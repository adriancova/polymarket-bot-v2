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
  ),
  -- Foreign-key targets for `accounting.ledger_transactions`: a transaction that
  -- books a wallet operation may not label itself with another environment or
  -- account than the operation it books. The *market* is bound by
  -- `accounting.assert_ledger_wallet_operation_market()` below rather than by a
  -- composite key; the comment there explains why a key cannot do it.
  constraint wallet_operations_id_environment_unique unique (wallet_operation_id, environment),
  constraint wallet_operations_id_account_unique unique (wallet_operation_id, account_ref)
);

create index wallet_operations_open_idx
  on accounting.wallet_operations (account_ref, state)
  where state in ('SUBMITTED', 'MINED', 'UNKNOWN', 'RECONCILING');

create trigger wallet_operations_set_updated_at
  before update on accounting.wallet_operations
  for each row execute function internal.set_updated_at();

-- `market_id` is part of the operation's identity, not a field to be revised.
--
-- Round 4: the market was omitted from this list, so an operation could be
-- created against market M1, have its ledger transactions bound to M1, and then
-- be repointed at M2 — leaving append-only, permanent transactions bound to a
-- market their operation no longer claims. A binding that a later UPDATE can
-- invalidate is not a binding, and `ledger_transactions` cannot be corrected
-- afterwards because it is append-only (ADR-006 §1, §5.2).
--
-- Consequence, deliberately accepted: a wallet operation states its market when
-- it is created, including "none". An operation discovered on-chain whose market
-- is not yet resolved is recorded once the mapping is known, or reported as a
-- reconciliation break (§9.17) — it is not inserted marketless and enriched
-- later.
create trigger wallet_operations_immutable_identity
  before update on accounting.wallet_operations
  for each row execute function internal.forbid_column_change(
    'wallet_operation_id', 'environment', 'account_ref', 'operation_type', 'market_id',
    'requested_at'
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
  ),
  -- The discriminators of a transaction that names an execution or wallet fact
  -- are that fact's, not independent labels.
  --
  -- `environment`, `account_ref`, and `market_id` were plain columns beside
  -- scalar `order_id`/`fill_id`/`wallet_operation_id` references, so a balanced,
  -- append-only transaction could book a LIVE fill while calling itself PAPER,
  -- or book one account's fill under another account's name — and the ledger is
  -- the monetary source of truth (ADR-006 §1), so that is a corruption of the
  -- thing every projection is rebuilt from. Append-only makes it permanent.
  --
  -- MATCH SIMPLE is exactly right here: each key is enforced for a transaction
  -- that *does* reference the row in question and skipped for one that does not,
  -- so external clearing, manual adjustments, and resolutions still stand alone
  -- with discriminators of their own (§9.15).
  --
  -- The market binding is where MATCH SIMPLE needed help, because `market_id` is
  -- itself nullable. For the *execution* links a CHECK is enough (below); for the
  -- *wallet-operation* link it is not, because the parent column is nullable too
  -- — see `accounting.assert_ledger_wallet_operation_market()`.
  --
  -- The execution half: an order- or fill-linked
  -- transaction that simply omitted the market skipped
  -- `ledger_transactions_order_market_fk` / `..._fill_market_fk` altogether and
  -- was stored with no market at all — disappearing from every market-scoped
  -- ledger query while still balancing, still naming the right account, and
  -- still being append-only. An order and a fill both carry a NOT NULL
  -- `market_id`, so the value is never unknown to the writer; a transaction that
  -- books one has no reason to omit it, and a standalone transaction (a
  -- deposit, a manual adjustment, a resolution) is still free to have no market.
  constraint ledger_transactions_execution_link_has_market check (
    market_id is not null
    or (order_id is null and fill_id is null)
  ),
  constraint ledger_transactions_order_environment_fk
    foreign key (order_id, environment)
    references execution.orders (order_id, environment),
  constraint ledger_transactions_order_account_fk
    foreign key (order_id, account_ref)
    references execution.orders (order_id, account_ref),
  constraint ledger_transactions_order_market_fk
    foreign key (order_id, market_id)
    references execution.orders (order_id, market_id),
  constraint ledger_transactions_fill_environment_fk
    foreign key (fill_id, environment)
    references execution.fills (fill_id, environment),
  constraint ledger_transactions_fill_account_fk
    foreign key (fill_id, account_ref)
    references execution.fills (fill_id, account_ref),
  constraint ledger_transactions_fill_market_fk
    foreign key (fill_id, market_id)
    references execution.fills (fill_id, market_id),
  -- A transaction that names both must name a fill *of that order*.
  constraint ledger_transactions_fill_order_fk
    foreign key (fill_id, order_id)
    references execution.fills (fill_id, order_id),
  constraint ledger_transactions_wallet_operation_environment_fk
    foreign key (wallet_operation_id, environment)
    references accounting.wallet_operations (wallet_operation_id, environment),
  constraint ledger_transactions_wallet_operation_account_fk
    foreign key (wallet_operation_id, account_ref)
    references accounting.wallet_operations (wallet_operation_id, account_ref)
);

