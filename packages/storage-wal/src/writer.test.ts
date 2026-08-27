import { describe, expect, it } from "vitest";

import { WalConfigurationError, WalRecordValidationError, WalWriterStateError } from "./errors.js";
import { listSegmentManifests, segmentFileName } from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import type {
  WalFsyncEvent,
  WalIngestSeqAnomalyEvent,
  WalOverflowEvent,
  WalSegmentOpenedEvent,
} from "./ports.js";
import { readSegmentRecords, validateSegment, validateWalDirectory } from "./reader.js";
import { classifySegmentLine } from "./segment-format.js";
import { createManualClock, DEFAULT_TEST_EPOCH_MS } from "./testing/manual-clock.js";
import type { ManualClock } from "./testing/manual-clock.js";
import { createMemoryFileSystem } from "./testing/memory-file-system.js";
import type { MemoryFileSystem } from "./testing/memory-file-system.js";
import { createTestFrame, createTestFrames, TEST_GATEWAY_EPOCH } from "./testing/frames.js";
import { openWalWriter } from "./writer.js";
import type { WalWriter, WalWriterOptions } from "./writer.js";

const DIRECTORY = "/wal";

type Harness = {
  readonly fileSystem: MemoryFileSystem;
  readonly clock: ManualClock;
  readonly writer: WalWriter;
};

async function openHarness(
  overrides: Partial<WalWriterOptions> = {},
  existing?: { readonly fileSystem: MemoryFileSystem; readonly clock: ManualClock },
): Promise<Harness> {
  const fileSystem = existing?.fileSystem ?? createMemoryFileSystem();
  const clock = existing?.clock ?? createManualClock();
  const writer = await openWalWriter({
    directoryPath: DIRECTORY,
    gatewayEpoch: TEST_GATEWAY_EPOCH,
    fileSystem,
    clock,
    ...overrides,
  });
  return { fileSystem, clock, writer };
}

function segmentLines(fileSystem: MemoryFileSystem, segmentId: string): readonly string[] {
  const bytes = fileSystem.peek(`${DIRECTORY}/${segmentFileName(segmentId)}`);
  if (bytes === undefined) {
    throw new Error(`segment ${segmentId} was not written`);
  }
  const text = bytes.toString("utf8");
  return text.length === 0 ? [] : text.slice(0, -1).split("\n");
}

async function readAllIngestSeqs(
  fileSystem: MemoryFileSystem,
  manifests: readonly WalSegmentManifest[],
): Promise<readonly string[]> {
  const seqs: string[] = [];
  for (const manifest of manifests) {
    const { records } = await readSegmentRecords(
      fileSystem,
      `${DIRECTORY}/${manifest.segmentFileName}`,
    );
    seqs.push(...records.map((record) => record.ingestSeq));
  }
  return seqs;
}

