/**
 * Incident-window exclusion and the delete-after-verify rule, on real files.
 *
 * These two behaviours are tested together because they are entangled by
 * design: exclusion **marks** rows instead of dropping them precisely so that
 * retention can delete a WAL segment without destroying the evidence of the
 * incident that segment recorded.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compactWalDirectory,
  deleteAfterVerifiedUploadRetention,
  fileSystemObjectStore,
  nodeCompactionFileSystem,
  ObjectVerificationError,
  readParquetObject,
  systemCompactionClock,
} from "@polymarket-bot/storage-parquet";
import type {
  CompactionResult,
  IncidentWindow,
  ObjectStore,
} from "@polymarket-bot/storage-parquet";

import { createWorkspace, frame, GATEWAY_EPOCH, recordFrames } from "./context.js";
import type { TemporaryWorkspace } from "./context.js";

let workspace: TemporaryWorkspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

const WINDOW: IncidentWindow = {
  incidentId: "inc-42",
  kind: "gap",
  gatewayEpoch: GATEWAY_EPOCH,
  fromIngestSeq: "3",
  toIngestSeq: "5",
  openedAt: "2026-01-01T00:00:02.000Z",
  closedAt: "2026-01-01T00:00:06.000Z",
  reason: "market channel gap; resubscribed and resynchronised",
};

async function record(): Promise<void> {
  const frames = [1, 2, 3, 4, 5, 6, 7].map((seq) =>
    frame({ ingestSeq: seq, payloadUtf8: `{"event_type":"book","n":${seq}}` }),
  );
  await recordFrames(workspace.walDirectoryPath, frames, { maxSegmentBytes: 900 });
}

async function compact(options: {
  readonly incidentWindows?: readonly IncidentWindow[];
  readonly deleteAfterVerify?: boolean;
  readonly objectStore?: ObjectStore;
}): Promise<CompactionResult> {
  const objectStore = options.objectStore ?? fileSystemObjectStore(workspace.objectStoreRoot);
  return await compactWalDirectory({
    walDirectoryPath: workspace.walDirectoryPath,
    datasetId: "ds-incidents",
    objectKeyPrefix: "datasets/ds-incidents",
    objectStore,
    fileSystem: nodeCompactionFileSystem(),
    clock: systemCompactionClock(),
    ...(options.incidentWindows === undefined
      ? {}
      : { incidentWindows: options.incidentWindows }),
    ...(options.deleteAfterVerify === true
      ? {
          retention: deleteAfterVerifiedUploadRetention({
            walDirectoryPath: workspace.walDirectoryPath,
            objectStore,
          }),
        }
      : {}),
  });
}

async function rowsOf(result: CompactionResult) {
  const rows = [];
  for (const object of result.manifest.objects) {
    rows.push(
      ...(await readParquetObject(await readFile(join(workspace.objectStoreRoot, object.objectKey)))),
    );
  }
  return rows.sort((left, right) => left.datasetRowOrdinal - right.datasetRowOrdinal);
}

describe("incident-window exclusion", () => {
  it("marks the window's records ineligible and keeps them in the dataset", async () => {
    await record();
    const result = await compact({ incidentWindows: [WINDOW] });
    const rows = await rowsOf(result);

    expect(rows).toHaveLength(7);
    expect(result.manifest.recordCounts.written).toBe(7);
    expect(result.manifest.recordCounts.excludedByIncident).toBe(3);
    expect(result.manifest.recordCounts.replayEligible).toBe(4);

    const excluded = rows.filter((row) => !row.replayEligible);
    expect(excluded.map((row) => row.record.ingestSeq)).toStrictEqual(["3", "4", "5"]);
    expect(excluded.every((row) => row.exclusionReason === "incident:inc-42")).toBe(true);

    const eligible = rows.filter((row) => row.replayEligible);
    expect(eligible.map((row) => row.record.ingestSeq)).toStrictEqual(["1", "2", "6", "7"]);
    expect(eligible.every((row) => row.exclusionReason === null)).toBe(true);
  });

  it("pins the window itself, its counts, and the segments it touched", async () => {
    await record();
    const result = await compact({ incidentWindows: [WINDOW] });

    expect(result.manifest.excludedIncidentWindows).toHaveLength(1);
    const pinned = result.manifest.excludedIncidentWindows[0];
    expect(pinned?.window).toStrictEqual(WINDOW);
    expect(pinned?.excludedRecordCount).toBe(3);
    expect(pinned?.excludedSegmentIds.length).toBeGreaterThan(0);
    for (const segmentId of pinned?.excludedSegmentIds ?? []) {
      expect(result.manifest.segments.map((s) => s.segmentId)).toContain(segmentId);
    }
  });

  it("survives a manifest round trip through the object store", async () => {
    await record();
    const result = await compact({ incidentWindows: [WINDOW] });
    const stored = JSON.parse(
      await readFile(join(workspace.objectStoreRoot, result.manifestObjectKey), "utf8"),
    ) as Record<string, unknown>;
    const windows = stored["excludedIncidentWindows"] as { window: IncidentWindow }[];
    expect(windows[0]?.window.incidentId).toBe("inc-42");
    expect(windows[0]?.window.reason).toBe(WINDOW.reason);
  });
});

describe("retention (ADR-004 §5)", () => {
  it("keeps every WAL file when no retention policy is supplied", async () => {
    await record();
    const result = await compact({});
    expect(result.deletedSegmentIds).toStrictEqual([]);
    const remaining = await readdir(workspace.walDirectoryPath);
    expect(remaining.filter((name) => name.endsWith(".wal.jsonl")).length).toBe(
      result.manifest.segments.length,
    );
  });

  it("deletes a segment and its sidecar only after the object verifies", async () => {
    await record();
    const result = await compact({ deleteAfterVerify: true });

    expect(result.deletedSegmentIds.length).toBe(result.manifest.segments.length);
    expect(result.retentionFailures).toStrictEqual([]);
    expect(await readdir(workspace.walDirectoryPath)).toStrictEqual([]);

    // Deletion state lives in the retention receipt, not in the (persisted-
    // before-deletion, immutable) manifest.
    expect(result.retentionReceiptObjectKey).toBe("datasets/ds-incidents/retention-receipt.json");
    const receipt = JSON.parse(
      await readFile(
        join(workspace.objectStoreRoot, result.retentionReceiptObjectKey ?? ""),
        "utf8",
      ),
    ) as {
      datasetManifestSha256: string;
      deletedSegments: { segmentId: string }[];
      retentionFailures: unknown[];
    };
    expect(receipt.datasetManifestSha256).toBe(result.manifestSha256);
    expect(receipt.deletedSegments.map((entry) => entry.segmentId).sort()).toStrictEqual(
      result.manifest.segments.map((segment) => segment.segmentId).sort(),
    );
    expect(receipt.retentionFailures).toStrictEqual([]);

    // Everything that was in the WAL is still readable from the archive.
    const rows = await rowsOf(result);
    expect(rows.map((row) => row.record.ingestSeq)).toStrictEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
  });

  it("keeps the WAL intact when verification fails", async () => {
    await record();
    const before = await readdir(workspace.walDirectoryPath);
    const backing = fileSystemObjectStore(workspace.objectStoreRoot);
    const failing: ObjectStore = {
      put: (key, bytes) => backing.put(key, bytes),
      head: async (key) => (key.endsWith(".parquet") ? null : backing.head(key)),
      get: (key) => backing.get(key),
    };

    await expect(
      compact({ deleteAfterVerify: true, objectStore: failing }),
    ).rejects.toBeInstanceOf(ObjectVerificationError);

    // The intended failure direction: the disk fills, the data survives.
    expect((await readdir(workspace.walDirectoryPath)).sort()).toStrictEqual(before.sort());
  });

  it("keeps the WAL intact when the manifest cannot be persisted", async () => {
    // Round-1 review's H1 probe on real files: with deletion enabled, a store
    // that rejects the manifest put must leave every WAL byte on disk,
    // because the manifest is persisted BEFORE any deletion is granted.
    await record();
    const before = await readdir(workspace.walDirectoryPath);
    const backing = fileSystemObjectStore(workspace.objectStoreRoot);
    const failing: ObjectStore = {
      put: async (key, bytes) => {
        if (key.endsWith("/manifest.json")) {
          throw new Error("manifest put rejected");
        }
        await backing.put(key, bytes);
      },
      head: (key) => backing.head(key),
      get: (key) => backing.get(key),
    };

    await expect(
      compact({ deleteAfterVerify: true, objectStore: failing }),
    ).rejects.toThrow("manifest put rejected");
    expect((await readdir(workspace.walDirectoryPath)).sort()).toStrictEqual(before.sort());
  });

  it("keeps an incident's records readable after its segment is deleted", async () => {
    // The reason exclusion marks rather than drops: after this deletion the
    // dataset is the only copy of the frames inside the incident window.
    await record();
    const result = await compact({ incidentWindows: [WINDOW], deleteAfterVerify: true });
    expect(await readdir(workspace.walDirectoryPath)).toStrictEqual([]);

    const rows = await rowsOf(result);
    const excluded = rows.filter((row) => !row.replayEligible);
    expect(excluded.map((row) => row.record.ingestSeq)).toStrictEqual(["3", "4", "5"]);
    expect(excluded.map((row) => row.record.payloadUtf8)).toStrictEqual([
      '{"event_type":"book","n":3}',
      '{"event_type":"book","n":4}',
      '{"event_type":"book","n":5}',
    ]);
  });
});
