/**
 * POSITION planning — central behaviour and refusal paths.
 *
 * ORACLE DISCIPLINE: the implementation prices and sizes with exact decimal
 * strings (BigInt-scaled integers + `@polymarket-bot/decimal`); the checks
 * here cross-verify with DIFFERENT primitives — JavaScript `Number`
 * arithmetic within an epsilon for magnitudes, and `decimal.js`-backed
 * `isTickConformant` for grid conformance — alongside exact byte equality
 * for the values themselves.
 */

import { describe, expect, it } from "vitest";

import { isTickConformant } from "../../../packages/decimal/src/index.js";
import {
  buildExecutionPlan,
  type PlacementPlan,
} from "../../../packages/execution-planner/src/index.js";
import {
  EVALUATED_AT,
  approvedPosition,
  marketInput,
  planCodesOf,
  planningInputs,
  position,
  resizedPosition,
  MARKET_A,
} from "./fixtures.js";

function placement(record: unknown, inputs: unknown): PlacementPlan {
  const result = buildExecutionPlan(record, inputs);
  if (!result.ok) throw new Error(JSON.stringify(result.refusals, null, 2));
  if (result.value.planKind !== "POSITION" && result.value.planKind !== "REDUCE_POSITION") {
    throw new Error(`expected a placement plan, got ${result.value.planKind}`);
  }
  return result.value;
}

const near = (decimal: string, expected: number): void => {
  expect(Math.abs(Number(decimal) - expected)).toBeLessThan(1e-9);
};

describe("POSITION plans — the baseline (NORMAL / TAKER_OK BUY 100 YES, cap 0.5)", () => {
  const record = approvedPosition();
  const plan = placement(record, planningInputs());

  it("carries the full traceability lineage of its approved intent (§6 invariant 4)", () => {
    expect(plan.approvedIntentId).toBe(record.approvedIntentId);
    expect(plan.rootApprovedIntentId).toBe(record.rootApprovedIntentId);
    expect(plan.sourceIntentId).toBe("intent-1");
    expect(plan.strategyInstanceId).toBe(record.strategyInstanceId);
    expect(plan.runMode).toBe("PAPER");
    expect(plan.provenance).toEqual({
      approvedAt: record.approvedAt,
      lineage: "ORIGINAL",
      worstCaseBasis: "EVALUATED",
    });
  });

  it("rests at the best bid under the posture table, price-protected and on tick", () => {
    expect(plan.legSelection).toEqual({
      selected: "BUY_DIRECTION",
      side: "YES",
      action: "BUY",
      effectiveExposurePrice: "0.48",
      reason: "DIRECT",
    });
    expect(plan.priceProtection).toEqual({ mode: "CAPPED_LIMIT_ORDERS_ONLY" });
    for (const group of plan.groups) {
      for (const order of group.orders) {
        expect(order.limitPrice).toBe("0.48");
        expect(order.postOnly).toBe(true);
        expect(order.executionStyle).toBe("REST");
        // decimal.js oracle, not the implementation's BigInt arithmetic:
        expect(isTickConformant(order.limitPrice, group.tickSize)).toBe(true);
      }
    }
  });

  it("slices 100 shares into [60, 40] under maxSliceShares 60, summing exactly", () => {
    const sizes = plan.groups.flatMap((group) => group.orders.map((order) => order.shares));
    expect(sizes).toEqual(["60", "40"]);
    near(String(sizes.reduce((sum, s) => sum + Number(s), 0)), 100);
  });

  it("requires one reservation per order with identical economics (§9.10 reserve-before-submit)", () => {
    expect(plan.reservationRule).toBe("RESERVE_BEFORE_SUBMISSION");
    const orders = plan.groups.flatMap((group) => group.orders);
    expect(plan.reservations).toHaveLength(orders.length);
    for (const order of orders) {
      const reservation = plan.reservations.find((r) => r.reservationId === order.reservationId);
      expect(reservation).toBeDefined();
      expect(reservation).toMatchObject({
        marketId: order.marketId,
        side: order.side,
        action: order.action,
        price: order.limitPrice,
        shares: order.shares,
        strategyInstanceId: plan.strategyInstanceId,
        runMode: plan.runMode,
        accountingMode: plan.accountingMode,
      });
    }
  });

  it("labels its estimates as estimates, with Number-oracle magnitudes", () => {
    expect(plan.estimates.basis).toBe("ESTIMATE");
    expect(plan.estimates.worstCaseCost).toBe("48");
    near(plan.estimates.worstCaseCost, 0.48 * 100);
    expect(plan.estimates.fees).toBe("0"); // maker rate "0" in the fixture
    expect(plan.estimates.slippage).toBe("0"); // resting orders cross nothing
    expect(plan.estimates.expectedProceeds).toBe("0");
  });

  it("carries a deadline strictly after plannedAt: min(validUntil, plannedAt + lifetime)", () => {
    expect(plan.plannedAt).toBe(EVALUATED_AT);
    expect(plan.deadline).toBe("2026-09-02T12:10:00.000Z"); // 12:00 + 600000ms < 13:00
    expect(plan.escalation).toEqual({ atDeadline: "CANCEL_REMAINING" });
  });

  it("copies the intent's partial-fill policy and the policy hysteresis", () => {
    expect(plan.partialFill).toEqual({ policy: "ACCEPT_ANY" });
    expect(plan.hysteresis).toEqual({ replaceThresholdTicks: 2, minimumReplaceIntervalMs: 500 });
  });

  it("is deeply frozen: in-place edits throw instead of corrupting the plan", () => {
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.groups)).toBe(true);
    expect(Object.isFrozen(plan.groups[0]?.orders[0])).toBe(true);
    expect(Object.isFrozen(plan.reservations[0])).toBe(true);
    expect(() => {
      (plan as unknown as Record<string, unknown>)["deadline"] = "2099-01-01T00:00:00Z";
    }).toThrow();
    expect(() => {
      (plan.groups as unknown as unknown[]).push("extra");
    }).toThrow();
  });
});

