/**
 * The emergency CLI's REAL-PostgreSQL suite (WP-330): WP-320's fencing lease
 * store and the `ops.config_change_audit` mirror, against a Testcontainers
 * PostgreSQL with every migration applied, and a database that is really
 * unreachable (a refused local connection) for the independence proof.
 *
 * Run with `pnpm --filter @polymarket-bot/ops-cli test:integration`. The
 * container is started in the file's own `beforeAll` (the precedent of the
 * control API's PostgreSQL suite, `CONTROL-1b`), and nothing skips when
 * Docker is absent: the run fails. `CI-7` (CLOSEOUT-3 L1) chained it into
 * the root `test:integration` as command 9/9, and CI runs it as
 * "Integration tests 9/9"; `test/unit/tooling/ci-step-split.test.ts` fails
 * if it leaves the chain.
 *
 * No venue, no signer, no real credential: Testcontainers' credentials are
 * throwaway, and every venue surface is the in-memory fake of
 * `apps/ops-cli/src/emergency/harness.test-support.ts`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function pkg(name: string, subpath: string): { find: RegExp; replacement: string } {
  return {
    find: new RegExp(`^@polymarket-bot/${name}$`, "u"),
    replacement: resolve(repoRoot, subpath),
  };
}

export default defineConfig({
  resolve: {
    alias: [
      pkg("storage-postgres/testing", "packages/storage-postgres/src/testing/index.ts"),
      pkg("storage-postgres", "packages/storage-postgres/src/index.ts"),
    ],
  },
  test: {
    root: repoRoot,
    include: ["test/integration/ops-cli/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    passWithNoTests: false,
  },
});
