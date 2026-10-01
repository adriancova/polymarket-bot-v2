/**
 * One storage cycle end to end (`STORAGE-1`): segments written by the real
 * `WP-050` writer, the research tier extracted, a window classified and
 * pinned, the plan made durable, and only verified, old, unpinned-or-pinned-
 * and-preserved segments expired — through the real filesystem deletion, in a
 * temporary directory.
 *
 * Acceptance lines this suite exercises end to end: "A segment is never
 * deleted unless it is 72 h old, its research tier is verified, its windows
 * are classified, and every overlapping pin is verified"; "A fill pin is never
 * evicted or reduced; a budget overrun only alarms"; "The expiry plan is
 * durable before any deletion; the receipt is reporting, not proof"; and the
 * dry-run default.
 */

import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXPIRY_OPT_IN_MARKER_CONTENT,
  EXPIRY_OPT_IN_MARKER_FILE_NAME,
  expireAfterExtractDeletion,
  fileSystemObjectStore,
  nodeCompactionFileSystem,
  parseRetentionReceipt,
  readParquetObject,
} from "@polymarket-bot/storage-parquet";
import type { ObjectStore, RawFrameRecord } from "@polymarket-bot/storage-parquet";
import { buildRawFrameRecord } from "@polymarket-bot/storage-wal";
import { manualClock } from "@polymarket-bot/storage-parquet/testing";
import {
  listExpiryPlanIds,
  readPinRecord,
  runStorageCycle,
  staticEvidenceSource,
} from "@polymarket-bot/research-worker";
import type { MarketWindow, OperatorPin, StorageCycleReport } from "@polymarket-bot/research-worker";

import { createWorkspace, GATEWAY_EPOCH, recordFrames } from "./context.js";
import type { TemporaryWorkspace } from "./context.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const OLD = NOW - 80 * HOUR;

const WINDOW: MarketWindow = {
  windowId: "btc-updown-15m-test",
  marketId: "m1",
  conditionId: "0xc1",
  tokenIds: ["tokA"],
  windowStartMs: OLD + 10 * 60 * 1000,
  windowEndMs: OLD + 25 * 60 * 1000,
  responsibleFromMs: OLD + 10 * 60 * 1000,
  responsibility: { kind: "trader", instanceIds: ["inst-1"] },
};

function polymarketBook(ingestSeq: number, atMs: number): RawFrameRecord {
  return buildRawFrameRecord({
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(ingestSeq),
    source: "polymarket",
    endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    connectionId: "pm-1",
    subscriptionGeneration: 0,
    receivedAt: new Date(atMs).toISOString(),
    receivedMonotonicNs: String(ingestSeq * 1_000_000),
    payloadUtf8: JSON.stringify([
      {
        event_type: "book",
        market: "0xc1",
        asset_id: "tokA",
        bids: [{ price: "0.40", size: String(10 + ingestSeq) }],
        asks: [{ price: "0.60", size: "5" }],
        timestamp: "1",
      },
    ]),
  });
}

function binanceTrade(ingestSeq: number, atMs: number): RawFrameRecord {
  return buildRawFrameRecord({
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(ingestSeq),
    source: "binance",
    endpoint: "wss://data-stream.binance.vision/stream",
    connectionId: "bn-1",
    subscriptionGeneration: 0,
    receivedAt: new Date(atMs).toISOString(),
    receivedMonotonicNs: String(ingestSeq * 1_000_000),
    payloadUtf8: JSON.stringify({
      stream: "btcusdt@trade",
      data: { e: "trade", E: 1, s: "BTCUSDT", t: ingestSeq, p: "100.5", q: "0.25", T: 1, m: false, M: true },
    }),
  });
}

let workspace: TemporaryWorkspace;
let objectStore: ObjectStore;

beforeEach(async () => {
  workspace = await createWorkspace();
  objectStore = fileSystemObjectStore(workspace.objectStoreRoot);
});

afterEach(async () => {
  await workspace.cleanup();
});

/** Frames from 80 h ago through the window, and some 10 h ago. */
async function record(): Promise<void> {
  const frames: RawFrameRecord[] = [];
  let seq = 1;
  for (let minute = 0; minute < 40; minute += 2) {
    frames.push(polymarketBook(seq++, OLD + minute * 60 * 1000));
    frames.push(binanceTrade(seq++, OLD + minute * 60 * 1000 + 500));
  }
  for (let minute = 0; minute < 6; minute += 2) {
    frames.push(binanceTrade(seq++, NOW - 10 * HOUR + minute * 60 * 1000));
  }
  // A small rotation bound gives many segments.
  await recordFrames(workspace.walDirectoryPath, frames, { maxSegmentBytes: 3000 });
}