describe("POSITION plans — maker/taker posture cells", () => {
  it("MAKER_ONLY + IMMEDIATE still rests (the preference is a constraint)", () => {
    const plan = placement(
      approvedPosition({ liquidityPreference: "MAKER_ONLY", urgency: "IMMEDIATE" }),
      planningInputs(),
    );
    const order = plan.groups[0]?.orders[0];
    expect(order?.executionStyle).toBe("REST");
    expect(order?.postOnly).toBe(true);
    expect(order?.limitPrice).toBe("0.48");
  });

  it("TAKER_OK + AGGRESSIVE crosses with a capped marketable limit", () => {
    const plan = placement(approvedPosition({ urgency: "AGGRESSIVE" }), planningInputs());
    const order = plan.groups[0]?.orders[0];
    expect(order?.executionStyle).toBe("MARKETABLE_LIMIT");
    expect(order?.postOnly).toBe(false);
    // min(bestAsk 0.5 + 2 ticks = 0.52, floorToTick(cap 0.5) = 0.5) = 0.5
    expect(order?.limitPrice).toBe("0.5");
    // taker fee estimate: 0.01 × (0.5 × 100) = 0.5, Number oracle:
    near(plan.estimates.fees, 0.01 * 0.5 * 100);
  });

  it("TAKER_ONLY + PASSIVE is still marketable (the preference wins)", () => {
    const plan = placement(
      approvedPosition({ liquidityPreference: "TAKER_ONLY", urgency: "PASSIVE" }),
      planningInputs(),
    );
    expect(plan.groups[0]?.orders[0]?.executionStyle).toBe("MARKETABLE_LIMIT");
  });

  it("uncapped marketable slippage is bounded by the slippage-ticks policy and estimated", () => {
    // Cap raised to 0.6: min(0.52, 0.6) = 0.52 → 2 ticks over the ask.
    const plan = placement(
      approvedPosition({ urgency: "IMMEDIATE", maximumBuyPrice: "0.6" }),
      planningInputs(),
    );
    const order = plan.groups[0]?.orders[0];
    expect(order?.limitPrice).toBe("0.52");
    near(plan.estimates.slippage, (0.52 - 0.5) * 100);
  });
});

