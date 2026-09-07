# Phase 2 verification report — paper-ready core

**Work package:** `WP-250` (Determinism and paper end-to-end verification).
**Date:** 2026-09-06.
**Subject:** the merged paper-ready core at the tip this package branched from —
`WP-230` (paper trader, merged `8425e03`) and `WP-240` (control API and paper
dashboards, merged `0e7227d`), on the governance tip `1e8a327`.
**Verifier:** the `WP-250` implementing agent. **This report is not a review.**
The implementing agent may not perform the final adversarial review, and a fresh
adversarial review round follows.

---

## 0. The honest summary, first

Three things this report DOES establish, by named tests that can fail:

1. the §6 invariant-4 traceability chain is complete and resolvable BY ID across
   the artefacts a paper run persists, walked from outside the process;
2. every difference between a projected and a realized value in the fixture is
   accounted for by a named mechanism whose arithmetic closes exactly;
3. the paper core is byte-deterministic over a fixed scenario, against a
   committed golden.

Two things it explicitly does NOT establish:

- **No soak, execution probe, live gate or real-order test has occurred.** None
  is claimed anywhere in this package. Time-based paper evidence remains
  **PENDING** (§6 below).
- **No database, Redis, container or network evidence exists.** There is no
  Docker in this repository; every seam that would touch one is exercised
  in-process through `apps/trader`'s own in-memory port implementations.

---

## 1. What was verified, and by which named test

The suite lives at `test/e2e/**` and runs with:

```
pnpm vitest run --config test/e2e/vitest.config.ts
```

**6 files, 75 tests, all passing.** Per file: `traceability-chain.test.ts` 7,
`traceability-chain-negative.test.ts` 24, `projection-reconciliation.test.ts`
11, `determinism-golden.test.ts` 5, `residuals-observed.test.ts` 13,
`safety-posture.test.ts` 15.

### 1.1 The subject is the real composition

Real in every test: `packages/order-book`, `packages/features`,
`packages/strategy-runtime`, `packages/strategies/static-bracket`,
`packages/capital-allocator`, `packages/risk`, `packages/execution-planner`,
`packages/simulation`'s `SimulatedVenue`, `packages/ledger`, `packages/pnl`, and
the whole of `apps/trader` — its safety gate, configuration door, event door,
core loop, pipeline, allocation gate, accounting and health surface.

Doubled, and only these three: the §12.1 `Clock`, the §4.2 event transport and
the §4.2 durable store, using `apps/trader`'s OWN in-memory implementations
(`@polymarket-bot/trader/testing`). No subject behaviour is doubled anywhere in
`test/e2e/**`.

The venue wiring is `apps/trader/src/main.ts`'s, reproduced verbatim rather than
simplified: a `books` provider that looks the market up THROUGH the trader on
every read, and an `ExecutionPolicy` whose `timeInForceFor` asks the composition
root for the value it recorded at plan time and refuses rather than assuming one.

### 1.2 The scenario

`test/e2e/support/scenario.ts` — one simulated market (`wp250-paper-sim`), one
`OWNER` Static Bracket instance, eight recorded §7.1 events (seven scenario
beats plus the book-refresh event deviation D5 discloses), no wall clock and no
entropy. Every constant's reason is stated in the module header. Two choices
matter for what follows:

- the YES ask ladder is `0.34 × 30` then `0.35 × 40`, so a 50-share entry WALKS
  TWO LEVELS and §12.2's Tier-0 immediate model emits one fill per consumed
  level — the chain FANS OUT to two complete chains from one decision;
- the venue fee schedule is non-zero (`0.0195` taker, HALF_UP at 3 places), and
  the two fills round in OPPOSITE directions, so the rounding rule is observed
  both ways rather than half observed.

`settlementReadiness` is stated `true` about this market, and that is a TRUTHFUL
statement: the market is one this suite specifies end to end. The scenario
deliberately does NOT use `btc-15m-updown`, whose truthful answer in this
repository is `false` and whose entries are therefore all refused — the shipped
truthful example is not a trading fixture, and this one does not pretend
otherwise by relabelling it.

