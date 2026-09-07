# ADR-021: `strategyInstanceId` is a UUIDv7; risk's `CodeString` typing is a mis-typing

- **Status:** Accepted (2026-09-06)
- **Deciders:** contract owner (orchestrator), under the runbook's
  per-package lifecycle authority
- **Work packages:** the correction is owned by the queued
  `packages/risk` remainder round; a later `apps/trader` touch relaxes
  the startup intersection door

## Context

One value must pass three merged doors and cannot:

- `packages/ledger`'s `AllocationClaim.instanceId` and `packages/pnl`'s
  `PnlOwner.instanceId` are `Uuidv7Schema`.
- `packages/risk` types `context.strategyInstanceId` as
  `CodeStringSchema` (`packages/risk/src/inputs.ts:194`), whose grammar
  requires a **leading letter**.
- A UUIDv7 minted from a real millisecond timestamp has `0` as its
  first hex digit for every date before ~2527 (the 48-bit timestamp
  field has not yet reached `0x1000…`), so no honestly-minted UUIDv7
  satisfies `CodeStringSchema`.

`WP-230` surfaced the conflict and shipped the correct interim posture:
`apps/trader/src/config.ts` refuses at startup with the
`UuidAndCodeString` grammar (a canonical lowercase UUID-shaped string
whose first hex digit is a letter), naming the conflict in the refusal
text rather than letting it surface mid-run as `RISK_INPUT_INVALID`.
Note the interim check enforces a letter-leading UUID *shape*; it does
not enforce UUIDv7 version/variant bits and therefore does not fully
implement the intersection — the ledger/pnl doors still enforce those
bits downstream. The ruling on which side is wrong was queued to the
contract owner (`docs/handoffs/WP-230.md`, accepted residual 1).

## Decision

**`strategyInstanceId` is an identity, and its contract type is
`Uuidv7Schema`.** The `packages/risk` typing is ruled a mis-typing:

1. `CodeStringSchema` documents itself as "a stable machine vocabulary
   token: reason codes, tags, feed identifiers, channel names"
   (`packages/domain/src/primitives.ts`). A strategy instance id is none
   of those — it is a minted identity, like `runId`, `configId` and
   `marketId`, all of which are UUIDs.
2. The database identity discipline (§10.3, `internal.uuid_v7` domains)
   and the ledger/pnl doors already bind the same value to UUIDv7;
   two-of-three merged doors and the durable schema agree.
3. Nothing depends on the letter-first property: a canonical lowercase
   UUID is a safe Prometheus label value and a safe database key — the
   two stated reasons for `CodeStringSchema`'s grammar.

Consequently:

- **The queued `packages/risk` remainder round** changes
  `context.strategyInstanceId` from `CodeStringSchema` to the arena copy
  of `Uuidv7Schema` (a widening on the honest population: every value
  the trader can mint today is refused by the current typing), with a
  regression test that a minted, `0`-leading UUIDv7 is accepted and a
  non-UUID code string is refused.
- **Until that lands**, `apps/trader`'s `UuidAndCodeString` startup
  refusal stays exactly as shipped — a letter-leading UUID shape,
  fail-closed, and honest about why (the version/variant bits it does
  not check are enforced downstream by the ledger/pnl doors).
- **After it lands**, a bounded `apps/trader` touch relaxes
  `InstanceConfigSchema.instanceId` to plain `Uuidv7Schema` and deletes
  the intersection grammar; its refusal text (which names the conflict
  this ADR resolves) must be updated in the same change.

## Consequences

- Instance ids become mintable with any standard UUIDv7 generator; the
  letter-first workaround (choosing ids from the ~6/16 of the space
  whose first digit is a–f) is retired once both follow-ups land.
- Existing letter-leading UUIDv7 configurations remain valid. The
  correction admits present-day minted UUIDv7s while rejecting non-UUID
  code strings the current risk typing would have accepted — a widening
  on the honest population (ids the trader can actually mint), and a
  narrowing only on code-shaped strings no other door ever admitted.
- The risk package's input surface loses one incidental restriction; no
  metric label, database column, or reason-code grammar is affected.
- Anything that would have relied on `strategyInstanceId` being a
  human-meaningful code token is foreclosed: it is an opaque identity.

