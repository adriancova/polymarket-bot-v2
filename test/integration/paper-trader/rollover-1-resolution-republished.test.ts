/**
 * `ROLLOVER-1` r3 (R3-ASTRA-01) — a resolution that a publication halt
 * swallowed, end to end across a gateway restart: the REAL gateway
 * composition (on the data-gateway suite's harness, with VENUE-SETL-1's
 * recorded keyset page and CLOB bodies on its HTTP port), restarted on the same
 * WAL root, and the REAL trader composition root consuming exactly what both
 * gateway epochs published, in their order.
 *
 * With a reviewed cap of 1 and a bound of 300 s:
 *
 * 1. epoch 1 admits W1 (22:15-22:30) and the trader buys 50 at 0.34 in it,
 *    holding to resolution;
 * 2. at 22:32 the event bus goes down — publication halts for the epoch — and
 *    W1's `market_resolved` arrives: dispatched, NOT published. The gateway
 *    keeps W1 ADMITTED, attached and in its cap slot, with the resolution
 *    recorded as owed; it admits nothing in W1's place;
 * 3. epoch 2 (22:42) re-attaches W1 and re-publishes the recorded resolution;
 *    the trader's W1 strategy handles it, W1 is torn down `RESOLVED` on both
 *    sides, and the next open window, W2 (22:30-22:45), is admitted by the
 *    gateway and then by the trader.
 *
 * Under r2 the gateway retired W1 `RESOLVED` at dispatch in epoch 1 and
 * admitted W2 in its place (as an intent, published by epoch 2), while the
 * resolution reached no consumer: the trader kept W1 HELD and refused W2
 * `CAP_REACHED`, and every later window after it, for the rest of its run.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { AdmissionNotice } from "@polymarket-bot/trader";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { describe, expect, it } from "vitest";

import { binanceTradeFrame, buildHarness, type Harness } from "../data-gateway/support/harness.js";
import { assembleOrThrow } from "./support/run.js";
import { bookFrame, ingestedOf, review, seriesConfig, seriesGatewayConfig, seriesVenue, W1, W2 } from "./support/series-windows.js";

/** The review both sides hold: a cap of 1 and an unresolved bound of 300 s. */
const SERIES = { ...review(), maximumConcurrentWindows: 1, unresolvedTeardownSeconds: 300 };
/** Hold the position through the close, to its resolution (no protective exit before it). */
const HOLD_TO_RESOLUTION = { final_policy: "HOLD_TO_RESOLUTION", allow_resolution_hold: true, maximum_holding_seconds: 7200 } as const;
/** 22:16:00Z: inside W1; W2 (22:30) is due within the admission lead, but the cap of 1 holds it. */
const START_MS = Date.UTC(2026, 9, 4, 22, 16, 0);
/** 22:32:00Z: W1 closed at 22:30; its resolution arrives while publication is halted. */
const RESOLVED_MS = Date.UTC(2026, 9, 4, 22, 32, 0);
/** 22:42:00Z: the gateway's next epoch; W1's bound (22:35) has passed, W2 is open until 22:45. */
const RESTART_MS = Date.UTC(2026, 9, 4, 22, 42, 0);

