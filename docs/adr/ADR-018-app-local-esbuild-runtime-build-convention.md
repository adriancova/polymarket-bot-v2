# ADR-018: Workspace apps that must run use an app-local esbuild bundle

- **Status:** Accepted
- **Date:** 2026-09-02
- **Recorded by:** `GOV-1C` (orchestrator-authorized contract-owner governance
  round at Wave 1 closeout)
- **Implemented by:** `apps/research-worker` (`WP-130`) and `apps/data-gateway`
  (`WP-120`) — **already shipped and merged**; this record ratifies the
  convention so `apps/trader`, `apps/control-api`, and later runnable apps
  follow it without re-litigation (`WP-130` `follow_up` 1)
- **Supersedes / Superseded by:** none

## Context

This repository's packages point `main` at TypeScript source, emit no `dist`,
and use `.js` relative specifiers inside `.ts` sources (the `NodeNext`
convention). That is the right shape for a workspace whose gates typecheck and
test source directly — and it means **`tsc && node dist/…` does not produce a
runnable process for any app that imports a workspace package**: the compiled
output's workspace imports resolve into neighboring packages' *source* trees,
which Node will not load as `.ts`.

This is not predicted; it was **observed twice, independently, and reproduced
by reviewers**:

- `WP-130` deviation 2: the `tsc` form of `apps/research-worker` **crashed**
  with `ERR_MODULE_NOT_FOUND` on `packages/storage-parquet/src/constants.js`.
  `apps/ops-cli`'s `tsc` build survives only because its executable path
  imports no workspace package.
- `WP-120` deviation 1 reproduced the same wall for `apps/data-gateway` and
  added the second finding: an **ESM** bundle of a CommonJS-only dependency
  (`ioredis`, reached through `packages/event-bus`) built cleanly and **died
  at startup** with `Dynamic require of "events" is not supported`;
  externalizing it failed differently (`ERR_MODULE_NOT_FOUND` under pnpm's
  strict layout), and declaring it as the app's own dependency would have put
  a Redis client in the manifest of a package that never imports one — the
  shape F8 exists to prevent. `--format=cjs` bundled it correctly with no
  dependency-graph fiction. Both failures were observed, not predicted.

## Decision

