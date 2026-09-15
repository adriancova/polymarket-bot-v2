/**
 * The `data.raw_segments` / `data.dataset_manifests` importer (WP-210).
 *
 * ## Why this file exists, and what it is not
 *
 * Operator decision 2026-09-02 (workplan `WP-210` comment; `IMPLEMENTATION_STATUS.md`
 * `WP-120` completion record): `data.raw_segments` (§10.2) was ORPHANED —
 * `WP-120` declined to write it (a PostgreSQL dependency in the recorder's path
 * violates §4.2) and `WP-130` did not persist it (manifests are the on-disk
 * source of truth, and the table is backfillable from them). `WP-210`'s event
 * source is the first consumer that queries recorded segments, so it inherits
 * the table plus "a manifest-reading importer/backfill job".
 *
 * **The table already exists.** `db/migrations/0003_data.up.sql:25` creates
 * `data.raw_segments`, and `:135` creates `data.dataset_manifests` with its two
 * child tables. What was missing was a WRITER, not DDL, so this file is the
 * writer and `WP-210` ships no migration that creates either table. That is
 * disclosed in `test/unit/simulation/migration.test.ts`, which pins the
 * finding against the DDL, and in the WP-210 completion record.
 *
 * ## Idempotency is the contract
 *
 * A backfill is run more than once by definition. Every write here is
 * insert-if-absent on a natural key, and where a row already exists its
 * identity-bearing columns are COMPARED with the manifest rather than
 * overwritten: a second import of the same manifest changes nothing, and an
 * import of a DIFFERENT manifest under the same key is refused rather than
 * silently reconciled. `data.dataset_manifests` and its children are
 * `enforce_append_only` (migration 0003), so "refuse" is the only alternative
 * the schema permits anyway.
 *
 * ## What this importer will NOT invent
 *
 * A dataset manifest does not carry every column `WP-040` requires, and the gaps
 * are real rather than oversights. Each is a REQUIRED CALLER INPUT here, so the
 * operator states it and the importer never guesses:
 *
 * | Column | Why the manifest cannot supply it |
 * | --- | --- |
 * | `raw_segments.source`, `.endpoint` | a WAL segment carries frames from every subscribed feed of one gateway epoch (`wal-format.md` §5); the per-segment manifest entry has no single source or endpoint |
 * | `dataset_manifests.normalizer_version`, `.run_seed` | §12.5 run-scoped pins. `WP-130` records them as `null` with a stated owner ("chosen by the replay run"), so the run supplies them |
 * | `dataset_manifests.manifest_hash` | a document cannot contain its own hash; `WP-130` writes it to a sidecar object, which the caller reads |
 *
 * And two facts the manifest DOES carry have nowhere to go, so they are not
 * persisted and are carried as follow-ups rather than approximated:
 *
 * - `segmentFileSha256` — ADR-017 §1's whole-file digest role. `raw_segments`
 *   has one digest column (`content_sha256`), which this importer fills with
 *   `segmentSha256`, the WAL-chain identity of the checksummed span, because
 *   that is what the column's name and §9.1 usage mean.
 * - the compacted Parquet objects. `raw_segments.compacted_into_segment_id`
 *   expects a segment row per object, and `raw_segments_epoch_seq_unique` keys
 *   rows by `(gateway_epoch, segment_seq)` — a WAL ordinal an object does not
 *   have. Minting one would be an invented ordinal (§9.4).
 *
 * SAFETY: this file holds no credential, opens no venue connection, and writes
 * no order, ledger or balance row.
 */

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import { withMappedErrors } from "../errors.js";
import { uuidV7 } from "../ids.js";
import { encodeJsonbText } from "../json.js";
import type { Detail, Sha256Hex, UuidV7Column } from "../schema/columns.js";
import type { EventSourceValue, SegmentFormatValue } from "../schema/enums.js";

