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

## Re-verification 2026-09-16 (VENUE-2, the phase-2 venue gate)

Added by `VENUE-2`; everything above this heading is the frozen WP-000 text
and is unchanged. Full evidence, drift rows and source digests are in
[`docs/venue/verified-2026-09-16.md`](../../../docs/venue/verified-2026-09-16.md)
(round authorized 2026-09-15; fetches performed 2026-09-16 UTC; the file is
named by its verification date — it was `verified-2026-09-15.md` in the r0
record and was renamed in remediation round 1).

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
  example name `level-removed-absolute-zero-UNVERIFIED` **stays by ruling**:
  ADR-013 Consequences (`docs/adr/ADR-013-book-price-change-absolute-size-confirmed.md:153-156`)
  — "keeps its name … Renaming it, if ever wanted, is a fixture-owning
  package's change under its own review." The assertion that pins the name is
  `test/contract/polymarket-public/market-ws-fixtures.test.ts:144` (plus the
  note at `test/replay-golden/order-book/replay-two-token-books.json:71`),
  not `apps/ops-cli` (the r0 text said so; corrected in remediation round 1,
  L-1). No rename is queued.
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

## Re-verification 2026-09-30 (VENUE-3, the phase-3 venue gate)

Added by `VENUE-3`; everything above this heading is unchanged (the frozen
WP-000 text and the dated VENUE-2 section). Full evidence, drift rows and
source digests are in
[`docs/venue/verified-2026-09-30.md`](../../../docs/venue/verified-2026-09-30.md)
(every fetch performed 2026-09-30 UTC).

**Outcome: no fixture payload was edited, but three fixtures are affected by
drift in the shapes or values they encode.** Each is a finding for the
fixture set's owner (and for `apps/ops-cli`, whose validator pins
`effective_date: "2026-08-24"` and asserts some of these strings verbatim).
The payloads remain true records of what the venue documented on
2026-08-24.

| Fixture | Verdict 2026-09-30 | Note (report row) |
| --- | --- | --- |
| `rtds/twap-update.json` | **deprecated source** | The cited page `market-data/chainlink-twap` is gone (308 to `market-data/realtime-data#twap-prices`; the `.md` source no longer exists — E-09). Reference prices moved to the authenticated PolyBolt service `wss://ws-live-v2.polymarket.com/ws`: channel `price.crypto.twap` with `filter` `{"symbol":"btcusd","window_seconds":60}`, a `{"v":1,"channel","seq","ts","snapshot"?,"dropped"?,"payload"}` envelope, `window_seconds` instead of `window_s`, a decimal-string price ("Do not apply that E18 conversion"), and **no 30-second window** (E-10). Legacy RTDS price topics are deprecated, removal "planned one month after the `0.11.0` release" (E-11). The replacement needs CLOB API credentials — conflict C-13 must be ruled on before any replacement fixture is written. |
| `fees/fee-reward-parameters.json` | **stale field** | `liquidity-rewards-market-settings.samples_per_epoch: 10080` — the page now says "An epoch is one UTC day … up to 1,440 samples" (E-04). All fee rates, rebate shares and tiers are unchanged. |
| `orders/restricted-modes.json` | **contested** | `http-503-cancel-only`: the matching-engine guide now shows `{"error": "trading is disabled"}` for both cancel-only and fully disabled trading and says the response "does not establish whether cancels are available" (E-05); the CLOB OpenAPI still shows this fixture's string (conflict C-9). The post-only example's `Retry-After: 79`, marked illustrative above, now matches the guide's own example. The 425 example stays valid; a `Retry-After` header is now documented as optional on 425 (E-06). |
| every other fixture | valid, unchanged | The market-stream section, both AsyncAPI pages, manage-orders, rate-limit, geoblock (response shape), positions and contracts pages are byte-identical or identical after table-format normalization; the SDK's `subscriptions/clob.ts`, `shared.ts`, `clob/account.ts` and `clob/order-response.ts` are byte-identical to VENUE-2's. `orders/rest-trades.json`'s prefixed statuses are now also what the CLOB OpenAPI enumerates for `GET /data/trades` (E-13). |

