/**
 * Integration-suite runner (`WP-120`).
 *
 * Self-contained, following the `WP-040`/`WP-060`/`WP-130` pattern: the root
 * config excludes `test/integration/**` and is owned by `WP-010`, so this
 * suite registers itself with its own config plus the package-level script
 * `pnpm --filter @polymarket-bot/data-gateway test:integration`. Root-script
 * wiring is orchestrator-owned at merge.
 *
 * **No network; Docker for ONE file.** Acceptance 4 ("Redis outage stops
 * publication but not WAL recording") is exercised against the WP-060
 * transport INTERFACE via an in-memory implementation with failure injection;
 * the WAL runs on the WP-050 in-memory filesystem; every socket is a scripted
 * double on the adapters' own injected transport ports. Redis itself is
 * covered by the event-bus package's Testcontainers suite and provided for
 * local operation by `infra/compose/data-gateway/`. The exception
 * (`THROUGHPUT-1b`) is `publish-throughput.test.ts`: it starts its own
 * throwaway Redis in `beforeAll` (Testcontainers, the pinned image, a
 * generated loopback port) to drive the real publisher over the real
 * transport, so this suite now needs a Docker daemon for that file.
 *
 * Files under `test/` sit outside every workspace package, so bare workspace
 * imports have no `node_modules` to resolve through; the aliases below map
 * each package this suite uses to its source.
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
      pkg("data-gateway/testing", "apps/data-gateway/src/testing/index.ts"),
      pkg("data-gateway", "apps/data-gateway/src/index.ts"),
      pkg("domain", "packages/domain/src/index.ts"),
      pkg("decimal", "packages/decimal/src/index.ts"),
      pkg("event-bus/testing", "packages/event-bus/src/testing/index.ts"),
      pkg("event-bus", "packages/event-bus/src/index.ts"),
      pkg("storage-wal/testing", "packages/storage-wal/src/testing/index.ts"),
      pkg("storage-wal", "packages/storage-wal/src/index.ts"),
      pkg("polymarket-public/rtds", "packages/polymarket-public/src/rtds/index.ts"),
      pkg("polymarket-public/testing", "packages/polymarket-public/src/testing/index.ts"),
      pkg("polymarket-public", "packages/polymarket-public/src/index.ts"),
      pkg("binance-adapter/testing", "packages/binance-adapter/src/testing/index.ts"),
      pkg("binance-adapter", "packages/binance-adapter/src/index.ts"),
      pkg("coinbase-adapter/testing", "packages/coinbase-adapter/src/testing/index.ts"),
      pkg("coinbase-adapter", "packages/coinbase-adapter/src/index.ts"),
      pkg("universe/testing", "packages/universe/src/testing/index.ts"),
      pkg("universe", "packages/universe/src/index.ts"),
    ],
  },
  test: {
    root: repoRoot,
    include: ["test/integration/data-gateway/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: false,
  },
});