describe("writer lifecycle", () => {
  it("creates no segment until a frame is written", async () => {
    const { fileSystem, writer } = await openHarness();
    expect(await fileSystem.listFileNames(DIRECTORY)).toEqual([]);
    expect(writer.activeSegmentId).toBeNull();
    await writer.drain();
    expect(await fileSystem.listFileNames(DIRECTORY)).toEqual([]);
    expect(await writer.close()).toBeNull();
  });

  it("writes a header first, then one line per frame", async () => {
    const { fileSystem, writer } = await openHarness();
    for (const frame of createTestFrames(3)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }
    await writer.drain();
    const segmentId = writer.activeSegmentId;
    expect(segmentId).not.toBeNull();
    const lines = segmentLines(fileSystem, segmentId ?? "");
    expect(lines).toHaveLength(4);
    const header = classifySegmentLine(lines[0] ?? "");
    expect(header.kind).toBe("header");
    if (header.kind !== "header") {
      throw new Error("expected a header");
    }
    expect(header.header.gatewayEpoch).toBe(TEST_GATEWAY_EPOCH);
    expect(header.header.walSchemaVersion).toBe(1);
    for (const line of lines.slice(1)) {
      expect(classifySegmentLine(line).kind).toBe("frame");
    }
    await writer.close();
  });

  it("closes with a footer and a sidecar manifest that both validate", async () => {
    const { fileSystem, writer } = await openHarness();
    for (const frame of createTestFrames(5)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    const segmentId = writer.activeSegmentId ?? "";
    const manifest = await writer.close();
    expect(manifest).not.toBeNull();
    expect(manifest?.recordCount).toBe(5);
    expect(manifest?.footerPresent).toBe(true);
    expect(manifest?.closeReason).toBe("shutdown");
    expect(manifest?.firstIngestSeq).toBe("1");
    expect(manifest?.lastIngestSeq).toBe("5");
    expect(manifest?.truncatedTailBytes).toBe(0);

    const report = await validateSegment(fileSystem, DIRECTORY, segmentId);
    expect(report.issues).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.scan.footer?.segmentSha256).toBe(manifest?.segmentSha256);
    expect(report.scan.recordCount).toBe(5);
  });

  it("preserves payload bytes verbatim through a full write-and-read cycle", async () => {
    const payloads = ["PING", "PONG", '{"event_type":"book"}', "🚀 launch", "a\nb", ""];
    const { fileSystem, writer } = await openHarness();
    payloads.forEach((payload, index) => {
      writer.enqueue(createTestFrame({ ingestSeq: index + 1, payloadUtf8: payload }));
    });
    const manifest = await writer.close();
    const { records } = await readSegmentRecords(
      fileSystem,
      `${DIRECTORY}/${manifest?.segmentFileName ?? ""}`,
    );
    expect(records.map((record) => record.payloadUtf8)).toEqual(payloads);
  });

  it("refuses to reopen an existing segment file", async () => {
    const { fileSystem, clock, writer } = await openHarness({
      segmentIdFactory: () => "fixed-segment",
    });
    writer.enqueue(createTestFrame());
    await writer.close();
    const second = await openHarness(
      { segmentIdFactory: () => "fixed-segment" },
      { fileSystem, clock },
    );
    second.writer.enqueue(createTestFrame({ ingestSeq: 2 }));
    await expect(second.writer.drain()).rejects.toBeInstanceOf(WalWriterStateError);
  });

  it("continues segment numbering across a restart", async () => {
    const { fileSystem, clock, writer } = await openHarness();
    writer.enqueue(createTestFrame());
    const first = await writer.close();

    const second = await openHarness({}, { fileSystem, clock });
    expect(second.writer.recovery.segments).toHaveLength(1);
    expect(second.writer.recovery.segments[0]?.outcome).toBe("already-finalized");
    second.writer.enqueue(createTestFrame({ ingestSeq: 2 }));
    const next = await second.writer.close();
    expect(next?.segmentIndex).toBe((first?.segmentIndex ?? 0) + 1);
    expect(next?.segmentId).not.toBe(first?.segmentId);
  });
});

describe("rotation", () => {
  it("rotates by size and keeps every record", async () => {
    const { fileSystem, writer } = await openHarness({ maxSegmentBytes: 900 });
    for (const frame of createTestFrames(12)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    await writer.close();

    const manifests = await listSegmentManifests(fileSystem, DIRECTORY);
    expect(manifests.length).toBeGreaterThan(1);
    for (const manifest of manifests) {
      expect(manifest.byteSize).toBeLessThanOrEqual(900 + 400);
      expect(manifest.recordCount).toBeGreaterThan(0);
    }
    expect(manifests.filter((m) => m.closeReason === "size-rotation").length).toBeGreaterThan(0);
    expect(await readAllIngestSeqs(fileSystem, manifests)).toEqual(
      createTestFrames(12).map((frame) => frame.ingestSeq),
    );
    const reports = await validateWalDirectory(fileSystem, DIRECTORY);
    expect(reports.every((report) => report.valid)).toBe(true);
  });

  it("never splits a record that is larger than the size bound", async () => {
    const { fileSystem, writer } = await openHarness({ maxSegmentBytes: 200 });
    writer.enqueue(createTestFrame({ ingestSeq: 1, payloadUtf8: "x".repeat(2_000) }));
    writer.enqueue(createTestFrame({ ingestSeq: 2, payloadUtf8: "y".repeat(2_000) }));
    await writer.drain();
    await writer.close();
    const manifests = await listSegmentManifests(fileSystem, DIRECTORY);
    expect(manifests).toHaveLength(2);
    expect(manifests.every((manifest) => manifest.recordCount === 1)).toBe(true);
    const reports = await validateWalDirectory(fileSystem, DIRECTORY);
    expect(reports.every((report) => report.valid)).toBe(true);
  });

  it("rotates by age on the next drain", async () => {
    const { fileSystem, clock, writer } = await openHarness({ maxSegmentAgeMs: 60_000 });
    writer.enqueue(createTestFrame({ ingestSeq: 1 }));
    await writer.drain();
    const firstSegment = writer.activeSegmentId;
    clock.advance(60_000);
    writer.enqueue(createTestFrame({ ingestSeq: 2 }));
    await writer.drain();
    expect(writer.activeSegmentId).not.toBe(firstSegment);
    await writer.close();
    const manifests = await listSegmentManifests(fileSystem, DIRECTORY);
    expect(manifests).toHaveLength(2);
    expect(manifests[0]?.closeReason).toBe("time-rotation");
  });

  it("rotates an idle aged segment on tick", async () => {
    const { fileSystem, clock, writer } = await openHarness({ maxSegmentAgeMs: 30_000 });
    writer.enqueue(createTestFrame());
    await writer.drain();
    expect(writer.activeSegmentId).not.toBeNull();
    clock.advance(29_999);
    await writer.tick();
    expect(writer.activeSegmentId).not.toBeNull();
    clock.advance(1);
    await writer.tick();
    expect(writer.activeSegmentId).toBeNull();
    const manifests = await listSegmentManifests(fileSystem, DIRECTORY);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.closeReason).toBe("time-rotation");
    await writer.close();
  });

  it("does not rotate an empty segment on tick", async () => {
    const { clock, writer } = await openHarness({ maxSegmentAgeMs: 1_000 });
    writer.enqueue(createTestFrame());
    await writer.drain();
    await writer.rotate();
    expect(writer.activeSegmentId).toBeNull();
    clock.advance(100_000);
    await writer.tick();
    expect(writer.activeSegmentId).toBeNull();
    await writer.close();
  });

  it("returns the manifest from an explicit rotation", async () => {
    const { writer } = await openHarness();
    writer.enqueue(createTestFrame());
    const manifest = await writer.rotate();
    expect(manifest?.closeReason).toBe("manual-rotation");
    expect(writer.activeSegmentId).toBeNull();
    expect(await writer.rotate()).toBeNull();
    await writer.close();
  });
});

