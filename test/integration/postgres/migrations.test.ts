/**
 * WP-040 acceptance 1: "Migrations apply from an empty database."
 *
 * Plus the rollback half of the deliverable ("forward and rollback migrations"),
 * which is only meaningful if a full rollback leaves nothing behind.
 */

import { cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MIGRATIONS_DIRECTORY,
  MigrationChecksumMismatchError,
  createPostgresPool,
  getAppliedMigrations,
  migrateDown,
  migrateUp,
  readMigrations,
} from "@polymarket-bot/storage-postgres";
import { afterEach, describe, expect, it } from "vitest";

import { captureRejection, useEmptyDatabase } from "./context.js";

const SEMANTIC_SCHEMAS = ["catalog", "data", "strategy", "execution", "accounting", "ops"] as const;

const getConnectionString = useEmptyDatabase("migrations");
const getRollbackConnectionString = useEmptyDatabase("migrations_rollback");

const pools: { end: () => Promise<void> }[] = [];

function poolFor(connectionString: string) {
  const pool = createPostgresPool({
    connectionString,
    applicationName: "wp040-migration-test",
    maxConnections: 2,
    statementTimeoutMs: 60_000,
  });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map(async (pool) => pool.end()));
});

async function listSchemas(pool: ReturnType<typeof poolFor>): Promise<string[]> {
  const result = await pool.query<{ nspname: string }>(
    `select nspname from pg_namespace where nspname = any($1::text[]) order by nspname`,
    [[...SEMANTIC_SCHEMAS, "internal", "migrations"]],
  );
  return result.rows.map((row) => row.nspname);
}