### 1.3 Acceptance criterion 1 — the traceability chain is complete

> event → feature → decision → intent → plan → submission → fill → ledger
> posting → PnL, verifiable by id across the persisted artefacts.

**Named by:** `test/e2e/traceability-chain.test.ts`, tests *"every hop resolves
by id, in every chain, over the run's own bytes"* and *"every hop resolves by id
over the COMMITTED GOLDEN bytes"*.

**The primitive.** `WP-230`'s
`test/integration/paper-trader/acceptance-3-traceable-chain.test.ts` already
walks this chain hop by hop from INSIDE a live process, holding the loop, the
venue and the ledger as objects. `WP-250` does not repeat it. Instead the run is
captured into ONE PLAIN DOCUMENT (`support/artifact.ts`), serialised to canonical
bytes, and the chain is resolved as a CLOSED-WORLD GRAPH over those bytes by
`support/chain-walk.ts` — a module that imports nothing from any workspace
package and holds no reference to anything that ran. An id naming something
outside the document is a broken hop, because there is nowhere else to look.

**Hops walked (12):** `event`, `feature`, `decision`, `intent`,
`approved-intent`, `plan`, `submission`, `order`, `fill`, `ledger-posting`,
`pnl-record`, `pnl-snapshot`. The last two continue past §6 invariant 4's own end
to the two artefacts the packet asks for. Precision (review round 1, LOW-1):
ten of the twelve hops are genuine id lookups against a captured collection;
the `approved-intent` and `submission` hops are non-empty-plus-distinctness
checks, because the artifact document carries no approved-intent or
submission-attempt collection to resolve against — both remain falsifiable
(setting `approvedIntentId = executionPlanId` breaks exactly
`["approved-intent"]`).

**Bidirectional.** Forward resolution proves the chain reaches PnL. Seven
document-level checks prove nothing was persisted that no chain accounts for —
`ORPHAN_LEDGER_TRANSACTION`, `ORPHAN_FILL`, `DANGLING_PNL_REF`,
`DANGLING_DECISION_SOURCE_EVENT`, `NON_PAPER_LEDGER_TRANSACTION`,
`LEDGER_TRANSACTION_CLAIMED_TWICE`, `DECISION_KEY_NOT_UNIQUE`, plus id-uniqueness
per collection and a `NO_CHAIN` guard so an empty walk can never pass as a clean
one. Scope precision (review round 1, LOW-2): the closed world covers ledger
transactions and fills as orphan classes; PnL records are closed only via
`DANGLING_PNL_REF` — the loop exposes the `VIRTUAL_STRATEGY`-scope stream
per instance (4 of the 8 records health counts; the other four are
account-scope records the loop never exposes per-instance, correct behavior),
so the orphan closure does not extend to them.

**Falsifiability, measured.** `traceability-chain-negative.test.ts` mutates the
golden one link at a time and requires the walk to break EXACTLY the expected set
of hops — not "at least the target", which would let a mutation that broke
everything count as evidence for one link. **12 hop mutations + 9 finding
mutations = 21 mutations, 21 killed, 0 survived.** Where a mutation breaks more
than one hop the coupling is stated and asserted (e.g. corrupting the evaluation
sequence breaks `feature`, `decision`, `intent` and `pnl-snapshot`, because those
three hops read THROUGH the persisted decision).

**Observed chain shape.** 1 entry decision → 1 intent → 1 approved intent → 1
plan → 1 submission → 1 venue order → 2 fills → 6 ledger transactions (principal,
outcome-token receipt and fee, once per fill) → 4 PnL records → 2 persisted PnL
snapshots. 11 evaluations, 11 persisted decisions, 11 checkpoints, zero halts.

### 1.4 Acceptance criterion 2 — zero unexplained projection difference

**Named by:** `test/e2e/projection-reconciliation.test.ts`, test *"every row is
explained: the named mechanisms reproduce the difference exactly"*, plus its
golden twin *"the same table is reproduced from the COMMITTED GOLDEN bytes"*.

