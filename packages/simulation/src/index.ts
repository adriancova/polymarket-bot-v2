/**
 * `@polymarket-bot/simulation` — WP-210.
 *
 * The replay clock, the dataset event source, the simulated execution venue, and
 * the Tier 0 / Tier 1 fill models with their optimistic / base / conservative
 * queue scenarios (handoff §8.4, §12; ADR-012).
 *
 * ## What this package is
 *
 * Pure layer-1 logic (`docs/contracts/dependency-direction.md` §2): it declares
 * exactly ONE workspace dependency, downward — `@polymarket-bot/decimal` — and
 * it imports **no Node built-in at all**. `zod` is therefore not in this
 * package's dependency closure in any form. Bytes, digests, books, ledgers,
 * plans and normalizers arrive through the structural ports in
 * {@link ./ports.js}, pinned to the real packages by root-level tests (the
 * WP-190 `ports.test.ts` precedent, which creates no workspace edge).
 *
 * ## Safety
 *
 * There is no venue network surface, no signer, no credential, and no real
 * order anywhere in this package, and none is representable in its types. The
 * simulated venue REFUSES `EXECUTION_PROBE`, `LIVE_MICRO` and `LIVE` by name
 * (§11 gives those a live signer). `MAX_RUN_MODE=PAPER`,
 * `ALLOW_REAL_ORDERS=false` and both live-micro caps at `0` are untouched by
 * anything here.
 *
 * ## The evidence rule
 *
 * ADR-012 §2 / §12.2: **paper fills do not count as evidence that the fill
 * simulator is correct**, Tier 0 is never used for deployment decisions, and a
 * Tier-1 resting result is a BAND. Every fill carries
 * `evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"`; every Tier-0 result carries
 * `deploymentDecisionUse: "FORBIDDEN"` and is refused at compile time by
 * {@link ./fill-model.js#quoteForDeploymentDecision}; and the only Tier-1
 * resting entry point returns a {@link ./queue.js#RestingFillBand}.
 *
 * ## Boundary discipline
 *
 * ADR-020 §3 / `docs/contracts/schema-boundary.md` §1: this package carries **no
 * runtime schema library**, and `zod` is absent from its whole dependency
 * closure (its one workspace dependency, `@polymarket-bot/decimal`, depends on
 * `decimal.js` and `node:crypto` only). Wire data is read by a hand-written strict-JSON
 * reader that materializes prototype-free as it parses (D1), is validated by
 * hand-written total predicates bound to the frozen domain schemas by a
 * root-level grammar cross-test, takes every value from the materialized tree
 * (D3), and emits prototype-free frozen records (D4). D2 (a severed, warmed
 * `_zod` arena) is not applicable because no library state exists to sever. See
 * `README.md` §2 for the conformance statement.
 */

// --- refusals and plain data ------------------------------------------------
export {
  SIMULATION_REFUSAL_CODES,
  defineData,
  describeForRefusal,
  isSimulationRefusalCode,
  ownDataDescriptor,
  ownDataDetails,
  plainRecord,
  simulationFailure,
  simulationOk,
  simulationRefusal,
  totally,
} from "./refusals.js";
export type {
  SimulationRefusal,
  SimulationRefusalCode,
  SimulationResult,
} from "./refusals.js";

export { MAX_INPUT_DEPTH, materializeInput, ownFrozenTree, ownPlainCopy } from "./plain.js";
export type { MaterializeProblem, MaterializedInput } from "./plain.js";

export {
  decodeUtf8Strict,
  encodeUtf8Strict,
  isJsonBigNumber,
  parseStrictJsonBytes,
  parseStrictJsonText,
} from "./strict-json.js";
export type { JsonBigNumber, StrictJsonOutcome, StrictJsonProblem } from "./strict-json.js";

// --- grammars ---------------------------------------------------------------
export {
  MAX_CODE_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_UNSIGNED_BIGINT_DIGITS,
  daysInMonth,
  isCanonicalUuid,
  isCanonicalUuidV7,
  isCodeString,
  isDecimalString,
  isIsoTimestamp,
  isMemberOf,
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  isSha256Hex,
  isTokenId,
  isUnsignedIntegerString,
  isoToEpochMilliseconds,
  readField,
  recordKeys,
} from "./grammar.js";

// --- clock ------------------------------------------------------------------
export {
  NANOSECONDS_PER_MILLISECOND,
  ReplayClock,
  addMilliseconds,
  addNanoseconds,
  createReplayClock,
} from "./clock.js";
export type { Clock, RecordedInstant, ReplayClockObservations } from "./clock.js";

// --- ports (§12.1) ----------------------------------------------------------
export {
  PLANNING_DEPTH_AWARENESS,
  PLAN_PRIORITY_RANK,
  SIMULATED_EVIDENCE_CLASS,
  SIMULATED_RUN_MODES,
  comparePlanPriority,
} from "./ports.js";
export type {
  AccountSnapshot,
  BookLevelView,
  BookView,
  CancelCommand,
  CancelPlanView,
  CancelResult,
  EventEnvelope,
  ExecutionGroupView,
  ExecutionPlanView,
  ExecutionResult,
  ExecutionVenue,
  FillFactView,
  MarketEventSource,
  NotPlacedOrder,
  PartialFillHandlingView,
  PlacementPlanView,
  PlanPriority,
  PlannedOrderView,
  PlanningDepthAwareness,
  RecordedEventIdentity,
  RestingFillBandLike,
  RunMode,
  SimulatedEvidenceClass,
  SimulatedFillLike,
  SimulatedOrder,
  SimulatedOrderState,
  SimulatedRunMode,
  TopOfBookView,
} from "./ports.js";

