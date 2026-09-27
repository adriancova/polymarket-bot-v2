# CI-2: four of CI-1's review LOWs

Branch `ci-2` on base `9340df6`, merged into `main` as `6325d10` (`--no-ff`) on 2026-09-26. Authorized the same day by the user ("can you handle the 9 follow ups pls?").

It ran under the user's HARDENING LOOP: an Opus implementer, then an independent verifier, then a fresh Opus remediator on any findings, repeated until ACCEPT. The verifier was a **Claude Fable adversarial reviewer**, not Codex. This package's probes are about child processes and test-worker timing, and Codex's sandbox blocks process spawning. The orchestrator recommended Fable over running Codex unsandboxed, and the user agreed.

| Commit | Content |
| --- | --- |
| `b452f45` | r0: all four items. The implementer continued uncommitted work from a predecessor that the orchestrator had stopped only to switch this verifier. |
| `6da71b2` | r1: Fable r1's two LOWs, plus the python-gating residual it disclosed. |
| `6325d10` | the merge (with RECON-2 already on `main`). |

## Outcome
- **`CI1-L1`:**
  - Each shared repository run in `dependency-direction.test.ts` now has its own 30 s deadline, measured from its start, that kills its child. A no-op `.catch` covers early rejection, and each of the five readers has a 40 s timeout.
  - A 45 s-slow or hung run now gives 5 failed / 182 passed. Before, all 187 tests were skipped.
  - Why not the review's own suggestion: it used per-reader timeouts alone, and measured 1 failed / 186 passed. The implementer showed that result misses the acceptance criterion.
- **`CI1-L3`:** the tripwire now states the real hazard, about 60 s of synchronous work per test file of ANY kind. It says what is not checked: untracked files, names assembled at run time, and the fact that the suite needs `git`. It also scans all tracked helper modules under `test/`, and none uses a synchronous child-process call.
- **`CI1-L4`:** `PROBE_TEST_TIMEOUT_MS = MODES.length * PROBE_CEILING_MS + 10_000` (90 s). A hang fails through the 20 s spawn ceiling, and no child survives.
- **`CI1-L5`:**
  - `ci.yml` runs `typecheck` (4), `test:contract` (4) and `test:integration` (6) as one gated step per command.
  - Job timeouts come from run `36284366946`: node 30 min (6.5× its 277 s), compose and python a 10 min floor.
  - The drift pin is `test/unit/tooling/ci-workflow.ts` (a small YAML reader that refuses anything outside its subset, identical to PyYAML on this file) plus `ci-step-split.test.ts` (26 tests). It fails when:
    - the split steps and the root chains diverge;
    - a node or python gate loses its job's gating `if:`;
    - any other gate starts running an `&&` chain as one step.
  - The root `package.json` is byte-identical.

## Reviews (Fable)
- **r1, of `b452f45`: ACCEPT, 2 LOW.** Every CI-1 LOW was reproduced and each is fixed.
  - L5-1: a new `&&` chain in another gate's root script escaped the pin.
  - L3-1: a helper-module count comment was off by one.
- **r2, of `6da71b2`: ACCEPT, 2 new LOW, queued.**
  - `CI2-L5-2`: a multi-line `run: |` block of independent gates escapes the pin.
  - `CI2-L5-3`: alternative pnpm spellings that run the root script escape it, and the header's claim about flags is false for them.

## Evidence
- Verifier gates at `6da71b2`, outside any sandbox: typecheck 0; lint 0; check:deps PASS; unit 333 / 7250; e2e 7 / 117; replay 3 / 17.
- **GitHub Actions:** PR #4 run `36292508550`, all three jobs green, including every one of the 14 new split steps. This was the first run of the split workflow.
- Post-merge on `main` `6325d10`: lint 0, unit 334 / 7253, e2e 7 / 157.

## commit_sha
`6da71b20937dd30c964b4a1d4664290f2c17a8c7` (branch `ci-2`), merged as `6325d10`.

---

# Appendix A — implementer handoff, r0 (verbatim)

# CI-2 handoff, round 0 (first implementation)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-ci-2`, branch `ci-2`, base `9340df6`.
One commit: `b452f4551ad65bd0c1c0e2d08dd36edf848cd4d6`. Not pushed.

## plan (written before editing; continuation of a stopped implementer)

An earlier implementer was stopped after about 15 minutes. It left uncommitted edits in two
allowed files (`dependency-direction.test.ts`, `index-name-pollution.test.ts`) and a plan in this
file. I reviewed both edits against the packet and ADOPTED that plan, with the changes marked
below. None of its work counted until I had re-run every probe myself, and I did. It had changed
no file outside the allowed paths.

