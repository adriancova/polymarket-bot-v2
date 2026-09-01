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
  | "RETENTION_GUARD"
  /** Verified segments span gateway epochs with no defined chronology. */
  | "CROSS_EPOCH_ORDER"
  /** The candidate segments exceed the per-run compaction batch bound. */
  | "BATCH_LIMIT";

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

/**
 * Verified segments span more than one gateway epoch.
 *
 * A gateway epoch is an identity, not a timestamp: `wal-format.md` §4 gives
 * `segmentIndex` per-directory meaning *within* an epoch and defines no
 * ordering between epochs, and an epoch UUID's lexical order says nothing
 * about which epoch came first. §8.4 requires replay to consume recorded
 * dispatch order, so a compactor that invented a cross-epoch chronology —
 * lexical, mtime-based, or otherwise — would fabricate exactly the ordering
 * replay treats as ground truth. Until the WAL contract defines cross-epoch
 * chronology, a mixed-epoch input is refused whole: the caller may compact one
 * epoch at a time by passing `segmentIds`.
 */
export class CrossEpochOrderError extends CompactionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("CROSS_EPOCH_ORDER", message, details);
  }
}

/**
 * The candidate segments exceed `maxTotalBatchBytes`.
 *
 * The compactor holds every verified segment's records in memory for the whole
 * run (dispatch ordinals and deduplication span segments), so its resident set
 * is bounded by the total bytes of the batch, not by one segment. The bound is
 * enforced *before* any segment is read, and exceeding it refuses the run
 * rather than degrading it: nothing is uploaded, nothing is deleted, and the
 * WAL is untouched — the ADR-004 failure direction. The caller compacts in
 * bounded batches by passing `segmentIds` subsets, or raises the bound
 * deliberately.
 */
export class CompactionBatchLimitError extends CompactionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("BATCH_LIMIT", message, details);
  }
}
