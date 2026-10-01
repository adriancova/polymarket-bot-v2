/**
 * Dataset-manifest versions 1 and 2, and retention-receipt versions 1 and 2
 * (`STORAGE-1`; ADR-029 Decision 1 and Consequences; ADR-028 Decision 4.3).
 *
 * The acceptance lines pinned here:
 *
 * - "Version-1 manifests and receipts still read; version-1 manifests read as
 *   exact."
 * - "Before any version-2 manifest is written, every dataset-manifest reader
 *   accepts version 1 and version 2 (storage-parquet, …)."
 * - ADR-029 Decision 1.6: "A reader refuses a version 2 manifest without it."
 */

import { describe, expect, it } from "vitest";

import { compactWalDirectory } from "./compactor.js";
import { DATASET_MANIFEST_VERSION, RETENTION_RECEIPT_VERSION } from "./constants.js";
import { encodeDatasetManifest, parseDatasetManifest, readDatasetManifestFidelity } from "./dataset-manifest.js";
import type { DatasetManifest } from "./dataset-manifest.js";
import { parseAnyDatasetManifest } from "./research-tier-manifest.js";
import { buildRetentionReceipt, encodeRetentionReceipt, parseRetentionReceipt } from "./retention-receipt.js";
import {
  buildSegmentFixture,
  manualClock,
  memoryFileSystem,
  memoryObjectStore,
  recordingRetention,
} from "./testing/index.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";
const WAL = "/wal";

async function compactOne(datasetManifestVersion?: 1 | 2) {
  const fileSystem = memoryFileSystem();
  const fixture = buildSegmentFixture({
    gatewayEpoch: EPOCH,
    segmentIndex: 0,
    frames: [{ ingestSeq: "1", payloadUtf8: '{"event_type":"book"}' }],
  });
  fileSystem.write(WAL, fixture.segmentFileName, fixture.segmentBytes);
  fileSystem.write(WAL, fixture.manifestFileName, fixture.manifestBytes);
  const objectStore = memoryObjectStore();
  const result = await compactWalDirectory({
    walDirectoryPath: WAL,
    datasetId: "ds",
    objectKeyPrefix: "datasets/ds",
    objectStore,
    fileSystem,
    clock: manualClock(),
    ...(datasetManifestVersion === undefined ? {} : { datasetManifestVersion }),
  });
  const document = JSON.parse(Buffer.from(await objectStore.get(result.manifestObjectKey)).toString("utf8")) as Record<
    string,
    unknown
  >;
  return { result, document, fileSystem, objectStore, fixture };
}

describe("the compactor writes version 2 with fidelity exact", () => {
  it("writes datasetManifestVersion 2, fidelity exact, right after the version", async () => {
    const { document, result } = await compactOne();
    expect(DATASET_MANIFEST_VERSION).toBe(2);
    expect(document["datasetManifestVersion"]).toBe(2);
    expect(document["fidelity"]).toBe("exact");
    expect(Object.keys(document).slice(0, 4)).toStrictEqual([
      "datasetManifestFormatId",
      "datasetManifestVersion",
      "fidelity",
      "datasetId",
    ]);
    expect((document["schemaVersions"] as Record<string, unknown>)["datasetManifestVersion"]).toBe(2);
    // The format id is the coarse discriminator; it does not move (STORAGE-1's answer to ADR-029 1.2).
    expect(document["datasetManifestFormatId"]).toBe("polymarket-bot/dataset-manifest/v1");
    expect(result.manifest.fidelity).toBe("exact");
  });

  it("still writes a byte-identical version 1 document when asked, with no fidelity field", async () => {
    const { document, result } = await compactOne(1);
    expect(document["datasetManifestVersion"]).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(document, "fidelity")).toBe(false);
    // The encoder omits fidelity for version 1, so the bytes are WP-130's.
    expect(Buffer.from(encodeDatasetManifest(result.manifest)).toString("utf8")).not.toContain('"fidelity"');
  });
});

