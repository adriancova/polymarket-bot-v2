/**
 * WP-270: the §9.11 idempotent submission protocol, steps 1-8, and work-plan
 * acceptance 1 ("Lost response becomes SUBMISSION_UNKNOWN").
 *
 * Every port is mocked (`support/harness.ts`): no network, no key, no signer.
 */

import { describe, expect, it } from "vitest";

import { type PlacementOutcome, type StoreWrite } from "../../../packages/oms/src/index.js";

import { accepted, signatureFor, venueError, venueIdFor } from "./support/fake-venue.js";
import { PUSD, group, openHarness, ticket } from "./support/harness.js";

function kinds(transaction: readonly StoreWrite[]): string[] {
  return transaction.map((write) => write.kind);
}

describe("§9.11 steps 1-5: the order of persistence and transmission", () => {
  it("creates the attempt id before signing, persists ciphertext + salt + plan link, commits SIGNED with the attempt, and marks SENDING durably before transmitting", async () => {
    const trace: string[] = [];
    let n = 0;
    const h = await openHarness({
      newId: () => {
        n += 1;
        trace.push("newId");
        return `00000000-00aa-7000-8000-${n.toString(16).padStart(12, "0")}`;
      },
    });
    const sign = h.venue.createLimitOrder.bind(h.venue);
    h.venue.createLimitOrder = async (request) => {
      trace.push("sign");
      return sign(request);
    };
    let attemptStateAtTransmit: string | undefined;
    h.venue.placement = (handle) => {
      trace.push("post");
      const persisted = [...h.store.snapshotSync().attempts.values()].find((a) => a.salt === handle.identity.salt);
      attemptStateAtTransmit = persisted?.state;
      return accepted(venueIdFor(handle.identity.salt));
    };
    const g = group(1);
    expect((await h.manager.registerGroup(g)).ok).toBe(true);
    const t = ticket(g, { n: 1 });
    const result = await h.manager.submit(t);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Step 1 precedes step 2; step 5's mark is durable when the venue is called.
    expect(trace).toEqual(["newId", "sign", "post"]);
    expect(attemptStateAtTransmit).toBe("SENDING");
    expect(result.value.orderState).toBe("LIVE");
    expect(result.value.attemptState).toBe("RESPONDED");

    // The transactions, in order: PLANNED (+ links), RESERVED, SIGNED (attempt + order), SENDING, outcome.
    const log = h.store.log;
    expect(kinds(log[1] ?? [])).toEqual(["INSERT_ORDER", "APPEND_ORDER_EVENT", "INSERT_INTENT_LINK"]);
    expect(kinds(log[2] ?? [])).toEqual(["APPEND_ORDER_EVENT", "UPDATE_ORDER"]);
    const signedTx = log[3] ?? [];
    // WP-040 F17: the attempt row precedes the order's SIGNED state, in ONE transaction.
    expect(kinds(signedTx)).toEqual(["INSERT_ATTEMPT", "APPEND_ORDER_EVENT", "UPDATE_ORDER"]);
    const insert = signedTx[0];
    expect(insert?.kind).toBe("INSERT_ATTEMPT");
    if (insert?.kind !== "INSERT_ATTEMPT") return;
    const salt = h.venue.signed[0] as string;
    expect(insert.attempt.salt).toBe(salt);
    expect(insert.attempt.planId).toBe(g.planId);
    expect(insert.attempt.executionGroupId).toBe(g.executionGroupId);
    expect(insert.attempt.state).toBe("SIGNED");
    expect(insert.attempt.attemptOrdinal).toBe(1);
    // THE STOP ITEM: never computed.
    expect(insert.attempt.expectedOrderHash).toBeNull();
    const updateOrder = signedTx[2];
    expect(updateOrder?.kind === "UPDATE_ORDER" && updateOrder.order.state).toBe("SIGNED");
    expect(updateOrder?.kind === "UPDATE_ORDER" && updateOrder.order.submissionAttemptId).toBe(insert.attempt.submissionAttemptId);
    expect(kinds(log[4] ?? [])).toEqual(["UPDATE_ATTEMPT", "APPEND_ORDER_EVENT", "UPDATE_ORDER"]);
  });

  it("persists the signed payload ENCRYPTED: no signature and no plaintext payload in anything written; the ciphertext round-trips", async () => {
    const h = await openHarness();
    const g = group(2);
    await h.manager.registerGroup(g);
    const result = await h.manager.submit(ticket(g, { n: 2 }));
    expect(result.ok).toBe(true);
    const salt = h.venue.signed[0] as string;
    const written = h.store.serialized();
    expect(written).not.toContain(signatureFor(salt));
    expect(written).not.toContain('"signature"');
    const attempt = [...h.store.snapshotSync().attempts.values()][0];
    expect(attempt?.signedPayload.keyId).toBe("test-key-1");
    const plaintext = await h.cipher.decrypt(attempt?.signedPayload ?? { keyId: "", ciphertext: "" });
    expect(JSON.parse(plaintext)).toMatchObject({ salt, signature: signatureFor(salt) });
    // Encrypted once, then decrypted once to verify it is recoverable before anything depends on it.
    expect(h.cipher.encryptCalls).toBe(1);
  });

  it("refuses a cipher that does not encrypt (identity), and persists or sends nothing", async () => {
    const h = await openHarness();
    h.cipher.mode = "IDENTITY";
    const g = group(3);
    await h.manager.registerGroup(g);
    const result = await h.manager.submit(ticket(g, { n: 3 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("OMS_CIPHER_FAILED");
    expect(h.venue.received).toEqual([]);
    expect(h.store.snapshotSync().attempts.size).toBe(0);
    expect(h.store.serialized()).not.toContain(signatureFor(h.venue.signed[0] as string));
    // The order is closed and its reservation released.
    const order = h.manager.order(ticket(g, { n: 3 }).orderId);
    expect(order?.state).toBe("CANCELED");
    expect(order?.reservation.released).toBe(true);
  });

  it("refuses a no-op cipher that round-trips (the payload in clear, or merely wrapped)", async () => {
    for (const [index, mode] of (["PASSTHROUGH", "WRAP"] as const).entries()) {
      const h = await openHarness();
      h.cipher.mode = mode;
      const g = group(10 + index);
      await h.manager.registerGroup(g);
      const result = await h.manager.submit(ticket(g, { n: 10 + index }));
      expect(!result.ok && result.refusal.code).toBe("OMS_CIPHER_FAILED");
      expect(h.venue.received).toEqual([]);
      expect(h.store.serialized()).not.toContain(signatureFor(h.venue.signed[0] as string));
    }
  });

  it("refuses a cipher whose decryption does not round-trip", async () => {
    const h = await openHarness();
    h.cipher.mode = "CORRUPT_DECRYPT";
    const g = group(4);
    await h.manager.registerGroup(g);
    const result = await h.manager.submit(ticket(g, { n: 4 }));
    expect(!result.ok && result.refusal.code).toBe("OMS_CIPHER_FAILED");
    expect(h.venue.received).toEqual([]);
  });

  it("a FAILED sign outcome means no order exists: nothing is persisted as an attempt or sent, the reservation is released, and the group stays open", async () => {
    const h = await openHarness();
    h.venue.sign = () => Object.freeze({ kind: "FAILED", error: venueError("RATE_LIMITED", "UNKNOWN", 2) });
    const g = group(5);
    await h.manager.registerGroup(g);
    const result = await h.manager.submit(ticket(g, { n: 5 }));
    expect(!result.ok && result.refusal.code).toBe("OMS_SIGN_FAILED");
    expect(h.venue.received).toEqual([]);
    expect(h.store.snapshotSync().attempts.size).toBe(0);
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(true);
    expect(h.inventory?.book.available("paper-account-1", PUSD)).toBe("1000");
  });
});

/**
 * Acceptance 1: every way a response can be lost or unclassifiable lands in
 * SUBMISSION_UNKNOWN, is reconciled by its signed identity, and closes the
 * group's salt gate. Never REJECTED.
 */
const LOST: readonly { readonly name: string; readonly outcome: () => PlacementOutcome | Promise<PlacementOutcome> }[] = [
  { name: "a timeout (SDK TimeoutError)", outcome: () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError("TIMEOUT", "UNKNOWN") }) },
  {
    name: "a dropped socket (TransportError)",
    outcome: () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError("TRANSPORT_FAILURE", "UNKNOWN") }),
  },
  { name: "HTTP 401", outcome: () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError("AUTHENTICATION_REJECTED", "UNKNOWN") }) },
  { name: "HTTP 425 (engine restarting)", outcome: () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError("ENGINE_RESTARTING", "UNKNOWN", 1) }) },
  { name: "HTTP 429", outcome: () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError("RATE_LIMITED", "UNKNOWN", 5) }) },
  { name: "the SDK's `unmatched` success turned UNKNOWN (C-6)", outcome: () => ({ kind: "UNKNOWN", reason: "SDK_UNMATCHED", error: null }) },
  { name: "an unclassified SDK code", outcome: () => ({ kind: "UNKNOWN", reason: "SDK_UNKNOWN_CODE", error: null }) },
  { name: "a bare HTTP 503", outcome: () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError("TRADING_UNAVAILABLE", "UNKNOWN") }) },
  {
    name: "a port that throws",
    outcome: () => {
      throw new Error("socket hang up");
    },
  },
  { name: "a rejected promise", outcome: () => Promise.reject(new Error("ECONNRESET")) },
  { name: "a malformed answer", outcome: () => ({ kind: "ACCEPTED", status: "LIVE" }) as unknown as PlacementOutcome },
  { name: "an unknown status", outcome: () => accepted("venue-x", "WEIRD" as "LIVE") },
  {
    name: "a REFUSED claim with a 425 kind (outside the adapter's contract)",
    outcome: () => ({ kind: "REFUSED", error: venueError("ENGINE_RESTARTING", "UNKNOWN") }),
  },
  { name: "a NOT_SENT claim whose effect is UNKNOWN", outcome: () => ({ kind: "NOT_SENT", error: venueError("TRANSPORT_FAILURE", "UNKNOWN") }) },
  { name: "a rejection reason the SDK does not name", outcome: () => ({ kind: "REJECTED", reason: "SOMETHING_NEW" }) },
  { name: "an outcome kind nobody knows", outcome: () => ({ kind: "MAYBE" }) as unknown as PlacementOutcome },
];

