# FLAKES-1: make the known load-sensitive tests deterministic

**Status:** Complete (2026-10-04). Merged `e476a49` (PR #61; CI run `37220019881` green). It closes `FLAKE-CANONICAL-ORDER` and the "TWICE pace" flake in `WALCAP-LOWS`. `TC-LOCAL-FLAKE` stays open, deferred with its measured cause.
**Reviewer:** Codex gpt-6-astra. ACCEPT at round 2 on `8adeea4`.
**Base:** `4f75924`. The branch merged `main` at `79c113c` before the PR.
**Paths:** tests and test support only.

## summary

1. **`FLAKE-CANONICAL-ORDER`** (`packages/features/src/canonical-order.test.ts`).
   - **The fix.** Each loop now collects its disagreements and asserts once, instead of running one `expect` per value, which was about 85% of the cost. Comparisons use `Object.is`, the same equality as `toBe` (round 1).
   - **What is kept.** The exhaustive 1,002,001-pair sweep still makes every oracle call, under an explicit, measured 60 s budget.
2. **`machine-closure` and `boundary-surface`.**
   - `machine-closure`: the strategy's parameters are parsed once per sweep, not once per evaluation.
   - `boundary-surface`: the TypeScript program is built once, in `beforeAll`, under a measured budget.
   - Inputs, oracles and decisions are unchanged.
3. **The "TWICE its recorded pace" throughput test.**
   - **The cause.** The driver and the publisher share one thread. While it waited for a CPU, the wall-clock schedule kept advancing, so the next turn admitted the whole gap at once.
   - **The fix.** `publish-bench.ts` gains an opt-in "runnable" clock: wall time minus this thread's run-queue wait, from Linux `schedstat`. The test uses it. The benchmark CLI's default stays wall time.
   - **It still catches regressions.** Base `051d058` still overflows, 5 of 5 idle and 5 of 5 under load, and three publisher mutants are each caught.
4. **`TC-LOCAL-FLAKE`: deferred** (governance `79c113c`).
   - **The cause.** Under load, Docker Desktop's WSL port proxy publishes container ports minutes late, and testcontainers' own 120 s wait fails in unchanged code.
   - **What stays.** The bounded readiness helpers: a RESP PING or a PostgreSQL SSLRequest answered within 30 s, and a reaper-only retry with at most 3 attempts. They are never weaker than base.

## Rounds

| Round | Candidate | Verdict | Blocking findings |
|---|---|---|---|
| 0 | `008c1d5` | (stopped item 4) | Item 4 deferred by the orchestrator |
| 1 | `008c1d5` | CHANGES REQUIRED | FLAKES1-R1-01 HIGH: `!==` treats -0 as +0, so the sampled oracle was weaker than `toBe` |
| 2 | `8adeea4` | **ACCEPT** | none |

## tests_run

- **Under load**, with 20 busy processes pinned to CPUs 0–3:

  | Test | Base | Candidate |
  |---|---|---|
  | The unit trio | 0 of 10 | 20 of 20 |
  | The throughput test's item 1 | 0 of 10 | 20 of 20 |
  | Trader container files | — | 6 of 12 (item 4, deferred) |

- **Gates, all exit 0:**
  - typecheck, lint and check:deps;
  - unit: 483 / 10990;
  - data-gateway integration: 15/108;
  - trader integration: 40/291.
- **Mutation:** six unit mutants and three publisher mutants, all caught. A -0 comparator mutant is caught by the round-1 pin.
- **CI:** GitHub CI on the PR #61 merge ref was green before the merge. That run also exercised the runnable clock on `ubuntu-latest`.

## deviations
- **The load budget.** It ran 4 min over the 45-minute cap once round 1's check is counted (49 min in total).

## known_risks
- **The runnable clock** credits run-queue wait caused by load on other threads, and falls back to wall time off Linux.
- **The inherited exhaustive loop** still compares with `!==`, as base did. Equal pairs in the sample catch a general -0. A one-operator strengthening is optional.
- **`TC-LOCAL-FLAKE` stays open.**

## follow_up
1. **A test-infrastructure round:** serialize container start-up across workers, and cap the container files' parallelism (`TC-LOCAL-FLAKE`).

## commit_sha
`8adeea4`
