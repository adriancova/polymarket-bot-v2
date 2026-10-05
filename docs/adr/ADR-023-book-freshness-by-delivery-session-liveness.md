# ADR-023: Book freshness by delivery-session liveness, not by the last change

- **Status:** **Accepted, 2026-10-02: ratified by the user as is.** Proposed
  2026-09-30. The user's ratification confirms the three rulings its review
  asked for, which the orchestrator recorded on 2026-10-01 as interim rulings
  in `IMPLEMENTATION_STATUS.md`:
  - the D7 option: (a), the process-lag guard;
  - the `Clock`-port reading of D7;
  - the epoch taint of §5, which stays coarse and fail-closed.

  Wherever the text below says a ruling is interim or awaits ratification,
  read it as confirmed on 2026-10-02. That confirmation does not cover
  Amendment 1 (2026-10-05), which the user has not ruled on.
- **Date:** 2026-09-30
- **Recorded by:** `THROUGHPUT-1c`, which also implements it.
- **Amended:** [Amendment 1](#amendment-1-2026-10-05-rollover-1)
  (2026-10-05) records the orchestrator's interim ruling on the reference id
  that a series-admission incident names when it has no window id
  (`ROLLOVER-1`). The user has not ruled on it.
- **Supersedes / Superseded by:** none. It changes how a venue book's AGE is
  measured, when a configuration opts in. It does not change any bound, any
  gate's direction, the §9.9 stale-book response, or the clock semantics
  (every age is still measured in event time; `CO2-N1` is unchanged). It
  adds one bound of its own: the per-book ceiling on the last-change age
  (D2 rule 6). Under `CONNECTION_CONFIRMED` only, it reads the process's
  `Clock` port to NARROW its own extension for a lagging trader (the
  process-lag guard, D7, r2).
- **Revision:** r1 (2026-09-30), after review round 1 (findings X1–X9): the
  per-book ceiling (X1), the gateway reporting a frame's problems before its
  accepted events (X8), and corrected statements on the taint's lifetime
  (X2), the H1 evidence (X3), the configuration identity (X6), the venue
  documentation (X7) and `CO2-N1` (X9). r2 (2026-09-30), after review
  round 2: the process-lag guard (D7, X9 option (a), the option the interim
  ruling later chose), the heartbeat wording (D5, Option B) and the
  replay-parity qualification (D8). r3 (2026-09-30), wording only: the
  guard's bound is unguarded `CONNECTION_CONFIRMED`, not `LAST_CHANGE` (D7),
  and the process lag reaches feature snapshot refs, so opted-in live records
  have no guaranteed byte parity with replay (D8). r5 (2026-10-01), wording
  only (review round 5, X9-GOV): the sentences that said a ruling was still
  owed (D7, §5) now point to the interim rulings recorded in
  `IMPLEMENTATION_STATUS.md`; the user's ratification is still the merge
  gate. r6 (2026-10-01), after review round 6 (R6-H1): the gateway validates
  every envelope of a market-channel frame before it publishes any, so an
  event its envelope contract refuses is reported ahead of the frame (D2.4,
  D3, D5); `LAST_CHANGE` records no delivery session (D4, O-R6-I1); a
  backward step of the gateway's wall clock is disclosed (D7, D8, O-R6-I2).
  r7 (2026-10-01), after review round 7 (R7-H1): r6's claim that a frame of
  up to 1 024 events is never split across two transport calls was false.
  The publisher now never starts a frame in a run that cannot hold it
  whole, and the gateway publishes a `GATEWAY_FRAME_SPLIT` taint ahead of
  every frame too large for one call (D2.4, D3, D5, D8, §4, §5, §6).
  r8 (2026-10-01), after review round 8 (R8-H1): r7's account of the
  trader's side was incomplete. `RedisMarketEventFeed` hands a frame longer
  than `receiveBatchSize` out across two polls, and the first part vouched
  for a book whose change was in the unread part. Rounds 6, 7 and 8 each
  found a new place where a frame could be cut, so r8 closes the CLASS at
  the consumer: a frame's confirmations are used only once the trader has
  processed a later event of the same gateway epoch from another frame
  (D1, D2, D2.4, D3, D5, D8, §4, §5, §6).
- **Handoff sections:** §6 (invariants 9, 12 and 15), §7.1, §8.1, §9.5, §9.8
  (check 7), §9.9, §12.4, §13.3. **ADRs:** ADR-002 (envelope and ordering),
  ADR-013 (`price_change` semantics), ADR-020 (parse boundaries), ADR-022 (one
  shared core), ADR-024 (evaluate once per venue frame).
- **Finding it addresses (not a claim that it resolves it):** H1 run 1,
  finding 5 (`docs/handoffs/H1-RUN-1.md:76`): 20,367 of 37,546 decisions (54%)
  paused on `SB.STALE_BOOK`. The evidence for this rule is a MECHANISM CHECK
  only. On the recorded H1 burst fixture, base and candidate both pause 0
  times, because the traded YES book's last-change age never exceeds 493 ms
  there. The 21.9% → 0 figure in the `THROUGHPUT-1c` handoff comes from a
  DERIVED stream that deletes the YES token's changes, not from a recording.
  No claim is made about the whole H1 run: the paired-frame observation of
  `H1-RUN-1.md:71-72` describes the burst only. Measuring the real effect
  needs a live-data paper run. That run must also measure the epoch taint:
  in a gateway with a Binance feed, which H1's is, the Binance adapter's
  subscription-start incident taints the epoch at its start (§5).

## 1. Context

1. **What "fresh" means today.** Three places measure a Polymarket book's age,
   all as `now − (the instant of the book's last applied update)`:
   - the strategy: `packages/strategies/static-bracket/src/decide.ts`
     `assessDataQuality`, `observation.nowMs − books[leg].asOfMs` against
     `data_quality.maximum_book_age_ms`, where `asOf` is "Logical time of the
     last applied book event for this token" (`packages/strategy-sdk/src/views.ts:63`)
     and the trader sets it to the last update's `receivedAt`
     (`packages/trading-core/src/market-state.ts` `bookView`);
   - the feature engine's input: `book.lastEventAt` is the same instant
     (`packages/trading-core/src/loop.ts` `#computeSnapshot`), reported as the
     `polymarket.book` entry of `quality.input_feed_ages`;
   - §9.8 check 7: the trader's `#bookAgeMs` measures the YES book's last
     update, and `packages/risk` classifies it against
     `freshness.venueBookMaxAgeMs` (`packages/risk/src/freshness.ts`).
   `now` is the triggering event's `receivedAt` everywhere (event time;
   `loop.ts` `#processEvent`).
2. **Why that misreads a live book.** The documentation names the triggers of
   a book's events: an order placed or cancelled, a trade, a subscription
   (§2, V2–V4). It does not promise periodic updates, so a book with none of
   those triggers may receive no frame for a long time. Its age then grows
   while the connection keeps delivering other books' frames. In H1 run 1 the example bounds were 2 000 ms
   (`infra/compose/trader/trader.config.example.json`), and 54% of all
   decisions paused on `SB.STALE_BOOK`; in runs 3–8 it was about 9%
   (`docs/handoffs/H1-RUNS-2-8.md`).
3. **What the trader can observe.** Every consumed event carries the §7.1
   session fields `gatewayEpoch`, `connectionId` and `subscriptionGeneration`
   (`docs/spec/polymarket-bot-orchestrator-handoff.md:440-469`). The gateway
   stamps them from the adapter's socket session
   (`apps/data-gateway/src/feeds/polymarket.ts` `onEvent`), mints one
   `connectionId` per connection attempt as `<feedId>-a<ordinal>` — an ordinal
   that restarts with the process (`apps/data-gateway/src/connection-ids.ts`) —
   and receives the venue's `PONG` without publishing anything for it
   (`packages/polymarket-public/src/feed/connection.ts` `#onMessage`). The H1
   burst's 86,033 Polymarket envelopes all carry
   `connectionId: polymarket-market-a1`, `subscriptionGeneration: 2`.

## 2. What the venue documents, and what it does not

Every statement here is quoted from the official documentation, as recorded in
`docs/venue/verified-2026-09-30.md` (§3, W.5, §12) and
`docs/venue/verified-2026-09-16.md` §3, and re-fetched by this round
(2026-09-30): `https://docs.polymarket.com/market-data/realtime-data.md` (S-D13,
SHA-256 `5971b5ae1378e006d5ab01971f59750dd463e78b7b2601db36d8e59497ffd5f7`) and
`https://docs.polymarket.com/api-reference/wss/market.md` (S-D14, SHA-256
`92a02634755fd92cc1c4a3f798ea64f050f76670e677003a9a595d8a8f4c616a`) — both
byte-identical to the digests `verified-2026-09-30.md` §14 indexes (lines
710–711), so no statement below is newer than the verified record.

**Documented (V):**

