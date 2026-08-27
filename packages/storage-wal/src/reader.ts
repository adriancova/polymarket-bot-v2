/**
 * Sequential segment reading and validation.
 *
 * One scanner backs every read path — iteration, validation, recovery, and the
 * writer's post-fault reconciliation — so there is exactly one implementation of
 * "what this file actually contains".
 *
 * The scanner distinguishes the two failure modes ADR-004 §3 separates:
 *
 * - an **incomplete final record** (bytes after the last newline) is reported as
 *   state, not as corruption, because it is the expected result of a crash
 *   mid-append and it is the only thing recovery may truncate;
 * - anything else — a malformed line in the middle, a missing header, a footer
 *   that disagrees with the bytes — is an integrity failure and a data-quality
 *   incident.
 */

import { createHash } from "node:crypto";

import {
  DEFAULT_MAX_RECORD_BYTES,
  DEFAULT_READ_CHUNK_BYTES,
  LINE_FEED,
} from "./constants.js";
import { WalSegmentIntegrityError } from "./errors.js";
import {
  defaultSegmentIdFactory,
  isSegmentFileName,
  readSegmentManifest,
  segmentFileName,
  segmentIdFromFileName,
} from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import type { WalFileSystem } from "./ports.js";
import { compareIngestSeq } from "./raw-frame.js";
import type { RawFrameRecord } from "./raw-frame.js";
import { classifySegmentLine } from "./segment-format.js";
import type { WalSegmentFooter, WalSegmentHeader } from "./segment-format.js";

/** Machine-readable classification of a segment defect. */
export type SegmentIssueCode =
  | "HEADER_MISSING"
  | "RECORD_INVALID"
  | "RECORD_TOO_LARGE"
  | "RECORD_AFTER_FOOTER"
  | "INCOMPLETE_FINAL_RECORD"
  | "RECORD_COUNT_MISMATCH"
  | "CHECKSUM_MISMATCH"
  | "CHECKSUM_LENGTH_MISMATCH"
  | "SEGMENT_ID_MISMATCH"
  | "GATEWAY_EPOCH_MISMATCH"
  | "BYTE_SIZE_MISMATCH"
  | "MANIFEST_MISSING"
  | "FOOTER_MANIFEST_DISAGREE"
  /** The manifest contradicts the segment's own header. */
  | "MANIFEST_HEADER_DISAGREE"
  /** The manifest contradicts the records on disk. */
  | "MANIFEST_CONTENT_DISAGREE"
  /** The manifest contradicts itself. */
  | "MANIFEST_INCONSISTENT";

export type SegmentIssue = {
  readonly code: SegmentIssueCode;
  readonly message: string;
  readonly lineIndex?: number;
  readonly byteOffset?: number;
  readonly details?: Readonly<Record<string, unknown>>;
};

/** The trailing bytes of a segment that do not form a complete record. */
export type IncompleteFinalRecord = {
  readonly byteOffset: number;
  readonly byteLength: number;
  /** First bytes of the partial record, for an operator log. Truncated. */
  readonly preview: string;
};

/** One frame record and where it sits in the file. */
export type SegmentRecordEntry = {
  readonly index: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly record: RawFrameRecord;
};

/** Everything the scanner learned about one segment file. */
export type SegmentScanReport = {
  readonly path: string;
  readonly header: WalSegmentHeader | null;
  readonly footer: WalSegmentFooter | null;
  readonly recordCount: number;
  /** Total bytes in the file. */
  readonly byteSize: number;
  /** Bytes covered by {@link SegmentScanReport.computedSha256}. */
  readonly checksummedByteLength: number;
  /**
   * SHA-256 over the header line plus every complete frame line.
   *
   * Meaningful only when `issues` contains no code other than
   * `INCOMPLETE_FINAL_RECORD`; a scan that stopped on corruption digests a
   * prefix.
   */
  readonly computedSha256: string;
  readonly firstIngestSeq: string | null;
  readonly lastIngestSeq: string | null;
  readonly firstReceivedAt: string | null;
  readonly lastReceivedAt: string | null;
  readonly incompleteFinalRecord: IncompleteFinalRecord | null;
  readonly nonMonotonicIngestSeqCount: number;
  readonly issues: readonly SegmentIssue[];
};

