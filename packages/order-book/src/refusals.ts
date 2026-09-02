/**
 * Typed refusals (handoff §21: "Errors are typed and observable").
 *
 * A REFUSAL is data, following the established repository pattern
 * (`@polymarket-bot/universe`, `@polymarket-bot/settlement`, the `WP-070` feed
 * outcomes): the book answers "no" by returning the reason, carrying the
 * evidence, so the composition root can open a `DataQualityIncidentOpened`
 * with the offending value attached. Nothing here logs, throws for a
 * recoverable condition, or silently tolerates a value the contract forbids.
 *
 * Codes are stable `CodeString`-shaped identifiers (§14.3 labels metrics by
 * reason code).
 */

/** Why an update, query, or helper call was refused. */
export type OrderBookRefusalCode =
  // --- input validation -----------------------------------------------------
  /** The payload failed its frozen domain contract. */
  | "ORDER_BOOK_INPUT_INVALID"
  /**
   * A UUID-shaped identifier arrived in a non-canonical (non-lowercase)
   * spelling. ADR-016 §2 (2026-09-02 amendment): REFUSE, never case-fold. The
   * raw value rides on the refusal so the caller's defect is diagnosable.
   */
  | "ORDER_BOOK_UUID_NOT_CANONICAL"
  /** A price or size is not in the canonical decimal grammar (ADR-001 §3.1). */
  | "ORDER_BOOK_NONCANONICAL_DECIMAL"
  /** The ingest metadata is malformed (`ingestSeq`, timestamps, generation). */
  | "ORDER_BOOK_INGEST_META_INVALID"

  // --- identity -------------------------------------------------------------
  /** The payload names a different market or token than this book's (§9.4: independent books, never mixed). */
  | "ORDER_BOOK_IDENTITY_MISMATCH"
  /** The routed token id is neither of this market's two outcome tokens. */
  | "ORDER_BOOK_UNKNOWN_TOKEN"

  // --- freshness / ordering -------------------------------------------------
  /**
   * The update carries a subscription generation OLDER than the accepted
   * baseline's (§9.4: "Reject updates from a stale subscription generation").
   * Carries both generations.
   */
  | "ORDER_BOOK_STALE_SUBSCRIPTION_GENERATION"
  /**
   * A level change carries a NEWER generation than the baseline snapshot's. A
   * generation advances exactly when a gap opens
   * (`packages/polymarket-public/src/feed/subscriptions.ts`), and a gap
   * requires an authoritative snapshot before affected markets resume (§7.1);
   * a delta may not resume the market on its own.
   */
  | "ORDER_BOOK_GENERATION_AHEAD_REQUIRES_SNAPSHOT"
  /**
   * The update carries no subscription generation where one is required.
   * Fail closed: every legitimate producer path stamps one (WS events carry
   * the session's generation; REST snapshots taken to close a gap are stamped
   * by the fetcher), so an unstamped update is unattributable to a stream.
   */
  | "ORDER_BOOK_MISSING_SUBSCRIPTION_GENERATION"
  /**
   * The update's `gatewayEpoch` differs from the baseline's. Epochs are
   * identity, not chronology (`docs/contracts/wal-format.md` §12.1): no order
   * across epochs exists, so a non-snapshot update from another epoch cannot
   * be sequenced against this book. Only an authoritative snapshot may move
   * the book to a new epoch (§7.1).
   */
  | "ORDER_BOOK_EPOCH_MISMATCH"
  /** A level change arrived before any baseline snapshot (§7.1). */
  | "ORDER_BOOK_NO_BASELINE_SNAPSHOT"
  /**
   * Within one epoch, `ingestSeq` must strictly increase (§7.1:
   * "`gatewayEpoch + ingestSeq` defines the exact order consumed"). A replayed
   * or reordered update is refused, never silently applied twice.
   */
  | "ORDER_BOOK_OUT_OF_ORDER_INGEST"
  /** One snapshot side carries the same price twice; depth is ambiguous. */
  | "ORDER_BOOK_DUPLICATE_SNAPSHOT_LEVEL"

  // --- trading parameters ---------------------------------------------------
  /** A tick-size change names an older `parametersVersion` than one already applied. */
  | "ORDER_BOOK_PARAMETERS_VERSION_REGRESSION"
  /** A tick-size change restates an applied `parametersVersion` with a different value. */
  | "ORDER_BOOK_PARAMETERS_VERSION_CONTRADICTION"
  /** The tick size is not a positive canonical decimal. */
  | "ORDER_BOOK_TICK_SIZE_INVALID"

  // --- queries --------------------------------------------------------------
  /** The requested quantity is not a positive canonical decimal. */
  | "ORDER_BOOK_INVALID_QUANTITY"
  /**
   * The book cannot fill the requested quantity (§9.4 executable price).
   * Typed, carrying requested and available shares — never a partial silent
   * answer.
   */
  | "ORDER_BOOK_INSUFFICIENT_DEPTH"

  // --- price helpers --------------------------------------------------------
  /** No tick size has been applied to the book yet, so no grid exists. */
  | "ORDER_BOOK_NO_TICK_SIZE"
  /**
   * The helper was pinned to a tick size the book no longer trades at
   * (workplan acceptance 3: tick changes invalidate nonconforming price
   * helpers — typed, visible, never silently wrong).
   */
  | "ORDER_BOOK_PRICE_HELPER_INVALIDATED";

/** One refusal, with its evidence. */
export interface OrderBookRefusal {
  readonly code: OrderBookRefusalCode;
  /** Bounded human-readable text; never parsed. */
  readonly detail: string;
  /** The offending value(s), preserved so an incident carries its evidence. */
  readonly evidence?: Readonly<Record<string, string | number | undefined>>;
}

/** Successful application of one update. */
export interface Applied {
  readonly applied: true;
}

/** Refused application of one update. */
export interface Refused {
  readonly applied: false;
  readonly refusal: OrderBookRefusal;
}

/** The outcome of feeding one update to a book. */
export type ApplyOutcome = Applied | Refused;

export const APPLIED: Applied = Object.freeze({ applied: true });

export function refuse(
  code: OrderBookRefusalCode,
  detail: string,
  evidence?: Readonly<Record<string, string | number | undefined>>,
): Refused {
  return {
    applied: false,
    refusal: evidence === undefined ? { code, detail } : { code, detail, evidence },
  };
}
