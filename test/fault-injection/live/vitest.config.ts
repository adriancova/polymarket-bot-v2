/**
 * Self-contained runner for the live-micro fault-injection suite (`WP-340`):
 *
 * ```
 * pnpm exec tsc --noEmit -p test/fault-injection/live/tsconfig.json
 * pnpm exec vitest run --config test/fault-injection/live/vitest.config.ts
 * ```
 *
 * No root script runs it yet: the root `package.json` is a protected path, so
 * wiring this runner into the root `test:fault` chain and CI is the
 * orchestrator's (as `CI-5` did for the OMS and reconciliation suites). The
 * suite imports the packages and the earlier suites' shared support by
 * relative path, so it needs no alias.
 *
 * Docker-free: every venue is the mock CLOB in `support/`, every network
 * attempt is refused by WP-260's tripwire (installed in every file), and no
 * database is touched. The real-PostgreSQL half (two live-shaped writers
 * against one fencing lease) lives under `postgres/`, behind its own runner,
 * and is excluded here.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Keep Vitest's cache in the repository's own node_modules, not inside this test tree.
  cacheDir: resolve(here, "../../../node_modules/.vite/fault-injection-live"),
  test: {
    root: here,
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "postgres/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: false,
  },
});
