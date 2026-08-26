-- WP-040 / migration 0004 — `strategy` schema (handoff §10.3).
--
-- | Table | Purpose |
-- |---|---|
-- | definitions       | Strategy name, code version, schemas |
-- | configs           | Immutable validated configuration versions |
-- | instances         | Named deployments and ownership rules |
-- | runs              | Code/config/data/model/environment pinning |
-- | state_checkpoints | Versioned strategy state |
-- | decisions         | One record per strategy evaluation |
-- | intents           | Original strategy intents |
-- | approved_intents  | Risk-approved/resized variants |
-- | market_ownership  | The materialized "ownership rules" of `instances` (see below) |

create schema strategy;

comment on schema strategy is
  'Handoff §10.3: strategy definitions, immutable configs, instances and ownership, runs, checkpoints, decisions, intents.';

-- ---------------------------------------------------------------------------
-- definitions — strategy name, code version, schemas
-- ---------------------------------------------------------------------------

create table strategy.definitions (
  definition_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  strategy_name internal.code not null,
  -- A version string such as '0.1.0' is an identifier, not a metric label, so
  -- it is not constrained to the leading-letter `internal.code` grammar.
  code_version internal.identifier not null,
  params_schema jsonb not null,
  state_schema_version integer not null,
  decision_contract_version integer not null,
  description internal.detail,
  created_at timestamptz not null default now(),
  constraint definitions_name_version_unique unique (strategy_name, code_version),
  constraint definitions_state_schema_version_positive check (state_schema_version >= 1),
  constraint definitions_decision_contract_version_positive check (decision_contract_version >= 1)
);

call internal.enforce_append_only('strategy', 'definitions');

-- ---------------------------------------------------------------------------
-- configs — immutable validated configuration versions (§10.7)
-- ---------------------------------------------------------------------------

create table strategy.configs (
  config_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  definition_id internal.uuid_v7 not null references strategy.definitions (definition_id),
  config_version integer not null,
  parameters jsonb not null,
  parameters_hash internal.sha256_hex not null,
  validated_at timestamptz not null,
  created_by internal.identifier not null,
  created_at timestamptz not null default now(),
  constraint configs_version_unique unique (definition_id, config_version),
  constraint configs_hash_unique unique (definition_id, parameters_hash),
  constraint configs_version_positive check (config_version >= 1)
);

-- §10.7: "Immutable strategy configs and market rule versions."
call internal.enforce_append_only('strategy', 'configs');

-- ---------------------------------------------------------------------------
-- instances — named deployments and ownership rules
-- ---------------------------------------------------------------------------

create table strategy.instances (
  instance_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  instance_name internal.code not null,
  definition_id internal.uuid_v7 not null references strategy.definitions (definition_id),
  config_id internal.uuid_v7 not null references strategy.configs (config_id),
  series_id internal.uuid_v7 references catalog.series (series_id),
  -- §10.8: the environment discriminator. One semantic schema; every
  -- environment-scoped record names its own environment.
  environment internal.run_mode not null,
  account_ref internal.identifier,
  default_ownership_mode internal.ownership_mode not null default 'OBSERVER',
  -- §8.2 stable strategy order: market ownership priority, then instance
  -- priority, then instance UUID.
  evaluation_priority integer not null default 0,
  status internal.instance_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instances_name_environment_unique unique (environment, instance_name),
  -- Redundant as a key (`instance_id` is already the primary key) and required
  -- as a foreign-key target: it is what lets every environment-scoped record
  -- downstream — ownership, runs, plans — bind its own `environment` to the
  -- instance's instead of carrying an independent copy a caller could mislabel.
  constraint instances_id_environment_unique unique (instance_id, environment),
  constraint instances_id_account_unique unique (instance_id, account_ref),
  -- §11: BACKTEST, PAPER, and SHADOW require no signer, so they carry no
  -- account reference; a real-order mode always names the account it trades.
  constraint instances_real_mode_has_account check (
    not internal.is_real_order_mode(environment) or account_ref is not null
  )
);

create index instances_series_idx on strategy.instances (series_id, status);

create trigger instances_set_updated_at
  before update on strategy.instances
  for each row execute function internal.set_updated_at();

-- `account_ref` is immutable for the same reason `environment` is: both are the
-- authority an instance trades under. Re-pointing a live instance at another
-- account would move its fencing lease, its exposure, and its ownership claims
-- without a single new record to audit. A different account is a different
-- instance.
create trigger instances_immutable_environment
  before update on strategy.instances
  for each row execute function internal.forbid_column_change(
    'instance_id', 'definition_id', 'environment', 'account_ref'
  );

