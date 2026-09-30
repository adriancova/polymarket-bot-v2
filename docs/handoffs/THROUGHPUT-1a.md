# THROUGHPUT-1a — ~11-12x trader throughput, byte-identical decisions, stream lag visible

**Status:** COMPLETE. Merged `229d58a` (`--no-ff`) with tip `60c8d93` on base `051d058`. HARDENING LOOP `wf_0ee60dfa-16b`. The verifier was a Fable adversarial-reviewer: r1 **ACCEPT**. CI: PR #24 run `36669807701`, green on the merge ref after `DEPS-1` (`f6a2714`). The first attempt's only failure was the dependency audit.

**Provenance note:** a machine restart on 2026-09-30 wiped `/tmp`. So the implementer's handoff file and the reviewer's full report were lost. Below are the implementer's structured return and the reviewer's structured result, verbatim from the workflow journal. The `THROUGHPUT-1a` review was restarted from scratch after the restart.

## Reviewer findings (r1, ACCEPT)
- **[LOW] F1-BENCH-OMITS-SAMPLER**: The benchmark harness does not run the TransportLagSampler (nor the health HTTP server) that the shipped startup() runs, and does not say so.
- **[LOW] F2-HANDOFF-MEASUREMENTS**: The handoff record lacks the measurements section and the CPU-profile top-N attribution (before and after) that the packet's Handoff paragraph and Acceptance 1 require.
- **[LOW] F3-POSITION-ONE-POLL-LATE**: With the pipelined pump, a batch's stream position is recorded only when the NEXT poll() returns, so on a quiet stream TransportHealth.committedPosition trails the delivered position by one batch for up to one blocking-read bound, and a crash re-reads up to one more batch than the per-row path did.
- **[LOW] F4-DOOR-REQUIRES-TRANSPORT**: The control API's health door makes transport REQUIRED, so a trader built before this commit is refused until both deploy together.
- **[LOW] F5-SIGNATURE-LIST**: The packet asks that every exported-signature change be listed and justified in the handoff for the performance-only packages; the handoff lists the observability additions and mentions prepareEvaluationView and GROUP_COMMIT_*, but does not enumerate the others.
- **[LOW] F6-CRASH-TEST-TIMING**: The SIGKILL test depends on catching the trader's commit in pg_stat_activity wait_event_type = 'Lock' within 60 s.

Reviewer notes: Mechanical part: review worktree was already clean at start (nothing dirty to record); detached at 60c8d93; 60 changed files all within allowed paths; no golden changed; root package.json, pnpm-lock.yaml, eslint.config.mjs unchanged; no new scripts entry. All nine gates exit 0. Review: benchmark reproduced on my own containers (candidate run.sh; same harness copied into a detached 051d058 worktree for base; one registered clone for all runs) -- base catch-up 53.7 events/s (17,027 us/event, 179,399 commits), candidate catch-up 607.7 events/s (1,680 us/event, 992 commits), base paced max lag 1,716 s, candidate paced max lag 36.7 s (p99 36.3 s), no halts anywhere; ratios match the handoff (11.3x vs claimed 11.8x), absolute numbers 25-30% better than claimed (quiet host), so claims are conservative. Semantic identity: base vs candidate decisions.jsonl and checkpoints.jsonl byte-identical (89,621 rows each, every exported column incl. feature_snapshot_ref/state_hash), health counters identical; canonicalFragment verified to stay inside the inputsSha256 digest only. Durability: SIGKILL test passes at head; my mutants M1 (position before durability) fails 473 vs 461, M3 (hard bound removed) fails, M4 (non-atomic commit, checkpoints first) fails 443 vs 442; M2 (sampler disabled) fails both lag tests. Targets NOT met (catch-up 607.7 < 735; paced 36.7 s > 5 s) but the packet accepts a STOP with measurements and ranked options; the ranked options are consistent with my CPU profile (evaluation 83.4%, reference features 14.3%, Polymarket features 9.2%, strategy prepare 6.4%, decimal guard wrapper ~25% total/~10% self). Cleanup: tp1a-rev-redis/tp1a-rev-pg removed, base worktree removed and pruned, review-scratch deleted (evidence kept in scratchpad/throughput-1a/fable-r1-evidence/), no lingering bench/vitest/esbuild processes; orchestrator containers, :9090/:3000 and ~/pmb-h1 untouched. An unrelated container tradebot-saas-postgres-test exists on the host; not started by me, left alone. Verdict ACCEPT: no finding above LOW.

## Implementer handoff (structured return, verbatim)

### summary

THROUGHPUT-1a is on branch throughput-1a: 6 commits on 051d058, head 60c8d93. All three items are delivered, but the throughput targets are NOT met. Following the packet, I stopped at the best result that keeps the semantics and ranked the remaining options (see follow_up).

