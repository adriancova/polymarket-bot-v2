/**
 * Contract-suite runner for `packages/inventory` wallet operations (WP-300).
 *
 * Self-contained, like the `polymarket-secure` suite: the root config's
 * `include` covers `test/unit/**` and colocated package tests only. Relative
 * imports, no aliases. OFFLINE: the suite reads sanitized fixtures from
 * `test/fixtures/venue/`; nothing is signed or sent. The network tripwire is
 * a setup file (WP300B-R1-04): it is installed before each test module loads,
 * so module-level code is covered too (`network-tripwire.setup.ts`).
 *
 * Run it with:
 *   pnpm --filter @polymarket-bot/inventory test:contract
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export default defineConfig({
  test: {
    root: repoRoot,
    include: ["test/contract/wallet-operations/**/*.test.ts"],
    setupFiles: ["test/contract/wallet-operations/network-tripwire.setup.ts"],
    passWithNoTests: false,
  },
});