**What "explained" means.** A row is explained only when
`realized − projected = Σ named contributions` closes to a residual of exactly
`"0"` in decimal arithmetic. A label is never enough: a mechanism whose
arithmetic does not close leaves a non-zero residual and the row is UNEXPLAINED,
and a mechanism outside the closed set makes the row unexplained whatever its
arithmetic says.

**The table: 17 rows, 0 unexplained.** Twelve rows are exact equalities; four
carry a difference; one has no realized value at all.

| Row | Projected | Realized | Difference | Mechanism |
| --- | --- | --- | --- | --- |
| `entry.executable_price_notional` | `17.2` | `17.2` | `0` | `EXACT_NO_DIFFERENCE` |
| `entry.projected_cost` | `17.2` | `17.2` | `0` | `EXACT_NO_DIFFERENCE` |
| `entry.shares` | `50` | `50` | `0` | `EXACT_NO_DIFFERENCE` |
| `entry.worst_price` | `0.35` | `0.35` | `0` | `EXACT_NO_DIFFERENCE` |
| `entry.cost_cap` | `18` | `17.2` | `-0.8` | `COST_CAP_HEADROOM` |
| `entry.expected_net_edge_formula` | `7.7` | `7.7` | `0` | `EXACT_NO_DIFFERENCE` |
| `fee.fill.…/t0/0` | `0.131274` | `0.131` | `-0.000274` | `FEE_ROUNDING_HALF_UP` |
| `fee.fill.…/t0/1` | `0.088725` | `0.089` | `+0.000275` | `FEE_ROUNDING_HALF_UP` |
| `fee.total_model_vs_venue` | `0.05` | `0.22` | `+0.17` | `FEE_MODEL_BASIS` `0.169999` + `FEE_ROUNDING_HALF_UP` `0.000001` |
| `ledger.virtual_cash_delta` | `-17.42` | `-17.42` | `0` | `EXACT_NO_DIFFERENCE` |
| `ledger.virtual_token_balance` | `50` | `50` | `0` | `EXACT_NO_DIFFERENCE` |
| `pnl.fees_paid` | `0.22` | `0.22` | `0` | `EXACT_NO_DIFFERENCE` |
| `pnl.capital_committed` | `17.2` | `17.2` | `0` | `EXACT_NO_DIFFERENCE` |
| `pnl.gross_trading` | `0.3` | `0.3` | `0` | `EXACT_NO_DIFFERENCE` |
| `pnl.core_net` | `0.08` | `0.08` | `0` | `EXACT_NO_DIFFERENCE` |
| `pnl.worst_case_resolution` | `-17.2` | `-17.2` | `0` | `EXACT_NO_DIFFERENCE` |
| `exit.expected_net_edge` | `7.7` | **none exists** | — | `PROTECTIVE_EXIT_REFUSED_AT_RISK_SEAM` |

The five mechanisms are a closed set, each with a stated definition
(`support/reconcile.ts`).

**The projections are independent, not read back.** The venue fee is RECOMPUTED
from the schedule's documented formula `shares × rate × price × (1 − price)`
exactly, in `@polymarket-bot/decimal`, and only the ROUNDING step is left to the
venue; the contribution attributed to rounding is additionally required to be
within half a unit in the last place, per fill and in aggregate. The strategy's
expected-net-edge formula is likewise recomputed from the scenario's own
configuration and compared with the number the intent carries.

**The headline exact row.** `entry.projected_cost`: the §9.5 executable-buy-price
feature projected `17.2` for 50 shares over a TWO-LEVEL ladder, and the venue's
realized ladder walk cost exactly `17.2`. That equality could have failed and did
not.

**Falsifiability, measured.** Four probes in the same file: a fabricated realized
fee is reported unexplained AND named as exceeding the rounding bound; a moved
projected value breaks the exact rows; a ledger balance that disagrees with the
fills is unexplained; and a run with no fill, or with no entry decision, is
REFUSED OUTRIGHT rather than reported as "zero unexplained rows" — an empty table
is not a passing table.

