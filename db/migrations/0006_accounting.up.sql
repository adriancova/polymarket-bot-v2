-- WP-040 / migration 0006 — `accounting` schema (handoff §10.5).
--
-- | Table | Purpose |
-- |---|---|
-- | ledger_transactions        | Event-level accounting transaction |
-- | ledger_entries             | Per-asset balanced entries |
-- | actual_position_projection | Rebuildable wallet position view |
-- | virtual_position_projection| Rebuildable strategy attribution |
-- | balance_projection         | Actual and reserved balances |
-- | inventory_reservations     | Funds/tokens reserved for plans/orders |
-- | wallet_operations          | Split, merge, redeem, approve, transfer |
-- | wallet_operation_events    | Append-only operation lifecycle |
-- | reward_estimates           | Non-realized estimates |
-- | reward_payouts             | Actual observed payouts |
-- | pnl_snapshots              | Rebuildable reporting projection |
--
-- ADR-006 §1: the append-only ledger is the monetary source of truth and the
-- projections are rebuildable views, not truth (§6 invariant 8).
-- ADR-006 §7: there is no implicit "cash" asset. Every entry names its asset,
-- because the USDC/pUSD denomination question (venue conflict C-2) is
-- UNRESOLVED and must not be resolved by assumption.

create schema accounting;

comment on schema accounting is
  'Handoff §10.5: the append-only ledger (monetary source of truth) and the rebuildable projections over it.';

-- ---------------------------------------------------------------------------
-- wallet_operations — split, merge, redeem, approve, transfer (§9.14)
-- ---------------------------------------------------------------------------

create table accounting.wallet_operations (
  wallet_operation_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  environment internal.run_mode not null,
  account_ref internal.identifier not null,
  operation_type internal.wallet_operation_type not null,
  state internal.wallet_operation_state not null default 'PLANNED',
  market_id internal.uuid_v7 references catalog.markets (market_id),
  condition_id internal.identifier,
  asset_id internal.identifier,
  amount internal.non_negative_decimal_string,
  transaction_hash internal.identifier,
  relayer_reference internal.identifier,
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  detail internal.detail,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallet_operations_confirmed_consistent check (
    (state = 'CONFIRMED') = (confirmed_at is not null)
  )
);

create index wallet_operations_open_idx
  on accounting.wallet_operations (account_ref, state)
  where state in ('SUBMITTED', 'MINED', 'UNKNOWN', 'RECONCILING');

create trigger wallet_operations_set_updated_at
  before update on accounting.wallet_operations
  for each row execute function internal.set_updated_at();

create trigger wallet_operations_immutable_identity
  before update on accounting.wallet_operations
  for each row execute function internal.forbid_column_change(
    'wallet_operation_id', 'environment', 'account_ref', 'operation_type', 'requested_at'
  );

-- ---------------------------------------------------------------------------
-- wallet_operation_events — append-only operation lifecycle
-- ---------------------------------------------------------------------------

create table accounting.wallet_operation_events (
  wallet_operation_event_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  wallet_operation_id internal.uuid_v7 not null
    references accounting.wallet_operations (wallet_operation_id),
  event_ordinal integer not null,
  previous_state internal.wallet_operation_state,
  new_state internal.wallet_operation_state not null,
  transaction_hash internal.identifier,
  block_number bigint,
  reason_code internal.code,
  detail internal.detail,
  payload jsonb,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint wallet_operation_events_ordinal_unique
    unique (wallet_operation_id, event_ordinal),
  constraint wallet_operation_events_ordinal_non_negative check (event_ordinal >= 0)
);

call internal.enforce_append_only('accounting', 'wallet_operation_events');

-- ---------------------------------------------------------------------------
-- ledger_transactions — event-level accounting transaction (§9.15)
-- ---------------------------------------------------------------------------

