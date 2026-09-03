/**
 * @polymarket-bot/strategy-sdk — the pure, versioned strategy interface
 * (WP-170; handoff §9.6, §7.6; ADR-005).
 *
 * This package is what a concrete strategy package imports (the §2.1 S2 edge
 * of `docs/contracts/dependency-direction.md`). Its dependency surface is the
 * enforcement mechanism that keeps strategies away from venue/storage
 * adapters: the only dependency is the frozen layer-0 `@polymarket-bot/domain`,
 * so nothing reachable through this package can perform I/O. Declarations
 * only — no function in this package has a body beyond constants.
 */

export {
  STRATEGY_CALLBACK_NAMES,
  STRATEGY_SDK_CONTRACT_VERSION,
  type Strategy,
  type StrategyCallbackName,
} from "./strategy.js";

export type { SeededRandom, StrategyContext } from "./context.js";

export type {
  BookLevelView,
  FeatureSnapshot,
  MarketView,
  OrderBookView,
  ResolutionView,
  RiskBudgetView,
  SourceEventRef,
  StrategyFill,
  StrategyOrderStatus,
  StrategyOrderView,
  VirtualPositionView,
} from "./views.js";

// Convenience type-only re-exports of the frozen domain contracts a strategy
// returns. The values (schemas) stay in `@polymarket-bot/domain`; a strategy
// that needs them declares the layer-0 dependency itself.
export type { DecisionResult, DecisionType, Intent } from "@polymarket-bot/domain";
