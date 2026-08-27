/**
 * TypeScript mirrors of the `internal.*` PostgreSQL enumerations.
 *
 * Where the handoff freezes a vocabulary in `packages/domain`, the mirror is
 * pinned to the frozen type with `satisfies`, so a database enum can never drift
 * from a domain contract without failing `pnpm typecheck`. Where §10 or §9 names
 * a vocabulary that has no domain contract yet (ledger scopes, order states,
 * kill-switch actions), the values are transcribed from the cited section and
 * the citation is in the comment.
 *
 * The domain contracts are FROZEN: nothing here edits them, and a mismatch is a
 * bug in this file, not licence to widen a contract.
 */

import type {
  BookSide,
  DecisionType,
  EventSource,
  IntentType,
  LiquidityPreference,
  MarketOutcomeState,
  OutcomeSide,
  PartialFillPolicy,
  RunMode,
  TradingParameterKind,
} from "@polymarket-bot/domain";

/** §11 run modes; also the §10.8 environment discriminator. */
export const RUN_MODES = [
  "BACKTEST",
  "PAPER",
  "SHADOW",
  "EXECUTION_PROBE",
  "LIVE_MICRO",
  "LIVE",
] as const satisfies readonly RunMode[];

/** §7.1 envelope `source`. */
export const EVENT_SOURCES = [
  "polymarket",
  "binance",
  "coinbase",
  "rtds",
  "internal",
] as const satisfies readonly EventSource[];

/** §9.3 required outcome states. */
export const MARKET_OUTCOME_STATES = [
  "YES_WIN",
  "NO_WIN",
  "SPLIT_50_50",
  "CANCELLED",
  "DISPUTED",
  "PENDING",
  "PENDING_CLARIFICATION",
] as const satisfies readonly MarketOutcomeState[];

export const OUTCOME_SIDES = ["YES", "NO"] as const satisfies readonly OutcomeSide[];
export const BOOK_SIDES = ["BID", "ASK"] as const satisfies readonly BookSide[];

/** §9.2 / §10.1 versioned trading parameters. */
export const TRADING_PARAMETER_KINDS = [
  "tick_size",
  "minimum_order_size",
  "fee_schedule",
  "trading_delay",
  "neg_risk",
  "open_time",
  "close_time",
  "status",
] as const satisfies readonly TradingParameterKind[];

/** §7.7 intent discriminators. */
export const INTENT_TYPES = [
  "POSITION",
  "QUOTE",
  "BASKET",
  "CANCEL",
  "REDUCE_POSITION",
] as const satisfies readonly IntentType[];

/** §7.5 decision types. */
export const DECISION_TYPES = [
  "enter",
  "exit",
  "quote",
  "hold",
  "skip",
  "cancel",
  "reduce",
] as const satisfies readonly DecisionType[];

export const PARTIAL_FILL_POLICIES = [
  "REJECT",
  "ACCEPT_ANY",
  "ACCEPT_MINIMUM",
] as const satisfies readonly PartialFillPolicy[];

export const LIQUIDITY_PREFERENCES = [
  "MAKER_ONLY",
  "MAKER_PREFERRED",
  "TAKER_OK",
  "TAKER_ONLY",
] as const satisfies readonly LiquidityPreference[];

/** Lifecycle projection derived from the §7.4 market-lifecycle events. */
export const MARKET_LIFECYCLE_STATES = [
  "DISCOVERED",
  "OPEN",
  "CLOSING",
  "CLOSED",
  "RESOLVED",
] as const;

/** §9.3 observation types. */
export const OBSERVATION_TYPES = [
  "TERMINAL_SPOT",
  "TWAP",
  "VWAP",
  "EVENT_RESULT",
  "MANUAL_ORACLE",
] as const;

/** §9.3 comparisons. */
export const COMPARISON_OPERATORS = ["GT", "GTE", "LT", "LTE"] as const;

/** §9.3 payoff models. */
export const PAYOFF_MODELS = [
  "TerminalSpotBinaryModel",
  "TwapBinaryModel",
  "ReferenceOpenUpDownModel",
  "ThresholdByDateModel",
] as const;

