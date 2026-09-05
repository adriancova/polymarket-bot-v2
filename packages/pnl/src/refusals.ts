/**
 * Typed refusals (handoff §21: "Errors are typed and observable").
 *
 * A REFUSAL is data — the engine answers "no" with a machine-readable reason
 * and the evidence attached (the `universe`/`ledger` pattern). The engine
 * never adjusts an input to make it foldable, never guesses a valuation, and
 * never realizes anything an input did not prove. This package is pure; the
 * composition root owns the response to each refusal.
 *
 * THE PROTOTYPE-FREE DOOR (`WP-200-FU1`, 2026-09-04). Three of this module's
 * exports are the shared half of ADR-020 §3's D1-D4 rule:
 * {@link readInputAsData} performs **D1** (materialize before parsing),
 * {@link contained} keeps the totality half of ADR-020 §6, and
 * {@link pnlRefusal} now builds its `details` with `ownDataDetails` so BUILDING
 * a refusal cannot run caller code either. All three come from
 * `@polymarket-bot/risk`'s canonical door across the
 * `docs/contracts/dependency-direction.md` §2.1 **S6** same-layer edge — the
 * door is consumed, never copied (`WP-180-FU2`'s deletion guard).
 */

import { describeValue, ownDataDetails, readPlainData } from "@polymarket-bot/risk/plain-data";

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
  | "PNL_REWARD_EVIDENCE_MISMATCH"
  /**
   * The named ledger transaction has ALREADY been realized by this stream
   * under a different record reference. One observed payout is one booking is
   * one realization: deduplicating the PnL record's own `ref` says nothing
   * about the money, because two distinct refs can name the same booking
   * (review round 2, HIGH-2).
   */
  | "PNL_REWARD_EVIDENCE_ALREADY_REALIZED";

export type PnlRefusalDetails = Readonly<Record<string, unknown>>;

/** A PnL question answered "no", with the reason machine-readable. */
export interface PnlRefusal {
  readonly code: PnlRefusalCode;
  readonly message: string;
  readonly details: PnlRefusalDetails;
}

/**
 * Builds a refusal.
 *
 * TOTAL FOR ANY `details` (`WP-200-FU1`). The body was
 * `Object.freeze({ ...details })`, and a spread is an own-only READ that still
 * runs a `Proxy`'s traps and INVOKES any getter on the object — so the
 * constructor whose entire purpose is to say "no" could itself throw.
 * `ownDataDetails` copies own DATA properties only, records the count of
 * anything it could not copy under `detailsUnreadable`, and returns a frozen
 * prototype-free record (**D4**).
 */
export function pnlRefusal(
  code: PnlRefusalCode,
  message: string,
  details: PnlRefusalDetails = {},
): PnlRefusal {
  return Object.freeze({ code, message, details: ownDataDetails(details) });
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

/**
 * THE OUTER CONTAINMENT GUARD (ADR-020 §6, `WP-200-FU1`).
 *
 * Every function here that promises a `PnlResult` keeps that promise whatever
 * the input did. The site fix is **D1** — read the input as data before any
 * schema touches it ({@link readInputAsData}) — and this is the structural
 * half. It matters more in this package than anywhere else in the monetary
 * path, because the cold-first-parse class measured on `PnlRecordSchema`
 * escaped a `TypeError` out of `applyPnlRecord` at `main` `761db76`:
 *
 * ```text
 * one ENUMERABLE Object.prototype.zzUnrelated = 1, fresh import of state.js
 *   applyPnlRecord(state, a valid TRADE)  → ESCAPED TypeError:
 *                                            Cannot read properties of undefined
 *                                            (reading 'values')
 *   the SAME call afterwards, prototype clean
 *                                        → ESCAPED Error: Invalid discriminated
 *                                            union option at index "0"  ← POISONED
 * ```
 *
 * The site fix for THAT is the warmed arena (`records.ts`); this guard is what
 * makes the promise structural rather than a list of the throws somebody
 * thought of.
 *
 * The refusal carries only the thrown value's TYPE, never its message and never
 * a coercion of it. The two documented THROWS of this package —
 * `emptyPnlState`'s and `PnlSettlementEvidence`'s `PnlConfigurationError` — are
 * deliberately outside every guard: they are construction-time contracts, and
 * `WP-200`'s tests pin them.
 */
export function contained<T>(body: () => PnlResult<T>): PnlResult<T> {
  try {
    return body();
  } catch (error) {
    return pnlFailure<T>(
      pnlRefusal(
        "PNL_INPUT_INVALID",
        "the operation could not be completed on this input and is refused rather than " +
          "throwing; a PnL boundary answers with a typed refusal (ADR-020 §6)",
        { thrown: describeValue(error) },
      ),
    );
  }
}

/**
 * **D1** — reads a caller-supplied `unknown` into plain own data, or refuses.
 *
 * THE DOOR IN FRONT OF EVERY SCHEMA IN THIS PACKAGE. `safeParse` reads
 * properties through the prototype chain, so an inherited value is ADOPTED as
 * though the caller had supplied it. Measured at `main` `761db76`, on this
 * package, before this change:
 *
 * ```text
 * a TRADE record with no own `price`
 *   clean                                      → PNL_INPUT_INVALID
 *   one NON-ENUMERABLE Object.prototype.price = "0.99"
 *                                              → ACCEPTED, lot costBasis "9.9"
 * a REWARD_ESTIMATE with ref "totally-not-a-uuid" and three garbage timestamps
 *   clean                                      → PNL_INPUT_INVALID
 *   one NON-ENUMERABLE Object.prototype.skipChecks
 *                                              → ACCEPTED, folded verbatim
 * ```
 *
 * `readPlainData` takes the value apart with DESCRIPTORS, refuses what is not
 * data, and hands the schema a materialized tree with **no prototype**.
 */
export function readInputAsData(
  value: unknown,
  path: string,
  what: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly refusal: PnlRefusal } {
  const read = readPlainData(value, path);
  if (read.ok) {
    return { ok: true, value: read.value };
  }
  return {
    ok: false,
    refusal: pnlRefusal(
      "PNL_INPUT_INVALID",
      `the ${what} is not a data record: an input is a finite tree of plain own data, so ` +
        "hidden, inherited, computed or unreadable state is refused rather than inspected " +
        "(fail closed)",
      { issues: read.problems.map((problem) => `${problem.path}: ${problem.problem}`) },
    ),
  };
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
