/**
 * `@polymarket-bot/trader` — the paper trader (`WP-230`).
 *
 * The layer-3 composition root of handoff §4.1's `apps/trader`: it "owns the
 * live deterministic event loop… books, features, strategies, risk, OMS, user
 * stream, heartbeat, reconciliation, ledger projections". This process
 * implements the PAPER half of that — live data, SIMULATED execution (§11) —
 * by assembling the already-merged packages behind the §12.1 ports, so the live
 * execution adapter that arrives later replaces one implementation and leaves
 * the whole loop above it unchanged.
 *
 * ## What it assembles
 *
 * | Layer | Package | Role |
 * | --- | --- | --- |
 * | books | `@polymarket-bot/order-book` | §9.4 per-outcome-token reconstruction |
 * | features | `@polymarket-bot/features` | §9.5 versioned, content-addressed snapshots |
 * | strategy | `@polymarket-bot/strategy-runtime` + `@polymarket-bot/strategy-static-bracket` | §9.6 one persisted decision per callback |
 * | allocation | `@polymarket-bot/capital-allocator` | §9.7 commitments and caps — `allocation.ts` asks it for a verdict before every risk check |
 * | risk | `@polymarket-bot/risk` | §9.8 twenty pre-trade checks |
 * | planning | `@polymarket-bot/execution-planner` | §9.10 immutable execution plans |
 * | venue | `@polymarket-bot/simulation` | §12.1 `ExecutionVenue`, simulated |
 * | accounting | `@polymarket-bot/ledger` + `@polymarket-bot/pnl` | §9.15 / §9.16 |
 *
 * ## Safety
 *
 * `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false` and both live-micro caps at
 * `0` are untouched by this process and ENFORCED by it: `safety.ts` refuses to
 * start under a raised ceiling, under a run mode that would place a real order,
 * or in an environment that references a production secret name (§15, ADR-010
 * §3). There is no signer, no credential, no venue connection and no real-order
 * path anywhere in this app, and none is representable in its types — the only
 * `ExecutionVenue` it can be handed is `packages/simulation`'s, which refuses
 * `EXECUTION_PROBE`, `LIVE_MICRO` and `LIVE` by name.
 *
 * A paper fill is NOT evidence about real fill quality (ADR-012 §2, §12.2), and
 * nothing in this process claims otherwise: every fill it observes carries
 * `evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"` from the venue that produced
 * it.
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
} from "@polymarket-bot/trading-core";

export {
  TraderConfigSchema,
  configuredFeatureKeys,
  parseTraderConfig,
  type ConfigRefusal,
  type InstanceConfig,
  type MarketConfig,
  type ParseConfigResult,
  type TraderConfig,
} from "@polymarket-bot/trading-core";

// `ROLLOVER-1` (ADR-030): the trader's series admissions — its copy of the
// reviewed-series rules, the re-judge, and the notices `main.ts` logs.
export {
  ReviewedSeriesSchema,
  SeriesWindowAdmissions,
  admissionRunModeProblem,
  canonicalSeriesJson,
  configuredSeries,
  deriveWindowSchedule,
  seriesConfigHash,
  windowInternalMarketId,
  type AdmissionNotice,
  type AdmissionRefusalCode,
  type AdmittedMarketRegistered,
  type AdmittedMarketRegistration,
  type AdmittedWindow,
  type ConfiguredSeries,
  type ReviewedSeries,
  type SeriesInstanceConfig,
} from "@polymarket-bot/trading-core";

export {
  CONSUMED_EVENTS,
  readEventEnvelope,
  type EventDoorRefusal,
  type EventDoorRefusalCode,
  type ReadEventResult,
} from "@polymarket-bot/trading-core";

export {
  formatStrictUtc,
  isStrictUtcInstant,
  normalizeToStrictUtc,
  strictUtcEpochMs,
  type NormalizeInstantResult,
} from "@polymarket-bot/trading-core";

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
} from "@polymarket-bot/trading-core";

export { BoundedQueue, type OfferOutcome, type QueueMetrics } from "@polymarket-bot/trading-core";

// `THROUGHPUT-2` (ADR-024): what one venue frame is, for the process's feeds and harnesses.
export { frameKeyOf, sameFrame, type FrameKey } from "@polymarket-bot/trading-core";

export {
  HaltController,
  haltOnLedgerProjection,
  type HaltRecord,
  type HaltReasonCode,
  type HaltScope,
} from "@polymarket-bot/trading-core";

export {
  HealthState,
  RISK_SEAM_CAVEAT,
  RealizedPnlBook,
  type AccountingCounters,
  type AccountingHealth,
  type ExecutionHealth,
  type HealthSnapshot,
  type LoopHealth,
  type RealizedPnlHealth,
  type RealizedPnlObservation,
  type RiskHealth,
  type SeamHealth,
  type TransportHealth,
  type TransportHealthSource,
  unattachedTransportHealth,
} from "@polymarket-bot/trading-core";

export {
  TRADER_HEALTH_BOUNDS,
  TRADER_HEALTH_LOOPBACK_HOSTS,
  TRADER_HEALTH_PATH,
  classifyHealthFailure,
  healthResponseBody,
  readHealthServerEnv,
  startTraderHealthServer,
  type HealthListen,
  type HealthServerEnvResult,
  type HealthServerRefusal,
  type HealthServerRefusalCode,
  type RunningTraderHealthServer,
  type TraderHealthServerOptions,
} from "./health-server.js";

export { observeRealizedPnl } from "./pnl-observation.js";

export {
  AllocatorGate,
  CostBasisBook,
  allocationMarketOf,
  intentLegs,
  requestFor,
  type AllocationCoverage,
  type AllocationMarket,
  type AllocationOutcome,
  type AllocationVerdict,
  type AllocatorMetrics,
  type IntentLeg,
} from "@polymarket-bot/trading-core";

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
  type FeedMark,
  type GroupCommit,
  type StagedEvaluations,
  type DispatchPosition,
  type RiskRefusalRecord,
} from "@polymarket-bot/trading-core";

// `CADENCE-1` (ADR-026): the evaluation cadence the core runs, for the
// harnesses that import the core through this package.
export {
  EVALUATION_HEARTBEAT_MS,
  EVALUATION_INTERVAL_MS,
  PAPER_EVALUATION_CADENCE,
  PER_FRAME_EVALUATION_CADENCE,
  evaluationCadenceProblem,
  type CadenceAlarm,
  type EvaluationCadenceOption,
  type EvaluationCadenceSettings,
} from "@polymarket-bot/trading-core";

export {
  FILLS_ARE_DELIVERED_WHILE_PAUSED,
  FillDeduplicator,
  type FillAdmission,
  type FillDeduplicatorMetrics,
  type IdentifiedFill,
} from "@polymarket-bot/trading-core";

export {
  OrderViewTracker,
  TERMINAL_STATUSES,
  isTerminalStatus,
  toStrategyOrderView,
  type OrderViewDelivery,
  type OrderViewMetrics,
} from "@polymarket-bot/trading-core";

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
} from "@polymarket-bot/trading-core";

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
} from "@polymarket-bot/trading-core";

export {
  CancelLedger,
  type CancelLedgerMetrics,
  type CancelResolution,
  type PendingCancel,
  type ResolvedCancel,
} from "@polymarket-bot/trading-core";

export {
  ReservationBook,
  type OutcomeSide,
  type ReservationMetrics,
  type ShareReservation,
} from "@polymarket-bot/trading-core";

export {
  InstanceRegistry,
  compareInstances,
  type ManifestRow,
  type Ownership,
  type RegisterResult,
  type RegisteredInstance,
} from "@polymarket-bot/trading-core";

export {
  MarketState,
  type ActiveIncident,
  type MarketLifecycle,
  type ObservedTradeRecord,
} from "@polymarket-bot/trading-core";

export {
  DeterministicIdFactory,
  postFill,
  projectionOf,
  type FillClaim,
  type PostFillOutcome,
  type PostingIdentity,
  type TraceLink,
} from "@polymarket-bot/trading-core";

export {
  ORDER_TYPE_TAG_PREFIX,
  OrderTimeInForceBook,
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
} from "@polymarket-bot/trading-core";

export {
  CoreLoop,
  DecisionOutboxBuffer,
  type AccountingRebuildCheck,
  type CoreLoopOptions,
  type DecisionTrace,
  type LoopHealthSnapshot,
  type RetainedOrderState,
  type TraderVenue,
} from "@polymarket-bot/trading-core";

export { pump, type PumpOptions, type PumpResult } from "./pump.js";
export {
  TRANSPORT_SAMPLE_INTERVAL_MS,
  TRANSPORT_SAMPLE_INTERVAL_RANGE,
  TransportLagSampler,
  sampleFromMetrics,
  transportHealthOf,
  type TransportLagSamplerOptions,
  type TransportMetricsReader,
} from "./transport-lag.js";

export {
  ReferenceState,
  type ReferencePoint,
  type ReferenceVenueName,
} from "@polymarket-bot/trading-core";

export {
  createPaperTrader,
  type CreateTraderOptions,
  type CreateTraderResult,
  type PaperTrader,
  type TraderRefusal,
} from "@polymarket-bot/trading-core";

/**
 * `BACKTEST-2` (ADR-022 D5): the ONE simulated-venue builder, re-exported so
 * the test harnesses that reach the core through this facade build the venue
 * `main.ts` builds, with no suite alias of their own.
 */
export {
  UNMODELED_VENUE_RATE_LIMITS_DISCLOSURE,
  buildSimulatedVenue,
  type SimulatedVenueBuild,
  type SimulatedVenueBuildOptions,
  type SimulatedVenueSettings,
} from "@polymarket-bot/trading-core";