export const VERIFICATION_STATUSES = ["UNVERIFIED", "VERIFIED", "REJECTED"] as const;

/** ADR-006 §6: three distinct incentive programs. */
export const REWARD_PROGRAM_TYPES = [
  "MAKER_REBATE",
  "TAKER_REBATE",
  "LIQUIDITY_REWARD",
] as const;

/** §10.2 `data_quality_incidents`. */
export const DATA_QUALITY_INCIDENT_TYPES = [
  "GAP",
  "STALENESS",
  "CORRUPTION",
  "RESYNC_WINDOW",
] as const;

/** §14.4 alert vocabulary. */
export const INCIDENT_SEVERITIES = ["LOG", "NOTIFY", "PAGE"] as const;
export const INCIDENT_STATUSES = ["OPEN", "MITIGATING", "RESOLVED"] as const;

/** §9.9 incident action ladder. */
export const INCIDENT_ACTIONS = [
  "HALT_NEW_ENTRIES",
  "CANCEL_RESTING_ORDERS",
  "RECONCILE_ACCOUNT",
  "MANAGE_KNOWN_POSITIONS_ONLY",
  "PROTECTED_REDUCE",
  "HOLD_TO_RESOLUTION",
  "FULL_HALT",
] as const;

/** §9.11 order state machine. */
export const ORDER_STATES = [
  "PLANNED",
  "SIGNED",
  "SENDING",
  "ACKNOWLEDGED",
  "LIVE",
  "DELAYED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCEL_PENDING",
  "CANCELED",
  "REJECTED",
  "SUBMISSION_UNKNOWN",
  "RECONCILING",
  "EXPIRED",
] as const;

/**
 * §9.11 trade settlement states, plus `MATCHED_NOT_BROADCASTED`.
 *
 * §9.11 lists five; the SDK enumerates six and ADR-006 §5 names the sixth
 * explicitly (venue report §4). A venue state the table cannot record would be
 * unrecordable venue truth.
 */
export const TRADE_SETTLEMENT_STATES = [
  "MATCHED_NOT_BROADCASTED",
  "MATCHED",
  "MINED",
  "CONFIRMED",
  "RETRYING",
  "FAILED",
] as const;

export const LIQUIDITY_ROLES = ["MAKER", "TAKER"] as const;

/** §9.11 idempotent submission protocol. */
export const SUBMISSION_STATES = [
  "SIGNED",
  "SENDING",
  "RESPONDED",
  "SUBMISSION_UNKNOWN",
  "RECONCILING",
  "ABANDONED",
] as const;

/** §9.6 strategy callbacks. */
export const STRATEGY_CALLBACKS = [
  "onStart",
  "onMarketOpen",
  "onFeatures",
  "onFill",
  "onOrderUpdate",
  "onTimer",
  "onMarketClosing",
  "onMarketResolved",
  "onStop",
] as const;

/** §6 invariant 11 / ADR-011. */
export const OWNERSHIP_MODES = ["LIVE_OWNER", "SHADOW", "OBSERVER"] as const;
export const OWNERSHIP_STATUSES = ["ACTIVE", "RELEASED"] as const;

export const INSTANCE_STATUSES = ["ACTIVE", "PAUSED", "STOPPED"] as const;
export const RUN_STATUSES = ["RUNNING", "STOPPED", "FAILED"] as const;

/** §9.18 / ADR-008 fencing lease. */
export const LEASE_STATUSES = ["ACTIVE", "EXPIRED", "RELEASED", "REVOKED"] as const;

export const RESERVATION_STATUSES = ["ACTIVE", "RELEASED", "CONSUMED"] as const;

/** §9.15 ledger scopes. */
export const LEDGER_SCOPES = [
  "ACTUAL_ACCOUNT",
  "VIRTUAL_STRATEGY",
  "UNATTRIBUTED",
  "EXTERNAL_CLEARING",
  "FEE_EXPENSE",
  "REWARD_INCOME",
] as const;