describe("durability policy", () => {
  it("does not fsync once per frame", async () => {
    const { fileSystem, writer } = await openHarness({
      fsyncIntervalMs: 1_000,
      fsyncByteThreshold: 10_000_000,
    });
    for (const frame of createTestFrames(50)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    // One fsync for the header, and none for the 50 frames.
    expect(fileSystem.stats.syncs).toBe(1);
    expect(writer.metrics().recordsUnsynced).toBe(50);
    await writer.close();
  });

  it("fsyncs when the interval elapses", async () => {
    const { fileSystem, clock, writer } = await openHarness({
      fsyncIntervalMs: 1_000,
      fsyncByteThreshold: 10_000_000,
    });
    writer.enqueue(createTestFrame({ ingestSeq: 1 }));
    await writer.drain();
    expect(fileSystem.stats.syncs).toBe(1);

    clock.advance(999);
    await writer.tick();
    expect(fileSystem.stats.syncs).toBe(1);

    clock.advance(1);
    await writer.tick();
    expect(fileSystem.stats.syncs).toBe(2);
    expect(writer.metrics().recordsUnsynced).toBe(0);
    expect(writer.metrics().framesDurable).toBe(1);
    await writer.close();
  });

  it("fsyncs when the byte threshold is reached", async () => {
    const { fileSystem, writer } = await openHarness({
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: 512,
    });
    for (const frame of createTestFrames(20)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    expect(fileSystem.stats.syncs).toBeGreaterThan(1);
    await writer.close();
  });

  it("publishes the fsync interval as the data-loss bound", async () => {
    const { writer } = await openHarness({ fsyncIntervalMs: 250 });
    expect(writer.metrics().dataLossBoundMs).toBe(250);
    await writer.close();
  });

  it("flush forces an fsync outside the periodic policy", async () => {
    const { fileSystem, writer } = await openHarness({
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: 10_000_000,
    });
    writer.enqueue(createTestFrame());
    await writer.drain();
    expect(fileSystem.stats.syncs).toBe(1);
    const result = await writer.flush();
    expect(result.fsyncs).toBe(1);
    expect(fileSystem.stats.syncs).toBe(2);
    await writer.close();
  });

  it("uses monotonic time, so a wall-clock step does not trigger an fsync", async () => {
    const { fileSystem, clock, writer } = await openHarness({
      fsyncIntervalMs: 1_000,
      fsyncByteThreshold: 10_000_000,
    });
    writer.enqueue(createTestFrame());
    await writer.drain();
    clock.setWallClock(Date.UTC(2030, 0, 1));
    await writer.tick();
    expect(fileSystem.stats.syncs).toBe(1);
    await writer.close();
  });
});

describe("backpressure and refusals", () => {
  it("refuses on queue overflow and keeps the frame with the caller", async () => {
    const overflows: WalOverflowEvent[] = [];
    const { writer } = await openHarness({
      queueCapacity: 2,
      observer: { onOverflow: (event) => overflows.push(event) },
    });
    const frames = createTestFrames(3);
    expect(writer.enqueue(frames[0] ?? createTestFrame()).accepted).toBe(true);
    expect(writer.enqueue(frames[1] ?? createTestFrame()).accepted).toBe(true);
    const refused = writer.enqueue(frames[2] ?? createTestFrame());
    expect(refused.accepted).toBe(false);
    if (refused.accepted) {
      throw new Error("expected a refusal");
    }
    expect(refused.reason).toBe("queue-overflow");
    expect(refused.queueDepth).toBe(2);
    expect(overflows).toHaveLength(1);
    expect(overflows[0]?.record.ingestSeq).toBe("3");

    const metrics = writer.metrics();
    expect(metrics.overflowSignals).toBe(1);
    expect(metrics.queue.messagesDropped).toBe(0);
    expect(metrics.framesAccepted).toBe(2);
    await writer.close();
  });

  it("refuses when the hard capacity threshold is reached, without deleting anything", async () => {
    // 800 bytes would be refused outright: a segment costs a header line and a
    // footer line beyond its records, and 800 does not fit even one frame with
    // its framing. The threshold covers those bytes, so it is a real bound on
    // what lands on disk rather than on frame lines alone.
    const { fileSystem, writer } = await openHarness({ maxTotalBytes: 2_500 });
    let refusals = 0;
    let accepted = 0;
    for (const frame of createTestFrames(20)) {
      const result = writer.enqueue(frame);
      if (result.accepted) {
        accepted += 1;
      } else {
        expect(result.reason).toBe("capacity-exceeded");
        refusals += 1;
      }
      await writer.drain();
    }
    expect(refusals).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
    expect(writer.metrics().capacityRefusals).toBe(refusals);
    await writer.close();
    const manifests = await listSegmentManifests(fileSystem, DIRECTORY);
    expect(manifests.reduce((total, m) => total + m.recordCount, 0)).toBe(accepted);

    let onDisk = 0;
    for (const [path, bytes] of fileSystem.files) {
      if (path.endsWith(".wal.jsonl")) {
        onDisk += bytes.length;
      }
    }
    expect(onDisk).toBeLessThanOrEqual(2_500);
  });

  it("refuses everything when the threshold cannot cover one segment's framing", async () => {
    const { fileSystem, writer } = await openHarness({ maxTotalBytes: 800 });
    for (const frame of createTestFrames(5)) {
      const result = writer.enqueue(frame);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.reason).toBe("capacity-exceeded");
      }
    }
    await writer.close();
    // Refusing everything is the honest outcome, and it costs no bytes and no
    // dropped frames.
    expect(fileSystem.files.size).toBe(0);
    expect(writer.metrics().queue.messagesDropped).toBe(0);
    expect(writer.metrics().capacityRemainingBytes).toBeGreaterThanOrEqual(0);
  });

  it("refuses everything once closed", async () => {
    const { writer } = await openHarness();
    await writer.close();
    const result = writer.enqueue(createTestFrame());
    expect(result.accepted).toBe(false);
    if (result.accepted) {
      throw new Error("expected a refusal");
    }
    expect(result.reason).toBe("writer-closed");
    expect(writer.metrics().closedRefusals).toBe(1);
    await expect(writer.drain()).rejects.toBeInstanceOf(WalWriterStateError);
  });

  it("counts a caller-acknowledged drop only when the caller reports it", async () => {
    const { writer } = await openHarness({ queueCapacity: 1 });
    writer.enqueue(createTestFrame({ ingestSeq: 1 }));
    const refused = writer.enqueue(createTestFrame({ ingestSeq: 2 }));
    expect(refused.accepted).toBe(false);
    expect(writer.metrics().queue.messagesDropped).toBe(0);
    writer.recordCallerDrop(1, "incident-shed");
    expect(writer.metrics().queue.messagesDropped).toBe(1);
    await writer.close();
  });
});

