import { describe, expect, it } from "vitest";

import {
  buildSegmentFixture,
  manualClock,
  memoryFileSystem,
  memoryObjectStore,
  recordingRetention,
} from "@polymarket-bot/storage-parquet/testing";
import type { MemoryFileSystem } from "@polymarket-bot/storage-parquet/testing";
import { retainAllWalSegments } from "@polymarket-bot/storage-parquet";

import type { ResearchWorkerConfig } from "./config.js";
import { MetricsRecorder } from "./metrics.js";
import { datasetIdForCycle, runCompactionCycle, runResearchWorker } from "./worker.js";
import type { ResearchWorkerDependencies } from "./worker.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";
const WAL_DIR = "/wal";

function config(overrides: Partial<ResearchWorkerConfig> = {}): ResearchWorkerConfig {
  return {
    walDirectoryPath: WAL_DIR,
    objectStoreRoot: "/objects",
    datasetKeyPrefix: "datasets",
    datasetIdPrefix: "ds",
    intervalMs: 1_000,
    retention: "retain",
    incidentWindowsPath: null,
    normalizerVersion: null,
    codec: "UNCOMPRESSED",
    rowGroupSize: 1_000,
    runOnce: true,
    ...overrides,
  };
}

function seed(fileSystem: MemoryFileSystem, segmentIndex: number, ingestSeq: string): string {
  const fixture = buildSegmentFixture({
    gatewayEpoch: EPOCH,
    segmentIndex,
    frames: [{ ingestSeq, payloadUtf8: `{"n":${ingestSeq}}` }],
  });
  fileSystem.write(WAL_DIR, fixture.segmentFileName, fixture.segmentBytes);
  fileSystem.write(WAL_DIR, fixture.manifestFileName, fixture.manifestBytes);
  return fixture.segmentId;
}

function dependencies(
  overrides: Partial<ResearchWorkerDependencies> = {},
): ResearchWorkerDependencies {
  const fileSystem = overrides.fileSystem ?? memoryFileSystem();
  return {
    config: config(),
    objectStore: memoryObjectStore(),
    fileSystem,
    clock: manualClock(),
    retention: retainAllWalSegments(),
    incidentWindows: [],
    sleep: async () => {
      // No waiting in tests; the loop's abort behaviour is exercised directly.
    },
    ...overrides,
  };
}

describe("datasetIdForCycle", () => {
  it("produces an object-key-safe id from the wall clock", () => {
    const id = datasetIdForCycle("ds", Date.parse("2026-01-01T00:00:00.000Z"));
    expect(id).toBe("ds-2026-01-01T00-00-00-000Z");
    expect(id).not.toMatch(/[:.]/u);
  });
});

