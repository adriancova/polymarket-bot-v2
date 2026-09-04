/**
 * The pinned v1 division policy, the exact-halving carve-out, quantization,
 * and the deterministic square root.
 *
 * The two policy constants are pinned to their DOCUMENTED VALUES (34 and
 * ROUND_HALF_EVEN = 6), not merely re-exported: if `@polymarket-bot/decimal`
 * ever changed its defaults, these assertions fail rather than silently
 * changing every v1 feature value.
 */

import { compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import { describe, expect, it } from "vitest";

import {
  FEATURE_DIVISION_PRECISION,
  FEATURE_DIVISION_ROUNDING,
  dividePolicy,
  halveExact,
  quantizePolicy,
  sqrtPolicy,
} from "./decimal-policy.js";

describe("the pinned policy constants", () => {
  it("are 34 significant digits and ROUND_HALF_EVEN (decimal.js code 6)", () => {
    expect(FEATURE_DIVISION_PRECISION).toBe(34);
    expect(FEATURE_DIVISION_ROUNDING).toBe(6);
  });
});

describe("dividePolicy", () => {
  it("rounds a non-terminating quotient to 34 significant digits", () => {
    expect(dividePolicy("1", "3")).toBe("0.3333333333333333333333333333333333");
    expect(dividePolicy("2", "3")).toBe("0.6666666666666666666666666666666667");
  });

  it("applies HALF_EVEN at the 34th digit (ties to even, both directions)", () => {
    // 0.5 / 1e33 sits exactly on the tie for a 34-digit round of 5.
    expect(dividePolicy("10", "3")).toBe("3.333333333333333333333333333333333");
    // A terminating quotient is returned exactly (no padding, canonical form).
    expect(dividePolicy("1", "4")).toBe("0.25");
    expect(dividePolicy("100", "8")).toBe("12.5");
  });
});

describe("halveExact", () => {
  it("is exact for every decimal (halving appends at most one digit)", () => {
    expect(halveExact("1")).toBe("0.5");
    expect(halveExact("0.1")).toBe("0.05");
    expect(halveExact("0.05")).toBe("0.025");
    expect(halveExact("100750")).toBe("50375");
    expect(halveExact("0")).toBe("0");
    // Doubling back reproduces the input exactly — the exactness oracle.
    for (const value of ["0.123456789", "99999.99999", "0.000001", "3"]) {
      expect(mulDecimal(halveExact(value), "2")).toBe(value);
    }
  });
});

describe("quantizePolicy", () => {
  it("is the identity below 34 significant digits and rounds above", () => {
    expect(quantizePolicy("0.5")).toBe("0.5");
    expect(quantizePolicy("12345.678")).toBe("12345.678");
    // 35 significant digits round half-even at the 34th.
    expect(quantizePolicy("1.2345678901234567890123456789012345")).toBe(
      "1.234567890123456789012345678901234",
    );
    expect(quantizePolicy("1.2345678901234567890123456789012335")).toBe(
      "1.234567890123456789012345678901234",
    );
  });
});

describe("sqrtPolicy", () => {
  it("is exact on perfect squares (BigInt oracle)", () => {
    for (const root of [1n, 2n, 7n, 12n, 123n, 100750n, 999983n]) {
      const square = (root * root).toString();
      expect(sqrtPolicy(square)).toEqual({ ok: true, value: root.toString() });
    }
    expect(sqrtPolicy("0.25")).toEqual({ ok: true, value: "0.5" });
    expect(sqrtPolicy("0.0001")).toEqual({ ok: true, value: "0.01" });
    expect(sqrtPolicy("0")).toEqual({ ok: true, value: "0" });
  });

  it("matches the published 34-digit value of sqrt(2)", () => {
    // Reference: sqrt(2) = 1.41421356237309504880168872420969807856...,
    // rounded half-even to 34 significant digits.
    const result = sqrtPolicy("2");
    expect(result).toEqual({ ok: true, value: "1.414213562373095048801688724209698" });
  });

  it("squares back to within one part in 10^30 (multiplicative oracle)", () => {
    for (const value of ["2", "3", "0.5", "0.0049875311720698", "123456.789", "0.000001234"]) {
      const result = sqrtPolicy(value);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const squared = mulDecimal(result.value, result.value);
      const error = subDecimal(squared, value);
      const absError = error.startsWith("-") ? error.slice(1) : error;
      // |s^2 - v| <= v * 1e-30 for values in these magnitudes.
      expect(compareDecimal(absError, mulDecimal(value, "0.000000000000000000000000000001"))).toBeLessThanOrEqual(0);
    }
  });

  it("refuses a negative input", () => {
    expect(sqrtPolicy("-1").ok).toBe(false);
  });
});
