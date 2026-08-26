/**
 * The WAL writer: bounded ingestion, append-only segments, rotation by size and
 * time, periodic fsync, and a fault path that loses nothing.
 *
 * Two design choices are worth stating up front because they are not obvious:
 *
 * - **No timers.** The writer never schedules work. `drain`, `tick`, `flush`,
 *   `rotate`, and `close` are called by the owning process (`WP-120`), so the
 *   sequence of writes is a function of the calls and the injected clock, not of
 *   the event loop. That is what makes the fsync-interval and rotation-by-time
 *   behavior testable and replayable (§12.4).
 * - **Refuse, never drop.** `enqueue` returns a refusal when a bound is reached;
 *   the frame stays with the caller (§8.3, ADR-004 §4). A write fault does not
 *   discard the frames in flight either — they stay in `pendingFrames()`.
 */

import { isoFromEpochMs } from "./clock.js";
import {
  DEFAULT_FSYNC_BYTE_THRESHOLD,
  DEFAULT_FSYNC_INTERVAL_MS,
  DEFAULT_MAX_SEGMENT_AGE_MS,
  DEFAULT_MAX_SEGMENT_BYTES,
  DEFAULT_QUEUE_CAPACITY,
  DEFAULT_QUEUE_MAX_BYTES,
  WAL_FORMAT_ID,
  WAL_MANIFEST_VERSION,
  WAL_SCHEMA_VERSION,
} from "./constants.js";
import {
  WalConfigurationError,
  WalRecordValidationError,
  WalWriteFaultError,
  WalWriterStateError,
} from "./errors.js";
import {
  defaultSegmentIdFactory,
  listSegmentManifests,
  segmentFileName,
  writeSegmentManifest,
} from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import type {
  SegmentIdFactory,
  WalClock,
  WalCloseReason,
  WalEnqueueResult,
  WalFileSystem,
  WalRefusalReason,
  WalWriterObserver,
} from "./ports.js";
import { BoundedRawFrameQueue } from "./queue.js";
import type { QueuedFrame, WalQueueMetrics } from "./queue.js";
import {
  assertPayloadDigest,
  compareIngestSeq,
  parseRawFrameRecord,
} from "./raw-frame.js";
import type { RawFrameRecord } from "./raw-frame.js";
import { scanSegment } from "./reader.js";
import { recoverWalDirectory } from "./recovery.js";
import type { WalRecoveryReport } from "./recovery.js";
import { buildSegmentHeader, encodeFrameLine } from "./segment-format.js";
import { ActiveSegment } from "./segment-writer.js";

export type WalWriterState = "open" | "faulted" | "closed";

export type WalWriterOptions = {
  readonly directoryPath: string;
  /** §7.1 gateway epoch. Every frame this writer accepts must carry it. */
  readonly gatewayEpoch: string;
  readonly fileSystem: WalFileSystem;
  readonly clock: WalClock;
  readonly queueCapacity?: number;
  readonly queueMaxBytes?: number;
  /** Rotate once the active segment reaches this size (§9.1). */
  readonly maxSegmentBytes?: number;
  /** Rotate once the active segment reaches this age (§9.1). */
  readonly maxSegmentAgeMs?: number;
  /**
   * Periodic fsync interval. **This is the published data-loss bound**
   * (ADR-004 §3): a host power loss can lose at most the frames written since
   * the last successful fsync.
   */
  readonly fsyncIntervalMs?: number;
  /** Periodic fsync byte threshold; whichever bound trips first wins. */
  readonly fsyncByteThreshold?: number;
  /**
   * Hard WAL capacity threshold in bytes (§4.2). `null` disables it.
   *
   * Reaching it refuses new frames — it never overwrites or deletes. That is
   * the intended failure direction (ADR-004, Consequences).
   */
  readonly maxTotalBytes?: number | null;
  readonly segmentIdFactory?: SegmentIdFactory;
  readonly observer?: WalWriterObserver;
  /** Verify `payloadSha256` against `payloadUtf8` on enqueue. Default `true`. */
  readonly verifyPayloadDigest?: boolean;
  readonly recoveryChunkBytes?: number;
  readonly recoveryMaxRecordBytes?: number;
};

