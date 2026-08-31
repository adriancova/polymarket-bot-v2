/**
 * The real delete-after-verified-upload retention, probed as an adversarial
 * caller would call it — directly, with claims the durable store does not
 * back.
 *
 * Round-1 review invoked `deleteAfterVerifiedUploadRetention` with an
 * arbitrary non-Parquet object, that object's own digest, and a nonexistent
 * dataset-manifest key, and it deleted both WAL files. Every test here holds
 * the fixed implementation to the rule `ports.ts` states: the request is a
 * set of claims, and the proof is fetched from the store.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactWalDirectory } from "./compactor.js";
import type { CompactionResult } from "./compactor.js";
import {
  DATASET_MANIFEST_DIGEST_OBJECT_NAME,
  DATASET_MANIFEST_OBJECT_NAME,
} from "./constants.js";
import { encodeDatasetManifest } from "./dataset-manifest.js";
import type { DatasetManifest } from "./dataset-manifest.js";
import { RetentionGuardError } from "./errors.js";
import {
  deleteAfterVerifiedUploadRetention,
  fileSystemObjectStore,
  nodeCompactionFileSystem,
} from "./node-file-system.js";
import type { ObjectStore, SegmentDeletionRequest, WalSegmentRetention } from "./ports.js";
import { sha256Hex } from "./wal-format.js";
import { buildSegmentFixture, manualClock } from "./testing/index.js";
import type { SegmentFixture } from "./testing/wal-fixture.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";

let root: string;
let walDir: string;
let storeRoot: string;
let objectStore: ObjectStore;
let retention: WalSegmentRetention;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wp130-retention-"));
  walDir = join(root, "wal");
  storeRoot = join(root, "objects");
  await mkdir(walDir, { recursive: true });
  objectStore = fileSystemObjectStore(storeRoot);
  retention = deleteAfterVerifiedUploadRetention({ walDirectoryPath: walDir, objectStore });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function placeSegment(fixture: SegmentFixture): Promise<void> {
  await writeFile(join(walDir, fixture.segmentFileName), fixture.segmentBytes);
  await writeFile(join(walDir, fixture.manifestFileName), fixture.manifestBytes);
}

function victim(): SegmentFixture {
  return buildSegmentFixture({
    gatewayEpoch: EPOCH,
    segmentIndex: 0,
    frames: [
      { ingestSeq: "1", payloadUtf8: '{"event_type":"book"}' },
      { ingestSeq: "2", payloadUtf8: "PING", receivedAt: "2026-01-01T00:00:10.000Z" },
    ],
  });
}

/** Compact with the default (retain) policy, so the manifest is durable. */
async function compact(datasetId = "ds-ret"): Promise<CompactionResult> {
  return await compactWalDirectory({
    walDirectoryPath: walDir,
    datasetId,
    objectKeyPrefix: `datasets/${datasetId}`,
    objectStore,
    fileSystem: nodeCompactionFileSystem(),
    clock: manualClock(),
  });
}

/** The truthful deletion request for the compacted victim segment. */
function requestFor(result: CompactionResult, fixture: SegmentFixture): SegmentDeletionRequest {
  const segment = result.manifest.segments.find((s) => s.segmentId === fixture.segmentId);
  const object = result.manifest.objects.find((o) => o.segmentIds.includes(fixture.segmentId));
  if (segment === undefined || object === undefined) {
    throw new Error("compaction did not pin the fixture segment");
  }
  return {
    segmentId: segment.segmentId,
    gatewayEpoch: segment.gatewayEpoch,
    recordCount: segment.recordCount,
    segmentSha256: segment.segmentSha256,
    verifiedObjectKey: object.objectKey,
    verifiedObjectSha256: object.sha256,
    datasetManifestKey: result.manifestObjectKey,
  };
}

