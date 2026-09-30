/**
 * `THROUGHPUT-2` (ADR-024) — the trader evaluates ONCE PER VENUE FRAME, on the
 * fully applied frame, and never on a state between two of its events.
 *
 * H1 run 1 (`docs/handoffs/H1-RUN-1.md` finding 2, `H1R1-FRAME-ATOMICITY`):
 * every Polymarket `price_change` frame produced TWO `BookLevelChanged` events,
 * one per token of the pair, sharing one `causationId`, and the trader
 * evaluated after EACH — so half of all evaluations saw the YES book already
 * updated beside a NO book that was not yet: a book state that never existed at
 * the venue. These tests drive the REAL assembled core (the fixture's order
 * books, features, strategy runtime and Static Bracket) and record, at every
 * evaluation, the two book views the strategy is handed.
 *
 * NON-VACUOUS: on base `bf1ee89` the first test fails — the evaluation after
 * the frame's first event records the half-applied pair.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { IngestedEvent, PaperTrader } from "@polymarket-bot/trader";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_EPOCH,
  MARKET_ID,
  NO_TOKEN,
  YES_TOKEN,
  ingested,
  resetEventIds,
} from "./support/fixture.js";
import { assembleOrThrow } from "./support/run.js";

const CONDITION = "0xcondition";

/** The same event as `ingested` builds, stamped as one gateway raw frame's event. */
function inFrame(frame: string, event: IngestedEvent): IngestedEvent {
  const envelope: EventEnvelope<unknown> = {
    ...event.envelope,
    causationId: `raw:${GATEWAY_EPOCH}:${frame}`,
  };
  return { envelope, identity: event.identity };
}

function level(tokenId: string, side: "BID" | "ASK", price: string, size: string, seq: number, at: string): IngestedEvent {
  return ingested(
    "BookLevelChanged",
    { internalMarketId: MARKET_ID, tokenId, side, price, size },
    { receivedAt: at, ingestSeq: seq },
  );
}

/** The run's opening: reference prices, the market open, and both baselines (no entry fires: asks above 0.35). */
function opening(): IngestedEvent[] {
  resetEventIds();
  return [
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100000", size: "0.5" },
      { receivedAt: "2026-03-04T11:59:58.000Z", ingestSeq: 1, source: "binance" },
    ),
    ingested(
      "MarketOpened",
      { internalMarketId: MARKET_ID, conditionId: CONDITION, openedAt: "2026-03-04T12:00:00.000Z" },
      { receivedAt: "2026-03-04T12:00:00.000Z", ingestSeq: 2 },
    ),
    ingested(
      "BookSnapshot",
      {
        internalMarketId: MARKET_ID,
        tokenId: YES_TOKEN,
        bids: [{ price: "0.38", size: "200" }],
        asks: [{ price: "0.4", size: "200" }],
      },
      { receivedAt: "2026-03-04T12:00:00.100Z", ingestSeq: 3 },
    ),
    ingested(
      "BookSnapshot",
      {
        internalMarketId: MARKET_ID,
        tokenId: NO_TOKEN,
        bids: [{ price: "0.59", size: "200" }],
        asks: [{ price: "0.61", size: "200" }],
      },
      { receivedAt: "2026-03-04T12:00:00.200Z", ingestSeq: 4 },
    ),
  ];
}

interface Seen {
  readonly yesBestAsk: string | undefined;
  readonly noBestBid: string | undefined;
}

/**
 * Records, per evaluation, the YES best ask and the NO best bid the strategy
 * was handed. The loop builds `books.yes` then `books.no` for every
 * evaluation (`#buildEvaluationInput`), so each NO view closes one pair.
 */
function spyOnBooks(trader: PaperTrader): Seen[] {
  const market = trader.markets.get(MARKET_ID);
  if (market === undefined) throw new Error("the fixture market is not assembled");
  const original = market.bookView.bind(market);
  const seen: Seen[] = [];
  let yesBestAsk: string | undefined;
  Object.defineProperty(market, "bookView", {
    configurable: true,
    value: (outcome: "YES" | "NO", fallbackAsOf: string) => {
      const view = original(outcome, fallbackAsOf);
      if (outcome === "YES") {
        yesBestAsk = view.asks[0]?.price;
      } else {
        seen.push({ yesBestAsk, noBestBid: view.bids[0]?.price });
      }
      return view;
    },
  });
  return seen;
}

