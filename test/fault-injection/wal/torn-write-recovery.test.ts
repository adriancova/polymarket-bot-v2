/**
 * Handoff §16.6: "Corrupt the final WAL record" — the crash half.
 *
 * A process killed in the middle of an append leaves a prefix of the bytes it
 * was writing. ADR-004 §3 allows recovery to truncate exactly that, and nothing
 * else. These tests inject the torn write rather than describing it.
 */

import { describe, expect, it } from "vitest";

import {
  validateSegment,
  validateWalDirectory,
  WalWriteFaultError,
} from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, recordedIngestSeqs, WAL_DIRECTORY } from "./support/harness.js";

/** Tear the second append (the first frame batch; the first append is the header). */
function tearTheFrameBatch(): ReturnType<typeof createFaultHarness> {
  return createFaultHarness({
    onAppend: (call, _path, bytes) =>
      call === 2
        ? { writeBytes: Math.floor(bytes.length / 2), error: new Error("SIGKILL mid-append") }
        : undefined,
  });
}

describe("a process killed mid-append", () => {
  it("faults the writer, keeps every unwritten frame, and never reports a drop", async () => {
    const harness = tearTheFrameBatch();
    const writer = await harness.open();
    for (const frame of createTestFrames(5)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    expect(writer.state).toBe("faulted");

    const metrics = writer.metrics();
    expect(metrics.writeFaults).toBe(1);
    expect(metrics.pendingFrameCount).toBe(5);
    expect(metrics.queue.messagesDropped).toBe(0);

    // A faulted writer refuses new frames instead of pretending to accept them.
    const refused = writer.enqueue(createTestFrames(1, {}, 6)[0]!);
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) {
      expect(refused.reason).toBe("writer-faulted");
    }
  });

  it("closes by truncating only the partial record and accounting for every frame", async () => {
    const harness = tearTheFrameBatch();
    const writer = await harness.open();
    for (const frame of createTestFrames(5)) {
      writer.enqueue(frame);
    }
    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);

    const manifest = await writer.close();
    expect(manifest).not.toBeNull();
    expect(manifest?.closeReason).toBe("write-fault");
    expect(manifest?.truncatedTailBytes).toBeGreaterThan(0);
    expect(manifest?.footerPresent).toBe(false);

    const persisted = await recordedIngestSeqs(harness.fileSystem);
    const pending = writer.pendingFrames().map((frame) => frame.ingestSeq);

    expect(persisted.length).toBe(manifest?.recordCount);
    expect(persisted.length).toBeGreaterThan(0);
    expect(pending.length).toBeGreaterThan(0);
    // Nothing lost, nothing duplicated: the persisted prefix and the frames the
    // caller still holds partition the five frames exactly.
    expect([...persisted, ...pending]).toEqual(["1", "2", "3", "4", "5"]);

    const validation = await validateSegment(
      harness.fileSystem,
      WAL_DIRECTORY,
      manifest?.segmentId ?? "",
    );
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it("lets the caller re-enqueue the pending frames against a fresh writer", async () => {
    const harness = tearTheFrameBatch();
    const first = await harness.open();
    for (const frame of createTestFrames(5)) {
      first.enqueue(frame);
    }
    await expect(first.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    await first.close();
    const pending = first.pendingFrames();

    const second = await harness.open();
    for (const frame of pending) {
      expect(second.enqueue(frame).accepted).toBe(true);
    }
    await second.close();

    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(["1", "2", "3", "4", "5"]);
    const reports = await validateWalDirectory(harness.fileSystem, WAL_DIRECTORY);
    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.valid)).toBe(true);
  });

  it("recovers on the next open when the process never got to close", async () => {
    const harness = tearTheFrameBatch();
    const first = await harness.open();
    for (const frame of createTestFrames(5)) {
      first.enqueue(frame);
    }
    await expect(first.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    // The process dies here: no close(), no footer, no manifest.

    const bytesBefore = harness.base.snapshot();
    const second = await harness.open();
    expect(second.recovery.truncatedSegmentCount).toBe(1);
    expect(second.recovery.truncatedBytes).toBeGreaterThan(0);
    expect(second.recovery.hasIntegrityFailures).toBe(false);
    expect(harness.base.snapshot()).not.toEqual(bytesBefore);

    const reports = await validateWalDirectory(harness.fileSystem, WAL_DIRECTORY);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.valid).toBe(true);
    expect(reports[0]?.scan.incompleteFinalRecord).toBeNull();
    await second.close();
  });
});

describe("recovery idempotence", () => {
  it("changes nothing on a second and third pass", async () => {
    const harness = tearTheFrameBatch();
    const first = await harness.open();
    for (const frame of createTestFrames(5)) {
      first.enqueue(frame);
    }
    await expect(first.drain()).rejects.toBeInstanceOf(WalWriteFaultError);

    const afterCrash = await harness.open();
    const recoveredSnapshot = harness.base.snapshot();
    const recoveredSeqs = await recordedIngestSeqs(harness.fileSystem);
    await afterCrash.close();

    harness.clock.advance(3_600_000);
    const secondPass = await harness.open();
    expect(secondPass.recovery.truncatedSegmentCount).toBe(0);
    expect(secondPass.recovery.truncatedBytes).toBe(0);
    expect(secondPass.recovery.segments.every((s) => s.outcome === "already-finalized")).toBe(true);
    await secondPass.close();

    const thirdPass = await harness.open();
    expect(thirdPass.recovery.truncatedBytes).toBe(0);
    await thirdPass.close();

    expect(harness.base.snapshot()).toEqual(recoveredSnapshot);
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(recoveredSeqs);
  });

  it("truncates nothing when the file already ends on a record boundary", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open();
    for (const frame of createTestFrames(3)) {
      writer.enqueue(frame);
    }
    await writer.flush();
    // Crash with every byte written and no partial tail.
    const snapshot = harness.base.snapshot();

    const reopened = await harness.open();
    expect(reopened.recovery.truncatedBytes).toBe(0);
    expect(reopened.recovery.segments[0]?.outcome).toBe("recovered-clean");
    expect(reopened.recovery.segments[0]?.recordCount).toBe(3);
    // The segment bytes are untouched; only a sidecar manifest was added.
    const after = harness.base.snapshot();
    for (const [path, content] of Object.entries(snapshot)) {
      expect(after[path]).toBe(content);
    }
    await reopened.close();
  });
});
