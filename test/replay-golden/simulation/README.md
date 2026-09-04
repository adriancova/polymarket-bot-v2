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
| `expected.serialization` | The `polymarket-bot/simulation-run/v1` canonical form, line by line, compared **byte-for-byte** |

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
between ordinals 0 and 1, which is why `venueTimestampInversions=1` and
`wallClockRegressions=1` appear in the pinned output — both are OBSERVED and
reported, and neither reorders anything.

The `ingestSeq` values are non-contiguous (`1`, `4`, `9`) on purpose too: one
gateway counter serves raw frames AND normalized events (`WP-120`), so raw
frames alone are never contiguous, and a replay that required contiguity would
refuse every real dataset.

## How `expected.serialization` was derived

**By hand, from `serializeRun`'s published grammar and this fixture's own
declared values — not captured from a run.** The derivation, line by line:

1. `polymarket-bot/simulation-run/v1` — the format id constant.
2. `run …` — the five §12.5 model pins, verbatim from `runPins`.
3. `pins …` — the four remaining §12.5 pins; `settlement=` is empty because the
   fixture pins no settlement-spec version.
4. `dataset …` — `datasetId` and the single `gatewayEpochs[0]` from the manifest;
   `objects=1`; `walSegments=NOT_AVAILABLE_ARCHIVED_ONLY` because the test
   supplies no WAL-segment reader, and the source says so rather than implying a
   check happened.
5. `counts …` — `read` and `delivered` from the manifest's own `recordCounts`;
   `venueTimestampInversions=1` from the table above.
6. `clock …` — `start`/`startNs` from row 0 and `end`/`endNs` from row 2, because
   the clock is positioned at the first record and advanced by every one;
   `advances=3` (one per delivered record) and `wallClockRegressions=1`.
7. `economics …` — all zero: this replay drives no core loop and no venue, so no
   order and no fill exist. `markoutPenaltyApplied=false` is a literal (§12.3).
8. `end`.

If a change moves these bytes, re-derive them the same way; do not paste the new
output. The suite additionally asserts that the replay is reproducible and that
a one-character change to a recorded payload is REFUSED, so the golden is not
merely a snapshot of whatever the code does.
