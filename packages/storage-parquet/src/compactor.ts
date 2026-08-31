/**
 * The compactor.
 *
 * ## The order of operations, and why it is the order
 *
 * ADR-004 §5 states one rule that shapes everything below: "Compaction never
 * deletes a WAL segment until Parquet upload **and** checksum verification both
 * succeed." Handoff §9.1 states it identically. The consequence is that
 * deletion is the *last* thing that can possibly happen, and every step before
 * it is a precondition someone can check:
 *
 * 1. **Enumerate manifests, not segments.** `wal-format.md` §2: a segment with
 *    no sidecar manifest is unverified and "a compactor must not consume it".
 *    Listing manifests rather than `.wal.jsonl` files makes that structural
 *    instead of a filter someone can forget.
 * 2. **Verify each segment against its own bytes.** Checksum, record count,
 *    byte size, and every field the manifest shares with the header, the
 *    footer, and the records (§6.3). A refusal excludes the segment and is
 *    pinned in the dataset manifest with its issue codes.
 * 3. **Order records by dispatch order** — segment ordinal, then position in
 *    the file — and assign a dense `datasetRowOrdinal`. §8.4: replay consumes
 *    recorded dispatch order and "must not sort solely by venue timestamp".
 * 4. **Mark, never drop.** Incident-window records and duplicate copies are
 *    written with `replayEligible = false`. See `incidents.ts` for why: after
 *    step 8 the dataset may be the only copy.
 * 5. **Encode Parquet, one object per segment**, and check each row reproduces
 *    the exact WAL line it came from before the bytes leave the process.
 * 6. **Upload, then read back.** The digest that goes into the manifest is the
 *    one computed from the bytes the store returned, not from the bytes this
 *    process holds. A store that accepted a write and serves something else
 *    fails the run here, before any retention decision.
 * 7. **Write the dataset manifest**, and verify it the same way.
 * 8. **Only now, retention.** And only for segments whose every record is in a
 *    verified object that the written manifest pins.
 *
 * A failure at any step leaves the WAL untouched. "The delete-after-verify rule
 * means a broken upload path fills the disk instead of losing data. That is the
 * intended failure direction" (ADR-004, Consequences).
 */

import {
  DATASET_MANIFEST_DIGEST_OBJECT_NAME,
  DATASET_MANIFEST_OBJECT_NAME,
  DEFAULT_MAX_LISTED_DUPLICATE_KEYS,
  DEFAULT_MAX_RECORD_BYTES,
  DEFAULT_MAX_SEGMENT_BYTES,
  DEFAULT_ROW_GROUP_SIZE,
  PARQUET_OBJECT_SUFFIX,
} from "./constants.js";
import type {
  DatasetManifest,
  DatasetObjectEntry,
  DatasetSegmentEntry,
  EventIdentity,
  ExcludedIncidentWindowEntry,
  ExcludedSegmentEntry,
  ReplayPins,
} from "./dataset-manifest.js";
import {
  currentColumnPins,
  currentSchemaVersions,
  datasetManifestDigest,
  emptyReplayPins,
  encodeDatasetManifest,
} from "./dataset-manifest.js";
import {
  CompactionConfigurationError,
  DuplicateDivergenceError,
  ObjectVerificationError,
} from "./errors.js";
import type { IncidentWindow } from "./incidents.js";
import { findContainingWindow, validateIncidentWindows } from "./incidents.js";
import type { DatasetRow } from "./parquet-layout.js";
import { datasetRowFromWalRecord, rowReproducesItsSourceLine } from "./parquet-layout.js";
import type { DatasetCodec } from "./parquet-object.js";
import { readParquetObject, writeParquetObject } from "./parquet-object.js";
import type {
  CompactionClock,
  CompactionFileSystem,
  CompactionObserver,
  ObjectStore,
  WalSegmentRetention,
} from "./ports.js";
import { retainAllWalSegments } from "./ports.js";
import type {
  RawFrameRecord,
  WalSegmentIssue,
  WalSegmentReadResult,
} from "./wal-format.js";
import {
  readWalSegment,
  segmentIdFromManifestFileName,
  sha256Hex,
  walManifestFileName,
  walSegmentFileName,
} from "./wal-format.js";

/** Version of the Parquet writer this build pins, recorded in every manifest. */
export const PARQUET_WRITER_LIBRARY = "hyparquet-writer";
export const PARQUET_WRITER_LIBRARY_VERSION = "0.16.6";

