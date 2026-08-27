/**
 * Integration-suite runner (WP-040).
 *
 * Self-contained, and deliberately separate from `test/vitest.config.ts`:
 *
 *   * the root config excludes `test/integration/**`, and it is owned by
 *     `WP-010`, so this package does not edit it;
 *   * these tests need Docker and take orders of magnitude longer than the unit
 *     suite, so they must not run inside `pnpm test`.
 *
 * Files under `test/` sit outside every workspace package, so a bare workspace
 * import has no `node_modules` to resolve through. The aliases below map the
 * three packages this suite uses to their sources. Everything else the tests
 * touch (Testcontainers, `pg`, Kysely) is reached through
 * `@polymarket-bot/storage-postgres/testing`, whose own imports resolve inside
 * the package.
 *
 * Run it with:
 *   pnpm --filter @polymarket-bot/storage-postgres test:integration
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@polymarket-bot\/storage-postgres\/testing$/u,
        replacement: resolve(repoRoot, "packages/storage-postgres/src/testing/index.ts"),
      },
      {
        find: /^@polymarket-bot\/storage-postgres$/u,
        replacement: resolve(repoRoot, "packages/storage-postgres/src/index.ts"),
      },
      {
        find: /^@polymarket-bot\/domain$/u,
        replacement: resolve(repoRoot, "packages/domain/src/index.ts"),
      },
      {
        find: /^@polymarket-bot\/decimal$/u,
        replacement: resolve(repoRoot, "packages/decimal/src/index.ts"),
      },
    ],
  },
  test: {
    root: repoRoot,
    include: ["test/integration/postgres/**/*.test.ts"],
    globalSetup: [resolve(here, "global-setup.ts")],
    // One container is started once and shared; each file creates its own
    // database inside it, so a slow first pull cannot time out a test.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    teardownTimeout: 120_000,
    passWithNoTests: false,
  },
});
