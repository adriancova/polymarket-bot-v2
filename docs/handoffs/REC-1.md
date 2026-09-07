# REC-1 completion record — Recorder-pipeline hardening

**Merged:** `327cae7` (`--no-ff`, 2026-09-06). Chain `85073d3` (candidate)
→ `76a62d6` (remediation r1, test-only) on base `5128d6c`. Review r1:
CHANGES REQUIRED (0 blockers; 4 MEDIUM — all regression-protection or
record-honesty gaps, no shipped-logic defect); remediation r1; confirming
pass by the same reviewer re-running its own mutants: **ACCEPT**.

**What it is.** GOV-2A §5 item 3 (subsuming WP-120-FU1's gateway items):
the four measured schema-boundary §3 recorder defeats closed with
**package-local own-property doors** — 4 new door modules
(binance/coinbase `wire-door.ts`, rtds `wire-door.ts`, gateway
`config-door.ts`), 4 boundary suites (50 tests after remediation), 4
modified consumers. No new dependency edge (check:deps 34/71 unchanged),
no manifest or lockfile change, no copy of the mirrored bodies (the
deletion guard's own matcher scores every new module 0/14).

## Door shape (each door's header states it)

- **D1** materialize prototype-free from own DESCRIPTORS before any parse.
- **D2 NOT performed, disclosed** — a severed warmed arena needs a
  forbidden edge or a forbidden copy. Compensation, measured: the three
  ADAPTER doors re-state the schemas' presence/bounds checks on their own
  reads (rows stay closed with every zod check disabled); the GATEWAY
  door's D2-independence covers the two authorized rows only (it restates
  nothing but the `.default()`s — named residual, see below).
- **D3** every emitted value from the materialized tree, never
  `parsed.data`. **D4** null-prototype emissions (pinned).
- Refusal construction contained (ADR-020 2026-09-06 amendment; proven
  load-bearing against sixteen hostile prototype shapes, now pinned in
  all four doors).

## The four rows, closed (reproduce-first, both variants)

1. **rtds:** inherited `type` no longer routes; the fabricated ECONOMIC
   value (`full_accuracy_value` → published `value:"999000"` at base) and
   invented `feedId` (from `topic`) are pinned closed, plus a seven-cell
   envelope/payload sweep.
2. **coinbase:** inherited `channel` no longer routes; neither can
   `sequence_num`/`timestamp` (recorded-frame keys) nor a market-trades
   `size` come from the prototype.
3. **binance (the sharpest row):** the §3 transcript reproduced
   byte-for-byte at base (CLEAN → MALFORMED; inherited non-enumerable `q`
   → `kind=TRADE quantityRaw="999999" unknownFields=[]` → normalized size
   AND the dedup fingerprint `64000.25|999999|1700000000000|false`);
   closed for ALL EIGHT declared trade keys, the bookTicker/
   serverShutdown/controlError shapes, and the wrapper `stream`.
   `unknownFields` still records genuine drift.
4. **gateway:** the get-only inherited `tickIntervalMs` `.default()`
   defeat (the `dataLossBoundMs` check silently passing) and the
   inherited feed-block adoption both refused; four defeated defaults and
   two further adoptable feed blocks found by audit and closed. The door
   applies the schema's defaults itself; the 13-entry `.default()` census
   (11 nested + the root `tickIntervalMs` + the `publisher` block —
   corrected from the round-1 figure of 12 in the docs round) is derived
   FROM the schema, so a new `.default()` without a table row fails
   (demonstrated live by adding one more).

**Honest-input preservation:** verdict digests at base (git-stashed real
base code) and tip over every fixture — adapters byte-identical under raw
serialization (reviewer-reproduced with an independent serializer:
binance 43 rows, coinbase 20, rtds 22); the gateway VALUE-identical under
a recursively key-sorted serialization (quote it that way — the raw byte
count is framing-dependent), with the emitted KEY-ORDER change disclosed
(inert today: no consumer enumerates or serializes the config —
reviewer-verified repo-wide). The coinbase emitted frame is a projection
onto the declared keys in schema order (restores byte-identity; the
stronger D3). An own `__proto__` key is now refused MALFORMED with raw
preserved (no honest fixture carries one; ADR-002 §7 house policy).

## Review arc

- **r1 (CHANGES REQUIRED):** shipped logic survived everything — all four
  base defeats independently reproduced with a different primitive and
  confirmed closed with zero prototype reads. The four MEDIUMs were the
  fence, not the door: an enumerable-copy materializer mutant reopened
  the binance row with 620/620 green (F1); deleting the containment
  killed zero tests (F2); the gateway key-order change was undisclosed
  (F3); the rtds suite pinned only the `type` cell (F4). Plus M9=7 not 6
  (F8) and the overbroad gateway re-statement claim (F5).
- **Remediation r1 (`76a62d6`, test-only, +16 tests):** kill-set flips —
  enumerable-copy 0→6 across the packages, containment-delete 0→4,
  null-proto 0/0/3→1/1/5, rtds D1-identity 1→4. All new pins fail at
  real base (21/35). The gateway F1 pin is on `readOwnConfig`'s own
  contract (argued and reviewer-confirmed: `strictObject`'s accidental
  unrecognized-keys refusal makes the end-to-end enumerable probe unable
  to kill the mutant); the rtds enumerable honest-frame refusal is a
  base-identical availability class (frozen contract payload).
- **Confirming pass: ACCEPT.** Every mutant re-run by its author; counts
  exact; non-vacuity proven; F3/F5/F8 corrections adjudicated accurate.
  Record notes honored here: the key-sorted identity is quoted without a
  portable byte count; M9 counts name their tip (7 at `85073d3`, 9 at
  `76a62d6` — the suite grew).

## NEWLY MEASURED, NOT CLOSED (review-verified verbatim, unchanged at tip)

`packages/polymarket-public`'s CLOB half (GOV-2A probed only rtds):
- `venue/market-events.ts:248` `parseMarketEvent` — under a
  non-enumerable inherited `event_type` THROWS
  `TypeError: propValues[key].add is not a function`, escaping a function
  documented to return `MarketEventParseResult` (clean-missing verdict:
  `{"status":"unrecognized"}`).
- `venue/order-book.ts:123` `parseVenueOrderBook` — `hash` deleted is
  refused clean; inherited `hash` parses with `hash:"INVENTED"`; same for
  `tick_size` → `"0.99"`, an economic parameter.

**Owner: a bounded grant on `packages/polymarket-public`'s CLOB doors**
(deliberately not expanded into here — not among the four authorized
rows, and the 583-test CLOB surface risks the frozen golden).

## Residuals (owned)

- **Gateway config door restates no format check** (F5): under inherited
  `skipChecks`, malformed `streamName`/negative `tickIntervalMs`/empty
  `internalMarketId`/malformed `feedId` accepted identically at base and
  tip (the two AUTHORIZED rows hold — `dataLossBoundMs` still throws).
  Under the ENUMERABLE variant, base fail-closed by `strictObject`
  accident, tip by the door's own-key copy — deliberate, but not a
  re-stated format check. Owner: a `config-door` follow-up (re-state the
  format-bearing checks or obtain D2).
- Coinbase nested per-channel `.min(1)` under `skipChecks` — base-
  identical; not reopenable into the authorized row (presence reads the
  same materialized tree). Owner: `coinbase-adapter/wire-door.ts`.
- Exotic own keys (Symbol, class instance, cycle, >16 depth, own
  accessor) now refuse fail-closed where base accepted — venue-
  unreachable (every door input is a `JSON.parse` result); the depth cap
  is a known drift-refusal. Owner: the three adapter doors.
- `ownControlId(payload) ?? null` conflates absent with present-but-
  malformed (pollution-only, control-frame correlation value). Owner:
  `binance-adapter/frames.ts`.
- 8 uncontained `.safeParse(` DOWNSTREAM of the doors (coinbase
  normalize/stream-processor, binance emission, rtds signals) — the same
  throw-under-pollution class one layer down. Owner: the follow-up F2's
  pin motivates.
- Coinbase/rtds have no door-level input byte cap (binance's 1 MiB is
  enforced before `JSON.parse`). Per-frame materialization cost is
  O(frame), unprofiled — profile on the recorder soak before any
  throughput claim (operator-owned soak; no claim made).
- Four near-parallel door modules (no shared package importable by all
  four): a materializer fix lands four times; collapse into a shared
  prototype-free door when one becomes reachable without a forbidden
  edge. Arrays keep `Array.prototype` (separate class, owned elsewhere).

## Follow-ups (owned)

1. Docs round (orchestrator): schema-boundary §3 recorder rows + tally +
   §5 item 3 EXECUTED + the new CLOB-half evidence and grant entry.
2. The CLOB-doors bounded grant (evidence above).
3. The `config-door` format-check follow-up (F5 owner).
4. Downstream `.safeParse` containment round (F11).
5. Soak-profile the per-frame materialization (operator-owned evidence).
