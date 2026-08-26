/**
 * fast-check arbitraries shared by this package's property tests.
 *
 * TEST-ONLY SUPPORT MODULE. It is deliberately not re-exported from
 * `src/index.ts`, so no production consumer can reach it and the `fast-check`
 * development dependency never becomes a runtime dependency.
 */

import fc from "fast-check";

import { normalizeDecimalString, type DecimalString } from "../canonical.js";

function digits(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength, maxLength })
    .map((values) => values.join(""));
}

export interface CanonicalDecimalArbitraryOptions {
  readonly maxIntegerDigits?: number;
  readonly maxFractionDigits?: number;
  readonly allowNegative?: boolean;
}

/** Arbitrary canonical decimal strings, including zero and negative values. */
export function canonicalDecimalArbitrary(
  options: CanonicalDecimalArbitraryOptions = {},
): fc.Arbitrary<DecimalString> {
  const maxIntegerDigits = options.maxIntegerDigits ?? 6;
  const maxFractionDigits = options.maxFractionDigits ?? 6;
  const allowNegative = options.allowNegative ?? true;
  return fc
    .tuple(
      allowNegative ? fc.boolean() : fc.constant(false),
      digits(1, maxIntegerDigits),
      digits(0, maxFractionDigits),
    )
    .map(([negative, integer, fraction]) =>
      normalizeDecimalString(`${negative ? "-" : ""}${integer}.${fraction}`),
    );
}

/** Arbitrary canonical decimal strings inside `[0, 1]` (price/probability context). */
export function unitIntervalDecimalArbitrary(
  maxFractionDigits = 6,
): fc.Arbitrary<DecimalString> {
  return fc.oneof(
    fc.constant("0"),
    fc.constant("1"),
    digits(1, maxFractionDigits).map((fraction) => normalizeDecimalString(`0.${fraction}`)),
  );
}

export interface EquivalentSpellingOptions {
  /**
   * Whether a leading `+` may be generated. Defaults to `true`.
   *
   * The hash-input grammar forbids a leading `+` (§7.3), so hashing property
   * tests pass `false` and cover `+` spellings with a dedicated rejection
   * property instead.
   */
  readonly allowLeadingPlus?: boolean;
}

/**
 * Given a canonical decimal string, generates other spellings of the *same*
 * number: extra leading zeros, extra trailing fractional zeros, an explicit
 * `+` (unless suppressed), and `-0` spellings of zero.
 *
 * Every generated spelling must normalize back to the input under
 * `normalizeDecimalString`. With `allowLeadingPlus: false`, every generated
 * spelling is additionally a legal hash input.
 */
export function equivalentSpellingArbitrary(
  canonical: DecimalString,
  options: EquivalentSpellingOptions = {},
): fc.Arbitrary<string> {
  const allowLeadingPlus = options.allowLeadingPlus ?? true;
  const negative = canonical.startsWith("-");
  const body = negative ? canonical.slice(1) : canonical;
  const pointIndex = body.indexOf(".");
  const integer = pointIndex < 0 ? body : body.slice(0, pointIndex);
  const fraction = pointIndex < 0 ? "" : body.slice(pointIndex + 1);
  const isZero = canonical === "0";

  return fc
    .tuple(fc.nat({ max: 3 }), fc.nat({ max: 3 }), fc.boolean(), fc.boolean())
    .map(([leadingZeros, trailingZeros, explicitPlus, signedZero]) => {
      const plus = allowLeadingPlus && explicitPlus;
      const sign = negative || (isZero && signedZero) ? "-" : plus ? "+" : "";
      const integerPart = "0".repeat(leadingZeros) + integer;
      const fractionPart = fraction + "0".repeat(trailingZeros);
      return fractionPart.length === 0
        ? `${sign}${integerPart}`
        : `${sign}${integerPart}.${fractionPart}`;
    });
}
