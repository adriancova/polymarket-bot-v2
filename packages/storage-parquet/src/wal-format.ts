/**
 * An independent reader for the WAL on-disk format.
 *
 * ## Why this exists rather than an import
 *
 * `packages/storage-wal` already implements a reader, and importing it would be
 * the obvious thing to do. It is also forbidden: both packages sit in layer 2
 * (`docs/contracts/dependency-direction.md` §2), a workspace edge between them
 * is therefore a **same-layer** edge, and §2.1 — which is exhaustive and fails
 * closed (F13) — lists no such row. §2.1 is edited by the contract owner with a
 * citation, not by a consumer that finds the edge convenient.
 *
 * So this module consumes the **published byte format** instead:
 * `docs/contracts/wal-format.md`, which exists precisely because "`WP-130`
 * (Parquet compactor and dataset manifests) reads it" (that document's header).
 * The coupling is a documented contract rather than a symbol table, and the
 * risk that the two implementations drift is answered by the integration suite,
 * which writes its segments with the **real `WP-050` writer** and then reads
 * them back through this module.
 *
 * ## What it enforces
 *
 * `wal-format.md` §7 lists six conditions for a segment to be valid, and all
 * six are checked here. Two consequences a caller must understand:
 *
 * - **A segment with no sidecar manifest is invisible.** §2: "A segment with no
 *   manifest is unverified, and a compactor must not consume it." That is the
 *   mechanism by which a corrupt or crash-abandoned segment is kept out of a
 *   dataset — no manifest, no exposure.
 * - **Nothing here repairs anything.** A defect is reported as a refusal with
 *   its issue codes; the file is left exactly as found. ADR-004 §3 makes
 *   mid-file corruption a data-quality incident, not a recovery case, and this
 *   package has no write access to the WAL directory at all.
 */

import { createHash } from "node:crypto";

import {
  DEFAULT_MAX_RECORD_BYTES,
  LINE_FEED,
  SUPPORTED_WAL_MANIFEST_VERSION,
  SUPPORTED_WAL_SCHEMA_VERSION,
  WAL_FORMAT_ID,
  WAL_MANIFEST_FILE_SUFFIX,
  WAL_SEGMENT_FILE_SUFFIX,
} from "./constants.js";

/** Why a segment stopped accepting records (`wal-format.md` §6.1). */
export type WalCloseReason =
  | "size-rotation"
  | "time-rotation"
  | "manual-rotation"
  | "shutdown"
  | "recovery"
  | "write-fault";

const CLOSE_REASONS: readonly WalCloseReason[] = [
  "size-rotation",
  "time-rotation",
  "manual-rotation",
  "shutdown",
  "recovery",
  "write-fault",
];

/** Provenance of a segment id (`wal-format.md` §6.2). Optional and additive. */
export type WalSegmentIdKind = "default" | "opaque";

const SEGMENT_ID_KINDS: readonly WalSegmentIdKind[] = ["default", "opaque"];

/**
 * The handoff §9.1 raw frame record, exactly as it appears on a segment line.
 *
 * Declared here rather than imported for the layering reason in this module's
 * header. The field grammar is `wal-format.md` §5 and it is enforced below —
 * `ingestSeq` and `receivedMonotonicNs` are bigints serialized as canonical
 * unsigned decimal strings, and `payloadUtf8` is the frame **verbatim** and is
 * not required to parse as JSON (§5.1).
 */
export type RawFrameRecord = {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly source: string;
  readonly endpoint: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly payloadUtf8: string;
  readonly payloadSha256: string;
};

/** The §9.1 field order. Serialization uses exactly this order (§12.4). */
export const RAW_FRAME_RECORD_KEYS = [
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
] as const satisfies readonly (keyof RawFrameRecord)[];

/** First line of a segment (`wal-format.md` §4). */
export type WalSegmentHeader = {
  readonly record: "header";
  readonly formatId: string;
  readonly walSchemaVersion: number;
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly createdAt: string;
};

/** Optional last line of a cleanly closed segment (`wal-format.md` §6.1). */
export type WalSegmentFooter = {
  readonly record: "footer";
  readonly formatId: string;
  readonly walSchemaVersion: number;
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly recordCount: number;
  readonly checksummedByteLength: number;
  readonly segmentSha256: string;
  readonly closedAt: string;
  readonly closeReason: WalCloseReason;
};