describe("POSITION plans — the economic-leg selector (workplan acceptance 1)", () => {
  const cheaperOppositeInputs = (noHeld: string) =>
    planningInputs({
      markets: [
        marketInput({
          book: { yesBestBid: "0.48", yesBestAsk: "0.5", noBestBid: "0.5", noBestAsk: "0.55" },
          inventory: { yes: { held: "0", reserved: "0" }, no: { held: noHeld, reserved: "0" } },
        }),
      ],
    });

  it("sells the opposite token when that exposure is cheaper AND actually held", () => {
    const plan = placement(approvedPosition(), cheaperOppositeInputs("150"));
    expect(plan.legSelection).toEqual({
      selected: "SELL_OPPOSITE",
      side: "NO",
      action: "SELL",
      effectiveExposurePrice: "0.45", // 1 − 0.55
      reason: "CHEAPER_EXPOSURE",
    });
    const order = plan.groups[0]?.orders[0];
    expect(order?.action).toBe("SELL");
    expect(order?.side).toBe("NO");
    expect(order?.limitPrice).toBe("0.55");
    expect(plan.estimates.worstCaseCost).toBe("0");
    near(plan.estimates.expectedProceeds, 0.55 * 100);
  });

  it("falls back to buying when the cheaper leg is not backed by ACTUAL free inventory", () => {
    const plan = placement(approvedPosition(), cheaperOppositeInputs("50"));
    expect(plan.legSelection.selected).toBe("BUY_DIRECTION");
    expect(plan.legSelection.reason).toBe("INVENTORY_FALLBACK");
  });

  it("counts reserved shares against inventory: held 150 with 100 reserved is a fallback too", () => {
    const inputs = planningInputs({
      markets: [
        marketInput({
          book: { yesBestBid: "0.48", yesBestAsk: "0.5", noBestBid: "0.5", noBestAsk: "0.55" },
          inventory: { yes: { held: "0", reserved: "0" }, no: { held: "150", reserved: "100" } },
        }),
      ],
    });
    const plan = placement(approvedPosition(), inputs);
    expect(plan.legSelection.reason).toBe("INVENTORY_FALLBACK");
  });

  it("takes the sell leg as ONLY_FEASIBLE when collateral cannot back the buy", () => {
    const inputs = planningInputs({
      availableCollateral: "10",
      markets: [
        marketInput({
          book: { yesBestBid: "0.48", yesBestAsk: "0.5", noBestBid: "0.5", noBestAsk: "0.55" },
          inventory: { yes: { held: "0", reserved: "0" }, no: { held: "150", reserved: "0" } },
        }),
      ],
    });
    const plan = placement(approvedPosition(), inputs);
    expect(plan.legSelection.selected).toBe("SELL_OPPOSITE");
    expect(plan.legSelection.reason).toBe("ONLY_FEASIBLE");
  });

  it("refuses with BOTH reasons when neither leg is expressible", () => {
    const result = buildExecutionPlan(
      approvedPosition(),
      planningInputs({ availableCollateral: "10" }), // baseline book, zero inventory
    );
    expect(result.ok).toBe(false);
    const codes = planCodesOf(result);
    expect(codes).toContain("PLAN_COLLATERAL_INSUFFICIENT");
    expect(codes).toContain("PLAN_INVENTORY_INSUFFICIENT");
  });
});

