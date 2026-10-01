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
 */

import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExpiredSegmentDeletion } from "@polymarket-bot/storage-parquet";
import {
  EXPIRY_OPT_IN_MARKER_CONTENT,
  EXPIRY_OPT_IN_MARKER_FILE_NAME,
  expireAfterExtractDeletion,
  nodeCompactionFileSystem,
  readParquetObject,
} from "@polymarket-bot/storage-parquet";
import { buildSegmentFixture } from "@polymarket-bot/storage-parquet/testing";

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
