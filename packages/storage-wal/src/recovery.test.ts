import { describe, expect, it } from "vitest";

import { manifestFileName, segmentFileName } from "./manifest.js";
import { readSegmentRecords, validateSegment } from "./reader.js";
import { recoverSegment, recoverWalDirectory } from "./recovery.js";
import { buildSegmentHeader, encodeFrameLine, encodeHeaderLine } from "./segment-format.js";
import { createManualClock } from "./testing/manual-clock.js";
import type { ManualClock } from "./testing/manual-clock.js";
import { createMemoryFileSystem } from "./testing/memory-file-system.js";
import type { MemoryFileSystem } from "./testing/memory-file-system.js";
import { createTestFrames, TEST_GATEWAY_EPOCH } from "./testing/frames.js";
import { openWalWriter } from "./writer.js";

const DIRECTORY = "/wal";

type Scene = {
  readonly fileSystem: MemoryFileSystem;
  readonly clock: ManualClock;
  readonly segmentId: string;
  readonly path: string;
};

/**
 * Write a segment and abandon it without closing — the state a process leaves
 * behind when it is killed.
 */
async function abandonedSegment(recordCount = 4): Promise<Scene> {
  const fileSystem = createMemoryFileSystem();
  const clock = createManualClock();
  const writer = await openWalWriter({
    directoryPath: DIRECTORY,
    gatewayEpoch: TEST_GATEWAY_EPOCH,
    fileSystem,
    clock,
  });
  for (const frame of createTestFrames(recordCount)) {
    writer.enqueue(frame);
  }
  await writer.drain();
  const segmentId = writer.activeSegmentId ?? "";
  return { fileSystem, clock, segmentId, path: `${DIRECTORY}/${segmentFileName(segmentId)}` };
}

function fileBytes(fileSystem: MemoryFileSystem, path: string): Buffer {
  const bytes = fileSystem.peek(path);
  if (bytes === undefined) {
    throw new Error(`${path} does not exist`);
  }
  return bytes;
}

