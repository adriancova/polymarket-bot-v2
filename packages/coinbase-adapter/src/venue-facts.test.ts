/**
 * The citation catalogue is itself under test.
 *
 * `AGENTS.md` forbids inventing venue behaviour, so the mechanism that keeps
 * this package honest — every load-bearing claim carries a URL and a date, and
 * every unsettled question is named — has to be checked like any other
 * invariant. A citation list nobody verifies decays into decoration.
 */

import { describe, expect, it } from "vitest";

import {
  buildSubscribeFrame,
  buildUnsubscribeFrame,
  COINBASE_CHANNELS,
  COINBASE_DOC_CITATIONS,
  COINBASE_EVENT_TYPES,
  COINBASE_FACTS_VERIFIED_AT,
  COINBASE_LIVE_OBSERVATIONS,
  COINBASE_MARKET_DATA_CHANNELS,
  COINBASE_PUBLIC_MARKET_DATA_ENDPOINT,
  COINBASE_TRADE_SIDES,
  COINBASE_UNVERIFIED_ITEMS,
  findCitation,
} from "./venue-facts.js";

describe("citations", () => {
  it("are all official Coinbase URLs with an ISO access date", () => {
    expect(COINBASE_DOC_CITATIONS.length).toBeGreaterThan(10);
    for (const citation of COINBASE_DOC_CITATIONS) {
      expect(citation.url, citation.id).toMatch(/^https:\/\/docs\.cdp\.coinbase\.com\//u);
      expect(citation.accessedAt, citation.id).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(citation.claim.length, citation.id).toBeGreaterThan(20);
    }
  });

  it("have unique ids, and every id resolves", () => {
    const ids = COINBASE_DOC_CITATIONS.map((citation) => citation.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(findCitation(id)?.id).toBe(id);
    }
    expect(findCitation("not-a-citation")).toBeUndefined();
  });

  it("cover every fact the implementation actually relies on", () => {
    const required = [
      "public-endpoint",
      "public-channels-unauthenticated",
      "subscribe-without-keys",
      "subscribe-within-5s",
      "json-frames",
      "envelope-base",
      "sequence-gap-meaning",
      "market-trades-shape",
      "market-trades-maker-side",
      "ticker-shape",
      "ticker-batch-no-top-of-book",
      "heartbeats",
      "idle-close",
      "subscriptions-ack",
      "rate-limits",
    ];
    for (const id of required) {
      expect(findCitation(id), `missing citation ${id}`).toBeDefined();
    }
  });

  it("carry the same verification date the snapshot constant records", () => {
    for (const citation of COINBASE_DOC_CITATIONS) {
      expect(citation.accessedAt, citation.id).toBe(COINBASE_FACTS_VERIFIED_AT);
    }
  });
});

describe("unverified items", () => {
  it("each name a question, what was checked, and the conservative behaviour", () => {
    expect(COINBASE_UNVERIFIED_ITEMS.length).toBeGreaterThan(0);
    for (const item of COINBASE_UNVERIFIED_ITEMS) {
      expect(item.id, item.id).toMatch(/^U-CB-\d+$/u);
      expect(item.question.length, item.id).toBeGreaterThan(20);
      expect(item.checked.length, item.id).toBeGreaterThan(20);
      expect(item.conservativeHandling.length, item.id).toBeGreaterThan(20);
    }
  });

  it("have unique ids", () => {
    const ids = COINBASE_UNVERIFIED_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("live observations", () => {
  it("are labelled as observations, with a method and a date, never as documentation", () => {
    for (const observation of COINBASE_LIVE_OBSERVATIONS) {
      expect(observation.id).toMatch(/^O-CB-\d+$/u);
      expect(observation.method.length).toBeGreaterThan(20);
      expect(observation.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });

  it("record that the observation used no credential", () => {
    const methods = COINBASE_LIVE_OBSERVATIONS.map((observation) => observation.method).join(" ");
    expect(methods).toContain("no credential");
  });
});

describe("the endpoint and channels", () => {
  it("point at the public, unauthenticated market-data host", () => {
    expect(COINBASE_PUBLIC_MARKET_DATA_ENDPOINT).toBe("wss://advanced-trade-ws.coinbase.com");
    expect(COINBASE_PUBLIC_MARKET_DATA_ENDPOINT).not.toContain("user");
    expect(COINBASE_PUBLIC_MARKET_DATA_ENDPOINT).not.toContain("?");
  });

  it("normalize only the two channels the work plan scopes", () => {
    expect([...COINBASE_MARKET_DATA_CHANNELS]).toEqual(["market_trades", "ticker"]);
  });

  it("keep the documented vocabularies as data, not as parser enums", () => {
    expect([...COINBASE_TRADE_SIDES]).toEqual(["BUY", "SELL"]);
    expect([...COINBASE_EVENT_TYPES]).toEqual(["snapshot", "update"]);
  });
});

describe("subscribe frames", () => {
  it("match the documented public form exactly", () => {
    expect(buildSubscribeFrame(COINBASE_CHANNELS.marketTrades, ["ETH-USD", "ETH-EUR"])).toBe(
      '{"type":"subscribe","channel":"market_trades","product_ids":["ETH-USD","ETH-EUR"]}',
    );
    expect(buildUnsubscribeFrame(COINBASE_CHANNELS.ticker, ["ETH-USD"])).toBe(
      '{"type":"unsubscribe","channel":"ticker","product_ids":["ETH-USD"]}',
    );
  });

  it("omit product_ids for heartbeats, as the documented example does", () => {
    expect(buildSubscribeFrame(COINBASE_CHANNELS.heartbeats, [])).toBe(
      '{"type":"subscribe","channel":"heartbeats"}',
    );
  });

  it("cannot carry a credential", () => {
    const frames = [
      buildSubscribeFrame(COINBASE_CHANNELS.ticker, ["BTC-USD"]),
      buildSubscribeFrame(COINBASE_CHANNELS.heartbeats, []),
      buildUnsubscribeFrame(COINBASE_CHANNELS.marketTrades, ["BTC-USD"]),
    ];
    for (const frame of frames) {
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).not.toContain("jwt");
      expect(frame.toLowerCase()).not.toContain("jwt");
    }
  });

  it("copies the product list rather than aliasing the caller's array", () => {
    const products = ["BTC-USD"];
    const frame = buildSubscribeFrame(COINBASE_CHANNELS.ticker, products);
    products.push("MUTATED");
    expect(frame).not.toContain("MUTATED");
  });
});
