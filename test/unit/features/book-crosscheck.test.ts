/**
 * The WP-150 carried follow-ups, proved against the REAL order-book package:
 *
 * 1. NO SECOND CANONICAL SERIALIZATION: the feature engine consumes
 *    `serializeBook`'s exact output. This test drives live
 *    `OutcomeTokenBook` instances through snapshots and level changes and
 *    feeds every resulting serialization to the features reader — version
 *    constant, ladders, top-of-book, and depth must all round-trip.
 * 2. DIVISION POLICY: the features VWAP (pinned 34-digit HALF_EVEN) must
 *    equal `executablePrice`'s documented default on identical books and
 *    quantities, quote and refusal alike.
 *
 * Both packages are imported ONLY through their `exports` entry modules
 * (WP-150 replay-golden precedent for root-tree tests).
 */

import { describe, expect, it } from "vitest";

import {
  BOOK_SERIALIZATION_VERSION,
  OutcomeTokenBook,
  executablePrice,
  serializeBook,
} from "../../../packages/order-book/src/index.js";
import type { BookIngestMeta } from "../../../packages/order-book/src/index.js";
import {
  SUPPORTED_BOOK_SERIALIZATION_VERSION,
  computeFeatureSnapshot,
  readBookSerialization,
} from "../../../packages/features/src/index.js";
import type { FeatureSnapshot } from "../../../packages/features/src/index.js";
import { EPOCH, MARKET, TOKEN, validInput } from "./fixtures.js";

function meta(ingestSeq: string, generation = 3): BookIngestMeta {
  return {
    gatewayEpoch: EPOCH,
    ingestSeq,
    subscriptionGeneration: generation,
    receivedAt: "2026-09-03T11:59:59.500Z",
  };
}

/** A live book matching the root fixture's hand-written serialization. */
function buildFixtureBook(): OutcomeTokenBook {
  const book = new OutcomeTokenBook({ internalMarketId: MARKET, tokenId: TOKEN });
  const applied = book.applySnapshot({
    payload: {
      internalMarketId: MARKET,
      tokenId: TOKEN,
      bids: [
        { price: "0.48", size: "100" },
        { price: "0.47", size: "50" },
        { price: "0.45", size: "200" },
      ],
      asks: [
        { price: "0.52", size: "80" },
        { price: "0.53", size: "120" },
      ],
      venueBookHash: "abc123",
    },
    meta: meta("41"),
  });
  expect(applied.applied).toBe(true);
  const tick = book.applyTickSizeChange({ tickSize: "0.01" });
  expect(tick.applied).toBe(true);
  const change = book.applyLevelChange({
    payload: { internalMarketId: MARKET, tokenId: TOKEN, side: "BID", price: "0.48", size: "100" },
    meta: meta("42"),
  });
  expect(change.applied).toBe(true);
  return book;
}

describe("the serializeBook <-> features reader binding", () => {
  it("shares one version constant with WP-150", () => {
    expect(SUPPORTED_BOOK_SERIALIZATION_VERSION).toBe(BOOK_SERIALIZATION_VERSION);
  });

  it("the live book's serialization equals the root fixture's hand-written text", () => {
    const book = buildFixtureBook();
    const expected = (validInput()["book"] as { serializedBook: string }).serializedBook;
    expect(serializeBook(book)).toBe(expected);
  });

  it("round-trips a populated book: ladders, top, and depth agree with the live queries", () => {
    const book = buildFixtureBook();
    const read = readBookSerialization(serializeBook(book));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.book.bids).toEqual(book.levels("BID"));
    expect(read.book.asks).toEqual(book.levels("ASK"));
    const top = book.topOfBook();
    expect(read.book.bids[0]?.price).toBe(top.bestBidPrice);
    expect(read.book.asks[0]?.price).toBe(top.bestAskPrice);
    expect(read.book.tickSize).toBe(book.tickSize());
    expect(read.book.venueBookHash).toBe(book.venueBookHash());
  });

  it("round-trips an empty and a one-sided book (absent markers)", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET, tokenId: TOKEN });
    const applied = book.applySnapshot({
      payload: { internalMarketId: MARKET, tokenId: TOKEN, bids: [], asks: [] },
      meta: meta("1"),
    });
    expect(applied.applied).toBe(true);
    const emptyRead = readBookSerialization(serializeBook(book));
    expect(emptyRead.ok).toBe(true);
    if (!emptyRead.ok) return;
    expect(emptyRead.book.bids).toEqual([]);
    expect(emptyRead.book.asks).toEqual([]);

    const change = book.applyLevelChange({
      payload: { internalMarketId: MARKET, tokenId: TOKEN, side: "ASK", price: "0.6", size: "25" },
      meta: meta("2"),
    });
    expect(change.applied).toBe(true);
    const oneSided = readBookSerialization(serializeBook(book));
    expect(oneSided.ok).toBe(true);
    if (!oneSided.ok) return;
    expect(oneSided.book.asks).toEqual([{ price: "0.6", size: "25" }]);
  });

  it("refuses an UNBASELINED book's serialization the way §7.1 demands", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET, tokenId: TOKEN });
    const read = readBookSerialization(serializeBook(book));
    expect(read).toMatchObject({ ok: false, kind: "NOT_BASELINED" });
  });
});

describe("the executable-price binding (division policy follow-up)", () => {
  function featureValue(snapshot: FeatureSnapshot, id: string): unknown {
    const entry = snapshot.features.find((feature) => feature.id === id);
    if (entry === undefined || entry.status !== "OK") throw new Error(`no OK entry for ${id}`);
    return entry.value;
  }

  it("features VWAP equals executablePrice's documented default on the same book", () => {
    const book = buildFixtureBook();
    const result = computeFeatureSnapshot(validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const buys = featureValue(result.snapshot, "polymarket.executable_buy_price") as Record<string, unknown>[];
    const sells = featureValue(result.snapshot, "polymarket.executable_sell_price") as Record<string, unknown>[];
    const quantities = ["50", "150", "1000"];
    for (const [index, shares] of quantities.entries()) {
      const buy = executablePrice(book, { side: "BUY", shares });
      const featureBuy = buys[index];
      expect(featureBuy).toBeDefined();
      if (buy.ok) {
        expect(featureBuy).toEqual({
          requestedShares: buy.requestedShares,
          outcome: "QUOTE",
          volumeWeightedAveragePrice: buy.volumeWeightedAveragePrice,
          totalCost: buy.totalCost,
          worstPrice: buy.worstPrice,
          levelsConsumed: buy.levelsConsumed,
        });
      } else {
        expect(buy.refusal.code).toBe("ORDER_BOOK_INSUFFICIENT_DEPTH");
        expect(featureBuy).toEqual({
          requestedShares: shares,
          outcome: "INSUFFICIENT_DEPTH",
          availableShares: (buy.refusal.evidence as { availableShares: string }).availableShares,
        });
      }
      const sell = executablePrice(book, { side: "SELL", shares });
      const featureSell = sells[index];
      if (sell.ok) {
        expect(featureSell).toEqual({
          requestedShares: sell.requestedShares,
          outcome: "QUOTE",
          volumeWeightedAveragePrice: sell.volumeWeightedAveragePrice,
          totalCost: sell.totalCost,
          worstPrice: sell.worstPrice,
          levelsConsumed: sell.levelsConsumed,
        });
      } else {
        expect(featureSell).toEqual({
          requestedShares: shares,
          outcome: "INSUFFICIENT_DEPTH",
          availableShares: (sell.refusal.evidence as { availableShares: string }).availableShares,
        });
      }
    }
  });
});
