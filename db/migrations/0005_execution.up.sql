-- WP-040 / migration 0005 — `execution` schema (handoff §10.4).
--
-- | Table | Purpose |
-- |---|---|
-- | plans               | Immutable execution plans |
-- | groups              | Slices or coordinated legs |
-- | submission_attempts | Persisted signed payloads and uncertainty state |
-- | orders              | Current order projection |
-- | order_events        | Append-only order lifecycle |
-- | intent_order_links  | Many-to-many attribution |
-- | fills               | Deduplicated fill facts |
-- | fill_allocations    | Actual fill ownership by virtual strategy |
-- | trade_settlements   | Match-to-confirmation lifecycle |
-- | rate_limit_snapshots| Observed budgets and headers |
--
-- The §9.10 execution hierarchy is a chain of foreign keys, so §6 invariant 4
-- ("every fill is traceable") is structural:
--   decision → intent → approved intent → plan → group → submission attempt
--   → order → order event → fill → fill allocation → settlement event.

create schema execution;

comment on schema execution is
  'Handoff §10.4: execution plans, submission attempts, orders and their append-only lifecycle, fills and allocations.';

-- ---------------------------------------------------------------------------
-- plans — immutable execution plans (§9.10)
-- ---------------------------------------------------------------------------

create table execution.plans (
  plan_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  approved_intent_id internal.uuid_v7 not null
    references strategy.approved_intents (approved_intent_id),
  run_id internal.uuid_v7 not null,
  instance_id internal.uuid_v7 not null,
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  environment internal.run_mode not null,
  account_ref internal.identifier,
  token_id internal.token_id not null,
  side internal.order_side not null,
  liquidity_preference internal.liquidity_preference not null,
  partial_fill_policy internal.partial_fill_policy not null,
  planned_price internal.price_string,
  planned_shares internal.positive_decimal_string not null,
  minimum_fill_shares internal.non_negative_decimal_string,
  slice_count integer not null default 1,
  cancel_replace_threshold_ticks integer,
  deadline_at timestamptz,
  escalation_policy internal.detail,
  -- §9.10 estimates, all canonical decimal strings.
  estimated_fee internal.non_negative_decimal_string,
  estimated_slippage internal.non_negative_decimal_string,
  estimated_proceeds internal.decimal_string,
  -- §6 invariant 9: a plan is priced against the parameters that were current.
  parameters_version integer not null,
  tick_size internal.positive_decimal_string not null,
  fee_schedule_id internal.uuid_v7
    references catalog.fee_schedule_snapshots (fee_schedule_id),
  plan_hash internal.sha256_hex not null,
  planned_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  constraint plans_slice_count_positive check (slice_count >= 1),
  constraint plans_threshold_non_negative check (
    cancel_replace_threshold_ticks is null or cancel_replace_threshold_ticks >= 0
  ),
  constraint plans_parameters_version_fk
    foreign key (market_id, parameters_version)
    references catalog.market_parameter_history (market_id, parameters_version),
  -- The environment and the account of a plan are the run's and the instance's,
  -- not independent values. A plan that claimed PAPER while executing a LIVE
  -- run would carry that lie to every order beneath it, and the live-order
  -- fencing CHECK reads exactly this discriminator.
  constraint plans_run_environment_fk
    foreign key (run_id, environment)
    references strategy.runs (run_id, environment),
  constraint plans_instance_environment_fk
    foreign key (instance_id, environment)
    references strategy.instances (instance_id, environment),
  constraint plans_instance_account_fk
    foreign key (instance_id, account_ref)
    references strategy.instances (instance_id, account_ref),
  constraint plans_real_mode_has_account check (
    not internal.is_real_order_mode(environment) or account_ref is not null
  ),
  -- Foreign-key targets for the orders and submission attempts below, so their
  -- own discriminators cannot disagree with the plan that authorized them.
  constraint plans_id_environment_unique unique (plan_id, environment),
  constraint plans_id_account_unique unique (plan_id, account_ref),
  constraint plans_id_market_unique unique (plan_id, market_id)
);

