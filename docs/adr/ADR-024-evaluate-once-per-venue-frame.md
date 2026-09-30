# ADR-024: The trader evaluates once per venue frame

- **Status:** Proposed. The user ratifies it before `THROUGHPUT-2` merges
  (ruling 2026-09-30, "Yes, round before re-run").
- **Date:** 2026-09-30
- **Recorded by:** `THROUGHPUT-2`, which also implements it.
- **Supersedes / Superseded by:** none. It refines WHEN the §8.1 loop invokes
  a strategy; it does not change what one invocation produces (§6 invariant 3,
  §7.5, ADR-005).
- **Handoff sections:** §6 (invariants 3 and 15), §7.1, §7.5, §8.1, §8.3,
  §8.4, §12.1, §12.4. **ADRs:** ADR-002 (envelope and ordering), ADR-003
  (transport), ADR-005 (one decision per callback), ADR-013 (`price_change`
  semantics), ADR-022 (one shared core).
- **Finding it resolves:** `H1R1-FRAME-ATOMICITY`
  (`docs/handoffs/H1-RUN-1.md`, finding 2).

## Context

1. **The venue delivers book changes in frames.** One Polymarket market-channel
   WebSocket message is one frame. The `price_change` event carries a
   `price_changes[]` ARRAY, one entry per changed level, each naming its own
   `asset_id` (`docs/venue/verified-2026-08-24.md` §3: "`price_change`
   (batched `price_changes[]` with `asset_id`, `price`, `size`, `side`,
   `hash`, `best_bid`, `best_ask`)"; re-confirmed in
   `docs/venue/verified-2026-09-16.md` §3). A message may also be a JSON array
   of several events, which the adapter normalizes element by element
   (`packages/polymarket-public/src/normalize/market-events.ts`
   `normalizeMarketEvents`: "The venue may deliver a single event object or a
   JSON array of them in one text frame"). Nothing in the verified documents
   says more than that about what one message contains; this ADR relies on
   nothing more.
2. **One frame becomes several events.** The adapter emits one
   `BookLevelChanged` per `price_changes[]` entry (`normalizePriceChange`), and
   the gateway stamps every market-data event derived from one recorded raw
   frame with the same `causationId`, `raw:<gatewayEpoch>:<raw frame
   ingestSeq>` (`apps/data-gateway/src/envelope.ts` `rawFrameCausationId`;
   `feeds/polymarket.ts` `onEvent`). The adapter emits a frame's events
   synchronously after `onRawFrame`, in one turn
   (`packages/polymarket-public/src/feed/connection.ts` `#onMessage`).
3. **H1 run 1's burst** (the last 100,000 stream events before the halt,
   `scratchpad/throughput-1/fixtures/burst-2026-09-29T2100.jsonl`) holds
   85,547 `BookLevelChanged` events. Grouped by consecutive `causationId`,
   they form 42,773 frames of exactly two events (one per token of the pair),
   plus one frame cut by the fixture's start. Reference trades form 126 frames
   of 2 to 65 trades. Every other frame is a single event. Every envelope in
   the burst carries a `causationId`, and no `causationId` recurs after
   another intervenes.
4. **The trader evaluated after each event.** So after the first event of a
   two-token frame, the strategy saw the YES book already updated beside a NO
   book that was not: a state that never existed at the venue. Half of all
   book evaluations were on such states.
5. **Evaluation dominates the trader's CPU.** After `THROUGHPUT-1a`, about
   82–83% of trader CPU is inside `#evaluateMarket`; catch-up ran at 486–608
   events/s against the recorded 735, and the paced replay lagged 37–125 s
   where ≤ 5 s needs about 943 events/s (`docs/handoffs/THROUGHPUT-1a.md`).
6. **The contract.** §7.5 (`docs/spec/polymarket-bot-orchestrator-handoff.md:559`):
   "The runtime … persists exactly one decision record after the callback
   returns." §6 invariant 3 (:418): "Every strategy callback produces exactly
   one persisted `DecisionResult`." `WP-170`'s acceptance: "Runtime persists
   exactly one decision per callback." None of these fixes how many callbacks
   one event triggers; §8.1 (:679) says only "update feature snapshots →
   invoke subscribed strategies".

## Decision

### D1. A frame is a run of consecutive events sharing a frame key

