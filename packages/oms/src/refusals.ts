/**
 * Typed results for `@polymarket-bot/oms` (WP-270).
 *
 * Every operation that can say "no" returns an {@link OmsResult}. A refusal
 * carries a stable code from the closed list below, a fixed human sentence and
 * flat, non-secret evidence. Nothing in this package answers "no" by throwing,
 * and nothing answers "yes" by default. No refusal ever carries a signed
 * payload, a signature or a ciphertext (ADR-007 §11; handoff §15).
 */

export const OMS_REFUSAL_CODES = [
  // Input shape and identity.
  "OMS_INVALID_INPUT",
  // ADR-034 D2.4: a ticket's shares are off the venue's 0.01 grid. The OMS never rounds; the planner quantizes.
  "OMS_SIZE_OFF_GRID",
  "OMS_DUPLICATE_ORDER",
  "OMS_UNKNOWN_ORDER",
  "OMS_UNKNOWN_ATTEMPT",
  "OMS_DUPLICATE_GROUP",
  "OMS_UNKNOWN_GROUP",
  "OMS_GROUP_MISMATCH",
  "OMS_ID_SOURCE_FAILED",
  // Manager health (a store write failed: the in-memory state may be ahead of the durable one).
  "OMS_FAULTED",
  "OMS_STORE_WRITE_FAILED",
  // Startup and coordinator pause (handoff §9.17 step 1, "Pause new submissions").
  "OMS_PAUSED",
  "OMS_RESUME_BLOCKED",
  // §9.11 step 10 and the group's remaining quantity.
  "OMS_SALT_GATE_CLOSED",
  "OMS_GROUP_REMAINDER_EXCEEDED",
  "OMS_POST_ONLY_RETRY_FORBIDDEN",
  // Venue modes (caller-supplied snapshot; detection is WP-310's).
  "OMS_POST_ONLY_MODE",
  "OMS_TRADING_UNAVAILABLE",
  // Reservations (WP-300's inventory, through the port).
  "OMS_RESERVATION_MISMATCH",
  "OMS_RESERVATION_REFUSED",
  // Signing and persistence of the signed payload (§9.11 steps 2-4).
  "OMS_SIGN_FAILED",
  "OMS_SIGNED_ORDER_MISMATCH",
  "OMS_CIPHER_FAILED",
  // Batches.
  "OMS_BATCH_SIZE",
  // Transitions and transmission.
  "OMS_ILLEGAL_TRANSITION",
  "OMS_TRANSMISSION_IN_FLIGHT",
  "OMS_RETRANSMIT_NOT_SUPPORTED",
  "OMS_SIGNED_PAYLOAD_UNAVAILABLE",
  // Reconciliation answers (ADR-007 §3; ADR-032's binding rules applied to orders).
  "OMS_RECONCILIATION_UNRECOGNISED",
  "OMS_RECONCILIATION_UNBOUND",
  "OMS_RECONCILIATION_SUPERSEDED",
  "OMS_RECONCILIATION_SUBJECT_MISMATCH",
  "OMS_RECONCILIATION_IN_FLIGHT",
  "OMS_RECONCILIATION_NOT_QUIESCENT",
  "OMS_EVIDENCE_CONFLICT",
  // Cancel and replace.
  "OMS_CANCEL_NOT_APPLICABLE",
  "OMS_NO_STAGED_REPLACEMENT",
  "OMS_REPLACEMENT_NOT_READY",
  // Venue-side evidence.
  "OMS_UNKNOWN_VENUE_ORDER",
  // Not an error: the evidence names a venue order id no order holds YET, and is kept while an unresolved
  // attempt could own it (UNATTRIBUTED EVIDENCE in `order-manager.ts`). Delivering it again is harmless.
  "OMS_EVIDENCE_RETAINED",
  "OMS_OBSERVATION_UNRECOGNISED",
  "OMS_FILL_INCONSISTENT",
  "OMS_FILL_CONFLICT",
  "OMS_UNKNOWN_FILL",
  "OMS_SETTLEMENT_UNRECOGNISED",
  "OMS_SETTLEMENT_REGRESSION",
  "OMS_SETTLEMENT_CONFLICT",
] as const;

export type OmsRefusalCode = (typeof OMS_REFUSAL_CODES)[number];

export type EvidenceValue = string | number | boolean | null;

export interface OmsRefusal {
  readonly code: OmsRefusalCode;
  readonly message: string;
  readonly details: Readonly<Record<string, EvidenceValue>>;
}

export type OmsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: OmsRefusal };

export function ok<T>(value: T): OmsResult<T> {
  return Object.freeze({ ok: true as const, value });
}

export function refuse<T = never>(
  code: OmsRefusalCode,
  message: string,
  details: Readonly<Record<string, EvidenceValue>> = {},
): OmsResult<T> {
  return Object.freeze({
    ok: false as const,
    refusal: Object.freeze({ code, message, details: Object.freeze({ ...details }) }),
  });
}
