/**
 * UNIV-4 — REPRODUCTION AT BASE (closeout blocker B10).
 *
 * `MarketOpened` / `MarketClosing` are produced NOWHERE in the repository
 * (`BACKTEST-1` task F; `IMPLEMENTATION_STATUS.md` row `UNIV-4`). The gateway's
 * Polymarket feed emits only `MARKET_DATA_EVENT_TYPES`
 * (`apps/data-gateway/src/feeds/polymarket.ts:71-79`), which lacks both, so a
 * live-data paper run can never leave `PENDING`: `apps/trader/src/pipeline.ts`
 * maps `PENDING → UNKNOWN` and §9.8 fails closed on it.
 *
 * This test is the pin that flips. At base it configures one market whose
 * reviewed configuration says `status: "OPEN"` with an `openTime` in the past
 * and a `closeTime` ahead, stubs the venue so that BOTH documented surfaces
 * answer — the market WebSocket delivers a `book` frame, and the documented
 * polled market-state surface (`GET /markets/{id}`, D-30) would answer a
 * trade-ready `Market` (`active && !closed && acceptingOrders`) if anything
 * asked — runs the gateway across several tick intervals, and asserts that the
 * published stream NEVER carries `MarketOpened` or `MarketClosing`, and that
 * nothing ever asked the polled surface.
 *
 * Configuration alone (`status: "OPEN"`, `openTime`) does NOT open the
 * market, and must not: configuration says nothing about the venue's state
 * (§9.2 "subscriptions and the universe directory are configuration, not
 * discovery"). The round that closes B10 replaces the absence assertions
 * below with the derivation the row requires.
 */

import { describe, expect, it } from "vitest";

import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";

import { buildHarness, polymarketBookFrame, polymarketRestBook, MARKET } from "./support/harness.js";

/** A trade-ready `Market` in the documented D-30 shape (all state fields present). */
function gammaReadyMarket(): Record<string, unknown> {
  return {
    id: "900001",
    conditionId: MARKET.conditionId,
    question: "Synthetic market (reproduction stub)",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    restricted: false,
    enableOrderBook: true,
    negRisk: false,
    startDate: "2026-09-01T00:00:00Z",
    endDate: "2026-12-31T00:00:00Z",
    closedTime: null,
    gameStartTime: null,
  };
}

describe("UNIV-4 reproduction — nothing produces MarketOpened / MarketClosing", () => {
  it("a configured OPEN market with a trade-ready venue never opens in the published stream", async () => {
    const marketStateRequests: string[] = [];
    const route = (request: PublicHttpRequest): PublicHttpResponse => {
      if (request.url.includes("/markets/")) {
        marketStateRequests.push(request.url);
        return { status: 200, body: JSON.stringify(gammaReadyMarket()) };
      }
      return {
        status: 200,
        body: JSON.stringify(polymarketRestBook(MARKET.yesTokenId, MARKET.conditionId)),
      };
    };
    const harness = await buildHarness({
      config: {
        markets: [
          {
            ...MARKET,
            parameters: {
              ...MARKET.parameters,
              status: "OPEN",
              openTime: "2026-09-01T00:00:00.000Z",
              closeTime: "2026-12-31T00:00:00.000Z",
            },
          },
        ],
        polymarket: { feedId: "polymarket-market" },
      },
      http: route,
    });
    harness.gateway.start();
    const socket = harness.polymarketSockets.current;
    socket.open();
    socket.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    await harness.settle();
    // Several tick intervals of a healthy run: still nothing.
    harness.timers.advance(60_000);
    await harness.settle();
    await harness.gateway.stop();

    // The market data flowed…
    expect(harness.publishedOfType("BookSnapshot")).toHaveLength(1);
    // …and the lifecycle never did. This is B10.
    expect(harness.publishedOfType("MarketOpened")).toHaveLength(0);
    expect(harness.publishedOfType("MarketClosing")).toHaveLength(0);
    // Nothing in the gateway consults the documented polled surface.
    expect(marketStateRequests).toHaveLength(0);
    // And the whole published vocabulary lacks both event types.
    const types = new Set(harness.published().map((envelope) => envelope.eventType));
    expect(types.has("MarketOpened")).toBe(false);
    expect(types.has("MarketClosing")).toBe(false);
  });
});
