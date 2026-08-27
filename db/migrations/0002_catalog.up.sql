-- WP-040 / migration 0002 — `catalog` schema (handoff §10.1).
--
-- | Table | Purpose |
-- |---|---|
-- | series                    | Stable rolling market families |
-- | markets                   | Internal market identity and current projection |
-- | market_tokens             | Outcome token mapping |
-- | market_rule_versions      | Immutable full rules and hashes |
-- | market_clarifications     | Additional context observed after opening |
-- | settlement_specs          | Structured, reviewed payoff semantics |
-- | market_parameter_history  | Tick, minimum size, delay, negRisk, fees, status |
-- | fee_schedule_snapshots    | Current and historical fee parameters |
-- | reward_program_snapshots  | Maker/taker/liquidity-reward rules |
-- | reference_instruments     | Binance, Coinbase, RTDS symbol mappings |

create schema catalog;

comment on schema catalog is
  'Handoff §10.1: market identity, versioned rules and parameters, settlement specs, fee/reward snapshots.';

-- ---------------------------------------------------------------------------
-- series — stable rolling market families (e.g. btc-15m-updown)
-- ---------------------------------------------------------------------------

create table catalog.series (
  series_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  series_key internal.code not null unique,
  display_name internal.identifier not null,
  underlying_symbol internal.code not null,
  cadence internal.code,
  description internal.detail,
  -- §9.2: "Series binding is configuration, not heuristic-only." A suggested
  -- match is recorded but is not an approval.
  binding_approved boolean not null default false,
  binding_approved_by internal.identifier,
  binding_approved_at timestamptz,
  active_settlement_spec_id internal.uuid_v7,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint series_binding_approval_complete check (
    binding_approved = (binding_approved_by is not null and binding_approved_at is not null)
  )
);

create trigger series_set_updated_at
  before update on catalog.series
  for each row execute function internal.set_updated_at();

-- ---------------------------------------------------------------------------
-- markets — internal market identity and current (mutable) projection
-- ---------------------------------------------------------------------------

create table catalog.markets (
  market_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  condition_id internal.identifier not null,
  venue_event_id internal.identifier,
  venue_market_slug internal.identifier,
  series_id internal.uuid_v7 references catalog.series (series_id),
  question_title internal.detail not null,
  lifecycle_state internal.market_lifecycle_state not null default 'DISCOVERED',
  outcome_state internal.market_outcome_state not null default 'PENDING',
  -- Current values of the versioned parameter set. The authoritative history is
  -- catalog.market_parameter_history (§6 invariant 9).
  current_parameters_version integer not null default 1,
  current_rule_version_id internal.uuid_v7,
  neg_risk boolean not null default false,
  tick_size internal.positive_decimal_string not null,
  minimum_order_size internal.positive_decimal_string not null,
  trading_delay_seconds integer not null default 0,
  open_time timestamptz,
  close_time timestamptz,
  resolved_at timestamptz,
  raw_metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint markets_condition_id_unique unique (condition_id),
  constraint markets_parameters_version_positive check (current_parameters_version >= 1),
  constraint markets_trading_delay_non_negative check (trading_delay_seconds >= 0),
  constraint markets_close_after_open check (
    open_time is null or close_time is null or close_time > open_time
  ),
  constraint markets_resolved_has_timestamp check (
    (lifecycle_state = 'RESOLVED') = (resolved_at is not null)
  )
);

create index markets_series_idx on catalog.markets (series_id);
create index markets_lifecycle_close_idx on catalog.markets (lifecycle_state, close_time);

create trigger markets_set_updated_at
  before update on catalog.markets
  for each row execute function internal.set_updated_at();

-- The venue identity of a market never changes; only its projection does.
create trigger markets_immutable_identity
  before update on catalog.markets
  for each row execute function internal.forbid_column_change('market_id', 'condition_id');

-- ---------------------------------------------------------------------------
-- market_tokens — outcome token mapping
-- ---------------------------------------------------------------------------

create table catalog.market_tokens (
  market_token_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  token_id internal.token_id not null,
  outcome_side internal.outcome_side not null,
  outcome_label internal.identifier not null,
  created_at timestamptz not null default now(),
  constraint market_tokens_token_unique unique (token_id),
  constraint market_tokens_side_unique unique (market_id, outcome_side)
);

create index market_tokens_market_idx on catalog.market_tokens (market_id);

-- ---------------------------------------------------------------------------
-- market_rule_versions — immutable full rules and hashes (§10.7)
-- ---------------------------------------------------------------------------

create table catalog.market_rule_versions (
  rule_version_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  rules_version integer not null,
  rules_text text not null,
  rules_hash internal.sha256_hex not null,
  source_url internal.detail,
  source internal.event_source not null default 'polymarket',
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint market_rule_versions_version_unique unique (market_id, rules_version),
  constraint market_rule_versions_hash_unique unique (market_id, rules_hash),
  constraint market_rule_versions_version_positive check (rules_version >= 1)
);

