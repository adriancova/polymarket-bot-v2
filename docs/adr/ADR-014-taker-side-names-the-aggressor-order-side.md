# ADR-014: `takerSide` names the aggressor order's own side

- **Status:** Accepted
- **Date:** 2026-08-28
- **Recorded by:** `GOV-1B` (orchestrator-authorized contract-owner governance round)
- **Implemented by:** `WP-020` (the frozen `takerSide` field — **unchanged** by
  this record); `WP-070` (conforms today); `WP-090` (conforms today);
  `WP-080` (omits today; a **mandatory** bounded follow-up brings it under this
  ruling); every future adapter that emits a trade event
- **Supersedes / Superseded by:** none

## Context

Two frozen contracts carry an optional taker side:

- `PublicTradeObserved.takerSide` (`packages/domain/src/events/book.ts`)
- `ReferenceTradeObserved.takerSide` (`packages/domain/src/events/reference.ts`)

Both are `BookSideSchema.optional()` over the vocabulary `BID | ASK`, documented
in full as: *"Taker side when the venue reports it."*

That sentence says **when** the field is present. It does not say **what `BID`
means**, and the two available readings are exact opposites:

| Reading | A taker who **buys** is recorded as |
| --- | --- |
| The taker's own order direction, expressed as a book side | `BID` |
| The side of the book the taker consumed | `ASK` |

Batch 1B shipped three adapters into that gap and produced three different
outcomes, which is precisely the situation `AGENTS.md` means by "do not modify
shared contracts merely to make local implementation easier" — nobody modified
anything, and the ambiguity propagated instead:

- **`WP-070` (Polymarket)** maps the venue's taker-perspective `side` `BUY → BID`
  and `SELL → ASK`.
- **`WP-090` (Coinbase)** inverts the venue's documented **maker** side: maker
  `SELL → BID`, maker `BUY → ASK`.
- **`WP-080` (Binance)** **omits** the field by default and records the ambiguity
  as open item `BNC-U5`, offering a caller-selected convention
  (`OMIT` / `BOOK_SIDE_CONSUMED` / `TAKER_ORDER_DIRECTION`) rather than guessing.
  `WP-080`'s own review called the question unresolvable from the frozen
  artifacts, which it was.

