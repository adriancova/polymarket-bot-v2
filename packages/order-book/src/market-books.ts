/**
 * The two independent outcome-token books of one binary market (§9.4:
 * "Maintain independent books for both outcome tokens").
 *
 * Independence is structural: two `OutcomeTokenBook` instances, one per
 * token, sharing nothing but the market identity and the market-level tick
 * size. Neither book is ever derived from, mirrored into, or reconciled
 * against the other — the YES and NO books are two venue order books, not
 * two views of one.
 *
 * Routing is by the payload's own `tokenId`; a payload naming a token that
 * is neither outcome token is a typed `ORDER_BOOK_UNKNOWN_TOKEN` refusal.
 */

import { OutcomeTokenBook } from "./book.js";
import { OrderBookConfigurationError } from "./errors.js";
import type { BookIngestMeta } from "./ingest.js";
import type { ApplyOutcome } from "./refusals.js";
import { refuse } from "./refusals.js";

export interface MarketBooksOptions {
  readonly internalMarketId: string;
  /** The two outcome tokens, in the catalogue's YES/NO order. Must differ. */
  readonly yesTokenId: string;
  readonly noTokenId: string;
}

type RoutablePayload = { readonly tokenId?: unknown };

export class MarketOutcomeBooks {
  readonly yesBook: OutcomeTokenBook;
  readonly noBook: OutcomeTokenBook;

  constructor(options: MarketBooksOptions) {
    if (options.yesTokenId === options.noTokenId) {
      throw new OrderBookConfigurationError(
        "ORDER_BOOK_DUPLICATE_OUTCOME_TOKEN",
        `the two outcome tokens of one market must be distinct: ${JSON.stringify(options.yesTokenId)}`,
      );
    }
    this.yesBook = new OutcomeTokenBook({
      internalMarketId: options.internalMarketId,
      tokenId: options.yesTokenId,
    });
    this.noBook = new OutcomeTokenBook({
      internalMarketId: options.internalMarketId,
      tokenId: options.noTokenId,
    });
  }

  /** The book for a token id, when it is one of the two outcome tokens. */
  bookFor(tokenId: string): OutcomeTokenBook | undefined {
    if (tokenId === this.yesBook.tokenId) {
      return this.yesBook;
    }
    if (tokenId === this.noBook.tokenId) {
      return this.noBook;
    }
    return undefined;
  }

  /** Routes a `BookSnapshot` payload to the token's own book. */
  applySnapshot(input: { readonly payload: unknown; readonly meta: BookIngestMeta }): ApplyOutcome {
    return this.#route(input, (book) => book.applySnapshot(input));
  }

  /** Routes a `BookLevelChanged` payload to the token's own book. */
  applyLevelChange(input: { readonly payload: unknown; readonly meta: BookIngestMeta }): ApplyOutcome {
    return this.#route(input, (book) => book.applyLevelChange(input));
  }

  /**
   * Applies a market-level tick-size change to BOTH books. Tick size is a
   * market trading parameter (`TradingParametersChanged` is keyed by market,
   * not token), so the two books share it; refusals are per book and the
   * first refusal is returned (the second book is left untouched only when
   * the first refused — both books validate the same input, so a refusal is
   * identical for both).
   */
  applyTickSizeChange(input: {
    readonly tickSize: string;
    readonly parametersVersion?: number;
  }): ApplyOutcome {
    const yes = this.yesBook.applyTickSizeChange(input);
    if (!yes.applied) {
      return yes;
    }
    return this.noBook.applyTickSizeChange(input);
  }

  #route(
    input: { readonly payload: unknown },
    apply: (book: OutcomeTokenBook) => ApplyOutcome,
  ): ApplyOutcome {
    const payload = input.payload;
    const tokenId =
      typeof payload === "object" && payload !== null
        ? (payload as RoutablePayload).tokenId
        : undefined;
    if (typeof tokenId !== "string") {
      return refuse(
        "ORDER_BOOK_INPUT_INVALID",
        "the payload carries no string tokenId to route by",
      );
    }
    const book = this.bookFor(tokenId);
    if (book === undefined) {
      return refuse(
        "ORDER_BOOK_UNKNOWN_TOKEN",
        "the payload's tokenId is neither of this market's two outcome tokens",
        {
          tokenId,
          yesTokenId: this.yesBook.tokenId,
          noTokenId: this.noBook.tokenId,
        },
      );
    }
    return apply(book);
  }
}