create index plans_market_idx on execution.plans (market_id, planned_at desc);
create index plans_run_idx on execution.plans (run_id, planned_at desc);

-- §10.4: "Immutable execution plans."
call internal.enforce_append_only('execution', 'plans');

-- ---------------------------------------------------------------------------
-- groups — slices or coordinated legs
-- ---------------------------------------------------------------------------

create table execution.groups (
  execution_group_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  plan_id internal.uuid_v7 not null references execution.plans (plan_id),
  group_ordinal integer not null,
  group_kind internal.execution_group_kind not null,
  token_id internal.token_id not null,
  side internal.order_side not null,
  limit_price internal.price_string not null,
  shares internal.positive_decimal_string not null,
  release_after_group_id internal.uuid_v7 references execution.groups (execution_group_id),
  leg_risk_limit internal.non_negative_decimal_string,
  recorded_at timestamptz not null default now(),
  constraint groups_ordinal_unique unique (plan_id, group_ordinal),
  constraint groups_ordinal_non_negative check (group_ordinal >= 0),
  -- Foreign-key target: an order or a submission attempt names both a plan and
  -- a group, and the group must belong to that plan.
  constraint groups_id_plan_unique unique (execution_group_id, plan_id)
);

call internal.enforce_append_only('execution', 'groups');

-- ---------------------------------------------------------------------------
-- submission_attempts — persisted signed payloads and uncertainty state
-- ---------------------------------------------------------------------------
--
-- §9.11 idempotent submission protocol; §6 invariant 6: "Unknown submission
-- state is never treated as rejection. Reconcile using the persisted signed
-- order/order hash before any retry with a new salt."

create table execution.submission_attempts (
  submission_attempt_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  execution_group_id internal.uuid_v7 not null,
  plan_id internal.uuid_v7 not null,
  environment internal.run_mode not null,
  account_ref internal.identifier,
  attempt_ordinal integer not null default 1,
  -- ADR-008: a live submission is persisted with the fencing token that
  -- authorized it. The referential constraint is added in migration 0008,
  -- once ops.fencing_leases exists.
  fencing_lease_id internal.uuid_v7,
  fencing_token bigint,
  signed_payload jsonb not null,
  salt internal.identifier not null,
  -- §10.7: unique where known. NULL means "the venue identity is not yet known",
  -- which is exactly the state §6 invariant 6 forbids treating as a rejection.
  expected_order_hash internal.identifier,
  state internal.submission_state not null default 'SIGNED',
  request_sent_at timestamptz,
  response_received_at timestamptz,
  response_status internal.code,
  response_payload jsonb,
  venue_order_id internal.identifier,
  error_code internal.code,
  error_detail internal.detail,
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint submission_attempts_ordinal_unique
    unique (execution_group_id, attempt_ordinal),
  constraint submission_attempts_ordinal_positive check (attempt_ordinal >= 1),
  -- ADR-008 §1/§2: the fencing CHECK below reads this row's own `environment`,
  -- so that discriminator must be the plan's. Otherwise a LIVE submission could
  -- claim PAPER and sign without holding the account's fencing token.
  constraint submission_attempts_plan_environment_fk
    foreign key (plan_id, environment)
    references execution.plans (plan_id, environment),
  constraint submission_attempts_plan_account_fk
    foreign key (plan_id, account_ref)
    references execution.plans (plan_id, account_ref),
  constraint submission_attempts_group_plan_fk
    foreign key (execution_group_id, plan_id)
    references execution.groups (execution_group_id, plan_id),
  constraint submission_attempts_real_mode_has_account check (
    not internal.is_real_order_mode(environment) or account_ref is not null
  ),
  -- Foreign-key targets for `execution.orders`: an order names the attempt that
  -- signed it, and may not re-declare either the plan or the fencing authority.
  constraint submission_attempts_id_plan_unique unique (submission_attempt_id, plan_id),
  constraint submission_attempts_id_fencing_unique
    unique (submission_attempt_id, fencing_lease_id, fencing_token)
);

