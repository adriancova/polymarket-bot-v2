# Sanitized Polymarket venue fixtures

Frozen by WP-000 on **2026-08-24** together with
`docs/venue/verified-2026-08-24.md`. These fixtures are the contract-test
surface required by handoff §16.3 and are consumed by
`apps/ops-cli/src/verify-venue/`.

## Provenance

Every fixture file is a JSON object with a common envelope:

```json
{
  "fixture": "<category/name>",
  "source": "<official documentation URL>",
  "retrieved": "2026-08-24",
  "sanitized": true,
  "notes": "<provenance and caveats>",
  "examples": [ ... ]
}
```

Payloads are reconstructed from the examples published in the official
Polymarket documentation at `source` on the retrieval date. Where the docs
show elided values (for example `0xabc123…`), full-length synthetic
placeholders are substituted so parsers see realistic shapes.

## Sanitization rules

- No real API keys, secrets, passphrases, signatures, or signed payloads.
  Credential-shaped fields use all-zero or `sanitized-*` placeholders.
- No real wallet addresses or personal data. Addresses are all-zero or
  clearly synthetic (`0x0000...`, `0xdead...beef` style).
- Market/condition/asset identifiers reuse only the identifiers already
  published as examples in the official documentation, or synthetic values.
- Transaction hashes and order IDs are synthetic full-length hex strings.
- Monetary values are the documentation's example values or small round
  numbers; they identify no account.
- Nothing in this tree was produced by placing an order or calling an
  authenticated endpoint. No credential existed in the environment.

## Layout

- `market-ws/` — market WebSocket events: book snapshot, price change
  (including the level-removal example, see caveat below), tick-size change,
  last trade, best bid/ask, market lifecycle (`new_market`,
  `market_resolved`).
- `user-ws/` — authenticated user channel RAW wire events per the official
  SDK bindings: order lifecycle (PLACEMENT/UPDATE/CANCELLATION) and trade
  settlement with the plain user-channel wire statuses
  (MATCHED/MINED/CONFIRMED/RETRYING/FAILED).
- `orders/` — order placement responses (`live`, `matched`, `delayed`,
  `unmatched`, error-taxonomy examples) and REST trade reads with prefixed
  `TRADE_STATUS_*` constants including the REST-only
  `TRADE_STATUS_MATCHED_NOT_BROADCASTED` (conflict C-3).
- `heartbeat/` — `POST /v1/heartbeats` empty-ID bootstrap, ID rotation,
  and the documented 400 invalid-ID recovery.
- `fees/` — fee formula parameters, category fee rates, rebate and
  liquidity-reward program parameter snapshots.
- `rate-limits/` — IP and per-signer limit snapshots plus documented
  response headers. Snapshots, not truths (handoff §9.13).
- `geoblock/` — `GET https://polymarket.com/api/geoblock` response examples.
- `positions/` — split/merge/redeem (CTF) request/TransactionOutcome
  examples, published Polygon contract addresses (public on-chain data),
  and position-ID derivation.
- `rtds/` — Chainlink TWAP subscribe/update messages (30 s and 60 s
  windows) over RTDS.

## Raw vs normalized layers and SDK reference commit

Raw wire fixtures (`market-ws/*`, `user-ws/*`, `orders/*`) follow the raw
Zod schemas in the official unified SDK bindings
(`Polymarket/ts-sdk`, `packages/bindings/src/subscriptions/clob.ts`,
`packages/bindings/src/shared.ts`, `packages/bindings/src/clob/account.ts`,
`packages/bindings/src/clob/order-response.ts`) at reference commit
`7fdbed42484b5d279c71aa36d3757d18968260da` (retrieved 2026-08-24; raw
sources re-verified verbatim 2026-08-26). Every SDK citation is a commit
permalink — mutable `blob/main` links are rejected by the verifier — and
each `source` field of an SDK-derived fixture must embed that commit. The
docs' normalized events are camelCase SDK models layered on those raw
schemas and are NOT what these fixtures represent. Per the SDK, the user
websocket channel serializes plain trade statuses while REST serializes
prefixed `TRADE_STATUS_*` constants, and `MatchedNotBroadcasted` appears
only on REST trades (conflict C-3 in the verification report).

Wire-type conventions preserved by these fixtures and enforced by
`apps/ops-cli/src/verify-venue`:

- Optional decimal fields use the SDK `OptionalDecimalStringSchema`, so the
  **wire empty string `""` is a valid value** (`fee_rate_bps`, `best_bid`,
  `best_ask`, `spread`, `tick_size`, `old_tick_size`, `min_order_size`,
  `last_trade_price`, `last_trade_price.size`, `makingAmount`,
  `takingAmount`).
- `outcome_index`/`bucket_index` on the user websocket channel are
  **integers** (`z.number().int()`); REST `bucket_index` is `z.number()`.
- `timestamp`, `match_time`, `matchtime`, `last_update`, `created_at`, and
  `expiration` are **digit strings** (`/^\d+$/`).
- `orders/rest-trades.json` follows `ClobTradeSchema`/`MakerOrderSchema`
  (every field required; no `outcome_index` on REST maker orders), which is
  a different contract from the websocket trade event.
- All decimal strings are canonical per handoff §7.3 (no trailing
  fractional zeros): a documented 20% is recorded as `"0.2"`.

## Caveats

- `market-ws/price-change.json` contains a `size: "0"` level-removal
  example. The current official docs do not explicitly state absolute-size
  semantics; the example follows handoff §23 and is flagged UNVERIFIED in
  the verification report (conflict C-1). WP-070 must confirm before the
  order-book package relies on it.
- All numeric limits and program parameters are configuration snapshots
  effective 2026-08-24 and must be re-verified each phase (handoff §1.2).
