/**
 * `@polymarket-bot/universe` — the Universe Service (WP-110, handoff §9.2).
 *
 * What this package owns:
 *
 * - **Market identity**: the binding between our `InternalMarketId` and the
 *   venue's condition id, event id, and two outcome tokens, with uniqueness
 *   enforced across the universe.
 * - **Series grouping as CONFIGURATION**: an approved binding requires a human;
 *   the heuristic produces suggestions and can never promote one (§9.2).
 * - **Versioned parameters**: tick size, minimum size, `negRisk`, fee-schedule
 *   reference, trading delay, open/close, and status, in an append-only,
 *   immutable, queryable history (§6 invariant 9).
 * - **Lifecycle projection** over the frozen §7.4 events, including the
 *   post-open clarification case and the rule that only `MarketResolved` may
 *   set a terminal outcome.
 * - **Eligibility and readiness predicates**, including the refusal to activate
 *   a model-dependent strategy on a settlement spec nobody verified.
 *
 * DEPENDENCY DIRECTION (`docs/contracts/dependency-direction.md`): layer 1,
 * depending downward on `@polymarket-bot/domain` and `@polymarket-bot/decimal`
 * and on `zod`. It does NOT depend on `@polymarket-bot/settlement`, which is the
 * same layer and has no §2.1 row: the settlement verdict arrives through the
 * port in `settlement-binding.ts`, wired at a composition root.
 *
 * PURITY: no I/O, no clock, no randomness, no mutable global state. Registry
 * values are immutable and every operation returns a new one.
 */

export {
  UniverseError,
  UniverseValidationError,
  universeFailure,
  universeOk,
  universeRefusal,
} from "./errors.js";
export type {
  UniverseRefusal,
  UniverseRefusalCode,
  UniverseRefusalDetails,
  UniverseResult,
} from "./errors.js";

export { MarketIdentitySchema, isSameMarketIdentity } from "./identity.js";
export type { MarketIdentity } from "./identity.js";

export {
  EVENT_DRIVEN_LIFECYCLE_STATES,
  MarketLifecycleStateSchema,
  lifecycleRank,
} from "./lifecycle-state.js";
export type { EventDrivenLifecycleState, MarketLifecycleState } from "./lifecycle-state.js";

export {
  MarketParametersSchema,
  ParameterObservationSchema,
  appendParameterVersion,
  changedParameterKinds,
  createParameterHistory,
  currentParameterVersion,
  parameterVersion,
  parametersAsOf,
} from "./parameters.js";
export type {
  MarketParameterHistory,
  MarketParameterVersion,
  MarketParameters,
  ParameterObservation,
  ParameterVersionAppended,
} from "./parameters.js";

export {
  SeriesBindingApprovalSchema,
  SeriesDefinitionSchema,
  UNBOUND_SERIES_BINDING,
  approvedSeriesBinding,
  isApprovedSeriesBinding,
  suggestSeriesBindings,
  suggestedSeriesBinding,
} from "./series.js";
export type {
  MarketSeriesBinding,
  SeriesBindingApproval,
  SeriesDefinition,
  SeriesSuggestion,
} from "./series.js";

export {
  MARKET_LIFECYCLE_EVENT_TYPES,
  applyMarketLifecycleEvent,
  clarificationsAfterOpen,
  effectiveCloseInstant,
  effectiveLifecycleState,
  recordObservedOutcomeState,
} from "./lifecycle.js";
export type {
  EventOrder,
  MarketClarificationRecord,
  MarketLifecycleEventType,
  MarketLifecycleInput,
  MarketProjection,
  ObservedOutcomeStateInput,
  ProjectionApplied,
} from "./lifecycle.js";

export { marketLifecycleInputFromEnvelope } from "./envelope.js";
export type { EnvelopeLifecycleInput } from "./envelope.js";

export {
  applyMarketEvent,
  approveSeries,
  bindMarketToSeries,
  createUniverseRegistry,
  findMarketByConditionId,
  findMarketByTokenId,
  recordMarketOutcomeState,
  recordMarketParameters,
  recordSeriesSuggestion,
  registerMarket,
  registerSeries,
  suggestSeriesForMarket,
} from "./registry.js";
export type {
  MarketEventApplied,
  MarketParametersRecorded,
  MarketRegistered,
  MarketRegistrationInput,
  UniverseRegistry,
} from "./registry.js";

export {
  ACTIVATION_PERMITTED_STATUS,
  SETTLEMENT_ACTIVATION_STATUSES,
  isConsistentSettlementActivation,
  permittedSettlementActivationProblems,
} from "./settlement-binding.js";
export type {
  BlockedSettlementActivationStatus,
  BlockedSettlementActivationView,
  PermittedSettlementActivationView,
  PermittedVerdictProblem,
  SettlementActivationStatus,
  SettlementActivationView,
  SettlementRefusalView,
  UnvalidatedSettlementActivationView,
} from "./settlement-binding.js";

export {
  currentTradingParameters,
  evaluateMarketReadiness,
  hasApprovedSeriesBinding,
} from "./eligibility.js";
export type {
  MarketReadiness,
  MarketReadinessInput,
  MarketReadinessPolicy,
} from "./eligibility.js";

export { instantMilliseconds, isAtOrAfter, isBefore, isSameInstant } from "./time.js";

/**
 * `ROLLOVER-1` (ADR-030): series auto-admission in PAPER — the reviewed
 * series, the exact-match judge, the run-mode guard, the admitted window's
 * derived identity, and its schedule from its title.
 */
export {
  ADMISSION_RUN_MODES,
  ReviewedSeriesSchema,
  admissionRunModeProblem,
  canonicalSeriesJson,
  judgeSeriesWindow,
  parseReviewedSeries,
  seriesConfigHash,
  windowInternalMarketId,
} from "./series-admission.js";
export type {
  AdmittedWindowFacts,
  ClobMarketInfoReading,
  GammaWindowEventReading,
  GammaWindowMarketReading,
  ReviewedSeries,
  ReviewedSeriesParse,
  SeriesWindowVerdict,
  VenueBooleanReading,
  VenueDecimalReading,
  VenueStringReading,
} from "./series-admission.js";
export {
  SERIES_TITLE_TIME_ZONE,
  SERIES_TITLE_ZONE_LABEL,
  deriveWindowSchedule,
  epochMsOfInstant,
  isoFromEpochMs,
} from "./series-window-schedule.js";
export type { SeriesWindowShape, WindowScheduleResult } from "./series-window-schedule.js";