create table accounting.ledger_transactions (
  ledger_transaction_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  event_type internal.ledger_event_type not null,
  environment internal.run_mode not null,
  account_ref internal.identifier not null,
  market_id internal.uuid_v7 references catalog.markets (market_id),
  order_id internal.uuid_v7 references execution.orders (order_id),
  fill_id internal.uuid_v7 references execution.fills (fill_id),
  wallet_operation_id internal.uuid_v7
    references accounting.wallet_operations (wallet_operation_id),
  -- Added in migration 0008, once ops.reconciliation_runs exists.
  reconciliation_run_id internal.uuid_v7,
  -- ADR-006 §5: settlement state is carried on the ledger transaction, because
  -- a match is not a confirmed on-chain settlement (§6 invariant 5).
  settlement_state internal.trade_settlement_state,
  -- ADR-006 §5.2: a FAILED settlement produces a compensating append-only
  -- reversal, never an edit or a delete.
  reverses_ledger_transaction_id internal.uuid_v7
    references accounting.ledger_transactions (ledger_transaction_id),
  source internal.event_source not null,
  reference_hash internal.sha256_hex,
  detail internal.detail,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint ledger_transactions_not_self_reversing check (
    reverses_ledger_transaction_id is null
    or reverses_ledger_transaction_id <> ledger_transaction_id
  )
);

create index ledger_transactions_account_idx
  on accounting.ledger_transactions (account_ref, environment, occurred_at desc);
create index ledger_transactions_fill_idx on accounting.ledger_transactions (fill_id);
create index ledger_transactions_market_idx on accounting.ledger_transactions (market_id);

call internal.enforce_append_only('accounting', 'ledger_transactions');

-- ---------------------------------------------------------------------------
-- ledger_entries — per-asset balanced entries (§10.7)
-- ---------------------------------------------------------------------------

create table accounting.ledger_entries (
  ledger_entry_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  ledger_transaction_id internal.uuid_v7 not null
    references accounting.ledger_transactions (ledger_transaction_id),
  entry_ordinal integer not null,
  scope internal.ledger_scope not null,
  account_ref internal.identifier not null,
  instance_id internal.uuid_v7 references strategy.instances (instance_id),
  run_id internal.uuid_v7 references strategy.runs (run_id),
  market_id internal.uuid_v7 references catalog.markets (market_id),
  -- ADR-006 §7 rule 1: every entry carries an explicit asset identifier.
  asset_id internal.identifier not null,
  asset_kind internal.asset_kind not null,
  -- Signed: a balanced transaction has entries on both sides.
  amount internal.decimal_string not null,
  detail internal.detail,
  recorded_at timestamptz not null default now(),
  constraint ledger_entries_ordinal_unique unique (ledger_transaction_id, entry_ordinal),
  constraint ledger_entries_ordinal_non_negative check (entry_ordinal >= 0),
  constraint ledger_entries_amount_non_zero check (amount <> '0'),
  -- ADR-006 §2: a VIRTUAL_STRATEGY entry names the instance it attributes to,
  -- and no other scope may.
  constraint ledger_entries_instance_matches_scope check (
    (scope = 'VIRTUAL_STRATEGY') = (instance_id is not null)
  )
);

create index ledger_entries_transaction_idx
  on accounting.ledger_entries (ledger_transaction_id, entry_ordinal);
create index ledger_entries_asset_idx
  on accounting.ledger_entries (account_ref, asset_id, recorded_at desc);
create index ledger_entries_instance_idx on accounting.ledger_entries (instance_id);

call internal.enforce_append_only('accounting', 'ledger_entries');

-- ---------------------------------------------------------------------------
-- §10.7: "Every ledger transaction balances to zero per asset."
-- ---------------------------------------------------------------------------
--
-- Deferred to COMMIT, because a balanced transaction is only balanced once all
-- of its entries exist. Both tables carry `ledger_transaction_id`, so one
-- function serves both triggers: inserting the transaction alone must fail just
-- as loudly as inserting a one-sided pair of entries.