-- ---------------------------------------------------------------------------
-- market_ownership — one active live owner per market (§6 invariant 11, ADR-011)
-- ---------------------------------------------------------------------------
--
-- §10.3 gives `instances` the purpose "Named deployments and ownership rules".
-- An instance is bound to a *series*, while the ownership constraint §10.7
-- states is per *market*, and a rolling series produces a new ephemeral market
-- every cadence. The ownership rule is therefore materialized as its own
-- append-and-release table so the constraint can exist as a database
-- constraint (ADR-011 §1 enforcement layer 1) rather than as prose.

-- `environment` is NOT an independent property of an ownership claim. It is the
-- environment of the instance making the claim, bound by a composite foreign
-- key: without that binding, two LIVE instances could each own one market by
-- labelling one of the two rows `PAPER`, and the partial unique index below —
-- which is keyed by execution realm — would never see a collision. The claim
-- and the claimant now cannot disagree, for any writer.
create table strategy.market_ownership (
  market_ownership_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  instance_id internal.uuid_v7 not null,
  environment internal.run_mode not null,
  ownership_mode internal.ownership_mode not null,
  status internal.ownership_status not null default 'ACTIVE',
  acquired_at timestamptz not null default now(),
  released_at timestamptz,
  released_reason internal.detail,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_ownership_instance_environment_fk
    foreign key (instance_id, environment)
    references strategy.instances (instance_id, environment),
  constraint market_ownership_release_consistent check (
    (status = 'RELEASED') = (released_at is not null)
  )
);

-- ADR-011 §1: "At most one strategy instance may hold live ownership of a
-- market at a time." All real-order modes share the 'REAL' realm, so a LIVE and
-- a LIVE_MICRO owner of one market collide; each simulated mode has its own
-- realm, so a PAPER or SHADOW owner neither blocks nor is blocked by it (§10.8).
create unique index market_ownership_one_active_live_owner
  on strategy.market_ownership (market_id, internal.execution_realm(environment))
  where ownership_mode = 'LIVE_OWNER' and status = 'ACTIVE';

create index market_ownership_instance_idx
  on strategy.market_ownership (instance_id, status);

create trigger market_ownership_set_updated_at
  before update on strategy.market_ownership
  for each row execute function internal.set_updated_at();

-- Ownership may be released, never silently transferred or re-scoped.
create trigger market_ownership_immutable_identity
  before update on strategy.market_ownership
  for each row execute function internal.forbid_column_change(
    'market_ownership_id', 'market_id', 'instance_id', 'environment',
    'ownership_mode', 'acquired_at'
  );

-- ---------------------------------------------------------------------------
-- runs — code/config/data/model/environment pinning (§9.6, §12.4)
-- ---------------------------------------------------------------------------

create table strategy.runs (
  run_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  instance_id internal.uuid_v7 not null,
  definition_id internal.uuid_v7 not null references strategy.definitions (definition_id),
  config_id internal.uuid_v7 not null references strategy.configs (config_id),
  environment internal.run_mode not null,
  code_commit internal.identifier not null,
  feature_set_id internal.uuid_v7 references data.feature_sets (feature_set_id),
  dataset_manifest_id internal.uuid_v7 references data.dataset_manifests (dataset_manifest_id),
  model_version internal.identifier,
  state_schema_version integer not null,
  simulator_version internal.identifier,
  run_seed internal.uint_string not null,
  status internal.run_status not null default 'RUNNING',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  stop_reason internal.detail,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint runs_end_consistent check ((status = 'RUNNING') = (ended_at is null)),
  -- A run executes an instance, so its environment is the instance's. The
  -- composite key is the foreign-key target for `execution.plans`, which binds
  -- the same way — the environment discriminator is one value, carried down the
  -- chain, not re-declared at each level where a caller could mislabel it.
  constraint runs_instance_environment_fk
    foreign key (instance_id, environment)
    references strategy.instances (instance_id, environment),
  constraint runs_id_environment_unique unique (run_id, environment),
  -- §11: a BACKTEST run replays a pinned dataset; a live-data run does not.
  constraint runs_backtest_has_manifest check (
    environment <> 'BACKTEST' or dataset_manifest_id is not null
  )
);

create index runs_instance_idx on strategy.runs (instance_id, started_at desc);

create trigger runs_set_updated_at
  before update on strategy.runs
  for each row execute function internal.set_updated_at();

-- §9.6: "Start a new run for every code, config, model, feature, or state-schema
-- change." The pinning of a run therefore never changes after it starts.
create trigger runs_immutable_pinning
  before update on strategy.runs
  for each row execute function internal.forbid_column_change(
    'run_id', 'instance_id', 'definition_id', 'config_id', 'environment',
    'code_commit', 'feature_set_id', 'dataset_manifest_id', 'model_version',
    'state_schema_version', 'simulator_version', 'run_seed', 'started_at'
  );

-- ---------------------------------------------------------------------------
-- state_checkpoints — versioned strategy state
-- ---------------------------------------------------------------------------

