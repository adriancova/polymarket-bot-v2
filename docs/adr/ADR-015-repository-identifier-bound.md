# ADR-015: The repository identifier bound is a boundary-hardening decision, not a venue narrowing

- **Status:** Accepted
- **Date:** 2026-08-28
- **Recorded by:** `GOV-1B` (orchestrator-authorized contract-owner governance round)
- **Implemented by:** `WP-020` (`MAX_IDENTIFIER_LENGTH = 200` — already shipped,
  frozen, and **unchanged** by this record); `WP-070` (the typed refusal above
  the bound, shipped); every adapter that parses a venue identifier
- **Supersedes / Superseded by:** none. This record **refines**
  [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) §7's condition-id
  row, which is amended in place to point here.

## Context

`WP-000`'s fixture catalogue narrowed `conditionId` to 31/32 bytes, while the
official SDK's `ConditionIdResponseSchema` "validates hex syntax without
constraining the condition ID byte length" (`docs/venue/verified-2026-08-24.md`
§7.1). ADR-002 §7 and `docs/contracts/protected-contracts.md` §9 therefore
required a runtime parser to "accept **any** hex condition id the SDK accepts (no
31/32-byte bound at runtime)".

`WP-070` implemented that — a 4-character id and a 128-character id both parse —
and then found the rule as written is **not literally satisfiable**, because the
frozen domain contract independently bounds identifier length:

```text
packages/domain/src/primitives.ts:  MAX_IDENTIFIER_LENGTH = 200
                                    NonEmptyStringSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH)
packages/domain/src/identifiers.ts: ConditionIdSchema = VenueIdentifierSchema = NonEmptyStringSchema
```

An id of 201 characters therefore cannot reach any domain payload, whatever the
adapter does. `WP-070` shipped the honest version of this — ≤ 200 accepted and
carried through unchanged, > 200 refused as a typed `INVALID_CONDITION_ID`
problem carrying the raw frame (never a throw, never a silent drop, never a
truncation) — declared the §9 row "discharged **in substance**, not literally",
and flagged the contradiction for the contract owner rather than editing a frozen
package or quietly narrowing the claim. Its round-1 review had raised exactly
this as finding M2: "a contract-level contradiction the adapter cannot
discharge".

The question for this round is which of the two texts is wrong.

## Decision

### 1. The 200-character bound stays, and is not a venue narrowing

`MAX_IDENTIFIER_LENGTH = 200` is a deliberate, repository-wide
**boundary-hardening** decision, in the same family as `MAX_DECIMAL_STRING_LENGTH`,
`MAX_CODE_LENGTH`, and `MAX_DETAIL_LENGTH` (`docs/contracts/domain.md` §7). Its
purpose is stated there and is not about the venue at all: a process parsing
untrusted frames must bound what it will hold, and metric-label cardinality and
database column widths must be predictable.

The `WP-000` narrowing rule is about a **different** thing: not inheriting a
*fixture's* documentation-fidelity strictness into a runtime parser. The 31/32-byte
narrowing is such a strictness and remains rejected. A repository-wide safety
bound is not, and a rule against fixture narrowings does not repeal it.

### 2. The narrowing rule, restated

The binding form of the condition-id row, replacing "accept **any** hex condition
id the SDK accepts" everywhere it appears (ADR-002 §7,
`protected-contracts.md` §9):

> **No 31/32-byte narrowing.** An adapter accepts any SDK-accepted hex condition
> id **up to the repository identifier bound** (`MAX_IDENTIFIER_LENGTH` = 200,
> this ADR). **Beyond the bound, a typed refusal is the correct adapter
> behavior** — a problem carrying the raw frame, routed like any other data-quality
> failure — never a truncation, never a silent drop, and never a throw that loses
> the frame.

### 3. The bound is checked at the venue edge, and that is not a second bound

An adapter **should** check the bound itself rather than letting a domain parse
fail at emission time. It is the same bound, checked earlier, and the difference
is diagnostic quality: `WP-070` turns an over-long id into a typed
`INVALID_CONDITION_ID` problem carrying the raw frame instead of a generic
`PAYLOAD_CONTRACT_VIOLATION` at emission. An adapter that does **not** check
early is still conforming, as long as the failure is typed and the frame is
preserved (handoff §8.3 forbids the silent drop either way).

### 4. It applies to every identifier-like domain string, not just `conditionId`

`ConditionId`, `VenueOrderId`, `VenueTradeId`, `TokenId`, and every other
`NonEmptyStringSchema`-derived identifier share the bound. One bound, defined in
one place. An adapter that special-cases one identifier's length has invented a
second policy.

### 5. Why 200 is the right number today, on evidence

- A real Polymarket condition id is **66 characters** (`0x` + 32 bytes hex). The
  bound leaves roughly **3× headroom**.
- The 31-byte form the fixtures also allow is 64 characters.
- The venue's own schema declares **hex syntax without a length bound**, so there
  is no documented venue maximum to match; any finite bound is ours, and 200 is
  the one already frozen and already load-bearing across every identifier.
