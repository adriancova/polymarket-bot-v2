/**
 * Self-contained runner for the live-safety fault-injection suite (`WP-320`):
 * `pnpm --filter @polymarket-bot/trader test:fault:live-safety`.
 *
 * The root runner (`test/vitest.config.ts`) does not execute
 * `test/fault-injection/**`, and the root `test:fault` chain and CI run only
 * the WAL suite today; wiring this suite into them is the orchestrator's (as
 * `CI-5` does for the OMS and reconciliation suites). The suite imports the
 * packages, `apps/trader/src/live-safety` and the shared test support by
 * relative path, so it needs no alias. The script typechecks this tree first
 * (`./tsconfig.json`): the root `typecheck`'s test program includes only
 * `test/unit`.
 *
 * Nothing here reaches a network, a database, a key or a venue: every port
 * is a fake, and the network tripwire guards every file. The REAL-PostgreSQL
 * half (`postgres/`, Docker) is excluded here and has its own config
 * (`postgres/vitest.config.ts`); the same script runs it after this one (r2
 * O3), so the script needs Docker.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Keep Vitest's cache in the repository's own node_modules, not inside this test tree.
  cacheDir: resolve(here, "../../../node_modules/.vite/fault-injection-live-safety"),
  test: {
    root: here,
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "postgres/**"],
    passWithNoTests: false,
  },
});
