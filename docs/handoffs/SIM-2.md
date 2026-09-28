# SIM-2: bound SimulatedVenue (LOOPMEM-SIM part 2)

Branch `sim-2` on base `d2a8e93`, merged into `main` as `04bf9d8` (`--no-ff`) on 2026-09-27.

- **Authorization:** the user, "yes go for it please" (LOOPMEM-SIM). Dispatched after `SIM-1`, because a live index is bounded only if every order terminates.
- **Process:** the HARDENING LOOP (workflow `wf_2a89b0b2-ada`): an Opus implementer, gates run outside any sandbox (including a golden-bytes gate), Codex gpt-6-astra verification.

| Commit | Content |
| --- | --- |
| `7c570ed` | r0: the bounding |
| `a0d0164` | r1: `SIM2-R1-1` … `R1-5` |
| `04bf9d8` | the merge (tree identical to `a0d0164`) |

## Outcome
A PURE bounding change. **Every golden under `test/replay-golden/**` is byte-identical.** That tree was outside the grant, and the verification gate checked the diff was empty in both rounds.

- **Fill cursor.** `fillsSince(sequence)` returns `{fills, next}` over an absolute sequence and consumes nothing.
  - A cursor behind retention is refused (`SIMULATED_VENUE_HISTORY_EVICTED`), and the loop halts GLOBAL (`VENUE_OBSERVATION_FAILED`) before releasing anything.
  - `#knownFills` moves only after a whole batch is booked, so the store-failure re-read is preserved.