- Nothing observed, documented, or fixtured in this repository exceeds 200.

The bound is therefore **not** currently rejecting any real venue traffic, which
is what distinguishes it from the 31/32-byte narrowing, which would have.

### 6. If the venue ever publishes a longer identifier

The typed refusal makes that observable rather than silent — that is the point of
§2's "never a truncation". The remedy is:

1. a **new ADR** (or an amendment to this one under orchestrator approval)
   recording the evidence and the new bound;
2. an orchestrator-authorized **bounded repair package** owning
   `packages/domain/**` (`protected-contracts.md` §3.1), because the bound lives
   in a frozen package;
3. an explicit **schema-version consequence** statement (ADR-002 §3) — raising a
   `max()` widens a constraint, which §3 lists as a change requiring a new
   version, so the repair package states the version consequence for every
   affected event type rather than assuming a widening is free.

It is **not**: an adapter-side workaround, a truncation, a hash of the id, or a
per-package constant.

### 7. `WP-070` is ratified as conforming, and the row is closed for it

`WP-070`'s shipped behavior — ≤ 200 accepted (asserted at 4/42/66/98/200
characters), 201 refused as a typed problem carrying the raw value — **is** the
correct implementation of §2. The §9 row is **closed** for `WP-070`; its
"discharged in substance, not literally" caveat is superseded by this ADR, which
changes the rule's wording so that what `WP-070` ships is also the literal rule.

**Schema-version consequence for recorded data:** no `packages/domain` file is
modified by this record and no emitted field set changed, therefore
**`schemaVersion` is unchanged**.

## Consequences

- **The rule is now satisfiable as written**, which matters more than it sounds:
  a contract requirement no implementation can literally meet trains reviewers to
  accept "in substance" discharges, and the next one may not deserve it.
- **A 201-character condition id is data loss by policy.** It is refused, loudly
  and with the raw frame preserved, and no market it names is traded until the
  bound is raised. That is the intended failure mode for an untrusted-input
  bound, and it is a real (if remote) availability risk, recorded here rather
  than discovered live.
- **The bound is now a documented decision rather than an incidental constant**,
  so a future package cannot quietly raise it "because a venue field is long".
  §6 is the only route.
- **`docs/venue/verified-2026-08-24.md` §7.1 and §17 keep their wording.** A
  merged report is a frozen dated snapshot (`protected-contracts.md` §2). On this
  architectural point it is superseded by ADR-002 §7 as amended and by this
  record, exactly as the Wave 0 closeout's H1 correction handled the sibling
  `null`-acceptance case: the report governs the **venue fact** (the SDK declares
  no length bound — unchanged and binding), the handoff and its ADRs govern which
  internal component bounds it.

## Evidence

**Frozen implementation** (read 2026-08-28):

- `packages/domain/src/primitives.ts` — `MAX_IDENTIFIER_LENGTH = 200`;
  `NonEmptyStringSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH)`.
- `packages/domain/src/identifiers.ts` — `ConditionIdSchema =
  VenueIdentifierSchema = NonEmptyStringSchema`; `TokenIdSchema` additionally
  `.max(MAX_IDENTIFIER_LENGTH)`.
- `docs/contracts/domain.md` §7 — the boundary-hygiene table, verbatim: "These
  bounds are not venue facts. They are boundary hygiene for a process that parses
  untrusted frames, and they keep metric-label cardinality and database column
  widths predictable."

**The rule being amended:**

- [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) §7, condition-id
  row (amended in place to cite this ADR).
- `docs/contracts/protected-contracts.md` §9, second bullet (amended in the same
  change).
- `docs/venue/verified-2026-08-24.md` §7.1 — `ConditionIdResponseSchema`
  "validates hex syntax without constraining the condition ID byte length"; §17 —
  the fixture-narrowing list. Frozen; not edited.

**Implementation and prior handoffs:**

- `packages/polymarket-public/README.md` §4.1 — "One §9 narrowing is discharged
  in substance, NOT literally", with the two-row behavior table and the statement
  that 200 "is not the venue's: it is `MAX_IDENTIFIER_LENGTH` in the frozen
  `packages/domain`".
- `docs/handoffs/WP-070.md` — review round 1 finding **M2** and its remediation
  (the any-length claim withdrawn in place; the boundary asserted at 200/201);
  remediation round 1 `follow_up` 1, which names the three resolution options and
  states that all three are outside an implementing package's allowed paths. This
  record takes the first option (amend the rule) and explicitly declines the
  second (raise or remove the cap).
- `test/contract/polymarket-public/narrowings.test.ts` and
  `packages/polymarket-public/src/normalize/values.test.ts` — the boundary is
  asserted at the exact characters (accepted at 4/42/66/98/200, rejected at 201).
  Those tests already encode §2 and need no change.
- `IMPLEMENTATION_STATUS.md` → "Contract-owner items accumulated from batch 1B
  round 1", item 3.

**Safety:** this ADR changes no run-mode default (ADR-010). It also relaxes no
input bound: the frozen `max()` is unchanged.
