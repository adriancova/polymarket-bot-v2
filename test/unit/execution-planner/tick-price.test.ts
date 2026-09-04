/**
 * Exact tick arithmetic and the pricing rules — unit-level, with oracles on
 * a DIFFERENT primitive than the implementation.
 *
 * The implementation scales to `BigInt`; the oracles here are `decimal.js`
 * (`isTickConformant` from `@polymarket-bot/decimal`) and plain `Number`
 * arithmetic within an epsilon. A shared-arithmetic bug therefore cannot
 * certify itself.
 */

import { describe, expect, it } from "vitest";

import { isTickConformant } from "../../../packages/decimal/src/index.js";
import {
  buyLimitPrice,
  ceilToTick,
  floorToTick,
  isOnTick,
  positionPosture,
  reductionPosture,
  sellLimitPrice,
  sliceDivision,
  tickTimes,
} from "../../../packages/execution-planner/src/index.js";

const near = (decimal: string | undefined, expected: number): void => {
  expect(decimal).toBeDefined();
  expect(Math.abs(Number(decimal) - expected)).toBeLessThan(1e-9);
};

describe("tick arithmetic — exact, safe-direction, decimal.js-corroborated", () => {
  const cases: Array<{ value: string; tick: string; floor: string; ceil: string }> = [
    { value: "0.485", tick: "0.01", floor: "0.48", ceil: "0.49" },
    { value: "0.48", tick: "0.01", floor: "0.48", ceil: "0.48" },
    { value: "0.07", tick: "0.01", floor: "0.07", ceil: "0.07" }, // the float trap: 0.07 % 0.01
    { value: "0.999", tick: "0.005", floor: "0.995", ceil: "1" },
    { value: "0.0301", tick: "0.003", floor: "0.03", ceil: "0.033" },
    { value: "123.456", tick: "0.25", floor: "123.25", ceil: "123.5" },
  ];

  it("floors and ceilings byte-exactly, staying on the decimal.js-verified grid", () => {
    for (const { value, tick, floor, ceil } of cases) {
      expect(floorToTick(value, tick)).toBe(floor);
      expect(ceilToTick(value, tick)).toBe(ceil);
      expect(isTickConformant(floor, tick)).toBe(true);
      expect(isTickConformant(ceil, tick)).toBe(true);
      expect(isOnTick(floor, tick)).toBe(true);
      expect(isOnTick(ceil, tick)).toBe(true);
      // Number oracle: floor ≤ value ≤ ceil, and both within one tick.
      expect(Number(floor)).toBeLessThanOrEqual(Number(value) + 1e-12);
      expect(Number(ceil)).toBeGreaterThanOrEqual(Number(value) - 1e-12);
      expect(Number(value) - Number(floor)).toBeLessThan(Number(tick) + 1e-12);
      expect(Number(ceil) - Number(value)).toBeLessThan(Number(tick) + 1e-12);
    }
  });

  it("agrees with decimal.js across a generated sweep", () => {
    for (let index = 1; index < 200; index += 7) {
      // Shortest-round-trip string form: canonical (no trailing zeros).
      const value = String(index / 200);
      for (const tick of ["0.01", "0.005", "0.002"]) {
        const floor = floorToTick(value, tick);
        expect(floor).toBeDefined();
        expect(isTickConformant(floor ?? "0", tick)).toBe(true);
        if (isTickConformant(value, tick)) {
          expect(floor).toBe(value); // conformant values pass through byte-identically
        }
      }
    }
  });

  it("computes tick offsets exactly", () => {
    expect(tickTimes("0.01", 2)).toBe("0.02");
    expect(tickTimes("0.005", 3)).toBe("0.015");
    expect(tickTimes("0.01", 0)).toBe("0");
    expect(tickTimes("0.01", -1)).toBeUndefined();
    expect(tickTimes("0.01", 2.5)).toBeUndefined();
  });

  it("is total: malformed values answer undefined, never a throw", () => {
    expect(floorToTick("1e5", "0.01")).toBeUndefined();
    expect(floorToTick("0.48", "0")).toBeUndefined();
    expect(floorToTick("-0.5", "0.01")).toBeUndefined();
    expect(ceilToTick("+1", "0.01")).toBeUndefined();
  });

  it("divides slices exactly, remainder cross-checked by Number arithmetic", () => {
    const division = sliceDivision("100", "7");
    expect(division).toEqual({ fullSlices: 14n, remainder: "2" });
    near(division?.remainder, 100 - 14 * 7);
    expect(sliceDivision("0.9", "0.4")).toEqual({ fullSlices: 2n, remainder: "0.1" });
    expect(sliceDivision("60", "60")).toEqual({ fullSlices: 1n, remainder: "0" });
  });
});

