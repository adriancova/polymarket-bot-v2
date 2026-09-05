# `@polymarket-bot/simulation` (WP-210)

The replay clock, the dataset event source, the simulated execution venue, and
the Tier 0 / Tier 1 fill models with their optimistic / base / conservative queue
scenarios.

Authority: handoff §8.3, §8.4, §11, §12 (all), §6 invariants 1, 2, 9, 10, 12, 13,
15; [ADR-012](../../docs/adr/ADR-012-simulation-fill-model-evidence-hierarchy.md)
(**binding** for what a simulated result may be used to justify),
[ADR-013](../../docs/adr/ADR-013-book-price-change-absolute-size-confirmed.md),
[ADR-017](../../docs/adr/ADR-017-dataset-manifest-and-retention-receipt-artifact-contract.md)
(the manifest artifact and its strict-JSON reading profile),
[ADR-020](../../docs/adr/ADR-020-schema-parse-boundary-integrity.md) +
[`schema-boundary.md`](../../docs/contracts/schema-boundary.md) (the parse door),
and [`wal-format.md`](../../docs/contracts/wal-format.md) §12.1 (cross-epoch
chronology).

---

## 1. What is here

| Module | What it owns |
| --- | --- |
| `clock.ts` | The §12.1 `Clock`, positioned and advanced ONLY by recorded events |
| `strict-json.ts` | The ADR-017 §3 strict-JSON profile, with its own UTF-8 codec |
| `manifest.ts` | The dataset-manifest door and the §12.5 run pin set |
| `event-source.ts` | The §12.1 `MarketEventSource` over a verified dataset (§8.4) |
| `seed.ts` | SplitMix64 named streams — the only randomness (§6 invariant 2) |
| `latency.ts` | The Tier-1 latency model (§12.2 step 1) |
| `fees.ts` | `fee = C × feeRate × p × (1 − p)` from a PINNED snapshot (§6 invariant 9) |
| `fill-model.ts` | The evidence labels, exact depth arithmetic, and the ledger bridge |
| `tier0.ts` | §12.2 Tier 0 — pipeline smoke, never for deployment decisions |
| `tier1.ts` | §12.2 Tier 1 immediate orders — latency, delay, GTD, FAK/FOK |
| `queue.ts` | §12.2 Tier 1 resting orders — queue-ahead and the BAND |
| `markout.ts` | §12.3 markouts as diagnostics, and stress scenarios separately |
| `rate-limit.ts` | The §9.13 budget seam, with absence stated explicitly |
| `venue.ts` | The §12.1 `ExecutionVenue`, simulated — routes on `executionStyle`: a crossing `postOnly` order is REJECTED, a non-crossing `REST` order rests and is filled by observed trades, and everything marketable takes |
| `replay.ts` | The run driver and the seam the shared core loop plugs into |
| `serialize.ts` | The §12.4 canonical form a determinism claim is made about |

---

## 2. Boundary-discipline conformance statement (`schema-boundary.md` §4)

This package's event source parses RECORDED WIRE DATA, so ADR-020 §3 applies.
`schema-boundary.md` §1 offers two conforming routes; **this package takes the
`WP-160` route: no runtime schema library at all.**

| Step | What this package does |
| --- | --- |
| **D1 — materialize prototype-free before parsing** | Manifest and pin BYTES go through `strict-json.ts`, which BUILDS the tree with `Object.create(null)` and `Object.defineProperty` as it parses, so there is no intermediate `JSON.parse` result at all. Decoded dataset rows go through `plain.ts`'s `materializeInput`, which reads property DESCRIPTORS (a getter is refused without being invoked), refuses `__proto__` as a name, symbol keys, accessors, cycles, sparse holes and non-plain prototypes. **Every door materializes every caller-supplied DATA argument** through `readOwnPlainInput` before it validates or computes, reads only the materialized tree afterwards, and never returns the caller's own object. What is NOT materialized is exactly: a PORT (an object whose contract is its methods — `BookView`, `MidTimeline`, `DepthTimeline`, `DatasetArchiveReader`, a seeded stream), a FUNCTION, BYTES (`strict-json.ts` is itself the D1 reader for those), and a PRIMITIVE. A door's own OPTIONS BAG is a call-site literal and is read ONCE PER FIELD, so one read cannot be made to disagree with a later one. See `plain.ts`'s `readOwnPlainInput` for the table, and §5 item 10 for the one shape this policy refuses that a root might legitimately build. |
| **D2 — parse through a severed, warmed arena** | **Not applicable, and that is the strongest form of it rather than a waiver.** D2 exists to sever a `zod` node's `_zod` container and force its lazies. This package runs no schema library, and `zod` is absent from its ENTIRE dependency closure: it declares one workspace dependency, `@polymarket-bot/decimal`, which depends on `decimal.js` and `node:crypto` only. There is therefore no `skipChecks` / `optin` / `optout` / `when` / `values` slot to inherit and no lazy build to poison. `test/unit/simulation/purity.test.ts` checks the closure from the manifests; `doors.test.ts` installs those exact keys anyway and measures that nothing moves. |
| **D3 — take values from the materialized tree** | By construction: there is no library output to take them from. Every field is read with `readField`, an own-property read of the materialized tree. |
| **D4 — emit prototype-free** | Every emitted record is `ownFrozenTree`: null prototype, deep-frozen, `undefined` members dropped, so an absent optional field cannot be answered by a polluted `Object.prototype` in the consumer. Its copier reads DESCRIPTORS, is cycle-guarded and is bounded at `MAX_INPUT_DEPTH`; because D1 now runs first at every record door, those guards are ASSERTIONS about trees this package built, and a violation raises inside a totality guard rather than producing a partial tree. Round-3 review MEDIUM-1: `checkBandOrdering`'s OK path returned the CALLER'S OWN band — unfrozen, prototype-bearing — which contradicted this row; `doors.test.ts` now asserts the property for every record door rather than for the five it used to list. |