-- §10.7: `submission_attempts(expected_order_hash)` unique where known.
create unique index submission_attempts_expected_order_hash_unique
  on execution.submission_attempts (expected_order_hash)
  where expected_order_hash is not null;

create index submission_attempts_unknown_idx
  on execution.submission_attempts (state, signed_at)
  where state in ('SUBMISSION_UNKNOWN', 'RECONCILING');

create trigger submission_attempts_set_updated_at
  before update on execution.submission_attempts
  for each row execute function internal.set_updated_at();

-- §9.11 step 10: "Never create a new salt until the prior attempt is
-- authoritatively absent, canceled, or terminal." The signed identity of an
-- attempt is therefore immutable; a new salt means a new attempt row.
create trigger submission_attempts_immutable_signature
  before update on execution.submission_attempts
  for each row execute function internal.forbid_column_change(
    'submission_attempt_id', 'execution_group_id', 'plan_id', 'environment',
    'account_ref', 'attempt_ordinal', 'signed_payload', 'salt',
    'fencing_lease_id', 'fencing_token'
  );

-- ---------------------------------------------------------------------------
-- orders — current order projection (mutable; the history is order_events)
-- ---------------------------------------------------------------------------

create table execution.orders (
  order_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  submission_attempt_id internal.uuid_v7,
  plan_id internal.uuid_v7 not null,
  execution_group_id internal.uuid_v7,
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  token_id internal.token_id not null,
  environment internal.run_mode not null,
  account_ref internal.identifier,
  -- The account binding as a NEVER-NULL key, so a composite foreign key to it
  -- cannot be skipped by writing NULL. `internal.identifier` is 1..200
  -- characters, so the empty string is not a spelling of any account: it means
  -- "this row names no account", and it means that on both sides of the key.
  -- MATCH SIMPLE skips a composite foreign key whenever any of its columns is
  -- NULL, which is exactly how a child row drops out of account-scoped exposure
  -- and reconciliation while still passing every constraint (round-2 HIGH-3).
  account_key text generated always as (coalesce(account_ref::text, '')) stored,
  side internal.order_side not null,
  limit_price internal.price_string not null,
  original_shares internal.positive_decimal_string not null,
  filled_shares internal.non_negative_decimal_string not null default '0',
  state internal.order_state not null default 'PLANNED',
  venue_order_id internal.identifier,
  venue_order_hash internal.identifier,
  -- §10.7 / ADR-008 §1: "Every live order references a valid fencing token."
  -- The composite foreign key and the validity trigger are added in migration
  -- 0008, once ops.fencing_leases exists.
  fencing_lease_id internal.uuid_v7,
  fencing_token bigint,
  submitted_at timestamptz,
  last_event_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- §6 invariant 10: partial fills are first-class, and a fill can never exceed
  -- the order. The comparison is exact: `numeric` is arbitrary-precision
  -- decimal, never binary floating point.
  constraint orders_filled_within_original check (
    filled_shares::numeric <= original_shares::numeric
  ),
  constraint orders_fencing_pair_complete check (
    (fencing_lease_id is null) = (fencing_token is null)
  ),
  constraint orders_real_mode_has_account check (
    not internal.is_real_order_mode(environment) or account_ref is not null
  ),
  -- §9.11 lineage: decision → intent → approved intent → plan → group →
  -- submission attempt → order → fill. Without this, an order could reach a
  -- submitted, live, or filled state with no persisted signed payload at all,
  -- and §6 invariant 6 ("reconcile using the persisted signed order/order hash")
  -- would have nothing to reconcile against.
  --
  -- The boundary is the state that first requires a *persisted signed payload*,
  -- and §9.11's own step order fixes where that is:
  --
  --   1. create `submission_attempt_id`
  --   2. create and sign the complete venue order locally
  --   3. persist signed payload, salt, expected order hash, and the plan link
  --   4. commit state `SIGNED`
  --
  -- The attempt row is created at step 1, *before* signing, and the durable
  -- signed payload it carries is written at step 3 — so by the time an order may
  -- be called `SIGNED` at step 4 the attempt necessarily exists. An attemptless
  -- `SIGNED` order is therefore a contradiction of the protocol, not a stage of
  -- it: it claims a signature with no signature on record, which is exactly what
  -- §6 invariant 6 needs to reconcile a lost response against. `SIGNED` is not
  -- exempt.
  --
  -- What remains exempt is `PLANNED` — the state before step 1 — and the three
  -- terminal states an order can reach by being abandoned before transmission,
  -- and those only while the row carries *no evidence of venue contact*: no
  -- venue identity, no submission timestamp, and no fills. A terminal state is
  -- not an exemption from lineage; not having been submitted is.
  constraint orders_submission_requires_attempt check (
    submission_attempt_id is not null
    or (
      state in ('PLANNED', 'CANCELED', 'REJECTED', 'EXPIRED')
      and filled_shares = '0'
      and venue_order_id is null
      and venue_order_hash is null
      and submitted_at is null
    )
  ),
  -- §10.7 / ADR-008 §1. The live-order fencing CHECK is written against this
  -- row's own `environment`, so that column must be the plan's: an order that
  -- named a LIVE plan and claimed PAPER used to be a fully-formed order,
  -- accepted with no fencing token at all. Both columns are NOT NULL on both
  -- sides, so this composite key is enforced for every order without exception.
  constraint orders_plan_environment_fk
    foreign key (plan_id, environment)
    references execution.plans (plan_id, environment),
  -- MATCH SIMPLE: enforced whenever the order names an account. An order that
  -- names none cannot be a real-order-mode order, because
  -- `orders_real_mode_has_account` and the environment binding above together
  -- forbid it.
  constraint orders_plan_account_fk
    foreign key (plan_id, account_ref)
    references execution.plans (plan_id, account_ref),
  constraint orders_plan_market_fk
    foreign key (plan_id, market_id)
    references execution.plans (plan_id, market_id),
  constraint orders_group_plan_fk
    foreign key (execution_group_id, plan_id)
    references execution.groups (execution_group_id, plan_id),
  constraint orders_submission_attempt_plan_fk
    foreign key (submission_attempt_id, plan_id)
    references execution.submission_attempts (submission_attempt_id, plan_id),
  -- An order and the attempt that signed it are fenced by the same lease and
  -- token, or the order is not the one that was signed.
  constraint orders_submission_attempt_fencing_fk
    foreign key (submission_attempt_id, fencing_lease_id, fencing_token)
    references execution.submission_attempts
      (submission_attempt_id, fencing_lease_id, fencing_token),
  -- Foreign-key targets for `execution.fills`, which carries the same
  -- discriminators and must not be able to disagree with the order it fills,
  -- and for `accounting.ledger_transactions`, whose own discriminators must not
  -- be able to disagree with the order it books.
  constraint orders_id_environment_unique unique (order_id, environment),
  constraint orders_id_account_unique unique (order_id, account_ref),
  -- The unskippable form of the same key (see `account_key` above).
  constraint orders_id_account_key_unique unique (order_id, account_key),
  constraint orders_id_market_unique unique (order_id, market_id),
  constraint orders_id_market_token_unique unique (order_id, market_id, token_id)
);

