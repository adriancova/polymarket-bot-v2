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
import { buildSegmentHeader, encodeFooterLine, encodeFrameLine, encodeHeaderLine } from "./segment-format.js";
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
  /**
   * Frame bytes that may still be admitted under `maxTotalBytes`, given what is
   * on disk, what is queued, and the framing overhead the queued bytes will
   * cause. `null` when no threshold is configured. Never negative.
   */
  readonly capacityRemainingBytes: number | null;
  /** Framing overhead currently reserved against `maxTotalBytes` (§11.1). */
  readonly capacityReservedBytes: number | null;
  /**
   * Frames appended to the active segment whose durability no `fsync` has
   * proven yet. They are the frames a power loss would cost right now, and the
   * ones a fault hands back through `pendingFrames()`.
   */
  readonly unprovenFrameCount: number;
  /**
   * Segments this writer faulted on and could not prove durable, so it wrote no
   * manifest. Each one is unverified until recovery finalizes it, and each is a
   * data-quality incident.
   */
  readonly unmanifestedFaultedSegments: number;
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
 * Slack added to every per-segment overhead reservation.
 *
 * Absorbs the difference between a segment id measured now and the one actually
 * produced later (a custom `segmentIdFactory` may fold the creation time into
 * the id). Over-reserving only refuses sooner, which is the safe direction; the
 * bound in `docs/contracts/wal-format.md` §11.1 is stated in terms of it.
 */
const SEGMENT_OVERHEAD_SLACK_BYTES = 64;

/** A timestamp of the widest shape `isoFromEpochMs` produces. */
const WIDEST_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Every close reason, at its longest — a footer carries exactly one. */
const WIDEST_CLOSE_REASON: WalCloseReason = "manual-rotation";

/** Bytes of the header line for a segment, at its widest. */
function headerReserveBytes(
  segmentId: string,
  gatewayEpoch: string,
  segmentIndex: number,
): number {
  return (
    encodeHeaderLine(
      buildSegmentHeader({
        segmentId,
        gatewayEpoch,
        segmentIndex,
        createdAt: WIDEST_TIMESTAMP,
      }),
    ).length + SEGMENT_OVERHEAD_SLACK_BYTES
  );
}

/**
 * Bytes of the footer line for a segment, at its widest: the numeric fields are
 * taken at `Number.MAX_SAFE_INTEGER` and the close reason at its longest, so no
 * real footer can be larger.
 */