1. **A workspace TypeScript app that must RUN ships an app-local esbuild
   bundle.** The app — and only the app — declares `build` (an `esbuild
   src/main.ts --bundle --platform=node --target=node24` invocation writing
   into the app's own `dist/`) and `start` (typecheck, build, run the bundle)
   scripts, and declares `esbuild` as its own `devDependency`. Nothing is
   imposed on any library package, and no root build infrastructure exists.
2. **ESM is the default output; CJS is permitted where a CJS-only dependency
   forces it, and the deviation is disclosed.** `apps/research-worker` is the
   ESM precedent (`--format=esm`, `dist/main.mjs`); `apps/data-gateway` is the
   CJS precedent (`--format=cjs`, `dist/main.cjs`), forced by `ioredis` as
   reproduced above. An app choosing CJS states which dependency forces it, in
   its handoff or manifest comment, so the choice remains evidence-backed.
3. **Bundling changes packaging, never the dependency rules.** The
   dependency-direction contract is evaluated over declared manifests and
   *source* (`dependency-direction.md` §6 reads source, not bundles), so a
   bundle neither launders an F6/F8-forbidden dependency into an app nor
   exempts one; and no app may declare a dependency it does not import merely
   to satisfy a bundler (the exact fiction `WP-120` refused).
4. **Departures need an ADR, not a preference.** Adopting per-package `dist`
   builds with conditional `exports`, a runtime loader, or any root-owned
   build pipeline is a repository-wide change to how every later app ships,
   and supersedes this record. Until then, "bundle per runnable app" is the
   answer, and `apps/ops-cli` may keep its `tsc` build only while its
   executable path imports no workspace package — the moment it does, it
   follows this convention.

## Consequences

- `apps/trader` and every later runnable app copy a settled, twice-reproduced
  pattern instead of rediscovering the wall (`WP-130` `follow_up` 1's explicit
  request; `WP-120` reproduced it once already).
- The cost is bundling: a bundle is a build artifact whose contents are not
  the source tree, so runtime stack traces and any future license/audit
  tooling see bundled output. Mitigations already shipped: the bundle is
  built from typechecked source at `start`, and `WP-140`'s soak smoke runs
  the real bundle.
- esbuild becomes a per-app build dependency (it is already in the tree via
  vitest and allowlisted to build in `pnpm-workspace.yaml`); pinning or
  upgrading it is each app's ordinary dependency review, and an upgrade that
  changes emitted bytes matters only to apps, not to any checksummed archive
  (the archive writers are library code, not bundles).
- **No code changes.** Both shipped apps already conform; `schemaVersion` is
  untouched (no domain contract is involved at all).

## Evidence

- `apps/research-worker/package.json` and `apps/data-gateway/package.json` —
  the shipped `build`/`start` scripts and app-local `esbuild` devDependency
  (read 2026-09-02: ESM and CJS respectively, both `--target=node24`).
- `docs/handoffs/WP-130.md` deviation 2 and `follow_up` 1 (the observed
  `ERR_MODULE_NOT_FOUND` crash; the request for this convention).
- `docs/handoffs/WP-120.md` deviation 1 (the observed ESM/`ioredis` startup
  death, the externalization failure, the F8 reasoning; "Both failures were
  observed, not predicted"), reviewed and left standing across its
  remediation rounds.
- `docs/contracts/dependency-direction.md` §6 (the check reads manifests and
  source; F6/F8) — why decision 3 holds by construction.
- Handoff §2 (TypeScript on Node 24), §5 layout (apps are composition roots).
- **Venue facts:** none — this record asserts no venue behavior.
- **Safety:** no run-mode default is touched (ADR-010); `start` scripts gate
  nothing live and the apps remain PAPER-bounded by configuration.

## Evidence addendum (2026-09-28): a third pattern — ESM with a `createRequire` banner (`BUNDLE-1`)

Append-only; nothing above this line changed.

Recorded by `DOCS-1`. It answers `BUNDLE1-LOWS` (1), the review LOW
`B1-R1-ADR018-EVIDENCE` in `docs/handoffs/BUNDLE-1.md`. Like the
repository's other records, it cites this record's Decision items 1-4 as
§1-§4.

**What.** `apps/trader` ships a third pattern, beside the two in §2.
It is ESM (`--format=esm`, `dist/main.mjs`) plus one esbuild banner in the
app's own `build` script (`apps/trader/package.json`; `BUNDLE-1`, merged
`fd30e5f`):

`import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);`

esbuild's `__require` shim then finds a real `require` for the Node
built-ins that `ioredis` loads. The forcing dependency is `ioredis`, reached
through `packages/event-bus`. That is the same dependency, and the same
failure (`Dynamic require of "events" is not supported`), that `WP-120`
observed for `apps/data-gateway` (Context above). Before `BUNDLE-1`, the
trader's plain ESM bundle died at load with exactly that error, which was
blocker M18.

**Why CJS was measured and rejected for the trader.** `BUNDLE-1` measured
each step in scratch at its base, `1ad2a36` (`docs/handoffs/BUNDLE-1.md`):

1. **Top-level await.** A plain `--format=cjs` build fails, because the
   trader's entry awaits `startup()` at module top level
   (`apps/trader/src/main.ts:655` at `1ad2a36`, `:539` at `ae25450`).
2. **The migrations loader.** With the await wrapped in a function, the
   bundle crashes at load with `TypeError: Invalid URL`. The cause is
   `packages/storage-postgres/src/migrations/loader.ts:33`, which evaluates
   `new URL("../../../../db/migrations", import.meta.url)` at load: the
   package's index re-exports `migrations/`, and in CJS `import.meta.url` is
   undefined.
3. **The entry guard.** With `import.meta.url` shimmed, the trader's entry
   guard never fires. The guard is keyed on the file name
   (`import.meta.url.endsWith("/main.mjs")`), and the file is now
   `main.cjs`. So the process exits 0 having done nothing.

Only a variant that also edited the guard and renamed the file to
`main.cjs` worked. The banner needed one flag.

**The pin.** `test/unit/tooling/app-bundles-load.test.ts` now builds and runs
every runnable app's bundle: `apps/trader`, `apps/data-gateway`,
`apps/control-api`, `apps/backtest-cli` and `apps/research-worker`.

- Each bundle is built with the app's own `build` script.
- Each must reach its own refusal or usage line with an exact exit code,
  never a load crash.
- The pin fails if an app whose `build` starts with `esbuild` is missing
  from its list. `apps/ops-cli` keeps its `tsc` build under §4, and
  is not listed.

**Latent residuals.** These are `BUNDLE1-LOWS` (2) and (3). They are queued,
not fixed:

- **The migrations directory.** Inside a bundle,
  `DEFAULT_MIGRATIONS_DIRECTORY` resolves relative to the bundle file, not
  to `packages/storage-postgres`. It is latent: no app source reads it. The
  migrations are read only by `packages/storage-postgres`'s own migrate CLI
  and runner.
- **Renamed bundles.** Three entry guards test how the bundle's
  `import.meta.url` ends: the trader's for `/main.mjs`, `apps/control-api`'s
  for `main.mjs` and `apps/backtest-cli`'s for `.mjs`. A rename that makes a
  guard's test false exits 0 silently. A rename that keeps it true still
  runs. Measured for this addendum at `ae25450`, with each bundle built by
  its app's own `build` script:
  - the trader exits 0 with no output as `renamed-trader.mjs` and as
    `renamed-main.mjs`. As `main.mjs` in another directory, it still
    refuses with exit 78;
  - control-api exits 0 with no output as `renamed-control-api.mjs`. As
    `renamed-main.mjs`, or with `CONTROL_API_MAIN=1` set, it still refuses
    with exit 78;
  - backtest-cli still prints its usage with exit 2 as
    `renamed-backtest.mjs`. Only a rename that drops `.mjs`, such as
    `renamed-backtest.js`, exits 0 with no output.

  `apps/research-worker`'s guard compares `import.meta.url` with
  `file://${process.argv[1]}`, so a rename does not silence it
  (`renamed-research.mjs` still refuses with exit 1). A path containing a
  space does: `dir with space/main.mjs` exits 0 with no output, as
  `docs/handoffs/BUNDLE-1.md` ("known_risks") warned for URL-escaped
  characters. `apps/data-gateway` has no entry guard, and still refuses with
  exit 1 as `renamed-gateway.cjs`. The pin keeps each basename, and asserts
  an exact exit code plus a refusal line.

**No decision of this record changes.**

- **§1 is untouched.** The banner is one flag in the app-local esbuild
  `build`.
- **§4 is untouched.** There is no runtime loader, no per-package `dist` and
  no root build pipeline.
- **§2 is unchanged.** ESM stays the default. §2's disclosure rule is
  satisfied by this addendum, which names the forcing dependency in the ADR
  itself. `BUNDLE-1` first stated it in its round record and in the pin's
  header, because `docs/**` was outside its grant.
- **§3 is unaffected.** `apps/trader` declares no Redis client. The banner
  changes the bundle, not a manifest.

**Venue facts:** none. **Safety:** no run-mode default is touched. The
shipped trader bundle refuses an unsafe environment with exit 78, and the
pin asserts that refusal.
