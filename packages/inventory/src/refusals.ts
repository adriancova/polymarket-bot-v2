/**
 * Typed results for `@polymarket-bot/inventory` (WP-300).
 *
 * Every operation that can say "no" returns an {@link InventoryResult}; a
 * refusal carries a stable code, a human message and flat evidence. Nothing in
 * this package answers "no" by throwing, and nothing answers "yes" by default.
 */

export const INVENTORY_REFUSAL_CODES = [
  // Input shape.
  "INVENTORY_INVALID_INPUT",
  // Assets (ADR-006 §7: explicit asset ids, pUSD and USDC.e never folded).
  "INVENTORY_UNKNOWN_ASSET",
  "INVENTORY_ASSET_CONFLICT",
  "INVENTORY_ASSET_ROLE_MISMATCH",
  // Availability (§10.7: no negative available balance after reservations).
  "INVENTORY_INSUFFICIENT_AVAILABLE",
  // Reservations (§9.14: prevent double reservation).
  "INVENTORY_DUPLICATE_RESERVATION_ID",
  "INVENTORY_DOUBLE_RESERVATION",
  "INVENTORY_RESERVATION_NOT_FOUND",
  "INVENTORY_RESERVATION_NOT_ACTIVE",
  "INVENTORY_OVER_CONSUMPTION",
  // Pending (in-flight) amounts.
  "INVENTORY_DUPLICATE_PENDING_ID",
  "INVENTORY_PENDING_NOT_FOUND",
  "INVENTORY_PENDING_UNRESOLVED",
  "INVENTORY_PENDING_EXCEEDS_ACTUAL",
  // Service health.
  "INVENTORY_FAULTED",
  "INVENTORY_JOURNAL_FAILED",
  // Wallet operations.
  "WALLET_OP_UNSUPPORTED_TYPE",
  "WALLET_OP_SPENDER_NOT_DOCUMENTED",
  "WALLET_OP_REDEEM_OUTCOME_NOT_TERMINAL",
  "WALLET_OP_REDEEM_CANCELLED_UNVERIFIED",
  "WALLET_OP_DUPLICATE_ID",
  "WALLET_OP_NOT_FOUND",
  "WALLET_OP_ILLEGAL_TRANSITION",
  "WALLET_OP_EVIDENCE_REQUIRED",
] as const;

export type InventoryRefusalCode = (typeof INVENTORY_REFUSAL_CODES)[number];

export type EvidenceValue = string | number | boolean | null;

export interface InventoryRefusal {
  readonly code: InventoryRefusalCode;
  readonly message: string;
  readonly details: Readonly<Record<string, EvidenceValue>>;
}

export type InventoryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: InventoryRefusal };

export function ok<T>(value: T): InventoryResult<T> {
  return Object.freeze({ ok: true as const, value });
}

export function refuse<T = never>(
  code: InventoryRefusalCode,
  message: string,
  details: Readonly<Record<string, EvidenceValue>> = {},
): InventoryResult<T> {
  return Object.freeze({
    ok: false as const,
    refusal: Object.freeze({ code, message, details: Object.freeze({ ...details }) }),
  });
}
