# GOV-NOTES-1: dated corrections to ADR-028 Amendment 1 rule 6 and wal-format §11.1

**Status:** Complete (2026-10-04). Merged `1f99fcc` (PR #59; CI run `37191829788` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 2 on `05514ca`.
**Base:** `3202688`. In round 1, the branch merged `main` at `a130aaf` to record `TC-LOWS-1`'s closures.
**Paths:** `docs/adr/ADR-028-raw-retention-with-pins.md` and `docs/contracts/wal-format.md`. Docs only; it decides nothing.

## summary

Each note is dated 2026-10-04, in ADR-026 D2.11's form, and names the merged package and its merge SHA. The original text is unchanged.

1. **ADR-028 Amendment 1, rule 6, after the trader-limits block.** `PROVENANCE-1` (`71d8b80`) lifted both trader limits:
   - **the dispatch position:** `dispatchPositionOf`, `decisionRow`, `dispatchFrontiers` and `meetsRequirement`;
   - **the refusal and halt rows:** `riskEventRows`, `recordHaltsBeforeExit`, `postgresTraderEvidence` and `pinClassOf`.

   The note also records what is still open in `PROV1-LOWS` (F3 and R2-L1), and that `TC-LOWS-1` closed R2-L2 and R2-L3.
2. **ADR-028 rule 6, items 1 and 2.** A second note records `WALCAP-1` (`da559ca`):
   - the `laptop-paper` marker now requires `maxTotalBytes`;
   - the per-file ledger lets expiry give bytes back;
   - the items still open.

   The orchestrator ratifies this addition. It discharges `WALCAP-1` round 2's follow_up 9.
3. **`docs/contracts/wal-format.md` §11.1, at the top of the section.** The capacity ledger as merged:
   - its scope;
   - when it is read: at open and on every `tick()`;
   - what raises and what lowers it;
   - the admission test;
   - `capacityRemainingBytes`.

   It also covers the deferred time rotation (`#mayCloseByTime`). That note was moved here from §8 in round 1, to stay inside the grant. The packet's "§9.1" meant the handoff's §9.1 age rule, not this contract's own §9.1.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `65c61e9` | CHANGES REQUIRED | NEW-1 HIGH: a false claim about when a deferred rotation closes. MEDIUMs: a note outside the grant (§8); R2-L2 and R2-L3 listed as open after `TC-LOWS-1` closed them; one overhead term reused with two meanings |
| 2 | `05514ca` | **ACCEPT** | none; three LOWs |

## tests_run
- `lint`, `check:deps` and `test` exit 0. No test reads either document.
- **CI:** GitHub CI on the PR #59 merge ref was green before the merge.

## deviations
- **The time-rotation note sits in §11.1,** after round 1's scope finding.
- **ADR-028 rule 6 gains a second note,** for `WALCAP-1`, which the orchestrator ratified.

## known_risks
- **Round-2 LOWs:**
  - GN1-R2-01: "It never checks on an empty queue" reads against the in-flight definition;
  - GN1-R2-02: the `WALCAP-LOWS` pointer names no owner;
  - GN1-R2-03a: two unclear references.
- **Other stale passages in `wal-format.md`, outside this grant:**
  - §2: one writer per directory, where the ledger assumes one per WAL root;
  - §12: the capacity-against-time-rotation and single-writer rows;
  - §14: the test and file tables lack `capacity-relief.test.ts`, `capacity-in-flight.test.ts` and `capacity-ledger.ts`.

## follow_up
1. **A docs round with a grant on `wal-format.md`:**
   - §2, §12 and §14;
   - a pointer from §8's `maxSegmentAgeMs` row to the §11.1 note;
   - the three round-2 LOWs.

## commit_sha
`05514ca`
