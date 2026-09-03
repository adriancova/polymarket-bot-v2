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

export type { EvaluationInput, EvaluationViews, InputValidationResult } from "./input.js";
export { validateEvaluationInput } from "./input.js";

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
  rebuildStateFromPatches,
  restoreCheckpoint,
  STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
  type CheckpointIdentity,
  type CheckpointRefusal,
  type CheckpointRefusalCode,
  type InstanceStatus,
  type RestoreCheckpointResult,
  type RestoredCheckpoint,
  type StrategyStateCheckpoint,
} from "./checkpoint.js";

export {
  isReservedRuntimeReasonCode,
  RESERVED_RUNTIME_REASON_CODE_PREFIX,
  RUNTIME_REASON_CODES,
  type ReservedRuntimeReasonCode,
} from "./reserved-codes.js";

export {
  canonicalJsonStringify,
  checkpointableJsonProblem,
  deepFreeze,
  materializeCheckpointableJson,
  type CheckpointableJson,
  type MaterializeCheckpointableJsonResult,
} from "./json.js";

export { DeterministicRng, isRngState, type RngState } from "./rng.js";
