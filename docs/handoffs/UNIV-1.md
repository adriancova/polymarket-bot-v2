# UNIV-1 completion record — The packages/universe lifecycle door

**Merged:** `4d7443b` (`--no-ff`, 2026-09-07). Chain `ee6a795`
(candidate, one commit) → `e82ae63` (disclosed orchestrator comment
correction, reviewer characterization — r1 MED-2 header precision) on
base `78ec81d`. One review round: ACCEPT (0 blockers; 2 MEDIUM
residuals with owners, 3 LOW, 2 NOTE).

**What it is.** GOV-2A §5 item 7's first HIGH grant. The projection's
one irreversible transition (RESOLVED — domain.md §6.2, lifecycle.ts
rule 1) was reachable from the prototype: `applyMarketLifecycleEvent`
consumed zod's output at nine sites, and at the pinned zod@4.4.3 a
declared key the payload does not carry is read off `Object.prototype`.
A package-local D1–D4 door (`lifecycle-door.ts`: readOwnPayload,
containedParse per the ADR-020 2026-09-06 amendment, per-arm
DECLARED_KEYS + readShape/readDeclaredPayload, ownEmit) now closes the
class: no universe→risk edge (check:deps 34/71), no mirrored-body copy
(the deletion guard proven NON-VACUOUS on this package — planting
schema-arena.ts fails 14/14 anchors).

## Evidence highlights (all reviewer-reproduced independently)

- **Probe-O rows, both variants:** inherited `outcome` → RESOLVED/
  YES_WIN at base; inherited `resolvedAt` → resolved at 2099-01-01;
  inherited `conditionId` → checkIdentity satisfied; ALL THREE at once
  on `{internalMarketId}` only → RESOLVED at base. All refused at tip
  end-to-end; an inherited accessor on `outcome` invoked 0× at tip
  (2× at base, with the market resolving). TOCTOU closed (each key read
  exactly once — Proxy-verified).
- **The 40-key sweep:** 32 required + 8 optional declared keys across
  the eight arms; 40/40 adopt at base, 0/40 at tip (64/64 required
  cells refuse; 16/16 optional cells byte-identical to the unpolluted
  fold). Census re-derived from the frozen schemas in the suite, so an
  undoored new key fails. Sharpest optional cell: a RESOLVED market
  gaining an invented `rulesVersionId` from the prototype.
- **D2 disclosed-not-performed, compensation measured:** nine skipChecks
  defeats closed (six claimed + three the reviewer found closed,
  including `resolvedAt:"yesterday"` resolving a market at base and a
  1025-char `tickSize` that THREW at base). The instant restatement
  proven not-stricter over 40,000 fuzzed forms; a 160,000-payload
  strictness fuzz: schema-accept ⟹ door-accept, drift 0.
- **Honest-input preservation:** the 48-case pinned digest byte-identical
  at real base and tip; the reviewer's STRICTER 63-case serializer (key
  order, descriptor flags, prototype identity) found exactly the one
  disclosed representational change (`MarketClarificationRecord` now
  null-prototype; every consumer reads by field — repo-verified).
- **Mutants:** M1/M2/M4/M5 exact (6/2/8/12-12-87); the layering claim
  proven BOTH ways (D1 and D3 close the rows independently; only the
  double mutant reopens them — r1 LOW-1's correction: 22 kills is the
  double mutant, the true full revert kills 27). Reviewer additions all
  killed: census-derivation failure on a dropped arm, D4 un-nulling,
  issue-rendering equivalence (the digest catches a changed message),
  optionality flip.

## Residuals (owned)

- **r1 MED-1 — the projection-side dot-read class** (undisclosed in the
  candidate; found by review): five optional `MarketProjection` fields
  (`rulesVersionId`, `openedAt`, `closesAt`, `resolvedAt`,
  `lastEventOrder`) are read with `.` on a prototype-bearing projection
  inside the doored function; sharpest cell — `applyRulesChanged` under
  a non-enumerable inherited `rulesVersionId` APPLIES over a rules hole
  where clean input refuses `UNIVERSE_RULES_VERSION_MISMATCH`.
  Base-identical, out of the §3 row's declared scope. **Owner: a
  `packages/universe` state-side follow-up (the analogue of
  WP-160-FU1's features output round) — recorded in governance before
  the next universe grant.**
- **r1 MED-2 — the instant-format residual reaches the terminal
  transition under `skipChecks`** (base-identical; the door header now
  says so precisely — corrected pre-merge in `e82ae63`). Owner: the
  same follow-up, or D2 when a severed arena is reachable.
- **Upstream (disclosed):** `envelope.ts:44` is un-doored — an
  envelope-layer adoption arrives as a genuine OWN key the lifecycle
  door provably cannot see (reviewer-reproduced end-to-end at tip).
  Owner: an envelope-door round.
- **Registry doors (newly measured, reviewer-reproduced):**
  `registerSeries` adopts five keys including a fabricated
  `{approved:true, approvedBy:"ghost"}` binding — a series approved by
  a review that never happened; `registerMarket` adopts all four
  identity keys (the binding WP-040's `markets_immutable_identity`
  trigger protects). Owner: a bounded registration-doors grant.
- r1 LOW-2: three fail-closed exotic-shape drifts vs base (two
  unpinned); LOW-3: emitted lists non-frozen (`length` writable; not
  projected); NOTE-2: a non-canonical `tickSize` under `skipChecks`
  still throws `InvalidDecimalStringError` OUT of the function
  (base-identical; conversely the door closed a base throw). Owner:
  `packages/universe` follow-up.

## Follow-ups (owned)

1. Docs round (orchestrator, combined with SETL-1's): flip the §3
   universe row to CLOSED-for-the-measured-class; update the tally and
   §5 item 7's universe half; enter MED-1, the envelope door, and the
   registration doors as owned follow-ups.
2. The `packages/universe` state-side follow-up (MED-1 + MED-2 + LOW-2
   pins + LOW-3 + NOTE-2).
3. The envelope-door round; the registration-doors grant.