-- §10.7: `orders(venue_order_id)` unique where not null, scoped by
-- environment/account.
--
-- NULLS NOT DISTINCT (PostgreSQL 15+; this stack targets 16) because the scope
-- is nullable: under ordinary NULL semantics two rows with no account and the
-- same venue order id are "distinct", so the deduplication the venue identity
-- exists to provide would lapse exactly where the account is unknown — which is
-- the reconciliation path, where duplicates are most likely.
create unique index orders_venue_order_id_unique
  on execution.orders (environment, account_ref, venue_order_id)
  nulls not distinct
  where venue_order_id is not null;

create index orders_market_state_idx on execution.orders (market_id, state);
create index orders_open_idx
  on execution.orders (environment, account_ref, state)
  where terminal_at is null;

create trigger orders_set_updated_at
  before update on execution.orders
  for each row execute function internal.set_updated_at();

-- The order's identity, economics, and fencing authority are fixed at creation;
-- only lifecycle state, venue identifiers, and fill progress move.
create trigger orders_immutable_identity
  before update on execution.orders
  for each row execute function internal.forbid_column_change(
    'order_id', 'plan_id', 'market_id', 'token_id', 'environment', 'account_ref',
    'side', 'limit_price', 'original_shares', 'fencing_lease_id', 'fencing_token'
  );

