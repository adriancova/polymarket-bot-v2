# GOV-NOTES-2: the remaining stale wal-format and Prometheus README passages

**Status:** Complete (2026-10-04). Merged `2776a8c` (PR #64; CI run `37258574527` green). It discharges `GOV-NOTES-1` follow_up 1 and `CONTROL-2`'s CTL2-R2-L2.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 2 on `c5e9bf9`.
**Base:** `4562a7c`.
**Paths:** `docs/contracts/wal-format.md` and `infra/prometheus/README.md`. Docs only; it decides nothing.

## summary

Each note is dated 2026-10-04 and names the merged package, its SHA, its date and its record. The original text is unchanged.

1. **`docs/contracts/wal-format.md`** (`WALCAP-1`, `da559ca`):
   - **§2:** the capacity ledger's scope (`rescanSegmentBytes`). The gateway is the only production writer. The ledger assumes one writer per WAL root (ADR-025 D10.3), and nothing enforces that.
   - **§8:** a dated pointer from the `maxSegmentAgeMs` row to §11.1's deferred time rotation.
   - **§11.1:** GN1-R2-01 (the empty-queue sentence) and the wal-format half of GN1-R2-03a.
   - **§12:** the capacity and time-rotation row (the residual is gone; `timeRotationsDeferred` counts the cost), and the single-writer row.
   - **§14:**
     - `capacity-ledger.ts`, `capacity-relief.test.ts` and `capacity-in-flight.test.ts`, each with exactly what it guarantees. The count is never below the disk only when no write is in flight, and admission covers the in-flight half (round 1's HIGH).
     - The CI sentence is corrected: CI has run `test:fault` since `cdfc878`.
2. **`infra/prometheus/README.md`** (`CONTROL-2`, `2f84ad7`):
   - the `trader-halts` group and its `TraderHaltOpenOrUnknown` PAGE alert;
   - `control_trader_halts_state`;
   - the control-api job's `scrape_timeout: 10s`, which must stay above `READ_REFRESH_DEADLINE_MS` (8 s);
   - what the two tests pin.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `837aeae` | CHANGES REQUIRED | GN2-R1-01 HIGH: the relief row claimed the count is never below the disk, even mid-write. GN2-R1-02 MEDIUM: writing. LOW-1 to LOW-4 |
| 2 | `c5e9bf9` | **ACCEPT** | none |

## tests_run
- `lint`, `check:deps` and `test` (485 / 11055) exit 0. That includes `infra-consistency.test.ts`, which scans the README.
- **CI:** GitHub CI on the PR #64 merge ref was green before the merge.

## known_risks
- **Still open in ADR-028, outside this grant:**
  - GN1-R2-02 (`WALCAP-LOWS` has no owner line);
  - the ADR-028 half of GN1-R2-03a;
  - GN1-R2-03b (wording).
- **§12 does not list `WALCAP-1`'s open limits** O-L2 and O-L6. They are residuals with owners, not stale text.

## follow_up
1. **A later docs touch with an ADR-028 grant:** the items above.

## commit_sha
`c5e9bf9`
