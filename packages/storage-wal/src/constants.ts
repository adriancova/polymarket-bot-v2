/**
 * Format identity and default bounds for the WAL.
 *
 * Every default here is a policy choice, not a venue fact. The two that carry
 * operational meaning are `DEFAULT_FSYNC_INTERVAL_MS` (ADR-004 §3: the fsync
 * interval is a published bound on data loss) and the rotation bounds (§9.1:
 * rotate by size *and* time).
 */

/**
 * On-disk schema version. Written in the segment header and in every manifest.
 *
 * Bumped only for a change that an existing reader cannot parse; see
 * `docs/contracts/wal-format.md` §9.
 */
export const WAL_SCHEMA_VERSION = 1;

/** Format discriminator written into the header, footer, and manifest. */
export const WAL_FORMAT_ID = "polymarket-bot/wal/v1";

/** Suffix of a segment file: `<segmentId>.wal.jsonl`. */
export const SEGMENT_FILE_SUFFIX = ".wal.jsonl";

/** Suffix of a segment's sidecar manifest: `<segmentId>.wal.manifest.json`. */
export const MANIFEST_FILE_SUFFIX = ".wal.manifest.json";

/** Manifest document version, independent of the segment schema version. */
export const WAL_MANIFEST_VERSION = 1;

/** Bounded raw-frame queue capacity in frames (§8.3: every queue is bounded). */
export const DEFAULT_QUEUE_CAPACITY = 10_000;

/** Bounded raw-frame queue capacity in encoded bytes. */
export const DEFAULT_QUEUE_MAX_BYTES = 64 * 1024 * 1024;

/** Rotate a segment once it reaches this many bytes (§9.1: rotate by size). */
export const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

/** Rotate a segment once it reaches this age (§9.1: rotate by time). */
export const DEFAULT_MAX_SEGMENT_AGE_MS = 15 * 60_000;

/**
 * Periodic fsync interval (§9.1: periodic fsync, not one per frame).
 *
 * ADR-004 §3: this value is the published bound on data loss — a host power
 * loss can lose at most the frames written since the last successful fsync.
 * Changing it changes the bound and belongs in the recorder runbook.
 */
export const DEFAULT_FSYNC_INTERVAL_MS = 1_000;

/** Periodic fsync byte threshold; whichever bound trips first wins. */
export const DEFAULT_FSYNC_BYTE_THRESHOLD = 1024 * 1024;

/** Chunk size used by sequential segment reads. */
export const DEFAULT_READ_CHUNK_BYTES = 256 * 1024;

/**
 * Longest single record (line, including its newline) a reader will buffer.
 *
 * A longer line means the file is corrupt or was written by a different
 * format; buffering it unbounded would turn a corrupt file into an OOM.
 */
export const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** Largest accepted `payloadUtf8`, in UTF-8 bytes. */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Largest accepted length for the short identifier fields of a raw record. */
export const MAX_IDENTIFIER_LENGTH = 256;

/** Largest accepted length for `endpoint` (URLs with query strings). */
export const MAX_ENDPOINT_LENGTH = 2048;

/**
 * Largest **JSON-encoded** segment id, in UTF-8 bytes — the contract every
 * `SegmentIdFactory` must satisfy.
 *
 * The bound is stated on `JSON.stringify(segmentId)` rather than on the id
 * itself because that is exactly what a segment pays for its identity: the id
 * is written into the header line and into the footer line, escaped, and the
 * `maxTotalBytes` reservation has to charge for both before either exists
 * (`docs/contracts/wal-format.md` §11.2). A plain-ASCII id may therefore be up
 * to 1022 characters; an id built from characters JSON must escape is
 * proportionally shorter.
 *
 * The writer refuses an id past this bound rather than silently overrunning the
 * capacity threshold, and it charges an injected factory this full width,
 * because a factory may fold `createdAtMs` into its id and so answer a later
 * call with a different width than the one the reservation measured.
 */
export const MAX_SEGMENT_ID_ENCODED_BYTES = 1024;

/** Line terminator. The format is JSON Lines: exactly one record per line. */
export const LINE_FEED = 0x0a;
