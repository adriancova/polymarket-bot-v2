/**
 * Writing and reading one compacted Parquet object.
 *
 * ## The library choice
 *
 * `hyparquet-writer` (writer) and `hyparquet` (reader), both MIT, both pure
 * JavaScript, pinned to **exact** versions. The alternatives were considered
 * and rejected for stated reasons rather than taste:
 *
 * - `@dsnp/parquetjs` is the best-maintained classic fork, and it declares
 *   `@aws-sdk/client-s3` as a **runtime dependency**. Handoff §2.1 says every
 *   dependency in the trading process needs a concrete purpose, and this work
 *   package's task packet is explicit that no cloud SDK is mandated. Pulling
 *   the AWS SDK into a compaction library to get a Parquet encoder is exactly
 *   the dependency creep that rule exists to stop.
 * - `parquetjs` / `parquetjs-lite` are unmaintained.
 * - `parquet-wasm` is a WebAssembly build of the Rust implementation: correct,
 *   but a multi-megabyte binary artifact and a second toolchain.
 * - A self-written encoder was the fallback the task packet permits. It is not
 *   needed, and it would mean owning Thrift-compact metadata encoding, page
 *   headers, and RLE definition levels — several hundred lines whose only
 *   validation would be "DuckDB still reads it".
 *
 * The versions are pinned exactly (`hyparquet-writer@0.16.6`,
 * `hyparquet@1.28.1`) rather than with a caret, because this library decides
 * the **bytes of an archived artifact whose checksum a dataset manifest pins**.
 * A patch release that changed a page boundary would change every object's
 * digest for identical input. Pinning makes that a deliberate, reviewable
 * upgrade. The maintenance risk this accepts is written up in
 * `docs/handoffs/WP-130.md`.
 *
 * ## Codec
 *
 * `UNCOMPRESSED` by default. Compression is lossless either way, so this is not
 * a correctness choice; it is a reproducibility one. With no compressor in the
 * path, the object bytes are a pure function of the rows and the pinned writer
 * version, so a third party can re-run compaction over the same segments and
 * get the same digest. A deployment that would rather have smaller objects can
 * set `codec: "SNAPPY"`; the manifest records which was used.
 */

import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { CompressionCodec } from "hyparquet";

import { DEFAULT_ROW_GROUP_SIZE } from "./constants.js";
import { DatasetManifestError } from "./errors.js";
import type { ColumnData, DatasetRow } from "./parquet-layout.js";
import { DATASET_COLUMNS, buildColumnData } from "./parquet-layout.js";
import type { RawFrameRecord } from "./wal-format.js";
import { sha256Hex } from "./wal-format.js";

/** Compression codecs this package is willing to write. */
export type DatasetCodec = "UNCOMPRESSED" | "SNAPPY";

export type WriteParquetObjectOptions = {
  readonly rows: readonly DatasetRow[];
  readonly codec?: DatasetCodec;
  readonly rowGroupSize?: number;
  /** Key/value metadata embedded in the Parquet footer. */
  readonly keyValueMetadata?: Readonly<Record<string, string>>;
};

export type ParquetObjectBytes = {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly rowCount: number;
};

const BASIC_TYPE_BY_PHYSICAL_TYPE = {
  BYTE_ARRAY_UTF8: "STRING",
  INT64: "INT64",
  BOOLEAN: "BOOLEAN",
} as const;

function toWriterColumn(column: ColumnData): {
  name: string;
  data: unknown[];
  type: "STRING" | "INT64" | "BOOLEAN";
  nullable: boolean;
} {
  return {
    name: column.name,
    data: [...column.data],
    type: BASIC_TYPE_BY_PHYSICAL_TYPE[column.physicalType],
    nullable: column.nullable,
  };
}

/** Encode rows into one Parquet object and hash the exact bytes. */
export function writeParquetObject(options: WriteParquetObjectOptions): ParquetObjectBytes {
  const codec: DatasetCodec = options.codec ?? "UNCOMPRESSED";
  const columnData = buildColumnData(options.rows).map(toWriterColumn);
  const kvMetadata = Object.entries(options.keyValueMetadata ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => ({ key, value }));

  const buffer = parquetWriteBuffer({
    // The writer's own types are structurally wider than this package's column
    // union; the mapping above is total over `DatasetColumnPhysicalType`.
    columnData: columnData as never,
    codec: codec as CompressionCodec,
    statistics: true,
    rowGroupSize: options.rowGroupSize ?? DEFAULT_ROW_GROUP_SIZE,
    ...(kvMetadata.length > 0 ? { kvMetadata } : {}),
  });
  const bytes = new Uint8Array(buffer);
  return { bytes, sha256: sha256Hex(bytes), rowCount: options.rows.length };
}

