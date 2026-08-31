/**
 * RTDS contract-suite runner (WP-100).
 *
 * Self-contained, and deliberately separate both from `test/vitest.config.ts`
 * and from the market adapter's contract config:
 *
 *   * the root config's `include` covers `test/unit/**` and colocated package
 *     tests only, and it is owned by `WP-010`, so this package does not edit it;
 *   * these tests are driven by the frozen sanitized venue fixture under
 *     `test/fixtures/venue/rtds/`, which sits outside every workspace package;
 *   * `test/contract/polymarket-public/**` belongs to `WP-070` and its script
 *     must keep running exactly as it did.
 *
 * Files under `test/` sit outside every workspace package, so a bare workspace
 * import has no `node_modules` to resolve through. The aliases below map the
 * packages this suite uses to their sources; everything those sources import
 * (`zod`, `decimal.js`) resolves inside the owning package.
 *
 * OFFLINE. Nothing in this suite opens a socket or makes an HTTP request: the
 * WebSocket, clock and timer ports are all supplied by the package's own test
 * doubles. Network access was used only during implementation, to verify the
 * venue documentation cited in the handoff.
 *
 * Run it with:
 *   pnpm --filter @polymarket-bot/polymarket-public test:contract:rtds
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
        find: /^@polymarket-bot\/polymarket-public\/rtds$/u,
        replacement: resolve(repoRoot, "packages/polymarket-public/src/rtds/index.ts"),
      },
      {
        find: /^@polymarket-bot\/polymarket-public\/testing$/u,
        replacement: resolve(repoRoot, "packages/polymarket-public/src/testing/index.ts"),
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
    include: ["test/contract/rtds/**/*.test.ts"],
    passWithNoTests: false,
  },
});
