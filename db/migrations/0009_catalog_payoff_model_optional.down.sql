-- Rollback of migration 0009.
--
-- The `set not null` below FAILS if any spec with no implementing model has been
-- persisted since. That is the correct behaviour, not an oversight: the only
-- ways to make it succeed would be to delete a reviewed settlement spec or to
-- give it a model it does not have, and ADR-009 §1 / §6 invariant 9 forbid both
-- ("a change produces a new `spec_version` rather than an edit"). An operator
-- rolling back a schema that now holds such a spec has to decide what to do with
-- it explicitly.

alter table catalog.settlement_specs
  drop constraint settlement_specs_model_only_where_one_exists;

alter table catalog.settlement_specs
  alter column payoff_model set not null;

comment on column catalog.settlement_specs.payoff_model is null;
