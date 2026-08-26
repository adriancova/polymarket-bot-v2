/**
 * The migration runner.
 *
 * Properties it guarantees:
 *
 *   * **One writer.** A session-level advisory lock serializes concurrent
 *     runners, so two deploying processes cannot interleave DDL.
 *   * **Atomic per migration.** Each migration runs inside one transaction
 *     together with its bookkeeping row, so a failure leaves no half-applied
 *     schema and no row claiming it was applied.
 *   * **Applied migrations are immutable.** The SHA-256 of the SQL as applied is
 *     recorded and re-checked. Editing an applied migration would silently give
 *     a fresh database a different schema from an existing one, so it is an
 *     error rather than something to reconcile.
 *   * **Rollback is symmetric.** `migrateDown` runs the recorded rollbacks in
 *     reverse order and deletes their bookkeeping rows.
 */

import type pg from "pg";

import type { PostgresPool } from "../pool.js";
import { MigrationChecksumMismatchError, MigrationFailedError } from "../errors.js";
import { DEFAULT_MIGRATIONS_DIRECTORY, readMigrations } from "./loader.js";
import type { MigrationFile } from "./loader.js";

/**
 * Advisory lock key for schema migrations.
 *
 * A fixed constant rather than a hash of a string, so the value is greppable and
 * stable across PostgreSQL versions.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 4_004_000_000_000_040n;

const BOOTSTRAP_SQL = `
  create schema if not exists migrations;

  create table if not exists migrations.schema_migrations (
    version text primary key,
    name text not null,
    checksum text not null,
    rollback_checksum text not null,
    applied_at timestamptz not null default now(),
    execution_ms integer not null,
    applied_by text not null
  );
`;

/** A row of `migrations.schema_migrations`. */
export type AppliedMigration = {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly rollbackChecksum: string;
  readonly appliedAt: string;
  readonly executionMs: number;
  readonly appliedBy: string;
};

/** What a migration run did. */
export type MigrationRunResult = {
  readonly direction: "up" | "down";
  readonly applied: readonly { readonly version: string; readonly name: string; readonly durationMs: number }[];
  readonly alreadyCurrent: boolean;
};

export type MigrateOptions = {
  /** Defaults to `db/migrations` resolved from this package. */
  readonly directory?: string;
  /** Recorded in the bookkeeping row so a surprising schema is attributable. */
  readonly appliedBy?: string;
  /**
   * Stop after this version (inclusive). Absent means "apply everything".
   */
  readonly toVersion?: string;
};

export type RollbackOptions = {
  readonly directory?: string;
  /** How many migrations to roll back. `"all"` empties the database. */
  readonly steps?: number | "all";
};

/** Creates the bookkeeping schema. Idempotent, and safe to call concurrently. */
export async function ensureMigrationBookkeeping(pool: PostgresPool): Promise<void> {
  await pool.query(BOOTSTRAP_SQL);
}

/** Reads the applied migrations, oldest first. */
export async function getAppliedMigrations(
  pool: PostgresPool,
): Promise<readonly AppliedMigration[]> {
  await ensureMigrationBookkeeping(pool);
  const result = await pool.query<{
    version: string;
    name: string;
    checksum: string;
    rollback_checksum: string;
    applied_at: string;
    execution_ms: number;
    applied_by: string;
  }>(
    `select version, name, checksum, rollback_checksum, applied_at, execution_ms, applied_by
     from migrations.schema_migrations
     order by version asc`,
  );

  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    rollbackChecksum: row.rollback_checksum,
    appliedAt: row.applied_at,
    executionMs: row.execution_ms,
    appliedBy: row.applied_by,
  }));
}

/**
 * Applies every migration that has not been applied yet.
 *
 * @throws {MigrationChecksumMismatchError} when an applied migration's file has
 *   changed since it ran.
 * @throws {MigrationFailedError} when a migration's SQL fails; the transaction
 *   is rolled back first, so the schema is unchanged.
 */
