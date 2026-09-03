/**
 * The §7.6 `StrategyContext` implementation. "No context method performs
 * network or database I/O. The runtime constructs the context from current
 * in-memory state."
 *
 * Everything a strategy can reach from here is frozen: the views are
 * deep-frozen in place (the caller handed ownership via `EvaluationInput`),
 * params and state are frozen by the runtime before this is built, and the
 * RNG surface is a frozen draw-only facade — `snapshot`/`restore` stay with
 * the runtime, so a strategy can consume randomness but cannot rewind or
 * replant it.
 *
 * `now()` returns the logical evaluation timestamp injected with the input —
 * never a wall clock (§6 invariant 2, F11).
 */

import type { SeededRandom, StrategyContext } from "@polymarket-bot/strategy-sdk";
import type {
  FeatureSnapshot,
  MarketView,
  OrderBookView,
  RiskBudgetView,
  StrategyOrderView,
  VirtualPositionView,
} from "@polymarket-bot/strategy-sdk";

import type { EvaluationInput } from "./input.js";
import { deepFreeze } from "./json.js";
import type { DeterministicRng } from "./rng.js";

/** A frozen draw-only view over the runtime-owned generator. */
export function drawOnlyRng(rng: DeterministicRng): SeededRandom {
  return Object.freeze({
    nextUint32: () => rng.nextUint32(),
    nextFloat53: () => rng.nextFloat53(),
    nextIntBelow: (maxExclusive: number) => rng.nextIntBelow(maxExclusive),
  });
}

export function buildStrategyContext(
  input: EvaluationInput,
  params: unknown,
  state: Readonly<Record<string, unknown>>,
  rng: SeededRandom,
): StrategyContext {
  // Freeze the observable views in place; the caller handed ownership.
  const market = deepFreeze(input.market);
  const books = deepFreeze(input.books);
  const features = deepFreeze(input.features);
  const position = deepFreeze(input.position);
  const orders = deepFreeze(input.orders);
  const riskBudget = deepFreeze(input.riskBudget);
  const evaluatedAt = input.evaluatedAt;

  return Object.freeze({
    now: (): string => evaluatedAt,
    market: (): Readonly<MarketView> => market,
    book: (outcome: "YES" | "NO"): Readonly<OrderBookView> =>
      outcome === "YES" ? books.yes : books.no,
    features: (): Readonly<FeatureSnapshot> => features,
    position: (): Readonly<VirtualPositionView> => position,
    orders: (): readonly StrategyOrderView[] => orders,
    riskBudget: (): Readonly<RiskBudgetView> => riskBudget,
    params: <T>(): Readonly<T> => params as Readonly<T>,
    state: <T>(): Readonly<T> => state as Readonly<T>,
    rng: (): SeededRandom => rng,
  });
}
