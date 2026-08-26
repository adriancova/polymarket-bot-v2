import { describe, expect, it } from "vitest";

import {
  DecimalStringSchema,
  MoneyStringSchema,
  NonNegativeDecimalStringSchema,
  NonNegativeMoneyStringSchema,
  NonNegativeSharesStringSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
  ProbabilityStringSchema,
  SharesStringSchema,
  decimalStringSchema,
} from "./decimals.js";

const economicSchemas = [
  ["DecimalStringSchema", DecimalStringSchema],
  ["PriceStringSchema", PriceStringSchema],
  ["ProbabilityStringSchema", ProbabilityStringSchema],
  ["SharesStringSchema", SharesStringSchema],
  ["MoneyStringSchema", MoneyStringSchema],
  ["NonNegativeDecimalStringSchema", NonNegativeDecimalStringSchema],
  ["NonNegativeSharesStringSchema", NonNegativeSharesStringSchema],
  ["NonNegativeMoneyStringSchema", NonNegativeMoneyStringSchema],
  ["PositiveDecimalStringSchema", PositiveDecimalStringSchema],
] as const;

describe("no economic schema accepts a JavaScript number (acceptance criterion 1)", () => {
  const numericInputs: ReadonlyArray<readonly [string, unknown]> = [
    ["the integer 1", 1],
    ["the fraction 0.5", 0.5],
    ["zero", 0],
    ["a negative number", -1.25],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 1n],
    ["a Number object", new Number(1)],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["an array", ["0.5"]],
    ["an object with toString", { toString: () => "0.5" }],
  ];

  for (const [schemaName, schema] of economicSchemas) {
    it.each(numericInputs)(`${schemaName} rejects %s`, (_description, value) => {
      expect(schema.safeParse(value).success).toBe(false);
    });
  }
});

describe("scientific notation is rejected (acceptance criterion 2)", () => {
  it.each(economicSchemas)("%s rejects exponent forms", (_name, schema) => {
    for (const value of ["1e5", "1E5", "1e-5", "1.5e3", "0.5E-2"]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});

describe("canonical form is required at the boundary", () => {
  it.each(economicSchemas)("%s rejects non-canonical spellings", (_name, schema) => {
    for (const value of ["1.50", "01.5", "+1", "-0", "1.", ".5", "", "NaN", "Infinity", " 1"]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("accepts canonical values", () => {
    expect(DecimalStringSchema.parse("0")).toBe("0");
    expect(DecimalStringSchema.parse("-1.25")).toBe("-1.25");
    expect(SharesStringSchema.parse("-100")).toBe("-100");
    expect(MoneyStringSchema.parse("-0.01")).toBe("-0.01");
    expect(PriceStringSchema.parse("0.5")).toBe("0.5");
  });

  it("surfaces the canonicalization reason in the issue message", () => {
    const result = DecimalStringSchema.safeParse("1.50");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("canonical");
    }
  });
});

describe("contextual ranges", () => {
  it("constrains prices and probabilities to [0, 1]", () => {
    for (const schema of [PriceStringSchema, ProbabilityStringSchema]) {
      expect(schema.safeParse("0").success).toBe(true);
      expect(schema.safeParse("1").success).toBe(true);
      expect(schema.safeParse("0.999999").success).toBe(true);
      expect(schema.safeParse("1.0000001").success).toBe(false);
      expect(schema.safeParse("2").success).toBe(false);
      expect(schema.safeParse("-0.5").success).toBe(false);
    }
  });

  it("leaves shares and money signed", () => {
    expect(SharesStringSchema.safeParse("-25").success).toBe(true);
    expect(MoneyStringSchema.safeParse("-25.5").success).toBe(true);
  });

  it("constrains non-negative variants", () => {
    expect(NonNegativeSharesStringSchema.safeParse("0").success).toBe(true);
    expect(NonNegativeSharesStringSchema.safeParse("-1").success).toBe(false);
    expect(NonNegativeMoneyStringSchema.safeParse("-0.01").success).toBe(false);
    expect(PositiveDecimalStringSchema.safeParse("0").success).toBe(false);
    expect(PositiveDecimalStringSchema.safeParse("0.0001").success).toBe(true);
  });

  it("exposes a builder for additional contextual constraints", () => {
    const feeSchema = decimalStringSchema({ range: "NON_NEGATIVE" });
    expect(feeSchema.safeParse("0.02").success).toBe(true);
    expect(feeSchema.safeParse("-0.02").success).toBe(false);
    expect(feeSchema.safeParse(0.02).success).toBe(false);
  });
});
