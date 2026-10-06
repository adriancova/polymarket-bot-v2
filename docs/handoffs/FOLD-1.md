# FOLD-1: the ledger view and PnL state held incrementally (LOOPMEM-FOLD Option 2)

Branch `fold-1` on base `8d64bec`, merged into `main` as `2c0bd21` (`--no-ff`) on 2026-09-27.

- **Authorization:** the user, "let's proceed with loopmem-fold".
- **Scoping:** read-only, workflow `wf_b527845c-ad5` (four lenses plus a synthesis, with REPRODUCED measurements). It found a CPU problem, not a memory problem.
- **Options:** the user chose Option 2 (F1), with a PAPER check every 50 fills plus shutdown and a halt on mismatch (F2), and a visible counter for a refused PnL record (F3).
- **Orchestrator reading of §6 invariant 8 (no ADR):** an incremental state is allowed if a from-zero rebuild equals it and is run as a check. That is the wording of ADR-006:48-51, handoff §16.2, the Phase-2 gate, and WP-200's acceptance.
- **Orchestrator call (O1):** the test and golden harnesses check after every fill; real backtests use the PAPER cadence.
- **Process:** the HARDENING LOOP (workflow `wf_695d8814-aff`): an Opus implementer; gates run outside any sandbox, including a gate that checks `test/replay-golden/` and `packages/` are byte-identical; Codex gpt-6-astra verification.

| Commit | Content |
| --- | --- |
| `b0403c6` | r0 |
| `1e6e057` | r1: `FOLD1-R1-1`, `R1-2` and `R1-3` (all MEDIUM) |
| `2c0bd21` | the merge (tree identical to `1e6e057`) |

## Outcome
- **`HeldAccounting`** (`apps/trader/src/folds.ts`) holds the ledger and its view together, and `adopt()` is their only writer.
  - At both posting sites (owned and unowned fill), `fold()` applies `posted.appended` with `packages/ledger`'s exported `applyTransaction` BEFORE anything is adopted.
  - A fold that throws, or that miscounts `posted.ledger.length`, is a failed posting at stage `VIEW_FOLD`, which halts the market with `LEDGER_POSTING_REFUSED`.
- **The four read sites** read the held view. `haltOnLedgerProjection` still gets the WHOLE view, so the TRDR-4 unowned-fill halts are unchanged.
- **Held PnL** per instance, advanced with `applyPnlRecord` on new records only, retrying from the failure point.
  - A refused record stops that instance's snapshots at exactly the same fill as base; probes compared the snapshot fills with base.
  - F3 counts each refused record once, by instance and code.
  - A PnL check covers the WHOLE record stream: it catches up a stream left behind by a store failure (`R1-1`).
- **Rebuild checks** compare serialized bytes (`serializeProjection` / `serializePnlState`). A mismatch is counted, latches a GLOBAL halt `ACCOUNTING_REBUILD_MISMATCH` (`FULL_HALT`), and replaces the held state with the rebuild.
  - PAPER: every 50 fills, plus shutdown (`main.ts`, after the pump stops).
  - Real backtests: every 50 fills, plus end of run (`runBacktest`). A real-core backtest cannot omit its final check (`R1-3`).
  - Test and golden harnesses: ledger AND PnL after every due fill, including unowned fills and the store-failure return (`R1-2`).
- **Health:** a new `seams.folds` key only. The control-api strict door, its fixture and the health-shape pins are updated. The door accepts any halt-code string.
- **`packages/**` is untouched.** `projectLedger` and `foldPnlRecords` stay pure and uncached.
- **The goldens are BYTE-IDENTICAL**, and the e2e and backtest goldens now run WITH every-fill checks on.

## Measurements (one WSL2 machine, same harness)

| | base | after |
| --- | --- | --- |
| ~1e3 tx, per event (mean) | 1,952 ms | 54.7 ms |
| ~1e3 tx, per fill | 195 ms | 5.5 ms |
| ~1e4 tx, per event (mean) | 13,417 ms | 104 ms (median 38.7) |
| ~1e4 tx, per fill | 1,342 ms | 10.4 ms |
| PnL per fill, ~1e3 records | 80.5 ms | 0.31 ms |
| `projectLedger` calls per event | 33 | 0.2 |

One PAPER ledger check costs 64 ms at 1,602 tx and 399 ms at 10,182 tx.

## Reviews (Codex gpt-6-astra)
- **r1 of `b0403c6`: CHANGES REQUIRED, 3 MEDIUM** (`R1-1` stale PnL passes the end-of-run check; `R1-2` unowned fills skip per-fill PnL checks; `R1-3` a real-core backtest can omit its final check).
- **r2 of `1e6e057`: ACCEPT, no findings.** It confirmed byte-for-byte restoration of 1,369 tracked blobs. Residuals:
  - memory is unbounded;
  - the incremental PnL work still grows with retained state (`FOLD-2`);
  - a periodic ledger rebuild pauses the loop synchronously (about 0.4 s at 1e4 tx);
  - the first GLOBAL halt keeps its reason, and later mismatches show only in the counters.

## Evidence
- Verification gates at `1e6e057`, outside any sandbox:
  - typecheck 0, lint 0, check:deps PASS;
  - unit 344 / 7473;
  - e2e 7 / 157;
  - replay 3 / 17;
  - control-api integration 10 / 87;
  - goldens and `packages/` byte-identical.
- **Docker was unavailable in this session.** The trader Testcontainers suite ran green on GitHub: PR #9 run `36378622192`. The unit step took 187 s there (`FOLD1-SLOWTEST`).
- Post-merge on `2c0bd21`: e2e 7 / 157, replay 3 / 17.

## Queued
- `FOLD1-SLOWTEST`: trim the 1,000-fill pin.
- `FOLD-2`: constant-cost PnL steps.
- Memory bounding, which is Option 4: behind `RECON2-DURABLE` and an ADR-006 amendment.
- `FOLD-RELATCH`, `FOLD-PNL2TOKEN`, `FOLD-OVERSELL`: queued at authorization.

## commit_sha
`1e6e0571e32a94ed03e4542127106f2bc0220be2` (branch `fold-1`), merged as `2c0bd21`.

---

# Appendix A — implementer handoff, r0 (verbatim)

# FOLD-1 handoff, round 0 (first implementation)

## plan (written before any edit)

