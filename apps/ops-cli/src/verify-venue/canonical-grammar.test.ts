/**
 * Cross-grammar consistency: the fixture validator versus `@polymarket-bot/decimal`.
 *
 * The canonical-decimal grammar of handoff §7.3 is implemented TWICE in this
 * repository, deliberately and independently:
 *
 * - `apps/ops-cli/src/verify-venue/fixtures.ts` (`CANONICAL_DECIMAL_RE`,
 *   `isCanonicalDecimalString`, `isCanonicalPriceString`) — the WP-000 fixture
 *   catalog, which must not depend on the runtime contract packages;
 * - `packages/decimal/src/canonical.ts` (`CANONICAL_PATTERN`,
 *   `isCanonicalDecimalString`) — the frozen boundary implementation every
 *   domain schema is built on (ADR-001 §2).
 *
 * Wave 0 closeout finding M5: nothing linked the two, so they could drift apart
 * silently and each would still pass its own suite. This test is that link. It
 * does not merge the implementations — the duplication is recorded as an open
 * item in `docs/contracts/protected-contracts.md` §8 and is owned by the
 * work package that replaces the hand-transcribed stand-in schemas — it pins
 * their agreement over a broad accept/reject vector set so a divergence fails a
 * gate instead of being discovered by a wrong fixture verdict.
 *
 * ADR-001 §2 is the authority for the grammar; where this test pins an expected
 * verdict, that verdict is the ADR's grammar, not either implementation's
 * behavior.
 *
 * Runs entirely offline; imports no fixture data, no network, no credential.
 */
import {
  MAX_DECIMAL_STRING_LENGTH,
  isCanonicalDecimalString as decimalIsCanonical,
} from "@polymarket-bot/decimal";
import { describe, expect, it } from "vitest";

import {
  isCanonicalDecimalString as fixtureIsCanonical,
  isCanonicalPriceString as fixtureIsCanonicalPrice,
} from "./fixtures.js";

/** `packages/decimal` spells the price bound as a range constraint. */
function decimalIsCanonicalPrice(value: unknown): boolean {
  return decimalIsCanonical(value, { range: "UNIT_INTERVAL" });
}

/**
 * Vectors whose verdict is fixed by ADR-001 §2 (canonical form) and §2's
 * `[0, 1]` bound for prices. Both implementations must agree with the ADR AND
 * with each other, so a shared drift is caught as well as a divergence.
 */