/** Write a well-formed, unfinalized segment directly, bypassing the writer. */
function writeRawSegment(
  fileSystem: MemoryFileSystem,
  segmentId: string,
  segmentIndex: number,
  recordCount: number,
): void {
  const header = buildSegmentHeader({
    segmentId,
    gatewayEpoch: TEST_GATEWAY_EPOCH,
    segmentIndex,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const lines = [
    Buffer.from(encodeHeaderLine(header)),
    ...createTestFrames(recordCount).map((frame) => Buffer.from(encodeFrameLine(frame))),
  ];
  fileSystem.poke(`${DIRECTORY}/${segmentFileName(segmentId)}`, Buffer.concat(lines));
}

function corruptLine(fileSystem: MemoryFileSystem, path: string, lineIndex: number): void {
  const lines = fileBytes(fileSystem, path).toString("utf8").split("\n");
  lines[lineIndex] = '{"gatewayEpoch": broken';
  fileSystem.poke(path, Buffer.from(lines.join("\n"), "utf8"));
}

describe("truncating an incomplete final record", () => {
  it("removes only the partial tail and keeps every complete record", async () => {
    const { fileSystem, clock, segmentId, path } = await abandonedSegment(4);
    const complete = fileBytes(fileSystem, path);
    const partialTailLength = 25;
    fileSystem.poke(
      path,
      Buffer.concat([complete, Buffer.from('{"gatewayEpoch":"0190a3', "utf8")]),
    );
    const withTail = fileBytes(fileSystem, path).length;

    const report = await recoverSegment(fileSystem, DIRECTORY, segmentId, { clock });
    expect(report.outcome).toBe("recovered-truncated");
    expect(report.truncatedBytes).toBe(withTail - complete.length);
    expect(report.truncatedBytes).toBeLessThan(partialTailLength);
    expect(report.recordCount).toBe(4);
    expect(fileBytes(fileSystem, path).equals(complete)).toBe(true);

    const { records } = await readSegmentRecords(fileSystem, path);
    expect(records.map((record) => record.ingestSeq)).toEqual(["1", "2", "3", "4"]);

    const validation = await validateSegment(fileSystem, DIRECTORY, segmentId);
    expect(validation.valid).toBe(true);
    expect(validation.manifest?.truncatedTailBytes).toBe(report.truncatedBytes);
    expect(validation.manifest?.closeReason).toBe("recovery");
    expect(validation.manifest?.footerPresent).toBe(false);
  });

  it("never truncates a valid final record", async () => {
    const { fileSystem, clock, segmentId, path } = await abandonedSegment(3);
    const before = fileBytes(fileSystem, path);
    const report = await recoverSegment(fileSystem, DIRECTORY, segmentId, { clock });
    expect(report.outcome).toBe("recovered-clean");
    expect(report.truncatedBytes).toBe(0);
    expect(report.recordCount).toBe(3);
    expect(fileBytes(fileSystem, path).equals(before)).toBe(true);
    expect(fileSystem.stats.truncations).toBe(0);
  });

  it("truncates a partial header to an empty file and writes no manifest", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const segmentId = "partial-header";
    const path = `${DIRECTORY}/${segmentFileName(segmentId)}`;
    fileSystem.poke(path, Buffer.from('{"record":"hea', "utf8"));
    const report = await recoverSegment(fileSystem, DIRECTORY, segmentId, { clock });
    expect(report.outcome).toBe("empty");
    expect(report.truncatedBytes).toBe(14);
    expect(report.manifest).toBeNull();
    expect(fileBytes(fileSystem, path).length).toBe(0);
    expect(fileSystem.peek(`${DIRECTORY}/${manifestFileName(segmentId)}`)).toBeUndefined();
  });
});

describe("corruption is not a recovery case", () => {
  it("reports a corrupt non-final record as an integrity error and changes nothing", async () => {
    const { fileSystem, clock, segmentId, path } = await abandonedSegment(5);
    corruptLine(fileSystem, path, 2);
    const before = fileBytes(fileSystem, path);

    const report = await recoverSegment(fileSystem, DIRECTORY, segmentId, { clock });
    expect(report.outcome).toBe("integrity-error");
    expect(report.manifest).toBeNull();
    expect(report.issues.map((issue) => issue.code)).toContain("RECORD_INVALID");
    expect(fileBytes(fileSystem, path).equals(before)).toBe(true);
    expect(fileSystem.stats.truncations).toBe(0);
    // No manifest means the segment is not offered to a compactor.
    expect(fileSystem.peek(`${DIRECTORY}/${manifestFileName(segmentId)}`)).toBeUndefined();
  });

  it("reports a corrupt but newline-terminated final record as an integrity error", async () => {
    const { fileSystem, clock, segmentId, path } = await abandonedSegment(4);
    // Line 4 is the last record and it still ends with a newline: it is
    // complete framing with corrupt content, which recovery may not truncate.
    corruptLine(fileSystem, path, 4);
    const before = fileBytes(fileSystem, path);

    const report = await recoverSegment(fileSystem, DIRECTORY, segmentId, { clock });
    expect(report.outcome).toBe("integrity-error");
    expect(fileBytes(fileSystem, path).equals(before)).toBe(true);
    expect(fileSystem.stats.truncations).toBe(0);
  });

  it("does not stop the recovery of other segments", async () => {
    const { fileSystem, clock, segmentId, path } = await abandonedSegment(3);
    corruptLine(fileSystem, path, 1);
    const goodSegmentId = "zz-good-segment";
    writeRawSegment(fileSystem, goodSegmentId, 1, 2);

    const report = await recoverWalDirectory(fileSystem, DIRECTORY, { clock });
    expect(report.hasIntegrityFailures).toBe(true);
    expect(report.integrityFailureCount).toBe(1);
    expect(report.segments).toHaveLength(2);
    const failed = report.segments.find((segment) => segment.segmentId === segmentId);
    const recovered = report.segments.find((segment) => segment.segmentId === goodSegmentId);
    expect(failed?.outcome).toBe("integrity-error");
    expect(recovered?.outcome).toBe("recovered-clean");
  });
});

describe("idempotence", () => {
  it("recovering twice changes nothing", async () => {
    const { fileSystem, clock, segmentId, path } = await abandonedSegment(4);
    fileSystem.poke(
      path,
      Buffer.concat([fileBytes(fileSystem, path), Buffer.from('{"gateway', "utf8")]),
    );

    const first = await recoverWalDirectory(fileSystem, DIRECTORY, { clock });
    const afterFirst = fileSystem.snapshot();
    expect(first.truncatedSegmentCount).toBe(1);

    clock.advance(120_000);
    const second = await recoverWalDirectory(fileSystem, DIRECTORY, { clock });
    expect(second.truncatedSegmentCount).toBe(0);
    expect(second.truncatedBytes).toBe(0);
    expect(second.segments[0]?.outcome).toBe("already-finalized");
    expect(fileSystem.snapshot()).toEqual(afterFirst);

    const third = await recoverWalDirectory(fileSystem, DIRECTORY, { clock });
    expect(fileSystem.snapshot()).toEqual(afterFirst);
    expect(third.segments[0]?.segmentSha256).toBe(first.segments[0]?.segmentSha256);
    expect(await validateSegment(fileSystem, DIRECTORY, segmentId)).toMatchObject({ valid: true });
  });

  it("does not rewrite a segment that already has a footer and a manifest", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const writer = await openWalWriter({
      directoryPath: DIRECTORY,
      gatewayEpoch: TEST_GATEWAY_EPOCH,
      fileSystem,
      clock,
    });
    for (const frame of createTestFrames(2)) {
      writer.enqueue(frame);
    }
    await writer.close();
    const before = fileSystem.snapshot();
    fileSystem.resetStats();

    const report = await recoverWalDirectory(fileSystem, DIRECTORY, { clock });
    expect(report.segments[0]?.outcome).toBe("already-finalized");
    expect(fileSystem.stats.wholeFileWrites).toBe(0);
    expect(fileSystem.stats.opensForRead).toBe(0);
    expect(fileSystem.snapshot()).toEqual(before);
  });
});

