# CKPT-1: ADR-027, checkpoint on change plus a 60 s heartbeat

**Status:** Complete (2026-10-03). Merged `891ccdd` (PR #56; CI run `37161139762` green). It closes `DURABLE-1` LOW-3.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 1 on `f86d87e`.
**Base:** `ebed242`. The branch merged `main` at `85b81e5` before the PR.
**Contract:** ADR-027 (Accepted; user ruling A2), Decisions 1–5.
**Posture:** PAPER only.

## summary

1. **D1, the transition rule** (`packages/strategy-runtime/src/transitions.ts`).
   - After a persisted decision, a checkpoint is written only for one of six reasons:
     - a state change: the canonical bytes differ;
     - a status change;
     - an RNG change: the four lanes differ;
     - the start: a fresh runtime's first decision;
     - the stop: `onStop`;
     - a heartbeat: 60 s of `evaluatedAt` since the last checkpoint's decision. 60,000 ms is due, and 59,999 ms is not.
   - The rule is pure and never throws.
   - `DECIDED` and `CONTAINED` outcomes carry `checkpointTransitions`. Their `checkpoint` is `null` when none was owed.
2. **D2, restore.**
   - `restoreFrom` takes a `StrategyRestorePoint`: the last checkpoint, the highest durable `evaluationSeq`, and the checkpointed decision's `evaluatedAt`, from which the heartbeat restarts.
   - The next sequence is the highest durable sequence plus one.
   - A restored runtime's checkpoints are byte-identical to an uninterrupted run's. An inconsistent restore point is refused.
   - `rebuildStateFromPatches` still works.
3. **D3, durable together: one transaction.**
   - **Why this option.** The alternative, detecting a missing checkpoint at restore, cannot see RNG changes: no decision row records the generator's state.
   - **The outbox** pairs each decision with its checkpoint.
   - **The `DURABLE-1` boundary** writes the pair together in group mode and in single mode.
   - **The store port** gains `persistDecisionWithCheckpoint` and loses `saveCheckpoint`. `PostgresTraderStore` writes the pair as one SQL statement.
   - **A `SAVE_CHECKPOINT` failure** latches a GLOBAL halt and drops the outbox, so a decision is never written without its checkpoint.
   - This closes `DURABLE-1` LOW-3.
4. **D5, the re-pins.** Every test ADR-027 §5 names is re-pinned, and each change is explained in its file. Others found by search are re-pinned too.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `f86d87e` | **ACCEPT** | None. astra first rated PG-RNG-STATUS HIGH, and agreed to LOW in reconciliation (see known_risks). |

## tests_run

- **Gates on `f86d87e`**, all exit 0:
  - typecheck, lint and check:deps;
  - unit: 473 / 10546, against a base of 472 / 10520;
  - e2e: 9/216;
  - replay: 3/19;
  - integration:
    - trader: 39/287, on attempt 2; attempt 1 failed when a Redis container never started;
    - event-bus: 10/112;
    - storage-postgres: 15/228.
- **Fails at base:** 6 of the 7 new loop tests and 6 of the 6 new PostgreSQL tests. At base, the entry decision is durable without its checkpoint in both modes.
- **The H1 burst** (99,669 envelopes, base `ebed242` against the candidate):
  - checkpoints fall from 134 to 3: the start, and heartbeats at sequences 59 and 119;
  - decisions are byte-identical to base;
  - each remaining checkpoint row equals base's row at the same sequence;
  - repeated runs are byte-identical.
- **Goldens.** Only checkpoint counts moved, and every other byte was checked against base:
  - paper-e2e: 12→10 and 19→15;
  - the backtest store line: 12→10;
  - the throughput sample: 4→2.
- **Mutation:** 14 of 14 killed: each D1 transition, the heartbeat bound, the D2 sequence rule and guard, and the D3 pairings.
- **CI:** GitHub CI on the PR #56 merge ref was green before the merge.

## assumptions
- **"Start"** is the first decision of a runtime created without a restore point.

## deviations
- **Public API changes:**
  - the `TraderStore` port's shape;
  - `restoreFrom`, which now takes a `StrategyRestorePoint`;
  - a nullable `checkpoint` on outcomes.

  Nothing in production restores, so no product caller changed.
- **`captured_at` can change in one rare case.** A checkpoint made durable at the boundary, during a lifecycle callback inside a longer frame, gets that event's instant rather than the frame's last. No golden or bench row moved (LOW-2).

## known_risks
- **PG-RNG-STATUS (LOW, agreed).**
  - **The gap.** `strategy.state_checkpoints` stores neither the checkpoint's RNG lanes nor its status, because `apps/trader`'s `checkpointRow` drops them. So a PostgreSQL restore cannot recover either.
  - **Why LOW.** The writer is byte-identical to base, so the gap is pre-existing. Nothing in production restores. A fix needs a migration, or a change to what `state` means.
  - **What it needs.** A user ruling, before any production restore exists. It is recorded as the residual `CKPT1-PG-RNG-STATUS`.
- **LOW-2:** the boundary `captured_at` case above.
- **INFO-2.** The heartbeat's restore anchor is supplied by the caller. A millisecond-truncated `evaluated_at` can shift one heartbeat at an exact 60 s boundary.
- **The heartbeat needs evaluations.** An instance that is not evaluated writes nothing.

## follow_up
1. **The user:** rule on storing the checkpoint's RNG lanes and status, by new columns (a migration) or by the whole document in `state`. This must close before a production restore.
2. **`ROLLOVER-1` Q2, if granted**, needs from this design:
   - a run-scoped sequence source, seeded once per run by `restoreFromPoint`;
   - checkpoint rows that name their window: `checkpointRow` writes `market_id` as NULL today, and populating it needs no migration.

   The transition rule, D3 and both unique keys are unchanged under Q2.
3. **`HOST-BENCH`:** measure the database saving.

## commit_sha
`f86d87e3248ab68730c335a00a98cbe12f44a148`
