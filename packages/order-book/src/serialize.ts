/**
 * Deterministic canonical serialization of one book's reconstructed state.
 *
 * One state has exactly one serialization: fixed line order, canonical
 * decimal spellings (the only spellings the book can hold), bids descending,
 * asks ascending, `\n` separators, no trailing whitespace. This is what the
 * replay-golden acceptance criterion compares BYTE FOR BYTE, and what the
 * REST-snapshot validation quotes in findings.
 *
 * The format is versioned by its first line so a change to it is visible in
 * every golden fixture rather than silently absorbed.
 *
 * Absent values serialize as `-` (no canonical decimal or identifier can be
 * `-`, so the marker is unambiguous).
 */

import type { OutcomeTokenBook } from "./book.js";

export const BOOK_SERIALIZATION_VERSION = "polymarket-bot/order-book/v1" as const;

const ABSENT = "-";

/** Serializes the book's queryable state deterministically. Pure. */
export function serializeBook(book: OutcomeTokenBook): string {
  const baseline = book.baseline();
  const lastUpdate = book.lastUpdate();
  const bids = book.levels("BID");
  const asks = book.levels("ASK");
  const top = book.topOfBook();
  const depth = book.depth();

  const lines: string[] = [
    BOOK_SERIALIZATION_VERSION,
    `market ${book.internalMarketId}`,
    `token ${book.tokenId}`,
    `epoch ${baseline?.gatewayEpoch ?? ABSENT}`,
    `generation ${baseline === undefined ? ABSENT : String(baseline.subscriptionGeneration)}`,
    `lastIngestSeq ${lastUpdate?.ingestSeq ?? ABSENT}`,
    `venueBookHash ${book.venueBookHash() ?? ABSENT}`,
    `tickSize ${book.tickSize() ?? ABSENT}`,
    `bestBid ${top.bestBidPrice ?? ABSENT} ${top.bestBidSize ?? ABSENT}`,
    `bestAsk ${top.bestAskPrice ?? ABSENT} ${top.bestAskSize ?? ABSENT}`,
    `spread ${top.spread ?? ABSENT}`,
    `depth bids ${String(depth.bidLevels)} ${depth.bidShares} asks ${String(depth.askLevels)} ${depth.askShares}`,
    `bids ${String(bids.length)}`,
    ...bids.map((level) => `${level.price} ${level.size}`),
    `asks ${String(asks.length)}`,
    ...asks.map((level) => `${level.price} ${level.size}`),
  ];
  return lines.join("\n");
}