`WP-080` was right to omit (ADR-002 §6: "a producer that cannot supply them must
omit them rather than guess"), and `WP-070`'s follow-up asked the contract owner
for exactly this ruling. A field whose meaning depends on which adapter produced
it is not a contract; a feature built across venues on `takerSide` — aggressor
imbalance, trade-flow sign, markout attribution — would be silently summing
opposite quantities.

## Decision

### 1. `takerSide` names the side of the **taker's own order**

`takerSide` records the aggressor's order direction, expressed in the `BookSide`
vocabulary:

- **`BID`** ⇔ **the taker was buying.**
- **`ASK`** ⇔ **the taker was selling.**

### 2. It is NOT the side of the book that was consumed

Stated separately because the two readings are inverses and a reader who assumes
the other one gets every sign backwards:

> A **buying** taker consumes resting **asks** and is still recorded as
> **`BID`**. A **selling** taker hits resting **bids** and is still recorded as
> **`ASK`**.

Equivalently: `takerSide` is the side the taker's order **would have rested on**
had it not been marketable; the maker's side is always the opposite.

### 3. The derived per-venue mappings, stated so a test can be written from them

| Venue field shape | Mapping under this ruling |
| --- | --- |
| A side documented **"from the taker's perspective"**, `BUY`/`SELL` (Polymarket `last_trade_price.side`) | `BUY → BID`, `SELL → ASK` |
| A side documented as the **maker's** side, `BUY`/`SELL` (Coinbase `market_trades[].side`) | maker `SELL → BID`, maker `BUY → ASK` (the inverse — the taker took the other role) |
| A boolean **"is the buyer the market maker"** (Binance `m`) | `m = true → ASK` (the buyer was the maker, so the taker was the **seller**); `m = false → BID` |
| A side documented only as "trade side", with no role stated | **not mappable** — omit under §4 and record the gap |

Each row is a *reading of that venue's documentation*, not an assumption about
matching. If a venue's documentation is wrong about the role it reports, its
adapter's mapping is wrong under this ruling too; §6 says what that is and is
not.

### 4. Absence rules are unchanged, and still bind

1. The field stays **optional**. A producer that cannot determine the aggressor
   **omits** it (ADR-002 §6). Omission is conforming behavior, never a defect.
2. An **unrecognized** wire value is first-class UNKNOWN — reported and
   preserved raw, never coerced into a side (ADR-002 §7; both `WP-070` and
   `WP-090` already do this).
3. **A value may not be emitted under any other convention.** Emitting the
   consumed-book-side reading into this field writes a value that the contract
   now defines to mean its opposite. That is a contract violation, not a
   configuration choice — see §7 for the one adapter this bites.

### 5. The field is NOT renamed

`WP-070` `follow_up` 2 raised `takerOrderSide` as an option. **Declined.**
Renaming a field in a frozen contract is a schema change requiring a new
`schemaVersion` for every affected event type and a migration story for recorded
data (ADR-002 §3), in exchange for clarity this record already supplies. The
name stays `takerSide`; the meaning is fixed here.

**Schema-version consequence for recorded data**: **no emitted field set
changed, therefore `schemaVersion` is unchanged** (ADR-002 §3;
`protected-contracts.md` §3). No `packages/domain` file is modified by this
record.

Recorded `takerSide` values emitted **before** this date are correct as recorded
where the producer already conformed (`WP-070`, `WP-090`) and absent where it did
not (`WP-080`), so no recorded value is reinterpreted by this ruling. That is a
consequence of `WP-080` having omitted rather than guessed, and is the strongest
practical argument for ADR-002 §6's omission rule.

### 6. What this ruling does NOT settle

This record fixes the **meaning of the domain field**. It does not:

- resolve `U-CB-3` — whether Coinbase's `market_trades[].side` really reports the
  **maker's** side. That is an open venue-fact item owned by `WP-090`'s package
  and its validation follow-up. If it is ever disproved, `WP-090`'s mapping
  inverts; this ruling does not move.
- assert anything about matching-engine behavior, self-trade prevention, or how
  a venue assigns the taker role in an auction or cross.
- license inferring an aggressor from price movement, quote position, or any
  other heuristic. `takerSide` carries a **reported** fact or nothing (§4.1).

### 7. Conformance verdicts for the shipped batch-1B adapters

| Package | Shipped behavior (read in code, 2026-08-28) | Verdict |
| --- | --- | --- |
| `WP-070` `packages/polymarket-public` | `normalizeVenueSide`: `BUY → BID`, `SELL → ASK`, over a venue field the current official page documents "From taker's perspective" | **CONFORMS.** This ruling adopts the convention `WP-070` shipped. |
| `WP-090` `packages/coinbase-adapter` | `takerSideFromDocumentedMakerSide`: maker `SELL → BID`, maker `BUY → ASK`; unknown value → omitted plus a `COINBASE_UNKNOWN_TRADE_SIDE` anomaly; raw venue value preserved as `venueDetail.venueSide` with `venueSideMeaning: "MAKER"` | **CONFORMS.** A maker `SELL` means the taker bought, which is `BID` under §1. No remediation is owed. |
| `WP-080` `packages/binance-adapter` | `takerSideFor`: `OMIT` (default) → absent; `TAKER_ORDER_DIRECTION` → `m = true → ASK`; `BOOK_SIDE_CONSUMED` → `m = true → BID` | **CONFORMS BY OMISSION** in its default configuration, and **carries one non-conforming reachable path**: `BOOK_SIDE_CONSUMED` now emits the inverse of the ruled meaning. See the mandatory follow-up below. |

**Mandatory bounded follow-up — `packages/binance-adapter` (`BNC-U5` closure).**
Owned by the package's owner under an orchestrator-authorized bounded package,
**before any consumer wires `takerSide` from this adapter**:

1. Map `m` under this ruling (`m = true → ASK`, `m = false → BID`) — i.e. the
   existing `TAKER_ORDER_DIRECTION` behavior becomes the adapter's mapping.
2. **Remove the `BOOK_SIDE_CONSUMED` convention**, or otherwise make it
   unreachable. Retaining a selectable convention that emits the inverse of a
   ruled meaning keeps the defect this ADR exists to remove, one configuration
   flag away.
3. Decide and record whether the default becomes the mapping or stays `OMIT`;
   either is conforming, and the choice is the package's, but it must be stated.
4. Update `BNC-U5` in the package's venue-fact table from *open* to *closed by
   ADR-014*, and keep `buyerIsMaker` preserved on the decoded frame either way.

This ADR does **not** edit that adapter; a governance round rules, it does not
implement.

## Consequences

- **Cross-venue aggressor features become summable.** That is the entire point:
  `BID` means the same thing on a Polymarket print, a Coinbase print, and (after
  the follow-up) a Binance print.
- **The name stays slightly counter-intuitive to one class of reader** — the
  reader who thinks in "which side of the book was hit". §2 exists for them, and
  any code comment or dashboard label that restates `takerSide` should restate
  §1's biconditional rather than paraphrase it.
- **The ruling is discoverable from the contract documents and this ADR, but not
  yet from the frozen source files.** `packages/domain/src/events/book.ts` still
  carries only "Taker side when the venue reports it", and
  `packages/domain/src/events/reference.ts` carries no comment on the field at
  all. Adding a comment-only
  pointer there is a **follow-up for the next bounded package that owns
  `packages/domain/**`** (comment-only, hash-proved, no version bump), because a
  governance round may not widen its own allowed paths. Recorded in
  `docs/contracts/protected-contracts.md` §8.1 so it is owned rather than
  remembered.
- **An adapter that cannot determine the role now has one legal answer**
  (omit) instead of two plausible ones. That makes a missing `takerSide` more
  common than a wrong one, which is the correct trade for a field feeding
  signed features.
- **If a venue's documentation about roles is wrong, this ruling makes the
  resulting error uniform rather than random.** Uniform errors are detectable by
  cross-venue comparison; per-adapter conventions are not.

## Evidence

**Frozen contracts** (read 2026-08-28):

- `packages/domain/src/events/book.ts` — `PublicTradeObserved.takerSide:
  BookSideSchema.optional()`, documented "Taker side when the venue reports it".
- `packages/domain/src/events/reference.ts` — `ReferenceTradeObserved.takerSide`,
  the same shape with **no field comment at all**, so a reader of that file has
  even less than the one sentence.
- `packages/domain/src/identifiers.ts` — `BookSideSchema = z.enum(["BID", "ASK"])`,
  documented "Book side. Used by normalized book events (§7.4)".
- `packages/domain/src/testing/samples.ts` — the `PublicTradeObserved` sample
  carries `takerSide: "ASK"` and lists it in `optionalFields`; the sample fixes
  no meaning either way.
- `docs/contracts/domain.md` §8 — "Event payload fields beyond §7.4's names …
  payload shapes are our design"; handoff §7.4 names event **types** only, so no
  primary-specification text defines this field's vocabulary. That is why a
  ruling was needed rather than a citation.

**Venue documentation** (each read by the package that cites it; the Polymarket
line re-read for this record on 2026-08-28):

- Polymarket `https://docs.polymarket.com/api-reference/wss/market` —
  `last_trade_price.side`, `enumValues: [BUY, SELL]`, description **"From taker's
  perspective"**. This is what licenses `WP-070`'s mapping and what makes the
  taker-order-direction reading the one the repository's own primary venue
  already uses.
- Coinbase Advanced Trade WebSocket channels — `side` "refers to the makers
  side" / "The maker's side of the trade" (`docs/handoffs/WP-090.md` source list,
  items 8 and 9).
