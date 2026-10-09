/**
 * `CADENCE-1`, work-plan acceptance 12: live and backtest share ONE code path
 * for the evaluation cadence (ADR-026; ADR-022).
 *
 * The cadence lives in one place, the core loop (`packages/trading-core`
 * `cadence.ts`, driven by `CoreLoop`), and both composition roots reach it
 * through the same `createPaperTrader`:
 *
 * - the LIVE root (`apps/trader` `assembleDurableTrader`): the core's venue
 *   builder, `createPaperTrader` with the PAPER cadence its registration check
 *   verified in the run row — reproduced here exactly, but over the core's
 *   in-memory store instead of PostgreSQL;
 * - the BACKTEST root (`assembleBacktestCore`): the same builder, the same
 *   `createPaperTrader`, the cadence from the run pins.
 *
 * Fed the SAME envelopes — Static Bracket's own fixture, compressed so that
 * frames arrive 100-300 ms apart and the cadence coalesces — the two cores
 * decide byte-identically and count the same coalescences. NO DOCKER, NO
 * NETWORK, NO CREDENTIAL.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { ReplayRunPins } from "@polymarket-bot/simulation";
import {
  CoreLoop,
  InMemoryTraderStore,
  PAPER_EVALUATION_CADENCE,
  buildSimulatedVenue,
  createPaperTrader,
  parseTraderConfig,
  type IngestedEvent,
  type PaperTrader,
} from "@polymarket-bot/trading-core";
import { ManualClock } from "@polymarket-bot/trading-core/testing";
import { describe, expect, it } from "vitest";

import { assembleBacktestCore } from "./assembly.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "replay-golden", "backtest", "static-bracket");
const CONFIG = JSON.parse(readFileSync(join(FIXTURE, "trader-config.json"), "utf8")) as Record<string, unknown>;
const PINS = JSON.parse(readFileSync(join(FIXTURE, "run-pins.json"), "utf8")) as ReplayRunPins;
const FRAMES = JSON.parse(readFileSync(join(FIXTURE, "frames.json"), "utf8")) as {
  readonly gatewayEpoch: string;
  readonly frames: readonly {
    readonly source: string;
    readonly connectionId: string;
    readonly envelope: { readonly eventType: string; readonly schemaVersion: number; readonly sourceChannel: string; readonly payload: Record<string, unknown> };
  }[];
};
const START = "2026-05-01T08:59:58.000Z";
const ENVIRONMENT = {
  MAX_RUN_MODE: "PAPER",
  ALLOW_REAL_ORDERS: "false",
  LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
  LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
} as const;
const ID_NAMESPACE = "cadence-1-one-code-path";

/**
 * The fixture's eight frames, re-stamped 100-300 ms apart, with extra book
 * changes and reference trades between them: a stream the PAPER cadence
 * coalesces. Every envelope is its own frame (no causationId), as a live
 * gateway's lone events are.
 */
function envelopes(): IngestedEvent[] {
  const list: IngestedEvent[] = [];
  let at = Date.parse(START);
  let seq = 0;
  const push = (frame: (typeof FRAMES.frames)[number], stepMs: number): void => {
    seq += 1;
    at += stepMs;
    const receivedAt = new Date(at).toISOString();
    const envelope: EventEnvelope<unknown> = {
      eventId: `019b1e00-0000-7000-9000-${String(seq).padStart(12, "0")}`,
      eventType: frame.envelope.eventType,
      schemaVersion: frame.envelope.schemaVersion,
      source: frame.source as EventEnvelope<unknown>["source"],
      sourceChannel: frame.envelope.sourceChannel,
      receivedAt,
      receivedMonotonicNs: String(seq * 1_000_000),
      gatewayEpoch: FRAMES.gatewayEpoch,
      ingestSeq: String(seq),
      connectionId: frame.connectionId,
      subscriptionGeneration: 1,
      payload: frame.envelope.payload,
    };
    list.push({ envelope, identity: { gatewayEpoch: FRAMES.gatewayEpoch, ingestSeq: String(seq), receivedAt, datasetRowOrdinal: seq } });
  };
  const frames = FRAMES.frames;
  // The opening (two reference trades, the open, both books) 100-200 ms apart.
  for (const [index, frame] of frames.slice(0, 5).entries()) push(frame, index === 0 ? 0 : 150);
  // Then, for four seconds, the level change and a reference trade, alternating every 120-280 ms.
  const level = frames[5];
  const reference = frames[0];
  if (level === undefined || reference === undefined) throw new Error("the fixture changed");
  for (let step = 0; step < 24; step += 1) push(step % 3 === 2 ? reference : level, 120 + ((step * 53) % 160));
  // The late snapshot and the closing, as the fixture ends.
  for (const frame of frames.slice(6)) push(frame, 250);
  return list;
}

