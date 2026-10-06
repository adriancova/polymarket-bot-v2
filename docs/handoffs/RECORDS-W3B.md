# RECORDS-W3B: completed packages live in the handoff INDEX, not the brief

**Status:** Complete (2026-10-06). Merged `e1915c6` (PR #87; CI run `37485124589` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 2 on `16551cf`.
**Base:** `cdbd5ea`. The branch merged `main` at `3294201`. The orchestrator then dropped the now-Complete `V2-10` row, whose INDEX row exists, and kept the running `ADR-034` row.
**Paths:**
- `IMPLEMENTATION_STATUS.md`;
- `docs/handoffs/INDEX.md` and `docs/handoffs/README.md`;
- `tools/records/check-brief.py` and `tools/records/selftest-preservation.py`.

## summary
1. **The brief's Work packages table holds open rows only.** At the merge these are: `WP-140` (evidence pending), the running rounds, `HOST-BENCH` (Ready), and the catch-all, reworded to "All other packages not in `docs/handoffs/INDEX.md`".
   - One line above the table says that completed packages are listed in the INDEX.
   - 150 rows moved: 148 Complete rows, the superseded WP-150 review-trail row, and the CLOSEOUT-3 audit row.
   - The brief went from 15.0% of its base to 11.6% by bytes and 9.9% by lines.
2. **The INDEX covers every moved row.** A script checked each row's id, merge SHA and link.
   - Facts the brief rows carried were added to the INDEX rows: THROUGHPUT-1c's ADR-023 ratification, CO2-N1-ADR's ruling, review ids, and scope qualifiers.
   - **DEPS-1**, which has no handoff, got a row linking its archived row.
   - **WP-140's cell** ("the gate is open") was corrected under README rule 8.
3. **`docs/handoffs/README.md`, rules 1 and 10.** A package's brief row exists while it is open. Once it is Complete, the row is removed, and its INDEX row carries the status, merge SHA, link and any qualification, ruling or grant.
4. **`check-brief.py`:**
   - **K38:** a Complete row in the brief is a finding;
   - **K39:** a package the brief names as Complete needs an INDEX row, and a matching SHA where the brief gives one;
   - **K26 and K28:** re-anchored to INDEX;
   - **unchanged:** K1, K2 and the safety-state check.
5. **The self-test** `--brief-only` passes.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `958248f` | CHANGES REQUIRED | MEDIUM RW3B-I2: K39 recognized only one completion wording |
| 2 | `16551cf` | **ACCEPT** | none; LOW checker-heuristic gaps (J1 to J8) |

## tests_run
- `check-brief.py --base f43efe6`: PASS, on the candidate and after the merge.
- `selftest-preservation.py --brief-only`: PASS.
- typecheck, lint and check:deps.
- Unit: 12,066.
- The live fault suite: 95, which reads the brief's safety state.
- `check-preservation.py`: informational only. Proofs A and B pass.
- **CI:** the PR #87 merge ref was green before the merge.

## known_risks
- **The completion step has changed.** A governance commit that marks a brief row "Complete" in place now fails K38. The completion commit removes the row, and adds or updates the INDEX row.
- **The checker's heuristics have gaps,** all LOW:
  - K39 recognizes only some completion wordings;
  - K38 misses rows under nested headings, or with plain ids;
  - no check binds an INDEX SHA to the merge commit;
  - nothing protects INDEX rows of packages the brief does not name.
- **The `AGENTS.md` sentence** "Current per-package authorization and state are recorded in IMPLEMENTATION_STATUS.md" now reads as authorization plus open state. Completed state is in the INDEX. Only the user changes `AGENTS.md`.

## follow_up
1. **A small records round:** the checker LOWs, J1 to J8.
2. **The user, optionally:** reword the `AGENTS.md` sentence to name the INDEX for completed packages.

## commit_sha
`16551cf`
