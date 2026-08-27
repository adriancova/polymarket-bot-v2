/**
 * The typed query layer (handoff §2: "Kysely or another SQL-first typed query
 * layer").
 *
 * Kysely is used as a *typed SQL builder*, not as an ORM: there is no entity
 * cache, no lazy loading, and no implicit write. Every repository issues SQL it
 * could have written by hand, with the column types checked against
 * `src/schema` — which is what makes "no economic field is a `number`" a
 * compile-time property of the query, not only of the column.
 */

import { Kysely, PostgresDialect } from "kysely";

import type { PostgresPool } from "./pool.js";
import type { Database } from "./schema/index.js";
import { withMappedErrors } from "./errors.js";

/** The typed database handle used by every repository. */
export type PolymarketBotDatabase = Kysely<Database>;

/** Wraps an existing pool in a typed Kysely instance. */
export function createDatabase(pool: PostgresPool): PolymarketBotDatabase {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * Runs `work` in one transaction, translating PostgreSQL errors into the typed
 * errors of `errors.ts`.
 *
 * Several §10.7 constraints are `DEFERRABLE INITIALLY DEFERRED` — a ledger
 * transaction balances only once all of its entries exist, and a fill is fully
 * allocated only once its allocations exist. Those checks therefore fire at
 * COMMIT, which is inside this helper, so a caller that ignores the returned
 * promise would miss the violation. Every repository write that spans more than
 * one row goes through here.
 */
export async function inTransaction<T>(
  db: PolymarketBotDatabase,
  work: (trx: PolymarketBotDatabase) => Promise<T>,
): Promise<T> {
  return withMappedErrors(async () => db.transaction().execute(async (trx) => work(trx)));
}
