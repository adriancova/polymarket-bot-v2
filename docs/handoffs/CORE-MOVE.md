# CORE-MOVE — the H8 track, round 3: the paper core moves into `packages/trading-core` (move only)

- **Package:** `CORE-MOVE`, a bounded `WP-230` follow-up round (ADR-022 D8),
  run under the grant `docs/handoffs/H8-GOV.md` records ("The `CORE-MOVE`
  grant", binding) and the orchestrator's ruling on pruning
  (`IMPLEMENTATION_STATUS.md`, row `CORE-MOVE`, authorized 2026-09-28).
- **Base:** `ac0b12f` (`main`, with `H8-GOV` and `DEPCHECK-1` merged).
  **Branch:** `core-move`. **Date:** 2026-09-28. **Exclusive window:** no other
  round was in flight on any path below.
- **Review:** an independent Codex review (the hardening loop) gates the merge,
  and a green GitHub Actions run is the orchestrator's step. The implementer
  did not review its own work. **This round is not marked complete.**
- **What it is:** a MOVE. The `createPaperTrader` / `CoreLoop` import closure
  (25 files, 11,218 lines, re-measured at `ac0b12f`) and its 14 colocated tests
  move byte-identical to `packages/trading-core/src`. No comment or code in a
  moved file changes. The two venue tests change one import specifier each, as
  the grant names. Stale comments in moved files (for example
  `ports.ts`'s "consumed only from layer 3") are left for `BACKTEST-2`, so every
  rename stays R100.
- **Safety:** unchanged. `safety.ts` and `config.ts` move byte-identical, so the
  core keeps its PAPER ceiling (ADR-022 D6). `MAX_RUN_MODE=PAPER`,
  `ALLOW_REAL_ORDERS=false` and both live-micro caps at `0` are untouched. There
  is no wallet, signer, credential or real order anywhere in this change. No
  `eslint-disable`, `.skip`, `.only` or `ts-ignore` was added.

---

## The move map

Every pair below is checked by blob hash (`git rev-parse ac0b12f:<old>` against
`git rev-parse HEAD:<new>`). `R` pairs are byte-identical renames (R100). `R1`
pairs change exactly one line, the `./main.js` → `./venue-policy.js` specifier.
The `C` pair is a byte-identical copy (C100 under `-C -C`); the old file stays
as the `/testing` facade.

| Kind | Old path (`ac0b12f`) | New path |
| --- | --- | --- |
| R | `apps/trader/src/accounting.ts` | `packages/trading-core/src/accounting.ts` |
| R | `apps/trader/src/allocation.ts` | `packages/trading-core/src/allocation.ts` |
| R | `apps/trader/src/basket-execution.ts` | `packages/trading-core/src/basket-execution.ts` |
| R | `apps/trader/src/cancels.ts` | `packages/trading-core/src/cancels.ts` |
| R | `apps/trader/src/config.ts` | `packages/trading-core/src/config.ts` |
| R | `apps/trader/src/event-door.ts` | `packages/trading-core/src/event-door.ts` |
| R | `apps/trader/src/fills.ts` | `packages/trading-core/src/fills.ts` |
| R | `apps/trader/src/folds.ts` | `packages/trading-core/src/folds.ts` |
| R | `apps/trader/src/halt.ts` | `packages/trading-core/src/halt.ts` |
| R | `apps/trader/src/health.ts` | `packages/trading-core/src/health.ts` |
| R | `apps/trader/src/instances.ts` | `packages/trading-core/src/instances.ts` |
| R | `apps/trader/src/loop.ts` | `packages/trading-core/src/loop.ts` |
| R | `apps/trader/src/market-state.ts` | `packages/trading-core/src/market-state.ts` |
| R | `apps/trader/src/order-lifecycle.ts` | `packages/trading-core/src/order-lifecycle.ts` |
| R | `apps/trader/src/orders.ts` | `packages/trading-core/src/orders.ts` |
| R | `apps/trader/src/pipeline.ts` | `packages/trading-core/src/pipeline.ts` |
| R | `apps/trader/src/pnl-snapshot-key.ts` | `packages/trading-core/src/pnl-snapshot-key.ts` |
| R | `apps/trader/src/ports.ts` | `packages/trading-core/src/ports.ts` |
| R | `apps/trader/src/projection.ts` | `packages/trading-core/src/projection.ts` |
| R | `apps/trader/src/queue.ts` | `packages/trading-core/src/queue.ts` |
| R | `apps/trader/src/reference-state.ts` | `packages/trading-core/src/reference-state.ts` |
| R | `apps/trader/src/reservations.ts` | `packages/trading-core/src/reservations.ts` |
| R | `apps/trader/src/safety.ts` | `packages/trading-core/src/safety.ts` |
| R | `apps/trader/src/time.ts` | `packages/trading-core/src/time.ts` |
| R | `apps/trader/src/trader.ts` | `packages/trading-core/src/trader.ts` |
| R | `apps/trader/src/allocation.test.ts` | `packages/trading-core/src/allocation.test.ts` |
| R | `apps/trader/src/basket-execution.test.ts` | `packages/trading-core/src/basket-execution.test.ts` |
| R | `apps/trader/src/config.test.ts` | `packages/trading-core/src/config.test.ts` |
| R | `apps/trader/src/event-door.test.ts` | `packages/trading-core/src/event-door.test.ts` |
| R | `apps/trader/src/folds.test.ts` | `packages/trading-core/src/folds.test.ts` |
| R | `apps/trader/src/halt.test.ts` | `packages/trading-core/src/halt.test.ts` |
| R | `apps/trader/src/loop-long-run.test.ts` | `packages/trading-core/src/loop-long-run.test.ts` |
| R | `apps/trader/src/loop-refused-plan.test.ts` | `packages/trading-core/src/loop-refused-plan.test.ts` |
| R | `apps/trader/src/order-lifecycle.test.ts` | `packages/trading-core/src/order-lifecycle.test.ts` |
| R | `apps/trader/src/queue.test.ts` | `packages/trading-core/src/queue.test.ts` |
| R | `apps/trader/src/seams.test.ts` | `packages/trading-core/src/seams.test.ts` |
| R | `apps/trader/src/time.test.ts` | `packages/trading-core/src/time.test.ts` |
| R1 | `apps/trader/src/loop-order-lifecycle.test.ts` | `packages/trading-core/src/loop-order-lifecycle.test.ts` (:106) |
| R1 | `apps/trader/src/order-provenance.test.ts` | `packages/trading-core/src/order-provenance.test.ts` (:44) |
| C | `apps/trader/src/testing/index.ts` | `packages/trading-core/src/testing/index.ts` |

What stays in `apps/trader/src`: `main.ts`, `main.test.ts` (unchanged),
`pump.ts`, `pnl-observation.ts`, `health-server.ts`, `adapters/*`,
`loop-folds.test.ts`, and the two facades `index.ts` and `testing/index.ts`.
No per-module shim is left at any old path.

## Every edit that is not a move

1. **`packages/trading-core/package.json`** (new): name
   `@polymarket-bot/trading-core`, private, ESM; `exports` `.` →
   `./src/index.ts` and `./testing` → `./src/testing/index.ts`; `typecheck`
   script `tsc --noEmit`; 13 `workspace:*` dependencies (every workspace package
   the moved source imports) plus `zod`; devDependencies `typescript` and
   `vitest` (the 14 moved tests import `vitest`).
2. **`packages/trading-core/tsconfig.json`** (new): a byte copy of
   `packages/simulation/tsconfig.json`.
3. **`packages/trading-core/src/index.ts`** (new): a new header comment, then
   the 23 closure export blocks of `ac0b12f:apps/trader/src/index.ts` verbatim
   and in order, then two blocks: `createExecutionPolicy` / `type VenueWiring`
   from `./venue-policy.js`, and `unreplacedPnlSnapshotProblem` from
   `./pnl-snapshot-key.js` (imported by `adapters/postgres-store.ts`; the
   trader's index never exported it).
4. **`packages/trading-core/src/venue-policy.ts`** (new): a 16-line header (a
   doc comment and the imports the block needs: `type PlannedOrderView`,
   `type TimeInForce` from `@polymarket-bot/simulation`, `type PaperTrader`
   from `./trader.js`), then `ac0b12f:apps/trader/src/main.ts` lines 155-217
   byte for byte.
5. **The two venue tests** (`R1` above): one specifier each.
6. **`apps/trader/src/main.ts`**:
   - five closure specifiers re-pointed to `@polymarket-bot/trading-core`;
   - `type PlannedOrderView,` and `type TimeInForce,` removed from the
     `@polymarket-bot/simulation` import (only the block used them;
     `PaperTrader` is still used, so it stays);
   - lines 155-218 removed (the block and the blank line after it);
   - three lines added after the last import:
     `import { createExecutionPolicy, type VenueWiring } from "@polymarket-bot/trading-core";`,
     a blank line, and `export { createExecutionPolicy, type VenueWiring };`.
     So `main.test.ts` and the paper-trader suite keep importing `./main.js`.
7. **`apps/trader/src/index.ts`**: the 23 closure blocks' specifiers
   re-pointed to `@polymarket-bot/trading-core`. The header and the three
   blocks for staying files (`health-server`, `pnl-observation`, `pump`) are
   unchanged.
8. **`apps/trader/src/testing/index.ts`**: now a facade, a doc comment and
   `export * from "@polymarket-bot/trading-core/testing";`.
9. **Specifier-only edits** in `pump.ts`, `pnl-observation.ts`,
   `health-server.ts`, `adapters/postgres-registration.ts`,
   `adapters/postgres-store.ts`, `adapters/redis-feed.ts` and
   `loop-folds.test.ts`: each `./X.js` / `../X.js` with `X` in the closure
   becomes `@polymarket-bot/trading-core`. No import is merged, split or
   reordered. `loop-folds.test.ts` keeps `./health-server.js`,
   `./pnl-observation.js` and `./testing/index.js` (the facade).
10. **`apps/trader/package.json` `dependencies`**: adds
    `@polymarket-bot/trading-core`, and removes exactly the five workspace
    dependencies no staying source file imports, measured (a TypeScript
    `preProcessFile` scan of every file under `apps/trader/src`, including
    type-only imports and `vi.mock` specifiers, and a `tsc --traceResolution`
    run): `@polymarket-bot/decimal`, `execution-planner`, `features`,
    `order-book`, `strategy-static-bracket`. Every kept dependency is imported:
    `capital-allocator`, `domain`, `risk` and `strategy-sdk` by
    `loop-folds.test.ts` (and `risk` by `health-server.ts`), `event-bus`,
    `ledger`, `pnl`, `simulation`, `storage-postgres`, `strategy-runtime`,
    `zod` by production files.
11. **`pnpm-lock.yaml`**: the `apps/trader` importer block (the five links
    removed, the core link added) and a new `packages/trading-core` importer
    block. Written by `pnpm install --offline --lockfile-only`; every hunk lies
    inside `importers:`, and `packages:` and `snapshots:` are byte-identical.
12. **`test/unit/trader`**:
    - `health-realized-pnl.test.ts`: the :19 specifier, and the :214 path
      string `apps/trader/src/health.ts` → `packages/trading-core/src/health.ts`
      in "the source files on the path contain no Number(...), parseFloat or
      parseInt". The scan still reads the real `health.ts`;
    - `health-server.test.ts`: the :20 specifier;
    - `memory-store-pnl-snapshot-key.test.ts`: the :55, :56 and :63 specifiers;
    - `query-boundary-cast-scan.test.ts`: a second scan root `CORE_SRC`
      (`packages/trading-core/src`) beside `TRADER_SRC`, and each file labelled
      relative to its own root (`rootOf`). Labels such as `loop.ts` and
      `adapters/postgres-store.ts` are unchanged.
13. **`test/unit/tooling/dependency-direction.test.ts`**, the three granted
    anchors (re-found by content; DEPCHECK-1 moved them):
    - the `removeDependencies` comment (:224-230 at base) and the fixture of
      "does not treat a strategy class entry matching zero packages as an
      error" (:658 at base): the dangling dependency to drop is now
      `packages/trading-core`'s; `apps/trader` no longer declares the strategy;
    - one `expect(layerOf("packages/trading-core")).toBe(1)` inside
      "classifies every workspace package into exactly one §2 layer" (:442-458
      at base), so no test is added;
    - the pin in "keeps the shipping contract valid under all of the above"
      (:1017-1030 at base): S0..S18.
14. **`docs/contracts/dependency-direction.md`**, the activation: the §2 fence
    line and paragraph, rows S8-S18 (verbatim, leading `| ` restored), the two
    S15 sentences, the PENDING subsection replaced by a dated DONE note that
    keeps the grant verbatim, and a dated §6 graph note with the measured
    counts.
15. **This record.**

## Anchors re-verified at `ac0b12f`, by content

| Grant anchor (`a8a3a63`) | At `ac0b12f` | Content |
| --- | --- | --- |
| closure "25 files" | 25 files, 11,218 lines | the same set, incl. `pnl-snapshot-key.ts` |
| `loop-order-lifecycle.test.ts:106`, `order-provenance.test.ts:44` | :106, :44 | `import { createExecutionPolicy, type VenueWiring } from "./main.js";` |
| `main.ts` :155-217 | :155-217 | `/** The holder the venue's policy reads…` through `createExecutionPolicy`'s closing `}` |
| `health-realized-pnl.test.ts` :19, :214 | :19, :214 | the `health.js` import; the `"apps/trader/src/health.ts",` path string |
| `health-server.test.ts` :20 | :20 | the `health.js` import |
| `memory-store-pnl-snapshot-key.test.ts` :55, :56, :63 | :55, :56, :63 | `pnl-snapshot-key.js`, `ports.js`, `time.js` imports |
| `query-boundary-cast-scan.test.ts` :121 | :121 | `const TRADER_SRC = …` |
| tooling test :224-230, :442-458, :658, :1017-1030 | :224-230, :442-458, :658, :1017-1030 | the comment, the `layerOf` test, the fixture, the pin |

## Evidence

All proofs below were run by the implementer. The verifier re-runs them.

### Proof 1 — blob-hash equality

A loop over the 40 pairs: **38 blob-equal, 0 mismatches**. The two `R1` pairs
differ by exactly the one line each:

```text
packages/trading-core/src/loop-order-lifecycle.test.ts (1+/1-):
  106c106
  < import { createExecutionPolicy, type VenueWiring } from "./main.js";
  > import { createExecutionPolicy, type VenueWiring } from "./venue-policy.js";
packages/trading-core/src/order-provenance.test.ts (1+/1-):
  44c44
  < import { createExecutionPolicy, type VenueWiring } from "./main.js";
  > import { createExecutionPolicy, type VenueWiring } from "./venue-policy.js";
```

Completeness: `git diff --no-renames --diff-filter=D` finds 39 paths deleted
from `apps/trader/src`, and all 39 are old paths in the map. The map's only old
path that is not deleted is `apps/trader/src/testing/index.ts` (the copy).

### Proof 2 — rename detection

- `git diff -M100% --name-status ac0b12f HEAD`: 37 `R100` (25 closure files
  and 12 tests).
- `git diff -M --name-status`: the two venue tests are `R099`, and `--numstat`
  gives `1 1` for each.
- `git diff -C -C --name-status`: `C100 apps/trader/src/testing/index.ts
  packages/trading-core/src/testing/index.ts`.

### Proof 3 — specifier-normalized diffs of the staying files

Every `from "<specifier>"` rewritten to one placeholder in both versions:
empty for `adapters/postgres-registration.ts`, `adapters/postgres-store.ts`,
`adapters/redis-feed.ts`, `health-server.ts`, `index.ts`,
`loop-folds.test.ts`, `pnl-observation.ts`, `pump.ts`,
`test/unit/trader/health-server.test.ts` and
`memory-store-pnl-snapshot-key.test.ts`. The residues are the granted ones:
`health-realized-pnl.test.ts` :214 (the path string), `main.ts` (proof 4),
and the cast-scan test's roots and labels (edit 12).

### Proof 4 — the `main.ts` block

- `cmp`: `ac0b12f:apps/trader/src/main.ts` lines 155-217 equal
  `packages/trading-core/src/venue-policy.ts` lines 17-79 (63 lines).
- A byte reconstruction: base `main.ts` with (1) the five specifier
  re-points, (2) lines 107-108 removed, (3) lines 155-218 removed and (4) the
  three lines inserted after :127 equals HEAD `main.ts`: `True`.
- `git diff --color-moved=plain` marks all 64 removed block lines as moved.

### Proof 5 — the core's `index.ts`

Its first 23 export blocks equal `ac0b12f:apps/trader/src/index.ts`'s 23
closure blocks, verbatim and in order (`True`). The two extra blocks are the
venue-policy block and `unreplacedPnlSnapshotProblem`.

### Proof 6 — public surface (TypeScript compiler API)

`checker.getExportsOfModule` over `apps/trader/src/index.ts` and
`apps/trader/src/testing/index.ts`, following every alias hop and recording
the resolved symbol's value/type meaning, whether any hop is a type-only
export, and the declaring file's basename. **195 entries (188 for `.`, 7 for
`./testing`), identical at `ac0b12f` and HEAD** (`diff` empty). A mutation
(`HaltController` → `type HaltController` in the facade) changes exactly that
line, so the comparison sees kinds.

### Proof 7 — test counts and name inventories

Every suite run through its official script with a JSON reporter at
`ac0b12f` and at HEAD. Inventory = (file, full name, status), base paths
mapped through the move map:

| Suite | `ac0b12f` | HEAD | Inventory |
| --- | --- | --- | --- |
| root (`pnpm run test`) | 348 / 7594 | 348 / 7594 | equal |
| e2e (`pnpm run test:e2e`) | 8 / 206 | 8 / 206 | equal |
| replay (`pnpm run test:replay`) | 3 / 17 | 3 / 17 | equal |
| control-api `test:integration` | 10 / 87 | 10 / 87 | equal |
| paper-trader `test:integration` (Docker 29.1.2) | 17 / 138 | 17 / 138 | equal |

The root inventory includes the `DEPCHECK-1` tooling tests.

### Proof 8 — goldens

`git diff --exit-code ac0b12f HEAD -- test/replay-golden` is empty, and
`git status --porcelain test/replay-golden` is empty after the e2e and replay
runs.

### Proof 9 — no narrowing

- The cast-scan census (the test's own scanning code, run over each tree):
  43 assertions at both; the sorted (label, text, target, classification,
  query boundary) list is deep-equal. With line numbers, the one difference is
  `main.ts`'s `JSON.parse(text) as unknown` (widening), at :613 on base and
  :550 at HEAD, because the cut removed 63 lines above it net. The scan reads
  34 files at base and 37 at HEAD: every base label, plus the core's
  `index.ts`, `testing/index.ts` and `venue-policy.ts`. No suppression comment
  at either.
- The no-float scan in `health-realized-pnl.test.ts` reads
  `packages/trading-core/src/health.ts`, the real module.
- No file exists at any of the 39 old paths of a moved module.

### Proof 10 — the dependency check

`pnpm run check:deps` passes under `DEPCHECK-1`'s rules: **35 packages, 89
declared workspace edges** (base: 34 / 80). `--json`: `ok: true`, allowlist
exactly `S0`..`S18`, `layer(packages/trading-core) = 1`, no violation. There is
no §2.2 row: the core imports no `node:` module. Every S8-S18 row matches a
declared edge (the stale-row `CHK` passes). The edge delta, from the check's
own edge lists: +11 same-layer (S8-S18), +2 downward to layer 0 (`decimal`,
`domain`), +1 `apps/trader` → `packages/trading-core`, −5 pruned.

### Proof 11 — build and lint

- `pnpm run typecheck` exit 0 (`pnpm -r run typecheck`, including
  `packages/trading-core` and the paper-trader suite's tsconfig, then
  `test/tsconfig.json`, `test/e2e` and the soak recorder).
  `tsc -p test/integration/control-api/tsconfig.json` exit 0.
- `pnpm run lint` exit 0.
- `pnpm --filter @polymarket-bot/trader build` exit 0 (`dist/main.mjs`,
  2.8 MB). Run with the four `AGENTS.md` defaults weakened and a scrubbed
  environment, the bundle exits 78 with `REFUSING TO START` and all four
  violation codes. `test/unit/tooling/app-bundles-load.test.ts` passes inside
  the root suite. Bundle byte identity is not required and was not checked.

### Proof 12 — lockfile

Six hunks, all inside `importers:` (`apps/trader` lines 175-226 and the new
`packages/trading-core` block at 698-749). Everything before `importers:` and
everything after it (`packages:`, `snapshots:`, 3,221 lines) is byte-identical.
CI's `pnpm install --frozen-lockfile` is the final proof.

### Proof 13 — scope

`git diff --name-only ac0b12f HEAD` (default rename detection) is 63 paths:
44 under `packages/trading-core/`, 11 modified files under `apps/trader/` (the
39 deleted paths show as renames), `pnpm-lock.yaml`, the four
`test/unit/trader` files, the tooling test, the contract and this record. No
path is outside the grant. The suite aliases and `tsconfig.lint.json` are
unchanged: no gate needed them.

### Proof 14 — gates

Run on the working tree that became this commit, which differs from it only by
this record. Each exits 0:

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm run lint` | exit 0 |
| `pnpm run check:deps` | exit 0, 35 packages / 89 edges |
| `pnpm run test` | 348 files / 7594 tests passed |
| `pnpm run test:e2e` | 8 / 206 passed |
| `pnpm run test:replay` | 3 / 17 passed |
| control-api `test:integration` | 10 / 87 passed |
| trader `test:integration` (Docker) | 17 / 138 passed |

The second e2e, replay and paper-trader runs, and the re-run of every gate on
the commit itself, are recorded in the implementer's handoff.

## Decisions and disclosures

1. **`vitest` in the core's devDependencies.** The moved tests import it.
   Most packages with colocated tests declare it (`packages/domain`,
   `packages/ledger`, …); `packages/observability` does not. The lockfile
   version string is the one every other importer already resolves, so no
   `packages:` or `snapshots:` entry changed. `@types/node` is not declared:
   the core imports no Node module.
2. **The venue-policy header.** The block's first comment says "See the
   module header", which meant `main.ts`'s. The block cannot change, so the new
   file's own header says which module header that is.
3. **The `unreplacedPnlSnapshotProblem` block** is appended after the
   venue-policy block, not placed among the verbatim blocks, so the verbatim
   prefix stays exactly the base's.
4. **The contract's S15 sentences.** The first is appended inside the
   H8-GOV settled note, before its closing `)*`. The second is appended at the
   end of §4's execution-venue bullet, after that bullet's settled note.
5. **Time-qualified text stays verbatim.** The §2 paragraph and row S18 say
   what the check did not do "at `a8a3a63`". `DEPCHECK-1` has since added
   F16's relative half and the stale-row `CHK`. The sentences are still true
   as dated statements, and the grant requires the text verbatim. Updating
   them is a docs follow-up.
6. **Local links.** The workspace links are hand-made (gitignored). The five
   pruned `apps/trader/node_modules/@polymarket-bot/*` links were left in
   place, because the worktree's `node_modules` is hardlinked with the main
   checkout. So a local run cannot prove that nothing needs them. The static
   scan and `tsc --traceResolution` (no `apps/trader/src` file resolves any of
   the five) prove it, and CI's frozen install removes them.

## Follow-ups (outside this grant)

- `BACKTEST-2`: make `apps/backtest-cli` build the core, fix the stale
  comments in moved files (for example `ports.ts`'s "consumed only from
  layer 3"), and retire the copies of the venue wiring (ADR-022 D5).
- Residual rows and packets that name `apps/trader/src/<closure file>`
  (`SNAP1-KEYSET`, `FOLD-*`, `TRDR4-*`, `SIM1-BASKET`, `RECON2-DURABLE`,
  `BOOT1-R6`, `UNIV4-R2`, `TRDR-3-FU1`, …) need re-pathing to
  `packages/trading-core/src` when they are next dispatched. Cherry-pick and
  merge follow renames; plain `git apply` does not.
- A docs round: the dated statements in decision 5, and the history
  references to old paths in READMEs and comments outside this grant.
- A later round retires the two facades (ADR-022 D7).
