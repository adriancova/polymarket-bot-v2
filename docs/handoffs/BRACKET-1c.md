# BRACKET-1c: a durable two-bracket round trip through real PostgreSQL + Redis

Branch `bracket-1c` on base `60a5d7e`, merged into `main` as `6e06c50` (`--no-ff`) on 2026-09-28.

- **Authorization:** the user's ruling R1 (1a + 1b + 1c); authorized at the `BRACKET-1b` flip (`60a5d7e`).
- **Process:** the HARDENING LOOP (workflow `wf_726270df-fe0`).
  - An Opus implementer.
  - The **verifier was a Claude Fable adversarial-reviewer**, not Codex. The round's evidence is Testcontainers-only, and Codex's sandbox cannot start containers. This is the precedent the user approved for `CI-2`.
  - The reviewer ran every gate itself, with Docker 29.1.2.

| Commit | Content |
| --- | --- |
| `df0e8e4` | r0 (accepted on first review) |
| `6e06c50` | the merge (tree identical to `df0e8e4`) |

## Outcome
**New file:** `test/integration/paper-trader/durable-two-brackets-postgres-redis.test.ts`, with `support/two-brackets.ts`.

**What it drives — the real path:**
- registration through the WP-040 repositories, with the registered `strategy.configs` row read back;
- `assembleDurableTrader`, using `PostgresTraderStore`, `observeRealizedPnl`, `verifyRegisteredRows`, the Tier-0 `SimulatedVenue` and `createPaperTrader`;
- each event published with `RedisStreamsEventTransport` and consumed through the process's own `RedisMarketEventFeed` and `pump`;
- a SHUTDOWN rebuild check at the end.

**The scenario** is 1b's 11 events on the fixture's market, shifted +3 h, with one delta: `maximum_entries_per_market` 2.
- Bracket 1 is closed by `SB.PROTECTED_REDUCE` on the holding timeout, and `SB.REARMED` follows at 12:03:40.
- Bracket 2's onFill take-profit fills as MAKER from a public trade.
- The run ends with `SB.REFUSED_MAXIMUM_ENTRIES`.

