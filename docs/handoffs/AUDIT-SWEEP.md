# AUDIT-SWEEP: remove the latent audit-bound race from control-api tests

**Status:** Complete (2026-10-05). Merged `6044450` (PR #72; CI run `37351695299` green). It closes `AUDIT-BOUND-SWEEP`.
**Reviewer:** Codex gpt-6-astra. ACCEPT at round 1 on `7756571`.
**Base:** `e2b14c1`.
**Paths:** `test/integration/control-api/postgres/audit-sink-postgres.test.ts` only. Test-only; no product change.

## summary
1. **Every `auditAppendTimeoutMs` site** in the control-api test trees (24) is classified in the handoff's table.
   - **22 are deterministic.**
     - Must-succeed appends meet in-memory or timer-driven sinks. `ControlPlane.#write` calls `append` synchronously, then arms the timer, so the append settles in microtasks before the timers phase.
     - Timer sinks run in expiry order.
     - A scratch probe on the real `ControlPlane` confirmed both: 20 of 20 engages landed under a forced stall, and the controls refuse as they should.
   - **Row 24** was already fixed by `FLAKE-KS-1`.
   - **Row 23 was at risk:** `audit-sink-postgres.test.ts` ran eight must-succeed real PostgreSQL inserts under a 250 ms bound.
2. **The fix (row 23).** The bound is now `AUDIT_APPEND_BOUND_MS = 2_000`, and the late engage is still forced by the holding sink. New pins:
   - the refusal names the bound;
   - `held` is 1 at the refusal;
   - `unsettledAuditAppends` goes 0, then 1, then 0;
   - the door refusal is audited.

   No assertion was removed or loosened.

## tests_run
- **Held lock:**
  - with the insert held 400 ms, the base fails at the first engage, with CI's bare signature;
  - the candidate passes at 400 ms and 1,500 ms;
  - at 2,500 ms the candidate is refused at the 2,000 ms bound, and the refusal is printed.
- **Under load:** 18 of 18 runs pass. Real appends ran p50 7.8 ms, max 51.5 ms.
- **Mutants:** 4 of 4 caught on the candidate. The base let M-UNSETTLED through.
- **Gates:**
  - typecheck, lint and check:deps;
  - unit: 11,542;
  - control-api `test:integration`: 310;
  - control-api `test:integration:postgres`: 36.
- **CI:** green on the PR #72 merge ref.

## known_risks
- **A real insert slower than 2 s** would still refuse a must-succeed step. The failure now prints why.
- **`apps/control-api/src/testing/index.ts`** is outside the paths. It composes the default bound over an in-memory log, which is deterministic.

## follow_up
- None.

## commit_sha
`7756571`
