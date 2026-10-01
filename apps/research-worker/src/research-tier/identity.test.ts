/**
 * The market-identity inventory (`STORAGE-1` round 1, J1): every Polymarket
 * frame either names its markets, names nothing by construction, or is
 * counted as unidentified — whatever the sampler keeps of it.
 */

import { describe, expect, it } from "vitest";

import type { RawFrameRecord } from "@polymarket-bot/storage-parquet";

import { MarketIdentityInventory, frameMarketIdentity, gammaMarketIdOf } from "./identity.js";

function record(source: string, endpoint: string, payloadUtf8: string): RawFrameRecord {
  return {
    gatewayEpoch: "e",
    ingestSeq: "1",
    source,
    endpoint,
    connectionId: "c",
    subscriptionGeneration: 0,
    receivedAt: "2026-01-01T00:00:00.000Z",
    receivedMonotonicNs: "1",
    payloadUtf8,
    payloadSha256: "0".repeat(64),
  } as RawFrameRecord;
}

const MARKET = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const market = (payload: unknown): RawFrameRecord =>
  record("polymarket", MARKET, typeof payload === "string" ? payload : JSON.stringify(payload));

describe("frameMarketIdentity", () => {
  it("reads tokens and conditions at any depth, from every event type", () => {
    expect(frameMarketIdentity(market([{ event_type: "best_bid_ask", market: "0xc", asset_id: "t" }]))).toStrictEqual({
      tokens: ["t"],
      conditions: ["0xc"],
      gammaMarkets: [],
      unidentified: false,
    });
    expect(
      frameMarketIdentity(market([{ event_type: "price_change", market: "0xc", price_changes: [{ asset_id: "t1" }, { asset_id: "t2" }] }])),
    ).toMatchObject({ tokens: ["t1", "t2"], conditions: ["0xc"], unidentified: false });
    expect(frameMarketIdentity(market({ event_type: "new_market", market: "0xc", assets_ids: ["a", "b"] }))).toMatchObject({
      tokens: ["a", "b"],
      unidentified: false,
    });
    expect(frameMarketIdentity(market([{ event_type: "market_resolved", market: "0xc", winning_asset_id: "w" }]))).toMatchObject({
      tokens: ["w"],
    });
  });

  it("names nothing for a PONG and an empty array", () => {
    expect(frameMarketIdentity(market("PONG"))).toMatchObject({ tokens: [], conditions: [], unidentified: false });
    expect(frameMarketIdentity(market([]))).toMatchObject({ unidentified: false });
  });

  it("counts as unidentified what could carry a market but names none", () => {
    expect(frameMarketIdentity(market("{not json")).unidentified).toBe(true);
    expect(frameMarketIdentity(market([{ event_type: "book" }])).unidentified).toBe(true);
    // One entry names a market and another does not: both are recorded.
    expect(frameMarketIdentity(market([{ market: "0xc" }, { event_type: "x" }]))).toMatchObject({ conditions: ["0xc"], unidentified: true });
    expect(frameMarketIdentity(market([42])).unidentified).toBe(true);
    expect(frameMarketIdentity(record("polymarket", "https://clob.polymarket.com/book", "{}")).unidentified).toBe(true);
    expect(frameMarketIdentity(record("somewhere-new", "wss://x", "{}")).unidentified).toBe(true);
    expect(frameMarketIdentity(record("polymarket", "https://gamma-api.polymarket.com/markets/../x", "{}")).unidentified).toBe(true);
  });

  it("identifies another Polymarket endpoint by its query, and a Gamma poll by its endpoint only", () => {
    expect(frameMarketIdentity(record("polymarket", "https://clob.polymarket.com/book?token_id=t9", "[]"))).toMatchObject({
      tokens: ["t9"],
      unidentified: false,
    });
    const gamma = record("polymarket", "https://gamma-api.polymarket.com/markets/5121169", JSON.stringify({ conditionId: "0xother" }));
    expect(gammaMarketIdOf(gamma)).toBe("5121169");
    expect(frameMarketIdentity(gamma)).toStrictEqual({ tokens: [], conditions: [], gammaMarkets: ["5121169"], unidentified: false });
  });

  it("names nothing for the reference feeds", () => {
    for (const source of ["binance", "coinbase", "rtds"]) {
      expect(frameMarketIdentity(record(source, "wss://x", JSON.stringify({ market: "m", asset_id: "a" })))).toMatchObject({
        tokens: [],
        unidentified: false,
      });
    }
  });
});

describe("MarketIdentityInventory", () => {
  it("accumulates a segment's names sorted and unique, and counts unidentified frames", () => {
    const inventory = new MarketIdentityInventory();
    inventory.add(market([{ market: "0xb", asset_id: "t2" }]));
    inventory.add(market([{ market: "0xa", asset_id: "t1" }, { market: "0xb", asset_id: "t2" }]));
    inventory.add(market("garbage"));
    inventory.add(market("garbage"));
    expect(inventory.result()).toStrictEqual({
      polymarketTokenIds: ["t1", "t2"],
      conditionIds: ["0xa", "0xb"],
      gammaMarketIds: [],
      unidentifiedFrames: 2,
    });
  });
});
