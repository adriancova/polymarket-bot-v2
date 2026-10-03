# ADR-026: Evaluation cadence: at most one `onFeatures` evaluation per market per second of event time

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling A1).
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `CADENCE-1`, after `THROUGHPUT-1c` merges. Not yet
  implemented.
- **Supersedes / Superseded by:** none. It **amends** ADR-024 D3 (its
  cadence clause and three sentences, named in "What it amends") and its
  Consequences, and handoff §8.1.
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

### D1. Two run settings, pinned in the run record

1. `evaluationIntervalMs`: the shortest event-time gap between two `onFeatures`
   evaluations of one market. The default is **1,000**.
2. `evaluationHeartbeatMs`: the longest event-time gap after which a market is
   evaluated even if no event touched it. The default is **5,000**.
3. Both are run settings. They are pinned in the run record of every run, on
   live data or in replay. A change to either starts a new run (§9.6).
4. The run record is the run's `strategy.runs` row (§10.3), or the immutable
   configuration version that row names (`config_id`). Today neither has a
   field for these settings. The schema is in
   `packages/storage-postgres/src/schema/strategy.ts`.
   `CADENCE-1` names the field it uses and pins it with a test. If that needs
   a schema change, `CADENCE-1` stops and asks for a `db/migrations/**` grant.
5. **Every new run uses the defaults.** A PAPER run on live data, and every
   replay that is not a reproduction (rule 6), uses exactly 1,000 ms and
   5,000 ms. A run refuses to start with any other value. Other values need a
   new ruling.
6. **A historical replay may use the per-frame cadence.** `CADENCE-1` may offer
   `evaluationIntervalMs` = 0, meaning ADR-024's per-frame cadence, unchanged,
   with no heartbeat. Only a replay that reproduces a golden or a run recorded
   under ADR-024 (such as the H1 comparisons) may use it. The value 0 is
   pinned like any other. A live-data run refuses it.

### D2. The rule, per market

All times are event times, built from the `receivedAt` instant of each event,
as the loop already uses it.

1. **The cadence clock.** An event is **applied** when it passed the event
   door and its `receivedAt` normalized to strict UTC, so the loop counted it
   in `eventsProcessed` (`CoreLoop.#processEvent`). A refused event is not
   applied, though it can still close a frame (ADR-024 D3). The loop keeps
   `now`: the latest instant of an applied event in this run (a high-water
   mark). A refused event never moves `now`. An applied event with an earlier
   instant leaves `now` unchanged. So `now` never moves backwards.
2. A market is **owed** an evaluation when an event touches it in the sense of
   ADR-024 D3. That is, when the per-frame cadence would have evaluated it.
3. The check runs only at a frame close (ADR-024 D2). Let `t` be `now` at that
   close, and `last` the value of `now` at the market's last `onFeatures`
   evaluation in this run.
4. At the frame close, a market is evaluated when one of these holds:
   - it is owed, and it has no `last` in this run;
   - it is owed, and `t − last ≥ evaluationIntervalMs`;
   - `t − last ≥ evaluationHeartbeatMs`, whether or not it is owed.
5. When a market is evaluated, `last` becomes `t`.
6. Otherwise it is **not evaluated** at this close. If it is still owed, it
   stays owed until a later close.
7. A later close may belong to a frame that does not touch the market. A market
   that is still owed is evaluated at the first close where rule 4 allows it.
8. **A backward step.** Stamps may repeat or step backwards (Context 5).
   Because `t` and `last` are both values of `now`, `t − last` is never
   negative. A backward step neither adds an evaluation nor stops one: the
   market is evaluated once `now` has moved on by the interval. So each market
   is evaluated at most once per `evaluationIntervalMs` of `now`, exactly as
   ruled.
9. `now` is the cadence clock only. A decision's `evaluatedAt` is still its
   source event's instant (D3). When stamps step backwards, two decisions'
   `evaluatedAt` values can be closer than the interval. The shortfall is at
   most the later source's lag behind `now`.
