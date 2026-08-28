import { describe, expect, it } from "vitest";

import {
  staticMarketDirectory,
  type StaticMarketDirectory,
  testMarket,
} from "../testing/index.js";
import { normalizeMarketEvents } from "./market-events.js";

const MARKET = testMarket(1);
const OTHER = testMarket(2);

function run(
  values: readonly unknown[],
  directory: StaticMarketDirectory = staticMarketDirectory({ known: [MARKET] }),
) {
  return normalizeMarketEvents(values, { directory });
}

const bookEvent = {
  event_type: "book",
  market: MARKET.conditionId,
  asset_id: MARKET.yesTokenId,
  timestamp: "1782753357257",
  hash: "0x0000000000000000000000000000000000000000000000000000000000abc123",
  bids: [
    { price: "0.07", size: "5000" },
    { price: "0.08", size: "33343.4" },
  ],
  asks: [
    { price: "0.09", size: "163939.58" },
    { price: "0.1", size: "7500.25" },
  ],
};

describe("book → BookSnapshot", () => {
  it("orders bids descending and asks ascending", () => {
    const { events, problems } = run([bookEvent]);
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toMatchObject({
      bids: [
        { price: "0.08", size: "33343.4" },
        { price: "0.07", size: "5000" },
      ],
      asks: [
        { price: "0.09", size: "163939.58" },
        { price: "0.1", size: "7500.25" },
      ],
    });
  });

  it("carries the book hash, which the venue documents as the hash of the book content", () => {
    const { events } = run([bookEvent]);
    expect(events[0]?.payload).toMatchObject({ venueBookHash: bookEvent.hash });
  });

  it("emits no TradingParametersChanged for the tick_size a snapshot restates", () => {
    // A snapshot restates the current parameter; it does not announce a change.
    // Emitting here would manufacture a change history the venue never published.
    const { events } = run([{ ...bookEvent, tick_size: "0.001", min_order_size: "5" }]);
    expect(events.map((event) => event.eventType)).toEqual(["BookSnapshot"]);
  });
});

describe("price_change → BookLevelChanged", () => {
  const priceChange = (entries: readonly Record<string, unknown>[]) => ({
    event_type: "price_change",
    market: MARKET.conditionId,
    price_changes: entries,
    timestamp: "1782753357257",
  });

  const entry = {
    asset_id: MARKET.yesTokenId,
    price: "0.08",
    size: "33343.4",
    side: "BUY",
    hash: "56621a121a47ed9333273e21c83b660cff37ae50",
    best_bid: "0.08",
    best_ask: "0.09",
  };

  it("passes the size through as the absolute level size (C-1/U-1, confirmed)", () => {
    const { events } = run([priceChange([entry])]);
    expect(events[0]?.payload).toMatchObject({
      side: "BID",
      price: "0.08",
      size: "33343.4",
    });
  });

  it("carries a zero size verbatim: the venue documents 0 as level removal", () => {
    const { events, problems } = run([priceChange([{ ...entry, size: "0" }])]);
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toMatchObject({ size: "0" });
  });

  it("performs no delta arithmetic across two changes at one price", () => {
    const { events } = run([priceChange([entry, { ...entry, size: "10" }])]);
    expect(events.map((event) => (event.payload as { size: string }).size)).toEqual([
      "33343.4",
      "10",
    ]);
  });

  it("does NOT put the order hash in venueBookHash", () => {
    // The venue documents `price_change.hash` as the "Hash of the order that
    // caused this change", not a hash of the book.
    const { events } = run([priceChange([entry])]);
    expect(events[0]?.payload).not.toHaveProperty("venueBookHash");
  });

  it("does NOT synthesize a second top-of-book event from best_bid/best_ask", () => {
    const { events } = run([priceChange([entry])]);
    expect(events.map((event) => event.eventType)).toEqual(["BookLevelChanged"]);
  });

  it("accounts for every entry of a batch, including the failing ones", () => {
    const { events, problems } = run([
      priceChange([
        entry,
        { ...entry, side: "SIDEWAYS" },
        { ...entry, asset_id: OTHER.yesTokenId },
        { ...entry, price: "1.5" },
      ]),
    ]);
    expect(events).toHaveLength(1);
    expect(problems.map((problem) => problem.code)).toEqual([
      "UNKNOWN_SIDE",
      "UNRESOLVED_MARKET",
      "PRICE_OUT_OF_RANGE",
    ]);
  });

  it("reports a batch that asserts no change at all", () => {
    const { events, problems } = run([priceChange([])]);
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("INVALID_EVENT_PAYLOAD");
  });
});

