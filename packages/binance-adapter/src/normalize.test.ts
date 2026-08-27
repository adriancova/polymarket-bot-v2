import {
  ReferenceTopOfBookChangedPayloadSchema,
  ReferenceTradeObservedPayloadSchema,
} from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import type { DecodedBookTickerFrame, DecodedTradeFrame } from "./frames.js";
import { normalizeBookTicker, normalizeTrade, takerSideFor } from "./normalize.js";

function tradeFrame(overrides: Partial<DecodedTradeFrame> = {}): DecodedTradeFrame {
  return {
    kind: "TRADE",
    raw: "{}",
    streamName: "bnbbtc@trade",
    channelSource: "WRAPPER",
    unknownFields: [],
    symbol: "BNBBTC",
    tradeId: 12345,
    priceRaw: "0.001",
    quantityRaw: "100",
    eventTimeEpoch: 1_672_515_782_136,
    tradeTimeEpoch: 1_672_515_782_136,
    buyerIsMaker: true,
    ...overrides,
  };
}

function bookTickerFrame(
  overrides: Partial<DecodedBookTickerFrame> = {},
): DecodedBookTickerFrame {
  return {
    kind: "BOOK_TICKER",
    raw: "{}",
    streamName: "bnbusdt@bookTicker",
    channelSource: "WRAPPER",
    unknownFields: [],
    symbol: "BNBUSDT",
    updateId: 400_900_217,
    bidPriceRaw: "25.35190000",
    bidQuantityRaw: "31.21000000",
    askPriceRaw: "25.36520000",
    askQuantityRaw: "40.66000000",
    ...overrides,
  };
}

const MILLISECOND_CONTEXT = { timeUnit: "MILLISECOND", takerSideConvention: "OMIT" } as const;

describe("normalizeTrade", () => {
  it("canonicalizes the venue's decimal spelling (ADR-001 §3)", () => {
    const result = normalizeTrade(tradeFrame({ priceRaw: "0.00100000", quantityRaw: "100.00" }), MILLISECOND_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.payload.price).toBe("0.001");
    expect(result.payload.size).toBe("100");
    // …and the canonical form is what the frozen schema accepts.
    expect(ReferenceTradeObservedPayloadSchema.safeParse(result.payload).success).toBe(true);
  });

  it("restates the envelope source as the payload venue (ADR-002 §5)", () => {
    const result = normalizeTrade(tradeFrame(), MILLISECOND_CONTEXT);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.payload.venue).toBe("binance");
  });

  it("carries the venue's own symbol spelling, opaque", () => {
    const result = normalizeTrade(tradeFrame({ symbol: "BNBBTC" }), MILLISECOND_CONTEXT);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.payload.symbol).toBe("BNBBTC");
  });

  it("takes the venue timestamp from `T` (trade time), not from `E`", () => {
    const result = normalizeTrade(
      tradeFrame({ tradeTimeEpoch: 1_672_515_782_136, eventTimeEpoch: 1_672_515_782_999 }),
      MILLISECOND_CONTEXT,
    );
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.venueTimestamp).toBe("2022-12-31T19:43:02.136Z");
  });

  it("records the trade id as an opaque string", () => {
    const result = normalizeTrade(tradeFrame({ tradeId: 12345 }), MILLISECOND_CONTEXT);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.payload.venueTradeId).toBe("12345");
  });

  it("omits `takerSide` by default, because the contract's convention is unstated (BNC-U5)", () => {
    const result = normalizeTrade(tradeFrame(), MILLISECOND_CONTEXT);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect("takerSide" in result.payload).toBe(false);
  });

  it("rejects a non-positive price instead of clamping it (ADR-002 §7)", () => {
    const result = normalizeTrade(tradeFrame({ priceRaw: "0" }), MILLISECOND_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.failures.map((failure) => failure.field)).toContain("p");
  });

  it("rejects a non-numeric venue decimal with a typed failure", () => {
    const result = normalizeTrade(tradeFrame({ quantityRaw: "1e5" }), MILLISECOND_CONTEXT);
    expect(result.ok).toBe(false);
  });

  it("reports every failing field at once, not just the first", () => {
    const result = normalizeTrade(
      tradeFrame({ priceRaw: "-1", quantityRaw: "abc" }),
      MILLISECOND_CONTEXT,
    );
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.failures).toHaveLength(2);
  });

  it("reads the same epoch differently under the connection's declared unit", () => {
    const millis = normalizeTrade(tradeFrame(), MILLISECOND_CONTEXT);
    const micros = normalizeTrade(tradeFrame(), {
      timeUnit: "MICROSECOND",
      takerSideConvention: "OMIT",
    });
    if (!millis.ok || !micros.ok) {
      throw new Error("unreachable");
    }
    expect(millis.venueTimestamp).not.toBe(micros.venueTimestamp);
  });
});

