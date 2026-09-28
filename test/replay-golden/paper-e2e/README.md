# Replay-golden fixture — paper end-to-end run (WP-250)

Consumed by `test/e2e/determinism-golden.test.ts`, and read as a document by
`test/e2e/traceability-chain.test.ts`,
`test/e2e/traceability-chain-negative.test.ts`,
`test/e2e/projection-reconciliation.test.ts`,
`test/e2e/reconciliation-attribution.test.ts` and
`test/e2e/two-brackets.test.ts` — and, for their order and fill counts, by the
`SIM-2` retention census in `test/unit/simulation/venue-sim2.test.ts`.

`paper-e2e-run.json` is the canonical byte form of ONE deterministic paper run
of the merged core — `apps/trader`'s composition root driving the real books,
feature engine, strategy runtime, Static Bracket strategy, capital allocator,
risk engine, execution planner, `SimulatedVenue`, ledger and PnL engine.

`two-brackets-run.json` (`BRACKET-1b`) is a SECOND golden of the same kind, of
a second scenario (`test/e2e/support/scenarios/two-brackets.ts`): two brackets
in one market, the first closed by a protective reduction, the second by a
FILLED take-profit. It has its own section below,
["The two-bracket golden"](#the-two-bracket-golden-two-brackets-runjson-bracket-1b).
It is also read by `test/e2e/two-brackets.test.ts`. Both files are SIMULATED
evidence (`SIMULATED_NOT_REAL_EVIDENCE`); see "Provenance".

## Relationship to `pnpm test:replay`

None. §12.4's replay gate is `test/replay-golden/order-book/` (`WP-090`) and
`test/replay-golden/simulation/` (`WP-210`), run by `pnpm test:replay`, and
`WP-250` does not touch it. This golden is a THIRD artefact of the same kind,
over a different subject — the paper-core end-to-end surface `WP-230` and
`WP-240` assembled — and it is compared by `WP-250`'s own suite, which the root
`pnpm test:e2e` script runs (orchestrator-wired in `da37a0c`; the root
`package.json` is a protected path).

## What the bytes contain

| Key | What it is |
| --- | --- |
| `scenario` | the identities, sizes, prices and fee schedule `test/e2e/support/scenario.ts` states |
| `events` | the eight recorded §7.1 events, by id and ingest sequence |
| `decisions` | every PERSISTED `DecisionRecord`, as it reached the durable-store port |
| `checkpointInstants` | one per persisted decision, at the evaluation's own instant |
| `traces` | the §6 invariant 4 chains the run produced — one per FILL, so an order that never filled is on none |
| `orderProvenance` | every order's §6 invariant 4 trace PREFIX as the loop recorded it at SUBMISSION (`CoreLoop.orderProvenance()`), filled or not, in submission order — golden format 2 (`RECON-2`) |
| `orders` / `fills` | what the simulated venue booked and produced |
| `ledgerTransactions` | the append-only postings, entry by entry |
| `pnlRecords` / `pnlSnapshots` | the §9.16 stream and the rows written to the store |
| `ledgerProjection` | the §6 invariant 8 fold: balances, virtual positions, and the two "nothing unexplained" counts |
| `health` | every §14.3-shaped counter the run moved, plus `accounting.realizedPnl` (below), and — golden format 3 (`TRDR-4`) — `seams.orders` (the loop's per-order state: `tracked`, `settled`, the settled-order tombstones, `unownedFills`, `lateFillsAfterSettlement`, `settleMismatches`) and `seams.retention` (`retained / maximumRetained / evicted` for the decision, trace and provenance logs — all `evicted: 0` here, which PINS that this fixture evicts nothing) |
| `reconciliation` | the projected-vs-realized table, with each difference's named mechanism |

### The `TRDR-4` regeneration (golden format 3): terminal order views are evaluated once

The user's ruling R1 (2026-09-26) changed the core loop's delivery rule. A
WORKING order's view is still delivered through `onOrderUpdate` on every
harvest; a TERMINAL order's view is delivered until ONE delivery has been
evaluated by the strategy, and then the order is RETIRED — no further
delivery, and out of `ctx.orders()`. Before R1 every order ever placed was
re-delivered on every harvest. This run's six re-deliveries of already
evaluated terminal views — old `evaluationSeq` 7 (the entry, at 09:00:03),
11 and 12 (the entry and the withdrawn take-profit, at 09:14:49), and 15, 16
and 17 (all three orders, at 09:14:50), each an `onOrderUpdate` `hold` with
reason `SB.IDLE` and no intent — are gone, so `decisions` has 12 records, not
18, and `checkpointInstants` 12 entries. Later records renumber: the reduce
decision `9 → 8` (and with it the reduce's `traces` and `orderProvenance`
`evaluationSeq`), its fill's `onFill` `10 → 9`, the reduce order's own
terminal view `13 → 10`, `onMarketClosing` `14 → 11`. The health counters
follow (`loop.evaluations`, `decisionsPersisted`, `featureSnapshots` `18 → 12`;
`seams.orderViews` `emitted 10 → 4`, `repeats 6 → 0`, `tracked 3 → 0`), and the
two new seams appear. Every order, fill, ledger transaction, PnL record, PnL
snapshot, projection line and reconciliation row is identical — proven
section by section, with the removed decisions identified by the order each
one delivered, in the round's handoff. The take-profit's placing `exit`
decision is still `evaluationSeq 2`.

### The `BRACKET-1a` regeneration: the run now ends CLOSED, not PAUSED

`RISK-2` residual 5 was recorded here as two decisions. The protective
reduction had no order track, so its own fill (`evaluationSeq 9`, `onFill`)
read `SB.UNATTRIBUTED_FILL, SB.POSITION_MISMATCH, SB.NO_BLIND_FLATTEN,
SB.PAUSED` with `modelOutputs {expectedShares: "50", heldShares: "0"}`, and
`onMarketClosing` (`evaluationSeq 11`) resumed and paused again (`SB.RESUMED,
SB.EXIT_CUTOFF, SB.RESOLUTION_HOLD_DISALLOWED, SB.POSITION_MISMATCH,
SB.NO_BLIND_FLATTEN, SB.PAUSED`, the same model outputs). `BRACKET-1a` gave the
reduction its track (`packages/strategies/static-bracket`, the user's rulings
R1–R3), and the regeneration — ONCE, from the restored base bytes — moved
exactly those two records and nothing else:

- `decisions[9]` (`onFill`, still `hold`): `SB.EXIT_FILLED, SB.CLOSED`, model
  outputs `{}`. The reduction's track is `PENDING` and id-less (the fill
  precedes the order's view), so the fill matches it by leg and side;
  `applyExitFill` folds the 50 shares, the allocation is flat, and
  `EXIT_PLANNED --EXIT_FILL_COMPLETE--> CLOSED`.
- `decisions[11]` (`onMarketClosing`, still `hold`): `SB.REFUSED_MAXIMUM_ENTRIES`,
  model outputs `{}`. The instance is `CLOSED`, so the ladder reaches
  `planRearm`, which checks `maximum_entries_per_market` (1, spent) before the
  cool-down.

`decisions[10]` (the reduction's own `FILLED` view) is unchanged at `SB.IDLE`:
the bracket already cleared the track, exactly as before. Every other section —
`checkpointInstants`, `events`, `fills`, `goldenFormatVersion`, `health`,
`ledgerProjection`, `ledgerTransactions`, `orderProvenance`, `orders`,
`pnlRecords`, `pnlSnapshots`, `reconciliation`, `scenario`, `traces` — is
byte-identical, and every number outside `decisions` is the same multiset
(proved mechanically in the round's handoff). No economic value moved: the
money was always right; what moved is the strategy's account of it.

### The `SNAP-1` regeneration: one PnL snapshot per instance per instant

`BRACKET-1c` found that this golden held a shape the durable store refuses:
TWO `pnlSnapshots` rows for one instance and market at `2026-05-01T09:00:02Z`
(the entry's `30 @ 0.34` and `20 @ 0.35`, one row per fill), while
`accounting.pnl_snapshots_scope_unique` is `unique nulls not distinct (scope,
environment, account_ref, instance_id, market_id, as_of)`. The durable trader
GLOBAL-halted on the second row; the in-memory store accepted it, which is how
this file came to hold it (`BRACKET1C-SNAPKEY`). The user ruled "one snapshot
per instance per instant" (2026-09-28): the loop now computes the row at every
fill exactly as before and WRITES, once per harvest, the row of each
instance's LAST fill at that instant (`apps/trader/src/loop.ts`,
`#stagePnlSnapshot` / `#flushPnlSnapshots`), and `MemoryTraderStore` enforces
the same key. The regeneration — ONCE, from the verified base bytes, with
`WP250_WRITE_GOLDEN -t "paper-e2e"` — removed exactly the FIRST `09:00:02Z`
row (the state after the `30 @ 0.34` fill: `capitalCommitted 10.2`,
`feesPaid 0.131`, `coreNetPnl -0.131`) and nothing else: `pnlSnapshots` goes
from three rows to two, and the two it keeps are byte-identical to base's
second and third rows — the LAST row base wrote at each instant. Every other
section, `health` included (no counter counts snapshots), is byte-identical,
and every number outside `pnlSnapshots` is the same multiset (proved
mechanically in the round's handoff). `two-brackets-run.json` did not move:
each of its instants has one fill.

### `health.accounting.realizedPnl` reads "no snapshot observed" here — deliberately, and why

`TRDR-3` (2026-09-17) gave the trader's health surface `accounting.realizedPnl`:
`byInstance` (the latest `PnlSnapshot.realizedPnl` the durable store accepted,
per instance, EXACT decimal strings) and `account` (their exact
`@polymarket-bot/decimal` sum, or `null` while no snapshot has been observed).
The value is observed at the STORE PORT: `apps/trader/src/main.ts`'s
`assembleDurableTrader` wraps the store with `observeRealizedPnl` and attaches
the resulting `RealizedPnlBook` to the health state. `test/e2e/support/harness.ts`
calls `createPaperTrader` directly with a bare `MemoryTraderStore` and attaches
no book, so this golden carries

```json
"realizedPnl": { "account": null, "byInstance": {} }
```

— an ABSENT measurement, stated as such, not a `"0"`. The regeneration that
added it moved exactly these four lines and nothing else. The same run's
last snapshot's `realizedPnl` (`pnlSnapshots[1]` since `SNAP-1`; it was
`pnlSnapshots[2]`) is `"-1.2"`, so a harness that attached the book
the way the composition root does (or a `createPaperTrader` that wrapped its
own store — the follow-up `TRDR-3`'s handoff names) would make the field read

```json
"realizedPnl": { "account": "-1.2", "byInstance": { "e18f5c20-2000-7a20-8b00-000000000002": "-1.2" } }
```

and nothing else. Until then, the composed value is proven where the composition
root runs: `test/integration/paper-trader/trader-health-endpoint-postgres.test.ts`
(real PostgreSQL, `GET /health` serving `-1` after `BUY 50 @ 0.34` /
`SELL 50 @ 0.32`, equal to the persisted `realized_pnl` column).

## What the bytes deliberately do NOT contain

- `DecisionTelemetry.evaluationDurationUs` — `packages/strategy-runtime`
  documents it as "machine-dependent by nature; excluded from `DecisionRecord`
  so §12.4 byte-identity holds". A golden that froze it would freeze the host.
- `HealthSnapshot.riskSeamCaveat` — a prose constant owned by `apps/trader`.
  `test/e2e/residuals-observed.test.ts` pins it BY IDENTITY against the exported
  `RISK_SEAM_CAVEAT`, which is drift-proof; copying its text here would make an
  upstream wording fix look like a determinism failure.

## The canonical form

`test/e2e/support/canonical-json.ts`: object keys sorted recursively, two-space
indentation, LF endings, one trailing newline. Every `number` must be a SAFE
INTEGER, so §6 invariant 1's rule — economic values are canonical decimal
STRINGS — is enforced by the serialiser rather than assumed; a float that leaked
into an economic field would be refused by name and path instead of frozen.

## The arithmetic, derived by hand

Every economic number below can be checked without running anything.

**The book.** YES asks `0.34 × 30` then `0.35 × 40`; YES bids `0.32 × 200`,
`0.31 × 300`.

**The trigger.** The executable buy price for 50 shares is
`(30 × 0.34 + 20 × 0.35) / 50 = (10.2 + 7) / 50 = 17.2 / 50 = 0.344`, which is
`≤ 0.35`, so the Static Bracket enters. The value is exactly representable, so
the fixture depends on no rounding policy to fire.

**The fills.** §12.2's Tier-0 immediate model consumes the observed depth and
emits ONE FILL PER CONSUMED LEVEL, so the 50-share entry produces two fills,
`30 @ 0.34` and `20 @ 0.35`, and therefore TWO complete §6 invariant 4 chains
from one decision. The protective reduction at the exit cutoff sells all 50
against the resting bid in one fill, `50 @ 0.32` — the THIRD chain. The
take-profit rested and never filled, so it is on no chain; its origin is its
`orderProvenance` record, which names the `exit` decision at `evaluationSeq 2`.

**The fees.** The schedule is taker `0.0195`, maker `0`, HALF_UP at 3 decimal
places, minimum `0`. The formula is `shares × rate × price × (1 − price)`:

| Fill | Exact product | Rounded | Direction |
| --- | --- | --- | --- |
| `30 @ 0.34` | `30 × 0.0195 × 0.34 × 0.66 = 0.131274` | `0.131` | DOWN |
| `20 @ 0.35` | `20 × 0.0195 × 0.35 × 0.65 = 0.088725` | `0.089` | UP |
| `50 @ 0.32` (exit) | `50 × 0.0195 × 0.32 × 0.68 = 0.21216` | `0.212` | DOWN |

The two entry fills round in OPPOSITE directions on purpose: a rounding rule
observed only downward is a rule half observed. Entry totals: exact `0.219999`,
charged `0.22`. With the exit: exact `0.432159`, charged `0.432`.

**The ledger.** Entry principal `10.2 + 7 = 17.2`, exit proceeds
`50 × 0.32 = 16`, fees `0.432`, so the instance's collateral line is
`16 − 17.2 − 0.432 = −1.632`. The position is flat, and the projection carries
NO outcome-token line for a zero balance. Nine transactions — principal, token
movement and fee, once per fill.

**The PnL.** Two snapshots, one per instant with fills (`SNAP-1`: one row per
instance per instant, the state after the LAST fill booked at it; three before
`SNAP-1`, one per fill). After the entry's two fills, both at `09:00:02` (the
first snapshot, marked at the second fill's price `0.35`):
`capitalCommitted = 17.2`, `feesPaid = 0.22`,
`unrealizedPnlMidpoint = 0.3`, so `grossTradingPnl = 0 + 0.3 = 0.3`,
`coreNetPnl = 0.3 − 0.22 = 0.08` and
`worstCaseResolutionPnl = realizedPnl − Σ open cost basis = 0 − 17.2 = −17.2`.
After the exit (the final snapshot): the whole average-cost basis `17.2` leaves
with the 50 shares, so `realizedPnl = 16 − 17.2 = −1.2`,
`capitalCommitted = 0`, `unrealizedPnlMidpoint = 0`, `feesPaid = 0.432`,
`grossTradingPnl = −1.2`, `coreNetPnl = −1.2 − 0.432 = −1.632` and
`worstCaseResolutionPnl = −1.2 − 0 = −1.2`.

**The round trip against its projection.** The entry intent carries
`expectedNetEdge = 0.5 × 50 − 17.2 − (0.001 + 0.001) × 50 = 25 − 17.2 − 0.1 =
7.7`. The realized round trip is `16 − 17.2 − 0.432 = −1.632`, and the
difference `−9.332` is named in full on `exit.expected_net_edge`:
`EXIT_BELOW_TAKE_PROFIT` `16 − 0.5 × 50 = −9` (the protective reduction sold at
`0.32`, not the take-profit `0.5`), `FEE_MODEL_BASIS`
`−(0.432159 − (0.001 × 50 + 0.001 × 50)) = −0.332159` and
`FEE_ROUNDING_HALF_UP` `−(0.432 − 0.432159) = +0.000159`. The position is
closed at run end, so `POSITION_OPEN_AT_RUN_END` (`RECON-2`, present only when
shares are still open) does not appear. (Before `RISK-2` this paragraph was
"the projection with no realized value": the exit was refused at the risk seam
as the accepted `WP-220` residual. That residual is fixed and
`risk.refusedExits` is `0`.)

**The projection with no realized value.** The take-profit, `30 @ 0.5`, rested
and was withdrawn unfilled (§6 invariant 13's cancel-before-replace, because
the confirmed allocation grew after it had been sized). `exit.cancelled_proceeds.…d000:g0:o0`
projects `0.5 × 30 = 15`, and its realized value is an ABSENCE, not a zero
(`RESTING_EXIT_CANCELLED_UNFILLED`). The row names what was withdrawn — the
take-profit the `exit` decision at `evaluationSeq 2` placed — from the order's
provenance record, because no trace names an order that never filled.

## Regenerating

```
WP250_WRITE_GOLDEN=1 pnpm vitest run --config test/e2e/vitest.config.ts test/e2e/determinism-golden.test.ts -t "paper-e2e"
WP250_WRITE_GOLDEN=1 pnpm vitest run --config test/e2e/vitest.config.ts test/e2e/determinism-golden.test.ts -t "two-brackets"
```

The regeneration REWRITES the golden of every scenario whose determinism test
runs — so name ONE with `-t` (the describe block is
`deterministic golden output — <scenario name>`) — and then FAILS ON PURPOSE.
It can therefore never be the step that turned a red suite green: read the
diff, decide whether the change is intended, re-derive the arithmetic above if
an economic value moved, and re-run WITHOUT the variable.

## `health.accounting.pnlRecords` is TWICE the `pnlRecords` array — by construction (`N1`)

`GOV-2B`'s `N1` asked what the counter counts, since `paper-e2e-run.json`
carries `health.accounting.pnlRecords` **12** beside a top-level `pnlRecords`
array of **6**. The answer, read from the code (`BRACKET-1b`; nothing here
changes it):

- `packages/ledger/src/fill-posting.ts` emits the §9.16 PnL records of a fill
  PER OWNER STREAM: one for the ACTUAL account and one for each claiming
  instance (`owners = [ACTUAL_ACCOUNT, ...slices]`), each a `TRADE` record plus
  a `FEE` record when — and only when — the fee is not zero
  (`!isZeroDecimal(slice.fee)`, `fill-posting.ts:409`; the `PLATFORM_FEE`
  ledger transaction has the same guard at `:355`).
- `apps/trader/src/loop.ts` counts EVERY record the posting returned
  (`countAccounting("pnlRecords", posted.pnlRecords.length)`, `#harvestFills`,
  and the same line for an unowned fill in `#bookUnownedFill`), and keeps in the
  instance's stream only the records that name that instance
  (`VIRTUAL_STRATEGY`, `instanceId`).
- The artefact's `pnlRecords` is `loop.pnlRecords(instanceId)` — that ONE
  stream.

So for a run whose every fill is owned by the one instance and claimed by it
whole, the counter is exactly `2 × pnlRecords.length`, and
`pnlRecords.length = Σ over fills of (1 + [fee ≠ 0])`. `paper-e2e-run.json`:
three taker fills, `3 × 2 = 6` records, counter `12`. `two-brackets-run.json`:
three taker fills and one zero-fee MAKER fill, `3 × 2 + 1 = 7` records,
counter `14`. The counter is NOT wrong — it counts a different, larger set (the
account's stream too) than the array carries. `test/e2e/two-brackets.test.ts`
pins the ratio and the per-fill count in BOTH goldens. (An unowned fill would
break the ratio on purpose: it adds account records and no instance record.)

## The two-bracket golden (`two-brackets-run.json`, `BRACKET-1b`)

SIMULATED evidence of the `BRACKET-1b` round (ruling R1 under `BRACKET-1a`):
an instance that survives its own protective reduction, re-arms, enters again,
and closes the second bracket through a FILLED take-profit. It is the first
recorded run in which a take-profit fills (`RISK2-R6`) and the first whose
filled order was placed by an evaluation the loop originated
(`RECON2-EVENTHOP`). It does NOT close handoff §7 item 1: `BRACKET-1c` (a
durable round trip) follows, and the verdict belongs to a fresh closeout.

The scenario is `test/e2e/support/scenarios/two-brackets.ts`: the original
scenario's market, identities, fee schedule, environment and operator
document, with ONE configuration delta — `reentry.maximum_entries_per_market`
`2` (`cooldown_seconds` stays `30`) — and its own `idNamespace`
(`wp-250-paper-e2e-two-brackets`), so its minted ids differ from the original
golden's. The `scenario` section of the two goldens therefore differs in
`idNamespace` only.

### The arithmetic, derived by hand BEFORE the first capture

Written from `packages/strategies/static-bracket/src/decide.ts`,
`apps/trader/src/loop.ts`, `packages/simulation/src/tier0.ts` and
`packages/ledger/src/fill-posting.ts` before the scenario had ever been run;
the capture is compared against it, not pasted over it (see
"Capture and comparison" below).

**The books.** YES bids `0.32 × 200`, `0.31 × 300` throughout. YES asks
`0.34 × 60`, `0.35 × 40` for bracket 1 (events 4, 6, 7) and `0.33 × 60`,
`0.35 × 40` for bracket 2 (events 8, 11). NO `0.65 / 0.66 × 200`.

**The events** (`ingestSeq`, `receivedAt`): 1 `08:59:58` and 2 `08:59:59`
reference trades; 3 `09:00:00` `MarketOpened`; 4 `09:00:01` YES book; 5
`09:00:02` NO book; 6 `09:03:05` YES book; 7 `09:03:06` YES book; 8 `09:03:40`
YES book (the new asks); 9 `09:03:41` NO book; 10 `09:04:00`
`PublicTradeObserved` YES `0.5 × 60`; 11 `09:04:10` YES book. Events 1-3
produce no evaluation (no book yet: `snapshotsUnavailable 3`).

**The decisions** (19; `evaluationSeq`, callback, type, reason codes):

| seq | event | callback | type | reason codes | what happened |
| --- | --- | --- | --- | --- | --- |
| 0 | 4 | onFeatures | hold | `SB.ARMED` | DORMANT → ARMED |
| 1 | 5 | onFeatures | enter | `SB.ENTRY_TRIGGER_MET`, `SB.ENTRY_LEG_DIRECT`, `SB.ENTRY_INTENT_EMITTED` | executable buy price for 50 = `0.34` ≤ `0.35`; model outputs `trigger 0.34`, `entryCost 17`, `worstPrice 0.34`, `expectedNetEdge 7.9`; intent `sb-entry-0-…`, `+50`, max buy `0.35`, max cost `18`, IMMEDIATE, TAKER_OK, valid until `09:00:32.000Z` |
| 2 | 5 | onFill | exit | `SB.ALLOCATION_CONFIRMED`, `SB.TAKE_PROFIT_INTENT`, `SB.EXIT_SIZED_TO_ALLOCATION` | the entry's ONE fill `50 @ 0.34`; take-profit `sb-take-profit-1-…`, `−50`, min sell `0.5`, PASSIVE, MAKER_ONLY, valid until `09:00:32.000Z`; outputs `allocatedShares 50`, `exitShares 50`, `exitSide SELL`, `exitLimitPrice 0.5`; source event `null` |
| 3 | 5 | onOrderUpdate | hold | `SB.ENTRY_ORDER_WORKING`, `SB.TERMINAL_ORDER_VIEW_ABSORBED`, `SB.ENTRY_ORDER_TERMINAL` | the entry's FILLED view (already folded) |
| 4 | 5 | onOrderUpdate | hold | `SB.EXIT_ORDER_WORKING` | the take-profit's OPEN view → EXIT_WORKING |
| 5 | 6 | onFeatures | cancel | `SB.HOLDING_TIMEOUT`, `SB.SAFETY_CANCEL` | held `09:03:05 − 09:00:02 = 183 s ≥ 180 s`; the stop reads `0.32 > 0.27`; the protective reduction first WITHDRAWS the resting take-profit (§6 invariant 13) |
| 6 | 6 | onOrderUpdate | hold | `SB.EXIT_ORDER_WORKING`, `SB.EXIT_ORDER_TERMINAL` | the take-profit's CANCELED view, `0` filled → OPEN |
| 7 | 7 | onFeatures | reduce | `SB.HOLDING_TIMEOUT`, `SB.EXIT_SIZED_TO_ALLOCATION`, `SB.PROTECTED_REDUCE` | nothing left to withdraw, position agrees (`50 = 50`); intent `sb-protected-reduce-2-…`, `−50`, floor `0.26`, AGGRESSIVE, TAKER_OK, valid until `09:03:36.000Z`; outputs `exitShares 50`, `exitSide SELL`, `floor 0.26`, `reduceCause "maximum holding time"` |
| 8 | 7 | onFill | hold | `SB.EXIT_FILLED`, `SB.CLOSED` | the reduction's fill `50 @ 0.32` names its PENDING track; bracket 1 CLOSED, `closedAt 09:03:06` |
| 9 | 7 | onOrderUpdate | hold | `SB.IDLE` | the reduction's FILLED view; both tracks already cleared |
| 10 | 8 | onFeatures | hold | `SB.REARMED` | CLOSED; entries `1 < 2`; `09:03:40 − 09:03:06 = 34 s ≥ 30 s` |
| 11 | 9 | onFeatures | enter | `SB.ENTRY_TRIGGER_MET`, `SB.ENTRY_LEG_DIRECT`, `SB.ENTRY_INTENT_EMITTED` | executable buy price `0.33`; outputs `trigger 0.33`, `entryCost 16.5`, `worstPrice 0.33`, `expectedNetEdge 8.4`; intent `sb-entry-3-…`, `+50`, valid until `09:04:11.000Z`; `09:15:00 − 09:03:41 = 679 s` from the close |
| 12 | 9 | onFill | exit | `SB.ALLOCATION_CONFIRMED`, `SB.TAKE_PROFIT_INTENT`, `SB.EXIT_SIZED_TO_ALLOCATION` | the entry's ONE fill `50 @ 0.33`; take-profit `sb-take-profit-4-…`, `−50` at `0.5`, valid until `09:04:11.000Z`; source event `null` — the loop records `""` in its provenance |
| 13 | 9 | onOrderUpdate | hold | `SB.ENTRY_ORDER_WORKING`, `SB.TERMINAL_ORDER_VIEW_ABSORBED`, `SB.ENTRY_ORDER_TERMINAL` | the entry's FILLED view |
| 14 | 9 | onOrderUpdate | hold | `SB.EXIT_ORDER_WORKING` | the take-profit's OPEN view |
| 15 | 10 | onFeatures | hold | `SB.EXIT_ORDER_WORKING` | the venue filled the take-profit on the trade BEFORE this evaluation (`#applyEvent`), but the fill is harvested after it; held `19 s`; the resting remainder `50` equals the open `50` |
| 16 | 10 | onFill | hold | `SB.EXIT_FILLED`, `SB.CLOSED` | the MAKER fill `50 @ 0.5` names the take-profit by order id; bracket 2 CLOSED |
| 17 | 10 | onOrderUpdate | hold | `SB.IDLE` | the take-profit's FILLED view |
| 18 | 11 | onFeatures | hold | `SB.REFUSED_MAXIMUM_ENTRIES` | CLOSED; `planRearm`'s first check, entries `2 ≥ 2` |

No `SB.PAUSED`, `SB.UNATTRIBUTED_FILL`, `SB.POSITION_MISMATCH` or halt. The
traded book is at most `20 s` old at any evaluation (`maximum_book_age_ms`
600 000). Intent ids keep counting across brackets (`intentSequence` is not
reset by REARM): `0`, `1`, `2`, `3`, `4`.

**The orders** (5, in id order = submission order): 1 the bracket-1 entry, BUY
YES `50` limit `0.35`, marketable, FILLED; 2 take-profit 1, SELL YES `50` at
`0.5`, REST post-only, CANCELLED `0` filled; 3 the protective reduction, SELL
YES `50`, marketable at the bid less two ticks (`0.3`, above the `0.26` floor),
FILLED; 4 the bracket-2 entry, BUY YES `50` limit `0.35`, FILLED; 5
take-profit 2, SELL YES `50` at `0.5`, REST post-only, FILLED.

**The fills and the fees** (4; taker `0.0195`, maker `0`, HALF_UP at 3 places;
`fee = shares × rate × price × (1 − price)`):

| Fill | Role | Exact fee | Charged | Rounding |
| --- | --- | --- | --- | --- |
| entry 1 `50 @ 0.34` (event 5) | TAKER | `50 × 0.0195 × 0.34 × 0.66 = 0.21879` | `0.219` | UP `+0.00021` |
| reduction `50 @ 0.32` (event 7) | TAKER | `50 × 0.0195 × 0.32 × 0.68 = 0.21216` | `0.212` | DOWN `−0.00016` |
| entry 2 `50 @ 0.33` (event 9) | TAKER | `50 × 0.0195 × 0.33 × 0.67 = 0.2155725` | `0.216` | UP `+0.0004275` |
| take-profit 2 `50 @ 0.5` (event 10) | MAKER | `50 × 0 × 0.5 × 0.5 = 0` | `0` | none |

Bracket 1 fees `0.431` (exact `0.43095`); bracket 2 fees `0.216` (exact
`0.2155725`); run total `0.647` (exact `0.6465225`).

**Realized PnL per bracket** (average cost; each bracket starts and ends flat,
so the whole basis leaves with the exit):

- Bracket 1: entry cost `50 × 0.34 = 17`; the reduction's proceeds
  `50 × 0.32 = 16`; realized `16 − 17 = −1`; net of its fees `−1 − 0.431 =
  −1.431`.
- Bracket 2: entry cost `50 × 0.33 = 16.5`; the take-profit's proceeds
  `50 × 0.5 = 25`; realized `25 − 16.5 = 8.5`; net of its fees
  `8.5 − 0.216 = 8.284`.
- Cumulative: realized `−1 + 8.5 = 7.5`; fees `0.647`; core net
  `7.5 − 0.647 = 6.853`.

**The ledger.** 11 transactions: three per TAKER fill (principal, token
movement, `PLATFORM_FEE`) and TWO for the zero-fee MAKER fill (principal and
token delivery — `fill-posting.ts:355` books a fee transaction only when the
fee is not zero). The instance's collateral line is
`−17 − 0.219 + 16 − 0.212 − 16.5 − 0.216 + 25 = 6.853`; the token position
is flat, so the projection carries no outcome-token line.

**The PnL stream and snapshots.** 7 records in the instance's stream (`TRADE`
+ `FEE` for each taker fill, `TRADE` alone for the maker fill);
`health.accounting.pnlRecords` `14` (see `N1` above). Four snapshots, one per
fill, marked at the fill's price — and so one per instant: each of these
instants has exactly one fill, which is why `SNAP-1` (one row per instance per
instant) left this golden byte-identical:

| After | capitalCommitted | feesPaid | realizedPnl | unrealizedPnlMidpoint | grossTradingPnl | coreNetPnl | worstCaseResolutionPnl |
| --- | --- | --- | --- | --- | --- | --- | --- |
| entry 1 (09:00:02) | `17` | `0.219` | `0` | `0` | `0` | `−0.219` | `−17` |
| reduction (09:03:06) | `0` | `0.431` | `−1` | `0` | `−1` | `−1.431` | `−1` |
| entry 2 (09:03:41) | `16.5` | `0.647` | `−1` | `0` | `−1` | `−1.647` | `−17.5` |
| take-profit 2 (09:04:00) | `0` | `0.647` | `7.5` | `0` | `7.5` | `6.853` | `7.5` |

**The chains.** Four traces, one per fill. Three descend from recorded events
(5, 7, 9). The take-profit's descends from `evaluationSeq 12`, an `onFill` the
loop originated: its `sourceEventId` is `""` and its persisted decision's is
`null`, so the chain ENDS AT THAT DECISION AND ITS `featureSnapshotRef`, not
at a recorded event — `RECON-2`'s accepted reading of §6 invariant 4, now
walked (`RECON2-EVENTHOP`, `test/e2e/support/chain-walk.ts`).

**The reconciliation** (31 rows). The strategy's own `SB.REARMED`
(`evaluationSeq 10`, event 8) splits the run into two brackets; the
reconciler's fold of every fill consumed before event 8 (entry 1 `+50`,
reduction `−50`) is flat. Per bracket (ids prefixed `bracket.1.` /
`bracket.2.`), every row explained, residual `0`:

| Row | Bracket 1 | Bracket 2 |
| --- | --- | --- |
| `entry.executable_price_notional` | `0.34 × 50 = 17` vs `17` | `0.33 × 50 = 16.5` vs `16.5` |
| `entry.projected_cost` | `17` vs `17` | `16.5` vs `16.5` |
| `entry.shares` | `50` vs `50` | `50` vs `50` |
| `entry.worst_price` | `0.34` vs `0.34` | `0.33` vs `0.33` |
| `entry.cost_cap` | `18` vs `17`, headroom `−1` | `18` vs `16.5`, headroom `−1.5` |
| `entry.expected_net_edge_formula` | `25 − 17 − 0.1 = 7.9` vs `7.9` | `25 − 16.5 − 0.1 = 8.4` vs `8.4` |
| `fee.fill.<entry>` | `0.21879` vs `0.219` | `0.2155725` vs `0.216` |
| `fee.fill.<exit>` | `0.21216` vs `0.212` (reduction) | `0` vs `0` (MAKER, rate `0`) |
| `fee.total_model_vs_venue` | `0.05` vs `0.219`: basis `0.16879`, rounding `0.00021` | `0.05` vs `0.216`: basis `0.1655725`, rounding `0.0004275` |
| `exit.expected_net_edge` | `7.9` vs `16 − 17 − 0.431 = −1.431`: below take-profit `16 − 25 = −9`, basis `−(0.43095 − 0.1) = −0.33095`, rounding `−0.00005` | `8.4` vs `25 − 16.5 − 0.216 = 8.284`: below take-profit `25 − 25 = 0`, basis `−(0.2155725 − 0.1) = −0.1155725`, rounding `−0.0004275` |
| `exit.cancelled_proceeds.<take-profit 1>` | `0.5 × 50 = 25`, no realized value (withdrawn unfilled) | — |
| `pnl.realized` | `−1` from its fills vs `−1` from its §9.16 trade records | `8.5` vs `8.5` |

Run-cumulative (ids unchanged): `ledger.virtual_cash_delta`
`41 − 33.5 − 0.647 = 6.853`; `ledger.virtual_token_balance` `100 − 100 = 0`;
`pnl.fees_paid` `0.647`; `pnl.capital_committed` `0`; `pnl.gross_trading`
`7.5 + 0 = 7.5`; `pnl.core_net` `7.5 − 0.647 = 6.853`;
`pnl.worst_case_resolution` `7.5 − 0 = 7.5`; and `pnl.realized`, the
per-bracket sum `−1 + 8.5 = 7.5` against the last snapshot's `7.5`.

**The health counters.** `loop`: `evaluations`, `decisionsPersisted` and
`featureSnapshots` 19, `eventsAccepted` / `eventsProcessed` 11,
`snapshotsUnavailable` 3. `risk`: 6 evaluations, 6 approvals (two entries, two
take-profits, the cancel, the reduction), 0 refusals, 0 refused exits.
`execution`: `plansBuilt` / `submissionsAccepted` 6, `fillsObserved` 4,
`cancelsRequested` / `cancelsConfirmed` 1. `accounting`: `ledgerTransactions`
11, `pnlRecords` 14, `unattributedActivity` / `unexplainedMovements` 0. No
halts. `seams.orderViews.emitted` 7 (sequences 3, 4, 6, 9, 13, 14, 17).

### Capture and comparison

Everything under "The arithmetic, derived by hand BEFORE the first capture"
above was committed to the working tree before the scenario had ever run; the
`BRACKET-1b` handoff records this file's hash at that moment.

- **Before the capture, no golden was written.** The scenario was run once
  without capture, and a second time to build its reconciliation, both from a
  scratch probe outside the repository. The aim was to catch a strategy or
  trader defect, and a reconciler error, before the one capture. Neither run
  found one, and both agreed with the derivation.
- **Captured ONCE**, with the writer:
  `WP250_WRITE_GOLDEN=1 … determinism-golden.test.ts -t "two-brackets"`. That
  run did not execute the original scenario's describe block, and
  `paper-e2e-run.json` is byte-identical before and after it. The suite then
  passed without the variable.
- **Compared mechanically** against the derivation: every decision's sequence,
  callback, type, reason codes and source event; the model outputs and intents
  of the five decisions that carry them; the five orders; the four fills (side,
  shares, price, fee, role, event); the 11 ledger transactions and the maker
  fill's two; the seven PnL records; the four snapshots; the collateral line;
  each chain's source event; the health counters listed above; and all 31
  reconciliation rows. 92 checks, 0 mismatches.
- **Not derived beforehand, and so not claimed by the derivation:**
  - the minted ids and the content-addressed `featureSnapshotRef`s;
  - the maker fill's id, `…/t0m/10`;
  - each order's `atEventIngestSeq`, which is the event of the order's LAST
    state change: 6 for take-profit 1 (its cancel), 10 for take-profit 2 (its
    fill).

## Provenance

**No live venue connection was made, by this package or for these fixtures. No
credential, wallet, signer or real order exists anywhere in them.** Both
`paper-e2e-run.json` and `two-brackets-run.json` are SIMULATED evidence; no
soak, execution probe or live gate is claimed by either.

Every value is repository-assigned and synthetic by design: this is a SIMULATED
market (`wp250-paper-sim`) that `test/e2e/support/scenario.ts` (and, for the
second golden, `test/e2e/support/scenarios/two-brackets.ts`) specifies in full,
not a recording of any real Polymarket market. The fee schedule is a fixture
schedule chosen to exercise both rounding directions and asserts nothing about
any venue's published fees. Every fill in this file carries
`evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"` and a model identity with
`deploymentDecisionUse: "FORBIDDEN"` — ADR-012 §2: a paper fill is not evidence
about real fill quality.
