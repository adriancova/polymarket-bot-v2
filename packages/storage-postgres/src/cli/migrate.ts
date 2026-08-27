/**
 * `db:migrate` entry point.
 *
 * Usage (from the repository root):
 *
 *   pnpm --filter @polymarket-bot/storage-postgres db:migrate
 *   pnpm --filter @polymarket-bot/storage-postgres db:migrate -- --down --steps=1
 *   pnpm --filter @polymarket-bot/storage-postgres db:migrate -- --status
 *
 * The connection comes from `DATABASE_URL`, or from `PGHOST`/`PGPORT`/
 * `PGDATABASE`/`PGUSER`/`PGPASSWORD` if it is absent. This is the only module in
 * the package that reads the environment: a library that reached for a global
 * connection string could open one a caller never asked for.
 *
 * SAFETY: no run mode, signer, or venue credential is involved. A database URL
 * is not a venue credential and this command performs no venue call.
 */

import process from "node:process";

import { createPostgresPool } from "../pool.js";
import { getAppliedMigrations, migrateDown, migrateUp } from "../migrations/runner.js";
import { readMigrations } from "../migrations/loader.js";

type Command = "up" | "down" | "status";

type Arguments = {
  readonly command: Command;
  readonly steps: number | "all";
  readonly directory: string | undefined;
};

function parseArguments(argv: readonly string[]): Arguments {
  let command: Command = "up";
  let steps: number | "all" = 1;
  let directory: string | undefined;

  for (const argument of argv) {
    if (argument === "--") {
      // `pnpm run <script> -- --flag` forwards the separator verbatim.
      continue;
    }
    if (argument === "--down") {
      command = "down";
    } else if (argument === "--status") {
      command = "status";
    } else if (argument === "--all") {
      steps = "all";
    } else if (argument.startsWith("--steps=")) {
      const value = argument.slice("--steps=".length);
      if (value === "all") {
        steps = "all";
      } else {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`--steps must be a positive integer or "all", received ${value}`);
        }
        steps = parsed;
      }
    } else if (argument.startsWith("--directory=")) {
      directory = argument.slice("--directory=".length);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }

  return { command, steps, directory };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const connectionString = process.env["DATABASE_URL"];

  const pool = createPostgresPool({
    ...(connectionString === undefined ? {} : { connectionString }),
    applicationName: "polymarket-bot-migrate",
    // DDL on a large table can exceed the default statement timeout.
    statementTimeoutMs: 300_000,
  });

  try {
    if (args.command === "status") {
      const [applied, onDisk] = await Promise.all([
        getAppliedMigrations(pool),
        readMigrations(args.directory),
      ]);
      const appliedVersions = new Set(applied.map((entry) => entry.version));
      for (const migration of onDisk) {
        const state = appliedVersions.has(migration.version) ? "applied" : "pending";
        console.log(`${migration.version} ${migration.name} ${state}`);
      }
      return;
    }

    const result =
      args.command === "up"
        ? await migrateUp(pool, {
            ...(args.directory === undefined ? {} : { directory: args.directory }),
            appliedBy: "db:migrate",
          })
        : await migrateDown(pool, {
            ...(args.directory === undefined ? {} : { directory: args.directory }),
            steps: args.steps,
          });

    if (result.alreadyCurrent) {
      console.log(`No migrations to run ${result.direction}.`);
      return;
    }

    for (const entry of result.applied) {
      console.log(`${result.direction} ${entry.version} ${entry.name} (${entry.durationMs}ms)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
