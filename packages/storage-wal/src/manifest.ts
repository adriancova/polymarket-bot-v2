/**
 * Segment manifests — the per-segment metadata `WP-130` compaction and §12.5
 * dataset manifests consume.
 *
 * The manifest is the ADR-004 §2 **sidecar**: it carries the record count and
 * the SHA-256 of the segment, and it is the form that survives a crash, because
 * a footer cannot be written by a process that is no longer running. A cleanly
 * closed segment has both a footer and a manifest and they must agree; a
 * crash-closed segment has only a manifest, written by recovery.
 *
 * `WP-050` never deletes anything. The manifest is what a later compactor
 * verifies **before** it may delete (ADR-004 §5).
 */

import {
  MANIFEST_FILE_SUFFIX,
  SEGMENT_FILE_SUFFIX,
  WAL_FORMAT_ID,
  WAL_MANIFEST_VERSION,
  WAL_SCHEMA_VERSION,
} from "./constants.js";
import { WalManifestError } from "./errors.js";
import type { SegmentIdContext, WalCloseReason, WalFileSystem } from "./ports.js";

/**
 * Everything a compactor needs about one segment without opening it: identity,
 * epoch, record range, byte size, checksum, and lifecycle timestamps.
 */
export type WalSegmentManifest = {
  readonly manifestVersion: number;
  readonly formatId: string;
  readonly walSchemaVersion: number;
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly segmentFileName: string;
  /** Number of frame records, excluding the header and footer lines. */
  readonly recordCount: number;
  /** First/last `ingestSeq` in the segment; `null` for an empty segment. */
  readonly firstIngestSeq: string | null;
  readonly lastIngestSeq: string | null;
  readonly firstReceivedAt: string | null;
  readonly lastReceivedAt: string | null;
  /** Total bytes of the segment file, including the footer line when present. */
  readonly byteSize: number;
  /** Bytes covered by `segmentSha256`: the header plus every frame line. */
  readonly checksummedByteLength: number;
  readonly segmentSha256: string;
  readonly createdAt: string;
  readonly closedAt: string;
  readonly closeReason: WalCloseReason;
  /** Whether the segment carries an in-file footer as well as this sidecar. */
  readonly footerPresent: boolean;
  /**
   * Bytes removed by crash recovery because they formed an incomplete final
   * record. `0` for a segment that was closed cleanly. A non-zero value is the
   * published data-loss bound made concrete for this segment.
   */
  readonly truncatedTailBytes: number;
};

/** `<segmentId>.wal.jsonl`. */
export function segmentFileName(segmentId: string): string {
  return `${segmentId}${SEGMENT_FILE_SUFFIX}`;
}

/** `<segmentId>.wal.manifest.json`. */
export function manifestFileName(segmentId: string): string {
  return `${segmentId}${MANIFEST_FILE_SUFFIX}`;
}

/** True for a file name that is a segment file. */
export function isSegmentFileName(fileName: string): boolean {
  return fileName.endsWith(SEGMENT_FILE_SUFFIX) && fileName.length > SEGMENT_FILE_SUFFIX.length;
}

/** The segment id encoded in a segment file name, or `null`. */
export function segmentIdFromFileName(fileName: string): string | null {
  if (!isSegmentFileName(fileName)) {
    return null;
  }
  return fileName.slice(0, fileName.length - SEGMENT_FILE_SUFFIX.length);
}

/**
 * Default segment identity: the gateway epoch plus a zero-padded per-directory
 * ordinal.
 *
 * A pure function of its input — no clock, no randomness (§12.4). The epoch
 * component is what keeps identifiers unique across process restarts, since the
 * ordinal restarts from the directory contents.
 */
export const defaultSegmentIdFactory = (context: SegmentIdContext): string =>
  `${context.gatewayEpoch}-${String(context.segmentIndex).padStart(6, "0")}`;

const LOWERCASE_SHA256_HEX = /^[0-9a-f]{64}$/u;

const CLOSE_REASONS: readonly WalCloseReason[] = [
  "size-rotation",
  "time-rotation",
  "manual-rotation",
  "shutdown",
  "recovery",
  "write-fault",
];

function fail(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new WalManifestError(message, details);
}

function readString(
  candidate: Record<string, unknown>,
  field: string,
  details: Readonly<Record<string, unknown>>,
): string {
  const value = candidate[field];
  if (typeof value !== "string" || value.length === 0) {
    fail(`manifest field ${field} must be a non-empty string`, { ...details, field });
  }
  return value;
}

function readNullableString(
  candidate: Record<string, unknown>,
  field: string,
  details: Readonly<Record<string, unknown>>,
): string | null {
  const value = candidate[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    fail(`manifest field ${field} must be a non-empty string or null`, { ...details, field });
  }
  return value;
}

function readInteger(
  candidate: Record<string, unknown>,
  field: string,
  details: Readonly<Record<string, unknown>>,
): number {
  const value = candidate[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`manifest field ${field} must be a non-negative safe integer`, {
      ...details,
      field,
      value,
    });
  }
  return value;
}

function readBoolean(
  candidate: Record<string, unknown>,
  field: string,
  details: Readonly<Record<string, unknown>>,
): boolean {
  const value = candidate[field];
  if (typeof value !== "boolean") {
    fail(`manifest field ${field} must be a boolean`, { ...details, field, value });
  }
  return value;
}