export type CompactionOptions = {
  /** Directory holding `<segmentId>.wal.jsonl` and its sidecar manifests. */
  readonly walDirectoryPath: string;
  /**
   * Identity of the dataset being produced.
   *
   * Supplied by the caller rather than generated, because a dataset id is
   * pinned by replay runs (§12.5) and a value derived from a clock would make
   * a re-run of the same compaction produce a second, indistinguishable
   * dataset.
   */
  readonly datasetId: string;
  /** Object-key prefix. Objects land at `<prefix>/<segmentId>.parquet`. */
  readonly objectKeyPrefix: string;
  readonly objectStore: ObjectStore;
  readonly fileSystem: CompactionFileSystem;
  readonly clock: CompactionClock;
  readonly retention?: WalSegmentRetention;
  readonly observer?: CompactionObserver;
  /** Windows whose records are marked ineligible for replay (§8.4, §12.5). */
  readonly incidentWindows?: readonly IncidentWindow[];
  /** §12.5 pins the caller knows. Everything unsupplied stays explicitly null. */
  readonly replayPins?: Partial<ReplayPins>;
  readonly codec?: DatasetCodec;
  readonly rowGroupSize?: number;
  readonly maxSegmentBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxListedDuplicateKeys?: number;
  /**
   * Segments to consider. Defaults to every segment with a sidecar manifest.
   *
   * A caller that compacts incrementally passes the segments it has not
   * compacted yet; the compactor does not track state of its own, because
   * "which segments are already compacted" is a fact about the object store and
   * the `data.raw_segments` table (§10.2), not about this process's memory.
   */
  readonly segmentIds?: readonly string[];
};

/** What one compaction run did. */
export type CompactionResult = {
  readonly datasetId: string;
  readonly manifest: DatasetManifest;
  readonly manifestObjectKey: string;
  readonly manifestSha256: string;
  readonly verifiedSegmentIds: readonly string[];
  readonly refusedSegments: readonly ExcludedSegmentEntry[];
  readonly deletedSegmentIds: readonly string[];
  readonly retentionFailures: readonly { segmentId: string; detail: string }[];
  readonly rowsWritten: number;
  readonly replayEligibleRows: number;
  readonly objectBytesUploaded: number;
  readonly durationMs: number;
  /**
   * Age of the oldest segment this run left uncompacted, in milliseconds.
   *
   * `null` when nothing was left behind. This is §14.3's "compaction lag" as a
   * number the caller can publish; it is computed from segment `closedAt`
   * timestamps against the injected clock, so it is testable.
   */
  readonly compactionLagMs: number | null;
};

function sortSegments(results: readonly Extract<WalSegmentReadResult, { status: "verified" }>[]): readonly Extract<
  WalSegmentReadResult,
  { status: "verified" }
>[] {
  // Dispatch order across segments: gateway epoch, then the per-directory
  // ordinal the header records, then the id as a last, total tiebreak. Epoch
  // first because a restart begins a new epoch and its ordinals restart from
  // zero (`wal-format.md` §2), so ordinal alone is not a total order.
  return [...results].sort((left, right) => {
    if (left.manifest.gatewayEpoch !== right.manifest.gatewayEpoch) {
      return left.manifest.gatewayEpoch < right.manifest.gatewayEpoch ? -1 : 1;
    }
    if (left.manifest.segmentIndex !== right.manifest.segmentIndex) {
      return left.manifest.segmentIndex - right.manifest.segmentIndex;
    }
    return left.segmentId < right.segmentId ? -1 : left.segmentId > right.segmentId ? 1 : 0;
  });
}

function duplicateKey(record: RawFrameRecord): string {
  // The key is `(gatewayEpoch, ingestSeq)`; the separator is a unit separator
  // so an epoch containing the separator cannot forge a collision.
  return `${record.gatewayEpoch}${record.ingestSeq}`;
}

/**
 * Compact every verified segment in a WAL directory into a dataset.
 *
 * Throws only on a failure of the run itself (see `errors.ts`); a bad segment
 * is data, and comes back in {@link CompactionResult.refusedSegments}.
 */
