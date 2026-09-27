# LINT-1: no floating promise anywhere (`CI1-L2`)

Branch `lint-1`, one commit `8ebf8e0` on base `3bfe56a`, merged into `main` as `e3a3389` (`--no-ff`) on 2026-09-26.

- **Authorization.** The user authorized the round the same day ("can you handle the 9 follow ups pls?"). It is the last of the nine follow-ups.
- **Protected file.** `eslint.config.mjs` is protected. The user granted this rule's block and its header comment only.
- **Scope.** A read-only census found zero violations in all 999 files. After seeing that, the user widened the scope from tests only to tests AND production.
- **Process.** The user's HARDENING LOOP: an Opus implementer, gates run outside any sandbox, then Codex gpt-6-astra verification. Codex ACCEPTED on round 1 with no findings.

## Outcome
- **`eslint.config.mjs`: one typed block.** It turns on `@typescript-eslint/no-floating-promises` with default options (`void` stays the explicit opt-out). It covers `test/**/*.ts`, `test/**/*.mjs`, `packages/**/src/**/*.ts`, `apps/**/src/**/*.ts`, `tools/*.mjs` and the config file itself. The header comment now describes this block and no longer says "deferred".
- **`tsconfig.lint.json` (new, repository root).**
  - It extends the base config with `noEmit` and `allowJs`.
  - Its `paths` are the union of all 40 aliases in the 49 tracked tsconfigs.
  - Its `include` equals the block's globs.
  - `tsc -p` over it gives 0 errors, and all 4,636 import specifiers resolve.
  - A file the block lints but the program lacks fails lint loudly.
- **Drift pin: `test/unit/tooling/lint-typed-program.test.ts`.** 14 tests, about 0.5 s; it builds no TypeScript program. It fails when:
  - the program's `paths` stop being a superset, with identical targets, of every tsconfig's;
  - the program's `include` and the block's globs diverge;
  - any tracked file ESLint lints does not get the rule typed by this program. This third check goes beyond the packet. It caught a drift that `pnpm run lint` alone passed.
- **The rule fires.** It is proven on:
  - the CI-1 probe;
  - un-awaited `.resolves`, `.rejects` and `expect.poll`;
  - one planted file in every tsconfig group, test and production;
  - promises typed through aliases.

  `void` passes. The implementer also reproduced the silent skip the pin guards: with an alias removed, a floating promise goes unreported.
- **Violations: 0.** No source file changed. `no-misused-promises` also reports 0 but is NOT enabled: it costs +29% time and about 290 MB of heap.

## Cost

| `pnpm run lint` | wall time | peak heap |
| --- | --- | --- |
| before | 7.6–7.9 s | ~555 MB |
| after, local | 14.6–14.9 s | ~2.2 GB |
| after, GitHub runner | 24 s | — |

After the change it still passes with the heap capped at 2048 MB, 1536 MB and 1280 MB, and runs out of memory at 1024 MB. CI needs no heap flag.

## Review (Codex gpt-6-astra r1): ACCEPT, no findings
- **Coverage.** Its independent census found 1,002 in-scope files with zero coverage gaps. It planted probes in 81 files and got exactly the 86 expected errors, across all test suites, colocated tests and all 34 package and app groups.
- **Restoration.** It confirmed byte-for-byte restoration of all 1,351 tracked files.
- **Residuals it recorded.** Inherent to the rule: `void` opt-outs, and promises typed as `any`. Not guarded: import resolution beyond `paths`, because CI does not compile `tsconfig.lint.json`. That one is queued as `LINT1-TSC`.

## Evidence
- Verification gates at `8ebf8e0`, outside any sandbox: typecheck 0; lint 0 (also under `--max-old-space-size=2048`, max RSS about 2.0 GB); check:deps PASS; unit 335 / 7267; e2e 7 / 157; replay 3 / 17.
- GitHub Actions: PR #5 run `36295096276`, all three jobs green; lint took 24 s.
- Post-merge on `main` `e3a3389` (tree byte-identical to `8ebf8e0`): lint 0.

## commit_sha
`8ebf8e045c19358d46fc973fda46a995fb36ec22` (branch `lint-1`), merged as `e3a3389`.

---

# Appendix: implementer handoff, r0 (verbatim)

# LINT-1 r0 — implementer handoff

## plan (written before any edit)

