/**
 * WP-270: §9.11 step 10, "Never create a new salt until the prior attempt is
 * authoritatively absent, canceled, or terminal" (work-plan acceptance 2), in
 * deterministic cases. The seeded interleaving property is
 * `salt-gate.property.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { type PlacementOutcome } from "../../../packages/oms/src/index.js";

import { accepted, venueError, venueIdFor } from "./support/fake-venue.js";
import { group, openHarness, reopen, ticket } from "./support/harness.js";

const UNKNOWN_425: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: venueError("ENGINE_RESTARTING", "UNKNOWN", 1) };
const UNKNOWN_TIMEOUT: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: venueError("TIMEOUT", "UNKNOWN") };

describe("the salt gate", () => {
  it("is closed while an attempt is unresolved, and opens on an authoritative ABSENT (no retransmission path): then, and only then, a new salt", async () => {
    const h = await openHarness();
    h.venue.placement = () => UNKNOWN_TIMEOUT;
    const g = group(1);
    await h.manager.registerGroup(g);
    const first = await h.manager.submit(ticket(g, { n: 1 }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const attemptId = first.value.submissionAttemptId;
    expect(h.manager.saltGate(g.executionGroupId)).toMatchObject({ open: false, remaining: null });
    expect((await h.manager.submit(ticket(g, { n: 2 }))).ok).toBe(false);
    const request = h.reconciler.latestFor(attemptId);
    // UNRESOLVED changes nothing.
    const unresolved = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "UNRESOLVED" });
    expect(unresolved.ok && unresolved.value.state).toBe("RECONCILING");
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(false);
    const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(absent.ok && absent.value.state).toBe("ABANDONED");
    expect(h.manager.saltGate(g.executionGroupId)).toMatchObject({ open: true, remaining: "10" });
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    const second = await h.manager.submit(ticket(g, { n: 2 }));
    expect(second.ok && second.value.orderState).toBe("LIVE");
    expect(h.venue.signed).toHaveLength(2);
    expect(new Set(h.venue.signed).size).toBe(2);
  });

  it("is closed while the venue holds the order (PRESENT, LIVE), and after a cancel until the final matched size is confirmed", async () => {
    const h = await openHarness();
    h.venue.placement = () => UNKNOWN_TIMEOUT;
    const g = group(2);
    await h.manager.registerGroup(g);
    const first = await h.manager.submit(ticket(g, { n: 10 }));
    if (!first.ok) throw new Error("submit failed");
    const attemptId = first.value.submissionAttemptId;
    const salt = h.venue.signed[0] as string;
    const request = h.reconciler.latestFor(attemptId);
    const present = await h.manager.applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: venueIdFor(salt), status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    expect(present.ok && present.value.state).toBe("RESPONDED");
    expect(h.manager.order(ticket(g, { n: 10 }).orderId)?.state).toBe("LIVE");
    expect(h.manager.saltGate(g.executionGroupId)?.blockers).toEqual([{ id: attemptId, reason: "ORDER_LIVE" }]);
    // A partial fill, then a cancel: CANCELED, but the final size is not yet known.
    const fill = await h.manager.recordFill({
      venueTradeId: "trade-1",
      venueOrderId: venueIdFor(salt),
      shares: "4",
      price: "0.5",
      liquidityRole: "MAKER",
      matchedAt: "2026-10-03T00:00:00Z",
    });
    expect(fill.ok && fill.value.state).toBe("PARTIALLY_FILLED");
    const canceled = await h.manager.requestCancel(ticket(g, { n: 10 }).orderId);
    expect(canceled.ok && canceled.value.state).toBe("CANCELED");
    expect(h.manager.saltGate(g.executionGroupId)?.blockers).toEqual([{ id: attemptId, reason: "FINAL_SIZE_UNCONFIRMED" }]);
    expect((await h.manager.submit(ticket(g, { n: 11, shares: "6" }))).ok).toBe(false);
    const finalRead = h.reconciler.latestFor(attemptId);
    expect(finalRead?.purpose).toBe("FINAL_SIZE");
    const final = await h.manager.applyReconciliation({
      requestId: finalRead?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: venueIdFor(salt), status: "CANCELED", sizeMatched: "4", originalSize: "10" },
    });
    expect(final.ok).toBe(true);
    expect(h.manager.saltGate(g.executionGroupId)).toMatchObject({ open: true, remaining: "6" });
    // The remainder caps the next attempt exactly.
    const tooBig = await h.manager.submit(ticket(g, { n: 12, shares: "6.01" }));
    expect(!tooBig.ok && tooBig.refusal.code).toBe("OMS_GROUP_REMAINDER_EXCEEDED");
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    const replacement = await h.manager.submit(ticket(g, { n: 13, shares: "6" }));
    expect(replacement.ok && replacement.value.orderState).toBe("LIVE");
  });

  it("is checked and claimed in one synchronous step: two concurrent submissions for one group sign exactly one order", async () => {
    const h = await openHarness();
    const g = group(3);
    await h.manager.registerGroup(g);
    const [a, b] = await Promise.all([h.manager.submit(ticket(g, { n: 20 })), h.manager.submit(ticket(g, { n: 21 }))]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const refused = a.ok ? b : a;
    expect(!refused.ok && refused.refusal.code).toBe("OMS_SALT_GATE_CLOSED");
    expect(h.venue.signed).toHaveLength(1);
  });

  it("refuses two orders of one group in one batch", async () => {
    const h = await openHarness();
    const g = group(4);
    await h.manager.registerGroup(g);
    const result = await h.manager.submitBatch([ticket(g, { n: 30, shares: "5" }), ticket(g, { n: 31, shares: "5" })]);
    expect(!result.ok && result.refusal.code).toBe("OMS_SALT_GATE_CLOSED");
    expect(h.venue.signed).toHaveLength(0);
  });

  it("a never-transmitted SIGNED attempt holds the gate until it is transmitted or abandoned", async () => {
    const h = await openHarness();
    const g = group(5);
    await h.manager.registerGroup(g);
    // The venue mode changes to TRADING_UNAVAILABLE while the order is being signed: nothing is transmitted.
    const sign = h.venue.createLimitOrder.bind(h.venue);
    h.venue.createLimitOrder = async (request) => {
      h.mode.value = "TRADING_UNAVAILABLE";
      return sign(request);
    };
    const result = await h.manager.submit(ticket(g, { n: 40 }));
    expect(result.ok && result.value.attemptState).toBe("SIGNED");
    expect(result.ok && result.value.placement).toBeNull();
    expect(h.venue.received).toEqual([]);
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(false);
    if (!result.ok) return;
    const abandoned = await h.manager.abandonAttempt(result.value.submissionAttemptId);
    expect(abandoned.ok && abandoned.value.state).toBe("ABANDONED");
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(true);
  });

  it("the same signed order is retransmitted only on the 425 path, only after ABSENT, never re-signed", async () => {
    const h = await openHarness();
    h.venue.placement = () => UNKNOWN_425;
    const g = group(6);
    await h.manager.registerGroup(g);
    const first = await h.manager.submit(ticket(g, { n: 50 }));
    if (!first.ok) throw new Error("submit failed");
    const attemptId = first.value.submissionAttemptId;
    // Before ABSENT: refused.
    const early = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(!early.ok && early.refusal.code).toBe("OMS_RETRANSMIT_NOT_SUPPORTED");
    const request = h.reconciler.latestFor(attemptId);
    const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    // Held for the retransmission decision: still blocking the gate.
    expect(absent.ok && absent.value).toMatchObject({ state: "RECONCILING", absentConfirmed: true });
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(false);
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    const resent = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(resent.ok && resent.value.orderState).toBe("LIVE");
    expect(h.venue.signed).toHaveLength(1);
    expect(h.venue.received).toEqual([h.venue.signed[0], h.venue.signed[0]]);
  });

  it("a retransmission whose answer died with the process is not the restart path: after ABSENT it is abandoned, never resent", async () => {
    const h = await openHarness();
    h.venue.placement = () => UNKNOWN_425;
    const g = group(9);
    await h.manager.registerGroup(g);
    const first = await h.manager.submit(ticket(g, { n: 90 }));
    if (!first.ok) throw new Error("submit failed");
    const attemptId = first.value.submissionAttemptId;
    let request = h.reconciler.latestFor(attemptId);
    await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    h.venue.placement = () => {
      h.store.frozen = true;
      throw new Error("killed during the retransmission");
    };
    await h.manager.retransmitSameSignedOrder(attemptId);
    h.store.frozen = false;
    const r = await reopen(h);
    expect(r.manager.attempt(attemptId)).toMatchObject({ state: "RECONCILING", errorCode: null });
    request = h.reconciler.latestFor(attemptId);
    const absent = await r.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(absent.ok && absent.value.state).toBe("ABANDONED");
    expect(h.venue.received).toHaveLength(2);
  });

  it("refuses retransmission for every non-restart unknown, and abandons on ABSENT instead", async () => {
    for (const [index, kind] of ["TIMEOUT", "TRANSPORT_FAILURE", "RATE_LIMITED", "AUTHENTICATION_REJECTED", "TRADING_UNAVAILABLE"].entries()) {
      const h = await openHarness();
      h.venue.placement = () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError(kind, "UNKNOWN") });
      const g = group(60 + index);
      await h.manager.registerGroup(g);
      const first = await h.manager.submit(ticket(g, { n: 60 + index }));
      if (!first.ok) throw new Error("submit failed");
      const attemptId = first.value.submissionAttemptId;
      const request = h.reconciler.latestFor(attemptId);
      const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
      expect(absent.ok && absent.value.state).toBe("ABANDONED");
      const resent = await h.manager.retransmitSameSignedOrder(attemptId);
      expect(!resent.ok && resent.refusal.code).toBe("OMS_RETRANSMIT_NOT_SUPPORTED");
      expect(h.venue.received).toHaveLength(1);
    }
  });

  it("a retransmission refused in post-only mode for a non-post-only order (VENUE_FACTS.POST_ONLY_NO_UNCHANGED_RETRY)", async () => {
    const h = await openHarness();
    h.venue.placement = () => UNKNOWN_425;
    const g = group(7);
    await h.manager.registerGroup(g);
    const first = await h.manager.submit(ticket(g, { n: 70 }));
    if (!first.ok) throw new Error("submit failed");
    const attemptId = first.value.submissionAttemptId;
    const request = h.reconciler.latestFor(attemptId);
    await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    h.mode.value = "POST_ONLY";
    const resent = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(!resent.ok && resent.refusal.code).toBe("OMS_POST_ONLY_MODE");
    expect(h.venue.received).toHaveLength(1);
    // The attempt still waits on the decision; abandoning it opens the gate.
    const abandoned = await h.manager.abandonAttempt(attemptId);
    expect(abandoned.ok && abandoned.value.state).toBe("ABANDONED");
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(true);
  });

  it("abandonAttempt closes only a never-transmitted SIGNED attempt or one held absent: every other attempt is refused, its gate stays closed and no new salt is signed (r1, OP-R1-01)", async () => {
    const h = await openHarness();
    const cases: { label: string; n: number; attemptId: string; unresolved: boolean }[] = [];
    const add = async (n: number, label: string, outcome: () => PlacementOutcome | Promise<PlacementOutcome>, hang = false): Promise<string> => {
      h.venue.placement = () => outcome();
      const g = group(n);
      await h.manager.registerGroup(g);
      const t = ticket(g, { n });
      const received = h.venue.received.length;
      const pending = h.manager.submit(t);
      if (hang) {
        for (let i = 0; i < 50 && h.venue.received.length === received; i += 1) await Promise.resolve();
      } else {
        await pending;
      }
      const attemptId = h.manager.order(t.orderId)?.submissionAttemptId as string;
      const state = h.manager.attempt(attemptId)?.state as string;
      cases.push({ label, n, attemptId, unresolved: !["RESPONDED", "ABANDONED"].includes(state) });
      return attemptId;
    };
    // RECONCILING, not (yet) found absent.
    await add(101, "unknown, reconciling", () => UNKNOWN_TIMEOUT);
    // RECONCILING on the 425 path, after an ABSENT that did not attest quiescence (refused): still not absent.
    const restart = await add(102, "425, an unattested ABSENT refused", () => UNKNOWN_425);
    const request = h.reconciler.latestFor(restart);
    const unattested = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: restart, verdict: "ABSENT" });
    expect(!unattested.ok && unattested.refusal.code).toBe("OMS_RECONCILIATION_NOT_QUIESCENT");
    // SENDING, in flight; then (below) the watchdog's RECONCILING, still in flight.
    let answer: (outcome: PlacementOutcome) => void = () => undefined;
    const hung = await add(103, "in flight", () => new Promise<PlacementOutcome>((resolve) => (answer = resolve)), true);
    // RESPONDED (accepted) and ABANDONED (not sent).
    await add(104, "responded", () => accepted("venue-104"));
    await add(105, "not sent", () => ({ kind: "NOT_SENT", error: venueError("INVALID_REQUEST", "NOT_SENT") }));
    expect(cases.map((c) => h.manager.attempt(c.attemptId)?.state)).toEqual(["RECONCILING", "RECONCILING", "SENDING", "RESPONDED", "ABANDONED"]);
    const check = async (): Promise<void> => {
      for (const c of cases) {
        const before = h.manager.attempt(c.attemptId);
        const result = await h.manager.abandonAttempt(c.attemptId);
        expect(!result.ok && result.refusal.code, c.label).toBe("OMS_ILLEGAL_TRANSITION");
        expect(h.manager.attempt(c.attemptId), c.label).toEqual(before);
        if (c.unresolved) expect(h.manager.saltGate(group(c.n).executionGroupId)?.open, c.label).toBe(false);
      }
    };
    await check();
    const lost = await h.manager.declareTransmissionLost(hung);
    expect(lost.ok && lost.value).toMatchObject({ state: "RECONCILING", inFlight: true });
    await check();
    // No new salt for any unresolved group.
    const signedBefore = h.venue.signed.length;
    for (const c of cases.filter((entry) => entry.unresolved)) {
      const again = await h.manager.submit(ticket(group(c.n), { n: 1000 + c.n }));
      expect(!again.ok && again.refusal.code, c.label).toBe("OMS_SALT_GATE_CLOSED");
    }
    expect(h.venue.signed).toHaveLength(signedBefore);
    answer(UNKNOWN_TIMEOUT);
  });

  it("after a restart the 425 path stays reachable: resume() admits an attempt held absent, and the SAME signed order is resent (r1, OP-R1-03)", async () => {
    const h = await openHarness();
    h.venue.placement = () => UNKNOWN_425;
    const g = group(110);
    await h.manager.registerGroup(g);
    const first = await h.manager.submit(ticket(g, { n: 110 }));
    if (!first.ok) throw new Error("submit failed");
    const attemptId = first.value.submissionAttemptId;
    const r = await reopen(h);
    expect(r.manager.paused).toBe(true);
    // Not yet read: still unresolved, so resume() refuses.
    const early = r.manager.resume();
    expect(!early.ok && early.refusal.code).toBe("OMS_RESUME_BLOCKED");
    const request = h.reconciler.latestFor(attemptId);
    const absent = await r.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(absent.ok && absent.value).toMatchObject({ state: "RECONCILING", absentConfirmed: true });
    // Held for the decision: it keeps its group's gate closed, but no longer blocks resume().
    expect(r.manager.saltGate(g.executionGroupId)?.open).toBe(false);
    expect(r.manager.resume().ok).toBe(true);
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    const resent = await r.manager.retransmitSameSignedOrder(attemptId);
    expect(resent.ok && resent.value.orderState).toBe("LIVE");
    expect(h.venue.signed).toHaveLength(1);
    expect(h.venue.received).toEqual([h.venue.signed[0], h.venue.signed[0]]);
  });

  it("a retransmission the venue definitively rejects closes the attempt: the gate opens for a new salt (the oracle's E2 after E3)", async () => {
    const h = await openHarness();
    h.venue.placement = () => UNKNOWN_425;
    const g = group(111);
    await h.manager.registerGroup(g);
    const first = await h.manager.submit(ticket(g, { n: 111 }));
    if (!first.ok) throw new Error("submit failed");
    const attemptId = first.value.submissionAttemptId;
    const request = h.reconciler.latestFor(attemptId);
    await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    h.venue.placement = () => ({ kind: "REJECTED", reason: "INSUFFICIENT_BALANCE_OR_ALLOWANCE" });
    const resent = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(resent.ok && resent.value).toMatchObject({ orderState: "REJECTED", attemptState: "RESPONDED" });
    expect(h.manager.saltGate(g.executionGroupId)).toMatchObject({ open: true, remaining: "10" });
  });

  it("ABSENT is accepted only after the port settled; if the venue later shows the order anyway, that evidence is an unknown venue order and raises a halt alert", async () => {
    const h = await openHarness();
    let answer: (outcome: PlacementOutcome) => void = () => undefined;
    h.venue.placement = () => new Promise<PlacementOutcome>((resolve) => (answer = resolve));
    const g = group(8);
    await h.manager.registerGroup(g);
    const t = ticket(g, { n: 80 });
    const pending = h.manager.submit(t);
    for (let i = 0; i < 50 && h.venue.received.length === 0; i += 1) await Promise.resolve();
    const attemptId = h.manager.order(t.orderId)?.submissionAttemptId as string;
    await h.manager.declareTransmissionLost(attemptId);
    const salt = h.venue.signed[0] as string;
    // The port settles with an unknown first; the fresh read then says ABSENT.
    answer(UNKNOWN_TIMEOUT);
    await pending;
    const request = h.reconciler.latestFor(attemptId);
    const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(absent.ok && absent.value.state).toBe("ABANDONED");
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(true);
    // If the venue reports the order after all (a delayed request), the OMS never had its venue id, so the
    // evidence arrives as an unknown venue order: refused, with a market-halt alert (WP-290 attributes it).
    const observed = await h.manager.applyOrderObservation({ venueOrderId: venueIdFor(salt), status: "LIVE" });
    expect(!observed.ok && observed.refusal.code).toBe("OMS_UNKNOWN_VENUE_ORDER");
    expect(h.manager.alerts().some((alert) => alert.kind === "UNKNOWN_VENUE_ORDER" && alert.haltMarket)).toBe(true);
  });
});
