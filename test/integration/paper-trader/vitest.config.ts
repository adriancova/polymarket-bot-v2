/**
 * Integration-suite runner for the paper trader (`WP-230`).
 *
 * Self-contained, following the `WP-040` / `WP-060` / `WP-120` / `WP-130`
 * pattern: `test/vitest.config.ts` excludes `test/integration/**` and is
 * `WP-010`-owned, so this suite registers itself with its own config plus the
 * package-level script `pnpm --filter @polymarket-bot/trader test:integration`.
 * Root-script wiring is orchestrator-owned at merge.
 *
 * **No venue, no credential — but no longer no network.** ONE file in this
 * suite opens a TCP socket to a container on `localhost`, and on a cold image
 * cache Testcontainers pulls `postgres:16.6-alpine` — and its own reaper image
 * — from a public registry before it can (see the Docker paragraph below).
 * Nothing here reaches a VENUE, a wallet, a signer or any real credential, and
 * nothing outside that one file leaves the process. The trader's three
 * infrastructure seams — the §12.1 `Clock`, the event transport and the durable
 * store — are exercised through in-memory implementations with failure injection
 * (`apps/trader/src/testing/`), which is exactly how `WP-120`'s suite exercises
 * §4.2's Redis boundary. **Everything else is the REAL merged package**: the
 * order books, the feature engine, the strategy runtime, the Static Bracket
 * strategy, the risk engine, the execution planner, the simulated venue, the
 * ledger and the PnL engine. No subject behaviour is doubled anywhere in this
 * tree.
 *
 * **Docker, for one file only.** `GOV-2B` blocker B1 was a defect in the
 * durable store that only a real database could see: every existing test of
 * `writePnlSnapshot` used the in-memory double, and the double could not
 * reject a column name. `durable-pnl-snapshot-postgres.test.ts` (`TRDR-2`)
 * therefore drives the real `PostgresTraderStore` against a Testcontainers
 * PostgreSQL. It starts that container in its OWN `beforeAll` rather than in a
 * `globalSetup`, so it is the only file in this suite that needs Docker; the
 * rest of the tree stays in-memory. Testcontainers' credentials are throwaway
 * and live only as long as the run (§0.2, ADR-010).
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
