/**
 * Integration-suite runner for the control API (`WP-240`).
 *
 * Self-contained, following the `WP-040` / `WP-060` / `WP-120` / `WP-130` /
 * `WP-230` pattern: `test/vitest.config.ts` excludes `test/integration/**` and
 * is `WP-010`-owned, so this suite registers itself with its own config plus
 * the package-level script
 * `pnpm --filter @polymarket-bot/control-api test:integration`. Root-script
 * wiring is orchestrator-owned at merge.
 *
 * **No Docker, no external network, no credential.** Every server this suite
 * starts binds `127.0.0.1` on an ephemeral port and is closed afterwards. The
 * PostgreSQL audit sink is not exercised HERE; the acceptance-2 evidence is
 * against the real control plane and the real append-only log. (`CONTROL-1b`:
 * `postgres/` holds the sink's real-PostgreSQL suite, excluded below and run by
 * its own config, so this suite still starts no container.)
 *
 * ## Why this config aliases `apps/trader`
 *
 * `test/integration/control-api/trader-health-shape.test.ts` builds a health
 * snapshot with `apps/trader`'s REAL `HealthState` class and drives it through
 * the control API's door. That pin cannot live in a workspace package —
 * `docs/contracts/dependency-direction.md` F10 forbids any package depending on
 * an app, and `apps/control-api` is itself an app — but this tree sits outside
 * every workspace package, so it can alias both. It is the ONLY place in the
 * repository that may, and it is the reason the shape claim in
 * `packages/observability/src/control/metric-shapes.ts` is executable rather
 * than asserted in prose.
 *
 * Files under `test/` have no `node_modules` to resolve bare workspace imports
 * through; the aliases below map each package this suite uses to its source.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

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
      pkg("control-api/testing", "apps/control-api/src/testing/index.ts"),
      pkg("control-api", "apps/control-api/src/index.ts"),
      pkg("trader", "apps/trader/src/index.ts"),
      pkg("observability", "packages/observability/src/index.ts"),
      pkg("domain", "packages/domain/src/index.ts"),
      pkg("decimal", "packages/decimal/src/index.ts"),
      pkg("risk/plain-data", "packages/risk/src/plain-data.ts"),
      pkg("risk/schema-arena", "packages/risk/src/schema-arena.ts"),
      pkg("risk", "packages/risk/src/index.ts"),
      pkg("storage-postgres", "packages/storage-postgres/src/index.ts"),
    ],
  },
  test: {
    root: repoRoot,
    include: ["test/integration/control-api/**/*.test.ts"],
    // `CONTROL-1b`: the real-PostgreSQL files start a container, and this suite
    // starts none (CI's "control-api (no container)" step). They run through
    // `postgres/vitest.config.ts` and `test:integration:postgres` instead.
    exclude: [...configDefaults.exclude, "test/integration/control-api/postgres/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: false,
  },
});