## Exception 2026-10-06 (V2-9): sanitized live public captures

Added by `V2-9` (`docs/venue/protocol-v2-migration-plan.md`, package `V2-9`,
acceptance 4); everything above this heading is unchanged. It answers
`docs/venue/verified-2026-10-05.md` §15, which recorded that `protocol-v2/`
departs from the "Sanitization rules" above.

**The decision: a dated, scoped exception, not replacement.** The rules above
allow only documentation-example or synthetic identifiers, and
documentation-example or small round monetary values. `protocol-v2/` keeps
live public identifiers and observed prices and times. They stay, because:

1. **They are the evidence.** These captures pin live V2 shapes that no
   documentation example shows: 75-digit position ids whose `>> 8` is the
   condition (F-44), the 32-byte right-padded condition the CLOB serves
   (C-19), the 404 and 400 on the 31-byte form (F-70), and the undocumented
   `"version":"v2"` (C-21). A replaced id would no longer derive, pair or
   route as the venue's does, so the facts would be lost.
2. **Replacing them changes the payload bytes and digests.** V2-9 must keep
   both, and each raw digest is the one the report's source index records
   (§14), which `verify-venue` now checks.
3. **They name no person or account.** They are public market data, served to
   anyone without credentials.
4. **Readers outside this tree rely on them.** Fourteen test files in other
   packages and tools read these captures and use the live ids, for example
   to show the SDK routes a V2 id to ExchangeV3
   (`test/contract/polymarket-secure/sdk-0-12.test.ts`).

**Scope.** The exception covers only:

- the captures under `protocol-v2/` that the `protocol-v2-captures` check
  claims, each with its provenance sidecar; and
- fixtures copied value for value from such a capture, which name the capture
  and the line. Today that is only `market-ws/book-snapshot-v2.json`, from
  `protocol-v2/ws-market-v2-session.jsonl` line 3, and its check refuses any
  other value.

Within that scope, these may be live: public market identifiers (condition,
position, token, market, event and series ids; slugs, questions and titles),
documented public contract addresses (today the V2 proxies; another needs an
entry, with its source, in `PUBLIC_CONTRACT_ADDRESSES` in
`apps/ops-cli/src/verify-venue/checks.ts`), observed prices, book sizes and
times, public venue metadata as served (for example Gamma's numeric
`createdBy` and `updatedBy` record ids), and the bodies of public,
unauthenticated GETs and of the public market channel.

**Still replaced, and enforced by `verify-venue`** (round 1 of V2-9 widened
this from the payload to the sidecars and to every field; the policy is set
out in `apps/ops-cli/src/verify-venue/captures.ts`, "personal data"):

- **Personal keys, at any depth of any capture.** Keys compare without case
  or separators (`proxy_wallet`, `proxyWallet`). A key containing `wallet`
  holds a labelled synthetic address or `null` (round 5: a number, a
  boolean, a list or an object is refused); `pseudonym` a labelled synthetic value;
  `bio`, `profile_image…`, any key containing `email`, and a user name or
  handle (`user_name`, `x_username`, `display_name`, `handle`) are empty or a
  labelled synthetic value.
- **A person's row**: a trade or activity row, or any object carrying one of
  those keys. Its `name` and `transaction_hash` are labelled synthetic values
  (the hash names the wallet on chain). In a Data API capture every `name`
  is, because S-O06 uses `name` for the wallet's display name in `Trade`,
  `Activity`, `Holder` and `Position`.
- **Personal values, anywhere in a capture or in its sidecar's text**,
  after NFKC normalization and in each percent-decoded layer (round 5): no
  email address; no `0x` 40-hex address other
  than a labelled synthetic one or a documented V2 contract address
  (`PUBLIC_CONTRACT_ADDRESSES`, F-71). A label glued to the address
  (`wallet_0x…`, `maker0x…`) does not hide it (round 3); only more hex
  digits after it, which make it a longer id, do.