/** One row as read back out of a Parquet object. */
export type DecodedDatasetRow = {
  readonly datasetRowOrdinal: number;
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly segmentRecordIndex: number;
  readonly record: RawFrameRecord;
  readonly frameLineByteOffset: number;
  readonly frameLineByteLength: number;
  readonly frameLineSha256: string;
  readonly replayEligible: boolean;
  readonly exclusionReason: string | null;
};

function requireString(source: Record<string, unknown>, column: string): string {
  const value = source[column];
  if (typeof value !== "string") {
    throw new DatasetManifestError(`column ${column} did not read back as a string`, {
      column,
      received: value === null ? "null" : typeof value,
    });
  }
  return value;
}

function requireNullableString(source: Record<string, unknown>, column: string): string | null {
  const value = source[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DatasetManifestError(`column ${column} did not read back as a string or null`, {
      column,
      received: typeof value,
    });
  }
  return value;
}

function requireSafeInteger(source: Record<string, unknown>, column: string): number {
  const value = source[column];
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DatasetManifestError(`column ${column} is outside the safe integer range`, {
        column,
        value: value.toString(),
      });
    }
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new DatasetManifestError(`column ${column} did not read back as a non-negative integer`, {
    column,
    received: typeof value,
  });
}

function requireBoolean(source: Record<string, unknown>, column: string): boolean {
  const value = source[column];
  if (typeof value !== "boolean") {
    throw new DatasetManifestError(`column ${column} did not read back as a boolean`, {
      column,
      received: typeof value,
    });
  }
  return value;
}

/**
 * Read a Parquet object back into rows.
 *
 * Used for post-upload verification, so it validates rather than trusts: every
 * column must be present with the expected JavaScript type, and the caller then
 * checks each row against `frameLineSha256`. A read that silently coerced a
 * missing column to `undefined` would make the verification pass vacuous.
 */
export async function readParquetObject(bytes: Uint8Array): Promise<readonly DecodedDatasetRow[]> {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  const metadata = parquetMetadata(arrayBuffer);
  const columnNames = metadata.schema.slice(1).map((element) => element.name);
  const expected = DATASET_COLUMNS.map((column) => column.name);
  if (columnNames.length !== expected.length) {
    throw new DatasetManifestError("parquet object does not carry the pinned column set", {
      expected,
      observed: columnNames,
    });
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (columnNames[index] !== expected[index]) {
      throw new DatasetManifestError("parquet object column order does not match the layout", {
        index,
        expected: expected[index],
        observed: columnNames[index],
      });
    }
  }

  const objects = await parquetReadObjects({ file: arrayBuffer, utf8: true });
  return objects.map((entry) => {
    const source = entry as Record<string, unknown>;
    return {
      datasetRowOrdinal: requireSafeInteger(source, "datasetRowOrdinal"),
      segmentId: requireString(source, "segmentId"),
      segmentIndex: requireSafeInteger(source, "segmentIndex"),
      segmentRecordIndex: requireSafeInteger(source, "segmentRecordIndex"),
      record: {
        gatewayEpoch: requireString(source, "gatewayEpoch"),
        ingestSeq: requireString(source, "ingestSeq"),
        source: requireString(source, "source"),
        endpoint: requireString(source, "endpoint"),
        connectionId: requireString(source, "connectionId"),
        subscriptionGeneration: requireSafeInteger(source, "subscriptionGeneration"),
        receivedAt: requireString(source, "receivedAt"),
        receivedMonotonicNs: requireString(source, "receivedMonotonicNs"),
        payloadUtf8: requireString(source, "payloadUtf8"),
        payloadSha256: requireString(source, "payloadSha256"),
      },
      frameLineByteOffset: requireSafeInteger(source, "frameLineByteOffset"),
      frameLineByteLength: requireSafeInteger(source, "frameLineByteLength"),
      frameLineSha256: requireString(source, "frameLineSha256"),
      replayEligible: requireBoolean(source, "replayEligible"),
      exclusionReason: requireNullableString(source, "exclusionReason"),
    };
  });
}

/** Number of rows a Parquet object declares in its footer. */
export function parquetObjectRowCount(bytes: Uint8Array): number {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const rows = parquetMetadata(arrayBuffer).num_rows;
  return typeof rows === "bigint" ? Number(rows) : rows;
}
