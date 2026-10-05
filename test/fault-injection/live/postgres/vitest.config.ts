/**
 * The real-PostgreSQL half of the live-micro fault-injection suite (`WP-340`,
 * packet scenario 6: two live-shaped writers against one fencing lease).
 * Needs Docker (Testcontainers); excluded from the Docker-free runner beside
 * it:
 *
 * ```
 * pnpm exec vitest run --config test/fault-injection/live/postgres/vitest.config.ts
 * ```
 *
 * Typechecked with the rest of the tree (`test/fault-injection/live/tsconfig.json`).
 * Every workspace package is imported by relative path, so no alias is needed.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: resolve(here, "../../../../node_modules/.vite/fault-injection-live-postgres"),
  test: {
    root: here,
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    globalSetup: [resolve(here, "global-setup.ts")],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    teardownTimeout: 120_000,
    passWithNoTests: false,
  },
});
