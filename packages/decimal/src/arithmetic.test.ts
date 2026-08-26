import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DIVISION_PRECISION,
  absDecimal,
  addDecimal,
  compareDecimal,
  divDecimal,
  divDecimalExact,
  equalsDecimal,
  isNegativeDecimal,
  isZeroDecimal,
  mulDecimal,
  negateDecimal,
  subDecimal,
} from "./arithmetic.js";
import { isCanonicalDecimalString } from "./canonical.js";
import {
  DecimalDivisionByZeroError,
  DecimalInexactError,
  InvalidDecimalStringError,
} from "./errors.js";
import { canonicalDecimalArbitrary } from "./testing/arbitraries.js";

describe("exact arithmetic (handoff §6 invariant 1)", () => {
  it("adds without binary floating-point error", () => {
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal("0.1", "0.7")).toBe("0.8");
    expect(addDecimal("2.675", "0")).toBe("2.675");
  });

  it("subtracts exactly", () => {
    expect(subDecimal("0.3", "0.1")).toBe("0.2");
    expect(subDecimal("1", "1")).toBe("0");
    expect(subDecimal("0", "1.5")).toBe("-1.5");
  });

  it("multiplies exactly", () => {
    expect(mulDecimal("0.1", "0.2")).toBe("0.02");
    expect(mulDecimal("1.1", "1.1")).toBe("1.21");
    expect(mulDecimal("3", "0.3333")).toBe("0.9999");
    expect(mulDecimal("-2.5", "4")).toBe("-10");
  });

  it("keeps money-scale sums exact where IEEE-754 doubles do not", () => {
    // 0.1 + 0.2 !== 0.3 and 1.005 * 100 !== 100.5 in binary floating point.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(mulDecimal("1.005", "100")).toBe("100.5");

    let total = "0";
    for (let index = 0; index < 10; index += 1) {
      total = addDecimal(total, "0.1");
    }
    expect(total).toBe("1");
  });

  it("returns canonical output for every operation", () => {
    for (const value of [
      addDecimal("1.25", "1.25"),
      subDecimal("1.5", "1.5"),
      mulDecimal("0", "5"),
      negateDecimal("0"),
      absDecimal("-2.5"),
      divDecimal("1", "4"),
    ]) {
      expect(isCanonicalDecimalString(value)).toBe(true);
    }
  });

  it("normalizes negative zero results to canonical zero", () => {
    expect(negateDecimal("0")).toBe("0");
    expect(mulDecimal("-1", "0")).toBe("0");
    expect(subDecimal("0", "0")).toBe("0");
  });

  it("compares exactly", () => {
    expect(compareDecimal("0.1", "0.2")).toBe(-1);
    expect(compareDecimal("0.2", "0.1")).toBe(1);
    expect(compareDecimal("1", "1")).toBe(0);
    expect(compareDecimal("-1", "1")).toBe(-1);
    expect(equalsDecimal("1", "1")).toBe(true);
    expect(equalsDecimal("1", "1.0000001")).toBe(false);
  });

  it("exposes sign predicates", () => {
    expect(isZeroDecimal("0")).toBe(true);
    expect(isZeroDecimal("0.0000001")).toBe(false);
    expect(isNegativeDecimal("-0.1")).toBe(true);
    expect(isNegativeDecimal("0")).toBe(false);
    expect(absDecimal("-3.5")).toBe("3.5");
  });
});

describe("arithmetic never accepts a JavaScript number", () => {
  const operations: ReadonlyArray<readonly [string, (value: unknown) => unknown]> = [
    ["addDecimal", (value) => addDecimal(value as string, "1")],
    ["addDecimal (right)", (value) => addDecimal("1", value as string)],
    ["subDecimal", (value) => subDecimal(value as string, "1")],
    ["mulDecimal", (value) => mulDecimal(value as string, "1")],
    ["divDecimal", (value) => divDecimal(value as string, "1")],
    ["divDecimalExact", (value) => divDecimalExact(value as string, "1")],
    ["compareDecimal", (value) => compareDecimal(value as string, "1")],
    ["negateDecimal", (value) => negateDecimal(value as string)],
    ["absDecimal", (value) => absDecimal(value as string)],
    ["isZeroDecimal", (value) => isZeroDecimal(value as string)],
  ];

  it.each(operations)("%s rejects a number argument", (_name, operation) => {
    expect(() => operation(0.5)).toThrow(InvalidDecimalStringError);
    expect(() => operation(1)).toThrow(InvalidDecimalStringError);
  });

  it.each(operations)("%s rejects non-canonical strings", (_name, operation) => {
    expect(() => operation("1.50")).toThrow(InvalidDecimalStringError);
    expect(() => operation("+1")).toThrow(InvalidDecimalStringError);
    expect(() => operation("1e5")).toThrow(InvalidDecimalStringError);
  });
});

