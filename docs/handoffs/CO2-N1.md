# CO2-N1: ADR-031 option (a) — the entry guard on the process clock

**Status:** Complete (2026-10-03). Merged `9869e53` (PR #50; CI run `37111523978` green on attempt 2). It closes the residual `CO2-N1`.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 1 on `bfaead6`.
**Base:** `f5a5967`. **Contract:** ADR-031, Accepted on 2026-10-02 when the user ruled option (a), through existing inputs, entries only. Its section 5 rules are R1–R7, and its section 7 tests are T1–T11.
**Posture:** PAPER only.

## summary

- **R1.** `CoreLoop.#routeIntent` reads `clock.now()` once for each routed placement. The read comes after `#persistDecisionsBeforePlacement` resolves, and before the allocator and the risk input are built. A CANCEL reads nothing.
- **R2/R3.** `featuresAgeMs = max(0, processNow − eventNow)`, in whole milliseconds. Check 7 refuses a late ENTRY with `RISK_FEATURES_STALE`.
- **R4.** `secondsToClose` counts from `max(eventNow, processNow)`. Check 20 refuses an entry the process reaches inside the cutoff.
- **R5.** An unreadable reading leaves the FEATURES observation out, so the entry is refused `RISK_FRESHNESS_UNKNOWN`.
- **R6/R7.** Nothing else changes, and no switch turns the guard off. `packages/risk`, `packages/domain`, `db/migrations` and `test/replay-golden` are untouched. The two comments that ADR-031 §6.1 names are rewritten.
- **The closeout probe (T1).** At base it still gave 2 approvals and 1 fill. It now gives 0 approvals and 1 refusal, counted under both `RISK_FEATURES_STALE` and `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED`.
- **Migrations.** Ten tests fed months-old fixtures through the host clock. Nine were migrated to a host clock re-based to the scenario's first event (`support/host-clock.ts`). Two of them re-base `SystemPaperClock.prototype.now`, because `startup()` takes no clock parameter. None was deleted.

## tests_run

- **Gates on `bfaead6`:**
  - typecheck, lint and check:deps exit 0;
  - unit: 439 files / 9871 tests;
  - e2e: 9/212;
  - replay: 3/17;
  - integration: trader 37/276, event-bus 10/112.
  - `git diff --quiet f5a5967 -- test/replay-golden` holds.
- **Against base:** 20 of 22 unit tests and 6 of 13 integration tests fail. The ones that pass there are the lag-0, approval and control cases.
- **Mutation:** 14 mutants, the 9 of ADR-031 §7 plus 5 more. All are killed, each by the test the ADR names.
- **T6:** with the clock positioned at each event, three fixture scenarios serialize byte-identically at base and candidate.
- **The bench:** decision digests are unchanged. Its templates never trigger an entry, so the new read never happens there.
- **CI:** the first run on the PR #50 merge ref hit the known `CI-FLAKE-STALL-BOUND` (303 > 302) in an untouched data-gateway test. The rerun of the failed job was green (see the merge commit).

## assumptions
- `eventNow` is `input.epochMs`, the instant the decision names. Inside a venue frame, that is the last owing event's instant (ADR-024).

## deviations
- None from ADR-031's rules.
- One correction to the packet: the bench does not position its clock in catch-up mode. It hands the trader an unpositioned `SystemPaperClock`.

## known_risks
- **Entries are refused during backlogs, as ruled (ADR-031 §8).** With `featuresMaxAgeMs` at 2000 ms, a PAPER trader refuses every entry while it lags by more than 2 s. H1 runs 3–8 peaked at 23–153 s. Fixing the lag itself is throughput work (`CO2-N7`) and `CADENCE-1`.
- **Close refusals are not attributable (Q1, as ruled).**
- **`ADR023-CLOCK-STEP` stays open.**
- **CO2N1-R1-J1 (LOW).** The `TransportHealth` header in `health.ts` still says the core reads no wall clock.
- **CO2N1-R1-J2 (LOW).** `durable-halts-and-refusals-postgres-redis.test.ts` now has its entries refused by the guard, but it was not migrated. It still passes.
- **CO2N1-R1-J3 (LOW).** `host-clock.ts` claims its lag is the trader's real processing delay. With a fixed offset it is `max(0, elapsedWall − elapsedEvent)`.
- **CO2N1-R1-J4 (LOW).** A mutant that measures lag from `#lastEpochMs` instead of `input.epochMs` survives T1–T11. It is not equivalent: under ADR-024, live frames can carry differing receipt instants.
- **INFO.** A `Clock.now()` that throws escapes `drain()` at admission. It fails closed: the decision is durable and nothing is placed.

## follow_up
1. **A later trading-core round** closes J1–J4. J4 needs a pin that evaluates a frame whose events carry differing instants.
2. **A clock parameter on `startup()`,** so tests inject a clock instead of spying on the prototype.
3. **A replay-positioned bench mode,** so the bench can measure admission.
4. **Q2, exits under lag:** the §9.9 Incident Controller round, before any mode above PAPER.
5. **`CO2-N3`:** the first lag refusal will not show on the per-code veto panel until it is fixed.

## commit_sha
`bfaead6ccb45bae81972968b6d956dce3b54da3f`
