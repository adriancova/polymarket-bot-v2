/**
 * The dataset manifest: what a dataset *is*, stated once and immutably.
 *
 * Handoff §8.4 fixes the minimum content — "all segment checksums, gateway
 * epochs, event ranges, and excluded data-quality windows" — and ADR-004 §5
 * adds the rule that matters more than the fields: "Replay consumes the
 * manifest, not a directory listing."
 *
 * ## The §12.5 pin list, and the honest half of it
 *
 * §12.5 lists what "every replay **run**" pins. Some of those facts are
 * properties of the *data* and are knowable here; the rest are properties of a
 * *run* and are not knowable by a compactor at all:
 *
 * | §12.5 pin | Where it comes from |
 * | --- | --- |
 * | raw segment IDs and checksums | this manifest, `segments[]` |
 * | excluded incident windows | this manifest, `excludedIncidentWindows[]` |
 * | start/end event identity | this manifest, `eventRange` |
 * | normalizer version | the gateway that produced the frames; **unknown here** |
 * | feature-set version | the feature engine; **unknown here** |
 * | run seed | chosen by the replay run |
 * | fill / latency model versions and parameters | chosen by the replay run |
 * | fee / reward snapshot versions | chosen by the replay run |
 * | settlement-spec versions | chosen by the replay run |
 *
 * The manifest therefore carries a `replayPins` section whose run-scoped
 * entries are **explicitly `null` with a stated owner**, rather than being
 * omitted or filled with a plausible-looking default. A `null` a reader can see
 * is a fact ("nobody pinned this yet"); a missing key is an ambiguity, and a
 * fabricated version string is a lie that would survive into a determinism
 * claim. A caller that *does* know a value — a gateway that records its
 * normalizer version alongside the WAL — supplies it and it is pinned.
 *
 * ## Canonical encoding
 *
 * The document is serialized with a fixed key order and two-space indentation,
 * so the same dataset produces the same bytes and therefore the same
 * `manifestSha256`. The digest is written to a sidecar object rather than into
 * the manifest, because a document cannot contain its own hash.
 *
 * ## Deletion state lives elsewhere
 *
 * The manifest carries **no** per-segment deletion flag. It is persisted and
 * read-back-verified *before* retention is allowed to delete anything (the
 * ADR-004 §5 ordering made mechanical), so at the moment it is written no
 * deletion has happened — and it is immutable, so no later deletion could be
 * recorded in it without changing pinned bytes. What retention actually
 * removed is stated afterwards in the separate retention receipt
 * ({@link ./retention-receipt.js}).
 */

import { encodePlainJson } from "@polymarket-bot/risk/plain-json";

import {
  DATASET_FIDELITIES,
  DATASET_MANIFEST_FORMAT_ID,
  DATASET_MANIFEST_VERSION,
  DATASET_MANIFEST_VERSION_1,
  PARQUET_LAYOUT_ID,
  READABLE_DATASET_MANIFEST_VERSIONS,
  PARQUET_LAYOUT_VERSION,
  SUPPORTED_WAL_MANIFEST_VERSION,
  SUPPORTED_WAL_SCHEMA_VERSION,
  WAL_FORMAT_ID,
} from "./constants.js";
import type { DatasetFidelity } from "./constants.js";
import { DatasetManifestError } from "./errors.js";
import type { IncidentWindow } from "./incidents.js";
import { DATASET_COLUMNS } from "./parquet-layout.js";
import type { DatasetCodec } from "./parquet-object.js";
import type { WalSegmentIssue } from "./wal-format.js";
import { sha256Hex } from "./wal-format.js";

/** Identity of one event, as §12.5's "start/end event identity". */
export type EventIdentity = {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly receivedAt: string;
  readonly datasetRowOrdinal: number;
};

