# RECON-2: RECON-1's four residuals

Branch `recon-2` on base `9340df6`, merged into `main` as `a4d1159` (`--no-ff`) on 2026-09-26. Authorized the same day by the user ("can you handle the 9 follow ups pls?"), and run under the user's HARDENING LOOP (workflow `wf_8c301910-f61`):
1. An Opus implementer.
2. Gates run outside any sandbox.
3. Codex gpt-6-astra verification.
4. A fresh Opus remediator on any findings, repeating from step 2 until ACCEPT.

| Commit | Content |
| --- | --- |
| `7d7cafa` | r0: provenance accessor and artifact v2, attribution by id, parsed import scan, the EDGE mechanism, golden regeneration. The implementer continued uncommitted work from a predecessor the orchestrator had stopped only to change the CI-2 verifier. |
| `8db0825` | r1: every trace is bound to its own fill (`RECON2-R1`), and an empty plan identity is refused (`RECON2-R2`). |
| `a4d1159` | the merge. Its tree is byte-identical to `8db0825`. |

## Outcome

| Residual | Closed by |
| --- | --- |
| `RECON1-SCAN` | `test/e2e/support/module-specifiers.ts` parses imports with the TypeScript compiler API. It is shared by the safety-posture scan and the reconciler's independence pin, so a trailing comment no longer hides an import. |
| `RECON1-ORIGIN` | `CoreLoop.orderProvenance()` returns frozen copies of the submission-time trace prefixes; it is the only change to `loop.ts`, pinned by `apps/trader/src/order-provenance.test.ts`. The golden format becomes v2 with an `orderProvenance` section. Every order, filled or not, is attributed by id. Refused: an order with no record; a record that disagrees with a fill's trace; a trace not bound to its own fill. The closed-world inference is retired, and every RECON-1 pin was converted (the table is in Appendix A). |
| `RECON1-TEXT` | Both "FIFO" `projectedSource` strings now describe average cost. The withdrawn exit's note names the decision that placed it. |
| `RECON1-EDGE` | The orchestrator's ruling: `POSITION_OPEN_AT_RUN_END` = −(takeProfit − exitFee) × openShares, and `FEE_MODEL_BASIS` counts exit fees on exited shares only. |

**The EDGE ruling was verified independently.** Codex derived the persisted projection from `packages/strategies/static-bracket/src/decide.ts:1053` (`Q = TP×I − projectedEntryCost − (fe+fx)×I`). It showed that the residual is exactly `projectedEntryCost − N + (TP − fe − fx)×(E − I)`: zero when entry size and cost match the projection, and non-zero only for a real entry discrepancy, which should stay visible. Its numbers:

| Case | Residual |
| --- | --- |
| golden (fully closed) | 0 |
| 25 of 50 exited | 0 |
| unequal fees | 0 |
| changed entry price | −0.9, correctly unexplained |

## Golden

`a5368efa…` → `3ec3880c6021938591eaf4a2a8afb0c6ff057ae2215cc219bdd64f341841e210`. The diff holds only:
- `goldenFormatVersion` 1 → 2;
- the new `orderProvenance` section (three records);
- the two corrected `projectedSource` strings;
- the withdrawn exit's note.

The implementer and Codex each proved independently that the multiset of number-like values outside the new section is identical, and the orchestrator read the whole diff.

**Qualification (Codex r2):** the golden was rewritten more than once during the interrupted-then-continued implementation. "Regenerated once" therefore certifies the final committed bytes, which satisfy every constraint, not the literal history.

## Reviews
- **Codex r1 of `7d7cafa`: CHANGES REQUIRED.**
  - MEDIUM `RECON2-R1` (pre-existing at base, not introduced here): classification used `fill.simulatedOrderId`, but provenance was selected by `trace.venueOrderId`, and nothing joined the two through `trace.venueFillId`. Swapping two traces' submission prefixes reconciled silently. Redirecting a fill gave wrong rows (`entry.shares.realized = "100"`).
  - LOW `RECON2-R2`: an empty `executionPlanId` passed the chain walk.
- **Codex r2 of `8db0825`: ACCEPT, zero findings.**
  - Every reproduction was re-run and is refused with a named cause.
  - Restoring r0's files fails exactly the 6 new pins.
  - 26 of 26 independent probes pass (attribution, chain closure, EDGE, accessor mutation).
  - Its residual statement: the oracle proves the document is internally consistent, not that it is authentic. Consistently fabricated linked records remain attributable by design.

## Evidence
- Verification gates at `8db0825`, outside any sandbox:
  - typecheck 0;
  - lint 0;
  - check:deps PASS;
  - unit 333 / 7224;
  - e2e 7 / 157;
  - replay 3 / 17;
  - trader integration 14 / 129 (Docker 29.1.2).
- GitHub Actions: PR #3 run `36290553896`, all three jobs green.
- Post-merge on `a4d1159`: e2e 7 / 157, replay 3 / 17.

## Observations queued (new, not part of the nine)
- `RECON2-LOOPMEM`: the loop's per-order and per-fill maps are never pruned, so memory is unbounded over a long process.
- `RECON2-DURABLE`: unfilled-order provenance is not persisted, so a restart loses a cancelled order's link to its intent.
- `RECON2-EVENTHOP`: a fill from a loop-originated evaluation would carry an empty `sourceEventId`, which the e2e chain walk's event hop would report as broken.
- `RECON2-README`: stale "Running it" text in `test/e2e/README.md`.

## commit_sha
`8db0825754946001fd20141deb8513d1ff3e1f9c` (branch `recon-2`), merged as `a4d1159`.

---

# Appendix A — implementer handoff, r0 (verbatim)

# RECON-2 r0 handoff

## plan (written before editing; continuation implementer)

I took over from an implementer the orchestrator stopped after about 15 minutes. I reviewed its uncommitted
work against the packet. I ADOPT its plan (kept below, lightly amended) and own the whole result.

What I found in the partial work, and what I did with it:

- `apps/trader/src/loop.ts`: +20 lines, the one accessor `orderProvenance()` and its doc comment, and nothing
  else. KEPT. Verified with `git diff --numstat 9340df6` (20 added, 0 removed, one hunk).
- `apps/trader/src/order-provenance.test.ts` (new): KEPT. I ran it, and ran a mutant against it (see
  tests_run).
- `test/e2e/support/module-specifiers.ts` (new) and the `safety-posture.test.ts` rewrite: KEPT.
  `reconciliation-attribution.test.ts` still had its own private copy of the walk; I switched it to the shared
  helper.