Base `8d64bec` (= main), worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-fold-1`, branch `fold-1`, clean.

Prerequisites verified at base:
- `packages/ledger` exports `applyTransaction`, `emptyProjection`, `projectLedger`, `serializeProjection` (index.ts:103-110). The per-transaction step EXISTS, so no stop.
- `packages/pnl` exports `applyPnlRecord`, `emptyPnlState`, `foldPnlRecords`, `serializePnlState` (index.ts).
- `Ledger.length` is a public O(1) field (ledger.ts:105), so "view and ledger moved together" can be asserted at adoption as `view.transactionCount === ledger.length`.
- Read sites at base: loop.ts:1335 (#positionView), :1510 (#routeIntent), :1706 (#submitPlan), :2452 (#readProjection). `#ledger` assignments: :603 (ctor), :2251 (owned fill), :2415 (unowned fill). `#pnlRecords` :593, append :2265-2274, `#writePnlSnapshot` :2590-2629.
- The control-api door admits any halt `code` string (`z.string().min(1).max(128)`), so no halt vocabulary change is needed there.
- `test/e2e/support/artifact.ts` copies `health.seams` KEY BY KEY (:580-591), so a new seam does not reach the paper-e2e golden; the backtest artefact renders only named counters and the halts list.
- Docker: NOT available (`docker` not found in this WSL distro). The trader Testcontainers files cannot run locally; the non-Docker trader integration files can be run individually.

Design:
1. New module `apps/trader/src/folds.ts`: the held ledger view helper (`foldPosting`: fold `posted.appended` onto the held view with `applyTransaction`, total, and refuse unless `view.transactionCount === posted.ledger.length`), per-instance held PnL streams (`{state, applied, seen}`, advanced by `applyPnlRecord` with RETRY-FROM-FAILURE, F3 counted once per refused record, by instance and code), the rebuild checks (`projectLedger` + `serializeProjection`; `foldPnlRecords` + `serializePnlState`, and on a refused stream: the from-zero fold must refuse at the same index with the same code), the cadence option (`AccountingChecks {everyFills, pnl}`; PAPER default `{50, false}`; test `EVERY_FILL_ACCOUNTING_CHECKS = {1, true}`) and the `seams.folds` counters.
2. `loop.ts`: hold `#ledgerView` (one `projectLedger` in the ctor). At both posting sites the postFill outcome passes through `foldPosting`; a fold failure becomes a failed posting with stage `VIEW_FOLD` and goes down the SAME failure branch (ledgerRefusals + MARKET `LEDGER_POSTING_REFUSED`); on success the view and the ledger are adopted together in one method. The four read sites read `#ledgerView`; `haltOnLedgerProjection` still gets the whole view. `#writePnlSnapshot` keeps its timing and early returns but reads the held stream (opened lazily there, so a bad identity still throws from the same place as base). `#pnlRecords` and every accessor are unchanged; a new read-only `ledgerView()` accessor.
3. Checks: after every K-th adopted posting, the ledger check (right after adoption); the PnL check (when enabled) of every held stream after the fill's `#writePnlSnapshot`; `checkAccountingRebuild("SHUTDOWN" | "END_OF_RUN")` public for the final check. A mismatch: counted, GLOBAL halt `ACCOUNTING_REBUILD_MISMATCH` (action FULL_HALT), and the held state is REPLACED by the rebuild so later accounting reads and snapshots are the truth.
4. New halt code in `halt.ts` (+ `halt.test.ts` vocabulary pin). New optional `SeamHealth.folds` in `health.ts`; `LoopHealthSnapshot` always carries it.
5. Wiring: `CoreLoopOptions.accountingChecks`, `CreateTraderOptions.accountingChecks` (validated by name, TOTAL). `main.ts` runs the SHUTDOWN check after the pump stops. `apps/backtest-cli`: `ReplayDrivenLoop.checkAccountingRebuild?`, `ReplayDrivenCoreLoop.endOfRun()`, `BacktestRunOptions.endOfRun?` called by `runBacktest` after `runReplay`.
6. Harnesses pass `EVERY_FILL_ACCOUNTING_CHECKS` in code: `test/e2e/support/harness.ts`, `test/unit/simulation/backtest-replay-support.ts` (+ `endOfRun`), `test/integration/paper-trader/support/fixture.ts`, and the apps/trader unit harnesses (`loop-long-run`, `loop-refused-plan`, `loop-order-lifecycle`, `order-provenance`).
7. control-api: `health-door.ts` strict `folds` schema, `testing/index.ts` fixture, `health-door.test.ts`, and the control-api integration health-shape pins; `halts-reservations-and-seams.test.ts` seam-key list.
8. Tests: a new `apps/trader/src/loop-folds.test.ts` (held==rebuilt over a 1,000+ fill run with per-fill checks, PAPER cadence at 50/100/... plus end of run, corrupted held view -> GLOBAL halt, broken advance (vi.mock skip) -> GLOBAL halt, fold failure -> posting failure, PnL refusal parity + F3 counter, projectLedger call count per event); a held==rebuilt pin in `test/integration/paper-trader/`.
9. Measurements (item 7) by a scratch probe at base first, then after.

## summary

FOLD-1 is implemented in `apps/trader` with the wiring the packet allows. The loop now holds its ledger view and per-instance PnL state and advances them in place. The goldens are byte-identical (`git diff 8d64bec -- test/replay-golden/` is empty).

- **(1) Held ledger view.** New module `apps/trader/src/folds.ts`, class `HeldAccounting`, holds the ledger and its view together. It uses `packages/ledger`'s exported `applyTransaction`, confirmed exported at `packages/ledger/src/index.ts:103`.
  - At both posting sites (the owned fill in `#harvestFills`, the unowned fill in `#bookUnownedFill`), the `postFill` outcome goes through `HeldAccounting.fold()`. That folds `posted.appended` onto the held view BEFORE anything is adopted.
  - A fold that throws, or whose result does not count `posted.ledger.length` transactions, becomes a failed posting at stage `VIEW_FOLD` (`LEDGER_VIEW_FOLD_FAILED` / `LEDGER_VIEW_OUT_OF_STEP`). It takes the SAME failure branch as a `postFill` failure: `ledgerRefusals`, then MARKET `LEDGER_POSTING_REFUSED`.
  - `HeldAccounting.adopt()` is the ONE writer of both the ledger and the view.
  - The constructor runs the one `projectLedger` outside the checks.