The frame key of an envelope (`packages/trading-core/src/frames.ts`
`frameKeyOf`) is:

- its `causationId`, when present — every event the gateway derived from one
  recorded raw frame shares it, and events of different raw frames never do;
- otherwise its §7.1 dispatch identity `(gatewayEpoch, ingestSeq)`.

Two events are in one frame iff they are **consecutive** in delivery order
and their keys are equal. The key is read from the envelope's own data
properties only; it decides grouping, never validity (the event door still
judges every event).

What that means per source, grounded in how each is produced today:

| Source | Raw frame | Events per frame | Grouped? |
| --- | --- | --- | --- |
| Polymarket `price_change` | one WS message | one `BookLevelChanged` per `price_changes[]` entry — both tokens of the pair in H1 | **yes**: one evaluation after the last entry |
| Polymarket `book` | one WS message; an array message holds several books | one `BookSnapshot` per book element | yes when one message carried several books (every H1 `book` frame carried one) |
| Polymarket `last_trade_price` | one WS message | one `PublicTradeObserved` | single-event frame: unchanged |
| Polymarket array message mixing event types | one WS message | one event per element | yes, as one frame |
| Binance / Coinbase trades | one WS message | one `ReferenceTradeObserved` per trade the message reports (2–65 in H1) | **yes**: every trade applied, every market evaluated once |
| REST snapshot recovery (`#recover`) | no socket frame (`#currentRaw = undefined`) | one `BookSnapshot` per token, no `causationId`, distinct `ingestSeq` | no: each is its own frame, as before |
| Lifecycle, incidents, feed health | journaled response / gateway-originated | no shared key with market data | not grouped with book events; see D3 for lifecycle callbacks |
| Replay of recorded raw frames | one WAL record | envelopes stamped with the record's own `(gatewayEpoch, ingestSeq)` (`apps/backtest-cli/src/normalizer.ts` `envelopeFrom`) | yes, by the dispatch identity: the same grouping the live `causationId` gives |

A live gateway assigns every envelope its own `ingestSeq`, so a live event
without a `causationId` is always a frame of one.

### D2. Knowing a frame is complete without waiting on the next event

**Chosen: option (b), made provable** — frame-atomic publication plus
frame-aligned delivery. The loop's rule (`CoreLoop.drain`) is: an event closes
its frame when the next QUEUED event has another key, or when nothing is
queued after it. The second half is an obligation on every producer of a
drain's batch: **a batch never ends in the middle of a frame.** Each producer
meets it as follows.

1. **The gateway publishes a frame in ONE atomic transport call**
   (`apps/data-gateway/src/publisher.ts`, "Frame-atomic runs").
   - A feed driver dispatches all of one raw frame's events in one
     synchronous turn (context 2). When the publisher's pump STARTS on an
     envelope that names a raw frame, it first yields one microtask, so the
     rest of that frame is admitted before the first run is cut. A pump that
     is already running dequeues only in a later turn, when every frame then
     queued is complete. An envelope with no `causationId` starts the pump
     synchronously, as before.
   - A run is never cut between two consecutive envelopes sharing a
     `causationId`: the batch bounds (256 envelopes, 1 MiB) end a run only at
     a frame boundary, and a longer frame is taken whole up to
     `FRAME_RUN_MAX_ENVELOPES` = 1,024, the Redis transport's limit for one
     script call (`packages/event-bus/src/redis/transport.ts`
     `MAX_PUBLISH_BATCH_ENVELOPES`).
   - The Redis transport writes one batch "by ONE server-side script call
     (`PUBLISH_BATCH_SCRIPT`), atomically", and a script failure "ran
     completely or not at all" (`publishBatch`'s contract). So a reader sees
     all of a frame's entries or none.
2. **The trader's Redis feed hands out frame-aligned batches**
   (`apps/trader/src/adapters/redis-feed.ts`).
   - A read that returned FEWER entries than its `COUNT` reached the stream's
     end at that instant; by 1, every frame in it is whole, and it is handed
     out whole.
   - A FULL read may have cut its last frame at the `COUNT` boundary. Its
     trailing run of one key is CARRIED: read, not handed out, and put at the
     front of the next poll's batch. The next read asks only for the room the
     carry leaves, so a batch never exceeds `receiveBatchSize`.
   - Nothing waits for a next event: a quiet stream answers the very next
     read short, which releases the carried frame at once.
   - A single frame that fills a whole batch cannot be aligned; it is handed
     out as it stands and counted (`RedisMarketEventFeed.framesSplit`). That
     needs a frame of ≥ 128 events (the shipped `receiveBatchSize`); H1's
     largest was 65.
