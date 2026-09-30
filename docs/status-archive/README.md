# Status archive

This directory holds the history that `IMPLEMENTATION_STATUS.md` carried until
LOGS-1. The status file is now a brief: current state only. Everything it held
at the cut is here, byte for byte.

- **Cut:** `f43efe6` (`f43efe61d6501b0e49adc08b037f00b72937d294`). If the archive is re-cut, this line and every file's marker change together.
- **Frozen.** Do not edit the archived files, and do not add new history here. New detail goes in the round's handoff (see [`docs/handoffs/README.md`](../handoffs/README.md)).
- **Search by id; do not read whole files.** The files are large (the two work-package files are about 200-260 KB each).

## Files

Each file holds one contiguous run of lines of the old file, between
`verbatim-begin` and `verbatim-end` markers. The begin marker records the base
commit, the line range and the sha256 of the region.

| File | What it holds |
| --- | --- |
| [`header-and-phase.md`](header-and-phase.md) | The old header, with the long current-phase sentence, and the safety state |
| [`work-packages-waves-0-2.md`](work-packages-waves-0-2.md) | The table header and the full rows `WP-000` to `WP-250` |
| [`work-packages-rounds.md`](work-packages-rounds.md) | The full rows `WP-180-FU3` to `VENUE-3`, `WP-260`, and the authorization vocabulary |
| [`completion-records-wave-1.md`](completion-records-wave-1.md) | Completion records `WP-170` to `WP-100`, and the Wave 1 batch 1B phase-gate record |
| [`wave-1-batch-1b-in-flight.md`](wave-1-batch-1b-in-flight.md) | The batch 1B in-flight records, including "contract-owner item 3" (cited from code) |
| [`completion-records-wave-0.md`](completion-records-wave-0.md) | Completion records `WP-060` (with its review history) to `WP-010` |
| [`wave-0-closeout-and-reviews.md`](wave-0-closeout-and-reviews.md) | The Wave 0 closeout and review history, the `WP-000` in-flight record, accepted evidence |
| [`wave-2-qualification.md`](wave-2-qualification.md) | What Wave 2 "Complete" means; the superseded header sentences |
| [`open-blockers-2026-09.md`](open-blockers-2026-09.md) | The closeout blockers and every residual row, open and closed |
| [`cross-package-schema-risk.md`](cross-package-schema-risk.md) | The 2026-09-03 zod adoption/loss record and its 2026-09-15 reconciliation |
| [`deviations-evidence-gates.md`](deviations-evidence-gates.md) | The full deviation bullets, pending and resolved evidence, and the gates |
| [`MOVE-MAP.md`](MOVE-MAP.md) | Where each old heading, row and bullet went |
| [`REWRITES.md`](REWRITES.md) | Each live sentence the brief restates, as an old and new pair with a fact account |

## Old line citations

Older records cite the status file by line, for example
`IMPLEMENTATION_STATUS.md:5` or `:1629-1631`. Those numbers refer to the file at
the cut. Read them with `git show f43efe6:IMPLEMENTATION_STATUS.md`, or find the
line in `MOVE-MAP.md` and the archive file whose marker range contains it.

## Links inside the archived regions

The old file sat at the repository root, so relative links inside a region
resolve from the root, not from this directory. The bytes are kept as they
were. `split-status.py` writes a note after each such region with the working
links; Proof A checks the note is exactly the generated one, and C4 checks that
every archived link resolves from the root and has a working counterpart.

## Tools

All are Python 3 standard library, deterministic and offline. Run them from the
repository root.

- `python3 tools/records/split-status.py --base <rev>` writes the archive files from `<rev>:IMPLEMENTATION_STATUS.md`. The split keys on headings and row ids, not line numbers.
- `python3 tools/records/move-map.py --base <rev>` writes `MOVE-MAP.md`. Re-run it after editing the brief or `REWRITES.md`. C5 checks that the map is exactly its output, and that the line for each carried completion record or Complete row names its entry.
- `python3 tools/records/check-preservation.py --base <rev>` runs three proofs:
  - A: the archive regions partition the base file exactly.
  - B: every non-blank base line is present, counted with multiplicity.
  - C: the brief names every package and open item, its SHAs exist, its links resolve, and the move map is complete.
  - C also checks `REWRITES.md` against the base and the brief: old blocks are verbatim, every base line is paired or declared, and each declaration's kind and disposition are checked (C6, C8-C16). [`REWRITES.md`](REWRITES.md) lists each check.
  - A declared kind can still pass while partly wrong: a partly closed row can pass as closed, and `REWRITES.md` says which.
  - C15 checks that each residual clause holds a marker, not that the marker covers the whole clause, so reviewers must check the rest of each clause.
  - C authenticates what `REWRITES.md` says. It cannot tell whether a rewrite kept every fact, or whether a drop reason is true; that is a review question.
- `python3 tools/records/check-brief.py --base <rev>` checks the brief's budget (15% of the base file) and the measurable parts of the writing standard. For example: no sentence over 45 words (K23), and a commit pin in every section that cites a file line (K25).
  - K31 is a set of regression checks for 17 specific closures that review found. Each rule reads its evidence at the cut. K31 is not a detector: an item closed before the cut that no rule names still passes.
  - K32 checks the pending dashboard panels against the code. K33 checks every file:line citation in the brief against the file at the cut. K34 checks that the brief names every id still in `BINANCE_UNVERIFIED`.
  - K36 checks that facts review found dropped are carried: each rule names a brief row or bullet, the words it must hold, and the source text at the cut.
- `python3 tools/records/selftest-preservation.py` shows the proofs are not vacuous: it mutates a scratch copy, including a synthetic re-cut, and checks that each mutation fails and each re-cut passes.

## Re-cutting after edits on `main`

Edits made to the old file on `main` after the cut (new rows, status flips) are
re-applied like this. `REWRITES.md` stays pinned to its `rewrites-base`
(`f43efe6`), so its existing line numbers never change.

1. Merge `main`. Resolve the conflict in `IMPLEMENTATION_STATUS.md` by keeping the brief.
2. Run `python3 tools/records/split-status.py --base <main tip>`. The archive now holds those edits verbatim.
3. For each id in `git diff f43efe6 <main tip> -- IMPLEMENTATION_STATUS.md`, update its one line in the brief.
4. In `REWRITES.md`, cover every line inserted or changed since `f43efe6`. Do not renumber existing blocks.
   - Changed lines: add an entry whose old block names the cut (`~~~old base=<main tip sha> lines=a-b`), with keep phrases for an open or live row; or add a declaration to a `~~~unpaired base=<main tip sha>` block.
   - A new Complete row that mentions a residual or follow-up needs a disposition (C12). Its live residuals go in the brief's "Residuals recorded in Complete package rows", with an excerpt entry. Each residual clause it does not carry gets a drop line (C15).
   - A new completion-record item that names an obligation is declared `record-item` (C14). Its live part goes in "Obligations in completion records".
   - Before carrying an item as owed, check that no later record or contract commit closed it (`git log <cut> -- docs/contracts docs/adr`, the later handoffs, the code comment). If one did, write a drop line with the evidence instead.
5. Run `python3 tools/records/move-map.py --base <main tip>`, then `check-preservation.py --base <main tip>`, `check-brief.py --base <main tip>` and `selftest-preservation.py`. All must pass.
6. Update the cut line above.