### 1.5 Deliverable 2 — deterministic golden output

**Named by:** `test/e2e/determinism-golden.test.ts`.

- *"two fresh in-suite runs produce byte-identical artefacts"* — two independent
  assemblies and drives inside one process, compared byte for byte.
- *"a run is byte-identical to the committed golden"* — against
  `test/replay-golden/paper-e2e/paper-e2e-run.json` (1378 lines, 45 265 bytes,
  SHA-256 `dd6893bfa586d345cbc1567b2fa9486ae5c186a1efacf6f054e6271f92263d95`).
- The comparison was additionally run **twice in two separate OS processes** and
  produced identical results with the file on disk unchanged.
- *"the comparison is falsifiable: one changed character changes the bytes"* — a
  one-field perturbation produces different bytes and fails against the golden,
  so the byte identity is a fact about the run and not about a serialiser that
  discards detail.

**Canonical form.** `support/canonical-json.ts`: keys sorted recursively,
two-space indent, LF, one trailing newline, and every `number` required to be a
SAFE INTEGER — so §6 invariant 1 (economic values are canonical decimal STRINGS)
is enforced by the serialiser rather than assumed. A float leaking into an
economic field is refused by name and path instead of frozen.

**Excluded from the golden, deliberately and disclosed:**
`DecisionTelemetry.evaluationDurationUs` (documented upstream as
machine-dependent and excluded from `DecisionRecord` for exactly this reason)
and `HealthSnapshot.riskSeamCaveat` (a prose constant owned by `apps/trader`,
pinned here BY IDENTITY instead, so an upstream wording fix does not read as a
determinism failure).

**Regeneration is deliberately fatal.** `WP250_WRITE_GOLDEN=1` rewrites the
golden and then FAILS, so a regeneration can never be the step that turned a red
suite green.

**Relationship to `pnpm test:replay`.** None. §12.4's replay gate
(`WP-090` order-book + `WP-210` simulation, 6/6) is untouched by this package
and still passes. This golden is a third artefact of the same kind over the
paper-core end-to-end surface.

### 1.6 Safety posture

**Named by:** `test/e2e/safety-posture.test.ts` (15 tests).

The four repository floors — `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
`LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` — are
stated as values in the scenario and enforced by REFUSAL, not clamping: five
raised-environment probes each produce `TRADER_UNSAFE_ENVIRONMENT`, and a sixth
probe pairs a raised ceiling with a document that would ALSO be refused and
confirms the SAFETY code wins, proving the gate runs BEFORE the configuration
door. A production secret name in the environment refuses without echoing a
value.

Every fill in the run carries `evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"`, and
every model identity carries `deploymentDecisionUse: "FORBIDDEN"`,
`permittedUse: "WIRING_AND_REGRESSION_ONLY"` and
`calibration: "UNCALIBRATED_NO_PROBE_DATA_EXISTS"`. Every ledger transaction and
PnL snapshot is booked `PAPER`.

This package's own files are scanned: no production secret, account or
builder-attribution name; no module specifier outside a permitted set of ten
(with a floor on the number of specifiers found, so a broken regex cannot pass by
matching nothing); no random-source or wall-clock CALL; no run-mode raise.

---

## 2. Residuals OBSERVED, not fought

Nothing in `test/e2e/**` weakens a policy, re-tags an intent, bypasses a door or
works around a refusal. Each residual below is pinned by its observable
consequence, so the day it is fixed this suite fails and says which one moved.
**Named by:** `test/e2e/residuals-observed.test.ts` (13 tests).

### R1 — the `strategyInstanceId` contract conflict

`packages/ledger` and `packages/pnl` require `Uuidv7Schema`; `packages/risk`
types `context.strategyInstanceId` as a `CodeString`, whose grammar requires a
LEADING LETTER. A UUIDv7 minted from a real timestamp begins with `0` and cannot
satisfy both. `apps/trader`'s config door refuses at STARTUP rather than letting
this surface as a mid-run `RISK_INPUT_INVALID`.

