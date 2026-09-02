import { describe, expect, it } from "vitest";

import type { BookIngestMeta } from "./ingest.js";
import { OutcomeTokenBook } from "./book.js";
import { serializeBook } from "./serialize.js";

const MARKET_ID = "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const TOKEN_ID = "123";
const EPOCH = "018f0000-0000-7000-8000-00000000000a";

const META: BookIngestMeta = {
  gatewayEpoch: EPOCH,
  ingestSeq: "7",
  subscriptionGeneration: 2,
};

describe("serializeBook", () => {
  it("serializes an empty book deterministically with absent markers", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(serializeBook(book)).toBe(
      [
        "polymarket-bot/order-book/v1",
        `market ${MARKET_ID}`,
        `token ${TOKEN_ID}`,
        "epoch -",
        "generation -",
        "lastIngestSeq -",
        "venueBookHash -",
        "tickSize -",
        "bestBid - -",
        "bestAsk - -",
        "spread -",
        "depth bids 0 0 asks 0 0",
        "bids 0",
        "asks 0",
      ].join("\n"),
    );
  });

  it("one state has exactly one serialization: bids descending, asks ascending, canonical decimals", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(
      book.applySnapshot({
        payload: {
          internalMarketId: MARKET_ID,
          tokenId: TOKEN_ID,
          bids: [
            { price: "0.07", size: "5000" },
            { price: "0.08", size: "33343.4" },
          ],
          asks: [
            { price: "0.1", size: "7500.25" },
            { price: "0.09", size: "163939.58" },
          ],
          venueBookHash: "abc123",
        },
        meta: META,
      }).applied,
    ).toBe(true);
    expect(book.applyTickSizeChange({ tickSize: "0.01" }).applied).toBe(true);

    const expected = [
      "polymarket-bot/order-book/v1",
      `market ${MARKET_ID}`,
      `token ${TOKEN_ID}`,
      `epoch ${EPOCH}`,
      "generation 2",
      "lastIngestSeq 7",
      "venueBookHash abc123",
      "tickSize 0.01",
      "bestBid 0.08 33343.4",
      "bestAsk 0.09 163939.58",
      "spread 0.01",
      "depth bids 2 38343.4 asks 2 171439.83",
      "bids 2",
      "0.08 33343.4",
      "0.07 5000",
      "asks 2",
      "0.09 163939.58",
      "0.1 7500.25",
    ].join("\n");
    expect(serializeBook(book)).toBe(expected);
    // Serialization is a pure read: calling it twice yields identical bytes.
    expect(serializeBook(book)).toBe(expected);
  });
});
