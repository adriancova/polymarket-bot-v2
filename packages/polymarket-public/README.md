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
- **It drops nothing silently** (§8.3). Every element of every inbound frame
  becomes exactly one normalized event or exactly one
  `PublicMarketProblem` carrying the raw value; the contract suite asserts that
  accounting.

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

## 5. R-2: the SDK anchor table

`docs/contracts/protected-contracts.md` §8.1 assigns register item R-2 to this
package: hand-transcribed venue schemas must not be silently load-bearing.

The mechanism is `test/contract/polymarket-public/sdk-anchor/`. It records, for
every field of every venue schema this package owns, the modifier the official
SDK declares, with a commit permalink to the pinned reference commit
`7fdbed42484b5d279c71aa36d3757d18968260da`. The contract suite then:

1. compares the anchor table's field set against the package's zod schemas, key
   for key, in both directions;
2. asserts each anchor's field count against the number read from the SDK
   source, so adding a field without re-reading the SDK fails;
3. drives every modifier as an accept/reject vector against the real parser —
   omission must fail a `required` field, `null` must pass a `.nullish()` one,
   and `""` must additionally pass an optional decimal;
4. requires every citation to embed the pinned commit and rejects a mutable
   `blob/main` link;
5. requires a written reason (`sdkDivergence`) wherever this package is
   deliberately looser than the SDK, so a divergence is never indistinguishable
   from a transcription mistake.

## 6. Ports

Nothing here reads a clock, opens a socket, performs a request, or generates an
identifier directly; `src/runtime.ts` holds the only implementations that touch
a global and nothing inside the package imports it. `src/testing/index.ts`
provides a deterministic double for each, which is what lets the whole contract
suite run offline with no network and no real time.

`PublicMarketDirectory` is the catalogue seam: token → market identity, market
announcement → registration, observed parameter change → version assignment.
Every method may decline, and a declined answer becomes a reported problem.

## 7. Safety

PUBLIC market data only. No environment variable is read, no header
authenticates anything, no signer or wallet exists, no order is placed, and no
run-mode default is touched (ADR-010). `MAX_RUN_MODE=PAPER`,
`ALLOW_REAL_ORDERS=false`, and the zero live caps are untouched by this package.