/** One WAL segment as a dataset manifest pins it (`WP-130` `DatasetSegmentEntry`). */
export type ManifestSegmentInput = {
  /** The WAL's own opaque segment id (`wal-format.md` §3). Not a UUIDv7. */
  readonly walSegmentId: string;
  /** The WAL's per-directory ordinal; becomes `raw_segments.segment_seq`. */
  readonly segmentIndex: number;
  /** ADR-017 §1: WAL-chain identity of the checksummed span. */
  readonly segmentSha256: Sha256Hex;
  readonly recordCount: number;
  readonly byteSize: number;
  readonly firstIngestSeq: string | null;
  readonly lastIngestSeq: string | null;
  readonly firstReceivedAt: string | null;
  readonly lastReceivedAt: string | null;
  /** Where the segment's bytes live; `wal-format.md` §3's file name by default. */
  readonly fileUri: Detail;
};

/** An excluded data-quality window as the manifest records it. */
export type ManifestExclusionInput = {
  readonly incidentId: string;
  readonly reason: Detail;
  /** `IncidentWindow.openedAt`. */
  readonly windowStart: string;
  /**
   * `IncidentWindow.closedAt`.
   *
   * `dataset_manifest_exclusions` requires `window_end > window_start`
   * (migration 0003), so an OPEN incident cannot be persisted as an exclusion
   * row. The importer refuses rather than inventing a close time.
   */
  readonly windowEnd: string | null;
};

/** Everything one import needs. Nothing here has a default. */
export type ImportDatasetManifestInput = {
  /** `datasetId` from the manifest; becomes `dataset_manifests.manifest_key`. */
  readonly manifestKey: string;
  /** The single gateway epoch the dataset covers (`wal-format.md` §12.1). */
  readonly gatewayEpoch: string;
  /** SHA-256 of the manifest's canonical bytes, read from its digest sidecar. */
  readonly manifestSha256: Sha256Hex;
  /** §12.5 run-scoped pin; `WP-130` records `null` and the run supplies it. */
  readonly normalizerVersion: string;
  /** §12.5 run-scoped pin, as a canonical unsigned integer string. */
  readonly runSeed: string;
  /** §12.5 "start/end event identity". */
  readonly startEventIdentity: Readonly<Record<string, unknown>>;
  readonly endEventIdentity: Readonly<Record<string, unknown>>;
  /** §12.5 fee/reward/settlement pins and anything else the run pinned. */
  readonly pinnedVersions: Readonly<Record<string, unknown>>;
  /** Not derivable per segment; see the module header. */
  readonly source: EventSourceValue;
  readonly endpoint: Detail;
  /** `JSONL` for WAL segments (`wal-format.md` §3). */
  readonly segmentFormat: SegmentFormatValue;
  readonly segments: readonly ManifestSegmentInput[];
  readonly exclusions: readonly ManifestExclusionInput[];
};

/** What an import did. Running twice yields `created: false` and zero inserts. */
export type ImportDatasetManifestResult = {
  readonly datasetManifestId: UuidV7Column;
  readonly created: boolean;
  readonly segmentsInserted: number;
  readonly segmentsAlreadyPresent: number;
};

/** A refusal from the importer. Never thrown for data reasons; returned. */
export type DatasetImportRefusal = {
  readonly code:
    | "DATASET_IMPORT_MANIFEST_CONFLICT"
    | "DATASET_IMPORT_SEGMENT_CONFLICT"
    | "DATASET_IMPORT_OPEN_INCIDENT_WINDOW"
    | "DATASET_IMPORT_EMPTY_SEGMENT_WINDOW";
  readonly message: string;
};

export type DatasetImportOutcome =
  | { readonly ok: true; readonly value: ImportDatasetManifestResult }
  | { readonly ok: false; readonly refusal: DatasetImportRefusal };

export type DatasetCatalogRepository = ReturnType<typeof createDatasetCatalogRepository>;

function refuse(
  code: DatasetImportRefusal["code"],
  message: string,
): { readonly ok: false; readonly refusal: DatasetImportRefusal } {
  return { ok: false, refusal: { code, message } };
}