/** One WAL segment pinned by the dataset. */
export type DatasetSegmentEntry = {
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  /** The WAL's own segment digest, re-verified against the bytes on disk. */
  readonly segmentSha256: string;
  readonly checksummedByteLength: number;
  readonly byteSize: number;
  /**
   * SHA-256 over the segment file's **entire** `byteSize` bytes, footer
   * included, computed at compaction time from the bytes that were verified
   * and archived.
   *
   * `segmentSha256` covers only the checksummed span (`wal-format.md` §7),
   * which necessarily excludes the footer line — so it cannot detect a
   * same-length mutation of the footer made after compaction. Retention
   * (`retention-proof.ts`) requires the file it is about to delete to hash to
   * this pin over its full length, closing that gap (round-2 review, L-2).
   */
  readonly segmentFileSha256: string;
  readonly recordCount: number;
  readonly firstIngestSeq: string | null;
  readonly lastIngestSeq: string | null;
  readonly firstReceivedAt: string | null;
  readonly lastReceivedAt: string | null;
  readonly closeReason: string;
  readonly footerPresent: boolean;
  /** Bytes WAL recovery removed as an incomplete final record (§10). */
  readonly truncatedTailBytes: number;
  /** The object holding this segment's records. */
  readonly objectKey: string;
  readonly firstDatasetRowOrdinal: number | null;
  readonly lastDatasetRowOrdinal: number | null;
};

/** One compacted object pinned by the dataset. */
export type DatasetObjectEntry = {
  readonly objectKey: string;
  readonly byteLength: number;
  /** SHA-256 of the object as **read back from the store**, not as written. */
  readonly sha256: string;
  readonly rowCount: number;
  readonly replayEligibleRowCount: number;
  readonly firstDatasetRowOrdinal: number | null;
  readonly lastDatasetRowOrdinal: number | null;
  readonly segmentIds: readonly string[];
};

/** A segment the compactor refused, and why. */
export type ExcludedSegmentEntry = {
  readonly segmentId: string;
  readonly gatewayEpoch: string | null;
  readonly issues: readonly WalSegmentIssue[];
};

/** An incident window and what it actually excluded in this dataset. */
export type ExcludedIncidentWindowEntry = {
  readonly window: IncidentWindow;
  readonly excludedRecordCount: number;
  readonly excludedSegmentIds: readonly string[];
};

/** Deduplication outcome for `(gatewayEpoch, ingestSeq)`. */
export type DeduplicationSummary = {
  /**
   * The policy, stated so a reader does not have to infer it.
   *
   * `first-wins-in-dispatch-order`: the earliest copy in dispatch order stays
   * replay-eligible; later byte-identical copies are marked as duplicates.
   */
  readonly policy: "first-wins-in-dispatch-order";
  readonly duplicateRecordCount: number;
  /** Bounded enumeration; `duplicateRecordCount` is always exact. */
  readonly duplicateKeys: readonly string[];
  readonly duplicateKeysTruncated: boolean;
};

/** Every count a reconciliation needs. */
export type DatasetRecordCounts = {
  /** Frame records the verified segments declared, summed. */
  readonly segmentDeclared: number;
  /** Frame records actually read from those segments. */
  readonly segmentRead: number;
  /** Rows written to Parquet. Equals `segmentRead`: nothing is dropped. */
  readonly written: number;
  /** Rows a replay will consume. */
  readonly replayEligible: number;
  /** Rows excluded because they fall inside an incident window. */
  readonly excludedByIncident: number;
  /** Rows excluded as later copies of a duplicated key. */
  readonly excludedAsDuplicate: number;
};

/** Run-scoped §12.5 pins, `null` when their owner has not run yet. */
export type ReplayPins = {
  readonly normalizerVersion: string | null;
  readonly featureSetVersion: string | null;
  readonly runSeed: string | null;
  readonly fillModelVersion: string | null;
  readonly latencyModelVersion: string | null;
  readonly feeSnapshotVersion: string | null;
  readonly rewardSnapshotVersion: string | null;
  readonly settlementSpecVersions: readonly string[];
  /** Why the nulls are nulls. Written into every manifest. */
  readonly note: string;
};