- Binance — `m` is "Is the buyer the market maker?"
  (`docs/handoffs/WP-080.md`, `BNC-U5`; `packages/binance-adapter/src/venue.ts`).

**Shipped adapter code** (read 2026-08-28, not inferred from handoffs):

- `packages/polymarket-public/src/normalize/values.ts` → `normalizeVenueSide`:
  `"BUY" → "BID"`, `"SELL" → "ASK"`, anything else invalid.
- `packages/polymarket-public/src/venue/market-events.ts` — the schema comment
  recording that "`side` is documented 'From taker's perspective', which is what
  licenses the mapping onto the domain's `PublicTradeObserved.takerSide`".
- `packages/coinbase-adapter/src/normalize.ts` →
  `TAKER_SIDE_BY_DOCUMENTED_MAKER_SIDE = { SELL: "BID", BUY: "ASK" }`, with the
  stated rationale "a maker `SELL` was lifted by a buyer, whose side of the book
  is the BID".
- `packages/binance-adapter/src/normalize.ts` → `TAKER_SIDE_CONVENTIONS` and
  `takerSideFor`, whose own comments name both readings and their opposite
  results.

**Prior records:**

- `docs/handoffs/WP-070.md` → remediation round 1 `follow_up` 2 (the
  cross-adapter meaning of `takerSide`, raised for the contract owner).
- `docs/handoffs/WP-080.md` → `BNC-U5` and its `follow_up` (open until the
  contract owner rules).
- `docs/handoffs/WP-090.md` → `known_risks` 1 (`U-CB-3`, the maker-side reading)
  and `follow_up` 5 (validate it against execution data).
- `IMPLEMENTATION_STATUS.md` → "Contract-owner items accumulated from batch 1B
  round 1", item 2: "rule the `takerSide` BID/ASK vocabulary (WP-080 omission
  accepted pending ruling; WP-090 emits maker-inversion; adapters must
  converge)".
- ADR-002 §6 (omit rather than guess) and §7 (unknown wire values are first-class
  UNKNOWN) supply the two rules §4 restates rather than invents.

**Safety:** this ADR changes no run-mode default (ADR-010).
