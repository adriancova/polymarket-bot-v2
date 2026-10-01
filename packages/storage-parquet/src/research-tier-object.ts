/**
 * Writing and reading one research-tier table object.
 *
 * The same writer library, pinned to the same exact version, as the raw-frame
 * objects (`parquet-object.ts` states why). The read path validates rather than
 * trusts: the column set and order must be exactly the table's pinned list,
 * and every value must read back with its pinned JavaScript type and
 * nullability, so a post-upload verification over these rows cannot pass
 * vacuously.
 */

import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { CompressionCodec } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";

import { DEFAULT_ROW_GROUP_SIZE } from "./constants.js";
import { DatasetManifestError } from "./errors.js";
import type { DatasetCodec } from "./parquet-object.js";
import type { ResearchColumnSpec, ResearchRow, ResearchTableSpec } from "./research-tier-layout.js";
import { sha256Hex } from "./wal-format.js";

const WRITER_TYPE = {
  BYTE_ARRAY_UTF8: "STRING",
  INT64: "INT64",
  BOOLEAN: "BOOLEAN",
} as const;

function columnValue(
  table: ResearchTableSpec,
  spec: ResearchColumnSpec,
  row: ResearchRow,
  index: number,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, spec.name)) {
    throw new DatasetManifestError("a research-tier row is missing a pinned column", {
      table: table.name,
      column: spec.name,
      row: index,
    });
  }
  const value = row[spec.name];
  if (value === null || value === undefined) {
    if (!spec.nullable) {
      throw new DatasetManifestError("a research-tier row holds null in a REQUIRED column", {
        table: table.name,
        column: spec.name,
        row: index,
      });
    }
    return null;
  }
  switch (spec.physicalType) {
    case "BYTE_ARRAY_UTF8":
      if (typeof value !== "string") break;
      return value;
    case "INT64":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) break;
      return BigInt(value);
    case "BOOLEAN":
      if (typeof value !== "boolean") break;
      return value;
  }
  throw new DatasetManifestError("a research-tier value does not match its pinned column type", {
    table: table.name,
    column: spec.name,
    row: index,
    physicalType: spec.physicalType,
    received: typeof value,
  });
}

/** Encode one table's rows. Every row must carry exactly the table's columns. */
export function writeResearchTableObject(options: {
  readonly table: ResearchTableSpec;
  readonly rows: readonly ResearchRow[];
  readonly codec?: DatasetCodec;
  readonly rowGroupSize?: number;
  readonly keyValueMetadata?: Readonly<Record<string, string>>;
}): { readonly bytes: Uint8Array; readonly sha256: string; readonly rowCount: number } {
  const pinned = new Set(options.table.columns.map((spec) => spec.name));
  options.rows.forEach((row, index) => {
    for (const key of Object.keys(row)) {
      if (!pinned.has(key)) {
        throw new DatasetManifestError("a research-tier row carries a column its table does not pin", {
          table: options.table.name,
          column: key,
          row: index,
        });
      }
    }
  });
  const columnData = options.table.columns.map((spec) => ({
    name: spec.name,
    data: options.rows.map((row, index) => columnValue(options.table, spec, row, index)),
    type: WRITER_TYPE[spec.physicalType],
    nullable: spec.nullable,
  }));
  const kvMetadata = Object.entries(options.keyValueMetadata ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => ({ key, value }));
  const buffer = parquetWriteBuffer({
    columnData: columnData as never,
    codec: (options.codec ?? "SNAPPY") as CompressionCodec,
    statistics: true,
    rowGroupSize: options.rowGroupSize ?? DEFAULT_ROW_GROUP_SIZE,
    ...(kvMetadata.length > 0 ? { kvMetadata } : {}),
  });
  const bytes = new Uint8Array(buffer);
  return { bytes, sha256: sha256Hex(bytes), rowCount: options.rows.length };
}

function readBack(
  table: ResearchTableSpec,
  spec: ResearchColumnSpec,
  source: Record<string, unknown>,
  index: number,
): string | number | boolean | null {
  const value = source[spec.name];
  if (value === null || value === undefined) {
    if (!spec.nullable) {
      throw new DatasetManifestError("a REQUIRED research-tier column read back as null", {
        table: table.name,
        column: spec.name,
        row: index,
      });
    }
    return null;
  }
  switch (spec.physicalType) {
    case "BYTE_ARRAY_UTF8":
      if (typeof value === "string") return value;
      break;
    case "INT64":
      if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value);
      }
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
      break;
    case "BOOLEAN":
      if (typeof value === "boolean") return value;
      break;
  }
  throw new DatasetManifestError("a research-tier column did not read back with its pinned type", {
    table: table.name,
    column: spec.name,
    row: index,
    received: typeof value,
  });
}

/** Decode one table object, refusing anything but the table's exact column list. */
export async function readResearchTableObject(
  table: ResearchTableSpec,
  bytes: Uint8Array,
): Promise<readonly ResearchRow[]> {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const metadata = parquetMetadata(arrayBuffer);
  const observed = metadata.schema.slice(1).map((element) => element.name);
  const expected = table.columns.map((spec) => spec.name);
  if (observed.length !== expected.length || observed.some((name, index) => name !== expected[index])) {
    throw new DatasetManifestError("a research-tier object does not carry its table's pinned columns", {
      table: table.name,
      expected,
      observed,
    });
  }
  const objects = await parquetReadObjects({ file: arrayBuffer, utf8: true });
  return objects.map((entry, index) => {
    const source = entry as Record<string, unknown>;
    const row: Record<string, string | number | boolean | null> = {};
    for (const spec of table.columns) {
      row[spec.name] = readBack(table, spec, source, index);
    }
    return row;
  });
}
