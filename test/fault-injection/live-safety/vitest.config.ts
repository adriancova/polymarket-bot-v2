/**
 * Self-contained runner for the live-safety fault-injection suite (`WP-320`):
 * `pnpm --filter @polymarket-bot/trader test:fault:live-safety`.
 *
 * The root runner (`test/vitest.config.ts`) does not execute
 * `test/fault-injection/**`. The root `test:fault` chain and CI run the WAL,
 * OMS and reconciliation suites (`CI-5`) but not this one; wiring it in is
 * the orchestrator's. The suite imports the packages,
 * `apps/trader/src/live-safety` and the shared test support by relative path,
 * so it needs no alias. The script typechecks this tree first
 * (`./tsconfig.json`): the root `typecheck`'s test program includes only
 * `test/unit`.
 *
 * Nothing here reaches a network, a database, a key or a venue: every port
 * is a fake, and the network tripwire guards every file. The script needs no
 * Docker.
 *
 * `WP-320` r5: this tree once held a real-PostgreSQL half, under a second
 * runner here. That half drove the process that writes the kill-switch rows,
 * and that process's code may execute only under its own guarded runners.
 * This runner loads the secure adapter, so the half now lives in that
 * process's guarded real-PostgreSQL suite under `test/integration/`. The
 * suite's `runner-hygiene.test.ts` pins that nothing in this tree names that
 * process again.
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
    exclude: ["**/node_modules/**"],
    passWithNoTests: false,
  },
});
