/**
 * A synthetic WAL segment builder for unit tests.
 *
 * It writes the bytes `docs/contracts/wal-format.md` specifies — header line,
 * frame lines, footer line, sidecar manifest — without depending on
 * `packages/storage-wal`, which this package may not import (same layer, F13).
 *
 * **This builder is not evidence that the format is implemented correctly.**
 * It is a second implementation of the same document, so a shared
 * misunderstanding would be invisible to it. That is exactly why the
 * integration suite in `test/integration/parquet/**` builds its segments with
 * the **real `WP-050` writer** instead: the unit tests here buy speed and the
 * ability to construct adversarial corruption byte by byte, and the integration
 * suite buys the assurance that the reader agrees with the writer that actually
 * ships.
 */

import { createHash } from "node:crypto";

import { SUPPORTED_WAL_MANIFEST_VERSION, SUPPORTED_WAL_SCHEMA_VERSION, WAL_FORMAT_ID } from "../constants.js";
import type { RawFrameRecord, WalCloseReason, WalSegmentManifest } from "../wal-format.js";
import { defaultSegmentId, encodeFrameLine, sha256Hex } from "../wal-format.js";

/** Input for one frame, with the payload digest computed for the caller. */
export type FrameInput = {
  readonly ingestSeq: string;
  readonly payloadUtf8: string;
  readonly gatewayEpoch?: string;
  readonly source?: string;
  readonly endpoint?: string;
  readonly connectionId?: string;
  readonly subscriptionGeneration?: number;
  readonly receivedAt?: string;
  readonly receivedMonotonicNs?: string;
};

/** Build a well-formed `RawFrameRecord` from a terse test input. */
export function frameRecord(input: FrameInput, gatewayEpoch: string): RawFrameRecord {
  const payloadUtf8 = input.payloadUtf8;
  return {
    gatewayEpoch: input.gatewayEpoch ?? gatewayEpoch,
    ingestSeq: input.ingestSeq,
    source: input.source ?? "polymarket",
    endpoint: input.endpoint ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    connectionId: input.connectionId ?? "conn-1",
    subscriptionGeneration: input.subscriptionGeneration ?? 0,
    receivedAt: input.receivedAt ?? "2026-01-01T00:00:00.000Z",
    receivedMonotonicNs: input.receivedMonotonicNs ?? "1000000",
    payloadUtf8,
    payloadSha256: sha256Hex(payloadUtf8),
  };
}

export type SegmentFixtureOptions = {
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly frames: readonly FrameInput[];
  readonly segmentId?: string;
  readonly createdAt?: string;
  readonly closedAt?: string;
  readonly closeReason?: WalCloseReason;
  /** Omit the in-file footer, as a recovery-closed segment does (§6). */
  readonly withoutFooter?: boolean;
  /** Bytes recovery removed as an incomplete final record. */
  readonly truncatedTailBytes?: number;
};

export type SegmentFixture = {
  readonly segmentId: string;
  readonly segmentFileName: string;
  readonly manifestFileName: string;
  readonly segmentBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly manifest: WalSegmentManifest;
  readonly records: readonly RawFrameRecord[];
};

