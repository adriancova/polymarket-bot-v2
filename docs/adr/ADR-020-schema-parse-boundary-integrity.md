# ADR-020: A schema parse result is not clean data — prototype-mediated boundary integrity

- **Status:** Accepted
- **Date:** 2026-09-04
- **Recorded by:** `GOV-2A` (cross-package schema-boundary governance round)
- **Implemented by:** `WP-180` (`packages/risk`, `packages/capital-allocator`) and
  `WP-190` (`packages/execution-planner`) already conform by mechanism. **No other
  merged package does**, and the staged owner assignment in §5 is the plan. This
  ADR records the decision; it changes no code.
- **Supersedes / Superseded by:** none. Refines the §6 invariant set and
  [ADR-016](./ADR-016-ratified-inferred-domain-shapes.md) (identifier
  canonicality) by stating what "validated" is allowed to mean.

---

## Context

The repository pins `zod@4.4.3` and every package validates at its boundary with
it. `WP-180`'s round-6 mechanical census found — and its rounds 7 to 10 measured
in detail — that `zod` reads its own parse state, its own per-node configuration,
and the input object's properties **through the prototype chain**. A successful
`safeParse` therefore guarantees neither that the output matches the input, nor
that the checks the schema declares actually ran.

`WP-180` closed its own paths by mechanism and escalated the class as
repository-wide (its follow-ups R6-3, R9-2 and the `IMPLEMENTATION_STATUS.md`
"Cross-package risk" record). The class spans packages no single work package
owns; this ADR is the ruling that escalation asked for.

**What is new here is not the class — it is the measurement.** `GOV-2A` audited
every merged raw-`zod` boundary against a `/dev/shm` scratch copy of `main`
(`2d7e7da`), with executed probes rather than reading. The audit found **live
fail-opens in twelve merged packages and one app** (the tally is
`docs/contracts/schema-boundary.md` §3; three of the twelve —
`binance-adapter`, `settlement`, `universe` — were measured in this ADR's
round-1 review remediation, which overturned two "not reached by probe" rows
and one wrong CONTAINED verdict), including two that defeat a recorded `WP-040`
obligation and a gateway startup safety check, one — the frozen
`§7.5 DecisionResult` schema — where **every required key can be supplied from
`Object.prototype`**, and a settlement spec whose own review status is
adoptable. It also found a variant nobody had recorded: the
**non-enumerable** form of the pollution, which defeats the accidental
`z.strictObject` protection that made several of these boundaries look safe.

This is not a claim that the repository is under attack. `Object.prototype`
pollution requires code already running in the process. The decision below is
about what a boundary is entitled to *promise*, and about not building monetary
and safety logic on a guarantee the library does not give.

---

## Decision

### 1. A raw `zod` parse result is not validated data, and no code may treat it as such

Concretely, at `zod@4.4.3`, all of the following are measured behaviour
(transcripts in `docs/handoffs/GOV-2A.md`; classes A1–A9):

1. **Adoption.** A key the schema declares — required *or* optional — is read
   off the prototype chain when the input lacks it, and lands in the output.
   Measured for `z.object` and `z.strictObject`, warm and cold.
2. **Loss.** A get-only inherited accessor makes the library's own output
   assignment fail, so a field present in the input is **absent** from the
   output.
3. **Defaults defeated.** The same accessor defeats a schema's own `.default()`:
   the parse succeeds and the defaulted key never lands as an own property.
4. **Format checks disabled wholesale.** One inherited `skipChecks` turns every
   `.uuid()`, `.datetime()`, `.regex()`, and `.min()` check in **every** schema
   in the process into a no-op — including the frozen `packages/domain`
   primitives every package parses through.
5. **Required-key waiver.** An inherited `optin`/`optout` pair waives required-key
   enforcement on the interpreted parser and on a **cold** first parse. A warm
   compiled fastpass bakes the pair and is not fooled — an order-dependence, not
   a defence.
6. **Custom checks skipped.** An inherited `when` skips every custom check.
7. **Cold-lazy poisoning.** Enumerable pollution present during a schema's
   **first** parse aborts the lazy build and **permanently** poisons that schema
   object: every later parse, in a clean process, throws.
8. **Descriptor literals.** An inherited `get` makes every `Object.defineProperty`
   written with an object-literal descriptor throw `TypeError`.
9. **`values` reads** fail closed (availability, not permission) — recorded for
   completeness.

### 2. `z.strictObject` is not a mitigation

`z.strictObject` refuses an **enumerable** inherited unknown key as
`unrecognized_keys`, which made several merged doors look immune. It does not
see a **non-enumerable** one, and it never protected a key the schema itself
declares. Both were measured: the same ledger door that refuses an enumerable
`skipChecks` accepts a non-enumerable one and admits `"totally-not-a-uuid"` as a
`ledgerTransactionId`. **A door may not cite `strictObject` as its defence.**

### 3. A boundary that parses caller-supplied or wire-supplied values parses through a prototype-free door

The door is `WP-180`'s shipped mechanism, and the obligation is on the door, not
on the schema:

1. **Materialize prototype-free before parsing.** The value handed to `zod` is a
   tree the package built with `Object.create(null)`, reading only own
   properties. `WP-170`'s `materializeEvaluationViewAt` and `WP-160`'s input
   materialization are the same shape.
2. **Parse through an arena** whose per-node `_zod` containers are severed from
   the ordinary prototype chain and warmed at module load, so no lazy structure
   remains for a polluted first parse to build.
3. **Take every value from the materialized tree**, never from the library's
   constructed output.
4. **Emit prototype-free.** The door's own output is built with a null
   prototype, so the boundary is closed in both directions.

