/**
 * Per-file database setup for the integration suite.
 *
 * Each file gets a brand-new database inside the shared container, so
 * "migrations apply from an empty database" is literally true for every file and
 * one file's fixtures can never leak into another's constraint test.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createIsolatedDatabase, createMigratedContext } from "@polymarket-bot/storage-postgres/testing";
import { afterAll, beforeAll, inject } from "vitest";

/** Creates and migrates a database for the current file. */
export function useMigratedDatabase(label: string): () => TestContext {
  let context: TestContext | undefined;

  beforeAll(async () => {
    const { connectionString } = await createIsolatedDatabase(inject("postgresAdminUrl"), label);
    context = await createMigratedContext(connectionString);
  });

  afterAll(async () => {
    await context?.close();
  });

  return () => {
    if (context === undefined) {
      throw new Error("The database context was requested before beforeAll completed.");
    }
    return context;
  };
}

/** Creates an empty database for the current file, without migrating it. */
export function useEmptyDatabase(label: string): () => string {
  let connectionString: string | undefined;

  beforeAll(async () => {
    const created = await createIsolatedDatabase(inject("postgresAdminUrl"), label);
    connectionString = created.connectionString;
  });

  return () => {
    if (connectionString === undefined) {
      throw new Error("The database was requested before beforeAll completed.");
    }
    return connectionString;
  };
}

/**
 * Asserts that `operation` fails, and returns the failure.
 *
 * `expect(...).rejects.toThrow(Type)` loses the error, and every constraint test
 * here needs to assert the SQLSTATE as well as the type — the message is not a
 * contract, the SQLSTATE is.
 */
export async function captureRejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to be rejected, but it succeeded.");
}