/** Schema versions the dataset pins (`WP-130` acceptance criterion 3). */
export type DatasetSchemaVersions = {
  readonly walFormatId: string;
  readonly walSchemaVersion: number;
  readonly walManifestVersion: number;
  readonly parquetLayoutId: string;
  readonly parquetLayoutVersion: number;
  readonly datasetManifestFormatId: string;
  readonly datasetManifestVersion: number;
};

/** How the objects were produced, so a byte difference has an explanation. */
export type DatasetWriterInfo = {
  readonly library: string;
  readonly libraryVersion: string;
  readonly codec: DatasetCodec;
  readonly rowGroupSize: number;
};

/** One column of the pinned layout. */
export type DatasetColumnPin = {
  readonly name: string;
  readonly physicalType: string;
  readonly nullable: boolean;
};

/**
 * The immutable description of one compacted (exact) dataset.
 *
 * `fidelity` is always `exact` here. A version 2 document states it; a
 * version 1 document has no such field, and {@link parseDatasetManifest}
 * reads it as `exact` (ADR-029 Decision 1.3), so in memory the field is always
 * present. {@link encodeDatasetManifest} writes it only for version 2, which is
 * what keeps a version 1 manifest's bytes — and therefore its digest — exactly
 * what `WP-130` wrote.
 */
export type DatasetManifest = {
  readonly datasetManifestFormatId: string;
  readonly datasetManifestVersion: number;
  readonly fidelity: "exact";
  readonly datasetId: string;
  readonly createdAt: string;
  readonly schemaVersions: DatasetSchemaVersions;
  readonly writer: DatasetWriterInfo;
  readonly columns: readonly DatasetColumnPin[];
  readonly replayPins: ReplayPins;
  readonly gatewayEpochs: readonly string[];
  readonly eventRange: {
    readonly first: EventIdentity | null;
    readonly last: EventIdentity | null;
  };
  readonly recordCounts: DatasetRecordCounts;
  readonly deduplication: DeduplicationSummary;
  readonly segments: readonly DatasetSegmentEntry[];
  readonly objects: readonly DatasetObjectEntry[];
  readonly excludedSegments: readonly ExcludedSegmentEntry[];
  readonly excludedIncidentWindows: readonly ExcludedIncidentWindowEntry[];
  /** Retention policy in force when the dataset was produced. */
  readonly walRetentionPolicy: string;
};

/** The §12.5 note every manifest carries. */
export const REPLAY_PINS_NOTE =
  "Null entries are run-scoped handoff §12.5 pins a compactor cannot know: the " +
  "normalizer and feature-set versions belong to the gateway and feature engine, " +
  "and the seed, fill/latency model, fee/reward snapshot, and settlement-spec " +
  "versions are chosen by the replay run that consumes this dataset. A null means " +
  "'not pinned yet', never 'not applicable'.";

/** Replay pins with nothing supplied. */
export function emptyReplayPins(overrides: Partial<ReplayPins> = {}): ReplayPins {
  return {
    normalizerVersion: null,
    featureSetVersion: null,
    runSeed: null,
    fillModelVersion: null,
    latencyModelVersion: null,
    feeSnapshotVersion: null,
    rewardSnapshotVersion: null,
    settlementSpecVersions: [],
    ...overrides,
    note: REPLAY_PINS_NOTE,
  };
}

/**
 * The schema versions this build pins.
 *
 * `datasetManifestVersion` defaults to the version this build writes. The
 * compactor can still be asked for version 1 (`CompactionOptions`), which
 * exists only so a committed version 1 fixture stays reproducible byte for
 * byte (ADR-029 Consequences: "Version 1 fixtures and goldens stay version 1
 * and keep passing").
 */
export function currentSchemaVersions(
  datasetManifestVersion: 1 | 2 = DATASET_MANIFEST_VERSION,
): DatasetSchemaVersions {
  return {
    walFormatId: WAL_FORMAT_ID,
    walSchemaVersion: SUPPORTED_WAL_SCHEMA_VERSION,
    walManifestVersion: SUPPORTED_WAL_MANIFEST_VERSION,
    parquetLayoutId: PARQUET_LAYOUT_ID,
    parquetLayoutVersion: PARQUET_LAYOUT_VERSION,
    datasetManifestFormatId: DATASET_MANIFEST_FORMAT_ID,
    datasetManifestVersion,
  };
}

