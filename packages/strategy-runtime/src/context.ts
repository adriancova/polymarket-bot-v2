/**
 * The §7.6 `StrategyContext` implementation. "No context method performs
 * network or database I/O. The runtime constructs the context from current
 * in-memory state."
 *
 * **The context is INVOCATION-SCOPED.** It is a capability handed to exactly
 * one callback invocation, and every capability on it is revoked the moment
 * that invocation returns or throws (`runtime.ts` revokes in a `finally`
 * immediately around the call). After revocation each method refuses with a
 * typed `StrategyContextRevokedError` naming the capability.
 *
 * Why revocation exists at all (review finding H1, 2026-09-02): the RNG facade
 * closes over the runtime's LIVE generator. A strategy that kept `ctx` and
 * drew from it between callbacks shifted the shared stream, so the next
 * decision saw a different draw than a replay of the same seed would — and the
 * out-of-band draw was represented in no checkpoint and attributable to no
 * decision. Reproduced with seed `1`: the second decision's draw was
 * `2958390140` normally and `798431460` after one retained out-of-band draw,
 * while a fresh runtime restored from the checkpoint written after the first
 * callback produced `2958390140`. The guard runs BEFORE the draw, so a refused
 * call cannot advance the generator.
 *
 * Which capabilities were audited, and what each one closes over:
 * - `rng` (and the three draw methods) — the runtime's MUTABLE
 *   `DeterministicRng`. The determinism hazard; the reason for this design.
 * - `state` — the state object as it stood when the context was built. The
 *   runtime REPLACES `this.state` with a new frozen object when a decision
 *   commits, so a retained context would keep answering with a superseded
 *   state: a silently stale read, not a mutation.
 * - `market`, `book`, `features`, `position`, `orders`, `riskBudget` — the
 *   deep-frozen views of THAT evaluation's input. Retaining them across
 *   evaluations is a silently stale read of market data.
 * - `now` — the logical `evaluatedAt` of that evaluation; stale afterwards.
 * - `params` — the instance's frozen params, identical for the run's whole
 *   life. No hazard was found here.
 * Only `rng` can perturb runtime state, but ALL of them are revoked on the
 * same discipline: a stale read should be loud, and a future capability added
 * to this object inherits the guard instead of re-opening the hole.
 *
 * Honest limit of revocation: it withdraws the CAPABILITY, not copies of the
 * immutable data already read through it. A strategy may keep the frozen view
 * object it obtained during the callback; that object is deep-frozen plain
 * data and cannot affect runtime state or the RNG stream.
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
import { StrategyContextRevokedError, type StrategyContextCapability } from "./outcomes.js";
import type { DeterministicRng } from "./rng.js";

/**
 * Throws the typed refusal once the invocation that owns the capability has
 * ended. Every context method calls this first.
 */
type CapabilityGuard = (capability: StrategyContextCapability) => void;

/** One invocation's context plus the runtime-only revocation handle. */
export interface ScopedStrategyContext {
  /** Valid only for the duration of the callback invocation it was built for. */
  readonly context: StrategyContext;
  /**
   * Revokes every capability on `context`. Idempotent; called from the
   * `finally` around the callback, so it runs on the returning AND the
   * throwing path.
   */
  readonly revoke: () => void;
}

/**
 * A frozen draw-only view over the runtime-owned generator, gated by the
 * invocation's guard. The guard runs before the draw: a revoked call refuses
 * WITHOUT advancing the generator, which is what keeps a checkpoint an exact
 * description of the stream.
 */
export function drawOnlyRng(rng: DeterministicRng, guard: CapabilityGuard): SeededRandom {
  return Object.freeze({
    nextUint32: (): number => {
      guard("rng.nextUint32");
      return rng.nextUint32();
    },
    nextFloat53: (): number => {
      guard("rng.nextFloat53");
      return rng.nextFloat53();
    },
    nextIntBelow: (maxExclusive: number): number => {
      guard("rng.nextIntBelow");
      return rng.nextIntBelow(maxExclusive);
    },
  });
}

export function buildStrategyContext(
  input: EvaluationInput,
  params: unknown,
  state: Readonly<Record<string, unknown>>,
  rng: DeterministicRng,
): ScopedStrategyContext {
  let live = true;
  const guard: CapabilityGuard = (capability) => {
    if (!live) {
      throw new StrategyContextRevokedError(capability);
    }
  };

  // Freeze the observable views in place; the caller handed ownership.
  const market = deepFreeze(input.market);
  const books = deepFreeze(input.books);
  const features = deepFreeze(input.features);
  const position = deepFreeze(input.position);
  const orders = deepFreeze(input.orders);
  const riskBudget = deepFreeze(input.riskBudget);
  const evaluatedAt = input.evaluatedAt;
  const rngFacade = drawOnlyRng(rng, guard);

  const context: StrategyContext = Object.freeze({
    now: (): string => {
      guard("now");
      return evaluatedAt;
    },
    market: (): Readonly<MarketView> => {
      guard("market");
      return market;
    },
    book: (outcome: "YES" | "NO"): Readonly<OrderBookView> => {
      guard("book");
      return outcome === "YES" ? books.yes : books.no;
    },
    features: (): Readonly<FeatureSnapshot> => {
      guard("features");
      return features;
    },
    position: (): Readonly<VirtualPositionView> => {
      guard("position");
      return position;
    },
    orders: (): readonly StrategyOrderView[] => {
      guard("orders");
      return orders;
    },
    riskBudget: (): Readonly<RiskBudgetView> => {
      guard("riskBudget");
      return riskBudget;
    },
    params: <T>(): Readonly<T> => {
      guard("params");
      return params as Readonly<T>;
    },
    state: <T>(): Readonly<T> => {
      guard("state");
      return state as Readonly<T>;
    },
    rng: (): SeededRandom => {
      guard("rng");
      return rngFacade;
    },
  });

  return Object.freeze({
    context,
    revoke: (): void => {
      live = false;
    },
  });
}
