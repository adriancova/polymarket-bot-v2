import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLIC_MARKET_FEED_OPTIONS,
  MARKET_HEARTBEAT_INTERVAL_MS,
  MAXIMUM_BOOKS_PER_BATCH_REQUEST,
  POLYMARKET_CLOB_REST_BASE_URL,
  POLYMARKET_MARKET_WEBSOCKET_URL,
  resolvePublicMarketFeedOptions,
} from "./config.js";
import { PublicMarketConfigurationError } from "./errors.js";

describe("documented endpoint and cadence snapshot", () => {
  it("pins the documented public endpoints", () => {
    expect(POLYMARKET_MARKET_WEBSOCKET_URL).toBe(
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    );
    expect(POLYMARKET_CLOB_REST_BASE_URL).toBe("https://clob.polymarket.com");
  });

  it("carries no credential, key, or authentication material", () => {
    const serialized = JSON.stringify(DEFAULT_PUBLIC_MARKET_FEED_OPTIONS).toLowerCase();
    for (const forbidden of ["key", "secret", "passphrase", "signature", "token=", "auth"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("pins the documented heartbeat cadence and batch maximum", () => {
    expect(MARKET_HEARTBEAT_INTERVAL_MS).toBe(10_000);
    expect(MAXIMUM_BOOKS_PER_BATCH_REQUEST).toBe(500);
  });

  it("imposes no default asset cap, because none is documented (venue item U-3)", () => {
    expect(DEFAULT_PUBLIC_MARKET_FEED_OPTIONS).not.toHaveProperty(
      "maximumAssetsPerSubscriptionFrame",
    );
    expect(resolvePublicMarketFeedOptions().maximumAssetsPerSubscriptionFrame).toBeUndefined();
  });

  it("asks for the initial snapshot explicitly rather than relying on the server default", () => {
    expect(resolvePublicMarketFeedOptions().initialDump).toBe(true);
  });
});

describe("resolvePublicMarketFeedOptions", () => {
  it("fails at construction on an option that would misbehave much later", () => {
    expect(() => resolvePublicMarketFeedOptions({ url: "  " })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => resolvePublicMarketFeedOptions({ feedId: "1feed" })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => resolvePublicMarketFeedOptions({ feedId: "has space" })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => resolvePublicMarketFeedOptions({ heartbeatIntervalMs: 0 })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => resolvePublicMarketFeedOptions({ maximumAssetsPerSubscriptionFrame: 0 })).toThrow(
      PublicMarketConfigurationError,
    );
  });

  it("rejects a staleness window that would fire between two heartbeats", () => {
    expect(() =>
      resolvePublicMarketFeedOptions({ heartbeatIntervalMs: 10_000, pongTimeoutMs: 5_000 }),
    ).toThrow(PublicMarketConfigurationError);
  });

  it("rejects a backoff ceiling below its own base", () => {
    expect(() =>
      resolvePublicMarketFeedOptions({
        reconnectBaseDelayMs: 5_000,
        reconnectMaximumDelayMs: 1_000,
      }),
    ).toThrow(PublicMarketConfigurationError);
  });

  it("keeps a caller's overrides", () => {
    const options = resolvePublicMarketFeedOptions({
      feedId: "polymarket-market.test",
      customFeatureEnabled: true,
      maximumAssetsPerSubscriptionFrame: 50,
    });
    expect(options.feedId).toBe("polymarket-market.test");
    expect(options.customFeatureEnabled).toBe(true);
    expect(options.maximumAssetsPerSubscriptionFrame).toBe(50);
  });
});
