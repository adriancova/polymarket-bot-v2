/**
 * Storage-cycle regressions with real deletions (`STORAGE-1` round 1): each
 * case is one the round-1 review showed deleting, or able to delete, a
 * segment it must keep. Every case runs the real cycle in `execute` mode, in
 * a temporary directory, with the opt-in marker present, so the deletion
 * capability would unlink if the decision let it.
 *
 * | Case | Finding |
 * | --- | --- |
 * | an unregistered market named only by a frame the sampler does not keep | J1 |
 * | a research pointer rewritten to name no market | J2 |
 * | a frontier stamped past the window while an earlier-stamped frame later in dispatch order is unprocessed | J5 |
 * | an operator pin written while the proof reads the store | J6 |
 * | a forward wall-clock step between cycles | J7 |
 * | a fill chain's source frame, named by identity, outside the window | J8 |
 * | an unclassified window's segment before windowStart - leadIn | J9 |
 * | the expiry capacity metric after deletions | J10 |
 * | a pin that starts to overlap between the plan and the recheck | J11 |
 * | dry-run handed a deletion capability | J12 |
 * | a sidecar left without its segment | J13 |
 * | a segment the extract path refuses | J14 |
 *
 * Rounds 2, 3 and 4 add their own sections below (K1-K6, L1-L4, M1-M2),
 * each case a real deletion the review showed, or a liveness failure it
 * showed.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExpiredSegmentDeletion, ObjectStore } from "@polymarket-bot/storage-parquet";
import {
  EXPIRY_OPT_IN_MARKER_CONTENT,
  EXPIRY_OPT_IN_MARKER_FILE_NAME,
  expireAfterExtractDeletion,
  nodeCompactionFileSystem,
  readParquetObject,
} from "@polymarket-bot/storage-parquet";
import { buildSegmentFixture } from "@polymarket-bot/storage-parquet/testing";
import type { SegmentFixture } from "@polymarket-bot/storage-parquet/testing";

import { researchPointerKey } from "../research-tier/extract.js";
import {
  EPOCH,
  HOUR,
  bookFrame,
  manualBootClock,
  polymarketFrame,
  storageFixture,
  tradeFrame,
} from "../testing/storage-fixture.js";
import type { ManualBootClock, StorageFixture } from "../testing/storage-fixture.js";
import type { MarketEvidence, TraderEvidenceSource } from "./classify.js";
import { dispatchFrontier, staticEvidenceSource } from "./classify.js";
import { runStorageCycle } from "./cycle.js";
import type { EvidenceHoldsFileOperations } from "./evidence-holds.js";
import {
  EVIDENCE_HOLDS_FILE_NAME,
  evidenceHoldsFileSystem,
  evidenceHoldsPath,
  nodeEvidenceHoldsFileOperations,
  readEvidenceHolds,
} from "./evidence-holds.js";
import { listExpiryPlanIds } from "./execute.js";
import type { StorageCycleDependencies, StorageCycleReport } from "./cycle.js";
import { fileOperatorPinLock, operatorPinLockPath, publishOperatorPin } from "./operator-pin-lock.js";
import { readPinRecord } from "./pins.js";
import { loadOperatorPins } from "./windows.js";
import type { MarketWindow } from "./windows.js";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const OLD = NOW - 80 * HOUR;
const MIN = 60 * 1000;
const NONE: MarketEvidence = { fillsAtMs: [], intents: [], refusalsAtMs: [], haltsAtMs: [] };

let fixtures: StorageFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures) await fixture.cleanup();
  fixtures = [];
});

async function fixture(segments: Parameters<typeof storageFixture>[0]["segments"], nowMs = NOW): Promise<StorageFixture> {
  const created = await storageFixture({ nowMs, segments });
  fixtures.push(created);
  await writeFile(join(created.walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
  return created;
}

function dependencies(
  f: StorageFixture,
  extra: Partial<StorageCycleDependencies> & { readonly bootClock?: ManualBootClock | null } = {},
): StorageCycleDependencies {
  return {
    walRootPath: f.walRoot,
    objectStore: f.objectStore,
    fileSystem: nodeCompactionFileSystem(),
    clock: f.clock,
    evidence: staticEvidenceSource({ frontiers: new Map(), evidence: new Map() }),
    loadWindows: async () => [],
    loadOperatorPins: async () => [],
    settings: {
      retentionMs: 72 * HOUR,
      leadInMs: 15 * MIN,
      durabilityGraceMs: 60_000,
      pinBudgetBytesPerDay: 1e12,
      expiryStuckAfterMs: 6 * HOUR,
      walMaxTotalBytes: null,
      maxSegmentsPerDataset: 64,
      extractionBatchDelayMs: 0,
    },
    mode: "execute",
    deletion: expireAfterExtractDeletion({ walRootPath: f.walRoot, objectStore: f.objectStore }),
    stateDirectory: f.stateDir,
    bootClock: manualBootClock(),
    ...extra,
  };
}

async function walFiles(f: StorageFixture): Promise<string[]> {
  return (await readdir(f.walDir)).filter((name) => name.endsWith(".wal.jsonl")).sort();
}

function reasonsOf(report: StorageCycleReport, segmentId: string): readonly string[] {
  return report.decisions.find((decision) => decision.segment.segmentId === segmentId)?.reasons ?? [];
}

/**
 * An evidence source that answers both the dispatch-order port and the
 * receipt-instant frontier the round-0 code read, so each case decides the
 * same way under either: only the guard under test differs.
 */
function evidenceBoth(input: {
  readonly durableThroughMs: number;
  readonly frontierIngestSeq: string;
  readonly evidence: MarketEvidence | (() => MarketEvidence);
}): TraderEvidenceSource {
  const source = {
    async durableThroughMs(): Promise<number> {
      return input.durableThroughMs;
    },
    async dispatchFrontiers(instanceIds: readonly string[]) {
      return new Map(instanceIds.map((id) => [id, dispatchFrontier({ [EPOCH]: input.frontierIngestSeq })] as const));
    },
    async marketEvidence(): Promise<MarketEvidence> {
      return typeof input.evidence === "function" ? input.evidence() : input.evidence;
    },
  };
  return source;
}

describe("J1: a market named only by a frame the sampler does not keep is still unclassified", () => {
  const cases = [
    ["a valid best_bid_ask", { event_type: "best_bid_ask", market: "unknown-condition", asset_id: "unknown-token", best_bid: "0.4", best_ask: "0.6", spread: "0.2" }],
    ["an unknown event type", { event_type: "future_event", market: "unknown-condition", asset_id: "unknown-token" }],
    ["an invalid book", { event_type: "book", market: "unknown-condition", asset_id: "unknown-token", bids: "bad", asks: [] }],
    ["a payload that does not parse", "{\"event_type\":"],
  ] as const;
  it.each(cases)("keeps the segment on disk: %s", async (_name, payload) => {
    const f = await fixture([[polymarketFrame({ ingestSeq: "1", atMs: OLD, payload: typeof payload === "string" ? payload : [payload] })]]);
    const report = await runStorageCycle(dependencies(f));
    expect(report.decisions[0]?.eligible).toBe(false);
    expect(report.decisions[0]?.reasons.some((reason) => /^(unknown-market|unidentified-market-content)/u.test(reason))).toBe(true);
    expect(await walFiles(f)).toHaveLength(1);
  });
});

describe("J2: a research pointer cannot remove a market from the decision", () => {
  it("keeps the segment when the pointer is rewritten to name no market", async () => {
    const f = await fixture([[bookFrame({ ingestSeq: "1", atMs: OLD, tokenId: "unknown-token", conditionId: "unknown-condition" })]]);
    await f.extract();
    const key = researchPointerKey(EPOCH, f.segments[0]?.segmentId ?? "");
    const pointer = JSON.parse(Buffer.from(await f.objectStore.get(key)).toString("utf8")) as Record<string, unknown>;
    await writeFile(join(f.root, "objects", key), JSON.stringify({ ...pointer, polymarketTokenIds: [], conditionIds: [] }));
    const report = await runStorageCycle(dependencies(f));
    expect(report.decisions[0]?.eligible).toBe(false);
    expect(await walFiles(f)).toHaveLength(1);
  });
});

describe("J5: a durable frontier is a dispatch position, not the newest receipt instant", () => {
  it("keeps a segment whose earlier-stamped frame, later in dispatch order, the trader has not processed", async () => {
    const end = OLD + 15 * MIN;
    const f = await fixture([
      [
        bookFrame({ ingestSeq: "1", atMs: end + 120_000, tokenId: "tok", conditionId: "cond" }),
        // F2: later in dispatch order, stamped back inside the window, NOT processed.
        bookFrame({ ingestSeq: "2", atMs: end - 1000, tokenId: "tok", conditionId: "cond" }),
      ],
      [tradeFrame({ ingestSeq: "3", atMs: end + 5 * MIN })],
      [tradeFrame({ ingestSeq: "4", atMs: NOW - HOUR })],
    ]);
    const window: MarketWindow = {
      windowId: "w",
      marketId: "m",
      conditionId: "cond",
      gammaMarketId: null,
      tokenIds: ["tok"],
      windowStartMs: OLD,
      windowEndMs: end,
      responsibleFromMs: OLD,
      responsibility: { kind: "trader", instanceIds: ["i"] },
    };
    const report = await runStorageCycle(
      dependencies(f, {
        loadWindows: async () => [window],
        // F1 is durable: its instant is past end + grace; its dispatch position is 1.
        evidence: evidenceBoth({ durableThroughMs: end + 120_000, frontierIngestSeq: "1", evidence: NONE }),
      }),
    );
    expect(report.classifications[0]).toMatchObject({ state: "unclassified" });
    expect(reasonsOf(report, f.segments[0]?.segmentId ?? "")).toContainEqual(expect.stringMatching(/^unclassified-window: w/u));
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
  });
});

