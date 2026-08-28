/**
 * Contract-suite runner (WP-070).
 *
 * Self-contained, and deliberately separate from `test/vitest.config.ts`:
 *
 *   * the root config's `include` covers `test/unit/**` and colocated package
 *     tests only, and it is owned by `WP-010`, so this package does not edit it;
 *   * these tests are driven by the frozen sanitized venue fixtures under
 *     `test/fixtures/venue/`, which sit outside every workspace package.
 *
 * Files under `test/` sit outside every workspace package, so a bare workspace
 * import has no `node_modules` to resolve through. The aliases below map the
 * packages this suite uses to their sources; everything those sources import
 * (`zod`) resolves inside the owning package.
 *
 * OFFLINE. Nothing in this suite opens a socket or makes an HTTP request: the
 * WebSocket, HTTP, clock, timer, and catalogue ports are all supplied by the
 * package's own test doubles. Network access was used only during
 * implementation, to verify the venue documentation cited in the handoff.
 *
 * Run it with:
 *   pnpm --filter @polymarket-bot/polymarket-public test:contract
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
        find: /^@polymarket-bot\/polymarket-public\/testing$/u,
        replacement: resolve(repoRoot, "packages/polymarket-public/src/testing/index.ts"),
      },
      {
        find: /^@polymarket-bot\/polymarket-public$/u,
        replacement: resolve(repoRoot, "packages/polymarket-public/src/index.ts"),
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
    include: ["test/contract/polymarket-public/**/*.test.ts"],
    passWithNoTests: false,
  },
});
