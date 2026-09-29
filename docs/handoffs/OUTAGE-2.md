# OUTAGE-2: OUTAGE-1's outage test made deterministic

Branch `outage-2` on base `d91a5ad`, merged into `main` as `a618752` (`--no-ff`) on 2026-09-29.

- **Trigger:** PR #21 CI attempt 1 failed on OUTAGE-1's PARTITION test; the re-run passed.
- **Authorization:** the orchestrator authorized the round as a CI-health fix.
- **Process:** HARDENING LOOP `wf_1c0f9193-d7b`.
  - An Opus implementer, commit `f70682e` (the test file only).
  - A Fable adversarial reviewer, because the round needs real containers: r1 ACCEPT.

## Finding
It was a TEST RACE.
- **The extra row** was the checkpoint of decision 6 (`checkpoint_seq` 6). It committed about 3 ms after the test read its "before" snapshot, and about 1 s before the halt.
- **No row was committed after the halt** in any of 55 runs that took a halt snapshot.
- **Why the old settle raced:**
  - `decisionsPersisted` counts a decision when it enters the outbox.
  - The flush writes decisions first, then checkpoints.
  - The old settle compared decisions against the counter but never checked checkpoints.

## Fix
- **Settle** on the trader's committed stream position, read from the transport's consumer lag. The pump commits only after `drain()` returns.
- **"Nothing written after the halt"** is checked by PostgreSQL commit order: no row version in any scenario table may be newer than a pre-fault MVCC snapshot.
- **Whole-row equality** between quiescence and exit.

## Evidence
- 25/25 consecutive whole-file runs.
- Planted post-halt writes are each caught: a decision, a checkpoint, and a same-value PnL update.
- The old settle reproduces the race in 4 to 7 runs out of 30.
- The reviewer reproduced the mechanism deterministically by adding a delay to the checkpoint INSERT. Without the delay it did not reproduce on this host (0 of 80 runs); that finding is `OUT2-R1-NATURAL-RATE-NOT-REPRODUCED`.

## Review (Fable r1: ACCEPT), 3 LOW
- `OUT2-R1-HALT-RECORD-INTERACTION`: the future durable-halt round must update these scenarios. This is noted on `OUT1-R1-HALT-NOT-DURABLE`.
- `OUT2-R1-STATUS-ROW-WORDING`: the ledger row's wording (a checkpoint, not a decision) and the pump path. Corrected at the flip.
- `OUT2-R1-NATURAL-RATE-NOT-REPRODUCED`: the natural race rate varies by host.

## commit_sha
- Implementation: `f70682e`.
- Merge: `a618752`.

# Appendix A: implementer handoff, r0 (verbatim)

# OUTAGE-2 — implementer handoff, round 0

## plan (written before any structural change)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-outage-2`, branch `outage-2`, base `d91a5ad`. Prerequisites present: OUTAGE-1 merged (`143ad8d` is an ancestor), Docker up, `node_modules` present, the test file passes locally once (4/4, 22.9 s).

**Correction to the packet, from the CI excerpt itself.** The failing assertion is at `redis-outage-halts-postgres-redis.test.ts:381:79`, which is the CHECKPOINTS comparison (`[checkpoint_seq, state_hash]`), not the decisions one. The diff rows (`"5"`/`"6"` paired with a 64-hex value) are `[checkpoint_seq, state_hash]`; the decisions projection is `[evaluation_seq, decision_type]`. So the extra row is `strategy.state_checkpoints` seq 6 (7 rows after vs 6 before), not a decision.

**Hypothesis (to be proved by reproduction, item 1).** The settle condition is not a quiescence condition:
- `decisionsPersisted` is counted when the decision is appended to the in-memory outbox (`loop.ts` `#consumeOutcome`), not when it is durable;
- `#flushOutbox` (the last step of `#processEvent`) writes every decision FIRST, then every checkpoint (§9.6: one checkpoint per persisted decision, `checkpointSeq == evaluationSeq`);
- the settle predicate checks `eventsProcessed === 6`, decisions rows == `decisionsPersisted`, ledger rows == `ledgerTransactions`, and nothing about checkpoints. A poll landing between the last decision INSERT and the last checkpoint INSERT snapshots "before" one checkpoint short; the checkpoint lands milliseconds later, long before the fault. That is a TEST RACE, if the reproduction shows the extra row committed before the halt.

**Item 1.** Scratch probes (untracked files under `test/integration/paper-trader/`, deleted before commit):
- A: the partition scenario with the ORIGINAL settle, 30 iterations, recording per iteration the settle instant, the transport's consumer lag at the settle, a PostgreSQL clock + MVCC snapshot read immediately before the fault, the HALT/`pump stopped` instants, and every extra row with `recorded_at` and whether it was committed before the fault.
- B (if A is too rare): the same with jitter — a scratch-only `BEFORE INSERT` trigger with a random `pg_sleep` on `strategy.state_checkpoints` in the scenario's own database.
- If ANY row was committed after the halt: STOP and report (product defect).

