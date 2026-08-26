/**
 * Handoff §16.6: "Fill disk or exceed configured WAL capacity", and §4.2: a
 * storage-side problem must not silently become data loss.
 *
 * Two distinct failures live here. The **configured** capacity threshold is
 * orderly: the writer refuses new frames and everything already recorded stays
 * exactly where it is — ADR-004's intended failure direction is a full disk, not
 * an overwritten archive. A **real** `ENOSPC` is disorderly: the append tears,
 * the writer faults, and the recorded prefix must still be recoverable.
 */

import { describe, expect, it } from "vitest";

import {
  listSegmentManifests,
  validateWalDirectory,
  WalWriteFaultError,
} from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, recordedIngestSeqs, WAL_DIRECTORY } from "./support/harness.js";

describe("the configured capacity threshold", () => {
  it("refuses new frames and deletes nothing", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ maxTotalBytes: 1_500 });

    const accepted: string[] = [];
    const refused: string[] = [];
    for (const frame of createTestFrames(40)) {
      const result = writer.enqueue(frame);
      if (result.accepted) {
        accepted.push(frame.ingestSeq);
      } else {
        expect(result.reason).toBe("capacity-exceeded");
        expect(result.detail).toContain("capacity threshold");
        refused.push(frame.ingestSeq);
      }
      await writer.drain();
    }
    await writer.close();

    expect(accepted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    expect(accepted.length + refused.length).toBe(40);
    // Every accepted frame is on disk; no refusal cost a recorded frame.
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(accepted);
    expect(writer.metrics().queue.messagesDropped).toBe(0);
    expect(writer.metrics().capacityRefusals).toBe(refused.length);

    const reports = await validateWalDirectory(harness.fileSystem, WAL_DIRECTORY);
    expect(reports.every((report) => report.valid)).toBe(true);
  });

  it("reports remaining capacity so an operator sees it coming", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ maxTotalBytes: 100_000 });
    expect(writer.metrics().capacityBytes).toBe(100_000);
    // No segment is open yet, so no framing overhead is reserved.
    expect(writer.metrics().capacityRemainingBytes).toBe(100_000);
    expect(writer.metrics().capacityReservedBytes).toBe(0);

    for (const frame of createTestFrames(10)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    const metrics = writer.metrics();
    expect(metrics.totalSegmentBytes).toBeGreaterThan(0);
    // Headroom is for *frame bytes*: what is on disk, plus what is queued, plus
    // the footer the open segment still owes (`wal-format.md` §11.1).
    expect(metrics.capacityReservedBytes).toBeGreaterThan(0);
    expect(metrics.capacityRemainingBytes).toBe(
      100_000 -
        metrics.totalSegmentBytes -
        metrics.queue.currentByteDepth -
        (metrics.capacityReservedBytes ?? 0),
    );
    await writer.close();
  });

  it("never reports negative remaining capacity, however tight the threshold", async () => {
    for (const cap of [1, 200, 700, 1_100, 1_477, 5_000]) {
      const harness = createFaultHarness();
      const writer = await harness.open({ maxTotalBytes: cap });
      for (const frame of createTestFrames(30)) {
        writer.enqueue(frame);
        expect(writer.metrics().capacityRemainingBytes).toBeGreaterThanOrEqual(0);
        await writer.drain();
        expect(writer.metrics().capacityRemainingBytes).toBeGreaterThanOrEqual(0);
      }
      await writer.close();
      expect(writer.metrics().capacityRemainingBytes).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps total WAL bytes at or under the threshold, framing included", async () => {
    // The pre-fix projection charged only frame lines, so a threshold could be
    // overshot by a header plus a footer per segment. These thresholds bracket
    // the interesting cases: below one segment's overhead, exactly one closed
    // one-frame segment, and enough for several rotations.
    for (const cap of [700, 1_050, 1_100, 2_000, 4_000]) {
      const harness = createFaultHarness();
      const writer = await harness.open({ maxTotalBytes: cap, maxSegmentBytes: 900 });
      const accepted: string[] = [];
      for (const frame of createTestFrames(40)) {
        if (writer.enqueue(frame).accepted) {
          accepted.push(frame.ingestSeq);
        }
        await writer.drain();
      }
      await writer.close();

      let onDisk = 0;
      for (const [path, bytes] of harness.base.files) {
        if (path.endsWith(".wal.jsonl")) {
          onDisk += bytes.length;
        }
      }
      expect(onDisk, `threshold ${cap} was exceeded`).toBeLessThanOrEqual(cap);
      // Refusing is not the same as losing: everything admitted is on disk.
      expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(accepted);
      expect(writer.metrics().queue.messagesDropped).toBe(0);
    }
  });

  it("counts pre-existing segments toward the threshold after a restart", async () => {
    const harness = createFaultHarness();
    const first = await harness.open();
    for (const frame of createTestFrames(10)) {
      first.enqueue(frame);
    }
    await first.close();
    const used = harness.fileSystem.appendCalls() > 0 ? 1 : 0;
    expect(used).toBe(1);

    const second = await harness.open({ maxTotalBytes: 1 });
    expect(second.metrics().totalSegmentBytes).toBeGreaterThan(1);
    const refused = second.enqueue(createTestFrames(1, {}, 11)[0] ?? fail());
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) {
      expect(refused.reason).toBe("capacity-exceeded");
    }
    // The pre-existing segment is untouched.
    expect(await recordedIngestSeqs(harness.fileSystem)).toHaveLength(10);
    await second.close();
  });
});

