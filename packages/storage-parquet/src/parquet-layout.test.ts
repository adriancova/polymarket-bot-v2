import { describe, expect, it } from "vitest";

import {
  buildColumnData,
  datasetRowFromWalRecord,
  reconstructFrameLine,
  rowReproducesItsSourceLine,
  DATASET_COLUMNS,
  DATASET_COLUMN_NAMES,
} from "./parquet-layout.js";
import type { DatasetRow } from "./parquet-layout.js";
import { readParquetObject, writeParquetObject } from "./parquet-object.js";
import { encodeFrameLine, sha256Hex } from "./wal-format.js";
import type { RawFrameRecord } from "./wal-format.js";
import { frameRecord } from "./testing/wal-fixture.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";

function rowFor(record: RawFrameRecord, ordinal: number): DatasetRow {
  const line = encodeFrameLine(record);
  return datasetRowFromWalRecord({
    datasetRowOrdinal: ordinal,
    segmentId: `${EPOCH}-000000`,
    segmentIndex: 0,
    entry: {
      recordIndex: ordinal,
      byteOffset: 100 + ordinal,
      byteLength: line.byteLength,
      lineSha256: sha256Hex(line),
      record,
    },
    replayEligible: true,
    exclusionReason: null,
  });
}

describe("the pinned layout", () => {
  it("has one specification per column name and no duplicates", () => {
    expect(DATASET_COLUMNS.map((column) => column.name)).toStrictEqual([...DATASET_COLUMN_NAMES]);
    expect(new Set(DATASET_COLUMN_NAMES).size).toBe(DATASET_COLUMN_NAMES.length);
  });

  it("stores every bigint-as-string and decimal-shaped field as UTF-8 text", () => {
    // The encoding decision this package exists to get right: no Parquet
    // DECIMAL, no INT64 for a value the WAL admits up to 40 digits of.
    const textColumns = ["ingestSeq", "receivedMonotonicNs", "payloadUtf8", "receivedAt"];
    for (const name of textColumns) {
      const column = DATASET_COLUMNS.find((candidate) => candidate.name === name);
      expect(column?.physicalType).toBe("BYTE_ARRAY_UTF8");
    }
  });

  it("makes exactly one column nullable, and says why in its description", () => {
    const nullable = DATASET_COLUMNS.filter((column) => column.nullable);
    expect(nullable.map((column) => column.name)).toStrictEqual(["exclusionReason"]);
  });

  it("transposes rows into columns in the pinned order", () => {
    const rows = [rowFor(frameRecord({ ingestSeq: "1", payloadUtf8: "PING" }, EPOCH), 0)];
    expect(buildColumnData(rows).map((column) => column.name)).toStrictEqual([
      ...DATASET_COLUMN_NAMES,
    ]);
  });
});

describe("byte-exact reversibility", () => {
  it("reconstructs the exact WAL line from a row", () => {
    const record = frameRecord({ ingestSeq: "7", payloadUtf8: 'x"y\\z' }, EPOCH);
    const row = rowFor(record, 0);
    expect(rowReproducesItsSourceLine(row)).toBe(true);
    expect(sha256Hex(reconstructFrameLine(record))).toBe(row.frameLineSha256);
  });

  it("fails the check when a row's record no longer matches its digest", () => {
    const row = rowFor(frameRecord({ ingestSeq: "7", payloadUtf8: "PING" }, EPOCH), 0);
    const tampered: DatasetRow = {
      ...row,
      record: { ...row.record, connectionId: "conn-9" },
    };
    expect(rowReproducesItsSourceLine(tampered)).toBe(false);
  });
});

