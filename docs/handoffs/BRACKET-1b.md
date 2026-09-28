# BRACKET-1b: two-bracket e2e evidence with a filled take-profit, a per-bracket reconciler, and RECON2-EVENTHOP

Branch `bracket-1b` on base `397d416`, merged into `main` as `7252150` (`--no-ff`) on 2026-09-28.

- **Authorization:** the user's ruling R1 (1a + 1b + 1c), recorded in the `BRACKET-1a` row. Authorized at the `BRACKET-1a` flip (`397d416`).
- **Design basis:** the scoping synthesis, workflow `wf_b7a8d34d-4f9` (its 1b sections).
- **Orchestrator calls:** `SIM2-E2E-MSG` and `N1` (the pin-the-ratio route) rode along.
- **Process:** the HARDENING LOOP (workflow `wf_5c045d63-bd6`):
  - an Opus implementer;
  - gates run outside any sandbox (Docker 29.1.2; the trader Testcontainers suite ran locally every round);
  - a scope gate proving `paper-e2e-run.json`, `packages/`, `apps/`, `test/integration/` and the other golden trees byte-identical, with `test:e2e` run twice;
  - verification by Codex gpt-6-astra.

| Commit | Content |
| --- | --- |
| `4257273` | r0 |
| `4d1baa9` | r1: `BR1B-M1`, `BR1B-M2` (MEDIUM) |
| `7d72dac` | r2: `BR1B-R2-M1` (MEDIUM) |
| `7252150` | the merge (tree identical to `7d72dac`) |

## Outcome
- **E1.** The e2e harness, capture, golden reader and determinism test take a `Scenario` (`support/scenario-contract.ts`); the default is the original scenario. `paper-e2e-run.json` is BYTE-IDENTICAL: determinism passes with no regeneration, and there is no format bump.
- **E2.** The scenario `test/e2e/support/scenarios/two-brackets.ts` has one config delta, `maximum_entries_per_market 2`. Its golden is `test/replay-golden/paper-e2e/two-brackets-run.json`, captured once.

  | Step | What happens | Time |
  | --- | --- | --- |
  | Bracket 1 entry | Enters 50 @ 0.34 in one ask level; the take-profit is placed from onFill | 09:00:02 |
  | Holding timeout | The take-profit is withdrawn and its CANCELED view arrives | 09:03:05 |
  | Protective reduce | `SB.PROTECTED_REDUCE` fills 50 @ 0.32 (TAKER) → `SB.EXIT_FILLED, SB.CLOSED` | 09:03:06 |
  | Re-arm | `SB.REARMED` | 09:03:40 |
  | Bracket 2 entry | Enters 50 @ 0.33; the take-profit is placed from onFill (`sourceEventId ""`) | 09:03:41 |
  | Take-profit fill | A public trade at 0.50 fills it as MAKER at fee 0 → `SB.EXIT_FILLED, SB.CLOSED` | 09:04:00 |
  | End | `SB.REFUSED_MAXIMUM_ENTRIES` | 09:04:10 |

  - There is no pause, no unattributed fill and no halt.
  - The economics were written by hand into the README and hashed BEFORE the scenario first ran. They matched the capture on 92 of 92 values.
- **E3.** The reconciler scopes by instanceId and splits each instance's decisions at the strategy's own `SB.REARMED`.
  - **Boundaries:** each boundary must follow an `SB.CLOSED`, sit in the run's fill order, and be flat by the reconciler's own average-cost fold. It is refused otherwise.
  - **Rows:** one `enter` and one intent per bracket; exits are attributed by provenance within the bracket. There are `bracket.<n>.*` rows, `bracket.<n>.pnl.realized`, and a cumulative `pnl.realized` check.
  - **Single-bracket runs** keep today's ids and bytes exactly.
  - **Pins:** the second-enter refusal pins are converted, and new negatives were added.
  - **After review:**
    - the fold uses each fill's RECORDED direction (`BR1B-M1`);
    - the PnL stream is held to the ledger one to one (`BR1B-M2`);
    - the stream is folded in its recorded order, and an out-of-order stream is refused (`BR1B-R2-M1`).
- **E4, `RECON2-EVENTHOP`.** A `""` chain is accepted exactly when its decision's `sourceEventId` is null, and then ends at the decision and its featureSnapshotRef (RECON-2's reading of §6 invariant 4). A `""` chain against a decision that names an event still breaks, on both hops. The zero-fee MAKER fill books exactly 2 ledger transactions (`fill-posting.ts`: a fee posting only when the fee is non-zero). The "three postings" pin is generalised accordingly.
- **E5.** The venue-sim2 retention census includes the new golden. The multiplier is restated as 5,000×, with its reason.
- **`SIM2-E2E-MSG`.** An evicted venue history is refused at capture as "EVICTED".
- **`N1`.** `health.accounting.pnlRecords` is exactly 2× the top-level array in both goldens (12/6 and 14/7), and the reason is pinned. The counter is not wrong.

## Economics (hand-derived, captured, independently re-derived by the reviewer)
| | Bracket 1 | Bracket 2 | Cumulative |
| --- | ---: | ---: | ---: |
| Entry cost | 17 | 16.5 | 33.5 |
| Exit proceeds | 16 | 25 | 41 |
| Realized PnL | −1 | 8.5 | 7.5 |
| Fees | 0.431 | 0.216 | 0.647 |
| Net | −1.431 | 8.284 | **6.853** |

Ledger transactions: 3 + 3 + 3 + 2 = 11.

## Reviews (Codex gpt-6-astra)
- **r1 of `4257273`: CHANGES REQUIRED, 2 MEDIUM.**
  - `BR1B-M1`: attribution overrode the recorded accounting direction, which allowed false flatness and false realized PnL.
  - `BR1B-M2`: extra or duplicate trade records reconciled silently.
- **r2 of `4d1baa9`: CHANGES REQUIRED, 1 MEDIUM.**
  - `BR1B-R2-M1`: the reconciler silently repaired PnL record ordering, and so certified a stream the engine rejects.
- **r3 of `7d72dac`: ACCEPT, no findings.**
  - All three earlier findings were fixed on their exact reproductions.
  - An independent Python `Decimal` derivation of the new golden ran 361 checks with 0 mismatches.
  - Byte-for-byte restoration of all 1,376 tracked files.

## Evidence
- **Gates at `7d72dac`, outside any sandbox:**
  - typecheck 0, lint 0, check:deps PASS;
  - unit 345 / 7529;
  - e2e 8 / 206, twice, with both paper-e2e goldens sha256-identical across the runs;
  - replay 3 / 17;
  - control-api integration 10 / 87;
  - trader integration 15 / 132 (Testcontainers).
- **Non-vacuity (r0):**
  - base `reconcile.ts` fails 22 tests, and the two-bracket capture throws on the second `enter`;
  - base `chain-walk.ts` fails 2 tests: the filled take-profit's chain breaks on the event and decision hops.
- **GitHub CI:** PR #11 run `36423914292`, green.

## Residuals (queued)
- **`BRACKET1B-RECON`.** Disclosed reconciler limits, each loud rather than silent where it matters:
  - FEE records are not individually tied to their fills (fee totals are compared through fills and snapshots);
  - the single-bracket path does not check the PnL stream's order (no single-bracket row reads the stream);
  - same-event fill ties keep the fill-id convention;
  - there is no per-bracket engine checkpoint in the artifact;
  - the two internal guards are unreachable and unpinned.
- `BRACKET1-TPRACE` is unreachable in this scenario by construction: each entry fills in one level.

## Not claimed
- §7 item 1 is NOT closed by this round. `BRACKET-1c` (a durable Postgres + Redis round trip) follows, and the MET verdict belongs to a fresh read-only closeout.
- All evidence is simulated.

## commit_sha
- Implementation tip: `7d72dac528149ed1a74baaf0b216d62a711c108b`.
- Merge: `7252150`.

# Appendix A — implementer handoff, r0 (verbatim)

# BRACKET-1b — implementation handoff, round 0

## plan (written BEFORE any edit; the pre-edit hand-back is waived by the packet)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-bracket-1b`, branch `bracket-1b`,
base `397d416` (clean). Docker answered `29.1.2`. Baseline `pnpm run test:e2e` 7 / 157, exit 0.

Prerequisites verified: AGENTS.md; `IMPLEMENTATION_STATUS.md` rows BRACKET-1b (authorized
2026-09-28, R1), BRACKET-1a (Complete), RISK2-R6, RECON2-EVENTHOP, SIM2-E2E-MSG, N1,
BRACKET1-TPRACE, BRACKET1-IDLESSVIEW; `docs/handoffs/BRACKET-1a.md`; the scoping report
(`scenario_plan`, `reconciler_changes`, `golden_impact`, `acceptance`, F7-F11, F16-F17); RECON-1/RECON-2
records; every e2e support module and test; venue-sim2 census; decide.ts / fill-posting.ts / loop.ts
(read-only).

Read-only findings that shape the plan (re-verified at 397d416):
- `loop.ts` `#harvestFills` books fills, delivers `onFill`, then `#deliverOrderViews` re-delivers every
  non-retired owned order's view on EVERY harvest; a PublicTradeObserved fills a resting order in
  `#applyEvent` (venue.observeTrade) BEFORE that event's onFeatures evaluation, and the fill is
  harvested after it.
- `fill-posting.ts:355` books a PLATFORM_FEE transaction and a FEE PnL record only when the fee is
  non-zero; PnL records are emitted per OWNER (ACTUAL_ACCOUNT + each claiming instance), and
  `health.accounting.pnlRecords` counts all of them (`loop.ts:2340`), while the artefact's
  `pnlRecords` is the instance's VIRTUAL_STRATEGY stream only (`loop.pnlRecords(INSTANCE_ID)`).
