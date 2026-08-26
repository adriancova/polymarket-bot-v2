import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { WalSegmentIntegrityError } from "./errors.js";
import { manifestFileName, segmentFileName } from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import {
  iterateSegmentRecords,
  readSegmentRecords,
  scanSegment,
  validateSegment,
  validateWalDirectory,
} from "./reader.js";
import { encodeFrameLine } from "./segment-format.js";
import { createManualClock } from "./testing/manual-clock.js";
import { createMemoryFileSystem } from "./testing/memory-file-system.js";
import type { MemoryFileSystem } from "./testing/memory-file-system.js";
import { createTestFrame, createTestFrames, TEST_GATEWAY_EPOCH } from "./testing/frames.js";
import { openWalWriter } from "./writer.js";

const DIRECTORY = "/wal";

type BuiltSegment = {
  readonly fileSystem: MemoryFileSystem;
  readonly manifest: WalSegmentManifest;
  readonly path: string;
};

async function buildSegment(recordCount = 5): Promise<BuiltSegment> {
  const fileSystem = createMemoryFileSystem();
  const writer = await openWalWriter({
    directoryPath: DIRECTORY,
    gatewayEpoch: TEST_GATEWAY_EPOCH,
    fileSystem,
    clock: createManualClock(),
  });
  for (const frame of createTestFrames(recordCount)) {
    writer.enqueue(frame);
  }
  const manifest = await writer.close();
  if (manifest === null) {
    throw new Error("expected a manifest");
  }
  return {
    fileSystem,
    manifest,
    path: `${DIRECTORY}/${segmentFileName(manifest.segmentId)}`,
  };
}

function bytesOf(fileSystem: MemoryFileSystem, path: string): Buffer {
  const bytes = fileSystem.peek(path);
  if (bytes === undefined) {
    throw new Error(`${path} does not exist`);
  }
  return bytes;
}

describe("sequential reading", () => {
  it("yields every record in order with its byte offset", async () => {
    const { fileSystem, path } = await buildSegment(4);
    const entries: { index: number; byteOffset: number; ingestSeq: string }[] = [];
    const iterator = iterateSegmentRecords(fileSystem, path);
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) {
        expect(step.value.recordCount).toBe(4);
        break;
      }
      entries.push({
        index: step.value.index,
        byteOffset: step.value.byteOffset,
        ingestSeq: step.value.record.ingestSeq,
      });
    }
    expect(entries.map((entry) => entry.ingestSeq)).toEqual(["1", "2", "3", "4"]);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    const file = bytesOf(fileSystem, path);
    for (const entry of entries) {
      const line = file.subarray(entry.byteOffset, file.indexOf(0x0a, entry.byteOffset) + 1);
      expect(line.toString("utf8").includes(`"ingestSeq":"${entry.ingestSeq}"`)).toBe(true);
    }
  });

  it("computes the checksum over the header plus every frame line, excluding the footer", async () => {
    const { fileSystem, path, manifest } = await buildSegment(3);
    const file = bytesOf(fileSystem, path);
    const prefix = file.subarray(0, manifest.checksummedByteLength);
    expect(createHash("sha256").update(prefix).digest("hex")).toBe(manifest.segmentSha256);
    expect(manifest.checksummedByteLength).toBeLessThan(manifest.byteSize);

    const scan = await scanSegment(fileSystem, path);
    expect(scan.computedSha256).toBe(manifest.segmentSha256);
    expect(scan.checksummedByteLength).toBe(manifest.checksummedByteLength);
    expect(scan.byteSize).toBe(manifest.byteSize);
    expect(scan.issues).toEqual([]);
  });

  it("produces identical results for every read chunk size", async () => {
    const { fileSystem, path } = await buildSegment(6);
    const reference = await scanSegment(fileSystem, path);
    for (const chunkBytes of [1, 2, 7, 13, 64, 4096]) {
      const scan = await scanSegment(fileSystem, path, { chunkBytes });
      expect(scan.computedSha256).toBe(reference.computedSha256);
      expect(scan.recordCount).toBe(reference.recordCount);
      expect(scan.checksummedByteLength).toBe(reference.checksummedByteLength);
      expect(scan.issues).toEqual([]);
    }
  });

  it("reads records back verbatim", async () => {
    const { fileSystem, path } = await buildSegment(3);
    const { records } = await readSegmentRecords(fileSystem, path);
    expect(records.map((record) => record.ingestSeq)).toEqual(["1", "2", "3"]);
    expect(records[0]?.payloadUtf8).toBe('{"event_type":"book","asset_id":"1"}');
  });
});

