/**
 * Self-contained runner for the WAL fault-injection suite (`WP-050`).
 *
 * The root runner (`test/vitest.config.ts`) does not execute
 * `test/fault-injection/**`, and it is a `WP-010`-owned protected path. Under
 * the 2026-08-26 workplan test-tree registration ratification this tree carries
 * its own config plus a package-level script
 * (`pnpm --filter @polymarket-bot/storage-wal test:fault`), so the suite really
 * runs without editing the root gate.
 *
 * The alias resolves the package to its TypeScript source: this tree is not a
 * workspace package, so it cannot resolve `@polymarket-bot/storage-wal` through
 * `node_modules` without adding a dependency to the protected root manifest.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const packageSource = resolve(here, "../../../packages/storage-wal/src");

export default defineConfig({
  // Keep Vitest's cache in the repository's own node_modules. Left at its
  // default it would create `node_modules/.vite` *inside* this test tree, which
  // is source, not a package.
  cacheDir: resolve(here, "../../../node_modules/.vite/fault-injection-wal"),
  test: {
    root: here,
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    passWithNoTests: false,
  },
  resolve: {
    alias: [
      {
        find: /^@polymarket-bot\/storage-wal\/testing$/u,
        replacement: resolve(packageSource, "testing/index.ts"),
      },
      {
        find: /^@polymarket-bot\/storage-wal$/u,
        replacement: resolve(packageSource, "index.ts"),
      },
    ],
  },
});