export function createDatasetCatalogRepository(db: PolymarketBotDatabase) {
  return {
    /**
     * Imports one dataset manifest, idempotently.
     *
     * Everything happens in ONE transaction: a partially imported manifest —
     * segments present, manifest row absent — would look to a later run like a
     * different dataset that happens to share segment ordinals.
     */
    async importDatasetManifest(
      input: ImportDatasetManifestInput,
    ): Promise<DatasetImportOutcome> {
      for (const exclusion of input.exclusions) {
        if (exclusion.windowEnd === null) {
          return refuse(
            "DATASET_IMPORT_OPEN_INCIDENT_WINDOW",
            `incident ${exclusion.incidentId} is still open (closedAt is null) and data.dataset_manifest_exclusions requires window_end > window_start; the importer refuses rather than inventing a close time`,
          );
        }
      }
      // The three identity documents were already bound as TEXT; since `SER-2`
      // that text is the documents' OWN bytes (`json.ts`), never
      // `JSON.stringify`'s answer through the prototype chain. Encoded after
      // the data refusals above and before the transaction opens, so an
      // unencodable document costs no round trip.
      const startEventIdentity = encodeJsonbText(
        input.startEventIdentity,
        "dataset_manifests.start_event_identity",
      );
      const endEventIdentity = encodeJsonbText(
        input.endEventIdentity,
        "dataset_manifests.end_event_identity",
      );
      const pinnedVersions = encodeJsonbText(
        input.pinnedVersions,
        "dataset_manifests.pinned_versions",
      );
      return await withMappedErrors(async () =>
        inTransaction(db, async (trx) => {
          const segmentIds = new Map<string, UuidV7Column>();
          let segmentsInserted = 0;
          let segmentsAlreadyPresent = 0;

          // Ordered by the WAL's own per-directory ordinal, so two runs insert in
          // the same order and a diff of the two is empty rather than reordered.
          const ordered = [...input.segments].sort((left, right) =>
            left.segmentIndex === right.segmentIndex
              ? compareStrings(left.walSegmentId, right.walSegmentId)
              : left.segmentIndex - right.segmentIndex,
          );

          for (const segment of ordered) {
            const existing = await trx
              .selectFrom("data.raw_segments")
              .select([
                "segment_id",
                "content_sha256",
                "record_count",
                "byte_size",
                "file_uri",
              ])
              .where("gateway_epoch", "=", input.gatewayEpoch)
              .where("segment_seq", "=", String(segment.segmentIndex))
              .executeTakeFirst();

            if (existing !== undefined) {
              if (
                existing.content_sha256 !== segment.segmentSha256 ||
                String(existing.record_count) !== String(segment.recordCount) ||
                String(existing.byte_size) !== String(segment.byteSize) ||
                existing.file_uri !== segment.fileUri
              ) {
                return refuse(
                  "DATASET_IMPORT_SEGMENT_CONFLICT",
                  `a row already exists for (gateway_epoch, segment_seq)=(${input.gatewayEpoch}, ${String(segment.segmentIndex)}) with different bytes; a segment ordinal is an identity and is never overwritten (§6 invariant 9)`,
                );
              }
              segmentIds.set(segment.walSegmentId, existing.segment_id);
              segmentsAlreadyPresent += 1;
              continue;
            }

            const startedAt = segment.firstReceivedAt;
            if (startedAt === null) {
              return refuse(
                "DATASET_IMPORT_EMPTY_SEGMENT_WINDOW",
                `segment ${segment.walSegmentId} records no first receivedAt, and data.raw_segments.started_at is NOT NULL; an empty segment is refused rather than given an invented start`,
              );
            }
            const segmentId = uuidV7();
            await trx
              .insertInto("data.raw_segments")
              .values({
                segment_id: segmentId,
                gateway_epoch: input.gatewayEpoch,
                segment_seq: String(segment.segmentIndex),
                source: input.source,
                endpoint: input.endpoint,
                segment_format: input.segmentFormat,
                file_uri: segment.fileUri,
                record_count: String(segment.recordCount),
                byte_size: String(segment.byteSize),
                content_sha256: segment.segmentSha256,
                first_ingest_seq: segment.firstIngestSeq,
                last_ingest_seq: segment.lastIngestSeq,
                started_at: startedAt,
                ended_at: segment.lastReceivedAt,
                // `sealed_at`, `upload_verified_at` and `checksum_verified_at`
                // are left NULL on purpose. `WP-130` verifies read-back before
                // it writes the manifest, so the FACTS are true — but the
                // manifest records no INSTANT for them, and inventing one would
                // put a fabricated timestamp in a compaction-safety column.
                sealed_at: null,
                compacted_into_segment_id: null,
                upload_verified_at: null,
                checksum_verified_at: null,
              })
              .execute();
            segmentIds.set(segment.walSegmentId, segmentId);
            segmentsInserted += 1;
          }

          const existingManifest = await trx
            .selectFrom("data.dataset_manifests")
            .select(["dataset_manifest_id", "manifest_hash"])
            .where("manifest_key", "=", input.manifestKey)
            .executeTakeFirst();

          if (existingManifest !== undefined) {
            if (existingManifest.manifest_hash !== input.manifestSha256) {
              return refuse(
                "DATASET_IMPORT_MANIFEST_CONFLICT",
                `manifest_key ${input.manifestKey} is already registered with a different manifest_hash; a dataset manifest is immutable (ADR-004 §5) and is never overwritten`,
              );
            }
            return {
              ok: true as const,
              value: {
                datasetManifestId: existingManifest.dataset_manifest_id,
                created: false,
                segmentsInserted,
                segmentsAlreadyPresent,
              },
            };
          }

          const datasetManifestId = uuidV7();
          await trx
            .insertInto("data.dataset_manifests")
            .values({
              dataset_manifest_id: datasetManifestId,
              manifest_key: input.manifestKey,
              normalizer_version: input.normalizerVersion,
              feature_set_id: null,
              run_seed: input.runSeed,
              fill_model_version: null,
              fill_model_parameters: null,
              latency_model_version: null,
              latency_model_parameters: null,
              start_event_identity: startEventIdentity,
              end_event_identity: endEventIdentity,
              pinned_versions: pinnedVersions,
              manifest_hash: input.manifestSha256,
            })
            .execute();

          for (let ordinal = 0; ordinal < ordered.length; ordinal += 1) {
            const segment = ordered[ordinal];
            /* c8 ignore next */
            if (segment === undefined) continue;
            const segmentId = segmentIds.get(segment.walSegmentId);
            /* c8 ignore next */
            if (segmentId === undefined) continue;
            await trx
              .insertInto("data.dataset_manifest_segments")
              .values({
                dataset_manifest_id: datasetManifestId,
                ordinal,
                segment_id: segmentId,
                content_sha256: segment.segmentSha256,
              })
              .execute();
          }

          for (let ordinal = 0; ordinal < input.exclusions.length; ordinal += 1) {
            const exclusion = input.exclusions[ordinal];
            /* c8 ignore next */
            if (exclusion === undefined || exclusion.windowEnd === null) continue;
            await trx
              .insertInto("data.dataset_manifest_exclusions")
              .values({
                dataset_manifest_id: datasetManifestId,
                ordinal,
                data_quality_incident_id: null,
                window_start: exclusion.windowStart,
                window_end: exclusion.windowEnd,
                reason: exclusion.reason,
              })
              .execute();
          }

          return {
            ok: true as const,
            value: {
              datasetManifestId,
              created: true,
              segmentsInserted,
              segmentsAlreadyPresent,
            },
          };
        }),
      );
    },

    /** Every segment a registered manifest pins, in its recorded order. */
    async segmentsOfManifest(manifestKey: string) {
      return await withMappedErrors(async () =>
        db
          .selectFrom("data.dataset_manifest_segments as s")
          .innerJoin(
            "data.dataset_manifests as m",
            "m.dataset_manifest_id",
            "s.dataset_manifest_id",
          )
          .innerJoin("data.raw_segments as r", "r.segment_id", "s.segment_id")
          .select([
            "s.ordinal",
            "s.segment_id",
            "s.content_sha256",
            "r.gateway_epoch",
            "r.segment_seq",
            "r.file_uri",
            "r.record_count",
            "r.byte_size",
          ])
          .where("m.manifest_key", "=", manifestKey)
          .orderBy("s.ordinal", "asc")
          .execute(),
      );
    },
  };
}

/** Locale-independent total string order. */
function compareStrings(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}