/** The pinned column list, derived from the single layout authority. */
export function currentColumnPins(): readonly DatasetColumnPin[] {
  return DATASET_COLUMNS.map((column) => ({
    name: column.name,
    physicalType: column.physicalType,
    nullable: column.nullable,
  }));
}

/**
 * Serialize a manifest canonically.
 *
 * Key order is fixed by this function rather than by object construction order,
 * so a refactor cannot silently change the bytes and therefore the digest.
 */
export function encodeDatasetManifest(manifest: DatasetManifest): Uint8Array {
  if (
    manifest.datasetManifestVersion !== DATASET_MANIFEST_VERSION_1 &&
    manifest.datasetManifestVersion !== DATASET_MANIFEST_VERSION
  ) {
    throw new DatasetManifestError("refusing to encode a dataset manifest version this build does not write", {
      version: manifest.datasetManifestVersion,
    });
  }
  if (manifest.fidelity !== "exact") {
    throw new DatasetManifestError("an exact dataset manifest must state fidelity exact", {
      fidelity: String(manifest.fidelity),
    });
  }
  const ordered = {
    datasetManifestFormatId: manifest.datasetManifestFormatId,
    datasetManifestVersion: manifest.datasetManifestVersion,
    // ADR-029 Decision 1.1/1.6: required in version 2, absent in version 1
    // (whose bytes must stay exactly what `WP-130` wrote).
    ...(manifest.datasetManifestVersion === DATASET_MANIFEST_VERSION_1
      ? {}
      : { fidelity: manifest.fidelity }),
    datasetId: manifest.datasetId,
    createdAt: manifest.createdAt,
    schemaVersions: {
      walFormatId: manifest.schemaVersions.walFormatId,
      walSchemaVersion: manifest.schemaVersions.walSchemaVersion,
      walManifestVersion: manifest.schemaVersions.walManifestVersion,
      parquetLayoutId: manifest.schemaVersions.parquetLayoutId,
      parquetLayoutVersion: manifest.schemaVersions.parquetLayoutVersion,
      datasetManifestFormatId: manifest.schemaVersions.datasetManifestFormatId,
      datasetManifestVersion: manifest.schemaVersions.datasetManifestVersion,
    },
    writer: {
      library: manifest.writer.library,
      libraryVersion: manifest.writer.libraryVersion,
      codec: manifest.writer.codec,
      rowGroupSize: manifest.writer.rowGroupSize,
    },
    columns: manifest.columns.map((column) => ({
      name: column.name,
      physicalType: column.physicalType,
      nullable: column.nullable,
    })),
    replayPins: {
      normalizerVersion: manifest.replayPins.normalizerVersion,
      featureSetVersion: manifest.replayPins.featureSetVersion,
      runSeed: manifest.replayPins.runSeed,
      fillModelVersion: manifest.replayPins.fillModelVersion,
      latencyModelVersion: manifest.replayPins.latencyModelVersion,
      feeSnapshotVersion: manifest.replayPins.feeSnapshotVersion,
      rewardSnapshotVersion: manifest.replayPins.rewardSnapshotVersion,
      settlementSpecVersions: [...manifest.replayPins.settlementSpecVersions],
      note: manifest.replayPins.note,
    },
    gatewayEpochs: [...manifest.gatewayEpochs],
    eventRange: {
      first: manifest.eventRange.first === null ? null : { ...manifest.eventRange.first },
      last: manifest.eventRange.last === null ? null : { ...manifest.eventRange.last },
    },
    recordCounts: {
      segmentDeclared: manifest.recordCounts.segmentDeclared,
      segmentRead: manifest.recordCounts.segmentRead,
      written: manifest.recordCounts.written,
      replayEligible: manifest.recordCounts.replayEligible,
      excludedByIncident: manifest.recordCounts.excludedByIncident,
      excludedAsDuplicate: manifest.recordCounts.excludedAsDuplicate,
    },
    deduplication: {
      policy: manifest.deduplication.policy,
      duplicateRecordCount: manifest.deduplication.duplicateRecordCount,
      duplicateKeys: [...manifest.deduplication.duplicateKeys],
      duplicateKeysTruncated: manifest.deduplication.duplicateKeysTruncated,
    },
    segments: manifest.segments.map((segment) => ({
      segmentId: segment.segmentId,
      gatewayEpoch: segment.gatewayEpoch,
      segmentIndex: segment.segmentIndex,
      segmentSha256: segment.segmentSha256,
      checksummedByteLength: segment.checksummedByteLength,
      byteSize: segment.byteSize,
      segmentFileSha256: segment.segmentFileSha256,
      recordCount: segment.recordCount,
      firstIngestSeq: segment.firstIngestSeq,
      lastIngestSeq: segment.lastIngestSeq,
      firstReceivedAt: segment.firstReceivedAt,
      lastReceivedAt: segment.lastReceivedAt,
      closeReason: segment.closeReason,
      footerPresent: segment.footerPresent,
      truncatedTailBytes: segment.truncatedTailBytes,
      objectKey: segment.objectKey,
      firstDatasetRowOrdinal: segment.firstDatasetRowOrdinal,
      lastDatasetRowOrdinal: segment.lastDatasetRowOrdinal,
    })),
    objects: manifest.objects.map((object) => ({
      objectKey: object.objectKey,
      byteLength: object.byteLength,
      sha256: object.sha256,
      rowCount: object.rowCount,
      replayEligibleRowCount: object.replayEligibleRowCount,
      firstDatasetRowOrdinal: object.firstDatasetRowOrdinal,
      lastDatasetRowOrdinal: object.lastDatasetRowOrdinal,
      segmentIds: [...object.segmentIds],
    })),
    excludedSegments: manifest.excludedSegments.map((entry) => ({
      segmentId: entry.segmentId,
      gatewayEpoch: entry.gatewayEpoch,
      issues: entry.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        ...(issue.details === undefined ? {} : { details: issue.details }),
      })),
    })),
    excludedIncidentWindows: manifest.excludedIncidentWindows.map((entry) => ({
      window: {
        incidentId: entry.window.incidentId,
        kind: entry.window.kind,
        gatewayEpoch: entry.window.gatewayEpoch,
        fromIngestSeq: entry.window.fromIngestSeq,
        toIngestSeq: entry.window.toIngestSeq,
        openedAt: entry.window.openedAt,
        closedAt: entry.window.closedAt,
        reason: entry.window.reason,
      },
      excludedRecordCount: entry.excludedRecordCount,
      excludedSegmentIds: [...entry.excludedSegmentIds],
    })),
    walRetentionPolicy: manifest.walRetentionPolicy,
  };
  // The own-data encoder with the same two-space gap, byte for byte. This
  // document is persisted to the immutable object store with a digest computed
  // from these bytes; `SER-0` measured `JSON.stringify` under an inherited
  // `toJSON` producing a manifest whose digest was self-consistent with the
  // WRONG bytes, which retention then refused.
  //
  // WHAT `ordered` CONTAINS (`SER-2` review, H1). Everything above is a
  // primitive or this module's own literal EXCEPT one field: an excluded
  // segment's `issue.details`, which is passed through from the reader. The
  // first `SER-2` candidate's claim that the encoder's refusal is therefore
  // "unreachable" was FALSE — `wal-format.ts` copied a corrupt line's parsed
  // `record` discriminator into that bag, so a segment holding 65 nested
  // objects made this call throw `DEPTH` and killed a whole compaction batch
  // that base had completed by excluding the bad segment. The reader now bounds
  // every diagnostic where it captures it, and `WalSegmentIssueDetail` narrows
  // the bag to bounded plain data at every producer, so the refusal is
  // unreachable for a manifest this package builds — from any bytes on disk.
  // It stays a typed refusal rather than silent substitution for the case no
  // type can exclude: a caller that constructed a `DatasetManifest` itself.
  return Buffer.from(`${encodePlainJson(ordered, { indent: 2 })}\n`, "utf8");
}

