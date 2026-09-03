/**
 * Typed refusals (handoff §21: "Errors are typed and observable").
 *
 * A REFUSAL is data — the engine answers "no" with a machine-readable reason
 * and the evidence attached (the `universe`/`ledger` pattern). The engine
 * never adjusts an input to make it foldable, never guesses a valuation, and
 * never realizes anything an input did not prove. This package is pure; the
 * composition root owns the response to each refusal.
 */

export type PnlRefusalCode =
  /** The input failed schema validation before any accounting rule ran. */
  | "PNL_INPUT_INVALID"
  /**
   * A UUID-shaped identifier arrived in a non-canonical spelling.
   * ADR-016 §2: refused carrying the raw value — never case-folded.
   */
  | "PNL_UUID_NOT_CANONICAL"
  /** The record's owner is not the owner this state folds. */
  | "PNL_OWNER_MISMATCH"
  /** This record reference was already folded into this state. */
  | "PNL_DUPLICATE_REF"
  /**
   * A trade whose settlement state is already `FAILED` is not recognized:
   * ADR-006 §5 books a failure as a compensating reversal of a previously
   * recognized trade, never as a fresh recognition.
   */
  | "PNL_SETTLEMENT_FAILED_TRADE"
  /**
   * The record removes more shares than the position holds. Selling requires
   * inventory (venue report §10.2); a negative position here would corrupt
   * average-cost accounting. The caller escalates to reconciliation instead.
   */
  | "PNL_OVERSELL"
  /** A token lot's denomination asset is fixed by its first record (C-2 rule). */
  | "PNL_DENOMINATION_CONFLICT"
  /** The reversal references a trade this state never folded. */
  | "PNL_REVERSAL_UNKNOWN"
  /** The referenced trade was already reversed once. */
  | "PNL_ALREADY_REVERSED"
  /**
   * The position can no longer absorb an exact unwind of the referenced
   * trade (it was partially consumed since). Exact unwinding is ill-defined
   * here; the caller books a reconciliation correction instead.
   */
  | "PNL_REVERSAL_INSUFFICIENT_POSITION"
  /**
   * An open position has no midpoint mark: unrealized PnL at midpoint is a
   * required measure (§9.16) and is never guessed.
   */
  | "PNL_MARK_MISSING"
  /**
   * A reward payout arrived with no settlement evidence to check it against.
   * ADR-006 §6: only an OBSERVED payout realizes a reward, and an identifier
   * is not an observation — the caller supplies the booked ledger
   * transaction, not its id (`evidence.ts`).
   */
  | "PNL_REWARD_EVIDENCE_MISSING"
  /** The named ledger transaction is not in the supplied evidence set. */
  | "PNL_REWARD_EVIDENCE_UNKNOWN"
  /**
   * The named transaction exists but does not book THIS payout: wrong event
   * type, wrong environment, an unsettled state, no matching `REWARD_INCOME`
   * entries, or nothing credited to this owner.
   */
  | "PNL_REWARD_EVIDENCE_MISMATCH";

export type PnlRefusalDetails = Readonly<Record<string, unknown>>;

/** A PnL question answered "no", with the reason machine-readable. */
export interface PnlRefusal {
  readonly code: PnlRefusalCode;
  readonly message: string;
  readonly details: PnlRefusalDetails;
}

/** Builds a refusal. */
export function pnlRefusal(
  code: PnlRefusalCode,
  message: string,
  details: PnlRefusalDetails = {},
): PnlRefusal {
  return Object.freeze({ code, message, details: Object.freeze({ ...details }) });
}

/** A successful result, or the refusals that prevented it. */
export type PnlResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusals: readonly PnlRefusal[] };

/** Wraps a value as a successful result. */
export function pnlOk<T>(value: T): PnlResult<T> {
  return { ok: true, value };
}

/** Wraps one or more refusals as a failed result. */
export function pnlFailure<T>(...refusals: readonly PnlRefusal[]): PnlResult<T> {
  return { ok: false, refusals: Object.freeze([...refusals]) };
}

/** A caller error: the value handed to this package is structurally impossible. */
export class PnlConfigurationError extends Error {
  readonly details: PnlRefusalDetails;

  constructor(message: string, details: PnlRefusalDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}
