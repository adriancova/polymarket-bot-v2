# CAP-1: a filled order's capital never vanishes from the cap check or the loss limits

**Status:** Complete (2026-10-04). Merged `b72acc7` (PR #63; CI run `37253345634` green). It closes `CAP-OVERSHOOT`. The accepted residuals are in `CAP1-RESIDUALS`.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 4 on `2712d6d`.
**Base:** `a8b733e`. The branch merged `main` at `d88624f` before the PR.
**Paths:** `packages/trading-core/**` and `packages/risk/src/**`. No golden moved.
**Posture:** PAPER only.

## summary

1. **The defect.**
   - An order's allocator reservation was released at its FILLED view: in the terminal arm of `#deliverOrderViews`, in `#releaseSettledReservations` and in `#releaseSettledOwn`.
   - Its fill was booked only at the next harvest point, so every evaluation in between counted neither.
   - The `CADENCE-1` probe R4-CAP admitted three BUYs totalling 10.20 pUSD under an 8 pUSD cap.
   - The defect predates `CADENCE-1`.
2. **Caps, at one choke point: `AllocatorGate#buildState`.** It builds the account for every evaluation (check 14's verdict and check 15's snapshot) and for every `applyForPlan`. Each planned order's commitment moves through four states:
   - **Reserved:** limit × shares.
   - **Converted** as each fill is booked. A working order counts at exactly its reservation, never reservation plus position.
   - **Settled** at the terminal view: exactly the unused remainder is released (WP-270 decision 5), and fills no position carries yet are kept.
   - **Closed** once the whole final size is booked.

   Also fixed:
   - partial fills were counted twice;
   - a partly sold covered SELL made the account impossible to rebuild;
   - unattributed fills and refused postings lost their capital from every cap.
3. **Risk checks 16 and 17** (the orchestrator's ruling, 2026-10-04).
   - A new, separate input, `unbookedFills`, is derived from the same commitments (`AllocatorGate.unbookedExposure`).
   - Checks 16 and 17 count it exactly like a booked position. It is never a sellable position (§6 invariant 10) and never an open order (check 18).
   - Where counting it "as booked" could lower a measure (check 17, and check 16's resolution limit), the larger value is compared (OBS-2).
4. **Fill prices.** Every fill page the loop reads is price evidence (`#readFills`).

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 0 | `13994b9` | (stopped) | Checks 16 and 17 have the same window. The orchestrator ruled them in (`eaa0dae`) |
| ruling | `651d258` | — | `unbookedFills`, checks 16 and 17 |
| 1 | `651d258` | CHANGES REQUIRED | GATE-1 HIGH: the property blocked the event loop past vitest's timeout. MEDIUMs: a terminal unsettled reservation; booked partials counted twice in risk; terminal unbooked fills priced at the limit |
| 2 | `0c75a17` | CHANGES REQUIRED | R2-01 MEDIUM: delayed fills over-refused |
| 3 | `2712d6d` | CHANGES REQUIRED | Fixed point on R2-01 half (ii). The orchestrator ruled (C), accepting it as `CAP1-TIER1-LIMIT-PRICE` (`117729e`) |
| 4 | `2712d6d` | **ACCEPT** | none; LOWs and INFOs |

## tests_run
- **Gates** (the implementer's final run; the verifiers re-ran them each round), all exit 0:
  - typecheck, lint and check:deps (99 edges);
  - unit: 485 / 11034;
  - e2e: 9/216;
  - replay: 3/19;
  - integration: trader 40/291, event-bus 10/112.
  - No golden moved, and the throughput decision digest is unchanged.
- **Properties:**
  - the loop property (90 seeds, 3,586 risk evaluations, 8,499 evaluations in total) holds the cap check and checks 16 and 17 to the venue's floor at every evaluation;
  - a 3,000-state risk property shows the measures never fall below the booked-only ones.
- **Mutation:** 31 of 31 killed.
- **At base:** the R4-CAP regression and 20 of the 134 tests in the touched files fail.
- **CI:** GitHub CI on the PR #63 merge ref was green before the merge.

## deviations
- **The orchestrator's rulings,** recorded in the brief: checks 16 and 17 in scope; (C); OBS-2 as an interim rule.
- **`unbookedFills` is optional in the risk schema.** If it is absent, the measure is exactly the pre-CAP-1 one, so existing callers are unchanged.

## known_risks
- **`CAP1-TIER1-LIMIT-PRICE`.** It is a fail-closed over-refusal, bounded by (limit − price) × shares, on Tier 1 only. The shipping Tier-0 composition never reaches it.
- **OBS-1, pre-existing.** An unbooked SELL fill can let check 17 and check 16's resolution limit admit what a booked control refuses. A risk ADR is owed before any mode above PAPER.
- **CAP1-R4-FABLE-01 (LOW).** A fill booked UNATTRIBUTED is counted twice against collateral, but once against the caps. It is unreachable in PAPER, because the same booking latches a halt and nothing releases it in-run. It matters once `WP-290` or a live composition can release a halt.
- **INFO:**
  - `AllocatorGate.metrics()` reads commitments as settled, a caveat for the health display;
  - mutant X6 survives both properties and is killed only by a WORKING pin, a coverage gap;
  - stale "awaits the orchestrator's ruling" wording in two comments and a test name.

## follow_up
1. **`WP-290` or the composition round:** CAP1-R4-FABLE-01.
2. **A pre-live risk ADR:** OBS-1 and OBS-2.
3. **A `packages/simulation` round, if Tier 1 ships:** observe and cancel answers carry fill economics.
4. **A trading-core test touch:** the X6 working-page property arm, and the stale wording.

## commit_sha
`2712d6d`