export type WalDrainResult = {
  readonly framesWritten: number;
  readonly bytesWritten: number;
  readonly rotations: number;
  readonly fsyncs: number;
};

export type WalWriterMetrics = {
  readonly state: WalWriterState;
  readonly queue: WalQueueMetrics;
  readonly activeSegmentId: string | null;
  readonly activeSegmentRecordCount: number;
  readonly activeSegmentByteLength: number;
  /** §14.3 "segment age". `null` when no segment is open. */
  readonly activeSegmentAgeMs: number | null;
  readonly segmentsOpened: number;
  readonly segmentsFinalized: number;
  readonly rotations: number;
  readonly framesAccepted: number;
  readonly framesWritten: number;
  /** Frames known to have reached durable storage (post-fsync). */
  readonly framesDurable: number;
  /** §14.3 "bytes written". */
  readonly bytesWritten: number;
  readonly bytesUnsynced: number;
  readonly recordsUnsynced: number;
  readonly fsyncCount: number;
  /** §14.3 "fsync latency": total and last observed, in milliseconds. */
  readonly lastFsyncDurationMs: number | null;
  readonly totalFsyncDurationMs: number;
  readonly msSinceLastFsync: number | null;
  /** The configured fsync interval, restated as what it is: a data-loss bound. */
  readonly dataLossBoundMs: number;
  readonly totalSegmentBytes: number;
  readonly capacityBytes: number | null;
  readonly capacityRemainingBytes: number | null;
  readonly overflowSignals: number;
  readonly capacityRefusals: number;
  readonly closedRefusals: number;
  readonly faultedRefusals: number;
  readonly validationRejections: number;
  readonly writeFaults: number;
  readonly nonMonotonicIngestSeqCount: number;
  readonly pendingFrameCount: number;
};

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WalConfigurationError(`${name} must be a positive safe integer`, { [name]: value });
  }
  return value;
}

/**
 * Open a WAL writer on a directory, recovering it first.
 *
 * Recovery runs before the first byte is written (§9.1: "Recovery truncates
 * only an incomplete final record"). A segment that recovery found corrupt does
 * **not** stop the writer — §4.2 forbids letting a storage problem stop the
 * recorder — but it is reported in `writer.recovery` and through
 * `observer.onRecovery`, and the caller is expected to open a data-quality
 * incident.
 */
export async function openWalWriter(options: WalWriterOptions): Promise<WalWriter> {
  if (typeof options.gatewayEpoch !== "string" || options.gatewayEpoch.length === 0) {
    throw new WalConfigurationError("gatewayEpoch is required");
  }
  const queueCapacity = requirePositiveInteger(
    options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY,
    "queueCapacity",
  );
  const queueMaxBytes = requirePositiveInteger(
    options.queueMaxBytes ?? DEFAULT_QUEUE_MAX_BYTES,
    "queueMaxBytes",
  );
  const maxSegmentBytes = requirePositiveInteger(
    options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES,
    "maxSegmentBytes",
  );
  const maxSegmentAgeMs = requirePositiveInteger(
    options.maxSegmentAgeMs ?? DEFAULT_MAX_SEGMENT_AGE_MS,
    "maxSegmentAgeMs",
  );
  const fsyncIntervalMs = requirePositiveInteger(
    options.fsyncIntervalMs ?? DEFAULT_FSYNC_INTERVAL_MS,
    "fsyncIntervalMs",
  );
  const fsyncByteThreshold = requirePositiveInteger(
    options.fsyncByteThreshold ?? DEFAULT_FSYNC_BYTE_THRESHOLD,
    "fsyncByteThreshold",
  );
  const maxTotalBytes = options.maxTotalBytes ?? null;
  if (maxTotalBytes !== null) {
    requirePositiveInteger(maxTotalBytes, "maxTotalBytes");
  }

  const recovery = await recoverWalDirectory(options.fileSystem, options.directoryPath, {
    clock: options.clock,
    ...(options.recoveryChunkBytes === undefined
      ? {}
      : { chunkBytes: options.recoveryChunkBytes }),
    ...(options.recoveryMaxRecordBytes === undefined
      ? {}
      : { maxRecordBytes: options.recoveryMaxRecordBytes }),
  });
  options.observer?.onRecovery?.(recovery);

  return new WalWriter({
    directoryPath: options.directoryPath,
    gatewayEpoch: options.gatewayEpoch,
    fileSystem: options.fileSystem,
    clock: options.clock,
    queueCapacity,
    queueMaxBytes,
    maxSegmentBytes,
    maxSegmentAgeMs,
    fsyncIntervalMs,
    fsyncByteThreshold,
    maxTotalBytes,
    segmentIdFactory: options.segmentIdFactory ?? defaultSegmentIdFactory,
    observer: options.observer ?? {},
    verifyPayloadDigest: options.verifyPayloadDigest ?? true,
    recovery,
  });
}

