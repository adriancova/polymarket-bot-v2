# SIM-1: SimulatedVenue correctness (LOOPMEM-SIM part 1)

Branch `sim-1` on base `6cbecc8`, merged into `main` as `93c7bbd` (`--no-ff`) on 2026-09-27.

- **Authorization:** the user, "yes go for it please" (LOOPMEM-SIM).
- **Scoping:** read-only, workflow `wf_8524bc0f-1b8`, four lenses. It REPRODUCED the defects below, and bounding had to wait for them because a live index is bounded only if every order terminates (`IF-20`).
- **User ruling R3:** per-order results.
- **Orchestrator calls:** O1–O10, recorded in the `SIM-1` row.
- **Process:** the HARDENING LOOP (workflow `wf_fbbcb79f-8af`): an Opus implementer, gates run outside any sandbox, Codex gpt-6-astra verification, and fresh Opus remediators.

| Commit | Content |
| --- | --- |
| `805a578` | r0: R3 and O1–O10; the goldens (O8/O9) |
| `288334c` | r1: `SIM1-R1-1` (HIGH): a DELAYED disposition that cannot be applied is REJECTED once and reported, and the loop halts on it; the golden READMEs are restored (`SIM1-R1-2`, LOW) |
| `9019d37` | r2: `SIM1-R2-1` (HIGH): a BASKET is judged from each booked order's own outcome, so an "accepted" basket that executed only in part halts |
| `31504b2` | r3: `SIM1-R3-1` (HIGH): every venue answer is followed by a basket judgement, so a basket that a delivery callback cancels short halts before any other intent or callback runs |
| `93c7bbd` | the merge (tree identical to `31504b2`) |

## Outcome
- **§6 invariant 13 (`VS-13`/`TERM-H`).** A market-scoped cancel now targets and charges only LIVE orders. A cancel with no live target is a successful no-op.
  - Before: a SAFETY_CANCEL that cancelled every live order was answered `accepted:false` (`CANCEL_INCOMPLETE`) once any historical order existed, and the trader recorded it as REJECTED.
  - Before, under a modelled budget: the history exhausted the bucket and left the live order uncancelled.
- **No dead orders (`TERM-A/B/C/D/G`).** Each of these held its reservation, allocator commitment and time-in-force, was counted open by risk, and escaped TRDR-4's delivery bound (`TERM-K`). Each fix is pinned at the venue and, for O1 to O4, through the real CoreLoop.
  - O1: a FAK partial → CANCELLED, keeping `filledShares`.
  - O2: a Tier-0 FOK is all-or-nothing: REJECTED with 0 filled.
  - O3: GTC/GTD remainders of any style rest (under Tier 0, a trade through the limit fills the whole remainder as a maker at the limit).
  - O4: a partial GTD → EXPIRED, keeping `filledShares`. The live status is UNVERIFIED. Expiry is now also checked on `observe()` and on every `observeTrade()`, so a GTD in a quiet market expires.
  - O5: DELAYED is faithful (D-18): nothing fills before `matchableAtNs`, the computed disposition then applies, and cancels inside the window are refused. No ADR change was needed.
- **R3: per-order results.**
  - **The venue answer.** `ExecutionResult` carries `outcome` (ACCEPTED | PARTIAL | REFUSED) and `notPlaced` (`NotPlacedOrder`). Booked orders, fills and bands are listed on every path, including contained errors.
  - **Before booking.** A whole-plan pre-flight runs the local checks: group shape, validation, duplicates, time-in-force, postOnly/style and GTD expiry.
  - **Rate limits.** Admission is per batch of ≤15 orders, all-or-nothing (ADR-012 / D-05). After a batch with a failure, later batches are not sent (`SIMULATED_VENUE_ORDER_NOT_SUBMITTED`). That stop rule is a simulator choice, disclosed in the README.
  - **Booking.** Compute-then-apply: an error leaves no trace, which also closes O10 (`PP-17`).
  - **The trader** OWNS booked orders (`#ownBookedOrders`: owner, trace prefix and provenance) and releases only the orders that were neither booked nor held.
  - **Halts.** A POSITION/REDUCE partial does not halt. A BASKET partial halts every market in the basket (`BASKET_PARTIALLY_EXECUTED`, MANAGE_KNOWN_POSITIONS_ONLY). The basket is judged after every venue answer, with the harvest as a backstop. TRDR-4's orphan halt stays as the DEFENSIVE path, pinned through a scripted double; both TRDR-4 pins were converted, none deleted.
- **Also:**
  - O6: market-scoped cancels are live-only.
  - O7: a REJECTED order is never cancellable, on any path.
  - O8: a cancel re-stamps `atEvent`.
  - O9: the version pin is `wp-210/v2`.

## Goldens
Only the O9 and O8 lines changed:
- `golden-replay.json`: the version pin and the `run simulator=` line;
- `run-pins.json`: the version pin;
- `expected-artifact.txt`: line 4 (the version) and line 11 (the cancelled take-profit's `atEvent`, `5 4` → `6 5`);
- `paper-e2e-run.json`: `orders[1].atEventIngestSeq` "5" → "6".

Every fill, ledger, PnL, decision, trace and health value is identical. The implementer proved this mechanically, the orchestrator read the whole golden diff, and the determinism tests passed twice.

## Evidence
- Verification gates at `31504b2`, outside any sandbox: typecheck 0, lint 0, check:deps PASS; unit 341 / 7390; e2e 7 / 157; replay 3 / 17.
- **Docker was unavailable in this session**, so the trader Testcontainers files never ran locally. They ran green on GitHub: PR #7 run `36352682313`, all three jobs, all six integration suites.
- Post-merge on `93c7bbd`: unit 341 / 7390, e2e 7 / 157, replay 3 / 17.

## Queued
`SIM1-BASKET` (baskets are unreachable in production and have no `failurePolicy` consumer), `SIM1-CANCELDEBIT`, `SIM1-LOOKAHEAD`, `SIM1-PRICEVALID`.

`TRDR4-ORPHAN` is now defensive-only, and the TRDR-4 "Tier-1 settle-mismatch" statement is corrected (REFUTED, `VS-16`).

## Requirements carried into SIM-2
- Keep a terminal order visible to the loop until the loop has seen it; TRDR-4 settlement and the basket watch rely on this.
- Track the held-but-unowned orders that the harvest release currently finds by a full venue scan.
- Carry `#pending` (DELAYED) and the eager expiry sweep into the bounding design.

## commit_sha
`31504b280d73ad5007db180114265d9bb9fb939b` (branch `sim-1`), merged as `93c7bbd`.

---

# Appendix A — implementer handoff, r0 (verbatim)

# SIM-1 handoff, round 0 (first implementation)

## plan (written before any edit)

Base `6cbecc8` on branch `sim-1`; baseline `pnpm run test` = 339 files / 7315 tests, green.

### Venue (`packages/simulation/src/venue.ts`, `ports.ts`, `refusals.ts`, `index.ts`, README §5)

1. **Stage, then commit.** Split every order's execution into a STAGE step (pure except the
   Tier-1 seeded draws, which happen once per order exactly as today) and a COMMIT step that
   applies fills, books the order, registers the resting record/band, or parks a DELAYED
   order. Cash and positions are computed into locals and assigned last, so a throw anywhere
   before the commit leaves nothing behind. This closes O10 (`PP-17`: no orphan resting
   record) and is what lets a per-order refusal list exactly what was booked.
2. **R3 per-order results.** `ExecutionResult` gains `outcome: "ACCEPTED" | "PARTIAL" |
   "REFUSED"` and `notPlaced: readonly { plannedOrderId, refusalCode, refusalMessage }[]`.
   `accepted` stays `true` only when everything took effect; `orders`/`fills`/`bands` list
   what WAS booked on every path (the containment path included); `refusalCode` is the
   cause (unchanged codes for a whole refusal).
   - Pre-flight over the whole plan before any token or booking: groups shape, every
     planned order's validation, duplicates within the plan and against the venue, and the
     per-order policy/style checks (time-in-force, postOnly/style, REST+FAK/FOK, GTD expiry).
     A failure books nothing and spends nothing; every readable planned order is listed in
     `notPlaced`.
   - Admission per batch of <= 15 orders in plan order, one `admit(count)` per batch,
     all-or-nothing. Within an admitted batch each entry executes on its own (the venue's
     per-entry batch response); a failure refuses that entry only. After any failure in a
     batch, or a refused batch, later batches are not sent (a simulator choice, disclosed).
   - A throw while staging one order is contained per order (that order refused
     `SIMULATION_INTERNAL`), so the throw path also reports what was booked (`PP-3`).
   - New refusal code `SIMULATED_VENUE_ORDER_NOT_SUBMITTED` for orders never sent because an
     earlier part of the plan failed.
3. **O1** FAK remainder -> CANCELLED keeping `filledShares`. **O2** Tier-0 FOK with a
   remainder -> REJECTED, 0 filled, no fill booked. **O3** any GTC/GTD remainder (REST or
   MARKETABLE_LIMIT, Tier 0 and Tier 1) is registered to rest. **O4** `#expire` moves
   RESTING and PARTIALLY_FILLED to EXPIRED keeping `filledShares` (live status UNVERIFIED,
   commented). Lazy expiry: I intend to make expiry EAGER as well (swept on `observe()` from
   the venue clock and on every `observeTrade()`), because a GTD in a quiet market otherwise
   never expires and holds capital (VS-05b); it is golden-neutral (no golden uses GTD).
4. **O5 DELAYED** faithful: on a delayed market the order is booked DELAYED with 0 filled and
   no fill applied; a pending record keeps the already-computed disposition and fills; a
   sweep on `observe()` (venue clock), `observeTrade()` (trade instant) and cancel resolves
   it once the clock reaches `matchableAtNs`. Cancels inside the window are refused
   (`notCancelled`, D-18). No ADR change needed (ADR-012 §5.1 says "pending order").
5. **O6** market-scoped cancel targets live orders only; charges only those; zero live
   targets = successful no-op with no charge. **O7** REJECTED is "already REJECTED" on every
   path. **O8** a cancel re-stamps `atEvent` to the venue's current event.
6. No new public member on `SimulatedVenue` (the doors census stays unchanged).

### Trader (`apps/trader/src/loop.ts`, `halt.ts`, tests)