create index market_rule_versions_market_idx
  on catalog.market_rule_versions (market_id, rules_version desc);

-- §10.7: "Immutable strategy configs and market rule versions."
call internal.enforce_append_only('catalog', 'market_rule_versions');

alter table catalog.markets
  add constraint markets_current_rule_version_fk
  foreign key (current_rule_version_id)
  references catalog.market_rule_versions (rule_version_id);

-- ---------------------------------------------------------------------------
-- market_clarifications — context observed after opening
-- ---------------------------------------------------------------------------

create table catalog.market_clarifications (
  clarification_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  rule_version_id internal.uuid_v7 references catalog.market_rule_versions (rule_version_id),
  clarification_text text not null,
  clarification_hash internal.sha256_hex not null,
  source internal.event_source not null,
  source_url internal.detail,
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint market_clarifications_hash_unique unique (market_id, clarification_hash)
);

create index market_clarifications_market_idx
  on catalog.market_clarifications (market_id, observed_at desc);

call internal.enforce_append_only('catalog', 'market_clarifications');

-- ---------------------------------------------------------------------------
-- fee_schedule_snapshots — current and historical fee parameters
-- ---------------------------------------------------------------------------
--
-- §9.13: "Limits are configuration snapshots with source and effective time. Do
-- not hardcode the example values in the product design." ADR-006 §7: the
-- denomination is carried explicitly because the USDC/pUSD question (venue
-- conflict C-2) is UNRESOLVED.

create table catalog.fee_schedule_snapshots (
  fee_schedule_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  scope_key internal.code not null,
  market_id internal.uuid_v7 references catalog.markets (market_id),
  series_id internal.uuid_v7 references catalog.series (series_id),
  taker_fee_rate internal.non_negative_decimal_string not null,
  maker_fee_rate internal.non_negative_decimal_string not null,
  minimum_charged_fee internal.non_negative_decimal_string not null,
  fee_formula internal.detail not null,
  rounding_decimals integer not null,
  denomination_asset internal.identifier not null,
  source_url internal.detail not null,
  observed_at timestamptz not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  recorded_at timestamptz not null default now(),
  constraint fee_schedule_rounding_non_negative check (rounding_decimals >= 0),
  constraint fee_schedule_effective_window check (
    effective_to is null or effective_to > effective_from
  )
);

create index fee_schedule_scope_idx
  on catalog.fee_schedule_snapshots (scope_key, effective_from desc);

call internal.enforce_append_only('catalog', 'fee_schedule_snapshots');

-- ---------------------------------------------------------------------------
-- reward_program_snapshots — maker/taker/liquidity-reward rules
-- ---------------------------------------------------------------------------

create table catalog.reward_program_snapshots (
  reward_program_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  program_type internal.reward_program_type not null,
  scope_key internal.code not null,
  market_id internal.uuid_v7 references catalog.markets (market_id),
  series_id internal.uuid_v7 references catalog.series (series_id),
  parameters jsonb not null,
  payout_denomination_asset internal.identifier not null,
  minimum_accrual internal.non_negative_decimal_string not null,
  payout_cadence internal.code not null,
  source_url internal.detail not null,
  observed_at timestamptz not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  recorded_at timestamptz not null default now(),
  constraint reward_program_effective_window check (
    effective_to is null or effective_to > effective_from
  )
);

create index reward_program_scope_idx
  on catalog.reward_program_snapshots (program_type, scope_key, effective_from desc);

call internal.enforce_append_only('catalog', 'reward_program_snapshots');

-- ---------------------------------------------------------------------------
-- market_parameter_history — versioned trading parameters (§6 invariant 9)
-- ---------------------------------------------------------------------------

create table catalog.market_parameter_history (
  parameter_version_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  parameters_version integer not null,
  previous_parameters_version integer,
  -- Validated element-by-element against internal.trading_parameter_kind by
  -- the trigger below; see internal.assert_text_array_elements().
  changed_parameters text [] not null,
  tick_size internal.positive_decimal_string not null,
  minimum_order_size internal.positive_decimal_string not null,
  trading_delay_seconds integer not null,
  neg_risk boolean not null,
  lifecycle_state internal.market_lifecycle_state not null,
  fee_schedule_id internal.uuid_v7 references catalog.fee_schedule_snapshots (fee_schedule_id),
  open_time timestamptz,
  close_time timestamptz,
  source internal.event_source not null,
  source_event_id uuid,
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint market_parameter_history_version_unique unique (market_id, parameters_version),
  constraint market_parameter_history_version_positive check (parameters_version >= 1),
  constraint market_parameter_history_version_advances check (
    previous_parameters_version is null
    or previous_parameters_version < parameters_version
  ),
  constraint market_parameter_history_changes_non_empty check (
    cardinality(changed_parameters) >= 1
  ),
  constraint market_parameter_history_delay_non_negative check (trading_delay_seconds >= 0)
);

