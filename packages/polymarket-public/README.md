# `@polymarket-bot/polymarket-public`

Owner: `WP-070`
Layer: 2 (adapters and infrastructure — `docs/contracts/dependency-direction.md` §2)
Authority: handoff §9.1, §9.4; [ADR-001](../../docs/adr/ADR-001-exact-decimal-representation.md) §8; [ADR-002](../../docs/adr/ADR-002-event-envelope-and-ordering-semantics.md) §2, §7, §8

The public, unauthenticated Polymarket market-data adapter: the market
WebSocket client, its subscription manager, the REST book-snapshot fetcher, and
the normalization of all of it into the frozen domain events.

**No credential, signer, wallet, authenticated call, or order path exists in
this package, and none is representable in any of its interfaces.**

---

## 1. What this package owns, and what it does not

| Owned here | Owned elsewhere |
| --- | --- |
| The market-channel wire format and its REST book counterpart | The unified SDK surface (`packages/polymarket-secure`, `WP-260` — F6) |
| Normalization to `BookSnapshot`, `BookLevelChanged`, `BestBidAskChanged`, `PublicTradeObserved`, `TradingParametersChanged`, `MarketDiscovered`, `MarketResolved`, and the `Feed*` events | The event envelope: `eventId`, `gatewayEpoch`, `ingestSeq`, receipt metadata (`WP-120`, ADR-002 §1) |
| Connection lifecycle, heartbeat, staleness, reconnect, subscription generations | Deciding *when* to take a recovery snapshot (`WP-120`) |
| Producing an authoritative REST snapshot on demand | `InternalMarketId`, YES/NO token assignment, parameter versions (`WP-110`, via the `PublicMarketDirectory` port) |
| Reporting absolute level changes exactly as published | Local order-book reconstruction (`WP-150`) |

Three things this package deliberately never does:

- **It invents no venue sequence number** (§9.4, ADR-002 §2.3). Ordering is
  `(gatewayEpoch, ingestSeq)`, assigned by the gateway. Venue timestamps and
  venue-provided hashes are carried as data, never as an order.
- **It mints no identity.** `InternalMarketId` is a UUIDv7 owned by the Universe
  Service; a parameter version and its `parameterVersionRef` are catalogue
  state. Both arrive through a port, and a missing answer becomes a reported
  problem rather than a guess.