-- `submission_attempt_id` may be attached to an order that did not have one
-- (PLANNED → SIGNED → SENDING), and may never be detached or re-pointed
-- afterwards. Detaching would be the way around
-- `orders_submission_requires_attempt` and around the fill lineage trigger
-- below: attach an attempt, record the fills, then set the column back to NULL
-- and the §9.11 chain is gone while every row it explains is still there.
create function execution.forbid_submission_attempt_unlink() returns trigger
language plpgsql
as $$
begin
  if old.submission_attempt_id is not null
     and new.submission_attempt_id is distinct from old.submission_attempt_id then
    raise exception
      using errcode = 'PMB02',
        message = format(
          'order %s is already signed by submission attempt %s',
          old.order_id, old.submission_attempt_id
        ),
        hint = 'A new salt is a new attempt and a new order, never a re-pointed one (§9.11 step 10).';
  end if;
  return new;
end;
$$;

create trigger orders_submission_attempt_attach_only
  before update on execution.orders
  for each row execute function execution.forbid_submission_attempt_unlink();

-- ---------------------------------------------------------------------------
-- order_events — append-only order lifecycle (§10.7)
-- ---------------------------------------------------------------------------

create table execution.order_events (
  order_event_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  order_id internal.uuid_v7 not null references execution.orders (order_id),
  event_ordinal bigint not null,
  event_type internal.code not null,
  previous_state internal.order_state,
  new_state internal.order_state not null,
  venue_order_id internal.identifier,
  venue_event_id internal.identifier,
  shares_delta internal.decimal_string,
  filled_shares internal.non_negative_decimal_string,
  remaining_shares internal.non_negative_decimal_string,
  reason_code internal.code,
  detail internal.detail,
  payload jsonb,
  source internal.event_source not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint order_events_ordinal_unique unique (order_id, event_ordinal),
  constraint order_events_ordinal_non_negative check (event_ordinal >= 0)
);

create index order_events_order_idx on execution.order_events (order_id, event_ordinal);

call internal.enforce_append_only('execution', 'order_events');

-- ---------------------------------------------------------------------------
-- intent_order_links — many-to-many attribution (§9.10, ADR-006 §4)
-- ---------------------------------------------------------------------------

create table execution.intent_order_links (
  intent_order_link_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  intent_id internal.uuid_v7 not null references strategy.intents (intent_id),
  approved_intent_id internal.uuid_v7 references strategy.approved_intents (approved_intent_id),
  order_id internal.uuid_v7 not null references execution.orders (order_id),
  attributed_shares internal.positive_decimal_string,
  recorded_at timestamptz not null default now(),
  constraint intent_order_links_unique unique (intent_id, order_id)
);

create index intent_order_links_order_idx on execution.intent_order_links (order_id);

call internal.enforce_append_only('execution', 'intent_order_links');

-- ---------------------------------------------------------------------------
-- fills — deduplicated fill facts (§10.7 uniqueness)
-- ---------------------------------------------------------------------------

