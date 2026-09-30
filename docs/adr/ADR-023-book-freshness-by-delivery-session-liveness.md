# ADR-023: Book freshness by delivery-session liveness, not by the last change

- **Status:** Proposed, 2026-09-30. The user ratifies it before `THROUGHPUT-1c` merges.
- **Date:** 2026-09-30
- **Recorded by:** `THROUGHPUT-1c`, which also implements it.
- **Supersedes / Superseded by:** none. It changes how a venue book's AGE is
  measured, when a configuration opts in. It does not change any bound, any
  gate's direction, the §9.9 stale-book response, or the clock semantics.
- **Handoff sections:** §6 (invariants 9, 12 and 15), §7.1, §8.1, §9.5, §9.8
  (check 7), §9.9, §12.4, §13.3. **ADRs:** ADR-002 (envelope and ordering),
  ADR-013 (`price_change` semantics), ADR-020 (parse boundaries), ADR-022 (one
  shared core), ADR-024 (evaluate once per venue frame).
- **Finding it resolves:** H1 run 1, finding 5 (`docs/handoffs/H1-RUN-1.md:76`):
  20,367 of 37,546 decisions (54%) paused on `SB.STALE_BOOK`.

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
2. **Why that misreads a live book.** The venue sends a book's events only when
   that book changes (§2, V2–V4). A quiet book on a healthy connection
   therefore produces no frames, and its age grows while the connection keeps
   delivering other books' frames. In H1 run 1 the example bounds were 2 000 ms
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
with no message means no change". It documents that an unchanged book produces
no frames (V2–V4, read together), and nothing that bounds how late a change may
arrive (N-A, N-B). No rule available to this repository can prove that a book
is current. What CAN be proved is narrower, and it is exactly what the
last-change rule already relied on: **that the delivery path was delivering,
recently.** A book whose own frame arrived 1.9 s ago was never proved current
either (N-A); it was proved to sit on a path that delivered 1.9 s ago.

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
same `now` (event time).

`confirmedAt` falls back to `lastChange(book)` — the pre-ADR-023 rule, never
more permissive than it — whenever:

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
   included (when in doubt, stale);
5. the market has an active data-quality incident of its own.

### D3. When a book is stale

| Case | What happens | Detected by |
| --- | --- | --- |
| Quiet book, live session (the H1 case) | other assets' frames keep confirming the session: FRESH | D2 |
| Silent session, socket still open | no confirmations: STALE at `lastConfirmation + bound` | D2 (no rule needed) |
| Disconnection (`FeedDisconnected`), reconnect | the old session gets no more frames; the new session's frames do not confirm a book delivered on the old one: STALE within the bound. A book re-delivered on the new session is confirmed by it | D1 key |
| Missed `PONG` (`FeedStale`), heartbeat loss | the gateway reconnects (`reconnectWhenStale`), so as above; and its `GATEWAY_FEED_STALL` incident taints the gateway epoch | D2.4 |
| Subscription change (new generation) | a new session; books of the old generation are not confirmed by it | D1 key |
| Gateway restart | new `gatewayEpoch`: a new session even though `connectionId` repeats | D1 key |
| Gateway publication halt / overflow (`CO2-N6`) | nothing is published, so no confirmations: STALE within the bound — IF any other event still advances the trader's event time; if nothing arrives at all, nothing is evaluated | D2 (and N1, D7) |
| Gateway WAL refusal, unparsable frame | the gateway's incident names no market: the epoch is tainted, fallback to the last change for the rest of the gateway's life (repeats are deduplicated, D2.4) | D2.4 |
| Market data-quality incident | fallback to the last change | D2.5 |
| REST recovery snapshot | no session: last change only, until a socket frame for that asset lands on a session | D2.2 |
| Trader lagging the stream | ages are measured in event time, exactly as before; a lagging trader is not detected here (N1, D7) | — |
| Replay of old data | deterministic (D6); data without session fields ages by the last change | D2.2 |

### D4. The opt-in, and backward compatibility of configurations

The trader configuration gains ONE optional block:
`bookFreshness: { basis: "LAST_CHANGE" | "CONNECTION_CONFIRMED" }`. An absent
block means `LAST_CHANGE` (`packages/trading-core/src/config.ts`
`bookFreshnessBasisOf`). This is the document's only optional key, and it is
disclosed there: absence selects the STRICTER rule (the confirmed instant is
never earlier than the last change), there is no `.default()` (absence is read
as an own-property absence on the prototype-free D1 tree, ADR-020), and every
configuration written before this ADR — registered runs `BOOT-1` compares,
golden configurations, operators' templates — must keep loading with its
original meaning. Under `LAST_CHANGE` the loop records nothing new and computes
exactly the pre-ADR-023 values; a test pins byte-identical decisions for an
absent block and an explicit `LAST_CHANGE`.