describe("best_bid_ask → BestBidAskChanged", () => {
  const bestBidAsk = {
    event_type: "best_bid_ask",
    market: MARKET.conditionId,
    asset_id: MARKET.yesTokenId,
    best_bid: "0.08",
    best_ask: "0.09",
    spread: "0.01",
    timestamp: "1782753357257",
  };

  it("carries the prices the venue publishes", () => {
    const { events } = run([bestBidAsk]);
    expect(events[0]?.payload).toEqual({
      internalMarketId: MARKET.internalMarketId,
      tokenId: MARKET.yesTokenId,
      bestBidPrice: "0.08",
      bestAskPrice: "0.09",
    });
  });

  it("omits an empty side rather than inventing a zero for it", () => {
    // "an absent best bid is not a zero best bid" (ADR-001 §8.1).
    const { events } = run([{ ...bestBidAsk, best_bid: "", best_ask: null }]);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("bestBidPrice");
    expect(payload).not.toHaveProperty("bestAskPrice");
  });

  it("never emits a size, because this event carries no depth", () => {
    const { events } = run([bestBidAsk]);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("bestBidSize");
    expect(payload).not.toHaveProperty("bestAskSize");
  });
});

describe("last_trade_price → PublicTradeObserved", () => {
  const trade = {
    event_type: "last_trade_price",
    market: MARKET.conditionId,
    asset_id: MARKET.yesTokenId,
    price: "0.08",
    size: "219.217767",
    fee_rate_bps: "0",
    side: "SELL",
    timestamp: "1782753357257",
    transaction_hash: "0x0000000000000000000000000000000000000000000000000000000000eeefff",
  };

  it("maps the taker-perspective side onto takerSide", () => {
    const { events } = run([trade]);
    expect(events[0]?.payload).toMatchObject({
      price: "0.08",
      size: "219.217767",
      takerSide: "ASK",
    });
  });

  it("does not use the transaction hash as a trade id", () => {
    // One settlement transaction can carry several trades, so treating it as a
    // trade identity would silently deduplicate distinct trades.
    const { events } = run([trade]);
    expect(events[0]?.payload).not.toHaveProperty("venueTradeId");
  });

  it("reports a trade with no size instead of publishing one without", () => {
    for (const size of ["", null, undefined]) {
      const { events, problems } = run([{ ...trade, size }]);
      expect(events).toEqual([]);
      expect(problems[0]?.code).toBe("MISSING_TRADE_SIZE");
    }
  });

  it("reports a non-positive trade size", () => {
    const { problems } = run([{ ...trade, size: "0" }]);
    expect(problems[0]?.code).toBe("NON_POSITIVE_TRADE_SIZE");
  });
});

