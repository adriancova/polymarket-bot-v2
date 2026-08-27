/**
 * Accountability is not durability: the at-least-once half of the invariant.
 *
 * Rounds 1 and 2 built the durability side — a manifest never names a record no
 * `fsync` proved, and the watermark freezes on any failure on a segment's handle
 * (`wal-format.md` §9.1). Round 3 found the *other* half incomplete. The writer
 * discarded a frame the moment an `fsync` proved it durable, on the assumption
 * that a durable frame would end up in a manifest. Under the watermark rule it
 * often does not: a later failure freezes the watermark short of the file, no
 * manifest is written for the segment **at all**, and those earlier-fsynced
 * frames were then in neither the manifest nor `pendingFrames()`.
 *
 * `wal-format.md` §10.1 case 4 is explicit about what must happen instead:
 *
 * > the segment is left **unmanifested** … and *every* frame it might hold stays
 * > with the caller.
 *
 * So the two accountings are separated (`wal-format.md` §10.2):
 *
 * - **durable-for-manifest** — the watermark. It governs what a manifest *may*
 *   name, and a failure freezes it.
 * - **retained-for-accountability** — every accepted record appended to the
 *   active segment that no *written* manifest names yet. It is released only
 *   when a manifest naming it lands on disk, and an `fsync` releases nothing.
 *
 * The three scenarios below are the round-3 review's probes, reproduced before
 * being fixed. Each has a frame that a successful `fsync` had already covered
 * and that the fault then left unaccounted for.
 */

import { describe, expect, it } from "vitest";

import {
  listSegmentManifests,
  readSegmentRecords,
  segmentFileName,
  validateSegment,
  WalWriteFaultError,
} from "@polymarket-bot/storage-wal";
import type { RawFrameRecord, WalFileSystem, WalWriter } from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, WAL_DIRECTORY } from "./support/harness.js";

/** Ingest sequences a compactor would consume: only manifested segments. */
async function manifestedIngestSeqs(fileSystem: WalFileSystem): Promise<readonly string[]> {
  const manifests = await listSegmentManifests(fileSystem, WAL_DIRECTORY);
  const seqs: string[] = [];
  for (const manifest of manifests) {
    const report = await validateSegment(fileSystem, WAL_DIRECTORY, manifest.segmentId);
    expect(report.valid, `manifested segment ${manifest.segmentId} did not validate`).toBe(true);
    const { records } = await readSegmentRecords(
      fileSystem,
      `${WAL_DIRECTORY}/${segmentFileName(manifest.segmentId)}`,
    );
    seqs.push(...records.map((record) => record.ingestSeq));
  }
  return seqs;
}

/** The invariant: manifested + pending is exactly the accepted frames, in order. */
async function expectExactPartition(
  writer: WalWriter,
  fileSystem: WalFileSystem,
  accepted: readonly RawFrameRecord[],
): Promise<{ readonly manifested: readonly string[]; readonly pending: readonly string[] }> {
  const manifested = await manifestedIngestSeqs(fileSystem);
  const pending = writer.pendingFrames().map((frame) => frame.ingestSeq);
  expect([...manifested, ...pending]).toEqual(accepted.map((frame) => frame.ingestSeq));
  expect(writer.metrics().queue.messagesDropped).toBe(0);
  return { manifested, pending };
}

/** Thresholds high enough that only an explicit `flush()` ever fsyncs. */
const NO_PERIODIC_FSYNC = {
  fsyncIntervalMs: 1_000_000,
  fsyncByteThreshold: 10_000_000,
} as const;

function frameAt(frames: readonly RawFrameRecord[], index: number): RawFrameRecord {
  const frame = frames[index];
  if (frame === undefined) {
    throw new Error(`expected a generated frame at ${index}`);
  }
  return frame;
}

