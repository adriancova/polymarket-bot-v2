/**
 * Testcontainers helpers (handoff §16.4: "Use Testcontainers for PostgreSQL and
 * Redis").
 *
 * Dev-only. The image is pinned to the same version `docker-compose.yml` runs,
 * so an integration test exercises the PostgreSQL the developer runs locally,
 * not a different major version with different DDL behavior.
 *
 * CREDENTIALS: Testcontainers generates a throwaway user, password, and port for
 * a container that lives for the duration of the test run. Nothing here reads,
 * writes, or requires a real credential (§0.2, ADR-010).
 */

import { randomBytes } from "node:crypto";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { createPostgresPool } from "../pool.js";

/** Pinned to `docker-compose.yml`'s PostgreSQL version. */
export const POSTGRES_TEST_IMAGE = "postgres:16.6-alpine";

/** Starts a throwaway PostgreSQL container. */
export async function startPostgresContainer(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
}

/**
 * Creates a fresh, empty database on a running server and returns its URL.
 *
 * Each test file gets its own database so that "migrations apply from an empty
 * database" is literally true for every file, and so that a file that rolls
 * everything back cannot affect another file's fixtures.
 */
export async function createIsolatedDatabase(
  adminConnectionString: string,
  label = "test",
): Promise<{ readonly connectionString: string; readonly databaseName: string }> {
  const suffix = randomBytes(6).toString("hex");
  const databaseName = `pmb_${sanitize(label)}_${suffix}`;

  const adminPool = createPostgresPool({
    connectionString: adminConnectionString,
    applicationName: "polymarket-bot-test-admin",
    maxConnections: 1,
  });

  try {
    // The database name is generated here from a hex suffix and a sanitized
    // label, so it cannot carry an injected identifier; PostgreSQL has no
    // parameter placeholder for a CREATE DATABASE target.
    await adminPool.query(`create database "${databaseName}"`);
  } finally {
    await adminPool.end();
  }

  const url = new URL(adminConnectionString);
  url.pathname = `/${databaseName}`;

  return { connectionString: url.toString(), databaseName };
}

function sanitize(label: string): string {
  const cleaned = label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_");
  return cleaned.slice(0, 24) || "test";
}