describe("J6: an operator pin is checked at the unlink, and its publication is serialized with it", () => {
  it("keeps a segment when a pin is written to the pin file while the proof reads the store", async () => {
    const f = await fixture([[tradeFrame({ ingestSeq: "1", atMs: OLD })]]);
    const pinsPath = join(f.root, "operator-pins.json");
    await writeFile(pinsPath, JSON.stringify({ operatorPinVersion: 1, pins: [] }));
    const fs = nodeCompactionFileSystem();
    const deletion = expireAfterExtractDeletion({
      walRootPath: f.walRoot,
      objectStore: f.objectStore,
      fileSystem: {
        ...fs,
        async readWholeFile(path: string): Promise<Uint8Array> {
          // The pin lands while the deletion-time proof is reading.
          await writeFile(
            pinsPath,
            JSON.stringify({
              operatorPinVersion: 1,
              pins: [{ pinId: "during-proof", from: new Date(OLD - 1).toISOString(), to: new Date(OLD + 1).toISOString(), reason: "late" }],
            }),
          );
          return await fs.readWholeFile(path);
        },
      },
    });
    const report = await runStorageCycle(dependencies(f, { loadOperatorPins: () => loadOperatorPins(pinsPath), deletion }));
    expect(report.expiry?.deleted).toStrictEqual([]);
    expect(report.expiry?.failures[0]?.detail).toMatch(/operator pin during-proof now covers the segment/u);
    expect(await walFiles(f)).toHaveLength(1);
  });

  it("a pin published with the command while a deletion holds the lock waits for it, and holds every later segment", async () => {
    const f = await fixture([
      [tradeFrame({ ingestSeq: "1", atMs: OLD })],
      [tradeFrame({ ingestSeq: "2", atMs: OLD + MIN })],
      [tradeFrame({ ingestSeq: "3", atMs: NOW - HOUR })],
    ]);
    const pinsPath = join(f.root, "operator-pins.json");
    await writeFile(pinsPath, JSON.stringify({ operatorPinVersion: 1, pins: [] }));
    const lockPath = await operatorPinLockPath(pinsPath);
    const lock = fileOperatorPinLock(lockPath, { pollMs: 20 });
    const fs = nodeCompactionFileSystem();
    let publication: Promise<unknown> | null = null;
    const events: string[] = [];
    const real = expireAfterExtractDeletion({
      walRootPath: f.walRoot,
      objectStore: f.objectStore,
      fileSystem: {
        ...fs,
        async readWholeFile(path: string): Promise<Uint8Array> {
          if (publication === null) {
            publication = publishOperatorPin({
              operatorPinsPath: pinsPath,
              lock: fileOperatorPinLock(lockPath, { pollMs: 5 }),
              pin: { pinId: "published", from: new Date(OLD - HOUR).toISOString(), to: new Date(OLD + HOUR).toISOString(), reason: "review" },
            }).then(() => events.push("published"));
          }
          return await fs.readWholeFile(path);
        },
      },
    });
    const deletion: ExpiredSegmentDeletion = {
      policyName: real.policyName,
      async deleteExpiredSegment(directory, request, options) {
        const outcome = await real.deleteExpiredSegment(directory, request, options);
        events.push(`unlinked ${request.segmentId}`);
        return outcome;
      },
    };
    const report = await runStorageCycle(
      dependencies(f, { loadOperatorPins: () => loadOperatorPins(pinsPath), deletion, operatorPinLock: lock }),
    );
    await publication;
    // The deletion in flight completed first; the publication came next; the
    // later segment saw the pin.
    expect(events).toStrictEqual([`unlinked ${f.segments[0]?.segmentId ?? ""}`, "published"]);
    expect(report.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[0]?.segmentId]);
    expect(report.expiry?.failures).toMatchObject([
      { segmentId: f.segments[1]?.segmentId, detail: expect.stringMatching(/operator-pin: operator-published/u) },
    ]);
    expect(await walFiles(f)).toContain(f.segments[1]?.segmentFileName);
  });
});

describe("J7: a forward step of the wall clock cannot shorten the retention", () => {
  it("keeps a segment 71 h old on the true timeline after the wall clock jumps 2 h ahead", async () => {
    const f = await fixture([
      [tradeFrame({ ingestSeq: "1", atMs: NOW - 73 * HOUR })],
      [tradeFrame({ ingestSeq: "2", atMs: NOW - 71 * HOUR })],
    ]);
    const bootClock = manualBootClock();
    // A first cycle records the baseline.
    await runStorageCycle(dependencies(f, { mode: "dry-run", deletion: null, bootClock }));
    // One minute passes; the wall clock reads two hours later.
    bootClock.advance(MIN);
    f.clock.setNowMs(NOW + 2 * HOUR);
    const report = await runStorageCycle(dependencies(f, { bootClock }));
    expect(report.metrics.clock).toMatchObject({ status: "forward-step", skewMs: 2 * HOUR - MIN });
    // 73 h old (true) still expires; 71 h old (true) is kept.
    expect(report.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[0]?.segmentId]);
    expect(reasonsOf(report, f.segments[1]?.segmentId ?? "")).toContainEqual(expect.stringMatching(/^younger-than-retention/u));
    expect(await walFiles(f)).toStrictEqual([f.segments[1]?.segmentFileName]);
  });

  it("refuses execute mode without a boot clock", async () => {
    const f = await fixture([[tradeFrame({ ingestSeq: "1", atMs: OLD })]]);
    await expect(runStorageCycle(dependencies(f, { bootClock: null }))).rejects.toThrow(/boot clock/u);
    expect(await walFiles(f)).toHaveLength(1);
  });
});

describe("J8: a fill chain's source frame named by identity is held by the pin", () => {
  it("widens the pin to the source frame's segment; the deleted raw segment survives byte-exactly in the pin", async () => {
    const START = OLD;
    const book = (seq: string, atMs: number) => bookFrame({ ingestSeq: seq, atMs, tokenId: "tok", conditionId: "cond" });
    const f = await fixture([
      [book("1", START - 61 * MIN), book("2", START - 60 * MIN)], // holds the source frame (EPOCH, "2")
      [book("3", START - 30 * MIN)],
      [book("4", START + MIN), book("5", START + 4 * MIN)],
      [tradeFrame({ ingestSeq: "6", atMs: START + 20 * MIN })],
    ]);
    const window: MarketWindow = {
      windowId: "w1",
      marketId: "m",
      conditionId: "cond",
      gammaMarketId: null,
      tokenIds: ["tok"],
      windowStartMs: START,
      windowEndMs: START + 10 * MIN,
      responsibleFromMs: START,
      responsibility: { kind: "trader", instanceIds: ["i"] },
    };
    const evidence: MarketEvidence = {
      ...NONE,
      fillsAtMs: [START + 4 * MIN],
      intents: [{ evaluatedAtMs: START + 3 * MIN, sourceEventId: "src-2", gatewayEpoch: EPOCH, ingestSeq: "2" }],
    };
    const report = await runStorageCycle(
      dependencies(f, {
        loadWindows: async () => [window],
        evidence: evidenceBoth({ durableThroughMs: NOW, frontierIngestSeq: "6", evidence }),
      }),
    );
    const outcome = report.pins[0];
    if (outcome === undefined || outcome.status === "waiting") throw new Error("expected an extracted pin");
    const sourceSegmentId = f.segments[0]?.segmentId ?? "";
    expect(outcome.record.sourceEventsInside).toBe(true);
    expect(outcome.record.datasets.flatMap((dataset) => dataset.segmentIds)).toContain(sourceSegmentId);
    // Either the source segment is still on disk, or its deletion named the pin.
    const deletion = report.expiry?.deleted.find((entry) => entry.segmentId === sourceSegmentId);
    if (deletion === undefined) {
      expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
    } else {
      expect(deletion.basis === "expired-after-extract" && deletion.pins.map((pin) => pin.pinId)).toStrictEqual([outcome.pinId]);
      const dataset = outcome.record.datasets.find((candidate) => candidate.segmentIds.includes(sourceSegmentId));
      if (dataset === undefined) throw new Error("no dataset");
      const rows = await readParquetObject(
        await f.objectStore.get(`${dataset.manifestObjectKey.replace(/manifest\.json$/u, "")}${sourceSegmentId}.parquet`),
      );
      expect(rows.map((row) => row.record.ingestSeq)).toStrictEqual(["1", "2"]);
    }
    expect(await readPinRecord(f.objectStore, outcome.pinId)).toStrictEqual(outcome.record);
  });
});

describe("J9: an unclassified trader window holds from its responsibleFrom", () => {
  it("keeps a segment in [responsibleFrom - leadIn, windowStart - leadIn)", async () => {
    const START = OLD;
    const book = (seq: string, atMs: number) => bookFrame({ ingestSeq: seq, atMs, tokenId: "tok", conditionId: "cond" });
    const f = await fixture([
      [book("1", START - 120 * MIN)],
      [book("2", START - 40 * MIN)],
      [tradeFrame({ ingestSeq: "3", atMs: START + 60 * MIN })],
    ]);
    const window: MarketWindow = {
      windowId: "w1",
      marketId: "m",
      conditionId: "cond",
      gammaMarketId: null,
      tokenIds: ["tok"],
      windowStartMs: START,
      windowEndMs: START + 10 * MIN,
      responsibleFromMs: START - 30 * MIN,
      responsibility: { kind: "trader", instanceIds: ["i"] },
    };
    const report = await runStorageCycle(dependencies(f, { loadWindows: async () => [window] }));
    expect(reasonsOf(report, f.segments[1]?.segmentId ?? "")).toContainEqual(expect.stringMatching(/^unclassified-window: w1/u));
    expect(await walFiles(f)).toContain(f.segments[1]?.segmentFileName);
    // The control: the segment two hours before is outside every range and goes.
    expect(await walFiles(f)).not.toContain(f.segments[0]?.segmentFileName);
  });
});

describe("J10: the capacity metric counts what the WAL writer counts", () => {
  it("adds the bytes of expired segments to their epoch's sealed bytes on disk", async () => {
    const f = await fixture([
      [tradeFrame({ ingestSeq: "1", atMs: OLD })],
      [tradeFrame({ ingestSeq: "2", atMs: NOW - HOUR })],
    ]);
    const total = f.segments.reduce((sum, segment) => sum + segment.segmentBytes.byteLength, 0);
    const base = dependencies(f);
    const report = await runStorageCycle({ ...base, settings: { ...base.settings, walMaxTotalBytes: total } });
    expect(report.expiry?.deleted).toHaveLength(1);
    expect(report.metrics.walCapacity).toMatchObject({
      sealedBytesOnDisk: f.segments[1]?.segmentBytes.byteLength,
      largestEpoch: EPOCH,
      largestEpochWrittenBytes: total,
      headroomBytes: 0,
      alarm: true,
    });
    expect(report.metrics.expiryPlansUnreadable).toBe(0);
    // A durable plan that does not read is reported, and does not fail the cycle.
    await writeFile(join(f.stateDir, "expiry-plans", "expiry-broken.json"), "{");
    const again = await runStorageCycle({ ...base, settings: { ...base.settings, walMaxTotalBytes: total } });
    expect(again.metrics.expiryPlansUnreadable).toBe(1);
  });
});

