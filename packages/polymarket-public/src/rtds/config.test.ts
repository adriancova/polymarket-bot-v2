import { describe, expect, it } from "vitest";

import { PublicMarketConfigurationError } from "../errors.js";
import {
  DEFAULT_RTDS_TWAP_FEED_OPTIONS,
  RTDS_HEARTBEAT_INTERVAL_MS,
  RTDS_HEARTBEAT_REQUEST,
  RTDS_TWAP_TOPIC_BY_WINDOW,
  RTDS_TWAP_VALUE_DIVISOR,
  RTDS_TWAP_VALUE_SCALE_DECIMALS,
  RTDS_TWAP_WINDOW_BY_TOPIC,
  RTDS_WEBSOCKET_URL,
  isTwapTopic,
  isTwapWindow,
  resolveRtdsTwapFeedOptions,
  rtdsTopicChannel,
} from "./config.js";

describe("documented venue constants", () => {
  it("pins the RTDS endpoint and the two topics", () => {
    expect(RTDS_WEBSOCKET_URL).toBe("wss://ws-live-data.polymarket.com");
    expect(RTDS_TWAP_TOPIC_BY_WINDOW).toEqual({
      30: "crypto_prices_twap_thirty",
      60: "crypto_prices_twap_sixty",
    });
  });

  it("keeps the window/topic tables mutually inverse", () => {
    const entries = Object.entries(RTDS_TWAP_TOPIC_BY_WINDOW) as readonly [
      string,
      keyof typeof RTDS_TWAP_WINDOW_BY_TOPIC,
    ][];
    expect(entries).toHaveLength(2);
    for (const [window, topic] of entries) {
      expect(RTDS_TWAP_WINDOW_BY_TOPIC[topic]).toBe(Number(window));
    }
  });

  it("pins the documented client heartbeat: the text PING every 5 seconds", () => {
    expect(RTDS_HEARTBEAT_REQUEST).toBe("PING");
    expect(RTDS_HEARTBEAT_INTERVAL_MS).toBe(5_000);
  });

  it("pins the E18 scale the current page documents", () => {
    expect(RTDS_TWAP_VALUE_SCALE_DECIMALS).toBe(18);
    expect(RTDS_TWAP_VALUE_DIVISOR).toBe("1000000000000000000");
    expect(BigInt(RTDS_TWAP_VALUE_DIVISOR)).toBe(10n ** 18n);
  });

  it("names a topic-specific channel so the window is explicit in provenance", () => {
    expect(rtdsTopicChannel("crypto_prices_twap_thirty")).toBe(
      "rtds:crypto_prices_twap_thirty",
    );
  });

  it("recognizes exactly the two published windows and topics", () => {
    expect(isTwapWindow(30)).toBe(true);
    expect(isTwapWindow(60)).toBe(true);
    expect(isTwapWindow(45)).toBe(false);
    expect(isTwapTopic("crypto_prices_twap_sixty")).toBe(true);
    expect(isTwapTopic("crypto_prices")).toBe(false);
    // A prototype key is not a topic.
    expect(isTwapTopic("toString")).toBe(false);
  });
});

describe("defaults", () => {
  it("subscribes to both windows with no symbol filter", () => {
    expect(DEFAULT_RTDS_TWAP_FEED_OPTIONS.subscriptions).toEqual([
      { windowSeconds: 30 },
      { windowSeconds: 60 },
    ]);
  });

  it("does not close a quiet socket, because no cadence is documented", () => {
    // RTDS-U1: "lookback windows, not publication cadences", and "never infer
    // the window from update frequency". Quiet is not evidence of death here.
    expect(DEFAULT_RTDS_TWAP_FEED_OPTIONS.reconnectWhenStale).toBe(false);
  });

  it("resolves to itself when nothing is overridden", () => {
    expect(resolveRtdsTwapFeedOptions()).toEqual(DEFAULT_RTDS_TWAP_FEED_OPTIONS);
  });
});

describe("configuration is validated loudly, at construction", () => {
  it("rejects an empty endpoint and a non-code feed id", () => {
    expect(() => resolveRtdsTwapFeedOptions({ url: "  " })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => resolveRtdsTwapFeedOptions({ feedId: "has space" })).toThrow(
      PublicMarketConfigurationError,
    );
  });

  it("rejects non-positive intervals and an inverted backoff range", () => {
    expect(() => resolveRtdsTwapFeedOptions({ heartbeatIntervalMs: 0 })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => resolveRtdsTwapFeedOptions({ updateStalenessMs: -1 })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() =>
      resolveRtdsTwapFeedOptions({ reconnectBaseDelayMs: 500, reconnectMaximumDelayMs: 100 }),
    ).toThrow(PublicMarketConfigurationError);
  });

  it("rejects an empty subscription set", () => {
    // RTDS documents no dynamic subscription change (RTDS-U3), so a feed that
    // starts with nothing can never start receiving anything.
    expect(() => resolveRtdsTwapFeedOptions({ subscriptions: [] })).toThrow(
      PublicMarketConfigurationError,
    );
  });

  it("rejects a window the feed does not publish", () => {
    expect(() =>
      // @ts-expect-error -- 45 is not one of the two published windows.
      resolveRtdsTwapFeedOptions({ subscriptions: [{ windowSeconds: 45 }] }),
    ).toThrow(PublicMarketConfigurationError);
  });

  it("rejects two entries for one window", () => {
    expect(() =>
      resolveRtdsTwapFeedOptions({
        subscriptions: [
          { windowSeconds: 30, symbols: ["btc/usd"] },
          { windowSeconds: 30, symbols: ["eth/usd"] },
        ],
      }),
    ).toThrow(PublicMarketConfigurationError);
  });

  it("rejects a symbol that is not the documented lowercase slash-delimited form", () => {
    // A malformed filter subscribes to nothing, which is the worst failure mode
    // available to a market-data feed, so it fails at construction instead.
    for (const symbol of ["BTC/USD", "btc-usd", "btc / usd", "btcusd", ""]) {
      expect(() =>
        resolveRtdsTwapFeedOptions({ subscriptions: [{ windowSeconds: 30, symbols: [symbol] }] }),
      ).toThrow(PublicMarketConfigurationError);
    }
    expect(() =>
      resolveRtdsTwapFeedOptions({ subscriptions: [{ windowSeconds: 30, symbols: ["btc/usd"] }] }),
    ).not.toThrow();
  });

  it("rejects non-positive bounds on the two client-side memories", () => {
    expect(() => resolveRtdsTwapFeedOptions({ duplicateWindowPerSeries: 0 })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => resolveRtdsTwapFeedOptions({ maxTrackedSeries: 0 })).toThrow(
      PublicMarketConfigurationError,
    );
  });
});
