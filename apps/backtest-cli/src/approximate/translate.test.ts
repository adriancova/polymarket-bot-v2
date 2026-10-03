/**
 * `APPROX-REPLAY-1` — the sample → envelope translation
 * (`backtest-cli/research-tier-samples/v1`): which envelope each sample
 * becomes, what every envelope carries, and the lifecycle rules at sample
 * resolution. Every envelope asserted here has passed the core's own wire
 * door (`readEventEnvelope`), which the translation runs on each one.
 */

import { readEventEnvelope } from "@polymarket-bot/trading-core";
import { deriveReplayEventId } from "@polymarket-bot/simulation";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../archive.js";
import type { ReleaseFrame } from "./research-source.js";
import {
  APPROXIMATE_BOOK_SUBSCRIPTION_GENERATION,
  ResearchSampleTranslator,
  deriveApproximateEventId,
  type ApproximateMarket,
} from "./translate.js";
import {
  EPOCH,
  bar,
  depth,
  feedEvent,
  fullBook,
  gammaPoll,
  marketEvent,
  tick,
  top,
  trade,
  type FixtureSample,
} from "./test-support.js";

const MARKET: ApproximateMarket = {
  marketId: "019b1e00-0000-7000-8000-000000000001",
  conditionId: "0xbacktest1condition",
  yesTokenId: "9101",
  noTokenId: "9102",
  openTime: "2026-05-01T09:00:00.000Z",
  closeTime: "2026-05-01T09:15:00.000Z",
  gammaMarketId: "777",
};
const T0 = Date.UTC(2026, 4, 1, 9, 0, 0);
const C = MARKET.conditionId;

function frameOf(seq: string, atMs: number, samples: readonly FixtureSample[], ordinal = 0): ReleaseFrame {
  return {
    releaseOrdinal: ordinal,
    gatewayEpoch: EPOCH,
    releaseIngestSeq: seq,
    availableAt: new Date(atMs).toISOString(),
    availableAtEpochMs: atMs,
    releaseSegmentId: `${EPOCH}-000000`,
    samples: samples.map((sample, index) => ({ table: sample.table, row: sample.row, datasetId: "fixture", sampleOrdinal: index })),
  };
}

function translator(): ResearchSampleTranslator {
  return new ResearchSampleTranslator({ markets: [MARKET], digestSha256: sha256Hex });
}

function ok(result: ReturnType<ResearchSampleTranslator["translate"]>) {
  if (!result.ok) throw new Error(`refused: ${result.refusal.detail}`);
  return result.envelopes;
}

const r = (seq: string, atMs: number, ordinal = 0) => ({ ordinal, seq, atMs });

