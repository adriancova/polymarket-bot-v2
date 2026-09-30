# ADR-026: Evaluation cadence: at most one `onFeatures` evaluation per market per second of event time

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling A1).
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `CADENCE-1`, after `THROUGHPUT-1c` merges. Not yet
  implemented.
- **Supersedes / Superseded by:** none. It **amends** ADR-024 D3 and its
  Consequences.
- **Handoff sections:** §6 (invariants 3, 4 and 15), §7.5, §8.1, §9.6, §12.4,
  §12.5. **ADRs:** ADR-005, ADR-022, ADR-024.

## Context

1. ADR-024 made the trader evaluate `onFeatures` once per venue frame, for each
   market the frame touched. On the H1 burst that is 46,666 decisions from
   99,669 events.
2. Evaluation is most of the trader's CPU. After `THROUGHPUT-1a`, about 82-83%
   of trader CPU was inside `#evaluateMarket` (ADR-024, Context 5).
3. Decision rows dominate the database. `LEAN-1` §4 puts today's PostgreSQL
   growth at about 11.7 GB a day for one market.
4. `LEAN-1` proposed a cap of one evaluation per market per second. The user
   accepted it.
5. The loop's event time is each envelope's `receivedAt`, normalized to strict
   UTC (`CoreLoop`). Replay uses the recorded value. The loop reads no wall
   clock to decide anything. The instants are gateway stamps, so they may
   repeat or step backwards (`loop.ts`, `#writtenSnapshotKeys`).
6. There is no timer in the loop today. The gateway's 1 s tick drives WAL and
   feed maintenance only. It publishes nothing to the trader (`LEAN-1` §2).

## The ruling

The user's ruling A1 (`docs/handoffs/LEAN-1.md`, "The user's rulings
(2026-09-30)"):

> **A1: yes, once per second.** Evaluate each market at most once per 1 s of
> event time, plus a 5 s heartbeat; fills, order updates, lifecycle and stop
> callbacks are never delayed.

The proposal the user accepted (`LEAN-1` §6, row A1):

> Evaluate each market at most once per 1 s of event time: whenever any event
> touched it, plus a 5 s heartbeat when quiet. Fills, order updates,
> lifecycle and stop callbacks are never delayed.

## Decision

### D1. Two run settings, pinned in the run manifest

1. `evaluationIntervalMs`: the shortest event-time gap between two `onFeatures`
   evaluations of one market. The default is **1,000**.
2. `evaluationHeartbeatMs`: the longest event-time gap after which a market is
   evaluated even if no event touched it. The default is **5,000**.
3. Both are run settings. They are recorded in the run manifest (§8.2, §12.5)
   of every run, live or replay. A change to either starts a new run (§9.6).
4. `CADENCE-1` may also offer `evaluationIntervalMs` = 0, meaning ADR-024's
   per-frame cadence, unchanged. If it does, the value 0 is pinned like any
   other. It exists so that older goldens and H1 comparisons stay
   reproducible.

### D2. The rule, per market

All times are event times: the `receivedAt` instant of an event, as the loop
already uses it.

1. A market is **owed** an evaluation when an event touches it in the sense of
   ADR-024 D3. That is, when the per-frame cadence would have evaluated it.
2. The check runs only at a frame close (ADR-024 D2). Let `t` be the instant of
   that frame's last event, and `last` the instant of the market's last
   `onFeatures` evaluation in this run.
3. At the frame close, a market is evaluated when one of these holds:
   - it is owed, and it has no `last` in this run;
   - it is owed, and `t − last ≥ evaluationIntervalMs`;
   - `t − last ≥ evaluationHeartbeatMs`, whether or not it is owed.
4. Otherwise it is **not evaluated** at this close. If it is still owed, it
   stays owed until a later close.
5. A later close may belong to a frame that does not touch the market. A market
   that is still owed is evaluated at the first close where rule 3 allows it.
6. If `t` is earlier than `last`, event time stepped backwards. The market is
   evaluated if it is owed, and `last` becomes `t`. So a backward step never
   stops evaluation.
7. The usual gates still apply. A halted or closed market is not evaluated, as
   today.
8. Markets are evaluated in the order ADR-024 D3 gives. Where that order says
   nothing (a market not touched by the frame), the stable configured order of
   §8.2 decides.

### D3. The decision's source event

1. If the frame at whose close the evaluation runs owed the market an
   evaluation, the source event and `evaluatedAt` follow ADR-024 D3 unchanged.
2. Otherwise they are the frame's last event and its instant.
3. So every decision still names a real source event, and §6 invariant 4's
   chain is complete.

### D4. Every other callback is never delayed

1. Only `onFeatures` is throttled.
2. `onFill`, `onOrderUpdate`, `onStart`, `onStop`, `onMarketOpen`,
   `onMarketClosing`, `onMarketResolved` and `onTimer` fire exactly when they
   fire today.
3. Every event is still ingested and applied to the books, trades, reference
   prices and incidents. None is skipped. `eventsProcessed` still counts every
   event.