/** §9.15 ledger events. */
export const LEDGER_EVENT_TYPES = [
  "ORDER_RESERVATION",
  "RESERVATION_RELEASE",
  "TRADE_PRINCIPAL",
  "OUTCOME_TOKEN_RECEIPT",
  "OUTCOME_TOKEN_DELIVERY",
  "PLATFORM_FEE",
  "MAKER_REBATE_PAYOUT",
  "TAKER_REBATE_PAYOUT",
  "LIQUIDITY_REWARD",
  "SPLIT",
  "MERGE",
  "REDEEM",
  "DEPOSIT_OBSERVED",
  "WITHDRAWAL_OBSERVED",
  "MANUAL_ADJUSTMENT",
  "RECONCILIATION_CORRECTION",
  "RESOLUTION",
] as const;

/** ADR-006 §7: no implicit "cash" asset; an asset always declares its kind. */
export const ASSET_KINDS = ["COLLATERAL", "OUTCOME_TOKEN"] as const;

/** §9.14 wallet operations. */
export const WALLET_OPERATION_TYPES = [
  "APPROVE_ERC20",
  "APPROVE_ERC1155",
  "SPLIT",
  "MERGE",
  "REDEEM",
  "TRANSFER",
] as const;
export const WALLET_OPERATION_STATES = [
  "PLANNED",
  "SUBMITTED",
  "MINED",
  "CONFIRMED",
  "FAILED",
  "UNKNOWN",
  "RECONCILING",
] as const;

/** §14.1 kill switches. */
export const KILL_SWITCH_SCOPES = ["GLOBAL", "ACCOUNT", "MARKET", "STRATEGY_INSTANCE"] as const;
export const KILL_SWITCH_ACTIONS = [
  "HALT_NEW_ENTRIES",
  "CANCEL_ALL",
  "CANCEL_MARKET",
  "MANAGE_POSITIONS_ONLY",
  "FULL_HALT",
] as const;
export const ACTOR_KINDS = ["HUMAN", "AUTOMATED"] as const;

/** §9.8 risk gate outcomes. */
export const RISK_OUTCOMES = ["APPROVED", "RESIZED", "VETOED", "BREAKER"] as const;

/** §9.17 reconciliation. */
export const RECONCILIATION_TRIGGERS = [
  "STARTUP",
  "PERIODIC_TIMER",
  "USER_STREAM_RECONNECT",
  "MARKET_STREAM_GAP",
  "SUBMISSION_UNKNOWN",
  "WALLET_OPERATION_UNKNOWN",
  "MANUAL_REQUEST",
  "POSITION_BALANCE_DISCREPANCY",
] as const;
export const RECONCILIATION_STATUSES = ["RUNNING", "PASSED", "FAILED", "QUARANTINED"] as const;
export const BREAK_STATUSES = ["OPEN", "RESOLVED", "QUARANTINED"] as const;

/** §9.1 raw archive. */
export const SEGMENT_FORMATS = ["JSONL", "PARQUET"] as const;

/** §9.13 rate-limit budgets. */
export const RATE_LIMIT_BUCKET_KINDS = [
  "IP_ENDPOINT_CLASS",
  "SIGNER",
  "ORDER",
  "CANCEL",
  "RELAYER",
] as const;

/** §9.10 execution groups: slices or coordinated legs. */
export const EXECUTION_GROUP_KINDS = ["SLICE", "LEG"] as const;

export const ORDER_SIDES = ["BUY", "SELL"] as const;

