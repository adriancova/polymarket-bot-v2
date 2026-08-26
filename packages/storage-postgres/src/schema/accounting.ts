/**
 * `accounting` schema table types (handoff §10.5).
 *
 * Mirrors `db/migrations/0006_accounting.up.sql`.
 *
 * ADR-006 §1: the append-only ledger is the monetary source of truth; the
 * projections are rebuildable views (§6 invariant 8), which is why only the
 * projections are writable through `updateTable`.
 */

import type {
  AppendOnlyTable,
  BigIntColumn,
  Code,
  DatabaseGenerated,
  DecimalString,
  Detail,
  Identifier,
  NullableJsonColumn,
  Sha256Hex,
  TimestampColumn,
  TimestampColumnWithDefault,
  TokenId,
  UuidV7Column,
  WithDefault,
} from "./columns.js";
import type {
  AssetKindValue,
  EventSourceValue,
  LedgerEventTypeValue,
  LedgerScopeValue,
  ReservationStatusValue,
  RewardProgramTypeValue,
  RunModeValue,
  TradeSettlementStateValue,
  WalletOperationStateValue,
  WalletOperationTypeValue,
} from "./enums.js";

/** §10.5 `wallet_operations` — split, merge, redeem, approve, transfer (§9.14). */
export type AccountingWalletOperationsTable = {
  wallet_operation_id: WithDefault<UuidV7Column>;
  environment: RunModeValue;
  account_ref: Identifier;
  operation_type: WalletOperationTypeValue;
  state: WithDefault<WalletOperationStateValue>;
  market_id: UuidV7Column | null;
  condition_id: Identifier | null;
  asset_id: Identifier | null;
  amount: DecimalString | null;
  transaction_hash: Identifier | null;
  relayer_reference: Identifier | null;
  requested_at: TimestampColumnWithDefault;
  confirmed_at: TimestampColumn | null;
  detail: Detail | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.5 `wallet_operation_events` — append-only operation lifecycle. */
export type AccountingWalletOperationEventsTable = AppendOnlyTable<{
  wallet_operation_event_id: WithDefault<UuidV7Column>;
  wallet_operation_id: UuidV7Column;
  event_ordinal: number;
  previous_state: WalletOperationStateValue | null;
  new_state: WalletOperationStateValue;
  transaction_hash: Identifier | null;
  block_number: BigIntColumn | null;
  reason_code: Code | null;
  detail: Detail | null;
  payload: NullableJsonColumn;
  occurred_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.5 `ledger_transactions` — event-level accounting transaction (§9.15). */
export type AccountingLedgerTransactionsTable = AppendOnlyTable<{
  ledger_transaction_id: WithDefault<UuidV7Column>;
  event_type: LedgerEventTypeValue;
  environment: RunModeValue;
  account_ref: Identifier;
  market_id: UuidV7Column | null;
  order_id: UuidV7Column | null;
  fill_id: UuidV7Column | null;
  wallet_operation_id: UuidV7Column | null;
  reconciliation_run_id: UuidV7Column | null;
  settlement_state: TradeSettlementStateValue | null;
  /** ADR-006 §5.2: a failure is a compensating reversal, never an edit. */
  reverses_ledger_transaction_id: UuidV7Column | null;
  source: EventSourceValue;
  reference_hash: Sha256Hex | null;
  detail: Detail | null;
  occurred_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.5 `ledger_entries` — per-asset balanced entries (§10.7). */
export type AccountingLedgerEntriesTable = AppendOnlyTable<{
  ledger_entry_id: WithDefault<UuidV7Column>;
  ledger_transaction_id: UuidV7Column;
  entry_ordinal: number;
  scope: LedgerScopeValue;
  account_ref: Identifier;
  instance_id: UuidV7Column | null;
  run_id: UuidV7Column | null;
  market_id: UuidV7Column | null;
  /** ADR-006 §7 rule 1: every entry carries an explicit asset identifier. */
  asset_id: Identifier;
  asset_kind: AssetKindValue;
  /** Signed: a balanced transaction has entries on both sides. */
  amount: DecimalString;
  detail: Detail | null;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.5 `balance_projection` — actual and reserved balances. */
export type AccountingBalanceProjectionTable = {
  account_ref: Identifier;
  environment: RunModeValue;
  asset_id: Identifier;
  asset_kind: AssetKindValue;
  actual_amount: WithDefault<DecimalString>;
  reserved_amount: WithDefault<DecimalString>;
  /** `GENERATED ALWAYS`: actual minus reserved, checked to be non-negative. */
  available_amount: DatabaseGenerated<DecimalString>;
  last_ledger_transaction_id: UuidV7Column | null;
  rebuilt_at: TimestampColumn | null;
  updated_at: TimestampColumnWithDefault;
};

/** §10.5 `inventory_reservations` — funds/tokens reserved for plans/orders. */
export type AccountingInventoryReservationsTable = {
  inventory_reservation_id: WithDefault<UuidV7Column>;
  account_ref: Identifier;
  environment: RunModeValue;
  asset_id: Identifier;
  asset_kind: AssetKindValue;
  plan_id: UuidV7Column | null;
  order_id: UuidV7Column | null;
  instance_id: UuidV7Column | null;
  amount: DecimalString;
  status: WithDefault<ReservationStatusValue>;
  reserved_at: TimestampColumnWithDefault;
  released_at: TimestampColumn | null;
  release_reason: Detail | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.5 `actual_position_projection` — rebuildable wallet position view. */
export type AccountingActualPositionProjectionTable = {
  account_ref: Identifier;
  environment: RunModeValue;
  asset_id: Identifier;
  asset_kind: AssetKindValue;
  market_id: UuidV7Column | null;
  token_id: TokenId | null;
  shares: WithDefault<DecimalString>;
  average_cost: DecimalString | null;
  last_ledger_transaction_id: UuidV7Column | null;
  rebuilt_at: TimestampColumn | null;
  updated_at: TimestampColumnWithDefault;
};

/** §10.5 `virtual_position_projection` — rebuildable strategy attribution. */
export type AccountingVirtualPositionProjectionTable = {
  instance_id: UuidV7Column;
  market_id: UuidV7Column;
  asset_id: Identifier;
  asset_kind: AssetKindValue;
  run_id: UuidV7Column | null;
  token_id: TokenId | null;
  shares: WithDefault<DecimalString>;
  average_cost: DecimalString | null;
  realized_pnl: WithDefault<DecimalString>;
  last_ledger_transaction_id: UuidV7Column | null;
  rebuilt_at: TimestampColumn | null;
  updated_at: TimestampColumnWithDefault;
};

/** §10.5 `reward_estimates` — never booked as realized (§9.16). */
export type AccountingRewardEstimatesTable = AppendOnlyTable<{
  reward_estimate_id: WithDefault<UuidV7Column>;
  program_type: RewardProgramTypeValue;
  reward_program_id: UuidV7Column | null;
  environment: RunModeValue;
  account_ref: Identifier | null;
  instance_id: UuidV7Column | null;
  market_id: UuidV7Column | null;
  period_start: TimestampColumn;
  period_end: TimestampColumn;
  estimated_amount: DecimalString;
  denomination_asset: Identifier;
  methodology: Code;
  computed_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.5 `reward_payouts` — actual observed payouts. */
export type AccountingRewardPayoutsTable = AppendOnlyTable<{
  reward_payout_id: WithDefault<UuidV7Column>;
  program_type: RewardProgramTypeValue;
  reward_program_id: UuidV7Column | null;
  environment: RunModeValue;
  account_ref: Identifier;
  market_id: UuidV7Column | null;
  period_start: TimestampColumn | null;
  period_end: TimestampColumn | null;
  amount: DecimalString;
  denomination_asset: Identifier;
  transaction_hash: Identifier | null;
  ledger_transaction_id: UuidV7Column | null;
  observed_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.5 `pnl_snapshots` — rebuildable reporting projection (§9.16). */
export type AccountingPnlSnapshotsTable = {
  pnl_snapshot_id: WithDefault<UuidV7Column>;
  scope: LedgerScopeValue;
  environment: RunModeValue;
  account_ref: Identifier;
  instance_id: UuidV7Column | null;
  run_id: UuidV7Column | null;
  market_id: UuidV7Column | null;
  denomination_asset: Identifier;
  gross_trading_pnl: DecimalString;
  /** §6 invariant 14: core PnL excludes discretionary rewards. */
  core_net_pnl: DecimalString;
  all_in_pnl: DecimalString;
  realized_pnl: DecimalString;
  unrealized_pnl_midpoint: DecimalString;
  unrealized_pnl_model: DecimalString | null;
  unrealized_pnl_liquidation: DecimalString | null;
  worst_case_resolution_pnl: DecimalString | null;
  fees_paid: WithDefault<DecimalString>;
  reward_estimate_total: WithDefault<DecimalString>;
  realized_rewards: WithDefault<DecimalString>;
  capital_committed: WithDefault<DecimalString>;
  as_of: TimestampColumn;
  computed_at: TimestampColumnWithDefault;
  rebuilt_at: TimestampColumn | null;
};

/** Every `accounting` table, keyed by its qualified name. */
export type AccountingSchema = {
  "accounting.wallet_operations": AccountingWalletOperationsTable;
  "accounting.wallet_operation_events": AccountingWalletOperationEventsTable;
  "accounting.ledger_transactions": AccountingLedgerTransactionsTable;
  "accounting.ledger_entries": AccountingLedgerEntriesTable;
  "accounting.balance_projection": AccountingBalanceProjectionTable;
  "accounting.inventory_reservations": AccountingInventoryReservationsTable;
  "accounting.actual_position_projection": AccountingActualPositionProjectionTable;
  "accounting.virtual_position_projection": AccountingVirtualPositionProjectionTable;
  "accounting.reward_estimates": AccountingRewardEstimatesTable;
  "accounting.reward_payouts": AccountingRewardPayoutsTable;
  "accounting.pnl_snapshots": AccountingPnlSnapshotsTable;
};