- **A trade or activity page** carries only the S-O06 fields: `data` and
  `pagination`, both present; in a row only the `Trade` and `Activity`
  fields; in `pagination` only `limit`, `offset`, `has_more` and
  `next_cursor`. An unrecognized field (an email, a nested profile) is
  refused, since it may carry personal data. A package that captures a new
  field classifies it, with its source.
- **Each field has the type S-O06 declares** (round 3,
  `FEED_ROW_FIELD_TYPES`): integers (`timestamp`, `outcome_index`,
  `limit`, `offset`, non-negative), numbers (`size`, `price`,
  `usdc_size`), booleans (`is_combo`, `has_more`), `next_cursor` a string or
  `null`; `side` is `BUY`, `SELL`, `IN`, `OUT` or empty; `type` one of the
  activity types S-O06 names (`ACTIVITY_TYPES`). A row's `condition_id` is a
  condition id and its `token_id` a decimal token id, each one the report
  read as a market (below) or a labelled synthetic value: a row does not
  vouch for itself. The free text (`title`, `slug`, `event_slug`, `icon`,
  `outcome`) carries no hash-shaped run: `0x` and 20 or more hex digits, or
  20 or more bare hex or decimal digits (80 bits, more than any price,
  size, time or slug needs), other than a labelled synthetic value or a
  market id the report read. Nor do the capture's bytes outside its strings:
  a number of 20 or more digits is refused. The personal fields are strings
  whose values the rules above judge.
- **Market ids the report read** (round 3): a condition id in the URL of a
  source-index row (§14) that is not a feed read; a whole `token_id=` value
  in such a URL; and the tokens of a CLOB market read (`/clob-markets/…`)
  kept as a `live-capture`, whose bytes are the raw response the report's
  source index records, so that they are the report's own and not the
  capture author's.
- **Labelled synthetic** means: `synthetic-` and lowercase letters, digits and
  hyphens (so no email, spaced name or base64url cursor fits); or `0x`, zeros
  and at most eight significant hex digits; or, for a cursor,
  `synthetic-cursor-…`. VENUE-4 also replaced the trade sizes and block
  timestamps; the gate does not judge those values, only that the redactions
  list `timestamp` (below).
- **Feed cursors.** A trade or activity cursor carries the seek anchor of the
  last row (S-O06) and re-fetches the unredacted page, so the page's
  `next_cursor` and every cursor parameter of the sidecar URL (every
  occurrence, whatever its case or percent-encoding) is a labelled synthetic
  value, and one that decodes to a venue cursor is refused. The URL carries
  at most one cursor parameter, and only the query parameters S-O06 documents
  for the feeds (`FEED_QUERY_PARAMETERS`). No other query value, path,
  fragment, row value, pagination value (round 3) or sidecar prose token of
  a trade or activity capture may hide a cursor, in whatever written form
  (round 2): as plain JSON text;
  as the value of an assignment (`cursor=…`, `#cursor=…`, `cursor%3D…`);
  glued to a word; in base64, base64url or hex; percent-encoded or in full
  width.