The mechanism is proven, not hypothesised: the same `Uuidv7Schema` that accepts
`"NOT-A-UUID"` under inherited `skipChecks` still refuses it when copied through
the arena (`GOV-2A` probe K3).

### 4. "Internally constructed" and "caller/wire supplied" are different exposure classes and are ranked differently

- **Caller/wire-supplied.** Venue frames, Redis envelopes, strategy return
  values, ledger transaction inputs, gateway configuration. A fail-open here
  changes what the system accepts. **These are the ones that must be closed.**
- **Internally constructed, parsed defensively.** A package parsing a value it
  built in the same function. A fail-open here is a lost assertion, not an
  admitted lie. Recorded, not prioritised.

Severity additionally accounts for deployment reality. The recorder pipeline
(adapters → `apps/data-gateway`) runs unattended against live venue data, so a
fail-open there is unsupervised — but reaching it requires a **compromised
process first**, because nothing on the wire can write `Object.prototype`. A
probe result therefore means "this check is not load-bearing against an attacker
already inside the process", not "a venue can turn this off". Both halves must be
stated whenever one of these findings is reported.

### 5. Adoption is staged, and every stage has a named owner

No package is required to retrofit the door in a round it does not own. The
staging is by measured exposure, and the owners are recorded in
`docs/contracts/schema-boundary.md` **§5** and in `GOV-2A`'s `follow_up`. **A new or
substantially rewritten boundary opened after this date conforms on arrival** —
that is the part that binds immediately, because it costs nothing at
construction time and is expensive to retrofit.

### 6. No refusal, cancel, or permission decision may vary with ambient prototype state

`WP-180` measured, with a ~7,000-**call** tuned pollution battery, that refusal **composition**
(message, path, issue ordering) can vary while permission never does and cancels
stay byte-identical. That is the bound, and it is the bound every conforming
door must keep: **composition may vary; permission may not, and a `SAFETY_CANCEL`
must be byte-identical.** A door that cannot state this bound has not been
measured.

### 7. The `zod` pin is load-bearing and its upgrade is gated

`zod@4.4.3` is pinned. `WP-180`'s `inherited-state.test.ts` re-derives the
consulted `_zod` slot names from the shipped source (18 at this version) and
fails on any upgrade that consults a new slot. **A `zod` upgrade is a contract
change**: it requires re-running that derivation and re-measuring §1's classes,
and it may not be a lockfile-only edit.

---

## Consequences

**What this costs.** The door is real work per boundary: a materializer, an
arena, and a test battery. `WP-180` spent five remediation rounds on it for two
packages. Staging (§5) is the only way this is affordable, and staging means the
repository knowingly runs with open boundaries in the meantime — recorded in
`IMPLEMENTATION_STATUS.md` under `## Open blockers` rather than left implicit.

**What it forecloses.** "The schema validated it" stops being a sufficient
argument in review. A door that wants to claim a validated value must say which
of §3's four steps it performs.

**What breaks if it is changed later.** If a future round decides the class is
acceptable and drops the door, `WP-180`/`WP-190` lose the property their
acceptance rests on, and the §6 invariant 3 decision record, the §9.15 ledger,
and the run-mode ceiling all revert to being enforceable only in an unpolluted
process. That is a superseding-ADR decision, not a package-level one.

**What it deliberately does NOT do.**

- It does **not** claim the repository is presently exploited, or that any venue
  input can reach `Object.prototype`. It cannot: nothing measured here is
  reachable without code already executing in the process.
- It does **not** add a CI rule. A gate that every merged package fails is a gate
  that gets waived wholesale — the failure mode
  `docs/contracts/dependency-direction.md` §6.1 item 1 ruled against. Tooling is
  a follow-up owner assignment (`docs/contracts/schema-boundary.md` §5).
- It does **not** change any run-mode default, credential boundary, or safety
  ceiling. `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, and both live-micro
  caps at `0` are untouched.
- It does **not** change `packages/domain`. The frozen schemas are correct as
  schemas; §1 is a statement about the library that runs them.

---

## Evidence

- **Measured classes and every per-package verdict:** `docs/handoffs/GOV-2A.md`
  (probe transcripts A–L), run against a `/dev/shm` scratch copy of `main`
  `2d7e7da` installed with `pnpm install --frozen-lockfile`, `zod@4.4.3`
  confirmed from the resolved store path.
- **Origin and the closed reference implementation:** `docs/handoffs/WP-180.md`
  — round-6 census, round-7 three live fail-opens (including `maxRunMode`),
  round-8 `skipChecks` and descriptor literals, round-9 `optin`/`optout`, `when`,
  `values`, cold-lazy poisoning and the arena's sever/warm mechanism, round-10
  independent confirmation (nine probe campaigns, a ~7,000-call tuned pollution
  battery).
- **Third conforming instance:** `docs/handoffs/WP-190.md` (the mirrored
  `plain-data.ts` / `schema-arena.ts` in `packages/execution-planner`, drift-
  guarded three ways).
- **Corroborations from batch 2B:** `docs/handoffs/WP-160.md` R1-L3 (output-side
  adoption in `selectIndexedValues`), R1-N3 / `WP-180` R9-1 (regex detectors are
  dodgeable), the `divDecimal` explicit-options disclosure; `docs/handoffs/WP-190.md`
  R1-N2/N4.
- **Handoff sections:** §6 invariants 1, 3, 4, 7, 12, 17; §7 (domain contracts
  are Zod schemas); §7.5 (`DecisionResult`); §9.15 (ledger); §11 (run modes).
- **Contract:** `docs/contracts/schema-boundary.md` (this ADR's normative
  companion — the audit table, the door definition, and the owner assignment).
- **No venue fact is asserted by this ADR.** Nothing here is observational: no
  payout, balance, order, or credential was involved, and no network call was
  made.
