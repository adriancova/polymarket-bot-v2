# Replay-golden fixture — paper end-to-end run (WP-250)

Consumed by `test/e2e/determinism-golden.test.ts`, and read as a document by
`test/e2e/traceability-chain.test.ts`,
`test/e2e/traceability-chain-negative.test.ts` and
`test/e2e/projection-reconciliation.test.ts`.

`paper-e2e-run.json` is the canonical byte form of ONE deterministic paper run
of the merged core — `apps/trader`'s composition root driving the real books,
feature engine, strategy runtime, Static Bracket strategy, capital allocator,
risk engine, execution planner, `SimulatedVenue`, ledger and PnL engine.

## Relationship to `pnpm test:replay`

None. §12.4's replay gate is `test/replay-golden/order-book/` (`WP-090`) and
`test/replay-golden/simulation/` (`WP-210`), run by `pnpm test:replay`, and
`WP-250` does not touch it. This golden is a THIRD artefact of the same kind,
over a different subject — the paper-core end-to-end surface `WP-230` and
`WP-240` assembled — and it is compared by `WP-250`'s own suite. Wiring a root
`pnpm test:e2e` script is a protected-path edit and is orchestrator-owned.

## What the bytes contain

| Key | What it is |
| --- | --- |
| `scenario` | the identities, sizes, prices and fee schedule `test/e2e/support/scenario.ts` states |
| `events` | the eight recorded §7.1 events, by id and ingest sequence |
| `decisions` | every PERSISTED `DecisionRecord`, as it reached the durable-store port |
| `checkpointInstants` | one per persisted decision, at the evaluation's own instant |
| `traces` | the §6 invariant 4 chains the run produced |
| `orders` / `fills` | what the simulated venue booked and produced |
| `ledgerTransactions` | the append-only postings, entry by entry |
| `pnlRecords` / `pnlSnapshots` | the §9.16 stream and the rows written to the store |
| `ledgerProjection` | the §6 invariant 8 fold: balances, virtual positions, and the two "nothing unexplained" counts |
| `health` | every §14.3-shaped counter the run moved |
| `reconciliation` | the projected-vs-realized table, with each difference's named mechanism |

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
from one decision.

**The fees.** The schedule is taker `0.0195`, maker `0`, HALF_UP at 3 decimal
places, minimum `0`. The formula is `shares × rate × price × (1 − price)`:

| Fill | Exact product | Rounded | Direction |
| --- | --- | --- | --- |
| `30 @ 0.34` | `30 × 0.0195 × 0.34 × 0.66 = 0.131274` | `0.131` | DOWN |
| `20 @ 0.35` | `20 × 0.0195 × 0.35 × 0.65 = 0.088725` | `0.089` | UP |

The two round in OPPOSITE directions on purpose: a rounding rule observed only
downward is a rule half observed. Totals: exact `0.219999`, charged `0.22`.

**The ledger.** Principal `10.2 + 7 = 17.2`, fees `0.22`, so the instance's
collateral line is `−17.42` and its outcome-token line is `50`. Six
transactions — principal, token receipt and fee, once per fill.

**The PnL.** At the final snapshot: `capitalCommitted = 17.2`,
`feesPaid = 0.22`, `unrealizedPnlMidpoint = 0.3`, so
`grossTradingPnl = 0 + 0.3 = 0.3` and `coreNetPnl = 0.3 − 0.22 = 0.08`.
`worstCaseResolutionPnl = realizedPnl − Σ open cost basis = 0 − 17.2 = −17.2`.

**The projection with no realized value.** The entry intent carries
`expectedNetEdge = 0.5 × 50 − 17.2 − (0.001 + 0.001) × 50 = 25 − 17.2 − 0.1 =
7.7`. It is never realized: the take-profit exit is a §7.7 `POSITION` intent,
`packages/risk` types the disposition from the intent TYPE alone, and the
refusal (`RISK_EDGE_INPUTS_MISSING`) is counted in `risk.refusedExits`. That is
the accepted `WP-220` residual, observed and not worked around.

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
