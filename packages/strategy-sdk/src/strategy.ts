/**
 * The pure, versioned strategy interface — handoff §9.6, verbatim.
 *
 * A strategy is deterministic, synchronous, and side-effect-free (§2, §6
 * invariant 2, ADR-005 §1). Every callback returns exactly one
 * `DecisionResult`; the RUNTIME, not the strategy, guarantees that exactly one
 * decision record is persisted per callback (§6 invariant 3, ADR-005 §2).
 *
 * Versioning: `name`/`version` identify the strategy code,
 * `stateSchemaVersion` versions the checkpointed state shape (§9.6 "Start a
 * new run for every code, config, model, feature, or state-schema change"),
 * and `STRATEGY_SDK_CONTRACT_VERSION` versions this interface itself.
 *
 * `paramsSchema` is `unknown` per §9.6. The runtime accepts a Zod-structural
 * schema — any object exposing `safeParse(value)` — and refuses anything else
 * with a typed error (see `packages/strategy-runtime`).
 *
 * `TParams` and `TState` document the strategy's own parameter and state
 * shapes. They are deliberately not threaded through the context: §7.6 fixes
 * `StrategyContext` as non-generic with `params<T>()` / `state<T>()` methods,
 * and this interface follows both frozen shapes rather than reconciling them
 * into something the handoff does not say.
 */

import type { DecisionResult } from "@polymarket-bot/domain";

import type { StrategyContext } from "./context.js";
import type { ResolutionView, StrategyFill, StrategyOrderView } from "./views.js";

/** Version of the SDK strategy-interface contract itself. */
export const STRATEGY_SDK_CONTRACT_VERSION = 1;

/**
 * The nine §9.6 callbacks, in the handoff's order. This vocabulary matches
 * the storage layer's `internal.strategy_callback` enum (WP-040, §10.3
 * `decisions.callback`) so a persisted record names the callback verbatim.
 */
export const STRATEGY_CALLBACK_NAMES = [
  "onStart",
  "onMarketOpen",
  "onFeatures",
  "onFill",
  "onOrderUpdate",
  "onTimer",
  "onMarketClosing",
  "onMarketResolved",
  "onStop",
] as const;

export type StrategyCallbackName = (typeof STRATEGY_CALLBACK_NAMES)[number];

/**
 * Handoff §9.6, verbatim.
 *
 * `TParams` and `TState` are documentation-only type parameters: §9.6 fixes
 * this signature and §7.6 fixes `StrategyContext` as NON-generic
 * (`params<T>()` / `state<T>()`), so neither parameter has a position to
 * appear in without departing from one of the two frozen shapes. They are kept
 * because a strategy declares `Strategy<MyParams, MyState>` and the two names
 * are how its author states those types; the lint exemption is narrow and
 * deliberate rather than a signature change.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface Strategy<TParams, TState> {
  readonly name: string;
  readonly version: string;
  readonly paramsSchema: unknown;
  readonly stateSchemaVersion: number;

  onStart(ctx: StrategyContext): DecisionResult;
  onMarketOpen(ctx: StrategyContext): DecisionResult;
  onFeatures(ctx: StrategyContext): DecisionResult;
  onFill(ctx: StrategyContext, fill: StrategyFill): DecisionResult;
  onOrderUpdate(ctx: StrategyContext, order: StrategyOrderView): DecisionResult;
  onTimer(ctx: StrategyContext): DecisionResult;
  onMarketClosing(ctx: StrategyContext, secondsRemaining: number): DecisionResult;
  onMarketResolved(ctx: StrategyContext, resolution: ResolutionView): DecisionResult;
  onStop(ctx: StrategyContext, reason: string): DecisionResult;
}
