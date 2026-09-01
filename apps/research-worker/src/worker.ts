/**
 * The research worker's scheduling loop.
 *
 * Handoff §4.1: `apps/research-worker` "Compacts WAL segments, creates Parquet
 * manifests, computes offline metrics, and runs Python research jobs." This
 * work package delivers the first two; the offline metrics and the Python jobs
 * belong to later packages, and this loop is the process they will attach to.
 *
 * Three properties the loop is built around:
 *
 * - **A failed cycle changes nothing.** Compaction either produces a verified
 *   dataset or throws, and it never deletes before verifying, so a crash loop
 *   costs disk space and no data (ADR-004, Consequences). The loop therefore
 *   records the failure and tries again rather than exiting.
 * - **Shutdown finishes the cycle in flight.** `SIGTERM` during a compaction
 *   run must not leave a half-uploaded dataset with no manifest, so the signal
 *   sets a flag and the loop stops at the next boundary. A second signal is the
 *   operator's escalation and is left to the platform.
 * - **Nothing is ambient.** Clock, filesystem, object store and retention all
 *   arrive as ports, so the loop is testable without a disk or a wall clock.
 */

import type {
  CompactionClock,
  CompactionFileSystem,
  CompactionObserver,
  CompactionResult,
  IncidentWindow,
  ObjectStore,
  WalSegmentRetention,
} from "@polymarket-bot/storage-parquet";
import { compactWalDirectory } from "@polymarket-bot/storage-parquet";

import type { ResearchWorkerConfig } from "./config.js";
import { MetricsRecorder } from "./metrics.js";
import type { ResearchWorkerMetrics } from "./metrics.js";

/** Everything the loop needs that it does not construct itself. */
export type ResearchWorkerDependencies = {
  readonly config: ResearchWorkerConfig;
  readonly objectStore: ObjectStore;
  readonly fileSystem: CompactionFileSystem;
  readonly clock: CompactionClock;
  readonly retention: WalSegmentRetention;
  readonly incidentWindows: readonly IncidentWindow[];
  readonly observer?: CompactionObserver;
  /** Sleep between cycles. Injected so a test does not wait. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Where a cycle summary goes. Defaults to nothing. */
  readonly report?: (line: string) => void;
};

/**
 * One cycle's outcome, as the loop saw it.
 *
 * `idle` still carries a result: a cycle that found no segments wrote a
 * manifest describing an empty dataset, which is a truthful statement ("these
 * were the segments, and there were none") and not an absence of work.
 */
export type CycleOutcome =
  | { readonly status: "compacted" | "idle"; readonly result: CompactionResult }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Dataset identity for one cycle.
 *
 * Derived from the wall clock, because a dataset produced at a moment is what a
 * cycle is; the compactor itself never reads a clock for identity (§12.4). The
 * colons and dots an ISO instant carries are replaced so the id is safe in an
 * object key on every store.
 */
export function datasetIdForCycle(prefix: string, nowMs: number): string {
  const instant = new Date(nowMs).toISOString().replace(/[:.]/gu, "-");
  return `${prefix}-${instant}`;
}

/** Run exactly one compaction cycle. */
export async function runCompactionCycle(
  dependencies: ResearchWorkerDependencies,
  metrics: MetricsRecorder,
): Promise<CycleOutcome> {
  const { config, clock } = dependencies;
  metrics.cycleStarted();
  const startedMs = clock.monotonicMs();

  try {
    const datasetId = datasetIdForCycle(config.datasetIdPrefix, clock.nowMs());
    const result = await compactWalDirectory({
      walDirectoryPath: config.walDirectoryPath,
      datasetId,
      objectKeyPrefix: `${config.datasetKeyPrefix}/${datasetId}`,
      objectStore: dependencies.objectStore,
      fileSystem: dependencies.fileSystem,
      clock,
      retention: dependencies.retention,
      incidentWindows: dependencies.incidentWindows,
      codec: config.codec,
      rowGroupSize: config.rowGroupSize,
      ...(config.normalizerVersion === null
        ? {}
        : { replayPins: { normalizerVersion: config.normalizerVersion } }),
      ...(dependencies.observer === undefined ? {} : { observer: dependencies.observer }),
    });

    metrics.cycleSucceeded({
      segmentsCompacted: result.verifiedSegmentIds.length,
      segmentsRefused: result.refusedSegments.length,
      rowsWritten: result.rowsWritten,
      objectBytes: result.objectBytesUploaded,
      segmentsDeleted: result.deletedSegmentIds.length,
      retentionFailures: result.retentionFailures.length,
      durationMs: result.durationMs,
      compactionLagMs: result.compactionLagMs,
    });

    dependencies.report?.(
      JSON.stringify({
        event: "compaction-cycle",
        datasetId: result.datasetId,
        manifestObjectKey: result.manifestObjectKey,
        manifestSha256: result.manifestSha256,
        segmentsCompacted: result.verifiedSegmentIds.length,
        segmentsRefused: result.refusedSegments.length,
        rowsWritten: result.rowsWritten,
        replayEligibleRows: result.replayEligibleRows,
        segmentsDeleted: result.deletedSegmentIds.length,
        retentionFailures: result.retentionFailures,
        objectBytesUploaded: result.objectBytesUploaded,
        compactionLagMs: result.compactionLagMs,
        durationMs: result.durationMs,
      }),
    );

    const foundNothing =
      result.verifiedSegmentIds.length === 0 && result.refusedSegments.length === 0;
    return { status: foundNothing ? "idle" : "compacted", result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    metrics.cycleFailed(reason, clock.monotonicMs() - startedMs);
    dependencies.report?.(JSON.stringify({ event: "compaction-cycle-failed", reason }));
    return { status: "failed", reason };
  }
}

export type ResearchWorkerRunResult = {
  readonly cycles: number;
  readonly metrics: ResearchWorkerMetrics;
};

/**
 * Run the loop until the abort signal fires, or once when `runOnce` is set.
 *
 * The signal is checked at cycle boundaries only: a compaction run in flight
 * completes, because aborting between an upload and its manifest write is
 * exactly the state ADR-004 §5's ordering exists to avoid.
 */
export async function runResearchWorker(
  dependencies: ResearchWorkerDependencies,
  signal: AbortSignal,
): Promise<ResearchWorkerRunResult> {
  const metrics = new MetricsRecorder();
  let cycles = 0;

  for (;;) {
    if (signal.aborted) {
      break;
    }
    await runCompactionCycle(dependencies, metrics);
    cycles += 1;

    if (dependencies.config.runOnce || signal.aborted) {
      break;
    }
    try {
      await dependencies.sleep(dependencies.config.intervalMs, signal);
    } catch {
      // An aborted sleep is a shutdown request, not a failure.
      break;
    }
  }

  return { cycles, metrics: metrics.snapshot() };
}

/** A sleep that resolves early when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
