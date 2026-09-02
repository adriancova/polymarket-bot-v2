/**
 * Soak-harness suite runner (`WP-140`).
 *
 * Self-contained, following the WP-040/WP-060/WP-120/WP-130 test-tree
 * pattern: the root vitest config excludes everything outside `test/unit`
 * and package sources, so this suite registers itself with its own config
 * and the scripts in `./package.json`
 * (`pnpm --dir test/soak/recorder run soak:smoke` etc.). Root-script wiring
 * is orchestrator-owned at merge.
 *
 * **No Docker, no network beyond closed loopback ports.** The smoke spec
 * spawns the REAL gateway bundle exactly as
 * `test/integration/data-gateway/process-liveness.test.ts` does — every
 * endpoint is 127.0.0.1, nothing leaves the machine. The evaluate/compare
 * jobs read files.
 *
 * Timeouts are generous because the smoke builds the real esbuild bundle in
 * beforeAll and runs bounded subprocess windows (seconds, not soak lengths —
 * a soak's LENGTH cannot be tested; only its machinery can).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export default defineConfig({
  test: {
    root: repoRoot,
    include: ["test/soak/recorder/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    passWithNoTests: false,
  },
});
