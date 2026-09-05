# Replay-golden fixture — `packages/simulation` (WP-210)

Consumed by `test/unit/simulation/golden-replay.test.ts`. Handoff §12.4: "CI runs
a small golden replay on every change to core contracts", and work-plan `WP-210`
acceptance 2: "Same manifest/config/seed is byte-identical."

## What it pins

`golden-replay.json` carries four things:

| Key | What it is |
| --- | --- |
| `manifest` | A `polymarket-bot/dataset-manifest/v1` document in `WP-130`'s exact shape and key order |
| `rows` | The decoded dataset rows (`WP-130` `DecodedDatasetRow`) the manifest's one object contains |
| `runPins` | The complete §12.5 run-scoped pin set (§12.5's normalizer, feature-set, seed, fill/latency model, fee/reward snapshot, settlement-spec versions, plus the simulator version) |
| `expected.serialization` | The `polymarket-bot/simulation-run/v3` canonical form, line by line, compared **byte-for-byte** |

## Provenance

**No live venue connection was made, by this package or for these fixtures.**

| Material | Source |
| --- | --- |
| The `book` frame's price grid (`0.07` bid, `0.09` ask), the 78-digit `asset_id`, and the venue timestamp `1782753357257` | `test/fixtures/venue/market-ws/book-snapshot.json` (frozen `WP-000` catalogue, retrieved 2026-08-24 from the official market-channel page) |
| The `price_change` frame's shape (`price` `0.08`, `size` `33343.4`, `side: "BUY"`) | `test/fixtures/venue/market-ws/price-change.json`, example `level-updated`; the absolute-size semantics are ADR-013 |
| The `last_trade_price` frame's shape | `test/fixtures/venue/market-ws/` (frozen catalogue); the values are illustrative and assert nothing about any real trade |
| `2026-06-29T17:15:57.257Z` ISO renderings | deterministic epoch-milliseconds conversion of the frozen venue timestamp |

## Synthetic values, declared

Repository-assigned by design, so inventing them is legitimate — no venue ever
supplies them (§7.1, §7.2):

- `gatewayEpoch`, `ingestSeq`, `receivedAt`, `receivedMonotonicNs`,
  `connectionId`, `subscriptionGeneration`, `segmentId`, `datasetId`,
  `objectKey`, and every dataset row ordinal.
- The `segmentSha256` / `segmentFileSha256` / `frameLineSha256` digests are real
  SHA-256 values over declared literal strings (`"golden-segment-span"`,
  `"golden-segment-file"`, `"golden-line:<n>"`), so they are checkable, and they
  assert nothing about any recorded segment.
- `payloadSha256` and the object's `sha256`/`byteLength` are real digests of the
  fixture's own bytes: the event source RE-DERIVES both and refuses a mismatch,
  so a wrong value here fails the suite rather than passing silently.

## The ordering the fixture exists to exercise

The three frames disagree between DISPATCH order and VENUE-TIMESTAMP order, on
purpose:

| dispatch ordinal | `ingestSeq` | venue `timestamp` | `receivedAt` |
| --- | --- | --- | --- |
| 0 | `1` | `1782753357257` | `…57.300Z` |
| 1 | `4` | `1782753357000` | `…57.100Z` |
| 2 | `9` | `1782753357500` | `…57.500Z` |

Sorting by venue timestamp gives `(4, 1, 9)`; the recorded dispatch order is
`(1, 4, 9)`. §8.4 requires the second, and the golden bytes would change if the
implementation ever produced the first. The wall clock also steps backwards
between ordinals 0 and 1, which is why BOTH diagnostics appear in the pinned
output — `venueTimestampInversions=1` on the `delivery` line (the normalized
envelopes' venue timestamps) and `receivedAtInversions=1` on the `counts` line
(the recorded arrival wall clock), plus `wallClockRegressions=1` from the clock.
All three are OBSERVED and reported, and none reorders anything.

The `ingestSeq` values are non-contiguous (`1`, `4`, `9`) on purpose too: one
gateway counter serves raw frames AND normalized events (`WP-120`), so raw
frames alone are never contiguous, and a replay that required contiguity would
refuse every real dataset.

## What the golden RUN does (regenerated, round-1 review)

The first version of this fixture drove **no venue and no core loop**, so its
pinned bytes carried zero orders, zero fills and zero economics — §12.4's
byte-identity list ("simulated order events, fills, …") was unexercised by the
very test that exists to guard it. The run now drives a **Tier-1** simulated
venue through the §12.1 seam:

| At | What the core loop does | Why the outcome is what it is |
| --- | --- | --- |
| ordinal 0 (`book`, `ingestSeq` 1) | submits `golden-plan-1` with two orders | the recorded book is bid `0.07 × 100`, ask `0.09 × 60` |
| — `golden-order-take` | `MARKETABLE_LIMIT` BUY, limit `0.09`, 10 shares | crosses the `0.09` ask, so it TAKES: one fill, 10 @ `0.09` |
| — `golden-order-rest` | `REST` BUY, limit `0.08`, 50 shares, `postOnly` | inside the spread, so it RESTS; a `postOnly` order that does not cross is not rejected (venue report §2.3) |
| ordinal 1 (`last_trade_price`, `ingestSeq` 4) | reports the recorded trade (`0.08 × 5`) to the venue | the resting order is AT `0.08` and nothing is queued ahead of it there, so all 5 shares reach it |
| ordinal 2 (`price_change`, `ingestSeq` 9) | nothing | a book update is not a trade |

Two model choices keep the run hand-derivable and seed-stable: every latency
distribution has ONE sample at 0 ms (so the sampled latency is 0 whatever the
seed draws — the seed still matters and is still pinned), and the fee snapshot is
the frozen 2026-08-24 one (taker `0.07`, maker `0`, 5 decimal places, `HALF_UP`).

A **Tier-1 resting order books no point-precise fill**: ADR-012 §1 makes its
estimate the optimistic/base/conservative BAND, so the order line carries
`fillEstimateKind=TIER_1_RESTING_BAND` and `filledShares=0`, and the `band` line
carries the estimate. The `fillModelVersion` pin is `sim/tier1/v1` because that
is the model that ran (§12.5).

## How `expected.serialization` was derived

**By hand, from `serializeRun`'s published grammar and this fixture's own
declared values — not captured from a run.** The derivation, line by line:

1. `polymarket-bot/simulation-run/v3` — the format id constant.
2. `run …` — the five §12.5 model pins, verbatim from `runPins`.
3. `pins …` — the four remaining §12.5 pins; `settlement=` is empty because the
   fixture pins no settlement-spec version.
4. `dataset …` — `datasetId` and the single `gatewayEpochs[0]` from the manifest;
   `objects=1`; `walSegments=NOT_AVAILABLE_ARCHIVED_ONLY` because the test
   supplies no WAL-segment reader, and the source says so rather than implying a
   check happened.
5. `counts …` — `read` and `delivered` from the manifest's own `recordCounts`;
   `receivedAtInversions=1` from the arrival column of the table above
   (`…57.300Z`, then `…57.100Z`, compared on epoch milliseconds).
6. `delivery …` — `envelopes=3` (the normalizer emits one per frame);
   `venueTimestampInversions=1` from the venue-timestamp column
   (`…357257`, then `…357000`); `withoutVenueTimestamp=0` because every frame
   carries one.
7. `clock …` — `start`/`startNs` from row 0 and `end`/`endNs` from row 2, because
   the clock is positioned at the first record and advanced by every one;
   `advances=3` (one per delivered record) and `wallClockRegressions=1`.
8. `order …` ×2 — ordered by `simulatedOrderId`, so `golden-order-rest` precedes
   `golden-order-take`. Fields in `serializeRun`'s fixed order: plan id, market,
   the book's `tokenId`, side, action, limit, requested, filled, state, style,
   fill-estimate kind, `postOnly`, and the recorded event identity the state was
   reached at — ordinal 0, because both orders were booked against the recorded
   `book` frame.
9. `fill …` — one taker fill: `10 @ 0.09`. The fee is the ADR-012 §5.4 formula on
   the frozen snapshot: `10 × 0.07 × 0.09 × (1 − 0.09) = 0.05733`, already exact
   at 5 decimal places, so the rounding mode does not bite. Its id is
   `<orderId>/t1/<level index>`.
10. `economics …` — folded from that one fill: `buy = 0.09 × 10 = 0.9`,
    `sell = 0`, `fees = 0.05733`, `net = 0 − 0.9 − 0.05733 = −0.95733`,
    `sharesBought = 10`, `fills = 1`. `markoutPenaltyApplied=false` is a literal
    (§12.3). The resting order contributes NOTHING here: a band is not cash.
11. `band …` — the resting order's estimate. `sameInstantAdditions=NOT_OBSERVED`
    because `GOLDEN_POLICY` answers `"NOT_OBSERVED"`: the fixture carries ONE
    recorded book snapshot and no record of what was added at `0.08` in the
    instant the order was placed, so the run did not look, and
    `renderSameInstantAdditions` prints the tag verbatim. (A root that had looked
    and seen nothing would print `OBSERVED:0` — different bytes, because it is a
    different fact; round-2 review L4.) Queue ahead at placement is the aggregate
    size observed at `0.08`, which is `0` (the recorded book's only bid is at
    `0.07`), and an unobserved same-instant addition adds nothing to it, so the
    observed trade's 5 shares reach the order in every scenario:
    `filled=5 remaining=45` three times, `postCancelFills=0` because no cancel
    was requested. The three scenarios agreeing here is a property of THIS book,
    not a general one.
12. `end`.

### What moved in round 2, and why

Only two things: the format id (`v2` → `v3`, because the `band` line's grammar
changed) and the new `sameInstantAdditions=` field on the `band` line. Every
other byte is unchanged, and the derivations above are the same ones — the
conservative arm's queue ahead was `0 + 0` before and is `0 + (nothing observed)`
now, so no quantity moved.

If a change moves these bytes, re-derive them the same way; do not paste the new
output. The suite additionally asserts that the replay is reproducible and that
a one-character change to a recorded payload is REFUSED, so the golden is not
merely a snapshot of whatever the code does.
