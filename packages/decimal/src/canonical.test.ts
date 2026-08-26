import { describe, expect, it } from "vitest";

import {
  MAX_DECIMAL_STRING_LENGTH,
  assertCanonicalDecimalString,
  decimalPlaces,
  explainCanonicalDecimalString,
  isCanonicalDecimalString,
  normalizeDecimalString,
  significantDigits,
  tryNormalizeDecimalString,
} from "./canonical.js";
import { DecimalRangeError, InvalidDecimalStringError } from "./errors.js";

describe("canonical decimal strings (handoff §7.3)", () => {
  const accepted = [
    "0",
    "1",
    "-1",
    "0.5",
    "-0.5",
    "1.5",
    "1.05",
    "123456789012345678901234567890",
    "0.000001",
    "-123.456",
  ];

  it.each(accepted)("accepts canonical form %j", (value) => {
    expect(isCanonicalDecimalString(value)).toBe(true);
    expect(explainCanonicalDecimalString(value)).toBeNull();
    expect(assertCanonicalDecimalString(value)).toBe(value);
  });

  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ['"-0" (canonical zero is unsigned)', "-0"],
    ['"01.23" (redundant leading zero)', "01.23"],
    ['"1.50" (trailing fractional zero)', "1.50"],
    ['"1." (trailing decimal point)', "1."],
    ['"+1" (leading plus)', "+1"],
    ['"1e5" (scientific notation)', "1e5"],
    ['"1E5" (uppercase scientific notation)', "1E5"],
    ['"1e-5" (negative exponent)', "1e-5"],
    ['".5" (missing integer part)', ".5"],
    ['"" (empty string)', ""],
    ['"NaN"', "NaN"],
    ['"Infinity"', "Infinity"],
    ['"-Infinity"', "-Infinity"],
    ['"0.0" (redundant fractional zero)', "0.0"],
    ['"00" (redundant leading zeros)', "00"],
    ['"-0.00" (signed zero)', "-0.00"],
    ['" 1" (leading whitespace)', " 1"],
    ['"1 " (trailing whitespace)', "1 "],
    ['"1,5" (thousands separator)', "1,5"],
    ['"--1" (double sign)', "--1"],
    ['"1.2.3" (two decimal points)', "1.2.3"],
    ['"0x1f" (hexadecimal)', "0x1f"],
    ["the JavaScript number 1", 1],
    ["the JavaScript number 0.5", 0.5],
    ["the JavaScript number 1e5", 1e5],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["an object", {}],
    ["an array", []],
    ["a bigint", 10n],
  ];

  it.each(rejected)("rejects %s", (_description, value) => {
    expect(isCanonicalDecimalString(value)).toBe(false);
    expect(explainCanonicalDecimalString(value)).toBeTypeOf("string");
    expect(() => assertCanonicalDecimalString(value)).toThrow(InvalidDecimalStringError);
  });

  it("reports a dedicated error code for scientific notation", () => {
    expect(() => assertCanonicalDecimalString("1e5")).toThrowError(
      expect.objectContaining({ code: "DECIMAL_SCIENTIFIC_NOTATION" }),
    );
  });

  it("reports a dedicated error code for a leading plus", () => {
    expect(() => assertCanonicalDecimalString("+1")).toThrowError(
      expect.objectContaining({ code: "DECIMAL_LEADING_PLUS" }),
    );
  });

  it("reports a dedicated error code for a non-string", () => {
    expect(() => assertCanonicalDecimalString(0.5)).toThrowError(
      expect.objectContaining({ code: "DECIMAL_NOT_A_STRING" }),
    );
  });

  it("rejects strings beyond the pathological-input bound", () => {
    const tooLong = `1.${"1".repeat(MAX_DECIMAL_STRING_LENGTH)}`;
    expect(tooLong.length).toBeGreaterThan(MAX_DECIMAL_STRING_LENGTH);
    expect(() => assertCanonicalDecimalString(tooLong)).toThrowError(
      expect.objectContaining({ code: "DECIMAL_TOO_LONG" }),
    );
  });

  it("includes the caller-supplied label in the error message", () => {
    expect(() => assertCanonicalDecimalString("1.50", undefined, "price")).toThrow(/^price: /u);
  });
});