describe("J11: the recheck requires the same set of overlapping pins as the plan", () => {
  it("keeps a segment that a window pin started to overlap between the plan and the recheck", async () => {
    const book = (seq: string, atMs: number) => bookFrame({ ingestSeq: seq, atMs, tokenId: "tok", conditionId: "cond" });
    const f = await fixture([
      [book("1", OLD + 5 * MIN)],
      [tradeFrame({ ingestSeq: "2", atMs: OLD + 30 * MIN })],
      [tradeFrame({ ingestSeq: "3", atMs: NOW - HOUR })],
    ]);
    const window: MarketWindow = {
      windowId: "w1",
      marketId: "m",
      conditionId: "cond",
      gammaMarketId: null,
      tokenIds: ["tok"],
      windowStartMs: OLD,
      windowEndMs: OLD + 15 * MIN,
      responsibleFromMs: OLD,
      responsibility: { kind: "trader", instanceIds: ["i"] },
    };
    const intent: MarketEvidence = {
      ...NONE,
      intents: [{ evaluatedAtMs: OLD + 5 * MIN, sourceEventId: null, gatewayEpoch: null, ingestSeq: null }],
    };
    // A dry run with the intent extracts the window's pin.
    await runStorageCycle(
      dependencies(f, {
        mode: "dry-run",
        deletion: null,
        loadWindows: async () => [window],
        evidence: evidenceBoth({ durableThroughMs: NOW, frontierIngestSeq: "3", evidence: intent }),
      }),
    );
    // The plan reads no evidence, and the store's pin listing does not show
    // the pin yet (as if another cycle wrote its record after this plan);
    // every later read finds the intent and the pin.
    let reads = 0;
    let listings = 0;
    const store = f.objectStore;
    const report = await runStorageCycle(
      dependencies(f, {
        objectStore: {
          put: (key, bytes) => store.put(key, bytes),
          head: (key) => store.head(key),
          get: (key) => store.get(key),
          // Listings 1 (pin binding) and 2 (the plan) come before the recheck.
          list: async (prefix) => (++listings <= 2 ? [] : await (store.list?.(prefix) ?? [])),
        },
        loadWindows: async () => [window],
        evidence: evidenceBoth({
          durableThroughMs: NOW,
          frontierIngestSeq: "3",
          evidence: () => (++reads === 1 ? NONE : intent),
        }),
      }),
    );
    const planned = report.decisions.find((decision) => decision.segment.segmentId === f.segments[0]?.segmentId);
    expect(planned?.eligible).toBe(true);
    expect(planned?.request?.pins).toStrictEqual([]);
    expect(report.expiry?.failures).toContainEqual({
      segmentId: f.segments[0]?.segmentId,
      detail: "kept on recheck: the set of overlapping pins changed since the plan was made",
    });
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
  });
});

describe("J12: dry-run never deletes, even when handed a deletion capability", () => {
  it("deletes nothing and writes no plan", async () => {
    const f = await fixture([[tradeFrame({ ingestSeq: "1", atMs: OLD })], [tradeFrame({ ingestSeq: "2", atMs: NOW - HOUR })]]);
    const report = await runStorageCycle(dependencies(f, { mode: "dry-run" }));
    expect(report.decisions[0]?.eligible).toBe(true);
    expect(report.expiry).toBeNull();
    expect(await walFiles(f)).toHaveLength(2);
    expect(await listExpiryPlanIds(f.stateDir)).toStrictEqual([]);
  });
});

describe("J13: a sidecar left without its segment is reported, never planned", () => {
  it("does not fail every later cycle", async () => {
    const f = await fixture([
      [tradeFrame({ ingestSeq: "1", atMs: OLD })],
      [tradeFrame({ ingestSeq: "2", atMs: OLD + MIN })],
      [tradeFrame({ ingestSeq: "3", atMs: NOW - HOUR })],
    ]);
    await f.extract();
    // A deletion interrupted between its two unlinks.
    await rm(join(f.walDir, f.segments[0]?.segmentFileName ?? ""));
    const report = await runStorageCycle(dependencies(f));
    expect(report.metrics.walOrphanSidecars).toBe(1);
    expect(report.decisions.map((decision) => decision.segment.segmentId)).not.toContain(f.segments[0]?.segmentId);
    expect(report.expiry?.failures).toStrictEqual([]);
    expect(report.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[1]?.segmentId]);
  });
});

describe("J14: a broken extract path is stuck", () => {
  it("raises the stuck alarm for a segment whose research tier cannot be written", async () => {
    const f = await fixture([[tradeFrame({ ingestSeq: "1", atMs: OLD })], [tradeFrame({ ingestSeq: "2", atMs: NOW - HOUR })]]);
    // Segment 0's bytes no longer match its sidecar: it is refused, never extracted.
    const segment = f.segments[0];
    if (segment === undefined) throw new Error("no segment");
    await writeFile(join(f.walDir, segment.segmentFileName), Buffer.from(Buffer.from(segment.segmentBytes).toString("utf8").replace("BTCUSDT", "BTCUSDX")));
    const report = await runStorageCycle(dependencies(f));
    expect(report.extraction.refused.map((entry) => entry.segmentId)).toStrictEqual([segment.segmentId]);
    expect(reasonsOf(report, segment.segmentId)).toContainEqual(expect.stringMatching(/^not-extracted/u));
    expect(report.metrics.expiryLagMs).toBeGreaterThan(6 * HOUR);
    expect(report.metrics.expiryStuck).toBe(true);
  });
});

describe("a refused segment the inventory lists is never deleted", () => {
  it("keeps a segment rewritten after the research tier was built", async () => {
    const f = await fixture([[tradeFrame({ ingestSeq: "1", atMs: OLD })], [tradeFrame({ ingestSeq: "2", atMs: NOW - HOUR })]]);
    await f.extract();
    const replacement = buildSegmentFixture({ gatewayEpoch: EPOCH, segmentIndex: 0, frames: [tradeFrame({ ingestSeq: "1", atMs: OLD, id: 999 })] });
    await writeFile(join(f.walDir, replacement.segmentFileName), replacement.segmentBytes);
    await writeFile(join(f.walDir, replacement.manifestFileName), replacement.manifestBytes);
    const report = await runStorageCycle(dependencies(f));
    expect(report.expiry?.deleted ?? []).toStrictEqual([]);
    expect(await walFiles(f)).toHaveLength(2);
  });
});

// -- Round 2 ------------------------------------------------------------------

const MARKET_WINDOW = (start: number, end: number, responsibleFrom = start): MarketWindow => ({
  windowId: "w1",
  marketId: "m",
  conditionId: "cond",
  gammaMarketId: null,
  tokenIds: ["tok"],
  windowStartMs: start,
  windowEndMs: end,
  responsibleFromMs: responsibleFrom,
  responsibility: { kind: "trader", instanceIds: ["i"] },
});
const tokBook = (seq: string, atMs: number) => bookFrame({ ingestSeq: seq, atMs, tokenId: "tok", conditionId: "cond" });
const frontierAt = (ingestSeq: string, evidence: MarketEvidence): TraderEvidenceSource =>
  staticEvidenceSource({ frontiers: new Map([["i", dispatchFrontier({ [EPOCH]: ingestSeq })]]), evidence: new Map([["m", evidence]]) });

/** Flip one byte of the pin's Parquet object for a segment: the pin no longer preserves its bytes. */
async function damagePinObject(f: StorageFixture, pinId: string, segmentId: string): Promise<void> {
  const directory = join(f.root, "objects", "pins", pinId, EPOCH);
  const name = (await readdir(directory)).find((candidate) => candidate.startsWith(segmentId) && candidate.endsWith(".parquet"));
  if (name === undefined) throw new Error(`pin ${pinId} holds no object for ${segmentId}`);
  const bytes = Buffer.from(await f.objectStore.get(`pins/${pinId}/${EPOCH}/${name}`));
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0xff;
  await writeFile(join(directory, name), bytes);
}

async function windowPinDirectories(f: StorageFixture): Promise<string[]> {
  return (await readdir(join(f.root, "objects", "pins"))).filter((name) => name.startsWith("window-")).sort();
}

describe("K1: a pending chain source never releases the segment of a located one", () => {
  // Segment 0 holds the located source (EPOCH, "2"), two hours before the window.
  const segments = () => [[tokBook("1", OLD - 2 * HOUR)], [tokBook("3", OLD)], [tradeFrame({ ingestSeq: "5", atMs: OLD + 20 * MIN })]];
  const located = { evaluatedAtMs: OLD, sourceEventId: "located", gatewayEpoch: EPOCH, ingestSeq: "2" };
  // Its epoch has no sealed segment yet.
  const pending = { evaluatedAtMs: OLD + MIN, sourceEventId: "pending", gatewayEpoch: "0190a3e0-0000-7000-8000-000000000002", ingestSeq: "2" };

  it.each([
    ["located, then pending", [located, pending]],
    ["pending, then located", [pending, located]],
  ])("keeps the located source's segment on disk (%s)", async (_order, intents) => {
    const f = await fixture(segments());
    const report = await runStorageCycle(
      dependencies(f, {
        loadWindows: async () => [MARKET_WINDOW(OLD, OLD + 15 * MIN)],
        evidence: frontierAt("100", { ...NONE, fillsAtMs: [OLD + MIN], intents }),
      }),
    );
    expect(report.classifications[0]).toMatchObject({ state: "unclassified", reason: expect.stringMatching(/not sealed and verified yet/u) });
    expect(reasonsOf(report, f.segments[0]?.segmentId ?? "")).toContainEqual(
      expect.stringMatching(/^unclassified-window: w1 holds chain evidence in this segment/u),
    );
    expect(report.expiry?.deleted.map((entry) => entry.segmentId) ?? []).not.toContain(f.segments[0]?.segmentId);
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
  });

  it("keeps it while the trader has not yet passed the window, too", async () => {
    const f = await fixture(segments());
    const report = await runStorageCycle(
      dependencies(f, {
        loadWindows: async () => [MARKET_WINDOW(OLD, OLD + 15 * MIN)],
        evidence: frontierAt("3", { ...NONE, fillsAtMs: [OLD + MIN], intents: [located] }),
      }),
    );
    expect(report.classifications[0]).toMatchObject({ state: "unclassified", reason: expect.stringMatching(/has not durably processed/u) });
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
  });

  it("control: with the located source alone, the window classifies and its pin holds the segment", async () => {
    const f = await fixture(segments());
    const report = await runStorageCycle(
      dependencies(f, {
        loadWindows: async () => [MARKET_WINDOW(OLD, OLD + 15 * MIN)],
        evidence: frontierAt("100", { ...NONE, fillsAtMs: [OLD + MIN], intents: [located] }),
      }),
    );
    const outcome = report.pins[0];
    if (outcome === undefined || outcome.status === "waiting") throw new Error("expected an extracted pin");
    expect(outcome.record.sourceEventsInside).toBe(true);
    expect(outcome.record.datasets.flatMap((dataset) => dataset.segmentIds)).toContain(f.segments[0]?.segmentId);
  });
});

