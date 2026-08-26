/**
 * Typed-error taxonomy: class and `code` must agree (Wave 0 closeout L9).
 *
 * Handoff §21 requires typed, observable errors. A stable `code` is only worth
 * having if it agrees with the class: otherwise a caller branching on
 * `instanceof` and a metric labelling on `code` disagree about what happened.
 * Two defects were found at Wave 0 closeout and are pinned here:
 *
 * 1. `tick.ts` threw `InvalidTickSizeError` with `"DECIMAL_INEXACT"`.
 * 2. `divDecimal` reported an out-of-range `precision` ARGUMENT as
 *    `DecimalInexactError`, which is documented to mean a RESULT could not be
 *    represented exactly.
 *
 * No arithmetic result, canonical grammar, or hash digest is affected by either
 * fix; this file asserts the taxonomy only.
 */
import { describe, expect, it } from "vitest";

import { divDecimal, divDecimalExact, mulDecimal } from "./arithmetic.js";
import { assertCanonicalDecimalString } from "./canonical.js";
import {
  DecimalDivisionByZeroError,
  DecimalError,
  DecimalInexactError,
  DecimalRangeError,
  InvalidDecimalStringError,
  InvalidTickSizeError,
  type DecimalErrorCode,
} from "./errors.js";
import { assertTickConformant, isTickConformant } from "./tick.js";

/** The pairing declared in `errors.ts`. */
const PERMITTED_CODES: ReadonlyMap<string, readonly DecimalErrorCode[]> = new Map([
  [
    InvalidDecimalStringError.name,
    [
      "DECIMAL_NOT_A_STRING",
      "DECIMAL_EMPTY",
      "DECIMAL_TOO_LONG",
      "DECIMAL_SCIENTIFIC_NOTATION",
      "DECIMAL_LEADING_PLUS",
      "DECIMAL_TRAILING_POINT",
      "DECIMAL_MISSING_INTEGER_PART",
      "DECIMAL_MALFORMED",
      "DECIMAL_NOT_CANONICAL",
    ] satisfies DecimalErrorCode[],
  ],
  [
    DecimalRangeError.name,
    ["DECIMAL_OUT_OF_RANGE", "DECIMAL_INVALID_PRECISION"] satisfies DecimalErrorCode[],
  ],
  [DecimalDivisionByZeroError.name, ["DECIMAL_DIVISION_BY_ZERO"] satisfies DecimalErrorCode[]],
  [DecimalInexactError.name, ["DECIMAL_INEXACT"] satisfies DecimalErrorCode[]],
  [InvalidTickSizeError.name, ["DECIMAL_INVALID_TICK"] satisfies DecimalErrorCode[]],
]);

function captured(operation: () => unknown): DecimalError {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof DecimalError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the operation to throw a DecimalError");
}

/** Every reachable throw site in the package, one per row. */
const THROW_SITES: ReadonlyArray<readonly [string, () => unknown]> = [
  ["assertCanonicalDecimalString(number)", () => assertCanonicalDecimalString(1)],
  ["assertCanonicalDecimalString('')", () => assertCanonicalDecimalString("")],
  [
    "assertCanonicalDecimalString(too long)",
    () => assertCanonicalDecimalString(`1.${"1".repeat(2000)}`),
  ],
  ["assertCanonicalDecimalString('1e5')", () => assertCanonicalDecimalString("1e5")],
  ["assertCanonicalDecimalString('+1')", () => assertCanonicalDecimalString("+1")],
  ["assertCanonicalDecimalString('1.')", () => assertCanonicalDecimalString("1.")],
  ["assertCanonicalDecimalString('.5')", () => assertCanonicalDecimalString(".5")],
  ["assertCanonicalDecimalString('1.50')", () => assertCanonicalDecimalString("1.50")],
  [
    "assertCanonicalDecimalString out of range",
    () => assertCanonicalDecimalString("1.5", { range: "UNIT_INTERVAL" }),
  ],
  ["divDecimal by zero", () => divDecimal("1", "0")],
  ["divDecimalExact by zero", () => divDecimalExact("1", "0")],
  ["divDecimalExact non-terminating", () => divDecimalExact("1", "3")],
  ["divDecimal bad precision", () => divDecimal("1", "3", { precision: 0 })],
  ["mulDecimal overlong result", () => mulDecimal(`1${"0".repeat(600)}`, `1${"0".repeat(600)}`)],
  ["isTickConformant zero tick", () => isTickConformant("0.5", "0")],
  ["assertTickConformant off grid", () => assertTickConformant("0.075", "0.01")],
];