// --- dataset manifest (§8.4, §12.5) -----------------------------------------
export {
  SUPPORTED_DATASET_MANIFEST_FORMAT_ID,
  SUPPORTED_DATASET_MANIFEST_VERSION,
  SUPPORTED_PARQUET_LAYOUT_ID,
  SUPPORTED_WAL_FORMAT_ID,
  readDatasetManifestBytes,
  readDatasetManifestText,
  readRunPins,
  reconcileRunPins,
} from "./manifest.js";
export type {
  ReplayDataset,
  ReplayEventIdentity,
  ReplayExcludedWindow,
  ReplayManifestPins,
  ReplayObjectPin,
  ReplayRecordCounts,
  ReplayRunPins,
  ReplaySegmentPin,
} from "./manifest.js";

// --- dataset event source (§8.4, §12.1) -------------------------------------
export {
  DatasetEventSource,
  deriveReplayEventId,
  loadDataset,
  runEventSource,
} from "./event-source.js";
export type {
  ArchivedObject,
  DatasetArchiveReader,
  DatasetLoadReport,
  EventSourceReport,
  LoadDatasetOptions,
  LoadedDataset,
  NormalizeOutcome,
  RecordedFrame,
  ReplayNormalizer,
  ReplayRecord,
  Sha256HexDigest,
} from "./event-source.js";

// --- seeded randomness (§6 invariant 2, §12.4) ------------------------------
export { SEEDED_STREAM_LABELS, SeededStream, deriveStream, deriveStreams } from "./seed.js";
export type { SeededStreamLabel, SeededStreams } from "./seed.js";

// --- fees (§6 invariant 9, ADR-012 §5.4) ------------------------------------
export {
  FEE_ROUNDING_MODES,
  computeFee,
  readFeeScheduleSnapshot,
  readRoundingMode,
  roundDecimal,
  sumFees,
} from "./fees.js";
export type { FeeComputation, FeeRoundingMode, FeeScheduleSnapshot } from "./fees.js";

// --- fill models (§12.2, ADR-012) -------------------------------------------
export {
  consumeDepth,
  quoteForDeploymentDecision,
  simulatedFill,
  sizeAtPrice,
  toFillFact,
} from "./fill-model.js";
export type {
  DeploymentDecisionUse,
  DepthConsumption,
  FillModelIdentity,
  FillModelTier,
  MatchedLevel,
  PermittedUse,
  SimulatedFill,
} from "./fill-model.js";

export { tier0Immediate, tier0Maker, tier0Model } from "./tier0.js";
export type { Tier0ImmediateOutcome, Tier0MakerOutcome } from "./tier0.js";

export { GTD_EARLY_EXPIRY_MS, tier1Immediate, tier1Model } from "./tier1.js";
export type {
  DepthTimeline,
  MarketExecutionParameters,
  Tier1ImmediateOutcome,
  TimeInForce,
} from "./tier1.js";

export { readLatencyDistribution, readLatencyModel, sampleLatency, sampleLatencyMs } from "./latency.js";
export type { LatencyDistribution, LatencyModel, LatencySample, SampledLatency } from "./latency.js";

export {
  QUEUE_SCENARIOS,
  checkBandOrdering,
  readQueueModelParameters,
  readSameInstantAdditions,
  simulateResting,
} from "./queue.js";
export type {
  ObservedTrade,
  QueueModelParameters,
  QueueScenario,
  RestingFillBand,
  RestingOrderInput,
  RestingScenarioOutcome,
  SameInstantAdditions,
} from "./queue.js";

// --- markouts (§12.3, ADR-012 §3) -------------------------------------------
export {
  MARKOUT_HORIZONS,
  REPLAY_PATH_ECONOMICS_KEYS,
  computeMarkouts,
  markoutStressScenario,
  replayPathEconomics,
} from "./markout.js";
export type {
  MarkoutDiagnostics,
  MarkoutHorizon,
  MarkoutObservation,
  MarkoutStressScenario,
  MidTimeline,
  ReplayPathEconomics,
} from "./markout.js";

// --- rate limits (§9.13, ADR-012 §5.6) --------------------------------------
export { tokenBucketRateLimits, unmodeledRateLimits } from "./rate-limit.js";
export type { RateLimitBudget, RateLimitDecision, RateLimitRequest } from "./rate-limit.js";

// --- the simulated venue (§12.1) --------------------------------------------
export { DEFAULT_VENUE_RETENTION, SimulatedVenue } from "./venue.js";
export type {
  ExecutionPolicy,
  MarketBookProvider,
  SimulatedVenueOptions,
  VenueRetention,
  VenueRetentionBounds,
} from "./venue.js";
export type { EvictedIdFilterCounters, RetentionCounters } from "./retention.js";

// --- the run driver and its canonical serialization (§12.4) -----------------
export { runReplay } from "./replay.js";
export type {
  ReplayCoreLoop,
  ReplayEventContext,
  ReplayRunOptions,
  ReplayRunResult,
} from "./replay.js";

export { SIMULATION_RUN_SERIALIZATION_VERSION, serializeBand, serializeRun } from "./serialize.js";
export type { SerializableDelivery, SerializableRun } from "./serialize.js";