async function cycle(input: {
  readonly mode: "dry-run" | "execute";
  readonly durableThroughMs: number;
  readonly pinBudgetBytesPerDay?: number;
  readonly loadOperatorPins?: () => Promise<readonly OperatorPin[]>;
}): Promise<StorageCycleReport> {
  return await runStorageCycle({
    walRootPath: workspace.walDirectoryPath,
    objectStore,
    fileSystem: nodeCompactionFileSystem(),
    clock: manualClock(NOW),
    evidence: staticEvidenceSource({
      durableThroughMs: new Map([["inst-1", input.durableThroughMs]]),
      evidence: new Map([
        [
          "m1",
          {
            fillsAtMs: [OLD + 15 * 60 * 1000],
            intents: [{ evaluatedAtMs: OLD + 12 * 60 * 1000, sourceEventId: null, gatewayEpoch: null, ingestSeq: null }],
            refusalsAtMs: [],
            haltsAtMs: [],
          },
        ],
      ]),
    }),
    loadWindows: async () => [WINDOW],
    loadOperatorPins: input.loadOperatorPins ?? (async () => []),
    settings: {
      retentionMs: 72 * HOUR,
      leadInMs: 5 * 60 * 1000,
      durabilityGraceMs: 60_000,
      pinBudgetBytesPerDay: input.pinBudgetBytesPerDay ?? 3_000_000_000,
      expiryStuckAfterMs: 6 * HOUR,
      walMaxTotalBytes: null,
      maxSegmentsPerDataset: 64,
      extractionBatchDelayMs: 0,
    },
    mode: input.mode,
    deletion: input.mode === "execute" ? expireAfterExtractDeletion({ walRootPath: workspace.walDirectoryPath, objectStore }) : null,
    stateDirectory: join(workspace.root, "state"),
  });
}

async function segmentFiles(): Promise<string[]> {
  return (await readdir(workspace.walDirectoryPath)).filter((name) => name.endsWith(".wal.jsonl")).sort();
}