- **(2) The four read sites** (`#positionView`, `#routeIntent`, `#submitPlan`, `#readProjection`) read the held view. `haltOnLedgerProjection` still receives the whole view. `projectionOf` is no longer called by the loop; it is still exported for the harnesses.
- **(3) Held PnL per instance.** It is advanced in `#writePnlSnapshot`, at the same point and with the same early returns as before, using `applyPnlRecord` on only the unfolded records, with RETRY-FROM-FAILURE. The stream is opened lazily there, so a PnL-refused identity still throws from the same place as base. `#pnlRecords` and every accessor are unchanged. F3 counts each refused record ONCE, by instance and code.
- **(4) Rebuild checks.**
  - The ledger view is compared with `projectLedger(ledger)` on `serializeProjection` bytes after every K-th posted fill (default K = 50) and at `CoreLoop.checkAccountingRebuild("SHUTDOWN" | "END_OF_RUN")`.
  - With `pnl` on, every held stream is also compared with `foldPnlRecords`: `serializePnlState` bytes, or the same refusal index and code from the same prior state.
  - A mismatch is counted, latches a GLOBAL `ACCOUNTING_REBUILD_MISMATCH` halt (action `FULL_HALT`, new in `halt.ts`), and replaces the held state with the rebuild.
  - Cadence is `CoreLoopOptions.accountingChecks` / `CreateTraderOptions.accountingChecks`, set in code and refused by name when invalid. The defaults are `PAPER_ACCOUNTING_CHECKS = {everyFills: 50, pnl: false}` and, for tests, `EVERY_FILL_ACCOUNTING_CHECKS = {1, true}`.
  - `main.ts` runs the SHUTDOWN check once the pump stops. A mismatch exits `halted`.
  - `apps/backtest-cli`: `ReplayDrivenLoop.checkAccountingRebuild?`, `ReplayDrivenCoreLoop.endOfRun()`, and `BacktestRunOptions.endOfRun`, which `runBacktest` calls once after `runReplay`.
  - The e2e harness, the backtest replay support, the paper-trader fixture and four apps/trader unit harnesses pass `EVERY_FILL_ACCOUNTING_CHECKS` in code.
- **(5) Health.** A NEW `health.seams.folds` key: `checkEveryFills`, `pnlCheck`, `fillsPosted`, `ledgerChecks`, `pnlChecks`, `fillsAtLastCheck` (null before the first), `ledgerMismatches`, `pnlMismatches` and `pnlRefusals` (instance -> code -> count). Nothing was added under `loop`, `execution` or `accounting`. `test/e2e/support/artifact.ts` copies seams key by key, so the new seam never reaches the golden. The control-api strict door requires the new seam; its fixture, the door tests and the three control-api integration health-shape pins were updated. No control-api halt vocabulary exists: the door admits any code string.
- **(6)** `packages/**` is untouched. `projectLedger` and `foldPnlRecords` are unchanged and uncached.
- **(7) Measurements** (same harness, base `8d64bec` vs FOLD-1 at PAPER cadence; scratch probe `probes/perf.probe.ts`; one WSL2 machine, growth shape rather than a benchmark):

| Case | Base | FOLD-1 |
|---|---|---|
| ~1e3 tx (1,002 → 1,602 tx, 20 events, 200 fills): per-event mean / median | 1,952 / 1,985 ms | 54.7 / 42.1 ms |
| ~1e3 tx: per-fill | 195.2 ms | 5.47 ms |
| ~1e3 tx: `projectLedger` calls per event | 33.0 | 0.20 (checks at fills 50/100/150/200) |
| ~1e3 tx: `projectLedger` ms per event | 1,730 | 11.3 |
| ~1e4 tx (10,002 → 10,182 tx, 6 events, 60 fills): per-event mean / median | 13,417 / 13,455 ms | 103.9 / 38.7 ms |
| ~1e4 tx: per-fill | 1,342 ms | 10.4 ms |
| ~1e4 tx: `projectLedger` calls per event | 33.0 | 0.17 (one check at fill 50) |
| PnL per fill at ~1e3 instance records (940..1,000) | 80.5 ms | 0.306 ms |
| Total per fill at the same point | 250.9 ms | 5.07 ms |

  PAPER rebuild check (ledger), one run:
  - 64.4 ms at 1,602 tx; at base the equivalent work (`projectLedger` plus two serializations) took 64.6 ms;
  - 398.9 ms at 10,182 tx (base equivalent 376.1 ms).

  So the amortized cost at a cadence of 50 is about 1.3 ms per fill at 1e3 tx and about 8 ms per fill at 1e4 tx. At 1,000 records and 1,500 tx, the tests-only PnL check (`foldPnlRecords` plus two `serializePnlState`) costs 98.4 ms, and ledger plus PnL `checkAccountingRebuild` costs 170.9 ms.

  On the real e2e scenario, `projectLedger` calls went from 22 over 8 events (base, 0 at construction) to 1 at construction plus exactly 1 per fill (3) under the every-fill test cadence. Events without a fill now make 0 calls.

## files_changed

New:
- apps/trader/src/folds.ts
- apps/trader/src/folds.test.ts
- apps/trader/src/loop-folds.test.ts
- test/integration/paper-trader/fold-held-equals-rebuilt.test.ts

Modified:
- apps/trader/src/loop.ts, halt.ts, halt.test.ts, health.ts, index.ts, trader.ts, main.ts
- apps/trader/src/loop-long-run.test.ts, loop-refused-plan.test.ts, loop-order-lifecycle.test.ts, order-provenance.test.ts (the O1 check option; loop-order-lifecycle also gains an `accountingChecks` input and a cadence-refusal pin)
- apps/backtest-cli/src/core-loop.ts, run.ts, core-loop.test.ts, backtest.test.ts
- apps/control-api/src/health-door.ts, health-door.test.ts, testing/index.ts
- test/integration/control-api/health-refresh-wiring.test.ts, trader-health-http-source.test.ts, trader-health-shape.test.ts
- test/integration/paper-trader/support/fixture.ts, halts-reservations-and-seams.test.ts
- test/e2e/support/harness.ts
- test/unit/simulation/backtest-replay-support.ts

## tests_run

All with `pnpm_config_verify_deps_before_run=false`. Docker is NOT available: `docker` is not found in this WSL distro.
- `pnpm run typecheck`: exit 0.
- `pnpm run lint`: exit 0.
- `pnpm run check:deps`: exit 0 (PASS).
- `pnpm run test`: **344 files / 7460 tests, exit 0** (base 342 / 7427).
  - In one of three full runs, an UNRELATED test timed out: `test/unit/strategy-runtime/boundary-surface.test.ts`, which uses the TS type checker and has a 5 s default timeout; it took 5.97 s under load. It passes alone in 1.1 s, and in the other full runs in 3.1 and 3.3 s. The rerun was green. Disclosed, not suppressed.
