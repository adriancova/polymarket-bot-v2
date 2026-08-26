/**
 * `data` schema table types (handoff §10.2).
 *
 * Mirrors `db/migrations/0003_data.up.sql`. §10.2: raw high-frequency events
 * live in WAL/Parquet; these are metadata, checksums, manifests, and anchors.
 */

import type {
  AppendOnlyTable,
  BigIntColumn,
  Code,
  Detail,
  Identifier,
  JsonColumn,
  JsonColumnWithDefault,
  NullableJsonColumn,
  DecimalString,
  Sha256Hex,
  TimestampColumn,
  TimestampColumnWithDefault,
  TokenId,
  UnsignedIntegerString,
  Uuid,
  UuidV7Column,
  WithDefault,
} from "./columns.js";
import type {
  DataQualityIncidentTypeValue,
  EventSourceValue,
  IncidentSeverityValue,
  SegmentFormatValue,
} from "./enums.js";

/** §10.2 `raw_segments` — WAL/Parquet segment metadata and checksums (§9.1). */
export type DataRawSegmentsTable = {
  segment_id: WithDefault<UuidV7Column>;
  gateway_epoch: Uuid;
  segment_seq: BigIntColumn;
  source: EventSourceValue;
  endpoint: Detail;
  segment_format: SegmentFormatValue;
  file_uri: Detail;
  record_count: BigIntColumn;
  byte_size: BigIntColumn;
  content_sha256: Sha256Hex;
  first_ingest_seq: UnsignedIntegerString | null;
  last_ingest_seq: UnsignedIntegerString | null;
  started_at: TimestampColumn;
  ended_at: TimestampColumn | null;
  sealed_at: TimestampColumn | null;
  /** §9.1: compaction may not drop a WAL segment before both checks pass. */
  compacted_into_segment_id: UuidV7Column | null;
  upload_verified_at: TimestampColumn | null;
  checksum_verified_at: TimestampColumn | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.2 `feature_sets` — feature definition versions (§9.5). */
export type DataFeatureSetsTable = AppendOnlyTable<{
  feature_set_id: WithDefault<UuidV7Column>;
  feature_set_key: Code;
  feature_set_version: number;
  definition: JsonColumn;
  definition_hash: Sha256Hex;
  created_at: TimestampColumnWithDefault;
}>;

/** §10.2 `data_quality_incidents` — gaps, staleness, corruption, resync. */
export type DataQualityIncidentsTable = {
  data_quality_incident_id: WithDefault<UuidV7Column>;
  incident_type: DataQualityIncidentTypeValue;
  severity: IncidentSeverityValue;
  source: EventSourceValue;
  feed_key: Code;
  market_id: UuidV7Column | null;
  token_id: TokenId | null;
  gateway_epoch: Uuid | null;
  /** §7.1/§9.1: the obligation is recorded, never waived. */
  requires_authoritative_snapshot: WithDefault<boolean>;
  authoritative_snapshot_applied_at: TimestampColumn | null;
  window_start: TimestampColumn;
  window_end: TimestampColumn | null;
  opened_at: TimestampColumnWithDefault;
  closed_at: TimestampColumn | null;
  detail: Detail;
  resolution: Detail | null;
  created_at: TimestampColumnWithDefault;
  updated_at: TimestampColumnWithDefault;
};

/** §10.2 `dataset_manifests` — exact replay inputs (§12.5). */
export type DataDatasetManifestsTable = AppendOnlyTable<{
  dataset_manifest_id: WithDefault<UuidV7Column>;
  manifest_key: Code;
  normalizer_version: Identifier;
  feature_set_id: UuidV7Column | null;
  run_seed: UnsignedIntegerString;
  fill_model_version: Identifier | null;
  fill_model_parameters: NullableJsonColumn;
  latency_model_version: Identifier | null;
  latency_model_parameters: NullableJsonColumn;
  start_event_identity: JsonColumn;
  end_event_identity: JsonColumn;
  pinned_versions: JsonColumnWithDefault;
  manifest_hash: Sha256Hex;
  created_at: TimestampColumnWithDefault;
}>;

/** Normalized "exact input segments" list of a manifest (§12.5). */
export type DataDatasetManifestSegmentsTable = AppendOnlyTable<{
  dataset_manifest_id: UuidV7Column;
  ordinal: number;
  segment_id: UuidV7Column;
  content_sha256: Sha256Hex;
}>;

/** Normalized "excluded incident windows" list of a manifest (§12.5). */
export type DataDatasetManifestExclusionsTable = AppendOnlyTable<{
  dataset_manifest_id: UuidV7Column;
  ordinal: number;
  data_quality_incident_id: UuidV7Column | null;
  window_start: TimestampColumn;
  window_end: TimestampColumn;
  reason: Detail;
}>;

/** §10.2 `book_checkpoints` — sparse authoritative anchors (§9.4). */
export type DataBookCheckpointsTable = AppendOnlyTable<{
  book_checkpoint_id: WithDefault<UuidV7Column>;
  market_id: UuidV7Column;
  token_id: TokenId;
  gateway_epoch: Uuid;
  ingest_seq: UnsignedIntegerString;
  subscription_generation: number | null;
  venue_timestamp: TimestampColumn | null;
  /** §9.4: a venue-provided hash may be recorded; a sequence number may not. */
  venue_book_hash: string | null;
  book_hash: Sha256Hex;
  best_bid: DecimalString | null;
  best_ask: DecimalString | null;
  levels: JsonColumn;
  source: EventSourceValue;
  segment_id: UuidV7Column | null;
  captured_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** §10.2 `feature_snapshot_index` — content-addressed feature references. */
export type DataFeatureSnapshotIndexTable = AppendOnlyTable<{
  feature_snapshot_id: WithDefault<UuidV7Column>;
  feature_set_id: UuidV7Column;
  market_id: UuidV7Column | null;
  token_id: TokenId | null;
  content_hash: Sha256Hex;
  storage_uri: Detail | null;
  segment_id: UuidV7Column | null;
  gateway_epoch: Uuid | null;
  ingest_seq: UnsignedIntegerString | null;
  indexed_values: JsonColumnWithDefault;
  captured_at: TimestampColumn;
  recorded_at: TimestampColumnWithDefault;
}>;

/** Every `data` table, keyed by its qualified name. */
export type DataSchema = {
  "data.raw_segments": DataRawSegmentsTable;
  "data.feature_sets": DataFeatureSetsTable;
  "data.data_quality_incidents": DataQualityIncidentsTable;
  "data.dataset_manifests": DataDatasetManifestsTable;
  "data.dataset_manifest_segments": DataDatasetManifestSegmentsTable;
  "data.dataset_manifest_exclusions": DataDatasetManifestExclusionsTable;
  "data.book_checkpoints": DataBookCheckpointsTable;
  "data.feature_snapshot_index": DataFeatureSnapshotIndexTable;
};