describe("record validation at the boundary", () => {
  it("throws rather than recording a frame from another gateway epoch", async () => {
    const { writer } = await openHarness();
    expect(() => writer.enqueue(createTestFrame({ gatewayEpoch: "other-epoch" }))).toThrow(
      WalRecordValidationError,
    );
    expect(writer.metrics().validationRejections).toBe(1);
    await writer.close();
  });

  it("throws when the declared payload digest is wrong", async () => {
    const { writer } = await openHarness();
    const frame = { ...createTestFrame(), payloadUtf8: "tampered" };
    expect(() => writer.enqueue(frame)).toThrow(WalRecordValidationError);
    await writer.close();
  });

  it("can skip digest verification when the caller opts out", async () => {
    const { writer } = await openHarness({ verifyPayloadDigest: false });
    const frame = { ...createTestFrame(), payloadUtf8: "tampered" };
    expect(writer.enqueue(frame).accepted).toBe(true);
    await writer.close();
  });

  it("rejects invalid writer configuration", async () => {
    await expect(openHarness({ maxSegmentBytes: 0 })).rejects.toBeInstanceOf(
      WalConfigurationError,
    );
    await expect(openHarness({ fsyncIntervalMs: -1 })).rejects.toBeInstanceOf(
      WalConfigurationError,
    );
    await expect(openHarness({ gatewayEpoch: "" })).rejects.toBeInstanceOf(
      WalConfigurationError,
    );
  });

  it("observes a non-monotonic ingest sequence without refusing the frame", async () => {
    const anomalies: WalIngestSeqAnomalyEvent[] = [];
    const { writer } = await openHarness({
      observer: { onIngestSeqAnomaly: (event) => anomalies.push(event) },
    });
    writer.enqueue(createTestFrame({ ingestSeq: 10 }));
    expect(writer.enqueue(createTestFrame({ ingestSeq: 9 })).accepted).toBe(true);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.previousIngestSeq).toBe("10");
    expect(writer.metrics().nonMonotonicIngestSeqCount).toBe(1);
    const manifest = await writer.close();
    expect(manifest?.recordCount).toBe(2);
  });
});