function traderConfig(): Record<string, unknown> {
  const base = seriesConfig(SERIES);
  const instance = (base["seriesInstances"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  const params = instance["params"] as Record<string, unknown>;
  return { ...base, seriesInstances: [{ ...instance, params: { ...params, exit: { ...(params["exit"] as Record<string, unknown>), ...HOLD_TO_RESOLUTION } } }] };
}

function payloadOf(envelope: EventEnvelope<unknown>): Record<string, unknown> {
  return envelope.payload as Record<string, unknown>;
}

function ledgerRecord(harness: Harness, conditionId: string): Record<string, unknown> | undefined {
  const text = harness.walFileSystem.snapshot()["/wal/series-admission-ledger.json"];
  if (text === undefined) return undefined;
  return (JSON.parse(text) as { windows: Record<string, Record<string, unknown>> }).windows[conditionId];
}

/** One gateway step: `ms` of timers, one reference trade, settled. */
function stepper(gateway: Harness, start: number) {
  let tradeId = start;
  return async (ms: number): Promise<void> => {
    gateway.timers.advance(ms);
    tradeId += 1;
    gateway.binanceSockets.current.message(binanceTradeFrame("BTCUSDT", tradeId, gateway.clock.nowMs()));
    await gateway.settle();
  };
}

/** The two gateway epochs over the timeline above; everything each published. */
async function gatewayEpochs() {
  const walFileSystem = createMemoryFileSystem();
  const stub = seriesVenue();
  const first = await buildHarness({ config: seriesGatewayConfig(SERIES), http: stub.route, clockStartMs: START_MS, walFileSystem });
  const step = stepper(first, 0);
  const market = first.polymarketSockets;
  first.gateway.start();
  first.binanceSockets.current.open();
  market.current.open();
  await step(0);
  for (let index = 0; index < 3; index += 1) await step(10_000);
  // W1 is quoted UNDER the entry trigger: the bracket arms, then buys 50 at 0.34.
  const quoted = first.clock.nowMs();
  market.current.message(bookFrame(W1.conditionId, W1.yesTokenId, [["0.32", "200"], ["0.31", "300"]], [["0.34", "200"], ["0.35", "300"]], quoted));
  market.current.message(bookFrame(W1.conditionId, W1.noTokenId, [["0.65", "200"]], [["0.66", "200"]], quoted));
  for (let index = 0; index < 3; index += 1) await step(1_000);
  const dead = first.clock.nowMs();
  market.current.message(bookFrame(W1.conditionId, W1.yesTokenId, [["0.1", "200"]], [["0.9", "200"]], dead));
  for (let index = 0; index < 2; index += 1) await step(1_000);
  while (first.clock.nowMs() < RESOLVED_MS - 30_000) await step(30_000);
  // 22:32: the event bus goes down, then W1's resolution arrives.
  first.clock.advance(RESOLVED_MS - first.clock.nowMs());
  first.transport.setUnavailable(true);
  market.current.message(
    JSON.stringify([
      {
        event_type: "market_resolved",
        id: "5255913",
        market: W1.conditionId,
        assets_ids: [W1.yesTokenId, W1.noTokenId],
        winning_asset_id: W1.yesTokenId,
        winning_outcome: "Up",
        timestamp: String(RESOLVED_MS),
      },
    ]),
  );
  await first.settle();
  // Cycles to 22:41, past W1's bound, with publication halted.
  for (let index = 0; index < 18; index += 1) await step(30_000);
  const epoch1 = {
    published: first.published(),
    w1: ledgerRecord(first, W1.conditionId),
    w2: ledgerRecord(first, W2.conditionId),
    metrics: first.gateway.metrics().seriesAdmission,
  };
  await first.gateway.stop();

  // 22:42: the next epoch, on the same WAL root.
  const second = await buildHarness({ config: seriesGatewayConfig(SERIES), http: seriesVenue().route, clockStartMs: RESTART_MS, walFileSystem, idSeed: 1 });
  const step2 = stepper(second, 1_000);
  second.gateway.start();
  second.binanceSockets.current.open();
  second.polymarketSockets.current.open();
  await step2(0);
  for (let index = 0; index < 3; index += 1) await step2(30_000);
  for (let index = 0; index < 3; index += 1) await step2(1_000);
  const epoch2 = { published: second.published(), w1: ledgerRecord(second, W1.conditionId), metrics: second.gateway.metrics().seriesAdmission };
  await second.gateway.stop();
  return { epoch1, epoch2 };
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

describe("ROLLOVER-1 r3 (R3-ASTRA-01): gateway to trader, a resolution a publication halt swallowed", () => {
  it("the gateway keeps the window and its resolution until the resolution is PUBLISHED by its next epoch; the trader then handles it, and only then does the series move on, on both sides", async () => {
    const { epoch1, epoch2 } = await gatewayEpochs();

    // Epoch 1: W1's resolution was dispatched but never published; W1 stays, owed.
    const admitted1 = epoch1.published.filter((envelope) => envelope.eventType === "SeriesWindowAdmitted").map((envelope) => payloadOf(envelope)["internalMarketId"]);
    expect(admitted1).toEqual([W1.marketId]);
    expect(epoch1.published.filter((envelope) => envelope.eventType === "MarketResolved")).toEqual([]);
    expect(epoch1.w1?.["status"]).toBe("ADMITTED");
    expect((epoch1.w1?.["resolution"] as Record<string, unknown> | undefined)?.["publishedAt"]).toBeUndefined();
    // Nothing was admitted in W1's place, not even as an intent.
    expect(epoch1.w2).toBeUndefined();
    expect(epoch1.metrics).toMatchObject({ resolutionsUnpublished: 1, resolutionsOwed: 1, windowsRetiredResolved: 0, liveWindows: 1 });

    // Epoch 2: the resolution re-published, W1 retired RESOLVED, then W2 admitted.
    const resolved2 = epoch2.published.filter((envelope) => envelope.eventType === "MarketResolved");
    expect(resolved2.map((envelope) => payloadOf(envelope)["internalMarketId"])).toEqual([W1.marketId]);
    expect(epoch2.w1).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    const admitted2 = epoch2.published.filter((envelope) => envelope.eventType === "SeriesWindowAdmitted").map((envelope) => payloadOf(envelope)["internalMarketId"]);
    expect(admitted2).toEqual([W2.marketId]);
    const resolvedSeq = BigInt(resolved2[0]?.ingestSeq ?? "0");
    const w2Seq = BigInt(epoch2.published.find((envelope) => envelope.eventType === "SeriesWindowAdmitted")?.ingestSeq ?? "0");
    expect(w2Seq).toBeGreaterThan(resolvedSeq);
    expect(epoch2.metrics).toMatchObject({ resolutionsReplayed: 1, resolutionsUnpublished: 0, windowsRetiredResolved: 1, liveWindows: 1 });

    // The trader, fed exactly what both epochs published, in order.
    const notices: AdmissionNotice[] = [];
    const live: number[] = [];
    const run = assembleOrThrow({
      config: traderConfig(),
      idNamespace: "rollover-1-r3",
      onAdmission: (notice) => {
        notices.push(notice);
        live.push(run.trader.loop.admissionMetrics()?.live ?? -1);
      },
    });
    for (const event of ingestedOf([...epoch1.published, ...epoch2.published])) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    expect(run.trader.loop.health().halts).toEqual([]);
    expect(run.parts.venue.fills.map((fill) => `${fill.marketId === W1.marketId ? "W1" : fill.marketId} ${fill.action} ${fill.shares}@${fill.price}`)).toEqual([
      "W1 BUY 50@0.34",
    ]);
    expect(notices.map(noticeLine)).toEqual([
      `ADMITTED ${W1.marketId}`,
      `HELD_UNRESOLVED ${W1.marketId}`,
      `TORN_DOWN ${W1.marketId} RESOLVED`,
      `ADMITTED ${W2.marketId}`,
    ]);
    expect(live.every((count) => count <= 1)).toBe(true);
    // W1's resolution reached W1's own strategy, once, before its teardown.
    const resolutions = run.parts.store.decisions.filter((entry) => entry.record.marketId === W1.marketId && entry.record.callback === "onMarketResolved");
    expect(resolutions).toHaveLength(1);
    expect(run.trader.loop.admissionMetrics()).toMatchObject({ admitted: 2, tornDownResolved: 1, tornDownResolvedUnhandled: 0, heldUnresolved: 0, live: 1, refusals: {} });
  });
});
