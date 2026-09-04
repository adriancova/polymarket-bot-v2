# Schema parse boundaries: what "validated" is allowed to mean

Owner: contract owner (`GOV-2A`, 2026-09-04)
Authority: [ADR-020](../adr/ADR-020-schema-parse-boundary-integrity.md),
`docs/spec/polymarket-bot-orchestrator-handoff.md` §6 invariants, §7 domain
contracts
Related: [`domain.md`](./domain.md) (the frozen schemas),
[`dependency-direction.md`](./dependency-direction.md) (§2.1 and the built-in
allowlist), [ADR-016](../adr/ADR-016-ratified-inferred-domain-shapes.md)
(identifier canonicality)

---

## 1. The rule

ADR-020 §3: **a boundary that parses caller-supplied or wire-supplied values
parses through a prototype-free door.** A door is prototype-free when it does all
four of:

| # | Step | Why it is not optional |
| --- | --- | --- |
| D1 | **Materialize prototype-free before parsing** — rebuild the value with `Object.create(null)`, reading own properties only | The library reads declared keys off the prototype chain; a materialized tree has no chain to read |
| D2 | **Parse through a severed, warmed arena** — every copied node's `_zod` container severed from `Object.prototype`, every lazy forced at module load | Closes the library's own state reads (`skipChecks`, `optin`/`optout`, `when`, `values`) and the cold-lazy poisoning |
| D3 | **Take values from the materialized tree, not from `parsed.data`** | The library's output assembly invokes inherited setters and can drop or invent fields |
| D4 | **Emit prototype-free** — the door's own result has a null prototype | Closes the output side; an emitted record is read by someone else's `?? default` |

`packages/risk`, `packages/capital-allocator` (`WP-180`) and
`packages/execution-planner` (`WP-190`) implement all four. Their
`plain-data.ts` / `schema-arena.ts` pair is the reference implementation and is
byte-identical across the three packages below its header markers, enforced
three ways by `test/unit/execution-planner/mirrors.test.ts`.

**What is not a door:**

- `z.strictObject`. It refuses an *enumerable* inherited unknown key and is
  blind to a non-enumerable one; it never protected a key the schema declares.
  Measured both ways (§3, F1/F2/F3).
- Parsing the caller's live object and then *using that object*. The two reads
  can disagree.
- Validating a value and handing back the caller's original. That is honest
  about the output but leaves the check itself defeatable (`packages/event-bus`,
  §3 G2).
- The frozen `packages/domain` schemas. They are correct as schemas; the classes
  are properties of the library that runs them (§3 G1).

---

## 2. The measured classes

At the pinned `zod@4.4.3`. Every row was executed by `GOV-2A` against a
`/dev/shm` scratch copy of `main` `2d7e7da`; transcripts in
`docs/handoffs/GOV-2A.md`.

| Class | Pollution | Effect | Warm-safe? |
| --- | --- | --- | --- |
| Adoption | inherited value on a **declared** key | the key lands in the output from the prototype | no — works warm and cold, enumerable and non-enumerable, `object` and `strictObject` |
| Loss | get-only inherited accessor on a declared key | a field present in the input is absent from the output | no |
| Defaults defeated | get-only inherited accessor on a `.default()`ed key | parse succeeds; the default never lands as an own property; any check gated on it skips | no |
| Format checks disabled | inherited `skipChecks` | every `.uuid()`, `.datetime()`, `.regex()`, `.min()` in **every** schema in the process becomes a no-op | no |
| Required-key waiver | inherited `optin` **and** `optout` | required-key enforcement waived | **partly** — the warm compiled fastpass bakes the pair; the interpreted parser and a cold first parse are fooled |
| Custom check skipped | inherited `when` | every custom check (`.refine`, `.superRefine`) is skipped | no |
| Cold-lazy poisoning | any **enumerable** key present during a schema's first parse | the lazy build aborts, throws, and **permanently poisons** that schema object for the process | cold only, but the damage persists |
| Descriptor literals | inherited `get` | every `Object.defineProperty` with an object-literal descriptor throws | no |
| `values` | inherited `values` | fails **closed** (availability, not permission) | no |

**The non-enumerable variant is the one to design against.** Enumerable
pollution is loud: it breaks `for…in`, it trips `strictObject`, and it poisons
cold lazies noisily. Non-enumerable pollution is read by every property read the
library performs and is invisible to every enumeration-based guard.

---

## 3. Per-package audit, `main` `2d7e7da` (2026-09-04)

Exposure column: **caller/wire** = the values parsed arrive from outside the
package; **internal** = the package parses values it built.
Verdict: **LIVE** = a probe changed a real outcome; **CONTAINED** = the class
exists but the package's own structure keeps it off a decision;
**CLOSED** = a prototype-free door per §1.

