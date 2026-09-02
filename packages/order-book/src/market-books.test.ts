import { describe, expect, it } from "vitest";

import type { BookIngestMeta } from "./ingest.js";
import { MarketOutcomeBooks } from "./market-books.js";
import { OrderBookConfigurationError } from "./errors.js";

const MARKET_ID = "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const YES_TOKEN = "123";
const NO_TOKEN = "456";
const EPOCH = "018f0000-0000-7000-8000-00000000000a";

function meta(ingestSeq: string): BookIngestMeta {
  return { gatewayEpoch: EPOCH, ingestSeq, subscriptionGeneration: 1 };
}

function snapshotFor(tokenId: string, bids: readonly { price: string; size: string }[]) {
  return { internalMarketId: MARKET_ID, tokenId, bids, asks: [] };
}

function books(): MarketOutcomeBooks {
  return new MarketOutcomeBooks({
    internalMarketId: MARKET_ID,
    yesTokenId: YES_TOKEN,
    noTokenId: NO_TOKEN,
  });
}

describe("MarketOutcomeBooks", () => {
  it("refuses two identical outcome tokens at construction", () => {
    expect(
      () =>
        new MarketOutcomeBooks({
          internalMarketId: MARKET_ID,
          yesTokenId: YES_TOKEN,
          noTokenId: YES_TOKEN,
        }),
    ).toThrowError(OrderBookConfigurationError);
  });

  it("maintains INDEPENDENT books per outcome token — never mixed, never derived from each other", () => {
    const pair = books();
    expect(
      pair.applySnapshot({
        payload: snapshotFor(YES_TOKEN, [{ price: "0.6", size: "10" }]),
        meta: meta("1"),
      }).applied,
    ).toBe(true);
    expect(
      pair.applySnapshot({
        payload: snapshotFor(NO_TOKEN, [{ price: "0.39", size: "20" }]),
        meta: meta("2"),
      }).applied,
    ).toBe(true);

    // The YES book saw only its own snapshot; the NO book only its own. In
    // particular the NO book is NOT the YES book's complement (0.4): it is
    // exactly what its own feed asserted (0.39).
    expect(pair.yesBook.levels("BID")).toEqual([{ price: "0.6", size: "10" }]);
    expect(pair.noBook.levels("BID")).toEqual([{ price: "0.39", size: "20" }]);
    expect(pair.yesBook.updatesApplied()).toBe(1);
    expect(pair.noBook.updatesApplied()).toBe(1);

    // A level change routed to one token leaves the other book untouched.
    expect(
      pair.applyLevelChange({
        payload: {
          internalMarketId: MARKET_ID,
          tokenId: YES_TOKEN,
          side: "BID",
          price: "0.6",
          size: "0",
        },
        meta: meta("3"),
      }).applied,
    ).toBe(true);
    expect(pair.yesBook.levels("BID")).toEqual([]);
    expect(pair.noBook.levels("BID")).toEqual([{ price: "0.39", size: "20" }]);
  });

  it("refuses a payload whose token is neither outcome token", () => {
    const pair = books();
    const outcome = pair.applySnapshot({
      payload: snapshotFor("789", []),
      meta: meta("1"),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_UNKNOWN_TOKEN");
      expect(outcome.refusal.evidence).toEqual({
        tokenId: "789",
        yesTokenId: YES_TOKEN,
        noTokenId: NO_TOKEN,
      });
    }
  });

  it("refuses a payload with no routable tokenId", () => {
    const pair = books();
    const outcome = pair.applyLevelChange({ payload: { nope: true }, meta: meta("1") });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_INPUT_INVALID");
    }
  });

  it("applies a market-level tick-size change to both books", () => {
    const pair = books();
    expect(pair.applyTickSizeChange({ tickSize: "0.001" }).applied).toBe(true);
    expect(pair.yesBook.tickSize()).toBe("0.001");
    expect(pair.noBook.tickSize()).toBe("0.001");
  });

  it("resolves a book by token id", () => {
    const pair = books();
    expect(pair.bookFor(YES_TOKEN)).toBe(pair.yesBook);
    expect(pair.bookFor(NO_TOKEN)).toBe(pair.noBook);
    expect(pair.bookFor("789")).toBeUndefined();
  });
});