/** Build a valid segment and its sidecar manifest. */
export function buildSegmentFixture(options: SegmentFixtureOptions): SegmentFixture {
  const segmentId = options.segmentId ?? defaultSegmentId(options.gatewayEpoch, options.segmentIndex);
  const createdAt = options.createdAt ?? "2026-01-01T00:00:00.000Z";
  const closedAt = options.closedAt ?? "2026-01-01T00:15:00.000Z";
  const closeReason: WalCloseReason = options.closeReason ?? "shutdown";

  const headerLine = Buffer.from(
    `${JSON.stringify({
      record: "header",
      formatId: WAL_FORMAT_ID,
      walSchemaVersion: SUPPORTED_WAL_SCHEMA_VERSION,
      segmentId,
      gatewayEpoch: options.gatewayEpoch,
      segmentIndex: options.segmentIndex,
      createdAt,
    })}\n`,
    "utf8",
  );

  const records = options.frames.map((frame) => frameRecord(frame, options.gatewayEpoch));
  const frameLines = records.map((record) => Buffer.from(encodeFrameLine(record)));

  const checksummed = Buffer.concat([headerLine, ...frameLines]);
  const segmentSha256 = createHash("sha256").update(checksummed).digest("hex");

  const footerLine = options.withoutFooter
    ? Buffer.alloc(0)
    : Buffer.from(
        `${JSON.stringify({
          record: "footer",
          formatId: WAL_FORMAT_ID,
          walSchemaVersion: SUPPORTED_WAL_SCHEMA_VERSION,
          segmentId,
          gatewayEpoch: options.gatewayEpoch,
          recordCount: records.length,
          checksummedByteLength: checksummed.byteLength,
          segmentSha256,
          closedAt,
          closeReason,
        })}\n`,
        "utf8",
      );

  const segmentBytes = Buffer.concat([checksummed, footerLine]);
  const first = records[0] ?? null;
  const last = records[records.length - 1] ?? null;

  const manifest: WalSegmentManifest = {
    manifestVersion: SUPPORTED_WAL_MANIFEST_VERSION,
    formatId: WAL_FORMAT_ID,
    walSchemaVersion: SUPPORTED_WAL_SCHEMA_VERSION,
    segmentId,
    gatewayEpoch: options.gatewayEpoch,
    segmentIndex: options.segmentIndex,
    segmentFileName: `${segmentId}.wal.jsonl`,
    segmentIdKind:
      segmentId === defaultSegmentId(options.gatewayEpoch, options.segmentIndex)
        ? "default"
        : "opaque",
    recordCount: records.length,
    firstIngestSeq: first === null ? null : first.ingestSeq,
    lastIngestSeq: last === null ? null : last.ingestSeq,
    firstReceivedAt: first === null ? null : first.receivedAt,
    lastReceivedAt: last === null ? null : last.receivedAt,
    byteSize: segmentBytes.byteLength,
    checksummedByteLength: checksummed.byteLength,
    segmentSha256,
    createdAt,
    closedAt,
    closeReason,
    footerPresent: !options.withoutFooter,
    truncatedTailBytes: options.truncatedTailBytes ?? 0,
  };

  return {
    segmentId,
    segmentFileName: `${segmentId}.wal.jsonl`,
    manifestFileName: `${segmentId}.wal.manifest.json`,
    segmentBytes,
    manifestBytes: encodeManifest(manifest),
    manifest,
    records,
  };
}

/** Serialize a sidecar manifest the way `WP-050` does (pretty-printed, §6.2). */
export function encodeManifest(manifest: WalSegmentManifest): Uint8Array {
  const ordered = {
    manifestVersion: manifest.manifestVersion,
    formatId: manifest.formatId,
    walSchemaVersion: manifest.walSchemaVersion,
    segmentId: manifest.segmentId,
    gatewayEpoch: manifest.gatewayEpoch,
    segmentIndex: manifest.segmentIndex,
    segmentFileName: manifest.segmentFileName,
    ...(manifest.segmentIdKind === undefined ? {} : { segmentIdKind: manifest.segmentIdKind }),
    recordCount: manifest.recordCount,
    firstIngestSeq: manifest.firstIngestSeq,
    lastIngestSeq: manifest.lastIngestSeq,
    firstReceivedAt: manifest.firstReceivedAt,
    lastReceivedAt: manifest.lastReceivedAt,
    byteSize: manifest.byteSize,
    checksummedByteLength: manifest.checksummedByteLength,
    segmentSha256: manifest.segmentSha256,
    createdAt: manifest.createdAt,
    closedAt: manifest.closedAt,
    closeReason: manifest.closeReason,
    footerPresent: manifest.footerPresent,
    truncatedTailBytes: manifest.truncatedTailBytes,
  };
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}
