/**
 * The seeded random source (§6 invariant 2, §12.4).
 *
 * §6 invariant 2 forbids "unseeded randomness"; §12.4 requires a fixed seed to
 * produce byte-identical output. So this package contains no `Math.random`, no
 * `crypto.getRandomValues`, and no entropy of any kind: every draw comes from
 * an explicit seed through the generator below.
 *
 * ## The generator
 *
 * SplitMix64 (Steele, Lea & Flood 2014), implemented on `BigInt` masked to 64
 * bits. It is chosen because it is:
 *
 * - **fully specified by three constants**, so an independent oracle in the
 *   test suite reimplements it in a few lines and disagrees loudly if this one
 *   drifts (`test/unit/simulation/determinism.test.ts` does exactly that);
 * - **stateless apart from a 64-bit counter**, so a stream's `n`th draw is a
 *   pure function of `(seed, streamLabel, n)` and a replay can be resumed or
 *   re-derived without replaying the draws before it;
 * - **not cryptographic, and never used as if it were** — nothing here protects
 *   a secret; it selects a latency sample.
 *
 * ## Named streams
 *
 * A model that draws from one shared stream couples unrelated decisions: adding
 * a latency draw would shift every later queue draw and change a result that
 * should not have moved. Each model therefore takes a NAMED stream derived from
 * the run seed and a label, so `latency.network` and `queue.cancellation` are
 * independent and a new model can be added without perturbing the old ones.
 */

const MASK64 = (1n << 64n) - 1n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const MIX_A = 0xbf58476d1ce4e5b9n;
const MIX_B = 0x94d049bb133111ebn;

function mix(value: bigint): bigint {
  let z = value & MASK64;
  z = ((z ^ (z >> 30n)) * MIX_A) & MASK64;
  z = ((z ^ (z >> 27n)) * MIX_B) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** A named, seeded, resumable draw sequence. */
export class SeededStream {
  #state: bigint;
  #draws = 0;
  readonly label: string;

  constructor(label: string, state: bigint) {
    this.label = label;
    this.#state = state & MASK64;
  }

  /** How many draws this stream has produced. Part of the run report. */
  get draws(): number {
    return this.#draws;
  }

  /** The next 64-bit draw. */
  nextUint64(): bigint {
    this.#state = (this.#state + GOLDEN_GAMMA) & MASK64;
    this.#draws += 1;
    return mix(this.#state);
  }

  /**
   * A uniform draw in `[0, bound)`, unbiased.
   *
   * Rejection sampling rather than a modulo: a plain `% bound` over-weights the
   * low end whenever `bound` does not divide `2^64`, which for a latency
   * distribution means a systematically optimistic simulator.
   */
  nextBelow(bound: bigint): bigint {
    if (bound <= 0n) return 0n;
    const limit = (1n << 64n) - ((1n << 64n) % bound);
    for (;;) {
      const draw = this.nextUint64();
      if (draw < limit) return draw % bound;
    }
  }
}

/**
 * Derives a named stream from a run seed.
 *
 * The label is folded in one UTF-16 code unit at a time through the same mixing
 * function, so two labels that differ anywhere give unrelated streams. No hash
 * library is involved, which is what keeps this package free of `node:crypto`
 * (`docs/contracts/dependency-direction.md` §2.2).
 */
export function deriveStream(runSeed: string, label: string): SeededStream {
  let state = mix(BigInt(runSeed) & MASK64);
  state = (state ^ mix(BigInt(label.length))) & MASK64;
  for (let index = 0; index < label.length; index += 1) {
    state = mix((state + BigInt(label.charCodeAt(index)) + GOLDEN_GAMMA) & MASK64);
  }
  return new SeededStream(label, state);
}

/**
 * Every stream name this package draws from.
 *
 * Exactly the four §12.2 latency components, and nothing else: the queue model
 * ({@link ./queue.js}) is DETERMINISTIC given its parameters, because its
 * scenarios are stated assumptions rather than sampled quantities, and adding a
 * draw there would manufacture variability nobody measured (ADR-012 §7).
 */
export const SEEDED_STREAM_LABELS = [
  "latency.decision",
  "latency.signing",
  "latency.network",
  "latency.venue",
] as const;

export type SeededStreamLabel = (typeof SEEDED_STREAM_LABELS)[number];

/** The full set of streams for one run. */
export type SeededStreams = Readonly<Record<SeededStreamLabel, SeededStream>>;

/** Derives every stream for a run seed. */
export function deriveStreams(runSeed: string): SeededStreams {
  const out = Object.create(null) as Record<string, SeededStream>;
  for (const label of SEEDED_STREAM_LABELS) {
    out[label] = deriveStream(runSeed, label);
  }
  return out as SeededStreams;
}
