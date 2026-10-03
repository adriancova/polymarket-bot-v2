-- Rollback of migration 0010 (CADENCE-1): exactly the reverse of the up file.
--
-- The pinning trigger is re-created with migration 0004's column list, the
-- three checks are dropped, and the two columns are dropped — with whatever
-- they recorded. A database that holds runs recorded under ADR-026 loses
-- those runs' pinned cadence on rollback; that is the cost of rolling back a
-- column, and an operator rolling back such a database decides it explicitly.

drop trigger runs_immutable_pinning on strategy.runs;

create trigger runs_immutable_pinning
  before update on strategy.runs
  for each row execute function internal.forbid_column_change(
    'run_id', 'instance_id', 'definition_id', 'config_id', 'environment',
    'code_commit', 'feature_set_id', 'dataset_manifest_id', 'model_version',
    'state_schema_version', 'simulator_version', 'run_seed', 'started_at'
  );

alter table strategy.runs
  drop constraint runs_evaluation_cadence_per_frame_has_no_heartbeat,
  drop constraint runs_evaluation_cadence_non_negative,
  drop constraint runs_evaluation_cadence_both_or_neither;

alter table strategy.runs
  drop column evaluation_heartbeat_ms,
  drop column evaluation_interval_ms;
