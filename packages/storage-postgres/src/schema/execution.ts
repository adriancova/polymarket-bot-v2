/**
 * `execution` schema table types (handoff §10.4).
 *
 * Mirrors `db/migrations/0005_execution.up.sql`.
 *
 * Every price, size, fee, and notional below is a `DecimalString`. A `number`
 * here would violate §6 invariant 1 and would be rejected by the underlying
 * PostgreSQL domain anyway.
 */

import type {
  AppendOnlyTable,
  BigIntColumn,
  Code,
  DecimalString,
  Detail,
  Identifier,
  DecimalSafeJsonColumn,
  JsonColumnWithDefault,
  NullableDecimalSafeJsonColumn,
  NullableJsonColumn,
  Sha256Hex,
  TimestampColumn,
  TimestampColumnWithDefault,
  TokenId,
  UuidV7Column,
  WithDefault,
} from "./columns.js";
import type {
  EventSourceValue,
  ExecutionGroupKindValue,
  LedgerScopeValue,
  LiquidityPreferenceValue,
  LiquidityRoleValue,
  OrderSideValue,
  OrderStateValue,
  PartialFillPolicyValue,
  RateLimitBucketKindValue,
  RunModeValue,
  SubmissionStateValue,
  TradeSettlementStateValue,
} from "./enums.js";