10. **A forward jump.** One applied event stamped far ahead moves `now` there.
    Every market evaluated at that close gets `last` equal to that instant.
    Later stamps lie behind `now`, so no market is evaluated again, not even by
    heartbeat, until `now` has moved on by the interval. Only `onFeatures`
    waits; every other callback fires (D4). But a protective exit decided in
    `onFeatures` waits too: Static Bracket's stop ladder does
    (`packages/strategies/static-bracket/src/strategy.ts`). So:
    - the loop raises an alarm when an applied event's instant lies more than
      `evaluationHeartbeatMs` (5,000 ms when the heartbeat is off) behind
      `now`. `CADENCE-1` names the alarm, carries it through the health door
      like `evaluationsCoalesced`, and routes it to a page;
    - `CADENCE-1` tests a forward jump. The test shows that the hold ends
      when `now` has moved on by the interval, and that the alarm fires;
    - the rule does not recover early. An early recovery would let a backward
      step add evaluations, which rule 8 forbids.
11. The usual gates still apply. A halted or closed market is not evaluated, as
    today.

    > **Corrected 2026-10-03 (`CADENCE-1`, under the orchestrator's grant Q4).**
    > What the code does today. A HALTED market — a market-scoped halt, or any
    > GLOBAL halt — is not evaluated: at each close the loop's market-halt gate
    > skips it, and an evaluation it was owed is dropped, not carried, as the
    > per-frame cadence dropped it. A halted strategy INSTANCE is skipped
    > inside the market's evaluation, which still runs for the market's other
    > instances and still moves the market's `last`. A CLOSED market has no
    > gate: nothing in the loop or the strategy runtime gates evaluation on a
    > market's lifecycle. A market whose `MarketClosing` or `MarketResolved`
    > event has arrived is still evaluated under rule 4, like any other. Its
    > lifecycle callbacks fire in place (D4); the strategy learns of the close
    > from them, and the risk engine reads the lifecycle as the §9.8 market
    > status at admission. "A closed market is not evaluated" therefore
    > describes no gate the code has. This correction adds none; a lifecycle
    > gate would need its own ruling.
12. **The order at one close.** First come the markets this frame owed an
    evaluation (D3.1), in the order ADR-024 D3 gives. Then come all the
    others, carried-over and heartbeat evaluations alike (D3.2), in the stable
    configured order of §8.2. A market is evaluated at most once per close.
    So the order is fixed, and decisions stay byte-identical (D6).

### D3. The decision's source event

1. If the frame at whose close the evaluation runs owed the market an
   evaluation, the source event and `evaluatedAt` follow ADR-024 D3 unchanged.
2. Otherwise the evaluation is a carried-over or heartbeat evaluation. Its
   source is the frame's last **applied** event (D2.1), and its `evaluatedAt`
   is that event's instant. That event may be one that owed no market. A
   refused event is never a source: it may have no event id and no valid
   instant.
3. If the frame has no applied event, because every event in it was refused,
   the close evaluates nothing. Such a frame owed no market, and it runs no
   carried-over or heartbeat evaluation. A market still owed stays owed until
   a later close.
4. This **amends** an ADR-024 D3 rule, named in "What it amends": "An event
   that owed no market an evaluation … never becomes a decision's source".
   It now holds only for an evaluation at a close that owed the market.
5. The reason: the frame's last applied event is the latest data the loop took
   in before the close that triggered the evaluation. The market's last owing
   event can be seconds older. Admission (risk freshness, book age,
   seconds-to-close) runs on event time (`CO2-N1`), so that older instant
   would make the data look fresher than it is.
6. So every decision still names a real, applied source event with a valid
   instant, and §6 invariant 4's chain is complete.

### D4. Every other callback is never delayed

1. Only `onFeatures` is throttled.
2. `onFill`, `onOrderUpdate`, `onStart`, `onStop`, `onMarketOpen`,
   `onMarketClosing`, `onMarketResolved` and `onTimer` fire exactly when they
   fire today.
3. Every event is still ingested and applied to the books, trades, reference
   prices and incidents. None is skipped. `eventsProcessed` still counts every
   applied event, and `eventsRefused` every refused one, as today.

### D5. A coalesced market is not evaluated, so no record is owed

A market that D2 does not evaluate at a close is **coalesced** at that close.

1. §6 invariant 3 is kept: "Every strategy callback produces exactly one
   persisted `DecisionResult`."
2. §7.5 is kept: the runtime "persists exactly one decision record after the
   callback returns."
3. §9.6 is kept: the runtime must "Persist exactly one `DecisionResult` per
   evaluation."
4. A coalesced market is not evaluated. The loop never asks the runtime, and
   the strategy is not invoked. So no evaluation and no callback exist, and
   no record is owed.
5. This follows the `WP-170` precedent. A `REFUSED` outcome means "the callback
   was **never invoked** … so §6 invariant 3 does not bind and **no** record
   exists" (`docs/handoffs/WP-170.md`, decision 5).
6. A new health counter, `evaluationsCoalesced`, adds one for each owed
   market at each frame close where that market is not evaluated. A market
   that stays owed over three closes adds three. `evaluations` and
   `decisionsPersisted` keep their meaning.

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
   evaluation per market per second of **recorded** time. It does not coalesce
   more to catch up. Fewer evaluations do shorten the backlog.
4. This ADR neither fixes nor worsens `CO2-N1`. `CO2-N1` must still close before
   any settlement veto is lifted and before `WP-270`.
5. If `CO2-N1`'s fix brings processing time into admission, the cadence stays
   on event time. The two clocks are separate.

## What it amends

| Text | As written | How it now reads |
| --- | --- | --- |
| ADR-024 D3 | "What moves to the frame's CLOSE (`CoreLoop.#closeFrame`) is: the `onFeatures` evaluation of each market the frame touched, ONCE per market;" (list flattened) | At the frame's close, each market is evaluated only if D2 allows it: owed and at least `evaluationIntervalMs` of the cadence clock since its last evaluation, or `evaluationHeartbeatMs` since it. A market still owed is evaluated at a later close. Every other part of D3 is unchanged, except the three sentences in the next rows |
| ADR-024 D3 | "a frame's decisions are a SUBSEQUENCE of the per-event cadence's decisions, in the same order, with the same source events and instants." | Still true for an evaluation at a close that owed the market. A carried-over or heartbeat evaluation takes the frame's last applied event as its source (D3) |
| ADR-024 D3 | "An event that owed no market an evaluation — one for a market this trader does not run, or one whose application triggered no callback — never becomes a decision's source" | True for an evaluation at a close that owed the market. A carried-over or heartbeat evaluation takes the frame's last applied event as its source, even if that event owed no market. A frame with no applied event evaluates nothing (D3.2-D3.5) |
| ADR-024 D3 | "A frame of one event takes exactly the path every event took before" | True for every callback other than `onFeatures`. A frame of one event still delivers every such callback in place, as before. Its `onFeatures` evaluation is subject to D2, like any other frame's: it runs only if D2 allows it at that close |
| ADR-024, Consequences | "The decision cadence changes. … decisions fall from 89,621 to 46,666: one per closed frame that reaches a configured market or a reference price." | The decision cadence changes again. At the default settings it is at most one `onFeatures` decision per market per second of event time, plus heartbeats. `CADENCE-1` measures the new count on the H1 burst |
| Handoff §8.1 | "→ update feature snapshots → invoke subscribed strategies in stable configured order" | Every event updates state. `onFeatures` is invoked at most once per market per `evaluationIntervalMs` of event time, plus heartbeats (D2). Every other callback is invoked as before |

Not amended, and kept word for word: §6 invariant 3, §7.5, §9.6 ("Persist
exactly one `DecisionResult` per evaluation"), ADR-005 §2 and the `WP-170`
acceptance "Runtime persists exactly one decision per callback."

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
- **Health counters.** `evaluationsCoalesced` and the forward-jump alarm
  (D2.10) are new. The control API's health door and the observability metric
  shapes list every loop counter strictly, so `CADENCE-1` adds both there in
  the same round. The meaning of
  `eventsProcessed`, `evaluations` and `decisionsPersisted` is unchanged.
- **A far-future stamp holds `onFeatures`.** Until later stamps catch up, no
  market is evaluated, and a stop decided in `onFeatures` waits (D2.10). The
  alarm pages; it does not shorten the hold.
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