**The bound (ADR-020 §6), measured in `test/unit/simulation/doors.test.ts` over
all ten `schema-boundary.md` §2 classes** — adoption (enumerable AND
non-enumerable), loss, defaults defeated, `skipChecks`, `optin`/`optout`, `when`,
descriptor literals, `values`, and cold-lazy poisoning:

1. **Permission never varies.** Every door returns the same verdict, and the same
   VALUES, clean and under every class.
2. **A `SAFETY_CANCEL` is byte-identical.** `SimulatedVenue.cancel` produces the
   same JSON bytes clean and under every class.
3. **No throw escapes.** Every door is total under every class, including on
   malformed and hostile input. `doors.test.ts` drives every exported DOOR — by
   reflection, so a door added later is covered automatically — with a battery of
   hostile arguments (`null`, a non-canonical decimal string, a `Proxy`, a
   symbol, a null-prototype record, a CYCLIC record and array, a getter-bearing
   record, a record nested past `MAX_INPUT_DEPTH`, and each of those three
   classes NESTED inside a record whose keys the doors read) and requires a
   refusal, never an exception. The cyclic argument is a VALID parameter set with
   a self-reference, so it reaches the door's copy step rather than being
   rejected on its first field.
4. **A caller record is refused, not read.** For every RECORD DOOR the bound is
   stronger: the cyclic / accessor / over-deep classes are planted at EVERY data
   position of a VALID argument — positions **derived by walking the fixture**,
   not listed by hand — and each must come back `SIMULATION_INPUT_NOT_DATA` with
   the accessor NEVER invoked, and each door's emitted value must be its own
   frozen prototype-free tree rather than an alias. Round-3 review LOW-1: the
   previous table named five doors and checked itself by list equality, so
   nothing detected a sixth. The three lists (record doors, non-record doors with
   the reason their argument is not data, pure helpers with the door that
   validated what reaches them) must now PARTITION the export surface exactly, so
   a new export fails the suite until it is classified — and classifying it as a
   record door subscribes it to the whole battery.

`SimulatedVenue.submit` returns an `ExecutionResult` rather than a
`SimulationResult`, so it honours the same bound by producing a REFUSED result:
it never rejects its promise.

The validators are bound to the FROZEN contracts they mirror by
`test/unit/simulation/grammar-cross.test.ts`, which compares each predicate with
its real `packages/domain` schema over a generated corpus in both directions.
`doors.test.ts` additionally reproduces `GOV-2A` probe K3's shape: under an
inherited `skipChecks` the frozen `Uuidv7Schema` accepts `"NOT-A-UUID"` and this
package's `isCanonicalUuidV7` still refuses it.

**Not a fourth `plain-data.ts`/`schema-arena.ts` mirror.** `GOV-2A`'s
mirror-collapse ruling (`dependency-direction.md` §2.1) states that
duplication-with-drift-guard is NOT the ratified permanent shape and that
`mirrors.test.ts` becomes a guard against a fourth copy. Copying it here would
have been the shape that ruling forecloses.

---

## 3. What a simulated result may be used for (ADR-012)

