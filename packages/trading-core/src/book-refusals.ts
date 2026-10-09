/**
 * `C1-HALTS` (BOOK-WAITS; the user's ruling of 2026-10-08): what the trader
 * does when one of its books refuses an update.
 *
 * Until `C1-HALTS` EVERY refusal latched a `BOOK_DESYNCHRONIZED` halt, and
 * every halt ends the run — including the refusals `packages/order-book`
 * itself defines as "refused pending a snapshot", and a restart whose first
 * events for a token are level changes (`ORDER_BOOK_NO_BASELINE_SNAPSHOT`,
 * THROUGHPUT-1a deviation 3), which the next restart would repeat. Now the
 * refusals are three classes:
 *
 * | Class | Codes | What the loop does |
 * | --- | --- | --- |
 * | `BENIGN` | a stale subscription generation; a replayed or reordered `ingestSeq` | counts it. The book already holds newer state; nothing was lost |
 * | `DIVERGENCE` | no baseline; a newer generation; another epoch; an unstamped update; a duplicate snapshot level — every refused update that is neither of the others | counts it and clears the book's baseline and delivery-session key, so risk check 8 (`bookSynchronized`) refuses that market's entries AND reductions, and the book's age reads its last APPLIED change (ADR-023 rule 2), until the next applied `BookSnapshot` re-arms it. Cancels stay allowed (check 8 gates placements only) |
 * | `FAULT` | an unknown token; an identity mismatch; a payload or ingest metadata that fails its contract; a trading-parameter contradiction | latches `BOOK_DESYNCHRONIZED` (MARKET scope), which ends the run: a contract or programming fault, not a market condition |
 *
 * A SNAPSHOT refused as `BENIGN` (a stale generation or a replayed sequence)
 * is benign for the same reason a delta is: the book's baseline is newer than
 * the refused snapshot, so it still describes the venue. Any other refused
 * snapshot is a `DIVERGENCE`: the venue sent a new authoritative state this
 * book could not take.
 *
 * The switch is exhaustive over `OrderBookRefusalCode`, so a new order-book
 * code is a compile error here until someone decides its class. The query and
 * helper codes are never answered by an apply; they are `FAULT` (fail closed)
 * should one ever be.
 */

import type { OrderBookRefusalCode } from "@polymarket-bot/order-book";

export type BookRefusalClass = "BENIGN" | "DIVERGENCE" | "FAULT";

export function classifyBookRefusal(code: OrderBookRefusalCode): BookRefusalClass {
  switch (code) {
    case "ORDER_BOOK_STALE_SUBSCRIPTION_GENERATION":
    case "ORDER_BOOK_OUT_OF_ORDER_INGEST":
      return "BENIGN";
    case "ORDER_BOOK_NO_BASELINE_SNAPSHOT":
    case "ORDER_BOOK_GENERATION_AHEAD_REQUIRES_SNAPSHOT":
    case "ORDER_BOOK_EPOCH_MISMATCH":
    case "ORDER_BOOK_MISSING_SUBSCRIPTION_GENERATION":
    case "ORDER_BOOK_DUPLICATE_SNAPSHOT_LEVEL":
      return "DIVERGENCE";
    case "ORDER_BOOK_INPUT_INVALID":
    case "ORDER_BOOK_UUID_NOT_CANONICAL":
    case "ORDER_BOOK_NONCANONICAL_DECIMAL":
    case "ORDER_BOOK_INGEST_META_INVALID":
    case "ORDER_BOOK_IDENTITY_MISMATCH":
    case "ORDER_BOOK_UNKNOWN_TOKEN":
    case "ORDER_BOOK_PARAMETERS_VERSION_REGRESSION":
    case "ORDER_BOOK_PARAMETERS_VERSION_CONTRADICTION":
    case "ORDER_BOOK_TICK_SIZE_INVALID":
    case "ORDER_BOOK_INVALID_QUANTITY":
    case "ORDER_BOOK_INSUFFICIENT_DEPTH":
    case "ORDER_BOOK_NO_TICK_SIZE":
    case "ORDER_BOOK_PRICE_HELPER_INVALIDATED":
      return "FAULT";
  }
}

/** One market's book-refusal counts (`CoreLoop.bookRefusals`). */
export interface BookRefusalCounts {
  /** Refusals counted and dropped: the book still held newer state. */
  readonly benign: number;
  /** Refusals that cleared a book's baseline until its next snapshot. */
  readonly divergence: number;
  /** Outcome books currently waiting for a snapshot (`YES`/`NO`, sorted). */
  readonly waiting: readonly ("YES" | "NO")[];
}
