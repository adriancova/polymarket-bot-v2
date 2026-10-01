/**
 * Wallet-operation vocabulary and the state machine's transition table
 * (handoff §9.14; ADR-006 §8; WP-040 `internal.wallet_operation_state`).
 *
 * States (the §9.14 list, spelled as WP-040's enum):
 *
 *   PLANNED ──submit accepted──▶ SUBMITTED ──▶ MINED ──▶ CONFIRMED
 *      │                            │            │
 *      │ NOT_SENT (nothing left     ├──────────▶ FAILED ◀┘
 *      │ the process) ─▶ FAILED     │
 *      └─ anything unrecognised ──▶ UNKNOWN ──(reconciliation requested)──▶ RECONCILING
 *                                                                        │
 *                  only authoritative reconciliation evidence ◀──────────┘
 *                  (→ SUBMITTED | MINED | CONFIRMED | FAILED)
 *
 * UNKNOWN is never resolved by elapsed time, by a heuristic, or by absence of
 * news (ADR-007 §3 applied to wallet operations; ADR-006 §8 "An UNKNOWN wallet
 * operation triggers reconciliation … until resolved, its effect is not
 * asserted in a projection"). There is no timeout anywhere in this package.
 *
 * Operation types. §9.14 lists APPROVE_ERC20, APPROVE_ERC1155, SPLIT, MERGE,
 * REDEEM and TRANSFER; WP-300's packet adds the pUSD wrap/unwrap through the
 * documented CollateralOnramp / CollateralOfframp (verified-2026-09-30 §W.8).
 * TRANSFER is deliberately NOT implemented: a transfer sends tokens to another
 * address, which is a withdrawal path, and v1 has "No autonomous deposit,
 * withdrawal, or bridge behavior" (§9.14). Nor is any DEPOSIT, WITHDRAW or
 * BRIDGE type. WRAP_COLLATERAL / UNWRAP_COLLATERAL are not in the WP-040
 * `internal.wallet_operation_type` enum; persisting them needs a migration
 * (recorded as a WP-300 follow-up).
 */

export const WALLET_OPERATION_TYPES = [
  "APPROVE_ERC20",
  "APPROVE_ERC1155",
  "SPLIT",
  "MERGE",
  "REDEEM",
  "WRAP_COLLATERAL",
  "UNWRAP_COLLATERAL",
] as const;

export type WalletOperationType = (typeof WALLET_OPERATION_TYPES)[number];

export const WALLET_OPERATION_STATES = [
  "PLANNED",
  "SUBMITTED",
  "MINED",
  "CONFIRMED",
  "FAILED",
  "UNKNOWN",
  "RECONCILING",
] as const;

export type WalletOperationState = (typeof WALLET_OPERATION_STATES)[number];

export const TERMINAL_WALLET_OPERATION_STATES: readonly WalletOperationState[] = Object.freeze([
  "CONFIRMED",
  "FAILED",
]);

/** The only legal transitions. Anything else is refused. */
export const WALLET_OPERATION_TRANSITIONS: Readonly<Record<WalletOperationState, readonly WalletOperationState[]>> =
  Object.freeze({
    PLANNED: Object.freeze(["SUBMITTED", "FAILED", "UNKNOWN"] as const),
    SUBMITTED: Object.freeze(["MINED", "CONFIRMED", "FAILED", "UNKNOWN"] as const),
    MINED: Object.freeze(["CONFIRMED", "FAILED", "UNKNOWN"] as const),
    UNKNOWN: Object.freeze(["RECONCILING"] as const),
    RECONCILING: Object.freeze(["SUBMITTED", "MINED", "CONFIRMED", "FAILED"] as const),
    CONFIRMED: Object.freeze([] as const),
    FAILED: Object.freeze([] as const),
  });

export function isLegalWalletTransition(from: WalletOperationState, to: WalletOperationState): boolean {
  return WALLET_OPERATION_TRANSITIONS[from].includes(to);
}

/** The WP-040 `internal.reconciliation_trigger` value for this package's requests. */
export const WALLET_OPERATION_UNKNOWN_TRIGGER = "WALLET_OPERATION_UNKNOWN" as const;
