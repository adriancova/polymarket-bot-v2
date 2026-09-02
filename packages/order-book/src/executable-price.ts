/**
 * Executable price for a requested quantity (§9.4): a volume-weighted walk
 * of the reconstructed book, in exact decimals.
 *
 * A BUY consumes resting asks from the best (lowest) upward; a SELL consumes
 * resting bids from the best (highest) downward. When the book cannot fill
 * the whole requested quantity the answer is a typed
 * `ORDER_BOOK_INSUFFICIENT_DEPTH` refusal carrying requested and available
 * shares — never a partial silent answer.
 *
 * `totalCost` and `worstPrice` are exact. The volume-weighted average price
 * is a division and can be non-terminating, so it uses
 * `divDecimal`'s documented policy — 34 significant digits,
 * `ROUND_HALF_EVEN` — overridable per call via `division` (ADR-001 §3.3:
 * components pass an explicit rounding mode where they need one).
 */

import { addDecimal, compareDecimal, divDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import type { DivisionOptions } from "@polymarket-bot/decimal";
import { PositiveDecimalStringSchema } from "@polymarket-bot/domain";
import type { DecimalString } from "@polymarket-bot/domain";

import type { OutcomeTokenBook } from "./book.js";
import type { OrderBookRefusal } from "./refusals.js";
import { refuse } from "./refusals.js";

export interface ExecutablePriceRequest {
  /** The taker's own direction: BUY consumes asks, SELL consumes bids. */
  readonly side: "BUY" | "SELL";
  /** Requested quantity in shares; positive canonical decimal. */
  readonly shares: string;
  /** Optional explicit precision/rounding for the average-price division. */
  readonly division?: DivisionOptions;
}

export interface ExecutablePriceQuote {
  readonly ok: true;
  readonly side: "BUY" | "SELL";
  readonly requestedShares: DecimalString;
  /** Exact sum of `level price × shares taken` over the walk. */
  readonly totalCost: DecimalString;
  /** `totalCost / requestedShares` under the documented division policy. */
  readonly volumeWeightedAveragePrice: DecimalString;
  /** The last (worst) level price the walk consumed. */
  readonly worstPrice: DecimalString;
  readonly levelsConsumed: number;
}

export interface ExecutablePriceRefusal {
  readonly ok: false;
  readonly refusal: OrderBookRefusal;
}

export type ExecutablePriceResult = ExecutablePriceQuote | ExecutablePriceRefusal;

/** Volume-weighted executable price over the book's current levels. Pure. */
export function executablePrice(
  book: OutcomeTokenBook,
  request: ExecutablePriceRequest,
): ExecutablePriceResult {
  const shares = PositiveDecimalStringSchema.safeParse(request.shares);
  if (!shares.success) {
    return {
      ok: false,
      refusal: refuse(
        "ORDER_BOOK_INVALID_QUANTITY",
        "requested shares must be a positive canonical decimal string",
        { shares: request.shares },
      ).refusal,
    };
  }
  const requested: DecimalString = shares.data;

  // BUY walks asks ascending (already sorted best-first); SELL walks bids
  // descending (already sorted best-first).
  const ladder = request.side === "BUY" ? book.levels("ASK") : book.levels("BID");

  let remaining: DecimalString = requested;
  let totalCost: DecimalString = "0";
  let worstPrice: DecimalString | undefined;
  let levelsConsumed = 0;

  for (const level of ladder) {
    if (compareDecimal(remaining, "0") === 0) {
      break;
    }
    const take =
      compareDecimal(level.size, remaining) < 0 ? level.size : remaining;
    totalCost = addDecimal(totalCost, mulDecimal(take, level.price));
    remaining = subDecimal(remaining, take);
    worstPrice = level.price;
    levelsConsumed += 1;
  }

  if (compareDecimal(remaining, "0") > 0 || worstPrice === undefined) {
    const available = subDecimal(requested, remaining);
    return {
      ok: false,
      refusal: refuse(
        "ORDER_BOOK_INSUFFICIENT_DEPTH",
        "the book cannot fill the requested quantity; no partial answer is returned",
        {
          side: request.side,
          requestedShares: requested,
          availableShares: available,
        },
      ).refusal,
    };
  }

  return {
    ok: true,
    side: request.side,
    requestedShares: requested,
    totalCost,
    volumeWeightedAveragePrice: divDecimal(totalCost, requested, request.division),
    worstPrice,
    levelsConsumed,
  };
}
