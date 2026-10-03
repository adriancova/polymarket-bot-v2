/**
 * `APPROX-REPLAY-1` — the approximate run: the research-tier source driven
 * through the SHIPPED driver (`replayDrivenCoreLoop`) and the REAL shared core
 * (`assembleBacktestCore`, the exact `run` command's own assembly).
 *
 * Pinned here:
 *
 * - the replay clock is positioned at every sample: at each ingest the clock
 *   reads the envelope's own `receivedAt` (the release frame's receipt
 *   instant), so ADR-031's process lag reads 0 (R7);
 * - acceptance 1 through the core: the frame released at ingestSeq 1 (10,000
 *   ms) is evaluated before the frame released at ingestSeq 2 (9,999 ms);
 * - acceptance 2 through the driver: the [9,000, 10,000) bar F1 released is
 *   delivered at F1 holding F0 alone, and F2's price arrives only with the bar
 *   released at F3;
 * - the Static Bracket scenario of `test/replay-golden/backtest/static-bracket/`,
 *   restated as research-tier samples, drives the real core to an entry and a
 *   fill, byte-identically across two runs (ADR-029 Decision 6: repeatable,
 *   not evidence);
 * - r1 (APPROX-R1-H1): a line the core's venue logs during an approximate run
 *   reaches the caller's log labelled, as one physical line.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL. NO SIGNER. Every file written is
 * under a fresh temporary directory; the committed fixture is read only.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createReplayClock, type EventEnvelope } from "@polymarket-bot/simulation";
import { fileSystemObjectStore } from "@polymarket-bot/storage-parquet";
import { afterAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../archive.js";
import { recordFraming, replayDrivenCoreLoop, type ReplayDrivenLoop, type ReplayIngestedEvent } from "../core-loop.js";
import { readResearchTierReplaySource } from "./research-source.js";
import { deliverReleaseFrames, derivedMonotonicNs, runApproximateBacktest, type ApproximateRun } from "./run.js";
import { renderApproximateArtifact, serializeApproximateRun } from "./serialize.js";
import { APPROXIMATE_TRANSLATION_VERSION, ResearchSampleTranslator, deriveApproximateEventId } from "./translate.js";
import { EPOCH, bar, depth, gammaPoll, trade, writeResearchDataset, type FixtureSample } from "./test-support.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "test", "replay-golden", "backtest", "static-bracket");
const CONFIG: Record<string, unknown> = JSON.parse(readFileSync(join(FIXTURE, "trader-config.json"), "utf8")) as Record<string, unknown>;
const PINS: Record<string, unknown> = {
  ...(JSON.parse(readFileSync(join(FIXTURE, "run-pins.json"), "utf8")) as Record<string, unknown>),
  normalizerVersion: APPROXIMATE_TRANSLATION_VERSION,
};
const MARKET_ID = "019b1e00-0000-7000-8000-000000000001";
const C = "0xbacktest1condition";
const GAMMA = new Map([[MARKET_ID, "777"]]);
const T0 = Date.UTC(2026, 4, 1, 9, 0, 0);

const scratch = mkdtempSync(join(tmpdir(), "approx-replay-run-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
let counter = 0;
function freshRoot(): string {
  counter += 1;
  return join(scratch, `store-${String(counter)}`);
}

const r = (ordinal: number, seq: string, atMs: number) => ({ ordinal, seq, atMs });

/** The Static Bracket scenario, as research-tier samples (dense ordinals, v1 order). */
function scenario(): FixtureSample[] {
  const samples: FixtureSample[] = [];
  let ordinal = 0;
  const next = () => ordinal++;
  const yesBids = [["0.32", "200"], ["0.31", "300"]] as const;
  samples.push(bar(r(next(), "1", T0 - 2_000), { spanStartMs: T0 - 3_000, close: "64000", volume: "0.5" }));
  samples.push(bar(r(next(), "2", T0 - 1_000), { spanStartMs: T0 - 2_000, close: "64100", volume: "0.25" }));
  samples.push(bar(r(next(), "3", T0), { spanStartMs: T0 - 1_000, close: "64100", volume: "0.1" }));
  samples.push(gammaPoll(r(next(), "3", T0), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true }));
  samples.push(depth(r(next(), "4", T0 + 1_000), { spanStartMs: T0, conditionId: C, tokenId: "9101", bids: yesBids, asks: [["0.34", "30"], ["0.35", "40"]] }));
  samples.push(depth(r(next(), "4", T0 + 1_000), { spanStartMs: T0, conditionId: C, tokenId: "9102", bids: [["0.65", "200"]], asks: [["0.66", "200"]] }));
  samples.push(bar(r(next(), "4", T0 + 1_000), { spanStartMs: T0, close: "64150", volume: "0.1" }));
  samples.push(
    depth(r(next(), "5", T0 + 2_000), { spanStartMs: T0 + 1_000, conditionId: C, tokenId: "9101", bids: [["0.32", "200"], ["0.31", "250"]], asks: [["0.34", "30"], ["0.35", "40"]] }),
  );
  samples.push(bar(r(next(), "5", T0 + 2_000), { spanStartMs: T0 + 1_000, close: "64160", volume: "0.1" }));
  samples.push(depth(r(next(), "6", T0 + 890_000), { spanStartMs: T0 + 889_000, conditionId: C, tokenId: "9101", bids: yesBids, asks: [["0.36", "40"]] }));
  samples.push(depth(r(next(), "6", T0 + 890_000), { spanStartMs: T0 + 889_000, conditionId: C, tokenId: "9102", bids: [["0.64", "200"]], asks: [["0.66", "200"]] }));
  samples.push(bar(r(next(), "6", T0 + 890_000), { spanStartMs: T0 + 889_000, close: "64200", volume: "0.1" }));
  samples.push(bar(r(next(), "7", T0 + 900_500), { spanStartMs: T0 + 899_000, close: "64250", volume: "0.1" }));
  return samples;
}