Prerequisites verified: CI-1 complete (merged `7248073`); the CI-2 row reads "Ready";
`node_modules` present; `gh run view 36284366946` readable.

1. `CI1-L1`: keep the earlier edit, which puts a deadline on the RUN, not on each reader.
   Re-run the 45 s, hang, early-rejection and leftover-child probes.
2. `CI1-L3`: new text; a helper scan in a NEW describe block, so no existing test name changes;
   the bracket-literal shape; no exclusions.
3. `CI1-L4`: keep `MODES.length * PROBE_CEILING_MS + 10_000`, and fix the comment sentences that
   were not true.
4. `CI1-L5`: split the 14 steps; set `timeout-minutes` from run `36284366946`; add the drift pin.
   The pin is a pure function of (workflow text, package.json text), so every mutant is an
   in-memory copy. Cross-check the reader against PyYAML.
5. Diff the sorted test names at base and at the candidate, then run every gate.

## summary

- **`CI1-L1`**, `test/unit/tooling/dependency-direction.test.ts`.
  - `beforeAll` now starts the two shared full-repository checker runs and does not await them.
  - Each run has its own 30 s deadline, `REPOSITORY_RUN_DEADLINE_MS`, counted from when the run
    starts. At the deadline, `spawnNode`'s new optional `deadlineMs` SIGKILLs the child and
    settles with an `error`, so `runChecker` rejects with a message that names the deadline.
  - `repositoryRun` attaches a no-op `.catch` to each stored promise.
  - The five readers get `REPOSITORY_READER_TIMEOUT_MS` = 40 s.
  - `liveChildren` and the `afterAll` kill are unchanged.
  - A slow, hung or rejected run now fails exactly the five readers, and the other 182 pass.
- **`CI1-L3`**, `test/unit/tooling/no-synchronous-spawn.test.ts`.
  - The header now states the real limit: about 60 s of SYNCHRONOUS work of any kind in one test
    file, without the worker's event loop turning. It cites the `Atomics.wait` reproduction.
  - It lists what is checked mechanically: only the names of the three APIs.
  - It lists what is NOT checked: other synchronous work, names assembled at run time, untracked
    files (CI checks out tracked files only), and modules outside `test/`. It also says the suite
    needs `git` and a `.git` directory.
  - A new describe block scans every tracked helper module under `test/` (`.ts .mts .cts .js .mjs
    .cjs`, not `*.test.ts`): 81 files at the commit. It has three tests: the filter, a
    non-vacuous listing, and the scan itself.
  - The shape test gains two bracket-literal forms.
  - Nothing is excluded. No helper names an API today, including `test/soak/recorder/**`, the
    configs and the `globalSetup` modules. The text says those run outside any worker, and that an
    exclusion must be added with its reason if one ever needs a synchronous call.
  - The four existing test names are unchanged.
- **`CI1-L4`**, `test/unit/decimal/index-name-pollution.test.ts`.
  - `PROBE_TEST_TIMEOUT_MS = MODES.length * PROBE_CEILING_MS + 10_000`, which is 90 s.
  - The comment now matches the code. `probe` memoizes answers, not spawns, so one test can wait on
    up to four sequential spawns, and each spawn ends at the 20 s ceiling at the latest.
  - The comment's measured claim was re-measured by me.
- **`CI1-L5`**, in the node job of `.github/workflows/ci.yml`.
  - `Typecheck`, `Venue contract tests` and `Integration tests` became 4 + 4 + 6 steps: one per
    chained command, in chain order.
  - Each has the exact CI-1 gate `if:` and is named `<label> k/N - …`.
  - N5's container facts are kept and re-verified: postgres, event-bus, and the trader's
    paper-trader suite.
  - Every other step is unchanged and in the same order. PyYAML confirms this, and the compose and
    python steps are identical.
  - `timeout-minutes`: node 30, compose 10, python 10. The comment states the basis (below).
- **The drift pin.**
  - New helper `test/unit/tooling/ci-workflow.ts` contains a conservative YAML-subset reader that
    THROWS outside its subset, plus `chainCommands`, `stepRunFor`, `splitStepDrift` and
    `jobTimeoutFindings`.
  - New test `test/unit/tooling/ci-step-split.test.ts` has 20 tests. They check that the real files
    agree, add a non-vacuity pin of 4/4/6 commands and 22 gates, and apply mutants for every drift
    class. They also check that the reader refuses 23 YAML constructs and that the chain parser
    refuses non-plain chains.
  - The root `package.json` is byte-identical.

## files_changed

- `.github/workflows/ci.yml`
- `test/unit/decimal/index-name-pollution.test.ts` (comment and one constant)
- `test/unit/tooling/dependency-direction.test.ts`
- `test/unit/tooling/no-synchronous-spawn.test.ts`
- `test/unit/tooling/ci-workflow.ts` (new helper module)
- `test/unit/tooling/ci-step-split.test.ts` (new test file)