export type SegmentScanOptions = {
  /**
   * `"throw"` (default) raises {@link WalSegmentIntegrityError} on the first
   * defect other than an incomplete final record. `"collect"` records it in the
   * report and stops scanning — the mode validation and recovery use, because
   * they must describe a broken file rather than fail on it.
   */
  readonly onIssue?: "throw" | "collect";
  readonly chunkBytes?: number;
  readonly maxRecordBytes?: number;
  /** Expected segment id; a mismatch with the header is an issue. */
  readonly expectedSegmentId?: string;
  /** Expected gateway epoch; a mismatch with the header is an issue. */
  readonly expectedGatewayEpoch?: string;
};

const PREVIEW_LIMIT = 120;

function issueError(issue: SegmentIssue, path: string): WalSegmentIntegrityError {
  return new WalSegmentIntegrityError(issue.message, {
    code: issue.code,
    path,
    ...(issue.lineIndex === undefined ? {} : { lineIndex: issue.lineIndex }),
    ...(issue.byteOffset === undefined ? {} : { byteOffset: issue.byteOffset }),
    ...(issue.details ?? {}),
  });
}

/**
 * Read a segment sequentially, yielding one frame record at a time and
 * returning the scan report when the file ends.
 *
 * Memory is bounded by the chunk size plus one record, so a 64 MiB segment is
 * read without materializing it.
 */