create function accounting.assert_ledger_transaction_balanced() returns trigger
language plpgsql
as $$
declare
  target_transaction_id uuid := new.ledger_transaction_id;
  entry_count integer;
  unbalanced record;
begin
  -- Serializes concurrent writers appending entries to one transaction.
  perform 1
  from accounting.ledger_transactions as t
  where t.ledger_transaction_id = target_transaction_id
  for update;

  select count(*) into entry_count
  from accounting.ledger_entries as e
  where e.ledger_transaction_id = target_transaction_id;

  if entry_count = 0 then
    raise exception
      using errcode = 'PMB05',
        message = format('ledger transaction %s has no entries', target_transaction_id),
        hint = 'A ledger transaction records at least one balanced pair of entries (§9.15).';
  end if;

  select e.asset_id as asset_id, sum(e.amount::numeric) as net
  into unbalanced
  from accounting.ledger_entries as e
  where e.ledger_transaction_id = target_transaction_id
  group by e.asset_id
  having sum(e.amount::numeric) <> 0
  limit 1;

  if found then
    raise exception
      using errcode = 'PMB05',
        message = format(
          'ledger transaction %s does not balance for asset %s: net %s',
          target_transaction_id, unbalanced.asset_id, unbalanced.net
        ),
        hint = 'Balance one-sided real-world movement with an EXTERNAL_CLEARING entry (§9.15, ADR-006 §2).';
  end if;

  return null;
end;
$$;

create constraint trigger ledger_transactions_balanced
  after insert on accounting.ledger_transactions
  deferrable initially deferred
  for each row execute function accounting.assert_ledger_transaction_balanced();

create constraint trigger ledger_entries_balanced
  after insert on accounting.ledger_entries
  deferrable initially deferred
  for each row execute function accounting.assert_ledger_transaction_balanced();

-- ---------------------------------------------------------------------------
-- balance_projection — actual and reserved balances (mutable projection)
-- ---------------------------------------------------------------------------
--
-- §10.7: "No negative available balance after reservations." The available
-- amount is a stored generated column, so the invariant is a CHECK on a value
-- the database computes rather than one a writer supplies.

create table accounting.balance_projection (
  account_ref internal.identifier not null,
  environment internal.run_mode not null,
  asset_id internal.identifier not null,
  asset_kind internal.asset_kind not null,
  actual_amount internal.decimal_string not null default '0',
  reserved_amount internal.non_negative_decimal_string not null default '0',
  available_amount internal.decimal_string
    generated always as (
      internal.decimal_text(actual_amount::numeric - reserved_amount::numeric)
    ) stored,
  last_ledger_transaction_id internal.uuid_v7
    references accounting.ledger_transactions (ledger_transaction_id),
  rebuilt_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (account_ref, environment, asset_id),
  constraint balance_projection_no_negative_available check (
    available_amount::numeric >= 0
  )
);

create trigger balance_projection_set_updated_at
  before update on accounting.balance_projection
  for each row execute function internal.set_updated_at();

-- ---------------------------------------------------------------------------
-- inventory_reservations — funds/tokens reserved for plans/orders (§9.14)
-- ---------------------------------------------------------------------------

create table accounting.inventory_reservations (
  inventory_reservation_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  account_ref internal.identifier not null,
  environment internal.run_mode not null,
  asset_id internal.identifier not null,
  asset_kind internal.asset_kind not null,
  plan_id internal.uuid_v7 references execution.plans (plan_id),
  order_id internal.uuid_v7 references execution.orders (order_id),
  instance_id internal.uuid_v7 references strategy.instances (instance_id),
  amount internal.positive_decimal_string not null,
  status internal.reservation_status not null default 'ACTIVE',
  reserved_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason internal.detail,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_reservations_release_consistent check (
    (status = 'ACTIVE') = (released_at is null)
  )
);