const PINNED: readonly {
  readonly value: unknown;
  readonly canonical: boolean;
  readonly price: boolean;
  readonly why: string;
}[] = [
  // --- canonical accepts -------------------------------------------------
  { value: "0", canonical: true, price: true, why: "canonical zero" },
  { value: "1", canonical: true, price: true, why: "unit" },
  { value: "0.5", canonical: true, price: true, why: "probability" },
  { value: "0.01", canonical: true, price: true, why: "one tick" },
  { value: "0.0001", canonical: true, price: true, why: "finest documented tick" },
  { value: "0.9999", canonical: true, price: true, why: "top of the ladder" },
  { value: "0.123456", canonical: true, price: true, why: "six decimals" },
  { value: "12.3", canonical: true, price: false, why: "above the unit interval" },
  { value: "100", canonical: true, price: false, why: "integer above 1" },
  { value: "2", canonical: true, price: false, why: "integer above 1" },
  { value: "1.5", canonical: true, price: false, why: "above 1" },
  { value: "-1.5", canonical: true, price: false, why: "negative" },
  { value: "-0.07", canonical: true, price: false, why: "negative" },
  { value: "-1", canonical: true, price: false, why: "negative" },
  {
    value: "123456789012345.678901",
    canonical: true,
    price: false,
    why: "wide but plain",
  },
  {
    value: "0.000000000000000001",
    canonical: true,
    price: true,
    why: "tiny positive is still in [0, 1]",
  },
  // --- canonical rejects -------------------------------------------------
  { value: "-0", canonical: false, price: false, why: "canonical zero is \"0\"" },
  { value: "-0.0", canonical: false, price: false, why: "signed zero spelling" },
  { value: "0.0", canonical: false, price: false, why: "trailing fractional zero" },
  { value: "1.50", canonical: false, price: false, why: "trailing fractional zero" },
  { value: "1.000", canonical: false, price: false, why: "trailing fractional zeros" },
  { value: "01", canonical: false, price: false, why: "redundant leading zero" },
  { value: "01.5", canonical: false, price: false, why: "redundant leading zero" },
  { value: "00", canonical: false, price: false, why: "redundant leading zero" },
  { value: "-01", canonical: false, price: false, why: "redundant leading zero" },
  { value: "1.", canonical: false, price: false, why: "trailing decimal point" },
  { value: ".5", canonical: false, price: false, why: "omitted integer part" },
  { value: "+1.5", canonical: false, price: false, why: "leading plus" },
  { value: "+0", canonical: false, price: false, why: "leading plus" },
  { value: "1e5", canonical: false, price: false, why: "scientific notation" },
  { value: "1E5", canonical: false, price: false, why: "scientific notation" },
  { value: "1e-5", canonical: false, price: false, why: "scientific notation" },
  { value: "0.5e0", canonical: false, price: false, why: "scientific notation" },
  { value: "", canonical: false, price: false, why: "empty string" },
  { value: " 1", canonical: false, price: false, why: "leading whitespace" },
  { value: "1 ", canonical: false, price: false, why: "trailing whitespace" },
  { value: "1 000", canonical: false, price: false, why: "embedded space" },
  { value: "1,000", canonical: false, price: false, why: "thousands separator" },
  { value: "NaN", canonical: false, price: false, why: "not a numeral" },
  { value: "Infinity", canonical: false, price: false, why: "not a numeral" },
  { value: "-Infinity", canonical: false, price: false, why: "not a numeral" },
  { value: "0x1", canonical: false, price: false, why: "hex" },
  { value: "1.2.3", canonical: false, price: false, why: "two decimal points" },
  { value: "--1", canonical: false, price: false, why: "double sign" },
  { value: "1-", canonical: false, price: false, why: "trailing sign" },
  { value: ".", canonical: false, price: false, why: "bare point" },
  { value: "-", canonical: false, price: false, why: "bare sign" },
  { value: "١٢٣", canonical: false, price: false, why: "non-ASCII digits" },
  { value: "1\n", canonical: false, price: false, why: "trailing newline" },
  { value: "\u00A01", canonical: false, price: false, why: "non-breaking space" },
  // Economic values are never JavaScript numbers (handoff §7.3, ADR-001 §7).
  { value: 1, canonical: false, price: false, why: "number, not string" },
  { value: 0.5, canonical: false, price: false, why: "number, not string" },
  { value: 0, canonical: false, price: false, why: "number, not string" },
  { value: null, canonical: false, price: false, why: "null" },
  { value: undefined, canonical: false, price: false, why: "undefined" },
  { value: true, canonical: false, price: false, why: "boolean" },
  { value: {}, canonical: false, price: false, why: "object" },
  { value: [], canonical: false, price: false, why: "array" },
  { value: ["1"], canonical: false, price: false, why: "array of string" },
  { value: 10n, canonical: false, price: false, why: "bigint" },
  // --- price bound, canonical spelling ------------------------------------
  { value: "1.0000001", canonical: true, price: false, why: "just above 1" },
  { value: "1.000001", canonical: true, price: false, why: "above 1" },
  { value: "-0.000001", canonical: true, price: false, why: "just below 0" },
  { value: "10", canonical: true, price: false, why: "above 1" },
  { value: "0.999999999999999999", canonical: true, price: true, why: "just below 1" },
];

/**
 * A systematic sweep: every combination of sign, integer part, fraction, and
 * suffix. Most combinations are non-canonical; the point is that BOTH
 * implementations must reach the same verdict on each one.
 */