describe("deleteAfterVerifiedUploadRetention: the proof comes from the store", () => {
  it("refuses the reviewer's misuse probe: arbitrary bytes, matching digest, absent manifest", async () => {
    const fixture = victim();
    await placeSegment(fixture);
    const arbitrary = Buffer.from("not parquet at all", "utf8");
    await objectStore.put("junk/arbitrary.bin", arbitrary);

    await expect(
      retention.deleteSegment({
        segmentId: fixture.segmentId,
        gatewayEpoch: EPOCH,
        recordCount: fixture.records.length,
        segmentSha256: fixture.manifest.segmentSha256,
        verifiedObjectKey: "junk/arbitrary.bin",
        verifiedObjectSha256: sha256Hex(arbitrary),
        datasetManifestKey: "datasets/NONEXISTENT/manifest.json",
      }),
    ).rejects.toBeInstanceOf(RetentionGuardError);

    expect((await readdir(walDir)).sort()).toStrictEqual([
      fixture.segmentFileName,
      fixture.manifestFileName,
    ].sort());
  });

  it("deletes when — and only because — the persisted manifest backs every claim", async () => {
    const fixture = victim();
    await placeSegment(fixture);
    const result = await compact();

    await retention.deleteSegment(requestFor(result, fixture));

    expect(await readdir(walDir)).toStrictEqual([]);
    // The archive still serves the rows.
    const objectKey = result.manifest.objects[0]?.objectKey ?? "";
    const stored = await readFile(join(storeRoot, objectKey));
    expect(sha256Hex(stored)).toBe(result.manifest.objects[0]?.sha256);
  });

  it("refuses a request that contradicts the pinned segment checksum", async () => {
    const fixture = victim();
    await placeSegment(fixture);
    const result = await compact();
    const truthful = requestFor(result, fixture);

    await expect(
      retention.deleteSegment({
        ...truthful,
        segmentSha256: sha256Hex("some other segment"),
      }),
    ).rejects.toBeInstanceOf(RetentionGuardError);
    expect(await readdir(walDir)).toHaveLength(2);
  });

  it("refuses a request that contradicts the pinned record count", async () => {
    const fixture = victim();
    await placeSegment(fixture);
    const result = await compact();
    const truthful = requestFor(result, fixture);

    await expect(
      retention.deleteSegment({ ...truthful, recordCount: truthful.recordCount + 1 }),
    ).rejects.toBeInstanceOf(RetentionGuardError);
    expect(await readdir(walDir)).toHaveLength(2);
  });

  it("refuses when the manifest's digest sidecar is missing", async () => {
    const fixture = victim();
    await placeSegment(fixture);
    const result = await compact();
    await unlink(join(storeRoot, "datasets/ds-ret", DATASET_MANIFEST_DIGEST_OBJECT_NAME));

    await expect(retention.deleteSegment(requestFor(result, fixture))).rejects.toBeInstanceOf(
      RetentionGuardError,
    );
    expect(await readdir(walDir)).toHaveLength(2);
  });

  it("refuses when the segment file changed after compaction", async () => {
    const fixture = victim();
    await placeSegment(fixture);
    const result = await compact();
    // Appended bytes: the file on disk is no longer the file the manifest
    // describes, so deleting it would destroy unarchived data.
    const segmentPath = join(walDir, fixture.segmentFileName);
    const original = await readFile(segmentPath);
    await writeFile(segmentPath, Buffer.concat([original, Buffer.from("{tail", "utf8")]));

    await expect(retention.deleteSegment(requestFor(result, fixture))).rejects.toBeInstanceOf(
      RetentionGuardError,
    );
    expect(await readdir(walDir)).toHaveLength(2);
  });

  it("refuses a forged manifest whose pinned object does not provide the segment's rows", async () => {
    // The strongest misuse: a manifest that pins the victim's true checksums
    // but names an object holding a DIFFERENT segment's rows. Digest checks
    // alone would pass; the row-provision check must not.
    const fixture = victim();
    await placeSegment(fixture);
    const other = buildSegmentFixture({
      gatewayEpoch: EPOCH,
      segmentIndex: 1,
      frames: [{ ingestSeq: "9", payloadUtf8: "other" }],
    });
    await placeSegment(other);
    const result = await compact();
    const otherObject = result.manifest.objects.find((o) =>
      o.segmentIds.includes(other.segmentId),
    );
    const victimEntry = result.manifest.segments.find((s) => s.segmentId === fixture.segmentId);
    if (otherObject === undefined || victimEntry === undefined) {
      throw new Error("fixture segments were not both compacted");
    }

    const forged: DatasetManifest = {
      ...result.manifest,
      segments: [{ ...victimEntry, objectKey: otherObject.objectKey }],
      objects: [{ ...otherObject, segmentIds: [fixture.segmentId] }],
    };
    const forgedBytes = encodeDatasetManifest(forged);
    const forgedKey = `datasets/forged/${DATASET_MANIFEST_OBJECT_NAME}`;
    await objectStore.put(forgedKey, forgedBytes);
    await objectStore.put(
      `datasets/forged/${DATASET_MANIFEST_DIGEST_OBJECT_NAME}`,
      Buffer.from(`${sha256Hex(forgedBytes)}\n`, "utf8"),
    );

    await expect(
      retention.deleteSegment({
        segmentId: fixture.segmentId,
        gatewayEpoch: EPOCH,
        recordCount: victimEntry.recordCount,
        segmentSha256: victimEntry.segmentSha256,
        verifiedObjectKey: otherObject.objectKey,
        verifiedObjectSha256: otherObject.sha256,
        datasetManifestKey: forgedKey,
      }),
    ).rejects.toBeInstanceOf(RetentionGuardError);
    expect(await readdir(walDir)).toHaveLength(4);
  });
});
