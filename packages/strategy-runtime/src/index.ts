/**
 * @polymarket-bot/strategy-runtime — the deterministic strategy runtime
 * (WP-170; handoff §9.6, §7.5, §7.6; ADR-005).
 *
 * Layer-1 application module (`docs/contracts/dependency-direction.md` §2):
 * pure logic over the frozen domain contracts and the strategy SDK (the §2.1
 * S1 edge). It owns NO connection — persistence is expressed as the pure
 * `DecisionSink` / `CheckpointStore` ports the composition root implements
 * (see `ports.ts` for the §9.6/F12 justification). No network, no database,
 * no filesystem, no wall clock, no ambient randomness anywhere in this
 * package.
 */

export {
  createStrategyInstanceRuntime,
  type CreateRuntimeResult,
  type RunIdentity,
  type StrategyInstanceRuntime,
  type StrategyRuntimeDefinition,
  type WatchdogPolicy,
} from "./runtime.js";

export type {
  AcquireEvaluationInputResult,
  EvaluationInput,
  EvaluationViews,
  InputValidationResult,
} from "./input.js";
export { acquireEvaluationInput, validateEvaluationInput } from "./input.js";

export type {
  ContainedFailure,
  EvaluationOutcome,
  EvaluationRefusal,
  EvaluationRefusalCode,
  IncidentReport,
  RuntimeCreationRefusal,
  RuntimeCreationRefusalCode,
  StrategyContextCapability,
} from "./outcomes.js";

export { STRATEGY_CONTEXT_REVOKED, StrategyContextRevokedError } from "./outcomes.js";

export type { CheckpointStore, DecisionSink, MonotonicClock } from "./ports.js";

export type {
  DecisionAttribution,
  DecisionRecord,
  DecisionTelemetry,
} from "./record.js";

export {
  MAX_EVALUATION_SEQ,
  rebuildStateFromPatches,
  restoreCheckpoint,
  restoreFromPoint,
  STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
  type CheckpointIdentity,
  type CheckpointRefusal,
  type CheckpointRefusalCode,
  type InstanceStatus,
  type RebuildStateResult,
  type RestoreCheckpointResult,
  type RestoredCheckpoint,
  type RestoredInstance,
  type RestoreFromPointResult,
  type StrategyRestorePoint,
  type StrategyStateCheckpoint,
} from "./checkpoint.js";

/**
 * `CKPT-1` — ADR-027 Decision 1, the checkpoint transition rule (pure). The
 * exact instant arithmetic behind its heartbeat stays package-internal.
 */
export {
  CHECKPOINT_HEARTBEAT_MS,
  checkpointTransitions,
  type CheckpointCandidate,
  type CheckpointMark,
  type CheckpointTransition,
} from "./transitions.js";

export {
  isReservedRuntimeReasonCode,
  RESERVED_RUNTIME_REASON_CODE_PREFIX,
  RUNTIME_REASON_CODES,
  type ReservedRuntimeReasonCode,
} from "./reserved-codes.js";

/**
 * The checkpointable-state boundary. `checkpointableJsonProblem` was REMOVED in
 * remediation round 3 (review round 3's LOW): a public validate-then-retain
 * predicate invites exactly the workflow that produced round 2's HIGH — validate
 * a Proxy, keep the Proxy — and after `restoreCheckpoint` was fixed to keep the
 * materialized copy, no internal caller was left to justify it. Validate by
 * materializing and keeping the returned copy.
 *
 * `materializeCheckpointableJson` takes the VALUE only. Its diagnostic `path`
 * argument became package-internal in remediation round 4 (review round 4's
 * MEDIUM 1): a caller-supplied path is not part of the value contract, and
 * interpolating one into a refusal made a function that promises never to throw
 * throw on `Symbol()` and on an object whose `toString` throws. The pathed
 * forms the runtime uses internally are deliberately not re-exported.
 */
export {
  canonicalJsonStringify,
  deepFreeze,
  materializeCheckpointableJson,
  MAX_MATERIALIZED_DEPTH,
  // `THROUGHPUT-1a`: additive, performance-only (see `json.ts`).
  prepareEvaluationView,
  type CheckpointableJson,
  type MaterializeCheckpointableJsonResult,
} from "./json.js";

export { DeterministicRng, isRngState, type RngState } from "./rng.js";

/**
 * `ROLLOVER-1` (ADR-030 Decision 4; the user's ruling Q2): the run-scoped
 * evaluation sequence every runtime of one run shares.
 */
export {
  createRunEvaluationSequence,
  isRunEvaluationSequence,
  RunEvaluationSequence,
  runEvaluationSequenceAfter,
  type CreateRunEvaluationSequenceResult,
  type RunEvaluationSequenceRefusal,
} from "./sequence.js";
