# CONTROL-1b: authoritative no-signer checks on what ships; the kill-switch lock key; bounded, timed, jsonb-safe audit appends

**Status:** Complete (2026-10-01). Merged `80a06e2` (PR #46; CI run `36970637486` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 5 on `6a912f2`.
**Base:** `8e95034`. The branch merged `main` at `8579244` before the PR.
**Paths:**
- `apps/control-api/**`;
- `test/integration/control-api/**`;
- `test/unit/control-api/**`;
- `test/vitest.config.ts`, granted 2026-10-01 for the scoped guard only.

**Posture:** PAPER only.

## summary

It closes `CONTROL1-LOWS` and adds the prerequisites for a durable audit sink.

- **The no-signer property.**
  - **The requirement was revised after round 4.** Rounds 1–4 each found a new static route past the test-tree scan (3, 2, 1 and 3 HIGHs). Each of those routes was refused by the run-time guard wherever the guard was installed. No static scan of JavaScript can be sound against deliberate obfuscation, so "unevadable by spelling" was withdrawn (brief `8579244`).
  - **Authoritative check 1, the shipped bundle.** `acceptance-3-shipped-artifact.test.ts` runs the build's own esbuild invocation with `--metafile`. It fails on:
    - any forbidden input, judged by its path and its real path;
    - any input that is not a file on disk;
    - any input outside the package's `src`, its workspace dependencies or `node_modules`;
    - any third-party package not on an exact list (today `zod` and `decimal.js`);
    - any external that is not a permitted builtin.

    Positive controls bundle the secure adapter directly and through a symbolic link. `support/production-source-rule.ts` bans dynamic-loading primitives in production source. It works on the TypeScript AST, and is pinned by 45 planted cases and 12 negative controls.
  - **Authoritative check 2, the run-time guard.** It runs in every runner that executes control-api code. `test/vitest.config.ts` now has two inline projects, and only control-api tests run under the guard; `packages/polymarket-secure`'s own tests are unaffected. The guard judges the file a load lands on after resolution, which closes the round-4 routes.
  - **The test-tree scan is best-effort lint.** Its limits are stated identically, and pinned, in the README and the module headers:
    - computed or evaluator routes;
    - exotic escapes in evaluated text;
    - crafted directories and manifests;
    - working-directory resolution;
    - copies and hard links;
    - child processes and threads;
    - loader internals.
  - **Vocabulary.** `ox`, `@polymarket/bindings` and `@polymarket/types` join an exact-match forbidden list.
- **The kill-switch lock key is pinned.** Mutants X13–X16 are killed, deterministically in the unit tests.
- **The append timeout.** Every audit append is bounded by `auditAppendTimeoutMs` (default 5000 ms; range 1–60000).
  - On timeout the mutation is refused 503 `CONTROL_NOT_AUDITABLE`, the state is unmoved, and the per-key lock is released.
  - A late APPLIED record gets a REFUSED void record beside it.
  - A timed-out append keeps its budget slot until it settles, and one unsettled protected append per key gates that key.
- **Bounds.** A mode-raise record keeps at most 8 keys plus `attemptedKeyCount`. Its reason is cut to 256 characters.
- **`jsonb`-safe text.** `audit-text.ts` escapes every record once, before any sink sees it: NUL, lone surrogates, and every Cc, Cf, Zl and Zp character become a visible `\u{HEX}`. The escaping is reversible. Fields are cut to the column bounds (identifier 200, detail 2000) on code-point boundaries. A real-PostgreSQL suite proves every record lands, identical to the in-memory log.

## Rounds

| Round | Candidate | Verdict | Agreed blocking findings |
|---|---|---|---|
| 1 | `a8fd0e7` | CHANGES REQUIRED | 3 HIGH, scan evasions: path-form specifiers, `.tsx` not walked, evaluators; 1 MEDIUM, retries spending the reserve |
| 2 | `c8c7b4b` | CHANGES REQUIRED | 2 HIGH: loaders reached without spelling their names; loader APIs of permitted packages |
| 3 | `c4b41b7` | CHANGES REQUIRED | 1 HIGH: computed `createRequire` reaching literal paths; the unit runner was not guarded |
| 4 | `0210a55` | CHANGES REQUIRED | 3 HIGH: directory landings, exotic escapes, nested manifests. The requirement was revised |
| 5 | `6a912f2` | **ACCEPT** | none; 3 LOW open |

- Rounds 1–2 ran before and after the weekly usage limit of 2026-10-01. The implementer's commit survived, and the run was resumed for verification.
- Rounds 5 onward ran as a continuation, under the revised rubric.

## tests_run

- **Gates on `6a912f2`:**
  - `typecheck`, `lint` and `check:deps` exit 0.
  - `test`: 422 files, 9537 tests.
  - `test:e2e`: 9/212.
  - `test:replay`: 3/17.
  - control-api `test:integration`: 21/283.
  - `test:integration:postgres`: 2/19, on real PostgreSQL.
- **astra's first unit run** hit the known `boundary-surface.test.ts` 5000 ms timeout under host load. That file is outside the diff, and both verifiers agree it is not a defect of the candidate.
- **Proofs against `0210a55`:**
  - with the old `test/vitest.config.ts`, 12 of the 14 new guard pins fail;
  - with the old vocabulary, the `ox` pins fail;
  - with the old texts, the limits pin fails.
- **Mutation:**
  - round 4: 39 of 39 killed;
  - round 3's applicable rows: 29 of 29 killed.
- **Plants and scope:**
  - every earlier plant is refused by the guard in the unit runner, except P8, a child process, which is disclosed;
  - a scope probe shows the SDK loads outside the guarded globs and is refused inside them.
- **CI:** GitHub CI on the PR #46 merge ref was green before the merge: run `36970637486`.

## assumptions
- "Every runner that executes control-api code" means `apps/control-api/src/**/*.test.ts` and `test/unit/control-api/**`. `test/unit/tooling/app-bundles-load.test.ts` imports control-api's `main.ts` in the unguarded project. It is pinned as the one exception.

## deviations
- The packet's "unevadable by spelling" was withdrawn by the orchestrator after round 4 (see summary).

## known_risks
- **CTRL1B-R5-L1 (LOW).** The production-source rule misses a global reached as a member of another, for example `const p = globalThis.process; p[k]`, or `Reflect.get(globalThis.process, k)`.
- **CTRL1B-R5-L2 (LOW).** The README and the shipped-artifact header claim that `check:deps` F14 holds the bundled workspace packages. F14 applies only to packages restricted for purity, which here means `domain` alone.
- **CTRL1B-R5-L3 (LOW).** The forbidden vocabulary omits the SDK's signing closure: `@noble/curves`, `@noble/hashes`, `@scure/bip32` and `@scure/bip39`. A computed-path plant in the guarded project loaded `@noble/curves` and signed. The shipped bundle's exact third-party list (`zod`, `decimal.js`) still excludes them from what ships.
- **A config-less `vitest` run** skips the guard. No repository script runs one, and `--pool=vmThreads` fails closed.
- **Carried from CONTROL-1 for the durable composition:**
  - a timed-out protected append that lands spends one reserved record;
  - voids are best-effort ordinary records;
  - a never-settling append gates that switch's protected mutations, escalation included;
  - log order can differ from apply order, so readers must join on `voidsRecordId`.

## follow_up
1. **A later control-api round** closes the three LOWs. L3 is a policy addition to `forbidden-targets.ts`.
2. **Before wiring a durable sink,** settle the carried durable-sink items above.

## commit_sha
`6a912f26f351d5659e175da8fa49376eca4cd9fc`
