/**
 * The columnar layout, and the encoding decision that makes it lossless.
 *
 * ## Physical encoding of string-shaped values
 *
 * **Every string-shaped field is written as `BYTE_ARRAY` with the `UTF8`
 * logical/converted type — including the two bigint-as-string fields, and
 * including any decimal string a future record type carries. No Parquet
 * `DECIMAL`, no `INT64`, no floating point, ever.**
 *
 * The reason is that the Parquet `DECIMAL` logical type is a scaled integer:
 * it has a fixed `precision` and `scale`, and writing `"0.10"` through it
 * produces the same physical value as `"0.1"`. Handoff §7.3 makes every
 * economic value an exact decimal **string** on every boundary precisely so
 * that no such normalization happens, and §12.4 requires byte-identical replay
 * outputs. A representation that cannot distinguish two strings the domain
 * treats as distinct bytes is therefore not a candidate, however natural it
 * looks in a data warehouse.
 *
 * The same argument rules out `INT64` for `ingestSeq` and `receivedMonotonicNs`
 * for a second, independent reason: `docs/contracts/wal-format.md` §5 admits up
 * to **40 digits**, and `INT64` holds 19. Storing them as `INT64` would either
 * overflow or force a silent range restriction the WAL never agreed to.
 *
 * Two columns are genuinely integral and are stored as `INT64`:
 * `subscriptionGeneration`, which the WAL format defines as a JSON number in
 * the safe-integer range, and the positional columns this package computes
 * itself. `INT64` represents every safe integer exactly, so nothing is lost —
 * and `subscriptionGeneration` round-trips back to the same JSON number, which
 * is what {@link ../wal-format.js} needs to re-encode the original line.
 *
 * ## Why the layout is verifiable rather than merely careful
 *
 * Every row carries `frameLineSha256`: the SHA-256 of the exact segment line
 * the row came from, including its terminating `LF`. Re-encoding a row through
 * `encodeFrameLine` and hashing must reproduce it. That turns "byte-exact" from
 * a property of the code into a property anyone can check against the archive,
 * including a Python job that never runs this code
 * (`python/research/compaction`).
 *
 * ## Ordering
 *
 * Replay consumes recorded dispatch order (§8.4) and "must not sort solely by
 * venue timestamp". Parquet preserves row order within a file, but a query
 * engine is free to return rows in any order it likes, so order is carried as
 * **data**: `datasetRowOrdinal` is a dense, gap-free sequence assigned across
 * the whole dataset in dispatch order. A reader recovers dispatch order with
 * `ORDER BY datasetRowOrdinal` and needs nothing else — not the file name, not
 * the row group, not `receivedAt`.
 */

import { PARQUET_LAYOUT_ID, PARQUET_LAYOUT_VERSION } from "./constants.js";
import type { RawFrameRecord, WalRecordEntry } from "./wal-format.js";
import { encodeFrameLine, sha256Hex } from "./wal-format.js";

/** Why a row is not eligible for replay. `null` means it is eligible. */
export type RowExclusionReason = string | null;

/** One Parquet row: a WAL record plus its position and its provenance. */
export type DatasetRow = {
  /** Dense dispatch-order ordinal across the whole dataset (§8.4). */
  readonly datasetRowOrdinal: number;
  readonly segmentId: string;
  readonly segmentIndex: number;
  /** Position among the segment's frame records, as found on disk. */
  readonly segmentRecordIndex: number;
  readonly record: RawFrameRecord;
  /** Byte offset of the record's line in its segment file. */
  readonly frameLineByteOffset: number;
  /** Byte length of that line, including its terminating `LF`. */
  readonly frameLineByteLength: number;
  /** SHA-256 of exactly those bytes. */
  readonly frameLineSha256: string;
  /**
   * Whether replay may consume this row.
   *
   * `false` for a record inside an excluded incident window and for the later
   * copies of a duplicated `(gatewayEpoch, ingestSeq)`. The row is still
   * written: see {@link buildDatasetRows} for why exclusion never means
   * deletion.
   */
  readonly replayEligible: boolean;
  readonly exclusionReason: RowExclusionReason;
};

