/**
 * The §9.15 accounting vocabulary.
 *
 * These token spellings are re-declared here from the handoff (§9.15 scope and
 * event lists, ADR-006 §2/§7) rather than imported from
 * `packages/storage-postgres`, because that package is layer 2 and this one is
 * layer 1: importing it would invert the §5.2 dependency direction (F12).
 * Both packages derive the SAME spellings from the same authority — the
 * WP-040 `internal.ledger_scope` / `internal.ledger_event_type` /
 * `internal.asset_kind` enums and these constants must agree token-for-token,
 * so a composition root binds records to columns with no mapping table.
 */

import { z } from "zod";

/** §9.15 ledger scopes (ADR-006 §2 gives the meaning of each). */
export const LEDGER_SCOPES = [
  "ACTUAL_ACCOUNT",
  "VIRTUAL_STRATEGY",
  "UNATTRIBUTED",
  "EXTERNAL_CLEARING",
  "FEE_EXPENSE",
  "REWARD_INCOME",
] as const;

export const LedgerScopeSchema = z.enum(LEDGER_SCOPES);
export type LedgerScope = z.infer<typeof LedgerScopeSchema>;

/**
 * The two scopes that state attribution of actual holdings (ADR-006 §2):
 * attribution is a partition of a real balance, never a parallel balance.
 */
export const ATTRIBUTION_SCOPES = ["VIRTUAL_STRATEGY", "UNATTRIBUTED"] as const;

/** §9.15 ledger events, one spelling per event kind (mirrors WP-040). */
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

export const LedgerEventTypeSchema = z.enum(LEDGER_EVENT_TYPES);
export type LedgerEventType = z.infer<typeof LedgerEventTypeSchema>;

/**
 * ADR-006 §7: no implicit "cash" asset; an asset always declares its kind.
 * USDC and pUSD are two DIFFERENT collateral asset ids and are never treated
 * as interchangeable (conflict C-2, UNRESOLVED). This package does not
 * resolve C-2 and cannot: resolving it requires then-current official venue
 * documentation and an amendment to ADR-006, a path WP-200 does not own. It
 * obeys ADR-006 §7 rules 1-3 instead — explicit asset ids everywhere, no
 * implicit conversion, denominations never summed. See the "C-2 remains
 * open" entry in `docs/handoffs/WP-200.md`.
 */
export const ASSET_KINDS = ["COLLATERAL", "OUTCOME_TOKEN"] as const;

export const AssetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/**
 * Trade settlement lifecycle (venue report §4; ADR-006 §5). Order state and
 * settlement state are separate (§6 invariant 5); `FAILED` produces a
 * compensating reversal, never an edit (ADR-006 §5.2).
 */
export const TRADE_SETTLEMENT_STATES = [
  "MATCHED_NOT_BROADCASTED",
  "MATCHED",
  "MINED",
  "CONFIRMED",
  "RETRYING",
  "FAILED",
] as const;

export const TradeSettlementStateSchema = z.enum(TRADE_SETTLEMENT_STATES);
export type TradeSettlementState = z.infer<typeof TradeSettlementStateSchema>;

/** ADR-006 §6: the three incentive programs, none attributable to a single fill. */
export const REWARD_PROGRAM_TYPES = [
  "MAKER_REBATE",
  "TAKER_REBATE",
  "LIQUIDITY_REWARD",
] as const;

export const RewardProgramTypeSchema = z.enum(REWARD_PROGRAM_TYPES);
export type RewardProgramType = z.infer<typeof RewardProgramTypeSchema>;