Base: `3bfe56a` on branch `lint-1`, worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-lint-1`
(clean). Tools at base: eslint 9.39.5, typescript-eslint 8.67.0, typescript 5.9.3, node 24.13.0.
`eslint .` lints 1003 files at base, all tracked: 552 `packages/**/src/**/*.ts`, 133
`apps/**/src/**/*.ts`, 314 `test/**/*.ts`, 2 `test/soak/recorder/*.mjs`, `tools/check-dependency-direction.mjs`
and `eslint.config.mjs`. No tracked `.js/.cjs/.mts/.cts/.tsx`, and no packages/apps file outside `src/`.

1. Measure BEFORE (clean base): `pnpm run lint` wall time x3, peak heap (census `heap-sampler.cjs`
   via `NODE_OPTIONS=--require`) and max RSS (`/usr/bin/time`), and a run at
   `--max-old-space-size=2048`.
2. `tsconfig.lint.json` (root, new): extends `./tsconfig.base.json`; `noEmit`; `types: ["node"]`;
   `allowJs` (for the `.mjs` helpers, tools and root config), `checkJs: false`; `paths` = the conflict-free
   union of all 40 suite aliases, written relative to the root WITHOUT `baseUrl` (TS resolves
   `./`-prefixed paths against the config's directory), re-derived at base; `include` = exactly the
   ESLint block's `files`:
   `test/**/*.ts`, `test/**/*.mjs`, `packages/**/src/**/*.ts`, `apps/**/src/**/*.ts`, `tools/*.mjs`,
   `eslint.config.mjs` (tools and the root config are INCLUDED, so every file ESLint lints is typed).
3. `eslint.config.mjs`: one new block at the end (so no earlier block can switch it off) with those
   `files`, `parserOptions.project: ["./tsconfig.lint.json"]`, `tsconfigRootDir: import.meta.dirname`,
   and `@typescript-eslint/no-floating-promises: "error"` with default options. Header comment rewritten
   to say the type-aware block exists and why. `no-misused-promises`: enable only if it reports 0 at base
   AND costs no measurable time (decided from measurements; stated in the handoff).
4. Drift pin `test/unit/tooling/lint-typed-program.test.ts` (plain JSON/text + ESLint's
   `calculateConfigForFile`, which never parses or builds a program):
   (a) `tsconfig.lint.json` `paths` is a superset of every tracked tsconfig's `paths`, targets compared
   after resolving each against its own `baseUrl` (or its directory);
   (b) `include` equals the ESLint block's `files`;
   (c) extra: every tracked file ESLint lints gets the rule at `error` with `parserOptions.project`
   pointing at `tsconfig.lint.json` (so a new file outside the globs cannot silently skip the rule).
   Pure checkers take in-memory inputs so mutants never touch tracked files; plus a scratch probe that
   drifts the real files and restores them byte-identically.
5. Probes (restored byte-identically, sha256 vs `git show HEAD:`): CI-1 `.then` probe, `.resolves`,
   `.rejects`, `void` control, one floating promise per tsconfig group (census `probe-files.txt`,
   re-checked at base), a file matched by the block but absent from the program, the drifted alias /
   drifted glob against the pin.
6. Re-run the rule(s) over everything; fix any violation (none predicted).
7. Measure AFTER, same method; check `NODE_OPTIONS=--max-old-space-size=2048`.
8. Gates: typecheck, lint, check:deps, test, test:e2e, test:replay; then one commit.

Plan outcome: executed as written, with one decision taken on the measurements: `no-misused-promises` is NOT
enabled (see summary).

## summary

LINT-1 (`CI1-L2`) r0 on base `3bfe56a`, branch `lint-1`, commit `8ebf8e0`. Every tracked file ESLint lints,
tests and production alike, now runs `@typescript-eslint/no-floating-promises` with type information.

- **(1) The rule.** `eslint.config.mjs` gains ONE block. It sets `no-floating-promises: "error"` with default
  options (`ignoreVoid` stays `true`), and its `files` are:
  - `test/**/*.ts` and `test/**/*.mjs` (this covers the recorder's `run-soak.mjs` and
    `inherited-tojson.preload.mjs`);
  - `packages/**/src/**/*.ts` and `apps/**/src/**/*.ts`;
  - `tools/*.mjs` and `eslint.config.mjs` (both INCLUDED, so no linted file is left untyped).

  Type information comes from `parserOptions.project: ["./tsconfig.lint.json"]` with `tsconfigRootDir:
  import.meta.dirname`. The header comment now describes the typed block instead of "deferred". Nothing else in
  the file changed.

  `no-misused-promises` also reports 0 at this base. It was measured and not enabled: three runs each gave
  18.82 / 19.10 / 18.87 s against 14.53 / 14.62 / 14.88 s without it (about +4.3 s, +29%), and a peak heap of
  2435–2445 MB against 2144–2163 MB (about +290 MB).
- **(2) The lint-only tsconfig.** The new root `tsconfig.lint.json`:
  - extends `./tsconfig.base.json`, with `noEmit`, `types: ["node"]`, `allowJs`, `checkJs: false`;
  - has `paths` = the conflict-free union of all 40 aliases found in the 49 tracked tsconfigs, re-derived at this
    base (identical to the census `paths-union.json`). They are written `./`-relative with no `baseUrl`;
  - has an `include` identical to the block's `files`;
  - carries a `"//"` key documenting the file, because strict JSON has no comments.

  Its program's repository files are exactly the 1003 files ESLint lints at base (1004 with the new pin).
  - `pnpm exec tsc -p tsconfig.lint.json --noEmit`: exit 0, **0 errors**, 8.4 s, max RSS 1.34 GB.
  - All 4636 import specifiers in those 1004 files resolve to a module symbol (TS API scan, scratch
    `unresolved.cjs`).
  - A file the block lints but the program lacks fails lint loudly, proven two ways: an untracked
    `test/.lint-probe/floating.ts`, and `include` minus `"tools/*.mjs"`. Both give `pnpm run lint` exit 1 with
    `Parsing error: "parserOptions.project" has been provided for @typescript-eslint/parser. The file was not
    found in any of the provided project(s): <file>`.
- **(3) The drift pin.** `test/unit/tooling/lint-typed-program.test.ts` has 14 tests and takes about 0.5 s alone
  (1.0 s in the full suite). It builds no TypeScript program. It checks:
  - (a) `tsconfig.lint.json`'s `paths` is a superset, with identical resolved targets, of every tracked
    tsconfig's `paths`. Each target resolves against the nearest `baseUrl` in its `extends` chain, else against
    the declaring file's directory, so the binance suite's `baseUrl: "."` and the others' repo-root `baseUrl`
    both compare correctly. Every lint-only target must also be a tracked file.
  - (b) `include` equals the block's `files`: same set, no duplicates, no `ignores` on the block, and no
    `files`/`exclude`/`references` on the tsconfig.
  - (c) EXTRA: every tracked file ESLint lints gets the rule at exactly `[2]` (on, default options) and
    `parserOptions.project` = `tsconfig.lint.json` alone. This uses ESLint's `calculateConfigForFile`, which
    merges config by path without parsing (all 1349 tracked files in about 0.4 s).

  The mutants are in-memory copies, and each expectation is on the findings a mutant ADDS to the real files'
  findings. Real-file drifts were each planted and restored byte-identically, and each fails the pin:
  - D1: an alias added to `test/e2e/tsconfig.json`;
  - D2: a changed target in `test/contract/binance/tsconfig.json`;
  - D3: an alias dropped from `tsconfig.lint.json` (exactly 1 failing test);
  - D4: `include` `apps/**/src/**/*.ts` changed to `apps/*/src/**/*.ts`. **`pnpm run lint` alone stays exit 0
    here**; only the pin catches it;
  - D5: an extra glob in the block's `files`;
  - D6: `ignoreIIFE: true` added to the rule.
- **(4) The rule fires.** In `test/unit/tooling/dependency-direction.test.ts`, lint flags:
  - the CI-1 probe `runCheckerJson(buildFixture()).then((r) => expect(r.ok).toBe(false));`;
  - un-awaited `.resolves`, `.rejects` and `expect.poll`;
  - and does NOT flag `void runCheckerJson(buildFixture());`.

  A `Promise.resolve(1).then(...)` probe is flagged in one file of every group, and a `void` control is never
  flagged:
  - tests: `test/tsconfig.json` (unit), e2e and its helper, fault-injection/wal, the 4 contract suites, the 6
    integration suites and a helper, soak/recorder (`.ts` and both `.mjs`), `test/vitest.config.ts`, and
    packages and apps `src` tests;
  - PRODUCTION: `packages/decimal`, the nested `packages/strategies/static-bracket`, `packages/event-bus`,
    `apps/trader`, `apps/data-gateway`, `apps/control-api`, `apps/backtest-cli`;
  - `tools/check-dependency-direction.mjs` and `eslint.config.mjs`.

  Alias-typed floating calls are flagged too: `@polymarket-bot/trader` (e2e), `@polymarket-bot/event-bus/testing`
  (integration), `@polymarket-bot/storage-postgres/testing` (integration), `MarketEventTransport` from
  `@polymarket-bot/event-bus` in `apps/data-gateway/src/gateway.ts` (production), and a relative-import call in
  `apps/trader/src/index.ts`. Result: **33/33 files as expected; `pnpm run lint` exit 1, "41 problems (41
  errors)"**.

  The risk the pin guards was reproduced: with `@polymarket-bot/event-bus/testing` dropped from a scratch copy of
  the program, the event-bus alias-typed probe goes SILENT (eslint exit 0, no message). Every probed file was
  restored, and its sha256 verified against the pre-plant bytes and against `HEAD`/index.
- **(5) Violations.** Re-run over everything at this base: **0**. No source file is touched.
- **(6) Measurements** (below). Lint passes at the default heap and at 2048 MB, so CI needs no heap flag;
  `ci.yml` and `package.json` are untouched.

### Measurements (`pnpm run lint`; eslint process; heap = census `heap-sampler.cjs` via `NODE_OPTIONS=--require`, an upper bound; RSS = `/usr/bin/time %M`; this machine: 24 cores, 32 GB, node 24.13.0, default heap limit 4288 MB)

| state | wall (s) | peak heap used (MB) | max RSS (MB) | at `--max-old-space-size=2048` |
| --- | --- | --- | --- | --- |
| before, `3bfe56a` clean | 7.62 / 7.83 / 7.91 | 552 / 561 / 552 | 878 / 863 / 841 | pass, 7.70 s, 521 MB |
| after, `8ebf8e0` content | 14.69 / 14.56 / 14.90 | 2171 / 2179 / 2171 | 2517 / 2530 / 2507 | **pass**, 15.36 s, 1624 MB, RSS 2081 MB |

Floor of the "after" state: it passes at 1536 MB (17.12 s) and at 1280 MB (20.58 s), and aborts out of memory at
1024 MB (exit 134, 22.9 s). With `no-misused-promises` added it would be about 18.9 s and about 2440 MB.

Unit note: the RSS column above is MiB (kB / 1024). The commit message states the same `/usr/bin/time`
readings in thousands of kB: "861-899 MB" before and "2567-2590 MB" after, the same numbers as this table's
841–878 and 2507–2530 MiB. Heap figures come from V8 and are MiB in both.

## files_changed

- `/home/adriancova/proyects/tradeBot/polymarket-bot-lint-1/eslint.config.mjs` (PROTECTED, user-granted): the
  header comment (lines 2–4) and the one LINT-1 block at the end. Nothing else.
- `/home/adriancova/proyects/tradeBot/polymarket-bot-lint-1/tsconfig.lint.json` (new, repository root).
- `/home/adriancova/proyects/tradeBot/polymarket-bot-lint-1/test/unit/tooling/lint-typed-program.test.ts`
  (new, the drift pin).

## tests_run

All at the final content, which was committed as `8ebf8e0`.

- `pnpm run typecheck`: exit 0.
- `pnpm run lint`: exit 0 (0 problems), 3 timed runs plus the 2048, 1536, 1280 and 1024 MB caps above.
- `pnpm run check:deps`: exit 0 (PASS).
- `pnpm run test`: exit 0, **335 files / 7267 tests**. That is 334/7253 post-merge + 1 file / 14 tests.
  **New:** `test/unit/tooling/lint-typed-program.test.ts` (14). No unhandled error and no
  `Timeout calling` in the output.
- `pnpm run test:e2e`: exit 0, 7 files / 157 tests.
- `pnpm run test:replay`: exit 0, 3 files / 17 tests.
- `pnpm exec tsc -p tsconfig.lint.json --noEmit`: exit 0, 0 errors.
- `pnpm exec tsc -p test/tsconfig.json --noEmit` and `eslint` on the new files: exit 0.

Probe harnesses are in `/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/lint-1/impl/`.
Each was run once while developing and once more on the final content.

| harness | what it proves | final output |
| --- | --- | --- |
| `probe.mjs` | 33 planted files, 41 errors, void controls, restore check | `probe-run-final.txt` |
| `probe-program.mjs` | silent skip with a dropped alias; the two loud-failure probes | `probe-program-final.txt` |
| `probe-pin.mjs --lint` | real-file drifts D1–D6 against the pin, and lint under D4 | `probe-pin-final.txt` |
| `measure.sh` | lint wall time, heap and RSS | `m-*.time` / `m-*.err` |

Also in that directory:
- `misused.config.mjs` and `misused-*.err`: the `no-misused-promises` cost comparison.
- `unresolved.cjs`: the import-resolution scan.
- `paths-union-base.json`: the union re-derived at this base.

After the last harness, `git status --porcelain` was empty apart from the three staged files, and it was empty
after the commit.

## assumptions

- **Scope.** The packet's widened scope (enforce on tests AND production) is authoritative. The
  `IMPLEMENTATION_STATUS.md` LINT-1 row says "Scope widened ... TESTS + PRODUCTION", but its older "Scope:" text
  still says "census production code ... REPORT it, not fix it". With 0 production violations, the difference
  had no effect here.
- **Allowed paths.** The drift pin under `test/unit/tooling/**` is allowed by the packet, although the status
  row's path list does not name it.
- **Unused aliases.** The lint program's `paths` may carry aliases no source file imports today. All 40 are
  declared by at least one suite tsconfig, so the superset is exact.
- **Production resolution.** Production files resolve workspace imports through `node_modules` links.
  `@polymarket-bot/*` aliases in the lint program point at the same `src` files as the packages' `exports`, so
  the lint program's types for production match `pnpm -r run typecheck`. This is inferred from 0 tsc errors and
  0 unresolved specifiers, not from a per-import comparison.
- **CI heap.** The CI runner's default Node heap limit is at least about 1.75 GB: V8 sizes the heap from physical
  memory, ubuntu-latest has 7 GB (private) or 16 GB (public), and lint's measured floor is below 1280 MB. **Not
  observed on CI**: this commit has not run there.

## deviations

- **An extra check in the pin.** Check (c), "every tracked file ESLint lints is typed by this block", goes
  beyond the two checks the packet asked for. It closes the remaining silent hole: a new linted file outside the
  globs, such as `packages/x/vitest.config.ts` or a `.cts` helper, would otherwise be linted untyped.
- **The pin is not purely text.** It imports `eslint`, a root devDependency, and dynamically imports
  `eslint.config.mjs` to read the block, so the vitest worker loads ESLint, typescript-eslint and the
  `typescript` module. It never parses a source file or builds a program: about 0.5 s alone, 1.0 s in the full
  suite.
- **Default options are pinned.** The pin requires the effective rule entry to be exactly `[2]`. Changing an
  option, even to something stricter, therefore needs a pin update.
- **A documentation key in the tsconfig.** `tsconfig.lint.json` documents itself in a `"//"` array key.
  TypeScript ignores it, and `tsc` exits 0.
- **Staged before the pin's first run.** The new files were staged before the first pin run, because the pin
  lists files from the Git index, as the CI-1 tripwire does.
- **`no-misused-promises` is not enabled.** It was permitted, but its cost is measurable (see summary).

## known_risks

- **Cost.**
  - Lint wall time roughly doubles, from about 7.8 s to about 14.7 s locally.
  - The eslint process's peak heap goes from about 0.55 GB to about 2.2 GB, and RSS from about 0.87 GB to
    about 2.5 GB.
  - The floor is between 1024 MB (OOM) and 1280 MB (pass), so the margin on a 7 GB runner (default heap about
    1.75 GB) is roughly 0.5 GB. The program grows with the repository.
  - The first CI run of this commit is the real evidence and has not happened.
- **Resolution drift outside `paths`.** Nothing in CI runs `tsc -p tsconfig.lint.json`. A future suite import
  that the lint program cannot resolve would give the rule an error type, and the rule would skip it silently.
  Examples: an import relying on a suite's `baseUrl` (the lint program has none), or on another
  resolution-affecting option. The pin covers only `paths`. At this base, every one of the 4636 specifiers
  resolves.
- **Dot-directories.** A tracked `.ts` file under a dot-directory inside the globs (e.g. `test/.fixtures/x.ts`)
  is linted by ESLint but skipped by TypeScript's `**`. Lint then fails loudly with the parsing error. That is
  fail-closed, but it surprises the author.
- **`.mjs` inference.** The `.mjs` files are typed by inference only (`checkJs: false`). A JS promise that
  inference types as `any` is not flagged.
- **`void` is the opt-out.** Under `ignoreVoid` default, any `void`-marked promise passes, and nothing enforces a
  reason comment next to it.
- **Editors.** An editor ESLint integration will build the same ~2 GB program.

## follow_up

- Watch the first GitHub Actions run of this commit: the Lint step's duration and any heap abort.
- Consider a CI gate `tsc -p tsconfig.lint.json --noEmit`, or an extension of the pin, so an unresolved import
  in the lint program fails loudly. This needs a grant for `ci.yml` or the protected `package.json`.
- `no-misused-promises` (0 violations) could be enabled in a later round if +4.3 s and +290 MB are acceptable.
- Governance: reconcile the LINT-1 row's older "Scope:" wording (report-only for production) with the widened,
  enforced scope. Record the round in `docs/handoffs/LINT-1.md`.

## commit_sha

`8ebf8e045c19358d46fc973fda46a995fb36ec22` (branch `lint-1`, one commit on `3bfe56a`; not pushed).