- **V1 — purpose.** "Use the market stream to keep your application in sync
  with changes to a market's order book and trading state." (S-D13, `## Market
  Stream`, lines 16–17.)
- **V2 — when a level change is sent.** `price_change`: "Delta update to
  orderbook price levels when an order is placed or cancelled" (S-D14 lines
  440–443).
- **V3 — when a full book is sent.** `book`: "Full orderbook snapshot sent on
  subscribe or after a trade" (S-D14 lines 277–278).
- **V4 — trades.** `last_trade_price`: "Trade execution notification" (S-D14
  lines 588–589).
- **V5 — heartbeat.** "The market WebSocket uses an application-level
  heartbeat. Send the text frame `PING` every 10 seconds; the server replies
  with `PONG`." (S-D13 lines 749–750); "Send PING every 10 seconds to keep the
  connection alive" and "Server responds to PING with PONG" (S-D14 lines 219–220,
  248–249).
- **V6 — one subscription carries many assets.** "Public channel for real-time
  market data. Subscribe by providing asset IDs (token IDs)." (S-D14 lines
  16–19); the subscribe frame is `{"assets_ids": [...], "type": "market"}`
  (S-D13 lines 757–760).

**Not documented (N) — this ADR relies on none of these:**

- **N-A — delivery completeness and latency.** No page states that every
  placement, cancellation or trade is delivered, or within what time. V1–V4
  say *what* is sent *when*; nothing bounds the delay from the venue's change
  to the frame.
- **N-B — ordering across assets.** No page states that the server emits the
  changes of different assets of one subscription in the order they happened,
  or through one queue. A frame for asset B is therefore NOT documented
  evidence that no earlier change of asset A is still unsent.
- **N-C — no sequence number.** The market channel's events carry a `hash` and
  a `timestamp`, but no sequence or `dropped` counter (S-D14; contrast the
  PolyBolt stream's documented "Dense per-channel `seq` and a `dropped`
  counter", `verified-2026-09-30.md` E-10). A missed frame cannot be detected
  from the payloads.
- **N-D — U-2.** "Server-side disconnect when `PING` is missed (CLOB WS) —
  Still undocumented" (`verified-2026-09-30.md` §12, line 642). The SDK's
  `CLOB_HEARTBEAT_STALE_MS = 30_000` "is a client-side choice", and PolyBolt's
  documented 25 s ping "is not evidence for the CLOB channels" (W.5, lines
  533–537).
- **N-E — what a `PONG` proves.** The heartbeat is documented as a reply to
  `PING` (V5), nothing more: not that the reply shares the data path, and not
  that the server has flushed every change queued before it.
- **N-F — U-3.** The maximum number of `assets_ids` per subscription is
  undocumented (`verified-2026-09-30.md` §12, line 643).

**Therefore:** the documentation does NOT guarantee that "a live connection
with no message means no change". The documentation identifies event triggers
but does not guarantee periodic updates, delivery completeness, bounded
latency, or that silence means no change (V2–V5; N-A, N-B). No rule available
to this repository can prove that a book is current. What CAN be proved is
narrower: **that the delivery path was delivering, recently.** A book whose
own frame arrived 1.9 s ago was never proved current either (N-A); it was
proved to sit on a path that delivered 1.9 s ago.

A sibling asset's frame proves LESS than the book's own frame, and this
rule must not pretend otherwise. It proves that the session delivers. It does
not prove that THIS asset's changes are being delivered: nothing documents
per-asset completeness or cross-asset ordering (N-A, N-B). So the extension
this ADR grants is bounded per book, by a ceiling on the book's OWN
last-change age (D2 rule 6). Past that ceiling, session traffic stops
vouching for the book, whatever it shows.

## 3. Decision

### D1. What a confirmation is

A **delivery session** is one `(gatewayEpoch, connectionId,
subscriptionGeneration)`. `gatewayEpoch` is part of the key because
`connectionId` restarts with the gateway process (§1.3); the generation is part
of it because a subscription change replaces the server-side subscription
state (`connection.ts` header; handoff §7.1: "A resubscription creates a new
`subscriptionGeneration`").

A **confirmation** of session S at instant T is a market-channel data event
this trader CONSUMED — `BookSnapshot`, `BookLevelChanged` or
`PublicTradeObserved`, `source: "polymarket"`, stamped with S — whose
`receivedAt` is T. Each such event is derived from one frame the venue socket
delivered (`connection.ts` `#onMessage`), recorded raw first and published in
stream order (ADR-002; `feeds/polymarket.ts`). The event's market does not
matter: a frame for a market this trader does not run was delivered on the
same socket, WAL and stream.

What a confirmation proves: the whole path — venue socket, gateway, WAL,
stream, this trader — delivered a frame of session S at T. What it does NOT
prove: that the venue had no change for another asset that it had not yet sent
(N-A, N-B).

**Not confirmations:** reference-feed events; lifecycle events; feed-health
events (`FeedConnected`, `FeedStale`, …, which the trader does not consume);
an event type the trader does not consume; the venue's `PONG` (the gateway
publishes nothing for it; see D5).

**A confirmation counts only from a frame proven WHOLE (r8, R8-H1).** The
events of one venue frame share a frame key (ADR-024: the gateway's
`causationId`, else the dispatch identity). A confirmation is HELD, and is
not a confirmation any evaluation can read, until the trader has PROCESSED
an event of the SAME gateway epoch with ANOTHER frame key after it. Then
the frame's latest confirmation per session is released
(`packages/trading-core/src/book-freshness.ts` `FrameCompletionGate`). A
frame that nothing of its epoch follows never confirms anything. Why that
event proves the frame whole, and why nothing weaker is trusted, is D2.4,
"A frame the trader has not proven whole".

### D2. When a book is fresh

A book is vouched for as of `confirmedAt`:

```text
confirmedAt(book) = max(lastChange(book), latestConfirmation(session(book)))
```

where `session(book)` is the session of the update that last CHANGED the book
(recorded only after the book accepted it), and `latestConfirmation` is the
latest confirmation of that session from a frame the trader has proven
whole (D1, r8). So an evaluation is never vouched for by the frame it is
evaluating: frame k is vouched for by frame k−1 at the latest. The book is FRESH iff
`now − confirmedAt ≤ bound`, with the same bounds as before
(`data_quality.maximum_book_age_ms`, `freshness.venueBookMaxAgeMs`) and the
same `now` (event time). Under `CONNECTION_CONFIRMED` the latest
confirmation is first moved back by the process lag, and rule 6 is judged
at the process's instant (the process-lag guard, D7, r2); with no lag, as
in a backtest, the formula above is exact.

`confirmedAt` falls back to `lastChange(book)` — the pre-ADR-023 rule, never
more permissive than it — whenever any of rules 1–6 applies:

1. the configured basis is `LAST_CHANGE` (D4);
2. the book's last update carried no `connectionId` or no
   `subscriptionGeneration` — a REST snapshot, which the gateway stamps with a
   generation but no connection (`feeds/polymarket.ts` `#recover`), or recorded
   data without the session fields;
3. the session has no known confirmation (never seen, or evicted from the
   bounded table of 1 024 sessions);
