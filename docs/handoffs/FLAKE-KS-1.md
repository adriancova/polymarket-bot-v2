# FLAKE-KS-1: fix the kill-switch engage flake in CI step 7/7

**Status:** Complete (2026-10-05). Merged `f66201e` (PR #71; CI run `37342803599` green). It closes `FLAKE-KILLSWITCH-ENGAGE`.
**Reviewer:** Codex gpt-6-astra. ACCEPT at round 1 on `7fadcc1`.
**Base:** `467647e`. The branch merged `main` at `9d2b5ea` before the PR.
**Paths:** `test/integration/control-api/postgres/trader-kill-switch-postgres.test.ts` only. Test-only; no product change.

## summary

1. **The cause, confirmed.** The test's `auditAppendTimeoutMs: 25` applied to every audit append, the must-succeed engage included.
   - Under 20 busy processes, real engage appends reached 77.6 ms.
   - CPU spinners alone never failed the base (0 of 27), because the event loop's phase order let the late response win the timer race.
   - CI's exact failure was reproduced deterministically: a real INSERT held for 100 ms behind a SHARE lock fails 2 of 5 tests at the engage lines, with "did not answer within the 25 ms append bound".
2. **The fix.** The bound is now `AUDIT_APPEND_BOUND_MS = 2_000`, explained in the file's header.
   - The held release still times out, because the holding sink parks its append until `land()`.
   - New pins prove the refusal came from the bound: `CONTROL_NOT_AUDITABLE`; `unsettledAuditAppends` going 0, then 1, then 0; one held append at the refusal.
   - Must-succeed assertions now print the refusal detail if they fail.

## tests_run
- **After the fix:** 20 of 20 pass under load. Held inserts of 100 ms and 1,500 ms pass, and a 2,500 ms hold refuses the engage at the 2,000 ms bound.
- **Mutation:** finality ignored, 2 of 5 fail; VOID ignored, 1 of 5; ordering collapsed, 2 of 5; a holding sink that never holds, 1 of 5.
- **Gates:** typecheck, lint, check:deps, and both control-api suites (310 and 36 tests), green on the merge with `main`.
- **CI:** green on the PR #71 merge ref.

## known_risks
- **A real append slower than 2 s** would still refuse the engage. The failure message would now say why.
- **The file runs about 2.6 s longer.**
- **Other tests with millisecond audit bounds** may carry the same latent race. They are recorded as `AUDIT-BOUND-SWEEP`.

## follow_up
1. **A control-api test round:** `AUDIT-BOUND-SWEEP`.

## commit_sha
`7fadcc1`