async function approximateRun(root: string, keys: readonly string[], overrides: { readonly config?: unknown } = {}): Promise<ApproximateRun> {
  const started = await runApproximateBacktest({
    environment: {},
    traderConfig: overrides.config ?? CONFIG,
    runPins: PINS,
    objectStore: fileSystemObjectStore(root),
    manifestObjectKeys: keys,
    gammaMarketIds: GAMMA,
    idNamespace: "approx-replay-1-test",
  });
  if (!started.ok) throw new Error(`refused: ${started.refusal.code}: ${started.refusal.detail}`);
  return started.run;
}

describe("the replay clock is positioned at every sample (ADR-031 R7)", () => {
  it("at every ingest the clock reads the envelope's own receivedAt and the frame's derived monotonic reading; one drain per release frame", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({ root, datasetId: "clock", samples: scenario() });
    const read = await readResearchTierReplaySource({ objectStore: fileSystemObjectStore(root), manifestObjectKeys: [written.manifestObjectKey], digestSha256: sha256Hex });
    if (!read.ok) throw new Error(read.refusal.detail);
    const frames = read.source.releaseFrames;
    const monotonic = derivedMonotonicNs(frames);
    const first = frames[0];
    if (first === undefined) throw new Error("no frame");
    const clock = createReplayClock({ receivedAt: first.availableAt, receivedMonotonicNs: monotonic[0] ?? "0" });
    if (!clock.ok) throw new Error("clock");
    const seen: { readonly now: string; readonly ns: bigint; readonly envelope: EventEnvelope<unknown> }[] = [];
    let drains = 0;
    const loop: ReplayDrivenLoop = {
      ingest(event: ReplayIngestedEvent): boolean {
        seen.push({ now: clock.value.now(), ns: clock.value.monotonicNs(), envelope: event.envelope });
        return true;
      },
      async drain(): Promise<void> {
        await Promise.resolve();
        drains += 1;
      },
      checkAccountingRebuild: () => undefined,
    };
    const framing = recordFraming();
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value, framing });
    const observed: string[] = [];
    const outcome = await deliverReleaseFrames({
      frames,
      monotonic,
      translator: new ResearchSampleTranslator({
        markets: [
          { marketId: MARKET_ID, conditionId: C, yesTokenId: "9101", noTokenId: "9102", openTime: "2026-05-01T09:00:00.000Z", closeTime: "2026-05-01T09:15:00.000Z", gammaMarketId: "777" },
        ],
        digestSha256: sha256Hex,
      }),
      framing,
      coreLoop: driver.coreLoop,
      venue: {
        observe: (identity) => {
          observed.push(identity.ingestSeq);
          return { ok: true, value: null };
        },
      },
    });
    expect(outcome.stop).toBeUndefined();
    expect(seen.length).toBe(outcome.envelopesDelivered);
    expect(seen.length).toBeGreaterThan(8);
    for (const entry of seen) {
      expect(entry.now).toBe(entry.envelope.receivedAt);
      expect(entry.ns.toString()).toBe(entry.envelope.receivedMonotonicNs);
    }
    // The lag the core would measure: process instant minus event instant.
    expect(seen.every((entry) => Date.parse(entry.now) - Date.parse(entry.envelope.receivedAt) === 0)).toBe(true);
    expect(drains).toBe(outcome.releaseFramesDelivered);
    expect(observed).toEqual(seen.map((entry) => entry.envelope.ingestSeq));
  });

  it("derives a non-decreasing monotonic reading from receipt instants that step backwards", () => {
    const frame = (seq: string, atMs: number) => ({
      releaseOrdinal: 0,
      gatewayEpoch: EPOCH,
      releaseIngestSeq: seq,
      availableAt: new Date(atMs).toISOString(),
      availableAtEpochMs: atMs,
      releaseSegmentId: "s",
      samples: [],
    });
    expect(derivedMonotonicNs([frame("1", 10_000), frame("2", 9_999), frame("3", 10_500)])).toEqual([
      "10000000000",
      "10000000000",
      "10500000000",
    ]);
  });
});

