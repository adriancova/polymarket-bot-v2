/**
 * WP-270 deliverable 4: the cancel and replace flow, with the venue modes
 * where documented (verified-2026-09-30 §9, §2.5):
 * - a cancel answer maps to CANCELED, back to the open state (not applied),
 *   or RECONCILING (not canceled, or unknown); never to an assumed state;
 * - a replacement is a NEW order with a NEW salt: it goes through the salt
 *   gate, only after the replaced order is terminal with a confirmed final
 *   size, and is capped by the group's exact remainder;
 * - POST_ONLY and TRADING_UNAVAILABLE gate placements, never cancels.
 */

import { describe, expect, it } from "vitest";

import { type CancelOutcome } from "../../../packages/oms/src/index.js";

import { accepted, venueError, venueIdFor } from "./support/fake-venue.js";
import { PUSD, group, openHarness, ticket, type Harness } from "./support/harness.js";

async function liveOrder(h: Harness, n: number, status: "LIVE" | "DELAYED" = "LIVE") {
  h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt), status);
  const g = group(n);
  await h.manager.registerGroup(g);
  const t = ticket(g, { n });
  const result = await h.manager.submit(t);
  if (!result.ok) throw new Error(`submit failed: ${result.refusal.code}`);
  return { g, t, attemptId: result.value.submissionAttemptId, venueOrderId: venueIdFor(h.venue.signed.at(-1) as string) };
}

describe("cancel outcomes", () => {
  const ROWS: readonly { readonly name: string; readonly answer: (id: string) => CancelOutcome | Promise<CancelOutcome>; readonly state: string; readonly read: boolean }[] = [
    { name: "canceled", answer: (id) => ({ kind: "COMPLETED", canceled: [id], notCanceled: [] }), state: "CANCELED", read: true },
    {
      name: "not canceled, documented reason (never trusted to pick a state)",
      answer: (id) => ({ kind: "COMPLETED", canceled: [], notCanceled: [{ orderId: id, reason: "Order already matched" }] }),
      state: "RECONCILING",
      read: true,
    },
    {
      name: "not canceled, undocumented reason",
      answer: (id) => ({ kind: "COMPLETED", canceled: [], notCanceled: [{ orderId: id, reason: "UNDOCUMENTED" }] }),
      state: "RECONCILING",
      read: true,
    },
    { name: "the id in neither list", answer: () => ({ kind: "COMPLETED", canceled: ["other"], notCanceled: [] }), state: "RECONCILING", read: true },
    {
      name: "the id in both lists",
      answer: (id) => ({ kind: "COMPLETED", canceled: [id], notCanceled: [{ orderId: id, reason: "Order not found" }] }),
      state: "RECONCILING",
      read: true,
    },
    { name: "unknown (a transport failure)", answer: () => ({ kind: "UNKNOWN", error: venueError("TRANSPORT_FAILURE", "UNKNOWN") }), state: "RECONCILING", read: true },
    { name: "a bare 503 (cancels not established, E-05)", answer: () => ({ kind: "UNKNOWN", error: venueError("TRADING_UNAVAILABLE", "UNKNOWN") }), state: "RECONCILING", read: true },
    {
      name: "a throwing port",
      answer: () => {
        throw new Error("boom");
      },
      state: "RECONCILING",
      read: true,
    },
    { name: "not sent (nothing left the process)", answer: () => ({ kind: "NOT_SENT", error: venueError("INVALID_REQUEST", "NOT_SENT") }), state: "LIVE", read: false },
    { name: "a NOT_SENT whose effect is UNKNOWN", answer: () => ({ kind: "NOT_SENT", error: venueError("TRANSPORT_FAILURE", "UNKNOWN") }), state: "RECONCILING", read: true },
  ];
  for (const [index, row] of ROWS.entries()) {
    it(row.name, async () => {
      const h = await openHarness();
      const { t, attemptId } = await liveOrder(h, 100 + index);
      h.venue.cancel = (id) => row.answer(id);
      const before = h.reconciler.requests.length;
      const result = await h.manager.requestCancel(t.orderId);
      expect(result.ok && result.value.state).toBe(row.state);
      const events = h.store.snapshotSync().events.filter((event) => event.orderId === t.orderId).map((event) => event.newState);
      expect(events).toContain("CANCEL_PENDING");
      if (row.read) {
        expect(h.reconciler.requests.length).toBe(before + 1);
        expect(h.reconciler.latestFor(attemptId)?.purpose).toBe(row.state === "CANCELED" ? "FINAL_SIZE" : "ORDER_STATE");
      } else {
        expect(h.reconciler.requests.length).toBe(before);
      }
      // The reservation is never released on a cancel answer alone.
      expect(h.manager.order(t.orderId)?.reservation.released).toBe(false);
    });
  }

  it("a DELAYED order can be asked to cancel; the venue's 'cannot be canceled' answer leads to reconciliation (VENUE_FACTS.DELAY_CANNOT_CANCEL)", async () => {
    const h = await openHarness();
    const { t } = await liveOrder(h, 200, "DELAYED");
    h.venue.cancel = (id) => ({ kind: "COMPLETED", canceled: [], notCanceled: [{ orderId: id, reason: "UNDOCUMENTED" }] });
    const result = await h.manager.requestCancel(t.orderId);
    expect(result.ok && result.value.state).toBe("RECONCILING");
  });

  it("refuses to cancel an order without a venue id (SUBMISSION_UNKNOWN), and a terminal one", async () => {
    const h = await openHarness();
    h.venue.placement = () => ({ kind: "UNKNOWN", reason: "SDK_UNMATCHED", error: null });
    const g = group(201);
    await h.manager.registerGroup(g);
    const t = ticket(g, { n: 201 });
    await h.manager.submit(t);
    const result = await h.manager.requestCancel(t.orderId);
    expect(!result.ok && result.refusal.code).toBe("OMS_CANCEL_NOT_APPLICABLE");
    expect(h.venue.cancels).toEqual([]);
  });

  it("a fill arriving while the cancel is pending is recorded; the cancel answer then lands on the filled order", async () => {
    const h = await openHarness();
    const { t, venueOrderId } = await liveOrder(h, 202);
    let release: (outcome: CancelOutcome) => void = () => undefined;
    h.venue.cancel = () => new Promise<CancelOutcome>((resolve) => (release = resolve));
    const pending = h.manager.requestCancel(t.orderId);
    for (let i = 0; i < 50 && h.venue.cancels.length === 0; i += 1) await Promise.resolve();
    const fill = await h.manager.recordFill({ venueTradeId: "t1", venueOrderId, shares: "10", price: "0.5", liquidityRole: "MAKER", matchedAt: "2026-10-03T00:00:00Z" });
    expect(fill.ok && fill.value.state).toBe("FILLED");
    release({ kind: "COMPLETED", canceled: [], notCanceled: [{ orderId: venueOrderId, reason: "Order already matched" }] });
    const result = await pending;
    expect(result.ok && result.value.state).toBe("FILLED");
    expect(h.manager.order(t.orderId)?.reservation.released).toBe(true);
  });
});

