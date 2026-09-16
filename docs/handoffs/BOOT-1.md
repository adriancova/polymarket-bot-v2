# BOOT-1 completion record — the durable trader refuses to start unless the rows its writes reference exist

**Merged:** `0d09eb5` (`--no-ff`, 2026-09-16). Chain `7263c13` candidate →
`ac0642f` r1, on base `1aa2238`. The candidate is the reviewed `5b4bc1b`'s tree
re-committed (diff empty) under a subject that states the design; the first
subject said "creates the rows" when the round refuses. Review round 1
**CHANGES REQUIRED** (2 HIGH, 4 MEDIUM, 4 LOW, 1 INFO) → round 2 **ACCEPT**
(2 LOW, 2 INFO). Reviewer independent of the implementer; every finding
reproduced through the real `startup()` against real PostgreSQL and Redis.

**Verdict on the blocker: B9 CLOSED for a run's FIRST start; a restart now
fails CLOSED at startup instead of at the first decision.**

## What it is

GOV-2B **B9**, raised by the TRDR-2 review: every durable write the trader
makes references `catalog.markets`, `strategy.instances` and `strategy.runs`
rows nothing in `apps/trader/src` creates. `strategy.decisions.run_id` /
`.instance_id` are NOT NULL FKs, so the assembled trader GLOBAL-halted on its
first DECISION against a migrated-but-unseeded database (`STORE_UNAVAILABLE`,
exit 75 — reproduced at base by the reviewer: `decisions_run_id_fkey`, all
tables 0 rows, and `health.loop.decisionsPersisted` reading **1** with 0 rows,
which became residual R6).

## The decision: refuse, not create

Argued per table and confirmed by the review on the code:
- `strategy.runs` — `createStrategyRepository(db).startRun` mints `run_id`
  (`repositories/strategy.ts:170-192`) and accepts no caller id; the configured
  `runId` is carried into every durable row and the `idNamespace`.
  `runs.definition_id`, `code_commit`, `state_schema_version` are NOT NULL and
  the trader config carries none of them: create-if-absent would have had to
  invent them or hand-write an insert bypassing WP-040's repository.
- `catalog.markets` — silently minting a market row is worse than refusing to
  trade.
- `strategy.instances` — the same: the row pins environment, account, config.

## What shipped