### D5. How the signal flows

- **Gateway: unchanged.** No new event type. The session fields every
  market-data envelope already carries are the signal. A `PONG`-derived
  liveness event was considered and not built (Option B): at the configured
  2 000 ms bounds a 10 s heartbeat (V5) can never confirm within the bound, and
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
byte-identical, so no run can straddle a behaviour change, and a version-2
configuration is a new configuration identity (a new `configId`). The code
version is pinned by the registration command (`apps/trader/src/register`,
not this round's path); if the user wants the code version bumped as well, it
must move there in the same change.

### D7. Clock semantics, and `CO2-N1`

Unchanged. Both `now` and every confirmation instant are event `receivedAt`
values; nothing reads a wall clock. This ADR does not address `CO2-N1` (live
admission runs on event time, so a stale backlog can be admitted late): a
trader lagging the stream judges a book fresh relative to the event it is
processing, under either basis. The two interact in one way that matters: a
future N1 rule that measures ages against a wall clock can use `confirmedAt`
unchanged, because it is an event-time instant of the same kind as the last
change it replaces.

### D8. Replay and backtest determinism

`confirmedAt` is a pure function of the consumed event sequence: the session
table is fed in stream order, uses only envelope fields, and its eviction is
insertion-ordered. The backtest CLI runs the same `CoreLoop` behind the same
configuration door (ADR-022), so replay and backtest reproduce live decisions
over the same events. ADR-024's frame grouping is unaffected: a frame's events
all update the table before its closing evaluation, which is the live order.
Inside one frame a later event's `receivedAt` may sit a millisecond after the
instant the frame's evaluation of a market uses; the age is then negative,
which every gate reads as fresh — exactly as a book update stamped after the
evaluating event always was (`features-v1.md` §2: feed stamps "may sit after
`asOf`"; the order-book never-clamp rule).
Recorded data without session fields replays under the last-change rule, so an
old recording can never read fresher than it did.

## 4. Options considered

- **A. Keep the last-change rule.** Rejected by the finding: 54% of H1
  decisions paused on books that were quiet, not stale.
- **B. A gateway liveness event from `PING`/`PONG`.** A new domain event per
  `PONG`, consumed by the trader as a session confirmation. Not built: the
  heartbeat period (10 s, V5) exceeds the bounds in use (2 s), so it would
  confirm nothing, and a `PONG` proves less than a data frame (N-E). It needs a
  new event contract (schema discipline) for no benefit at current bounds.
  Kept as the documented extension if bounds above 10 s are ever wanted for a
  fully quiet subscription.
- **C. "Connected and no disconnect seen" means live.** Rejected: absence of a
  negative signal is not provable liveness (a stalled gateway publishes
  nothing, including its disconnect), and the trader does not consume
  feed-health events.
- **D. Session confirmations by consumed data frames (chosen).** Uses only
  fields every envelope already carries, needs no gateway or contract change,
  fails closed on every missing piece, and is exactly as strong as the proof
  the last-change rule had (§2, "Therefore").
- **E. Raise `maximum_book_age_ms`.** Rejected: it loosens the bound for books
  on dead sessions too; D keeps the bound and changes only what counts as
  evidence.

## 5. Consequences

- A quiet book on a busy session no longer pauses the strategy or fails
  check 7. The H1-fixture effect and the throughput cost are measured in the
  `THROUGHPUT-1c` handoff.
- A book on a session whose only traffic is its own changes behaves exactly as
  before. A whole quiet subscription (no asset changing) goes stale after the
  bound, as before (Option B would be needed to change that).
- **Residual risk, stated:** N-B. If the venue delays one asset's changes
  while another asset's frames flow, the delayed asset reads fresh for up to the
  bound after the last frame of its session — where the last-change rule would
  have read it stale 2 s after its own last change. The bound limits the
  exposure to the same number of milliseconds as before, but measured from a
  different instant. This is the one way this rule is more permissive than the
  last-change rule, and it is permitted only because both rules rest on the same
  undocumented assumption (N-A): neither proves the book current.
- **For the venue register (not this round's paths):** N-B deserves an
  unknown row of its own (no documented cross-asset ordering on the market
  channel), next to U-2 and U-3.
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
