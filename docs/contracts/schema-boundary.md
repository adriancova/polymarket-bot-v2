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
| `packages/binance-adapter` | `decodeFrame`, `BinanceTradePayloadSchema` (`z.looseObject`) | wire | **LIVE** — a **declared** key missing from the wire is supplied from the prototype. A `trade` frame with `q` deleted is refused clean (`kind=MALFORMED`, `reason=SCHEMA_MISMATCH`) and, under a **non-enumerable** inherited `q`, decodes as `kind=TRADE` with `quantityRaw="999999"` and `unknownFields=[]` (probe M). It flows on: `normalizeTrade` emits `size:"999999"` (`normalize.ts:108`) and the dedup fingerprint becomes `64000.25\|999999\|1700000000000\|false` (`sequence.ts:298`), so a fabricated quantity is both recorded and used as trade identity. **Corrected 2026-09-04 (`GOV-2A` remediation round 1).** The original row measured only *unknown-key* adoption through `looseObject` and read the empty `unknownFields` list as containment; "reads named fields explicitly" (`frames.ts:469-472`) is precisely the mechanism by which the injected value lands, and the empty `unknownFields` is what makes it *silent* rather than what makes it safe | **MEDIUM** — unattended recorder, and the corruption is in the dataset's economic field and its dedup identity (same class and deployment story as the coinbase and rtds rows below) | recorder-pipeline hardening round (§5 item 3) |
| `packages/coinbase-adapter` | `CoinbaseFrameEnvelopeSchema` | wire | **LIVE (routing)** — a missing required `channel` is satisfied from the prototype (`"ticker"`), so a frame routes as a channel it never declared | **MEDIUM** — unattended recorder; misrouting corrupts a recorded dataset | recorder-pipeline hardening round (§5 item 3) |
| `packages/polymarket-public` (incl. rtds) | `RtdsEnvelopeSchema`, `RtdsTwapUpdatePayloadSchema` | wire | **LIVE (routing)** — a missing required `type` is satisfied from the prototype (`"update"`). The TWAP payload's numeric checks are **not** format checks and hold under `skipChecks` | **MEDIUM** — same class and same deployment reality as coinbase | recorder-pipeline hardening round (§5 item 3) |
| `packages/universe` | `applyMarketLifecycleEvent` (`lifecycle.ts:269`; `parsed.data` consumed at 10 sites) | wire (gateway-published lifecycle payloads) | **LIVE** — measured, not assumed (probe O). A `MarketResolved` payload with `outcome` deleted is refused clean (`UNIVERSE_INPUT_INVALID`) and, under a non-enumerable inherited `outcome`, **resolves the market**: `lifecycleState=RESOLVED`, `outcomeState=YES_WIN`. The same holds for `resolvedAt` (a market resolves at `2099-01-01T00:00:00Z`, an instant no event carried) and for `conditionId` — the identity key `checkIdentity` exists to refuse an event naming a different market, and it is satisfiable from the prototype. **Corrected 2026-09-04 (`GOV-2A` remediation round 1)**: the original row read the structure and declined to measure it, which its own rule forbids | **HIGH** — a terminal outcome is the projection's one irreversible transition, restricted by the frozen contract to `MarketResolved` (`domain.md` §6.2, `lifecycle.ts` rule 1), and it is reachable from the prototype; the market's resolved state gates settlement and eligibility | next bounded grant on `packages/universe/**` |
| `packages/settlement` | `safeParseSettlementSpec` (`spec.ts:1429`; `z.strictObject` + `superRefine`) | caller | **LIVE** — measured by a required-key sweep (probe N). Of the 16 own keys of `terminalSpotSpecSample()`, **14 are required** (deleting any one is refused clean) and **all 14 adopt from `Object.prototype`**: `settlementSpecId`, `seriesId`, `specVersion`, `referenceSymbol`, `observationType`, `resolutionSource`, `comparison`, `strikeSource`, `timestampBoundary`, `roundingRule`, `fallbackSource`, `disputePolicy`, `clarificationPolicy`, `verification`. What that means concretely: an adopted `resolutionSource` is a spec that settles against a source **its own text never named**; an adopted `verification` is sharper still — a spec carrying no verification key at all parses as `{status:"VERIFIED"}` and `isReviewedSettlementSpec` returns `true`, which is the gate on model-dependent activation (`activation.ts:128`). **Corrected 2026-09-04 (`GOV-2A` remediation round 1)**: "refused on type/shape before any format check ran" answered a *format-check* question; adoption is a different class and is reached by a ~30-line sweep | **HIGH** — settlement-spec integrity decides payouts; §6 invariant 9 (a change is a new version, never an edit) and ADR-009 §5.4's stated-policy rule both rest on this door, and the review gate is itself adoptable | next bounded grant on `packages/settlement/**` |
| `packages/order-book` | `validateIngestMeta` (scalar parses only) | wire meta | **LIVE (inherited from `packages/domain`)** — scalar `safeParse` on `UuidSchema` / `IsoTimestampSchema` / `UnsignedBigIntStringSchema`; no object parse, so no adoption/loss | LOW–MEDIUM | next bounded grant on `packages/order-book/**` |
| `packages/risk`, `packages/capital-allocator` (`WP-180`, `98a6cc1`) | every door | caller | **CLOSED** — D1–D4. Probe K3 confirms the arena copy of a domain schema still refuses what the raw schema accepts under `skipChecks` | — | — |
| `packages/execution-planner` (`WP-190`, `5aa11e3`) | every door | caller | **CLOSED** — same mechanism, third mirror | — | — |
| `packages/storage-postgres`, `storage-wal`, `storage-parquet`, `observability` | *(none — there is no `zod` door in any of the four)* | — | **n/a — outside this class, measured.** None of the four declares `zod` in its `package.json` or imports it anywhere in `src/`, and none contains a schema parse. Every `.parse(` in their sources is `JSON.parse` or `Date.parse`: `storage-postgres/src/timestamps.ts:63`, `storage-wal/src/raw-frame.ts:149`, four sites in `storage-parquet` (`compactor.ts:759`, `wal-format.ts:517`, `testing/index.ts:43`, `compactor.test.ts:582`), six in `observability` (`soak-evidence.ts:290,293,525,526`, `soak-evidence.test.ts:17`, `render.test.ts:271`). **Corrected 2026-09-04 (`GOV-2A` remediation round 1)**: the original row asserted "one `.parse` each, on internally-constructed values" and a CONTAINED verdict for doors that do not exist — a measured-sounding verdict that was never measured. These packages **do** validate hand-written structures (`parseDatasetManifest`, the WAL frame validators, `parseSoakWindowEvidence`); that is a different class, is not what ADR-020 rules on, and was **not** measured here | — | none; recorded |
| `packages/decimal` | no `zod` | — | n/a — but see `dependency-direction.md` §2.2 and `GOV-2A` `follow_up` 5 for the `divDecimal` explicit-options hazard | — | — |

