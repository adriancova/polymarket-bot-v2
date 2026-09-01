import { describe, expect, it } from "vitest";

import { compactWalDirectory, listManifestedSegmentIds } from "./compactor.js";
import type { CompactionOptions, CompactionResult } from "./compactor.js";
import {
  DATASET_MANIFEST_DIGEST_OBJECT_NAME,
  DATASET_MANIFEST_OBJECT_NAME,
  DATASET_RETENTION_RECEIPT_OBJECT_NAME,
} from "./constants.js";
import { encodeDatasetManifest, parseDatasetManifest } from "./dataset-manifest.js";
import {
  CompactionBatchLimitError,
  CompactionConfigurationError,
  CrossEpochOrderError,
  DuplicateDivergenceError,
  ObjectVerificationError,
} from "./errors.js";
import type { IncidentWindow } from "./incidents.js";
import { readParquetObject } from "./parquet-object.js";
import { retainAllWalSegments } from "./ports.js";
import type { CompactionObserver } from "./ports.js";
import { sha256Hex } from "./wal-format.js";
import {
  buildSegmentFixture,
  encodeManifest,
  manualClock,
  memoryFileSystem,
  memoryObjectStore,
  recordingRetention,
} from "./testing/index.js";
import type { MemoryFileSystem, MemoryObjectStore } from "./testing/index.js";
import type { SegmentFixture } from "./testing/wal-fixture.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";
const WAL_DIR = "/wal";

function place(fileSystem: MemoryFileSystem, fixture: SegmentFixture): void {
  fileSystem.write(WAL_DIR, fixture.segmentFileName, fixture.segmentBytes);
  fileSystem.write(WAL_DIR, fixture.manifestFileName, fixture.manifestBytes);
}

type Harness = {
  readonly fileSystem: MemoryFileSystem;
  readonly objectStore: MemoryObjectStore;
  readonly run: (overrides?: Partial<CompactionOptions>) => Promise<CompactionResult>;
};

function harness(): Harness {
  const fileSystem = memoryFileSystem();
  const objectStore = memoryObjectStore();
  const clock = manualClock();
  return {
    fileSystem,
    objectStore,
    run: (overrides = {}) =>
      compactWalDirectory({
        walDirectoryPath: WAL_DIR,
        datasetId: "ds-1",
        objectKeyPrefix: "datasets/ds-1",
        objectStore,
        fileSystem,
        clock,
        ...overrides,
      }),
  };
}

function segmentA(): SegmentFixture {
  return buildSegmentFixture({
    gatewayEpoch: EPOCH,
    segmentIndex: 0,
    frames: [
      { ingestSeq: "1", payloadUtf8: '{"event_type":"book"}' },
      { ingestSeq: "2", payloadUtf8: "PING", receivedAt: "2026-01-01T00:00:10.000Z" },
    ],
  });
}

function segmentB(): SegmentFixture {
  return buildSegmentFixture({
    gatewayEpoch: EPOCH,
    segmentIndex: 1,
    frames: [
      { ingestSeq: "3", payloadUtf8: '{"event_type":"price_change"}' },
      { ingestSeq: "4", payloadUtf8: "PONG", receivedAt: "2026-01-01T00:00:20.000Z" },
      { ingestSeq: "5", payloadUtf8: '{"price":"0.100"}' },
    ],
  });
}

describe("listManifestedSegmentIds", () => {
  it("lists only segments that carry a sidecar manifest", async () => {
    const fileSystem = memoryFileSystem();
    const withManifest = segmentA();
    const withoutManifest = segmentB();
    place(fileSystem, withManifest);
    fileSystem.write(WAL_DIR, withoutManifest.segmentFileName, withoutManifest.segmentBytes);
    expect(await listManifestedSegmentIds(fileSystem, WAL_DIR)).toStrictEqual([
      withManifest.segmentId,
    ]);
  });
});

