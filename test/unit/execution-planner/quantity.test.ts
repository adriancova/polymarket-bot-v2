/**
 * ADR-034 D2 (`CO3-N1`): ONE EXECUTABLE QUANTITY, quantized once, in the planner.
 *
 * D2.6 item 4's planner obligations: the quantizer on exact decimals for every
 * tick size, both sides and collateral inputs; slicing on the grid; the
 * recorded remainder; and the seal that keeps a hand-built plan on the grid.
 * Every expected value is an exact decimal string; nothing here uses a
 * `number` for an economic value.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PLANNER_REFUSAL_CODES,
  PLANNER_REFUSAL_CODE_COUNT,
  VENUE_PRECISION_TABLE,
  buildExecutionPlan,
  checkMinimumOrderSize,
  collateralBuySignedShares,
  isOnSizeGrid,
  quantizeOrderQuantity,
  sealExecutionPlan,
  sizeGridFor,
  sliceShares,
  venuePrecisionFor,
  type ExecutionPlan,
  type PlacementPlan,
  type PlannedOrder,
} from "../../../packages/execution-planner/src/index.js";
import {
  MARKET_A,
  approvedBasket,
  approvedPosition,
  approvedReduction,
  marketInput,
  planCodesOf,
  planningInputs,
} from "./fixtures.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const ADDENDUM = readFileSync(resolve(REPO_ROOT, "docs/venue/verified-2026-10-06.md"), "utf8").replace(/\s+/gu, " ");

const TICKS = ["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"] as const;

function quantized(requested: string, tickSize = "0.01", unit: "SHARES" | "COLLATERAL" = "SHARES") {
  const result = quantizeOrderQuantity({ requested, unit, tickSize });
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusals.map((refusal) => refusal.code))}`);
  return result.value;
}

function codes(result: { readonly ok: boolean; readonly refusals?: readonly { readonly code: string }[] }): string[] {
  return planCodesOf(result);
}

function plan(record: unknown, inputs: unknown = planningInputs()): PlacementPlan {
  const result = buildExecutionPlan(record, inputs);
  if (!result.ok) throw new Error(JSON.stringify(result.refusals.map((refusal) => refusal.code)));
  if (result.value.planKind === "CANCEL") throw new Error("expected a placement plan");
  return result.value as PlacementPlan;
}

function ordersOf(p: PlacementPlan): PlannedOrder[] {
  return p.groups.flatMap((group) => [...group.orders]);
}

describe("D2.1: the grid comes from the venue's precision table, keyed by tick size", () => {
  it("the table is A F-99's, row for row, and every tick's size grid is 0.01", () => {
    for (const row of VENUE_PRECISION_TABLE) {
      const line = `| \`${row.tickSize}\` | ${String(row.priceDecimals)} | ${String(row.sizeDecimals)} | ${String(row.amountDecimals)} |`;
      expect(ADDENDUM, line).toContain(line);
      expect(sizeGridFor(row.tickSize)).toBe("0.01");
    }
    expect(VENUE_PRECISION_TABLE.map((row) => row.tickSize)).toEqual([...TICKS]);
    expect(ADDENDUM).toContain("`size: 2` for each of the six ticks; `amount` 3, 4, 5, 6, 5, 6.");
  });

  it.each(["0.02", "0.05", "0.03", "0.000001", "0.010", "1", "0", "-0.01", "", "1e-2"])("an unknown tick size %j is refused PLAN_TICK_SIZE_UNSUPPORTED", (tickSize) => {
    expect(venuePrecisionFor(tickSize)).toBeUndefined();
    expect(sizeGridFor(tickSize)).toBeUndefined();
    expect(codes(quantizeOrderQuantity({ requested: "5", unit: "SHARES", tickSize }))).toEqual(["PLAN_TICK_SIZE_UNSUPPORTED"]);
  });

  it("the refusal vocabulary gains PLAN_TICK_SIZE_UNSUPPORTED (21 codes)", () => {
    expect(PLANNER_REFUSAL_CODES).toContain("PLAN_TICK_SIZE_UNSUPPORTED");
    expect(PLANNER_REFUSAL_CODES).toHaveLength(PLANNER_REFUSAL_CODE_COUNT);
    expect(PLANNER_REFUSAL_CODE_COUNT).toBe(21);
  });
});

describe("D2.2/D2.3: the quantizer floors once, exactly, and records the remainder", () => {
  for (const tickSize of TICKS) {
    for (const unit of ["SHARES", "COLLATERAL"] as const) {
      it(`tick ${tickSize}, ${unit}: floors to 0.01 and records SUB_GRID; on-grid values pass unchanged`, () => {
        for (const [requested, executable, remainder] of [
          ["5.009", "5", "0.009"],
          ["5", "5", "0"],
          ["0.01", "0.01", "0"],
          ["0.019", "0.01", "0.009"],
          ["50.857142", "50.85", "0.007142"],
          ["17.509", "17.5", "0.009"],
          ["49.995", "49.99", "0.005"],
          ["123.456789012345678901234567", "123.45", "0.006789012345678901234567"],
          ["1000000.999999", "1000000.99", "0.009999"],
          ["7.5", "7.5", "0"],
        ] as const) {
          const q = quantized(requested, tickSize, unit);
          expect(q, requested).toEqual({
            unit,
            tickSize,
            requested,
            executable,
            unexecutableRemainder: remainder,
            reason: remainder === "0" ? null : "SUB_GRID",
          });
        }
      });
    }
  }

  it("never rounds up: 0.0199999 floors to 0.01, and 4.999999 to 4.99", () => {
    expect(quantized("0.0199999").executable).toBe("0.01");
    expect(quantized("4.999999").executable).toBe("4.99");
  });

  it.each(["0.009", "0.0001", "0.000001"])("a quantity that floors to 0 (%s) is refused PLAN_BELOW_MINIMUM_ORDER_SIZE", (requested) => {
    expect(codes(quantizeOrderQuantity({ requested, unit: "SHARES", tickSize: "0.01" }))).toEqual(["PLAN_BELOW_MINIMUM_ORDER_SIZE"]);
  });

  it.each(["1e-7", "-5", "-0", "0", "5.", ".5", "05", "5.0", "+5", " 5", "NaN", "Infinity", ""])("an unreadable or non-positive quantity %j is refused PLAN_INPUT_INVALID", (requested) => {
    expect(codes(quantizeOrderQuantity({ requested, unit: "SHARES", tickSize: "0.01" }))).toEqual(["PLAN_INPUT_INVALID"]);
  });

  it("refuses a value that is not a string, and an unknown unit, without throwing", () => {
    expect(codes(quantizeOrderQuantity({ requested: 5 as unknown as string, unit: "SHARES", tickSize: "0.01" }))).toEqual(["PLAN_INPUT_INVALID"]);
    expect(codes(quantizeOrderQuantity({ requested: "5", unit: "PUSD" as unknown as "SHARES", tickSize: "0.01" }))).toEqual(["PLAN_INPUT_INVALID"]);
  });

  it("isOnSizeGrid is a check, never a rounding", () => {
    expect(isOnSizeGrid("5", "0.01")).toBe(true);
    expect(isOnSizeGrid("5.01", "0.001")).toBe(true);
    expect(isOnSizeGrid("5.001", "0.01")).toBe(false);
    expect(isOnSizeGrid("5.001", "0.001")).toBe(false);
    expect(isOnSizeGrid("-5", "0.01")).toBe(false);
    expect(isOnSizeGrid("5", "0.02")).toBe(false);
  });
});

describe("D2.3/D2.4: the collateral input (unit-tested; nothing produces one until ADR-034 R3)", () => {
  it("the signed share side is ceil at the tick's Amount decimals of target ÷ limit (A F-101), exactly", () => {
    for (const [collateralTarget, limitPrice, tickSize, shares] of [
      // ADR-034 D2.3's example: 1.73 at 0.347, tick 0.001 (Amount decimals 5): 4.985590… → 4.98560.
      ["1.73", "0.347", "0.001", "4.9856"],
      // A F-105's worked example: 10 USD at 0.52, tick 0.01 (Amount decimals 4): 19.2308 shares (takerAmount 19230800).
      ["10", "0.52", "0.01", "19.2308"],
      // An exact division needs no rounding: 17.00 ÷ 0.34 = 50.
      ["17", "0.34", "0.01", "50"],
      // Tick 0.1 (Amount decimals 3): 1 ÷ 0.3 = 3.333… → 3.334.
      ["1", "0.3", "0.1", "3.334"],
      // Tick 0.0025 (Amount decimals 6): 1 ÷ 0.3025 = 3.305785… → 3.305786.
      ["1", "0.3025", "0.0025", "3.305786"],
    ] as const) {
      expect(collateralBuySignedShares({ collateralTarget, limitPrice, tickSize }), `${collateralTarget} ÷ ${limitPrice}`).toEqual({ ok: true, value: shares });
    }
  });

  it("refuses an off-grid target, a price outside (0, 1), and an unknown tick: it never quantizes", () => {
    expect(codes(collateralBuySignedShares({ collateralTarget: "1.735", limitPrice: "0.347", tickSize: "0.001" }))).toEqual(["PLAN_INPUT_INVALID"]);
    expect(codes(collateralBuySignedShares({ collateralTarget: "1.73", limitPrice: "1", tickSize: "0.001" }))).toEqual(["PLAN_INPUT_INVALID"]);
    expect(codes(collateralBuySignedShares({ collateralTarget: "1.73", limitPrice: "0", tickSize: "0.001" }))).toEqual(["PLAN_INPUT_INVALID"]);
    expect(codes(collateralBuySignedShares({ collateralTarget: "1.73", limitPrice: "0.347", tickSize: "0.02" }))).toEqual(["PLAN_TICK_SIZE_UNSUPPORTED"]);
  });

  it("the minimum is judged on the SHARE reading (C-7): D2.3's example, 4.98560 < 5, is refused; the target 1.73 itself is never compared", () => {
    const refused = checkMinimumOrderSize({ kind: "COLLATERAL_BUY", collateralTarget: "1.73", limitPrice: "0.347" }, "5", "0.001");
    expect(codes(refused)).toEqual(["PLAN_BELOW_MINIMUM_ORDER_SIZE"]);
    expect(refused.ok ? null : refused.refusals[0]?.details).toMatchObject({ comparedShares: "4.9856", minimumOrderSize: "5" });
    expect(checkMinimumOrderSize({ kind: "COLLATERAL_BUY", collateralTarget: "1.74", limitPrice: "0.347" }, "5", "0.001")).toEqual({ ok: true, value: "5.01441" });
    expect(checkMinimumOrderSize({ kind: "COLLATERAL_BUY", collateralTarget: "10", limitPrice: "0.52" }, "5", "0.01")).toEqual({ ok: true, value: "19.2308" });
  });

  it("a limit order (and a FAK/FOK SELL) is judged on its executable shares", () => {
    expect(checkMinimumOrderSize({ kind: "SHARES", executableShares: "5" }, "5", "0.01")).toEqual({ ok: true, value: "5" });
    expect(codes(checkMinimumOrderSize({ kind: "SHARES", executableShares: "4.99" }, "5", "0.01"))).toEqual(["PLAN_BELOW_MINIMUM_ORDER_SIZE"]);
  });
});

describe("D2.2: slicing is on the grid", () => {
  it("slices an on-grid total into on-grid slices that sum to it exactly", () => {
    for (const [total, maxSlice, minimum, sizes] of [
      ["100", "60", "5", ["60", "40"]],
      ["103.5", "50", "5", ["50", "53.5"]],
      ["120.01", "60", "5", ["60", "60.01"]],
      ["0.07", "0.03", "0.01", ["0.03", "0.03", "0.01"]],
      ["12.34", "100", "5", ["12.34"]],
    ] as const) {
      const sliced = sliceShares(total, maxSlice, minimum, "0.01");
      expect(sliced, `${total} / ${maxSlice}`).toEqual({ ok: true, sizes: [...sizes] });
      if (sliced.ok) for (const size of sliced.sizes) expect(isOnSizeGrid(size, "0.01"), size).toBe(true);
    }
  });

  it.each(["60.005", "0.001", "59.999"])("refuses an off-grid maxSliceShares %s as PLAN_SLICING_INCOHERENT", (maxSlice) => {
    const sliced = sliceShares("100", maxSlice, "5", "0.01");
    expect(sliced.ok ? null : sliced.refusal.code).toBe("PLAN_SLICING_INCOHERENT");
  });

  it("refuses an off-grid total (only the quantizer's floored quantity is sliced), fail closed", () => {
    const sliced = sliceShares("100.001", "60", "5", "0.01");
    expect(sliced.ok ? null : sliced.refusal.code).toBe("PLAN_SLICING_INCOHERENT");
  });

  it("refuses an unknown tick size", () => {
    const sliced = sliceShares("100", "60", "5", "0.02");
    expect(sliced.ok ? null : sliced.refusal.code).toBe("PLAN_TICK_SIZE_UNSUPPORTED");
  });

  it("a plan whose policy's maxSliceShares is off the grid is refused, not rounded", () => {
    const inputs = planningInputs();
    inputs.policy = { ...inputs.policy, maxSliceShares: "60.005" };
    expect(codes(buildExecutionPlan(approvedPosition(), inputs))).toEqual(["PLAN_SLICING_INCOHERENT"]);
  });
});

describe("D2.3: the plan records the remainder, with both numbers, on the leg's last order", () => {
  it("a POSITION of 5.009 plans 5, with a SUB_GRID remainder of 0.009 (BUY)", () => {
    const p = plan(approvedPosition({ targetShares: "5.009" }));
    const [order] = ordersOf(p);
    expect(order).toMatchObject({ action: "BUY", shares: "5" });
    expect(order?.unexecutableRemainder).toEqual({ reason: "SUB_GRID", unit: "SHARES", quantity: "0.009", requested: "5.009", executable: "5" });
    expect(p.reservations.map((reservation) => reservation.shares)).toEqual(["5"]);
    expect(p.estimates.worstCaseCost).toBe("2.4");
  });

  it("an on-grid plan carries no remainder key at all (no PAPER change for on-grid sizes)", () => {
    const p = plan(approvedPosition());
    for (const order of ordersOf(p)) expect(Object.keys(order)).not.toContain("unexecutableRemainder");
    expect(ordersOf(p).map((order) => order.shares)).toEqual(["60", "40"]);
  });

  it("a sliced leg (100.009 under maxSliceShares 60) gives 60 and 40, the remainder on the last slice only", () => {
    const p = plan(approvedPosition({ targetShares: "100.009" }));
    const orders = ordersOf(p);
    expect(orders.map((order) => order.shares)).toEqual(["60", "40"]);
    expect(orders[0]?.unexecutableRemainder).toBeUndefined();
    expect(orders[1]?.unexecutableRemainder).toEqual({ reason: "SUB_GRID", unit: "SHARES", quantity: "0.009", requested: "100.009", executable: "100" });
  });

  it("every check sees the executable number: a ceiling of 48 admits 100.009 at 0.48 (48.00432 requested, 48 executable)", () => {
    const p = plan(approvedPosition({ targetShares: "100.009", maximumTotalCost: "48" }));
    expect(p.estimates.worstCaseCost).toBe("48");
  });

  it("a REDUCE_POSITION (SELL) of an off-grid holding sells the floor and records the rest", () => {
    const inputs = planningInputs({ markets: [marketInput({ inventory: { yes: { held: "100.257", reserved: "0" }, no: { held: "0", reserved: "0" } } })] });
    const p = plan(approvedReduction({ targetShares: "40" }), inputs);
    const orders = ordersOf(p);
    expect(orders.every((order) => order.action === "SELL")).toBe(true);
    expect(orders.map((order) => order.shares)).toEqual(["60.25"]);
    expect(orders.at(-1)?.unexecutableRemainder).toEqual({ reason: "SUB_GRID", unit: "SHARES", quantity: "0.007", requested: "60.257", executable: "60.25" });
  });

  it("a BASKET leg of 50.005 plans 50, with its remainder", () => {
    const p = plan(approvedBasket({ legs: [{ marketId: MARKET_A, direction: "YES", targetShares: "50.005", maximumBuyPrice: "0.5" }] }));
    const [order] = ordersOf(p);
    expect(order?.shares).toBe("50");
    expect(order?.unexecutableRemainder).toEqual({ reason: "SUB_GRID", unit: "SHARES", quantity: "0.005", requested: "50.005", executable: "50" });
  });

  it("a request that floors to zero is refused PLAN_BELOW_MINIMUM_ORDER_SIZE, and one below the minimum after flooring too", () => {
    // A holding of 40.009 reduced to 40: the excess, 0.009, floors to zero.
    const dust = planningInputs({
      markets: [marketInput({ minimumOrderSize: "0.01", inventory: { yes: { held: "40.009", reserved: "0" }, no: { held: "0", reserved: "0" } } })],
    });
    expect(codes(buildExecutionPlan(approvedReduction({ targetShares: "40" }), dust))).toEqual(["PLAN_BELOW_MINIMUM_ORDER_SIZE"]);
    expect(codes(buildExecutionPlan(approvedPosition({ targetShares: "5.009" }), planningInputs({ markets: [marketInput({ minimumOrderSize: "5.001" })] })))).toEqual([
      "PLAN_BELOW_MINIMUM_ORDER_SIZE",
    ]);
  });

  it("a market whose tick size the table does not know is refused PLAN_TICK_SIZE_UNSUPPORTED", () => {
    const inputs = planningInputs({
      markets: [marketInput({ tickSize: "0.02", book: { yesBestBid: "0.48", yesBestAsk: "0.5", noBestBid: "0.5", noBestAsk: "0.52" } })],
    });
    expect(codes(buildExecutionPlan(approvedPosition(), inputs))).toEqual(["PLAN_TICK_SIZE_UNSUPPORTED"]);
  });

  it("is deterministic: the same off-grid request plans byte-identical plans", () => {
    const a = JSON.stringify(plan(approvedPosition({ targetShares: "100.009" })));
    const b = JSON.stringify(plan(approvedPosition({ targetShares: "100.009" })));
    expect(a).toBe(b);
  });
});

describe("D2.5: the seal keeps a hand-built plan on the grid, and its remainder honest", () => {
  function draftOf(targetShares: string): PlacementPlan {
    return JSON.parse(JSON.stringify(plan(approvedPosition({ targetShares })))) as PlacementPlan;
  }

  function sealCodes(value: unknown): string[] {
    const result = sealExecutionPlan(value as ExecutionPlan);
    return result.ok ? [] : planCodesOf(result);
  }

  type Mutable = { groups: { tickSize: string; orders: Record<string, unknown>[] }[]; reservations: Record<string, unknown>[] };

  it("reseals the untouched off-grid-request plan", () => {
    expect(sealExecutionPlan(draftOf("100.009")).ok).toBe(true);
  });

  it("refuses an order whose shares are off the grid, even with a matching reservation", () => {
    const d = draftOf("5") as unknown as Mutable;
    const order = d.groups[0]?.orders[0] as Record<string, unknown>;
    order["shares"] = "5.009";
    (d.reservations[0] as Record<string, unknown>)["shares"] = "5.009";
    expect(sealCodes(d)).toEqual(["PLAN_SEAL_INVALID"]);
  });

  it("refuses a group whose tick size the table does not know", () => {
    const d = draftOf("5") as unknown as Mutable;
    (d.groups[0] as { tickSize: string }).tickSize = "0.02";
    const order = d.groups[0]?.orders[0] as Record<string, unknown>;
    order["limitPrice"] = "0.48";
    expect(sealCodes(d)).toEqual(["PLAN_SEAL_INVALID"]);
  });

  for (const [label, mutate] of [
    ["a remainder on a non-last order", (d: Mutable) => {
      const [first, last] = d.groups[0]?.orders ?? [];
      if (first !== undefined && last !== undefined) first["unexecutableRemainder"] = last["unexecutableRemainder"];
    }],
    ["a remainder whose reason is not SUB_GRID", (d: Mutable) => {
      const last = d.groups[0]?.orders.at(-1) as Record<string, Record<string, unknown>>;
      (last["unexecutableRemainder"] as Record<string, unknown>)["reason"] = "SUB_MINIMUM";
    }],
    ["a remainder whose unit is not SHARES", (d: Mutable) => {
      const last = d.groups[0]?.orders.at(-1) as Record<string, Record<string, unknown>>;
      (last["unexecutableRemainder"] as Record<string, unknown>)["unit"] = "COLLATERAL";
    }],
    ["a remainder of a whole grid unit or more", (d: Mutable) => {
      const last = d.groups[0]?.orders.at(-1) as Record<string, Record<string, unknown>>;
      Object.assign(last["unexecutableRemainder"] as Record<string, unknown>, { quantity: "0.01", requested: "100.01" });
    }],
    ["a remainder that is not requested − executable", (d: Mutable) => {
      const last = d.groups[0]?.orders.at(-1) as Record<string, Record<string, unknown>>;
      (last["unexecutableRemainder"] as Record<string, unknown>)["quantity"] = "0.008";
    }],
    ["a remainder whose executable is not the group's total", (d: Mutable) => {
      const last = d.groups[0]?.orders.at(-1) as Record<string, Record<string, unknown>>;
      Object.assign(last["unexecutableRemainder"] as Record<string, unknown>, { executable: "99.99", requested: "99.999" });
    }],
    ["a remainder with an unknown key", (d: Mutable) => {
      const last = d.groups[0]?.orders.at(-1) as Record<string, Record<string, unknown>>;
      (last["unexecutableRemainder"] as Record<string, unknown>)["note"] = "x";
    }],
  ] as const) {
    it(`refuses ${label}`, () => {
      const d = draftOf("100.009") as unknown as Mutable;
      mutate(d);
      expect(sealCodes(d)).toEqual(["PLAN_SEAL_INVALID"]);
    });
  }
});