describe("K3: every extracted pin is verified and named before a segment it covers expires", () => {
  // Cycle 1 runs while every segment is younger than 72 h; cycle 2, two hours later.
  const START = NOW - 72 * HOUR + 60 * MIN;
  const segments = () => [
    [tokBook("1", START - 24 * MIN), tokBook("2", START - 22 * MIN)], // S0: only the widened pin's lead-in covers it
    [tokBook("3", START - 10 * MIN), tokBook("4", START + 3 * MIN)], // S1: holds the source event (EPOCH, "4")
    [tokBook("5", START + 6 * MIN), tokBook("6", START + 9 * MIN)], // S2: the window
    [tradeFrame({ ingestSeq: "7", atMs: START + 20 * MIN })],
    [tradeFrame({ ingestSeq: "8", atMs: NOW + 3 * HOUR })],
  ];
  const window = MARKET_WINDOW(START, START + 10 * MIN);
  const evidence: MarketEvidence = {
    ...NONE,
    fillsAtMs: [START + 6 * MIN],
    intents: [{ evaluatedAtMs: START + 3 * MIN, sourceEventId: "src-4", gatewayEpoch: EPOCH, ingestSeq: "4" }],
  };
  const outage: TraderEvidenceSource = {
    async dispatchFrontiers() {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    },
    async marketEvidence() {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    },
  };

  async function firstCycle(): Promise<{ f: StorageFixture; bootClock: ManualBootClock; pinId: string }> {
    const f = await fixture(segments());
    const bootClock = manualBootClock();
    const first = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], evidence: frontierAt("8", evidence) }));
    const outcome = first.pins[0];
    if (outcome === undefined || outcome.status !== "extracted") throw new Error("expected an extracted pin");
    expect(outcome.record.datasets.flatMap((dataset) => dataset.segmentIds)).toContain(f.segments[0]?.segmentId);
    expect(first.expiry?.deleted ?? []).toStrictEqual([]);
    bootClock.advance(2 * HOUR);
    f.clock.setNowMs(NOW + 2 * HOUR);
    return { f, bootClock, pinId: outcome.pinId };
  }

  const triggers: [string, Partial<Pick<StorageCycleDependencies, "evidence" | "loadWindows">>][] = [
    ["the trader's database is unreachable", { evidence: outage }],
    ["the window is re-registered gateway-only", { loadWindows: async () => [{ ...window, responsibility: { kind: "gateway-only" } }] }],
  ];

  it.each(triggers)("names the pin in the deletion when %s", async (_trigger, change) => {
    const { f, bootClock, pinId } = await firstCycle();
    const report = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], ...change }));
    expect(report.pins.filter((outcome) => outcome.pinId.startsWith("window-"))).toStrictEqual([]);
    const deletion = report.expiry?.deleted.find((entry) => entry.segmentId === f.segments[0]?.segmentId);
    expect(deletion?.basis === "expired-after-extract" && deletion.pins.map((pin) => pin.pinId)).toStrictEqual([pinId]);
  });

  it.each(triggers)("keeps the segment when %s and the pin's copy of it is damaged", async (_trigger, change) => {
    const { f, bootClock, pinId } = await firstCycle();
    await damagePinObject(f, pinId, f.segments[0]?.segmentId ?? "");
    const report = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], ...change }));
    expect(report.expiry?.deleted.map((entry) => entry.segmentId) ?? []).not.toContain(f.segments[0]?.segmentId);
    expect(report.expiry?.failures).toContainEqual({
      segmentId: f.segments[0]?.segmentId,
      detail: expect.stringMatching(/an overlapping pin does not preserve the segment's bytes/u),
    });
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
  });

  it("names the first pin when the window is re-pinned with new evidence, and keeps the segment when that pin is damaged", async () => {
    for (const damaged of [false, true]) {
      const { f, bootClock, pinId } = await firstCycle();
      if (damaged) await damagePinObject(f, pinId, f.segments[0]?.segmentId ?? "");
      // A second decision with intents appears: the window's derived pin is a new one.
      const more: MarketEvidence = {
        ...evidence,
        intents: [...evidence.intents, { evaluatedAtMs: START + 7 * MIN, sourceEventId: "src-6", gatewayEpoch: EPOCH, ingestSeq: "6" }],
      };
      const report = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], evidence: frontierAt("8", more) }));
      expect(report.pins.map((outcome) => outcome.pinId)).not.toContain(pinId);
      const deletion = report.expiry?.deleted.find((entry) => entry.segmentId === f.segments[0]?.segmentId);
      if (damaged) {
        expect(deletion).toBeUndefined();
        expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
      } else {
        expect(deletion?.basis === "expired-after-extract" && deletion.pins.map((pin) => pin.pinId)).toContain(pinId);
      }
    }
  });
});

describe("K4: a window's pin stays bound after its chain-source segment expires under it", () => {
  it("expires the window's later segments under the same pin, with no second pin and nothing held forever", async () => {
    const START = NOW - 72 * HOUR + 10 * MIN;
    const f = await fixture([
      [tokBook("1", START - 61 * MIN), tokBook("2", START - 60 * MIN)], // S0: the source (EPOCH, "2")
      [tokBook("3", START - 30 * MIN)], // S1
      [tokBook("4", START + MIN), tokBook("5", START + 4 * MIN)], // S2: the window
      [tradeFrame({ ingestSeq: "6", atMs: START + 20 * MIN })],
      [tradeFrame({ ingestSeq: "7", atMs: NOW })],
    ]);
    const evidence: MarketEvidence = {
      ...NONE,
      fillsAtMs: [START + 4 * MIN],
      intents: [{ evaluatedAtMs: START + 3 * MIN, sourceEventId: "src-2", gatewayEpoch: EPOCH, ingestSeq: "2" }],
    };
    const bootClock = manualBootClock();
    const deps = () => dependencies(f, { bootClock, loadWindows: async () => [MARKET_WINDOW(START, START + 10 * MIN)], evidence: frontierAt("7", evidence) });
    const first = await runStorageCycle(deps());
    const pinId = first.pins[0]?.pinId;
    expect(first.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[0]?.segmentId, f.segments[1]?.segmentId]);
    for (const step of [1, 2]) {
      bootClock.advance(30 * MIN);
      f.clock.setNowMs(NOW + 30 * MIN * step);
      const report = await runStorageCycle(deps());
      expect(report.pins.map((outcome) => [outcome.pinId, outcome.status])).toStrictEqual([[pinId, "already-extracted"]]);
      for (const decision of report.decisions) {
        expect(decision.reasons.filter((reason) => reason.startsWith("pin-trace-incomplete"))).toStrictEqual([]);
      }
      if (step === 1) {
        const deletion = report.expiry?.deleted.find((entry) => entry.segmentId === f.segments[2]?.segmentId);
        expect(deletion?.basis === "expired-after-extract" && deletion.pins.map((pin) => pin.pinId)).toStrictEqual([pinId]);
      }
    }
    expect(await walFiles(f)).not.toContain(f.segments[2]?.segmentFileName);
    expect(await windowPinDirectories(f)).toStrictEqual([pinId]);
    expect(first.metrics.expiryStuck).toBe(false);
  });
});

describe("K3 / K4: ordinary aging — the source segment expires under the pin, then the segments only that pin covers", () => {
  it.each([false, true])("names the first pin when a segment only it covers expires next cycle (its copy damaged: %s)", async (damaged) => {
    const START = NOW - 72 * HOUR + 45 * MIN;
    const f = await fixture([
      [tokBook("1", START - 61 * MIN), tokBook("2", START - 60 * MIN)], // S0: the source (EPOCH, "2")
      [tokBook("3", START - 30 * MIN)], // S1: inside the first pin only, once the source is gone
      [tokBook("4", START + MIN), tokBook("5", START + 4 * MIN)], // S2: the window
      [tradeFrame({ ingestSeq: "6", atMs: START + 20 * MIN })],
      [tradeFrame({ ingestSeq: "7", atMs: NOW })],
    ]);
    const evidence: MarketEvidence = {
      ...NONE,
      fillsAtMs: [START + 4 * MIN],
      intents: [{ evaluatedAtMs: START + 3 * MIN, sourceEventId: "src-2", gatewayEpoch: EPOCH, ingestSeq: "2" }],
    };
    const bootClock = manualBootClock();
    const deps = () => dependencies(f, { bootClock, loadWindows: async () => [MARKET_WINDOW(START, START + 10 * MIN)], evidence: frontierAt("7", evidence) });
    const first = await runStorageCycle(deps());
    const pinId = first.pins[0]?.pinId ?? "";
    expect(first.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[0]?.segmentId]);
    if (damaged) await damagePinObject(f, pinId, f.segments[1]?.segmentId ?? "");
    bootClock.advance(30 * MIN);
    f.clock.setNowMs(NOW + 30 * MIN);
    const second = await runStorageCycle(deps());
    const deletion = second.expiry?.deleted.find((entry) => entry.segmentId === f.segments[1]?.segmentId);
    if (damaged) {
      expect(deletion).toBeUndefined();
      expect(await walFiles(f)).toContain(f.segments[1]?.segmentFileName);
    } else {
      expect(deletion?.basis === "expired-after-extract" && deletion.pins.map((pin) => pin.pinId)).toStrictEqual([pinId]);
    }
  });
});

