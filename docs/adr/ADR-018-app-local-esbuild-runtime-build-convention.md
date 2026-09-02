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