describe("acceptance 1 through the real core: release order, not instant order", () => {
  it("the frame released at ingestSeq 1 (10,000 ms) is evaluated before the frame released at ingestSeq 2 (9,999 ms)", async () => {
    const root = freshRoot();
    const base = T0 + 60_000;
    // F1 (ingestSeq 1, 10,000 ms) releases books, a bar and the market's open; F2
    // (ingestSeq 2, 9,999 ms) carries a trade. Sorting by instant would evaluate F2 first.
    const at1 = base + 10_000;
    const at2 = base + 9_999;
    const samples: FixtureSample[] = [
      depth(r(0, "1", at1), { spanStartMs: base + 9_000, conditionId: C, tokenId: "9101", bids: [["0.32", "200"]], asks: [["0.4", "30"]] }),
      depth(r(1, "1", at1), { spanStartMs: base + 9_000, conditionId: C, tokenId: "9102", bids: [["0.59", "200"]], asks: [["0.66", "200"]] }),
      bar(r(2, "1", at1), { spanStartMs: base + 9_000, close: "64000" }),
      gammaPoll(r(3, "1", at1), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true }),
      trade(r(4, "2", at2), { conditionId: C, tokenId: "9101", price: "0.4", size: "10" }),
    ];
    const written = await writeResearchDataset({ root, datasetId: "core-order", samples });
    const run = await approximateRun(root, [written.manifestObjectKey]);
    if (!run.outcome.ok) throw new Error(run.outcome.refusal.message);
    const id = (seq: string, atMs: number, index: number) =>
      deriveApproximateEventId(sha256Hex, { gatewayEpoch: EPOCH, releaseIngestSeq: seq, epochMs: atMs, index });
    // F1 was evaluated (its open and its books), as one frame: one drain each.
    const frameOne = new Set([0, 1, 2, 3].map((index) => id("1", at1, index)));
    const decisions = run.core.trader.loop.decisions();
    expect(decisions.map((decision) => decision.callback)).toContain("onMarketOpen");
    expect(decisions.every((decision) => frameOne.has(decision.sourceEventId))).toBe(true);
    expect(run.driver).toEqual({ eventsIngested: 5, drains: 2 });
    // The core's clock followed release order: F1's 10,000 ms, THEN F2's 9,999 ms — one wall-clock
    // step back, ending at F2. Ordered by instant, it would have ended at F1 with no step back.
    expect(run.outcome.result.clock.wallClockRegressions).toBe(1);
    expect(run.outcome.result.clock.currentAt).toBe(new Date(at2).toISOString());
    expect(run.outcome.result.clock.startedAt).toBe(new Date(at1).toISOString());
    // F2's trade reached the core after F1 and, its instant being earlier than the core's last
    // snapshot, produced no feature snapshot (the core's own rule, live and replay alike).
    expect(run.core.trader.loop.health().loop.snapshotsUnavailable).toBe(1);
    expect(decisions.some((decision) => decision.sourceEventId === id("2", at2, 0))).toBe(false);
    await run.core.store.close();
  });
});