describe("a segment left unmanifested returns every record it might hold", () => {
  /**
   * The shape all three probes share: frame 1 appended **and fsynced**, frame 2
   * appended and unproven, frame 3 still in the queue. Only frame 1 is
   * interesting — it is the one an `fsync` had already covered, and the one the
   * pre-round-3 writer forgot.
   */
  async function flushedThenUnprovenThenQueued(
    harness: ReturnType<typeof createFaultHarness>,
  ): Promise<{ readonly writer: WalWriter; readonly accepted: readonly RawFrameRecord[] }> {
    const writer = await harness.open({ maxSegmentAgeMs: 1_000, ...NO_PERIODIC_FSYNC });
    const frames = createTestFrames(3);

    expect(writer.enqueue(frameAt(frames, 0)).accepted).toBe(true);
    await writer.flush(); // frame 1 is now covered by a successful fsync
    expect(writer.metrics().framesDurable).toBe(1);
    expect(writer.metrics().unprovenFrameCount).toBe(0);

    expect(writer.enqueue(frameAt(frames, 1)).accepted).toBe(true);
    await writer.drain(); // frame 2 is on disk, unproven
    expect(writer.metrics().unprovenFrameCount).toBe(1);

    expect(writer.enqueue(frameAt(frames, 2)).accepted).toBe(true); // frame 3 stays queued
    harness.clock.advance(1_000); // old enough for tick() to rotate it
    return { writer, accepted: frames };
  }

  it("returns the fsynced frame too when a tick() rotation cannot write its footer", async () => {
    // Review round 3, probe (a). Appends: 1 = header, 2 = frame 1, 3 = frame 2,
    // 4 = the time-rotation footer, which fails. The fault-close fsync then
    // *succeeds* — and proves nothing, because the failed footer append already
    // froze the watermark (§9.1). No manifest is written, so all three frames
    // have to come back.
    //
    // Before the fix: `pendingFrames()` was `["2","3"]`. Frame 1 had been
    // dropped from `#unproven` by its successful fsync and was named by no
    // manifest — neither manifested nor pending, which §10.1 forbids.
    const harness = createFaultHarness({
      onAppend: (call) =>
        call === 4 ? { writeBytes: 0, error: new Error("EIO: footer write failed") } : undefined,
    });
    const { writer, accepted } = await flushedThenUnprovenThenQueued(harness);

    await expect(writer.tick()).rejects.toBeInstanceOf(WalWriteFaultError);
    expect(writer.state).toBe("faulted");
    // Immediately at the fault, not only after close(): the queue is empty and
    // every accepted frame is the caller's again.
    expect(writer.metrics().queue.currentDepth).toBe(0);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2", "3"]);

    expect(await writer.close()).toBeNull();
    expect(writer.metrics().unmanifestedFaultedSegments).toBe(1);
    expect(await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY)).toEqual([]);
    const { manifested, pending } = await expectExactPartition(
      writer,
      harness.fileSystem,
      accepted,
    );
    expect(manifested).toEqual([]);
    expect(pending).toEqual(["1", "2", "3"]);
  });

  it("returns the fsynced frame too when the rotation's own fsync fails", async () => {
    // Review round 3, probe (b). Syncs: 1 = header, 2 = the explicit flush,
    // 3 = the rotation footer's fsync, which fails. The footer bytes did reach
    // the file, but nothing proves them, so the segment gets no manifest.
    const harness = createFaultHarness({
      onSync: (call) => (call === 3 ? new Error("EIO: fsync failed") : undefined),
    });
    const { writer, accepted } = await flushedThenUnprovenThenQueued(harness);

    await expect(writer.tick()).rejects.toBeInstanceOf(WalWriteFaultError);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2", "3"]);

    expect(await writer.close()).toBeNull();
    expect(await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY)).toEqual([]);
    const { manifested, pending } = await expectExactPartition(
      writer,
      harness.fileSystem,
      accepted,
    );
    expect(manifested).toEqual([]);
    expect(pending).toEqual(["1", "2", "3"]);

    // And the at-least-once outcome is honest under a power loss: the bytes on
    // disk are unverified, and every frame is still recoverable from the caller.
    harness.fileSystem.simulatePowerLoss();
    expect(await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY)).toEqual([]);
  });

  it("returns every frame when a mid-batch append tears after an earlier flush", async () => {
    // Review round 3, probe (c). Frame 1 is flushed; frames 2-5 are drained in
    // one batch whose append writes frame 2 and part of frame 3 before failing.
    // Frames 2-5 come back as the in-flight batch, frame 1 only because the
    // segment it is in will never be manifested.
    const frames = createTestFrames(5);
    const harness = createFaultHarness({
      onAppend: (call, _path, bytes) =>
        call === 3
          ? {
              // Four equal-width frames: three eighths lands inside the third.
              writeBytes: Math.floor((bytes.length * 3) / 8),
              error: new Error("SIGKILL mid-append"),
            }
          : undefined,
    });
    const writer = await harness.open(NO_PERIODIC_FSYNC);

    expect(writer.enqueue(frameAt(frames, 0)).accepted).toBe(true);
    await writer.flush();
    expect(writer.metrics().framesDurable).toBe(1);

    for (let index = 1; index < frames.length; index += 1) {
      expect(writer.enqueue(frameAt(frames, index)).accepted).toBe(true);
    }
    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);

    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);

    expect(await writer.close()).toBeNull();
    const { manifested, pending } = await expectExactPartition(
      writer,
      harness.fileSystem,
      frames,
    );
    expect(manifested).toEqual([]);
    expect(pending).toEqual(["1", "2", "3", "4", "5"]);
    expect(writer.metrics().unmanifestedFaultedSegments).toBe(1);
  });
});