/** SHA-256 of a manifest's canonical bytes. */
export function datasetManifestDigest(manifest: DatasetManifest): string {
  return sha256Hex(encodeDatasetManifest(manifest));
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatasetManifestError(`${what} must be a JSON object`, { what });
  }
  return value as Record<string, unknown>;
}

/**
 * The fidelity a dataset-manifest document declares, after the version rules
 * of ADR-029 Decision 1:
 *
 * - version 1 has **no** `fidelity` field and reads as `exact` (1.3); a
 *   version 1 document that carries one is not a version 1 document and is
 *   refused, because a reader that honoured it could be told that a raw-WAL
 *   compaction is approximate, or worse, the reverse;
 * - version 2 **requires** it (1.6), and it must be `exact` or `approximate`;
 * - any other format id or version is refused by name.
 *
 * Exported so every reader in this package — and the retention guards that
 * must refuse an approximate manifest as proof of a lossless archive — apply
 * one rule.
 */
export function readDatasetManifestFidelity(value: unknown): DatasetFidelity {
  const source = requireObject(value, "dataset manifest");
  const formatId = source["datasetManifestFormatId"];
  if (formatId !== DATASET_MANIFEST_FORMAT_ID) {
    throw new DatasetManifestError("dataset manifest declares an unknown format", { formatId });
  }
  const version = source["datasetManifestVersion"];
  if (typeof version !== "number" || !READABLE_DATASET_MANIFEST_VERSIONS.includes(version)) {
    throw new DatasetManifestError("dataset manifest version is not readable by this build", {
      version,
      supported: [...READABLE_DATASET_MANIFEST_VERSIONS],
    });
  }
  const hasFidelity = Object.prototype.hasOwnProperty.call(source, "fidelity");
  if (version === DATASET_MANIFEST_VERSION_1) {
    if (hasFidelity) {
      throw new DatasetManifestError(
        "a version 1 dataset manifest has no fidelity field; one that carries it is refused",
        { version },
      );
    }
    return "exact";
  }
  if (!hasFidelity) {
    throw new DatasetManifestError(
      "a version 2 dataset manifest must state its fidelity (ADR-029 Decision 1.6)",
      { version },
    );
  }
  const fidelity = source["fidelity"];
  if (typeof fidelity !== "string" || !(DATASET_FIDELITIES as readonly string[]).includes(fidelity)) {
    throw new DatasetManifestError("dataset manifest declares an unknown fidelity", {
      fidelity: typeof fidelity === "string" ? fidelity : `(${typeof fidelity})`,
      supported: [...DATASET_FIDELITIES],
    });
  }
  return fidelity as DatasetFidelity;
}

