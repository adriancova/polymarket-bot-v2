/**
 * The accepted-frame invariant, on every write path that can fail.
 *
 * `WP-050` acceptance 3 is "queue overflow is observable and never silently
 * drops frames", and §8.3 forbids a silent drop outright. A refusal is easy to
 * get right; the hard part is the frame the writer *accepted* and then could not
 * write. The invariant this file pins down is total:
 *
 * > A frame that `enqueue` accepted leaves the writer's accountability only by
 * > appearing in a segment manifest, or by being handed back through
 * > `pendingFrames()`. Never by both, and never by neither.
 *
 * Round-1 review found three failure paths that broke it, because only a failed
 * *append* fed `pendingFrames()` while `drain()` had already emptied the queue:
 * creating a segment (the header write), finalizing one (the footer write), and
 * `fsync`. Each is reproduced below, together with the fourth problem the same
 * review found — a manifest that counted records no `fsync` had covered, and so
 * overcounted after a power loss.
 *
 * `manifested + pending === accepted` is asserted as an ordered partition, not
 * as a count: a partition that loses frame 3 and duplicates frame 4 has the
 * right size.
 */

import { describe, expect, it } from "vitest";

import {
  listSegmentManifests,
  readSegmentRecords,
  scanSegment,
  segmentFileName,
  validateSegment,
  WalWriteFaultError,
} from "@polymarket-bot/storage-wal";
import type { RawFrameRecord, WalFileSystem, WalWriter } from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, recordedIngestSeqs, WAL_DIRECTORY } from "./support/harness.js";

/**
 * Ingest sequences a compactor would actually consume: only segments that carry
 * a manifest, which is the mechanism that keeps an unverified segment out of a
 * dataset manifest (ADR-004 §5, handoff §12.5).
 */
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
    expect(records).toHaveLength(manifest.recordCount);
    seqs.push(...records.map((record) => record.ingestSeq));
  }
  return seqs;
}

/**
 * The invariant itself: every accepted frame is manifested or pending, exactly
 * once, in the order it was accepted.
 */
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

/** No manifest may claim more records than its segment actually holds. */
async function expectNoManifestOvercounts(fileSystem: WalFileSystem): Promise<void> {
  for (const manifest of await listSegmentManifests(fileSystem, WAL_DIRECTORY)) {
    const scan = await scanSegment(
      fileSystem,
      `${WAL_DIRECTORY}/${segmentFileName(manifest.segmentId)}`,
      { onIssue: "collect" },
    );
    expect(
      manifest.recordCount,
      `manifest for ${manifest.segmentId} claims ${manifest.recordCount} records but the file holds ${scan.recordCount}`,
    ).toBeLessThanOrEqual(scan.recordCount);
  }
}

async function enqueueAll(
  writer: WalWriter,
  frames: readonly RawFrameRecord[],
): Promise<readonly RawFrameRecord[]> {
  const accepted: RawFrameRecord[] = [];
  for (const frame of frames) {
    if (writer.enqueue(frame).accepted) {
      accepted.push(frame);
    }
  }
  return accepted;
}

describe("a failure creating the segment file", () => {
  // Review round 1, scenario (a): the header write failed, `drain()` had already
  // emptied the queue, and the three accepted frames were accounted for nowhere
  // — the writer even stayed `open` and `close()` returned null.
  it("faults the writer and keeps every accepted frame", async () => {
    const harness = createFaultHarness({
      onAppend: (call) =>
        call === 1 ? { writeBytes: 0, error: new Error("EIO: header write failed") } : undefined,
    });
    const writer = await harness.open();
    const accepted = await enqueueAll(writer, createTestFrames(3));
    expect(accepted).toHaveLength(3);

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    expect(writer.state).toBe("faulted");
    expect(writer.metrics().writeFaults).toBe(1);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2", "3"]);

    // No segment was ever verifiable, so nothing is manifested and everything
    // is still the caller's.
    expect(await writer.close()).toBeNull();
    expect(await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY)).toEqual([]);
    await expectExactPartition(writer, harness.fileSystem, accepted);
  });

  it("keeps every accepted frame when the header write tears", async () => {
    const harness = createFaultHarness({
      onAppend: (call, _path, bytes) =>
        call === 1
          ? { writeBytes: Math.floor(bytes.length / 3), error: new Error("SIGKILL mid-header") }
          : undefined,
    });
    const writer = await harness.open();
    const accepted = await enqueueAll(writer, createTestFrames(4));

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    await writer.close();
    await expectExactPartition(writer, harness.fileSystem, accepted);
    await expectNoManifestOvercounts(harness.fileSystem);
  });

  it("lets the caller re-record every pending frame against a fresh writer", async () => {
    const harness = createFaultHarness({
      onAppend: (call) =>
        call === 1 ? { writeBytes: 0, error: new Error("EIO: header write failed") } : undefined,
    });
    const first = await harness.open();
    await enqueueAll(first, createTestFrames(3));
    await expect(first.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    await first.close();

    // The partial segment left behind is recovered as empty, and the fresh
    // writer takes the next ordinal rather than reopening it.
    const second = await harness.open();
    expect(second.recovery.hasIntegrityFailures).toBe(false);
    for (const frame of first.pendingFrames()) {
      expect(second.enqueue(frame).accepted).toBe(true);
    }
    await second.close();

    expect(await manifestedIngestSeqs(harness.fileSystem)).toEqual(["1", "2", "3"]);
    expect(second.pendingFrames()).toEqual([]);
  });
});

