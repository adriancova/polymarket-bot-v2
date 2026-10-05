/**
 * The live-safety suite's REAL-PostgreSQL half (`WP-320` r1, findings I6 and
 * I7): the durable kill-switch read against a Testcontainers PostgreSQL with
 * every migration applied, written by the REAL control plane through its
 * REAL PostgreSQL audit sink.
 *
 * Why a second config: `../vitest.config.ts` reaches no database and needs
 * no Docker, so this directory is EXCLUDED there and runs here, with Docker.
 * Since r2 (finding O3) the package's ONE fault-script line runs both, the
 * Docker-free half first:
 *
 *   pnpm --filter @polymarket-bot/trader test:fault:live-safety
 *
 * so the real-PostgreSQL proof of the VOID lookup, the two orderings and the
 * release finality (r1 I6/I7, r2 X2) fails that script when it regresses.
 * Following the `test/integration/control-api/postgres` precedent, the
 * container is started in the test file's own `beforeAll`, with no
 * `globalSetup`, and nothing skips when Docker is absent: the run fails.
 * Wiring the script into CI is the orchestrator's. The suite imports by
 * relative path, so it needs no alias. Throwaway Testcontainers credentials
 * only; no venue, no signer, no real credential.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: resolve(here, "../../../../node_modules/.vite/fault-injection-live-safety-postgres"),
  test: {
    root: here,
    include: ["**/*.pg.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    passWithNoTests: false,
  },
});
