/**
 * `ROLLOVER-1` r5 (R5-ASTRA-01) — negative-risk membership is a MARKET-level
 * property (the official market-details page S-D23, lines 305 and 313-315),
 * end to end: the REAL gateway composition (the data-gateway suite's harness,
 * VENUE-SETL-1's recorded keyset page and CLOB bodies on its HTTP port) with
 * ONE change to the keyset response — W1's own `markets[0].negRisk` — and the
 * REAL trader composition consuming exactly what that gateway published.
 *
 * What is proven, by name:
 *
 * 1. **Control** — with the recorded flags (market and event both `false`, as
 *    reviewed), both due windows are admitted and each catalog row says
 *    `negRisk: false`, which is the market's own statement.
 * 2. **A market flag that is not the reviewed value never reaches the
 *    trader's catalog** — true under an event flag of `false`, `null`, absent,
 *    or not a boolean: the gateway refuses W1 (an incident names it and its
 *    `Market.negRisk`) and publishes no admission for it, so the trader writes
 *    no catalog row for W1 and attaches nothing; W2, unchanged, is admitted.
 *    Before r5 the gateway judged only the event's flag, so each of these W1s
 *    was admitted and cataloged with the REVIEWED `negRisk: false`.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import type { AdmissionNotice } from "@polymarket-bot/trader";
import { describe, expect, it } from "vitest";

import { buildHarness } from "../data-gateway/support/harness.js";
import { assembleOrThrow } from "./support/run.js";
import { GAMMA_BASE, ingestedOf, seriesConfig, seriesGatewayConfig, seriesVenue, START_MS, W1, W2 } from "./support/series-windows.js";

/** The gateway's stream at 22:29Z, with W1's market changed in every keyset response. */
async function gatewayPublished(
  mutateW1Market?: (market: Record<string, unknown>) => void,
): Promise<readonly EventEnvelope<unknown>[]> {
  const stub = seriesVenue();
  const route = (request: PublicHttpRequest): PublicHttpResponse => {
    const response = stub.route(request);
    if (mutateW1Market === undefined || !request.url.startsWith(`${GAMMA_BASE}/events/keyset`)) return response;
    const page = JSON.parse(response.body) as { events: Record<string, unknown>[] };
    for (const event of page.events) {
      const market = (event["markets"] as Record<string, unknown>[])[0];
      if (market !== undefined && market["conditionId"] === W1.conditionId) mutateW1Market(market);
    }
    return { ...response, body: JSON.stringify(page) };
  };
  const harness = await buildHarness({ config: seriesGatewayConfig(), http: route, clockStartMs: START_MS });
  harness.gateway.start();
  harness.polymarketSockets.current.open();
  await harness.settle();
  const published = harness.published();
  await harness.gateway.stop();
  return published;
}

async function trade(published: readonly EventEnvelope<unknown>[]) {
  const notices: AdmissionNotice[] = [];
  const run = assembleOrThrow({
    config: seriesConfig(),
    idNamespace: "rollover-1-r5-negrisk",
    onAdmission: (notice) => notices.push(notice),
  });
  for (const event of ingestedOf(published)) run.trader.loop.ingest(event);
  await run.trader.loop.drain();
  return { run, notices };
}

function admissionsOf(published: readonly EventEnvelope<unknown>[], marketId: string): readonly string[] {
  return published
    .filter((envelope) => ["MarketDiscovered", "TradingParametersChanged", "SeriesWindowAdmitted"].includes(envelope.eventType))
    .filter((envelope) => (envelope.payload as { internalMarketId?: string }).internalMarketId === marketId)
    .map((envelope) => envelope.eventType);
}

function refusalIncidents(published: readonly EventEnvelope<unknown>[]) {
  return published
    .filter((envelope) => envelope.eventType === "DataQualityIncidentOpened")
    .map((envelope) => envelope.payload as { reasonCode: string; detail?: string; affectedMarketIds?: readonly string[] })
    .filter((payload) => payload.reasonCode === "GATEWAY_SERIES_WINDOW_REFUSED");
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

describe("ROLLOVER-1 r5 (R5-ASTRA-01): a window whose MARKET-level negRisk is not the reviewed value never reaches the trader's catalog", () => {
  it("control: the recorded flags (market and event false, as reviewed) — W1 and W2 admitted, each row negRisk false", async () => {
    const published = await gatewayPublished();
    expect(admissionsOf(published, W1.marketId)).toEqual(["MarketDiscovered", "TradingParametersChanged", "SeriesWindowAdmitted"]);
    expect(refusalIncidents(published)).toEqual([]);
    const { run, notices } = await trade(published);
    expect(run.trader.loop.health().halts).toEqual([]);
    expect(notices.map(noticeLine)).toEqual([`ADMITTED ${W1.marketId}`, `ADMITTED ${W2.marketId}`]);
    expect(run.parts.store.admittedMarkets.map((market) => [market.marketId, market.negRisk])).toEqual([
      [W1.marketId, false],
      [W2.marketId, false],
    ]);
  });

  for (const [name, mutate, stated] of [
    ["true under an event flag of false", (market: Record<string, unknown>) => {
      market["negRisk"] = true;
    }, "true"],
    ["null", (market: Record<string, unknown>) => {
      market["negRisk"] = null;
    }, "null"],
    ["absent", (market: Record<string, unknown>) => {
      delete market["negRisk"];
    }, "absent"],
    ["not a boolean", (market: Record<string, unknown>) => {
      market["negRisk"] = "false";
    }, "unreadable"],
  ] as const) {
    it(`W1's market flag ${name}: the gateway refuses W1 and publishes no admission for it; the trader writes no catalog row for it and attaches nothing; W2 is admitted`, async () => {
      const published = await gatewayPublished(mutate);
      expect(admissionsOf(published, W1.marketId)).toEqual([]);
      const refused = refusalIncidents(published);
      expect(refused.map((payload) => payload.affectedMarketIds)).toEqual([[W1.marketId]]);
      expect(refused[0]?.detail).toContain(`Gamma Market.negRisk is ${stated}, not the reviewed false`);
      expect(admissionsOf(published, W2.marketId)).toEqual(["MarketDiscovered", "TradingParametersChanged", "SeriesWindowAdmitted"]);

      const { run, notices } = await trade(published);
      expect(run.trader.loop.health().halts).toEqual([]);
      expect(run.parts.store.admittedMarkets.find((market) => market.marketId === W1.marketId)).toBeUndefined();
      expect(run.parts.store.admittedMarkets.map((market) => [market.marketId, market.negRisk])).toEqual([[W2.marketId, false]]);
      expect(notices.map(noticeLine)).toEqual([`ADMITTED ${W2.marketId}`]);
      expect(run.trader.loop.admissionMetrics()).toMatchObject({ admitted: 1, live: 1 });
    });
  }
});
