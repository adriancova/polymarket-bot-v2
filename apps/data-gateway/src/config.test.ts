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

  // ROUND-1 REVIEW M2: this pair was accepted, and it FALSIFIES the WAL's
  // published data-loss bound. Nothing but the gateway tick fsyncs an idle
  // writer, so a 10 s tick with a 1 s `fsyncIntervalMs` leaves a final frame
  // unsynced for ~10 s while `dataLossBoundMs` still advertises 1 s. Round 1
  // deferred this to a follow-up; it is a configuration defect and it fails
  // at startup now.
  it("refuses a tick slower than the fsync interval (the data-loss bound must be real)", () => {
    expect(() =>
      parseGatewayConfig({
        ...BASE,
        tickIntervalMs: 10_000,
        wal: { rootPath: "/wal", fsyncIntervalMs: 1_000 },
      }),
    ).toThrow(GatewayConfigurationError);

    // Against the WAL's OWN default too, not only an explicit value: an
    // omitted `fsyncIntervalMs` is 1 s, so a 2 s tick is just as wrong.
    expect(() => parseGatewayConfig({ ...BASE, tickIntervalMs: 2_000 })).toThrow(
      GatewayConfigurationError,
    );
  });

  it("accepts a tick at or below the fsync interval", () => {
    expect(
      parseGatewayConfig({
        ...BASE,
        tickIntervalMs: 5_000,
        wal: { rootPath: "/wal", fsyncIntervalMs: 5_000 },
      }).tickIntervalMs,
    ).toBe(5_000);
    expect(
      parseGatewayConfig({
        ...BASE,
        tickIntervalMs: 250,
        wal: { rootPath: "/wal", fsyncIntervalMs: 5_000 },
      }).tickIntervalMs,
    ).toBe(250);
  });

  // Review H2: the publisher's admission bounds are configuration, with
  // documented defaults, and they are safety parameters rather than tuning
  // knobs (see `publisher.ts`).
  it("defaults the publisher admission bounds and accepts explicit ones", () => {
    const defaults = parseGatewayConfig(BASE);
    expect(defaults.publisher.maxQueueDepth).toBe(1_024);
    expect(defaults.publisher.maxQueueBytes).toBe(8 * 1024 * 1024);

    const explicit = parseGatewayConfig({
      ...BASE,
      publisher: { maxQueueDepth: 16, maxQueueBytes: 4_096 },
    });
    expect(explicit.publisher.maxQueueDepth).toBe(16);
    expect(explicit.publisher.maxQueueBytes).toBe(4_096);

    expect(() =>
      parseGatewayConfig({ ...BASE, publisher: { maxQueueDepth: 0 } }),
    ).toThrow(GatewayConfigurationError);
    expect(() =>
      parseGatewayConfig({ ...BASE, publisher: { unboundedQueue: true } }),
    ).toThrow(GatewayConfigurationError);
  });
});
