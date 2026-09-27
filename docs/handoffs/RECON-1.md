# RECON-1: the e2e reconciler's latent traps (RISK2-R3, RISK2-R4)

Branch `recon-1` on base `5d8b24f`, merged into `main` as `de58d83`
(`--no-ff`) on 2026-09-26. The user authorized it the same day as the second
of the two RISK-2 "incidental" findings. The first, `RISK2-R2`'s false
`RISK_SEAM_CAVEAT`, had already been fixed by `BOOT-1`; only its ledger row
was stale, and that was corrected in `5d8b24f`.

| Commit | Content |
| --- | --- |
| `cb8b4be` | r0: exits attributed by id; unfilled orders by a closed-world rule; a second entry refused; the fold ordered by `atEventIngestSeq`. |
| `273ad61` | r1: the fold restates `packages/pnl`'s AVERAGE-COST method, not FIFO; oracle-independence pin; agreement pins against the real engine. |
| `301b17e` | r2: the four findings of the r1 review. The confirming review examined this commit. |
| `de58d83` | the merge. |

## summary

`test/e2e/support/reconcile.ts` is the evidence oracle. It recomputes every
number in a recorded paper run's reconciliation table from the raw artifact,
independently of the engine that produced the run. RISK-2 fixed its entry
side and left two traps. Both were exact for today's one-bracket scenario and
wrong for the next scenario.

- **`RISK2-R3`: exits were "everything that isn't the entry".** Only the first
  `enter` decision was read.
  - A second entry's fills were summed into exit proceeds.
  - A second entry's order withdrawn unfilled produced an *explained*
    `exit.cancelled_proceeds.*` row with zero unexplained rows, which is a
    fully silent misreport.
  - **Now:** every fill is attributed by id through handoff §6 invariant 4
    (intent → trace → plan → order → fill). Traces resolve by emission key
    `(runId, evaluationSeq, intentId)`, and the decision at that key decides
    the side.
  - **Refused, each naming its cause:**
    - a fill in neither chain;
    - a trace resolving to a CANCEL or other decision type;
    - more than one `enter` (option (b), argued in the code: the table has no
      bracket dimension, and the artifact has no id linking an exit to the
      entry it closes);
    - duplicate identities.
  - **Unfilled orders** have no trace, because the loop records one only on a
    fill (`loop.ts` `#harvestFills`). They use a closed-world rule instead:
    - the plan needs a compatible origin (same market, one of the scenario
      market's tokens, matching side label);
    - no possible origin may be a non-exit emission;
    - all untraced plans must be matched one-to-one to distinct exit
      emissions (augmenting paths).
- **`RISK2-R4`: the fold relied on array order.** It is now ordered by
  `atEventIngestSeq`, compared as a canonical unsigned integer, then by fill
  id with embedded numbers compared by value. Every sequence value is
  validated, including a lone fill's.
- **A third defect, found by the r0 implementer: the cost method.** The
  reconciler folded FIFO, but `packages/pnl` is average cost
  (`state.ts:27-31`). The two agree for fully open or fully closed positions
  and disagree on a partial exit: 8.7 vs 8.6 for selling 25 of 50 shares.
  - The orchestrator ruled to align the reconciler with the engine.
  - The reconciler now restates the engine's written spec:
    `divDecimal(B·q, Q)` at 34 significant digits ROUND_HALF_EVEN, the
    remaining basis by exact subtraction, and an oversell refused.
  - It does not import the engine. A compiler-API pin enforces that it
    imports only `@polymarket-bot/decimal` and `./artifact.js`.
  - Agreement pins derive the numbers by hand and confirm them against the
    real engine, which only the test calls:

    | Case | Open basis | Realized |
    | --- | --- | --- |
    | sell 25 of 50 | 8.6 | −0.6 |
    | buy 30, sell 5, buy 20, sell 25 | 6.888888888888888888888888888888889 (a non-terminating division, rounded) | −0.711111111111111111111111111111111 |

  - Worst case for the second pin: −7.6 exactly.

The committed golden is **byte-identical** (sha256 `a5368efa…`). These are
evidence-harness fixes, not behaviour changes.

## files_changed

- `test/e2e/support/reconcile.ts`
- `test/e2e/reconciliation-attribution.test.ts` (new, 39 tests)
- `test/e2e/safety-posture.test.ts`: two allowlist entries, each commented
  (see deviations).
- `test/e2e/README.md`: the file table.

## tests_run

| Gate | Result |
| --- | --- |
| typecheck, lint, check:deps | exit 0 (implementer; Codex r2) |
| unit | 331 / 7217 (implementer). The Codex sandbox gave `EPERM` on spawn and listen; the reviewer showed its failures were identical by name at base `5d8b24f`. |
| e2e | 7 files / 117 tests (was 6 / 78): implementer, orchestrator, Codex r2, and post-merge on `de58d83` |
| replay | 3 / 17 (same four runs) |
| GitHub Actions | PR #2 run `36283910613`, all three jobs green. It runs on the merge ref, so it included `CI-1`. |

**Non-vacuity:**
- r0: with base `reconcile.ts` restored, 22 of 27 new tests fail. The 5 that
  pass are positive checks by design.
- r1: with `cb8b4be`'s FIFO fold restored, 6 of 109 fail. Both agreement
  pins miss, by −0.1 and by −0.111…1.
- r2: with `273ad61`'s reconciler restored, 9 of 117 fail. The confirming
  reviewer re-ran this and listed all nine by name.
- Mutants (reproduced by the reviewer): disabling the one-to-one matching
  fails 2 pins; making every emission compatible fails 3.

## Reviews

All by Codex gpt-6-astra, independent of the implementer.

- **r1, of `273ad61`: CHANGES REQUIRED.** All four findings were *silent*
  misattributions, with no throw and a wrong row.
  - R1 (MEDIUM): candidates were counted globally, so a copied exit decision
    could prop up a phantom untraced order, and an order in another market
    was accepted as an exit cancellation (projected 17.5).
  - R2 (MEDIUM): classification by intent id alone; a QUOTE and a reduce
    sharing an id were confused.
  - R3 (LOW): the independence pin was a line regex, so a trailing-comment
    import escaped it.
  - R4 (LOW): a single fill skipped sequence validation.
- **r2, of `301b17e`: ACCEPT.**
  - The reviewer rebuilt every r1 reproduction from scratch, and each now
    refuses, naming its cause.
  - It exercised the matcher directly: an augmenting path assigns 2 of 2; a
    Hall violation assigns 2 of 3 and the artifact-level refusal fires.
  - It planted each import shape into the real `reconcile.ts`: all eight
    fail the pin, and mentions in comments and strings pass.
  - It ruled both deviations sound.
  - Two new LOW findings:
    - **SCAN-1** → `RECON1-SCAN`: `safety-posture.test.ts`'s own import scan
      has the same trailing-comment gap. Confirmed by a planted
      `node:assert` import. It predates this round and is not worsened by
      it. The reviewer noted that its path is inside this round's grant, so
      deferring it is a queueing decision, not a scope limit.
    - **ORIGIN-1** → `RECON1-ORIGIN`: a fabricated compatible exit
      re-emission can absorb a phantom untraced plan. The inspected loop
      cannot generate it.

## assumptions

- The exit side is `exit` and `reduce` decisions (the §7.5 enum). CANCEL
  intents place no orders.
- The loop builds one plan per approved evaluation (`#routeIntent`) and
  records a trace for every fill. The closed-world rule is sound only as far
  as these hold.
- Compatibility is market + scenario token + side label. The artifact carries
  neither the intent's `direction` nor its `targetMode`, and the planner may
  buy the intent's token or sell the opposite one (`leg.ts`
  `selectIncreaseLeg`), so the rule cannot be narrower.