export async function* iterateSegmentRecords(
  fileSystem: WalFileSystem,
  path: string,
  options: SegmentScanOptions = {},
): AsyncGenerator<SegmentRecordEntry, SegmentScanReport, void> {
  const onIssue = options.onIssue ?? "throw";
  const chunkBytes = options.chunkBytes ?? DEFAULT_READ_CHUNK_BYTES;
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;

  const byteSize = await fileSystem.fileByteLength(path);
  if (byteSize === null) {
    throw new WalSegmentIntegrityError("segment file does not exist", { path });
  }

  const hash = createHash("sha256");
  const issues: SegmentIssue[] = [];
  let header: WalSegmentHeader | null = null;
  let footer: WalSegmentFooter | null = null;
  let recordCount = 0;
  let checksummedByteLength = 0;
  let consumedBytes = 0;
  let lineIndex = 0;
  let firstIngestSeq: string | null = null;
  let lastIngestSeq: string | null = null;
  let firstReceivedAt: string | null = null;
  let lastReceivedAt: string | null = null;
  let nonMonotonicIngestSeqCount = 0;
  let incompleteFinalRecord: IncompleteFinalRecord | null = null;
  let stopped = false;

  const record = (issue: SegmentIssue): void => {
    issues.push(issue);
    if (onIssue === "throw") {
      throw issueError(issue, path);
    }
  };

  const buildReport = (): SegmentScanReport => ({
    path,
    header,
    footer,
    recordCount,
    byteSize,
    checksummedByteLength,
    computedSha256: hash.digest("hex"),
    firstIngestSeq,
    lastIngestSeq,
    firstReceivedAt,
    lastReceivedAt,
    incompleteFinalRecord,
    nonMonotonicIngestSeqCount,
    issues,
  });

  const handle = await fileSystem.openRead(path);
  try {
    let readOffset = 0;
    let pending = Buffer.alloc(0);

    while (!stopped && readOffset < byteSize) {
      const wanted = Math.min(chunkBytes, byteSize - readOffset);
      const chunk = await handle.read(readOffset, wanted);
      if (chunk.length === 0) {
        break;
      }
      readOffset += chunk.length;
      // `Buffer.from(typedArray)` copies, so a filesystem implementation that
      // reuses its read buffer cannot corrupt bytes we still hold.
      const chunkBuffer = Buffer.from(chunk);
      pending = pending.length === 0 ? chunkBuffer : Buffer.concat([pending, chunkBuffer]);

      let searchFrom = 0;
      for (;;) {
        const newlineIndex = pending.indexOf(LINE_FEED, searchFrom);
        if (newlineIndex === -1) {
          break;
        }
        const lineBytes = pending.subarray(searchFrom, newlineIndex + 1);
        const byteOffset = consumedBytes;
        searchFrom = newlineIndex + 1;
        consumedBytes += lineBytes.length;

        if (footer !== null) {
          record({
            code: "RECORD_AFTER_FOOTER",
            message: "segment contains bytes after its footer record",
            lineIndex,
            byteOffset,
          });
          stopped = true;
          break;
        }

        const text = lineBytes.subarray(0, lineBytes.length - 1).toString("utf8");
        let classified;
        try {
          classified = classifySegmentLine(text, { path, lineIndex, byteOffset });
        } catch (error) {
          record({
            code: "RECORD_INVALID",
            message:
              error instanceof Error
                ? error.message
                : "segment line could not be classified",
            lineIndex,
            byteOffset,
            details:
              error instanceof WalSegmentIntegrityError ? error.details : { cause: String(error) },
          });
          stopped = true;
          break;
        }

        if (lineIndex === 0 && classified.kind !== "header") {
          record({
            code: "HEADER_MISSING",
            message: "segment does not begin with a header record",
            lineIndex,
            byteOffset,
          });
          stopped = true;
          break;
        }
        if (lineIndex > 0 && classified.kind === "header") {
          record({
            code: "RECORD_INVALID",
            message: "segment contains a header record after the first line",
            lineIndex,
            byteOffset,
          });
          stopped = true;
          break;
        }

        if (classified.kind === "header") {
          header = classified.header;
          hash.update(lineBytes);
          checksummedByteLength += lineBytes.length;
          if (
            options.expectedSegmentId !== undefined &&
            classified.header.segmentId !== options.expectedSegmentId
          ) {
            record({
              code: "SEGMENT_ID_MISMATCH",
              message: "segment header declares a different segment id",
              lineIndex,
              byteOffset,
              details: {
                declared: classified.header.segmentId,
                expected: options.expectedSegmentId,
              },
            });
            stopped = true;
            break;
          }
          if (
            options.expectedGatewayEpoch !== undefined &&
            classified.header.gatewayEpoch !== options.expectedGatewayEpoch
          ) {
            record({
              code: "GATEWAY_EPOCH_MISMATCH",
              message: "segment header declares a different gateway epoch",
              lineIndex,
              byteOffset,
              details: {
                declared: classified.header.gatewayEpoch,
                expected: options.expectedGatewayEpoch,
              },
            });
            stopped = true;
            break;
          }
        } else if (classified.kind === "footer") {
          footer = classified.footer;
        } else {
          hash.update(lineBytes);
          checksummedByteLength += lineBytes.length;
          const frame = classified.record;
          if (firstIngestSeq === null) {
            firstIngestSeq = frame.ingestSeq;
            firstReceivedAt = frame.receivedAt;
          }
          if (lastIngestSeq !== null && compareIngestSeq(frame.ingestSeq, lastIngestSeq) <= 0) {
            nonMonotonicIngestSeqCount += 1;
          }
          lastIngestSeq = frame.ingestSeq;
          lastReceivedAt = frame.receivedAt;
          recordCount += 1;
          yield {
            index: recordCount - 1,
            byteOffset,
            byteLength: lineBytes.length,
            record: frame,
          };
        }
        lineIndex += 1;
      }

      pending = pending.subarray(searchFrom);
      if (!stopped && pending.length > maxRecordBytes) {
        record({
          code: "RECORD_TOO_LARGE",
          message: `segment contains a line longer than the ${maxRecordBytes}-byte limit`,
          lineIndex,
          byteOffset: consumedBytes,
        });
        stopped = true;
      }
    }

    if (!stopped && pending.length > 0) {
      incompleteFinalRecord = {
        byteOffset: consumedBytes,
        byteLength: pending.length,
        preview: pending.subarray(0, PREVIEW_LIMIT).toString("utf8"),
      };
      const issue: SegmentIssue = {
        code: "INCOMPLETE_FINAL_RECORD",
        message: "segment ends with an incomplete final record",
        lineIndex,
        byteOffset: consumedBytes,
        details: { byteLength: pending.length },
      };
      issues.push(issue);
      if (footer !== null) {
        record({
          code: "RECORD_AFTER_FOOTER",
          message: "segment contains trailing bytes after its footer record",
          lineIndex,
          byteOffset: consumedBytes,
        });
      }
    }

    if (!stopped && header === null && byteSize > 0 && incompleteFinalRecord === null) {
      record({
        code: "HEADER_MISSING",
        message: "segment contains no header record",
        lineIndex: 0,
        byteOffset: 0,
      });
    }

    if (!stopped && footer !== null) {
      if (footer.recordCount !== recordCount) {
        record({
          code: "RECORD_COUNT_MISMATCH",
          message: "segment footer record count does not match the records on disk",
          details: { declared: footer.recordCount, counted: recordCount },
        });
      }
      if (footer.checksummedByteLength !== checksummedByteLength) {
        record({
          code: "CHECKSUM_LENGTH_MISMATCH",
          message: "segment footer checksummed byte length does not match the bytes on disk",
          details: {
            declared: footer.checksummedByteLength,
            counted: checksummedByteLength,
          },
        });
      }
    }
  } finally {
    await handle.close();
  }

  const report = buildReport();
  if (report.footer !== null && !stopped && report.footer.segmentSha256 !== report.computedSha256) {
    const issue: SegmentIssue = {
      code: "CHECKSUM_MISMATCH",
      message: "segment footer checksum does not match the bytes on disk",
      details: { declared: report.footer.segmentSha256, computed: report.computedSha256 },
    };
    issues.push(issue);
    if (onIssue === "throw") {
      throw issueError(issue, path);
    }
  }
  return report;
}

