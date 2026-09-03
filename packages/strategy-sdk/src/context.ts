/**
 * §7.6 `StrategyContext` and `SeededRandom` — the complete surface a strategy
 * may observe. Verbatim to the handoff's §7.6 interface: same methods, same
 * signatures, nothing added.
 *
 * "No context method performs network or database I/O. The runtime constructs
 * the context from current in-memory state." (§7.6). Time comes only from
 * `now()` (the logical evaluation timestamp) and randomness only from `rng()`
 * (a per-run deterministically seeded generator, §9.6) — a strategy that
 * reaches for `Date.now()` or `Math.random()` violates §6 invariant 2 and the
 * F11 dependency-contract rule, mechanically checked by `check:deps`.
 */

import type {
  FeatureSnapshot,
  MarketView,
  OrderBookView,
  RiskBudgetView,
  StrategyOrderView,
  VirtualPositionView,
} from "./views.js";

/**
 * Deterministic seeded randomness (§9.6 "deterministic seeded RNG"; ADR-005
 * §1). The runtime owns the generator and its state; the state is part of the
 * checkpoint so a restored instance continues the same sequence.
 */
export interface SeededRandom {
  /** Uniform integer in [0, 2^32). */
  nextUint32(): number;
  /** Uniform double in [0, 1) with 53 bits of precision. */
  nextFloat53(): number;
  /** Uniform integer in [0, maxExclusive); `maxExclusive` must be an integer in [1, 2^32]. */
  nextIntBelow(maxExclusive: number): number;
}

/** Handoff §7.6, verbatim. */
export interface StrategyContext {
  now(): string;
  market(): Readonly<MarketView>;
  book(outcome: "YES" | "NO"): Readonly<OrderBookView>;
  features(): Readonly<FeatureSnapshot>;
  position(): Readonly<VirtualPositionView>;
  orders(): readonly StrategyOrderView[];
  riskBudget(): Readonly<RiskBudgetView>;
  params<T>(): Readonly<T>;
  state<T>(): Readonly<T>;
  rng(): SeededRandom;
}
