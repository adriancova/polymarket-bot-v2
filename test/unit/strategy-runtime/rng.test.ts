/**
 * DeterministicRng (sfc32 + cyrb128 seed fold): determinism, serialization,
 * distribution bounds, and typed rejection of invalid draws.
 *
 * The golden values were derived from an INDEPENDENT mirror of the published
 * sfc32/cyrb128 algorithm (scratch script, not from this implementation's own
 * output at an earlier commit) and pin the sequence for seed "12345": a silent
 * algorithm change would break replay compatibility across versions (§12.4),
 * so it must break this file first.
 */

import { describe, expect, it } from "vitest";

import { DeterministicRng, isRngState } from "../../../packages/strategy-runtime/src/index.js";

const GOLDEN_12345 = [3778592554, 3118341740, 1678770010, 3405009475, 775900089];
const GOLDEN_STATE_AFTER = [4015854455, 3914647978, 2308897567, 1795820156];

describe("DeterministicRng", () => {
  it("pins the golden sequence for seed 12345", () => {
    const rng = DeterministicRng.fromSeed("12345");
    const draws = Array.from({ length: 5 }, () => rng.nextUint32());
    expect(draws).toEqual(GOLDEN_12345);
    expect(rng.snapshot()).toEqual(GOLDEN_STATE_AFTER);
  });

  it("pins the first draw for a different seed (54321) — the seed genuinely matters", () => {
    const rng = DeterministicRng.fromSeed("54321");
    expect(rng.nextUint32()).toBe(1670663950);
    expect(rng.nextUint32()).not.toBe(GOLDEN_12345[1]);
  });

  it("two generators from the same seed produce the same sequence", () => {
    const first = DeterministicRng.fromSeed("999");
    const second = DeterministicRng.fromSeed("999");
    for (let index = 0; index < 100; index += 1) {
      expect(second.nextUint32()).toBe(first.nextUint32());
    }
  });

  it("snapshot/restore continues the exact sequence", () => {
    const rng = DeterministicRng.fromSeed("7");
    rng.nextUint32();
    rng.nextUint32();
    const state = rng.snapshot();
    const expected = [rng.nextUint32(), rng.nextUint32(), rng.nextFloat53()];

    const resumed = DeterministicRng.fromState(state);
    expect([resumed.nextUint32(), resumed.nextUint32(), resumed.nextFloat53()]).toEqual(expected);
  });

  it("restore rolls an advanced generator back", () => {
    const rng = DeterministicRng.fromSeed("7");
    const state = rng.snapshot();
    const first = rng.nextUint32();
    rng.nextUint32();
    rng.restore(state);
    expect(rng.nextUint32()).toBe(first);
  });

  it("nextFloat53 stays in [0, 1) and is deterministic", () => {
    const rng = DeterministicRng.fromSeed("31337");
    const other = DeterministicRng.fromSeed("31337");
    for (let index = 0; index < 200; index += 1) {
      const value = rng.nextFloat53();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(other.nextFloat53()).toBe(value);
    }
  });

  it("nextIntBelow stays in range and covers the range", () => {
    const rng = DeterministicRng.fromSeed("42");
    const seen = new Set<number>();
    for (let index = 0; index < 300; index += 1) {
      const value = rng.nextIntBelow(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
      seen.add(value);
    }
    expect(seen.size).toBe(7);
  });

  it("nextIntBelow rejects a non-positive, fractional, or oversized bound with a typed error", () => {
    const rng = DeterministicRng.fromSeed("1");
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 32 + 1, Number.POSITIVE_INFINITY]) {
      expect(() => rng.nextIntBelow(bad)).toThrow(RangeError);
    }
    expect(rng.nextIntBelow(1)).toBe(0);
  });

  it("isRngState accepts exactly four uint32 lanes", () => {
    expect(isRngState([0, 1, 2, 3])).toBe(true);
    expect(isRngState([0, 1, 2, 2 ** 32 - 1])).toBe(true);
    expect(isRngState([0, 1, 2])).toBe(false);
    expect(isRngState([0, 1, 2, 3, 4])).toBe(false);
    expect(isRngState([0, 1, 2, -1])).toBe(false);
    expect(isRngState([0, 1, 2, 2 ** 32])).toBe(false);
    expect(isRngState([0, 1, 2, 3.5])).toBe(false);
    expect(isRngState(["0", 1, 2, 3])).toBe(false);
    expect(isRngState(null)).toBe(false);
    expect(isRngState({})).toBe(false);
  });
});
