/**
 * WP-270: restart through the store port (ADR-007 §2: "A process killed
 * between transmission and response persistence must find a SIGNED/SENDING
 * record on restart"; §16.6). The exhaustive crash-point sweep is the
 * fault-injection suite (`test/fault-injection/oms/`); these are the named
 * cases, each with one restart.
 */

import { describe, expect, it } from "vitest";

import { OrderManager, type PlacementOutcome } from "../../../packages/oms/src/index.js";

import { accepted, venueError, venueIdFor } from "./support/fake-venue.js";
import { ACCOUNT, PUSD, group, openHarness, reopen, ticket } from "./support/harness.js";

describe("restart through the store", () => {
  it("killed after SIGNED, before SENDING: the attempt is recovered SIGNED with its payload; it is transmitted with the SAME salt", async () => {
    const h = await openHarness();
    const g = group(1);
    await h.manager.registerGroup(g);
    // Transactions: 1 group, 2 planned, 3 reserved, 4 signed, 5 SENDING. Kill at 5.
    h.store.hooks.before = (_writes, call) => {
      if (call === 5) throw new Error("killed");
    };
    const t = ticket(g, { n: 1 });
    const result = await h.manager.submit(t);
    expect(!result.ok && result.refusal.code).toBe("OMS_STORE_WRITE_FAILED");
    expect(h.manager.faulted).toBe(true);
    expect(h.venue.received).toEqual([]);
    h.store.hooks.before = undefined;
    const r = await reopen(h);
    const [attempt] = r.manager.attempts();
    expect(attempt).toMatchObject({ state: "SIGNED", signedPayloadAvailable: true, salt: h.venue.signed[0] });
    expect(r.manager.paused).toBe(true);
    expect(r.manager.saltGate(g.executionGroupId)?.open).toBe(false);
    expect(r.manager.resume().ok).toBe(true);
    const sent = await r.manager.transmitSigned(attempt?.submissionAttemptId as string);
    expect(sent.ok && sent.value.orderState).toBe("LIVE");
    expect(h.venue.signed).toHaveLength(1);
    expect(h.venue.received).toEqual([h.venue.signed[0]]);
  });

  it("killed after the venue received the order, before the response was persisted: SUBMISSION_UNKNOWN on restart, reconciled, never resent", async () => {
    const h = await openHarness();
    const g = group(2);
    await h.manager.registerGroup(g);
    h.venue.placement = (handle) => {
      // The venue holds it now; the process dies before it can write anything.
      h.store.frozen = true;
      return accepted(venueIdFor(handle.identity.salt));
    };
    const t = ticket(g, { n: 2 });
    const result = await h.manager.submit(t);
    expect(result.ok).toBe(false);
    h.store.frozen = false;
    h.venue.placement = () => {
      throw new Error("a recovered order must never be resent");
    };
    const r = await reopen(h);
    const [attempt] = r.manager.attempts();
    expect(attempt).toMatchObject({ state: "RECONCILING", responseStatus: "RECOVERED_SENDING" });
    expect(r.manager.order(t.orderId)?.state).toBe("RECONCILING");
    const events = h.store.snapshotSync().events.filter((event) => event.orderId === t.orderId).map((event) => event.newState);
    expect(events).toContain("SUBMISSION_UNKNOWN");
    expect(r.manager.paused).toBe(true);
    expect(r.manager.resume().ok).toBe(false);
    const fresh = await r.manager.submit(ticket(g, { n: 3 }));
    expect(!fresh.ok && fresh.refusal.code).toBe("OMS_PAUSED");
    const request = h.reconciler.latestFor(attempt?.submissionAttemptId as string);
    expect(request?.signedIdentity?.salt).toBe(h.venue.signed[0]);
    const answer = await r.manager.applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attempt?.submissionAttemptId,
      verdict: "PRESENT",
      order: { venueOrderId: venueIdFor(h.venue.signed[0] as string), status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    expect(answer.ok).toBe(true);
    expect(r.manager.resume().ok).toBe(true);
    expect(h.venue.received).toHaveLength(1);
  });

  it("an attempt whose payload cannot be decrypted is never forgotten: it is reconciled by its salt, and can only be abandoned if never sent", async () => {
    const h = await openHarness();
    const g = group(3);
    await h.manager.registerGroup(g);
    h.store.hooks.before = (_writes, call) => {
      if (call === 5) throw new Error("killed");
    };
    await h.manager.submit(ticket(g, { n: 4 }));
    h.store.hooks.before = undefined;
    h.cipher.mode = "THROW_DECRYPT";
    const r = await reopen(h);
    h.cipher.mode = "OK";
    const [attempt] = r.manager.attempts();
    expect(attempt).toMatchObject({ state: "SIGNED", signedPayloadAvailable: false });
    expect(r.manager.alerts().some((alert) => alert.kind === "PAYLOAD_UNREADABLE")).toBe(true);
    r.manager.resume();
    const sent = await r.manager.transmitSigned(attempt?.submissionAttemptId as string);
    expect(!sent.ok && sent.refusal.code).toBe("OMS_SIGNED_PAYLOAD_UNAVAILABLE");
    const abandoned = await r.manager.abandonAttempt(attempt?.submissionAttemptId as string);
    expect(abandoned.ok && abandoned.value.state).toBe("ABANDONED");
    expect(r.manager.saltGate(g.executionGroupId)?.open).toBe(true);
  });

  it("an order that was never signed (killed after reserving) is closed on restart and its reservation released", async () => {
    const h = await openHarness();
    const g = group(4);
    await h.manager.registerGroup(g);
    h.store.hooks.before = (_writes, call) => {
      if (call === 4) throw new Error("killed");
    };
    const t = ticket(g, { n: 5 });
    await h.manager.submit(t);
    h.store.hooks.before = undefined;
    expect(h.inventory?.book.line(ACCOUNT, PUSD)?.reserved).toBe("5");
    const r = await reopen(h);
    expect(r.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0" });
    expect(h.inventory?.book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
    expect(r.manager.paused).toBe(false);
  });

  it("an order killed between its durable PLANNED row and `reserve` is closed; the missing reservation reads as never made", async () => {
    const h = await openHarness();
    const g = group(5);
    await h.manager.registerGroup(g);
    h.store.hooks.after = (_writes, call) => {
      if (call === 2) {
        h.store.frozen = true;
        throw new Error("killed after the PLANNED commit");
      }
    };
    const t = ticket(g, { n: 6 });
    await h.manager.submit(t);
    h.store.hooks.after = undefined;
    h.store.frozen = false;
    const r = await reopen(h);
    expect(r.manager.order(t.orderId)?.state).toBe("CANCELED");
    expect(r.manager.alerts().filter((alert) => alert.kind === "RESERVATION_RELEASE_FAILED")).toEqual([]);
  });

  it("a fill committed before a crash is consumed exactly once across the restart", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const g = group(6);
    await h.manager.registerGroup(g);
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    const t = ticket(g, { n: 7 });
    await h.manager.submit(t);
    const venueOrderId = venueIdFor(h.venue.signed[0] as string);
    // Kill right after the fill's transaction commits (before `consume`).
    const committed = h.store.calls + 1;
    h.store.hooks.after = (_writes, call) => {
      if (call === committed) {
        h.store.frozen = true;
        throw new Error("killed after the fill commit");
      }
    };
    const recorded = await h.manager.recordFill({ venueTradeId: "c1", venueOrderId, shares: "4", price: "0.5", liquidityRole: "MAKER", matchedAt: "2026-10-03T00:00:00Z" });
    expect(recorded.ok).toBe(false);
    expect(h.inventory?.book.line(ACCOUNT, PUSD)?.pendingOut).toBe("0");
    h.store.hooks.after = undefined;
    h.store.frozen = false;
    const r = await reopen(h);
    expect(h.inventory?.book.line(ACCOUNT, PUSD)).toMatchObject({ reserved: "3", pendingOut: "2" });
    // A second restart replays the consume again: a duplicate pending id, read as done.
    const r2 = await reopen(r);
    expect(h.inventory?.book.line(ACCOUNT, PUSD)).toMatchObject({ reserved: "3", pendingOut: "2" });
    expect(r2.manager.alerts().filter((alert) => alert.kind === "RESERVATION_SHORTFALL")).toEqual([]);
  });

  it("killed while a cancel was pending: on restart the order is RECONCILING and an authoritative read is requested", async () => {
    const h = await openHarness();
    const g = group(9);
    await h.manager.registerGroup(g);
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    const t = ticket(g, { n: 9 });
    await h.manager.submit(t);
    h.venue.cancel = () => {
      h.store.frozen = true;
      throw new Error("killed with the cancel in flight");
    };
    await h.manager.requestCancel(t.orderId);
    h.store.frozen = false;
    const r = await reopen(h);
    expect(r.manager.order(t.orderId)?.state).toBe("RECONCILING");
    const attemptId = r.manager.order(t.orderId)?.submissionAttemptId as string;
    expect(h.reconciler.latestFor(attemptId)?.purpose).toBe("ORDER_STATE");
    expect(r.manager.order(t.orderId)?.reservation.released).toBe(false);
  });

  it("a recovered cancel-pending order starts the manager PAUSED, as resume() would refuse it; it resumes once the read lands (r1, OP-R1-05)", async () => {
    const h = await openHarness();
    const g = group(10);
    await h.manager.registerGroup(g);
    const t = ticket(g, { n: 10 });
    await h.manager.submit(t);
    h.venue.cancel = () => {
      h.store.frozen = true;
      throw new Error("killed with the cancel in flight");
    };
    await h.manager.requestCancel(t.orderId);
    h.store.frozen = false;
    const r = await reopen(h);
    const attemptId = r.manager.order(t.orderId)?.submissionAttemptId as string;
    expect(r.manager.attempt(attemptId)?.state).toBe("RESPONDED");
    expect(r.manager.order(t.orderId)?.state).toBe("RECONCILING");
    expect(r.manager.paused).toBe(true);
    const fresh = await r.manager.submit(ticket(group(11), { n: 11 }));
    expect(!fresh.ok && fresh.refusal.code).toBe("OMS_PAUSED");
    const blocked = r.manager.resume();
    expect(!blocked.ok && blocked.refusal).toMatchObject({ code: "OMS_RESUME_BLOCKED", details: { orderId: t.orderId } });
    const request = h.reconciler.latestFor(attemptId);
    const answer = await r.manager.applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: venueIdFor(h.venue.signed[0] as string), status: "CANCELED", sizeMatched: "0", originalSize: "10" },
    });
    expect(answer.ok).toBe(true);
    expect(r.manager.resume().ok).toBe(true);
  });

  it("resume() refuses while an attempt is SENDING (in flight) or SUBMISSION_UNKNOWN (its request owed), whatever its order's state says (r1, OP-R1-05)", async () => {
    // SENDING: the order is SENDING too, which the order-level rule alone does not catch.
    const h = await openHarness();
    let answer: (outcome: PlacementOutcome) => void = () => undefined;
    h.venue.placement = () => new Promise<PlacementOutcome>((resolve) => (answer = resolve));
    const g = group(12);
    await h.manager.registerGroup(g);
    const t = ticket(g, { n: 12 });
    const pending = h.manager.submit(t);
    for (let i = 0; i < 50 && h.venue.received.length === 0; i += 1) await Promise.resolve();
    h.manager.pause();
    const sending = h.manager.resume();
    expect(!sending.ok && sending.refusal).toMatchObject({ code: "OMS_RESUME_BLOCKED", details: { state: "SENDING" } });
    expect(h.manager.paused).toBe(true);
    answer(accepted(venueIdFor(h.venue.signed[0] as string)));
    await pending;
    expect(h.manager.resume().ok).toBe(true);
    // SUBMISSION_UNKNOWN: the token source fails, so the request is owed and both attempt and order stay SUBMISSION_UNKNOWN.
    const u = await openHarness({
      requestToken: () => {
        throw new Error("no token");
      },
    });
    u.venue.placement = () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError("TIMEOUT", "UNKNOWN") });
    const gu = group(13);
    await u.manager.registerGroup(gu);
    const unknown = await u.manager.submit(ticket(gu, { n: 13 }));
    expect(unknown.ok && unknown.value).toMatchObject({ orderState: "SUBMISSION_UNKNOWN", attemptState: "SUBMISSION_UNKNOWN" });
    u.manager.pause();
    const owed = u.manager.resume();
    expect(!owed.ok && owed.refusal).toMatchObject({ code: "OMS_RESUME_BLOCKED", details: { state: "SUBMISSION_UNKNOWN" } });
    expect(u.manager.paused).toBe(true);
  });

  it("a faulted manager refuses everything until reopened; opening refuses a malformed store", async () => {
    const h = await openHarness();
    h.store.hooks.before = () => {
      throw new Error("disk full");
    };
    const result = await h.manager.registerGroup(group(7));
    expect(!result.ok && result.refusal.code).toBe("OMS_STORE_WRITE_FAILED");
    h.store.hooks.before = undefined;
    const after = await h.manager.registerGroup(group(8));
    expect(!after.ok && after.refusal.code).toBe("OMS_FAULTED");
    const malformed = await OrderManager.open({ ...h.deps, store: { apply: async () => undefined, load: async () => ({ groups: "nope" }) as never } });
    expect(!malformed.ok && malformed.refusal.code).toBe("OMS_INVALID_INPUT");
    const missing = await OrderManager.open({ ...h.deps, requestToken: undefined as never });
    expect(!missing.ok && missing.refusal.code).toBe("OMS_INVALID_INPUT");
  });
});