describe("the storage-parquet readers accept version 1 and version 2", () => {
  it("reads version 1 as exact (ADR-029 Decision 1.3)", async () => {
    const { document } = await compactOne(1);
    expect(readDatasetManifestFidelity(document)).toBe("exact");
    expect(parseDatasetManifest(document).fidelity).toBe("exact");
    const any = parseAnyDatasetManifest(document);
    expect(any.fidelity).toBe("exact");
  });

  it("reads version 2 exact", async () => {
    const { document } = await compactOne();
    expect(parseDatasetManifest(document).datasetManifestVersion).toBe(2);
    expect(parseAnyDatasetManifest(document).fidelity).toBe("exact");
  });

  it("refuses a version 2 manifest without fidelity (ADR-029 Decision 1.6)", async () => {
    const { document } = await compactOne();
    delete document["fidelity"];
    expect(() => parseDatasetManifest(document)).toThrow(/must state its fidelity/u);
    expect(() => parseAnyDatasetManifest(document)).toThrow(/must state its fidelity/u);
  });

  it("refuses an unknown fidelity", async () => {
    const { document } = await compactOne();
    document["fidelity"] = "mostly-exact";
    expect(() => parseAnyDatasetManifest(document)).toThrow(/unknown fidelity/u);
  });

  it("refuses a version 1 manifest that carries a fidelity field", async () => {
    const { document } = await compactOne(1);
    document["fidelity"] = "approximate";
    expect(() => parseAnyDatasetManifest(document)).toThrow(/version 1 dataset manifest has no fidelity/u);
  });

  it("refuses a version it does not read", async () => {
    const { document } = await compactOne();
    document["datasetManifestVersion"] = 3;
    expect(() => parseAnyDatasetManifest(document)).toThrow(/not readable by this build/u);
  });

  it("the exact reader refuses an approximate manifest (it cannot prove a lossless deletion)", async () => {
    const { document } = await compactOne();
    document["fidelity"] = "approximate";
    expect(() => parseDatasetManifest(document)).toThrow(/approximate/u);
  });

  it("refuses to encode an approximate document as an exact manifest", async () => {
    const { result } = await compactOne();
    const forged = { ...result.manifest, fidelity: "approximate" } as unknown as DatasetManifest;
    expect(() => encodeDatasetManifest(forged)).toThrow(/fidelity exact/u);
  });
});