describe("a genuinely full disk", () => {
  it("faults the writer and keeps the recorded prefix recoverable", async () => {
    const harness = createFaultHarness({ diskCapacityBytes: 1_400 });
    const writer = await harness.open({
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: 10_000_000,
    });
    for (const frame of createTestFrames(20)) {
      writer.enqueue(frame);
    }

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    expect(writer.state).toBe("faulted");
    expect(writer.metrics().queue.messagesDropped).toBe(0);
    expect(writer.pendingFrames().length).toBeGreaterThan(0);

    // Closing cannot write the sidecar manifest either — the disk really is
    // full — so close() fails and the writer stays faulted rather than
    // pretending the segment was finalized.
    await expect(writer.close()).rejects.toThrow(/ENOSPC/u);
    expect(writer.state).toBe("faulted");

    // The operator frees space. Closing again finalizes the verified prefix.
    harness.fileSystem.setDiskCapacityBytes(1_000_000);
    const manifest = await writer.close();
    expect(writer.state).toBe("closed");
    expect(manifest?.closeReason).toBe("write-fault");
    const persisted = await recordedIngestSeqs(harness.fileSystem);
    const pending = writer.pendingFrames().map((frame) => frame.ingestSeq);
    expect(persisted.length).toBe(manifest?.recordCount ?? 0);
    expect([...persisted, ...pending]).toEqual(
      createTestFrames(20).map((frame) => frame.ingestSeq),
    );

    const reports = await validateWalDirectory(harness.fileSystem, WAL_DIRECTORY);
    expect(reports.every((report) => report.valid)).toBe(true);
  });

  it("never overwrites an existing segment to make room", async () => {
    const harness = createFaultHarness();
    const first = await harness.open({ maxSegmentBytes: 1_000 });
    for (const frame of createTestFrames(6)) {
      first.enqueue(frame);
    }
    await first.drain();
    await first.close();
    const snapshotBefore = harness.base.snapshot();
    const manifestsBefore = await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY);

    // The disk is now nearly full: room for a header and a frame or two, and
    // nothing more.
    let used = 0;
    for (const bytes of harness.base.files.values()) {
      used += bytes.length;
    }
    harness.fileSystem.setDiskCapacityBytes(used + 600);

    const second = await harness.open({ maxSegmentBytes: 1_000 });
    for (const frame of createTestFrames(40, {}, 100)) {
      second.enqueue(frame);
    }
    await expect(second.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    await second.close().catch(() => undefined);

    // Older segments are byte-identical: the disk filled, the archive did not
    // get recycled.
    for (const manifest of manifestsBefore) {
      const path = `${WAL_DIRECTORY}/${manifest.segmentFileName}`;
      expect(harness.base.snapshot()[path]).toBe(snapshotBefore[path]);
    }
  });
});

function fail(): never {
  throw new Error("expected a generated frame");
}
