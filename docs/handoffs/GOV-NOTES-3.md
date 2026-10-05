# GOV-NOTES-3: ROLLOVER-1's owed governance records

**Status:** Complete (2026-10-05). Merged `c10e76e` (PR #70; CI run `37335827614` green). It closes `ROLLOVER1-OWED`.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 2 on `26caa9e`.
**Base:** `f0c58f7`. The branch merged `main` at `467647e` before the PR.
**Paths:**
- `docs/adr/ADR-030-*.md` and `docs/adr/ADR-023-*.md`;
- `docs/contracts/domain.md` and `docs/contracts/protected-contracts.md`;
- the work plan's `ROLLOVER-1` entry.

Docs only.

## summary

1. **ADR-030 Amendment 1** (R2-FABLE-03). It records ROLLOVER-1's implemented admission policies as the orchestrator's interim PAPER rulings (2026-10-05). They change no user ruling (A5, Q1–Q4). There are eight rules, each naming the decision it refines and why it fails closed:
   1. the cap: per series, every live window counts, no eviction;
   2. retirement only once the resolution is published;
   3. resolution finality at the trader;
   4. named operator retirement;
   5. the flat/idle teardown exception (`UNRESOLVED_AFTER_CLOSE`);
   6. the halt-suppression exception (`RESOLVED_UNHANDLED`);
   7. a window held while an allocator commitment names its market (R7-FABLE-03);
   8. checks 16 and 17 judged over every live window (R7-FABLE-01). Item 6 states R8-FABLE-01 without ruling on it.

   A preamble records Decision 3 as merged. The header points to the merge `ae11daa`.
2. **The `SeriesWindowAdmitted@1` records** (R1-FABLE-06):
   - `domain.md`: the event count is 23, and a new §12 gives the ten fields, the producer, the consumer and the schema-version consequence;
   - `protected-contracts.md` §5: a dated row for the user's grant Q1;
   - the work plan's `ROLLOVER-1` entry: dated notes for Q1, Q2 and Q4.
3. **ADR-023 Amendment 1** (R1-FABLE-03(b)). The orchestrator's interim ruling, open to the user:
   - an incident naming only the series-admission reference id (`windowInternalMarketId("series-admission-incident|" + scope, 0)`) is not market-less under D2 rule 4;
   - it names no market and taints no book;
   - the stall, WAL-refusal and ledger-write-failure incidents still taint the epoch.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `062b7f5` | CHANGES REQUIRED | Two HIGHs: an inexact statement of how the reference id's digest bits map into the UUID (GN3-ASTRA-01), and one more. Two MEDIUMs |
| 2 | `26caa9e` | **ACCEPT** | none |

## tests_run
- `lint`, `check:deps` and `test` (11,211) exit 0. No test reads the edited files.
- **CI:** GitHub CI on the PR #70 merge ref was green.

## known_risks
- **R8-FABLE-01** (check 17's netting across windows, and the freshness of other windows' marks) and **R8-FABLE-02** (no test of a held SELL commitment across windows) are recorded in `ROLLOVER1-RESIDUALS`.

## follow_up
1. **The orchestrator:** update the `docs/adr/README.md` rows for ADR-023 and ADR-030. Done in the governance commit.
2. **A risk ruling and a test round** for R8-FABLE-01 and R8-FABLE-02, before any mode above PAPER.
3. **The user** may confirm or overrule ADR-030 Amendment 1 and ADR-023 Amendment 1.

## commit_sha
`26caa9e`