describe("K2: a frame the inventory could not read in full keeps its segment", () => {
  const gatewayOnly = { ...MARKET_WINDOW(OLD, OLD + 15 * MIN), responsibility: { kind: "gateway-only" as const } };
  const hiddenAt = (depth: number) => {
    let hidden: unknown = { asset_id: "unknown-token" };
    for (let level = 0; level < depth; level += 1) hidden = { nested: hidden };
    return { asset_id: "tok", market: "cond", event_type: "future_event", hidden };
  };

  it.each([
    ["an unknown token nested 18 levels down", polymarketFrame({ ingestSeq: "1", atMs: OLD, payload: hiddenAt(18) }), /^unidentified-market-content/u],
    ["control: the same token 14 levels down", polymarketFrame({ ingestSeq: "1", atMs: OLD, payload: hiddenAt(14) }), /^unknown-market: token unknown-token/u],
    [
      "a duplicate identity key",
      polymarketFrame({ ingestSeq: "1", atMs: OLD, payload: '[{"event_type":"book","market":"unknown","asset_id":"unknown","market":"cond","asset_id":"tok"}]' }),
      /^unidentified-market-content/u,
    ],
    [
      "an RTDS frame on another topic",
      { ...polymarketFrame({ ingestSeq: "1", atMs: OLD, payload: { topic: "activity", payload: { conditionId: "unknown" } } }), source: "rtds", endpoint: "wss://ws-live-data.polymarket.com" },
      /^unidentified-market-content/u,
    ],
  ])("%s", async (_name, frame, reason) => {
    const f = await fixture([[frame], [tradeFrame({ ingestSeq: "2", atMs: NOW - HOUR })]]);
    const report = await runStorageCycle(dependencies(f, { loadWindows: async () => [gatewayOnly] }));
    expect(reasonsOf(report, f.segments[0]?.segmentId ?? "")).toContainEqual(expect.stringMatching(reason));
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
  });

  it("control: the same segment with a readable frame naming the registered market expires", async () => {
    const f = await fixture([[polymarketFrame({ ingestSeq: "1", atMs: OLD, payload: hiddenAt(0) })], [tradeFrame({ ingestSeq: "2", atMs: NOW - HOUR })]]);
    const readable = await runStorageCycle(dependencies(f, { loadWindows: async () => [{ ...gatewayOnly, tokenIds: ["tok", "unknown-token"] }] }));
    expect(readable.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[0]?.segmentId]);
  });
});

describe("K5: the final operator-pin check covers the segment's whole receipt span", () => {
  it("keeps a multi-frame segment when a pin over only its LATER frame is written while the proof reads", async () => {
    const f = await fixture([[tradeFrame({ ingestSeq: "1", atMs: OLD }), tradeFrame({ ingestSeq: "2", atMs: OLD + 10 * MIN })], [tradeFrame({ ingestSeq: "3", atMs: NOW - HOUR })]]);
    const pinsPath = join(f.root, "operator-pins.json");
    await writeFile(pinsPath, JSON.stringify({ operatorPinVersion: 1, pins: [] }));
    const fs = nodeCompactionFileSystem();
    const deletion = expireAfterExtractDeletion({
      walRootPath: f.walRoot,
      objectStore: f.objectStore,
      fileSystem: {
        ...fs,
        async readWholeFile(path: string): Promise<Uint8Array> {
          await writeFile(
            pinsPath,
            JSON.stringify({
              operatorPinVersion: 1,
              pins: [{ pinId: "late-frame", from: new Date(OLD + 9 * MIN).toISOString(), to: new Date(OLD + 11 * MIN).toISOString(), reason: "late" }],
            }),
          );
          return await fs.readWholeFile(path);
        },
      },
    });
    const report = await runStorageCycle(dependencies(f, { loadOperatorPins: () => loadOperatorPins(pinsPath), deletion }));
    expect(report.expiry?.deleted).toStrictEqual([]);
    expect(report.expiry?.failures[0]?.detail).toMatch(/operator pin late-frame now covers the segment/u);
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
  });
});

// -- Round 3 ------------------------------------------------------------------

const E2 = "0190a3e0-0000-7000-8000-000000000002";
const databaseDown: TraderEvidenceSource = {
  async dispatchFrontiers() {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  },
  async marketEvidence() {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  },
};
const evidenceTimesOut = (base: TraderEvidenceSource): TraderEvidenceSource => ({
  dispatchFrontiers: (instanceIds) => base.dispatchFrontiers(instanceIds),
  async marketEvidence() {
    throw new Error("canceling statement due to statement timeout");
  },
});
const frontiersAt = (byEpoch: Record<string, string>, evidence: MarketEvidence): TraderEvidenceSource =>
  staticEvidenceSource({ frontiers: new Map([["i", dispatchFrontier(byEpoch)]]), evidence: new Map([["m", evidence]]) });
/** A later, gateway-only window of the same market: it keeps the market registered once w1 is gone. */
const LATER_SAME_MARKET: MarketWindow = { ...MARKET_WINDOW(NOW + HOUR, NOW + 2 * HOUR), windowId: "w2", responsibility: { kind: "gateway-only" } };

/** Write a sealed segment of another gateway epoch into the WAL root. */
async function writeEpochSegment(
  f: StorageFixture,
  gatewayEpoch: string,
  segmentIndex: number,
  frames: Parameters<typeof buildSegmentFixture>[0]["frames"],
): Promise<SegmentFixture> {
  const directory = join(f.walRoot, gatewayEpoch);
  await mkdir(directory, { recursive: true });
  const segment = buildSegmentFixture({ gatewayEpoch, segmentIndex, frames });
  await writeFile(join(directory, segment.segmentFileName), segment.segmentBytes);
  await writeFile(join(directory, segment.manifestFileName), segment.manifestBytes);
  return segment;
}

async function onDisk(f: StorageFixture, gatewayEpoch: string, segment: SegmentFixture): Promise<boolean> {
  return (await readdir(join(f.walRoot, gatewayEpoch))).includes(segment.segmentFileName);
}

function deletionPins(report: StorageCycleReport, segmentId: string | undefined): readonly string[] | null {
  const deletion = report.expiry?.deleted.find((entry) => entry.segmentId === segmentId);
  return deletion === undefined || deletion.basis !== "expired-after-extract" ? null : deletion.pins.map((pin) => pin.pinId);
}