**Item 2 (if a race).** Only the test file (and support helpers if needed):
- Quiescence, event-driven and not a sleep: wait until the transport's own §8.3 consumer-lag metric (`publisher.streamMetrics(stream).consumerLag`) shows the trader's consumer committed past the sixth event. `pump.ts` commits only after `loop.drain()` resolved, and `drain()` awaits every `#processEvent`, whose last steps are the PnL and outbox flushes; an idle poll's `drain()` on an empty queue writes nothing. At lag 0 every durable write for the six events has completed, and nothing more can be written until a new event arrives. The counters-vs-rows equalities (now including checkpoints 1:1 with decisions) become assertions, not waits.
- Keep "nothing traded or written after the halt" and check it against the halt instant: immediately before the fault the test reads PostgreSQL's MVCC snapshot and clock (a lower bound of the halt instant, on the database's own clock). After exit: no row version in the scenario's database was committed after it (every user table, via `xmin` visibility), and no run row's `recorded_at`/`computed_at` is at or after it. Then the quiescent snapshot still equals the rows after exit, now in full-row form for `pnl_snapshots` (the one table the store may UPDATE).
- Same helper for the stopped-container case; the idle case (no events, so no race) gets the same halt-instant check.

**Item 3.** 25+ consecutive whole-file runs; the trader integration suite twice; the gates; non-vacuity probes (a) planted post-halt writes, (b) old settle restored under natural and jittered conditions.

No product file is planned to change unless item 1 finds a post-halt write.

---

# Handoff (after implementation)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-outage-2`, branch `outage-2`, base `d91a5ad`. ONE commit: `f70682eda73531827562db670bd3f0746ed53d2f`. Not pushed. No product file changed.

## summary

### (1) The extra row, identified and classified: a TEST RACE, not a product defect

**It was a CHECKPOINT, not a decision.** The packet says "6 decision rows vs 5". The CI excerpt shows otherwise:
- the failing assertion is `redis-outage-halts-postgres-redis.test.ts:381:79`, the `rows.checkpoints…[checkpoint_seq, state_hash]` line;
- the diffed pairs hold a 64-hex `state_hash`, while decisions were projected to `[evaluation_seq, decision_type]`;
- in every reproduction the decisions compared equal (7 = 7), and only the checkpoints differed.

**The row.** `strategy.state_checkpoints` with `checkpoint_seq` 6 (7 rows after the halt vs 6 in "before"). It is the checkpoint of decision `evaluation_seq` 6:
- `callback` `onOrderUpdate`, an evaluation the loop originates;
- `decision_type` `hold`;
- `evaluated_at` / `captured_at` `2026-03-04 12:00:03+00`, the sixth event's recorded instant.

The run's full decision chain (probe, jittered iteration 0):

| seq | callback | decision_type | evaluated_at |
| --- | --- | --- | --- |
| 0 | onFeatures | hold | 12:00:01 |
| 1 | onFeatures | enter | 12:00:02 |
| 2 | onFill | exit | 12:00:02 |
| 3 | onOrderUpdate | hold | 12:00:02 |
| 4 | onOrderUpdate | hold | 12:00:02 |
| 5 | onFeatures | hold | 12:00:03 |
| 6 | onOrderUpdate | hold | 12:00:03 |

Checkpoints 0..6 carry the same sequences.

**When it was written, against the halt.** The scratch probe reads PostgreSQL's MVCC snapshot (`pg_current_snapshot()`) twice:
- immediately before the fault is injected;
- (later probes) from inside the process's log callback at the `pump stopped:` line, which follows the halt latch in the same synchronous continuation.

It then classifies every row with `pg_visible_in_snapshot(xmin, …)`. That is commit order, not a clock.

- **Natural reproduction, ORIGINAL settle, partition scenario:** 3/30 (iterations 4, 11, 24) and then 5/30 (iterations 2, 10, 11, 17, 18) failed the original comparison, exactly the CI shape (before d=7/c=6, after d=7/c=7). Every extra row was committed BEFORE THE FAULT (`committed_before_fault = true`).
  - Example, iteration 4: `recorded_at` 08:43:14.645960; "before" snapshot returned 14.649; fault boundary 14.650899 (PostgreSQL clock, inside the Node bracket .650–.651); `pump stopped` (the halt) 15.651.
  - The checkpoint's transaction had started about 3 ms before the settle read returned. The read did not see it because it had not committed yet.