/** Column names in physical order. A dataset manifest pins this list. */
export const DATASET_COLUMN_NAMES = [
  "datasetRowOrdinal",
  "segmentId",
  "segmentIndex",
  "segmentRecordIndex",
  "gatewayEpoch",
  "ingestSeq",
  "source",
  "endpoint",
  "connectionId",
  "subscriptionGeneration",
  "receivedAt",
  "receivedMonotonicNs",
  "payloadUtf8",
  "payloadSha256",
  "frameLineByteOffset",
  "frameLineByteLength",
  "frameLineSha256",
  "replayEligible",
  "exclusionReason",
] as const;

export type DatasetColumnName = (typeof DATASET_COLUMN_NAMES)[number];

/** Physical type of one column, as written into the Parquet schema. */
export type DatasetColumnPhysicalType = "BYTE_ARRAY_UTF8" | "INT64" | "BOOLEAN";

/** The pinned description of one column. */
export type DatasetColumnSpec = {
  readonly name: DatasetColumnName;
  readonly physicalType: DatasetColumnPhysicalType;
  readonly nullable: boolean;
  readonly description: string;
};

/**
 * The layout, in physical column order.
 *
 * This array is the authority: {@link buildColumnData} builds from it, the
 * dataset manifest pins it, and the DuckDB validation job asserts the file it
 * reads matches it. Changing it is a {@link PARQUET_LAYOUT_VERSION} bump.
 */
export const DATASET_COLUMNS: readonly DatasetColumnSpec[] = [
  {
    name: "datasetRowOrdinal",
    physicalType: "INT64",
    nullable: false,
    description: "Dense dispatch-order ordinal across the dataset (handoff §8.4).",
  },
  {
    name: "segmentId",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description: "Opaque WAL segment identifier this record was read from.",
  },
  {
    name: "segmentIndex",
    physicalType: "INT64",
    nullable: false,
    description: "Per-directory segment ordinal from the segment header.",
  },
  {
    name: "segmentRecordIndex",
    physicalType: "INT64",
    nullable: false,
    description: "Zero-based position among the segment's frame records.",
  },
  {
    name: "gatewayEpoch",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description: "Gateway epoch (§7.1); half of the deduplication key.",
  },
  {
    name: "ingestSeq",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description: "Bigint-as-string ingest sequence, up to 40 digits. Never INT64.",
  },
  {
    name: "source",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description: "Feed source label, verbatim from the record.",
  },
  {
    name: "endpoint",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description: "URL the frame arrived on, verbatim from the record.",
  },
  {
    name: "connectionId",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description: "Per-connection identity used for gap attribution.",
  },
  {
    name: "subscriptionGeneration",
    physicalType: "INT64",
    nullable: false,
    description: "JSON safe integer; INT64 represents it exactly.",
  },
  {
    name: "receivedAt",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description:
      "ISO-8601 instant as recorded. Kept as text so the offset and the sub-second digits survive.",
  },
  {
    name: "receivedMonotonicNs",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description: "Bigint-as-string monotonic nanoseconds, up to 40 digits. Never INT64.",
  },
  {
    name: "payloadUtf8",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description:
      "The frame exactly as received. Not required to be JSON; may hold control characters.",
  },
  {
    name: "payloadSha256",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description: "SHA-256 of the payload's UTF-8 bytes, verified on read.",
  },
  {
    name: "frameLineByteOffset",
    physicalType: "INT64",
    nullable: false,
    description: "Offset of the record's line in its WAL segment file.",
  },
  {
    name: "frameLineByteLength",
    physicalType: "INT64",
    nullable: false,
    description: "Length of that line including its terminating LF.",
  },
  {
    name: "frameLineSha256",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: false,
    description: "SHA-256 of the original segment line; the byte-exactness proof.",
  },
  {
    name: "replayEligible",
    physicalType: "BOOLEAN",
    nullable: false,
    description: "False for an excluded-incident record or a duplicate copy.",
  },
  {
    name: "exclusionReason",
    physicalType: "BYTE_ARRAY_UTF8",
    nullable: true,
    description: "Null when replayEligible; otherwise 'incident:<id>' or 'duplicate:<ordinal>'.",
  },
];

/** Layout identity a dataset manifest pins and a reader checks. */
export const DATASET_LAYOUT = {
  layoutId: PARQUET_LAYOUT_ID,
  layoutVersion: PARQUET_LAYOUT_VERSION,
  columns: DATASET_COLUMNS,
} as const;

/**
 * Recompute a row's frame line and compare it with the digest the row carries.
 *
 * Used by the compactor before upload and by the post-upload verification pass,
 * so that a row that could not reproduce its own source bytes never reaches an
 * archive that may outlive the WAL.
 */
