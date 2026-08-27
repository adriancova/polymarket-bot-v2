import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MigrationDefinitionError } from "../errors.js";
import { DEFAULT_MIGRATIONS_DIRECTORY, readMigrations, sha256Hex } from "./loader.js";

const temporaryDirectories: string[] = [];

async function makeDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pmb-migrations-"));
  temporaryDirectories.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents, "utf8");
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readMigrations over db/migrations", () => {
  it("loads every migration in this repository, in order", async () => {
    const migrations = await readMigrations();

    expect(migrations.length).toBeGreaterThanOrEqual(8);
    expect(migrations.map((migration) => migration.version)).toEqual(
      [...migrations].map((migration) => migration.version).sort((a, b) => a.localeCompare(b)),
    );
  });

  it("gives every migration a non-empty rollback, as WP-040 requires", async () => {
    for (const migration of await readMigrations()) {
      expect(migration.downSql.trim().length).toBeGreaterThan(0);
      expect(migration.upChecksum).toMatch(/^[0-9a-f]{64}$/u);
      expect(migration.downChecksum).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("creates the six semantic schemas of §10 and drops each of them", async () => {
    const migrations = await readMigrations();
    const up = migrations.map((migration) => migration.upSql).join("\n");
    const down = migrations.map((migration) => migration.downSql).join("\n");

    for (const schema of ["catalog", "data", "strategy", "execution", "accounting", "ops"]) {
      expect(up).toContain(`create schema ${schema};`);
      expect(down).toContain(`drop schema ${schema} cascade;`);
    }
  });

  it("resolves the repository's db/migrations directory", () => {
    expect(DEFAULT_MIGRATIONS_DIRECTORY.replaceAll("\\", "/")).toMatch(/\/db\/migrations$/u);
  });
});

describe("readMigrations validation", () => {
  it("rejects a migration with no rollback", async () => {
    const directory = await makeDirectory({ "0001_only_up.up.sql": "select 1;" });
    await expect(readMigrations(directory)).rejects.toThrow(MigrationDefinitionError);
  });

  it("rejects a migration with no forward file", async () => {
    const directory = await makeDirectory({ "0001_only_down.down.sql": "select 1;" });
    await expect(readMigrations(directory)).rejects.toThrow(MigrationDefinitionError);
  });

  it("rejects a misnamed file", async () => {
    const directory = await makeDirectory({
      "1_bad_name.up.sql": "select 1;",
      "1_bad_name.down.sql": "select 1;",
    });
    await expect(readMigrations(directory)).rejects.toThrow(MigrationDefinitionError);
  });

  it("rejects two names sharing one version", async () => {
    const directory = await makeDirectory({
      "0001_first.up.sql": "select 1;",
      "0001_first.down.sql": "select 1;",
      "0001_second.up.sql": "select 1;",
      "0001_second.down.sql": "select 1;",
    });
    await expect(readMigrations(directory)).rejects.toThrow(MigrationDefinitionError);
  });

  it("rejects an empty migration body", async () => {
    const directory = await makeDirectory({
      "0001_empty.up.sql": "   \n",
      "0001_empty.down.sql": "select 1;",
    });
    await expect(readMigrations(directory)).rejects.toThrow(MigrationDefinitionError);
  });

  it("rejects a directory that does not exist", async () => {
    await expect(readMigrations(join(tmpdir(), "pmb-does-not-exist-0001"))).rejects.toThrow(
      MigrationDefinitionError,
    );
  });

  it("rejects a directory with no migrations", async () => {
    const directory = await makeDirectory({});
    await expect(readMigrations(directory)).rejects.toThrow(MigrationDefinitionError);
  });
});

describe("sha256Hex", () => {
  it("is the plain SHA-256 of the UTF-8 body", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("changes when a single character of a migration changes", () => {
    expect(sha256Hex("select 1;")).not.toBe(sha256Hex("select 2;"));
  });
});