- Every fill carries `evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"` — a
  one-member union, so it is not assignable where observed venue evidence is
  expected — plus its `fillModelVersion` and a `calibration` of
  `UNCALIBRATED_NO_PROBE_DATA_EXISTS` (ADR-012 §7: no execution probe and no
  live-micro run has occurred, so nothing here is fitted to observed behaviour).
- Tier 0 carries `deploymentDecisionUse: "FORBIDDEN"` and is refused by
  `quoteForDeploymentDecision` at COMPILE time and again at runtime.
- The only Tier-1 resting entry point returns a `RestingFillBand`. There is no
  function in this package that returns a single resting fill and no
  `collapse()` helper, so "one falsely precise fill result" is not constructible.
- `quoteForDeploymentDecision` checks a Tier-1 result STRUCTURALLY: all three
  labelled scenarios must be present. A value that merely carries a Tier-1
  identity — `{ model, filledShares }` — is refused, because that is exactly the
  "quoted as a single number" ADR-012 §1 forbids.
- A Tier-1 RESTING order books **no point-precise fill**: the venue reports the
  band on the `ExecutionResult` and the order carries
  `fillEstimateKind: "TIER_1_RESTING_BAND"` with `filledShares` holding only what
  was actually booked against cash and inventory. A band is an estimate, not
  cash, and the order says so rather than implying a number.