**Observed:** the scenario configures inside the intersection (a v7-shaped id
whose first hex digit is a letter), exactly as `WP-230`'s fixture does; and a
timestamp-shaped id is refused at startup with a message naming both doors.

**Status: OPEN.** The ruling belongs to the contract owner and is queued
elsewhere. `WP-250` did not work around it beyond what the merged fixture already
does.

### R2 — a protective reduction receives `ENTRY` disposition at the risk seam

The `WP-220` accepted residual. Every exit the Static Bracket emits is a §7.7
`POSITION` intent, and `packages/risk` derives the disposition from the intent
TYPE alone.

**Observed in this run:** the take-profit exit was refused
`RISK_EDGE_INPUTS_MISSING`, counted as `risk.refusedExits = 1` and
`refusedExitsByCode = { RISK_EDGE_INPUTS_MISSING: 1 }`. The counting is asserted;
the policy is not weakened. `RISK_SEAM_CAVEAT` is pinned by identity on the
health snapshot. Fail-closed confirmed: one plan, one submission, one order, and
every fill a BUY — nothing was planned or submitted for the refused exit.

**NEW OBSERVATION — the residual's blast radius.** After the refusal the
strategy's own state machine believes an exit order is working and enters
`SB.AWAITING_CANCEL_CONFIRMATION`, which no order will ever resolve. From that
point the instance emits no further actionable intent, passes its
`exit_cutoff_before_close_seconds`, and ends the run HOLDING 50 shares it cannot
exit. This is asserted in *"the CONSEQUENCE is visible too: the instance ends
holding what it cannot exit"*.

The practical consequence for verification is stated plainly: **a realized
round-trip PnL is not reachable in the merged paper core while this residual
stands**, because no exit can pass the risk seam under the default
`requirePositiveNetEdgeForEntries`. `WP-250` did not disable that policy to
manufacture one. Realized-PnL evidence is therefore PENDING on the risk-side
follow-up (§6).

### R3 — `SHADOW` ownership is observe-only

ADR-011 §5: a shadow instance "submits nothing".

**Observed:** with a second `SHADOW` instance over the same market,
`execution.observeOnlyIntents > 0`; the shadow's DECISIONS are still persisted;
no ledger entry and no PnL record carries its instance id; and adding it changes
neither the fills nor the transaction count, because a label is not a second
balance.

**NOT claimed.** The `SHARED_BOOK_ACCOUNTING_MODE = "LIVE"` backstop is
`apps/trader/src/loop.ts`-private and is not exported, so this suite cannot
import it and does not pretend to assert it. It was READ in source, not executed
here. What this suite observes is the PRIMARY remedy — the routing gate — and the
report says so rather than implying two layers were tested.

### R4 — the interim §9.8 operator inputs are required and undefaulted

**Observed:** omitting each of the four fields produces a startup
`TRADER_CONFIG_REFUSED` naming the field — `settlementReadiness` (check 6),
`parametersVersion` (check 9), `scenarios` (check 17), `requestBudget`
(check 19). The scenario supplies truthful values for a market it specifies
itself, and asserts that it is not the `btc-15m-updown` series.

**Status: interim by design.** The authoritative answers belong to
`packages/universe` and `packages/settlement`; wiring them into the trader is a
recorded follow-up owned elsewhere.

---

