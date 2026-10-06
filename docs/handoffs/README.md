# How to write records in this repository

`IMPLEMENTATION_STATUS.md` is the brief: current state only. Each package's
detail lives in its handoff here. History that the brief once carried is in
`docs/status-archive/`, frozen.

1. **One line per status row.** A row holds the package id, its scope, its status, the merge SHA and a link to the handoff. A package's row is in the brief while the package is open: Ready, Running, Blocked, Evidence pending, and so on. When the package is Complete, its row leaves the brief, and its single row in [`INDEX.md`](INDEX.md) carries it. Use the status words the brief already uses ("Ready (authorized)", "Complete", and so on). Everything else goes in the handoff.
2. **State the current fact; do not narrate the change.** When a fact changes, replace the brief's line. Put the old wording in the round's handoff, quoted and dated.
3. **Short sentences.** One fact per sentence; aim for 25 words or fewer. No nested parentheses. Use a list instead of a chain of clauses.
4. **Exact identifiers.** Give SHAs (7 or more characters), ids and numbers exactly. Never rename an id. A `file:line` citation goes stale; cite a symbol or heading, or pin the commit (`path@sha:line`).
5. **One handoff per package, one section per round.** Round N adds `## Round N (date)` with only what changed: findings, fixes, evidence. Do not repeat unchanged fields; write "unchanged since round N-1".
6. **Transcripts are evidence, not prose.** Keep a transcript only when it proves a claim. Trim it to the lines that do, and say above the fence what it proves. Put long logs outside the repository or in CI, and cite them.
7. **Tabulate mutation checks:** mutant, expected failure, observed result.
8. **Corrections:** state the corrected fact, then add one line: "Corrected <date> (<round>): was '<old>'." Never rewrite history silently.
9. **Required fields** (`AGENTS.md`): `summary`, `files_changed`, `tests_run`, `assumptions`, `deviations`, `known_risks`, `follow_up`, `commit_sha`. Add the round's outcome and its reviewer.
10. **After a merge,** add or update the handoff's single row in [`INDEX.md`](INDEX.md). If the package is now Complete, remove its row from the brief. The INDEX row then carries the package's status, merge SHA and handoff link. Its Outcome cell keeps any qualification, ruling or grant that the status carries. If the package is still open, update its row in the brief.

The orchestration runbook (§3 step 8) lists what a status update records:
state, merge SHA, review reference, tests, deviations, unblocked packages,
pending evidence and the run mode. Put the SHA and state in the package's row.
That is the brief's row while the package is open. Once it is Complete, the
brief's row is removed, and the row is its INDEX row. Put everything else in
the handoff, linked from the row. Live blockers and residuals get one line each
in the brief's Open blockers section.
