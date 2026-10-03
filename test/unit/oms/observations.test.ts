/**
 * WP-270: non-authoritative order observations (the user stream, WP-280's
 * normalized events). They move an open order along; they never resolve
 * RECONCILING, never turn `unmatched` into a cancel or a rejection
 * (VENUE_FACTS.UNMATCHED_ACCEPTED_NOT_FILLED), send an unrecognised status to
 * RECONCILING (never an assumption), and reopen a terminal order they
 * contradict, with a halt alert.
 *
 * r2 (WP270-R2-01, OP-R2-02; "STATE CONFLICTS" in `order-manager.ts`): an
 * unrecognised status on a TERMINAL order reopens it too, and the
 * authoritative read that finds the order terminal clears the state conflict,
 * so one stale or unknown stream message never blocks its group for good. A
 * terminal order with an open state conflict always has that read requested.
 */

import { describe, expect, it } from "vitest";

import { accepted, venueIdFor } from "./support/fake-venue.js";
import { group, openHarness, reopen, ticket, type Harness } from "./support/harness.js";

async function placed(h: Harness, n: number, status: "LIVE" | "DELAYED" | "MATCHED" = "LIVE") {
  h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt), status);
  const g = group(n);
  await h.manager.registerGroup(g);
  const t = ticket(g, { n });
  const result = await h.manager.submit(t);
  if (!result.ok) throw new Error(`submit failed: ${result.refusal.code}`);
  return { t, attemptId: result.value.submissionAttemptId, venueOrderId: venueIdFor(h.venue.signed.at(-1) as string) };
}

describe("order observations", () => {
  const MOVES: readonly { readonly from: "LIVE" | "DELAYED" | "MATCHED"; readonly status: string; readonly to: string; readonly read: boolean }[] = [
    { from: "MATCHED", status: "LIVE", to: "LIVE", read: false },
    { from: "DELAYED", status: "LIVE", to: "LIVE", read: false },
    { from: "DELAYED", status: "UNMATCHED", to: "LIVE", read: false },
    { from: "MATCHED", status: "DELAYED", to: "DELAYED", read: false },
    { from: "LIVE", status: "DELAYED", to: "LIVE", read: false },
    { from: "LIVE", status: "MATCHED", to: "LIVE", read: false },
    { from: "LIVE", status: "UNMATCHED", to: "LIVE", read: false },
    { from: "LIVE", status: "CANCELED", to: "CANCELED", read: true },
    { from: "DELAYED", status: "EXPIRED", to: "EXPIRED", read: true },
    { from: "LIVE", status: "SOMETHING_NEW", to: "RECONCILING", read: true },
  ];
  for (const [index, move] of MOVES.entries()) {
    it(`${move.from} observed ${move.status} → ${move.to}`, async () => {
      const h = await openHarness();
      const { t, attemptId, venueOrderId } = await placed(h, 10 + index, move.from);
      const before = h.reconciler.requests.length;
      const result = await h.manager.applyOrderObservation({ venueOrderId, status: move.status });
      expect(result.ok && result.value.state).toBe(move.to);
      expect(h.reconciler.requests.length).toBe(before + (move.read ? 1 : 0));
      if (move.read) expect(h.reconciler.latestFor(attemptId)?.purpose).toBe(move.to === "RECONCILING" ? "ORDER_STATE" : "FINAL_SIZE");
      // An observation never releases the reservation by itself.
      expect(h.manager.order(t.orderId)?.reservation.released).toBe(false);
    });
  }

  it("a terminal order observed LIVE again is reopened to RECONCILING, with a halt alert and a read", async () => {
    const h = await openHarness();
    const { t, attemptId, venueOrderId } = await placed(h, 40);
    await h.manager.applyOrderObservation({ venueOrderId, status: "CANCELED" });
    const reopened = await h.manager.applyOrderObservation({ venueOrderId, status: "LIVE" });
    expect(reopened.ok && reopened.value).toMatchObject({ state: "RECONCILING", conflict: true, finalSize: null });
    expect(h.manager.alerts().some((alert) => alert.kind === "EVIDENCE_CONFLICT" && alert.haltMarket)).toBe(true);
    expect(h.reconciler.latestFor(attemptId)?.purpose).toBe("ORDER_STATE");
    // The gate stays closed while the conflict is open.
    expect(h.manager.saltGate(h.manager.order(t.orderId)?.executionGroupId as string)?.open).toBe(false);
  });

  it("an unrecognised status on a terminal order whose final size is not yet confirmed reopens it to RECONCILING too (r2, WP270-R2-01)", async () => {
    const h = await openHarness();
    const { t, attemptId, venueOrderId } = await placed(h, 41);
    await h.manager.applyOrderObservation({ venueOrderId, status: "EXPIRED" });
    expect(h.reconciler.latestFor(attemptId)?.purpose).toBe("FINAL_SIZE");
    const result = await h.manager.applyOrderObservation({ venueOrderId, status: "SOMETHING_NEW" });
    expect(result.ok && result.value).toMatchObject({ state: "RECONCILING", conflict: true, finalSize: null });
    expect(h.reconciler.latestFor(attemptId)?.purpose).toBe("ORDER_STATE");
    expect(h.manager.saltGate(h.manager.order(t.orderId)?.executionGroupId as string)?.open).toBe(false);
  });

  it("refuses an observation that is not own data, or names a venue order the manager does not hold (a halt alert)", async () => {
    const h = await openHarness();
    const { venueOrderId } = await placed(h, 42);
    const getter = Object.defineProperty({ status: "CANCELED" }, "venueOrderId", { get: () => venueOrderId });
    expect(!((await h.manager.applyOrderObservation(getter)).ok)).toBe(true);
    const unknown = await h.manager.applyOrderObservation({ venueOrderId: "venue-nobody", status: "LIVE" });
    expect(!unknown.ok && unknown.refusal.code).toBe("OMS_UNKNOWN_VENUE_ORDER");
    expect(h.manager.alerts().some((alert) => alert.kind === "UNKNOWN_VENUE_ORDER" && alert.haltMarket)).toBe(true);
  });
});

