/**
 * `@polymarket-bot/storage-postgres` — the PostgreSQL adapter (WP-040).
 *
 * Contents:
 *
 *   * `db/migrations/**` — forward and rollback SQL for the six semantic schemas
 *     of handoff §10 (`catalog`, `data`, `strategy`, `execution`, `accounting`,
 *     `ops`) and the §10.7 constraints.
 *   * `src/migrations` — the SQL-first migration runner.
 *   * `src/schema` — Kysely typed table definitions for every table.
 *   * `src/repositories` — typed repositories for the shared records.
 *
 * DEPENDENCY DIRECTION (§5.2, `docs/contracts/dependency-direction.md`): this is
 * a layer-2 adapter. It imports `@polymarket-bot/domain` and
 * `@polymarket-bot/decimal`; nothing in `packages/domain` may import it.
 *
 * ECONOMIC VALUES (§6 invariant 1): prices, sizes, fees, balances, and PnL cross
 * this boundary as canonical decimal strings and are stored in a PostgreSQL
 * domain that rejects every other spelling. No repository signature in this
 * package accepts or returns a JavaScript `number` for an economic field.
 *
 * SAFETY: this package holds no credential, contacts no venue, and enables no
 * run mode. `internal.run_mode` is a discriminator column, not an enablement
 * mechanism (ADR-010).
 */

export * from "./database.js";
export * from "./errors.js";
export * from "./fencing/index.js";
export * from "./ids.js";
export * from "./json.js";
export * from "./migrations/index.js";
export * from "./pool.js";
export * from "./repositories/index.js";
export * from "./schema/index.js";
export * from "./timestamps.js";