describe("L1: a hold on a located chain source survives every later cycle until the window's pin holds it", () => {
  // As K1: segment 0 holds the located source (EPOCH, "2"), two hours before
  // the window; the other source's epoch has sealed nothing yet.
  const located = { evaluatedAtMs: OLD, sourceEventId: "located", gatewayEpoch: EPOCH, ingestSeq: "2" };
  const pending = { evaluatedAtMs: OLD + MIN, sourceEventId: "pending", gatewayEpoch: E2, ingestSeq: "2" };
  const evidence: MarketEvidence = { ...NONE, fillsAtMs: [OLD + MIN], intents: [located, pending] };
  const window = MARKET_WINDOW(OLD, OLD + 15 * MIN);
  const segments = (sourceFrame = tokBook("1", OLD - 2 * HOUR)) => [
    [sourceFrame],
    [tokBook("3", OLD)],
    [tradeFrame({ ingestSeq: "5", atMs: OLD + 20 * MIN })],
    [tradeFrame({ ingestSeq: "7", atMs: NOW - HOUR })],
  ];

  async function heldInCycleOne(
    sourceFrame?: ReturnType<typeof tokBook>,
  ): Promise<{ f: StorageFixture; bootClock: ManualBootClock; filesAfter: string[] }> {
    const f = await fixture(segments(sourceFrame));
    const bootClock = manualBootClock();
    const first = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], evidence: frontierAt("100", evidence) }));
    expect(first.classifications[0]).toMatchObject({ state: "unclassified", holdRanges: [{ fromMs: OLD - 2 * HOUR - 15 * MIN, toMs: OLD + 15 * MIN }] });
    // Only the reference-feed segment after the window, outside every range w1 could hold, went.
    expect(first.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[2]?.segmentId]);
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
    bootClock.advance(30 * MIN);
    f.clock.setNowMs(NOW + 30 * MIN);
    return { f, bootClock, filesAfter: await walFiles(f) };
  }

  it.each<[string, () => TraderEvidenceSource]>([
    ["the trader's database is unreachable", () => databaseDown],
    ["the evidence read times out while the frontier reads", () => evidenceTimesOut(frontierAt("100", evidence))],
    ["the evidence read times out while the trader lags", () => evidenceTimesOut(frontierAt("1", evidence))],
  ])("keeps the source segment, and every other, in a later cycle where %s", async (_trigger, failing) => {
    const { f, bootClock, filesAfter } = await heldInCycleOne();
    const second = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], evidence: failing() }));
    expect(await walFiles(f)).toStrictEqual(filesAfter);
    expect(filesAfter).toContain(f.segments[0]?.segmentFileName);
    expect(second.expiry).toBeNull();
    const reasons = reasonsOf(second, f.segments[0]?.segmentId ?? "");
    expect(reasons).toContainEqual(expect.stringMatching(/^evidence-unreadable: w1's rows could not be read/u));
    expect(reasons).toContainEqual(expect.stringMatching(/^evidence-hold: w1 holds chain evidence in this segment/u));
    for (const decision of second.decisions) expect(decision.eligible).toBe(false);
  });

  it("keeps every segment when the very first read of the window's rows fails, before any hold was recorded", async () => {
    const f = await fixture(segments());
    const report = await runStorageCycle(dependencies(f, { loadWindows: async () => [window], evidence: databaseDown }));
    expect(await walFiles(f)).toHaveLength(4);
    expect(report.expiry).toBeNull();
    for (const decision of report.decisions) {
      expect(decision.reasons).toContainEqual(expect.stringMatching(/^evidence-unreadable: w1's rows could not be read .*ECONNREFUSED/u));
    }
  });

  it("keeps every segment when the rows read but cannot be interpreted", async () => {
    const f = await fixture(segments());
    const malformed: TraderEvidenceSource = {
      dispatchFrontiers: (instanceIds) => frontierAt("100", NONE).dispatchFrontiers(instanceIds),
      async marketEvidence() {
        return { ...NONE, intents: null } as unknown as MarketEvidence;
      },
    };
    const report = await runStorageCycle(dependencies(f, { loadWindows: async () => [window], evidence: malformed }));
    expect(await walFiles(f)).toHaveLength(4);
    for (const decision of report.decisions) {
      expect(decision.reasons).toContainEqual(expect.stringMatching(/^evidence-unreadable: w1's rows could not be read/u));
    }
  });

  it("keeps every segment when the window leaves the registry while its rows could not be read", async () => {
    // Never read: the database was down from the window's first cycle.
    const f = await fixture(segments(tradeFrame({ ingestSeq: "1", atMs: OLD - 2 * HOUR })));
    const bootClock = manualBootClock();
    await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], evidence: databaseDown }));
    expect(await walFiles(f)).toHaveLength(4);
    bootClock.advance(30 * MIN);
    f.clock.setNowMs(NOW + 30 * MIN);
    const second = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [LATER_SAME_MARKET], evidence: databaseDown }));
    expect(await walFiles(f)).toHaveLength(4);
    for (const decision of second.decisions) {
      expect(decision.reasons).toContainEqual(expect.stringMatching(/^evidence-unreadable: w1 left the registry while its rows could not be read/u));
    }
  });

  it("a dry run reads the durable holds and never writes them", async () => {
    const f = await fixture(segments(tradeFrame({ ingestSeq: "1", atMs: OLD - 2 * HOUR })));
    const dryRun = (loadWindows: () => Promise<readonly MarketWindow[]>) =>
      runStorageCycle(dependencies(f, { mode: "dry-run", deletion: null, loadWindows, evidence: frontierAt("100", evidence) }));
    await dryRun(async () => [window]);
    await expect(readFile(join(f.stateDir, EVIDENCE_HOLDS_FILE_NAME))).rejects.toMatchObject({ code: "ENOENT" });
    // Held by an execute cycle, then read by a dry run without the window.
    await runStorageCycle(dependencies(f, { loadWindows: async () => [window], evidence: frontierAt("100", evidence) }));
    const before = await readFile(join(f.stateDir, EVIDENCE_HOLDS_FILE_NAME));
    const report = await dryRun(async () => [LATER_SAME_MARKET]);
    expect(reasonsOf(report, f.segments[0]?.segmentId ?? "")).toStrictEqual([expect.stringMatching(/^evidence-hold: w1 /u)]);
    expect(await readFile(join(f.stateDir, EVIDENCE_HOLDS_FILE_NAME))).toStrictEqual(before);
  });

  it("keeps the source segment when the window leaves the registry", async () => {
    // The located source is a reference-feed frame: once w1 is gone, no market keeps its segment.
    const { f, bootClock } = await heldInCycleOne(tradeFrame({ ingestSeq: "1", atMs: OLD - 2 * HOUR }));
    const second = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [LATER_SAME_MARKET], evidence: frontierAt("100", evidence) }));
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
    expect(reasonsOf(second, f.segments[0]?.segmentId ?? "")).toStrictEqual([
      expect.stringMatching(/^evidence-hold: w1 holds chain evidence in this segment/u),
    ]);
    expect((await readEvidenceHolds(f.stateDir)).windows.get("w1")?.holds).toStrictEqual([
      { fromMs: OLD - 2 * HOUR - 15 * MIN, toMs: OLD + 15 * MIN },
    ]);
  });

  it("releases the hold once the window's pin holds its evidence: the source segment then expires under that pin", async () => {
    const { f, bootClock } = await heldInCycleOne();
    // The pending source's epoch seals a segment holding it.
    await writeEpochSegment(f, E2, 0, [tokBook("1", OLD + 2 * MIN), tokBook("3", OLD + 3 * MIN)]);
    const second = await runStorageCycle(
      dependencies(f, { bootClock, loadWindows: async () => [window], evidence: frontiersAt({ [EPOCH]: "100", [E2]: "100" }, evidence) }),
    );
    expect(second.classifications[0]).toMatchObject({ state: "classified", pinClass: "fill" });
    const outcome = second.pins[0];
    if (outcome === undefined || outcome.status !== "extracted") throw new Error("expected an extracted pin");
    expect(outcome.record.sourceEventsInside).toBe(true);
    expect(deletionPins(second, f.segments[0]?.segmentId)).toStrictEqual([outcome.pinId]);
    expect((await readEvidenceHolds(f.stateDir)).windows.get("w1")).toStrictEqual({ holds: [], settled: true, unreadable: false });
  });

  it("makes a hold the recheck reads durable before its deletion: a later cycle without the window still keeps the segment", async () => {
    const f = await fixture(segments(tradeFrame({ ingestSeq: "1", atMs: OLD - 2 * HOUR })));
    const bootClock = manualBootClock();
    // The plan reads no evidence yet; every recheck reads the located source and a pending one.
    let reads = 0;
    const growing: TraderEvidenceSource = {
      dispatchFrontiers: (instanceIds) => frontierAt("100", NONE).dispatchFrontiers(instanceIds),
      async marketEvidence() {
        reads += 1;
        return reads === 1 ? NONE : evidence;
      },
    };
    const first = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], evidence: growing }));
    expect(first.decisions[0]?.eligible).toBe(true);
    expect(first.expiry?.failures).toContainEqual({
      segmentId: f.segments[0]?.segmentId,
      detail: expect.stringMatching(/^kept on recheck: unclassified-window: w1 holds chain evidence in this segment/u),
    });
    bootClock.advance(30 * MIN);
    f.clock.setNowMs(NOW + 30 * MIN);
    const second = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [LATER_SAME_MARKET], evidence: growing }));
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
    expect(reasonsOf(second, f.segments[0]?.segmentId ?? "")).toStrictEqual([
      expect.stringMatching(/^evidence-hold: w1 holds chain evidence in this segment/u),
    ]);
  });
});

describe("L1: holds that are not durably known keep every segment", () => {
  const segments = () => [[tradeFrame({ ingestSeq: "1", atMs: OLD })], [tradeFrame({ ingestSeq: "2", atMs: NOW - HOUR })]];

  it("keeps every segment, and never overwrites the file, while the holds do not read; the control expires", async () => {
    const f = await fixture(segments());
    await mkdir(f.stateDir, { recursive: true });
    await writeFile(join(f.stateDir, EVIDENCE_HOLDS_FILE_NAME), "{");
    const report = await runStorageCycle(dependencies(f));
    expect(await walFiles(f)).toHaveLength(2);
    expect(reasonsOf(report, f.segments[0]?.segmentId ?? "")).toStrictEqual([expect.stringMatching(/^evidence-holds-unknown: /u)]);
    expect(await readFile(join(f.stateDir, EVIDENCE_HOLDS_FILE_NAME), "utf8")).toBe("{");
    // Control: the same WAL with no holds file.
    await rm(join(f.stateDir, EVIDENCE_HOLDS_FILE_NAME));
    const control = await runStorageCycle(dependencies(f));
    expect(control.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[0]?.segmentId]);
  });

  it("keeps every segment when the holds cannot be made durable", async () => {
    const f = await fixture(segments());
    // The temporary file the durable write needs cannot be created.
    await mkdir(join(f.stateDir, `${EVIDENCE_HOLDS_FILE_NAME}.${process.pid.toString(36)}.tmp`), { recursive: true });
    const report = await runStorageCycle(dependencies(f));
    expect(await walFiles(f)).toHaveLength(2);
    expect(report.expiry).toBeNull();
    expect(reasonsOf(report, f.segments[0]?.segmentId ?? "")).toStrictEqual([
      expect.stringMatching(/^evidence-holds-unknown: .*could not be made durable/u),
    ]);
  });
});

describe("L2: a pin record's range is checked against its id and its datasets before it can skip a segment", () => {
  // As K3: cycle 1 pins the window while every segment is younger than 72 h.
  const START = NOW - 72 * HOUR + 60 * MIN;
  const segments = () => [
    [tokBook("1", START - 24 * MIN), tokBook("2", START - 22 * MIN)], // S0: only the widened pin's lead-in covers it
    [tokBook("3", START - 10 * MIN), tokBook("4", START + 3 * MIN)], // S1: holds the source event (EPOCH, "4")
    [tokBook("5", START + 6 * MIN), tokBook("6", START + 9 * MIN)], // S2: the window
    [tradeFrame({ ingestSeq: "7", atMs: START + 20 * MIN })],
    [tradeFrame({ ingestSeq: "8", atMs: NOW + 3 * HOUR })],
  ];
  const window = MARKET_WINDOW(START, START + 10 * MIN);
  const evidence: MarketEvidence = {
    ...NONE,
    fillsAtMs: [START + 6 * MIN],
    intents: [{ evaluatedAtMs: START + 3 * MIN, sourceEventId: "src-4", gatewayEpoch: EPOCH, ingestSeq: "4" }],
  };

  async function rewriteRecordRange(f: StorageFixture, pinId: string): Promise<void> {
    const path = join(f.root, "objects", "pins", pinId, "pin.json");
    const record = JSON.parse(await readFile(path, "utf8")) as { from: string; to: string };
    record.from = record.from.replace(/^2026-/u, "2027-");
    record.to = record.to.replace(/^2026-/u, "2027-");
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  }

  const cases: [string, boolean, Partial<Pick<StorageCycleDependencies, "evidence" | "loadWindows">>][] = [];
  for (const damaged of [true, false]) {
    cases.push(["the trader's database is unreachable", damaged, { evidence: databaseDown }]);
    cases.push(["the window has left the registry", damaged, { loadWindows: async () => [LATER_SAME_MARKET] }]);
  }

  it.each(cases)("keeps the segment when %s and its record's range was rewritten (its copy damaged: %s)", async (_trigger, damaged, change) => {
    const f = await fixture(segments());
    const bootClock = manualBootClock();
    const first = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], evidence: frontierAt("8", evidence) }));
    const outcome = first.pins[0];
    if (outcome === undefined || outcome.status !== "extracted") throw new Error("expected an extracted pin");
    expect(outcome.record.datasets.flatMap((dataset) => dataset.segmentIds)).toContain(f.segments[0]?.segmentId);
    if (damaged) await damagePinObject(f, outcome.pinId, f.segments[0]?.segmentId ?? "");
    await rewriteRecordRange(f, outcome.pinId);
    bootClock.advance(2 * HOUR);
    f.clock.setNowMs(NOW + 2 * HOUR);
    const second = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], evidence: frontierAt("8", evidence), ...change }));
    expect(deletionPins(second, f.segments[0]?.segmentId)).toBeNull();
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
    expect(reasonsOf(second, f.segments[0]?.segmentId ?? "")).toContainEqual(
      expect.stringMatching(new RegExp(`^pin-record-unreadable: ${outcome.pinId}: .*not the pin its id names`, "u")),
    );
  });
});

