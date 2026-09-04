/**
 * REDUCE_POSITION and BASKET planning — central behaviour and refusals.
 *
 * The basket half is workplan acceptance 3's home: a coordinated basket plan
 * is labeled `"COORDINATED"` and NOTHING else, carries the intent's own
 * leg-risk and combined-cost ceilings, and enforces both with exact
 * arithmetic before anything is planned.
 */

import { describe, expect, it } from "vitest";

import {
  buildExecutionPlan,
  type BasketPlan,
  type PlacementPlan,
} from "../../../packages/execution-planner/src/index.js";
import {
  MARKET_A,
  MARKET_B,
  approvedBasket,
  approvedReduction,
  basketIntent,
  marketInput,
  planCodesOf,
  planningInputs,
  position,
} from "./fixtures.js";

function built<T extends "REDUCE_POSITION" | "BASKET">(
  kind: T,
  record: unknown,
  inputs: unknown,
): T extends "BASKET" ? BasketPlan : PlacementPlan {
  const result = buildExecutionPlan(record, inputs);
  if (!result.ok) throw new Error(JSON.stringify(result.refusals, null, 2));
  if (result.value.planKind !== kind) throw new Error(`expected ${kind}, got ${result.value.planKind}`);
  return result.value as T extends "BASKET" ? BasketPlan : PlacementPlan;
}

function heldYes(held: string, reserved = "0") {
  return planningInputs({
    markets: [
      marketInput({
        inventory: { yes: { held, reserved }, no: { held: "0", reserved: "0" } },
      }),
    ],
  });
}

describe("REDUCE_POSITION plans", () => {
  it("sells the excess over the target out of ACTUAL holdings, resting at the floor-respecting ask", () => {
    const plan = built("REDUCE_POSITION", approvedReduction(), heldYes("100"));
    expect(plan.priority).toBe("PLACEMENT");
    expect(plan.legSelection.selected).toBe("SELL_DIRECTION");
    const orders = plan.groups.flatMap((g) => g.orders);
    expect(orders.map((o) => o.shares)).toEqual(["60", "40"]); // 100 excess, sliced
    for (const order of orders) {
      // REST sell joins the ask (0.5), already above the 0.4 intent floor.
      expect(order).toMatchObject({ action: "SELL", side: "YES", limitPrice: "0.5", postOnly: true });
    }
    // ANY partial reduction is progress (§6 invariant 10); stated rule.
    expect(plan.partialFill).toEqual({ policy: "ACCEPT_ANY" });
    expect(plan.estimates.basis).toBe("ESTIMATE");
    expect(plan.estimates.expectedProceeds).toBe("50");
    expect(plan.reservations).toHaveLength(orders.length);
  });

  it("reduces toward a non-zero target: held 100, target 40 sells exactly 60", () => {
    const plan = built(
      "REDUCE_POSITION",
      approvedReduction({ targetShares: "40" }),
      heldYes("100"),
    );
    expect(plan.groups.flatMap((g) => g.orders).map((o) => o.shares)).toEqual(["60"]);
  });

  it("crosses under AGGRESSIVE urgency with a floored marketable limit and estimated slippage", () => {
    const plan = built(
      "REDUCE_POSITION",
      approvedReduction({ urgency: "AGGRESSIVE" }),
      heldYes("100"),
    );
    const order = plan.groups[0]?.orders[0];
    // max(bestBid 0.48 − 2 ticks = 0.46, ceil(0.4) = 0.4) = 0.46
    expect(order?.limitPrice).toBe("0.46");
    expect(order?.executionStyle).toBe("MARKETABLE_LIMIT");
    expect(Math.abs(Number(plan.estimates.slippage) - (0.48 - 0.46) * 100)).toBeLessThan(1e-9);
    expect(Math.abs(Number(plan.estimates.fees) - 0.01 * 0.46 * 100)).toBeLessThan(1e-9);
  });

  it("REFUSES when reserved shares leave the sell-down unbacked — never downsizes", () => {
    const result = buildExecutionPlan(approvedReduction(), heldYes("100", "50"));
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toContain("PLAN_INVENTORY_INSUFFICIENT");
  });

  it("refuses when nothing is held above the target", () => {
    const result = buildExecutionPlan(approvedReduction({ targetShares: "100" }), heldYes("100"));
    expect(planCodesOf(result)).toContain("PLAN_NOTHING_TO_EXECUTE");
  });
});

