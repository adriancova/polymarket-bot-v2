/**
 * WP-270: non-authoritative order observations (the user stream, WP-280's
 * normalized events). They move an open order along; they never resolve
 * RECONCILING, never turn `unmatched` into a cancel or a rejection
 * (VENUE_FACTS.UNMATCHED_ACCEPTED_NOT_FILLED), send an unrecognised status to
 * RECONCILING (never an assumption), and reopen a terminal order they
 * contradict, with a halt alert.
 */

import { describe, expect, it } from "vitest";

import { accepted, venueIdFor } from "./support/fake-venue.js";
import { group, openHarness, ticket, type Harness } from "./support/harness.js";

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

  it("an unrecognised status on a terminal order is recorded and changes nothing", async () => {
    const h = await openHarness();
    const { venueOrderId } = await placed(h, 41);
    await h.manager.applyOrderObservation({ venueOrderId, status: "EXPIRED" });
    const result = await h.manager.applyOrderObservation({ venueOrderId, status: "SOMETHING_NEW" });
    expect(result.ok && result.value.state).toBe("EXPIRED");
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
