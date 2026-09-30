# DURABLE-1 — a decision is durable before its order and ledger effects

**Status:** Complete (2026-09-30). Merged (see the brief's row), PR #29, CI run `36735138667` (attempt 2; attempt 1 failed only on the flaky `publish-throughput` stall bound, `CI-FLAKE-STALL-BOUND`).
**Closes:** `CLOSEOUT-2` blocker `X1` (astra's E-01).
**Reviewers:** Opus and Codex gpt-6-astra, reconciled. r1 joint CHANGES REQUIRED (1 MEDIUM, A01) → r2 joint ACCEPT (`d6a6e76`).
**Loop:** `wf_81215710-b47`.

## User rulings owed (both LOW; both verifiers recommend "yes")
- **LOW-1:** a CANCEL is exempt from waiting for its own decision's durability (it places and books nothing).
- **A01 follow-on:** within one decision, cancels are routed before placements (`cancelsFirst`).

## Reviews

### r1 on `69a19dc`: CHANGES REQUIRED
- [MEDIUM] A01 CANCEL-AFTER-PLACEMENT (astra DURABLE1-ASTRA-R1-01): loop.ts CoreLoop.#consumeOutcome routes a decision's intents one at a time (:1777-1787), and #routeIntent awaits #persistDecisionsBeforePlacement() (:1881) before every non-CANCEL intent. So in an intent list [placement, CANCEL], the CANCEL waits on the current decision's store write, indefinitely if the store hangs. On base the CANCEL was submitted at once. Astra's held-promise probe reproduces this in both store modes. It breaches packet requirement 2 and acceptance 4. The severity is MEDIUM rather than HIGH because it is latent: every cancelIntent site in Static Bracket (decide.ts :549, :1415, :1988, :2523, :2613, :3232) builds a list that contains only cancels. Fix: keep placements behind durability, let cancels already emitted go through without waiting on the barrier, and add held-store tests for both intent orderings in both modes.
- [LOW] LOW-1 CANCEL-EXEMPT: A CANCEL is exempt from its own decision's barrier (loop.ts:1867-1880), which departs from the literal persist-before-submit order in handoff §8.1. It is disclosed and needs a recorded user ruling; both verifiers support keeping it. The 'store that hangs' rationale overstates the protection, because in group mode the CANCEL still awaits #commitStaged() (:1880).
- [LOW] LOW-2 PG-EXEC-VACUOUS: The PG variant's assertion that execution.* tables are empty (durable-decision-before-placement-postgres.test.ts:216) is vacuous, because the trader never writes execution.* (postgres-store.ts:409-418). The handoff's evidence claim should be corrected.
- [LOW] LOW-3 GROUP-SPLIT: In group mode a decision (loop.ts:3559/:3574) and its checkpoint (:3605-3607) can commit in separate transactions, so the handoff's 'as before' is imprecise. It is harmless today because nothing in production calls restoreFrom.
- [LOW] LOW-4 REFUSAL-OBSERVABILITY: A refusal at the boundary returns at loop.ts:1887, before risk and countRiskRefusal (:1946-1959), so the refused-protective-exit counters miss store-failure refusals. The GLOBAL halt still records the failure.
- [LOW] LOW-5 STAGE-FAILURE-MARK: This is pre-existing and now pinned: loop-refused-plan.test.ts:1900 asserts durabilityMark() is true after a staging failure. Opus accepted astra's correction on impact: the pump checks halts.anyHalt before it commits a position (pump.ts:189, :244), so it does not advance past the failed event.
- [LOW] LOW-6 BENCH-COVERAGE: The fixture has 1 intent-bearing decision out of 46,666, so the cost of placement-heavy bursts is unmeasured (disclosed). The added write happens once per intent-bearing decision, not once per placement.
- [INFORMATIONAL] LAG: Paced p99 lag was worse in both independent pairs (Opus 9.88 to 12.28 s, astra 8.974 to 13.382 s), each n=1 on a shared host, so the cause is unproven. Opus withdraws its categorical 'host noise' claim. The handoff's 'no measurable lag cost' should be qualified as UNVERIFIED.

### r2 on `d6a6e76`: ACCEPT
- [HIGH] E-01/X1: FIXED on d6a6e76. The closeout probe now produces only the store refusal: zero submissions, fills or ledger writes, and a STORE_UNAVAILABLE halt. The base mutant and the boundary-after-submit mutant are both caught by the tests.
- [MEDIUM] A01: FIXED. `cancelsFirst` (loop.ts:1786, :4106) routes a decision's cancels before its placements. Reverting it makes 2 unit tests fail.
- [LOW] LOW-2: FIXED. The PostgreSQL test's empty execution tables are now a stated premise of the control case, not evidence.
- [LOW] LOW-4: FIXED. Boundary refusals are now counted at the risk seam (RISK_RUN_STATE_BLOCKS).
- [LOW] LOW-5: FIXED. After a staging or per-row failure, `#durabilityLost` makes durabilityMark() return false.
- [LOW] LOW-1 (+R2-LOW-8 merged): Open, needs a user ruling. A CANCEL bypasses its own decision's durability barrier. For mixed lists, `cancelsFirst` routes every cancel before any placement, so a scoped cancel no longer reaches the same decision's new order. approvedIntentId minting (loop.ts:1909) follows the routed order, while the persisted record (loop.ts:1817) keeps the emitted order. The order change is disclosed at handoff-r1:182/190/197; the ID-minting consequence is extra detail. No shipped strategy emits a mixed list.
- [LOW] R2-LOW-7: Open, latent, found by code inspection. Decisions in one processing pass are evaluated serially (loop.ts:1523/1542, :1281-1289). A CANCEL from a later decision waits for an earlier decision's placement-boundary write (loop.ts:1898 -> :3613/:3617), or indefinitely if that write hangs. The per-row wait is new relative to base. Halt gates at :1524/:3367 can suppress the later evaluation after a write failure. The handoff should disclose this beside LOW-1.
- [LOW] LOW-3: Open, documented. In group mode a decision and its checkpoint can commit in separate transactions. restoreFrom has no production caller.
- [LOW] LOW-6: Open. The benchmark fixture has one intent-bearing decision, so the cost of placement-heavy bursts is unmeasured (follow_up).
- [INFORMATIONAL] LAG: UNVERIFIED. Opus's paced pairs showed a worse candidate p99 under host contention; astra's showed +37 ms. No code mechanism explains it, and shared-host numbers do not prove it absent.
- [INFORMATIONAL] R2-N1: Handoff nits. handoff-r1:97 says six `#durabilityLost` set sites; there are five (loop.ts:3509, :3524, :3599, :3619, :3650). handoff-r0:20 says a refused intent is 'refused on the spot', which is stale: since r1 it continues to the risk seam and consumes an ID (loop.ts:1907-1909).

## Implementer handoff r0 (verbatim)

### summary

DURABLE-1 r0 fixes closeout blocker X1 (E-01) in the one core loop, `packages/trading-core/src/loop.ts`, so live, replay and backtest are all covered. It is committed as 69a19dc on branch `durable-1` (not pushed).

**The ordering now implemented.** Every non-CANCEL intent of an OWNER instance passes a new check in `CoreLoop.#routeIntent`, called `#persistDecisionsBeforePlacement()`. This covers entries, exits, protective reduces and baskets, whether they come from onFeatures, a frame close, onFill or onOrderUpdate. The check runs before an id is minted, before the allocator is asked, and before risk, planning, reservation or submit:
- **Group commit:** every decision in the outbox, including the one just appended, is staged and the loop waits for the commit.
- **Per-row:** each decision is written in evaluation order.
- **On failure:**
  - a GLOBAL STORE_UNAVAILABLE halt is latched;
  - the intent is refused on the spot, so there is no allocation, reservation or submission, and therefore no fill and no ledger write;
  - every later placement of the same decision is refused the same way;
  - the rest of the outbox is dropped, as a failed flush drops it.
- **Checkpoints** are not drained at this point. The normal flush writes them with their unchanged `capturedAt`, so the fix changes when a decision row is written, never what is written.

**CANCEL and protective reduce.**
- A CANCEL keeps its base path and does not wait for its own record. It places and books nothing, and the risk seam never blocks it.
- The protective reduce (BRACKET-1a) is a new placement, so its decision is made durable first. On base, a global halt already refused every placement including protective exits, so the fail-closed behaviour is unchanged.

**Evidence.**
- The E probe, re-pointed at this worktree, now records `[decision_refused]` only, with fills=0, transactions=0 and halt=STORE_UNAVAILABLE, in both arms.
- On real PostgreSQL, a test-only trigger refuses the first decision that carries an intent. Zero `accounting.*` or `execution.*` rows exist afterwards, in both arms.
- On the full H1 burst, decisions and checkpoints are byte-identical to base, and throughput and lag show no measurable change.

The handoff explains the ordering in full.

### files_changed

[
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/packages/trading-core/src/loop.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/packages/trading-core/src/loop-refused-plan.test.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/test/e2e/support/harness.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/test/e2e/durable-decision-protective-reduce.test.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/test/integration/paper-trader/durable-decision-before-placement.test.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/test/integration/paper-trader/durable-decision-before-placement-postgres.test.ts"
]

### tests_run

**Gates** (run serially on the final tree 69a19dc; every one exit 0):
- typecheck: exit 0
- lint: exit 0
- check:deps: exit 0 (PASS)
- test: 368 files / 7812 tests passed
- test:e2e: 9 files / 212 tests passed
- test:replay: 3 files / 17 tests passed (the backtest golden is byte-identical)
- trader test:integration: 27 files / 194 tests passed (Docker 29.1.2)
- control-api test:integration: 10 files / 87 tests passed
- event-bus test:integration: 10 files / 112 tests passed

**Failures on base** (loop.ts at 8fde4df, same tests):
- in-memory regression, both arms: 6/6 fail
- PostgreSQL variant: 4/4 fail
- e2e protective-reduce file: 4/6 fail. The 2 that pass are the CANCEL-refusal cases, which pin behaviour that is deliberately unchanged.
- new unit cases: 3/3 fail

**Mutation sweep:** six mutants, all killed; the unmutated candidate then passes 21/21.
- M1 removes the new check before placements.
- M2 removes the per-decision refusal of later placements.
- M3 and M4 remove the outbox drop on a staging failure and on a row failure.
- M5 makes CANCEL wait for its own record too.
- M6 moves the check to after the submit (the reviewer's planned mutant).

**E probe re-run on the candidate:** its X1 assertions (fills > 0) now fail. The timeline shows no effect before the decision is durable.

**Bench:** twelve runs in total, base against candidate, catch-up and paced. Eight quiet runs in alternating order are reported; four first-pass runs are discarded because they overlapped my mutation sweep.

Logs are under scratchpad/durable-1/logs, and the bench output under scratchpad/durable-1/bench.

### assumptions

- **"New placement"** means every intent whose type is not CANCEL (POSITION, REDUCE_POSITION, BASKET), protective exits included.
- **A CANCEL does not wait for its own decision's record.** It places nothing and books nothing, so no fill can depend on that record. It must not be delayed behind a store round trip, or behind a store that hangs. Its record is still written by the flush after the callback, which halts on failure, as on base.
- **The record that must be durable first is the decision row.** Checkpoints stay with the normal flush, so their content and `capturedAt` are byte-identical to base. Inside an ADR-024 frame, `capturedAt` is the frame's last instant.
- **A failed durability write refuses the intent before the allocator**, instead of letting risk refuse it under the halt. No new health counter was added, to keep the health surface unchanged; the GLOBAL STORE_UNAVAILABLE halt record names the failure.

### deviations

- **`test/e2e/support/harness.ts`** is an existing test-support file, edited additively. It gains an optional `wrapStore`, mirroring the integration fixture's existing option. The packet lists `test/**` as "(new tests)", but the WP-250 e2e scenario is the only one with a protective reduce, and it could not run over an observed store otherwise. The golden runs are unchanged: e2e is 212/212.
- **`packages/trading-core/src/loop-refused-plan.test.ts`** is extended additively, with `intents` and `store` harness inputs and a new DURABLE-1 describe block. This is within the allowed paths.
- **For a CANCEL, handoff §8.1's order is not applied to its own decision.** Persisting decisions before any submit would include the CANCEL's own record; this is deliberate and pinned by tests. It needs a ruling (see follow_up).

### known_risks

- **The loop now waits on the store before each placement.** It awaits a commit (group commit) or a row write (per-row), protective reduces included. §8.1 says "never wait on external I/O", but THROUGHPUT-1a already awaited `#commitStaged` before every intent, so this extends an existing wait rather than adding a new kind. A slow database now delays each placement by one commit.
- **The bench fixture exercises the new check only once.** It has one decision with an intent among 46,666. Bursts with many placements are not measured beyond the unit and e2e scenarios.
- **The PostgreSQL variant fails the store with a trigger, not a network outage.** It fails the real INSERT inside PostgreSQL, but a connection lost mid-commit is not exercised here.
- **The per-decision refusal flag is reset for each DECIDED outcome.** Nested evaluation inside `#routeIntent` would reset it. None exists today, and a failure latches a GLOBAL halt that stops evaluation anyway.

### follow_up

- **Ruling needed from the verifiers or the user: the CANCEL exemption.** A CANCEL is routed without waiting for its own decision's record. They can accept that, or require the record to be durable first; changing it is a one-condition edit.
- **WP-270 (OMS and signed-order persistence)** must write its signed-attempt rows after this check and before submission. It must not treat an in-memory outbox append as an audit record.
- **E-02 / N1** (live admission uses event time) is untouched and stays with the closeout's N1 owner.
- **The paper-trader integration `vitest.config.ts` header** still counts six container files. This round adds a seventh, `durable-decision-before-placement-postgres.test.ts`, which starts its own containers as the header's rule requires; the header prose was not edited.

### commit_sha

69a19dc

## Implementer handoff r1 (verbatim)

### summary

DURABLE-1 round 1 is committed as d6a6e76, one commit on top of 69a19dc (not pushed). It fixes the MEDIUM finding and four of the LOW findings; two LOWs are argued and LOW-1 still needs the user's ruling. All gates pass.

**A01 (MEDIUM), fixed.** `CoreLoop.#consumeOutcome` now routes a decision's intents through a new helper, `cancelsFirst()` (loop.ts :1786, helper at :4106). It routes every CANCEL first, then every placement, keeping the emitted order within each group.
- A list with no placement before a cancel is returned unchanged. That covers every list Static Bracket builds.
- Placements still wait behind the durability boundary. A CANCEL never waits on its own decision's record, whatever its position in the list.
- One behaviour changes for a `[placement, market-wide CANCEL]` list: base cancelled the order the same decision had just placed; now that order stays resting. No shipped strategy emits such a list.
- Pinned by four held-store unit tests (both orderings, per-row and group commit). The two `[placement, CANCEL]` cases fail on 69a19dc.

**LOW-4, fixed.** A placement refused at the boundary now goes on to the risk check. That check refuses it under the halt already latched (RISK_RUN_STATE_BLOCKS) and counts it; a protective exit lands in `risk.refusedExits`. A final guard (`if (undurable) return`) refuses the placement whatever risk answers. Nothing is reserved, planned or submitted, and no health field was added.

**LOW-5, fixed.** A new flag, `#durabilityLost`, makes `durabilityMark()` answer false after a staging failure or a refused per-row write. Rows staged before the failure still commit. The pump already stops on any halt, so its behaviour is unchanged.

**LOW-2, fixed.** The PostgreSQL test no longer counts the empty `execution.*` tables as evidence, since the trader never writes them. Their emptiness is now asserted in the control case, so the test trips if the trader ever starts writing them.

**LOW-1: comment corrected, ruling still needed.** Under group commit a CANCEL still waits on the whole commit chain, as on base. The fix only guarantees that a CANCEL gains no new wait for its own record.

**LOW-3 and LOW-6: argued, not changed in code.** LOW-3 (a decision and its checkpoint can commit in separate transactions) is kept, because keeping them together would change checkpoint timestamps inside frames and break byte-identity. LOW-6 (placement-heavy bursts unmeasured) needs a new fixture or forbidden strategy changes.

**Bench (8fde4df vs d6a6e76):** three paced pairs and two catch-up pairs, in alternating order. Every candidate paced run had a lower p99 lag than the base run it was paired with (mean 9.028 s vs 9.143 s). Catch-up throughput was 0.5% lower (830.8 vs 835.1 events/s), inside the 1.4% spread between the two base runs. Decisions and checkpoints were byte-identical across all 10 runs.

The finding-by-finding table is in the handoff file.

### files_changed

[
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/packages/trading-core/src/loop.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/packages/trading-core/src/loop-refused-plan.test.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/test/e2e/durable-decision-protective-reduce.test.ts",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-durable-1/test/integration/paper-trader/durable-decision-before-placement-postgres.test.ts"
]

### tests_run

**Gates.** Run one after another on the final tree (identical to d6a6e76). Every gate exited 0.

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint | exit 0 |
| check:deps | PASS |
| test | 368 files / 7817 tests passed (+5 vs r0) |
| test:e2e | 9 / 212 passed |
| test:replay | 3 / 17 passed |
| trader test:integration | 27 / 194 passed (includes the 4 real-PostgreSQL tests, Docker) |
| control-api test:integration | 10 / 87 passed |
| event-bus test:integration | 10 / 112 passed |

Logs are in `…/durable-1/logs/r1-*.log`.

**Proof the new tests catch the old code.** I ran the r1 test files against 69a19dc's loop.ts in a separate scratch worktree:
- Unit: 6 failed, 20 passed. The failures are 3 for LOW-4, 1 for LOW-5 per-row, and 2 for A01 `[placement, CANCEL]`. The two `[CANCEL, placement]` cases pass, as they should.
- e2e: 2 failed, 4 passed (LOW-4 in both arms).

The scratch worktree was then removed. The candidate worktree was never touched and is clean.

**Mutation sweep.** Each mutant below was applied to the candidate loop.ts; the unit tests were filtered to the DURABLE-1 cases.

| Mutant | Unit | e2e |
|---|---|---|
| A01 (cancelsFirst removed) | 2 fail | pass |
| LOW4 (early return restored) | 3 fail | 2 fail |
| LOW5g (no flag on stage failure) | 1 fail | pass |
| LOW5r (no flag on per-row failure) | 1 fail | pass |
| BELT (final guard removed) | survives | pass |

The BELT survivor is expected and is disclosed under known risks.

**Bench.** Ten `trader-throughput` runs on the full H1 burst against fresh PostgreSQL and Redis containers; the numbers are in the handoff.

No .skip, .only, eslint-disable or ts-ignore was added.

### assumptions

- **Cancels first is the remedy the verifiers asked for.** Routing a decision's CANCELs ahead of its placements matches "let safety cancels that were already emitted go through without waiting on this barrier". It is deterministic. Reordering only when the store is actually slow would make routing depend on store latency and break replay.
- **Running the allocator and risk check on an already-refused placement is safe.** Both are side-effect-free apart from counters. Base handled every placement under a halt the same way.
- **The durability flag also covers per-row failures.** Setting `#durabilityLost` on per-row write failures, not only on staging failures, is the consistent reading of "every decision is durable once this resolves true".

### deviations

- **Routing order changes for one shape.** A `[placement, CANCEL]` decision is now routed cancel first. The persisted decision record keeps the strategy's order; only the routing order changes.
- **The LOW-2 test cannot fail on 69a19dc.** It corrects the test's evidence, not code behaviour.
- **LOW-3 and LOW-6 are argued rather than fixed in code.**
- **LOW-1 is left for the user's ruling.** Only its rationale in the code comment was corrected.
- **The protective-reduce case lives in an existing file.** The named reduce-path test from r0 is in the r0 test file that r1 extends.

### known_risks

- **The final guard is not covered by any test.** The BELT mutant survives because §9.8 check 1 already refuses every placement under a halt. Covering it would need a risk double that approves under a halt, and `packages/risk` is forbidden.
- **Scoped cancels behave differently in mixed lists.** A future strategy that emits a placement and then a market-wide CANCEL in one decision would leave its fresh order resting. This is documented on `cancelsFirst`.
- **A CANCEL can still wait on the store.** Under group commit it still waits on the commit chain for earlier batches, as on base, so a store that hangs on an earlier batch still delays it.
- **The LOW-3 window remains.** In group mode a decision can become durable while its checkpoint commits in a later transaction. A crash between the two leaves a durable decision without its checkpoint.
- **The lag result is small.** The paced comparison is 3 runs per side on a shared host.

### follow_up

- **User rulings needed.**
  - LOW-1: should a CANCEL stay exempt from its own decision's durability barrier? Both verifiers recommend yes.
  - A01: is routing cancels before placements acceptable for mixed intent lists?
- **LOW-6:** measure the commit cost on a placement-heavy burst. That needs a new recording or strategy-parameter changes outside this package.
- **LOW-3:** when a production `restoreFrom` caller is built, either stage a decision and its checkpoint together or make the restore tolerate a missing last checkpoint.
- **Carried over from r0:**
  - WP-270's signed-attempt rows must be written after this boundary.
  - E-02/N1 is untouched.
  - The header of the trader integration `vitest.config.ts` still says "SIX" container files; the PostgreSQL test added in r0 is the seventh.

### commit_sha

d6a6e76ff8777f4ccce6d7e97f76873e3003bf26