/** §10.4 `plans` — immutable execution plans (§9.10). */
export type ExecutionPlansTable = AppendOnlyTable<{
  plan_id: WithDefault<UuidV7Column>;
  approved_intent_id: UuidV7Column;
  run_id: UuidV7Column;
  instance_id: UuidV7Column;
  market_id: UuidV7Column;
  environment: RunModeValue;
  account_ref: Identifier | null;
  token_id: TokenId;
  side: OrderSideValue;
  liquidity_preference: LiquidityPreferenceValue;
  partial_fill_policy: PartialFillPolicyValue;
  planned_price: DecimalString | null;
  planned_shares: DecimalString;
  minimum_fill_shares: DecimalString | null;
  slice_count: WithDefault<number>;
  cancel_replace_threshold_ticks: number | null;
  deadline_at: TimestampColumn | null;
  escalation_policy: Detail | null;
  estimated_fee: DecimalString | null;
  estimated_slippage: DecimalString | null;
  estimated_proceeds: DecimalString | null;
  parameters_version: number;
  tick_size: DecimalString;
  fee_schedule_id: UuidV7Column | null;
  plan_hash: Sha256Hex;
  planned_at: TimestampColumnWithDefault;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.4 `groups` — slices or coordinated legs. */
export type ExecutionGroupsTable = AppendOnlyTable<{
  execution_group_id: WithDefault<UuidV7Column>;
  plan_id: UuidV7Column;
  group_ordinal: number;
  group_kind: ExecutionGroupKindValue;
  token_id: TokenId;
  side: OrderSideValue;
  limit_price: DecimalString;
  shares: DecimalString;
  release_after_group_id: UuidV7Column | null;
  leg_risk_limit: DecimalString | null;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.4 `submission_attempts` — signed payloads and uncertainty state (§9.11). */
export type ExecutionSubmissionAttemptsTable = {
  submission_attempt_id: WithDefault<UuidV7Column>;
  execution_group_id: UuidV7Column;
  plan_id: UuidV7Column;
  environment: RunModeValue;
  account_ref: Identifier | null;
  attempt_ordinal: WithDefault<number>;
  /** ADR-008: persisted with every live submission. */
  fencing_lease_id: UuidV7Column | null;
  fencing_token: BigIntColumn | null;
  /**
   * The signed order as sent. Its price and size are canonical decimal strings:
   * a `number` here would be a different order than the one that was signed.
   */
  signed_payload: DecimalSafeJsonColumn;
  salt: Identifier;
  /** §10.7: unique where known. NULL is "not yet known", never "rejected". */
  expected_order_hash: Identifier | null;
  state: WithDefault<SubmissionStateValue>;
  request_sent_at: TimestampColumn | null;
  response_received_at: TimestampColumn | null;
  response_status: Code | null;
  response_payload: NullableJsonColumn;
  venue_order_id: Identifier | null;
  error_code: Code | null;
  error_detail: Detail | null;
  signed_at: TimestampColumnWithDefault;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.4 `orders` — current order projection (mutable; history in order_events). */
export type ExecutionOrdersTable = {
  order_id: WithDefault<UuidV7Column>;
  submission_attempt_id: UuidV7Column | null;
  plan_id: UuidV7Column;
  execution_group_id: UuidV7Column | null;
  market_id: UuidV7Column;
  token_id: TokenId;
  environment: RunModeValue;
  account_ref: Identifier | null;
  side: OrderSideValue;
  limit_price: DecimalString;
  original_shares: DecimalString;
  filled_shares: WithDefault<DecimalString>;
  state: WithDefault<OrderStateValue>;
  venue_order_id: Identifier | null;
  venue_order_hash: Identifier | null;
  /** §10.7: every live order references a valid fencing token. */
  fencing_lease_id: UuidV7Column | null;
  fencing_token: BigIntColumn | null;
  submitted_at: TimestampColumn | null;
  last_event_at: TimestampColumn | null;
  terminal_at: TimestampColumn | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.4 `order_events` — append-only order lifecycle. */
export type ExecutionOrderEventsTable = AppendOnlyTable<{
  order_event_id: WithDefault<UuidV7Column>;
  order_id: UuidV7Column;
  event_ordinal: BigIntColumn;
  event_type: Code;
  previous_state: OrderStateValue | null;
  new_state: OrderStateValue;
  venue_order_id: Identifier | null;
  venue_event_id: Identifier | null;
  shares_delta: DecimalString | null;
  filled_shares: DecimalString | null;
  remaining_shares: DecimalString | null;
  reason_code: Code | null;
  detail: Detail | null;
  /** Venue lifecycle detail; fill quantities inside it are decimal strings. */
  payload: NullableDecimalSafeJsonColumn;
  source: EventSourceValue;
  occurred_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.4 `intent_order_links` — many-to-many attribution (ADR-006 §4). */
export type ExecutionIntentOrderLinksTable = AppendOnlyTable<{
  intent_order_link_id: WithDefault<UuidV7Column>;
  intent_id: UuidV7Column;
  approved_intent_id: UuidV7Column | null;
  order_id: UuidV7Column;
  attributed_shares: DecimalString | null;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.4 `fills` — deduplicated fill facts. */
export type ExecutionFillsTable = AppendOnlyTable<{
  fill_id: WithDefault<UuidV7Column>;
  order_id: UuidV7Column;
  market_id: UuidV7Column;
  token_id: TokenId;
  environment: RunModeValue;
  account_ref: Identifier | null;
  venue_trade_id: Identifier;
  venue_order_id: Identifier;
  allocation_discriminator: WithDefault<Identifier>;
  side: OrderSideValue;
  shares: DecimalString;
  price: DecimalString;
  notional: DecimalString;
  fee_amount: WithDefault<DecimalString>;
  fee_asset: Identifier | null;
  liquidity_role: LiquidityRoleValue;
  matched_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.4 `fill_allocations` — actual fill ownership by virtual strategy. */
export type ExecutionFillAllocationsTable = AppendOnlyTable<{
  fill_allocation_id: WithDefault<UuidV7Column>;
  fill_id: UuidV7Column;
  /** ADR-006 §2: only `VIRTUAL_STRATEGY` or `UNATTRIBUTED` may own a fill. */
  scope: LedgerScopeValue;
  instance_id: UuidV7Column | null;
  run_id: UuidV7Column | null;
  allocated_shares: DecimalString;
  allocated_notional: DecimalString | null;
  allocated_fee: DecimalString | null;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.4 `trade_settlements` — match-to-confirmation lifecycle (§6 invariant 5). */
export type ExecutionTradeSettlementsTable = AppendOnlyTable<{
  trade_settlement_id: WithDefault<UuidV7Column>;
  fill_id: UuidV7Column;
  state_ordinal: number;
  previous_state: TradeSettlementStateValue | null;
  state: TradeSettlementStateValue;
  venue_trade_id: Identifier;
  transaction_hash: Identifier | null;
  block_number: BigIntColumn | null;
  detail: Detail | null;
  observed_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.4 `rate_limit_snapshots` — observed budgets and headers (§9.13). */
export type ExecutionRateLimitSnapshotsTable = AppendOnlyTable<{
  rate_limit_snapshot_id: WithDefault<UuidV7Column>;
  bucket_kind: RateLimitBucketKindValue;
  bucket_key: Identifier;
  endpoint_class: Code | null;
  environment: RunModeValue;
  account_ref: Identifier | null;
  observed_limit: number | null;
  observed_remaining: number | null;
  observed_cost: number | null;
  reset_at: TimestampColumn | null;
  warning_header: Detail | null;
  headers: JsonColumnWithDefault;
  source: EventSourceValue;
  observed_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** Every `execution` table, keyed by its qualified name. */
export type ExecutionSchema = {
  "execution.plans": ExecutionPlansTable;
  "execution.groups": ExecutionGroupsTable;
  "execution.submission_attempts": ExecutionSubmissionAttemptsTable;
  "execution.orders": ExecutionOrdersTable;
  "execution.order_events": ExecutionOrderEventsTable;
  "execution.intent_order_links": ExecutionIntentOrderLinksTable;
  "execution.fills": ExecutionFillsTable;
  "execution.fill_allocations": ExecutionFillAllocationsTable;
  "execution.trade_settlements": ExecutionTradeSettlementsTable;
  "execution.rate_limit_snapshots": ExecutionRateLimitSnapshotsTable;
};