3. **The backtest driver drains once per recorded frame**
   (`apps/backtest-cli/src/core-loop.ts`, `recordFraming`). See D4.

**The loop never holds a frame open across drains.** If a producer broke its
obligation, the loop would evaluate the partial frame at the drain's end
(pinned by `frame-evaluation.test.ts`, "a frame never outlives a drain"): the
failure mode is the old per-event cadence for that one frame, never a lost
evaluation and never a position recorded inside an open frame.

**The stated exceptions** (each is a halt path or out of every observed size):
a door or ordering refusal INSIDE a gateway run publishes the run's prefix and
halts publication (the transport's documented behaviour; the gateway's own
envelopes are contract-validated at dispatch, so this is unreachable through
the dispatcher); a frame over 1,024 envelopes splits at the gateway; a frame
of `receiveBatchSize` or more splits at the trader.

### D3. What the loop does with a frame

For every event of a frame, the loop performs every state step exactly as
before and in the same order: the event door, the strict-UTC instant, the
venue's `observe`, the basket judgement, the cancel sweep, and applying the
event to the books, trades, reference prices and incidents
(`CoreLoop.#applyWithinFrame`). What moves to the frame's CLOSE
(`CoreLoop.#closeFrame`) is:

- the `onFeatures` evaluation of each market the frame touched, ONCE per
  market, in the order the frame first touched them;
- the fill harvest and the outbox flush (so a group commit stages one unit
  per frame, not per event).

The frame's evaluation uses the frame's LAST applied event as the decision's
`source_event_id` and its instant as `evaluatedAt` (a frame's events can carry
receipt instants microseconds apart: 1,973 H1 frames do). A market halted
during the frame is not evaluated at its close, by the same gate as always. A
callback that is not `onFeatures` — a lifecycle transition — still fires in
place, as it always did: coalescing changes only when features are evaluated,
never whether a lifecycle callback is delivered. A refused event that closes a
frame still closes it. A frame none of whose events would have reached the
harvest point on its own (no configured market, no reference price) harvests
nothing.

**A frame of one event takes exactly the path every event took before** — the
branch is taken only when a frame is longer than one — so reference ticks,
trades, snapshots, lifecycle events, incidents, fills and every
loop-originated callback behave as before.

What is unchanged: one callback, one persisted decision (§6 invariant 3,
§7.5, ADR-005, `WP-170`). Every event is ingested, applied and counted
(`eventsProcessed`); none is skipped. No envelope field, schema version,
database column or migration changes.

### D4. Replay and backtest parity (ADR-022)

The grouping is ONE code path, in `packages/trading-core` (`frames.ts` and
`CoreLoop.drain`), which every composition root drives. The live Redis feed
and the backtest driver differ only in how they meet D2's obligation:

- **Replay of recorded raw frames:** a WAL record is one raw frame. The
  normalizer stamps every envelope derived from it with the record's
  `(gatewayEpoch, ingestSeq)`, which is the frame key when no `causationId`
  is present (D1). `recordFraming()` wraps the run's normalizer — same
  `normalizerVersion`, same answers — to learn each record's last envelope;
  the driver ingests every envelope and drains at the record's last. The
  envelopes of one record share its recorded instant and identity, so
  deferring the drain moves neither the replay clock nor the venue's
  position (§6 invariant 15). The `run` command's assembly wires it.
- **Normalized-stream recordings** (`normalizedEnvelopeNormalizer`,
  `BACKTEST-1`) are one envelope per record, and their recorded format has no
  `causationId`, so every event is its own frame there — as it is for the
  live loop given the same envelopes. The one committed such recording
  (`test/replay-golden/backtest/static-bracket`) has eight single-event
  records. A normalized recording that must reproduce live framing needs its
  `causationId` recorded; that is a recording-format change for a later
  round (Consequences).

### D5. Crash recovery with group commit (`THROUGHPUT-1a`)