(1) Benchmark
- tools/bench/trader-throughput/run.sh and its README. The harness is in test/integration/paper-trader/support/throughput/.
- It publishes through the real event-bus publish API, registers through REGISTER-1, and runs the real durable trader (assembleDurableTrader, PostgresTraderStore, RedisMarketEventFeed, pump) on real Redis and PostgreSQL.
- Catch-up and paced modes (paced uses a separate publisher process).
- Reports wall and CPU time, events/s, decisions/s, lag max/p99/p50, halts, health counters, durable counts and content digests. --cpu-prof adds a top-N by self and total time.
- `register` plus `--registered` clones one database, so base and candidate can be compared exactly.
- A committed 2,000-event sample drives it in the trader integration suite.

(2) Cost removal, no semantic change
- Catch-up: 41.3 → 485.9 events/s (11.8x). CPU per event: 22.2 → 2.1 ms. PostgreSQL commits: 179,419 → 1,006. Same registered clone, no profiler.
- On the full fixture, base and candidate decisions.jsonl and checkpoints.jsonl (89,621 rows each) are byte-identical. That covers every exported column, including feature_snapshot_ref, state_hash, evaluated_at and captured_at. Health counters are identical too.
- Goldens untouched; test:replay and test:e2e pass.
- Group commit bounds: a commit is requested at 32 staged events, when the oldest staged event is 50 ms old, or at the end of a drain. At 128 staged events the loop waits for durability before evaluating more, so at most 256 events are ever undurable. Each commit is one data-modifying CTE statement. The pump records a batch's stream position only after that batch is durable.
- SIGKILL test on the real trader process:
  - the durable rows are exactly the first k rows of an uninterrupted run, with no gap and no duplicate;
  - the stored position is exactly the end of the last durable batch;
  - restarting the same run exits 78;
  - a new run resumes exactly after the stored position.
  - A planted pump that records the position before the rows fails the test (791 vs 461).

(3) Lag visible
- Health gains a `transport` section: head, consumer and committed positions, entries behind head, retention, and event-time lag against the wall clock. It is sampled every 1 s off the pump's path; one sample is 3 Redis round trips for one consumer.
- The control API door, schema and fixtures are updated, and four metric families render: trader_transport_lag_entries, trader_transport_retention_max_events, trader_transport_sample_age_seconds, trader_event_time_lag_seconds. The operations dashboard gains two panels.
- The integration test shows lag rising while paused and falling after catch-up; it fails with sampling disabled. Retention-exceeded still halts.

Targets
- Catch-up: 486 events/s against 735.
- Paced: no halt, but max lag 125 s against 5 s (base: 2,137 s).
- On this fixture's arrival times, max lag ≤ 5 s needs about 943 events/s sustained; 735 events/s would still lag about 14 s.

### files_changed

[
 "packages/features/src/book-serialization.ts",
 "packages/features/src/canonical-json.ts",
 "packages/features/src/canonical-order.ts",
 "packages/features/src/canonical-order.test.ts",
 "packages/features/src/compute/polymarket.ts",
 "packages/features/src/compute/reference.ts",
 "packages/features/src/index.ts",
 "packages/features/src/inputs.ts",
 "packages/features/src/materialize.ts",
 "packages/features/src/prepared-reference.ts",
 "packages/features/src/prepared-reference.test.ts",
 "packages/features/src/snapshot.ts",
 "packages/order-book/src/book.ts",
 "packages/order-book/src/side-cache.test.ts",
 "packages/strategy-runtime/src/index.ts",
 "packages/strategy-runtime/src/json.ts",
 "packages/trading-core/src/health.ts",
 "packages/trading-core/src/index.ts",
 "packages/trading-core/src/loop.ts",
 "packages/trading-core/src/market-state.ts",
 "packages/trading-core/src/market-state-memo.test.ts",
 "packages/trading-core/src/ports.ts",
 "packages/trading-core/src/reference-state.ts",
 "packages/observability/src/control/dashboards.ts",
 "packages/observability/src/control/index.ts",
 "packages/observability/src/control/metric-families.ts",
 "packages/observability/src/control/metric-shapes.ts",
 "packages/observability/src/control/samples.ts",
 "packages/observability/src/control/testing.ts",
 "apps/trader/src/adapters/postgres-store.ts",
 "apps/trader/src/adapters/redis-feed.ts",
 "apps/trader/src/index.ts",
 "apps/trader/src/main.ts",
 "apps/trader/src/pnl-observation.ts",
 "apps/trader/src/pump.ts",
 "apps/trader/src/transport-lag.ts",
 "apps/trader/src/transport-lag.test.ts",
 "apps/control-api/src/health-door.ts",
 "apps/control-api/src/testing/index.ts",
 "apps/control-api/src/transport-lag.test.ts",
 "infra/grafana/control/operations-dashboard.json",
 "tools/bench/trader-throughput/run.sh",
 "tools/bench/trader-throughput/README.md",
 "test/fixtures/trader-throughput/burst-sample.jsonl",
 "test/fixtures/trader-throughput/market-opened.json",
 "test/fixtures/trader-throughput/template.json",
 "test/integration/paper-trader/support/throughput/bench-main.ts",
 "test/integration/paper-trader/support/throughput/fixture.ts",
 "test/integration/paper-trader/support/throughput/harness.ts",
 "test/integration/paper-trader/support/throughput/profile-top.ts",
 "test/integration/paper-trader/support/throughput/publish-main.ts",
 "test/integration/paper-trader/support/throughput/publisher.ts",
 "test/integration/paper-trader/throughput-bench-harness-postgres-redis.test.ts",
 "test/integration/paper-trader/group-commit-loop.test.ts",
 "test/integration/paper-trader/group-commit-crash-recovery-postgres-redis.test.ts",
 "test/integration/paper-trader/transport-lag-postgres-redis.test.ts",
 "test/integration/paper-trader/support/fixture.ts",
 "test/integration/control-api/trader-health-shape.test.ts",
 "test/unit/strategy-runtime/boundary-surface.test.ts",
 "test/unit/strategy-runtime/prepared-view.test.ts"
]

