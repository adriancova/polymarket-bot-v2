/**
 * Integration-suite runner (WP-060).
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
 * packages this suite uses to their sources. Everything else the tests touch
 * (Testcontainers, the Redis client) is reached through
 * `@polymarket-bot/event-bus` and its `/testing` subpath, whose own imports
 * resolve inside the package.
 *
 * Run it with:
 *   pnpm --filter @polymarket-bot/event-bus test:integration
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
        find: /^@polymarket-bot\/event-bus\/testing$/u,
        replacement: resolve(repoRoot, "packages/event-bus/src/testing/index.ts"),
      },
      {
        find: /^@polymarket-bot\/event-bus$/u,
        replacement: resolve(repoRoot, "packages/event-bus/src/index.ts"),
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
    include: ["test/integration/event-bus/**/*.test.ts"],
    globalSetup: [resolve(here, "global-setup.ts")],
    // One container is started once and shared; each file publishes to its own
    // uniquely named stream, so a slow first pull cannot time out a test and
    // two files can never interleave their publication ordinals.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    teardownTimeout: 120_000,
    // A blocking read holds a connection, and two files running concurrently
    // against one server would still be isolated by stream name — but a single
    // file at a time keeps a failure's cause unambiguous.
    fileParallelism: false,
    passWithNoTests: false,
  },
});