describe("books: one snapshot per token per release frame, from the most complete sample", () => {
  it("a full book supersedes the depth and the top of book released with it; the depth keeps five levels", () => {
    const at = T0 + 60_010;
    const samples = [
      top(r("50", at), { spanStartMs: T0 + 59_000, conditionId: C, tokenId: "9101", bid: ["0.32", "200"], ask: ["0.34", "30"] }),
      depth(r("50", at), {
        spanStartMs: T0 + 59_000,
        conditionId: C,
        tokenId: "9101",
        bids: [["0.32", "200"], ["0.31", "300"]],
        asks: [["0.34", "30"], ["0.35", "20"]],
      }),
      depth(r("50", at), { spanStartMs: T0 + 59_000, conditionId: C, tokenId: "9102", bids: [["0.65", "200"]], asks: [["0.66", "200"]] }),
      fullBook(r("50", at), {
        spanStartMs: T0,
        conditionId: C,
        tokenId: "9101",
        bids: [["0.32", "200"], ["0.31", "300"], ["0.01", "9"]],
        asks: [["0.34", "30"], ["0.35", "20"], ["0.99", "9"]],
      }),
    ];
    const t = translator();
    const envelopes = ok(t.translate(frameOf("50", at, samples), "7"));
    expect(envelopes.map((envelope) => [envelope.eventType, (envelope.payload as { tokenId: string }).tokenId])).toEqual([
      ["BookSnapshot", "9102"],
      ["BookSnapshot", "9101"],
    ]);
    const yes = envelopes[1]?.payload as { bids: unknown[]; asks: unknown[] };
    expect(yes.bids).toEqual([
      { price: "0.32", size: "200" },
      { price: "0.31", size: "300" },
      { price: "0.01", size: "9" },
    ]);
    expect(yes.asks).toHaveLength(3);
    expect(t.counts()).toMatchObject({ bookSnapshots: 2, bookSamplesSuperseded: 2 });
  });

  it("refuses a top of book with no depth sample of its token at the same frame", () => {
    const at = T0 + 1_000;
    const result = translator().translate(
      frameOf("5", at, [top(r("5", at), { spanStartMs: T0, conditionId: C, tokenId: "9101", bid: ["0.3", "1"], ask: ["0.4", "1"] })]),
      "1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.detail).toContain("no depth sample");
  });

  it("refuses a sample that names a configured token under another condition id", () => {
    const at = T0 + 1_000;
    const result = translator().translate(
      frameOf("5", at, [depth(r("5", at), { spanStartMs: T0, conditionId: "0xother", tokenId: "9101", bids: [], asks: [] })]),
      "1",
    );
    expect(result.ok).toBe(false);
  });

  it("skips and counts the samples of a market the configuration does not name", () => {
    const at = T0 + 1_000;
    const t = translator();
    const envelopes = ok(
      t.translate(
        frameOf("5", at, [
          depth(r("5", at), { spanStartMs: T0, conditionId: "0xother", tokenId: "5555", bids: [], asks: [] }),
          trade(r("5", at), { conditionId: "0xother", tokenId: "5555", price: "0.5", size: "1" }),
        ]),
        "1",
      ),
    );
    expect(envelopes).toEqual([]);
    expect(t.counts().unconfiguredMarketSamples).toBe(2);
  });
});

describe("every envelope carries its release frame's identity", () => {
  it("epoch, release ingestSeq, receipt instant, the derived monotonic reading and the segment; books carry generation 1 and no connection", () => {
    const at = T0 + 2_000;
    const samples = [
      depth(r("77", at), { spanStartMs: T0 + 1_000, conditionId: C, tokenId: "9101", bids: [["0.3", "1"]], asks: [["0.4", "1"]] }),
      bar(r("77", at), { spanStartMs: T0 + 1_000, close: "64000", volume: "0.75" }),
      trade(r("77", at), { conditionId: C, tokenId: "9101", price: "0.4", size: "5", side: "SELL" }),
    ];
    const envelopes = ok(translator().translate(frameOf("77", at, samples), "1777626002000000000"));
    expect(envelopes).toHaveLength(3);
    for (const [index, envelope] of envelopes.entries()) {
      expect(readEventEnvelope(envelope).ok).toBe(true);
      expect(envelope.gatewayEpoch).toBe(EPOCH);
      expect(envelope.ingestSeq).toBe("77");
      expect(envelope.receivedAt).toBe(new Date(at).toISOString());
      expect(envelope.receivedMonotonicNs).toBe("1777626002000000000");
      expect(envelope.rawSegmentId).toBe(`${EPOCH}-000000`);
      expect(envelope.connectionId).toBeUndefined();
      expect(envelope.causationId).toBeUndefined();
      expect(envelope.sourceChannel.startsWith("approximate:research-tier/")).toBe(true);
      expect(envelope.eventId).toBe(
        deriveApproximateEventId(sha256Hex, { gatewayEpoch: EPOCH, releaseIngestSeq: "77", epochMs: at, index }),
      );
    }
    expect(envelopes[0]?.subscriptionGeneration).toBe(APPROXIMATE_BOOK_SUBSCRIPTION_GENERATION);
    expect(envelopes[1]?.subscriptionGeneration).toBeUndefined();
    expect(envelopes[1]).toMatchObject({
      eventType: "ReferenceTradeObserved",
      source: "binance",
      payload: { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.75" },
    });
    expect(envelopes[2]).toMatchObject({
      eventType: "PublicTradeObserved",
      payload: { tokenId: "9101", price: "0.4", size: "5", takerSide: "ASK" },
    });
  });

  it("an approximate event id is never the exact replay's id for the same frame", () => {
    const exact = deriveReplayEventId(sha256Hex, { gatewayEpoch: EPOCH, ingestSeq: "77", receivedAt: new Date(T0).toISOString(), index: 0 });
    const approximate = deriveApproximateEventId(sha256Hex, { gatewayEpoch: EPOCH, releaseIngestSeq: "77", epochMs: T0, index: 0 });
    expect(exact.ok && exact.value).not.toBe(approximate);
    expect(approximate).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});

describe("trades, bars and the samples that become no envelope", () => {
  it("a trade with no size, or an unreadable side, is not replayed; BUY is the taker buying (BID)", () => {
    const at = T0 + 3_000;
    const t = translator();
    const envelopes = ok(
      t.translate(
        frameOf("9", at, [
          trade(r("9", at), { conditionId: C, tokenId: "9101", price: "0.4", size: "2", side: "BUY", entryIndex: 0 }),
          trade(r("9", at), { conditionId: C, tokenId: "9101", price: "0.4", size: null, entryIndex: 1 }),
          trade(r("9", at), { conditionId: C, tokenId: "9101", price: "0.4", size: "2", side: "SIDEWAYS", entryIndex: 2 }),
          trade(r("9", at), { conditionId: C, tokenId: "9101", price: "0.4", size: "0", entryIndex: 3 }),
        ]),
        "1",
      ),
    );
    expect(envelopes.map((envelope) => envelope.payload)).toEqual([
      { internalMarketId: MARKET.marketId, tokenId: "9101", price: "0.4", size: "2", takerSide: "BID" },
    ]);
    expect(t.counts()).toMatchObject({ publicTrades: 1, tradesNotReplayed: 3 });
  });

  it("lifecycle events of the market channel, ticks and feed events become nothing, and are counted", () => {
    const at = T0 + 4_000;
    const t = translator();
    const envelopes = ok(
      t.translate(
        frameOf("10", at, [
          feedEvent(r("10", at), { eventKind: "connection-changed" }),
          marketEvent(r("10", at), { eventType: "market_resolved", conditionId: C, entryIndex: 0 }),
          marketEvent(r("10", at), { eventType: "tick_size_change", conditionId: C, entryIndex: 1 }),
          tick(r("10", at), { value: "64000.5", entryIndex: 2 }),
        ]),
        "1",
      ),
    );
    expect(envelopes).toEqual([]);
    expect(t.counts()).toMatchObject({ feedEventsNotReplayed: 1, lifecycleRowsNotReplayed: 2, chainlinkTicksNotReplayed: 1 });
  });
});

describe("lifecycle at sample resolution (UNIV-4 R1-R5)", () => {
  it("R1/R2: the first attributed ready poll opens the market once, openedAt = the configured openTime; R3 closes it on schedule, first in its frame", () => {
    const t = translator();
    const pollAt = T0 + 5_000;
    const opened = ok(
      t.translate(frameOf("1", pollAt, [gammaPoll(r("1", pollAt), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true })]), "1"),
    );
    expect(opened.map((envelope) => [envelope.eventType, envelope.payload])).toEqual([
      ["MarketOpened", { internalMarketId: MARKET.marketId, conditionId: C, openedAt: MARKET.openTime }],
    ]);
    // A second ready poll opens nothing.
    expect(ok(t.translate(frameOf("2", pollAt + 10, [gammaPoll(r("2", pollAt + 10), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true })]), "1"))).toEqual([]);
    // Before closeTime, a book frame carries no closing.
    const before = T0 + 899_999;
    expect(
      ok(t.translate(frameOf("3", before, [bar(r("3", before), { spanStartMs: T0 + 898_000, close: "1" })]), "1")).map((envelope) => envelope.eventType),
    ).toEqual(["ReferenceTradeObserved"]);
    // The first frame at or after closeTime: the scheduled closing comes FIRST.
    const after = T0 + 900_000;
    const closing = ok(t.translate(frameOf("4", after, [bar(r("4", after), { spanStartMs: T0 + 899_000, close: "1" })]), "1"));
    expect(closing.map((envelope) => envelope.eventType)).toEqual(["MarketClosing", "ReferenceTradeObserved"]);
    expect(closing[0]?.payload).toEqual({ internalMarketId: MARKET.marketId, conditionId: C, closesAt: MARKET.closeTime });
    // Only once.
    expect(ok(t.translate(frameOf("5", after + 1_000, [bar(r("5", after + 1_000), { spanStartMs: T0 + 900_000, close: "1" })]), "1")).map((envelope) => envelope.eventType)).toEqual(
      ["ReferenceTradeObserved"],
    );
    expect(t.lifecycles()[0]).toMatchObject({ phase: "OPEN", openedAtFrame: "1", scheduledClosingAtFrame: "4" });
  });

  it("R2: a not-ready poll at or after openTime makes openedAt the ready poll's own instant", () => {
    const t = translator();
    ok(t.translate(frameOf("1", T0 + 1_000, [gammaPoll(r("1", T0 + 1_000), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: false })]), "1"));
    const opened = ok(
      t.translate(frameOf("2", T0 + 11_000, [gammaPoll(r("2", T0 + 11_000), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true })]), "1"),
    );
    expect(opened[0]?.payload).toMatchObject({ openedAt: new Date(T0 + 11_000).toISOString() });
  });

  it("R4: a poll showing the venue's own close while open emits MarketClosing at the poll's instant; the market is then terminal", () => {
    const t = translator();
    ok(t.translate(frameOf("1", T0 + 1_000, [gammaPoll(r("1", T0 + 1_000), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true })]), "1"));
    const closed = ok(
      t.translate(frameOf("2", T0 + 61_000, [gammaPoll(r("2", T0 + 61_000), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: false })]), "1"),
    );
    expect(closed.map((envelope) => [envelope.eventType, envelope.payload])).toEqual([
      ["MarketClosing", { internalMarketId: MARKET.marketId, conditionId: C, closesAt: new Date(T0 + 61_000).toISOString() }],
    ]);
    expect(t.lifecycles()[0]).toMatchObject({ phase: "TERMINAL", observedClosingAtFrame: "2" });
    // Terminal: the schedule emits nothing more.
    expect(ok(t.translate(frameOf("3", T0 + 901_000, [bar(r("3", T0 + 901_000), { spanStartMs: T0 + 900_000, close: "1" })]), "1")).map((envelope) => envelope.eventType)).toEqual([
      "ReferenceTradeObserved",
    ]);
  });

  it("R5: a closed market seen before it opened emits nothing; a poll for an unconfigured Gamma id is not attributed", () => {
    const t = translator();
    expect(ok(t.translate(frameOf("1", T0 + 1_000, [gammaPoll(r("1", T0 + 1_000), { gammaMarketId: "999", active: true, closed: false, acceptingOrders: true })]), "1"))).toEqual([]);
    expect(ok(t.translate(frameOf("2", T0 + 2_000, [gammaPoll(r("2", T0 + 2_000), { gammaMarketId: "777", active: true, closed: true, acceptingOrders: false })]), "1"))).toEqual([]);
    expect(ok(t.translate(frameOf("3", T0 + 3_000, [gammaPoll(r("3", T0 + 3_000), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true })]), "1"))).toEqual([]);
    expect(t.counts()).toMatchObject({ gammaPollsUnattributed: 1, gammaPollsAttributed: 2, lifecycleEnvelopes: 0 });
    expect(t.lifecycles()[0]).toMatchObject({ phase: "TERMINAL", contradictedBeforeOpen: true });
  });

  it("a market first seen ready after its closeTime gets MarketOpened and the scheduled closing, in that order", () => {
    const t = translator();
    const late = T0 + 950_000;
    const envelopes = ok(
      t.translate(frameOf("1", late, [gammaPoll(r("1", late), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true })]), "1"),
    );
    expect(envelopes.map((envelope) => envelope.eventType)).toEqual(["MarketOpened", "MarketClosing"]);
  });
});