## tests_run

Everything below was run by me in this round. Probe scripts are in
`…/scratchpad/ci-2/mine/` (`l1.sh`, `l4.sh`). The preloads, reused after review, are in
`…/scratchpad/ci-2/probes/` (`checker-child.mjs`, `decimal-child.mjs`). Every tracked file I
edited for a probe was restored and checked by sha256.

### CI1-L1 (preload through `NODE_OPTIONS=--import`, only on the `--root <repo>` children unless noted)

| Probe | Result |
| --- | --- |
| candidate, both children sleep 45 s | exit 1; **5 failed / 182 passed**; no unhandled error; both children dead right after; no checker process of this worktree alive |
| candidate, both children hang (600 s) | same: 5 failed / 182 passed, no unhandled error, children dead (SIGKILLed at the deadline) |
| base file, both sleep 45 s | `Hook timed out in 30000ms`, **187 skipped** (the reviewer's result reproduced) |
| mutant: the reviewer's literal per-reader-timeout design (no run deadline, 30 s readers), 45 s | **1 failed / 186 passed**: the reason the deadline sits on the run |
| candidate, both runs reject (2 MiB stdout, over the 1 MiB cap) | 5 failed / 182 passed, no unhandled rejection |
| candidate, EARLY rejection (json rejects at once while reader 1 waits 5 s on text) | 5 failed / 182 passed, no unhandled rejection |
| mutant without the `.catch`, same early rejection | 5 failed, plus `Unhandled Rejection … child stdout exceeded`, `Errors 1 error` |
| candidate, the `--help` child blocks 120 s (its test times out at 5 s) | 1 failed / 186 passed; the child is dead right after the run (afterAll kill) |
| mutant without the afterAll kill, same | the child is ALIVE after the run (killed by hand), so the probe is sensitive |
| candidate, normal run (no-op preload) | 187 passed, exit 0, 33 s |

The five failing readers in the slow, hang and reject probes:

1. `dependency-direction check on this repository > passes, and reports the S0 same-layer edge as permitted`
2. `… > classifies every workspace package into exactly one §2 layer`
3. `… > builds the §6 graph from declared workspace edges and excludes the root manifest`
4. `dependency-direction check — round-1 review regressions > LOW: the parsed contract is validated eagerly > keeps the shipping contract valid under all of the above`
5. `dependency-direction check — round-6 evaluator-acquisition regressions > negatives: the rule stays inside its boundary > keeps this repository passing`

In the slow and hang probes the first reader failed at 30.0 s, and the other four failed in 0 ms,
each with `child did not finish within its 30000 ms deadline and was killed`.

### CI1-L3

- Planted in tracked NON-test helpers, one at a time, each restored byte-identically:
  - `import { spawnSync }` in `test/unit/strategy-runtime/helpers.ts`;
  - `cp.execFileSync("ls")` in `test/soak/recorder/run-soak.mjs`;
  - a comment naming `execSync` in `test/integration/data-gateway/support/harness.ts`.

  Each failed only `finds none in any tracked helper module under test/`. The received array named
  the file and line, e.g.
  `"test/unit/strategy-runtime/helpers.ts line 4: import { spawnSync } from \"node:child_process\";"`.
- The six shapes, each planted after line 41 of `test/unit/decimal/arithmetic-fold.test.ts`: named
  import, namespace call, `require`, alias, destructured alias, bracket literal. Each failed
  `finds none in any tracked *.test.ts file`, reporting `…arithmetic-fold.test.ts line 42: …`.

### CI1-L4 (preload on the decimal probe child)

| Probe | Result |
| --- | --- |
| candidate, every child hangs | 4 probe tests fail at 20.0 s each with `Command failed:` (execFile's rejection from `ChildProcess.exithandler`, not `Test timed out`); 12 pass; 4 children, all dead right after; 81 s |
| candidate, A-C 9 s and D hung | test 1 fails at **47.2 s** via the ceiling; tests 2-4 at 20 s each; 7 children, all dead |
| base file, same mixed probe, polled every 0.5 s | test 1 `Test timed out in 30000ms` at 30 s; its D child (spawned +27.2 s) was **last seen alive at +47.0 s** |
| candidate, every child 15 s | 16 passed; test 1 took 60.2 s |
| candidate, normal | 16 passed, 1 s |

### CI1-L5

- The new `ci.yml` parses with PyYAML 5.4.1. A PyYAML comparison against the base shows: top
  level unchanged; compose and python steps identical; no job key changed except the added
  `timeout-minutes`; the node job has 26 steps (was 15); every non-split step is byte-equal and in
  place; each split step's `run` equals its chain command, or `pnpm exec` + the command for `tsc`;
  each carries the gate `if:`; each has only the keys `name`, `if` and `run`.
- The reader's output is identical to PyYAML (after mapping YAML 1.1 `on: → True` and ints) on the
  base and on the new `ci.yml`. The in-test sample fixture also matches PyYAML.
- The drift pin passes on the real files. Against the BASE `ci.yml` it reports all 14 missing split
  steps, the 3 unsplit steps, and the 3 jobs without a timeout.
- Temporary edits of the real `ci.yml`, each restored byte-identically:
  - remove the step `Integration tests 3/6`: the real-file test fails with
    ``"`test:integration` command 3/6 "pnpm --filter @polymarket-bot/research-worker test:integration" has no gate step…"``;
  - add an extra step `Integration tests 7/7 - ops-cli` with an `ops-cli test:integration` run:
    it fails with `… looks like a split step (its name) but runs no command …`;
  - drop Lint's `if:`: it fails with
    `step 8 "Lint" runs after install without the gate condition: its \`if:\` is missing …`.

  In each case the mutant tests, which are derived from the real text, also fail. See known_risks.
- A package.json COPY in scratch whose `test:integration` chain gains a command, run through the
  helper against the real `ci.yml`, gives 7 findings. They are "command 7/7 … has no gate step",
  plus the six existing step names no longer matching `k/7`. The real `package.json` was never
  touched. The same case runs in-memory for all three chains in the test file.
- Implementation mutants of `ci-workflow.ts`, each killed by at least one test, file restored
  byte-identically: no `if:` check, no orphan check, orphan-by-name only, no `pnpm exec`
  normalization, no order check, no name check, duplicates accepted, no key check, no install check,
  duplicate YAML keys accepted, no timeout check.
- Each split step's command, as `ci.yml` spells it, was run on its own from the repository root, all
  exit 0:
  - the 4 typechecks: 26 s, 5 s, 3 s, 3 s;
  - the 4 contract suites: 6/637, 6/65, 9/158, 7/95;
  - the 6 integration suites, with Docker available locally: postgres 14/215, event-bus 8/81,
    research-worker 4/27, data-gateway 12/94, trader 14/129, control-api 10/85. File counts match
    the N5 comment (14, 8, 4, 12, 14, 10; 36 of 62 files start no container).

### Behaviour preservation

- Sorted test names, from `vitest run --config test/vitest.config.ts --reporter=json` at base
  (`git stash` of the earlier edits, run at `9340df6`) and at the candidate:
  - base: 332 files / 7221 tests, all passed, no duplicate names;
  - candidate: 333 / 7244, all passed;
  - **0 removed, 23 added**: 20 in `ci-step-split.test.ts` and 3 in the new describe block of
    `no-synchronous-spawn.test.ts`.
- No assertion was weakened:
  - the tripwire's scan and its `toEqual([])` are unchanged, now called through a shared helper;
  - the shape list only grew;
  - the shared-run readers assert exactly what they did before.
- The diff has no `eslint-disable`, `.skip`, `.only`, `ts-ignore` or `ts-expect-error`.
- There is no vitest config change.

### Gates (final tree, all exit 0)

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm run lint` | exit 0 |
| `pnpm run check:deps` | exit 0, 34 packages / 80 edges |
| `pnpm run test` | exit 0, **333 files / 7244 tests**, no unhandled error |
| `pnpm run test:e2e` | exit 0, 7 files / 117 tests |
| `pnpm run test:replay` | exit 0, 3 files / 17 tests |

The four touched test files run together: 230 passed (187 + 16 + 7 + 20). The per-file durations
in the full suite, base vs candidate:

| File | Base | Candidate |
| --- | --- | --- |
| dependency-direction | 35.4 s | 36.9 s |
| index-name-pollution | 0.98 s | 1.03 s |
| no-synchronous-spawn | 0.24 s | 0.24 s |
| ci-step-split | — | 0.05 s |

## assumptions

- **Run `36284366946` is the timeout basis, as the packet names.** It is a push of `de8116d` on
  `main`: node 277 s, compose 16 s, python 26 s. A newer green push run, `36285492368` (`9340df6`,
  governance only), appeared later (node 350 s). Other green runs: node 304-420 s, compose 13-23 s,
  python 24-28 s. The slowest node job seen, 420 s (PR run `36282501033`), is still 4.3x under the
  30 min timeout.
- **`pnpm exec tsc …` in a step is the same binary the `typecheck` script resolves.** `typescript`
  is a root devDependency, so `pnpm run` puts `node_modules/.bin` on PATH and `pnpm exec` resolves
  the same `node_modules/.bin/tsc`.
- **A chained `pnpm …` command run directly from a step behaves as it does inside the chain.** Both
  run at the repository root. I ran every split command standalone, and all passed.
- **The runs are equivalent to the old single steps.** GitHub runs every step in a fresh shell at
  the workspace root, and each split step's command reads only the checkout and `node_modules`, as
  CI-1 established for the gates.

## deviations

- **`CI1-L1` does not use the reviewer's literal fix.** The fix is the reviewer's suggestion plus a
  deadline ON THE RUN. The literal suggestion (start without awaiting, no-op `.catch`, per-reader
  timeout) was measured under the 45 s probe: 1 failed and 186 passed, so the other four readers
  pass once the slow run finishes. That misses the acceptance. The packet allows any equivalent
  design.
- **Things the packet did not ask for:**
  - the pin also checks every job's `timeout-minutes`, which guards the other half of `CI1-L5`;
  - it rejects unexpected gate keys (for example `continue-on-error`) and the install step losing
    `id: install`;
  - it checks each split step's `k/N` name prefix;
  - it flags the old unsplit steps (`pnpm typecheck` and the like) if they are re-added.

  All of these are inside the allowed paths.
- **The helper module is scanned by the new tripwire block.** The drift pin's reader and check live
  in a helper module, `ci-workflow.ts`, rather than in the test file. That lets the scratch
  cross-check import it with Node's type stripping.
- **The timeout rule has a floor.** It is 6x the measured job duration, rounded up to 5 minutes,
  with a 10-minute floor for the two short jobs. The effective multipliers are stated in `ci.yml`:
  6.5x, 37.5x and 23x.
- **I removed an ignored build output.** The test runs created `apps/data-gateway/dist/`, which is
  ignored and was absent before, and I deleted it. It is not tracked.

## known_risks

- **The CI side is unobserved.** The new `ci.yml` has not run on GitHub yet: the acceptance needs a
  green PR run, which the orchestrator will trigger. The red path of a split step (a later step
  still running after an earlier one fails) is still reasoned from GitHub's `!cancelled()`
  semantics, as in CI-1. `actionlint` is not installed, so only YAML-level parsing was checked.
- **A real drift fails many tests at once.** It fails the real-file test and the non-vacuity test,
  which pins 4/4/6 commands and 22 gates. The mutant tests build on the real texts and expect
  exactly the mutant's own finding, so they cascade too (12 of 20 in the probe). The first test's
  message names the actual drift. A legitimate chain change also needs the non-vacuity numbers
  updated.
- **The pin is deliberately strict.** Any new gate named like a split step, or whose command
  mentions `typecheck`, `tsc`, `test:contract` or `test:integration`, is reported. So is any gate
  key other than `name`/`if`/`run`. Adding such a gate means extending `ci-workflow.ts`
  deliberately.
- **The gate check covers the node job only.** The python job's `steps.sync` gating is not pinned.
- **The tripwire remains a name scan.** The broader synchronous-time hazard is documented, not
  detected. The slowest unit file is still `dependency-direction.test.ts`: about 37 s locally, and
  80 s on the runner per CI-1, now fully async.
- **The 30 s shared-run deadline carries over CI-1's laptop and runner measurements** (at most
  3.8 s per run on the runner).

## follow_up

- The orchestrator: open the PR for `ci-2` and confirm a green GitHub Actions run with the 14 split
  steps and the three job timeouts, as the CI-2 row requires. The PR run's node duration is worth
  recording against the 30 min bound.
- Optional: pin the python job's gate `if:` the same way.
- Optional: install `actionlint` in CI or locally.
- `LINT-1` (`CI1-L2`) is dispatched after CI-2 merges. It will lint the new files, which use no
  floating promises except the deliberate `void repositoryRun(...)` in `beforeAll`.

## commit_sha

`b452f4551ad65bd0c1c0e2d08dd36edf848cd4d6` (branch `ci-2`, one commit on `9340df6`; not pushed)

---

# Appendix B — implementer handoff, r1 (verbatim)

# CI-2 handoff, round 1 (remediation of the claude-fable ACCEPT-with-LOWs review)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-ci-2`, branch `ci-2`, on top of
`b452f4551ad65bd0c1c0e2d08dd36edf848cd4d6`. Not pushed.

## plan (written before editing)

Prerequisites checked: the worktree is clean at `b452f45`; `node_modules` is present; the review
report (`fable-r1.md`), gate results (`gates-r1.txt`) and the r0 handoff have been read in full.

1. **L5-1** (`test/unit/tooling/ci-workflow.ts`, `splitStepDrift`).
   - For every gate whose `run` is `pnpm <script>` or `pnpm run <script>` (arguments allowed) and
     `<script>` is a root script, follow the root scripts it reaches through the same form.
   - Report a finding when a script on that path contains `&&` and the gate's own script is not
     one of `SPLIT_CHAINS`. A split chain run directly is already reported as "looks like a split
     step".
   - Also report a gate whose own `run` contains `&&`: the same hazard, written in `ci.yml`.
   - Root scripts that no gate runs (`test:compose`, `ops:validate-dataset`) stay out of scope.
   - Pins: new in-memory mutant tests in `ci-step-split.test.ts`, using only `b452f45`'s exports,
     so that at `b452f45` they fail by assertion, not by a missing import:
     - the reviewer's two cases (`test:fault`, `test:e2e`);
     - each non-split root-script gate in turn;
     - a chain reached through another root script;
     - a chain written into a step.
2. **RES-PY** (python job gating).
   - Generalize the gate check to the gated jobs: `node` after `id: install`, and `python` after
     `id: sync`. Each gate needs its job's `${{ !cancelled() && steps.<id>.outcome == 'success' }}`
     and the same key rule.
   - Finding labels gain the job (`jobs.node step 9 "Lint"`), because there are now two jobs.
   - Pins:
     - each python gate losing its `if:` in turn;
     - wrong conditions, including node's `steps.install`;
     - `continue-on-error`;
     - the sync step losing its id;
     - a non-vacuity check (2 python gates).
3. **L3-1** (`no-synchronous-spawn.test.ts`).
   - Correct the comment to 81 (80 at CI-2's base plus CI-2's own `ci-workflow.ts`).
   - Add `test/unit/tooling/ci-workflow.ts` to the asserted list, so the 81st module the comment
     names is asserted as scanned.
   - Argue that a pin failing against `b452f45` does not apply to a comment-only defect.
4. `ci.yml`: comment-only pointers (node: the new root-script rule; python: the `if:` is pinned).
   PyYAML and the reader must agree, and every key must be unchanged.
5. Prove each pin fails with `ci-workflow.ts` restored from `b452f45`, then restore it
   byte-identically. Diff the test names against `b452f45`, run every gate, and commit on top.

The plan was carried out as written, with one extra step. After the first gate run, the node job's
split checks moved into their own function, `splitFindings`. Before that, an early `return` for a
missing install step also skipped the one-step-chain rule on the python gates. Every probe and gate
below was re-run after that change.

## finding table

| Finding | Status | Pin(s) |
| --- | --- | --- |
| L5-1 | FIXED | `ci-step-split.test.ts`: "L5-1: the root script a non-split gate runs becomes an && chain — each such gate in turn"; "L5-1: the review's two cases, test:fault and test:e2e each becoming a two-command chain"; "L5-1: a chain reached through another root script, or written into the step itself" |
| L3-1 | FIXED (comment) | `no-synchronous-spawn.test.ts` "scans a real file list: the Git index's helper modules under test/" now asserts `test/unit/tooling/ci-workflow.ts`, the 81st module the comment names. A pin that fails at `b452f45` does not apply here: see deviations |
| RES-PY | FIXED | `ci-step-split.test.ts`: "RES-PY: a python gate after sync that loses its if: — each in turn"; "RES-PY: a python gate whose if: requires the install instead of the sync, or no longer survives a failure"; "RES-PY: a python gate with continue-on-error, and the sync step losing its id" |

## summary

- **L5-1** (`test/unit/tooling/ci-workflow.ts`). `splitStepDrift` gains a one-step-chain rule. It
  reports a gate that runs an `&&` chain as ONE step, other than through the split steps.
  - **Where the chain can come from:**
    - the gate's own `run` contains `&&`; or
    - the gate runs a root script that contains `&&` and is not one of the three `SPLIT_CHAINS`.
  - **What counts as running a root script:** a `run` of `pnpm <script>` or `pnpm run <script>`,
    with or without arguments, where `<script>` is in the root `package.json`. The rule follows a
    root script of that form to the script it runs, and stops at a script it has already visited.
  - **No double report:** a gate already reported as a look-alike split step (for example
    `pnpm typecheck`) is not reported again.
  - **Not checked, stated in the module header with reasons:**
    - the lines of a `run: |` block (the python audit step's lines depend on each other);
    - `;` and `||`;
    - chains inside workspace packages' scripts;
    - root scripts that no gate runs (`test:compose`, `ops:validate-dataset`).
  - **Over-report:** `pnpm audit` resolves to the root `audit` script, not pnpm's built-in. This
    can only over-report.
- **RES-PY** (same module).
  - The gate check now covers `GATED_JOBS`: `node` after `id: install`, and `python` after
    `id: sync`.
  - Each gate needs its own job's `${{ !cancelled() && steps.<id>.outcome == 'success' }}`, the
    key rule (`name`/`if`/`run` only), and both `name` and `run`.
  - Finding labels now name the job, for example `jobs.node step 9 "Lint"` and
    `jobs.python step 4 "Pytest"`.
  - Exports: `nodeJobSteps` is kept as a wrapper of the new `jobSteps(text, job)`. `GATE_IF` has
    the same value.
- **L3-1** (`test/unit/tooling/no-synchronous-spawn.test.ts`).
  - The comment now reads "81 helper modules were tracked at the commit that added this scan. That
    is the 80 of CI-2's base, plus CI-2's own `ci-workflow.ts`, which the list below names."
  - `test/unit/tooling/ci-workflow.ts` was added to the asserted list.
- **`.github/workflows/ci.yml`: comment lines only.**
  - The node CI-2 note mentions the new rule.
  - The python note says the `if:` is pinned.
  - The PyYAML parse is identical to `b452f45`'s.
- **The six new tests are in `ci-step-split.test.ts`, which now has 26 tests.** They use only
  exports that already existed at `b452f45`: `splitStepDrift`, `parseWorkflowYaml`,
  `nodeJobSteps`, `GATE_IF`, `SPLIT_CHAINS`, and the type `YamlValue`. So at `b452f45` they fail by
  assertion, not by a missing import. The python condition is spelled out in the test as
  `SYNC_GATE_IF` rather than imported.

## files_changed

- `test/unit/tooling/ci-workflow.ts`
- `test/unit/tooling/ci-step-split.test.ts`
- `test/unit/tooling/no-synchronous-spawn.test.ts`
- `.github/workflows/ci.yml` (comments only)

## tests_run

All of these were run by me in this round, in `/home/adriancova/proyects/tradeBot/polymarket-bot-ci-2`.
Logs are in `…/scratchpad/ci-2/r1/`.

### The pins fail against `b452f45` (requirement 4)

I restored `test/unit/tooling/ci-workflow.ts` from `b452f45` and kept the new test file. Then I
ran `vitest run … ci-step-split.test.ts` (`proof-old-helper-final.log`):

- Result: exit 1, **6 failed / 20 passed**. The six failures are exactly the six new tests. The 20
  that pass are the pre-existing tests.
- Every failure is an `AssertionError: … expected [] to deeply equal [ … ]`, because the old helper
  returns no finding for any of the mutants:
  - `lint: …`
  - `test:fault: …`
  - the through/in-step case
  - `Pytest: …`
  - `${{ !cancelled() && steps.install.outcome == 'success' }}: …`
  - the continue-on-error/sync-id case
- I then restored my version. `sha256sum -c` matched my saved copy
  (`aad4d470…4dd`), which is the committed blob.

### Implementation mutants of the new code

I ran each mutant against `ci-step-split.test.ts`, then restored the file and checked it with
sha256. All nine were killed:

| Mutant | Failing tests |
| --- | --- |
| no follow through root scripts | 1: the L5-1 through/in-step test |
| no direct `&&` check | 1: the same test |
| no look-alike de-duplication | 1: "an extra split step that is not in any chain" (`pnpm typecheck` would be reported twice) |
| resolver without `run ` | 1: the L5-1 through/in-step test |
| chain looked for only in the first script of the path | 1: the same test |
| one-step-chain rule removed | 3: all three L5-1 tests |
| python removed from `GATED_JOBS` | 3: all three RES-PY tests |
| key rule skipped for python | 1: the RES-PY continue-on-error test |
| python gates checked against the install condition | 17: including the real-file "no drift" test |

### L3-1

- The helper modules tracked under `test/`, counted with the round-0 filter:
  - `9340df6`: 80;
  - `b452f45`: 81;
  - `6da71b2`: 81.
- **Sensitivity of the new asserted entry.** I ran `git rm --cached test/unit/tooling/ci-workflow.ts`
  and then the tripwire file.
  - Result: 1 failed / 6 passed, `AssertionError: expected [ …(80) ] to include
    'test/unit/tooling/ci-workflow.ts'`.
  - The index entry was restored with `git reset -q HEAD -- <path>`. It is identical to the
    `git ls-files -s` output from before, and the file itself is unchanged (sha256).

### ci.yml

- PyYAML 5.4.1 parses the new file, and the parse equals `b452f45`'s: only comments changed.
- The module's reader output equals PyYAML's, after `True`→`on` and scalar→str normalization.

### Behaviour preservation

- I ran `vitest run --config test/vitest.config.ts --reporter=json` at `b452f45`, before any edit,
  and on the final tree:
  - `b452f45`: 7244 tests, all passed, 7244 unique names;
  - final tree: 333 files, 7250 tests, all passed, 7250 unique names.
- **0 removed, 6 added.** All six added names are in `ci-step-split.test.ts`.
- No `expect(` line was removed; `git diff -U0` shows 0 removed lines containing `expect(`.
- No pre-existing test name changed.
- The added lines contain no `eslint-disable`, `.skip`, `.only`, `ts-ignore`, `ts-expect-error`,
  `testTimeout` or `hookTimeout`.
- `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs` and `test/vitest.config.ts` are unchanged.

### Gates (final tree, re-run after the last code change, all exit 0)

| Gate | Exit | Result |
| --- | --- | --- |
| `pnpm run typecheck` | 0 | 34 s |
| `pnpm run lint` | 0 | 8 s |
| `pnpm run check:deps` | 0 | PASS; 34 packages, 80 declared workspace edges |
| `pnpm run test` | 0 | **333 files / 7250 tests passed**, 38 s; no unhandled error |
| `pnpm run test:e2e` | 0 | 7 files / 117 tests |
| `pnpm run test:replay` | 0 | 3 files / 17 tests |

`git status --porcelain --ignored` shows no untracked or ignored leftovers, excluding
`node_modules`.

## assumptions

- **Which gates run a root script.** A gate's `run` of `pnpm <name>` or `pnpm run <name>` runs the
  root package's script `<name>`, because every gate runs at the repository root.
- **What does not count.** A flag before the name (`--filter`, `--dir`, `-r`) runs workspace
  packages' scripts instead, so it is not followed.
- **pnpm built-ins are not modelled.** For `pnpm audit`, pnpm runs its own built-in, not the root
  script. Treating it as the script can only over-report, and this is stated in the module and the
  test.
- **The python gates are exactly the steps after `id: sync`.** Today these are `Pytest` and the uv
  audit step.
- **The `compose` job has one step and no gates.** It is not in `GATED_JOBS`.

## deviations

- **L3-1's pin cannot fail against `b452f45`.**
  - The defect was only in a comment. `b452f45`'s code and assertions behaved correctly, and its
    test passes against every tree.
  - Restoring the affected file from `b452f45` also removes the pin itself, so the procedure in
    requirement 4 has nothing to show.
  - What I did instead:
    - corrected the comment;
    - made the module it names part of the asserted list;
    - showed that this assertion is load-bearing, with the index probe above.
  - I did not tighten `> 50` to `>= 81`. That would fail on any legitimate removal of a helper
    module. The bound is a non-vacuity floor, not a census.
- **Scope added to L5-1 beyond the reviewer's minimal fix.**
  - A chain written directly into a gate's `run` (`&&`) is reported. This is the same hazard,
    written in `ci.yml`.
  - Root scripts are followed through `pnpm [run] <script>`, so `test:fault := pnpm typecheck` is
    caught. The look-alike check cannot see that case from the step.
  - Both extensions are in the allowed paths, and both are pinned.
- **Finding labels changed from `step N "…"` to `jobs.<job> step N "…"`.** No test name changed.
  The existing tests build their expected messages from `nodeJobSteps(...).label`, so they follow
  the change unchanged.

## known_risks

- **Package-level chains remain.** The one-step-chain rule does not look into workspace packages'
  scripts. Today every package's `typecheck` is `tsc --noEmit && tsc --noEmit -p …`, and
  `Typecheck 1/4` (`pnpm -r run typecheck`) runs them all as one step, where pnpm's recursive run
  stops at the first failing package by default. This is pre-existing. The manifests are outside
  the allowed paths (`packages/**`, `apps/**`), and the gap is stated in the module's NOT CHECKED
  list. Whether to split `pnpm -r run typecheck` per package (or run it with `--no-bail`) is a
  decision beyond this package.
- **The rule is textual.** `&&` inside a quoted argument of a root script run by a gate would be
  reported. That is an over-report, and it fails loudly.
- **`GATED_JOBS` is a fixed list.** A new job with gates must be added to it deliberately. A new job
  is still required to set `timeout-minutes` by `jobTimeoutFindings`.
- **Carried over from round 0:** the CI side is unobserved, so there is no GitHub Actions run of
  this `ci.yml` yet, and `actionlint` is not installed.

## follow_up

- **The orchestrator:** the PR run for `ci-2` still has to show a green GitHub Actions run with the
  14 split steps and the three job timeouts, as the CI-2 row requires.
- **Optional, a separate decision:** package-level `typecheck` chains under `pnpm -r run typecheck`
  (see known_risks).
- **`LINT-1` (`CI1-L2`)** follows after CI-2 merges.

## commit_sha

`6da71b20937dd30c964b4a1d4664290f2c17a8c7` (branch `ci-2`, one commit on top of `b452f45`; not
amended, not rebased, not pushed)