function footerReserveBytes(segmentId: string, gatewayEpoch: string): number {
  return (
    encodeFooterLine({
      record: "footer",
      formatId: WAL_FORMAT_ID,
      walSchemaVersion: WAL_SCHEMA_VERSION,
      segmentId,
      gatewayEpoch,
      recordCount: Number.MAX_SAFE_INTEGER,
      checksummedByteLength: Number.MAX_SAFE_INTEGER,
      segmentSha256: "0".repeat(64),
      closedAt: WIDEST_TIMESTAMP,
      closeReason: WIDEST_CLOSE_REASON,
    }).length + SEGMENT_OVERHEAD_SLACK_BYTES
  );
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
  /**
   * Frames the caller must take back. See {@link WalWriter.pendingFrames}.
   */
  #pending: QueuedFrame[] = [];
  /**
   * Frames appended to the active segment since its last successful `fsync`.
   *
   * They are on disk but nothing has proven they survive a power loss, so the
   * writer keeps hold of them: on a fault they move to {@link #pending}, and a
   * successful `fsync` — the only proof of durability there is — clears them.
   * This list is what makes the accepted-frame invariant total rather than
   * append-shaped.
   */
  #unproven: QueuedFrame[] = [];
  #durableRecordCountAtFault = 0;
  #faultReconciled = false;
  #faultTruncatedTailBytes = 0;
  #unmanifestedFaultedSegments = 0;

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
  readonly #overheadReserveCache = new Map<number, number>();
  #activeFooterReserveBytes = 0;

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
      // The projection charges the framing this frame will *cause*, not only
      // the frame line itself: a segment costs a header line and a footer line
      // beyond its records, and admitting bytes without reserving those turns
      // the documented hard threshold into a suggestion (see
      // `docs/contracts/wal-format.md` §11.1).
      const unwrittenBytes = this.#queue.byteDepth + bytes.length;
      const projected = this.#totalSegmentBytes + unwrittenBytes + this.#overheadReserve(unwrittenBytes);
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
   * **The accepted-frame invariant is total.** A frame the writer accepted is,
   * at every instant, either queued, appended-and-proven-durable, or in
   * {@link WalWriter.pendingFrames}. That holds for *every* way this method can
   * fail — creating a segment, rotating, appending, finalizing, or fsyncing —
   * not only for a failed append: the queue is emptied by `takeAll()`, so any
   * error thrown while the frames are in flight would otherwise lose them.
   * On failure the writer becomes `faulted`, the frames it cannot prove durable
   * move to `pendingFrames()`, and the error is re-thrown.
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
        // From here until `cursor` reaches the end, `items.slice(cursor)` is
        // the writer's debt: those frames left the queue and are not on disk.
        let cursor = 0;
        try {
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
              if (
                batch.length > 0 &&
                active.unsyncedBytes + batchBytes + next.bytes.length >
                  this.#options.fsyncByteThreshold
              ) {
                // Stop the batch at the byte threshold so the fsync fires there
                // rather than after an arbitrarily larger batch. The threshold
                // is still a high-water mark, not a hard cap: one record may
                // cross it on its own (`wal-format.md` §9).
                break;
              }
              batch.push(next);
              batchBytes += next.bytes.length;
              scan += 1;
            }

            const appended = await this.#appendBatch(active, batch);
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
        } catch (error) {
          this.#enterFault(error, items.slice(cursor));
          throw error;
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
    try {
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
    } catch (error) {
      // Nothing was taken from the queue here, but frames appended since the
      // last fsync are still the writer's responsibility.
      this.#enterFault(error);
      throw error;
    }
  }

  /** Drain and force an fsync, regardless of the periodic policy. */
  async flush(): Promise<WalDrainResult> {
    const result = await this.drain();
    const active = this.#active;
    if (active !== null && active.unsyncedBytes > 0) {
      try {
        await this.#sync(active, "explicit");
      } catch (error) {
        this.#enterFault(error);
        throw error;
      }
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
    try {
      return await this.#finalizeActive(reason);
    } catch (error) {
      this.#enterFault(error);
      throw error;
    }
  }

  /**
   * Close the writer.
   *
   * A healthy writer drains, finalizes the active segment (footer + manifest),
   * and stops. A faulted writer reconciles the segment against what is actually
   * on disk, truncates an incomplete final record, writes a manifest for what it
   * can prove is durable, and reports every other accepted frame through
   * {@link WalWriter.pendingFrames}.
   *
   * A fault raised *by this call* is reconciled and then re-thrown: a close that
   * hit a write fault must not look like a clean shutdown. `pendingFrames()`,
   * `metrics()`, and `listManifests()` are all still readable afterwards, and
   * the writer is `closed`. If the reconciliation itself cannot complete — a
   * genuinely full disk that has no room for the sidecar — the writer stays
   * `faulted` and `close()` may be retried once space exists.
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

    let faultError: unknown = null;
    try {
      await this.drain();
    } catch (error) {
      faultError = error;
    }
    if (faultError === null) {
      try {
        const manifest = this.#active === null ? null : await this.#finalizeActive(reason);
        this.#state = "closed";
        return manifest;
      } catch (error) {
        this.#enterFault(error);
        faultError = error;
      }
    }
    // Reconcile before surfacing the fault, so the caller inspecting
    // `pendingFrames()` in its catch block sees the settled answer.
    await this.#finalizeFaultedSegment();
    this.#state = "closed";
    throw faultError;
  }

  /**
   * Frames the writer accepted but cannot prove are durable.
   *
   * Non-empty only after a write fault. They are handed back rather than
   * discarded so the caller can re-enqueue them against a fresh writer or record
   * them in an incident (§8.3). After `close()` this list is reconciled against
   * the bytes on disk: it holds exactly the accepted frames that are **not**
   * covered by a manifest, so re-enqueueing all of them duplicates nothing that
   * a compactor can see and loses nothing.
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
    const queueBytes = this.#queue.byteDepth;
    const reserved = capacity === null ? 0 : this.#overheadReserve(queueBytes);
    return {
      capacityReservedBytes: capacity === null ? null : reserved,
      unprovenFrameCount: this.#unproven.length,
      unmanifestedFaultedSegments: this.#unmanifestedFaultedSegments,
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
      // Headroom for *frame bytes*, under the §11.1 definition of the bound:
      // what is on disk, plus what is queued, plus the framing overhead the
      // queued bytes will cause. Never negative.
      capacityRemainingBytes:
        capacity === null
          ? null
          : Math.max(0, capacity - this.#totalSegmentBytes - queueBytes - reserved),
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

  /**
   * Take responsibility for every frame the failure put at risk.
   *
   * The single place the writer becomes `faulted`. It runs once per fault, and
   * it is what makes the accepted-frame invariant total: `#unproven` (appended,
   * never proven durable) plus `extraFrames` (taken from the queue, never
   * appended) become the caller's again through `pendingFrames()`, in the order
   * they were accepted.
   */
  #enterFault(error: unknown, extraFrames: readonly QueuedFrame[] = []): void {
    const active = this.#active;
    if (this.#state !== "faulted") {
      this.#state = "faulted";
      this.#writeFaults += 1;
      this.#durableRecordCountAtFault = active?.durableRecordCount ?? 0;
    }
    if (this.#unproven.length > 0 || extraFrames.length > 0) {
      this.#pending.push(...this.#unproven, ...extraFrames);
      this.#unproven = [];
    }
    this.#options.observer.onWriteFault?.({
      segmentId: active?.segmentId ?? null,
      pendingFrames: this.#pending.length,
      error,
      atMs: this.#options.clock.nowMs(),
    });
  }

  #writeFault(
    message: string,
    segmentId: string | null,
    error: unknown,
    extra: Readonly<Record<string, unknown>> = {},
  ): WalWriteFaultError {
    return new WalWriteFaultError(message, {
      ...(segmentId === null ? {} : { segmentId }),
      ...extra,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Framing overhead to reserve against `maxTotalBytes` for `unwrittenBytes` of
   * accepted-but-unwritten frame bytes.
   *
   * A segment costs a header line and a footer line beyond its records, and
   * neither exists yet when the frames are admitted. The reservation is the
   * active segment's footer plus one header-and-footer for each further segment
   * the unwritten bytes require. Header and footer lengths are computed from the
   * real gateway epoch and the real segment ids, with numeric fields taken at
   * their widest (`Number.MAX_SAFE_INTEGER`) and a small fixed slack, so the
   * reservation is an over-estimate and never an under-estimate.
   *
   * `docs/contracts/wal-format.md` §11.1 states the bound this enforces and the
   * one case it does not cover.
   */
  #overheadReserve(unwrittenBytes: number): number {
    const active = this.#active;
    const maxSegmentBytes = this.#options.maxSegmentBytes;
    let reserve = active === null ? 0 : this.#activeFooterReserveBytes;
    let newSegments: number;
    if (active === null) {
      newSegments = unwrittenBytes === 0 ? 0 : Math.ceil(unwrittenBytes / maxSegmentBytes);
    } else {
      const roomInActive = Math.max(maxSegmentBytes - active.byteLength, 0);
      newSegments = Math.ceil(Math.max(unwrittenBytes - roomInActive, 0) / maxSegmentBytes);
    }
    if (newSegments > 0) {
      // Segment ids grow with the ordinal, so the last index we could need
      // bounds the length of every id in between.
      reserve += newSegments * this.#segmentOverheadReserve(this.#nextSegmentIndex + newSegments - 1);
    }
    return reserve;
  }

  /** Worst-case header + footer bytes for the segment at `segmentIndex`. */
  #segmentOverheadReserve(segmentIndex: number): number {
    const cached = this.#overheadReserveCache.get(segmentIndex);
    if (cached !== undefined) {
      return cached;
    }
    const segmentId = this.#options.segmentIdFactory({
      gatewayEpoch: this.#options.gatewayEpoch,
      segmentIndex,
      createdAtMs: this.#options.clock.nowMs(),
    });
    const reserve =
      headerReserveBytes(segmentId, this.#options.gatewayEpoch, segmentIndex) +
      footerReserveBytes(segmentId, this.#options.gatewayEpoch);
    this.#overheadReserveCache.set(segmentIndex, reserve);
    return reserve;
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
      // warning: the writer stops accepting frames, every frame appended since
      // the last successful fsync goes back to the caller, and the caller
      // reopens — at which point recovery reads what actually reached the disk.
      throw this.#writeFault("WAL fsync failed; the writer is faulted", active.segmentId, error);
    }
    const durationMs = this.#options.clock.monotonicMs() - startedMs;
    this.#fsyncCount += 1;
    // The fsync returned: these frames are durable and stop being the writer's
    // debt. This is the only place durability is ever asserted.
    this.#unproven = [];
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
    let active: ActiveSegment;
    try {
      active = await ActiveSegment.open({
        fileSystem: this.#options.fileSystem,
        directoryPath: this.#options.directoryPath,
        header,
        clock: this.#options.clock,
      });
    } catch (error) {
      // Creating the segment is a write like any other. Before this fix the
      // failure escaped `drain()` raw, leaving the writer `open` and the frames
      // it had already taken from the queue accounted for nowhere.
      throw this.#writeFault(
        "WAL segment creation failed; the writer is faulted",
        segmentId,
        error,
        { path },
      );
    }
    this.#active = active;
    this.#activeFooterReserveBytes = footerReserveBytes(segmentId, this.#options.gatewayEpoch);
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

  async #appendBatch(active: ActiveSegment, batch: readonly QueuedFrame[]): Promise<number> {
    let appended: number;
    try {
      appended = await active.appendFrames(batch);
    } catch (error) {
      // The batch stays the caller's debt through `items.slice(cursor)` in
      // `drain()`, which still points at its first frame. A torn append may
      // have landed a prefix of it; the fault reconciliation in
      // `#finalizeFaultedSegment` finds out how much by reading the file.
      throw this.#writeFault("WAL append failed; the writer is faulted", active.segmentId, error);
    }
    this.#framesWritten += batch.length;
    this.#bytesWritten += appended;
    this.#totalSegmentBytes += appended;
    // Written, but not yet proven durable: still the writer's responsibility
    // until an fsync says otherwise.
    this.#unproven.push(...batch);
    return appended;
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
      // The caller of this method moves `#unproven` to `pendingFrames()`.
      throw this.#writeFault(
        "WAL segment finalization failed; the writer is faulted",
        active.segmentId,
        error,
      );
    }
    this.#active = null;
    this.#activeFooterReserveBytes = 0;
    // finalize() fsynced the footer, so every frame in this segment is durable.
    this.#unproven = [];
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
   * The rule this method enforces, and the reason it exists:
   * **a manifest never describes bytes that no `fsync` has covered.** A clean
   * close writes the footer, fsyncs, and only then writes the sidecar; the fault
   * path must do the same or the manifest becomes a claim about data a power
   * loss can still take away.
   *
   * So it first tries one last `fsync` to prove the file durable. If that
   * succeeds it reads back what actually reached the disk, truncates an
   * incomplete final record, writes the sidecar for the verified prefix, and
   * removes from `pendingFrames` exactly those frames that turned out to be
   * durable — so the caller re-enqueues neither a lost frame nor a duplicate.
   * If it fails, the segment is left exactly as found and **unmanifested**: it
   * is unverified, invisible to a compactor, and every frame it might hold stays
   * with the caller. Recovery finalizes it on the next open, describing whatever
   * actually survived.
   */
  async #finalizeFaultedSegment(): Promise<WalSegmentManifest | null> {
    const active = this.#active;
    if (active === null) {
      return null;
    }

    const durable = await active.syncForFaultClose();
    await active.abandon();
    if (!durable) {
      // Nothing about this file can be asserted. Writing a manifest here would
      // report frames as durable that were never proven to be, which is exactly
      // how a manifest comes to overcount after a power loss.
      this.#active = null;
      this.#activeFooterReserveBytes = 0;
      this.#unmanifestedFaultedSegments += 1;
      this.#faultReconciled = true;
      return null;
    }

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

    const fatal = scan.issues.filter((issue) => issue.code !== "INCOMPLETE_FINAL_RECORD");
    const verifiable = fatal.length === 0 && scan.header !== null;

    if (!this.#faultReconciled) {
      // The records on disk beyond the last proven-durable one are exactly the
      // leading entries of the pending list, in order. They leave that list only
      // now, because only now has an fsync proven them. If the segment is not
      // verifiable it gets no manifest, so nothing on it counts as recorded and
      // every frame stays with the caller. Done once, so a retried close cannot
      // drop frames.
      const provenFromPending = verifiable
        ? Math.min(
            Math.max(scan.recordCount - this.#durableRecordCountAtFault, 0),
            this.#pending.length,
          )
        : 0;
      this.#pending = this.#pending.slice(provenFromPending);
      this.#framesDurable += provenFromPending;
      this.#faultReconciled = true;
    }

    if (!verifiable) {
      // Leave the segment unmanifested: an unverifiable segment must not be
      // offered to a compactor (ADR-004 §3, §5).
      this.#active = null;
      this.#activeFooterReserveBytes = 0;
      this.#unmanifestedFaultedSegments += 1;
      return null;
    }
    if (scan.header === null) {
      this.#active = null;
      this.#activeFooterReserveBytes = 0;
      this.#unmanifestedFaultedSegments += 1;
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
    this.#activeFooterReserveBytes = 0;
    this.#segmentsFinalized += 1;
    this.#options.observer.onSegmentFinalized?.(manifest);
    return manifest;
  }
}
