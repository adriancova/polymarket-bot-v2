/**
 * `THROUGHPUT-1a` — `MarketState`'s memoized book serialization and book views
 * answer what a fresh computation answers after every applied update, for both
 * outcomes, while each update changes one side of one book: the serialization
 * equals `serializeBook` of the book right now, and the view equals the view
 * built from `book.levels()` and `book.lastUpdate()` right now. A REFUSED update
 * changes nothing (the memo is not disturbed), and a view is deep-frozen.
 */

import { serializeBook } from "@polymarket-bot/order-book";
import { describe, expect, it } from "vitest";

import type { MarketConfig } from "./config.js";
import { MarketState } from "./market-state.js";

const MARKET = "018f4a7e-1111-7abc-8def-0123456789ab";
const YES = "111";
const NO = "222";
const EPOCH = "018f4a7e-5555-7abc-8def-0123456789ab";

const config = {
  marketId: MARKET,
  conditionId: "0xcondition",
  yesTokenId: YES,
  noTokenId: NO,
  tickSize: "0.01",
  minimumOrderSize: "5",
  makerFeeRate: "0",
  takerFeeRate: "0",
  openTime: "2026-03-04T12:00:00.000Z",
  closeTime: "2026-03-04T12:15:00.000Z",
  parametersVersion: 1,
  settlementReadiness: { modelDependentActivationAllowed: false },
  seriesKey: "s",
  underlyingKey: "BTC",
  resolutionWindowKey: "w",
} as MarketConfig;

function meta(seq: number) {
  return {
    gatewayEpoch: EPOCH,
    ingestSeq: String(seq),
    subscriptionGeneration: 1,
    receivedAt: `2026-03-04T12:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  };
}

function freshView(market: MarketState, outcome: "YES" | "NO", fallback: string): unknown {
  const book = market.bookFor(outcome);
  return {
    bids: book.levels("BID").map((level) => ({ price: level.price, shares: level.size })),
    asks: book.levels("ASK").map((level) => ({ price: level.price, shares: level.size })),
    asOf: book.lastUpdate()?.receivedAt ?? fallback,
  };
}

function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every((member) => deepFrozen(member));
}

describe("MarketState book memos (THROUGHPUT-1a)", () => {
  it("serialization and views equal a fresh computation after every update", () => {
    const market = new MarketState({ config, tradeWindowMs: 60_000, maximumTrades: 8 });
    const fallback = "2026-03-04T12:00:00.000Z";
    // Before any update: the fallback instant is the view's asOf, and it is keyed.
    expect(JSON.parse(JSON.stringify(market.bookView("YES", fallback)))).toEqual(freshView(market, "YES", fallback));
    expect(market.bookView("YES", "2026-03-04T12:00:01.000Z").asOf).toBe("2026-03-04T12:00:01.000Z");

    let seq = 1;
    for (const [token, bids, asks] of [
      [YES, [{ price: "0.4", size: "10" }, { price: "0.39", size: "3" }], [{ price: "0.41", size: "7" }]],
      [NO, [{ price: "0.58", size: "2" }], [{ price: "0.6", size: "9" }, { price: "0.61", size: "1" }]],
    ] as const) {
      const applied = market.books.applySnapshot({
        payload: { internalMarketId: MARKET, tokenId: token, bids, asks },
        meta: meta(seq),
      });
      expect(applied.applied).toBe(true);
      seq += 1;
    }
    const changes: { token: string; side: "BID" | "ASK"; price: string; size: string }[] = [
      { token: YES, side: "BID", price: "0.38", size: "5" },
      { token: NO, side: "ASK", price: "0.6", size: "0" },
      { token: YES, side: "ASK", price: "0.41", size: "8" },
      { token: YES, side: "ASK", price: "0.99", size: "0" },
      { token: NO, side: "BID", price: "0.59", size: "4" },
      { token: YES, side: "BID", price: "0.4", size: "0" },
    ];
    for (const change of changes) {
      const before = { yes: market.serializedBook("YES"), no: market.serializedBook("NO") };
      const applied = market.books.applyLevelChange({
        payload: { internalMarketId: MARKET, tokenId: change.token, side: change.side, price: change.price, size: change.size },
        meta: meta(seq),
      });
      expect(applied.applied).toBe(true);
      seq += 1;
      for (const outcome of ["YES", "NO"] as const) {
        expect(market.serializedBook(outcome), `${outcome} after ${JSON.stringify(change)}`).toBe(
          serializeBook(market.bookFor(outcome)),
        );
        const view = market.bookView(outcome, fallback);
        expect(deepFrozen(view)).toBe(true);
        expect(JSON.parse(JSON.stringify(view))).toEqual(freshView(market, outcome, fallback));
      }
      // The untouched outcome's serialization is the very same string.
      const untouched = change.token === YES ? "NO" : "YES";
      expect(market.serializedBook(untouched)).toBe(untouched === "YES" ? before.yes : before.no);
    }

    // A REFUSED update (an older ingest sequence) changes nothing.
    const yesBefore = market.serializedBook("YES");
    const refused = market.books.applyLevelChange({
      payload: { internalMarketId: MARKET, tokenId: YES, side: "BID", price: "0.3", size: "1" },
      meta: meta(1),
    });
    expect(refused.applied).toBe(false);
    expect(market.serializedBook("YES")).toBe(yesBefore);
    expect(market.serializedBook("YES")).toBe(serializeBook(market.bookFor("YES")));
  });
});