create index market_parameter_history_market_idx
  on catalog.market_parameter_history (market_id, parameters_version desc);

create trigger market_parameter_history_valid_changed_parameters
  before insert on catalog.market_parameter_history
  for each row execute function internal.assert_text_array_elements(
    'changed_parameters', 'internal.trading_parameter_kind'
  );

call internal.enforce_append_only('catalog', 'market_parameter_history');

alter table catalog.markets
  add constraint markets_current_parameters_fk
  foreign key (market_id, current_parameters_version)
  references catalog.market_parameter_history (market_id, parameters_version)
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- settlement_specs — structured, reviewed payoff semantics (§9.3)
-- ---------------------------------------------------------------------------

create table catalog.settlement_specs (
  settlement_spec_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  series_id internal.uuid_v7 not null references catalog.series (series_id),
  spec_version integer not null,
  rules_version_id internal.uuid_v7 references catalog.market_rule_versions (rule_version_id),
  resolution_source internal.detail not null,
  reference_symbol internal.code not null,
  observation_type internal.observation_type not null,
  window_seconds integer,
  window_start_rule internal.detail,
  window_end_rule internal.detail,
  comparison internal.comparison_operator,
  strike_source internal.detail,
  reference_open_source internal.detail,
  timestamp_boundary internal.detail,
  rounding_rule internal.detail,
  fallback_source internal.detail,
  dispute_policy internal.detail,
  clarification_policy internal.detail,
  payoff_model internal.payoff_model not null,
  verification_status internal.verification_status not null default 'UNVERIFIED',
  verified_by internal.identifier,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint settlement_specs_version_unique unique (series_id, spec_version),
  constraint settlement_specs_version_positive check (spec_version >= 1),
  constraint settlement_specs_window_positive check (
    window_seconds is null or window_seconds > 0
  ),
  -- §9.3: a windowed observation needs a window.
  constraint settlement_specs_window_required check (
    observation_type not in ('TWAP', 'VWAP') or window_seconds is not null
  ),
  -- §9.3: "A terminal-spot model must not be used for a TWAP-settled market."
  constraint settlement_specs_model_matches_observation check (
    not (observation_type = 'TWAP' and payoff_model = 'TerminalSpotBinaryModel')
  ),
  -- §9.3 `verified_by` / `verified_at` are only meaningful once verified.
  constraint settlement_specs_verification_complete check (
    (verification_status = 'VERIFIED')
    = (verified_by is not null and verified_at is not null)
  )
);

create index settlement_specs_series_idx
  on catalog.settlement_specs (series_id, spec_version desc);

create trigger settlement_specs_set_updated_at
  before update on catalog.settlement_specs
  for each row execute function internal.set_updated_at();

-- The reviewed payoff semantics are versioned: a change produces a new
-- spec_version rather than an edit. Only the review outcome may be updated.
create trigger settlement_specs_immutable_semantics
  before update on catalog.settlement_specs
  for each row execute function internal.forbid_column_change(
    'settlement_spec_id', 'series_id', 'spec_version', 'resolution_source',
    'reference_symbol', 'observation_type', 'window_seconds', 'window_start_rule',
    'window_end_rule', 'comparison', 'strike_source', 'reference_open_source',
    'timestamp_boundary', 'rounding_rule', 'fallback_source', 'payoff_model'
  );

alter table catalog.series
  add constraint series_active_settlement_spec_fk
  foreign key (active_settlement_spec_id)
  references catalog.settlement_specs (settlement_spec_id);

-- ---------------------------------------------------------------------------
-- reference_instruments — Binance, Coinbase, RTDS symbol mappings
-- ---------------------------------------------------------------------------

create table catalog.reference_instruments (
  reference_instrument_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  venue internal.event_source not null,
  venue_symbol internal.identifier not null,
  underlying_symbol internal.code not null,
  quote_symbol internal.code not null,
  instrument_kind internal.code not null,
  price_decimals integer,
  description internal.detail,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reference_instruments_venue_symbol_unique unique (venue, venue_symbol),
  constraint reference_instruments_price_decimals_non_negative check (
    price_decimals is null or price_decimals >= 0
  ),
  -- §10.1 names Binance, Coinbase, and RTDS. 'internal' is not a reference venue.
  constraint reference_instruments_venue_is_reference check (
    venue in ('binance', 'coinbase', 'rtds', 'polymarket')
  )
);

create index reference_instruments_underlying_idx
  on catalog.reference_instruments (underlying_symbol, active);

create trigger reference_instruments_set_updated_at
  before update on catalog.reference_instruments
  for each row execute function internal.set_updated_at();