The position is never recorded inside a frame, so a crash mid-frame re-reads
the frame whole:

- the feed records (`mark`/`commit`) only the position of an event it HANDED
  OUT, never a carried one; a crash with a carried partial frame resumes
  before it;
- every handed-out batch ends at a frame boundary (D2), the loop closes every
  frame inside the drain (D2), and the pump records a batch's position only
  after that batch's decisions are durable (`pump.ts`, unchanged). So every
  recorded position is at a frame boundary;
- group commit stages one unit per closed frame; the `THROUGHPUT-1a` bounds
  (32 / 50 ms / 128 staged units, at most 256 undurable) and the
  one-chain prefix property are unchanged.

### D6. Determinism

Grouping is a pure function of the delivered sequence (consecutive equal
keys); the loop reads no clock to decide it, and the feed's alignment depends
only on what the stream holds. For a fixed delivered sequence the decisions
are byte-identical run to run (`determinism-and-ordering.test.ts`, the
paper-e2e goldens, and the bench's content digests on two candidate runs).

## Options considered

- **(a) A frame marker in the envelope** (the frame's last envelope stamped,
  or `index`/`count` on every envelope). Rejected. Every contract rejects
  unknown keys, and `packages/domain/src/schema-version.ts` is explicit:
  "Every change to the emitted field set increments `schemaVersion`. There is
  no 'additive optional field reuses the current version' exemption." A
  common-shape field is therefore a new version of EVERY event contract, with
  the old versions kept registered for recorded datasets, WALs and goldens,
  and the event-bus door and wire-byte fixtures re-pinned. It also does not
  remove the need for atomic publication: a count tells the consumer to wait
  for the frame's remaining envelopes, and without atomic publication they may
  not be in the stream yet. And the data it would add is already there: the
  `causationId` identifies the frame, and atomic publication plus the
  short-read rule identify its end.
- **(a′) Encode `index/count` inside the `causationId` string.** Rejected: it
  changes the meaning of an existing field, which the same rule makes a
  version change, and breaks the §6 invariant 4 lookup from `causationId` to
  the WAL record.
- **(b) Atomic publication, consumer groups by `causationId`** — chosen, with
  the straddle closed on both sides: the publisher never splits a frame, and
  the consumer never ends a batch inside one (D2).
- **(c1) Wait a grace period for the next event.** Rejected: a quiet stream
  would delay every evaluation by the grace period, which the ruling forbids.
- **(c2) Group by `receivedAt`** (`THROUGHPUT-1a`'s modelling proxy).
  Rejected: each envelope gets its own receipt stamp, so 1,973 H1 frames
  carry more than one `receivedAt`, and unrelated frames can share a
  millisecond.
- **(c3) Pair complementary tokens** (a YES change waits for the NO change).
  Rejected: it invents venue behaviour; the documentation promises no such
  pairing.

## Consequences

- **The decision cadence changes.** On the H1 burst (99,669 envelopes from
  index 332, 56,714 frames, 42,753 of them multi-event), decisions fall from
  89,621 to 46,666: one per closed frame that reaches a configured market or a
  reference price. The 42,955 decisions base made on the first event of a
  multi-event frame (42,627 two-token `price_change` frames, 328 reference
  trades inside multi-trade frames) are gone. Each of the other 46,666 is
  equal to base's decision at the same source event in every exported column —
  feature snapshot address, reason codes, state patch, `evaluated_at` — and so
  is its checkpoint; only the sequence numbers are renumbered. On this burst,
  skipping the half-applied evaluations changed no later decision.
- **Throughput rises, but not to the H1 burst rate.** Catch-up 572.6 → 807.9
  events/s (CPU 1,784 → 1,292 µs per event); paced max lag 44.5 s → 9.3 s.
  The removed evaluations were the cheap half of each pair (the second
  evaluation of a pair hit `THROUGHPUT-1a`'s memos), so the gain is about 1.4×,
  not the 2.1× `THROUGHPUT-1a` modelled; the `THROUGHPUT-2` handoff records
  the ranked options for the rest.
- **Recorded data and goldens need no migration.** The frame key is a field
  every recorded market-data envelope already carries (`causationId`), or
  the replay's own record identity. A stream or dataset without either
  evaluates per event, exactly as before. No committed golden has a
  multi-event frame, so none changes: the paper-e2e scenarios number
  `ingestSeq` by position and carry no `causationId`, the backtest golden has
  eight one-envelope records, and the order-book and simulation goldens do not
  drive the core loop. The one pinned decision baseline that changes is the
  throughput harness's 2,000-event sample (1,837 → 928 decisions, the 909
  half-applied ones removed; `throughput-bench-harness-postgres-redis.test.ts`).
- **Operational.** Health counters keep their meaning: `eventsProcessed` still
  counts every event; `evaluations` and `decisionsPersisted` now count
  per-frame callbacks. The feed's `framesSplit` is exposed on the adapter and
  in the bench report, not on the health surface (adding it there is a
  control-API door change for a later round).
- **Known limits, each stated where it lives:** REST snapshot recovery
  publishes the two tokens' snapshots without a shared key, so after a resync
  they are evaluated separately, as before; normalized-stream recordings carry
  no `causationId` (D4); the size limits in D2.

## Verification

- `test/integration/paper-trader/frame-evaluation.test.ts` — a two-token frame
  is evaluated once, after both tokens applied, and never on the intermediate
  state (records the book views handed to the strategy; fails on base
  `bf1ee89`); a multi-trade reference frame evaluates once; a single-event
  frame is unchanged; a replayed raw record groups by its identity; a frame
  halted by its first event is not evaluated; a frame never outlives a drain.
- `apps/data-gateway/src/publisher.test.ts` "frame-atomic runs" — one call per
  frame admitted in one turn; runs cut only at frame boundaries (envelope and
  byte bounds); the 1,024 split; unchanged behaviour without `causationId` and
  without the batch capability (four fail on base).
- `apps/trader/src/adapters/redis-feed-frames.test.ts` — carry on a full read,
  release on a short or idle read, the batch bound, `framesSplit`, positions
  never naming a carried event, ordinals unchanged.
- `apps/backtest-cli/src/core-loop.test.ts` — one drain per recorded frame.
- `test/integration/paper-trader/group-commit-crash-recovery-postgres-redis.test.ts`
  — the SIGKILL case now publishes frame-atomically and pins that the stored
  position is a frame boundary although the feed's reads were cutting
  two-token frames when the process died; a new run decides exactly what the
  uninterrupted run decided after it. The feed tests pin the same with a
  carried partial frame.
- The throughput benchmark (`tools/bench/trader-throughput`), base `bf1ee89`
  against the candidate on one registered clone, full H1 burst:

  | Run | Events/s | CPU µs/event | Decisions | Max lag | p99 lag | Halts |
  | --- | --- | --- | --- | --- | --- | --- |
  | base, catch-up | 572.6 | 1,784 | 89,621 | — | — | none |
  | candidate, catch-up | 807.9 | 1,292 | 46,666 | — | — | none |
  | base, paced | 566.1 | 1,776 | 89,621 | 44.46 s | 44.04 s | none |
  | candidate, paced | 709.0 | 1,366 | 46,666 | 9.26 s | 8.83 s | none |

  Base `bf1ee89`, candidate `ead59be`. A second session at the final tip
  (`510ba20`, whose product code differs only by an equivalent loop in the
  feed adapter), with base re-run beside it: catch-up 545.6 → 764.4 events/s
  (1,866 → 1,402 µs/event), paced max lag 48.6 s → 11.8 s (p99 48.3 → 11.5 s).
  The host is shared and was about 5% slower in that session; the ratio is the
  same (~1.4×). Decision and checkpoint content at the tip equals the first
  session's, in both modes.

  The targets (catch-up ≥ 943 events/s, paced max lag ≤ 5 s) are NOT met;
  the remaining cost is outside this package's paths (feature-input
  validation and serialization, the decimal guard, strategy-runtime view
  acquisition — the `THROUGHPUT-2` handoff ranks them).
- An in-process proof over the same burst (the assembled core, in memory):
  the state of BOTH outcome books and the trade window at each of the 56,714
  frame closes equals base's state after the same event; the final state is
  equal; `eventsProcessed` / `eventsRefused` are base's (89,622 / 10,047); and
  the candidate code handed ONE event per drain reproduces base's 89,621
  decisions byte for byte.