- `pnpm run test:e2e`: 7 files / 157 tests, exit 0, run twice.
- `pnpm run test:replay`: 3 files / 17 tests, exit 0, run twice.
- `pnpm --filter @polymarket-bot/control-api test:integration`: 10 files / 87 tests, exit 0 (base 10 / 86).
- `pnpm --filter @polymarket-bot/trader test:integration`: exit 1 locally, ONLY because of Docker.
  - The 11 in-memory files pass: 113 tests, including the new `fold-held-equals-rebuilt.test.ts` and the updated `halts-reservations-and-seams.test.ts`.
  - The 4 Testcontainers files (`durable-pnl-snapshot-postgres`, `durable-trader-first-fill-postgres`, `trader-health-endpoint-postgres`, `univ-4-gateway-opens-trader-redis`) fail at container start with "Could not find a working container runtime strategy"; 17 tests skipped. The suite is now 15 files / 130 tests (base 14 / 129). The GitHub CI run must cover these.
- `git diff 8d64bec -- test/replay-golden/`: EMPTY.

New tests:
- `apps/trader/src/folds.test.ts` (7):
  - the cadence door;
  - the PAPER default;
  - adopt/check cadence with held==rebuilt after every posting;
  - an out-of-step (branched) posting refused;
  - oversell refusal parity with the from-zero fold at every step, F3 counted once;
  - a TRANSIENT refusal resumes and equals the from-zero fold;
  - a v4-runId identity throws on every call, as base's `foldPnlRecords` did.
- `apps/trader/src/loop-folds.test.ts` (10):
  - a 1,000+ fill run with the ledger checked after EVERY fill (about 66 s locally);
  - the every-fill test cadence with the PnL check on, over 200+ fills;
  - the PAPER cadence: checks at 50/100/150 plus END_OF_RUN, with a `projectLedger` call count of 1 plus the checks only;
  - corruption through the container-guard bypass, caught at the next check: GLOBAL `ACCOUNTING_REBUILD_MISMATCH`, counted, view replaced;
  - the same corruption caught at SHUTDOWN under the PAPER cadence;
  - a count-preserving broken step, caught;
  - a corrupted held PnL state, caught by the PnL check;
  - a throwing step, treated exactly as a failed posting;
  - a skipped transaction, refused at adoption;
  - the F3 parity pin: a planted duplicate ref at fill 3 means snapshots only for fills 1–2, matching the from-zero model; counted once; served through `healthResponseBody`.
- `test/integration/paper-trader/fold-held-equals-rebuilt.test.ts` (1): an independent rebuild HERE equals the held view (bytes and Map order) and the held PnL state.
- In existing files:
  - `loop-order-lifecycle.test.ts`: the cadence-refusal pin (1);
  - backtest-cli: `endOfRun` pins, one in `core-loop.test.ts` and one in `backtest.test.ts`;
  - `health-door.test.ts`: +13 (the `folds` seam and its fields);
  - `trader-health-shape.test.ts`: +1 (a document without `folds` is refused);
  - `halt.test.ts`: the new code added to the vocabulary pin.

Probes (scratch only; every probed tracked file restored and sha256-verified):
- `probes/perf.probe.ts` and `probes/pnlcheck.probe.ts`: item (7).
- `probes/golden-checks.e2eprobe.ts`: the e2e golden AND the backtest golden each ran 3 fills with `ledgerChecks 4, pnlChecks 4` (3 per fill plus END_OF_RUN), 0 mismatches, `halts []`. It also gives the per-event `projectLedger` count above, at base and after.
- `probes/served-health.e2eprobe.ts`: the real loop's health passes `healthResponseBody` and the control-api door.
- `probes/f3parity.probe.ts`, planted duplicate ref at base `loop.ts` vs FOLD-1: base wrote snapshots [fills 1, 2] with the same asOf and has no counter; FOLD-1 writes the same, plus `pnlRefusals {instance: {PNL_DUPLICATE_REF: 1}}`.

