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
public contract addresses, observed prices, book sizes and times, public
venue metadata as served (for example Gamma's numeric `createdBy` and
`updatedBy` record ids), and the bodies of public, unauthenticated GETs and of
the public market channel.

**Still replaced, and enforced by `verify-venue`, in every capture:**

- anything that identifies a person or an account: wallets (`proxy_wallet`),
  names, pseudonyms, bios and profile images;
- in a Data API trade or activity row: the wallet, name, pseudonym and
  transaction hash, each with a labelled synthetic value (`synthetic-…`, or
  `0x` and zeros and at most eight significant hex digits). The trade size and
  block timestamp are replaced too;
- a trade or activity feed cursor, in the page or in the sidecar URL. Such a
  cursor carries the seek anchor of the last row (S-O06) and re-fetches the
  unredacted page. It must be a labelled synthetic value (`synthetic-cursor-…`),
  and one that decodes to a venue cursor is refused;
- a sidecar of a trade or activity page with rows or a cursor must list
  `timestamp` and `next_cursor` among its redactions;
- no credential-shaped value anywhere; `authenticated` is exactly `false`;
  the URL is on a public Polymarket host (documentation, Gamma, CLOB, Data
  API, the market channel); a CLOB URL is one of the public market reads the
  report observed (F-76, O.3), not an order, trade or balance route; and no
  Data API URL is keyed by a wallet (`user`, `address`, `proxy_wallet`,
  `wallet`).

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