describe("crash between the footer and the manifest", () => {
  it("preserves the footer's close reason and timestamp", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const writer = await openWalWriter({
      directoryPath: DIRECTORY,
      gatewayEpoch: TEST_GATEWAY_EPOCH,
      fileSystem,
      clock,
    });
    for (const frame of createTestFrames(3)) {
      writer.enqueue(frame);
    }
    const original = await writer.close();
    const segmentId = original?.segmentId ?? "";
    fileSystem.files.delete(`${DIRECTORY}/${manifestFileName(segmentId)}`);

    clock.advance(500_000);
    const report = await recoverSegment(fileSystem, DIRECTORY, segmentId, { clock });
    expect(report.outcome).toBe("recovered-clean");
    expect(report.manifest?.footerPresent).toBe(true);
    expect(report.manifest?.closeReason).toBe("shutdown");
    expect(report.manifest?.closedAt).toBe(original?.closedAt);
    expect(report.manifest?.segmentSha256).toBe(original?.segmentSha256);
    expect(report.manifest?.recordCount).toBe(original?.recordCount);
    expect(await validateSegment(fileSystem, DIRECTORY, segmentId)).toMatchObject({ valid: true });
  });
});

describe("directory recovery", () => {
  it("reports totals and the next segment index", async () => {
    const { fileSystem, clock, path } = await abandonedSegment(3);
    fileSystem.poke(
      path,
      Buffer.concat([fileBytes(fileSystem, path), Buffer.from("{partial", "utf8")]),
    );
    const report = await recoverWalDirectory(fileSystem, DIRECTORY, { clock });
    expect(report.segments).toHaveLength(1);
    expect(report.truncatedSegmentCount).toBe(1);
    expect(report.truncatedBytes).toBe(8);
    expect(report.nextSegmentIndex).toBe(1);
    expect(report.totalSegmentBytes).toBe(fileBytes(fileSystem, path).length);
    expect(report.hasIntegrityFailures).toBe(false);
    expect(report.recoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("creates the directory when it does not exist", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const report = await recoverWalDirectory(fileSystem, "/fresh", { clock });
    expect(report.segments).toEqual([]);
    expect(report.nextSegmentIndex).toBe(0);
    expect(report.totalSegmentBytes).toBe(0);
  });

  it("lets a writer resume after a crash without touching the recovered segment", async () => {
    const { fileSystem, clock, path, segmentId } = await abandonedSegment(2);
    fileSystem.poke(
      path,
      Buffer.concat([fileBytes(fileSystem, path), Buffer.from('{"ing', "utf8")]),
    );

    const writer = await openWalWriter({
      directoryPath: DIRECTORY,
      gatewayEpoch: "0190a3e0-0000-7000-8000-0000000000ff",
      fileSystem,
      clock,
    });
    expect(writer.recovery.truncatedSegmentCount).toBe(1);
    const recoveredBytes = fileBytes(fileSystem, path);

    writer.enqueue(
      createTestFrames(1, { gatewayEpoch: "0190a3e0-0000-7000-8000-0000000000ff" })[0] ??
        (() => {
          throw new Error("missing frame");
        })(),
    );
    const manifest = await writer.close();
    expect(manifest?.segmentId).not.toBe(segmentId);
    expect(fileBytes(fileSystem, path).equals(recoveredBytes)).toBe(true);
    expect(await validateSegment(fileSystem, DIRECTORY, segmentId)).toMatchObject({ valid: true });
    expect(await validateSegment(fileSystem, DIRECTORY, manifest?.segmentId ?? "")).toMatchObject({
      valid: true,
    });
  });
});
