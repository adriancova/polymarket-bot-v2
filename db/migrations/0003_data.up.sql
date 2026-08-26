-- WP-040 / migration 0003 — `data` schema (handoff §10.2).
--
-- | Table | Purpose |
-- |---|---|
-- | raw_segments          | WAL/Parquet segment metadata and checksums |
-- | dataset_manifests     | Exact input segments and exclusions for replay |
-- | data_quality_incidents| Gaps, staleness, corruption, resync windows |
-- | book_checkpoints      | Sparse authoritative book anchors, not full raw history |
-- | feature_sets          | Feature definition versions |
-- | feature_snapshot_index| References to content-addressed feature records |
--
-- §10.2: "Raw high-frequency events live primarily in WAL/Parquet, not
-- indefinitely in PostgreSQL." Nothing here stores frames; these are anchors,
-- manifests, and checksums.

create schema data;

comment on schema data is
  'Handoff §10.2: segment metadata and checksums, replay manifests, data-quality incidents, book anchors, feature indexes.';

-- ---------------------------------------------------------------------------
-- raw_segments — WAL/Parquet segment metadata and checksums (§9.1)
-- ---------------------------------------------------------------------------

create table data.raw_segments (
  segment_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  gateway_epoch uuid not null,
  segment_seq bigint not null,
  source internal.event_source not null,
  endpoint internal.detail not null,
  segment_format internal.segment_format not null,
  file_uri internal.detail not null,
  record_count bigint not null,
  byte_size bigint not null,
  content_sha256 internal.sha256_hex not null,
  first_ingest_seq internal.uint_string,
  last_ingest_seq internal.uint_string,
  started_at timestamptz not null,
  ended_at timestamptz,
  sealed_at timestamptz,
  -- §9.1: "Compaction never deletes a WAL segment until Parquet upload and
  -- checksum verification succeed." Both facts are recorded, not assumed.
  compacted_into_segment_id internal.uuid_v7 references data.raw_segments (segment_id),
  upload_verified_at timestamptz,
  checksum_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint raw_segments_epoch_seq_unique unique (gateway_epoch, segment_seq),
  constraint raw_segments_counts_non_negative check (record_count >= 0 and byte_size >= 0),
  constraint raw_segments_seq_non_negative check (segment_seq >= 0),
  constraint raw_segments_window check (ended_at is null or ended_at >= started_at),
  constraint raw_segments_compaction_verified check (
    compacted_into_segment_id is null
    or (upload_verified_at is not null and checksum_verified_at is not null)
  )
);

create index raw_segments_epoch_idx on data.raw_segments (gateway_epoch, segment_seq);
create index raw_segments_source_idx on data.raw_segments (source, started_at desc);

create trigger raw_segments_set_updated_at
  before update on data.raw_segments
  for each row execute function internal.set_updated_at();

-- A sealed segment's identity and checksum are facts about bytes on disk.
create trigger raw_segments_immutable_identity
  before update on data.raw_segments
  for each row execute function internal.forbid_column_change(
    'segment_id', 'gateway_epoch', 'segment_seq', 'content_sha256',
    'record_count', 'byte_size', 'file_uri'
  );

-- ---------------------------------------------------------------------------
-- feature_sets — feature definition versions (§9.5)
-- ---------------------------------------------------------------------------

create table data.feature_sets (
  feature_set_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  feature_set_key internal.code not null,
  feature_set_version integer not null,
  definition jsonb not null,
  definition_hash internal.sha256_hex not null,
  created_at timestamptz not null default now(),
  constraint feature_sets_version_unique unique (feature_set_key, feature_set_version),
  constraint feature_sets_version_positive check (feature_set_version >= 1)
);

call internal.enforce_append_only('data', 'feature_sets');

-- ---------------------------------------------------------------------------
-- data_quality_incidents — gaps, staleness, corruption, resync windows
-- ---------------------------------------------------------------------------

create table data.data_quality_incidents (
  data_quality_incident_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  incident_type internal.data_quality_incident_type not null,
  severity internal.incident_severity not null,
  source internal.event_source not null,
  feed_key internal.code not null,
  market_id internal.uuid_v7 references catalog.markets (market_id),
  token_id internal.token_id,
  gateway_epoch uuid,
  -- §7.1 / §9.1: a detected gap requires a new authoritative snapshot before
  -- affected markets resume. The obligation is recorded, never waived.
  requires_authoritative_snapshot boolean not null default true,
  authoritative_snapshot_applied_at timestamptz,
  window_start timestamptz not null,
  window_end timestamptz,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  detail internal.detail not null,
  resolution internal.detail,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint data_quality_incidents_window check (
    window_end is null or window_end >= window_start
  ),
  constraint data_quality_incidents_closed_has_resolution check (
    (closed_at is null) or (resolution is not null)
  )
);

create index data_quality_incidents_open_idx
  on data.data_quality_incidents (feed_key, opened_at desc)
  where closed_at is null;

