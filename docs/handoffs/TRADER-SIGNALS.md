# TRADER-SIGNALS: a graceful trader stop, and paper fills in the example PAPER config

**Status:** Complete (2026-10-05). Merged `3926f5f` (PR #77; CI run `37413213645` green).
**Reviewer:** Claude Fable (`adversarial-reviewer`). Its evidence spawns processes and sends signals, which Codex's sandbox blocks. ACCEPT at round 1 on `7683513`.
**Base:** `f0243f7`. The orchestrator gated it combined with `CI-6` before the merge.
**Paths:** `apps/trader/src/**`, `apps/trader/README.md`, `infra/compose/trader/**` and `test/integration/paper-trader/**`.
**Authorized by the user, 2026-10-05:** the graceful stop round, and paper fills in PAPER configs.

## summary

1. **The graceful stop** (`apps/trader/src/graceful-stop.ts`, installed first in `main.ts`):
   - **The first SIGINT or SIGTERM requests a stop.** It logs `STOP REQUESTED`, and the deadline starts.
   - **The pump** checks for the request before every poll, after the halt check, so a latched halt always wins. The batch in hand has already finished its durable writes and recorded its position. The pipelined path settles its pending batch first.
   - **`runUntilStopped`** runs the halt path's sequence:
     1. `FOLD-1`'s SHUTDOWN rebuild check, with its existing lines;
     2. the halt record, if a halt is latched;
     3. the closes, in reverse order of opening. A close that throws is logged, and the rest still run;
     4. `trader stopped: exit <code>`.
   - **Exit codes:**
     - 0: a clean stop;
     - 75: any halt is latched (a stop never clears a halt);
     - 70 (new): the SHUTDOWN check failed. It wins over 75;
     - 124 (new): the stop missed `TRADER_SHUTDOWN_DEADLINE_MS`. The default is 8 s, and 1–60 s is accepted;
     - 130 (new): a second signal arrived.
   - **Nothing new is recorded:** `strategy.runs.status` stays `RUNNING` on every exit.
   - **`main.ts`'s misleading header** is fixed.
2. **Paper fills.** The example PAPER config (`infra/compose/trader/trader.config.example.json`) sets `settlementReadiness.modelDependentActivationAllowed: true` for `btc-15m-updown`.
   - Both READMEs call it the owner's PAPER-only operator assertion, not a recorded review. The spec stays `UNVERIFIED`, and a live configuration must not copy it until a review can be recorded (gaps G-1 to G-10).
   - A pin ties the flag to `environment: PAPER`.

## tests_run
- **Measured on the shipped bundle,** against real PostgreSQL and Redis:
  - SIGTERM and SIGINT exit 0 in 18–200 ms;
  - a signal during a halt keeps exit 75;
  - a second signal exits 130;
  - a stuck stop at a 1 s deadline exits 124 at about 1,010 ms.
- **Unit and sequence tests:** the stop sequencing, using injected fakes.
- **A process-level integration test:** `graceful-stop-postgres-redis.test.ts`, 5/5.
- **Mutation:** all caught.
  - no handlers: 5/5 integration tests fail;
  - the pump ignores the stop: both clean-stop tests and 8/21 sequence tests fail;
  - the old close order: 8/21 sequence tests fail;
  - a pipelined stop that skips settle: the pipelined sequence test fails;
  - an exit code that ignores latched halts: 2 sequence tests fail.
- **Gates:**
  - typecheck, lint and check:deps;
  - unit: 11,956;
  - e2e: 216;
  - replay: 19;
  - fault;
  - live-safety: 74;
  - live chaos: 95;
  - control-api integration: 310.
- **The trader integration suite:** every failure was the local Testcontainers flake (`TC-LOCAL-FLAKE`), and each failed file passed when re-run alone.
- **The orchestrator's combined gate** (this round plus `CI-6`, scratch merge `94e2b60`), all exit 0:
  - typecheck, lint and check:deps;
  - unit: 11,956;
  - e2e: 216;
  - replay: 19;
  - contract;
  - the new `test:fault` chain: 89 + 7 + 848 + 74 + 95;
  - trader integration: 409/409, on the first run;
  - control-api integration: 310.
- **CI:** the PR merge ref was green before the merge.

## known_risks
- **TS-R1-01 (LOW).** "A latched halt always wins over a stop" has no test: swapping the halt and stop checks at the pump's loop top survives the trader suites.
- **TS-R1-02 (LOW).** `halt-record.ts`'s comments still say the exit is 75 unconditionally, but a SHUTDOWN mismatch now exits 70. Still non-zero.
- **A forced or late exit (124 or 130) can hide a latched halt's 75.** Its last line names the halts, and the halt record runs before the closes.
- **A signal during module load,** or within the 1 s exit grace, gets Node's default handling.

## follow_up
1. **A small trader round:** a pin for TS-R1-01, and the wording of TS-R1-02 and the MISMATCH line.
2. **Governance (done with this record):** a correction line in `FOLD-1.md` (a SHUTDOWN mismatch now exits 70). FOLD-1's residual is closed, since the SHUTDOWN path through `startup()` is now exercised.
3. **For the operator (H1, burn-in):** end runs with Ctrl-C so that the SHUTDOWN check is logged. To read the trader's own exit code, run `node apps/trader/dist/main.mjs`.
4. **Optional, for the user:** record `strategy.runs.status = 'STOPPED'` on a clean stop.

## commit_sha
`7683513`
