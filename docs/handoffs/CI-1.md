# CI-1: the first real CI run's failure; GATE1-R4; N5

Branch `ci-1`, one commit `fad38e2` on base `5d8b24f`, merged into `main` as
`7248073` (`--no-ff`) on 2026-09-26. Authorized the same day by the user,
after the repository gained its first git remote
(`git@github.com:adriancova/polymarket-bot-v2.git`).

| Commit | Content |
| --- | --- |
| `fad38e2` | the round: async child processes in four test files, the tripwire, the `ci.yml` gate conditions and label. Reviewed as-is. |
| `7248073` | the merge. Its tree is byte-identical to `fad38e2`. |

## Why the round existed

The first GitHub Actions run, `36279491795` (a push of `926cd08`), failed the
"TypeScript quality gates" job at "Unit tests". Every test passed: 331 files,
7217 tests. Vitest then reported one unhandled
`Error: [vitest-worker]: Timeout calling "onTaskUpdate"` and exited 1. The
node job was one fail-fast chain, so the seven gates after it (e2e, replay,
fault, contract, soak-smoke, audit, integration) were SKIPPED. That is
`GATE1-R4` as predicted.

**Cause.** The worker and the main process talk over an RPC channel (birpc)
whose calls time out after 60 s (`DEFAULT_TIMEOUT = 6e4`).
`test/unit/tooling/dependency-direction.test.ts` ran the dependency checker
through `spawnSync` in each of its 187 tests and took 82 s on the runner. A
file of back-to-back synchronous tests never yields the worker's event loop,
so the reply to a status update queued early in the file sits unread. When
the loop finally turns, Node runs expired timers before it reads I/O, and the
call times out even though the answer has arrived. On the laptop the file
finished in under 60 s, which is why no local run ever showed it.

## summary

- Every synchronous child-process call in a test file is now an awaited
  async one, with the same commands and assertions:
  - `dependency-direction.test.ts`: a new `spawnNode(args, cwd)` built on
    `spawn`, returning the same `status`/`stdout`/`stderr`/`error` fields
    `spawnSync` did. It keeps the 1 MiB per-stream cap, and a `liveChildren`
    set is killed in `afterAll`.
  - The three decimal files: `promisify(execFile)`, the exact async
    counterpart of their old blocking calls.
- The five tests that ran the checker over the whole repository now share two
  runs (text and `--json`). A `beforeAll` starts both with an explicit 30 s
  ceiling.
- The tripwire, `test/unit/tooling/no-synchronous-spawn.test.ts` (4 tests):
  it fails if `spawnSync`, `execSync` or `execFileSync` appears in any tracked
  `*.test.ts`, and its message states the reason and cites run `36279491795`.
- `ci.yml`, **GATE1-R4**: every node gate is
  `if: ${{ !cancelled() && steps.install.outcome == 'success' }}`, and the
  python job's two gates are conditioned the same way on `steps.sync`. One red
  gate no longer hides the gates after it, and the job still ends red.
- `ci.yml`, **N5**: the integration label says three suites need Docker
  (postgres, event-bus, paper-trader). The old label said two.

## files_changed

- `test/unit/tooling/dependency-direction.test.ts`
- `test/unit/tooling/no-synchronous-spawn.test.ts` (new)
- `test/unit/decimal/arithmetic-fold.test.ts`: describe timeout 60 → 70 s
  (`FOLD_TEST_TIMEOUT_MS`), so the 60 s spawn timeout fires first.
- `test/unit/decimal/index-name-pollution.test.ts`: `PROBE_CEILING_MS`
  20 s; the four probe tests get `PROBE_TEST_TIMEOUT_MS` 30 s.
- `test/unit/decimal/unneutralizable-shapes.test.ts`
- `.github/workflows/ci.yml`

## tests_run

**The mechanism, reproduced by the implementer and again by the reviewer:**

| Probe | Result |
| --- | --- |
| 65 × `spawnSync("sleep",["1"])` (implementer) | 65 passed, `Timeout calling "onTaskUpdate"`, exit 1 |
| the same work, awaited `execFile` | 65 passed, exit 0 |
| real file, old, each checker child slowed 400 ms (implementer) | 187 passed, 1 error, exit 1, 112.9 s |
| real file, new, same slowdown | 187 passed, exit 0, 107.3 s |
| real file, old, slowed 250 ms (reviewer) | 187 passed, 1 error, exit 1, 85.05 s |
| real file, new, same (reviewer) | 187 passed, exit 0, 79.55 s |
| 34 × `Atomics.wait` 2 s in the worker, no child process (reviewer) | 34 passed, same error, exit 1 — see `CI1-L3` |

The implementer ran a 10 ms interval timer in the worker. It ticked 0 times in
38.7 s during the old dependency-direction file and 2933 times in 31.5 s
during the new one; the longest gap was 244 ms.

