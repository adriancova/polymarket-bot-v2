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
- `user-ws/` — authenticated user channel: order lifecycle
  (PLACEMENT/UPDATE/CANCELLATION) and the six trade settlement states
  (MATCHED_NOT_BROADCASTED/MATCHED/MINED/CONFIRMED/RETRYING/FAILED).
- `orders/` — order placement responses: `live`, `matched`, `delayed`,
  `unmatched`, and error-taxonomy examples.
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

## Caveats

- `market-ws/price-change.json` contains a `size: "0"` level-removal
  example. The current official docs do not explicitly state absolute-size
  semantics; the example follows handoff §23 and is flagged UNVERIFIED in
  the verification report (conflict C-1). WP-070 must confirm before the
  order-book package relies on it.
- All numeric limits and program parameters are configuration snapshots
  effective 2026-08-24 and must be re-verified each phase (handoff §1.2).
