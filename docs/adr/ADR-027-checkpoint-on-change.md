# ADR-027: Strategy checkpoints on change, plus a 60 s heartbeat

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling A2).
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `CKPT-1`, after `CADENCE-1`. Not yet implemented.
- **Supersedes / Superseded by:** none. It defines the transitions that §9.6
  and ADR-005 §5 leave open. It refines `WP-170` decision 4.
- **Handoff sections:** §6 (invariants 3 and 8), §9.6, §10.3, §12.4.
  **ADRs:** ADR-005, ADR-024, ADR-026.

## Context

1. §9.6 says the runtime must "Checkpoint strategy state after defined
   transitions." ADR-005 §5 repeats it: "Strategy state is checkpointed after
   defined transitions and restored on restart only when compatible (§9.6)."
   Neither says which transitions.
2. `WP-170` chose the simplest answer: one checkpoint after every persisted
   decision. Its decision 4 says a `hold` with zero intents "takes the ordinary
   DECIDED path — one record, one checkpoint". The runtime's module header
   says "a persisted decision ALWAYS has its checkpoint" and "checkpoint state
   after every persisted decision". `OUTAGE-2` records the result:
   `checkpointSeq == evaluationSeq`.
3. So checkpoints grow as fast as decisions. `LEAN-1` §4 estimates at most
   105 MB a day per market with today's checkpoints, and at most 50 MB after
   this change.
4. A checkpoint carries the strategy state bytes, the instance status, and the
   seeded RNG's state (`WP-170` decision 7). The evaluation sequence is on every
   decision row.
5. No production code restores a checkpoint today. Every trader start is a new
   run, and `restoreFrom` has no production caller (`DURABLE-1`, LOW-3).
6. `DURABLE-1` LOW-3 is open: in group-commit mode a decision and its checkpoint
   can commit in separate transactions.

## The ruling

The user's ruling A2 (`docs/handoffs/LEAN-1.md`, "The user's rulings
(2026-09-30)"):

> **A2 + A3: yes to both.** Checkpoints only on state change (plus a 60 s
> heartbeat).

The proposal the user accepted (`LEAN-1` §6, row A2):

> Save a strategy checkpoint only on a defined transition (a state change, a
> status change, start and stop), plus a 60 s heartbeat. It must keep the RNG
> cursor and callback sequence recoverable.

## Decision

### 1. The defined transitions

After a persisted decision, the runtime writes a checkpoint only when one of
these holds:

1. **State change:** the canonical state bytes differ from the last
   checkpoint's.
2. **Status change:** the instance status differs from the last checkpoint's.
   For example, the instance was paused.
3. **RNG change:** the seeded RNG's state differs from the last checkpoint's.
   That is, the callback drew from `ctx.rng`, or a rollback moved it.
4. **Start:** the first decision of an instance in a run.
5. **Stop:** the decision of `onStop`.
6. **Heartbeat:** at least 60 s of event time have passed since the last
   checkpoint's instant.

Every other decision writes no checkpoint. The heartbeat uses the decision's
`evaluatedAt`, so it needs no wall clock.

### 2. What stays recoverable

1. **The state and the RNG cursor.** By rule 1, a decision that changed either
   one has a checkpoint. So the last checkpoint holds the current state and
   RNG state.
2. **The callback sequence.** Every decision row keeps its `evaluationSeq`,
   as today. The next sequence is the highest persisted `evaluationSeq` of the
   instance, plus one. It is not the checkpoint's sequence.
3. A checkpoint keeps its sequence number: the `evaluationSeq` of the decision
   it follows. Checkpoint sequences are no longer contiguous.
4. **Rebuild without checkpoints still works.** `rebuildStateFromPatches` folds
   the persisted `statePatch` values, as `WP-170` decision 8 requires.

### 3. A decision and its checkpoint become durable together

1. A decision that owes a checkpoint and that checkpoint must commit in one
   transaction. Or, a restore must detect a durable decision whose owed
   checkpoint is missing, and refuse.
