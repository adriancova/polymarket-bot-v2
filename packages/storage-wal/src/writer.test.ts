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
import { createManualClock } from "./testing/manual-clock.js";
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
    const { fileSystem, writer } = await openHarness({ maxTotalBytes: 800 });
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
