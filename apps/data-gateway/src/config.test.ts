import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  GAMMA_MARKETS_RATE_LIMIT_PER_10S,
  LIFECYCLE_MAX_BUDGET_SHARE_PERCENT,
  lifecycleRequestBudgetPer10s,
  lifecycleRequestsPer10s,
  MIN_LIFECYCLE_POLL_INTERVAL_MS,
  parseGatewayConfig,
} from "./config.js";
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

// ---------------------------------------------------------------------------
// UNIV-4 — the market lifecycle feed's configuration door.
// ---------------------------------------------------------------------------

const LIFECYCLE_MARKET = {
  ...MARKET,
  gammaMarketId: "900001",
  parameters: {
    ...MARKET.parameters,
    openTime: "2026-09-01T00:00:00.000Z",
    closeTime: "2026-12-31T00:00:00.000Z",
  },
};

function lifecycleMarkets(count: number): (typeof LIFECYCLE_MARKET)[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ...LIFECYCLE_MARKET,
    internalMarketId: `01990000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
    conditionId: `0x${String(index + 1).padStart(64, "0")}`,
    yesTokenId: String(100_000 + index * 2),
    noTokenId: String(100_001 + index * 2),
    gammaMarketId: String(900_000 + index),
  }));
}

describe("parseGatewayConfig — the lifecycle feed (UNIV-4)", () => {
  it("applies the documented defaults: feed id, 10 s cadence, three-failure stall threshold", () => {
    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [LIFECYCLE_MARKET],
      lifecycle: {},
    });
    expect(config.lifecycle).toEqual({
      feedId: "polymarket-lifecycle",
      pollIntervalMs: 10_000,
      consecutiveFailureThreshold: 3,
    });
    expect(config.markets[0]?.gammaMarketId).toBe("900001");
  });

  it("the lifecycle feed alone satisfies 'at least one feed must be configured'", () => {
    expect(
      parseGatewayConfig({
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: [LIFECYCLE_MARKET],
        lifecycle: { feedId: "polymarket-lifecycle" },
      }).lifecycle?.feedId,
    ).toBe("polymarket-lifecycle");
  });

  it("requires at least one configured market (§9.2: configuration, not discovery)", () => {
    expect(() =>
      parseGatewayConfig({
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: [],
        lifecycle: {},
      }),
    ).toThrow(GatewayConfigurationError);
  });

  it("refuses a market without gammaMarketId: the {id} the documented surface takes is not derived", () => {
    expect(() =>
      parseGatewayConfig({ ...BASE, markets: [MARKET], lifecycle: {} }),
    ).toThrow(/gammaMarketId/u);
    // Without the lifecycle feed the field stays optional (existing configurations are untouched).
    expect(parseGatewayConfig(BASE).markets[0]?.gammaMarketId).toBeUndefined();
  });

  it("refuses an openTime or closeTime that is not an ISO-8601 instant, only when the feed is configured", () => {
    const bad = {
      ...LIFECYCLE_MARKET,
      parameters: { ...LIFECYCLE_MARKET.parameters, closeTime: "tomorrow" },
    };
    expect(() =>
      parseGatewayConfig({ ...BASE, markets: [bad], lifecycle: {} }),
    ).toThrow(/parameters\.closeTime/u);
    expect(() =>
      parseGatewayConfig({
        ...BASE,
        markets: [{ ...bad, parameters: { ...bad.parameters, closeTime: undefined, openTime: "09/01/2026" } }],
        lifecycle: {},
      }),
    ).toThrow(/parameters\.openTime/u);
    // The same market parses without the lifecycle feed: the check belongs to the producer.
    expect(parseGatewayConfig({ ...BASE, markets: [bad] }).markets).toHaveLength(1);
  });

  it("refuses a cadence under the 1 s floor", () => {
    expect(() =>
      parseGatewayConfig({
        ...BASE,
        markets: [LIFECYCLE_MARKET],
        lifecycle: { pollIntervalMs: MIN_LIFECYCLE_POLL_INTERVAL_MS - 1 },
      }),
    ).toThrow(/pollIntervalMs must be at least 1000 ms/u);
    expect(
      parseGatewayConfig({
        ...BASE,
        markets: [LIFECYCLE_MARKET],
        lifecycle: { pollIntervalMs: MIN_LIFECYCLE_POLL_INTERVAL_MS },
      }).lifecycle?.pollIntervalMs,
    ).toBe(1_000);
  });

  // Acceptance (d): the rate-limit arithmetic, pinned. The venue's documented
  // Gamma /markets limit is 300 requests / 10 s (the general Gamma limit is
  // 4,000 / 10 s; the stricter figure is budgeted against); the feed may use
  // 5 % of it, 15 requests / 10 s. N markets × (10 000 / pollIntervalMs) ≤ 15.
  it("pins the request budget: 5 % of the venue's documented 300 / 10 s for Gamma /markets", () => {
    expect(GAMMA_MARKETS_RATE_LIMIT_PER_10S).toBe(300);
    expect(LIFECYCLE_MAX_BUDGET_SHARE_PERCENT).toBe(5);
    expect(lifecycleRequestBudgetPer10s()).toBe(15);
    expect(lifecycleRequestsPer10s(15, 10_000)).toBe(15);
    expect(lifecycleRequestsPer10s(16, 10_000)).toBe(16);
    expect(lifecycleRequestsPer10s(1, 1_000)).toBe(10);
    expect(lifecycleRequestsPer10s(2, 1_000)).toBe(20);
    expect(lifecycleRequestsPer10s(90, 60_000)).toBe(15);
  });

  it.each([
    [15, 10_000, true],
    [16, 10_000, false],
    [1, 1_000, true],
    [2, 1_000, false],
    [90, 60_000, true],
    [91, 60_000, false],
    [150, 100_000, true],
  ])(
    "%s markets at %s ms: admitted=%s (the door's arithmetic)",
    (markets, pollIntervalMs, admitted) => {
      const parse = (): unknown =>
        parseGatewayConfig({
          streamName: "market-events",
          wal: { rootPath: "/wal" },
          markets: lifecycleMarkets(markets),
          lifecycle: { pollIntervalMs },
        });
      if (admitted) {
        expect(parse).not.toThrow();
      } else {
        expect(parse).toThrow(/requests per 10 s, over its budget of 15 per 10 s/u);
      }
    },
  );

  it("the refusal states the arithmetic an operator sizes the interval from", () => {
    let thrown: unknown;
    try {
      parseGatewayConfig({
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: lifecycleMarkets(20),
        lifecycle: { pollIntervalMs: 10_000 },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayConfigurationError);
    expect((thrown as GatewayConfigurationError).message).toContain(
      "20 markets × (10000 ms / 10000 ms) = 20 requests per 10 s",
    );
    expect((thrown as GatewayConfigurationError).details).toMatchObject({
      markets: 20,
      pollIntervalMs: 10_000,
      requestsPer10s: 20,
      budgetPer10s: 15,
      venueRequestsPer10s: 300,
      budgetSharePercent: 5,
    });
  });

  it("refuses a lifecycle feed id that collides with another feed's", () => {
    expect(() =>
      parseGatewayConfig({
        ...BASE,
        markets: [LIFECYCLE_MARKET],
        lifecycle: { feedId: "binance-reference" },
      }),
    ).toThrow(/feed ids must be distinct/u);
  });

  it("is strict: no credential-shaped key can ride on the lifecycle block", () => {
    expect(() =>
      parseGatewayConfig({
        ...BASE,
        markets: [LIFECYCLE_MARKET],
        lifecycle: { apiKey: "sk-something" },
      }),
    ).toThrow(GatewayConfigurationError);
  });
});

/**
 * `THROUGHPUT-1b` item 3. H1 run 1's first attempt ran this example as
 * shipped, and it had no `polymarket` block: the gateway recorded no order
 * book at all. The example must pass the door AND subscribe to books.
 */
describe("the shipped example configuration (infra/compose/data-gateway)", () => {
  it("passes the configuration door and carries the polymarket block, so books are recorded", async () => {
    const path = new URL(
      "../../../infra/compose/data-gateway/gateway.config.example.json",
      import.meta.url,
    );
    const example: unknown = JSON.parse(await readFile(path, "utf8"));
    const config = parseGatewayConfig(example);
    expect(config.polymarket).toEqual({ feedId: "polymarket-market" });
    expect(config.markets).toHaveLength(1);
    // The other feeds the example already carried are still there.
    expect(config.lifecycle?.feedId).toBe("polymarket-lifecycle");
    expect(config.binance?.feedId).toBe("binance-reference");
    expect(config.coinbase?.feedId).toBe("coinbase-reference");
  });
});
