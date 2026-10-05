/**
 * `ROLLOVER-1` support: one PAPER run's gateway stream over three windows of
 * the `btc-15m-updown` series, and the series-bound trader configuration that
 * consumes it.
 *
 * The REAL gateway composition runs on the data-gateway suite's harness with
 * VENUE-SETL-1's recorded Gamma keyset page and CLOB market-info bodies
 * (`test/contract/polymarket-public/fixtures/series-window.json`) on its HTTP
 * port, and a scripted market socket:
 *
 * - 22:29:00Z — W1 (22:15-22:30) and W2 (22:30-22:45) are admitted; W1 is
 *   quoted ABOVE the Static Bracket's entry trigger (it holds);
 * - to 22:30:10Z — W2 opens (the lifecycle feed's `MarketOpened`); W3
 *   (22:45-23:00) comes due but the cap of 2 holds it;
 * - W2 is quoted UNDER the trigger: it arms, then enters;
 * - W1 resolves on the market channel; the next admission cycle tears it down
 *   and admits W3.
 *
 * The stream is generated ONCE per file and shared: every consumer receives
 * the identical recorded envelopes.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import type { IngestedEvent } from "@polymarket-bot/trader";
import { RECORDED_SERIES_WINDOWS, reviewedSeriesDocument } from "@polymarket-bot/trader/testing";

import { binanceTradeFrame, buildHarness, polymarketRestBook } from "../../data-gateway/support/harness.js";
import { traderConfig } from "./fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../../contract/polymarket-public/fixtures/series-window.json"), "utf8"),
) as { readonly examples: readonly { readonly payload: unknown }[] };
const [KEYSET_PAGE, CLOB_2215, CLOB_2230] = fixture.examples.map((example) => example.payload) as [
  { events: Record<string, unknown>[] },
  Record<string, unknown>,
  Record<string, unknown>,
];

export const [W1, W2, W3] = RECORDED_SERIES_WINDOWS;
export const GAMMA_BASE = "http://gamma.stub";
export const CLOB_BASE = "http://clob.stub";
/** 22:29:00Z: the 22:15 window is about to close; the 22:30 window opens in a minute. */
export const START_MS = Date.UTC(2026, 9, 4, 22, 29, 0);
export const SERIES_INSTANCE_ID = "c18f4a7e-1111-7abc-8def-0123456789ab";
export const SERIES_RUN_ID = "018f4a7e-1212-7abc-8def-0123456789ab";

/**
 * The review both sides hold. Sample configuration: the settlement binding is
 * allowed here so the run's entries are decided by the strategy (the shipped
 * sample says `false` until a human reviews the settlement, CLOSEOUT-2 N2).
 */
export function review(): Record<string, unknown> {
  return {
    ...reviewedSeriesDocument(),
    settlement: { specRef: "btc-15m-updown", modelDependentActivationAllowed: true },
  };
}

/** The CLOB info of the 22:45 window: S-K04a's shape with that window's own condition and tokens. */
const CLOB_2245 = {
  ...CLOB_2230,
  c: W3.conditionId,
  t: [
    { t: W3.yesTokenId, o: "Up" },
    { t: W3.noTokenId, o: "Down" },
  ],
};

const CONDITION_OF_TOKEN = new Map<string, string>(
  [W1, W2, W3].flatMap((window) => [
    [window.yesTokenId, window.conditionId],
    [window.noTokenId, window.conditionId],
  ]),
);

/** The stub venue of the series runs: the recorded keyset page, CLOB info for W1-W3, a ready Gamma market, books for any token. */
export function seriesVenue() {
  const requests: string[] = [];
  const clob: Readonly<Record<string, unknown>> = {
    [W1.conditionId]: CLOB_2215,
    [W2.conditionId]: CLOB_2230,
    [W3.conditionId]: CLOB_2245,
  };
  const route = (request: PublicHttpRequest): PublicHttpResponse => {
    requests.push(request.url);
    if (request.url.startsWith(`${GAMMA_BASE}/events/keyset`)) return { status: 200, body: JSON.stringify(KEYSET_PAGE) };
    if (request.url.startsWith(`${CLOB_BASE}/clob-markets/`)) {
      const body = clob[decodeURIComponent(request.url.slice(`${CLOB_BASE}/clob-markets/`.length))];
      return body === undefined ? { status: 404, body: "{}" } : { status: 200, body: JSON.stringify(body) };
    }
    if (request.url.startsWith(`${GAMMA_BASE}/markets/`)) {
      return { status: 200, body: JSON.stringify({ active: true, closed: false, archived: false, acceptingOrders: true }) };
    }
    if (request.url.includes("/books")) {
      const tokens = (request.jsonBody as readonly { token_id: string }[] | undefined) ?? [];
      return {
        status: 200,
        body: JSON.stringify(tokens.map((entry) => polymarketRestBook(entry.token_id, CONDITION_OF_TOKEN.get(entry.token_id) ?? "0x"))),
      };
    }
    return { status: 404, body: "{}" };
  };
  return { route, requests };
}

/** A market-channel `book` frame for one token (the documented shape). */
export function bookFrame(
  conditionId: string,
  tokenId: string,
  bids: readonly (readonly [string, string])[],
  asks: readonly (readonly [string, string])[],
  atMs: number,
): string {
  return JSON.stringify([
    {
      event_type: "book",
      market: conditionId,
      asset_id: tokenId,
      bids: bids.map(([price, size]) => ({ price, size })),
      asks: asks.map(([price, size]) => ({ price, size })),
      hash: `hash-${tokenId}-${String(atMs)}`,
      timestamp: String(atMs),
    },
  ]);
}