| Package / app | Door probed | Exposure | Verdict | Severity | Owner |
| --- | --- | --- | --- | --- | --- |
| `packages/domain` (frozen) | `Uuidv7Schema`, `IsoTimestampSchema`, `DecisionResultSchema` | caller/wire (every package parses through these) | **LIVE** — `skipChecks` makes both primitives accept `"NOT-A-UUID"` / `"yesterday"`; every required `DecisionResult` key is satisfiable from the prototype | **HIGH** (root cause; frozen path, so the fix is at the doors) | contract owner — closed by ADR-020 §3 at each door, **not** by editing the frozen package |
| `packages/ledger` (`WP-200`, `7e75f9a`) | `validateTransactionInput` | caller | **LIVE** ×2 — a non-enumerable inherited `marketId` defeats WP-040 obligation **F16** (a fill-booking transaction with no market is ACCEPTED); a non-enumerable `skipChecks` admits `ledgerTransactionId: "totally-not-a-uuid"`, `occurredAt: "yesterday-ish"` | **HIGH** — monetary path, and F16 is a recorded obligation | **WP-200-FU1** (bounded, `packages/{ledger,pnl}/**` + their tests) |
| `packages/pnl` (`WP-200`) | `PnlRecordSchema` and the record schemas | caller | **LIVE** — same classes; additionally the discriminated union **throws an escaped `TypeError`** on a cold first parse under enumerable pollution and is then permanently poisoned | **HIGH** — an escaped throw from a door that documents typed refusals | **WP-200-FU1** |
| `packages/strategy-runtime` (`WP-170`, `9d0971b`) | `validateEvaluationInput` / `acquireEvaluationInput`; the `DecisionResult` parse at `runtime.ts:918` | caller (strategy code) | **LIVE** — D1 is present (materialize-first) and defeats adoption/loss, but the format checks flow through raw domain schemas: under `skipChecks` an input with `evaluatedAt: "yesterday"` and a non-canonical uppercase `marketId` is **accepted**, so ADR-016's "refused, never case-folded" stops being enforced | **HIGH** — §6 invariant 3's one persisted decision, §6 invariant 4's traceability chain | **WP-170-FU1** (bounded, add D2/D3 to the existing materializer) |
| `apps/data-gateway` | `parseGatewayConfig` | caller (operator config) | **LIVE** ×2 — a get-only inherited `tickIntervalMs` defeats its `.default()` and the `dataLossBoundMs` startup check silently passes; an inherited `binance` block satisfies "at least one feed must be configured" | **MEDIUM** — startup-time, operator-supplied, unattended process | **WP-120-FU1** / the next bounded grant on `apps/data-gateway/**` |
| `packages/event-bus` | `validateEnvelope` (Redis wire) | wire | **LIVE** — clean throws `EventBusEnvelopeError`; under non-enumerable `skipChecks` an envelope with `eventId: "not-a-uuid"`, `receivedAt: "yesterday"` is accepted. Returns the caller's own object, so adoption/loss do not apply to the output | **MEDIUM** — the trader's consumption boundary; ordering/dedup keys off these fields | **WP-060-FU1** / the next bounded grant on `packages/event-bus/**` |
| `packages/features` (`WP-160`, `3d49946`) | `computeFeatureSnapshot` (no `zod`); `selectIndexedValues` | caller in, **caller out** | **LIVE (output side only)** — the package carries no runtime schema library and materializes inputs, but `selectIndexedValues` members are ordinary literals: under a non-enumerable inherited `reason` **both** members gain `reason`, and an `ABSENT` member gains a `value` | **MEDIUM** — these values are destined for PostgreSQL indexing next to decisions | **WP-160-FU1** (already carried as `WP-160` R1-L3; this round measured it independently) |
| `packages/binance-adapter` | `decodeFrame`, `BinanceTradePayloadSchema` (`z.looseObject`) | wire | **CONTAINED** — the `looseObject` output does adopt an inherited enumerable key, but `decodeFrame` reads named fields explicitly and its `unknownFields` list is empty under pollution, so the adopted key does not reach the recorded frame | LOW | recorder-pipeline hardening round (§5 item 3) |
| `packages/coinbase-adapter` | `CoinbaseFrameEnvelopeSchema` | wire | **LIVE (routing)** — a missing required `channel` is satisfied from the prototype (`"ticker"`), so a frame routes as a channel it never declared | **MEDIUM** — unattended recorder; misrouting corrupts a recorded dataset | recorder-pipeline hardening round (§5 item 3) |
| `packages/polymarket-public` (incl. rtds) | `RtdsEnvelopeSchema`, `RtdsTwapUpdatePayloadSchema` | wire | **LIVE (routing)** — a missing required `type` is satisfied from the prototype (`"update"`). The TWAP payload's numeric checks are **not** format checks and hold under `skipChecks` | **MEDIUM** — same class and same deployment reality as coinbase | recorder-pipeline hardening round (§5 item 3) |
| `packages/universe` | `registerSeries` / `lifecycle.ts` (consumes `parsed.data` at 10 sites) | wire (gateway-published lifecycle payloads) | **NOT REACHED by probe** — the doors probed refused on type/shape before any format check ran; the `parsed.data` consumption is structurally the adoption/loss class and is **assumed exposed** on the §1 rule | **MEDIUM (unconfirmed)** | next bounded grant on `packages/universe/**`; must probe, not assume |
| `packages/settlement` | `safeParseSettlementSpec` | caller | **NOT REACHED by probe** — same reason | **LOW (unconfirmed)** | next bounded grant on `packages/settlement/**` |
| `packages/order-book` | `validateIngestMeta` (scalar parses only) | wire meta | **LIVE (inherited from `packages/domain`)** — scalar `safeParse` on `UuidSchema` / `IsoTimestampSchema` / `UnsignedBigIntStringSchema`; no object parse, so no adoption/loss | LOW–MEDIUM | next bounded grant on `packages/order-book/**` |
| `packages/risk`, `packages/capital-allocator` (`WP-180`, `98a6cc1`) | every door | caller | **CLOSED** — D1–D4. Probe K3 confirms the arena copy of a domain schema still refuses what the raw schema accepts under `skipChecks` | — | — |
| `packages/execution-planner` (`WP-190`, `5aa11e3`) | every door | caller | **CLOSED** — same mechanism, third mirror | — | — |
| `packages/storage-postgres`, `storage-wal`, `storage-parquet`, `observability` | one `.parse` each, on internally-constructed values | internal | **CONTAINED** | LOW | none assigned; recorded |
| `packages/decimal` | no `zod` | — | n/a — but see `dependency-direction.md` §2.2 and `GOV-2A` `follow_up` 5 for the `divDecimal` explicit-options hazard | — | — |

