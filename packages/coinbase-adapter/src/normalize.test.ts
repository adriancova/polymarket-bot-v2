import { describe, expect, it } from "vitest";

import {
  normalizeTopOfBook,
  normalizeTrade,
  noteUnknownEventType,
  takerSideFromDocumentedMakerSide,
  type CoinbaseNormalizationContext,
} from "./normalize.js";
import type { CoinbaseMarketTrade, CoinbaseTicker } from "./wire.js";

const context: CoinbaseNormalizationContext = {
  venueMessageTime: "2023-02-09T20:19:35.39625135Z",
  venueEventType: "update",
  sequenceNum: 7,
  receivedAt: "2026-08-27T12:00:00.000Z",
  receivedMonotonicNs: "1000000000",
  connectionId: "c1",
  subscriptionGeneration: 3,
};

function trade(overrides: Partial<CoinbaseMarketTrade> = {}): CoinbaseMarketTrade {
  return {
    trade_id: "t1",
    product_id: "ETH-USD",
    price: "1260.01",
    size: "0.3",
    side: "BUY",
    time: "2019-08-14T20:42:27.265Z",
    ...overrides,
  };
}

describe("takerSideFromDocumentedMakerSide", () => {
  it("inverts the documented maker side", () => {
    // The docs say `side` "refers to the makers side". A maker SELL was lifted
    // by a buyer, and the buyer's side of the book is the BID.
    expect(takerSideFromDocumentedMakerSide("SELL")).toBe("BID");
    expect(takerSideFromDocumentedMakerSide("BUY")).toBe("ASK");
  });

  it("returns undefined rather than guessing for an unrecognized value", () => {
    for (const value of ["", "buy", "BID", "UNKNOWN", "SELL "]) {
      expect(takerSideFromDocumentedMakerSide(value), value).toBeUndefined();
    }
  });
});

describe("normalizeTrade", () => {
  it("produces a domain payload and keeps the venue detail beside it", () => {
    const outcome = normalizeTrade(trade(), context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.payload).toEqual({
      venue: "coinbase",
      symbol: "ETH-USD",
      price: "1260.01",
      size: "0.3",
      takerSide: "ASK",
      venueTradeId: "t1",
    });
    expect(outcome.value.venueDetail).toEqual({
      venueTradeTime: "2019-08-14T20:42:27.265Z",
      venueMessageTime: "2023-02-09T20:19:35.39625135Z",
      venueSide: "BUY",
      venueSideMeaning: "MAKER",
      venueEventType: "update",
      sequenceNum: 7,
      rawPrice: "1260.01",
      rawSize: "0.3",
    });
    expect(outcome.value.envelope.subscriptionGeneration).toBe(3);
    expect(outcome.value.envelope.venueTimestamp).toBe("2019-08-14T20:42:27.265Z");
    expect(outcome.value.envelope.receivedAt).toBe("2026-08-27T12:00:00.000Z");
  });

  it("canonicalizes a venue spelling and keeps the raw one", () => {
    const outcome = normalizeTrade(trade({ price: "+1260.0100", size: "1.50" }), context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.payload.price).toBe("1260.01");
    expect(outcome.value.payload.size).toBe("1.5");
    expect(outcome.value.venueDetail.rawPrice).toBe("+1260.0100");
  });

  it("refuses a value the canonicalizer rejects", () => {
    for (const price of ["1e5", "NaN", "", " 1 ", "Infinity", "0", "-1"]) {
      const outcome = normalizeTrade(trade({ price }), context);
      expect(outcome.ok, price).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("COINBASE_ECONOMIC_FIELD_INVALID");
        expect(outcome.symbol).toBe("ETH-USD");
      }
    }
  });

  it("refuses a size that is not strictly positive", () => {
    const outcome = normalizeTrade(trade({ size: "0" }), context);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("size");
    }
  });

  it("refuses a venue time that is not the documented RFC 3339 form", () => {
    const outcome = normalizeTrade(trade({ time: "2019-08-14 20:42:27" }), context);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("COINBASE_TIMESTAMP_INVALID");
    }
  });

  it("omits takerSide and notes the unknown value", () => {
    const outcome = normalizeTrade(trade({ side: "NEITHER" }), context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.payload.takerSide).toBeUndefined();
    expect(outcome.notes.map((note) => note.code)).toEqual(["COINBASE_UNKNOWN_TRADE_SIDE"]);
    expect(outcome.value.venueDetail.venueSide).toBe("NEITHER");
  });
});

function ticker(overrides: Partial<CoinbaseTicker> = {}): CoinbaseTicker {
  return { product_id: "BTC-USD", ...overrides };
}

describe("normalizeTopOfBook", () => {
  it("carries only the fields the venue supplied", () => {
    const outcome = normalizeTopOfBook(ticker({ best_bid: "1.50", best_bid_quantity: "2" }), context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.payload).toEqual({
      venue: "coinbase",
      symbol: "BTC-USD",
      bidPrice: "1.5",
      bidSize: "2",
    });
    expect(outcome.value.venueDetail.rawBestBid).toBe("1.50");
    expect(Object.hasOwn(outcome.value.venueDetail, "rawBestAsk")).toBe(false);
  });

  it("allows a zero quantity but not a zero price", () => {
    const zeroSize = normalizeTopOfBook(
      ticker({ best_bid: "1", best_bid_quantity: "0" }),
      context,
    );
    expect(zeroSize.ok).toBe(true);

    const zeroPrice = normalizeTopOfBook(ticker({ best_bid: "0" }), context);
    expect(zeroPrice.ok).toBe(false);
  });

  it("uses the message timestamp as the venue time", () => {
    const outcome = normalizeTopOfBook(ticker({ best_ask: "3" }), context);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.envelope.venueTimestamp).toBe("2023-02-09T20:19:35.39625135Z");
      expect(outcome.value.envelope.sourceChannel).toBe("ticker");
    }
  });

  it("refuses a message timestamp that is not RFC 3339", () => {
    const outcome = normalizeTopOfBook(ticker({ best_ask: "3" }), {
      ...context,
      venueMessageTime: "not a time",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("COINBASE_TIMESTAMP_INVALID");
    }
  });

  it("names the offending field when a quantity is unusable", () => {
    const outcome = normalizeTopOfBook(ticker({ best_ask_quantity: "-1" }), context);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("best_ask_quantity");
    }
  });
});

describe("noteUnknownEventType", () => {
  it("says nothing about a documented type", () => {
    expect(noteUnknownEventType("snapshot", undefined)).toBeUndefined();
    expect(noteUnknownEventType("update", undefined)).toBeUndefined();
  });

  it("notes anything else, carrying the symbol when there is one", () => {
    const note = noteUnknownEventType("resync", "BTC-USD");
    expect(note?.code).toBe("COINBASE_UNKNOWN_EVENT_TYPE");
    expect(note?.symbol).toBe("BTC-USD");
    expect(noteUnknownEventType("resync", undefined)?.symbol).toBeUndefined();
  });
});