describe("POSITION plans — sell-downs, targets, and refusal paths", () => {
  it("a negative DELTA sells the direction token out of actual holdings", () => {
    const inputs = planningInputs({
      markets: [
        marketInput({
          inventory: { yes: { held: "100", reserved: "0" }, no: { held: "0", reserved: "0" } },
        }),
      ],
    });
    const plan = placement(approvedPosition({ targetShares: "-30" }, [position()]), inputs);
    expect(plan.legSelection.selected).toBe("SELL_DIRECTION");
    const order = plan.groups[0]?.orders[0];
    expect(order).toMatchObject({ action: "SELL", side: "YES", shares: "30", limitPrice: "0.5" });
  });

  it("REFUSES a sell-down that exceeds free inventory — never downsizes silently", () => {
    const inputs = planningInputs({
      markets: [
        marketInput({
          inventory: { yes: { held: "20", reserved: "0" }, no: { held: "0", reserved: "0" } },
        }),
      ],
    });
    const result = buildExecutionPlan(approvedPosition({ targetShares: "-30" }, [position()]), inputs);
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toContain("PLAN_INVENTORY_INSUFFICIENT");
  });

  it("ABSOLUTE mode measures the delta against confirmed actual holdings", () => {
    const inputs = planningInputs({
      markets: [
        marketInput({
          inventory: { yes: { held: "100", reserved: "0" }, no: { held: "0", reserved: "0" } },
        }),
      ],
    });
    const plan = placement(
      approvedPosition({ targetMode: "ABSOLUTE", targetShares: "150" }),
      inputs,
    );
    expect(plan.groups[0]?.orders.map((o) => o.shares)).toEqual(["50"]);
  });

  it("refuses a zero delta: nothing to execute", () => {
    const inputs = planningInputs({
      markets: [
        marketInput({
          inventory: { yes: { held: "100", reserved: "0" }, no: { held: "0", reserved: "0" } },
        }),
      ],
    });
    const result = buildExecutionPlan(
      approvedPosition({ targetMode: "ABSOLUTE", targetShares: "100" }),
      inputs,
    );
    expect(planCodesOf(result)).toContain("PLAN_NOTHING_TO_EXECUTE");
  });

  it("refuses an intent whose validUntil is not after the planning instant", () => {
    const result = buildExecutionPlan(
      approvedPosition(),
      planningInputs({ plannedAt: "2026-09-02T13:00:00.000Z" }), // == validUntil
    );
    expect(planCodesOf(result)).toContain("PLAN_INTENT_EXPIRED");
  });

  it("refuses when no per-market input covers the intent's market", () => {
    const result = buildExecutionPlan(approvedPosition(), planningInputs({ markets: [] }));
    expect(planCodesOf(result)).toContain("PLAN_MARKET_INPUT_MISSING");
  });

  it("refuses a plan whose worst cost exceeds the intent's own maximumTotalCost", () => {
    const result = buildExecutionPlan(
      approvedPosition({ maximumTotalCost: "40" }), // worst cost is 48
      planningInputs(),
    );
    expect(planCodesOf(result)).toContain("PLAN_EXCEEDS_MAXIMUM_TOTAL_COST");
  });

  it("refuses when no price protection is derivable (no book, no floor, sell side)", () => {
    const inputs = planningInputs({
      markets: [
        marketInput({
          book: undefined,
          inventory: { yes: { held: "100", reserved: "0" }, no: { held: "0", reserved: "0" } },
        }),
      ],
    });
    // The fixture intent carries no minimumSellPrice; without a book there is
    // no bound at all for the sell leg, and nothing unprotected is planned.
    const result = buildExecutionPlan(approvedPosition({ targetShares: "-30" }, [position()]), inputs);
    expect(planCodesOf(result)).toContain("PLAN_PRICE_PROTECTION_UNAVAILABLE");
  });

  it("rests at the floored intent cap when only the cap exists (bookless maker buy)", () => {
    const inputs = planningInputs({ markets: [marketInput({ book: undefined })] });
    const plan = placement(approvedPosition(), inputs);
    const order = plan.groups[0]?.orders[0];
    expect(order?.limitPrice).toBe("0.5");
    expect(order?.postOnly).toBe(true);
  });
});

