# How to write records in this repository

`IMPLEMENTATION_STATUS.md` is the brief: current state only, at most 30 KB. Each
package's detail lives in its handoff here. Open residuals live in
[`RESIDUALS.md`](RESIDUALS.md). History that the brief once carried is in
`docs/status-archive/`, frozen.

1. **One line per status row.** A row holds the package id, its scope, its status, its merge reference and a link to the handoff. The merge reference is the PR number and the candidate SHA; rows written before 2026-10-08 give the merge SHA. A package's row is in the brief while the package is open: Ready, Running, Blocked, Evidence pending, and so on. When the package is Complete, its row leaves the brief, and its single row in [`INDEX.md`](INDEX.md) carries it. Use the status words the brief already uses ("Ready (authorized)", "Complete", and so on). Everything else goes in the handoff.
2. **State the current fact; do not narrate the change.** When a fact changes, replace the brief's line. Put the old wording in the round's handoff, quoted and dated.
3. **Short sentences.** One fact per sentence; aim for 25 words or fewer. No nested parentheses. Use a list instead of a chain of clauses.
4. **Exact identifiers.** Give SHAs (7 or more characters), ids and numbers exactly. Never rename an id. A `file:line` citation goes stale; cite a symbol or heading, or pin the commit (`path@sha:line`).
5. **One handoff per package, one section per round.** Round N adds `## Round N (date)` with only what changed: findings, fixes, evidence. Do not repeat unchanged fields; write "unchanged since round N-1".
6. **Transcripts are evidence, not prose.** Keep a transcript only when it proves a claim. Trim it to the lines that do, and say above the fence what it proves. Put long logs outside the repository or in CI, and cite them.
7. **Mutation checks** are required only in the protected areas (runbook §3). There, tabulate them: mutant, expected failure, observed result.
8. **Corrections:** state the corrected fact, then add one line: "Corrected <date> (<round>): was '<old>'." Never rewrite history silently.
9. **Required fields** (`AGENTS.md`): `summary`, `files_changed`, `tests_run`, `assumptions`, `deviations`, `known_risks`, `follow_up`, `commit_sha`. Add the round's outcome and its reviewer.
10. **In the round's own branch, before the merge,** add or update the handoff's single row in [`INDEX.md`](INDEX.md). Its Merge cell reads "merged via PR #N" and gives the candidate SHA. If the package will be Complete, remove its row from the brief in the same branch. The INDEX row then carries the package's status, merge reference and handoff link. Its Outcome cell keeps any qualification, ruling or grant that the status carries. If the package stays open, update its row in the brief.
11. **Residuals:** one row each in [`RESIDUALS.md`](RESIDUALS.md), with an owner, under "Affects PAPER" or "Before any live mode". A round that opens one adds its row. A round that closes one removes its row in its own branch and names it in its handoff.

Status lives in the PR: the handoff, the INDEX row, the brief change and any
residual change are written in the round's branch and merge with it. A direct
`governance:` commit on `main` is only for user rulings and authorizations
(runbook §3.3). Check the records with `python3 tools/records/check-brief.py`.
