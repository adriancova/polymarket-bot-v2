# ADR-016: Ratification of the four unratified `domain.md` §8 inferences (register item R-3)

- **Status:** Accepted
- **Date:** 2026-08-28
- **Recorded by:** `GOV-1B` (orchestrator-authorized contract-owner governance round)
- **Implemented by:** `WP-020` — all four are already implemented and frozen;
  this record ratifies them **as decided** and changes no code
- **Supersedes / Superseded by:** none
- **Amendments:** 2026-09-02 (`GOV-1C`) — §2's external-boundary sentence was
  decided both ways at once ("lowercases it … and a mixed-case value is that
  adapter's typed failure"); the dated block in §2 rules it single-valued:
  **refuse, do not normalize**. Register item **R-8**
  (`docs/contracts/protected-contracts.md` §8.1). The original sentence is
  kept and marked; no other section is touched and no code changed.

## Context

`docs/contracts/domain.md` §8 records the inferences behind the frozen contracts
"explicitly so review can challenge them", and §10 maps each group of decisions
to the ADR that ratified it. The Wave 0 closeout audit found **four §8 rows that
appear in no ratifying ADR** and registered them as
`docs/contracts/protected-contracts.md` §8.1 item **R-3**:

1. `TokenId` — canonical unsigned integer string, no leading zeros;
2. UUIDs — **lowercase only**;
3. incident `severity` — `LOG` / `NOTIFY` / `PAGE`;
4. event **payload field sets beyond §7.4's event-type names** — §7.4 lists types
   only, so the payload shapes are this repository's design.

R-3's own text fixes the disposition: "They are implemented and frozen, so this
is a governance gap, not a code gap: each needs an ADR to accept it as decided,
amend it, or record it as provisional", owned by "the next **ADR-modifying
package**, or an orchestrator governance round, whichever comes first". This is
that governance round.

Each of the four is **accepted as decided** below, with the reason it is the
right decision rather than merely the shipped one, and with what would have to be
true to reopen it. `docs/contracts/domain.md` is **not** edited: it already
states the inferences, and R-3 says so explicitly.

## Decision

### 1. `TokenId` is a canonical unsigned integer string with no leading zeros

Frozen form: `z.string().min(1).max(MAX_IDENTIFIER_LENGTH).regex(/^(?:0|[1-9][0-9]*)$/u)`
— so `"0"` is valid, `"0123"` is not, `""` is not, and `"-1"`, `"1.0"`,
`"1e3"`, and `" 1"` are not.

**Accepted as decided.** Handoff §7.2 types `TokenId` as a "venue integer encoded
as string". A venue integer has exactly one canonical decimal spelling, and one
spelling per identifier is what makes the value usable as a database key, a
stream key, a map key, a hash input, and a metric label without a normalization
step at every comparison site. The alternative — accepting any digit string and
comparing numerically — puts a normalization obligation on every consumer forever
and makes `"07"` and `"7"` two different rows in a database that thinks they are
one token.

Consequences that bind:

- The **adapter** normalizes the wire form before constructing a domain value, in
  exactly the way it already normalizes decimal strings (ADR-001 §3; the domain
  boundary never coerces).
- A leading-zero or non-numeric wire value that cannot be normalized is a typed
  adapter failure plus a data-quality incident, never a silent repair.
- The identifier bound of `MAX_IDENTIFIER_LENGTH` applies (ADR-015 §4).

Reopen only if a venue publishes a token identifier that is **not** an integer,
or one whose leading zeros are semantically significant. Either would be a
schema change with a `schemaVersion` consequence (ADR-002 §3), not a relaxation.

### 2. UUIDs are lowercase-canonical only

Frozen form: `UuidSchema` and `Uuidv7Schema` match `[0-9a-f]` only, with the
RFC 9562 version and variant nibbles pinned (`[1-8]` / `7`, and `[89ab]`).

**Accepted as decided**, on the reason the code already gives: "Lowercase is
required so an identifier has exactly one representation in database keys, stream
keys, and hashes. Every UUID in this system is **generated in-process**, so this
costs nothing at the venue boundary."

That last clause is what makes this cheap rather than strict: no UUID in these
contracts comes off a venue wire, so no external producer can be broken by the
rule. `InternalMarketId`, `eventId`, `gatewayEpoch`, and the strategy/decision
identifiers are all ours.

Consequences that bind:

- Any future component that *receives* a UUID from an external system lowercases
  it **at its adapter boundary**, and a mixed-case value is that adapter's typed
  failure — not a domain-schema relaxation. *(As written 2026-08-28 this
  sentence named both normalize and refuse; the 2026-09-02 amendment below
  rules it: the second half is the rule.)*
- The version and variant nibbles are pinned deliberately: `Uuidv7Schema` exists
  because §7.1 requires time-ordered `eventId`s, and a v4 in that position would
  break the ordering property the field is there to provide.

**Amendment, 2026-09-02 (`GOV-1C`; register item R-8) — the external-boundary
rule is REFUSE, not normalize.**

The first consequence above prescribed two opposite behaviors in one sentence.
The ruling, stated so a future adapter can conform to it or violate it:

1. **A UUID-shaped identifier arriving from an external input surface must
   already be in the canonical lowercase form.** A mixed-case — or otherwise
   non-canonical — spelling is a **typed refusal at that surface, carrying the
   raw value**, exactly the shape ADR-015 §5 prescribes for an over-long
   identifier: never truncation, never a silent repair, never a case-fold.
2. **Why refuse rather than fold, when RFC 9562 makes hex digits
   case-insensitive on input.** Folding would be *technically* safe (the
   grammar is ASCII-only, so Unicode-confusable risk is excluded before any
   fold), and this amendment does not pretend otherwise — the rule is
   repository **boundary hardening** in ADR-015's sense, not a claim about
   UUID semantics. The reasons it is right here:
   - **Every UUID in these contracts is generated in-process** (§2 above), so
     the only way a well-behaved external caller obtains one is from this
     repository — already lowercase. A caller must **round-trip identifiers
     byte-for-byte**; a mixed-case arrival is therefore evidence of a
     transforming pipeline, and the repository's strict-boundary rationale
     applies verbatim: "a silently coerced value hides a real integration
     bug" (`domain.md` §3.2). Refusal rejects nothing a correct caller sends —
     the same property that justified ADR-015's bound.
   - **Folding creates a second accepted spelling at every future surface**,
     and with it the evidence-vs-interpretation split this repository records
     raw frames to avoid: a recorded raw input carrying `ABC…` whose derived
     domain document carries `abc…` makes byte-level reconciliation of
     evidence against interpretation fail on every such identifier.
   - **The established direction is fail-closed** (`WP-110`'s
     placeholder/confusable hardening; ADR-015's typed refusal), and unlike
     the decimal case — where venues *documentedly* emit spellings such as
     `"1.50"` and `normalizeDecimalString` exists for exactly that traffic —
     **no external system is documented or expected to re-case these
     identifiers**, so a fold buys interoperability with nothing known.
3. **Consequences for future adapters and surfaces** (config files, the
   control API, database/import tooling, replay input — uniformly):
   - no adapter may offer a fold-on-input convenience for UUID-shaped
     identifiers, and none may accept uppercase "just for lookups";
   - the refusal is a **typed problem carrying the raw value**, so the
     evidence survives and the caller's defect is diagnosable;
   - this rules external **input** only — it does not change the frozen
     schemas (which already accept lowercase only), does not touch any venue
     wire format (venue identifiers are not UUIDs; their rules are ADR-015's),
     and moves no `schemaVersion` (no emitted field set changed).
4. **Reopen condition:** evidence of a real external system that legitimately
   re-cases repository identifiers **and** a superseding ADR that states how
   recorded evidence disambiguates raw versus folded spellings. Absent both,
   refusal stands.

### 3. Incident `severity` is exactly `LOG` / `NOTIFY` / `PAGE`

Frozen form: `IncidentSeveritySchema = z.enum(["LOG", "NOTIFY", "PAGE"])`.

**Accepted as decided.** This is not an invention: handoff §14.4 defines exactly
three alert tiers — **Page**, **Notify**, **Log** — and enumerates which
conditions belong to each. The contract reuses that vocabulary rather than
inventing a parallel one, so an incident's severity routes directly to the
alerting policy the specification already fixes. A fourth level (a "WARN", a
"CRITICAL") would either duplicate an existing tier or create a routing case
§14.4 does not define.

Consequences that bind:

- Adding a level is a `schemaVersion` change **and** requires §14.4 to gain the
  corresponding routing tier first. The vocabulary follows the alerting policy;
  it does not lead it.
- Severity is a **routing** decision, not a description of harm. `PAGE` means
  §14.4's page list, not "this feels bad".

### 4. Event payload field sets beyond §7.4's type names are this repository's design

Handoff §7.4 lists the 22 minimum event **types**. It does not specify their
payload fields. Every payload shape in `packages/domain/src/events/**` is
therefore ours, informed by §9.1–§9.4.

**Accepted as decided**, with the boundaries that make it reviewable:

1. **The design is accepted as a whole, as frozen by `WP-020`** — not field by
   field in this record. What is being ratified is that a payload shape is a
   repository design decision rather than a transcription of the handoff, and
   that this is legitimate because §7.4 leaves it open.
2. **Every payload field must still trace to a specification statement or a
   recorded inference.** §8's other rows, ADR-002 §6 (the
   `TradingParametersChanged` vocabulary, with its per-member citation table),
   ADR-005 §7, ADR-009 §3–§4, and ADR-002 §5 (the reserved `venue` key) are the
   existing instances; new payloads follow the same discipline.
3. **A payload may not encode a volatile venue fact as a frozen shape** (ADR-002
   §6's fee-schedule/`negRisk` reasoning; handoff §1.2). Where a shape would
   freeze a venue fact, the contract carries an opaque handle instead
   (`parameterVersionRef`).
4. **Changing a payload field set is a `schemaVersion` change** (ADR-002 §3), and
   this ratification grants no additive-field exemption.
5. **Ratifying the design is not ratifying every field as correct.** A defect in
   a specific payload is still a defect, fixed under
   `protected-contracts.md` §3/§3.1 with a version consequence stated. What this
   record removes is only the *governance* gap — that the design existed with no
   ADR accepting it — not the possibility of error.

## Consequences

- **Register item R-3 is discharged** and leaves `protected-contracts.md` §8.1
  by ratification, which is one of the two exits its own rule allows (the other
  being done-with-evidence). It is not quietly dropped.
- **No code changes, no version bumps.** All four are already implemented and
  frozen. **Schema-version consequence for recorded data: no emitted field set
  changed, therefore `schemaVersion` is unchanged** (ADR-002 §3).
- **Four decisions now have a supersession path.** Before this record, changing
  any of them meant editing a frozen package with no ADR to supersede — the exact
  situation `protected-contracts.md` §3.1 was written to prevent.
- **`domain.md` §8 keeps its "so review can challenge them" framing**, and this
  ADR is the record of the challenge having been made and answered. §8's other
  rows remain ratified by ADR-001, ADR-002, ADR-005, and ADR-009 as §10 records.
- **`domain.md` §10's cross-reference table does not yet name this ADR**, because
  a governance round confined to `docs/adr/**` and the registers may not widen
  its own allowed paths. Recorded as a follow-up in
  `protected-contracts.md` §8.1 so the map is completed by a package that owns
  `docs/contracts/domain.md`, rather than left to memory.

## Evidence

**The register item:**

- `docs/contracts/protected-contracts.md` §8.1 item **R-3**, including its own
  disposition ("each needs an ADR to accept it as decided, amend it, or record it
  as provisional") and its owner ("the next ADR-modifying package, or an
  orchestrator governance round, whichever comes first").

**The inferences being ratified** (`docs/contracts/domain.md` §8, verbatim rows):

| Row | Stated rationale in §8 |
| --- | --- |
| `TokenId` = canonical unsigned integer string, no leading zeros | "§7.2 says 'venue integer encoded as string'; adapters normalize first, as they do for decimals" |
| UUIDs lowercase only | "one representation per identifier; all UUIDs here are generated in-process" |
| Incident `severity` = `LOG` / `NOTIFY` / `PAGE` | "reuses the §14.4 alert vocabulary" |
| Event payload fields beyond §7.4's names | "§7.4 lists event types only; payload shapes are our design, informed by §9.1–§9.4" |

**Frozen implementation** (read 2026-08-28):

- `packages/domain/src/identifiers.ts` — `TokenIdSchema`'s regex; `UUID_PATTERN`
  and `UUID_V7_PATTERN`; the module header's own statement of the §7.2 mapping.
- `packages/domain/src/events/feed.ts` — `IncidentSeveritySchema`, with the
  header note "`severity` uses the §14.4 alert vocabulary".
- `packages/domain/src/events/**` — the payload shapes themselves.

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §7.1 — the envelope, including the time-ordered `eventId` requirement that
  `Uuidv7Schema` serves.
- §7.2 — the identifier list; `TokenId` as "venue integer encoded as string";
  the identifiers it leaves unformatted.
- §7.4 — the 22 minimum event **types**, with no payload field lists.
- §9.1–§9.4 — the gateway/book responsibilities the payload shapes are informed
  by.
- §14.4 — the three alert tiers (**Page**, **Notify**, **Log**) and their
  membership, read for this record.

**Related ADRs:** ADR-001 §3 (adapters normalize; the boundary never coerces),
ADR-002 §3 (version per emitted-field-set change), §5 (reserved `venue` key), §6
(`TradingParametersChanged`'s cited vocabulary), ADR-005 §7 and ADR-009 §3–§4
(the §8 rows already ratified), ADR-015 §4 (the identifier bound that also
applies to `TokenId`).

**Safety:** this ADR changes no run-mode default (ADR-010).