describe("compactWalDirectory", () => {
  it("compacts verified segments and reconciles every count and hash", async () => {
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    const b = segmentB();
    place(fileSystem, a);
    place(fileSystem, b);

    const result = await run();

    expect(result.verifiedSegmentIds).toStrictEqual([a.segmentId, b.segmentId]);
    expect(result.refusedSegments).toStrictEqual([]);
    expect(result.rowsWritten).toBe(5);
    expect(result.replayEligibleRows).toBe(5);

    // Counts reconcile against the WAL's own declarations.
    expect(result.manifest.recordCounts.segmentDeclared).toBe(5);
    expect(result.manifest.recordCounts.segmentRead).toBe(5);
    expect(result.manifest.recordCounts.written).toBe(5);

    // Hashes reconcile: the manifest pins the WAL's segment digests and the
    // object digests read back from the store.
    const pinned = new Map(result.manifest.segments.map((s) => [s.segmentId, s.segmentSha256]));
    expect(pinned.get(a.segmentId)).toBe(a.manifest.segmentSha256);
    expect(pinned.get(b.segmentId)).toBe(b.manifest.segmentSha256);
    for (const object of result.manifest.objects) {
      const bytes = await objectStore.get(object.objectKey);
      expect(sha256Hex(bytes)).toBe(object.sha256);
      expect(bytes.byteLength).toBe(object.byteLength);
    }
  });

  it("assigns a dense dispatch-order ordinal across segments", async () => {
    const { fileSystem, objectStore, run } = harness();
    place(fileSystem, segmentB());
    place(fileSystem, segmentA());

    const result = await run();
    const ordinals: number[] = [];
    for (const object of result.manifest.objects) {
      const rows = await readParquetObject(await objectStore.get(object.objectKey));
      ordinals.push(...rows.map((row) => row.datasetRowOrdinal));
    }
    ordinals.sort((left, right) => left - right);
    expect(ordinals).toStrictEqual([0, 1, 2, 3, 4]);

    // Segment 0's records come first even though it was placed second.
    expect(result.manifest.eventRange.first?.ingestSeq).toBe("1");
    expect(result.manifest.eventRange.last?.ingestSeq).toBe("5");
    expect(result.manifest.eventRange.first?.datasetRowOrdinal).toBe(0);
    expect(result.manifest.eventRange.last?.datasetRowOrdinal).toBe(4);
  });

  it("preserves every payload byte-exactly into the object", async () => {
    const { fileSystem, objectStore, run } = harness();
    const fixture = buildSegmentFixture({
      gatewayEpoch: EPOCH,
      segmentIndex: 0,
      frames: [
        { ingestSeq: "1", payloadUtf8: '{"price":"0.100","size":"1.0"}' },
        { ingestSeq: "2", payloadUtf8: "tab\tnul \u0000 emoji😀" },
      ],
    });
    place(fileSystem, fixture);

    const result = await run();
    const rows = await readParquetObject(
      await objectStore.get(result.manifest.objects[0]?.objectKey ?? ""),
    );
    expect(rows.map((row) => row.record.payloadUtf8)).toStrictEqual([
      '{"price":"0.100","size":"1.0"}',
      "tab\tnul \u0000 emoji😀",
    ]);
  });

  it("refuses an unmanifested segment and never reads it into the dataset", async () => {
    const { fileSystem, run } = harness();
    const good = segmentA();
    const orphan = segmentB();
    place(fileSystem, good);
    fileSystem.write(WAL_DIR, orphan.segmentFileName, orphan.segmentBytes);

    const result = await run();
    expect(result.verifiedSegmentIds).toStrictEqual([good.segmentId]);
    expect(result.rowsWritten).toBe(2);
    expect(result.manifest.excludedSegments).toStrictEqual([]);
  });

  it("pins a corrupt segment in the manifest's exclusion list with its issues", async () => {
    const { fileSystem, run } = harness();
    const good = segmentA();
    const broken = segmentB();
    place(fileSystem, good);
    place(fileSystem, broken);
    // Same-width edit to a field the payload digest does not cover.
    fileSystem.write(
      WAL_DIR,
      broken.segmentFileName,
      Buffer.from(broken.segmentBytes).toString("utf8").replace("conn-1", "conn-2"),
    );

    const result = await run();
    expect(result.verifiedSegmentIds).toStrictEqual([good.segmentId]);
    expect(result.manifest.excludedSegments).toHaveLength(1);
    const excluded = result.manifest.excludedSegments[0];
    expect(excluded?.segmentId).toBe(broken.segmentId);
    expect(excluded?.issues.map((issue) => issue.code)).toContain("CHECKSUM_MISMATCH");
    expect(result.manifest.recordCounts.written).toBe(2);
  });

  it("refuses a torn segment and leaves its bytes untouched", async () => {
    const { fileSystem, run } = harness();
    const torn = segmentA();
    place(fileSystem, torn);
    const tornBytes = Buffer.concat([
      Buffer.from(torn.segmentBytes),
      Buffer.from('{"gatewayEpoch":"trunc'),
    ]);
    fileSystem.write(WAL_DIR, torn.segmentFileName, tornBytes);

    const result = await run();
    expect(result.verifiedSegmentIds).toStrictEqual([]);
    expect(result.manifest.excludedSegments[0]?.issues.map((i) => i.code)).toContain(
      "RECORD_AFTER_FOOTER",
    );
    expect(await fileSystem.readWholeFile(`${WAL_DIR}/${torn.segmentFileName}`)).toStrictEqual(
      Uint8Array.from(tornBytes),
    );
  });

  it("marks incident-window records ineligible without dropping them", async () => {
    const { fileSystem, objectStore, run } = harness();
    place(fileSystem, segmentA());
    place(fileSystem, segmentB());

    const window: IncidentWindow = {
      incidentId: "inc-7",
      kind: "gap",
      gatewayEpoch: EPOCH,
      fromIngestSeq: "2",
      toIngestSeq: "3",
      openedAt: "2026-01-01T00:00:05.000Z",
      closedAt: "2026-01-01T00:00:15.000Z",
      reason: "market channel gap while resubscribing",
    };

    const result = await run({ incidentWindows: [window] });

    expect(result.rowsWritten).toBe(5);
    expect(result.replayEligibleRows).toBe(3);
    expect(result.manifest.recordCounts.excludedByIncident).toBe(2);

    const pinned = result.manifest.excludedIncidentWindows;
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.window.incidentId).toBe("inc-7");
    expect(pinned[0]?.excludedRecordCount).toBe(2);
    expect(pinned[0]?.excludedSegmentIds).toHaveLength(2);

    const rows = [];
    for (const object of result.manifest.objects) {
      rows.push(...(await readParquetObject(await objectStore.get(object.objectKey))));
    }
    const excluded = rows.filter((row) => !row.replayEligible);
    expect(excluded.map((row) => row.record.ingestSeq).sort()).toStrictEqual(["2", "3"]);
    expect(excluded.every((row) => row.exclusionReason === "incident:inc-7")).toBe(true);
    // The evidence is still in the dataset, which is the point.
    expect(rows).toHaveLength(5);
  });

  it("pins a window that excluded nothing, so a reader sees it was applied", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());
    const result = await run({
      incidentWindows: [
        {
          incidentId: "inc-empty",
          kind: "staleness",
          gatewayEpoch: "another-epoch",
          fromIngestSeq: "1",
          toIngestSeq: "100",
          openedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
          reason: "different epoch",
        },
      ],
    });
    expect(result.manifest.excludedIncidentWindows[0]?.excludedRecordCount).toBe(0);
    expect(result.replayEligibleRows).toBe(2);
  });

  it("rejects a malformed incident window instead of silently excluding nothing", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());
    await expect(
      run({
        incidentWindows: [
          {
            incidentId: "inc-bad",
            kind: "gap",
            gatewayEpoch: EPOCH,
            fromIngestSeq: "10",
            toIngestSeq: "2",
            openedAt: "2026-01-01T00:00:00.000Z",
            closedAt: null,
            reason: "inverted",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CompactionConfigurationError);
  });

  it("marks a byte-identical duplicate and keeps the first copy eligible", async () => {
    const { fileSystem, objectStore, run } = harness();
    const first = segmentA();
    // wal-format.md §12: re-recording `pendingFrames()` after a fault produces
    // exactly this — the same frames again in a later segment.
    const replay = buildSegmentFixture({
      gatewayEpoch: EPOCH,
      segmentIndex: 1,
      frames: [
        { ingestSeq: "2", payloadUtf8: "PING", receivedAt: "2026-01-01T00:00:10.000Z" },
        { ingestSeq: "3", payloadUtf8: "new" },
      ],
    });
    place(fileSystem, first);
    place(fileSystem, replay);

    const result = await run();
    expect(result.rowsWritten).toBe(4);
    expect(result.replayEligibleRows).toBe(3);
    expect(result.manifest.deduplication.duplicateRecordCount).toBe(1);
    expect(result.manifest.deduplication.duplicateKeys).toStrictEqual([`${EPOCH}/2`]);
    expect(result.manifest.deduplication.policy).toBe("first-wins-in-dispatch-order");

    const rows = [];
    for (const object of result.manifest.objects) {
      rows.push(...(await readParquetObject(await objectStore.get(object.objectKey))));
    }
    const duplicates = rows.filter((row) => row.exclusionReason?.startsWith("duplicate:"));
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.exclusionReason).toBe("duplicate:1");
    expect(duplicates[0]?.segmentId).toBe(replay.segmentId);
  });

  it("refuses the run when two records share a key but differ in bytes", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());
    place(
      fileSystem,
      buildSegmentFixture({
        gatewayEpoch: EPOCH,
        segmentIndex: 1,
        frames: [{ ingestSeq: "2", payloadUtf8: "DIFFERENT" }],
      }),
    );
    await expect(run()).rejects.toBeInstanceOf(DuplicateDivergenceError);
  });

  it("truncates the duplicate-key enumeration but never the count", async () => {
    const { fileSystem, run } = harness();
    const frames = Array.from({ length: 5 }, (_unused, index) => ({
      ingestSeq: String(index + 1),
      payloadUtf8: `p${index}`,
    }));
    place(fileSystem, buildSegmentFixture({ gatewayEpoch: EPOCH, segmentIndex: 0, frames }));
    place(fileSystem, buildSegmentFixture({ gatewayEpoch: EPOCH, segmentIndex: 1, frames }));

    const result = await run({ maxListedDuplicateKeys: 2 });
    expect(result.manifest.deduplication.duplicateRecordCount).toBe(5);
    expect(result.manifest.deduplication.duplicateKeys).toHaveLength(2);
    expect(result.manifest.deduplication.duplicateKeysTruncated).toBe(true);
  });

  it("pins the schema versions and the column layout", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());
    const result = await run();
    expect(result.manifest.schemaVersions.walFormatId).toBe("polymarket-bot/wal/v1");
    expect(result.manifest.schemaVersions.walSchemaVersion).toBe(1);
    expect(result.manifest.schemaVersions.walManifestVersion).toBe(1);
    expect(result.manifest.schemaVersions.parquetLayoutId).toBe(
      "polymarket-bot/parquet-raw-frames/v1",
    );
    expect(result.manifest.schemaVersions.parquetLayoutVersion).toBe(1);
    expect(result.manifest.columns.map((column) => column.name)).toContain("payloadUtf8");
  });

  it("records run-scoped §12.5 pins as explicit nulls, and accepts supplied ones", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());

    const bare = await run();
    expect(bare.manifest.replayPins.runSeed).toBeNull();
    expect(bare.manifest.replayPins.fillModelVersion).toBeNull();
    expect(bare.manifest.replayPins.note).toMatch(/not pinned yet/u);

    const supplied = await run({
      datasetId: "ds-2",
      objectKeyPrefix: "datasets/ds-2",
      replayPins: { normalizerVersion: "norm-3" },
    });
    expect(supplied.manifest.replayPins.normalizerVersion).toBe("norm-3");
    expect(supplied.manifest.replayPins.runSeed).toBeNull();
  });

  it("writes the manifest and a sidecar digest, and the digest matches", async () => {
    const { fileSystem, objectStore, run } = harness();
    place(fileSystem, segmentA());
    const result = await run();

    expect(result.manifestObjectKey).toBe(`datasets/ds-1/${DATASET_MANIFEST_OBJECT_NAME}`);
    const manifestBytes = await objectStore.get(result.manifestObjectKey);
    expect(sha256Hex(manifestBytes)).toBe(result.manifestSha256);

    const digestBytes = await objectStore.get(
      `datasets/ds-1/${DATASET_MANIFEST_DIGEST_OBJECT_NAME}`,
    );
    expect(Buffer.from(digestBytes).toString("utf8").trim()).toBe(result.manifestSha256);

    const parsed = parseDatasetManifest(
      JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown,
    );
    expect(parsed.datasetId).toBe("ds-1");
    expect(sha256Hex(encodeDatasetManifest(parsed))).toBe(result.manifestSha256);
  });

  it("is idempotent: re-running the same compaction rewrites identical bytes", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());
    const first = await run();
    const second = await run();
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(second.manifest.objects[0]?.sha256).toBe(first.manifest.objects[0]?.sha256);
  });

  it("fails the run when the store serves back different bytes", async () => {
    const { fileSystem, objectStore, run } = harness();
    place(fileSystem, segmentA());
    const original = objectStore.put.bind(objectStore);
    const rotting: typeof objectStore = {
      ...objectStore,
      async put(key: string, bytes: Uint8Array) {
        await original(key, bytes);
        if (key.endsWith(".parquet")) {
          const mutated = Buffer.from(await objectStore.get(key));
          // Flip a byte inside the data pages, away from the trailing magic, so
          // the object still parses and only the digest can catch it.
          const offset = Math.floor(mutated.length / 2);
          mutated.writeUInt8(mutated.readUInt8(offset) ^ 0xff, offset);
          objectStore.corrupt(key, mutated);
        }
      },
    };
    await expect(run({ objectStore: rotting })).rejects.toBeInstanceOf(ObjectVerificationError);
  });

  it("fails the run when the object disappears between put and verification", async () => {
    const { fileSystem, objectStore, run } = harness();
    place(fileSystem, segmentA());
    const original = objectStore.put.bind(objectStore);
    const forgetful: typeof objectStore = {
      ...objectStore,
      async put(key: string, bytes: Uint8Array) {
        await original(key, bytes);
        if (key.endsWith(".parquet")) {
          objectStore.forget(key);
        }
      },
    };
    await expect(run({ objectStore: forgetful })).rejects.toBeInstanceOf(ObjectVerificationError);
  });

  it("emits an observation for every verified segment, upload and refusal", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());
    const broken = segmentB();
    place(fileSystem, broken);
    fileSystem.write(WAL_DIR, broken.manifestFileName, "{ not json");

    const events: string[] = [];
    const observer: CompactionObserver = {
      onSegmentVerified: (event) => events.push(`verified:${event.segmentId}`),
      onSegmentRefused: (event) => events.push(`refused:${event.segmentId}`),
      onObjectUploaded: () => events.push("uploaded"),
      onObjectVerified: () => events.push("object-verified"),
      onDatasetManifestWritten: () => events.push("manifest"),
    };
    await run({ observer });

    expect(events).toContain(`refused:${broken.segmentId}`);
    expect(events).toContain("uploaded");
    expect(events).toContain("object-verified");
    expect(events[events.length - 1]).toBe("manifest");
  });

  it("rejects an empty dataset id or object prefix", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());
    await expect(run({ datasetId: "" })).rejects.toBeInstanceOf(CompactionConfigurationError);
    await expect(run({ objectKeyPrefix: "" })).rejects.toBeInstanceOf(
      CompactionConfigurationError,
    );
  });

  it("refuses a mixed-epoch batch instead of inventing a chronology", async () => {
    // Reviewer probe (M1): chronological input OLDER (epoch ffff…) and NEWER
    // (epoch 0000…) previously came out archived in reverse, because epochs
    // were ordered by their lexical UUID order. Epochs are identities, not
    // timestamps, so the compactor now refuses to order them at all.
    const { fileSystem, objectStore, run } = harness();
    const older = buildSegmentFixture({
      gatewayEpoch: "ffffffff-0000-7000-8000-000000000001",
      segmentIndex: 0,
      frames: [{ ingestSeq: "1", payloadUtf8: "older" }],
    });
    const newer = buildSegmentFixture({
      gatewayEpoch: "00000000-0000-7000-8000-000000000002",
      segmentIndex: 0,
      frames: [{ ingestSeq: "1", payloadUtf8: "newer" }],
    });
    place(fileSystem, older);
    place(fileSystem, newer);

    await expect(run()).rejects.toBeInstanceOf(CrossEpochOrderError);
    // Refused before anything was written or deleted.
    expect(objectStore.keys()).toStrictEqual([]);
    expect(fileSystem.list(WAL_DIR)).toHaveLength(4);

    // Epoch-by-epoch compaction through `segmentIds` still works.
    const single = await run({ segmentIds: [older.segmentId] });
    expect(single.verifiedSegmentIds).toStrictEqual([older.segmentId]);
    expect(single.manifest.gatewayEpochs).toStrictEqual([
      "ffffffff-0000-7000-8000-000000000001",
    ]);
  });

  it("refuses a batch past maxTotalBatchBytes before reading a single segment", async () => {
    // M3: the resident set is proportional to the whole batch, so the bound is
    // a refusal at the door, not an OOM later. Nothing read, nothing uploaded.
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    const b = segmentB();
    place(fileSystem, a);
    place(fileSystem, b);
    const combined = a.segmentBytes.byteLength + b.segmentBytes.byteLength;

    await expect(run({ maxTotalBatchBytes: combined - 1 })).rejects.toBeInstanceOf(
      CompactionBatchLimitError,
    );
    expect(objectStore.keys()).toStrictEqual([]);
    expect(fileSystem.list(WAL_DIR)).toHaveLength(4);

    // Exactly at the bound, the run proceeds.
    const result = await run({ maxTotalBatchBytes: combined });
    expect(result.rowsWritten).toBe(5);

    // And a caller can compact the same backlog in bounded batches.
    const batch = await run({
      datasetId: "ds-batch",
      objectKeyPrefix: "datasets/ds-batch",
      maxTotalBatchBytes: a.segmentBytes.byteLength,
      segmentIds: [a.segmentId],
    });
    expect(batch.verifiedSegmentIds).toStrictEqual([a.segmentId]);
  });

  it("compacts an explicitly supplied subset of segments", async () => {
    const { fileSystem, run } = harness();
    const a = segmentA();
    place(fileSystem, a);
    place(fileSystem, segmentB());
    const result = await run({ segmentIds: [a.segmentId] });
    expect(result.verifiedSegmentIds).toStrictEqual([a.segmentId]);
    expect(result.rowsWritten).toBe(2);
  });

  it("reports compaction lag from the oldest segment it left behind", async () => {
    const { fileSystem, run } = harness();
    const clock = manualClock(Date.parse("2026-01-01T01:00:00.000Z"));
    const stale = buildSegmentFixture({
      gatewayEpoch: EPOCH,
      segmentIndex: 0,
      frames: [{ ingestSeq: "1", payloadUtf8: "x" }],
      closedAt: "2026-01-01T00:30:00.000Z",
    });
    place(fileSystem, stale);
    // Doctor the sidecar so the segment is refused but its `closedAt` is still
    // readable, which is exactly the state compaction lag describes.
    fileSystem.write(
      WAL_DIR,
      stale.manifestFileName,
      encodeManifest({ ...stale.manifest, recordCount: 99 }),
    );

    const result = await run({ clock });
    expect(result.refusedSegments).toHaveLength(1);
    expect(result.compactionLagMs).toBe(30 * 60_000);
  });

  it("reports no lag when nothing was left behind", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());
    expect((await run()).compactionLagMs).toBeNull();
  });
});

