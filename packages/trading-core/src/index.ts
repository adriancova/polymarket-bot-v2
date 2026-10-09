/**
 * `@polymarket-bot/trading-core` — the shared deterministic trading core
 * (ADR-022; `dependency-direction.md` §2, layer 1).
 *
 * `createPaperTrader`, `CoreLoop`, and the modules in their import closure.
 * `CORE-MOVE` moved them here from `apps/trader/src`, byte for byte, under the
 * user's H8 ruling (option A, 2026-09-28). `apps/trader` still assembles and
 * runs this core on live data, and `apps/backtest-cli` builds it from
 * `BACKTEST-2` on; both depend on it downward.
 *
 * The export blocks below are `apps/trader/src/index.ts`'s blocks for these
 * modules as they stood at `ac0b12f`, verbatim and in the same order. Four
 * blocks follow them:
 * - the venue policy cut from `apps/trader/src/main.ts` (`venue-policy.ts`);
 * - `unreplacedPnlSnapshotProblem`, which the trader's PostgreSQL store
 *   imports;
 * - `BACKTEST-2`'s ONE simulated-venue builder (`venue-builder.ts`, ADR-022
 *   D5), which every composition root and test harness calls;
 * - `BACKTEST-2`'s production in-memory store (`memory-store.ts`), which the
 *   backtest executable builds the core over.
 *
 * `@polymarket-bot/trader` and `@polymarket-bot/trader/testing` still export
 * every name they exported before the move, under the same name and kind,
 * until a later round retires them (ADR-022 D7).
 *
 * PAPER only. The run-mode ceiling in `safety.ts` and `config.ts` moved
 * unchanged (ADR-022 D6). There is no signer, credential, venue connection or
 * real-order path here. The only production `ExecutionVenue` in the
 * workspace is `packages/simulation`'s `SimulatedVenue`, which refuses
 * `EXECUTION_PROBE`, `LIVE_MICRO` and `LIVE` by name.
 */

export {
  BUILDER_ATTRIBUTION_NAMES,
  CREDENTIAL_NAME_PATTERNS,
  PRODUCTION_ACCOUNT_NAMES,
  PRODUCTION_SECRET_NAMES,
  REPOSITORY_MAXIMUM_RUN_MODE,
  TRADER_RUN_MODE,
  checkPaperTraderSafety,
  type Environment,
  type SafetyOutcome,
  type SafetyViolation,
  type SafetyViolationCode,
} from "./safety.js";

export {
  DEFAULT_MARKET_CHANNEL_FEED_ID,
  TraderConfigSchema,
  bookFreshnessBasisOf,
  configuredFeatureKeys,
  configuredSeries,
  marketChannelFeedIdOf,
  parseTraderConfig,
  type ConfigRefusal,
  type ConfiguredSeries,
  type InstanceConfig,
  type MarketConfig,
  type ParseConfigResult,
  type SeriesInstanceConfig,
  type TraderConfig,
} from "./config.js";

/** `ROLLOVER-1` (ADR-030): the trader's half of series auto-admission. */
export {
  ReviewedSeriesSchema,
  SERIES_TITLE_TIME_ZONE,
  SERIES_TITLE_ZONE_LABEL,
  admissionRunModeProblem,
  canonicalSeriesJson,
  deriveWindowSchedule,
  epochMsOfInstant,
  seriesConfigHash,
  windowInternalMarketId,
  type ReviewedSeries,
  type WindowScheduleResult,
} from "./series.js";
export {
  SeriesWindowAdmissions,
  type AdmissionMetrics,
  type AdmissionNotice,
  type AdmissionRefusalCode,
  type AdmissionVerdict,
  type AdmittedWindow,
  type WindowAttachment,
  type WindowTeardownReason,
} from "./series-admission.js";

export {
  CONSUMED_EVENTS,
  readEventEnvelope,
  type EventDoorRefusal,
  type EventDoorRefusalCode,
  type ReadEventResult,
} from "./event-door.js";

export {
  formatStrictUtc,
  isStrictUtcInstant,
  normalizeToStrictUtc,
  strictUtcEpochMs,
  type NormalizeInstantResult,
} from "./time.js";

export {
  EXECUTABLE_PRICE_FEATURE_IDS,
  FEATURE_PROJECTION_VERSION,
  INCIDENT_ANY_SELECTOR,
  INCIDENT_FEATURE_ID,
  buildStrategyFeatureView,
  projectFeatureValues,
  splitFeatureKey,
  type ProjectionRefusal,
  type ProjectionResult,
  type ScalarFeatureValue,
} from "./projection.js";

export { BoundedQueue, type OfferOutcome, type QueueMetrics } from "./queue.js";

export { frameKeyOf, sameFrame, type FrameKey } from "./frames.js";

export {
  HaltController,
  haltOnLedgerProjection,
  type HaltRecord,
  type HaltReasonCode,
  type HaltScope,
} from "./halt.js";

export {
  HealthState,
  RISK_SEAM_CAVEAT,
  RealizedPnlBook,
  type AccountingCounters,
  type AccountingHealth,
  type ExecutionHealth,
  type HealthHalt,
  type HealthSnapshot,
  type LoopHealth,
  type RealizedPnlHealth,
  type RealizedPnlObservation,
  type RiskHealth,
  type SeamHealth,
  type TransportHealth,
  type TransportHealthSource,
  unattachedTransportHealth,
} from "./health.js";

