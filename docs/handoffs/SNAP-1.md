# SNAP-1: one PnL snapshot per instance per instant (H1 blocker `BRACKET1C-SNAPKEY`)

Branch `snap-1` on base `1ad2a36`, merged into `main` as `fff844d` (`--no-ff`) on 2026-09-28.

- **Authorization:** the user's ruling "One snapshot per instant" (2026-09-28): the trader writes one snapshot per instance per instant, holding the state after that instant's last fill, and the in-memory store enforces the same rule.
- **Process:** the HARDENING LOOP (workflow `wf_b3cf0832-acc`), run in parallel with `BUNDLE-1` on disjoint paths; verified by Codex gpt-6-astra.

| Commit | Content |
| --- | --- |
| `de867f6` | r0 |
| `4085e23` | r1: `SNAP1-R1` (HIGH), `SNAP1-R2` (MEDIUM) |
| `0d10395` | r2: `SNAP1-R3` (LOW) |
| `fff844d` | the merge |

## Outcome
- **One row per key.** The trader keeps exactly one `accounting.pnl_snapshots` row per (scope, environment, account, instance, market, `as_of`).
  - The first harvest at an instant INSERTs the row.
  - A later harvest in the same event UPDATEs that same row, which the loop identifies through its own written-keys set.
  - A distinct instant always gets its own row, and the row holds the state after the instant's LAST fill.
  - `apps/trader/src/pnl-snapshot-key.ts` keys `as_of` exactly as PostgreSQL 16.6 reads it: the year as written, PostgreSQL's rounding past six digits, and no silent roll-over of values PostgreSQL refuses.
  - A new store port replaces the row (`postgres-store.ts`); `pnl_snapshots` is a rebuildable projection and is not append-only.
- **What is unchanged.** The PnL advance, FOLD-1's rebuild checks and F3 counting keep their meaning. TRDR-3's realized-PnL book reflects the final state.
- **The in-memory store enforces the key.** `MemoryTraderStore` enforces `pnl_snapshots_scope_unique` with `nulls not distinct`, and refuses with the Postgres adapter's refusal shape. The doubles can no longer mask this class of bug.
- **Goldens.** Each was regenerated once from base bytes; the orchestrator verified every delta.
  - **Paper golden:** `pnlSnapshots` goes from 3 to 2, dropping the intermediate `09:00:02Z` entry. The kept entries are byte-identical to base's `[1]` and `[2]`.
  - **Backtest artifact:** one `pnl` line is dropped, and `store … pnlSnapshots` goes from 3 to 2.
  - **`two-brackets-run.json`:** unchanged.
- **Durable test.** New Testcontainers test `durable-two-level-entry-postgres-redis.test.ts`: an entry walking TWO ask levels in one instant, run through the real composition root, Redis and PostgreSQL. It asserts no halt, and exactly one durable snapshot at that instant, equal to the in-memory state after the second fill.
- **Ride-along.** `BRACKET1C-LOWS` L1 is pinned.

## Reviews (Codex gpt-6-astra)
- **r1 of `de867f6`: CHANGES REQUIRED.**
  - `SNAP1-R1` (HIGH): later fills at the same instant left the persisted snapshot and the realized-PnL book stale.
  - `SNAP1-R2` (MEDIUM): a distinct backwards timestamp lost its snapshot.
- **r2 of `4085e23`: CHANGES REQUIRED.**
  - `SNAP1-R3` (LOW): the key conflated distinct calendar years (`Date.UTC` reads years 0–99 as 1900–1999).
  - The fix was verified against a real PostgreSQL 16.6 across 2,148 edge cases and 20,000 random strings, with 0 mismatches.
- **r3 of `0d10395`: ACCEPT, no findings.** All three earlier findings were re-checked as fixed, and all 1,384 tracked files were restored byte for byte.

## Evidence
- **Gates at `0d10395`:**
  - typecheck, lint and check:deps: PASS;
  - unit: 347 / 7561;
  - e2e: 8 / 206 (run twice);
  - replay: 3 / 17 (run twice);
  - control-api integration: 10 / 87;
  - trader integration: 17 / 138 (run twice, with both durable files running).
- **GitHub CI:** PR #14, run `36466205761`, green.

## Residuals (queued)
- **`SNAP1-KEYSET`.** The loop's written-keys set grows without bound, one entry per snapshot instant, for the life of the process. This is a small but real regression against `TRDR-4`'s bounded loop. It is also empty after a restart, which is harmless because a restart is a new run.
- **`SNAP1-MINOR`:**
  - a replaced row keeps its first `computed_at`;
  - no health counter counts replacements;
  - the double does not refuse an `as_of` that PostgreSQL refuses, such as year 0000, which `normalizeToStrictUtc` accepts;
  - other PostgreSQL-accepted spellings key as themselves;
  - a crash between harvests;
  - unowned fills still write no virtual snapshot (pre-existing).

## commit_sha
- Implementation tip: `0d10395fea4d02d93b58092eb16f895957c43c2c`.
- Merge: `fff844d`.

# Appendix A — implementer handoff, r0 (verbatim)

# SNAP-1 — implementation handoff, round 0

## plan (written BEFORE any edit)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-snap-1`, branch `snap-1`, base `1ad2a36`,
clean. Docker `29.1.2`. Base copies + sha256 of the three goldens, `loop.ts` and `testing/index.ts`
saved under `scratchpad/snap-1/base/`.

Prerequisites verified: AGENTS.md; IMPLEMENTATION_STATUS.md rows SNAP-1 (Ready/authorized 2026-09-28,
user ruling "one snapshot per instant"), BRACKET1C-SNAPKEY, BRACKET1C-LOWS, N1 (closed by BRACKET-1b,
ratio pinned), FOLD-1, BRACKET-1c; docs/handoffs/BRACKET-1c.md (F3 / C4), FOLD-1.md; the migration's
`pnl_snapshots_scope_unique` (read only); loop.ts `#processEvent`, `#harvestFills`, `#bookUnownedFill`,
`#writePnlSnapshot`; folds.ts `advancePnl`/`completePnlState`; pnl-observation.ts; postgres-store.ts
`writePnlSnapshot` + `#contained`; testing/index.ts; health.ts; the goldens and READMEs; the BRACKET-1c
durable file and `support/two-brackets.ts`.

Read-only findings that shape the plan:

- R1. `#harvestFills` has exactly TWO call sites, both in `#processEvent` and mutually exclusive
  (the reference branch returns after its own harvest). Every event runs AT MOST ONE harvest today;
  fills from a submission made during an event's deliveries (onFill take-profit, onOrderUpdate) are
  read by the NEXT event's harvest. `#bookUnownedFill` is inside the harvest. Nothing else writes a
  snapshot.
- R2. "One instant" is NOT "one event": the loop's instant is the envelope's `receivedAt`, and the
  gateway stamps every normalized event with its own ms-precision receipt (`takeReceipt` per
  `onEvent`), so two events of one WebSocket frame routinely share an instant, and the loop does not
  require strictly increasing instants. A per-event deferral alone still GLOBAL-halts the durable
  trader when a LATER event at the same instant books a fill for an instance already written at it
  (for example a take-profit that crossed at submission, harvested by the next event of the same
  frame). The key must be guarded across harvests, not only within one.
- R3. `test/integration/paper-trader/halts-reservations-and-seams.test.ts` MEDIUM-1 pins that a PnL
  snapshot write failure latched in an iteration suppresses THAT iteration's onFill delivery. So the
  deferred write must happen at the end of the harvest's BOOKING phase, before its deliveries — not at
  the end of the event, and not lazily at the next instant (either would break that pin).
- R4. The control-api health door is `z.strictObject` all the way down (`apps/control-api/**` is
  forbidden), so no new health counter can be added this round.
- R5. The Postgres adapter maps the key violation to `UNAVAILABLE` with detail
  `the durable store could not write a PnL snapshot: error: duplicate key value violates unique
  constraint "pnl_snapshots_scope_unique"`; `as_of` is `timestamptz` (instant equality, microsecond
  resolution; PG 16 rounds sub-microsecond digits half-even — probed in a throwaway container).

Design:

1. `loop.ts`: `#writePnlSnapshot` becomes `#stagePnlSnapshot` — the SAME per-fill advance
   (`advancePnl`/`completePnlState`, so FOLD-1's checks and F3 counting are untouched), the SAME early
   returns and the SAME marks (the fill's own price), but the computed rows are STAGED per instance
   (a later fill of the same instance replaces them; staging order = order of each instance's last
   fill, which is base's write order of the kept rows). A new `#flushPnlSnapshots(instant)` writes each
   staged instance ONCE, and is called exactly once per harvest, at the end of its booking phase, on
   every exit path (normal end, both store-failure early returns, the venue-cursor refusal) — before
   the release, the basket judgement and the deliveries.
2. The key guard: the loop remembers, per instance, the `as_of` of the last snapshot it wrote. A staged
   snapshot is written only when its `as_of` is strictly LATER; otherwise (a later harvest at the same
   instant, or a receivedAt that went backwards) it is not written — the key forbids it — and stays
   OWED: the next harvest at a strictly later instant writes it re-dated to that instant (unless a
   fresh fill of the instance restaged newer rows first). Stated, pinned, and reported as a deviation
   for ratification (the ruling's "state after the LAST fill at that instant" cannot hold for the row
   at T when the first write at T must happen before T's deliveries — R3).
3. Halts: a halt latched mid-harvest does not drop the staged snapshot (the books are truthful, as base
   wrote every booked fill's row regardless of halts); a failed write at the flush latches the same
   GLOBAL `STORE_UNAVAILABLE` (same detail prefix) BEFORE the deliveries, and the failed rows are
   dropped (base never retried a failed snapshot); a ledger-store failure mid-harvest flushes the rows
   staged before it (base had written them) and then returns as before.
4. `MemoryTraderStore.writePnlSnapshot` refuses a second snapshot with the same
   (scope, environment, account_ref, instance_id, market_id, as_of), nulls not distinct, `as_of`
   compared as an instant at microsecond resolution — same `UNAVAILABLE` shape and detail as the
   Postgres adapter; nothing is pushed on refusal. Unit tests in `test/unit/trader/`.
5. Colocated loop tests (`apps/trader/src/loop-snapshots.test.ts`, new): ten fills per event → one
   row per instant equal to the last per-fill computation; two events at one instant → no second
   write, owed row written re-dated at the next later instant; halts mid-harvest (a refused posting,
   a ledger-store failure, a snapshot-store failure) with the staged row's fate pinned. Existing
   `loop-folds.test.ts` snapshot-count pins updated with their reason.
6. Goldens regenerated ONCE from verified base bytes (paper via `WP250_WRITE_GOLDEN -t "paper-e2e"`;
   backtest via the README's scratch capture probe, run twice byte-equal), with key-path diffs,
   the artifact diff, a byte-equality proof of the kept snapshot against base's last-per-instant one,
   and a numeric-multiset proof that nothing else moved. READMEs and count pins updated.
7. A new durable Testcontainers file for the two-level entry (BRACKET-1c's F3 shape: first YES ask
   `0.34 x 30`), reusing `support/two-brackets.ts` via an optional ask override; the BRACKET-1c header
   prose updated; the L1 ride-along pins (`core_net_pnl`, `gross_trading_pnl`, `capital_committed`,
   `worst_case_resolution_pnl`) added to the fixture-schedule tests with the header derivation.
8. Non-vacuity with base `loop.ts` restored (e2e halts on the duplicate; the durable two-level test
   halts `pnl_snapshots_scope_unique`), restored byte-identically; all gates, e2e/replay/trader
   integration twice. One commit.

---

## summary

SNAP-1 is implemented and committed on `snap-1` as `de867f6` (one commit on `1ad2a36`; not pushed,
no PR). All evidence is simulated execution (Tier-0 `SimulatedVenue`) over the in-memory doubles and,
for the durable file, real PostgreSQL + Redis in Testcontainers. No soak, probe or live evidence is
claimed. Every gate exits 0 at the commit; e2e, replay and trader integration were run twice.

**(1) One snapshot per instance per instant** (`apps/trader/src/loop.ts`).
- Only the WRITE moved. `#writePnlSnapshot` became `#stagePnlSnapshot`: the per-fill
  `advancePnl`/`completePnlState`, the early returns, the marks (the fill's own price) and
  `computePnlSnapshot` run exactly where and as before, so FOLD-1's per-fill checks (every-fill
  harnesses and PAPER cadence) and F3's refusal counting are untouched. The computed rows are STAGED
  per instance; a later fill of the same instance replaces them (delete + re-insert, so staging order
  is the order of each instance's last fill = base's write order of the rows it keeps). An early
  return (refused record, refused computation) replaces nothing, so the staged rows are those of the
  instance's last fill that DID compute — exactly base's last row at that instant.
- `#flushPnlSnapshots` writes each staged instance ONCE per harvest, at the end of the harvest's
  booking phase, on EVERY exit path: the normal end, the owned-fill ledger-store failure return, the
  unowned-fill store failure return and the venue-cursor refusal. That point is BEFORE the release,
  the basket judgement and all deliveries.
- Harvest sites: `#harvestFills` has exactly two call sites, both in `#processEvent`, mutually
  exclusive (the reference branch returns after its own harvest). So every event runs at most one
  harvest; fills from submissions made during an event's deliveries (onFill take-profit, onOrderUpdate)
  are read by the NEXT event's harvest. `#bookUnownedFill` is inside the harvest. Nothing else writes a
  snapshot.
- **The key guard (beyond the packet — see deviations).** One instant is not one event: the loop's
  instant is the envelope `receivedAt`, the gateway stamps every normalized event separately at ms
  precision (`takeReceipt` per `onEvent`), and the loop does not require increasing instants. So a
  LATER harvest can stage rows at an instant already written for that instance. The loop keeps, per
  instance, the `as_of` of its last WRITTEN row (`#lastSnapshotAsOfMs`, one number per instance) and
  writes a row only at an instant STRICTLY later. Rows that are not written stay staged, OWED, and the
  first later harvest at a strictly later instant writes them RE-DATED (same held state and marks,
  `computePnlSnapshot` again with the new `asOf`); a fresh fill of the instance restages newer rows
  first. Without this, the durable trader would still GLOBAL-halt one event later on a live frame.
- **Halts mid-event (stated in the `#flushPnlSnapshots` docstring and pinned):**
  - a halt latched earlier in the harvest (refused posting, projection halt, rebuild mismatch) does
    NOT stop the write — the books stay truthful, as base wrote every booked fill's row regardless of
    halts; pinned: a MARKET `LEDGER_POSTING_REFUSED` on fill 5 of 10 → the one row is the state after
    the last BOOKED fill (9 booked);
  - a ledger-store failure mid-harvest (early return) flushes the rows staged by the fills booked
    before it (base had already written them), then returns; pinned: failure at fill 15 → the row at
    that instant is the state after fill 14;
  - a failed snapshot write is the same GLOBAL `STORE_UNAVAILABLE` (`FULL_HALT`, same detail text
    "a PnL snapshot could not be persisted: …", at the harvest's instant), latched BEFORE the
    harvest's deliveries — §4.2 "a store failure halts" and the MEDIUM-1 gate hold (the integration
    MEDIUM-1 tests are unchanged and green); the failed rows are dropped, never retried (base never
    retried either); pinned, including that a later harvest after `recover()` writes nothing.
- TRDR-3's realized-PnL book sees the right final state: pinned in the new durable file (`7.3`, the
  last durable row) and still in BRACKET-1c's (`7.5`).
- Stale method-name comments updated in `folds.ts` and `pnl-observation.ts` (comments only).

**(2) `MemoryTraderStore` enforces the key** (`apps/trader/src/testing/index.ts`).
- `writePnlSnapshot` refuses a second row with the same (scope, environment, account_ref,
  instance_id, market_id, as_of), `nulls not distinct`, reading the key through `toPnlSnapshotRow`
  (own fields) exactly as the adapter binds it; `as_of` is compared as `timestamptz` (one instant
  whatever the zone/trailing zeros, microsecond resolution, sub-microsecond digits rounded
  half-to-even — what PostgreSQL 16 did on every tie probed in a throwaway `postgres:16.6-alpine`).
  Nothing is recorded on refusal. An injected outage still refuses first.
- The refusal is `portFailed("UNAVAILABLE", DUPLICATE_PNL_SNAPSHOT_DETAIL)` =
  `the durable store could not write a PnL snapshot: error: duplicate key value violates unique
  constraint "pnl_snapshots_scope_unique"` — the adapter's `#contained` shape. Pinned three ways:
  the assertions `durable-pnl-snapshot-postgres.test.ts` makes of the real adapter; `toEqual` against
  the REAL `PostgresTraderStore` driven through a stand-in Kysely handle that throws node-postgres'
  error shape; and `toEqual` against the answer of a REAL PostgreSQL in the new durable file.
- New unit file `test/unit/trader/memory-store-pnl-snapshot-key.test.ts` (7 tests).
- The masking, now caught: base `loop.ts` + the new double halts the paper-e2e run on the duplicate
  (see tests_run, non-vacuity).

**(3) Goldens**, each regenerated ONCE from verified base bytes (sha256 == `git show HEAD:` before):
- `paper-e2e-run.json` (`e762b16a…` → `6b9f6499…`) via `WP250_WRITE_GOLDEN=1 … -t "paper-e2e"`
  (that run failed on purpose; the suite then passed twice without the variable). The diff is ONE
  hunk: 27 deleted lines, the FIRST `09:00:02Z` snapshot (`capitalCommitted 10.2`, `feesPaid 0.131`,
  `coreNetPnl -0.131`, `worstCaseResolutionPnl -10.2`). Exactly the predicted delta.
- `expected-artifact.txt` (`512e246d…` → `0da3c56f…`) via the README's capture procedure (scratch
  probe `capture/capture.probe.ts`, outside the repo: `renderArtifact(await
  replayThroughShippedRoot({ withCore: true }))` twice, byte-equal, written once). `diff`:
  ```
  39d38
  < pnl scope=VIRTUAL_STRATEGY instance=019b1e00-0000-7000-8000-000000000002 asOf=2026-05-01T09:00:02Z realized=0 unrealizedMidpoint=0 fees=0.131 coreNet=-0.131 capitalCommitted=10.2
  45c44
  < store decisions=12 checkpoints=12 ledgerTransactions=9 pnlSnapshots=3
  ---
  > store decisions=12 checkpoints=12 ledgerTransactions=9 pnlSnapshots=2
  ```
  Exactly the predicted delta.
- `two-brackets-run.json`: UNCHANGED (`git diff --quiet` true; sha `49326233…`).
- (b) key-path diff of the paper golden (`golden_proof.py`, output `golden-proof-paper.txt`): 39
  moved leaf paths, ALL under `pnlSnapshots` (the removal plus the index shift of the two kept rows);
  every other top-level key — `checkpointInstants, decisions, events, fills, goldenFormatVersion,
  health, ledgerProjection, ledgerTransactions, orderProvenance, orders, pnlRecords, reconciliation,
  scenario, traces` — IDENTICAL. No health counter counts snapshots, so no counter moved; the N1 ratio
  (`pnlRecords` 12 vs array 6) is untouched.
- (c) the two kept snapshots equal base's LAST snapshot per instant, canonical bytes: `True`
  (base instants `09:00:02Z`, `09:14:49Z`; kept = base `[1]`, `[2]`). The same equality is pinned in
  code: `loop-folds.test.ts` "ten fills in one event…" holds the one row `toEqual` to the from-zero
  model's 10th per-fill row; the F3 test holds its one row to base's fill-2 row.
- (d) the numeric multiset outside `pnlSnapshots` is equal (325 values); inside `pnlSnapshots` base
  minus new is exactly the removed row's numbers `{-0.131:2, -10.2:1, 0:5, 0.131:2, 10.2:1}`.
- READMEs: `paper-e2e/README.md` gains "The `SNAP-1` regeneration" section, the PnL paragraph now
  says two snapshots (one per instant), the two-bracket paragraph says why it did not move, and a
  stale `pnlSnapshots[2]` index reference is corrected to `[1]`. `backtest/static-bracket/README.md`:
  counts `3 → 2` and a "Re-captured by `SNAP-1`" paragraph.
- Count pins updated with their reason: `test/e2e/traceability-chain.test.ts` (3 → 2, plus the two
  `as_of` values); `apps/trader/src/loop-folds.test.ts` (one row per ten-fill tick instead of one per
  fill; FOLD1-R1-1 10 → 1 twice; F3 2 → the one last row, held byte-equal to base's fill-2 row).

**(4) Durable two-level-entry test** — new `test/integration/paper-trader/durable-two-level-entry-postgres-redis.test.ts`
(2 tests), reusing `support/two-brackets.ts` through a new optional `bracket1Asks` input (default =
BRACKET-1c's events exactly) and `TWO_LEVEL_BRACKET_1_YES_ASKS` (`0.34 x 30`, `0.35 x 300` — probe F3).
Real path: WP-040 registration → `assembleDurableTrader` → `RedisStreamsEventTransport` publish →
`RedisMarketEventFeed` + `pump` → SHUTDOWN rebuild check; every durable claim a SELECT. Hand
derivation written in the header before the first run and matched on it. Asserts: no halt (first,
so a regression names its halt); 5 fills, 10 durable transactions; the instance's principal legs at
`12:00:02` are `-10.2` and `-7` (both fills booked) and both onFill evaluations ran; exactly ONE
durable row at `12:00:02`, equal column-for-column to the §9.16 row of the IN-MEMORY held state
captured right after that event (marked at the second fill's `0.35`); no row with capital `10.2`;
four rows total (`12:00:02, 12:03:06, 12:03:41, 12:04:00`) with capital `17.2, 0, 16.5, 0`,
realized `0, -1.2, -1.2, 7.3`, midpoint `0.3, 0, 0, 0`, gross = core net `0.3, -1.2, -1.2, 7.3`,
worst `-17.2, -1.2, -17.7, 7.3`; TRDR-3 book `7.3`; two `SB.CLOSED`, `SB.REARMED` at 12:03:40, final
`SB.REFUSED_MAXIMUM_ENTRIES`, final checkpoint CLOSED/2, no PAUSED/UNATTRIBUTED/ILLEGAL/MISMATCH
code, 20 decisions equal in memory and durably; and the double's duplicate refusal `toEqual` the real
database's. A contrast test runs the SystemPaperClock with one pump over the whole stream. The
BRACKET-1c file header's pending-finding paragraph is rewritten as a dated correction ("fixed");
`vitest.config.ts` gets a dated header correction (six container files). Prose only.

**(5) `BRACKET1C-LOWS` L1 ride-along** — `durable-two-brackets-postgres-redis.test.ts` now pins
`core_net_pnl`, `gross_trading_pnl`, `capital_committed` and `worst_case_resolution_pnl` per
snapshot (fixture: core net `0,-1,-1,7.5`, gross `0,-1,-1,7.5`, capital `17,0,16.5,0`, worst
`-17,-1,-17.5,7.5`; e2e-fee variant: core net `-0.219,-1.431,-1.647,6.853`, the other three as the
fixture). Re-derived in the header (each row marked at its own fill's price, so an open lot's
midpoint PnL is 0; gross = realized + midpoint; core = gross − fees; worst = realized − open basis);
they equal the reviewer's values. Existing assertions unchanged.

## files_changed

- `apps/trader/src/loop.ts` — staged snapshot write, the key guard, `#flushPnlSnapshots`,
  `#writeSnapshotRows`.
- `apps/trader/src/testing/index.ts` — `MemoryTraderStore` enforces `pnl_snapshots_scope_unique`;
  exports `PNL_SNAPSHOT_SCOPE_UNIQUE`, `DUPLICATE_PNL_SNAPSHOT_DETAIL`.
- `apps/trader/src/folds.ts`, `apps/trader/src/pnl-observation.ts` — comments only (method rename).
- `apps/trader/src/loop-folds.test.ts` — count pins updated with reasons; `tick(harness, at?)`;
  two new `SNAP-1` describe blocks (6 tests).
- `test/unit/trader/memory-store-pnl-snapshot-key.test.ts` — new (7 tests).
- `test/e2e/traceability-chain.test.ts` — snapshot count 3 → 2 with its reason and the `as_of`s.
- `test/replay-golden/paper-e2e/paper-e2e-run.json` — regenerated (first 09:00:02Z row removed).
- `test/replay-golden/paper-e2e/README.md` — SNAP-1 regeneration section and prose.
- `test/replay-golden/backtest/static-bracket/expected-artifact.txt` — captured (line 39 gone;
  `pnlSnapshots=2`).
- `test/replay-golden/backtest/static-bracket/README.md` — counts and the re-capture paragraph.
- `test/integration/paper-trader/durable-two-level-entry-postgres-redis.test.ts` — new (2 tests).
- `test/integration/paper-trader/support/two-brackets.ts` — optional `bracket1Asks`,
  `TWO_LEVEL_BRACKET_1_YES_ASKS`, `Level` exported, header note.
- `test/integration/paper-trader/durable-two-brackets-postgres-redis.test.ts` — header prose (the
  finding, fixed) and the L1 pins.
- `test/integration/paper-trader/vitest.config.ts` — dated header correction (prose only).

Untouched: `packages/**`, `db/**`, `docs/**`, `apps/trader/package.json`, `apps/trader/src/main.ts`,
every other `apps/**`, the backtest fixture inputs, `test/replay-golden/{order-book,simulation}/**`,
`two-brackets-run.json`, lockfile, root `package.json`, eslint/tsconfig, `.github/**`.

## tests_run

All outside any sandbox, Docker 29.1.2, cached images. Logs under
`scratchpad/snap-1/gates/` and `scratchpad/snap-1/nonvacuity/`.

**Gates at the committed tree** (loop.ts sha `817c6515…` = HEAD):

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 (run twice; the second after the last comment edit) |
| `pnpm run lint` | exit 0 (twice, same) |
| `pnpm run check:deps` | exit 0, PASS, 34 packages / 80 edges (twice) |
| `pnpm run test` | **346 files / 7542 tests**, exit 0 (base 345 / 7529: +1 file, +13 tests) |
| `pnpm run test:e2e` | **8 / 206**, exit 0, run twice |
| `pnpm run test:replay` | **3 / 17**, exit 0, run twice |
| `pnpm --filter @polymarket-bot/control-api test:integration` | **10 / 87**, exit 0 |
| `pnpm --filter @polymarket-bot/trader test:integration` | **17 / 137**, exit 0, run twice (base 16 / 135 + 1 file / 2 tests) |

Before the new durable file existed, trader integration with the new loop and double was also run
once: 16 / 135, exit 0.

**New tests (15):**
- `test/unit/trader/memory-store-pnl-snapshot-key.test.ts` — "SNAP-1: MemoryTraderStore enforces
  pnl_snapshots_scope_unique": (1) refuses a second row of one identity with the adapter's own
  UNAVAILABLE port data, and records nothing; (2) answers EXACTLY what the real PostgresTraderStore
  answers for the driver's refusal; (3) keys on exactly the six constraint columns; (4) run_id,
  denomination_asset and the economic columns are NOT in the key; (5) nulls NOT distinct; (6) as_of
  compared as timestamptz; (7) an injected outage refuses FIRST and records nothing.
- `apps/trader/src/loop-folds.test.ts` — "SNAP-1: one PnL snapshot per instance per instant — the
  database's key, in the loop": (8) ten fills in one event write ONE row: base's LAST per-fill row,
  byte for byte, per-fill checks unchanged; (9) a SECOND event at the same instant: no second row, no
  halt, the later state written re-dated at the next later instant; (10) a receivedAt that goes
  BACKWARDS. "SNAP-1: a halt latched mid-harvest, and the staged row": (11) a REFUSED posting
  mid-harvest; (12) a LEDGER-STORE failure mid-harvest; (13) a SNAPSHOT-store failure at the flush.
- `test/integration/paper-trader/durable-two-level-entry-postgres-redis.test.ts` — "SNAP-1: an entry
  that walks two ask levels in one instant, durably, …": (14) event-time clock, one event per pump;
  (15) the process's own SystemPaperClock and ONE pump over the whole stream.

**Non-vacuity** (base `apps/trader/src/loop.ts` from `git show HEAD:` = sha `127ab9da…`, with the NEW
`MemoryTraderStore`; restored afterwards to sha `817c6515…`, identical to before the swap and to the
committed blob):
- `pnpm run test:e2e`: **21 failed / 185 passed**, 6 of 8 files fail; the halt is GLOBAL
  `STORE_UNAVAILABLE` "a PnL snapshot could not be persisted: the durable store could not write a PnL
  snapshot: error: duplicate key value violates unique constraint \"pnl_snapshots_scope_unique\"".
  Failing tests: determinism-golden "paper-e2e > a run is byte-identical to the committed golden";
  projection-reconciliation ×4 ("every row is explained…", "every difference that is NOT zero…",
  "the projection with NO realized value…", "the ROUND TRIP reconciles…"); reconciliation-attribution
  ×3 ("RISK2-R4 … all 24 array orders…", "RECON-1 r1 … a partial exit (25 of 50)…", "RECON-1 r1 … an
  uneven split…"); residuals-observed ×5 (residual 2 ×3, residual 5 ×2); traceability-chain ×6
  ("the run trades a ROUND TRIP…", "every hop resolves by id, in every chain…", "every booked order's
  origin resolves by id…", "the chain is anchored in the RECORDED event…", "the two ends of the chain
  agree on the money…", "§6 invariant 8…"); two-brackets ×2 ("scope by instanceId: a SHADOW
  observer's…", "SIM2-E2E-MSG … evicted venue history…").
- The new durable two-level file: **2 / 2 fail**, each with halt `{scope GLOBAL, code
  STORE_UNAVAILABLE, at "2026-03-04T12:00:02Z", detail "a PnL snapshot could not be persisted: the
  durable store could not write a PnL snapshot: error: duplicate key value violates unique constraint
  \"pnl_snapshots_scope_unique\""}` — the real PostgreSQL's words, equal to the double's.
- `loop-folds.test.ts -t "SNAP-1|F3|FOLD1-R1-1"`: 8 fail / 2 pass (5 of the 6 SNAP-1 tests fail; the
  snapshot-store-failure test passes at base by design — it pins preserved §4.2 behaviour; one
  FOLD1-R1-1 test is count-free and passes).
- Also observed: a full `apps/trader/src` + `test/unit/trader` run at base loop with the new double
  shows further masked multi-fill instants (order-provenance, SIM-1 R3, SIM1-R2-1 tests fail); that
  run hit my 900 s timeout (exit 124, a long-run test spins once halted) and is NOT claimed as a count.
- Mutations of the new loop (`nonvacuity/mutations.py`, each restored, sha re-checked `817c6515…`):
  M1 no key guard → 2 SNAP-1 tests fail (same-instant, backwards); M2 flush after the deliveries →
  the snapshot-store-failure test fails AND the integration MEDIUM-1 pair (2 tests) fails; M3 no flush
  on the ledger-store early return → the ledger-store test fails; M5 keep the FIRST fill's rows
  instead of the last → 6 fail (F3 + 5 SNAP-1). All killed.

**Probe of the observed decisions** (a temporary `console.log` in the new durable file, restored to
the saved copy with identical sha `bd600872…` before later edits): 20 decisions; the entry's two
onFill evaluations (`SB.TAKE_PROFIT_INTENT`, then `SB.AWAITING_CANCEL_CONFIRMATION`); TP withdrawn at
12:03:05; reduce at 12:03:06 — now pinned.

## assumptions

- "One instant" means the loop's instant (the envelope `receivedAt`, strict UTC), which is also the
  `as_of` the loop writes. Instants are canonical ms-precision strings, so `Date.parse` is exact.
- The kept row "equal byte for byte to today's last per-fill snapshot" is checked on the canonical
  JSON of the golden's rows and by `toEqual` against the from-zero model in unit tests (the model is
  base's exact computation).
- node-postgres names its `DatabaseError` `error`; confirmed by BRACKET-1c's recorded halt and by
  the new durable file's real-database comparison.
- Test-owned pieces in the new durable file are BRACKET-1c's (ManualClock, a feed wrapper), and the
  fixture's ingested envelopes stand in for gateway-normalized ones, as in BRACKET-1c.

## deviations

1. **The key guard across harvests is beyond the packet's per-event framing.** The packet scoped the
   deferral to one event ("however many harvests the event runs"). Every event runs at most one
   harvest today, but two EVENTS routinely share one `receivedAt` (the gateway stamps each event of a
   frame separately at ms precision), so per-event deferral alone would still GLOBAL-halt the durable
   trader when a later event at the same instant books a fill for the same instance (e.g. a
   take-profit that crossed at submission, harvested by the next event of the same frame). I added the
   strictly-later guard with OWED rows re-dated to the next later instant. **Consequence, needs
   ratification:** in that case the row at the earlier instant T holds the state after its FIRST
   harvest's last fill, not after the last fill at T; the later state lands at the next instant any
   event is processed at (a row at an instant where that instance had no fill). The ruling's second
   half cannot hold for that row without either an upsert (option (b), not chosen) or a write deferred
   past the harvest's deliveries, which breaks §4.2's MEDIUM-1 gate (measured: mutation M2). With
   receivedAt going backwards, rows at an as_of not strictly later than the last written one are also
   owed rather than written out of order (base would have written them). Alternatives if not
   ratified: skip-and-wait-for-the-next-fill (simpler, the durable state can lag indefinitely) or a
   ruling for an upsert.
2. **No health counter for owed rows.** The control-api strict door (`z.strictObject` throughout,
   `apps/control-api/**` forbidden) rejects any new trader health field, so the owed path is visible
   only through the store and the tests.
3. The packet asked for the two-level test "reusing support/two-brackets.ts if clean": done with an
   optional parameter (default = BRACKET-1c's events), plus exporting the `Level` type; the new test
   lives in its own file with a compact runner rather than inside BRACKET-1c's file.
4. The new durable file also runs a one-pump SystemPaperClock contrast (not asked; mirrors
   BRACKET-1c).
5. `vitest.config.ts` header, `folds.ts` and `pnl-observation.ts` comments were edited (prose only)
   because they named the renamed method or the container-file count.

## known_risks

- **Owed rows at the end of a run are not written.** If two events share the LAST instant of a run
  and both book fills for one instance, the second harvest's state stays owed; nothing flushes it at
  SHUTDOWN (`checkAccountingRebuild` is synchronous; `main.ts` is BUNDLE-1's). The durable last row
  and the TRDR-3 book then lag the in-memory state until restart. Not reachable in any committed
  scenario.
- The row at an instant shared by two events holds the first harvest's state (deviation 1).
- The write order of kept rows across SEVERAL instances in one harvest (order of each instance's last
  fill) is argued, not pinned: every fixture has one instance per harvest.
- `computePnlSnapshot` can return one row per denomination, and `denomination_asset` is not in the
  key: a multi-denomination instance would collide with itself (pre-existing, not reachable with one
  pUSD denomination). The double now refuses it exactly as the database would.
- Halt ORDER can differ from base in combined failures: a MARKET halt latched by a later fill of the
  same harvest now precedes the flush's GLOBAL `STORE_UNAVAILABLE` (base latched the snapshot failure
  first). Each scope's first record is unchanged in kind.
- The double's sub-microsecond rounding is exact half-to-even on the decimal digits; PostgreSQL parses
  via a double and may differ on rare ties. The loop never writes sub-millisecond instants.
- Other `apps/**` READMEs were not searched beyond `apps/trader`; `apps/trader/README.md` has no
  per-fill-snapshot sentence (grep), and `docs/**` (BRACKET-1c handoff, STATUS) still describe the
  finding as pending — the orchestrator's record.

## follow_up

- Orchestrator/user: ratify or replace deviation 1 (owed rows re-dated to the next later instant).
- A future `apps/control-api` round could add an owed-row counter to the health surface; a future
  `main.ts` round (after BUNDLE-1) could flush owed rows at SHUTDOWN (it would still need a later
  instant, so a ruling on the shutdown `as_of`).
- Record the closure of `BRACKET1C-SNAPKEY` and `BR1C-R1-L1` in `IMPLEMENTATION_STATUS.md` and the
  BRACKET-1c handoff (docs are orchestrator-owned).
- A green GitHub CI run is still owed; the orchestrator opens the PR.

## commit_sha

`de867f6145378db0f4b8cac5bed5e0c946498a4e` (branch `snap-1`, base `1ad2a36`; not pushed).

# Appendix B — implementer handoff, r1 (verbatim)

# SNAP-1 — remediation handoff, round 1

## plan (written BEFORE any edit)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-snap-1`, branch `snap-1`, HEAD
`de867f6` (clean). Docker `29.1.2`. Read: `codex-r1.out` (SNAP1-R1 HIGH, SNAP1-R2 MEDIUM, no LOWs,
no scope violations), `gates-r1.txt` (all gates green), `handoff-r0.md`, the SNAP-1 / BRACKET1C-*
rows, BRACKET-1c.md's option list ((a) loop writes one per instant after the last fill — CHOSEN;
(b) the adapter upserts or skips on the key — not chosen; (c) a per-fill discriminator — not chosen).

Facts that decide the design:

- F1. `accounting.pnl_snapshots` is NOT append-only (no `internal.enforce_append_only` call, unlike
  `reward_payouts` right above it); it is the "rebuildable reporting projection". An UPDATE of a row
  needs no migration.
- F2. §4.2 / MEDIUM-1 (`halts-reservations-and-seams.test.ts`) pins that a failed snapshot write
  latches its GLOBAL halt BEFORE that harvest's `onFill` delivery. So the write for the fills of a
  harvest must happen before that harvest's deliveries — a write deferred until the instant
  "closes" (the next event at another instant, or shutdown) would break MEDIUM-1 (r0 measured it
  as mutation M2), and a terminal flush would need `main.ts` (BUNDLE-1's).
- F3. Two harvests can share an instant (two events with one `receivedAt`; R1), and instants can go
  backwards (R2). With a write-once row, the row at T can hold "the state after the LAST fill at T"
  only if a later harvest at T can bring the row up to date. That is the one missing capability.

Design (replaces r0's strictly-later guard, OWED rows and re-dating, all of which go):

1. Port (`apps/trader/src/ports.ts`): `TraderStore.replacePnlSnapshot(snapshot)` — rewrite the ONE
   existing row at the snapshot's `pnl_snapshots_scope_unique` identity; refuse when there is none.
   `writePnlSnapshot` is unchanged and still REFUSES a duplicate (packet item 2 intact). This is
   not option (b): the adapter never decides; the LOOP calls replace only for an identity it
   inserted itself in an EARLIER harvest of this process.
2. Loop (`loop.ts`): staging per harvest as r0 (per-fill advance/checks/marks untouched), flushed
   once per harvest before its deliveries on every exit path (as r0). At the flush, each staged row
   whose identity this process inserted in an earlier flush is REPLACED; every other row is
   INSERTED (and its identity remembered). No owed rows, no re-dating, no ordering assumption:
   distinct instants (backwards or not) get their own row (R2); a later harvest at an instant brings
   that row to the state after the last fill at it (R1), terminal runs included (nothing is ever
   pending after a harvest). Two rows of ONE computation that share an identity (multi-denomination,
   pre-existing, unreachable) still go to `writePnlSnapshot` and are refused as before — never a
   silent overwrite. A failed insert or replace is the same GLOBAL `STORE_UNAVAILABLE` before the
   deliveries.
3. `adapters/postgres-store.ts`: `replacePnlSnapshot` = one Kysely UPDATE of the 14 bound non-key
   columns (the three DB-owned columns untouched), WHERE the six key columns (`is null` for a null
   instance/market), `numUpdatedRows !== 1n` → thrown → `#contained` → `UNAVAILABLE`.
4. `testing/index.ts`: `MemoryTraderStore.replacePnlSnapshot` in place (same array position, like a
   row keeping its id), the adapter's exact refusal for a missing identity, injectable as
   `"replacePnlSnapshot"`, a `pnlSnapshotReplacements` counter. The identity function moves to a
   production module (`pnl-snapshot-key.ts`) so the loop and the double use ONE definition.
5. `pnl-observation.ts`: forwards `replacePnlSnapshot` and records its realized PnL on `ok` (so the
   TRDR-3 book follows the replaced row). `health.ts` prose.
6. `test/integration/paper-trader/acceptance-1-max-run-mode.test.ts`: its literal `TraderStore`
   stub gains the one method (compile-forced; disclosed).
7. Pins (each must FAIL at `de867f6`):
   - `loop-folds.test.ts`: r0's two stale tests replaced by contract tests — two events at one
     instant (row = the from-zero last-fill row after all 20 fills, one row, the observed TRDR-3
     book = final realized, SHUTDOWN rebuild matched, and a TERMINAL variant with no later event);
     backwards instants (each instant keeps its own row); the verifier's onFill-exit shape if the
     harness allows; a replace failure halts before that harvest's deliveries.
   - unit: the double's replace (in place, missing identity refused with the adapter's exact data,
     held `toEqual` to the real adapter via a stand-in handle); the UPDATE's emitted SQL (SET/WHERE
     column sets, distinct-sentinel zip, DB-owned columns untouched); the decorator records a
     replace.
   - durable (new test in `durable-two-level-entry-postgres-redis.test.ts`): bracket 2's take-profit
     trade stamped at bracket 2's entry instant `12:03:41` — two harvests at one instant through the
     real path; the `12:03:41` row must be the final state (realized `7.3`, capital `0`), three rows,
     TRDR-3 book `7.3`, no halt; plus the real database's refusal of a replace with no row, compared
     with the double's.
8. Goldens: expected UNCHANGED from `de867f6` (every golden instant has one harvest); verified with
   `git diff --quiet` after e2e/replay without write variables.
9. Non-vacuity against `de867f6` (its `loop.ts` restored, byte-identical restore), all gates, e2e /
   replay / trader integration twice. One commit on top of `de867f6`.

Deviation to be ratified: an instant touched by two harvests is written as an INSERT then a
REPLACE (two statements, one row). The ruling's "one snapshot per key, holding the last fill's
state" and §4.2's MEDIUM-1 gate cannot both hold otherwise.

---

## summary

`SNAP-1` round-1 remediation is committed on `snap-1` as `4085e23` (ONE commit on top of `de867f6`;
not pushed, no PR). All evidence is simulated execution (Tier-0 `SimulatedVenue`), over the in-memory
doubles and, for the durable file, a real PostgreSQL and Redis in Testcontainers. No soak, probe or
live evidence is claimed. Every acceptance gate exits 0 at the commit. e2e, replay and trader
integration were each run twice.

**Finding table**

| Finding | Severity | Disposition | Pins (each FAILS at `de867f6`, passes at `4085e23`) |
| --- | --- | --- | --- |
| SNAP1-R1: later fills at the same instant leave the persisted snapshot and the realized-PnL book stale | HIGH | **FIXED** | `loop-folds.test.ts` "a SECOND event at the same instant books ten more fills: the instant's ONE row is REPLACED …(SNAP1-R1)"; "an exit submitted from onFill fills at submission and is harvested by a LATER event at the SAME instant …(the reviewer's second shape, SNAP1-R1)"; "a REPLACEMENT the store refuses: the same GLOBAL STORE_UNAVAILABLE, latched BEFORE that harvest's deliveries …(SNAP1-R1)"; durable `durable-two-level-entry-postgres-redis.test.ts` "SNAP1-R1: TWO harvests at one instant — bracket 2's entry and its take-profit's fill, both at 12:03:41, the run ending there — …"; plus the port pins (double, UPDATE SQL, decorator) listed under tests_run |
| SNAP1-R2: a distinct backwards timestamp loses its snapshot | MEDIUM | **FIXED** | `loop-folds.test.ts` "instants that go BACKWARDS and come back: each distinct instant keeps its OWN row, at its own as_of; a revisited instant's row is replaced (SNAP1-R2)" |

There were no LOW findings and no scope violations in round 1. No finding is argued.

**What changed, and why this design.** Three facts decide it:
- **F1.** `accounting.pnl_snapshots` is NOT append-only. It is the "rebuildable reporting projection":
  there is no `internal.enforce_append_only` call (unlike `reward_payouts` just above it), and
  `AccountingPnlSnapshotsTable` is not an `AppendOnlyTable`. So an UPDATE of a row needs no migration.
- **F2.** §4.2's MEDIUM-1 gate (`halts-reservations-and-seams.test.ts`) requires that a failed snapshot
  write halts BEFORE that harvest's `onFill`. So the write cannot be deferred until an instant
  "closes". Such a deferral also could not cover the end of a run without `main.ts`, which belongs to
  BUNDLE-1.
- **F3.** Two harvests can share an instant (R1), and instants can go backwards (R2). A write-once row
  at T can hold "the state after the LAST fill at T" only if a later harvest at T can bring it up to
  date.

So:
- **The port** (`apps/trader/src/ports.ts`) gains `TraderStore.replacePnlSnapshot(snapshot)`. It
  rewrites the ONE existing row of the snapshot's `pnl_snapshots_scope_unique` identity, and REFUSES
  when there is none; it never inserts. `writePnlSnapshot` is unchanged and still refuses a duplicate,
  so packet item 2 is intact.
- **The loop** (`apps/trader/src/loop.ts`). Staging per harvest and the per-fill
  advance/checks/marks are exactly as in r0. The rows are flushed once per harvest, before its
  deliveries, on every path that could have booked a fill. At the flush:
  - a row whose identity this process INSERTED in an earlier flush is REPLACED;
  - any other row is INSERTED and its identity remembered (`#writtenSnapshotKeys`).

  r0's strictly-later guard, OWED rows and re-dating are removed. So:
  - every distinct instant, backwards or not, gets its own row (R2);
  - a later harvest at an instant brings that row to the state after its last fill (R1);
  - nothing is ever pending when a harvest returns, so the end of a run needs no flush;
  - two rows of ONE computation sharing an identity (the multi-denomination case: pre-existing and
    unreachable) still go to `writePnlSnapshot` and are refused, never silently overwritten.
- **One definition of the identity.** It moved to a production module,
  `apps/trader/src/pnl-snapshot-key.ts` (`pnlSnapshotKey`, `PNL_SNAPSHOT_SCOPE_UNIQUE`,
  `unreplacedPnlSnapshotProblem`), used by both the loop and `MemoryTraderStore`. Its semantics are
  unchanged from r0.
- **`PostgresTraderStore.replacePnlSnapshot`** is one Kysely UPDATE:
  - SET covers the 14 bound non-key columns, from the same `toPnlSnapshotRow` as the insert;
  - WHERE covers the 6 key columns, with `is null` for an absent instance or market (`nulls not
    distinct`);
  - the three DB-owned columns are untouched, so the row keeps its id and its first `computed_at`;
  - `numUpdatedRows !== 1n` → throw → `#contained` → `UNAVAILABLE`.
- **`MemoryTraderStore.replacePnlSnapshot`** rewrites the row in place (same array position),
  returns the adapter's exact refusal for a missing identity (`MISSING_PNL_SNAPSHOT_DETAIL`), can be
  failed by name (`"replacePnlSnapshot"`), and exposes a `pnlSnapshotReplacements` counter. The
  class's doc comment, which r0 had placed above the `TraderStoreWrite` alias, is back on the class.
- **`observeRealizedPnl`** forwards `replacePnlSnapshot` and records its realized PnL only on `ok`, so
  the TRDR-3 book follows the replaced row. Prose updated in `health.ts` and in the adapter header.

**The contract, measured.** The reviewer's R1 shape now gives one row, with:

| Value | `de867f6` served | Required | `4085e23` serves |
| --- | ---: | ---: | ---: |
| realized PnL | `0` | `-1` | `-1` |
| capital committed | `17` | `0` | `0` |
| fees paid | `0.22` | `0.43` | `0.43` |
| core net PnL | `-0.22` | `-1.43` | `-1.43` |
| TRDR-3 book | `0` | `-1` | `-1` |

The row is equal to the from-zero model's 20th per-fill row, byte for byte (`toEqual`). There is no
later event, no halt, and the SHUTDOWN rebuild matches. The reviewer's backwards shape
(`.500` BUY, then `.400` SELL) now gives two rows, one per instant, each holding its own last-fill
state; a later return to `.500` replaces that row.

**Halts mid-event** (docstring of `#flushPnlSnapshots`, pinned):
- A halt latched earlier in the harvest does not stop the write.
- A ledger-store failure flushes what was staged before it (unchanged from r0).
- A refused insert OR replacement is the same GLOBAL `STORE_UNAVAILABLE`, with the detail
  "a PnL snapshot could not be persisted: …", latched before that harvest's deliveries. So §4.2 "a
  store failure halts" and MEDIUM-1 hold for a replacement too (pinned).
- After a refused replacement, the earlier row stays; after a refused insert, the identity stays
  unwritten.

**Goldens: UNCHANGED from `de867f6`**, byte for byte. Every golden instant has a single harvest, so
r0's evidence (a)–(d) stands as recorded in `handoff-r0.md`:
- `paper-e2e-run.json`: `6b9f6499…`;
- `two-brackets-run.json`: `49326233…`, also identical to base `1ad2a36`;
- `expected-artifact.txt`: `0da3c56f…`.

These were checked with `git diff --quiet de867f6 -- <file>` after e2e and replay ran twice with no
write variable. Only `paper-e2e/README.md` prose moved (one clause on replacement).

## files_changed

(vs `de867f6`; 16 files: 14 modified, 2 new)
- `apps/trader/src/pnl-snapshot-key.ts` (NEW): the single identity definition and the replacement-refusal text.
- `apps/trader/src/ports.ts`: `replacePnlSnapshot` on `TraderStore`, and a doc on `writePnlSnapshot`.
- `apps/trader/src/loop.ts`: insert-or-replace flush; `#writtenSnapshotKeys`; r0's owed/re-dating/guard removed; staging holds rows only; base's marks literal restored.
- `apps/trader/src/adapters/postgres-store.ts`: `replacePnlSnapshot` (one UPDATE on the key); header note.
- `apps/trader/src/testing/index.ts`: `MemoryTraderStore.replacePnlSnapshot`, `MISSING_PNL_SNAPSHOT_DETAIL`, `pnlSnapshotReplacements`, `TraderStoreWrite` + `"replacePnlSnapshot"`; identity imported from the new module (re-exports `PNL_SNAPSHOT_SCOPE_UNIQUE`).
- `apps/trader/src/pnl-observation.ts`: forwards and records `replacePnlSnapshot`; prose.
- `apps/trader/src/health.ts`: prose only.
- `apps/trader/src/loop-folds.test.ts`: harness options `observe` / `strategy` (both default off); r0's two stale tests replaced by four contract tests; `exitsOnFill` strategy double; `closing(at?)`; header prose.
- `test/unit/trader/pnl-snapshot-replace-binding.test.ts` (NEW, 7 tests).
- `test/unit/trader/memory-store-pnl-snapshot-key.test.ts`: +4 tests, header.
- `test/unit/trader/health-realized-pnl.test.ts`: +1 test.
- `test/integration/paper-trader/durable-two-level-entry-postgres-redis.test.ts`: the shared-instant shape, +1 test, header prose.
- `test/integration/paper-trader/acceptance-1-max-run-mode.test.ts`: its literal `TraderStore` stub gains `replacePnlSnapshot` (compile-forced; one line).
- `test/integration/paper-trader/durable-two-brackets-postgres-redis.test.ts`: header prose only (assertions unchanged).
- `test/integration/paper-trader/vitest.config.ts`: header prose only.
- `test/replay-golden/paper-e2e/README.md`: one clause of prose.

Untouched: `packages/**`, `db/**`, `docs/**`, `apps/trader/package.json`, `apps/trader/src/main.ts`, every
other `apps/**`, the goldens' data files, `test/replay-golden/{order-book,simulation}/**`, the lockfile,
root `package.json`, `eslint.config.mjs`, `tsconfig*.json` and `.github/**`. This was checked with
`git diff --quiet` against both `de867f6` and `1ad2a36`. The diff adds no `eslint-disable`,
`ts-ignore`, `.skip` or `.only`, and touches no safety default.

## tests_run

All runs were outside any sandbox, on Docker 29.1.2, with every pnpm command prefixed by
`pnpm_config_verify_deps_before_run=false`. Logs are in `scratchpad/snap-1/r1/`.

**Gates at the committed tree:**

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 (run twice; the second after the last prose edit) |
| `pnpm run lint` | exit 0 (twice) |
| `pnpm run check:deps` | exit 0, PASS, 34 packages / 80 edges (twice) |
| `pnpm run test` | **347 files / 7556 tests**, exit 0 (r0 346 / 7542; base 345 / 7529) |
| `pnpm run test:e2e` | **8 / 206**, exit 0, run twice |
| `pnpm run test:replay` | **3 / 17**, exit 0, run twice |
| `pnpm --filter @polymarket-bot/control-api test:integration` | **10 / 87**, exit 0 |
| `pnpm --filter @polymarket-bot/trader test:integration` | **17 / 138**, exit 0, run twice; `durable-two-level-entry-postgres-redis.test.ts (3 tests)` ran each time (8394 ms, 7932 ms), not skipped |

The last edit after the full unit run was a comment in a `test/integration/**` file.
`test/vitest.config.ts` excludes that tree, and typecheck, lint, e2e ×2, replay ×2 and both
integration suites all ran after that edit.

**Tests new in r1 (17):**
- `apps/trader/src/loop-folds.test.ts`:
  - "a SECOND event at the same instant books ten more fills: the instant's ONE row is REPLACED with the state after the LAST (20th) fill; the TRDR-3 book reads it; nothing is pending when the run ends there (SNAP1-R1)";
  - "an exit submitted from onFill fills at submission and is harvested by a LATER event at the SAME instant: the instant's row is replaced with the state after that exit (the reviewer's second shape, SNAP1-R1)";
  - "instants that go BACKWARDS and come back: each distinct instant keeps its OWN row, at its own as_of; a revisited instant's row is replaced (SNAP1-R2)";
  - "a REPLACEMENT the store refuses: the same GLOBAL STORE_UNAVAILABLE, latched BEFORE that harvest's deliveries; the row keeps the earlier state and the TRDR-3 book does not move (SNAP1-R1)".
  - REMOVED: r0's two tests that asserted the stale/re-dated rows ("… the later state is written at the next later instant, re-dated" and "a receivedAt that goes BACKWARDS: … owed, not written out of order"). The reviewer named them as institutionalising R1/R2.
- `test/unit/trader/memory-store-pnl-snapshot-key.test.ts`, block "SNAP-1 r1: MemoryTraderStore.replacePnlSnapshot rewrites the ONE row of an identity, in place — never inserts":
  - "rewrites the recorded row IN PLACE: same position, same count, the new snapshot's values; and counts the replacement";
  - "matches by the SAME identity as the insert: another timestamptz spelling and NULL ids match; a differing key column does not";
  - "REFUSES a missing identity with the adapter's own UNAVAILABLE port data and inserts nothing in its place";
  - "its failure is injectable BY NAME: failOnly(['replacePnlSnapshot']) refuses it and leaves inserts up; fail() takes it down too".
- `test/unit/trader/pnl-snapshot-replace-binding.test.ts` (NEW). The statement is captured through the real `createDatabase` over a pool stand-in:
  - "names the fourteen SET columns and the six WHERE columns, in order, and nothing else";
  - "binds each column its OWN field: twenty distinct sentinels, so no transposition can pass";
  - "SET ∪ WHERE is exactly the insert's twenty columns; the three the database owns are touched by neither";
  - "an absent instance or market is matched with IS NULL (the constraint is nulls not distinct), never `= NULL`";
  - "an UPDATE that matches NO row is REFUSED (UNAVAILABLE, nothing else issued), and the in-memory double answers EXACTLY the same port data";
  - "any count but exactly one is refused, naming the count";
  - "refuses a scope or an environment the column's enumeration does not have, before any statement".
- `test/unit/trader/health-realized-pnl.test.ts`:
  - "SNAP-1 r1: a REPLACED row is recorded on the same terms — after the store's ok, never on a refusal".
- `test/integration/paper-trader/durable-two-level-entry-postgres-redis.test.ts`:
  - "SNAP1-R1: TWO harvests at one instant — bracket 2's entry and its take-profit's fill, both at 12:03:41, the run ending there — leave ONE durable row at 12:03:41 holding the state after the LAST fill, replaced in place; the TRDR-3 book reads it".
  - Its path is real: WP-040 registration → `assembleDurableTrader` → Redis stream → `RedisMarketEventFeed` + `pump` → PostgreSQL. It asserts:
    - no halt; 5 fills and 10 transactions;
    - the durable `12:03:41` row read right after the entry (capital 16.5, realized −1.2, worst −17.7);
    - at the end, three rows (`12:00:02`, `12:03:06`, `12:03:41`), the last with the SAME `pnl_snapshot_id` and `computed_at` (an UPDATE), holding capital 0 and realized = gross = core = worst 7.3, equal column for column to the in-memory held state after the take-profit's fill;
    - the TRDR-3 book reads 7.3; bracket 2 CLOSED at 12:03:41; final checkpoint CLOSED/2;
    - the REAL database refuses a replacement with no row, with exactly the double's port data, and inserts nothing.

**Non-vacuity against `de867f6`** (script `r1/nv/nv.sh`). The r1 files were saved with sha256 first,
and each swap was restored and checked with `sha256sum -c`: all OK for NV1, NV2 and M1–M6. The
worktree was unchanged afterwards.
- **NV1.** `de867f6`'s `apps/trader/src/loop.ts`, with every other r1 file:
  - `loop-folds.test.ts -t "SNAP-1|F3"`: **4 failed / 5 passed**. The four new loop pins fail; F3, the ten-fill test and r0's three halt tests pass, as they should.
  - The durable file: **1 failed / 2 passed**. The shared-instant test fails with no halt: `capital_committed` expected `"0"`, received `"16.5"`, so `de867f6` left the `12:03:41` row at the entry's state.
- **NV2.** `de867f6`'s `testing/index.ts`, `adapters/postgres-store.ts` and `pnl-observation.ts`, with the r1 loop: the three unit files give **12 failed / 14 passed**. Every new port pin fails.
- **Mutations of r1** (each killed by an assertion, not by a syntax error):
  - M1 never replace (always insert): 4 loop pins fail, and the double's duplicate refusal halts GLOBAL, so the double catches the masking.
  - M2 flush moved after the deliveries: 2 fail (r0's snapshot-store-failure test and the new refused-replacement test: `onFill` delivered).
  - M3 decorator does not record a replacement: 3 fail.
  - M4 `= <uuid>` instead of `is null`: 1 fails.
  - M5 no row-count check: 2 fail.
  - M6 double appends instead of rewriting in place: 6 fail.

## assumptions

- "One instant" is the loop's instant (the envelope `receivedAt`, strict-UTC milliseconds), which is also the `as_of` it writes. The identity compares `as_of` as `timestamptz` (microseconds), exactly as r0's double did.
- "Holds the state after the LAST fill booked at that instant" means the row's final content after every harvest at that instant, which is also the reviewer's reading ("finalize … across all relevant harvests, including terminal runs").
- A REPLACEMENT is not the option (b) the user did not choose ("the adapter upserts or skips on the key"):
  - the adapter never decides and never tolerates a duplicate;
  - the LOOP issues it, only for an identity it inserted itself, to realise option (a)'s "after the last fill booked at that instant" under §4.2's MEDIUM-1 gate.
  
  This is put forward for ratification under deviations, not assumed silently.
- node-postgres returns `rowCount` for an UPDATE, which kysely reads into `numUpdatedRows`. Confirmed on the real database: the row was updated in place, and the missing identity answered `0 matched`.
- The paper-trader fixture's venue has no latency model, so a resting order's rest start is the clock's nanosecond at submission. With the event-time clock, the take-profit's trade stamped at the same instant therefore matches (`trade.monotonicNs < restingFromNs` is false). Observed: the durable test's fill happened.

## deviations

1. **A new port method, `TraderStore.replacePnlSnapshot` (needs ratification).** An instant touched by two harvests is written as an INSERT then an UPDATE: two statements, one row.
   - The ruling's "one snapshot per key, holding the last fill's state" and §4.2's MEDIUM-1 gate cannot both hold with a write-once row when two harvests share an instant (F2/F3). The only alternative, deferring the write past the deliveries, fails MEDIUM-1 (r0 measured it as mutation M2, re-measured here) and cannot cover a run's end without `main.ts`.
   - `writePnlSnapshot` still refuses duplicates. The common case (one harvest per instant: every golden, every committed scenario but the new pins) still issues exactly one INSERT per key.
   - This supersedes r0's deviation 1 (owed rows re-dated to a later instant), which is withdrawn.
2. `test/integration/paper-trader/acceptance-1-max-run-mode.test.ts` is outside the packet's stated purposes for that directory. Its literal `TraderStore` stub gains one line (`replacePnlSnapshot: async () => ({ ok: true, value: null })`), forced by the compiler. The path is within the allowed glob, and no assertion changed.
3. The durable shared-instant shape DROPS event 11, so the run ends at the shared instant (the terminal case the reviewer named). It is a new test, so BRACKET-1c's and r0's two-level tests are unchanged. Backwards instants are pinned in memory only: a resting take-profit cannot fill from a trade stamped before its rest start.
4. The loop-folds harness gained two optional `assemble` options (`observe`, `strategy`), both off by default, so every pre-existing test runs exactly as before.
5. The identity helpers moved from `testing/index.ts` into the production module `pnl-snapshot-key.ts`, so the loop and the double share one definition. `testing/index.ts` re-exports `PNL_SNAPSHOT_SCOPE_UNIQUE`, so its public surface is unchanged, plus the r1 additions.

## known_risks

- **After a restart**, the in-memory `#writtenSnapshotKeys` is empty. A harvest at an instant that a previous process already wrote for the same instance would INSERT and be refused, which is a GLOBAL halt. This is the same pre-existing class as base (base's per-fill insert had it too) and is not reachable in any committed scenario. A fix needs a durable read of existing identities at startup (a `main.ts` / registration change).
- `#writtenSnapshotKeys` grows by one entry per (instance, instant with a booked fill). It is unbounded, as `#pnlRecords` (two records per fill) already is. Instants can repeat in any order, so no identity can be forgotten safely.
- A replaced row keeps its first `computed_at` and its `pnl_snapshot_id`, because the database owns both and the insert does not bind them either. `computed_at` is therefore the time of the FIRST computation at that instant.
- **Crash between harvests.** A crash after a harvest's ledger writes but before its flush leaves the durable row behind the ledger. This is the same class as base (a crash between a fill's posting and its snapshot); `pnl_snapshots` is a rebuildable projection.
- The multi-denomination self-collision (denomination not in the key) is pre-existing and unreachable with one pUSD denomination. It is still refused, never overwritten. That branch (`touched`) is argued, not pinned, because no fixture computes two rows.
- Halt ORDER in combined failures can differ from base, as r0 disclosed. Each scope's first record is unchanged in kind.
- No health counter counts replacements: the control-api strict door rejects new fields, and `apps/control-api/**` is forbidden. Replacements are visible only through the store (`pnlSnapshotReplacements` on the double) and the tests.

## follow_up

- Orchestrator/user: ratify deviation 1 (`replacePnlSnapshot`, loop-directed, insert-then-update on a shared instant) or rule otherwise.
- Record the closure of `BRACKET1C-SNAPKEY`, `BR1C-R1-L1` and SNAP1-R1/R2 in `IMPLEMENTATION_STATUS.md` and the BRACKET-1c handoff (docs are orchestrator-owned).
- A later `main.ts`/registration round could seed `#writtenSnapshotKeys` from the database at startup (the restart risk above).
- A green GitHub CI run is still owed; the orchestrator opens the PR.

## commit_sha

`4085e2398482bda2789691a892f2a23ee99e389a` (branch `snap-1`, parent `de867f6`, base `1ad2a36`; not pushed).

# Appendix C — implementer handoff, r2 (verbatim)

# SNAP-1 — remediation handoff, round 2

## plan (written BEFORE any edit)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-snap-1`, branch `snap-1`, HEAD
`4085e23` (clean). Docker `29.1.2`; `postgres:16.6-alpine` (the Testcontainers image) is cached
locally. Read: `codex-r2.out` (one LOW, SNAP1-R3; no scope violations; R1/R2 FIXED), `gates-r2.txt`
(all gates green at `4085e23`), `handoff-r0.md`, `handoff-r1.md`.

The finding: `asOfKey` in `apps/trader/src/pnl-snapshot-key.ts` builds epoch seconds with
`Date.UTC(Number(year), …)`, and `Date.UTC` maps years 0–99 to 1900–1999, so
`0099-05-01T09:00:02Z` and `1999-05-01T09:00:02Z` share a key. Both pass `normalizeToStrictUtc`.
The helper feeds the double's duplicate refusal AND the loop's insert-versus-replace choice. The
finding is inside my allowed paths and this package's scope (the key is SNAP-1's own module), so I
fix it; I do not argue it.

Fix (one module, no port or loop change):

1. Replace `Date.UTC` with exact integer calendar arithmetic (proleptic Gregorian days-from-civil),
   so a four-digit year is that year.
2. `Date.UTC` also silently rolled over out-of-range fields (`2026-02-30` keyed as `2026-03-02`,
   month 13 as next January). PostgreSQL refuses those. So the helper also validates what the
   `timestamptz` input validates, and keys a string the column would refuse as itself (the
   module's existing documented fallback). Where PostgreSQL rolls a field over (`24:00:00`,
   second `60`), the arithmetic does the same. Every claim is to be MEASURED, not recalled: a probe
   matrix of edge strings is run through a real PostgreSQL 16.6 (`docker run --network none`,
   local image) and compared, string by string, with the key (epoch microseconds, or "refused" ⇔
   raw fallback). If the matrix shows the existing sub-microsecond rounding diverging from
   PostgreSQL's, I fix that too and say so; otherwise I leave it.
3. Pins (each must FAIL at `4085e23`): in `test/unit/trader/memory-store-pnl-snapshot-key.test.ts`,
   a `SNAP1-R3` block: the verifier's exact pair through `MemoryTraderStore.writePnlSnapshot` (both
   accepted, two rows); every first-century year Y against Y+1900; the helper itself
   (`pnlSnapshotKey`, the loop's function) for the same pairs; a first-century instant still
   refuses its own duplicate in another spelling; and the PostgreSQL-measured classifications
   (roll-overs equal, refused strings not conflated with a valid instant).
4. Non-vacuity: restore `4085e23`'s `pnl-snapshot-key.ts` only, run the new pins (must fail), and
   restore byte-identically (sha256 checked).
5. Every gate re-run; e2e, replay and trader integration twice. One commit on top of `4085e23`,
   first line `SNAP-1 r2: …`. Goldens must not move (all golden instants are 2026, and the key's
   representation is unchanged for them).

---

## summary

`SNAP-1` round-2 remediation is committed on `snap-1` as `0d10395` (ONE commit on top of `4085e23`;
not pushed, no PR). It changes one production module and one unit-test file. There is no port,
loop, adapter, double or golden change. All evidence is simulated or in-process; the PostgreSQL
measurements used a local `postgres:16.6-alpine` container with `--network none`. No soak, probe or
live evidence is claimed. Every acceptance gate exits 0 at the commit; e2e, replay and trader
integration were each run twice.

**Finding table**

| Finding | Severity | Disposition | Pins (each FAILS at `4085e23`, passes at `0d10395`) |
| --- | --- | --- | --- |
| SNAP1-R3: the snapshot key conflates distinct calendar years | LOW | **FIXED** | `test/unit/trader/memory-store-pnl-snapshot-key.test.ts`, block "SNAP-1 r2 (SNAP1-R3): the key's calendar is PostgreSQL's — the year written, no silent roll-over": (1) "the verifier's pair: 0099-05-01T09:00:02Z and 1999-05-01T09:00:02Z both pass the trader's boundary, and the double keeps TWO rows"; (2) "every first-century year is its own instant: year Y never shares the loop's key with Y + 1900 (nor with Y + 100)"; (3) "pnlSnapshotKey — the loop's own insert-or-replace identity — groups as_of EXACTLY as PostgreSQL did: one key per measured instant, a distinct key per instant"; (4) "a spelling PostgreSQL REFUSES is never rolled over into an instant's key: it shares a key with nothing"; (5) "the double agrees: one row per measured instant and per refused spelling; every other spelling of an instant is refused as its duplicate" |

There were no other findings and no scope violations. No finding is argued.

**The defect, measured.** `asOfKey` computed epoch seconds with `Date.UTC(Number(year), …)`, and
`Date.UTC` reads years 0–99 as 1900–1999. A real PostgreSQL 16.6 confirmed that the verifier's two
strings are distinct instants: `0099-05-01T09:00:02Z` gives `-59032594798000000` µs and
`1999-05-01T09:00:02Z` gives `925549202000000` µs. Measuring the whole input domain exposed two more
divergences in the same function, both inside SNAP-1's own module:
- **Silent roll-over.** `Date.UTC` rolls an out-of-range field into another instant. For example,
  `2026-02-30` was keyed as `2026-03-02`, and year `0000` as `1900`. PostgreSQL REFUSES both
  (`22008`).
- **Sub-microsecond rounding.** r0/r1 rounded the digits half-to-even in DECIMAL. PostgreSQL computes
  `rint(strtod(".ddd") * 1e6)` on a double, so non-exact ties diverge: PostgreSQL reads `.5185705`
  as `.518571` and `.5025175` as `.502517`, where the decimal rule gave `.518570` and `.502518`. The
  four ties r0 probed (`.0000005`, `.0000015`, `.0000025`, `.0000035`) scale to EXACTLY `x.5` as
  doubles, which is why they agreed.

**The fix** is in `apps/trader/src/pnl-snapshot-key.ts` only. It is used both by `MemoryTraderStore`
and by the loop's insert-or-replace choice (`CoreLoop.#flushPnlSnapshots`).
- `daysFromCivil`: integer proleptic-Gregorian day arithmetic (Hinnant's `days_from_civil`) instead
  of `Date.UTC`. A four-digit year is the year written.
- Validation, as PostgreSQL 16.6 was measured to refuse: year `0000`; a day the month does not have
  (a month `00`/`13` has none); minute `60`; second `61`; a time of day past `24:00:00` once the
  fraction is rounded; a zone hour past `15` or zone minute past `59`. Such a string keys as ITSELF,
  which is the module's existing documented fallback ("the real column would refuse it"), so it is
  never conflated with an instant.
- Roll-overs PostgreSQL performs are reproduced by the arithmetic: `24:00:00` becomes the next
  midnight, second `60` becomes the next minute, and a fraction that rounds to one second carries.
- `fractionMicros`: `Number("0." + digits) * 1e6`, rounded half-to-even (C `rint`).
- The key's representation (`"<seconds>.<micros>"`) is unchanged, so every instant the loop writes
  (strict-UTC milliseconds, years 2026) has a byte-identical key to r1's. The goldens are unchanged.

**Evidence: key vs a real PostgreSQL 16.6, string by string.** A scratch probe compared, for each
string, PostgreSQL's `extract(epoch from s::timestamptz)` in µs (or its refusal) with the key
(decoded µs, or the raw fallback). It also checked pairwise that equal keys ⇔ equal PostgreSQL
instants:

| Matrix | Strings | `0d10395` | `4085e23` |
| --- | ---: | --- | --- |
| hand-built edge set (years 0000–9999, leap days, 24:00/:60, zones, fractions of 1–28 digits; 410 seventh-digit ties and 200 tie-adjacent tails generated) | 2148 | 1679 same-instant + 469 refused, **0 mismatches, 0 conflated groups, 0 split groups** | 752 mismatches, **298 conflated groups**, 1 split group |
| random (seed 424242; every field incl. out-of-range; fractions up to 25 digits) | 20000 | 5616 + 14384, **0 mismatches** | 15626 mismatches (1242 among accepted strings) |
| the committed test table | 66 | 51 + 15, **0 mismatches** | 29 mismatches, 20 conflated groups, 3 split groups |

A script also confirmed that the committed table (31 instants in 51 spellings, plus 15 refused
spellings) groups EXACTLY as PostgreSQL measured.

**Non-vacuity.** With `4085e23`'s `pnl-snapshot-key.ts` restored and the new test file, the unit file
gives **5 failed / 11 passed**. The five new pins fail on assertions:
- the verifier's pair: the second write answers `{ok:false, …}`;
- `0001-05-01` shares a key with another year;
- the `.5185705` group splits into 2 keys;
- `0000-05-01T09:00:02Z` is conflated with `1900-05-01T09:00:02Z`;
- the double refuses `1999-05-01T09:00:02Z`.

The file was restored and checked against sha256: OK for both files.

**Mutations of the new module.** Each of the 18 mutants was applied alone, run against the unit file,
then restored (sha256 OK). **All 18 are killed:**
- K1: no year floor;
- K2: no day-in-month check;
- K3: Julian leap rule;
- K4: no minute cap;
- K5: no second cap;
- K6: `>=` for the time of day;
- K7: no time-of-day check;
- K8: no zone-hour cap;
- K9: no zone-minute cap;
- K10: half-up rounding;
- K11: r1's decimal rounding;
- K12: `Date.UTC` days;
- K13: a missing month's fallback set to 31;
- K14: a leap February of 28 days;
- K15: zone minutes dropped;
- K16: no day floor;
- K17: no carry;
- K18: zone sign ignored.

Three guards whose mutants first survived as EQUIVALENT (`hour > 24`, `month < 1`, `month > 12`,
each implied by another check) were removed rather than left unpinned. The leap-day groups gained
second spellings so K14 is caught.

## files_changed

(vs `4085e23`; 2 files, both modified)
- `apps/trader/src/pnl-snapshot-key.ts`: `asOfKey` rewritten over `daysFromCivil` / `daysInMonth` / `fractionMicros` with the PostgreSQL-measured validation; its documentation states the measured contract.
- `test/unit/trader/memory-store-pnl-snapshot-key.test.ts`:
  - five new SNAP1-R3 tests with the `SAME_INSTANT` / `POSTGRES_REFUSES` tables;
  - new imports (`pnlSnapshotKey`, `normalizeToStrictUtc`);
  - header prose;
  - one existing comment corrected: the four small ties are exact doubles; the assertion is unchanged.

Untouched (checked with `git diff --quiet 4085e23 --`, exit 0): `packages/**`, `db/**`, `docs/**`,
`apps/trader/package.json`, `apps/trader/src/main.ts`, root `package.json`, `pnpm-lock.yaml`,
`eslint.config.mjs`, `.github/**` and `test/replay-golden/**`. `two-brackets-run.json` is also
unchanged vs base `1ad2a36`. The diff adds no `eslint-disable`, `ts-ignore`/`ts-expect-error`,
`.skip`, `.only`, and touches no safety default.

## tests_run

All runs were outside any sandbox, with every pnpm command prefixed by
`pnpm_config_verify_deps_before_run=false`, on Docker 29.1.2. They ran after the last edit, on the
tree that was committed. Logs are in `scratchpad/snap-1/r2/gates/`, the probes and measurements in
`scratchpad/snap-1/r2/`, and non-vacuity and mutation logs in `scratchpad/snap-1/r2/nv/`.

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm run lint` | exit 0 |
| `pnpm run check:deps` | exit 0, PASS, 34 packages / 80 edges |
| `pnpm run test` | **347 files / 7561 tests**, exit 0 (r1 347 / 7556: +5 new; base 345 / 7529) |
| `pnpm run test:e2e` | **8 / 206**, exit 0, run twice |
| `pnpm run test:replay` | **3 / 17**, exit 0, run twice |
| `pnpm --filter @polymarket-bot/control-api test:integration` | **10 / 87**, exit 0 |
| `pnpm --filter @polymarket-bot/trader test:integration` | **17 / 138**, exit 0, run twice. `durable-two-level-entry-postgres-redis.test.ts (3 tests)` ran each time (8978 ms, 8654 ms), as did `durable-two-brackets-postgres-redis.test.ts (3 tests)`; nothing was skipped |

After e2e and replay, `git diff --quiet 4085e23 -- test/replay-golden` exits 0 (goldens unchanged),
and `two-brackets-run.json` is unchanged vs `1ad2a36`. No `*WRITE_GOLDEN*` variable was set.

**New tests (5)** are all in `test/unit/trader/memory-store-pnl-snapshot-key.test.ts`, as named in
the finding table. The unit file went from 11 to 16 tests.

**PostgreSQL measurements.** A local `postgres:16.6-alpine` container (`--network none`, the
Testcontainers image, already cached) ran `probe_ts(s)`, a PL/pgSQL wrapper returning
`extract(epoch from s::timestamptz) * 1e6` or `ERR <sqlstate> <message>`. It covered the three
matrices above, and was stopped afterwards (`docker ps` shows none).

## assumptions

- "Exact key equivalence" is judged over the strings the key's pattern reads
  (`YYYY-MM-DDTHH:MM:SS[.d+](Z|±HH:MM)`). That is a superset of what `normalizeToStrictUtc`
  accepts, which is the verifier's domain. Strings outside the pattern keep the pre-existing
  documented fallback (keyed as themselves), and the loop never produces them.
- A string PostgreSQL refuses keys as itself. The double therefore ACCEPTS a write the real column
  would refuse with an input error. This is the module's existing, documented non-modelling of
  PostgreSQL's input refusal, which r2 keeps; r2 only stops such a string from colliding with a real
  instant.
- The rounding model matches PostgreSQL 16.6 as measured (the image the integration tests use). V8's
  `Number` read agreed on every fraction probed, up to 28 digits. ECMAScript permits a runtime to
  round differently past 20 significant digits.

## deviations

- The fix goes beyond the literal year remediation the verifier suggested. The same function also
  rolled PostgreSQL-refused fields into other instants' keys, and rounded non-exact sub-microsecond
  ties differently from PostgreSQL; both would falsify the same "exact key equivalence" claim, and
  both were measured, fixed and pinned here. It is still confined to SNAP-1's own module, with no
  interface change.
- Three redundant guards (`hour > 24`, `month < 1`, `month > 12`) were dropped because they were
  implied by other checks (the time-of-day limit; a nonexistent month having zero days). Behavior is
  unchanged: the matrices were re-run after the removal, with 0 mismatches.

## known_risks

- Spellings outside the key's pattern that PostgreSQL still reads as timestamps (for example
  `2026-05-01 09:00:02Z`, `+02`, `+0200`, a lowercase `z`) key as themselves. Two such spellings of
  one instant would not be conflated in the double, although PostgreSQL would refuse the second.
  This is pre-existing and documented, and unreachable from the loop (strict-UTC instants only).
- The double does not refuse an `as_of` the column refuses (year `0000`, `2026-02-30`, …). This is
  pre-existing and documented. Note that `normalizeToStrictUtc` ACCEPTS year `0000` (JavaScript's ISO
  parser reads it as 1 BC), while PostgreSQL refuses it. A trader instant in year 0000 would
  therefore halt the durable trader on insert and not the in-memory one. It is not reachable in any
  fixture. The trader's boundary is outside this package's scope (`time.ts` was not in the finding),
  so it is disclosed, not changed.
- The rounding model rests on V8 reading long decimals correctly rounded (verified to 28 digits,
  not proven for every length) and on PostgreSQL 16.6's behavior (not other major versions).
- Every r1 risk stands unchanged:
  - the restart-time empty `#writtenSnapshotKeys`;
  - unbounded key retention;
  - a replaced row keeping its first `computed_at`;
  - a crash between harvests;
  - the unreachable multi-denomination self-collision;
  - no health counter for replacements.

## follow_up

- The orchestrator records SNAP1-R3's closure and schedules the next verification of `0d10395`.
- Carried from r1:
  - ratify r1's deviation 1 (`replacePnlSnapshot`);
  - record the closure of `BRACKET1C-SNAPKEY` / `BR1C-R1-L1` / SNAP1-R1/R2 in `IMPLEMENTATION_STATUS.md`;
  - seed `#writtenSnapshotKeys` from the database at startup in a later `main.ts` round;
  - a green GitHub CI run on the PR.
- Optional, outside this package: decide whether `normalizeToStrictUtc` should refuse year `0000`,
  which PostgreSQL cannot store.

## commit_sha

`0d10395fea4d02d93b58092eb16f895957c43c2c` (branch `snap-1`, parent `4085e23`, base `1ad2a36`; not pushed).
