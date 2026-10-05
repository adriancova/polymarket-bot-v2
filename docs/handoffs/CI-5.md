# CI-5: run the OMS and reconciliation fault suites, and the control-api PostgreSQL suite, in CI

**Status:** Complete (2026-10-05). Merged `31b668d` (PR #66; CI run `37272422566` green, with the new steps executed on the runner).
**Reviewer:** Codex gpt-6-astra. ACCEPT at round 1 on `2e7b14b`.
**Base:** `23206f5`.
**Paths:** the root `package.json` scripts, `.github/workflows/ci.yml` and `test/unit/tooling/**`.

## summary

1. **The fault chain.** The root `test:fault` runs three suites, in order: storage-wal, then `oms test:fault` (`WP-270`), then `ledger test:fault:reconciliation` (`WP-290`).
   - CI runs each suite as its own gated step, "Fault-injection tests 1/3" to "3/3", in place of the single WAL step.
   - The drift pin's L5-1 rule requires the split, and a red OMS suite can no longer hide the reconciliation suite.
2. **The control-api PostgreSQL suite.** `pnpm --filter @polymarket-bot/control-api test:integration:postgres` is command 7/7 of the root `test:integration` chain. CI runs it as "Integration tests 7/7".
   - It uses the same helper and `postgres:16.6-alpine` image as step 1/7, so there is no new image pull and no secret.
   - It closes `CONTROL-2` follow_up 2 and the `CONTROL1B-LOWS` CI item.
3. **The drift pin** (`ci-step-split.test.ts`, `ci-workflow.ts`).
   - It expects 4 + 6 + 7 + 3 chained commands, 27 gates and 20 split steps.
   - A new test pins the exact commands, their order and the step names.
   - `CHAIN_WORD` gains `test:fault`.

## tests_run
- **Gates**, all exit 0:
  - typecheck, lint and check:deps;
  - unit: 485 / 11056;
  - the new `test:fault` chain: storage-wal 11/89, OMS 1/7, reconciliation 64/848, in 19 s;
  - the control-api PostgreSQL suite: 4 files / 31 tests, 6 of 6 green, including under CPU pinning and load.
- **Mutation:** 8 mutants against the pin, all failing it. The files were restored and checked with `sha256sum -c`.
- **The full local `test:integration` chain:** trader failed once on the deferred `TC-LOCAL-FLAKE` (a late port under host load). It passed re-run alone.
- **CI:** GitHub CI on the PR #66 merge ref was green before the merge. It is the first real run of the new steps on a GitHub runner.

## deviations
- **The PostgreSQL suite joins the root `test:integration` chain** rather than standing as a free step, so the drift rules pin it. A local `pnpm test:integration` now runs it too.
- **The L5-1 and DEPCHECK-1 test cases now use `test:replay`,** since `test:fault` is now a split chain.

## known_risks
- **Two tight bounds in the PostgreSQL suite,** each with about 2 s of slack: CTL2-F1's locked scrape window and the slow-read test.
- **The node job's timeout margin** is about 2.7 to 3 times its duration, below CI-2's 6x rule. It is unchanged here.
- **Stale text outside these paths** still names the old single WAL fault step, for example `docs/contracts/wal-format.md` §14.

## follow_up
1. **A docs touch:** the stale step names.
2. **A CI-tuning round:** the node job's timeout margin.

## commit_sha
`2e7b14b`