describe("L3: a window's own pin resolves a source whose whole gateway epoch expired under it", () => {
  it("binds the window to that pin and expires its later segments under it, cycle after cycle", async () => {
    const START = NOW - 71 * HOUR;
    // EPOCH ended with one segment: the source (EPOCH, "2"), two hours before the window.
    const f = await fixture([[tokBook("1", START - 2 * HOUR)]]);
    const windowSegment = await writeEpochSegment(f, E2, 0, [tokBook("3", START)]);
    await writeEpochSegment(f, E2, 1, [tradeFrame({ ingestSeq: "5", atMs: NOW - HOUR })]);
    const evidence: MarketEvidence = {
      ...NONE,
      fillsAtMs: [START + MIN],
      intents: [{ evaluatedAtMs: START, sourceEventId: "src-E1", gatewayEpoch: EPOCH, ingestSeq: "2" }],
    };
    const bootClock = manualBootClock();
    const deps = () =>
      dependencies(f, {
        bootClock,
        loadWindows: async () => [MARKET_WINDOW(START, START + 15 * MIN)],
        evidence: frontiersAt({ [EPOCH]: "100", [E2]: "100" }, evidence),
      });
    const first = await runStorageCycle(deps());
    const pin = first.pins[0];
    if (pin === undefined || pin.status !== "extracted") throw new Error("expected an extracted pin");
    expect(pin.record.sourceEventsInside).toBe(true);
    expect(pin.record.datasets.map((dataset) => dataset.gatewayEpoch)).toStrictEqual([EPOCH, E2]);
    // The source's whole epoch expires under the pin.
    expect(first.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[0]?.segmentId]);
    expect(await walFiles(f)).toStrictEqual([]);
    for (const step of [1, 2]) {
      bootClock.advance(2 * HOUR);
      f.clock.setNowMs(NOW + 2 * HOUR * step);
      const report = await runStorageCycle(deps());
      expect(report.classifications[0]).toMatchObject({ state: "classified", pinClass: "fill" });
      expect(report.pins.map((outcome) => [outcome.pinId, outcome.status])).toStrictEqual([[pin.pinId, "already-extracted"]]);
      if (step === 1) expect(deletionPins(report, windowSegment.segmentId)).toStrictEqual([pin.pinId]);
    }
    expect(await onDisk(f, E2, windowSegment)).toBe(false);
    expect(await windowPinDirectories(f)).toStrictEqual([pin.pinId]);
  });
});

describe("L4: no window pin is extracted while the pin catalog does not read in full", () => {
  it("binds the window to its first pin after a failed listing, with no second pin and nothing held forever", async () => {
    // As K4.
    const START = NOW - 72 * HOUR + 10 * MIN;
    const f = await fixture([
      [tokBook("1", START - 61 * MIN), tokBook("2", START - 60 * MIN)], // S0: the source (EPOCH, "2")
      [tokBook("3", START - 30 * MIN)], // S1
      [tokBook("4", START + MIN), tokBook("5", START + 4 * MIN)], // S2: the window
      [tradeFrame({ ingestSeq: "6", atMs: START + 20 * MIN })],
      [tradeFrame({ ingestSeq: "7", atMs: NOW })],
    ]);
    const evidence: MarketEvidence = {
      ...NONE,
      fillsAtMs: [START + 4 * MIN],
      intents: [{ evaluatedAtMs: START + 3 * MIN, sourceEventId: "src-2", gatewayEpoch: EPOCH, ingestSeq: "2" }],
    };
    const store = f.objectStore;
    let failNextListing = false;
    const flaky: ObjectStore = {
      put: (key, bytes) => store.put(key, bytes),
      head: (key) => store.head(key),
      get: (key) => store.get(key),
      async list(prefix) {
        if (failNextListing) {
          failNextListing = false;
          throw Object.assign(new Error("EIO: i/o error, scandir"), { code: "EIO" });
        }
        if (store.list === undefined) throw new Error("the fixture store lists");
        return await store.list(prefix);
      },
    };
    const bootClock = manualBootClock();
    const deps = () =>
      dependencies(f, { objectStore: flaky, bootClock, loadWindows: async () => [MARKET_WINDOW(START, START + 10 * MIN)], evidence: frontierAt("7", evidence) });
    const first = await runStorageCycle(deps());
    const pinId = first.pins[0]?.pinId;
    expect(first.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[0]?.segmentId, f.segments[1]?.segmentId]);
    // Cycle 2: the catalog's listing fails once.
    bootClock.advance(30 * MIN);
    f.clock.setNowMs(NOW + 30 * MIN);
    failNextListing = true;
    const second = await runStorageCycle(deps());
    expect(second.pins).toStrictEqual([
      { pinId: expect.stringMatching(/^window-w1-/u), status: "waiting", reason: expect.stringMatching(/the pin catalog did not read in full/u) },
    ]);
    expect(await walFiles(f)).toContain(f.segments[2]?.segmentFileName);
    // Cycle 3: it reads, and the window is bound to its first pin.
    bootClock.advance(30 * MIN);
    f.clock.setNowMs(NOW + 60 * MIN);
    const third = await runStorageCycle(deps());
    expect(third.pins.map((outcome) => [outcome.pinId, outcome.status])).toStrictEqual([[pinId, "already-extracted"]]);
    expect(deletionPins(third, f.segments[2]?.segmentId)).toStrictEqual([pinId]);
    expect(await walFiles(f)).not.toContain(f.segments[2]?.segmentFileName);
    expect(await windowPinDirectories(f)).toStrictEqual([pinId]);
  });
});

// -- Round 4 ------------------------------------------------------------------