## Evidence

- `apps/trader/src/config.ts` (`UuidAndCodeString`, and
  `InstanceConfigSchema.instanceId`'s doc comment) — the measured
  conflict statement and interim refusal.
- `packages/risk/src/inputs.ts:194` — the mis-typed door.
- `packages/domain/src/primitives.ts` — `CodeStringSchema`'s stated
  purpose and grammar.
- `docs/handoffs/WP-230.md` accepted residual 1; WP-230 review round 1
  ruled the intersection door "DISCLOSED-CONFLICT-NOT-DEFECT" with the
  intersection math verified.
- Handoff §10.3 (id discipline); `db/migrations` `internal.uuid_v7`
  domains.

## Amendment (2026-09-06): the risk re-typing landed; a fourth door was measured; sequencing is amended

Append-only; nothing above this line changed.

1. **The `packages/risk` correction is EXECUTED** (`WP-180-FU3`, merged
   `8c14b47`): `context.strategyInstanceId` is the arena `Uuidv7Schema`,
   with the regression tests this ADR demanded (a minted `0`-leading
   UUIDv7 accepted; a non-UUID code string refused; the letter-leading
   compatibility row green at base and tip).
2. **This ADR's context missed a door.** `packages/capital-allocator`
   types the same value `CodeStringSchema` at four sites:
   `src/reserve.ts:69`, `src/state.ts:68`, `src/state.ts:81`,
   `src/state.ts:92`. Measured, not assumed (WP-180-FU3, confirmed by its
   review round 1): with a `0`-leading instance id, exactly seven
   `test/unit/risk/ports.test.ts` tests fail with
   `CAPITAL_INPUT_INVALID … must be an alphanumeric code without
   whitespace`. So the value passes **four** merged doors, not three, and
   the letter-leading-UUIDv7 intersection remains the only shape every
   merged door accepts today.
3. **The "After it lands" step is re-conditioned.** The bounded
   `apps/trader` relaxation to plain `Uuidv7Schema` MUST NOT land until a
   `packages/capital-allocator` re-typing round corrects the four sites
   above. Ordering: allocator re-typing round → then the trader
   relaxation (which also updates the refusal text naming this
   conflict). Until then `apps/trader`'s `UuidAndCodeString` startup
   refusal stays exactly as shipped.
4. The interim state is fail-closed in the safe direction: the risk door
   now accepts `0`-leading UUIDv7s that the allocator door refuses —
   a cross-package narrowing that rejects, never admits.

## Second amendment (2026-09-06, later the same day): the allocator door is corrected

Append-only; nothing above this line changed.

1. **The `packages/capital-allocator` re-typing is EXECUTED** (`ALLOC-1`,
   merged `d9f70a6`; review round 1 ACCEPT, 0 blockers): all four
   identity sites named in the first amendment now type
   `strategyInstanceId` as `Uuidv7Schema`; the three scope keys remain
   `CodeStringSchema` (vocabulary, not identity), and that boundary is
   mutation-pinned in both directions.
2. **What the base state actually permitted, measured in review:** the
   old typing accepted a re-cased instance id verbatim into the
   commitment tables AND gave it its own `byStrategyInstance` exposure
   key — two spellings of one instance held SEPARATE per-strategy cap
   buckets, a cap-evasion surface. Non-UUID code strings likewise
   reached the tables and exposure keys verbatim. Both are closed
   fail-closed.
3. **The allocator's refusal-evidence shape did NOT change** (unlike the
   risk door's, recorded in ADR-016's 2026-09-06 amendment): the
   allocator already reported `CAPITAL_INPUT_INVALID` with
   `details.issues` on both sides; only the message string moved.
4. **The trader step is dispatched** (`TRDR-1`) with a review-added
   obligation beyond this ADR's original text: the interim
   `UuidAndCodeString` regex is version- AND variant-blind (a
   letter-leading lowercase v4 passes startup and is refused only
   mid-run by the risk door — fail-closed today), so replacing it with
   the real `Uuidv7Schema` is a simultaneous widening (0-leading
   admitted) and tightening (version/variant enforced), and the round is
   accountable for BOTH directions.
