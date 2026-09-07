# CLOB-1 completion record — The polymarket-public CLOB prototype-free doors

**Merged:** `eb0c586` (`--no-ff`, 2026-09-07). Candidate `8506d5f` (one
commit) on base `989d41d`. One review round: ACCEPT (0 blockers; 3 LOW
all fail-closed, 4 NOTE; zero fail-open and zero wrong-value rows at
tip). The implementing agent was rate-limit-killed mid-implementation
AND its worktree was destroyed by the kill; it was resumed via
SendMessage, recreated the worktree off base, re-reproduced every base
transcript live, and re-implemented from its own context — the reviewer
independently confirmed digest continuity (honest corpus byte-identical
across the recreation).

**What it is.** GOV-2A §5 item 8, measured by REC-1's review. The two
defeats: `parseMarketEvent` THREW an escaping cold-lazy
`propValues[key].add` TypeError under an inherited `event_type` (a
function documented to return `MarketEventParseResult`); the order-book
parsers adopted an inherited `hash` and an inherited `tick_size` — an
ECONOMIC parameter — into the recorded book. Closed by a package-local
door (`src/venue/wire-door.ts`): `parseMarketEvent` no longer parses
through the `discriminatedUnion` at all (it reads `event_type` from its
own materialized tree and routes to the member schema, taking the
cold-lazy build off the door's path and containing it), and the book
parsers materialize (D1), judge inside a containment, and project
null-prototype emissions from the tree (D3+D4). Field tables are DERIVED
from the schemas (key list, order, requiredness via `isOptional()`,
transform rules by node identity) — any desync fails the suite.
`src/rtds/**` (REC-1's doors) byte-identical to base; the 583-test
contract suite and 65-test rtds suite verdict-identical both ways; the
package index unchanged in bytes for the rtds half.

## Evidence highlights (reviewer-reproduced with different primitives)

- Independent 106-cell census (schema-walk, never the shipped tables):
  matches exactly, no missed declared key. Base 212/212 measurements
  diverged; tip 0/424 (four variants: data/accessor × enum/non-enum —
  the accessor variant was the reviewer's own and surfaced a SECOND base
  throw class, `Invalid discriminated union option`, beyond the recorded
  TypeError).
- 940-call hostile battery over 40 keys outside the implementer's
  24-shape list, plus symbol keys and `constructor.prototype` accessors:
  0 escapes, 0 undocumented verdicts (base threw on 21/56 of the
  index/iterator battery).
- 6448-row value corpus + two 20,000-payload fuzzers: REFUSE→ACCEPT 0,
  parsed-with-different-bytes 0; the mutation fuzz digest byte-identical
  base↔tip. ACCEPT→REFUSE 18, all exotic root shapes (below).
- Kill sets EXACT on all ten mutants (delta only where the reviewer's
  mutant definition differed), including the claim that the 583-test
  contract suite kills NONE of them — the colocated suites carry the
  full load (REC-1's F1 lesson institutionalized).
- Non-vacuity: 26/31 boundary tests fail against the base parsers,
  exactly as claimed.
- D2 disclosed-not-performed with a bounded compensation (routing read,
  required-key presence, `hash` `.min(1)`), proven by the reviewer's
  cold-module matrix (6 flag states × 18 cases): 8 base fail-open cells
  closed; the one disclosed non-restatement (`z.number().int()` in
  `VenueEpochLikeSchema` — `timestamp: 1.5` PARSES under inherited
  `skipChecks`) is base-identical.

## Review corrections (quote these, not the implementer's handoff)

- **An own `__proto__` wire key IS JSON-reachable** (`JSON.parse` creates
  it as an own data property) — the implementer's "venue-unreachable"
  label was wrong for this row. The tip behavior is a fail-closed
  whole-frame refusal where base parsed (ACCEPT→REFUSE, LOW); the
  shipped code makes no false claim (the refusal message is accurate) —
  only the handoff mislabelled it.
- **4 of the 5 base-passing boundary tests do not discriminate base from
  tip** (the handoff characterized only 2 that way). The warm-process
  `optin`/`optout` presence test passes at base with no door because the
  waiver bites COLD parses only (the §2 measured fact); the compensation
  is real — the reviewer's fresh-module matrix is the evidence the
  shipped test is not. Owed to the follow-up hardening round.

## Residuals (owned)

- **F1 (LOW):** a hostile `Array.prototype[Symbol.iterator]` mis-keys
  the door's own result record; `snapshot/fetcher.ts` then forwards
  `book === undefined` into a downstream TypeError. Availability-only,
  fail-closed, disclosed class (arrays keep `Array.prototype`). Owner:
  the shared-materializer collapse round (now SIX near-parallel doors).
- **F2/F3 (LOW):** exotic-shape ACCEPT→REFUSE drifts — own `__proto__`
  (JSON-reachable, relabelled), symbol keys, own accessors, sparse
  arrays, non-plain prototypes, and the 16-deep cap measured from the
  frame root (a 16-deep `fee_schedule` refuses a `new_market` frame).
  All fail-closed. Owner: recorded here; revisit if a real venue frame
  ever trips the depth cap.
- **F4 (NOTE):** three door defences killed by zero tests (all
  JSON-unreachable shapes: `ownMemberOf` accessor refusal, its
  `hasOwn(descriptor,"value")` guard, sparse-array refusal). Owner:
  CLOB-1 follow-up test hardening, with F5's non-discriminating tests.
- **Normalizer diagnostics (NOTE):** every D1 refusal collapses to
  `unrecognized`, so `UNRECOGNIZED_FRAME` can carry a message that
  contradicts the frame. Owner: polymarket-public normalizer round.
- **F6 (NOTE):** `export *` re-exports put the 11 `*_FIELDS` tables on
  the public API; `wire-fixtures.ts` is non-test data under `src/`
  (confirmed not re-exported, invisible to the anchor walker). Owner:
  package-surface tidy-up.
- **F7 (base-only, strengthens the record):** one polluted COLD parse
  permanently bricks base `parseMarketEvent` for the process lifetime
  (durable after pollution removal — the same durability class as
  SETL-1's §2 fact); tip answers `unrecognized` in all four variants.
- The `timestamp: 1.5`-under-`skipChecks` non-restatement (base-
  identical) — owner: ADR-020 D2 / the severed-arena question.
- Fifth near-parallel materializer, self-disclosed. Owner: the shared
  collapse round under ADR-020 governance (with UNIV-2's caller-door
  that count is now six).

## Follow-ups (owned)

1. Docs round (orchestrator, combined with UNIV-2's): flip the §3
   polymarket-public row from SPLIT to fully CLOSED, tally, §5 item 8
   EXECUTED; enter the review corrections and residual owners; add F7's
   durable-brick fact to the §2 class table (it corroborates the SETL-1
   durability row on a second package).
2. Follow-up test hardening (F4 + F5) — opportunistic, with the corpus
   value SETL-1 owes.
3. `apps/backtest-cli/src/normalizer.ts` stale "LIVE" comment — the
   comment-staleness round.
4. The shared-materializer collapse question — ADR-020 governance.