7. A non-accepted placement registers owner, trace prefix and provenance for every order the
   answer lists as booked (the accepted path's code, extracted). It releases reservation,
   allocator and time-in-force only for planned orders the answer did not book and the
   venue does not hold. Orders the venue holds but the answer did not list keep TRDR-4's
   orphan path (kept + `UNATTRIBUTED_ACTIVITY` halt). A POSITION/REDUCE partial raises no
   halt; a BASKET partial (detected by `placement.planKind === "BASKET"`) halts every market
   of the basket with a new code `BASKET_PARTIALLY_EXECUTED` (`MANAGE_KNOWN_POSITIONS_ONLY`),
   because nothing consumes `failurePolicy`.
8. Convert the TRDR-4 pins: real-venue versions assert owned, tracked, delivered booked orders
   and no halt; scripted `TraderVenue` doubles keep the orphan halt.

### Goldens

9. O9 bump `wp-210/v1` -> `wp-210/v2` in `golden-replay.json` (runPins + expected run line,
   derived by hand per its README), `run-pins.json`, `backtest.test.ts`, and the unit
   fixtures that pin the same value. Regenerate the backtest artifact once (scratch capture,
   per its README) and the paper-e2e golden once (`WP250_WRITE_GOLDEN=1`). Prove with a
   scratch diff script that only the version lines and the cancelled order's `atEvent`
   moved. Run determinism twice.

## summary

SIM-1 implemented on `sim-1` (base `6cbecc8`), one commit `805a578ddaff26a481cbc384b4d333e657ac27c5`. Plan above was followed; the deviations are listed below.

**R3, venue (`packages/simulation`).** `ExecutionResult` gains `outcome: "ACCEPTED" | "PARTIAL" | "REFUSED"` and `notPlaced: NotPlacedOrder[]` (`{ plannedOrderId, refusalCode, refusalMessage }`, exported). `orders`/`fills`/`bands` list what was BOOKED on every path, including the containment path (`PP-3`: `submit` keeps a `PlacementProgress` outside `#submitSync`, so `#refuseInProgress` lists the booked orders and quotes the real plan id). The whole plan is pre-flighted before any token or booking: group shape, `validatePlannedOrder`, duplicate ids within the plan and against the book, and the policy's order-type checks (time-in-force, postOnly/style, REST+FAK/FOK, GTD expiry; the policy is read once per order and a throw there is contained). Placements are admitted per batch of ≤15 in plan order with one `admit(count)`, all-or-nothing. Inside an admitted batch each entry executes on its own; after a batch with any failure (or a refused batch) the later batches are not sent (`SIMULATED_VENUE_ORDER_NOT_SUBMITTED`, new refusal code). Execution is STAGE (no venue state written; Tier-1 latency drawn once, as before) then COMMIT (`#applyFills` computes cash/positions into locals and assigns last). Consumers changed: `apps/trader/src/loop.ts` (refusal/partial branch), the two TRDR-4 test files (a scripted double builds a result; `WrappedVenue.rewriteAnswer`). Unchanged readers: e2e harness, integration fixture, backtest support, golden-replay test, doors battery (they read `accepted`/`refusalCode`/`orders` only).

**R3, trader.** `#ownBookedOrders` (extracted from the accepted path) registers owner, instance set, booked-shares counter, trace prefix and provenance for every order the answer lists, on the accepted AND the refused/partial path. `#releaseRefusedPlacement` releases reservation/allocator/time-in-force only for planned orders the answer did not book and the venue does not hold; orders the venue holds but the answer did not list keep TRDR-4's orphan path (kept + `UNATTRIBUTED_ACTIVITY`). POSITION/REDUCE partial: no halt. BASKET partial: detected by `plan.planKind === "BASKET"` in `#releaseRefusedPlacement`; halts every market of the basket's groups with the new code `BASKET_PARTIALLY_EXECUTED` → `MANAGE_KNOWN_POSITIONS_ONLY` (`halt.ts`). A partial is counted `submissionsRefused` (no new counter; see deviations).

**O1-O10.** O1 FAK remainder → CANCELLED keeping `filledShares` (Tier 0 and Tier 1). O2 Tier-0 FOK that cannot fill whole → REJECTED, 0 filled, no fill booked. O3 every GTC/GTD remainder registered to rest whatever the style; a Tier-0 maker fill of such a remainder fills its WHOLE remaining size at the limit price as a MAKER (maker fee from the snapshot) on the first observed trade at or through the limit, and the order becomes FILLED with `filledShares` = arrival fill + remainder (pinned: 30@0.5 TAKER + 20@0.5 MAKER). Tier 1 rests it with its band. A Tier-1 remainder whose book at `matchableAtNs` is unknown is now refused `NO_BOOK` instead of booked dead. O4 `#expire` moves RESTING and PARTIALLY_FILLED to EXPIRED keeping `filledShares`; comment records the live status as UNVERIFIED (no EXPIRED in the recorded statuses). Lazy expiry was NOT kept: expiry is also swept on `observe()` (venue clock) and on every `observeTrade()` (any market), because a GTD in a quiet market never expired and held its capital (VS-05b); golden-neutral (no golden uses GTD); disclosed in README §5 item 15. O5 DELAYED faithful, no ADR change needed (ADR-012 §5.1 already says "pending order"): on a delayed market the order is booked DELAYED, 0 filled, no fill applied; a `#pending` record holds the already-computed fills and disposition; `#sweep` (on `observe()`, `observeTrade()` before the walk, and before a cancel) applies it once the recorded clock reaches `matchableAtNs` in `(matchableAtNs, id)` order; a cancel inside the window → `notCancelled` "DELAYED … cannot be canceled (venue report D-18)", order unchanged. O6 market-scoped cancel targets/charges live orders (RESTING, PARTIALLY_FILLED, DELAYED; ACCEPTED is never produced); with no live target: `cancel()` returns `{ executionPlanId, cancelled: [], notCancelled: [], venueClass: "SIMULATED" }`, a CANCEL plan returns `{ accepted: true, outcome: "ACCEPTED", orders: [], fills: [], bands: [], notCancelled: [], notPlaced: [], rateLimitModel, rateLimitDisclosure, venueClass, planningDepthAwareness }` with no `refusalCode`, and no token is charged. O7 REJECTED is "already REJECTED" by id (by `cancel()` and by CANCEL plan), and never a market-scope target. O8 a cancel re-stamps `atEvent` to the venue's current event. O9 pin bumped. O10 closed by stage-then-commit (the resting record reaches `#resting` only at commit).

**Goldens.** Exactly the named hunks moved (proof below). Determinism tests run twice, green.

## files_changed

- `packages/simulation/src/venue.ts` — pre-flight, batch admission, stage/commit, per-order results, O1-O8/O10, `#pending` + `#sweep`, header table.
- `packages/simulation/src/ports.ts` — `NotPlacedOrder`, `ExecutionResult.outcome`/`notPlaced`, state and `atEvent` docs.
- `packages/simulation/src/refusals.ts` — `SIMULATED_VENUE_ORDER_NOT_SUBMITTED`.
- `packages/simulation/src/index.ts` — export type `NotPlacedOrder`.
- `packages/simulation/README.md` — §5 items 13-16.
- `apps/trader/src/loop.ts` — `#ownBookedOrders`, `#releaseRefusedPlacement` (R3 + BASKET halt + defensive orphan path), comments.
- `apps/trader/src/halt.ts`, `apps/trader/src/halt.test.ts` — `BASKET_PARTIALLY_EXECUTED` → `MANAGE_KNOWN_POSITIONS_ONLY`.
- `apps/trader/src/loop-refused-plan.test.ts` — R3 real-venue pins, BASKET pin, defensive double (`RefusesWhileHoldingVenue`).
- `apps/trader/src/loop-order-lifecycle.test.ts` — ORPHAN converted (double + real venue), O1-O4 CoreLoop pins, risk-input observer.
- `apps/backtest-cli/src/backtest.test.ts` — pin v2.
- `test/unit/simulation/venue-sim1.test.ts` (NEW, 38 tests), `test/unit/simulation/fixtures.ts`, `test/unit/simulation/determinism.test.ts` — pin v2.
- `test/replay-golden/simulation/golden-replay.json`, `test/replay-golden/backtest/static-bracket/{run-pins.json,expected-artifact.txt,README.md}`, `test/replay-golden/paper-e2e/{paper-e2e-run.json,README.md}`.

## tests_run

All at the final tree (`805a578`), pnpm prefixed with `pnpm_config_verify_deps_before_run=false`:
- `pnpm run typecheck` exit 0; `pnpm run lint` exit 0; `pnpm run check:deps` exit 0.
- `pnpm run test` exit 0: **340 files / 7361 tests** (base 339 / 7315; +1 file, +46 tests).
- `pnpm run test:e2e` exit 0: **7 / 157**. `pnpm run test:replay` exit 0: **3 / 17**.
- Determinism, twice each, green: `test/unit/simulation/{determinism,golden-replay,backtest-static-bracket-replay}.test.ts` 3 files / 25 tests (run 1 and run 2); `test/e2e/determinism-golden.test.ts` 1 / 5 (run 1 and run 2).
- `pnpm --filter @polymarket-bot/trader test:integration`: **NOT MET — exit 1, Docker unavailable** (`docker` not found in this WSL distro; `timeout 20 docker info` failed). 10 files / 112 tests passed (including `halts-reservations-and-seams`, `determinism-and-ordering`, `acceptance-3`); the 4 testcontainer files (`durable-pnl-snapshot-postgres`, `trader-health-endpoint-postgres`, `durable-trader-first-fill-postgres`, `univ-4-gateway-opens-trader-redis`; 17 tests) fail at `Could not find a working container runtime strategy`, before any test body.
- `pnpm --filter @polymarket-bot/backtest-cli test`: the package has no `test` script (no-op); its `backtest.test.ts` runs in the root suite. `packages/simulation` has no separate test script.
- **Golden proof** (`scratchpad/sim-1/goldens/prove.mjs` vs `git show HEAD~:` copies in `goldens/base/`): PROOF PASSED. golden-replay.json: only `$.runPins.simulatorVersion` and `$.expected.serialization[1]` (text lines 194, 199), category O9. run-pins.json: only `simulatorVersion` (O9, input). expected-artifact.txt: lines 4 and 11 of 49; line 4 differs only by the pin (O9); line 11 is the CANCELLED take-profit `order` line, tokens 15-16 `5 4 -> 6 5` (O8); every order/fill/economics/decision/trace/ledger/position/pnl/health/store/driver line identical. paper-e2e-run.json: the only structural difference is `$.orders[1].atEventIngestSeq "5" -> "6"` (text line 1146, O8); checkpointInstants, decisions, events, fills, health, ledgerProjection, ledgerTransactions, orderProvenance, pnlRecords, pnlSnapshots, reconciliation, scenario, traces all identical. Regenerated once each: backtest via the scratch capture (two renders byte-equal, written once); paper-e2e via `WP250_WRITE_GOLDEN=1 … determinism-golden.test.ts` (failed on purpose, then re-run without the variable: green); golden-replay by hand per its README.
- **Non-vacuity**: with `6cbecc8`'s `venue.ts` and `loop.ts` restored, `venue-sim1`, `loop-refused-plan`, `loop-order-lifecycle`, `backtest-static-bracket-replay`: 45 failed / 25 passed of 70. Every new venue pin fails except the two O2 contrasts ("a FOK the book can fill whole is FILLED", "Tier 1 agrees: REJECTED 0/50"); failing trader pins: R3 20-slice partial, ≤15 all-or-nothing, BASKET halt, "NOT an orphan", O1-O4 (4); plus the backtest golden (O8). Passing at base as intended: MEDIUM-4 and the two defensive-double orphan pins (retained behaviour). Both files restored byte-identically both times (`sha256sum -c` OK). The second restore's hashes, venue.ts `0909736d…` and loop.ts `c03c18fb…`, equal the committed blobs.
- New tests: `test/unit/simulation/venue-sim1.test.ts` (38); in `loop-refused-plan.test.ts` "SIM-1 R3 — the REAL venue reports what it booked, and the loop OWNS it" (20-slice partial; ≤15 books nothing; MEDIUM-4 kept), "SIM-1 R3 — a BASKET … halts its markets", "TRDR4-R1, the DEFENSIVE path …" (converted); in `loop-order-lifecycle.test.ts` "the ORPHAN … (the defensive path)" (converted), "SIM-1 R3: the REAL venue's partly executed plan is NOT an orphan", "SIM-1 (O1-O4)" ×4; `halt.test.ts` mapping row.

## assumptions

- "Refused mid-way through its 2nd batch" = the 2nd batch is refused whole (all-or-nothing), after the 1st batch booked.
- A PARTIAL is counted `health.execution.submissionsRefused` (the plan was not accepted); no new counter, because `health.execution` is copied wholesale into the paper-e2e artifact.
- DELAYED `atEvent`: the submission event while pending; the resolving event after `matchableAtNs`; the fills keep the book event at `matchableAtNs`. A DELAYED GTD that expires before matching resolves at `matchableAtNs`.
- For a failed pre-flight, the failing order carries the cause's code and the other readable orders `SIMULATED_VENUE_ORDER_NOT_SUBMITTED` naming the cause; a plan whose orders cannot be read has `notPlaced: []`.
- By-id cancels still charge one token per submitted id (venue report §8), and `orderIds: []` remains a no-op.

## deviations

- Pre-flight also includes the per-order policy checks (time-in-force, postOnly/style, REST+FAK/FOK, GTD expiry), not only the three listed categories. A THROWING `timeInForceFor` is therefore a pre-flight failure (nothing booked). The "thrown execution policy after booking started" case is still reachable (`sameInstantAdditionsFor`) and pinned, as is a throw at the budget (outer containment).
- New halt code in `apps/trader/src/halt.ts` (+ one mapping row in `halt.test.ts`): no existing code fitted a BASKET partial (the legs are attributed, so `UNATTRIBUTED_ACTIVITY` would mislabel it). The control-api health door accepts any code string.
- The BASKET pin needs a pass-through `vi.mock` of `buildRiskEvaluationInput` that supplies fee/slippage estimates for BASKET intents only. The shipped loop's `#economicsFor` answers POSITION only, so the REAL risk engine refuses every basket `RISK_EDGE_INPUTS_MISSING`. A BASKET therefore cannot reach the venue through the shipped pipeline today (verified by probe), and this halt path is unreachable in production until that changes.
- Version pin also bumped in `test/unit/simulation/fixtures.ts` and `determinism.test.ts` (unit fixtures carrying the same pin; not goldens).
- Golden READMEs (backtest static-bracket, paper-e2e) got a short regeneration note, following the TRDR-4 precedent.
- Lazy GTD expiry replaced by eager expiry (see summary O4); stated, disclosed, pinned.
- The trader integration gate could not be run with Docker in this session.

## known_risks

- The Docker-backed integration suites (4 files / 17 tests) were not run; CI or a Docker session must run them.
- Rule (c) — per-entry execution within an admitted batch, and no later batch after a failure — is a simulator choice. The venue docs do not state that an admitted batch's entry can fail other than post-only (PP-9).
- Loop release rule: a planned order neither booked nor held is released even if the answer does not list it in `notPlaced`. That is fine for the simulator (which always lists it); a live adapter's incomplete answer is the TRDR4-LIVESETTLE question.
- `observe()` now reads the venue `Clock` and is wrapped in a totality guard. A clock that does not advance (the trader's `ManualClock` in tests) never resolves DELAYED or expires GTD through `observe()`; only `observeTrade()` does. The shipped trader is Tier 0 (no DELAYED) and refuses GTD (no stated expiry), so there is no production reach today.
- `observeTrade()`'s answer now includes fills and bands settled by the sweep, possibly for other markets; the loop ignores the answer (VS-20).
- Tier-0 optimism now applies to MARKETABLE_LIMIT GTC/GTD remainders (whole remainder at the limit on touch), so paper exits can fill later where they used to hang. The static-bracket GTC reduce is one such exit.
- The Tier-1 disposition of a DELAYED order is still computed at submission from `timeline.bookAt(matchableAtNs)` (the pre-existing look-ahead question flagged by the scoping; unchanged).
- `#bands` is still never pruned (VS-04), and cancelled/expired Tier-1 bands stay in `restingBands()`; that is SIM-2's scope. `#pending` is bounded by the live DELAYED orders.

## follow_up

- Run `pnpm --filter @polymarket-bot/trader test:integration` with Docker (and the CI run on GitHub).
- Governance (docs forbidden here): `IMPLEMENTATION_STATUS.md` SIM-1 row and `TRDR4-ORPHAN` (now defensive-only for the simulator); the `docs/handoffs/SIM-1.md` record; correct TRDR-4's "Tier-1 settle-mismatch" statement (VS-16/TERM-F); README/`ports.ts` "adds nothing to the interface" claims (IF-02).
- Queue: a `failurePolicy` consumer for BASKET partials; `#economicsFor` for BASKET intents (a basket is refused at risk today); a health counter for partial submissions (with `TRDR4-GAUGES`, since it would move the paper-e2e golden).
- SIM-2 is unblocked on the "every order terminates" precondition (IF-20). Carry `#pending` and the eager expiry sweep into the bounding design.

## commit_sha

`805a578ddaff26a481cbc384b4d333e657ac27c5` on branch `sim-1` (not pushed).

---

# Appendix — implementer handoff, r1 (verbatim)

# SIM-1 handoff, round 1 (remediation of 805a578)

## plan (written before any edit)

Base of this round: `805a578ddaff26a481cbc384b4d333e657ac27c5` on `sim-1` (clean tree). One commit on top.

### SIM1-R1-1 (HIGH) — a failed DELAYED commit loses its disposition and holds capital

Venue (`packages/simulation/src/venue.ts`, `refusals.ts`):

1. `#sweep` keeps the `#pending` entry until the order has a FINAL answer. The resolved order is built
   and committed inside a per-order containment (`totally`); only after `#commit` succeeded is the
   pending entry deleted.
2. A commit that fails is handled EXPLICITLY, once, at `matchableAtNs`: the order becomes REJECTED,
   `filledShares` "0", `atEvent` = the resolving event; no fill, no cash, no position, no resting
   record, no band (the commit is all-or-nothing, so none of them moved). Venue anchor: D-18 ("If
   the market, balance, allowance, or risk checks fail when the delay expires, the order is rejected
   instead of matching"). No retry: the venue's decision at the end of the window is one-shot, and a
   retry would keep an order DELAYED past its window (uncancellable, capital held) — the defect.
   The REJECTED state is set before the pending entry is deleted, so even a throw there leaves the
   entry to be retried rather than lost.
3. The failure is NOT silent: it is held in a venue list and reported by the next door that answers
   for recorded time — `observe()` (the door that ran the sweep, normally) or `observeTrade()` —
   as `ok: false`, new refusal code `SIMULATED_VENUE_DISPOSITION_NOT_APPLIED`, naming each order, its
   market and the cause. `observe()` still positions the venue first and `observeTrade()` still
   walks the trade (state stays consistent; the failure is reported after). A failure found by a
   cancel's own sweep (cancel answers carry no refusal channel) is held and reported by the next
   `observe()`/`observeTrade()`; the order reads REJECTED immediately in every snapshot.
4. Venue pins (`test/unit/simulation/venue-sim1.test.ts`): the verifier's reproduction (cash
   `"9".repeat(1024)`, 5 s delay, partly fillable FAK) — resolution answers the new code once,
   the order is `REJECTED 0/50`, no fill, cash unchanged, open orders empty, a later cancel answers
   "already REJECTED", a retry `observe()` answers ok; and a cancel-path sweep holds the failure
   until the next `observe()`.

Trader (`apps/trader/src/loop.ts`, `halt.ts`, `halt.test.ts`):

5. `TraderVenue.observe`/`observeTrade` answers gain an optional `refusal` (`{ code, message }`),
   so existing doubles still conform. A failed `observe()` halts GLOBAL with a new code
   `VENUE_OBSERVATION_FAILED` (→ `RECONCILE_ACCOUNT`, "account state unknown"): the venue could not
   be positioned or could not apply what the recorded clock settled. A failed `observeTrade()`
   halts the same way only for `SIMULATED_VENUE_DISPOSITION_NOT_APPLIED`; its other refusals remain
   `VS-20` (out of this package's authorized scope; stated). The REJECTED order is released
   (reservation, allocator, time-in-force) at the harvest that sees it — releases run before the
   halt gate, as today; its delivery is suppressed by the halt and it is retired after the halt is
   released (the existing halt semantics).
6. Loop pin (`apps/trader/src/loop-order-lifecycle.test.ts`): the real CoreLoop over a Tier-1
   `SimulatedVenue` on a delayed market, venue cash `"9".repeat(1024)`: the FAK entry is DELAYED
   and holds 17.5; at `matchableAtNs` it is REJECTED 0/50, released (reservations/allocator/TIF),
   the GLOBAL halt names the order, and nothing is counted open afterwards; plus a control with an
   ordinary balance (same venue) where the DELAYED FAK resolves CANCELLED 30/50 and nothing halts.

### SIM1-R1-2 (LOW) — README additions in the golden directories

7. Restore `test/replay-golden/backtest/static-bracket/README.md` and
   `test/replay-golden/paper-e2e/README.md` byte-identically to `6cbecc8`. The regeneration record
   stays in the commit message and this handoff. Mechanical pin: a scratch script that compares
   EVERY file under `test/replay-golden/` with `6cbecc8` and allows only the named O8/O9 lines —
   it fails at `805a578` (the READMEs) and passes at the new commit.

### Gates and proofs

8. Non-vacuity: restore `805a578`'s `venue.ts`, `refusals.ts`, `loop.ts`, `halt.ts` temporarily,
   run the new pins, name the failures, restore byte-identically (sha256 vs the new blobs).
9. Re-run every gate: typecheck, lint, check:deps, test, test:e2e, test:replay, trader
   test:integration (Docker if available), determinism twice, golden proof.

## findings

| Finding | Severity | Disposition | Pin(s) (fail at `805a578`, pass at `288334c`) |
|---|---|---|---|
| SIM1-R1-1 | HIGH | **Fixed** (venue + loop) | `test/unit/simulation/venue-sim1.test.ts` › "SIM1-R1-1 — a DELAYED disposition the venue cannot APPLY is REJECTED once, reported, and never left DELAYED" (4 failing pins + 1 control); `apps/trader/src/loop-order-lifecycle.test.ts` › "SIM1-R1-1 — a DELAYED entry whose disposition the venue cannot APPLY is REJECTED, released, and HALTS; it never stays open" (2 failing pins + 1 control); `apps/trader/src/halt.test.ts` › "maps every reason code to a §9.9 ladder action" (new row) |
| SIM1-R1-2 | LOW | **Fixed** (the two README additions removed; files byte-identical to `6cbecc8`) | Scratch `scratchpad/sim-1/goldens/prove-dir.mjs`: every tracked file under `test/replay-golden/` must equal `6cbecc8` plus only the O8/O9 substitutions. It FAILS at `805a578` (2 failures: the two READMEs) and PASSES at `288334c`. No in-repo test: a test pinning documentation bytes would not be a behavioural pin, so the mechanical proof is the pin. |

## summary

Round 1 remediation of SIM-1, one commit `288334c6cf95f4f63b82db11e79b843e4ce09e21` on top of `805a578` (branch `sim-1`, not pushed). The plan above was followed with one addition: a loop pin for the `observeTrade()` path (a venue clock lagging the loop's). Both findings are fixed.

**SIM1-R1-1 at the venue** (`packages/simulation/src/venue.ts`, `refusals.ts`, README §5 item 14):

- `#sweep` now builds and commits each due DELAYED disposition inside a per-order `totally`. The `#pending` entry is deleted only after the commit succeeds, or after the failure has been handled.
- A failed commit is handled explicitly, once, at `matchableAtNs`, and is never retried. The order becomes `REJECTED`, `filledShares` "0", `atEvent` = the resolving event.
  - The commit is all-or-nothing, so no fill, cash, position, resting record or band moved.
  - Anchor: venue report D-18, "If the market, balance, allowance, or risk checks fail when the delay expires, the order is rejected instead of matching."
  - `REJECTED` is written before the entry is deleted, so a throw there leaves the entry to be swept again rather than lost.
- The failure goes into `#unapplied`. The next `observe()` or `observeTrade()` reports it exactly once, as `ok: false` with the new code `SIMULATED_VENUE_DISPOSITION_NOT_APPLIED`.
  - `details` holds `simulatedOrderIds`, `marketIds` and `causes`. The message names each order, its market, the cause code and message, and the contained error class.
  - Ordering: `observe()` positions and sweeps first, then answers. `observeTrade()` walks the trade first, then answers.
  - A failure found by a cancel's own sweep makes the order "already REJECTED" at once and waits for the next `observe()`/`observeTrade()`, because `CancelResult` has no refusal channel.
- One order's failure does not stop the rest of the sweep.

**SIM1-R1-1 in the loop** (`apps/trader/src/loop.ts`, `halt.ts`):

- The answers of `TraderVenue.observe`/`observeTrade` gain an optional `refusal: { code, message }` (new exported type `VenueObservationRefusal`).
- A failed `observe()` halts GLOBAL with the new code `VENUE_OBSERVATION_FAILED`, mapped to `RECONCILE_ACCOUNT` ("account state unknown").
- A failed `observeTrade()` halts the same way, but only for `SIMULATED_VENUE_DISPOSITION_NOT_APPLIED`.
- The REJECTED order's reservation, allocator commitment and time-in-force are released at the harvest that sees it. That release runs before the halt gate in `#deliverOrderViews`, unchanged.
- Its terminal view is suppressed by the halt, so it is not an evaluation. It is retired after the halt is released, the existing R1 halt rule.

**SIM1-R1-2.** The two README additions are reverted. The golden directory now differs from `6cbecc8` only by the O8/O9 lines. No golden data byte moved in this round.

## files_changed

(All relative to `/home/adriancova/proyects/tradeBot/polymarket-bot-sim-1`; `git diff 805a578 288334c --stat`: 10 files, +591/−79.)

- `packages/simulation/src/venue.ts`: `UnappliedDisposition`, `#unapplied`, `#sweep` (commit contained, entry kept until final, REJECTED on failure), `#reportUnapplied`, `describeCauseFailure`; `observe()`/`observeTrade()` report; comments.
- `packages/simulation/src/refusals.ts`: new code `SIMULATED_VENUE_DISPOSITION_NOT_APPLIED`.
- `packages/simulation/README.md`: §5 item 14, the failure path.
- `apps/trader/src/loop.ts`: `TraderVenue` answers carry an optional `refusal`, plus `VenueObservationRefusal`, `DISPOSITION_NOT_APPLIED` and `#haltOnVenueObservation`. `observe()`'s answer is read, and `observeTrade()`'s is read for the disposition code.
- `apps/trader/src/halt.ts`, `apps/trader/src/halt.test.ts`: `VENUE_OBSERVATION_FAILED` → `RECONCILE_ACCOUNT`.
- `apps/trader/src/loop-order-lifecycle.test.ts`:
  - `assemble()` gains a `tier1` option: a Tier-1 venue on a delayed market over the loop's own books, zero latency, optional separate venue clock.
  - 3 new tests, header item 7.
- `test/unit/simulation/venue-sim1.test.ts`: 5 new tests, header.
- `test/replay-golden/backtest/static-bracket/README.md`, `test/replay-golden/paper-e2e/README.md`: restored to `6cbecc8`, byte-identical (sha256 `36635058…` and `087f3315…` = base).

## tests_run

All at the final tree (`288334c`), every pnpm command prefixed with `pnpm_config_verify_deps_before_run=false`. Logs are in `scratchpad/sim-1/r1/`.

- `pnpm run typecheck`: exit 0 (re-run after the last edit; 0 `error TS`).
- `pnpm run lint`: exit 0. The first run failed on `prefer-const` in the new test harness; that was fixed and the re-run is clean.
- `pnpm run check:deps`: exit 0 (PASS line).
- `pnpm run test`: exit 0, **340 files / 7369 tests**. Base `6cbecc8` was 339 / 7315; `805a578` was 340 / 7361; this round adds 8 tests (5 venue, 3 loop).
- `pnpm run test:e2e`: exit 0, **7 / 157**.
- `pnpm run test:replay`: exit 0, **3 / 17**, run twice.
- Determinism, twice each, green:
  - `test/unit/simulation/{determinism,golden-replay,backtest-static-bracket-replay}.test.ts`: 3 files / 25 tests, runs 1 and 2.
  - `test/e2e/determinism-golden.test.ts`: 1 / 5, runs 1 and 2.
- `pnpm --filter @polymarket-bot/trader test:integration`: **NOT MET, exit 1, Docker unavailable.** `timeout 20 docker info` gives "The command 'docker' could not be found in this WSL 2 distro".
  - 10 files / 112 tests pass, 17 skipped.
  - The 4 testcontainer files fail at "Could not find a working container runtime strategy" before any test body: `durable-pnl-snapshot-postgres`, `durable-trader-first-fill-postgres`, `trader-health-endpoint-postgres`, `univ-4-gateway-opens-trader-redis`.
- `pnpm --filter @polymarket-bot/backtest-cli test`: no `test` script; `backtest.test.ts` runs inside the root suite. `packages/simulation` has no separate script.
- **Golden directory proof** (`scratchpad/sim-1/goldens/prove-dir.mjs`):
  - Target `805a578`: FAILED, 2 failures (the two READMEs, 170→181 and 210→223 lines).
  - Target `288334c` and the worktree: PASSED. No file added or removed. The 4 data files each equal base plus only their permitted O8/O9 substitution; the 9 other files are byte-identical.
- **Non-vacuity** (`scratchpad/sim-1/r1/nonvac.sh`, run under bash):
  - Restored `805a578`'s `venue.ts`, `refusals.ts`, `loop.ts` and `halt.ts`; each hash was checked equal to the `805a578` blob.
  - Ran `venue-sim1`, `loop-order-lifecycle` and `halt` tests: **7 failed / 69 passed of 76**.
  - Failing: the 4 venue SIM1-R1-1 pins. Their messages include "expected 'DELAYED 0/50' to be 'REJECTED 0/50'", "expected 'SIMULATION_INTERNAL' to be 'SIMULATED_VENUE_DISPOSITION_NOT_APPLIED'", and at `805a578` the cancel-sweep case made the whole cancel fail `SIMULATION_INTERNAL` "(the command could not be read)". Also failing: the 2 loop pins (observe path, observeTrade path) and the halt mapping row.
  - Passing as intended: both controls, plus every pre-existing test.
  - Restored byte-identically: `sha256sum -c` OK for all four files. Their hashes (`3a40c7ee…`, `8f022998…`, `552e4e04…`, `45e208be…`) equal the committed blobs.
- New tests:
  - venue: "observe() at matchableAtNs: REJECTED 0/50, nothing booked, the failure answered ONCE, then cancel says 'already REJECTED'"; "one order's failure does not stop the sweep: a later DELAYED GTC due at the same instant still RESTS"; "observeTrade() at matchableAtNs reports it too — after walking the trade — and only once"; "a cancel's OWN sweep finds it: the order is 'already REJECTED' at once, and the next observe() reports the failure"; "the control: the same order with an ordinary balance resolves CANCELLED 30/50 and observe() answers ok".
  - loop: "a venue balance the fill accounting cannot carry: REJECTED 0/50 at matchableAtNs, every entry released, a GLOBAL VENUE_OBSERVATION_FAILED halt, nothing counted open"; "reached first by a TRADE (the venue's clock lags the loop's): observeTrade()'s answer halts the same way"; "the control: the same DELAYED entry with an ordinary balance resolves CANCELLED 30/50 at matchableAtNs — released, retired, settled, and nothing halts".
  - halt mapping row `VENUE_OBSERVATION_FAILED`.

## assumptions

- A failed commit at `matchableAtNs` is final: REJECTED, not retried. Two reasons:
  - D-18 decides a delayed order at the end of its window.
  - A retry keeps the order DELAYED past its window, which is the defect.
  The failure class seen (a decimal operand too long) is deterministic for a given balance.
- REJECTED is chosen over CANCELLED because D-18 names "rejected" for checks that fail at delay expiry, and nobody cancelled the order.
- The loop halt scope is GLOBAL and the action `RECONCILE_ACCOUNT`, because the venue is one account and cash is what the failed accounting could not book. A MARKET-scoped halt of the named market(s) would be a narrower alternative.
- Every failed `observe()` halts, not just the new code. The loop always passes a recorded identity, so any refusal there means the venue cannot anchor what it produces (§6 invariant 15). The replay driver already stops on it. No existing test reached this (suite, e2e and replay are green).

## deviations

- `apps/trader/src/loop.ts` changes outside the refusal/partial branch (the `observe()`/`observeTrade()` call sites and the `TraderVenue` answer types), plus a new halt code in `halt.ts` with its `halt.test.ts` row.
  - Why: required by the finding's remediation ("Propagate the failure through the loop's failure handling … at both venue and loop boundaries").
  - Scope: inside `apps/trader/src/**`; no other package is touched.
- The loop halts on `observeTrade()` refusals only for `SIMULATED_VENUE_DISPOSITION_NOT_APPLIED`. Other `observeTrade()` refusals remain unread, which is the scoping's `VS-20`, assigned to another lens. Widening this would change paper behaviour on public-trade inputs this package does not own.
- The SIM1-R1-2 pin is a scratch mechanical proof, not an in-repo test (argued in the findings table).

## known_risks

- The Docker-backed integration suites (4 files / 17 tests) were still not run; CI or a Docker session must run them.
- A disposition failure found by a cancel's own sweep is reported at the next `observe()`/`observeTrade()`, not on the cancel's answer; the order reads REJECTED immediately. If no later `observe()`/`observeTrade()` ever runs (a direct venue user that stops after a cancel), the failure is visible only as the REJECTED state. The shipped drivers (the trader loop and `replay.ts`) call `observe()` for every event before any cancel, at the same clock, so there the sweep failure surfaces through `observe()` itself.
- Under the GLOBAL halt the REJECTED order is released but not retired: its terminal view is suppressed until an operator releases the halt. This is the existing halt rule, pinned by TRDR-4's "a HALTED instance …" case.
- The loop's `observeTrade()` branch is reachable only when the venue's clock differs from the loop's (pinned that way). With a shared clock, `observe()` always reaches `matchableAtNs` first.
- The submission-time commit (`#submitSync` → `#commit`) is still contained by the outer PP-3 path rather than per order. A throwing `#applyFills` at submission books nothing for that order (atomic) and reports the rest through `#refuseInProgress`, unchanged from r0.
- The verifier's residual is unchanged and outside this finding: a market-scoped cancel charges the live-target count up front, while the dated venue report describes one admission token and then a per-success debit.
- Tier-1 bands remain estimates, and terminal band retention is SIM-2's.

## follow_up

- Run `pnpm --filter @polymarket-bot/trader test:integration` with Docker, and the GitHub CI run.
- `VS-20`: decide whether the loop should halt (or count) on every `observeTrade()` refusal. Today only the disposition code is read.
- Market-cancel budget accounting (the verifier's residual): one admission token, then per-success debit.
- Governance (docs are forbidden here): record `VENUE_OBSERVATION_FAILED` and `SIMULATED_VENUE_DISPOSITION_NOT_APPLIED` in the SIM-1 handoff record, together with r0's items.

## commit_sha

`288334c6cf95f4f63b82db11e79b843e4ce09e21` on branch `sim-1`, parent `805a578ddaff26a481cbc384b4d333e657ac27c5` (not pushed, not amended).

---

# Appendix — implementer handoff, r2 (verbatim)

# SIM-1 handoff, round 2 (remediation of 288334c)

## plan (written before any edit)

Base of this round: `288334c6cf95f4f63b82db11e79b843e4ce09e21` on `sim-1` (clean tree). One commit on top,
first line `SIM-1 r2: ...`. Docker is unavailable in this session (`docker` not found in the WSL distro).

### SIM1-R2-1 (HIGH) — an ACCEPTED basket whose legs did not all EXECUTE bypasses the basket halt

Diagnosis (to be confirmed by the new pins at `288334c`): the venue answers `accepted: true`,
`outcome: "ACCEPTED"` whenever every planned order was BOOKED, and a booked order can end at once
without executing (O2: a Tier-0/Tier-1 FOK that cannot fill whole is booked `REJECTED 0/n`; O1: a FAK
remainder is `CANCELLED` short). The loop's basket halt lives only in `#releaseRefusedPlacement`, which
runs only under `!result.accepted`. It also never sees a DELAYED leg that resolves short later (O5).

The venue stays as it is (O1/O2 are the packet's rulings; "accepted" = every planned order was
PLACED). The loop decides basket completeness from EACH ORDER'S OWN OUTCOME:

1. `apps/trader/src/loop.ts`: a small per-plan BASKET WATCH (`#basketWatches`, keyed by execution plan
   id), created in `#submitPlan` for every BASKET plan the venue booked anything of, on the accepted
   AND the partial path, after `#ownBookedOrders`. It holds the plan id, failurePolicy, markets,
   planned count, the booked venue order ids and the answer's `notPlaced`.
2. `#checkBasket` halts every market of the basket `BASKET_PARTIALLY_EXECUTED` when
   (a) the answer was PARTIAL (booked some, placed not all) — R3's rule, unchanged; or
   (b) a booked order is TERMINAL SHORT of its size (REJECTED, CANCELLED, EXPIRED with
       `filledShares < requestedShares`) while some part of the basket executed (an order with a fill)
       or can still execute (a working order).
   A basket that executed NOTHING (every booked order terminal with no fill) is, like a wholly
   refused one, not partial: no halt; its capital comes back through the normal terminal release.
   A watch ends when it halts or when every booked order is terminal; so it holds working baskets
   only (bounded like TRDR-4's per-order state), and its size is published in `retainedOrderState()`.
3. The check runs at the four places an order's outcome can change before a decision reads it:
   at submission (from the venue's answer), right after `observe()` (DELAYED dispositions and GTD
   expiry are applied there), right after `observeTrade()` (the trade-instant sweep), and in the
   harvest after the settled-order release and before any delivery (cancels and fills produced
   during evaluations). So the halt is raised before the strategy is evaluated for a market whose
   basket just went short.
4. Ownership and terminal-release rules are untouched: the booked orders stay owned; reservations,
   allocator commitments and time-in-force still come back only at terminal; deliveries of a halted
   market are suppressed as for every halt (retired after release).
5. `packages/simulation/src/ports.ts` + README §5 item 13: correct the overstated doc — `accepted`
   says every planned order was PLACED, not that each executed; a consumer that needs every order
   executed (a basket) reads each order's `state`/`filledShares`.

Pins (in `apps/trader/src/loop-refused-plan.test.ts`, which already carries the basket-economics
seam): the verifier's reproduction (Tier-0 FOK, venue NO ladder capped at one share per level:
YES FILLED 5/5 ×2, NO REJECTED 0/5 ×2, ACCEPTED) must halt; a FAK variant whose NO leg is CANCELLED
short must halt; a DELAYED basket on a Tier-1 delayed market must not halt inside the window and
must halt at `matchableAtNs`, before that event's evaluation; controls: every leg FILLED → no halt,
every leg REJECTED 0 → no halt, watch count back to 0. Then non-vacuity with `288334c`'s `loop.ts`.

### Gates

Re-run typecheck, lint, check:deps, test, test:e2e, test:replay (twice), determinism twice, the
golden-directory proof, trader test:integration (Docker if present).

## findings

| Finding | Severity | Disposition | Pin(s) that FAIL at `288334c` and PASS at `9019d37` |
|---|---|---|---|
| SIM1-R2-1 | HIGH | **Fixed**, in the trader. The venue is unchanged: O1/O2 stand, and `accepted` is documented as "placed", not "executed". | `apps/trader/src/loop-refused-plan.test.ts`, describe "SIM1-R2-1 — a BASKET is judged from EACH ORDER'S outcome, not from the venue's `accepted`": (1) "the verifier's reproduction: an ACCEPTED FOK basket — YES FILLED, NO REJECTED 0/5 — halts BASKET_PARTIALLY_EXECUTED at submission …"; (2) "a FAK basket whose NO slices are CANCELLED short (1 of 5 filled each) halts the same way …"; (3) "a DELAYED basket (Tier 1, 5 s delayed market): no halt inside the window; at matchableAtNs …"; (4) "the same DELAYED basket reached first by a TRADE …"; (5) "a GTC basket whose NO slices REST partly filled is WATCHED, not halted; the strategy's own market cancel …"; (6) "the controls: …" (fails at base only on the new `basketWatches` field). Also `apps/trader/src/basket-execution.test.ts` (9 tests, one per branch of the rule), and the two `retainedOrderState()` `toEqual` pins, which gain `basketWatches: 0`. |

The report also lists residuals. None of them is a finding, so none is fixed in this round; they are in follow_up:

- Market-cancel budgeting charges up front.
- Tier-1 maker bands are estimates (SIM-2's scope).
- Hand-built plans with out-of-range limit prices are accepted. The verifier calls this a pre-existing limitation, separate from the blocker.

## summary

Round 2 remediation of SIM-1: one commit, `9019d3762f03b2161e9b7d4982f29ebbab9c077f`, on top of `288334c` (branch `sim-1`, not pushed, not amended). The plan above was followed. One pin was added beyond it: the harvest-path GTC case (5), so that every new call site has a pin that kills its removal.

**Diagnosis, confirmed.** The finding is reproduced by pins (1)–(5) at `288334c`.
- The venue answers `accepted: true` / `"ACCEPTED"` when every planned order was booked.
- A booked order can still end without executing, or reach its outcome later:
  - O2: a FOK that cannot fill whole is `REJECTED 0/n`.
  - O1: a FAK remainder is `CANCELLED`.
  - O5: a DELAYED order resolves at `matchableAtNs`.
  - O4: a GTD expires.
- The loop's `BASKET_PARTIALLY_EXECUTED` halt ran only under `!result.accepted`.

**The rule.** New `apps/trader/src/basket-execution.ts`, `judgeBasketExecution`, returns `WORKING`, `COMPLETE` or `PARTIALLY_EXECUTED`. It judges from each booked order's own `state`, `filledShares` and `requestedShares`, and the answer's `notPlaced` count. A basket is PARTIALLY_EXECUTED when either:
- (a) the answer was PARTIAL: some orders booked, others not placed. This is R3's rule, unchanged. Or:
- (b) a booked order is terminal and short (`REJECTED`, `CANCELLED` or `EXPIRED` with filled < requested), while part of the basket executed (an order has a fill) or can still execute (an order is non-terminal).

Other outcomes:
- If every booked order is terminal, the basket is COMPLETE when all of them FILLED, or when none of them executed anything.
- Otherwise it is WORKING.

Fail-closed readings:
- An order the venue does not list counts as working.
- A non-canonical quantity counts as both executed and short.

**The loop** (`apps/trader/src/loop.ts`):
- `#watchBasket` runs for every BASKET plan the venue booked anything of, on the accepted path and on the partial path, after `#ownBookedOrders`. This is where "basket" is detected: `plan.planKind === "BASKET"`. It builds a `BasketWatch` and judges it at once from the venue's answer.
- A WORKING basket is kept in `#basketWatches`, keyed by execution plan id. It is bounded by the working baskets and published as `retainedOrderState().basketWatches`.
- It is judged again by `#judgeBasketWatches` at three call sites:
  - right after `observe()`, where DELAYED dispositions and GTD expiry are applied;
  - right after `observeTrade()`, the trade-instant sweep;
  - in `#harvestFills`, after `#releaseSettledReservations()` and before any delivery (cancels and fills produced during evaluations).
- So the halt is raised before the strategy is evaluated for the market.
- A watch ends when it halts (once per market, `MANAGE_KNOWN_POSITIONS_ONLY`) or when it is COMPLETE.
- `#releaseRefusedPlacement` no longer halts baskets itself. Its release and defensive-orphan logic is unchanged.
- Ownership is unchanged. So are the terminal-release rules: reservation, allocator commitment and time-in-force come back only at the harvest that sees an order terminal. Deliveries are suppressed under a halt as before, and an order is retired after the halt is released.

**Docs.**
- `packages/simulation/src/ports.ts`: `accepted` means every planned order was PLACED (booked), not that each executed. A consumer that needs every order executed must read each order's state.
- `packages/simulation/README.md` §5 item 13 says the same.
- `apps/trader/src/halt.ts`: the `BASKET_PARTIALLY_EXECUTED` doc line now notes that an ACCEPTED plan is judged too.

**Worked outcome** of the verifier's reproduction on `9019d37`:
- ACCEPTED, with YES FILLED 5/5 ×2 and NO REJECTED 0/5 ×2.
- One `MARKET` halt, `BASKET_PARTIALLY_EXECUTED`, raised at the answer.
- No `onFill` or `onOrderUpdate` evaluation reached the strategy.
- 4 of 4 reservations and allocator commitments released; all time-in-force entries released.
- `unownedFills` 0, unattributed activity 0, 4 provenance records.
- `basketWatches` 0.

## files_changed

`git diff --stat 288334c 9019d37`: 9 files, +864/−79.

- `apps/trader/src/basket-execution.ts` (NEW): `judgeBasketExecution` and `BasketExecutionVerdict`.
- `apps/trader/src/basket-execution.test.ts` (NEW): 9 tests.
- `apps/trader/src/loop.ts`:
  - `BasketWatch`, `#basketWatches`, `#watchBasket`, `#judgeBasketWatches` and `#judgeBasket`.
  - The three call sites, plus the accepted-path and partial-path calls.
  - `RetainedOrderState.basketWatches`.
  - The basket block is removed from `#releaseRefusedPlacement`, and its docstring now points to `#watchBasket`.
- `apps/trader/src/halt.ts`: doc comment only.
- `apps/trader/src/loop-refused-plan.test.ts`:
  - Harness options `venueLadder`, `immediateOrderType` (FAK/FOK/GTC), `tier1` (Tier-1 delayed market, optional own clock) and `followUp` (one follow-up intent from the strategy double); `clock` on the Harness.
  - 6 new tests; header items 4a–4d.
  - The existing tests are unchanged.
- `apps/trader/src/loop-order-lifecycle.test.ts`, `apps/trader/src/loop-long-run.test.ts`: `basketWatches: 0` added to one `retainedOrderState()` `toEqual` each.
- `packages/simulation/src/ports.ts`: `ExecutionResult` / `accepted` / `outcome` / `refusalCode` docs.
- `packages/simulation/README.md`: §5 item 13, one paragraph.

## tests_run

The gates ran on the working tree that was then committed with no further edit as `9019d37`. The non-vacuity and mutation probes were re-run after the commit, on `9019d37` itself. Every pnpm command was prefixed with `pnpm_config_verify_deps_before_run=false`. Logs are in `scratchpad/sim-1/r2/`.

- `pnpm run typecheck`: exit 0, 0 `error TS`.
- `pnpm run lint`: exit 0.
- `pnpm run check:deps`: exit 0 (PASS line).
- `pnpm run test`: exit 0, **341 files / 7384 tests**. For comparison: r1 was 340 / 7369 and base `6cbecc8` was 339 / 7315. This round adds 1 file and 15 tests (9 unit, 6 loop).
- `pnpm run test:e2e`: exit 0, **7 / 157**.
- `pnpm run test:replay`: exit 0, **3 / 17**, run twice.
- Determinism, twice each, green:
  - `test/unit/simulation/{determinism,golden-replay,backtest-static-bracket-replay}.test.ts`: 3 files / 25 tests (runs 1 and 2).
  - `test/e2e/determinism-golden.test.ts` (config `test/e2e/vitest.config.ts`): 1 / 5 (runs 1 and 2).
  - One run of my own invocation used the wrong config path, failed at esbuild startup, and was re-run correctly. Stated so no log is misread.
- `pnpm --filter @polymarket-bot/trader test:integration`: **NOT MET, exit 1, Docker unavailable.** `timeout 20 docker info` gives "The command 'docker' could not be found in this WSL 2 distro".
  - 10 files / 112 tests pass, 17 skipped.
  - The 4 testcontainer files fail at "Could not find a working container runtime strategy" before any test body: `durable-pnl-snapshot-postgres`, `durable-trader-first-fill-postgres`, `trader-health-endpoint-postgres`, `univ-4-gateway-opens-trader-redis`.
- `pnpm --filter @polymarket-bot/backtest-cli test`: the package has no `test` script, and `packages/simulation` has no separate script. Both suites run in the root gate.
- **Goldens:**
  - `git diff 288334c 9019d37 -- test/replay-golden` is empty.
  - `scratchpad/sim-1/goldens/prove-dir.mjs WORKTREE` gives GOLDEN DIRECTORY PROOF PASSED. The 4 data files equal `6cbecc8` plus only their O8/O9 substitutions, the 9 other files are byte-identical, and no file was added or removed.
- **Non-vacuity** (`scratchpad/sim-1/r2/nonvac2.sh`, re-run on the committed tree):
  - `288334c`'s `loop.ts` restored; its sha256 `552e4e04…` equals the `288334c` blob.
  - Run 1, the committed pins (`loop-refused-plan`, `loop-order-lifecycle`, `loop-long-run`, `basket-execution`, `halt`): **8 failed / 46 passed of 54.**
    - Failing: all 6 new SIM1-R2-1 loop tests, and the two `retainedOrderState()` `toEqual` pins (new field).
    - At base, pins (1), (2) and (4) fail on "expected [] to have a length of 1" (no halt). Pins (3), (5) and the controls fail first on the new `basketWatches` field.
  - Run 2, a scratch copy of the refused-plan file with every `basketWatches` line removed, `-t SIM1-R2-1`: **5 failed / 1 passed.**
    - All five finding pins (1)–(5) fail on "expected [] to have a length of 1 but got +0", so the halt assertion itself fails at base.
    - The controls pass at base, as intended.
  - The scratch file was deleted, and `loop.ts` restored byte-identically (`sha256sum -c` OK). Its sha256 `846470fd…` equals the `9019d37` blob.
- **Mutation probes** (`scratchpad/sim-1/r2/mutants.py`, re-run on the committed tree). Each mutant was applied, then `loop-refused-plan` + `basket-execution` were run, then the file was restored and its sha256 checked. Every mutant was killed:

| Mutant | Result | Failing pin |
|---|---|---|
| M1: no judgement after `observe()` | 1 failed | DELAYED pin (3) |
| M2: no judgement after `observeTrade()` | 1 failed | trade pin (4) |
| M3: no judgement in the harvest | 1 failed | GTC-cancel pin (5) |
| M4: accepted path not watched | 5 failed | — |
| M5: partial path not watched | 1 failed | existing R3 BASKET pin |
| M6: rule (b) without the executed-or-working condition | 2 failed | the nothing-executed control, and its unit test |
| M7: a missing order counted as terminal | 1 failed | fail-closed unit test |

- **New tests:**
  - `loop-refused-plan.test.ts` describe "SIM1-R2-1 — a BASKET is judged from EACH ORDER'S outcome, not from the venue's `accepted`": the 6 listed in the findings table.
  - `basket-execution.test.ts` describe "judgeBasketExecution — COMPLETE, WORKING or PARTIALLY_EXECUTED, from each order's own outcome", 9 tests:
    - every FILLED;
    - the finding;
    - short beside working;
    - short with a fill;
    - nothing executed;
    - working;
    - R3 rule (a);
    - fail-closed missing order;
    - fail-closed unreadable quantity.

## assumptions

- "Partially executed" means some part of the basket executed or can still execute, while another part ended short.
  - A basket whose booked orders all ended with NO fill (e.g. every FOK leg REJECTED) is treated like a wholly refused plan: there is nothing to unwind or hold, so there is no halt. Its capital comes back through the normal terminal release. This is pinned by a control and by a unit test.
  - R3's rule (a) is kept literally: a PARTIAL answer halts even if its booked orders then executed nothing. Not weakening R3 took precedence over symmetry.
- A basket leg the strategy itself cancels while another leg filled (the GTC case) is a partial basket and halts. Nothing consumes `failurePolicy`, so the operator decides. A strategy that cancels ALL its working legs in one harvest before any fill does not halt: every leg ends with zero fill, so the basket is COMPLETE.
- The halt scope is unchanged from r0: every market the basket's groups name, `MARKET` scope. A pre-existing `MARKET` halt keeps its first code (`HaltController` semantics).
- The judgement relies on `ordersSnapshot()` listing each booked order until it has been seen terminal. The simulator never drops orders, and TRDR-4's settlement relies on the same property.

## deviations

- A new module, `apps/trader/src/basket-execution.ts`, plus its test, rather than inline code in `loop.ts`. It keeps the rule pure and unit-testable per branch. It is inside `apps/trader/src/**`, and it is the R3 basket-halt branch, so it is not an adjacent redesign.
- New call sites in `loop.ts` outside the refusal/partial branch (after `observe()`, after `observeTrade()`, in the harvest). The finding's remediation requires covering "outcomes resolved after DELAYED submission". Those outcomes arrive only through the observation doors and the harvest. Mutants M1–M3 show each site is load-bearing.
- `RetainedOrderState` gains `basketWatches`, and two TRDR-4 `toEqual` pins gain `basketWatches: 0`. This strengthens those pins; nothing was removed.
- `packages/simulation` changes are documentation only (`ports.ts` and the README). No venue behaviour changed in this round, so no simulator version bump is needed and no golden moved.

## known_risks

- The Docker-backed integration suites (4 files / 17 tests) were not run in this or any earlier round. CI or a Docker session must run them.
- Basket halting is still unreachable in production. `CoreLoop.#economicsFor` supplies fee/slippage estimates for POSITION intents only, so the real risk engine refuses every BASKET before execution (`RISK_EDGE_INPUTS_MISSING`). The pins reach the branch through the same pass-through `vi.mock` seam as r0's basket pin. The verifier flagged the same limit.
- The watch holds an order it cannot find in `ordersSnapshot()` as working (fail-closed). A future venue that prunes orders it has not yet reported terminal (SIM-2's bounding) would keep such a watch indefinitely, and could raise a halt for a short leg beside it. SIM-2 should keep terminal orders visible until the loop has seen them, as TRDR-4 already requires.
- When baskets are watched, `#judgeBasketWatches` takes one `ordersSnapshot()` per call site per event. That is up to 2 + (trades) per event, and only while a basket is watched. With no basket it costs a size check.
- Under the halt, the basket's terminal orders are released but not retired until an operator releases the halt. This is the existing R1 halt rule, the same as r0's partial basket and r1's disposition halt.

## follow_up

- Run `pnpm --filter @polymarket-bot/trader test:integration` with Docker, and the GitHub CI run.
- A `failurePolicy` consumer for BASKET partials (ABANDON / PROTECTED_UNWIND / HOLD_FILLED_LEGS), and `#economicsFor` for BASKET intents. These are the queue items from r0; this round only makes the halt complete.
- Verifier residuals, not findings of this round:
  - A market-cancel budget of one admission token plus a per-success debit.
  - Price-range validation of hand-built planned orders (0, −0.1, 1.1). A pre-existing validation gap; changing it alters `validatePlannedOrder` for every consumer, so it needs its own ruling.
  - Tier-1 band retention (SIM-2).
- SIM-2: keep a terminal order in `ordersSnapshot()` until the loop has seen it, so TRDR-4 settlement and the basket watch both terminate.
- Governance (docs are forbidden here): record in the SIM-1 handoff record that the trader judges baskets per order (`basket-execution.ts`), and that `accepted` means "placed".

## commit_sha

`9019d3762f03b2161e9b7d4982f29ebbab9c077f` on branch `sim-1`, parent `288334c6cf95f4f63b82db11e79b843e4ce09e21` (not pushed, not amended).

---

# Appendix — implementer handoff, r3 (verbatim)

# SIM-1 handoff, round 3 (remediation of 9019d37)

## plan (written before any edit)

Base of this round: `9019d3762f03b2161e9b7d4982f29ebbab9c077f` on `sim-1` (clean tree). One commit on
top, first line `SIM-1 r3: ...`. Docker is unavailable in this session (`docker` not found in the WSL
distro), as in r1/r2.

### SIM1-R3-1 (HIGH) — a basket cancelled from a delivery callback can execute another order before the halt

Diagnosis (to be confirmed by new pins at `9019d37`): the r2 basket watch is judged after `observe()`,
after `observeTrade()`, at a basket's own submission, and ONCE in `#harvestFills` before deliveries.
But the deliveries themselves (`#deliverFill` -> `onFill`, `#deliverOrderViews` -> `onOrderUpdate`)
evaluate the strategy, and an evaluation can submit a CANCEL that leaves a watched basket short. Both
CANCEL branches of `#submitPlan` (accepted, and refused/partial) return without judging, so the next
callback of the same harvest - or the next intent of the same decision - executes with no halt.

The venue's order state changes at exactly three doors the loop calls: `observe()`, `observeTrade()`
and `submit()` (every strategy evaluation - per event, `onFill`, `onOrderUpdate` - reaches the venue
only through `#consumeOutcome` -> `#routeIntent` -> `#submitPlan` -> `venue.submit`, the single call
site). r2 judged after the first two; the fix judges after the third:

1. `apps/trader/src/loop.ts` `#submitPlan`: the answer handling (the two CANCEL branches, the partial
   placement branch, the accepted placement branch) moves into one synchronous helper, and
   `#judgeBasketWatches(instant)` runs right after it, for EVERY answer - an accepted cancel, a
   partial or refused cancel, a placement of any kind. So a basket a cancel left short halts before
   control returns to `#consumeOutcome` (next intent of the same decision: refused by risk
   `RISK_RUN_STATE_BLOCKS`, since `runStatePermitsIntent = !anyHalt`) or to the delivery loops (next
   `onFill` / `onOrderUpdate`: suppressed by their existing per-delivery `isInstanceHalted` gate).
   Free when nothing is watched (a size check).
2. Docs: the `#watchBasket` docstring lists the judgement points; add the post-answer one and the
   "three doors" argument. No behaviour change beyond the new call.

Pins (in `apps/trader/src/loop-refused-plan.test.ts`, which has the basket-economics seam): the
harness strategy double gains a scripted delivery hook (`onDelivery(callback, n, ctx)` -> intents).
GTC basket, NO asks capped at one share per level (YES FILLED 5/5 x2, NO PARTIALLY_FILLED 1/5 x2,
watched). New describe "SIM1-R3-1":
- (A) `onFill` #1 emits a market CANCEL, `onFill` #2 a 5-share YES POSITION: halt at the cancel, no
  POSITION submitted, later deliveries suppressed;
- (B) the same through `onOrderUpdate` (`onFill` holds);
- (C) ONE decision `[CANCEL, POSITION]` from `onFill` #1: the POSITION is refused
  `RISK_RUN_STATE_BLOCKS`, never submitted;
- (D) a PARTIAL cancel answer (real venue: `orderIds` [a NO leg, a FILLED YES leg] -> one cancelled,
  one "already FILLED", `accepted:false`/`PARTIAL`): halt at the answer, POSITION not submitted;
- (E) control: a COMPLETE (all FILLED) basket - no watch - the callback's cancel then POSITION: no
  halt, the POSITION is submitted (the new judgement does not over-halt).
Then non-vacuity with `9019d37`'s `loop.ts` restored, and a mutant removing the new call.

### Gates

typecheck, lint, check:deps, test, test:e2e, test:replay (twice), determinism twice, golden-directory
proof, trader test:integration (Docker if present).

## findings

| Finding | Severity | Disposition | Pin(s) that FAIL at `9019d37` and PASS at `31504b2` |
|---|---|---|---|
| SIM1-R3-1 | HIGH | **Fixed** in `apps/trader/src/loop.ts`: every venue answer is followed by a basket judgement. | `apps/trader/src/loop-refused-plan.test.ts`, describe "SIM1-R3-1 — a basket a DELIVERY callback leaves short halts at the venue's answer, before any other intent or callback executes": (1) "onFill: the first fill delivery cancels the basket's working NO legs …"; (2) "onOrderUpdate: the first order view's evaluation cancels the NO legs …"; (3) "ONE decision [CANCEL, POSITION]: … refused at the risk seam (RISK_RUN_STATE_BLOCKS) …"; (4) "a PARTIAL cancel answer (orderIds: a working NO leg and a FILLED YES leg …)". Plus two pins that pass at both commits: (5) the harvest BACKSTOP pin (kills mutant R3-M4) and (6) the COMPLETE-basket control. |

No other finding was raised in round 3. The verifier also listed three residuals. None is a finding, so none is fixed in this round (see follow_up):
- Market cancels charge the live-target count up front.
- Tier-1 maker bands are estimates (SIM-2's scope).
- Basket production reachability is blocked by missing economics inputs.

## summary

This is the round-3 remediation of SIM-1: one commit, `31504b280d73ad5007db180114265d9bb9fb939b`, on top of `9019d37` (branch `sim-1`; not pushed, not amended). I followed the plan above. One pin was added beyond it: the harvest-backstop pin (5), so that the harvest judgement, which is now redundant for the real simulator, still has a pin that fails when it is removed.

**Diagnosis, confirmed at `9019d37` by pins (1)–(4).**
- The GTC basket answers ACCEPTED with YES FILLED 5/5 ×2 and NO PARTIALLY_FILLED 1/5 ×2. It is watched, with no halt.
- The harvest of that same event delivers its fills (`onFill`) and order views (`onOrderUpdate`) to the strategy.
- A CANCEL emitted there leaves the NO legs CANCELLED 1/5 next to the FILLED YES legs.
- Both CANCEL branches of `#submitPlan` returned without judging. So the next `onFill`/`onOrderUpdate`, or the next intent of the same decision, placed a 5-share YES BUY:
  - `submitted` = BASKET, CANCEL, POSITION;
  - halts `[]`;
  - a fifth order at the venue.
- The halt came only at the next event.

**The fix (`apps/trader/src/loop.ts`).** The venue's order state changes at exactly three doors that the loop calls: `observe()`, `observeTrade()` and `submit()`.
- Every strategy evaluation reaches the venue only through `#consumeOutcome` → `#routeIntent` → `#submitPlan` → `venue.submit`. That covers per-event evaluations, `onFill` and `onOrderUpdate`, and it is the single call site.
- r2 already judged after the first two doors. r3 judges after the third:
  - `#submitPlan`'s answer handling moves unchanged into `#absorbVenueAnswer`. That covers the two CANCEL branches, the partial placement branch and the accepted placement branch.
  - `#judgeBasketWatches(input.instant)` runs right after it, for every answer: an accepted cancel, a PARTIAL or refused cancel, and any placement.
- A basket left short therefore halts (MARKET, `BASKET_PARTIALLY_EXECUTED`) before control returns:
  - to `#consumeOutcome`. The decision's next non-cancel intent is refused at the risk seam: `runStatePermitsIntent` is `!anyHalt`, so the code is `RISK_RUN_STATE_BLOCKS`. A CANCEL still passes (§6 invariant 13).
  - or to the delivery loops. The next `onFill`/`onOrderUpdate` is suppressed by the existing per-delivery `isInstanceHalted` gate.
- The judgement costs nothing when no basket is watched (a size check).
- The r2 harvest judgement stays. Its comment now names it as the BACKSTOP for a venue whose state moves between the loop's calls.
- The `#watchBasket` docstring now lists every judgement point.
- Unchanged: ownership, the release rules (ADR-006 §9: nothing released before terminal), TRDR-4 retirement and the defensive orphan path.

**Worked outcome on `31504b2`, pin (1).**
- `submitted` = BASKET, CANCEL.
- Venue orders: YES FILLED 5/5 ×2, NO CANCELLED 1/5 ×2, and no fifth order.
- One halt, at event 4's instant, whose detail includes "2 booked order(s) ended short of their size" and "CANCELLED 1/5".
- Evaluations: `onFeatures`, then the one `onFill` that cancelled. The other three fill deliveries and every order view were suppressed (`deliveriesSuppressedByHalt` ≥ 3).
- Reservations and allocator: open 0, taken/applied 4, released 4.
- `basketWatches` 0, `unownedFills` 0.
- Event 5 is not evaluated.

**Pin (4), the PARTIAL cancel answer.** It is reproduced with the real venue: `orderIds` = [NO leg, FILLED YES leg].
- The venue answers `accepted: false`, `outcome: "PARTIAL"`, `SIMULATED_VENUE_CANCEL_INCOMPLETE`, and `notCancelled` = ["already FILLED"].
- One NO leg is CANCELLED 1/5; the other is still PARTIALLY_FILLED.
- The loop halts at that answer, with `cancelsRejected` 1.
- The working NO leg keeps its entries: reservations open 1 of 4.

## files_changed

`git diff --stat 9019d37 31504b2`: 2 files, +420/−14.

- `apps/trader/src/loop.ts`:
  - `#submitPlan` now calls `#absorbVenueAnswer`, a new method holding the moved answer-handling branches, then `#judgeBasketWatches(input.instant)`.
  - The `#watchBasket` docstring (judgement points) and the harvest-judgement comment (backstop) are updated.
- `apps/trader/src/loop-refused-plan.test.ts`:
  - Header item 4e.
  - A `DeliveryScript` type and an `onDelivery` option on the strategy double and on `assemble()`. The double's `onFill`/`onOrderUpdate` still hold when no script is given.
  - The `MovesBetweenCallsVenue` scripted double.
  - The helpers `followOnBuy`, `MARKET_CANCEL`, `planKinds`, `callbacks` and `T_EVENT_4`.
  - A new describe "SIM1-R3-1 …" with 6 tests.
  - The title of r2's GTC pin, and one comment in it, now say where the halt is raised since r3: at the cancel's answer, still before the harvest's deliveries. Its assertions are unchanged.

## tests_run

The gates ran on the working tree that was then committed with no further edit as `31504b2`. Non-vacuity and the mutants were re-run after the commit, on `31504b2` itself. Every pnpm command was prefixed with `pnpm_config_verify_deps_before_run=false`. Logs are in `scratchpad/sim-1/r3/logs/` (`final-*.log` are the final-tree runs).

- `pnpm run typecheck`: exit 0, with 0 `error TS`.
  - An earlier run failed on TS4111 (an index-signature property access in the new test). I fixed it with bracket access before the final run.
- `pnpm run lint`: exit 0.
- `pnpm run check:deps`: exit 0 (PASS line).
- `pnpm run test`: exit 0, **341 files / 7390 tests**. r2 was 341 / 7384, and base `6cbecc8` was 339 / 7315. This round adds 6 tests.
- `pnpm run test:e2e`: exit 0, **7 files / 157 tests**.
- `pnpm run test:replay`: exit 0, **3 files / 17 tests**, run twice.
- Determinism, twice each, both green:
  - `test/unit/simulation/{determinism,golden-replay,backtest-static-bracket-replay}.test.ts`: 3 files / 25 tests.
  - `test/e2e/determinism-golden.test.ts` (config `test/e2e/vitest.config.ts`): 1 file / 5 tests.
- Goldens:
  - `git diff 9019d37 31504b2 -- test/` is empty.
  - `scratchpad/sim-1/goldens/prove-dir.mjs WORKTREE` reports GOLDEN DIRECTORY PROOF PASSED:
    - the 4 data files equal `6cbecc8` plus only their O8/O9 substitutions;
    - the 9 other files are byte-identical;
    - no file was added or removed.
- `pnpm --filter @polymarket-bot/trader test:integration`: **NOT MET, exit 1, because Docker is unavailable.** `timeout 20 docker info` answers "The command 'docker' could not be found in this WSL 2 distro".
  - 10 files / 112 tests pass, and 17 are skipped.
  - The 4 testcontainer files (`durable-pnl-snapshot-postgres`, `durable-trader-first-fill-postgres`, `trader-health-endpoint-postgres`, `univ-4-gateway-opens-trader-redis`) fail at "Could not find a working container runtime strategy", before any test body runs.
- `pnpm --filter @polymarket-bot/backtest-cli test`: the package has no `test` script, and `packages/simulation` has no separate script. Both suites run inside the root `pnpm run test`.
- **Non-vacuity** (`scratchpad/sim-1/r3/nonvac3.sh`, re-run on the committed tree):
  - I restored `9019d37`'s `loop.ts`. Its sha256 `846470fd…` equals the `9019d37` blob.
  - Files run: `loop-refused-plan`, `basket-execution`, `loop-order-lifecycle`, `halt`. Result: **4 failed / 55 passed of 59.** The failing tests are exactly pins (1)–(4), each on "expected ['BASKET','CANCEL','POSITION'] to deeply equal ['BASKET','CANCEL']". The backstop pin and the control pass at base, as intended.
  - `loop.ts` was restored, and `sha256sum -c` reports OK.
  - Two scratch variants isolate the other assertion layers at base (`logs/nonvac-variant*.log`). Each was a scratch test file, deleted afterwards, with `loop.ts` restored via `git checkout HEAD`.
    - Variant 1, without the plan-kind and callback assertions: all 4 fail on the venue's order list (a fifth order exists).
    - Variant 2, also without the order-list assertion: all 4 fail on "expected [] to have a length of 1 but got +0". So the halt assertion itself fails at base.
  - After the probes, `git status` is clean, and the `loop.ts` sha256 `ade7836b…` equals the HEAD blob.
- **Mutation probes** (`scratchpad/sim-1/r3/mutants3.py`, re-run on the committed tree). Each mutant was applied, `loop-refused-plan` + `basket-execution` were run, then the file was restored and its sha256 checked. Every mutant was killed:

| Mutant | Result | Pins that fail |
|---|---|---|
| R3-M1: no judgement after the venue answer | 4 failed | (1)–(4) |
| R3-M2: judged only after an ACCEPTED answer | 1 failed | (4), the PARTIAL cancel |
| R3-M3: judged only after a placement answer | 4 failed | (1)–(4) |
| R3-M4: harvest backstop removed | 1 failed | (5), the backstop pin |

- **New tests.** All six are in `apps/trader/src/loop-refused-plan.test.ts`, describe "SIM1-R3-1 — a basket a DELIVERY callback leaves short halts at the venue's answer, before any other intent or callback executes":
  - "onFill: the first fill delivery cancels …"
  - "onOrderUpdate: the first order view's evaluation cancels …"
  - "ONE decision [CANCEL, POSITION]: …"
  - "a PARTIAL cancel answer (…) is judged too: …"
  - "the harvest's BACKSTOP: a venue whose order state moves BETWEEN the loop's calls …"
  - "the control: a COMPLETE basket …"

## assumptions

- The venue's order state changes only inside `observe()`, `observeTrade()` and `submit()` (and the venue's own `cancel()`/`submitAll()`, which the loop never calls). I checked this by reading `packages/simulation/src/venue.ts`:
  - `#sweep` runs only from `observe`, `observeTrade` and `#cancelSync`;
  - the placement and cancel state changes run inside `submit`.
  - The loop's only `venue.submit` call is in `#submitPlan`.
  - For a live adapter whose state moves between calls, the harvest backstop is the guard. It is pinned by (5).
- A halt raised mid-decision is enforced for the decision's later intents by the existing risk run-state check (`runStatePermitsIntent: !anyHalt`, §9.8 check 1). I did not add a second loop-level gate: that would redesign the intent path, and CANCELs must keep passing (§6 invariant 13). Pin (3) shows the POSITION being refused `RISK_RUN_STATE_BLOCKS`.
- A test-only premise, from the verifier's reproduction: the strategy double's scripted `onFill`/`onOrderUpdate` intents stand in for any strategy that reacts to a fill or an order view.

## deviations

- The answer handling moved into a new private method, `#absorbVenueAnswer`, with its body unchanged. This lets the single post-answer judgement follow every branch, rather than four copies before four `return`s. It is inside the R3 refusal/partial branch area of `apps/trader/src/loop.ts`, so it is not an adjacent redesign.
- I added one pin beyond the plan: the harvest backstop (5), through a scripted `TraderVenue` double. Without it, the harvest judgement would be an unpinned survivor (R3-M4) once every door is judged at its answer.
- I retitled r2's GTC pin to say where the halt is now raised. Its assertions are unchanged and it still passes.
- No `packages/**`, golden, docs or configuration file changed in this round.

## known_risks

- The Docker-backed integration suites (4 files / 17 tests) have not been run in any round. CI or a Docker session must run them.
- Basket halting is still unreachable in production. `CoreLoop.#economicsFor` supplies fee/slippage estimates for POSITION intents only, so the real risk engine refuses every BASKET (`RISK_EDGE_INPUTS_MISSING`). The pins reach the branch through the same disclosed pass-through `vi.mock` seam as r0/r2. The verifier's reachability qualification stands.
- Once a basket halt is raised mid-decision, every later non-cancel intent of the process is refused until an operator releases the halt: `anyHalt` is process-wide. This is the existing halt semantics, and it fails closed.
- With a basket watched, `#judgeBasketWatches` now takes one `ordersSnapshot()` per venue answer as well. That is bounded by the submissions per event, and it happens only while a basket is watched.
- The backstop pin's double (`MovesBetweenCallsVenue`) models a live venue's asynchronous state change. No live adapter exists yet, so how such a venue really reports venue-side cancels is UNVERIFIED.

## follow_up

- Run `pnpm --filter @polymarket-bot/trader test:integration` with Docker, and the GitHub CI run.
- Carried over from r0–r2:
  - a `failurePolicy` consumer for BASKET partials;
  - `#economicsFor` for BASKET intents (basket reachability).
- Verifier residuals (not findings):
  - market-cancel budgeting charges up front (admission plus a per-success debit, as the dated venue report describes);
  - Tier-1 maker-band retention (SIM-2);
  - price-range validation of hand-built planned orders (needs its own ruling).
- SIM-2: keep a terminal order in `ordersSnapshot()` until the loop has seen it. TRDR-4 settlement and the basket watch both rely on this.
- Governance (docs are forbidden here): record that the trader judges a basket after every venue door (`observe`, `observeTrade`, every `submit` answer), with the harvest as a backstop.

## commit_sha

`31504b280d73ad5007db180114265d9bb9fb939b` on branch `sim-1`, parent `9019d3762f03b2161e9b7d4982f29ebbab9c077f` (not pushed, not amended).