**Every durable claim is a SELECT:**
- **Decisions:** 19 rows, in order. They equal `loop.decisions()` and the 1b golden's reason codes, types, callbacks, time offsets and causing events.
- **Checkpoints:** one per decision. Hashes are recomputed from the stored state, and the stored status goes CLOSED/1 → ARMED/1 → CLOSED/2.
- **Ledger:** 8 transactions (the fixture's fees are zero), equal to health and to the per-fill sum. All are PAPER, on the registered account. The instance's pUSD entries sum to −1 at the boundary and 7.5 at the end.
- **PnL snapshots:** 4, with realized `0, −1, −1, 7.5`. These equal the hand derivation written before the first run, and the in-memory PnL state after each close. TRDR-3's realized-PnL book equals the last durable row.

**Two more tests:**
- A **contrast test** uses the process's own `SystemPaperClock` and ONE pump over the whole stream. It reads back the identical durable run.
- A **fee variant**, a disclosed second delta using the e2e fee schedule, lands the durable fee legs: 3+3+3+2 = 11 transactions. Its snapshots equal the 1b golden column for column.

**Non-vacuity**, each probe restored with sha256 equal to HEAD:

| Probe | Result |
| --- | --- |
| Event published to another stream | fails |
| Reversed monotonic clock | fails (the event-time tests) |
| One `receivedAt` shifted | fails |
| Snapshot column renamed mid-run | GLOBAL halt, and the test fails |
| Clock never advanced | passes — see deviation 1 |

**Ratified by the orchestrator at merge:**
1. **The clock premise is corrected.** Strategy time is the envelope's `receivedAt` (`loop.ts` `#processEvent`), not the paper clock, so a frozen clock does not fail the run. What does fail it is a wrong event time carried through Redis, or a reversed monotonic clock. The e2e harness never advances its clock either. The packet's premise was wrong, and the implementer's correction is right.
2. **The fee-variant test is kept.** It is the only test that exercises the durable `PLATFORM_FEE` writer.

## Review (Claude Fable adversarial-reviewer)
**r1 of `df0e8e4`: ACCEPT.**
- **Gates:** it ran the gates itself, including trader integration 16/135 twice, with the new file running, not skipped, both times.
- **Path:** it traced the real path.
- **Economics:** it re-derived them independently from the raw PostgreSQL rows.
- **Probes:** the packet's mutations plus five of its own, each caught except `L2`.

**Findings:**
- **`BRACKET1C-SNAPKEY`, HIGH, a residual outside this grant; it does not change the verdict.** See below.
- **`BR1C-R1-L1`, LOW.** The fixture-schedule tests do not pin `core_net_pnl`, `gross_trading_pnl`, `capital_committed` or `worst_case_resolution_pnl`. The values were read back and are correct, so this is a coverage gap only.
- **`BR1C-R1-L2`, LOW.** The SQL `where` predicates are not load-bearing: one database per scenario is what scopes the rows. No wrong claim follows.

## The finding: `BRACKET1C-SNAPKEY` (HIGH)
**The defect.** The durable paper trader GLOBAL-halts `STORE_UNAVAILABLE` on the second fill of any entry that walks two ask levels.
- `loop.ts` `#writePnlSnapshot` writes one `accounting.pnl_snapshots` row PER FILL, at the event's instant.
- But `pnl_snapshots_scope_unique` is `unique nulls not distinct (scope, environment, account_ref, instance_id, market_id, as_of)` (`db/migrations/0006_accounting.up.sql:857`).

**Reproduction.** The implementer's probe F3 was reproduced by the reviewer:
- the halt is at 12:00:02Z with `duplicate key value violates unique constraint "pnl_snapshots_scope_unique"`;
- both fills' postings land, and one snapshot lands;
- the loop halts before the take-profit decision.

**Why the doubles masked it.** The original paper-e2e golden holds two snapshots at `09:00:02Z` for one instance and market, and `MemoryTraderStore.writePnlSnapshot` just pushes. This is GOV-2B's B1 class.

**The consequence.** The durable paper path is proven only for one fill per instance per instant. The first multi-level taker in a live-data paper run would halt it. **This blocks H1.**

**The ruling.** On 2026-09-28 the user chose **one snapshot per instance per instant**. The round is authorized as `SNAP-1`.

## Also observed (queued)
**`BOOT1-CONFIGPARAMS`** (implementer, pre-existing). `verifyRegisteredRows` checks the `config_id` but never reads `strategy.configs.parameters` or its hash. So a registered config and a trader document that disagree on parameters — for example, max entries 1 against 2 — would start without refusal. This is an operator hazard for H1.

## Not claimed
- §7 item 1 is NOT closed by this round. The MET verdict belongs to a fresh read-only closeout, which must also weigh `BRACKET1C-SNAPKEY` (being fixed by `SNAP-1`).
- The evidence is simulated execution (Tier-0) over real PostgreSQL and Redis.
- Not exercised:
  - gateway normalisation (the UNIV-4 file covers it);
  - `startup()` itself (no config-file read, no env URLs);
  - the durable execution chain (`RECON2-DURABLE`).

## commit_sha
- Implementation: `df0e8e4e895bb5dc4815c04791cec10a8003bfe5`.
- Merge: `6e06c50`.

# Appendix A — implementer handoff, r0 (verbatim)

# BRACKET-1c — implementation handoff, round 0

## plan (written BEFORE any edit; the pre-edit hand-back is waived by the packet)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-bracket-1c`, branch `bracket-1c`, base
`60a5d7e` (clean). Docker answered `29.1.2`.

Prerequisites verified: AGENTS.md; `IMPLEMENTATION_STATUS.md` rows BRACKET-1c (Ready/authorized
2026-09-28, R1), BRACKET-1a and BRACKET-1b (Complete), RECON2-DURABLE, BRACKET1-TPRACE, TRDR3-R1;
`docs/handoffs/BRACKET-1b.md`, `GOV-2B-wave-2-closeout.md` §7 + B1, `BOOT-1.md`; every
`test/integration/paper-trader` file the packet names; `test/e2e/support/scenarios/two-brackets.ts`,
`scenario.ts`, `harness.ts`; the two-bracket golden; `apps/trader/src/{main,pump,loop}.ts`,
`adapters/{postgres-store,redis-feed}.ts`, `pnl-observation.ts` (read only).

Read-only findings that shape the plan (verified at `60a5d7e`):

- F1 (packet premise on the clock). The loop's instant is the ENVELOPE's `receivedAt`
  (`loop.ts` `#processEvent`: `#lastInstant = normalizeToStrictUtc(envelope.receivedAt)`), not
  the §12.1 `Clock`. The clock supplies only (a) the instant before the first event
  (`clock.now()` once, at construction) and (b) monotonic nanoseconds: the runtime watchdog, the
  venue's rest-start stamp and the observed-trade stamp (`venue.ts`: a resting order fills from a
  trade only when `trade ns >= restingFromNs`). The holding timeout and cooldown are measured in
  recorded event time, which travels through Redis inside the envelope. The e2e harness never
  advances its `ManualClock` (it stays at `clockStart`). So "a wrong clock fails the run" is not
  generally true: a FROZEN clock should still pass; a clock whose monotonic time runs BACKWARDS
  between the take-profit's placement and the public trade should fail (the take-profit never
  fills). I will still do what the packet asks (an event-time `ManualClock` positioned at each
  event before the loop processes it), measure the frozen and reversed probes, and add the
  non-vacuity that actually governs time: a shifted `receivedAt` on the Redis path.