describe("a manifest that does land takes its records and no others", () => {
  it("does not over-return: a clean close manifests and empties the pending list", async () => {
    // The other direction of the same rule. Retaining records for
    // accountability must not turn into handing back records a manifest already
    // names, or "never by both" breaks and every fault boundary duplicates.
    const harness = createFaultHarness();
    const writer = await harness.open(NO_PERIODIC_FSYNC);
    const frames = createTestFrames(4);
    for (const frame of frames) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }
    await writer.flush(); // an fsync mid-life must not release accountability…

    const manifest = await writer.close(); // …but the manifest write must.
    expect(manifest?.recordCount).toBe(4);
    const { manifested, pending } = await expectExactPartition(writer, harness.fileSystem, frames);
    expect(manifested).toEqual(["1", "2", "3", "4"]);
    expect(pending).toEqual([]);
  });

  it("keeps a manifested earlier segment out of the pending list when a later one faults", async () => {
    // Segment 0 rotates cleanly and gets its manifest, so its records are gone
    // from accountability for good. Segment 1 then faults, and only *its*
    // records come back. Retention is per active segment, not cumulative.
    const harness = createFaultHarness({
      // Appends: 1 = header 0, 2 = frame 1, 3 = footer 0, 4 = header 1,
      // 5 = frame 2, 6 = frame 3. Tear the last one.
      onAppend: (call, _path, bytes) =>
        call === 6
          ? { writeBytes: Math.floor(bytes.length / 2), error: new Error("EIO: torn append") }
          : undefined,
    });
    const writer = await harness.open({ maxSegmentBytes: 700, ...NO_PERIODIC_FSYNC });
    const frames = createTestFrames(3);
    const accepted: RawFrameRecord[] = [];

    for (const frame of frames) {
      expect(writer.enqueue(frame).accepted).toBe(true);
      accepted.push(frame);
      if (frame.ingestSeq !== "3") {
        await writer.drain();
      }
    }
    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);

    await writer.close().catch(() => undefined);
    const { manifested, pending } = await expectExactPartition(
      writer,
      harness.fileSystem,
      accepted,
    );
    // Segment 0's record is manifested and stays that way; segment 1's records
    // are the caller's.
    expect(manifested).toEqual(["1"]);
    expect(pending).toEqual(["2", "3"]);
  });
});
