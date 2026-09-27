/**
 * SIM-1 r2 (`SIM1-R2-1`) — the rule the trader halts a BASKET by, in
 * isolation: judged from EACH booked order's own outcome, never from the
 * venue's `accepted` alone.
 *
 * The loop-level behaviour — through the real `CoreLoop`, risk, planner and
 * `SimulatedVenue`, at submission, after `observe()`, after `observeTrade()`
 * — is pinned in `loop-refused-plan.test.ts`; this file pins every branch of
 * the rule, including the ones the real venue reaches only through timing
 * (a leg that is still working while another ended short) and the
 * fail-closed readings.
 */

import type { SimulatedOrder, SimulatedOrderState } from "@polymarket-bot/simulation";
import { describe, expect, it } from "vitest";

import { judgeBasketExecution } from "./basket-execution.js";

let sequence = 0;

function order(state: SimulatedOrderState, filledShares: string, requestedShares = "5"): SimulatedOrder {
  sequence += 1;
  return {
    simulatedOrderId: `sim-${String(sequence)}`,
    plannedOrderId: `planned-${String(sequence)}`,
    executionPlanId: "plan-1",
    marketId: "market-1",
    tokenId: "token-1",
    side: sequence % 2 === 0 ? "NO" : "YES",
    action: "BUY",
    limitPrice: "0.35",
    requestedShares,
    filledShares,
    state,
    postOnly: false,
    executionStyle: "MARKETABLE_LIMIT",
    fillEstimateKind: "POINT",
    atEvent: { gatewayEpoch: "epoch", ingestSeq: "1", receivedAt: "2026-05-01T09:00:00.000Z", datasetRowOrdinal: 1 },
  };
}

function kindOf(booked: readonly (SimulatedOrder | undefined)[], notPlaced = 0): string {
  return judgeBasketExecution({ booked, notPlaced }).kind;
}

describe("judgeBasketExecution — COMPLETE, WORKING or PARTIALLY_EXECUTED, from each order's own outcome", () => {
  it("every booked order FILLED whole: COMPLETE", () => {
    expect(kindOf([order("FILLED", "5"), order("FILLED", "5")])).toBe("COMPLETE");
  });

  it("the finding: a FILLED leg and a REJECTED 0/5 leg are PARTIALLY_EXECUTED, naming the short order", () => {
    const rejected = order("REJECTED", "0");
    const verdict = judgeBasketExecution({ booked: [order("FILLED", "5"), rejected], notPlaced: 0 });
    expect(verdict).toEqual({ kind: "PARTIALLY_EXECUTED", notAllPlaced: false, endedShort: [rejected] });
  });

  it("a leg that ended short while another can STILL execute is PARTIALLY_EXECUTED (the working leg may fill alone)", () => {
    for (const working of ["ACCEPTED", "DELAYED", "RESTING"] as const) {
      expect(kindOf([order(working, "0"), order("REJECTED", "0")]), working).toBe("PARTIALLY_EXECUTED");
      expect(kindOf([order(working, "0"), order("CANCELLED", "0")]), working).toBe("PARTIALLY_EXECUTED");
      expect(kindOf([order(working, "0"), order("EXPIRED", "0")]), working).toBe("PARTIALLY_EXECUTED");
    }
    expect(kindOf([order("PARTIALLY_FILLED", "2"), order("REJECTED", "0")])).toBe("PARTIALLY_EXECUTED");
  });

  it("an order that ended short WITH a fill is PARTIALLY_EXECUTED on its own (O1 CANCELLED 1/5, O4 EXPIRED 30/50)", () => {
    expect(kindOf([order("CANCELLED", "1")])).toBe("PARTIALLY_EXECUTED");
    expect(kindOf([order("EXPIRED", "30", "50"), order("EXPIRED", "30", "50")])).toBe("PARTIALLY_EXECUTED");
  });

  it("a basket that executed NOTHING — every booked order terminal with no fill — is COMPLETE, like a wholly refused plan", () => {
    expect(kindOf([order("REJECTED", "0"), order("REJECTED", "0")])).toBe("COMPLETE");
    expect(kindOf([order("REJECTED", "0"), order("CANCELLED", "0"), order("EXPIRED", "0")])).toBe("COMPLETE");
  });

  it("while every order can still execute and none ended short, it is WORKING — judged again later", () => {
    expect(kindOf([order("DELAYED", "0"), order("DELAYED", "0")])).toBe("WORKING");
    expect(kindOf([order("FILLED", "5"), order("RESTING", "0")])).toBe("WORKING");
    expect(kindOf([order("FILLED", "5"), order("PARTIALLY_FILLED", "3")])).toBe("WORKING");
  });

  it("R3's rule (a), unchanged: a PARTIAL answer — some booked, some NOT placed — is PARTIALLY_EXECUTED whatever the booked orders did", () => {
    expect(judgeBasketExecution({ booked: [order("FILLED", "5")], notPlaced: 1 })).toEqual({
      kind: "PARTIALLY_EXECUTED",
      notAllPlaced: true,
      endedShort: [],
    });
    expect(kindOf([order("RESTING", "0")], 3)).toBe("PARTIALLY_EXECUTED");
    expect(kindOf([order("REJECTED", "0")], 1)).toBe("PARTIALLY_EXECUTED");
    // Nothing booked is not a partial basket (the loop never watches one).
    expect(kindOf([], 4)).toBe("COMPLETE");
  });

  it("FAIL-CLOSED: an order the venue's state does not list counts as WORKING (never settled), so a short leg beside it halts", () => {
    expect(kindOf([undefined])).toBe("WORKING");
    expect(kindOf([undefined, order("FILLED", "5")])).toBe("WORKING");
    expect(kindOf([undefined, order("REJECTED", "0")])).toBe("PARTIALLY_EXECUTED");
  });

  it("FAIL-CLOSED: an unreadable quantity reads as executed AND short, so it can only ever cause a halt", () => {
    // A terminal order whose filled quantity cannot be read: short, and executed.
    expect(kindOf([order("CANCELLED", "not-a-decimal")])).toBe("PARTIALLY_EXECUTED");
    // …executed, so a zero-fill REJECTED leg beside it is short against an executed leg.
    expect(kindOf([order("FILLED", "1e2"), order("REJECTED", "0")])).toBe("PARTIALLY_EXECUTED");
    // An unreadable REQUESTED size makes a FILLED order short (it cannot prove it is whole).
    expect(kindOf([order("FILLED", "5", "five")])).toBe("PARTIALLY_EXECUTED");
  });
});