4. the session's **gateway epoch is tainted**: a `DataQualityIncidentOpened`
   that names no market (`affectedMarketIds` absent or empty) has arrived from
   that epoch. The gateway opens exactly such incidents when it suppresses a
   frame's events after a WAL refusal (`GATEWAY_WAL_FRAME_REFUSED`), cannot
   normalize a frame, refuses one of a frame's envelopes
   (`GATEWAY_ENVELOPE_REJECTED`, r6), is about to publish a frame too large
   for one transport call (`GATEWAY_FRAME_SPLIT`, r7), or sees a heartbeat
   stall (`GATEWAY_FEED_STALL`) (`feeds/polymarket.ts`, `dispatcher.ts`). From
   then on "another asset's frame arrived" no longer implies "this asset's
   frames are being delivered". The taint covers
   EVERY session of the epoch, later ones included, and is never lifted,
   because the gateway's incident registry deduplicates an open incident per
   `(scope, reasonCode)` and closes only the stall and snapshot-fetch
   incidents (`apps/data-gateway/src/incidents.ts` `open`,
   `feeds/polymarket.ts`): a repeat of a WAL refusal or of a normalization
   problem after a reconnect publishes NOTHING, so a per-session taint would
   leave the new session looking clean while its frames are being suppressed.
   A gateway restart (a new epoch) starts clean. Every severity taints, `LOG`
   included (when in doubt, stale).
   A frame the gateway could only partly normalize is reported BEFORE its
   accepted events. The adapter calls `onProblem` for the frame's problems
   before `onEvent` for its events (`connection.ts` `#onMessage`), and the
   gateway opens the incident synchronously, so the incident is sequenced
   ahead of every sibling event of that frame, and the epoch is tainted
   before any sibling can close an evaluation (r1, X8).
   **A frame the gateway itself could only partly publish (r6, R6-H1)** is
   reported the same way. An event the adapter accepts can still be refused
   by the frozen envelope contract when the gateway completes it: a venue
   `timestamp` inside the adapter's epoch range
   (`packages/polymarket-public/src/normalize/values.ts`, |ms| ≤ 8.64e15)
   whose ISO form has a five-digit year (`253402300800000` gives
   `+010000-…`; the frame's own instant sent in MICROSECONDS gives
   `+058142-…`) is refused by `IsoTimestampSchema`. Before r6 the dispatcher
   refused such an event only when it reached it, AFTER the frame's earlier
   siblings were submitted. Its `GATEWAY_ENVELOPE_REJECTED` incident carries
   no raw-frame causation, so the trader read it as a frame of its own
   (ADR-024's frame key) and evaluated the sibling's frame before the taint
   landed: review reproduced 2 approved orders under `CONNECTION_CONFIRMED`
   (0 under `LAST_CHANGE`). Now the driver hands the dispatcher each socket
   message's market-data events as ONE frame
   (`feeds/polymarket.ts` `frameBoundedSocketFactory`: the adapter handles a
   message synchronously inside the socket's `onMessage`, so that callback
   bounds the frame), and `GatewayDispatcher.dispatchFrame` assigns and
   validates every envelope of the frame before it submits any. If one is
   refused, the incident (no market) is opened FIRST, stamped with the
   frame's first receipt, and the accepted events follow it under fresh
   sequences; when none is refused, the stream is byte-identical to one
   dispatch per event. The other ways a frame can lose events between the
   socket and the stream were checked. A WAL refusal opens its incident
   before the frame is parsed and suppresses every derived event. The
   transport's door (`packages/event-bus` `encodeEnvelope`) is derived from
   the same domain envelope schema, so it accepts every envelope
   `completeEnvelope` accepted (its one tightening, a top-level `__proto__`
   member, is never written by the gateway). REST recovery snapshots are
   dispatched one by one, as before: they carry no session (rule 2), so
   their order vouches for nothing.
   **A frame published across two transport calls (r7, R7-H1).** A
   publication halt (an outage, a full queue, a refused admission)
   suppresses everything still queued, so it cannot cut a frame that one
   transport call carries. The r6 text said a frame of up to 1 024 events
   is never split across two calls. That was FALSE. The publisher
   (`apps/data-gateway/src/publisher.ts`, "Frame-atomic runs") never cut a
   run inside a frame, but a run that already held up to 255 envelopes of
   earlier frames could START a frame and then stop at the Redis
   transport's limit of 1 024 envelopes per call. Behind a backlog, a frame
   of about 770 events or more was split (review reproduced `[A200+B824],
   [B76]` for a 900-event frame B), and a frame of more than 1 024 events
   was always split. An outage between the two calls published a PREFIX.
   The trader closes a frame when the stream moves on or runs dry
   (`apps/trader/src/adapters/redis-feed.ts`: a short read is handed out
   whole; `loop.ts` closes the frame when the queue ends), so it evaluated
   the prefix as a whole frame, and the prefix vouched for a book whose
   change was in the lost tail. Review reproduced 2 approved orders under
   `CONNECTION_CONFIRMED` (0 under `LAST_CHANGE`) with a 4 096-deep
   admission queue; the H1 operator ran 16 384. "After which the stream
   ends" is therefore not a safety argument. r7 closes both routes:
   - **Backlog splits.** A run never starts a frame it cannot hold whole.
     Before a run that already holds envelopes takes a frame's first
     envelope, the publisher counts the frame's envelopes in the queue,
     and if the run plus the whole frame would pass 1 024, the frame starts
     the next run. The count is exact, because every queued frame is
     complete when a run is cut (one `dispatchFrame` call per socket
     message). So a frame of up to 1 024 events is now ONE transport call,
     published whole or not at all.
   - **Frames too large for one call.** A frame of more envelopes than the
     publisher submits in one call (`GatewayPublisher.atomicFrameEnvelopes`:
     1 024 with the Redis transport's batch capability, and 1 without it;
     only test doubles and the startup-outage transport lack it, and that
     transport publishes nothing) cannot be one call. So
     `GatewayDispatcher.dispatchFrame` opens a `GATEWAY_FRAME_SPLIT` incident
     naming no market BEFORE the frame's events are assigned sequences,
     stamped with the frame's first receipt. Whatever later happens to the
     tail, the epoch is tainted before any of the frame's events can close
     an evaluation. The registry key is closed again at once, so EVERY
     oversized frame is preceded by its own incident. A trader that joined
     the epoch late therefore still meets one ahead of the frame, and this
     route is not left to the X2 bound. Its severity is `LOG`: nothing was
     lost, and the incident exists to taint. When publication has already
     halted, no incident is opened, because nothing of the frame can be
     published.
   The cost is stated, not hidden: an oversized frame turns the extension
   off for the rest of the epoch even when it is delivered whole
   (fail-closed; §5). In the H1 burst fixture (99 668 events) the largest
   Polymarket frame has 2 events, and the largest frame of any source has 65
   (a Coinbase frame, which never confirms). One case remains, and it is
   unchanged: an envelope
   the transport REFUSES inside a run publishes the run's prefix and halts
   (`packages/event-bus/src/redis/transport.ts` `publishBatch`: a door,
   epoch or ordering refusal at index `k` publishes `0..k-1`; a script,
   server or queue failure publishes nothing). The gateway's own envelopes
   pass the door (above). One gateway process publishes one epoch. The
   publisher admits only sequences above its high-water mark, in assignment
   order. So none of these refusals is expected, and each one would halt
   publication loudly. (r8: that case no longer reaches book freshness; see
   the next paragraph.)
   **A frame the trader has not proven whole (r8, R8-H1: the class).** The
   r7 text above, and handoff-r7, said a frame of up to 1 024 events is
   published whole or not at all, and treated that as closing the route.
   It did not, because the READ side cuts frames too. The trader's feed
   (`apps/trader/src/adapters/redis-feed.ts` `RedisMarketEventFeed.poll`)
   reads at most `receiveBatchSize` events (1 to 10 000; the example
   configuration ships 128 next to `CONNECTION_CONFIRMED`). A frame longer
   than that is handed out across two polls, counted only in `framesSplit`.
   `loop.ts` closes a frame at the end of what one drain was handed, so the
   first part closed as if it were the frame, and its events confirmed the
   session while the change in the unread part was not yet applied. Review
   reproduced 2 approved orders under `CONNECTION_CONFIRMED` (0 under
   `LAST_CHANGE`) through real Redis, with no outage and no backlog: a frame
   of 129, 200 or 1 024 events at `receiveBatchSize` 128, and of 2 events at
   `receiveBatchSize` 1. Rounds 6, 7 and 8 each found a new boundary of this
   kind (a refused envelope, a transport call, a poll), so r8 does not close
   one more boundary. It moves the rule to the CONSUMER, where it holds
   whatever any upstream boundary does:
   - **The invariant.** No evaluation takes a confirmation from a frame the
     trader has not applied in full, and a frame the trader cannot PROVE
     complete is non-confirming (fail closed). A frame is proven complete
     when the trader processes an event of the same gateway epoch that
     belongs to another frame. Until then its confirmations are held, and
     a frame that is never followed never confirms
     (`book-freshness.ts` `FrameCompletionGate`, fed every consumed event
     by `loop.ts` `#observeDeliverySession`).
   - **Why that event proves the frame whole.** Three properties of the
     path, each already relied on and pinned elsewhere:
     (P1) the gateway submits a frame's envelopes CONSECUTIVELY: one socket
     message is one synchronous `dispatchFrame` call into ONE FIFO publisher
     queue, and the publisher submits in queue order (`publisher.ts`,
     "Submission order is assignment order"; `feeds/polymarket.ts`: the
     adapter emits only market-data events inside a message, so nothing
     else is dispatched between two of them);
     (P2) a loss inside an epoch is final or announced: EVERY unsuccessful
     submission halts that epoch's publication for good (`publisher.ts`,
     "Every unsuccessful submission halts": an outage, an overflow, a
     refusal), and every loss the gateway survives (a WAL refusal, a
     normalization problem, a refused envelope, a frame too large for one
     call) is a no-market incident sequenced AHEAD of the frame, which taints
     the epoch (rule 4 above);
     (P3) the trader reads its stream in order and without gaps: a retention
     gap is a hard resync, which halts (`pump.ts`).
     So an event of epoch E that the trader processes after frame F was
     published after ALL of F, and everything between them was delivered to
     the loop and processed first. An event of ANOTHER epoch proves nothing:
     a gateway restart may have lost F's tail.
   - **What is no longer trusted.** A short read, the end of a batch, the
     size of a transport call, the feed's carry, the r7 look-ahead. A frame
     read across two polls, a frame whose tail an outage or a transport
     refusal cut off, and a frame at the end of the stream are all simply
     not yet proven. The gateway's own orderings (r1, r6, r7) stay, as
     defence in depth: under r8 an incident published right AFTER its frame
     (the pre-r6 order) would also be safe, because that incident is the
     very event that proves the frame, and it taints the epoch in the same
     step, before any evaluation reads the confirmation.
   - **Bounded buffering.** The feed still hands a long frame out in parts,
     at any `receiveBatchSize`, so its buffering stays bounded by it. The
     gate holds one frame per gateway epoch (at most 1 024 epochs, then the
     oldest is forgotten and confirms nothing) and keeps one instant per
     session of that frame. No configuration is refused: the rule needs no
     carry rule and no ingest-depth argument, because it does not depend on
     how the events were batched, polled or queued.
   - **What it costs.** One frame: an evaluation at frame k is vouched for
     by frame k−1 at the latest, never by frame k itself, and the last frame
     before a quiet spell vouches only once the next event of its epoch
     arrives (§5).
   Every boundary on a frame's path, from the venue socket to the loop's
   evaluation, with what it does to a frame and the pin for each, is listed
   in the `THROUGHPUT-1c` r8 handoff ("Every boundary").
   **What "never lifted" covers, and what it does not (r1, X2).** The taint
   is state of THIS PROCESS, fed by the incidents it consumed. A trader that
   starts, restarts or resumes from its checkpoint inside an epoch whose
   incident it did not consume does not know the epoch is tainted: the
   incident is deduplicated and will not be published again, and neither
   the transport's resume point nor its oldest retained event guarantees a
   replay of it. No sound signal exists today by which the trader could tell
   that it consumed an epoch from its start. `ingestSeq` does not work,
   because the published sequence has holes by design (`dispatcher.ts`).
   Neither does any other published event: none reliably marks an epoch's
   start. This gap is ACCEPTED and bounded, not closed. Such a trader can
   vouch for a book past its last change for at most the ceiling of rule 6,
   which is the same exposure every untainted epoch already carries under
   N-B. A retention gap inside a running process is not part of this gap:
   the transport reports it as a hard resync, which halts the trader
   (`apps/trader/src/pump.ts`). Closing the gap needs a new gateway signal
   (see §5);
