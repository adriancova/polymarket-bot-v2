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

const MILLISECOND_CONTEXT = { timeUnit: "MILLISECOND" } as const;

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

  it("emits `takerSide` for every trade, with no configuration (ADR-014; BNC-U5 closed)", () => {
    // The pre-ADR-014 behavior this replaces: absent by default, present only
    // under a caller-selected convention. ADR-014 ruled the vocabulary, so the
    // mapping is the adapter's behavior and there is nothing to opt into.
    const buyerIsMaker = normalizeTrade(tradeFrame({ buyerIsMaker: true }), MILLISECOND_CONTEXT);
    const buyerIsTaker = normalizeTrade(tradeFrame({ buyerIsMaker: false }), MILLISECOND_CONTEXT);
    if (!buyerIsMaker.ok || !buyerIsTaker.ok) {
      throw new Error("unreachable");
    }

    // ADR-014 §3, the Binance row: "`m = true → ASK` (the buyer was the maker,
    // so the taker was the **seller**); `m = false → BID`".
    expect(buyerIsMaker.payload.takerSide).toBe("ASK");
    expect(buyerIsTaker.payload.takerSide).toBe("BID");
    expect("takerSide" in buyerIsMaker.payload).toBe(true);
    expect(ReferenceTradeObservedPayloadSchema.safeParse(buyerIsMaker.payload).success).toBe(true);
    expect(ReferenceTradeObservedPayloadSchema.safeParse(buyerIsTaker.payload).success).toBe(true);
  });

  it("maps only `m`: the same frame with `m` flipped is the only thing that moves the side", () => {
    // Guards against a mapping that reads something else (price direction, a
    // quote, an id parity) and happens to agree on the documented example.
    const sides = [true, false].flatMap((buyerIsMaker) =>
      [
        { tradeId: 1, priceRaw: "0.001", quantityRaw: "100" },
        { tradeId: 2, priceRaw: "999", quantityRaw: "0.00000001" },
      ].map((variant) => {
        const result = normalizeTrade(tradeFrame({ ...variant, buyerIsMaker }), MILLISECOND_CONTEXT);
        if (!result.ok) {
          throw new Error("unreachable");
        }
        return { buyerIsMaker, takerSide: result.payload.takerSide };
      }),
    );
    expect(sides.filter((entry) => entry.buyerIsMaker).map((entry) => entry.takerSide)).toEqual([
      "ASK",
      "ASK",
    ]);
    expect(sides.filter((entry) => !entry.buyerIsMaker).map((entry) => entry.takerSide)).toEqual([
      "BID",
      "BID",
    ]);
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
    const micros = normalizeTrade(tradeFrame(), { timeUnit: "MICROSECOND" });
    if (!millis.ok || !micros.ok) {
      throw new Error("unreachable");
    }
    expect(millis.venueTimestamp).not.toBe(micros.venueTimestamp);
  });
});

describe("takerSideFor (ADR-014)", () => {
  it("maps the documented `m` exactly as ADR-014 §3's Binance row states", () => {
    // "A boolean **\"is the buyer the market maker\"** (Binance `m`) |
    //  `m = true → ASK` (the buyer was the maker, so the taker was the
    //  **seller**); `m = false → BID`"
    expect(takerSideFor(true)).toBe("ASK");
    expect(takerSideFor(false)).toBe("BID");
  });

  it("is NOT the side of the book that was consumed (ADR-014 §2)", () => {
    // §2: "A **buying** taker consumes resting **asks** and is still recorded as
    // **`BID`**. A **selling** taker hits resting **bids** and is still recorded
    // as **`ASK`**." `m = true` means the taker was SELLING; the consumed-side
    // reading would have said `BID`, and that value is now a contract violation
    // (§4.3), not an alternative convention.
    expect(takerSideFor(true)).not.toBe("BID");
    expect(takerSideFor(false)).not.toBe("ASK");
  });

  it("is total: there is no configuration and no absent case", () => {
    // The removed `takerSideConvention` parameter would show up here as a second
    // formal argument, so a convention cannot be reintroduced unnoticed.
    expect(takerSideFor.length).toBe(1);
    for (const buyerIsMaker of [true, false]) {
      expect(takerSideFor(buyerIsMaker)).toMatch(/^(BID|ASK)$/u);
    }
  });

  it("produces a value the frozen payload accepts", () => {
    for (const buyerIsMaker of [true, false]) {
      const result = normalizeTrade(tradeFrame({ buyerIsMaker }), MILLISECOND_CONTEXT);
      if (!result.ok) {
        throw new Error("unreachable");
      }
      expect(result.payload.takerSide).toBe(takerSideFor(buyerIsMaker));
      expect(ReferenceTradeObservedPayloadSchema.safeParse(result.payload).success).toBe(true);
    }
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
