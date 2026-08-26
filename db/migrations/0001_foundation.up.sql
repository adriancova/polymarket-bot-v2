-- WP-040 / migration 0001 — foundation for the six semantic schemas.
--
-- Authority: docs/spec/polymarket-bot-orchestrator-handoff.md §10 (database
-- model), §10.7 (required constraints), §10.8 (logical vs physical environment
-- separation), §7.2 (canonical identifiers), §7.3 (exact decimal types).
--
-- The `internal` schema holds NO business records. It holds the shared domains,
-- enumerations, and trigger functions that the six semantic schemas
-- (`catalog`, `data`, `strategy`, `execution`, `accounting`, `ops`) build on.
-- It is deliberately separate so that "the semantic model" stays exactly the
-- six schemas §10 names.

create schema internal;

comment on schema internal is
  'WP-040 infrastructure: shared domains, enums, and trigger functions. Holds no business records.';

-- ---------------------------------------------------------------------------
-- Sortable identifiers (§10.7 "UUIDv7 or equivalent sortable IDs")
-- ---------------------------------------------------------------------------

-- PostgreSQL 16 has no built-in uuidv7(). This is the standard construction:
-- take a v4 UUID (which already carries the correct variant bits), overlay the
-- 48-bit big-endian Unix-millisecond timestamp into the leading six bytes, then
-- turn the version nibble 0100 (v4) into 0111 (v7) by setting bits 52 and 53.
create function internal.uuid_generate_v7() returns uuid
language plpgsql
volatile
parallel safe
as $$
begin
  return encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(
            int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
            from 3
          )
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
end;
$$;

comment on function internal.uuid_generate_v7() is
  'RFC 9562 UUIDv7 (time-ordered). §10.7 requires sortable internal ids.';

-- Every internal primary key is declared with this domain, so a non-sortable
-- identifier cannot be inserted even by a caller that supplies its own id.
--
-- Both nibbles RFC 9562 pins are checked. The version nibble (character 15)
-- must be 7, and the variant nibble (character 19+1 = 20, the first character
-- of the fourth group) must be one of 8, 9, a, b — that is the two-bit RFC 4122
-- variant prefix `10`. Checking only the version would accept
-- `00000000-0000-7000-0000-000000000000`, which `isUuidV7()` in
-- `packages/storage-postgres/src/ids.ts` rejects; a value the client calls
-- invalid must not be storable.
create domain internal.uuid_v7 as uuid
  constraint uuid_v7_version check (substring(value::text from 15 for 1) = '7')
  constraint uuid_v7_variant check (substring(value::text from 20 for 1) ~ '^[89ab]$');

comment on domain internal.uuid_v7 is
  'A UUID whose version nibble is 7 and whose variant nibble is 8/9/a/b (time-ordered, sortable). §7.2, §10.7.';

-- ---------------------------------------------------------------------------
-- Exact decimal boundary types (§7.3, §6 invariant 1)
-- ---------------------------------------------------------------------------
--
-- Economic values are stored as TEXT in the canonical decimal grammar, never as
-- `double precision` and never as `numeric`:
--
--   * TEXT preserves exactly one representation per value, so equality, unique
--     constraints, and canonical hashes agree with `docs/contracts/domain.md`
--     §3.2. `numeric` would accept '1.50' and '1.5' as two spellings of one
--     value and would hand back whichever scale it stored.
--   * Aggregation inside constraint triggers casts to `numeric` (arbitrary
--     precision decimal), never to a floating-point type, so the checks are
--     exact.
--
-- Grammar (§7.3): -?(0|[1-9][0-9]*)(\.[0-9]*[1-9])? with canonical zero '0'.
-- No scientific notation, no leading '+', no '-0', no redundant leading or
-- trailing zeros, no trailing decimal point.

