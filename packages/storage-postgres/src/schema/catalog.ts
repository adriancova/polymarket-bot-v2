/**
 * `catalog` schema table types (handoff §10.1).
 *
 * Mirrors `db/migrations/0002_catalog.up.sql` exactly. Nullable columns are
 * `| null`; columns with a database default are `WithDefault<T>`; append-only
 * tables are wrapped in `AppendOnlyTable`.
 */

import type {
  AppendOnlyTable,
  Code,
  DecimalString,
  Detail,
  Identifier,
  JsonColumn,
  JsonColumnWithDefault,
  Sha256Hex,
  TextArrayColumn,
  TimestampColumn,
  TimestampColumnWithDefault,
  TokenId,
  Uuid,
  UuidV7Column,
  WithDefault,
} from "./columns.js";
import type {
  ComparisonOperatorValue,
  EventSourceValue,
  MarketLifecycleStateValue,
  MarketOutcomeStateValue,
  ObservationTypeValue,
  OutcomeSideValue,
  PayoffModelValue,
  RewardProgramTypeValue,
  TradingParameterKindValue,
  VerificationStatusValue,
} from "./enums.js";

/** §10.1 `series` — stable rolling market families. */
export type CatalogSeriesTable = {
  series_id: WithDefault<UuidV7Column>;
  series_key: Code;
  display_name: Identifier;
  underlying_symbol: Code;
  cadence: Code | null;
  description: Detail | null;
  /** §9.2: "a new market pattern is not auto-approved for live trading". */
  binding_approved: WithDefault<boolean>;
  binding_approved_by: Identifier | null;
  binding_approved_at: TimestampColumn | null;
  active_settlement_spec_id: UuidV7Column | null;
  active: WithDefault<boolean>;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.1 `markets` — internal identity and the current mutable projection. */
export type CatalogMarketsTable = {
  market_id: WithDefault<UuidV7Column>;
  condition_id: Identifier;
  venue_event_id: Identifier | null;
  venue_market_slug: Identifier | null;
  series_id: UuidV7Column | null;
  question_title: Detail;
  lifecycle_state: WithDefault<MarketLifecycleStateValue>;
  outcome_state: WithDefault<MarketOutcomeStateValue>;
  current_parameters_version: WithDefault<number>;
  current_rule_version_id: UuidV7Column | null;
  neg_risk: WithDefault<boolean>;
  tick_size: DecimalString;
  minimum_order_size: DecimalString;
  trading_delay_seconds: WithDefault<number>;
  open_time: TimestampColumn | null;
  close_time: TimestampColumn | null;
  resolved_at: TimestampColumn | null;
  raw_metadata: JsonColumnWithDefault;
  first_seen_at: TimestampColumnWithDefault;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.1 `market_tokens` — outcome token mapping. */
export type CatalogMarketTokensTable = {
  market_token_id: WithDefault<UuidV7Column>;
  market_id: UuidV7Column;
  token_id: TokenId;
  outcome_side: OutcomeSideValue;
  outcome_label: Identifier;
  created_at: TimestampColumnWithDefault;
};

/** §10.1 `market_rule_versions` — immutable full rules and hashes (§10.7). */
export type CatalogMarketRuleVersionsTable = AppendOnlyTable<{
  rule_version_id: WithDefault<UuidV7Column>;
  market_id: UuidV7Column;
  rules_version: number;
  rules_text: string;
  rules_hash: Sha256Hex;
  source_url: Detail | null;
  source: WithDefault<EventSourceValue>;
  observed_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.1 `market_clarifications` — context observed after opening. */
export type CatalogMarketClarificationsTable = AppendOnlyTable<{
  clarification_id: WithDefault<UuidV7Column>;
  market_id: UuidV7Column;
  rule_version_id: UuidV7Column | null;
  clarification_text: string;
  clarification_hash: Sha256Hex;
  source: EventSourceValue;
  source_url: Detail | null;
  observed_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.1 `fee_schedule_snapshots` — versioned fee parameters (§9.13). */
export type CatalogFeeScheduleSnapshotsTable = AppendOnlyTable<{
  fee_schedule_id: WithDefault<UuidV7Column>;
  scope_key: Code;
  market_id: UuidV7Column | null;
  series_id: UuidV7Column | null;
  taker_fee_rate: DecimalString;
  maker_fee_rate: DecimalString;
  minimum_charged_fee: DecimalString;
  fee_formula: Detail;
  rounding_decimals: number;
  /** ADR-006 §7: the denomination is explicit; USDC and pUSD are not equal. */
  denomination_asset: Identifier;
  source_url: Detail;
  observed_at: TimestampColumn;
  effective_from: TimestampColumn;
  effective_to: TimestampColumn | null;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.1 `reward_program_snapshots` — maker/taker/liquidity-reward rules. */
export type CatalogRewardProgramSnapshotsTable = AppendOnlyTable<{
  reward_program_id: WithDefault<UuidV7Column>;
  program_type: RewardProgramTypeValue;
  scope_key: Code;
  market_id: UuidV7Column | null;
  series_id: UuidV7Column | null;
  parameters: JsonColumn;
  payout_denomination_asset: Identifier;
  minimum_accrual: DecimalString;
  payout_cadence: Code;
  source_url: Detail;
  observed_at: TimestampColumn;
  effective_from: TimestampColumn;
  effective_to: TimestampColumn | null;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.1 `market_parameter_history` — versioned parameters (§6 invariant 9). */
export type CatalogMarketParameterHistoryTable = AppendOnlyTable<{
  parameter_version_id: WithDefault<UuidV7Column>;
  market_id: UuidV7Column;
  parameters_version: number;
  previous_parameters_version: number | null;
  changed_parameters: TextArrayColumn<TradingParameterKindValue>;
  tick_size: DecimalString;
  minimum_order_size: DecimalString;
  trading_delay_seconds: number;
  neg_risk: boolean;
  lifecycle_state: MarketLifecycleStateValue;
  fee_schedule_id: UuidV7Column | null;
  open_time: TimestampColumn | null;
  close_time: TimestampColumn | null;
  source: EventSourceValue;
  source_event_id: Uuid | null;
  observed_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.1 `settlement_specs` — structured, reviewed payoff semantics (§9.3). */
export type CatalogSettlementSpecsTable = {
  settlement_spec_id: WithDefault<UuidV7Column>;
  series_id: UuidV7Column;
  spec_version: number;
  rules_version_id: UuidV7Column | null;
  resolution_source: Detail;
  reference_symbol: Code;
  observation_type: ObservationTypeValue;
  window_seconds: number | null;
  window_start_rule: Detail | null;
  window_end_rule: Detail | null;
  comparison: ComparisonOperatorValue | null;
  strike_source: Detail | null;
  reference_open_source: Detail | null;
  timestamp_boundary: Detail | null;
  rounding_rule: Detail | null;
  fallback_source: Detail | null;
  dispute_policy: Detail | null;
  clarification_policy: Detail | null;
  payoff_model: PayoffModelValue;
  verification_status: WithDefault<VerificationStatusValue>;
  verified_by: Identifier | null;
  verified_at: TimestampColumn | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.1 `reference_instruments` — Binance, Coinbase, RTDS symbol mappings. */
export type CatalogReferenceInstrumentsTable = {
  reference_instrument_id: WithDefault<UuidV7Column>;
  venue: EventSourceValue;
  venue_symbol: Identifier;
  underlying_symbol: Code;
  quote_symbol: Code;
  instrument_kind: Code;
  price_decimals: number | null;
  description: Detail | null;
  active: WithDefault<boolean>;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** Every `catalog` table, keyed by its qualified name. */
export type CatalogSchema = {
  "catalog.series": CatalogSeriesTable;
  "catalog.markets": CatalogMarketsTable;
  "catalog.market_tokens": CatalogMarketTokensTable;
  "catalog.market_rule_versions": CatalogMarketRuleVersionsTable;
  "catalog.market_clarifications": CatalogMarketClarificationsTable;
  "catalog.fee_schedule_snapshots": CatalogFeeScheduleSnapshotsTable;
  "catalog.reward_program_snapshots": CatalogRewardProgramSnapshotsTable;
  "catalog.market_parameter_history": CatalogMarketParameterHistoryTable;
  "catalog.settlement_specs": CatalogSettlementSpecsTable;
  "catalog.reference_instruments": CatalogReferenceInstrumentsTable;
};
