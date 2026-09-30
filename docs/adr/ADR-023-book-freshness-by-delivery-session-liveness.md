# ADR-023: Book freshness by delivery-session liveness, not by the last change

- **Status:** Proposed, 2026-09-30. The user ratifies it before `THROUGHPUT-1c` merges.
- **Date:** 2026-09-30
- **Recorded by:** `THROUGHPUT-1c`, which also implements it.
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
  round 2: the process-lag guard (D7, X9 option (a), pending its ruling),
  the heartbeat wording (D5, Option B) and the replay-parity qualification
  (D8).
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

### D2. When a book is fresh

A book is vouched for as of `confirmedAt`:

```text
confirmedAt(book) = max(lastChange(book), latestConfirmation(session(book)))
```

where `session(book)` is the session of the update that last CHANGED the book
(recorded only after the book accepted it), and `latestConfirmation` is the
latest confirmation of that session. The book is FRESH iff
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
   normalize a frame, or sees a heartbeat stall (`GATEWAY_FEED_STALL`)
   (`feeds/polymarket.ts`). From then on "another asset's frame arrived" no
   longer implies "this asset's frames are being delivered". The taint covers
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
| A trader that starts or restarts inside an epoch whose incident it did not consume | the taint is unknown to it (an accepted gap): bounded by the ceiling | D2.4, rule 6 (r1, X2) |
| Silent session, socket still open | no confirmations: STALE at `lastConfirmation + bound` | D2 (no rule needed) |
| Disconnection (`FeedDisconnected`), reconnect | the old session gets no more frames; the new session's frames do not confirm a book delivered on the old one: STALE within the bound. A book re-delivered on the new session is confirmed by it | D1 key |
| Missed `PONG` (`FeedStale`), heartbeat loss | the gateway reconnects (`reconnectWhenStale`), so as above; and its `GATEWAY_FEED_STALL` incident taints the gateway epoch | D2.4 |
| Subscription change (new generation) | a new session; books of the old generation are not confirmed by it | D1 key |
| Gateway restart | new `gatewayEpoch`: a new session even though `connectionId` repeats | D1 key |
| Gateway publication halt / overflow (`CO2-N6`) | nothing is published, so no confirmations: STALE within the bound — IF any other event still advances the trader's event time; if nothing arrives at all, nothing is evaluated | D2 (and N1, D7) |
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
absent block and an explicit `LAST_CHANGE`.

### D5. How the signal flows

- **Gateway: no new event type; one ordering change (r1, X8).** The session
  fields every market-data envelope already carries are the signal. The
  market-channel adapter now reports a frame's normalization problems BEFORE
  its accepted events (`packages/polymarket-public/src/feed/connection.ts`),
  so the gateway's incident for a partly malformed frame precedes the
  frame's siblings in the stream (D2.4). Nothing is dropped, and neither list
  is reordered internally. A `PONG`-derived
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
  consumed event is offered to the session table right after the event door,
  before the event is applied or evaluated; the loop records each applied
  book update's session per outcome (`market-state.ts` `noteBookSession`).
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
pre-guard rule or than `LAST_CHANGE`. A process clock that runs BEHIND event
time (skew between the gateway host and the trader host) reads as lag 0, the
pre-guard answer.

What it does not do: it does not make `LAST_CHANGE` lag-aware (that is N1),
and a trader behind by less than the bound is still judged in event time for
the part of the age that is its own last change. Pinned by
`book-freshness.test.ts` › "r2 X9": the reviewers' reproduction (0 orders
under both bases), a 30-minute replay equal to `LAST_CHANGE` evaluation by
evaluation, a live process 1 700 ms behind fresh and 1 900 ms behind stale
at the same event, and a per-event replay clock equal to the unlagged run.

**A ruling is still owed before ratification**, because round 1 asked the
orchestrator or the user to choose, and the choice is recorded in
`IMPLEMENTATION_STATUS.md`, not here:

- (a) **the live-admission guard:** implemented in r2 as above. Accepting
  it closes the conflict with criterion B for this rule;
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

`confirmedAt` is a pure function of the consumed event sequence: the session
table is fed in stream order, uses only envelope fields, and its eviction is
insertion-ordered. The backtest CLI runs the same `CoreLoop` behind the same
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
the reverse (the guard only removes extension). ADR-024's frame grouping is unaffected: a frame's events
all update the table before its closing evaluation, which is the live order.
Inside one frame a later event's `receivedAt` may sit a millisecond after the
instant the frame's evaluation of a market uses; the age is then negative,
which every gate reads as fresh — exactly as a book update stamped after the
evaluating event always was (`features-v1.md` §2: feed stamps "may sit after
`asOf`"; the order-book never-clamp rule).
Recorded data without session fields replays under the last-change rule, so an
old recording can never read fresher than it did.

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
  needs no new event type or contract change, only the adapter's
  problems-first order (D5). It fails closed on every missing piece. It is
  WEAKER per book than the last-change rule's proof, because a sibling's
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
  it is left to the user's ruling rather than made here. **A ruling is owed
  before ratification** (review round 2, O-I1(ii)): today the taint applies
  no source filter (`loop.ts` `#observeDeliverySession`), so the rule's
  intended effect is unproven in any H1-like deployment until either the
  narrowing is ruled in or a live run without reference-venue incidents
  measures it.
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
  (r2), subject to its ruling.
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
