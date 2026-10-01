/**
 * The research-tier extractor (`STORAGE-1`; ADR-028 Decision 2.6).
 *
 * Acceptance line pinned here: "The extractor runs validateSegment on each
 * sealed segment before it reads it, and computes both digests from the
 * verified bytes; a segment that fails is not extracted and never expires
 * (ADR-028 Decision 2.6)." Also: the age a segment expires by is the maximum
 * receipt instant over its frames, not the last one's (Decision 2.1).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompactionFileSystem } from "@polymarket-bot/storage-parquet";
import { nodeCompactionFileSystem, sha256Hex, verifyResearchTierDataset } from "@polymarket-bot/storage-parquet";
import { buildSegmentFixture, manualClock, memoryObjectStore } from "@polymarket-bot/storage-parquet/testing";
import type { FrameInput, SegmentFixture } from "@polymarket-bot/storage-parquet/testing";
import { validateSegment } from "@polymarket-bot/storage-wal";

import { extractResearchTier, readResearchPointer } from "./extract.js";
import { inventoryWalRoot } from "./inventory.js";
import { verifySegmentForExtraction } from "./segment-verify.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";

let root: string;
let walDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "storage1-extract-"));
  walDir = join(root, "wal", EPOCH);
  await mkdir(walDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function binanceTrade(id: number, price: string): string {
  return JSON.stringify({
    stream: "btcusdt@trade",
    data: { e: "trade", E: 1, s: "BTCUSDT", t: id, p: price, q: "1", T: 1, m: false, M: true },
  });
}

function segment(index: number, frames: readonly FrameInput[]): SegmentFixture {
  return buildSegmentFixture({ gatewayEpoch: EPOCH, segmentIndex: index, frames });
}

async function place(fixture: SegmentFixture): Promise<void> {
  await writeFile(join(walDir, fixture.segmentFileName), fixture.segmentBytes);
  await writeFile(join(walDir, fixture.manifestFileName), fixture.manifestBytes);
}

const binance = { source: "binance", endpoint: "wss://data-stream.binance.vision/stream" } as const;

describe("verifySegmentForExtraction", () => {
  it("runs the WAL's validateSegment before anything reads the frames, and refuses what it refuses", async () => {
    const fixture = segment(0, [{ ingestSeq: "1", payloadUtf8: binanceTrade(1, "1"), ...binance }]);
    await place(fixture);
    const calls: string[] = [];
    const accepted = await verifySegmentForExtraction({
      fileSystem: nodeCompactionFileSystem(),
      walDirectoryPath: walDir,
      segmentId: fixture.segmentId,
      validate: async (...args) => {
        calls.push(args[2]);
        return await validateSegment(...args);
      },
    });
    expect(calls).toStrictEqual([fixture.segmentId]);
    expect(accepted.status).toBe("verified");

    // A refusal by the WAL's own validator is final, even though the
    // compactor's reader would accept the very same bytes.
    const refused = await verifySegmentForExtraction({
      fileSystem: nodeCompactionFileSystem(),
      walDirectoryPath: walDir,
      segmentId: fixture.segmentId,
      validate: async (...args) => ({ ...(await validateSegment(...args)), valid: false, issues: [{ code: "CHECKSUM_MISMATCH", message: "probe" }] }),
    });
    expect(refused).toMatchObject({ status: "refused", reasons: ["CHECKSUM_MISMATCH: probe"] });
  });

  it("refuses a segment whose bytes no longer match its manifest", async () => {
    const fixture = segment(0, [{ ingestSeq: "1", payloadUtf8: binanceTrade(1, "100"), ...binance }]);
    const corrupt = Buffer.from(Buffer.from(fixture.segmentBytes).toString("utf8").replace("100", "900"), "utf8");
    await writeFile(join(walDir, fixture.segmentFileName), corrupt);
    await writeFile(join(walDir, fixture.manifestFileName), fixture.manifestBytes);
    const result = await verifySegmentForExtraction({
      fileSystem: nodeCompactionFileSystem(),
      walDirectoryPath: walDir,
      segmentId: fixture.segmentId,
    });
    expect(result.status).toBe("refused");
  });

  it("computes both digests from ONE read: a file that changes between reads cannot reach the tier", async () => {
    const fixture = segment(0, [{ ingestSeq: "1", payloadUtf8: binanceTrade(1, "1"), ...binance }]);
    await place(fixture);
    const real = nodeCompactionFileSystem();
    let segmentReads = 0;
    const shifting: CompactionFileSystem = {
      ...real,
      async readWholeFile(path: string): Promise<Uint8Array> {
        if (path.endsWith(".wal.jsonl")) {
          segmentReads += 1;
          // A second read would see other bytes.
          if (segmentReads > 1) return Buffer.from("tampered\n", "utf8");
        }
        return await real.readWholeFile(path);
      },
    };
    const result = await verifySegmentForExtraction({ fileSystem: shifting, walDirectoryPath: walDir, segmentId: fixture.segmentId });
    expect(segmentReads).toBe(1);
    if (result.status !== "verified") throw new Error(result.reasons.join("; "));
    expect(result.segmentFileSha256).toBe(sha256Hex(fixture.segmentBytes));
    expect(result.segmentSha256).toBe(fixture.manifest.segmentSha256);
  });

  it("takes the newest receipt instant over EVERY frame, not the last frame's (ADR-028 Decision 2.1)", async () => {
    // Dispatched first with the NEWER instant, then with an older one.
    const fixture = segment(0, [
      { ingestSeq: "1", payloadUtf8: "PONG", receivedAt: "2026-01-04T00:00:00.000Z" },
      { ingestSeq: "2", payloadUtf8: "PONG", receivedAt: "2026-01-03T22:00:00.000Z" },
    ]);
    await place(fixture);
    const result = await verifySegmentForExtraction({
      fileSystem: nodeCompactionFileSystem(),
      walDirectoryPath: walDir,
      segmentId: fixture.segmentId,
    });
    if (result.status !== "verified") throw new Error("expected verified");
    expect(result.maxReceivedAt).toBe("2026-01-04T00:00:00.000Z");
    expect(result.minReceivedAt).toBe("2026-01-03T22:00:00.000Z");
  });
});

describe("extractResearchTier", () => {
  it("lists each source segment with both digests from the verified bytes, then writes pointers", async () => {
    const zero = segment(0, [
      { ingestSeq: "1", payloadUtf8: binanceTrade(1, "100"), receivedAt: "2026-01-01T00:00:00.100Z", ...binance },
      { ingestSeq: "2", payloadUtf8: binanceTrade(2, "101"), receivedAt: "2026-01-01T00:00:01.100Z", ...binance },
    ]);
    const one = segment(1, [
      { ingestSeq: "3", payloadUtf8: binanceTrade(3, "102"), receivedAt: "2026-01-01T00:00:02.100Z", ...binance },
    ]);
    await place(zero);
    await place(one);
    const objectStore = memoryObjectStore();
    const fileSystem = nodeCompactionFileSystem();
    const inventory = await inventoryWalRoot(fileSystem, join(root, "wal"));
    const result = await extractResearchTier({ fileSystem, objectStore, clock: manualClock(), byEpoch: inventory.byEpoch });
    expect(result.refused).toStrictEqual([]);
    expect(result.datasets).toHaveLength(1);
    const dataset = result.datasets[0];
    if (dataset === undefined) throw new Error("no dataset");
    const verified = await verifyResearchTierDataset(objectStore, dataset.manifestObjectKey);
    expect(verified.manifest.sourceSegments.map((source) => [source.segmentId, source.segmentSha256, source.segmentFileSha256])).toStrictEqual([
      [zero.segmentId, zero.manifest.segmentSha256, sha256Hex(await readFile(join(walDir, zero.segmentFileName)))],
      [one.segmentId, one.manifest.segmentSha256, sha256Hex(await readFile(join(walDir, one.segmentFileName)))],
    ]);
    const pointer = await readResearchPointer(objectStore, EPOCH, one.segmentId);
    expect(pointer).toMatchObject({ manifestSha256: verified.manifestSha256, segmentFileSha256: sha256Hex(one.segmentBytes) });
    // The bar for [0 s, 1 s) was released by the first frame of the NEXT
    // segment's span close; the dataset carried it.
    expect(dataset.samples).toBeGreaterThan(0);
  });

  it("never extracts a segment that fails validation, and restarts the chain after it", async () => {
    const zero = segment(0, [{ ingestSeq: "1", payloadUtf8: binanceTrade(1, "100"), ...binance }]);
    const one = segment(1, [{ ingestSeq: "2", payloadUtf8: binanceTrade(2, "100"), ...binance }]);
    const two = segment(2, [{ ingestSeq: "3", payloadUtf8: binanceTrade(3, "100"), ...binance }]);
    await place(zero);
    await place(two);
    // Segment 1's bytes do not match its manifest.
    await writeFile(join(walDir, one.segmentFileName), Buffer.from(Buffer.from(one.segmentBytes).toString("utf8").replace("BTCUSDT", "BTCUSDX")));
    await writeFile(join(walDir, one.manifestFileName), one.manifestBytes);
    const objectStore = memoryObjectStore();
    const fileSystem = nodeCompactionFileSystem();
    const inventory = await inventoryWalRoot(fileSystem, join(root, "wal"));
    const result = await extractResearchTier({ fileSystem, objectStore, clock: manualClock(), byEpoch: inventory.byEpoch });
    expect(result.refused.map((entry) => entry.segmentId)).toStrictEqual([one.segmentId]);
    expect(await readResearchPointer(objectStore, EPOCH, one.segmentId)).toBeNull();
    expect(result.datasets.map((dataset) => [dataset.segmentIds, dataset.freshStart])).toStrictEqual([
      [[zero.segmentId], true],
      [[two.segmentId], true],
    ]);
    // A second run extracts nothing new and still refuses segment 1.
    const again = await extractResearchTier({ fileSystem, objectStore, clock: manualClock(), byEpoch: inventory.byEpoch });
    expect(again.datasets).toStrictEqual([]);
    expect(again.refused.map((entry) => entry.segmentId)).toStrictEqual([one.segmentId]);
  });

  it("chains a later extraction to the previous dataset's end state", async () => {
    const zero = segment(0, [{ ingestSeq: "1", payloadUtf8: binanceTrade(1, "100"), receivedAt: "2026-01-01T00:00:00.100Z", ...binance }]);
    await place(zero);
    const objectStore = memoryObjectStore();
    const fileSystem = nodeCompactionFileSystem();
    await extractResearchTier({ fileSystem, objectStore, clock: manualClock(), byEpoch: (await inventoryWalRoot(fileSystem, join(root, "wal"))).byEpoch });
    const ticker = JSON.stringify({ stream: "btcusdt@bookTicker", data: { u: 1, s: "BTCUSDT", b: "1", B: "1", a: "2", A: "1" } });
    const one = segment(1, [{ ingestSeq: "2", payloadUtf8: ticker, receivedAt: "2026-01-01T00:00:01.500Z", ...binance }]);
    await place(one);
    const second = await extractResearchTier({
      fileSystem,
      objectStore,
      clock: manualClock(),
      byEpoch: (await inventoryWalRoot(fileSystem, join(root, "wal"))).byEpoch,
    });
    expect(second.datasets).toHaveLength(1);
    expect(second.datasets[0]?.freshStart).toBe(false);
    const verified = await verifyResearchTierDataset(objectStore, second.datasets[0]?.manifestObjectKey ?? "");
    expect(verified.manifest.samplerState.stateIn?.datasetId).toMatch(/000000-000000$/u);
    // Segment 0's open bar was released by segment 1's first frame.
    expect(second.datasets[0]?.samples).toBe(1);
  });

  it("waits to batch until the oldest pending segment is old enough", async () => {
    const zero = segment(0, [{ ingestSeq: "1", payloadUtf8: "PONG", ...binance }]);
    await place(zero);
    const objectStore = memoryObjectStore();
    const fileSystem = nodeCompactionFileSystem();
    const clock = manualClock(Date.parse("2026-01-01T00:20:00.000Z"));
    const inventory = await inventoryWalRoot(fileSystem, join(root, "wal"));
    const early = await extractResearchTier({ fileSystem, objectStore, clock, byEpoch: inventory.byEpoch, batchDelayMs: 60 * 60 * 1000 });
    expect(early.datasets).toStrictEqual([]);
    clock.setNowMs(Date.parse("2026-01-01T01:16:00.000Z"));
    const late = await extractResearchTier({ fileSystem, objectStore, clock, byEpoch: inventory.byEpoch, batchDelayMs: 60 * 60 * 1000 });
    expect(late.datasets).toHaveLength(1);
  });
});