describe("contextual range constraints (handoff §7.3 price in [0, 1])", () => {
  it.each(["0", "1", "0.5", "0.999999", "0.0000001"])(
    "accepts %j inside the unit interval",
    (value) => {
      expect(isCanonicalDecimalString(value, { range: "UNIT_INTERVAL" })).toBe(true);
    },
  );

  it.each(["1.0000001", "2", "-0.1", "10", "1.5"])(
    "rejects %j outside the unit interval",
    (value) => {
      expect(isCanonicalDecimalString(value, { range: "UNIT_INTERVAL" })).toBe(false);
      expect(() =>
        assertCanonicalDecimalString(value, { range: "UNIT_INTERVAL" }),
      ).toThrow(DecimalRangeError);
    },
  );

  it("enforces NON_NEGATIVE", () => {
    expect(isCanonicalDecimalString("0", { range: "NON_NEGATIVE" })).toBe(true);
    expect(isCanonicalDecimalString("0.1", { range: "NON_NEGATIVE" })).toBe(true);
    expect(isCanonicalDecimalString("-0.1", { range: "NON_NEGATIVE" })).toBe(false);
  });

  it("enforces POSITIVE", () => {
    expect(isCanonicalDecimalString("0.0001", { range: "POSITIVE" })).toBe(true);
    expect(isCanonicalDecimalString("0", { range: "POSITIVE" })).toBe(false);
    expect(isCanonicalDecimalString("-1", { range: "POSITIVE" })).toBe(false);
  });

  it("applies range checks after normalization too", () => {
    expect(normalizeDecimalString("1.000", { range: "UNIT_INTERVAL" })).toBe("1");
    expect(() => normalizeDecimalString("1.0001", { range: "UNIT_INTERVAL" })).toThrow(
      DecimalRangeError,
    );
  });
});

describe("normalizeDecimalString (venue input → canonical)", () => {
  const vectors: ReadonlyArray<readonly [string, string]> = [
    ["0", "0"],
    ["-0", "0"],
    ["+0", "0"],
    ["0.0", "0"],
    ["-0.000", "0"],
    ["00", "0"],
    ["1.50", "1.5"],
    ["01.5", "1.5"],
    ["+1.5", "1.5"],
    ["1.5", "1.5"],
    ["0001.5000", "1.5"],
    ["1.", "1"],
    [".5", "0.5"],
    ["-.5", "-0.5"],
    ["+.50", "0.5"],
    ["-01.230", "-1.23"],
    ["000123", "123"],
    ["1.000000000000000000001", "1.000000000000000000001"],
  ];

  it.each(vectors)("normalizes %j to %j", (input, expected) => {
    expect(normalizeDecimalString(input)).toBe(expected);
    expect(isCanonicalDecimalString(normalizeDecimalString(input))).toBe(true);
  });

  it.each(["1e5", "", "NaN", "Infinity", " 1", "1 ", "abc", "1,5", "--1", "1.2.3", "."])(
    "refuses to normalize %j",
    (input) => {
      expect(() => normalizeDecimalString(input)).toThrow(InvalidDecimalStringError);
      expect(tryNormalizeDecimalString(input).ok).toBe(false);
    },
  );

  const nonStrings: ReadonlyArray<readonly [string, unknown]> = [
    ["the JavaScript number 1", 1],
    ["the JavaScript number 0.5", 0.5],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["an object", {}],
    ["an array", []],
    ["a bigint", 10n],
  ];

  it.each(nonStrings)("refuses to normalize %s", (_description, input) => {
    expect(() => normalizeDecimalString(input)).toThrow(InvalidDecimalStringError);
  });

  it("is idempotent", () => {
    const once = normalizeDecimalString("0001.5000");
    expect(normalizeDecimalString(once)).toBe(once);
  });

  it("returns a structured result from the non-throwing variant", () => {
    expect(tryNormalizeDecimalString("+1.50")).toEqual({ ok: true, value: "1.5" });
    const failure = tryNormalizeDecimalString("1e5");
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.code).toBe("DECIMAL_SCIENTIFIC_NOTATION");
      expect(failure.message).toContain("scientific notation");
    }
  });
});

describe("digit accessors", () => {
  it.each([
    ["0", 0],
    ["1", 0],
    ["1.5", 1],
    ["-1.25", 2],
    ["0.000001", 6],
  ] as ReadonlyArray<readonly [string, number]>)("decimalPlaces(%j) === %i", (value, expected) => {
    expect(decimalPlaces(value)).toBe(expected);
  });

  it.each([
    ["0", 0],
    ["1", 1],
    ["100", 3],
    ["0.025", 2],
    ["-1.25", 3],
  ] as ReadonlyArray<readonly [string, number]>)(
    "significantDigits(%j) === %i",
    (value, expected) => {
      expect(significantDigits(value)).toBe(expected);
    },
  );

  it("requires canonical input", () => {
    expect(() => decimalPlaces("1.50")).toThrow(InvalidDecimalStringError);
  });
});
