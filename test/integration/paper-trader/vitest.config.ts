/**
 * Integration-suite runner for the paper trader (`WP-230`).
 *
 * Self-contained, following the `WP-040` / `WP-060` / `WP-120` / `WP-130`
 * pattern: `test/vitest.config.ts` excludes `test/integration/**` and is
 * `WP-010`-owned, so this suite registers itself with its own config plus the
 * package-level script `pnpm --filter @polymarket-bot/trader test:integration`.
 * Root-script wiring is orchestrator-owned at merge.
 *
 * **No venue, no credential — but no longer no network.** TWO files in this
 * suite open a TCP socket to a container on `localhost` (this paragraph used
 * to say "ONE file … nothing outside that one file leaves the process";
 * `BOOT-1` added the second), and on a cold image cache Testcontainers pulls
 * `postgres:16.6-alpine` — and its own reaper image — from a public registry
 * before it can (see the Docker paragraph below). Nothing here reaches a
 * VENUE, a wallet, a signer or any real credential, and nothing outside those
 * two files leaves the process. In the rest of the tree the trader's three
 * infrastructure seams — the §12.1 `Clock`, the event transport and the durable
 * store — are exercised through in-memory implementations with failure injection
 * (`apps/trader/src/testing/`), which is exactly how `WP-120`'s suite exercises
 * §4.2's Redis boundary. **Everything else is the REAL merged package**: the
 * order books, the feature engine, the strategy runtime, the Static Bracket
 * strategy, the risk engine, the execution planner, the simulated venue, the
 * ledger and the PnL engine. No subject behaviour is doubled anywhere in this
 * tree.
 *
 * **Docker, for two files.** `GOV-2B` blocker B1 was a defect in the durable
 * store that only a real database could see: every existing test of
 * `writePnlSnapshot` used the in-memory double, and the double could not
 * reject a column name. `durable-pnl-snapshot-postgres.test.ts` (`TRDR-2`)
 * therefore drives the real `PostgresTraderStore` against a Testcontainers
 * PostgreSQL, and `durable-trader-first-fill-postgres.test.ts` (`BOOT-1`)
 * drives the ASSEMBLED trader through the process's own startup path against
 * one — the file that proves the durable trader survives its first decision
 * and first fill. This paragraph used to read "**Docker, for one file only.**
 * … it is the only file in this suite that needs Docker". Each starts its
 * container in its OWN `beforeAll` rather than in a `globalSetup`, so no other
 * file in the suite acquires a Docker dependency; the rest of the tree stays
 * in-memory. Testcontainers' credentials are throwaway and live only as long
 * as the run (§0.2, ADR-010).
 *
 * **Dated correction (`UNIV-4`, 2026-09-17): FOUR files, and one of them also
 * needs Redis.** `TRDR-3` added `trader-health-endpoint-postgres.test.ts`
 * (PostgreSQL) and `UNIV-4` added `univ-4-gateway-opens-trader-redis.test.ts`,
 * which starts a PostgreSQL AND a `redis:7.4.2-alpine` container in its own
 * `beforeAll`: it runs the REAL gateway composition with the REAL
 * `RedisStreamsEventTransport` beside the REAL trader composition root, so the
 * `MarketOpened` the trader consumes is the one the gateway's lifecycle feed
 * produced from a venue-shaped stub response, over the same Redis stream the
 * process's own `RedisMarketEventFeed` reads (closeout blocker B10, part (c)).
 * "Two files" above is therefore historical. The rule is unchanged: each
 * container file starts its own containers, and no other file acquires a
 * Docker dependency — `univ-4-gateway-opens-trader.test.ts` proves the same
 * claim in memory.
 *
 * **Dated correction (`BRACKET-1c`, 2026-09-28): FIVE files, two of them with
 * Redis.** `durable-two-brackets-postgres-redis.test.ts` starts a PostgreSQL
 * and a Redis container in its own `beforeAll` and drives a whole two-bracket
 * round trip through the REAL composition root, a Redis stream read by the
 * process's own `RedisMarketEventFeed` and `pump`, and the durable store. The
 * rule is unchanged.
 *
 * **Dated correction (`SNAP-1`, 2026-09-28): SIX files, three of them with
 * Redis.** `durable-two-level-entry-postgres-redis.test.ts` starts a
 * PostgreSQL and a Redis container in its own `beforeAll` and drives
 * `BRACKET-1c`'s round trip with an entry that walks two ask levels in one
 * instant — the shape the durable trader used to halt on
 * (`BRACKET1C-SNAPKEY`) — and (`SNAP-1` r1) a variant with two harvests at
 * one instant. The rule is unchanged.
 *
 * **Dated note (`THROUGHPUT-1c` r8, 2026-10-01): one more Redis file.**
 * `throughput-1c-consumer-frame-proof-redis.test.ts` starts a
 * `redis:7.4.2-alpine` container in its own `beforeAll` and feeds the REAL
 * gateway composition's transport calls, through the real
 * `RedisStreamsEventTransport`, to the process's own `RedisMarketEventFeed`
 * and `pump`. The rule is unchanged.
 *
 * **Dated note (`PROVENANCE-1`, 2026-10-02): two more container files.**
 * `durable-halts-and-refusals-postgres-redis.test.ts` (PostgreSQL and Redis;
 * one scenario starts a SECOND PostgreSQL of its own, which it stops) and
 * `provenance-retention-postgres-redis.test.ts` (PostgreSQL and Redis, plus a
 * throwaway WAL root, object store and state directory under the OS temporary
 * directory, removed afterwards). The rule is unchanged.
 *
 * Files under `test/` sit outside every workspace package, so bare workspace
 * imports have no `node_modules` to resolve through; the aliases below map each
 * package this suite uses to its source.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function pkg(name: string, subpath: string): { find: RegExp; replacement: string } {
  return {
    find: new RegExp(`^@polymarket-bot/${name}$`, "u"),
    replacement: resolve(repoRoot, subpath),
  };
}

export default defineConfig({
  resolve: {
    alias: [
      pkg("trader/testing", "apps/trader/src/testing/index.ts"),
      pkg("trader", "apps/trader/src/index.ts"),
      pkg("domain", "packages/domain/src/index.ts"),
      pkg("decimal", "packages/decimal/src/index.ts"),
      pkg("order-book", "packages/order-book/src/index.ts"),
      pkg("features", "packages/features/src/index.ts"),
      pkg("strategy-sdk", "packages/strategy-sdk/src/index.ts"),
      pkg("strategy-runtime", "packages/strategy-runtime/src/index.ts"),
      pkg("strategy-static-bracket", "packages/strategies/static-bracket/src/index.ts"),
      pkg("capital-allocator", "packages/capital-allocator/src/index.ts"),
      pkg("risk/plain-data", "packages/risk/src/plain-data.ts"),
      pkg("risk/schema-arena", "packages/risk/src/schema-arena.ts"),
      pkg("risk", "packages/risk/src/index.ts"),
      pkg("execution-planner", "packages/execution-planner/src/index.ts"),
      pkg("simulation", "packages/simulation/src/index.ts"),
      pkg("ledger", "packages/ledger/src/index.ts"),
      pkg("pnl", "packages/pnl/src/index.ts"),
      // `TRDR-2`: the Testcontainers fixtures the durable-store files use. The
      // `/testing` subpath was the only one aliased then ("the suite was
      // measured with the bare `@polymarket-bot/storage-postgres` entry removed
      // and passed unchanged, so carrying one would be dead configuration");
      // `BOOT-1`'s `durable-trader-first-fill-postgres.test.ts` now imports a
      // TYPE from the bare entry, and the sibling `tsconfig.json` maps it for
      // `tsc`, so the alias is carried here too for the two to agree. Order is
      // irrelevant: `pkg()` builds the ANCHORED `^@polymarket-bot/storage-postgres$`,
      // which cannot match a `/testing` specifier at all. (`risk/plain-data`
      // above is ordered out of habit, not necessity, and is not this suite's
      // to change.)
      pkg("storage-postgres", "packages/storage-postgres/src/index.ts"),
      pkg("storage-postgres/testing", "packages/storage-postgres/src/testing/index.ts"),
      // `UNIV-4` acceptance (c): `univ-4-gateway-opens-trader-redis.test.ts`
      // drives the REAL gateway composition (with the real Redis transport)
      // beside the real trader, and `univ-4-gateway-opens-trader.test.ts`
      // the same claim on the data-gateway suite's in-memory harness; both
      // reuse that suite's support files. The same rows are carried in
      // `tsconfig.json`.
      pkg("data-gateway/testing", "apps/data-gateway/src/testing/index.ts"),
      pkg("data-gateway", "apps/data-gateway/src/index.ts"),
      pkg("event-bus/testing", "packages/event-bus/src/testing/index.ts"),
      pkg("event-bus", "packages/event-bus/src/index.ts"),
      pkg("storage-wal/testing", "packages/storage-wal/src/testing/index.ts"),
      pkg("storage-wal", "packages/storage-wal/src/index.ts"),
      pkg("polymarket-public", "packages/polymarket-public/src/index.ts"),
      pkg("binance-adapter", "packages/binance-adapter/src/index.ts"),
      pkg("coinbase-adapter/testing", "packages/coinbase-adapter/src/testing/index.ts"),
      // `PROVENANCE-1`: `provenance-retention-postgres-redis.test.ts` runs the
      // REAL research-worker storage cycle (`storageMain`) over the rows the
      // real trader wrote, and the halt/refusal file reads them through the
      // worker's own read-only evidence adapter. The same rows are carried in
      // `tsconfig.json`.
      pkg("research-worker", "apps/research-worker/src/index.ts"),
      pkg("storage-parquet/testing", "packages/storage-parquet/src/testing/index.ts"),
      pkg("storage-parquet", "packages/storage-parquet/src/index.ts"),
      // `ROLLOVER-1`: `rollover-1-series-mirror.test.ts` holds the trader's
      // copy of the reviewed-series rules (`@polymarket-bot/trading-core`
      // `series.ts`, read through `@polymarket-bot/trader`) to the gateway's
      // (`@polymarket-bot/universe`). The same rows are carried in
      // `tsconfig.json` (and `tsconfig.lint.json` already carries them).
      pkg("universe/testing", "packages/universe/src/testing/index.ts"),
      pkg("universe", "packages/universe/src/index.ts"),
    ],
  },
  test: {
    root: repoRoot,
    include: ["test/integration/paper-trader/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: false,
  },
});
