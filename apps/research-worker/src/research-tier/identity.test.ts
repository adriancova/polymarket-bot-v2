/**
 * The market-identity inventory (`STORAGE-1` round 1, J1): every Polymarket
 * frame either names its markets, names nothing by construction, or is
 * counted as unidentified — whatever the sampler keeps of it.
 */

import { describe, expect, it } from "vitest";

import type { RawFrameRecord } from "@polymarket-bot/storage-parquet";

import { MAX_DEPTH, MarketIdentityInventory, frameMarketIdentity, gammaMarketIdOf } from "./identity.js";

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

  it("names nothing for the other venues' reference feeds", () => {
    for (const source of ["binance", "coinbase"]) {
      expect(frameMarketIdentity(record(source, "wss://x", JSON.stringify({ market: "m", asset_id: "a" })))).toMatchObject({
        tokens: [],
        unidentified: false,
      });
    }
  });
});

/** An object whose innermost object, `{ asset_id }`, sits `depth` levels below the entry. */
function nestedEntry(depth: number, tokenId: string): Record<string, unknown> {
  let inner: Record<string, unknown> = { asset_id: tokenId };
  for (let level = 1; level < depth; level += 1) inner = { nested: inner };
  return { event_type: "future_event", market: "0xc", asset_id: "t", hidden: inner };
}

describe("an inventory that could not read the whole frame is unidentified (round 2, K2)", () => {
  const RTDS = "wss://ws-live-data.polymarket.com";
  const rtds = (payload: unknown): RawFrameRecord => record("rtds", RTDS, typeof payload === "string" ? payload : JSON.stringify(payload));

  it("reads names down to MAX_DEPTH, and counts a frame nesting deeper as unidentified, whatever it names above", () => {
    // The entry is level 1; `hidden` is level 2; its innermost object is level depth + 1.
    const atLimit = frameMarketIdentity(market([nestedEntry(MAX_DEPTH - 1, "deep")]));
    expect(atLimit).toMatchObject({ tokens: ["t", "deep"], unidentified: false });
    const beyond = frameMarketIdentity(market([nestedEntry(MAX_DEPTH, "deep")]));
    expect(beyond).toMatchObject({ tokens: ["t"], conditions: ["0xc"], unidentified: true });
    // The probe's shapes: an unknown token 14 levels down is named; 18 levels down, the frame is unidentified.
    expect(frameMarketIdentity(market(nestedEntry(14, "unknown-token")))).toMatchObject({ unidentified: false });
    expect(frameMarketIdentity(market(nestedEntry(14, "unknown-token"))).tokens).toContain("unknown-token");
    expect(frameMarketIdentity(market(nestedEntry(18, "unknown-token")))).toMatchObject({ unidentified: true });
    // Another endpoint's body is read the same way.
    let deep: unknown = { condition_id: "0xdeep" };
    for (let level = 0; level < MAX_DEPTH + 1; level += 1) deep = [deep];
    expect(frameMarketIdentity(record("polymarket", "https://clob.polymarket.com/book?token_id=t9", JSON.stringify(deep))).unidentified).toBe(true);
  });

  it("counts a frame with a duplicate key as unidentified: last-wins would drop the first spelling's names", () => {
    const duplicate = '[{"event_type":"book","market":"UNKNOWN-COND","asset_id":"UNKNOWN-TOK","market":"0xc","asset_id":"t"}]';
    expect(frameMarketIdentity(market(duplicate))).toMatchObject({ unidentified: true });
    // A duplicate of a key that is not an identity key hides names too.
    const hidden = '[{"market":"0xc","asset_id":"t","x":{"asset_id":"UNKNOWN"},"x":{}}]';
    expect(frameMarketIdentity(market(hidden))).toMatchObject({ unidentified: true });
    expect(
      frameMarketIdentity(record("polymarket", "https://clob.polymarket.com/book?token_id=t9", '{"market":"UNKNOWN","market":"0xc"}')),
    ).toMatchObject({ tokens: ["t9"], unidentified: true });
    // The same frames without the duplicate are identified.
    expect(frameMarketIdentity(market('[{"event_type":"book","market":"0xc","asset_id":"t"}]'))).toMatchObject({ unidentified: false });
  });

  it("counts an identity key holding something that is not a name as unidentified", () => {
    expect(frameMarketIdentity(market([{ market: "0xc", price_changes: [{ asset_id: 123456789 }] }]))).toMatchObject({ unidentified: true });
    expect(frameMarketIdentity(market([{ market: "0xc", asset_id: "" }]))).toMatchObject({ unidentified: true });
    expect(frameMarketIdentity(market([{ market: "0xc", assets_ids: ["a", 7] }]))).toMatchObject({ unidentified: true });
    expect(frameMarketIdentity(market([{ market: { id: "0xc" }, asset_id: "t" }]))).toMatchObject({ unidentified: true });
  });

  it("counts an unparsable body of another endpoint as unidentified, whatever its query names", () => {
    expect(frameMarketIdentity(record("polymarket", "https://clob.polymarket.com/book?token_id=t9", "<html>"))).toMatchObject({
      tokens: ["t9"],
      unidentified: true,
    });
    expect(frameMarketIdentity(record("polymarket", "https://clob.polymarket.com/book?token_id=t9", ""))).toMatchObject({
      tokens: ["t9"],
      unidentified: false,
    });
  });

  it("reads RTDS: a heartbeat and a TWAP-topic envelope name nothing; another topic, or a frame that does not parse, is unidentified", () => {
    expect(frameMarketIdentity(rtds("PONG"))).toStrictEqual({ tokens: [], conditions: [], gammaMarkets: [], unidentified: false });
    expect(frameMarketIdentity(rtds("PING"))).toMatchObject({ unidentified: false });
    const twap = {
      topic: "crypto_prices_twap_sixty",
      type: "update",
      timestamp: 1,
      payload: { symbol: "btc/usd", full_accuracy_value: "1", timestamp: 1, window_s: 60 },
    };
    expect(frameMarketIdentity(rtds(twap))).toStrictEqual({ tokens: [], conditions: [], gammaMarkets: [], unidentified: false });
    expect(frameMarketIdentity(rtds([twap, { ...twap, topic: "crypto_prices_twap_thirty" }]))).toMatchObject({ unidentified: false });
    // The probe's frame: another topic naming a market.
    expect(frameMarketIdentity(rtds({ topic: "activity", payload: { conditionId: "UNKNOWN", asset: "X" } }))).toMatchObject({
      conditions: ["UNKNOWN"],
      unidentified: true,
    });
    expect(frameMarketIdentity(rtds({ topic: "comments", payload: {} }))).toMatchObject({ unidentified: true });
    expect(frameMarketIdentity(rtds({ topic: 7 }))).toMatchObject({ unidentified: true });
    expect(frameMarketIdentity(rtds("{not json")).unidentified).toBe(true);
    expect(frameMarketIdentity(rtds([42])).unidentified).toBe(true);
    expect(frameMarketIdentity(rtds('{"topic":"crypto_prices_twap_sixty","topic":"activity"}')).unidentified).toBe(true);
    // An identity key on RTDS names its market, which must then be registered.
    expect(frameMarketIdentity(rtds({ topic: "crypto_prices_twap_sixty", payload: { market: "0xc" } }))).toMatchObject({
      conditions: ["0xc"],
      unidentified: false,
    });
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
