/**
 * Errors raised by compaction.
 *
 * The distinction that matters operationally: a **refusal** is data (a segment
 * this compactor will not consume, reported in the result and pinned in the
 * dataset manifest), while an **error** is a failure of the compaction run
 * itself. A corrupt WAL segment therefore does not throw — it is excluded and
 * reported, because ADR-004 §3 makes mid-file corruption a data-quality
 * incident whose range is excluded from dataset manifests, not a crash.
 *
 * What *does* throw is a broken invariant of this package: an object store that
 * hands back bytes different from the ones it was given, a manifest that would
 * overwrite a different manifest under the same key, or a caller-supplied
 * configuration that cannot produce a well-defined dataset.
 */

/** Machine-readable classification of a compaction failure. */
export type CompactionErrorCode =
  /** A caller-supplied option is missing, malformed, or self-contradictory. */
  | "CONFIGURATION"
  /** The object store did not return the bytes that were written to it. */
  | "OBJECT_VERIFICATION"
  /** An object key already exists and holds different bytes. */
  | "OBJECT_IMMUTABILITY"
  /** A dataset manifest could not be built or parsed. */
  | "DATASET_MANIFEST"
  /** Two records share `(gatewayEpoch, ingestSeq)` but differ in content. */
  | "DUPLICATE_DIVERGENCE"
  /** A segment deletion was attempted without a completed verification. */
  | "RETENTION_GUARD";

/** Base class for every error this package raises. */
export class CompactionError extends Error {
  readonly code: CompactionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CompactionErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** A caller-supplied option is missing, malformed, or self-contradictory. */
export class CompactionConfigurationError extends CompactionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("CONFIGURATION", message, details);
  }
}

/**
 * The object store did not return the bytes that were written to it.
 *
 * This is the failure ADR-004 §5 exists to catch: "compaction never deletes a
 * WAL segment until Parquet upload **and checksum verification** both succeed".
 * A store that accepted a write and then served different bytes must stop the
 * run before any retention decision is taken.
 */
export class ObjectVerificationError extends CompactionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("OBJECT_VERIFICATION", message, details);
  }
}

/**
 * An object key already exists and holds different bytes.
 *
 * Dataset objects and dataset manifests are immutable (§12.5: a replay pins a
 * manifest). Re-running a compaction that produces byte-identical output is
 * idempotent and permitted; producing *different* bytes under a key something
 * may already have pinned is not.
 */
export class ObjectImmutabilityError extends CompactionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("OBJECT_IMMUTABILITY", message, details);
  }
}

/** A dataset manifest could not be built or parsed. */
export class DatasetManifestError extends CompactionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("DATASET_MANIFEST", message, details);
  }
}

/**
 * Two records share `(gatewayEpoch, ingestSeq)` and are not byte-identical.
 *
 * Deduplication on that key is mandatory for a consumer of this WAL
 * (`docs/contracts/wal-format.md` §12; the `WP-050` completion record makes it
 * a binding obligation), and it is safe **because** a duplicate is a
 * re-recording of the same frame. Two different frames under one key mean the
 * gateway's sequence assignment is broken, and dropping one of them would pick
 * a winner arbitrarily. The compactor refuses instead.
 */
export class DuplicateDivergenceError extends CompactionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("DUPLICATE_DIVERGENCE", message, details);
  }
}

/** A segment deletion was attempted without a completed verification. */
export class RetentionGuardError extends CompactionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("RETENTION_GUARD", message, details);
  }
}
