/**
 * Coinbase contract-suite runner (WP-090).
 *
 * Self-contained, and deliberately separate from `test/vitest.config.ts`:
 *
 *   * the root config is owned by `WP-010`, and this package does not edit it;
 *   * these tests are a *contract* suite over a fixture catalogue, run as
 *     `pnpm --filter @polymarket-bot/coinbase-adapter test:contract`, mirroring
 *     the `WP-040` and `WP-060` pattern.
 *
 * Files under `test/` sit outside every workspace package, so a bare workspace
 * import has no `node_modules` to resolve through. The aliases below map the
 * three packages this suite uses to their sources.
 *
 * OFFLINE. There is no global setup, no container, and no network: the adapter's
 * socket, wall clock, monotonic clock, and timer are all ports, and the suite
 * injects the fakes from `@polymarket-bot/coinbase-adapter/testing`.
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
        find: /^@polymarket-bot\/coinbase-adapter\/testing$/u,
        replacement: resolve(repoRoot, "packages/coinbase-adapter/src/testing/index.ts"),
      },
      {
        find: /^@polymarket-bot\/coinbase-adapter$/u,
        replacement: resolve(repoRoot, "packages/coinbase-adapter/src/index.ts"),
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
    include: ["test/contract/coinbase/**/*.test.ts"],
    passWithNoTests: false,
  },
});
