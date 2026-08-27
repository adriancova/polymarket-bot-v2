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
  WalConfigurationError,
  WalWriteFaultError,
} from "@polymarket-bot/storage-wal";
import type { SegmentIdContext } from "@polymarket-bot/storage-wal";
import { createTestFrames, DEFAULT_TEST_EPOCH_MS } from "@polymarket-bot/storage-wal/testing";

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

  /**
   * Enqueue a burst with **no drain between the offers**, then write it in one
   * go. Returns how many frames were admitted and how many segment bytes that
   * produced.
   */
  async function runQueuedBurst(
    burst: number,
    maxTotalBytes: number,
    maxSegmentBytes: number,
  ): Promise<{ readonly admitted: number; readonly onDisk: number }> {
    const harness = createFaultHarness();
    const writer = await harness.open({
      maxTotalBytes,
      maxSegmentBytes,
      // No time rotation: §11.1 pre-accounts size-driven rotation only, and the
      // one-segment residual it does not cover is a *time* rotation.
      maxSegmentAgeMs: 1_000_000_000,
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: 10_000_000,
    });
    let admitted = 0;
    for (const frame of createTestFrames(burst)) {
      if (writer.enqueue(frame).accepted) {
        admitted += 1;
      }
      expect(writer.metrics().capacityRemainingBytes).toBeGreaterThanOrEqual(0);
    }
    await writer.drain();
    await writer.close();
    let onDisk = 0;
    for (const [path, bytes] of harness.base.files) {
      if (path.endsWith(".wal.jsonl")) {
        onDisk += bytes.length;
      }
    }
    expect(await recordedIngestSeqs(harness.fileSystem)).toHaveLength(admitted);
    expect(writer.metrics().queue.messagesDropped).toBe(0);
    return { admitted, onDisk };
  }

  it("keeps a queued burst under the threshold, at the exact cap and one byte below", async () => {
    // Round-2 review, MEDIUM. `#overheadReserve` divided the unwritten frame
    // bytes by `maxSegmentBytes` to decide how many segments they needed, which
    // ignores two things: each segment spends part of that budget on its own
    // header line, and a segment holds **whole records**. With the reviewer's
    // 900-byte segments a 415-byte frame packs one per segment, so a 10-frame
    // burst needs ten segments where the division predicted five — and the
    // 3-, 10- and 20-frame bursts overshot the cap by 306, 2340 and 4695 bytes.
    //
    // Only a queued burst exposes it: draining between offers keeps exactly one
    // frame unwritten, and one frame never needs more than one segment.
    const maxSegmentBytes = 900;
    for (const burst of [1, 2, 3, 10, 20]) {
      // The smallest threshold that admits the whole burst — a cap-exact vector,
      // found rather than hard-coded so it tracks the format. Admission is
      // monotone in the threshold, so a binary search finds the boundary.
      let low = 1_000;
      let high = 60_000;
      expect((await runQueuedBurst(burst, high, maxSegmentBytes)).admitted).toBe(burst);
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((await runQueuedBurst(burst, middle, maxSegmentBytes)).admitted >= burst) {
          high = middle;
        } else {
          low = middle + 1;
        }
      }
      const cap = low;

      // At the exact cap: everything is admitted, and the bytes it produces are
      // at or under the threshold. This is the assertion the old projection
      // failed.
      const atCap = await runQueuedBurst(burst, cap, maxSegmentBytes);
      expect(atCap.admitted, `burst ${burst}: cap ${cap} should admit all`).toBe(burst);
      expect(atCap.onDisk, `burst ${burst}: cap ${cap} was exceeded`).toBeLessThanOrEqual(cap);

      // One byte below it the last frame is refused — refusing sooner is the
      // safe direction, but the reservation must not be *arbitrarily* pessimistic
      // either, or the threshold would stop meaning anything.
      const belowCap = await runQueuedBurst(burst, cap - 1, maxSegmentBytes);
      expect(belowCap.admitted, `burst ${burst}: cap ${cap - 1} should refuse one`).toBe(
        burst - 1,
      );
      expect(belowCap.onDisk).toBeLessThanOrEqual(cap - 1);
    }
  });

  it("holds the bound for queued bursts across segment sizes and thresholds", async () => {
    for (const maxSegmentBytes of [900, 1_500, 4_096]) {
      for (const burst of [3, 10, 20]) {
        for (const cap of [1_100, 2_000, 4_000, 6_000, 10_000, 20_000]) {
          const { onDisk } = await runQueuedBurst(burst, cap, maxSegmentBytes);
          expect(
            onDisk,
            `burst ${burst}, segment ${maxSegmentBytes}, threshold ${cap} was exceeded`,
          ).toBeLessThanOrEqual(cap);
        }
      }
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
  it("faults the writer, claims nothing, and keeps every frame recoverable", async () => {
    const harness = createFaultHarness({ diskCapacityBytes: 1_400 });
    const writer = await harness.open({
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: 10_000_000,
    });
    const accepted = createTestFrames(20).map((frame) => frame.ingestSeq);
    for (const frame of createTestFrames(20)) {
      writer.enqueue(frame);
    }

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    expect(writer.state).toBe("faulted");
    expect(writer.metrics().queue.messagesDropped).toBe(0);
    expect(writer.pendingFrames().length).toBeGreaterThan(0);

    // The `ENOSPC` tore an append on this segment's handle, so its durability
    // watermark froze at the header — the last fsync that succeeded before the
    // failure. No manifest may be written for what the tear left behind, and
    // the close says so by returning null rather than by claiming a prefix
    // (round-2 HIGH-2). The bytes stay on disk, unverified.
    expect(await writer.close()).toBeNull();
    expect(writer.state).toBe("closed");
    expect(writer.metrics().unmanifestedFaultedSegments).toBe(1);
    expect(await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY)).toEqual([]);

    // Nothing was recorded, and nothing was lost: all twenty are the caller's.
    expect(await recordedIngestSeqs(harness.fileSystem, { skipInvalid: true })).toEqual([]);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(accepted);

    // The operator frees space. Recovery finalizes the abandoned segment on the
    // next open, describing exactly what survived — the disclosed at-least-once
    // boundary, since those records are also still pending.
    harness.fileSystem.setDiskCapacityBytes(1_000_000);
    const reopened = await harness.open();
    expect(reopened.recovery.hasIntegrityFailures).toBe(false);
    const recovered = await recordedIngestSeqs(harness.fileSystem);
    expect(recovered.length).toBeGreaterThan(0);
    expect(accepted.slice(0, recovered.length)).toEqual(recovered);
    await reopened.close();

    const reports = await validateWalDirectory(harness.fileSystem, WAL_DIRECTORY);
    expect(reports.every((report) => report.valid)).toBe(true);
  });

  it("still fails a close that cannot write a sidecar it is entitled to write", async () => {
    // The retryable branch survives the round-2 change: when the watermark is
    // clean, the only thing standing between the segment and its manifest is
    // disk space, and `close()` must fail loudly rather than silently drop the
    // claim it is entitled to make.
    // Three failed sidecar writes: the clean close consumes two of them (its own
    // and the fault close's), the first retry the third, and only the second
    // retry lands.
    const harness = createFaultHarness({
      onWriteWholeFile: (call) => (call <= 3 ? new Error("ENOSPC: no space for sidecar") : undefined),
    });
    const writer = await harness.open();
    for (const frame of createTestFrames(4)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }

    await expect(writer.close()).rejects.toThrow(/ENOSPC/u);
    expect(writer.state).toBe("faulted");
    await expect(writer.close()).rejects.toThrow(/ENOSPC/u);
    expect(writer.pendingFrames()).toHaveLength(4);
    expect(await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY)).toEqual([]);

    const manifest = await writer.close();
    expect(writer.state).toBe("closed");
    expect(manifest?.recordCount).toBe(4);
    // Accountability moved exactly once, with the manifest write.
    expect(writer.pendingFrames()).toEqual([]);
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(["1", "2", "3", "4"]);
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

/**
 * Round-3 review, MEDIUM. `maxTotalBytes` is documented as a **hard** threshold,
 * so it has to hold against an injected `segmentIdFactory` too — the id is
 * written into both the header and the footer, so its width is part of the
 * framing the reservation charges for.
 *
 * The projection used to measure the factory's id by calling it once and cache
 * the result with 64 bytes of slack. But `SegmentIdContext` carries
 * `createdAtMs`, and the factory is called **again** when the segment actually
 * opens — by then the clock has moved, and a time-dependent factory answers with
 * a completely different width. The reviewer's probe measured a short id at
 * admission, got a 5,000-byte one at open, and finished 7,964 bytes over the cap.
 *
 * The fix (`wal-format.md` §11.2) states the factory contract and enforces it:
 * an id is at most `MAX_SEGMENT_ID_BYTES` UTF-8 bytes, an injected factory is
 * charged that worst case rather than a measurement that can go stale, and an
 * over-long id is refused loudly instead of quietly overrunning the threshold.
 */
describe("the capacity threshold against an injected segmentIdFactory", () => {
  /**
   * Ids that grow with the clock and stay inside the documented bound: 25
   * characters per simulated second, up to 500. Nothing here is pathological —
   * this is a factory that folds the creation time into the id, which
   * `SegmentIdContext` exists to permit.
   */
  const timeDependentFactory = (context: SegmentIdContext): string =>
    `${context.gatewayEpoch}-${String(context.segmentIndex).padStart(6, "0")}-${"a".repeat(
      Math.min(Math.floor((context.createdAtMs - DEFAULT_TEST_EPOCH_MS) / 40), 500),
    )}`;

  async function onDiskBytes(harness: ReturnType<typeof createFaultHarness>): Promise<number> {
    let total = 0;
    for (const [path, bytes] of harness.base.files.entries()) {
      if (path.endsWith(".wal.jsonl")) {
        total += bytes.length;
      }
    }
    return total;
  }

  it("never exceeds maxTotalBytes when the factory's id grows between admission and open", async () => {
    // Reproduced against the pre-fix writer: 12 frames admitted against a
    // 27-byte id measured at the first offer, 6,756 bytes on disk behind a
    // 546-byte id at open — 756 bytes past a threshold documented as hard.
    const harness = createFaultHarness();
    const cap = 6_000;
    const writer = await harness.open({
      maxTotalBytes: cap,
      maxSegmentBytes: 100_000,
      segmentIdFactory: timeDependentFactory,
    });

    const accepted: string[] = [];
    for (const frame of createTestFrames(20)) {
      // Time passes between offers, exactly as it does in a real recorder: the
      // id the projection measured is not the id the segment will be opened
      // with.
      harness.clock.advance(1_000);
      if (writer.enqueue(frame).accepted) {
        accepted.push(frame.ingestSeq);
      }
    }
    await writer.drain().catch(() => undefined);
    await writer.close().catch(() => undefined);

    // The threshold still admits real work — a bound that refuses everything
    // proves nothing — and the bytes on disk stayed inside it.
    expect(accepted.length).toBeGreaterThan(0);
    expect(await onDiskBytes(harness)).toBeLessThanOrEqual(cap);
    expect(writer.metrics().capacityRemainingBytes).toBeGreaterThanOrEqual(0);
    // And nothing was lost on the way: every accepted frame is recorded or
    // pending, never neither.
    const recorded = await recordedIngestSeqs(harness.fileSystem, { skipInvalid: true });
    const pending = writer.pendingFrames().map((frame) => frame.ingestSeq);
    expect([...recorded, ...pending]).toEqual(accepted);
    expect(writer.metrics().queue.messagesDropped).toBe(0);
  });

  it("refuses an over-long factory id loudly instead of overrunning the threshold", async () => {
    // The reviewer's 5,000-byte id is past the documented bound, so it is not
    // silently charged to the archive: the factory is rejected. Being refused at
    // admission is the honest answer — a bound nobody can enforce is not a bound.
    const overLong = (context: SegmentIdContext): string =>
      `${context.gatewayEpoch}-${"z".repeat(5_000)}-${context.segmentIndex}`;
    const harness = createFaultHarness();
    await expect(
      harness.open({ maxTotalBytes: 20_000, segmentIdFactory: overLong }),
    ).rejects.toBeInstanceOf(WalConfigurationError);
    // Nothing was created before the refusal.
    expect([...harness.base.files.keys()].filter((path) => path.endsWith(".wal.jsonl"))).toEqual(
      [],
    );
  });

  it("faults loudly rather than over-capping when a factory grows past the bound later", async () => {
    // A factory that starts inside the bound and later leaves it cannot be
    // caught at construction. It is caught at open, before the file exists, so
    // the cap still holds and every accepted frame comes back to the caller.
    const grows = (context: SegmentIdContext): string =>
      `${context.gatewayEpoch}-${String(context.segmentIndex).padStart(6, "0")}-${"a".repeat(
        context.createdAtMs === DEFAULT_TEST_EPOCH_MS ? 8 : 4_000,
      )}`;
    const harness = createFaultHarness();
    const cap = 20_000;
    const writer = await harness.open({ maxTotalBytes: cap, segmentIdFactory: grows });

    const accepted: string[] = [];
    for (const frame of createTestFrames(3)) {
      if (writer.enqueue(frame).accepted) {
        accepted.push(frame.ingestSeq);
      }
    }
    harness.clock.advance(1_000);
    await expect(writer.drain()).rejects.toThrow(/segment id/u);
    expect(writer.state).toBe("faulted");

    await writer.close().catch(() => undefined);
    expect(await onDiskBytes(harness)).toBeLessThanOrEqual(cap);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(accepted);
    expect(writer.metrics().queue.messagesDropped).toBe(0);
  });
});

function fail(): never {
  throw new Error("expected a generated frame");
}