create table execution.fills (
  fill_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  order_id internal.uuid_v7 not null,
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  token_id internal.token_id not null,
  environment internal.run_mode not null,
  account_ref internal.identifier,
  -- Never NULL, so the account binding below is enforced for every fill. See
  -- `execution.orders.account_key`: a fill of an account-bearing order that
  -- named no account used to satisfy `fills_order_account_fk` vacuously, and a
  -- fill that carries no account is a fill that has left account-scoped
  -- exposure, reconciliation, and the ledger (round-2 HIGH-3).
  account_key text generated always as (coalesce(account_ref::text, '')) stored,
  venue_trade_id internal.identifier not null,
  venue_order_id internal.identifier not null,
  -- §10.7 names an "allocation discriminator" in the fill uniqueness key: one
  -- venue trade can be reported as several distinct fill facts against one
  -- order. Its default is '0' so a venue that reports one fact per trade needs
  -- no synthetic value.
  allocation_discriminator internal.identifier not null default '0',
  side internal.order_side not null,
  shares internal.positive_decimal_string not null,
  price internal.price_string not null,
  notional internal.non_negative_decimal_string not null,
  fee_amount internal.non_negative_decimal_string not null default '0',
  fee_asset internal.identifier,
  liquidity_role internal.liquidity_role not null,
  matched_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  -- §10.7: fills(venue_trade_id, venue_order_id, allocation discriminator)
  -- unique. Scoped by environment/account for the same §10.8 reason orders are:
  -- a replayed or simulated fill must never collide with a live one.
  --
  -- NULLS NOT DISTINCT: `account_ref` is nullable, and ordinary NULL semantics
  -- would let one venue trade be recorded twice whenever the account is not
  -- known — double-counting a real fill, which §6 invariant 4 and the ledger
  -- both depend on not happening.
  constraint fills_venue_identity_unique unique nulls not distinct (
    environment, account_ref, venue_trade_id, venue_order_id, allocation_discriminator
  ),
  constraint fills_fee_asset_present check (fee_amount = '0' or fee_asset is not null),
  -- A fill is a fact about one order: its environment, account, market, and
  -- token are that order's. Without these, a fill of a LIVE order could be
  -- recorded as PAPER and disappear from every live exposure, reconciliation,
  -- and ledger query that filters by environment.
  constraint fills_order_environment_fk
    foreign key (order_id, environment)
    references execution.orders (order_id, environment),
  -- Keyed on the never-NULL account key, not on `account_ref`: under MATCH
  -- SIMPLE a NULL child account skipped this key entirely, so a fill of a LIVE,
  -- account-bearing order could be recorded with no account and disappear from
  -- every account-scoped query while remaining a fill of that order. Both sides
  -- spell "no account" as the empty string, so a fill of an accountless
  -- simulated order is still representable — and is the *only* case in which a
  -- fill has no account.
  constraint fills_order_account_fk
    foreign key (order_id, account_key)
    references execution.orders (order_id, account_key),
  constraint fills_order_market_token_fk
    foreign key (order_id, market_id, token_id)
    references execution.orders (order_id, market_id, token_id),
  -- Foreign-key targets for `accounting.ledger_transactions`: a transaction that
  -- books a fill may not label itself with another environment, account, market,
  -- or order than the fill it books.
  constraint fills_id_environment_unique unique (fill_id, environment),
  constraint fills_id_account_unique unique (fill_id, account_ref),
  constraint fills_id_market_unique unique (fill_id, market_id),
  constraint fills_id_order_unique unique (fill_id, order_id)
);

create index fills_order_idx on execution.fills (order_id, matched_at);
create index fills_market_idx on execution.fills (market_id, matched_at desc);

call internal.enforce_append_only('execution', 'fills');

-- §9.11 lineage, from the other end: a fill is a fact about an order that was
-- submitted, so the order it fills must carry the attempt that signed it.
-- `orders_submission_requires_attempt` states the same rule as a property of the
-- order, but `filled_shares` is a projection a writer maintains, so a fill can
-- exist against an order whose projection still says '0'. This closes that gap
-- at the point the fill is written.
create function execution.assert_fill_order_has_submission_attempt() returns trigger
language plpgsql
as $$
declare
  attempt_id uuid;
