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
  -- Required by the composite foreign key that binds a live order to the exact
  -- lease *and* token that authorized it (migration 0008).
  constraint fencing_leases_id_token_unique unique (fencing_lease_id, fencing_token),
  constraint fencing_leases_token_positive check (fencing_token >= 1),
  constraint fencing_leases_expiry_after_acquisition check (expires_at > acquired_at),
  -- ADR-008 §2 and ADR-010: "paper mode cannot acquire a live fencing lease at
  -- all". The fence exists to arbitrate real order authority; a simulated mode
  -- holding one would either block the live writer or teach an operator that a
  -- simulated process holds live authority. Both are worse than having no row.
  constraint fencing_leases_real_modes_only check (
    internal.is_real_order_mode(environment)
  ),
  -- Any lease that is no longer ACTIVE records when it stopped being ACTIVE,
  -- whether it was released by its holder, revoked, or found expired by the
  -- process that took it over.
  constraint fencing_leases_terminal_consistent check (
    (status <> 'ACTIVE') = (released_at is not null)
  )
);

-- §2: "Exactly one fenced live order writer per account/signer."
--
-- Keyed by execution realm, not by run mode. `EXECUTION_PROBE`, `LIVE_MICRO`,
-- and `LIVE` all submit real orders with the same CLOB credentials, and the
-- venue cannot tell two of our processes apart (ADR-008 §4) — so an index keyed
-- by `environment` permitted three simultaneous real writers per account, which
-- is exactly the state the fence exists to prevent. The
-- `fencing_leases_real_modes_only` CHECK means every row here is in the REAL
-- realm, so no predicate on the realm is needed.
create unique index fencing_leases_one_active_holder
  on ops.fencing_leases (account_ref, internal.execution_realm(environment))
  where status = 'ACTIVE';

-- Tokens are monotonic per account across the whole real realm (see the trigger
-- below), so the token key and the lookup index are realm-scoped too.
create unique index fencing_leases_token_unique
  on ops.fencing_leases (account_ref, internal.execution_realm(environment), fencing_token);

create index fencing_leases_account_token_idx
  on ops.fencing_leases (account_ref, internal.execution_realm(environment), fencing_token desc);

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

-- The lease state machine is forward-only: ACTIVE → (EXPIRED | RELEASED |
-- REVOKED), and nothing else.
--
-- The immutability trigger above protects the *grant* — token, account,
-- environment, holder, acquisition — but `status`, `released_at`, and
-- `expires_at` were freely writable, so
--
--   update ops.fencing_leases
--      set status = 'ACTIVE', released_at = null,
--          expires_at = clock_timestamp() + interval '5 minutes'
--    where fencing_lease_id = <a released lease>
--
-- resurrected a lease that had already been handed over: the old holder and the
-- old token become valid again, and ADR-008 §1's "a token is never reused" is
-- violated by an UPDATE rather than by an INSERT. Authority that has ended has
-- ended; the only way to hold the fence again is a fresh grant, which allocates
-- a fresh token. A terminal lease is frozen outright — it is history, and the
-- takeover path only ever touches ACTIVE rows.
create function ops.assert_fencing_lease_forward_only() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'ACTIVE' then
    raise exception
      using errcode = 'PMB10',
        message = format(
          'fencing lease %s is %s: a lease that has ended cannot be changed or reactivated',
          old.fencing_lease_id, old.status
        ),
        hint = 'Acquire a new lease; it allocates a new token (ADR-008 §1, §9.18).';
  end if;

  return new;
end;
$$;

comment on function ops.assert_fencing_lease_forward_only() is
  'Rejects any change to a lease that is no longer ACTIVE, including resurrection (ADR-008 §1). SQLSTATE PMB10.';

create trigger fencing_leases_forward_only
  before update on ops.fencing_leases
  for each row execute function ops.assert_fencing_lease_forward_only();

-- A lease row is history, so it is never deleted either: `max(fencing_token)`
-- over a table someone can delete from is not a monotonic sequence, and the
-- high-water mark below exists precisely because the lease rows can be missing.
-- Both guards are here because they fail differently — this one keeps the audit
-- trail, that one keeps the token.
create trigger fencing_leases_no_delete
  before delete on ops.fencing_leases
  for each row execute function internal.forbid_update_delete();

create trigger fencing_leases_no_truncate
  before truncate on ops.fencing_leases
  for each statement execute function internal.forbid_truncate();

-- ---------------------------------------------------------------------------
-- fencing_token_high_water — the token sequence, independent of lease history
-- ---------------------------------------------------------------------------
--
-- ADR-008 §1: "A token is never reused, never decremented." Deriving the next
-- token from `max(fencing_token)` over `ops.fencing_leases` made that claim only
-- as durable as the lease rows: delete the released history for an account and
-- the maximum drops, so the *next* acquisition re-issues a token a previous
-- holder already used — and a late write from that holder becomes
-- indistinguishable from a current one, which is the entire purpose of the
-- token. This table only ever increases, per account and execution realm, and
-- may not be deleted from or truncated, so erasing lease rows cannot reopen a
-- token.
create table ops.fencing_token_high_water (
  account_ref internal.identifier not null,
  -- The realm string from internal.execution_realm(), not a run mode: the token
  -- sequence is per real authority, and all three real-order modes share it.
  execution_realm text not null,
  highest_token bigint not null,
  first_issued_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_ref, execution_realm),
  constraint fencing_token_high_water_positive check (highest_token >= 1)
);