type ResolvedWriterOptions = {
  readonly directoryPath: string;
  readonly gatewayEpoch: string;
  readonly fileSystem: WalFileSystem;
  readonly clock: WalClock;
  readonly queueCapacity: number;
  readonly queueMaxBytes: number;
  readonly maxSegmentBytes: number;
  readonly maxSegmentAgeMs: number;
  readonly fsyncIntervalMs: number;
  readonly fsyncByteThreshold: number;
  readonly maxTotalBytes: number | null;
  readonly segmentIdFactory: SegmentIdFactory;
  readonly observer: WalWriterObserver;
  readonly verifyPayloadDigest: boolean;
  readonly recovery: WalRecoveryReport;
};

export class WalWriter {
  readonly #options: ResolvedWriterOptions;
  readonly #queue: BoundedRawFrameQueue;
  readonly recovery: WalRecoveryReport;

  #state: WalWriterState = "open";
  #active: ActiveSegment | null = null;
  #nextSegmentIndex: number;
  #draining = false;
  #pending: QueuedFrame[] = [];
  #failedBatchSize = 0;
  #recordCountBeforeFailedBatch = 0;
  #faultReconciled = false;
  #faultTruncatedTailBytes = 0;

  #segmentsOpened = 0;
  #segmentsFinalized = 0;
  #rotations = 0;
  #framesAccepted = 0;
  #framesWritten = 0;
  #framesDurable = 0;
  #bytesWritten = 0;
  #fsyncCount = 0;
  #totalFsyncDurationMs = 0;
  #lastFsyncDurationMs: number | null = null;
  #lastFsyncMonotonicMs: number | null = null;
  #totalSegmentBytes: number;
  #overflowSignals = 0;
  #capacityRefusals = 0;
  #closedRefusals = 0;
  #faultedRefusals = 0;
  #validationRejections = 0;
  #writeFaults = 0;
  #nonMonotonicIngestSeqCount = 0;
  #lastIngestSeq: string | null = null;

