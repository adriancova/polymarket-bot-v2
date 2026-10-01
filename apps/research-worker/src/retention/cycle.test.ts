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
    const lock = fileOperatorPinLock(operatorPinLockPath(pinsPath), { pollMs: 20 });
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
              lock: fileOperatorPinLock(operatorPinLockPath(pinsPath), { pollMs: 5 }),
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
    // The plan reads no evidence; every later read finds the intent.
    let reads = 0;
    const report = await runStorageCycle(
      dependencies(f, {
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
