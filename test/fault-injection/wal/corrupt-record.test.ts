/**
 * Handoff §16.6: "Corrupt the final WAL record" — the corruption half.
 *
 * ADR-004 §3 draws a line that this suite exists to hold: an **incomplete**
 * final record is a recovery case, and a **corrupt** record — final or not — is
 * a data-quality incident. Recovery must not quietly delete a corrupt record to
 * make the file parse again, and it must not stop the recorder either.
 */

import { describe, expect, it } from "vitest";

import {
  readSegmentRecords,
  recoverSegment,
  scanSegment,
  validateSegment,
  WalSegmentIntegrityError,
} from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, recordedIngestSeqs, WAL_DIRECTORY } from "./support/harness.js";

type Corrupted = {
  readonly harness: ReturnType<typeof createFaultHarness>;
  readonly segmentId: string;
  readonly path: string;
  readonly before: Buffer;
};

/**
 * Write an unfinalized segment, then corrupt one complete, newline-terminated
 * line in place. The framing stays valid; the content does not.
 */
async function corruptLineOf(recordCount: number, lineIndex: number): Promise<Corrupted> {
  const harness = createFaultHarness();
  const writer = await harness.open();
  for (const frame of createTestFrames(recordCount)) {
    writer.enqueue(frame);
  }
  await writer.flush();
  const segmentId = writer.activeSegmentId ?? "";
  const path = `${WAL_DIRECTORY}/${segmentId}.wal.jsonl`;
  const original = harness.base.peek(path);
  if (original === undefined) {
    throw new Error("segment was not written");
  }
  const lines = original.toString("utf8").split("\n");
  const target = lines[lineIndex];
  if (target === undefined || target.length === 0) {
    throw new Error(`line ${lineIndex} does not exist`);
  }
  lines[lineIndex] = `${target.slice(0, target.length - 12)}CORRUPTED`;
  const corrupted = Buffer.from(lines.join("\n"), "utf8");
  harness.base.poke(path, corrupted);
  return { harness, segmentId, path, before: corrupted };
}

describe("a corrupt final record", () => {
  it("is not truncated, and the segment is left unmanifested", async () => {
    const { harness, segmentId, path, before } = await corruptLineOf(4, 4);
    const report = await recoverSegment(harness.fileSystem, WAL_DIRECTORY, segmentId, {
      clock: harness.clock,
    });

    expect(report.outcome).toBe("integrity-error");
    expect(report.truncatedBytes).toBe(0);
    expect(report.manifest).toBeNull();
    expect(report.issues.map((issue) => issue.code)).toContain("RECORD_INVALID");
    expect(harness.base.peek(path)?.equals(before)).toBe(true);

    // No manifest means the segment is invisible to compaction (ADR-004 §5).
    const validation = await validateSegment(harness.fileSystem, WAL_DIRECTORY, segmentId);
    expect(validation.valid).toBe(false);
    expect(validation.manifest).toBeNull();
  });

  it("does not stop the recorder", async () => {
    const { harness } = await corruptLineOf(4, 4);
    const writer = await harness.open();
    expect(writer.recovery.hasIntegrityFailures).toBe(true);
    expect(writer.recovery.integrityFailureCount).toBe(1);

    for (const frame of createTestFrames(2, {}, 100)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }
    const manifest = await writer.close();
    expect(manifest?.recordCount).toBe(2);
    // Only the healthy segment is readable end to end; the corrupt one is
    // excluded rather than silently repaired.
    expect(await recordedIngestSeqs(harness.fileSystem, { skipInvalid: true })).toEqual([
      "100",
      "101",
    ]);
  });
});

describe("a corrupt non-final record", () => {
  it("is reported at its line index and never repaired", async () => {
    const { harness, segmentId, path, before } = await corruptLineOf(5, 2);
    const scan = await scanSegment(harness.fileSystem, path, { onIssue: "collect" });
    expect(scan.issues.map((issue) => issue.code)).toContain("RECORD_INVALID");
    expect(scan.issues[0]?.lineIndex).toBe(2);
    expect(scan.recordCount).toBe(1);

    const report = await recoverSegment(harness.fileSystem, WAL_DIRECTORY, segmentId, {
      clock: harness.clock,
    });
    expect(report.outcome).toBe("integrity-error");
    expect(harness.base.peek(path)?.equals(before)).toBe(true);
    await expect(readSegmentRecords(harness.fileSystem, path)).rejects.toBeInstanceOf(
      WalSegmentIntegrityError,
    );
  });

  it("is still detected after the segment was closed cleanly", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open();
    for (const frame of createTestFrames(4)) {
      writer.enqueue(frame);
    }
    const manifest = await writer.close();
    const path = `${WAL_DIRECTORY}/${manifest?.segmentFileName ?? ""}`;
    const original = harness.base.peek(path);
    if (original === undefined) {
      throw new Error("segment was not written");
    }
    // Flip one byte inside a record. The line still parses, so only the
    // segment checksum can catch it.
    const flipped = Buffer.from(original);
    const target = flipped.indexOf("conn-1") + 5;
    flipped[target] = 0x39;
    harness.base.poke(path, flipped);

    const validation = await validateSegment(
      harness.fileSystem,
      WAL_DIRECTORY,
      manifest?.segmentId ?? "",
    );
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["CHECKSUM_MISMATCH"]),
    );
  });
});

describe("a truncated header", () => {
  it("leaves an empty segment rather than an unreadable one", async () => {
    const harness = createFaultHarness({
      onAppend: (call, _path, bytes) =>
        call === 1
          ? { writeBytes: Math.floor(bytes.length / 3), error: new Error("SIGKILL in header") }
          : undefined,
    });
    const writer = await harness.open();
    writer.enqueue(createTestFrames(1)[0] ?? (() => {
      throw new Error("missing frame");
    })());
    await expect(writer.drain()).rejects.toThrow();

    const reopened = await harness.open();
    expect(reopened.recovery.segments[0]?.outcome).toBe("empty");
    expect(reopened.recovery.hasIntegrityFailures).toBe(false);
    expect(reopened.recovery.segments[0]?.manifest).toBeNull();
    await reopened.close();
  });
});
