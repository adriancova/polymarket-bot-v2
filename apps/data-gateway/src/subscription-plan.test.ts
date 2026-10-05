import { describe, expect, it } from "vitest";

import { parseGatewayConfig } from "./config.js";
import { planSubscriptions } from "./subscription-plan.js";

const MARKET_A = {
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

const MARKET_B = {
  ...MARKET_A,
  internalMarketId: "01990000-0000-7000-8000-000000000002",
  conditionId: "0x" + "cd".repeat(31),
  yesTokenId: "33333",
  noTokenId: "22222", // shares NO token with A on purpose (dedup case)
};

describe("planSubscriptions", () => {
  it("plans both outcome tokens per market, deduplicated, in order", () => {
    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [MARKET_A, MARKET_B],
      polymarket: { feedId: "polymarket-market" },
    });
    const plan = planSubscriptions(config);
    expect(plan.polymarketTokenIds).toEqual(["11111", "22222", "33333"]);
  });

  it("plans trade and bookTicker per Binance symbol", () => {
    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [],
      binance: {
        feedId: "binance-reference",
        symbols: ["BTCUSDT", "ETHUSDT"],
        stalenessThresholdMs: 30_000,
      },
    });
    const plan = planSubscriptions(config);
    expect(plan.binanceSubscriptions).toEqual([
      { symbol: "BTCUSDT", suffix: "trade" },
      { symbol: "BTCUSDT", suffix: "bookTicker" },
      { symbol: "ETHUSDT", suffix: "trade" },
      { symbol: "ETHUSDT", suffix: "bookTicker" },
    ]);
  });

  it("passes Coinbase product ids through opaquely (U-CB-4: no invented cap)", () => {
    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [],
      coinbase: { feedId: "coinbase-reference", productIds: ["BTC-USD", "ETH-USD"] },
    });
    const plan = planSubscriptions(config);
    expect(plan.coinbaseProductIds).toEqual(["BTC-USD", "ETH-USD"]);
  });
});
