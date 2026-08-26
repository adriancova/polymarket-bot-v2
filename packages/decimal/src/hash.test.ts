import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normalizeDecimalString } from "./canonical.js";
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
    const spellings = ["1.5", "1.50", "01.5", "+1.5", "0001.500000", "1.5000"];
    const hashes = new Set(spellings.map((value) => canonicalDecimalHash(value)));
    expect(hashes.size).toBe(1);
  });

  it("collapses every spelling of zero to one hash", () => {
    const spellings = ["0", "-0", "+0", "0.0", "-0.000", "00", "+00.00"];
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

  it("rejects inputs that are not decimal numerals", () => {
    expect(() => canonicalDecimalHash("1e5")).toThrow(InvalidDecimalStringError);
    expect(() => canonicalDecimalHash(1.5)).toThrow(InvalidDecimalStringError);
    expect(() => canonicalDecimalHash("")).toThrow(InvalidDecimalStringError);
  });

  it("applies range constraints when supplied", () => {
    expect(() => canonicalDecimalHash("1.5", { range: "UNIT_INTERVAL" })).toThrow(
      DecimalRangeError,
    );
  });
});

describe("canonical decimal hashing properties", () => {
  it("hashes every equivalent representation identically", () => {
    fc.assert(
      fc.property(
        canonicalDecimalArbitrary().chain((canonical) =>
          fc.tuple(fc.constant(canonical), equivalentSpellingArbitrary(canonical)),
        ),
        ([canonical, spelling]) => {
          expect(normalizeDecimalString(spelling)).toBe(canonical);
          expect(canonicalDecimalHash(spelling)).toBe(canonicalDecimalHash(canonical));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never collides for different values", () => {
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
        const canonical = normalizeDecimalString(value);
        expect(canonicalDecimalHash(value)).toBe(canonicalDecimalHash(canonical));
        expect(canonicalDecimalHash(value)).toBe(canonicalDecimalHash(value));
      }),
    );
  });
});
