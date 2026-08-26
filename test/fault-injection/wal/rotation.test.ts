/**
 * Rotation by size **and** time (§9.1), asserted end to end.
 *
 * Rotation is where a recorder most easily loses or duplicates a frame, so
 * every case here checks the same invariant: after rotation, the concatenation
 * of the segments is exactly the sequence of accepted frames, in order, and
 * every segment validates on its own.
 */

import { describe, expect, it } from "vitest";

import { listSegmentManifests, validateWalDirectory } from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, recordedIngestSeqs, WAL_DIRECTORY } from "./support/harness.js";

const expectedSeqs = (count: number): readonly string[] =>
  createTestFrames(count).map((frame) => frame.ingestSeq);

describe("rotation by size", () => {
  it("keeps every segment under the bound and every frame in order", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ maxSegmentBytes: 1_200 });
    for (const frame of createTestFrames(40)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
      await writer.drain();
    }
    await writer.close();

    const manifests = await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY);
    expect(manifests.length).toBeGreaterThan(3);
    for (const manifest of manifests) {
      // The bound governs the frame region; the footer line is written after it.
      expect(manifest.checksummedByteLength).toBeLessThanOrEqual(1_200);
      expect(manifest.recordCount).toBeGreaterThan(0);
    }
    expect(manifests.reduce((total, m) => total + m.recordCount, 0)).toBe(40);
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(expectedSeqs(40));

    const reports = await validateWalDirectory(harness.fileSystem, WAL_DIRECTORY);
    expect(reports.every((report) => report.valid)).toBe(true);
    expect(reports).toHaveLength(manifests.length);
  });

  it("rotates within a single batched drain", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ maxSegmentBytes: 1_200 });
    for (const frame of createTestFrames(40)) {
      writer.enqueue(frame);
    }
    const result = await writer.drain();
    expect(result.framesWritten).toBe(40);
    expect(result.rotations).toBeGreaterThan(0);
    await writer.close();
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(expectedSeqs(40));
  });

  it("gives every segment a distinct id and a consecutive index", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ maxSegmentBytes: 900 });
    for (const frame of createTestFrames(20)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    await writer.close();

    const manifests = await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY);
    expect(new Set(manifests.map((m) => m.segmentId)).size).toBe(manifests.length);
    expect(manifests.map((m) => m.segmentIndex)).toEqual(manifests.map((_, index) => index));
    expect(new Set(manifests.map((m) => m.gatewayEpoch)).size).toBe(1);
    // The record ranges are contiguous and non-overlapping.
    const ranges = manifests.map((m) => [m.firstIngestSeq, m.lastIngestSeq] as const);
    for (let index = 1; index < ranges.length; index += 1) {
      const previousEnd = Number(ranges[index - 1]?.[1] ?? "0");
      const currentStart = Number(ranges[index]?.[0] ?? "0");
      expect(currentStart).toBe(previousEnd + 1);
    }
  });
});

describe("rotation by time", () => {
  it("rotates an aged segment on the next drain", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ maxSegmentAgeMs: 60_000, maxSegmentBytes: 10_000_000 });
    for (const frame of createTestFrames(3)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    const first = writer.activeSegmentId;

    harness.clock.advance(59_999);
    writer.enqueue(createTestFrames(1, {}, 4)[0] ?? fail());
    await writer.drain();
    expect(writer.activeSegmentId).toBe(first);

    harness.clock.advance(1);
    writer.enqueue(createTestFrames(1, {}, 5)[0] ?? fail());
    await writer.drain();
    expect(writer.activeSegmentId).not.toBe(first);
    await writer.close();

    const manifests = await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY);
    expect(manifests).toHaveLength(2);
    expect(manifests[0]?.closeReason).toBe("time-rotation");
    expect(manifests[0]?.recordCount).toBe(4);
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(expectedSeqs(5));
  });

  it("rotates an idle segment on tick, so segment age stays bounded", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ maxSegmentAgeMs: 10_000 });
    writer.enqueue(createTestFrames(1)[0] ?? fail());
    await writer.drain();
    expect(writer.metrics().activeSegmentAgeMs).toBe(0);

    harness.clock.advance(10_000);
    expect(writer.metrics().activeSegmentAgeMs).toBe(10_000);
    await writer.tick();
    expect(writer.activeSegmentId).toBeNull();
    expect(writer.metrics().activeSegmentAgeMs).toBeNull();

    const manifests = await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.closeReason).toBe("time-rotation");
    await writer.close();
  });

  it("keeps rotating across a long simulated run", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ maxSegmentAgeMs: 5_000, fsyncIntervalMs: 1_000 });
    for (let index = 0; index < 30; index += 1) {
      writer.enqueue(createTestFrames(1, {}, index + 1)[0] ?? fail());
      await writer.drain();
      harness.clock.advance(1_000);
      await writer.tick();
    }
    await writer.close();

    const manifests = await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY);
    expect(manifests.length).toBeGreaterThanOrEqual(5);
    expect(manifests.reduce((total, m) => total + m.recordCount, 0)).toBe(30);
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(expectedSeqs(30));
    const reports = await validateWalDirectory(harness.fileSystem, WAL_DIRECTORY);
    expect(reports.every((report) => report.valid)).toBe(true);
  });
});

function fail(): never {
  throw new Error("expected a generated frame");
}
