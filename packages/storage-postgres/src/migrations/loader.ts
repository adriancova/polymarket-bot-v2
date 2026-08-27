/**
 * Migration file loading.
 *
 * The migration mechanism is **plain SQL files plus a small runner in this
 * package** (handoff §2: PostgreSQL with `pg` and a SQL-first typed query
 * layer). The reasons, recorded so the choice can be challenged:
 *
 *   * Every constraint in §10.7 is expressed as DDL — partial unique indexes,
 *     domains, constraint triggers, deferred constraint triggers. A migration
 *     DSL would either not express them or would express them as embedded SQL
 *     strings anyway, adding a dependency that buys nothing.
 *   * The forward and rollback SQL is reviewable as SQL. A reviewer checking
 *     "does this actually enforce one live owner per market" reads the index, not
 *     a builder chain.
 *   * Kysely ships a migrator, but its migrations are TypeScript modules that
 *     must be compiled before they can run — which would make `db:migrate`
 *     depend on a build step of the very package that owns the schema.
 *
 * Every migration is a pair: `NNNN_name.up.sql` and `NNNN_name.down.sql`. A
 * missing rollback is an error, not a convention — §10 requires "forward and
 * rollback migrations".
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MigrationDefinitionError } from "../errors.js";

/** `db/migrations`, resolved relative to this package. */
export const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../../db/migrations", import.meta.url),
);

const MIGRATION_FILE = /^(?<version>\d{4})_(?<name>[a-z0-9_]+)\.(?<direction>up|down)\.sql$/u;

/** One forward/rollback pair. */
export type MigrationFile = {
  /** Zero-padded ordinal, e.g. `0001`. Sorts lexicographically. */
  readonly version: string;
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string;
  readonly upSql: string;
  readonly downSql: string;
  /** SHA-256 of the forward SQL; recorded when applied and re-checked after. */
  readonly upChecksum: string;
  readonly downChecksum: string;
};

/**
 * Reads and validates every migration in `directory`, ordered by version.
 *
 * @throws {MigrationDefinitionError} when a file is misnamed, a direction is
 *   missing, or a version is duplicated. All three would make "apply from an
 *   empty database" mean something different on two machines.
 */
export async function readMigrations(
  directory: string = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<readonly MigrationFile[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(directory);
  } catch (cause) {
    throw new MigrationDefinitionError(`Cannot read migrations directory ${directory}`, { cause });
  }

  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();
  if (sqlFiles.length === 0) {
    throw new MigrationDefinitionError(`No migration files found in ${directory}`);
  }

  const partial = new Map<string, { name: string; up?: string; down?: string }>();

  for (const file of sqlFiles) {
    const match = MIGRATION_FILE.exec(file);
    if (match?.groups === undefined) {
      throw new MigrationDefinitionError(
        `Migration file ${file} does not match NNNN_name.(up|down).sql`,
      );
    }
    const { version, name, direction } = match.groups as {
      version: string;
      name: string;
      direction: "up" | "down";
    };

    const existing = partial.get(version) ?? { name };
    if (existing.name !== name) {
      throw new MigrationDefinitionError(
        `Migration ${version} has conflicting names: ${existing.name} and ${name}`,
      );
    }
    if (existing[direction] !== undefined) {
      throw new MigrationDefinitionError(`Migration ${version} has two ${direction} files`);
    }
    existing[direction] = file;
    partial.set(version, existing);
  }

  const migrations: MigrationFile[] = [];

  for (const [version, files] of [...partial.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.up === undefined) {
      throw new MigrationDefinitionError(`Migration ${version} has no .up.sql file`);
    }
    if (files.down === undefined) {
      throw new MigrationDefinitionError(
        `Migration ${version} (${files.name}) has no .down.sql file. ` +
          "Forward and rollback migrations are both required (handoff §10, work plan WP-040).",
      );
    }

    const upPath = join(directory, files.up);
    const downPath = join(directory, files.down);
    const [upSql, downSql] = await Promise.all([
      readFile(upPath, "utf8"),
      readFile(downPath, "utf8"),
    ]);

    if (upSql.trim().length === 0) {
      throw new MigrationDefinitionError(`Migration ${version} has an empty .up.sql file`);
    }
    if (downSql.trim().length === 0) {
      throw new MigrationDefinitionError(`Migration ${version} has an empty .down.sql file`);
    }

    migrations.push({
      version,
      name: files.name,
      upPath,
      downPath,
      upSql,
      downSql,
      upChecksum: sha256Hex(upSql),
      downChecksum: sha256Hex(downSql),
    });
  }

  return migrations;
}

/** SHA-256 of a migration body, as 64 lowercase hex characters. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