create index ledger_transactions_account_idx
  on accounting.ledger_transactions (account_ref, environment, occurred_at desc);
create index ledger_transactions_fill_idx on accounting.ledger_transactions (fill_id);
create index ledger_transactions_market_idx on accounting.ledger_transactions (market_id);

call internal.enforce_append_only('accounting', 'ledger_transactions');

-- ---------------------------------------------------------------------------
-- A transaction that books a market-bearing wallet operation books its market
-- ---------------------------------------------------------------------------
--
-- The round-3 fix bound `market_id` for the order and fill links, and left the
-- wallet-operation link where it was: bound on environment and account only. So
-- a REDEEM of market M1 could be booked by a transaction with `market_id` NULL
-- (invisible to every market-scoped ledger query) or with market M2 (filed under
-- a market it has nothing to do with), while naming the right operation, the
-- right account, the right environment, and balancing. Both were reproduced on
-- the reviewed schema; the ledger is append-only, so both are permanent.
--
-- WHY NOT A COMPOSITE FOREIGN KEY, which is how every other discriminator here
-- is bound:
--
--   * MATCH SIMPLE skips the key whenever any child column is NULL, so a
--     transaction that simply omits the market skips it — the round-3 defect,
--     one column across. The round-3 remedy (a CHECK requiring the market) does
--     not transfer, because it would force a market onto a transaction that
--     books an approval or a collateral transfer, which genuinely has none.
--   * MATCH FULL would demand all-or-nothing across `(wallet_operation_id,
--     market_id)`, so a marketless operation could never be booked at all.
--   * A non-null child market against a marketless operation would be rejected
--     by any such key, turning "the operation did not record a market" into "the
--     transaction may not name one" — a stronger rule than the facts support,
--     and one that contradicts `ledger_transactions_execution_link_has_market`
--     for a transaction that books an execution fact *and* an approval.
--
-- So the rule is CONDITIONAL EQUALITY, and it needs a trigger to say it:
--
--     the operation has a market  →  the transaction names the SAME market
--     the operation has none      →  the transaction's market is its own affair
--                                    (exactly as for a transaction that books no
--                                    operation at all)
--
-- Two related questions, answered rather than left open:
--
--   * `ops.reconciliation_runs` has no market column at all (§9.17: a run
--     examines an account in an environment, not a market), so the
--     reconciliation link has no market to bind and needs no analogue here.
--   * `market_id` on `accounting.wallet_operations` is immutable (see the
--     trigger on that table), which is what keeps this check true after the
--     fact: without it the operation could be repointed at another market once
--     the transaction was committed and beyond correction.

create function accounting.assert_ledger_wallet_operation_market() returns trigger
language plpgsql
as $$
declare
  operation_market uuid;
begin
  if new.wallet_operation_id is null then
    return null;
  end if;

  -- FOR SHARE, not a bare read: the operation's market is immutable by trigger,
  -- and a trigger is a thing a privileged role can disable, so this does not
  -- rely on immutability for correctness. The share lock serializes this check
  -- against anything that changes or removes the operation row for the duration
  -- of the booking transaction.
  select w.market_id
  into operation_market
  from accounting.wallet_operations as w
  where w.wallet_operation_id = new.wallet_operation_id
  for share;

  if not found then
    -- `ledger_transactions_wallet_operation_*_fk` is the authority on existence
    -- and has already rejected this row; there is nothing to compare against.
    return null;
  end if;

  if operation_market is null then
    -- A genuinely marketless operation (APPROVE_ERC20, APPROVE_ERC1155, and a
    -- collateral TRANSFER) constrains nothing here.
    return null;
  end if;

  if new.market_id is distinct from operation_market then
    raise exception
      using errcode = 'PMB12',
        message = format(
          'ledger transaction %s books wallet operation %s of market %s, but names market %s',
          new.ledger_transaction_id, new.wallet_operation_id, operation_market,
          coalesce(new.market_id::text, 'none')
        ),
        hint = 'A transaction that books a market-bearing wallet operation names that operation''s own market (§9.14, §9.15, ADR-006 §1).';
  end if;

  return null;
end;
$$;

comment on function accounting.assert_ledger_wallet_operation_market() is
  'Rejects a ledger transaction whose market is not the market of the wallet operation it books (§9.14, §9.15). Conditional: an operation with no market constrains nothing.';

