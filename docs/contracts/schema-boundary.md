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

`packages/risk` implements all four; its `plain-data.ts` / `schema-arena.ts`
pair is the canonical implementation. *(Corrected 2026-09-05: the pair was
originally mirrored byte-identically into `packages/capital-allocator` and
`packages/execution-planner`; `WP-180-FU2` (merged `625c83b`) collapsed the
mirrors to the one canonical copy in `packages/risk`, consumed over the §2.1
same-layer rows — S3/S4 (`WP-180`/`WP-190`), and since `WP-200-FU1` (merged
`a30fec8`) also S5/S6 (`packages/ledger`, `packages/pnl`). A repo-wide
deletion guard in `test/unit/execution-planner/mirrors.test.ts` forbids any
copy, and per-edge door-only pins live in `test/unit/risk/ports.test.ts`,
`test/unit/execution-planner/ports.test.ts` and
`test/unit/ledger/ports.test.ts`.)*

**What is not a door:**

- `z.strictObject`. It refuses an *enumerable* inherited unknown key and is
  blind to a non-enumerable one; it never protected a key the schema declares.
  Measured both ways (§3, F1/F2/F3).
- Parsing the caller's live object and then *using that object*. The two reads
  can disagree.
- Validating a value and handing back the caller's original. That is honest
  about the output but leaves the check itself defeatable. Historical example:
  `packages/event-bus` before `WP-060-FU1` (`d869868`, 2026-09-11);
  its current closure is recorded in §3.
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

Further classes and refinements were measured after `GOV-2A`, by the named
work packages rather than by the `2d7e7da` transcripts, and bind the same way:

