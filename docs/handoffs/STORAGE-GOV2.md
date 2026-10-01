# STORAGE-GOV2: ADR-028 Amendment 1 corrections after STORAGE-1b; ADR-029's header

**Status:** Complete (2026-10-01). Merged `a428ba3` (PR #42; CI run `36894221120` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 1 on `bc70e9e`.
**Base:** `d968c89`. The branch merged `main` at `fa76c7a` before the PR. Docs only.

## summary

- **ADR-028 Amendment 1, rule 3 (the cycle lock).** Items 5 and 8 are rewritten. Each carries a dated correction line that quotes the old item. They record that `STORAGE-1b` (`7b6499e`) closed both lock LOWs under route (a):
  - any `open()` error other than EEXIST refuses at once;
  - an unreadable or non-UUID boot id refuses before the state directory or the lock is created;
  - there is no fallback name, and a leftover `storage-cycle.lock` counts as held;
  - `ProcSubset=pid` is unsupported.
- **Rule 1, item 6 (`S-GOV-R3-01`).** It now says exactly what `rememberEvidence` does, with a dated correction line:
  - only an execute cycle clears the mark, including its recheck; a dry run never does;
  - an entry for a settled, empty, unregistered window is dropped.
- **ADR-029.** Its "Implemented by" line and README row now say `STORAGE-1` (done, `a22502b`). `APPROX-REPLAY-1` is not yet implemented.
  - Corrected 2026-10-01 (STORAGE-GOV2): ADR-029's line was "Not yet implemented", and its README row was "(not yet)".

## tests_run
- `lint` and `check:deps` exit 0: 35 packages, 98 edges.
- `test`: 416 files, 9322 tests.
- A scope check shows only three hunks in ADR-028.
- A script found every quoted old wording verbatim at the base.
- GitHub CI on the PR #42 merge ref was green before the merge: run `36894221120`.

## assumptions
- A recheck counts as part of its execute cycle.

## deviations
- "Refuses before creating anything" is scoped to the cycle. `storageMain` creates the object-store root before the cycle starts.
- The ADR-028 README row is unchanged, because nothing in it is false.

## known_risks
The reviewers agreed six wording LOWs. All are open; a later docs round may apply them:
- **SG2-R1-01:** the route (a) bullet should say when a cycle refuses, and point to `docs/handoffs/STORAGE-1b.md`.
- **S-GOV2-R1-01:** rule 1 item 6 is harder to parse than the fact it states.
- **S-GOV2-R1-02:** the fact that a leftover `storage-cycle.lock` still blocks cycles after a reboot survives only inside the correction quote.
- **S-GOV2-R1-03:** item 8 drops the mixed-version upgrade residual that `STORAGE-1b.md` records.
- **S-GOV2-R1-06:** ADR-029's header was replaced without an in-file correction line. That follows the `STORAGE-GOV` precedent; this record carries the correction.
- **S-GOV2-R1-07:** Amendment 1's Source and Scope bullets name only `STORAGE-1`, but rule 3 now records `STORAGE-1b`.

## follow_up
- Rules 3 and 6 go stale again as `STORAGE1-MAXBYTES` and `PROVENANCE-1` land. Each of those rounds adds a dated correction or an Amendment 2, and may apply the LOWs above.

## commit_sha
`bc70e9e8a6adc929c674008551a77502d4ca3b1e`
