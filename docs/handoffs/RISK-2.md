# RISK-2 completion record — protective-reduction recognition (GOV-2B B2)

**Merged:** `133eac1` (`--no-ff`, 2026-09-15). Two commits on base `345f4e0`:
`31995e4` (the disposition fix) → `0de684c` (the chain completion). Review r1
**ACCEPT** (4 LOW, 3 INFO; none blocking).

**Acceptance MET:** the golden reaches `realizedPnl "-1.2"` through a complete
entry→exit round trip, `capitalCommitted "0"`, `risk: approvals 4 / refusals 0 /
refusedExits 0`, `test:e2e` green at 6 files / 78 tests.

## The defect

`static-bracket` emitted protective exits as POSITION (`decide.ts:770/1614/1798`);
`packages/risk` classified POSITION as ENTRY (`intent-view.ts:147`);
`engine.ts:594-612`'s entry-only positive-net-edge gate then refused the exit for a
missing `expectedNetEdge` **an exit can never declare**. The committed golden
recorded the consequence: `refusedExits 1`, `RISK_EDGE_INPUTS_MISSING`,
`realizedPnl "0"`. Queued as a follow-up by WP-220, WP-230 and WP-250 (F1) and
never executed.

## What shipped

1. **Design (b), consumer-side.** A `POSITION` resolving to a SELL **fully
   covered** by the confirmed holding of the same `(marketId, side)` is an
   `EXIT`; anything with a BUY leg, an over-held sell, and every `QUOTE`/`BASKET`
   stays `ENTRY`. **No tag is read** — `packages/risk` reads no tag content, and
   `apps/trader/src/pipeline.ts`'s rule that a composition root may not re-derive
   disposition from tags is untouched. `packages/risk/src/engine.ts` is unchanged
   on the branch: every `isEntry` exemption the exit now takes was already
   specified before this round; RISK-2 changed only which intents take it.
   **(a) was rejected on evidence the repository already had**: §7.7's
   `ReducePositionIntent.targetShares` is a per-market sell-down level that
   `execution-planner`'s `buildReductionPlan` applies to BOTH sides reading only
   `minimumSellPrice`, so it cannot express a single-leg exit that BUYS, and it
   acts on inventory the emitting instance never created.
