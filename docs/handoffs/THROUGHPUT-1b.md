# THROUGHPUT-1b — the gateway publisher batches consecutive envelopes; the example config subscribes to books

**Status:** COMPLETE. Merged `c179095` (`--no-ff`) with tip `e5fdf42` on base `051d058`. HARDENING LOOP `wf_0ee60dfa-16b`. The verifier was a Fable adversarial-reviewer: r1 **ACCEPT**. CI: PR #23 run `36669802877`, green on the merge ref after `DEPS-1` (`f6a2714`). The first attempt's only failure was the dependency audit.

**Provenance note:** a machine restart on 2026-09-30 wiped `/tmp`. So the implementer's handoff file and the reviewer's full report were lost. Below are the implementer's structured return and the reviewer's structured result, verbatim from the workflow journal. The `THROUGHPUT-1a` review was restarted from scratch after the restart.

## Reviewer findings (r1, ACCEPT)
- **[LOW] TP1B-R1-L1**: The unthrottled-ceiling figures in the handoff and tools/bench/gateway/README.md did not reproduce within 20% as absolute numbers on this host, although every outcome, high-water mark and overflow point did (candidate 21,193–22,188/s vs 27,205–29,011/s claimed; base 3,114–3,221/s vs 3,821–4,216/s claimed; both sides proportionally low under a parallel 1a review, ratio 6.9x = 6.9x).
- **[LOW] TP1B-R1-L2**: The CI workflow's label and count are now stale, as the handoff discloses (follow_up): .github/workflows/ci.yml:185 "Integration tests 4/6 - data-gateway (no container)" and the N5 recount comment at :158–170, because test/integration/data-gateway/publish-throughput.test.ts now starts a Testcontainers Redis in beforeAll; orchestrator-owned file.
- **[LOW] TP1B-R1-L3**: A pre-existing duplicate hazard is widened, as disclosed (known_risks 2): packages/event-bus/src/redis/client.ts leaves ioredis's autoResendUnfulfilledCommands at its default, so a PUBLISH_BATCH_SCRIPT call whose reply is lost on a reconnect inside the 5 s commandTimeout can be re-sent and re-executed server-side, appending the same run (up to 256 envelopes, previously 1) again with fresh ordinals; recommend the implementer's named follow-up round.
- **[LOW] TP1B-R1-L4**: The bounded in-flight window grew from 1 envelope to up to 256 envelopes / 1 MiB submitted-but-unsettled above the 1,024 / 8 MiB admission queue, and the depth gauge deliberately excludes them (GatewayPublisher.#dequeueRun, #drainQueue); documented, and my docker-pause runs show the same halt shape as base (1,025 not published, contiguous prefix). Informational.
- **[LOW] TP1B-R1-L5**: publish-throughput.test.ts "the committed sample at TWICE its recorded pace" asserts a timing outcome (no overflow at ~6,300/s with the default bounds), disclosed as known_risks 5; 4/4 passes here at HWM 25–60 of 1,024 and base overflows every time (M6), so it is meaningful, but a much slower runner could flake it.
- **[LOW] TP1B-R1-L6**: RedisStreamsEventTransport.publishBatch refuses an envelope of a second gatewayEpoch inside one batch as an ordering error (transport.ts, "a batch publishes one gatewayEpoch"), stricter than N single publish calls; unreachable from the gateway (one epoch per boot), documented in the JSDoc, and my probe shows a clean halt with nothing after it. Informational.

Reviewer notes: Mechanical part: the review worktree was clean (empty porcelain) before checkout; detached at e5fdf425f2d8eff5efdfcbd89abd5f1eab8cd01c. Scope: 22 files, all in allowed paths; no golden file; root package.json/pnpm-lock.yaml/eslint.config.mjs unchanged; no .skip/.only/eslint-disable/ts-ignore/retry in added lines. All 8 gates exit 0 with counts identical to the handoff. Review part: benchmark reproduced on base and candidate (uniform and recorded pacing at 735/1500/3000 + saturate x3, --prefill 100000, default bounds) with every overflow/no-overflow outcome and HWM reproducing (candidate 1,500/s recorded: no overflow, HWM 202; base: overflow at 72,540 vs 73,026–73,210 claimed); absolute ceilings 16–27% low on BOTH sides because a parallel 1a review loaded the host (its paper-trader vitest processes and tp1a-* containers were running; I never started those). Byte identity on the full 100,000-envelope fixture: base and candidate streams byte-equal with ids stripped at retention 100,000 and at 7,777 (trim active), counters 100000/100000. Fail-closed: literal docker pause (3 s) identical shape on both sides; my scratch vitest probe (real transport + real publisher, 3/3) for a door refusal inside a 39-envelope batch, a foreign-epoch envelope mid-batch, and a mid-run counter denial consuming no ordinal; planted mutants M1/M3/M4/M5/M6 each caught by the named tests and every file restored byte-identically (sha-checked). Book feed: harness tests plus my own real-bundle runs on loopback (with the example's polymarket block: no announcement, exit 0; without: [incident] NOTIFY GATEWAY_BOOK_FEED_ABSENT printed at start). Cleanup: my base worktree removed and pruned (the remaining scratchpad/throughput-1a/base-wt entry is the 1a review's), review-scratch deleted (gates-r1.txt and fable-r1.md kept), zero tp1b-rev containers, no process of mine running; protected trader containers, :9090/:3000 and ~/pmb-h1/ untouched. Not verified: --cpu-prof percentages; the live gateway under co-located load (the H1 re-run is the proof); the other integration suites not required by the packet.

## Implementer handoff (structured return, verbatim)

### summary

THROUGHPUT-1b is complete at tip e5fdf42, branch throughput-1b, not pushed. All three items are done and the target is met.

(1) Benchmark
- Committed as tools/bench/gateway/run.sh + README, with the harness and CLI in test/integration/data-gateway/bench/. The lint coverage pin forbids code files under tools/bench.
- Drives the REAL GatewayPublisher over the REAL RedisStreamsEventTransport against a fresh redis:7.4.2-alpine per rate, with the DEFAULT admission bounds.
- Input: the fixture's envelopes, re-stamped with one epoch and ingestSeq 1..n. An optional prefill brings the stream to its 100,000 retention first, so trimming is active.
- Offered load: uniform, or "recorded" (the fixture's own receipt instants scaled to a mean rate), plus a closed-loop unthrottled ceiling.
- A 1.8 MB sample (2,800 envelopes) is committed. publish-throughput.test.ts drives both the harness and run.sh on it.
- The baseline was measured on 051d058 first. The burst is very bursty (3,107 events in its busiest second), so uniform pacing hides the failure and recorded pacing reproduces it.

(2) Target met, publication semantics unchanged
- Full fixture, recorded pacing:
  - base overflowed at 1,500/s (2x) and 3,000/s (4x) in 3 of 3 runs;
  - the candidate never overflowed: queue high-water mark (HWM) 175-250/1024 at 2x, 265-343 at 4x, and 65-91 at 1x (base: 396-402).
- Unthrottled ceiling: 3,821-4,216/s on base, 27,205-29,011/s on the candidate.
- Profile: base is 52.9% idle, bound by one Redis round trip per envelope; it overflowed at 1,500/s while 81% idle.
- The fix batches consecutive queued envelopes into one round trip:
  - PUBLISH_BATCH_SCRIPT: prevalidates the whole run, undoes its own appends on any failure (all or nothing), and trims exactly, once, last;
  - RedisStreamsEventTransport.publishBatch: the same door and the same per-epoch ordering check per envelope, in the same serialized section; it returns the published prefix plus the first failure;
  - the pump in GatewayPublisher sends the run (at most 256 envelopes / 1 MiB).
- Unchanged: publish() itself, the interface, admission, the bounds and their defaults, dedup, halts.
- Byte identity on the FULL fixture: base and candidate streams are identical (ids ignored), both with retention 100,000 and with 7,777 (trim active).
- Fail-closed:
  - a literal docker pause gives the same overflow halt at 1024/1024 on both sides, and the stream is a contiguous prefix ending before the halt;
  - the committed test does the same with a frozen TCP hop;
  - an in-batch refusal halts with nothing after it (real transport and unit tests);
  - a counter-write failure leaves the stream and counter exactly as found.
- Six planted mutants are caught, including "append past a refusal" in the transport and in the publisher.

(3) Book feed
- The example config gains "polymarket": {"feedId": "polymarket-market"} and passes the door (new unit test).
- The README says books need it.
- A gateway with markets and no polymarket block opens a NOTIFY GATEWAY_BOOK_FEED_ABSENT at start, in the stream and in the [incident] log. Tested through the harness and through the REAL bundle's stderr.

Handoff with full measurements: /tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/throughput-1b/handoff-r0.md

### files_changed

[
 "packages/event-bus/src/redis/scripts.ts",
 "packages/event-bus/src/redis/client.ts",
 "packages/event-bus/src/redis/transport.ts",
 "packages/event-bus/src/redis/transport.test.ts",
 "apps/data-gateway/src/publisher.ts",
 "apps/data-gateway/src/publisher.test.ts",
 "apps/data-gateway/src/main.ts",
 "apps/data-gateway/src/gateway.ts",
 "apps/data-gateway/src/config.test.ts",
 "apps/data-gateway/src/testing/memory-transport.ts",
 "infra/compose/data-gateway/gateway.config.example.json",
 "infra/compose/data-gateway/README.md",
 "test/integration/event-bus/publish-batch.test.ts",
 "test/integration/data-gateway/publish-throughput.test.ts",
 "test/integration/data-gateway/book-feed-absent.test.ts",
 "test/integration/data-gateway/univ-4-market-lifecycle.test.ts",
 "test/integration/data-gateway/vitest.config.ts",
 "test/integration/data-gateway/bench/publish-bench.ts",
 "test/integration/data-gateway/bench/publish-bench-cli.ts",
 "test/integration/data-gateway/fixtures/burst-sample-2026-09-29T2100.jsonl",
 "tools/bench/gateway/run.sh",
 "tools/bench/gateway/README.md"
]

### tests_run

Gates at the tip e5fdf42. All exit 0, all run serially with pnpm_config_verify_deps_before_run=false:
- pnpm run typecheck: 35 package typechecks Done, plus the test, e2e and soak programs.
- pnpm run lint: clean.
- pnpm run check:deps: PASS.
- pnpm run test: 359 files, 7,748 tests.
- pnpm run test:e2e: 8 files, 206 tests.
- pnpm run test:replay: 3 files, 17 tests.
- pnpm --filter @polymarket-bot/data-gateway test:integration: 14 files, 104 tests.
- pnpm --filter @polymarket-bot/event-bus test:integration, serially after: 10 files, 112 tests.

History:
- The first full data-gateway run (tree of 7e36307) failed two of my NEW tests on test-timing bugs, both fixed in e5fdf42:
  - the stall test's lower bound (299 published is legal);
  - SIGTERM sent before run.ts installed its signal handlers.
- After the fix: publish-throughput 6/6 runs, book-feed-absent 8/8, the full data-gateway suite 3/3 plus once more at the tip.

Extra, outside my paths (run only): test/integration/paper-trader/univ-4-gateway-opens-trader-redis.test.ts, 2/2 passed. It wires the real gateway over the real Redis, now on the batch path.

Evidence runs:
- Benchmark sweeps: 3 repetitions per side on the full fixture, uniform and recorded pacing at 735/1,500/3,000 plus saturate.
- CPU profiles on both sides.
- Sample runs at 1x/2x/3x recorded pace.
- Full-fixture byte-identity dumps.
- A literal docker pause scenario on base and candidate.
- Six mutation runs.

Not run: the storage-postgres, research-worker, full trader and control-api integration suites; test:fault; test:contract; test:soak-smoke; audit.

### assumptions

- ADR-003 does not require one round trip per publish. Batching is allowed if the stream entries, their order, per-epoch ordering, dedup, halts and retention stay the same.
- Exact trimming is required (the RetentionPolicy says "enforced exactly"), so it was kept: MAXLEN without ~, once per batch, last.
- A bounded in-flight run of at most 256 envelopes / 1 MiB beyond the admission queue is acceptable. The depth gauge keeps its meaning, "admitted and not yet submitted"; before, exactly one uncounted envelope was in flight.
- The unthrottled ceiling means a closed-loop producer: the queue is kept at half its bound. An open-loop unthrottled producer overflows 1,024 in its first turn by construction.
- Recorded-timing pacing is the relevant reproduction of "the window-open burst". Uniform results are also reported, as the packet asked.
- Base numbers come from a separate detached 051d058 worktree running the identical committed harness (sha256 checked).

### deviations

- The benchmark TypeScript lives under test/integration/data-gateway/bench/, not tools/bench/gateway/.
  - eslint's typed block covers only tools/*.mjs, and the LINT-1 pin test fails any other linted file under tools/.
  - Those config files are outside my paths.
  - tools/bench/gateway/ holds run.sh and its README.
- Added "recorded" pacing beyond the requested uniform rates, because uniform pacing does not reproduce H1: base survives uniform 1,500/s in isolation.
- The committed stall test uses a frozen TCP proxy (startFreezableRedisProxy, the repository's documented docker-pause shape) instead of a literal docker pause. No container-pause helper is reachable from my paths. A literal docker pause was run by hand on base and candidate.
- The data-gateway integration suite now contains one Docker-requiring file. .github/workflows/ci.yml, which is outside my paths, still labels that step "(no container)" and its N5 comment is now stale.
- The packet said a test for the example config existed; none did. I added two: config.test.ts and book-feed-absent.test.ts.
- MemoryEventTransport now offers publishBatch by default, so the whole in-memory gateway suite exercises the batch path. The per-envelope path is covered by a wrapper without the method.
- Seven UNIV-4 exact incident-list assertions now include the new startup incident, the intended behaviour for their lifecycle-only configuration. One was strengthened and none loosened.
- Transport metrics on the batch path:
  - producerBlockedTimeMs accrues once per batch call;
  - publishFailures counts one per failed call.
- New additive publisher metrics: submissions, inFlight, largestSubmission.

### known_risks

1. In flight: up to 256 envelopes / 1 MiB can be submitted but unsettled on top of a full admission queue. Before, it was one envelope.
2. Pre-existing, now widened: ioredis resends unfulfilled commands after a reconnect by default.
   - A batch script that ran but whose reply was lost could be re-sent and append the run twice, under new ordinals.
   - The window grows from 1 envelope to up to 256.
   - Subscriptions count this as nonMonotonicDeliveries but still deliver it. Trader deduplication is THROUGHPUT-1a's area and was not verified.
3. The benchmark measures the publish path in isolation. The live gateway shares its event loop with frame parsing, the WAL and completeEnvelope. The candidate's margin is large (HWM at most 343/1024 at 4x the burst, ceiling about 28k/s), but live headroom is only proven by the H1 re-run.
4. The mid-batch XADD failure path in Lua cannot be triggered from a test: an ACL denial fails the first XADD, and Redis refuses writes for OOM only before a script's first write. The same undoAppends routine is exercised by the counter-write failure test, and mutant M3 is caught.
5. The committed 2x sample test asserts no overflow: HWM 42-60 here, and it overflows every time without batching. A CI runner roughly 4x slower than this host could make it flaky.
6. Byte identity was proven on the fixture's five event types. Other event types use the same encodeEnvelope path but were not replayed.
7. publishBatch is detected by shape, because the interface is 1a's. It is checked at compile time only where main.ts wires the Redis transport.
8. One batch script call occupies the Redis server for up to 256 XADDs plus one XTRIM. This was not measured separately and may add read latency for the trader during bursts.

### follow_up

- Orchestrator: relabel the CI step "Integration tests 4/6 - data-gateway (no container)" and update the N5 count in .github/workflows/ci.yml; publish-throughput.test.ts starts a Testcontainers Redis.
- After THROUGHPUT-1a merges: promote publishBatch to MarketEventTransport and remove the shape detection.
- Re-run H1 through a full window to confirm live headroom. A co-located-load or raw-WAL replay benchmark of the whole gateway was not done.
- Consider autoResendUnfulfilledCommands=false on the command connection, so a lost publish reply halts instead of risking a duplicate run. It needs its own round: reconnect.test.ts asserts the resend.
- The new ceiling is per-envelope CPU in the envelope door and the admission byte count, about 17 µs per envelope. Both are semantic doors and were left untouched.
- The IMPLEMENTATION_STATUS and docs rows are the orchestrator's; docs/** is forbidden to me.
- Cleanup done:
  - my base worktree was removed;
  - every tp1b-* container was removed, including 18 idle ones leaked by an early run.sh bug, which was fixed before commit;
  - THROUGHPUT-1a's resources, the H1 containers and ~/pmb-h1 were untouched.

### commit_sha

e5fdf42
