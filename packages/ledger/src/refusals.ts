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
 *
 * THE PROTOTYPE-FREE DOOR (`WP-200-FU1`, 2026-09-04). Three of this module's
 * exports are the shared half of ADR-020 §3's D1-D4 rule:
 * {@link readInputAsData} performs **D1** (materialize before parsing),
 * {@link contained} keeps the totality half of ADR-020 §6 (no throw escapes a
 * function whose contract is a typed refusal), and {@link ledgerRefusal} now
 * builds its `details` with `ownDataDetails` so BUILDING a refusal cannot run
 * caller code either. All three are imported from `@polymarket-bot/risk`'s
 * canonical door across the `docs/contracts/dependency-direction.md` §2.1
 * **S5** same-layer edge — the door is consumed, never copied
 * (`WP-180-FU2`'s deletion guard).
 */

import { describeValue, ownDataDetails, readPlainData } from "@polymarket-bot/risk/plain-data";

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

/**
 * Builds a refusal.
 *
 * TOTAL FOR ANY `details` (`WP-200-FU1`). The body was
 * `Object.freeze({ ...details })`, and a spread is an own-only READ that still
 * runs a `Proxy`'s traps and INVOKES any getter on the object — so the
 * constructor whose entire purpose is to say "no" could itself throw. The same
 * defect and the same fix as `packages/risk`'s `riskRefusal` (review round 6,
 * BLOCKER 3); `ownDataDetails` copies own DATA properties only, records the
 * count of anything it could not copy under `detailsUnreadable`, and returns a
 * frozen prototype-free record (**D4**).
 */
export function ledgerRefusal(
  code: LedgerRefusalCode,
  message: string,
  details: LedgerRefusalDetails = {},
): LedgerRefusal {
  return Object.freeze({ code, message, details: ownDataDetails(details) });
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

/**
 * THE OUTER CONTAINMENT GUARD (ADR-020 §6, `WP-200-FU1`).
 *
 * Every function here that promises a `LedgerResult` keeps that promise
 * whatever the input did. The site fix is **D1** — read the input as data
 * before any schema touches it ({@link readInputAsData}) — and this is the
 * structural half: a throw from anywhere inside becomes a typed refusal, so
 * "permission never varies and no throw escapes" is a property of the shape of
 * the function rather than of a reviewer having thought of every value.
 *
 * The refusal carries only the thrown value's TYPE, never its message and never
 * a coercion of it: reading `.message` off a caller-supplied thrown object is
 * one more place caller code runs. Copied in FORM (not in body) from
 * `packages/capital-allocator`'s `contained`, which is the WP-180 reference.
 *
 * The two documented THROWS of this package are deliberately outside every
 * guard: `Ledger.empty` and the `LedgerConfigurationError` it raises are a
 * construction-time contract, not a recoverable refusal, and `WP-200`'s tests
 * pin them.
 */
export function contained<T>(body: () => LedgerResult<T>): LedgerResult<T> {
  try {
    return body();
  } catch (error) {
    return ledgerFailure<T>(
      ledgerRefusal(
        "LEDGER_INPUT_INVALID",
        "the operation could not be completed on this input and is refused rather than " +
          "throwing; a ledger boundary answers with a typed refusal (ADR-020 §6)",
        { thrown: describeValue(error) },
      ),
    );
  }
}

/**
 * **D1** — reads a caller-supplied `unknown` into plain own data, or refuses.
 *
 * THE DOOR IN FRONT OF EVERY SCHEMA IN THIS PACKAGE. `safeParse` is a
 * validator, not a safe way to LOOK at a caller's object: it reads properties
 * through the prototype chain, so an inherited value is ADOPTED as though the
 * caller had supplied it, a getter runs, and a `Proxy` trap runs. Measured at
 * `main` `761db76`, on this package, before this change:
 *
 * ```text
 * a fill-booking transaction with fillId and NO own marketId
 *   clean                                    → LEDGER_MARKET_REQUIRED (F16)
 *   one NON-ENUMERABLE Object.prototype.marketId → ACCEPTED
 * ledgerTransactionId "totally-not-a-uuid", occurredAt "yesterday-ish"
 *   clean                                    → LEDGER_INPUT_INVALID
 *   one NON-ENUMERABLE Object.prototype.skipChecks → ACCEPTED, both values kept
 * ```
 *
 * `readPlainData` takes the value apart with DESCRIPTORS, refuses what is not
 * data, and hands the schema a materialized tree with **no prototype** —
 * so absence stays absence, for the schema and for every later read.
 *
 * `what` names the value in the refusal message ("ledger transaction"), and
 * `path` roots the per-problem paths ("transaction.entries[0].amount: …").
 */
export function readInputAsData(
  value: unknown,
  path: string,
  what: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly refusal: LedgerRefusal } {
  const read = readPlainData(value, path);
  if (read.ok) {
    return { ok: true, value: read.value };
  }
  return {
    ok: false,
    refusal: ledgerRefusal(
      "LEDGER_INPUT_INVALID",
      `the ${what} is not a data record: an input is a finite tree of plain own data, so ` +
        "hidden, inherited, computed or unreadable state is refused rather than inspected " +
        "(fail closed)",
      { issues: read.problems.map((problem) => `${problem.path}: ${problem.problem}`) },
    ),
  };
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
