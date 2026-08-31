import { describe, expect, it } from "vitest";

import { decodeFrame, rawExcerpt, utf8ByteLength, MAX_FRAME_BYTES } from "./frames.js";

/** The documented `<symbol>@trade` example, verbatim. */
const DOCUMENTED_TRADE = JSON.stringify({
  e: "trade",
  E: 1672515782136,
  s: "BNBBTC",
  t: 12345,
  p: "0.001",
  q: "100",
  T: 1672515782136,
  m: true,
  M: true,
});

/** The documented `<symbol>@bookTicker` example, verbatim. */
const DOCUMENTED_BOOK_TICKER = JSON.stringify({
  u: 400900217,
  s: "BNBUSDT",
  b: "25.35190000",
  B: "31.21000000",
  a: "25.36520000",
  A: "40.66000000",
});

describe("decodeFrame — documented shapes", () => {
  it("decodes the documented trade payload", () => {
    const decoded = decodeFrame(DOCUMENTED_TRADE);
    expect(decoded.kind).toBe("TRADE");
    if (decoded.kind !== "TRADE") {
      throw new Error("unreachable");
    }
    expect(decoded.symbol).toBe("BNBBTC");
    expect(decoded.tradeId).toBe(12345);
    expect(decoded.priceRaw).toBe("0.001");
    expect(decoded.quantityRaw).toBe("100");
    expect(decoded.eventTimeEpoch).toBe(1672515782136);
    expect(decoded.tradeTimeEpoch).toBe(1672515782136);
    expect(decoded.buyerIsMaker).toBe(true);
  });

  it("preserves the venue's raw `m` verbatim, both polarities, unmapped (ADR-014)", () => {
    // The decoded frame keeps Binance's own boolean. `takerSide` is DERIVED from
    // it at the domain boundary (`./normalize.ts`), and ADR-014's §7 follow-up
    // item 4 requires the raw value to survive that derivation, so a consumer
    // never has to invert the mapping to recover what the venue said.
    for (const buyerIsMaker of [true, false]) {
      const decoded = decodeFrame(
        JSON.stringify({ ...(JSON.parse(DOCUMENTED_TRADE) as object), m: buyerIsMaker }),
      );
      if (decoded.kind !== "TRADE") {
        throw new Error("unreachable");
      }
      expect(decoded.buyerIsMaker).toBe(buyerIsMaker);
      // …and it is still a boolean, not a book side: the frame layer maps nothing.
      expect(typeof decoded.buyerIsMaker).toBe("boolean");
    }
  });

  it("does not report `M` as unknown: the venue documents it, as 'Ignore'", () => {
    // `unknownFields` reports VENUE schema drift, not this package's modelling
    // choices. Listing `M` would open a data-quality incident on every trade.
    const decoded = decodeFrame(DOCUMENTED_TRADE);
    expect(decoded.unknownFields).toEqual([]);
  });

  it("still reports a key the venue's documentation does not describe", () => {
    const decoded = decodeFrame(
      JSON.stringify({ ...(JSON.parse(DOCUMENTED_TRADE) as object), someFutureField: 1 }),
    );
    expect(decoded.unknownFields).toEqual(["someFutureField"]);
  });

  it("reconstructs the channel for an unwrapped frame and says so", () => {
    const decoded = decodeFrame(DOCUMENTED_TRADE);
    expect(decoded.streamName).toBe("bnbbtc@trade");
    expect(decoded.channelSource).toBe("RECONSTRUCTED");
  });

  it("decodes the documented bookTicker payload, which has no `e` field", () => {
    const decoded = decodeFrame(DOCUMENTED_BOOK_TICKER);
    expect(decoded.kind).toBe("BOOK_TICKER");
    if (decoded.kind !== "BOOK_TICKER") {
      throw new Error("unreachable");
    }
    expect(decoded.updateId).toBe(400900217);
    expect(decoded.symbol).toBe("BNBUSDT");
    expect(decoded.bidPriceRaw).toBe("25.35190000");
    expect(decoded.askQuantityRaw).toBe("40.66000000");
    expect(decoded.streamName).toBe("bnbusdt@bookTicker");
    expect(decoded.unknownFields).toEqual([]);
  });

  it("takes the channel from the combined-stream wrapper when it is present", () => {
    const decoded = decodeFrame(
      JSON.stringify({ stream: "bnbusdt@bookTicker", data: JSON.parse(DOCUMENTED_BOOK_TICKER) }),
    );
    expect(decoded.kind).toBe("BOOK_TICKER");
    expect(decoded.streamName).toBe("bnbusdt@bookTicker");
    expect(decoded.channelSource).toBe("WRAPPER");
  });

  it("decodes the documented serverShutdown notice, in both raw and wrapped forms", () => {
    const raw = decodeFrame(JSON.stringify({ e: "serverShutdown", E: 1770123456789 }));
    expect(raw.kind).toBe("SERVER_SHUTDOWN");

    const wrapped = decodeFrame(
      JSON.stringify({
        stream: "!serverShutdown",
        data: { e: "serverShutdown", E: 1770123456789 },
      }),
    );
    expect(wrapped.kind).toBe("SERVER_SHUTDOWN");
    expect(wrapped.streamName).toBe("!serverShutdown");
    // The documented `!serverShutdown` envelope is not a `<symbol>@<suffix>`
    // name, so nothing in the payload can confirm it: it is kept as data and
    // marked unverified rather than treated as provenance.
    expect(wrapped.channelSource).toBe("UNVERIFIED_WRAPPER");
  });

  it("decodes the documented control responses", () => {
    expect(decodeFrame(JSON.stringify({ result: null, id: 1 })).kind).toBe("CONTROL_RESPONSE");
    expect(decodeFrame(JSON.stringify({ result: ["btcusdt@aggTrade"], id: 3 })).kind).toBe(
      "CONTROL_RESPONSE",
    );
    expect(decodeFrame(JSON.stringify({ result: true, id: 2 })).kind).toBe("CONTROL_RESPONSE");
  });

  it("decodes the documented control errors", () => {
    const decoded = decodeFrame(
      JSON.stringify({ code: 2, msg: "Invalid request: too many parameters" }),
    );
    expect(decoded.kind).toBe("CONTROL_ERROR");
    if (decoded.kind !== "CONTROL_ERROR") {
      throw new Error("unreachable");
    }
    expect(decoded.venueCode).toBe(2);
    expect(decoded.message).toContain("too many parameters");
  });
});