async function drive(trader: PaperTrader, events: readonly IngestedEvent[]): Promise<void> {
  for (const event of events) {
    expect(trader.loop.ingest(event)).toBe(true);
  }
  await trader.loop.drain();
}

describe("THROUGHPUT-2: one evaluation per venue frame, on the fully applied frame", () => {
  it("a two-token price_change frame is evaluated ONCE, after both tokens applied — never half-applied", async () => {
    const { trader } = assembleOrThrow();
    const seen = spyOnBooks(trader);
    const frame = [
      // One venue frame: the YES ask and the NO bid move together.
      inFrame("100", level(YES_TOKEN, "ASK", "0.42", "150", 5, "2026-03-04T12:00:01.000Z")),
      inFrame("100", level(NO_TOKEN, "BID", "0.57", "150", 6, "2026-03-04T12:00:01.000Z")),
    ];
    const events = [...opening(), ...frame];
    await drive(trader, events);

    // Every event was applied: both books show the frame's levels.
    const market = trader.markets.get(MARKET_ID);
    expect(market?.bookFor("YES").levels("ASK").map((entry) => entry.price)).toEqual(["0.4", "0.42"]);
    expect(market?.bookFor("NO").levels("BID").map((entry) => entry.price)).toEqual(["0.59", "0.57"]);

    // The half-applied pair — YES moved, NO not yet — is never evaluated.
    // (Both new levels sit BEHIND the best prices, so a best-price view cannot
    // show them; the pin is on WHICH states were evaluated, below.)
    const decisions = trader.loop.decisions();
    const sources = decisions.map((decision) => decision.sourceEventId);
    const frameFirst = frame[0]?.envelope.eventId;
    const frameLast = frame[1]?.envelope.eventId;
    expect(sources).not.toContain(frameFirst);
    expect(sources.filter((source) => source === frameLast)).toHaveLength(1);
    // Opening: one reference tick, the market open, two snapshots; then ONE frame evaluation.
    expect(seen).toHaveLength(decisions.length);
    expect(decisions.at(-1)?.sourceEventId).toBe(frameLast);
    expect(decisions.at(-1)?.callback).toBe("onFeatures");
    // The health counters still see every event processed.
    expect(trader.loop.health().loop.eventsProcessed).toBe(events.length);
  });

  it("the frame's evaluation sees BOTH tokens' new best prices; base's per-event evaluation saw YES alone first", async () => {
    const { trader } = assembleOrThrow();
    const seen = spyOnBooks(trader);
    const frame = [
      // New BEST prices on both books, in one frame.
      inFrame("200", level(YES_TOKEN, "ASK", "0.39", "150", 5, "2026-03-04T12:00:01.000Z")),
      inFrame("200", level(NO_TOKEN, "BID", "0.6", "150", 6, "2026-03-04T12:00:01.000Z")),
    ];
    await drive(trader, [...opening(), ...frame]);

    const opened = seen.length - 1;
    // The last evaluation is the frame's: YES 0.39 ask beside NO 0.6 bid.
    expect(seen.at(-1)).toEqual({ yesBestAsk: "0.39", noBestBid: "0.6" });
    // No evaluation ever saw the state between the two events.
    expect(seen).not.toContainEqual({ yesBestAsk: "0.39", noBestBid: "0.59" });
    expect(seen.slice(0, opened).every((pair) => pair.yesBestAsk !== "0.39")).toBe(true);
  });

  it("a single-event frame (no shared causationId) is evaluated after its own event, exactly as before", async () => {
    const { trader } = assembleOrThrow();
    const seen = spyOnBooks(trader);
    const lone = [
      level(YES_TOKEN, "ASK", "0.39", "150", 5, "2026-03-04T12:00:01.000Z"),
      level(NO_TOKEN, "BID", "0.6", "150", 6, "2026-03-04T12:00:01.100Z"),
    ];
    await drive(trader, [...opening(), ...lone]);
    const sources = trader.loop.decisions().map((decision) => decision.sourceEventId);
    expect(sources.slice(-2)).toEqual([lone[0]?.envelope.eventId, lone[1]?.envelope.eventId]);
    // Two events, two evaluations: the first saw YES moved and NO not yet —
    // which is the right state HERE, because they were two venue frames.
    expect(seen.slice(-2)).toEqual([
      { yesBestAsk: "0.39", noBestBid: "0.59" },
      { yesBestAsk: "0.39", noBestBid: "0.6" },
    ]);
  });

  it("a multi-trade reference frame applies every trade and evaluates the market once", async () => {
    const { trader } = assembleOrThrow();
    const trades = [0, 1, 2].map((index) =>
      inFrame(
        "300",
        ingested(
          "ReferenceTradeObserved",
          { venue: "binance", symbol: "BTCUSDT", price: String(100_010 + index), size: "0.1" },
          { receivedAt: "2026-03-04T12:00:02.000Z", ingestSeq: 5 + index, source: "binance" },
        ),
      ),
    );
    const before = (async () => {
      await drive(trader, opening());
      return trader.loop.decisions().length;
    })();
    const opened = await before;
    await drive(trader, trades);
    const after = trader.loop.decisions();
    expect(after.length - opened).toBe(1);
    expect(after.at(-1)?.sourceEventId).toBe(trades[2]?.envelope.eventId);
    expect(trader.loop.health().loop.eventsProcessed).toBe(opening().length + trades.length);
  });

  it("a frame whose first event halts its market (desynchronized book) is not evaluated at its close", async () => {
    const { trader } = assembleOrThrow();
    const frame = [
      // A level change for a token with no baseline in this run: BOOK_DESYNCHRONIZED.
      inFrame("400", level(YES_TOKEN, "ASK", "0.39", "150", 1, "2026-03-04T12:00:01.000Z")),
      inFrame("400", level(NO_TOKEN, "BID", "0.6", "150", 2, "2026-03-04T12:00:01.000Z")),
    ];
    await drive(trader, frame);
    expect(trader.halts.isMarketHalted(MARKET_ID)).toBe(true);
    expect(trader.loop.decisions()).toHaveLength(0);
  });

  it("a REPLAYED raw record — several envelopes carrying the record's own identity, no causationId — is one frame", async () => {
    // `apps/backtest-cli`'s raw-frame normalizers stamp every envelope derived
    // from one recorded frame with that record's (gatewayEpoch, ingestSeq);
    // the core groups them exactly as it groups the gateway's causationId.
    const { trader } = assembleOrThrow();
    const seen = spyOnBooks(trader);
    await drive(trader, opening());
    const opened = trader.loop.decisions().length;
    const record = [
      level(YES_TOKEN, "ASK", "0.39", "150", 5, "2026-03-04T12:00:01.000Z"),
      level(NO_TOKEN, "BID", "0.6", "150", 5, "2026-03-04T12:00:01.000Z"),
    ];
    await drive(trader, record);
    expect(trader.loop.decisions().length - opened).toBe(1);
    expect(seen.at(-1)).toEqual({ yesBestAsk: "0.39", noBestBid: "0.6" });
    expect(seen).not.toContainEqual({ yesBestAsk: "0.39", noBestBid: "0.59" });
  });

  it("a frame never outlives a drain: a producer that splits one evaluates each part at its drain's end", async () => {
    // The producers' obligation (ADR-024 §2) is to hand whole frames to a
    // drain; this pins what the loop does if one does not — it never holds a
    // frame open across drains (so a recorded position is never mid-frame).
    const { trader } = assembleOrThrow();
    await drive(trader, opening());
    const opened = trader.loop.decisions().length;
    const first = inFrame("500", level(YES_TOKEN, "ASK", "0.39", "150", 5, "2026-03-04T12:00:01.000Z"));
    const second = inFrame("500", level(NO_TOKEN, "BID", "0.6", "150", 6, "2026-03-04T12:00:01.000Z"));
    await drive(trader, [first]);
    expect(trader.loop.decisions().length - opened).toBe(1);
    await drive(trader, [second]);
    expect(trader.loop.decisions().length - opened).toBe(2);
  });
});
