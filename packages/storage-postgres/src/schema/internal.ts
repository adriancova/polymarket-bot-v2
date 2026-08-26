/**
 * Migration bookkeeping.
 *
 * `migrations.schema_migrations` is created by the runner itself, before any
 * migration executes, and is deliberately outside the six semantic schemas of
 * §10: it records what has been applied, not anything about trading.
 */

import type { Sha256Hex, TimestampColumnWithDefault } from "./columns.js";

/** One row per applied migration. */
export type MigrationsSchemaMigrationsTable = {
  version: string;
  name: string;
  /** SHA-256 of the forward SQL exactly as applied. */
  checksum: Sha256Hex;
  /** SHA-256 of the rollback SQL, so a rollback edit is detectable too. */
  rollback_checksum: Sha256Hex;
  applied_at: TimestampColumnWithDefault;
  execution_ms: number;
  applied_by: string;
};

export type InternalSchema = {
  "migrations.schema_migrations": MigrationsSchemaMigrationsTable;
};