describe("acceptance 1: a lost response becomes SUBMISSION_UNKNOWN, never a rejection", () => {
  for (const [index, row] of LOST.entries()) {
    it(row.name, async () => {
      const h = await openHarness();
      h.venue.placement = () => row.outcome();
      const g = group(100 + index);
      await h.manager.registerGroup(g);
      const t = ticket(g, { n: 100 + index });
      const result = await h.manager.submit(t);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const events = h.store.snapshotSync().events.filter((event) => event.orderId === t.orderId);
      // Step 7 is recorded, then step 8 asks for an authoritative read.
      expect(events.map((event) => event.newState)).toContain("SUBMISSION_UNKNOWN");
      expect(events.map((event) => event.newState)).not.toContain("REJECTED");
      expect(result.value.orderState).toBe("RECONCILING");
      expect(result.value.attemptState).toBe("RECONCILING");
      const request = h.reconciler.latestFor(result.value.submissionAttemptId);
      expect(request?.purpose).toBe("SUBMISSION_UNKNOWN");
      // Reconciled by the signed identity: the salt and the signed fields, never an invented client id.
      expect(request?.salt).toBe(h.venue.signed[0]);
      expect(request?.signedIdentity?.salt).toBe(h.venue.signed[0]);
      expect(request?.expectedOrderHash).toBeNull();
      expect(request?.venueOrderId).toBeNull();
      // The group's salt gate is closed: no new salt until reconciled.
      expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(false);
      const again = await h.manager.submit(ticket(g, { n: 900 + index }));
      expect(!again.ok && again.refusal.code).toBe("OMS_SALT_GATE_CLOSED");
      expect(h.venue.signed).toHaveLength(1);
      // The reservation stays held.
      expect(h.manager.order(t.orderId)?.reservation.released).toBe(false);
    });
  }

  it("a watchdog timeout while the port has not answered: SUBMISSION_UNKNOWN; ABSENT is refused while the transmission is in flight", async () => {
    const h = await openHarness();
    let answer: (outcome: PlacementOutcome) => void = () => undefined;
    h.venue.placement = () => new Promise<PlacementOutcome>((resolve) => (answer = resolve));
    const g = group(200);
    await h.manager.registerGroup(g);
    const t = ticket(g, { n: 200 });
    const pending = h.manager.submit(t);
    for (let i = 0; i < 50 && h.venue.received.length === 0; i += 1) await Promise.resolve();
    expect(h.venue.received).toHaveLength(1);
    const attemptId = h.manager.order(t.orderId)?.submissionAttemptId as string;
    const lost = await h.manager.declareTransmissionLost(attemptId);
    expect(lost.ok && lost.value.state).toBe("RECONCILING");
    expect(h.manager.order(t.orderId)?.state).toBe("RECONCILING");
    const request = h.reconciler.latestFor(attemptId);
    const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(!absent.ok && absent.refusal.code).toBe("OMS_RECONCILIATION_IN_FLIGHT");
    // The late answer is a rejection: recorded, ignored, and the read is re-requested (made after the port settled).
    answer({ kind: "REJECTED", reason: "INSUFFICIENT_BALANCE_OR_ALLOWANCE" });
    const settled = await pending;
    expect(settled.ok && settled.value.orderState).toBe("RECONCILING");
    const fresh = h.reconciler.latestFor(attemptId);
    expect(fresh?.requestId).not.toBe(request?.requestId);
    const stale = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(!stale.ok && stale.refusal.code).toBe("OMS_RECONCILIATION_SUPERSEDED");
    const ok = await h.manager.applyReconciliation({ requestId: fresh?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(ok.ok && ok.value.state).toBe("ABANDONED");
    expect(h.manager.order(t.orderId)?.state).toBe("REJECTED");
  });
});

describe("definitive placement answers", () => {
  it("DELAYED is never a fill; MATCHED waits for fill facts", async () => {
    const h = await openHarness();
    const g1 = group(300);
    const g2 = group(301);
    await h.manager.registerGroup(g1);
    await h.manager.registerGroup(g2);
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt), "DELAYED");
    const delayed = await h.manager.submit(ticket(g1, { n: 300 }));
    expect(delayed.ok && delayed.value.orderState).toBe("DELAYED");
    expect(h.manager.order(ticket(g1, { n: 300 }).orderId)?.filledShares).toBe("0");
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt), "MATCHED");
    const matched = await h.manager.submit(ticket(g2, { n: 301 }));
    expect(matched.ok && matched.value.orderState).toBe("ACKNOWLEDGED");
    expect(h.manager.order(ticket(g2, { n: 301 }).orderId)?.filledShares).toBe("0");
  });

  it("a known rejection closes the attempt with final size 0, releases the whole reservation, and opens the gate", async () => {
    const h = await openHarness();
    h.venue.placement = () => ({ kind: "REJECTED", reason: "INSUFFICIENT_BALANCE_OR_ALLOWANCE" });
    const g = group(302);
    await h.manager.registerGroup(g);
    const t = ticket(g, { n: 302 });
    const result = await h.manager.submit(t);
    expect(result.ok && result.value.orderState).toBe("REJECTED");
    expect(result.ok && result.value.attemptState).toBe("RESPONDED");
    expect(h.manager.order(t.orderId)?.reservation.released).toBe(true);
    expect(h.inventory?.book.available("paper-account-1", PUSD)).toBe("1000");
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(true);
  });

  it("NOT_SENT: nothing left the process; the attempt is ABANDONED and the gate opens", async () => {
    const h = await openHarness();
    h.venue.placement = () => ({ kind: "NOT_SENT", error: venueError("INVALID_REQUEST", "NOT_SENT") });
    const g = group(303);
    await h.manager.registerGroup(g);
    const result = await h.manager.submit(ticket(g, { n: 303 }));
    expect(result.ok && result.value.attemptState).toBe("ABANDONED");
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(true);
  });

  it("a post-only-mode refusal forbids sending a non-post-only order of that group again, re-signed or not", async () => {
    const h = await openHarness();
    h.venue.placement = () => ({ kind: "REFUSED", error: venueError("POST_ONLY_MODE", "NOT_APPLIED", 79) });
    const g = group(304, { plannedShares: "20" });
    await h.manager.registerGroup(g);
    const first = await h.manager.submit(ticket(g, { n: 304, shares: "10" }));
    expect(first.ok && first.value.orderState).toBe("REJECTED");
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(true);
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    const second = await h.manager.submit(ticket(g, { n: 305, shares: "10" }));
    expect(!second.ok && second.refusal.code).toBe("OMS_POST_ONLY_RETRY_FORBIDDEN");
    expect(h.venue.signed).toHaveLength(1);
  });
});
