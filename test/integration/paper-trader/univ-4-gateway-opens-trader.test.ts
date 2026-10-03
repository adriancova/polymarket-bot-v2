/**
 * `UNIV-4` acceptance (c), the in-memory half — the trader opens a market
 * from the gateway's REAL `MarketOpened`, with no container.
 *
 * The Redis/PostgreSQL drive of the same claim is
 * `./univ-4-gateway-opens-trader-redis.test.ts` (the REAL composition root,
 * the REAL transport). This file proves the same derivation chain on the
 * data-gateway suite's in-memory harness and the paper-trader suite's
 * in-memory assembly, so the claim is checkable without Docker and in
 * milliseconds: the gateway (real composition, injected doubles) polls a stub
 * of the documented `GET /markets/{id}` surface answering a trade-ready
 * `Market`, derives the REAL `MarketOpened`, journals the raw response first,
 * publishes it through its real dispatcher, sequencer and publisher alongside
 * the `BookSnapshot`s its market WebSocket driver normalized from two book
 * frames and the reference trades its Binance driver normalized; every
 * envelope the gateway published is then ingested — unchanged — by the
 * assembled paper trader, which leaves `PENDING`, evaluates the Static
 * Bracket on the book, and ADMITS an entry (risk approval, plan, submission,
 * fill). No hand-written lifecycle event exists anywhere in this file. The
 * contrast scenario runs the same gateway without the lifecycle feed: the
 * trader stays `PENDING` (§9.8 `UNKNOWN`, fail closed) and admits nothing.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";

import { binanceTradeFrame, buildHarness, polymarketRestBook } from "../data-gateway/support/harness.js";
import { CONDITION_ID, MARKET_ID, NO_TOKEN, T_CLOSE, T_OPEN, YES_TOKEN } from "./support/fixture.js";
import { assembleOrThrow } from "./support/run.js";

const GAMMA_BASE = "http://gamma.stub";

/** The trader fixture's market, as the GATEWAY would be configured for it. */
const GATEWAY_MARKET = {
  internalMarketId: MARKET_ID,
  conditionId: CONDITION_ID,
  yesTokenId: YES_TOKEN,
  noTokenId: NO_TOKEN,
  gammaMarketId: "900001",
  parameters: {
    tickSize: "0.01",
    minimumOrderSize: "5",
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
    openTime: T_OPEN,
    closeTime: T_CLOSE,
  },
  observedAt: "2026-03-04T11:00:00.000Z",
} as const;

/** A trade-ready `Market` in the documented D-30 shape. */
const READY_MARKET = {
  conditionId: CONDITION_ID,
  question: "Synthetic market (stub)",
  active: true,
  closed: false,
  archived: false,
  acceptingOrders: true,
  restricted: false,
  enableOrderBook: true,
  negRisk: false,
  startDate: "2026-03-04T12:00:00Z",
  endDate: "2026-03-04T12:15:00Z",
  closedTime: null,
  gameStartTime: null,
};

/** The fixture's YES ladder: executable buy for 50 shares at 0.34, under the 0.35 trigger. */
function bookFrame(tokenId: string, bids: readonly [string, string][], asks: readonly [string, string][]): string {
  return JSON.stringify([
    {
      event_type: "book",
      market: CONDITION_ID,
      asset_id: tokenId,
      bids: bids.map(([price, size]) => ({ price, size })),
      asks: asks.map(([price, size]) => ({ price, size })),
      hash: `hash-${tokenId}`,
      timestamp: "1772625600000",
    },
  ]);
}