/** `assembleDurableTrader`'s composition, but over the in-memory store (no registration check). */
function liveCore(): { readonly trader: PaperTrader; readonly store: InMemoryTraderStore } {
  const parsed = parseTraderConfig(CONFIG);
  if (!parsed.ok) throw new Error(parsed.refusal.detail);
  const clock = new ManualClock(START);
  const built = buildSimulatedVenue({ clock, settings: parsed.config.simulation, startingCash: parsed.config.accounting.startingCash });
  if (!built.ok) throw new Error(built.refusal.message);
  const store = new InMemoryTraderStore();
  const created = createPaperTrader({
    env: ENVIRONMENT,
    config: CONFIG,
    clock,
    venue: built.venue,
    store,
    idNamespace: ID_NAMESPACE,
    evaluationCadence: PAPER_EVALUATION_CADENCE,
  });
  if (!created.ok) throw new Error(created.refusal.detail);
  built.wiring.trader = created.trader;
  return { trader: created.trader, store };
}

function backtestCore(): { readonly trader: PaperTrader; readonly store: InMemoryTraderStore } {
  const assembled = assembleBacktestCore({
    environment: ENVIRONMENT,
    traderConfig: CONFIG,
    runPins: { ...PINS, evaluationIntervalMs: 1000, evaluationHeartbeatMs: 5000 },
    clockStart: { receivedAt: START, receivedMonotonicNs: "0" },
    idNamespace: ID_NAMESPACE,
  });
  if (!assembled.ok) throw new Error(`${assembled.refusal.code}: ${assembled.refusal.detail}`);
  return { trader: assembled.core.trader, store: assembled.core.store };
}

/** Each envelope is its own frame: one drain each, as the live pump and the replay driver hand them. */
async function drive(trader: PaperTrader): Promise<void> {
  for (const event of envelopes()) {
    expect(trader.loop.ingest(event)).toBe(true);
    await trader.loop.drain();
  }
}

describe("CADENCE-1 acceptance 12: live and backtest share one code path", () => {
  it("both roots build the core's own CoreLoop, through createPaperTrader, at the PAPER cadence", () => {
    const live = liveCore();
    const backtest = backtestCore();
    expect(live.trader.loop).toBeInstanceOf(CoreLoop);
    expect(backtest.trader.loop).toBeInstanceOf(CoreLoop);
    expect(Object.getPrototypeOf(backtest.trader.loop)).toBe(Object.getPrototypeOf(live.trader.loop));
    expect(backtest.trader.loop.evaluationCadence()).toEqual(live.trader.loop.evaluationCadence());
    expect(live.trader.loop.evaluationCadence()).toEqual({ intervalMs: 1000, heartbeatMs: 5000 });
  });

  it("the same envelopes give byte-identical decisions and the same coalescences in both", async () => {
    const live = liveCore();
    const backtest = backtestCore();
    await drive(live.trader);
    await drive(backtest.trader);
    const record = (store: InMemoryTraderStore) => JSON.stringify(store.decisions.map((entry) => entry.record));
    expect(record(backtest.store)).toBe(record(live.store));
    expect(backtest.trader.loop.health().loop).toEqual(live.trader.loop.health().loop);
    // Non-vacuous: the cadence did coalesce, and Static Bracket did decide.
    expect(live.trader.loop.health().loop.evaluationsCoalesced).toBeGreaterThan(10);
    expect(live.store.decisions.length).toBeGreaterThan(2);
    expect(live.trader.halts.records()).toEqual([]);
  });
});