describe("runCompactionCycle", () => {
  it("compacts what is there and records the metrics §14.3 asks for", async () => {
    const fileSystem = memoryFileSystem();
    seed(fileSystem, 0, "1");
    seed(fileSystem, 1, "2");
    const metrics = new MetricsRecorder();

    const outcome = await runCompactionCycle(dependencies({ fileSystem }), metrics);

    expect(outcome.status).toBe("compacted");
    const snapshot = metrics.snapshot();
    expect(snapshot.cyclesStarted).toBe(1);
    expect(snapshot.cyclesSucceeded).toBe(1);
    expect(snapshot.objectUploadStatus).toBe("succeeded");
    expect(snapshot.lastCycleSegmentsCompacted).toBe(2);
    expect(snapshot.lastCycleRowsWritten).toBe(2);
    expect(snapshot.lastCycleObjectBytes).toBeGreaterThan(0);
    expect(snapshot.compactionLagMs).toBeNull();
  });

  it("reports an empty WAL directory as idle, with a manifest that says so", async () => {
    const metrics = new MetricsRecorder();
    const outcome = await runCompactionCycle(dependencies(), metrics);
    expect(outcome.status).toBe("idle");
    if (outcome.status === "failed") return;
    expect(outcome.result.manifest.segments).toStrictEqual([]);
    expect(outcome.result.manifest.recordCounts.written).toBe(0);
  });

  it("records a failure without throwing, and keeps the last good counters", async () => {
    const fileSystem = memoryFileSystem();
    seed(fileSystem, 0, "1");
    const metrics = new MetricsRecorder();
    await runCompactionCycle(dependencies({ fileSystem }), metrics);

    const exploding = dependencies({
      fileSystem,
      objectStore: {
        async put() {
          throw new Error("object store is down");
        },
        async head() {
          return null;
        },
        async get(): Promise<Uint8Array> {
          throw new Error("object store is down");
        },
      },
    });
    const outcome = await runCompactionCycle(exploding, metrics);

    expect(outcome.status).toBe("failed");
    const snapshot = metrics.snapshot();
    expect(snapshot.cyclesFailed).toBe(1);
    expect(snapshot.objectUploadStatus).toBe("failed");
    expect(snapshot.lastFailureReason).toBe("object store is down");
    // The previous cycle's numbers survive: a failed cycle must not look like a
    // successful empty one.
    expect(snapshot.lastCycleRowsWritten).toBe(1);
  });

  it("leaves the WAL untouched when a cycle fails", async () => {
    const fileSystem = memoryFileSystem();
    const segmentId = seed(fileSystem, 0, "1");
    const objectStore = memoryObjectStore();
    const retention = recordingRetention({ fileSystem, walDirectoryPath: WAL_DIR, objectStore });
    const metrics = new MetricsRecorder();

    const outcome = await runCompactionCycle(
      dependencies({
        fileSystem,
        retention,
        objectStore: {
          ...objectStore,
          async put(key: string, bytes: Uint8Array) {
            await objectStore.put(key, bytes);
            objectStore.forget(key);
          },
        },
      }),
      metrics,
    );

    expect(outcome.status).toBe("failed");
    expect(retention.requests).toStrictEqual([]);
    expect(fileSystem.list(WAL_DIR)).toContain(`${segmentId}.wal.jsonl`);
  });

  it("pins a supplied normalizer version and leaves the rest explicitly null", async () => {
    const fileSystem = memoryFileSystem();
    seed(fileSystem, 0, "1");
    const outcome = await runCompactionCycle(
      dependencies({ fileSystem, config: config({ normalizerVersion: "norm-9" }) }),
      new MetricsRecorder(),
    );
    if (outcome.status === "failed") throw new Error(outcome.reason);
    expect(outcome.result.manifest.replayPins.normalizerVersion).toBe("norm-9");
    expect(outcome.result.manifest.replayPins.runSeed).toBeNull();
  });

  it("emits one JSON summary line per cycle", async () => {
    const fileSystem = memoryFileSystem();
    seed(fileSystem, 0, "1");
    const lines: string[] = [];
    await runCompactionCycle(
      dependencies({ fileSystem, report: (line) => lines.push(line) }),
      new MetricsRecorder(),
    );
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed["event"]).toBe("compaction-cycle");
    expect(parsed["manifestSha256"]).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("runResearchWorker", () => {
  it("runs exactly one cycle when runOnce is set", async () => {
    const fileSystem = memoryFileSystem();
    seed(fileSystem, 0, "1");
    const result = await runResearchWorker(
      dependencies({ fileSystem }),
      new AbortController().signal,
    );
    expect(result.cycles).toBe(1);
    expect(result.metrics.cyclesSucceeded).toBe(1);
  });

  it("does not start a cycle when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runResearchWorker(dependencies(), controller.signal);
    expect(result.cycles).toBe(0);
    expect(result.metrics.cyclesStarted).toBe(0);
  });

  it("loops until aborted, finishing the cycle in flight", async () => {
    const fileSystem = memoryFileSystem();
    seed(fileSystem, 0, "1");
    const controller = new AbortController();
    let sleeps = 0;

    const result = await runResearchWorker(
      dependencies({
        fileSystem,
        config: config({ runOnce: false }),
        // The clock does not advance, so every cycle produces the identical
        // dataset id and identical bytes — which the object store accepts as a
        // no-op. That is the idempotence property, exercised for free here.
        sleep: async () => {
          sleeps += 1;
          if (sleeps >= 3) {
            controller.abort();
          }
        },
      }),
      controller.signal,
    );

    expect(result.cycles).toBe(3);
    expect(result.metrics.cyclesStarted).toBe(3);
  });
});
