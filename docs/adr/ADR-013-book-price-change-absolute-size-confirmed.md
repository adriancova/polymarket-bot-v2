# ADR-013: Book `price_change` carries absolute aggregate size, with zero removal (C-1 / U-1 ratified)

- **Status:** Accepted
- **Date:** 2026-08-28
- **Recorded by:** `GOV-1B` (orchestrator-authorized contract-owner governance round)
- **Implemented by:** `WP-020` (the frozen `BookLevelChanged` contract — already
  shipped and **unchanged** by this record); `WP-070` (the shipped adapter, which
  carries the venue value through unchanged); `WP-150` (may now treat the
  semantics as truth); `WP-210` (simulation depth reconstruction, see §5)
- **Supersedes / Superseded by:** none. This record **discharges the condition**
  [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) §8.3 set; it does
  not overturn ADR-002's decision, and ADR-002 §8 keeps its original text plus a
  dated amendment pointing here.

## Context

Handoff §23 asserts that public market data includes "absolute price-level
changes", and §9.4 requires the local book to "apply snapshots and absolute-size
price changes exactly as documented by the venue". At verification time
(2026-08-24) the venue's documentation did **not** state this, so:

- `docs/venue/verified-2026-08-24.md` recorded it as conflict **C-1** (§11) and
  unverified item **U-1** (§12);
- ADR-002 §8 retained the handoff assumption **provisionally**, marked it
  UNVERIFIED, and set an explicit condition: "**`WP-070` must confirm the
  semantics** … *before* `WP-150` treats it as truth";
- `docs/contracts/protected-contracts.md` §8 carried the open row, and the Wave 0
  closeout added comment-only UNVERIFIED markers to
  `packages/domain/src/events/book.ts` (finding M2);
- ADR-012 §5.8 inherited the same uncertainty for the simulator.

`WP-070`'s workplan acceptance criterion required exactly this confirmation:
"Book price-change semantics (C-1/U-1 absolute-size zero-removal) are confirmed
against current official sources or recorded observation; on confirmation the
provisional rule is ratified, otherwise the affected contracts are flagged for an
ADR-governed revision."

`WP-070` performed the confirmation (2026-08-27) and — correctly — did **not**
ratify it, because ADR-002, `protected-contracts.md` §8 and
`packages/domain/**` are all outside an implementing package's allowed paths. It
flagged the ratification for the contract owner. This record is that
ratification.

## Decision

### 1. The semantics are CONFIRMED, and are no longer provisional

The market channel's `price_change` message carries, for each reported level,
the **new aggregate size at that price level**, and a size of `0` **removes the
level**. Current official documentation states it in those words (Evidence
below). C-1 and U-1 are **closed**.

### 2. "Delta" describes which levels are reported, not arithmetic

The venue calls the message a delta because it reports **only the levels that
changed** — not because the carried `size` is a signed increment. A consumer
**replaces** the size at the named level; it never adds to or subtracts from a
previous size. `size: "0"` deletes the level rather than setting it to zero.

This distinction is the whole content of C-1 and is stated separately so that a
test can be written from it: for a level at size `"120"` receiving a
`price_change` with `size: "5"`, the resulting level size is `"5"`, never
`"125"` and never `"115"`.

### 3. `BookLevelChanged.size` needs no change, and no version bump

`BookLevelChanged.size` was already specified as "absolute resulting size at
this price; `"0"` removes the level". The confirmation makes that wording
**verified** rather than provisional.

**Schema-version consequence for recorded data** (ADR-002 §3,
`protected-contracts.md` §3): **no emitted field set changed, therefore
`schemaVersion` is unchanged**. v1 book data recorded before this date was
recorded under the same intended semantics and is correct as recorded; nothing
is reinterpreted and no migration is owed.

### 4. What downstream packages may now do

- **`WP-150`** (order book) may treat absolute-size-with-zero-removal as truth.
  The ADR-002 §8.3 precondition is discharged.
- **`WP-210` / ADR-012 §5.8**: the Tier-1 "book-update semantics are
  provisional" caveat is discharged **for this item only**. ADR-012's evidence
  hierarchy is otherwise unchanged, and every other §5 item keeps its status.
- **Simulation results produced before 2026-08-28 keep the marker they were
  produced under.** A report is not retro-labelled; ADR-012 §7 forbids
  manufacturing evidence, and that includes back-dating a confirmation.

### 5. This confirmation is DOCUMENTARY, not observational

No live connection was made, by `WP-070` or by this round. Nothing here may be
cited as observed venue behavior, and no package may claim a soak, probe, or
live observation on the strength of it (`AGENTS.md`).

Two consequences follow:

1. Any component that reconstructs depth still owes its own **hash / snapshot
   reconciliation** discipline. `book` is documented as a "Full orderbook
   snapshot sent on subscribe or after a trade" and carries a "Hash of the
   orderbook content"; a resynchronization still requires an authoritative
   snapshot (ADR-002 §2.4), and this ratification does not weaken that.
2. If live observation ever contradicts the documentation, the remedy is
   ADR-002 §8.4's: a **new `schemaVersion`** for the affected book contracts,
   never a reinterpretation of recorded v1 data and never an in-place
   redefinition.

### 6. The venue fact stays volatile, and the source index owes an update

This is a **venue fact** and remains subject to handoff §1.2: the next dated
verification report re-verifies it and restates it in its own §3/§11/§12.

