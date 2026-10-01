/**
 * The research-tier downsampler (`STORAGE-1`; ADR-029 Decision 5).
 *
 * Acceptance lines pinned here:
 *
 * - "Every research-tier sample carries its release frame's gatewayEpoch,
 *   ingestSeq and receipt instant (ADR-029 Decision 5)."
 * - "A span sample (a 1 s bar, a periodic or full book) holds only frames
 *   dispatched before its release frame; a frame dispatched at or after the
 *   release frame belongs to a later span, whatever its instant. A test pins
 *   that F1 (ingestSeq 1, 10,000 ms) releases the [9,000, 10,000) bar and F2
 *   (ingestSeq 2, 9,999 ms) lands in the [10,000, 11,000) bar (ADR-029
 *   Decision 5.1)."
 */

import { describe, expect, it } from "vitest";

import type { RawFrameRecord, ResearchRow } from "@polymarket-bot/storage-parquet";
import { sha256Hex } from "@polymarket-bot/storage-parquet";

import type { Interpretation, Observation } from "./interpret.js";
import { FrameInterpreter } from "./interpret.js";
import { ResearchSampler, compareCanonical, epochMsOf } from "./sampler.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";
const MARKET_ENDPOINT = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

function record(input: {
  readonly ingestSeq: string;
  readonly atMs: number;
  readonly source?: string;
  readonly endpoint?: string;
  readonly payload?: string;
  readonly connectionId?: string;
}): RawFrameRecord {
  const payloadUtf8 = input.payload ?? "{}";
  return {
    gatewayEpoch: EPOCH,
    ingestSeq: input.ingestSeq,
    source: input.source ?? "binance",
    endpoint: input.endpoint ?? "wss://data-stream.binance.vision/stream",
    connectionId: input.connectionId ?? "conn-1",
    subscriptionGeneration: 0,
    receivedAt: new Date(input.atMs).toISOString(),
    receivedMonotonicNs: "1",
    payloadUtf8,
    payloadSha256: sha256Hex(payloadUtf8),
  };
}

function trade(price: string, size: string, tradeId: string): Interpretation {
  return {
    category: "binance-trade",
    interpreted: true,
    observations: [{ kind: "ref-trade", entryIndex: 0, source: "binance", instrument: "BTCUSDT", tradeId, price, size }],
    problems: [],
    snapshotTradesExcluded: 0,
  };
}

const NOTHING: Interpretation = {
  category: "binance-book-ticker",
  interpreted: false,
  observations: [],
  problems: [],
  snapshotTradesExcluded: 0,
};

function rowsOf(sampler: ResearchSampler, table: string): readonly ResearchRow[] {
  return sampler.rows().get(table as never) ?? [];
}

describe("span membership follows dispatch order (ADR-029 Decision 5.1)", () => {
  it("F1 (ingestSeq 1, 10,000 ms) releases [9,000, 10,000); F2 (ingestSeq 2, 9,999 ms) lands in [10,000, 11,000)", () => {
    const sampler = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    // F0 opens the [9,000, 10,000) span with one trade.
    sampler.consume({ record: record({ ingestSeq: "0", atMs: 9_500 }), segmentId: "s0", interpretation: trade("100", "1", "t0") });
    // F1: instant 10,000 is the boundary. It releases the [9,000, 10,000) bar
    // BEFORE its own trade applies, and belongs to [10,000, 11,000).
    sampler.consume({ record: record({ ingestSeq: "1", atMs: 10_000 }), segmentId: "s0", interpretation: trade("101", "2", "t1") });
    // F2 arrives later with an EARLIER instant, 9,999: it belongs to the span
    // open now, [10,000, 11,000), not to the bar F1 already released.
    sampler.consume({ record: record({ ingestSeq: "2", atMs: 9_999 }), segmentId: "s0", interpretation: trade("99", "4", "t2") });
    // F3 closes [10,000, 11,000).
    sampler.consume({ record: record({ ingestSeq: "3", atMs: 11_000 }), segmentId: "s0", interpretation: NOTHING });

    const bars = rowsOf(sampler, "ref_trade_bars");
    expect(bars).toHaveLength(2);
    const [first, second] = bars;
    expect(first).toMatchObject({
      spanStartMs: 9_000,
      spanEndMs: 10_000,
      releaseIngestSeq: "1",
      availableAt: new Date(10_000).toISOString(),
      open: "100",
      close: "100",
      volume: "1",
      tradeCount: 1,
    });
    expect(second).toMatchObject({
      spanStartMs: 10_000,
      spanEndMs: 11_000,
      releaseIngestSeq: "3",
      open: "101",
      high: "101",
      low: "99",
      close: "99",
      volume: "6",
      tradeCount: 2,
    });
  });

  it("a frame after a gap releases the open span once, and empty spans release nothing", () => {
    const sampler = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    sampler.consume({ record: record({ ingestSeq: "1", atMs: 1_200 }), segmentId: "s0", interpretation: trade("1", "1", "a") });
    sampler.consume({ record: record({ ingestSeq: "2", atMs: 7_400 }), segmentId: "s0", interpretation: trade("2", "1", "b") });
    sampler.consume({ record: record({ ingestSeq: "3", atMs: 8_000 }), segmentId: "s0", interpretation: NOTHING });
    const bars = rowsOf(sampler, "ref_trade_bars");
    expect(bars.map((bar) => [bar["spanStartMs"], bar["spanEndMs"], bar["releaseIngestSeq"]])).toStrictEqual([
      [1_000, 2_000, "2"],
      [7_000, 8_000, "3"],
    ]);
  });

  it("a span with no release frame in the epoch is never released", () => {
    const sampler = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    sampler.consume({ record: record({ ingestSeq: "1", atMs: 1_200 }), segmentId: "s0", interpretation: trade("1", "1", "a") });
    expect(rowsOf(sampler, "ref_trade_bars")).toHaveLength(0);
    // ...and it travels in the state, released by the next dataset's frame.
    const resumed = new ResearchSampler({ gatewayEpoch: EPOCH, state: sampler.exportState() });
    resumed.consume({ record: record({ ingestSeq: "2", atMs: 2_000 }), segmentId: "s1", interpretation: NOTHING });
    expect(rowsOf(resumed, "ref_trade_bars")).toMatchObject([{ spanStartMs: 1_000, releaseIngestSeq: "2", tradeCount: 1 }]);
  });
});