- **Trade and activity URLs** (round 2) are exactly the Data API host and one
  feed route (`/v2/trades`, `/v2/activity`, `/v2/activity/combos`) with a
  query, in canonical form, with no fragment, and each parameter once
  (round 3). Each query value has the type S-O06 documents for its
  parameter (`FEED_PARAMETER_TYPES`): `limit` an integer to 1000; booleans;
  `side`, `filter_type`, `sort_by` and `sort_direction` their documented
  values; `type` the activity types S-O06 names (round 3: a closed list, so
  no other capital-letter word); `event_id` decimal ids of at most 19
  digits; `filter_amount` a short decimal. `start` and `end`
  are only the documented sentinels `0` and `1`: the bounds are ignored on
  every URL the gate admits, so any other value could only be a real block
  timestamp. A `condition` is a `0x` 62- or 64-hex condition id that the
  report's source index (§14) read as a market, or that is labelled
  synthetic (round 3: a row's `condition_id` no longer vouches for it). So
  no documented value holds a hash-shaped run other than such a condition,
  and the gate refuses one (round 3).
- **Which captures are trade or activity pages** (round 4). The report
  decides, not the sidecar's spelling: a capture is one when the URL that
  the report's source index records for its catalogue source id is a feed
  route, when its sidecar URL reads as one under any spelling
  (percent-encoded, capitalized, with repeated slashes, a port or full-width
  letters), or when its rows carry a wallet. An empty page is one too, so
  its sidecar URL and prose answer to every cursor rule above.
- **The sidecar URL keeps the report's route** (round 4): its scheme, host
  and path are those of the URL the report's source index records for the
  catalogue source id. A sidecar may replace a query value (a cursor, by a
  labelled synthetic one) but not respell or swap the route. Every `https`
  sidecar URL is in canonical form (its own WHATWG serialization, so no
  `:443`, no `.` segment and no capitalized host), with no percent-encoding
  in its path.
- **What the scanner cannot read fails the gate** (round 5, V2-9-R5-01). The
  scanner is defense in depth against an accidental commit, so it fails
  closed, with a named reason, and never falls back to the raw text:
  - sidecar text (`url`, `notes`, each redaction, `extract.rule`) and
    every capture string (keys included) are judged as written,
    NFKC-normalized and in each percent-decoded layer (to four layers); a
    run of `%XX` escapes that is not UTF-8, deeper nesting, or,
    in the URL, a `%` that begins no escape fails the gate. One malformed
    escape (`&unused=%FF`) no longer leaves the rest of the URL undecoded;
  - so does such an escape in any text a cursor scan reads (a trade row, a
    pagination value, a trade URL's query, path or fragment);
  - a URL that does not parse fails, and reads as a trade page, so it
    answers to every rule; an `https` sidecar URL carries no fragment and
    no credential; each query parameter is one the gate lists for the
    URL's route (`SIDECAR_QUERY_PARAMETERS`, with its source; the trade
    and activity routes keep `FEED_QUERY_PARAMETERS`), and a query on a
    route with no list fails;
  - a key containing `wallet` holds an address string or `null`;
  - a `.jsonl` data text that is not JSON is a known control message:
    `PING` or `PONG` sent or received, the market channel URL on the
    `open` record, or a `local-close` reason word;
  - a sidecar that is not valid UTF-8 fails.
- **Outside the trade and activity pages** (round 6, V2-9-R6-02):
  - the sidecar URL is the URL the report's source index records for the
    catalogue source id, character for character, or, when the index cuts
    it with `…`, extends the text before the `…`; so the report vouches for
    every token id, condition and path id in it, and a hash or a wallet
    cannot replace one;
  - each query value has the type its parameter is listed with
    (`SIDECAR_PARAMETER_TYPES`: decimal token ids, condition ids, short
    integers and durations, booleans, and a classified market cursor), and,
    but for that cursor, carries no hash-shaped run that is not a market id
    the report read;
  - no sidecar text (`url`, `notes`, each redaction, `extract.rule`) and no
    capture string hides a venue cursor, in any of the written forms above,
    unless it is a public market cursor classified for the capture's route
    (`PUBLIC_MARKET_CURSORS`: today the `prices_history` cursor on
    `/v2/prices-history`, S-A02 and S-A03). A trade or activity cursor, an
    untyped one, or a market cursor off its route fails the gate.
- **Every fixture envelope is scanned** (round 6, V2-9-R6-01). Each
  fixture-kind check's files (the WP-000 envelope `{fixture, source,
  retrieved, sanitized, notes, examples}`, today's and the 2026-08-24
  baseline's alike) answer to the same scan as a capture and its sidecar
  (`fixturePersonalDataErrors` in `captures.ts`):
  - every envelope text (`fixture`, `source`, `retrieved`, `notes`, each
    example `name`) and every payload string and key, in every reading
    (NFKC and each percent-decoded layer; what cannot be decoded fails by
    name): no email address, and no `0x` 40-hex address other than a
    labelled synthetic one, a documented V2 contract address, or one the
    check's report records (the 2026-08-24 report records the V1 CTF
    contracts);
  - every payload: the personal keys, as in a capture, and, at any depth, a
    value under a transaction-hash key (`transaction_hash`,
    `transactionHash`, `tx_hash`) is a labelled synthetic hash or empty;
  - the notes and every payload text: no personal field written with a
    value, and no token that decodes to a venue cursor (none is classified
    outside a capture's route);
  - the notes, and every payload string with a space (prose): no hex id,
    hash or number of 40 or more digits that is not labelled synthetic,
    unless a payload carries it as a whole value (an id its payload spec and
    `assert` hook judge) or the check's report records it. A hash written
    under a hash label (`transactionHash: …`) is judged so, by its value:
    the V1 CTF notes' `outcome.transactionHash: TxHash` type passes, a
    pasted transaction hash does not.
- A sidecar of a trade or activity page with rows or a cursor lists
  `timestamp` and `next_cursor` among its redactions.
- **Sidecar text** (`url`, `notes`, each redaction, `extract.rule`). A
  personal field written with a value (`name: …`, `name=…`, `"name":"…"`, or
  a URL query parameter such as `name=`), also when a label is glued to it by
  `_` or `-` (`the_name: …`, round 3), holds a labelled synthetic value, a
  `<placeholder>`, `null` or nothing; a redaction's subject list before its
  first colon names fields and is not a value. Prose carries no hex id, hash
  or number of 40 or more digits that is not labelled synthetic, glued to a
  label or not (round 3), unless the capture or the URL carries it or it is
  the sidecar's own digest: a market is named by placeholder
  (`<V1 window>`), as the committed sidecars do.
- **No repeated key** in any object of a capture, a WebSocket frame or a
  sidecar: `JSON.parse` keeps only the last value, so an earlier one (a live
  wallet, a venue cursor) would sit in the committed bytes and escape every
  check above.
- No credential-shaped value anywhere; `authenticated` is exactly `false`;
  the URL is on a public Polymarket host (documentation, Gamma, CLOB, Data
  API, the market channel); a CLOB URL is one of the public market reads the
  report observed (F-76, O.3), not an order, trade or balance route; and no
  Data API URL is keyed by a wallet (`user`, `address`, `proxy_wallet`,
  `wallet`).

**One walk over every file** (round 7, V2-9-R7-01, -02 and -03; the
orchestrator's 2026-10-08 directive). The rules above name fields, and each
review round found a field they missed: an envelope or example property, a
repeated key, an invalid byte, a source URL. So every file in this tree but a
`README.md` (capture, sidecar, fixture and example alike) also goes through one
generic walk (`apps/ops-cli/src/verify-venue/tree-scan.ts`), and no field is
exempt by name:

- **A strict read.** UTF-8 with no invalid byte, and RFC 8259 JSON (one
  document, or one per `.jsonl` line) with no comment, no trailing comma, no
  byte-order mark, no repeated key and no lone surrogate. A failure fails the
  gate, by name. `loadFixture` reads a fixture the same way.
- **Every key and every string, at any depth**, in every reading the scanner
  decodes (as written, NFKC-normalized and each percent-decoded layer); a
  string that is itself JSON text (a WebSocket frame, Gamma's `outcomes`) is
  also parsed strictly and walked; every URL in a string must parse, and its
  user information, host, path, each query name and value, and fragment are
  read and scanned one by one. Each answers to every rule: an email address;
  a `0x` 40-hex address; a hash (`0x` and more than 40 hex digits, or 40 or
  more bare hex digits with a letter); a token that decodes to a venue
  cursor; a personal field written with a value. Each object answers to the
  personal-key, person's-row and credential rules, and may not itself be
  shaped as a venue cursor. Labelled synthetic values pass.
- **The only exceptions** are explicit: `scan-allowlist.ts` lists each
  (file, JSON path, exact value) the rules refuse but the tree may hold, with
  its rule, a report id that the report defines (the gate checks it) and a
  reason. Today: public market condition and question ids, book hashes, raw
  and capture digests, the pinned SDK commit, documented contract addresses,
  the two public `prices_history` cursors, one market's resolution
  transaction, the trade sidecars' redaction subjects and one documentation
  type annotation. A value moved to another path, another value at a listed
  path, and a listed value no longer there (stale) each fail the gate. A
  package that commits a new public value adds its entry, with its source.
- **Closed envelopes.** A fixture's envelope holds exactly `fixture`,
  `source`, `retrieved`, `sanitized`, `notes` and `examples`, and an example
  exactly `name` and `payload` (a sidecar's keys were already closed).
- **Every raw mailbox, and JSON text that parses** (round 8, V2-9-R8-01 and
  -02). The email rule reads every raw mailbox spelling a paste can carry:
  a local part in any script (`josé@…`, RFC 6531), a quoted one
  (`"Jane Doe"@…`, RFC 5321), one followed by a comment (`jane(work)@…`),
  and a domain in any script, an IDNA A-label or an address literal
  (`…@[192.0.2.1]`). JSON text opens wherever a string starts with `{` or
  `[`, and wherever a `{` precedes a key or a `[` precedes a string, an
  object or an array; each must parse strictly as one JSON value from there,
  or the gate fails by name (a truncated value, a trailing comma, a repeated
  key). It is never read as prose instead. That holds in every reading, and
  in every URL part. A JSON text quoted in prose is walked like a whole one.

**What the gate cannot check.** These are not machine-detectable:

- a person's name written as plain prose with no field label ("traded by
  Jane Doe");
- a personal value encoded (base64, for example), other than a venue cursor;
- a venue cursor split across tokens or otherwise transformed (reversed,
  chunked, encrypted);
- in a trade or activity page or URL, a hash split into runs of fewer than
  20 digits (across fields, list items or a free text), or re-encoded other
  than in hex or decimal (in base64, for example);
- a personal key glued to a label by a letter or a digit
  (`maker1wallet: …`): it reads as another word, as `filename:` does;
- a hash written in decimal digits alone: the walk reads a run of decimal
  digits as an id or a number (token and position ids are decimal), so only
  the trade-page rules above refuse a long one (round 7; until round 7 a
  whole-value hex id in a fixture payload was not judged either, and now it
  is, by path);
- an email address deliberately disguised ("jane at example dot com",
  spaces around the `@`, an address with no dot in its domain such as
  `jane@localhost`) (round 8: per the 2026-10-08 ruling, not a raw paste);
- a personal value hidden by a deliberate re-encoding other than
  percent-encoding (round 5: per the 2026-10-08 ruling, such a bypass is a
  follow-up, not a gap of this gate);
- outside the Data API, a name under a generic key (`name`, `title`) of an
  object with no personal key: Gamma's `name` is market metadata;
- an address without its `0x` written in decimal digits alone (round 7: with
  a hex letter, it is a bare 40-hex run, which the walk refuses as a hash
  unless listed; the market channel's book `hash` is one, listed by path).

So the capture author writes personal values in a sidecar only as labelled
synthetic values or `<placeholders>`, and the reviewer of a new capture reads
the capture's keys and its sidecar prose.

**Not covered.** Every other fixture in this tree keeps the rules above. The
V2 Router fixture (`positions/router-v2.json`) needs no exception: its ids
are the documentation's own, and its synthetic values are labelled. A new
live capture needs a sidecar and a catalogue entry in
`apps/ops-cli/src/verify-venue/checks.ts` (`PROTOCOL_V2_CAPTURES`). An
unclaimed file fails the gate, whatever its suffix.

**The rest of V2-9 in this tree:**

- `verify-venue` now claims every file here except a `README.md`, whatever
  its suffix. `protocol-v2/` is under the gate with its `.jsonc` and `.jsonl`
  names. No `.jsonc` held a comment, so nothing moved into a sidecar and no
  digest changed. The rename to `.json` is deferred: the readers outside
  V2-9's paths open the files by name (`protocol-v2/README.md`).
- `market-ws/book-snapshot-v2.json` is the V2 `book` frame, with its
  `version` (plan row D8).
- `positions/router-v2.json` holds the V2 Router and PositionManager
  operations (plan row D7, the V2 half).
- The notes of `heartbeat/heartbeat.json` now cite C-20. Its examples are
  unchanged.
