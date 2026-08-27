/**
 * Durability policy (§9.1: "Periodic `fsync`, not one `fsync` per frame";
 * ADR-004 §3: the interval is a published bound on data loss).
 *
 * The bound is only real if it is observable, so these tests count `fsync`
 * calls through the filesystem shim and then make the bound concrete: a
 * simulated power loss must lose exactly the frames written since the last
 * successful `fsync`, and no others.
 */

import { describe, expect, it } from "vitest";

import { validateWalDirectory, WalWriteFaultError } from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, recordedIngestSeqs } from "./support/harness.js";

const NO_BYTE_THRESHOLD = 10_000_000;

describe("periodic fsync", () => {
  it("does not fsync once per frame", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({
      fsyncIntervalMs: 1_000,
      fsyncByteThreshold: NO_BYTE_THRESHOLD,
    });
    for (const frame of createTestFrames(100)) {
      writer.enqueue(frame);
    }
    await writer.drain();

    // One fsync for the header, none for the hundred frames.
    expect(harness.fileSystem.syncCalls()).toBe(1);
    expect(writer.metrics().recordsUnsynced).toBe(100);
    expect(writer.metrics().framesDurable).toBe(0);
    await writer.close();
  });

  it("fsyncs exactly when the configured interval elapses", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({
      fsyncIntervalMs: 500,
      fsyncByteThreshold: NO_BYTE_THRESHOLD,
    });
    writer.enqueue(createTestFrames(1)[0] ?? fail());
    await writer.drain();
    expect(harness.fileSystem.syncCalls()).toBe(1);

    harness.clock.advance(499);
    await writer.tick();
    expect(harness.fileSystem.syncCalls()).toBe(1);

    harness.clock.advance(1);
    await writer.tick();
    expect(harness.fileSystem.syncCalls()).toBe(2);

    // Nothing unsynced means no further fsync, however much time passes.
    harness.clock.advance(10_000);
    await writer.tick();
    expect(harness.fileSystem.syncCalls()).toBe(2);

    writer.enqueue(createTestFrames(1, {}, 2)[0] ?? fail());
    await writer.drain();
    expect(harness.fileSystem.syncCalls()).toBe(3);
    await writer.close();
  });

  it("fsyncs on the byte threshold when it trips first", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: 600,
    });
    for (const frame of createTestFrames(10)) {
      writer.enqueue(frame);
      await writer.drain();
    }
    expect(harness.fileSystem.syncCalls()).toBeGreaterThan(2);
    expect(writer.metrics().framesDurable).toBeGreaterThan(0);
    await writer.close();
  });

  it("keeps unsynced bytes within the threshold plus one record", async () => {
    // The byte trigger is a high-water mark, not a hard cap: the batch stops at
    // the threshold, so the overshoot is bounded by the single record that
    // crosses it and never by "however much happened to be queued"
    // (`wal-format.md` §9).
    const harness = createFaultHarness();
    const threshold = 1_500;
    const writer = await harness.open({
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: threshold,
    });
    let largestRecordBytes = 0;
    let highWater = 0;
    for (const frame of createTestFrames(60)) {
      writer.enqueue(frame);
      largestRecordBytes = Math.max(largestRecordBytes, frame.payloadUtf8.length + 400);
      await writer.drain();
      highWater = Math.max(highWater, writer.metrics().bytesUnsynced);
    }
    expect(highWater).toBeGreaterThan(0);
    expect(highWater).toBeLessThanOrEqual(threshold + largestRecordBytes);
    await writer.close();
  });

  it("does not let a queued burst push unsynced bytes far past the threshold", async () => {
    const harness = createFaultHarness();
    const threshold = 2_000;
    const writer = await harness.open({
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: threshold,
    });
    // 200 frames arrive before a single drain — the case that used to append
    // them all in one batch and only then consider the threshold.
    for (const frame of createTestFrames(200)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    expect(writer.metrics().bytesUnsynced).toBeLessThanOrEqual(threshold * 2);
    expect(harness.fileSystem.syncCalls()).toBeGreaterThan(10);
    await writer.close();
  });

  it("reports the interval as the data-loss bound and measures fsync latency", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ fsyncIntervalMs: 750 });
    expect(writer.metrics().dataLossBoundMs).toBe(750);
    writer.enqueue(createTestFrames(1)[0] ?? fail());
    await writer.flush();
    const metrics = writer.metrics();
    expect(metrics.fsyncCount).toBeGreaterThan(0);
    expect(metrics.lastFsyncDurationMs).not.toBeNull();
    expect(metrics.msSinceLastFsync).toBe(0);
    await writer.close();
  });
});

describe("the data-loss bound, made concrete", () => {
  it("loses exactly the frames written since the last successful fsync", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: NO_BYTE_THRESHOLD,
    });

    for (const frame of createTestFrames(3)) {
      writer.enqueue(frame);
    }
    await writer.flush(); // durable: 1, 2, 3

    for (const frame of createTestFrames(4, {}, 4)) {
      writer.enqueue(frame);
    }
    await writer.drain(); // written but not fsynced: 4, 5, 6, 7
    expect(writer.metrics().recordsUnsynced).toBe(4);

    harness.fileSystem.simulatePowerLoss();

    const reopened = await harness.open();
    expect(reopened.recovery.hasIntegrityFailures).toBe(false);
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(["1", "2", "3"]);
    const reports = await validateWalDirectory(harness.fileSystem, "/wal");
    expect(reports.every((report) => report.valid)).toBe(true);
    await reopened.close();
  });

  it("loses nothing when every frame was flushed", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open();
    for (const frame of createTestFrames(5)) {
      writer.enqueue(frame);
    }
    await writer.flush();

    harness.fileSystem.simulatePowerLoss();

    const reopened = await harness.open();
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(["1", "2", "3", "4", "5"]);
    await reopened.close();
  });
});

describe("a failing fsync", () => {
  it("faults the writer instead of reporting success", async () => {
    const harness = createFaultHarness({
      // Call 1 is the header fsync; call 2 is the first periodic one.
      onSync: (call) => (call === 2 ? new Error("EIO: fsync failed") : undefined),
    });
    const writer = await harness.open();
    for (const frame of createTestFrames(3)) {
      writer.enqueue(frame);
    }
    await expect(writer.flush()).rejects.toBeInstanceOf(WalWriteFaultError);
    expect(writer.state).toBe("faulted");
    expect(writer.metrics().writeFaults).toBe(1);

    const refused = writer.enqueue(createTestFrames(1, {}, 4)[0] ?? fail());
    expect(refused.accepted).toBe(false);

    // Closing reconciles, and reconciling means telling the truth: the failed
    // fsync froze the segment's durability watermark at the header, so no
    // manifest can be written and all three frames go back to the caller. A
    // later fsync returning success does not change that — on Linux it can do
    // so without the failed writeback ever having landed (round-2 HIGH-2).
    expect(await writer.close()).toBeNull();
    expect(writer.metrics().unmanifestedFaultedSegments).toBe(1);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2", "3"]);
    expect(await recordedIngestSeqs(harness.fileSystem, { skipInvalid: true })).toEqual([]);
  });
});

function fail(): never {
  throw new Error("expected a generated frame");
}
