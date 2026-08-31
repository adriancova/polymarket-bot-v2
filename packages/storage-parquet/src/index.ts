/**
 * `@polymarket-bot/storage-parquet` — WAL compaction, checksummed Parquet, and
 * immutable dataset manifests (`WP-130`).
 *
 * Authority: handoff §2 (raw archive is an append-only WAL compacted into
 * checksummed Parquet in object storage), §8.4 (replay ordering and what a
 * dataset manifest contains), §9.1 (compaction never deletes a WAL segment
 * until Parquet upload and checksum verification succeed), §10.2
 * (`data.raw_segments`, `data.dataset_manifests`), §12.5 (the replay pin list),
 * §14.3 (compaction lag and object upload status), and
 * [ADR-004](../../docs/adr/ADR-004-wal-format-durability-and-compaction.md),
 * which is **binding** for the format, durability, and compaction decisions.
 *
 * Layer: adapters/infrastructure (`docs/contracts/dependency-direction.md` §2,
 * layer 2). It declares **no workspace dependency at all** — in particular not
 * `packages/storage-wal`, which is the same layer and would be an unlisted
 * same-layer edge (F13). It consumes the WAL's published on-disk format
 * (`docs/contracts/wal-format.md`) through its own reader; see
 * {@link ./wal-format.js} for the full reasoning.
 *
 * Typical use from a composition root:
 *
 * ```ts
 * const result = await compactWalDirectory({
 *   walDirectoryPath: "/var/lib/polymarket-bot/wal",
 *   datasetId: "2026-01-01T00-00Z",
 *   objectKeyPrefix: "datasets/2026-01-01T00-00Z",
 *   objectStore: fileSystemObjectStore("/var/lib/polymarket-bot/objects"),
 *   fileSystem: nodeCompactionFileSystem(),
 *   clock: systemCompactionClock(),
 *   incidentWindows,
 *   // retention defaults to `retainAllWalSegments()`: nothing is deleted.
 * });
 * ```
 *
 * **No credential, no network, and no cloud SDK exists in this package**, and
 * none is needed: the object-storage boundary is the {@link ObjectStore}
 * interface, and the shipped implementation is a local directory.
 */

export {
  DATASET_MANIFEST_DIGEST_OBJECT_NAME,
  DATASET_MANIFEST_FORMAT_ID,
  DATASET_MANIFEST_OBJECT_NAME,
  DATASET_MANIFEST_VERSION,
  DATASET_RETENTION_RECEIPT_OBJECT_NAME,
  DEFAULT_MAX_LISTED_DUPLICATE_KEYS,
  DEFAULT_MAX_RECORD_BYTES,
  DEFAULT_MAX_SEGMENT_BYTES,
  DEFAULT_MAX_TOTAL_BATCH_BYTES,
  DEFAULT_ROW_GROUP_SIZE,
  PARQUET_LAYOUT_ID,
  PARQUET_LAYOUT_VERSION,
  PARQUET_OBJECT_SUFFIX,
  RETENTION_RECEIPT_FORMAT_ID,
  RETENTION_RECEIPT_VERSION,
  SUPPORTED_WAL_MANIFEST_VERSION,
  SUPPORTED_WAL_SCHEMA_VERSION,
  WAL_FORMAT_ID,
  WAL_MANIFEST_FILE_SUFFIX,
  WAL_SEGMENT_FILE_SUFFIX,
} from "./constants.js";

export {
  CompactionBatchLimitError,
  CompactionConfigurationError,
  CompactionError,
  CrossEpochOrderError,
  DatasetManifestError,
  DuplicateDivergenceError,
  ObjectImmutabilityError,
  ObjectVerificationError,
  RetentionGuardError,
  type CompactionErrorCode,
} from "./errors.js";

export {
  buildRetentionReceipt,
  encodeRetentionReceipt,
  retentionReceiptDigest,
  type RetentionReceipt,
  type RetentionReceiptDeletion,
  type RetentionReceiptFailure,
} from "./retention-receipt.js";

export {
  verifyRetentionProof,
  type RetentionProofContext,
} from "./retention-proof.js";

export {
  compareUnsignedIntegerStrings,
  defaultSegmentId,
  encodeFrameLine,
  parseRawFrameRecord,
  parseWalSegmentManifest,
  readWalSegment,
  segmentIdFromManifestFileName,
  sha256Hex,
  walManifestFileName,
  walSegmentFileName,
  RAW_FRAME_RECORD_KEYS,
  type RawFrameRecord,
  type ReadWalSegmentOptions,
  type WalCloseReason,
  type WalRecordEntry,
  type WalSegmentBytesSource,
  type WalSegmentFooter,
  type WalSegmentHeader,
  type WalSegmentIdKind,
  type WalSegmentIssue,
  type WalSegmentIssueCode,
  type WalSegmentManifest,
  type WalSegmentReadResult,
} from "./wal-format.js";

export {
  findContainingWindow,
  validateIncidentWindows,
  windowContains,
  type IncidentKind,
  type IncidentWindow,
  type IncidentWindowProblem,
} from "./incidents.js";

export {
  buildColumnData,
  datasetRowFromWalRecord,
  reconstructFrameLine,
  rowReproducesItsSourceLine,
  DATASET_COLUMNS,
  DATASET_COLUMN_NAMES,
  DATASET_LAYOUT,
  type ColumnData,
  type DatasetColumnName,
  type DatasetColumnPhysicalType,
  type DatasetColumnSpec,
  type DatasetRow,
  type RowExclusionReason,
} from "./parquet-layout.js";

export {
  parquetObjectRowCount,
  readParquetObject,
  writeParquetObject,
  type DatasetCodec,
  type DecodedDatasetRow,
  type ParquetObjectBytes,
  type WriteParquetObjectOptions,
} from "./parquet-object.js";

export {
  currentColumnPins,
  currentSchemaVersions,
  datasetManifestDigest,
  emptyReplayPins,
  encodeDatasetManifest,
  parseDatasetManifest,
  REPLAY_PINS_NOTE,
  type DatasetColumnPin,
  type DatasetManifest,
  type DatasetObjectEntry,
  type DatasetRecordCounts,
  type DatasetSchemaVersions,
  type DatasetSegmentEntry,
  type DatasetWriterInfo,
  type DeduplicationSummary,
  type EventIdentity,
  type ExcludedIncidentWindowEntry,
  type ExcludedSegmentEntry,
  type ReplayPins,
} from "./dataset-manifest.js";

export {
  compactWalDirectory,
  listManifestedSegmentIds,
  PARQUET_WRITER_LIBRARY,
  PARQUET_WRITER_LIBRARY_VERSION,
  type CompactionOptions,
  type CompactionResult,
} from "./compactor.js";

export {
  deleteAfterVerifiedUploadRetention,
  ensureDirectory,
  fileSystemObjectStore,
  isoFromEpochMs,
  nodeCompactionFileSystem,
  systemCompactionClock,
  writeWholeFileDurably,
} from "./node-file-system.js";

export { retainAllWalSegments } from "./ports.js";

export type {
  CompactionClock,
  CompactionFileSystem,
  CompactionObserver,
  DatasetManifestWrittenEvent,
  ObjectHead,
  ObjectStore,
  ObjectUploadedEvent,
  ObjectVerifiedEvent,
  SegmentDeletedEvent,
  SegmentDeletionRequest,
  SegmentRefusedEvent,
  SegmentVerifiedEvent,
  WalSegmentRetention,
} from "./ports.js";
