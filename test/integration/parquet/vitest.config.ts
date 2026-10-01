/**
 * Integration-suite runner (`WP-130`).
 *
 * Self-contained, and deliberately separate from `test/vitest.config.ts`,
 * following the `WP-040`/`WP-060` pattern:
 *
 *   * the root config excludes `test/integration/**`, and it is owned by
 *     `WP-010`, so this package does not edit it;
 *   * this suite writes real files to a temporary directory and reads them back
 *     through two independent implementations, so it is slower than the unit
 *     suite and must not run inside `pnpm test`.
 *
 * **It needs no Docker, except one file.** The object-storage boundary is an
 * injected port and its v1 implementation is a local directory, so there is
 * nothing to emulate. The exception (`STORAGE-1`) is
 * `trader-evidence-postgres.test.ts`: the window classifier reads the
 * trader's rows through a read-only PostgreSQL adapter, and only a real,
 * migrated PostgreSQL can reject a wrong column name.
 *
 * Files under `test/` sit outside every workspace package, so a bare workspace
 * import has no `node_modules` to resolve through. The aliases below map the
 * packages this suite uses to their sources.
 *
 * `@polymarket-bot/storage-wal` appears here on purpose. `storage-parquet` may
 * not depend on it — both are layer 2 and
 * `docs/contracts/dependency-direction.md` §2.1 lists no such same-layer edge
 * (F13) — so the compactor reads the WAL's *published byte format* through its
 * own reader. This suite is what keeps that honest: it writes its segments with
 * the **real `WP-050` writer** and then compacts them, so a drift between the
 * two implementations fails a test rather than silently producing a wrong
 * dataset. The suite is owned and run by `apps/research-worker`, a layer-3
 * composition root, which is permitted to depend on both packages.
 *
 * Run it with:
 *   pnpm --filter @polymarket-bot/research-worker test:integration
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
        find: /^@polymarket-bot\/storage-parquet\/testing$/u,
        replacement: resolve(repoRoot, "packages/storage-parquet/src/testing/index.ts"),
      },
      {
        find: /^@polymarket-bot\/storage-parquet$/u,
        replacement: resolve(repoRoot, "packages/storage-parquet/src/index.ts"),
      },
      {
        find: /^@polymarket-bot\/storage-wal\/testing$/u,
        replacement: resolve(repoRoot, "packages/storage-wal/src/testing/index.ts"),
      },
      {
        find: /^@polymarket-bot\/storage-wal$/u,
        replacement: resolve(repoRoot, "packages/storage-wal/src/index.ts"),
      },
      {
        find: /^@polymarket-bot\/research-worker$/u,
        replacement: resolve(repoRoot, "apps/research-worker/src/index.ts"),
      },
      // STORAGE-1: the classifier's read-only PostgreSQL adapter is tested
      // against a real, migrated PostgreSQL (one file of this suite).
      {
        find: /^@polymarket-bot\/storage-postgres\/testing$/u,
        replacement: resolve(repoRoot, "packages/storage-postgres/src/testing/index.ts"),
      },
      {
        find: /^@polymarket-bot\/storage-postgres$/u,
        replacement: resolve(repoRoot, "packages/storage-postgres/src/index.ts"),
      },
    ],
  },
  test: {
    root: repoRoot,
    include: ["test/integration/parquet/**/*.test.ts"],
    testTimeout: 60_000,
    // The PostgreSQL container of `trader-evidence-postgres.test.ts`.
    hookTimeout: 180_000,
    passWithNoTests: false,
  },
});
