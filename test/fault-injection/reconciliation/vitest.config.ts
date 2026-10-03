/**
 * Self-contained runner for the reconciliation suite (`WP-290`):
 * `pnpm --filter @polymarket-bot/ledger test:fault:reconciliation`.
 *
 * The root runner (`test/vitest.config.ts`) does not execute
 * `test/fault-injection/**`, and the root `test:fault` chain and CI run only
 * the WAL suite today; wiring this suite into them is an orchestrator
 * follow-up (as `CI-4` was for the contract suites, and `CI-5` is for the OMS
 * suite). The suite imports the packages and the OMS suites' shared support
 * by relative path, so it needs no alias.
 *
 * The script lives in `packages/ledger/package.json`, not `packages/oms`'s:
 * `test/unit/oms/source-hygiene.test.ts` pins the OMS manifest to exactly its
 * two scripts. It typechecks this tree first (`./tsconfig.json`): the root
 * `typecheck`'s test program includes only `test/unit`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Keep Vitest's cache in the repository's own node_modules, not inside this test tree.
  cacheDir: resolve(here, "../../../node_modules/.vite/fault-injection-reconciliation"),
  test: {
    root: here,
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    passWithNoTests: false,
  },
});