/** Serialize a manifest. Pretty-printed: an operator reads this during an incident. */
export function encodeSegmentManifest(manifest: WalSegmentManifest): Uint8Array {
  const ordered = {
    manifestVersion: manifest.manifestVersion,
    formatId: manifest.formatId,
    walSchemaVersion: manifest.walSchemaVersion,
    segmentId: manifest.segmentId,
    gatewayEpoch: manifest.gatewayEpoch,
    segmentIndex: manifest.segmentIndex,
    segmentFileName: manifest.segmentFileName,
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

/** Parse and validate a manifest document. */
export function parseSegmentManifest(
  value: unknown,
  details: Readonly<Record<string, unknown>> = {},
): WalSegmentManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("manifest must be a JSON object", details);
  }
  const candidate = value as Record<string, unknown>;

  const formatId = readString(candidate, "formatId", details);
  if (formatId !== WAL_FORMAT_ID) {
    fail("manifest declares an unknown WAL format", { ...details, formatId });
  }
  const manifestVersion = readInteger(candidate, "manifestVersion", details);
  if (manifestVersion !== WAL_MANIFEST_VERSION) {
    fail("manifest version is not readable by this build", {
      ...details,
      manifestVersion,
      supported: WAL_MANIFEST_VERSION,
    });
  }
  const walSchemaVersion = readInteger(candidate, "walSchemaVersion", details);
  if (walSchemaVersion !== WAL_SCHEMA_VERSION) {
    fail("manifest declares an unsupported segment schema version", {
      ...details,
      walSchemaVersion,
    });
  }
  const segmentSha256 = readString(candidate, "segmentSha256", details);
  if (!LOWERCASE_SHA256_HEX.test(segmentSha256)) {
    fail("manifest checksum must be 64 lowercase hexadecimal characters", {
      ...details,
      segmentSha256,
    });
  }
  const closeReason = candidate["closeReason"];
  if (typeof closeReason !== "string" || !CLOSE_REASONS.includes(closeReason as WalCloseReason)) {
    fail("manifest declares an unknown close reason", { ...details, closeReason });
  }

  return {
    manifestVersion,
    formatId,
    walSchemaVersion,
    segmentId: readString(candidate, "segmentId", details),
    gatewayEpoch: readString(candidate, "gatewayEpoch", details),
    segmentIndex: readInteger(candidate, "segmentIndex", details),
    segmentFileName: readString(candidate, "segmentFileName", details),
    recordCount: readInteger(candidate, "recordCount", details),
    firstIngestSeq: readNullableString(candidate, "firstIngestSeq", details),
    lastIngestSeq: readNullableString(candidate, "lastIngestSeq", details),
    firstReceivedAt: readNullableString(candidate, "firstReceivedAt", details),
    lastReceivedAt: readNullableString(candidate, "lastReceivedAt", details),
    byteSize: readInteger(candidate, "byteSize", details),
    checksummedByteLength: readInteger(candidate, "checksummedByteLength", details),
    segmentSha256,
    createdAt: readString(candidate, "createdAt", details),
    closedAt: readString(candidate, "closedAt", details),
    closeReason: closeReason as WalCloseReason,
    footerPresent: readBoolean(candidate, "footerPresent", details),
    truncatedTailBytes: readInteger(candidate, "truncatedTailBytes", details),
  };
}

/** Write a manifest durably next to its segment. */
export async function writeSegmentManifest(
  fileSystem: WalFileSystem,
  directoryPath: string,
  manifest: WalSegmentManifest,
): Promise<string> {
  const path = fileSystem.joinPath(directoryPath, manifestFileName(manifest.segmentId));
  await fileSystem.writeWholeFile(path, encodeSegmentManifest(manifest));
  return path;
}

/** Read one segment's manifest, or `null` when the segment has none. */
export async function readSegmentManifest(
  fileSystem: WalFileSystem,
  directoryPath: string,
  segmentId: string,
): Promise<WalSegmentManifest | null> {
  const path = fileSystem.joinPath(directoryPath, manifestFileName(segmentId));
  const byteLength = await fileSystem.fileByteLength(path);
  if (byteLength === null) {
    return null;
  }
  const bytes = await fileSystem.readWholeFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new WalManifestError("manifest is not valid JSON", {
      segmentId,
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const manifest = parseSegmentManifest(parsed, { segmentId, path });
  if (manifest.segmentId !== segmentId) {
    throw new WalManifestError("manifest segment id does not match its file name", {
      segmentId,
      declared: manifest.segmentId,
      path,
    });
  }
  return manifest;
}

/**
 * Every manifest in a WAL directory, ordered by segment index then segment id.
 *
 * A segment without a manifest is deliberately absent: it has not been verified
 * as complete, so it is not offered to a compactor (ADR-004 §3, §5).
 */
export async function listSegmentManifests(
  fileSystem: WalFileSystem,
  directoryPath: string,
): Promise<readonly WalSegmentManifest[]> {
  const fileNames = await fileSystem.listFileNames(directoryPath);
  const manifests: WalSegmentManifest[] = [];
  for (const fileName of [...fileNames].sort()) {
    if (!fileName.endsWith(MANIFEST_FILE_SUFFIX)) {
      continue;
    }
    const segmentId = fileName.slice(0, fileName.length - MANIFEST_FILE_SUFFIX.length);
    const manifest = await readSegmentManifest(fileSystem, directoryPath, segmentId);
    if (manifest !== null) {
      manifests.push(manifest);
    }
  }
  return manifests.sort((left, right) => {
    if (left.segmentIndex !== right.segmentIndex) {
      return left.segmentIndex - right.segmentIndex;
    }
    return left.segmentId < right.segmentId ? -1 : left.segmentId > right.segmentId ? 1 : 0;
  });
}