describe("migrations", () => {
  it("apply from an empty database and create all six semantic schemas", async () => {
    const pool = poolFor(getConnectionString());

    expect(await listSchemas(pool)).toEqual([]);

    const result = await migrateUp(pool, { appliedBy: "wp040-test" });

    expect(result.direction).toBe("up");
    expect(result.applied.length).toBeGreaterThanOrEqual(8);
    expect(await listSchemas(pool)).toEqual(
      [...SEMANTIC_SCHEMAS, "internal", "migrations"].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("record every applied migration with its checksum", async () => {
    const pool = poolFor(getConnectionString());
    const [applied, onDisk] = await Promise.all([getAppliedMigrations(pool), readMigrations()]);

    expect(applied.map((entry) => entry.version)).toEqual(onDisk.map((entry) => entry.version));
    for (const [index, entry] of applied.entries()) {
      expect(entry.checksum).toBe(onDisk[index]?.upChecksum);
      expect(entry.rollbackChecksum).toBe(onDisk[index]?.downChecksum);
      expect(entry.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u);
    }
  });

  it("are idempotent: a second run applies nothing", async () => {
    const pool = poolFor(getConnectionString());
    const result = await migrateUp(pool, { appliedBy: "wp040-test" });
    expect(result.alreadyCurrent).toBe(true);
    expect(result.applied).toEqual([]);
  });

  it("create the §10.7 constraints as database objects, not as prose", async () => {
    const pool = poolFor(getConnectionString());

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
       where schemaname in ('catalog','data','strategy','execution','accounting','ops')`,
    );
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));

    // §10.7 "orders(venue_order_id) unique where not null, scoped by environment/account"
    expect(byName.get("orders_venue_order_id_unique")).toMatch(/UNIQUE/iu);
    expect(byName.get("orders_venue_order_id_unique")).toMatch(/venue_order_id IS NOT NULL/iu);
    expect(byName.get("orders_venue_order_id_unique")).toMatch(/environment/iu);

    // §10.7 "submission_attempts(expected_order_hash) unique where known"
    expect(byName.get("submission_attempts_expected_order_hash_unique")).toMatch(
      /expected_order_hash IS NOT NULL/iu,
    );

    // §10.7 "Only one active live owner per market"
    expect(byName.get("market_ownership_one_active_live_owner")).toMatch(/UNIQUE/iu);
    expect(byName.get("market_ownership_one_active_live_owner")).toMatch(/LIVE_OWNER/u);

    // §2 "Exactly one fenced live order writer per account/signer", keyed by
    // execution realm so LIVE, LIVE_MICRO, and EXECUTION_PROBE cannot coexist.
    expect(byName.get("fencing_leases_one_active_holder")).toMatch(/UNIQUE/iu);
    expect(byName.get("fencing_leases_one_active_holder")).toMatch(/execution_realm/u);

    // Venue identity deduplicates even where the account is not yet known.
    expect(byName.get("orders_venue_order_id_unique")).toMatch(/NULLS NOT DISTINCT/iu);

    const constraints = await pool.query<{ conname: string }>(
      `select conname from pg_constraint
       where conname in (
         'fills_venue_identity_unique',
         'orders_live_requires_fencing_token',
         'orders_fencing_lease_fk',
         'balance_projection_no_negative_available',
         'settlement_specs_model_matches_observation',
         'fencing_leases_real_modes_only',
         'market_ownership_instance_environment_fk',
         'orders_plan_environment_fk',
         'orders_plan_account_fk',
         'submission_attempts_plan_environment_fk',
         'plans_run_environment_fk',
         'runs_instance_environment_fk',
         'fills_order_environment_fk'
       )`,
    );
    expect(constraints.rows.map((row) => row.conname).sort((a, b) => a.localeCompare(b))).toEqual([
      "balance_projection_no_negative_available",
      "fencing_leases_real_modes_only",
      "fills_order_environment_fk",
      "fills_venue_identity_unique",
      "market_ownership_instance_environment_fk",
      "orders_fencing_lease_fk",
      "orders_live_requires_fencing_token",
      "orders_plan_account_fk",
      "orders_plan_environment_fk",
      "plans_run_environment_fk",
      "runs_instance_environment_fk",
      "settlement_specs_model_matches_observation",
      "submission_attempts_plan_environment_fk",
    ]);

    // The fill venue identity is a constraint, not an index, so its NULL
    // handling is read from the constraint's own index.
    const fillsIdentity = await pool.query<{ indexdef: string }>(
      `select pg_get_indexdef(conindid) as indexdef from pg_constraint
       where conname = 'fills_venue_identity_unique'`,
    );
    expect(fillsIdentity.rows[0]?.indexdef).toMatch(/NULLS NOT DISTINCT/iu);
  });

  it("keep the reservation facts authoritative for every writer (§10.7)", async () => {
    const pool = poolFor(getConnectionString());

    const triggers = await pool.query<{ tgname: string }>(
      `select tgname from pg_trigger
       where not tgisinternal
         and tgrelid = 'accounting.balance_projection'::regclass`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toContain(
      "balance_projection_reserved_amount_authoritative",
    );
  });

  it("declare every internal primary key with the sortable UUIDv7 domain (§10.7)", async () => {
    const pool = poolFor(getConnectionString());

    // Any primary-key column holding a UUID must hold a *sortable* one, so the
    // check looks for a plain `uuid` where the `internal.uuid_v7` domain
    // belongs. Composite keys over venue-supplied identifiers (`asset_id`,
    // `token_id`) are text, not UUIDs, and are correctly excluded: §10.7 asks
    // for sortable ids "for internal records", not for venue identifiers.
    const plainUuidKeys = await pool.query<{ table_name: string; column_name: string }>(
      `select c.relname as table_name, a.attname as column_name
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       join unnest(con.conkey) as k(attnum) on true
       join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
       where con.contype = 'p'
         and n.nspname in ('catalog','data','strategy','execution','accounting','ops')
         and format_type(a.atttypid, a.atttypmod) = 'uuid'`,
    );

    expect(plainUuidKeys.rows).toEqual([]);

    const sortableKeys = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       join unnest(con.conkey) as k(attnum) on true
       join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
       where con.contype = 'p'
         and n.nspname in ('catalog','data','strategy','execution','accounting','ops')
         and format_type(a.atttypid, a.atttypmod) = 'internal.uuid_v7'`,
    );

    expect(Number(sortableKeys.rows[0]?.count ?? "0")).toBeGreaterThanOrEqual(40);
  });

  it("reject an applied migration whose file has changed", async () => {
    const pool = poolFor(getConnectionString());
    await pool.query(
      `update migrations.schema_migrations set checksum = repeat('0', 64) where version = '0001'`,
    );

    const error = await captureRejection(async () => migrateUp(pool));
    expect(error).toBeInstanceOf(MigrationChecksumMismatchError);

    const onDisk = await readMigrations();
    await pool.query(`update migrations.schema_migrations set checksum = $1 where version = '0001'`, [
      onDisk[0]?.upChecksum,
    ]);
  });

  it("refuse to roll back with a rollback script that has been edited", async () => {
    // The forward checksum protects what a fresh database gets. The rollback
    // checksum protects what a *rolled-back* database keeps: an edited
    // `.down.sql` either drops objects the applied `.up.sql` never created or
    // leaves behind objects it did, and the failure surfaces later, on the
    // re-apply, as an error about an object that "already exists".
    const directory = join(tmpdir(), `wp040-rollback-${String(Date.now())}`);
    await cp(DEFAULT_MIGRATIONS_DIRECTORY, directory, { recursive: true });

    const pool = poolFor(getRollbackConnectionString());
    await migrateUp(pool, { directory, appliedBy: "wp040-rollback-test" });

    const downPath = join(directory, "0008_cross_schema_constraints.down.sql");
    const original = await readFile(downPath, "utf8");
    await writeFile(downPath, `${original}\n-- edited after the migration was applied\n`, "utf8");

    const error = await captureRejection(async () => migrateDown(pool, { directory, steps: 1 }));
    expect(error).toBeInstanceOf(MigrationChecksumMismatchError);
    expect((error as MigrationChecksumMismatchError).direction).toBe("down");
    expect((error as MigrationChecksumMismatchError).version).toBe("0008");

    // Nothing was rolled back: the refusal happens before any rollback runs.
    const applied = await getAppliedMigrations(pool);
    expect(applied.at(-1)?.version).toBe("0008");

    // Restored, so the rollback is verified to work once the file matches again.
    await writeFile(downPath, original, "utf8");
    const rolledBack = await migrateDown(pool, { directory, steps: 1 });
    expect(rolledBack.applied[0]?.version).toBe("0008");
  });

  it("roll back cleanly, leaving no semantic schema behind", async () => {
    const pool = poolFor(getConnectionString());

    const result = await migrateDown(pool, { steps: "all" });
    expect(result.applied.length).toBeGreaterThanOrEqual(8);
    // Newest first.
    expect(result.applied[0]?.version).toBe("0008");

    expect(await listSchemas(pool)).toEqual(["migrations"]);
    expect(await getAppliedMigrations(pool)).toEqual([]);

    const leftoverTypes = await pool.query<{ typname: string }>(
      `select t.typname from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       where n.nspname in ('internal','catalog','data','strategy','execution','accounting','ops')`,
    );
    expect(leftoverTypes.rows).toEqual([]);
  });

  it("re-apply after a full rollback (the rollback really did leave an empty database)", async () => {
    const pool = poolFor(getConnectionString());
    const result = await migrateUp(pool, { appliedBy: "wp040-test" });
    expect(result.applied.length).toBeGreaterThanOrEqual(8);
    expect(await listSchemas(pool)).toEqual(
      [...SEMANTIC_SCHEMAS, "internal", "migrations"].sort((a, b) => a.localeCompare(b)),
    );
  });
});
