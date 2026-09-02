# Replay-golden fixtures — `packages/order-book` (WP-150)

Consumed by `test/unit/order-book/replay-golden.test.ts` (workplan WP-150
acceptance 1: "Fixture replay reconstructs the expected book byte-for-byte").

## Provenance

No live venue connection was made, by this package or for these fixtures.
Every venue-shaped value traces to a frozen, dated documentary source:

| Material | Source |
| --- | --- |
| The YES-token `BookSnapshot` payload (prices `0.07`/`0.08` bids, `0.09`/`0.1` asks, sizes, the 64-hex `venueBookHash`, the 78-digit token id, the venue timestamp `1782753357257`) | `test/fixtures/venue/market-ws/book-snapshot.json` (frozen WP-000 catalogue, retrieved 2026-08-24 from the official market-channel page) |
| The `BookLevelChanged` "level updated" step (`BUY → BID`, price `0.08`, size `33343.4`) | `test/fixtures/venue/market-ws/price-change.json`, example `level-updated`; side mapping `BUY → BID` per ADR-014 §3 / the shipped `WP-070` normalizer |
| The `BookLevelChanged` zero-removal step (price `0.08`, size `"0"`) | `test/fixtures/venue/market-ws/price-change.json`, example `level-removed-absolute-zero-UNVERIFIED` — the semantics are since CONFIRMED and ratified (ADR-013; re-verified documentarily in `docs/venue/verified-2026-09-02.md` §2). The frozen fixture keeps its historical name per ADR-013 Consequences |
| The replace-not-accumulate step (price `0.07`: size `5000` → `5`) | ADR-013 §2, verbatim template: "for a level at size `120` receiving a `price_change` with `size: 5`, the resulting level size is `5`, never `125` and never `115`" — instantiated on the frozen snapshot's own price grid |
| The tick-size step (`0.01 → 0.001`) | `test/fixtures/venue/market-ws/tick-size-change.json` (frozen WP-000 catalogue) |
| Venue timestamps rendered as ISO-8601 (`1782753357257` → `2026-06-29T17:15:57.257Z`) | deterministic epoch-milliseconds conversion; the envelope's `venueTimestamp` is ISO-8601 by §7.1 |

## Synthetic values, declared

These are repository-assigned by design, not venue facts, and inventing them
is therefore legitimate:

- `internalMarketId`, `gatewayEpoch`, `ingestSeq`, `subscriptionGeneration`,
  `receivedAt` — assigned in-process by the catalogue/gateway (§7.1, §7.2);
  no venue ever supplies them.
- The NO-token id and the NO book's levels are **synthetic**: the frozen
  WP-000 catalogue froze exactly one `asset_id`, and no venue document in the
  repository records a sibling outcome-token book. The NO side exists in the
  fixture to exercise §9.4's "independent books for both outcome tokens"
  routing; its values assert nothing about the venue. Token-id shape follows
  ADR-016 §1 (canonical unsigned integer string).

## Format

`replay-two-token-books.json`:

- `market` — the `MarketOutcomeBooks` constructor arguments;
- `steps[]` — applied in array order (internal ingest order, §9.4): `kind` is
  `snapshot` | `levelChange` (each with `meta` + domain-shaped `payload`) or
  `tickSize`;
- `expected.yesSerialization` / `expected.noSerialization` — the expected
  `serializeBook` output as an array of lines, joined with `\n` and compared
  **byte-for-byte** (`polymarket-bot/order-book/v1` format).

The expected serializations were computed by hand from the step semantics
(ADR-013) and are the acceptance oracle; they must never be regenerated from
the implementation's own output without re-deriving them.