- The band's ordering claim is derived over NON-NEGATIVE quantities, and
  `simulateResting` enforces exactly that at the door where the derivation is
  written down: a negative `shares`, `queueAheadAtPlacement` or observed
  same-instant addition, and a non-positive observed trade size, are refused with
  `SIMULATION_INPUT_INVALID` naming the field. (Round-2 review MEDIUM-2: the
  venue guarded its own inputs, but a caller reaching the door directly got a
  nonsense band from a negative traded size — the queue walk ran backwards — or a
  band-inconsistency refusal that blamed the derivation for an unvalidated input.
  The venue's guards remain; the door no longer depends on them.)
- The same bound applies to PRICES (round-3 review, NOTE-3): a resting price and
  an observed trade price must be strictly positive. A price is what the fee is
  computed on (`fee = C × rate × p × (1 − p)`), what the at-price / through-price
  comparison turns on, and what the §12.4 `band` line prints — so the door
  enforces what its own computation assumes rather than inheriting the venue's
  guard. Before the fix a `restingPrice` of `"-0.5"` produced an ACCEPTED band
  that serialized as `band … price=-0.5 …`.
- §12.3: markouts are `role: "DIAGNOSTIC_ONLY"` with
  `appliedToReplayEconomics: false`; `replayPathEconomics` has no argument
  through which a penalty could arrive and carries `markoutPenaltyApplied: false`
  as a literal; a penalty is available only through the separately-typed
  `markoutStressScenario`, which carries the untouched replay economics beside it.

---

## 4. Safety

No venue network surface, no signer, no credential, no order — and none is
representable in these types. `SimulatedVenue.submit` REFUSES `EXECUTION_PROBE`,
`LIVE_MICRO` and `LIVE` by name, because §11 gives those three a live signer.
`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false` and both live-micro caps at `0`
are untouched by anything here.

`test/unit/simulation/purity.test.ts` scans these sources and fails on any
`Date`/`performance`/`process` read, any `Math.random`, any `node:` import, any
`zod` import or schema parse, any `localeCompare`, and any URL, socket, signer or
key.

---

## 5. Disclosed limits and open questions

1. **The fee rounding DIRECTION is not a documented venue fact.** The venue
   documentation says fees are "rounded to 5 decimal places" and states no
   direction or tie rule (`docs/venue/verified-2026-08-24.md` §6). `FeeScheduleSnapshot`
   therefore carries a REQUIRED `roundingMode`, and `readFeeScheduleSnapshot`,
   `computeFee` and `roundDecimal` each REFUSE a mode outside the implemented
   set: this package does not choose for the operator, and there is no branch
   that quietly rounds one way when it was never told which way.
2. **The GTD "around 3 minutes" minimum is not enforced.** ADR-012 §5.2 quotes a
   minimum stated expiration "around 3 minutes in the future". "Around" is not a
   threshold, so only the exactly-stated 60-second early expiry is applied.
3. **`Proxy` is not detected.** Every reflective probe for one runs a trap — i.e.
   runs caller code inside the door that exists to stop caller code running — and
   `node:util`'s `types.isProxy` is unavailable here because this package is not
   on `dependency-direction.md` §2.2's layer-1 built-in allowlist and may not add
   itself to a contract it does not own. The same containment `packages/features`
   records applies: each property is read exactly once into the tree, every trap
   invocation is inside the totality guard, and everything downstream consumes
   only the materialized tree.
4. **Rate limits are a SEAM, not a model.** The venue's per-signer buckets belong
   to `packages/polymarket-secure/src/rate-limit/**`, which does not exist yet. A
   run with no model must pass `unmodeledRateLimits(disclosure)` and every result
   then says `NOT_MODELED` — ADR-012 §5.6's warning is that ignoring them
   overstates maker performance, so the absence is stated rather than implied.
5. **No core loop is assembled here.** Books, features, the strategy runtime,
   risk, the allocator, the planner and the ledger are same-layer packages with
   no §2.1 edge; `WP-230` wires them into `apps/trader`'s composition root
   through `runReplay`'s `coreLoop` hook.
6. **Depth-aware participation stays deferred.** WP-190 `follow_up` 1 records
   that planning inputs carry only top-of-book. The simulated venue consumes
   DEPTH, so every result it produces carries
   `planningDepthAwareness: "TOP_OF_BOOK_ONLY"` so a reader cannot infer that the
   plan participated in depth it never saw.
7. **A resting order is filled by OBSERVED trades the driver hands over.** The
   venue has no feed: `SimulatedVenue.observeTrade` is how a recorded trade
   reaches a resting order (Tier 0 fills on touch/trade-through per §12.2; Tier 1
   recomputes the band). What is a trade — and which recorded frame carries one —
   is normalization, which belongs to layer 2, so the composition root decides it
   and this package never guesses.
8. **Same-instant queue additions cannot be derived from a book snapshot.** A
   recorded book carries AGGREGATE size per level, so the venue cannot see what
   was added at our price in the same instant we placed. `ExecutionPolicy`
   therefore requires `sameInstantAdditionsFor`, and it answers a TAGGED value —
   `"NOT_OBSERVED"` or `{ observedShares }` — never a bare quantity. A bare `"0"`
   conflated "we looked and saw nothing added" with "we did not look", and only
   the first supports calling the CONSERVATIVE arm conservative. The answer is
   carried on the `RestingFillBand` and printed in the §12.4 bytes
   (`sameInstantAdditions=NOT_OBSERVED` / `=OBSERVED:<shares>`), so a run whose
   conservative arm rests on an unmeasured quantity says so in its own artifact.
   There is still no default: a root that states neither is refused. Only the
   CONSERVATIVE scenario assumes we sit behind the additions, and an unobserved
   addition contributes nothing to the queue ahead.
9. **Two different inversion diagnostics, named for what they measure.** The load
   report counts `receivedAtInversions` — recorded ARRIVAL wall clocks out of
   order across the dispatch-ordered rows — and the event source counts
   `venueTimestampInversions` over the DELIVERED envelopes' `venueTimestamp`,
   which is the §8.4 disagreement (a dataset row carries no venue timestamp).
   Both compare EPOCH MILLISECONDS, never ISO strings: two §7.1 instants with
   different UTC offsets do not compare correctly as text. Both are reported and
   neither reorders anything.
10. **D1 refuses a legitimately-built class instance, and that is a real cost.**
    The rule is a policy about SHAPE: a value with a non-plain prototype is
    refused, because an inherited property is state the input does not own and no
    copy can carry it faithfully. So a composition root that built its fee
    snapshot, its queue parameters, a recorded instant or a book level as a CLASS
    INSTANCE rather than a record literal gets `SIMULATION_INPUT_NOT_DATA` naming
    the prototype. That is typed, documented and — for this package's purposes —
    correct, but it means the claim "none of these doors can refuse a legitimate
    argument" is FALSE as stated, and a refusable legitimate construction exists
    (round-3 review NOTE). The interfaces in `ports.ts` are DATA interfaces
    (`{ price, size }`, `{ receivedAt, receivedMonotonicNs }`), and
    `packages/order-book`'s real `levels()` returns object literals, so no CURRENT
    caller is affected; a future one that is will see a typed refusal naming the
    prototype rather than a wrong answer.
11. **A `bigint` is data at the doors whose records carry §7.1 instants, and
    nowhere else.** `RestingOrderInput.restingFromNs` and
    `ObservedTrade.monotonicNs` are `bigint`, so `simulateResting` materializes
    with `bigintIsData`. Every WIRE door keeps the default, which refuses a
    `bigint`: one cannot come from JSON, so at a wire door its presence means the
    value was constructed rather than recorded. A `bigint` is a primitive —
    immutable, identity-free, carrying no prototype and no code — so admitting it
    adopts nothing and invokes nothing, and every other non-plain value stays
    refused under both settings.