1. **`apps/trader/src/adapters/postgres-registration.ts`** (new). Reads the
   three tables by primary key through the typed builder, in one pass, before
   anything is written and before the stream is subscribed. Cross-checks the
   market's condition id; the instance's environment and `account_ref`
   (NULL treated as a mismatch against a configured account — the trader books
   every row to the configured account, so "the database states nothing" is a
   disagreement); the run's instance, environment, config id, run seed and
   status. **r1 added the read that closes the restart hole:**
   `select distinct run_id from strategy.decisions where run_id in (…)`, guarded
   on the non-empty set of runs the SELECT found. Typed codes:
   `TRADER_REGISTRATION_MISSING`, `_MISMATCH`, `_RUN_NOT_RESUMABLE` (exit 78,
   `configurationRefused`: the remedy is configuration) and `_UNREADABLE`
   (exit 69, new `EXIT_CODES.infrastructureUnavailable`). Every problem at
   once; the refusal text names the table, the id, the repository functions,
   the fact that no CLI exists, and — for a non-resumable run — the remedy
   (`startRun` a NEW run and point the config's `runId` at it, §9.6) and the
   reason (no read path until R10; starting anyway would halt on
   `decisions_evaluation_unique`, measured).
2. **`apps/trader/src/main.ts`** — `assembleDurableTrader({env, config,
   document, postgresUrl, clock, log})` factored out of `startup()`. Order,
   verified in source by the reviewer: `checkPaperTraderSafety` (`:346`) →
   pool (`:357`) → registration (`:365`) → venue and trader. It closes the store
   it opened on every refusal (fixing a pre-existing leak where a fee-snapshot
   refusal returned 78 with the pool open — disclosed as a behaviour change,
   not refactoring), and `startup()` closes the transport. `SystemPaperClock`
   exported; the `venue as unknown as …` cast deleted (TRDR-2's census registry
   is now empty and TRDR2-R8, the parenthesized-alias evasion, is closed).
3. **`apps/trader/src/adapters/postgres-store.ts`** — `appendLedgerTransaction`
   binds `fill_id: null, order_id: null`. See "The severing" below.
4. **`health.ts`'s `RISK_SEAM_CAVEAT` and `pipeline.ts:99-106`'s premise** —
   both FALSE since RISK-2 (they said protective reductions are refused and
   that `packages/risk` decides disposition from the intent TYPE). Corrected
   sentence by sentence against `packages/risk/src/intent-view.ts`, superseded
   text quoted, `not.toMatch(/^WP-220/)` pinned.
5. **`test/integration/paper-trader/durable-trader-first-fill-postgres.test.ts`**
   (new; real PostgreSQL 16.6-alpine + real Redis 7.4.2-alpine; NO
   `createTradingChain`) — the first test in the repository that proves the
   assembled durable trader survives its first fill: register through WP-040's
   repository functions → assemble → six recorded events through the real feed
   → decisions 8, checkpoints 8, ledger transactions 2, ledger entries 8,
   `pnl_snapshots` 1 landed; unseeded → `_MISSING` naming all three rows, every
   table 0 rows. r1 added: the restart refusal (close WITHOUT `stopRun`,
   assemble again → exit 78, rows unchanged; `startRun` a new run → assembles);
   the four cross-check mismatches (a SHADOW instance/run and a second config;
   four issue lines asserted); `account_ref` mismatch; the safety-first pin two
   ways (unreachable `postgresUrl` → `TRADER_UNSAFE_ENVIRONMENT`, not
   `_UNREADABLE`, no query ran; real unseeded DB → same); and
   `expect(execution.fills).toHaveLength(0)`.

## The severing, stated plainly

`accounting.ledger_transactions.fill_id → execution.fills` (plus four composite
FKs, `0006_accounting.up.sql:126, 189-201`); the trader writes no `execution.*`
row, and `execution.fills.order_id` / `execution.orders.plan_id` are NOT NULL, so
no minimal fills row is honest. With registration satisfied, the base halted on
`ledger_transactions_fill_id_fkey` (reviewer's reproduction: decisions 2,
checkpoints 2, ledger 0). The NULL binding is the right binding for this round
and it **severs** something: `packages/ledger/src/fill-posting.ts:277-285` puts
the fill id nowhere but the header, so one fill's durable transactions
(principal, token, fee) share only `occurred_at`/market/account/environment; two
fills at one instant in one market are indistinguishable in the durable ledger;
§6 invariant 8's rebuild FROM THE DURABLE ROWS cannot reproduce per-fill
economics (per-lot cost basis, per-fill fees, the `TraceLink` chain) until the
execution chain lands. Not lost: per-asset balances, per-instance attribution,
the in-memory ledger and `loop.traces()`. The `execution.fills`-is-empty pin
trips the day a round persists the chain; that failure is the instruction to
delete the NULL binding.

## What the review established independently

- **The restart hole (r1 HIGH).** The candidate's check treated
  `status = 'RUNNING'` as "accepts decisions". A crashed run stays RUNNING,
  passed, and the trader halted on `decisions_evaluation_unique` at its first
  decision — the exact shape the check exists to prevent, for every start but
  the first. Reproduced through the real `startup()` at the candidate (exit
  75, 8→8) and with the fix (exit 78, refused before `transport.subscribe`,
  8→8). The "no checkpoint without a decision" claim verified against
  `runtime.ts:811, :1201` and `loop.ts:1660-1690`.
- **Safety after reads (r1 MEDIUM).** The exported seam ran the registration
  SELECTs under `MAX_RUN_MODE=LIVE`; fixed and pinned.
- **Seven mutants, seven caught**, each by exactly the pin that names it
  (four cross-checks, `account_ref`, the decisions read, the safety ordering).
- Refusal ordering: SELECTs are the first statements (lazy pool, no I/O in the
  store constructor); nothing writes before the check; `in ()` unreachable
  (`config.ts:460-461` `.min(1)`).
- The census: the laundering cast reintroduced → census fails; the R8 stripper
  neutralized → self-test fails; no new evasion found.

## Gates

At tip `ac0642f` (reviewer's runs) and post-merge on `main` `0d09eb5`
(orchestrator's runs): `pnpm run test` **328 files / 7154 tests**; trader
integration **11 files / 122 tests** (candidate 118; +4 pins); `test:e2e` 6/78;
`test:replay` 3/17 (BACKTEST-1's golden unchanged, as predicted); storage-
postgres integration 14/215; control-api integration 8/77; typecheck 0; lint 0;
`check:deps` PASS 34/80. Scope: 12 files in the candidate + 6 in r1, none under
`packages/**`, `db/**`, `docs/spec/**`; no lockfile; `safety.ts`, `loop.ts`,
`trader.ts` byte-identical to base; no suppression or erasing cast added.
Paper-only controls untouched; exit codes pinned (`main.test.ts`).

## Residuals (owned)

- **Fill-link severing** (above) — Wave 3 execution-chain persistence.
- **Restart is a refusal, not a resume** — the R10 read path (Wave 3) turns
  `RUN_NOT_RESUMABLE` into a resume; until then the operator starts a new run.
- **Unchecked shared facts** — `instances.status` (a PAUSED/RETIRED instance
  with a RUNNING run passes), `default_ownership_mode`/`evaluation_priority`,
  `catalog.market_tokens`, `parameters_version`; listed in the adapter header.
- **No registration CLI** — two-step operator registration through WP-040's
  repository functions; Wave 3 operator tooling.
- **Out of grant, confirmed real, in the residual queue:** R6
  `health.loop.decisionsPersisted` counts outbox appends before the write
  (read 1 with 0 rows; ships as `trader_decisions_persisted_total`); R7 a Redis
  outage HANGS the real process (60 s+ measured; §4.2 evidenced only in-memory);
  R11 `apps/trader/README.md:144-160` and
  `test/integration/control-api/trader-health-shape.test.ts:169` (a pin that
  passes only because the caveat quotes the old phrase); the
  `createMigratedContext.close()` pool leak in `storage-postgres/src/testing`.
- **INFO:** `durable-trader-first-fill-postgres.test.ts:120` duplicates the
  `CONDITION_ID` literal `support/fixture.ts:55` now exports; the
  `strategy.configs.parameters` decimal guard vs Static Bracket's integer
  parameters tension (test header lines 147-157).

## Handoff fields

- `summary`: above.
- `files_changed`: candidate 12 files (`postgres-registration.ts` new,
  `main.ts`, `postgres-store.ts`, `health.ts`, `pipeline.ts`, the acceptance
  test new, fixture, vitest config, tsconfig, `main.test.ts`, the census test,
  `index.ts` exports); r1 6 files (listed in the row).
- `tests_run`: as under Gates; the r1 restart reproduction through the real
  `startup()` (scratch, deleted); the seven-mutant table (implementer and
  reviewer, independently).
- `assumptions`: the decisions read is issued only for runs that exist; a NULL
  `account_ref` is a mismatch against a configured account; the R3 scenario
  uses a SHADOW instance because the config door pins `environment` to PAPER.
- `deviations`: the `fill_id`/`order_id` NULL binding (behaviour change beyond
  the packet, argued and disclosed as a severing); the leak fix in the
  factoring (R12); three new refusals in r1 (non-resumable run; unsafe env at
  the seam; foreign/NULL account).
- `known_risks`: the severing; the pool leak; R7.
- `follow_up`: R10 read path; registration CLI; the unchecked facts; execution-
  chain persistence flips the NULL binding and the `execution.fills` pin.
- `commit_sha`: `7263c13`, `ac0642f`; merge `0d09eb5`.
