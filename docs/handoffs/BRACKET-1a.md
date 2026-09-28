# BRACKET-1a: the protective reduce gets an order track (RISK-2 residual 5)

Branch `bracket-1a` on base `f034c0b`, merged into `main` as `11969f3` (`--no-ff`) on 2026-09-28.

- **Authorization:** the user accepted the proposed closeout order ("Suggested order/steps do sound good … feel free to start whenever you're ready"). The rulings below followed. Governance commit `f034c0b`.
- **Scoping:** read-only workflow `wf_b7a8d34d-4f9`: three lenses (strategy, trader loop and e2e, governance) plus a synthesis, REPRODUCED at the strategy and golden level. The same run drafted the H8 options.
- **User rulings (2026-09-28):**
  - **(R1)** §7 item 1 is pursued as three rounds: 1a, then 1b, then 1c.
  - **(R2)** An unanswered protective reduce becomes SUBMISSION_UNKNOWN. It is retired only after its intent's `validUntil`, and only when no view or fill ever named it. At most one re-plan per validity window.
  - **(R3)** A protective reduction is sticky.
  - **(H8)** Option A, with C's wording as the interim state.
- **Process:** the HARDENING LOOP (workflow `wf_990a7b9e-63e`).
  - An Opus implementer.
  - Gates run outside any sandbox, with Docker available: the trader Testcontainers suite ran locally in every round.
  - A scope gate: comment-only checks on three trader test files and `scenario.ts`, a caveat-only check on `health.ts`, and byte identity for the frozen goldens and fixture inputs.
  - Codex gpt-6-astra verification.

| Commit | Content |
| --- | --- |
| `dcba8ad` | r0 |
| `ecf7f60` | r1: `BR1-H1` (HIGH), `BR1-M1` (MEDIUM) |
| `8d3f6cb` | r2: `BR2-H1` (HIGH) |
| `11969f3` | the merge (tree identical to `8d3f6cb`) |

## Outcome
- **The track (D1).** `planProtectedReduce` records an EXIT track with `planTakeProfit`'s exact shape, for the stop, holding-timeout and cutoff causes. The reduce's fill folds through `applyExitFill` (EXIT_PLANNED/EXIT_WORKING --EXIT_FILL_COMPLETE--> CLOSED). The instance ends CLOSED instead of PAUSED.
  - `machine.ts` and `state.ts` are byte-identical to base.
  - There are still 63 instance edges, and the state schema is still v2.
  - There are two new move sites, `exitStillOwed` and `exitIntentExpired`, both in the MOVE-SITE census.
- **The role (D2).** `exitRole(track)` derives the role from the minted intent-id prefix. An unknown prefix is refused by name and halts; it is never guessed.
- **No re-emission and no self-cancel (D3).** While a reduce is live, the ladder holds with `SB.EXIT_ORDER_WORKING`: no intent and no cancel. `withdrawResting` withdraws only the entry and a take-profit.
- **Sticky reduce (D4, R3).** Take-profit maintenance never cancels a live reduce. A take-profit is compared by its remaining shares. A late entry fill walks the bracket back into the exit states, so the reduce's fill still folds.
- **Stale views (D5).** An id-less reduce is adopted or attributed only through an OPEN or PARTIALLY_FILLED view.
- **Fold before settle (D6).** Exit settlement, and now entry settlement too (`BR1-H1`), keeps the track while the reported fills exceed the folded fills.
- **R2 (D7).** SUBMISSION_UNKNOWN at `submission_unknown_after_ms`, under every final policy (`BR1-M1`). `SB.EXIT_INTENT_EXPIRED` retires the track only when `validUntil` is strictly past and no view or fill ever named it. The re-plan is gated by `positionAgrees`. README obligation 11 cites risk `engine.ts:238-248` and planner `build.ts:196-213`.
- **Codes (D8).** New: `SB.PROTECTED_REDUCE` (stop and timeout), `SB.EXIT_INTENT_EXPIRED`, `SB.EXIT_SUBMISSION_UNKNOWN`, `SB.EXIT_RECONCILED`. The vocabulary grows from 72 to 76 codes. The cutoff keeps `SB.FINAL_PROTECTED_REDUCE`.
- **Documentation and version (D9–D11).**
  - The disclosures are corrected, and the obsolete four-row table (`RISK2-R5`, item 7(i)) is removed.
  - The README states R2 and R3 explicitly.
  - `STATIC_BRACKET_VERSION` is now 1.1.0.
  - `RISK_SEAM_CAVEAT` quotes residual 5 as SUPERSEDED (BRACKET-1a).
  - The residual-5 pins are CONVERTED into closure assertions, not deleted.
  - `RECON2-README` rode along.

## Golden delta (regenerated once, from verified base bytes)
- **Paper golden `paper-e2e-run.json`:**
  - Only `decisions[9]` and `decisions[11]` changed.
  - Decision 9 went from `[UNATTRIBUTED_FILL, POSITION_MISMATCH, NO_BLIND_FLATTEN, PAUSED]` to `[EXIT_FILLED, CLOSED]`, and decision 11 from `[RESUMED, EXIT_CUTOFF, RESOLUTION_HOLD_DISALLOWED, POSITION_MISMATCH, NO_BLIND_FLATTEN, PAUSED]` to `[REFUSED_MAXIMUM_ENTRIES]`. Both dropped `expectedShares` / `heldShares` from their model outputs.
  - Every other section is structurally identical, and the 329 numeric values outside `decisions` are equal in value and order.
  - The orchestrator re-ran the key-path diff independently.
- **Backtest `expected-artifact.txt`:** only lines 28 and 30 changed, and only in their reason fields.
- **Untouched:** the fixture inputs, and the order-book and simulation goldens.

## Reviews (Codex gpt-6-astra)
- **r1 of `dcba8ad`: CHANGES REQUIRED.**
  - `BR1-H1` HIGH: a late entry fill could be discarded, and the tracked reduce then closed a bracket that still held shares. The entry-fill loss was pre-existing; the false CLOSED was new.
  - `BR1-M1` MEDIUM: two cutoff policies bypassed R2's silence transition and D3's working reason.
- **r2 of `ecf7f60`: CHANGES REQUIRED.**
  - `BR2-H1` HIGH: a stale-data incident during a late entry fill bypassed the exit-state walk-back, so after resume the reduce's fill was discarded.
- **r3 of `8d3f6cb`: no implementation defect.** Its only finding, `BR3-M1` (MEDIUM, "the required green GitHub CI result is unproven"), was the orchestrator's own PR step. The r3 remediator correctly made no commit; its handoff is Appendix D. PR #10 CI run `36407747957` answers it.
  - All three earlier findings were re-checked as FIXED, with mutation confirmation: restoring the r0 or r1 `decide.ts` fails the pins.
  - The reviewer's own permutation batteries passed: 56/56 required sequences and 120/120 independent permutations.
  - Non-vacuity: 54 of 56 new pins fail against base. A track-only (D1-alone) overlay fails every discriminator: P1b, P2a, P2d, P4a, P4c/P4d, P5a, stale adoption, and all nine R2 pins.
  - Byte-for-byte restoration of all 1,371 tracked files.

## Evidence
- **Verification gates at `8d3f6cb`, outside any sandbox:**
  - typecheck 0, lint 0, check:deps PASS (34 / 80);
  - unit 345 / 7529 (base 344 / 7473);
  - e2e 7 / 157;
  - replay 3 / 17;
  - control-api integration 10 / 87;
  - trader integration 15 / 132, including the Testcontainers files (Docker 29.1.2).
- **Static-bracket suite:** 14 files / 375 tests (base 13 / 319).
- **GitHub CI, PR #10 run `36407747957`:** all three jobs green.
- **Post-merge `main` CI:** see the ledger row.

## Residuals (queued; none is new behaviour)
- **`BRACKET1-TPRACE` (pre-existing, disclosed in the README).** The `(PARTIALLY_OPEN|OPEN, *_FILL)` family. Two cases:
  - A take-profit is still LIVE when a late entry fill resizes it, and the resize's cancel loses the race to a fill. That fill is refused with `SB.ILLEGAL_TRANSITION` and the instance pauses, fail-closed, with the fill unfolded. At base, the view-first order gave `UNATTRIBUTED_FILL` instead. It pauses either way.
  - A LIVE entry's fill arrives while the bracket is `OPEN`.

  It needs an edge or a ruling. One option: exit settlement does not move into `OPEN` while the entry is still live.
- **`BRACKET1-IDLESSVIEW`.** An id-less reduce whose FIRST view is terminal and partly filled is ignored by D5. Its fill then names it, but the track stays WORKING until a terminal view is re-delivered by id. This is unreachable under the trader's fills-before-views delivery (`loop.ts` `#harvestFills` before `#deliverOrderViews`). The fix would be to re-read `ctx.orders()` by id for a tracked exit whose view is terminal.
- **R2's composition obligation.** It relies on a booked order appearing in `ctx.orders()` before its intent's `validUntil`. That is true for the synchronous SimulatedVenue path; arbitrary asynchronous roots were not verified.
- **No exit escalation (R3).** A resting protective reduce is never re-priced.

## Not claimed
§7 item 1 is NOT closed by this round. `BRACKET-1b` (two-bracket e2e evidence and a filled take-profit, `RISK2-R6`) and `BRACKET-1c` (a durable round trip) follow, and the MET verdict belongs to a fresh read-only closeout. All evidence is simulated.

## commit_sha
- Implementation tip: `8d3f6cb3b86615efb8e6badd9cd298ace79f6a51`.
- Merge: `11969f3`.

# Appendix A — implementer handoff, r0 (verbatim)

# BRACKET-1a — implementation handoff, round 0

## plan (written BEFORE any edit; the pre-edit hand-back is waived by the packet)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-bracket-1a`, branch
`bracket-1a`, base `f034c0b` (clean). Docker answered `29.1.2`.

Prerequisites verified: the BRACKET-1a row (R1-R3, D1-D11) in
`IMPLEMENTATION_STATUS.md:228-268`; RISK-2 residual 5 / RISK2-R6 / RECON2-EVENTHOP /
RECON2-README / RISK-2 item 7 / BRACKET-1b / TRDR3-R1 rows; the scoping report and
its probe material; `docs/handoffs/RISK-2.md`; the spec (§6 inv 6/7, §9.6, §13);
WP-220 acceptance; the package sources and tests; the e2e/backtest golden tooling;
`RISK_SEAM_CAVEAT`. Golden decisions re-read at base: `decisions` carry no
`statePatch` and no `nextWakeupAt`, so only reason codes / model outputs / intents
of a decision can move.

Strategy design (all inside `packages/strategies/static-bracket/src`):

1. D2 `exitRole(track)` in `decide.ts`, beside `intentId`: maps the minted
   `sb-take-profit-` / `sb-protected-reduce-` prefix to TAKE_PROFIT /
   PROTECTED_REDUCE, refuses (Outcome `ok:false`) any other prefix or an ENTRY
   track. A guard at the entry of every role-reading evaluation (`planTick`,
   `planFill`, `planOrderUpdate`) HALTS, naming the id, on an EXIT track whose role
   is refused, so the helpers downstream only ever see a proved role. State schema
   stays v2; `state.ts` untouched.