describe("the posture table", () => {
  it("maps every liquidity-preference × urgency cell deterministically", () => {
    expect(positionPosture("MAKER_ONLY", "IMMEDIATE")).toBe("REST");
    expect(positionPosture("MAKER_ONLY", "PASSIVE")).toBe("REST");
    expect(positionPosture("TAKER_ONLY", "PASSIVE")).toBe("MARKETABLE_LIMIT");
    expect(positionPosture("MAKER_PREFERRED", "NORMAL")).toBe("REST");
    expect(positionPosture("MAKER_PREFERRED", "AGGRESSIVE")).toBe("MARKETABLE_LIMIT");
    expect(positionPosture("TAKER_OK", "NORMAL")).toBe("REST");
    expect(positionPosture("TAKER_OK", "IMMEDIATE")).toBe("MARKETABLE_LIMIT");
    expect(reductionPosture("NORMAL")).toBe("REST");
    expect(reductionPosture("AGGRESSIVE")).toBe("MARKETABLE_LIMIT");
    expect(reductionPosture("IMMEDIATE")).toBe("MARKETABLE_LIMIT");
  });
});

describe("limit-price computation — capped, floored, safe-rounded", () => {
  it("caps a marketable buy at the floored intent ceiling", () => {
    const outcome = buyLimitPrice({
      posture: "MARKETABLE_LIMIT",
      tickSize: "0.01",
      slippageTicks: 2,
      bestAsk: "0.5",
      maximumBuyPrice: "0.515", // floors to 0.51 < 0.52 crossing
    });
    expect(outcome).toEqual({ ok: true, price: "0.51" });
  });

  it("uses the floored cap as the marketable limit when the book is silent", () => {
    const outcome = buyLimitPrice({
      posture: "MARKETABLE_LIMIT",
      tickSize: "0.01",
      slippageTicks: 2,
      maximumBuyPrice: "0.515",
    });
    expect(outcome).toEqual({ ok: true, price: "0.51" });
  });

  it("REFUSES a buy with neither book nor cap — price protection is not optional", () => {
    const outcome = buyLimitPrice({ posture: "MARKETABLE_LIMIT", tickSize: "0.01", slippageTicks: 2 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.code).toBe("PLAN_PRICE_PROTECTION_UNAVAILABLE");
  });

  it("refuses a cap that floors off the tradeable interval", () => {
    const outcome = buyLimitPrice({
      posture: "REST",
      tickSize: "0.01",
      slippageTicks: 0,
      maximumBuyPrice: "0.004", // floors to 0
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.code).toBe("PLAN_PRICE_OUT_OF_RANGE");
  });

  it("ceilings a sell floor upward — the safe direction for the seller", () => {
    const outcome = sellLimitPrice({
      posture: "MARKETABLE_LIMIT",
      tickSize: "0.01",
      slippageTicks: 2,
      bestBid: "0.48",
      minimumSellPrice: "0.465", // ceilings to 0.47 > 0.46 crossing
    });
    expect(outcome).toEqual({ ok: true, price: "0.47" });
  });

  it("never sells below one tick, even with a deep marketable crossing", () => {
    const outcome = sellLimitPrice({
      posture: "MARKETABLE_LIMIT",
      tickSize: "0.01",
      slippageTicks: 5,
      bestBid: "0.03",
    });
    expect(outcome).toEqual({ ok: true, price: "0.01" });
  });

  it("refuses a sell floor that ceilings to 1 or beyond", () => {
    const outcome = sellLimitPrice({
      posture: "REST",
      tickSize: "0.01",
      slippageTicks: 0,
      minimumSellPrice: "0.995",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.code).toBe("PLAN_PRICE_OUT_OF_RANGE");
  });
});
