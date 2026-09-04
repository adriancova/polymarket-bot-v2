-- WP-210 / migration 0009 — resolve the `catalog.settlement_specs.payoff_model`
-- NOT NULL divergence.
--
-- THE RECORD THIS IMPLEMENTS (nothing here is invented):
--
--   * `docs/handoffs/WP-110.md` `follow_up` 1: "`catalog.settlement_specs.payoff_model`
--     is `NOT NULL`. A spec whose observation type has no implementing model
--     (ADR-009 §2) cannot be persisted by migration `0002`. Owner: the
--     `db/migrations/**` owner (`WP-040`'s successor), under a new migration —
--     this package must not edit migrations."
--   * `packages/settlement/README.md` §7 item 1: the settlement package makes
--     `payoffModel` OPTIONAL "for exactly that case, so a `VWAP`,
--     `EVENT_RESULT`, or `MANUAL_ORACLE` spec cannot currently be persisted by
--     migration `0002`."
--   * `ADR-009` §2: "An `observation_type` with no implementing model (`VWAP`,
--     `EVENT_RESULT`, `MANUAL_ORACLE` have no model in the §9.3 list) is a spec
--     that cannot be activated for model-dependent strategies. **It is not an
--     invitation to approximate with the nearest available model.**"
--   * `IMPLEMENTATION_STATUS.md` (2026-09-04, WP-210 authorization row): the
--     orchestrator ratified this resolution as part of WP-210's bounded
--     additive migration-path grant.
--
-- ADR-009 §2 has TWO halves and this migration implements both:
--
--   1. a spec whose observation type has no model still yields a spec, so the
--      column becomes NULLABLE;
--   2. such a spec may not NAME a model anyway, so a new CHECK refuses one.
--      Without (2), dropping NOT NULL would newly ALLOW `VWAP` +
--      `TerminalSpotBinaryModel` — precisely the approximation ADR-009 §2
--      forbids. The permitted set below is the shipped compatibility matrix in
--      `packages/settlement/src/models/compatibility.ts`, whose three empty rows
--      are `VWAP`, `EVENT_RESULT` and `MANUAL_ORACLE`.
--
-- NOT CHANGED, deliberately: the `settlement_specs_immutable_semantics` trigger
-- already lists `payoff_model`, so a spec persisted without a model can never
-- gain one by UPDATE. That is ADR-009 §1 / §6 invariant 9 — "a change produces a
-- new `spec_version` rather than an edit" — and relaxing it is not part of this
-- resolution.
--
-- NO VENUE FACT IS ASSERTED HERE. The §9.3 payoff-model list and the
-- observation-type vocabulary are repository contracts (ADR-009), not
-- observations.

alter table catalog.settlement_specs
  alter column payoff_model drop not null;

alter table catalog.settlement_specs
  add constraint settlement_specs_model_only_where_one_exists check (
    payoff_model is null
    or observation_type in ('TERMINAL_SPOT', 'TWAP')
  );

comment on column catalog.settlement_specs.payoff_model is
  'ADR-009 §2: NULL when the observation type has no implementing model (VWAP, EVENT_RESULT, MANUAL_ORACLE). Such a spec is legal but cannot be activated for model-dependent strategies, and may not name a model — see settlement_specs_model_only_where_one_exists.';
