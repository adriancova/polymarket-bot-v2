/**
 * Format identity and default bounds for compaction.
 *
 * Two of these constants are **persisted format identity** and are governed by
 * the same rule `docs/contracts/wal-format.md` §12 states for the WAL: a change
 * that an existing reader cannot parse, or that changes the bytes a given input
 * produces, is a version bump, because the persisted bytes and their checksums
 * are the artifact.
 */

/**
 * The WAL on-disk format this package reads.
 *
 * `packages/storage-parquet` is layer 2 and `packages/storage-wal` is layer 2,
 * so an import edge between them would be a same-layer edge, and
 * `docs/contracts/dependency-direction.md` §2.1 is exhaustive and lists no such
 * row (F13). The compactor therefore consumes the **documented on-disk format**
 * (`docs/contracts/wal-format.md`) through its own reader rather than the
 * writer's. These two constants are the coupling point, and the integration
 * suite writes its segments with the real `WP-050` writer so that a divergence
 * fails a test instead of silently producing a wrong dataset.
 */
export const WAL_FORMAT_ID = "polymarket-bot/wal/v1";

/** The WAL segment schema version this reader implements (`wal-format.md` §12). */
export const SUPPORTED_WAL_SCHEMA_VERSION = 1;

/** The WAL sidecar manifest document version this reader implements. */
export const SUPPORTED_WAL_MANIFEST_VERSION = 1;

/** Suffix of a WAL segment file: `<segmentId>.wal.jsonl` (`wal-format.md` §2). */
export const WAL_SEGMENT_FILE_SUFFIX = ".wal.jsonl";

/** Suffix of a WAL sidecar manifest: `<segmentId>.wal.manifest.json`. */
export const WAL_MANIFEST_FILE_SUFFIX = ".wal.manifest.json";

/** Line terminator of the JSON Lines segment format. */
export const LINE_FEED = 0x0a;

/**
 * Identity of the columnar layout this package writes.
 *
 * Bump it for any change to the column set, the column order, the physical
 * types, or the meaning of a column: a dataset manifest pins this string, so a
 * reader can refuse a layout it does not implement instead of misreading it.
 */
export const PARQUET_LAYOUT_ID = "polymarket-bot/parquet-raw-frames/v1";

/** Version number of {@link PARQUET_LAYOUT_ID}, pinned in every dataset manifest. */
export const PARQUET_LAYOUT_VERSION = 1;

/**
 * Identity of the dataset manifest document.
 *
 * **It does not move with the version** (`STORAGE-1`, answering ADR-029
 * Decision 1.2). The rule is the one `docs/contracts/wal-format.md` §12 states
 * for the WAL's own `formatId`: the id is the *coarse discriminator* and
 * changes only for a wholesale format replacement; a new field set is a
 * `datasetManifestVersion` change. Version 2 adds the `fidelity` field and an
 * approximate (research-tier) body under the same document family, so the id
 * stays `polymarket-bot/dataset-manifest/v1` and the version carries the change.
 */
export const DATASET_MANIFEST_FORMAT_ID = "polymarket-bot/dataset-manifest/v1";

/**
 * Document version of the dataset manifest this build **writes**.
 *
 * Version 2 (ADR-029 Decision 1) adds the required `fidelity` field: `exact`
 * for a dataset compacted losslessly from raw WAL, `approximate` for a
 * research-tier dataset. Version 1 has no such field and reads as `exact`
 * (ADR-029 Decision 1.3), because every version 1 dataset was compacted from
 * raw WAL.
 */
export const DATASET_MANIFEST_VERSION = 2;

/** The legacy version: no `fidelity` field; read as `exact`. */
export const DATASET_MANIFEST_VERSION_1 = 1;

/**
 * Every dataset-manifest version this build reads. ADR-029 Consequences:
 * every reader accepts both before any version 2 manifest is written.
 */
export const READABLE_DATASET_MANIFEST_VERSIONS: readonly number[] = [1, 2];

/** The two dataset classes of ADR-029 Decision 1. */
export const DATASET_FIDELITIES = ["exact", "approximate"] as const;

/** A dataset's class (ADR-029 Decision 1.1). */
export type DatasetFidelity = (typeof DATASET_FIDELITIES)[number];

