/**
 * `ROLLOVER-1` r2 (R2-ASTRA-01, R2-ASTRA-02) — a window that HOLDS inventory
 * past its unresolved bound, end to end: the REAL gateway composition (on the
 * data-gateway suite's harness, with VENUE-SETL-1's recorded keyset page and
 * CLOB bodies on its HTTP port) admits it, and the REAL trader composition root
 * consumes exactly what the gateway published, in the gateway's order.
 *
 * The case the verifiers asked for: a gateway-admitted window, a position in
 * it, its unresolved bound passed, and a resolution that arrives LATE. With a
 * reviewed cap of 1 and a bound of 300 s:
 *
 * 1. the gateway admits W1 (22:15-22:30) and the trader buys 50 at 0.34 in it,
 *    holding to resolution;
 * 2. W1 closes, and its bound passes with no `market_resolved`: the gateway
 *    keeps W1 ADMITTED and subscribed, names it (`GATEWAY_SERIES_WINDOW_UNRESOLVED`)
 *    and DEFERS every later window (`GATEWAY_SERIES_CAP_REACHED`) — W1 keeps
 *    its cap slot; the trader reports W1 `HELD_UNRESOLVED` and keeps it;
 * 3. long after the bound (22:52), W1's `market_resolved` arrives: the gateway
 *    still publishes `MarketResolved` (W1 was never abandoned), the trader's
 *    W1 strategy handles it and W1 is torn down `RESOLVED`; the gateway
 *    retires W1 and admits the next open window, W3 (22:45-23:00), which the
 *    trader admits in turn.
 *
 * Under r1 the gateway admitted W2 in W1's place at 22:35 (a past-bound window
 * held no cap slot), and at 22:50, with W2 also past its bound, ABANDONED W1:
 * unsubscribed and released, so its late resolution was never published and
 * the trader kept W1 HELD for the rest of its run.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { AdmissionNotice } from "@polymarket-bot/trader";
import { describe, expect, it } from "vitest";

import { binanceTradeFrame, buildHarness } from "../data-gateway/support/harness.js";
import { assembleOrThrow } from "./support/run.js";
import { bookFrame, ingestedOf, review, seriesConfig, seriesGatewayConfig, seriesVenue, W1, W2, W3 } from "./support/series-windows.js";

/** The review both sides hold: a cap of 1 and an unresolved bound of 300 s. */
const SERIES = { ...review(), maximumConcurrentWindows: 1, unresolvedTeardownSeconds: 300 };
/** Hold the position through the close, to its resolution (no protective exit before it). */
const HOLD_TO_RESOLUTION = { final_policy: "HOLD_TO_RESOLUTION", allow_resolution_hold: true, maximum_holding_seconds: 7200 } as const;
/** 22:16:00Z: inside W1; W2 (22:30) is due within the admission lead, but the cap of 1 holds it. */
const START_MS = Date.UTC(2026, 9, 4, 22, 16, 0);
/** 22:52:00Z: W1 closed at 22:30, its bound passed at 22:35; W2 closed at 22:45; W3 is open. */
const LATE_RESOLUTION_MS = Date.UTC(2026, 9, 4, 22, 52, 0);

