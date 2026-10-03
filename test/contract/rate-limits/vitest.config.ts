/**
 * Contract-suite runner for WP-310 (rate-limit budgets and matching-engine
 * modes): `packages/polymarket-secure/src/rate-limit/**` and
 * `packages/oms/src/restricted-mode/**` against the documented snapshots in
 * `./fixtures/`, the frozen venue fixtures (`test/fixtures/venue/`), the
 * pinned SDK's own HTTP error construction, and the real OMS.
 *
 * Self-contained, like the `polymarket-secure` suite: NO ALIASES. Sources are
 * imported through RELATIVE paths; the pinned SDK is reached only through
 * `packages/polymarket-secure/src/testing` (F6). OFFLINE: every test installs
 * the package's network tripwire; the only HTTP "responses" are in-memory
 * fixtures.
 *
 * Run it with (it is chained into the package's `test:contract`, after the
 * WP-260 suite, and typechecked first):
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
    include: ["test/contract/rate-limits/**/*.test.ts"],
    passWithNoTests: false,
  },
});