- `support/artifact.ts`, `support/chain-walk.ts` and `support/reconcile.ts`: KEPT after a line-by-line review,
  with small additions. Both now refuse (or report) a format-1 artefact by name, and `reconcile.ts`'s doc gained
  one refusal bullet.
- The golden had ALREADY been rewritten mid-work. I restored it to `9340df6` and regenerated it ONCE, at the
  end, per the README protocol.
- NOT DONE by the previous implementer, and done here:
  - the pin conversion;
  - the EDGE pins;
  - the provenance pins in both traceability tests;
  - both READMEs;
  - the golden proofs, the non-vacuity run, the gates and the commit.

Prerequisites I verified:
- RECON-1 is merged (`de58d83`).
- The `RECON-2` row is Ready/authorized.
- The branch is `recon-2` at `9340df6`.
- `node_modules` is present.
- Docker answers (29.1.2).

## summary

Commit `7d7cafa5b1c9ccad2536c99ccbf174d81f22966c` on `recon-2` (one commit on `9340df6`). All four items are
done, and every gate exits 0.

### (1) `RECON1-SCAN`
`test/e2e/support/module-specifiers.ts` is ONE compiler-API helper, `moduleSpecifiersIn(text)`. Both scans
import it:
- `safety-posture.test.ts`'s allowlist scan over every owned `.ts` file;
- `reconciliation-attribution.test.ts`'s oracle-independence pin, which no longer imports `typescript` itself.

It detects every shape RECON-1 pinned:
- `import … from`, `import type … from`;
- side-effect `import "m"`;
- `export … from`, `export * from`;
- `import x = require("m")`;
- `import("m")`;
- `typeof import("m")`;
- `require("m")`.

A computed specifier is reported as `<computed>`, which is a violation. Mentions in comments and strings are
inert.

In-suite pins cover:
- nine plants;
- the two computed forms;
- five mentions;
- a permitted import with a trailing comment;
- "both scans import the one helper, and neither imports `typescript` itself".

The manual scratch-file probe is in tests_run.

### (2) `RECON1-ORIGIN`
- **The accessor.** `CoreLoop.orderProvenance()` returns a fresh frozen list of fresh frozen copies of
  `#orderTraces`' values, in submission order.
- **The artifact.** It carries the section as `orderProvenance`, and `GOLDEN_FORMAT_VERSION` is 2.
- **The reconciler.** `attributeByProvenance` resolves EVERY order, filled or not, through its own record to the
  emission `(runId, evaluationSeq, intentId)`. Refused, each by name:
  - a format-1 artefact (no section);
  - an order id booked twice;
  - two records for one order;
  - an orphan record (an order the venue never booked);
  - **an order with no record**;
  - a record whose plan is not the booked order's;
  - a record naming an emission no decision made;
  - a record naming an emission that could not have placed the order;
  - a non-entry, non-exit emission (a QUOTE, a CANCEL, a `hold`);
  - one plan naming two emissions, or one emission claimed by two plans;
  - a fill on an unbooked order;
  - a trace naming an order with no record;
  - **a trace that disagrees with its order's record on any of the 8 shared fields** (named per field);
  - an order that reports filled shares with no trace.
- **Retired:** the closed-world inference (`untracedExitOrders`) and the matcher (`assignableCount`). Two
  cross-checks are kept, argued in the code:
  - compatibility (`couldHavePlaced`), now a test of the emission the record NAMES;
  - one plan per emission, both directions. It is the matcher's surviving content, and it refuses a
    fabricated record that borrows an emission a real plan holds.
- **The chain walk.** `support/chain-walk.ts` treats every record as a node:
  - `PROVENANCE_UNRESOLVED`: decision, intent, feature snapshot, source event, distinct ids, booked plan;
  - `ORPHAN_PROVENANCE`;
  - `ORDER_WITHOUT_PROVENANCE`;
  - `PROVENANCE_ORDER_NOT_UNIQUE`;
  - `PROVENANCE_TRACE_MISMATCH`;
  - `PROVENANCE_SECTION_MISSING`.

  The walk stays total.
- **RECON-1's pins** are converted, not deleted. The table is under tests_run.

### (3) `RECON1-TEXT`
- **The two projectedSource strings.** Both now describe the average-cost fold.
- **`exit.cancelled_proceeds.*`.** The `quantity` names what was withdrawn: "a withdrawn take-profit" (an `exit`
  decision placed it) or "a withdrawn protective reduction" (a `reduce` decision). The note names the placing
  decision, its `evaluationSeq` and its intent, from the provenance record.
- **What the golden shows.** The golden's own row IS a take-profit, so its `quantity` bytes are unchanged; its
  note changed. The protective-reduction wording is pinned on synthetic artefacts.
- **`MECHANISMS.RESTING_EXIT_CANCELLED_UNFILLED.detail`** is generalised. It is not in the golden.
- **`test/replay-golden/paper-e2e/README.md`.** Every sentence was verified against the golden before it was
  changed. Corrected:
  - the consumer list, which now includes `reconciliation-attribution.test.ts`;
  - the `test:e2e` wiring sentence (wired in `da37a0c`);
  - the section table: `traces` is one per fill, and `orderProvenance` is added;
  - the fills paragraph (the exit fill, and the take-profit that is on no chain);
  - the fee table (the exit fill, `0.21216` rounded to `0.212`, and totals `0.432159` / `0.432`);
  - **the ledger**: it said collateral `−17.42`, token line `50`, six transactions. It is `−1.632`, no token
    line, nine transactions.
  - **the PnL**: "the final snapshot" was really the second. The final snapshot's values are now derived.
  - **"The projection with no realized value"**: it said the edge is "never realized" and refused at the risk
    seam, which has been false since RISK-2. It is replaced by the round-trip decomposition, with a line
    labelled as history. A new, correct paragraph covers the withdrawn take-profit.

### (4) `RECON1-EDGE`, the ruling, implemented as ruled
- `POSITION_OPEN_AT_RUN_END` = `−(TP − fx) × openShares`, present only when `openShares ≠ 0`.
- `FEE_MODEL_BASIS` models `fe × entryShares + fx × exitShares`.

The persisted projection decomposes exactly as the ruling assumes, so I did not STOP:
- Contributions sum to `P − TP·E + (fe+fx)·E − C`.
- The difference is `P − N − C − (TP·E − entryCost − (fe+fx)·E)`.
- The residual is therefore `(entryCost − N) + (TP − fe − fx)(E_realized − E_intent)`. That is 0 whenever the
  entry cost what it projected and filled its size, independent of X.

The 25-of-50 pin, hand-derived in its comment:

| Mechanism | Amount |
| --- | --- |
| `EXIT_BELOW_TAKE_PROFIT` | −4.5 |
| `POSITION_OPEN_AT_RUN_END` | −12.475 |
| `FEE_MODEL_BASIS` | −0.251079 |
| `FEE_ROUNDING_HALF_UP` | +0.000079 |
| **Σ** | **−17.226 = difference, residual 0** |

The pin also asserts RECON-1's decomposition of the same row left −12.5 = `TP × (X − E)`.

Further pins, each hand-derived:
- 30-of-50 (two exit fills): residual 0.
- No exit fill (the reduction withdrawn): residual 0, and the withdrawn reduction is named.
- **Per-side fees** 0.001/0.003 with projection 7.6: residual 0. The pin also shows the swapped basis differs
  (0.175 vs 0.125); with fe = fx the golden alone cannot tell the two apart.
- **An entry that cost 17.5 against a projected 17.2** stays UNEXPLAINED with residual exactly −0.3 =
  entryCost − N. The open-position term does not absorb it.
- **The golden's fully closed row** has no new term and is identical in number and word. The numeric proof
  below confirms it at golden level.

## files_changed

- `apps/trader/src/loop.ts`: the ONE accessor `orderProvenance()` and its doc comment (+20/−0, one hunk).
- `apps/trader/src/order-provenance.test.ts` (new): pins the accessor.
- `test/e2e/support/module-specifiers.ts` (new): the shared parse helper.
- `test/e2e/support/artifact.ts`: `ArtifactOrderProvenance`, the `orderProvenance` section, format version 2.
- `test/e2e/support/reconcile.ts`: attribution by provenance; the EDGE mechanism; the TEXT prose.
- `test/e2e/support/chain-walk.ts`: provenance records as nodes.
- `test/e2e/reconciliation-attribution.test.ts`: pins converted; new provenance and EDGE pins; shared helper.
- `test/e2e/safety-posture.test.ts`: parse-based scan, and the shape, mention and one-helper pins.
- `test/e2e/traceability-chain.test.ts`: +1 positive provenance pin (the run's bytes and the golden).
- `test/e2e/traceability-chain-negative.test.ts`: provenance mutations by exact finding set; `orderProvenance`
  added to the never-throws list.
- `test/e2e/README.md`: the file table only.
- `test/replay-golden/paper-e2e/README.md`: false descriptions corrected (see summary).
- `test/replay-golden/paper-e2e/paper-e2e-run.json`: regenerated once (see golden below).

## tests_run

### Gates
All run on the final tree, exit codes captured without pipes. The one exception is noted.

| Command | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm run lint` | exit 0 |
| `pnpm run check:deps` | exit 0 |
| `pnpm run test` | exit 0; **333 files / 7224 tests** (base 332/7221, plus the new trader test's 3) |
| `pnpm run test:e2e` | exit 0; **7 files / 151 tests** (base 7/117, +34) |
| `pnpm run test:replay` | exit 0; 3 / 17 |
| `pnpm --filter @polymarket-bot/trader test` | exit 0 with EMPTY output (see below) |
| `pnpm exec vitest run --config test/vitest.config.ts apps/trader/src` | exit 0; 9 files / 140 tests |
| `timeout 20 docker info` | `29.1.2` |
| `pnpm --filter @polymarket-bot/trader test:integration` | exit 0; 14 files / 129 tests |

`pnpm --filter @polymarket-bot/trader test` is a NO-OP: `apps/trader/package.json` has no `test` script. That
is why I also ran the trader's unit tests explicitly through the root runner.

The safety scan over the diff found no `eslint-disable`, `.skip`, `.only`, `ts-ignore`, `ts-expect-error`,
`process.env`, `Math.random` or `Date.now` added.

### SCAN proof
Scratch script `scratchpad/recon-2/scan-probe.sh`. For each shape it wrote the plant into
`test/e2e/zz-review-plant.test.ts`, ran only the scan test, and deleted the file.

Each of these fails the scan (exit 1), naming `zz-review-plant.test.ts: node:assert`:
- the trailing-comment named import `import { strict as reviewAssert } from "node:assert"; // review plant`;
- the side-effect import;
- `import type`;
- `export {…} from`;
- `export * from`;
- `import = require`;
- `await import()`;
- `typeof import()`;
- `require()`.

Both computed forms fail as `<computed>`. The line-comment, block-comment, string and template mentions pass
(exit 0), and so does the control (`node:fs` with a trailing comment).

Base comparison: with `9340df6`'s `safety-posture.test.ts` restored and the same trailing-comment plant, the scan
reported NO hit for the plant. Its only hits were 4 false positives on the prose table in
`module-specifiers.ts`. Everything was restored byte-identically (sha256 `2df234d2…` before and after).

### ORIGIN proofs
- **Accessor mutant.** I made `orderProvenance()` return `[...this.#orderTraces.values()]`: the loop's own
  objects, unfrozen. The "answer is a COPY" pin failed (1 of 3). `loop.ts` was restored, `sha256sum -c` OK.

### Pin conversion
Every pin in `reconciliation-attribution.test.ts` at `9340df6`. Old name → new name; ⟳ marks a pin whose
REFUSAL REASON changed.

| # | Old pin | Replacement | Property it now asserts |
| --- | --- | --- | --- |
| 1 | every golden fill is reached by exactly one chain, and the table is unchanged | unchanged | the golden partitions 2 entry fills + 1 exit fill, and the table equals the golden's |
| 2 | the withdrawn take-profit is the ONLY exit cancellation, and it is the exit's | …and its record names the exit decision | reached BY ID: its record names `(runId, 2, sb-take-profit-1-…)`, which is the `exit` decision's POSITION intent. The row's `quantity` says take-profit, and the note names the decision (TEXT). Was: closed-world deduction. |
| 3 ⟳ | remove the take-profit's intent and its row is REFUSED, not kept by complement (`no possible origin`) | …its order is REFUSED: its record names an emission no decision made | refused because the record resolves to nothing (`no persisted decision emitted that intent there`) |
| 4 | an exit fill is the exit's because a REDUCE decision emitted it… | same name | same refusal; the regex is tightened to "its order's provenance resolves to" |
| 5 ⟳ | R3a: a fill on an order whose plan NO trace names (`belongs to neither…`) | R3a: a fill on an order with no provenance record and no trace | refused for the missing record (`has no provenance record`); the message still names the fill |
| 6 | R3a: a fill naming an order the venue never booked | same | same refusal, regex tightened ("the venue never booked") |
| 7 | R3a: a fill TRACED to an intent that neither the entry nor an exit emitted (a QUOTE) | R3a: a fill whose order's record names an intent… (a QUOTE) | the synthetic now carries its record, and the trace is built from that record. Same refusal, regex "resolves to QUOTE". |
| 8 | R3b: a second `enter` decision with its own filled chain… | same | the synthetic gains its record (4 records asserted); `2 \`enter\` decisions` |
| 9 | R3b: an entry decision that emits TWO order-placing intents… | unchanged | — |
| 10 | R3c: a second bracket's entry, rested and withdrawn… | same | the synthetic gains its record; same refusal |
| 11 ⟳ | R3c: an unfilled order that no untraced intent could have placed (`no possible origin`) | R3c: an unfilled order with no provenance record is refused, and a record borrowing a held emission is too | no record → `has no provenance record`; a fabricated record borrowing the take-profit's emission → `is claimed by two plans` |
| 12 ⟳ | R3c: the take-profit's attribution is withdrawn the moment a non-exit intent could have placed it (`not an exit`) | R3c: a QUOTE emission beside the take-profit no longer clouds it; a record naming the QUOTE is refused | INVERTED by design. An unrelated QUOTE emission leaves the table equal to the golden. The refusal moves to a record that NAMES the QUOTE (`neither the entry intent nor one an exit or reduce decision emitted`). |
| 13 | R3c: an entry order withdrawn beside a filled sibling stays the ENTRY's | same | the sibling carries its record and the table equals the golden; WITHOUT the record → `has no provenance record` |
| 14 | an exit id re-emitted by a later reduce decision is a second possible origin | …: the record's KEY decides which emission placed the order | a record naming evaluation 18 is attributed, and its row says "withdrawn protective reduction" (TEXT). A record naming evaluation 9, which the real plan holds → `is claimed by two plans`. |
| 15 | the entry's intent id re-emitted by a reduce decision leaves the entry's fills the entry's | unchanged | — |
| 16 ⟳ | broken: one plan traced to two intents (`is traced to two intents`) | broken: a trace naming another intent than its order's provenance record | `disagrees with order …'s provenance record on intentId` |
| 17 | broken: a filled plan traced to an emission that is a CANCEL | broken: a filled order whose record names an emission that is a CANCEL | same refusal |
| 18 | broken: one decision emitting the same intent id twice | unchanged | — |
| 19 ⟳ | broken: one order id booked under the entry's plan and under an exit's (`reached from the entry's chain AND from an exit's`) | same name | `is booked twice` (the book is checked against itself before any record is matched) |
| 20 | broken: an entry intent with no id | unchanged | — |
| 21 ⟳ | broken: an untraced order that reports filled shares (`…no trace names its plan`, reached through the closed-world rule) | broken: an order that reports filled shares while no trace names it | given a VALID record (a distinct reduce emission), so the traced-fill rule itself fires (`no trace names it`) |
| 22 | broken: an unfilled order under a plan traced to a QUOTE | broken: an unfilled order whose record names a QUOTE | the link is the record, not a trace for an absent fill; same refusal |
| 23 ⟳ | R1: a copied exit decision cannot stand in for a phantom order's origin | same name | the phantom alone → `has no provenance record` (was `no possible origin`); the copy is still refused as a duplicate decision key. The RECON1-ORIGIN reproduction (a DISTINCT compatible exit re-emission) → `has no provenance record`. A record borrowing the take-profit's emission → `is claimed by two plans`. |
| 24–26 ⟳ | R1: an untraced order {in another market, on another token / on a token not one of its two / on YES labelled NO} has no possible origin | R1: an order {…} contradicts the emission its record names | refused by the compatibility CROSS-CHECK on the record's emission (`which could not have placed it`) |
| 27 | R2: a trace resolves by (runId, evaluationSeq, intentId), not by the id alone | R2: an order resolves by (runId, evaluationSeq, intentId)… | the sibling carries its record, so the refusal is the KEY's (`belongs to neither…`, names the exit fill) |
| 28 | R4: a single fill's non-canonical sequence is refused | unchanged | `not a canonical unsigned integer string` |

The remaining pins are unchanged in body:
- RISK2-R4 ×4;
- the comparators ×2;
- r1 PnL ×3;
- the division policy.

The independence pin keeps its body, but reads through the shared helper; `"<computed>"` became the
`COMPUTED_SPECIFIER` constant.

**RECON-1's six review reproductions, rebuilt against v2:**

| Reproduction | Outcome |
| --- | --- |
| copied exit decision plus phantom | refused (#23) |
| foreign market | refused (#24) |
| foreign token | refused (#25) |
| wrong side label | refused (#26) |
| QUOTE and reduce sharing an id | refused (#27) |
| single fill with sequence `"05"` | refused (#28) |

**New pins, in `reconciliation-attribution.test.ts`:**
- one record per order, and every trace is its record completed;
- 7 new `broken` probes:
  - an unfilled order naming a CANCEL emission;
  - two records;
  - an orphan record;
  - a plan mismatch;
  - one plan naming two emissions;
  - a trace naming an order with no record;
  - a format-1 artefact;
- delete ANY order's record (all 3 orders);
- a trace disagreeing on EACH of the 8 shared fields;
- a record naming a different, resolvable emission than its fill's trace (`trace 9, provenance 18`);
- the stated boundary (below);
- EDGE ×6.

**New pins elsewhere:**
- `traceability-chain.test.ts` +1;
- `traceability-chain-negative.test.ts` +13 (1 clean, 12 mutations by exact finding-code set with no broken
  hop);
- `safety-posture.test.ts` +2.

### Golden (sha256 `a5368efa…` → `3ec3880c6021938591eaf4a2a8afb0c6ff057ae2215cc219bdd64f341841e210`)
- **Regenerated ONCE.** From the `9340df6` bytes, restored first:
  `WP250_WRITE_GOLDEN=1 pnpm vitest run --config test/e2e/vitest.config.ts test/e2e/determinism-golden.test.ts`.
  It failed on purpose (the rewrite) and passed the other 4 tests.

**Hunk categorization** of `git diff 9340df6 -- …/paper-e2e-run.json`. Five hunks, nothing else:

| Hunk | Change | Category |
| --- | --- | --- |
| `@@ -549` | `goldenFormatVersion` 1 → 2 | FORMAT VERSION |
| `@@ -1169` | `+"orderProvenance": [...]`: 3 records (entry eval 1, take-profit eval 2 with `sourceEventId: ""`, reduce eval 9) | NEW PROVENANCE SECTION |
| `@@ -1638` | `pnl.capital_committed.projectedSource`: FIFO → average cost | CORRECTED PROSE |
| `@@ -1695` | `pnl.worst_case_resolution.projectedSource`: FIFO → average cost | CORRECTED PROSE |
| `@@ -1736` | `exit.cancelled_proceeds.…d000:g0:o0` note now names the take-profit, the `exit` decision at evaluationSeq 2 and its intent, "by its provenance record" | CORRECTED PROSE |

**Numeric-multiset proof.** Scratch `scratchpad/recon-2/numeric-multiset.mjs`, reading copies of the before and
after bytes:
- **[1]** Number-like values (JSON numbers plus whole numeric strings) outside `orderProvenance` and
  `goldenFormatVersion`: before 347, after 347. The multisets are IDENTICAL (85 distinct values each).
- **[1b]** Skipping only `orderProvenance`, the sole difference is the version field (`n:1` 10→9, `n:2` 3→4).
- **[2]** Structural check:
  - I deleted `orderProvenance`, restored the version, and reverted exactly the 3 prose fields listed above.
  - The document is then deep-equal to `9340df6`'s.
  - Every other value, and the key set, is unchanged.
  - The fully closed `exit.expected_net_edge` row is byte-identical.

**Determinism.** `determinism-golden.test.ts` without the variable, run twice: exit 0 both times, 5/5 each. The
full `test:e2e` passed again after that.

**Disclosure.** While iterating, before the official regeneration, I generated the prospective bytes with a
scratch probe (`captureArtifact` + `serializeArtifact` → a scratch file). I temporarily copied them over the
golden path to run the suite, then restored the `9340df6` bytes (sha `a5368efa…`, checked) before the single
protocol regeneration. The protocol's output is byte-identical to that scratch copy (`cmp`).

### Non-vacuity
- **Setup.** I restored `9340df6`'s `support/reconcile.ts` and `support/artifact.ts`. No adaptation was needed to
  RUN: vitest strips types, so the tests' type-only imports of `ArtifactOrderProvenance` vanish. `tsc` would
  reject that tree, which is expected.
- **Result.** With them, `test:e2e` gives **43 failed / 108 passed of 151** (4 of 7 files).
- **Restored.** Both files byte-identically (`sha256sum -c` OK: `a3e84278…`, `93b09f8a…`).

The failing pins, by cause:
- **Provenance attribution and refusal (27).** The base reconciler has no record rule, so its messages differ or
  it attributes by inference:
  - remove-intent (#3);
  - exit-fill (#4, message);
  - R3a ×3;
  - the no-record/borrow pin (#11);
  - QUOTE-no-longer-clouds (#12);
  - sibling (#13);
  - key-decides (#14);
  - broken: trace-vs-record intentId, unfilled-CANCEL, booked-twice, record-names-QUOTE, two-records, orphan,
    plan-mismatch, plan-two-emissions, trace-without-record, format-1;
  - delete-any-record;
  - disagree-by-field;
  - record-vs-trace emission;
  - R1 copied/phantom;
  - the boundary pin (note wording);
  - R1 displaced ×3.
- **EDGE (5).** 25-of-50, 30-of-50, no exit fill, per-side fees, entry cost more. The fully-closed pin passes
  under base by design: the row did not change.
- **TEXT and golden (6).** The base emits the old prose, so it disagrees with the regenerated golden:
  - determinism ×2;
  - `projection-reconciliation` "same table from the golden";
  - attribution "every golden fill…";
  - the take-profit row pin;
  - "entry's intent id re-emitted".
- **Capture (5).** The base `artifact.ts` captures no `orderProvenance`:
  - traceability "every hop … over the run's own bytes" (the walk reports the missing section);
  - "every booked order's origin resolves";
  - RISK2-R4 interleaved and both r1 PnL pins. These three fail incidentally: their `landmarks()` reads the
    captured artifact's records.

Full list: `scratchpad/recon-2/nonvacuity-failed.txt`.

## assumptions

- **One plan per emission.** The loop mints ONE execution plan per routed intent of a decided evaluation
  (`#routeIntent`: one `ids.next()` per call). The one-plan-per-emission cross-check rests on it, as RECON-1's
  matcher did.
- **Traces are completed from records.** The loop builds a trace from the record, field for field
  (`{ ...prefix, venueFillId, … }` at the fill). So the 8 shared fields must agree, and `venueOrderId` is the
  lookup key.
- **`sourceEventId: ""`.** This is the loop's value for evaluations it originates (`onFill`, `onOrderUpdate`),
  whose persisted decision carries `null`. The artifact captures it verbatim. The chain walk accepts `""` if and
  only if the decision's `sourceEventId` is `null`.
- **The edge formula.** It is read from the `entry.expected_net_edge_formula` row's documented formula
  (`packages/strategies/static-bracket`). I did not re-read the strategy source. The decomposition is verified
  against the golden's persisted 7.7 and on five synthetic artefacts.

## deviations

- **The golden had been regenerated mid-work** by the stopped implementer. I reset it and regenerated once at the
  end, and the scratch iteration copy is disclosed above. The committed diff is the one protocol run.
- **`pnpm --filter @polymarket-bot/trader test` is a no-op** (no `test` script). The trader's unit tests were run
  explicitly (9/140), as was its integration suite (14/129).
- **Small additions the packet did not name:**
  - the reconciler refuses a format-1 artefact by name;
  - the chain walk reports `PROVENANCE_SECTION_MISSING` rather than throwing (it is documented as total);
  - `EXIT_BELOW_TAKE_PROFIT`'s note names the exit kind from provenance instead of hard-coding "the protective
    reduction". The golden bytes are unchanged, because it IS the protective reduction.
- **The golden README's `test:e2e` wiring sentence was corrected.** It describes how the golden is compared
  rather than the golden itself.
- **`test/e2e/README.md`: only the file table changed.** Its "Running it" paragraph ("There is no root
  `pnpm test:e2e` script yet") and its type-checking paragraph have been stale since `da37a0c`. I left them,
  because the packet scoped README correction to the golden README. See follow_up.
- **The golden's own `exit.cancelled_proceeds` `quantity` string is unchanged.** Its order really is a
  take-profit. The TEXT correction is visible in its note, and for a withdrawn protective reduction it is pinned
  on synthetics.
- **Beyond the packet's refusal list,** I added a pin stating the BOUNDARY. A document fabricated consistently at
  every id (a new `exit` decision, plus a record, plan and order naming it) is attributed as the record says.

## known_risks

- **The boundary (pinned).** The oracle checks consistency by id, not authenticity. A fully consistent
  fabrication is attributed. Nor is an order's action checked against its intent: the artifact carries no
  `direction`, as in RECON-1.
- **One plan per emission.** A future loop path that re-plans the SAME emission (a retry or replace minting a new
  plan for one `(runId, evaluationSeq, intentId)`) would be refused loudly. It would not be misattributed.
- **Fills without traces.** A fill with no trace of its own, on an order that has traces, is still attributed via
  its order, exactly as in RECON-1. The chain walk's `ORPHAN_FILL` catches it; the reconciler does not.
- **Pre-existing, not exercised by the golden.** A FILL of an order placed by a loop-originated evaluation (for
  example, a take-profit that fills) would produce a trace with `sourceEventId: ""`. The chain walk's per-chain
  "event" hop requires a recorded event, so it would report that chain broken. The provenance walk handles `""`;
  the chain hops do not.
- **Report, do not fix: `#orderTraces` is never pruned.** Its only uses are `set` at submission (`loop.ts` ≈1316)
  and `get` at fill (≈1443). There is no `delete` or clear anywhere, so it grows by one entry per accepted order
  for the life of the process. The same holds for `#orderOwners`, `#instanceOrders`, `#traces` (per fill) and
  the loop's `#decisions` list.
- **Report, do not fix: unfilled-order provenance is not durable.** It lives only in process memory. The durable
  store port (`apps/trader/src/ports.ts`) writes `persistDecision`, `saveCheckpoint`, `appendLedgerTransaction`
  and `writePnlSnapshot`, and nothing for a trace, a plan or an order's provenance. After a restart, a cancelled
  unfilled order's link to its intent is gone. That is a §6 traceability question for cancelled orders; a filled
  order's link survives only through what the ledger postings carry.
- **CI.** The RECON-2 gate "a green CI run on GitHub" was NOT performed; pushing is out of scope for me.

## follow_up

- **The orchestrator:** push `recon-2` and obtain the GitHub CI run this package's gate requires.
- **`test/e2e/README.md`:** its "Running it" and type-checking paragraphs are stale since `da37a0c` and should be
  corrected in the next `test/e2e/**` round.
- **Traceability rounds:**
  - decide whether a trace for a loop-originated evaluation's fill should pass the chain's event hop the way the
    provenance walk does;
  - decide whether trace and provenance records (and plans) belong in the durable store (the report above);
  - bound or prune `#orderTraces` and its sibling maps for long processes.
- **A future artefact bump** could carry the intent's `direction`, so that an order's action can be
  cross-checked against its intent.

## commit_sha

`7d7cafa5b1c9ccad2536c99ccbf174d81f22966c` on branch `recon-2`, one commit on `9340df6`. Not pushed.

---

# Appendix B — implementer handoff, r1 (verbatim)

# RECON-2 r1 handoff (remediation round 1)

## plan (written before editing)

Base: `7d7cafa5b1c9ccad2536c99ccbf174d81f22966c` on `recon-2`, clean tree. One commit on top.

### RECON2-R1 (MEDIUM): bind every trace to the fill whose id it carries
- `test/e2e/support/reconcile.ts`, `attributeByProvenance`, the trace loop. After the existing record lookup
  (kept first, so existing pins keep their reasons), add:
  1. resolve the trace's fill by `venueFillId`; exactly ONE fill must carry that id (none: the venue never
     produced it; two or more: the id is ambiguous). Both are refused.
  2. that fill's `simulatedOrderId` must equal `trace.venueOrderId`, or the trace is refused. The record compared
     field for field is then, necessarily, the record of the fill's own order.
- The doc comment's refusal list gains these bullets.
- New pins in `reconciliation-attribution.test.ts`:
  - the verifier's reproduction 1 (two traces swap their submission prefixes but keep their fill ids);
  - the verifier's reproduction 2 (the exit fill is re-pointed at the entry order);
  - a trace naming a fill the venue never produced;
  - a fill id carried by two fills.
  Each has a non-vacuity precondition showing that the pre-existing checks are satisfied.
- One existing pin builds a malformed synthetic: RECON-1 r1's "fully open and fully closed" drops the exit fill
  but keeps its trace. It now uses the well-formed `withReductionWithdrawn` (fill, trace and order filledShares
  together). Its asserted numbers are unchanged. This is disclosed.
- NOT added: a fill-level "every fill has its own trace" rule. The loop legitimately leaves a fill untraced when
  its ledger posting is refused (`loop.ts` `continue` after `LEDGER_POSTING_REFUSED`), so that rule is a design
  choice, not a remediation. It stays a known risk, as it was in r0.

### RECON2-R2 (LOW, in scope): an empty plan id on a provenance record
- `test/e2e/support/chain-walk.ts`: the identity check also requires `record.executionPlanId !== ""`.
- Pin in `traceability-chain-negative.test.ts`: the take-profit's order and record both get `executionPlanId: ""`.
  It must yield exactly `PROVENANCE_UNRESOLVED` with no broken hop, and the exact finding text is asserted.
- The reconciler is left as it is for R2: attribution there is by emission key, and I argue this below.

### Proof, gates, commit
- Non-vacuity: restore `reconcile.ts` and `chain-walk.ts` from 7d7cafa, run the new pins (they must fail), and
  restore byte-identically (sha256).
- The golden needs no regeneration: no row text changes. Determinism is re-run twice.
- All packet gates are re-run with exact counts.
- One commit, `RECON-2 r1: …`, with the two trailers. Not pushed.

Deviation from the plan, found while executing: a SECOND existing pin had the same malformed shape (RECON-1 r2's
"R4: a single fill's non-canonical sequence"). It is adapted the same way; see deviations.

## summary

Commit `8db0825754946001fd20141deb8513d1ff3e1f9c` on `recon-2`, one commit on top of `7d7cafa`, not amended. It
fixes both findings, and every gate exits 0.

### Finding table

| Finding | Severity | Disposition | Pin(s), each FAILS on 7d7cafa and passes on 8db0825 |
| --- | --- | --- | --- |
| RECON2-R1 | MEDIUM | **FIXED** | `reconciliation-attribution.test.ts`, describe "RECON2-R1 — a trace is bound to the fill whose id it carries" (below) |
| RECON2-R2 | LOW | **FIXED** (in the chain walk, where the finding sits; the reconciler part is argued below) | `traceability-chain-negative.test.ts`: the `PROVENANCE_MUTATIONS` row "…order AND its record carry an empty plan id… (RECON2-R2)", and "RECON2-R2: an unfilled order's record with an empty plan id is refused by the identity rule alone" |

The RECON2-R1 pins:
- "two traces that swap their orders' prefixes, keeping their own fill ids, are refused"
- "a fill re-pointed at another order, while its trace names the order that placed it, is refused"
- "a trace naming a fill the venue never produced is refused"
- "a fill id carried by two fills, under two orders, is refused as ambiguous"

### RECON2-R1: the fix
In `attributeByProvenance`'s trace loop, the record lookup by `trace.venueOrderId` stays first, so existing pins
keep their refusal reasons. The new join follows it:

1. **The fill.** The trace's `venueFillId` must be carried by exactly ONE fill.
   - Zero: "`the trace of fill F (order O) names a fill the venue never produced`".
   - Two or more: "`fill id F, which the trace of order O names, is carried by N fills (orders …)`".
2. **The order.** That fill's `simulatedOrderId` must equal `trace.venueOrderId`. Otherwise: "`the trace of
   fill F names order O, but fill F belongs to order O2`".

Only then are the eight shared fields compared. The record compared is therefore, necessarily, that of the fill's
own order. This is what the verifier's "compare provenance selected through that verified order" asks for,
reached without reordering the existing checks.

This mirrors the loop exactly. `#harvestFills` builds a trace from `#orderTraces.get(fill.simulatedOrderId)`, so in
a run a trace's fill and its order cannot differ.

Each pin first asserts every PRE-JOIN rule through a shared helper, `tracesAgreeWithTheirOrdersRecords`:
- every trace agrees field for field with the record of the order it names;
- every order reporting filled shares is named by some trace.

This proves the refusal is the join's alone.

- **Pin 1 (the verifier's reproduction 1).** It also asserts that `walkChains(tampered).brokenHops` is exactly
  `["fill"]`: the chain walk already saw what the reconciler missed.
- **Pin 2 (reproduction 2).** The r0 reconciler reported `entry.shares.realized = "100"`, per the verifier.

The doc comment's refusal list gains the new bullet, and the "an order that reports fills has traces" section
notes that the check is now fill-bound.

### RECON2-R2: the fix
`support/chain-walk.ts`'s provenance identity rule now also refuses `record.executionPlanId === ""`. All three ids
(approved intent, plan, submission attempt) are now non-empty and pairwise distinct, as the finding message always
claimed.

The pin blanks the plan id on the withdrawn take-profit's booked order AND on its record. The two still agree, so
the "plan the booked order was not placed under" problem cannot fire, and the order is on no chain, so no hop can
see it. Result:
- the finding set is exactly `PROVENANCE_UNRESOLVED`, with no broken hop;
- the exact finding is `PROVENANCE_UNRESOLVED: <tp order id>: the approved-intent, plan and submission-attempt ids
  are not three distinct, non-empty identities`.

**Argued: why the reconciler is not changed for R2.** The verifier noted that "the reconciliation table also
remains unchanged". The finding and its minimal remediation are scoped to the chain walk, and the reconciler does
not need the rule:
- It attributes an order by its record's EMISSION KEY `(runId, evaluationSeq, intentId)`, not by plan id.
- The plan id enters only two cross-checks: record plan = booked plan, and one plan per emission. An empty string
  is still a well-defined key for both, so it cannot move an order between sides or hide one:
  - two orders under `""` naming different emissions are still refused ("names two emissions");
  - an emission held by `""` and by a real plan is still refused ("claimed by two plans").

Identity well-formedness (non-empty, distinct ids) is the chain walk's job, for chains and records alike. The
reconciler has never checked approved-intent or submission-attempt emptiness either. If the orchestrator wants
the reconciler to refuse empty ids, that is one small follow-up covering all three ids, not only the plan.

## files_changed

Cumulative scope versus `9340df6` is unchanged, all in allowed paths. This round touches 4 files, all under
`test/e2e/**`:

- `test/e2e/support/reconcile.ts` (+40/−1): the fill-to-trace join, its comments and the doc-comment refusal
  bullet. Its imports are still only `@polymarket-bot/decimal` and `./artifact.js`; the independence pin passes.
- `test/e2e/support/chain-walk.ts`: `record.executionPlanId === ""` added to the identity rule, plus a 3-line
  comment.
- `test/e2e/reconciliation-attribution.test.ts`:
  - new `walkChains` import;
  - new helper `tracesAgreeWithTheirOrdersRecords`;
  - the new RECON2-R1 describe block (4 pins);
  - the eight-field pin's comment points at R1;
  - two adapted pins (see deviations).
- `test/e2e/traceability-chain-negative.test.ts`: helper `emptyTakeProfitPlan`, one `PROVENANCE_MUTATIONS` row, and
  one exact-finding pin.

Not changed:
- the golden (sha256 `3ec3880c…` at both 7d7cafa and 8db0825);
- `apps/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs`;
- both READMEs, whose descriptions remain accurate.

## tests_run

### Gates
Run on the final tree, which is byte-identical to commit 8db0825 (the only diff was the four committed files).
Script: `scratchpad/recon-2/r1/run-gates.sh`; logs: `scratchpad/recon-2/r1/gate-*.log`. Every command was prefixed
`pnpm_config_verify_deps_before_run=false`.

| Command | Exit | Counts |
| --- | --- | --- |
| `pnpm run typecheck` | 0 | no errors |
| `pnpm run lint` | 0 | `eslint .`, no output |
| `pnpm run check:deps` | 0 | PASS (F1–F14, every package classified) |
| `pnpm run test` | 0 | **333 files / 7224 tests** (unchanged from r0: this round touches no unit test) |
| `pnpm run test:e2e` | 0 | **7 files / 157 tests** (r0 151, +4 R1, +2 R2) |
| `pnpm run test:replay` | 0 | **3 / 17** |
| `pnpm --filter @polymarket-bot/trader test` | 0 | EMPTY output: `apps/trader/package.json` has no `test` script (a no-op, as in r0) |
| `pnpm exec vitest run --config test/vitest.config.ts apps/trader/src` | 0 | **9 files / 140 tests** (the trader's unit tests, including `order-provenance.test.ts`) |
| `timeout 20 docker info --format '{{.ServerVersion}}'` | 0 | `29.1.2` |
| `pnpm --filter @polymarket-bot/trader test:integration` | 0 | **14 files / 129 tests** |
| `determinism-golden.test.ts`, run 1, without `WP250_WRITE_GOLDEN` | 0 | 5 / 5 |
| `determinism-golden.test.ts`, run 2, without `WP250_WRITE_GOLDEN` | 0 | 5 / 5 |

The added lines were scanned for `eslint-disable`, `.skip`, `.only`, `ts-ignore`, `ts-expect-error`,
`process.env`, `Math.random` and `Date.now`: none.

### Non-vacuity (packet requirement 4)
1. **Setup.** I recorded the sha256 of the r1 files:
   - `reconcile.ts` `d1b010d6d728dff1ac66b0bcf8cc7861b1604154007b4e30d9b9a9d1fdae1a26`;
   - `chain-walk.ts` `e54158c724e8d3133744e438a0a9d9a57015b7096a94c94caf514b7ca6c087a5`.

   I then replaced both with `git show 7d7cafa:<path>`. No other file was touched, and no adaptation was needed.
2. **Run.** `pnpm run test:e2e` exit 1: **Test Files 2 failed | 5 passed (7); Tests 6 failed | 151 passed (157)**.
   Exactly the six new pins failed, and nothing else.

   | Pin | Failure against 7d7cafa |
   | --- | --- |
   | swapped prefixes | `expected [Function] to throw an error` (r0 accepted it) |
   | re-pointed fill | `expected [Function] to throw an error` (r0 accepted it) |
   | trace naming an unproduced fill | `expected [Function] to throw an error` (r0 accepted it) |
   | fill id carried by two fills | `expected [Function] to throw an error` (r0 accepted it) |
   | R2 mutation-table row | `expected true to be false` (`report.ok` was true) |
   | R2 exact-finding pin | `expected [] to deeply equal [ Array(1) ]` (no finding) |

   Both ADAPTED pins ("fully open and fully closed", "R4") PASSED against 7d7cafa's files. The adaptations are
   therefore valid documents under both reconcilers, and neither depends on the new rule.
3. **Restored.** Both files were copied back, and `sha256sum -c` reported OK for both. The committed bytes are
   these.

Log: `scratchpad/recon-2/r1/nonvacuity-r1-e2e.log`.

### RECON-1's six review reproductions
All remain green in the 157-test run:
- copied exit plus phantom;
- foreign market;
- foreign token;
- wrong side label;
- QUOTE and reduce sharing an id;
- `"05"`.

The `"05"` pin's synthetic changed shape (see deviations). Its refusal is still the canonical-sequence check, and it
now has a positive control.

## assumptions

- **Trace construction.** The loop builds a trace only from `#orderTraces.get(fill.simulatedOrderId)`
  (`loop.ts` ≈1443). So in a real run a trace's `venueOrderId` is its fill's `simulatedOrderId`, and a fill id
  names one fill. I read this; I did not change it.
- **Fill ids are unique within a run's document.** The chain walk already reports `FILL_ID_NOT_UNIQUE`. The
  reconciler now refuses an ambiguous id only when a trace names it, which is the case the join needs. It does not
  add a global uniqueness check.

## deviations

- **Two existing pins adapted, not weakened.** Both previously built documents in which a trace named a fill the
  document no longer held. The new join refuses that before the property each pin tests. Each synthetic is made
  well formed, and its assertion is unchanged.
  - **RECON-1 r1 "fully open and fully closed — the golden's only states — are unchanged".** The fully-open
    document is now `withReductionWithdrawn(golden)`: the exit fill leaves with its trace, and its order reports
    0 filled. It still asserts open capital `17.2` = Σ entry notional, and fully-closed `0`. A precondition that
    the exit fill is absent was added.
  - **RECON-1 r2 "R4: a single fill's non-canonical sequence is refused, not folded".** The single-fill document is
    now `withReductionWithdrawn(golden)` with only the first entry lot and ITS trace. It still asserts the refusal
    `/not a canonical unsigned integer string/`. It gains two preconditions (one fill, one trace) and a CONTROL:
    the same document spelled `"5"` is folded without throwing.

  Both adapted pins pass against 7d7cafa's reconciler too (see non-vacuity).
- **The r0 wording "this pin's refusal changed" does not apply here.** Neither adapted pin's refusal reason
  changed; only their synthetics did.
- **No golden regeneration.** None was needed: `buildReconciliation`'s rows are byte-identical for the golden, and
  determinism passed twice. The packet's regeneration step applied to r0's content changes, not to this round.

## known_risks

- **Fill-level trace completeness is NOT enforced, deliberately.** It is unchanged from r0's disclosure: a second
  fill with no trace of its own, on an order that HAS a bound trace, is still attributed through its order's
  record. That is by id and on the correct side, but it is not corroborated by a trace of its own. The chain walk
  reports it as `ORPHAN_FILL`.

  I did not add a fill-level rule, because the loop can legitimately leave a fill untraced. When a ledger posting
  is refused (`loop.ts`: `continue` after `LEDGER_POSTING_REFUSED`), or the store fails, no trace is pushed. Refusing
  such a document outright is a policy choice for the orchestrator. It would also require adding traces to the
  RISK2-R4 / RECON1-EDGE interleaved synthetics, which add a second exit fill without one.
- **Order `filledShares` is not reconciled against Σ its fills' shares.** This is unchanged from before RECON-2.
  A document that re-points a fill AND deletes and re-fabricates the corresponding traces consistently is the
  stated boundary: the oracle checks consistency by id, not authenticity.
- **The reconciler does not refuse empty ids** (plan, approved intent, submission attempt). The chain walk does.
  See the R2 argument in the summary.
- **All r0 known risks stand as written.** In particular:
  - `#orderTraces` is never pruned;
  - unfilled-order provenance is process-memory only (not durable);
  - one plan per emission;
  - there is no intent `direction` in the artefact.
- **CI.** The GitHub CI run the RECON-2 gate asks for was NOT performed; pushing is out of scope for me.

## follow_up

- **The orchestrator:** push `recon-2` and obtain the GitHub CI run.
- **Optional policy decisions:**
  - (a) refuse a fill with no trace of its own at the reconciler, given the posting-refusal path;
  - (b) have the reconciler refuse empty plan, approval and submission ids, mirroring the chain walk;
  - (c) reconcile each order's `filledShares` against its fills.
- **Everything in r0's follow_up still stands:**
  - the stale "Running it" and type-checking paragraphs in `test/e2e/README.md`;
  - trace and provenance durability;
  - `#orderTraces` pruning;
  - the chain's event hop for fills of loop-originated evaluations;
  - `direction` in a future artefact bump.

## commit_sha

`8db0825754946001fd20141deb8513d1ff3e1f9c` on branch `recon-2`, on top of
`7d7cafa5b1c9ccad2536c99ccbf174d81f22966c`. Not amended, not rebased, not pushed.