export async function compactWalDirectory(
  options: CompactionOptions,
): Promise<CompactionResult> {
  const startedAtMonotonicMs = options.clock.monotonicMs();
  const retention = options.retention ?? retainAllWalSegments();
  const incidentWindows = options.incidentWindows ?? [];
  const maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const maxListedDuplicateKeys =
    options.maxListedDuplicateKeys ?? DEFAULT_MAX_LISTED_DUPLICATE_KEYS;
  const codec: DatasetCodec = options.codec ?? "UNCOMPRESSED";
  const rowGroupSize = options.rowGroupSize ?? DEFAULT_ROW_GROUP_SIZE;

  if (options.datasetId.length === 0) {
    throw new CompactionConfigurationError("datasetId must not be empty");
  }
  if (options.objectKeyPrefix.length === 0) {
    throw new CompactionConfigurationError("objectKeyPrefix must not be empty");
  }
  const windowProblems = validateIncidentWindows(incidentWindows);
  if (windowProblems.length > 0) {
    throw new CompactionConfigurationError("incident windows are malformed", {
      problems: windowProblems,
    });
  }

  const objectKeyFor = (name: string): string => `${options.objectKeyPrefix}/${name}`;

  // ---- 1. Enumerate the segments that carry a sidecar manifest. ----------
  const candidateSegmentIds =
    options.segmentIds ?? (await listManifestedSegmentIds(options.fileSystem, options.walDirectoryPath));

  // ---- 2. Read and verify each one. -------------------------------------
  const verified: Extract<WalSegmentReadResult, { status: "verified" }>[] = [];
  const refused: ExcludedSegmentEntry[] = [];
  const refusedClosedAt: (string | null)[] = [];

  for (const segmentId of candidateSegmentIds) {
    const result = await readWalSegment(
      walBytesSource(options.fileSystem, options.walDirectoryPath),
      segmentId,
      { maxSegmentBytes, maxRecordBytes },
    );
    if (result.status === "verified") {
      verified.push(result);
      options.observer?.onSegmentVerified?.({
        segmentId,
        gatewayEpoch: result.manifest.gatewayEpoch,
        recordCount: result.records.length,
        segmentSha256: result.manifest.segmentSha256,
      });
    } else {
      const entry: ExcludedSegmentEntry = {
        segmentId,
        gatewayEpoch: result.manifest?.gatewayEpoch ?? null,
        issues: result.issues,
      };
      refused.push(entry);
      refusedClosedAt.push(result.manifest?.closedAt ?? null);
      options.observer?.onSegmentRefused?.({
        segmentId,
        issueCodes: result.issues.map((issue) => issue.code),
        detail: describeIssues(result.issues),
      });
    }
  }

  const ordered = sortSegments(verified);

  // ---- 3./4. Assign dispatch ordinals; mark exclusions. ------------------
  const rowsBySegment = new Map<string, DatasetRow[]>();
  const seenKeys = new Map<string, { ordinal: number; lineSha256: string }>();
  const incidentCounts = new Map<string, { count: number; segmentIds: Set<string> }>();
  const duplicateKeys: string[] = [];
  let duplicateRecordCount = 0;
  let excludedByIncident = 0;
  let ordinal = 0;
  let segmentDeclared = 0;
  let segmentRead = 0;

  for (const segment of ordered) {
    segmentDeclared += segment.manifest.recordCount;
    segmentRead += segment.records.length;
    const rows: DatasetRow[] = [];
    for (const entry of segment.records) {
      const record = entry.record;
      const window = findContainingWindow(incidentWindows, record);
      const key = duplicateKey(record);
      const previous = seenKeys.get(key);

      let replayEligible = true;
      let exclusionReason: string | null = null;

      if (previous !== undefined) {
        // `wal-format.md` §12: duplicates are the normal outcome at a fault
        // boundary, and the consumer's job is to reconcile on
        // `(gatewayEpoch, ingestSeq)`. That is safe only because a duplicate is
        // a re-recording of the *same* frame — so two records under one key
        // whose bytes differ mean the sequence assignment is broken, and
        // picking a winner would be arbitrary.
        if (previous.lineSha256 !== entry.lineSha256) {
          throw new DuplicateDivergenceError(
            "two records share (gatewayEpoch, ingestSeq) but are not byte-identical",
            {
              gatewayEpoch: record.gatewayEpoch,
              ingestSeq: record.ingestSeq,
              firstDatasetRowOrdinal: previous.ordinal,
              firstLineSha256: previous.lineSha256,
              secondLineSha256: entry.lineSha256,
              segmentId: segment.segmentId,
            },
          );
        }
        replayEligible = false;
        exclusionReason = `duplicate:${previous.ordinal}`;
        duplicateRecordCount += 1;
        if (duplicateKeys.length < maxListedDuplicateKeys) {
          duplicateKeys.push(`${record.gatewayEpoch}/${record.ingestSeq}`);
        }
      } else if (window !== null) {
        replayEligible = false;
        exclusionReason = `incident:${window.incidentId}`;
        excludedByIncident += 1;
        const bucket = incidentCounts.get(window.incidentId) ?? {
          count: 0,
          segmentIds: new Set<string>(),
        };
        bucket.count += 1;
        bucket.segmentIds.add(segment.segmentId);
        incidentCounts.set(window.incidentId, bucket);
      }

      if (previous === undefined) {
        seenKeys.set(key, { ordinal, lineSha256: entry.lineSha256 });
      }

      const row = datasetRowFromWalRecord({
        datasetRowOrdinal: ordinal,
        segmentId: segment.segmentId,
        segmentIndex: segment.manifest.segmentIndex,
        entry,
        replayEligible,
        exclusionReason,
      });
      // ---- 5. Byte-exactness, checked before the bytes leave the process.
      if (!rowReproducesItsSourceLine(row)) {
        throw new ObjectVerificationError(
          "a dataset row does not reproduce the WAL line it was read from",
          {
            segmentId: segment.segmentId,
            segmentRecordIndex: entry.recordIndex,
            frameLineSha256: entry.lineSha256,
          },
        );
      }
      rows.push(row);
      ordinal += 1;
    }
    rowsBySegment.set(segment.segmentId, rows);
  }

  // ---- 5./6. Encode, upload, and read back every object. -----------------
  const objects: DatasetObjectEntry[] = [];
  const segmentEntries: DatasetSegmentEntry[] = [];
  const verifiedObjectBySegment = new Map<string, { key: string; sha256: string }>();
  let objectBytesUploaded = 0;
  let replayEligibleTotal = 0;

  for (const segment of ordered) {
    const rows = rowsBySegment.get(segment.segmentId) ?? [];
    const objectKey = objectKeyFor(`${segment.segmentId}${PARQUET_OBJECT_SUFFIX}`);
    const encoded = writeParquetObject({
      rows,
      codec,
      rowGroupSize,
      keyValueMetadata: {
        "polymarket-bot.datasetId": options.datasetId,
        "polymarket-bot.parquetLayoutId": currentSchemaVersions().parquetLayoutId,
        "polymarket-bot.segmentId": segment.segmentId,
        "polymarket-bot.segmentSha256": segment.manifest.segmentSha256,
        "polymarket-bot.walFormatId": currentSchemaVersions().walFormatId,
      },
    });

    await options.objectStore.put(objectKey, encoded.bytes);
    options.observer?.onObjectUploaded?.({
      objectKey,
      byteLength: encoded.bytes.byteLength,
      sha256: encoded.sha256,
    });

    const verification = await verifyUploadedObject({
      objectStore: options.objectStore,
      objectKey,
      expectedSha256: encoded.sha256,
      expectedByteLength: encoded.bytes.byteLength,
      expectedRows: rows,
    });

    options.observer?.onObjectVerified?.({
      objectKey,
      byteLength: verification.byteLength,
      sha256: verification.sha256,
      rowCount: verification.rowCount,
    });

    objectBytesUploaded += verification.byteLength;
    const replayEligibleRowCount = rows.filter((row) => row.replayEligible).length;
    replayEligibleTotal += replayEligibleRowCount;
    const first = rows[0] ?? null;
    const last = rows[rows.length - 1] ?? null;

    objects.push({
      objectKey,
      byteLength: verification.byteLength,
      sha256: verification.sha256,
      rowCount: verification.rowCount,
      replayEligibleRowCount,
      firstDatasetRowOrdinal: first === null ? null : first.datasetRowOrdinal,
      lastDatasetRowOrdinal: last === null ? null : last.datasetRowOrdinal,
      segmentIds: [segment.segmentId],
    });
    verifiedObjectBySegment.set(segment.segmentId, {
      key: objectKey,
      sha256: verification.sha256,
    });
    segmentEntries.push({
      segmentId: segment.segmentId,
      gatewayEpoch: segment.manifest.gatewayEpoch,
      segmentIndex: segment.manifest.segmentIndex,
      segmentSha256: segment.manifest.segmentSha256,
      checksummedByteLength: segment.manifest.checksummedByteLength,
      byteSize: segment.manifest.byteSize,
      recordCount: segment.records.length,
      firstIngestSeq: segment.manifest.firstIngestSeq,
      lastIngestSeq: segment.manifest.lastIngestSeq,
      firstReceivedAt: segment.manifest.firstReceivedAt,
      lastReceivedAt: segment.manifest.lastReceivedAt,
      closeReason: segment.manifest.closeReason,
      footerPresent: segment.manifest.footerPresent,
      truncatedTailBytes: segment.manifest.truncatedTailBytes,
      objectKey,
      firstDatasetRowOrdinal: first === null ? null : first.datasetRowOrdinal,
      lastDatasetRowOrdinal: last === null ? null : last.datasetRowOrdinal,
      // Filled in below, after retention runs. Written here as `false` so the
      // field is never absent.
      walSegmentDeleted: false,
    });
  }

  // ---- 7. The dataset manifest. -----------------------------------------
  const allRows = ordered.flatMap((segment) => rowsBySegment.get(segment.segmentId) ?? []);
  const firstRow = allRows[0] ?? null;
  const lastRow = allRows[allRows.length - 1] ?? null;
  const eventIdentity = (row: DatasetRow | null): EventIdentity | null =>
    row === null
      ? null
      : {
          gatewayEpoch: row.record.gatewayEpoch,
          ingestSeq: row.record.ingestSeq,
          receivedAt: row.record.receivedAt,
          datasetRowOrdinal: row.datasetRowOrdinal,
        };

  const excludedIncidentWindows: ExcludedIncidentWindowEntry[] = incidentWindows.map((window) => {
    const bucket = incidentCounts.get(window.incidentId);
    return {
      window,
      excludedRecordCount: bucket?.count ?? 0,
      excludedSegmentIds: [...(bucket?.segmentIds ?? [])].sort(),
    };
  });

  const gatewayEpochs = [
    ...new Set(ordered.map((segment) => segment.manifest.gatewayEpoch)),
  ].sort();

  const buildManifest = (deletedSegmentIds: ReadonlySet<string>): DatasetManifest => ({
    datasetManifestFormatId: currentSchemaVersions().datasetManifestFormatId,
    datasetManifestVersion: currentSchemaVersions().datasetManifestVersion,
    datasetId: options.datasetId,
    createdAt: new Date(options.clock.nowMs()).toISOString(),
    schemaVersions: currentSchemaVersions(),
    writer: {
      library: PARQUET_WRITER_LIBRARY,
      libraryVersion: PARQUET_WRITER_LIBRARY_VERSION,
      codec,
      rowGroupSize,
    },
    columns: currentColumnPins(),
    replayPins: emptyReplayPins(options.replayPins ?? {}),
    gatewayEpochs,
    eventRange: { first: eventIdentity(firstRow), last: eventIdentity(lastRow) },
    recordCounts: {
      segmentDeclared,
      segmentRead,
      written: allRows.length,
      replayEligible: replayEligibleTotal,
      excludedByIncident,
      excludedAsDuplicate: duplicateRecordCount,
    },
    deduplication: {
      policy: "first-wins-in-dispatch-order",
      duplicateRecordCount,
      duplicateKeys,
      duplicateKeysTruncated: duplicateRecordCount > duplicateKeys.length,
    },
    segments: segmentEntries.map((entry) => ({
      ...entry,
      walSegmentDeleted: deletedSegmentIds.has(entry.segmentId),
    })),
    objects,
    excludedSegments: refused,
    excludedIncidentWindows,
    walRetentionPolicy: retention.policyName,
  });

  // The manifest is written **before** any deletion, and it is written again
  // afterwards only if retention actually removed something — see below.
  const manifestObjectKey = objectKeyFor(DATASET_MANIFEST_OBJECT_NAME);
  const digestObjectKey = objectKeyFor(DATASET_MANIFEST_DIGEST_OBJECT_NAME);

  const preRetentionManifest = buildManifest(new Set());

  // ---- 8. Retention: the only step that removes anything. ---------------
  //
  // Ordering note: ADR-004 §5 requires upload + checksum verification before a
  // deletion. Both are complete above. The manifest is written *after* the
  // deletions so that `walSegmentDeleted` is a fact rather than an intention —
  // but the deletions are only permitted because the objects are already
  // verified, and a crash between a deletion and the manifest write loses no
  // data: the object holds every record, and re-running compaction over the
  // remaining segments produces the manifest again.
  const deletedSegmentIds: string[] = [];
  const retentionFailures: { segmentId: string; detail: string }[] = [];

  if (retention.policyName !== "retain") {
    for (const entry of segmentEntries) {
      const verifiedObject = verifiedObjectBySegment.get(entry.segmentId);
      /* c8 ignore next 3 -- unreachable: every entry in `segmentEntries` was
         created immediately after its object was verified. */
      if (verifiedObject === undefined) {
        continue;
      }
      try {
        await retention.deleteSegment({
          segmentId: entry.segmentId,
          gatewayEpoch: entry.gatewayEpoch,
          recordCount: entry.recordCount,
          segmentSha256: entry.segmentSha256,
          verifiedObjectKey: verifiedObject.key,
          verifiedObjectSha256: verifiedObject.sha256,
          datasetManifestKey: manifestObjectKey,
        });
        deletedSegmentIds.push(entry.segmentId);
        options.observer?.onSegmentDeleted?.({
          segmentId: entry.segmentId,
          verifiedObjectKey: verifiedObject.key,
        });
      } catch (error) {
        retentionFailures.push({
          segmentId: entry.segmentId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const manifest =
    deletedSegmentIds.length === 0 ? preRetentionManifest : buildManifest(new Set(deletedSegmentIds));
  const manifestBytes = encodeDatasetManifest(manifest);
  const manifestSha256 = datasetManifestDigest(manifest);

  await options.objectStore.put(manifestObjectKey, manifestBytes);
  const storedManifest = await options.objectStore.get(manifestObjectKey);
  const storedManifestSha256 = sha256Hex(storedManifest);
  if (storedManifestSha256 !== manifestSha256) {
    throw new ObjectVerificationError("dataset manifest read back with a different digest", {
      objectKey: manifestObjectKey,
      expected: manifestSha256,
      observed: storedManifestSha256,
    });
  }
  await options.objectStore.put(digestObjectKey, Buffer.from(`${manifestSha256}\n`, "utf8"));

  options.observer?.onDatasetManifestWritten?.({
    datasetId: options.datasetId,
    objectKey: manifestObjectKey,
    manifestSha256,
    rowCount: allRows.length,
  });

  return {
    datasetId: options.datasetId,
    manifest,
    manifestObjectKey,
    manifestSha256,
    verifiedSegmentIds: ordered.map((segment) => segment.segmentId),
    refusedSegments: refused,
    deletedSegmentIds,
    retentionFailures,
    rowsWritten: allRows.length,
    replayEligibleRows: replayEligibleTotal,
    objectBytesUploaded,
    durationMs: options.clock.monotonicMs() - startedAtMonotonicMs,
    compactionLagMs: computeCompactionLagMs(refusedClosedAt, options.clock.nowMs()),
  };
}

/**
 * §14.3 "compaction lag": how old the oldest segment this run did **not**
 * compact is.
 *
 * Only refused segments count, because they are the ones a run leaves behind.
 * A refusal whose sidecar manifest could not be read contributes nothing rather
 * than a guess — there is no timestamp to read, and inventing one would put a
 * fabricated number on a dashboard.
 */
function computeCompactionLagMs(
  refusedClosedAt: readonly (string | null)[],
  nowMs: number,
): number | null {
  let oldest: number | null = null;
  for (const closedAt of refusedClosedAt) {
    if (closedAt === null) {
      continue;
    }
    const parsed = Date.parse(closedAt);
    if (!Number.isNaN(parsed) && (oldest === null || parsed < oldest)) {
      oldest = parsed;
    }
  }
  return oldest === null ? null : Math.max(0, nowMs - oldest);
}

function describeIssues(issues: readonly WalSegmentIssue[]): string {
  return issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
}

function walBytesSource(fileSystem: CompactionFileSystem, walDirectoryPath: string) {
  return {
    async segmentByteLength(segmentId: string): Promise<number | null> {
      return await fileSystem.fileByteLength(
        fileSystem.joinPath(walDirectoryPath, walSegmentFileName(segmentId)),
      );
    },
    async readSegment(segmentId: string): Promise<Uint8Array> {
      return await fileSystem.readWholeFile(
        fileSystem.joinPath(walDirectoryPath, walSegmentFileName(segmentId)),
      );
    },
    async readManifest(segmentId: string): Promise<Uint8Array | null> {
      const path = fileSystem.joinPath(walDirectoryPath, walManifestFileName(segmentId));
      const byteLength = await fileSystem.fileByteLength(path);
      if (byteLength === null) {
        return null;
      }
      return await fileSystem.readWholeFile(path);
    },
  };
}

/**
 * Segment ids that carry a sidecar manifest, sorted.
 *
 * Enumerating manifests rather than segment files is the mechanism behind
 * `wal-format.md` §2: an unmanifested segment is not offered to a compactor at
 * all, so a crash-abandoned or corrupt segment cannot reach a dataset even by
 * mistake.
 */
export async function listManifestedSegmentIds(
  fileSystem: CompactionFileSystem,
  walDirectoryPath: string,
): Promise<readonly string[]> {
  const fileNames = await fileSystem.listFileNames(walDirectoryPath);
  const segmentIds: string[] = [];
  for (const fileName of fileNames) {
    const segmentId = segmentIdFromManifestFileName(fileName);
    if (segmentId !== null) {
      segmentIds.push(segmentId);
    }
  }
  return segmentIds.sort();
}

/**
 * Read an object back from the store and reconcile it against what was written.
 *
 * This is the "checksum verification" half of ADR-004 §5, and it is deliberately
 * stronger than a digest comparison: the object is decoded and **every row** is
 * checked to still reproduce the WAL line it came from. A digest alone would
 * prove the store kept the bytes; it would not prove those bytes decode to the
 * records the manifest is about to claim.
 */
async function verifyUploadedObject(input: {
  readonly objectStore: ObjectStore;
  readonly objectKey: string;
  readonly expectedSha256: string;
  readonly expectedByteLength: number;
  readonly expectedRows: readonly DatasetRow[];
}): Promise<{ sha256: string; byteLength: number; rowCount: number }> {
  const head = await input.objectStore.head(input.objectKey);
  if (head === null) {
    throw new ObjectVerificationError("object is absent from the store after a successful put", {
      objectKey: input.objectKey,
    });
  }
  if (head.byteLength !== input.expectedByteLength) {
    throw new ObjectVerificationError("stored object length differs from what was written", {
      objectKey: input.objectKey,
      expected: input.expectedByteLength,
      observed: head.byteLength,
    });
  }

  const stored = await input.objectStore.get(input.objectKey);
  const sha256 = sha256Hex(stored);
  if (sha256 !== input.expectedSha256) {
    throw new ObjectVerificationError("stored object digest differs from what was written", {
      objectKey: input.objectKey,
      expected: input.expectedSha256,
      observed: sha256,
    });
  }

  const decoded = await readParquetObject(stored);
  if (decoded.length !== input.expectedRows.length) {
    throw new ObjectVerificationError("stored object row count differs from what was written", {
      objectKey: input.objectKey,
      expected: input.expectedRows.length,
      observed: decoded.length,
    });
  }
  for (let index = 0; index < decoded.length; index += 1) {
    const actual = decoded[index];
    const expected = input.expectedRows[index];
    /* c8 ignore next 3 -- unreachable: lengths were compared above. */
    if (actual === undefined || expected === undefined) {
      throw new ObjectVerificationError("row index out of range during verification", {
        objectKey: input.objectKey,
        index,
      });
    }
    if (
      actual.datasetRowOrdinal !== expected.datasetRowOrdinal ||
      actual.segmentId !== expected.segmentId ||
      actual.segmentRecordIndex !== expected.segmentRecordIndex ||
      actual.frameLineSha256 !== expected.frameLineSha256 ||
      actual.frameLineByteOffset !== expected.frameLineByteOffset ||
      actual.frameLineByteLength !== expected.frameLineByteLength ||
      actual.replayEligible !== expected.replayEligible ||
      actual.exclusionReason !== expected.exclusionReason
    ) {
      throw new ObjectVerificationError("stored row does not match the row that was written", {
        objectKey: input.objectKey,
        index,
      });
    }
    if (
      !rowReproducesItsSourceLine({
        ...expected,
        record: actual.record,
      })
    ) {
      throw new ObjectVerificationError(
        "a row read back from the store does not reproduce its WAL line",
        { objectKey: input.objectKey, index, frameLineSha256: expected.frameLineSha256 },
      );
    }
  }

  return { sha256, byteLength: head.byteLength, rowCount: decoded.length };
}