- **It drops nothing silently** (§8.3). Every fact an inbound frame asserts
  becomes exactly one normalized event or exactly one `PublicMarketProblem`
  carrying the raw value, and the contract suite asserts that accounting. The
  unit is the venue's, not the frame element's: an element that asserts one fact
  yields one outcome, while a `price_change` batching N entries yields N — each
  stamped with the element's `observedIndex` and its own `entryIndex`, so
  `(observedIndex, entryIndex ?? 0)` totally orders one frame's outcomes.
  (Round-1 review finding L1: this used to be stated as "exactly one outcome per
  frame element", which the batched case never satisfied.)

## 2. Book price-change semantics — C-1 / U-1, **CONFIRMED 2026-08-27**

`docs/contracts/protected-contracts.md` §8 carried this as the register's first
open item: handoff §23 asserts absolute price-level changes with zero removal,
and the market-channel documentation `WP-000` retrieved on 2026-08-24 typed
`price_change.size` as a `DecimalString` without stating absolute-versus-delta
semantics or zero removal. The `WP-070` acceptance criterion required
confirmation against current official sources, or an ADR-governed flag.

**It is confirmed.** The current official Market Channel API reference states the
rule explicitly.

- **Source:** <https://docs.polymarket.com/api-reference/wss/market.md>
  ("Market Channel — Public WebSocket for real-time orderbook, price, and market
  lifecycle updates"), retrieved read-only and unauthenticated on **2026-08-27**.
- **Verbatim, the `price_change` message's `size` property description:**

  > `New aggregate size (0 means level removed)`

- **Verbatim, the same message's `price` property:** > `Price level affected`
- **Verbatim, the operation description:**

  > `Delta update to orderbook price levels when an order is placed or cancelled`

- **Verbatim, the payload title:** > `Orderbook price level delta update`
- **Verbatim, the `book` event's level `size`:** > `Total size at this price level`
  — and the `book` operation itself: > `Full orderbook snapshot sent on subscribe or after a trade`

Read together: the *message* is a delta (it reports only the levels that
changed), while the `size` it carries is the **new aggregate size at that
level**, and `0` removes the level. That is exactly the handoff §23 assumption
`WP-000` retained provisionally.

Two further quotes retrieved the same day, from
<https://docs.polymarket.com/market-data/realtime-data> and
<https://docs.polymarket.com/market-data/prices-order-books>, corroborate the
aggregate reading and fix the book ordering:

> Bids are ordered by ascending price and asks by descending price, so the best
> bid and ask are the last entries in their respective arrays. Each response
> also includes a `hash` for the order-book state. Compare it with the previous
> response's hash to determine whether the book changed between reads.

**Status.** This package implements the confirmed reading — the size is carried
through as the absolute level size, `"0"` included, and no delta arithmetic is
performed anywhere. **Ratifying the register entry is an orchestrator/ADR step,
not this package's to take.** Until that ratification lands,
`packages/domain/src/events/book.ts` still carries its provisional UNVERIFIED
comment, `docs/contracts/protected-contracts.md` §8 still lists C-1/U-1 as open,
and `test/fixtures/venue/market-ws/price-change.json` still names its example
`level-removed-absolute-zero-UNVERIFIED`. All three are protected or
`WP-000`-owned paths. See `docs/handoffs/WP-070.md` for the requested
ratification.

Two related items are **still open and are not asserted here**:

- **U-2 — the server-side consequence of a missed `PING`.** The reference
  documents only "Send PING every 10 seconds to keep the connection alive" and
  the `PONG` reply. No timeout and no close code is published. This client
  therefore measures the one thing it can observe — how long since a `PONG` came
  back — and reports it as a `FeedStale` event. The default 30-second window is
  the official SDK's own client-side `CLOB_HEARTBEAT_STALE_MS`, evidence of what
  the SDK treats as dead, not evidence of a server rule.
- **U-3 — the maximum `assets_ids` per subscription.** Still undocumented. This
  client imposes no cap by default, and that is not a claim that none exists;
  `maximumAssetsPerSubscriptionFrame` exists so an operator who learns the real
  bound can apply it without a code change.

## 3. Venue facts this package relies on

All retrieved read-only and unauthenticated on **2026-08-27**; every one is a
configuration snapshot to be re-verified at each phase gate (handoff §1.2).

| Fact | Source |
| --- | --- |
| `wss://ws-subscriptions-clob.polymarket.com/ws/market` | api-reference/wss/market |
| Subscribe frame `{"assets_ids": [...], "type": "market"}`, plus `custom_feature_enabled`, `initial_dump` (default `true`), `level` (`1\|2\|3`, default `2`) | api-reference/wss/market |
| Dynamic `{"operation": "subscribe"\|"unsubscribe", "assets_ids": [...]}` | api-reference/wss/market |
| Client sends `PING` every 10 s; server replies `PONG` | api-reference/wss/market |
| Seven event types: `book`, `price_change`, `last_trade_price`, `tick_size_change`, and behind `custom_feature_enabled` `best_bid_ask`, `new_market`, `market_resolved` | api-reference/wss/market |
| `book.hash` is the "Hash of the orderbook content"; `price_change[].hash` is the "Hash of the order that caused this change" | api-reference/wss/market |
| `last_trade_price.side` is "From taker's perspective" | api-reference/wss/market |
| `GET /book?token_id=…`, `POST /books` with `[{"token_id":"…"}]`, "Maximum 500 items per request" | market-data/prices-order-books |
| `OrderBookSummary` lists all ten properties (`market`, `asset_id`, `timestamp`, `hash`, `bids`, `asks`, `min_order_size`, `tick_size`, `neg_risk`, `last_trade_price`) under `required`, and `OrderSummary` requires `price` and `size` | api-reference/market-data/get-order-book (`/api-spec/clob-openapi.yaml`) |
| The same OpenAPI describes `bids` as "sorted by price descending" and `asks` as "sorted by price ascending" — the opposite of the prose page above. The adapter imposes the domain order on both sides and trusts neither | api-reference/market-data/get-order-book vs market-data/prices-order-books |

`level` is documented as existing, with a default and an enumeration, and with
no statement of what the three levels mean. This package therefore never sends
it: choosing a value whose effect is unknown would be a guess about venue
behaviour.

## 4. The venue edge

Four obligations from ADR-001 §8 and ADR-002 §7, all discharged in
`src/normalize/values.ts` rather than in a schema:

1. `""`, `null`, and an absent key all collapse to **absent**. An absent best
   bid is never turned into `"0"`.
2. Venue decimal spellings are canonicalized with `@polymarket-bot/decimal` —
   the same implementation the domain schemas validate against, so the two can
   never drift. The wire is demonstrably non-canonical: the official order-book
   example prints `"last_trade_price": "0.090"`.
3. Every epoch-like form the SDK accepts is accepted, including the date-like
   string, and converted to ISO-8601.
4. An unrecognized free-string value is first-class **UNKNOWN**: reported with
   the raw frame attached, never coerced to a default.

Every payload this package builds is then parsed by its own domain contract
before it is emitted. A payload that fails becomes a
`PAYLOAD_CONTRACT_VIOLATION` problem: the adapter reports its own bug rather
than shipping a malformed document downstream.

### 4.1 One §9 narrowing is discharged in substance, NOT literally

`docs/contracts/protected-contracts.md` §9 requires a runtime parser to "accept
any hex condition id `ConditionIdResponseSchema` accepts (**no** 31/32-byte
bound at runtime)". The fixture catalogue's 31/32-byte narrowing is genuinely
not inherited — a 4-character id and a 128-character id are both accepted — but
**a different bound applies, and this package does not claim the row is
closed** (round-1 review finding M2).

`normalizeVenueConditionId` rejects a condition id longer than **200
characters**. That number is not the venue's: it is `MAX_IDENTIFIER_LENGTH` in
the frozen `packages/domain`, which `ConditionIdSchema` — and therefore every
payload carrying a condition id — enforces. Checking it at the venue edge turns
an over-long id into a typed `INVALID_CONDITION_ID` problem carrying the raw
frame rather than a `PAYLOAD_CONTRACT_VIOLATION` at emission time; it does not
make the bound disappear.

| Condition-id length | Behaviour |
| --- | --- |
| ≤ 200 characters (includes the 66-character form the venue publishes, the 64-character 31-byte form, and everything shorter) | accepted, carried through unchanged |
| > 200 characters | one `INVALID_CONDITION_ID` problem carrying the raw value. Never a throw, never a silent drop |

Both rows are asserted in
`test/contract/polymarket-public/narrowings.test.ts` and
`src/normalize/values.test.ts` at the exact boundary. Reconciling
`ConditionIdSchema`'s cap with §9's wording is a contract-owner decision —
`packages/domain` is frozen and outside this package's allowed paths — and the
orchestrator carries it as **contract-owner item 3** in
`IMPLEMENTATION_STATUS.md`.

## 5. R-2: the SDK anchor table

`docs/contracts/protected-contracts.md` §8.1 assigns register item R-2 to this
package: hand-transcribed venue schemas must not be silently load-bearing.

The mechanism is `test/contract/polymarket-public/sdk-anchor/`. Every field of
every venue schema this package owns is a row recording **three modifiers
separately**, each with its own citation:

| Column | Source |
| --- | --- |
| `sdkModifier` | the official SDK at the pinned commit `7fdbed42484b5d279c71aa36d3757d18968260da` |
| `restModifier` | for the REST book, the venue's own OpenAPI document (`GET /book`, `OrderBookSummary`), retrieved 2026-08-27 |
| `localModifier` | what this package declares |

Round-1 review finding M1 is why the columns are separate: the first version
recorded ONE modifier — the local one — and called it the SDK's, so a field this
package had quietly loosened read as agreement with the SDK, and four REST
fields both first-party sources declare `required` parsed happily when omitted.
Every difference between the columns must now name its **dimension** —
`presence` (may the key be absent or `null`?) or `value-form` (what may a
present value look like?) — its source, its reason and its authority. A
value-form reason can no longer be spent on a presence change.

The contract suite then:

1. compares the anchor table's field set against the package's zod schemas, key
   for key, in both directions — **and** walks the package's public surface for
   every object schema it can reach, so a nested schema that is never anchored
   fails (this is what `VenueBookLevelSchema` and `MarketEventMessageSchema`
   were). The walk follows zod's wrappers (transforms, pipes, refinements,
   `.optional()`, arrays, records, unions) and an object's own fields, matching
   schemas by identity rather than by name, because round-2 finding L1 was that
   the first version of this guard matched a naming convention and a wrapped or
   renamed export could evade it;
2. asserts each anchor's field count against the number read from the SDK
   source, so adding a field without re-reading the SDK fails;
3. drives the LOCAL modifier as an accept/reject vector against the real parser
   — omission and `null` must fail a `required` field, `null` and absence must
   pass a `.nullish()` one, `""` must additionally pass an optional decimal;
4. drives the SDK and REST modifiers as obligations: this parser may never be
   stricter than the SDK about presence, and any loosening relative to either
   source needs a recorded `presence` divergence;
5. requires every `value-form` divergence to carry a vector **this parser
   accepts**, plus the reason, authority and pinned citation for the source rule
   it departs from. The suite does not vendor or execute the SDK or the OpenAPI
   document, so what the SOURCE rejects is recorded and cited rather than run —
   round-2 finding L2 is that this step used to be described as proving the
   rejection;
6. requires every citation to embed the pinned commit (or the official spec URL
   with its retrieval date) and rejects a mutable `blob/main` link.

The REST book therefore now **requires** `market`, `asset_id`, `bids`, `asks`,
`min_order_size`, `tick_size`, `neg_risk` and `hash`, exactly as the OpenAPI and
the SDK do. Only `timestamp` and `last_trade_price` tolerate absence, because
the SDK declares those two `.nullish()`, and both divergences from the OpenAPI
are recorded with that evidence.

## 6. The feed's six safety invariants

All six were added by review findings — H1 and H2 in each of rounds 1 and 2, H1
and M1 in round 3 — and all six are about the same thing: an event must say what
actually happened, on the connection it actually happened on.

**1. Every socket callback is bound to the session that installed it.** A
transport may deliver a frame, an open, an error or a close for a socket the
feed has already abandoned. Each of the four closures captures an immutable
session token (its `connectionId`, its socket, the generation it was serving)
and does nothing unless that token is still the live one:

| Late callback | What happens |
| --- | --- |
| `onMessage` | the raw frame is recorded under the STALE session's `connectionId`/generation, and reported as a `STALE_CONNECTION_FRAME` problem carrying the frame. Never published as current data, never dropped (§8.3) |
| `onOpen` | the abandoned socket is closed. No `FeedConnected`, no generation change, no timers |
| `onError` | ignored: a dead socket's failure may not relabel the live connection's disconnect |
| `onClose` | ignored: that session's disconnect was published when it was retired |

**2. A gap is closed only by an acknowledgement naming its exact generation.**
`markResynchronized` takes the generation being acknowledged and returns a typed
outcome:

```ts
const gap = feed.openGap;                       // reasonCode, subscriptionGeneration, ...
await gateway.applyAuthoritativeSnapshot(gap);
const outcome = feed.markResynchronized({ subscriptionGeneration: gap.subscriptionGeneration });
// { status: "accepted" } | { status: "rejected", reasonCode: "NO_OPEN_GAP" | "GENERATION_MISMATCH", ... }
```

No open gap → `NO_OPEN_GAP` and nothing is published, which is also what stops a
duplicate acknowledgement. A generation other than the open gap's →
`GENERATION_MISMATCH`, which is the race that matters: a snapshot fetched for
generation N, applied after a reconnect or a subscription change opened
generation N+1, must not close the newer gap. A rejection is returned rather
than thrown, because a late snapshot is a race and not a defect.

**3. No socket-dependent action is lost because the handle has not arrived.** A
transport is not obliged to open asynchronously: an already-connected one calls
`onOpen` from inside the factory call, before the feed has a socket to send on.
Before round-2 finding H1 that published `FeedConnected` while the subscription
frame went nowhere — a feed that believed it was subscribed to a socket it had
sent nothing on. Each connect attempt now queues socket-dependent work and runs
it the instant the handle exists, so the subscription is written before
`FeedConnected` is published, a `stop()` from inside a synchronous callback still
closes its socket, and an attempt overtaken before its handle arrived is closed
rather than leaked.

**4. Every gap opens under a generation no gap has used.** Gap identity is the
`subscriptionGeneration`, so it has to be unique, and it is: every gap this feed
opens is opened by a transition that advances the generation in the same step.
Adding tokens replaces server-side subscription state, so it advances the
generation and opens a gap; removing tokens does neither, because the venue's
dynamic `unsubscribe` leaves the rest of the subscription in place and nothing
still subscribed missed anything; and a reconnect **with nothing subscribed**
resubscribes nothing, advances nothing and opens nothing (round-2 finding H2 —
it used to open a gap at the unchanged generation, which the previous gap's
acknowledgement then closed). The converse is not claimed: the generation also
advances where nothing was missed and no gap is owed — the first connection, and
any change made while disconnected.

**5. At most one session is ever live, and starting a connection stands the
pending reconnect down.** A disconnect arms a backoff timer and returns the feed
to `idle`. If the caller calls `start()` during that window, the timer used to
survive and fire at its original deadline, connecting a THIRD socket over the
manually started second one — which stayed physically open and subscribed, had
every frame on it refused as stale purely because its identity had been
overwritten, and was never named by a `FeedDisconnected` again (round-3 finding
H1). Three things hold the invariant now, outermost first: a connect attempt
cancels any armed reconnect; the timer stands down unless the feed is still
`idle` with no session; and a connect attempt that somehow finds a live session
retires it, closes it and publishes `FeedDisconnected` with
`CONNECTION_SUPERSEDED` rather than overwriting it. The first two make the third
unreachable, which is the point of having it.

**6. A frame is subscription data only once that session's subscription has been
written.** The other end of the window invariant 3 opened: a transport that
opens *and delivers a frame* from inside the factory call does so before the
deferred open has planned the subscription, sent it, or advanced the session's
generation. Such a frame used to be normalized and published as current data,
stamped with the session's **pre-subscription** generation — under which no
subscription was ever written — and it reached the consumer before
`FeedConnected` announced the connection (round-3 finding M1). It is now refused
at the gate as a `PRE_SUBSCRIPTION_FRAME` problem carrying the payload, the same
refusal shape a stale frame gets, and it is still preserved raw (§9.1). The
refusal is a window and not a verdict on the connection: the frame after the
open is ordinary data.

## 7. Ports

Nothing here reads a clock, opens a socket, performs a request, or generates an
identifier directly; `src/runtime.ts` holds the only implementations that touch
a global and nothing inside the package imports it. `src/testing/index.ts`
provides a deterministic double for each, which is what lets the whole contract
suite run offline with no network and no real time.

`PublicMarketDirectory` is the catalogue seam: token → market identity, market
announcement → registration, observed parameter change → version assignment.
Every method may decline, and a declined answer becomes a reported problem.

## 8. Safety

PUBLIC market data only. No environment variable is read, no header
authenticates anything, no signer or wallet exists, no order is placed, and no
run-mode default is touched (ADR-010). `MAX_RUN_MODE=PAPER`,
`ALLOW_REAL_ORDERS=false`, and the zero live caps are untouched by this package.