| Class | Pollution | Effect | Warm-safe? |
| --- | --- | --- | --- |
| Numeric-name family *(measured by `WP-200-FU1`, `WP-020-FU1`, `WP-170-FU1`)* | a numeric-named property (`"0"`, `"1"`, …, and the non-index `"-1"`) on `Object.prototype` or `Array.prototype`, enumerable or not | not a zod-lazy class — it hits ANY code path that consults the prototype chain through array reads: `decimal.js` result assembly corrupts or aborts (array-index names — covered by `withNeutralIndexNames`, `domain.md` §3.6), iterative walkers throw or hang (`WP-170-FU1`'s walk-stack escape; its `topOf` `"-1"` hang — a NEGATIVE name outside the decimal guard's index regex, guarded per-site), constructors refuse (`WP-200-FU1`'s index-`0` interference). Guarded code fails closed (`DECIMAL_HOSTILE_PROTOTYPE`; typed refusals); unguarded code ESCAPES with bare `TypeError`s or hangs | n/a — schema warmth is irrelevant; the defense is prototype-free structures, `withNeutralIndexNames` for array-index names, or guards written per site |
| Error construction *(measured by `WP-230` review r1; independently confirmed)* | any class above, present when a REFUSAL is being built | **the warmed arena protects the parse, not zod's error construction**: `safeParse(INVALID)` can THROW out of the refusal path (e.g. under inherited `get` — the descriptor-literal class — while zod assembles its issues), converting a clean refusal into an escaped exception | no — a warm schema still constructs errors lazily per refusal. A CONFORMING door must contain its refusal construction inside `contained(...)` or equivalent exception containment (ADR-020 amendment 2026-09-06); boundaries not yet through a door retain their §3 audit status |
| Waiver reach + durability; the `status` trigger *(measured by `SETL-1`, confirmed by its review's own cold-isolated probes)* | inherited `optin` **and** `optout` present during a schema's COLD first parse; separately, an inherited `status` during a cold `discriminatedUnion` parse | Two refinements of the rows above. (1) The required-key waiver DOES reach a `.superRefine`-carrying `strictObject` (`SettlementSpecSchema`) — **cold parses only, and DURABLY**: a schema whose first parse ran under the pair stays waived after the pollution is removed; a schema warmed on one honest parse first is immune. (An earlier `SETL-1` round-1 claim that superRefine schemas were unreachable was retracted — its probe harness warmed first; the reversal was review-adjudicated correct.) (2) The cold-`discriminatedUnion` lazy build throws `propValues[key].add is not a function` under an inherited **`status`** — the same key a verification-cell attack sets, so the poisoning trigger and the attack key coincide on this schema family | cold-only for both; the waiver damage and the poisoning both persist for the process. *(Corroborated on a second schema family 2026-09-07 by `CLOB-1`'s review: one polluted COLD parse of the market-event `discriminatedUnion` durably bricks base `parseMarketEvent` — later clean parses throw `Invalid discriminated union option` after the pollution is removed — and the trigger family is broader than the recorded TypeError: an accessor-variant pollution throws the union-option error directly. The tip door routes via an own `event_type` read, so the cold-lazy build is off its path.)* |
| Lookup-table adoption + refusal-detail parses *(measured by `SETL-2`, 2026-09-07)* | inherited value on a NON-declared key consulted by a frozen object-literal lookup table; any hostile class present while a refusal DETAIL is computed by a zod parse | Two refinements of the adoption and error-construction rows. (1) A frozen object-literal lookup (`matrix[key]`) answers from `Object.prototype` for a key outside its own properties — turning a documented non-throwing function into an escaping `TypeError` (and `isCompatiblePayoffModel("toString")` → `true`). Freezing protects the declared cells, not the lookup. (2) A refusal detail computed by a zod parse (`payoutPerShare`'s `terminal` detail) is inside the ADR-020 2026-09-06 amendment's blast radius — `_zod`/`value`/`get`/`set`/`writable` pollution throws out of the refusal path unless contained | n/a for (1) — no schema involved; the defenses are own-property lookups (`Object.hasOwn` before indexing) and containment around detail computation |

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
| `packages/ledger` (`WP-200`, `7e75f9a`; door: `WP-200-FU1`, `a30fec8`) | every door (`validateTransactionInput`, `Ledger.empty/append/rebuild`, `allocateFill`, `buildFillPosting`, the eight `balance.ts` exports) | caller | **CLOSED** (2026-09-05) — D1–D4 through the canonical `packages/risk` door over §2.1 row S5, door-only pinned by `test/unit/ledger/ports.test.ts`. The original LIVE ×2 measurement (the non-enumerable `marketId` F16 defeat; non-enumerable `skipChecks` admitting garbage ids) reproduced at base `761db76` and refused at the tip; verified by two review rounds (r2: independent divergence census — zero PERMISSION, zero ESCAPE; honest fold byte-identical base→tip). Disclosed residual: a fail-closed availability class at index `"0"` (constructors refuse under inherited index-`0` interference; widening owned by the `packages/risk` grant-and-widen round) — `docs/handoffs/WP-200-FU1.md` | — | — |
| `packages/pnl` (`WP-200`; door: `WP-200-FU1`, `a30fec8`) | every door (`applyPnlRecord`, `emptyPnlState`, `foldPnlRecords`, `computePnlSnapshot`, `PnlSettlementEvidence.from`, `toPnlSnapshotRow`) | caller | **CLOSED** (2026-09-05) — D1–D4 through the canonical `packages/risk` door over §2.1 row S6, same pins. The original LIVE classes reproduced at base and refused at the tip, including the cold-first-parse escaped `TypeError` and its permanent poisoning (the base also threw a bare `TypeError` from `emptyPnlState` under inherited index-`0` interference — a pre-existing escape the door converts into the typed `PnlConfigurationError` channel, measured in `WP-200-FU1` remediation r1 and confirmed in r2) | — | — |
| `packages/strategy-runtime` (`WP-170`, `9d0971b`; door: `WP-170-FU1`, `d89841d`) | `validateEvaluationInput` / `acquireEvaluationInput`; the `DecisionResult` parse (now through `parse-door.ts`); the run-seed door; the raw `modelOutputs` parse | caller (strategy code) | **CLOSED** (2026-09-06) — D1–D4 through the canonical `packages/risk` door over `dependency-direction.md` §2.1 row S7, door-only pinned by `test/unit/strategy-runtime/ports.test.ts`. The original LIVE measurement (`skipChecks` admitting `evaluatedAt: "yesterday"` + an uppercase `marketId`) reproduced at base `53e9f62` and refused at the tip, along with ten further measured base defeats (five format-bearing scalars, the garbage-`DecisionResult` persistence, the run-seed door, the walk-stack index-name escape, 19 escaped zod error-construction TypeErrors) and a twelfth (enumerable-key availability) confirmed in review; two review rounds, r2 ACCEPT (the r1 HIGH cold-lazy poison on the `.pick` split and the r1 MEDIUM nested-`__proto__` emission both closed in remediation and verified by independent reproduction at base/candidate/tip). Disclosed residuals: a fail-closed availability class — non-enumerable inherited `values` CONTAINS an honest `modelOutputs` decision (the arena widening landed 2026-09-06 — `WP-180-FU3` `8c14b47` grew `ARENA_NODE_TYPES` with `"null"` — so this now closes with the strategy-runtime-side `modelOutputs` split collapse, §5 item 2, now enabled); an own `__proto__` inside the input's `sourceEvent` persists verbatim (producer-side, base-identical, its own future round) — `docs/handoffs/WP-170-FU1.md` | — | — |
| `apps/data-gateway` (door: `REC-1`, `327cae7`) | `parseGatewayConfig` (through `config-door.ts`) | caller (operator config) | **CLOSED (the two measured rows, 2026-09-06)** — both defeats reproduced at base (the get-only inherited `tickIntervalMs` `.default()` defeat with the `dataLossBoundMs` check silently passing; the inherited `binance` block satisfying "at least one feed") and refused at the tip, along with four defeated defaults and two further adoptable feed blocks found by audit; the door materializes from own descriptors, applies the schema's defaults ITSELF, and the 13-entry `.default()` census is derived from the schema shape so an unregistered new `.default()` fails the suite. Disclosed residuals (`docs/handoffs/REC-1.md`): the door RESTATES NO FORMAT CHECK — its D2-independence covers the two measured rows only (under inherited `skipChecks`, a malformed `streamName`/negative `tickIntervalMs`/empty `internalMarketId`/malformed `feedId` are accepted identically at base and tip); the emitted key ORDER changed (value-identical; inert — no consumer enumerates or serializes the config). Owner of the residual: a `config-door` format-check follow-up (restate or obtain D2) | — | — |
| `packages/event-bus` (door: `WP-060-FU1`, `d869868`) | `validateEnvelope` (Redis wire) | wire | **CLOSED (the measured wire class, 2026-09-11)** — D1/D3/D4 through the package's own `envelope-door.ts`: the caller's own enumerable data is materialized into a frozen own-data tree BEFORE parsing (record objects have null prototypes; arrays retain Array.prototype), judged inside containment, re-checked field by field against constraints derived from the schema's own `_zod.def` by own-property reads, and returned as a FROZEN, PROTOTYPE-FREE envelope record with the array exception above — so the base row's two defeats are gone (the `eventId: "not-a-uuid"` / `receivedAt: "yesterday"` acceptance under inherited `skipChecks` REFUSES in both variants, and the output is no longer the caller's object, so adoption/loss now DO apply to it and are closed). The required-key waiver (`optin` AND `optout` together) is refused in six cold contexts. The WIRE BYTES are emitted by an own-data restatement of `JSON.stringify`, because the native one resolves `toJSON` through the prototype chain — round 4 measured an inherited `toJSON` rewriting the bytes of an ACCEPTED array-payload envelope, and a `bigint` payload turning a typed refusal into an acceptance. Error classification reads an own data brand, not `instanceof`, which a `Proxy` made throw out of the boundary. Sanctioned tightening: a top-level own `__proto__` member is REFUSED where the schema accepts and silently drops it | — | closed; residuals (an inherited `venue` fail-closing an array-payload envelope; `redis/transport.ts` keying its epoch cursor on the caller's object) owned by a bounded `redis/transport.ts` follow-up, recorded in `docs/handoffs/WP-060-FU1.md` |
| `packages/features` (`WP-160`, `3d49946`; output door: `WP-160-FU1`, `5faf16b`) | `computeFeatureSnapshot` (no `zod`); `selectIndexedValues`, `snapshotReference` | caller in, **caller out** | **CLOSED (output side, 2026-09-06)** — the two §9.5 storage helpers now emit through the package's own `ownFrozenTree` (the machinery the snapshot itself is built with): members/reference null-prototype + frozen, serialized bytes and per-member own-key lists identical, and the measured defeats (a non-enumerable inherited `reason` on **both** members; an `ABSENT` member gaining a `value`) reproduced at base `934fbb1` and refused at the tip — review closed the class for enumerable, Symbol-keyed and accessor pollution too. Disclosed residuals (`docs/handoffs/WP-160-FU1.md`): the input-side/control-flow records (`computeFeatureSnapshot`'s SUCCESS wrapper, `validateFeatureInput`, `materializeInput`, `parseUtcTimestamp`) remain prototype-bearing — no live consumer route today (the sole production consumer branches on the own `ok` first, and the refusal arm is null-prototype with an own `ok:false`); a bounded successor round owns the shallow own-property emitter; the returned array keeps `Array.prototype` (owner: whichever round starts indexing selected values into PostgreSQL) | — | — |
| `packages/binance-adapter` (door: `REC-1`, `327cae7`) | `decodeFrame` (through `wire-door.ts`), `BinanceTradePayloadSchema` | wire | **CLOSED (measured class, 2026-09-06)** — the declared-key adoption row reproduced at base byte-for-byte (a `trade` frame with `q` deleted refused clean; under a non-enumerable inherited `q` decoding as `kind=TRADE` with `quantityRaw="999999"` and `unknownFields=[]`, flowing to the normalized `size` AND the dedup fingerprint) and refused at the tip for ALL EIGHT declared trade keys, the bookTicker/serverShutdown/controlError shapes and the combined-stream wrapper `stream`, in both the non-enumerable and enumerable variants (both pinned; review-reproduced with an independent primitive, zero prototype reads at tip). `unknownFields` still records genuine drift; honest-input digests byte-identical. Disclosed residuals (`docs/handoffs/REC-1.md`): D2 not performed (the door restates the schema's presence/bounds checks on its own reads — holds under inherited `skipChecks`); 1 downstream uncontained `.safeParse` in `emission.ts`; `ownControlId` absent/malformed conflation (pollution-only, control-frame correlation value) | — | — |
| `packages/coinbase-adapter` (door: `REC-1`, `327cae7`) | `classifyFrame` (through `wire-door.ts`), `CoinbaseFrameEnvelopeSchema` | wire | **CLOSED (measured class, 2026-09-06)** — the routing adoption reproduced at base (inherited `channel` routes as TICKER; audit also found inherited `sequence_num`/`timestamp` routed with the key missing from the recorded frame, and a market-trades `size` adoptable into `venueDetail.rawSize`) and refused at the tip in both pollution variants (pinned; review-reproduced independently). The emitted frame is a projection onto the declared keys in schema order (byte-identity verified by two independent digests). Disclosed residuals (`docs/handoffs/REC-1.md`): nested per-channel `.min(1)` checks remain library-dependent under `skipChecks` (base-identical; not reopenable into the measured row — presence reads the same materialized tree); 6 downstream uncontained `.safeParse` in `normalize.ts`/`stream-processor.ts`; no door-level input byte cap | — | — |
| `packages/polymarket-public` | rtds: `normalizeRtdsFrame` (through `rtds/wire-door.ts`, `REC-1` `327cae7`); CLOB: `parseMarketEvent`/`parseVenueOrderBook`/`parseVenueOrderBooks` (through `venue/wire-door.ts`, `CLOB-1` `eb0c586`) | wire | **CLOSED (both halves: rtds 2026-09-06, CLOB 2026-09-07)**. rtds: the routing adoption (inherited `type` → "update") plus every other envelope/payload cell — including a fabricated ECONOMIC value (inherited `full_accuracy_value` → published `value:"999000"`) and an invented `feedId` (from `topic`) — reproduced at base and refused at the tip, both variants pinned; the TWAP payload's numeric checks still hold under `skipChecks` (unregressed). CLOB (`CLOB-1`, review r1 ACCEPT, 0 blockers): `parseMarketEvent` no longer parses through the `discriminatedUnion` (an own `event_type` read routes to the member schema, so the escaping cold-lazy `propValues[key].add` TypeError is off the door's path and contained to the documented verdict shape), and the book parsers close the inherited `hash`/`tick_size` adoption with D1/D3/D4 doors and schema-DERIVED field tables (desync fails the suite); the review's independent 106-cell census matched exactly (base 212/212 measurements diverged, tip 0/424 across four variants), a 940-call hostile battery escaped 0, and REFUSE→ACCEPT and wrong-bytes were 0 across a 6448-row corpus and two 20,000-payload fuzzers. Disclosed residuals (`docs/handoffs/CLOB-1.md`): arrays keep `Array.prototype` (a hostile array iterator mis-keys the door's own result record — availability-only, fail-closed); exotic-shape ACCEPT→REFUSE drifts including the JSON-REACHABLE own `__proto__` (review-corrected label) and the 16-deep root depth cap; the `timestamp: 1.5`-under-`skipChecks` non-restatement (base-identical); cold-lazy poisoning contained-not-cured | — | **residual owners recorded** (`docs/handoffs/CLOB-1.md`): the shared-materializer collapse question → ADR-020 governance (six near-parallel doors); follow-up test hardening; normalizer diagnostics; package-surface tidy-up |
| `packages/universe` | lifecycle: `applyMarketLifecycleEvent` (through `lifecycle-door.ts`, `UNIV-1` `4d7443b`); registration + envelope: the nine registry/envelope surfaces (through `caller-door.ts`/`registration-door.ts`/`envelope-door.ts`, `UNIV-2` `f90ff05`); state side: the projection/observation/eligibility readers (through `state-door.ts`/`parameters-door.ts`/`grammar.ts`, `UNIV-3` `cbc1ed3`) | wire (gateway-published lifecycle payloads); caller (registration, state) | **CLOSED (the measured classes: lifecycle, registration + envelope, and state side — all 2026-09-07)**. Lifecycle: the three probe-O rows and the 40-key sweep closed (census re-derived from the frozen schemas); nine `skipChecks` defeats closed by the D2 compensation. Registration + envelope: the ghost-approval route, `registerMarket`'s 7 identity keys, the whole-market-from-`{}` route, and the envelope→lifecycle composition closed end-to-end. State side (`UNIV-3`, r1 CHANGES REQUIRED → remediation → CONFIRMED ACCEPT): the projection dot-read class closed (sharpest cell BEYOND the packet — an inherited `rulesVersionId` flipped §9.2 model-dependent activation from DRIFT-refused to permitted-with-no-refusals); the instant-format residual CLOSED via a pattern derived from the schema's own regex (differential 1128 rows drift 0; never-stricter mutation-pinned; the review's cold-load derivation attack failed 0/7); the `parameters.ts` output-side adoption and the `skipChecks` observation defeat (13 cells) closed with the documented `UniverseValidationError` contract preserved; two SANCTIONED tightenings (`bindMarketToSeries` aligned with `approveSeries`' existing guard — exactly ONE row of the 87-case digests moved, independently verified twice; `metadataVersion` held to the payload schema's own verdict, null→default-1 restored in remediation); the `ingestSeq` re-statement (base ordered `"0x10"` as 16 and skipped the replay guard on a missing `gatewayEpoch`); required scalar projection fields must be own enumerable DATA properties (the r1 fail-open regression — an invented `?? "DISCOVERED"` default — closed fail-closed and pinned in all three mutant directions). Disclosed residuals (`docs/handoffs/UNIV-3.md`): the DIRECT-export caller-input reads (`input.eventType`/`payload`, order-presence — base-identical; the registry path is doored); nested values of hand-built projections carried by reference; the identifier grammars (UUIDv7/token-id/condition-id/CodeString) unstated under `skipChecks`; D2 not performed; PERMANENT cold-union poisoning (fail-closed, base-parity) | — | **a bounded direct-export caller-input round** (opportunistic); the D2/permanent-poisoning and door-consolidation questions → ADR-020 governance |
| `packages/settlement` (doors: `SETL-1` `af991ee`, `SETL-2` `6142e66`) | `safeParseSettlementSpec`/`parseSettlementSpec` (through `spec-door.ts`) + the activation path (`activation.ts`, `registry.ts:252`); `evaluateSettlement`/`selectPayoffModel`/`checkPayoffModelCompatibility`/`payoutPerShare` (through `observation-door.ts`) | caller | **CLOSED (both measured layers: the probe-N spec class and the observation/evaluation class — 2026-09-07)**. Spec layer (`SETL-1`): all 14 required-key adoptions refused in all three variants; VERIFIED-from-nothing closed end-to-end; the D2 compensation held to the schema's own verdict by the six-grammar differential (B1 fixed in both directions; the reviewer's 897-row digest byte-identical). Observation/evaluation layer (`SETL-2`, r1 ACCEPT 0 blockers): the base class was TOTAL — `evaluateSettlement` never parsed an observation, and inherited `strike`/`observedValue`/`comparison` landed WRONG VALUES on the payout surface (strike hole + inherited `"0"` → YES_WIN `{yes:"1",no:"0"}`; a btc spec settled by an eth.usd reading); closed by `observation-door.ts` REUSING `spec-door.ts`'s primitives (spec-door byte-unchanged). D2 declared VACUOUS and measured (the review's 40-key × 2-variant battery: zero zod-defeat divergence at tip; base had four escaping TypeError classes, tip zero). Two beyond-premise throw closures (the compatibility matrix object-literal lookup; `payoutPerShare`'s zod-backed refusal detail) and one review-surfaced IMPROVEMENT: `comparison:"BOGUS"` settled NO_WIN at base with NO pollution — a live cash-surface defect — and now refuses. Six corpus values closed SETL-1's case-drift gap (measured six survivors, not the residual's two). Disclosed residuals (`docs/handoffs/SETL-2.md`): the spec is never MATERIALIZED on the evaluation path (a caller-supplied Proxy descriptor trap can answer gates differently across reads — base-identical; emitted records stay self-consistent); the `SettlementResult` envelope keeps `Object.prototype` and is unfrozen (refusals and D4 records are null-proto/frozen); the ordering-pin `comparison` case is gate-ambiguous; two value gates depend on `Array.prototype.includes`; eight surviving mutants all verified dead-by-ordering (enumerated in the suite header) | — | **SETL-2 follow-up hardening** (ordering pin, catch value, intrinsic gates); the spec multi-read → the `spec-door.ts` line; the result-envelope D4 → an `errors.ts` follow-up; an observation parse entry only if a wire caller ever appears |
| `packages/order-book` | `validateIngestMeta` (scalar parses only) | wire meta | **LIVE (inherited from `packages/domain`)** — scalar `safeParse` on `UuidSchema` / `IsoTimestampSchema` / `UnsignedBigIntStringSchema`; no object parse, so no adoption/loss | LOW–MEDIUM | next bounded grant on `packages/order-book/**` |
| `packages/risk`, `packages/capital-allocator` (`WP-180`, `98a6cc1`) | every door | caller | **CLOSED** — D1–D4. Probe K3 confirms the arena copy of a domain schema still refuses what the raw schema accepts under `skipChecks`. *(Updated 2026-09-06, `WP-180-FU3` `8c14b47`: all 77 remaining `Array.prototype.push` sites across risk's ten other modules are `CreateDataProperty` appends through the one exported `appendData`, and direct-door index-name divergence measured 37→0 per intrinsic. The index-name availability residual shrinks to zod's own array assembly — warm `handleArrayResult` (`schemas.js:678`), cold `Doc.write` via `generateFastpass` — ACCEPT→REFUSE only, owned by a designed `isFreshOrdinaryContainer` round with the four arena consumers in scope. ADR-021: risk types `context.strategyInstanceId` as the arena `Uuidv7Schema`, and the allocator's four identity doors followed on 2026-09-06 (`ALLOC-1`, merged `d9f70a6` — which also closed a measured base cap-evasion surface: a re-cased id kept its own `byStrategyInstance` exposure bucket). Updated 2026-09-07: `TRDR-1` merged at `65ae56c`, replacing the trader's interim intersection grammar with the real `Uuidv7Schema`; startup now admits 0-leading UUIDv7s and enforces version/variant bits. ADR-021 is discharged end to end.)* | — | — |
| `packages/execution-planner` (`WP-190`, `5aa11e3`) | every door | caller | **CLOSED** — same mechanism *(originally the third mirror; since the `WP-180-FU2` collapse, `625c83b`, it consumes the one canonical `packages/risk` door over §2.1 row S4 — corrected 2026-09-05)* | — | — |
| `packages/storage-postgres`, `storage-wal`, `storage-parquet`, `observability` | *(none — there is no `zod` door in any of the four)* | — | **n/a — outside this class, measured.** None of the four declares `zod` in its `package.json` or imports it anywhere in `src/`, and none contains a schema parse. Every `.parse(` in their sources is `JSON.parse` or `Date.parse`: `storage-postgres/src/timestamps.ts:63`, `storage-wal/src/raw-frame.ts:149`, four sites in `storage-parquet` (`compactor.ts:759`, `wal-format.ts:517`, `testing/index.ts:43`, `compactor.test.ts:582`), six in `observability` (`soak-evidence.ts:290,293,525,526`, `soak-evidence.test.ts:17`, `render.test.ts:271`). **Corrected 2026-09-04 (`GOV-2A` remediation round 1)**: the original row asserted "one `.parse` each, on internally-constructed values" and a CONTAINED verdict for doors that do not exist — a measured-sounding verdict that was never measured. These packages **do** validate hand-written structures (`parseDatasetManifest`, the WAL frame validators, `parseSoakWindowEvidence`); that is a different class, is not what ADR-020 rules on, and was **not** measured here | — | none; recorded |
| `packages/decimal` | no `zod` | — | n/a — outside the zod class. *(Updated 2026-09-06: `GOV-2A` `follow_up` 5's `divDecimal` explicit-options hazard and the index-name family were both closed by `WP-020-FU1`, merged `edf6b1d` — every arithmetic/tick door now runs inside `withNeutralIndexNames` with exact `finally` restoration, and an unneutralizable non-configurable shape is refused typed (`HostilePrototypeError` / `DECIMAL_HOSTILE_PROTOTYPE`), never computed through; `decimal.js` pinned exactly `10.6.0`; `domain.md` §3.6)* | — | — |

**The tally, and it is the number every other document must quote.** The table
above carries **LIVE for two merged packages** —
`packages/{domain,order-book}` fully LIVE, and the `order-book` row is LIVE
only by inheritance from `packages/domain` — and no split rows remain.
Thirteen packages are **CLOSED** (`event-bus` (the measured wire class),
`risk`, `capital-allocator`,
`execution-planner`, `features` (output side — its input-side records carry
an owned residual, not a zod door), `ledger`, `pnl`, `strategy-runtime`,
`settlement` (the measured probe-N class), `polymarket-public` (both
halves), `universe` (the measured lifecycle and registration + envelope
classes), and, for their measured classes, `binance-adapter` and
`coinbase-adapter`),
`apps/data-gateway`'s two measured rows are closed, and five packages are
**outside the class** (`decimal`, `storage-postgres`, `storage-wal`,
`storage-parquet`, `observability` — no `zod` door). *(Recounted 2026-09-11: `event-bus` flipped LIVE→CLOSED for the measured
wire class when `WP-060-FU1` merged (`d869868`), moving the category counts
to **2 LIVE / 13 CLOSED / 5 outside**. Only `packages/domain` (frozen — closed
at each door per ADR-020 §3 rather than by editing it) and
`packages/order-book` (LIVE by inheritance from `domain`) remain. That round
also measured a class this table had not recorded anywhere: a door may
materialize its own data correctly and still emit WRONG BYTES, because
`JSON.stringify` resolves `toJSON` through the PROTOTYPE CHAIN — reachable
from any array a door leaves `Array.prototype` on, and from a `bigint`
through `BigInt.prototype`, where it turned a typed refusal into an
acceptance. Every other door that ends in `JSON.stringify` of a materialized
tree should be measured for the same route; that is an OPEN successor
obligation. Recounted
2026-09-07, third recount that day: the category counts are UNCHANGED
(3 LIVE / 12 CLOSED / 5 outside) while two closures deepened —
`settlement` closed its second measured layer when `SETL-2` merged
(`6142e66`) and `universe` closed the state-side class when `UNIV-3`
merged (`cbc1ed3`), retiring §5 items 10 and 9c; the open successor
queue is now the bounded direct-export caller-input round and the
ADR-020 governance questions. Recounted
2026-09-07, second recount that day: BOTH splits collapsed when `UNIV-2`
(`f90ff05`) and `CLOB-1` (`eb0c586`) merged — the registration + envelope
and CLOB halves each closed under a 0-blocker ACCEPT. The successor
obligations that remain open are §5 item 9c (the universe state-side
round, which now also carries `UNIV-2`'s residuals) and item 10 (the
settlement observation/evaluation grant). Recounted earlier
2026-09-07: `universe` SPLIT (lifecycle closed) and `settlement`
closed-for-the-measured-class when `UNIV-1` (`4d7443b`) and `SETL-1`
(`af991ee`) merged — `UNIV-1` also measured LIVE registration-door adoptions;
`SETL-1` identified an observation/evaluation surface not yet probed
end-to-end. These are newly recorded successor obligations outside the
closed measured classes. Recounted
2026-09-06, third recount that day: `binance-adapter`, `coinbase-adapter`
and the `apps/data-gateway` rows closed and `polymarket-public` split when
`REC-1` merged (`327cae7`) — its CLOB half was measured LIVE in the same
round. Second recount that day: `features`
flipped LIVE→CLOSED (output side) when `WP-160-FU1` merged (`5faf16b`).
Recounted earlier 2026-09-06: `strategy-runtime` flipped LIVE→CLOSED
when `WP-170-FU1` merged (`d89841d`). Previously recounted 2026-09-05:
`ledger` and `pnl` flipped LIVE→CLOSED when `WP-200-FU1` merged (`a30fec8`).
Previously recounted 2026-09-04 in `GOV-2A` remediation round 1, whose
round-1 headline said "five merged packages and one app" — it counted neither
the `features`, `order-book`, `coinbase-adapter` and `polymarket-public` rows
the same table already carried as LIVE, nor the three rows that round-1 review
corrected — `binance-adapter`, `settlement`, `universe`.)*

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

1. **`WP-200-FU1` — EXECUTED** (merged `a30fec8`, 2026-09-05; two review
   rounds, r2 ACCEPT; `docs/handoffs/WP-200-FU1.md`): the D1–D4 door on
   `validateTransactionInput`, `allocateFill`, `buildFillPosting`, and the PnL
   record parses; the cold-lazy throw on `PnlRecordSchema` closed; a
   regression test per §3 row; `WP-200`'s deep-freeze LOW residual closed in
   both duplicated modules. Successor obligations it spawned: the
   `packages/risk` grant-and-widen round (`plain-data.ts` append surface →
   `CreateDataProperty` + an index-`"0"` regression) and the
   `packages/decimal` round (the invented `Object.prototype["0"]` on
   exactly-zero results; the `subDecimal` index-`0` throw; `follow_up` 5's
   `divDecimal` hazard).
2. **`WP-170-FU1` — EXECUTED** (merged `d89841d`, 2026-09-06; two review
   rounds, r2 ACCEPT; `docs/handoffs/WP-170-FU1.md`): D2/D3 through the
   canonical `packages/risk` door over the new `dependency-direction.md`
   §2.1 row S7, covering the
   `DecisionResult` parse, the six scalar identifier parses, the run-seed
   door and the `modelOutputs` split; eleven measured base defeats flipped
   refused plus a twelfth confirmed in review; the r1 cold-lazy poison and
   nested-`__proto__` emission closed in remediation. Successor obligations
   it spawned: **executed 2026-09-06** (`WP-180-FU3`, merged `8c14b47`, one
   review round ACCEPT; `docs/handoffs/WP-180-FU3.md`) — the remainder
   round grew `ARENA_NODE_TYPES` (`"null"`, with the measurement its
   comment demands) and re-typed `context.strategyInstanceId` to the arena
   `Uuidv7Schema` per ADR-021 (whose 2026-09-06 amendment records the
   measured `capital-allocator` conflict and the allocator-before-trader
   sequencing). The `values` availability residual now closes with the
   strategy-runtime-side `modelOutputs` split collapse (enabled, its own
   bounded round); the input-snapshot `sourceEvent` `__proto__` question is
   its own future measured round.
3. **Recorder-pipeline hardening round — EXECUTED** (`REC-1`, merged
   `327cae7`, 2026-09-06; review r1 CHANGES REQUIRED on regression-fence
   gaps → test-only remediation → confirming pass ACCEPT with the
   reviewer's own mutants; `docs/handoffs/REC-1.md`): the routing
   adoptions (rtds `type`, coinbase `channel`), binance's trade-payload
   declared-key adoption, and the gateway's two defeated startup checks —
   all four §3 rows closed with package-local own-property doors (D2
   disclosed-not-performed; the adapter doors restate presence/bounds).
   Successor obligations it spawned: the CLOB-doors grant (item 8), the
   `config-door` format-check follow-up, and the downstream
   `.safeParse` containment round.
4. **`WP-160-FU1` — EXECUTED** (merged `5faf16b`, 2026-09-06; one review
   round, ACCEPT; `docs/handoffs/WP-160-FU1.md`): both §9.5 storage helpers
   (`selectIndexedValues` AND `snapshotReference`) emit through the
   package's own `ownFrozenTree`. The must-land-before condition held:
   zero production consumers indexed snapshot values at merge time
   (review-verified repo-wide). Successor obligation it spawned: the
   input-side shallow own-property emitter round (review r1 N2).
5. **Mirror collapse — EXECUTED** (`WP-180-FU2`, merged `625c83b`, 2026-09-04;
   corrected here 2026-09-05): `plain-data.ts`/`schema-arena.ts` live only in
   `packages/risk`; every door consumes that one implementation over the §2.1
   rows (S3/S4, and S5/S6 since `WP-200-FU1`), with a repo-wide deletion guard
   forbidding any copy.
6. **Tooling** — a detector that flags a `.safeParse`/`.parse` on a value that
   did not come from a materializer, and a source-scan hardening pass for the
   alias/cast indirection both `WP-160` (R1-N3) and `WP-180` (R9-1) disclosed.
   **Deliberately last**, and deliberately not a CI gate today: a gate every
   merged package fails is a gate that gets waived wholesale
   (`dependency-direction.md` §6.1 item 1).
7. **`packages/settlement` and `packages/universe` — EXECUTED**
   (2026-09-07): the two bounded grants landed as `SETL-1` (merged
   `af991ee`; review r1 CHANGES REQUIRED — a fail-open offset bound and
   three unpinned defences — then a both-directions remediation and a
   confirming-pass ACCEPT with the reviewer's independent digest
   byte-identical between true base and tip; `docs/handoffs/SETL-1.md`)
   and `UNIV-1` (merged `4d7443b`; review r1 ACCEPT, 0 blockers;
   `docs/handoffs/UNIV-1.md`). The D1–D4 doors stand on
   `safeParseSettlementSpec`/the activation path and on
   `applyMarketLifecycleEvent`'s nine consumption sites, each with a
   regression per measured row in both pollution variants. Successor
   obligations they spawned: items 9 and 10.

8. **`packages/polymarket-public` CLOB doors — EXECUTED** (2026-09-07:
   merged as `CLOB-1`, `eb0c586`; review r1 ACCEPT, 0 blockers;
   `docs/handoffs/CLOB-1.md`) *(added 2026-09-06 when
   `REC-1` measured them LIVE — §3)*: a bounded grant on
   `parseMarketEvent` (`venue/market-events.ts:248` — an escaping
   `TypeError` under an inherited `event_type`, from a function documented
   total) and `parseVenueOrderBook`/`parseVenueOrderBooks`
   (`venue/order-book.ts:123` — inherited `hash` and `tick_size` parse
   into the recorded book). Evidence: `docs/handoffs/REC-1.md`. The grant
   must not touch the frozen e2e golden — the constraint held: the golden
   is byte-identical through the merge, and the 583-test contract suite
   verdict-identical both ways.

9. **`packages/universe` follow-ups** *(added 2026-09-07 from `UNIV-1`'s
   review — evidence in `docs/handoffs/UNIV-1.md`)*: (a) the
   registration doors — `registerSeries` adopts five keys including a
   fabricated approved binding, `registerMarket` adopts all four
   identity keys (review-reproduced); (b) the envelope door
   (`envelope.ts:44` — an envelope-layer adoption arrives as genuine own
   keys downstream); (c) the state-side follow-up (the projection-side
   dot-read class + the instant-format residual + the unpinned
   fail-closed drifts). **(a)+(b) EXECUTED** (2026-09-07: merged as
   `UNIV-2`, `f90ff05`; review r1 ACCEPT, 0 blockers;
   `docs/handoffs/UNIV-2.md`). **(c) EXECUTED** (2026-09-07: merged as
   `UNIV-3`, `cbc1ed3`; review r1 CHANGES REQUIRED — a fail-open
   regression the candidate itself introduced, closed in remediation
   `3340675` — then a confirming pass CONFIRMED ACCEPT;
   `docs/handoffs/UNIV-3.md`). Item 9 is closed end to end; the
   remaining universe surface is the bounded direct-export
   caller-input round recorded in the §3 row.
10. **`packages/settlement` observation/evaluation grant — EXECUTED**
    (2026-09-07: merged as `SETL-2`, `6142e66`; review r1 ACCEPT,
    0 blockers; `docs/handoffs/SETL-2.md`) *(added
    2026-09-07 from `SETL-1` — evidence in `docs/handoffs/SETL-1.md`)*:
    `evaluateSettlement`/`selectPayoffModel` dot-read caller-supplied
    views and `SettlementObservationSchema` has no door — the same class
    one layer below the closed spec door. Measurement found the class
    TOTAL (that path never parsed an observation), with wrong values
    landing on the payout surface; the review additionally surfaced and
    the round closed a NO-pollution base cash-surface defect
    (`comparison:"BOGUS"` settled NO_WIN).

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
