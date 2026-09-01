/**
 * Injected ports.
 *
 * Nothing in this package reaches for a filesystem, a clock, or an object store
 * directly (handoff §12.1, §12.4). That is what makes a compaction run
 * reproducible in a test without a disk, and what keeps the object-storage
 * boundary a boundary: the handoff mandates "checksummed Parquet in object
 * storage" (§2) but names no vendor, so there is **no cloud SDK dependency in
 * this package** and none is needed. A deployment that wants S3 writes an
 * adapter against {@link ObjectStore}.
 */

/** Time source. Wall clock for timestamps, monotonic clock for durations. */
export interface CompactionClock {
  /** Wall-clock milliseconds since the Unix epoch. */
  nowMs(): number;
  /** Monotonic milliseconds from an arbitrary origin. */
  monotonicMs(): number;
}

/**
 * The read-only filesystem surface a compactor needs over a WAL directory.
 *
 * Read-only **by construction**: deletion is a separate port
 * ({@link WalSegmentRetention}) so that "the compactor can delete a segment"
 * is a capability a deployment grants explicitly, rather than one that comes
 * attached to the ability to read.
 */
export interface CompactionFileSystem {
  /** File names (not paths) directly inside a directory. */
  listFileNames(directoryPath: string): Promise<readonly string[]>;
  /** Byte length of a file, or `null` when it does not exist. */
  fileByteLength(path: string): Promise<number | null>;
  /** Read a whole file. */
  readWholeFile(path: string): Promise<Uint8Array>;
  /** Join path segments with the implementation's separator. */
  joinPath(...segments: readonly string[]): string;
}

/** What an object store reports about a stored object without fetching it. */
export type ObjectHead = {
  readonly byteLength: number;
};

/**
 * The object-storage boundary.
 *
 * Three operations, because verification needs all three: `put` writes,
 * `head` establishes existence cheaply, and `get` is what makes the checksum
 * claim real. ADR-004 §5 requires "Parquet upload **and checksum verification**"
 * to succeed before a WAL segment may be deleted, and a checksum computed only
 * over the bytes still in this process's memory verifies nothing about what the
 * store kept. The compactor therefore reads every object back.
 */
export interface ObjectStore {
  /**
   * Store bytes under a key.
   *
   * Implementations must be all-or-nothing as observed through `get`: a reader
   * must never see a partially written object under a key. The filesystem
   * implementation in this package writes to a temporary name and renames.
   */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Metadata for a stored object, or `null` when the key does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** Fetch an object's bytes. Rejects when the key does not exist. */
  get(key: string): Promise<Uint8Array>;
}

/**
 * A segment the compactor asks to have deleted.
 *
 * Every field here is a **claim to be re-verified, never proof**. A caller can
 * put any bytes in a request, so an implementation that compared these fields
 * only against each other would delete whatever the caller told it to —
 * round-1 review demonstrated exactly that with an arbitrary object and its
 * own digest. The proof lives in the durable store: the persisted dataset
 * manifest named by `datasetManifestKey` must pin this segment's checksum,
 * record count, object key and object checksum, and the object must actually
 * provide the segment's rows. `verifyRetentionProof` in `retention-proof.ts`
 * performs that check, and every implementation must apply it (or one at least
 * as strong) before unlinking anything.
 */
export type SegmentDeletionRequest = {
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  /** Number of frame records the verified object holds for this segment. */
  readonly recordCount: number;
  /** The segment's own SHA-256, as pinned in the dataset manifest. */
  readonly segmentSha256: string;
  /** The object key whose upload and checksum verification both succeeded. */
  readonly verifiedObjectKey: string;
  /** SHA-256 of the verified object, re-read from the store. */
  readonly verifiedObjectSha256: string;
  /**
   * Key of the dataset manifest that pins this segment. The manifest is
   * persisted and read-back-verified before retention is invoked, so an
   * implementation can — and must — fetch it from the store as the proof.
   */
  readonly datasetManifestKey: string;
};

