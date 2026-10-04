/**
 * `THROUGHPUT-1a` — `canonical-order.ts`'s three string answers ARE the
 * `compareDecimal` expressions they replace, on every input they are called
 * with (canonical, non-negative decimal strings): exhaustively over every
 * canonical spelling of up to five characters, and on a seeded sample of
 * longer ones, including values with many fractional digits and integer parts
 * of many digits.
 *
 * `FLAKES-1` (`FLAKE-CANONICAL-ORDER`): under host load this file timed out at
 * vitest's default 5,000 ms. Two changes, neither touching what is checked:
 *
 * - One `expect()` per value cost about 5.5 µs, against about 0.9 µs for the
 *   `compareDecimal` oracle itself: some 85% of the two single-value tests and
 *   of the 50,000 sampled pairs. Each loop now compares the same two answers
 *   with `toBe`'s own equality, `Object.is` ({@link sameAsToBe}), collects
 *   every disagreement, and asserts once that there is none. Every value and
 *   every pair is still checked against the oracle, as strictly as `toBe`
 *   checked it: `-0` is not `+0` (`FLAKES1-R1-01`).
 * - The exhaustive pair sweep is about 1,000,000 oracle calls. That cost IS the
 *   check, so it keeps every call and gets an explicit, measured budget
 *   instead ({@link EXHAUSTIVE_PAIR_BUDGET_MS}).
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

/**
 * The exhaustive pair sweep's explicit timeout (`FLAKES-1`).
 *
 * The work is deterministic and bounded: about 1,000,000 `compareDecimal`
 * calls over a fixed input set, plus 50,000 seeded pairs. Measured cost of
 * that test: about 1.2 s alone on an idle host. Before this change it took
 * about 3 s inside the full `pnpm test` (`GOV-NOTES-1`'s gate logs), and at
 * host load 11-30 it ran 5.2-9.6 s and timed out at vitest's default
 * 5,000 ms. 60 s tolerates about a 50-fold slowdown of the idle cost; the
 * round's handoff records the load it was measured under.
 */
const EXHAUSTIVE_PAIR_BUDGET_MS = 60_000;

/** At most the first 20 disagreements, spelled out, and how many there were in all. */
interface Disagreements {
  count: number;
  readonly first: string[];
}

function noDisagreements(): Disagreements {
  return { count: 0, first: [] };
}

function disagree(found: Disagreements, detail: string): void {
  found.count += 1;
  if (found.first.length < 20) found.first.push(detail);
}

/**
 * `toBe`'s own equality, `Object.is` (`FLAKES1-R1-01`). Unlike `!==`, it tells
 * `-0` from `+0`: a comparator answering `-0` where `compareDecimal` answers
 * `0` is a disagreement here, as it was under `toBe`.
 */
function sameAsToBe(answer: unknown, oracle: unknown): boolean {
  return Object.is(answer, oracle);
}

/** `String(value)`, except that `-0` is spelled `-0` (`String(-0)` is `"0"`). */
function spell(value: unknown): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/**
 * The 50,000 seeded pairs over `unit`, each answer checked against
 * `compareDecimal` with `toBe`'s equality. `compare` is a parameter only so
 * that the `FLAKES1-R1-01` pin can run this very loop against a comparator
 * that answers `-0`.
 */
function sampledPairDisagreements(
  compare: (left: string, right: string) => number,
  unit: readonly string[],
): Disagreements {
  const random = prng(7);
  const found = noDisagreements();
  for (let index = 0; index < 50_000; index += 1) {
    const left = unit[Math.floor(random() * unit.length)] ?? "0";
    const right = unit[Math.floor(random() * unit.length)] ?? "0";
    const answer = compare(left, right);
    const oracle = compareDecimal(left, right);
    if (!sameAsToBe(answer, oracle)) disagree(found, `${left} vs ${right}: ${spell(answer)}, oracle ${spell(oracle)}`);
  }
  return found;
}

describe("canonical-order: exact string answers to compareDecimal", () => {
  it("covers a non-trivial exhaustive space", () => {
    expect(SHORT.length).toBeGreaterThan(10_000);
    expect(SHORT).toContain("0");
    expect(SHORT).toContain("1");
    expect(SHORT).toContain("0.001");
  });

  it("isPositiveCanonical(v) === (compareDecimal(v, '0') > 0)", () => {
    const found = noDisagreements();
    for (const value of ALL) {
      const oracle = compareDecimal(value, "0") > 0;
      const answer = isPositiveCanonical(value);
      if (!sameAsToBe(answer, oracle)) disagree(found, `${value}: ${spell(answer)}, oracle ${spell(oracle)}`);
    }
    expect(found).toStrictEqual(noDisagreements());
  });

  it("isAtMostOneCanonical(v) === (compareDecimal(v, '1') <= 0)", () => {
    const found = noDisagreements();
    for (const value of ALL) {
      const oracle = compareDecimal(value, "1") <= 0;
      const answer = isAtMostOneCanonical(value);
      if (!sameAsToBe(answer, oracle)) disagree(found, `${value}: ${spell(answer)}, oracle ${spell(oracle)}`);
    }
    expect(found).toStrictEqual(noDisagreements());
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
    expect(sampledPairDisagreements(compareCanonicalUnitInterval, unit)).toStrictEqual(noDisagreements());
  }, EXHAUSTIVE_PAIR_BUDGET_MS);

  it("FLAKES1-R1-01 pin: the collected checks tell -0 from +0, as toBe does", () => {
    expect(sameAsToBe(-0, 0)).toBe(false);
    expect(sameAsToBe(0, -0)).toBe(false);
    expect(sameAsToBe(0, 0)).toBe(true);
    expect(sameAsToBe(-1, -1)).toBe(true);
    expect(sameAsToBe(1, true)).toBe(false);
    expect(spell(-0)).toBe("-0");
    expect(spell(0)).toBe("0");
    // The very loop the pair test runs, against the real comparator with its
    // equal answer turned into -0: it reports disagreements, and each one it
    // spells out is an answer of -0 against the oracle's 0.
    const unit = ALL.filter((value) => compareDecimal(value, "1") <= 0);
    const negativeZero = (left: string, right: string): number => {
      const answer = compareCanonicalUnitInterval(left, right);
      return answer === 0 ? -0 : answer;
    };
    const found = sampledPairDisagreements(negativeZero, unit);
    expect(found.count).toBeGreaterThan(0);
    for (const detail of found.first) expect(detail).toMatch(/: -0, oracle 0$/);
  });
});
