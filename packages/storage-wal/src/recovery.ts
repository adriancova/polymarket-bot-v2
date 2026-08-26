/**
 * Crash recovery.
 *
 * The rule, from ADR-004 §3 and handoff §9.1, is narrow on purpose: recovery
 * **truncates only an incomplete final record**. It never discards a well-formed
 * record, never rewrites earlier bytes, and never repairs a middle-of-file
 * corruption. A corrupt non-final record is a data-quality incident, and the
 * segment is left exactly as found, without a manifest — which is precisely how
 * it stays out of dataset manifests and out of a compactor's reach (§10.2,
 * §12.5, ADR-004 §5).
 *
 * Recovery is idempotent. A segment that already carries a manifest is
 * finalized, and a second pass neither reads its bytes nor writes anything.
 */

import { isoFromEpochMs } from "./clock.js";
import { WAL_FORMAT_ID, WAL_MANIFEST_VERSION, WAL_SCHEMA_VERSION } from "./constants.js";
import { WalSegmentIntegrityError } from "./errors.js";
import {
  isSegmentFileName,
  readSegmentManifest,
  segmentFileName,
  segmentIdFromFileName,
  writeSegmentManifest,
} from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import type { WalClock, WalFileSystem } from "./ports.js";
import { scanSegment } from "./reader.js";
import type { SegmentIssue } from "./reader.js";

export type SegmentRecoveryOutcome =
  /** The segment already had a manifest; nothing was read or written. */
  | "already-finalized"
  /** An incomplete final record was truncated and a manifest was written. */
  | "recovered-truncated"
  /** The segment ended on a record boundary; a manifest was written. */
  | "recovered-clean"
  /** No header survived (crash before or during the header write). */
  | "empty"
  /** The segment is corrupt beyond an incomplete final record. */
  | "integrity-error";

export type SegmentRecoveryReport = {
  readonly segmentId: string;
  readonly path: string;
  readonly outcome: SegmentRecoveryOutcome;
  /** Bytes removed because they formed an incomplete final record. */
  readonly truncatedBytes: number;
  readonly recordCount: number;
  readonly segmentSha256: string | null;
  readonly manifest: WalSegmentManifest | null;
  readonly issues: readonly SegmentIssue[];
};

export type WalRecoveryReport = {
  readonly directoryPath: string;
  readonly recoveredAt: string;
  readonly segments: readonly SegmentRecoveryReport[];
  readonly truncatedSegmentCount: number;
  readonly truncatedBytes: number;
  readonly integrityFailureCount: number;
  /**
   * True when at least one segment is corrupt beyond an incomplete final
   * record. The caller opens a data-quality incident; recording continues,
   * because §4.2 forbids letting a storage problem stop the recorder.
   */
  readonly hasIntegrityFailures: boolean;
  /** Total bytes of every segment file after recovery (capacity accounting). */
  readonly totalSegmentBytes: number;
  /** The ordinal a newly opened segment should use in this directory. */
  readonly nextSegmentIndex: number;
};

export type WalRecoveryOptions = {
  readonly clock: WalClock;
  readonly chunkBytes?: number;
  readonly maxRecordBytes?: number;
};

/**
 * Recover one segment.
 *
 * Returns a report rather than throwing for a corrupt segment: the caller
 * (`WP-120`) needs to open an incident and keep recording, not crash.
 */
