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

  **These examples are SYNTHETIC COMPLETED PLACEHOLDERS, not captured
  official responses.** The documentation does not publish a full REST trade
  body, so the examples were *completed* field-by-field to satisfy every
  field `ClobTradeSchema` marks required. The added values (all-zero
  transaction hashes, the all-zero maker address, `bucket_index: 0`, the
  epoch-second `match_time`/`last_update`) are placeholders chosen only to
  satisfy the SDK's declared types. They assert nothing about what the venue
  really returns — in particular nothing about a not-yet-broadcast trade —
  and must never be cited as an observed venue response.
- All decimal strings are canonical per handoff §7.3 (no trailing
  fractional zeros): a documented 20% is recorded as `"0.2"`.

  **Canonicalized decimals are normalized data, not raw wire capture.** The
  fee and reward strings in `fees/fee-reward-parameters.json` were rewritten
  into canonical form from the values printed in the documentation, so they
  are evidence of the *numeric values* only. They CANNOT prove which raw
  lexeme the venue actually emits (for example `"0.20"` versus `"0.2"`, or a
  JSON number versus a string). No consumer may cite these fixtures as
  wire-format evidence. A future raw-wire capture must preserve the venue's
  original strings verbatim, in a separate fixture that is explicitly marked
  as un-normalized, before any wire-lexeme claim is made.
- The `market_settings_example` inside `fees/fee-reward-parameters.json`
  declares the **SDK-parsed** `market.rewards` layer, not the raw Gamma HTTP
  body. The official market-details page publishes both and they differ:
  its TypeScript/Python tabs type `rewardsAmount`, `rewardsDailyRate`, and
  `rewardsMinSize` as `DecimalString`/`Decimal` and print them quoted, while
  its API (Gamma) tab types them `number` and prints them unquoted. Both are
  real, because the SDK's `ClobRewardsSchema` parses them through
  `DecimalishSchema` (a `string | number` input union that always OUTPUTS a
  decimal string). This fixture therefore carries decimal STRINGS and
  `verify-venue` rejects a JSON number for those three fields; a number would
  mean an un-parsed raw body had leaked in. `rewardsMaxSpread` stays a JSON
  number — it is `number`/`float` in every published representation. See
  report §7.1 for the verbatim quotes and the SDK permalinks. The same object
  carries `holdingRewardsEnabled` (`?: boolean | null`), which completes the
  published `MarketRewards` field list; the frozen `true` is illustrative of
  the documented shape, since the page's own JSON example omits the key.
- **An absent key and a `null` value are different facts.** A fixture may omit
  an optional key, but it may carry an explicit `null` only where an official
  published type documents the null — currently
  `TransactionOutcome.transactionId`, `clobRewards[].endDate`,
  `holdingRewardsEnabled`, and the REST maker order's `fee_rate_bps`. Any
  other `null` is rejected by `verify-venue`, including for fields the SDK
  marks `.nullish()`. That is a deliberate narrowing for a frozen fixture set
  and it must not be copied into a runtime parser; report §17 states the rule
  and its limits.

## Caveats

- `market-ws/price-change.json` contains a `size: "0"` level-removal
  example. The current official docs do not explicitly state absolute-size
  semantics; the example follows handoff §23 and is flagged UNVERIFIED in
  the verification report (conflict C-1). WP-070 must confirm before the
  order-book package relies on it.
- All numeric limits and program parameters are configuration snapshots
  effective 2026-08-24 and must be re-verified each phase (handoff §1.2).

## Re-verification 2026-09-15 (VENUE-2, the phase-2 venue gate)

Added by `VENUE-2`; everything above this heading is the frozen WP-000 text
and is unchanged. Full evidence, drift rows and source digests are in
[`docs/venue/verified-2026-09-15.md`](../../../docs/venue/verified-2026-09-15.md)
(fetches performed 2026-09-16 UTC; the file carries the round's
authorization date).

**Outcome: every fixture payload in this tree is unchanged.** Each was
re-checked against the current official page it cites and against the
official SDK at commit `983a10a7579c95043d4099f60873ff7ea817e5a0` (`main`,
2026-09-14) as well as the frozen commit `7fdbed42484b5d279c71aa36d3757d18968260da`.
No drift found by the round alters a wire shape a fixture encodes, so the
`retrieved: "2026-08-24"` envelopes and `effective_date: "2026-08-24"`
snapshots stay as they are — they remain true statements about when the
payloads were captured.