-- AFTER INSERT OR UPDATE, and NOT DEFERRABLE, so the check cannot be postponed
-- past the statement by a session that sets constraints deferred. The UPDATE
-- event is redundant today — `ledger_transactions` is append-only — and is
-- present because the append-only guard is itself a trigger (see the README's
-- privilege note): two independent triggers have to be disabled to get around
-- this, not one.
create constraint trigger ledger_transactions_wallet_operation_market
  after insert or update on accounting.ledger_transactions
  for each row execute function accounting.assert_ledger_wallet_operation_market();

-- ---------------------------------------------------------------------------
-- ledger_entries — per-asset balanced entries (§10.7)
-- ---------------------------------------------------------------------------

create table accounting.ledger_entries (
  ledger_entry_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  ledger_transaction_id internal.uuid_v7 not null
    references accounting.ledger_transactions (ledger_transaction_id),
  entry_ordinal integer not null,
  scope internal.ledger_scope not null,
  -- Deliberately NOT bound to `ledger_transactions.account_ref`, and this is the
  -- column that says where value went. The header account is the initiating
  -- scope — whose action this was — while the entry accounts are the legs, and a
  -- transfer between two accounts is one transaction with legs in two of them.
  -- Binding the legs to the header would make that unrepresentable. Anything
  -- reading a position, a net movement, or a per-account balance therefore reads
  -- *this* column and never the header's — `netByAsset()` in this package's
  -- ledger repository is the worked example.
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
--
-- `reserved_amount` is NOT an ordinary writable column. It is a projection of
-- the reservation facts in `accounting.inventory_reservations`, maintained by
-- the trigger below and validated on every write by
-- `accounting.assert_reserved_amount_matches_reservations()`. Before that
-- guard existed the CHECK compared `actual_amount` against a value any writer
-- could lower: reserve 100 of 100, set `reserved_amount` to '0', reserve
-- another 100, and the projection reported 200 reserved against 100 held. The
-- facts are now authoritative for every writer, not only for the repository.

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

-- The identity of a balance is not a mutable field.
--
-- `(account_ref, environment, asset_id)` is the primary key, and PostgreSQL lets
-- an UPDATE change a primary key. The reservation guard below judges a write by
-- the key the row will have, so
--
--   update accounting.balance_projection
--      set account_ref = 'other', reserved_amount = '0'
--    where account_ref = 'original' ...
--
-- passed whenever the destination key had no reservations (expected total 0,
-- supplied 0), and left the original account's reservations pointing at a
-- balance row that no longer existed — the same oversubscription the round-1
-- guard closed, reached by moving the balance instead of by rewriting it. A
-- projection row is *identified* by the account, environment, and asset it
-- projects; a different key is a different row, written as such.
create trigger balance_projection_immutable_key
  before update on accounting.balance_projection
  for each row execute function internal.forbid_column_change(
    'account_ref', 'environment', 'asset_id'
  );

create trigger balance_projection_set_updated_at
  before update on accounting.balance_projection
  for each row execute function internal.set_updated_at();

comment on column accounting.balance_projection.reserved_amount is
  'Maintained from accounting.inventory_reservations by trigger. Not directly writable: any write that disagrees with the active reservations raises PMB08.';

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

-- Sums the reservations that currently constrain one balance.
--
-- One definition, used by both the maintaining trigger and the guard that
-- validates every write to `balance_projection`, so the projection and its
-- validation can never drift apart. STABLE (not IMMUTABLE): it reads a table.
create function accounting.active_reserved_amount(
  target_account_ref text,
  target_environment internal.run_mode,
  target_asset_id text
) returns numeric
language sql
stable
parallel safe
as $$
  select coalesce(sum(r.amount::numeric), 0)
  from accounting.inventory_reservations as r
  where r.account_ref = target_account_ref
    and r.environment = target_environment
    and r.asset_id = target_asset_id
    and r.status = 'ACTIVE';
$$;

comment on function accounting.active_reserved_amount(text, internal.run_mode, text) is
  'Exact sum of the ACTIVE reservations constraining one balance (§9.14, §10.7).';

-- A reservation constrains availability the moment it exists, and stops
-- constraining only when it is released or consumed. `reserved_amount` is
-- recomputed here from the reservation rows rather than incremented by a
-- delta, so the projection is a function of the facts and cannot drift from
-- them — an incremented counter is only ever as correct as every write that
-- ever touched it.
--
-- The row lock is taken *before* the sum is read: a concurrent reserver's own
-- maintenance has to take the same lock, so it cannot commit between this
-- session's read and its write. That is what makes two simultaneous
-- reservations of one balance serialize instead of both reading a stale total.
create function accounting.apply_inventory_reservation() returns trigger
language plpgsql
as $$
declare
  target_account_ref text;
  target_environment internal.run_mode;
  target_asset_id text;
  reserved_total numeric;
  affected integer;
begin
  if tg_op = 'DELETE' then
    target_account_ref := old.account_ref;
    target_environment := old.environment;
    target_asset_id := old.asset_id;
  else
    target_account_ref := new.account_ref;
    target_environment := new.environment;
    target_asset_id := new.asset_id;
  end if;

  perform 1
  from accounting.balance_projection as b
  where b.account_ref = target_account_ref
    and b.environment = target_environment
    and b.asset_id = target_asset_id
  for update;

  reserved_total := accounting.active_reserved_amount(
    target_account_ref, target_environment, target_asset_id
  );

  update accounting.balance_projection as b
  set reserved_amount = internal.decimal_text(reserved_total),
      updated_at = now()
  where b.account_ref = target_account_ref
    and b.environment = target_environment
    and b.asset_id = target_asset_id;

  get diagnostics affected = row_count;

  if affected = 0 and tg_op <> 'DELETE' then
    raise exception
      using errcode = 'PMB09',
        message = format(
          'no balance projection row for account %s, environment %s, asset %s',
          target_account_ref, target_environment, target_asset_id
        ),
        hint = 'A reservation constrains a known balance; create the balance row first (§9.14).';
  end if;

  return null;
end;
$$;

-- DELETE is covered too: a deleted reservation stops constraining, and leaving
-- the projection behind would both overstate the reservation and deadlock every
-- later write against the guard below.
create trigger inventory_reservations_apply
  after insert or update or delete on accounting.inventory_reservations
  for each row execute function accounting.apply_inventory_reservation();

-- The guard that makes the reservation facts authoritative for ANY writer.
--
-- Every write to `balance_projection` must leave `reserved_amount` equal to the
-- sum of the ACTIVE reservations for that key: an UPDATE that disagrees is
-- rejected, an INSERT is corrected to the facts, and a balance row that
-- reservations still depend on cannot be deleted (delete-then-reinsert was the
-- other half of the bypass). PostgreSQL takes the row lock before firing a
-- BEFORE ROW trigger on UPDATE and DELETE, so the sum below is read under that
-- lock.
create function accounting.assert_reserved_amount_matches_reservations() returns trigger
language plpgsql
as $$
declare
  reserved_total numeric;
begin
  if tg_op = 'DELETE' then
    reserved_total := accounting.active_reserved_amount(
      old.account_ref, old.environment, old.asset_id
    );
    if reserved_total <> 0 then
      raise exception
        using errcode = 'PMB08',
          message = format(
            'balance for account %s, environment %s, asset %s still has %s reserved',
            old.account_ref, old.environment, old.asset_id, reserved_total
          ),
          hint = 'Release the reservations before removing the balance they constrain (§9.14).';
    end if;
    return old;
  end if;

  reserved_total := accounting.active_reserved_amount(
    new.account_ref, new.environment, new.asset_id
  );

  if tg_op = 'INSERT' then
    -- An INSERT establishes the row, so there is no prior value to contradict:
    -- the facts are simply written in. This also keeps the ordinary
    -- `insert ... on conflict do update` rebuild working, because PostgreSQL
    -- fires BEFORE INSERT on the speculative row before it discovers the
    -- conflict — rejecting there would break every upsert on a balance that has
    -- reservations, while correcting is exactly as authoritative.
    new.reserved_amount := internal.decimal_text(reserved_total);
    return new;
  end if;

  if new.reserved_amount::numeric <> reserved_total then
    raise exception
      using errcode = 'PMB08',
        message = format(
          'reserved_amount %s for account %s, environment %s, asset %s does not match the %s actually reserved',
          new.reserved_amount, new.account_ref, new.environment, new.asset_id, reserved_total
        ),
        hint = 'reserved_amount is maintained from accounting.inventory_reservations; write a reservation, not the projection (§10.7).';
  end if;

  return new;
end;
$$;

comment on function accounting.assert_reserved_amount_matches_reservations() is
  'Rejects any write that would make balance_projection.reserved_amount disagree with the active reservations (§10.7). SQLSTATE PMB08.';

create trigger balance_projection_reserved_amount_authoritative
  before insert or update or delete on accounting.balance_projection
  for each row execute function accounting.assert_reserved_amount_matches_reservations();

-- Neither table may be truncated: TRUNCATE fires no row-level trigger, so it
-- would be the one statement that could empty the reservation facts, or the
-- balances they constrain, without either guard above ever running.
create trigger balance_projection_no_truncate
  before truncate on accounting.balance_projection
  for each statement execute function internal.forbid_truncate();

create trigger inventory_reservations_no_truncate
  before truncate on accounting.inventory_reservations
  for each statement execute function internal.forbid_truncate();

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
