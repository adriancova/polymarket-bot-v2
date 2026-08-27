/**
 * Typed errors for the write-ahead log (handoff §21: "Errors are typed and
 * observable").
 *
 * Every error carries a stable `code` so callers can branch without string
 * matching on messages, and a `details` bag so an operator sees the offending
 * segment, line, or byte offset in a structured log.
 */

export type WalErrorCode =
  /** A `RawFrameRecord` handed to the writer, or read back from disk, is not a valid §9.1 record. */
  | "WAL_RECORD_INVALID"
  /** A segment file violates the on-disk format in a way that is not an incomplete final record. */
  | "WAL_SEGMENT_INTEGRITY"
  /** A segment manifest (sidecar) is unreadable or disagrees with its segment. */
  | "WAL_MANIFEST_INVALID"
  /** The writer was used in a state that forbids the operation (closed, faulted). */
  | "WAL_WRITER_STATE"
  /** An append/fsync failed; the active segment can no longer be trusted in memory. */
  | "WAL_WRITE_FAULT"
  /** Writer configuration is self-contradictory or out of range. */
  | "WAL_CONFIGURATION";

export type WalErrorDetails = Readonly<Record<string, unknown>>;

/** Base class for every error this package raises. */
export class WalError extends Error {
  readonly code: WalErrorCode;
  readonly details: WalErrorDetails;

  constructor(code: WalErrorCode, message: string, details: WalErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/**
 * A raw frame is not a valid §9.1 `RawFrameRecord`.
 *
 * This is thrown synchronously from `enqueue`, which makes it a caller error
 * rather than a dropped frame: the caller still holds the frame and must decide
 * what to do with it (§8.3 forbids silent drops).
 */
export class WalRecordValidationError extends WalError {
  constructor(message: string, details: WalErrorDetails = {}) {
    super("WAL_RECORD_INVALID", message, details);
  }
}

/**
 * A segment file is corrupt in a way recovery may not repair.
 *
 * ADR-004 §3: recovery truncates only an incomplete final record. Anything else
 * — a malformed middle record, a missing header, a checksum mismatch, bytes
 * after the footer — is a data-quality incident, not a recovery case.
 */
export class WalSegmentIntegrityError extends WalError {
  constructor(message: string, details: WalErrorDetails = {}) {
    super("WAL_SEGMENT_INTEGRITY", message, details);
  }
}

/** A sidecar manifest is unreadable, malformed, or disagrees with its segment. */
export class WalManifestError extends WalError {
  constructor(message: string, details: WalErrorDetails = {}) {
    super("WAL_MANIFEST_INVALID", message, details);
  }
}

/** The writer is closed or faulted and cannot perform the requested operation. */
export class WalWriterStateError extends WalError {
  constructor(message: string, details: WalErrorDetails = {}) {
    super("WAL_WRITER_STATE", message, details);
  }
}

/**
 * An append or fsync failed.
 *
 * The writer transitions to `faulted`, retains every frame that is not known to
 * be durable in `pendingFrames()`, and refuses further enqueues. Nothing is
 * discarded.
 */
export class WalWriteFaultError extends WalError {
  constructor(message: string, details: WalErrorDetails = {}) {
    super("WAL_WRITE_FAULT", message, details);
  }
}

/** Writer configuration is invalid (non-positive bound, contradictory limits). */
export class WalConfigurationError extends WalError {
  constructor(message: string, details: WalErrorDetails = {}) {
    super("WAL_CONFIGURATION", message, details);
  }
}