describe("M1: a classified window's whole pin extent is held, durably, until its pin is settled, whatever the registry says", () => {
  // As L1: S0 holds the located source (EPOCH, "2"), a reference-feed frame
  // two hours before the window, which names no market; S1 is the window's
  // own book; S2 lies after the window, outside every range it could pin; S3
  // is young, and carries the WAL past the range.
  const located = { evaluatedAtMs: OLD, sourceEventId: "located", gatewayEpoch: EPOCH, ingestSeq: "2" };
  const evidence: MarketEvidence = { ...NONE, fillsAtMs: [OLD + MIN], intents: [located] };
  const window = MARKET_WINDOW(OLD, OLD + 15 * MIN);
  const EXTENT = { fromMs: OLD - 2 * HOUR - 15 * MIN, toMs: OLD + 15 * MIN };
  const segments = () => [
    [tradeFrame({ ingestSeq: "1", atMs: OLD - 2 * HOUR })],
    [tokBook("3", OLD)],
    [tradeFrame({ ingestSeq: "5", atMs: OLD + 20 * MIN })],
    [tradeFrame({ ingestSeq: "7", atMs: NOW - HOUR })],
  ];

  /** A store whose pin writes, or whose first pin listing, fail while `armed`. */
  function faultyStore(store: ObjectStore, fault: "pin-write" | "catalog-listing"): { store: ObjectStore; disarm(): void } {
    let armed = true;
    return {
      disarm() {
        armed = false;
      },
      store: {
        async put(key, bytes) {
          if (armed && fault === "pin-write" && key.startsWith("pins/")) {
            throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
          }
          await store.put(key, bytes);
        },
        head: (key) => store.head(key),
        get: (key) => store.get(key),
        async list(prefix) {
          if (armed && fault === "catalog-listing" && prefix === "pins") {
            armed = false;
            throw Object.assign(new Error("EIO: i/o error, scandir"), { code: "EIO" });
          }
          if (store.list === undefined) throw new Error("the fixture store lists");
          return await store.list(prefix);
        },
      },
    };
  }

  type Trigger = "batch-delay" | "pin-write" | "catalog-listing" | "recheck-learned";
  /**
   * Cycle 1 classifies w1 with a fill, but settles no pin for it. Returns the
   * dependencies for later cycles, with the trigger cleared.
   */
  async function classifiedUnsettled(trigger: Trigger): Promise<{
    f: StorageFixture;
    first: StorageCycleReport;
    later: (extra: Partial<StorageCycleDependencies>) => StorageCycleDependencies;
  }> {
    const f = await fixture(segments());
    const bootClock = manualBootClock();
    let store: ObjectStore = f.objectStore;
    let source: TraderEvidenceSource = frontierAt("100", evidence);
    let batchDelayMs = 0;
    let disarm = (): void => undefined;
    if (trigger === "batch-delay") {
      // The production default batch delay, and no fault: every segment above
      // is extracted, and one sealed ten minutes ago waits for its batch, so
      // the window's pin waits on it.
      await f.extract();
      const young = buildSegmentFixture({
        gatewayEpoch: EPOCH,
        segmentIndex: 4,
        frames: [tradeFrame({ ingestSeq: "9", atMs: NOW - 12 * MIN })],
        createdAt: new Date(NOW - 15 * MIN).toISOString(),
        closedAt: new Date(NOW - 10 * MIN).toISOString(),
      });
      await writeFile(join(f.walDir, young.segmentFileName), young.segmentBytes);
      await writeFile(join(f.walDir, young.manifestFileName), young.manifestBytes);
      batchDelayMs = HOUR;
    } else if (trigger === "pin-write" || trigger === "catalog-listing") {
      const faulty = faultyStore(f.objectStore, trigger);
      store = faulty.store;
      disarm = () => faulty.disarm();
    } else {
      // The plan reads no evidence (the window classifies with none); every
      // recheck, and every later cycle, reads the fill.
      let reads = 0;
      source = {
        dispatchFrontiers: (instanceIds) => frontierAt("100", evidence).dispatchFrontiers(instanceIds),
        async marketEvidence() {
          reads += 1;
          return reads === 1 ? NONE : evidence;
        },
      };
    }
    const deps = (extra: Partial<StorageCycleDependencies>): StorageCycleDependencies => {
      const base = dependencies(f, { bootClock, objectStore: store, loadWindows: async () => [window], evidence: source });
      return { ...base, ...extra, settings: { ...base.settings, extractionBatchDelayMs: batchDelayMs } };
    };
    const first = await runStorageCycle(deps({}));
    expect(first.classifications[0]).toMatchObject({ state: "classified", pinClass: trigger === "recheck-learned" ? null : "fill" });
    expect(first.pins.filter((outcome) => outcome.status !== "waiting")).toStrictEqual([]);
    if (trigger === "pin-write") expect(first.pinFailures).toStrictEqual([{ pinId: expect.stringMatching(/^window-w1-/u), detail: expect.stringMatching(/ENOSPC/u) }]);
    if (trigger === "recheck-learned") {
      expect(first.expiry?.failures).toContainEqual({ segmentId: f.segments[0]?.segmentId, detail: expect.stringMatching(/^kept on recheck: /u) });
    }
    // Only the segment after the window went.
    expect(first.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[2]?.segmentId]);
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
    expect(await walFiles(f)).toContain(f.segments[1]?.segmentFileName);
    disarm();
    bootClock.advance(HOUR);
    f.clock.setNowMs(NOW + HOUR);
    return { f, first, later: deps };
  }

  const triggers: Trigger[] = ["batch-delay", "pin-write", "catalog-listing", "recheck-learned"];
  const registries: [string, readonly MarketWindow[]][] = [
    ["with no window of its market registered", []],
    ["with another window of the same market still registered", [LATER_SAME_MARKET]],
  ];
  const removals = triggers.flatMap((trigger) => registries.map(([name, windows]) => [trigger, name, windows] as const));

  it.each(removals)("(%s) keeps the chain source's segment and the window's own, %s, once the window leaves the registry", async (trigger, _name, windows) => {
    const { f, first, later } = await classifiedUnsettled(trigger);
    const second = await runStorageCycle(later({ loadWindows: async () => windows }));
    expect(deletionPins(second, f.segments[0]?.segmentId)).toBeNull();
    expect(deletionPins(second, f.segments[1]?.segmentId)).toBeNull();
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
    expect(await walFiles(f)).toContain(f.segments[1]?.segmentFileName);
    for (const segment of [f.segments[0], f.segments[1]]) {
      expect(reasonsOf(second, segment?.segmentId ?? "")).toContainEqual(
        expect.stringMatching(/^evidence-hold: w1 holds chain evidence in this segment until its pin holds it/u),
      );
    }
    // Cycle 1 made w1's whole pin extent, the located source's segment
    // included, durable — in the recheck, before its deletion — and it stays
    // durable after the removal, and in the cycle after.
    if (trigger === "recheck-learned") {
      expect(first.expiry?.failures).toContainEqual({
        segmentId: f.segments[0]?.segmentId,
        detail: expect.stringMatching(/^kept on recheck: .*evidence-hold: w1 holds chain evidence in this segment/u),
      });
    }
    expect((await readEvidenceHolds(f.stateDir)).windows.get("w1")).toStrictEqual({ holds: [EXTENT], settled: false, unreadable: false });
    f.clock.setNowMs(NOW + 2 * HOUR);
    await runStorageCycle(later({ loadWindows: async () => windows, bootClock: null, mode: "dry-run", deletion: null }));
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
  });

  it.each(triggers)("(%s) releases the hold once the window's pin is extracted: the source and the window then expire under it", async (trigger) => {
    const { f, later } = await classifiedUnsettled(trigger);
    const second = await runStorageCycle(later({}));
    const outcome = second.pins[0];
    if (outcome === undefined || outcome.status !== "extracted") throw new Error(`expected an extracted pin, got ${JSON.stringify(second.pins)}`);
    expect(outcome.record.sourceEventsInside).toBe(true);
    expect(deletionPins(second, f.segments[0]?.segmentId)).toStrictEqual([outcome.pinId]);
    expect(deletionPins(second, f.segments[1]?.segmentId)).toStrictEqual([outcome.pinId]);
    expect((await readEvidenceHolds(f.stateDir)).windows.get("w1")).toStrictEqual({ holds: [], settled: true, unreadable: false });
  });

  it("control: a window pinned in the cycle it classifies holds nothing; its segments expire under the pin, and its removal changes nothing", async () => {
    const f = await fixture(segments());
    const bootClock = manualBootClock();
    const first = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [window], evidence: frontierAt("100", evidence) }));
    const outcome = first.pins[0];
    if (outcome === undefined || outcome.status !== "extracted") throw new Error("expected an extracted pin");
    expect(deletionPins(first, f.segments[0]?.segmentId)).toStrictEqual([outcome.pinId]);
    expect(deletionPins(first, f.segments[1]?.segmentId)).toStrictEqual([outcome.pinId]);
    expect((await readEvidenceHolds(f.stateDir)).windows.get("w1")).toStrictEqual({ holds: [], settled: true, unreadable: false });
    bootClock.advance(HOUR);
    f.clock.setNowMs(NOW + HOUR);
    await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [LATER_SAME_MARKET], evidence: frontierAt("100", evidence) }));
    expect((await readEvidenceHolds(f.stateDir)).windows.has("w1")).toBe(false);
    expect(await windowPinDirectories(f)).toStrictEqual([outcome.pinId]);
  });
});

describe("M2: the holds file's own guards, with the real writer and reader, in a real cycle", () => {
  /** The real calls, the holds file's first read, or one sync, failing once. */
  function failingOnce(fault: "read" | "file-sync" | "directory-sync", path: string): { operations: EvidenceHoldsFileOperations; failures: () => number } {
    const real = nodeEvidenceHoldsFileOperations;
    let failures = 0;
    const fail = (step: string): never => {
      failures += 1;
      throw Object.assign(new Error(`EIO: i/o error, ${step}`), { code: "EIO" });
    };
    return {
      failures: () => failures,
      operations: {
        mkdir: (directory) => real.mkdir(directory),
        async open(target, flags, mode) {
          const handle = await real.open(target, flags, mode);
          const directory = target !== `${path}.${process.pid.toString(36)}.tmp`;
          return {
            writeFile: (bytes) => handle.writeFile(bytes),
            async sync() {
              if (failures === 0 && fault === (directory ? "directory-sync" : "file-sync")) fail(fault);
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
        rename: (oldPath, newPath) => real.rename(oldPath, newPath),
        async readFile(target) {
          if (failures === 0 && fault === "read" && target === path) fail("read");
          return await real.readFile(target);
        },
      },
    };
  }

  it("a holds file the cycle cannot read (EIO, not ENOENT) keeps every segment, and is never overwritten: the hold survives", async () => {
    // Cycle 1 holds w1's located source (L1); then w1 leaves the registry.
    const located = { evaluatedAtMs: OLD, sourceEventId: "located", gatewayEpoch: EPOCH, ingestSeq: "2" };
    const pending = { evaluatedAtMs: OLD + MIN, sourceEventId: "pending", gatewayEpoch: E2, ingestSeq: "2" };
    const f = await fixture([
      [tradeFrame({ ingestSeq: "1", atMs: OLD - 2 * HOUR })],
      [tokBook("3", OLD)],
      [tradeFrame({ ingestSeq: "5", atMs: OLD + 20 * MIN })],
      [tradeFrame({ ingestSeq: "7", atMs: NOW - HOUR })],
    ]);
    const bootClock = manualBootClock();
    await runStorageCycle(
      dependencies(f, { bootClock, loadWindows: async () => [MARKET_WINDOW(OLD, OLD + 15 * MIN)], evidence: frontierAt("100", { ...NONE, fillsAtMs: [OLD + MIN], intents: [located, pending] }) }),
    );
    const before = await readFile(evidenceHoldsPath(f.stateDir));
    expect((await readEvidenceHolds(f.stateDir)).windows.get("w1")?.holds.length).toBe(1);
    bootClock.advance(30 * MIN);
    f.clock.setNowMs(NOW + 30 * MIN);
    const transient = failingOnce("read", evidenceHoldsPath(f.stateDir));
    const second = await runStorageCycle(
      dependencies(f, { bootClock, loadWindows: async () => [LATER_SAME_MARKET], evidenceHoldsFileSystem: evidenceHoldsFileSystem(transient.operations) }),
    );
    expect(transient.failures()).toBe(1);
    expect(second.expiry).toBeNull();
    for (const decision of second.decisions) {
      expect(decision.reasons).toContainEqual(expect.stringMatching(/^evidence-holds-unknown: the evidence holds .* could not be read: EIO/u));
    }
    expect(await readFile(evidenceHoldsPath(f.stateDir))).toStrictEqual(before);
    // The read works again: the hold is still there, and still keeps the source.
    bootClock.advance(30 * MIN);
    f.clock.setNowMs(NOW + HOUR);
    const third = await runStorageCycle(dependencies(f, { bootClock, loadWindows: async () => [LATER_SAME_MARKET] }));
    expect(await walFiles(f)).toContain(f.segments[0]?.segmentFileName);
    expect(reasonsOf(third, f.segments[0]?.segmentId ?? "")).toStrictEqual([expect.stringMatching(/^evidence-hold: w1 holds chain evidence/u)]);
  });

  it.each(["file-sync", "directory-sync"] as const)("a %s of the holds that fails keeps every segment; the control expires", async (fault) => {
    const f = await fixture([[tradeFrame({ ingestSeq: "1", atMs: OLD })], [tradeFrame({ ingestSeq: "2", atMs: NOW - HOUR })]]);
    const failing = failingOnce(fault, evidenceHoldsPath(f.stateDir));
    const report = await runStorageCycle(dependencies(f, { evidenceHoldsFileSystem: evidenceHoldsFileSystem(failing.operations) }));
    expect(failing.failures()).toBe(1);
    expect(report.expiry).toBeNull();
    expect(await walFiles(f)).toHaveLength(2);
    expect(reasonsOf(report, f.segments[0]?.segmentId ?? "")).toStrictEqual([
      expect.stringMatching(new RegExp(`^evidence-holds-unknown: .*could not be made durable: EIO: i/o error, ${fault}`, "u")),
    ]);
    // Control: the same cycle once the sync works.
    const control = await runStorageCycle(dependencies(f, { evidenceHoldsFileSystem: evidenceHoldsFileSystem(failing.operations) }));
    expect(control.expiry?.deleted.map((entry) => entry.segmentId)).toStrictEqual([f.segments[0]?.segmentId]);
  });
});