  /**
   * Internal. `ResolvedWriterOptions` is deliberately not exported, so the only
   * way to obtain a writer is {@link openWalWriter} — which recovers the
   * directory first. A writer that skipped recovery could append to a segment
   * with an incomplete final record.
   */
  constructor(options: ResolvedWriterOptions) {
    this.#options = options;
    this.#queue = new BoundedRawFrameQueue({
      capacity: options.queueCapacity,
      maxBytes: options.queueMaxBytes,
    });
    this.recovery = options.recovery;
    this.#nextSegmentIndex = options.recovery.nextSegmentIndex;
    this.#totalSegmentBytes = options.recovery.totalSegmentBytes;
  }

  get state(): WalWriterState {
    return this.#state;
  }

  get directoryPath(): string {
    return this.#options.directoryPath;
  }

  get gatewayEpoch(): string {
    return this.#options.gatewayEpoch;
  }

  /** The active segment's id, or `null` when none is open. */
  get activeSegmentId(): string | null {
    return this.#active?.segmentId ?? null;
  }

  /**
   * Offer one exact raw frame.
   *
   * Throws {@link WalRecordValidationError} for a malformed record — a caller
   * bug, surfaced rather than recorded. Returns a refusal when a bound is
   * reached: the frame is still the caller's, and nothing has been dropped.
   */
  enqueue(record: RawFrameRecord): WalEnqueueResult {
    const nowMs = this.#options.clock.nowMs();
    if (this.#state === "closed") {
      this.#closedRefusals += 1;
      return this.#refuse(record, "writer-closed", "the WAL writer is closed", nowMs);
    }
    if (this.#state === "faulted") {
      this.#faultedRefusals += 1;
      return this.#refuse(
        record,
        "writer-faulted",
        "a previous WAL append failed; the writer must be closed and reopened",
        nowMs,
      );
    }

    let parsed: RawFrameRecord;
    try {
      parsed = parseRawFrameRecord(record);
      if (parsed.gatewayEpoch !== this.#options.gatewayEpoch) {
        throw new WalRecordValidationError(
          "raw frame gatewayEpoch does not match the writer's gateway epoch",
          { declared: parsed.gatewayEpoch, expected: this.#options.gatewayEpoch },
        );
      }
      if (this.#options.verifyPayloadDigest) {
        assertPayloadDigest(parsed);
      }
    } catch (error) {
      this.#validationRejections += 1;
      throw error;
    }

    const bytes = encodeFrameLine(parsed);

    const capacity = this.#options.maxTotalBytes;
    if (capacity !== null) {
      const projected = this.#totalSegmentBytes + this.#queue.byteDepth + bytes.length;
      if (projected > capacity) {
        this.#capacityRefusals += 1;
        return this.#refuse(
          parsed,
          "capacity-exceeded",
          `WAL capacity threshold of ${capacity} bytes reached (${projected} bytes projected)`,
          nowMs,
        );
      }
    }

    const offered = this.#queue.offer(parsed, nowMs, bytes);
    if (!offered.accepted) {
      this.#overflowSignals += 1;
      return this.#refuse(parsed, "queue-overflow", offered.detail, nowMs);
    }

    if (this.#lastIngestSeq !== null && compareIngestSeq(parsed.ingestSeq, this.#lastIngestSeq) <= 0) {
      this.#nonMonotonicIngestSeqCount += 1;
      this.#options.observer.onIngestSeqAnomaly?.({
        segmentId: this.#active?.segmentId ?? null,
        previousIngestSeq: this.#lastIngestSeq,
        ingestSeq: parsed.ingestSeq,
        atMs: nowMs,
      });
    }
    this.#lastIngestSeq = parsed.ingestSeq;
    this.#framesAccepted += 1;
    return { accepted: true, queueDepth: offered.depth };
  }

  #refuse(
    record: RawFrameRecord,
    reason: WalRefusalReason,
    detail: string,
    nowMs: number,
  ): WalEnqueueResult {
    this.#options.observer.onOverflow?.({
      reason,
      detail,
      record,
      queueDepth: this.#queue.depth,
      queueCapacity: this.#options.queueCapacity,
      atMs: nowMs,
    });
    return { accepted: false, reason, queueDepth: this.#queue.depth, detail };
  }

  /**
   * Write every queued frame, rotating and fsyncing as the policy requires.
   *
   * On an append failure the writer becomes `faulted`, every frame that is not
   * known to be durable stays in {@link WalWriter.pendingFrames}, and the error
   * is re-thrown.
   */
  async drain(): Promise<WalDrainResult> {
    this.#assertWritable("drain");
    if (this.#draining) {
      throw new WalWriterStateError("a drain is already in progress");
    }
    this.#draining = true;
    let framesWritten = 0;
    let bytesWritten = 0;
    let rotations = 0;
    let fsyncs = 0;
    try {
      for (;;) {
        const items = this.#queue.takeAll();
        if (items.length === 0) {
          break;
        }
        let cursor = 0;
        while (cursor < items.length) {
          const first = items[cursor];
          if (first === undefined) {
            cursor += 1;
            continue;
          }
          if (this.#active === null) {
            await this.#openSegment();
          }
          const active = this.#active;
          if (active === null) {
            throw new WalWriterStateError("no active segment after opening one");
          }

          const rotateReason = this.#rotationReason(active, first.bytes.length);
          if (rotateReason !== null) {
            await this.#finalizeActive(rotateReason);
            rotations += 1;
            continue;
          }

          const batch: QueuedFrame[] = [];
          let batchBytes = 0;
          let scan = cursor;
          while (scan < items.length) {
            const next = items[scan];
            if (next === undefined) {
              scan += 1;
              continue;
            }
            if (
              batch.length > 0 &&
              active.byteLength + batchBytes + next.bytes.length > this.#options.maxSegmentBytes
            ) {
              break;
            }
            batch.push(next);
            batchBytes += next.bytes.length;
            scan += 1;
          }

          const appended = await this.#appendBatch(active, batch, items, cursor);
          framesWritten += batch.length;
          bytesWritten += appended;
          cursor = scan;

          const monotonic = this.#options.clock.monotonicMs();
          if (this.#shouldSync(active, monotonic)) {
            await this.#sync(
              active,
              active.unsyncedBytes >= this.#options.fsyncByteThreshold
                ? "byte-threshold"
                : "interval",
            );
            fsyncs += 1;
          }
        }
      }
    } finally {
      this.#draining = false;
    }
    return { framesWritten, bytesWritten, rotations, fsyncs };
  }

  /**
   * Advance time-driven policy without new frames: rotate an aged segment,
   * fsync when the interval has elapsed.
   *
   * The gateway calls this on its own cadence. Without it an idle recorder would
   * hold unsynced bytes past the published data-loss bound.
   */
  async tick(): Promise<void> {
    if (this.#state !== "open") {
      return;
    }
    const active = this.#active;
    if (active === null) {
      return;
    }
    const monotonic = this.#options.clock.monotonicMs();
    if (
      active.recordCount > 0 &&
      monotonic - active.openedMonotonicMs >= this.#options.maxSegmentAgeMs
    ) {
      await this.#finalizeActive("time-rotation");
      return;
    }
    if (
      active.unsyncedBytes > 0 &&
      monotonic - active.lastSyncMonotonicMs >= this.#options.fsyncIntervalMs
    ) {
      await this.#sync(active, "interval");
    }
  }

  /** Drain and force an fsync, regardless of the periodic policy. */
  async flush(): Promise<WalDrainResult> {
    const result = await this.drain();
    const active = this.#active;
    if (active !== null && active.unsyncedBytes > 0) {
      await this.#sync(active, "explicit");
      return { ...result, fsyncs: result.fsyncs + 1 };
    }
    return result;
  }

  /** Drain and close the active segment, returning its manifest. */
  async rotate(reason: WalCloseReason = "manual-rotation"): Promise<WalSegmentManifest | null> {
    this.#assertWritable("rotate");
    await this.drain();
    if (this.#active === null) {
      return null;
    }
    return this.#finalizeActive(reason);
  }

  /**
   * Close the writer.
   *
   * A healthy writer drains, finalizes the active segment (footer + manifest),
   * and stops. A faulted writer reconciles the segment against what is actually
   * on disk, truncates an incomplete final record, writes a manifest, and
   * reports the frames that never reached the disk through
   * {@link WalWriter.pendingFrames}.
   */
  async close(reason: WalCloseReason = "shutdown"): Promise<WalSegmentManifest | null> {
    if (this.#state === "closed") {
      return null;
    }
    if (this.#state === "faulted") {
      const manifest = await this.#finalizeFaultedSegment();
      this.#state = "closed";
      return manifest;
    }
    await this.drain();
    const manifest = this.#active === null ? null : await this.#finalizeActive(reason);
    this.#state = "closed";
    return manifest;
  }

  /**
   * Frames the writer accepted but cannot prove are durable.
   *
   * Non-empty only after a write fault. They are handed back rather than
   * discarded so the caller can re-enqueue them against a fresh writer or record
   * them in an incident (§8.3).
   */
  pendingFrames(): readonly RawFrameRecord[] {
    return this.#pending.map((frame) => frame.record);
  }

  /** Every manifest in this writer's directory, including recovered segments. */
  async listManifests(): Promise<readonly WalSegmentManifest[]> {
    return listSegmentManifests(this.#options.fileSystem, this.#options.directoryPath);
  }

  metrics(): WalWriterMetrics {
    const nowMs = this.#options.clock.nowMs();
    const monotonic = this.#options.clock.monotonicMs();
    const active = this.#active;
    const capacity = this.#options.maxTotalBytes;
    return {
      state: this.#state,
      queue: this.#queue.metrics(nowMs),
      activeSegmentId: active?.segmentId ?? null,
      activeSegmentRecordCount: active?.recordCount ?? 0,
      activeSegmentByteLength: active?.byteLength ?? 0,
      activeSegmentAgeMs: active === null ? null : monotonic - active.openedMonotonicMs,
      segmentsOpened: this.#segmentsOpened,
      segmentsFinalized: this.#segmentsFinalized,
      rotations: this.#rotations,
      framesAccepted: this.#framesAccepted,
      framesWritten: this.#framesWritten,
      framesDurable: this.#framesDurable,
      bytesWritten: this.#bytesWritten,
      bytesUnsynced: active?.unsyncedBytes ?? 0,
      recordsUnsynced: active?.unsyncedRecords ?? 0,
      fsyncCount: this.#fsyncCount,
      lastFsyncDurationMs: this.#lastFsyncDurationMs,
      totalFsyncDurationMs: this.#totalFsyncDurationMs,
      msSinceLastFsync:
        this.#lastFsyncMonotonicMs === null ? null : monotonic - this.#lastFsyncMonotonicMs,
      dataLossBoundMs: this.#options.fsyncIntervalMs,
      totalSegmentBytes: this.#totalSegmentBytes,
      capacityBytes: capacity,
      capacityRemainingBytes: capacity === null ? null : capacity - this.#totalSegmentBytes,
      overflowSignals: this.#overflowSignals,
      capacityRefusals: this.#capacityRefusals,
      closedRefusals: this.#closedRefusals,
      faultedRefusals: this.#faultedRefusals,
      validationRejections: this.#validationRejections,
      writeFaults: this.#writeFaults,
      nonMonotonicIngestSeqCount: this.#nonMonotonicIngestSeqCount,
      pendingFrameCount: this.#pending.length,
    };
  }

  /**
   * Record that the caller discarded frames the writer refused.
   *
   * The only path that moves the §8.3 `messagesDropped` metric. A drop is
   * always a decision someone made and logged, never something the WAL did.
   */
  recordCallerDrop(count: number, reason: string): void {
    this.#queue.recordCallerDrop(count, reason);
  }

  #assertWritable(operation: string): void {
    if (this.#state === "closed") {
      throw new WalWriterStateError(`cannot ${operation}: the WAL writer is closed`);
    }
    if (this.#state === "faulted") {
      throw new WalWriterStateError(
        `cannot ${operation}: the WAL writer is faulted and must be closed and reopened`,
      );
    }
  }

  #rotationReason(active: ActiveSegment, nextRecordBytes: number): WalCloseReason | null {
    if (active.recordCount === 0) {
      // A single record larger than the size bound gets its own segment rather
      // than being split: records are never divided across segments.
      return null;
    }
    const monotonic = this.#options.clock.monotonicMs();
    if (monotonic - active.openedMonotonicMs >= this.#options.maxSegmentAgeMs) {
      return "time-rotation";
    }
    if (active.byteLength + nextRecordBytes > this.#options.maxSegmentBytes) {
      return "size-rotation";
    }
    return null;
  }

  #shouldSync(active: ActiveSegment, monotonicMs: number): boolean {
    if (active.unsyncedBytes === 0) {
      return false;
    }
    if (active.unsyncedBytes >= this.#options.fsyncByteThreshold) {
      return true;
    }
    return monotonicMs - active.lastSyncMonotonicMs >= this.#options.fsyncIntervalMs;
  }

  async #sync(
    active: ActiveSegment,
    trigger: "byte-threshold" | "interval" | "explicit" | "finalize",
  ): Promise<void> {
    const startedMs = this.#options.clock.monotonicMs();
    let synced: { readonly bytes: number; readonly records: number };
    try {
      synced = await active.sync(this.#options.clock);
    } catch (error) {
      // An fsync that fails leaves durability unknown. That is a fault, not a
      // warning: the writer stops accepting frames and the caller reopens, at
      // which point recovery reads what actually reached the disk.
      this.#state = "faulted";
      this.#writeFaults += 1;
      this.#options.observer.onWriteFault?.({
        segmentId: active.segmentId,
        pendingFrames: this.#pending.length,
        error,
        atMs: this.#options.clock.nowMs(),
      });
      throw new WalWriteFaultError("WAL fsync failed; the writer is faulted", {
        segmentId: active.segmentId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const durationMs = this.#options.clock.monotonicMs() - startedMs;
    this.#fsyncCount += 1;
    this.#framesDurable += synced.records;
    this.#totalFsyncDurationMs += durationMs;
    this.#lastFsyncDurationMs = durationMs;
    this.#lastFsyncMonotonicMs = this.#options.clock.monotonicMs();
    this.#options.observer.onFsync?.({
      segmentId: active.segmentId,
      syncedBytes: synced.bytes,
      syncedRecords: synced.records,
      trigger,
      durationMs,
      atMs: this.#options.clock.nowMs(),
    });
  }

  async #openSegment(): Promise<void> {
    const createdAtMs = this.#options.clock.nowMs();
    const segmentIndex = this.#nextSegmentIndex;
    const segmentId = this.#options.segmentIdFactory({
      gatewayEpoch: this.#options.gatewayEpoch,
      segmentIndex,
      createdAtMs,
    });
    const path = this.#options.fileSystem.joinPath(
      this.#options.directoryPath,
      segmentFileName(segmentId),
    );
    const existing = await this.#options.fileSystem.fileByteLength(path);
    if (existing !== null) {
      // Never append to an existing segment: it may already be finalized, and a
      // second writer on the same directory is a bug, not a merge.
      throw new WalWriterStateError("refusing to reopen an existing segment file", {
        segmentId,
        path,
      });
    }
    const header = buildSegmentHeader({
      segmentId,
      gatewayEpoch: this.#options.gatewayEpoch,
      segmentIndex,
      createdAt: isoFromEpochMs(createdAtMs),
    });
    const active = await ActiveSegment.open({
      fileSystem: this.#options.fileSystem,
      directoryPath: this.#options.directoryPath,
      header,
      clock: this.#options.clock,
    });
    this.#active = active;
    this.#nextSegmentIndex += 1;
    this.#segmentsOpened += 1;
    this.#bytesWritten += active.byteLength;
    this.#totalSegmentBytes += active.byteLength;
    this.#fsyncCount += 1;
    this.#lastFsyncMonotonicMs = this.#options.clock.monotonicMs();
    this.#options.observer.onSegmentOpened?.({
      segmentId,
      segmentIndex,
      gatewayEpoch: this.#options.gatewayEpoch,
      path,
      atMs: createdAtMs,
    });
  }

  async #appendBatch(
    active: ActiveSegment,
    batch: readonly QueuedFrame[],
    items: readonly QueuedFrame[],
    cursor: number,
  ): Promise<number> {
    const recordCountBefore = active.recordCount;
    try {
      const appended = await active.appendFrames(batch);
      this.#framesWritten += batch.length;
      this.#bytesWritten += appended;
      this.#totalSegmentBytes += appended;
      return appended;
    } catch (error) {
      this.#state = "faulted";
      this.#writeFaults += 1;
      this.#failedBatchSize = batch.length;
      this.#recordCountBeforeFailedBatch = recordCountBefore;
      this.#pending = items.slice(cursor).filter((item): item is QueuedFrame => item !== undefined);
      this.#options.observer.onWriteFault?.({
        segmentId: active.segmentId,
        pendingFrames: this.#pending.length,
        error,
        atMs: this.#options.clock.nowMs(),
      });
      throw new WalWriteFaultError("WAL append failed; the writer is faulted", {
        segmentId: active.segmentId,
        pendingFrames: this.#pending.length,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #finalizeActive(reason: WalCloseReason): Promise<WalSegmentManifest> {
    const active = this.#active;
    if (active === null) {
      throw new WalWriterStateError("no active segment to finalize");
    }
    const byteLengthBefore = active.byteLength;
    const unsyncedRecordsBefore = active.unsyncedRecords;
    let manifest: WalSegmentManifest;
    try {
      manifest = await active.finalize(reason, this.#options.clock);
    } catch (error) {
      // The footer or the manifest did not make it. The segment stays as the
      // active-but-faulted one so that a subsequent close() reconciles it
      // against the disk; if the process dies first, recovery finalizes it.
      this.#state = "faulted";
      this.#writeFaults += 1;
      this.#options.observer.onWriteFault?.({
        segmentId: active.segmentId,
        pendingFrames: this.#pending.length,
        error,
        atMs: this.#options.clock.nowMs(),
      });
      throw new WalWriteFaultError("WAL segment finalization failed; the writer is faulted", {
        segmentId: active.segmentId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    this.#active = null;
    this.#segmentsFinalized += 1;
    if (reason !== "shutdown") {
      this.#rotations += 1;
    }
    // finalize() fsyncs, so everything that was unsynced is now durable.
    this.#framesDurable += unsyncedRecordsBefore;
    this.#bytesWritten += manifest.byteSize - byteLengthBefore;
    this.#totalSegmentBytes += manifest.byteSize - byteLengthBefore;
    this.#fsyncCount += 1;
    this.#lastFsyncMonotonicMs = this.#options.clock.monotonicMs();
    this.#options.observer.onSegmentFinalized?.(manifest);
    return manifest;
  }

  /**
   * Close a segment whose in-memory state can no longer be trusted.
   *
   * Reads back what actually reached the disk, truncates an incomplete final
   * record, writes the sidecar manifest for the verified prefix, and removes
   * from `pendingFrames` exactly those frames that turned out to be durable —
   * so the caller re-enqueues neither a lost frame nor a duplicate.
   */
  async #finalizeFaultedSegment(): Promise<WalSegmentManifest | null> {
    const active = this.#active;
    if (active === null) {
      return null;
    }
    await active.abandon();

    const scan = await scanSegment(this.#options.fileSystem, active.path, {
      onIssue: "collect",
      expectedSegmentId: active.segmentId,
    });

    let byteSize = scan.byteSize;
    if (scan.incompleteFinalRecord !== null) {
      await this.#options.fileSystem.truncate(
        active.path,
        scan.incompleteFinalRecord.byteOffset,
      );
      this.#faultTruncatedTailBytes += scan.incompleteFinalRecord.byteLength;
      byteSize = scan.incompleteFinalRecord.byteOffset;
    }

    if (!this.#faultReconciled) {
      // Frames that turned out to be durable leave the pending list; the rest
      // stay with the caller. Done once, so a retried close cannot drop frames.
      const persistedFromBatch = Math.min(
        Math.max(scan.recordCount - this.#recordCountBeforeFailedBatch, 0),
        this.#failedBatchSize,
      );
      this.#pending = this.#pending.slice(persistedFromBatch);
      this.#faultReconciled = true;
    }

    const fatal = scan.issues.filter((issue) => issue.code !== "INCOMPLETE_FINAL_RECORD");
    if (fatal.length > 0 || scan.header === null) {
      // Leave the segment unmanifested: an unverifiable segment must not be
      // offered to a compactor (ADR-004 §3, §5).
      this.#active = null;
      return null;
    }

    const manifest: WalSegmentManifest = {
      manifestVersion: WAL_MANIFEST_VERSION,
      formatId: WAL_FORMAT_ID,
      walSchemaVersion: WAL_SCHEMA_VERSION,
      segmentId: active.segmentId,
      gatewayEpoch: scan.header.gatewayEpoch,
      segmentIndex: scan.header.segmentIndex,
      segmentFileName: segmentFileName(active.segmentId),
      recordCount: scan.recordCount,
      firstIngestSeq: scan.firstIngestSeq,
      lastIngestSeq: scan.lastIngestSeq,
      firstReceivedAt: scan.firstReceivedAt,
      lastReceivedAt: scan.lastReceivedAt,
      byteSize,
      checksummedByteLength: scan.checksummedByteLength,
      segmentSha256: scan.computedSha256,
      createdAt: scan.header.createdAt,
      // A footer that did reach the disk keeps its own close reason and
      // timestamp; the manifest describes what happened, it does not rewrite it.
      closedAt: scan.footer?.closedAt ?? isoFromEpochMs(this.#options.clock.nowMs()),
      closeReason: scan.footer?.closeReason ?? "write-fault",
      footerPresent: scan.footer !== null,
      truncatedTailBytes: this.#faultTruncatedTailBytes,
    };
    // If this throws — a full disk usually — the segment stays active-but-
    // faulted so that another close() can retry once space exists, and recovery
    // finalizes it if the process dies first.
    await writeSegmentManifest(
      this.#options.fileSystem,
      this.#options.directoryPath,
      manifest,
    );
    this.#active = null;
    this.#segmentsFinalized += 1;
    this.#options.observer.onSegmentFinalized?.(manifest);
    return manifest;
  }
}
