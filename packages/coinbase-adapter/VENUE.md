# Coinbase venue facts (WP-090)

**Verified 2026-08-27.** Venue facts are volatile (handoff §1.2); this is a dated
snapshot, not a standing guarantee. The machine-readable copy of everything below
lives in `src/venue-facts.ts` and is asserted by `src/venue-facts.test.ts`, so
this document and the code cannot drift apart silently.

---

## 1. Which Coinbase product, and why

**Chosen: the Coinbase Advanced Trade Market Data WebSocket,
`wss://advanced-trade-ws.coinbase.com`.**

| | Advanced Trade market data (chosen) | Coinbase Exchange market data (not chosen) |
| --- | --- | --- |
| Endpoint | `wss://advanced-trade-ws.coinbase.com` | `wss://ws-feed.exchange.coinbase.com` |
| Unauthenticated? | Documented per channel: `heartbeats`, `candles`, `status`, `ticker`, `ticker_batch`, `level2`, `market_trades` are all listed "Requires Authentication: **No**", and the endpoints page states plainly "**A JWT is not required**" | Documented as "our traditional feed which is available without authentication" |
| Machine-readable schema | Yes — an AsyncAPI 3.0.0 document defines the envelope and every channel payload | No equivalent published schema found |
| Trades | `market_trades` | `matches` |
| Top of book | `ticker` (`best_bid`, `best_ask`, `best_bid_quantity`, `best_ask_quantity`) | `ticker` (`best_bid`, `best_ask`) |
| Gap detection | `sequence_num` on every message, plus `heartbeat_counter` | `sequence` |

Both surfaces are public and neither needs a credential, so either satisfies the
hard constraint. Advanced Trade was chosen because:

1. **The unauthenticated guarantee is stated per channel, in a table**, rather
   than as a single sentence about the endpoint. The exact channels this adapter
   uses are individually marked as needing no authentication.
2. **A published AsyncAPI document pins the frame shapes.** The wire schemas in
   `src/wire.ts` are transcribed from it rather than inferred from prose
   examples, which is the difference between a cited schema and a guess.
3. **The top-of-book message carries sizes as well as prices.** The frozen
   `ReferenceTopOfBookChanged` contract has `bidSize` and `askSize`; a surface
   that supplied only prices would leave two contract fields permanently absent.

**Nothing authenticated is in scope.** The Advanced Trade *user* endpoint
(`advanced-trade-ws-user`) and the `user` / `futures_balance_summary` channels
require a CDP JWT and are therefore out of scope by rule, not by preference.
`src/venue-facts.ts` contains no code path that can attach a credential, and
`test/contract/coinbase/isolation.test.ts` asserts it.

---

## 2. Cited facts

Every URL below was fetched and read on **2026-08-27**.

| # | Fact | Source |
| --- | --- | --- |
| 1 | Public market-data URL is `wss://advanced-trade-ws.coinbase.com`; "A JWT is not required." | [endpoints](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints) |
| 2 | `heartbeats`, `ticker`, `ticker_batch`, `level2`, `market_trades`, `candles`, `status` are marked "Requires Authentication: No"; only `user` and `futures_balance_summary` require it. | [channels](https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-channels) |
| 3 | The documented public subscribe form is `{"type":"subscribe","product_ids":[…],"channel":"…"}` with no `jwt` key ("Sending Messages without API Keys"). | [overview](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview) |
| 4 | A subscribe message is mandatory within 5 seconds of connecting; one channel per subscription message. | [overview](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview) |
| 5 | "The WebSocket feed uses a bidirectional protocol that encodes all messages as JSON objects." "New message types can be added at any time." | [overview](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview) |
| 6 | Every streamed message carries `channel`, `timestamp` (server send time, RFC 3339) and `sequence_num`, documented in the AsyncAPI as a "Per-connection message sequence number". | [AsyncAPI](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/advanced-trade-asyncapi.json) |
| 7 | A forward jump in `sequence_num` means a message was dropped; a lower value "can be ignored or represent a message that has arrived out of order"; consumers must handle both. | [overview](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview) |
| 8 | `market_trades` carries `events[].type` ∈ {`snapshot`,`update`} and `events[].trades[]` of `{trade_id, product_id, price, size, side, time}`; `price`/`size` are strings, `time` is RFC 3339, `side` is enumerated `BUY`/`SELL`. | [market-trades](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/market-trades) |
| 9 | `side` "refers to the makers side"; the AsyncAPI calls it "The maker's side of the trade". Updates batch the last 250 ms, so one update may hold many trades. | [channels](https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-channels), [market-trades](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/market-trades) |
| 10 | `ticker` carries `events[].tickers[]` with `product_id`, `price`, `best_bid`, `best_ask`, `best_bid_quantity`, `best_ask_quantity`, all strings; it emits on every match. | [ticker](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/ticker) |
| 11 | `ticker_batch` shares the schema but "currently doesn't provide best bid or best ask fields". | [channels](https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-channels) |
| 12 | `heartbeats` sends once a second with a `heartbeat_counter` "which verifies that no messages were missed"; no products and no authentication. | [heartbeats](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/heartbeats) |
| 13 | "Most channels close within 60-90 seconds when no updates arrive. Subscribe to `heartbeats` to keep the connection open." | [endpoints](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints) |
| 14 | The server answers a subscribe or unsubscribe with a `subscriptions` message. | [overview](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview) |
| 15 | "WebSocket connections and unauthenticated messages are each limited to 8 per second per IP." | [rate limits](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-rate-limits) |