export {
  AllocatorGate,
  CostBasisBook,
  allocationMarketOf,
  intentLegs,
  requestFor,
  type AllocationMarket,
  type AllocationOutcome,
  type AllocationVerdict,
  type AllocatorMetrics,
  type IntentLeg,
} from "./allocation.js";

export {
  portFailed,
  portOk,
  type Clock,
  type DecisionOutbox,
  type EventEnvelope,
  type ExecutionVenue,
  type IngestedEvent,
  type MarketEventFeed,
  type MarketEventSource,
  type PortFailure,
  type PortFailureKind,
  type PortResult,
  type RecordedEventIdentity,
  type TraderStore,
  type GroupCommit,
  type StagedEvaluations,
  type FeedMark,
  type DispatchPosition,
  type RiskRefusalRecord,
  type AdmittedMarketRegistered,
  type AdmittedMarketRegistration,
} from "./ports.js";

export {
  FILLS_ARE_DELIVERED_WHILE_PAUSED,
  FillDeduplicator,
  type FillAdmission,
  type FillDeduplicatorMetrics,
  type IdentifiedFill,
} from "./fills.js";

export {
  OrderViewTracker,
  TERMINAL_STATUSES,
  isTerminalStatus,
  toStrategyOrderView,
  type OrderViewDelivery,
  type OrderViewMetrics,
} from "./orders.js";

export {
  DEFAULT_RETENTION,
  OrderTombstones,
  RetentionLog,
  UNREADABLE_BOOKED_SHARES,
  retentionBoundsProblem,
  settlementBlocker,
  type OrderLifecycleMetrics,
  type OrderTombstoneMetrics,
  type RetentionBounds,
  type RetentionHealth,
  type RetentionMetrics,
  type SettlementBlocker,
} from "./order-lifecycle.js";

export {
  EVERY_FILL_ACCOUNTING_CHECKS,
  HeldAccounting,
  PAPER_ACCOUNTING_CHECKS,
  accountingChecksProblem,
  type AccountingChecks,
  type FailedPosting,
  type FoldHealth,
  type FoldedPosting,
  type RebuildMismatch,
} from "./folds.js";

export {
  EVALUATION_HEARTBEAT_MS,
  EVALUATION_INTERVAL_MS,
  EvaluationCadenceClock,
  FORWARD_JUMP_ALARM_FALLBACK_MS,
  PAPER_EVALUATION_CADENCE,
  PER_FRAME_EVALUATION_CADENCE,
  evaluationCadenceProblem,
  type CadenceAlarm,
  type CadenceObservation,
  type EvaluationCadenceOption,
  type EvaluationCadenceSettings,
} from "./cadence.js";

export {
  CancelLedger,
  type CancelLedgerMetrics,
  type CancelResolution,
  type PendingCancel,
  type ResolvedCancel,
} from "./cancels.js";

export {
  ReservationBook,
  type OutcomeSide,
  type ReservationMetrics,
  type ShareReservation,
} from "./reservations.js";

export {
  InstanceRegistry,
  compareInstances,
  windowRegistrationKey,
  type InstanceRegistration,
  type ManifestRow,
  type Ownership,
  type RegisterResult,
  type RegisteredInstance,
  type RegistrationIdentity,
} from "./instances.js";

export { classifyBookRefusal, type BookRefusalClass, type BookRefusalCounts } from "./book-refusals.js";

export {
  MarketState,
  type ActiveIncident,
  type MarketLifecycle,
  type ObservedTradeRecord,
} from "./market-state.js";

export {
  DeterministicIdFactory,
  postFill,
  projectionOf,
  type FillClaim,
  type PostFillOutcome,
  type PostingIdentity,
  type TraceLink,
} from "./accounting.js";

export {
  ORDER_TYPE_TAG_PREFIX,
  PROTECTIVE_EXIT_TAGS,
  buildPlanningInputs,
  buildRiskEvaluationInput,
  isProtectiveExitIntent,
  resolveTimeInForce,
  runPlanner,
  runRiskCheck,
  type PortfolioOpenOrderInput,
  type PortfolioPositionInput,
  type RiskInputContext,
} from "./pipeline.js";

export {
  CoreLoop,
  DecisionOutboxBuffer,
  type AccountingRebuildCheck,
  type CoreLoopOptions,
  type DecisionTrace,
  type LoopHealthSnapshot,
  type OutboxEntry,
  type RetainedOrderState,
  type TraderVenue,
} from "./loop.js";

export {
  ReferenceState,
  type ReferencePoint,
  type ReferenceVenueName,
} from "./reference-state.js";

export {
  createPaperTrader,
  type CreateTraderOptions,
  type CreateTraderResult,
  type PaperTrader,
  type TraderRefusal,
} from "./trader.js";

export { createExecutionPolicy, type VenueWiring } from "./venue-policy.js";

export { unreplacedPnlSnapshotProblem } from "./pnl-snapshot-key.js";

export {
  UNMODELED_VENUE_RATE_LIMITS_DISCLOSURE,
  buildSimulatedVenue,
  type SimulatedVenueBuild,
  type SimulatedVenueBuildOptions,
  type SimulatedVenueSettings,
} from "./venue-builder.js";

export {
  IN_MEMORY_DUPLICATE_PNL_SNAPSHOT_DETAIL,
  IN_MEMORY_MISSING_PNL_SNAPSHOT_DETAIL,
  IN_MEMORY_STORE_CLOSED_DETAIL,
  InMemoryTraderStore,
  type RecordedDecision,
} from "./memory-store.js";
