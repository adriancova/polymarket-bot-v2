/**
 * Integration-suite runner for the paper trader (`WP-230`).
 *
 * Self-contained, following the `WP-040` / `WP-060` / `WP-120` / `WP-130`
 * pattern: `test/vitest.config.ts` excludes `test/integration/**` and is
 * `WP-010`-owned, so this suite registers itself with its own config plus the
 * package-level script `pnpm --filter @polymarket-bot/trader test:integration`.
 * Root-script wiring is orchestrator-owned at merge.
 *
 * **No Docker, no network, no credential.** The trader's three infrastructure
 * seams — the §12.1 `Clock`, the event transport and the durable store — are
 * exercised through in-memory implementations with failure injection
 * (`apps/trader/src/testing/`), which is exactly how `WP-120`'s suite exercises
 * §4.2's Redis boundary. **Everything else is the REAL merged package**: the
 * order books, the feature engine, the strategy runtime, the Static Bracket
 * strategy, the risk engine, the execution planner, the simulated venue, the
 * ledger and the PnL engine. No subject behaviour is doubled anywhere in this
 * tree.
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
