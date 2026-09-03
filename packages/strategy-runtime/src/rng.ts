/**
 * Deterministic seeded RNG (§9.6 "Own per-instance state and deterministic
 * seeded RNG"; ADR-005 §1).
 *
 * Implementation: sfc32 over four 32-bit lanes, seeded by folding the run's
 * canonical unsigned-integer seed string through cyrb128. Everything is
 * 32-bit integer arithmetic (`Math.imul`, shifts, `>>>`), which is exact and
 * platform-independent in ECMAScript — no wall clock, no `Math.random`, no
 * `node:crypto`, no I/O.
 *
 * The generator state is serializable (four uint32s) and is carried inside
 * every checkpoint, so a restored instance continues the exact sequence the
 * stopped instance would have produced (§12.4 byte-identical replay).
 */

export type RngState = readonly [number, number, number, number];

const UINT32_RANGE = 0x1_0000_0000;
const WARMUP_DRAWS = 12;

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < UINT32_RANGE;
}

/**
 * True when `state` is a well-formed serialized RNG state.
 *
 * TOTAL since remediation round 3: a predicate that throws is not a predicate,
 * and every operation below can run caller code — `Array.isArray` throws on a
 * REVOKED proxy, and `length`/`every` run traps. Callers that intend to KEEP
 * the value should materialize it first and test the copy, which is what
 * `restoreCheckpoint` does; this guard exists so that a direct caller passing
 * something exotic gets `false` instead of an exception.
 */
export function isRngState(state: unknown): state is RngState {
  try {
    return Array.isArray(state) && state.length === 4 && state.every((lane) => isUint32(lane));
  } catch {
    return false;
  }
}

/** cyrb128 fold of an arbitrary seed string into four uint32 lanes. */
function seedLanes(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < seed.length; index += 1) {
    const k = seed.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/**
 * The runtime-owned generator. Implements the SDK's `SeededRandom` draw
 * surface plus `snapshot`/`restore` for checkpointing — the strategy never
 * sees those two (the context hands out a frozen draw-only facade).
 */
export class DeterministicRng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  private constructor(state: RngState) {
    [this.a, this.b, this.c, this.d] = state;
  }

  /** Seed a fresh generator from the run seed string. */
  static fromSeed(seed: string): DeterministicRng {
    const rng = new DeterministicRng(seedLanes(seed));
    for (let index = 0; index < WARMUP_DRAWS; index += 1) {
      rng.nextUint32();
    }
    return rng;
  }

  /** Restore a generator from a checkpointed state. Caller validates via `isRngState`. */
  static fromState(state: RngState): DeterministicRng {
    return new DeterministicRng(state);
  }

  nextUint32(): number {
    // sfc32
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  nextFloat53(): number {
    const hi = this.nextUint32() >>> 6; // 26 bits
    const lo = this.nextUint32() >>> 5; // 27 bits
    return (hi * 134217728 + lo) / 9007199254740992; // (hi << 27 | lo) / 2^53
  }

  nextIntBelow(maxExclusive: number): number {
    if (
      typeof maxExclusive !== "number" ||
      !Number.isInteger(maxExclusive) ||
      maxExclusive < 1 ||
      maxExclusive > UINT32_RANGE
    ) {
      throw new RangeError(
        `nextIntBelow requires an integer in [1, 2^32]; received ${String(maxExclusive)}`,
      );
    }
    // Rejection sampling for exact uniformity; deterministic because the
    // underlying draw sequence is.
    const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
    let draw = this.nextUint32();
    while (draw >= limit) {
      draw = this.nextUint32();
    }
    return draw % maxExclusive;
  }

  snapshot(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  restore(state: RngState): void {
    [this.a, this.b, this.c, this.d] = state;
  }
}