| Fixture | Verdict | Note (report row) |
| --- | --- | --- |
| `market-ws/*.json` (6 files) | valid, unchanged | The cited `source` URL is a standing **HTTP 308** to `market-data/realtime-data#market-stream` (report D-07); the AsyncAPI page `api-reference/wss/market` was re-fetched byte-identical to 2026-08-28/2026-09-02. Every `market` value is a 66-char hex condition id, which the SDK now requires (`market: ConditionIdSchema`, D-08); `asset_id` is now `ClobAssetIdSchema` (still an unconstrained string, D-09). |
| `user-ws/order-lifecycle.json`, `user-ws/trade-settlement.json` | valid, unchanged | `market-data/websocket/user-channel` is now also a **308** (→ `trading/realtime-order-updates`, D-11); the cited sources are unaffected. The five plain trade statuses are re-confirmed by the user AsyncAPI page and the order-lifecycle page (C-3 evidence widened). |
| `orders/order-responses.json` | valid, unchanged | `order-response.ts` byte-identical across commits. The `unmatched` status now has two official definitions (C-6); the frozen example's wording is one of them. |
| `orders/rest-trades.json` | valid, unchanged | **Provenance-note correction:** the sentence above, "The documentation does not publish a full REST trade body", is no longer true — `trading/manage-orders` now publishes a `Trade Type` and `Trade Example` for `GET /data/trades`, and that raw example carries a **plain** `"status": "MATCHED"` while the same page's SDK tab prints `"TRADE_STATUS_MATCHED"` (report C-5). The fixture keeps the SDK's prefixed form because the SDK controls venue facts (handoff §1.1) and `TradeStatusSchema` accepts both. The examples remain synthetic completed placeholders. |
| `orders/restricted-modes.json` | valid, unchanged | — |
| `heartbeat/heartbeat.json` | valid, unchanged | All five examples re-confirmed verbatim. |
| `fees/fee-reward-parameters.json` | valid, unchanged | Every rate, share, tier and reward parameter re-confirmed. The venue now also publishes a **per-market** `feeSchedule { rate, exponent, takerOnly, rebateRate }` (D-13) that this fixture does not model. |
| `rate-limits/rate-limits.json` | valid, unchanged | All eight tiers and every IP limit re-confirmed; a **negative cancel balance** rule is now documented for Standard–Gold tiers (D-21) and is not modelled here. |
| `geoblock/geoblock.json` | valid, unchanged | — |
| `positions/split-merge-redeem.json` | valid, unchanged | The four addresses re-confirmed on two pages; `trading/ctf/overview` is now a **308** to `trading/positions/how-positions-work` (D-25); the contracts page now publishes the CTF Exchange and Neg Risk CTF Exchange addresses (D-26) — not added here (see the validator note). |
| `rtds/twap-update.json` | valid, unchanged | Page byte-identical to 2026-09-02. |

**Caveat corrections to the frozen text above (dated, not edited in place):**

- The "Caveats" bullet on `market-ws/price-change.json` (C-1 UNVERIFIED,
  "WP-070 must confirm") is historical: C-1/U-1 was **CLOSED 2026-08-28 by
  ADR-013** and re-verified documentarily on 2026-09-02 and 2026-09-16. The
  example name `level-removed-absolute-zero-UNVERIFIED` is kept only because
  `apps/ops-cli/src/verify-venue/fixtures.test.ts` asserts it; renaming is a
  fixture-plus-validator change for the `apps/ops-cli` owner.
- "All numeric limits and program parameters are configuration snapshots
  effective 2026-08-24" — re-verified unchanged as of 2026-09-16; they remain
  volatile and are re-verified at each phase gate.

**Why nothing new was frozen this round (validator constraints, reported to
the `apps/ops-cli` owner in the report's §15):**
`apps/ops-cli/src/verify-venue/checks.ts` pins `effective_date` to the single
value `2026-08-24`, pins the report path to `verified-2026-08-24.md`, pins the
SDK permalink prefix to `7fdbed4…`, and has no spec for `feeSchedule`, the
batch `POST /orders` response array, `GET /clob-markets/{condition_id}`
(`itode`) or `GET /auth/ban-status/closed-only`. A phase-2 snapshot of any
newly documented parameter therefore cannot pass `verify-venue` without an
`apps/ops-cli` change, which is outside `VENUE-2`'s paths. The documented
values are recorded in the dated report instead, with their sources and
digests, so the owning packages can freeze them once the validator admits
dated snapshots.