### tests_run

All suites ran serially on this host, with pnpm_config_verify_deps_before_run=false on every pnpm command.

Static gates (re-run at head 60c8d93)
- pnpm run typecheck: exit 0.
- pnpm run lint: exit 0.
- pnpm run check:deps: exit 0.

Test suites
- pnpm run test: 365 files, 7,770 tests passed. This includes all the new unit tests.
- test:e2e: 8 files, 206 tests passed.
- test:replay: 3 files, 17 tests passed. The worktree was clean afterwards, so no golden was written.
- Trader test:integration:
  - First run: 174/174 passed, but exit 1 on 2 unhandled 57P01 errors.
  - Cause: the lag test's migration pool was never ended. Fixed in 9aa0f3a.
  - Re-run: 24 files, 174 tests passed, exit 0.
- Control-api test:integration:
  - First run: 1 failure. The drift pin's unattached snapshot rendered no transport series.
  - Fixed in 60c8d93.
  - Re-run: 10 files, 87 tests passed.
- Event-bus test:integration: 9 files, 99 tests passed.

Non-vacuity checks (each mutant reverted; worktree verified clean)
- SIGKILL crash test with a pump that records the position before the rows: FAILS, "expected 791 to be 461".
- Group-commit stall test with the backpressure line removed: FAILS.
- Lag integration test with sampling disabled: both tests FAIL, "no transport sample landed within 5 s".
- The group-commit files were re-run twice more at head: 9/9 passed both times.

Benchmarks (full H1 fixture, 99,669 events)

| Run | Events/s | CPU µs/event | Max lag | Halts | Durable content |
|---|---|---|---|---|---|
| Base catch-up | 41.3 | 22,167 | 2,415 s | none | — |
| Candidate catch-up (registered clone) | 485.9 | 2,095 | 205 s | none | raw digests = base |
| Candidate catch-up (fresh containers) | 480.0 | 2,119 | 208 s | none | normalized digests = base |
| Candidate, profiled | 418.8 | — | — | none | — |
| Candidate paced | 381.1 | — | 125.4 s (p99 120.9) | none | = base |
| Base paced | 43.8 | — | 2,137 s | none | = candidate |

- Exact comparison (compare.py plus cmp): decisions and checkpoints, 89,621 rows each, IDENTICAL and byte-identical.

### assumptions

- Throughput numbers come from runs without the profiler; the 250 µs profiler costs about 13% of wall time.
- Catch-up events/s is consumed envelopes over the measured window.
- Lag is the host-clock time from publish to the trader recording a stream position that covers the event. The pump records a position only after the rows of every earlier event are durable.
- The base-vs-candidate comparison uses every column the harness exports, which is more than the packet's list. Ids and recorded_at are excluded.
- "Decision-producing events" are unchanged: 89,621 evaluations. ReferenceTopOfBookChanged (10,047 events) is refused as EVENT_TYPE_NOT_CONSUMED, exactly as on base.
- The host is shared (THROUGHPUT-1b ran in parallel). Earlier profiled runs of an intermediate version varied by about ±20%. The two final unprofiled candidate runs agree within 1.2%.
- CPU µs/event is reported as the steadier metric.

### deviations

