# STORAGE-GOV: ADR-028 Amendment 1 (the retention-safety rules STORAGE-1 implemented)

**Status:** Complete (2026-10-01). Merged `1f75ac0` (PR #39; CI run `36881820439` green on attempt 2, after the known `CI-FLAKE-STALL-BOUND` flake on attempt 1).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 3 on `169b7e4`.
**Base:** `4603211`. The branch merged `main` at `7942b1d` before the PR. Docs only.

## summary

ADR-028 gains `## Amendment 1 (2026-10-01, STORAGE-1)`. It records the rules as the code reads at `4603211`, and decides nothing new. Each rule names the ADR-028 decision it refines, and why it fails closed. It cites code by symbol.

1. **Evidence availability.** A trader database that is missing, not configured or unreadable gives a failed read, never an empty one.
2. **Durable, grow-only holds.** A dry run only adds. Only an execute cycle settles a window and releases its holds.
3. **One storage cycle at a time per state directory.** A boot-scoped `O_EXCL` lock enforces it. A stale lock in the same boot is never broken automatically. The two open round-6 LOWs are named in the rule, with their owner, `STORAGE1-LOCK-LOWS`.
4. **A state directory in every mode.**
5. **Registry pruning.** A window may leave the registry only after an execute cycle has settled it. This is an operator rule; the amendment says what stays held if it is broken.
6. **Where STORAGE-1 stops short:**
   - `maxTotalBytes` is not enforced;
   - the writer's byte counter (`J10`) is never reduced by expiry;
   - the codec is SNAPPY;
   - lapsed non-fill pins are never deleted;
   - two limits come from the trader: no decision carries its dispatch position (`H1R1-PROVENANCE`), and nothing writes refusal or halt rows (`OUT1-R1-HALT-NOT-DURABLE`).

The ADR's "Implemented by" line and its README row now point to the amendment.

## Rounds

| Round | Candidate | Verdict | Agreed findings |
|---|---|---|---|
| 1 | `6252b01` | CHANGES REQUIRED | 2 HIGH, 1 MEDIUM, 8 LOW |
| 2 | `342861e` | CHANGES REQUIRED | K-01 HIGH; 3 LOW |
| 3 | `169b7e4` | **ACCEPT** | 2 LOW, both open |

Details of the blocking findings:
- **Round 1, J-01 (HIGH):** the amendment claimed a refusal-only window "classifies unpinned". Both verifiers showed that no trader-responsible window classifies today.
- **Round 1, J-02 (HIGH):** the lock wait was misdescribed.
- **Round 1, J-04 (MEDIUM):** the rule labels collided with the user's ruling ids, so the rules are now numbered 1–6.
- **Round 2, K-01 (HIGH):** the amendment said a pruned window's failed-read mark lasts until it is re-registered, which overstated the code.

## tests_run
- `lint` exit 0.
- `check:deps` exit 0: 35 packages, 98 edges.
- `test` exit 0: 416 files, 9284 tests.
- GitHub CI on PR #39 was green before the merge.

## assumptions
- "Missing" means configured but unreachable or nonexistent. "Not configured" means `RESEARCH_WORKER_TRADER_DATABASE_URL` is unset.

## deviations
- The header pointer replaced the stale line "Implemented by: `STORAGE-1`. Not yet implemented."

## known_risks
- The amendment describes the code at `4603211`. Rules 3 and 6 go stale as `STORAGE-1b`, `STORAGE1-MAXBYTES` and `PROVENANCE-1` land. Each of those rounds should add a dated correction or an Amendment 2.
- **S-GOV-R3-01 (LOW, open).** Rule 1, item 6 says "Only a later read that succeeds, in an execute cycle, clears the mark". That is broader than `rememberEvidence`.
- **S-GOV-R3-02 (LOW).** The out-of-repo handoff's line count was 263; the true count against `4603211` is 262 added, 1 deleted.

## follow_up
1. ADR-029's header and README row still say "not yet implemented". STORAGE-1 implemented it (`a22502b`). Owner: the next docs or governance round.
2. Tighten rule 1, item 6 (S-GOV-R3-01) in that same round.

## commit_sha
`169b7e428a0becb967374c0929c7cbe1d73538f8`
