# TRDR-2 completion record — the `pnl_snapshots` column binding (GOV-2B B1)

**Merged:** `f3da220` (`--no-ff`, 2026-09-15). Chain on base `f41fb8d`:
`f60cc4f` (candidate) → `0f6fa58` (r1). Review arc: r1 **CHANGES REQUIRED**
(1 HIGH, 1 MEDIUM, 4 LOW, 1 INFO) → r2 **ACCEPT** (1 LOW, 2 INFO, none blocking).

## What it closes, and what it does not

**Closes B1's CAUSE.** `apps/trader/src/adapters/postgres-store.ts` inserted
`toPnlSnapshotRow`'s camelCase keys into the snake_case
`accounting.pnl_snapshots` columns behind `.values(row as never)`. Against a
real PostgreSQL 16.6 the driver answered `column "accountRef" of relation
"pnl_snapshots" does not exist`; `#contained` turns that into `UNAVAILABLE`;
`loop.ts:1523-1530` escalates it to a GLOBAL `STORE_UNAVAILABLE` halt, after
every fill. The twenty fields are now bound by column and the cast is deleted,
so the compiler checks the binding as it already did for the two sibling
inserts. Reproduced before the fix and verified after, against a real database.

**Does NOT close B1's SYMPTOM, and says so in four places.** Nothing in
`apps/trader` creates the `strategy.instances`, `strategy.runs` or
`catalog.markets` rows that every durable write references, so the assembled
trader still GLOBAL-halts — on its first **DECISION**, before any fill, because
`strategy.decisions.run_id`/`.instance_id` are NOT NULL FKs
(`0004_strategy.up.sql:260-261`) and `loop.ts:1645-1656` halts on a failed
`persistDecision`. The container test satisfies those FKs through
`createTradingChain`, a `storage-postgres/testing` fixture, so it establishes
the **column binding** and not the trader's survival. Raised as closeout
blocker **B9** and authorized as round **`BOOT-1`**.

*Why this matters beyond the bug*: a real-looking test whose fixture supplies
what production does not is the same shape of gap that let B1 ship for an entire
wave. It nearly did so twice.

## What shipped

1. **The binding**, twenty fields ↔ twenty columns, reconciled against the DDL
   as a clean bijection (every column except the three the database owns:
   `pnl_snapshot_id`, `computed_at`, `rebuilt_at`).
2. **No suppressed check traded for another.** Deleting the cast exposed that
   `PnlSnapshotRow.scope`/`environment` are typed `string` while the columns are
   unions. Rather than `as LedgerScopeValue` — B1's own class — the round
   narrows by searching the shipped enum lists, so there is **no assertion at
   all**; an out-of-list value becomes the same `UNAVAILABLE` port data
   PostgreSQL's enum rejection would produce, one step earlier and naming the
   field. The lists are pinned against the migration DDL by an existing test, so
   they cannot drift silently.
3. **The defect generalized into a guard**: an AST census over all 27 trader
   production modules — zero assertions at any query boundary, zero of any kind
   in `adapters/**` — with two orthogonal axes (relationship and position), local
   `never|any|unknown` alias expansion, `.values(…)`/`.set(…)` arguments treated
   as a query boundary however the builder was obtained, and ten scanner
   self-tests. The one laundering cast left (`main.ts:292`, outside the grant)
   was **measured** harmless (`venue: venue` typechecks clean) and registered in
   a registry that fails when the site disappears.
4. **Three tests**: a Testcontainers round trip that reads the row back and
   compares every field; a Docker-free SQL pin including a **twenty-distinct-
   sentinel positional zip**; and the census.

## What the review established that the round had missed

- **The transposition guard was blind exactly where it mattered.** The original
  fixture had `core_net_pnl == all_in_pnl` and `reward_estimate_total ==
  realized_rewards`, so swapping either pair passed **every test in the
  repository**, including the full 7,094-test suite. `core_net_pnl` vs
  `all_in_pnl` is the pair §6 invariant 14 exists to keep separate. The sentinel
  zip closes it; the reviewer then planted six further mutations — including a
  three-way rotation and the two non-measure string pairs — and all were caught.
- **The test named for B1's own shape never fired on B1's own shape.** The
  query-boundary rule was unreachable for `never`/`any` because `classify()`
  returned `laundering` first. Against the unfixed adapter that test now fails.
- **Two proven evasions closed** (a type alias hiding `never`; a staged Kysely
  chain), and **two that remain are disclosed in the file's header and pinned**
  (an alias imported from another module; an assertion bound to a variable
  before the call) — the pin means closing one forces the header to change.
- **A pre-existing false sentence corrected**: the adapter's doc claimed Kysely
  makes a nullable column's absence "checked". It does not — absence is
  *permitted*. The reviewer measured both halves: deleting `instance_id` from
  the binding compiles clean and fails 4 of 6 tests. The compiler covers column
  names and TS types; the tests carry the rest.

## Gates at the merged tip `0f6fa58`, and on `main` at `f3da220`

`typecheck`, `lint`, `check:deps` 0; `pnpm run test` **325 files / 7106 tests**
(base `f41fb8d`: 323 / 7082); `trader test:integration` **10 files / 113 tests**
(Docker); `storage-postgres test:integration` 14 / 215; `test:e2e` 6 / 75. All
re-run green on `main` after the merge. Non-vacuity with the adapter restored to
base: SQL pin **6/6 fail**, census **4/18 fail**, container test **3/3 fail** on
the real column error.

## Residuals (owned)

1. **B9 / `BOOT-1`** — the assembled durable trader still halts on its first
   decision; no bootstrap path exists. Disclosed in four places here; authorized
   as its own round.
2. **`TRDR2-R8` (LOW, undisclosed until now, one-line fix)** — `resolveTypeText`
   does not strip parentheses, so `type X = (never); value as X` evades the
   census, `eslint` and `tsc` alike. Remediation: strip balanced surrounding
   parentheses before each comparison, plus one self-test case. **Owner: the
   next round touching `test/unit/trader/**`.**
3. **Census holes, disclosed and pinned**: an alias imported from another module,
   an alias whose RHS must be evaluated, an assertion bound to a variable before
   the binding call, a builder passed to another function, and `unknown` narrowed
   by a hand-written predicate. A `ts.Program`-backed census is the only complete
   fix.
4. **`main.ts:292`'s laundering cast** remains — measured harmless, registered
   with that measurement, unscheduled. The registry fails when the site
   disappears, not when the venue drifts underneath it.
5. **The compiler pin covers column names and TS types only.** DB domain
   constraints (`non_negative_decimal_string`, `uuid_v7` version/variant CHECKs,
   `identifier`'s 1-200 bound) are invisible to TypeScript, and a missing
   nullable/defaulted column compiles. Stated in `writePnlSnapshot`'s doc.
6. **Three of the six chained integration suites now need Docker**
   (`test/integration/{postgres,event-bus,paper-trader}`). `git remote -v` is
   empty, so CI has never run. **`GATE-1`'s N5 label says two and must say
   three**, and the `Integration tests` step needs a working host Docker daemon —
   Testcontainers needs the daemon, not a `services:` block.
7. `persistDecision`, `saveCheckpoint` and `appendLedgerTransaction` remain
   typecheck-pinned with no round trip of their own (GOV-2B's R8, half
   discharged). `TRDR2-R9` (INFO): one sentence says "nothing else in the app
   writes SQL at all"; `appendLedgerTransaction` does cause SQL through WP-040's
   ledger repository — the conclusion is unaffected, the sentence should be
   narrowed. `TRDR2-R10` (INFO): eleven pre-existing paper-trader harness aliases
   have no importer.
