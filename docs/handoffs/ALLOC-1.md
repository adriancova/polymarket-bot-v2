# ALLOC-1 completion record — capital-allocator strategyInstanceId re-typing

**Merged:** `d9f70a6` (`--no-ff`, 2026-09-06). Chain `da4f6d2` (four-site
re-typing + 12-test regression file) → `044b864` (the stop-and-report
grant extension `0e9c054`) on base `2248711`. One review round: ACCEPT
(0 blockers; 2 LOW — both TRDR-1 obligations, 6 NOTE).

**What it is.** The ADR-021 2026-09-06 amendment's owed round. The four
identity sites — `ReservationRequestSchema` (`reserve.ts`),
`PositionHoldingSchema`, `OpenOrderCommitmentSchema`, `LiveOwnerSchema`
(`state.ts`) — re-typed `CodeStringSchema` → `Uuidv7Schema` (same import
source, `@polymarket-bot/domain`). The three scope keys
(`seriesKey`/`underlyingKey`/`resolutionWindowKey`) stay
`CodeStringSchema` — vocabulary, not identity — and that boundary is
mutation-pinned in both directions (a scope key re-typed to UUID fails
the vocabulary rows; an identity site reverted fails 12–45 tests).

## The measured change (reviewer-reproduced independently at all four doors)

| spelling | base | tip |
| --- | --- | --- |
| minted 0-leading canonical v7 | REFUSED `CAPITAL_INPUT_INVALID` | ACCEPTED |
| letter-leading canonical v7 | ACCEPTED | ACCEPTED |
| `sb-instance-1` (code string) | ACCEPTED | REFUSED |
| UPPERCASE v7 | ACCEPTED | REFUSED |
| lowercase v4 | ACCEPTED | REFUSED |

**Base-state finding, review-confirmed and EXTENDED:** at base a re-cased
instance id was accepted verbatim into the commitment tables AND became
its own `byStrategyInstance` exposure key — two spellings of one
instance kept SEPARATE per-strategy cap buckets, a cap-evasion surface.
`sb-instance-1` likewise reached the tables and the exposure key
verbatim. Both closed fail-closed by this round.

**Producer sweep (acceptance-bar-critical, reviewer's own):** the only
live producers into these doors are the trader's `instanceId` (minted
under the interim letter-leading `UuidAndCodeString` — passes both
grammars) and ledger projection lines (typed `Uuidv7Schema` — exactly
the 0-leading population base refused). No live producer emits a
now-refused value. `apps/control-api` has no dependency on the package.

**Unchanged, verified:** evidence shape (`CAPITAL_INPUT_INVALID` +
`details.issues` both sides; only the message string moved — NOT the
risk door's ADR-016 shape change); guard territory
(`uuidShapedNotCanonical` has three call sites — reservationId,
positionId, orderId — and never covered this field; parse-before-guard
in both doors; two rows pin the guard's surviving territory, green at
base and tip).

## Lifecycle notes

- The implementer STOPPED AND REPORTED on one out-of-grant failure (the
  `test/unit/risk/schema-arena.test.ts` corpus's only accepting row
  starved its non-vacuity guard; the differential arena-vs-library
  property never broke). The grant was extended by ONE value line
  (governance `0e9c054`), and the fix uses the letter-leading spelling so
  the row is accepting under both grammars. Record precision (reviewer):
  the `ports.test.ts` edit was covered by the ORIGINAL enumerated edge —
  the extension was for schema-arena only.
- The `ports.test.ts:161` ownership row had silently decayed: with the
  re-typing, its `"someone-else"` value made it pin a schema refusal
  instead of the `CAPITAL_LIVE_OWNERSHIP_CONFLICT` it was written for
  (decay proven directly by the reviewer). Restored with a second valid
  UUIDv7 and the refusal code pinned as a singleton.
- The allocator suite's own `INSTANCE`/`OTHER_INSTANCE` moved to minted
  0-leading UUIDv7s so the 66 existing tests exercise the newly admitted
  population (proven load-bearing by the M1–M4 kill sets: 35/17/12/45,
  reviewer-exact). One pollution probe re-vectored
  (`strategyInstanceId:"constructor"` is unrepresentable under the new
  grammar → `scope.seriesKey:"constructor"`), proven coverage-equivalent
  by a paired base/tip mutation (kills exactly one test on each side).
- The new regression file carries ZERO prototype-census sites (the
  out-of-grant budget pin demanded it — proven necessary by injecting a
  single site, which fails the census).

## Residuals (owned)

- **r1 L1 → TRDR-1:** `apps/trader`'s `UuidAndCodeString`
  (`config.ts:175`) is version- AND variant-blind — a lowercase v4 with
  a letter lead passes STARTUP and is refused mid-run by the risk door
  (fail-closed at base already; no order placed on either side). TRDR-1
  must TIGHTEN to v7+variant (i.e. the real `Uuidv7Schema`), not merely
  relax the leading-letter constraint.
- **r1 L2 → TRDR-1:** the same door's refusal text still says
  "packages/risk types context.strategyInstanceId as CodeStringSchema" —
  false since WP-180-FU3, doubly so now.
- **N1/N2 → next allocator round:** stale `guards.ts:38-44` comment
  (still lists strategyInstanceId among bounded-non-empty-string scope
  keys); base-relative line refs in the new file's prose.
- **N3 (pre-existing, disclosed):** `withLiveOwner`/`withLiveOwnerInner`
  take plain strings and parse nothing — byte-identical to base, zero
  non-test callers repo-wide; same class in `exposure.ts`'s zero-fill
  surfaces.
- **N4:** the arena/`skipChecks` pollution pin for the new grammar is
  ABSENT (the census-site discipline forced the omission) — but the
  BEHAVIOR is verified correct by the reviewer: both live doors refuse
  under `skipChecks`/`skipFast`/`async`/`abort` where the raw schemas
  are fooled. Coverage owed, behavior sound.
- **N5:** one reproduce-first row's negative assertion is weaker than it
  could be (non-vacuous — fails at base on `ok === false`).

## Follow-ups (owned)

1. **TRDR-1 — EXECUTED** (merged `65ae56c`, 2026-09-07):
   `InstanceConfigSchema.instanceId` now uses the real `Uuidv7Schema`,
   admitting 0-leading UUIDv7s and enforcing version/variant bits
   (closing r1 L1). `UuidAndCodeString` was deleted and the conflict
   refusal text replaced (closing r1 L2). All four merged doors and the
   trader startup door now agree; ADR-021 is discharged.
2. Docs round: ADR-021 second amendment (allocator door corrected by
   this merge; the evidence-shape NON-change; the cap-evasion finding);
   WP-180-FU3 handoff follow-up 1 marked done.
3. Next allocator round: N1/N2 comment fixes; the N4 arena/skipChecks
   pin in a census-budgeted location.
