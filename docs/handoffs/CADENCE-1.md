# CADENCE-1: ADR-026 evaluation cadence — once per market per second of event time, 5 s heartbeat

**Status:** Complete (2026-10-03). Merged `8d7086a` (PR #53; CI run `37140145650` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 4 on `11ac885`.
**Base:** `6e918fc`, relaunched there after the first implementer's correct STOP. The branch merged `main` at `f694746` before the PR.
**Grants (orchestrator, 2026-10-03, brief `dcd22e9`):**
- Q1: an additive migration `0010`, on the WP-210 precedent;
- Q2: the `ReplayRunPins` door in `packages/simulation`;
- Q3: `infra/grafana/control` and `infra/prometheus`;
- Q4: one dated ADR-026 D2.11 correction.

**Posture:** PAPER only.

## summary

- **The rule.** `packages/trading-core/src/cadence.ts`, wired into `CoreLoop`, runs on the high-water mark of applied event instants. Refused events never move it.
  - At each frame close, the markets the frame owed are decided first, in ADR-024 D3's order: evaluated when D2.4 allows, otherwise coalesced and carried.
  - Then the other markets, in configured order: a carried market once 1000 ms have passed, any market once 5000 ms have passed. Each takes the frame's last applied event as its source.
  - A carried evaluation's own fills, order views and ledger booking are harvested at that same close, in the ordinary harvest's order (rounds 2 and 3).
  - A frame with no applied event evaluates nothing. Halted markets drop what they were owed. Every other callback fires in place.
  - The value 0/0 reproduces ADR-024 exactly: 928 decisions on the committed H1 sample.
- **The settings.** One policy, `evaluationCadenceProblem`: 1000/5000, or 0/0 only with a declared reproduction.
  - It is enforced by `createPaperTrader` (`TRADER_CADENCE_REFUSED`), by the `CoreLoop` constructor, and by `assembleBacktestCore` (`BACKTEST_CADENCE_REFUSED`).
  - `backtest-cli run --reproduces <what>` declares a reproduction, and the artifact (now v2) records the cadence.
- **The run record (Q1).**
  - Migration `0010` adds nullable `strategy.runs.evaluation_interval_ms` and `evaluation_heartbeat_ms`, with three checks, and adds both columns to `runs_immutable_pinning`. It rolls back exactly.
  - `StartRunInput` requires both values.
  - The trader's registration check refuses any run row other than 1000/5000, and the register command writes 1000/5000.
- **Replay (Q2).** `ReplayRunPins` gains both values through the strict door.
- **Surfaces (Q3).**
  - `evaluationsCoalesced` and `cadenceForwardJumpAlarms` are added to `LoopHealth`, the strict control-api health door, and the metric shapes, families and samples.
  - Two Grafana panels, and a `TraderCadenceForwardJump` page rule in `infra/prometheus/trader-alerts.yaml`.
  - `main.ts` logs `CADENCE CLOCK FORWARD JUMP: …` as the page line.
- **ADR-026 D2.11 (Q4).** One dated correction: a halted market is skipped and drops what it was owed; no lifecycle gate exists for a closed market.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `33f7c5d` | CHANGES REQUIRED | J1 HIGH: a harvest instant was overwritten. J2 HIGH: `markEvaluated` ran before an evaluation that could be skipped. O02 MEDIUM |
| 2 | `3035c51` | CHANGES REQUIRED | RA HIGH: a carried evaluation's own effects waited for an unbounded harvest |
| 3 | `5df1608` | CHANGES REQUIRED | A-R3-01 HIGH: the carried harvest double-counted capital. A-R3-02 HIGH: an order placed in the carried harvest missed its same-close update |
| 4 | `11ac885` | **ACCEPT** | none; LOWs open |

## tests_run

- **Goldens, each checked mechanically against base:**
  - paper-e2e moves from format 4 to 5, as a declared 0/0 reproduction. Only the format, a cadence section and two zero counters moved. At 1000/5000 the scenarios give the same results apart from the cadence section.
  - The backtest artifact moves from v1 to v2.
  - The simulation golden's pins gain 1000/5000.
  - The throughput harness pin moves from 928 to 4 decisions.
- **Bench** (the H1 burst, 99,669 envelopes, base `6e918fc` against the candidate):
  - decisions fall from 46,666 to 134; 46,532 coalesced plus 134 equals base's count exactly;
  - each candidate decision equals base's at the same source event;
  - catch-up throughput rises from 874 to 8,440 events/s;
  - paced max lag falls from 8.56 s to 0.07 s.
- **Mutation:** 28 mutants; 3 first survived, and each was killed by an added test. Round 4 found three new unpinned guards (LOW).
- **Gates** were green per round, and GitHub CI on the PR #53 merge ref was green before the merge.

## assumptions
- The cadence settings are policy constants, with no configuration-document field.

## deviations
- The first implementer stopped before any change, as its packet required, because the run record needed a schema change. The orchestrator granted Q1–Q4.

## known_risks
- **CAD1-R4-01 (LOW).** Three round-3 guards in `loop.ts` are correct but unpinned.
- **O-R3-01 (LOW).** A heartbeat can see a position whose order's reservation was released at its FILLED view. In a probe, a per-strategy cap of 8 pUSD was passed at 10.20 pUSD. The reviewers found the ordinary harvest does exactly the same, so this predates CADENCE-1. It is a capital-cap concern, recorded separately as `CAP-OVERSHOOT` for a risk and allocator review.
- **O07 (LOW).** Four suites keep reproduction-only (0/0) coverage.
- **O11.** The first implementer ran a host-wide `docker container prune`. What it removed cannot be audited. Packets now forbid host-wide Docker cleanup.
- **INFO.** `evaluationsCoalesced` excludes owed markets stopped by the snapshot gate. `simulation-run/v3` and the approximate artifact omit the cadence pins.

## follow_up
1. **A trading-core round** pins CAD1-R4-01's guards and widens the 0/0-only suites (O07).
2. **`CAP-OVERSHOOT`:** a risk and allocator review of reservation release at FILLED, before any live mode.
3. **The cadence pins** go into the simulation-run and approximate artifacts.
4. **`ROLLOVER-1`** and then **`CKPT-1`** follow, on `packages/trading-core`.

## commit_sha
`11ac885aa18de2f1739615ea399c8a1d9dd3b08c`