2. D1 `planProtectedReduce` writes `exitOrder` (planTakeProfit's shape) inside its
   existing `protectedReduce` move site. No machine edge.
3. D3 a live reduce (PENDING / SUBMISSION_UNKNOWN / WORKING, and CANCEL_PENDING
   after an incident cancel) is recognised BEFORE `withdrawResting`: hold, no
   intent, no cancel. `withdrawResting` withdraws (and waits on) only the entry and
   a TAKE_PROFIT track.
4. D4 `planTakeProfit`: a live reduce -> hold `SB.EXIT_ORDER_WORKING`, never a
   cancel (R3). If the instance is PARTIALLY_OPEN/OPEN (a late entry fill moved it
   out of the exit states while its reduce is live) the hold moves it back with
   `EXIT_TRIGGER_MET` (an existing edge; a NEW move site, census updated) so the
   reduce's own fill still folds through `EXIT_PARTIAL_FILL`/`EXIT_FILL_COMPLETE`.
   TAKE_PROFIT tracks compare `requested - filled` with open.
5. D5 an id-less PROTECTED_REDUCE track is adopted / attributed only by an
   `OPEN` or `PARTIALLY_FILLED` view; TAKE_PROFIT adoption unchanged.
6. D6 `settleTerminalOrder(EXIT)` keeps the track and holds
   `SB.EXIT_ORDER_TERMINAL` + `SB.AWAITING_FILL_ALLOCATION` while
   `viewFilledShares > filledShares`; `planExit` returns that hold instead of
   running the ladder on it.
7. D7 / R2: in the live-reduce hold, PENDING silent for `submission_unknown_after_ms`
   -> `SILENCE_EXCEEDED` -> SUBMISSION_UNKNOWN, reported like the entry
   (`modelOutputs.submissionUnknown: true`). At the top of `planExit` (after
   adoption and settlement, before the ladder) a PROTECTED_REDUCE track that is
   PENDING/SUBMISSION_UNKNOWN, has `orderId null` and zero filled / view-filled
   (never named by a view or a fill) and whose `placedAtMs + order_validity_ms`
   is strictly in the past is retired with the new `SB.EXIT_INTENT_EXPIRED` via
   `EXIT_PLANNED --EXIT_ABANDONED--> OPEN` (new move site, census updated); the
   ladder then re-plans in the same evaluation, gated by `positionAgrees`.
8. D8 new codes `SB.PROTECTED_REDUCE` (stop / timeout reductions; the cutoff keeps
   `SB.FINAL_PROTECTED_REDUCE`), `SB.EXIT_INTENT_EXPIRED`,
   `SB.EXIT_SUBMISSION_UNKNOWN`, `SB.EXIT_RECONCILED` (a SUBMISSION_UNKNOWN exit
   reconciled by a view; it used to be labelled `SB.ENTRY_RECONCILED`).
   `SB.AWAITING_CANCEL_CONFIRMATION` emission untouched (S17a).
9. D9 decide.ts header + README (compounding section, obligation 9, the obsolete
   table, the new R2 obligation, the R3 policy). D10 version 1.1.0 + repo grep.

Tests: new unit file(s) under `test/unit/strategies/static-bracket/` pinning
P1b/P2a/P2d/P4a/P4c/P4d/P5a, both fold orders, R2 (SU, retire only after
validUntil and never when named, one re-plan per window), D2 prefixes, repeated
brackets (stop and timeout) with max entries 2, incident cancel + paused fold +
resume; machine-closure sweeps gain an exit-role dimension; MOVE-SITE census gains
the two new sites.

Outside the package (D11): `RISK_SEAM_CAVEAT` rewrite with a quoted
`SUPERSEDED (BRACKET-1a)` clause; residual-5 blocks CONVERTED in
`test/e2e/residuals-observed.test.ts` and the backtest replay test; both goldens
regenerated once from restored base bytes with the (a)-(e) evidence; prose in
`scenario.ts`, the two golden READMEs, three trader test comments;
`test/e2e/README.md` (RECON2-README).

Anything moving a golden byte beyond `decisions[9]`/`[11]` and artifact lines
28/30 stops the item and is reported.

---

## summary

BRACKET-1a is implemented and committed on `bracket-1a` (`dcba8ad`, one commit on
`f034c0b`). The Static Bracket protective reduction now has an EXIT order track, so an
instance survives its own exit: the paper e2e run and the backtest replay both end
CLOSED (`SB.EXIT_FILLED, SB.CLOSED` on the reduction's own `onFill`, then
`SB.REFUSED_MAXIMUM_ENTRIES`) instead of PAUSED. Beyond the track (D1) the round adds
the pieces the scoping proved a track alone lacks: role from the minted id prefix,
refused (halt) when unknown (D2); a live reduce is held, never re-emitted or
self-cancelled (D3); take-profit maintenance never cancels it and compares the TP's
remaining shares (D4/R3); an id-less reduce is named only by a LIVE view (D5); exit
settlement waits for the fold (D6); R2's SUBMISSION_UNKNOWN + expiry retirement with at
most one re-plan per validity window (D7); four new reason codes, stop/timeout
reductions report `SB.PROTECTED_REDUCE` (D8); disclosures (D9); version 1.1.0 (D10);
caveat rewritten, residual-5 pins converted, both goldens regenerated once, prose fixed
(D11). The instance machine is unchanged (63 edges; the census names two new move sites
that reuse existing edges). Golden delta is exactly the predicted one. All gates exit 0.
All evidence is SIMULATED_NOT_REAL_EVIDENCE; no soak, live or real-order evidence is
claimed. §7 checklist item 1 is NOT claimed closed (R1: 1b and 1c follow).

What changed where (decide.ts line numbers at `dcba8ad`):
- D1: `planProtectedReduce` (:2100) builds the track (:2184) and passes it in the existing
  `protectedReduce` move (:2198-2202). Fold via `applyExitFill` (:2801; flat at :2814;
  move :2839-2840; reasons :2844).
- D2: `EXIT_INTENT_KINDS`, `ExitRole`, `EXIT_ROLE_PREFIXES`, `exitRole` (:206-290, exported
  from `index.ts`); `refusedExitRole` guard at the top of `planTick`, `planFill`,
  `planOrderUpdate` (halt, naming the id).
- D3: `liveReduce` (:321; PENDING/SUBMISSION_UNKNOWN/WORKING/CANCEL_PENDING) checked
  first in `planProtectedReduce` (:2116) -> `holdForLiveReduce` (:2253);
  `withdrawResting` (:2383) filters PROTECTED_REDUCE out.
- D4/R3: `planTakeProfit` (:1848) holds on a live reduce (:1857), never overwrites an
  exit awaiting its fill (:1862), compares `requested - filled` (:1868ff).
  `holdForLiveReduce` walks a PARTIALLY_OPEN/OPEN bracket back with `EXIT_TRIGGER_MET`
  (new move site `reduceStillLive`, :2262) so the reduce's fill folds after a late entry
  fill.
- D5: `adoptOrder` (:1410, filter :1423) and `attributeOrder` (:2978, :2990) +
  `isLiveViewStatus` (:1572).
- D6: `settleTerminalOrder` EXIT branch (:1537) returns `awaitingFill`; `planExit`
  (:1716) returns that hold before the ladder.
- D7/R2: SU transition in `holdForLiveReduce`; `retireExpiredReduce` (:2342; new move
  site `exitIntentExpired`, :2354, `EXIT_PLANNED --EXIT_ABANDONED--> OPEN`), called in
  `planExit` after settlement and before the ladder.
- D8: `reasons.ts` — `SB.PROTECTED_REDUCE`, `SB.EXIT_INTENT_EXPIRED`,
  `SB.EXIT_SUBMISSION_UNKNOWN`, `SB.EXIT_RECONCILED` (documented); cutoff keeps
  `SB.FINAL_PROTECTED_REDUCE`; `SB.AWAITING_CANCEL_CONFIRMATION` emission untouched.

## files_changed

- `packages/strategies/static-bracket/src/decide.ts` — D1-D8 (+ header disclosures D9)
- `packages/strategies/static-bracket/src/reasons.ts` — D8 codes
- `packages/strategies/static-bracket/src/strategy.ts` — D10 `1.0.0 -> 1.1.0`
- `packages/strategies/static-bracket/src/index.ts` — exports `exitRole`, `EXIT_ROLE_PREFIXES`, `ExitRole`
- `packages/strategies/static-bracket/README.md` — D9 (compounding section, obsolete table removed, obligations 4/7/9 amended, obligation 11 added, R2/R3 policy section)
- `test/unit/strategies/static-bracket/bracket-1a-reduce-track.test.ts` — NEW, 39 pins
- `test/unit/strategies/static-bracket/machine-closure.test.ts` — exit-role sweep dimension (3240 -> 6480), census gains `reduceStillLive` + `exitIntentExpired`, one D6-affected fixture (see deviations)
- `test/unit/strategies/static-bracket/hostile-config.test.ts` — one added `not.toContain(REASONS.protectedReduce)` (keeps the unreadable-stop pin non-vacuous under D8)
- `apps/trader/src/health.ts` — `RISK_SEAM_CAVEAT` constant + its doc comment only
- `apps/trader/src/loop-order-lifecycle.test.ts`, `loop-long-run.test.ts`, `loop-folds.test.ts` — comments only (verified: every changed line is a comment line)
- `test/e2e/residuals-observed.test.ts` — header row + caveat pins + residual-5 block CONVERTED
- `test/e2e/support/scenario.ts` — prose only (verified: every changed line is a comment line)
- `test/e2e/README.md` — RECON2-README (docs only)
- `test/replay-golden/paper-e2e/paper-e2e-run.json` — regenerated once
- `test/replay-golden/paper-e2e/README.md` — new "BRACKET-1a regeneration" section
- `test/replay-golden/backtest/static-bracket/expected-artifact.txt` — captured once
- `test/replay-golden/backtest/static-bracket/README.md` — ordinal-7 row, residual-5 section, re-capture paragraph
- `test/unit/simulation/backtest-static-bracket-replay.test.ts` — header item 6 + residual-5 block only (hunks at base lines 31-34 and 212-260)

Not touched (verified by `git diff --name-only`): backtest fixture inputs, `test/replay-golden/{order-book,simulation}/**`, `test/e2e/support/{harness,artifact,golden,reconcile,chain-walk}.ts`, `docs/**`, `db/**`, `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs`, `tsconfig*`, `.github/**`, `state.ts`, `machine.ts`.

## tests_run

All with `pnpm_config_verify_deps_before_run=false`, Docker `29.1.2`, at the final
tree (source identical to `dcba8ad`; only README prose changed after the full gate run,
and the package suite / e2e / replay / lint / package typecheck were re-run on the
commit itself):

| Gate | Result | Base |
| --- | --- | --- |
| `pnpm run typecheck` | exit 0 | — |
| `pnpm run lint` | exit 0 (twice) | — |
| `pnpm run check:deps` | exit 0 (34 packages / 80 edges) | — |
| `pnpm run test` | exit 0, **345 files / 7512 tests** | 344 / 7473 |
| `pnpm run test:e2e` | exit 0, **7 / 157**, run twice (+1 on the commit) | 7 / 157 |
| `pnpm run test:replay` | exit 0, **3 / 17**, run twice (+1 on the commit) | 3 / 17 |
| `pnpm --filter @polymarket-bot/control-api test:integration` | exit 0, **10 / 87** | 10 / 87 |
| `pnpm --filter @polymarket-bot/trader test:integration` | exit 0, **15 / 132**; the Testcontainers files ran (durable-trader-first-fill-postgres 9 tests 11 s, trader-health-endpoint-postgres, durable-pnl-snapshot-postgres, univ-4-...-redis) | 15 / 132 |
| static-bracket suite alone (`vitest run --config test/vitest.config.ts test/unit/strategies/static-bracket`) | **14 files / 358 tests** (+ `pnpm --filter @polymarket-bot/strategy-static-bracket typecheck` exit 0) | 13 / 319 |

New tests (39, all in `test/unit/strategies/static-bracket/bracket-1a-reduce-track.test.ts`):
- D1: the stop / the holding timeout / the close cutoff / the stop on the COMPLEMENT leg: one reduction, and its track — PENDING, id-less, sized to the open allocation (4)
- D2: the two minted exit prefixes are exactly two, disjoint, and name one role each; every exit id the strategy actually MINTS maps to exactly one role; an unknown prefix, a near-miss and an ENTRY track are REFUSED by name, never guessed; an evaluation holding an exit track of unknown role HALTS, naming it, on every role-reading callback (4)
- D3: P1b consecutive ladder evaluations while PENDING re-emit nothing; P2a once WORKING — and partly filled — the ladder never cancels it; with a stop or a timeout too, a live reduction is held (3)
- fold both orders: fill before view (the golden's order) complete -> CLOSED with closedAtMs, then the golden's tail (d10 IDLE, d11 REFUSED_MAXIMUM_ENTRIES); fill before view, partial -> EXIT_WORKING then closes; view before fill (live view names it, terminal FILLED view waits for the fold, the fill closes); view before fill, never seen alive (4)
- R3/D4: P5a stop reduce partly filled then the stop clears — held, never cancelled or replaced; P4a TP partial fill no longer cancel-and-replace; a TP whose remainder no longer matches IS still cancelled first (discrimination); CANCEL_ONLY at the close leaves a live stop reduction working (4)
- D5: P2d the replaced TP's CANCELED view, redelivered, is not the reduction's — ends CLOSED; the ladder does not ADOPT a stale terminal view, it adopts the reduction's live one (2)
- D6: P4c view (20 of 50) outruns its fill — no pause, late fill folds by id, then the remainder; P4d lagging position view never names more than the folded remainder (2)
- R2: PENDING until the silence bound then SUBMISSION_UNKNOWN reported as the entry reports it (held up to and including validUntil); retired strictly AFTER validUntil and ONE re-plan; at most one reduction per validity window (emissions at 0, 30 500, 61 000, 91 500 ms over a 100 s loop); re-plan gated by positionAgrees; a track NAMED by a live view is never retired; a track NAMED by a fill is never retired; a SUBMISSION_UNKNOWN reduce found by a live view reconciles as an EXIT; a reduce rejected on arrival (terminal view, never alive) is retired once its intent expires; validity shorter than the silence bound retires straight from PENDING (9)
- repeated brackets through the REAL WP-170 runtime, max entries 2: a STOP / a HOLDING TIMEOUT: reduce -> EXIT_FILLED, CLOSED -> REFUSED_COOLDOWN -> REARMED -> a second entry (entriesExecuted 2) (2)
- stale data: incidentPlan cancels the WORKING reduction (CANCEL order-3), the cancel-race fill folds while PAUSED, resume closes the bracket; with a PENDING reduction stale data still cancels/pauses and emits no reduction (2)
- a late ENTRY fill after the reduction was placed: back to the exit states, nothing placed beside it, the reduce fill folds, then the grown remainder is reduced (1)
- D8: names each new code by its stable string; FINAL_PROTECTED_REDUCE marks the cutoff only (2)

Converted / extended pre-existing pins: `machine-closure.test.ts` (sweeps over both exit roles; census; the D6 fixture), `hostile-config.test.ts` (+1 negative), `residuals-observed.test.ts` (residual-5 block + caveat pins), `backtest-static-bracket-replay.test.ts` (residual-5 block).

### Golden-change protocol evidence

**(a) regenerated once from restored base bytes, re-run without the variable.**
- Paper: base sha256 `fb7ae430186ac982ff92b546d2cd46c2982e055273731ffd4213a926835549e0` confirmed equal to `git show HEAD:` before the single run of `WP250_WRITE_GOLDEN=1 vitest run --config test/e2e/vitest.config.ts test/e2e/determinism-golden.test.ts` (it rewrote and failed on purpose, 4 passed / 1 deliberate failure). New sha256 `e762b16adc3920a1f5bbb7dce52b529f7cf2310e256eec80b84886a0b882cf41`. `pnpm run test:e2e` then passed without the variable, twice (and once more on the commit).
- Backtest: base sha256 `d2fa41fba44cff6fc9d815444dbd8e79c447f855a8e4d4ce0a9070a696dbb0b3` confirmed equal to `git show HEAD:`; captured ONCE by a scratch probe (`.../scratchpad/bracket-1a/capture/capture.probe.ts`, outside the repo) calling `renderArtifact(await replayThroughShippedRoot({ withCore: true }))` twice, asserting byte-equality, writing once (9457 bytes). New sha256 `512e246dc8525fd18f5eb15c056824cc962e90f2c394f38d88d4953a2a578303`. `pnpm run test:replay` passed twice afterwards (and once on the commit).
- Both goldens were regenerated BEFORE the caveat rewrite and still match after it — the caveat moves no golden byte.

**(b) key-path structural diff (paper) and `diff` (backtest)** — scratch script `golden-proof.mjs`:
```
leaf paths: base 1333, new 1324; moved 16
  - $.decisions[9].modelOutputs.expectedShares = "50"
  - $.decisions[9].modelOutputs.heldShares = "0"
  ~ $.decisions[9].reasonCodes[0]: "SB.UNATTRIBUTED_FILL" -> "SB.EXIT_FILLED"
  ~ $.decisions[9].reasonCodes[1]: "SB.POSITION_MISMATCH" -> "SB.CLOSED"
  - $.decisions[9].reasonCodes[2] = "SB.NO_BLIND_FLATTEN"
  - $.decisions[9].reasonCodes[3] = "SB.PAUSED"
  - $.decisions[11].modelOutputs.expectedShares = "50"
  - $.decisions[11].modelOutputs.heldShares = "0"
  ~ $.decisions[11].reasonCodes[0]: "SB.RESUMED" -> "SB.REFUSED_MAXIMUM_ENTRIES"
  - $.decisions[11].reasonCodes[1..5] = EXIT_CUTOFF, RESOLUTION_HOLD_DISALLOWED, POSITION_MISMATCH, NO_BLIND_FLATTEN, PAUSED
  + $.decisions[9].modelOutputs{} = <empty object>
  + $.decisions[11].modelOutputs{} = <empty object>
top-level sections that moved: decisions
sections byte-identical: checkpointInstants, events, fills, goldenFormatVersion, health, ledgerProjection, ledgerTransactions, orderProvenance, orders, pnlRecords, pnlSnapshots, reconciliation, scenario, traces
decisions[] indices that moved: 9, 11   (decisions count 12 -> 12; decisionType hold -> hold; callback and evaluationSeq unchanged)
```
`git diff --stat`: 5 insertions, 18 deletions in `paper-e2e-run.json`.
Backtest `diff base new`: exit 1, exactly `28c28` (`reasons=SB.UNATTRIBUTED_FILL,SB.POSITION_MISMATCH,SB.NO_BLIND_FLATTEN,SB.PAUSED` -> `reasons=SB.EXIT_FILLED,SB.CLOSED`) and `30c30` (`reasons=SB.RESUMED,SB.EXIT_CUTOFF,SB.RESOLUTION_HOLD_DISALLOWED,SB.POSITION_MISMATCH,SB.NO_BLIND_FLATTEN,SB.PAUSED` -> `reasons=SB.REFUSED_MAXIMUM_ENTRIES`); every other byte of each line (instance, run, callback, type, intents, snapshot, sourceEvent) is equal; 48 lines both.

**(c) numeric multiset**: every number and every decimal-looking string outside `decisions`: base 329, new 329, multisets EQUAL. Inside `decisions`: 33 -> 29, removed exactly `"0","0","50","50"` (the two dropped `modelOutputs` pairs), none added.

**(d) hand derivation (decide.ts at `dcba8ad`).**
- d8 unchanged: at 09:14:49 (11 s to close, <= the 20 s exit cutoff) `planExit` (:1716) has no exit track (the TP was settled and cleared at d7), so settlement (:1736) and retirement (:1747) are no-ops and the cutoff branch (:1773) calls `planFinalPolicy` -> `planProtectedReduce(..., REASONS.finalProtectedReduce)`; no live reduce, nothing to withdraw, `positionAgrees` 50 == 50, so the intent is unchanged (same id `sb-protected-reduce-2-…`, `-50`, floor 0.26) and so are the reasons; the only new output is the track in the state patch, which the golden does not carry.
- d9 `onFill` SELL 50 @ 0.32, `order-3`: `planFill` (:2606) — the exit track is the reduce's, `orderId null`, side SELL/outcome YES, so `isExitFill` (:2625-2628) matches it by leg and side -> `applyExitFill` (:2801): exited 0 + 50 = allocation 50, `flat` (:2814), `exitOrder: null`, `closedAtMs` = now (:2825-2827); `move(EXIT_PLANNED, "EXIT_FILL_COMPLETE")` (:2839-2840) -> CLOSED; returns `[SB.EXIT_FILLED, SB.CLOSED]` (:2844) with `modelOutputs` null, which the artefact renders `{}`.
- d10 `onOrderUpdate` FILLED view of `order-3`: both tracks are null, `attributeOrder` returns null -> `SB.IDLE` (unchanged).
- d11 `onMarketClosing(10)`: `planTick` — not PAUSED, time to close 10 s > 0 so the `MARKET_CLOSED` branch (:695) does not fire; `case "CLOSED"` -> `planRearm` (:2545), whose FIRST check is `entriesExecuted (1) >= maximum_entries_per_market (1)` (:2552-2553) -> `[SB.REFUSED_MAXIMUM_ENTRIES]`, `modelOutputs` null -> `{}`.
- d2-d7 re-derived unchanged: d3 is the TP PENDING with remainder 30-0 = 30 != 50 -> not WORKING -> `[…, SB.EXIT_ORDER_WORKING, SB.AWAITING_CANCEL_CONFIRMATION]` (S17a untouched); d6 remainder 30 != 50, TP WORKING -> cancel, reason text still "allocation changed from 30 to 50" (remainder 30 - 0 = 30); d7 the CANCELED view reports 0 filled = 0 folded, so D6 does not wait and the track clears.

**(e) the caveat is in neither golden**: `grep -c` for `riskSeamCaveat`, `RISK_SEAM_CAVEAT`, `SUPERSEDED`, `WP-220 accepted residual`, `never from a tag`, `does not weaken risk policy`, `THE CAVEAT NOW` = 0 in `paper-e2e-run.json` and 0 in `expected-artifact.txt`; `test/e2e/support/artifact.ts:25` documents the exclusion; and both goldens, captured before the caveat rewrite, still pass after it.

### Non-vacuity (all overlays restored byte-identically; `sha256sum -c` OK for all 12 src files and `health.ts`; `git status` clean before commit)

- **Base sources** (`f034c0b`'s `packages/strategies/static-bracket/src/**` overlaid): static-bracket suite 40 failed / 318 passed of 358 — 37 of the 39 new pins fail (all but "a take-profit whose remainder no longer matches IS still cancelled first" and "with a PENDING reduction, stale data still cancels and pauses and emits no reduction", which are the discrimination / safety pins and hold at base by design) plus machine-closure's two census pins and its D6 fixture test. `test:e2e` 2 failed (determinism golden; converted residual-5 row). `test:replay` 2 failed (backtest byte compare; converted residual-5 row).
- **Base caveat** (`git show HEAD:apps/trader/src/health.ts` overlaid): the caveat pin fails — `expected 'SUPERSEDED (RISK-2, 133eac1): …' to contain 'SUPERSEDED (BRACKET-1a)'`; the base text contains `THE CAVEAT NOW` (count 1), so the new `not.toMatch(/THE CAVEAT NOW/)` bites too.
- **Track-only variant A** (base + only the one-line track in `planProtectedReduce`, `.../scratchpad/bracket-1a/variantA/`): 36 failed / 322 passed. FAIL: every D3 pin (P1b, P2a, stop/timeout hold), P5a, P4a, CANCEL_ONLY, both D5 pins (P2d, stale adoption), both D6 pins (P4c, P4d), all nine R2 pins, both repeated-bracket pins, the late-entry-fill pin, both view-before-fill fold pins, the D2/D8 pins (missing symbols), and the stop/timeout/complement D1 cases (D8's code). PASS under variant A (as expected — variant A does fix these): the cutoff D1 case, fill-before-view complete and partial (the golden's order), the TP-grew discrimination pin, and both stale-data pins. So the self-cancel (S6), stale-view (S8), fold-before-settle (S14) and R2 pins all distinguish a track-only fix.

## assumptions

- "Named" (R2) means ATTRIBUTED to the track: a live view or a fill gave it a venue order id, or it carries confirmed / view-reported fills. A terminal view that D5 refuses to attribute to an id-less reduce does not name it. `neverNamed` checks `orderId === null && filledShares == 0 && viewFilledShares == 0`.
- "validUntil has passed" is STRICT (`now > placedAtMs + order_validity_ms`): at `now == validUntil` the risk engine would still admit the intent (`isExpired` is `end < now`), so retirement waits one more millisecond; the planner already refuses at equality.
- Retirement does not require passing through SUBMISSION_UNKNOWN first (a validity window shorter than `submission_unknown_after_ms` retires straight from PENDING; pinned).
- A `CANCEL_PENDING` reduce (after an incident / reconciliation cancel) counts as live for D3/D4 (held with `SB.AWAITING_CANCEL_CONFIRMATION`, never re-cancelled, never replaced) — the packet lists PENDING/SUBMISSION_UNKNOWN/WORKING; CANCEL_PENDING is the state only a safety path can put it in.
- `SB.AWAITING_RECONCILIATION` (key `entryAwaitingReconciliation`) is reused for the exit SU report; the purity test forbids duplicate code strings, so no alias key was added.
- `nextWakeupAt` is requested on the PENDING reduce hold (silence bound) and on the SU hold (first retirable instant). Neither golden carries `nextWakeupAt`, and the trader dispatches no `onTimer`.

## deviations

1. **`machine-closure.test.ts` "and the exits still work afterwards — the halt's real cost"**: the fixture moved, not the claim. It used `terminalTrack("EXIT","CANCELED")` whose evidence is `viewFilledShares "50"` with nothing folded — under D6 that exit is awaiting a 50-share fill, and firing a 50-share stop on top of it is exactly P4d's oversell. The test now uses `viewFilledShares "0"` for the "stop still fires" route and ADDS the D6 half (same state with 50 reported -> not halted, `SB.AWAITING_FILL_ALLOCATION`, no placement, no cancel). Required by D6; disclosed in the test.
2. **`machine-closure.test.ts` sweep count 3240 -> 6480**: every sweep gained an exit-role dimension (TAKE_PROFIT, PROTECTED_REDUCE) so the stale-data, no-halt and §6-invariant-13 sweeps cover reduce-role tracks (acceptance 8). Strengthening, not a weakened assertion.
3. **Two new MOVE-SITEs** (`reduceStillLive`, `exitIntentExpired`), both on existing edges. `reduceStillLive` is not named in D1-D11: it is needed so a reduce fill after a LATE ENTRY fill folds (without it `OPEN --EXIT_PARTIAL_FILL-->` is refused and the instance pauses on its own exit again — the reviewer's "late entry fill" probe).
4. **`SB.EXIT_RECONCILED`** added: a SUBMISSION_UNKNOWN exit (reachable only since R2) found by a view used to be labelled `SB.ENTRY_RECONCILED`.
5. **`planTakeProfit` never overwrites an exit awaiting its fill** (D6 applied to the `applyEntryFill -> planTakeProfit` path); without it a late entry fill would replace a terminal-awaiting track and the late exit fill could be misattributed.
6. **README: the obsolete pre-RISK-2 record (text + four-row table + follow-up list) was REMOVED**, not kept below a line; a pointer to `133eac1` and `docs/handoffs/RISK-2.md` replaces it. `RISK2-R5` asked for exactly this.
7. The caveat marker is `SUPERSEDED (BRACKET-1a)` without a sha (per packet).
8. `hostile-config.test.ts` gained one negative assertion (`not.toContain(REASONS.protectedReduce)`) so the unreadable-stop pin stays non-vacuous once stop reductions stop saying `SB.FINAL_PROTECTED_REDUCE`.

## known_risks

- **Pre-existing, not introduced, not fixed (out of the D-items):** an exit fill that arrives while the instance is PARTIALLY_OPEN/OPEN because the allocation grew under a TAKE-PROFIT (TP cancel-pending after a resize, or a TP terminal-awaiting its fill when a late entry fill lands) is still refused as `ILLEGAL_TRANSITION` (the census classes `(OPEN, EXIT_PARTIAL_FILL)` as a designed refusal) and pauses, and the fill is not folded. BRACKET-1a closes this only for the protective reduction (the `reduceStillLive` walk-back). Unreachable in the golden (its TP never fills); 1b's scenario fills a TP placed from a single complete entry fill, so it does not hit it either.
- **View-before-fill ordering for a reduce never seen alive that ends PARTLY filled:** D5 refuses its terminal view (it is id-less); its fill then names it (WORKING, with the id) but its terminal state is known only if a view naming that id is delivered again. `apps/trader` delivers every harvested fill before any view (`#harvestFills` then `#deliverOrderViews`), so this ordering does not occur there; views are repeat-safe (obligation 5).
- **A late fill of an already-settled take-profit** (its terminal view said 0 filled, then a fill arrives — a root inconsistency) would match an id-less reduce track by leg and side and be folded into it. Unreachable with fills-before-views; D6 closes the honest version (view reports the fill).
- **R2 rests on obligation 11** (a booked order is listed in `ctx.orders()` before its intent's `validUntil`). `apps/trader`'s loop meets it synchronously (`#ownBookedOrders` in the submit answer; `#orderViews_` lists owned, unretired orders). An asynchronous OMS is unverified; the reservation and `positionAgrees` remain the backstops.
- **A reduce that fills exactly its requested shares after the allocation grew** (late entry fill) is kept WORKING until its FILLED view arrives (the fold decides the order trigger by allocation flatness, not by the order's own completeness); the trader delivers that view. Not changed (adjacent fold semantics).
- `reduceStillLive` makes a late ENTRY fill during a live reduce leave the bracket in `EXIT_PLANNED`/`EXIT_WORKING`; the grown allocation is planned only after the reduce settles. That is D4's stated behaviour, but it is a new transition sequence a reviewer should probe.
- The two new move sites and the extra role guard add halting paths only for a corrupt exit intent id (never produced by this code).

## follow_up

- Governance (orchestrator): update `IMPLEMENTATION_STATUS.md` rows RISK-2 residual 5 (closed by BRACKET-1a, pending review), `RISK-2 item 7` member (i) (`RISK2-R5`, closed), `RISK_SEAM_CAVEAT` note, and WAVE-2-HANDOVER §1 item 1 wording; the round record `docs/handoffs/BRACKET-1a.md` (docs/** was forbidden to this round).
- `BRACKET-1b` (R1): two-bracket e2e scenario, reconciler redesign, `RECON2-EVENTHOP` (quoted, deliberately left), `RISK2-R6`. `BRACKET-1c`: durable round trip. §7 item 1 verdict from a fresh closeout only.
- Still queued, not ridden: `RISK-2 item 7` members (ii) (complement-leg reclassification, a §9.8 contract-owner question) and (iii) (`planEntry` tags `immediate_order_type` unconditionally — the PASSIVE-entry order-type collision; the decide.ts note is unchanged); `TRDR-3-FU1` (same paper golden — sequence it after this round and regenerate from these bytes); `apps/trader/README.md:141-164` pre-RISK-2 posture (BOOT1-R11 owner); `SIM2-E2E-MSG`, N1 (next test/e2e round).
- New candidates: (a) fold an exit fill that arrives in PARTIALLY_OPEN/OPEN for a TAKE-PROFIT too (the pre-existing refusal above); (b) decide the order-sub-machine trigger in `applyExitFill` from the order's own completeness (`filled >= requested`) rather than allocation flatness; (c) whether an exit remainder should ever escalate (R3 says no today — a future ruling).

## commit_sha

`dcba8ad59812e88f91502460c1f66e1c25bd625b` (short `dcba8ad`; branch `bracket-1a`, parent `f034c0b`; not pushed).

# Appendix B — implementer handoff, r1 (verbatim)

# BRACKET-1a — remediation handoff, round 1

## plan (written BEFORE any edit; the pre-edit hand-back is waived by the packet)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-bracket-1a`, branch
`bracket-1a`, HEAD `dcba8ad` (clean). Read: `codex-r1.out` (verdict CHANGES REQUIRED,
BR1-H1 HIGH, BR1-M1 MEDIUM, no LOW, no scope violation), `gates-r1.txt` (all gates
green at `dcba8ad`), `handoff-r0.md`.

BR1-H1 (a late entry fill discarded, then the tracked reduction closes a bracket
that still holds shares). Root cause at `decide.ts:1504`: the ENTRY branch of
`settleTerminalOrder` waits for the fill only when NOTHING has been folded; with 30
folded and a terminal view reporting 50 it clears the entry track, so the late
20-share fill matches no track. Fix, all inside `decide.ts`:

1. `settleTerminalOrder(ENTRY)` keeps the track and holds
   `SB.ENTRY_ORDER_TERMINAL` + `SB.AWAITING_FILL_ALLOCATION` whenever
   `viewFilledShares > filledShares` (incomparable read fail-safe as "waiting"),
   folded or not — the mirror of D6's exit rule. The late fill then matches the
   kept track BY ORDER ID (attribution preserved through settlement).
2. "Do not certify closure while confirmed execution remains unfolded": one
   predicate, `entryExecutionUnfolded(state)` (an entry track whose view reports
   more executed than is folded), refuses every closure the strategy itself
   certifies: `applyExitFill`'s flat fold (it takes `EXIT_PARTIAL_FILL`, keeps
   the exit track, sets no `closedAtMs`, holds `SB.AWAITING_FILL_ALLOCATION`),
   `planExit`'s zero-open branch (the paused-fold -> resume route), and
   `planTick`'s `MARKET_CLOSED` shortcut. Existing edges only; the `exitFill`,
   `bracketFinished`, `marketClosed` move sites keep their pairs.
3. The consequential path the reviewer's residual names (terminal exit awaiting
   its fill -> late entry fill -> OPEN -> exit fill refused as ILLEGAL_TRANSITION):
   `planTakeProfit`'s "exit awaiting its fill" hold re-enters the exit states with
   the existing `EXIT_TRIGGER_MET` edge, exactly as `holdForLiveReduce` does for a
   live reduction. The two walk-backs share ONE helper and ONE move site (the r0
   `reduceStillLive` site is renamed to cover both; the census is updated).

BR1-M1 (HOLD_TO_RESOLUTION and CANCEL_ONLY bypass R2 and D3's reason): in
`planFinalPolicy` both branches recognise a live protective reduction FIRST (as
`planProtectedReduce` does) and return `holdForLiveReduce` with the policy's own
codes, so the silence transition, `SB.EXIT_ORDER_WORKING` and the
`submissionUnknown` report apply under all three final policies.

Pins (in `bracket-1a-reduce-track.test.ts`): the reviewer's callback-only BR1-H1
sequence (no seeded state) carried to a real close; the swapped order (reduction
fill before the late entry fill: never CLOSED while unfolded); the paused-fold ->
resume route; the market-closed shortcut; the terminal-exit-awaiting-fill + late
entry fill route; and BR1-M1 for both policies through the silence threshold and
past validUntil. Each must FAIL with `dcba8ad`'s `decide.ts` restored and pass on
the fix. Goldens must not move (both goldens' entry fills precede their views).
Then every gate in the packet, exact counts.

---

## summary

Review round 1 is fixed and committed: `ecf7f60` sits on top of `dcba8ad` on `bracket-1a` (no amend, no rebase, not pushed). Both findings are fixed. There were no LOW findings and no scope violations. The goldens did not move. All evidence is SIMULATED_NOT_REAL_EVIDENCE.

**BR1-H1 (HIGH)**
- Root cause: `settleTerminalOrder`'s ENTRY branch waited for a fill only when nothing had been folded (`dcba8ad` decide.ts:1504).
- New predicate: `entryExecutionUnfolded(state)` (decide.ts:368) is true when the entry view is ahead of its fold. An incomparable read counts as true (fail-safe).
- The predicate drives three rules, all so that the awaited fill FOLDS when it lands:
  1. The terminal entry track is KEPT (:1550), so the late fill folds into it by order id.
  2. No path certifies CLOSED while the predicate holds:
     - `applyExitFill` (:2947) takes `EXIT_PARTIAL_FILL`, keeps the exit track, sets no `closedAtMs`, and reports `[SB.EXIT_FILLED, SB.AWAITING_FILL_ALLOCATION]`;
     - `planExit`'s zero-open branch (:1809) holds (this covers the paused-fold, then resume, route);
     - `planTick`'s MARKET_CLOSED shortcut (:735) holds.
  3. Exit settlement (:1601) and R2 retirement (:2446) do not move the bracket into OPEN. §13.3 folds entry fills out of the entry states, PARTIALLY_OPEN and the exit states, never out of OPEN (the census calls `(OPEN, ENTRY_*)` a designed refusal).
- The reviewer's Residual is now fixed and pinned through callbacks. The case: a terminal exit awaits its fill (D6) and a late entry fill lands, which led to OPEN and an ILLEGAL_TRANSITION.
  - The fix: `planTakeProfit`'s D6 hold (:1932) walks the bracket back into the exit states.
  - It uses the same helper, `reenterExitStates` (:2313), and the single move site `exitStillOwed` (:2317) that `holdForLiveReduce` (:2355) now uses.
  - The r0 site `reduceStillLive` was renamed. Its pairs are unchanged.

**BR1-M1 (MEDIUM)**
- `planFinalPolicy`'s `HOLD_TO_RESOLUTION` (:2549) and `CANCEL_ONLY` (:2563) now recognise a live reduction first and hold it through `holdForLiveReduce`, with the policy's own codes.
- So R2's silence transition, `modelOutputs.submissionUnknown` and D3's `SB.EXIT_ORDER_WORKING` now apply under all three final policies.
- After R2 retires the reduction, neither policy places another.

**Unchanged**
- Machine: 63 edges, state schema v2, 20 move sites (one renamed).
- `machine.ts`, `state.ts`, `reasons.ts`, `strategy.ts` (1.1.0), every golden, `apps/**`, `test/e2e/**`, `test/integration/**` and the manifests are byte-identical to `dcba8ad`.

### finding -> disposition

| id | severity | disposition | pins (in `test/unit/strategies/static-bracket/bracket-1a-reduce-track.test.ts`, block `BR1-H1 — …` at :1320 / `BR1-M1 — …` at :1621) |
| --- | --- | --- | --- |
| BR1-H1 | HIGH | FIXED | "the reviewer's sequence: the late 20 folds BY ID into the kept entry track, and the bracket exits all 50 before it is CLOSED" (:1403); "the reduction's fill lands FIRST: flat on what is folded is not CLOSED while 20 more were reported" (:1449); "the paused-fold-then-resume route (the reviewer's steps 8-9 as run): resume does not certify CLOSED" (:1485); "the late 20 lands BETWEEN the take-profit's settlement and the stop's reduction: it folds (OPEN would refuse it)" (:1368); "the market-closed shortcut does not close an entry whose view outran its fill; the fill then folds" (:1526); "a terminal REDUCTION awaiting its fill, then the late entry fill: back into the exit states, and the sale still folds" (:1551, the reviewer's Residual); "the same for a terminal TAKE-PROFIT awaiting its fill when the entry's own remainder fills" (:1585) |
| BR1-M1 | MEDIUM | FIXED | "HOLD_TO_RESOLUTION: an unanswered stop reduction goes SUBMISSION_UNKNOWN at the silence bound inside the cutoff, and is retired only after validUntil" and "CANCEL_ONLY: …" (parameterised, :1621ff; the reviewer's instants 12:14:39 / 12:14:45, silence 5 000 ms, validity 30 000 ms; also via `onMarketClosing`, held up to and including validUntil 12:15:09.000, retired at 12:15:09.001 with no replacement); the r0 pin "CANCEL_ONLY at the close leaves a live stop reduction working" (:797) now also asserts `[SB.EXIT_CUTOFF, SB.FINAL_CANCEL_ONLY, SB.EXIT_ORDER_WORKING]` |

## files_changed

- `packages/strategies/static-bracket/src/decide.ts`:
  - `entryExecutionUnfolded`;
  - ENTRY settlement retention;
  - the three closure guards;
  - the settle and retire into-OPEN guards;
  - `reenterExitStates` (the shared walk-back; the MOVE-SITE is renamed to `exitStillOwed`);
  - `planTakeProfit`'s D6 walk-back;
  - `planFinalPolicy`'s live-reduce holds;
  - doc comments for each (the `settleTerminalOrder` three-outcomes text, `withdrawResting`, `planFinalPolicy`, `holdForLiveReduce`, `planTakeProfit`).
- `packages/strategies/static-bracket/README.md`:
  - the sticky bullet now covers the final policies (BR1-M1);
  - the "An allocation that grows under it" bullet names the D6 walk-back;
  - a new "A late ENTRY fill is never discarded, and the bracket is never closed over it" bullet, including the uncovered pre-existing case;
  - the paused-fold note;
  - obligation 7.
- `test/unit/strategies/static-bracket/bracket-1a-reduce-track.test.ts`:
  - 9 new tests (the two blocks above);
  - one r0 pin extended with an extra assertion;
  - a header paragraph;
  - a note on the seeded r0 late-entry test pointing to the callback-only block.
- `test/unit/strategies/static-bracket/machine-closure.test.ts`: the census entry `reduceStillLive` -> `exitStillOwed` (same pairs, updated `why`) and the `marketClosed` `why` text. No assertion was changed or removed.

## tests_run

All commands used `pnpm_config_verify_deps_before_run=false`. Docker `29.1.2`. Logs are under `…/scratchpad/bracket-1a/r1/`.

| Gate | Result | At `dcba8ad` (gates-r1) |
| --- | --- | --- |
| `pnpm run typecheck` | exit 0 | exit 0 |
| `pnpm run lint` | exit 0 | exit 0 |
| `pnpm run check:deps` | exit 0 (34 packages / 80 edges, PASS) | same |
| `pnpm run test` | exit 0, **345 files / 7521 tests** | 345 / 7512 |
| `pnpm run test:e2e` (twice) | exit 0, **7 / 157** both runs | 7 / 157 |
| `pnpm run test:replay` (twice) | exit 0, **3 / 17** both runs | 3 / 17 |
| `pnpm --filter @polymarket-bot/control-api test:integration` | exit 0, **10 / 87** | 10 / 87 |
| `pnpm --filter @polymarket-bot/trader test:integration` | exit 0, **15 / 132**, 0 skipped. The Testcontainers files ran: durable-trader-first-fill-postgres (9 tests, 10.5 s), trader-health-endpoint-postgres, durable-pnl-snapshot-postgres, univ-4-gateway-opens-trader-redis | 15 / 132 |
| static-bracket suite alone (`vitest run --config test/vitest.config.ts test/unit/strategies/static-bracket`) | **14 files / 367 tests**, and again on the commit itself; `pnpm --filter @polymarket-bot/strategy-static-bracket typecheck` exit 0 | 14 / 358 |

New tests (9; 39 -> 48 in `bracket-1a-reduce-track.test.ts`): the seven BR1-H1 and two BR1-M1 tests named in the table above. One existing pin gained an assertion: CANCEL_ONLY at the close.

### Non-vacuity (every overlay restored; `sha256sum -c` OK for `decide.ts` (b842ab13…) and the test file)

- **`dcba8ad`'s `decide.ts` restored:** static-bracket suite **11 failed / 355 passed (366)**. That is all 9 new tests, the extended CANCEL_ONLY pin, and the two census pins, which fail because `exitStillOwed` has no marker at `dcba8ad`. With the added BETWEEN pin in the file: 10 of 48 fail. The failures are exactly the ones the findings predict:
  - H1 sequences: `[ENTRY_ORDER_WORKING, ENTRY_ORDER_TERMINAL]` without `AWAITING_FILL_ALLOCATION` (the track was cleared);
  - market-closed: `SB.MARKET_CLOSED`;
  - TP walk-back: instanceState `OPEN` where `EXIT_PLANNED` is expected;
  - M1: `[EXIT_CUTOFF, FINAL_*]` without `SB.EXIT_ORDER_WORKING`.
- **Per-guard ablations** (each r1 piece removed alone from the r1 `decide.ts`; the first row instead applies only the retention to `dcba8ad`). Every guard makes at least one pin fail:

  | Ablation | Failed / 47 | Which pins fail |
  | --- | --- | --- |
  | retention only (on `dcba8ad`) | 9 | every H1 and M1 pin |
  | no `applyExitFill` guard | 2 | "fill lands FIRST", "paused-fold -> resume" |
  | no zero-open guard | 2 | the same two |
  | no MARKET_CLOSED guard | 1 | market-closed |
  | no settle/retire into-OPEN guard | 4 (5/48 with BETWEEN) | the pins that pass through the helper's step-5 state assertion |
  | no `planTakeProfit` walk-back | 2 | terminal REDUCTION, terminal TAKE-PROFIT |
  | no final-policy hold | 3 | both M1 pins and the CANCEL_ONLY pin |

- For the settle-into-OPEN guard I also ran a behavioural probe. With the helper's state assertion stripped in a scratch copy, the BETWEEN pin fails on the behaviour itself: `expected 'SB.ILLEGAL_TRANSITION' to be 'SB.ALLOCATION_CONFIRMED'`.

### Golden-change protocol

No golden byte moved in r1. Nothing was regenerated.
- `git diff --quiet dcba8ad -- test/replay-golden` exit 0.
- `test:e2e` and `test:replay` passed unchanged, twice each.
- Derivation: both goldens deliver the entry's fills 30 and 20 before the entry's FILLED view. At d4 the view reports 50 with 50 folded, so `entryExecutionUnfolded` is false everywhere in both runs.
- The golden's `final_policy` is PROTECTED_REDUCE, so BR1-M1's branches are not reached.
- r0's evidence (a)-(e) stands unchanged for the `dcba8ad` delta.

## assumptions

- "Confirmed execution remains unfolded" (the reviewer's wording) is read as "the entry track's `viewFilledShares` > `filledShares`", for a terminal or a live entry. A live entry whose view shows nothing unfolded does not block closure. That is pre-existing, and I did not extend it.
- The "exit states" walk-back applies to an exit of either role that is terminal but awaiting its fill. The same argument covers both: an order that can still produce a fill must be foldable. The TAKE-PROFIT half closes a subcase of r0's disclosed pre-existing risk.
- Staying in `EXIT_PLANNED`/`EXIT_WORKING` with no exit track and a nonzero open allocation (while an entry is unfolded) is a legitimate host for the ladder. Every placement from there uses `EXIT_TRIGGER_MET`, which exists from both states. The machine-closure sweeps pass over it.
- BR1-M1: a live reduction is recognised BEFORE `withdrawResting` in the two policies, consistent with D3 in `planProtectedReduce`. Under the invariant that a reduction is placed only after the entry and take-profit are withdrawn, nothing else can be live beside it, so the order of the two checks makes no difference.

## deviations

1. Beyond the reviewer's minimal remediation (retention + no closure), I added:
   - the settle/retire into-OPEN guard;
   - the MARKET_CLOSED guard;
   - the D6 walk-back in `planTakeProfit`.

   Each closes an interleaving of the same finding that the minimal fix left open. Each is pinned by a callback-only test, and each is shown load-bearing by ablation:
   - without the into-OPEN guard, a late fill landing between the take-profit's settlement and the reduction is an ILLEGAL_TRANSITION pause;
   - without the walk-back, the reviewer's Residual becomes reachable through callbacks once retention exists.
2. The census site `reduceStillLive` was renamed `exitStillOwed`, because it now serves both owed-exit cases through one helper. The pairs are unchanged. This is a test-table edit, not a weakened assertion.
3. The r0 test "CANCEL_ONLY at the close…" gained one stronger assertion (its reason codes). No existing assertion was relaxed or removed.

## known_risks

- **Pre-existing, unchanged from base, disclosed in the README:** a fill for an entry order that is still LIVE while the bracket is already `OPEN` is still the census's designed refusal: `SB.ILLEGAL_TRANSITION`, PAUSED, the fill unfolded. An example is a withdrawn entry whose cancel loses the race after the take-profit's settlement moved the bracket to OPEN. `OPEN --ENTRY_*-->` is not a §13.3 edge, and no edge was added. If that entry's terminal view later reports the fill, the bracket also cannot close; it waits, and needs operator reconciliation. Under §13.2's example the entry is an immediate FAK.
- **Pre-existing:** r0's take-profit risk for a LIVE take-profit (cancel-pending after a resize) whose fill lands in PARTIALLY_OPEN/OPEN remains. Only the terminal-awaiting subcase is fixed here.
- **Behaviour change:**
  - A root that reports a filled size on an entry view and never delivers that fill now leaves an instance that has exited everything it folded waiting in its exit state (`SB.AWAITING_FILL_ALLOCATION`) instead of closing. This is the fail-safe direction and is disclosed in obligation 7.
  - An entry's terminal view in PARTIALLY_OPEN that is ahead of the fold now keeps the bracket in PARTIALLY_OPEN until the fill, instead of moving it to OPEN at once.
- **Pre-existing TAKE_PROFIT adoption (kept by the packet):** a redelivered terminal view of an already-settled exit can still be adopted into a fresh id-less TAKE_PROFIT track. D5 protects only the reduce role. r1 creates no new ordering for this.
- **A reduction that fills its full requested size after the allocation grew** stays WORKING until its FILLED view settles it. This is r0's known risk; the reviewer's sequence pin exercises exactly that path, with the view delivered as the trader delivers it.
- **The reviewer's residual note "an order that ended unfilled without ever being adopted can expire out of tracking"** is R2 as ruled: never named by a view or a fill, and past its validUntil. It was pinned in r0. It is not a defect.

## follow_up

- Orchestrator: verify `ecf7f60` (Codex). On ACCEPT, governance records BRACKET-1a r1 (docs/** was forbidden to this round).
- Candidate, not ridden: fold an entry fill for a LIVE entry that arrives in OPEN, which needs an edge or a ruling. Also r0's LIVE-take-profit case. Both are the same `(OPEN, *_FILL)` designed-refusal family.
- Unchanged from r0: BRACKET-1b and 1c (R1), `RISK-2 item 7` (ii) and (iii), `TRDR-3-FU1` (sequence after this round), `SIM2-E2E-MSG`, N1.

## commit_sha

`ecf7f604ec5b7a42cb09eb3da640b05cb63d151d` (short `ecf7f60`; branch `bracket-1a`, parent `dcba8ad`; not pushed).

# Appendix C — implementer handoff, r2 (verbatim)

# BRACKET-1a — remediation handoff, round 2

## plan (written BEFORE any edit; the pre-edit hand-back is waived by the packet)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-bracket-1a`, branch
`bracket-1a`, HEAD `ecf7f60` (clean). Read: `codex-r2.out` (verdict CHANGES REQUIRED,
one finding BR2-H1 HIGH, no MEDIUM, no LOW, no scope violation), `gates-r2.txt`
(every gate green at `ecf7f60`), `handoff-r0.md`, `handoff-r1.md`, `codex-r1.out`.

BR2-H1 root cause (re-derived from `decide.ts` at `ecf7f60`):

- `applyEntryFill` (:2896-2913) folds a late entry fill out of the exit states
  (`EXIT_* --ENTRY_FILL_COMPLETE/ENTRY_PARTIAL_FILL--> OPEN/PARTIALLY_OPEN`). On
  healthy data it continues into `planTakeProfit`, whose r1 D6 hold walks the
  bracket back into the exit states (`reenterExitStates`). On unhealthy data it
  returns `incidentPlan(moved.value …)` instead, which PAUSES with
  `resumeTo: OPEN`.
- On resume, `planTick` lands in `OPEN` and runs `planExit`. Its D6 return
  (:1792-1797, "exit terminal, view ahead of fold") returns the settlement's state
  unchanged — still `OPEN` — without the walk-back every other owed-exit path
  performs (`holdForLiveReduce`, `planTakeProfit`'s D6 hold).
- The awaited exit fill then hits `OPEN --EXIT_PARTIAL_FILL-->`, which §13.3 does
  not contain: `refuseTransition` -> ILLEGAL_TRANSITION, PAUSED, the fill discarded,
  and every later evaluation waits for it again.

Fix (inside `packages/strategies/static-bracket/src/decide.ts` only; no new edge, no
new move site):

1. `planExit`'s D6 return walks the bracket back into the exit states through the
   existing `reenterExitStates` helper (single move site `exitStillOwed`,
   `PARTIALLY_OPEN|OPEN --EXIT_TRIGGER_MET--> EXIT_PLANNED`, then
   `syncPlannedToWorking`), halting on the (unreachable) refusal exactly as
   `planTakeProfit` does. This is the reviewer's diagnostic fix. It covers every
   route to that return, because a RESUME happens only in `planTick`, which then
   runs `planExit` for `PARTIALLY_OPEN`/`OPEN`, and it covers both exit roles (a
   terminal TAKE-PROFIT awaiting its fill reaches the same return).
2. Doc comments: `planExit`'s D6 comment, `reenterExitStates`'s caller list,
   `planTakeProfit`'s "only from applyEntryFill" sentence (no longer the only
   walk-back caller), and the census `why` text for `exitStillOwed` in
   `machine-closure.test.ts` (pairs unchanged). README: extend the r1 bullet on the
   D6 walk-back with the incident/resume route.

Pins (in `bracket-1a-reduce-track.test.ts`, new block `BR2-H1`), callbacks only:
- the reviewer's exact 10-step sequence (reduction terminal awaiting its fill,
  late entry fill on stale data, fresh features, reduction fill, fresh features),
  carried to a real close with all 50 exited;
- the swapped order (the reduction's fill lands while PAUSED, before fresh data);
- the TAKE-PROFIT mirror (a terminal take-profit awaiting its fill, the entry's
  remainder fills on stale data).
Each must FAIL with `ecf7f60`'s `decide.ts` restored (except any that do not
exercise the gap, which I will name) and pass on the fix. Goldens must not move
(neither golden has an incident, nor a D6 hold in `planExit`). Then every gate in
the packet, with exact counts.

I considered also walking back inside `incidentPlan` (so the PAUSED record's
`resumeTo` names an exit state). I do not plan to: with fix 1 it changes no
observable behaviour I can construct (a paused fill is folded by `pausedFold`
regardless of `resumeTo`, and the resume's own evaluation walks back), and the
reviewer's minimal remediation is fix 1. If the pins show otherwise I will revisit
and report.

---

## summary

BR2-H1 (HIGH) is fixed and committed as `8d3f6cb3b86615efb8e6badd9cd298ace79f6a51`, on top of `ecf7f60` on `bracket-1a`. Nothing was amended, rebased or pushed.
- There were no MEDIUM or LOW findings and no scope violations.
- Neither golden moved.
- All evidence is simulated. No soak, live data or real order was involved.

**Root cause** (confirmed as the plan above describes):
1. A late ENTRY fill on stale data takes `applyEntryFill`'s incident branch. That PAUSES with `resumeTo` `OPEN`/`PARTIALLY_OPEN` instead of reaching `planTakeProfit`'s r1 walk-back.
2. The resume's evaluation then reached `planExit`'s D6 return ("exit terminal, its view ahead of its fold") and returned without moving.
3. The awaited exit fill therefore hit `OPEN --EXIT_PARTIAL_FILL-->`, which §13.3 does not contain: `SB.ILLEGAL_TRANSITION`, PAUSED, and the fill discarded.

**Fix** (the reviewer's diagnostic remediation):
- `planExit`'s D6 return (`decide.ts:1792-1812`) now calls the existing `reenterExitStates` (`decide.ts` ~:2330) before holding.
- `reenterExitStates` is the single `exitStillOwed` move site: `PARTIALLY_OPEN|OPEN --EXIT_TRIGGER_MET--> EXIT_PLANNED`, then `syncPlannedToWorking`.
- The executable delta is exactly these five lines:
  ```
  -    return plan(settlement.state, "hold", [...reasons, ...settlement.reasons]);
  +    const back = reenterExitStates(settlement.state);
  +    if (!back.ok) {
  +      return halted(settlement.state, back.problem, []);
  +    }
  +    return plan(back.value, "hold", [...reasons, ...settlement.reasons]);
  ```
- No machine edge, no new move site. The machine keeps 63 edges and state schema v2. `machine.ts`, `state.ts`, `reasons.ts`, `strategy.ts` and `index.ts` are byte-identical to `ecf7f60`.

**Why this one site suffices** for the family:
- RESUME happens only in `planTick` (`decide.ts` ~:708). For `PARTIALLY_OPEN`/`OPEN`, the same evaluation runs `planExit`.
- In `planExit`, every hold that keeps an owed exit now walks back:
  - a live reduction, via `holdForLiveReduce` (all three final policies since r1);
  - a terminal exit awaiting its fill, via the D6 return (this fix).
- A fill that lands while PAUSED is folded by `pausedFold` whatever `resumeTo` says.
- This covers both exit roles and every resume callback: `onFeatures`, `onTimer`, `onMarketClosing` inside the cutoff, and `onMarketClosing(0)`.

### finding -> disposition

All pins are in `test/unit/strategies/static-bracket/bracket-1a-reduce-track.test.ts`, in the block "BR2-H1 — a late entry fill on stale data pauses; the resume walks the bracket back into the exit states, so the awaited exit fill still folds". It is nested inside the BR1-H1 describe so it can reuse that block's sequence helpers without moving existing test code.

| id | severity | disposition | pins |
| --- | --- | --- | --- |
| BR2-H1 | HIGH | FIXED | (1) "the reviewer's sequence: a terminal REDUCTION awaits its fill, the late BUY 20 lands on a stale book; after the resume the sale folds and all 50 exit" (the reviewer's 10 steps, carried to CLOSED 50/50); (2) "the same when the late fill is PARTIAL: the pause is taken from PARTIALLY_OPEN, and the walk-back starts there"; (3) "the TAKE-PROFIT mirror: a terminal take-profit awaits its fill, the entry's remainder fills on a stale book; after the resume the sale folds"; (4) "the incident CANCELS a working reduction and its FILLED view lands WHILE PAUSED: the resume walks back all the same, and the sale folds"; (5-7) "PROTECTED_REDUCE / HOLD_TO_RESOLUTION / CANCEL_ONLY: the resume is onMarketClosing inside the cutoff — the awaited fill is waited for before the policy, and it folds"; (8) "a guard, not a discriminator: when the reduction's fill lands WHILE PAUSED it folds there, and the resume settles it and exits the rest". Pins 1-7 FAIL against `ecf7f60`; 8 passes there by design |

## files_changed

- `packages/strategies/static-bracket/src/decide.ts`
  - The fix: `planExit`'s D6 return walks back.
  - Comments only:
    - `planExit`'s D6 comment;
    - `planTakeProfit`'s "exit still awaiting its fill" paragraph;
    - `reenterExitStates`'s doc, which now names its three evaluation callers and the stale-data route.
- `packages/strategies/static-bracket/README.md`
  - The "An allocation that grows under it" bullet: the stale-data route, i.e. pause, resume, then the walk-back in the resume's evaluation.
  - The "An exit terminal on the venue waits for its fill" bullet: it waits in the exit states. It also discloses the pre-existing live take-profit race (see known_risks) with its base behaviour, which I measured.
- `test/unit/strategies/static-bracket/bracket-1a-reduce-track.test.ts`
  - The header gains a round-2 paragraph.
  - New nested BR2-H1 block: 8 tests (48 -> 56 in this file).
  - No existing test or assertion was changed or moved.
- `test/unit/strategies/static-bracket/machine-closure.test.ts`
  - The `exitStillOwed` census `why` text now names r2 and `planExit`'s hold.
  - The pairs (`PARTIALLY_OPEN|OPEN x EXIT_TRIGGER_MET`) and every assertion are unchanged.

## tests_run

Every pnpm command was prefixed `pnpm_config_verify_deps_before_run=false`. Docker answered `29.1.2`. Gate logs for the committed tree are in `…/scratchpad/bracket-1a/r2gates/`; the logs of an identical pre-commit run are in `r2gates/first/`. The two runs differ only by one comment edit, and both are all exit 0.

| Gate (run on the committed tree `8d3f6cb`) | Result | At `ecf7f60` (gates-r2) |
| --- | --- | --- |
| `pnpm run typecheck` | exit 0 | exit 0 |
| `pnpm run lint` | exit 0 | exit 0 |
| `pnpm run check:deps` | exit 0, PASS | PASS |
| `pnpm run test` | exit 0, **345 files / 7529 tests** | 345 / 7521 |
| `pnpm run test:e2e` (twice) | exit 0, **7 / 157** both runs | 7 / 157 |
| `pnpm run test:replay` (twice) | exit 0, **3 / 17** both runs | 3 / 17 |
| `pnpm --filter @polymarket-bot/control-api test:integration` | exit 0, **10 / 87** | 10 / 87 |
| `pnpm --filter @polymarket-bot/trader test:integration` | exit 0, **15 / 132**, 0 skipped. The Testcontainers files ran: durable-trader-first-fill-postgres (9), trader-health-endpoint-postgres (3), durable-pnl-snapshot-postgres (3), univ-4-gateway-opens-trader-redis (2) | 15 / 132 |
| static-bracket suite alone (`pnpm exec vitest run --config test/vitest.config.ts test/unit/strategies/static-bracket`) | exit 0, **14 files / 375 tests** | 14 / 367 |
| `pnpm --filter @polymarket-bot/strategy-static-bracket typecheck` | exit 0 | — |
| `pnpm exec vitest run --config test/vitest.config.ts test/unit/simulation/backtest-static-bracket-replay.test.ts` | exit 0, **1 / 8** | 1 / 8 |

New tests: 8, all named in the table above. The +8 accounts exactly for 7521 -> 7529 and 367 -> 375.

### Non-vacuity (every overlay restored; `sha256sum -c` OK each time)

1. **`ecf7f60`'s `decide.ts` restored** (sha `b842ab13…`, equal to `git show ecf7f60:<path>`).
   - Static-bracket suite: **7 failed / 368 passed (375)**. The 7 failures are exactly pins 1-7.
   - Six fail with `expected 'OPEN' to be 'EXIT_PLANNED'` and one (PARTIAL) with `expected 'PARTIALLY_OPEN' to be 'EXIT_PLANNED'`, each on the state after the resume.
   - The guard (pin 8) passes, as designed.
   - Restored: `decide.ts` `b4ddec3a…` OK. That was the working copy before one last comment-only edit to `reenterExitStates`'s doc (a two-line comment reworded; no code). The committed `decide.ts` is `969f5e7a…`, equal to `git show HEAD:<path>`. Every gate above ran on the commit, and the neighbour battery re-ran there: 12/12.
   - Log: `r2probe/nonvac-ecf-suite2.log`.
2. **Behavioural variant**, to show the pins do not rest on the state assertion alone.
   - Temporary change: the 5 textual `expect(b.state.instanceState).toBe("EXIT_PLANNED")` lines in the BR2-H1 block stripped, with `ecf7f60`'s `decide.ts` restored.
   - Result: the same **7 fail**, all at the sale: `expected [ 'SB.ILLEGAL_TRANSITION', …(3) ] to deeply equal [ 'SB.EXIT_FILLED' ]`. That is the reviewer's failure exactly.
   - Both files restored, `sha256sum -c` OK.
   - Log: `r2probe/nonvac-behaviour.log`.
3. **Neighbour battery** (scratch probes, never in the repo: `r2probe/probes/neighbours.probe.ts`, 12 interleavings).
   - On the fix: **12 / 12 pass** (`neighbours-final.log`, run on the commit).
   - Against `ecf7f60`: **9 fail**. N2, N3, N4, N5, N7 x2, N8, N9 and N11 fail with ILLEGAL_TRANSITION variants (N11 is the incident flagged by feature instead of a stale book).
   - The 3 that pass at `ecf7f60` (N1, N6, N10) are the routes where the reduction is still LIVE at the resume, so `holdForLiveReduce` already walked back (`neighbours-ecf.log`).
   - The battery covers:
     - live-WORKING and PENDING reductions cancelled by the incident;
     - a CANCELED-with-partial-fill view while paused and after the resume;
     - resume via `onMarketClosing` inside the cutoff and at 0 seconds;
     - a second stale evaluation after the walk-back;
     - both non-reduce final policies;
     - the TP mirror with a still-live entry.
4. **Goldens.**
   - `git diff --quiet ecf7f60 -- test/replay-golden` exit 0; nothing was regenerated.
   - `test:e2e` and `test:replay` passed unchanged twice each, and the backtest replay test passed as well.
   - Derivation: neither golden run has a data-quality incident, and neither reaches `planExit`'s D6 return. The only D6-shaped decision is the backtest's seq 7 `onOrderUpdate`, a take-profit CANCELED with nothing executed, which is not an awaiting-fill hold. So the new branch is never taken.
   - r0's evidence (a)-(e) stands unchanged for the `f034c0b` -> HEAD golden delta.

Scope checks:
- `git diff --name-only ecf7f60 HEAD` = the four files above, all inside allowed paths.
- `machine.ts`, `state.ts`, `reasons.ts`, `strategy.ts`, `index.ts`, `apps/**`, `test/e2e/**`, `test/integration/**`, `docs/**`, `db/**`, `package.json`, `pnpm-lock.yaml` and `eslint.config.mjs` are unchanged versus `ecf7f60`.
- No untracked files in the worktree, and no `eslint-disable`, `.skip`, `.only` or `ts-ignore`.

## assumptions

- The reviewer's step-7 "stale book data" is the leg's (YES) book with `asOf` an hour old, as stated (`11:00:00` against `now=12:00:07`). The incident codes are then `[SB.INCIDENT_POLICY_FIRST, SB.STALE_BOOK, SB.PAUSED]`, with no safety cancel because nothing is live at that instant. The feature-flagged incident (`SB.DATA_QUALITY_INCIDENT`) takes the same branch; I probed it as N11.
- Step 10's "evaluate fresh features again" is pinned with the stop still triggered. The 20 held then get a protective reduction. The TAKE-PROFIT mirror pins the no-stop variant, where they get a take-profit.
- `resumeTo` on the PAUSED record is left naming `OPEN`/`PARTIALLY_OPEN`. I did not also walk back inside `incidentPlan` (see deviations).

## deviations

- The pins are a nested `describe` inside the BR1-H1 block, not a new top-level block. This lets them reuse `reportedAheadOfFold` without moving or re-indenting existing test code. Their names all start with "BR2-H1", so `-t BR2-H1` selects exactly them.
- I considered making the pause itself record an exit state (walking back inside `incidentPlan` before `PAUSE`) and did not do it. With the fix it changes no observable behaviour I could construct:
  - a paused fill is folded by `pausedFold` whatever `resumeTo` says;
  - the resume's own evaluation walks back;
  - all 12 neighbour probes pass without it.

  It would be a second change for no pinned difference. The reviewer's minimal remediation is the D6 return.
- The README now also DISCLOSES the pre-existing live take-profit race, which I measured at base and at HEAD. That is documentation only: the walk-back text needed to say what it does NOT cover. The behaviour is unchanged.

## known_risks

- **Pre-existing, disclosed in r0/r1, now also in the README; not changed:** a TAKE-PROFIT still LIVE when a late entry fill moved the bracket to `PARTIALLY_OPEN`/`OPEN` (the resize's cancel-then-replace, whose cancel loses the race).
  - Its fill is refused from that state: `SB.ILLEGAL_TRANSITION`, paused, fail-closed, the fill unfolded.
  - Measured on both delivery orders at HEAD (`r2probe/probes/livetp.probe.ts`): fill-first gives `[ILLEGAL_TRANSITION, POSITION_MISMATCH, NO_BLIND_FLATTEN, PAUSED]`; view-first (`CANCELED f=10`, then the fill) gives the same.
  - At base `f034c0b`, fill-first gave the same, and view-first gave `[UNATTRIBUTED_FILL, POSITION_MISMATCH, NO_BLIND_FLATTEN, PAUSED]`. Both pause the same way.
  - It is the only route by which `planOrderUpdate`'s own D6 hold (`finishOrder`) can sit in `PARTIALLY_OPEN`/`OPEN`. I did not walk back there, for two reasons:
    - it would fix only the view-first order;
    - walking a scale-in bracket back while its entry is still live trades this refusal for the LIVE-entry one below.

    A clean fix needs the family's ruling.
- **Pre-existing, disclosed:** an entry fill for an entry order still LIVE while the bracket is `OPEN` is the census's designed refusal. The walk-back does not create this. At `ecf7f60` the same routes failed earlier, at the exit fill; after the fix, a still-live entry can meet this refusal later, exactly as on r1's healthy-data path.
- **The reviewer's residual, carried forward and not a finding:** an id-less reduction whose FIRST view is terminal and partly filled is ignored by D5, since an id-less reduction is named only by a live view. Its fill then names it, but the track stays WORKING until a terminal view is delivered again by id. Under the trader's fills-before-views delivery (`loop.ts` `#harvestFills` before `#deliverOrderViews`) the fill arrives first, so the view settles it.
- The fix walks back through `EXIT_TRIGGER_MET` from `OPEN` while the exit is terminal. The census and the machine-closure sweeps cover the pair. A halt branch exists for a refused walk-back; it is unreachable because the edge exists from both states, and mirrors `planTakeProfit`'s.

## follow_up

- Orchestrator: verify `8d3f6cb` (Codex). On ACCEPT, governance records BRACKET-1a r2; `docs/**` was forbidden to this round.
- Candidates, not ridden:
  - the `(PARTIALLY_OPEN|OPEN, *_FILL)` family: a LIVE take-profit's race fill after a resize, and a LIVE entry's fill in `OPEN`. It needs an edge or a ruling. One option: exit settlement does not move into `OPEN` while the entry is still live, not only while it is unfolded.
  - the id-less-reduction terminal-first-view residual: re-read `ctx.orders()` by id for a tracked exit whose view is terminal.
- Unchanged from r0/r1: BRACKET-1b and 1c (R1), `RISK-2 item 7` (ii) and (iii), `TRDR-3-FU1`, `SIM2-E2E-MSG`, N1.

## commit_sha

`8d3f6cb3b86615efb8e6badd9cd298ace79f6a51` (short `8d3f6cb`; branch `bracket-1a`, parent `ecf7f60`; not pushed).

# Appendix D — implementer handoff, r3 (no commit: its only finding was the CI step, answered by PR #10) (verbatim)

# BRACKET-1a — remediation handoff, round 3

## plan (written BEFORE any edit; the pre-edit hand-back is waived by the packet)

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-bracket-1a`, branch
`bracket-1a`, HEAD `8d3f6cb3b86615efb8e6badd9cd298ace79f6a51` (clean). Read: `codex-r3.out`
(verdict CHANGES REQUIRED; one finding BR3-M1 MEDIUM "the required green GitHub CI result
is unproven"; no CRITICAL/HIGH/LOW; no scope violation; "No implementation change is
indicated by this finding"), `gates-r3.txt` (eight local gates green at `8d3f6cb`),
`handoff-r0..r2.md`, `codex-r1..r3.out`, `IMPLEMENTATION_STATUS.md:258-267` ("All gates
green, and CI green"; "Gate: ... a green CI run on GitHub").

BR3-M1 needs a GitHub Actions run on this candidate. That run exists only after a push /
PR, and this packet forbids both ("No network. Do not push, open a PR or merge."). The
standing process opens the PR per round from the orchestrator side. So the GitHub record
itself is outside the implementer's authority; I will STOP on that part and report it.

What I can do inside the rules, and will do:
1. Mirror `.github/workflows/ci.yml` locally, step by step, on the exact candidate tree
   (`8d3f6cb`), including the CI steps that are NOT in the packet's gate list
   (`typecheck` split 1/4..4/4, `test:fault`, the four `test:contract` suites,
   `test:soak-smoke`, integration 1/6..4/6: storage-postgres, event-bus,
   research-worker, data-gateway). Each such step is a way the candidate could still go
   red on GitHub after passing every packet gate.
2. For steps that need the network (`pnpm install --frozen-lockfile`, `pnpm audit`,
   `uv sync`, `pip-audit`, image pulls), prove by `git diff` that their inputs
   (lockfiles, manifests, `python/**`, `docker-compose.yml`, `.github/**`) are
   byte-identical to base `f034c0b`, so the candidate cannot change their outcome.
   Run the compose and python jobs only if possible fully offline (`--pull never`,
   `--offline`); otherwise report them as not run.
3. If any mirrored step fails because of this package: fix it inside the allowed paths,
   pin it (fails at `8d3f6cb`, passes after), commit `BRACKET-1a r3: ...` on top.
   If every step passes: there is nothing to change. I will then NOT create an empty
   commit, because a new commit would move the SHA that the owed GitHub run has to
   certify while changing no byte of the tree; I will disclose this as a deviation from
   "commit on top" and return `8d3f6cb` as the candidate SHA.

---

## summary

Round 3 has one finding, BR3-M1 (MEDIUM): the GitHub CI run the package gate requires
(`IMPLEMENTATION_STATUS.md:262` "All gates green, and CI green"; `:267` "a green CI run on
GitHub") has not been shown for candidate `8d3f6cb`. The verifier found no implementation
defect and says "No implementation change is indicated by this finding".

**I did not close BR3-M1, and I could not.** A GitHub Actions run only exists after a push
or a PR, and this packet forbids both ("No network. Do not push, open a PR or merge."). I
STOP on that item and hand it to the orchestrator, who opens the PR under the standing
per-round process.

**What I did instead.** I mirrored `.github/workflows/ci.yml` locally on the exact candidate
tree, so the owed GitHub run has no known way to fail:
- Every `node`-job step that runs offline passed: all **21 of 21**, each command exactly as
  `ci.yml` spells it. That includes the CI-only steps the packet's gate list leaves out:
  `test:fault`, the four `test:contract` suites, `test:soak-smoke`, and integration 1/6–4/6
  (storage-postgres, event-bus, research-worker, data-gateway).
- Under the GitHub runner's environment (`CI=true GITHUB_ACTIONS=true TZ=UTC
  LANG=C.UTF-8`), the unit, e2e and replay suites passed again. Those are the suites that
  read the two regenerated goldens.
- The `python` job's pytest passed offline: **131 passed**.
- Steps I could not run, and why:
  - The CI steps that need the network were not run: `pnpm install --frozen-lockfile`,
    `pnpm audit`, `uv sync` against the network, and `pip-audit`. Their inputs are
    byte-identical to base `f034c0b`, proved by `git diff`, so this candidate cannot change
    their outcome.
  - The compose job's `up`/`down` was not run, because it would mount the user's existing
    dev volumes (reason below). Its `docker compose config --quiet` step passed.

**No commit this round.** Nothing in the repository needed to change, so I made no commit.
The candidate is still `8d3f6cb3b86615efb8e6badd9cd298ace79f6a51`, and the worktree is clean.
An empty commit would only move the SHA the owed GitHub run has to certify, without changing
a single byte of the tree (see deviations).

All evidence is simulated or offline. No soak, live data, real order or network was involved.

### Finding table

| id | severity | disposition | pin / evidence |
|---|---|---|---|
| BR3-M1 | MEDIUM | **STOPPED: needs the orchestrator** (push/PR forbidden to the implementer). Not argued wrong: the finding is correct that no GitHub record exists. | No pin is possible: the finding is about CI evidence, not code, so there is no behaviour to pin. Offline evidence instead: a local CI mirror, 21 of 21 offline `node`-job steps exit 0 at `8d3f6cb` (`r3/ci-status.txt`); a runner-env re-run of unit/e2e/replay is green; python pytest 131 passed. |

## files_changed

None. No tracked file was modified, added or deleted, and no commit was made.
- `git status --porcelain=v1` is empty, and `git diff --exit-code` exits 0.
- HEAD is still `8d3f6cb3b86615efb8e6badd9cd298ace79f6a51`.

The data-gateway integration suite builds `apps/data-gateway/dist/` during its run. That
directory is ignored (`.gitignore:4 dist/`) and was absent before the run, so I deleted it
afterwards. `git status --porcelain=v1 --ignored`, excluding `node_modules`, is empty again.

The only files written are scratch files, under
`/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/bracket-1a/r3/`:
- `ci-mirror.sh`, `ci-status.txt`, `ci-NN-*.log`
- `ghenv-*.log`, `py-*.log`, `pyvenv/`, `sb-suite.log`, `pkt-typecheck.log`

## tests_run

Everything ran in `/home/adriancova/proyects/tradeBot/polymarket-bot-bracket-1a` at HEAD
`8d3f6cb3b86615efb8e6badd9cd298ace79f6a51`, clean. Every pnpm command had
`pnpm_config_verify_deps_before_run=false`. Docker was available (`29.1.2`) and Node was
`v24.13.0`. Mirror start: 2026-09-28T03:58:30-06:00.

**A. Local mirror of `ci.yml` job `node`**, in step order (script `r3/ci-mirror.sh`; status
in `r3/ci-status.txt`). Every step exited 0.

| # | ci.yml step | command | result |
|---|---|---|---|
| 01 | Typecheck 1/4 | `pnpm -r run typecheck` | exit 0 |
| 02 | Typecheck 2/4 | `pnpm exec tsc -p test/tsconfig.json --noEmit` | exit 0, no output |
| 03 | Typecheck 3/4 | `pnpm exec tsc -p test/e2e/tsconfig.json --noEmit` | exit 0, no output |
| 04 | Typecheck 4/4 | `pnpm --dir test/soak/recorder run typecheck` | exit 0 |
| 05 | Lint | `pnpm lint` | exit 0, no findings |
| 06 | Dependency direction | `pnpm check:deps` | exit 0, `PASS: no cycle (F9), no upward edge (F12), no unlisted same-layer edge (F13)` |
| 07 | Unit tests | `pnpm test` | **345 files / 7529 tests** passed |
| 08 | Paper e2e | `pnpm test:e2e` | **7 / 157** passed |
| 09 | Replay goldens | `pnpm test:replay` | **3 / 17** passed |
| 10 | WAL fault injection | `pnpm test:fault` | **11 / 89** passed |
| 11 | Contract 1/4 | `pnpm --filter @polymarket-bot/polymarket-public test:contract` | **6 / 637** passed |
| 12 | Contract 2/4 | `pnpm --filter @polymarket-bot/polymarket-public test:contract:rtds` | **6 / 65** passed |
| 13 | Contract 3/4 | `pnpm --filter @polymarket-bot/binance-adapter test:contract` | **9 / 158** passed |
| 14 | Contract 4/4 | `pnpm --filter @polymarket-bot/coinbase-adapter test:contract` | **7 / 95** passed |
| 15 | Soak-harness smoke | `pnpm test:soak-smoke` | **1 / 5** passed |
| -- | Vulnerability scan | `pnpm audit --audit-level high` | NOT RUN (needs the registry) |
| 16 | Integration 1/6 | `pnpm --filter @polymarket-bot/storage-postgres test:integration` | **14 / 215** passed (Testcontainers) |
| 17 | Integration 2/6 | `pnpm --filter @polymarket-bot/event-bus test:integration` | **8 / 81** passed (Testcontainers) |
| 18 | Integration 3/6 | `pnpm --filter @polymarket-bot/research-worker test:integration` | **4 / 27** passed |
| 19 | Integration 4/6 | `pnpm --filter @polymarket-bot/data-gateway test:integration` | **12 / 94** passed |
| 20 | Integration 5/6 | `pnpm --filter @polymarket-bot/trader test:integration` | **15 / 132** passed (Docker) |
| 21 | Integration 6/6 | `pnpm --filter @polymarket-bot/control-api test:integration` | **10 / 87** passed |

No vitest summary line in any log reports a skipped, todo or failed test (the grep for
`skipped|todo|failed` on the summary lines matched nothing).

**B. The GitHub runner's environment**, simulated. With `CI=true GITHUB_ACTIONS=true TZ=UTC
LANG=C.UTF-8 LC_ALL=C.UTF-8`:
- `pnpm test`: **345 / 7529**
- `pnpm test:e2e`: **7 / 157**
- `pnpm test:replay`: **3 / 17**

All exited 0. This is the second run of e2e and of replay. `TZ=UTC` shows that the
regenerated paper golden and backtest artifact do not depend on the local timezone
(`-06:00`). `CI=true` shows that no changed test relies on writing snapshots: no changed test
file uses `toMatchSnapshot`, `child_process` or `process.env`.

**C. The packet's remaining spellings:**
- `pnpm run typecheck` (the root `&&` chain): exit 0, 0 `error TS`.
- The static-bracket suite on its own,
  `pnpm exec vitest run --config test/vitest.config.ts test/unit/strategies/static-bracket`:
  **14 files / 375 tests**, exit 0.
- `pnpm run lint`, `pnpm run check:deps`, `pnpm run test` and the two integration filters
  are the same commands as A05/A06/A07/A20/A21.

**D. The `python` job**, run offline in a scratch environment:
- `UV_PROJECT_ENVIRONMENT=<scratch>/pyvenv uv sync --frozen --offline`: exit 0, resolved from
  the local uv cache.
- `uv run --frozen --offline pytest -p no:cacheprovider`: **131 passed**, exit 0.
  `PYTHONDONTWRITEBYTECODE=1` and `-p no:cacheprovider` kept any cache out of the worktree.
- `pip-audit`: NOT RUN (needs the network).

**E. The `compose` job:**
- `docker compose config --quiet`: exit 0.
- `up -d --wait`, `exec` and `down`: NOT RUN. `docker-compose.yml` pins `name:
  polymarket-bot-dev` and fixed container names. The user's volumes
  `polymarket-bot-dev_postgres-data` and `polymarket-bot-dev_redis-data` already exist on
  this machine, so `up` would mount the user's dev database, and `down` would remove
  same-named dev containers.

**F. Inputs of the network steps are byte-identical to base.** `git diff --quiet f034c0b 8d3f6cb
-- pnpm-lock.yaml pnpm-workspace.yaml package.json '**/package.json' python
docker-compose.yml .github .npmrc tsconfig.base.json eslint.config.mjs` exits 0. No changed
path lies under `python/`, `infra/`, `db/`, `.github/` or `tools/`. Nothing under `python/`
references any path this package changed (grep for `replay-golden|paper-e2e|
expected-artifact|static-bracket|health.ts|RISK_SEAM|apps/trader|packages/strategies` found
nothing).

**G. The merge ref's tree.** Local `main` and the last-fetched `origin/main` are both
`f034c0b`, an ancestor of the candidate (`git merge-base --is-ancestor main 8d3f6cb` exits
0). If `main` has not moved on GitHub, a PR's merge ref therefore has exactly the
candidate's tree. I did not fetch, so this is unverified against the live remote.

## assumptions

- The GitHub CI run is the orchestrator's action under the standing process (a PR per round;
  CI runs on the merge ref), and the implementer must not push or open a PR, as this packet
  says.
- A local mirror on the same Node major (24) and pnpm (11.17.0) is the closest evidence
  available offline. The hardlinked `node_modules` stand in for a frozen install from the
  unchanged lockfile. I did not run `pnpm install`, as the packet forbids it.
- `origin/main` on GitHub is still `f034c0b` (G). If it has moved, the merge ref's tree
  differs from the candidate's, and CI tests that merge.

## deviations

- **No commit this round** (remediation step 6 asks for one commit on top of `8d3f6cb`).
  - The only finding requires no repository change, and the mirror found no CI-only gate
    that fails.
  - An empty commit would change no byte of the tree. It would move the head SHA that the
    owed GitHub run must certify, and add a content-free entry to `main`'s history on merge.
  - The candidate therefore stays `8d3f6cb3b86615efb8e6badd9cd298ace79f6a51`. If the
    orchestrator wants a round-3 commit regardless, `git commit --allow-empty` on
    `bracket-1a` would add one with an identical tree.
- **No pin for BR3-M1** (remediation step 4). The finding concerns missing CI evidence, not
  behaviour, so there is nothing whose absence at `8d3f6cb` a test could detect.
- **Mirror steps modified or not run:**
  - `pnpm audit`, `pip-audit`, the frozen `pnpm install` and a network `uv sync`: not run
    (no network).
  - The compose job's `up`/`down`: not run (it would mount the user's dev volumes).
  - The python job ran with `--offline` and a scratch environment.

## known_risks

- **BR3-M1 stays open until a real GitHub run is recorded.** A local mirror is not GitHub.
  Remaining differences:
  - the runner performs a fresh `pnpm install --frozen-lockfile`;
  - runner speed can matter for Testcontainers and the timeouts in `soak-smoke` and the
    integration suites;
  - the two audit steps read the live advisory database, so they can go red independently
    of any commit. The lockfiles are unchanged, so such a failure would equally hit `main`.
- **The same pre-existing residuals remain, all disclosed.** The verifier reproduced the
  live take-profit cancellation race again at base and at candidate (entry 30 → take-profit
  OPEN → late entry 20 → take-profit SELL 10 → PAUSED). Also still outside the corrected
  guarantees: the live-entry-in-OPEN limitation, and the id-less reduction first observed
  terminal. None is a round-3 finding, and none changed this round.

## follow_up

For the orchestrator, to close BR3-M1:
1. Push `bracket-1a` at `8d3f6cb3b86615efb8e6badd9cd298ace79f6a51`.
2. Open a PR against `main`.
3. Record the run id and the conclusion of all three jobs (`node`, `compose`, `python`) for
   head `8d3f6cb`.
4. If `main` has moved since `f034c0b`, confirm that the merge ref's tree differs from the
   candidate only by `main`'s own commits.

If the GitHub run goes red on a step this mirror passed, the step log is the new finding for
a round 4. The audit steps are the likeliest source, and they are independent of this diff.

Unchanged queue: `BRACKET-1b` (the two-bracket e2e, the reconciler redesign,
`RECON2-EVENTHOP`) and `BRACKET-1c` (a durable round trip), per R1. The §7 item 1 closure is
not claimed.

## commit_sha

`8d3f6cb3b86615efb8e6badd9cd298ace79f6a51`. This round made no commit; this is still the
candidate, and it is what the GitHub run must certify.
