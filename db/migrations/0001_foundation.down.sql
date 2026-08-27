-- WP-040 / migration 0001 rollback.
--
-- The six semantic schemas are dropped by their own rollbacks, which run first,
-- so nothing depends on `internal` by the time this executes. CASCADE covers
-- the domains, enums, and functions the schema owns.

drop schema internal cascade;
