/**
 * `strategy` schema table types (handoff §10.3).
 *
 * Mirrors `db/migrations/0004_strategy.up.sql`.
 */

import type {
  AppendOnlyTable,
  BigIntColumn,
  Code,
  DecimalString,
  Detail,
  Identifier,
  DecimalSafeJsonColumn,
  JsonColumn,
  NullableDecimalSafeJsonColumn,
  NullableJsonColumn,
  Sha256Hex,
  TextArrayColumnWithDefault,
  TimestampColumn,
  TimestampColumnWithDefault,
  UnsignedIntegerString,
  Uuid,
  UuidV7Column,
  WithDefault,
} from "./columns.js";
import type {
  DecisionTypeValue,
  InstanceStatusValue,
  IntentTypeValue,
  OwnershipModeValue,
  OwnershipStatusValue,
  RiskOutcomeValue,
  RunModeValue,
  RunStatusValue,
  StrategyCallbackValue,
} from "./enums.js";

/** §10.3 `definitions` — strategy name, code version, schemas. */
export type StrategyDefinitionsTable = AppendOnlyTable<{
  definition_id: WithDefault<UuidV7Column>;
  strategy_name: Code;
  code_version: Identifier;
  params_schema: JsonColumn;
  state_schema_version: number;
  decision_contract_version: number;
  description: Detail | null;
  created_at: TimestampColumnWithDefault;
}>;

/** §10.3 `configs` — immutable validated configuration versions (§10.7). */
export type StrategyConfigsTable = AppendOnlyTable<{
  config_id: WithDefault<UuidV7Column>;
  definition_id: UuidV7Column;
  config_version: number;
  /** Strategy parameters may be economic; decimal strings only (§6 invariant 1). */
  parameters: DecimalSafeJsonColumn;
  parameters_hash: Sha256Hex;
  validated_at: TimestampColumn;
  created_by: Identifier;
  created_at: TimestampColumnWithDefault;
}>;