- **Natural, ORIGINAL settle, stopped-container scenario:** 2/15 (iterations 6, 7), the same shape, committed before the fault. So the stopped case shares the race.
- **Jitter** (a scratch-only `BEFORE INSERT` trigger with `pg_sleep(random()*0.1)` on `strategy.state_checkpoints`, in the scenario's own database): the ORIGINAL settle failed 10/10 and 9/10.
  - The extra checkpoints (seq 5 and 6, or 6) were still in flight at the fault, and were committed after it.
  - In the run with the halt-line snapshot, every one was committed BEFORE THE HALT LINE.
- **Across all 55 runs that took a halt-line snapshot** (30 natural partition, 15 stop, 10 jitter): 0 row versions in decisions, checkpoints, ledger transactions or PnL snapshots were committed after the halt line.
- **Across the 75 natural runs with a fault snapshot:** 0 committed after the fault.

**Mechanism** (read in code):
- `loop.ts` `#consumeOutcome` counts `decisionsPersisted` when the decision enters the in-memory outbox, not when it is durable.
- `#flushOutbox`, the last step of `#processEvent`, writes ALL decisions, then ALL checkpoints (loop.ts ~3190).
- The old settle waited for `eventsProcessed === 6`, decision rows == `decisionsPersisted` and ledger rows == `ledgerTransactions`, and said nothing about checkpoints. A poll landing between the last decision INSERT and the last checkpoint INSERT snapshotted "before" one (or, with delay, two) checkpoints short.

**By construction nothing can be written after the halt.**
- The pump latches the halt only after a failed `poll()` or `commit()`, and returns.
- Every durable write (`#evaluateMarket`, `#harvestFills`, `#flushPnlSnapshots`, `#flushOutbox`) is reached only from `#processEvent`, which only `drain()` calls (loop.ts 900-906, 993-1028).
- A poll or commit happens only after `drain()` resolved.
- After the pump returns, `main.ts` runs the synchronous `checkAccountingRebuild` and closes.
- **No product defect.** No product file was touched.

### (2) The test is deterministic, and the assertion is stronger

Only `test/integration/paper-trader/redis-outage-halts-postgres-redis.test.ts` changed.

**Quiescence = the pump's own commit (event-driven, no sleep).** `publishSixAndSettle` now waits until `publisher.streamMetrics(stream).consumerLag` shows the trader's consumer (`consumerIdOf(document)`, "trader-1") at lag 0 with `publishedTotal` 6.
- `pump.ts` commits the position only after `await loop.drain()` returned for the batch, and `drain()` holds every durable write, including the loop-originated `onFill`/`onOrderUpdate` evaluations and their flushes.
- An idle poll's `drain()` on an empty queue processes nothing.
- So at lag 0 every write for the six events has landed, and none can follow without a new event.
- The health and rows read after that are final. Their agreement is ASSERTED (not waited for): `eventsProcessed` 6; decisions == `decisionsPersisted`; checkpoint seqs == decision seqs (§9.6, one checkpoint per persisted decision); ledger rows == `ledgerTransactions`; snapshots == `fillsObserved`.

**"Nothing written after the halt" is checked against the halt instant.**
- `readFaultBoundary` reads `pg_current_snapshot()` immediately before the fault (`redis.stop()` / `hop.freeze()`), and asserts the cluster xid epoch is 0 so that `xmin::text::xid8` is exact.
- `faultBoundaryBeforeAnyHalt` then shows the process still reports no halt. So the boundary provably precedes the halt, which the fault causes.
- After exit, `writesCommittedAfter` enumerates every base table of the scenario's database (it asserts the enumeration includes the five run tables) and counts row versions not visible in the boundary snapshot. That covers INSERTs and UPDATEs, on every table, by commit order. It must be empty.
- A row committed after the halt is committed after the boundary, so the check is at least as strict as "after the halt". It cannot fail a correct process, because the process is quiescent at the boundary.
- Then the quiescent snapshot must equal the rows after exit, compared WHOLE: decisions, checkpoints, ledger transactions, ledger entries, and PnL snapshots, the one table the store may UPDATE. `durableRows` gained `orderBy` on entries and snapshots for a stable whole-row comparison.
- The process's own counters at exit must still equal those at quiescence.

**The same helpers apply to the stopped-container case.** The idle case (no events, so no race) gains the boundary check, and now asserts no decision, checkpoint, ledger or PnL row at all (it used to check decisions only).

### (3) Stability

- **Committed file (`f70682e`): 25/25** consecutive runs of the whole file, each 4/4, 22.32–23.05 s. Measured in every run:
  - stopped halt +4656..+4775 ms;
  - idle halt +679..+739 ms;
  - partition halt +999..+1003 ms and exit +3001..+3006 ms.
- **Before the final doc-comment-only edit (identical code): 30/30** consecutive, each 4/4, 19.59–23.07 s. Two runs had the stopped-container halt at +1819/+2117 ms, the connection-close path (CI saw +1730); all were within bound.
- **Trader integration suite at `f70682e`:** 20 files / 161 tests, twice. It also passed twice before the doc edit.

## files_changed

- `test/integration/paper-trader/redis-outage-halts-postgres-redis.test.ts`: +223/−39. This covers:
  - a dated `OUTAGE-2` header section;
  - `consumerIdOf`;
  - the quiescent `publishSixAndSettle`;
  - `FaultBoundary`, `readFaultBoundary`, `writesCommittedAfter`, `faultBoundaryBeforeAnyHalt`;
  - whole-row `expectNothingTradedOrWrittenAfter`;
  - `orderBy` in `durableRows`;
  - the three outage scenarios wired to the boundary.

Nothing else. `git diff --name-only d91a5ad HEAD` is exactly this one path. No support helper, product, package, docs or lockfile change.

## tests_run

All were run by me in this session, with exit 0 unless stated.

**Gates at `f70682e`** (clean tree):
- `pnpm run typecheck`: exit 0 (38 s).
- `pnpm run lint`: exit 0 (16 s).
- `pnpm run test`: 358 files / 7732 tests, exit 0.
- `pnpm --filter @polymarket-bot/trader test:integration`, run 1: 20 files / 161 tests.
- The same, run 2: 20 files / 161 tests.

The same five gates also passed once earlier, on the pre-doc-edit tree, with identical counts.

**Stability:**
- 25/25 consecutive whole-file runs at `f70682e`;
- 30/30 before the doc-comment edit.

Per-run logs are in `…/scratchpad/outage-2/stability-commit/` and `…/stability/`.

**Item 1, reproduction** (scratch probe `probes/zz-outage2-probe-a.test.ts`, the ORIGINAL settle, with instrumentation; JSONL in scratch):
- partition, natural: 3/30 and 5/30 failed the original comparison. 0 rows were committed after the fault or the halt line.
- stopped container, natural: 2/15 failed. 0 rows after the fault or the halt line.
- partition, jitter 100 ms: 10/10 and 9/10 failed. Extra rows were committed after the fault and before the halt line. 0 rows after the halt line.

**Non-vacuity (a): a planted write after the halt**, in scratch copies generated from the committed file by `make-probes.py` (anchors asserted), re-run at `f70682e`. Each planted row is caught by the halt-instant check, which names the table:
- a decision INSERT (partition): `strategy.decisions: 1 row version(s)`;
- a checkpoint INSERT (partition): `strategy.state_checkpoints: 1`;
- a same-value PnL `UPDATE … set realized_pnl = realized_pnl` (partition): `accounting.pnl_snapshots: 1`;
- a decision INSERT (stopped container): `strategy.decisions: 1`;
- a checkpoint INSERT (idle): `strategy.state_checkpoints: 1`.

With the MVCC check removed from the helper:
- the planted decision is still caught, by the whole-row comparison (8 vs 7);
- the same-value PnL UPDATE PASSES. Only the MVCC check sees it, which shows that check adds real coverage.

A decision planted BETWEEN quiescence and the boundary passes the MVCC check (correct: it was before the halt) and is caught by the whole-row comparison. So the two checks are distinct, and both are live.

**Non-vacuity (b): the old settle restored**, in scratch copies of the new file.
- Old wait predicate, new assertions, natural: 7/30 failed. The first failure was at run 3. The new §9.6 assertion caught the race at settle time (checkpoints 0..5 vs decisions 0..6).
- Old settle restored whole, natural: 4/30 failed, first at run 3, at the post-halt checkpoints comparison, the CI shape. Earlier, two files in parallel (60 iterations each, both without jitter) gave 13/60 and 12/60; one further failure was `TC-LOCAL-FLAKE`.
- With jitter 100 ms: old whole 10/10 and, re-run at `f70682e`, 8/8, caught by the new halt-instant check because the in-flight checkpoints committed after the boundary. Old wait with new assertions: 10/10.

**Robustness of the new settle under jitter 100 ms:**
- partition 15/15;
- stopped 5/5;
- re-run at `f70682e`: stopped 3/3, and partition 7/8. The one failure was `TC-LOCAL-FLAKE` in `connectPublisher` during setup ("a fresh Redis container never accepted a connection", before the process under test started); see known_risks.

**Other:**
- `eslint` and `tsc -p test/integration/paper-trader/tsconfig.json` on the file after every edit: clean.
- A grep for `.only`, `.skip`, `eslint-disable`, `ts-ignore` and `ts-expect-error` in the file: none.

## assumptions

- **The quiescence rests on a product property:** `pump.ts` commits the stream position only after `drain()` (documented there as deliberate, §8.3). It is also defended in depth: the settle-time assertions (checkpoints 1:1 with decisions, rows == counters) caught the race in 7/30 natural and 10/10 jittered runs when the old wait was restored.
- **The MVCC check.** `xmin::text::xid8` is exact while the cluster xid epoch is 0, which is true for a throwaway container and asserted at every boundary. `information_schema.tables` lists every table for the test's owner role; the enumeration is asserted to include the five run tables.
- **No clock comparison decides anything.** Clocks appear only in the failure message; PostgreSQL's and Node's clocks agreed to within 1 ms in the probe.
- **The trader's `consumerId`** is read from the document (`infrastructure.consumerId`, "trader-1" in the fixture), not hard-coded.

## deviations

- **The packet's description of the failure is corrected:** the extra row was a checkpoint, not a decision. The evidence is above.
- **The packet names `packages/trading-core/src/pump.ts`.** The pump is `apps/trader/src/pump.ts`. I only read it; no product file changed.
- **"Nothing written after the halt" is checked against a PROVEN LOWER BOUND of the halt instant** (the MVCC snapshot read before the fault, with the process still unhalted after it), by commit order. The packet suggested `recorded_at`. That column is `now()`, the transaction START, so it misses UPDATEs (`replacePnlSnapshot` keeps `computed_at`) and commits that land later than they start. The MVCC check is strictly stronger and was shown to catch a same-value UPDATE the row comparison misses.
- **Scope beyond the race, all strengthening:**
  - whole-row comparisons replace projections;
  - the idle case asserts all four run tables are empty (it had no race, and before it checked decisions only).
- **The stability script's wall-time column broke** (`bc` is absent on this host). Durations are vitest's own `Duration` lines from the per-run logs.

## known_risks

- **`TC-LOCAL-FLAKE`, observed twice in scratch probes this session, not in any stability or gate run.** In both, the pre-existing setup retry (`connectPublisher`, 5×400 ms) found a fresh Redis container refusing every connect:
  - once with two probe files running in parallel;
  - once in the committed-file jitter probe.

  It fails at setup, before the process under test starts, so it cannot be confused with the race or the halt check. It is left unchanged (out of scope; the queued `TC-LOCAL-FLAKE` item).
- **The boundary check is stricter than "after the halt".** A legitimate write in flight at the fault would be flagged. This file guarantees quiescence before the boundary, so it cannot happen here. A future scenario that injects a fault mid-processing must not reuse `expectNothingTradedOrWrittenAfter` without a boundary at the halt.
- **Deletes are invisible to the MVCC check** (the rows vanish). For the run's tables they are caught by the whole-row comparisons; most other tables are append-only by trigger.
- **GitHub CI has not run on this commit** (the orchestrator's step). Local timings match CI's.

## follow_up

- **Orchestrator:**
  - update the `OUTAGE-2` row;
  - correct its "6 decision rows" wording (it was a checkpoint);
  - write `docs/handoffs/OUTAGE-2.md` at the flip (`docs/**` was outside this grant);
  - run CI on the PR.
- **Other container files do not share this race.** `durable-two-brackets`, `durable-two-level-entry`, `univ-4-gateway-opens-trader-redis` and `register-command` await `pump({ untilIdle: true })` or `loop.drain()` directly before reading. Only this file polls a running `startup()` over HTTP.
- **`TC-LOCAL-FLAKE`:** a readiness wait on container start (rather than a publisher connect retry) is the candidate fix for the queued item.
- **`OUT1-R1-HALT-NOT-DURABLE`** is unchanged: the halt is still not persisted.

## commit_sha

`f70682eda73531827562db670bd3f0746ed53d2f`

# Appendix B: Fable adversarial-reviewer report, r1 (verbatim)

VERDICT: ACCEPT

# OUTAGE-2 — independent verification, round 1 (Claude Fable)

Candidate `f70682eda73531827562db670bd3f0746ed53d2f` on `outage-2`, base `d91a5ad`, one commit (`git log --oneline d91a5ad..f70682e` = the single OUTAGE-2 commit). Review worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-outage-2-review`, detached at the candidate; the review started from a clean tree (`git status --porcelain` empty, detached at d91a5ad). Docker was available (required). The implementation worktree was never touched.

ACCEPT: every acceptance criterion is met and every claim in the handoff that I could re-run held. The extra row is a checkpoint, not a decision; it is a TEST RACE; no durable write after a halt was found on base or candidate in 115 instrumented runs; the fix is a strict strengthening with a sound, event-driven quiescence condition; the planted-write probes are all caught; the file is 20/20 here plus the implementer's 25/25; only the allowed path changed; all gates are green with exact counts. Three LOW findings, none requiring a code round.

## Findings

[SEVERITY LOW] OUT2-R1-HALT-RECORD-INTERACTION: `writesCommittedAfter` (`test/integration/paper-trader/redis-outage-halts-postgres-redis.test.ts`) scans EVERY base table of the scenario's database for a row version invisible to the pre-fault MVCC snapshot, and all three outage scenarios assert it is empty. The queued `OUT1-R1-HALT-NOT-DURABLE` round exists precisely to add a durable halt record (a `TraderStore` write to `ops.incidents`/`ops.risk_events` AT the halt). When it lands, the stopped, idle and partition scenarios will all fail on "a row was committed after the fault boundary" by design, and must be changed to expect exactly that record (table, one row version) and nothing else. This is the intended sensitivity of the check, not a defect, and the handoff's known_risks say the boundary is "stricter than after the halt", but it does not name the queued round that will trip it. Remediation: none this round; the orchestrator should note it on the `OUT1-R1-HALT-NOT-DURABLE` row so that round's packet includes the test update.

[SEVERITY LOW] OUT2-R1-STATUS-ROW-WORDING: The `OUTAGE-2` row in `IMPLEMENTATION_STATUS.md` (line 673 ff.) says the partition case "read 6 durable decision rows after the halt, against a 'before' snapshot of 5". It was a CHECKPOINT: the CI excerpt fails at `redis-outage-halts-postgres-redis.test.ts:381:79`, the `[checkpoint_seq, state_hash]` comparison, with 7 rows against 6 (the diffed pairs carry a 64-hex `state_hash`; the decisions projection was `[evaluation_seq, decision_type]`), and every reproduction here shows decisions 7 = 7 with checkpoints 7 vs 5 or 6. The same row's grant names `packages/trading-core/src/pump.ts`, which does not exist (`ls` confirms; the pump is `apps/trader/src/pump.ts`). The handoff discloses both. Remediation: the orchestrator corrects the row (and the OUTAGE-2 handoff doc it writes at the flip); `docs/**` was outside this grant.

[SEVERITY LOW] OUT2-R1-NATURAL-RATE-NOT-REPRODUCED: On this host the UNJITTERED base race did not appear: 0/80 partition runs (30 + 20 sequential, 2 x 15 in parallel) and 0/9 valid stopped runs of the base test with the original settle, against the implementer's 8/60 partition and 2/15 stopped and CI's one failure. The mechanism reproduced deterministically once a delay was added to the checkpoint INSERT (30 ms: 9/10; 100 ms: 5/5, see Classification), so the classification stands on the jittered reproductions plus the structural argument, and the implementer's natural rates are recorded as their measurement, not mine. Not a defect in the candidate; recorded so the numbers in the file's header ("21 of 135") are read as the implementer's host.

## Earlier findings re-check

None: this is the first review.

## Classification (packet A)

**What the extra row was.** `strategy.state_checkpoints`, `checkpoint_seq` 6 (and under heavier delay also 5), the checkpoint of decision `evaluation_seq` 6, an `onOrderUpdate` `hold` at the sixth event's instant (`captured_at` 2026-03-04 12:00:03+00). Never a decision: `before.d` = `after.d` = 7 in every raced run. This matches the CI excerpt (line 381, checkpoints; the diff adds `["6", "d616d8ff…"]`), not the packet's "6 decision rows vs 5".

**How I reproduced it.** A scratch copy of the BASE test (`git show d91a5ad:…`, untracked, deleted afterwards) with the ORIGINAL settle and instrumentation only: (1) `pg_current_snapshot()` + `clock_timestamp()` read immediately before the fault; (2) a second snapshot fired synchronously from the `pump stopped:` log line (the halt's own continuation: `pump()` returns after latching, `main.ts:378-380` then runs the synchronous `checkAccountingRebuild` and logs the line); (3) after exit, every decision, checkpoint, ledger transaction and PnL snapshot of the run with its `xmin`, `recorded_at` and `pg_visible_in_snapshot(xmin::text::xid8, …)` against both snapshots; (4) optionally a scratch `BEFORE INSERT` trigger with `pg_sleep(random()*J)` on `strategy.state_checkpoints`. Node's and PostgreSQL's clocks agreed within 1 ms in every run (`preFaultPgClock` vs `faultAt`).

| base test, original settle | runs | raced (CI shape) | row versions committed after the FAULT | committed after the HALT line |
| --- | --- | --- | --- | --- |
| partition, natural (30 + 20, then 2 x 15 in parallel) | 80 | 0 | 0 | 0 |
| stopped, natural | 9 (+1 `TC-LOCAL-FLAKE` at setup) | 0 | 0 | 0 |
| partition, jitter 5 ms | 10 | 0 | 0 | 0 |
| partition, jitter 30 ms | 10 | 9 | 9 | 0 |
| partition, jitter 100 ms | 5 | 5 | 8 | 0 |
| **total classified** | **115** (1,955 row versions) | 14 | 17 | **0** |

**Against the halt instant.** In all 14 raced runs the extra checkpoint(s) were committed BEFORE the halt line (`before_halt_line = true`, 0 row versions invisible to the halt-line snapshot), about 1.0-1.1 s before it (T = 1000 ms). Examples: jitter 30 ms run 1: cp 5 `recorded_at` 10:23:06.033976, committed before the fault (`before_fault = true`), settle read 06.057, fault 06.057, halt line 07.079 — the natural CI flavour, a row committed before the fault that the settle read did not yet see; cp 6 `recorded_at` 06.053699, committed after the fault (the INSERT was sleeping in the trigger) and before the halt. Jitter 100 ms run 2: cp 6 `recorded_at` 16.744157, fault 16.759, halt line 17.811. Three raced rows in total were committed before the fault, eleven after the fault; all fourteen before the halt.

**Mechanism, read in code.** `loop.ts:1513/1517` counts `decisionsPersisted` in `#consumeOutcome`, when the decision enters the in-memory outbox. `#flushOutbox` (`loop.ts:3190-3219`), the last step of `#processEvent` (`:1028`), writes every decision and THEN every checkpoint, each an awaited autocommit INSERT (`postgres-store.ts:172-250`). The old settle (`eventsProcessed === 6`, decisions == `decisionsPersisted`, transactions == `ledgerTransactions`, nothing about checkpoints) could therefore return with a checkpoint INSERT in flight; the 50 ms poll made the window rarely visible.

**By construction nothing is written after the halt.** `apps/trader/src/pump.ts:83-143`: the halt latches only after a failed `poll()` (:88-104) or `commit()` (:132-143), each issued only after `await loop.drain()` resolved (:110, :127); `drain()` (`loop.ts:900-906`) awaits every `#processEvent`, which holds every store call (`#evaluateMarket` → `#consumeOutcome` → outbox; `#harvestFills` → `appendLedgerTransaction`, `#flushPnlSnapshots`; `#flushOutbox`); an empty queue's `drain()` returns at once. `grep` finds no `setTimeout`/`setImmediate`/`queueMicrotask`/`.then(`/`void this.` in `loop.ts`, `postgres-store.ts` or `main.ts`; after `pump()` returns, `main.ts:378-394` calls only the synchronous, store-free `checkAccountingRebuild`, `health()`, and the closes. So no store write can be in flight when the halt latches. The probes agree: 0 of 1,955 row versions after the halt line. **Classification: TEST RACE. No product defect. No product file changed (correct).**

## Not a weakening (packet B)

**The assertion is still made, and against the halt.** `expectNothingTradedOrWrittenAfter` now takes a `FaultBoundary` read by `readFaultBoundary` immediately before `redis.stop()` / `hop.freeze()` (PostgreSQL's own `pg_current_snapshot()`, with the xid-epoch-0 precondition asserted), and `faultBoundaryBeforeAnyHalt` shows the process still healthy with no halt AFTER that read, so the halt (caused by the fault) follows the boundary. `writesCommittedAfter` enumerates every base table (asserting the five run tables are in the enumeration) and counts row versions `not pg_visible_in_snapshot(xmin::text::xid8, boundary)`: INSERTs and UPDATEs, by commit order, no clock. A row committed after the halt is committed after the boundary, so "empty" is at least as strict as "nothing after the halt"; and it cannot fail a correct process because the process is quiescent at the boundary (below). Then the quiescent rows must equal the rows after exit, compared WHOLE (previously projections: `[seq, type]`, `[seq, hash]`, ids, a length, `realized_pnl`), including `ledger_entries` and `pnl_snapshots` (the one table the store UPDATEs, `replacePnlSnapshot`). The counters-at-exit equality and the `typeof amount === "string"` decimal check are kept. The idle case gains the boundary check and now asserts all four run tables are empty (it checked decisions only). No timing bound, exit code, halt triple or detail assertion changed.

**Planted writes (scratch copies of the CANDIDATE file, untracked, deleted afterwards; one run each):**

| plant | where | result |
| --- | --- | --- |
| checkpoint INSERT (seq 99) | partition, after the halt | FAIL: `a row was committed after the fault boundary … + "strategy.state_checkpoints: 1 row version(s)"` |
| same-value `UPDATE accounting.pnl_snapshots SET realized_pnl = realized_pnl` | partition, after the halt | FAIL: `"accounting.pnl_snapshots: 1 row version(s)"` |
| decision INSERT (seq 99) | stopped, after the halt | FAIL: `"strategy.decisions: 1 row version(s)"` |
| checkpoint INSERT | idle, after the halt | FAIL: `"strategy.state_checkpoints: 1 row version(s)"` |
| decision INSERT | partition, between quiescence and the boundary | MVCC check PASSES (correct: before the boundary); FAIL at `expect(rows.decisions).toEqual(before.rows.decisions)` (8 vs 7) — the two checks are distinct and both live |
| mutant: `writesCommittedAfter` returns `[]` + same-value PnL UPDATE | partition | PASSES — only the MVCC check sees a same-value UPDATE, so it adds real coverage (matches the handoff) |
| mutant: `writesCommittedAfter` returns `[]` + checkpoint INSERT | partition | FAIL by the whole-row comparison (defence in depth) |

**The quiescence condition is sound and not a sleep.** `publishSixAndSettle` waits until `publisher.streamMetrics(stream)` reports `publishedTotal === 6` and the trader's consumer (`consumerIdOf(document)` = `infrastructure.consumerId`, "trader-1" in `support/fixture.ts:219`) at `lag === 0`. That lag is computed from the STORED checkpoint (`transport.ts:372-411`: `hgetall(keys.checkpoints)`, judged by the server's script, `publishedTotal - position.sequence`), which only `subscription.checkpoint()` writes (`subscription.ts:293`), which only `RedisMarketEventFeed.commit()` calls (`redis-feed.ts:114-127`) with the LAST delivered event's checkpoint, which the pump calls only after `await loop.drain()` (`pump.ts:127-132`). Hence lag 0 ⇒ the drain holding the sixth event's writes has resolved ⇒ every awaited autocommit INSERT/UPDATE has committed, and with no seventh event and an empty queue nothing can write again. The counter/row equalities are then ASSERTED (including §9.6 checkpoints 1:1 with decisions by sequence) rather than waited for. Verified empirically: candidate settle under 100 ms checkpoint jitter, partition 5/5 and stopped 3/3 pass; with the OLD wait predicate restored in the candidate copy (new assertions kept), jitter 100 ms fails 5/5 AT SETTLE TIME on the §9.6 assertion (`expected ['0'..'4'] to deeply equal ['0'..'6']`), i.e. the old predicate is provably not a quiescence condition and the new assertion is live; the same old predicate, natural, passed 10/10 here (see finding 3).

**No retry-until-green.** `grep` for `.skip`, `.only`, `eslint-disable`, `ts-ignore`, `ts-expect-error`, `retry` in the file: none (the word "retry" appears once, in the pre-existing header sentence about the publisher's connect); `vitest.config.ts` has no `retry`. The candidate's `waitFor` is the same bounded 50 ms poll the base used, now on a monotone, event-driven condition.

## Stability (packet C)

- Candidate whole file (`redis-outage-halts`, 4 tests): **20/20** consecutive here (10 in the mechanical gate, 10 more), 19.7-22.6 s each. The implementer reports 25/25 at `f70682e` and 30/30 before the doc edit.
- Trader integration suite: **twice**, 20 files / 161 tests each (26.3 s, 26.1 s), with the outage measurements: stopped default T halt +4653/+4651 ms; idle T=1000 halt +695/+668 ms; partition T=1000 halt +1001/+1000 ms, return +3003/+3002 ms.
- Candidate under 100 ms checkpoint jitter: partition 5/5, stopped 3/3 (the `-t "container stopped"` filter also ran the idle case each time; it passed).
- `TC-LOCAL-FLAKE`: seen ONCE in 205 scratch/gate runs, in a BASE probe run (stopped, `connectPublisher`: "a fresh Redis container never accepted a connection"), at setup, before the process under test starts. Never in a candidate-file run. Pre-existing and queued; out of scope.

## Scope and gates (packet D)

- `git diff --name-only d91a5ad f70682e` = `test/integration/paper-trader/redis-outage-halts-postgres-redis.test.ts` only (+223/−39). No support helper, product, package, docs or lockfile change; `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs` unchanged. scope_violations: none. Product paths were correctly NOT touched, since item 1 found no defect.
- Safety: `safeEnvironment()` (`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`) unchanged; PAPER throughout; throwaway container credentials; no venue, signer, wallet or real order. Exact-decimal rule preserved (`typeof row.amount === "string"` kept; no decimal code touched).
- Gates (all exit 0; `gates-r1.txt`): typecheck; lint; check:deps; `pnpm run test` 358 files / 7732 tests; `test:e2e` 8 / 206; `test:replay` 3 / 17; trader `test:integration` 20 / 161 twice; outage file x10: 10/10. Counts equal the handoff's.
- Handoff accuracy: the deviations (checkpoint not decision; `pump.ts` path; MVCC boundary instead of `recorded_at`, with the reason that `recorded_at` is `now()` at transaction START and misses UPDATEs — confirmed: `recorded_at` default `now()` in `0004_strategy.up.sql`, and the same-value UPDATE probe) and the known risks (`TC-LOCAL-FLAKE`, the boundary stricter than "after the halt", deletes invisible to the MVCC check) are all accurate and were each confirmed here. The commit message matches the evidence.

## Not verified

- The implementer's NATURAL race rates (3/30, 5/30, 2/15, 7/30, 4/30, 13/60, 12/60) did not reproduce on this host (finding 3); I verified the mechanism with jitter and the structural argument instead.
- The implementer's 25/25 and 30/30 stability series are their measurement; mine is 20/20 plus the two suite runs.
- GitHub CI on this commit is the orchestrator's step; local timings match CI's (+1.0 s halt, +3.0 s exit).
- No soak, no live gate, no execution probe; nothing here is live evidence.

## Residuals (not findings)

- `information_schema.tables` lists only tables the test role can see; the arrayContaining assertion on the five run tables guards against an empty scan, and the throwaway database is owned by that role.
- The MVCC check requires PostgreSQL 13+ (`pg_current_snapshot`, `xid8`); the container is `postgres:16.6-alpine`.
- The idle test's name contains "the container stopped", so a `-t "container stopped"` filter selects two tests; pre-existing naming, cosmetic.
- `OUT1-R1-HALT-NOT-DURABLE` remains open (the halt is still not persisted); see finding 1 for the interaction with this file when it is closed.

## Restoration

- Review worktree at `f70682eda73531827562db670bd3f0746ed53d2f`, `git status --porcelain` empty, `git diff HEAD --stat` empty (no tracked file was ever edited: every probe was a NEW untracked file, generated by script from `git show d91a5ad:…` and the candidate with anchored edits, and both were deleted). No commit made. The implementation worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-outage-2` was not touched.
- Containers: `docker ps -a --filter label=org.testcontainers=true` is empty (every Testcontainers Redis/PostgreSQL container and the Ryuk reaper from the gates and probes is gone); the host's unrelated pre-existing containers were not touched.
- Processes: no vitest, runner or probe process of mine remains (`pgrep` empty).
- The review scratch directory `…/scratchpad/outage-2/review-scratch/` (probe generator, runner, per-run logs, classification JSONL) was deleted as instructed; `gates-r1.txt` and this report remain.

REPORT COMPLETE
