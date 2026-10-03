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

import { rescanSegmentBytes, SegmentByteLedger } from "./capacity-ledger.js";
import { isoFromEpochMs } from "./clock.js";
import {
  DEFAULT_FSYNC_BYTE_THRESHOLD,
  DEFAULT_FSYNC_INTERVAL_MS,
  DEFAULT_MAX_SEGMENT_AGE_MS,
  DEFAULT_MAX_SEGMENT_BYTES,
  DEFAULT_QUEUE_CAPACITY,
  DEFAULT_QUEUE_MAX_BYTES,
  MAX_SEGMENT_ID_ENCODED_BYTES,
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
  segmentIdKindFor,
  writeSegmentManifest,
} from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import type {
  SegmentIdContext,
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
   *
   * What it counts is a ledger of segment files (`capacity-ledger.ts`), read
   * from the disk at open and re-derived on every `tick()`: a segment that
   * raw-WAL expiry deleted stops counting, and a segment of an earlier epoch
   * under {@link WalWriterOptions.capacityRootPath} counts (`WALCAP-1`).
   */
  readonly maxTotalBytes?: number | null;
  /**
   * The WAL root `maxTotalBytes` covers: segment files directly in it and in
   * its immediate subdirectories count, as well as this writer's own
   * directory. Omitted, the threshold covers this writer's own directory
   * alone. The gateway names its WAL root, whose per-epoch subdirectories hold
   * every earlier epoch (`apps/data-gateway/src/journal.ts`).
   *
   * Needs `fileSystem.listDirectoryNames` when a threshold is set.
   */
  readonly capacityRootPath?: string;
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
  /**
   * With `maxTotalBytes` set, the bytes it is compared against: every segment
   * file in scope, as the capacity ledger counts them (`capacity-ledger.ts`).
   * With none, this writer's directory as recovery found it plus what it
   * wrote.
   */
  readonly totalSegmentBytes: number;
  readonly capacityBytes: number | null;
  /**
   * The last admission decision against `maxTotalBytes` refused the frame:
   * recording is stopped by the cap. Cleared by the next frame the cap admits.
   * Always `false` with no threshold.
   */
  readonly capacityReached: boolean;
  /** Re-derivations of the capacity count that completed (`tick()`). */
  readonly capacityRescans: number;
  /** Re-derivations that failed; the count kept what it had, which never undercounts. */
  readonly capacityRescanFailures: number;
  /** Bytes the count gave back because their segment files were found gone. */
  readonly capacityRelievedBytes: number;
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
   * proven yet: the frames a power loss would cost right now.
   *
   * This is the *durability* number. It is **not** the number a fault hands
   * back — see {@link WalWriterMetrics.retainedRecordCount}, which is the
   * accountability one and is never smaller.
   */
  readonly unprovenFrameCount: number;
  /**
   * Records of the active segment the writer is still answerable for, because
   * no manifest names them yet.
   *
   * A fault hands **all** of these back through `pendingFrames()`, whether or
   * not an `fsync` proved them, because a segment that ends unmanifested is a
   * segment nothing on disk claims (`wal-format.md` §10.1, §10.2). It falls to
   * zero every time a segment is manifested, so it is also the writer's
   * retention high-water mark within one segment.
   */
  readonly retainedRecordCount: number;
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
 * Pure margin now that the id width is bounded rather than measured
 * (`#reserveSegmentId`). Over-reserving only refuses sooner, which is the safe
 * direction; the bound in `docs/contracts/wal-format.md` §11.1 is stated in
 * terms of it.
 */
const SEGMENT_OVERHEAD_SLACK_BYTES = 64;

/**
 * The id the reservation charges for a segment an **injected** factory will
 * name: as wide as `MAX_SEGMENT_ID_ENCODED_BYTES` allows, in characters JSON
 * does not escape, so `JSON.stringify` of it is exactly that bound.
 *
 * Measuring the factory instead is what broke the threshold. `SegmentIdContext`
 * carries `createdAtMs`, so a factory may answer the reservation and the open
 * with ids of completely different widths — round-3 review measured a
 * projection taken against a short id and a 5,000-byte id at open, finishing
 * 7,964 bytes over `maxTotalBytes`. A bound cannot be enforced from a
 * measurement that goes stale, so the writer charges the bound and enforces it
 * (`docs/contracts/wal-format.md` §11.2).
 */
const WIDEST_INJECTED_SEGMENT_ID = "a".repeat(MAX_SEGMENT_ID_ENCODED_BYTES - 2);

/**
 * Bytes `JSON.stringify` produces for a segment id — what a line pays for it.
 *
 * Deliberately still `JSON.stringify`, unlike every container this package
 * encodes (`segment-format.ts`, `manifest.ts`, routed through the own-data
 * encoder by `SER-2`): the argument is a STRING PRIMITIVE, and ECMA-262 25.5.2
 * `SerializeJSONProperty` looks `toJSON` up only on a value of type Object or
 * BigInt, so no inherited `toJSON` can reach it (`SER-0` measured the string
 * route immune in all six contexts). `MAX_SEGMENT_ID_ENCODED_BYTES` and
 * `docs/contracts/wal-format.md` §11.2 state the bound on
 * `JSON.stringify(segmentId)` by name, and the primitive is byte-identical
 * here, so the wording stays true either way.
 */
function encodedSegmentIdBytes(segmentId: string): number {
  return Buffer.byteLength(JSON.stringify(segmentId), "utf8");
}

/**
 * Enforce the `SegmentIdFactory` contract.
 *
 * Loud on violation, and always **before** the segment file is created, so a
 * factory that would overrun `maxTotalBytes` costs a refused open rather than
 * bytes on disk nobody reserved for.
 */
function assertSegmentIdWithinBound(segmentId: unknown, context: SegmentIdContext): string {
  if (typeof segmentId !== "string" || segmentId.length === 0) {
    throw new WalConfigurationError("segmentIdFactory must return a non-empty string", {
      segmentIndex: context.segmentIndex,
      returned: typeof segmentId,
    });
  }
  const encoded = encodedSegmentIdBytes(segmentId);
  if (encoded > MAX_SEGMENT_ID_ENCODED_BYTES) {
    throw new WalConfigurationError(
      `segmentIdFactory returned a segment id of ${encoded} encoded bytes, past the ${MAX_SEGMENT_ID_ENCODED_BYTES}-byte bound`,
      {
        segmentIndex: context.segmentIndex,
        encodedBytes: encoded,
        maxEncodedBytes: MAX_SEGMENT_ID_ENCODED_BYTES,
      },
    );
  }
  return segmentId;
}

/** A timestamp of the widest shape `isoFromEpochMs` produces. */
const WIDEST_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Every close reason, at its longest — a footer carries exactly one. */
const WIDEST_CLOSE_REASON: WalCloseReason = "manual-rotation";

/**
 * How the frames that are accepted but not yet written will pack into segments.
 *
 * `newSegments` is how many further segments they need beyond the open one, and
 * `roomLeft` is the frame bytes that still fit in the last of them. `overhead`
 * is the header-plus-footer reservation those new segments cost.
 *
 * The projection exists because segment count is a *packing* question, not a
 * division: a segment holds whole records, so 10 records of 415 bytes need ten
 * 900-byte segments, not the `ceil(4150 / 900) = 5` a byte-count division
 * predicts. Getting that wrong is what let a queued burst overshoot
 * `maxTotalBytes` (`docs/contracts/wal-format.md` §11.1).
 */
type CapacityProjection = {
  readonly newSegments: number;
  readonly roomLeft: number;
  readonly overhead: number;
  /**
   * The next frame lands in a segment that holds no record yet, so it is
   * admitted however large it is — §8's "a record is never split" exception.
   */
  readonly nextRecordAlwaysFits: boolean;
};

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
  const capacityRootPath = options.capacityRootPath ?? null;
  if (capacityRootPath !== null && (typeof capacityRootPath !== "string" || capacityRootPath.length === 0)) {
    throw new WalConfigurationError("capacityRootPath must be a non-empty path when given", {
      capacityRootPath: String(capacityRootPath),
    });
  }
  if (
    maxTotalBytes !== null &&
    capacityRootPath !== null &&
    typeof options.fileSystem.listDirectoryNames !== "function"
  ) {
    // Refused rather than narrowed: counting the writer's own directory alone
    // would leave every earlier epoch under the root out of the threshold.
    throw new WalConfigurationError(
      "maxTotalBytes over a capacity root needs a filesystem that lists directories (listDirectoryNames)",
      { capacityRootPath },
    );
  }
  const segmentIdFactory = options.segmentIdFactory ?? defaultSegmentIdFactory;
  // Fail fast on a factory that already violates its contract, before recovery
  // touches the directory. A factory that only *later* leaves the bound cannot
  // be caught here — `#openSegment` catches that one — but a plainly wrong one
  // should not cost a partially opened recorder to discover.
  assertSegmentIdWithinBound(
    segmentIdFactory({
      gatewayEpoch: options.gatewayEpoch,
      segmentIndex: 0,
      createdAtMs: options.clock.nowMs(),
    }),
    { gatewayEpoch: options.gatewayEpoch, segmentIndex: 0, createdAtMs: 0 },
  );

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

  // With a threshold, the count starts from the disk, not from recovery's
  // tally of this directory alone: an earlier epoch's segments under the root
  // are on the same disk (`WALCAP-1`). A read that fails here fails the open,
  // because a count that could not be read cannot be trusted to bound anything.
  let capacityLedger: SegmentByteLedger | null = null;
  if (maxTotalBytes !== null) {
    capacityLedger = new SegmentByteLedger();
    await rescanSegmentBytes(options.fileSystem, capacityLedger, {
      ownDirectory: options.directoryPath,
      rootPath: capacityRootPath,
      retain: () => false,
    });
  }

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
    capacityRootPath,
    capacityLedger,
    segmentIdFactory,
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
  readonly capacityRootPath: string | null;
  /** Present exactly when `maxTotalBytes` is set. */
  readonly capacityLedger: SegmentByteLedger | null;
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
  #pending: RawFrameRecord[] = [];
  /**
   * **Retained for accountability**: every record appended to the *active*
   * segment that no written manifest names yet, in accept order.
   *
   * This is deliberately not the same thing as the segment's durability
   * watermark, and round-3 review found the package conflating them. The
   * watermark (`segment-writer.ts`) answers "what may a manifest claim?" and a
   * successful `fsync` advances it. This list answers "which accepted records is
   * the writer still answerable for?", and **only a manifest write releases
   * it** — because under the watermark rule a later failure can freeze the
   * watermark short of the file, leaving the segment unmanifested *after*
   * earlier records were fsynced. Releasing on `fsync`, as the writer used to,
   * put those records in neither the manifest nor `pendingFrames()`, which is
   * the silent gap `wal-format.md` §10.1 forbids.
   *
   * The retention is bounded by `maxSegmentBytes`: it is emptied every time a
   * segment is manifested, which for a healthy writer is every rotation.
   */
  #segmentRecords: RawFrameRecord[] = [];
  /**
   * Records of the faulted segment that are accounted for as durable — the ones
   * that are *not* in {@link #pending}. The fault reconciliation uses it as the
   * pivot between "already accounted" and "the leading entries of the pending
   * list".
   *
   * It is structurally `0` now that {@link #segmentRecords} retains the whole
   * active segment, and it is still computed rather than assumed: if the two
   * ever drifted, a pivot derived from the real counts fails safe (fewer records
   * leave the pending list) where a hard-coded one would not.
   */
  #segmentRecordsAccountedDurable = 0;
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
  /**
   * What `maxTotalBytes` is compared against, per segment file: `null` with no
   * threshold. See `capacity-ledger.ts` for what may raise and lower it.
   */
  readonly #capacityLedger: SegmentByteLedger | null;
  #capacityRescanning = false;
  #capacityRescans = 0;
  #capacityRescanFailures = 0;
  #capacityRelievedBytes = 0;
  #capacityReached = false;
  #overflowSignals = 0;
  #capacityRefusals = 0;
  #closedRefusals = 0;
  #faultedRefusals = 0;
  #validationRejections = 0;
  #writeFaults = 0;
  #nonMonotonicIngestSeqCount = 0;
  #lastIngestSeq: string | null = null;
  readonly #overheadReserveCache = new Map<number, number>();
  readonly #headerReserveCache = new Map<number, number>();
  #activeFooterReserveBytes = 0;
  /**
   * How the queued frames will pack into segments, for the `maxTotalBytes`
   * projection. `null` means "rebuild it": the queue or the active segment
   * changed under it.
   */
  #projection: CapacityProjection | null = null;

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
    this.#capacityLedger = options.capacityLedger;
  }

  /** The bytes `maxTotalBytes` is compared against. */
  #countedSegmentBytes(): number {
    return this.#capacityLedger?.totalBytes ?? this.#totalSegmentBytes;
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
    // Packing this frame on top of the queued ones, without committing: the
    // projection charges the framing this frame will *cause*, not only the frame
    // line itself. A segment costs a header line and a footer line beyond its
    // records, and admitting bytes without reserving those turns the documented
    // hard threshold into a suggestion (`docs/contracts/wal-format.md` §11.1).
    // Only computed when a threshold exists; with none there is nothing to
    // reserve against and no reason to pay for the arithmetic per frame.
    let withCandidate: CapacityProjection | null = null;
    if (capacity !== null) {
      withCandidate = this.#packFrames([bytes.length], this.#currentProjection());
      const unwrittenBytes = this.#queue.byteDepth + bytes.length;
      const projected =
        this.#countedSegmentBytes() +
        unwrittenBytes +
        (this.#active === null ? 0 : this.#activeFooterReserveBytes) +
        withCandidate.overhead;
      if (projected > capacity) {
        this.#capacityRefusals += 1;
        this.#capacityReached = true;
        return this.#refuse(
          parsed,
          "capacity-exceeded",
          `WAL capacity threshold of ${capacity} bytes reached (${projected} bytes projected)`,
          nowMs,
        );
      }
      this.#capacityReached = false;
    }

    const offered = this.#queue.offer(parsed, nowMs, bytes);
    if (!offered.accepted) {
      this.#overflowSignals += 1;
      return this.#refuse(parsed, "queue-overflow", offered.detail, nowMs);
    }
    // Committed only now: a refused frame changes no reservation.
    if (withCandidate !== null) {
      this.#projection = withCandidate;
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
        this.#invalidateProjection();
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
    if (active !== null) {
      const monotonic = this.#options.clock.monotonicMs();
      try {
        if (
          active.recordCount > 0 &&
          monotonic - active.openedMonotonicMs >= this.#options.maxSegmentAgeMs
        ) {
          await this.#finalizeActive("time-rotation");
        } else if (
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
    // After the durability work, so a re-derivation never delays the fsync
    // that the published data-loss bound depends on. It runs whether or not a
    // segment is open: a writer refused at its cap has often just rotated and
    // has none, and it is exactly the writer that needs the relief.
    await this.#rescanCapacity();
  }

  /**
   * Re-derive the capacity count from the disk (`WALCAP-1`, J10).
   *
   * Lowers the count only by the bytes of segment files a direct read found
   * gone, which on a gateway host is raw-WAL expiry (ADR-028 Decision 2). It
   * deletes nothing, writes nothing, and never throws: a failed read is not a
   * write fault, and the count it leaves is still never below the disk
   * (`capacity-ledger.ts`). Skipped with no threshold, while another
   * re-derivation is in flight, and once the writer is not open.
   */
  async #rescanCapacity(): Promise<void> {
    const ledger = this.#capacityLedger;
    if (ledger === null || this.#capacityRescanning || this.#state !== "open") {
      return;
    }
    this.#capacityRescanning = true;
    try {
      const outcome = await rescanSegmentBytes(this.#options.fileSystem, ledger, {
        ownDirectory: this.#options.directoryPath,
        rootPath: this.#options.capacityRootPath,
        // The open segment's descriptor holds its bytes on disk until it is
        // closed, whatever happens to its name.
        retain: (path) => this.#active?.path === path,
      });
      this.#capacityRescans += 1;
      this.#capacityRelievedBytes += outcome.relievedBytes;
      this.#options.observer.onCapacityRescan?.({
        outcome: "counted",
        previousBytes: outcome.previousBytes,
        countedBytes: outcome.countedBytes,
        relievedBytes: outcome.relievedBytes,
        segmentsForgotten: outcome.segmentsForgotten,
        atMs: this.#options.clock.nowMs(),
      });
    } catch (error) {
      this.#capacityRescanFailures += 1;
      this.#options.observer.onCapacityRescan?.({
        outcome: "failed",
        countedBytes: ledger.totalBytes,
        error,
        atMs: this.#options.clock.nowMs(),
      });
    } finally {
      this.#capacityRescanning = false;
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
   * Frames the writer accepted whose accountability was never released by a
   * written manifest. This deliberately includes records an earlier successful
   * `fsync` covered when their segment ended unmanifested — durability proof
   * (the watermark) and accountability release (the manifest write) are
   * separate; only the latter removes a frame from this list.
   *
   * Non-empty only after a write fault. They are handed back rather than
   * discarded so the caller can re-enqueue them against a fresh writer or record
   * them in an incident (§8.3). After `close()` this list is reconciled against
   * the bytes on disk: it holds exactly the accepted frames that are **not**
   * covered by a manifest, so re-enqueueing all of them duplicates nothing that
   * a compactor can see and loses nothing.
   */
  pendingFrames(): readonly RawFrameRecord[] {
    return [...this.#pending];
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
    const reserved = capacity === null ? 0 : this.#reservedOverheadBytes();
    return {
      capacityReservedBytes: capacity === null ? null : reserved,
      // Derived from the watermark rather than from a second list, so the
      // durability metric and the durability claim cannot drift apart: the
      // retained records past what the last clean fsync covered.
      unprovenFrameCount: Math.max(
        this.#segmentRecords.length - (active?.durableRecordCount ?? 0),
        0,
      ),
      retainedRecordCount: this.#segmentRecords.length,
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
      totalSegmentBytes: this.#countedSegmentBytes(),
      capacityBytes: capacity,
      capacityReached: this.#capacityReached,
      capacityRescans: this.#capacityRescans,
      capacityRescanFailures: this.#capacityRescanFailures,
      capacityRelievedBytes: this.#capacityRelievedBytes,
      // Headroom for *frame bytes*, under the §11.1 definition of the bound:
      // what is on disk, plus what is queued, plus the framing overhead the
      // queued bytes will cause. Never negative.
      capacityRemainingBytes:
        capacity === null
          ? null
          : Math.max(0, capacity - this.#countedSegmentBytes() - queueBytes - reserved),
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
   * The single place the writer becomes `faulted`, and what makes the
   * accepted-frame invariant total. Three groups become the caller's again
   * through `pendingFrames()`, in the order they were accepted:
   *
   * 1. `#segmentRecords` — **every** record appended to the active segment that
   *    no manifest names, including ones an earlier `fsync` did prove durable;
   * 2. `extraFrames` — taken from the queue by `drain()` and never appended;
   * 3. **whatever is still queued** — the frames `enqueue` accepted and no drain
   *    ever reached.
   *
   * Group 3 was the round-2 gap: a fault raised by `tick()` takes nothing from
   * the queue, so a frame sitting in it was neither manifested nor pending, and
   * the faulted `close()` that followed reconciled only the segment. The queue
   * is emptied here rather than left to look "still to be written", because a
   * faulted writer will never write it: `enqueue` refuses from now on and
   * `drain()` refuses to run.
   *
   * Group 1 was the round-3 gap. It used to be "the frames since the last
   * successful `fsync`", which is the *durability* question, not the
   * *accountability* one. A segment that ends unmanifested — the usual outcome
   * of a write or `fsync` failure, under §9.1's watermark rule — holds records
   * no manifest will ever name, and the earlier-fsynced ones among them were
   * being handed to nobody.
   */
  #enterFault(error: unknown, extraFrames: readonly QueuedFrame[] = []): void {
    const active = this.#active;
    if (this.#state !== "faulted") {
      this.#state = "faulted";
      this.#writeFaults += 1;
      // How many of the active segment's records are already accounted for
      // elsewhere — that is, are *not* in the pending list about to be built.
      // Read before `#segmentRecords` is drained, and deliberately not taken
      // from `durableRecordCount`: `finalize()` advances that on its footer
      // fsync while those same records are still retained here, and using it as
      // the pivot made the pending list and a retried manifest both claim them
      // (round-2 HIGH-1b).
      this.#segmentRecordsAccountedDurable = Math.max(
        (active?.recordCount ?? 0) - this.#segmentRecords.length,
        0,
      );
    }
    if (this.#segmentRecords.length > 0 || extraFrames.length > 0) {
      this.#pending.push(
        ...this.#segmentRecords,
        ...extraFrames.map((frame) => frame.record),
      );
      this.#segmentRecords = [];
    }
    this.#absorbQueueIntoPending();
    this.#options.observer.onWriteFault?.({
      segmentId: active?.segmentId ?? null,
      pendingFrames: this.#pending.length,
      error,
      atMs: this.#options.clock.nowMs(),
    });
  }

  /**
   * Move every still-queued frame into `pendingFrames()`.
   *
   * Order is preserved because nothing can be enqueued once the writer is
   * faulted, so the queue's contents are strictly the youngest accepted frames.
   * Idempotent: an empty queue makes it a no-op.
   */
  #absorbQueueIntoPending(): void {
    const remaining = this.#queue.takeAll();
    this.#invalidateProjection();
    if (remaining.length > 0) {
      this.#pending.push(...remaining.map((frame) => frame.record));
    }
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
   * Framing overhead currently reserved against `maxTotalBytes`.
   *
   * A segment costs a header line and a footer line beyond its records, and
   * neither exists yet when the frames are admitted. The reservation is the
   * active segment's footer plus one header-and-footer for each further segment
   * the queued frames will need, where "will need" is decided by packing the
   * real frame sizes with the real rotation rule rather than by dividing bytes
   * by `maxSegmentBytes`. Header and footer lengths are computed from the real
   * gateway epoch and the real segment ids, with numeric fields taken at their
   * widest (`Number.MAX_SAFE_INTEGER`) and a small fixed slack, so the
   * reservation is an over-estimate and never an under-estimate.
   *
   * `docs/contracts/wal-format.md` §11.1 states the bound this enforces and the
   * one case it does not cover.
   */
  #reservedOverheadBytes(): number {
    const active = this.#active;
    return (
      (active === null ? 0 : this.#activeFooterReserveBytes) + this.#currentProjection().overhead
    );
  }

  /** The committed projection for the frames currently queued. */
  #currentProjection(): CapacityProjection {
    if (this.#projection === null) {
      this.#projection = this.#packFrames(this.#queue.queuedByteLengths());
    }
    return this.#projection;
  }

  /**
   * Drop the projection because the ground it stood on moved — a segment opened,
   * rotated, or grew, or the queue was emptied. The next admission decision
   * rebuilds it from the frames actually queued.
   */
  #invalidateProjection(): void {
    this.#projection = null;
  }

  /**
   * Pack `frameByteLengths` into segments the way `drain()` will, starting from
   * the active segment's remaining room.
   *
   * Mirrors `#rotationReason`: a frame goes into the current segment when it
   * still fits, otherwise it starts a new one — and a record larger than
   * `maxSegmentBytes` is never split, so it occupies a segment of its own.
   */
  #packFrames(
    frameByteLengths: readonly number[],
    from: CapacityProjection = this.#emptyProjection(),
  ): CapacityProjection {
    const maxSegmentBytes = this.#options.maxSegmentBytes;
    let { newSegments, roomLeft, overhead, nextRecordAlwaysFits } = from;
    for (const length of frameByteLengths) {
      if (nextRecordAlwaysFits || length <= roomLeft) {
        roomLeft = Math.max(roomLeft - length, 0);
      } else {
        newSegments += 1;
        const segmentIndex = this.#nextSegmentIndex + newSegments - 1;
        overhead += this.#segmentOverheadReserve(segmentIndex);
        roomLeft = Math.max(
          maxSegmentBytes - this.#segmentHeaderReserve(segmentIndex) - length,
          0,
        );
      }
      nextRecordAlwaysFits = false;
    }
    return { newSegments, roomLeft, overhead, nextRecordAlwaysFits };
  }

  /** The projection for an empty backlog: whatever room the active segment has. */
  #emptyProjection(): CapacityProjection {
    const active = this.#active;
    return {
      newSegments: 0,
      roomLeft:
        active === null ? 0 : Math.max(this.#options.maxSegmentBytes - active.byteLength, 0),
      overhead: 0,
      nextRecordAlwaysFits: active !== null && active.recordCount === 0,
    };
  }

  /** Worst-case header + footer bytes for the segment at `segmentIndex`. */
  #segmentOverheadReserve(segmentIndex: number): number {
    const cached = this.#overheadReserveCache.get(segmentIndex);
    if (cached !== undefined) {
      return cached;
    }
    const reserve =
      this.#segmentHeaderReserve(segmentIndex) +
      footerReserveBytes(this.#reserveSegmentId(segmentIndex), this.#options.gatewayEpoch);
    this.#overheadReserveCache.set(segmentIndex, reserve);
    return reserve;
  }

  /** Worst-case header bytes for the segment at `segmentIndex`. */
  #segmentHeaderReserve(segmentIndex: number): number {
    const cached = this.#headerReserveCache.get(segmentIndex);
    if (cached !== undefined) {
      return cached;
    }
    const reserve = headerReserveBytes(
      this.#reserveSegmentId(segmentIndex),
      this.#options.gatewayEpoch,
      segmentIndex,
    );
    this.#headerReserveCache.set(segmentIndex, reserve);
    return reserve;
  }

  /**
   * The id width the capacity reservation charges for a future segment.
   *
   * The default factory is a **pure function of the epoch and the ordinal** — it
   * ignores `createdAtMs` — so its id can be computed now and will be identical
   * at open, and the reservation is exact. Any injected factory is charged the
   * documented maximum instead: it may fold the creation time into its id, and a
   * width measured at admission then bears no relation to the width written at
   * open. `#openSegment` enforces the same bound on the id it actually gets, so
   * the reservation is an upper bound for *every* factory, not only for
   * well-behaved ones (`docs/contracts/wal-format.md` §11.2).
   *
   * This is also why the reservation no longer reads the clock: for the default
   * factory there is nothing to read, and for an injected one the answer would
   * be worthless.
   */
  #reserveSegmentId(segmentIndex: number): string {
    if (this.#options.segmentIdFactory !== defaultSegmentIdFactory) {
      return WIDEST_INJECTED_SEGMENT_ID;
    }
    return defaultSegmentIdFactory({
      gatewayEpoch: this.#options.gatewayEpoch,
      segmentIndex,
      createdAtMs: 0,
    });
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
    let synced: { readonly bytes: number; readonly records: number; readonly proven: boolean };
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
    // A successful fsync advances the segment's durability watermark and
    // nothing else. It does **not** release the records from `#segmentRecords`:
    // durability decides what a manifest may claim, accountability ends only
    // when a manifest actually claims it. Releasing here is what left an
    // earlier-fsynced record in neither the manifest nor `pendingFrames()` when
    // a later failure froze the watermark short of the file (round-3 HIGH).
    //
    // `synced.proven` is not branched on because it cannot be `false` here: a
    // watermark freezes only on a failure, every failure faults the writer, and
    // a faulted writer runs no further `drain`, `tick`, `flush`, or `rotate` —
    // the fault path uses `syncForFaultClose()` instead, which is where an
    // unproven result is expected and handled. `synced.records` is `0` on a
    // frozen watermark in any case, so the counter stays honest either way.
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
    const context: SegmentIdContext = {
      gatewayEpoch: this.#options.gatewayEpoch,
      segmentIndex,
      createdAtMs,
    };
    // Checked before anything is created. An id past the bound is a factory
    // contract violation, and the honest answer is to refuse loudly: the
    // alternative is a header and a footer the capacity reservation never
    // charged for, which turns the documented hard threshold into a suggestion.
    const segmentId = assertSegmentIdWithinBound(
      this.#options.segmentIdFactory(context),
      context,
    );
    const reservedIdBytes = encodedSegmentIdBytes(this.#reserveSegmentId(segmentIndex));
    if (encodedSegmentIdBytes(segmentId) > reservedIdBytes) {
      // Only reachable if `segmentIdFactory` is the default one and answered
      // differently than its own pure definition — impossible today, and
      // asserted rather than assumed, because it is the single premise the
      // capacity bound rests on for the default path.
      throw new WalConfigurationError(
        "segmentIdFactory returned a wider segment id than the capacity reservation charged",
        {
          segmentIndex,
          encodedBytes: encodedSegmentIdBytes(segmentId),
          reservedBytes: reservedIdBytes,
        },
      );
    }
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
    this.#invalidateProjection();
    this.#nextSegmentIndex += 1;
    this.#segmentsOpened += 1;
    this.#bytesWritten += active.byteLength;
    this.#totalSegmentBytes += active.byteLength;
    // In the ledger before any frame is appended to it.
    this.#capacityLedger?.recordOwn(path, this.#options.directoryPath, active.byteLength, false);
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
    this.#capacityLedger?.recordOwn(
      active.path,
      this.#options.directoryPath,
      active.byteLength,
      false,
    );
    // The active segment grew, so the room the projection assumed is stale.
    this.#invalidateProjection();
    // On disk, and still the writer's responsibility — until a manifest names
    // it. Not until an fsync proves it: see `#segmentRecords`.
    this.#segmentRecords.push(...batch.map((frame) => frame.record));
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
    this.#invalidateProjection();
    // The manifest is on disk and names every record in this segment, so
    // accountability for them transfers here — the one place it may, and the
    // same rule the fault path follows (round-2 HIGH-1b). `finalize()` writes
    // the sidecar last, so reaching this line means the claim actually landed.
    this.#segmentRecords = [];
    this.#segmentsFinalized += 1;
    if (reason !== "shutdown") {
      this.#rotations += 1;
    }
    // finalize() fsyncs, so everything that was unsynced is now durable.
    this.#framesDurable += unsyncedRecordsBefore;
    this.#bytesWritten += manifest.byteSize - byteLengthBefore;
    this.#totalSegmentBytes += manifest.byteSize - byteLengthBefore;
    // Sealed: its manifest is on disk, so the file can no longer change.
    this.#capacityLedger?.recordOwn(active.path, this.#options.directoryPath, manifest.byteSize, true);
    this.#fsyncCount += 1;
    this.#lastFsyncMonotonicMs = this.#options.clock.monotonicMs();
    this.#options.observer.onSegmentFinalized?.(manifest);
    return manifest;
  }

  /**
   * Close a segment whose in-memory state can no longer be trusted.
   *
   * Two rules govern it, and between them they make the accepted-frame
   * invariant hold across a fault:
   *
   * 1. **A manifest never names a record whose durability is unproven.** The
   *    segment's durability watermark — the last `fsync` that succeeded with no
   *    earlier failure on its handle — is the only evidence there is. A last
   *    `fsync` is still attempted, because on a handle with no failure history
   *    it genuinely proves the bytes a torn append left behind; but on a frozen
   *    watermark its success proves nothing and is not believed
   *    (`segment-writer.ts`, "The durability watermark"). If the watermark does
   *    not cover the whole verified prefix, **no manifest is written at all**:
   *    the format has no way to describe a segment partially, and a manifest
   *    that named the uncovered records would be exactly the claim a power loss
   *    falsifies.
   * 2. **Accountability transfers at the manifest write and nowhere else.**
   *    Frames leave `pendingFrames()` only in the same step in which a manifest
   *    that names them lands on disk. A failed sidecar write therefore leaves
   *    every frame with the caller and the segment unmanifested — retryable, and
   *    never counted twice. Before round 2 the two halves were separate, so two
   *    sidecar failures returned the frames to the caller while a third,
   *    successful attempt still wrote a manifest declaring them: "never by both"
   *    violated.
   *
   * An unmanifested segment keeps its bytes, stays unverified and invisible to a
   * compactor (§2), and is finalized by recovery on the next open — which is a
   * disclosed duplicate source (`wal-format.md` §12), and the deliberate trade
   * against losing a frame.
   *
   * The two rules only add up to the invariant because `#enterFault()` has
   * already handed back **every** record of this segment, not only the ones no
   * `fsync` covered. Rule 1 makes an unmanifested segment the normal outcome of
   * a failure, so anything released before the manifest write is released to
   * nobody — which is the round-3 finding, and why `#segmentRecords` is keyed to
   * the manifest rather than to the watermark (`wal-format.md` §10.2).
   */
  async #finalizeFaultedSegment(): Promise<WalSegmentManifest | null> {
    // A fault raised where no frame was in flight — `tick()` is the one that
    // bites — leaves the queue full of accepted frames nobody will ever write.
    this.#absorbQueueIntoPending();
    const active = this.#active;
    if (active === null) {
      return null;
    }

    const watermark = await active.syncForFaultClose();
    await active.abandon();

    const scan = await scanSegment(this.#options.fileSystem, active.path, {
      onIssue: "collect",
      expectedSegmentId: active.segmentId,
    });

    let byteSize = scan.byteSize;
    // A torn append can leave whole records on disk that no `recordOwn`
    // counted. The writer admits nothing once faulted, but its count still
    // never reads below the disk: the larger of the two stays.
    this.#capacityLedger?.observe(active.path, this.#options.directoryPath, scan.byteSize, false);
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
    // Everything the manifest would claim must sit at or below the watermark.
    const provenDurable =
      watermark.recordCount >= scan.recordCount && watermark.byteLength >= byteSize;

    if (!verifiable || !provenDurable || scan.header === null) {
      // Either the bytes cannot be verified — an unverifiable segment must not
      // be offered to a compactor (ADR-004 §3, §5) — or their durability cannot
      // be proven. Either way no manifest is written, so nothing on this segment
      // counts as recorded and every frame stays with the caller.
      this.#abandonFaultedSegment();
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
      segmentIdKind: segmentIdKindFor(
        active.segmentId,
        scan.header.gatewayEpoch,
        scan.header.segmentIndex,
      ),
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
    // finalizes it if the process dies first. Nothing above has changed the
    // pending list, so a failed attempt costs the caller nothing.
    await writeSegmentManifest(
      this.#options.fileSystem,
      this.#options.directoryPath,
      manifest,
    );
    // The manifest is on disk. *Now* the records it names leave the caller's
    // hands, in the same step, so no observer can ever see them in both places.
    // They are the leading entries of the pending list: the segment's records
    // beyond the ones already accounted for as durable, in accept order.
    // Truncated to `byteSize` and sealed by the manifest just written.
    this.#capacityLedger?.recordOwn(active.path, this.#options.directoryPath, byteSize, true);
    const manifested = Math.min(
      Math.max(scan.recordCount - this.#segmentRecordsAccountedDurable, 0),
      this.#pending.length,
    );
    this.#pending = this.#pending.slice(manifested);
    this.#framesDurable += manifested;
    this.#active = null;
    this.#activeFooterReserveBytes = 0;
    this.#invalidateProjection();
    this.#segmentsFinalized += 1;
    this.#options.observer.onSegmentFinalized?.(manifest);
    return manifest;
  }

  /**
   * Give up on the faulted segment without a manifest: it keeps its bytes, gets
   * no durability claim, and every frame it might hold stays with the caller.
   */
  #abandonFaultedSegment(): void {
    this.#active = null;
    this.#activeFooterReserveBytes = 0;
    this.#invalidateProjection();
    this.#unmanifestedFaultedSegments += 1;
  }
}
