/**
 * `THROUGHPUT-1a` — `canonical-order.ts`'s three string answers ARE the
 * `compareDecimal` expressions they replace, on every input they are called
 * with (canonical, non-negative decimal strings): exhaustively over every
 * canonical spelling of up to five characters, and on a seeded sample of
 * longer ones, including values with many fractional digits and integer parts
 * of many digits.
 */

import { compareDecimal, isCanonicalDecimalString } from "@polymarket-bot/decimal";
import { describe, expect, it } from "vitest";

import {
  compareCanonicalUnitInterval,
  isAtMostOneCanonical,
  isPositiveCanonical,
} from "./canonical-order.js";

/** Every string over [0-9.] up to `maxLength` that is canonical and non-negative. */
function exhaustiveCanonical(maxLength: number): string[] {
  const alphabet = "0123456789.";
  const out: string[] = [];
  let frontier = [""];
  for (let length = 1; length <= maxLength; length += 1) {
    const next: string[] = [];
    for (const prefix of frontier) {
      for (const character of alphabet) {
        const candidate = prefix + character;
        next.push(candidate);
        if (isCanonicalDecimalString(candidate) && !candidate.startsWith("-")) out.push(candidate);
      }
    }
    frontier = next;
  }
  return out;
}

/** A deterministic PRNG (mulberry32), so the sample is the same on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampledCanonical(count: number, seed: number): string[] {
  const random = prng(seed);
  const digit = (from: number) => String(from + Math.floor(random() * (10 - from)));
  const out: string[] = [];
  while (out.length < count) {
    const integerDigits = random() < 0.6 ? 0 : 1 + Math.floor(random() * 25);
    let integer = integerDigits === 0 ? "0" : digit(1);
    for (let index = 1; index < integerDigits; index += 1) integer += digit(0);
    const fractionDigits = random() < 0.2 ? 0 : 1 + Math.floor(random() * 40);
    let fraction = "";
    for (let index = 0; index < fractionDigits - 1; index += 1) fraction += digit(0);
    if (fractionDigits > 0) fraction += digit(1);
    const value = fraction === "" ? integer : `${integer}.${fraction}`;
    if (isCanonicalDecimalString(value)) out.push(value);
  }
  return out;
}

const SHORT = exhaustiveCanonical(5);
const LONG = sampledCanonical(4_000, 20260929);
const ALL = [...SHORT, ...LONG, "1", "0", "0.5", "1.0000000000000000000000001", "0.99999999999999999999999"];

describe("canonical-order: exact string answers to compareDecimal", () => {
  it("covers a non-trivial exhaustive space", () => {
    expect(SHORT.length).toBeGreaterThan(10_000);
    expect(SHORT).toContain("0");
    expect(SHORT).toContain("1");
    expect(SHORT).toContain("0.001");
  });

  it("isPositiveCanonical(v) === (compareDecimal(v, '0') > 0)", () => {
    for (const value of ALL) {
      expect(isPositiveCanonical(value), value).toBe(compareDecimal(value, "0") > 0);
    }
  });

  it("isAtMostOneCanonical(v) === (compareDecimal(v, '1') <= 0)", () => {
    for (const value of ALL) {
      expect(isAtMostOneCanonical(value), value).toBe(compareDecimal(value, "1") <= 0);
    }
  });

  it("compareCanonicalUnitInterval(a, b) === compareDecimal(a, b) for every pair in [0, 1]", () => {
    const unit = ALL.filter((value) => compareDecimal(value, "1") <= 0);
    // Exhaustive over the short unit-interval values; sampled pairs over the rest.
    const shortUnit = SHORT.filter((value) => compareDecimal(value, "1") <= 0);
    expect(shortUnit.length).toBeGreaterThan(1_000);
    for (const left of shortUnit) {
      for (const right of shortUnit) {
        if (compareCanonicalUnitInterval(left, right) !== compareDecimal(left, right)) {
          expect.unreachable(`${left} vs ${right}`);
        }
      }
    }
    const random = prng(7);
    for (let index = 0; index < 50_000; index += 1) {
      const left = unit[Math.floor(random() * unit.length)] ?? "0";
      const right = unit[Math.floor(random() * unit.length)] ?? "0";
      expect(compareCanonicalUnitInterval(left, right), `${left} vs ${right}`).toBe(compareDecimal(left, right));
    }
  });
});