export function rowReproducesItsSourceLine(row: DatasetRow): boolean {
  const encoded = encodeFrameLine(row.record);
  return (
    encoded.byteLength === row.frameLineByteLength && sha256Hex(encoded) === row.frameLineSha256
  );
}

/** Build a row from a verified WAL record entry. */
export function datasetRowFromWalRecord(input: {
  readonly datasetRowOrdinal: number;
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly entry: WalRecordEntry;
  readonly replayEligible: boolean;
  readonly exclusionReason: RowExclusionReason;
}): DatasetRow {
  return {
    datasetRowOrdinal: input.datasetRowOrdinal,
    segmentId: input.segmentId,
    segmentIndex: input.segmentIndex,
    segmentRecordIndex: input.entry.recordIndex,
    record: input.entry.record,
    frameLineByteOffset: input.entry.byteOffset,
    frameLineByteLength: input.entry.byteLength,
    frameLineSha256: input.entry.lineSha256,
    replayEligible: input.replayEligible,
    exclusionReason: input.exclusionReason,
  };
}

/** Column-major data in {@link DATASET_COLUMNS} order, ready for the writer. */
export type ColumnData = {
  readonly name: DatasetColumnName;
  readonly data: readonly unknown[];
  readonly physicalType: DatasetColumnPhysicalType;
  readonly nullable: boolean;
};

/**
 * Transpose rows into columns.
 *
 * `INT64` columns are emitted as `bigint` because that is what the Parquet
 * writer requires for an `INT64` physical column and because it is the only JS
 * type that represents the full range without rounding. The values are all
 * safe integers here, so the conversion is exact in both directions.
 */
export function buildColumnData(rows: readonly DatasetRow[]): readonly ColumnData[] {
  const column = <T,>(
    name: DatasetColumnName,
    select: (row: DatasetRow) => T,
  ): { name: DatasetColumnName; data: T[] } => ({
    name,
    data: rows.map(select),
  });

  const specByName = new Map(DATASET_COLUMNS.map((spec) => [spec.name, spec]));
  const raw: readonly { name: DatasetColumnName; data: readonly unknown[] }[] = [
    column("datasetRowOrdinal", (row) => BigInt(row.datasetRowOrdinal)),
    column("segmentId", (row) => row.segmentId),
    column("segmentIndex", (row) => BigInt(row.segmentIndex)),
    column("segmentRecordIndex", (row) => BigInt(row.segmentRecordIndex)),
    column("gatewayEpoch", (row) => row.record.gatewayEpoch),
    column("ingestSeq", (row) => row.record.ingestSeq),
    column("source", (row) => row.record.source),
    column("endpoint", (row) => row.record.endpoint),
    column("connectionId", (row) => row.record.connectionId),
    column("subscriptionGeneration", (row) => BigInt(row.record.subscriptionGeneration)),
    column("receivedAt", (row) => row.record.receivedAt),
    column("receivedMonotonicNs", (row) => row.record.receivedMonotonicNs),
    column("payloadUtf8", (row) => row.record.payloadUtf8),
    column("payloadSha256", (row) => row.record.payloadSha256),
    column("frameLineByteOffset", (row) => BigInt(row.frameLineByteOffset)),
    column("frameLineByteLength", (row) => BigInt(row.frameLineByteLength)),
    column("frameLineSha256", (row) => row.frameLineSha256),
    column("replayEligible", (row) => row.replayEligible),
    column("exclusionReason", (row) => row.exclusionReason),
  ];

  return raw.map(({ name, data }) => {
    const spec = specByName.get(name);
    /* c8 ignore next 3 -- unreachable: the two lists are checked against each
       other by `parquet-layout.test.ts`, which fails if they ever diverge. */
    if (spec === undefined) {
      throw new Error(`column ${name} has no specification`);
    }
    return { name, data, physicalType: spec.physicalType, nullable: spec.nullable };
  });
}

/**
 * Reconstruct the original WAL segment line from a decoded Parquet row.
 *
 * This is the reversibility claim made executable. A caller that has read a row
 * back out of Parquet — from this package's reader or from DuckDB — can rebuild
 * the exact bytes the recorder wrote and check them against `frameLineSha256`.
 */
export function reconstructFrameLine(record: RawFrameRecord): Uint8Array {
  return encodeFrameLine(record);
}