describe("tick_size_change → TradingParametersChanged", () => {
  const tickChange = {
    event_type: "tick_size_change",
    market: MARKET.conditionId,
    asset_id: MARKET.yesTokenId,
    old_tick_size: "0.01",
    new_tick_size: "0.001",
    timestamp: "1782753357257",
  };

  it("emits exactly one event, naming only the parameter that changed", () => {
    const directory = staticMarketDirectory({ known: [MARKET] });
    const { events, problems } = run([tickChange], directory);

    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("TradingParametersChanged");
    expect(events[0]?.payload).toEqual({
      internalMarketId: MARKET.internalMarketId,
      conditionId: MARKET.conditionId,
      parametersVersion: 1,
      parameterVersionRef: `${MARKET.conditionId}:params:1`,
      changedParameters: ["tick_size"],
      tickSize: "0.001",
    });
  });

  it("emits one event per venue event, never coalescing two changes", () => {
    const directory = staticMarketDirectory({ known: [MARKET] });
    const { events } = run(
      [tickChange, { ...tickChange, old_tick_size: "0.001", new_tick_size: "0.0001" }],
      directory,
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => (event.payload as { tickSize: string }).tickSize)).toEqual([
      "0.001",
      "0.0001",
    ]);
    expect(
      events.map((event) => (event.payload as { parametersVersion: number }).parametersVersion),
    ).toEqual([1, 2]);
  });

  it("hands the catalogue both the old and the new value, exactly as sent", () => {
    const directory = staticMarketDirectory({ known: [MARKET] });
    run([tickChange], directory);
    expect(directory.parameterChanges[0]).toMatchObject({
      previousTickSize: "0.01",
      tickSize: "0.001",
      tokenId: MARKET.yesTokenId,
    });
  });

  it("canonicalizes a non-canonical tick size", () => {
    const { events } = run([{ ...tickChange, new_tick_size: "0.0010" }]);
    expect(events[0]?.payload).toMatchObject({ tickSize: "0.001" });
  });

  it("accepts an absent old_tick_size, which the SDK marks optional", () => {
    const { events, problems } = run([{ ...tickChange, old_tick_size: "" }]);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("reports rather than guesses when the catalogue assigns no version", () => {
    const directory = staticMarketDirectory({
      known: [MARKET],
      assignsParameterVersions: false,
    });
    const { events, problems } = run([tickChange], directory);
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("UNASSIGNED_PARAMETER_VERSION");
  });

  it("reports a new tick size that is not a positive decimal", () => {
    expect(run([{ ...tickChange, new_tick_size: "0" }]).problems[0]?.code).toBe("INVALID_DECIMAL");
    expect(run([{ ...tickChange, new_tick_size: "" }]).problems[0]?.code).toBe("INVALID_DECIMAL");
  });
});

describe("new_market → MarketDiscovered", () => {
  const newMarket = {
    event_type: "new_market",
    id: "123456",
    question: "Will the US confirm that aliens exist before 2027?",
    market: OTHER.conditionId,
    slug: "will-the-us-confirm-that-aliens-exist-before-2027",
    assets_ids: [OTHER.yesTokenId, OTHER.noTokenId],
    outcomes: ["Yes", "No"],
    timestamp: "1782753357257",
  };

  it("takes the market's identity and outcome tokens from the catalogue", () => {
    const directory = staticMarketDirectory({ known: [MARKET], registrable: [OTHER] });
    const { events, problems } = run([newMarket], directory);

    expect(problems).toEqual([]);
    expect(events[0]?.eventType).toBe("MarketDiscovered");
    expect(events[0]?.payload).toEqual({
      internalMarketId: OTHER.internalMarketId,
      conditionId: OTHER.conditionId,
      yesTokenId: OTHER.yesTokenId,
      noTokenId: OTHER.noTokenId,
      metadataVersion: 1,
    });
  });

  it("does not pair assets_ids with outcomes itself", () => {
    // The venue publishes two parallel arrays and documents no pairing rule.
    const directory = staticMarketDirectory({ registrable: [OTHER] });
    run([newMarket], directory);
    expect(directory.registrations[0]).toMatchObject({
      tokenIds: [OTHER.yesTokenId, OTHER.noTokenId],
      outcomes: ["Yes", "No"],
      conditionId: OTHER.conditionId,
      venueMarketId: "123456",
    });
  });

  it("reports an announcement the catalogue declined to register", () => {
    const directory = staticMarketDirectory({ known: [MARKET] });
    const { events, problems } = run([newMarket], directory);
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("UNREGISTERED_MARKET");
  });
});

describe("market_resolved → MarketResolved", () => {
  const resolved = {
    event_type: "market_resolved",
    id: "123456",
    market: MARKET.conditionId,
    assets_ids: [MARKET.yesTokenId, MARKET.noTokenId],
    winning_asset_id: MARKET.yesTokenId,
    winning_outcome: "Yes",
    timestamp: "1782753357257",
  };

  it("decides the outcome from the winning TOKEN, not from the free-text label", () => {
    const { events } = run([resolved]);
    expect(events[0]?.payload).toEqual({
      internalMarketId: MARKET.internalMarketId,
      conditionId: MARKET.conditionId,
      outcome: "YES_WIN",
      resolvedAt: "2026-06-29T17:15:57.257Z",
    });

    const noWin = run([
      { ...resolved, winning_asset_id: MARKET.noTokenId, winning_outcome: "Yes" },
    ]);
    expect(noWin.events[0]?.payload).toMatchObject({ outcome: "NO_WIN" });
  });

  it("reports a resolution that names no winner rather than guessing a 50/50", () => {
    // SPLIT_50_50 and CANCELLED cannot be expressed by this event, and the
    // 50/50 process is itself an open venue item (U-6).
    const { events, problems } = run([{ ...resolved, winning_asset_id: null }]);
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("MISSING_WINNING_TOKEN");
  });

  it("reports a winner that is neither outcome token", () => {
    const { problems } = run([{ ...resolved, winning_asset_id: OTHER.yesTokenId }]);
    expect(problems[0]?.code).toBe("UNRESOLVED_MARKET");
  });

  it("reports a resolution with no timestamp, since resolvedAt has no substitute", () => {
    const { problems } = run([{ ...resolved, timestamp: null }]);
    expect(problems[0]?.code).toBe("INVALID_TIMESTAMP");
  });
});

describe("frame-level accounting", () => {
  it("gives every element exactly one outcome", () => {
    const values = [
      bookEvent,
      { event_type: "sports_score", anything: true },
      { not: "an event" },
      { event_type: "book", market: MARKET.conditionId },
      42,
    ];
    const { events, problems } = run(values);
    expect(events.length + problems.length).toBe(values.length);
    expect(problems.map((problem) => problem.code)).toEqual([
      "UNKNOWN_EVENT_TYPE",
      "UNRECOGNIZED_FRAME",
      "INVALID_EVENT_PAYLOAD",
      "UNRECOGNIZED_FRAME",
    ]);
  });

  it("records each outcome's position within the frame", () => {
    const { events, problems } = run([{ bad: true }, bookEvent]);
    expect(problems[0]?.observedIndex).toBe(0);
    expect(events[0]?.provenance.observedIndex).toBe(1);
  });

  it("preserves the offending value on every problem, as incident evidence", () => {
    const offender = { event_type: "book", market: MARKET.conditionId };
    const { problems } = run([offender]);
    expect(problems[0]?.raw).toBe(offender);
  });

  it("exposes no sequence number anywhere on a normalized event", () => {
    // §9.4 / ADR-002 §2.3: no invented venue sequence number.
    const { events } = run([bookEvent]);
    const keys = Object.keys(events[0]?.provenance ?? {});
    for (const forbidden of ["sequence", "seq", "ingestSeq", "offset", "ordinal"]) {
      expect(keys.some((key) => key.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
    }
  });
});