comment on table ops.fencing_token_high_water is
  'Highest fencing token ever issued per account and execution realm. Monotonic and non-erasable, so deleting lease rows cannot re-issue a token (ADR-008 §1).';

-- The high-water mark itself moves in one direction and never disappears.
create function ops.assert_fencing_high_water_monotonic() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      using errcode = 'PMB07',
        message = format(
          'the fencing token high-water mark for account %s in realm %s may not be deleted',
          old.account_ref, old.execution_realm
        ),
        hint = 'Deleting it would re-issue tokens that were already used (ADR-008 §1).';
  end if;

  if new.account_ref <> old.account_ref or new.execution_realm <> old.execution_realm then
    raise exception
      using errcode = 'PMB07',
        message = 'the identity of a fencing token high-water mark is immutable';
  end if;

  if new.highest_token < old.highest_token then
    raise exception
      using errcode = 'PMB07',
        message = format(
          'fencing token high-water mark for account %s would fall from %s to %s',
          old.account_ref, old.highest_token, new.highest_token
        ),
        hint = 'Fencing tokens are monotonic and never reused (§9.18, ADR-008 §1).';
  end if;

  return new;
end;
$$;

create trigger fencing_token_high_water_monotonic
  before update or delete on ops.fencing_token_high_water
  for each row execute function ops.assert_fencing_high_water_monotonic();

create trigger fencing_token_high_water_no_truncate
  before truncate on ops.fencing_token_high_water
  for each statement execute function internal.forbid_truncate();

-- ADR-008 §1: "A token is never reused, never decremented." Scoped by execution
-- realm rather than by run mode, so a LIVE_MICRO takeover of an account a LIVE
-- process was fencing continues the same sequence instead of restarting at 1 —
-- a restarted sequence would make a stale write from the previous holder
-- indistinguishable from a current one, which is the whole point of the token.
--
-- The comparison is against the high-water mark rather than against the lease
-- rows, so it does not depend on any lease row still being there. The advance is
-- the same statement as the comparison: `on conflict ... where` updates only
-- when the new token really is higher, and `row_count = 0` means it was not —
-- which also serializes two concurrent acquisitions on the same row rather than
-- letting both read the same "highest".
create function ops.assert_fencing_token_monotonic() returns trigger
language plpgsql
as $$
declare
  realm text := internal.execution_realm(new.environment);
  advanced integer;
  highest_token bigint;
begin
  insert into ops.fencing_token_high_water as h
    (account_ref, execution_realm, highest_token)
  values (new.account_ref, realm, new.fencing_token)
  on conflict (account_ref, execution_realm) do update
    set highest_token = excluded.highest_token,
        updated_at = now()
    where h.highest_token < excluded.highest_token;

  get diagnostics advanced = row_count;

  if advanced = 0 then
    select h.highest_token into highest_token
    from ops.fencing_token_high_water as h
    where h.account_ref = new.account_ref
      and h.execution_realm = realm;

    raise exception
      using errcode = 'PMB07',
        message = format(
          'fencing token %s for account %s is not above the highest issued token %s',
          new.fencing_token, new.account_ref, highest_token
        ),
        hint = 'Fencing tokens are monotonic and never reused, and deleting lease history does not release one (§9.18, ADR-008 §1).';
  end if;

  return new;
end;
$$;

create trigger fencing_leases_monotonic_token
  before insert on ops.fencing_leases
  for each row execute function ops.assert_fencing_token_monotonic();

-- Moves lapsed leases into the EXPIRED state.
--
-- Authorization never depends on this having run: the live-write trigger in
-- migration 0008 compares against the database's own clock, so an ACTIVE row
-- whose expiry has passed authorizes nothing whether or not anyone has
-- relabelled it. This exists so the recorded state machine matches reality for
-- the operator reading the table and for the takeover path, which must see the
-- lapse as a transition rather than as a silent overwrite.
create function ops.expire_stale_fencing_leases(target_account_ref text default null)
returns integer
language plpgsql
as $$
declare
  expired_count integer;
begin
  update ops.fencing_leases as l
  set status = 'EXPIRED',
      released_at = now(),
      revoked_reason = coalesce(l.revoked_reason, 'lease expired')
  where l.status = 'ACTIVE'
    and l.expires_at <= now()
    and (target_account_ref is null or l.account_ref = target_account_ref);

  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

comment on function ops.expire_stale_fencing_leases(text) is
  'Marks ACTIVE leases whose expiry has passed as EXPIRED (ADR-008). Never a precondition for authorization.';

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
  ),
  -- Foreign-key targets for `accounting.ledger_transactions` (migration 0008): a
  -- reconciliation correction is booked in the environment and against the
  -- account the reconciliation run actually examined (§9.17, ADR-006 §5.2).
  constraint reconciliation_runs_id_environment_unique
    unique (reconciliation_run_id, environment),
  constraint reconciliation_runs_id_account_unique
    unique (reconciliation_run_id, account_ref)
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