**Deployment reading, required whenever one of these rows is quoted.** Nothing on
the wire can write `Object.prototype`; every row above needs code already
executing in the process. The rows say *"this check is not load-bearing against
an attacker already inside the process"*, not *"a venue can turn this off"*. The
reason they still matter is that several of them are the *only* enforcement of a
recorded obligation (F16), a run-mode-class ceiling, or an ADR-016 identifier
rule — and the recorder pipeline runs unattended, so nobody is watching when one
of them stops firing.

---

## 4. What a conforming door states

A package claiming conformance says, in its handoff and in the door's own
comment, which of D1–D4 it performs and what it measured. The `WP-180`/`WP-190`
form is the model:

1. the door materializes prototype-free before parsing (D1);
2. all parses go through the warmed arena (D2);
3. values come from the materialized tree (D3);
4. emitted values have a null prototype (D4);
5. **the bound**: under its pollution battery, permission never varies, a
   `SAFETY_CANCEL` is byte-identical, and no throw escapes — refusal
   *composition* may vary (ADR-020 §6).

A door that has not run a battery says so. "It uses `strictObject`" is not a
statement of conformance.

---

## 5. Owner assignments (follow-ups, not implemented here)

1. **`WP-200-FU1`** — `packages/{ledger,pnl}/**` + their tests: the D1–D4 door on
   `validateTransactionInput`, `allocateFill`, `buildFillPosting`, and the PnL
   record parses; the cold-lazy throw on `PnlRecordSchema` closed; a regression
   test per §3 row. Also carries `WP-200`'s existing LOW residual (the
   deep-freeze memoisation set added to before the freeze succeeds).
2. **`WP-170-FU1`** — `packages/strategy-runtime/**`: D2/D3 added to the
   existing materializer, covering the `DecisionResult` parse at
   `runtime.ts:918` and the six scalar identifier parses in `input.ts`.
3. **Recorder-pipeline hardening round** — `packages/{polymarket-public,
   binance-adapter,coinbase-adapter}/**` and `apps/data-gateway/**`: the routing
   adoptions (rtds `type`, coinbase `channel`) and the gateway's two defeated
   startup checks. One round, because they share a deployment story and a test
   shape.
4. **`WP-160-FU1`** — `selectIndexedValues` members routed through the existing
   `ownFrozenTree` / `ownPlainCopy` machinery. **Must land before any consumer
   indexes snapshot values into PostgreSQL.**
5. **Mirror collapse** — `dependency-direction.md` §2.1's pre-authorised row.
   Once `plain-data.ts`/`schema-arena.ts` live in one package, every door above
   consumes one implementation instead of copying a fourth.
6. **Tooling** — a detector that flags a `.safeParse`/`.parse` on a value that
   did not come from a materializer, and a source-scan hardening pass for the
   alias/cast indirection both `WP-160` (R1-N3) and `WP-180` (R9-1) disclosed.
   **Deliberately last**, and deliberately not a CI gate today: a gate every
   merged package fails is a gate that gets waived wholesale
   (`dependency-direction.md` §6.1 item 1).

---

## 6. Binding now

Staging (§5) is about **retrofit**. Two things bind from 2026-09-04:

1. **A new or substantially rewritten boundary that parses caller- or
   wire-supplied values conforms on arrival** (ADR-020 §5). It costs little at
   construction and is expensive later — `WP-180` spent five remediation rounds
   retrofitting two packages.
2. **A `zod` upgrade is a contract change** (ADR-020 §7): re-run
   `WP-180`'s slot-name derivation, re-measure §2, and record the result. It is
   never a lockfile-only edit.
