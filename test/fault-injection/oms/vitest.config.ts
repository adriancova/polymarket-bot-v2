/**
 * Self-contained runner for the OMS fault-injection suite (`WP-270`):
 * `pnpm --filter @polymarket-bot/oms test:fault`.
 *
 * The root runner (`test/vitest.config.ts`) does not execute
 * `test/fault-injection/**`, and the root `test:fault` chain and CI run only
 * the WAL suite today; wiring this suite into them is an orchestrator
 * follow-up (as `CI-4` was for the contract suites). The suite imports the
 * package and its shared test support by relative path, so it needs no alias
 * (and `tsconfig.lint.json` no new path).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Keep Vitest's cache in the repository's own node_modules, not inside this test tree.
  cacheDir: resolve(here, "../../../node_modules/.vite/fault-injection-oms"),
  test: {
    root: here,
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    passWithNoTests: false,
  },
});