describe("decodeFrame — tolerance and strictness in the right places", () => {
  it("accepts an added venue field instead of rejecting real traffic (ADR-002 §7)", () => {
    const extended = JSON.stringify({
      ...(JSON.parse(DOCUMENTED_BOOK_TICKER) as Record<string, unknown>),
      E: 1672515782136,
      T: 1672515782136,
    });
    const decoded = decodeFrame(extended);
    expect(decoded.kind).toBe("BOOK_TICKER");
    // …and makes the drift visible rather than invisible.
    expect(decoded.unknownFields).toEqual(["E", "T"]);
  });

  it("rejects an integer JSON could only represent approximately (BNC-U6)", () => {
    const decoded = decodeFrame('{"e":"trade","E":1,"s":"X","t":9007199254740993,"p":"1","q":"1","T":1,"m":false}');
    expect(decoded.kind).toBe("MALFORMED");
    if (decoded.kind !== "MALFORMED") {
      throw new Error("unreachable");
    }
    expect(decoded.reason).toBe("SCHEMA_MISMATCH");
  });

  it("rejects a JSON-number price rather than losing precision on it", () => {
    // Binance documents `p` and `q` as decimal STRINGS. A number would be a
    // venue change, not something to coerce (ADR-001 §7).
    const decoded = decodeFrame('{"e":"trade","E":1,"s":"X","t":1,"p":0.001,"q":"1","T":1,"m":false}');
    expect(decoded.kind).toBe("MALFORMED");
  });
});