function traderConfig(): Record<string, unknown> {
  const base = seriesConfig(SERIES);
  const instance = (base["seriesInstances"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  const params = instance["params"] as Record<string, unknown>;
  return { ...base, seriesInstances: [{ ...instance, params: { ...params, exit: { ...(params["exit"] as Record<string, unknown>), ...HOLD_TO_RESOLUTION } } }] };
}

function payloadOf(envelope: EventEnvelope<unknown>): Record<string, unknown> {
  return envelope.payload as Record<string, unknown>;
}

/** Runs the gateway over the timeline above and returns everything it published, and its ledger metrics. */
async function gatewayRun() {
  const stub = seriesVenue();
  const gateway = await buildHarness({ config: seriesGatewayConfig(SERIES), http: stub.route, clockStartMs: START_MS });
  let tradeId = 0;
  const step = async (ms: number): Promise<void> => {
    gateway.timers.advance(ms);
    tradeId += 1;
    gateway.binanceSockets.current.message(binanceTradeFrame("BTCUSDT", tradeId, gateway.clock.nowMs()));
    await gateway.settle();
  };
  const market = gateway.polymarketSockets;

  gateway.gateway.start();
  gateway.binanceSockets.current.open();
  market.current.open();
  await step(0);
  // 22:16: W1 is admitted (W2 is due, but held by the cap); the lifecycle feed opens W1.
  for (let index = 0; index < 3; index += 1) await step(10_000);
  // W1 is quoted UNDER the entry trigger: the bracket arms, then buys 50 at 0.34.
  const quoted = gateway.clock.nowMs();
  market.current.message(bookFrame(W1.conditionId, W1.yesTokenId, [["0.32", "200"], ["0.31", "300"]], [["0.34", "200"], ["0.35", "300"]], quoted));
  market.current.message(bookFrame(W1.conditionId, W1.noTokenId, [["0.65", "200"]], [["0.66", "200"]], quoted));
  for (let index = 0; index < 3; index += 1) await step(1_000);
  // Then a quote no exit sells into: the position is held, to resolution.
  const dead = gateway.clock.nowMs();
  market.current.message(bookFrame(W1.conditionId, W1.yesTokenId, [["0.1", "200"]], [["0.9", "200"]], dead));
  for (let index = 0; index < 2; index += 1) await step(1_000);
  // To 22:52: W1 closes (22:30) and passes its bound (22:35) with no resolution.
  while (gateway.clock.nowMs() < LATE_RESOLUTION_MS) await step(30_000);
  const beforeResolution = {
    admitted: gateway.publishedOfType("SeriesWindowAdmitted").map((envelope) => payloadOf(envelope)["internalMarketId"]),
    metrics: gateway.gateway.metrics().seriesAdmission,
  };
  // 22:52: W1's resolution arrives on the market channel, long after its bound.
  market.current.message(
    JSON.stringify([
      {
        event_type: "market_resolved",
        id: "5255913",
        market: W1.conditionId,
        assets_ids: [W1.yesTokenId, W1.noTokenId],
        winning_asset_id: W1.yesTokenId,
        winning_outcome: "Up",
        timestamp: String(gateway.clock.nowMs()),
      },
    ]),
  );
  await gateway.settle();
  for (let index = 0; index < 2; index += 1) await step(30_000);
  for (let index = 0; index < 3; index += 1) await step(1_000);
  await gateway.gateway.stop();
  return { published: gateway.published(), beforeResolution, metrics: gateway.gateway.metrics().seriesAdmission, requests: stub.requests };
}

function noticeLine(notice: AdmissionNotice): string {
  switch (notice.kind) {
    case "ADMITTED":
      return `ADMITTED ${notice.window.marketId}`;
    case "REFUSED":
      return `REFUSED ${notice.code} ${notice.marketId ?? "-"}`;
    case "TORN_DOWN":
      return `TORN_DOWN ${notice.window.marketId} ${notice.reason}`;
    case "HELD_UNRESOLVED":
      return `HELD_UNRESOLVED ${notice.window.marketId}`;
  }
}

describe("ROLLOVER-1 r2 (R2-ASTRA-01, R2-ASTRA-02): gateway to trader, a held window's late resolution", () => {
  it("a position held past the bound keeps its window's cap slot on both sides, its late resolution is still delivered and handled, and only then does the series move on", async () => {
    const { published, beforeResolution, metrics, requests } = await gatewayRun();

    // The gateway: W1 alone until its resolution; never abandoned; W2 never admitted.
    expect(beforeResolution.admitted).toEqual([W1.marketId]);
    expect(beforeResolution.metrics).toMatchObject({ windowsAwaitingResolution: 1, windowsRetiredResolved: 0, liveWindows: 1 });
    expect(requests.some((url) => url.includes(`/clob-markets/${W2.conditionId}`))).toBe(false);
    const incidents = published
      .filter((envelope) => envelope.eventType === "DataQualityIncidentOpened")
      .map((envelope) => `${String(payloadOf(envelope)["reasonCode"])} ${JSON.stringify(payloadOf(envelope)["affectedMarketIds"])}`);
    expect(incidents).toContain(`GATEWAY_SERIES_WINDOW_UNRESOLVED ${JSON.stringify([W1.marketId])}`);
    expect(incidents.some((line) => line.startsWith("GATEWAY_SERIES_CAP_REACHED "))).toBe(true);
    expect(incidents.some((line) => line.startsWith("GATEWAY_SERIES_WINDOW_RESOLUTION_ABANDONED"))).toBe(false);
    const resolved = published.filter((envelope) => envelope.eventType === "MarketResolved");
    expect(resolved.map((envelope) => payloadOf(envelope)["internalMarketId"])).toEqual([W1.marketId]);
    expect(Date.parse(String(resolved[0]?.receivedAt))).toBeGreaterThanOrEqual(LATE_RESOLUTION_MS);
    expect(
      published.filter((envelope) => envelope.eventType === "SeriesWindowAdmitted").map((envelope) => payloadOf(envelope)["internalMarketId"]),
    ).toEqual([W1.marketId, W3.marketId]);
    expect(metrics).toMatchObject({ windowsAwaitingResolution: 0, windowsRetiredResolved: 1, liveWindows: 1 });

    // The trader, fed exactly what the gateway published.
    const notices: AdmissionNotice[] = [];
    const live: number[] = [];
    const run = assembleOrThrow({
      config: traderConfig(),
      idNamespace: "rollover-1-r2",
      onAdmission: (notice) => {
        notices.push(notice);
        live.push(run.trader.loop.admissionMetrics()?.live ?? -1);
      },
    });
    for (const event of ingestedOf(published)) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    expect(run.trader.loop.health().halts).toEqual([]);
    expect(run.parts.venue.fills.map((fill) => `${fill.marketId === W1.marketId ? "W1" : fill.marketId} ${fill.action} ${fill.shares}@${fill.price}`)).toEqual([
      "W1 BUY 50@0.34",
    ]);
    expect(notices.map(noticeLine)).toEqual([
      `ADMITTED ${W1.marketId}`,
      `HELD_UNRESOLVED ${W1.marketId}`,
      `TORN_DOWN ${W1.marketId} RESOLVED`,
      `ADMITTED ${W3.marketId}`,
    ]);
    expect(live.every((count) => count <= 1)).toBe(true);
    // W1's late resolution reached W1's own strategy before its teardown.
    const callbacks = run.parts.store.decisions.filter((entry) => entry.record.marketId === W1.marketId).map((entry) => entry.record.callback);
    expect(callbacks).toContain("onMarketResolved");
    expect(run.trader.markets.has(W1.marketId)).toBe(false);
    expect(run.trader.loop.admissionMetrics()).toMatchObject({ admitted: 2, tornDownResolved: 1, heldUnresolved: 0, live: 1, refusals: {} });
  });
});