- **Live index plus retention.**
  - `#orders` holds live orders only. Terminal orders, fills and bands move to bounded FIFO retention (`retention.ts`). Defaults: 50,000 orders, 50,000 fills, 10,000 bands and 100,000 tombstones; a pin checks they stay at least 10,000× every golden.
  - Lookups (by id, cancel-by-id, a CANCEL plan's orders) fall back to retention.
  - `ordersSnapshot()`, `fills` and `bandHistory()` return the same lists as before while nothing is evicted. `runReplay` refuses evicted history.
- **Acknowledgement (r1, `SIM2-R1-1`).**
  - A terminal order is held OUTSIDE every bound until its consumer calls `acknowledgeTerminal`.
  - The loop acknowledges on settle, when releasing a held unowned order, and for a basket leg only when its watch concludes (`#watchedOrders`).
  - `retention().awaitingAcknowledgment` counts what is still held.
- **Duplicate ids (§6 invariant 6; r1, `SIM2-R1-2`).** An id is refused while it is live, retained or tombstoned. After its tombstone is evicted it goes into a deterministic, never-forgetting filter, so a reused id is refused forever (`SIMULATED_VENUE_ORDER_ID_NOT_PROVABLY_UNIQUE`). A false positive fails closed and is counted (`SIM2-FILTER`).
- **The loop stops scanning venue history.**
  - `TraderVenue` loses `ordersSnapshot()` and `fills`, and gains `fillsSince`, `orderById`, `orderByPlannedId` and `acknowledgeTerminal`.
  - All six readers iterate the loop's own sets, sorted with the venue's comparator (`:o10` before `:o2`; a 12-slice pin guards it), plus lookups.
  - `#heldUnowned` tracks TRDR-4's held-but-unlisted orders and lost-answer planned orders. A lost answer's order is promoted once a lookup shows it (r1, `R1-4`).
- **Cancel answers** list every order the same call cancelled (r1, `R1-3`).
- **`#trades`.** Tier 0 keeps one last timestamp per (market, side), closing the largest production leak (~760 B per public trade). Tier 1 stays unbounded (`SIM2-TIER1-TRADES`): trimming is not byte-safe, and that is pinned.
- **Bands:** `restingBands()` is live only; `runReplay` serializes `bandHistory()`, and the conflicting docstrings are fixed.
- **SIM-1's DELAYED and expiry sweeps** read live state only.
- **A venue-only `retention()` accessor** reports live sizes and retained / maximum / evicted counts; no health seam (`TRDR4-GAUGES`).
- **The "adds nothing" claims** in `ports.ts` and `venue.ts` are corrected, and README §5 item 17 is new.

## Measurements (a 2,010-order synthetic run; NOT a soak)

| Configuration | Venue ms/event, base (first → last tenth) | After | Loop `ordersSnapshot()` calls/event |
| --- | --- | --- | --- |
| 260 fills | 0.97 → 5.81 | 0.82 → 0.58 | 13–14 (max 34) → 0 |
| 20 fills | 0.76 → 2.83 | 0.67 → 0.45 | 13 (max 34) → 0 |

Total per-event time still grows, because the ledger is re-folded on every evaluation (`LOOPMEM-FOLD`).

## Reviews (Codex gpt-6-astra)
- **r1 of `7c570ed`: CHANGES REQUIRED** — 2 HIGH (`R1-1` evictable before the loop saw it; `R1-2` duplicate ids re-allowed after tombstone eviction), 2 MEDIUM (`R1-3` cancel answers; `R1-4` lost-answer promotion) and 1 LOW (`R1-5` documentation).
- **r2 of `a0d0164`: ACCEPT, no findings.** Residuals:
  - an unacknowledging consumer keeps all its terminal history;
  - filter saturation;
  - the e2e eviction message wording (`SIM2-E2E-MSG`);
  - Tier-1 trades and the ledger/PnL folds.

## Evidence
- Verification gates at `a0d0164`, outside any sandbox: typecheck 0, lint 0, check:deps PASS; unit 342 / 7427; e2e 7 / 157; replay 3 / 17; golden bytes identical.
- **Docker was unavailable in this session.** The trader Testcontainers suite ran green on GitHub: PR #8 run `36360522743`.
- Post-merge on `04bf9d8`: unit 342 / 7427, e2e 7 / 157, replay 3 / 17.

## commit_sha
`a0d0164f1dc24f50ac45b7df25a58cfc96c9666c` (branch `sim-2`), merged as `04bf9d8`.

---

# Appendix A — implementer handoff, r0 (verbatim)

# SIM-2 handoff, round 0 (first implementation)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-sim-2`, branch `sim-2`, base `d2a8e93`.

## plan (written before any edit)

Prerequisites verified at the base: `SIM-1` merged (`93c7bbd`, governance `d2a8e93`); `SIM-2` row "Ready";
worktree clean; no Docker in this session (`docker` is not installed in this WSL distro).
Scoping claims re-verified at `d2a8e93` (SIM-1 moved most line numbers): `#orders`/`#fills`/`#bands`/`#trades` are
still never pruned; `#pending`/`#resting` are live-only; the market-scoped cancel and `openOrders` already filter to
live orders (O6); the loop's six `ordersSnapshot()` readers and the `fills` index cursor are as `IF-08`/`VS-08` describe,
plus SIM-1's `#releaseRefusedPlacement` and `#judgeBasketWatches` readers.

### Venue (`packages/simulation/src/venue.ts`, a new internal `retention.ts`, `ports.ts`, `replay.ts`, `refusals.ts`, `index.ts`, README)
1. **Fill cursor.** `fillsSince(sequence)` → `SimulationResult<{ fills, next }>` over an ABSOLUTE sequence; non-destructive.
   A sequence older than the oldest retained fill (or past the end, or not a safe integer) is REFUSED with a new code
   `SIMULATED_VENUE_HISTORY_EVICTED` / `SIMULATION_INPUT_INVALID`. `fills` (history) keeps returning the retained window.
2. **Live index + retention.** `#orders` holds LIVE orders only (the existing `isLiveState`). One choke point `#putOrder`
   moves a terminal order to a bounded FIFO retention map (and its band, if any, to a bounded band retention map).
   `orderById` / `orderByPlannedId` fall back to it; so do cancel-by-id and a CANCEL plan's `orders`.
   `ordersSnapshot()` = live ∪ retained sorted by id (unchanged bytes while nothing is evicted); fills in a bounded log.
   Defaults far above every fixture; a constructor option overrides them (positive safe integers, else `RangeError`).
3. **Duplicate guard.** `live ∪ retained ∪ bounded tombstones` (ids of evicted terminal orders), every eviction counted.
   Chosen over an unbounded id set because an unbounded set is exactly the per-order leak this round closes; trader ids are
   unique by construction, so the guard is defence in depth and a counted, finite memory is the honest shape.
4. **`runReplay` refuses** a run whose venue evicted any order, fill or band (`SIMULATED_VENUE_HISTORY_EVICTED`).
5. **`#trades`:** Tier 0 keeps one last `monotonicNs` per key (the only thing it reads). Tier 1: LEFT UNBOUNDED and
   queued, with evidence (a later order can rest at or before a trade the venue already holds; the only lower bound on a
   future `restingFromNs` is the clock, and clock trimming is ruled out by `IF-15`) — pinned by a test.
6. **`restingBands()`** = live bands; new `bandHistory()` = live ∪ retained bands, which `runReplay` serializes. Docstrings
   in `venue.ts` and `replay.ts` reconciled.
7. `#pending` and the eager expiry sweep already iterate live state only; kept so, and pinned.
8. **`retention()`** accessor: live sizes, retained / maximum / evicted per log, tombstones, trades. No health seam.
9. README §5 new item + `ports.ts`/`venue.ts` header corrections for the "adds nothing" claims (`IF-02`).

### Trader (`apps/trader/src/loop.ts`, `halt.ts` doc, tests)
- `TraderVenue` loses `ordersSnapshot()` and `fills`; gains `fillsSince`, `orderById`, `orderByPlannedId`.
- `#harvestFills` reads `fillsSince(#knownFills)`; `#knownFills` advances exactly where it does today (store-failure
  re-read preserved). A cursor refusal HALTS (GLOBAL, `VENUE_OBSERVATION_FAILED`) and returns before any release.
- `#orderViews_`, `#openOrdersFor`, `#deliverOrderViews` (one boundary of records captured up front),
  `#releaseSettledReservations`, `#releaseRefusedPlacement` (lookup by planned id) and `#judgeBasketWatches` iterate the
  loop's own sets, SORTED with the venue's comparator (UTF-16 code-unit order, `IF-07`), plus lookups by id.
- A lookup miss for an order the loop owns/holds is LOUD (GLOBAL `VENUE_OBSERVATION_FAILED` halt).
- New `#heldUnowned` (planned id → venue id): the refusal branch's held-but-unlisted orders, plus the planned orders of a
  placement whose `submit` threw (the old whole-venue scan released those too); released and forgotten at terminal.
  Counted in `retainedOrderState().heldUnowned`.
- Update every structural implementer: `WrappedVenue`, `RefusesWhileHoldingVenue`, `MovesBetweenCallsVenue`,
  the acceptance-1 stub.

### Tests
- Venue unit pins (new `test/unit/simulation/venue-sim2.test.ts`): cursor, eviction with small bounds, lookups after
  leaving the live map, duplicate guard via retention and tombstones, `runReplay` refusal, Tier-0 `#trades` O(keys),
  Tier-1 evidence pin, `restingBands()` live-only vs `bandHistory()`, live-only sweeps, doors census entries.
- Loop pins: `:o10` ordering (12-slice plan), held-unlisted release on terminal, lost-answer release, miss → halt,
  cursor refusal → halt, store-failure re-read counters.
- Item (10): a deterministic long synthetic run (NOT a soak) with ≥2,000 orders plus public trades, small venue
  bounds, `ordersSnapshot()`/`fills` calls from the loop = 0 per event, Tier-0 trades O(keys).
- Before/after per-event venue time measured with one scratch probe on the same harness, at base and after.

---

(Plan revision during implementation, disclosed: the default bounds were tightened after measuring entry sizes
— 50 000 orders / 50 000 fills / 10 000 bands / 100 000 tombstones instead of the 100k/100k/10k/1M first drafted — and a
loop-side `#terminalSeen` record was added so SIM-1's carried requirement holds independent of the venue's bound.)

## summary

SIM-2 bounds `SimulatedVenue` and moves the trader loop off venue history, with every golden byte-identical
(`git diff d2a8e93 -- test/replay-golden/` is empty).

- **(1) Fill cursor.** `SimulatedVenue.fillsSince(sequence)` → `{ fills, next }` over an ABSOLUTE sequence (a ring
  buffer, O(fills answered)); non-destructive. A sequence older than the oldest retained fill is refused
  `SIMULATED_VENUE_HISTORY_EVICTED` (new code); a non-safe-integer or future sequence `SIMULATION_INPUT_INVALID`.
  The loop's `#knownFills` is now that sequence and advances exactly where it did (after the whole batch), so the
  store-failure re-read is unchanged (pinned: 1 → 11 observed, 1 duplicate). A cursor refusal HALTS the loop GLOBAL
  (`VENUE_OBSERVATION_FAILED`) and returns before any release.
- **(2) Live index + retention.** `#orders` holds LIVE orders only (`isLiveState`); one choke point `#putOrder` moves a
  terminal order (and its last Tier-1 band) into bounded FIFO retention (`packages/simulation/src/retention.ts`,
  internal). `orderById` / `orderByPlannedId`, cancel-by-id and a CANCEL plan's `orders` fall back to it.
  `ordersSnapshot()`, `fills` and the new `bandHistory()` answer live ∪ retained — the same lists while nothing is
  evicted. `runReplay` refuses a run whose venue evicted any order, fill or band (`SIMULATED_VENUE_HISTORY_EVICTED`).
  Defaults (`DEFAULT_VENUE_RETENTION`): 50 000 orders, 50 000 fills, 10 000 bands, 100 000 tombstones, from measured
  sizes (order ≈ 1.55 KB, fill ≈ 1.92 KB, tombstone ≈ 193 B, band ≈ 2.5 KB before scenario fills → ≈ 190 MB Tier-0
  worst case); overridable via `SimulatedVenueOptions.retention` (a bad bound throws `RangeError` naming it).
  A pin reads the three golden files and asserts every default is ≥ 10 000× (bands ≥ 1 000×) their counts; the
  TRDR-4 500-order run now asserts nothing evicted.
- **(3) Duplicate guard.** `#knowsOrderId` = live ∪ retained ∪ bounded, counted tombstones (ids of evicted terminal
  orders). Argued choice: an unbounded id set is exactly the per-order growth this round removes; trader ids are unique
  by construction, so the guard is defence in depth and a counted finite memory is honest (`tombstones.evicted > 0`
  says when a reuse could pass). Pinned through history, then tombstone, then accepted-and-counted once both forgot.
  A cancel naming a tombstoned id answers "already terminal … evicted", never UNKNOWN.
- **(4) The loop reads no history.** `TraderVenue` lost `ordersSnapshot()` and `fills`, gained `fillsSince`,
  `orderById`, `orderByPlannedId`. `#orderViews_`, `#openOrdersFor`, `#deliverOrderViews` (one boundary of records
  captured before any delivery), `#releaseSettledReservations`, `#releaseRefusedPlacement` and `#judgeBasketWatches`
  iterate the loop's own sets sorted by `compareVenueOrderIds` (UTF-16 code units = the snapshot's `compareStrings`)
  plus O(1) lookups. New `#heldUnowned` (planned id → venue id) tracks the TRDR-4 held-but-unlisted orders AND the
  planned orders of a placement whose `submit` threw (the old full scan released those too); released and forgotten
  at the first harvest that sees each terminal. New `#terminalSeen` keeps an owned order's TERMINAL record until it
  settles, so an order the loop has read terminal stays visible even if the venue later evicts it (SIM-1 requirement);
  any other miss for an owned/held order is LOUD (GLOBAL `VENUE_OBSERVATION_FAILED`, nothing released).
  `retainedOrderState()` gained `heldUnowned` and `terminalSeen`. Every structural implementer updated
  (`WrappedVenue`, `RefusesWhileHoldingVenue`, `MovesBetweenCallsVenue`, the acceptance-1 stub); the backtest harness now
  passes the venue UNCAST (its stale comment said main.ts casts; it does not).