describe("a storage cycle, end to end", () => {
  it("dry-run (the default) extracts, classifies and pins, and deletes nothing", async () => {
    await record();
    const before = await segmentFiles();
    const report = await cycle({ mode: "dry-run", durableThroughMs: NOW });
    expect(report.extraction.refused).toStrictEqual([]);
    expect(report.classifications).toMatchObject([{ state: "classified", pinClass: "fill" }]);
    expect(report.pins).toMatchObject([{ pinId: expect.stringMatching(/^window-btc-updown-15m-test-[0-9a-f]{12}$/u), status: "extracted" }]);
    expect(report.expiry).toBeNull();
    expect(await segmentFiles()).toStrictEqual(before);
    expect(await listExpiryPlanIds(join(workspace.root, "state"))).toStrictEqual([]);
    // The old segments are eligible; the young ones are not.
    const eligible = report.decisions.filter((decision) => decision.eligible);
    expect(eligible.length).toBeGreaterThan(0);
    expect(report.decisions.some((decision) => decision.reasons.some((reason) => reason.startsWith("younger-than-retention")))).toBe(true);
  });

  it("keeps every old segment the window could pin while its trader's rows are not durable", async () => {
    await record();
    const report = await cycle({ mode: "dry-run", durableThroughMs: WINDOW.windowEndMs });
    expect(report.classifications).toMatchObject([{ state: "unclassified" }]);
    expect(report.pins).toStrictEqual([]);
    const overlapping = report.decisions.filter((decision) =>
      decision.reasons.some((reason) => reason.startsWith("unclassified-window")),
    );
    expect(overlapping.length).toBeGreaterThan(0);
    expect(overlapping.every((decision) => !decision.eligible)).toBe(true);
  });

  it("execute without the opt-in marker makes the plan durable and deletes nothing", async () => {
    await record();
    const before = await segmentFiles();
    const report = await cycle({ mode: "execute", durableThroughMs: NOW });
    expect(report.expiry?.deleted).toStrictEqual([]);
    expect(report.expiry?.failures.every((failure) => /has not opted in/u.test(failure.detail))).toBe(true);
    expect(await segmentFiles()).toStrictEqual(before);
    expect(await listExpiryPlanIds(join(workspace.root, "state"))).toHaveLength(1);
  });

  it("execute with the marker deletes only the eligible segments; a pinned one survives byte-exactly in its pin", async () => {
    await record();
    await writeFile(join(workspace.walDirectoryPath, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const before = await segmentFiles();
    // A budget of one byte: the pin is over budget. It only alarms.
    const report = await cycle({ mode: "execute", durableThroughMs: NOW, pinBudgetBytesPerDay: 1 });
    const expiry = report.expiry;
    if (expiry === null) throw new Error("expected an expiry run");
    expect(expiry.failures).toStrictEqual([]);
    const eligible = report.decisions.filter((decision) => decision.eligible).map((decision) => decision.segment.segmentId);
    expect(expiry.deleted.map((deletion) => deletion.segmentId).sort()).toStrictEqual([...eligible].sort());
    const after = await segmentFiles();
    expect(after.length).toBe(before.length - eligible.length);
    // Young segments are all still there.
    for (const decision of report.decisions.filter((candidate) => !candidate.eligible)) {
      expect(after).toContain(`${decision.segment.segmentId}.wal.jsonl`);
    }

    // The fill pin was over budget and is untouched: record and objects present.
    expect(report.metrics.pinBudget.exceeded).toBe(true);
    const pinId = report.pins[0]?.pinId ?? "";
    const pin = await readPinRecord(objectStore, pinId);
    if (pin === null) throw new Error("the pin record is gone");
    expect(pin.keepUntil).toBeNull();
    const pinnedIds = pin.datasets.flatMap((dataset) => dataset.segmentIds);
    expect(pinnedIds.length).toBeGreaterThan(0);

    // Every deleted segment the pin overlapped is preserved in the pin, frame for frame.
    const receipt = parseRetentionReceipt(JSON.parse(Buffer.from(await objectStore.get(expiry.receiptObjectKey)).toString("utf8")));
    expect(receipt.retentionReceiptVersion).toBe(2);
    expect(receipt.expiryPlanId).toBe(expiry.planId);
    const pinnedDeletions = receipt.deletedSegments.filter(
      (deletion) => deletion.basis === "expired-after-extract" && deletion.pins.length > 0,
    );
    expect(pinnedDeletions.length).toBeGreaterThan(0);
    for (const deletion of pinnedDeletions) {
      expect(pinnedIds).toContain(deletion.segmentId);
      const dataset = pin.datasets.find((candidate) => candidate.segmentIds.includes(deletion.segmentId));
      if (dataset === undefined) throw new Error("no pin dataset");
      const objectKey = `${dataset.manifestObjectKey.replace(/manifest\.json$/u, "")}${deletion.segmentId}.parquet`;
      const rows = await readParquetObject(await objectStore.get(objectKey));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.segmentId === deletion.segmentId)).toBe(true);
    }

    // A second cycle finds nothing more to delete and changes no pin.
    const again = await cycle({ mode: "execute", durableThroughMs: NOW });
    expect(again.expiry).toBeNull();
    expect(again.pins).toMatchObject([{ pinId, status: "already-extracted" }]);
    expect(await readPinRecord(objectStore, pinId)).toStrictEqual(pin);
  });

  it("re-decides each segment right before its deletion: an operator pin added after planning keeps it", async () => {
    await record();
    await writeFile(join(workspace.walDirectoryPath, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const before = await segmentFiles();
    let calls = 0;
    const report = await cycle({
      mode: "execute",
      durableThroughMs: NOW,
      // Planning reads no operator pin; every read after it (the per-segment
      // recheck) finds one covering everything old.
      loadOperatorPins: async () => {
        calls += 1;
        return calls === 1 ? [] : [{ pinId: "late", fromMs: OLD - HOUR, toMs: NOW - 72 * HOUR, reason: "added after planning" }];
      },
    });
    const expiry = report.expiry;
    if (expiry === null) throw new Error("expected an expiry run");
    expect(expiry.deleted).toStrictEqual([]);
    expect(expiry.failures.length).toBeGreaterThan(0);
    expect(expiry.failures.every((failure) => /kept on recheck: .*operator-pin: operator-late/u.test(failure.detail))).toBe(true);
    expect(await segmentFiles()).toStrictEqual(before);
  });
});
