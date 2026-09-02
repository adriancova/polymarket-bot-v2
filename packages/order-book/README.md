# `@polymarket-bot/order-book` — local exact-decimal order books (WP-150)

Handoff §9.4. A pure layer-1 state-machine library: domain book events in,
queries and typed refusals out. No connection, no clock read, no I/O, no
credential surface. Dependencies: `@polymarket-bot/domain`,
`@polymarket-bot/decimal` (both layer 0).

## Semantics, each with its authority

| Behavior | Authority |
| --- | --- |
| Independent books per outcome token; a payload for another token/market is `ORDER_BOOK_IDENTITY_MISMATCH`; the two books of a market are never derived from each other | §9.4; `MarketOutcomeBooks` routes by the payload's own `tokenId` |
| `BookLevelChanged.size` is the absolute resulting size; REPLACE, never accumulate; `"0"` removes the level; removing an absent level is an applied no-op | ADR-013 §1–§2 (ratified venue fact, re-verified documentarily 2026-09-02 — `docs/venue/verified-2026-09-02.md` §2) |
| All prices/sizes are canonical decimal strings; `"0.10"` is refused (`ORDER_BOOK_INPUT_INVALID` via the frozen contracts), never normalized here | §7.3 / ADR-001 §3 — adapters own normalization; the boundary never coerces |
| Freshness identity is `(gatewayEpoch, subscriptionGeneration)`, adopted from the last applied snapshot. Older generation → `ORDER_BOOK_STALE_SUBSCRIPTION_GENERATION` (carries both generations). Newer generation on a delta → `ORDER_BOOK_GENERATION_AHEAD_REQUIRES_SNAPSHOT`. Missing generation → `ORDER_BOOK_MISSING_SUBSCRIPTION_GENERATION` | §9.4 (stale rejection); §7.1 (gap ⇒ authoritative snapshot); `WP-070` feed semantics, ONE-WAY: every opened gap advances the generation, but the generation also advances where no gap is owed (first connection; changes made while disconnected); generations are strictly increasing from 1, never `0` on an event; WS events are always stamped, REST snapshots only when the fetcher's caller supplies the generation |
| A delta from a different `gatewayEpoch` → `ORDER_BOOK_EPOCH_MISMATCH`; only a snapshot moves the book to a new epoch | `wal-format.md` §12.1 — epochs are identity, not chronology |
| Within one epoch `ingestSeq` must strictly increase → `ORDER_BOOK_OUT_OF_ORDER_INGEST`; no venue sequence number is invented anywhere | §7.1, §9.4 closing rule |
| Tracked: best bid/ask, exact spread, depth (level counts + exact share sums), venue-provided book hash, last update, staleness vs a caller-supplied now | §9.4 |
| `executablePrice` walks the book volume-weighted; a short book is a typed `ORDER_BOOK_INSUFFICIENT_DEPTH` carrying requested and available shares, never a partial answer; VWAP division policy is `divDecimal`'s documented default, overridable per call | §9.4; ADR-001 §3.3 |
| `compareAgainstRestSnapshot` canonicalizes both snapshot sides order-independently and compares canonical forms byte-exactly, returning named divergences | §9.4; `docs/venue/verified-2026-09-02.md` §6 — the venue's two sources publish OPPOSITE orders for both sides, so no order is assumed |
| WS-tracked and REST-supplied hashes are reported side by side, never judged equal or unequal across surfaces | no official source states the two surfaces share a hash algorithm; the REST hash is documented for comparison between successive REST reads (`WP-070` `known_risks` 3) |
| A tick-size VALUE change advances the tick epoch and invalidates every issued `PriceGrid` (`ORDER_BOOK_PRICE_HELPER_INVALIDATED`, carrying both tick sizes); an identical restatement does not invalidate | §9.4; workplan acceptance 3 |
| A UUID-shaped `gatewayEpoch` in non-canonical case is refused with the raw value, never case-folded | ADR-016 §2 (2026-09-02 amendment) |

## Decisions where the venue or spec is silent (all fail-closed, recorded)

1. **A zero-size snapshot level is dropped, not stored and not refused.**
   Under ADR-013 a zero size asserts absence; storing it would corrupt depth
   and best-price. Same reading as the `WP-140` recorder comparison job.
2. **A duplicate price within one snapshot side refuses the whole snapshot**
   (`ORDER_BOOK_DUPLICATE_SNAPSHOT_LEVEL`): depth at that price is ambiguous
   and half-applying a snapshot would leave an unattributable state.
3. **A generation-less snapshot is refused** rather than adopted. This is
   not hypothetical: the generic REST fetcher stamps a snapshot only when
   its caller supplies the generation
   (`polymarket-public/src/snapshot/fetcher.ts` — the
   `subscriptionGeneration` context field is optional, and the normalizer
   omits it from provenance when absent), so unstamped snapshots are
   producible today. The `WP-120` composition root must stamp gap-closing
   snapshots via the fetcher context, or `applySnapshot` refuses them
   (typed, visible). A periodic validation snapshot is fed to
   `compareAgainstRestSnapshot`, which needs no generation, not to
   `applySnapshot`.
4. **`BestBidAskChanged` is not consumed.** Top-of-book is derived from the
   reconstructed levels only; consuming a second top-of-book source would
   create two contradictory histories (the same reasoning as `WP-070`
   deviation 4).
5. **A crossed book is representable.** If venue data produces one, the book
   reports what the venue asserted (`spread` may be negative); inventing a
   repair would falsify venue state.

## What this package deliberately does not do

- No HTTP, no WebSocket, no filesystem: the REST-snapshot check is a pure
  function fed by the caller.
- No envelope parsing or event routing beyond the two book payloads plus the
  tick-size input: the gateway/trader owns dispatch.
- No order handling: §9.4's "invalidate or reprice affected orders" is
  realized here as the price-helper invalidation; orders are the OMS's.
