/**
 * The exact replay door reads dataset-manifest versions 1 and 2, and refuses
 * the approximate class (`STORAGE-1`; ADR-029 Decisions 1, 2 and 4.3, and
 * Consequences: "`packages/simulation/src/manifest.ts`, the exact replay door
 * … must accept version 1 and version 2 `exact` manifests, and refuse a
 * version 2 `approximate` manifest").
 *
 * The documents below are both hand-shaped (from the committed v1 fixture
 * builder) and REAL: a version 2 exact manifest the compactor wrote, and a
 * research-tier manifest the research-tier writer wrote.
 */

import { describe, expect, it } from "vitest";

import {
  SUPPORTED_DATASET_MANIFEST_VERSIONS,
  readDatasetManifestBytes,
  readDatasetManifestText,
} from "../../../packages/simulation/src/index.js";
import {
  compactWalDirectory,
  writeResearchTierDataset,
} from "../../../packages/storage-parquet/src/index.js";
import {
  buildSegmentFixture,
  manualClock,
  memoryFileSystem,
  memoryObjectStore,
} from "../../../packages/storage-parquet/src/testing/index.js";
import { GATEWAY_EPOCH, buildDataset } from "./fixtures.js";

function v1Text(): string {
  return buildDataset({
    frames: [{ ingestSeq: "1", receivedAt: "2026-01-01T00:00:00.000Z", receivedMonotonicNs: "1", payloadUtf8: "{}" }],
  }).manifestText;
}

function asV2(text: string, fidelity: unknown | undefined): string {
  const document = JSON.parse(text) as Record<string, unknown>;
  const ordered: Record<string, unknown> = {
    datasetManifestFormatId: document["datasetManifestFormatId"],
    datasetManifestVersion: 2,
  };
  if (fidelity !== undefined) ordered["fidelity"] = fidelity;
  for (const [key, value] of Object.entries(document)) {
    if (key === "datasetManifestFormatId" || key === "datasetManifestVersion") continue;
    ordered[key] = value;
  }
  (ordered["schemaVersions"] as Record<string, unknown>)["datasetManifestVersion"] = 2;
  return JSON.stringify(ordered);
}

describe("the exact replay door: versions 1 and 2", () => {
  it("reads both versions", () => {
    expect(SUPPORTED_DATASET_MANIFEST_VERSIONS).toStrictEqual([1, 2]);
  });

  it("still reads a version 1 manifest (as exact), unchanged", () => {
    const result = readDatasetManifestText(v1Text());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.datasetManifestVersion).toBe(1);
  });

  it("refuses a version 1 manifest that carries a fidelity field (strict key list)", () => {
    const document = JSON.parse(v1Text()) as Record<string, unknown>;
    document["fidelity"] = "exact";
    const result = readDatasetManifestText(JSON.stringify(document));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("REPLAY_MANIFEST_INVALID");
  });

  it("reads a version 2 exact manifest", () => {
    const result = readDatasetManifestText(asV2(v1Text(), "exact"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.datasetManifestVersion).toBe(2);
  });

  it("refuses a version 2 approximate manifest with its own code", () => {
    const result = readDatasetManifestText(asV2(v1Text(), "approximate"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("REPLAY_MANIFEST_APPROXIMATE");
  });

  it("refuses a version 2 manifest without fidelity, or with an unknown one", () => {
    for (const fidelity of [undefined, "roughly", 1, null]) {
      const result = readDatasetManifestText(asV2(v1Text(), fidelity));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe("REPLAY_MANIFEST_INVALID");
    }
  });

  it("refuses a version this build does not read", () => {
    const document = JSON.parse(asV2(v1Text(), "exact")) as Record<string, unknown>;
    document["datasetManifestVersion"] = 3;
    const result = readDatasetManifestText(JSON.stringify(document));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("REPLAY_MANIFEST_UNSUPPORTED");
  });
});

describe("the door against the manifests this build actually writes", () => {
  it("reads the compactor's version 2 exact manifest", async () => {
    const fileSystem = memoryFileSystem();
    const fixture = buildSegmentFixture({
      gatewayEpoch: GATEWAY_EPOCH,
      segmentIndex: 0,
      frames: [{ ingestSeq: "1", payloadUtf8: "{}" }],
    });
    fileSystem.write("/wal", fixture.segmentFileName, fixture.segmentBytes);
    fileSystem.write("/wal", fixture.manifestFileName, fixture.manifestBytes);
    const objectStore = memoryObjectStore();
    const result = await compactWalDirectory({
      walDirectoryPath: "/wal",
      datasetId: "ds",
      objectKeyPrefix: "datasets/ds",
      objectStore,
      fileSystem,
      clock: manualClock(),
    });
    const read = readDatasetManifestBytes(await objectStore.get(result.manifestObjectKey));
    if (!read.ok) throw new Error(read.refusal.message);
    expect(read.value.datasetManifestVersion).toBe(2);
  });

  it("refuses the research-tier writer's approximate manifest", async () => {
    const objectStore = memoryObjectStore();
    const written = await writeResearchTierDataset({
      datasetId: "research",
      objectKeyPrefix: "research/e/research",
      objectStore,
      clock: manualClock(),
      gatewayEpoch: GATEWAY_EPOCH,
      downsampling: { downsamplingId: "t", downsamplingVersion: 1, parameters: {}, tieOrder: "t" },
      rowsByTable: new Map(),
      sourceSegments: [],
      recordCounts: { segmentDeclared: 0, framesRead: 0, framesInterpreted: 0, framesUninterpreted: 0 },
      samplerStateIn: null,
      samplerStateOut: Buffer.from("{}\n", "utf8"),
    });
    const read = readDatasetManifestBytes(await objectStore.get(written.manifestObjectKey));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("REPLAY_MANIFEST_APPROXIMATE");
  });
});