function sweepVectors(): readonly string[] {
  const signs = ["", "-", "+"] as const;
  const integers = ["0", "00", "1", "01", "10", "9", "123", ""] as const;
  const fractions = [
    "",
    ".",
    ".0",
    ".5",
    ".00",
    ".50",
    ".05",
    ".000001",
    ".0000010",
  ] as const;
  const suffixes = ["", "e5", "E-5", " ", "\t"] as const;
  const values: string[] = [];
  for (const sign of signs) {
    for (const integer of integers) {
      for (const fraction of fractions) {
        for (const suffix of suffixes) {
          values.push(`${sign}${integer}${fraction}${suffix}`);
        }
      }
    }
  }
  return values;
}

describe("canonical-decimal grammar: fixture validator vs @polymarket-bot/decimal", () => {
  it.each(PINNED)(
    "agrees on $value ($why)",
    ({ value, canonical, price }) => {
      expect(fixtureIsCanonical(value)).toBe(canonical);
      expect(decimalIsCanonical(value)).toBe(canonical);
      expect(fixtureIsCanonicalPrice(value)).toBe(price);
      expect(decimalIsCanonicalPrice(value)).toBe(price);
    },
  );

  it("pins a substantial vector set (regression guard on the table itself)", () => {
    expect(PINNED.length).toBeGreaterThanOrEqual(60);
    expect(PINNED.filter((entry) => entry.canonical).length).toBeGreaterThanOrEqual(15);
    expect(PINNED.filter((entry) => entry.price).length).toBeGreaterThanOrEqual(8);
  });

  it("agrees on every spelling in the systematic sweep", () => {
    const vectors = sweepVectors();
    expect(vectors.length).toBeGreaterThanOrEqual(500);
    const disagreements = vectors.filter(
      (value) => fixtureIsCanonical(value) !== decimalIsCanonical(value),
    );
    expect(disagreements).toStrictEqual([]);
  });

  it("agrees on the [0, 1] price bound across the systematic sweep", () => {
    const disagreements = sweepVectors().filter(
      (value) => fixtureIsCanonicalPrice(value) !== decimalIsCanonicalPrice(value),
    );
    expect(disagreements).toStrictEqual([]);
  });

  it("accepts the same canonical subset of the sweep", () => {
    const accepted = sweepVectors().filter((value) => fixtureIsCanonical(value));
    // "", "-", "+" × the canonical spellings that survive: sanity-check that
    // the sweep really exercises the accept path rather than rejecting
    // everything (which would make the agreement assertions vacuous).
    expect(accepted).toContain("0");
    expect(accepted).toContain("1");
    expect(accepted).toContain("-1");
    expect(accepted).toContain("0.5");
    expect(accepted).toContain("-123.000001");
    expect(accepted.length).toBeGreaterThanOrEqual(20);
    for (const value of accepted) {
      expect(decimalIsCanonical(value)).toBe(true);
    }
  });

  /**
   * The ONE documented divergence, pinned so it cannot become a surprise.
   *
   * `packages/decimal` additionally bounds an accepted string at
   * `MAX_DECIMAL_STRING_LENGTH` characters (ADR-001 §5: "boundary hygiene for a
   * process that parses untrusted venue frames, not a venue fact"). The fixture
   * validator has no such bound because it validates a frozen, in-repo,
   * hand-authored fixture tree rather than untrusted input. No fixture value is
   * anywhere near that length, so the two agree on every real vector; the
   * divergence is asserted here rather than left to be discovered.
   */
  it("diverges only on the untrusted-input length bound", () => {
    const overlong = `1.${"1".repeat(MAX_DECIMAL_STRING_LENGTH)}`;
    expect(overlong.length).toBeGreaterThan(MAX_DECIMAL_STRING_LENGTH);
    expect(fixtureIsCanonical(overlong)).toBe(true);
    expect(decimalIsCanonical(overlong)).toBe(false);

    const atBound = `1.${"1".repeat(MAX_DECIMAL_STRING_LENGTH - 2)}`;
    expect(atBound.length).toBe(MAX_DECIMAL_STRING_LENGTH);
    expect(fixtureIsCanonical(atBound)).toBe(true);
    expect(decimalIsCanonical(atBound)).toBe(true);
  });
});
