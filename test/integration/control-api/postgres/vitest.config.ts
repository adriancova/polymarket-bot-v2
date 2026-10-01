/**
 * The control API's REAL-PostgreSQL suite (`CONTROL-1b`): the durable audit
 * sink, `src/adapters/postgres-audit-sink.ts`, against a Testcontainers
 * PostgreSQL with every migration applied.
 *
 * ## Why a second config, and an opt-in script
 *
 * `../vitest.config.ts` is the control API's integration suite, which starts
 * NO container — CI runs it as "Integration tests 6/6 - control-api (no
 * container)", and that step and its comment are outside this round's grant.
 * So this directory is EXCLUDED there and runs here instead, through
 * `pnpm --filter @polymarket-bot/control-api test:integration:postgres`. It
 * follows the `test/integration/paper-trader` precedent for Docker: the
 * container is started in this file's own `beforeAll`, with no `globalSetup`,
 * and nothing skips when Docker is absent — the run fails. Wiring it into CI
 * is an orchestrator follow-up (`CONTROL-1b` handoff).
 *
 * No venue, no signer, no real credential: Testcontainers' credentials are
 * throwaway and live only as long as the run (§0.2, ADR-010).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

function pkg(name: string, subpath: string): { find: RegExp; replacement: string } {
  return {
    find: new RegExp(`^@polymarket-bot/${name}$`, "u"),
    replacement: resolve(repoRoot, subpath),
  };
}

export default defineConfig({
  resolve: {
    alias: [
      pkg("control-api/testing", "apps/control-api/src/testing/index.ts"),
      pkg("control-api", "apps/control-api/src/index.ts"),
      pkg("observability", "packages/observability/src/index.ts"),
      pkg("domain", "packages/domain/src/index.ts"),
      pkg("decimal", "packages/decimal/src/index.ts"),
      pkg("risk/plain-data", "packages/risk/src/plain-data.ts"),
      pkg("risk/schema-arena", "packages/risk/src/schema-arena.ts"),
      pkg("risk", "packages/risk/src/index.ts"),
      pkg("storage-postgres", "packages/storage-postgres/src/index.ts"),
      pkg("storage-postgres/testing", "packages/storage-postgres/src/testing/index.ts"),
    ],
  },
  test: {
    root: repoRoot,
    include: ["test/integration/control-api/postgres/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    passWithNoTests: false,
  },
});
