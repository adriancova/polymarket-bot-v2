# CI-6: run the Wave 3 live fault suites in CI

**Status:** Complete (2026-10-05). Merged `46aba42` (PR #75; CI run `37413210760` green).
**Reviewer:** Codex gpt-6-astra. ACCEPT at round 1 on `1f040d5`.
**Base:** `f0243f7` (= `main`).
**Paths:**
- the root `package.json` (`scripts` only);
- `.github/workflows/ci.yml`;
- `test/unit/tooling/**`.

## summary

1. **The root `test:fault` chain** runs six Docker-free commands:
   1. storage-wal;
   2. OMS (WP-270);
   3. reconciliation (WP-290);
   4. `pnpm --filter @polymarket-bot/trader test:fault:live-safety` (WP-320, 74 tests);
   5. `tsc --noEmit -p test/fault-injection/live/tsconfig.json` (WP-340);
   6. `vitest run --config test/fault-injection/live/vitest.config.ts` (WP-340, 95 tests).

   Commands 5 and 6 run bare from the root, as `typecheck`, `test`, `test:e2e` and `test:replay` already do.
2. **The root `test:integration` chain** gains WP-340's PostgreSQL half as command 8/8: fencing with two writers, 4 tests. It reuses the same Testcontainers helper and `postgres:16.6-alpine` image as 1/8 and 7/8, as CI-5 did for the control-api PostgreSQL suite.
3. **CI:** one step per new command: "Fault-injection tests 4/6–6/6" and "Integration tests 8/8". CI-5's steps are renumbered.
4. **The drift pin** `test/unit/tooling/ci-step-split.test.ts` pins 4 + 6 + 8 + 6 chained commands, 31 gates and 24 split steps, with exact commands, names, order and 8/8's adjacency to 7/8. All 17 file-level mutants fail it.
5. **Cost:** about 1–2 minutes of CI. The node job runs about 12.5–19 min against its 30-min timeout.

## tests_run
- **The implementer:** typecheck, lint, check:deps, test (11,893), the drift pin (33/33), and the new `test:fault` chain, twice: 89 + 7 + 848 + 74 + the typecheck + 95. Also control-api `test:integration` (310), and the live PostgreSQL half 17 of 19 green: one container-start flake, and one timing loss at host load 23–29.
- **The verifier:** every gate, independently; ACCEPT with one LOW.
- **The orchestrator:** gated TRADER-SIGNALS combined with this round before merging either.
- **CI:** the PR #75 merge ref was green before the merge.

## known_risks
- **CI6-R1-L1 (LOW).** The PostgreSQL half's fence lease runs on a 10× time line, about 150–180 ms of real time. A lease renewal slower than that loses the holder's own fence: safe, but the test then fails with "A holds no fence". The fix belongs in `test/fault-injection/**`, and retrying the step would hide a real fence failure.
- **The node job's timeout margin** is about 1.6–2.4×, below CI-2's 6× rule. Retuning it is CI-5's follow-up 2.
- **A stale step label:** "Integration tests 3/8 — research-worker parquet (no container)".

## follow_up
1. **A small test round:** give the live PostgreSQL half's lease more real-time margin, if CI ever shows the timing loss.
2. **CI-5's follow-up 2:** the node job's timeout.

## commit_sha
`1f040d5`