describe("a failure finalizing a segment", () => {
  /** Rotate after one frame, and fail the rotation's footer write. */
  function harnessFailingTheFooter(footerAppendCall: number): ReturnType<typeof createFaultHarness> {
    return createFaultHarness({
      onAppend: (call) =>
        call === footerAppendCall
          ? { writeBytes: 0, error: new Error("EIO: footer write failed") }
          : undefined,
    });
  }

  // Review round 1, scenario (b): three accepted, one recorded, two vanished —
  // `pendingFrames()` was empty and `close()` produced a one-record manifest
  // that quietly stood for the whole batch.
  it("keeps the frames the rotation never got to write", async () => {
    const frames = createTestFrames(3);
    // Appends: 1 = header, 2 = frame 1, 3 = the rotation footer.
    const harness = harnessFailingTheFooter(3);
    const writer = await harness.open({ maxSegmentBytes: 500 });
    const accepted = await enqueueAll(writer, frames);
    expect(accepted).toHaveLength(3);

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    expect(writer.state).toBe("faulted");
    // Frame 1 was appended but no fsync had covered it, so it is still the
    // writer's debt at this point, alongside the two frames never written.
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2", "3"]);

    const manifest = await writer.close();
    expect(manifest?.recordCount).toBe(1);
    const { manifested, pending } = await expectExactPartition(
      writer,
      harness.fileSystem,
      accepted,
    );
    expect(manifested).toEqual(["1"]);
    expect(pending).toEqual(["2", "3"]);
    await expectNoManifestOvercounts(harness.fileSystem);
  });

  it("keeps them when the footer is written but its fsync fails", async () => {
    const frames = createTestFrames(3);
    const harness = createFaultHarness({
      // Syncs: 1 = header, 2 = the rotation footer's fsync.
      onSync: (call) => (call === 2 ? new Error("EIO: fsync failed") : undefined),
    });
    const writer = await harness.open({ maxSegmentBytes: 500 });
    const accepted = await enqueueAll(writer, frames);

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    await writer.close();
    await expectExactPartition(writer, harness.fileSystem, accepted);
    await expectNoManifestOvercounts(harness.fileSystem);
  });

  it("keeps them when rotation cannot write the sidecar", async () => {
    const frames = createTestFrames(3);
    const harness = createFaultHarness();
    const writer = await harness.open({ maxSegmentBytes: 500 });
    const accepted = await enqueueAll(writer, frames);
    // The disk fills between the footer and the sidecar: the segment bytes are
    // complete and fsynced, but nothing can describe them yet.
    harness.fileSystem.setDiskCapacityBytes(700);

    await expect(writer.drain()).rejects.toThrow();
    await writer.close().catch(() => undefined);
    harness.fileSystem.setDiskCapacityBytes(undefined);
    await writer.close().catch(() => undefined);
    await expectExactPartition(writer, harness.fileSystem, accepted);
    await expectNoManifestOvercounts(harness.fileSystem);
  });
});

describe("a failing fsync", () => {
  // Review round 1, scenario (c): the frames had been appended but no fsync had
  // covered them, and `close()` wrote a manifest counting all three anyway. A
  // power loss then left zero records behind a manifest claiming three.
  it("never reports as durable what no fsync covered", async () => {
    const harness = createFaultHarness({
      // Every fsync after the header's fails, so nothing can ever be proven.
      onSync: (call) => (call >= 2 ? new Error("EIO: fsync failed") : undefined),
    });
    const writer = await harness.open({ fsyncByteThreshold: 1 });
    const accepted = await enqueueAll(writer, createTestFrames(3));

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    expect(writer.state).toBe("faulted");
    expect(writer.metrics().framesDurable).toBe(0);

    // Unprovable means unmanifested: the segment stays unverified rather than
    // being described by a manifest nobody could stand behind.
    expect(await writer.close()).toBeNull();
    expect(writer.metrics().unmanifestedFaultedSegments).toBe(1);
    expect(await listSegmentManifests(harness.fileSystem, WAL_DIRECTORY)).toEqual([]);
    await expectExactPartition(writer, harness.fileSystem, accepted);
    expect(writer.pendingFrames()).toHaveLength(3);
  });

  it("keeps the manifest honest when a later fsync does prove the bytes", async () => {
    const harness = createFaultHarness({
      onSync: (call) => (call === 2 ? new Error("EIO: fsync failed") : undefined),
    });
    const writer = await harness.open({ fsyncByteThreshold: 1 });
    const accepted = await enqueueAll(writer, createTestFrames(3));

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    const manifest = await writer.close();
    // close() proved the file durable with one more fsync, so what it recorded
    // it may honestly claim.
    expect(manifest).not.toBeNull();
    await expectExactPartition(writer, harness.fileSystem, accepted);
    await expectNoManifestOvercounts(harness.fileSystem);
  });
});

