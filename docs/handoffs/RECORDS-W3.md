# RECORDS-W3: records hygiene after the Wave 3 closeout

**Status:** Complete (2026-10-06). Merged `b008a26` (PR #83; CI run `37446661001` green). It closes `CLOSEOUT-3` L2, L5, L6, L9 and I8.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 1 on `09b517d`.
**Base:** `47549ac`. The branch merged `main` twice, at `64bad5b` and at `51c0213`. After the second merge the orchestrator brought the Protocol V2 line current.
**Paths:**
- `IMPLEMENTATION_STATUS.md`;
- `docs/runbooks/emergency.md`;
- `docs/handoffs/{WP-330,THROUGHPUT-1c,GOV-NOTES-3,INDEX}.md`;
- `docs/adr/README.md` and `ADR-007`, `ADR-026`, `ADR-031` (implemented-by lines only);
- `tools/records/**`.

## summary
1. **The brief is back under budget.** It went from 113,376 B and 527 lines to about 103.5 KB and 438 lines, 14.9% of the base, so `check-brief.py --base f43efe6` passes.
   - The run of "X is Complete" lines is gone; the Work packages table carries each completion.
   - THROUGHPUT-1c's rulings moved, word for word, into its handoff.
   - Closures that only the removed lines recorded are now in the closed list.
   - Over-long sentences are split.
2. **L2.** `docs/runbooks/emergency.md` now says that a line that does not parse can hold a complete `ACTING` or `OUTCOME` record from another invocation (CX330-R5-01), so it is not proof that nothing was done.
   - The correction is dated.
   - `WP-330.md` records that round 5 opened split: astra returned MEDIUM and Opus returned ACCEPT, and they reconciled to LOW.
3. **L9.** The ADR-007, ADR-026 and ADR-031 implemented-by lines now name their merges, each with a dated correction. ADR-007 also names its unbuilt parts (FAK and FOK: `CO3-N2`; the durable store: `CO3-N3`). The README's "(not yet)" cells are corrected.
4. **L5 and L6.** Stale brief entries are corrected, each checked against the repository:
   - `N8`, `B4` and `B5`;
   - the paper-fills contradiction;
   - the `WP320-FOLLOWUPS`, `WP270-DECISIONS`, `ROLLOVER1-RESIDUALS`, `WP300C-OBLIGATIONS` and `WP300-PERSIST` rows;
   - "Last updated" and "Next";
   - an `ADR033-REVIEW` row.

   A new row, `CO3-L6`, carries the unowned follow-ups.
5. **The tooling** (`tools/records/check-brief.py`):
   - **`--cut`:** a new option. The citation and carried-fact rules (K31-K34, K36) read their evidence at the archive's cut, `8fde4df`, while the budget uses `--base`. K33 also requires every "as of" pin to name the cut.
   - **Retired** (the `:906` citation, the LOGS-1 reviewer rule) and **re-anchored** (the H1R1 and Wave 3 rules), each with a reason.
   - **Unchanged:** K1, K2 and the safety-state check.
   - **The self-test** gains `--brief-only`.

## The orchestrator's ruling (2026-10-06)
`check-preservation.py` is LOGS-1's one-time proof that the archive cut preserved history. It is not a standing gate.
- Its Proof C compares the live brief with the frozen cut, so every legitimate brief edit since then adds failure lines. It already failed at the base, with 106 lines.
- Proofs A and B pass, and the handoff accounts for each new Proof C line.

## tests_run
- `check-brief.py --base f43efe6`: PASS.
- `selftest-preservation.py --brief-only`: PASS, 70 of 70.
- typecheck, lint and check:deps.
- Unit: 11,994, including the tooling suites and the ops-cli source-hygiene test, which pins runbook text.
- The live fault suite: 95, including `live-defaults`, which reads the brief's safety state.
- **CI:** the PR #83 merge ref was green before the merge.

## known_risks
- **The brief has under 1 KB of budget left.** Every completed package adds a Work-packages row, so the budget will be hit again; a structural answer is needed (follow-up 1).
- **LOWs:**
  - RW3-OPUS-01: the self-test does not pin the `--cut` reading;
  - RW3-OPUS-02: an H3 attribution;
  - RW3-OPUS-03: some records still call ADR-023 and ADR-030 Amendment 1 interim;
  - RW3-OPUS-04: stale K20 text;
  - RW3-OPUS-05: the ROLLOVER1 r7 item 9 wording.

## follow_up
1. **The orchestrator: a structural budget fix,** such as Work-packages rows for completed packages living only in `docs/handoffs/INDEX.md`, under a `docs/handoffs/README.md` rule change. Until then, governance edits must not grow the brief.
2. **A small records round,** with the next such work: the five LOWs.

## commit_sha
`09b517d`
