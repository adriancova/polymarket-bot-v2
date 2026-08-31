/**
 * WAL segments written by the real `WP-050` writer, compacted, verified, and
 * reconciled — the whole `WP-130` acceptance list, end to end.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compactWalDirectory,
  fileSystemObjectStore,
  nodeCompactionFileSystem,
  readParquetObject,
  reconstructFrameLine,
  sha256Hex,
  systemCompactionClock,
} from "@polymarket-bot/storage-parquet";
import type { DecodedDatasetRow } from "@polymarket-bot/storage-parquet";
import { listSegmentManifests, nodeWalFileSystem } from "@polymarket-bot/storage-wal";

import { createWorkspace, frame, recordFrames } from "./context.js";
import type { TemporaryWorkspace } from "./context.js";

let workspace: TemporaryWorkspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

const PAYLOADS = [
  '{"event_type":"book","asset_id":"71321045","bids":[{"price":"0.100","size":"12.5"}]}',
  "PING",
  "PONG",
  '{"event_type":"price_change","changes":[{"price":"0.9990","size":"0.0100"}]}',
  // Adversarial: a payload that looks like a footer record, control bytes, a
  // literal newline, and an emoji. `wal-format.md` §5.1 requires all of it to
  // survive verbatim.
  '{"record":"footer","formatId":"polymarket-bot/wal/v1"}',
  "line\nbreak\ttab \u0000nul \u007fdel",
  "emoji 😀 and a backslash \\n that is not a newline",
  "",
];

async function recordAndCompact(options: { maxSegmentBytes?: number } = {}) {
  const frames = PAYLOADS.map((payloadUtf8, index) =>
    frame({
      ingestSeq: index + 1,
      payloadUtf8,
      receivedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    }),
  );
  const written = await recordFrames(workspace.walDirectoryPath, frames, options);
  const result = await compactWalDirectory({
    walDirectoryPath: workspace.walDirectoryPath,
    datasetId: "ds-integration",
    objectKeyPrefix: "datasets/ds-integration",
    objectStore: fileSystemObjectStore(workspace.objectStoreRoot),
    fileSystem: nodeCompactionFileSystem(),
    clock: systemCompactionClock(),
  });
  return { frames, written, result };
}

async function allRows(
  objectStoreRoot: string,
  objectKeys: readonly string[],
): Promise<DecodedDatasetRow[]> {
  const rows: DecodedDatasetRow[] = [];
  for (const key of objectKeys) {
    rows.push(...(await readParquetObject(await readFile(join(objectStoreRoot, key)))));
  }
  return rows.sort((left, right) => left.datasetRowOrdinal - right.datasetRowOrdinal);
}

describe("WAL → compact → Parquet → verify", () => {
  it("compacts every verified segment the real writer produced", async () => {
    const { written, result } = await recordAndCompact({ maxSegmentBytes: 900 });

    // The writer really did rotate, so this exercises multiple segments.
    expect(written.manifests.length).toBeGreaterThan(1);
    expect(result.verifiedSegmentIds).toStrictEqual(
      [...written.manifests].map((manifest) => manifest.segmentId).sort(),
    );
    expect(result.refusedSegments).toStrictEqual([]);
  });

  it("reconciles record counts against the WAL's own manifests", async () => {
    const { written, result } = await recordAndCompact({ maxSegmentBytes: 900 });

    const declared = written.manifests.reduce((sum, m) => sum + m.recordCount, 0);
    expect(declared).toBe(PAYLOADS.length);
    expect(result.manifest.recordCounts.segmentDeclared).toBe(declared);
    expect(result.manifest.recordCounts.segmentRead).toBe(declared);
    expect(result.manifest.recordCounts.written).toBe(declared);
    expect(result.manifest.recordCounts.replayEligible).toBe(declared);
    expect(result.rowsWritten).toBe(declared);
  });

  it("reconciles hashes: the WAL's segment digests and the stored objects'", async () => {
    const { result } = await recordAndCompact({ maxSegmentBytes: 900 });

    // The compactor's independent reader recomputed each segment digest from
    // the bytes; the WAL writer computed the same digest when it closed them.
    const walManifests = await listSegmentManifests(
      nodeWalFileSystem(),
      workspace.walDirectoryPath,
    );
    const byId = new Map(walManifests.map((m) => [m.segmentId, m.segmentSha256]));
    for (const segment of result.manifest.segments) {
      expect(segment.segmentSha256).toBe(byId.get(segment.segmentId));
    }

    // Object digests match the bytes actually on disk.
    for (const object of result.manifest.objects) {
      const bytes = await readFile(join(workspace.objectStoreRoot, object.objectKey));
      expect(sha256Hex(bytes)).toBe(object.sha256);
      expect(bytes.byteLength).toBe(object.byteLength);
    }
  });

  it("preserves every frame byte-exactly, including adversarial payloads", async () => {
    const { frames, result } = await recordAndCompact({ maxSegmentBytes: 900 });
    const rows = await allRows(
      workspace.objectStoreRoot,
      result.manifest.objects.map((object) => object.objectKey),
    );

    expect(rows).toHaveLength(frames.length);
    for (let index = 0; index < frames.length; index += 1) {
      const expected = frames[index];
      const actual = rows[index];
      if (expected === undefined || actual === undefined) throw new Error("missing row");
      // Field for field, not "looks similar".
      expect(actual.record).toStrictEqual(expected);
      // And the row can rebuild the exact WAL line it came from.
      expect(sha256Hex(reconstructFrameLine(actual.record))).toBe(actual.frameLineSha256);
    }
  });

  it("lets a row be traced back to the exact bytes in its segment file", async () => {
    const { result } = await recordAndCompact({ maxSegmentBytes: 900 });
    const rows = await allRows(
      workspace.objectStoreRoot,
      result.manifest.objects.map((object) => object.objectKey),
    );

    for (const row of rows) {
      const segmentBytes = await readFile(
        join(workspace.walDirectoryPath, `${row.segmentId}.wal.jsonl`),
      );
      const slice = segmentBytes.subarray(
        row.frameLineByteOffset,
        row.frameLineByteOffset + row.frameLineByteLength,
      );
      expect(sha256Hex(slice)).toBe(row.frameLineSha256);
      expect(Buffer.from(reconstructFrameLine(row.record))).toStrictEqual(slice);
    }
  });

  it("recovers dispatch order from datasetRowOrdinal alone", async () => {
    const { frames, result } = await recordAndCompact({ maxSegmentBytes: 900 });
    const rows = await allRows(
      workspace.objectStoreRoot,
      result.manifest.objects.map((object) => object.objectKey),
    );
    expect(rows.map((row) => row.datasetRowOrdinal)).toStrictEqual(
      frames.map((_unused, index) => index),
    );
    expect(rows.map((row) => row.record.ingestSeq)).toStrictEqual(
      frames.map((record) => record.ingestSeq),
    );
    expect(result.manifest.eventRange.first?.ingestSeq).toBe("1");
    expect(result.manifest.eventRange.last?.ingestSeq).toBe(String(frames.length));
  });

  it("pins the gateway epoch, event range and schema versions in the manifest", async () => {
    const { result } = await recordAndCompact({ maxSegmentBytes: 900 });
    expect(result.manifest.gatewayEpochs).toStrictEqual([
      "0190a3e0-0000-7000-8000-000000000001",
    ]);
    expect(result.manifest.schemaVersions.walFormatId).toBe("polymarket-bot/wal/v1");
    expect(result.manifest.schemaVersions.walSchemaVersion).toBe(1);
    expect(result.manifest.schemaVersions.parquetLayoutVersion).toBe(1);
    expect(result.manifest.eventRange.first).not.toBeNull();
    expect(result.manifest.eventRange.last).not.toBeNull();
  });

  it("writes a manifest object whose digest matches its sidecar", async () => {
    const { result } = await recordAndCompact();
    const manifestBytes = await readFile(
      join(workspace.objectStoreRoot, result.manifestObjectKey),
    );
    expect(sha256Hex(manifestBytes)).toBe(result.manifestSha256);
    const sidecar = await readFile(
      join(workspace.objectStoreRoot, "datasets/ds-integration/manifest.sha256"),
      "utf8",
    );
    expect(sidecar.trim()).toBe(result.manifestSha256);
  });

  it("leaves every WAL file in place under the default retention", async () => {
    const { result } = await recordAndCompact({ maxSegmentBytes: 900 });
    expect(result.deletedSegmentIds).toStrictEqual([]);
    expect(result.manifest.walRetentionPolicy).toBe("retain");

    const remaining = await readdir(workspace.walDirectoryPath);
    for (const segment of result.manifest.segments) {
      expect(remaining).toContain(`${segment.segmentId}.wal.jsonl`);
      expect(remaining).toContain(`${segment.segmentId}.wal.manifest.json`);
    }
  });
});