- `reconcile.ts` may import only `./artifact.js` and `@polymarket-bot/decimal` (independence pin).

E1 (pure refactor). A `Scenario` object `{name, idNamespace, clockStart, events(), traderConfig(),
constants, goldenPath}`; `scenario.ts` keeps its events/config/constants and exports
`PAPER_E2E_SCENARIO` built from them. `harness.ts` (`assemble`/`driveScenario` take an optional
scenario, default the existing one; `Run` carries it), `artifact.ts` (reads constants/events/
instance from `run.scenario`), `golden.ts` (`goldenBytes(scenario?)`/`writeGoldenBytes(bytes,
scenario?)`, `GOLDEN_PATH` kept), `determinism-golden.test.ts` (one describe per scenario). Every
existing caller keeps compiling unchanged. Proof: determinism-golden passes with no regeneration and
`git diff --quiet 397d416 -- test/replay-golden/paper-e2e/paper-e2e-run.json`.

E2. `test/e2e/support/scenarios/two-brackets.ts`: same identities, fee schedule, market, env; config
delta `reentry.maximum_entries_per_market 2` only. Eleven events (both entries fill in ONE ask level,
so each take-profit is placed once, from `onFill`, full size — no scale-in resize, BRACKET1-TPRACE
cannot be reached): refs 08:59:58/59, MarketOpened 09:00:00, YES book 09:00:01 (asks 0.34x60,
0.35x40), NO book 09:00:02 (enter 1), YES book 09:03:05 (holding timeout: withdraw TP1), YES book
09:03:06 (PROTECTED_REDUCE, fills 50 @ 0.32 -> CLOSED), YES book 09:03:40 (asks 0.33x60, 0.35x40;
REARMED), NO book 09:03:41 (enter 2), PublicTradeObserved YES 0.5 x 60 09:04:00 (TP2 MAKER fill ->
CLOSED), YES book 09:04:10 (REFUSED_MAXIMUM_ENTRIES). Hand-derive decisions/orders/fills/fees/PnL into
the golden README BEFORE the first capture. Capture once (`WP250_WRITE_GOLDEN=1 … -t` the two-bracket
case only), then run the suite without the variable twice. Stop and report on any strategy/trader
defect.

