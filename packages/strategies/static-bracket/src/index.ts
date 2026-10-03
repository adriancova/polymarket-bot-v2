/**
 * `@polymarket-bot/strategy-static-bracket` — the first strategy (WP-220;
 * handoff §13).
 *
 * A layer-1, PURITY-RESTRICTED package: no network, database, filesystem,
 * environment, clock or unseeded randomness, and no schema library (ADR-005 §1,
 * `docs/contracts/dependency-direction.md` §3 F3/F11/F14, enforced by
 * `check:deps`). Its only workspace dependencies are
 * `@polymarket-bot/strategy-sdk` (the §2.1 S2 edge) and
 * `@polymarket-bot/decimal` (layer 0, exact economics).
 *
 * It emits INTENTS and nothing else. Risk, allocation, execution planning, the
 * OMS and the venue adapters own orders (§2, §7.7, ADR-005 §4).
 *
 * It is NOT presumed profitable (§13.1). Nothing in this package or its tests
 * claims, measures, or implies an edge.
 */

export { staticBracketStrategy, STATIC_BRACKET_NAME, STATIC_BRACKET_VERSION } from "./strategy.js";

export {
  staticBracketParamsSchema,
  validateStaticBracketParams,
  STATIC_BRACKET_CONFIG_VERSION,
  STATIC_BRACKET_CONFIG_VERSION_2,
  STATIC_BRACKET_CONFIG_VERSIONS,
  BOOK_AGE_FEATURE_KEY,
  STATIC_BRACKET_STRATEGY_NAME,
  DATA_QUALITY_RESPONSES,
  ECONOMIC_LEG_POLICIES,
  FINAL_POLICIES,
  IMMEDIATE_ORDER_TYPES,
  LIQUIDITY_PREFERENCES,
  OUTCOME_SIDES,
  PARTIAL_FILL_POLICIES,
  REDUCTION_URGENCIES,
  type DataQualityParams,
  type DataQualityResponse,
  type EconomicLegPolicy,
  type EntryEconomicsParams,
  type EntryExecutionParams,
  type EntryParams,
  type ExitParams,
  type FinalPolicy,
  type ImmediateOrderType,
  type LiquidityPreference,
  type MarketSelectorParams,
  type OutcomeSide,
  type PartialFillPolicy,
  type ReductionUrgency,
  type ReentryParams,
  type RiskParams,
  type StaticBracketParams,
  type StopParams,
  type TakeProfitParams,
} from "./params.js";

export {
  INSTANCE_STATES,
  INSTANCE_TRANSITIONS,
  INSTANCE_TRIGGERS,
  ORDER_STATES,
  ORDER_TRANSITIONS,
  ORDER_TRIGGERS,
  RESUME_TARGET,
  TERMINAL_ORDER_STATES,
  instanceTransition,
  isInstanceState,
  isOrderState,
  isResumeTarget,
  orderTransition,
  readInstanceState,
  readOrderState,
  type InstanceState,
  type InstanceTransition,
  type InstanceTransitionResult,
  type InstanceTrigger,
  type OrderState,
  type OrderTransition,
  type OrderTransitionResult,
  type OrderTrigger,
} from "./machine.js";

export {
  INITIAL_STATE,
  STATIC_BRACKET_STATE_SCHEMA_VERSION,
  readState,
  stateToPatch,
  withState,
  type OrderTrack,
  type StaticBracketState,
} from "./state.js";

export {
  BASIS_FEATURE_ID,
  FEATURE_IDS_V1,
  INCIDENT_FEATURE_ID,
  TRIGGER_BASES,
  isFeatureIdV1,
  parseFeatureKey,
  readFeatureFlag,
  readFeatureScalar,
  type FeatureKey,
  type FeatureRead,
  type FeatureValues,
  type TriggerBasis,
} from "./features.js";

export { REASONS, TAGS, legTag, orderTypeTag, type Reason } from "./reasons.js";

export {
  EXIT_ROLE_PREFIXES,
  assessDataQuality,
  measureBookAge,
  chooseLeg,
  currentLeg,
  exitRole,
  expectedNetEdge,
  openShares,
  planClosing,
  planFill,
  planOrderUpdate,
  planResolved,
  planStop,
  planTick,
  statusTrigger,
  stopTriggerSatisfied,
  type ConfirmedFill,
  type DataQuality,
  type ExitRole,
  type LegQuote,
  type Plan,
  type TickContext,
} from "./decide.js";

export {
  askDepthUpTo,
  bidDepthDownTo,
  heldShares,
  observe,
  orderView,
  walkForSize,
  type BookLevel,
  type BookSnapshot,
  type BookWalk,
  type MarketSnapshot,
  type Observation,
  type ObserveResult,
  type PositionSnapshot,
  type TrackedOrderView,
  type ViewFault,
} from "./observe.js";

export {
  MAX_PLAIN_DEPTH,
  hasOwn,
  plainCopy,
  readOwn,
  refuseUnknownKeys,
  type Outcome,
  type PlainJson,
  type PlainRecord,
} from "./plain.js";

export { formatInstantMs, parseInstantMs } from "./time.js";

export {
  ONE,
  ZERO,
  add,
  compare,
  complement,
  greaterOrEqual,
  isDecimal,
  isNonNegative,
  isPositive,
  isPrice,
  isZero,
  lessOrEqual,
  mul,
  onTickGrid,
  sub,
  type Money,
  type Price,
  type Shares,
} from "./economics.js";
