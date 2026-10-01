/**
 * Contract-suite runner for `packages/polymarket-secure` (WP-260).
 *
 * Self-contained, like the `polymarket-public` suite: the root config's
 * `include` covers `test/unit/**` and colocated package tests only.
 *
 * NO ALIASES, on purpose. The suite imports the package through RELATIVE
 * paths to its source (`../../../packages/polymarket-secure/src/...`), so it
 * needs no tsconfig `paths` entry and no `tsconfig.lint.json` alias. It never
 * imports `@polymarket/client` itself: only the package may (F6); the suite
 * reaches the pinned SDK through the package's `testing` hooks.
 *
 * OFFLINE. Every test installs the package's network tripwire; the only HTTP
 * "responses" are in-memory fixtures served by a responder, and any other
 * network attempt throws and fails the test.
 *
 * Run it with:
 *   pnpm --filter @polymarket-bot/polymarket-secure test:contract
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export default defineConfig({
  test: {
    root: repoRoot,
    include: ["test/contract/polymarket-secure/**/*.test.ts"],
    passWithNoTests: false,
  },
});