create table strategy.state_checkpoints (
  state_checkpoint_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  run_id internal.uuid_v7 not null references strategy.runs (run_id),
  instance_id internal.uuid_v7 not null references strategy.instances (instance_id),
  market_id internal.uuid_v7 references catalog.markets (market_id),
  checkpoint_seq bigint not null,
  state_schema_version integer not null,
  state jsonb not null,
  state_hash internal.sha256_hex not null,
  captured_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint state_checkpoints_seq_unique unique (run_id, checkpoint_seq),
  constraint state_checkpoints_seq_non_negative check (checkpoint_seq >= 0)
);

call internal.enforce_append_only('strategy', 'state_checkpoints');

-- ---------------------------------------------------------------------------
-- decisions — one record per strategy evaluation (§6 invariant 3)
-- ---------------------------------------------------------------------------
--
-- "Every strategy callback produces exactly one persisted DecisionResult." The
-- unique (run_id, evaluation_seq) key is what makes "exactly one" a database
-- fact rather than a runtime hope.

create table strategy.decisions (
  decision_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  run_id internal.uuid_v7 not null references strategy.runs (run_id),
  instance_id internal.uuid_v7 not null references strategy.instances (instance_id),
  market_id internal.uuid_v7 references catalog.markets (market_id),
  evaluation_seq bigint not null,
  callback internal.strategy_callback not null,
  decision_type internal.decision_type not null,
  decision_contract_version integer not null,
  -- Validated element-by-element against internal.code by the trigger below.
  reason_codes text [] not null default '{}'::text [],
  feature_snapshot_ref internal.identifier not null,
  feature_snapshot_id internal.uuid_v7 references data.feature_snapshot_index (feature_snapshot_id),
  model_outputs jsonb,
  state_patch jsonb,
  next_wakeup_at timestamptz,
  -- §7.1 information-arrival identity of the event that triggered the
  -- evaluation (§8.4 replay ordering).
  source_event_id uuid,
  gateway_epoch uuid,
  ingest_seq internal.uint_string,
  intent_count integer not null default 0,
  evaluation_duration_us bigint,
  evaluated_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint decisions_evaluation_unique unique (run_id, evaluation_seq),
  constraint decisions_evaluation_seq_non_negative check (evaluation_seq >= 0),
  constraint decisions_intent_count_non_negative check (intent_count >= 0),
  constraint decisions_duration_non_negative check (
    evaluation_duration_us is null or evaluation_duration_us >= 0
  )
);

create index decisions_market_idx on strategy.decisions (market_id, evaluated_at desc);

create trigger decisions_valid_reason_codes
  before insert on strategy.decisions
  for each row execute function internal.assert_text_array_elements(
    'reason_codes', 'internal.code'
  );

call internal.enforce_append_only('strategy', 'decisions');

-- ---------------------------------------------------------------------------
-- intents — original strategy intents (§7.7)
-- ---------------------------------------------------------------------------

create table strategy.intents (
  intent_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  decision_id internal.uuid_v7 not null references strategy.decisions (decision_id),
  run_id internal.uuid_v7 not null references strategy.runs (run_id),
  instance_id internal.uuid_v7 not null references strategy.instances (instance_id),
  market_id internal.uuid_v7 not null references catalog.markets (market_id),
  intent_ordinal integer not null,
  intent_type internal.intent_type not null,
  contract_version integer not null,
  -- The intent payload keeps the frozen §7.7 shape verbatim. Its economic
  -- fields are canonical decimal strings inside the document; the columns that
  -- must be queryable or constrained are lifted out explicitly.
  payload jsonb not null,
  recorded_at timestamptz not null default now(),
  constraint intents_ordinal_unique unique (decision_id, intent_ordinal),
  constraint intents_ordinal_non_negative check (intent_ordinal >= 0)
);

create index intents_market_idx on strategy.intents (market_id, recorded_at desc);

call internal.enforce_append_only('strategy', 'intents');

-- ---------------------------------------------------------------------------
-- approved_intents — risk-approved/resized variants (§9.8)
-- ---------------------------------------------------------------------------

create table strategy.approved_intents (
  approved_intent_id internal.uuid_v7 primary key default internal.uuid_generate_v7(),
  intent_id internal.uuid_v7 not null references strategy.intents (intent_id),
  revision integer not null default 1,
  risk_outcome internal.risk_outcome not null,
  approved_payload jsonb not null,
  resize_reason internal.detail,
  approved_shares internal.non_negative_decimal_string,
  approved_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  constraint approved_intents_revision_unique unique (intent_id, revision),
  constraint approved_intents_revision_positive check (revision >= 1),
  -- §9.8: a resize must say why it resized.
  constraint approved_intents_resize_has_reason check (
    risk_outcome <> 'RESIZED' or resize_reason is not null
  )
);

call internal.enforce_append_only('strategy', 'approved_intents');
