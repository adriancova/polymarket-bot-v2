# GOV-2C completion record — the ledger tells the truth about what is open; the contracts record the sweep

**Merged:** `33c36f9` (`--no-ff`, 2026-09-16). Chain `a4e0c66` candidate →
`3041d07` r1, on base `1aa2238`. Review round 1 **CHANGES REQUIRED** (3 MEDIUM,
7 LOW/INFO) → round 2 **ACCEPT** (1 LOW, 2 INFO, corrected in the governance
flip that followed the merge). Reviewer independent of the implementer.

**What it is.** The governance and documentation half of the GOV-2B closeout:
findings **B8**, **N2**, **N3**, **N6**, **N7**, **N9**, **N10**, **G-13**, plus
SER-3's **N4**. Text, ledger and ratification only. **No behaviour change**,
proven: comment-stripped `ts.transpileModule` of the two touched source files
(`apps/control-api/src/control-plane.ts`, `packages/features/src/inputs.ts`)
byte-identical to `1aa2238`; the parsed work-plan data differs only in nine
`allowed_paths` lists (below).

## What shipped

1. **B8 — the ledger contradicted itself where a closeout must read it as
   authority.** `## Open blockers` said `None.` above a 219-line record whose
   own closing text said it "stays open". It now enumerates what is open: the
   live blockers (B4/H1, B5, B9 at the time of writing, G-01) and a **residual
   queue of 22 owned rows**, each with evidence and owner; a "closed since the
   audit" list with the closing commit for each item.
2. **G-13 — no row pointed at the qualification.** `## Wave 2 qualification`
   now states what "COMPLETE" in the header means and does not mean, and the
   header's line 5 strikes exactly the two clauses that became false (the audit
   "has not been run"; the round trip) with dated notes — an over-strike of the
   four still-true conditions was caught by the review and reverted in r1.
3. **"Unblocks nothing new" restated correctly.** The candidate copied the
   closeout's own error (`… except WP-250 itself and WP-360`). The true
   statement, re-parsed from `docs/spec/polymarket-bot-workplan.yaml` at
   `1aa2238`: exactly four packages outside Wave 2 depend directly on a Wave 2
   package — `WP-270`, `WP-290`, `WP-300`, `WP-360` — and every one also
   reaches `WP-260` (`WP-360` via `WP-350 → WP-340 → the phase-3 chain`), so
   closing Wave 2 releases none of them. Verified by the orchestrator and by the
   reviewer with independent parses; the orchestrator's own suggested wording
   ("except WP-360") was wrong and was correctly not adopted.
4. **N10 / the SER docs debt.** `docs/contracts/schema-boundary.md` §5's OPEN
   successor obligation is discharged in text with the sweep recorded
   (`SER-0` `9a44167` → `SER-1` `c065d63`, `SER-2` `0d8b6a0`, `SER-3`
   `603a49c`); §3's header is re-pinned; row R8-1 added; the six new downward
   `risk` edges and the consumed subpath `./plain-json` recorded in
   `dependency-direction.md`.
5. **N2 — a false basis sentence.** §3's `packages/order-book` entry said
   "scalar parses only … no object parse" while `book.ts:191` and `:265` both
   `safeParse` caller-supplied `input.payload` against object schemas. Corrected
   with the old text quoted; the r1 review moved one citation
   (`price-helper.ts:104`) under the schema it actually belongs to.
6. **N4 — one sentence at `control-plane.ts:440`** on the iterator-vs-index
   values divergence SER-3 owed.
7. **N3 — a ruling's compliance mechanism failed, twice.** `GOV-2A` required two
   totality claims corrected "by the next bounded round touching each package";
   `WP-180-FU2` and `WP-160-FU1` each touched the package and left the claim.
   `inputs.ts`'s "never throws" is corrected; the deviation entry records the
   systemic cause — nothing checks a ruling's compliance — and states that the
   fix needs a grant over the plan's package entries.
