import { describe, expect, it } from "vitest";

import type { BookIngestMeta } from "./ingest.js";
import { OutcomeTokenBook } from "./book.js";
import { executablePrice } from "./executable-price.js";

const MARKET_ID = "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const TOKEN_ID = "123";
const EPOCH = "018f0000-0000-7000-8000-00000000000a";

const META: BookIngestMeta = {
  gatewayEpoch: EPOCH,
  ingestSeq: "1",
  subscriptionGeneration: 1,
};

function book(): OutcomeTokenBook {
  const instance = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
  const outcome = instance.applySnapshot({
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: TOKEN_ID,
      bids: [
        { price: "0.07", size: "100" },
        { price: "0.08", size: "50" },
      ],
      asks: [
        { price: "0.09", size: "30" },
        { price: "0.1", size: "200" },
      ],
    },
    meta: META,
  });
  expect(outcome.applied).toBe(true);
  return instance;
}

describe("executablePrice", () => {
  it("BUY walks asks best-first with an exact volume-weighted result", () => {
    // 30 @ 0.09 = 2.7; 20 @ 0.1 = 2; total 4.7 for 50 shares; vwap 0.094.
    const result = executablePrice(book(), { side: "BUY", shares: "50" });
    expect(result).toEqual({
      ok: true,
      side: "BUY",
      requestedShares: "50",
      totalCost: "4.7",
      volumeWeightedAveragePrice: "0.094",
      worstPrice: "0.1",
      levelsConsumed: 2,
    });
  });

  it("SELL walks bids best-first (highest price first)", () => {
    // 50 @ 0.08 = 4; 10 @ 0.07 = 0.7; total 4.7 for 60 shares.
    const result = executablePrice(book(), { side: "SELL", shares: "60" });
    expect(result).toMatchObject({
      ok: true,
      totalCost: "4.7",
      worstPrice: "0.07",
      levelsConsumed: 2,
    });
  });

  it("fills exactly one level without touching the next", () => {
    const result = executablePrice(book(), { side: "BUY", shares: "30" });
    expect(result).toMatchObject({
      ok: true,
      totalCost: "2.7",
      volumeWeightedAveragePrice: "0.09",
      worstPrice: "0.09",
      levelsConsumed: 1,
    });
  });

  it("returns a typed INSUFFICIENT_DEPTH outcome, never a partial silent answer", () => {
    const result = executablePrice(book(), { side: "BUY", shares: "231" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("ORDER_BOOK_INSUFFICIENT_DEPTH");
      expect(result.refusal.evidence).toEqual({
        side: "BUY",
        requestedShares: "231",
        availableShares: "230",
      });
    }
  });

  it("returns INSUFFICIENT_DEPTH with zero available on an empty side", () => {
    const empty = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const result = executablePrice(empty, { side: "SELL", shares: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("ORDER_BOOK_INSUFFICIENT_DEPTH");
      expect(result.refusal.evidence).toMatchObject({ availableShares: "0" });
    }
  });

  it.each(["0", "-1", "0.10", "1e3", "", "abc"])(
    "refuses a non-positive or non-canonical quantity %j",
    (shares) => {
      const result = executablePrice(book(), { side: "BUY", shares });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code).toBe("ORDER_BOOK_INVALID_QUANTITY");
      }
    },
  );

  it("uses the documented division policy for a non-terminating average, overridable per call", () => {
    const instance = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(
      instance.applySnapshot({
        payload: {
          internalMarketId: MARKET_ID,
          tokenId: TOKEN_ID,
          bids: [],
          asks: [
            { price: "0.1", size: "1" },
            { price: "0.2", size: "2" },
          ],
        },
        meta: META,
      }).applied,
    ).toBe(true);
    // total 0.5 over 3 shares = 0.1666… — non-terminating.
    const result = executablePrice(instance, {
      side: "BUY",
      shares: "3",
      division: { precision: 4 },
    });
    expect(result).toMatchObject({
      ok: true,
      totalCost: "0.5",
      volumeWeightedAveragePrice: "0.1667",
    });
  });
});