export async function migrateUp(
  pool: PostgresPool,
  options: MigrateOptions = {},
): Promise<MigrationRunResult> {
  const migrations = await readMigrations(options.directory ?? DEFAULT_MIGRATIONS_DIRECTORY);
  const appliedBy = options.appliedBy ?? "storage-postgres";

  return withAdvisoryLock(pool, async () => {
    await ensureMigrationBookkeeping(pool);
    const applied = await getAppliedMigrations(pool);
    assertAppliedChecksumsMatch(applied, migrations);

    const appliedVersions = new Set(applied.map((entry) => entry.version));
    const pending = migrations.filter(
      (migration) =>
        !appliedVersions.has(migration.version) &&
        (options.toVersion === undefined || migration.version <= options.toVersion),
    );

    const results: { version: string; name: string; durationMs: number }[] = [];

    for (const migration of pending) {
      const durationMs = await runInTransaction(pool, migration, "up", async (client) => {
        const startedAt = process.hrtime.bigint();
        await client.query(migration.upSql);
        const sqlDurationMs = elapsedMs(startedAt);
        await client.query(
          `insert into migrations.schema_migrations
             (version, name, checksum, rollback_checksum, execution_ms, applied_by)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            migration.version,
            migration.name,
            migration.upChecksum,
            migration.downChecksum,
            sqlDurationMs,
            appliedBy,
          ],
        );
      });

      results.push({ version: migration.version, name: migration.name, durationMs });
    }

    return {
      direction: "up" as const,
      applied: results,
      alreadyCurrent: results.length === 0,
    };
  });
}

/**
 * Rolls back applied migrations, newest first.
 *
 * The rollback SQL comes from the files on disk, and their checksums are
 * verified against what was recorded — rolling back with a rollback script that
 * no longer matches the forward script it undoes is exactly how a "clean"
 * rollback leaves objects behind.
 */
export async function migrateDown(
  pool: PostgresPool,
  options: RollbackOptions = {},
): Promise<MigrationRunResult> {
  const migrations = await readMigrations(options.directory ?? DEFAULT_MIGRATIONS_DIRECTORY);
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  return withAdvisoryLock(pool, async () => {
    await ensureMigrationBookkeeping(pool);
    const applied = await getAppliedMigrations(pool);
    assertAppliedChecksumsMatch(applied, migrations);
    // The rollback about to run must be the rollback that was recorded when the
    // forward migration was applied. Checking only the forward checksum would
    // leave the destructive direction unverified: an edited `.down.sql` drops
    // objects the applied `.up.sql` never created, or leaves behind objects it
    // did — which is exactly how a "clean" rollback stops being clean.
    assertAppliedRollbackChecksumsMatch(applied, migrations);

    const steps = options.steps ?? 1;
    const targets = [...applied].reverse().slice(0, steps === "all" ? applied.length : steps);

    const results: { version: string; name: string; durationMs: number }[] = [];

    for (const target of targets) {
      const migration = byVersion.get(target.version);
      if (migration === undefined) {
        throw new MigrationFailedError(
          target.version,
          "down",
          new Error(`No migration file for applied version ${target.version}`),
        );
      }

      const durationMs = await runInTransaction(pool, migration, "down", async (client) => {
        await client.query(migration.downSql);
        await client.query(`delete from migrations.schema_migrations where version = $1`, [
          migration.version,
        ]);
      });

      results.push({ version: migration.version, name: migration.name, durationMs });
    }

    return {
      direction: "down" as const,
      applied: results,
      alreadyCurrent: results.length === 0,
    };
  });
}

function assertAppliedChecksumsMatch(
  applied: readonly AppliedMigration[],
  migrations: readonly MigrationFile[],
): void {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const entry of applied) {
    const migration = byVersion.get(entry.version);
    if (migration === undefined) {
      // A database ahead of the checkout: reported by the caller's own
      // comparison, not silently "fixed" here.
      continue;
    }
    if (migration.upChecksum !== entry.checksum) {
      throw new MigrationChecksumMismatchError(entry.version, entry.checksum, migration.upChecksum);
    }
  }
}

function assertAppliedRollbackChecksumsMatch(
  applied: readonly AppliedMigration[],
  migrations: readonly MigrationFile[],
): void {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const entry of applied) {
    const migration = byVersion.get(entry.version);
    if (migration === undefined) {
      continue;
    }
    if (migration.downChecksum !== entry.rollbackChecksum) {
      throw new MigrationChecksumMismatchError(
        entry.version,
        entry.rollbackChecksum,
        migration.downChecksum,
        "down",
      );
    }
  }
}

async function runInTransaction(
  pool: PostgresPool,
  migration: MigrationFile,
  direction: "up" | "down",
  work: (client: pg.PoolClient) => Promise<void>,
): Promise<number> {
  const client = await pool.connect();
  const startedAt = process.hrtime.bigint();
  try {
    await client.query("begin");
    await work(client);
    await client.query("commit");
  } catch (cause) {
    try {
      await client.query("rollback");
    } catch {
      // The original failure is the useful one; a rollback failure on an
      // already-aborted transaction would mask it.
    }
    throw new MigrationFailedError(migration.version, direction, cause);
  } finally {
    client.release();
  }
  return elapsedMs(startedAt);
}

function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

async function withAdvisoryLock<T>(pool: PostgresPool, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    try {
      return await work();
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
}