Non-vacuity, with `8d64bec`'s `apps/trader/src/loop.ts` restored temporarily (then restored: sha256 `a199cc88…` OK):
- all 10 `loop-folds.test.ts` pins FAIL;
- `fold-held-equals-rebuilt.test.ts` FAILS (`ledgerView is not a function`);
- `halts-reservations-and-seams` "all eight seam sections" FAILS;
- 32 e2e tests in 6 files FAIL (the harness's END_OF_RUN call has no target);
- `folds.test.ts` passes, since it is module-level and independent of loop.ts;
- replay goldens pass, since the driver's hook is optional.

Break probe: `folds.ts` was edited to skip the 2nd appended transaction of the 2nd posting while keeping the count, then restored (sha256 OK). The backtest golden then renders `halts=ACCOUNTING_REBUILD_MISMATCH@GLOBAL` (4 backtest tests fail) and the e2e determinism golden fails.

## assumptions

- "Every 50 fills" counts postings that advanced the held view, owned and unowned. A refused posting, including `VIEW_FOLD`, is not counted.
- At a due fill:
  - the ledger check runs right after adoption, before the store writes;
  - the PnL check (when on) compares EVERY held stream, after that fill's `#writePnlSnapshot`;
  - an unowned fill runs the ledger part only (no PnL moved).
- A held PnL stream answers for `records[0, seen)`, where `seen` is the stream's length at its last advance. Records appended by a fill whose store write then failed are folded at the instance's next snapshot, as base folded them. A check in between compares the prefix the stream answers for.
- On a mismatch the held state is REPLACED by the rebuild, not only halted. That is my call: the ledger is the truth, and accounting continues under a halt. The halt detail says whether it was replaced.
- The action for the new code is `FULL_HALT`.
- The "real shutdown hook" is `startup()` after `pump` returns in `main.ts`. `trader.ts` has no close, and no signal handler exists.
- The backtest end is `runBacktest` after `runReplay`, since backtest-cli never constructs the loop.
- O1's "and unit tests" covers the four apps/trader unit harnesses that build a loop.

## deviations

- `test/integration/paper-trader/halts-reservations-and-seams.test.ts` was edited: its seam-key list pin, plus live `folds` values. The grant names only "the fixture's check option and a held==rebuilt pin", but adding any seam breaks this exact-keys pin (the TRDR-4 precedent edited the same test).
- An adoption guard, `view.transactionCount === posted.ledger.length` (`LEDGER_VIEW_OUT_OF_STEP`), is added beyond the packet, to make "never branch the ledger" structural. As a result a plain "skip one appended transaction" is refused at adoption (MARKET `LEDGER_POSTING_REFUSED`), before any rebuild check. The rebuild check is shown catching a count-preserving skip and in-place corruption, in a test and in the source-level break probe.
- `test/e2e/support/harness.ts` `driveScenario` also calls `checkAccountingRebuild("END_OF_RUN")`, and `backtest-replay-support.ts` passes `endOfRun`. Both are check wiring, beyond "the check option only".
- New public CoreLoop methods: `ledgerView()`, `pnlState()`, `checkAccountingRebuild()`. New exports: `HeldAccounting`, the cadence constants and types, `AccountingRebuildCheck`, `RebuildMismatch`.
- `loop-order-lifecycle.test.ts`'s harness gained an optional `accountingChecks` input, used by one new pin.

## known_risks

- **The long pin is slow.** It takes about 66–75 s locally (per-fill `projectLedger` is inherently O(N²) over a run), and could be about 2× on CI. The CI job budget is 30 min (measured 277–420 s). It adds sustained CPU to the unit step, and the unrelated 5 s boundary-surface test timed out once locally under load.
- **Not memory-bounded.** Held PnL state adds about 340 B per record (the scoping's figure, not re-measured). The ledger and `#pnlRecords` stay whole.
- **The PnL step is still O(stream).** Each apply copies refs and tradeLog, so the per-fill PnL cost is linear, not constant (`FOLD-2`).
- **The PAPER ledger check is synchronous in the loop.** About 0.4 s at 1e4 tx, and about 4 s at 1e5 (extrapolated), every 50 fills.
- **Held PnL is never checked in PAPER** (ruling F2).
- **A mismatch can lose its halt record.** A GLOBAL halt latched earlier (for example `STORE_UNAVAILABLE`) keeps its first record, so a later mismatch then shows only on `seams.folds`, not as a halt record.
- **The shutdown call is not exercised by a test.** `startup()` needs Redis; the method itself is pinned.
- **The Testcontainers suites were not run locally.** The real-DB health endpoint serves the new seam (a probe shows the real loop's health encodes and passes the door).
- **`ledgerView()` exposes the frozen held object.** A caller using the container-guard bypass could contaminate it; the next check catches that (in PAPER, every 50 fills or at shutdown).
- **F3 counts a refusal caused by a corrupted held state** (which is also a mismatch).
- **A stale comment elsewhere.** `test/unit/control-api/response-encoder-bound.test.ts` says the door has "one `z.record(`". It now has nested records: a fixed depth, 2 levels more. Documentation only (`TRDR4-CITES` class).

## follow_up

- A CI run for the Testcontainers suites.
- Orchestrator docs:
  - the new halt code and `seams.folds`;
  - the `LOOPMEM-FOLD` / `FOLD-1` rows;
  - the stale `loop.ts` line cites;
  - `TRDR4-GAUGES`, to export `seams.folds` as gauges.
- `FOLD-2`, to make a PAPER PnL check affordable and the PnL step constant.
- `FOLD-RELATCH`, `FOLD-PNL2TOKEN` and `FOLD-OVERSELL` are unchanged.
- A `startup()` shutdown-path test through a transport seam.
- Consider moving the PAPER ledger check off the hot path at large ledgers.

## commit_sha

b0403c6482eb9c29a648a3cf51ea030675f550f1 (branch fold-1, one commit on base 8d64bec; not pushed)

---

# Appendix B — implementer handoff, r1 (verbatim)

# FOLD-1 handoff, remediation round 1

## plan (written before any edit)

Base of this round: `b0403c6` (branch `fold-1`, worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-fold-1`, clean). Docker: NOT available (`docker` not found in this WSL distro).

Findings (all MEDIUM, from `codex-r1.out`):

- FOLD1-R1-1: `HeldAccounting.checkPnl` compares only `records[0, seen)`. After a ledger-store failure, the fill's records are in `#pnlRecords` but the held stream was not advanced, and a check still says `matched: true`.
- FOLD1-R1-2: the PnL check lives inside `#writePnlSnapshot`. So an unowned fill (which never reaches it) and an owned fill whose store write fails (early `return`) skip the due PnL check.
- FOLD1-R1-3: `runBacktest`'s `endOfRun` is optional, so `runBacktest({ coreLoop: driver.coreLoop })` over the real core silently skips the final check.

Fix design:

1. R1-1, `apps/trader/src/folds.ts`: a PnL check answers for the WHOLE record stream.
   - `checkPnl(instanceId, identity, records)` first CATCHES the held stream UP over every record, with the SAME step and retry-from-failure as `advancePnl`. It opens the stream if it is not open yet. F3 still counts each refused record once.
   - It then compares with `foldPnlRecords(identity, records)` over the FULL list. No prefix.
   - A stream that cannot be opened (identity refused) agrees only if the rebuild refuses the same identity.
   - The loop's PnL check covers every instance with records in `#pnlRecords`, not only opened streams.
   - Snapshot timing, identity-throw site and retry semantics are unchanged: `#writePnlSnapshot` still advances and writes as before (its advance is a no-op after a catch-up).
2. R1-2, `apps/trader/src/loop.ts`: the cadence checks (ledger, plus PnL when on) run from ONE method, at every due adopted fill, owned or unowned.
   - Owned fill: after the fill's records join `#pnlRecords` and BEFORE the store writes, so no early return skips them.
   - Unowned fill: right after adoption.
   - `#writePnlSnapshot` loses its `checkDue` parameter and inline check.
3. R1-3, `apps/backtest-cli/src/{core-loop.ts,run.ts}`: the end-of-run check is BOUND to the driver and mandatory.
   - `replayDrivenCoreLoop` registers its `coreLoop` to its end-of-run check in a module WeakMap, and `runBacktest` runs the bound check once `runReplay` returns. The caller wires nothing, and the `endOfRun` option is removed.
   - `ReplayDrivenLoop.checkAccountingRebuild` becomes REQUIRED. The driver refuses a loop without one (TypeError at construction).
   - `runBacktest` REFUSES (`SIMULATION_INPUT_INVALID`, before reading anything) a `coreLoop` that is not a driver's, because it cannot know whether such a core keeps accounting.
   - Dataset-only verification (no `coreLoop`) is unchanged. A throwing finalizer becomes `SIMULATION_INTERNAL`.
   - `test/unit/simulation/backtest-replay-support.ts` drops `endOfRun: driver.endOfRun` and gains an optional `accountingChecks` (check option).
4. Pins, each shown to FAIL with `b0403c6`'s affected files restored:
   - R1-1: `loop-folds.test.ts`, with the store failing at fill 11 and the PnL check on but not due. After END_OF_RUN, the held state equals `foldPnlRecords` over ALL records. A second variant uses the every-fill cadence.
   - R1-2: `loop-folds.test.ts`. First, a corrupted held PnL state followed by UNOWNED fills (the venue's fills re-labelled with an unknown order id): the PnL check runs at every unowned fill, and the mismatch halts GLOBAL. Second, the same corruption followed by an owned fill whose store write fails: caught at that fill.
   - R1-3, structurally: `apps/backtest-cli/src/backtest.test.ts` and `core-loop.test.ts`. `runBacktest` handed only `driver.coreLoop` runs the check once; a hand-rolled `coreLoop` is refused; a loop without the check is refused.
   - R1-3, real core: `test/integration/paper-trader/fold-held-equals-rebuilt.test.ts`. The committed replay fixture runs through `runBacktest` with ONLY `driver.coreLoop` at the PAPER cadence: one end-of-run ledger check. With a held-balance discrepancy injected mid-run, a GLOBAL `ACCOUNTING_REBUILD_MISMATCH`.
5. Re-run every gate.

## summary

Round 1 fixes all three MEDIUM findings in one commit on top of `b0403c6`. There are no LOW findings and no scope violations to address. The goldens and `packages/**` are byte-identical to `8d64bec`.

| Finding | Status | Pins (fail against `b0403c6`, pass on `1e6e057`) |
|---|---|---|
| FOLD1-R1-1: a stale PnL state passes the end-of-run check | FIXED | `loop-folds.test.ts` › "FOLD1-R1-1: a PnL check never certifies a held stream that is BEHIND its records" (3 tests: END_OF_RUN catch-up; every-fill catch-up; behind-and-corrupted); `folds.test.ts` › "FOLD1-R1-1: a PnL check answers for the WHOLE record list, never a prefix" (5 tests) |
| FOLD1-R1-2: unowned fills skip the per-fill PnL checks | FIXED | `loop-folds.test.ts` › "FOLD1-R1-2: EVERY due posted fill runs every enabled check — unowned fills and the store-failure return included" (2 tests: unowned fills; owned fill whose store write fails) |
| FOLD1-R1-3: a real-core backtest can silently omit its final check | FIXED | `test/integration/paper-trader/fold-held-equals-rebuilt.test.ts` › "FOLD1-R1-3 — a real-core backtest, handed ONLY the driver's coreLoop, still ends with its held==rebuilt check" (2 tests, real core, PAPER cadence, one with an injected held-balance discrepancy); `apps/backtest-cli/src/backtest.test.ts` › 3 "FOLD1-R1-3:" tests; `apps/backtest-cli/src/core-loop.test.ts` › the binding test and "FOLD1-R1-3: a core with NO end-of-run check is refused at construction" |

**R1-1: a PnL check now answers for the WHOLE record stream** (`apps/trader/src/folds.ts`).
- `checkPnl(instanceId, identity, records)` first catches the held stream up over every record. It uses the SAME step as `advancePnl` (now a shared private `#advance`): retry from the failure point, and each refused record counted ONCE, whoever meets it first. It opens the stream if no snapshot has.
- Only then does it compare with `foldPnlRecords` over the full list, and `#repairPnl` also uses the full list.
- So `matched: true` is never said of a state that is behind. After END_OF_RUN, `pnlState()` folds all records. The verifier's case (fill 11's store write fails) now ends with held `recordCount` 22 = the rebuild.
- `#checkPnlRebuild` covers every instance with records in `#pnlRecords`, plus any held stream.
- Edge cases:
  - An identity `packages/pnl` refuses cannot be opened. The check agrees only if the rebuild refuses the same identity with the same error type. It stores no stream, so `#writePnlSnapshot` still throws from where base threw. Reachable: a v4 runId, per the r0 pin.
  - Records with no stream and no registered identity are a counted mismatch, never a silent pass (unreachable today: the registry only grows).

**R1-2: every due posted fill runs every enabled check** (`apps/trader/src/loop.ts`).
- The cadence checks moved into one method, `#runCadenceChecks` (the ledger, plus every PnL stream when `pnl` is on). Both posting sites call it BEFORE their store writes:
  - owned fills: after the fill's records join `#pnlRecords`;
  - unowned fills: right after adoption.
- `#writePnlSnapshot` lost its `checkDue` parameter and its inline check. Its identity builder is shared as `#pnlIdentity`.
- A corrupted held PnL state is now caught at the FIRST unowned fill (pnlChecks 20 of 20 fills), and at an owned fill whose ledger-store write fails.

**R1-3: the end-of-run check is bound to the driver and mandatory** (`apps/backtest-cli/src/{core-loop.ts,run.ts,index.ts}`). I did both remedies the verifier offered.
- **Bound.** `replayDrivenCoreLoop` registers its `coreLoop` to its end-of-run check in a module WeakMap, and `endOfRunBoundTo` is exported. `runBacktest` looks up the check bound to `options.coreLoop` and runs it once `runReplay` returns, whether the replay completed or was refused part-way. The `endOfRun` option is removed, so a caller passing `driver.coreLoop` gets the check with nothing to wire.
- **Mandatory.**
  - `ReplayDrivenLoop.checkAccountingRebuild` is required, and the driver throws a `TypeError` at construction for a loop without one.
  - `runBacktest` refuses a `coreLoop` the driver did not build (`SIMULATION_INPUT_INVALID`, before reading anything), since it cannot know whether that core keeps accounting.
  - A check that throws makes the run a `SIMULATION_INTERNAL` refusal.
- Dataset-only verification (no `coreLoop`) is unchanged, and pinned.
- `test/unit/simulation/backtest-replay-support.ts` no longer passes a finalizer. It gains an optional `accountingChecks` (default: the every-fill test cadence), so a test can run the real core at the PAPER cadence.

**Base parity (scratch probe).** `parity-r1/parity.probe.ts` ran `8d64bec`'s `loop.ts` beside the candidate on the loop-folds harness, over 4 scenarios × 3 cadences (every fill, PAPER, and pnl on but not due). The scenarios: ledger-store failure then recovery and re-read; snapshot-store failure then recovery; unowned then owned fills; two ledger-store failures.
- It compared, after every tick: ledger length, projection bytes, PnL record count, the full PnL snapshot list, store transactions, decisions, and health except `seams.folds`.
- All 12 were equal, and every candidate END_OF_RUN check matched.

**Measurements (item 7), re-run on this candidate** with the r0 probe on the same host; they match r0 within noise.

| Case | r0 (`b0403c6`) | r1 (`1e6e057`) |
|---|---|---|
| ~1e3 tx: per-event mean / median | 54.7 / 42.1 ms | 56.2 / 41.2 ms |
| ~1e3 tx: per fill | 5.47 ms | 5.62 ms |
| ~1e3 tx: `projectLedger` calls per event | 0.20 | 0.20 |
| ~1e3 tx: one rebuild check at 1,602 tx | 64.4 ms | 62.0 ms |
| ~1e4 tx: per-event mean / median | 103.9 / 38.7 ms | 109.6 / 39.3 ms |
| ~1e4 tx: per fill | 10.4 ms | 10.96 ms |
| ~1e4 tx: one rebuild check at 10,182 tx | 398.9 ms | 415.2 ms |
| PnL at ~1e3 records: per fill | 0.306 ms | 0.352 ms |

Base figures are unchanged from r0: 1,952 ms per event at ~1e3 tx and 13,417 ms at ~1e4 tx; PnL 80.5 ms per fill at ~1e3 records.

**Golden checks (scratch probe `probes/golden-checks.e2eprobe.ts`, on r1).**
- The e2e golden and the backtest golden each ran 3 fills with `ledgerChecks 4, pnlChecks 4`, 0 mismatches and `halts []`.
- The backtest golden's END_OF_RUN check now comes from the driver binding, with no finalizer passed.
- On the e2e scenario, `projectLedger` ran once at construction and 3 times over 8 events (one per fill).

## files_changed

Round 1 (`b0403c6..1e6e057`):
- apps/trader/src/folds.ts
- apps/trader/src/loop.ts
- apps/trader/src/folds.test.ts
- apps/trader/src/loop-folds.test.ts
- apps/backtest-cli/src/core-loop.ts
- apps/backtest-cli/src/run.ts
- apps/backtest-cli/src/index.ts
- apps/backtest-cli/src/core-loop.test.ts
- apps/backtest-cli/src/backtest.test.ts
- test/integration/paper-trader/fold-held-equals-rebuilt.test.ts
- test/unit/simulation/backtest-replay-support.ts

Cumulative `8d64bec..1e6e057`: 30 files, 3,140 insertions and 76 deletions.
- Unchanged versus `8d64bec`: `test/replay-golden/**`, `packages/**`, `docs/**`, `db/**`, `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs`, every `tsconfig*.json` and `.github/**`.

## tests_run

Every command was prefixed with `pnpm_config_verify_deps_before_run=false` and run in the worktree at the final tree (now committed as `1e6e057`). Logs are in `…/scratchpad/fold-1/gates-impl-r1/`. Docker is NOT available (`docker` not found in this WSL distro).

Gates:
- `pnpm run typecheck`: exit 0.
- `pnpm run lint`: exit 0.
- `pnpm run check:deps`: exit 0 (PASS).
- `pnpm run test`: exit 0, **344 files / 7473 tests** (r0 344 / 7460; base 342 / 7427).
- `pnpm run test:e2e`, twice: exit 0, **7 / 157** each time.
- `pnpm run test:replay`, twice: exit 0, **3 / 17** each time.
- `pnpm --filter @polymarket-bot/control-api test:integration`: exit 0, **10 / 87**.
- `pnpm --filter @polymarket-bot/trader test:integration`: exit 1, ONLY because of Docker.
  - 11 in-memory files pass: 115 tests, including the 2 new real-core backtest pins.
  - The 4 Testcontainers files fail at container start ("Could not find a working container runtime strategy", 4 of 4); 17 tests skipped.
  - Suite: 15 files / 132 tests (r0 15 / 130). The GitHub CI run must cover the Testcontainers files.
- `git diff --quiet 8d64bec HEAD -- test/replay-golden/ packages/`: exit 0 (EMPTY).

The new tests account for the +13 unit tests and +2 integration tests:
- `apps/trader/src/folds.test.ts`, +5 (12 in the file), under "FOLD1-R1-1: a PnL check answers for the WHOLE record list, never a prefix":
  - a behind stream is caught up and compared whole;
  - an unopened stream is opened by the check;
  - a refusal met first by the check is counted once;
  - a refused identity agrees with the rebuild and still throws at the snapshot;
  - no stream and no identity is a counted mismatch.
- `apps/trader/src/loop-folds.test.ts`, +5 (15 in the file):
  - 2 under FOLD1-R1-2 (unowned fills; owned fill with a failed store write);
  - 3 under FOLD1-R1-1 (END_OF_RUN catch-up at `{everyFills: 1000, pnl: true}`; the every-fill cadence; behind-and-corrupted caught over the whole list).
- `apps/backtest-cli/src/core-loop.test.ts`: the r0 end-of-run test was replaced by a binding test, plus the new construction-refusal test (+1; 17 in the file).
- `apps/backtest-cli/src/backtest.test.ts`: the r0 `endOfRun` test was replaced by 3 FOLD1-R1-3 tests (+2; 26 in the file): the bound check runs once (completed, refused part-way, never when not started); a hand-built coreLoop is refused and dataset-only still verifies; a throwing check is refused as SIMULATION_INTERNAL.
- `test/integration/paper-trader/fold-held-equals-rebuilt.test.ts`, +2 (3 in the file): a real-core backtest at the PAPER cadence runs 1 END_OF_RUN check and matches; an injected held-balance discrepancy halts GLOBAL `ACCOUNTING_REBUILD_MISMATCH` "at the end of the run".

The changed trader and backtest test files, run together, pass: 9 files / 136 tests. The 1,000-fill pin took 67.9 s.

Non-vacuity. Every probed file was restored and its sha256 checked against my copy (`nonvacuity-r1/setA-mine.sha`, `setB-mine.sha`: all OK). `git status` was clean after commit.
- **Set A:** `b0403c6`'s `apps/trader/src/loop.ts` and `folds.ts`.
  - All 5 new loop-folds R1 pins FAIL:
    - R1-2 unowned: `fillsPosted 20 / pnlChecks 20` not matched;
    - R1-2 store failure: `pnlChecks 11` not matched;
    - R1-1 END_OF_RUN and every-fill: "expected 20 to be 22";
    - behind-and-corrupted: the whole-list state bytes differ.
  - `folds.test.ts`: all 5 new pins FAIL. The 2 r0 PnL-stream tests also fail there, only because `checkPnl`'s signature changed; the other 5 pass.
- **Set B:** `b0403c6`'s `apps/backtest-cli/src/run.ts`, `core-loop.ts` and `index.ts`.
  - The 3 new backtest.test pins FAIL: `[]` vs `["END_OF_RUN"]`, and `ok` true vs false twice.
  - The 2 core-loop.test R1-3 pins FAIL.
  - Both real-core integration pins FAIL: the PAPER run shows `ledgerChecks 0`, and the corrupted run shows `halts []` instead of the GLOBAL mismatch. The r0 integration pin still passes.

Scratch probes (none inside the repository):
- `parity-r1/parity.probe.ts`, base vs candidate: 12 of 12 equal.
- `probes/golden-checks.e2eprobe.ts`: 3 of 3.
- `probes/perf.probe.ts`: 3 of 3 (`probes/perf-r1.out`).

## assumptions

- A PnL check may ADVANCE the held stream before comparing. The catch-up is exactly what the next snapshot's advance would fold, with the same step and the same retry and counting rules. The base-parity probe shows snapshots, ledger, decisions and health unchanged. Between a failed store write and the next snapshot or check, `pnlState()` can still be behind `pnlRecords()`, as base's last snapshot was; the verifier's "do not report matched while behind" is met because a check never compares a stream it has not caught up.
- At a due fill, an unowned fill runs the PnL check over every stream, although it adds no PnL record. The verifier asked for "all enabled PnL comparisons at every due adopted fill".
- On the owned path the ledger check now runs after the fill's cash, allocator and PnL-record bookkeeping rather than immediately after adoption; both points are before the store writes. None of that bookkeeping reads the view or halts, so this changes nothing observable (parity probe).
- For a refused identity, "the held stream and the rebuild agree" means both throw an error of the same type when opening that identity.
- `runBacktest` refusing a `coreLoop` the driver did not build is acceptable. No caller passes one: `runReplay`'s own tests pass raw hooks to `runReplay`, not to `runBacktest`.

## deviations

- **The R1-3 real-core pin is in the paper-trader integration suite.** It lives in `test/integration/paper-trader/fold-held-equals-rebuilt.test.ts` and imports the replay-golden support (`test/unit/simulation/backtest-replay-support.ts`) and `apps/backtest-cli`.
  - Why there: a new test file under `test/unit/simulation/` is outside the allowed paths, and `check:deps` forbids app-to-app imports inside `apps/**`.
  - Why it fits the grant: the pin is a held==rebuilt pin, the grant for that directory.
  - Effect: it runs under `@polymarket-bot/trader test:integration`, not the root `test`.
- **The backtest-cli public surface changed beyond "the check option".**
  - `BacktestRunOptions.endOfRun` is removed; r0 added it, and no merged caller used it.
  - `ReplayDrivenLoop.checkAccountingRebuild` is now required.
  - `endOfRunBoundTo` is exported.
  - `runBacktest` refuses an unbound `coreLoop`, and a throwing check.
  - These are the verifier's minimal remedy ("mandatory … or bind it automatically"), carried as check wiring.
- **`backtest-replay-support.ts` gained an optional `accountingChecks` argument** on `assembleSharedCore` and `replayThroughShippedRoot`: a check option. The golden default is unchanged (every fill).
- **`HeldAccounting.checkPnl`'s signature gained an `identity` argument.** It is internal to `apps/trader` and exported only through `HeldAccounting`.

## known_risks

- **A check mutates held PnL state.** The catch-up moves the refusal COUNT (F3) to the check when the check meets a refused record first. The count is still once per record, and the set of snapshots is unchanged.
- **A check opens streams early.** It opens a stream for any instance with records, which a snapshot opens anyway, except when a store failure happened before the instance's first snapshot.
- **Every-fill PnL checks cost more.** They now run on unowned fills too, which is O(records) per stream per unowned fill, in tests only (F2 keeps PnL checks out of PAPER).
- **Nothing gates a hand-rolled driver.** A caller that drives `runReplay` directly with a hand-built hook (not `runBacktest`) is still not forced to run the final check. `runBacktest` is the backtest composition root, and `runReplay` is `packages/simulation`'s, which is out of scope.
- **The WeakMap binding is per `coreLoop` function.** Reusing one driver for two `runBacktest` calls runs its check once per call. The check is idempotent.
- **Carried from r0 and still true:**
  - memory is not bounded;
  - the PnL step is O(stream) (`FOLD-2`);
  - the synchronous PAPER ledger check takes about 0.4 s at 1e4 tx;
  - a GLOBAL halt latched first keeps its record (seen in R1-2's store-failure pin: the mismatch latched before STORE_UNAVAILABLE);
  - the 1,000-fill pin takes about 68 s;
  - the Testcontainers suites were not run locally;
  - the SHUTDOWN path through `startup()` is not exercised by a repository test.

## follow_up

- A CI run for the Testcontainers files: 4 of them, 17 tests.
- Orchestrator docs, beyond r0's list:
  - `runBacktest` now requires the driver-built `coreLoop` and runs its bound end-of-run check;
  - `BacktestRunOptions.endOfRun` no longer exists;
  - `seams.folds.pnlChecks` counts per instance with records, per check.
- Consider binding a final check at `runReplay` level if a non-`runBacktest` replay composition appears (`packages/simulation`, out of scope here).
- `FOLD-2`, `FOLD-RELATCH`, `FOLD-PNL2TOKEN` and `FOLD-OVERSELL` are unchanged.

## commit_sha

1e6e0571e32a94ed03e4542127106f2bc0220be2 (branch `fold-1`, one commit on top of `b0403c6`; not pushed, not amended)

**Correction (2026-10-05, `TRADER-SIGNALS`, `3926f5f`):** a SHUTDOWN rebuild mismatch now exits 70 (`shutdownCheckFailed`), where it used to exit halted (75). The SHUTDOWN path through `startup()` now runs on every graceful stop and is exercised by tests, which closes this record's residual that no repository test reached it.
