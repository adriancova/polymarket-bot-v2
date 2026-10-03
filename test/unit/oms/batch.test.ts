/**
 * WP-270 acceptance 4 (WP-260 I-R2-2): a refused `postOrders` batch returns at
 * most 16 NOT_SENT outcomes, not one per input, so its outcomes are NEVER
 * paired with its inputs by position. A refused batch is a batch-level fact
 * ("nothing left the process"), applied to every input; any other answer that
 * is not exactly one outcome per input makes every input UNKNOWN.
 */

import { describe, expect, it } from "vitest";

import { classifyBatch, type PlacementOutcome } from "../../../packages/oms/src/index.js";

import { accepted, venueError, venueIdFor } from "./support/fake-venue.js";
import { group, openHarness, ticket } from "./support/harness.js";

const NOT_SENT: PlacementOutcome = { kind: "NOT_SENT", error: venueError("INVALID_REQUEST", "NOT_SENT") };

async function batchOf(size: number, answer: (salts: readonly string[]) => readonly PlacementOutcome[]) {
  const h = await openHarness();
  const tickets = [];
  for (let index = 0; index < size; index += 1) {
    const g = group(500 + index, { plannedShares: "1" });
    await h.manager.registerGroup(g);
    tickets.push(ticket(g, { n: 500 + index, shares: "1" }));
  }
  h.venue.batch = (handles) => answer(handles.map((handle) => handle.identity.salt));
  const result = await h.manager.submitBatch(tickets);
  return { h, tickets, result };
}

describe("acceptance 4: refused-batch outcomes are never paired by position", () => {
  it("a refused batch answering FEWER NOT_SENT outcomes than inputs closes every input as not sent", async () => {
    const { h, result } = await batchOf(3, () => [NOT_SENT]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((report) => report.attemptState)).toEqual(["ABANDONED", "ABANDONED", "ABANDONED"]);
    expect(result.value.every((report) => report.placement?.kind === "NOT_SENT")).toBe(true);
    expect(h.venue.postCalls).toHaveLength(1);
  });

  it("a refused batch answering MORE NOT_SENT outcomes than inputs (16 for 15) closes every input as not sent", async () => {
    const { result } = await batchOf(15, () => new Array<PlacementOutcome>(16).fill(NOT_SENT));
    expect(result.ok && result.value.every((report) => report.attemptState === "ABANDONED")).toBe(true);
  });

  it("a NOT_SENT mixed with an acceptance is outside the adapter's contract: every input is UNKNOWN, none is paired", async () => {
    // If the OMS paired by position, input 2 would adopt `venue-x` and input 1 would be closed as not sent.
    const { h, tickets, result } = await batchOf(3, () => [NOT_SENT, accepted("venue-x"), NOT_SENT]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((report) => report.attemptState)).toEqual(["RECONCILING", "RECONCILING", "RECONCILING"]);
    for (const t of tickets) expect(h.manager.order(t.orderId)?.venueOrderId).toBeNull();
    expect(h.reconciler.requests).toHaveLength(3);
  });

  it("a sent batch answering the wrong number of outcomes: every input is UNKNOWN", async () => {
    const { result } = await batchOf(3, (salts) => [accepted(venueIdFor(salts[0] as string)), accepted(venueIdFor(salts[1] as string))]);
    expect(result.ok && result.value.map((report) => report.placement?.kind)).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  });

  it("an empty, non-array or throwing batch answer: every input is UNKNOWN (an empty answer is not 'all NOT_SENT')", async () => {
    for (const answer of [() => [], () => ({ length: 1, 0: NOT_SENT }) as never, () => { throw new Error("socket closed"); }]) {
      const { result } = await batchOf(2, answer as never);
      expect(result.ok && result.value.map((report) => report.attemptState)).toEqual(["RECONCILING", "RECONCILING"]);
    }
  });

  it("a sent batch with exactly one outcome per input is paired in request order (the adapter's documented contract)", async () => {
    const { h, tickets, result } = await batchOf(3, (salts) => [
      accepted(venueIdFor(salts[0] as string)),
      { kind: "REJECTED", reason: "INSUFFICIENT_BALANCE_OR_ALLOWANCE" },
      { kind: "UNKNOWN", reason: "ERROR", error: venueError("RATE_LIMITED", "UNKNOWN") },
    ]);
    expect(result.ok && result.value.map((report) => report.orderState)).toEqual(["LIVE", "REJECTED", "RECONCILING"]);
    expect(h.manager.order(tickets[0]?.orderId as string)?.venueOrderId).toBe(venueIdFor(h.venue.signed[0] as string));
  });

  it("refuses a batch of 0 or 16 orders before signing anything", async () => {
    const h = await openHarness();
    expect(!((await h.manager.submitBatch([])).ok)).toBe(true);
    const many = [];
    for (let index = 0; index < 16; index += 1) many.push(ticket(group(600 + index), { n: 600 + index }));
    const result = await h.manager.submitBatch(many);
    expect(!result.ok && result.refusal.code).toBe("OMS_BATCH_SIZE");
    expect(h.venue.signed).toHaveLength(0);
  });

  it("classifyBatch, directly: refused batches never pair; mixed and mis-sized answers are UNKNOWN", () => {
    expect(classifyBatch([NOT_SENT], 4).map((cls) => cls.kind)).toEqual(["NOT_SENT", "NOT_SENT", "NOT_SENT", "NOT_SENT"]);
    expect(classifyBatch([accepted("a"), NOT_SENT], 2).map((cls) => cls.kind)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(classifyBatch([], 2).map((cls) => cls.kind)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(classifyBatch([accepted("a")], 2).map((cls) => cls.kind)).toEqual(["UNKNOWN", "UNKNOWN"]);
    const holey: unknown[] = [accepted("a")];
    holey[2] = accepted("b");
    expect(classifyBatch(holey, 3).map((cls) => cls.kind)).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  });

  it("a batch reserves in a stable asset order (WP-040 F12) and rolls back every reservation when one is refused", async () => {
    const h = await openHarness({ balances: { pusd: "6" } });
    const tickets = [];
    for (let index = 0; index < 3; index += 1) {
      const g = group(700 + index, { plannedShares: "4" });
      await h.manager.registerGroup(g);
      tickets.push(ticket(g, { n: 700 + index, shares: "4" }));
    }
    // 3 x (0.5 x 4) = 6 fits; make the third too large for what is left.
    const result = await h.manager.submitBatch([tickets[0], tickets[1], { ...tickets[2], shares: "4", limitPrice: "0.6", reservation: { ...tickets[2]?.reservation, amount: "2.4" } }]);
    expect(!result.ok && result.refusal.code).toBe("OMS_RESERVATION_REFUSED");
    expect(h.venue.signed).toHaveLength(0);
    expect(h.inventory?.book.available("paper-account-1", "asset-pusd")).toBe("6");
    for (const t of tickets) expect(h.manager.order(t?.orderId as string)?.state).toBe("CANCELED");
  });
});
