# OMS-QTY: one executable quantity on the 0.01 grid (ADR-034 R1, D2; `CO3-N1`)

**Status:** Complete (2026-10-08). Merged `9df10c7` (PR #89; CI run `37873083097` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 1 on `0e71bbe`.
**Base:** `5ed023a`.
**Paths:** ADR-034's plan, row R1:
- `packages/execution-planner/**`, `packages/oms/**`;
- `packages/polymarket-secure/src/venue-client.ts`;
- Static Bracket's `params.ts`;
- the tests and fault suites it names.

## summary
1. **One quantizer** in `packages/execution-planner/src/quantity.ts`.
   - It holds A F-99's precision table, and refuses an unknown tick size with the new code `PLAN_TICK_SIZE_UNSUPPORTED`.
   - It floors shares or pUSD to 0.01 exactly, with no `number`, and records `unexecutableRemainder` with reason `SUB_GRID`.
   - It refuses a quantity that floors to zero with `PLAN_BELOW_MINIMUM_ORDER_SIZE`.
   - Each leg is quantized once, so the cost checks, slicing, reservations and estimates see the executable quantity.
2. **The OMS checks and never rounds.**
   - The ticket door refuses an off-grid ticket with `OMS_SIZE_OFF_GRID`, before the PLANNED row and before `reserve`. This covers submit, batch and staged replacements.
   - `identityMismatch` requires the signed `makerAmount` and `takerAmount` to be exact, for GTC and GTD BUYs and SELLs.
3. **The signing adapter** refuses an off-grid size before the SDK runs. Its cross-check is exact, with no rounding tolerance.
4. **Static Bracket** refuses an off-grid `size_shares`, `minimum_fill_shares` or `maximum_position_shares` at load.
5. **The mock venues book what was signed.**
6. **The closeout's probe E01 is a regression in both arms:** 5.009 is refused at the ticket; the planner makes 5 with a remainder of 0.009; the order signs 5000000; reconciliation resumes with no break.
7. **FAK and FOK** follow the orchestrator's ruling of 2026-10-08.
   - The collateral quantizer input and `collateralBuySignedShares` are built and unit-tested, but nothing is wired to them.
   - The adapter and `identityMismatch` still refuse FAK and FOK.
   - Their rows land in `TIF-COLLATERAL`.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `0e71bbe` | **ACCEPT** | none. Astra's MEDIUM CX-OMS-QTY-R1-01 was agreed down to LOW at reconciliation, because it predates this round. Also LOW FQ-1 and FQ-2, and INFO FQ-3 to FQ-6. |

## tests_run
- **Gates:**
  - typecheck, lint and check:deps;
  - unit: 12,366;
  - e2e: 216;
  - replay: 19, with the goldens byte-identical;
  - contract: 1,189;
  - fault: 1,127;
  - trader integration: 409, with one Testcontainers port-bind flake that passed when re-run alone;
  - control-api integration: 310;
  - ops-cli integration: 6.
- **Proof:** the pins fail at `5ed023a` (124 of 311 unit pins, 7 of 35 contract pins, 8 of 23 live pins). All 25 named mutants are killed.
- **CI:** the PR #89 merge ref was green before the merge.

## known_risks
- **A latent PAPER change:** an off-grid planned quantity now floors.
  - The cost ceilings judge the floored quantity: 100.009 at 0.48, against a ceiling of 48, now plans 100 (FQ-6).
  - An exit from an off-grid position plans the floored amount. Its residue is on the plan, but not yet in the strategy's state; that is D4.3, in R3.
  - No shipped configuration or golden reaches this.
- **An unknown tick size now refuses every plan.** `trading-core`'s configuration still accepts it, and an off-grid `maxSliceShares`, at load (FQ-5). This fails closed.
- **LOW CX-OMS-QTY-R1-01:** `trading-core/src/loop.ts:2943-2947` counts `plansRefused` but drops every planner refusal code and its details. This predates the round.
- **LOW FQ-1:** a mutant that floors the adapter's quote survives. `identityMismatch` is a pinned second guard.
- **LOW FQ-2:** `checkMinimumOrderSize` throws on non-canonical input, against its module's "total" claim.

## follow_up
1. **`OMS-VENUE-TIME`, then `TIF-COLLATERAL`,** after `COMPLEXITY-1`. R3 adds:
   - the FAK and FOK rows;
   - the conversion of D4.1;
   - D4.3's residuals.
2. **A trading-core round:**
   - a load-time door for the tick size and `maxSliceShares` (FQ-5);
   - surface planner refusal codes (CX-OMS-QTY-R1-01).
3. **Small fixes:** FQ-1's discriminating test and FQ-2's input validation, in the next round granted these paths.
4. **ADR-034 Open item 4:** the durable columns for the remainder and the link's two quantities (needs a migration).

## commit_sha
`0e71bbe`