- `atEventIngestSeq` values come from a single gateway epoch; the artifact
  has no epoch field.

## deviations

Each was disclosed; the reviewer ruled the first two sound.

- The authorization said "new pins only". `test/e2e/safety-posture.test.ts`'s
  import allowlist gained two entries:
  - `@polymarket-bot/pnl`, so the TEST can run the real engine;
  - `typescript`, for parsing only, as `test/contract/coinbase/isolation.test.ts`
    already does.

  `reconcile.ts` itself imports neither, and the parsed pin proves it.
- r0's id-level refusal ("the entry intent id is also emitted by an exit
  decision") was relaxed in r2. Under key resolution the entry's fills stay
  the entry's, and the pin asserts the correct rows. The reviewer confirmed
  them numerically: entry 50 shares, cost 17.2, exit proceeds 16.
- The cost-method change (FIFO → average cost) goes beyond the two named
  traps. It was ruled by the orchestrator mid-round.
- `test/e2e/README.md`'s file table (documentation only).

## known_risks

- `RECON1-ORIGIN`: origin by compatibility, not provenance (above).
- `RECON1-SCAN`: the e2e tree's safety-posture import scan (above).
- `RECON1-TEXT`: frozen golden prose.
  - Two `projectedSource` strings still say "FIFO"; the numbers are
    identical for every state the golden holds.
  - The `exit.cancelled_proceeds.*` text calls every exit cancellation "a
    withdrawn take-profit".
- `RECON1-EDGE`: `exit.expected_net_edge` assumes a fully closed bracket. A
  correct partial exit is reported unexplained, residual −12.5 in the pin.
  This is loud, not silent.
- When a purchase and a sale share one event, the tiebreak between them is a
  convention, not the venue's booking order.
- A two-bracket scenario, or a run with a shadow instance, will throw by
  design. Decision counting is not scoped to one instance.

## follow_up

- `RECON1-SCAN`: move `safety-posture.test.ts`'s import scan onto the
  compiler API.
- `RECON1-ORIGIN` / per-order trace data: a golden format bump, so unfilled
  orders can be attributed by id; also carry intent `direction`.
- `RECON1-TEXT`: fix the prose at the next golden regeneration.
- `RECON1-EDGE`: rule what the row means for an open bracket.
- Per-bracket reconciliation once a two-bracket scenario exists (after
  RISK-2 residual 5); consider `gatewayEpoch` on fills.

## commit_sha

`301b17e16f296ca10872f24da9c06651ff69d11d` (branch `recon-1`; chain
`cb8b4be` → `273ad61` → `301b17e`), merged as `de58d83`.