create trigger data_quality_incidents_set_updated_at
  before update on data.data_quality_incidents
  for each row execute function internal.set_updated_at();

-- ---------------------------------------------------------------------------
-- dataset_manifests — exact input segments and exclusions for replay (§12.5)
-- ---------------------------------------------------------------------------

create table data.dataset_manifests (
  dataset_manifest_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  manifest_key internal.code not null unique,
  normalizer_version internal.identifier not null,
  feature_set_id internal.uuid_v7 references data.feature_sets (feature_set_id),
  run_seed internal.uint_string not null,
  fill_model_version internal.identifier,
  fill_model_parameters jsonb,
  latency_model_version internal.identifier,
  latency_model_parameters jsonb,
  -- §12.5 "start/end event identity": (gatewayEpoch, ingestSeq) pairs, recorded
  -- as structured values because a replay boundary is an identity, not a clock.
  start_event_identity jsonb not null,
  end_event_identity jsonb not null,
  -- §12.5 pins the fee/reward snapshot versions and settlement-spec versions.
  pinned_versions jsonb not null default '{}'::jsonb,
  manifest_hash internal.sha256_hex not null,
  created_at timestamptz not null default now()
);

call internal.enforce_append_only('data', 'dataset_manifests');

-- §10.2 names `dataset_manifests` as holding "exact input segments and
-- exclusions". Those two lists are normalized into child tables so a manifest
-- cannot reference a segment that does not exist.
create table data.dataset_manifest_segments (
  dataset_manifest_id internal.uuid_v7 not null
    references data.dataset_manifests (dataset_manifest_id),
  ordinal integer not null,
  segment_id internal.uuid_v7 not null references data.raw_segments (segment_id),
  content_sha256 internal.sha256_hex not null,
  primary key (dataset_manifest_id, ordinal),
  constraint dataset_manifest_segments_ordinal_non_negative check (ordinal >= 0),
  constraint dataset_manifest_segments_segment_unique unique (dataset_manifest_id, segment_id)
);

call internal.enforce_append_only('data', 'dataset_manifest_segments');

create table data.dataset_manifest_exclusions (
  dataset_manifest_id internal.uuid_v7 not null
    references data.dataset_manifests (dataset_manifest_id),
  ordinal integer not null,
  data_quality_incident_id internal.uuid_v7
    references data.data_quality_incidents (data_quality_incident_id),
  window_start timestamptz not null,
  window_end timestamptz not null,
  reason internal.detail not null,
  primary key (dataset_manifest_id, ordinal),
  constraint dataset_manifest_exclusions_window check (window_end > window_start)
);

call internal.enforce_append_only('data', 'dataset_manifest_exclusions');

-- ---------------------------------------------------------------------------
-- book_checkpoints — sparse authoritative book anchors (§9.4)
-- ---------------------------------------------------------------------------

create table data.book_checkpoints (
  book_checkpoint_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  token_id internal.token_id not null,
  gateway_epoch uuid not null,
  ingest_seq internal.uint_string not null,
  subscription_generation integer,
  -- §9.4: "The implementation must not invent a venue sequence number." Only
  -- ingest order, venue timestamps, and venue-provided hashes are recorded.
  venue_timestamp timestamptz,
  venue_book_hash internal.identifier,
  book_hash internal.sha256_hex not null,
  best_bid internal.price_string,
  best_ask internal.price_string,
  levels jsonb not null,
  source internal.event_source not null,
  segment_id internal.uuid_v7 references data.raw_segments (segment_id),
  captured_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint book_checkpoints_identity_unique unique (token_id, gateway_epoch, ingest_seq)
);

create index book_checkpoints_market_idx
  on data.book_checkpoints (market_id, captured_at desc);

call internal.enforce_append_only('data', 'book_checkpoints');

-- ---------------------------------------------------------------------------
-- feature_snapshot_index — references to content-addressed feature records
-- ---------------------------------------------------------------------------
--
-- §9.5: "A FeatureSnapshot is immutable and content-addressed. High-frequency
-- snapshots may live in the event archive; important action decisions store a
-- durable snapshot reference plus selected indexed values in PostgreSQL."

create table data.feature_snapshot_index (
  feature_snapshot_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  feature_set_id internal.uuid_v7 not null references data.feature_sets (feature_set_id),
  market_id internal.uuid_v7 references catalog.markets (market_id),
  token_id internal.token_id,
  content_hash internal.sha256_hex not null,
  storage_uri internal.detail,
  segment_id internal.uuid_v7 references data.raw_segments (segment_id),
  gateway_epoch uuid,
  ingest_seq internal.uint_string,
  indexed_values jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint feature_snapshot_index_content_unique unique (content_hash)
);

create index feature_snapshot_index_market_idx
  on data.feature_snapshot_index (market_id, captured_at desc);

call internal.enforce_append_only('data', 'feature_snapshot_index');