describe("takerSideFor", () => {
  it("omits by default", () => {
    expect(takerSideFor(true, "OMIT")).toBeUndefined();
    expect(takerSideFor(false, "OMIT")).toBeUndefined();
  });

  it("maps `m` to opposite values under the two named conventions, which is the point", () => {
    expect(takerSideFor(true, "BOOK_SIDE_CONSUMED")).toBe("BID");
    expect(takerSideFor(true, "TAKER_ORDER_DIRECTION")).toBe("ASK");
    expect(takerSideFor(false, "BOOK_SIDE_CONSUMED")).toBe("ASK");
    expect(takerSideFor(false, "TAKER_ORDER_DIRECTION")).toBe("BID");
  });

  it("produces a value the frozen payload accepts when a convention is chosen", () => {
    const result = normalizeTrade(tradeFrame(), {
      timeUnit: "MILLISECOND",
      takerSideConvention: "BOOK_SIDE_CONSUMED",
    });
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.payload.takerSide).toBe("BID");
    expect(ReferenceTradeObservedPayloadSchema.safeParse(result.payload).success).toBe(true);
  });
});

describe("normalizeBookTicker", () => {
  it("canonicalizes both sides and produces no venue timestamp", () => {
    const result = normalizeBookTicker(bookTickerFrame());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.payload.bidPrice).toBe("25.3519");
    expect(result.payload.bidSize).toBe("31.21");
    expect(result.payload.askPrice).toBe("25.3652");
    expect(result.payload.askSize).toBe("40.66");
    // `bookTicker` carries no timestamp; the receipt time is never substituted.
    expect(result.venueTimestamp).toBeUndefined();
    expect(ReferenceTopOfBookChangedPayloadSchema.safeParse(result.payload).success).toBe(true);
  });

  it("accepts a zero quantity, which the contract types as non-negative", () => {
    const result = normalizeBookTicker(bookTickerFrame({ bidQuantityRaw: "0.00000000" }));
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.payload.bidSize).toBe("0");
  });

  it("emits the representable side and records the omitted one (BNC-U4)", () => {
    const result = normalizeBookTicker(
      bookTickerFrame({ bidPriceRaw: "0.00000000", bidQuantityRaw: "0.00000000" }),
    );
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect("bidPrice" in result.payload).toBe(false);
    expect("bidSize" in result.payload).toBe(false);
    expect(result.payload.askPrice).toBe("25.3652");
    expect(result.omittedSides.map((failure) => failure.field)).toEqual(["b/B"]);
  });

  it("rejects the frame when neither side can cross the boundary", () => {
    const result = normalizeBookTicker(
      bookTickerFrame({
        bidPriceRaw: "0",
        bidQuantityRaw: "0",
        askPriceRaw: "0",
        askQuantityRaw: "0",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.failures).toHaveLength(2);
  });

  it("never turns a zero best bid into an absent one without saying so", () => {
    const result = normalizeBookTicker(bookTickerFrame({ bidPriceRaw: "0" }));
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.omittedSides[0]?.rawValue).toContain("0");
  });
});