- F2 (fixture vs e2e). The paper-trader fixture's fee schedule is ZERO (taker and maker), so the
  one-delta configuration books 2 ledger transactions per fill (8, not 3+3+3+2 = 11); its
  `maximum_book_participation` is 0.5 (e2e 0.9), so the fixture's level sizes (200/300) are kept
  and each entry still fills in ONE level. Times shift by exactly +3 h (T_OPEN 12:00 vs 09:00).
- F3 (possible B1-class finding, outside this scenario's shape). `accounting.pnl_snapshots`
  carries `pnl_snapshots_scope_unique (scope, environment, account_ref, instance_id, market_id,
  as_of)`, and the loop writes one snapshot PER FILL at the event's instant
  (`loop.ts` `#writePnlSnapshot`). Two fills of one instance at one recorded instant (an entry
  walking two ask levels — the ORIGINAL paper-e2e golden has two snapshots at `09:00:02Z`) would
  violate it and GLOBAL-halt `STORE_UNAVAILABLE`. This scenario cannot reach it (one-level fills,
  by the packet's own rule). I will reproduce it in a scratch probe through
  `assembleDurableTrader` and REPORT it (C4), not fix it, not commit a skipped test.

Implementation (only `test/integration/paper-trader/**`):

1. `support/registration.ts`: an OPTIONAL `params` option on `registerThroughTheRepositories`
   (default `strategyParams()`, so every existing caller is byte-for-byte unchanged in behaviour)
   so the registered `strategy.configs` row carries the params the run actually uses.
2. `support/two-brackets.ts` (new): the one-delta params (`maximum_entries_per_market` 2), the
   document builder (fixture document naming the registered rows + a unique event stream, as
   UNIV-4 does), and the 11-event builder with 1b's shape on the fixture's market, times and
   ladders: refs 11:59:58/59, MarketOpened 12:00:00, YES 12:00:01 (arm; asks 0.34x200, 0.35x300),
   NO 12:00:02 (enter 1), YES 12:03:05 (holding timeout withdraws the TP), YES 12:03:06
   (PROTECTED_REDUCE fills 50 @ 0.32 -> CLOSED), YES 12:03:40 (asks 0.33x200; REARMED), NO 12:03:41
   (enter 2), PublicTradeObserved YES 0.5 x 60 12:04:00 (TP MAKER fill -> CLOSED), YES 12:04:10
   (REFUSED_MAXIMUM_ENTRIES). Both entries fill in one level (BRACKET1-TPRACE unreachable).
3. `durable-two-brackets-postgres-redis.test.ts` (new), own `beforeAll` (one PostgreSQL + one
   Redis), no globalSetup, no Docker skip, PAPER throughout:
   - main: register through the repositories -> `assembleDurableTrader` with an event-time
     `ManualClock` -> for each event: publish it with `RedisStreamsEventTransport` onto the
     stream, then `pump` the process's own `RedisMarketEventFeed` (wrapped to position the clock
     at the delivered event's `receivedAt`, and refusing a multi-event batch) until idle -> the
     SHUTDOWN rebuild check (startup step 5b) -> read everything back from SQL: C2 in full,
     including the in-memory PnL captured right after each close;
   - contrast: the process's own `SystemPaperClock`, all events published first, ONE pump, no
     wrapper — the same durable run (F1 made observable);
   - fee variant (a DISCLOSED second delta, the e2e scenario's fee schedule): the only way the
     durable `PLATFORM_FEE` writer runs; 3+3+3+2 = 11 and the snapshot economics equal the
     BRACKET-1b golden's `pnlSnapshots` column for column.
   The hand derivation goes into the file header BEFORE the first run.
4. Non-vacuity probes (scratch, restored byte-identically, sha256 checked): one event published
   to another stream; the clock frozen; the clock reversed; one event's `receivedAt` shifted.
5. Gates: typecheck, lint, check:deps, unit, e2e, replay, control-api integration, trader
   integration twice. One commit on `bracket-1c`; no push.

---

## summary

BRACKET-1c is implemented and committed on `bracket-1c` as `df0e8e4` (one commit on `60a5d7e`; not
pushed, no PR). The evidence is simulated execution over real infrastructure: a Tier-0
`SimulatedVenue` with fills labelled `SIMULATED_NOT_REAL_EVIDENCE`. No soak, probe or live
evidence is claimed, and §7 item 1 is NOT claimed closed (ruling R1: a fresh read-only closeout
grades it). Every gate exits 0 at the commit, and trader integration was run twice.

**C1.** The new `test/integration/paper-trader/durable-two-brackets-postgres-redis.test.ts` has its
own `beforeAll` (one PostgreSQL, one Redis), no globalSetup and no Docker skip.

- **Registration** goes through the WP-040 repositories. The registered `strategy.configs` row
  carries the two-entry params, and that is read back.
- **Assembly** is `assembleDurableTrader`.
- **Events:** each event is published with `RedisStreamsEventTransport` onto a per-scenario stream.
  It is consumed through the process's own `RedisMarketEventFeed` and `pump`, then the SHUTDOWN
  rebuild check (startup step 5b) runs.
- **Scenario:** `support/two-brackets.ts` builds 1b's eleven-event shape on the fixture's market,
  identities and ladders, at the e2e instants + 3 h. The one delta is
  `maximum_entries_per_market` 2.
  - Bracket 1 is closed by `SB.PROTECTED_REDUCE` on `SB.HOLDING_TIMEOUT`.
  - `SB.REARMED` follows at 12:03:40.
  - Bracket 2 is closed by its onFill take-profit, filled as MAKER by a public trade at 12:04:00.
  - The run ends with `SB.REFUSED_MAXIMUM_ENTRIES`.
  - Each entry fills in ONE level, so `BRACKET1-TPRACE` is unreachable.
- **Clock:** as asked, the main test positions a `ManualClock` at each delivered event's
  `receivedAt`, inside a feed wrapper. One event is published, then pumped until idle; a
  multi-event batch is refused.
  - The packet's PREMISE is corrected (deviation 1). Loop time is the envelope's `receivedAt`
    (`loop.ts` `#processEvent`), not the clock.
  - A contrast test runs the process's own `SystemPaperClock` with ONE pump over the whole stream,
    and reads back the identical durable run.

**C2.** Every durable claim is a SELECT:

- **Decisions:** 19 rows, in order. They equal `loop.decisions()`. They also equal
  `two-brackets-run.json`'s `reasonCodes`, `decisionType` and `callback`, its offsets from market
  open, and the causing event by ingest ordinal. The golden is READ, never written.
  - The cancel at 12:03:05 and the reduce at 12:03:06 both carry `SB.HOLDING_TIMEOUT`.
  - No `SB.PAUSED`, `UNATTRIBUTED_FILL`, `ILLEGAL_TRANSITION` or `POSITION_MISMATCH` appears.
- **Checkpoints:** one per decision, with `captured_at` = `evaluated_at` and `state_hash` =
  sha256(canonicalJsonStringify(stored state)).
  - The state is CLOSED/1 after bracket 1's close and just before REARMED.
  - It is ARMED/1 at REARMED: the CLOSED→ARMED transition, named in the rows.
  - It is CLOSED/2 at the second close and at the end.
- **Ledger:** the count = `health.accounting.ledgerTransactions` = the sum of each fill's
  postings. Every row is PAPER, on the registered account.
  - `fill_id`/`order_id` are NULL and `execution.fills` is empty, the same meaning as the BOOT-1
    pair (`RECON2-DURABLE`).
  - The instance's durable pUSD and token entries are summed exactly, at the bracket boundary and
    at the end.
- **PnL snapshots:** one per fill. Realized PnL equals the hand derivation and the in-memory
  `pnlState` captured right after each close.
- **Health book:** the TRDR-3 realized-PnL book equals the last durable row.
- **Fee variant (deviation 2):** a disclosed second delta, the e2e fee schedule. It is the only way
  the durable `PLATFORM_FEE` writer runs.
  - It books 3+3+3+2 = 11 transactions, with fee legs −0.219 / −0.212 / −0.216.
  - Its 13 economic snapshot columns equal the BRACKET-1b golden's `pnlSnapshots`, column by
    column.

**C3.** Non-vacuity is shown for the Redis path, for the clock (whose premise was corrected), for
event time and for a broken durable writer. The probes ran twice: before the commit, and against
`df0e8e4` with sha256 == HEAD after each restore. The header states what is NOT proven.

**C4. FINDING, reported and not fixed.** The durable trader GLOBAL-halts on the second fill of
any entry that walks two ask levels. The cause:

- `loop.ts` writes one PnL snapshot per fill at the event's instant.
- `accounting.pnl_snapshots` is `unique nulls not distinct (scope, environment, account_ref,
  instance_id, market_id, as_of)`.

The ORIGINAL paper-e2e golden's entry (30 @ 0.34 + 20 @ 0.35 at one instant) has exactly this
shape. `MemoryTraderStore` accepts duplicates, which is how the doubles masked it: the B1 class.
The reproduction is below. It is not committed as a test, skipped or otherwise.

## Hand-derived economics (written in the test header BEFORE the first run; matched on the first run)

| | Bracket 1 | Bracket 2 | Cumulative |
| --- | ---: | ---: | ---: |
| Entry | BUY 50 @ 0.34 = 17 | BUY 50 @ 0.33 = 16.5 | 33.5 |
| Exit | reduce SELL 50 @ 0.32 = 16 (TAKER) | TP SELL 50 @ 0.5 = 25 (MAKER) | 41 |
| Realized | −1 | 8.5 | 7.5 |
| Fees (fixture, zero schedule) | 0 | 0 | 0 |
| Fees (e2e-fee variant) | 0.219 + 0.212 = 0.431 | 0.216 + 0 = 0.216 | 0.647 |

- **Snapshots, per fill:** realized `0, −1, −1, 7.5`.
  - `fees_paid` is `0,0,0,0` on the fixture schedule.
  - `fees_paid` is `0.219, 0.431, 0.647, 0.647` on the e2e-fee variant.
  - Net is 7.5 on the fixture schedule and 6.853 on the variant (`core_net_pnl` read back as
    `6.853`).
- **Instance pUSD entries summed:** −1 at the boundary and 7.5 at the end (fixture); −1.431 and
  6.853 (variant). The token entries sum to 0 at both points.
- **Ledger:** 2+2+2+2 = **8** (fixture), 3+3+3+2 = **11** (variant). A zero fee posts no
  `PLATFORM_FEE`.

## C4 finding: durable PnL-snapshot key collision (pending, skip-free, NOT a committed test)

**Reproduction.** Run it against `df0e8e4` with `/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/bracket-1c/probes.py`, case F3.

1. In `test/integration/paper-trader/support/two-brackets.ts`, change the first
   `BRACKET_1_YES_ASKS` level from `0.34 x 200` to `0.34 x 30`. The 50-share entry now fills
   30 @ 0.34 + 20 @ 0.35 at `12:00:02`.
2. Run the main test:
   `pnpm exec vitest run --config test/integration/paper-trader/vitest.config.ts test/integration/paper-trader/durable-two-brackets-postgres-redis.test.ts -t "event-time clock"`.
3. Restore the file from HEAD.

The exact halt:

```text
{"scope":{"kind":"GLOBAL"},"code":"STORE_UNAVAILABLE","detail":"a PnL snapshot could not be persisted:
 the durable store could not write a PnL snapshot: error: duplicate key value violates unique constraint
 \"pnl_snapshots_scope_unique\"","at":"2026-03-04T12:00:02Z","action":"FULL_HALT"}
```

- **What landed:** both fills' ledger postings (4 transactions), ONE snapshot (`capital_committed`
  10.2), and 2 decisions (ARMED, enter).
- **What did not:** the second snapshot. The loop halted before the take-profit decision.
- **Evidence that the doubles masked it:** `test/replay-golden/paper-e2e/paper-e2e-run.json` holds
  two VIRTUAL_STRATEGY snapshots for the same instance and market at `2026-05-01T09:00:02Z`, with
  `health.halts: []`. `MemoryTraderStore.writePnlSnapshot` just pushes.
- **Consequence:** the durable paper process halts on the first taker order that walks more than
  one level, or on any event that yields two fills for one instance. Such fills are normal for a
  live-data paper run.
- **Owner decision needed.** It lies in `apps/**` and/or `db/**`. Options, none chosen here:
  - (a) the loop writes one snapshot per (instance, instant), after the last fill booked at that
    instant;
  - (b) the adapter upserts or skips on the key (it is a "rebuildable reporting projection");
  - (c) the key gains a per-fill discriminator.
  - In addition, `MemoryTraderStore` should enforce the same key, so the doubles stop masking it.

## files_changed

- `test/integration/paper-trader/durable-two-brackets-postgres-redis.test.ts` (new, 3 tests)
- `test/integration/paper-trader/support/two-brackets.ts` (new: one-delta params, document builder,
  the 11-event builder, the e2e fee schedule for the variant)
- `test/integration/paper-trader/support/registration.ts` (one optional `params` input on
  `registerThroughTheRepositories`, default `strategyParams()`; header note; no existing caller
  changed)
- `test/integration/paper-trader/vitest.config.ts` (header prose only: a dated correction, since
  "FOUR files" became false)

## tests_run

All runs were outside any sandbox, with Docker 29.1.2 and cached images.

**Baseline at `60a5d7e`:** trader integration 15 files / 132 tests, exit 0.

**Gates at the commit `df0e8e4`** (re-run after the final edit):

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm run lint` | exit 0 |
| `pnpm run check:deps` | exit 0 (PASS; 34 packages, 80 edges) |
| `pnpm run test` | 345 files / 7529 tests, exit 0 |
| `pnpm run test:e2e` | 8 / 206, exit 0 |
| `pnpm run test:replay` | 3 / 17, exit 0 |
| `pnpm --filter @polymarket-bot/control-api test:integration` | 10 / 87, exit 0 |
| `pnpm --filter @polymarket-bot/trader test:integration` | 16 / 135, exit 0, run TWICE. That is base 15/132 + 1 file / 3 tests |

The same gates were also run once before the commit (identical counts), and the new file alone
passed 3/3 on four separate runs.

**New tests** (describe "BRACKET-1c: a durable two-bracket round trip through PostgreSQL, Redis
and the composition root"):

1. "drives both brackets through the Redis stream and pump on the event-time clock; every durable
   write past the first fill reads back"
2. "the process's own SystemPaperClock and ONE pump over the whole stream give the same durable
   run — strategy time is the envelope's receivedAt"
3. "on the e2e scenario's fee schedule the durable fee postings land: 3+3+3+2 transactions, and
   the snapshots equal the BRACKET-1b golden's"

**Probes against `df0e8e4`** (`/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/bracket-1c/probes.py`; logs `/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/bracket-1c/head-probe-*.log`; summary
`/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/bracket-1c/head-probes-summary.txt`). Each probe is restored from `git show HEAD:<path>`, and its
sha256 equals HEAD: the test file is `35e074ee…`, `two-brackets.ts` is `a9b20dcc…`. Git status is
clean after the probes.

- **P1** (the 12:03:05 event published to `<stream>-elsewhere`, both publication paths): 3/3 FAIL.
  - The per-event runs observe 2 fills, not 4.
  - The one-pump run ingests 10 events, not 11.
- **P2** (the clock never advanced): 3/3 PASS, as the code predicts.
- **P3** (a monotonic clock that runs backwards): both event-time tests FAIL with 3 fills.
  - The SystemPaperClock test PASSES, with 4 fills.
- **P4** (the 12:03:05 book's `receivedAt` moved to 12:03:01): 3/3 FAIL, 2 fills each, the
  system-clock test included.
- **P5** (`pnl_snapshots.realized_pnl` renamed after bracket 1): GLOBAL `STORE_UNAVAILABLE` at
  12:03:41 ("column "realized_pnl" of relation "pnl_snapshots" does not exist"). The test FAILS on
  `halts`.
- **F3** (the finding above): GLOBAL `STORE_UNAVAILABLE`, duplicate key `pnl_snapshots_scope_unique`
  at 12:00:02.

## assumptions

- The fixture's `ingested()` envelopes (`sourceChannel "market"`, the fixture gateway epoch) are
  acceptable stand-ins for gateway-normalised envelopes. The transport's envelope door accepted all
  eleven. Gateway normalisation is out of scope here; UNIV-4 covers it for `MarketOpened` and books.
- A per-scenario `infrastructure.eventStream` is an infrastructure address, not a configuration
  delta in the packet's sense, as in UNIV-4.
- "Valid hash" means the durable `state_hash` equals sha256 of the canonical serialization of the
  durable `state`. Recomputing it from the jsonb read-back relies on the state holding only values
  that round-trip through jsonb canonically, which is true for this state (observed).
- Calling `pump` once per event (main test) is still "the process's own pump". The single-pump
  shape is covered by the contrast test.

## deviations

1. **The clock premise is corrected, not met as worded.** The packet assumed the clock must follow
   event time because the timeout and cooldown "cannot be waited out in real time".
   - The loop measures time from the envelope's `receivedAt`; the clock supplies only the pre-event
     instant and monotonic stamps. The e2e harness never advances its ManualClock either.
   - I implemented the event-time clock exactly as asked. But "not advancing it" does NOT fail the
     run (P2, measured).
   - A monotonic clock running backwards does fail it (P3), and so does a wrong EVENT time on the
     Redis path (P4). The holding-timeout, cancel and REARMED pins are pins on recorded time.
2. **The fee-variant test uses a SECOND configuration delta** (the e2e fee schedule, on both
   `simulation.feeSchedule` and the market's rates). The main and contrast tests obey the
   one-delta rule. The variant exists because the fixture's zero fee schedule never exercises the
   durable `PLATFORM_FEE` writer; it also lets the snapshots be held to the 1b golden column by
   column. It is easy to remove if the orchestrator disagrees.
3. **The ledger count is 8, not 11,** in the one-delta configuration: the fixture's fees are zero.
   Stated, as the packet anticipated.
4. **The main test publishes and pumps one event at a time,** so the clock can be positioned per
   event. The contrast test covers the whole-stream single pump.
5. **Two support/config edits.** A comment-only dated correction in the suite's
   `vitest.config.ts`, and an optional `params` input on the registration helper (allowed support
   extension; no existing assertion changed).

## known_risks

- **The C4 finding means the durable paper path is only proven for runs with one fill per
  instance per instant.** Any multi-level or multi-fill instant halts it. This bears directly on
  the closeout's grading of §7 item 1.
- **Coupling to the golden.** The test reads `two-brackets-run.json`: `decisions[*]` and
  `pnlSnapshots[*]`. A legitimate regeneration that changes decisions or snapshot economics must
  be mirrored here. `TRDR-3-FU1`'s expected flip touches only `health.accounting.realizedPnl`,
  which this file does not read from the golden.
- **The header's probe paragraph** describes behaviour at `df0e8e4`. A future change to the venue's
  monotonic rule or to the loop's time source would make it stale.
- **Test-owned pieces stay in the path:** the ManualClock (main and fee tests) and the feed
  wrapper (all three). It is not `startup()` itself: no config-file read, no env URLs, and the pump
  stops on idle rather than on a halt.
- **Container image dependency.** Testcontainers needs the images cached, or network for a cold
  pull, as for the other container files.

## follow_up

- **Owner ruling and fix for the C4 finding.** It lies in `apps/trader/src/loop.ts` and/or
  `adapters/postgres-store.ts` and/or `db/migrations` (0006 `pnl_snapshots_scope_unique`). Also
  make `MemoryTraderStore` enforce the key. After the fix, a two-level-entry durable test should
  be added. A candidate residual row: `BRACKET1C-SNAPKEY`.
- **Observation (pre-existing, BOOT-1 scope).** `verifyRegisteredRows` checks the run's
  `config_id` but never reads `strategy.configs.parameters` or its hash. A registered config
  recording `maximum_entries_per_market 1` and a trader document stating 2 would start without
  refusal. This file registers matching params and reads them back, but the trader does not check
  them.
- **Governance and CI.** `RECON2-DURABLE` is unchanged (disclosed, pinned). The closeout grades
  §7 item 1. A green GitHub CI run is still owed; the orchestrator opens the PR.

## commit_sha

`df0e8e4e895bb5dc4815c04791cec10a8003bfe5` (branch `bracket-1c`, base `60a5d7e`; not pushed).
