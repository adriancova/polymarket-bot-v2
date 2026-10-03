import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import { NO_SIGNER_SETUP_FILE, noSignerVitePlugin } from "./integration/control-api/support/no-signer-guard.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Unit tests live under test/unit and inside workspace packages.
// Integration tests are intentionally excluded here; `pnpm test:integration`
// is an explicit exit-0 skip placeholder until WP-040+.
const UNIT_INCLUDE = ["test/unit/**/*.test.ts", "packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"];
const UNIT_EXCLUDE = ["**/node_modules/**", "**/dist/**", "test/integration/**"];

/**
 * `CONTROL-1b` r4: the control API's unit tests — every test file that runs
 * control-api code in this runner — run in their own project, under the
 * run-time no-signer guard (`integration/control-api/support/no-signer-guard.ts`:
 * its one vite plugin and its one setup file, exactly). Every other test runs
 * as before, without it: the guard refuses the secure adapter and the venue
 * SDK, which `packages/polymarket-secure`'s own tests load. Acceptance 3 holds
 * this split to exactly these two projects.
 */
const CONTROL_API_TESTS = ["apps/control-api/src/**/*.test.ts", "test/unit/control-api/**/*.test.ts"];

export default defineConfig({
  test: {
    root: repoRoot,
    passWithNoTests: false,
    projects: [
      { test: { name: "unit", include: UNIT_INCLUDE, exclude: [...UNIT_EXCLUDE, ...CONTROL_API_TESTS] } },
      {
        plugins: [noSignerVitePlugin()],
        test: { name: "control-api", include: CONTROL_API_TESTS, exclude: UNIT_EXCLUDE, setupFiles: [NO_SIGNER_SETUP_FILE] },
      },
    ],
  },
});