/** The gateway configuration of the series runs: the market, reference, lifecycle and admission feeds over `series`. */
export function seriesGatewayConfig(series: Record<string, unknown> = review()): Record<string, unknown> {
  return {
    markets: [],
    polymarket: { feedId: "polymarket-market", customFeatureEnabled: true, snapshotBaseUrl: CLOB_BASE },
    binance: { feedId: "binance-reference", symbols: ["BTCUSDT"], stalenessThresholdMs: 3_600_000 },
    lifecycle: { feedId: "polymarket-lifecycle", baseUrl: GAMMA_BASE, pollIntervalMs: 10_000 },
    seriesAdmission: {
      gammaBaseUrl: GAMMA_BASE,
      clobBaseUrl: CLOB_BASE,
      pollIntervalMs: 30_000,
      maximumPages: 1,
      admissionLeadSeconds: 900,
      series: [series],
    },
  };
}

/** Runs the gateway over the run's timeline and returns everything it published. */
async function gatewayStream(): Promise<readonly EventEnvelope<unknown>[]> {
  const stub = seriesVenue();
  const gateway = await buildHarness({ config: seriesGatewayConfig(), http: stub.route, clockStartMs: START_MS });
  let tradeId = 0;
  const trade = (): void => {
    tradeId += 1;
    gateway.binanceSockets.current.message(binanceTradeFrame("BTCUSDT", tradeId, gateway.clock.nowMs()));
  };
  const step = async (ms: number): Promise<void> => {
    gateway.timers.advance(ms);
    trade();
    await gateway.settle();
  };

  gateway.gateway.start();
  gateway.binanceSockets.current.open();
  gateway.polymarketSockets.current.open();
  trade();
  await gateway.settle();
  // 22:29: W1 and W2 are admitted (W3, 16 minutes ahead, is not yet due).
  // W1 is quoted ABOVE the entry trigger: it is evaluated, and holds.
  const at = gateway.clock.nowMs();
  gateway.polymarketSockets.current.message(bookFrame(W1.conditionId, W1.yesTokenId, [["0.58", "200"]], [["0.6", "200"]], at));
  gateway.polymarketSockets.current.message(bookFrame(W1.conditionId, W1.noTokenId, [["0.39", "200"]], [["0.41", "200"]], at));
  for (let index = 0; index < 3; index += 1) await step(1_000);
  // To 22:30:10: W2 opens (the lifecycle feed's MarketOpened); W3 comes due but
  // two windows are live, so it is held.
  for (let index = 0; index < 7; index += 1) await step(10_000);
  // W2 is quoted UNDER the trigger: it arms, then enters, on the run's cadence.
  const open = gateway.clock.nowMs();
  gateway.polymarketSockets.current.message(
    bookFrame(W2.conditionId, W2.yesTokenId, [["0.32", "200"], ["0.31", "300"]], [["0.34", "200"], ["0.35", "300"]], open),
  );
  gateway.polymarketSockets.current.message(bookFrame(W2.conditionId, W2.noTokenId, [["0.65", "200"]], [["0.66", "200"]], open));
  for (let index = 0; index < 3; index += 1) await step(1_000);
  // 22:30:13: W1 resolves on the market channel; the next admission cycle tears
  // it down and admits W3 in its place.
  gateway.polymarketSockets.current.message(
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
  for (let index = 0; index < 4; index += 1) await step(10_000);
  for (let index = 0; index < 3; index += 1) await step(1_000);
  await gateway.gateway.stop();
  const clobReads = stub.requests.filter((url) => url.includes("/clob-markets/")).length;
  if (clobReads !== 3) throw new Error(`the run's gateway read the CLOB ${String(clobReads)} times, not once per window`);
  return gateway.published();
}

let recorded: readonly EventEnvelope<unknown>[] | undefined;
/** The run's gateway stream, generated once and shared. */
export async function seriesStream(): Promise<readonly EventEnvelope<unknown>[]> {
  recorded ??= await gatewayStream();
  return recorded;
}

/** The series-bound trader configuration (no market, no market-bound instance). */
export function seriesConfig(series: Record<string, unknown> = review()): Record<string, unknown> {
  const base = traderConfig();
  const instance = (base["instances"] as Record<string, unknown>[])[0] ?? {};
  const rest = Object.fromEntries(Object.entries(instance).filter(([key]) => key !== "marketId"));
  return {
    ...base,
    markets: [],
    instances: [],
    series: [series],
    seriesInstances: [{ ...rest, instanceId: SERIES_INSTANCE_ID, runId: SERIES_RUN_ID, seriesId: "btc-15m-updown" }],
  };
}

/** The envelopes as the trader's feed hands them over, in order. */
export function ingestedOf(envelopes: readonly EventEnvelope<unknown>[]): readonly IngestedEvent[] {
  return envelopes.map((envelope, index) => ({
    envelope,
    identity: {
      gatewayEpoch: envelope.gatewayEpoch,
      ingestSeq: envelope.ingestSeq,
      receivedAt: envelope.receivedAt,
      datasetRowOrdinal: index + 1,
    },
  }));
}
