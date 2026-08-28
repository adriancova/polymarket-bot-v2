/**
 * Acceptance criterion 1: **all sanitized official fixtures parse.**
 *
 * Every example in every `test/fixtures/venue/market-ws/*.json` file is driven
 * through the real entry points — the wire parser and then the normalizer —
 * and must produce a domain event, not a problem. The suite additionally
 * asserts that the fixture catalogue still covers all seven modelled event
 * types, so "all fixtures parse" cannot become true by the fixtures shrinking.
 */

import {
  normalizeMarketEvents,
  parseMarketEvent,
} from "@polymarket-bot/polymarket-public";
import {
  staticMarketDirectory,
  type StaticMarketDirectory,
  type TestMarketDefinition,
} from "@polymarket-bot/polymarket-public/testing";
import { describe, expect, it } from "vitest";

import {
  loadAllMarketWsExamples,
  loadMarketWsFixture,
  MARKET_WS_FIXTURE_FILES,
} from "./fixtures.js";

/** The identifiers the frozen fixtures actually use. */
const FIXTURE_MARKET: TestMarketDefinition = {
  internalMarketId: "0199f0a0-0000-7000-8000-000000000001",
  conditionId: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
  yesTokenId:
    "107505882767731489358349912513945399560393482969656700824895970500493757150417",
  noTokenId:
    "7305630249804085635496399869905769372294302716159034447326228509068694952392",
};

function directory(options: { readonly registrable?: boolean } = {}): StaticMarketDirectory {
  return staticMarketDirectory({
    known: [FIXTURE_MARKET],
    ...(options.registrable === false ? {} : { registrable: [FIXTURE_MARKET] }),
  });
}

const examples = loadAllMarketWsExamples();

describe("every sanitized official market-WebSocket fixture", () => {
  it("is loaded, and there is something to check", () => {
    expect(examples.length).toBeGreaterThanOrEqual(8);
  });

  it.each(examples.map((example) => [`${example.file}/${example.name}`, example] as const))(
    "%s parses at the wire layer",
    (_name, example) => {
      const parsed = parseMarketEvent(example.payload);
      expect(parsed.status, JSON.stringify(parsed)).toBe("parsed");
    },
  );

  it.each(examples.map((example) => [`${example.file}/${example.name}`, example] as const))(
    "%s normalizes into a domain event with no problem",
    (_name, example) => {
      const { events, problems } = normalizeMarketEvents([example.payload], {
        directory: directory(),
      });
      expect(problems, JSON.stringify(problems)).toEqual([]);
      expect(events).toHaveLength(1);
    },
  );

  it("covers all seven modelled event types, so the criterion cannot go vacuous", () => {
    const covered = new Set(
      examples.map((example) => (example.payload as { event_type: string }).event_type),
    );
    expect([...covered].sort()).toEqual([
      "best_bid_ask",
      "book",
      "last_trade_price",
      "market_resolved",
      "new_market",
      "price_change",
      "tick_size_change",
    ]);
  });

  it("still has every fixture file WP-000 froze", () => {
    for (const file of MARKET_WS_FIXTURE_FILES) {
      const fixture = loadMarketWsFixture(file);
      expect(fixture.sanitized).toBe(true);
      expect(fixture.source).toContain("polymarket.com");
      expect(fixture.examples.length).toBeGreaterThan(0);
    }
  });
});

describe("the fixtures normalize into the expected domain events", () => {
  function normalizeExample(file: (typeof MARKET_WS_FIXTURE_FILES)[number], name: string) {
    const example = loadMarketWsFixture(file).examples.find((entry) => entry.name === name);
    expect(example, `fixture ${file}/${name} is missing`).toBeDefined();
    return normalizeMarketEvents([example?.payload], { directory: directory() });
  }

  it("book-snapshot → BookSnapshot, reordered for the domain contract", () => {
    const { events } = normalizeExample("book-snapshot", "book-snapshot");
    expect(events[0]?.eventType).toBe("BookSnapshot");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      tokenId: FIXTURE_MARKET.yesTokenId,
      bids: [
        { price: "0.08", size: "33343.4" },
        { price: "0.07", size: "5000" },
      ],
      asks: [
        { price: "0.09", size: "163939.58" },
        { price: "0.1", size: "7500.25" },
      ],
      venueBookHash:
        "0x0000000000000000000000000000000000000000000000000000000000abc123",
    });
    expect(events[0]?.provenance.venueTimestamp).toBe("2026-06-29T17:15:57.257Z");
  });

  it("price-change/level-updated → BookLevelChanged with the absolute level size", () => {
    const { events } = normalizeExample("price-change", "level-updated");
    expect(events[0]?.eventType).toBe("BookLevelChanged");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      tokenId: FIXTURE_MARKET.yesTokenId,
      side: "BID",
      price: "0.08",
      size: "33343.4",
    });
  });

  it("price-change/level-removed → size '0', carried through unchanged", () => {
    // The fixture's own name still carries the `UNVERIFIED` marker WP-000 gave
    // it. The semantics were confirmed against the current official reference
    // on 2026-08-27 — `size` is the "New aggregate size (0 means level
    // removed)" — and this adapter carries the value through with no delta
    // arithmetic either way. Renaming the frozen fixture is not this package's
    // to do; see `docs/handoffs/WP-070.md`.
    const { events, problems } = normalizeExample(
      "price-change",
      "level-removed-absolute-zero-UNVERIFIED",
    );
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toMatchObject({ price: "0.08", size: "0", side: "BID" });
  });

  it("tick-size-change → exactly one TradingParametersChanged naming only tick_size", () => {
    const { events } = normalizeExample("tick-size-change", "tick-size-change");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("TradingParametersChanged");
    expect(events[0]?.payload).toMatchObject({
      changedParameters: ["tick_size"],
      tickSize: "0.001",
    });
  });

  it("last-trade-price → PublicTradeObserved with the taker side", () => {
    const { events } = normalizeExample("last-trade-price", "last-trade-price");
    expect(events[0]?.eventType).toBe("PublicTradeObserved");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      tokenId: FIXTURE_MARKET.yesTokenId,
      price: "0.08",
      size: "219.217767",
      takerSide: "ASK",
    });
  });

  it("best-bid-ask → BestBidAskChanged with prices and no invented sizes", () => {
    const { events } = normalizeExample("best-bid-ask", "best-bid-ask");
    expect(events[0]?.eventType).toBe("BestBidAskChanged");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      tokenId: FIXTURE_MARKET.yesTokenId,
      bestBidPrice: "0.08",
      bestAskPrice: "0.09",
    });
  });

  it("lifecycle/new-market → MarketDiscovered from the catalogue's registration", () => {
    const { events } = normalizeExample("lifecycle", "new-market");
    expect(events[0]?.eventType).toBe("MarketDiscovered");
    expect(events[0]?.payload).toMatchObject({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      conditionId: FIXTURE_MARKET.conditionId,
      yesTokenId: FIXTURE_MARKET.yesTokenId,
      noTokenId: FIXTURE_MARKET.noTokenId,
    });
  });

  it("lifecycle/market-resolved → MarketResolved decided by the winning token", () => {
    const { events } = normalizeExample("lifecycle", "market-resolved");
    expect(events[0]?.eventType).toBe("MarketResolved");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      conditionId: FIXTURE_MARKET.conditionId,
      outcome: "YES_WIN",
      resolvedAt: "2026-06-29T17:15:57.257Z",
    });
  });
});