2. **Three defects B2 had masked**, because nothing downstream had ever executed
   an exit: the exits named no venue order type (a `MAKER_ONLY` take-profit
   inherited the entry's `FAK`, and the venue refused it as unable to REST);
   `legBaselineShares` was derived from a view that LEADS the fill stream, so a
   batched first fill trapped an instance holding a position it could no longer
   exit; and `loop.ts:1095` pushed `intentIdOf`'s `""` for a CANCEL into §9.8
   check 18's duplicate-guard list, so the **first approved safety cancellation**
   poisoned it and every later evaluation was refused `RISK_INPUT_INVALID`.
   Fixed **at the caller** — the door was NOT relaxed, since admitting `""` would
   make check 18 match id-less CANCELs against each other, which §6 invariant 13
   forbids.
3. **A defect in the evidence itself.** `test/e2e/support/reconcile.ts` computed
   its `entry.*` rows over **all** `artifact.fills`, so with a SELL fill present
   it would have reported Σ(BUY 50 + SELL 50) = 100 shares as the ENTRY's and
   labelled it `EXACT_NO_DIFFERENCE` — a row arithmetically wrong while wearing
   "explained". Entry quantities are now attributed **by id** down the §6
   invariant 4 chain (intent → trace → plan → order → fill), never by `action`.
   An absent `virtualPositions` line is read as an explicit `"0"`, a convention
   proven from `packages/ledger/src/projections.ts:364-366/:380-382` (the key is
   deleted when the balance is zero), and the falsifiability tamper now corrupts
   both a present and an absent line — the old tamper had gone **silently
   vacuous** once the position closed.
4. `PROTECTIVE_EXIT_REFUSED_AT_RISK_SEAM` **deleted** — B2 written as prose, every
   clause now false, and a named mechanism is a claim. `EXIT_BELOW_TAKE_PROFIT`
   and `RESTING_EXIT_CANCELLED_UNFILLED` added; the sole consumer updated.
   **No risk reason code added, removed or renamed** (62 at base and at tip,
   `diff` empty).

## What the review established independently

- **Every changed golden number derived from the three fills**, not accepted:
  realized `16 − 17.2 = −1.2`; fees `0.131 + 0.089 + 0.212 = 0.432`; `coreNetPnl
  −1.632` = the collateral line; and the `expected_net_edge` decomposition
  `−9.332` = `EXIT_BELOW_TAKE_PROFIT (−9)` + `FEE_MODEL_BASIS (−0.332159)` +
  `FEE_ROUNDING_HALF_UP (+0.000159)`, residual `"0"`. The byte-identity of
  everything that should not have moved was confirmed structurally.
- **The golden is a capture, not a patch**: `determinism-golden.test.ts` passes,
  so two fresh in-suite runs are byte-identical to the committed artefact.
- **Fourteen disposition probes**: over-held by one ulp, other market, other
  side, absent/zero holding, exact equality, absolute targets above and below,
  two summed lines, QUOTE, BASKET, BUY. Exact decimal comparison
  (`ExactDecimal.cmp`), not float, not string; a non-canonical string is
  unreachable through the door.
- **The portfolio view cannot be lied to**: traced to `loop.ts:1691-1720`
  `#positionsFor`, which filters the §6-invariant-7 ledger projection to the
  instance's own attributed position. A strategy would have to forge ledger
  postings.
- **The boundary is not decorative**: mutating `<= 0` to `< 0`, or removing the
  coverage predicate, each fails 4 committed pins. **The entry gate is unmoved**:
  mutating `engine.ts:606` fails 5 pins.
- **The reconciler's by-id walk is real**: `action` appears once, in a comment;
  swapping every BUY/SELL label produces a **byte-identical** table (the
  complement case); breaking the chain throws rather than reconciling an empty
  set; and the two deliberate breaks (entry rows over all fills; absent line read
  as non-zero) fail 7 and 3 tests respectively.
- Non-vacuity reproduced exactly: **13 unit / 15 e2e / 10 trader-integration**
  failures against the base sources, with the claimed names.

## Gates at the merged tip `0de684c`, and on `main` at `133eac1`

`typecheck`, `lint`, `check:deps`, `audit` 0; `pnpm run test` **326 files / 7129
tests**; `test:e2e` **6 / 78**; `test:replay` 2 / 9; `test:fault` 11 / 89; trader
integration 10 / 113 (Docker); storage-postgres integration 14 / 215.

## Residuals (owned)

1. **Residual 5 — the round trip ends PAUSED.** `planProtectedReduce` creates no
   order track, so when the reduction FILLS the strategy cannot name it:
   `SB.UNATTRIBUTED_FILL` → `SB.POSITION_MISMATCH` → `SB.NO_BLIND_FLATTEN` →
   `SB.PAUSED`. **This is NOT §6 invariant 7 unattributed activity** — verified
   against the invariant's text and the golden's own ledger
   (`unattributedActivity 0`, `unexplainedMovements 0`, no `UNATTRIBUTED` posting,
   `halts []`, `healthy true`, every record `VIRTUAL_STRATEGY`); the money is
   right and the pause is strictly AFTER the exit is booked. **But an instance
   that pauses on its own exit cannot open a second bracket, so GOV-2B §7
   checklist item 1 is NOT closed by this round.** The honest statement is: *one
   bracket, one round trip, closed by the cutoff reduce, ending PAUSED.* Pinned
   as residual 5 so it fails the day it is fixed. **In-grant for
   `packages/strategies/static-bracket/**` — the deferral is a scope judgement,
   not a path constraint.**
2. **`RISK2-R2` — `RISK_SEAM_CAVEAT` is a false statement PUBLISHED on the health
   surface.** `apps/trader/src/health.ts:58-66` still calls B2 the "WP-220
   accepted residual" and says protective reductions "are therefore refused"; it
   ships on every `HealthSnapshot` and through the control API. Out of this
   round's grant, disclosed at the pin site. **Must be scheduled before any
   operator-facing surface is trusted** — it is the one artefact a human reads
   that still describes B2 as the accepted posture.
3. **`RISK2-R1`** — `apps/trader/src/pipeline.ts:99-103`'s RULE is intact, but its
   justifying premise ("`packages/risk` decides disposition from the intent TYPE")
   is now superseded. Doc-only; the one drift the round did not disclose.
4. **`RISK2-R3`** — the reconciler's exit set is the *complement* of the entry
   set and only the FIRST `enter` decision is read. Exact for this one-bracket
   scenario; a second entry's fills would be summed into `exitProceeds`, and an
   entry order cancelled unfilled would report as `exit.cancelled_proceeds.*`.
5. **`RISK2-R4`** — the reconciler's FIFO fold relies on array order, not on
   `atEventIngestSeq`. Vacuous today (`openCostBasis` is exactly `"0"`); a partial
   exit would make `pnl.capital_committed` order-dependent.
   *(Items 4 and 5 CLOSED 2026-09-26 by `RECON-1`, merged `de58d83`; record
   `docs/handoffs/RECON-1.md`. That round also found the fold was FIFO while
   `packages/pnl` is average cost, and aligned it.)*
6. **`RISK2-R6`** — the golden's take-profit is cancelled and never re-emitted
   (the scenario delivers no further `onFeatures` before the exit cutoff), so
   **the repository still has no evidence that a take-profit can FILL.** A
   scenario limit, honestly named in the reconciliation, not a misstatement.
7. `RISK2-R5` an obsolete four-row table retained in the static-bracket README;
   the complement-leg reclassification (a strategy that establishes exposure by
   selling a token it holds is now also an EXIT — sound within §9.8's own
   measures, disclosed at the site, not exercised end to end); and `planEntry`
   tagging `immediate_order_type` unconditionally, so a PASSIVE entry hits the
   same order-type collision the exits just escaped.

## Follow-ups (owned)

- **Residual 5**, with the §7-item-1 dependency attached.
- **`RISK_SEAM_CAVEAT`** (`health.ts`) and `apps/trader/README.md:158`.
- `pipeline.ts`'s premise sentence; the reconciler's exit attribution and FIFO
  ordering; the static-bracket README's obsolete table.
- Sweep for the same empty-id class — `intentIdOf` returning `""` is a pattern.
- Contract-owner question: gating a covered sale on its *directional* effect
  needs a net-directional-exposure measure §9.8 does not define.
- The PASSIVE-entry order type.