2. Either way, a restore never resumes from a checkpoint that is older than a
   durable decision which changed the state, the status or the RNG.
3. `CKPT-1` chooses one and argues it. This closes `DURABLE-1` LOW-3.

### 4. Determinism

1. Which decisions write a checkpoint is a pure function of the evaluations.
2. The same dataset, settings and seed give byte-identical checkpoints
   (§12.4).

### 5. The tests to re-pin

These tests pin "one checkpoint per decision" today. `CKPT-1` re-pins each one
to the rule above and explains each change. It also searches for others.

- `test/unit/strategy-runtime/checkpoint.test.ts`: "a checkpoint is written
  after EVERY persisted decision and pins the full run identity".
- `test/unit/strategy-runtime/decision-persistence.test.ts`: "pins the no-op
  semantics: a hold with ZERO intents is persisted like any other decision
  (ADR-005 §2)" (`WP-170` decision 4), and "evaluation sequence numbers are
  contiguous and match the checkpoint sequence".
- `test/unit/strategy-runtime/determinism.test.ts`: the restore and rebuild
  cases.
- `test/unit/strategy-runtime/boundary-snapshots.test.ts`: "a clock that fails
  AFTER the callback is CONTAINED with one record, one checkpoint, and no
  claimed duration".
- `test/integration/paper-trader/redis-outage-halts-postgres-redis.test.ts`
  (`OUTAGE-2`): its settle compares checkpoints 1:1 with decisions.
- The `DURABLE-1` tests: `test/integration/paper-trader/durable-decision-before-placement.test.ts`,
  `test/integration/paper-trader/durable-decision-before-placement-postgres.test.ts`,
  `test/e2e/durable-decision-protective-reduce.test.ts`, and the `DURABLE-1`
  block of `packages/trading-core/src/loop-refused-plan.test.ts`.
- Any paper-e2e or throughput golden that counts checkpoints.

## What it amends

| Text | As written | How it now reads |
| --- | --- | --- |
| Handoff §9.6 | "Checkpoint strategy state after defined transitions." | Unchanged. Decision 1 defines the transitions |
| ADR-005 §5 | "Strategy state is checkpointed after defined transitions and restored on restart only when compatible (§9.6)." | Unchanged. Decision 1 defines the transitions |
| `WP-170` decision 4 | "A `hold` with zero intents therefore takes the ordinary DECIDED path — one record, one checkpoint" | One record, as before. A checkpoint only if Decision 1 requires one |
| `strategy-runtime` module header | "a persisted decision ALWAYS has its checkpoint"; "checkpoint state after every persisted decision" | A persisted decision that meets Decision 1 always has its checkpoint (Decision 3). Other decisions have none |

Not amended, and kept word for word: §6 invariant 3 (one decision per
callback), §6 invariant 8, and the `WP-170` acceptance "Same event/config/seed
yields identical state and decisions."

## Consequences

- **The database shrinks again.** `LEAN-1` estimates about half of today's
  checkpoint volume or less. `HOST-BENCH` measures the real saving with
  `count(DISTINCT state_hash)` on the H1 databases.
- **Restore gets more complex.** It needs the last checkpoint and the highest
  `evaluationSeq`. The design must be reviewed in `CKPT-1`.
- **After ADR-026 this is an optimisation.** It blocks no launch round.

## Evidence

- `docs/handoffs/LEAN-1.md` §4, §6 row A2, §9 item 5, and "The user's rulings
  (2026-09-30)".
- `docs/spec/polymarket-bot-orchestrator-handoff.md` §9.6.
- ADR-005 §5.
- `docs/handoffs/WP-170.md`, decisions 4, 7 and 8.
- `docs/handoffs/OUTAGE-2.md` and `docs/handoffs/DURABLE-1.md` (LOW-3).
- `packages/strategy-runtime/src/runtime.ts` (module header).
- No venue fact is used.
