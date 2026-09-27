# Replay-golden fixture — paper end-to-end run (WP-250)

Consumed by `test/e2e/determinism-golden.test.ts`, and read as a document by
`test/e2e/traceability-chain.test.ts`,
`test/e2e/traceability-chain-negative.test.ts`,
`test/e2e/projection-reconciliation.test.ts` and
`test/e2e/reconciliation-attribution.test.ts`.

`paper-e2e-run.json` is the canonical byte form of ONE deterministic paper run
of the merged core — `apps/trader`'s composition root driving the real books,
feature engine, strategy runtime, Static Bracket strategy, capital allocator,
risk engine, execution planner, `SimulatedVenue`, ledger and PnL engine.

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

### The `SIM-1` regeneration: a cancel re-stamps the order's recorded event

`SIM-1` (O8) made the simulated venue re-stamp an order's `atEvent` when it
is CANCELLED — "the recorded event identity this state was reached at" —
instead of leaving the event it was PLACED at. The withdrawn take-profit
(`…d000:g0:o0`, placed at event 5) is cancelled by id at event 6, so its
`orders[1].atEventIngestSeq` moves `"5" → "6"`. That is the ONLY change: every
other order, fill, ledger transaction, PnL record, PnL snapshot, projection
line, reconciliation row, decision, trace and health counter is identical —
proven by a structural diff of the whole document in the round's handoff. The
run contains no partial plan, no FAK/FOK partial, no DELAYED order and no
market-scoped cancel, so SIM-1's other venue changes move nothing here.

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
`pnlSnapshots[2].realizedPnl` is `"-1.2"`, so a harness that attached the book
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

**The PnL.** Three snapshots, one per fill. After the entry's two fills (the
second snapshot): `capitalCommitted = 17.2`, `feesPaid = 0.22`,
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
WP250_WRITE_GOLDEN=1 pnpm vitest run --config test/e2e/vitest.config.ts test/e2e/determinism-golden.test.ts
```

The regeneration REWRITES this file and then FAILS ON PURPOSE. It can therefore
never be the step that turned a red suite green: read the diff, decide whether
the change is intended, re-derive the arithmetic above if an economic value
moved, and re-run WITHOUT the variable.

## Provenance

**No live venue connection was made, by this package or for this fixture. No
credential, wallet, signer or real order exists anywhere in it.**

Every value is repository-assigned and synthetic by design: this is a SIMULATED
market (`wp250-paper-sim`) that `test/e2e/support/scenario.ts` specifies in full,
not a recording of any real Polymarket market. The fee schedule is a fixture
schedule chosen to exercise both rounding directions and asserts nothing about
any venue's published fees. Every fill in this file carries
`evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"` and a model identity with
`deploymentDecisionUse: "FORBIDDEN"` — ADR-012 §2: a paper fill is not evidence
about real fill quality.
