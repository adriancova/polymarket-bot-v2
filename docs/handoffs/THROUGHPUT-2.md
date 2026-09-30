# THROUGHPUT-2 — evaluate once per venue frame (ADR-024)

**Status:** COMPLETE. Merged `7d59fd3` (`--no-ff`; `6be3eae` r0 → `3b3f752` r1, base `bf1ee89`). HARDENING LOOP `wf_7beff25f-26e`. Fable r1 CHANGES REQUIRED → r2 ACCEPT. CI: PR #27 run `36686967040`. ADR-024 is provisionally accepted, pending the user's ratification. **The targets were NOT met:** 764–808 events/s against 943, and a paced max lag of 9–38 s against 5 s.

## Reviews

### r1 on `6be3eae`: CHANGES REQUIRED
- [HIGH] TP2-R1-H1: The paced max-lag headline (9.26 s in ADR-024 Consequences and its Verification table, 11.84 s at the final tip) does not reproduce within 20%: my two candidate paced runs on a quiet host gave max lag 22.88 s and 15.84 s (base paced and every throughput/CPU-per-event figure did reproduce); the STOP verdict on the targets is unchanged, but ADR-024 and the handoff must state the measured range (about 9-23 s) or reproduce within 20% over repeated runs.
- [MEDIUM] TP2-R1-M1: CoreLoop.#applyWithinFrame (packages/trading-core/src/loop.ts) sets frame.last for EVERY door-passing event of a frame, so when a frame's last event names a market this trader is not configured for, the frame's decision is attributed to that event and its instant (probed on the real core: source_event_id = the unconfigured market's event, not the last event that touched the market), contradicting ADR-024 D3's 'last APPLIED event' and making evaluated_at and the snapshot asOf/feature_snapshot_ref differ from base's at the last applying event on multi-market streams; record frame.last only where frame.harvest is set and pin a two-market case.
- [MEDIUM] TP2-R1-M2: The group-commit hard bound changed meaning and ADR-024 D5 says it did not: postgres-store.ts stage() increments once per call and #flushOutbox now stages once per frame, so GROUP_COMMIT_MAX_EVENTS = 128 bounds frames (about 1.76 events each on H1, up to 65), and the loop.ts 'at most 2 x 128 events undurable' statement and D5's 'bounds unchanged' are inaccurate; restate the bound in frames (or count events in stage()).
- [LOW] TP2-R1-L1: ADR-024 D2's stated exceptions omit the subscription's valid-prefix truncation (packages/event-bus/src/redis/subscription.ts #deliver stops at an unusable entry), which the feed treats as a short read and hands out whole, so a prefix ending inside a frame is evaluated once half-applied before the stashed EventBusEntryError halts the trader; a corruption path, but the exception list claims completeness.
- [LOW] TP2-R1-L2: Lifecycle envelopes derived from one journaled response share a causationId (apps/data-gateway/src/feeds/market-lifecycle.ts) and are therefore grouped among themselves, which ADR-024 D1's table does not say; their callbacks still fire in place and only the harvest/flush moves, so behaviourally benign, but the ADR row should state it.
- [LOW] TP2-R1-L3: The handoff understates its own non-vacuity: with base loop.ts frame-evaluation.test.ts fails 4 of 7 (not 3) and with base redis-feed.ts the feed frame tests fail 8 of 9 (not 7); not a defect, correct the handoff.
- [LOW] TP2-R1-L4: Backtest framing is wired but no CLI-selectable normalizer produces a multi-envelope record (apps/backtest-cli/src/main.ts normalizerFor offers only the normalized-envelope and passthrough normalizers), so live-framing parity in a backtest is unreachable end to end today; ADR-024 D4 states this, recorded as a residual for the causationId-in-recordings follow-up.

Notes: Review worktree was clean at start; detached at 6be3eae; clean and at 6be3eae after (git status empty, git diff 6be3eae empty); base worktree at bf1ee89 created under the scratch dir with hardlinked node_modules and removed/pruned; containers rv2-redis/rv2-pg started and removed; polymarket-bot-trader-* and ~/pmb-h1 untouched; review-scratch directory deleted. Independent evidence reproduced: full-burst decision comparison (base 89,621 = 3,913 single + 42,955 intermediate + 42,753 last; candidate 46,666 with 0 intermediate remaining, all 46,666 equal in every exported column and all 46,666 checkpoints equal at the same source event, final state_hash equal, order preserved); in-process probe re-run on both sides (56,714 frame closes, books+trade window equal to base after the same event at every close, eventsProcessed/eventsRefused 89,622/10,047 on both); 2,000-sample golden re-derived (1,837 -> 928 + 909, both digest pairs match old and new pins); ADR-024 fixture statistics verified exactly on the full burst; candidate paced and catch-up decisions byte-identical; non-vacuity re-run for loop.ts, redis-feed.ts, publisher.ts and the backtest driver. Benchmark: candidate catch-up 774.6 events/s at 1,377 us/event vs base 508.3 at 1,984; candidate paced max lag 22.88 s and 15.84 s vs base 50.28 s; targets NOT met (STOP correct). A surviving vitest job on the host belongs to another session (/tmp/logs1-codex-r2-*), not to this review. Verdict CHANGES REQUIRED per the packet's 20% reproduction rule (H1) plus the frame.last attribution defect (M1) and the group-commit bound restatement (M2); all three are small fixes (two are ADR/doc corrections, M1 is a one-line move plus a pin).

### r2 on `3b3f752`: ACCEPT
- [LOW] TP2-R2-L1: Inside a multi-market frame, a market's evaluation runs at its own last-owing event's instant while the venue, the cancel sweep and the basket judgement are already positioned at the frame's LAST event, and ADR-024 D3 does not say so (loop.ts #processEvent 1073-1078 run before #closeFrame; venue.ts #atEvent 1221 anchors any order there). Doc-only; no code change; affects only frames touching several configured markets, none on H1 or in any golden.
- [LOW] TP2-R2-L2: Backtest framing parity remains unreachable end to end from the CLI (round 1's L4, argued not fixed): apps/backtest-cli/src/main.ts normalizerFor still offers no raw-frame normalizer, so no CLI-selectable dataset yields a multi-envelope record. Mechanism in place and pinned; ADR-024 D4 records the residual; carried to the follow-up.

Notes: Review worktree was clean before detaching (porcelain empty). Scope: 26 changed paths, all allowed; root package.json / pnpm-lock.yaml / eslint.config.mjs unchanged; no golden under test/replay-golden changed in the range; r1 commit declares no golden changes (confirmed). Earlier findings: H1 FIXED (ADR states lag as range 9.3–38.4 s, median 19.4 s — re-derived; my reproduction candidate paced 11.49 s / 10.40 s inside the range and within 20% of 9.26 s; candidate catch-up 794.8 events/s @ 1,353 µs/event vs claimed 807.9/1,292; base catch-up 557.5 @ 1,824 vs 572.6/1,784; base paced 46.66 s vs 44.5–50.3 s; digests f397f524/45da9357 equal implementer's r1 and final-tip runs; base 930cf15e/7a99b2f3 equal implementer's base). M1 FIXED (per-market last-owing event; 6be3eae loop.ts fails exactly the 2 r1 pins, candidate 9/9). M2 FIXED by restating the unit as frames in ADR D5, loop.ts header, ports.ts, postgres-store.ts, with a stall pin (passes on 6be3eae by nature, as the handoff states). L1 FIXED (D2 exception; ReceiveResult has no truncation flag, confirmed). L2 FIXED (D1 lifecycle row). L3 FIXED (reproduced: base loop.ts → frame-evaluation 6 failed/3 passed; base redis-feed.ts → redis-feed-frames 8 failed/1 passed). L4 argued residual (TP2-R2-L2). STOP on targets stands (794.8 < 943 events/s; 10.4 s > 5 s) and is honestly reported; packet accepts a STOP with measurements. ADR-024 is Proposed and still needs the user's ratification before merge; ADR README index row is the orchestrator's (forbidden path). No .skip/.only/eslint-disable/ts-ignore added; strategy decision logic untouched; safety defaults untouched. Cleanup: rv3-redis/rv3-pg removed, base and cand scratch worktrees removed and pruned, review-scratch deleted, review worktree clean at the candidate, no processes of mine running; orchestrator containers and ~/pmb-h1/ untouched.

## Implementer handoff r0 (structured return, verbatim)

### summary

STOP at the throughput targets; everything else is delivered. Branch throughput-2 is 11 commits on bf1ee89, tip 6be3eae, not pushed.

The trader now evaluates ONCE PER VENUE FRAME (ADR-024, Proposed; the user ratifies before merge). No envelope, schema-version, DB or decision-contract change.

- **Frame definition.** A frame is a run of consecutive events sharing a frame key: the causationId, else the (gatewayEpoch, ingestSeq) dispatch identity. It is defined once, in packages/trading-core/src/frames.ts.
- **Core loop** (packages/trading-core/src/loop.ts, `drain`, `#applyWithinFrame`, `#closeFrame`).
  - Every event is still door-read, applied, venue-positioned and counted as before.
  - For a multi-event frame, the onFeatures evaluations, the fill harvest and the outbox flush run once, at the frame's last event. Each market the frame touched is evaluated once, in first-touch order, with the last applied event as source_event_id and instant.
  - Single-event frames take the unchanged path. Lifecycle callbacks still fire in place. A frame never outlives a drain.
- **Frame completeness without waiting** (ADR-024 D2).
  - The gateway publisher yields one microtask before cutting its first run on a frame-named envelope, and never cuts a run inside a causationId (bounded by the Redis script's 1,024-envelope limit). A frame is therefore one atomic script call.
  - The trader's RedisMarketEventFeed hands out a short read whole, because it reached the stream end. It carries the trailing frame of a full read into the next poll.
  - Positions follow delivery only, so a crash re-reads a partial frame whole.
- **Backtest parity.** `recordFraming()` makes the backtest driver drain once per recorded record; the run assembly wires it.
- **Extras.** (b) The static-bracket params parse is cached per deep-frozen plain-data params object. (a) The incremental EWMA was not done: no provably exact form exists (see deviations).

**Correctness evidence** (full H1 burst, base bf1ee89 vs candidate, one registered clone):
- Decisions fall from 89,621 to 46,666. All 42,955 decisions base made on a half-applied state are gone: 42,627 two-token price_change frames, plus 328 reference trades inside multi-trade frames.
- Each of the 46,666 remaining decisions equals base's decision at the same source event in every exported column (feature_snapshot_ref, state_patch and evaluated_at included). Every checkpoint equals base's, and the final state is equal. There is no remaining difference to characterize.
- In-process proof: at all 56,714 frame closes, BOTH books and the trade window equal base's state after the same event.
- The candidate code, fed one event per drain, reproduces base's 89,621 decisions byte for byte.

**Throughput.** Session 1 (base bf1ee89, candidate ead59be):

| Run | Base | Candidate |
|---|---|---|
| Catch-up events/s | 572.6 | 807.9 |
| CPU µs per event | 1,784 | 1,292 |
| Paced max lag | 44.5 s | 9.26 s |
| Paced p99 lag | 44.0 s | 8.83 s |

At the final tip (510ba20), with base re-run beside it on a host about 5% slower: 545.6 vs 764.4 events/s, and paced max lag 48.6 s vs 11.8 s. No halt anywhere, and framesSplit is 0 in every run.

The targets (943 events/s, ≤ 5 s) are NOT met. The removed evaluations were the cheap, memo-hitting half of each pair, so the gain is about 1.4×, not the 2.1× that 1a modelled.

Full handoff: /tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/throughput-2/handoff-r0.md. It includes the measurements and golden_changes sections.

### files_changed

[
 "docs/adr/ADR-024-evaluate-once-per-venue-frame.md",
 "packages/trading-core/src/frames.ts",
 "packages/trading-core/src/loop.ts",
 "packages/trading-core/src/index.ts",
 "apps/trader/src/adapters/redis-feed.ts",
 "apps/trader/src/adapters/redis-feed-frames.test.ts",
 "apps/trader/src/index.ts",
 "apps/data-gateway/src/publisher.ts",
 "apps/data-gateway/src/publisher.test.ts",
 "apps/backtest-cli/src/core-loop.ts",
 "apps/backtest-cli/src/core-loop.test.ts",
 "apps/backtest-cli/src/assembly.ts",
 "apps/backtest-cli/src/index.ts",
 "packages/strategies/static-bracket/src/params.ts",
 "test/integration/paper-trader/frame-evaluation.test.ts",
 "test/integration/paper-trader/group-commit-crash-recovery-postgres-redis.test.ts",
 "test/integration/paper-trader/throughput-bench-harness-postgres-redis.test.ts",
 "test/integration/paper-trader/support/throughput/publisher.ts",
 "test/integration/paper-trader/support/throughput/harness.ts",
 "test/integration/paper-trader/support/throughput/bench-main.ts",
 "test/integration/data-gateway/publish-throughput.test.ts",
 "test/unit/strategies/static-bracket/params-cache.test.ts",
 "tools/bench/trader-throughput/README.md"
]

### tests_run

Every pnpm command was run with pnpm_config_verify_deps_before_run=false. Suites ran serially.

**Final gate run at 510ba20** (worktree clean before and after; the tip 6be3eae adds only an ADR paragraph). All exit 0:

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint | exit 0 |
| check:deps | exit 0 |
| test | 368 files / 7,809 tests |
| test:e2e | 8 / 206 |
| test:replay | 3 / 17 (no golden written) |
| trader test:integration | 25 / 181 |
| control-api test:integration | 10 / 87 |
| event-bus test:integration | 10 / 112 |
| data-gateway test:integration | 14 / 104 |

**Earlier failures during the round, each fixed and then re-run green:**
- The unit test run failed the GOV-2B cast scan: I had a type assertion in redis-feed.ts. Fixed in 5732169.
- The trader crash test's reference run had a `> 1,000` decisions bound; it now decides once per frame (928).
- Two data-gateway tests pinned THROUGHPUT-1b run shapes (the stall bound 301 is now 302, the run size 7 is now 8). Explained in golden_changes and fixed in 510ba20.
- One intermediate trader integration run overlapped a roughly 10 s window in which I had swapped redis-feed.ts for a mutation check. The final gate run repeats that suite cleanly.

**Non-vacuity checks** (each reverted; worktree verified clean):
- Base loop.ts: the 3 frame cases in frame-evaluation.test.ts fail.
- Base publisher.ts: 4 frame-atomic tests fail.
- Base redis-feed.ts: 7 of 9 feed tests fail.
- The params-cache identity test cannot pass without the cache.

**Benchmarks** (tools/bench/trader-throughput, full H1 burst, containers tp2-* only, one run at a time):
- Base vs candidate, catch-up and paced, in two sessions.
- One profiled candidate catch-up.
- The 2,000-event sample on base and candidate.

**Other evidence:**
- An in-process probe of the book state at each frame close, for base (per-event drains) and for the candidate (per-frame drains and per-event drains).
- Decision and checkpoint comparison scripts (compare.py, compare_ckpt.py) in the scratch directory.

### assumptions

- **What a venue frame is.** A venue frame is one raw frame the gateway recorded (one WS message), identified by the gateway's causationId `raw:<epoch>:<rawIngestSeq>`. Nothing more is assumed about the venue: verified-2026-08-24/09-16 §3 document only that price_change batches price_changes[] entries with per-entry asset_id, and that a message may be an array.
- **One synchronous turn per raw frame.** A raw frame's events are dispatched in one synchronous turn. Traced in code: polymarket-public `#onMessage`, then the driver's `onEvent`, then the dispatcher, then `publisher.enqueue`.
- **Atomic batch publication.** The Redis publishBatch script is atomic, as its documented contract says. The short-read rule relies on that.
- **Frame evaluation identity.** A frame's evaluation uses its last APPLIED event's id and instant.
- **Benchmark noise.** The host is shared, with about ±20% noise; CPU µs per event is the steadier metric. Lag in catch-up mode is backlog drain time, not a target.
- **Registered clone.** Base and candidate share one registered clone, so feature_snapshot_ref values are comparable.

### deviations

1. **Targets not met (STOP, as the packet instructs).** Catch-up reached 807.9 events/s against 943 (764.4 at the final tip in a slower session). Paced max lag was 9.26 s against 5 s (11.8 s at the tip). No halt.

2. **Extra (a), the incremental EWMA, was not implemented, because no exact version exists.**
   - The fold v_k = Q(λ·v_{k−1} + (1−λ)·s_k) restarts at each window's first pair, and every step is quantized. Once the 60 s / 512-point window slides, no bit-exact incremental update exists.
   - Continuing the fold when points are only appended is exact, but on the burst that happens only while the window fills from the bench's cold start: binance has 512 append-only updates then 2,587 evicting ones; coinbase 621 then 161. A warm live run slides on nearly every trade, so this would only flatter the benchmark.
   - Detecting when two folds coalesce is exact too, but at λ = 0.94 it needs hundreds of steps.

3. **Small export additions.**
   - apps/trader/src/index.ts and the trading-core index export frameKeyOf and sameFrame.
   - RedisMarketEventFeed gains two read-only getters, framesSplit and carried.
   - framesSplit is reported on the adapter and in the bench report, not on the health surface. Putting it there would be a control-API door change.

4. **Retired digest pins.** The bench-harness test's old base digest constants became a doc comment, because the compiler would flag them as unused.

5. **ADR index not updated.** The ADR index row (docs/adr/README.md) was not added, because docs/** other than the ADR is forbidden to this package.

### known_risks

1. **Size limits.** Frames larger than 1,024 envelopes split at the gateway. Frames of 128 events or more (the receiveBatchSize) split at the trader feed, which counts them in framesSplit. The largest H1 frame was 65 events.
2. **Refusal inside a gateway run.** If the transport refuses an envelope in the middle of a run, the run's prefix is published, which could end mid-frame, and publication halts. This is the documented transport behaviour. It is unreachable through the dispatcher, because the gateway validates every envelope against its contract at dispatch.
3. **Snapshot recovery is still per event.** REST snapshot recovery publishes the two tokens' snapshots with no shared key, so after a resync they are still evaluated separately, as before.
4. **Normalized-stream recordings carry no causationId.** They therefore evaluate per event, exactly as the live loop would for the same envelopes. A normalized recording of live data loses its framing until the format records causationId.
5. **The gateway pump starts later.** For frame-named envelopes it now starts one microtask later.
6. **The lag test publishes per envelope.** transport-lag-postgres-redis.test.ts still publishes one envelope per call, so frames can split at its stream head. That test does not assert on framing.
7. **An H1 re-run would still lag.** At the H1 window-open rate the trader would still lag by roughly 9 to 12 s: seconds, not minutes.
8. **Final-session contention.** In the final benchmark session, another project's vitest jobs were running on the host. The absolute numbers are about 5% lower in that session; the ratio is the same.

### follow_up

Ranked options to reach the targets. None is implemented, and all are outside this package's paths. Each figure is an upper bound on the share of candidate CPU the option addresses.

1. **packages/features, performance-only.** Stop re-validating and re-reading the prepared inputs on every evaluation:
   - validateFeatureInput is 16.4%: readBookSerializationMemo 6.9%, preparedReferenceReuse 4.0%, validateReference 3.8%;
   - buildInputsSection is 4.6%.
   Memoize by prepared-object identity, as 1a did for the reference section, with the bytes pinned. Likely 10–15%, about 900–950 events/s.
2. **packages/strategy-runtime, performance-only.** View acquisition (prepareEvaluationView, materializeWith, appendOwn) is about 7–9%. Estimated gain 5–8%.
3. **packages/decimal guard overhead.** withNeutralIndexNames plus indexNamesOwnedBy (4.5% self). The package is protected. Estimated 5–10%.
4. **packages/order-book per-side revision accessor.** It would let the MarketState side views skip levels() and key building for unchanged sides. Estimated 2–4%.
5. **Semantic options (need a ruling or ADR):**
   - compute only the features the strategy consumes (reference features are 16.8%; this changes feature_snapshot_ref);
   - adopt an EWMA definition that is incremental by construction (a feature-version bump).

Options 1 and 2 together plausibly reach at least 943 events/s, which is about the capacity 1a's model says a paced max lag of 5 s or less needs.

Also:
- The user ratifies ADR-024 before merge.
- The orchestrator adds the ADR index row and updates IMPLEMENTATION_STATUS.
- THROUGHPUT-1c follows, then the H1 re-run.
- If replaying live framing from backtest recordings is wanted, the normalized recording format should record causationId.

Evidence is in /tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/throughput-2/:
- bench-chain-{r1,r2,r2prof,sample,final}.txt;
- bench-*/ reports, decisions.jsonl, checkpoints.jsonl and the profile;
- compare.py and compare_ckpt.py;
- probe-*.txt;
- gates-final.txt.

The tp2-* containers and the base worktree were removed. The orchestrator's containers and ~/pmb-h1 were not touched.

### commit_sha

6be3eae

## Implementer handoff r1 (structured return, verbatim)

### summary

THROUGHPUT-2 r1 (one commit, 3b3f752, on top of 6be3eae): every HIGH and MEDIUM finding is fixed, L1, L2 and L3 are fixed, and L4 is argued. The STOP on the targets stands: they are not met.

Finding map:

| Finding | Disposition | Pin or evidence |
|---|---|---|
| TP2-R1-H1 | FIXED | ADR-024 Consequences and Verification give the paced max lag as a measured range, with a per-run table (host load included where recorded). |
| TP2-R1-M1 | FIXED | Two new cases in frame-evaluation.test.ts. Both fail against 6be3eae's loop.ts (2 failed / 7 passed) and pass at 3b3f752. |
| TP2-R1-M2 | FIXED (documentation of the unit) | New group-commit-loop.test.ts pin "the bounds count STAGINGS". It passes on 6be3eae by nature, because the finding is a documentation inaccuracy (see deviations). |
| TP2-R1-L1 | FIXED | ADR-024 D2 exception list. |
| TP2-R1-L2 | FIXED | ADR-024 D1 table row. |
| TP2-R1-L3 | FIXED | Counts re-measured: 4 of the original 7 frame-evaluation cases fail on base loop.ts (6 of the 9 now); 8 of 9 feed tests fail on base redis-feed.ts. |
| TP2-R1-L4 | ARGUED | Residual; see deviations. |

M1 (packages/trading-core/src/loop.ts):
- For each market a frame owes an evaluation, the loop records the last frame event that owed that market one. A market owed again moves to the end of the order. The loop also records a separate harvest instant: the last event that reached the harvest point.
- At the frame's close, each market is evaluated with its own event as `source_event_id` and that event's instant as `evaluatedAt`, in the order of those events.
- Result: a frame's decisions are a subsequence of the per-event cadence's decisions, with the same source events, instants and order.
- The two-market pin also compares each decision with the per-event run at the same source event: instance, callback, type, reason codes and featureSnapshotRef all match.
- This goes one step past the verifier's minimal suggestion (see deviations). The verifier's remark about a reference trade with an unknown venue is not a defect: a lone such trade already evaluates every market in base. ADR D3 now says so.
- H1 content is unchanged: the r1 benchmark's normalized digests (f397f524… decisions, 45da9357… checkpoints) equal 6be3eae's.

M2: the group-commit bounds keep their numbers (32 / 50 ms / 128) but count stagings, and the loop stages once per frame. So at most 128 frames are staged and 256 frames undurable. This is now stated in the loop.ts header, the ports.ts GroupCommit.stagedEvents doc, the postgres-store.ts comments and ADR D5. The pin shows a stalled database holding 128 staged frames (256 events), each staging holding one decision.

H1: this round ran 5 candidate paced runs and 1 catch-up. Across 10 candidate paced runs in 4 sessions, the paced max lag ranges from 9.3 to 38.4 s (median 19.4 s). Base's three paced runs gave 44.5–50.3 s. Catch-up across sessions was 764–824 events/s, and 824.4 events/s at 1,300 µs/event this round. No run meets the targets (catch-up ≥ 943 events/s; paced max lag ≤ 5 s).

L1: ADR D2 now names the subscription's valid-prefix truncation. L2: the D1 lifecycle row now says that one journaled response's envelopes form one frame. L3: the corrected counts are in the handoff.

Handoff: /tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/throughput-2/handoff-r1.md

### files_changed

[
 "/home/adriancova/proyects/tradeBot/polymarket-bot-throughput-2/packages/trading-core/src/loop.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-throughput-2/packages/trading-core/src/ports.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-throughput-2/apps/trader/src/adapters/postgres-store.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-throughput-2/docs/adr/ADR-024-evaluate-once-per-venue-frame.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-throughput-2/test/integration/paper-trader/frame-evaluation.test.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-throughput-2/test/integration/paper-trader/group-commit-loop.test.ts"
]

### tests_run

Every pnpm command used pnpm_config_verify_deps_before_run=false, and the gates ran serially on the r1 tree, whose content is identical to 3b3f752 (gates-r1fix.txt). All exited 0:

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint | exit 0 |
| check:deps | exit 0 |
| test | 368 files / 7,809 tests |
| test:e2e | 8 / 206 |
| test:replay | 3 / 17 |
| trader test:integration | 25 / 184 (181 plus the 3 new pins) |
| control-api test:integration | 10 / 87 |
| event-bus test:integration | 10 / 112 |
| data-gateway test:integration | 14 / 104 |

Pin verification. Each swapped file was restored byte-identically (checked with cmp and git status):
- 6be3eae loop.ts with frame-evaluation.test.ts: 2 failed (the two r1 cases) / 7 passed.
- 6be3eae loop.ts with group-commit-loop.test.ts: 9 passed. The M2 pin passes on 6be3eae because the fix is documentation.
- bf1ee89 loop.ts with frame-evaluation.test.ts: 6 failed / 3 passed.
- bf1ee89 redis-feed.ts with redis-feed-frames.test.ts: 8 failed / 1 passed.

Benchmark (bench-chain-r1fix.txt). Own containers tp2-redis and tp2-pg on a fresh registration, one run at a time, full burst of 99,669 envelopes:

| Run | Events/s | Max lag | Host load at start |
|---|---|---|---|
| paced1 | 709.0 | 9.62 s | 1.29 |
| catch-up | 824.4 (1,300 µs/event) | n/a | 1.85 |
| paced2 | 652.0 | 24.84 s | 3.26 |
| paced3 | 610.1 | 37.09 s | 9.67 |
| paced4 | 577.1 | 38.37 s | 17.86 |
| paced5 | 652.7 | 27.96 s | 13.52 |

Every run: 46,666 decisions, no halts, framesSplit 0, and normalized digests equal to 6be3eae's. The containers were removed afterwards.

### assumptions

- A venue frame is one gateway raw frame, identified by its causationId. This is unchanged from r0, and nothing more is assumed about the venue.
- For a coalesced evaluation, the right source event is the event whose own evaluation of that market the per-event cadence ran last. For single-market frames, which is all of H1, that is the frame's last event.
- The spread in paced lag comes from host contention plus a threshold effect: capacity is just under the arrival rate at the window open. Host load was not recorded in sessions 1–3, and no run had a provably idle host.

### deviations

1. Targets NOT met (STOP): catch-up stays below 943 events/s and paced max lag above 5 s in every run. This is unchanged from r0.
2. M2 was fixed by restating the unit rather than by counting events in stage(). Counting events would commit about 1.76 times more often and buy no durability, because what stays undurable is decisions, and those are per frame. For the same reason, the M2 pin cannot fail on 6be3eae: the finding is a documentation inaccuracy.
3. M1 goes beyond the verifier's minimal fix (record frame.last only where frame.harvest is set). The minimal fix would still name a later event for another configured market, or an event that triggered no callback, as a decision's source. The new rule is a per-market source event, with markets evaluated in the order of their last owing events. Within a multi-market frame the decision order therefore now follows the per-event cadence rather than r0's first-touch order. Nothing measured changes, because H1 and every golden are single-market.
4. L1 is fixed in the ADR only. Letting the feed hold back a truncated prefix would need a "truncated" signal in the shared EventSubscription contract (packages/event-bus). The case is a corruption path that halts on the next receive, and a contract change for it is outside this remediation's scope.
5. L4 is argued, not fixed. Making a raw-frame normalizer selectable in apps/backtest-cli/src/main.ts would add a new backtest input format, which is a feature, not frame parity. The parity mechanism itself is in place and pinned (recordFraming, core-loop.test.ts, and the replayed-raw-record case), and ADR-024 D4 already records the residual.
6. The ADR-024 row in the ADR README index is still not added, because docs/** other than the ADR is a forbidden path.

### known_risks

1. r0's known risks 1–7 still apply. Risk 7, restated: an H1 re-run on this code would lag by roughly 10–40 s at the window open, depending on host load.
2. The decision order inside a multi-market frame now follows each market's last owing event. The verified venue docs do not say whether a single price_change message can span markets.
3. Paced max lag cannot be reproduced within 20% on this shared host. Future comparisons should use CPU µs/event, or several runs with host load recorded.

### follow_up

- Reaching the targets: the ranked options in r0 are unchanged (features validation memo, strategy-runtime view acquisition, the decimal guard, order-book side revisions, semantic feature pruning).
- Before merge, the user ratifies ADR-024, and the orchestrator adds its row to the ADR README index. Then THROUGHPUT-1c, then the H1 re-run.
- L4: expose a raw-frame normalizer in the backtest CLI, or record causationId in normalized recordings.
- L1: optionally, add a "truncated" signal to EventSubscription so the feed can hold back a prefix that ends inside a frame.
- Expose framesSplit on the health surface (a control-API door change).

### commit_sha

3b3f7520b30109a026df0703a171952173fd3bff
