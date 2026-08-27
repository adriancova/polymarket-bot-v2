/**
 * Self-contained runner for the Binance contract suite (`WP-080`).
 *
 * The root runner (`test/vitest.config.ts`) includes only `test/unit/**` and
 * package sources, and it is a `WP-010`-owned protected path. Under the
 * 2026-08-26 workplan test-tree registration ratification this tree therefore
 * carries its own config plus a package-level script
 * (`pnpm --filter @polymarket-bot/binance-adapter test:contract`), the same
 * pattern `WP-040`, `WP-050`, and `WP-060` established, so the suite really runs
 * without editing the root gate. Wiring it into a root script is
 * orchestrator-owned at merge.
 *
 * The aliases resolve the workspace packages to their TypeScript sources: this
 * tree is not a workspace package, so it cannot resolve `@polymarket-bot/*`
 * through `node_modules` without adding a dependency to the protected root
 * manifest.
 *
 * OFFLINE. Nothing in this suite opens a socket or makes a request. Venue facts
 * were verified against the official documentation at implementation time and
 * are frozen into `./fixtures/` with their citations.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export default defineConfig({
  // Keep Vitest's cache in the repository's own node_modules; left at its
  // default it would create `node_modules/.vite` inside this test tree, which is
  // source, not a package.
  cacheDir: resolve(repoRoot, "node_modules/.vite/contract-binance"),
  resolve: {
    alias: [
      {
        find: /^@polymarket-bot\/binance-adapter\/testing$/u,
        replacement: resolve(repoRoot, "packages/binance-adapter/src/testing/index.ts"),
      },
      {
        find: /^@polymarket-bot\/binance-adapter$/u,
        replacement: resolve(repoRoot, "packages/binance-adapter/src/index.ts"),
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
    root: here,
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    passWithNoTests: false,
  },
});