describe("acceptance 2 through the shipped driver: a span sample holds only frames dispatched before its release", () => {
  it("delivers F1's [9,000, 10,000) bar at F1 with F0's price alone; F2's price arrives only with the bar released at F3", async () => {
    // F0 (seq 0 in the example's terms: before F1) traded at 100; F1 (ingestSeq 1, 10,000 ms) at 101;
    // F2 (ingestSeq 2, 9,999 ms, dispatched after F1) at 102; F3 (ingestSeq 3, 11,000 ms) releases [10,000, 11,000).
    const base = T0 + 120_000;
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "core-membership",
      samples: [
        bar(r(0, "1", base + 10_000), { spanStartMs: base + 9_000, close: "100", tradeCount: 1, volume: "1" }),
        trade(r(1, "2", base + 9_999), { conditionId: C, tokenId: "9101", price: "0.5", size: "1" }),
        bar(r(2, "3", base + 11_000), { spanStartMs: base + 10_000, open: "101", close: "102", tradeCount: 2, volume: "2" }),
      ],
    });
    const read = await readResearchTierReplaySource({ objectStore: fileSystemObjectStore(root), manifestObjectKeys: [written.manifestObjectKey], digestSha256: sha256Hex });
    if (!read.ok) throw new Error(read.refusal.detail);
    const delivered: { readonly seq: string; readonly type: string; readonly price: unknown }[] = [];
    const monotonic = derivedMonotonicNs(read.source.releaseFrames);
    const outcome = await deliverReleaseFrames({
      frames: read.source.releaseFrames,
      monotonic,
      translator: new ResearchSampleTranslator({
        markets: [
          { marketId: MARKET_ID, conditionId: C, yesTokenId: "9101", noTokenId: "9102", openTime: "2026-05-01T09:00:00.000Z", closeTime: "2026-05-01T09:15:00.000Z", gammaMarketId: "777" },
        ],
        digestSha256: sha256Hex,
      }),
      framing: recordFraming(),
      coreLoop: (context) => {
        delivered.push({ seq: context.envelope.ingestSeq, type: context.envelope.eventType, price: (context.envelope.payload as { price?: unknown }).price });
        return { ok: true, value: null };
      },
      venue: { observe: () => ({ ok: true, value: null }) },
    });
    expect(outcome.stop).toBeUndefined();
    expect(delivered).toEqual([
      { seq: "1", type: "ReferenceTradeObserved", price: "100" },
      { seq: "2", type: "PublicTradeObserved", price: "0.5" },
      { seq: "3", type: "ReferenceTradeObserved", price: "102" },
    ]);
    // Nothing released at or before F2 carries F2's reference price.
    expect(delivered.filter((entry) => BigInt(entry.seq) <= 2n).some((entry) => entry.price === "102")).toBe(false);
  });
});

