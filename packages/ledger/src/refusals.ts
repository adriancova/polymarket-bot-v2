/**
 * Typed refusals (handoff §21: "Errors are typed and observable").
 *
 * As in `@polymarket-bot/universe` and `@polymarket-bot/settlement`, a REFUSAL
 * is data: the ledger answers "no" by returning the reason, machine-readable,
 * with the evidence attached. The ledger never adjusts an input to make it
 * acceptable — an unbalanced transaction is refused, never repaired (§9.15,
 * ADR-006 §1). A THROW is reserved for structurally impossible construction.
 *
 * Nothing here logs, halts a market, or pages anyone: this package is pure,
 * and the composition root owns the response to each refusal.
 */

export type LedgerRefusalCode =
  // --- input shape ----------------------------------------------------------
  /** The input failed schema validation before any accounting rule ran. */
  | "LEDGER_INPUT_INVALID"
  /**
   * A UUID-shaped identifier arrived in a non-canonical spelling.
   *
   * ADR-016 §2 (2026-09-02 amendment): the external-boundary rule is REFUSE,
   * not normalize — never a case-fold, never a silent repair. The refusal
   * carries the raw value so the caller's defect is diagnosable.
   */
  | "LEDGER_UUID_NOT_CANONICAL"

  // --- transaction structure ------------------------------------------------
  /** A ledger transaction records at least one balanced pair of entries (§9.15). */
  | "LEDGER_TRANSACTION_EMPTY"
  /** This transaction id was already appended; the ledger is append-only (§10.7). */
  | "LEDGER_DUPLICATE_TRANSACTION_ID"
  /** An entry amount is exactly zero: it moves nothing and records nothing. */
  | "LEDGER_ENTRY_AMOUNT_ZERO"
  /**
   * A transaction that books an order or a fill must name its market.
   *
   * WP-040 obligation F16 ("carry the market on ledger postings"):
   * `execution.orders.market_id` and `execution.fills.market_id` are NOT NULL,
   * so a caller holding an execution fact always holds its market.
   */
  | "LEDGER_MARKET_REQUIRED"

  // --- the central invariant ------------------------------------------------
  /**
   * The transaction does not balance to zero for at least one asset.
   *
   * §9.15 / §10.7 / ADR-006 §1: "Every ledger transaction balances to zero
   * per asset using explicit external-clearing accounts." The refusal names
   * EVERY unbalanced asset and its exact net imbalance — the check is
   * per-asset, never a global sum across assets.
   */
  | "LEDGER_UNBALANCED_ASSET"

  // --- scope discipline -----------------------------------------------------
  /**
   * A `VIRTUAL_STRATEGY` entry names the instance it attributes to, and no
   * other scope may (ADR-006 §2; mirrors the WP-040 database constraint
   * `ledger_entries_instance_matches_scope`).
   */
  | "LEDGER_INSTANCE_SCOPE_MISMATCH"
  /**
   * The transaction changes an `ACTUAL_ACCOUNT` holding without stating its
   * attribution, or states an attribution no actual movement backs.
   *
   * ADR-006 §2: "Virtual allocation never creates or destroys value. The sum
   * of VIRTUAL_STRATEGY plus UNATTRIBUTED holdings for an asset equals the
   * ACTUAL_ACCOUNT holding for that asset." Enforced per transaction so §6
   * invariant 7 is checkable inductively from zero rather than hoped for.
   */
  | "LEDGER_ATTRIBUTION_PARITY_BROKEN"

  // --- asset identity -------------------------------------------------------
  /**
   * The same asset id was declared with two different asset kinds — within
   * one transaction or against the kind the ledger already recorded for it.
   * ADR-006 §7 rule 1: every entry carries an explicit asset identifier;
   * an identifier has exactly one kind.
   */
  | "LEDGER_ASSET_KIND_CONFLICT"
  /**
   * An outcome-token asset was posted under a different market than the one
   * the ledger already bound it to. An outcome token belongs to exactly one
   * market (§9.2 identity binding).
   */
  | "LEDGER_ASSET_MARKET_CONFLICT"

  // --- environment ----------------------------------------------------------
  /** The transaction's environment differs from the ledger's (§10.8 separation). */
  | "LEDGER_ENVIRONMENT_MISMATCH"

  // --- reversals ------------------------------------------------------------
  /** The referenced transaction to reverse is not in this ledger. */
  | "LEDGER_REVERSED_TRANSACTION_UNKNOWN"
  /** The referenced transaction was already reversed once (§10.7 append-only). */
  | "LEDGER_ALREADY_REVERSED"
  /**
   * A reversal must exactly negate the referenced transaction's per-leg
   * deltas (ADR-006 §5.2: "a compensating append-only reversal, never an
   * edit"). Anything else is an adjustment and must be booked as
   * `MANUAL_ADJUSTMENT` or `RECONCILIATION_CORRECTION` instead.
   */
  | "LEDGER_REVERSAL_NOT_COMPENSATING"

  // --- fill allocation ------------------------------------------------------
  /** The allocation claims sum to more than the actual fill quantity (§10.7, §16.2). */
  | "LEDGER_ALLOCATION_EXCEEDS_FILL"
  /** Two allocation claims name the same strategy instance for one fill. */
  | "LEDGER_ALLOCATION_DUPLICATE_INSTANCE"
  /**
   * A fee split was required but absent, or does not sum exactly to the fee.
   * A fee is prorated only by an explicit, machine-checked split — never by a
   * silently rounded division.
   */
  | "LEDGER_FEE_SPLIT_MISMATCH";

export type LedgerRefusalDetails = Readonly<Record<string, unknown>>;

/** A ledger question answered "no", with the reason machine-readable. */
export interface LedgerRefusal {
  readonly code: LedgerRefusalCode;
  readonly message: string;
  readonly details: LedgerRefusalDetails;
}

/** Builds a refusal. */
export function ledgerRefusal(
  code: LedgerRefusalCode,
  message: string,
  details: LedgerRefusalDetails = {},
): LedgerRefusal {
  return Object.freeze({ code, message, details: Object.freeze({ ...details }) });
}

/** A successful result, or the refusals that prevented it. */
export type LedgerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusals: readonly LedgerRefusal[] };

/** Wraps a value as a successful result. */
export function ledgerOk<T>(value: T): LedgerResult<T> {
  return { ok: true, value };
}

/** Wraps one or more refusals as a failed result. */
export function ledgerFailure<T>(...refusals: readonly LedgerRefusal[]): LedgerResult<T> {
  return { ok: false, refusals: Object.freeze([...refusals]) };
}

/** A caller error: the value handed to this package is structurally impossible. */
export class LedgerConfigurationError extends Error {
  readonly details: LedgerRefusalDetails;

  constructor(message: string, details: LedgerRefusalDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}