describe("UNIV-4 acceptance (c) — the trader opens a market from the gateway's REAL MarketOpened", () => {
  it("leaves PENDING on the gateway-produced MarketOpened and admits an entry on the gateway-produced book", async () => {
    const gammaRequests: string[] = [];
    const route = (request: PublicHttpRequest): PublicHttpResponse => {
      if (request.url.startsWith(`${GAMMA_BASE}/markets/`)) {
        gammaRequests.push(request.url);
        return { status: 200, body: JSON.stringify(READY_MARKET) };
      }
      return { status: 200, body: JSON.stringify(polymarketRestBook(YES_TOKEN, CONDITION_ID)) };
    };
    const gateway = await buildHarness({
      config: {
        markets: [GATEWAY_MARKET],
        polymarket: { feedId: "polymarket-market" },
        binance: { feedId: "binance-reference", symbols: ["BTCUSDT"], stalenessThresholdMs: 30_000 },
        lifecycle: { feedId: "polymarket-lifecycle", baseUrl: GAMMA_BASE, pollIntervalMs: 10_000 },
      },
      http: route,
    });
    // The gateway's manual clock starts in 2025; move it to the fixture's
    // open instant so the configured openTime is past (and closeTime ahead).
    gateway.timers.advance(Date.parse(T_OPEN) - gateway.clock.nowMs());
    gateway.gateway.start();
    // The reference feed the risk engine's freshness check reads: two real
    // Binance trade frames through the gateway's Binance driver.
    const binance = gateway.binanceSockets.current;
    binance.open();
    binance.message(binanceTradeFrame("BTCUSDT", 1, gateway.clock.nowMs()));
    binance.message(binanceTradeFrame("BTCUSDT", 2, gateway.clock.nowMs()));
    // The first poll (at start) finds the venue ready: the REAL MarketOpened,
    // from the venue-shaped response — and only that, since the reviewed
    // closeTime (15 minutes ahead) is not reached.
    await gateway.settle();
    const socket = gateway.polymarketSockets.current;
    socket.open();
    socket.message(bookFrame(YES_TOKEN, [["0.32", "200"], ["0.31", "300"]], [["0.34", "200"], ["0.35", "300"]]));
    socket.message(bookFrame(NO_TOKEN, [["0.65", "200"]], [["0.66", "200"]]));
    await gateway.settle();
    // `CADENCE-1` (ADR-026): every envelope above carries ONE instant (the
    // gateway's manual clock has not moved), and the trader evaluates a market
    // at most once per 1 s of event time. The first reference trade evaluates
    // it (no book yet); the books, at that same instant, are owed and carried.
    // Two later reference trades, 1 s and 2 s on, close the frames at which the
    // carried evaluation runs: Static Bracket arms on the first and enters on
    // the second, as it did on the books themselves under the per-frame cadence.
    for (const tradeId of [3, 4]) {
      gateway.timers.advance(1_000);
      binance.message(binanceTradeFrame("BTCUSDT", tradeId, gateway.clock.nowMs()));
    }
    await gateway.settle();
    await gateway.gateway.stop();

    expect(gammaRequests).toEqual([`${GAMMA_BASE}/markets/900001`]);
    const published = gateway.published();
    const opened = published.filter((envelope) => envelope.eventType === "MarketOpened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.source).toBe("polymarket");
    expect(opened[0]?.sourceChannel).toBe("polymarket:gamma-market-rest");
    expect((opened[0]?.payload as { openedAt: string }).openedAt).toBe(T_OPEN);
    expect(published.filter((envelope) => envelope.eventType === "MarketClosing")).toHaveLength(0);
    expect(published.filter((envelope) => envelope.eventType === "BookSnapshot")).toHaveLength(2);

    // The trader, fed EXACTLY what the gateway published, in the gateway's order.
    const run = assembleOrThrow();
    for (const [index, envelope] of published.entries()) {
      run.trader.loop.ingest({
        envelope: envelope as EventEnvelope<unknown>,
        identity: {
          gatewayEpoch: envelope.gatewayEpoch,
          ingestSeq: envelope.ingestSeq,
          receivedAt: envelope.receivedAt,
          datasetRowOrdinal: index + 1,
        },
      });
    }
    await run.trader.loop.drain();

    const health = run.trader.loop.health();
    expect(health.halts).toEqual([]);
    const market = run.trader.markets.get(MARKET_ID);
    expect(market?.lifecycle).toBe("OPEN");
    const decisions = run.trader.loop.decisions();
    expect(decisions.some((decision) => decision.decisionType === "enter")).toBe(true);
    expect(health.risk.approvals).toBeGreaterThanOrEqual(1);
    expect(health.execution.submissionsAccepted).toBeGreaterThanOrEqual(1);
    expect(health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
  });

  it("without the lifecycle feed the same gateway stream leaves the trader PENDING and admits nothing (the pin, for contrast)", async () => {
    const gateway = await buildHarness({
      config: {
        markets: [GATEWAY_MARKET],
        polymarket: { feedId: "polymarket-market" },
        binance: { feedId: "binance-reference", symbols: ["BTCUSDT"], stalenessThresholdMs: 30_000 },
      },
      http: () => ({ status: 200, body: JSON.stringify(polymarketRestBook(YES_TOKEN, CONDITION_ID)) }),
    });
    gateway.timers.advance(Date.parse(T_OPEN) - gateway.clock.nowMs());
    gateway.gateway.start();
    const binance = gateway.binanceSockets.current;
    binance.open();
    binance.message(binanceTradeFrame("BTCUSDT", 1, gateway.clock.nowMs()));
    binance.message(binanceTradeFrame("BTCUSDT", 2, gateway.clock.nowMs()));
    const socket = gateway.polymarketSockets.current;
    socket.open();
    socket.message(bookFrame(YES_TOKEN, [["0.32", "200"], ["0.31", "300"]], [["0.34", "200"], ["0.35", "300"]]));
    socket.message(bookFrame(NO_TOKEN, [["0.65", "200"]], [["0.66", "200"]]));
    await gateway.settle();
    // `CADENCE-1` (ADR-026): every envelope above carries ONE instant (the
    // gateway's manual clock has not moved), and the trader evaluates a market
    // at most once per 1 s of event time. The first reference trade evaluates
    // it (no book yet); the books, at that same instant, are owed and carried.
    // Two later reference trades, 1 s and 2 s on, close the frames at which the
    // carried evaluation runs: Static Bracket arms on the first and enters on
    // the second, as it did on the books themselves under the per-frame cadence.
    for (const tradeId of [3, 4]) {
      gateway.timers.advance(1_000);
      binance.message(binanceTradeFrame("BTCUSDT", tradeId, gateway.clock.nowMs()));
    }
    await gateway.settle();
    await gateway.gateway.stop();

    const run = assembleOrThrow();
    for (const [index, envelope] of gateway.published().entries()) {
      run.trader.loop.ingest({
        envelope: envelope as EventEnvelope<unknown>,
        identity: {
          gatewayEpoch: envelope.gatewayEpoch,
          ingestSeq: envelope.ingestSeq,
          receivedAt: envelope.receivedAt,
          datasetRowOrdinal: index + 1,
        },
      });
    }
    await run.trader.loop.drain();
    expect(run.trader.markets.get(MARKET_ID)?.lifecycle).toBe("PENDING");
    const health = run.trader.loop.health();
    // §9.8: PENDING maps to UNKNOWN and fails closed at the risk seam.
    expect(health.risk.approvals).toBe(0);
    expect(health.execution.plansBuilt).toBe(0);
    expect(health.execution.submissionsAccepted).toBe(0);
  });
});