describe("every sample carries its release frame (ADR-029 Decision 5.2)", () => {
  function book(tokenId: string, bids: [string, string][], asks: [string, string][]): Observation {
    return { kind: "pm-book", entryIndex: 0, conditionId: "0xc", tokenId, bids, asks };
  }
  function polymarket(observations: Observation[]): Interpretation {
    return { category: "polymarket-market", interpreted: true, observations, problems: [], snapshotTradesExcluded: 0 };
  }

  it("carries gatewayEpoch, releaseIngestSeq and availableAt from the release frame, and a dense consumption order", () => {
    const sampler = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    const pm = { source: "polymarket", endpoint: MARKET_ENDPOINT };
    sampler.consume({
      record: record({ ingestSeq: "10", atMs: 60_100, ...pm }),
      segmentId: "s0",
      interpretation: polymarket([book("tok", [["0.4", "10"]], [["0.6", "5"]])]),
    });
    sampler.consume({ record: record({ ingestSeq: "11", atMs: 60_500 }), segmentId: "s0", interpretation: trade("5", "1", "x") });
    sampler.consume({
      record: record({ ingestSeq: "12", atMs: 120_000, ...pm }),
      segmentId: "s1",
      interpretation: polymarket([
        { kind: "pm-trade", entryIndex: 0, conditionId: "0xc", tokenId: "tok", price: "0.5", size: "1", side: "BUY", feeRateBps: null, venueTimestamp: "1", transactionHash: null },
      ]),
    });
    const all = [...sampler.rows().entries()].flatMap(([table, rows]) => rows.map((row) => ({ table, row })));
    all.sort((left, right) => Number(left.row["sampleOrdinal"]) - Number(right.row["sampleOrdinal"]));
    expect(all.map((entry) => entry.row["sampleOrdinal"])).toStrictEqual(all.map((_, index) => index));
    // Samples released at frame 12, in the fixed tie order: span samples by
    // boundary — the 1 s span [60,000, 61,000) closes at 61,000, before the
    // 60 s span [60,000, 120,000) at 120,000 — and by kind at one boundary,
    // then the frame's own on-change samples.
    const atTwelve = all.filter((entry) => entry.row["releaseIngestSeq"] === "12").map((entry) => entry.table);
    expect(atTwelve).toStrictEqual(["pm_top_of_book", "pm_depth", "ref_trade_bars", "pm_full_book", "pm_trades"]);
    for (const entry of all) {
      const release = entry.row["releaseIngestSeq"] === "10" ? 60_100 : entry.row["releaseIngestSeq"] === "11" ? 60_500 : 120_000;
      expect(entry.row["gatewayEpoch"]).toBe(EPOCH);
      expect(entry.row["availableAt"]).toBe(new Date(release).toISOString());
    }
    const top = all.find((entry) => entry.table === "pm_top_of_book")?.row;
    expect(top).toMatchObject({ bestBidPrice: "0.4", bestBidSize: "10", bestAskPrice: "0.6", bestAskSize: "5", releaseSegmentId: "s1" });
  });

  it("applies price_change sizes as absolute, removes zero levels, and ignores deltas before a snapshot", () => {
    const sampler = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    const pm = { source: "polymarket", endpoint: MARKET_ENDPOINT };
    const level = (price: string, size: string, side: "BID" | "ASK"): Observation => ({
      kind: "pm-level",
      entryIndex: 0,
      conditionId: "0xc",
      tokenId: "tok",
      side,
      price,
      size,
    });
    // A delta before any snapshot is not applied: there is no book to apply it to.
    sampler.consume({ record: record({ ingestSeq: "1", atMs: 100, ...pm }), segmentId: "s0", interpretation: polymarket([level("0.5", "3", "BID")]) });
    sampler.consume({ record: record({ ingestSeq: "2", atMs: 1_100, ...pm }), segmentId: "s0", interpretation: polymarket([]) });
    expect(rowsOf(sampler, "pm_top_of_book")).toHaveLength(0);
    sampler.consume({
      record: record({ ingestSeq: "3", atMs: 1_200, ...pm }),
      segmentId: "s0",
      interpretation: polymarket([book("tok", [["0.40", "10"]], [["0.6", "5"]]), level("0.45", "7", "BID"), level("0.6", "0", "ASK")]),
    });
    sampler.consume({ record: record({ ingestSeq: "4", atMs: 2_000, ...pm }), segmentId: "s0", interpretation: polymarket([]) });
    expect(rowsOf(sampler, "pm_top_of_book")[0]).toMatchObject({ bestBidPrice: "0.45", bestBidSize: "7", bestAskPrice: null });
  });

  it("a reconnect of the market channel invalidates every book until its next snapshot", () => {
    const sampler = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    const pm = { source: "polymarket", endpoint: MARKET_ENDPOINT };
    sampler.consume({ record: record({ ingestSeq: "1", atMs: 100, ...pm }), segmentId: "s0", interpretation: polymarket([book("tok", [["0.4", "1"]], [])]) });
    sampler.consume({
      record: record({ ingestSeq: "2", atMs: 1_100, ...pm, connectionId: "conn-2" }),
      segmentId: "s0",
      interpretation: polymarket([]),
    });
    // The release at frame 2 still saw the old connection's book (frame 1).
    expect(rowsOf(sampler, "pm_top_of_book")).toHaveLength(1);
    sampler.consume({ record: record({ ingestSeq: "3", atMs: 2_100, ...pm, connectionId: "conn-2" }), segmentId: "s0", interpretation: polymarket([]) });
    expect(rowsOf(sampler, "pm_top_of_book")).toHaveLength(1);
    expect(rowsOf(sampler, "feed_events").map((row) => row["eventKind"])).toContain("connection-changed");
  });

  it("skips a frame whose ingestSeq does not advance (a re-recorded copy), first wins", () => {
    const sampler = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    sampler.consume({ record: record({ ingestSeq: "5", atMs: 100 }), segmentId: "s0", interpretation: trade("1", "1", "a") });
    sampler.consume({ record: record({ ingestSeq: "5", atMs: 100 }), segmentId: "s0", interpretation: trade("1", "1", "b") });
    expect(sampler.counts.framesSkippedNotAdvancing).toBe(1);
  });

  it("resuming from an exported state yields the same samples as one uninterrupted pass", () => {
    const frames = [
      { ingestSeq: "1", atMs: 500, price: "10" },
      { ingestSeq: "2", atMs: 1_400, price: "11" },
      { ingestSeq: "3", atMs: 2_100, price: "12" },
      { ingestSeq: "4", atMs: 2_900, price: "13" },
      { ingestSeq: "5", atMs: 4_000, price: "14" },
    ];
    const whole = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    for (const frame of frames) {
      whole.consume({ record: record(frame), segmentId: "s", interpretation: trade(frame.price, "1", frame.ingestSeq) });
    }
    const first = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    for (const frame of frames.slice(0, 3)) {
      first.consume({ record: record(frame), segmentId: "s", interpretation: trade(frame.price, "1", frame.ingestSeq) });
    }
    const second = new ResearchSampler({ gatewayEpoch: EPOCH, state: JSON.parse(JSON.stringify(first.exportState())) });
    for (const frame of frames.slice(3)) {
      second.consume({ record: record(frame), segmentId: "s", interpretation: trade(frame.price, "1", frame.ingestSeq) });
    }
    const strip = (rows: readonly ResearchRow[]) =>
      rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "sampleOrdinal")));
    expect([...strip(rowsOf(first, "ref_trade_bars")), ...strip(rowsOf(second, "ref_trade_bars"))]).toStrictEqual(
      strip(rowsOf(whole, "ref_trade_bars")),
    );
  });

  it("refuses a frame from another epoch, and a state from another epoch", () => {
    const sampler = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    expect(() =>
      sampler.consume({
        record: { ...record({ ingestSeq: "1", atMs: 1 }), gatewayEpoch: "other" },
        segmentId: "s",
        interpretation: NOTHING,
      }),
    ).toThrow(/another gateway epoch/u);
    expect(() => new ResearchSampler({ gatewayEpoch: "other", state: sampler.exportState() })).toThrow(/cross gateway epochs/u);
  });
});