describe("the whole fixture catalogue as one batched frame", () => {
  it("accounts for every event, in order, with nothing dropped", () => {
    // The venue may batch several events into one text frame; the SDK's own
    // market socket branches on `Array.isArray(message)`.
    const payloads = examples.map((example) => example.payload);
    const { events, problems } = normalizeMarketEvents(payloads, { directory: directory() });
    expect(problems).toEqual([]);
    expect(events).toHaveLength(payloads.length);
    expect(events.map((event) => event.provenance.observedIndex)).toEqual(
      payloads.map((_payload, index) => index),
    );
    // Only the batching element type carries an entry index — a `price_change`
    // is a batch even when it batches one entry — and every other element
    // carries none. The batching case is the next describe block.
    for (const [index, event] of events.entries()) {
      const isBatched =
        (examples[index]?.payload as { event_type?: string } | undefined)?.event_type ===
        "price_change";
      expect(event.provenance.entryIndex, `${String(index)}`).toBe(isBatched ? 0 : undefined);
    }
  });
});

describe("the accounting unit is the venue's, not the frame element (L1)", () => {
  const BATCHED_PRICE_CHANGE = {
    event_type: "price_change",
    market: FIXTURE_MARKET.conditionId,
    timestamp: "1782753357257",
    price_changes: [
      { asset_id: FIXTURE_MARKET.yesTokenId, price: "0.08", size: "1", side: "BUY" },
      { asset_id: FIXTURE_MARKET.yesTokenId, price: "0.09", size: "0", side: "SELL" },
      // A side the venue does not document: one problem, not a lost element.
      { asset_id: FIXTURE_MARKET.yesTokenId, price: "0.1", size: "2", side: "MIDDLE" },
    ],
  };

  it("one element carrying N entries produces exactly N outcomes", () => {
    // Round-1 finding L1: the claim used to be "exactly one outcome per frame
    // element", which this case never satisfied — three outcomes came out of
    // one element and nothing said so.
    const { events, problems } = normalizeMarketEvents([BATCHED_PRICE_CHANGE], {
      directory: directory(),
    });
    expect(events).toHaveLength(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("UNKNOWN_SIDE");
  });

  it("(observedIndex, entryIndex) totally orders the outcomes of one frame", () => {
    const { events, problems } = normalizeMarketEvents(
      [loadMarketWsFixture("book-snapshot").examples[0]?.payload, BATCHED_PRICE_CHANGE],
      { directory: directory() },
    );
    const ordered = [
      ...events.map((event) => ({
        observedIndex: event.provenance.observedIndex,
        entryIndex: event.provenance.entryIndex,
      })),
      ...problems.map((problem) => ({
        observedIndex: problem.observedIndex,
        entryIndex: problem.entryIndex,
      })),
    ].sort(
      (left, right) =>
        left.observedIndex - right.observedIndex ||
        (left.entryIndex ?? 0) - (right.entryIndex ?? 0),
    );

    expect(ordered).toEqual([
      // The single-fact element: no entry index.
      { observedIndex: 0, entryIndex: undefined },
      { observedIndex: 1, entryIndex: 0 },
      { observedIndex: 1, entryIndex: 1 },
      { observedIndex: 1, entryIndex: 2 },
    ]);
    // No two outcomes of the frame share a position.
    const positions = ordered.map(
      (entry) => `${String(entry.observedIndex)}:${String(entry.entryIndex ?? 0)}`,
    );
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("an element that asserts nothing is still reported exactly once", () => {
    const { events, problems } = normalizeMarketEvents(
      [
        {
          event_type: "price_change",
          market: FIXTURE_MARKET.conditionId,
          timestamp: "1782753357257",
          price_changes: [],
        },
      ],
      { directory: directory() },
    );
    expect(events).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ code: "INVALID_EVENT_PAYLOAD", observedIndex: 0 });
    expect(problems[0]).not.toHaveProperty("entryIndex");
  });
});
