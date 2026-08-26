-- WP-040 / migration 0007 — `ops` schema (handoff §10.6).
--
-- | Table | Purpose |
-- |---|---|
-- | risk_events           | Vetoes, breakers, exposure violations |
-- | incidents             | Operational incident lifecycle |
-- | reconciliation_runs   | Reconciliation attempts |
-- | reconciliation_breaks | Individual mismatches |
-- | kill_switch_events    | Global, market, or instance actions |
-- | config_change_audit   | Human and automated changes |
-- | fencing_leases        | Active live-writer lease and token |
-- | health_snapshots      | Optional sampled subsystem health |

create schema ops;

comment on schema ops is
  'Handoff §10.6: risk events, incidents, reconciliation, kill switches, config audit, fencing leases, health.';

-- ---------------------------------------------------------------------------
-- fencing_leases — active live-writer lease and token (§9.18, ADR-008)
-- ---------------------------------------------------------------------------
--
-- §9.18: "Redis is not sufficient as the only fence. Use a PostgreSQL advisory
-- lock or lease with a monotonic fencing token persisted with every live
-- submission." ADR-008 §1: "Monotonic means monotonic. A token is never reused,
-- never decremented, and is allocated by the same store that records live
-- orders, so a late write from a previous holder is detectable rather than
-- merely improbable."

create table ops.fencing_leases (
  fencing_lease_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  account_ref internal.identifier not null,
  environment internal.run_mode not null,
  fencing_token bigint not null,
  holder_id internal.identifier not null,
  holder_hostname internal.identifier,
  holder_pid integer,
  status internal.lease_status not null default 'ACTIVE',
  -- ADR-008 §4: the rotating venue heartbeat id is part of the lease state, so
  -- a failover can resume with it or bootstrap cleanly from empty.
  heartbeat_id text,
  last_heartbeat_at timestamptz,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  revoked_reason internal.detail,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fencing_leases_token_unique unique (account_ref, environment, fencing_token),
  -- Required by the composite foreign key that binds a live order to the exact
  -- lease *and* token that authorized it (migration 0008).
  constraint fencing_leases_id_token_unique unique (fencing_lease_id, fencing_token),
  constraint fencing_leases_token_positive check (fencing_token >= 1),
  constraint fencing_leases_expiry_after_acquisition check (expires_at > acquired_at),
  -- Any lease that is no longer ACTIVE records when it stopped being ACTIVE,
  -- whether it was released by its holder, revoked, or found expired by the
  -- process that took it over.
  constraint fencing_leases_terminal_consistent check (
    (status <> 'ACTIVE') = (released_at is not null)
  )
);

-- §2: "Exactly one fenced live order writer per account/signer."
create unique index fencing_leases_one_active_holder
  on ops.fencing_leases (account_ref, environment)
  where status = 'ACTIVE';

create index fencing_leases_account_token_idx
  on ops.fencing_leases (account_ref, environment, fencing_token desc);

create trigger fencing_leases_set_updated_at
  before update on ops.fencing_leases
  for each row execute function internal.set_updated_at();

-- The token, the account it fences, and the acquisition are facts about a
-- granted authority. Only the lease's own lifecycle and heartbeat state move.
create trigger fencing_leases_immutable_grant
  before update on ops.fencing_leases
  for each row execute function internal.forbid_column_change(
    'fencing_lease_id', 'account_ref', 'environment', 'fencing_token',
    'holder_id', 'acquired_at'
  );

create function ops.assert_fencing_token_monotonic() returns trigger
language plpgsql
as $$
declare
  highest_token bigint;
begin
  select max(l.fencing_token) into highest_token
  from ops.fencing_leases as l
  where l.account_ref = new.account_ref
    and l.environment = new.environment
    and l.fencing_lease_id <> new.fencing_lease_id;

  if highest_token is not null and new.fencing_token <= highest_token then
    raise exception
      using errcode = 'PMB07',
        message = format(
          'fencing token %s for account %s is not above the highest issued token %s',
          new.fencing_token, new.account_ref, highest_token
        ),
        hint = 'Fencing tokens are monotonic and never reused (§9.18, ADR-008 §1).';
  end if;

  return new;