5. the market has an active data-quality incident of its own;
6. **the per-book ceiling (r1, X1):** `now − lastChange(book)` is more than
   `maximumLastChangeAgeMs`. The configuration requires this ceiling with
   `CONNECTION_CONFIRMED` (D4). It is an integer from 1 to 600 000 ms, and
   the example configuration sets 30 000 ms. Once a book's own last change is
   older than the ceiling, the book ages by that last change, and the
   ordinary bound judges it. So a book whose own delivery stalled while its
   session stayed busy is stale at `lastChange + max(ceiling, bound)` at the
   latest. It no longer stays fresh for as long as sibling assets keep
   arriving. The ceiling is an operator's choice, not a venue fact: no
   documented venue period bounds how long a live book may stay quiet (§2).

### D3. When a book is stale

| Case | What happens | Detected by |
| --- | --- | --- |
| Quiet book, live session (the H1 case) | other assets' frames keep confirming the session: FRESH, until the book's own last change is older than the ceiling | D2, rule 6 |
| One asset's delivery stalls while the session stays busy (N-B) | FRESH until the ceiling, then aged by its own last change: STALE at `lastChange + max(ceiling, bound)` at the latest | D2 rule 6 |
| A frame the gateway could only partly normalize | the frame's incident is sequenced before its accepted events, so the epoch is tainted before any sibling evaluates | D2.4 (r1, X8) |
| A frame one of whose events the gateway's envelope contract refuses (an adapter-accepted `timestamp` whose ISO year has five digits, e.g. one sent in microseconds) | every envelope of the frame is validated before any is published; `GATEWAY_ENVELOPE_REJECTED` (no market) is published ahead of the frame's accepted events, so the epoch is tainted before any sibling evaluates | D2.4 (r6, R6-H1) |
| A frame published across two transport calls, with an outage between them (a frame queued behind a backlog, or one larger than the transport's 1 024-envelope call) | a frame of up to 1 024 events is now one call, so an outage publishes all of it or none; a larger frame is preceded by `GATEWAY_FRAME_SPLIT` (no market), so the epoch is tainted before any of its events evaluates, whether or not its tail is lost. Since r8 the trader holds either way: a prefix that nothing of its epoch follows is never proven whole, so it never confirms | D2.4 (r7, R7-H1; r8) |
| A frame read across two polls (longer than `receiveBatchSize`, 1 to 10 000; the example ships 128), with no outage at all (R8-H1) | the first part closes an evaluation, but the frame is not proven whole, so its confirmations are held: the book is judged by earlier, proven frames. They are released only when an event of the same epoch from another frame is processed, after the whole frame is applied | D1, D2.4 (r8, R8-H1) |
| A frame whose tail never arrives, for any reason (an outage between calls, a transport refusal inside a call that publishes the call's prefix, an admission overflow, a crash) | nothing of the epoch follows the prefix (P2), so the frame is never proven and never confirms; the session ages from its last proven frame and goes STALE within the bound | D2.4 (r8) |
| The newest frame, before anything else of its epoch arrives | not yet proven: it does not vouch, even for the evaluations at its own close. The cost of the rule (§5) | D1 (r8) |
| A trader that resumes inside a frame (a restart after a commit that fell inside a split frame) | it sees the frame's tail as a frame of its own, held until the next frame of the epoch; the books it knows were all built from events it applied after its resume point, so no unapplied change of that frame belongs to a book it holds | D2.4 (r8) |
| A trader that starts or restarts inside an epoch whose incident it did not consume | the taint is unknown to it (an accepted gap): bounded by the ceiling | D2.4, rule 6 (r1, X2) |
| Silent session, socket still open | no confirmations: STALE at `lastConfirmation + bound` | D2 (no rule needed) |
| Disconnection (`FeedDisconnected`), reconnect | the old session gets no more frames; the new session's frames do not confirm a book delivered on the old one: STALE within the bound. A book re-delivered on the new session is confirmed by it | D1 key |
| Missed `PONG` (`FeedStale`), heartbeat loss | the gateway reconnects (`reconnectWhenStale`), so as above; and its `GATEWAY_FEED_STALL` incident taints the gateway epoch | D2.4 |
| Subscription change (new generation) | a new session; books of the old generation are not confirmed by it | D1 key |
| Gateway restart | new `gatewayEpoch`: a new session even though `connectionId` repeats | D1 key |
| Gateway publication halt / overflow (`CO2-N6`) | nothing more is published, so no confirmations: STALE within the bound — IF any other event still advances the trader's event time; if nothing arrives at all, nothing is evaluated. A halt cannot leave part of a frame of up to 1 024 events in the stream, and a larger frame is preceded by its taint (r7); and whatever a halt leaves, the last frame before it is never proven whole, so it never confirms (r8) | D2 (and N1, D7); D2.4 |
| Gateway WAL refusal, unparsable frame | the gateway's incident names no market: the epoch is tainted, fallback to the last change for the rest of the gateway's life (repeats are deduplicated, D2.4) | D2.4 |
| Market data-quality incident | fallback to the last change | D2.5 |
| REST recovery snapshot | no session: last change only, until a socket frame for that asset lands on a session | D2.2 |
| Trader lagging the stream | ages are measured in event time, exactly as before (`CO2-N1` unchanged). The EXTENSION is narrowed by the process lag: a confirmation is moved back by `max(0, processNow − eventNow)` and the ceiling is judged at the later instant, so a trader behind by more than a confirmation's lead over the last change gets exactly `LAST_CHANGE` (r2) | D7 (process-lag guard) |
| Replay of old data | in a backtest (replay clock at each event) deterministic, lag 0 (D8); in a live-clock process (a late trader, a catch-up bench) the guard gives `LAST_CHANGE` once the lag exceeds the confirmation's lead; data without session fields ages by the last change | D2.2, D7, D8 |

### D4. The opt-in, and backward compatibility of configurations

The trader configuration gains ONE optional block, in one of two shapes:
`bookFreshness: { basis: "LAST_CHANGE" }` or
`bookFreshness: { basis: "CONNECTION_CONFIRMED", maximumLastChangeAgeMs: <1..600000> }`.
The ceiling is REQUIRED with `CONNECTION_CONFIRMED` and refused with
`LAST_CHANGE`. It has no default, because a safety bound nobody chose is not a
bound. Its ten-minute cap stops the extension from being configured into a
disguised "freshness off". An absent block means `LAST_CHANGE`
(`packages/trading-core/src/config.ts` `bookFreshnessBasisOf`,
`bookFreshnessCeilingMsOf`). This is the document's only optional key, and it is
disclosed there: absence selects the STRICTER rule (the confirmed instant is
never earlier than the last change), there is no `.default()` (absence is read
as an own-property absence on the prototype-free D1 tree, ADR-020), and every
configuration written before this ADR — registered runs `BOOT-1` compares,
golden configurations, operators' templates — must keep loading with its
original meaning. Under `LAST_CHANGE` the loop records nothing new and computes
exactly the pre-ADR-023 values; a test pins byte-identical decisions for an
absent block and an explicit `LAST_CHANGE`. (Until r6 the loop did record each
applied book update's session under `LAST_CHANGE` too, without ever reading
it; r6 returns before recording, and a test pins that no session is recorded
under an absent block or `LAST_CHANGE` (review round 6, O-R6-I1).)

### D5. How the signal flows

- **Gateway: no new event type; three ordering changes (r1, X8; r6, R6-H1;
  r7, R7-H1).** The session fields every market-data envelope already
  carries are the signal. The market-channel adapter now reports a frame's
  normalization problems BEFORE its accepted events
  (`packages/polymarket-public/src/feed/connection.ts`), so the gateway's
  incident for a partly malformed frame precedes the frame's siblings in the
  stream (D2.4). The gateway validates every envelope of a socket
  message's frame before it publishes any (`apps/data-gateway/src/dispatcher.ts`
  `dispatchFrame`, `feeds/polymarket.ts`), so an envelope it refuses is
  reported ahead of the frame as well (D2.4, r6). And the publisher never
  starts a frame in a run that cannot hold it whole, while the dispatcher
  publishes a `GATEWAY_FRAME_SPLIT` incident (a new reason code, not a new
  event type) ahead of a frame too large for one transport call
  (`publisher.ts`, `dispatcher.ts`; D2.4, r7). Nothing is dropped that was
  not dropped before, and the accepted events keep their order; a refusal
  leaves the first pass's sequences as holes, which the stream already
  allows (`dispatcher.ts` header). Grouping envelopes into transport calls
  changes no stream entry. A `PONG`-derived
  liveness event was considered and not built (Option B): a `PONG` confirmation
  has age 0 when it arrives, so it would satisfy a 2 000 ms bound briefly,
  but a 10 s heartbeat (V5) cannot maintain continuous freshness under a
  2-second bound (it would leave at least 8 s of every 10 s unconfirmed), and
  N-E means a `PONG` proves less than a data frame. It becomes worth building
  only if an operator wants bounds above the heartbeat period for a whole
  quiet subscription.
- **Stream: unchanged.** ADR-002 ordering; the session fields ride on the
  envelope (§7.1).
- **Trader (`packages/trading-core/src/book-freshness.ts`, `loop.ts`):** every
  consumed event is offered right after the event door, before the event is
  applied or evaluated, to the frame gate (r8), which first releases the
  previous frame of the event's gateway epoch into the session table when
  the event belongs to another frame, and then holds the event's own
  confirmation against its frame; the loop records each applied book
  update's session per outcome (`market-state.ts` `noteBookSession`). The
  feed (`RedisMarketEventFeed`) is unchanged: it still hands a frame longer
  than `receiveBatchSize` out in parts, and its `framesSplit` note points
  here.
- **Features:** the book section's `lastEventAt` is `confirmedAt` (under
  `LAST_CHANGE`, the pre-ADR-023 value). No feature definition changes:
  `quality.input_feed_ages` still reports `asOf − lastEventAt`
  (`docs/contracts/features-v1.md` §7); the contract's inputs table describes
  `lastEventAt` as the caller's stamp, and the caller now states when the book
  was last vouched for. Snapshot content addresses change only for opted-in
  runs, and only where `confirmedAt` differs from the last change.