The confirming page — `https://docs.polymarket.com/api-reference/wss/market` —
is **not in the frozen 2026-08-24 report's source index**, and the URL that
report cites now redirects elsewhere. That is recorded as a **gap for the next
verification round** (`docs/venue/verified-2026-08-24.md` is a frozen dated
snapshot and is not edited; `WP-070` `follow_up` 3 already asks for the
re-issue). Until that report exists, this ADR plus
`packages/polymarket-public/README.md` are where the citation lives.

### 7. How this record relates to the ADR-README rule on venue facts

`docs/adr/README.md` states that no ADR asserts a venue fact on its own
authority and that every venue statement cites the dated verification report.
That rule is **kept, not weakened**:

- The authority for the fact is **current official Polymarket documentation**,
  which handoff §1.1 ranks **above** the in-repo report. This ADR asserts
  nothing on its own authority; it records a fact a work package's *mandated*
  verification obtained, with URL, retrieval date, and verbatim quotes.
- The frozen report is still cited, for the item's **origin and prior status**
  (§3, §11 C-1, §12 U-1).
- The gap obligation is discharged in §6 above.

`README.md` is amended in the same change to state this narrow case explicitly,
so the next ADR does not have to re-derive it.

## Consequences

- **The order book becomes buildable.** ADR-002's Consequences said "the book
  contract is not yet trustworthy for order-book reconstruction"; that sentence
  is now discharged, and `WP-150` inherits a settled contract instead of a
  provisional one.
- **A documentation-only confirmation is weaker than observation**, and the
  repository now depends on a vendor page that has already moved once (the
  2026-08-24 URL redirects). The next verification round must re-capture the
  AsyncAPI page; if it disappears without a successor, the item reopens rather
  than silently resting on this quote.
- **Three artifacts stop saying "provisional"** (ADR-002 §8 amendment,
  `protected-contracts.md` §8, the `book.ts` comment markers) and one keeps its
  own history (`docs/venue/verified-2026-08-24.md`, frozen). A reader who finds
  the frozen report's C-1 entry and stops there will read a stale status; the
  report's own §1.2 framing and `protected-contracts.md` §2 already say a merged
  report is a dated snapshot.
- **The `WP-000` fixture example `level-removed-absolute-zero-UNVERIFIED` keeps
  its name.** A frozen fixture catalogue is not relabelled by a later package;
  the name records what was known when it was written. Renaming it, if ever
  wanted, is a fixture-owning package's change under its own review.

## Evidence

**Re-verified for this record on 2026-08-28** by the contract-owner round, by
direct read-only unauthenticated fetch of
`https://docs.polymarket.com/api-reference/wss/market.md` (HTTP 200, 44 794
bytes), independently of `WP-070`'s 2026-08-27 retrieval and of the `WP-070`
round-1 reviewer's own confirmation. Verbatim, from the served AsyncAPI
document:

| Where | Quote |
| --- | --- |
| `price_change` → `price_changes[].size` | `New aggregate size (0 means level removed)` |
| `price_change` → `price_changes[].price` | `Price level affected` |
| `price_change` operation | `Delta update to orderbook price levels when an order is placed or cancelled` |
| `price_change` payload | `Orderbook price level delta update` |
| `book` operation | `Full orderbook snapshot sent on subscribe or after a trade` |
| `book` → `bids` | `Aggregated buy orders by price level` |
| `book` → `bids[].size` / `asks[].size` | `Total size at this price level` |
| `book` → `hash` | `Hash of the orderbook content` |

The `size` description appears twice in the document (the `price_change` payload
and its message schema), identically.

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §1.1 — source precedence: current official Polymarket documentation is the
  first-tier authority for venue facts.
- §1.2 — venue facts are volatile; each phase re-verifies and writes a **new**
  dated report.
- §9.4 — "apply snapshots and absolute-size price changes exactly as documented
  by the venue"; no invented venue sequence number.
- §23 — the handoff-time assumption, flagged there as requiring reverification.

**Prior in-repo status** (all superseded on this point by the current official
page, under §1.1):

- `docs/venue/verified-2026-08-24.md` §3 (market-channel event set, `size`
  semantics not stated), §11 **C-1**, §12 **U-1**.
- [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) §8 — the
  provisional retention and the `WP-070` precondition.
- [ADR-012](./ADR-012-simulation-fill-model-evidence-hierarchy.md) §5.8 — the
  simulator's inherited uncertainty.
- `docs/contracts/protected-contracts.md` §8 — the open register row.
- `packages/domain/src/events/book.ts` — the comment-only UNVERIFIED markers
  (Wave 0 closeout finding M2).

**Implementation and prior handoffs:**

- `docs/handoffs/WP-070.md` → "1. C-1 / U-1: CONFIRMED against current official
  sources (2026-08-27)": the retrieval, the same verbatim quotes, the reading,
  the explicit statement that no live connection was made, and the list of four
  artifacts the package deliberately did **not** edit.
- The `WP-070` round-1 adversarial review graded the C-1/U-1 evidence **"PASS
  with caveat"**: the reviewer independently confirmed the page's delta
  semantics and internal consistency, but "could not extract the exact nested
  quote through its extractor" (`IMPLEMENTATION_STATUS.md`, `WP-070` review
  round 1). **That caveat is what this round's own fetch closes**: the nested
  `price_changes[].size` description was read directly out of the served
  document, at both of the two places it occurs, and is quoted verbatim above.
- `packages/polymarket-public` carries the venue value through unchanged (`"0"`
  included) and performs no delta arithmetic anywhere.

**Safety:** this ADR changes no run-mode default. `MAX_RUN_MODE=PAPER`,
`ALLOW_REAL_ORDERS=false`, and both live micro caps at `0` are untouched
(ADR-010; `AGENTS.md`).