/** The sidecar manifest (`wal-format.md` §6.2). */
export type WalSegmentManifest = {
  readonly manifestVersion: number;
  readonly formatId: string;
  readonly walSchemaVersion: number;
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly segmentFileName: string;
  readonly segmentIdKind?: WalSegmentIdKind;
  readonly recordCount: number;
  readonly firstIngestSeq: string | null;
  readonly lastIngestSeq: string | null;
  readonly firstReceivedAt: string | null;
  readonly lastReceivedAt: string | null;
  readonly byteSize: number;
  readonly checksummedByteLength: number;
  readonly segmentSha256: string;
  readonly createdAt: string;
  readonly closedAt: string;
  readonly closeReason: WalCloseReason;
  readonly footerPresent: boolean;
  readonly truncatedTailBytes: number;
};

/** One frame record and the exact bytes it occupies in its segment. */
export type WalRecordEntry = {
  /** Zero-based position among the segment's frame records. */
  readonly recordIndex: number;
  /** Offset of the record's first byte in the segment file. */
  readonly byteOffset: number;
  /** Length of the record including its terminating `LF` (`wal-format.md` §3). */
  readonly byteLength: number;
  /** SHA-256 of exactly those bytes. */
  readonly lineSha256: string;
  readonly record: RawFrameRecord;
};

/**
 * Machine-readable classification of a segment defect.
 *
 * The codes mirror `wal-format.md` §6.3 and the `WP-050` reader's vocabulary so
 * that an operator reading a compaction report and an operator reading a WAL
 * validation report see the same words for the same defect.
 */
export type WalSegmentIssueCode =
  | "MANIFEST_MISSING"
  | "MANIFEST_UNREADABLE"
  | "SEGMENT_MISSING"
  | "SEGMENT_TOO_LARGE"
  | "HEADER_MISSING"
  | "RECORD_INVALID"
  | "RECORD_TOO_LARGE"
  | "RECORD_AFTER_FOOTER"
  | "INCOMPLETE_FINAL_RECORD"
  | "RECORD_COUNT_MISMATCH"
  | "CHECKSUM_MISMATCH"
  | "CHECKSUM_LENGTH_MISMATCH"
  | "BYTE_SIZE_MISMATCH"
  | "SEGMENT_ID_MISMATCH"
  | "GATEWAY_EPOCH_MISMATCH"
  | "MANIFEST_HEADER_DISAGREE"
  | "FOOTER_MANIFEST_DISAGREE"
  | "MANIFEST_CONTENT_DISAGREE"
  | "MANIFEST_INCONSISTENT"
  | "UNSUPPORTED_FORMAT";

export type WalSegmentIssue = {
  readonly code: WalSegmentIssueCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * The outcome of reading one segment.
 *
 * `verified` is the only status a compactor may consume. Everything else is a
 * refusal carrying the issues that produced it, so the reason survives into the
 * dataset manifest's exclusion list rather than into a log line nobody reads.
 */
export type WalSegmentReadResult =
  | {
      readonly status: "verified";
      readonly segmentId: string;
      readonly manifest: WalSegmentManifest;
      readonly header: WalSegmentHeader;
      readonly footer: WalSegmentFooter | null;
      readonly records: readonly WalRecordEntry[];
      readonly computedSegmentSha256: string;
      readonly byteSize: number;
    }
  | {
      readonly status: "refused";
      readonly segmentId: string;
      readonly manifest: WalSegmentManifest | null;
      readonly issues: readonly WalSegmentIssue[];
    };

const LOWERCASE_SHA256_HEX = /^[0-9a-f]{64}$/u;
const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/u;
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;
const MAX_BIGINT_STRING_DIGITS = 40;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ENDPOINT_LENGTH = 2048;

/** SHA-256 of bytes or of a UTF-8 string, lowercase hex. */
export function sha256Hex(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(typeof value === "string" ? Buffer.from(value, "utf8") : value);
  return hash.digest("hex");
}

/** `<segmentId>.wal.jsonl`. */
export function walSegmentFileName(segmentId: string): string {
  return `${segmentId}${WAL_SEGMENT_FILE_SUFFIX}`;
}

/** `<segmentId>.wal.manifest.json`. */
export function walManifestFileName(segmentId: string): string {
  return `${segmentId}${WAL_MANIFEST_FILE_SUFFIX}`;
}

/** The segment id encoded in a sidecar manifest file name, or `null`. */
export function segmentIdFromManifestFileName(fileName: string): string | null {
  if (!fileName.endsWith(WAL_MANIFEST_FILE_SUFFIX)) {
    return null;
  }
  const segmentId = fileName.slice(0, fileName.length - WAL_MANIFEST_FILE_SUFFIX.length);
  return segmentId.length > 0 ? segmentId : null;
}

/**
 * The default segment id (`wal-format.md` §2), used only to decide provenance.
 *
 * An id is otherwise **opaque**: §2 says identity is what the header says,
 * never what the file name implies, and this reader never infers an ordinal
 * from a name.
 */
export function defaultSegmentId(gatewayEpoch: string, segmentIndex: number): string {
  return `${gatewayEpoch}-${String(segmentIndex).padStart(6, "0")}`;
}

/**
 * Compare two canonical unsigned integer strings.
 *
 * String comparison is wrong for numbers of different widths ("9" > "10"), and
 * `Number` is wrong past 2^53. Length first, then lexicographic, is exact for
 * every value the grammar admits — including a 40-digit `ingestSeq`.
 */
export function compareUnsignedIntegerStrings(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Re-encode a frame record into its canonical segment line, including the `LF`.
 *
 * This is the inverse of parsing, and it is what makes "byte-exact" a checkable
 * claim rather than an assertion: every row this package writes carries the
 * SHA-256 of the line it came from, and re-encoding a row must reproduce those
 * bytes. `wal-format.md` §5 fixes the key order, so one record has exactly one
 * encoding.
 */
export function encodeFrameLine(record: RawFrameRecord): Uint8Array {
  const json = JSON.stringify({
    gatewayEpoch: record.gatewayEpoch,
    ingestSeq: record.ingestSeq,
    source: record.source,
    endpoint: record.endpoint,
    connectionId: record.connectionId,
    subscriptionGeneration: record.subscriptionGeneration,
    receivedAt: record.receivedAt,
    receivedMonotonicNs: record.receivedMonotonicNs,
    payloadUtf8: record.payloadUtf8,
    payloadSha256: record.payloadSha256,
  });
  return Buffer.from(`${json}\n`, "utf8");
}

class ParseFailure extends Error {}

function fail(message: string): never {
  throw new ParseFailure(message);
}

function readString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) {
    return fail(`${field} must be a non-empty string`);
  }
  return value;
}