/** Scan a segment without materializing its records. */
export async function scanSegment(
  fileSystem: WalFileSystem,
  path: string,
  options: SegmentScanOptions = {},
): Promise<SegmentScanReport> {
  const iterator = iterateSegmentRecords(fileSystem, path, options);
  for (;;) {
    const step = await iterator.next();
    if (step.done === true) {
      return step.value;
    }
  }
}

export type SegmentReadResult = {
  readonly records: readonly RawFrameRecord[];
  readonly report: SegmentScanReport;
};

/**
 * Read every frame record in a segment.
 *
 * Throws on any integrity defect. An incomplete final record is *not* a defect
 * here: it is returned in `report.incompleteFinalRecord` so the caller can
 * decide, which is what `allowIncompleteFinalRecord` controls.
 */
export async function readSegmentRecords(
  fileSystem: WalFileSystem,
  path: string,
  options: SegmentScanOptions & { readonly allowIncompleteFinalRecord?: boolean } = {},
): Promise<SegmentReadResult> {
  const allowIncomplete = options.allowIncompleteFinalRecord ?? true;
  const records: RawFrameRecord[] = [];
  const iterator = iterateSegmentRecords(fileSystem, path, { ...options, onIssue: "collect" });
  let report: SegmentScanReport;
  for (;;) {
    const step = await iterator.next();
    if (step.done === true) {
      report = step.value;
      break;
    }
    records.push(step.value.record);
  }
  for (const issue of report.issues) {
    if (issue.code === "INCOMPLETE_FINAL_RECORD" && allowIncomplete) {
      continue;
    }
    throw issueError(issue, path);
  }
  return { records, report };
}

/** Verdict for one segment, cross-checked against its footer and manifest. */
export type SegmentValidationReport = {
  readonly segmentId: string;
  readonly path: string;
  /**
   * `true` only when the segment is complete and verified: a header, no
   * defects, no incomplete final record, and a footer or manifest whose record
   * count and SHA-256 both match the bytes on disk.
   */
  readonly valid: boolean;
  readonly scan: SegmentScanReport;
  readonly manifest: WalSegmentManifest | null;
  readonly issues: readonly SegmentIssue[];
};

/**
 * Cross-check every field two artifacts both carry.
 *
 * A checksum proves the *frame bytes* were not altered. It proves nothing about
 * the metadata around them: an edited `gatewayEpoch` or `firstIngestSeq` changes
 * which range a compactor believes it holds while every digest still matches.
 * So each pair of values that must agree is compared by name, and a
 * disagreement is an issue with both sides in its details.
 */
function compareFields(
  issues: SegmentIssue[],
  code: SegmentIssueCode,
  subject: string,
  pairs: readonly (readonly [field: string, declared: unknown, actual: unknown])[],
): void {
  for (const [field, declared, actual] of pairs) {
    if (declared !== actual) {
      issues.push({
        code,
        message: `manifest ${field} does not match ${subject}`,
        details: { field, manifest: declared, [subject]: actual },
      });
    }
  }
}

/**
 * Validate one segment by record count and SHA-256 (`WP-050` acceptance 2).
 *
 * Also cross-checks every field the manifest shares with the segment header, the
 * footer, or the records themselves — see {@link compareFields} for why a
 * checksum alone is not enough — and checks the manifest against itself.
 *
 * Never throws for a defective segment: it reports. A caller that wants an
 * exception uses {@link readSegmentRecords}.
 */
