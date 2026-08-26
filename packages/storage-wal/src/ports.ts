/**
 * Injected ports.
 *
 * Nothing in this package reads a clock, a filesystem, or a random source
 * directly: every one of them arrives through a port (handoff §12.1, §12.4).
 * That is what lets the fault-injection suite simulate a torn write, a full
 * disk, or a clock jump without touching a real disk, and what keeps the
 * writer's behavior reproducible.
 */

import type { RawFrameRecord } from "./raw-frame.js";
import type { WalSegmentManifest } from "./manifest.js";
import type { WalRecoveryReport } from "./recovery.js";

/**
 * Time source.
 *
 * `nowMs` supplies the wall-clock timestamps written to disk; `monotonicMs`
 * drives every *interval* decision (segment age, fsync interval) so that a
 * wall-clock step does not rotate or flush spuriously.
 */
export interface WalClock {
  /** Wall-clock milliseconds since the Unix epoch. */
  nowMs(): number;
  /** Monotonic milliseconds from an arbitrary origin. */
  monotonicMs(): number;
}

/** An append-only handle on one segment file. */
export interface WalAppendHandle {
  /**
   * Append the bytes to the end of the file.
   *
   * Implementations must write all bytes or throw. A partial write followed by
   * a throw is exactly the crash the recovery path handles, so an implementation
   * that can detect it should report how many bytes reached the file in the
   * error details.
   */
  append(bytes: Uint8Array): Promise<void>;
  /** Flush this file's data and metadata to durable storage (`fsync`). */
  sync(): Promise<void>;
  /** Close the handle. */
  close(): Promise<void>;
}

/** A read handle used for sequential segment scans. */
export interface WalReadHandle {
  /** Read up to `length` bytes at `offset`; a short result means end of file. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * The filesystem surface the WAL needs — deliberately small, and deliberately
 * without a delete operation.
 *
 * ADR-004 §5: compaction never deletes a WAL segment until Parquet upload and
 * checksum verification both succeed. `WP-050` owns no deletion path at all, so
 * the capability is absent from the port rather than merely unused.
 */
export interface WalFileSystem {
  /** Create the directory (and parents) if it does not exist. */
  ensureDirectory(directoryPath: string): Promise<void>;
  /** File names (not paths) directly inside the directory. */
  listFileNames(directoryPath: string): Promise<readonly string[]>;
  /** Byte length of a file, or `null` when it does not exist. */
  fileByteLength(path: string): Promise<number | null>;
  /** Open (creating if needed) a file for appending. */
  openAppend(path: string): Promise<WalAppendHandle>;
  /** Open an existing file for reading. */
  openRead(path: string): Promise<WalReadHandle>;
  /** Read a whole (small) file, used for manifests. */
  readWholeFile(path: string): Promise<Uint8Array>;
  /** Write a whole (small) file durably, used for manifests. */
  writeWholeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** Truncate a file to `byteLength`. Used only to remove an incomplete final record. */
  truncate(path: string, byteLength: number): Promise<void>;
  /** Join path segments with the implementation's separator. */
  joinPath(...segments: readonly string[]): string;
}

/** Context handed to a segment id factory. */
export type SegmentIdContext = {
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly createdAtMs: number;
};

/**
 * Produces segment identifiers.
 *
 * Injected rather than generated internally so no randomness or wall clock is
 * baked into identity (§12.4). The default is a pure function of the epoch and
 * the per-directory ordinal.
 */
export type SegmentIdFactory = (context: SegmentIdContext) => string;

/** Reason a segment stopped accepting records. */
export type WalCloseReason =
  | "size-rotation"
  | "time-rotation"
  | "manual-rotation"
  | "shutdown"
  | "recovery"
  | "write-fault";

/** Why the writer refused a frame. Never "it was dropped". */
export type WalRefusalReason =
  /** The bounded queue is at its frame or byte capacity (§8.3). */
  | "queue-overflow"
  /** The configured hard WAL capacity threshold is reached (§4.2). */
  | "capacity-exceeded"
  /** The writer is closed. */
  | "writer-closed"
  /** A previous append or fsync failed; the writer is faulted. */
  | "writer-faulted";

/** Result of offering a frame to the writer. */
export type WalEnqueueResult =
  | {
      readonly accepted: true;
      readonly queueDepth: number;
    }
  | {
      readonly accepted: false;
      readonly reason: WalRefusalReason;
      readonly queueDepth: number;
      readonly detail: string;
    };

/** Emitted when the writer refuses a frame. The frame still belongs to the caller. */
export type WalOverflowEvent = {
  readonly reason: WalRefusalReason;
  readonly detail: string;
  readonly record: RawFrameRecord;
  readonly queueDepth: number;
  readonly queueCapacity: number;
  readonly atMs: number;
};

/** Emitted on every successful fsync. */
export type WalFsyncEvent = {
  readonly segmentId: string;
  readonly syncedBytes: number;
  readonly syncedRecords: number;
  readonly trigger: "byte-threshold" | "interval" | "explicit" | "finalize";
  readonly durationMs: number;
  readonly atMs: number;
};

/** Emitted when a segment file is created. */
export type WalSegmentOpenedEvent = {
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly gatewayEpoch: string;
  readonly path: string;
  readonly atMs: number;
};

/** Emitted when an append or fsync fails and the writer becomes faulted. */
export type WalWriteFaultEvent = {
  readonly segmentId: string | null;
  readonly pendingFrames: number;
  readonly error: unknown;
  readonly atMs: number;
};

/** Emitted when a frame's `ingestSeq` does not advance past its predecessor. */
export type WalIngestSeqAnomalyEvent = {
  readonly segmentId: string | null;
  readonly previousIngestSeq: string;
  readonly ingestSeq: string;
  readonly atMs: number;
};

/**
 * Observation hooks.
 *
 * The writer never decides policy from these; it reports. The gateway
 * (`WP-120`) turns an overflow or an integrity failure into a data-quality
 * incident (§8.3, ADR-004 §4).
 */
export interface WalWriterObserver {
  onOverflow?(event: WalOverflowEvent): void;
  onSegmentOpened?(event: WalSegmentOpenedEvent): void;
  onSegmentFinalized?(manifest: WalSegmentManifest): void;
  onFsync?(event: WalFsyncEvent): void;
  onRecovery?(report: WalRecoveryReport): void;
  onWriteFault?(event: WalWriteFaultEvent): void;
  onIngestSeqAnomaly?(event: WalIngestSeqAnomalyEvent): void;
}