describe("decodeFrame — nothing is dropped silently", () => {
  it("classifies a non-JSON frame instead of throwing", () => {
    const decoded = decodeFrame("PONG");
    expect(decoded.kind).toBe("MALFORMED");
    if (decoded.kind !== "MALFORMED") {
      throw new Error("unreachable");
    }
    expect(decoded.reason).toBe("NOT_JSON");
    expect(decoded.raw).toBe("PONG");
  });

  it("classifies a JSON array or scalar as malformed, not as an event", () => {
    expect(decodeFrame("[1,2,3]").kind).toBe("MALFORMED");
    expect(decodeFrame("42").kind).toBe("MALFORMED");
    expect(decodeFrame("null").kind).toBe("MALFORMED");
  });

  it("classifies an undocumented event type as UNKNOWN and preserves the raw frame", () => {
    const raw = JSON.stringify({ e: "depthUpdate", E: 1, s: "BNBBTC", U: 1, u: 2, b: [], a: [] });
    const decoded = decodeFrame(raw);
    expect(decoded.kind).toBe("UNKNOWN");
    if (decoded.kind !== "UNKNOWN") {
      throw new Error("unreachable");
    }
    expect(decoded.declaredEventType).toBe("depthUpdate");
    expect(decoded.raw).toBe(raw);
  });

  it("classifies an unrecognized untyped object as UNKNOWN", () => {
    const decoded = decodeFrame(JSON.stringify({ hello: "world" }));
    expect(decoded.kind).toBe("UNKNOWN");
  });

  it("refuses a frame above the size bound rather than parsing it", () => {
    const decoded = decodeFrame("x".repeat(MAX_FRAME_BYTES + 1));
    expect(decoded.kind).toBe("MALFORMED");
    if (decoded.kind !== "MALFORMED") {
      throw new Error("unreachable");
    }
    expect(decoded.reason).toBe("FRAME_TOO_LARGE");
  });

  it("measures the size bound in UTF-8 BYTES, not in characters (round-1 review, L2)", () => {
    // Every code point here encodes to 4 bytes, so the frame is well under the
    // bound by `String#length` and well over it on the wire. The venue
    // explicitly contemplates non-ASCII symbol names, so this is not a
    // theoretical shape.
    const raw = "\u{10FFFF}".repeat(300_000);
    expect(raw.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(utf8ByteLength(raw)).toBeGreaterThan(MAX_FRAME_BYTES);

    const decoded = decodeFrame(raw);
    expect(decoded.kind).toBe("MALFORMED");
    if (decoded.kind !== "MALFORMED") {
      throw new Error("unreachable");
    }
    expect(decoded.reason).toBe("FRAME_TOO_LARGE");
    expect(decoded.detail).toContain("UTF-8 bytes");
  });

  it("still accepts a multi-byte frame that is genuinely inside the bound", () => {
    const symbol = "ééé";
    const decoded = decodeFrame(
      JSON.stringify({
        e: "trade",
        E: 1,
        s: symbol,
        t: 1,
        p: "1",
        q: "1",
        T: 1,
        m: false,
      }),
    );
    expect(decoded.kind).toBe("TRADE");
  });
});

describe("utf8ByteLength", () => {
  it("agrees with the platform encoder on ASCII, BMP, and astral text", () => {
    const encoder = new TextEncoder();
    for (const value of ["", "abc", "é", "€", "\u{1F600}", 'aé€\u{10FFFF}"']) {
      expect(utf8ByteLength(value), JSON.stringify(value)).toBe(encoder.encode(value).length);
    }
  });

  it("counts a lone surrogate the way an encoder does — as a 3-byte replacement", () => {
    const lone = "\ud800";
    expect(utf8ByteLength(lone)).toBe(new TextEncoder().encode(lone).length);
  });
});

describe("decodeFrame — channel provenance is verified, not believed (round-1 review, M1)", () => {
  const wrap = (stream: string, data: unknown): string => JSON.stringify({ stream, data });
  const TRADE_PAYLOAD = JSON.parse(DOCUMENTED_TRADE) as Record<string, unknown>;
  const BOOK_PAYLOAD = JSON.parse(DOCUMENTED_BOOK_TICKER) as Record<string, unknown>;

  it("accepts a wrapper that agrees with the payload", () => {
    const decoded = decodeFrame(wrap("bnbbtc@trade", TRADE_PAYLOAD));
    expect(decoded.kind).toBe("TRADE");
    expect(decoded.streamName).toBe("bnbbtc@trade");
    expect(decoded.channelSource).toBe("WRAPPER");
  });

  it("refuses a wrapper naming a different symbol than the payload", () => {
    const decoded = decodeFrame(wrap("ethusdt@trade", TRADE_PAYLOAD));
    expect(decoded.kind).toBe("MALFORMED");
    if (decoded.kind !== "MALFORMED") {
      throw new Error("unreachable");
    }
    expect(decoded.reason).toBe("CHANNEL_MISMATCH");
    // Both halves of the disagreement are in the report, and the raw frame is
    // preserved: nothing here decides which half was right.
    expect(decoded.detail).toContain("ethusdt@trade");
    expect(decoded.detail).toContain("bnbbtc@trade");
    expect(decoded.raw).toBe(wrap("ethusdt@trade", TRADE_PAYLOAD));
  });

  it("refuses a wrapper naming a different stream type than the payload", () => {
    expect(decodeFrame(wrap("bnbbtc@bookTicker", TRADE_PAYLOAD)).kind).toBe("MALFORMED");
    expect(decodeFrame(wrap("bnbusdt@trade", BOOK_PAYLOAD)).kind).toBe("MALFORMED");
  });

  it("refuses an uppercase wrapper — the venue documents lowercase stream names", () => {
    expect(decodeFrame(wrap("BNBBTC@trade", TRADE_PAYLOAD)).kind).toBe("MALFORMED");
  });

  it("refuses a wrapper that is not a stream name at all", () => {
    expect(decodeFrame(wrap("totally-unknown", TRADE_PAYLOAD)).kind).toBe("MALFORMED");
  });

  it("refuses a channel outside the caller's subscription set", () => {
    const expectedStreams = new Set(["bnbbtc@trade"]);
    expect(decodeFrame(wrap("bnbbtc@trade", TRADE_PAYLOAD), { expectedStreams }).kind).toBe(
      "TRADE",
    );

    const other = decodeFrame(wrap("bnbusdt@bookTicker", BOOK_PAYLOAD), { expectedStreams });
    expect(other.kind).toBe("MALFORMED");
    if (other.kind !== "MALFORMED") {
      throw new Error("unreachable");
    }
    expect(other.reason).toBe("CHANNEL_NOT_SUBSCRIBED");
  });

  it("applies the subscription check to a reconstructed channel too", () => {
    const decoded = decodeFrame(DOCUMENTED_TRADE, {
      expectedStreams: new Set(["bnbusdt@bookTicker"]),
    });
    expect(decoded.kind).toBe("MALFORMED");
  });

  it("preserves the raw frame on every classification", () => {
    for (const raw of [
      DOCUMENTED_TRADE,
      DOCUMENTED_BOOK_TICKER,
      "not json",
      JSON.stringify({ e: "kline" }),
      JSON.stringify({ result: null, id: 1 }),
    ]) {
      expect(decodeFrame(raw).raw).toBe(raw);
    }
  });

  it("never throws, whatever it is given", () => {
    for (const raw of ["", "{", "{}", "[]", '"x"', " ", "{\"stream\":1}"]) {
      expect(() => decodeFrame(raw)).not.toThrow();
    }
  });
});

describe("rawExcerpt", () => {
  it("collapses whitespace and stays within the incident detail bound", () => {
    expect(rawExcerpt('{\n  "a": 1\n}')).toBe('{ "a": 1 }');
  });

  it("marks a truncated excerpt and points at the WAL for the verbatim frame", () => {
    const excerpt = rawExcerpt("y".repeat(5000));
    expect(excerpt).toContain("truncated");
    expect(excerpt).toContain("WAL");
  });

  it("names an empty frame rather than returning an empty string", () => {
    expect(rawExcerpt("   ")).toBe("(empty frame)");
  });
});