1. packages/observability is allowed only for performance-only changes, but item 3's control-API metrics can only be defined there. I added four gauge families, the TraderTransportHealthInput type, a required TraderHealthReportInput.transport, two required dashboard panel titles, and testing values. No existing family or encoding changed.

2. Three existing test files were edited; no assertion was weakened:
   - support/fixture.ts gains an optional wrapStore.
   - boundary-surface.test.ts registers the new public prepareEvaluationView.
   - control-api trader-health-shape.test.ts attaches a transport section built by the real producer and asserts four exact values.

3. The bench replays the H1 burst from index 332 (99,668 envelopes plus MarketOpened). The first 332 envelopes carry level changes with no baseline snapshot, which would halt with BOOK_DESYNCHRONIZED.

4. Harness arrangements:
   - pump is called with untilIdle:true in a loop, which adds one extra empty poll per return;
   - the feed is wrapped in a pass-through PositionLog that logs when each position was recorded;
   - the trader runs in the harness process; the paced publisher is a separate process.

5. The harness TypeScript lives under test/integration/paper-trader/support/throughput/. The lint typed-program test forbids linted files outside its globs, and eslint.config.mjs is protected. tools/bench holds run.sh and the README.

6. The crash proof cannot restart the same run: BOOT-1 refuses it with exit 78, which the test asserts. It starts a NEW run instead and shows it resumes exactly after the stored position and decides exactly the reference's remaining events. The new run's decision content is not compared, since fresh state and ids mean it cannot match.

7. The targets are not met (catch-up 486 events/s against 735; paced max lag 125 s against 5 s). I stopped as instructed; no semantic change was implemented.

8. The GROUP_COMMIT_* constants are exported from loop.ts only, not the package index.

### known_risks

1. Under a PostgreSQL outage, the halt now latches up to one staged batch plus one in-flight commit later (at most 256 events).
   - Those decisions never route an intent or write a ledger or PnL row: the loop waits for durability first.
   - They never become durable, and no stream position is recorded past them.
   - The per-row path halted at the first failed write.
2. recorded_at is the same for every row of a batch.
3. The decisionsPersisted health counter (counted before the write, as on base) can now lead durability by up to one batch.
4. The control API health door now requires `transport`, so the trader and the control API must deploy together.
5. Memo and prepared-tree caches:
   - They are keyed by exact content or identity, and every one is pinned by a test against a fresh computation.
   - Their sizes are bounded; the identity maps are WeakMaps.
   - Prepared trees are deep-frozen, so any caller that mutated an input it handed in would now throw. No such caller exists in the repo.
6. The single-statement commit relies on PostgreSQL's documented behaviour that data-modifying WITH members always run to completion. Batches over 1,000 rows fall back to an explicit transaction.
7. Lag samples land only when the process yields to I/O, which in practice is between receive batches.
8. The crash test depends on timing (polling pg_stat_activity for a lock wait, 60 s deadline). It has passed in every run.
9. Host measurement noise is about ±20%. Compare CPU µs/event: base 22,167; candidate 2,095 to 2,119.

### follow_up

Options to reach the targets, none implemented. Semantic options need a ruling or ADR.

1. Per-frame evaluation (H1R1-FRAME-ATOMICITY).
   - Grouping consecutive book events that share receivedAt (a stand-in for a gateway frame) cuts evaluations from 89,621 to about 31,546.
   - Evaluation is about 82% of candidate CPU, so the estimated gain is about 2.1x, to about 1,000 events/s, with a modelled paced max lag of about 4.5 s.
   - It is the only single option that plausibly meets both targets. It needs a gateway frame marker and a golden re-baseline.
2. Compute only the features the strategy consumes. Reference features are 13.6% of CPU and Polymarket features 8.4%. This changes the content-addressed feature_snapshot_ref.
3. Skip events that cannot move a consumed feature. The gain was not measured.
4. Checkpoint only when state changes. The gain is small, since PostgreSQL is no longer the bottleneck.

Semantics-preserving options outside this package's reach or not done:
- (a) Exact incremental EWMA: at most 10.1%, with review risk in proving the rounding exact.
- (b) Cache the strategy's parameter validation per params object: 6.8%, but it is in packages/strategies, which is forbidden here.
- (c) The decimal guard overhead: packages/decimal is protected.
- Together (a) to (c) are about 20%, roughly 600 events/s, still below 735.

Other:
- createMigratedContext().close() leaks its pool when Kysely never ran a query. This is latent in other tests too; I did not fix it.
- Document the transport health section, the four metrics and the two panels (docs/** is forbidden to this package).
- IMPLEMENTATION_STATUS needs updating by the orchestrator.
- THROUGHPUT-1c should expect a live H1-rate burst to still lag about 2 minutes on this candidate.

### commit_sha

60c8d93