### D5. A skipped evaluation is not a callback

1. §6 invariant 3 is kept: "Every strategy callback produces exactly one
   persisted `DecisionResult`."
2. §7.5 is kept: the runtime "persists exactly one decision record after the
   callback returns."
3. A skipped evaluation is not a callback. The strategy is not invoked, so no
   record is owed.
4. This follows the `WP-170` precedent. A `REFUSED` outcome means "the callback
   was **never invoked** … so §6 invariant 3 does not bind and **no** record
   exists" (`docs/handoffs/WP-170.md`, decision 5).
5. Each skip of an owed market is counted in a new health counter,
   `evaluationsCoalesced`. `evaluations` and `decisionsPersisted` keep their
   meaning.

### D6. Determinism

1. Which evaluations run is a pure function of the delivered sequence and its
   recorded instants.
2. The loop reads no wall clock for it. Replay of the same dataset with the
   same settings gives byte-identical decisions (§12.4).
3. `CADENCE-1` lists and explains every golden that changes.

### D7. The interaction with `CO2-N1`

1. `CO2-N1` is an open residual: "Live admission (risk freshness, book age,
   seconds-to-close) runs on event time (`envelope.receivedAt`), so a stale
   backlog can approve entries after close."
2. This cadence also runs on event time. It is required for replay
   determinism (D6).
3. So during a backlog, the trader still evaluates at the recorded pace: one
   evaluation per market per second of **recorded** time. It does not skip
   more to catch up. Fewer evaluations do shorten the backlog.
4. This ADR neither fixes nor worsens `CO2-N1`. `CO2-N1` must still close before
   any settlement veto is lifted and before `WP-270`.
5. If `CO2-N1`'s fix brings processing time into admission, the cadence stays
   on event time. The two clocks are separate.

## What it amends

| Text | As written | How it now reads |
| --- | --- | --- |
| ADR-024 D3 | "What moves to the frame's CLOSE (`CoreLoop.#closeFrame`) is: the `onFeatures` evaluation of each market the frame touched, ONCE per market;" | At the frame's close, each market is evaluated only if D2 allows it: owed and at least `evaluationIntervalMs` of event time since its last evaluation, or `evaluationHeartbeatMs` since it. A market still owed is evaluated at a later close. Every other part of D3 is unchanged |
| ADR-024 D3 | "a frame's decisions are a SUBSEQUENCE of the per-event cadence's decisions, in the same order, with the same source events and instants." | Still true for an evaluation at a close that owed the market. A carried-over or heartbeat evaluation takes the frame's last event as its source (D3) |
| ADR-024, Consequences | "The decision cadence changes. … decisions fall from 89,621 to 46,666: one per closed frame that reaches a configured market or a reference price." | The decision cadence changes again. At the default settings it is at most one `onFeatures` decision per market per second of event time, plus heartbeats. `CADENCE-1` measures the new count on the H1 burst |
| Handoff §8.1 | "→ update feature snapshots → invoke subscribed strategies in stable configured order" | Every event updates state. `onFeatures` is invoked at most once per market per `evaluationIntervalMs` of event time, plus heartbeats (D2). Every other callback is invoked as before |

Not amended, and kept word for word: §6 invariant 3, §7.5, ADR-005 §2 and the
`WP-170` acceptance "Runtime persists exactly one decision per callback."

## Consequences

- **Fewer decisions and less CPU.** `LEAN-1` §6 estimates about 250 times fewer
  decision rows, and most of the evaluation CPU.
- **The strategy reacts up to about one second later.** This is a new strategy
  behaviour. Results are not comparable with the H1 runs or with a future
  low-latency live run.
- **A quiet market waits for the next event.** With no event at all, nothing is
  evaluated: there is no wall-clock timer. The heartbeat fires at the first
  frame close 5 s after the last evaluation. Any event closes a frame,
  including a reference trade. How long real quiet gaps last is not measured;
  `CADENCE-1` measures it.
- **Health counters.** `evaluationsCoalesced` is new. The meaning of
  `eventsProcessed`, `evaluations` and `decisionsPersisted` is unchanged.
- **Goldens.** Any golden with two evaluations of one market less than a second
  apart changes. `CADENCE-1` must explain each change.

## Evidence

- `docs/handoffs/LEAN-1.md` §2 (the 1 s tick correction), §4 (database
  volumes), §6 row A1, and "The user's rulings (2026-09-30)".
- ADR-024 Context 5, D2, D3 and Consequences.
- `docs/spec/polymarket-bot-orchestrator-handoff.md` §6 invariant 3, §7.5,
  §8.1, §8.2, §9.6.
- `docs/handoffs/WP-170.md`, decision 5 (`REFUSED`).
- `IMPLEMENTATION_STATUS.md`, residual `CO2-N1`.
- `packages/trading-core/src/loop.ts` (`CoreLoop`, the `receivedAt` instant).
- No venue fact is used.