describe("the venue doors and the exact helpers", () => {
  it("reads the Polymarket market channel through the WP-070 door", () => {
    const interpreter = new FrameInterpreter();
    const payload = JSON.stringify([
      { event_type: "book", market: "0xc", asset_id: "tok", bids: [{ price: "0.40", size: "10.0" }], asks: [], timestamp: "1" },
      { event_type: "price_change", market: "0xc", price_changes: [{ asset_id: "tok", price: "0.41", size: "0", side: "BUY" }], timestamp: "2" },
      { event_type: "last_trade_price", market: "0xc", asset_id: "tok", price: "0.41", size: "5", side: "SELL", timestamp: "3" },
    ]);
    const result = interpreter.interpret(record({ ingestSeq: "1", atMs: 1, source: "polymarket", endpoint: MARKET_ENDPOINT, payload }));
    expect(result.problems).toStrictEqual([]);
    expect(result.observations.map((observation) => observation.kind)).toStrictEqual(["pm-book", "pm-level", "pm-trade"]);
    expect(result.observations[0]).toMatchObject({ bids: [["0.4", "10"]] });
    const pong = interpreter.interpret(record({ ingestSeq: "2", atMs: 1, source: "polymarket", endpoint: MARKET_ENDPOINT, payload: "PONG" }));
    expect(pong).toMatchObject({ category: "polymarket-pong", interpreted: false });
  });

  it("reads Binance trades and leaves book tickers out of the research tier", () => {
    const interpreter = new FrameInterpreter();
    const tradePayload = JSON.stringify({
      stream: "btcusdt@trade",
      data: { e: "trade", E: 1, s: "BTCUSDT", t: 7, p: "100.10", q: "0.50", T: 1, m: true, M: true },
    });
    expect(interpreter.interpret(record({ ingestSeq: "1", atMs: 1, payload: tradePayload })).observations).toMatchObject([
      { kind: "ref-trade", instrument: "BTCUSDT", tradeId: "7", price: "100.1", size: "0.5" },
    ]);
    const ticker = JSON.stringify({ stream: "btcusdt@bookTicker", data: { u: 1, s: "BTCUSDT", b: "1", B: "1", a: "2", A: "1" } });
    expect(interpreter.interpret(record({ ingestSeq: "2", atMs: 1, payload: ticker })).category).toBe("binance-book-ticker");
  });

  it("excludes Coinbase snapshot trades from bars and counts them", () => {
    const interpreter = new FrameInterpreter();
    const payload = JSON.stringify({
      channel: "market_trades",
      timestamp: "2026-01-01T00:00:00Z",
      sequence_num: 1,
      events: [
        { type: "snapshot", trades: [{ trade_id: "1", product_id: "BTC-USD", price: "1", size: "1", side: "BUY", time: "t" }] },
        { type: "update", trades: [{ trade_id: "2", product_id: "BTC-USD", price: "2", size: "3", side: "SELL", time: "t" }] },
      ],
    });
    const result = interpreter.interpret(record({ ingestSeq: "1", atMs: 1, source: "coinbase", endpoint: "wss://x", payload }));
    expect(result.snapshotTradesExcluded).toBe(1);
    expect(result.observations).toMatchObject([{ kind: "ref-trade", source: "coinbase", tradeId: "2", price: "2", size: "3" }]);
  });

  it("compares canonical decimals exactly, and reads receipt instants to the millisecond", () => {
    expect(compareCanonical("0.45", "0.405")).toBe(1);
    expect(compareCanonical("10", "9.99")).toBe(1);
    expect(compareCanonical("0.5", "0.50")).toBe(0);
    expect(epochMsOf("2026-01-01T00:00:00.123456789Z")).toBe(Date.parse("2026-01-01T00:00:00.123Z"));
    expect(() => epochMsOf("yesterday")).toThrow(/not an ISO-8601 instant/u);
  });
});
