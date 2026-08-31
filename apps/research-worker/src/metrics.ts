/**
 * The worker's metric snapshot.
 *
 * Handoff §14.3's recorder family ends with two entries this work package owns:
 * **compaction lag** and **object upload status**. Both are here, as typed
 * values rather than as formatted strings, so a later exporter (`WP-140`) reads
 * numbers instead of parsing a log line.
 *
 * Two of them deserve their definition spelled out, because a metric whose
 * meaning is ambiguous is worse than no metric:
 *
 * - `compactionLagMs` is the age of the **oldest segment a cycle left
 *   behind** — refused, and therefore still waiting. `null` means nothing was
 *   left behind, which is not the same as zero lag and is not reported as zero.
 * - `objectUploadStatus` is the outcome of the **last completed cycle**, not a
 *   running tally. A cycle that threw reports `failed` with the reason.
 */

export type ObjectUploadStatus = "idle" | "succeeded" | "failed";

export type ResearchWorkerMetrics = {
  /** Compaction cycles started since the process began. */
  readonly cyclesStarted: number;
  /** Cycles that completed without throwing. */
  readonly cyclesSucceeded: number;
  /** Cycles that threw. The WAL is untouched by a failed cycle. */
  readonly cyclesFailed: number;
  /** §14.3 "object upload status" for the most recent completed cycle. */
  readonly objectUploadStatus: ObjectUploadStatus;
  /** Why the last cycle failed, when it did. */
  readonly lastFailureReason: string | null;
  /** §14.3 "compaction lag". `null` when the last cycle left nothing behind. */
  readonly compactionLagMs: number | null;
  /** Segments verified and compacted by the last cycle. */
  readonly lastCycleSegmentsCompacted: number;
  /** Segments the last cycle refused, and therefore excluded. */
  readonly lastCycleSegmentsRefused: number;
  /** Rows written by the last cycle. */
  readonly lastCycleRowsWritten: number;
  /** Object bytes uploaded and verified by the last cycle. */
  readonly lastCycleObjectBytes: number;
  /** WAL segments deleted by the last cycle, after verification. */
  readonly lastCycleSegmentsDeleted: number;
  /** Segments whose deletion failed. A disk-space problem, not a data one. */
  readonly lastCycleRetentionFailures: number;
  /** Duration of the last cycle, in milliseconds. */
  readonly lastCycleDurationMs: number;
  /** Cumulative totals across the process's lifetime. */
  readonly totalSegmentsCompacted: number;
  readonly totalRowsWritten: number;
  readonly totalObjectBytes: number;
  readonly totalSegmentsDeleted: number;
};

/** Mutable accumulator behind {@link ResearchWorkerMetrics}. */
export class MetricsRecorder {
  #cyclesStarted = 0;
  #cyclesSucceeded = 0;
  #cyclesFailed = 0;
  #objectUploadStatus: ObjectUploadStatus = "idle";
  #lastFailureReason: string | null = null;
  #compactionLagMs: number | null = null;
  #lastCycleSegmentsCompacted = 0;
  #lastCycleSegmentsRefused = 0;
  #lastCycleRowsWritten = 0;
  #lastCycleObjectBytes = 0;
  #lastCycleSegmentsDeleted = 0;
  #lastCycleRetentionFailures = 0;
  #lastCycleDurationMs = 0;
  #totalSegmentsCompacted = 0;
  #totalRowsWritten = 0;
  #totalObjectBytes = 0;
  #totalSegmentsDeleted = 0;

  cycleStarted(): void {
    this.#cyclesStarted += 1;
  }

  cycleSucceeded(outcome: {
    readonly segmentsCompacted: number;
    readonly segmentsRefused: number;
    readonly rowsWritten: number;
    readonly objectBytes: number;
    readonly segmentsDeleted: number;
    readonly retentionFailures: number;
    readonly durationMs: number;
    readonly compactionLagMs: number | null;
  }): void {
    this.#cyclesSucceeded += 1;
    this.#objectUploadStatus = "succeeded";
    this.#lastFailureReason = null;
    this.#compactionLagMs = outcome.compactionLagMs;
    this.#lastCycleSegmentsCompacted = outcome.segmentsCompacted;
    this.#lastCycleSegmentsRefused = outcome.segmentsRefused;
    this.#lastCycleRowsWritten = outcome.rowsWritten;
    this.#lastCycleObjectBytes = outcome.objectBytes;
    this.#lastCycleSegmentsDeleted = outcome.segmentsDeleted;
    this.#lastCycleRetentionFailures = outcome.retentionFailures;
    this.#lastCycleDurationMs = outcome.durationMs;
    this.#totalSegmentsCompacted += outcome.segmentsCompacted;
    this.#totalRowsWritten += outcome.rowsWritten;
    this.#totalObjectBytes += outcome.objectBytes;
    this.#totalSegmentsDeleted += outcome.segmentsDeleted;
  }

  cycleFailed(reason: string, durationMs: number): void {
    this.#cyclesFailed += 1;
    this.#objectUploadStatus = "failed";
    this.#lastFailureReason = reason;
    this.#lastCycleDurationMs = durationMs;
    // Deliberately does not reset the per-cycle counters: they describe the
    // last cycle that produced anything, and zeroing them would make a failed
    // cycle look like a successful empty one on a dashboard.
  }

  snapshot(): ResearchWorkerMetrics {
    return {
      cyclesStarted: this.#cyclesStarted,
      cyclesSucceeded: this.#cyclesSucceeded,
      cyclesFailed: this.#cyclesFailed,
      objectUploadStatus: this.#objectUploadStatus,
      lastFailureReason: this.#lastFailureReason,
      compactionLagMs: this.#compactionLagMs,
      lastCycleSegmentsCompacted: this.#lastCycleSegmentsCompacted,
      lastCycleSegmentsRefused: this.#lastCycleSegmentsRefused,
      lastCycleRowsWritten: this.#lastCycleRowsWritten,
      lastCycleObjectBytes: this.#lastCycleObjectBytes,
      lastCycleSegmentsDeleted: this.#lastCycleSegmentsDeleted,
      lastCycleRetentionFailures: this.#lastCycleRetentionFailures,
      lastCycleDurationMs: this.#lastCycleDurationMs,
      totalSegmentsCompacted: this.#totalSegmentsCompacted,
      totalRowsWritten: this.#totalRowsWritten,
      totalObjectBytes: this.#totalObjectBytes,
      totalSegmentsDeleted: this.#totalSegmentsDeleted,
    };
  }
}