/**
 * Deletion of WAL segments.
 *
 * **Who deletes, and why it is here.** `packages/storage-wal` deletes nothing
 * and cannot: its filesystem port has no delete operation at all, and
 * `docs/contracts/wal-format.md` §2 says so explicitly — "This package never
 * deletes a file… Deletion belongs to `WP-130`, and only after a verified
 * upload (ADR-004 §5)." So deletion is this work package's responsibility, and
 * it is modelled as an injected capability with three deliberate properties:
 *
 * 1. **It is off by default.** {@link retainAllWalSegments} is the default
 *    retention, and it deletes nothing. A deployment that wants the disk
 *    reclaimed opts in.
 * 2. **It is called only after the dataset manifest and its digest sidecar
 *    are persisted to the store and read-back-verified** — never before. A
 *    segment whose bytes are gone and whose manifest was never persisted is
 *    unrecoverable, and that ordering is what ADR-004's "delete-after-verify"
 *    actually requires. The compactor enforces it mechanically: the manifest
 *    write and verification precede the first `deleteSegment` call, and a
 *    failure there aborts the run with every WAL byte still on disk.
 * 3. **An implementation trusts the store, not the caller.** The request's
 *    fields are claims; the proof is the persisted manifest the request names,
 *    re-fetched from the store and checked against the segment's own bytes and
 *    the object's rows (`retention-proof.ts`). An implementation that skipped
 *    that check would delete whatever its caller asserted.
 *
 * Deletion state is reported afterwards in the retention receipt object
 * (`retention-receipt.ts`), never by mutating the immutable manifest.
 */
export interface WalSegmentRetention {
  /** Human-readable policy name, recorded in the compaction result. */
  readonly policyName: string;
  /**
   * Delete one segment and its sidecar manifest.
   *
   * Called only after {@link SegmentDeletionRequest}'s verification completed.
   * An implementation that fails must throw; the compactor reports the failure
   * and keeps going, because a segment that could not be deleted is a disk-space
   * problem, not a data-integrity one.
   */
  deleteSegment(request: SegmentDeletionRequest): Promise<void>;
}

/**
 * The default retention: keep every WAL segment forever.
 *
 * "Filling the disk is the intended failure direction" (ADR-004, Consequences)
 * — so the safe default is the one that never removes evidence, and reclaiming
 * space is an explicit operational decision.
 */
export function retainAllWalSegments(): WalSegmentRetention {
  return {
    policyName: "retain",
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async deleteSegment(_request: SegmentDeletionRequest): Promise<void> {
      // Intentionally empty: this policy retains.
    },
  };
}

/** A segment was read and fully verified. */
export type SegmentVerifiedEvent = {
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly recordCount: number;
  readonly segmentSha256: string;
};

/** A segment was refused and excluded from the dataset. */
export type SegmentRefusedEvent = {
  readonly segmentId: string;
  readonly issueCodes: readonly string[];
  readonly detail: string;
};

/** An object was written to the store. Not yet verified. */
export type ObjectUploadedEvent = {
  readonly objectKey: string;
  readonly byteLength: number;
  readonly sha256: string;
};

/** An object was read back and reconciled against what was written. */
export type ObjectVerifiedEvent = {
  readonly objectKey: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly rowCount: number;
};

/** A segment's bytes were removed after a verified upload. */
export type SegmentDeletedEvent = {
  readonly segmentId: string;
  readonly verifiedObjectKey: string;
};

/** The dataset manifest object was written and verified. */
export type DatasetManifestWrittenEvent = {
  readonly datasetId: string;
  readonly objectKey: string;
  readonly manifestSha256: string;
  readonly rowCount: number;
};

/**
 * Observation hooks.
 *
 * The compactor never decides policy from these; it reports. §14.3's recorder
 * metric family — compaction lag and object upload status — is assembled by the
 * composition root from these events plus {@link CompactionResult}.
 */
export interface CompactionObserver {
  onSegmentVerified?(event: SegmentVerifiedEvent): void;
  onSegmentRefused?(event: SegmentRefusedEvent): void;
  onObjectUploaded?(event: ObjectUploadedEvent): void;
  onObjectVerified?(event: ObjectVerifiedEvent): void;
  onSegmentDeleted?(event: SegmentDeletedEvent): void;
  onDatasetManifestWritten?(event: DatasetManifestWrittenEvent): void;
}