begin
  select o.submission_attempt_id into attempt_id
  from execution.orders as o
  where o.order_id = new.order_id
  for share;

  if attempt_id is null then
    raise exception
      using errcode = 'PMB11',
        message = format(
          'order %s has no submission attempt, so fill %s has no signed origin',
          new.order_id, new.fill_id
        ),
        hint = 'Persist the signed submission attempt before recording its fills (§9.11, §6 invariant 6).';
  end if;

  return new;
end;
$$;

comment on function execution.assert_fill_order_has_submission_attempt() is
  'Rejects a fill whose order carries no submission attempt (§9.11 lineage). SQLSTATE PMB11.';

create trigger fills_order_has_submission_attempt
  before insert on execution.fills
  for each row execute function execution.assert_fill_order_has_submission_attempt();

-- ---------------------------------------------------------------------------
-- fill_allocations — actual fill ownership by virtual strategy (ADR-006 §4)
-- ---------------------------------------------------------------------------
--
-- §10.7: "Every fill allocation sum equals the actual fill quantity."
-- §6 invariant 7: activity with no attribution goes to UNATTRIBUTED — so the
-- sum can always be closed, and a missing attribution is recorded rather than
-- silently dropped.

create table execution.fill_allocations (
  fill_allocation_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  fill_id internal.uuid_v7 not null references execution.fills (fill_id),
  scope internal.ledger_scope not null,
  instance_id internal.uuid_v7 references strategy.instances (instance_id),
  run_id internal.uuid_v7 references strategy.runs (run_id),
  allocated_shares internal.positive_decimal_string not null,
  allocated_notional internal.non_negative_decimal_string,
  allocated_fee internal.non_negative_decimal_string,
  recorded_at timestamptz not null default now(),
  -- ADR-006 §2: attribution is a partition of a real fill, so only the two
  -- attribution scopes may own one.
  constraint fill_allocations_scope_is_attribution check (
    scope in ('VIRTUAL_STRATEGY', 'UNATTRIBUTED')
  ),
  constraint fill_allocations_instance_matches_scope check (
    (scope = 'VIRTUAL_STRATEGY') = (instance_id is not null)
  ),
  constraint fill_allocations_owner_unique unique nulls not distinct (fill_id, scope, instance_id)
);

create index fill_allocations_fill_idx on execution.fill_allocations (fill_id);
create index fill_allocations_instance_idx on execution.fill_allocations (instance_id);

call internal.enforce_append_only('execution', 'fill_allocations');

-- ---------------------------------------------------------------------------
-- trade_settlements — match-to-confirmation lifecycle (§6 invariant 5)
-- ---------------------------------------------------------------------------
--
-- "Order state and settlement state are separate. A match is not the same as
-- confirmed on-chain settlement." This is an append-only lifecycle log, so the
-- current settlement state of a fill is its highest ordinal, and a FAILED
-- settlement is a recorded transition rather than an erased one.

create table execution.trade_settlements (
  trade_settlement_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  fill_id internal.uuid_v7 not null references execution.fills (fill_id),
  state_ordinal integer not null,
  previous_state internal.trade_settlement_state,
  state internal.trade_settlement_state not null,
  venue_trade_id internal.identifier not null,
  transaction_hash internal.identifier,
  block_number bigint,
  detail internal.detail,
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint trade_settlements_ordinal_unique unique (fill_id, state_ordinal),
  constraint trade_settlements_ordinal_non_negative check (state_ordinal >= 0)
);

create index trade_settlements_fill_idx on execution.trade_settlements (fill_id, state_ordinal);

call internal.enforce_append_only('execution', 'trade_settlements');

-- ---------------------------------------------------------------------------
-- rate_limit_snapshots — observed budgets and headers (§9.13)
-- ---------------------------------------------------------------------------

