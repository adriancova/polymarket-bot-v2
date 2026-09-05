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
 * | allocation | `@polymarket-bot/capital-allocator` | §9.7 commitments and caps |
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
} from "./safety.js";

export {
  TraderConfigSchema,
  configuredFeatureKeys,
  parseTraderConfig,
  type ConfigRefusal,
  type InstanceConfig,
  type MarketConfig,
  type ParseConfigResult,
  type TraderConfig,
} from "./config.js";

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

export {
  HaltController,
  haltOnLedgerProjection,
  type HaltRecord,
  type HaltReasonCode,
  type HaltRelease,
  type HaltScope,
} from "./halt.js";

export {
  HealthState,
  RISK_SEAM_CAVEAT,
  type AccountingHealth,
  type ExecutionHealth,
  type HealthSnapshot,
  type LoopHealth,
  type RiskHealth,
} from "./health.js";

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
} from "./orders.js";

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
  type ManifestRow,
  type Ownership,
  type RegisterResult,
  type RegisteredInstance,
} from "./instances.js";

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
} from "./pipeline.js";

export {
  CoreLoop,
  DecisionOutboxBuffer,
  type CoreLoopOptions,
  type DecisionTrace,
  type TraderVenue,
} from "./loop.js";

export { pump, type PumpOptions, type PumpResult } from "./pump.js";

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