describe("integrity detection", () => {
  it("detects a byte flip inside a frame payload as a checksum mismatch", async () => {
    const { fileSystem, path, manifest } = await buildSegment(4);
    const file = bytesOf(fileSystem, path);
    const target = file.indexOf("asset_id");
    expect(target).toBeGreaterThan(0);
    const corrupted = Buffer.from(file);
    corrupted[target] = 0x41;
    fileSystem.poke(path, corrupted);

    const scan = await scanSegment(fileSystem, path, { onIssue: "collect" });
    expect(scan.issues.map((issue) => issue.code)).toContain("CHECKSUM_MISMATCH");
    expect(scan.computedSha256).not.toBe(manifest.segmentSha256);

    const report = await validateSegment(fileSystem, DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("CHECKSUM_MISMATCH");
  });

  it("detects a structurally broken record", async () => {
    const { fileSystem, path, manifest } = await buildSegment(4);
    const file = bytesOf(fileSystem, path);
    const lines = file.toString("utf8").split("\n");
    lines[2] = '{"gatewayEpoch":';
    fileSystem.poke(path, Buffer.from(lines.join("\n"), "utf8"));

    await expect(readSegmentRecords(fileSystem, path)).rejects.toBeInstanceOf(
      WalSegmentIntegrityError,
    );
    const report = await validateSegment(fileSystem, DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("RECORD_INVALID");
    expect(report.issues[0]?.lineIndex).toBe(2);
  });

  it("detects a record count that disagrees with the manifest", async () => {
    const { fileSystem, manifest } = await buildSegment(4);
    const manifestPath = `${DIRECTORY}/${manifestFileName(manifest.segmentId)}`;
    const doctored = { ...manifest, recordCount: 99 };
    fileSystem.poke(manifestPath, Buffer.from(`${JSON.stringify(doctored, null, 2)}\n`, "utf8"));
    const report = await validateSegment(fileSystem, DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("RECORD_COUNT_MISMATCH");
  });

  it("detects a checksum that disagrees with the manifest", async () => {
    const { fileSystem, manifest } = await buildSegment(4);
    const manifestPath = `${DIRECTORY}/${manifestFileName(manifest.segmentId)}`;
    const doctored = { ...manifest, segmentSha256: "b".repeat(64) };
    fileSystem.poke(manifestPath, Buffer.from(`${JSON.stringify(doctored, null, 2)}\n`, "utf8"));
    const report = await validateSegment(fileSystem, DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["CHECKSUM_MISMATCH", "FOOTER_MANIFEST_DISAGREE"]),
    );
  });

  it("treats a segment with no manifest as unverified", async () => {
    const { fileSystem, manifest } = await buildSegment(2);
    fileSystem.files.delete(`${DIRECTORY}/${manifestFileName(manifest.segmentId)}`);
    const report = await validateSegment(fileSystem, DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("MANIFEST_MISSING");
    // The bytes themselves are still fine; only the verification is missing.
    expect(report.scan.issues).toEqual([]);
  });

  it("detects a missing header", async () => {
    const fileSystem = createMemoryFileSystem();
    const path = `${DIRECTORY}/headerless${".wal.jsonl"}`;
    fileSystem.poke(path, Buffer.from(encodeFrameLine(createTestFrame())));
    const scan = await scanSegment(fileSystem, path, { onIssue: "collect" });
    expect(scan.issues.map((issue) => issue.code)).toContain("HEADER_MISSING");
  });

  it("detects bytes after the footer", async () => {
    const { fileSystem, path, manifest } = await buildSegment(2);
    const file = bytesOf(fileSystem, path);
    fileSystem.poke(path, Buffer.concat([file, Buffer.from(encodeFrameLine(createTestFrame()))]));
    const scan = await scanSegment(fileSystem, path, { onIssue: "collect" });
    expect(scan.issues.map((issue) => issue.code)).toContain("RECORD_AFTER_FOOTER");
    const report = await validateSegment(fileSystem, DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(false);
  });

  it("detects a segment id that does not match the file name", async () => {
    const { fileSystem, path } = await buildSegment(2);
    const scan = await scanSegment(fileSystem, path, {
      onIssue: "collect",
      expectedSegmentId: "some-other-segment",
    });
    expect(scan.issues.map((issue) => issue.code)).toContain("SEGMENT_ID_MISMATCH");
  });

  it("throws by default and collects on request", async () => {
    const { fileSystem, path } = await buildSegment(2);
    const file = bytesOf(fileSystem, path);
    const lines = file.toString("utf8").split("\n");
    lines[1] = "{oops";
    fileSystem.poke(path, Buffer.from(lines.join("\n"), "utf8"));
    await expect(scanSegment(fileSystem, path)).rejects.toBeInstanceOf(WalSegmentIntegrityError);
    const collected = await scanSegment(fileSystem, path, { onIssue: "collect" });
    expect(collected.issues).toHaveLength(1);
  });
});

describe("incomplete final record exposure", () => {
  it("reports the partial tail as state rather than corruption", async () => {
    const { fileSystem, path } = await buildSegment(3);
    const file = bytesOf(fileSystem, path);
    // Cut the file in the middle of what is now its final line.
    const truncated = file.subarray(0, file.length - 30);
    fileSystem.poke(path, truncated);

    const scan = await scanSegment(fileSystem, path, { onIssue: "collect" });
    expect(scan.incompleteFinalRecord).not.toBeNull();
    expect(scan.incompleteFinalRecord?.byteOffset).toBeLessThan(truncated.length);
    expect(scan.issues.map((issue) => issue.code)).toEqual(["INCOMPLETE_FINAL_RECORD"]);

    const { records } = await readSegmentRecords(fileSystem, path);
    expect(records).toHaveLength(3);
    await expect(
      readSegmentRecords(fileSystem, path, { allowIncompleteFinalRecord: false }),
    ).rejects.toBeInstanceOf(WalSegmentIntegrityError);
  });

  it("reports an empty file without inventing a defect", async () => {
    const fileSystem = createMemoryFileSystem();
    const path = `${DIRECTORY}/empty.wal.jsonl`;
    fileSystem.poke(path, Buffer.alloc(0));
    const scan = await scanSegment(fileSystem, path, { onIssue: "collect" });
    expect(scan.issues).toEqual([]);
    expect(scan.recordCount).toBe(0);
    expect(scan.header).toBeNull();
  });
});

describe("directory validation", () => {
  it("validates every segment and ignores non-segment files", async () => {
    const { fileSystem } = await buildSegment(3);
    fileSystem.poke(`${DIRECTORY}/notes.txt`, Buffer.from("ignore me", "utf8"));
    const reports = await validateWalDirectory(fileSystem, DIRECTORY);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.valid).toBe(true);
  });
});
