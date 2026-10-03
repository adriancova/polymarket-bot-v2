/**
 * Contract-suite runner for the authenticated user-stream adapter (WP-280,
 * `packages/polymarket-secure/src/user-stream/**`).
 *
 * Self-contained, like the `polymarket-secure` suite beside it: the root
 * config's `include` covers `test/unit/**` and colocated package tests only.
 * NO ALIASES: the suite imports through relative paths to the package source,
 * and to WP-270's OMS and its test harness for the port-conformance check.
 * It never imports `@polymarket/client`.
 *
 * OFFLINE. Every test installs WP-260's network tripwire; the only "frames"
 * are the offline fixtures in `test/fixtures/venue/user-ws/`, delivered to a
 * fake socket port. No socket, no credential.
 *
 * Run it with:
 *   pnpm --filter @polymarket-bot/polymarket-secure test:contract
 * (which also type-checks this suite: `tsconfig.json` beside this file).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export default defineConfig({
  test: {
    root: repoRoot,
    include: ["test/contract/user-stream/**/*.test.ts"],
    passWithNoTests: false,
  },
});
