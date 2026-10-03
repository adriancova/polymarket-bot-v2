-- CADENCE-1 / migration 0010 — the ADR-026 evaluation cadence, pinned in the
-- run record.
--
-- THE RECORD THIS IMPLEMENTS (nothing here is invented):
--
--   * ADR-026 D1.3-D1.4: `evaluationIntervalMs` and `evaluationHeartbeatMs` are
--     run settings, "pinned in the run record of every run, on live data or in
--     replay. A change to either starts a new run (§9.6)." The run record is
--     the run's `strategy.runs` row, and "Today neither has a field for these
--     settings."
--   * `IMPLEMENTATION_STATUS.md` (2026-10-03, the `CADENCE-1` grants, Q1): the
--     orchestrator granted this additive migration on the `WP-210` precedent:
--     two nullable columns, NULL meaning a run recorded under ADR-024; both or
--     neither; both >= 0; (interval = 0) = (heartbeat = 0); both added to
--     `runs_immutable_pinning`.
--
-- WHAT THE DATABASE DOES NOT DECIDE. The policy — a PAPER run on live data, and
-- every replay that is not a reproduction, uses exactly 1000 ms and 5000 ms;
-- 0 only for a reproduction (ADR-026 D1.5-D1.6) — stays in the application
-- (`apps/trader` `verifyRegisteredRows` and `packages/trading-core`
-- `evaluationCadenceProblem`), because a row cannot say whether its run
-- reproduces anything. These checks hold only what is true of every run.
--
-- NULL is a run started before this migration: ADR-024's per-frame cadence,
-- which had no setting to record. A new run always records both values
-- (`StartRunInput` requires them). A PAPER trader refuses a NULL row.
--
-- NO VENUE FACT IS ASSERTED HERE.

alter table strategy.runs
  add column evaluation_interval_ms integer,
  add column evaluation_heartbeat_ms integer;

alter table strategy.runs
  add constraint runs_evaluation_cadence_both_or_neither check (
    (evaluation_interval_ms is null) = (evaluation_heartbeat_ms is null)
  ),
  add constraint runs_evaluation_cadence_non_negative check (
    evaluation_interval_ms >= 0 and evaluation_heartbeat_ms >= 0
  ),
  -- 0 is ADR-024's per-frame cadence, which has no heartbeat (ADR-026 D1.6).
  add constraint runs_evaluation_cadence_per_frame_has_no_heartbeat check (
    (evaluation_interval_ms = 0) = (evaluation_heartbeat_ms = 0)
  );

-- §9.6: "Start a new run for every code, config, model, feature, or
-- state-schema change" — and ADR-026 D1.3: a change to either setting starts a
-- new run. The pinning trigger is re-created with the two columns added; its
-- earlier column list (migration 0004) is unchanged and in the same order.
drop trigger runs_immutable_pinning on strategy.runs;

create trigger runs_immutable_pinning
  before update on strategy.runs
  for each row execute function internal.forbid_column_change(
    'run_id', 'instance_id', 'definition_id', 'config_id', 'environment',
    'code_commit', 'feature_set_id', 'dataset_manifest_id', 'model_version',
    'state_schema_version', 'simulator_version', 'run_seed', 'started_at',
    'evaluation_interval_ms', 'evaluation_heartbeat_ms'
  );

comment on column strategy.runs.evaluation_interval_ms is
  'ADR-026 D1.1: the shortest event-time gap, in ms, between two onFeatures evaluations of one market. 1000 for every live-data run; 0 (ADR-024''s per-frame cadence) only for a reproduction; NULL for a run recorded under ADR-024, before this column existed.';

comment on column strategy.runs.evaluation_heartbeat_ms is
  'ADR-026 D1.2: the longest event-time gap, in ms, after which a market is evaluated although no event touched it. 5000 for every live-data run; 0 (no heartbeat) only with evaluation_interval_ms 0; NULL for a run recorded under ADR-024.';