describe("the Static Bracket scenario as research-tier samples, through the real core", () => {
  it("opens the market from the Gamma poll, enters, fills, closes on schedule — and is byte-identical across two runs", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({ root, datasetId: "static-bracket", samples: scenario() });
    const one = await approximateRun(root, [written.manifestObjectKey]);
    const two = await approximateRun(root, [written.manifestObjectKey]);
    if (!one.outcome.ok || !two.outcome.ok) throw new Error("stopped");
    const decisions = one.core.trader.loop.decisions();
    expect(decisions.some((decision) => decision.decisionType === "enter")).toBe(true);
    expect(decisions.some((decision) => decision.callback === "onMarketClosing")).toBe(true);
    expect(one.outcome.result.fills.length).toBeGreaterThan(0);
    expect(one.outcome.result.lifecycles[0]).toMatchObject({ phase: "OPEN", openedAtFrame: "3", scheduledClosingAtFrame: "7" });
    expect(one.outcome.result.fills.every((fill) => fill.evidenceClass === "SIMULATED_NOT_REAL_EVIDENCE")).toBe(true);

    const render = (run: ApproximateRun) => {
      if (!run.outcome.ok) throw new Error("stopped");
      const artifact = renderApproximateArtifact({ result: run.outcome.result, trader: run.core.trader, store: run.core.store, driver: run.driver });
      if (!artifact.ok) throw new Error(artifact.problem);
      return { artifact: artifact.text, serialization: serializeApproximateRun(run.outcome.result) };
    };
    expect(render(one)).toEqual(render(two));
    await one.core.store.close();
    await two.core.store.close();
  });
});

describe("r1, APPROX-R1-H1: the core's venue log is an approximate output too", () => {
  it("a line the venue's policy logs reaches the run's log labelled with the manifest's fidelity, as one physical line", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({ root, datasetId: "venue-log", samples: scenario() });
    const logged: string[] = [];
    const started = await runApproximateBacktest({
      environment: {},
      traderConfig: CONFIG,
      runPins: PINS,
      objectStore: fileSystemObjectStore(root),
      manifestObjectKeys: [written.manifestObjectKey],
      gammaMarketIds: GAMMA,
      idNamespace: "approx-replay-1-test",
      log: (line) => logged.push(line),
    });
    if (!started.ok) throw new Error(started.refusal.detail);
    const run = started.run;
    try {
      // The policy's one logged case: a planned order the core never recorded a
      // time-in-force for. Its id carries a line break and a counter-like tail.
      const submitted = await run.core.venue.submit({
        executionPlanId: "019b1e00-0000-7000-8000-00000000f00d",
        planKind: "PLACE",
        runMode: "PAPER",
        accountingMode: "LIVE",
        groups: [
          {
            marketId: MARKET_ID,
            orders: [
              {
                plannedOrderId: "planned-unknown\nrisk_refusals=0",
                tokenId: "9101",
                side: "YES",
                action: "BUY",
                limitPrice: "0.34",
                shares: "1",
                executionStyle: "MARKETABLE_LIMIT",
                postOnly: false,
              },
            ],
          },
        ],
        reservations: [],
      } as unknown as Parameters<typeof run.core.venue.submit>[0]);
      expect(submitted.accepted).toBe(false);
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.filter((line) => !line.startsWith("approximate "))).toEqual([]);
      expect(logged.filter((line) => line.includes("\n") || line.includes("\r"))).toEqual([]);
      expect(logged.some((line) => line.startsWith("approximate SUBMISSION REFUSED") && line.includes("planned-unknown\\nrisk_refusals=0"))).toBe(true);
    } finally {
      await run.core.store.close();
    }
  });
});