describe("POSITION plans — slicing (§9.10)", () => {
  it("folds a sub-minimum remainder into the final slice, conserving the total", () => {
    const inputs = planningInputs({
      policy: {
        maxSliceShares: "7",
        marketableSlippageTicks: 2,
        replaceThresholdTicks: 2,
        minimumReplaceIntervalMs: 500,
        cancelDeadlineMs: 30000,
        maxPlanLifetimeMs: 600000,
      },
    });
    const plan = placement(approvedPosition(), inputs);
    const sizes = plan.groups.flatMap((g) => g.orders.map((o) => o.shares));
    // 100 = 14×7 + 2; the 2 is below minimum order size 5 and folds: 13×7 + 9.
    expect(sizes).toHaveLength(14);
    expect(sizes.slice(0, 13)).toEqual(Array.from({ length: 13 }, () => "7"));
    expect(sizes[13]).toBe("9");
    near(String(sizes.reduce((sum, s) => sum + Number(s), 0)), 100);
  });

  it("refuses a total below the market's minimum order size", () => {
    const result = buildExecutionPlan(
      approvedPosition(),
      planningInputs({ markets: [marketInput({ minimumOrderSize: "200" })] }),
    );
    expect(planCodesOf(result)).toContain("PLAN_BELOW_MINIMUM_ORDER_SIZE");
  });

  it("refuses a slicing policy below the market minimum", () => {
    const inputs = planningInputs({
      policy: {
        maxSliceShares: "2",
        marketableSlippageTicks: 2,
        replaceThresholdTicks: 2,
        minimumReplaceIntervalMs: 500,
        cancelDeadlineMs: 30000,
        maxPlanLifetimeMs: 600000,
      },
    });
    const result = buildExecutionPlan(approvedPosition(), inputs);
    expect(planCodesOf(result)).toContain("PLAN_SLICING_INCOHERENT");
  });

  it("refuses an absurd slice count instead of planning an order stream", () => {
    const inputs = planningInputs({
      markets: [marketInput({ minimumOrderSize: "0.1" })],
      policy: {
        maxSliceShares: "0.5",
        marketableSlippageTicks: 2,
        replaceThresholdTicks: 2,
        minimumReplaceIntervalMs: 500,
        cancelDeadlineMs: 30000,
        maxPlanLifetimeMs: 600000,
      },
    });
    const result = buildExecutionPlan(approvedPosition(), inputs);
    expect(planCodesOf(result)).toContain("PLAN_SLICING_INCOHERENT");
  });
});

describe("POSITION plans — resized lineage (WP-180 follow_up 3)", () => {
  it("plans a RESIZED record and records the inherited worst-case basis", () => {
    const record = resizedPosition("40");
    const plan = placement(record, planningInputs());
    expect(plan.provenance.lineage).toBe("RESIZED");
    expect(plan.provenance.worstCaseBasis).toBe("INHERITED_UPPER_BOUND");
    expect(plan.approvedIntentId).toBe("approved-1-resized");
    expect(plan.rootApprovedIntentId).toBe("approved-1");
    expect(plan.groups[0]?.orders.map((o) => o.shares)).toEqual(["40"]);
  });
});

describe("QUOTE intents — the recorded domain gap", () => {
  it("refuses with PLAN_QUOTE_UNSUPPORTED instead of inventing which token is quoted", () => {
    const clone = JSON.parse(JSON.stringify(approvedPosition())) as Record<string, unknown>;
    clone["intent"] = {
      type: "QUOTE",
      intentId: "intent-quote-1",
      marketId: MARKET_A,
      bids: [{ price: "0.4", shares: "10" }],
      asks: [],
      postOnly: true,
      quoteLifetimeMs: 1000,
      replaceThresholdTicks: 1,
      maximumInventory: "100",
      tags: [],
    };
    const result = buildExecutionPlan(clone, planningInputs());
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toEqual(["PLAN_QUOTE_UNSUPPORTED"]);
  });
});