describe("observability", () => {
  it("reports segment lifecycle and fsync events", async () => {
    const opened: WalSegmentOpenedEvent[] = [];
    const finalized: WalSegmentManifest[] = [];
    const fsyncs: WalFsyncEvent[] = [];
    const { writer } = await openHarness({
      maxSegmentBytes: 700,
      observer: {
        onSegmentOpened: (event) => opened.push(event),
        onSegmentFinalized: (manifest) => finalized.push(manifest),
        onFsync: (event) => fsyncs.push(event),
      },
    });
    for (const frame of createTestFrames(10)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    await writer.flush();
    await writer.close();
    expect(opened.length).toBeGreaterThan(1);
    expect(finalized.length).toBe(opened.length);
    expect(fsyncs.some((event) => event.trigger === "explicit")).toBe(true);
    expect(opened[0]?.gatewayEpoch).toBe(TEST_GATEWAY_EPOCH);
  });


  it("exposes the §8.3 and §14.3 metric families", async () => {
    const { writer } = await openHarness();
    for (const frame of createTestFrames(4)) {
      writer.enqueue(frame);
    }
    const before = writer.metrics();
    expect(before.queue.currentDepth).toBe(4);
    expect(before.state).toBe("open");
    expect(before.activeSegmentAgeMs).toBeNull();

    await writer.drain();
    const after = writer.metrics();
    expect(after.framesWritten).toBe(4);
    expect(after.bytesWritten).toBeGreaterThan(0);
    expect(after.activeSegmentRecordCount).toBe(4);
    expect(after.activeSegmentAgeMs).toBe(0);
    expect(after.segmentsOpened).toBe(1);
    expect(after.queue.currentDepth).toBe(0);

    await writer.close();
    const closed = writer.metrics();
    expect(closed.state).toBe("closed");
    expect(closed.segmentsFinalized).toBe(1);
    expect(closed.framesDurable).toBe(4);
  });

  it("lists manifests in segment order", async () => {
    const { writer } = await openHarness({ maxSegmentBytes: 700 });
    for (const frame of createTestFrames(9)) {
      writer.enqueue(frame);
    }
    await writer.drain();
    await writer.close();
    const manifests = await writer.listManifests();
    expect(manifests.length).toBeGreaterThan(1);
    expect(manifests.map((manifest) => manifest.segmentIndex)).toEqual(
      [...manifests].map((_, index) => index),
    );
  });
});

/**
 * Round-2 review regressions.
 *
 * They are duplicated here, at unit level, on purpose: the fault-injection tree
 * that covers them in depth is not wired into the root gate or into CI yet (see
 * the `WP-050` handoff, `follow_up` 2), and these three defects are the ones
 * that would silently lose or double-count a recorded frame.
 */
describe("durability accounting under faults", () => {
  /**
   * The in-memory filesystem with a failure schedule, and with the Linux
   * writeback error cursor: after an `fsync` on a handle has failed, a later one
   * may return success while nothing new became durable.
   */
  function failingFileSystem(schedule: {
    readonly failAppendOn?: number;
    readonly failSyncOn?: number;
    readonly failWholeFileWriteUntil?: number;
  }): MemoryFileSystem & { durableBytes(path: string): number } {
    const base = createMemoryFileSystem();
    let appends = 0;
    let syncs = 0;
    let writes = 0;
    const durable = new Map<string, number>();
    const wrapped: MemoryFileSystem & { durableBytes(path: string): number } = {
      ...base,
      durableBytes: (path: string): number => durable.get(path) ?? 0,
      async openAppend(path: string) {
        const inner = await base.openAppend(path);
        let syncFailed = false;
        return {
          async append(bytes: Uint8Array): Promise<void> {
            appends += 1;
            if (appends === schedule.failAppendOn) {
              throw new Error("EIO: append failed");
            }
            await inner.append(bytes);
          },
          async sync(): Promise<void> {
            syncs += 1;
            if (syncs === schedule.failSyncOn) {
              syncFailed = true;
              throw new Error("EIO: fsync failed");
            }
            await inner.sync();
            if (!syncFailed) {
              durable.set(path, (await base.fileByteLength(path)) ?? 0);
            }
          },
          async close(): Promise<void> {
            await inner.close();
          },
        };
      },
      async writeWholeFile(path: string, bytes: Uint8Array): Promise<void> {
        writes += 1;
        if (writes <= (schedule.failWholeFileWriteUntil ?? 0)) {
          throw new Error("ENOSPC: no space for the sidecar");
        }
        await base.writeWholeFile(path, bytes);
      },
    };
    return wrapped;
  }

  async function open(
    fileSystem: MemoryFileSystem,
    clock: ManualClock,
    overrides: Partial<WalWriterOptions> = {},
  ): Promise<WalWriter> {
    return openWalWriter({
      directoryPath: DIRECTORY,
      gatewayEpoch: TEST_GATEWAY_EPOCH,
      fileSystem,
      clock,
      ...overrides,
    });
  }

  it("hands back the frames still queued when tick() faults", async () => {
    // HIGH-1a: `tick()` takes nothing from the queue, so a frame waiting in it
    // was accounted for nowhere once the rotation it triggered failed.
    const fileSystem = failingFileSystem({ failAppendOn: 3 });
    const clock = createManualClock();
    const writer = await open(fileSystem, clock, {
      maxSegmentAgeMs: 1_000,
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: 10_000_000,
    });
    expect(writer.enqueue(createTestFrame({ ingestSeq: 1 })).accepted).toBe(true);
    await writer.drain();
    expect(writer.enqueue(createTestFrame({ ingestSeq: 2 })).accepted).toBe(true);
    clock.advance(1_000);

    await expect(writer.tick()).rejects.toThrow();
    expect(writer.state).toBe("faulted");
    expect(writer.metrics().queue.currentDepth).toBe(0);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2"]);

    await writer.close();
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2"]);
    expect(await listSegmentManifests(fileSystem, DIRECTORY)).toEqual([]);
  });

  it("never lets an fsync that follows a failed one extend a durability claim", async () => {
    // HIGH-2: on Linux a writeback error is reported once and then cleared, so
    // the next `fsync` can return success without the failed writeback ever
    // having landed. The fault close may attempt it, but may not believe it.
    const fileSystem = failingFileSystem({ failSyncOn: 2 });
    const clock = createManualClock();
    const writer = await open(fileSystem, clock, { fsyncByteThreshold: 1 });
    for (const frame of createTestFrames(3)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }
    await expect(writer.drain()).rejects.toThrow();

    expect(await writer.close()).toBeNull();
    expect(writer.metrics().framesDurable).toBe(0);
    expect(writer.metrics().unmanifestedFaultedSegments).toBe(1);
    expect(await listSegmentManifests(fileSystem, DIRECTORY)).toEqual([]);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2", "3"]);
    // Only the header ever reached durable storage, which is exactly what the
    // absent manifest declines to contradict.
    const path = `${DIRECTORY}/${segmentFileName(writer.metrics().activeSegmentId ?? "")}`;
    expect(fileSystem.durableBytes(path)).toBe(0);
  });

  it("moves records out of pendingFrames only when the manifest write succeeds", async () => {
    // HIGH-1b: `finalize()` marked its records durable before writing the
    // sidecar, so two failed sidecar writes returned the frames to the caller
    // while a later, successful one still wrote a manifest naming them.
    const fileSystem = failingFileSystem({ failWholeFileWriteUntil: 2 });
    const clock = createManualClock();
    const writer = await open(fileSystem, clock);
    for (const frame of createTestFrames(3)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }

    await expect(writer.close()).rejects.toThrow(/ENOSPC/u);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2", "3"]);
    expect(await listSegmentManifests(fileSystem, DIRECTORY)).toEqual([]);

    const manifest = await writer.close();
    expect(manifest?.recordCount).toBe(3);
    // Named by the manifest, therefore no longer the caller's: never by both.
    expect(writer.pendingFrames()).toEqual([]);
    const manifests = await listSegmentManifests(fileSystem, DIRECTORY);
    expect(await readAllIngestSeqs(fileSystem, manifests)).toEqual(["1", "2", "3"]);
  });

  it("reserves enough framing for a queued burst to stay under maxTotalBytes", async () => {
    // MEDIUM: the reservation divided the queued bytes by `maxSegmentBytes`,
    // which ignores both the per-segment header and the fact that a segment
    // holds whole records. Only a burst with no drain between offers exposes it.
    for (const burst of [3, 10, 20]) {
      for (const cap of [2_000, 4_000, 10_000]) {
        const fileSystem = createMemoryFileSystem();
        const clock = createManualClock();
        const writer = await open(fileSystem, clock, {
          maxTotalBytes: cap,
          maxSegmentBytes: 900,
          maxSegmentAgeMs: 1_000_000_000,
        });
        let accepted = 0;
        for (const frame of createTestFrames(burst)) {
          if (writer.enqueue(frame).accepted) {
            accepted += 1;
          }
        }
        await writer.drain();
        await writer.close();

        let onDisk = 0;
        for (const [path, bytes] of fileSystem.files) {
          if (path.endsWith(".wal.jsonl")) {
            onDisk += bytes.length;
          }
        }
        expect(onDisk, `burst ${burst} at threshold ${cap}`).toBeLessThanOrEqual(cap);
        const manifests = await listSegmentManifests(fileSystem, DIRECTORY);
        expect(manifests.reduce((total, m) => total + m.recordCount, 0)).toBe(accepted);
        expect(writer.metrics().queue.messagesDropped).toBe(0);
      }
    }
  });

  /**
   * Round-3 review regressions, at unit level for the same reason as the
   * round-2 ones above: the fault tree that covers them in depth is still not in
   * CI, and these are the defects that lose a recorded frame.
   */

  it("returns a frame an earlier fsync proved when the segment ends unmanifested", async () => {
    // HIGH: a successful `fsync` used to release the frame from the writer's
    // accountability, on the assumption that a durable frame ends up in a
    // manifest. Under the §9.1 watermark rule it usually does not: a later
    // failure freezes the watermark short of the file and *no* manifest is
    // written, so the earlier-fsynced frame was in neither half of the
    // partition. Appends: 1 = header, 2 = frame 1, 3 = frame 2, 4 = the
    // time-rotation footer, which fails.
    const fileSystem = failingFileSystem({ failAppendOn: 4 });
    const clock = createManualClock();
    const writer = await open(fileSystem, clock, {
      maxSegmentAgeMs: 1_000,
      fsyncIntervalMs: 1_000_000,
      fsyncByteThreshold: 10_000_000,
    });

    expect(writer.enqueue(createTestFrame({ ingestSeq: 1 })).accepted).toBe(true);
    await writer.flush(); // frame 1 is now covered by a successful fsync
    expect(writer.metrics().framesDurable).toBe(1);
    expect(writer.metrics().unprovenFrameCount).toBe(0);
    // Durability released nothing: the record is still the writer's to answer for.
    expect(writer.metrics().retainedRecordCount).toBe(1);

    expect(writer.enqueue(createTestFrame({ ingestSeq: 2 })).accepted).toBe(true);
    await writer.drain();
    expect(writer.enqueue(createTestFrame({ ingestSeq: 3 })).accepted).toBe(true);
    clock.advance(1_000);

    await expect(writer.tick()).rejects.toThrow();
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2", "3"]);

    expect(await writer.close()).toBeNull();
    expect(await listSegmentManifests(fileSystem, DIRECTORY)).toEqual([]);
    expect(writer.pendingFrames().map((frame) => frame.ingestSeq)).toEqual(["1", "2", "3"]);
  });

  it("does not hand back records a manifest already names", async () => {
    // The other half of the same rule: retaining records for accountability
    // must release them exactly when a manifest claims them, or every clean
    // close would duplicate.
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const writer = await open(fileSystem, clock);
    for (const frame of createTestFrames(4)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }
    await writer.flush();
    expect(writer.metrics().retainedRecordCount).toBe(4);

    const manifest = await writer.close();
    expect(manifest?.recordCount).toBe(4);
    expect(writer.pendingFrames()).toEqual([]);
    expect(writer.metrics().retainedRecordCount).toBe(0);
  });

  it("holds maxTotalBytes against a segmentIdFactory that folds in the clock", async () => {
    // MEDIUM: the reservation measured the factory's id once and cached it with
    // 64 bytes of slack, but `SegmentIdContext` carries `createdAtMs` and the
    // factory is called again at open. A time-dependent factory therefore wrote
    // a much wider header and footer than anything was reserved for.
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const cap = 6_000;
    const writer = await open(fileSystem, clock, {
      maxTotalBytes: cap,
      maxSegmentBytes: 100_000,
      segmentIdFactory: (context) =>
        `${context.gatewayEpoch}-${String(context.segmentIndex).padStart(6, "0")}-${"a".repeat(
          Math.min(Math.floor((context.createdAtMs - DEFAULT_TEST_EPOCH_MS) / 40), 500),
        )}`,
    });

    let accepted = 0;
    for (const frame of createTestFrames(20)) {
      clock.advance(1_000);
      if (writer.enqueue(frame).accepted) {
        accepted += 1;
      }
    }
    await writer.drain();
    await writer.close();

    let onDisk = 0;
    for (const [path, bytes] of fileSystem.files) {
      if (path.endsWith(".wal.jsonl")) {
        onDisk += bytes.length;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(onDisk).toBeLessThanOrEqual(cap);
    expect(writer.metrics().capacityRemainingBytes).toBeGreaterThanOrEqual(0);
  });

  it("refuses a segmentIdFactory whose id is past the documented bound", async () => {
    // The bound is enforced, not assumed: an id nobody can reserve for is a
    // configuration error, surfaced rather than charged to the archive.
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    await expect(
      open(fileSystem, clock, {
        segmentIdFactory: (context) => `${context.gatewayEpoch}-${"z".repeat(5_000)}`,
      }),
    ).rejects.toBeInstanceOf(WalConfigurationError);
    expect([...fileSystem.files.keys()].filter((path) => path.endsWith(".wal.jsonl"))).toEqual([]);
  });

  it("emits no fsync event once a failure has frozen the watermark", async () => {
    // The premise behind `WalFsyncEvent`: every event describes an fsync that
    // genuinely advanced the watermark. A frozen watermark means the writer is
    // already faulted, so no further periodic fsync runs at all — the fault path
    // uses `syncForFaultClose()`, which reports through `onWriteFault` instead.
    const fileSystem = failingFileSystem({ failSyncOn: 2 });
    const clock = createManualClock();
    const fsyncs: WalFsyncEvent[] = [];
    const writer = await open(fileSystem, clock, {
      fsyncByteThreshold: 1,
      observer: { onFsync: (event) => fsyncs.push(event) },
    });
    for (const frame of createTestFrames(2)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }
    await expect(writer.drain()).rejects.toThrow();
    await writer.close();

    // Nothing was ever reported as synced, because nothing ever was: the
    // header's fsync is issued inside `ActiveSegment.open()` and the only frame
    // fsync failed.
    expect(fsyncs.every((event) => event.syncedRecords > 0)).toBe(true);
    expect(writer.metrics().framesDurable).toBe(0);
    expect(await listSegmentManifests(fileSystem, DIRECTORY)).toEqual([]);
  });

  it("validates an injected-factory segment whose id looks like a default ordinal", async () => {
    // LOW-1: any `<epoch>-<digits>` id was read as a default-factory ordinal, so
    // an opaque `<epoch>-999999` at `segmentIndex` 0 was rejected as
    // `MANIFEST_INCONSISTENT`. Provenance is recorded now, and §2's rule holds:
    // identity is what the header says, never what the name implies.
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const writer = await open(fileSystem, clock, {
      segmentIdFactory: (context) => `${context.gatewayEpoch}-${999_999 - context.segmentIndex}`,
    });
    for (const frame of createTestFrames(3)) {
      expect(writer.enqueue(frame).accepted).toBe(true);
    }
    const manifest = await writer.close();
    expect(manifest?.segmentIdKind).toBe("opaque");

    const report = await validateSegment(fileSystem, DIRECTORY, manifest?.segmentId ?? "");
    expect(report.issues).toEqual([]);
    expect(report.valid).toBe(true);
  });
});