E3. `reconcile.ts`: split the scenario instance's decisions (scoped by instanceId, sorted by
evaluationSeq) at the strategy's own `SB.REARMED` decisions. Per boundary: the closing bracket must
hold an `SB.CLOSED` decision (else refused: REARMED with no preceding close); the boundary's source
event gives an ingest sequence; every fill of an earlier bracket must be consumed before it and every
later one at or after it; the reconciler's own average-cost fold over every fill before it must be
flat (else refused). Per bracket: exactly one `enter`, exactly one POSITION intent, at most one
order-placing intent (existing refusals, now per bracket); orders/fills attributed by provenance and
by the bracket of the emitting decision. ONE bracket => today's code path, ids, texts and row order,
byte-for-byte. Several => `bracket.<n>.`-qualified per-bracket rows (entry.*, fee.fill.*,
fee.total_model_vs_venue, exit.expected_net_edge, exit.cancelled_proceeds.*, plus a new
`bracket.<n>.pnl.realized` from the bracket's fills vs its §9.16 TRADE records resolved by id), then
the run-cumulative ledger.*/pnl.* rows unchanged plus `pnl.realized` (Σ per-bracket vs the last
snapshot). Convert the two second-enter pins; add negatives (two enters in one bracket, non-flat
boundary, misplaced boundary, multi-intent entry, REARMED without a close, REARMED first).

E4. `chain-walk.ts`: the event and decision hops accept `sourceEventId ""` exactly when the persisted
decision's `sourceEventId` is null (event hop then satisfied through that decision); negative pin
("" vs a non-null decision stays broken); convert `traceability-chain.test.ts` "every trace's source
event is recorded" and "three postings per fill" (fee posting exactly when the fee is non-zero).

E5. venue-sim2 census includes `two-brackets-run.json`; the orders/fills multiplier restated as a
named constant with its reason.

Ride-alongs. SIM2-E2E-MSG: `captureArtifact` refuses an evicted venue history by name ("EVICTED")
before the reconciler can misreport it as "never booked/produced"; a pin drives the scenario with a
tiny venue retention (harness option). N1: pin `health.accounting.pnlRecords = 2 × pnlRecords.length`
in both goldens with its reason (two owner streams per owned fill; the artefact carries the
instance's), and `pnlRecords.length = Σ fills (1 + [fee ≠ 0])`.

Non-vacuity at the end: restore 397d416's `reconcile.ts` / `chain-walk.ts` temporarily, name the
failing pins, show the capture throws at base's `entries.length > 1` refusal and base's walk breaks the
loop-originated take-profit chain; restore byte-identically (sha256 vs `git show HEAD:`).

---

## summary

BRACKET-1b is implemented and committed on `bracket-1b` as `4257273` (one commit on
`397d416`, not pushed). All evidence is SIMULATED (`SIMULATED_NOT_REAL_EVIDENCE`). No
soak, probe or live gate is claimed, and handoff §7 item 1 is NOT claimed closed
(ruling R1: `BRACKET-1c` and a fresh closeout follow). All gates exit 0.

**E1: the harness is parameterised.** `support/scenario-contract.ts` defines `Scenario`
(events, operator document, constants, fee snapshot, idNamespace, golden file).
- `scenario.ts` keeps its events, config and constants unchanged. It exports them as
  `PAPER_E2E_SCENARIO` and exports `recordedEventsOf`/`Recorded`.
- `harness.ts`, `artifact.ts`, `golden.ts` and `determinism-golden.test.ts` take a
  scenario and default to the original one.
- Proof: before any other change, `test:e2e` passed 7/157 with no regeneration, and
  `git diff --quiet 397d416 -- test/replay-golden/paper-e2e/paper-e2e-run.json` exits 0
  (also at `HEAD`). The sha256 is `e762b16a…` throughout.
- There is no `goldenFormatVersion` bump.

**E2: the two-bracket scenario and golden.**
- **Scenario:** `support/scenarios/two-brackets.ts`. The only config delta is
  `maximum_entries_per_market 2`; cooldown 30 is kept. It has its own idNamespace.
- **Run shape.** Eleven events; 19 decisions; 5 orders; 4 fills.
  1. Bracket 1 enters 50 @ 0.34 (one ask level), and its take-profit is placed from `onFill`.
  2. The holding timeout (183 s) withdraws the take-profit (`cancel`
     `[SB.HOLDING_TIMEOUT, SB.SAFETY_CANCEL]`), and its CANCELED view arrives.
  3. The next book's `reduce` `[SB.HOLDING_TIMEOUT, SB.EXIT_SIZED_TO_ALLOCATION,
     SB.PROTECTED_REDUCE]` fills 50 @ 0.32 as a taker, giving `[SB.EXIT_FILLED, SB.CLOSED]`.
  4. `SB.REARMED` follows at +34 s.
  5. Bracket 2 enters 50 @ 0.33. Its take-profit is placed from `onFill` (decision
     `sourceEventId null`, provenance `""`).
  6. A `PublicTradeObserved` 0.5 × 60 gives a MAKER fill 50 @ 0.5, fee `0`, and
     `[SB.EXIT_FILLED, SB.CLOSED]`.
  7. The run ends with `SB.REFUSED_MAXIMUM_ENTRIES`.
- **Clean run:** no pause, no unattributed fill, no halt; `unattributedActivity` 0; every
  PnL record is `VIRTUAL_STRATEGY`.
- **BRACKET1-TPRACE is unreachable:** each take-profit is placed once, at the whole allocation.
- **Hand derivation:** written into the golden README BEFORE the scenario ever ran.
- **Capture:** once, with the writer (`-t "two-brackets"`), giving sha256 `49326233…`. It
  matched the derivation on all 92 mechanically compared values.
- **No strategy or trader defect was found.**

**E3: the reconciler learns brackets.**
- **Brackets:** the scenario instance's decisions (scoped by `instanceId`, ordered by
  `evaluationSeq`) are split at the strategy's own `SB.REARMED`.
- **Every boundary is checked; anything else is refused by name.** A boundary must:
  - follow an `SB.CLOSED` after that bracket's entry;
  - be placed at its source event's `ingestSeq`, with earlier brackets' fills before it and
    later ones at or after it;
  - be flat by the module's own average-cost fold.
- **Per bracket:** exactly one `enter`, one POSITION intent and at most one order-placing
  intent. Orders are attributed by provenance to the bracket of the emitting decision.
  MAKER fees use `makerFeeRate`.
- **One bracket:** exactly today's rows, ids, texts and order. The existing golden's
  reconciliation is unchanged, and `projection-reconciliation`'s rebuild equals it.
- **Several brackets:**
  - `bracket.<n>.` entry, fee, exit-edge and withdrawn-exit rows;
  - `bracket.<n>.pnl.realized`: fills against the bracket's §9.16 TRADE records, resolved by id;
  - run-cumulative `ledger.*`/`pnl.*` under their own ids;
  - `pnl.realized`: Σ of the brackets against the last snapshot.
  The two-bracket table is 31 rows, all explained, residual 0.
- **Pins:**
  - Converted: the second-enter pins (R3b, R3c).
  - New negatives: two enters in one bracket; a multi-intent entry; a bracket with no
    enter; a non-flat boundary; a misplaced boundary, both ways; a boundary with no source
    event; `SB.REARMED` with no preceding close, and one as the first decision; the realized
    rows failing from each of their three sources.
  - Scope by `instanceId`: a SHADOW run now reconciles to the original table.

**E4: RECON2-EVENTHOP.**
- **The fix:** the chain walk's event and decision hops accept `""` exactly when the
  persisted decision's `sourceEventId` is `null`. The event hop is then satisfied through
  that decision.
- **What a loop-originated chain now means:** it ENDS AT THE DECISION AND ITS
  `featureSnapshotRef`, not at a recorded event (RECON-2's accepted reading of §6
  invariant 4). This is stated in the chain-walk header, the e2e README and the golden README.
- **Negative pins:** `""` against a decision that names an event stays broken on both
  hops, pinned in the negative suite (paper golden) and in `two-brackets.test.ts`.
- **Converted in `traceability-chain.test.ts`:**
  - "every trace's source event is recorded" becomes "anchored in a recorded event, or
    loop-originated per the rule";
  - "three postings per fill" becomes "a fee posting exactly when the fee is non-zero",
    citing `fill-posting.ts:355`.
- **The zero-fee MAKER fill** books exactly 2 transactions (TRADE_PRINCIPAL and
  OUTCOME_TOKEN_DELIVERY).

**E5: the census.** The venue-sim2 retention census includes `two-brackets-run.json` (5
orders, 4 fills). The multiplier is restated as `HISTORY_HEADROOM = 5_000`, with this reason:
- 10_000× met the new golden with zero margin;
- 5_000× agrees with the census's own `< 10` bound, since 5_000 × 9 = 45_000 ≤ 50_000.

**Ride-alongs.**
- **`SIM2-E2E-MSG`:** `captureArtifact` checks `SimulatedVenue.retention()` first and
  refuses an evicted history as "EVICTED", with counts. Base said "…which the venue never
  booked", shown by overlay. This is pinned via a new test-only harness option,
  `venueRetention`.
- **`N1`:** `health.accounting.pnlRecords` counts every record `postFill` returns, i.e. the
  ACTUAL-account stream plus the claiming instance's stream. The artefact's `pnlRecords` is
  the instance's stream only. So the counter is exactly 2 × the array (12/6 and 14/7), and
  array = Σ fills (1 + [fee ≠ 0]). This is pinned in both goldens. The counter is not wrong.

**Hand-derived economics** (matched by the capture):

| | Entry | Exit | Realized | Net of fees |
| --- | --- | --- | --- | --- |
| Bracket 1 | 50 @ 0.34 = 17, taker fee 0.21879 → 0.219 | reduction 50 @ 0.32 = 16, fee 0.21216 → 0.212 | −1 | −1.431 |
| Bracket 2 | 50 @ 0.33 = 16.5, fee 0.2155725 → 0.216 | take-profit 50 @ 0.5 = 25, MAKER fee 0 | 8.5 | 8.284 |

Cumulative: realized 7.5, fees 0.647, core net 6.853 (= the collateral line).
Snapshots (realized): 0 → −1 → −1 → 7.5.

## files_changed

- `test/e2e/support/scenario-contract.ts`: NEW, the `Scenario` shape (E1).
- `test/e2e/support/scenario.ts`: exports `Recorded`, `recordedEventsOf` and
  `PAPER_E2E_SCENARIO`. Events, config and constants are unchanged.
- `test/e2e/support/harness.ts`: scenario parameter, `Run.scenario`, and the optional
  `venueRetention`.
- `test/e2e/support/artifact.ts`: reads `run.scenario`; the evicted-history refusal
  (`SIM2-E2E-MSG`).
- `test/e2e/support/golden.ts`: `goldenPathOf` / `goldenBytes` / `writeGoldenBytes` per
  scenario (`GOLDEN_PATH` kept).
- `test/e2e/determinism-golden.test.ts`: the five claims looped over both scenarios.
- `test/e2e/support/scenarios/two-brackets.ts`: NEW, the two-bracket scenario (E2).
- `test/replay-golden/paper-e2e/two-brackets-run.json`: NEW golden, captured once.
- `test/replay-golden/paper-e2e/README.md`:
  - the two-bracket section (the hand derivation, then a capture-and-comparison record);
  - the `N1` section;
  - the per-scenario regeneration command;
  - provenance (both files SIMULATED);
  - the consumer list.
- `test/e2e/support/reconcile.ts`: E3 (bracket model, boundary checks, per-bracket and
  cumulative rows, the generalised average-cost fold), plus mechanism detail prose
  (not serialised).
- `test/e2e/support/chain-walk.ts`: E4 (`RECON2-EVENTHOP` hops) and the header.
- `test/e2e/two-brackets.test.ts`: NEW, 29 tests.
- `test/e2e/reconciliation-attribution.test.ts`: R3b/R3c CONVERTED; helpers
  `rearmDecision`, `withRearm`, `consistentSecondEntry`.
- `test/e2e/traceability-chain.test.ts`: two rows converted, plus one comment/assertion.
- `test/e2e/traceability-chain-negative.test.ts`: +1 hop mutation (`""` against a non-null
  decision).
- `test/e2e/README.md`: layout table, acceptance map, and a two-scenario / loop-originated
  chain section.
- `test/unit/simulation/venue-sim2.test.ts`: the retention census only (hunks inside the
  `DEFAULTS are far above…` test, base lines 464-489).

Not touched: `packages/**`, `apps/**`, `test/integration/**`, other `test/unit/**`,
`test/replay-golden/{backtest,order-book,simulation}/**`, `docs/**`, `db/**`, manifests,
lockfile, eslint/tsconfig, `.github/**`. This was verified with `git diff --name-only 397d416 HEAD`.

## tests_run

Every pnpm command used `pnpm_config_verify_deps_before_run=false`. Docker was 29.1.2.
Logs are under `…/scratchpad/bracket-1b/logs/`.

| Gate | Result | Base (397d416) |
| --- | --- | --- |
| `pnpm run typecheck` | exit 0 | exit 0 |
| `pnpm run lint` | exit 0 | exit 0 |
| `pnpm run check:deps` | exit 0, PASS (34 packages / 80 edges) | same |
| `pnpm run test` | exit 0, **345 files / 7529 tests** (the census test was edited in place) | 345 / 7529 |
| `pnpm run test:e2e`, twice (+1 on the commit, +1 sanity) | exit 0, **8 files / 192 tests** each time | 7 / 157 (measured at base: exit 0) |
| `pnpm run test:replay`, twice | exit 0, **3 / 17** both | 3 / 17 |
| `pnpm --filter @polymarket-bot/control-api test:integration` | exit 0, **10 / 87** | 10 / 87 |
| `pnpm --filter @polymarket-bot/trader test:integration` | exit 0, **15 / 132**. The Testcontainers files ran: durable-trader-first-fill-postgres (9), trader-health-endpoint-postgres (3), durable-pnl-snapshot-postgres (3), univ-4-gateway-opens-trader-redis (2) | 15 / 132 |

**New tests (35 e2e):**
- `determinism-golden.test.ts`, "deterministic golden output — two-brackets" (5): two fresh
  in-suite runs byte-identical; a run byte-identical to the committed golden; ends in one
  LF; falsifiable; parses back.
  - The original five are now titled "… — paper-e2e".
- `two-brackets.test.ts` (29):
  - **E2:**
    - the ONE configuration delta;
    - bracket 1 closed by a NON-cutoff protective reduction, its take-profit withdrawn first;
    - SB.REARMED after the 30 s cooldown, with bracket 2 entering well before the cutoffs;
    - bracket 2's take-profit placed FROM onFill and FILLED as a MAKER at fee 0;
    - the run ends REFUSED_MAXIMUM_ENTRIES with no pause, no unattributed fill, no halt, clean books;
    - BRACKET1-TPRACE unreachable.
  - **E3:**
    - every row explained, and the table rebuilt from the golden's bytes;
    - brackets delimited by SB.REARMED, flat at the boundary;
    - per-bracket entry and exit rows;
    - per-bracket realized PnL sums to the cumulative row / snapshot;
    - the realized rows can FAIL from each of three sources;
    - refusals: two enters in ONE bracket; a multi-intent entry; a bracket with no enter;
      a non-flat boundary (40 of 50); a misplaced boundary, both ways; a boundary with no
      source event; SB.REARMED with no preceding close / as first decision;
    - scope by instanceId (SHADOW).
  - **E4:**
    - every hop resolves over the run's bytes and the golden;
    - the take-profit chain ends at its decision and featureSnapshotRef;
    - NEGATIVE: `""` against a recorded-event decision stays broken on both hops;
    - fee posting iff fee ≠ 0, for paper-e2e and for two-brackets;
    - the zero-fee MAKER fill books exactly 2.
  - **N1:** paper-e2e 12 = 2 × 6; two-brackets 14 = 2 × 7.
  - **SIM2-E2E-MSG:** evicted orders refused as EVICTED with counts; evicted fills named,
    and the default evicts nothing.
- `traceability-chain-negative.test.ts` (1): hop "event" breaks when the chain says `""`
  but its persisted decision names a recorded event, breaking exactly `[event, decision]`.

**Converted in place (not deleted):**
- `reconciliation-attribution.test.ts`:
  - R3b "a second `enter` with its own filled chain: refused in ONE bracket, reconciled as
    bracket 2 after an SB.REARMED";
  - R3c "…refused, never a withdrawn take-profit — in one bracket or after an SB.REARMED".
- `traceability-chain.test.ts`:
  - "the chain is anchored in the RECORDED event, not in a clock";
  - "the two ends of the chain agree on the money";
  - an extra fee assertion in "the run trades a ROUND TRIP".
- `venue-sim2.test.ts`: "DEFAULTS are far above every fixture and golden…".

**Golden protocol evidence:**
- **(a) Order of work.** The hand derivation was written and hashed (README sha256
  `59d0337e…`, copy `logs/README.hand-derivation.md`) before any run of the scenario.
  Before the capture:
  - a first NON-capturing run (`probe/probes/first-run.probe.ts`) matched every decision,
    order, fill, fee, snapshot and counter;
  - a reconciliation probe (`probe/probes/recon.probe.ts`) matched all 31 rows, and showed
    the unfixed chain walk breaking chain 3 on the event and decision hops.
  Neither probe wrote a golden.
- **(b) The capture.** Done once: `WP250_WRITE_GOLDEN=1 vitest … determinism-golden.test.ts
  -t "two-brackets"`. The result was 1 deliberate failure, 4 passed and 5 skipped (the
  paper-e2e block did not run). `paper-e2e-run.json` is unchanged. The README hash was still
  `59d0337e…` at capture time; after the capture only a "Capture and comparison" subsection
  and the consumer list were added (diff against the saved copy: only the 2 consumer-list
  lines differ).
- **(c) The comparison.** `compare-hand.mjs` (scratch) checks the capture against the
  derivation: **92 checks, 0 mismatches**.
- **(d) Stability.** The suite then ran without the variable, twice (and again on the commit).

**Non-vacuity** (overlays from `397d416`). Each was restored and `sha256sum -c` was OK
against my saved copies: reconcile `e6aa1606…`, chain-walk `55de86eb…`, artifact.

| Overlay | Result | What failed, and why |
| --- | --- | --- |
| A: base `reconcile.ts` | **22 failed / 170 passed** | All 5 two-brackets determinism tests; E2 ×5 (the capture throws); E3 ×10 (every reconciler pin, including the SHADOW scope pin); E4 "every hop resolves over the run's bytes" (the capture throws); the converted R3b and R3c. The capture throws base's refusal verbatim: "the run holds 2 `enter` decisions (evaluationSeq 1, 11), and this table has ONE bracket's shape…". |
| B: base `chain-walk.ts` | **2 failed / 190 passed** | "every hop of every chain resolves…" and "the filled take-profit's chain ends at its decision…". Base reports "chain 3 hop event: sourceEventId  is absent from the recorded event list" and "chain 3 hop decision: … names source event none, not ". |
| C: both | **23 failed / 169 passed** | — |
| D: base `artifact.ts` (SIM2 pins only) | **2 failed** | Base's capture of an evicted run throws "a provenance record names order … which the venue never booked". |

The negative pins (`""` against a non-null decision) pass at base by design: base breaks
those chains too.

## assumptions

- **Bracket boundaries.**
  - An `SB.REARMED` decision always has a recorded source event in a trader run: it is
    decided in `planTick` (`onFeatures` / `onMarketClosing`), and the trader dispatches no
    `onTimer`. A null-sourced re-arm is REFUSED rather than guessed.
  - The boundary instant is its source event's `ingestSeq`. Earlier brackets' fills must be
    `< B` and later ones `≥ B`.
- **`SB.CLOSED` as "the close".** It is emitted on every `CLOSED` edge that ends a filled
  bracket (`EXIT_FILL_COMPLETE`, `POSITION_FLAT`). `MARKET_CLOSED` reports `SB.MARKET_CLOSED`,
  but no re-arm follows it.
- **Per-bracket realized PnL has two sides.** "Projected" is the bracket's fills folded by
  average cost. "Realized" is the bracket's §9.16 TRADE records, resolved by id (record.ref
  → the chain that posted it → fill → bracket). The ENGINE comparison is the cumulative
  `pnl.realized` against the last snapshot, because the artefact carries no per-bracket
  engine checkpoint (snapshots name no fill).
- **Scoping.** `instanceId` scoping applies to the one-bracket path too. An order whose
  provenance names another instance's decision is refused with a clause naming that
  instance. No real run produces one, and before, it would have been summed into this
  instance's rows.
- **The scenario's own idNamespace** (`wp-250-paper-e2e-two-brackets`) is not a
  configuration change. It is the harness's id seed, so the two goldens' minted ids are
  disjoint. Event ids reuse the original ordinal scheme.
- **The venue-sim2 census multiplier** is a census policy, not a safety bound. Lowering it
  with a stated reason is the "restate" the packet asked for.

## deviations

1. **The scenario does not reuse the original events 1-6** (the scoping's suggestion). Each
   bracket's entry fills in ONE ask level (0.34 × 60, then 0.33 × 60), so each take-profit
   is placed once, at the full allocation, from `onFill`. The reasons: no scale-in resize,
   so BRACKET1-TPRACE is unreachable; the fewest orders (5); and distinct per-bracket
   numbers. The original golden already covers the two-level ladder and the resize.
2. **The run ends on a 09:04:10 YES book, not on `MarketClosing`.** The reentry refusal is
   `planRearm`'s first check; a `MarketClosing` near 09:15 would need another fresh book.
3. **Two probe runs of the scenario came before the single capture** (disclosed above;
   neither wrote a golden).
4. **Census:** the multiplier went from 10_000 to 5_000 (`HISTORY_HEADROOM`), with the
   reason, even though 10_000 × 5 still held exactly.
5. **New rows and refusals, multi-bracket path only:**
   - rows `bracket.<n>.pnl.realized` and `pnl.realized`;
   - refusals for an unresolvable TRADE record, a TRADE record with no shares/price, and a
     re-arm with no recorded source event.
6. **The second-`enter` refusal wording changed** (converted pins). The one-bracket
   messages for every other refusal are unchanged.
7. **Harness:** a test-only `venueRetention` option (absent in every golden run).
8. **Prose:** the chain walk's event/decision hop detail now JSON-quotes the source event
   id (hop details are not in any golden). The `EXIT_BELOW_TAKE_PROFIT` and
   `RESTING_EXIT_CANCELLED_UNFILLED` detail prose is generalised (details are not
   serialised; names and notes are unchanged).
9. **Test titles:** the determinism titles gained a " — <scenario>" suffix.

## known_risks

- **A re-armed bracket that never enters is REFUSED.** For example, the instance re-arms
  and the market closes before a second trigger. This is a legitimate run shape, and the
  refusal ("holds no `enter` decision") follows the packet's "exactly one enter per bracket".
  It is loud, not silent, but a future scenario would need an empty-trailing-bracket rule.
- **An entry that never filled, followed by a re-entry** (`ENTRY_ORDER_TERMINAL_UNFILLED` →
  ARMED, with no `SB.REARMED`), is refused as two enters in one bracket. This is the same
  as base's whole-run refusal, now per bracket.
- **Per-bracket realized PnL is not checked against the engine per bracket.** Only the
  cumulative row compares with the engine. Both sides of `bracket.<n>.pnl.realized` are
  computed by the oracle from two different persisted sources (venue fills and the §9.16
  stream).
- **Ordering assumptions.** The decision ordering assumes one `runId` per instance
  (`evaluationSeq` restarts would interleave). Fills at the boundary event itself are
  treated as later brackets'.
- **Evidence of the order of work lives in scratch, not git.** The golden and its
  derivation landed in one commit, so a reviewer can only verify "derived before capture"
  from the scratch copy and hash (`logs/README.hand-derivation.md`, `59d0337e…`) and the
  log timestamps.
- **The `fills: 1` eviction pin** asserts only the capture refusal and its count. That run
  may also halt (the loop's cursor falls behind retention), which is not asserted.
- **Wording.** `EXIT_BELOW_TAKE_PROFIT` appears with amount `0` on the take-profit-closed
  bracket. The name reads oddly there, though the detail prose explains the zero case.
- **The two goldens share recorded event ids** (same ordinal scheme and gateway epoch) for
  different events. Each golden is closed-world, so the walk is unaffected.

## follow_up

- **Governance (orchestrator):**
  - on acceptance, close `RISK2-R6` (a take-profit FILLED in a recorded run), `RECON2-EVENTHOP`,
    `SIM2-E2E-MSG` and `N1` (ratio pinned, counter not wrong);
  - write the round record `docs/handoffs/BRACKET-1b.md` (`docs/**` was forbidden here).
- **§7 item 1:** `BRACKET-1c` (a durable Postgres/Redis round trip), then a fresh read-only
  closeout for the MET verdict. Not claimed here.
- **Possible future reconciler work:**
  - a rule for an empty trailing bracket (re-armed, never entered);
  - a per-bracket engine checkpoint (a fill id or bracket ordinal on PnL snapshots, which
    is a trader/`packages` change) if per-bracket engine comparison is wanted.
- **Still queued, untouched:** `BRACKET1-TPRACE` and `BRACKET1-IDLESSVIEW` (the next
  static-bracket round); a backtest mirror of the two-bracket scenario (H8 / `BACKTEST-2`
  territory; none was made).

## commit_sha

`4257273939c638b1325f37eecd7938da24b690c9` (short `4257273`). Branch `bracket-1b`, parent
`397d416`, one commit, not pushed. Working tree clean.

# Appendix B — implementer handoff, r1 (verbatim)

# BRACKET-1b — remediation handoff, round 1

## plan (written BEFORE any edit)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-bracket-1b`, branch `bracket-1b`,
HEAD `4257273` (clean). Inputs read: `codex-r1.out` (CHANGES REQUIRED: BR1B-M1, BR1B-M2, both
MEDIUM; no LOW; no scope violation), `gates-r1.txt` (all gates exit 0), `handoff-r0.md`.
Engine facts re-read (read-only): `packages/pnl/src/state.ts` `applyTrade` (BUY adds, SELL removes,
`PNL_OVERSELL`; `PNL_DUPLICATE_REF` over every record kind), `packages/ledger/src/fill-posting.ts`
(TRADE record `ref = tokenTransactionId`, `side = fill.side`; token movement is
`OUTCOME_TOKEN_RECEIPT` for BUY / `OUTCOME_TOKEN_DELIVERY` for SELL), `apps/trader/src/loop.ts:2845`
(`side: fill.action`), `packages/simulation/src/tier0.ts` (a fill carries its order's market, token,
side and action), `packages/execution-planner/src/leg.ts` (SELL_OPPOSITE needs opposite-token
inventory; a Static Bracket instance at a flat bracket start holds none).

Only `test/e2e/support/reconcile.ts`, `test/e2e/two-brackets.test.ts`,
`test/e2e/reconciliation-attribution.test.ts` (R3b fixture only) and, if prose needs it, the e2e /
golden READMEs change. No golden byte may move: every new check is either a refusal that the honest
runs never trip, or an extra unexplained reason on an existing row that is empty on honest runs.

BR1B-M1 (direction). Attribution stays by id. Added CROSS-CHECKS, refused by name:
- D1 (both paths): a fill contradicts its booked order on market, token, side or action.
- D2 (both paths): an order attributed to an ENTRY that does not BUY, or to an EXIT that does not
  SELL. The table's rows price the entry as a purchase and the exit as a sale; the complement leg
  cannot occur from a flat bracket start (leg.ts).
- D3 (multi-bracket realized rows): a TRADE record whose `side` is not its fill's `action`.
- D4 (same): the fill's token-movement transaction contradicts its direction (RECEIPT/BUY,
  DELIVERY/SELL).
- The fills fold reads `fill.action` and the record fold reads `record.side` (BUY opens, SELL
  closes, anything else refused), instead of taking `opens` from attribution.
Placement: after every existing check, so existing refusal messages still fire first.

BR1B-M2 (cardinality and lots), multi-bracket realized rows only (the single-bracket table reads no
record):
- S1: a `ref` repeated in the instance's stream is refused (the engine's `PNL_DUPLICATE_REF`).
- S2: a TRADE record must follow from its fill's TOKEN-MOVEMENT transaction: carried by the ledger
  section, eventType RECEIPT/DELIVERY, `fillId` = the chain's `ledgerFillId`; a principal or fee ref
  is refused. The existing orphan refusal wording is kept. A transaction named by two chains is
  refused.
- S3: every attributed fill has exactly one TRADE record; a missing one is refused.
- N2: the record fold's REMAINING lots (shares and basis, per token, mapped fill token -> record
  token, a mapping refused if not one-to-one) must equal the fills fold's; a disagreement is an
  unexplained reason on `bracket.<n>.pnl.realized` (row texts unchanged, so bytes unchanged).
- R3b's acceptance half books its synthetic second fill in the PnL stream (token-movement
  transaction + TRADE record); the unbooked synthetic is pinned as refused by S3.

Pins (each must FAIL at `4257273` and pass after): M1 exit-fill-BUYS (two-bracket and one-bracket,
fill alone and fill+order), record side contradiction, ledger token-movement direction contradiction;
M2 duplicate ref, extra record under the principal transaction, missing record (entry and exit),
entry record re-sized to 60 (realized agrees, lots do not), plus the engine's own answer for the
duplicate and extra-record cases via `foldPnlRecords` on a live run (test side only).
Non-vacuity: overlay `4257273`'s `reconcile.ts` (and the R3b fixture), run, name the failures,
restore byte-identically (sha256 vs `git show HEAD:`). Then every gate.

---

## summary

Remediation round 1 is committed as `4d1baa9` on `bracket-1b`: one commit on top of `4257273`, not
pushed, no amend or rebase. Both MEDIUM findings are fixed. The verifier reported no LOW finding
and no scope violation. No golden byte moved. All evidence is still SIMULATED, and handoff §7
item 1 is still NOT claimed closed.

| Finding | Status | Pins (each FAILS at `4257273` and passes at `4d1baa9`) |
| --- | --- | --- |
| BR1B-M1 (attribution overrode the recorded direction) | FIXED | `two-brackets.test.ts`, in "BRACKET-1b r1 — BR1B-M1: the recorded direction is cross-checked, never overridden by attribution": (1) "an EXIT fill recorded as a PURCHASE is refused — against its own order, then (order changed too) against its side"; (2) "the ONE-bracket table is held to the same rule (its exit recorded as a purchase left every row explained)"; (3) "a TRADE record whose side contradicts its fill is refused, and so is a token movement booked the other way" |
| BR1B-M2 (record cardinality and remaining lots unchecked) | FIXED | `two-brackets.test.ts`, in "BRACKET-1b r1 — BR1B-M2: the PnL stream books the fills ONE TO ONE, and leaves the fills' position": (4) "a ref the stream carries twice is refused — as packages/pnl itself refuses it (PNL_DUPLICATE_REF)"; (5) "a TRADE record under a fill's PRINCIPAL transaction is refused — packages/pnl would fold it into an open position"; (6) "a fill the stream does not book is refused — bracket 2's purchase, or its sale"; (7) "the stream's other one-to-one links refuse when broken: a transaction two chains name, one the ledger lacks, a token named two ways"; (8) "the POSITION is reconciled alongside realized PnL: a purchase booked at 60 shares realizes the same 8.5, keeps 10, and the row fails". Also the EXTENDED converted pin `reconciliation-attribution.test.ts` R3b |

**BR1B-M1: the fix.** Attribution (which bracket, which side) is still resolved by id and never
reads `action`. The two averaging folds now read the RECORDED direction, exactly as
`packages/pnl` `applyTrade` does: the fills fold reads `fill.action` (`foldFills`), and the
records fold reads `record.side` (`bracketRealizedRow`). BUY adds to the lot, SELL removes from
it, and anything else is refused (`opensBy`).

The recorded direction is then cross-checked against the attribution, and a contradiction is
refused by name. The first two checks are in `refuseContradictedDirection`, which runs in BOTH
the one-bracket and multi-bracket paths, after every id-level check and before the boundaries:
- **A fill that disagrees with its own booked order** on `marketId`, `tokenId`, `side` or
  `action`. `packages/simulation` `tier0.ts` copies all four from the order it fills.
- **An order whose action is not its side's:** the entry BUYS and every exit SELLS. The table
  prices the entry as a purchase and the exit as a sale. The complement leg (SELL_OPPOSITE)
  needs opposite-token inventory (`execution-planner` `leg.ts` `selectIncreaseLeg`), which a
  flat-started bracket does not hold.

The multi-bracket realized rows add two more:
- **A TRADE record whose `side` is not its fill's `action`** (`loop.ts:2845` `side: fill.action`
  → `fill-posting.ts` `side: fill.side`).
- **A token movement booked the other way:** a RECEIPT for a sale, or a DELIVERY for a purchase.

**BR1B-M2: the fix.** The multi-bracket realized rows hold the instance's PnL stream to the
ledger one to one (`tradeRecordsByBracket`). Each of the following is refused:
- **Any `ref` carried twice, of any kind.** This mirrors the engine's `PNL_DUPLICATE_REF`, whose
  refs set spans every record kind.
- **A ledger transaction named by two chains.**
- **A TRADE record that does not follow from its own fill's token movement.** That movement is
  the `OUTCOME_TOKEN_RECEIPT` / `OUTCOME_TOKEN_DELIVERY` transaction, carried by the ledger
  section, with `fillId` equal to the chain's `ledgerFillId` (`fill-posting.ts` `tradeRef =
  ids.tokenTransactionId`). A missing transaction, a `TRADE_PRINCIPAL` or `PLATFORM_FEE` ref, or
  another ledger fill's transaction is refused.
- **A fill with no TRADE record, or with two.**
- **A venue token that the stream names as two tokens**, or two venue tokens named as one.

In addition, the POSITION each fold leaves (shares and cost basis per token) must agree
(`lotDisagreements`). A disagreement is an extra unexplained reason on `bracket.<n>.pnl.realized`,
and that row's texts are unchanged, so an honest row serialises byte-identically.
- The duplicate reproduction is now refused.
- The distinct principal-ref reproduction is now refused.
- An entry record booked at 60 shares realizes the same 8.5 but leaves 10 shares at 3.3. The
  row now fails on the position.
- Two pins run the REAL engine (`foldPnlRecords`), test side only, on the live run's records.
  With the duplicate it refuses `PNL_DUPLICATE_REF`. With the extra principal-ref record it
  accepts and holds `[token:9001, 50, 16.5]` at realized 7.5, which is the divergence the
  verifier measured.

**R3b (converted pin, extended, not weakened).** Its synthetic second bracket was never booked
in the PnL stream, and at `4257273` its `bracket.2.pnl.realized` passed only because both
sides read 0. That is the M2 class.
- The unbooked shape is now pinned as REFUSED ("…(bracket 2) is booked by no §9.16 TRADE
  record").
- The acceptance half books the synthetic fill the way `packages/ledger` does
  (`bookedSecondEntry`): three re-keyed copies of the golden's first chain's transactions, plus
  a BUY TRADE record following from the token movement and a FEE record.
- It still asserts bracket 1 row for row, bracket 2's ten ids and explanations, and
  `POSITION_OPEN_AT_RUN_END`. It newly asserts that the realized row agrees on the position
  (projected 0, realized 0, no reasons).
- The ledger projection and snapshots are still not refolded, so the run-cumulative rows stay
  unexplained, as before.

**Goldens.**
- `paper-e2e-run.json`: sha256 `e762b16a…`. `git diff --quiet 397d416` exits 0.
- `two-brackets-run.json`: sha256 `49326233…`. `git diff --quiet 4257273 -- test/replay-golden/`
  exits 0.
- The determinism suite passes with no regeneration. No `goldenFormatVersion` change.

**Economics.** Unchanged from r0:

| | Realized | Fees | Net |
| --- | --- | --- | --- |
| Bracket 1 | −1 | 0.431 | −1.431 |
| Bracket 2 | 8.5 | 0.216 | 8.284 |
| Cumulative | 7.5 | 0.647 | 6.853 (core net) |

## files_changed

All paths are under `test/e2e/**`, which is allowed. `git diff --name-only 4257273 HEAD`:
- `test/e2e/support/reconcile.ts`:
  - the module header section "Attribution by id, DIRECTION by the record";
  - `exact(…, extraReasons = [])`;
  - `refuseContradictedDirection`, called from `attributeByProvenance`;
  - `opensBy`;
  - `foldFills` reads `action`;
  - `tradeRecordsByBracket` is rewritten, returning `{byBracket, recordTokenOf}`;
  - `lotDisagreements`;
  - `bracketRealizedRow` folds by `record.side` and reports lot disagreements;
  - docstrings updated where they said "the sign convention is the table's, not `action`".
- `test/e2e/two-brackets.test.ts`: helpers (`literally`, `chainOf`, `tradeRecordOf`,
  `fillPlacedBy`, `withTrade`, `withRecord`, `engineFold`) and two new describe blocks with 8
  tests. It now imports `@polymarket-bot/pnl` (`foldPnlRecords`, `type PnlRecord`), which is
  already on `safety-posture`'s permitted list for exactly this test-side use.
- `test/e2e/reconciliation-attribution.test.ts`: the new `bookedSecondEntry` helper, and the R3b
  pin extended as above.
- `test/e2e/README.md`: the `support/reconcile.ts` and `two-brackets.test.ts` table rows describe
  the r1 rule.

Not touched:
- `test/replay-golden/**` (neither golden nor its README). The per-bracket table in the golden
  README is part of the pre-capture hand derivation, and r1 adds no row.
- `packages/**`, `apps/**`, `test/integration/**`, `test/unit/**`, `docs/**`, `db/**`.
- Manifests, lockfile, eslint/tsconfig and `.github/**`.

## tests_run

Every pnpm command used `pnpm_config_verify_deps_before_run=false`. Docker answered `29.1.2`
before and after. Logs are in `…/scratchpad/bracket-1b/r1logs/`.

| Gate | Result | At `4257273` |
| --- | --- | --- |
| `pnpm run typecheck` (includes `tsc -p test/e2e/tsconfig.json`) | exit 0 | exit 0 |
| `pnpm run lint` | exit 0 | exit 0 |
| `pnpm run check:deps` | exit 0, PASS (34 packages / 80 edges) | same |
| `pnpm run test` | exit 0, **345 files / 7529 tests** | 345 / 7529 |
| `pnpm run test:e2e`, run twice, plus once on the committed tree | exit 0, **8 files / 200 tests** each time | 8 / 192 (re-measured at the start of this round: exit 0) |
| `pnpm run test:replay`, run twice | exit 0, **3 / 17** both | 3 / 17 |
| `pnpm --filter @polymarket-bot/control-api test:integration` | exit 0, **10 / 87** | 10 / 87 |
| `pnpm --filter @polymarket-bot/trader test:integration` (Docker) | exit 0, **15 / 132**. The four Postgres/Redis Testcontainers files ran: durable-pnl-snapshot-postgres (3), trader-health-endpoint-postgres (3), univ-4-gateway-opens-trader-redis (2), durable-trader-first-fill-postgres (9). | 15 / 132 |

After the e2e runs, `git status --porcelain` was empty and both goldens were unchanged.

**New tests (+8, all e2e, in `two-brackets.test.ts`)**: pins (1)-(8) named in the summary table.
**Extended in place (not deleted, not weakened):** `reconciliation-attribution.test.ts` R3b, "a
second `enter` with its own filled chain: refused in ONE bracket, reconciled as bracket 2 after an
SB.REARMED".

**Non-vacuity.** I overlaid `4257273`'s `test/e2e/support/reconcile.ts` under the new tests, ran
`pnpm run test:e2e`, then restored the file. The result was exit 1, **9 failed / 191 passed**:
all 8 new pins and the extended R3b. The restore was verified with `sha256sum -c` against the
saved copy: OK. The tree was later committed; `git status` is clean.

How each failure presented at base:
- **Silent at base:** the verifier's five reproductions (the reduction fill as BUY, alone and with
  its order, and the one-bracket twin; the record side set to BUY; the token movement recorded as
  a DELIVERY; the duplicate ref; the principal-ref record), plus the R3b unbooked shape. Each
  showed "expected [Function] to throw an error".
- **Row explained at base:** the 60-share position case. It showed
  `['8.5','8.5','0','0',true]` against the expected `false`.
- **Loud at base, but for the wrong reason.** Base threw its oversell refusal ("the TRADE record
  (ledger transaction …) … removes …") in two cases, and I pin the true reason:
  - the missing purchase record;
  - the transaction named by two chains.
  - The missing SALE record was an unexplained row at base, not silent. The pin runs the purchase
    case first, which is the one that failed there.

## assumptions

- **The one-bracket table takes the direction checks but not the stream checks.** It reads no
  §9.16 record: its PnL rows compare against the engine's persisted snapshot. So D1/D2 apply to
  both paths, while the PnL-stream checks (S1-S3, D3, D4, lots) apply where the records are
  read: the multi-bracket realized rows. Applying the stream checks to the one-bracket path
  would claim nothing new about any row. It would also force every RECON-1/RECON-2 synthetic
  (partial exits, interleaving), whose traces carry `ledgerTransactionIds: []`, to be rebuilt.
- **An instance owns every fill it traces, whole.** So its stream carries exactly ONE TRADE
  record per attributed fill. This is true for the harness (a single claimant). A fill split
  across several claims of the same instance does not occur here, and would be refused loudly.
- **The complement (SELL_OPPOSITE) entry cannot occur for this strategy from a flat start.** The
  planner needs free opposite-token inventory, and each bracket starts flat, which the boundary
  check proves. So "the entry buys, every exit sells" is the table's precondition, now enforced
  rather than assumed.
- **A TRADE record's `tokenAssetId` is the stream's own token name** (`token:9001`), not the
  venue's (`9001`). The lots are compared through a one-to-one mapping built from the record-fill
  pairs.

## deviations

1. **R3b's acceptance fixture changed.** It now books its synthetic fill in the PnL stream. This
   is a fixture change forced by the stricter rule; the pin's assertions are kept and extended.
   The old unbooked shape is pinned as refused.
2. **Refusal wording.** The message for a TRADE record with a null `tokenAssetId` now reads
   "carries no shares, no price or no token" (it was "no shares or no price"). Nothing pinned
   the old text.
3. **The fills fold's oversell label** is now "exit fill …" for a SELL and "entry fill …" for a
   BUY. A BUY never oversells, so only the SELL label can appear. The existing `PNL_OVERSELL` pin
   still passes.
4. **Two new pins drive the two-bracket scenario live** to fold its real records through
   `packages/pnl`, test side only. The oracle (`reconcile.ts`) still imports only `./artifact.js`
   and `@polymarket-bot/decimal`, and the independence pin passes.

## known_risks

- **The stream checks cover TRADE records, plus `ref` uniqueness over every kind.** FEE records
  are not otherwise tied to their fills (for example, an extra FEE record under a fresh ref). No
  reconciliation row reads a FEE record: fees come from the venue fills, and `pnl.fees_paid`
  compares them with the engine's snapshot. So no row certifies the FEE stream. It was left
  alone as outside the finding.
- **A multi-claimant fill would be refused.** If a future run lets two claims of ONE instance
  split a fill, the "exactly one TRADE record per fill" rule would refuse it. The refusal is loud
  and names the fill.
- **The lots comparison is per bracket.** Cross-bracket consistency rests on the boundary
  flatness check, which folds the fills. The records are not folded across a boundary.
- **The r0 risks carry over unchanged:** the empty trailing bracket is refused, there is no
  per-bracket engine checkpoint, and the order-of-work evidence lives in scratch.

## follow_up

- **Governance (orchestrator):** on ACCEPT, close as in r0: `RISK2-R6`, `RECON2-EVENTHOP`,
  `SIM2-E2E-MSG` and `N1`. Write `docs/handoffs/BRACKET-1b.md`, recording both r1 findings as
  fixed.
- **Optional, a later round:**
  - tie FEE records to their fills' `PLATFORM_FEE` transactions (exactly one iff fee ≠ 0) if
    any row ever reads them;
  - bring the one-bracket path onto the stream checks together with a rebuild of the RECON
    synthetics.
- **Unchanged:** §7 item 1 → `BRACKET-1c`, then a fresh read-only closeout. `BRACKET1-TPRACE` and
  `BRACKET1-IDLESSVIEW` remain queued.

## commit_sha

`4d1baa93a4b452dc975b2854c94f6375c03f3352` (short `4d1baa9`) on `bracket-1b`, parent `4257273`,
not pushed. Working tree clean.

# Appendix C — implementer handoff, r2 (verbatim)

# BRACKET-1b — remediation handoff, round 2

## plan (written BEFORE any edit)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-bracket-1b`, branch `bracket-1b`,
HEAD `4d1baa9` (clean). Docker answered `29.1.2`. Inputs read: `codex-r2.out` (CHANGES REQUIRED:
BR1B-R2-M1, MEDIUM; no LOW; no scope violation; both r1 findings re-checked FIXED), `gates-r2.txt`
(every gate exit 0), `handoff-r0.md`, `handoff-r1.md`.

Engine facts re-read (read-only):
- `packages/pnl/src/state.ts` `foldPnlRecords` folds the records in the order it is given them;
  `applyTrade` moves the lot (BUY adds, SELL removes, `PNL_OVERSELL`); `applyFee` only adds to
  `feesPaid`/`feesBySchedule`, never touching a lot, so FEE order changes no realized value and no
  position.
- `apps/trader/src/loop.ts` ~:2312-2360: per fill, the posting's transactions are adopted into the
  ledger, THEN its records join the instance's stream. So the stream's TRADE records are recorded
  in the ledger's booking order (`sequence`), and the harvest order is the venue's consumption order.
- `artifact.ts` keeps the loop's record order (`pnlRecords(instanceId)`), and each ledger
  transaction's `sequence`.
- Fill ids are `<orderId>/t0/<n>`, so `inConsumptionOrder`'s tie-break between two ORDERS at one
  event is a convention; the ledger `sequence` is the recorded booking order.

The defect (verified by reading `reconcile.ts` at `4d1baa9`): `bracketRealizedRow` sorts each
bracket's TRADE records into their fills' consumption order, and `tradeRecordsByBracket` partitions
the stream by bracket before any fold, so the records side never folds the stream the engine folds.

Fix, multi-bracket realized rows only (the one-bracket table reads no §9.16 record; its PnL rows
compare fills with the engine's persisted snapshots):
1. `refuseReorderedStream`: after every existing stream check (duplicate ref, chain links, token
   movement, direction, one record per fill), walk the instance's TRADE records IN RECORDED ORDER
   across the whole stream (no partition) and refuse, by name, any record that comes after one
   whose fill (a) the run consumed LATER (`atEventIngestSeq` smaller than its predecessor's) or
   (b) whose token movement the ledger booked EARLIER (`sequence` not greater than its
   predecessor's). The message names both records, their fills, brackets, ingestSeqs and
   sequences, and says when the boundary between two brackets is crossed.
2. The records side folds the WHOLE stream ONCE, in recorded order, never sorted and never
   partitioned (`foldRecordedStream`): each bracket's realized value is what its own records
   contribute to that fold, and its position is the position the fold holds after its last record
   (so a position a bracket's records leave open is carried into the next bracket, exactly as the
   engine carries it). Given step 1 and the proven boundaries, brackets are contiguous and
   ascending in the stream; this is asserted, not assumed.
3. Row ids and texts unchanged, so neither golden moves a byte; existing refusals keep firing
   first (the new check runs last in `tradeRecordsByBracket`).

Pins (each must FAIL at `4d1baa9` and pass after), in a new describe block in
`two-brackets.test.ts`:
- reproduction A (bracket 2's sale recorded before its purchase): refused; the engine's own fold of
  the live run's records, permuted the same way, refuses `PNL_OVERSELL` at record index 4;
- reproduction B (bracket 2's purchase recorded before bracket 1's exit): refused, naming the
  crossed boundary; the engine realizes −0.75 at the first sale (not −1), total 7.5;
- the ledger half: record order agrees with the venue's but the ledger's `sequence` of two token
  movements is swapped: refused;
- the carry: bracket 1's purchase booked at 60 leaves 10 shares open; bracket 2's row now also
  fails, with the engine's value for that stream (checked against `foldPnlRecords`), where
  `4d1baa9` folded bracket 2 from zero and explained it.
Plus a boundary pin (passes at both): FEE records moved in the stream reconcile unchanged, and
the engine agrees (FEE order moves nothing).
Non-vacuity: overlay `4d1baa9`'s `reconcile.ts`, run, name the failures, restore byte-identically
(sha256 vs `git show HEAD:`). Then every gate.

---

## summary

Remediation round 2 is committed as `7d72dac` on `bracket-1b`. It is one commit on top of
`4d1baa9`, not pushed, with no amend or rebase. The one finding (MEDIUM) is fixed. The verifier
reported no LOW finding, no gate failure and no scope violation. No golden byte moved. All
evidence is still SIMULATED, and handoff §7 item 1 is still NOT claimed closed.

| Finding | Status | Pins (each FAILS with `4d1baa9`'s `reconcile.ts` and passes at `7d72dac`) |
| --- | --- | --- |
| BR1B-R2-M1 (the reconciler re-sorted and split the PnL stream, so it certified streams the engine rejects or folds differently) | FIXED | In `two-brackets.test.ts`, describe "BRACKET-1b r2 — BR1B-R2-M1: the stream is folded in the order it was recorded, never re-sorted or split": (1) "reproduction A — bracket 2's SALE recorded before its PURCHASE is refused; packages/pnl refuses the same stream (PNL_OVERSELL at record index 4)"; (2) "reproduction B — bracket 2's PURCHASE recorded before bracket 1's exit is refused across the boundary; packages/pnl would realize −0.75 on that exit, not −1"; (3) "the LEDGER's order binds as well: the stream unchanged, but a ledger that booked bracket 2's purchase before bracket 1's exit, is refused"; (4) "a position one bracket's records leave open is CARRIED into the next, as the engine carries it: bracket 1's purchase booked at 60 fails bracket 1 AND bracket 2". In `reconciliation-attribution.test.ts` (R3b describe): (5) "(r2) at ONE event the ledger's order decides: bracket 1's two purchases recorded against it are refused". Boundary pin, which passes at both commits by design: (6) "FEE records are not ordered: moved to the front of the stream they reconcile unchanged, and packages/pnl folds them to the same state" |

**The defect, confirmed by reading `4d1baa9`.** There were two problems:
- `bracketRealizedRow` sorted each bracket's TRADE records with `inConsumptionOrder` before
  folding them.
- `tradeRecordsByBracket` split the stream into per-bracket lists, and each list was folded from
  zero.

`packages/pnl` `foldPnlRecords` instead folds the whole stream once, in the order given.
`artifact.ts` keeps the loop's order, so the artefact records it faithfully. The reconciler
therefore certified a stream the engine never folded.

**The fix (`test/e2e/support/reconcile.ts`, multi-bracket realized rows only).**

1. **`refuseReorderedStream`** runs last in `tradeRecordsByBracket`, after the duplicate-ref,
   chain-link, token-movement, direction, one-record-per-fill and token-mapping checks. Those
   checks therefore still refuse first, by their own names.
   - It walks the instance's TRADE records in RECORDED order across the whole stream, including
     across bracket boundaries.
   - Each record must follow its predecessor by BOTH of two recorded facts:
     - **The venue's:** its fill was consumed no earlier (`atEventIngestSeq` not smaller).
     - **The ledger's:** its token movement was booked later (`sequence` greater).
       `apps/trader/src/loop.ts` ~:2312-2360 adopts a fill's posting into the ledger and only
       then appends that posting's records to the stream, so the stream follows the ledger's
       order exactly. This also settles two fills consumed at ONE event. Fill ids are
       `<orderId>/t0/<n>`, so `inConsumptionOrder`'s tiebreak there is only a convention.
   - A disagreement is refused by name, never re-sorted. The message names both records, their
     fills, brackets and ledger transactions, the ingestSeqs and sequences that disagree, and
     "across the boundary between bracket m and bracket n" when a boundary is crossed.
   - FEE records are deliberately not ordered: `applyFee` only adds to `feesPaid`, so their
     position moves no realized value and no position. Pin (6) shows this, using the engine.
2. **`foldRecordedStream`** makes the records side ONE average-cost fold of the whole stream,
   in recorded order.
   - A bracket's share is the realized PnL its own records add to that fold, plus the position
     the fold holds after the bracket's last record.
   - So a position one bracket's records leave open is CARRIED into the next bracket's share,
     exactly as the engine carries it.
   - The brackets' records are contiguous and ascending. This follows from the order check plus
     the already-proven boundary placement, and is re-asserted: a stray record is refused.
3. **What is kept.**
   - `bracketRealizedRow` now takes that share. Its row ids and texts are unchanged, and the
     honest values are the same (bracket 1: −1 − 0 = −1; bracket 2: 7.5 − (−1) = 8.5). So
     neither golden moves a byte.
   - r1's direction, cardinality and remaining-position (`lotDisagreements`) checks are kept.

**The verifier's reproductions, now.**
- **A** (records 4 ↔ 6) is refused: "…records the TRADE record of fill …1d000…/t0m/10 (bracket 2,
  …) before the TRADE record of fill …16000…/t0/0 (bracket 2, …), but the run consumed fill …
  first (ingestSeq 9, before 10) and the ledger booked its token movement first (sequence 7, not
  after 10)…".
  - The engine, given the live run's records in the same order: `PNL_INPUT_INVALID` +
    `PNL_OVERSELL`, "fold refused at record index 4".
- **B** (records 2 ↔ 4) is refused "…across the boundary between bracket 1 and bracket 2, but
  the run consumed fill …f000…/t0/0 first (ingestSeq 7, before 9) and the ledger booked its token
  movement first (sequence 4, not after 7)".
  - The engine, on the live records in that order: after the first sale it holds `[token:9001,
    50, 16.75]` and has realized `−0.75`. Its total is `7.5`.

**Why the carried position matters (pin 4).** The case: bracket 1's purchase is booked at 60
shares.
- **Bracket 1:** it realizes −1, as the fills do, and keeps 10 shares at 3.4. The row fails on
  the position, as it did in r1.
- **Bracket 2, as the engine folds it:** 60 shares at 19.9, of which the sale removes
  16.58333333333333333333333333333333. It realizes 8.41666666666666666666666666666667 and keeps
  10 shares at 3.31666666666666666666666666666667. The row now fails too.
- **At `4d1baa9`**, bracket 2's records were folded from zero: 8.5, flat, and the row was
  explained.
- **The engine's own fold** of the live records with the same change agrees with every number
  above: total realized 7.41666666666666666666666666666667 = −1 + bracket 2's share.

**Goldens.**
- `paper-e2e-run.json`: sha256 `e762b16adc3920a1f5bbb7dce52b529f7cf2310e256eec80b84886a0b882cf41`.
  `git diff --quiet 397d416` exits 0.
- `two-brackets-run.json`: sha256
  `49326233359c75f6391e29fb664ca0eda90ba60f2810d23e564f74998693cfec`.
  `git diff --quiet 4d1baa9 -- test/replay-golden/` exits 0.
- The sha256 of both was unchanged across the two e2e runs and the run on the commit.
- No regeneration and no `goldenFormatVersion` change.

**Economics.** Unchanged from r0 (hand-derived, matched by the capture):

| | Realized | Fees | Net |
| --- | --- | --- | --- |
| Bracket 1 | −1 | 0.431 | −1.431 |
| Bracket 2 | 8.5 | 0.216 (MAKER exit fee 0) | 8.284 |
| Cumulative | 7.5 | 0.647 | 6.853 (core net) |

## files_changed

All four paths are under `test/e2e/**`, which is allowed. `git diff --name-only 4d1baa9 HEAD`:

- **`test/e2e/support/reconcile.ts`:**
  - the module header section "The stream in the ORDER it was recorded (`BRACKET-1b` r2)";
  - the `ArtifactLedgerTransaction` type import;
  - `BracketTrade` gains `bracket` and `movement`;
  - `BracketTrades.byBracket` is replaced by `inRecordedOrder`;
  - `tradeRecordsByBracket` builds the list in stream order and calls `refuseReorderedStream`
    last;
  - new: `refuseReorderedStream`, `StreamShare` and `foldRecordedStream`;
  - `bracketRealizedRow` takes a `StreamShare` (the sort and the per-bracket fold are removed);
  - `buildReconciliation` computes the stream fold once;
  - docstrings of `lotDisagreements` and `bracketRealizedRow` updated.
- **`test/e2e/two-brackets.test.ts`:**
  - helpers `engineState` (the engine's fold with its refusal messages and fees, test side only)
    and `swapped`;
  - the new describe block with pins (1)-(4) and (6).
- **`test/e2e/reconciliation-attribution.test.ts`:** pin (5), in the R3b describe, on R3b's
  booked fixture. No existing test was changed.
- **`test/e2e/README.md`:** the `support/reconcile.ts` and `two-brackets.test.ts` table rows
  describe the r2 rule.

Not touched:
- `test/replay-golden/**` (neither golden nor its README; the README's per-bracket values are
  unchanged);
- `packages/**`, `apps/**`, `test/integration/**`, `test/unit/**`, `docs/**`, `db/**`;
- manifests, lockfile, eslint/tsconfig and `.github/**`. Verified: `git diff --quiet 4d1baa9 --
  packages apps test/integration test/unit package.json pnpm-lock.yaml eslint.config.mjs docs db
  .github` exits 0.

## tests_run

Every pnpm command used `pnpm_config_verify_deps_before_run=false`. Docker answered `29.1.2` at
the start and before the trader integration gate. Logs are in
`…/scratchpad/bracket-1b/r2work/`. All gates ran on exactly the committed tree.

| Gate | Result | At `4d1baa9` (gates-r2.txt) |
| --- | --- | --- |
| `pnpm run typecheck` | exit 0 | exit 0 |
| `pnpm run lint` | exit 0 | exit 0 |
| `pnpm run check:deps` | exit 0, PASS | exit 0 |
| `pnpm run test` | exit 0, **345 files / 7529 tests** | 345 / 7529 |
| `pnpm run test:e2e`, twice (plus once more on the commit) | exit 0, **8 files / 206 tests** each time | 8 / 200 |
| `pnpm run test:replay`, twice | exit 0, **3 / 17** both | 3 / 17 |
| `pnpm --filter @polymarket-bot/control-api test:integration` | exit 0, **10 / 87** | 10 / 87 |
| `pnpm --filter @polymarket-bot/trader test:integration` (Docker) | exit 0, **15 / 132**. The Testcontainers files ran: durable-pnl-snapshot-postgres (3), trader-health-endpoint-postgres (3), univ-4-gateway-opens-trader-redis (2), durable-trader-first-fill-postgres (9). | 15 / 132 |

After the e2e runs, `git status --porcelain` was empty and both goldens' sha256 checked OK.

**New tests (+6, all e2e):** pins (1)-(6) named in the summary table. Pins (1)-(4) and (6) are in
`two-brackets.test.ts`; pin (5) is in `reconciliation-attribution.test.ts`. No test was deleted,
skipped or weakened, and no existing assertion changed.

**Non-vacuity.**
- **Method:** `4d1baa9`'s `test/e2e/support/reconcile.ts` (sha256 `7bb0a50c…`, checked equal to
  `git show 4d1baa9:…`) was overlaid under the new tests, and `pnpm run test:e2e` was run.
- **Result:** exit 1, **5 failed / 201 passed**. The failures are exactly pins (1)-(5):
  - (1), (2), (3) and (5) failed with "expected [Function] to throw an error": at base each
    reorder was silently re-sorted and reconciled.
  - (4) failed with bracket 2's row `['8.5', '8.5', '0', true]` (explained) against the
    expected `['8.5', '8.41666666666666666666666666666667',
    '-0.08333333333333333333333333333333', false]`.
  - Pin (6) passed at base, as a boundary pin should.
- **Restore:** the r2 file was restored from a saved copy, and `sha256sum -c` against its
  recorded hash (`f72c9e25…`, the pre-docstring-tweak r2 file) was OK. The only later change was
  a comment-only docstring clarification, made before every gate. The overlay log is
  `r2work/nonvac-overlay-4d1baa9.log`.

## assumptions

- **The one-bracket table stays outside the stream checks, as accepted in r1.**
  - Its PnL rows read the engine's own persisted snapshots, never the §9.16 records.
    `tradeRecordsByBracket` is the only reader of `pnlRecords` in `reconcile.ts`, and the
    one-bracket PnL rows name "the last persisted PnL snapshot's …" as their realized source.
  - So a reordered stream in a one-bracket artefact moves no row, and no row claims it.
  - Bringing the one-bracket path onto the stream checks would require rebuilding every
    RECON-1/RECON-2 synthetic (`ledgerTransactionIds: []`), as r1 noted.
- **The ledger `sequence` in the artefact is the store's append order** (`appended.sequence`,
  `artifact.ts` ~:484). It is compared as a number, and a non-number fails the "greater than"
  test and is refused.
- **The stream is recorded in ledger order because of the loop's code path** (`loop.ts`
  ~:2312-2360: `postFill` → `#held.adopt` → the records are pushed). This holds for every run
  this harness drives. A future loop that appended records before their posting would be
  refused loudly, not passed silently.
- **Across brackets there is no tie.** Earlier brackets' fills are consumed strictly before the
  boundary, and later ones at or after it (`refuseMisplacedBoundaries`). So contiguity follows
  from the order check, and `foldRecordedStream` re-asserts it.

## deviations

1. **The ledger half of the order check** (the `sequence` must increase) goes beyond the
   verifier's two reproductions. It follows its "fill/ledger consumption order" wording, and it
   is what makes the check exact at a one-event tie (pin 5). That pin refuses a reorder that is
   numerically neutral: two purchases commute under average cost. It is refused because it is
   not the stream the trader recorded.
2. **The records side now carries a position across a boundary** (pin 4). This is stricter than
   the finding's minimum. It follows the verifier's alternative ("independently fold the
   complete recorded stream and verify its boundaries"), taken together with the refusal.
3. **Wording.** `lotDisagreements`' message ("the bracket's TRADE records leave …") is unchanged.
   It now means the position the recorded-order fold holds after the bracket's last record,
   which includes anything carried in; this is documented in its docstring. Keeping the text
   keeps r1's pin (8) and the goldens byte-stable.

## known_risks

- **One-event ties.** Among fills consumed at ONE event, the fills side still orders by the
  fill-id convention (`inConsumptionOrder`), while the records side now follows the ledger. If
  a real run ever booked two same-event fills of different orders against that convention, and
  the order changed a number, the realized row would show a difference. That is loud, not
  silent. No run of either scenario has such a pair (the two-bracket run has one fill per
  event; the one-bracket run's same-event pair is one order's two levels, in id order).
- **The one-bracket path does not check the stream's order** (see assumptions). No one-bracket
  row reads the stream.
- **The FEE-record linkage limitation from r1 is unchanged.** FEE records are not tied to their
  fills; fee totals are compared through fills and snapshots. FEE order is deliberately
  unchecked, since the engine is indifferent to it (pin 6).
- **The internal guards** in `foldRecordedStream` (a stray record) and `buildReconciliation` (a
  bracket with no share) cannot be reached once `refuseReorderedStream` and the boundary checks
  pass. They are not separately pinned.
- **The r0/r1 risks carry over unchanged:**
  - an empty trailing bracket is refused;
  - there is no per-bracket engine checkpoint;
  - a multi-claimant fill would be refused;
  - the order-of-work evidence lives in scratch.

## follow_up

- **Governance (orchestrator):** on ACCEPT, close as in r0/r1: `RISK2-R6`, `RECON2-EVENTHOP`,
  `SIM2-E2E-MSG` and `N1`. Write `docs/handoffs/BRACKET-1b.md`, recording BR1B-M1, BR1B-M2 and
  BR1B-R2-M1 as fixed.
- **Optional, a later round:**
  - order same-event fills by the ledger's booking on the fills side too (it touches
    `foldFills`, which the one-bracket rows share; no golden has a mixed-order same-event
    pair);
  - bring the one-bracket path onto the stream checks together with a rebuild of the RECON
    synthetics;
  - tie FEE records to their `PLATFORM_FEE` transactions.
- **Unchanged:** §7 item 1 → `BRACKET-1c`, then a fresh read-only closeout. `BRACKET1-TPRACE` and
  `BRACKET1-IDLESSVIEW` remain queued.

## commit_sha

`7d72dac528149ed1a74baaf0b216d62a711c108b` (short `7d72dac`) on `bracket-1b`, parent `4d1baa9`,
not pushed. Working tree clean.