create domain internal.decimal_string as text
  constraint decimal_string_canonical
    check (value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
  constraint decimal_string_no_negative_zero check (value <> '-0')
  constraint decimal_string_bounded check (length(value) <= 1024);

create domain internal.non_negative_decimal_string as text
  constraint non_negative_decimal_string_canonical
    check (value ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
  constraint non_negative_decimal_string_bounded check (length(value) <= 1024);

create domain internal.positive_decimal_string as text
  constraint positive_decimal_string_canonical
    check (value ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
  constraint positive_decimal_string_non_zero check (value <> '0')
  constraint positive_decimal_string_bounded check (length(value) <= 1024);

-- A canonical decimal in the closed unit interval [0, 1] is exactly: '0', '1',
-- or '0.<digits ending in a non-zero digit>'. Expressing the range as a grammar
-- rather than a numeric comparison keeps the check free of any cast.
create domain internal.price_string as text
  constraint price_string_unit_interval
    check (value ~ '^(0|1|0\.[0-9]*[1-9])$')
  constraint price_string_bounded check (length(value) <= 1024);

comment on domain internal.price_string is
  'Canonical decimal in [0, 1] (§7.3 "Price must be in [0, 1] where context requires").';

-- Renders an exact `numeric` computed inside a constraint trigger back into the
-- canonical decimal grammar: `trim_scale` removes the trailing fractional zeros
-- that `numeric` carries in its scale, and `numeric` has no negative zero, so
-- the result is always canonical. Used only by projection-maintaining triggers;
-- no value ever passes through a floating-point type.
create function internal.decimal_text(value numeric) returns text
language sql
immutable
parallel safe
returns null on null input
as $$
  select trim_scale(value)::text;
$$;

-- ---------------------------------------------------------------------------
-- Non-economic string domains (docs/contracts/domain.md §7 boundary hygiene)
-- ---------------------------------------------------------------------------

create domain internal.identifier as text
  constraint identifier_bounded check (length(value) between 1 and 200);

create domain internal.code as text
  constraint code_grammar check (value ~ '^[A-Za-z][A-Za-z0-9_.:-]*$')
  constraint code_bounded check (length(value) <= 64);

create domain internal.detail as text
  constraint detail_bounded check (length(value) <= 2000);

-- Venue integer encoded as a string (§7.2 `TokenId`), canonical: no leading zeros.
create domain internal.token_id as text
  constraint token_id_canonical check (value ~ '^(0|[1-9][0-9]*)$')
  constraint token_id_bounded check (length(value) <= 200);

-- bigint-like values that cannot be held exactly by a JavaScript number
-- (`ingestSeq`, `receivedMonotonicNs`, `rawRecordOffset`): canonical unsigned
-- integer strings, per docs/contracts/domain.md §4.
create domain internal.uint_string as text
  constraint uint_string_canonical check (value ~ '^(0|[1-9][0-9]*)$')
  constraint uint_string_bounded check (length(value) <= 40);

create domain internal.sha256_hex as text
  constraint sha256_hex_format check (value ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------

-- §11 run modes. Also the environment discriminator (§10.8): one semantic
-- schema, with every environment-scoped record naming its own environment so
-- that live and simulated records can share a model without mixing.
create type internal.run_mode as enum (
  'BACKTEST', 'PAPER', 'SHADOW', 'EXECUTION_PROBE', 'LIVE_MICRO', 'LIVE'
);

-- §7.1 envelope `source`.
create type internal.event_source as enum (
  'polymarket', 'binance', 'coinbase', 'rtds', 'internal'
);

-- §9.3 required outcome states.
create type internal.market_outcome_state as enum (
  'YES_WIN', 'NO_WIN', 'SPLIT_50_50', 'CANCELLED',
  'DISPUTED', 'PENDING', 'PENDING_CLARIFICATION'
);

-- Market lifecycle projection, from the §7.4 lifecycle events
-- (MarketDiscovered / MarketOpened / MarketClosing / MarketResolved).
create type internal.market_lifecycle_state as enum (
  'DISCOVERED', 'OPEN', 'CLOSING', 'CLOSED', 'RESOLVED'
);

create type internal.outcome_side as enum ('YES', 'NO');
create type internal.book_side as enum ('BID', 'ASK');
create type internal.order_side as enum ('BUY', 'SELL');

-- §9.3 settlement observation types and comparisons.
create type internal.observation_type as enum (
  'TERMINAL_SPOT', 'TWAP', 'VWAP', 'EVENT_RESULT', 'MANUAL_ORACLE'
);
create type internal.comparison_operator as enum ('GT', 'GTE', 'LT', 'LTE');

-- §9.3 payoff models.
create type internal.payoff_model as enum (
  'TerminalSpotBinaryModel', 'TwapBinaryModel',
  'ReferenceOpenUpDownModel', 'ThresholdByDateModel'
);

create type internal.verification_status as enum ('UNVERIFIED', 'VERIFIED', 'REJECTED');

-- §9.2 / §10.1 versioned trading parameters, matching
-- `TradingParameterKindSchema` in packages/domain (frozen vocabulary).
create type internal.trading_parameter_kind as enum (
  'tick_size', 'minimum_order_size', 'fee_schedule', 'trading_delay',
  'neg_risk', 'open_time', 'close_time', 'status'
);

-- The three incentive programs are distinct mechanisms (ADR-006 §6).
create type internal.reward_program_type as enum (
  'MAKER_REBATE', 'TAKER_REBATE', 'LIQUIDITY_REWARD'
);

-- §10.2 `data_quality_incidents`: "Gaps, staleness, corruption, resync windows".
create type internal.data_quality_incident_type as enum (
  'GAP', 'STALENESS', 'CORRUPTION', 'RESYNC_WINDOW'
);

-- §14.4 alert vocabulary, reused for incident severity
-- (docs/contracts/domain.md §8).
create type internal.incident_severity as enum ('LOG', 'NOTIFY', 'PAGE');
create type internal.incident_status as enum ('OPEN', 'MITIGATING', 'RESOLVED');

-- §9.9 incident controller action ladder.
create type internal.incident_action as enum (
  'HALT_NEW_ENTRIES', 'CANCEL_RESTING_ORDERS', 'RECONCILE_ACCOUNT',
  'MANAGE_KNOWN_POSITIONS_ONLY', 'PROTECTED_REDUCE', 'HOLD_TO_RESOLUTION',
  'FULL_HALT'
);

-- §9.11 order state machine.
create type internal.order_state as enum (
  'PLANNED', 'SIGNED', 'SENDING', 'ACKNOWLEDGED', 'LIVE', 'DELAYED',
  'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'REJECTED',
  'SUBMISSION_UNKNOWN', 'RECONCILING', 'EXPIRED'
);

-- §9.11 trade settlement state machine, plus `MATCHED_NOT_BROADCASTED`.
-- §9.11 lists five states; the SDK enumerates six and ADR-006 §5 names
-- `MATCHED_NOT_BROADCASTED` explicitly (venue report §4). A state the venue can
-- report but the table cannot record would be unrecordable venue truth, so it
-- is included here. See docs/handoffs/WP-040.md (deviations).
create type internal.trade_settlement_state as enum (
  'MATCHED_NOT_BROADCASTED', 'MATCHED', 'MINED', 'CONFIRMED', 'RETRYING', 'FAILED'
);

create type internal.liquidity_role as enum ('MAKER', 'TAKER');

-- §9.11 idempotent submission protocol, steps 4-7.
create type internal.submission_state as enum (
  'SIGNED', 'SENDING', 'RESPONDED', 'SUBMISSION_UNKNOWN', 'RECONCILING', 'ABANDONED'
);

-- §7.7 intent discriminators, matching `IntentTypeSchema` in packages/domain.
create type internal.intent_type as enum (
  'POSITION', 'QUOTE', 'BASKET', 'CANCEL', 'REDUCE_POSITION'
);

-- §7.5 decision types, matching `DecisionTypeSchema` in packages/domain.
create type internal.decision_type as enum (
  'enter', 'exit', 'quote', 'hold', 'skip', 'cancel', 'reduce'
);

-- §9.6 strategy callbacks; a decision record names the callback that produced it.
create type internal.strategy_callback as enum (
  'onStart', 'onMarketOpen', 'onFeatures', 'onFill', 'onOrderUpdate', 'onTimer',
  'onMarketClosing', 'onMarketResolved', 'onStop'
);

-- §6 invariant 11 / ADR-011: exactly one LIVE_OWNER per market per execution realm.
create type internal.ownership_mode as enum ('LIVE_OWNER', 'SHADOW', 'OBSERVER');
create type internal.ownership_status as enum ('ACTIVE', 'RELEASED');

create type internal.instance_status as enum ('ACTIVE', 'PAUSED', 'STOPPED');
create type internal.run_status as enum ('RUNNING', 'STOPPED', 'FAILED');

-- §9.18 / ADR-008: the fencing lease.
create type internal.lease_status as enum ('ACTIVE', 'EXPIRED', 'RELEASED', 'REVOKED');

-- §10.5 `inventory_reservations`.
create type internal.reservation_status as enum ('ACTIVE', 'RELEASED', 'CONSUMED');

-- §9.15 ledger scopes.
create type internal.ledger_scope as enum (
  'ACTUAL_ACCOUNT', 'VIRTUAL_STRATEGY', 'UNATTRIBUTED',
  'EXTERNAL_CLEARING', 'FEE_EXPENSE', 'REWARD_INCOME'
);

-- §9.15 ledger events.
create type internal.ledger_event_type as enum (
  'ORDER_RESERVATION', 'RESERVATION_RELEASE', 'TRADE_PRINCIPAL',
  'OUTCOME_TOKEN_RECEIPT', 'OUTCOME_TOKEN_DELIVERY', 'PLATFORM_FEE',
  'MAKER_REBATE_PAYOUT', 'TAKER_REBATE_PAYOUT', 'LIQUIDITY_REWARD',
  'SPLIT', 'MERGE', 'REDEEM', 'DEPOSIT_OBSERVED', 'WITHDRAWAL_OBSERVED',
  'MANUAL_ADJUSTMENT', 'RECONCILIATION_CORRECTION', 'RESOLUTION'
);

-- ADR-006 §7: there is no implicit "cash" asset; every entry names its asset
-- and the asset's kind. USDC and pUSD are NOT interchangeable (conflict C-2 is
-- unresolved), so the denomination is always carried explicitly as the asset id.
create type internal.asset_kind as enum ('COLLATERAL', 'OUTCOME_TOKEN');

-- §9.14 wallet operations.
create type internal.wallet_operation_type as enum (
  'APPROVE_ERC20', 'APPROVE_ERC1155', 'SPLIT', 'MERGE', 'REDEEM', 'TRANSFER'
);
create type internal.wallet_operation_state as enum (
  'PLANNED', 'SUBMITTED', 'MINED', 'CONFIRMED', 'FAILED', 'UNKNOWN', 'RECONCILING'
);

-- §14.1 kill switches.
create type internal.kill_switch_scope as enum (
  'GLOBAL', 'ACCOUNT', 'MARKET', 'STRATEGY_INSTANCE'
);
create type internal.kill_switch_action as enum (
  'HALT_NEW_ENTRIES', 'CANCEL_ALL', 'CANCEL_MARKET', 'MANAGE_POSITIONS_ONLY', 'FULL_HALT'
);
create type internal.actor_kind as enum ('HUMAN', 'AUTOMATED');

-- §9.8 risk gate outcomes.
create type internal.risk_outcome as enum ('APPROVED', 'RESIZED', 'VETOED', 'BREAKER');

-- §9.17 reconciliation.
create type internal.reconciliation_trigger as enum (
  'STARTUP', 'PERIODIC_TIMER', 'USER_STREAM_RECONNECT', 'MARKET_STREAM_GAP',
  'SUBMISSION_UNKNOWN', 'WALLET_OPERATION_UNKNOWN', 'MANUAL_REQUEST',
  'POSITION_BALANCE_DISCREPANCY'
);
create type internal.reconciliation_status as enum (
  'RUNNING', 'PASSED', 'FAILED', 'QUARANTINED'
);
create type internal.break_status as enum ('OPEN', 'RESOLVED', 'QUARANTINED');

-- §9.1 raw archive.
create type internal.segment_format as enum ('JSONL', 'PARQUET');

-- §9.13 rate-limit budgets.
create type internal.rate_limit_bucket_kind as enum (
  'IP_ENDPOINT_CLASS', 'SIGNER', 'ORDER', 'CANCEL', 'RELAYER'
);

-- §9.10 execution groups: slices or coordinated legs.
create type internal.execution_group_kind as enum ('SLICE', 'LEG');

-- §7.7 execution policy vocabularies, matching packages/domain.
create type internal.partial_fill_policy as enum ('REJECT', 'ACCEPT_ANY', 'ACCEPT_MINIMUM');
create type internal.liquidity_preference as enum (
  'MAKER_ONLY', 'MAKER_PREFERRED', 'TAKER_OK', 'TAKER_ONLY'
);

-- ---------------------------------------------------------------------------
-- Execution realm (§10.8, ADR-011 §1)
-- ---------------------------------------------------------------------------
--
-- Two run modes belong to the same realm when a record in one can create real
-- exposure that a record in the other must respect. All three real-order modes
-- share one realm, so a LIVE and a LIVE_MICRO owner of the same market collide.
-- Each simulated mode gets its own realm, so a PAPER or SHADOW owner never
-- blocks (or is blocked by) the live owner — that is exactly what §6 invariant
-- 11 permits ("Other strategies may observe or run in shadow mode") and what
-- §10.8 means by not baking live/backtest mixing into the model.
--
-- IMMUTABLE, because it is used in index predicates, index keys, and CHECKs.
create function internal.execution_realm(mode internal.run_mode) returns text
language sql
immutable
parallel safe
returns null on null input
as $$
  select case mode
    when 'BACKTEST' then 'SIMULATED:BACKTEST'
    when 'PAPER' then 'SIMULATED:PAPER'
    when 'SHADOW' then 'SIMULATED:SHADOW'
    else 'REAL'
  end;
$$;

comment on function internal.execution_realm(internal.run_mode) is
  'REAL for EXECUTION_PROBE/LIVE_MICRO/LIVE; a distinct simulated realm otherwise (§10.8, ADR-011).';

create function internal.is_real_order_mode(mode internal.run_mode) returns boolean
language sql
immutable
parallel safe
returns null on null input
as $$
  select internal.execution_realm(mode) = 'REAL';
$$;

-- ---------------------------------------------------------------------------
-- Append-only and immutability enforcement (§10.7)
-- ---------------------------------------------------------------------------
--
-- "Append-only event and ledger tables; updates are forbidden except explicitly
-- mutable projections." Enforcement is by trigger rather than by privilege
-- because a privilege grant protects only non-owner roles: the migration owner,
-- and any superuser, retains UPDATE/DELETE regardless. A BEFORE trigger rejects
-- the statement for every role including the owner. Revoking UPDATE/DELETE from
-- the application role is a complementary deployment control and is documented
-- in packages/storage-postgres/README.md; it is not a substitute.

create function internal.forbid_update_delete() returns trigger
language plpgsql
as $$
begin
  raise exception
    using errcode = 'PMB01',
      message = format(
        '%I.%I is append-only: %s is not permitted',
        tg_table_schema, tg_table_name, tg_op
      ),
      hint = 'Append a compensating record instead of rewriting history (handoff §10.7).';
end;
$$;

comment on function internal.forbid_update_delete() is
  'Append-only guard (§10.7). Raises SQLSTATE PMB01 on UPDATE, DELETE, or TRUNCATE.';

-- Guards individual columns of an otherwise-mutable row. Trigger arguments are
-- the column names that may never change after insert.
create function internal.forbid_column_change() returns trigger
language plpgsql
as $$
declare
  guarded_column text;
  old_row jsonb := to_jsonb(old);
  new_row jsonb := to_jsonb(new);
begin
  foreach guarded_column in array tg_argv loop
    if (old_row -> guarded_column) is distinct from (new_row -> guarded_column) then
      raise exception
        using errcode = 'PMB02',
          message = format(
            'column %I.%I.%I is immutable',
            tg_table_schema, tg_table_name, guarded_column
          );
    end if;
  end loop;
  return new;
end;
$$;

-- Validates every element of a `text[]` column against a type or domain.
--
-- The columns that hold a controlled vocabulary are declared `text[]` rather
-- than `<enum>[]` for one concrete reason: the PostgreSQL wire protocol returns
-- an array of a built-in type in a form the client parses into a list, while an
-- array of a custom enum or domain comes back as an unparsed array literal
-- (`{tick_size}`). Storing `text[]` and validating here keeps the vocabulary
-- defined exactly once — in the enum type — while the repository API still
-- returns a real array.
create function internal.assert_text_array_elements() returns trigger
language plpgsql
as $$
declare
  target_column text := tg_argv[0];
  element_type text := tg_argv[1];
  column_value jsonb := to_jsonb(new) -> tg_argv[0];
  element text;
begin
  if column_value is null or jsonb_typeof(column_value) = 'null' then
    return new;
  end if;

  for element in select jsonb_array_elements_text(column_value)
  loop
    -- A NULL element is not a member of the vocabulary: `null::internal.code`
    -- casts without error, so the cast below cannot be trusted to reject it.
    -- An unlabelled reason code or parameter kind would silently widen the
    -- vocabulary the enum exists to close.
    if element is null then
      raise exception
        using errcode = '23514',
          message = format(
            'column %I.%I.%I must not contain a NULL element',
            tg_table_schema, tg_table_name, target_column
          ),
          hint = 'Every element names a value of the controlled vocabulary; omit the element instead.';
    end if;

    -- `element_type` comes from the migration, never from data.
    execute format('select %L::%s', element, element_type);
  end loop;
  return new;
end;
$$;

comment on function internal.assert_text_array_elements() is
  'Checks each element of a text[] column against a type or domain named in the trigger arguments, and rejects NULL elements.';

-- TRUNCATE is not an UPDATE or a DELETE, so no row-level guard sees it. A
-- mutable table whose rows are still *facts* — a reservation, the projection a
-- reservation constrains — therefore needs a statement-level guard of its own,
-- or the row-level invariant can be emptied out from under itself.
create function internal.forbid_truncate() returns trigger
language plpgsql
as $$
begin
  raise exception
    using errcode = 'PMB01',
      message = format('%I.%I may not be truncated', tg_table_schema, tg_table_name),
      hint = 'Release or delete the rows individually, so the guards that depend on them run.';
end;
$$;

comment on function internal.forbid_truncate() is
  'Statement-level TRUNCATE guard for mutable tables whose rows other invariants depend on.';

create function internal.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Attaches the append-only guard to a table, including TRUNCATE.
create procedure internal.enforce_append_only(target_schema text, target_table text)
language plpgsql
as $$
begin
  execute format(
    'create trigger %I before update or delete on %I.%I '
    || 'for each row execute function internal.forbid_update_delete()',
    target_table || '_append_only', target_schema, target_table
  );
  execute format(
    'create trigger %I before truncate on %I.%I '
    || 'for each statement execute function internal.forbid_update_delete()',
    target_table || '_no_truncate', target_schema, target_table
  );
end;
$$;

comment on procedure internal.enforce_append_only(text, text) is
  'Attaches the §10.7 append-only guard (UPDATE, DELETE, and TRUNCATE) to a table.';