describe("BASKET plans (workplan acceptance 3)", () => {
  it("labels the basket COORDINATED — and only COORDINATED — with the intent's own risk policy", () => {
    const plan = built("BASKET", approvedBasket(), planningInputs());
    expect(plan.coordination).toBe("COORDINATED");
    expect(plan.failurePolicy).toBe("ABANDON");
    expect(plan.legRiskLimit).toBe("30");
    expect(plan.maximumCombinedCost).toBe("30");
    // The word "atomic" appears NOWHERE in the emitted plan, under any key.
    expect(JSON.stringify(plan).toLowerCase()).not.toContain("atomic");
    const order = plan.groups[0]?.orders[0];
    // marketable: min(ask 0.5 + 2 ticks, floorToTick(0.5)) = 0.5; one 50-share slice
    expect(order).toMatchObject({
      action: "BUY",
      side: "YES",
      limitPrice: "0.5",
      shares: "50",
      executionStyle: "MARKETABLE_LIMIT",
    });
    expect(plan.estimates.worstCaseCost).toBe("25");
    expect(plan.reservations).toHaveLength(1);
  });

  it("plans one execution group per leg across markets", () => {
    const record = approvedBasket(
      {
        legs: [
          { marketId: MARKET_A, direction: "YES", targetShares: "50", maximumBuyPrice: "0.5" },
          { marketId: MARKET_B, direction: "YES", targetShares: "50", maximumBuyPrice: "0.4" },
        ],
        maximumCombinedCost: "50",
        legRiskLimit: "30",
      },
      { marketIds: [MARKET_A, MARKET_B] },
    );
    const inputs = planningInputs({
      markets: [
        marketInput(),
        marketInput({
          marketId: MARKET_B,
          book: { yesBestBid: "0.38", yesBestAsk: "0.42", noBestBid: "0.58", noBestAsk: "0.62" },
        }),
      ],
    });
    const plan = built("BASKET", record, inputs);
    expect(plan.groups.map((g) => g.marketId)).toEqual([MARKET_A, MARKET_B]);
    // Leg B: min(0.42 + 0.02, floor(0.4)) = 0.4
    expect(plan.groups[1]?.orders[0]?.limitPrice).toBe("0.4");
    // combined worst cost 25 + 20 = 45 ≤ 50
    expect(plan.estimates.worstCaseCost).toBe("45");
  });

  it("plans a selling leg out of actual holdings", () => {
    const record = approvedBasket(
      {
        legs: [
          { marketId: MARKET_A, direction: "NO", targetShares: "-50", minimumSellPrice: "0.45" },
        ],
      },
      { positions: [position({ side: "NO" })] },
    );
    const inputs = planningInputs({
      markets: [
        marketInput({
          inventory: { yes: { held: "0", reserved: "0" }, no: { held: "60", reserved: "0" } },
        }),
      ],
    });
    const plan = built("BASKET", record, inputs);
    const order = plan.groups[0]?.orders[0];
    // marketable sell: max(bid 0.5 − 0.02, ceil(0.45)) = 0.48
    expect(order).toMatchObject({ action: "SELL", side: "NO", limitPrice: "0.48", shares: "50" });
  });

  it("REFUSES a selling leg the holdings do not back (acceptance 1 on the basket path)", () => {
    const record = approvedBasket(
      {
        legs: [
          { marketId: MARKET_A, direction: "NO", targetShares: "-50", minimumSellPrice: "0.45" },
        ],
      },
      { positions: [position({ side: "NO" })] },
    );
    const inputs = planningInputs({
      markets: [
        marketInput({
          inventory: { yes: { held: "0", reserved: "0" }, no: { held: "10", reserved: "0" } },
        }),
      ],
    });
    const result = buildExecutionPlan(record, inputs);
    expect(planCodesOf(result)).toContain("PLAN_INVENTORY_INSUFFICIENT");
  });

  it("refuses a leg whose worst cost exceeds the basket's own legRiskLimit", () => {
    const result = buildExecutionPlan(approvedBasket({ legRiskLimit: "20" }), planningInputs());
    expect(planCodesOf(result)).toContain("PLAN_BASKET_LEG_RISK_EXCEEDED");
  });

  it("refuses a basket whose combined cost exceeds maximumCombinedCost", () => {
    const result = buildExecutionPlan(approvedBasket({ maximumCombinedCost: "20" }), planningInputs());
    expect(planCodesOf(result)).toContain("PLAN_BASKET_COMBINED_COST_EXCEEDED");
  });

  it("refuses an unbounded buying leg even on a hand-mutated record", () => {
    // The risk engine refuses these at approval, so an unbounded leg can only
    // arrive hand-built; the planner restates the rule rather than trusting
    // its upstream blindly.
    const clone = JSON.parse(JSON.stringify(approvedBasket())) as {
      intent: { legs: Array<Record<string, unknown>> };
    };
    delete clone.intent.legs[0]?.["maximumBuyPrice"];
    const result = buildExecutionPlan(clone, planningInputs());
    expect(planCodesOf(result)).toContain("PLAN_BASKET_LEG_UNBOUNDED");
  });

  it("refuses when the collateral cannot back the combined legs", () => {
    const result = buildExecutionPlan(
      approvedBasket(),
      planningInputs({ availableCollateral: "10" }),
    );
    expect(planCodesOf(result)).toContain("PLAN_COLLATERAL_INSUFFICIENT");
  });

  it("sanity: the basket intent fixture round-trips risk approval", () => {
    // Guards the fixture itself: a drifted basketIntent would silently turn
    // every basket test above into a fixture-throw rather than a planner test.
    expect(basketIntent()["type"]).toBe("BASKET");
  });
});