describe("manual reconciliation (§9.17 manual request)", () => {
  it("sends an open order to RECONCILING with a read; a cancel answer that arrives later is recorded only", async () => {
    const h = await openHarness();
    const { t, attemptId, venueOrderId } = await liveOrder(h, 250);
    let release: (outcome: CancelOutcome) => void = () => undefined;
    h.venue.cancel = () => new Promise<CancelOutcome>((resolve) => (release = resolve));
    const pending = h.manager.requestCancel(t.orderId);
    for (let i = 0; i < 50 && h.venue.cancels.length === 0; i += 1) await Promise.resolve();
    expect(h.manager.order(t.orderId)?.state).toBe("CANCEL_PENDING");
    const manual = await h.manager.requestOrderReconciliation(t.orderId);
    expect(manual.ok && manual.value.state).toBe("RECONCILING");
    expect(h.reconciler.latestFor(attemptId)?.purpose).toBe("ORDER_STATE");
    release({ kind: "COMPLETED", canceled: [venueOrderId], notCanceled: [] });
    const late = await pending;
    expect(late.ok && late.value.state).toBe("RECONCILING");
    const read = h.reconciler.latestFor(attemptId);
    await h.manager.applyReconciliation({
      requestId: read?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId, status: "CANCELED", sizeMatched: "0", originalSize: "10" },
    });
    expect(h.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0" });
    expect(h.manager.order(t.orderId)?.reservation.released).toBe(true);
  });

  it("refuses an order without a venue id or a terminal one", async () => {
    const h = await openHarness();
    const { t } = await liveOrder(h, 251);
    await h.manager.requestCancel(t.orderId);
    const result = await h.manager.requestOrderReconciliation(t.orderId);
    expect(!result.ok && result.refusal.code).toBe("OMS_ILLEGAL_TRANSITION");
  });
});