describe("a fill supersedes an outstanding read (a read made before it would under-report the matched size)", () => {
  it("the old answer is refused as superseded, not taken for an evidence conflict; the fresh read is bound", async () => {
    const h = await openHarness();
    const { t, attemptId, venueOrderId } = await placed(h, 50);
    h.venue.cancel = () => ({ kind: "UNKNOWN", error: null });
    await h.manager.requestCancel(t.orderId);
    const stale = h.reconciler.latestFor(attemptId);
    expect(stale?.purpose).toBe("ORDER_STATE");
    const fill = await h.manager.recordFill({ venueTradeId: "f1", venueOrderId, shares: "2", price: "0.5", liquidityRole: "MAKER", matchedAt: "2026-10-03T00:00:00Z" });
    expect(fill.ok).toBe(true);
    const fresh = h.reconciler.latestFor(attemptId);
    expect(fresh?.requestId).not.toBe(stale?.requestId);
    // The stale read (made before the fill) says 0 matched.
    const old = await h.manager.applyReconciliation({
      requestId: stale?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId, status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    expect(!old.ok && old.refusal.code).toBe("OMS_RECONCILIATION_SUPERSEDED");
    expect(h.manager.alerts().filter((alert) => alert.kind === "EVIDENCE_CONFLICT")).toEqual([]);
    const current = await h.manager.applyReconciliation({
      requestId: fresh?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId, status: "LIVE", sizeMatched: "2", originalSize: "10" },
    });
    expect(current.ok).toBe(true);
    expect(h.manager.order(t.orderId)?.state).toBe("PARTIALLY_FILLED");
  });
});

/** Placed LIVE, canceled, and its final size confirmed by an authoritative read: released, and the group's gate open. */
async function closedAndConfirmed(h: Harness, n: number) {
  const g = group(n);
  const { t, attemptId, venueOrderId } = await placed(h, n);
  const canceled = await h.manager.requestCancel(t.orderId);
  expect(canceled.ok && canceled.value.state).toBe("CANCELED");
  const final = await answer(h, attemptId, venueOrderId, "CANCELED", "0");
  expect(final.ok).toBe(true);
  expect(h.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0", conflict: false });
  expect(h.manager.order(t.orderId)?.reservation.released).toBe(true);
  expect(h.manager.saltGate(g.executionGroupId)).toEqual({ open: true, blockers: [], remaining: "10" });
  return { g, t, attemptId, venueOrderId };
}

/** Answer the attempt's current read as PRESENT with `status` and `sizeMatched` (original size 10). */
async function answer(h: Harness, attemptId: string, venueOrderId: string, status: string, sizeMatched: string) {
  const read = h.reconciler.latestFor(attemptId);
  return h.manager.applyReconciliation({
    requestId: read?.requestId,
    submissionAttemptId: attemptId,
    verdict: "PRESENT",
    order: { venueOrderId, status, sizeMatched, originalSize: "10" },
  });
}

function stateConflictEvents(h: Harness, orderId: string): unknown[] {
  return h.store
    .snapshotSync()
    .events.filter((event) => event.orderId === orderId && event.payload !== null && "conflict" in event.payload)
    .map((event) => [event.eventType, event.reasonCode, event.payload?.["conflict"]]);
}

describe("an unrecognised status on a terminal order (r2, WP270-R2-01): reopened to RECONCILING, never assumed harmless", () => {
  it("after the authoritative final read: a halt alert, a fresh ORDER_STATE read, the gate closed; durable across a restart", async () => {
    const h = await openHarness();
    const { g, t, attemptId, venueOrderId } = await closedAndConfirmed(h, 60);
    const reads = h.reconciler.requests.length;
    const alerts = h.manager.alerts().length;
    const result = await h.manager.applyOrderObservation({ venueOrderId, status: "FUTURE_STATUS" });
    expect(result.ok && result.value).toMatchObject({ state: "RECONCILING", conflict: true, venueIdConflict: false, finalSize: null });
    expect(h.reconciler.requests.length).toBe(reads + 1);
    expect(h.reconciler.latestFor(attemptId)?.purpose).toBe("ORDER_STATE");
    expect(h.manager.alerts().slice(alerts)).toEqual([
      expect.objectContaining({ kind: "EVIDENCE_CONFLICT", haltMarket: true, orderId: t.orderId, submissionAttemptId: attemptId }),
    ]);
    expect(h.manager.saltGate(g.executionGroupId)).toEqual({ open: false, blockers: [{ id: attemptId, reason: "ORDER_RECONCILING" }], remaining: null });
    expect(stateConflictEvents(h, t.orderId).at(-1)).toEqual(["OBSERVATION_UNRECOGNISED", "UNRECOGNISED_STATUS", true]);
    // A new salt for the group is refused while it reconciles.
    const blocked = await h.manager.submit(ticket(group(60), { n: 960 }));
    expect(!blocked.ok && blocked.refusal.code).toBe("OMS_SALT_GATE_CLOSED");
    const r = await reopen(h);
    expect(r.manager.order(t.orderId)).toMatchObject({ state: "RECONCILING", conflict: true, finalSize: null });
    expect(r.manager.saltGate(g.executionGroupId)?.open).toBe(false);
    expect(r.reconciler.latestFor(attemptId)?.purpose).toBe("ORDER_STATE");
  });

  it("the fresh read that finds the order terminal clears the conflict: the gate reopens and the group can sign again, also after a restart", async () => {
    const h = await openHarness();
    const { g, t, attemptId, venueOrderId } = await closedAndConfirmed(h, 61);
    await h.manager.applyOrderObservation({ venueOrderId, status: "FUTURE_STATUS" });
    const cleared = await answer(h, attemptId, venueOrderId, "CANCELED", "0");
    expect(cleared.ok).toBe(true);
    expect(h.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0", conflict: false });
    expect(h.manager.outstandingReconciliations()).toBe(0);
    expect(h.manager.saltGate(g.executionGroupId)).toEqual({ open: true, blockers: [], remaining: "10" });
    const r = await reopen(h);
    expect(r.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0", conflict: false });
    expect(r.manager.saltGate(g.executionGroupId)?.open).toBe(true);
    const next = await r.manager.submit(ticket(group(61), { n: 961 }));
    expect(next.ok && next.value.orderState).toBe("LIVE");
  });
});

describe("a stale contradicting status on a terminal order (r2, OP-R2-02): the authoritative terminal read clears the state conflict", () => {
  it("probe L1: LIVE after the final read reopens the order; the read finding it CANCELED clears the conflict, durably; the group signs again", async () => {
    const h = await openHarness();
    const { g, t, attemptId, venueOrderId } = await closedAndConfirmed(h, 70);
    const reopened = await h.manager.applyOrderObservation({ venueOrderId, status: "LIVE" });
    expect(reopened.ok && reopened.value).toMatchObject({ state: "RECONCILING", conflict: true, finalSize: null });
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(false);
    const final = await answer(h, attemptId, venueOrderId, "CANCELED", "0");
    expect(final.ok).toBe(true);
    expect(h.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0", conflict: false });
    expect(h.manager.saltGate(g.executionGroupId)).toEqual({ open: true, blockers: [], remaining: "10" });
    expect(stateConflictEvents(h, t.orderId).slice(-2)).toEqual([
      ["EVIDENCE_CONFLICT", null, true],
      ["RECONCILED_PRESENT", null, false],
    ]);
    const r = await reopen(h);
    expect(r.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", conflict: false });
    expect(r.manager.saltGate(g.executionGroupId)?.open).toBe(true);
    expect(r.manager.alerts().filter((alert) => alert.kind === "EVIDENCE_CONFLICT")).toEqual([]);
    const next = await r.manager.submit(ticket(group(70), { n: 970 }));
    expect(next.ok && next.value.orderState).toBe("LIVE");
  });

  it("a restart between the reopen and the read re-requests the read, and its terminal answer clears the conflict", async () => {
    const h = await openHarness();
    const { g, t, attemptId, venueOrderId } = await closedAndConfirmed(h, 71);
    await h.manager.applyOrderObservation({ venueOrderId, status: "LIVE" });
    const r = await reopen(h);
    expect(r.manager.order(t.orderId)).toMatchObject({ state: "RECONCILING", conflict: true });
    const final = await answer(r, attemptId, venueOrderId, "CANCELED", "0");
    expect(final.ok).toBe(true);
    expect(r.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0", conflict: false });
    expect(r.manager.saltGate(g.executionGroupId)?.open).toBe(true);
  });

  it("an order the read finds still open, then completely filled, keeps its conflict only until a read confirms it: that read is requested, in process and after a restart", async () => {
    for (const restart of [false, true]) {
      const h = await openHarness({ balances: { pusd: "100" } });
      const n = restart ? 73 : 72;
      const g = group(n);
      const { t, attemptId, venueOrderId } = await placed(h, n);
      // Terminal by the stream, before any final-size read; then a stale LIVE reopens it.
      await h.manager.applyOrderObservation({ venueOrderId, status: "CANCELED" });
      await h.manager.applyOrderObservation({ venueOrderId, status: "LIVE" });
      expect(h.manager.order(t.orderId)).toMatchObject({ state: "RECONCILING", conflict: true });
      // The read finds it open: tracked as LIVE, the conflict still open.
      expect((await answer(h, attemptId, venueOrderId, "LIVE", "0")).ok).toBe(true);
      expect(h.manager.order(t.orderId)).toMatchObject({ state: "LIVE", conflict: true });
      const reads = h.reconciler.requests.length;
      const filled = await h.manager.recordFill({ venueTradeId: `fill-${String(n)}`, venueOrderId, shares: "10", price: "0.5", liquidityRole: "MAKER", matchedAt: "2026-10-03T00:00:00Z" });
      expect(filled.ok && filled.value).toMatchObject({ state: "FILLED", finalSize: "10", conflict: true });
      expect(h.manager.saltGate(g.executionGroupId)?.blockers).toEqual([{ id: attemptId, reason: "EVIDENCE_CONFLICT" }]);
      expect(h.manager.order(t.orderId)?.reservation.released).toBe(false);
      let m: Harness = h;
      if (restart) {
        m = await reopen(h);
        expect(m.manager.order(t.orderId)).toMatchObject({ state: "FILLED", conflict: true });
      }
      // The read that can clear the conflict is requested (after the fill, or by recovery).
      expect(m.reconciler.requests.length).toBeGreaterThan(reads);
      expect(m.reconciler.latestFor(attemptId)?.purpose).toBe("ORDER_STATE");
      expect(m.manager.outstandingReconciliations()).toBe(0);
      expect((await answer(m, attemptId, venueOrderId, "MATCHED", "10")).ok).toBe(true);
      expect(m.manager.order(t.orderId)).toMatchObject({ state: "FILLED", finalSize: "10", conflict: false });
      expect(m.manager.order(t.orderId)?.reservation.released).toBe(true);
      expect(m.manager.saltGate(g.executionGroupId)).toEqual({ open: true, blockers: [], remaining: "0" });
    }
  });
});