/**
 * Default object-key suffix of a dataset manifest.
 *
 * The manifest is an object like any other, so a replay run that is handed an
 * object store and a dataset id can find it without a directory listing (§8.4:
 * "Replay consumes the manifest, not a directory listing", ADR-004 §5).
 */
export const DATASET_MANIFEST_OBJECT_NAME = "manifest.json";

/** Sidecar holding the lowercase hex SHA-256 of the manifest object's bytes. */
export const DATASET_MANIFEST_DIGEST_OBJECT_NAME = "manifest.sha256";

/**
 * Object holding the retention receipt, next to the dataset manifest.
 *
 * Deletion state is deliberately **not** part of the dataset manifest: the
 * manifest is immutable and is persisted and read-back-verified *before* any
 * deletion is permitted, so at the moment it is written no deletion has
 * happened yet, and recording one there would require mutating an immutable
 * artifact. What retention actually removed is stated afterwards in this
 * separate receipt object. Written only when a deleting retention policy ran.
 */
export const DATASET_RETENTION_RECEIPT_OBJECT_NAME = "retention-receipt.json";

/**
 * Identity of the retention receipt document. Like the dataset manifest's id,
 * it is the coarse discriminator and does not move with the version.
 */
export const RETENTION_RECEIPT_FORMAT_ID = "polymarket-bot/retention-receipt/v1";

/**
 * Document version of the retention receipt this build **writes**.
 *
 * Version 2 (ADR-028 Decision 4.3) gives every deletion entry a `basis`:
 * `verified-upload` (the `WP-130` basis: every deleted record is inside the
 * verified object named) or `expired-after-extract` (the ADR-028 basis: the
 * segment's records are kept only as the verified research tier and the
 * verified pins it names). A reader must still accept version 1, whose
 * entries are all `verified-upload` by construction.
 */
export const RETENTION_RECEIPT_VERSION = 2;

/** Every retention-receipt version this build reads. */
export const READABLE_RETENTION_RECEIPT_VERSIONS: readonly number[] = [1, 2];

/** File extension of a compacted data object. */
export const PARQUET_OBJECT_SUFFIX = ".parquet";

/**
 * Largest WAL segment this compactor will read into memory, in bytes.
 *
 * The compactor builds one Parquet object per segment, so it holds a segment's
 * records while it encodes them. `WP-050`'s default rotation bound is 64 MiB
 * (`DEFAULT_MAX_SEGMENT_BYTES`); this bound is deliberately larger, because
 * `wal-format.md` §8 permits a single over-large record to exceed the rotation
 * bound, and refusing such a segment would strand real data. A segment past
 * this bound is **refused with a stated reason**, never truncated.
 */
export const DEFAULT_MAX_SEGMENT_BYTES = 256 * 1024 * 1024;

/** Largest single JSON Lines record a reader will accept, in bytes. */
export const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;

/**
 * Largest total batch — the summed on-disk bytes of every candidate segment —
 * one compaction run will accept, in bytes.
 *
 * The compactor's resident set is proportional to the **whole batch**, not to
 * one segment: dispatch ordinals and `(gatewayEpoch, ingestSeq)` deduplication
 * span segments, so every verified segment's records stay in memory until the
 * dataset manifest is written. This bound makes that cost a configured number
 * instead of "however much the WAL directory holds". It is checked against
 * file sizes *before* any segment is read; past it the run is refused with
 * {@link ../errors.js CompactionBatchLimitError} and nothing has been touched.
 * A caller compacts a larger backlog in batches via `segmentIds`.
 */
export const DEFAULT_MAX_TOTAL_BATCH_BYTES = 1024 * 1024 * 1024;

/**
 * Rows per Parquet row group.
 *
 * Row groups are the unit a query engine skips; they do not affect row order,
 * which Parquet preserves within a file. Replay ordering is recovered from the
 * `datasetRowOrdinal` column, never from physical layout (§8.4).
 */
export const DEFAULT_ROW_GROUP_SIZE = 10_000;

/**
 * Number of duplicate `(gatewayEpoch, ingestSeq)` keys listed individually in a
 * dataset manifest before the list is truncated to a count.
 *
 * Duplicates are the *normal* outcome at a WAL fault boundary
 * (`wal-format.md` §12), so a manifest must be able to describe a large
 * duplicate set without becoming unreadable. The count is always exact; only
 * the enumeration is bounded.
 */
export const DEFAULT_MAX_LISTED_DUPLICATE_KEYS = 64;
