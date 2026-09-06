/**
 * Runner for the `WP-250` paper end-to-end verification suite.
 *
 * SELF-CONTAINED, following the `WP-040` / `WP-060` / `WP-120` / `WP-130` /
 * `WP-230` / `WP-240` pattern. The root runner (`test/vitest.config.ts`) is
 * `WP-010`-owned and its `include` list is
 * `test/unit/**`, `packages/** /src/**`, `apps/** /src/**` — `test/e2e/**` is
 * NOT in it and this package may not edit it, so nothing in this tree enters
 * the root count. Root-script wiring (`pnpm test:e2e`) is a protected-path edit
 * and is orchestrator-owned at merge, the `af059d7` precedent.
 *
 * Run it directly:
 *
 * ```
 * pnpm vitest run --config test/e2e/vitest.config.ts
 * ```
 *
 * **No Docker, no network, no credential, no signer.** Everything is in-process
 * PAPER. The three §12.1 seams the trader takes as constructor arguments — the
 * clock, the event transport and the durable store — are the trader's OWN
 * in-memory implementations (`apps/trader/src/testing/`). Everything else is
 * the REAL merged composition: books, features, the strategy runtime, the
 * Static Bracket strategy, capital allocation, the risk engine, the execution
 * planner, the simulated venue, the ledger and the PnL engine.
 *
 * Files under `test/` sit outside every workspace package, so bare workspace
 * imports have no `node_modules` to resolve through; the aliases below map each
 * package this suite uses to its source.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

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
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: false,
  },
});