export async function recoverSegment(
  fileSystem: WalFileSystem,
  directoryPath: string,
  segmentId: string,
  options: WalRecoveryOptions,
): Promise<SegmentRecoveryReport> {
  const path = fileSystem.joinPath(directoryPath, segmentFileName(segmentId));
  const byteLength = await fileSystem.fileByteLength(path);
  if (byteLength === null) {
    throw new WalSegmentIntegrityError("segment file does not exist", { path, segmentId });
  }

  const existingManifest = await readSegmentManifest(fileSystem, directoryPath, segmentId);
  if (existingManifest !== null) {
    return {
      segmentId,
      path,
      outcome: "already-finalized",
      truncatedBytes: 0,
      recordCount: existingManifest.recordCount,
      segmentSha256: existingManifest.segmentSha256,
      manifest: existingManifest,
      issues: [],
    };
  }

  const scan = await scanSegment(fileSystem, path, {
    onIssue: "collect",
    expectedSegmentId: segmentId,
    ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
    ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
  });

  const fatalIssues = scan.issues.filter((issue) => issue.code !== "INCOMPLETE_FINAL_RECORD");
  if (fatalIssues.length > 0) {
    return {
      segmentId,
      path,
      outcome: "integrity-error",
      truncatedBytes: 0,
      recordCount: scan.recordCount,
      segmentSha256: null,
      manifest: null,
      issues: scan.issues,
    };
  }

  const incomplete = scan.incompleteFinalRecord;
  if (scan.header === null) {
    // A crash before (or during) the header write leaves nothing verifiable.
    // Truncate the partial header if there is one; write no manifest, because
    // there is no segment to describe. The file is kept, never deleted.
    if (incomplete !== null) {
      await fileSystem.truncate(path, incomplete.byteOffset);
    }
    return {
      segmentId,
      path,
      outcome: "empty",
      truncatedBytes: incomplete?.byteLength ?? 0,
      recordCount: 0,
      segmentSha256: null,
      manifest: null,
      issues: scan.issues,
    };
  }

  let byteSize = scan.byteSize;
  let truncatedBytes = 0;
  if (incomplete !== null) {
    await fileSystem.truncate(path, incomplete.byteOffset);
    truncatedBytes = incomplete.byteLength;
    byteSize = incomplete.byteOffset;
  }

  const closedAtMs = options.clock.nowMs();
  const manifest: WalSegmentManifest = {
    manifestVersion: WAL_MANIFEST_VERSION,
    formatId: WAL_FORMAT_ID,
    walSchemaVersion: WAL_SCHEMA_VERSION,
    segmentId,
    gatewayEpoch: scan.header.gatewayEpoch,
    segmentIndex: scan.header.segmentIndex,
    segmentFileName: segmentFileName(segmentId),
    recordCount: scan.recordCount,
    firstIngestSeq: scan.firstIngestSeq,
    lastIngestSeq: scan.lastIngestSeq,
    firstReceivedAt: scan.firstReceivedAt,
    lastReceivedAt: scan.lastReceivedAt,
    byteSize,
    checksummedByteLength: scan.checksummedByteLength,
    segmentSha256: scan.computedSha256,
    createdAt: scan.header.createdAt,
    // A footer written before the crash keeps its original close reason and
    // timestamp: recovery describes what happened, it does not rewrite it.
    closedAt: scan.footer?.closedAt ?? isoFromEpochMs(closedAtMs),
    closeReason: scan.footer?.closeReason ?? "recovery",
    footerPresent: scan.footer !== null,
    truncatedTailBytes: truncatedBytes,
  };
  await writeSegmentManifest(fileSystem, directoryPath, manifest);

  return {
    segmentId,
    path,
    outcome: truncatedBytes > 0 ? "recovered-truncated" : "recovered-clean",
    truncatedBytes,
    recordCount: scan.recordCount,
    segmentSha256: scan.computedSha256,
    manifest,
    issues: scan.issues,
  };
}

/**
 * Recover every segment in a WAL directory.
 *
 * Called by {@link openWalWriter} before the first byte is written, and usable
 * on its own by an ops tool. Creates the directory when it is absent.
 */
export async function recoverWalDirectory(
  fileSystem: WalFileSystem,
  directoryPath: string,
  options: WalRecoveryOptions,
): Promise<WalRecoveryReport> {
  await fileSystem.ensureDirectory(directoryPath);
  const fileNames = await fileSystem.listFileNames(directoryPath);
  const segmentIds = [...fileNames]
    .sort()
    .filter((fileName) => isSegmentFileName(fileName))
    .map((fileName) => segmentIdFromFileName(fileName))
    .filter((segmentId): segmentId is string => segmentId !== null);

  const segments: SegmentRecoveryReport[] = [];
  let truncatedSegmentCount = 0;
  let truncatedBytes = 0;
  let integrityFailureCount = 0;
  let totalSegmentBytes = 0;
  let highestSegmentIndex = -1;

  for (const segmentId of segmentIds) {
    const report = await recoverSegment(fileSystem, directoryPath, segmentId, options);
    segments.push(report);
    if (report.outcome === "recovered-truncated") {
      truncatedSegmentCount += 1;
      truncatedBytes += report.truncatedBytes;
    }
    if (report.outcome === "integrity-error") {
      integrityFailureCount += 1;
    }
    if (report.manifest !== null) {
      highestSegmentIndex = Math.max(highestSegmentIndex, report.manifest.segmentIndex);
    }
    const size = await fileSystem.fileByteLength(report.path);
    totalSegmentBytes += size ?? 0;
  }

  return {
    directoryPath,
    recoveredAt: isoFromEpochMs(options.clock.nowMs()),
    segments,
    truncatedSegmentCount,
    truncatedBytes,
    integrityFailureCount,
    hasIntegrityFailures: integrityFailureCount > 0,
    totalSegmentBytes,
    nextSegmentIndex: Math.max(highestSegmentIndex + 1, segmentIds.length),
  };
}