end;
$$;

create trigger fencing_leases_monotonic_token
  before insert on ops.fencing_leases
  for each row execute function ops.assert_fencing_token_monotonic();

-- ---------------------------------------------------------------------------
-- risk_events — vetoes, breakers, exposure violations (§9.8)
-- ---------------------------------------------------------------------------

create table ops.risk_events (
  risk_event_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  environment internal.run_mode not null,
  account_ref internal.identifier,
  run_id internal.uuid_v7 references strategy.runs (run_id),
  instance_id internal.uuid_v7 references strategy.instances (instance_id),
  market_id internal.uuid_v7 references catalog.markets (market_id),
  intent_id internal.uuid_v7 references strategy.intents (intent_id),
  check_code internal.code not null,
  outcome internal.risk_outcome not null,
  reason_code internal.code not null,
  measures jsonb,
  detail internal.detail,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

create index risk_events_instance_idx on ops.risk_events (instance_id, occurred_at desc);
create index risk_events_reason_idx on ops.risk_events (reason_code, occurred_at desc);

call internal.enforce_append_only('ops', 'risk_events');

-- ---------------------------------------------------------------------------
-- incidents — operational incident lifecycle (§9.9)
-- ---------------------------------------------------------------------------

create table ops.incidents (
  incident_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  incident_key internal.code not null,
  environment internal.run_mode not null,
  account_ref internal.identifier,
  severity internal.incident_severity not null,
  status internal.incident_status not null default 'OPEN',
  failure_class internal.code not null,
  action internal.incident_action,
  market_id internal.uuid_v7 references catalog.markets (market_id),
  instance_id internal.uuid_v7 references strategy.instances (instance_id),
  data_quality_incident_id internal.uuid_v7
    references data.data_quality_incidents (data_quality_incident_id),
  detail internal.detail not null,
  resolution internal.detail,
  opened_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint incidents_resolution_consistent check (
    (status = 'RESOLVED') = (resolved_at is not null)
  ),
  constraint incidents_resolved_has_resolution check (
    status <> 'RESOLVED' or resolution is not null
  )
);

create index incidents_open_idx
  on ops.incidents (environment, severity, opened_at desc)
  where status <> 'RESOLVED';

create trigger incidents_set_updated_at
  before update on ops.incidents
  for each row execute function internal.set_updated_at();

-- ---------------------------------------------------------------------------
-- reconciliation_runs / reconciliation_breaks (§9.17)
-- ---------------------------------------------------------------------------

create table ops.reconciliation_runs (
  reconciliation_run_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  environment internal.run_mode not null,
  account_ref internal.identifier not null,
  trigger_reason internal.reconciliation_trigger not null,
  status internal.reconciliation_status not null default 'RUNNING',
  orders_checked integer not null default 0,
  fills_checked integer not null default 0,
  wallet_operations_checked integer not null default 0,
  breaks_found integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  detail internal.detail,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reconciliation_runs_completion_consistent check (
    (status = 'RUNNING') = (completed_at is null)
  ),
  constraint reconciliation_runs_counts_non_negative check (
    orders_checked >= 0 and fills_checked >= 0
    and wallet_operations_checked >= 0 and breaks_found >= 0
  )
);

create index reconciliation_runs_account_idx
  on ops.reconciliation_runs (account_ref, environment, started_at desc);

create trigger reconciliation_runs_set_updated_at
  before update on ops.reconciliation_runs
  for each row execute function internal.set_updated_at();

create table ops.reconciliation_breaks (
  reconciliation_break_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  reconciliation_run_id internal.uuid_v7 not null
    references ops.reconciliation_runs (reconciliation_run_id),
  break_type internal.code not null,
  status internal.break_status not null default 'OPEN',
  market_id internal.uuid_v7 references catalog.markets (market_id),
  order_id internal.uuid_v7 references execution.orders (order_id),
  fill_id internal.uuid_v7 references execution.fills (fill_id),
  wallet_operation_id internal.uuid_v7
    references accounting.wallet_operations (wallet_operation_id),
  asset_id internal.identifier,
  expected_value internal.decimal_string,
  observed_value internal.decimal_string,
  -- §9.17 step 7: resolve or quarantine. A resolution is a compensating ledger
  -- transaction, never an edit of history (ADR-006 §5.2).
  resolution_ledger_transaction_id internal.uuid_v7
    references accounting.ledger_transactions (ledger_transaction_id),
  detail internal.detail not null,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reconciliation_breaks_resolution_consistent check (
    (status = 'OPEN') = (resolved_at is null)
  )
);

create index reconciliation_breaks_open_idx
  on ops.reconciliation_breaks (status, opened_at desc)
  where status <> 'RESOLVED';

create trigger reconciliation_breaks_set_updated_at
  before update on ops.reconciliation_breaks
  for each row execute function internal.set_updated_at();

-- ---------------------------------------------------------------------------
-- kill_switch_events — append-only audited control actions (§14.1)
-- ---------------------------------------------------------------------------
--
-- "Every change is append-only audited with actor, reason, timestamp, prior
-- state, and resulting state." All five are NOT NULL for that reason.

create table ops.kill_switch_events (
  kill_switch_event_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  scope internal.kill_switch_scope not null,
  scope_ref internal.identifier,
  action internal.kill_switch_action not null,
  environment internal.run_mode not null,
  actor internal.identifier not null,
  actor_kind internal.actor_kind not null,
  reason internal.detail not null,
  prior_state jsonb not null,
  resulting_state jsonb not null,
  incident_id internal.uuid_v7 references ops.incidents (incident_id),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  -- A scoped switch must say what it is scoped to; a GLOBAL one must not.
  constraint kill_switch_events_scope_ref check ((scope = 'GLOBAL') = (scope_ref is null))
);

create index kill_switch_events_scope_idx
  on ops.kill_switch_events (scope, scope_ref, occurred_at desc);

call internal.enforce_append_only('ops', 'kill_switch_events');

-- ---------------------------------------------------------------------------
-- config_change_audit — human and automated changes
-- ---------------------------------------------------------------------------

create table ops.config_change_audit (
  config_change_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  actor internal.identifier not null,
  actor_kind internal.actor_kind not null,
  change_kind internal.code not null,
  target_schema internal.code not null,
  target_table internal.code not null,
  target_id internal.identifier,
  previous_value jsonb,
  new_value jsonb,
  reason internal.detail not null,
  environment internal.run_mode,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

create index config_change_audit_target_idx
  on ops.config_change_audit (target_schema, target_table, occurred_at desc);

call internal.enforce_append_only('ops', 'config_change_audit');

-- ---------------------------------------------------------------------------
-- health_snapshots — optional sampled subsystem health (§9.18)
-- ---------------------------------------------------------------------------
--
-- The health lease requires recent proof from market data, user data, event
-- loop, OMS, database, reconciler, and kill-switch state.

create table ops.health_snapshots (
  health_snapshot_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  subsystem internal.code not null,
  environment internal.run_mode not null,
  account_ref internal.identifier,
  holder_id internal.identifier,
  fencing_lease_id internal.uuid_v7 references ops.fencing_leases (fencing_lease_id),
  healthy boolean not null,
  age_ms integer,
  detail internal.detail,
  metrics jsonb,
  checked_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint health_snapshots_age_non_negative check (age_ms is null or age_ms >= 0)
);

create index health_snapshots_subsystem_idx
  on ops.health_snapshots (subsystem, checked_at desc);

call internal.enforce_append_only('ops', 'health_snapshots');
