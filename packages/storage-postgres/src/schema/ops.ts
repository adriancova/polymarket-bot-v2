/**
 * `ops` schema table types (handoff §10.6).
 *
 * Mirrors `db/migrations/0007_ops.up.sql`.
 */

import type {
  AppendOnlyTable,
  BigIntColumn,
  Code,
  DecimalString,
  Detail,
  Identifier,
  JsonColumn,
  NullableJsonColumn,
  TimestampColumn,
  TimestampColumnWithDefault,
  UuidV7Column,
  WithDefault,
} from "./columns.js";
import type {
  ActorKindValue,
  BreakStatusValue,
  IncidentActionValue,
  IncidentSeverityValue,
  IncidentStatusValue,
  KillSwitchActionValue,
  KillSwitchScopeValue,
  LeaseStatusValue,
  ReconciliationStatusValue,
  ReconciliationTriggerValue,
  RiskOutcomeValue,
  RunModeValue,
} from "./enums.js";

/**
 * §10.6 `fencing_leases` — active live-writer lease and token (§9.18, ADR-008).
 *
 * The token is monotonic and never reused, so a late write from a previous
 * holder is detectable rather than merely improbable.
 */
export type OpsFencingLeasesTable = {
  fencing_lease_id: WithDefault<UuidV7Column>;
  account_ref: Identifier;
  environment: RunModeValue;
  fencing_token: BigIntColumn;
  holder_id: Identifier;
  holder_hostname: Identifier | null;
  holder_pid: number | null;
  status: WithDefault<LeaseStatusValue>;
  /** ADR-008 §4: the venue heartbeat id rotates and belongs to the lease. */
  heartbeat_id: string | null;
  last_heartbeat_at: TimestampColumn | null;
  acquired_at: TimestampColumnWithDefault;
  expires_at: TimestampColumn;
  released_at: TimestampColumn | null;
  revoked_reason: Detail | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.6 `risk_events` — vetoes, breakers, exposure violations (§9.8). */
export type OpsRiskEventsTable = AppendOnlyTable<{
  risk_event_id: WithDefault<UuidV7Column>;
  environment: RunModeValue;
  account_ref: Identifier | null;
  run_id: UuidV7Column | null;
  instance_id: UuidV7Column | null;
  market_id: UuidV7Column | null;
  intent_id: UuidV7Column | null;
  check_code: Code;
  outcome: RiskOutcomeValue;
  reason_code: Code;
  measures: NullableJsonColumn;
  detail: Detail | null;
  occurred_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.6 `incidents` — operational incident lifecycle (§9.9). */
export type OpsIncidentsTable = {
  incident_id: WithDefault<UuidV7Column>;
  incident_key: Code;
  environment: RunModeValue;
  account_ref: Identifier | null;
  severity: IncidentSeverityValue;
  status: WithDefault<IncidentStatusValue>;
  failure_class: Code;
  action: IncidentActionValue | null;
  market_id: UuidV7Column | null;
  instance_id: UuidV7Column | null;
  data_quality_incident_id: UuidV7Column | null;
  detail: Detail;
  resolution: Detail | null;
  opened_at: TimestampColumnWithDefault;
  acknowledged_at: TimestampColumn | null;
  resolved_at: TimestampColumn | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.6 `reconciliation_runs` — reconciliation attempts (§9.17). */
export type OpsReconciliationRunsTable = {
  reconciliation_run_id: WithDefault<UuidV7Column>;
  environment: RunModeValue;
  account_ref: Identifier;
  trigger_reason: ReconciliationTriggerValue;
  status: WithDefault<ReconciliationStatusValue>;
  orders_checked: WithDefault<number>;
  fills_checked: WithDefault<number>;
  wallet_operations_checked: WithDefault<number>;
  breaks_found: WithDefault<number>;
  started_at: TimestampColumnWithDefault;
  completed_at: TimestampColumn | null;
  detail: Detail | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.6 `reconciliation_breaks` — individual mismatches (§9.17). */
export type OpsReconciliationBreaksTable = {
  reconciliation_break_id: WithDefault<UuidV7Column>;
  reconciliation_run_id: UuidV7Column;
  break_type: Code;
  status: WithDefault<BreakStatusValue>;
  market_id: UuidV7Column | null;
  order_id: UuidV7Column | null;
  fill_id: UuidV7Column | null;
  wallet_operation_id: UuidV7Column | null;
  asset_id: Identifier | null;
  expected_value: DecimalString | null;
  observed_value: DecimalString | null;
  resolution_ledger_transaction_id: UuidV7Column | null;
  detail: Detail;
  opened_at: TimestampColumnWithDefault;
  resolved_at: TimestampColumn | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.6 `kill_switch_events` — append-only audited control actions (§14.1). */
export type OpsKillSwitchEventsTable = AppendOnlyTable<{
  kill_switch_event_id: WithDefault<UuidV7Column>;
  scope: KillSwitchScopeValue;
  scope_ref: Identifier | null;
  action: KillSwitchActionValue;
  environment: RunModeValue;
  actor: Identifier;
  actor_kind: ActorKindValue;
  reason: Detail;
  prior_state: JsonColumn;
  resulting_state: JsonColumn;
  incident_id: UuidV7Column | null;
  occurred_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.6 `config_change_audit` — human and automated changes. */
export type OpsConfigChangeAuditTable = AppendOnlyTable<{
  config_change_id: WithDefault<UuidV7Column>;
  actor: Identifier;
  actor_kind: ActorKindValue;
  change_kind: Code;
  target_schema: Code;
  target_table: Code;
  target_id: Identifier | null;
  previous_value: NullableJsonColumn;
  new_value: NullableJsonColumn;
  reason: Detail;
  environment: RunModeValue | null;
  occurred_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.6 `health_snapshots` — sampled subsystem health (§9.18). */
export type OpsHealthSnapshotsTable = AppendOnlyTable<{
  health_snapshot_id: WithDefault<UuidV7Column>;
  subsystem: Code;
  environment: RunModeValue;
  account_ref: Identifier | null;
  holder_id: Identifier | null;
  fencing_lease_id: UuidV7Column | null;
  healthy: boolean;
  age_ms: number | null;
  detail: Detail | null;
  metrics: NullableJsonColumn;
  checked_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** Every `ops` table, keyed by its qualified name. */
export type OpsSchema = {
  "ops.fencing_leases": OpsFencingLeasesTable;
  "ops.risk_events": OpsRiskEventsTable;
  "ops.incidents": OpsIncidentsTable;
  "ops.reconciliation_runs": OpsReconciliationRunsTable;
  "ops.reconciliation_breaks": OpsReconciliationBreaksTable;
  "ops.kill_switch_events": OpsKillSwitchEventsTable;
  "ops.config_change_audit": OpsConfigChangeAuditTable;
  "ops.health_snapshots": OpsHealthSnapshotsTable;
};
