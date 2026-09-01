import { describe, expect, it } from "vitest";

import { parseGatewayConfig } from "./config.js";
import { GatewayConfigurationError } from "./errors.js";

const MARKET = {
  internalMarketId: "01990000-0000-7000-8000-000000000001",
  conditionId: "0x" + "ab".repeat(31),
  yesTokenId: "11111",
  noTokenId: "22222",
  parameters: {
    tickSize: "0.01",
    minimumOrderSize: "5",
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
  },
  observedAt: "2026-08-30T12:00:00.000Z",
};

const BASE = {
  streamName: "market-events",
  wal: { rootPath: "/wal" },
  markets: [MARKET],
  binance: {
    feedId: "binance-reference",
    symbols: ["BTCUSDT"],
    stalenessThresholdMs: 30_000,
  },
};

describe("parseGatewayConfig", () => {
  it("accepts a minimal valid configuration and applies defaults", () => {
    const config = parseGatewayConfig(BASE);
    expect(config.streamName).toBe("market-events");
    expect(config.tickIntervalMs).toBe(1_000);
    expect(config.binance?.unauthorizedEventEscalationThreshold).toBe(3);
  });

  // §0.2 / ADR-010: the gateway has no credential surface. The schema is
  // strict at every level, so a key resembling one cannot be represented.
  it("refuses any unknown key, so no credential-shaped field is representable", () => {
    expect(() => parseGatewayConfig({ ...BASE, apiKey: "sk-something" })).toThrow(
      GatewayConfigurationError,
    );
    expect(() =>
      parseGatewayConfig({
        ...BASE,
        binance: { ...BASE.binance, apiSecret: "shh" },
      }),
    ).toThrow(GatewayConfigurationError);
    expect(() =>
      parseGatewayConfig({ ...BASE, wal: { rootPath: "/wal", signerKey: "0xdead" } }),
    ).toThrow(GatewayConfigurationError);
  });

  // Obligation 7 (WP-060 follow-up 2): durable consumer state is keyed by the
  // stream name; a per-boot name would orphan every checkpoint on restart.
  it("refuses a UUID-shaped stream name, which could not be stable across restarts", () => {
    expect(() =>
      parseGatewayConfig({ ...BASE, streamName: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000" }),
    ).toThrow(GatewayConfigurationError);
  });

  it("requires at least one configured feed", () => {
    expect(() =>
      parseGatewayConfig({ streamName: "market-events", wal: { rootPath: "/wal" }, markets: [] }),
    ).toThrow(GatewayConfigurationError);
  });

  it("requires configured markets when the Polymarket feed is enabled (§9.2)", () => {
    expect(() =>
      parseGatewayConfig({
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: [],
        polymarket: { feedId: "polymarket-market" },
      }),
    ).toThrow(GatewayConfigurationError);
  });

  it("refuses duplicate feed ids", () => {
    expect(() =>
      parseGatewayConfig({
        ...BASE,
        coinbase: {
          feedId: "binance-reference",
          productIds: ["BTC-USD"],
        },
      }),
    ).toThrow(GatewayConfigurationError);
  });

  it("requires the Binance staleness threshold (no invented venue cadence)", () => {
    expect(() =>
      parseGatewayConfig({
        ...BASE,
        binance: { feedId: "binance-reference", symbols: ["BTCUSDT"] },
      }),
    ).toThrow(GatewayConfigurationError);
  });

  it("requires at least one planned RTDS symbol when RTDS is configured", () => {
    expect(() =>
      parseGatewayConfig({
        ...BASE,
        rtds: {
          feedId: "polymarket-rtds-twap",
          subscriptions: [{ windowSeconds: 60 }],
          plannedSymbols: [],
        },
      }),
    ).toThrow(GatewayConfigurationError);
  });
});