- **Projection (`packages/trading-core/src/projection.ts`, now
  `feature-projection/v2`):** rule R6 projects
  `quality.input_feed_ages@<feedId>` as a canonical base-10 integer string.
  Everything v1 projected, v2 projects identically.
- **Strategy (D6).** **Risk:** §9.8 check 7's `VENUE_BOOK` measurement is
  `now − confirmedAt` of the YES book (the book it always measured);
  `packages/risk` itself is unchanged — it classifies caller-supplied ages
  (`freshness.ts`: "NO CLOCK IS READ IN THIS PACKAGE").

### D6. The strategy's parameter and version discipline

Static Bracket's configuration grammar gains **version 2**: version 1 plus ONE
required key, `data_quality.book_age_feature_key`, which must be exactly
`quality.input_feed_ages@polymarket.book`. Under version 2 the gate reads the
root's measured age for the configured direction's book (the feature
snapshot's subject); an absent, missing or malformed measurement is a stale
book, never replaced by the view's age. A complement-leg bracket's OTHER book
keeps the version-1 age, because the snapshot says nothing about it. Version 1
is unchanged and still loads: its gate is `now − book.asOf`, whatever the
root's basis.

`STATIC_BRACKET_VERSION` stays `1.1.0`: a version-1 run's behaviour is
byte-identical, and a version-2 configuration is a new configuration identity
(a new `configId`). The code version is pinned by the registration command
(`apps/trader/src/register`, not this round's path); if the user wants the
code version bumped as well, it must move there in the same change.

**What the configuration identity does NOT cover (r1, X6).** The
`bookFreshness` block (its basis and ceiling) lives in the TRADER
configuration document, not in the strategy parameters. The registration
command hashes and persists only the parameters (`register/template.ts`,
`register/registration.ts`), so the `configId` does not bind the basis. One
`configId` can therefore run under `LAST_CHANGE` in one process and under
`CONNECTION_CONFIRMED` in another. Reproducing or auditing a run's freshness
behaviour needs the trader configuration file that process was started with,
as external provenance: the operator's deployed
`infra/compose/trader/trader.config.json`, or the configuration a backtest
was invoked with. Binding the basis to the registered identity would need the
registration path, which is outside this round's allowed paths (§5).

### D7. Clock semantics, `CO2-N1`, and the process-lag guard

**Clock semantics: unchanged.** Both `now` and every confirmation instant are
event `receivedAt` values, and every age is measured in event time, as
before. This ADR does not address `CO2-N1`: live admission runs on event
time, so a stale backlog can be admitted late, under `LAST_CHANGE` exactly as
before this ADR.

**The widening r1 found (X9), and how r2 removes it.** A trader lagging the
stream judges a book fresh relative to the event it is processing. Without a
guard, `CONNECTION_CONFIRMED` admitted MORE lagged states than `LAST_CHANGE`,
because a sibling frame in the backlog vouched for a book whose own change
was older. Reproduced in review against `a0a5f24`: process clock 09:30, YES
book changed 09:00:01, NO snapshot 09:00:04.100 on the same session;
`LAST_CHANGE` gave 0 approvals and `CONNECTION_CONFIRMED` gave 2. That
conflicts with review criterion B ("a trader lagging behind the stream; a
replay of old data" must not read fresh while the feed is not provably live).

r2 implements option (a) below, the **process-lag guard**, as the narrowest
change that removes the widening without touching `CO2-N1`
(`book-freshness.ts` `bookConfirmedAt`, `loop.ts` `#processNowEpochMs`):

- under `CONNECTION_CONFIRMED` only, the loop reads its `Clock` port (the
  §12.1 port it already holds: `SystemPaperClock` in a PAPER process, the
  replay clock in a backtest) when it asks for a book's vouched-for instant;
- `lag = max(0, processNow − eventNow)`. Rule 6's ceiling is judged at
  `eventNow + lag`, and the session confirmation is moved back by `lag`
  before it is compared with the last change, so its event-time age equals
  its age at the process's own instant;
- the answer is never earlier than the book's last change, so a lag of at
  least the confirmation's lead over the last change (the reviewers' 30
  minutes, or any catch-up of recorded data) gives EXACTLY the
  `LAST_CHANGE` answer; an unreadable or non-finite process reading turns
  the extension off.

Why this is not a clock-semantics change: nothing is measured against the
process clock that was measured against event time before. `now` for every
age, the `LAST_CHANGE` path (which reads no clock), admission, the risk
gates' inputs and N1 are all unchanged. The process clock can only REMOVE
extension this ADR added; it can never make a book fresher than the
unguarded `CONNECTION_CONFIRMED` rule. It is NOT a promise of `LAST_CHANGE`
parity at every lag: while the shifted confirmation still leads the last
change, the answer is fresher than `LAST_CHANGE` (last change 0,
confirmation 5 000, event 5 200, lag 1 700: age 1 900, fresh, against 5 200,
stale, under `LAST_CHANGE`; that is the extension this ADR adds, bounded by
the process's own instant). The answer EQUALS `LAST_CHANGE` once the shifted
confirmation no longer leads the last change, or once another fallback
(rule 6's ceiling, an unreadable process clock, a tainted epoch, no session
confirmation) applies. A process clock that runs BEHIND event
time (skew between the gateway host and the trader host) reads as lag 0, the
pre-guard answer.

**A backward step of the gateway's wall clock (review round 6, O-R6-I2).**
Every `receivedAt` is the gateway's wall clock (`apps/data-gateway/src/system.ts`
`nowMs`, stamped by `ports.ts` `takeReceipt`). If that clock steps BACK by
`S` just after a session's last confirmation and the session then falls
silent, later events carry instants up to `S` before that confirmation, so
in event time the confirmation stays young: the session's books can read
fresh for up to `S + bound` of real time, and rule 6's ceiling, judged in the
same stepped event time, does not cut it short. This is a pre-existing
event-time property, not a new one: under `LAST_CHANGE` a book's own last
change ages the same way after such a step. What `CONNECTION_CONFIRMED`
widens is its reach, from the one book that changed to every book on the
session. The process-lag guard removes it when only the gateway's clock
stepped: the trader's process clock is then ahead of event time by about
`S`, the confirmation is moved back by that lag, and it ages in real time.
It remains when both clocks step together (one host, the H1 deployment's
shape) or when the trader's clock carries the same skew. Not closed here:
it needs a monotonic receipt basis, which is the clock-semantics question
`CO2-N1` owns.

What it does not do: it does not make `LAST_CHANGE` lag-aware (that is N1),
and a trader behind by less than the bound is still judged in event time for
the part of the age that is its own last change. Pinned by
`book-freshness.test.ts` › "r2 X9": the reviewers' reproduction (0 orders
under both bases), a 30-minute replay equal to `LAST_CHANGE` evaluation by
evaluation, a live process 1 700 ms behind fresh and 1 900 ms behind stale
at the same event, and a per-event replay clock equal to the unlagged run.

**The ruling: option (a), interim; confirmed by the user's ratification on 2026-10-02.** Round 1 asked the orchestrator or the
user to choose among the three options below. The choice is recorded in
`IMPLEMENTATION_STATUS.md` (Authorized now, `THROUGHPUT-1c`, "Interim
rulings", orchestrator, 2026-10-01), not here, as two interim rulings, each
the most conservative option: option (a), the process-lag guard as
implemented; and the reading above, that the guard's use of the `Clock` port
is NOT a clock-semantics change (`CO2-N1` unchanged). Both await the user's
ratification of this ADR, which is still the merge gate for `THROUGHPUT-1c`;
at ratification the user confirms or replaces them. The options:

- (a) **the live-admission guard:** implemented in r2 as above, and the
  option the interim ruling chose. Accepting it closes the conflict with
  criterion B for this rule;
- (b) **narrowing criterion B** for this rule: accept that event-time
  freshness is judged in event time under both bases until N1 lands. The
  guard would then be stricter than required, never looser, and can stay;
- (c) **deferring the opt-in:** leave `CONNECTION_CONFIRMED` unused (absent
  block) until N1 lands. Compatible with the code as it stands.

The two interact in one further way: a future N1 rule that measures ages
against a wall clock can use `confirmedAt` unchanged. With such a rule the
guard's shift and N1's measurement would count the same lag, so N1 must
measure ages from the UNSHIFTED instant, or drop the guard (whichever lands
second removes the double count; both directions are fail-closed).

### D8. Replay and backtest determinism

`confirmedAt` is a pure function of the consumed event sequence and, under an
opted-in `CONNECTION_CONFIRMED` basis only, of the caller's process-clock
reading (the D7 guard's `lag`): the session table is fed in stream order,
uses only envelope fields, and its eviction is insertion-ordered; the lag is
the one non-event input, and it is 0 under a replay clock positioned at each
event. The backtest CLI runs the same `CoreLoop` behind the same
configuration door (ADR-022), so replay and backtest reproduce live decisions
over the same events, PROVIDED the replay starts from the same point and
the process is not restarted in between: the epoch taint is state of the
process (D2.4). A process that consumed an epoch's incident reads a later
book by its last change, and a process started after that incident reads it
by its confirmation (review probe: a continuous process stale at 3 100 ms,
a restarted one fresh at 0 ms after the same later events), so parity holds
for the same initialization and restart boundaries, and a replay that
starts mid-epoch reproduces a trader that started there, not one that ran
through it. The process-lag guard (D7) is the other qualification: a
backtest's replay clock sits at each event (lag 0), so it reproduces a live
process that kept up; a live process that ran behind by more than a few
milliseconds may have read a book stale that the replay reads fresh, never
the reverse (the guard only removes extension). The lag also reaches the
records, not only the verdicts: under an opted-in `CONNECTION_CONFIRMED`
basis, the shifted instant is what the loop hands to features as the book's
confirmation, so a live process's feed ages and its `featureSnapshotRef`
hashes carry its process lag, and byte parity of those records with a replay
is NOT guaranteed even where every stale/fresh outcome matches (review probe:
a 3 ms lag changed 12 of 13 decision records with identical outcomes);
evaluations that fall back (`LAST_CHANGE`, rule 6, a tainted epoch) can
still match byte for byte. Under the default `LAST_CHANGE` basis no clock is
read and parity is as before. ADR-024's frame grouping is unaffected. The
frame gate (r8) is a pure function of the consumed event SEQUENCE: a frame
is released when the next event of its epoch from another frame is
processed, whatever the batches, polls or drains were. So a live process, a
replay that drains once per recorded frame and a backtest that drains once
per event release every frame at the same event, and the confirmation an
evaluation at a given event can read does not depend on `receiveBatchSize`.
What can still depend on the batching is ADR-024's cadence: when a feed
hands a frame out in parts, each part's close is an evaluation of its own,
and that evaluation is vouched for by earlier, proven frames only. Pinned:
the same events in five partitions, cuts inside the frame included, admit
the same entry at the same event. A raw-frame replay through the
verification-only normalizer releases a recorded frame at the next record's
first event, as live does.
Inside one frame a later event's `receivedAt` may sit a millisecond after the
instant the frame's evaluation of a market uses; a book that later event
changed then has a negative age, which every gate reads as fresh — exactly
as a book update stamped after the evaluating event always was
(`features-v1.md` §2: feed stamps "may sit after `asOf`"; the order-book
never-clamp rule). Since r8 that comes from the book's own last change only:
a frame's confirmations are never read inside the frame.
Recorded data without session fields replays under the last-change rule, so an
old recording can never read fresher than it did. A backward step of the
gateway's wall clock (D7, O-R6-I2) is in the recorded `receivedAt` values, so
a replay (lag 0) reproduces the extension it caused as a process on the
gateway's host would have read it, never the guard's correction a trader on
another, unstepped host applied.
The `GATEWAY_FRAME_SPLIT` incident (D2.4, r7) is part of the published
stream, so a replay of a normalized-stream recording reproduces it and its
taint exactly. A raw-frame replay through the verification-only
`polymarketMarketNormalizer` (`apps/backtest-cli/src/normalizer.ts`; not
selectable from the CLI) runs no gateway. It therefore never splits a frame
and never publishes the incident, so under an opted-in
`CONNECTION_CONFIRMED` it can vouch through an oversized frame where the
live trader was tainted. That replay is more permissive than live, in a
backtest only. As with r6's refused-envelope case, a raw-frame replay is not
a reproduction of the gateway.

## 4. Options considered

- **A. Keep the last-change rule.** Not chosen, because of the finding: 54%
  of H1 run 1's decisions paused on `SB.STALE_BOOK`. This ADR's evidence
  shows the mechanism on a derived stream. It does not show that those
  pauses were quiet books (see the header). Keeping the rule remains the
  fallback (D4: absent block).
- **B. A gateway liveness event from `PING`/`PONG`.** A new domain event per
  `PONG`, consumed by the trader as a session confirmation. Not built: the
  heartbeat period (10 s, V5) exceeds the bounds in use (2 s). A `PONG`
  confirmation would satisfy a 2 s bound for up to 2 s after it arrived, but it
  cannot maintain continuous freshness under a 2-second bound: a fully quiet
  subscription would still read stale for at least 8 s of every 10 s. And a
  `PONG` proves less than a data frame (N-E). It needs a new event contract
  (schema discipline) for little benefit at current bounds: for a whole quiet
  subscription, a brief fresh window after each heartbeat; for a busy
  session, nothing the data frames do not already give.
  Kept as the documented extension if bounds above 10 s are ever wanted for a
  fully quiet subscription.
- **C. "Connected and no disconnect seen" means live.** Rejected: absence of a
  negative signal is not provable liveness (a stalled gateway publishes
  nothing, including its disconnect), and the trader does not consume
  feed-health events.
- **D. Session confirmations by consumed data frames, with a per-book
  ceiling (chosen).** It uses only fields every envelope already carries. It
  needs no new event type or contract change, only the losses-first order
  of D5 (the adapter's problems, r1; the gateway's envelope refusals, r6;
  whole-frame transport calls and the split-frame taint, r7) and, since r8,
  the consumer's own rule that a frame confirms only once a later frame of
  its epoch proves it whole (D1, D2.4).
  It fails closed on every missing piece. It is WEAKER per book than the last-change rule's proof, because a sibling's
  frame says nothing about this asset's delivery (§2, "Therefore"). The
  ceiling (D2 rule 6) bounds that weakness.
- **E. Raise `maximum_book_age_ms`.** Rejected: it loosens the bound for books
  on dead sessions too; D keeps the bound and changes only what counts as
  evidence.

## 5. Consequences

- A quiet book on a busy session no longer pauses the strategy or fails
  check 7, until its own last change is older than the ceiling. The
  throughput cost, and the H1-fixture mechanism check (§ header: no reduction
  on the recording, 21.9% → 0 on a derived stream), are in the
  `THROUGHPUT-1c` handoffs.
- **The epoch taint, measured (r1).** The Binance adapter reports every
  subscription start as `BINANCE_SUBSCRIPTION_START_NO_REPLAY`, an incident
  naming no market (`packages/binance-adapter/src/incidents.ts`). In a
  gateway that runs a Binance feed, which H1's does
  (`gateway.config.json`), that incident taints the epoch from its start. So
  a trader that consumed the epoch from its start falls back to
  `LAST_CHANGE` for the whole epoch. This is fail-closed, and it is why the
  r1 gateway-to-trader test runs its gateway without a Binance feed. It also
  means this rule changes nothing in an H1-like deployment until the taint is
  narrowed. Narrowing it, for example by not tainting on incidents whose
  envelope `source` is a reference venue, would loosen a fail-closed rule, so
  it is not made here. **The interim ruling (review round 2, O-I1(ii)) keeps
  the taint coarse and fail-closed:** any incident that names no market
  taints the gateway epoch, with no source filter (`loop.ts`
  `#observeDeliverySession`). It is recorded in `IMPLEMENTATION_STATUS.md`
  (Authorized now, `THROUGHPUT-1c`, "Interim rulings", orchestrator,
  2026-10-01). The user's ratification of this ADR on 2026-10-02 confirmed
  it, and kept the taint coarse. Until it is narrowed, or a live run without reference-venue
  incidents measures it, the rule's intended effect is unproven in any
  H1-like deployment.
- A book on a session whose only traffic is its own changes behaves exactly as
  before. A whole quiet subscription (no asset changing) goes stale after the
  bound, as before (Option B would be needed to change that).
- **Residual risk, stated (corrected in r1, X1):** N-B. If the venue delays
  or stops one asset's changes while other assets' frames keep the session
  busy, that asset keeps reading fresh until its own last change is older than
  the ceiling. It then ages by its own last change, and is stale at
  `lastChange + max(ceiling, bound)` at the latest. The last-change rule would
  have read it stale at `lastChange + bound`. The r0 text said this exposure
  was "the same number of milliseconds as before", which was false: without
  a ceiling it was unbounded on a busy session. With the ceiling the extra
  exposure is at most `ceiling − bound` per book, by the operator's choice
  (28 s with the example's 30 000 ms and 2 000 ms). This is how this rule is
  more permissive than the last-change rule. It rests on an undocumented
  assumption (N-A, N-B), and the ceiling is what bounds it. The same bound
  covers the accepted gap of a taint this process never consumed (D2.4, X2).
  The widened `CO2-N1` backlog (D7, X9) is removed by the process-lag guard
  (r2; option (a), the ruling D7 points to, confirmed on 2026-10-02).
- **For the venue register (not this round's paths):** N-B deserves an
  unknown row of its own (no documented cross-asset ordering on the market
  channel), next to U-2 and U-3.
- **Closing the X2 gap (a gateway change, not this round's):** a signal from
  which a trader can tell that it consumed an epoch from its start, for
  example an epoch-start event, or incidents attributed to a session and
  re-announced per connection. Until then, the ceiling bounds the gap.
- **Binding the basis to the configuration identity (X6, not this round's
  paths):** the registration command could hash and persist the
  `bookFreshness` block beside the parameters.
- **Contract text (not this round's paths):** `docs/contracts/features-v1.md`
  §2 could say that the book section's `lastEventAt` is the root's vouched-for
  instant; `docs/adr/README.md` needs this ADR's index row.
- §9.8 check 7 still measures the YES book only, for either direction; a
  NO-direction instance's traded book is gated by the strategy (D6), not by
  check 7. Pre-existing; not changed here.
- **The taint is coarse, on purpose.** An incident carries no session, the
  trader cannot map a gateway `feedId` to a session, and the gateway
  deduplicates repeats of an open incident; so ONE unattributed incident from
  ANY feed of a gateway (a Binance or Coinbase incident, or a `LOG` catalogue
  incident, included) turns the extension off for that gateway's lifetime,
  and every book falls back to the last-change rule. Fail-closed, visible as
  stale pauses, and measurable in a live run (the H1 burst carries no
  incident, so the fixture does not measure it). A narrower taint needs the
  gateway to attribute its incidents to a session or a market and to publish
  `DataQualityIncidentClosed` — a gateway change, not this round's.
- **An oversized frame turns the extension off (r7, R7-H1).** A venue
  message of more than 1 024 normalized events (for example a subscription
  answered with more than 1 024 books in one message) is preceded by
  `GATEWAY_FRAME_SPLIT`, which taints the epoch even when the whole frame is
  delivered. That is the coarse taint above applied to a new trigger:
  fail-closed, and visible as stale pauses and as one `LOG` incident per
  such frame. Not observed in H1 (the burst's largest Polymarket frame has 2
  events).
  A narrower answer, such as a per-frame completeness marker the trader
  could check, needs a stream or contract change, which is not this
  round's. (Since r8 the trader no longer needs the taint to stay safe
  through a cut frame: D2.4's consumer rule covers it. Removing or
  narrowing the taint would loosen a fail-closed rule, so it is kept. The
  user's ratification on 2026-10-02 kept it.)
- **The frame proof costs one frame (r8, R8-H1).** A frame vouches only from
  the next event of its gateway epoch on. On a busy session the delay is the
  gap between two frames (milliseconds in H1's burst). A quiet session's
  last frame before a pause vouches only when the pause ends, so a book the
  r7 rule held fresh through a pause of up to the bound can now read stale
  for that pause. That is the fail-closed direction. The H1 burst and the
  derived quiet-YES stream are re-measured in the `THROUGHPUT-1c` r8
  handoff.

## 6. Verification

`packages/trading-core/src/book-freshness.test.ts` (the real composition),
`packages/trading-core/src/projection-feed-ages.test.ts`,
`test/unit/strategies/static-bracket/book-age-v2.test.ts` and
`params-grammar.test.ts` pin: a quiet book on a live session is fresh; a
silent session is stale 1 ms past its bound; a reconnect, a new generation and
a gateway restart that reuses the connection id each leave a quiet book stale
within its bound; the epoch taint (later sessions included, a new epoch clean), the market-incident and REST fallbacks; check 7's
measurement in both bases; byte-identical replay; byte-identical behaviour
with no `bookFreshness` block; grammar version 1 unchanged and version 2's key
required, pinned and refused in version 1.

r1 adds these pins:
- the per-book ceiling: stale at 121 s with age 120 000 ms on a busy session,
  fresh exactly at the ceiling and stale 1 ms past it, and check 7 honouring
  it;
- the ceiling bounding a process that missed its epoch's incident (X2);
- a REST snapshot replacing a socket-delivered book's session (X5);
- the configuration door (ceiling required, capped, refused with
  `LAST_CHANGE`);
- `connection.test.ts`: a frame's problems before its events;
- `test/integration/paper-trader/throughput-1c-partial-frame-taint.test.ts`:
  the REAL gateway to the REAL trader. A partly malformed frame admits 0
  orders under both bases (2 at `f341d5f`), and a well-formed control frame
  admits the entry under `CONNECTION_CONFIRMED` only.

r2 adds these pins (`book-freshness.test.ts`, "r2 X9"):
- `bookConfirmedAt`'s process-lag guard: no lag and a process clock behind
  event time leave the confirmation; 1 500 ms of lag moves it back
  1 500 ms; a lag past its lead, or 30 minutes, gives the last change; an
  unreadable reading turns the extension off; the ceiling is judged at the
  process's instant;
- the composition: the reviewers' 09:30 backlog admits 0 orders (2 at
  `a0a5f24`); a 30-minute-late replay evaluates exactly as `LAST_CHANGE`; a
  live process 1 700 ms behind is fresh and 1 900 ms behind is stale at the
  same event; a per-event replay clock decides byte-identically to the
  unlagged run.

r3 adds two pins that state the corrected wording as behaviour (no code
changed in r3):
- `bookConfirmedAt`: the reviewers' counterexample (last change 0,
  confirmation 5 000, event 5 200, lag 1 700 gives age 1 900 where
  `LAST_CHANGE` gives 5 200), and, over a sweep of lags, an answer between
  the last change and the unguarded confirmation, equal to the last change
  once the lag covers the lead;
- the composition: a 3 ms lag leaves every stale/fresh verdict unchanged but
  changes the decision records, while under `LAST_CHANGE` the lag changes
  nothing.

r5 adds no pins. It changes wording only: the pointers to the interim
rulings (D7, §5, header), and the `book-freshness.ts` header's replay
sentence, which now carries D8's qualification (review round 5, R5-L1). The
corrected replay statement is already pinned as behaviour by r3's 3 ms
composition pin above.

r6 adds these pins (review round 6):
- `test/integration/paper-trader/throughput-1c-partial-frame-taint.test.ts`,
  "r6 (R6-H1)": the REAL gateway to the REAL trader. For both triggers (year
  10000 in milliseconds; the frame's instant in microseconds) and both frame
  orders, `GATEWAY_ENVELOPE_REJECTED` is published before the frame's
  accepted NO snapshot, and 0 orders are admitted under both bases (the NO-first
  order admitted 2 under `CONNECTION_CONFIRMED` at `74e17ca`);
- `test/integration/paper-trader/throughput-1c-frame-loss-first.test.ts`
  (moved there from `test/integration/data-gateway/` in r7, unchanged except
  its import path, to stay inside this package's test grant): the gateway
  alone. A well-formed frame is published whole, in order, right behind its
  raw frame, inside the socket callback; the incident precedes every
  accepted event of a frame that lost one; a socket close keeps its place;
- `apps/data-gateway/src/dispatcher.test.ts` › `dispatchFrame`: an all-valid
  frame publishes exactly what one dispatch per event publishes; a refusal
  is published first, at the frame's first receipt, with the first pass's
  sequences left as holes; a later loss in the epoch opens no second
  incident; `apps/data-gateway/src/feeds/polymarket.test.ts`: the bracket's
  edges (a throw, a non-frame event, a second raw frame, a re-entrant
  socket, no bracket);
- `book-freshness.test.ts` › "r6 O-R6-I1": no delivery session is recorded
  under an absent block or `LAST_CHANGE`.

r7 adds these pins (review round 7, R7-H1):
- `test/integration/paper-trader/throughput-1c-frame-split.test.ts`: the
  REAL gateway to the REAL trader, with a 4 096-deep admission queue. A
  frame of 1 024 NO snapshots and a YES change, whose second call is lost
  to an outage, admits 0 orders under both bases (`[2, 0]` at `2d29b2d`),
  and `GATEWAY_FRAME_SPLIT` is published first. A 900-event frame queued
  behind a held call and a 200-event frame is one call; with that call
  lost, none of it is published and 0 orders are admitted (`[2, 0]` at
  `2d29b2d`). Controls: a frame of exactly 1 024 is one call, carries no
  incident and still vouches under `CONNECTION_CONFIRMED` only; at the
  default depth the oversized frame halts on admission; and the cost: an
  oversized frame delivered whole still taints the epoch;
- `apps/data-gateway/src/publisher.test.ts`, "a run never starts a frame it
  cannot hold whole": review's `[A200+B824], [B76]` is now `[A200], [B900]`;
  the boundary `A255+B769` (one call) against `A255+B770` (two); small
  frames still share a call; a frame of exactly the limit and one over it
  each start their own call; an outage on the call carrying a sub-limit
  frame's last envelope publishes none of the frame (824 at `2d29b2d`);
  `atomicFrameEnvelopes` is 1 024 with the batch capability and 1 without;
- `apps/data-gateway/src/dispatcher.test.ts`, "a frame too large for one
  transport call": the incident is published first at the frame's first
  receipt, names no market and is `LOG`; a frame of exactly the limit is
  byte-identical to one dispatch per event; every oversized frame gets its
  own incident; none is opened once publication has halted; without the
  batch capability a frame of two is marked; an oversized frame that also
  loses an event has both incidents ahead of its accepted events.

r8 adds these pins (review round 8, R8-H1, and the class):
- `test/integration/paper-trader/throughput-1c-consumer-frame-proof-redis.test.ts`:
  real Redis, the REAL `RedisMarketEventFeed` and the REAL `pump`, fed the
  REAL gateway composition's calls one by one. Named regressions, each 2
  orders under `CONNECTION_CONFIRMED` at `298199d` and 0 now: R8-H1 at
  `receiveBatchSize` 128 with frames of 129, 200 and 1 024 events and at
  `receiveBatchSize` 1 with a frame of 2, with and without a successor;
  R7-H1's prefix (the shape `2d29b2d` published) read in one short read;
  the real Redis transport refusing an envelope inside the frame's call;
  R6-H1's and X8's incident published AFTER its frame (the shapes `74e17ca`
  and `f341d5f` published). Controls: a whole frame and a successor DOES
  vouch at `receiveBatchSize` 1, 2, 128 and 4 096, and without the
  successor it never does. A seeded randomized property per boundary of
  the frame's path (feed batching and carry, a transport-call outage, a
  refused envelope, a malformed entry, a WAL refusal, a refusal by the real
  Redis transport, a restart from the committed position, a failed read, a
  retention trim): frames of 1 to 2 048 events, `receiveBatchSize` from 1
  upward, admission and ingest depths, and how far the trader reads between
  calls; no order and no approval is ever admitted when the frame carries
  the YES book's latest change;
- `packages/trading-core/src/book-freshness.test.ts`, "r8": the gate
  (released only by a later event of the same epoch from another frame;
  another epoch proves nothing; an event that confirms nothing still proves;
  bounded, and a forgotten frame confirms nothing), and the composition (the
  R8-H1 shape at every cut and batch size admits nothing; a frame vouches
  from the next frame on, never at its own close; a frame nothing follows
  never vouches; five partitions of the same events admit the same entry at
  the same event; an incident right after its frame proves and taints in
  one step);
- the r1, r6 and r7 end-to-end tests whose outcome turns on a whole frame
  vouching (or on its taint) now send a successor message, so the frame is
  proven and the taint, not the r8 rule, decides.

## Amendment 1 (2026-10-05, ROLLOVER-1)

- **Recorded by:** `GOV-NOTES-3`, from `ROLLOVER-1`'s known risk
  R1-FABLE-03(b).
- **Source:** `ROLLOVER-1`, merged `ae11daa` after a joint ACCEPT at
  `61a0ab2`. Its record is `docs/handoffs/ROLLOVER-1.md`.
- **Standing:** the orchestrator's interim ruling, made 2026-10-05. It is
  open to the user, who may confirm or overrule it.
- **Scope:** one producer convention. It changes no rule of D2. Rule 4
  still taints an epoch on every incident that names no market.

**The ruling.** A series-admission incident that names only its scope's
reference id is not a market-less incident under D2 rule 4. It taints no
epoch, and rule 5 applies it to no book.

### Why the convention exists

`ROLLOVER-1` added a series-admission feed to the gateway
(`apps/data-gateway/src/feeds/series-admission.ts`). Most of its incidents
are about one window or one series, such as a refused window, a series held
at its cap, a failed CLOB read, a window unresolved past its bound, and an
operator's retirement, applied, deferred or unmatched. None of these is
about the delivery of a book, and the cap is reached in the ordinary course
of a run.

A market-less incident taints its epoch (rule 4). Under
`CONNECTION_CONFIRMED`, every book of the epoch then falls back to the
last-change rule until the gateway restarts. `ROLLOVER-1` found that its
admission incidents would do this, and fixed it: each routine admission
incident names a market (`#openWindowIncident`).

### The convention, as merged

1. An incident about one window names the window's derived id
   (`windowInternalMarketId`, `packages/universe/src/series-admission.ts`).
2. When no window id can be derived, the incident names its scope's
   reference id, `incidentReferenceId(scope)`. No id can be derived when the
   keyset event has no condition id, or no usable start locator.
3. `incidentReferenceId(scope)` is
   `windowInternalMarketId("series-admission-incident|" + scope, 0)`:
   - a UUIDv7 whose 48-bit timestamp is 0, so its text begins
     `00000000-0000-7`;
   - it copies the first ten SHA-256 digest bytes of
     `rollover-1/window-market-id/v1|series-admission-incident|<scope>`
     into UUID bytes 6-15, then overwrites the version nibble with 7 and the
     variant bits with `10`, so 74 digest bits survive;
   - so it is stable across restarts and replays, and distinct per scope.

   The doc comment on `windowInternalMarketId` says the 74 bits are "the
   first bits" of the digest. The code is as stated above.

   The code's literal fallback, `00000000-0000-7000-8000-000000000000`, is
   unreachable: the derivation always succeeds at timestamp 0.
4. Two incidents can name it, both NOTIFY:
   - `GATEWAY_SERIES_WINDOW_REFUSED`, scoped `<feedId>:<key>`, where the key
     is the condition id or `event:<eventId>`;
   - `GATEWAY_SERIES_CAP_REACHED`, scoped `<feedId>:<seriesId>:cap`, when the
     held window has no derivable id.
5. Some conditions publish nothing. A keyset event with neither a condition
   id nor an event id is only counted (`windowsUnidentified`). So is a failed
   read with no window id (`requestFailures`). Enough failed reads in a row
   raise the stall of item 6.
6. Three admission-feed incidents still name no market, as the lifecycle
   feed's do: `GATEWAY_FEED_STALL`, `GATEWAY_WAL_FRAME_REFUSED` and
   `GATEWAY_SERIES_LEDGER_WRITE_FAILED`. Each taints the epoch under rule 4.

### Why no market carries the id, so no book is tainted

1. **No market any process runs carries the id.** An admitted window's id
   carries its scheduled open as its timestamp. Admission happens at
   contemporary time: both sides admit a window only if its close is after
   the admission's receipt, a reading of the gateway's clock (the trader
   refuses `WINDOW_CLOSED`). A window lasts its reviewed `durationSeconds`,
   at most 86,400 s. So its open is at most a day before that receipt,
   never the Unix epoch, and the timestamp is never 0. Any other market's
   id would also have to match the 74 hashed bits.
2. **The trader applies it to no market.** `CoreLoop` finds no market it
   runs in the incident's list.
3. **Rule 4 does not fire,** because the incident's market list is not
   empty (`CoreLoop.#observeDeliverySession`). **Rule 5 does not fire,**
   because no market has the id. So no book is tainted, and no market is
   paused.
4. **Pinned:**
   - the gateway: `test/integration/data-gateway/rollover-1-series-admission.test.ts`,
     "a refused window with no start locator names its scope's reference
     id";
   - the trader, for an incident that names a market it does not run:
     `packages/trading-core/src/book-freshness.test.ts`, "an incident naming
     ANOTHER market neither taints the session nor touches this market";
   - a multi-window run publishes no market-less admission incident:
     `test/integration/paper-trader/rollover-1-multi-window.test.ts`.

### Why it is safe, and fails closed where it matters

1. **Neither condition concerns delivery.** Rule 4 exists because a loss of
   data breaks the inference from "another asset's frame arrived" to "this
   asset's frames are being delivered". A refused or held window loses,
   delays and reorders no market-data frame, so the inference still holds.
2. **Admission still fails closed.** A refused window is never admitted, and
   a held one is not admitted until a slot frees (ADR-030 Decisions 1.4 and
   1.5, and ADR-030 Amendment 1, rule 1).
3. **Rule 4 is unchanged for every loss of data.** Each admission-feed
   incident about the gateway's own data stays market-less (item 6 above),
   and so does every such incident of the other feeds.
4. **Only `CONNECTION_CONFIRMED` is affected.** Under any other basis the
   trader records no taint at all (`#observeDeliverySession` returns first).
5. **The cost** is an incident that names an id no catalog holds. Its
   `detail` names the window by the condition id or event id it carried. A
   refusal is also in the admission ledger, as a `REFUSED` record.
