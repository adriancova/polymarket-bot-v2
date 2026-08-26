import { compareDecimal, normalizeDecimalString } from "@polymarket-bot/decimal";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DecimalStringSchema,
  MoneyStringSchema,
  NonNegativeMoneyStringSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
  ProbabilityStringSchema,
  SharesStringSchema,
} from "./decimals.js";

const economicSchemas = [
  DecimalStringSchema,
  PriceStringSchema,
  ProbabilityStringSchema,
  SharesStringSchema,
  MoneyStringSchema,
  NonNegativeMoneyStringSchema,
  PositiveDecimalStringSchema,
];

function digits(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength, maxLength })
    .map((values) => values.join(""));
}

/** Arbitrary canonical decimal strings, built without ever touching a JavaScript number. */
const canonicalDecimal: fc.Arbitrary<string> = fc
  .tuple(fc.boolean(), digits(1, 8), digits(0, 8))
  .map(([negative, integer, fraction]) =>
    normalizeDecimalString(`${negative ? "-" : ""}${integer}.${fraction}`),
  );

/** Arbitrary non-canonical spellings of the same values. */
const nonCanonicalSpelling: fc.Arbitrary<string> = fc
  .tuple(canonicalDecimal, fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }))
  .map(([canonical, leadingZeros, trailingZeros]) => {
    const negative = canonical.startsWith("-");
    const body = negative ? canonical.slice(1) : canonical;
    const point = body.indexOf(".");
    const integer = point < 0 ? body : body.slice(0, point);
    const fraction = point < 0 ? "" : body.slice(point + 1);
    return `${negative ? "-" : ""}${"0".repeat(leadingZeros)}${integer}.${fraction}${"0".repeat(trailingZeros)}`;
  });

describe("economic schema properties", () => {
  it("rejects every JavaScript number", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.double(), fc.integer(), fc.float(), fc.bigInt().map(Number)),
        (value) => {
          for (const schema of economicSchemas) {
            expect(schema.safeParse(value).success).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("rejects every non-canonical spelling", () => {
    fc.assert(
      fc.property(nonCanonicalSpelling, (value) => {
        expect(DecimalStringSchema.safeParse(value).success).toBe(false);
        // The same value in canonical form is accepted, so the rejection is
        // about representation, not about the number itself.
        expect(DecimalStringSchema.safeParse(normalizeDecimalString(value)).success).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("accepts every canonical decimal and returns it unchanged", () => {
    fc.assert(
      fc.property(canonicalDecimal, (value) => {
        const parsed = DecimalStringSchema.safeParse(value);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data).toBe(value);
        }
      }),
    );
  });

  it("accepts a price exactly when it lies in [0, 1]", () => {
    fc.assert(
      fc.property(canonicalDecimal, (value) => {
        const inUnitInterval =
          compareDecimal(value, "0") >= 0 && compareDecimal(value, "1") <= 0;
        expect(PriceStringSchema.safeParse(value).success).toBe(inUnitInterval);
        expect(ProbabilityStringSchema.safeParse(value).success).toBe(inUnitInterval);
      }),
      { numRuns: 500 },
    );
  });

  it("accepts a non-negative money value exactly when it is not negative", () => {
    fc.assert(
      fc.property(canonicalDecimal, (value) => {
        const nonNegative = compareDecimal(value, "0") >= 0;
        expect(NonNegativeMoneyStringSchema.safeParse(value).success).toBe(nonNegative);
        expect(PositiveDecimalStringSchema.safeParse(value).success).toBe(
          compareDecimal(value, "0") > 0,
        );
        // Shares and money keep their sign.
        expect(SharesStringSchema.safeParse(value).success).toBe(true);
        expect(MoneyStringSchema.safeParse(value).success).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("rejects every exponent form of a canonical value", () => {
    fc.assert(
      fc.property(canonicalDecimal, fc.integer({ min: -9, max: 9 }), (value, exponent) => {
        expect(DecimalStringSchema.safeParse(`${value}e${String(exponent)}`).success).toBe(false);
        expect(DecimalStringSchema.safeParse(`${value}E${String(exponent)}`).success).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