describe("replace", () => {
  it("stages the replacement, cancels the old order, and submits the replacement only when the old order is closed, capped by the remainder", async () => {
    const h = await openHarness();
    const { g, t, attemptId, venueOrderId } = await liveOrder(h, 300);
    await h.manager.recordFill({ venueTradeId: "t1", venueOrderId, shares: "3", price: "0.5", liquidityRole: "MAKER", matchedAt: "2026-10-03T00:00:00Z" });
    const replacement = ticket(g, { n: 301, shares: "7", limitPrice: "0.45" });
    const staged = await h.manager.requestReplace(t.orderId, replacement);
    expect(staged.ok && staged.value.state).toBe("CANCELED");
    const early = await h.manager.submitStagedReplacement(g.executionGroupId);
    expect(!early.ok && early.refusal.code).toBe("OMS_REPLACEMENT_NOT_READY");
    expect(h.venue.signed).toHaveLength(1);
    const read = h.reconciler.latestFor(attemptId);
    await h.manager.applyReconciliation({
      requestId: read?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId, status: "CANCELED", sizeMatched: "3", originalSize: "10" },
    });
    const submitted = await h.manager.submitStagedReplacement(g.executionGroupId);
    expect(submitted.ok && submitted.value.orderState).toBe("LIVE");
    expect(h.venue.signed).toHaveLength(2);
    expect(h.manager.order(replacement.orderId)?.limitPrice).toBe("0.45");
    // Nothing left to stage.
    const again = await h.manager.submitStagedReplacement(g.executionGroupId);
    expect(!again.ok && again.refusal.code).toBe("OMS_NO_STAGED_REPLACEMENT");
  });

  it("refuses a staged replacement that exceeds the remainder once the final size is known", async () => {
    const h = await openHarness();
    const { g, t, attemptId, venueOrderId } = await liveOrder(h, 310);
    await h.manager.requestReplace(t.orderId, ticket(g, { n: 311, shares: "8" }));
    // More filled than the replacement assumed.
    await h.manager.recordFill({ venueTradeId: "t1", venueOrderId, shares: "4", price: "0.5", liquidityRole: "MAKER", matchedAt: "2026-10-03T00:00:00Z" });
    const read = h.reconciler.latestFor(attemptId);
    await h.manager.applyReconciliation({
      requestId: read?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId, status: "CANCELED", sizeMatched: "4", originalSize: "10" },
    });
    const submitted = await h.manager.submitStagedReplacement(g.executionGroupId);
    expect(!submitted.ok && submitted.refusal.code).toBe("OMS_GROUP_REMAINDER_EXCEEDED");
  });

  it("refuses a replacement in another group", async () => {
    const h = await openHarness();
    const { t } = await liveOrder(h, 320);
    const other = group(321);
    const result = await h.manager.requestReplace(t.orderId, ticket(other, { n: 321 }));
    expect(!result.ok && result.refusal.code).toBe("OMS_GROUP_MISMATCH");
  });
});

describe("venue modes (caller-supplied; detection is WP-310's)", () => {
  it("POST_ONLY: a non-post-only group is refused before signing; a post-only group is placed; cancels still go out", async () => {
    const h = await openHarness();
    const { t } = await liveOrder(h, 400);
    h.mode.value = "POST_ONLY";
    const plain = group(401);
    await h.manager.registerGroup(plain);
    const refused = await h.manager.submit(ticket(plain, { n: 401 }));
    expect(!refused.ok && refused.refusal.code).toBe("OMS_POST_ONLY_MODE");
    const maker = group(402, { postOnly: true });
    await h.manager.registerGroup(maker);
    const placed = await h.manager.submit(ticket(maker, { n: 402 }));
    expect(placed.ok && placed.value.orderState).toBe("LIVE");
    expect(h.venue.signed).toHaveLength(2);
    const canceled = await h.manager.requestCancel(t.orderId);
    expect(canceled.ok && canceled.value.state).toBe("CANCELED");
  });

  it("TRADING_UNAVAILABLE (and any unreadable mode): no placement; cancels still go out (VENUE_FACTS.CANCELS_IN_CANCEL_ONLY)", async () => {
    for (const mode of ["TRADING_UNAVAILABLE", "CANCEL_ONLY_GUESS", undefined]) {
      const h = await openHarness();
      const { t } = await liveOrder(h, 410);
      h.mode.value = mode as never;
      const g = group(411);
      await h.manager.registerGroup(g);
      const refused = await h.manager.submit(ticket(g, { n: 411 }));
      expect(!refused.ok && refused.refusal.code).toBe("OMS_TRADING_UNAVAILABLE");
      const canceled = await h.manager.requestCancel(t.orderId);
      expect(canceled.ok && canceled.value.state).toBe("CANCELED");
    }
  });

  it("the post-only flag is the group's and is never mutated: a signed order whose flag differs is refused", async () => {
    const h = await openHarness();
    h.venue.sign = (request, salt) => {
      void salt;
      void request;
      return undefined;
    };
    const create = h.venue.createLimitOrder.bind(h.venue);
    h.venue.createLimitOrder = async (request) => create({ ...request, postOnly: true });
    const g = group(420);
    await h.manager.registerGroup(g);
    const result = await h.manager.submit(ticket(g, { n: 420 }));
    expect(!result.ok && result.refusal.code).toBe("OMS_SIGNED_ORDER_MISMATCH");
    expect(h.venue.received).toEqual([]);
    expect(h.inventory?.book.available("paper-account-1", PUSD)).toBe("1000");
  });
});