-- §9.14: "Prevent double reservation." One active reservation per order and
-- asset; a second reservation for the same order is a bug, not a top-up.
create unique index inventory_reservations_no_double_reservation
  on accounting.inventory_reservations (order_id, asset_id)
  where status = 'ACTIVE' and order_id is not null;

create index inventory_reservations_active_idx
  on accounting.inventory_reservations (account_ref, environment, asset_id)
  where status = 'ACTIVE';

create trigger inventory_reservations_set_updated_at
  before update on accounting.inventory_reservations
  for each row execute function internal.set_updated_at();

create trigger inventory_reservations_immutable_identity
  before update on accounting.inventory_reservations
  for each row execute function internal.forbid_column_change(
    'inventory_reservation_id', 'account_ref', 'environment', 'asset_id',
    'asset_kind', 'amount', 'reserved_at'
  );

-- A reservation constrains availability the moment it exists, and stops
-- constraining only when it is released or consumed. Maintaining
-- `reserved_amount` here rather than in a repository means the §10.7 invariant
-- holds for every writer, not only for the one that remembers to update both
-- tables. The CHECK on balance_projection is what actually rejects an
-- over-reservation.
create function accounting.apply_inventory_reservation() returns trigger
language plpgsql
as $$
declare
  reserved_delta numeric;
  affected integer;
begin
  if tg_op = 'INSERT' then
    reserved_delta := case when new.status = 'ACTIVE' then new.amount::numeric else 0 end;
  else
    reserved_delta :=
      (case when new.status = 'ACTIVE' then new.amount::numeric else 0 end)
      - (case when old.status = 'ACTIVE' then old.amount::numeric else 0 end);
  end if;

  if reserved_delta = 0 then
    return null;
  end if;

  update accounting.balance_projection as b
  set reserved_amount = internal.decimal_text(b.reserved_amount::numeric + reserved_delta),
      updated_at = now()
  where b.account_ref = new.account_ref
    and b.environment = new.environment
    and b.asset_id = new.asset_id;

  get diagnostics affected = row_count;

  if affected = 0 then
    raise exception
      using errcode = 'PMB09',
        message = format(
          'no balance projection row for account %s, environment %s, asset %s',
          new.account_ref, new.environment, new.asset_id
        ),
        hint = 'A reservation constrains a known balance; create the balance row first (§9.14).';
  end if;

  return null;
end;
$$;

create trigger inventory_reservations_apply
  after insert or update of status, amount on accounting.inventory_reservations
  for each row execute function accounting.apply_inventory_reservation();

-- ---------------------------------------------------------------------------
-- Position projections (§6 invariant 8: rebuildable, never the source of truth)
-- ---------------------------------------------------------------------------

create table accounting.actual_position_projection (
  account_ref internal.identifier not null,
  environment internal.run_mode not null,
  asset_id internal.identifier not null,
  asset_kind internal.asset_kind not null,
  market_id internal.uuid_v7 references catalog.markets (market_id),
  token_id internal.token_id,
  shares internal.decimal_string not null default '0',
  average_cost internal.non_negative_decimal_string,
  last_ledger_transaction_id internal.uuid_v7
    references accounting.ledger_transactions (ledger_transaction_id),
  rebuilt_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (account_ref, environment, asset_id)
);

create trigger actual_position_projection_set_updated_at
  before update on accounting.actual_position_projection
  for each row execute function internal.set_updated_at();

create table accounting.virtual_position_projection (
  instance_id internal.uuid_v7 not null references strategy.instances (instance_id),
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  asset_id internal.identifier not null,
  asset_kind internal.asset_kind not null,
  run_id internal.uuid_v7 references strategy.runs (run_id),
  token_id internal.token_id,
  shares internal.decimal_string not null default '0',
  average_cost internal.non_negative_decimal_string,
  realized_pnl internal.decimal_string not null default '0',
  last_ledger_transaction_id internal.uuid_v7
    references accounting.ledger_transactions (ledger_transaction_id),
  rebuilt_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (instance_id, market_id, asset_id)
);