**Behaviour preserved.** Unit went from 331 files / 7217 tests to
332 / 7221; the only additions are the tripwire's file and its 4 tests, and
every earlier test name is identical and passing. The reviewer applied four
checker mutants (exit always 0; text forced PASS; JSON forced ok; failure in
the repository run only) and three decimal-helper mutants (wrong output,
forced exit 7, hang), running the OLD and NEW files side by side. The failing
test sets were identical in every case. `spawnNode` was compared field by
field against `spawnSync` for exit 3, SIGKILL, a missing cwd, 2 MiB overflow,
exactly 1 MiB, multibyte UTF-8 split across chunks, and stdin.

**Gates.** Implementer and reviewer each ran them locally, all exit 0:
typecheck; lint; check:deps (34 packages / 80 edges); unit 332 / 7221 (the
reviewer ran it twice, no flakiness); e2e 6 / 78; replay 3 / 17; fault
11 / 89; contract 6/637 + 6/65 + 9/158 + 7/95; audit (2 moderate, below the
`high` threshold); soak-smoke 1 / 5.

**On GitHub.** PR #1 run `36282501033` (`pull_request`, head `fad38e2`):
all three jobs `success`. Every node gate passed, including all six
integration suites with Testcontainers on the runner, as did the compose
health job and the python job. Unit was 332 / 7221 with no unhandled error;
`dependency-direction.test.ts` took 80.1 s on the runner. **This is the first
CI evidence the repository has ever had** (`H2` DISCHARGED).

**Post-merge** on `main` `7248073`: unit 332 / 7221, exit 0, no RPC error.

## assumptions

- The spawned children never read stdin, so dropping
  `stdio: ["ignore", …]`, which `execFile` does not accept, changes nothing.
  The implementer checked by grep and the reviewer by probe.
- All `ci.yml` gates are independent after install: every typecheck is
  `--noEmit`, and suites that need a bundle build it inside their own tests.
- `git` is available wherever the unit tests run. The tripwire lists files
  with `git ls-files` and fails loudly if it cannot.

## deviations

Accepted by the reviewer:

- The python job's two gates received the same `if:` change as the node job.
- Three failure-path safeguards the packet did not ask for:
  - child processes still running when the dependency-direction file ends
    are killed;
  - test timeouts were raised above the spawn ceilings;
  - the 1 MiB output cap was re-implemented.

  These change test configuration, not assertions.
- On success, index-name-pollution's probe stderr is captured and dropped
  instead of being echoed to the worker. On failure it is still included in
  the error.

## Review

One round, by the independent Claude adversarial reviewer: **ACCEPT**, with
0 CRITICAL, 0 HIGH, 0 MEDIUM and 5 LOW. Every LOW is queued in
`IMPLEMENTATION_STATUS.md` `## Open blockers` with an owner:

| Id | Finding |
| --- | --- |
| `CI1-L1` | A slow shared repository run hides all 187 tests, not just the five readers: the `beforeAll` hook times out and every test is skipped. A REJECTED run behaves as documented: exactly the five readers fail, and there is no unhandled rejection. |
| `CI1-L2` | No lint or type check catches a floating promise in a test. The ESLint config has no type-aware rules, and it is a protected path. |
| `CI1-L3` | The real limit is about 60 s of synchronous work per file of ANY kind, not only child processes. Untracked files and helper modules are not scanned, and unit tests now need `git`. |
| `CI1-L4` | index-name-pollution's 30 s test timeout covers one 20 s spawn, but the first probe test can make four. |
| `CI1-L5` | `GATE1-R4` holds per step only: the `&&` chains inside `test:integration`, `test:contract` and `typecheck` remain, and no job sets `timeout-minutes`. |

The reviewer did not verify:

- `ci.yml`'s red-gate path on real GitHub. Only an all-green run exists, so
  that behaviour is reasoned from GitHub's documented `!cancelled()`
  semantics.
- The implementer's own timings. The reviewer reproduced the result at a
  different slowdown instead.

## known_risks

- The `ci.yml` failure path has not been observed on GitHub (see Review).
- The tripwire is a text match and misses a function name assembled at run
  time. The broader per-file synchronous-time hazard is `CI1-L3`.
- The 30 s shared-run ceiling came from laptop measurements (1.2 s alone,
  2.7 s under the full suite). The runner has not come close to it.

## follow_up

- `CI1-L1` … `CI1-L5`, as queued.
- One CI step per integration and contract suite (`CI1-L5`). The scripts live
  in the protected root `package.json`, so that needs a grant or duplicated
  commands in `ci.yml`.

## commit_sha

`fad38e25b317f506b71dd6f2c9f48020018139e4` (branch `ci-1`), merged as
`7248073`.
