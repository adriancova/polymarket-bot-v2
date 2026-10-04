# TC-LOWS-1: pin the open trading-core and trader LOWs

**Status:** Complete (2026-10-04). Merged `9033743` (PR #58; CI run `37186825618` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Round 6 reported the candidate acceptable once the orchestrator granted one test file. The orchestrator granted it and landed the reviewed patch unchanged as `5640c22`.
**Base:** `0c84b87`. The branch merged `main` at `be47edd` before the PR.
**Items:** `CADENCE1-LOWS` CAD1-R4-01 and O07; `CO2N1-LOWS` J1–J4; `PROV1-LOWS` R2-L2 and R2-L3.
**Posture:** PAPER only. Behaviour is preserved everywhere except the R2-L2 forced exit.

## summary

1. **CAD1-R4-01: closed.** Three pins in `packages/trading-core/src/loop-cadence.test.ts` compare the carried path with the ordinary path:
   - MZ9: a RESTING own order keeps its reservation;
   - MZ8: a canceled own order is released before `onFill`;
   - MZ6: an order an `onFill` decision cancels gets its CANCELED view and release at the same close.

   Each mutant fails only its own pin.
2. **O07: closed.**
   - The book-freshness, loop-folds, loop-long-run and loop-refused-plan suites run every loop test twice: at 0/0 under its original name, and at 1000/5000.
   - Each production difference is explained from ADR-026 at its assertion.
   - A harness forced back to 0/0 fails in all four files.
   - At base, these suites at 1000/5000 gave 46 failed of 117.
3. **`CO2N1-LOWS`: closed.**
   - J1: the `TransportHealth` header in `health.ts` is corrected.
   - J2: `durable-halts-and-refusals-postgres-redis.test.ts` is re-based; scenario 4 now pins `RISK_WORST_CASE_LOSS_EXCEEDED` exactly.
   - J3: the `host-clock.ts` comment states that its lag is `max(0, W − E)`.
   - J4: a frame whose events carry differing receipt instants kills the `#lastEpochMs` mutant.
4. **R2-L2, the forced exit: closed.**
   - `apps/trader/src/process-exit.ts` `exitAfterStartup` sets the exit code, then arms an unreferenced 1,000 ms grace timer.
   - If something still holds the process when the grace ends, it logs `PROCESS EXIT FORCED`, naming the holders, and exits with the same code once every logged line has drained. Round 1's HIGH, a backstop that dropped queued `HALT` lines, is fixed.
   - It runs only after `startup()` has returned, when every durable outcome is final.
5. **R2-L3, the operator bound line: closed by grant.**
   - **The fix.** `main.ts`'s step-2c line now says what happens at 5,000 ms: the record reports UNCONFIRMED and destroys the connection it holds. A connection the pool is still opening is ended only by the pool's 10,000 ms timeout. The line also covers the exit grace.
   - **Why it took six rounds.** Its only pin is verbatim in `test/unit/trader/startup-redis-refusal.test.ts`, outside the grant. The implementer stopped it in round 0 with a ready patch, and rounds 2–6 had no other blocker.
   - **How it landed.** The orchestrator granted that one expectation, as the joint round-6 report required, and landed the patch unchanged.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `f74e08b` | CHANGES REQUIRED | TCL1-R1-01 HIGH: the forced exit could drop queued halt lines. TCL1-R1-02 MEDIUM: R2-L3 not delivered |
| 2–6 | `4a922ff` … `45f3a41` | CHANGES REQUIRED | Only TCL1-R1-02, blocked by the grant. Round 6: "at a fixed point" |
| grant | `5640c22` | — | The orchestrator's grant lands the patch that both verifiers validated on `45f3a41` (23/23; `tsc` exit 0) |

## tests_run

- **Implementer, round 0 (`f74e08b`):** gates all exit 0.
  - unit: 482 / 10895;
  - e2e: 9/216;
  - replay: 3/19;
  - trader integration: 40/291;
  - event-bus integration: 10/112.
- **Goldens:** `git diff --quiet 0c84b87 -- test/replay-golden` holds. The throughput harness's decision digest is unchanged.
- **Mutation:** 23 of 23 killed.
- **Orchestrator, on `5640c22`:** typecheck, lint and check:deps exit 0; unit 482 / 10905.
- **CI:** GitHub CI on the PR #58 merge ref was green before the merge.

## assumptions
- The exit bound: a 1,000 ms grace, plus the time stderr takes to drain.

## deviations
- **The R2-L3 grant**, recorded above.
- **J2 tightens one assertion:** scenario 4 now pins its codes exactly.

## known_risks
- **TCL1-R2-02 (INFO).** The forced exit is bounded by the grace plus however long the log takes to drain. It is fail-safe: no line is dropped.
- **TCL1-R3-01 (INFO, pre-existing).** If the log consumer goes away while `startup()` is still writing, the process exits 1, not 75.
- **Flakes recurred in the verifiers' gates:**
  - `FLAKE-CANONICAL-ORDER` in `packages/features`;
  - a first-attempt trader integration flake (`TC-LOCAL-FLAKE`).

  Neither is caused by this round.
- **LOWs from round 1:**
  - TCL1-R1-03: the L2 scenario does not assert which socket holds the process;
  - TCL1-R1-04: the O07 X1 heartbeat rationale is unpinned.

## follow_up
1. **A features test round:** `FLAKE-CANONICAL-ORDER`.
2. **Still open in `CADENCE1-LOWS`:** the cadence pins in the simulation-run and approximate artifacts.

## commit_sha
`5640c22`
