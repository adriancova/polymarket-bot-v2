/**
 * The research-tier writer and the expired-after-extract deletion guard
 * (`STORAGE-1`; ADR-028 Decisions 2.2, 2.4, 2.6, 2.7; ADR-029 Decision 1).
 *
 * The acceptance lines pinned here:
 *
 * - "The research-tier manifest and every overlapping pin manifest list each
 *   source segment's segmentSha256 and segmentFileSha256; just before deletion
 *   the file must hash to both pinned digests (segmentFileSha256 over its full
 *   length), or it is kept."
 * - The research tier is "verified": read back from the store and checked
 *   against its manifest digest.
 * - Deletion code must be impossible to point at a directory by default: the
 *   real deletion refuses a WAL root without its opt-in marker.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactWalDirectory } from "./compactor.js";
import type { CompactionResult } from "./compactor.js";
import { RetentionGuardError } from "./errors.js";
import { verifyExpiryProof } from "./expiry-proof.js";
import type { ExpiryDeletionRequest } from "./expiry-proof.js";
import {
  EXPIRY_OPT_IN_MARKER_CONTENT,
  EXPIRY_OPT_IN_MARKER_FILE_NAME,
  expireAfterExtractDeletion,
  fileSystemObjectStore,
  nodeCompactionFileSystem,
} from "./node-file-system.js";
import type { ObjectStore } from "./ports.js";
import type { ResearchRow } from "./research-tier-layout.js";
import { RESEARCH_SOURCE_VERIFICATION } from "./research-tier-manifest.js";
import type { ResearchSourceSegment } from "./research-tier-manifest.js";
import { verifyResearchTierDataset, writeResearchTierDataset } from "./research-tier-writer.js";
import type { ResearchTierWriteResult } from "./research-tier-writer.js";
import { buildSegmentFixture, manualClock, memoryObjectStore } from "./testing/index.js";
import type { SegmentFixture } from "./testing/wal-fixture.js";
import { sha256Hex } from "./wal-format.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";

function fixture(): SegmentFixture {
  return buildSegmentFixture({
    gatewayEpoch: EPOCH,
    segmentIndex: 0,
    frames: [
      { ingestSeq: "1", payloadUtf8: '{"event_type":"book"}', receivedAt: "2026-01-01T00:00:00.000Z" },
      { ingestSeq: "2", payloadUtf8: "PONG", receivedAt: "2026-01-01T00:00:05.000Z" },
    ],
  });
}

function sourceOf(segment: SegmentFixture): ResearchSourceSegment {
  return {
    segmentId: segment.segmentId,
    gatewayEpoch: EPOCH,
    segmentIndex: 0,
    segmentSha256: segment.manifest.segmentSha256,
    segmentFileSha256: sha256Hex(segment.segmentBytes),
    checksummedByteLength: segment.manifest.checksummedByteLength,
    byteSize: segment.segmentBytes.byteLength,
    recordCount: segment.records.length,
    firstIngestSeq: "1",
    lastIngestSeq: "2",
    minReceivedAt: "2026-01-01T00:00:00.000Z",
    maxReceivedAt: "2026-01-01T00:00:05.000Z",
    verification: RESEARCH_SOURCE_VERIFICATION,
  };
}

function feedEventRow(ordinal: number, ingestSeq: string, segmentId: string): ResearchRow {
  return {
    sampleOrdinal: ordinal,
    gatewayEpoch: EPOCH,
    releaseIngestSeq: ingestSeq,
    availableAt: "2026-01-01T00:00:00.000Z",
    releaseSegmentId: segmentId,
    source: "polymarket",
    endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    connectionId: "conn-1",
    subscriptionGeneration: 0,
    eventKind: "connection-observed",
    detail: "first seen",
    payloadSha256: "a".repeat(64),
  };
}

async function writeResearch(
  objectStore: ObjectStore,
  segment: SegmentFixture,
  sources: readonly ResearchSourceSegment[] = [sourceOf(segment)],
): Promise<ResearchTierWriteResult> {
  return await writeResearchTierDataset({
    datasetId: "research-1",
    objectKeyPrefix: "research/e/research-1",
    objectStore,
    clock: manualClock(),
    gatewayEpoch: EPOCH,
    downsampling: { downsamplingId: "test/v1", downsamplingVersion: 1, parameters: { spanMs: 1000 }, tieOrder: "test" },
    rowsByTable: new Map([["feed_events", [feedEventRow(0, "1", segment.segmentId)]]]),
    sourceSegments: sources,
    recordCounts: { segmentDeclared: 2, framesRead: 2, framesInterpreted: 1, framesUninterpreted: 1 },
    samplerStateIn: null,
    samplerStateOut: Buffer.from("{}\n", "utf8"),
  });
}

describe("writeResearchTierDataset", () => {
  it("writes a version 2 approximate manifest that verifies from the store", async () => {
    const objectStore = memoryObjectStore();
    const segment = fixture();
    const written = await writeResearch(objectStore, segment);
    const manifest = JSON.parse(Buffer.from(await objectStore.get(written.manifestObjectKey)).toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest["datasetManifestVersion"]).toBe(2);
    expect(manifest["fidelity"]).toBe("approximate");
    expect(String(manifest["admissibility"])).toMatch(/^approximate/u);
    const verified = await verifyResearchTierDataset(objectStore, written.manifestObjectKey);
    expect(verified.manifestSha256).toBe(written.manifestSha256);
    expect(verified.manifest.sourceSegments[0]?.segmentFileSha256).toBe(sha256Hex(segment.segmentBytes));
  });

  it("refuses rows that would replay out of release order (ADR-029 Decision 5.3)", async () => {
    const segment = fixture();
    await expect(
      writeResearchTierDataset({
        datasetId: "r",
        objectKeyPrefix: "research/e/r",
        objectStore: memoryObjectStore(),
        clock: manualClock(),
        gatewayEpoch: EPOCH,
        downsampling: { downsamplingId: "t", downsamplingVersion: 1, parameters: {}, tieOrder: "t" },
        rowsByTable: new Map([
          ["feed_events", [feedEventRow(0, "2", segment.segmentId), feedEventRow(1, "1", segment.segmentId)]],
        ]),
        sourceSegments: [sourceOf(segment)],
        recordCounts: { segmentDeclared: 2, framesRead: 2, framesInterpreted: 1, framesUninterpreted: 1 },
        samplerStateIn: null,
        samplerStateOut: Buffer.from("{}\n", "utf8"),
      }),
    ).rejects.toThrow(/out of release order/u);
  });

  it("verification fails when a research object or the sidecar changes", async () => {
    const objectStore = memoryObjectStore();
    const written = await writeResearch(objectStore, fixture());
    const objectKey = written.manifest.objects[0]?.objectKey ?? "";
    const original = await objectStore.get(objectKey);
    const tampered = Uint8Array.from(original);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ?? 0) ^ 0xff;
    objectStore.corrupt(objectKey, tampered);
    await expect(verifyResearchTierDataset(objectStore, written.manifestObjectKey)).rejects.toThrow(/digest differs/u);
    objectStore.corrupt(objectKey, original);
    objectStore.corrupt("research/e/research-1/manifest.sha256", Buffer.from(`${"0".repeat(64)}\n`));
    await expect(verifyResearchTierDataset(objectStore, written.manifestObjectKey)).rejects.toThrow(/sidecar/u);
  });
});

// ---------------------------------------------------------------------------
// The deletion-time guard
// ---------------------------------------------------------------------------

let root: string;
let walRoot: string;
let walDir: string;
let objectStore: ObjectStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "storage1-expiry-proof-"));
  walRoot = join(root, "wal");
  walDir = join(walRoot, EPOCH);
  await mkdir(walDir, { recursive: true });
  objectStore = fileSystemObjectStore(join(root, "objects"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setUp(): Promise<{
  segment: SegmentFixture;
  research: ResearchTierWriteResult;
  pin: CompactionResult;
  request: ExpiryDeletionRequest;
}> {
  const segment = fixture();
  await writeFile(join(walDir, segment.segmentFileName), segment.segmentBytes);
  await writeFile(join(walDir, segment.manifestFileName), segment.manifestBytes);
  const research = await writeResearch(objectStore, segment);
  const pin = await compactWalDirectory({
    walDirectoryPath: walDir,
    datasetId: "pin-1",
    objectKeyPrefix: "pins/window-w/e",
    objectStore,
    fileSystem: nodeCompactionFileSystem(),
    clock: manualClock(),
  });
  const request: ExpiryDeletionRequest = {
    segmentId: segment.segmentId,
    gatewayEpoch: EPOCH,
    segmentSha256: segment.manifest.segmentSha256,
    segmentFileSha256: sha256Hex(segment.segmentBytes),
    researchTier: { datasetId: "research-1", manifestObjectKey: research.manifestObjectKey, manifestSha256: research.manifestSha256 },
    pins: [{ pinId: "window-w", datasetId: "pin-1", manifestObjectKey: pin.manifestObjectKey, manifestSha256: pin.manifestSha256 }],
  };
  return { segment, research, pin, request };
}

function readerOf(bytes: Uint8Array): { objectStore: ObjectStore; readSegmentFile: () => Promise<Uint8Array> } {
  return { objectStore, readSegmentFile: () => Promise.resolve(bytes) };
}

describe("verifyExpiryProof: the bytes are the ones extracted, checked at deletion time", () => {
  it("passes for the extracted file, the verified research tier and the verified pin", async () => {
    const { segment, request } = await setUp();
    const outcome = await verifyExpiryProof(readerOf(segment.segmentBytes), request);
    expect(outcome.pinsVerified).toBe(1);
    expect(outcome.researchEntry.segmentFileSha256).toBe(request.segmentFileSha256);
  });

  it("keeps a file whose footer changed in place: the whole-file digest (Decision 2.7)", async () => {
    const { segment, request } = await setUp();
    const text = Buffer.from(segment.segmentBytes).toString("utf8");
    // Same length, footer only: the checksummed span cannot see it.
    const mutated = Buffer.from(text.replace('"closeReason":"shutdown"', '"closeReason":"shutdowM"'), "utf8");
    expect(mutated.byteLength).toBe(segment.segmentBytes.byteLength);
    await expect(verifyExpiryProof(readerOf(mutated), request)).rejects.toThrow(/whole-file digest/u);
  });

  it("keeps a truncated file", async () => {
    const { segment, request } = await setUp();
    await expect(verifyExpiryProof(readerOf(segment.segmentBytes.subarray(0, 40)), request)).rejects.toThrow(
      /length differs/u,
    );
  });

  it("keeps a file whose checksummed span changed", async () => {
    const { segment, request } = await setUp();
    const text = Buffer.from(segment.segmentBytes).toString("utf8");
    const mutated = Buffer.from(text.replace("PONG", "PANG"), "utf8");
    await expect(verifyExpiryProof(readerOf(mutated), request)).rejects.toThrow(/segmentSha256/u);
  });

  it("refuses when the research tier does not verify (an object changed)", async () => {
    const { segment, research, request } = await setUp();
    const objectKey = research.manifest.objects[0]?.objectKey ?? "";
    // The filesystem store refuses overwrites; rot is simulated on disk.
    const path = join(root, "objects", objectKey);
    await writeFile(path, Buffer.from("rot"));
    await expect(verifyExpiryProof(readerOf(segment.segmentBytes), request)).rejects.toThrow(/research tier is not verified/u);
  });

  it("refuses when the research-tier manifest is not the one the plan pinned", async () => {
    const { segment, request } = await setUp();
    await expect(
      verifyExpiryProof(readerOf(segment.segmentBytes), {
        ...request,
        researchTier: { ...request.researchTier, manifestSha256: "0".repeat(64) },
      }),
    ).rejects.toThrow(/not the one the plan pinned/u);
  });

  it("refuses when the research tier does not list the segment", async () => {
    const { segment, request } = await setUp();
    const other = { ...sourceOf(segment), segmentId: "someone-else" };
    const research = await writeResearchTierDataset({
      datasetId: "research-2",
      objectKeyPrefix: "research/e/research-2",
      objectStore,
      clock: manualClock(),
      gatewayEpoch: EPOCH,
      downsampling: { downsamplingId: "t", downsamplingVersion: 1, parameters: {}, tieOrder: "t" },
      rowsByTable: new Map(),
      sourceSegments: [other],
      recordCounts: { segmentDeclared: 0, framesRead: 0, framesInterpreted: 0, framesUninterpreted: 0 },
      samplerStateIn: null,
      samplerStateOut: Buffer.from("{}\n", "utf8"),
    });
    await expect(
      verifyExpiryProof(readerOf(segment.segmentBytes), {
        ...request,
        researchTier: { datasetId: "research-2", manifestObjectKey: research.manifestObjectKey, manifestSha256: research.manifestSha256 },
      }),
    ).rejects.toThrow(/does not list it as a source/u);
  });

  it("refuses when the request's digests contradict the research tier", async () => {
    const { segment, request } = await setUp();
    await expect(
      verifyExpiryProof(readerOf(segment.segmentBytes), { ...request, segmentFileSha256: "1".repeat(64) }),
    ).rejects.toThrow(/contradicts what the research-tier manifest pins/u);
  });

  it("refuses when an overlapping pin's object no longer preserves the bytes", async () => {
    const { segment, pin, request } = await setUp();
    const objectKey = pin.manifest.objects[0]?.objectKey ?? "";
    await writeFile(join(root, "objects", objectKey), Buffer.from("rot"));
    await expect(verifyExpiryProof(readerOf(segment.segmentBytes), request)).rejects.toThrow(
      /does not preserve the segment's bytes/u,
    );
  });

  it("refuses a pin manifest the plan did not pin, or an approximate one", async () => {
    const { segment, research, request } = await setUp();
    const firstPin = request.pins[0];
    if (firstPin === undefined) throw new Error("no pin");
    await expect(
      verifyExpiryProof(readerOf(segment.segmentBytes), {
        ...request,
        pins: [{ ...firstPin, manifestSha256: "2".repeat(64) }],
      }),
    ).rejects.toThrow(/not the one the plan pinned/u);
    await expect(
      verifyExpiryProof(readerOf(segment.segmentBytes), {
        ...request,
        pins: [{ pinId: "window-w", datasetId: "research-1", manifestObjectKey: research.manifestObjectKey, manifestSha256: research.manifestSha256 }],
      }),
    ).rejects.toThrow(/not an exact dataset manifest/u);
  });
});

describe("expireAfterExtractDeletion: impossible to point at a directory by default", () => {
  it("refuses without the opt-in marker, and deletes nothing", async () => {
    const { request } = await setUp();
    const deletion = expireAfterExtractDeletion({ walRootPath: walRoot, objectStore });
    await expect(deletion.deleteExpiredSegment(walDir, request)).rejects.toThrow(/has not opted in/u);
    expect((await readdir(walDir)).sort()).toHaveLength(2);
  });

  it("refuses a marker with other content", async () => {
    const { request } = await setUp();
    await writeFile(join(walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), "yes please\n");
    const deletion = expireAfterExtractDeletion({ walRootPath: walRoot, objectStore });
    await expect(deletion.deleteExpiredSegment(walDir, request)).rejects.toThrow(/has not opted in/u);
  });

  it("refuses a directory outside the opted-in root", async () => {
    const { request } = await setUp();
    await writeFile(join(walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const deletion = expireAfterExtractDeletion({ walRootPath: join(root, "elsewhere"), objectStore });
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await writeFile(join(root, "elsewhere", EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    await expect(deletion.deleteExpiredSegment(walDir, request)).rejects.toThrow(/outside the opted-in WAL root/u);
    expect(await readdir(walDir)).toHaveLength(2);
  });

  it("deletes the segment and its manifest after the proof, with the marker", async () => {
    const { request } = await setUp();
    await writeFile(join(walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const deletion = expireAfterExtractDeletion({ walRootPath: walRoot, objectStore });
    const outcome = await deletion.deleteExpiredSegment(walDir, request);
    expect(outcome.pinsVerified).toBe(1);
    expect(await readdir(walDir)).toStrictEqual([]);
  });

  it("keeps the file when it changed after extraction, even with the marker", async () => {
    const { segment, request } = await setUp();
    await writeFile(join(walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const text = Buffer.from(segment.segmentBytes).toString("utf8");
    await writeFile(join(walDir, segment.segmentFileName), text.replace('"closeReason":"shutdown"', '"closeReason":"shutdowM"'));
    const deletion = expireAfterExtractDeletion({ walRootPath: walRoot, objectStore });
    await expect(deletion.deleteExpiredSegment(walDir, request)).rejects.toBeInstanceOf(RetentionGuardError);
    expect(await readdir(walDir)).toHaveLength(2);
  });
});