export type RunModeValue = (typeof RUN_MODES)[number];
export type EventSourceValue = (typeof EVENT_SOURCES)[number];
export type MarketOutcomeStateValue = (typeof MARKET_OUTCOME_STATES)[number];
export type MarketLifecycleStateValue = (typeof MARKET_LIFECYCLE_STATES)[number];
export type OutcomeSideValue = (typeof OUTCOME_SIDES)[number];
export type BookSideValue = (typeof BOOK_SIDES)[number];
export type OrderSideValue = (typeof ORDER_SIDES)[number];
export type TradingParameterKindValue = (typeof TRADING_PARAMETER_KINDS)[number];
export type IntentTypeValue = (typeof INTENT_TYPES)[number];
export type DecisionTypeValue = (typeof DECISION_TYPES)[number];
export type PartialFillPolicyValue = (typeof PARTIAL_FILL_POLICIES)[number];
export type LiquidityPreferenceValue = (typeof LIQUIDITY_PREFERENCES)[number];
export type ObservationTypeValue = (typeof OBSERVATION_TYPES)[number];
export type ComparisonOperatorValue = (typeof COMPARISON_OPERATORS)[number];
export type PayoffModelValue = (typeof PAYOFF_MODELS)[number];
export type VerificationStatusValue = (typeof VERIFICATION_STATUSES)[number];
export type RewardProgramTypeValue = (typeof REWARD_PROGRAM_TYPES)[number];
export type DataQualityIncidentTypeValue = (typeof DATA_QUALITY_INCIDENT_TYPES)[number];
export type IncidentSeverityValue = (typeof INCIDENT_SEVERITIES)[number];
export type IncidentStatusValue = (typeof INCIDENT_STATUSES)[number];
export type IncidentActionValue = (typeof INCIDENT_ACTIONS)[number];
export type OrderStateValue = (typeof ORDER_STATES)[number];
export type TradeSettlementStateValue = (typeof TRADE_SETTLEMENT_STATES)[number];
export type LiquidityRoleValue = (typeof LIQUIDITY_ROLES)[number];
export type SubmissionStateValue = (typeof SUBMISSION_STATES)[number];
export type StrategyCallbackValue = (typeof STRATEGY_CALLBACKS)[number];
export type OwnershipModeValue = (typeof OWNERSHIP_MODES)[number];
export type OwnershipStatusValue = (typeof OWNERSHIP_STATUSES)[number];
export type InstanceStatusValue = (typeof INSTANCE_STATUSES)[number];
export type RunStatusValue = (typeof RUN_STATUSES)[number];
export type LeaseStatusValue = (typeof LEASE_STATUSES)[number];
export type ReservationStatusValue = (typeof RESERVATION_STATUSES)[number];
export type LedgerScopeValue = (typeof LEDGER_SCOPES)[number];
export type LedgerEventTypeValue = (typeof LEDGER_EVENT_TYPES)[number];
export type AssetKindValue = (typeof ASSET_KINDS)[number];
export type WalletOperationTypeValue = (typeof WALLET_OPERATION_TYPES)[number];
export type WalletOperationStateValue = (typeof WALLET_OPERATION_STATES)[number];
export type KillSwitchScopeValue = (typeof KILL_SWITCH_SCOPES)[number];
export type KillSwitchActionValue = (typeof KILL_SWITCH_ACTIONS)[number];
export type ActorKindValue = (typeof ACTOR_KINDS)[number];
export type RiskOutcomeValue = (typeof RISK_OUTCOMES)[number];
export type ReconciliationTriggerValue = (typeof RECONCILIATION_TRIGGERS)[number];
export type ReconciliationStatusValue = (typeof RECONCILIATION_STATUSES)[number];
export type BreakStatusValue = (typeof BREAK_STATUSES)[number];
export type SegmentFormatValue = (typeof SEGMENT_FORMATS)[number];
export type RateLimitBucketKindValue = (typeof RATE_LIMIT_BUCKET_KINDS)[number];
export type ExecutionGroupKindValue = (typeof EXECUTION_GROUP_KINDS)[number];

/**
 * Run modes that place real orders (§11 "Execution" column).
 *
 * Mirrors `internal.execution_realm`: all three real-order modes share one
 * realm, so the ownership and fencing constraints treat them as one.
 */
export const REAL_ORDER_RUN_MODES = [
  "EXECUTION_PROBE",
  "LIVE_MICRO",
  "LIVE",
] as const satisfies readonly RunMode[];

export function isRealOrderRunMode(mode: RunModeValue): boolean {
  return (REAL_ORDER_RUN_MODES as readonly string[]).includes(mode);
}

/** Mirrors `internal.execution_realm(internal.run_mode)`. */
export function executionRealm(mode: RunModeValue): string {
  return isRealOrderRunMode(mode) ? "REAL" : `SIMULATED:${mode}`;
}