/**
 * Parse an **exact** dataset manifest — version 1 or version 2 — refusing a
 * format or version this build cannot read, and refusing an approximate
 * (research-tier) manifest.
 *
 * The refusal of `approximate` is deliberate: every caller of this function
 * consumes a lossless archive — the retention guard proves a deletion against
 * it, and an approximate dataset can prove nothing about bytes it does not
 * hold (ADR-029 Decision 2). A caller that reads either class uses
 * {@link parseAnyDatasetManifest}.
 *
 * Deliberately shallow beyond the identity and class fields: it re-checks them
 * and then trusts the structure, because the caller who needs strong
 * validation of the *contents* is the DuckDB job in
 * `python/research/compaction`, which checks the manifest against the actual
 * Parquet rather than against itself. A version 1 document is returned with
 * `fidelity: "exact"` filled in, which is how it reads (ADR-029 Decision 1.3).
 */
export function parseDatasetManifest(value: unknown): DatasetManifest {
  const fidelity = readDatasetManifestFidelity(value);
  if (fidelity !== "exact") {
    throw new DatasetManifestError(
      "an approximate (research-tier) dataset manifest is not an exact dataset and cannot be read as one",
      { fidelity },
    );
  }
  const source = value as Record<string, unknown>;
  return { ...source, fidelity: "exact" } as unknown as DatasetManifest;
}
