import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normalizeDecimalString, normalizeHashableDecimalString } from "./canonical.js";
import { DecimalRangeError, InvalidDecimalStringError } from "./errors.js";
import {
  CANONICAL_DECIMAL_HASH_DOMAIN,
  canonicalDecimalHash,
  canonicalDecimalPreimage,
} from "./hash.js";
import {
  canonicalDecimalArbitrary,
  equivalentSpellingArbitrary,
} from "./testing/arbitraries.js";

describe("canonical decimal hashing (handoff §7.3)", () => {
  it("is deterministic across calls", () => {
    const first = canonicalDecimalHash("1.5");
    const second = canonicalDecimalHash("1.5");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("hashes the documented domain-separated preimage", () => {
    expect(canonicalDecimalPreimage("01.50")).toBe(`${CANONICAL_DECIMAL_HASH_DOMAIN}:1.5`);
    const expected = createHash("sha256")
      .update(`${CANONICAL_DECIMAL_HASH_DOMAIN}:1.5`, "utf8")
      .digest("hex");
    expect(canonicalDecimalHash("1.5")).toBe(expected);
  });

  it("pins golden hashes so the preimage format cannot change silently", () => {
    // Reproduce with: printf 'polymarket-bot/decimal/v1:1.5' | sha256sum
    expect(canonicalDecimalHash("1.50")).toBe(
      "a935386d62699deeaa2abc350bda4a338c17fa24ebbf9dc04864b6470ececc15",
    );
    // Reproduce with: printf 'polymarket-bot/decimal/v1:0' | sha256sum
    expect(canonicalDecimalHash("-0.000")).toBe(
      "21ebd7f534e52136e9a93878389eaef49909a543d13d688001f5366e7b4e30bc",
    );
  });

  it("collapses every equivalent spelling to one hash", () => {
    // Only §7.3-permitted spellings: redundant leading/trailing zeros.
    const spellings = ["1.5", "1.50", "01.5", "0001.500000", "1.5000"];
    const hashes = new Set(spellings.map((value) => canonicalDecimalHash(value)));
    expect(hashes.size).toBe(1);
  });

  it("collapses every permitted spelling of zero to one hash", () => {
    const spellings = ["0", "-0", "0.0", "-0.000", "00", "00.00"];
    const hashes = new Set(spellings.map((value) => canonicalDecimalHash(value)));
    expect(hashes.size).toBe(1);
    expect(canonicalDecimalPreimage("-0.000")).toBe(`${CANONICAL_DECIMAL_HASH_DOMAIN}:0`);
  });

  it("distinguishes values that are merely similar", () => {
    const hashes = new Set(
      ["1.5", "1.05", "15", "0.15", "-1.5", "1.5000000000000001"].map((value) =>
        canonicalDecimalHash(value),
      ),
    );
    expect(hashes.size).toBe(6);
  });

  it("applies range constraints when supplied", () => {
    expect(() => canonicalDecimalHash("1.5", { range: "UNIT_INTERVAL" })).toThrow(
      DecimalRangeError,
    );
  });
});

describe("the hash-input grammar rejects every §7.3-forbidden form", () => {
  const forbidden: ReadonlyArray<readonly [string, string, string]> = [
    ["a leading +", "+1.5", "DECIMAL_LEADING_PLUS"],
    ["a leading + on zero", "+0", "DECIMAL_LEADING_PLUS"],
    ["a leading + with padding", "+00.00", "DECIMAL_LEADING_PLUS"],
    ["a leading + on an integer", "+1", "DECIMAL_LEADING_PLUS"],
    ["a trailing decimal point", "1.", "DECIMAL_TRAILING_POINT"],
    ["a trailing decimal point on zero", "0.", "DECIMAL_TRAILING_POINT"],
    ["a negative trailing decimal point", "-1.", "DECIMAL_TRAILING_POINT"],
    ["an omitted integer part", ".5", "DECIMAL_MISSING_INTEGER_PART"],
    ["a negative omitted integer part", "-.5", "DECIMAL_MISSING_INTEGER_PART"],
    ["scientific notation", "1e5", "DECIMAL_SCIENTIFIC_NOTATION"],
    ["upper-case scientific notation", "1E5", "DECIMAL_SCIENTIFIC_NOTATION"],
    ["negative-exponent scientific notation", "1.5e-3", "DECIMAL_SCIENTIFIC_NOTATION"],
    ["an empty string", "", "DECIMAL_EMPTY"],
    ["a bare decimal point", ".", "DECIMAL_TRAILING_POINT"],
    ["leading whitespace", " 1", "DECIMAL_MALFORMED"],
    ["trailing whitespace", "1 ", "DECIMAL_MALFORMED"],
    ["a thousands separator", "1,5", "DECIMAL_MALFORMED"],
    ["two decimal points", "1.2.3", "DECIMAL_MALFORMED"],
    ["a double sign", "--1", "DECIMAL_MALFORMED"],
    ["NaN", "NaN", "DECIMAL_MALFORMED"],
    ["Infinity", "Infinity", "DECIMAL_MALFORMED"],
    ["hexadecimal", "0x1f", "DECIMAL_MALFORMED"],
  ];

  it.each(forbidden)("rejects %s (%j) with code %s", (_description, input, code) => {
    expect(() => canonicalDecimalHash(input)).toThrow(InvalidDecimalStringError);
    expect(() => canonicalDecimalPreimage(input)).toThrow(InvalidDecimalStringError);
    expect(() => normalizeHashableDecimalString(input)).toThrow(InvalidDecimalStringError);
    try {
      canonicalDecimalHash(input);
      expect.unreachable("hashing a forbidden form must throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidDecimalStringError);
      expect((error as InvalidDecimalStringError).code).toBe(code);
    }
  });

  const nonStrings: ReadonlyArray<readonly [string, unknown]> = [
    ["the JavaScript number 1.5", 1.5],
    ["the JavaScript number 0", 0],
    ["NaN the number", Number.NaN],
    ["Infinity the number", Number.POSITIVE_INFINITY],
    ["a bigint", 15n],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["an array", []],
    ["an object with toString", { toString: () => "1.5" }],
  ];

  it.each(nonStrings)("refuses to hash %s", (_description, input) => {
    expect(() => canonicalDecimalHash(input)).toThrow(InvalidDecimalStringError);
  });

  it("keeps the forbidden forms reachable only through the venue-input normalizer", () => {
    // `normalizeDecimalString` remains available for adapters that must accept a
    // venue spelling. Hashing the *result* is fine; hashing the raw form is not.
    for (const [input, canonical] of [
      ["+1.5", "1.5"],
      ["1.", "1"],
      [".5", "0.5"],
      ["+0", "0"],
    ] as const) {
      expect(normalizeDecimalString(input)).toBe(canonical);
      expect(() => canonicalDecimalHash(input)).toThrow(InvalidDecimalStringError);
      expect(canonicalDecimalHash(normalizeDecimalString(input))).toBe(
        canonicalDecimalHash(canonical),
      );
    }
  });
});

describe("canonical decimal hashing properties", () => {
  it("hashes every permitted equivalent representation identically", () => {
    fc.assert(
      fc.property(
        canonicalDecimalArbitrary().chain((canonical) =>
          fc.tuple(
            fc.constant(canonical),
            equivalentSpellingArbitrary(canonical, { allowLeadingPlus: false }),
          ),
        ),
        ([canonical, spelling]) => {
          expect(normalizeHashableDecimalString(spelling)).toBe(canonical);
          expect(canonicalDecimalHash(spelling)).toBe(canonicalDecimalHash(canonical));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("rejects every leading-+ spelling that the venue normalizer would accept", () => {
    fc.assert(
      fc.property(
        canonicalDecimalArbitrary({ allowNegative: false }).chain((canonical) =>
          fc.tuple(fc.constant(canonical), equivalentSpellingArbitrary(canonical)),
        ),
        ([canonical, spelling]) => {
          fc.pre(spelling.startsWith("+"));
          expect(normalizeDecimalString(spelling)).toBe(canonical);
          expect(() => canonicalDecimalHash(spelling)).toThrow(InvalidDecimalStringError);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("shows no sampled collisions (SHA-256 is collision-resistant, not collision-free)", () => {
    // This is sampled evidence, not a proof: no finite test can establish that a
    // 256-bit digest never collides. It fails loudly if the preimage ever stops
    // distinguishing two distinct canonical values.
    fc.assert(
      fc.property(canonicalDecimalArbitrary(), canonicalDecimalArbitrary(), (a, b) => {
        if (a === b) {
          expect(canonicalDecimalHash(a)).toBe(canonicalDecimalHash(b));
          return;
        }
        expect(canonicalDecimalHash(a)).not.toBe(canonicalDecimalHash(b));
      }),
      { numRuns: 500 },
    );
  });

  it("is a pure function of the canonical form", () => {
    fc.assert(
      fc.property(canonicalDecimalArbitrary(), (value) => {
        const canonical = normalizeHashableDecimalString(value);
        expect(canonicalDecimalHash(value)).toBe(canonicalDecimalHash(canonical));
        expect(canonicalDecimalHash(value)).toBe(canonicalDecimalHash(value));
      }),
    );
  });
});