export async function validateSegment(
  fileSystem: WalFileSystem,
  directoryPath: string,
  segmentId: string,
  options: Pick<SegmentScanOptions, "chunkBytes" | "maxRecordBytes"> = {},
): Promise<SegmentValidationReport> {
  const path = fileSystem.joinPath(directoryPath, segmentFileName(segmentId));
  const scan = await scanSegment(fileSystem, path, {
    ...options,
    onIssue: "collect",
    expectedSegmentId: segmentId,
  });
  const issues: SegmentIssue[] = [...scan.issues];
  let manifest: WalSegmentManifest | null = null;
  try {
    manifest = await readSegmentManifest(fileSystem, directoryPath, segmentId);
  } catch (error) {
    issues.push({
      code: "MANIFEST_MISSING",
      message: error instanceof Error ? error.message : "manifest could not be read",
    });
  }

  if (manifest === null) {
    issues.push({
      code: "MANIFEST_MISSING",
      message: "segment has no sidecar manifest and is therefore unverified",
    });
  } else {
    if (manifest.recordCount !== scan.recordCount) {
      issues.push({
        code: "RECORD_COUNT_MISMATCH",
        message: "manifest record count does not match the records on disk",
        details: { declared: manifest.recordCount, counted: scan.recordCount },
      });
    }
    if (manifest.checksummedByteLength !== scan.checksummedByteLength) {
      issues.push({
        code: "CHECKSUM_LENGTH_MISMATCH",
        message: "manifest checksummed byte length does not match the bytes on disk",
        details: {
          declared: manifest.checksummedByteLength,
          counted: scan.checksummedByteLength,
        },
      });
    }
    if (manifest.segmentSha256 !== scan.computedSha256) {
      issues.push({
        code: "CHECKSUM_MISMATCH",
        message: "manifest checksum does not match the bytes on disk",
        details: { declared: manifest.segmentSha256, computed: scan.computedSha256 },
      });
    }
    if (manifest.byteSize !== scan.byteSize) {
      issues.push({
        code: "BYTE_SIZE_MISMATCH",
        message: "manifest byte size does not match the file",
        details: { declared: manifest.byteSize, actual: scan.byteSize },
      });
    }
    if (scan.footer !== null && scan.footer.segmentSha256 !== manifest.segmentSha256) {
      issues.push({
        code: "FOOTER_MANIFEST_DISAGREE",
        message: "segment footer and sidecar manifest declare different checksums",
        details: { footer: scan.footer.segmentSha256, manifest: manifest.segmentSha256 },
      });
    }
    if (scan.footer !== null && scan.footer.recordCount !== manifest.recordCount) {
      issues.push({
        code: "FOOTER_MANIFEST_DISAGREE",
        message: "segment footer and sidecar manifest declare different record counts",
        details: { footer: scan.footer.recordCount, manifest: manifest.recordCount },
      });
    }

    // The manifest against the segment's own header: identity and provenance.
    if (scan.header !== null) {
      compareFields(issues, "MANIFEST_HEADER_DISAGREE", "header", [
        ["formatId", manifest.formatId, scan.header.formatId],
        ["walSchemaVersion", manifest.walSchemaVersion, scan.header.walSchemaVersion],
        ["segmentId", manifest.segmentId, scan.header.segmentId],
        ["gatewayEpoch", manifest.gatewayEpoch, scan.header.gatewayEpoch],
        ["segmentIndex", manifest.segmentIndex, scan.header.segmentIndex],
        ["createdAt", manifest.createdAt, scan.header.createdAt],
      ]);
    }

    // The manifest against the footer: every field they both carry, not only
    // the two the earlier checks covered.
    if (scan.footer !== null) {
      compareFields(issues, "FOOTER_MANIFEST_DISAGREE", "footer", [
        ["formatId", manifest.formatId, scan.footer.formatId],
        ["walSchemaVersion", manifest.walSchemaVersion, scan.footer.walSchemaVersion],
        ["segmentId", manifest.segmentId, scan.footer.segmentId],
        ["gatewayEpoch", manifest.gatewayEpoch, scan.footer.gatewayEpoch],
        [
          "checksummedByteLength",
          manifest.checksummedByteLength,
          scan.footer.checksummedByteLength,
        ],
        ["closedAt", manifest.closedAt, scan.footer.closedAt],
        ["closeReason", manifest.closeReason, scan.footer.closeReason],
      ]);
    }

    // The manifest against the records themselves. Skipped when the scan
    // stopped on corruption, because then it describes a prefix and every
    // comparison would fire for the same underlying defect.
    const scanIsComplete = scan.issues.every(
      (issue) => issue.code === "INCOMPLETE_FINAL_RECORD",
    );
    if (scanIsComplete) {
      compareFields(issues, "MANIFEST_CONTENT_DISAGREE", "records", [
        ["firstIngestSeq", manifest.firstIngestSeq, scan.firstIngestSeq],
        ["lastIngestSeq", manifest.lastIngestSeq, scan.lastIngestSeq],
        ["firstReceivedAt", manifest.firstReceivedAt, scan.firstReceivedAt],
        ["lastReceivedAt", manifest.lastReceivedAt, scan.lastReceivedAt],
        ["footerPresent", manifest.footerPresent, scan.footer !== null],
      ]);
    }

    // The manifest against itself: combinations no writer or recovery pass can
    // produce, and which therefore mean the document was edited.
    const expectedFileName = segmentFileName(manifest.segmentId);
    if (manifest.segmentFileName !== expectedFileName) {
      issues.push({
        code: "MANIFEST_INCONSISTENT",
        message: "manifest segmentFileName does not follow from its segmentId",
        details: { declared: manifest.segmentFileName, expected: expectedFileName },
      });
    }
    if (manifest.footerPresent && manifest.truncatedTailBytes !== 0) {
      issues.push({
        code: "MANIFEST_INCONSISTENT",
        message: "a segment with a footer cannot also have had a tail truncated",
        details: { truncatedTailBytes: manifest.truncatedTailBytes },
      });
    }
    if (
      manifest.truncatedTailBytes > 0 &&
      manifest.closeReason !== "recovery" &&
      manifest.closeReason !== "write-fault"
    ) {
      issues.push({
        code: "MANIFEST_INCONSISTENT",
        message: "only recovery or a write fault truncates a tail",
        details: {
          truncatedTailBytes: manifest.truncatedTailBytes,
          closeReason: manifest.closeReason,
        },
      });
    }
    if (manifest.checksummedByteLength > manifest.byteSize) {
      issues.push({
        code: "MANIFEST_INCONSISTENT",
        message: "manifest checksummed byte length exceeds its declared file size",
        details: {
          checksummedByteLength: manifest.checksummedByteLength,
          byteSize: manifest.byteSize,
        },
      });
    }
    const emptyRange =
      manifest.firstIngestSeq === null &&
      manifest.lastIngestSeq === null &&
      manifest.firstReceivedAt === null &&
      manifest.lastReceivedAt === null;
    if ((manifest.recordCount === 0) !== emptyRange) {
      issues.push({
        code: "MANIFEST_INCONSISTENT",
        message: "manifest record count and record range disagree about emptiness",
        details: {
          recordCount: manifest.recordCount,
          firstIngestSeq: manifest.firstIngestSeq,
          lastIngestSeq: manifest.lastIngestSeq,
        },
      });
    }
    // Only for a manifest that *records* default-factory provenance. The id of
    // a segment written by an injected factory is opaque — identity is what the
    // header says, never what the name implies (`wal-format.md` §2) — and
    // round-3 review found the previous shape-based inference rejecting a
    // perfectly good `<epoch>-999999` at `segmentIndex` 0. Absent provenance
    // means "written before this field existed": skipped, because
    // `MANIFEST_HEADER_DISAGREE` already compares `segmentIndex` against the
    // checksummed header and a false positive here costs more than the overlap.
    if (manifest.segmentIdKind === "default") {
      const expectedId = defaultSegmentIdFactory({
        gatewayEpoch: manifest.gatewayEpoch,
        segmentIndex: manifest.segmentIndex,
        createdAtMs: 0,
      });
      if (manifest.segmentId !== expectedId) {
        issues.push({
          code: "MANIFEST_INCONSISTENT",
          message:
            "manifest claims a default-factory segment id that does not follow from its segmentIndex",
          details: {
            segmentId: manifest.segmentId,
            segmentIndex: manifest.segmentIndex,
            expected: expectedId,
          },
        });
      }
    }
  }

  return {
    segmentId,
    path,
    valid: issues.length === 0 && scan.header !== null,
    scan,
    manifest,
    issues,
  };
}

/** Validate every segment in a WAL directory, in file-name order. */
export async function validateWalDirectory(
  fileSystem: WalFileSystem,
  directoryPath: string,
  options: Pick<SegmentScanOptions, "chunkBytes" | "maxRecordBytes"> = {},
): Promise<readonly SegmentValidationReport[]> {
  const fileNames = await fileSystem.listFileNames(directoryPath);
  const reports: SegmentValidationReport[] = [];
  for (const fileName of [...fileNames].sort()) {
    if (!isSegmentFileName(fileName)) {
      continue;
    }
    const segmentId = segmentIdFromFileName(fileName);
    if (segmentId === null) {
      continue;
    }
    reports.push(await validateSegment(fileSystem, directoryPath, segmentId, options));
  }
  return reports;
}