describe("Parquet round trip", () => {
  const adversarialPayloads = [
    "PING",
    '{"event_type":"book","price":"0.10"}',
    // Trailing-zero decimals: the exact case a Parquet DECIMAL column would
    // silently normalise away.
    '{"price":"0.100","size":"1.0"}',
    "line\nbreak\tand\ttabs",
    "nul \u0000 byte and \u007f del",
    "emoji 😀 and a lone-looking pair \\ud83d\\ude00",
    '{"record":"footer","formatId":"polymarket-bot/wal/v1"}',
    "",
  ];

  it("preserves every payload byte-exactly through write and read", async () => {
    const rows = adversarialPayloads.map((payloadUtf8, index) =>
      rowFor(
        frameRecord(
          {
            ingestSeq: String(index + 1),
            payloadUtf8,
            receivedMonotonicNs: "18446744073709551617",
          },
          EPOCH,
        ),
        index,
      ),
    );
    const encoded = writeParquetObject({ rows, rowGroupSize: 3 });
    const decoded = await readParquetObject(encoded.bytes);

    expect(decoded).toHaveLength(rows.length);
    for (let index = 0; index < rows.length; index += 1) {
      const expected = rows[index];
      const actual = decoded[index];
      if (expected === undefined || actual === undefined) throw new Error("missing row");
      expect(actual.record).toStrictEqual(expected.record);
      expect(actual.record.payloadUtf8).toBe(adversarialPayloads[index]);
      expect(sha256Hex(reconstructFrameLine(actual.record))).toBe(expected.frameLineSha256);
    }
  });

  it("preserves an ingestSeq far beyond the INT64 range", async () => {
    const huge = "9".repeat(40);
    const rows = [rowFor(frameRecord({ ingestSeq: huge, payloadUtf8: "x" }, EPOCH), 0)];
    const decoded = await readParquetObject(writeParquetObject({ rows }).bytes);
    expect(decoded[0]?.record.ingestSeq).toBe(huge);
  });

  it("preserves nulls in the one nullable column", async () => {
    const eligible = rowFor(frameRecord({ ingestSeq: "1", payloadUtf8: "a" }, EPOCH), 0);
    const excluded: DatasetRow = {
      ...rowFor(frameRecord({ ingestSeq: "2", payloadUtf8: "b" }, EPOCH), 1),
      replayEligible: false,
      exclusionReason: "incident:inc-1",
    };
    const decoded = await readParquetObject(
      writeParquetObject({ rows: [eligible, excluded] }).bytes,
    );
    expect(decoded[0]?.exclusionReason).toBeNull();
    expect(decoded[0]?.replayEligible).toBe(true);
    expect(decoded[1]?.exclusionReason).toBe("incident:inc-1");
    expect(decoded[1]?.replayEligible).toBe(false);
  });

  it("writes byte-identical objects for identical input", () => {
    const rows = [rowFor(frameRecord({ ingestSeq: "1", payloadUtf8: "PING" }, EPOCH), 0)];
    const first = writeParquetObject({ rows });
    const second = writeParquetObject({ rows });
    expect(first.sha256).toBe(second.sha256);
  });

  it("writes an object for zero rows and reads it back as zero rows", async () => {
    const encoded = writeParquetObject({ rows: [] });
    expect(await readParquetObject(encoded.bytes)).toStrictEqual([]);
  });

  it("preserves row order across row-group boundaries", async () => {
    const rows = Array.from({ length: 25 }, (_unused, index) =>
      rowFor(frameRecord({ ingestSeq: String(index + 1), payloadUtf8: `p${index}` }, EPOCH), index),
    );
    const decoded = await readParquetObject(writeParquetObject({ rows, rowGroupSize: 4 }).bytes);
    expect(decoded.map((row) => row.datasetRowOrdinal)).toStrictEqual(
      rows.map((row) => row.datasetRowOrdinal),
    );
  });

  it("round-trips through the SNAPPY codec too", async () => {
    const rows = [rowFor(frameRecord({ ingestSeq: "1", payloadUtf8: "PING PING" }, EPOCH), 0)];
    const decoded = await readParquetObject(writeParquetObject({ rows, codec: "SNAPPY" }).bytes);
    expect(decoded[0]?.record.payloadUtf8).toBe("PING PING");
  });
});