describe("a power loss after a failed fsync", () => {
  it("never leaves a manifest that overcounts", async () => {
    const harness = createFaultHarness({
      onSync: (call) => (call >= 2 ? new Error("EIO: fsync failed") : undefined),
    });
    const writer = await harness.open({ fsyncByteThreshold: 1 });
    const accepted = await enqueueAll(writer, createTestFrames(6));

    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriteFaultError);
    await writer.close();
    const pendingBeforeLoss = writer.pendingFrames().map((frame) => frame.ingestSeq);

    // The host loses power: every byte written since the last successful fsync
    // is gone. Only the header was ever fsynced.
    harness.fileSystem.simulatePowerLoss();

    await expectNoManifestOvercounts(harness.fileSystem);
    expect(await manifestedIngestSeqs(harness.fileSystem)).toEqual([]);
    // Nothing was lost: every accepted frame is still with the caller.
    expect(pendingBeforeLoss).toEqual(accepted.map((frame) => frame.ingestSeq));

    // And recovery describes what actually survived, not what was hoped for.
    const reopened = await harness.open();
    expect(reopened.recovery.hasIntegrityFailures).toBe(false);
    await expectNoManifestOvercounts(harness.fileSystem);
    expect(await recordedIngestSeqs(harness.fileSystem, { skipInvalid: true })).toEqual([]);
    await reopened.close();
  });

  it("never overcounts across the whole fault matrix", async () => {
    const scenarios: readonly {
      readonly name: string;
      readonly harness: () => ReturnType<typeof createFaultHarness>;
      readonly maxSegmentBytes?: number;
    }[] = [
      {
        name: "header write fails",
        harness: () =>
          createFaultHarness({
            onAppend: (call) =>
              call === 1 ? { writeBytes: 0, error: new Error("EIO") } : undefined,
          }),
      },
      {
        name: "frame append tears",
        harness: () =>
          createFaultHarness({
            onAppend: (call, _path, bytes) =>
              call === 2
                ? { writeBytes: Math.floor(bytes.length / 2), error: new Error("EIO") }
                : undefined,
          }),
      },
      {
        name: "rotation footer fails",
        harness: () =>
          createFaultHarness({
            onAppend: (call) =>
              call === 3 ? { writeBytes: 0, error: new Error("EIO") } : undefined,
          }),
        maxSegmentBytes: 500,
      },
      {
        name: "every fsync fails",
        harness: () => createFaultHarness({ onSync: (call) => (call >= 2 ? new Error("EIO") : undefined) }),
      },
      {
        name: "second fsync fails",
        harness: () => createFaultHarness({ onSync: (call) => (call === 2 ? new Error("EIO") : undefined) }),
      },
      {
        name: "disk fills mid-run",
        harness: () => createFaultHarness({ diskCapacityBytes: 1_400 }),
      },
    ];

    for (const scenario of scenarios) {
      const harness = scenario.harness();
      const writer = await harness.open({
        fsyncByteThreshold: 1,
        ...(scenario.maxSegmentBytes === undefined
          ? {}
          : { maxSegmentBytes: scenario.maxSegmentBytes }),
      });
      const accepted = await enqueueAll(writer, createTestFrames(8));
      await writer.drain().catch(() => undefined);
      await writer.close().catch(() => undefined);
      // An operator frees space, then retries the close once.
      harness.fileSystem.setDiskCapacityBytes(undefined);
      await writer.close().catch(() => undefined);

      const manifested = await manifestedIngestSeqs(harness.fileSystem);
      const pending = writer.pendingFrames().map((frame) => frame.ingestSeq);
      expect([...manifested, ...pending], `${scenario.name}: frames were lost or duplicated`).toEqual(
        accepted.map((frame) => frame.ingestSeq),
      );
      expect(writer.metrics().queue.messagesDropped, scenario.name).toBe(0);

      harness.fileSystem.simulatePowerLoss();
      await expectNoManifestOvercounts(harness.fileSystem);
    }
  });
});