8. **N6 / N7 / N9 — ratified or recorded.** N6: the two controlling documents
   disagreed on the required handoff field list; reconciled and ratified as a
   plan comment. N7: ten of the eleven Wave 2 merges touched the protected
   `pnpm-lock.yaml`; measured per merge against its first parent
   (importer-block insertions only) and ratified RETROACTIVELY — nine packages
   (`WP-150`, `WP-160`, `WP-170`, `WP-180`, `WP-190`, `WP-200`, `WP-210`,
   `WP-230`, `WP-240`) gain `pnpm-lock.yaml` in `allowed_paths` with a dated
   comment; `WP-220`'s was already ratified. r1 added the seven further
   Wave 2-era first-parent touches by rounds with no plan entry (`625c83b`,
   `a30fec8`, `edf6b1d`, `d89841d`, `c065d63`, `0d8b6a0`, `603a49c`), measured:
   six insertions-only in `importers:`, one exact pin `^10.6.0 → 10.6.0` of
   `decimal.js` — stated as the ratification's coverage limit. N9: `WP-200`'s
   declared `test/integration/ledger/**` has never existed; recorded, not
   removed.

## What the review established independently

- Every SHA, count and line citation in the candidate re-derived; three
  sentences found false or self-contradicting (the `depends_on` claim; N5
  listed as closed by `GATE-1` at 17:37 when `TRDR-2` at 18:22 made the CI
  label wrong again; the header over-strike) and fixed in r1 with the
  superseded text quoted.
- All seven extra lockfile diffs re-measured hunk by hunk; every one before the
  `packages:` line except the one-line `decimal.js` pin.
- Round 2 found one row still false in the present tense: GATE1-R3 said
  `js-yaml 4.3.2` "has never executed here", but `GATE-1`'s post-merge frozen
  install materialized it (`node_modules/.pnpm/js-yaml@4.3.2`; `@eslint/eslintrc`
  resolves 4.3.2 — verified by the orchestrator) and every lint gate since ran on
  it. Corrected in the flip, with the old text quoted.

## Gates

At tip `3041d07` and post-merge on `main` `33c36f9`: `pnpm run test`
**326 files / 7129 tests** (unchanged), typecheck 0, lint 0, `check:deps` PASS
34 packages / 78 edges.

## Residuals (owned)

1. **The residual queue is now the ledger's authority for what is open, and
   nothing checks it** — the same failure class as N3. Every merge must maintain
   it by hand until a grant over the plan's package entries lets a round wire a
   mechanical check. Owner: the orchestrator, every governance flip.
2. **Header line 5 carries two strikes and two dated notes.** Readable; the next
   rewrite of that sentence should replace rather than append.
3. **N5 is open again** (`ci.yml:88` "two of them"; three of six suites now need
   Docker since `TRDR-2`). One-line fix for the next round granted
   `.github/workflows/ci.yml`.
4. **The N3 systemic fix** (a ruling that names a package must be checked when
   that package is next touched) needs a grant this round did not have.
5. **BACKTEST-1 shipped no `docs/handoffs/BACKTEST-1.md`** (not in its
   `allowed_paths`) — the N6 concern applies; the orchestrator writes it at
   merge time (done in the same flip as this record's successor).

## Handoff fields

- `summary`: above.
- `files_changed`: `IMPLEMENTATION_STATUS.md`, `docs/contracts/schema-boundary.md`,
  `docs/contracts/dependency-direction.md`, `docs/spec/polymarket-bot-workplan.yaml`
  (comment entries + nine `allowed_paths` additions), `apps/control-api/src/control-plane.ts`
  (comment), `packages/features/src/inputs.ts` (comment/doc correction).
- `tests_run`: `pnpm run test` 326/7129; typecheck; lint; check:deps 34/78;
  transpile byte-identity proof for both source files.
- `assumptions`: the WP-360 dependency chain as parsed at `1aa2238`; N5's owner
  is "the next round granted `ci.yml`".
- `deviations`: none from the packet; one wording departure (no "except WP-360")
  disclosed and verified correct.
- `known_risks`: residuals 1-2 above.
- `follow_up`: residuals 3-5; the H7 remainder.
- `commit_sha`: `a4e0c66`, `3041d07`; merge `33c36f9`.
