# Feature set v1 — `polymarket-bot/features/v1`

Owner: `WP-160` (`packages/features`)
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §9.5 (the v1
feature list is the deliverable's contract), §7.3 (exact decimals), §6
invariants 9 and 15; `docs/spec/polymarket-bot-workplan.yaml` `WP-160`.
Related: [`dependency-direction.md`](./dependency-direction.md) (layer 1; the
enumerated same-layer edge list), the WP-150 completion record's carried
follow-ups (`IMPLEMENTATION_STATUS.md`), and the recorded cross-package schema
risk ("a schema parse output is not clean data", 2026-09-03).

This document is the NORMATIVE contract for feature set v1: what each feature
means, which inputs it reads, the numeric policies, the input grammar, the
snapshot serialization, and the versioning rules. The implementation and its
tests conform to this text; a semantic change here requires the version bumps
of §8.

---

## 1. Shape of the engine

One call — `computeFeatureSnapshot(input)` — computes the whole v1 set once
for one event and returns either an immutable, content-addressed
`FeatureSnapshot` or a typed refusal. The engine is:

- **Pure and total.** No I/O beyond `node:crypto`'s synchronous SHA-256, no
  clock, no randomness, no network. Every failure is a typed refusal; nothing
  throws.
- **Deterministic.** The same input VALUE produces a byte-identical canonical
  serialization and an identical content address, regardless of object key
  insertion order, ambient system time, or prototype pollution.
- **Registry-bound.** The computed id set must EQUAL the registry's
  (`FEATURES_V1`); a registered-but-uncomputed or computed-but-unregistered
  feature refuses the whole snapshot (`FEATURES_INTERNAL`).

Every feature answer is `{status: "OK", value}` or
`{status: "ABSENT", reason, detail?}` with a typed `AbsenceReason`. Absence is
an answer, never `null` and never a fabricated zero (§4).

## 2. Inputs

The caller (a composition root; later work packages) assembles one input
record per evaluated event. All timestamps are event timestamps; `asOf` is
the evaluation instant taken from the triggering event, never from a clock.

| Section | Required | Content |
| --- | --- | --- |
| `subject` | yes | `internalMarketId` (lowercase UUIDv7), `tokenId` (canonical unsigned integer string) — §7.2 grammars |
| `asOf` | yes | strict-UTC timestamp (§6) |
| `trigger` | yes | `gatewayEpoch` (lowercase UUID), `ingestSeq` (unsigned bigint string ≤ 40), optional `eventId` (UUIDv7) — §7.1 provenance for invariant-4 traceability |
| `config` | yes | §3. NO DEFAULTS EXIST; every field is explicit |
| `book` | yes | `serializedBook` — the EXACT `serializeBook` v1 text (§5) — plus `lastEventAt` |
| `trades` | no | `lastEventAt` + ascending window of `{price, size, takerSide?, observedAt}` (ADR-014 taker-side vocabulary) |
| `reference.binance` / `.coinbase` | no | `symbol`, `lastEventAt`, ascending `trades: {price, observedAt}[]`, optional `topOfBook {bidPrice?, bidSize?, askPrice?, askSize?}` |
| `reference.chainlink` | no | `lastEventAt` + `twaps: {feedId, value, windowSeconds, windowEndAt}[]` (duplicates of `(feedId, windowSeconds, windowEndAt)` refused) |
| `lifecycle` | no | `openedAt?`, `closesAt?` (close before open refused), `referenceOpenPrice?` |
| `quality` | yes | `activeIncidents: {incidentId, reasonCode, severity, feedId?}[]` (severity = §14.4 `LOG`/`NOTIFY`/`PAGE`; duplicate ids refused) |

Structure is STRICT (unknown keys refuse), economic values are canonical
decimal strings only (§7.3 — a JavaScript `number` refuses), and every
VALUE-BEARING observation (`observedAt`, `windowEndAt`) must be at or before
`asOf` — features never consume information from the future (§6 invariant
15). Feed `lastEventAt` stamps are diagnostic and may sit after `asOf`; the
resulting age is negative and reported as-is (the order-book never-clamp
rule).

### 2.1 The boundary discipline (recorded schema risk)

The engine runs NO schema library. The caller's value is first materialized
into a fresh prototype-free tree (descriptor reads only — no getter is ever
invoked; `__proto__` names, symbol keys, accessors, non-plain prototypes,
cycles, sparse arrays and depth > 32 refuse with the path), and every
validation and computation reads ONLY that tree. The validated internal model
and every computed outcome are themselves prototype-free, so an absent
optional field can never be answered by a polluted `Object.prototype` —
adoption, loss, defeated defaults, and the inherited format-check kill switch
are all structurally unreachable, and the package's hostile battery pins each
class. Grammar mirrors (UUID, token, code, severity) are bound to the frozen
domain schemas by cross-test, not by runtime import.

## 3. Configuration (explicit, versioned into the address)

| Field | Meaning | Constraints |
| --- | --- | --- |
| `depthLevels` | the "configured levels" of `polymarket.depth_at_levels` | 1–16 strictly ascending positive integers ≤ 1000 |
| `executableShares` | quantities for the executable buy/sell prices | 1–16 strictly ascending positive canonical decimals |
| `tradeWindowMs` | the `recent_trades` window length | positive integer ≤ 86,400,000 |
| `ewmaLambda` | EWMA decay for realized volatility | canonical decimal strictly in (0, 1) |
| `primaryReferenceVenue` | venue used by `lifecycle.reference_open_distance` | `"binance"` or `"coinbase"` |

The whole config is embedded in the snapshot body, so two configs can never
share a content address.

## 4. Numeric policies

- **Division policy (the WP-150 carried follow-up: CHOSEN and documented).**
  Every inexact division uses 34 significant digits, ROUND_HALF_EVEN — the
  `@polymarket-bot/decimal` documented default, invoked through the default
  path and PINNED BY TEST to those numbers. It is deliberately NOT
  per-call-overridable (unlike `executablePrice`'s `division` option): a
  feature value must be a pure function of `(inputs, id, version)`, and an
  override would give one feature id two values over one input. Changing the
  policy is a version bump (§8), never an option. The explicit-options path
  is additionally avoided because it clones a constructor per call, which
  throws under descriptor-poisoned prototypes (measured; see
  `decimal-policy.ts`).
- **Exact halving.** Midpoints divide by 2 exactly (`divDecimalExact`); a
  halving always terminates, so no information is discarded.
- **Quantization.** EWMA accumulation quantizes each step to the policy
  precision (division by one), bounding digit growth deterministically.
- **Deterministic square root.** Volatility uses a Newton iteration built
  from policy divisions and exact halvings, magnitude-aware seed, stop on a
  fixed point at policy precision, deterministic smaller-value tie rule on a
  rounding 2-cycle, refusal (never a loop) past 48 iterations.
- **Absent versus zero (the second WP-150 carried follow-up).**
  PRICE-DERIVED features (best bid/ask, midpoint, spread, VWAP, microprice)
  are ABSENT on an empty side — `0` is a legal price/size and never stands in
  for "no price exists". SUM-DERIVED features (depth shares, traded volumes)
  report `"0"` over an empty set, matching the order-book package's own
  `depth()`. The executable price against an empty or thin side is a typed
  per-quantity `INSUFFICIENT_DEPTH` outcome carrying `availableShares`, never
  a partial answer — the `executablePrice` refusal semantics restated.

## 5. Book state: one canonical serialization

Book state enters as the EXACT text of WP-150's `serializeBook`
(`polymarket-bot/order-book/v1`). The engine parses it fail-closed (unknown
version line, structural deviation, self-contradiction between the summary
lines and the ladders, and a §7.1-unbaselined book all refuse — a crossed
book is read faithfully, mirroring order-book semantics) and content-addresses
the text verbatim (`inputs.bookSha256` = plain SHA-256 of the text). No
second canonical serialization of book state exists in this package; the
reader is bound to the real writer by a cross-test driving live
`OutcomeTokenBook` instances, so WP-210's reuse of `serializeBook` and this
engine consume one format.

## 6. Timestamps and event time

The v1 grammar is the strict UTC subset of the domain ISO grammar:
`YYYY-MM-DDTHH:MM:SS[.mmm]Z` — `Z` only (one instant, one spelling, one
address), at most millisecond precision (sub-millisecond digits would
truncate silently), real calendar dates (Gregorian leap rule; years ≥ 1583),
leap seconds refused. Conversion to epoch milliseconds is pure integer
calendar arithmetic (days-from-civil); the package contains no `Date` surface
at all. The composition root normalizes venue offsets upstream; a non-`Z`
timestamp refuses rather than converts.

## 7. The v1 registry (33 features)

Sorted registry order; every definition is version 1. `LVCF` = latest value
at or before the instant (last value carried forward; nothing interpolates).

### Polymarket (10)

| id | value | absent when |
| --- | --- | --- |
| `polymarket.best_bid` | `{price, size}` | `EMPTY_BID_SIDE` |
| `polymarket.best_ask` | `{price, size}` | `EMPTY_ASK_SIDE` |
| `polymarket.midpoint` | `(bestBid + bestAsk) / 2`, exact | either side empty |
| `polymarket.spread` | `bestAsk − bestBid`, exact (negative if crossed) | either side empty |
| `polymarket.depth_at_levels` | per configured N: `{levels, bidShares, bidLevelCount, askShares, askLevelCount}` (exact sums over the top N; `"0"` on an empty side) | never |
| `polymarket.executable_buy_price` | per configured quantity, walking asks best-first: `{requestedShares, outcome: "QUOTE", volumeWeightedAveragePrice, totalCost, worstPrice, levelsConsumed}` or `{…, outcome: "INSUFFICIENT_DEPTH", availableShares}` | never (insufficiency is typed per quantity) |
| `polymarket.executable_sell_price` | same, walking bids | never |
| `polymarket.order_book_imbalance` | `bidShares / (bidShares + askShares)`, policy division | `EMPTY_BOOK` |
| `polymarket.microprice` | `(bidPrice·askSize + askPrice·bidSize) / (bidSize + askSize)`, policy division | either side empty |
| `polymarket.recent_trades` | over the half-open window `(asOf − tradeWindowMs, asOf]`: `{windowMs, tradeCount, buyVolume, sellVolume, unknownVolume, totalVolume, netSignedVolume, netDirection: BUY/SELL/FLAT, lastTradeSide: BID/ASK/UNKNOWN/NONE}` (ADR-014: `takerSide` names the aggressor's own side; absent `takerSide` accumulates as `unknownVolume`) | `INPUT_MISSING` |

### Reference (17)

| id | value | absent when |
| --- | --- | --- |
| `reference.{binance,coinbase}.return_{250ms,1s,5s,30s}` | `(p(asOf) − p(asOf − h)) / p(asOf − h)`, both endpoints LVCF over the venue trade series, policy division | `INPUT_MISSING` (no venue section) / `NO_PRICE_AT_HORIZON` (an endpoint has no price) |
| `reference.cross_venue.midpoint_difference` | binance mid − coinbase mid, mids = exact halvings of `topOfBook` bid+ask | `INPUT_MISSING` / `NO_TOP_OF_BOOK` |
| `reference.cross_venue.direction_agreement_{250ms,1s,5s,30s}` | `AGREE` (both returns nonzero, same sign), `DISAGREE` (nonzero, opposite), `NEUTRAL` (either exactly zero) | either return absent |
| `reference.{binance,coinbase}.ewma_realized_volatility` | `{volatility, variance, observations, lambda}`: simple returns over consecutive series points; `S₁ = r₁²`, `Sᵢ = λ·Sᵢ₋₁ + (1−λ)·rᵢ²` quantized per step; `volatility = √Sₙ` (§4) | `INPUT_MISSING` / `INSUFFICIENT_SERIES` (< 2 points) / `SQRT_UNAVAILABLE` (defensive) |
| `reference.chainlink.twap_{30s,60s}` | the supplied TWAP observation with `windowSeconds` 30/60 and the greatest `windowEndAt ≤ asOf` (ties: smallest `feedId`): `{feedId, value, windowSeconds, windowEndAt}` | `NOT_CONFIGURED` (no chainlink section — §9.5 "where configured") / `NO_TWAP_OBSERVATION` |

### Lifecycle (4)

| id | value | absent when |
| --- | --- | --- |
| `lifecycle.time_to_close_ms` | `closesAt − asOf` (integer ms; negative after close, as-is) | `INPUT_MISSING` |
| `lifecycle.time_since_open_ms` | `asOf − openedAt` | `INPUT_MISSING` |
| `lifecycle.market_duration_ms` | `closesAt − openedAt` | `INPUT_MISSING` |
| `lifecycle.reference_open_distance` | `{venue, referencePrice, referenceOpenPrice, distance}`: LVCF primary-venue price minus `referenceOpenPrice`, exact subtraction | `INPUT_MISSING` / `NO_REFERENCE_PRICE` |

### Quality (2) — workplan acceptance 2

| id | value | absent when |
| --- | --- | --- |
| `quality.input_feed_ages` | `{feedId, ageMs}` for EVERY input section supplied (`polymarket.book`, `polymarket.trades`, `reference.binance`, `reference.coinbase`, `reference.chainlink`), `ageMs = asOf − lastEventAt`, sorted by feedId, negative as-is. Derived from the sections actually present, so a feed that fed the computation cannot be missing from the staleness record | never (the book is always present) |
| `quality.active_incidents` | the supplied incident flags, sorted by `incidentId`; `[]` means none were supplied | never |

## 8. Snapshot, content address, and versioning

```text
body = {format, featureSet, subject, asOf, asOfEpochMs, trigger, config,
        inputs, features}
serialization = canonical JSON of body     (sorted keys, safe integers only,
                                            no null, absence = absent key)
contentAddress = SHA-256hex("polymarket-bot/feature-snapshot/v1:" + serialization)
```

- `inputs` carries `inputsSha256` (digest of the WHOLE validated input tree —
  two inputs can never share an address even if every derived value
  coincides), `bookSha256` + `bookSerializationVersion` + the book's
  provenance (`gatewayEpoch`, `subscriptionGeneration`, `lastIngestSeq`,
  `venueBookHash?`, `tickSize?`).
- The returned snapshot is deeply frozen and PROTOTYPE-FREE (absent fields
  stay absent for every consumer, under any pollution).
- Storage (§9.5): high-frequency snapshots archive `serialization` verbatim
  (`verifySnapshotSerialization` re-derives the address); important action
  decisions store `snapshotReference(snapshot)` plus
  `selectIndexedValues(snapshot, ids)` in PostgreSQL. The storage itself
  belongs to later work packages.

**Versioning rules (§6 invariant 9).** A semantic change to one feature bumps
that feature's `version` and this document. A change to the set's membership,
the serialization format, the address domain, the timestamp grammar, or the
division policy bumps the affected format id
(`polymarket-bot/features/v2`, `polymarket-bot/feature-snapshot/v2`). Old
addresses are never recomputed under new semantics; historical snapshots stay
valid under the version they name.

## 9. Refusal codes

`FEATURES_INPUT_NOT_DATA`, `FEATURES_INPUT_INVALID`,
`FEATURES_TIMESTAMP_INVALID`, `FEATURES_SUBJECT_MISMATCH`,
`FEATURES_BOOK_SERIALIZATION_UNSUPPORTED`,
`FEATURES_BOOK_SERIALIZATION_MALFORMED`,
`FEATURES_BOOK_SERIALIZATION_INCONSISTENT`, `FEATURES_BOOK_NOT_BASELINED`,
`FEATURES_INTERNAL` (fail-closed containment). Refusal `details` are always
fresh, frozen, prototype-free own data.

## 10. Dependency posture

`packages/features` is layer 1 and depends on exactly `@polymarket-bot/domain`
(type-only: the ADR-014 `BookSide` and §14.4 `IncidentSeverity` vocabularies)
and `@polymarket-bot/decimal` (arithmetic, canonical grammar). No
features → order-book edge exists — §2.1 of `dependency-direction.md`
enumerates none, and the check fails closed (F13) — which is WHY book state
crosses this boundary as the versioned `serializeBook` text (§5) and the
binding to the real writer is a cross-test, not an import. Adapters are
layer 2 (an edge would be F12); reference data therefore arrives as
normalized event-derived series, not via adapter imports.
