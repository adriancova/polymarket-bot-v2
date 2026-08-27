import { describe, expect, it } from "vitest";

import { BinanceConfigurationError } from "./errors.js";
import {
  assertValidSymbol,
  buildCombinedStreamUrl,
  buildRawStreamUrl,
  resolveSubscriptions,
  streamNameFor,
} from "./streams.js";

describe("streamNameFor", () => {
  it("lowercases the symbol, as the venue requires in a stream name", () => {
    expect(streamNameFor({ symbol: "BTCUSDT", suffix: "trade" })).toBe("btcusdt@trade");
    expect(streamNameFor({ symbol: "btcusdt", suffix: "bookTicker" })).toBe("btcusdt@bookTicker");
  });

  it("keeps the documented mixed-case suffix spelling", () => {
    // The venue documents `<symbol>@bookTicker`, not `@bookticker`; only the
    // SYMBOL is lowercase.
    expect(streamNameFor({ symbol: "BNBUSDT", suffix: "bookTicker" })).toContain("@bookTicker");
  });
});

describe("assertValidSymbol", () => {
  it("rejects only characters that would break the URL or the stream grammar", () => {
    expect(() => assertValidSymbol("BTC USDT")).toThrow(BinanceConfigurationError);
    expect(() => assertValidSymbol("BTC/USDT")).toThrow(BinanceConfigurationError);
    expect(() => assertValidSymbol("BTC@USDT")).toThrow(BinanceConfigurationError);
    expect(() => assertValidSymbol("")).toThrow(BinanceConfigurationError);
  });

  it("does not over-narrow: the venue contemplates non-ASCII symbol names", () => {
    // "If your request contains a symbol name containing non-ASCII characters,
    // then the stream events may contain non-ASCII characters encoded in UTF-8."
    expect(() => assertValidSymbol("BTCÜSDT")).not.toThrow();
    expect(() => assertValidSymbol("1000SATSUSDT")).not.toThrow();
  });
});

describe("resolveSubscriptions", () => {
  it("refuses a duplicate stream, which would double-count every frame", () => {
    expect(() =>
      resolveSubscriptions([
        { symbol: "BTCUSDT", suffix: "trade" },
        { symbol: "btcusdt", suffix: "trade" },
      ]),
    ).toThrow(/subscribed twice/u);
  });

  it("refuses an empty subscription set", () => {
    expect(() => resolveSubscriptions([])).toThrow(BinanceConfigurationError);
  });

  it("enforces the documented 1024-stream ceiling", () => {
    const many = Array.from({ length: 1025 }, (_unused, index) => ({
      symbol: `SYM${String(index)}`,
      suffix: "trade" as const,
    }));
    expect(() => resolveSubscriptions(many)).toThrow(/at most 1024 streams/u);
  });

  it("accepts exactly the ceiling", () => {
    const many = Array.from({ length: 1024 }, (_unused, index) => ({
      symbol: `SYM${String(index)}`,
      suffix: "trade" as const,
    }));
    expect(resolveSubscriptions(many)).toHaveLength(1024);
  });
});

describe("buildCombinedStreamUrl", () => {
  it("builds the exact form the venue documents", () => {
    const built = buildCombinedStreamUrl({
      subscriptions: [
        { symbol: "BTCUSDT", suffix: "trade" },
        { symbol: "BTCUSDT", suffix: "bookTicker" },
      ],
    });
    expect(built.url).toBe(
      "wss://data-stream.binance.vision/stream?streams=btcusdt@trade/btcusdt@bookTicker",
    );
    expect(built.timeUnit).toBe("MILLISECOND");
  });

  it("does not percent-encode `@` or `/`, which the documented form shows raw", () => {
    const built = buildCombinedStreamUrl({
      subscriptions: [{ symbol: "ETHUSDT", suffix: "trade" }],
    });
    expect(built.url).not.toContain("%40");
    expect(built.url).not.toContain("%2F");
  });

  it("adds the documented timeUnit parameter only when it is not the default", () => {
    const millis = buildCombinedStreamUrl({
      subscriptions: [{ symbol: "ETHUSDT", suffix: "trade" }],
      timeUnit: "MILLISECOND",
    });
    expect(millis.url).not.toContain("timeUnit");

    const micros = buildCombinedStreamUrl({
      subscriptions: [{ symbol: "ETHUSDT", suffix: "trade" }],
      timeUnit: "MICROSECOND",
    });
    expect(micros.url).toContain("&timeUnit=MICROSECOND");
  });

  it("reports a query-free endpoint identifier, which cannot carry a credential", () => {
    const built = buildCombinedStreamUrl({
      subscriptions: [{ symbol: "ETHUSDT", suffix: "trade" }],
    });
    expect(built.endpointIdentifier).toBe("wss://data-stream.binance.vision/stream");
    expect(built.endpointIdentifier).not.toContain("?");
    expect(built.endpointIdentifier.length).toBeLessThanOrEqual(200);
  });

  it("refuses the credential-gated SBE host", () => {
    expect(() =>
      buildCombinedStreamUrl({
        endpoint: "wss://stream-sbe.binance.com",
        subscriptions: [{ symbol: "ETHUSDT", suffix: "trade" }],
      }),
    ).toThrow(/API key/u);
  });

  it("refuses an endpoint the venue does not document", () => {
    expect(() =>
      buildCombinedStreamUrl({
        endpoint: "wss://not-binance.example.test",
        subscriptions: [{ symbol: "ETHUSDT", suffix: "trade" }],
      }),
    ).toThrow(BinanceConfigurationError);
  });
});

describe("buildRawStreamUrl", () => {
  it("builds the documented `/ws/<streamName>` form", () => {
    const built = buildRawStreamUrl({ symbol: "BNBBTC", suffix: "trade" });
    expect(built.url).toBe("wss://data-stream.binance.vision/ws/bnbbtc@trade");
  });

  it("uses `?` rather than `&` for the time unit, since there is no other query", () => {
    const built = buildRawStreamUrl(
      { symbol: "BNBBTC", suffix: "trade" },
      { timeUnit: "MICROSECOND" },
    );
    expect(built.url).toBe(
      "wss://data-stream.binance.vision/ws/bnbbtc@trade?timeUnit=MICROSECOND",
    );
  });
});