describe("division has an explicit rounding contract", () => {
  it("divides exactly when the quotient terminates", () => {
    expect(divDecimal("1", "4")).toBe("0.25");
    expect(divDecimalExact("1", "4")).toBe("0.25");
    expect(divDecimalExact("10", "2")).toBe("5");
    expect(divDecimalExact("-1", "8")).toBe("-0.125");
  });

  it("rounds half-even to the documented default precision", () => {
    const third = divDecimal("1", "3");
    expect(third.replace("0.", "")).toHaveLength(DIVISION_PRECISION);
    expect(third.startsWith("0.3333333333")).toBe(true);
    expect(divDecimal("2", "3", { precision: 4 })).toBe("0.6667");
    expect(divDecimal("1", "3", { precision: 4 })).toBe("0.3333");
  });

  it("honours an explicitly requested rounding mode", () => {
    // 1 = ROUND_DOWN (truncate toward zero) in decimal.js.
    expect(divDecimal("2", "3", { precision: 4, rounding: 1 })).toBe("0.6666");
  });

  it("refuses to round when exactness is requested", () => {
    expect(() => divDecimalExact("1", "3")).toThrow(DecimalInexactError);
    expect(() => divDecimalExact("10", "7")).toThrow(DecimalInexactError);
  });

  it("rejects division by zero", () => {
    expect(() => divDecimal("1", "0")).toThrow(DecimalDivisionByZeroError);
    expect(() => divDecimalExact("1", "0")).toThrow(DecimalDivisionByZeroError);
  });

  it("rejects an unusable requested precision with a typed error", () => {
    for (const precision of [0, -1, 1.5, Number.NaN, 1e10]) {
      expect(() => divDecimal("1", "3", { precision })).toThrow(DecimalInexactError);
    }
  });
});

describe("arithmetic properties", () => {
  it("addition is commutative and produces canonical output", () => {
    fc.assert(
      fc.property(canonicalDecimalArbitrary(), canonicalDecimalArbitrary(), (a, b) => {
        const left = addDecimal(a, b);
        expect(left).toBe(addDecimal(b, a));
        expect(isCanonicalDecimalString(left)).toBe(true);
      }),
    );
  });

  it("subtraction inverts addition", () => {
    fc.assert(
      fc.property(canonicalDecimalArbitrary(), canonicalDecimalArbitrary(), (a, b) => {
        expect(subDecimal(addDecimal(a, b), b)).toBe(a);
      }),
    );
  });

  it("a value minus itself is canonical zero", () => {
    fc.assert(
      fc.property(canonicalDecimalArbitrary(), (a) => {
        expect(subDecimal(a, a)).toBe("0");
        expect(addDecimal(a, negateDecimal(a))).toBe("0");
      }),
    );
  });

  it("multiplication is commutative and exact", () => {
    fc.assert(
      fc.property(canonicalDecimalArbitrary(), canonicalDecimalArbitrary(), (a, b) => {
        expect(mulDecimal(a, b)).toBe(mulDecimal(b, a));
      }),
    );
  });

  it("comparison agrees with subtraction sign", () => {
    fc.assert(
      fc.property(canonicalDecimalArbitrary(), canonicalDecimalArbitrary(), (a, b) => {
        const difference = subDecimal(a, b);
        const expected = isZeroDecimal(difference) ? 0 : isNegativeDecimal(difference) ? -1 : 1;
        expect(compareDecimal(a, b)).toBe(expected);
      }),
    );
  });
});