- **(5) `#trades`.** Tier 0 keeps one last `monotonicNs` per (market, side) (`#lastTradeNs`), which is all it reads;
  Tier 1 keeps its list, LEFT UNBOUNDED and queued (`SIM2-TIER1-TRADES`), decided with evidence: a later order can rest
  at an instant the venue already holds a trade for (pinned: a trade observed before any order rests is in a later
  zero-latency order's band, fill id `late/t1q/BASE/0`), so "trim to the earliest live restingFromNs" is not
  byte-identical at this door; the only lower bound on a future restingFromNs is the clock (IF-15 rules out clock
  trimming); a resting GTC's window grows anyway until the walk is incremental (IF-15b); Tier 1 is not the trader's model.
- **(6) `restingBands()`** is LIVE (a cancelled/expired order's band moves to `bandHistory()`); `runReplay` serializes
  `bandHistory()`; the `venue.ts` / `replay.ts` docstrings are reconciled.
- **(7)** `#pending` resolution reads the live index only; the expiry sweep reads `#resting` (live) only; pinned with
  the history full and evicting.
- **(8)** `retention()`: `live {orders, resting, bands, pendingDelayed}`, `orders/fills/bands/tombstones {retained,
  maximumRetained, evicted}` (+ fill sequences), `trades {tier, keys, retained}`, `historyEvicted`. No health seam.
- **(9)** The "adds nothing to §12.1" claims in `ports.ts` and `venue.ts` are withdrawn and replaced; README §1 row and
  new §5 item 17 disclose the surface, the bounds, the refusals, Tier-1 trades and the queued gauge.
- **(10)** A deterministic long synthetic run (NOT a soak, §16.7) in `apps/trader/src/loop-long-run.test.ts`: the real
  CoreLoop + Tier-0 SimulatedVenue, ≥ 2 000 orders (2 010) and ≥ 250 public trades, venue bounds 64/16/1/256. After
  EVERY event: 0 `ordersSnapshot()`, 0 `fills`, 0 `bandHistory()` calls from the loop, ≤ 1 `fillsSince`; venue live
  orders = the loop's owners ≤ 10; retained ≤ bounds; live + retained + tombstoned ≤ 10 + 64 + 256; Tier-0 trades
  `retained 0`, `keys ≤ 1`. At the end: evictions counted exactly, `historyEvicted` true, no halt, the loop observed
  EVERY fill the venue produced though it kept 16, `terminalSeen`/`heldUnowned` 0, and per-event lookups flat (late
  no-fill max ≤ early no-fill max, all < 1 000). ≈ 8 s locally.

**Per-event venue time, same harness** (`scratchpad/sim-2/probe/venue-time.probe.ts`: real CoreLoop + SimulatedVenue,
2 010 orders, trades every event, WSL2, single machine — growth shape, not a benchmark):

| configuration | base `d2a8e93` venue ms/event (first → last decile, overall) | after | loop's `ordersSnapshot()` calls/event |
| --- | --- | --- | --- |
| full (260 fills) | 0.97 → 5.81, overall 2.74 | 0.82 → 0.58, overall 0.60 | base 13.5–14.3 (max 34) → 0 |
| light (20 fills), back-to-back | 0.76 → 2.83, overall 1.64 | 0.67 → 0.45, overall 0.50 | base 13 (max 34) → 0 |

After: 1 `fillsSince` and ≈ 108–124 O(1) `orderById` lookups per event (max 515 on a fill event), flat.
TOTAL per-event time is NOT fixed by this round: full config 41 → 382 ms at base vs 40 → 375 ms after; light config
14.9 → 54.1 vs 14.9 → 49.4 ms. A CPU profile attributes it to the ledger re-fold per evaluation (`LOOPMEM-FOLD`,
`projectLedger` ≈ 70% of time) and the features trade window (bounded at 512 trades).

## files_changed
- `packages/simulation/src/retention.ts` (new, internal): `SequencedLog`, `RetainedMap`, `TombstoneSet`, `requireRetentionBound`.
- `packages/simulation/src/venue.ts`: live index + retention, `#putOrder`/`#lookupOrder`/`#knowsOrderId`, `fillsSince`,
  `orderById`, `orderByPlannedId`, `retention()`, `bandHistory()`, live `restingBands()`, Tier-0 `#lastTradeNs`,
  `DEFAULT_VENUE_RETENTION`, `VenueRetention(Bounds)`, header/docstrings.
- `packages/simulation/src/replay.ts`: refuses evicted history; serializes `bandHistory()`; docstrings.
- `packages/simulation/src/refusals.ts`: `SIMULATED_VENUE_HISTORY_EVICTED`.
- `packages/simulation/src/index.ts`: exports `DEFAULT_VENUE_RETENTION`, `VenueRetention`, `VenueRetentionBounds`, `RetentionCounters`.
- `packages/simulation/src/ports.ts`: IF-02 doc corrections.
- `packages/simulation/README.md`: §1 rows, §5 item 17.
- `apps/trader/src/loop.ts`: the port, cursor, own-set iteration, `#heldUnowned`, `#terminalSeen`, loud misses.
- `apps/trader/src/halt.ts`: `VENUE_OBSERVATION_FAILED` doc (no new code).
- `apps/trader/src/order-lifecycle.ts`: stale LOOPMEM-SIM claim corrected (doc only).
- `apps/trader/src/loop-long-run.test.ts`: harness parametrized; SIM-2 long run + 3 loop pins; no-eviction pin on the TRDR-4 run.
- `apps/trader/src/loop-order-lifecycle.test.ts`: `WrappedVenue` on the new port (+ `forget`); 3 new pins; exact-shape pin extended.
- `apps/trader/src/loop-refused-plan.test.ts`: both doubles on the new port; `heldUnowned` assertions added to the TRDR-4 defensive pin.
- `test/unit/simulation/venue-sim2.test.ts` (new, 21 tests); `doors.test.ts` (census + fresh-answer checks);
  `backtest-replay-support.ts` (venue uncast, stale comment fixed).
- `test/integration/paper-trader/acceptance-1-max-run-mode.test.ts`: the typed venue stub on the new port.

## tests_run
All outside any sandbox, in `/home/adriancova/proyects/tradeBot/polymarket-bot-sim-2`, `pnpm_config_verify_deps_before_run=false`:
- `pnpm run typecheck` exit 0; `pnpm run lint` exit 0; `pnpm run check:deps` exit 0 (PASS).
- `pnpm run test`: **342 files / 7418 tests**, exit 0 (base 341 / 7390; +1 file, +28 tests: `venue-sim2.test.ts` 21,
  `loop-long-run.test.ts` +4, `loop-order-lifecycle.test.ts` +3).
- `pnpm run test:e2e` twice: 7 / 157 both, exit 0 (determinism-golden included).
- `pnpm run test:replay` twice: 3 / 17 both, exit 0.
- `git diff d2a8e93 -- test/replay-golden/`: empty (0 lines).
- `pnpm --filter @polymarket-bot/trader test:integration`: NOT RUN — Docker is not installed in this WSL distro
  (`docker: command not found`). The integration tree was typechecked (acceptance-1 stub updated); CI must run it.
- **Non-vacuity** (every probe restored; sha256 verified against saved copies each time):
  - base `venue.ts` + `loop.ts` restored together: 59 failures in `test/unit/simulation` + `apps/trader` — every
    SIM-2 venue pin (21), every new loop pin, and many existing tests (the doubles and `replay.ts` now call the new
    members). Base `loop.ts` alone on the new venue: the 2 000-order run fails (`event 4: expected 12 to be 0`
    snapshot calls), the cursor-behind-retention pin fails (the old loop silently misses evicted fills: no halt),
    the TRDR-4 exact shape fails on `heldUnowned`; the 12-slice ordering and IF-06 pins PASS with the old loop (they
    pin preserved behaviour) — and e2e 7/157 + replay 3/17 still pass (the venue change alone is byte-neutral).
  - reversed comparator: e2e determinism-golden and the backtest static-bracket golden FAIL, plus the 12-slice pin.
    Insertion order (no sort): goldens pass (their plans are single-slice), ONLY the 12-slice pin fails.
  - cursor advanced before booking (drain-like): the IF-06 pin fails (`expected 1 to be 11`).
  - 9 venue mutants (tombstones ignored; retained ignored; cancel-plan/cancel-by-id live-only; runReplay no refusal;
    runReplay serializes `restingBands()`; Tier 0 holds trades; `fillsSince` answers short; terminal stays live) and
    5 loop mutants (no held tracking — also trips BOTH existing TRDR-4 defensive pins; no lost-answer tracking;
    silent owned miss; no terminal-record fallback; silent cursor refusal): every one killed.
- Timing and size probes: see summary; scripts under `scratchpad/sim-2/probe/`.

## assumptions
- The simulator's `simulatedOrderId` equals `plannedOrderId` (as `#orderRecord` builds it); `orderByPlannedId` relies on
  that and confirms it; the loop still relies on neither.
- Tier 1 is not reachable from the shipped trader (main.ts builds `tier0Model`), so leaving Tier-1 trades unbounded is
  a backtest-only cost.
- Reusing `VENUE_OBSERVATION_FAILED` (RECONCILE_ACCOUNT) for a venue history miss avoids widening the halt vocabulary
  that `apps/control-api` reads; the detail text distinguishes the cause.
- A placement whose `submit` rejects makes `drain()` reject (pump propagates it); the tracking keeps the old release
  semantics for any process or test that carries on.

## deviations
- Test placement: the long synthetic run and three loop pins live in `apps/trader/src/loop-long-run.test.ts` (its
  harness, parametrized) rather than a new file, to reuse the TRDR-4 harness.
- Default bounds changed from the first draft after measuring (see plan revision).
- `#terminalSeen` and the lost-answer tracking in `#submitPlan` go slightly beyond the packet's letter, to keep
  SIM-1's carried requirement unconditional and the old scan's release semantics for a thrown `submit`.
- `test/e2e/support/**` untouched (no accessor was renamed).

## known_risks
- Visibility is bounded for orders the loop has NOT yet read terminal: an order would have to go terminal and be
  evicted within one event (> 50 000 terminal orders) to miss; that miss halts GLOBAL (loud, fail closed).
- A planned order of a lost answer that the venue never booked stays in `#heldUnowned` for the life of the process
  (bounded by lost answers; each one also rejects `drain()`), and its absence is not reported, because "never booked"
  and "evicted" are indistinguishable for it.
- `fillsSince` copies each answered fill (`ownFrozenTree`), O(new fills) per event.
- A harness that reads `ordersSnapshot()`/`fills` itself (the e2e artifact capture) gets a window after an eviction;
  only `runReplay` refuses. With the defaults no fixture comes near a bound (pinned).
- The per-event lookup count (~110, max 515) is constant but not small; each is an O(1) Map read.
- Timings are single-machine WSL2 measurements; the CI runner will differ. The new long run is ≈ 8 s locally and yields
  every 30 events.

## follow_up
- `SIM2-TIER1-TRADES`: bound Tier-1 trades — an incremental band walk (IF-15b) plus a trim point once the `Clock`
  port's monotonicity is settled (IF-15).
- A health seam for `retention()` with `TRDR4-GAUGES` (control-api closed grammar; paper-e2e golden impact).
- The e2e harness could assert `retention().historyEvicted === false` when it captures the artifact (test/e2e/support).
- `LOOPMEM-FOLD` dominates per-event time (ledger re-fold per evaluation), now the main growth once the venue is flat.
- Governance: record SIM-2 in `IMPLEMENTATION_STATUS.md` and `docs/handoffs/` (outside this package's paths).
- Run the trader Testcontainers suite on GitHub CI (Docker unavailable here).

## commit_sha
`7c570edf584c1033c4fe6415b1aedcb2c8a7bda6` on branch `sim-2` (base `d2a8e93`), one commit, not pushed.

---

# Appendix B — implementer handoff, r1 (verbatim)

# SIM-2 handoff, round 1 (remediation of 7c570ed)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-sim-2`, branch `sim-2`, on top of
`7c570edf584c1033c4fe6415b1aedcb2c8a7bda6` (base `d2a8e93`).

## plan (written before any edit)

Findings read in full (`codex-r1.out`), gates (`gates-r1.txt`), r0 handoff. Prerequisites: worktree clean at
7c570ed; no Docker (disclosed again at the end).

### SIM2-R1-1 (HIGH) — terminal orders disappear before the loop sees them
Root cause: a terminal order enters the bounded, evicting map the moment it becomes terminal, so one door
call that ends more orders than the bound (a ten-slice FILLED submission, a market cancel, an expiry or a
DELAYED batch) evicts some before any consumer could look. A loop-side cache cannot fix that (the verifier
says so, rightly). Fix at the VENUE: **a terminal order is HELD until its consumer ACKNOWLEDGES it.**
- venue: `#unacknowledged` (terminal, not yet acknowledged; NEVER evicted) between the live index and the
  bounded `#terminalOrders`; new `acknowledgeTerminal(venueOrderId): boolean` moves one order into the
  bounded log (which may then evict the oldest ACKNOWLEDGED one). Lookups, the duplicate guard,
  `ordersSnapshot()` and cancel-by-id read live ∪ unacknowledged ∪ retained. `retention()` gains
  `awaitingAcknowledgment`. A venue nobody acknowledges (runReplay-only drivers, tests) keeps every terminal
  order, exactly as before SIM-2 — its §12.4 history is all of it anyway.
- loop: acknowledges when it is DONE with an order, never earlier: at `#settle`; at the release of a
  `#heldUnowned` order; and — for a BASKET-watched order — only once its watch has concluded (new
  `#watchedOrders`; otherwise a settled leg could be evicted and the watch would read it as "still working"
  for ever — the same class, found while fixing R1-1). `#terminalSeen` (r0's loop-side cache) is removed: the
  venue now holds what the loop has not finished with, so the cache is redundant; `retainedOrderState()`
  drops `terminalSeen`, gains `watchedOrders`. A miss for an owned, held or watched order stays LOUD.
- `TraderVenue` gains `acknowledgeTerminal`; every structural implementer updated.

### SIM2-R1-2 (HIGH) — tombstone eviction re-permits a duplicate
Fix: a bounded, deterministic **evicted-id filter** (a Bloom filter, `retention.evictedIdFilterBits`, default
2^24 bits = 2 MiB, 7 hashes, FNV-1a double hashing): every id whose TOMBSTONE is evicted is folded in. It
never forgets an id (no false negatives), so a reused id is ALWAYS refused; when it matches an id the exact
memory no longer holds, the plan is refused `SIMULATED_VENUE_ORDER_ID_NOT_PROVABLY_UNIQUE` (new code) and
COUNTED — uniqueness that cannot be established is refused, never assumed (the verifier's second option,
made bounded). A false positive refuses a new id loudly; at the defaults ~1% after ~1.75 M folded ids. The
filter is empty unless a tombstone was evicted, so no fixture/golden changes.

### SIM2-R1-3 (MEDIUM) — a CANCEL answer omits orders it cancelled
Fix: `#cancelSync` accumulates each cancelled order's record AT THE TRANSITION and the CANCEL plan's `orders`
is built from those, never by a later lookup (independent of retention; also held by R1-1's fix).

### SIM2-R1-4 (MEDIUM) — a lost-answer order confirmed by lookup can vanish silently
Fix: the first successful lookup of a `#heldUnowned` entry PROMOTES it to its venue id, so a later miss halts
GLOBAL `VENUE_OBSERVATION_FAILED` with the hold preserved.

### SIM2-R1-5 (LOW) — documentation overstates retention guarantees
Fix: README §5 item 17, `venue.ts`/`retention.ts` docs and the `DEFAULT_VENUE_RETENTION` doc restated
precisely (the hold-until-acknowledged rule, the filter's guarantees and false positives, what a forgotten id
answers on cancel, "every fixture/golden/backtest at the default bounds" instead of "every run"); the
misnamed test is replaced by one that really evicts hundreds of orders past a reused id.

### Pins (each must FAIL on 7c570ed and pass here; proven by restoring 7c570ed's files)
- venue: ten FILLED in one submission / a market cancel of three / an expiry batch / a DELAYED batch, bound
  1: every terminal order still answers until acknowledged (R1-1); the CANCEL plan lists all three (R1-3);
  `dup` refused after its tombstone was evicted, and 300 acknowledged orders later (R1-2, R1-5); a filter
  false positive is refused and counted; a forgotten id's cancel reason is not UNKNOWN (R1-5).
- loop: the verifier's ten-slice probe (orders bound 1) — no halt, 10 releases, 0 open (R1-1); a ten-order
  cancellation batch at bound 1 (R1-1); a halted instance's two-slice FILLED entry at bound 1 is held until it
  settles (SIM-1 requirement, replaces r0's `forget`-based pin); a GTC basket whose settled YES legs must stay
  visible until its NO legs fill (watch concludes COMPLETE, no leak); lost-answer TP promoted then withheld →
  GLOBAL halt (R1-4).
- long run: `awaitingAcknowledgment ≤ owners`, the filter counters, no refusal.
Then every gate, twice for replay/e2e, and `git diff d2a8e93 -- test/replay-golden/` empty.

(Plan revision during implementation, disclosed: the basket-watch deferral was added while fixing R1-1 —
same class, not in the verifier's list; the pins were reordered so that each asserts BEHAVIOUR before any new
counter, so that at 7c570ed they fail on behaviour rather than on an `undefined` field.)

## finding table

| id | severity | status | pin(s) (fail at 7c570ed, pass at a0d0164) |
| --- | --- | --- | --- |
| SIM2-R1-1 | HIGH | FIXED — venue holds every terminal order until `acknowledgeTerminal`; loop acknowledges when done (settle / held release / watch end) | venue `SIM2-R1-1: … > a SUBMISSION batch: ten orders FILLED by one plan, bound 1 …` (`s00: expected undefined to be 'FILLED'`); `… > an EXPIRY batch …` (`undefined` not `EXPIRED`); `SIM-2 (7) … > a DELAYED batch resolves … HELD until acknowledged` (`fak-1: undefined`); loop `SIM2-R1-1, a SUBMISSION batch: ten slices FILLED in ONE submission …` and `SIM2-R1-1, a CANCELLATION batch …` (GLOBAL halt at 7c570ed); `SIM-1's requirement (SIM2-R1-1): … a halted instance's two FILLED slices at a bound of ONE` (`['GLOBAL','STRATEGY_INSTANCE']`); `SIM-2 r1 — a WATCHED basket's settled leg stays answerable …` (GLOBAL halt at 7c570ed; mutant M2 "no deferral" → watch never concludes) |
| SIM2-R1-2 | HIGH | FIXED — bounded never-forgetting evicted-id filter; unprovable ids refused `SIMULATED_VENUE_ORDER_ID_NOT_PROVABLY_UNIQUE`, counted | `SIM-2 (3) … > refused through the retained history, then a tombstone, then the evicted-id FILTER …` (7c570ed: `dup` ACCEPTED); `… > a reused id is refused however many orders ended since: 300 acknowledged orders past it, bounds 2 / 2` (7c570ed: accepted); `… > an id the filter cannot PROVE new is refused, counted — even one never used …` (7c570ed: never refused) |
| SIM2-R1-3 | MEDIUM | FIXED — `#cancelSync` returns the records written at each transition; CANCEL plan `orders` built from them | `SIM2-R1-1: … > a CANCELLATION batch (SIM2-R1-3): a market-scoped CANCEL plan over three resting orders, bound 1, lists ALL THREE` (7c570ed: `['c CANCELLED']`) |
| SIM2-R1-4 | MEDIUM | FIXED — first successful lookup promotes the `#heldUnowned` entry to its venue id | lifecycle `SIM2-R1-4: a LOST answer's order, once the venue has SHOWN it, is held by its venue id — its later disappearance HALTS, and the hold is kept` (7c570ed: no halt) |
| SIM2-R1-5 | LOW | FIXED (in scope: README / venue.ts / retention.ts / test names) | `SIM2-R1-1: … > SIM2-R1-5: a cancel naming a FORGOTTEN id answers what the venue can know …` (7c570ed: `SIMULATED_VENUE_UNKNOWN_ORDER`); the misnamed default-bounds test replaced by the 300-order evicting test above |

## summary

Round 1 remediates all five findings on top of `7c570ed`, goldens still byte-identical (`git diff d2a8e93 -- test/replay-golden/` empty).

- **SIM2-R1-1 (HIGH).** Root cause: a terminal order entered the bounded, evicting map the instant it ended, so a single
  door call ending more orders than the bound (a ten-slice FILLED submission, a market cancel, an expiry sweep, a
  DELAYED batch) evicted some before anyone could look; a loop-side cache of later lookups could not close that. Now
  the VENUE holds every terminal order (`#unacknowledged`: answered by `orderById`/`orderByPlannedId`, listed by
  `ordersSnapshot()`, refused as a duplicate, outside every bound, never evicted) until its consumer calls
  `acknowledgeTerminal(venueOrderId)`; only then may the bounded history (then tombstones, then the filter) take it.
  The trader loop acknowledges exactly when it is DONE: at `#settle`; at a `#heldUnowned` order's release; and, for a
  BASKET leg, only when its watch has concluded (`#watchedOrders`, `#forgetWatch`) — otherwise a settled leg could be
  evicted and the watch would read it as "still working" for ever (found while fixing, same class). r0's loop cache
  `#terminalSeen` is removed as redundant; `retainedOrderState()` swaps `terminalSeen` for `watchedOrders`;
  `retention()` gains `awaitingAcknowledgment`. `TraderVenue` gains `acknowledgeTerminal` (return ignored); every
  structural implementer updated. A watched-basket order the venue cannot answer for now halts loudly too.
- **SIM2-R1-2 (HIGH).** Past the exact memory (live, held, retained, tombstoned), every id whose TOMBSTONE is evicted
  is folded into `EvictedIdFilter` (`retention.ts`): a deterministic Bloom filter, `retention.evictedIdFilterBits`
  (default 2^24 bits = 2 MiB, max 2^31), 7 positions from two FNV-1a hashes (Kirsch–Mitzenmacher). No false negatives,
  so a reused id is refused however long ago it ended; a match is refused
  `SIMULATED_VENUE_ORDER_ID_NOT_PROVABLY_UNIQUE` (new code; whole plan, nothing booked) and counted in
  `retention().evictedIds.refused`. A false positive refuses a NEW id loudly — ≈1% after ≈1.75 M folded ids at the
  default size (i.e. after ≈1.9 M acknowledged terminal orders). The filter is empty until a tombstone is evicted, so
  no fixture/golden is affected. This is the verifier's second option ("refuse submissions whose uniqueness can no
  longer be established"), made bounded — no finite-horizon idempotency remains.
- **SIM2-R1-3 (MEDIUM).** `#cancelSync` returns `{ result, cancelledOrders }`, the records written AT each transition;
  a CANCEL plan's `orders` is built from them, never re-read. (Independent of retention by construction; with the R1-1
  hold a re-read could not miss either — see known_risks.)
- **SIM2-R1-4 (MEDIUM).** `#releaseSettledReservations` promotes a lost answer's `#heldUnowned` entry to the venue id
  the first time a lookup shows the order, so its later disappearance halts GLOBAL `VENUE_OBSERVATION_FAILED`
  ("… which it holds without an owner") with reservation, allocator and time-in-force kept.
- **SIM2-R1-5 (LOW).** README §5 item 17 rewritten (hold-until-acknowledged, who acknowledges, the unacknowledged venue
  keeps everything, the filter's guarantee and false-positive rate, cancel answers for forgotten ids — already
  terminal / probably terminal / UNKNOWN only when no memory matches, impossible for a booked id — and "every fixture,
  golden and backtest at the default bounds" instead of "every run"); `venue.ts` header, `VenueRetentionBounds`,
  `DEFAULT_VENUE_RETENTION`, `#knowsOrderId`, cancel comments; `retention.ts` header; `ports.ts`, `halt.ts`,
  `order-lifecycle.ts` claims. The misnamed "default bounds … however many orders ended since" test (200 orders, no
  eviction) is replaced by a 300-order test that really evicts past the reused id.

**Per-event venue time, same session, same harness** (`scratchpad/sim-2/probe/venue-time.probe.ts`, now also timing
`acknowledgeTerminal`; real CoreLoop + Tier-0 SimulatedVenue, 2 010 orders, WSL2 — growth shape, not a benchmark):

| config | base `d2a8e93` venue ms/event (first → last decile, overall) | r1 `a0d0164` | loop calls/event |
| --- | --- | --- | --- |
| light (20 fills, `PROBE_MAKER_EVERY=1000 PROBE_IMMEDIATE_FROM=100000`) | 0.82 → 2.72, overall 1.60 | 0.74 → 0.46, overall 0.51 | `ordersSnapshot` 13 (max 34) → 0; `acknowledgeTerminal` ≈ 5 |
| full (260 fills, defaults) | 0.92 → 4.48, overall 2.33 | 0.81 → 0.62, overall 0.59 | `ordersSnapshot` 13.5–14.3 (max 34) → 0; `acknowledgeTerminal` ≈ 5.1–5.5 |

(r0's figures for the same configs: light 0.67 → 0.45 / 0.50, full 0.82 → 0.58 / 0.60 — r1 is the same shape.) Total
per-event time still grows (`LOOPMEM-FOLD`): full 40.7 → 373.8 ms base vs 40.0 → 362.9 ms r1.

## files_changed
- `packages/simulation/src/venue.ts` — `#unacknowledged`, `acknowledgeTerminal`, lookups/duplicate guard/snapshot over
  the held set, `#evictedIds` + `SIMULATED_VENUE_ORDER_ID_NOT_PROVABLY_UNIQUE` refusal in `#preflight`, cancel records at
  transition (`#cancelSync` → `{ result, cancelledOrders }`), filter-aware cancel reasons, `retention()`
  (`awaitingAcknowledgment`, `evictedIds`), `VenueRetentionBounds.evictedIdFilterBits`,
  `DEFAULT_VENUE_RETENTION.evictedIdFilterBits = 16_777_216`, docs.
- `packages/simulation/src/retention.ts` — `TombstoneSet.remember` answers the evicted id; new `EvictedIdFilter`,
  `EvictedIdFilterCounters`, `MAXIMUM_EVICTED_ID_FILTER_BITS`; header.
- `packages/simulation/src/refusals.ts` — `SIMULATED_VENUE_ORDER_ID_NOT_PROVABLY_UNIQUE`.
- `packages/simulation/src/index.ts` — exports type `EvictedIdFilterCounters`.
- `packages/simulation/src/ports.ts`, `packages/simulation/README.md` — docs (R1-5).
- `apps/trader/src/loop.ts` — port `acknowledgeTerminal`; `#watchedOrders`, `#acknowledgeIfDone`, `#forgetWatch`;
  `#terminalSeen`/`#lookupOwned` removed; promotion in `#releaseSettledReservations`; watched-order miss halts;
  `RetainedOrderState.watchedOrders` (replaces `terminalSeen`); docs.
- `apps/trader/src/halt.ts`, `apps/trader/src/order-lifecycle.ts` — docs.
- `apps/trader/src/loop-long-run.test.ts` — 2 new pins; SIM-2 run asserts acks = settled per event, 0 held, filter
  counters; TRDR-4 run shape (`watchedOrders`) and no-hold/no-filter assertions; `acknowledgeTerminal` counted.
- `apps/trader/src/loop-order-lifecycle.test.ts` — `WrappedVenue.acknowledgeTerminal` (+ `acknowledged` log);
  `venueRetention` harness option; r0 SIM-1 pin rewritten on the real venue at bound 1; new R1-4 pin; owned-miss text.
- `apps/trader/src/loop-refused-plan.test.ts` — both doubles gain `acknowledgeTerminal`; `venueRetention` option; new
  basket pin; defensive pin asserts nothing left held.
- `test/unit/simulation/venue-sim2.test.ts` — 5 new pins, 2 rewritten (R1-2 encoded defect; R1-5 misnamed test),
  r0 tests adapted to the acknowledgment contract (`fillMany` and the runReplay driver acknowledge).
- `test/unit/simulation/doors.test.ts` — census entry `acknowledgeTerminal`.
- `test/integration/paper-trader/acceptance-1-max-run-mode.test.ts` — stub gains `acknowledgeTerminal`.

## tests_run
All in `/home/adriancova/proyects/tradeBot/polymarket-bot-sim-2`, every pnpm command prefixed
`pnpm_config_verify_deps_before_run=false`, final tree (`a0d0164`):
- `pnpm run typecheck` exit 0; `pnpm run lint` exit 0; `pnpm run check:deps` exit 0 (PASS).
- `pnpm run test`: **342 files / 7427 tests**, exit 0 (7c570ed: 342 / 7418; +9 — venue-sim2 +5, loop-long-run +2,
  loop-order-lifecycle +1, loop-refused-plan +1).
- `pnpm run test:e2e` twice: 7 / 157 both, exit 0 (determinism-golden included).
- `pnpm run test:replay` twice: 3 / 17 both, exit 0.
- Simulation determinism + golden-replay + backtest static-bracket, twice: 3 files / 25 tests both.
- `git diff --quiet d2a8e93 -- test/replay-golden/`: exit 0 (empty); worktree golden diff empty.
- `loop-long-run.test.ts` alone: 7 tests ≈ 14 s (SIM-2 run ≈ 8 s; CI-2 tripwire ≈ 60 s).
- `pnpm --filter @polymarket-bot/trader test:integration`: NOT RUN — `docker` is not installed in this WSL distro
  (`timeout 20 docker info` → "The command 'docker' could not be found"). The acceptance-1 stub was typechecked.
- **Non-vacuity vs 7c570ed**: 7c570ed's `venue.ts`, `retention.ts`, `refusals.ts`, `index.ts`, `loop.ts` restored
  (sha256 matched `git show 7c570ed:…`), run through a scratch config whose setup file shims a no-op
  `acknowledgeTerminal` onto the 7c570ed venue (7c570ed moved terminal orders into history at once, so that IS its
  behaviour), so failures are behavioural: 21 of 77 fail in the four files, every finding pin among them with the
  behavioural assertion in the table above (other failures: r0 pins adapted to the new shape/text, and the 2 000-order
  run whose `placed()` is NaN without `awaitingAcknowledgment`). Without the shim 30 fail (API errors included).
  Restored: `sha256sum -c` OK for all five.
- **Mutants at r1** (scratch `mutants-r1.py`, each restored by sha): M2 no watch deferral → basket pin fails; M3 no
  acknowledgment at settle → 3 long-run pins fail; M4 acknowledge at the first terminal read → SIM-1 halted-instance pin
  fails; M5 no promotion → R1-4 pin fails; M6 guard ignores the filter → 3 R1-2 pins fail; M8 cancel reason ignores the
  filter → R1-5 pin fails; M9 venue sends terminal orders straight to the bounded log → 9 hold pins fail. All killed.
- r0's ordering pins (12-slice `:o10` before `:o2`, reversed-comparator golden failures) are untouched by r1 (no
  iteration-order code changed) and pass in the suite.

## assumptions
- The consumer that acknowledges is the trader loop (shipped trader via `main.ts`, the e2e harness and the backtest
  composition all go through `createPaperTrader`/`CoreLoop`). A live adapter may implement `acknowledgeTerminal` as a
  no-op (a venue that forgets nothing needs no acknowledgment).
- The simulator's `simulatedOrderId` equals `plannedOrderId`, so the filter keyed on booked ids also guards planned ids.
- Reusing `VENUE_OBSERVATION_FAILED` for a watched-basket miss (as for owned/held misses) keeps the halt vocabulary
  `apps/control-api` reads unchanged.
- A new refusal code in `packages/simulation` is within this package's scope (the trader does not branch on refusal
  codes; a refused plan takes the existing NEITHER release path).

## deviations
- r0's `#terminalSeen` and `RetainedOrderState.terminalSeen` (introduced by this package in r0, not pre-existing) are
  removed; `watchedOrders` replaces the field. The r0 pin "SIM-1's requirement … even after the venue's history evicted
  it — no halt" (built on `WrappedVenue.forget`) is REPLACED: under the new contract a venue that forgets an
  unacknowledged order is broken and the loop halts (still pinned by the owned-miss pin); the requirement itself is
  now pinned with the REAL venue at a bound of one, which is stronger.
- Two r0 venue pins changed because the verifier identified them as encoding the defects: the tombstone test that
  ACCEPTED a reused id, and the misnamed default-bounds test.
- The basket-watch deferral and the watched-order miss halt go beyond the verifier's list (same class as R1-1).
- The owned-miss halt text changed ("which this process has not acknowledged: evicted … regardless, or never held");
  its r0 pin updated.

## known_risks
- **A venue nobody acknowledges holds every terminal order** (`awaitingAcknowledgment` grows, as before SIM-2): a
  `runReplay` driver with its own `coreLoop` hook, or a test. Every shipped composition acknowledges through the loop.
  No cap was added: a cap would have to refuse placements or evict unread orders — the defect this round removes.
- An owned order the loop never settles (a settle mismatch, an instance halted for ever) stays held at the venue —
  bounded by the loop's owned set, exactly what r0's `#terminalSeen` held.
- **Filter false positives** refuse a NEW id loudly (counted); probability grows with folded ids (≈1% at ≈1.75 M at the
  default size; it only starts after 150 000 acknowledged orders). At saturation every new id is refused — loud and
  fail-closed, but a denial of service for a very long run; `evictedIdFilterBits` is the knob. No per-id retry exists.
- R1-3's transition-record change is not separately observable while the R1-1 hold stands (a re-read cannot miss an
  unacknowledged order either); both are pinned together (the 7c570ed restore breaks both).
- The fill log is still bounded with a loud cursor refusal (not held until consumed) — accepted in round 1.
- `#judgeBasketWatches` now halts on a watched order the venue cannot answer (previously treated as working, silently).
- Timings are single-machine WSL2; the CI runner will differ.
- Tier-1 trades remain unbounded (`SIM2-TIER1-TRADES`).

## follow_up
- `SIM2-TIER1-TRADES` (unchanged from r0).
- A health seam for `retention()` — now including `awaitingAcknowledgment` and `evictedIds.refused` — with
  `TRDR4-GAUGES`.
- Optional symmetry: hold fills until the loop's cursor passes them (as orders are held until acknowledged), if the
  fill bound is ever set near per-event volumes.
- `LOOPMEM-FOLD` dominates per-event time.
- Governance: record SIM-2 in `IMPLEMENTATION_STATUS.md` and `docs/handoffs/` (outside this package's paths); note the
  new refusal code and the `TraderVenue.acknowledgeTerminal` contract.
- Run the trader Testcontainers suite on GitHub CI (Docker unavailable here).

## commit_sha
`a0d0164f1dc24f50ac45b7df25a58cfc96c9666c` on branch `sim-2`, on top of `7c570edf584c1033c4fe6415b1aedcb2c8a7bda6`
(no amend, no rebase), not pushed.
