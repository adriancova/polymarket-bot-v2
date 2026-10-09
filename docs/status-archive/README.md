# Status archive

This directory holds the history that `IMPLEMENTATION_STATUS.md` carried until
LOGS-1. The status file is now a brief: current state only. Everything it held
at the cut is here, byte for byte.

- **Cut:** `8fde4df` (`8fde4dffa9546dc7570f1e53653242c568669c58`). It re-cuts the first cut, `f43efe6` (`f43efe61d6501b0e49adc08b037f00b72937d294`), at LOGS-1's merge. If the archive is re-cut again, this line and every file's marker change together.
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
| [`work-packages-rounds.md`](work-packages-rounds.md) | The full rows `WP-180-FU3` to `LOGS-1`, `WP-260`, and the authorization vocabulary |
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
the first cut or earlier. Read them with `git show f43efe6:IMPLEMENTATION_STATUS.md`.
`MOVE-MAP.md` and the archive markers use the re-cut's numbers (`8fde4df`).
Lines 1-768 keep their numbers; only the `THROUGHPUT-2` and `VENUE-3` rows
(738 and 756) changed there. Later lines moved down by 9, and by 17 after the
four `V3-*` rows.

## Links inside the archived regions

The old file sat at the repository root, so relative links inside a region
resolve from the root, not from this directory. The bytes are kept as they
were. `split-status.py` writes a note after each such region with the working
links; Proof A checks the note is exactly the generated one, and C4 checks that
every archived link resolves from the root and has a working counterpart.

## Tools (removed)

The one-time tools that cut and proved this archive (`split-status.py`, `move-map.py`, `check-preservation.py`, `selftest-preservation.py`) were removed at `b8927d2` (COMPLEXITY-1, 2026-10-08). The archive is frozen, so no re-cut is needed. The base is `f43efe6` and the cut is `8fde4df`. To inspect a tool, run `git show 5129b98:tools/records/<name>`. `check-brief.py` remains, and checks the current brief only.