describe("typed-error taxonomy (handoff §21)", () => {
  it.each(THROW_SITES)("%s raises a class/code pair that agrees", (_name, operation) => {
    const error = captured(operation);
    const permitted = PERMITTED_CODES.get(error.constructor.name);
    expect(permitted, `unregistered error class ${error.constructor.name}`).toBeDefined();
    expect(permitted).toContain(error.code);
    // `name` is set from the concrete constructor, so metrics and logs agree.
    expect(error.name).toBe(error.constructor.name);
  });

  it("covers every declared class at least once", () => {
    const seen = new Set(
      THROW_SITES.map(([, operation]) => captured(operation).constructor.name),
    );
    for (const className of PERMITTED_CODES.keys()) {
      expect(seen).toContain(className);
    }
  });
});

describe("L9-1: InvalidTickSizeError always carries DECIMAL_INVALID_TICK", () => {
  const tickFailures: ReadonlyArray<readonly [string, () => unknown]> = [
    ["zero tick size", () => isTickConformant("0.5", "0")],
    ["negative tick size", () => isTickConformant("0.5", "-0.01")],
    ["value off the grid", () => assertTickConformant("0.075", "0.01", "price")],
    ["negative value off the grid", () => assertTickConformant("-0.075", "0.01")],
  ];

  it.each(tickFailures)("%s", (_name, operation) => {
    const error = captured(operation);
    expect(error).toBeInstanceOf(InvalidTickSizeError);
    expect(error.code).toBe("DECIMAL_INVALID_TICK");
  });

  /**
   * `scaleToInteger`'s non-integer guard is UNREACHABLE through the public API:
   * both operands are canonical, and scaling by `max(decimalPlaces(value),
   * decimalPlaces(tick))` cannot leave a fraction. It is kept as a hard
   * invariant against a future change, so it cannot be exercised directly —
   * this sweep instead pins the observable consequence: no tick-module failure
   * ever escapes carrying `DECIMAL_INEXACT` (the defect L9 found), and the
   * guard never fires for canonical input.
   */
  it("never leaks DECIMAL_INEXACT from the tick module", () => {
    const values = [
      "0",
      "1",
      "0.07",
      "0.075",
      "0.9999",
      "-0.07",
      "-12.345",
      "100",
      "101",
      "0.000001",
      "123456789.123456789",
    ];
    const ticks = ["0.0001", "0.001", "0.01", "0.1", "1", "5", "0.5", "0.02"];
    let evaluated = 0;
    for (const value of values) {
      for (const tick of ticks) {
        evaluated += 1;
        // Must return a boolean, never throw: the guard cannot fire here.
        expect(typeof isTickConformant(value, tick)).toBe("boolean");
        if (!isTickConformant(value, tick)) {
          const error = captured(() => assertTickConformant(value, tick));
          expect(error.code).not.toBe("DECIMAL_INEXACT");
          expect(error.code).toBe("DECIMAL_INVALID_TICK");
        }
      }
    }
    expect(evaluated).toBe(values.length * ticks.length);
  });
});

describe("L9-2: an out-of-range precision argument is not an inexactness", () => {
  const badPrecisions = [0, -1, 1.5, Number.NaN, 1e10, Number.POSITIVE_INFINITY];

  it.each(badPrecisions)("divDecimal rejects precision %p", (precision) => {
    const error = captured(() => divDecimal("1", "3", { precision }));
    expect(error).toBeInstanceOf(DecimalRangeError);
    expect(error.code).toBe("DECIMAL_INVALID_PRECISION");
    expect(error).not.toBeInstanceOf(DecimalInexactError);
    expect(error.message).toContain("precision must be an integer in [1, 1000000000]");
  });

  it("still accepts every in-range precision", () => {
    expect(divDecimal("2", "3", { precision: 1 })).toBe("0.7");
    expect(divDecimal("2", "3", { precision: 4 })).toBe("0.6667");
    expect(divDecimal("1", "4", { precision: 34 })).toBe("0.25");
    expect(divDecimal("1", "4")).toBe("0.25");
  });

  it("still reports a genuine inexactness as DecimalInexactError", () => {
    const error = captured(() => divDecimalExact("1", "3"));
    expect(error).toBeInstanceOf(DecimalInexactError);
    expect(error.code).toBe("DECIMAL_INEXACT");
  });
});