describe("retention receipts: version 2 writes a basis; version 1 still reads", () => {
  it("the compactor writes a version 2 receipt whose deletions are verified-upload", async () => {
    const fileSystem = memoryFileSystem();
    const fixture = buildSegmentFixture({
      gatewayEpoch: EPOCH,
      segmentIndex: 0,
      frames: [{ ingestSeq: "1", payloadUtf8: "PING" }],
    });
    fileSystem.write(WAL, fixture.segmentFileName, fixture.segmentBytes);
    fileSystem.write(WAL, fixture.manifestFileName, fixture.manifestBytes);
    const objectStore = memoryObjectStore();
    const result = await compactWalDirectory({
      walDirectoryPath: WAL,
      datasetId: "ds",
      objectKeyPrefix: "datasets/ds",
      objectStore,
      fileSystem,
      clock: manualClock(),
      retention: recordingRetention({ fileSystem, walDirectoryPath: WAL, objectStore }),
    });
    const document = JSON.parse(
      Buffer.from(await objectStore.get(result.retentionReceiptObjectKey ?? "")).toString("utf8"),
    ) as Record<string, unknown>;
    expect(RETENTION_RECEIPT_VERSION).toBe(2);
    expect(document["retentionReceiptVersion"]).toBe(2);
    const receipt = parseRetentionReceipt(document);
    expect(receipt.deletedSegments).toHaveLength(1);
    expect(receipt.deletedSegments[0]?.basis).toBe("verified-upload");
    expect(receipt.expiryPlanId).toBeNull();
  });

  it("reads a version 1 receipt, its entries as verified-upload", () => {
    const v1 = {
      retentionReceiptFormatId: "polymarket-bot/retention-receipt/v1",
      retentionReceiptVersion: 1,
      datasetId: "ds",
      datasetManifestObjectKey: "datasets/ds/manifest.json",
      datasetManifestSha256: "a".repeat(64),
      walRetentionPolicy: "delete-after-verified-upload",
      completedAt: "2026-01-01T00:00:00.000Z",
      deletedSegments: [{ segmentId: "s0", verifiedObjectKey: "datasets/ds/s0.parquet", verifiedObjectSha256: "b".repeat(64) }],
      retentionFailures: [],
    };
    const receipt = parseRetentionReceipt(v1);
    expect(receipt.retentionReceiptVersion).toBe(1);
    expect(receipt.deletedSegments[0]).toStrictEqual({
      basis: "verified-upload",
      segmentId: "s0",
      verifiedObjectKey: "datasets/ds/s0.parquet",
      verifiedObjectSha256: "b".repeat(64),
    });
  });

  it("refuses a version 1 entry that carries a basis, and an unknown basis in version 2", () => {
    expect(() =>
      parseRetentionReceipt({
        retentionReceiptFormatId: "polymarket-bot/retention-receipt/v1",
        retentionReceiptVersion: 1,
        datasetId: "ds",
        datasetManifestObjectKey: "k",
        datasetManifestSha256: "s",
        walRetentionPolicy: "p",
        completedAt: "2026-01-01T00:00:00.000Z",
        deletedSegments: [{ basis: "expired-after-extract", segmentId: "s0", verifiedObjectKey: "k", verifiedObjectSha256: "s" }],
        retentionFailures: [],
      }),
    ).toThrow(/version 1 entry has no basis/u);
    const v2 = encodeRetentionReceipt(
      buildRetentionReceipt({
        datasetId: null,
        datasetManifestObjectKey: null,
        datasetManifestSha256: null,
        expiryPlanId: "plan-1",
        expiryPlanSha256: "c".repeat(64),
        walRetentionPolicy: "expire-after-extract",
        completedAt: "2026-01-01T00:00:00.000Z",
        deletedSegments: [],
        retentionFailures: [],
      }),
    );
    const document = JSON.parse(Buffer.from(v2).toString("utf8")) as Record<string, unknown>;
    document["deletedSegments"] = [{ basis: "because", segmentId: "s0" }];
    expect(() => parseRetentionReceipt(document)).toThrow(/unknown deletion basis/u);
  });

  it("round-trips an expired-after-extract entry naming the research tier and every pin", () => {
    const receipt = buildRetentionReceipt({
      datasetId: null,
      datasetManifestObjectKey: null,
      datasetManifestSha256: null,
      expiryPlanId: "plan-1",
      expiryPlanSha256: "c".repeat(64),
      walRetentionPolicy: "expire-after-extract",
      completedAt: "2026-01-01T00:00:00.000Z",
      deletedSegments: [
        {
          basis: "expired-after-extract",
          segmentId: "s0",
          gatewayEpoch: EPOCH,
          segmentSha256: "d".repeat(64),
          segmentFileSha256: "e".repeat(64),
          researchTier: { datasetId: "r", manifestObjectKey: "research/r/manifest.json", manifestSha256: "f".repeat(64) },
          pins: [{ pinId: "window-w", datasetId: "p", manifestObjectKey: "pins/w/manifest.json", manifestSha256: "0".repeat(64) }],
        },
      ],
      retentionFailures: [],
    });
    const parsed = parseRetentionReceipt(JSON.parse(Buffer.from(encodeRetentionReceipt(receipt)).toString("utf8")));
    expect(parsed).toStrictEqual(receipt);
  });
});