/** §10.3 `instances` — named deployments and ownership rules. */
export type StrategyInstancesTable = {
  instance_id: WithDefault<UuidV7Column>;
  instance_name: Code;
  definition_id: UuidV7Column;
  config_id: UuidV7Column;
  series_id: UuidV7Column | null;
  /** §10.8 environment discriminator. */
  environment: RunModeValue;
  account_ref: Identifier | null;
  default_ownership_mode: WithDefault<OwnershipModeValue>;
  /** §8.2 stable evaluation order. */
  evaluation_priority: WithDefault<number>;
  status: WithDefault<InstanceStatusValue>;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §6 invariant 11 / ADR-011: one active live owner per market per realm. */
export type StrategyMarketOwnershipTable = {
  market_ownership_id: WithDefault<UuidV7Column>;
  market_id: UuidV7Column;
  instance_id: UuidV7Column;
  environment: RunModeValue;
  ownership_mode: OwnershipModeValue;
  status: WithDefault<OwnershipStatusValue>;
  acquired_at: TimestampColumnWithDefault;
  released_at: TimestampColumn | null;
  released_reason: Detail | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.3 `runs` — code/config/data/model/environment pinning (§12.4). */
export type StrategyRunsTable = {
  run_id: WithDefault<UuidV7Column>;
  instance_id: UuidV7Column;
  definition_id: UuidV7Column;
  config_id: UuidV7Column;
  environment: RunModeValue;
  code_commit: Identifier;
  feature_set_id: UuidV7Column | null;
  dataset_manifest_id: UuidV7Column | null;
  model_version: Identifier | null;
  state_schema_version: number;
  simulator_version: Identifier | null;
  run_seed: UnsignedIntegerString;
  /**
   * `CADENCE-1` (migration 0010; ADR-026 D1.1): the run's
   * `evaluationIntervalMs`. NULL only for a run recorded before migration
   * 0010, under ADR-024's per-frame cadence. Immutable (`runs_immutable_pinning`).
   */
  evaluation_interval_ms: number | null;
  /**
   * `CADENCE-1` (migration 0010; ADR-026 D1.2): the run's
   * `evaluationHeartbeatMs`. NULL exactly when `evaluation_interval_ms` is;
   * 0 exactly when it is 0. Immutable (`runs_immutable_pinning`).
   */
  evaluation_heartbeat_ms: number | null;
  status: WithDefault<RunStatusValue>;
  started_at: TimestampColumnWithDefault;
  ended_at: TimestampColumn | null;
  stop_reason: Detail | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.3 `state_checkpoints` — versioned strategy state. */
export type StrategyStateCheckpointsTable = AppendOnlyTable<{
  state_checkpoint_id: WithDefault<UuidV7Column>;
  run_id: UuidV7Column;
  instance_id: UuidV7Column;
  market_id: UuidV7Column | null;
  checkpoint_seq: BigIntColumn;
  state_schema_version: number;
  state: JsonColumn;
  state_hash: Sha256Hex;
  captured_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/**
 * §10.3 `decisions` — one record per strategy evaluation.
 *
 * §6 invariant 3: "Every strategy callback produces exactly one persisted
 * `DecisionResult`." The unique `(run_id, evaluation_seq)` key is what makes
 * "exactly one" checkable.
 */
export type StrategyDecisionsTable = AppendOnlyTable<{
  decision_id: WithDefault<UuidV7Column>;
  run_id: UuidV7Column;
  instance_id: UuidV7Column;
  market_id: UuidV7Column | null;
  evaluation_seq: BigIntColumn;
  callback: StrategyCallbackValue;
  decision_type: DecisionTypeValue;
  decision_contract_version: number;
  reason_codes: TextArrayColumnWithDefault<Code>;
  feature_snapshot_ref: Identifier;
  feature_snapshot_id: UuidV7Column | null;
  /**
   * §7.5 / ADR-005: `Record<string, DecimalString | string | boolean | null>`.
   * A model output is an edge, a probability, or a fair value — the inputs to
   * sizing and to the risk thresholds — so a JavaScript number here is a
   * rounding error with a downstream order attached. The database rejects one
   * too (`decisions_model_outputs_decimal_safe`).
   */
  model_outputs: NullableDecimalSafeJsonColumn;
  state_patch: NullableJsonColumn;
  next_wakeup_at: TimestampColumn | null;
  source_event_id: Uuid | null;
  gateway_epoch: Uuid | null;
  ingest_seq: UnsignedIntegerString | null;
  intent_count: WithDefault<number>;
  evaluation_duration_us: BigIntColumn | null;
  evaluated_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.3 `intents` — original strategy intents (§7.7). */
export type StrategyIntentsTable = AppendOnlyTable<{
  intent_id: WithDefault<UuidV7Column>;
  decision_id: UuidV7Column;
  run_id: UuidV7Column;
  instance_id: UuidV7Column;
  market_id: UuidV7Column;
  intent_ordinal: number;
  intent_type: IntentTypeValue;
  contract_version: number;
  /** The §7.7 intent document; its economic fields are decimal strings. */
  payload: DecimalSafeJsonColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.3 `approved_intents` — risk-approved/resized variants (§9.8). */
export type StrategyApprovedIntentsTable = AppendOnlyTable<{
  approved_intent_id: WithDefault<UuidV7Column>;
  intent_id: UuidV7Column;
  revision: WithDefault<number>;
  risk_outcome: RiskOutcomeValue;
  /** The risk-approved intent document; economic fields are decimal strings. */
  approved_payload: DecimalSafeJsonColumn;
  resize_reason: Detail | null;
  approved_shares: DecimalString | null;
  approved_at: TimestampColumnWithDefault;
  recorded_at: TimestampColumnWithDefault;
}>;

/** Every `strategy` table, keyed by its qualified name. */
export type StrategySchema = {
  "strategy.definitions": StrategyDefinitionsTable;
  "strategy.configs": StrategyConfigsTable;
  "strategy.instances": StrategyInstancesTable;
  "strategy.market_ownership": StrategyMarketOwnershipTable;
  "strategy.runs": StrategyRunsTable;
  "strategy.state_checkpoints": StrategyStateCheckpointsTable;
  "strategy.decisions": StrategyDecisionsTable;
  "strategy.intents": StrategyIntentsTable;
  "strategy.approved_intents": StrategyApprovedIntentsTable;
};