**The tally, and it is the number every other document must quote.** The table
above carries **LIVE for twelve merged packages and one app**:
`packages/{domain,ledger,pnl,strategy-runtime,event-bus,features,order-book,
binance-adapter,coinbase-adapter,polymarket-public,universe,settlement}` and
`apps/data-gateway`. Three packages are **CLOSED** (`risk`,
`capital-allocator`, `execution-planner`), and five are **outside the class**
(`decimal`, `storage-postgres`, `storage-wal`, `storage-parquet`,
`observability` — no `zod` door). *(Recounted 2026-09-04 in `GOV-2A`
remediation round 1. The round-1 headline said "five merged packages and one
app", which counted neither the `features`, `order-book`, `coinbase-adapter`
and `polymarket-public` rows the same table already carried as LIVE, nor the
three rows that round-1 review corrected — `binance-adapter`, `settlement`,
`universe`.)*

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
   adoptions (rtds `type`, coinbase `channel`), **binance's trade-payload
   declared-key adoption (`q` → `quantityRaw` → normalized `size` and the dedup
   fingerprint; added 2026-09-04 when that row was corrected from CONTAINED to
   LIVE)**, and the gateway's two defeated startup checks. One round, because
   they share a deployment story and a test shape.
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
7. **`packages/settlement` and `packages/universe`** *(added 2026-09-04 when
   both rows became LIVE on measurement — §3)*. Two bounded grants, one per
   package, each owing the D1-D4 door plus a regression test per measured row:
   `safeParseSettlementSpec` / `parseSettlementSpec` and the activation path that
   consumes them (`activation.ts:128`), and `applyMarketLifecycleEvent`'s
   `parsed.data` consumption at all ten sites. **Settlement ranks with the
   monetary follow-ups** (item 1): an adoptable `verification` means the review
   gate on model-dependent activation is not load-bearing. Each owner must probe
   the doors this audit did **not** reach — the other seven lifecycle folds, the
   series-binding doors, and specs other than the sampled one.

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