describe("retention (ADR-004 §5: delete only after a verified upload)", () => {
  it("deletes nothing by default, and writes no retention receipt", async () => {
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    place(fileSystem, a);

    const result = await run({ retention: retainAllWalSegments() });
    expect(result.deletedSegmentIds).toStrictEqual([]);
    expect(result.manifest.walRetentionPolicy).toBe("retain");
    expect(fileSystem.list(WAL_DIR)).toContain(a.segmentFileName);
    expect(result.retentionReceiptObjectKey).toBeNull();
    expect(result.retentionReceiptSha256).toBeNull();
    expect(objectStore.keys()).not.toContain(
      `datasets/ds-1/${DATASET_RETENTION_RECEIPT_OBJECT_NAME}`,
    );
  });

  it("deletes a segment and its sidecar only after the object is verified", async () => {
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    place(fileSystem, a);
    const retention = recordingRetention({ fileSystem, walDirectoryPath: WAL_DIR, objectStore });

    const result = await run({ retention });

    expect(result.deletedSegmentIds).toStrictEqual([a.segmentId]);
    expect(fileSystem.list(WAL_DIR)).toStrictEqual([]);
    expect(retention.requests).toHaveLength(1);
    const request = retention.requests[0];
    expect(request?.verifiedObjectSha256).toBe(result.manifest.objects[0]?.sha256);
    expect(request?.segmentSha256).toBe(a.manifest.segmentSha256);
    expect(request?.datasetManifestKey).toBe(result.manifestObjectKey);
    // The data survived the deletion.
    const rows = await readParquetObject(
      await objectStore.get(result.manifest.objects[0]?.objectKey ?? ""),
    );
    expect(rows.map((row) => row.record.ingestSeq)).toStrictEqual(["1", "2"]);
  });

  it("persists and verifies the manifest BEFORE the first deletion is requested", async () => {
    // The H1 ordering, asserted directly: at the moment `deleteSegment` runs,
    // the manifest and its digest sidecar must already be readable from the
    // store, because they are the proof a deleted segment stays recoverable.
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    place(fileSystem, a);
    const observedAtDeletion: string[][] = [];
    const inner = recordingRetention({ fileSystem, walDirectoryPath: WAL_DIR, objectStore });
    const result = await run({
      retention: {
        policyName: inner.policyName,
        async deleteSegment(request) {
          observedAtDeletion.push([...objectStore.keys()]);
          await inner.deleteSegment(request);
        },
      },
    });
    expect(observedAtDeletion).toHaveLength(1);
    expect(observedAtDeletion[0]).toContain(result.manifestObjectKey);
    expect(observedAtDeletion[0]).toContain(`datasets/ds-1/${DATASET_MANIFEST_DIGEST_OBJECT_NAME}`);
  });

  it("writes a retention receipt naming what was deleted, pinned to the manifest", async () => {
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    place(fileSystem, a);
    const retention = recordingRetention({ fileSystem, walDirectoryPath: WAL_DIR, objectStore });

    const result = await run({ retention });

    expect(result.retentionReceiptObjectKey).toBe(
      `datasets/ds-1/${DATASET_RETENTION_RECEIPT_OBJECT_NAME}`,
    );
    const receiptBytes = await objectStore.get(result.retentionReceiptObjectKey ?? "");
    expect(sha256Hex(receiptBytes)).toBe(result.retentionReceiptSha256);
    const receipt = JSON.parse(Buffer.from(receiptBytes).toString("utf8")) as {
      retentionReceiptFormatId: string;
      datasetManifestObjectKey: string;
      datasetManifestSha256: string;
      deletedSegments: { segmentId: string }[];
      retentionFailures: unknown[];
    };
    expect(receipt.retentionReceiptFormatId).toBe("polymarket-bot/retention-receipt/v1");
    expect(receipt.datasetManifestObjectKey).toBe(result.manifestObjectKey);
    expect(receipt.datasetManifestSha256).toBe(result.manifestSha256);
    expect(receipt.deletedSegments.map((entry) => entry.segmentId)).toStrictEqual([a.segmentId]);
    expect(receipt.retentionFailures).toStrictEqual([]);
    // Deletion state is NOT in the manifest: it was persisted before retention.
    const storedManifest = Buffer.from(
      await objectStore.get(result.manifestObjectKey),
    ).toString("utf8");
    expect(storedManifest).not.toContain("walSegmentDeleted");
  });

  it("keeps every WAL byte when the manifest cannot be persisted", async () => {
    // Reviewer probe (H1), now inverted: a store whose put() fails for the
    // manifest object must abort the run with the WAL fully intact and no
    // deletion ever requested.
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    place(fileSystem, a);
    const failing: typeof objectStore = {
      ...objectStore,
      async put(key: string, bytes: Uint8Array) {
        if (key.endsWith(DATASET_MANIFEST_OBJECT_NAME)) {
          throw new Error("store rejected the manifest put");
        }
        await objectStore.put(key, bytes);
      },
    };
    const retention = recordingRetention({
      fileSystem,
      walDirectoryPath: WAL_DIR,
      objectStore: failing,
    });

    await expect(run({ retention, objectStore: failing })).rejects.toThrow(
      "store rejected the manifest put",
    );
    expect(retention.requests).toStrictEqual([]);
    expect(fileSystem.list(WAL_DIR)).toStrictEqual([a.segmentFileName, a.manifestFileName]);
    expect(objectStore.keys().some((key) => key.endsWith(DATASET_MANIFEST_OBJECT_NAME))).toBe(
      false,
    );
  });

  it("keeps every WAL byte when the manifest read-back fails verification", async () => {
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    place(fileSystem, a);
    const lying: typeof objectStore = {
      ...objectStore,
      async get(key: string) {
        const bytes = await objectStore.get(key);
        if (key.endsWith(DATASET_MANIFEST_OBJECT_NAME)) {
          const mutated = Buffer.from(bytes);
          mutated[0] = (mutated[0] ?? 0) ^ 0xff;
          return mutated;
        }
        return bytes;
      },
    };
    const retention = recordingRetention({
      fileSystem,
      walDirectoryPath: WAL_DIR,
      objectStore: lying,
    });

    await expect(run({ retention, objectStore: lying })).rejects.toBeInstanceOf(
      ObjectVerificationError,
    );
    expect(retention.requests).toStrictEqual([]);
    expect(fileSystem.list(WAL_DIR)).toStrictEqual([a.segmentFileName, a.manifestFileName]);
  });

  it("keeps every WAL byte when the digest sidecar cannot be persisted", async () => {
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    place(fileSystem, a);
    const failing: typeof objectStore = {
      ...objectStore,
      async put(key: string, bytes: Uint8Array) {
        if (key.endsWith(DATASET_MANIFEST_DIGEST_OBJECT_NAME)) {
          throw new Error("store rejected the digest sidecar put");
        }
        await objectStore.put(key, bytes);
      },
    };
    const retention = recordingRetention({
      fileSystem,
      walDirectoryPath: WAL_DIR,
      objectStore: failing,
    });

    await expect(run({ retention, objectStore: failing })).rejects.toThrow(
      "store rejected the digest sidecar put",
    );
    expect(retention.requests).toStrictEqual([]);
    expect(fileSystem.list(WAL_DIR)).toStrictEqual([a.segmentFileName, a.manifestFileName]);
  });

  it("never deletes a refused segment, even when retention is enabled", async () => {
    const { fileSystem, objectStore, run } = harness();
    const good = segmentA();
    const broken = segmentB();
    place(fileSystem, good);
    place(fileSystem, broken);
    fileSystem.write(
      WAL_DIR,
      broken.segmentFileName,
      Buffer.from(broken.segmentBytes).toString("utf8").replace("conn-1", "conn-2"),
    );
    const retention = recordingRetention({ fileSystem, walDirectoryPath: WAL_DIR, objectStore });

    const result = await run({ retention });
    expect(result.deletedSegmentIds).toStrictEqual([good.segmentId]);
    expect(fileSystem.list(WAL_DIR)).toStrictEqual([
      broken.segmentFileName,
      broken.manifestFileName,
    ]);
  });

  it("keeps the WAL when the upload cannot be verified", async () => {
    const { fileSystem, objectStore, run } = harness();
    const a = segmentA();
    place(fileSystem, a);
    const retention = recordingRetention({ fileSystem, walDirectoryPath: WAL_DIR, objectStore });
    const original = objectStore.put.bind(objectStore);
    const rotting: typeof objectStore = {
      ...objectStore,
      async put(key: string, bytes: Uint8Array) {
        await original(key, bytes);
        if (key.endsWith(".parquet")) {
          objectStore.forget(key);
        }
      },
    };

    await expect(run({ retention, objectStore: rotting })).rejects.toBeInstanceOf(
      ObjectVerificationError,
    );
    expect(retention.requests).toStrictEqual([]);
    expect(fileSystem.list(WAL_DIR)).toStrictEqual([a.segmentFileName, a.manifestFileName]);
  });

  it("reports a retention failure without failing the run or losing the dataset", async () => {
    const { fileSystem, run } = harness();
    place(fileSystem, segmentA());
    const result = await run({
      retention: {
        policyName: "delete-after-verified-upload",
        async deleteSegment() {
          throw new Error("read-only filesystem");
        },
      },
    });
    expect(result.deletedSegmentIds).toStrictEqual([]);
    expect(result.retentionFailures[0]?.detail).toBe("read-only filesystem");
    expect(result.manifest.recordCounts.written).toBe(2);
  });
});