function readNullableString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    return fail(`${field} must be a non-empty string or null`);
  }
  return value;
}

function readInteger(source: Record<string, unknown>, field: string): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function readBoolean(source: Record<string, unknown>, field: string): boolean {
  const value = source[field];
  if (typeof value !== "boolean") {
    return fail(`${field} must be a boolean`);
  }
  return value;
}

function requirePlainObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function readCloseReason(source: Record<string, unknown>): WalCloseReason {
  const value = source["closeReason"];
  if (typeof value !== "string" || !CLOSE_REASONS.includes(value as WalCloseReason)) {
    return fail("closeReason is not one of the six documented values");
  }
  return value as WalCloseReason;
}

function readDigest(source: Record<string, unknown>, field: string): string {
  const value = readString(source, field);
  if (!LOWERCASE_SHA256_HEX.test(value)) {
    return fail(`${field} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

/** Parse a sidecar manifest document (`wal-format.md` §6.2). */
export function parseWalSegmentManifest(value: unknown): WalSegmentManifest {
  const source = requirePlainObject(value, "segment manifest");
  const formatId = readString(source, "formatId");
  if (formatId !== WAL_FORMAT_ID) {
    fail(`manifest declares an unknown WAL format: ${formatId}`);
  }
  const manifestVersion = readInteger(source, "manifestVersion");
  if (manifestVersion !== SUPPORTED_WAL_MANIFEST_VERSION) {
    fail(`manifest version ${manifestVersion} is not readable by this build`);
  }
  const walSchemaVersion = readInteger(source, "walSchemaVersion");
  if (walSchemaVersion !== SUPPORTED_WAL_SCHEMA_VERSION) {
    fail(`segment schema version ${walSchemaVersion} is not readable by this build`);
  }
  const segmentIdKind = source["segmentIdKind"];
  if (
    segmentIdKind !== undefined &&
    (typeof segmentIdKind !== "string" ||
      !SEGMENT_ID_KINDS.includes(segmentIdKind as WalSegmentIdKind))
  ) {
    fail("manifest declares an unknown segment id kind");
  }
  return {
    ...(segmentIdKind === undefined ? {} : { segmentIdKind: segmentIdKind as WalSegmentIdKind }),
    manifestVersion,
    formatId,
    walSchemaVersion,
    segmentId: readString(source, "segmentId"),
    gatewayEpoch: readString(source, "gatewayEpoch"),
    segmentIndex: readInteger(source, "segmentIndex"),
    segmentFileName: readString(source, "segmentFileName"),
    recordCount: readInteger(source, "recordCount"),
    firstIngestSeq: readNullableString(source, "firstIngestSeq"),
    lastIngestSeq: readNullableString(source, "lastIngestSeq"),
    firstReceivedAt: readNullableString(source, "firstReceivedAt"),
    lastReceivedAt: readNullableString(source, "lastReceivedAt"),
    byteSize: readInteger(source, "byteSize"),
    checksummedByteLength: readInteger(source, "checksummedByteLength"),
    segmentSha256: readDigest(source, "segmentSha256"),
    createdAt: readString(source, "createdAt"),
    closedAt: readString(source, "closedAt"),
    closeReason: readCloseReason(source),
    footerPresent: readBoolean(source, "footerPresent"),
    truncatedTailBytes: readInteger(source, "truncatedTailBytes"),
  };
}

function parseSegmentHeader(source: Record<string, unknown>): WalSegmentHeader {
  const formatId = readString(source, "formatId");
  if (formatId !== WAL_FORMAT_ID) {
    fail(`segment header declares an unknown WAL format: ${formatId}`);
  }
  const walSchemaVersion = readInteger(source, "walSchemaVersion");
  if (walSchemaVersion !== SUPPORTED_WAL_SCHEMA_VERSION) {
    fail(`segment schema version ${walSchemaVersion} is not readable by this build`);
  }
  return {
    record: "header",
    formatId,
    walSchemaVersion,
    segmentId: readString(source, "segmentId"),
    gatewayEpoch: readString(source, "gatewayEpoch"),
    segmentIndex: readInteger(source, "segmentIndex"),
    createdAt: readString(source, "createdAt"),
  };
}

function parseSegmentFooter(source: Record<string, unknown>): WalSegmentFooter {
  const formatId = readString(source, "formatId");
  if (formatId !== WAL_FORMAT_ID) {
    fail(`segment footer declares an unknown WAL format: ${formatId}`);
  }
  return {
    record: "footer",
    formatId,
    walSchemaVersion: readInteger(source, "walSchemaVersion"),
    segmentId: readString(source, "segmentId"),
    gatewayEpoch: readString(source, "gatewayEpoch"),
    recordCount: readInteger(source, "recordCount"),
    checksummedByteLength: readInteger(source, "checksummedByteLength"),
    segmentSha256: readDigest(source, "segmentSha256"),
    closedAt: readString(source, "closedAt"),
    closeReason: readCloseReason(source),
  };
}

/**
 * Validate an untrusted object as a `RawFrameRecord` (`wal-format.md` §5).
 *
 * An unknown key is rejected rather than ignored. §3 states the rule and the
 * reason: on the recording path an unexplained field is a defect, not a nicety,
 * and a compactor that dropped it would carry the loss into the archive that
 * replaces the WAL.
 */
export function parseRawFrameRecord(value: unknown): RawFrameRecord {
  const source = requirePlainObject(value, "raw frame record");
  const known = RAW_FRAME_RECORD_KEYS as readonly string[];
  const unknownKeys = Object.keys(source).filter((key) => !known.includes(key));
  if (unknownKeys.length > 0) {
    fail(`raw frame record has unknown keys: ${unknownKeys.join(", ")}`);
  }
  for (const key of RAW_FRAME_RECORD_KEYS) {
    if (!(key in source)) {
      fail(`raw frame record is missing ${key}`);
    }
  }

  const bounded = (field: string, maxLength: number): string => {
    const text = readString(source, field);
    if (text.length > maxLength) {
      fail(`${field} exceeds the maximum length of ${maxLength}`);
    }
    return text;
  };
  const bigintString = (field: string): string => {
    const text = readString(source, field);
    if (text.length > MAX_BIGINT_STRING_DIGITS || !CANONICAL_UNSIGNED_INTEGER.test(text)) {
      fail(`${field} must be a canonical unsigned integer string`);
    }
    return text;
  };

  const subscriptionGeneration = readInteger(source, "subscriptionGeneration");
  const receivedAt = readString(source, "receivedAt");
  if (!ISO_8601_INSTANT.test(receivedAt) || Number.isNaN(Date.parse(receivedAt))) {
    fail("receivedAt must be an ISO-8601 instant with an explicit offset");
  }
  const payloadUtf8 = source["payloadUtf8"];
  if (typeof payloadUtf8 !== "string") {
    fail("payloadUtf8 must be a string");
  }
  const payloadSha256 = readDigest(source, "payloadSha256");
  // §5: the digest is over the exact UTF-8 bytes of the payload. Checking it
  // here means a row this package writes carries a digest that was verified
  // against its own payload, not one copied from a line nobody read.
  const computedPayloadDigest = sha256Hex(payloadUtf8);
  if (computedPayloadDigest !== payloadSha256) {
    fail("payloadSha256 does not match the SHA-256 of payloadUtf8");
  }

  return {
    gatewayEpoch: bounded("gatewayEpoch", MAX_IDENTIFIER_LENGTH),
    ingestSeq: bigintString("ingestSeq"),
    source: bounded("source", MAX_IDENTIFIER_LENGTH),
    endpoint: bounded("endpoint", MAX_ENDPOINT_LENGTH),
    connectionId: bounded("connectionId", MAX_IDENTIFIER_LENGTH),
    subscriptionGeneration,
    receivedAt,
    receivedMonotonicNs: bigintString("receivedMonotonicNs"),
    payloadUtf8,
    payloadSha256,
  };
}

type ScanOutcome = {
  readonly header: WalSegmentHeader | null;
  readonly footer: WalSegmentFooter | null;
  readonly records: readonly WalRecordEntry[];
  readonly checksummedByteLength: number;
  readonly computedSha256: string;
  readonly issues: readonly WalSegmentIssue[];
};

/**
 * Scan the bytes of a segment file into classified lines.
 *
 * The scan stops at the first structural defect and reports it: describing the
 * rest of a file whose framing is already broken produces noise, not
 * information. An **incomplete final record** — bytes after the last `LF` — is
 * reported as its own issue code because `wal-format.md` §10 gives it a
 * different meaning from corruption: it is what a crash mid-append leaves, and
 * it is the only thing WAL recovery is allowed to remove. This package removes
 * nothing; it refuses the segment and lets recovery (`WP-050`, run by the
 * recorder) finalize it.
 */
function scanSegmentBytes(bytes: Uint8Array, maxRecordBytes: number): ScanOutcome {
  const issues: WalSegmentIssue[] = [];
  const records: WalRecordEntry[] = [];
  const hash = createHash("sha256");
  let header: WalSegmentHeader | null = null;
  let footer: WalSegmentFooter | null = null;
  let checksummedByteLength = 0;
  let offset = 0;
  let lineIndex = 0;

  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  while (offset < buffer.length) {
    if (footer !== null) {
      // §3: "a completed segment ends immediately after the footer's `LF`".
      // Anything past it is `RECORD_AFTER_FOOTER` whether or not it happens to
      // be newline-terminated. The distinction is load-bearing: an incomplete
      // final record is the one thing WAL recovery may truncate (§10), and
      // bytes after a footer are not that — they are corruption, and
      // mislabelling them would invite a silent repair ADR-004 §3 forbids.
      issues.push({
        code: "RECORD_AFTER_FOOTER",
        message: "segment carries bytes after its footer",
        details: { lineIndex, byteOffset: offset, byteLength: buffer.length - offset },
      });
      break;
    }
    const newlineIndex = buffer.indexOf(LINE_FEED, offset);
    if (newlineIndex === -1) {
      issues.push({
        code: "INCOMPLETE_FINAL_RECORD",
        message: "segment ends with bytes that are not terminated by a line feed",
        details: { byteOffset: offset, byteLength: buffer.length - offset },
      });
      break;
    }
    const byteLength = newlineIndex - offset + 1;
    if (byteLength > maxRecordBytes) {
      issues.push({
        code: "RECORD_TOO_LARGE",
        message: `segment line exceeds the ${maxRecordBytes}-byte reader bound`,
        details: { lineIndex, byteOffset: offset, byteLength },
      });
      break;
    }
    const lineBytes = buffer.subarray(offset, newlineIndex + 1);
    const text = lineBytes.subarray(0, byteLength - 1).toString("utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      issues.push({
        code: "RECORD_INVALID",
        message: "segment line is not valid JSON",
        details: { lineIndex, byteOffset: offset },
      });
      break;
    }

    let discriminator: unknown;
    try {
      discriminator = requirePlainObject(parsed, "segment line")["record"];
    } catch (error) {
      issues.push({
        code: "RECORD_INVALID",
        message: error instanceof Error ? error.message : "segment line is not a JSON object",
        details: { lineIndex, byteOffset: offset },
      });
      break;
    }

    if (discriminator === "header") {
      if (lineIndex !== 0) {
        issues.push({
          code: "RECORD_INVALID",
          message: "a header record appears after the first line",
          details: { lineIndex, byteOffset: offset },
        });
        break;
      }
      try {
        header = parseSegmentHeader(parsed as Record<string, unknown>);
      } catch (error) {
        issues.push({
          code: error instanceof ParseFailure ? "UNSUPPORTED_FORMAT" : "RECORD_INVALID",
          message: error instanceof Error ? error.message : "segment header is invalid",
          details: { lineIndex, byteOffset: offset },
        });
        break;
      }
      hash.update(lineBytes);
      checksummedByteLength += byteLength;
    } else if (discriminator === "footer") {
      if (header === null) {
        issues.push({
          code: "HEADER_MISSING",
          message: "segment footer appears before any header",
          details: { lineIndex, byteOffset: offset },
        });
        break;
      }
      try {
        footer = parseSegmentFooter(parsed as Record<string, unknown>);
      } catch (error) {
        issues.push({
          code: "RECORD_INVALID",
          message: error instanceof Error ? error.message : "segment footer is invalid",
          details: { lineIndex, byteOffset: offset },
        });
        break;
      }
      // Deliberately not hashed and not counted: §7, the digest covers the
      // header plus every frame line and cannot cover the line that holds it.
    } else if (discriminator !== undefined) {
      issues.push({
        code: "RECORD_INVALID",
        message: "segment line has an unknown record discriminator",
        details: { lineIndex, byteOffset: offset, record: discriminator },
      });
      break;
    } else {
      if (header === null) {
        issues.push({
          code: "HEADER_MISSING",
          message: "segment does not begin with a header record",
          details: { lineIndex, byteOffset: offset },
        });
        break;
      }
      let record: RawFrameRecord;
      try {
        record = parseRawFrameRecord(parsed);
      } catch (error) {
        issues.push({
          code: "RECORD_INVALID",
          message: error instanceof Error ? error.message : "segment line is not a valid frame",
          details: { lineIndex, byteOffset: offset },
        });
        break;
      }
      records.push({
        recordIndex: records.length,
        byteOffset: offset,
        byteLength,
        lineSha256: sha256Hex(lineBytes),
        record,
      });
      hash.update(lineBytes);
      checksummedByteLength += byteLength;
    }

    offset = newlineIndex + 1;
    lineIndex += 1;
  }

  if (header === null && issues.length === 0) {
    issues.push({
      code: "HEADER_MISSING",
      message: "segment is empty and carries no header record",
    });
  }

  return {
    header,
    footer,
    records,
    checksummedByteLength,
    computedSha256: hash.digest("hex"),
    issues,
  };
}

/**
 * Cross-check a manifest against itself, its header, its footer, and the bytes.
 *
 * `wal-format.md` §6.3 states the reason this is not optional: a checksum
 * protects the bytes but protects nothing about the *claims* made about those
 * bytes. `gatewayEpoch`, `firstIngestSeq`, `closeReason` and the rest can all be
 * edited in the sidecar while every digest still verifies — and those are
 * exactly the fields this package copies into a dataset manifest, where an
 * edited range silently mislabels which data a dataset contains.
 */
function crossCheckManifest(
  manifest: WalSegmentManifest,
  scan: ScanOutcome,
  byteSize: number,
): readonly WalSegmentIssue[] {
  const issues: WalSegmentIssue[] = [];
  const header = scan.header;
  const footer = scan.footer;

  if (manifest.segmentFileName !== walSegmentFileName(manifest.segmentId)) {
    issues.push({
      code: "MANIFEST_INCONSISTENT",
      message: "segmentFileName does not follow from segmentId",
      details: { segmentFileName: manifest.segmentFileName, segmentId: manifest.segmentId },
    });
  }
  if (manifest.footerPresent && manifest.truncatedTailBytes !== 0) {
    issues.push({
      code: "MANIFEST_INCONSISTENT",
      message: "a segment with a footer cannot also have had a tail truncated",
    });
  }
  if (
    manifest.truncatedTailBytes !== 0 &&
    manifest.closeReason !== "recovery" &&
    manifest.closeReason !== "write-fault"
  ) {
    issues.push({
      code: "MANIFEST_INCONSISTENT",
      message: "only recovery or write-fault truncates a tail",
      details: { closeReason: manifest.closeReason },
    });
  }
  if (manifest.checksummedByteLength > manifest.byteSize) {
    issues.push({
      code: "MANIFEST_INCONSISTENT",
      message: "checksummedByteLength exceeds byteSize",
    });
  }
  const rangeIsNull =
    manifest.firstIngestSeq === null &&
    manifest.lastIngestSeq === null &&
    manifest.firstReceivedAt === null &&
    manifest.lastReceivedAt === null;
  if ((manifest.recordCount === 0) !== rangeIsNull) {
    issues.push({
      code: "MANIFEST_INCONSISTENT",
      message: "recordCount === 0 must hold exactly when the record range is null",
    });
  }
  if (
    manifest.segmentIdKind === "default" &&
    manifest.segmentId !== defaultSegmentId(manifest.gatewayEpoch, manifest.segmentIndex)
  ) {
    issues.push({
      code: "MANIFEST_INCONSISTENT",
      message: "a default-provenance id must be exactly what the default factory produces",
    });
  }

  if (header !== null) {
    const disagreements: string[] = [];
    if (header.formatId !== manifest.formatId) disagreements.push("formatId");
    if (header.walSchemaVersion !== manifest.walSchemaVersion) {
      disagreements.push("walSchemaVersion");
    }
    if (header.segmentId !== manifest.segmentId) disagreements.push("segmentId");
    if (header.gatewayEpoch !== manifest.gatewayEpoch) disagreements.push("gatewayEpoch");
    if (header.segmentIndex !== manifest.segmentIndex) disagreements.push("segmentIndex");
    if (header.createdAt !== manifest.createdAt) disagreements.push("createdAt");
    if (disagreements.length > 0) {
      issues.push({
        code: "MANIFEST_HEADER_DISAGREE",
        message: `manifest contradicts the segment header: ${disagreements.join(", ")}`,
        details: { fields: disagreements },
      });
    }
  }

  if (footer !== null) {
    const disagreements: string[] = [];
    if (footer.formatId !== manifest.formatId) disagreements.push("formatId");
    if (footer.walSchemaVersion !== manifest.walSchemaVersion) {
      disagreements.push("walSchemaVersion");
    }
    if (footer.segmentId !== manifest.segmentId) disagreements.push("segmentId");
    if (footer.gatewayEpoch !== manifest.gatewayEpoch) disagreements.push("gatewayEpoch");
    if (footer.recordCount !== manifest.recordCount) disagreements.push("recordCount");
    if (footer.checksummedByteLength !== manifest.checksummedByteLength) {
      disagreements.push("checksummedByteLength");
    }
    if (footer.segmentSha256 !== manifest.segmentSha256) disagreements.push("segmentSha256");
    if (footer.closedAt !== manifest.closedAt) disagreements.push("closedAt");
    if (footer.closeReason !== manifest.closeReason) disagreements.push("closeReason");
    if (disagreements.length > 0) {
      issues.push({
        code: "FOOTER_MANIFEST_DISAGREE",
        message: `manifest contradicts the segment footer: ${disagreements.join(", ")}`,
        details: { fields: disagreements },
      });
    }
  }
  if (manifest.footerPresent !== (footer !== null)) {
    issues.push({
      code: "MANIFEST_CONTENT_DISAGREE",
      message: "footerPresent does not match the bytes on disk",
      details: { declared: manifest.footerPresent, observed: footer !== null },
    });
  }

  if (manifest.recordCount !== scan.records.length) {
    issues.push({
      code: "RECORD_COUNT_MISMATCH",
      message: "manifest recordCount does not match the records on disk",
      details: { declared: manifest.recordCount, observed: scan.records.length },
    });
  }
  if (manifest.checksummedByteLength !== scan.checksummedByteLength) {
    issues.push({
      code: "CHECKSUM_LENGTH_MISMATCH",
      message: "manifest checksummedByteLength does not match the bytes on disk",
      details: { declared: manifest.checksummedByteLength, observed: scan.checksummedByteLength },
    });
  }
  if (manifest.segmentSha256 !== scan.computedSha256) {
    issues.push({
      code: "CHECKSUM_MISMATCH",
      message: "manifest segmentSha256 does not match the bytes on disk",
      details: { declared: manifest.segmentSha256, computed: scan.computedSha256 },
    });
  }
  if (manifest.byteSize !== byteSize) {
    issues.push({
      code: "BYTE_SIZE_MISMATCH",
      message: "manifest byteSize does not match the file length",
      details: { declared: manifest.byteSize, observed: byteSize },
    });
  }

  const first = scan.records[0] ?? null;
  const last = scan.records[scan.records.length - 1] ?? null;
  const contentDisagreements: string[] = [];
  if (manifest.firstIngestSeq !== (first === null ? null : first.record.ingestSeq)) {
    contentDisagreements.push("firstIngestSeq");
  }
  if (manifest.lastIngestSeq !== (last === null ? null : last.record.ingestSeq)) {
    contentDisagreements.push("lastIngestSeq");
  }
  if (manifest.firstReceivedAt !== (first === null ? null : first.record.receivedAt)) {
    contentDisagreements.push("firstReceivedAt");
  }
  if (manifest.lastReceivedAt !== (last === null ? null : last.record.receivedAt)) {
    contentDisagreements.push("lastReceivedAt");
  }
  if (contentDisagreements.length > 0) {
    issues.push({
      code: "MANIFEST_CONTENT_DISAGREE",
      message: `manifest contradicts the records on disk: ${contentDisagreements.join(", ")}`,
      details: { fields: contentDisagreements },
    });
  }

  for (const entry of scan.records) {
    if (entry.record.gatewayEpoch !== manifest.gatewayEpoch) {
      issues.push({
        code: "GATEWAY_EPOCH_MISMATCH",
        message: "a frame record carries a different gateway epoch than its segment",
        details: {
          recordIndex: entry.recordIndex,
          declared: manifest.gatewayEpoch,
          observed: entry.record.gatewayEpoch,
        },
      });
      break;
    }
  }

  return issues;
}

/** Filesystem surface a segment read needs. Deliberately read-only. */
export type WalSegmentBytesSource = {
  /** Byte length of the segment file, or `null` when it does not exist. */
  readonly segmentByteLength: (segmentId: string) => Promise<number | null>;
  /** Whole segment file bytes. */
  readonly readSegment: (segmentId: string) => Promise<Uint8Array>;
  /** Whole sidecar manifest bytes, or `null` when the segment has none. */
  readonly readManifest: (segmentId: string) => Promise<Uint8Array | null>;
};

export type ReadWalSegmentOptions = {
  readonly maxSegmentBytes?: number;
  readonly maxRecordBytes?: number;
};

/**
 * Read and fully verify one WAL segment.
 *
 * Returns `verified` only when every condition of `wal-format.md` §7 holds.
 * Anything else is `refused`, with issues — the caller records the refusal in
 * the dataset manifest's exclusion list and, per ADR-004 §3, opens or
 * references a data-quality incident.
 */
export async function readWalSegment(
  source: WalSegmentBytesSource,
  segmentId: string,
  options: ReadWalSegmentOptions = {},
): Promise<WalSegmentReadResult> {
  const maxSegmentBytes = options.maxSegmentBytes ?? Number.POSITIVE_INFINITY;
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;

  const manifestBytes = await source.readManifest(segmentId);
  if (manifestBytes === null) {
    return {
      status: "refused",
      segmentId,
      manifest: null,
      issues: [
        {
          code: "MANIFEST_MISSING",
          message:
            "segment carries no sidecar manifest and is therefore unverified (wal-format.md §2)",
        },
      ],
    };
  }

  let manifest: WalSegmentManifest;
  try {
    manifest = parseWalSegmentManifest(
      JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown,
    );
  } catch (error) {
    return {
      status: "refused",
      segmentId,
      manifest: null,
      issues: [
        {
          code: "MANIFEST_UNREADABLE",
          message: error instanceof Error ? error.message : "manifest could not be parsed",
        },
      ],
    };
  }

  if (manifest.segmentId !== segmentId) {
    return {
      status: "refused",
      segmentId,
      manifest,
      issues: [
        {
          code: "SEGMENT_ID_MISMATCH",
          message: "manifest segment id does not match its file name",
          details: { declared: manifest.segmentId, fileName: walManifestFileName(segmentId) },
        },
      ],
    };
  }

  const byteSize = await source.segmentByteLength(segmentId);
  if (byteSize === null) {
    return {
      status: "refused",
      segmentId,
      manifest,
      issues: [
        {
          code: "SEGMENT_MISSING",
          message: "a manifest exists but its segment file does not",
        },
      ],
    };
  }
  if (byteSize > maxSegmentBytes) {
    return {
      status: "refused",
      segmentId,
      manifest,
      issues: [
        {
          code: "SEGMENT_TOO_LARGE",
          message: `segment is larger than the configured ${maxSegmentBytes}-byte compaction bound`,
          details: { byteSize, maxSegmentBytes },
        },
      ],
    };
  }

  const bytes = await source.readSegment(segmentId);
  const scan = scanSegmentBytes(bytes, maxRecordBytes);
  const issues = [...scan.issues];
  if (issues.length === 0) {
    issues.push(...crossCheckManifest(manifest, scan, bytes.byteLength));
  }

  if (issues.length > 0 || scan.header === null) {
    return { status: "refused", segmentId, manifest, issues };
  }

  return {
    status: "verified",
    segmentId,
    manifest,
    header: scan.header,
    footer: scan.footer,
    records: scan.records,
    computedSegmentSha256: scan.computedSha256,
    byteSize: bytes.byteLength,
  };
}