## 3. Gate results at this tip

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | clean, no lockfile change (this package adds no dependency) |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` (`eslint .`, covers `test/e2e/**`) | 0 problems |
| `pnpm test` (root) | **272 files / 6149 tests**, unchanged from the `80126e8` baseline |
| `pnpm check:deps` | **PASS — 34 packages, 70 edges**, unchanged |
| `pnpm test:replay` | **6/6**, untouched |
| `pnpm --filter @polymarket-bot/trader test:integration` | **9 files / 110 tests** |
| `pnpm --filter @polymarket-bot/control-api test:integration` | **7 files / 76 tests** |
| `pnpm vitest run --config test/e2e/vitest.config.ts` | **6 files / 75 tests** (new) |
| `pnpm exec tsc --noEmit -p test/e2e/tsconfig.json` | 0 errors |

**Root-count reconciliation, both ways.** The root runner
(`test/vitest.config.ts`, `WP-010`-owned and outside this package's grant)
includes `test/unit/**`, `packages/**/src/**` and `apps/**/src/**`, and excludes
`test/integration/**`. `test/e2e/**` matches none of those globs, so the root
count is expected to be UNCHANGED and is: 272/6149 before and 272/6149 after,
delta 0. The 75 new tests are therefore additional to, not part of, the root
figure — total repository coverage after this package is 6149 root + 110 trader
integration + 76 control-api integration + 75 e2e = **6410 tests across 294
files**.

---

## 4. Deferred wiring (protected paths, orchestrator-owned)

Two script legs are DEFERRED TO MERGE because they live in protected paths this
package may not edit. Both follow the `af059d7` precedent (the `WP-230` root
wiring the orchestrator performed as a disclosed step).

1. **A root `test:e2e` script.** `package.json` is a global protected path.
   Suggested value:
   `"test:e2e": "vitest run --config test/e2e/vitest.config.ts"`.
2. **A typecheck leg for `test/e2e/tsconfig.json`.** `pnpm typecheck` runs
   `tsc -p test/tsconfig.json`, whose `include` is `["unit", "vitest.config.ts"]`
   and which is not in this package's grant. Suggested value: append
   `&& tsc --noEmit -p test/e2e/tsconfig.json` to the root `typecheck` script.
   Until then the leg is run manually and its result is recorded in §3.

Until both land, **`test/e2e/**` does not run in any aggregate root script** and
a change elsewhere in the repository can break it without any root gate noticing.
That is a real gap and it is stated here rather than left implicit.

---

## 5. Findings from this round

Neither is a defect in a merged package; both are properties this verification
surfaced and that a reviewer should see.

**F1 — the paper core cannot currently produce a realized round trip.** See R2.
Consequence for Phase 2 evidence: `realizedPnl` is `0` in every snapshot this
suite produces, the `unrealizedPnlMidpoint`/`grossTradingPnl`/`coreNetPnl`
identities are verified but the REALIZED half of the PnL engine is exercised only
by `packages/pnl`'s own unit tests, not end to end. Owner: the risk-side
follow-up that resolves the `WP-220` residual.

**F2 — the replay-determinism dashboard panel still has no metric producer.**
`WP-240` shipped `infra/grafana/control/` with four PENDING panels, one of which
is replay determinism, and its named future owner is a simulation/backtest-cli
grant. `WP-250` produces exactly the fact that panel wants — a byte-identity
result over a deterministic run — but `packages/**` and `apps/**` are HARD
forbidden here, so no producer could be added and none was attempted. The panel
remains PENDING with its existing owner.

---

## 6. PENDING evidence — stated explicitly

This section discharges **acceptance criterion 3**: *time-based paper evidence
remains explicitly pending until observed.*

| Evidence | Status | Owner |
| --- | --- | --- |
| **Time-based paper soak** (a paper trader running for a sustained period against a live feed) | **PENDING. Never observed. Not claimed anywhere in this package.** Every run in `test/e2e/**` is a fixed eight-event scenario that completes in milliseconds against in-memory ports. | operator action, per runbook §1F/§7 |
| **`WP-140` external recorder soak evidence** | **PENDING**, machine-readably (`recorder_soak_status_info{status="PENDING"}`). Stands entirely apart from `WP-250` and is untouched by it. | operator action, per runbook §1F/§7 |
| **Execution probe / live gate** | **NOT PERFORMED, NOT PERMITTED.** `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false` and both live-micro caps at `0` are unweakened; the only `ExecutionVenue` this package can construct is the simulated one, which refuses `EXECUTION_PROBE`, `LIVE_MICRO` and `LIVE` by name. | phase-4 governance |
| **Fill-quality evidence** | **NONE EXISTS AND NONE IS CLAIMED.** Every fill here is Tier 0 — `deploymentDecisionUse: "FORBIDDEN"`, `calibration: "UNCALIBRATED_NO_PROBE_DATA_EXISTS"`. ADR-012 §2: "the simulator says it fills" is not a promotion argument. | ADR-012, phase-4 |
| **PostgreSQL / Redis integration** | **NONE.** No Docker exists in this repository; no testcontainer was started; the durable store and event transport are in-memory doubles of `apps/trader`'s ports. The Postgres audit sink `WP-240` shipped remains typecheck-pinned only. | future infrastructure work |
| **Realized round-trip PnL, end to end** | **PENDING** on the `WP-220` risk-seam residual (F1). | risk-side follow-up |
| **Latency, throughput and queue-pressure behaviour under load** | **NOT MEASURED.** The bounded queues are exercised for correctness by `WP-230`'s suite; nothing here measures them under sustained pressure. | future soak/performance work |
| **Any claim about a real Polymarket market** | **NONE.** The scenario's market is simulated and specified by this suite; the fee schedule is a fixture schedule chosen to exercise both rounding directions and asserts nothing about published venue fees. | `WP-000` catalogue owns venue facts |
| **`SHARED_BOOK_ACCOUNTING_MODE` backstop** | **READ IN SOURCE, NOT EXECUTED HERE** (R3). | future `apps/trader` grant |
| **Grafana dashboards in a real Grafana** | **NEVER IMPORTED.** `WP-240` validated them as JSON only; `WP-250` adds nothing to that. | future operations work |

---

## 7. Reproducing this report

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm check:deps
pnpm test:replay
pnpm --filter @polymarket-bot/trader test:integration
pnpm --filter @polymarket-bot/control-api test:integration
pnpm exec tsc --noEmit -p test/e2e/tsconfig.json
pnpm vitest run --config test/e2e/vitest.config.ts
```

The last command is the one this report is about. Nothing in it requires a
network, a container, a credential or an environment variable.

---

## Addendum (2026-09-07): §2 R1 is RESOLVED; the tripwire fired and was retired

Append-only; nothing above this line changed — including §2 R1's frozen
"Status: OPEN", which was true when written.

The ruling R1 queued was made by ADR-021 (2026-09-06:
`strategyInstanceId` is a `Uuidv7Schema` identity; risk's `CodeString`
typing ruled a mis-typing), and the resolution chain landed in three
merges: `packages/risk` re-typed by `WP-180-FU3` (`8c14b47`);
`packages/capital-allocator` — a fourth door ADR-021's original text
missed, found and measured by WP-180-FU3's review — by `ALLOC-1`
(`d9f70a6`); and `apps/trader`'s startup door by `TRDR-1` (`65ae56c`),
which deleted the `UuidAndCodeString` intersection and types
`instanceId` as the real `Uuidv7Schema` — simultaneously admitting the
timestamp-shaped (`0`-leading) population every honest mint produces and
TIGHTENING to version/variant enforcement (the interim regex checked
neither; a letter-leading v4 passed startup and was refused only
mid-run).

`test/e2e/residuals-observed.test.ts` fired on the first candidate
carrying the trader change — exactly as §2's design sentence promised —
and its R1 block was retired COUNT-NEUTRALLY in the same reviewed round
(still two rows; the file still carries 13 tests and the suite 75, so
§1's counts remain true): row 1 now pins that the letter-leading id this
scenario was written around STILL works (ADR-021's compatibility
promise, non-vacuous against this run), and row 2 pins the inversion —
the timestamp-shaped id the frozen body above records as REFUSED now
STARTS (and, review-verified end to end, runs the full scenario with
results identical to the baseline), while a wrong-version id is refused
at startup instead, with a message that names no cross-package conflict.
The frozen golden was byte-identical (`dd6893bf…263d95`) throughout the
chain.

R2, R3 and R4 remain OPEN and their rows are byte-untouched
(sha256-verified in TRDR-1's review).