create table execution.rate_limit_snapshots (
  rate_limit_snapshot_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  bucket_kind internal.rate_limit_bucket_kind not null,
  bucket_key internal.identifier not null,
  endpoint_class internal.code,
  environment internal.run_mode not null,
  account_ref internal.identifier,
  observed_limit integer,
  observed_remaining integer,
  observed_cost integer,
  reset_at timestamptz,
  warning_header internal.detail,
  headers jsonb not null default '{}'::jsonb,
  source internal.event_source not null,
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint rate_limit_snapshots_non_negative check (
    (observed_limit is null or observed_limit >= 0)
    and (observed_remaining is null or observed_remaining >= 0)
    and (observed_cost is null or observed_cost >= 0)
  )
);

create index rate_limit_snapshots_bucket_idx
  on execution.rate_limit_snapshots (bucket_kind, bucket_key, observed_at desc);

call internal.enforce_append_only('execution', 'rate_limit_snapshots');

-- ---------------------------------------------------------------------------
-- §10.7: "Every fill allocation sum equals the actual fill quantity."
-- ---------------------------------------------------------------------------
--
-- Two checks, because they answer two different questions:
--
--   1. IMMEDIATE — an allocation may never push the allocated total above the
--      fill quantity. This fires on the offending statement, so the caller
--      learns which insert was wrong.
--   2. DEFERRED — at COMMIT the total must equal the fill quantity exactly, so
--      a fill cannot be recorded with a partial or missing attribution. §6
--      invariant 7 makes this always satisfiable: an unattributable share is
--      allocated to UNATTRIBUTED (and halts the market), never left unassigned.

create function execution.assert_fill_allocation_within_fill() returns trigger
language plpgsql
as $$
declare
  fill_shares numeric;
  allocated numeric;
begin
  -- FOR UPDATE serializes concurrent allocators of one fill. Without it two
  -- transactions could each read a stale total and both pass the check.
  select f.shares::numeric into fill_shares
  from execution.fills as f
  where f.fill_id = new.fill_id
  for update;

  select coalesce(sum(a.allocated_shares::numeric), 0) into allocated
  from execution.fill_allocations as a
  where a.fill_id = new.fill_id;

  if allocated > fill_shares then
    raise exception
      using errcode = 'PMB03',
        message = format(
          'fill allocation total %s exceeds fill quantity %s for fill %s',
          allocated, fill_shares, new.fill_id
        ),
        hint = 'A fill allocation is a partition of the actual fill (§10.7, ADR-006 §4).';
  end if;

  return null;
end;
$$;

create trigger fill_allocations_within_fill
  after insert on execution.fill_allocations
  for each row execute function execution.assert_fill_allocation_within_fill();

create function execution.assert_fill_fully_allocated() returns trigger
language plpgsql
as $$
declare
  -- Both trigger tables carry `fill_id`, so one function serves both.
  target_fill_id uuid := new.fill_id;
  fill_shares numeric;
  allocated numeric;
begin
  select f.shares::numeric into fill_shares
  from execution.fills as f
  where f.fill_id = target_fill_id
  for update;

  if fill_shares is null then
    return null;
  end if;

  select coalesce(sum(a.allocated_shares::numeric), 0) into allocated
  from execution.fill_allocations as a
  where a.fill_id = target_fill_id;

  if allocated <> fill_shares then
    raise exception
      using errcode = 'PMB04',
        message = format(
          'fill %s is allocated %s of %s shares',
          target_fill_id, allocated, fill_shares
        ),
        hint = 'Allocate the remainder, to UNATTRIBUTED if the owner is unknown (§6 invariant 7).';
  end if;

  return null;
end;
$$;

-- Deferred to COMMIT so a fill and its allocations may be written in any order
-- inside one transaction — but not across transactions.
create constraint trigger fills_fully_allocated
  after insert on execution.fills
  deferrable initially deferred
  for each row execute function execution.assert_fill_fully_allocated();

create constraint trigger fill_allocations_close_fill
  after insert on execution.fill_allocations
  deferrable initially deferred
  for each row execute function execution.assert_fill_fully_allocated();