create trigger virtual_position_projection_set_updated_at
  before update on accounting.virtual_position_projection
  for each row execute function internal.set_updated_at();

-- ---------------------------------------------------------------------------
-- Rewards (§9.16, ADR-006 §6)
-- ---------------------------------------------------------------------------
--
-- "Reward estimates are never booked as realized." Estimates and payouts are
-- separate tables, and only a payout may reference a ledger transaction.

create table accounting.reward_estimates (
  reward_estimate_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  program_type internal.reward_program_type not null,
  reward_program_id internal.uuid_v7
    references catalog.reward_program_snapshots (reward_program_id),
  environment internal.run_mode not null,
  account_ref internal.identifier,
  instance_id internal.uuid_v7 references strategy.instances (instance_id),
  market_id internal.uuid_v7 references catalog.markets (market_id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  estimated_amount internal.non_negative_decimal_string not null,
  denomination_asset internal.identifier not null,
  methodology internal.code not null,
  computed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint reward_estimates_period check (period_end > period_start)
);

create index reward_estimates_period_idx
  on accounting.reward_estimates (program_type, period_start desc);

call internal.enforce_append_only('accounting', 'reward_estimates');

create table accounting.reward_payouts (
  reward_payout_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  program_type internal.reward_program_type not null,
  reward_program_id internal.uuid_v7
    references catalog.reward_program_snapshots (reward_program_id),
  environment internal.run_mode not null,
  account_ref internal.identifier not null,
  market_id internal.uuid_v7 references catalog.markets (market_id),
  period_start timestamptz,
  period_end timestamptz,
  amount internal.positive_decimal_string not null,
  denomination_asset internal.identifier not null,
  transaction_hash internal.identifier,
  ledger_transaction_id internal.uuid_v7
    references accounting.ledger_transactions (ledger_transaction_id),
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint reward_payouts_period check (
    period_start is null or period_end is null or period_end > period_start
  ),
  constraint reward_payouts_observation_unique unique nulls not distinct (
    account_ref, environment, program_type, market_id, period_start
  )
);

call internal.enforce_append_only('accounting', 'reward_payouts');

-- ---------------------------------------------------------------------------
-- pnl_snapshots — rebuildable reporting projection (§9.16)
-- ---------------------------------------------------------------------------

create table accounting.pnl_snapshots (
  pnl_snapshot_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  scope internal.ledger_scope not null,
  environment internal.run_mode not null,
  account_ref internal.identifier not null,
  instance_id internal.uuid_v7 references strategy.instances (instance_id),
  run_id internal.uuid_v7 references strategy.runs (run_id),
  market_id internal.uuid_v7 references catalog.markets (market_id),
  denomination_asset internal.identifier not null,
  gross_trading_pnl internal.decimal_string not null,
  -- §6 invariant 14: core net PnL excludes discretionary rewards; the all-in
  -- figure is reported separately, never merged into the core one.
  core_net_pnl internal.decimal_string not null,
  all_in_pnl internal.decimal_string not null,
  realized_pnl internal.decimal_string not null,
  unrealized_pnl_midpoint internal.decimal_string not null,
  unrealized_pnl_model internal.decimal_string,
  unrealized_pnl_liquidation internal.decimal_string,
  worst_case_resolution_pnl internal.decimal_string,
  fees_paid internal.non_negative_decimal_string not null default '0',
  reward_estimate_total internal.non_negative_decimal_string not null default '0',
  realized_rewards internal.non_negative_decimal_string not null default '0',
  capital_committed internal.non_negative_decimal_string not null default '0',
  as_of timestamptz not null,
  computed_at timestamptz not null default now(),
  rebuilt_at timestamptz,
  constraint pnl_snapshots_scope_unique unique nulls not distinct (
    scope, environment, account_ref, instance_id, market_id, as_of
  )
);

create index pnl_snapshots_instance_idx
  on accounting.pnl_snapshots (instance_id, as_of desc);