---

## 3. Conflict C-CB-1 — the scope of `sequence_num`

Two current official Coinbase sources disagree:

- The **overview** says "Sequence numbers are increasing integer values **for
  each product**".
- The **AsyncAPI document** says `sequence_num` is a "**Per-connection** message
  sequence number".

The readings are not compatible: on a connection carrying two products, the
per-product reading predicts two interleaved counters, and the per-connection
reading predicts one.

**Resolved in favour of per-connection**, on the AsyncAPI's authority as the
machine-readable specification of these exact frames, corroborated by observation
O-CB-2 below. The tracker in `src/sequence.ts` is per-connection and documents
the conflict at the point of use. If Coinbase ever moves to per-product
numbering, this adapter reports a storm of gaps rather than mis-detecting
quietly — a loud wrong answer, which is the preferred failure direction here.

---

## 4. Live observations (NOT documentation)

One read-only, unauthenticated, 25-second subscription to the public endpoint on
**2026-08-27**, used only to settle facts the documentation leaves open. No
credential was sent, no order was placed, and **no observed bytes became a
fixture** — every fixture derives from a documented example. Tests are offline.

- **O-CB-1 — framing.** All 338 frames were UTF-8 text carrying JSON objects. No
  binary frame, and no bare non-JSON text frame (no `PING`/`PONG` payload): the
  heartbeat is an ordinary JSON message on the `heartbeats` channel. **This
  settles the ADR-004 §1 open item for the Coinbase side**, which had recorded
  Coinbase framing as "to verify" and warned that `payloadUtf8` cannot hold
  binary. On this evidence, no ADR-004 amendment is needed for Coinbase. The
  adapter nonetheless still *reports* a binary frame as a typed anomaly rather
  than assuming it can never happen.
- **O-CB-2 — sequence scope.** `sequence_num` advanced by exactly one across all
  channels and products on the single connection (0, 1, 2, … with `heartbeats`,
  `ticker`, `market_trades` and `subscriptions` frames interleaved), starting at
  0. See C-CB-1.
- **O-CB-3 — envelope shape.** Every frame's top-level key set was exactly
  `{channel, timestamp, sequence_num, events}`, and `timestamp` was RFC 3339 with
  nanosecond precision, which the repository's `IsoTimestampSchema` accepts
  unchanged.

A single observation is weak evidence. Nothing in this package *depends* on an
observation alone: each one either agrees with a citation in §2 or is handled
conservatively per §5.

---

## 5. UNVERIFIED items and the conservative handling chosen

| # | Question the documentation does not answer | What this package does instead |
| --- | --- | --- |
| **U-CB-1** | Is a decimal ever sent as `""` or `null` to mean absent, as the Polymarket CLOB does? | An **absent key** stays absent (documented for `ticker_batch`). A key that is **present but empty or null** is a typed anomaly with the raw frame preserved — never mapped to absent, never invented as `"0"`. Absence and emptiness are different facts. |
| **U-CB-2** | Does the venue replay or backfill messages missed while disconnected? | Assumed **no**. A reconnect opens `FeedGapDetected` with `requiresAuthoritativeSnapshot`, and a separate `DataQualityIncidentOpened` records that missed trades are unrecoverable. `FeedResynchronized` claims only that current state was restored. |
| **U-CB-3** | Does `market_trades.side` really report the MAKER side? | The documented reading is followed (`takerSide` is its inverse), and the raw venue value is carried on every normalized trade so a correction is one function and no information is lost. **This is the highest-consequence open item in this package** — see the handoff's `known_risks`. |
| **U-CB-4** | What is the maximum number of `product_ids` per subscription? | No limit assumed and none enforced. Subscription planning belongs to `WP-120`. |
| **U-CB-5** | What is the exact payload of the `subscriptions` acknowledgement? | Recognized by channel name and classified as a control frame. No field of it is parsed or relied on; it advances the sequence counter because it carries `sequence_num`. |

---

## 6. What this package deliberately does not do

- **No order-book depth.** The work plan scopes `WP-090` to trades and top of
  book. `level2` is recognized as a channel this adapter does not handle, and a
  `level2` frame is reported as `COINBASE_UNKNOWN_CHANNEL` rather than parsed.
- **No envelope completion.** `eventId`, `gatewayEpoch`, and `ingestSeq` are the
  gateway's (ADR-002 §2.1, handoff §9.1).
- **No publication.** This package produces values; `WP-120` records and
  publishes them.
- **No configuration.** Every parameter is a constructor argument.
