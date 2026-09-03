# `@polymarket-bot/risk`

Owner: `WP-180`
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §9.8 (Risk Engine),
§9.9 (Incident Controller — recommendations only), §6 invariants 10/12/13/18,
§7.7 (intents and the resize rule), §14.3 (metrics are labelled by reason code)
Related: [`docs/handoffs/WP-180.md`](../../docs/handoffs/WP-180.md),
[`docs/handoffs/WP-110.md`](../../docs/handoffs/WP-110.md) (settlement payoffs),
[ADR-016](../../docs/adr/ADR-016-ratified-inferred-domain-shapes.md) (UUID refusal),
[`docs/contracts/dependency-direction.md`](../../docs/contracts/dependency-direction.md)

Pure layer-1 logic. **No I/O, no clock, no network, no credential, no signer, no
order-placement surface.** Every monetary and size value is an exact decimal
string (`@polymarket-bot/decimal`); no binary float appears anywhere (§6
invariant 1).

---

## 1. What this package does

`evaluateIntent(policy, input)` runs the §9.8 pre-trade checks over one intent
and returns either an **approved-intent record** or the **typed refusals** that
prevented it, plus **incident action recommendations** for the §9.9 controller.

`resizeApprovedIntent(record, request)` implements §7.7's rule that "a risk veto
never silently mutates an intent. A resize creates a new approved-intent record
linked to the original."

## 2. Three rules that shape everything here

1. **Fail closed.** Unknown never permits. A missing market context, an
   unmeasured feed, an absent exposure snapshot, an absent allocator verdict, an
   unbounded cost, an unsupplied scenario — each *blocks*. There is no code path
   in which absence is read as "fine".
2. **Worst-case contractual loss is PRIMARY.** `limits.maxWorstCaseContractualLoss`
   is the one **required** limit in the policy; every other cap is optional. The
   check runs even when secondary checks have already refused, and the assessment
   is returned on both arms of the result. Its codes are listed in
   `PRIMARY_RISK_REASON_CODES`.
3. **This package executes nothing.** It owns no connection. §9.9 says "the
   Incident Controller—not the ordinary risk gate—originates operational safety
   actions"; what this package emits is `kind: "RECOMMENDATION"` data for that
   controller, which is a later work package.

## 3. Worst-case contractual loss, and the `CANCELLED` outcome

The measure uses WP-110's **venue-verified** settlement payoff semantics —
both tokens, evaluated per outcome (`packages/settlement/src/payout.ts`,
retrieved 2026-08-28 from the venue's resolution documentation):

| Outcome | YES share redeems | NO share redeems |
| --- | --- | --- |
| `YES_WIN` | `1` | `0` |
| `NO_WIN` | `0` | `1` |
| `SPLIT_50_50` | `0.5` | `0.5` |

**`CANCELLED` is never valued.** The venue documents no cancellation, void, or
refund mechanic (WP-110 register row **U-10**, UNVERIFIED), and
`payoutPerShare("CANCELLED")` **refuses** with
`SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED`. This package invents no payout either.
The unverified outcome is instead **bounded**: an outcome token is an asset, so
no redemption path can charge its holder, every unverified redemption is `≥ 0`,
and the loss across *all* terminal outcomes is therefore bounded by a
**zero-redemption floor**. That produces two measures:

- **`maximumContractualLoss` (PRIMARY, binding)** — committed cost against the
  zero floor. Deliberately conservative: a fully hedged YES/NO pair is *not*
  credited its verified hedge value, because crediting it would rely on a
  cancellation payout the venue does not document.
- **`worstCaseResolutionLoss`** — committed cost minus the per-market minimum
  settlement value over the three **verified** outcomes (§9.8's "worst-case
  resolution PnL"). May be negative, meaning a guaranteed profit.

`cancelledOutcomeTreatment` on every assessment states this in one machine-
readable value: `ZERO_REDEMPTION_FLOOR_UNVERIFIED_U10`.

Conservative simplifications, each of which overstates loss and never
understates it: resting BUY orders are assumed to fill at their limit price;
resting SELL orders are assumed **not** to fill (retaining the exposed tokens and
forgoing the proceeds); a candidate entry is assumed to fill fully at its bound;
a `QUOTE` level names no outcome token (§7.7), so its bought shares are placed on
whichever token settles **worse**.

## 4. Which checks apply to which intent

Disposition is derived from the intent **type**. A `POSITION` intent that happens
to reduce a holding is still an `ENTRY` and gets the stricter treatment — refusing
to place a new order is the safe direction, and a strategy that means "exit" has
`REDUCE_POSITION`.

| §9.8 check | ENTRY | EXIT (`REDUCE_POSITION`) | CANCEL |
| --- | :---: | :---: | :---: |
| 1. run / strategy state | ✔ | ✔ | — (§6 inv. 13) |
| 2. run mode within process maximum | ✔ | ✔ | — |
| 3. real-order enablement and fencing | ✔ | ✔ | — |
| 4. venue geographic eligibility | ✔ | ✔ (not `CLOSE_ONLY`) | — |
| 5. market active / accepting | ✔ | ✔ (`CLOSE_ONLY` permitted) | — |
| 6. settlement spec verified | ✔ | — | — |
| 7a. features / reference feed fresh | ✔ | — (§9.9 row 1) | — |
| 7b. venue book fresh | ✔ | **✔** (§9.9 row 2, §6 inv. 12) | — |
| 8. book synchronized | ✔ | ✔ | — |
| 9. trading parameters known | ✔ | ✔ | — |
| 10. price on tick | ✔ | ✔ | — |
| 11a. size ≥ market minimum | ✔ | ✔ | — |
| 11b. economic floor | ✔ | — | — |
| 12. expected net edge | ✔ | — | — |
| 13. participation limit | ✔ | — | — |
| 14a. allocator verdict present | ✔ | — | — |
| 14b. allocator verdict *refused* | ✔ | ✔ | — |
| 14c. sell ≤ confirmed inventory | ✔ | ✔ | — |
| 15. per-order / per-scope / global limits | ✔ | — | — |
| 16. worst-case contractual loss | ✔ | reported, not enforced | reported |
| 17. scenario loss | ✔ | reported, not enforced | reported |
| 18. duplicate intent / self-trade | ✔ | duplicate only | — |
| 19. rate-limit headroom | ✔ | — | — |
| 20. time-to-close | ✔ | — | — |

The two rules behind the "—" cells:

- **§6 invariant 13** — "Safety cancellation outranks new order placement": a
  `CANCEL` is never blocked. See §4.1.
- **Capacity limits gate entries, not exits.** An exit reduces exposure;
  enforcing a cap against it would block exactly the action that brings the
  account back inside the cap. The measures are still computed and returned so
  an operator can see them.

### 4.1 A CANCEL is never blocked — and how that is enforced

> **Corrected 2026-09-02 (remediation round 1).** This section previously read
> "a `CANCEL` … *is* still blocked by an out-of-range run mode, which is a
> process configuration error rather than a market condition", and the check
> table marked checks 2, 14b, and 18 as applying to a cancel. **That was wrong
> and the code matched it**: adversarial review round 1 (BLOCKER 1) found that a
> run-mode mismatch and an explicit allocator refusal each blocked a cancel, and
> a same-class audit of every gate additionally found a missing market context
> and a non-canonical `approvedIntentId` doing the same. §6 invariant 13 admits
> no exception: blocking a cancel can trap a position, which is precisely the
> failure the invariant exists to prevent. The original wording is preserved
> here rather than quietly replaced.

> **Corrected 2026-09-03 (remediation round 2).** The `RISK_UUID_NOT_CANONICAL`
> row below read "observed, never blocks", and the paragraph after it called
> input *schema* validation the one unavoidable gate. Adversarial review round 2
> (BLOCKER) established what that combination produced: a `CANCEL` carrying a
> UUID-shaped, **non-canonical** `approvedIntentId` was approved and the id was
> copied verbatim into the emitted record — a contract-invalid record, which
> ADR-016 §2 forbids ("none may accept uppercase 'just for lookups'"). The
> ruling: `evaluateIntent(policy, input: unknown)` **is** an input surface, and
> §6 invariant 13 protects a **valid** cancel from risk *policy* — it does not
> require accepting a malformed identity. Identity validation is therefore
> **input validation**, applied at the door for every disposition, and the id is
> still never case-folded. The superseded row is preserved below, struck.

The rule is now **structural**, not a per-check condition. `evaluateIntent`
first passes the request through **one input door**
(`inputs.ts` `validateEvaluationInput`: the schema *and* ADR-016 §2 identity
validation), then runs the pipeline, then reaches one choke point: if the
disposition is `CANCEL`, every refusal that accumulated — from any gate,
including gates added later — becomes a non-blocking observation on
`cancelPriorityOverrides` and the cancel is **approved**, carrying its typed
record, its recommendations, and its worst-case measure. The gates audited, and
what the audit found:

| Gate | Could it block a cancel before? | Now |
| --- | --- | --- |
| input validation — schema (`RISK_INPUT_INVALID`) **and** ADR-016 §2 identity (`RISK_UUID_NOT_CANONICAL`) | yes | **yes, unavoidably** — it answers before a disposition exists. An unparseable request names no orders to cancel, and a request whose identity is malformed is not a valid cancel |
| ~~`RISK_UUID_NOT_CANONICAL` (record identity)~~ *(superseded; it is input validation, one row up)* | **yes — audit finding** | ~~observed, never blocks~~ **refused at the door** |
| `RISK_INTENT_EXPIRED` | no (§7.7 gives `CANCEL` no `validUntil`) | observed, never blocks |
| intent-view refusals (`RISK_ZERO_DELTA`, `RISK_BASKET_LEG_UNBOUNDED`) | no (a cancel produces neither) | observed, never blocks |
| check 1 run / strategy state | no (`placesOrders` guard) | never blocks |
| check 2 run mode vs process maximum | **yes — reviewer's BLOCKER 1** | observed, never blocks |
| check 3 real-order surface, check 4 eligibility | no (`placesOrders` guard) | never blocks |
| `RISK_MARKET_CONTEXT_MISSING` | **yes — audit finding** | observed, never blocks |
| checks 5, 7, 8, 9, 10, 11a | no (`placesOrders` guard) | never blocks |
| checks 6, 11b, 12, 13, 15, 19, 20, self-trade | no (`isEntry` guard) | never blocks |
| check 14a allocator verdict absent | no (`isEntry` guard) | never blocks |
| check 14b allocator verdict **refused** | **yes — reviewer's BLOCKER 1** | observed, never blocks |
| check 14c sell ≤ inventory | no (a cancel has no legs) | observed, never blocks |
| `RISK_POSITION_STATE_UNKNOWN`, `RISK_QUOTE_MAX_INVENTORY_EXCEEDED` | no (EXIT / QUOTE only) | never blocks |
| check 16 `RISK_WORST_CASE_UNBOUNDED` and the approval backstop | no (a cancel has no unbounded BUY leg) | observed, never blocks |
| check 18 duplicate intent | no (§7.7 gives `CANCEL` no `intentId`) | observed, never blocks |

`cancelPriorityOverrides` is **not** a refusal list. The evaluation is approved;
the entries are what an operator and the §9.9 incident controller should still
see. Pinned by `test/unit/risk/engine.test.ts`, describe block *"§6 invariant 13
— a CANCEL survives every audited gate"*, including a case that trips all three
audited risk gates at once, with every other input hostile too.

### 4.2 ADR-016 §2 identity validation — what the door checks

A UUID-shaped identifier that is not canonical lowercase is **refused with the
raw value, never case-folded** (ADR-016 §2, 2026-09-02 amendment). The check
runs at the input door, so no disposition can override it and no approved record
can carry one.

| Field | In scope? | Why |
| --- | --- | --- |
| `identifiers.approvedIntentId` | **yes** | the record's own identity and its lineage root |
| `context.strategyInstanceId` | **yes** | copied into every record |
| `intent.intentId` | **yes** | copied to `sourceIntentId` and carried inside `record.intent` |
| `guards.recentIntentIds[]` | **yes** | compared against `intentId`; a re-cased entry would silently under-match §9.8 check 18 |
| `record.*` on `resizeApprovedIntent` | **yes** | the argument is typed by TypeScript only; everything it carries is inherited into the new record — see §4.3 and §4.4 (round 4: it is now read as data and parsed in full) |
| any `marketId` **arriving as engine input** | n/a | `InternalMarketId` is lowercase-canonical UUIDv7 in the frozen schema, so a re-cased one is already `RISK_INPUT_INVALID` |
| `intent.orderIds[]` | **no** | Venue-supplied **by contract**: `CancelIntentSchema.orderIds` is `z.array(VenueOrderIdSchema)`. ADR-016 §2 "does not touch any venue wire format", and its premise (every UUID here is generated in-process) is false for these: a venue string must round-trip exactly as the venue spelled it, and refusing one on a `CANCEL` would trap a position for a rule the ADR does not impose |
| `portfolio.openOrders[].orderId` | **no** | **Corrected 2026-09-03 (review round 4).** This row used to claim the field was venue-supplied. It is **not established either way**: the schema types it only `NonEmptyString`, and the repository has both an in-process `execution.orders.order_id internal.uuid_v7` and a separate `venue_order_id` column (`db/migrations/0005_execution.up.sql`). It is out of scope on a narrower ground that does not need the answer: this door also admits a `CANCEL`, so a refusal here can trap a position, and the field never reaches an approved record. Contract-annotation follow-up R3-2 |

### 4.3 The emission boundary — why the table above is not the whole rule

**Corrected 2026-09-03 (adversarial review round 3).** §4.2's field table
describes the ENGINE'S DOOR, and rounds 2 and 3 each proved that a table of
fields is not a property. Round 2 fixed one field and its sweep found five;
round 3 still found a sixth — `record.intent.marketId`, inherited by
`resizeApprovedIntent` from a hand-built record and copied whole into the
emitted record — and remediation round 3's probe found the property false at 43
further positions, including `worstCase.perMarket[].marketId`.

So identity completeness is now derived from the code's shape:

- **one boundary.** `sealApprovedIntentRecord` is the only place an
  `ApprovedIntentRecord` is frozen and returned. `evaluateIntent`'s two arms
  and `resizeApprovedIntent` all go through it;
- **a walk, not a list.** It checks *every* string at *every* depth of the
  record it is about to emit. `resizeApprovedIntent` walks the record it
  inherits, and the parsed request, the same way — before it constructs
  anything;
- **the exceptions are the closed set**, `NON_IDENTITY_KEYS`: `orderIds`
  (`CancelIntentSchema.orderIds` is `z.array(VenueOrderIdSchema)`), `reason` /
  `resizeReason` / `rationale` (`DetailStringSchema` prose, "never parsed, only
  displayed or logged"), and `tags` (`z.array(TagSchema)`, §7.7 free-form
  strategy tags). Each entry names the schema that types it as something other
  than a repository identifier, and two of them ride the `CANCEL` path, where
  over-refusal would trap a position;
- **the inherited record is parsed**, not trusted, because the resize computes
  on it and copies most of it forward. A hand-built `targetShares` is a typed
  `RISK_INPUT_INVALID` instead of a thrown `InvalidDecimalStringError`.

A seventh identity field is therefore validated the moment it exists, with no
edit here — and the suite notices too: `test/unit/risk/engine.test.ts`, describe
block *"the emission boundary — a record is never built from an unvalidated
identity"*, generates its cases by walking a real record, so a new field is a
new case automatically. The older block *"ADR-016 §2 — record identity is INPUT
VALIDATION, never a cancel override"* still pins the door.

**Two corrections, 2026-09-03 (adversarial review round 4).** Singular `orderId`
was REMOVED from the exclusion set: no field an approved record can carry is
typed `VenueOrderId` under that name, and the repository's own `execution.orders`
table has an in-process `order_id internal.uuid_v7` beside a separate
`venue_order_id` column, so the name does not imply "venue". And `rationale`'s
exclusion cited a contract type the field did not have — it was an unconstrained
`string`; `IncidentActionRecommendationSchema` now types it `DetailStringSchema`,
so the justification is enforced rather than asserted. Each exclusion is bounded
by its TYPE, not by its key name: a `tag` that is not a `CodeString`, or a
`rationale` that is not a `DetailString`, is still refused — by the shape check
rather than the identity check.

### 4.4 The data-record boundary — why a walk was still not enough

**Adversarial review round 4.** §4.3's walk used `Object.entries`, which reports
only enumerable own properties. The enumeration primitive had become the new
list, and three shapes carried a contract-invalid repository identifier through
it: a **non-enumerable** property (accepted, emitted, and frozen into the
returned record), a property on the object's **prototype** (accepted — and
editing that prototype afterwards changed the value the "frozen" record
reported, so the record was not deeply immutable either), and an **accessor**,
whose getter `Object.entries` does not skip but INVOKES, so a throwing getter
escaped `resizeApprovedIntent` as an exception. The round-3 test walked the same
way, so it could not have caught any of them.

So this package no longer treats a caller-supplied object as a record.
`src/plain-data.ts` **reads** a value into plain own data before anything looks
at it, and both boundaries use only that snapshot — for identity validation, for
arithmetic, and as the value that is emitted:

- values come from property **descriptors**, so a getter is refused without ever
  being invoked;
- a **non-plain prototype** is refused: an inherited property is state the
  container does not own, and `Object.freeze` cannot reach it;
- a **non-enumerable data property is read**, not rejected — hiding a field does
  not remove it — so it is checked like any other and comes back as a
  `RISK_UUID_NOT_CANONICAL` refusal naming its exact path;
- functions, symbols, symbol-keyed properties, cycles, sparse arrays and
  excessive nesting are typed refusals;
- `ApprovedIntentRecordSchema` states the record's **complete runtime shape**, so
  `resizeApprovedIntent`'s `record` argument — typed by TypeScript, parsed by
  nothing until now — is parsed in full before it is computed on.

Two properties follow by construction rather than by argument: what any walk can
see IS what the record carries, and an emitted record is a fresh, deeply frozen
tree that shares no object with the caller — so no later edit of theirs can
reach inside it.

**Adversarial review round 5 corrected two sentences this section used to make**,
and the corrections are the substance of §4.5.

1. It said "**No caller code runs inside the boundary**", flat. False for a
   `Proxy`: every reflective operation on one runs a trap, so a nested proxy in
   an otherwise valid record was ACCEPTED after nine trap invocations.
2. It said a hostile `Proxy` "cannot make this package throw". Also false: an
   array proxy whose `length` answered with a throwing `@@toPrimitive` escaped
   through the code that **built the refusal**, so the public
   `resizeApprovedIntent` threw.

### 4.5 What the boundary claims after round 5, and what it rests on

The single absolute is replaced by three propositions, each testable
separately. `src/plain-data.ts` states them at length; in short:

1. **No code carried by the inspected value is invoked** — no getter, setter,
   `Proxy` trap, `@@toPrimitive` or `toString`. Three mechanisms: descriptor
   reads; a `Proxy` refused *before* any reflective operation by
   `util.types.isProxy`, which is a V8-level predicate that consults no trap
   (portable JavaScript has no such predicate — any portable probe already runs
   a trap); and `Object.defineProperty` for every property of the materialized
   tree, so no *inherited* setter runs either. **What it assumes:** that the
   intrinsics are genuine. A process that has replaced `Object`, `Reflect` or
   `util.types` has already lost, and no boundary inside it can help — a
   different threat model from "a caller handed us a hostile value".
2. **Totality is a property of the CLASSIFIED surface, not of the word
   "public".** *Corrected 2026-09-03 (review round 6).* Round 5 wrote here:
   "Totality is unconditional. No public function of this package throws for any
   input." **That was false**, and the reviewer's five-line matrix proved it:
   `assessWorstCase`, `riskRefusal`, `exposureSnapshot`,
   `nonFloorLiveMicroCapFields` and `validateEvaluationInput` all threw on a
   `Proxy` or an inherited getter. The functions round 5 had wrapped were total;
   the exported SURFACE was not, because nobody had enumerated it. What is true,
   and now enumerated export by export in
   `test/unit/risk/public-surface.test.ts` — which fails if an export is added
   without a classification:

   - every public function that takes an `unknown` (`validateEvaluationInput`,
     `parseRiskPolicy`, `evaluateIntent`, `resizeApprovedIntent`), the refusal
     constructors (`riskRefusal`, `riskOk`, `riskFailure`) and the pure
     predicates are **TOTAL**: they answer with a typed refusal for any value,
     including a `Proxy`, an inherited getter and a hostile descriptor;
   - the typed helpers whose result type cannot express a refusal —
     `assessWorstCase`, `buildWorstCaseLots`, `assessScenarios`,
     `assessFreshness`, `buildIntentView`, `heldShares`, `checkExposureLimits`,
     `recommendIncidentActions`, `settlementValueUnderOutcome` — **PROPAGATE**,
     deliberately. Containing them would mean INVENTING a measurement, and the
     only inventable number here is `"0"`: a worst-case loss of zero, or an
     empty exposure snapshot, is precisely the fail-open
     `RISK_EXPOSURE_ENTRY_MISSING` exists to prevent. Every in-repository call
     site runs inside `contained`, so no public ANSWER of this package is ever
     an exception; the classification test runs each hostile call and requires
     it to throw, so the entry is a measurement rather than a hope.

   The cost of containment where it IS applied is stated in `src/result.ts`: a
   genuine bug becomes a typed refusal rather than a crash.
3. **The output is plain own frozen data whatever the input did** — a fresh
   tree built one `defineProperty` at a time, sharing no object with the
   argument.

Two more round-5 corrections, both narrowings rather than repairs:

- **`__proto__` is refused as a property name.** Materializing it as an honest
  own data property is necessary but not sufficient: `zod`'s `strictObject` is
  blind to exactly this one key — it reports every other unrecognized name and
  silently drops this one (measured; the transcript is in `src/plain-data.ts`).
  A field a strict schema cannot report is a field this package cannot promise
  to refuse, so the name is refused at the read instead.
- **"Exactly one traversal primitive" was too broad.** What is true is that the
  ADR-016 §2 **identity check** traverses nothing of its own — it consumes the
  read's string inventory. `deepFreeze` (`src/guards.ts`) and the
  `Object.entries` in `src/exposure-limits.ts` are traversals too; both run on
  values already materialized or schema-validated, and `deepFreeze` is now
  descriptor-based for the same reason the read is.
- **Keyed tables use `ownEntry`/`Object.defineProperty`, never `table[key]`.**
  A scope key is a `CodeString`, so `"constructor"` is admissible input, and
  `table["constructor"]` answers the `Object` constructor rather than
  `undefined` — which would have read as a *measured* scope carrying no
  numbers, bypassing `RISK_EXPOSURE_ENTRY_MISSING` (§5, "Check 15 — capacity
  limits"; review round 1, BLOCKER 2) and feeding `undefined` to decimal
  arithmetic.

Pinned by `test/unit/risk/engine.test.ts`, describe blocks *"the data-record
boundary — a caller's object is not a record"* (round 4) and *"a hostile value
at the boundary — review round 5"*, and by the audited-built-in test in
`test/unit/risk/freshness.test.ts`.

### 4.6 An absent field is absent (review round 6)

A fourth proposition, added because round 6 found the third fail-open of this
chain and the first that needed no hostile input at all: **`Object.prototype` is
reachable state, and "this record has no such field" and "nobody has put that
name on `Object.prototype`" are different questions.**

- The materialized tree has **no prototype** (`Object.create(null)`), so a
  validator handed it cannot **adopt** an inherited field. Measured on the pinned
  `zod`: `z.strictObject({ b: z.string().optional() }).safeParse({ a: "x" })`
  with an inherited `b` returns `{ a: "x", b: "inherited" }` for an ordinary
  object, and `{ a: "x" }` for a prototype-free one. An absent
  `venueEligibility` would otherwise have arrived as `"ELIGIBLE"` and §9.8
  check 4 would have passed on a fact nobody supplied.
- Every computed table read goes through `ownEntry` / `ownFlag` /
  `ownProperty`, and `"intentId" in intent` — which consults the prototype, and
  which made a valid CANCEL refuse with `RISK_UUID_NOT_CANONICAL` — is an
  own-property test.

### 4.7 The validated value is the value we read (review round 7)

Round 6 also made each door **refuse a parse output smaller than what it read**,
because an inherited GET-ONLY accessor makes an assignment inside the validator
fail and a field can vanish from the output while the parse still reports
success. Review round 7 ruled that refusal a BLOCKER, and it was right to: its
probe was a valid `CANCEL` with an intact `intent.reason` and a get-only
`Object.prototype.reason`, and the door answered `RISK_INPUT_INVALID` with
`lost: ["input.intent.reason"]` — a **cancel trapped by an artefact of the
library's output assembly**, which §6 invariant 13 forbids.

The answer is architectural rather than a narrower check. **No door reads the
library's output.** A door materializes the input, asks the schema the QUESTION,
and then uses **the materialized tree** — own data, no prototype, built here one
`defineProperty` at a time. Adoption and loss both stop being detectable
conditions and start being unreachable ones.

What a schema legitimately CONTRIBUTES — a `.default()` — is applied from a table
the door declares (`RISK_POLICY_DEFAULTS`, `ALLOCATOR_CAPS_DEFAULTS`), because
that value is not the caller's and cannot come from the read. That is not
bookkeeping: at the round-6 tip, one get-only inherited accessor made `zod` fail
to assign its own default, so the key was missing from the output and the later
read walked the chain — `requireVerifiedSettlementForEntries` silently skipped
§9.8 check 6 and **approved** an entry with unverified settlement,
`requirePositiveNetEdgeForEntries` silently skipped check 12 and **approved** a
negative-edge entry, and `maxRunMode` made check 2 disappear. All three refuse
today.

Three mechanisms hold this, and none is a list. `test/unit/risk/prototype-access.test.ts`
asks the TypeScript compiler for every computed access, `in`, spread,
`Object.assign`, destructuring, `for…in`, `Reflect.*`, `Object.entries`/`keys`
and `structuredClone` in both packages and requires each to be an own-property
primitive or a registered exception with a reason — and states the complete list
of forms it does NOT see, each exercised by a probe.
`test/unit/risk/inherited-state.test.ts` re-runs every public door with
`Object.prototype` carrying one extra property — the names drawn from the door's
own inputs and from the doors' default tables — and requires the answer to be
unchanged, or to have become a typed refusal; **on a CANCEL, unchanged is the
only permitted outcome.** `test/unit/risk/schema-output.test.ts` walks each
door's schema and fails if it ever contributes a value the door does not apply.
An inherited property may cost availability; it may never buy permission, and it
may never trap a cancel.

### 4.8 Not reading the library's output was not enough (review round 8)

Round 7's rule — *a schema answers a question, it does not hand you the value* —
was necessary and **not sufficient**. Discarding the output does not stop the
library BUILDING it, and it builds it by ASSIGNMENT onto an object it created
with `{}`. An ordinary object inherits from `Object.prototype`, so that
assignment consults the prototype chain and invokes an inherited **setter**. The
reviewer's probe, against the round-7 tip, was a valid `CANCEL` carrying its own
`intent.reason` with a throwing setter at `Object.prototype.reason`:

```text
setterCalls=1, approved=false, codes=["RISK_INPUT_INVALID"]
```

— a cancel trapped by a failure inside an assembly nobody reads. An ACCEPTING
setter was invoked three times across one validation and one evaluation: the
answer survived, but a caller-supplied prototype was reading every validated
field.

**The obvious fix is a fail-open, and it was measured rather than assumed.**
"Ignore an assembly failure and answer valid" fails because the library
validates and assigns key by key: the abort leaves every later key unvalidated,
so `{ a: { reason: "ok" }, b: 42 }` — invalid — comes back with no issues at all.

So the assembly stops being able to reach a polluted prototype.
`src/schema-arena.ts` builds each door a **parsing copy** of its schema: the same
nodes, built by the library from the library's own definitions, running on a
payload whose assembly container has **no prototype**, with a parse context that
has none either. Under an accepting or a throwing inherited setter, on every key,
every door now answers **byte-identically** to the clean answer and the setter is
invoked **zero** times.

The parse context matters on its own. The library reads optional switches off it
(`ctx.skipChecks`, `ctx.direction`, `ctx.jitless`), and at the round-7 tip those
reads walked the chain — so one non-enumerable `Object.prototype.skipChecks =
true` turned **every format check in every door into a no-op**: an
`evaluatedAt` of `"definitely-not-a-timestamp"` and a market id of
`"not-a-uuid"` both validated. That was a live fail-open, found by this round and
closed by it.

Round 8 also found the same class **in this repository's own code**: a property
descriptor written as an object literal is read through the prototype chain, so
`Object.prototype.get` alone made every `Object.defineProperty` here a
`TypeError` — and, because building a refusal defines properties too, it escaped
`evaluateIntent` as an exception rather than a refusal. Every descriptor is now
built with a `null` prototype (`ownDataDescriptor` / `ownAccessorDescriptor`),
and every descriptor-attribute name is swept from here on.

### Staleness and exits, stated exactly

| Stale or unmeasured feed | Entry | Exit / reduction | Cancel |
| --- | --- | --- | --- |
| features / reference feed | **BLOCKED** | permitted | permitted |
| venue book | **BLOCKED** | **BLOCKED**, with `CANCEL_RESTING_ORDERS` + `RECONCILE_ACCOUNT` recommendations | permitted |

Sources, verbatim: §9.9 row 1 ("External reference feed stale, Polymarket
healthy → Cancel signal-dependent quotes; halt new entries" — the venue book is
healthy, so exits are not halted); §9.9 row 2 ("Polymarket book stale → Cancel
resting orders; no blind aggressive orders"); §6 invariant 12 ("No blind flatten.
Unknown position or book state causes cancel and reconciliation before any
protected reduction action"). The protected reduction happens *after*
reconciliation, under the incident controller — not here, and not now.

Staleness itself is a **caller-supplied measurement** (`ageMs`). This package
reads no clock, so the same inputs give the same verdict on replay as they did
live (§6 invariant 2, §12.4).

## 5. Reason codes — the PACKAGE-OWNED vocabulary

**The vocabulary has exactly 62 codes**, all listed below.

Every rejection, approval, and recommendation carries a code from this list.
Codes follow the frozen `CodeString` grammar (`^[A-Za-z][A-Za-z0-9_.:-]*$`, ≤ 64
characters) so they are safe as metric labels (§14.3). **Adding a code is
additive; changing the meaning of one is not** — operators alert on them. The
list is exported at runtime as `RISK_REASON_CODES`, and its cardinality as
`RISK_REASON_CODE_COUNT`, so a consumer can validate a persisted code against
the vocabulary of the version that wrote it. `test/unit/risk/engine.test.ts`
fails if any declared code becomes unreachable, if the count drifts from
`RISK_REASON_CODE_COUNT`, **or if this section stops documenting exactly the
declared set** — the three surfaces are bound together by test.

> **Corrected 2026-09-02 (remediation round 1).** `docs/handoffs/WP-180.md`
> claimed a 56-code vocabulary against a list that actually held 61 (adversarial
> review round 1, MEDIUM); the count is now pinned in code and asserted, and
> `RISK_EXPOSURE_ENTRY_MISSING` was added by the BLOCKER-2 fix in the same
> round, bringing the total to 62.

### Input validation

| Code | Meaning |
| --- | --- |
| `RISK_INPUT_INVALID` | The evaluation input, the policy, the resize request, or a resize's INHERITED intent failed its schema. |
| `RISK_UUID_NOT_CANONICAL` | A UUID-shaped **repository** identifier arrived in a non-lowercase spelling. ADR-016 §2: refuse at the input surface, never case-fold. The door's fields and the venue exclusion are in §4.2; the record rule that covers every other position is §4.3, and the data-record boundary it rests on is §4.4. |
| `RISK_INTENT_EXPIRED` | `validUntil` is before the caller-supplied evaluation instant, or the two are not comparable. |
| `RISK_ZERO_DELTA` | The position intent resolves to no share delta; there is nothing to execute. |
| `RISK_MARKET_CONTEXT_MISSING` | No market context was supplied for a market the intent touches. |

### Checks 1–4 — state, mode, enablement, eligibility

| Code | Meaning |
| --- | --- |
| `RISK_RUN_STATE_BLOCKS` | The run state does not permit this intent. |
| `RISK_STRATEGY_STATE_BLOCKS` | The strategy instance state does not permit this intent. |
| `RISK_RUN_MODE_EXCEEDS_MAXIMUM` | The requested run mode is above the configured process maximum (§11). |
| `RISK_REAL_ORDER_SURFACE_UNSUPPORTED` | The run mode places real orders, and this package cannot verify enablement or fencing (§6 invariants 16, 17). **It refuses by construction** — a second floor under check 2. |
| `RISK_VENUE_ELIGIBILITY_UNVERIFIED` | Eligibility is not a verified `ELIGIBLE` result. Absent = unverified = blocked (§6 invariant 18). |

### Checks 5–6 — market and settlement

| Code | Meaning |
| --- | --- |
| `RISK_MARKET_NOT_ACCEPTING` | The market is halted. |
| `RISK_MARKET_STATUS_UNKNOWN` | The market status is `UNKNOWN`; acting on it would be blind. |
| `RISK_MARKET_CLOSE_ONLY` | Close-only: new entries blocked, reductions permitted. |
| `RISK_SETTLEMENT_UNVERIFIED` | Settlement readiness does not permit model-dependent activation (§9.3, WP-110). Absent = unverified. |

### Check 7 — freshness

| Code | Meaning |
| --- | --- |
| `RISK_FEATURES_STALE` | The feature snapshot is older than its policy limit. |
| `RISK_REFERENCE_FEED_STALE` | The external reference feed is older than its limit. |
| `RISK_BOOK_STALE` | The venue book for this market is older than its limit (entry). |
| `RISK_FRESHNESS_UNKNOWN` | A required feed carries **no** measurement. Unknown is treated exactly like stale. |
| `RISK_BOOK_STALE_NO_BLIND_REDUCTION` | A **reduction** into a stale or unmeasured book. §6 invariant 12: cancel and reconcile first. |

### Checks 8–11 — book, parameters, price, size

| Code | Meaning |
| --- | --- |
| `RISK_BOOK_NOT_SYNCHRONIZED` | The local book is not confirmed synchronized. Absent = unknown = blocked. |
| `RISK_TRADING_PARAMETERS_UNKNOWN` | Tick size, minimum order size, or the parameter version is unknown (§6 invariant 9). |
| `RISK_PRICE_NOT_TICK_CONFORMANT` | A leg price is not an exact multiple of the tick size. |
| `RISK_SIZE_BELOW_MINIMUM` | A leg is below the market's minimum order size. |
| `RISK_NOTIONAL_BELOW_ECONOMIC_FLOOR` | An **entry** below the configured economic floor. Never applied to an exit. |

### Check 12 — economics

| Code | Meaning |
| --- | --- |
| `RISK_NET_EDGE_NOT_POSITIVE` | Edge does not survive fees, slippage, and the risk buffer. |
| `RISK_EDGE_INPUTS_MISSING` | A declared edge, fee estimate, or slippage estimate is absent. An unsupplied cost is not a zero cost. |

### Checks 13–14 — participation, balances, inventory

| Code | Meaning |
| --- | --- |
| `RISK_PARTICIPATION_LIMIT_EXCEEDED` | More bought shares than the configured per-intent limit. |
| `RISK_ALLOCATION_REFUSED` | The capital allocator refused; its own codes ride in `details.allocatorCodes`. |
| `RISK_ALLOCATION_VERDICT_MISSING` | No allocator verdict supplied for an **entry**; balances and reservations are unproven. |
| `RISK_SELL_EXCEEDS_INVENTORY` | A sell leg exceeds the confirmed holding (§6 invariant 10). |
| `RISK_QUOTE_MAX_INVENTORY_EXCEEDED` | A fully-filled quote ladder would breach the intent's own `maximumInventory`. |

### Check 15 — capacity limits

| Code | Meaning |
| --- | --- |
| `RISK_PER_ORDER_NOTIONAL_EXCEEDED` | The intent's bounded notional exceeds the per-order limit. |
| `RISK_GLOBAL_EXPOSURE_EXCEEDED` | The global cap. |
| `RISK_INSTANCE_EXPOSURE_EXCEEDED` | The per-strategy-instance cap. |
| `RISK_MARKET_EXPOSURE_EXCEEDED` | The per-market cap. |
| `RISK_SERIES_EXPOSURE_EXCEEDED` | The per-series cap. |
| `RISK_UNDERLYING_EXPOSURE_EXCEEDED` | The per-underlying cap. |
| `RISK_RESOLUTION_WINDOW_EXPOSURE_EXCEEDED` | The per-resolution-window cap. |
| `RISK_EXPOSURE_SNAPSHOT_MISSING` | A cap is configured and no snapshot was supplied. An unmeasured limit is not a passed limit. |
| `RISK_EXPOSURE_ENTRY_MISSING` | A cap is configured and the supplied snapshot carries **no entry** for the queried scope. An absent entry is *unknown* exposure, not zero exposure. Supply an explicit zero entry (the allocator's `exposureSnapshotCovering` builds one for a declared key set). |
| `RISK_SCOPE_KEY_MISSING` | A scope cap is configured for a dimension the market carries no attribution for. |

Every entry consumes a limit from **both** components — resting open orders and
held positions — and this package **recomputes** their sum rather than reading
the `combined` field the allocator also publishes, so a drifted derived field
cannot pass a limit.

### Check 16 — the PRIMARY measure

| Code | Meaning |
| --- | --- |
| `RISK_WORST_CASE_LOSS_EXCEEDED` | Projected maximum contractual loss above `limits.maxWorstCaseContractualLoss`. |
| `RISK_WORST_CASE_RESOLUTION_LOSS_EXCEEDED` | Projected worst-case loss over the three verified outcomes above its limit. |
| `RISK_WORST_CASE_UNBOUNDED` | The intent bounds no maximum cost, so it cannot be shown to pass the primary limit. |
| `RISK_BASKET_LEG_UNBOUNDED` | A buying basket leg carries no `maximumBuyPrice` (§9.10: a basket is coordinated, not atomic — each leg's risk must be bounded). |

These four are exactly `PRIMARY_RISK_REASON_CODES`.

### Check 17 — scenarios

| Code | Meaning |
| --- | --- |
| `RISK_SCENARIO_LOSS_EXCEEDED` | The worst supplied scenario exceeds `scenario.maxScenarioLoss`. |
| `RISK_SCENARIO_MISSING` | A required shock kind (`SPOT`, `VOLATILITY`, `TIME`, `LIQUIDITY`) was not supplied. |
| `RISK_SCENARIO_MARKS_INCOMPLETE` | A supplied scenario does not mark every held market; a partial mark understates the loss. |

### Checks 18–20 — guards, headroom, close

| Code | Meaning |
| --- | --- |
| `RISK_DUPLICATE_INTENT` | This `intentId` was already evaluated. |
| `RISK_SELF_TRADE` | The intent would cross the account's own resting order on the same market and token. |
| `RISK_RATE_LIMIT_HEADROOM_INSUFFICIENT` | Headroom at or below the safety reserve (§6 invariant 13). |
| `RISK_RATE_LIMIT_UNKNOWN` | Headroom was not supplied. |
| `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED` | Inside the configured entry cutoff before close. |
| `RISK_TIME_TO_CLOSE_UNKNOWN` | Time to close was not supplied. |

### Reductions and unknown state

| Code | Meaning |
| --- | --- |
| `RISK_POSITION_STATE_UNKNOWN` | A reduction was requested for a market the supplied portfolio holds no position in (§6 invariant 12). |

### Approvals

| Code | Meaning |
| --- | --- |
| `RISK_APPROVED` | The intent passed every applicable check. |
| `RISK_CANCEL_ALWAYS_PERMITTED` | Approved as a safety cancellation (§6 invariant 13). |
| `RISK_EXIT_CAPACITY_CHECKS_INAPPLICABLE` | Approved as a reduction; capacity, edge, and time gates do not apply. |

### Resize

| Code | Meaning |
| --- | --- |
| `RISK_RESIZE_NOT_A_REDUCTION` | A risk resize must strictly reduce `|targetShares|`. |
| `RISK_RESIZE_ID_REUSED` | The new record reused an id from the lineage; that would edit, not create. |
| `RISK_RESIZE_UNSUPPORTED_TYPE` | Only `POSITION` and `REDUCE_POSITION` carry a single resizable `targetShares`. |
| `RISK_RESIZE_INCOHERENT` | The resize would flip the side of the original intent. |

## 6. Approved-intent records and resize lineage

| Field | Meaning |
| --- | --- |
| `approvedIntentId` | This record's own identity. |
| `lineage` | `ORIGINAL` or `RESIZED`. |
| `supersedesApprovedIntentId` | The record this one replaces (absent on an `ORIGINAL`). |
| `rootApprovedIntentId` | Head of the chain, so an arbitrarily long resize chain is traceable in one hop. |
| `sourceIntentId` | The strategy's own `intentId`. Absent for `CANCEL` and `REDUCE_POSITION`, which §7.7 gives none. |
| `worstCaseBasis` | `EVALUATED` (computed for this intent) or `INHERITED_UPPER_BOUND` (carried from the record being resized). |

Records are deeply frozen: an in-place edit **throws**. A resize returns a new
record and leaves the original untouched. Freezing happens **inside**
`sealApprovedIntentRecord` (§4.3), so "emit a record" and "validate the record
being emitted" are one act rather than two conventions — and since round 4 the
value emitted is the *materialized* one (§4.4), so "deeply frozen" means the
record cannot be changed through a prototype or a getter either, not merely that
`Object.freeze` was called on it.

`resizeApprovedIntent`'s `record` argument is INPUT, not a trusted value: it is
read into plain own data (§4.4), checked for ADR-016 §2 violations in full, and
parsed against `ApprovedIntentRecordSchema` — including its `intent` against the
frozen §7.7 contract — before anything is built. The returned record shares no
object with it, so a caller cannot reach into a record it was given back.

Ceilings the strategy set (`maximumTotalCost`, `maximumBuyPrice`,
`minimumSellPrice`, `validUntil`) are copied unchanged by a resize — a ceiling
stays valid under a smaller size, and scaling one would be this package
inventing a number the strategy did not supply. Re-running `evaluateIntent` on a
resized intent produces a fresh `EVALUATED` record.

### 6.1 Consuming an emitted record — it has a `null` prototype

**Read this before consuming a record in WP-190 (execution planner) or WP-230.**
An emitted `ApprovedIntentRecord` is the materialized tree (§4.4), so every
object in it is created with `Object.create(null)`. That is deliberate — it is
what makes "this record has no such field" a different question from "nobody has
put that name on `Object.prototype`" (§4.6) — and it is a real difference from an
ordinary object. Measured:

| Works | Does NOT work |
| --- | --- |
| `Object.hasOwn(record, key)` | `record.hasOwnProperty(key)` — `undefined` |
| `Object.keys` / `entries` / `values` | `record.toString()`, `record.valueOf()` — `undefined` |
| `JSON.stringify(record)` | `record instanceof Object` — `false` |
| `key in record`, `record.field`, destructuring | `util.inspect` renders `[Object: null prototype] { … }` |
| `expect(...).toEqual(record)` (vitest / jest) | |

Consequences for a consumer, stated so none of them is a surprise:

- use `Object.hasOwn(record, key)`, never `record.hasOwnProperty(key)`, and never
  `record instanceof Object` as a "is this an object" test — use
  `typeof value === "object" && value !== null`;
- **a spread or a clone RESTORES `Object.prototype`.** `{ ...record }` and
  `structuredClone(record)` both work and both produce an ORDINARY object, which
  silently gives up the property above. If a consumer copies a record and then
  reads optional fields off the copy, an inherited name can answer for an absent
  field again. Re-harden the copy (build it with `Object.create(null)`), or
  re-validate it against `ApprovedIntentRecordSchema` and read only own
  properties;
- persistence and transport are unaffected: `JSON.stringify` produces the same
  bytes as for an ordinary object, and a record round-tripped through JSON comes
  back ordinary — so the boundary to re-establish is the one where a record
  RE-ENTERS a decision path, not the one where it leaves the process.

The same is true of the object `parseRiskPolicy` returns, and of the
caller-supplied parts of an allocator state (`packages/capital-allocator/README.md`
§2.1). No contract specifies a prototype for any of them, no consumer package
exists yet, and this is recorded in `docs/handoffs/WP-180.md` (round 6 deviation
R6-5, promoted here in round 7 at the reviewer's instruction).

## 7. Incident action recommendations

`recommendIncidentActions(failureClass, marketId?)` returns the §9.9 default
actions for a failure class as `kind: "RECOMMENDATION"` data. The action
vocabulary is the §9.9 ladder verbatim, and the mapping reproduces the §9.9
default-action table row by row, each recommendation quoting the row it comes
from. **Nothing here performs an action**, and no recommendation carries a
callable.

## 8. Dependency boundary

`packages/risk` declares exactly `@polymarket-bot/decimal` and
`@polymarket-bot/domain` (both layer 0) plus `zod`. It imports **no** layer-1
peer: `docs/contracts/dependency-direction.md` §2.1 lists no same-layer edge for
it, and adding one would be F13. Two consequences, both deliberate:

- The **capital-allocator** exposure snapshot and reservation verdict are
  consumed **structurally**, as loose views (`ExposureSnapshotViewSchema`,
  `AllocationVerdictViewSchema`). `test/unit/risk/ports.test.ts` pins the port
  three ways: `tsc`-checked field names, a runtime parse of real allocator
  output, and an end-to-end pass driving a refusal from the allocator's own
  numbers.
- The **settlement** payout constants are **mirrored**, not imported, and
  `test/unit/risk/worst-case.test.ts` imports both packages (a test tree is not
  a workspace package and declares no edge) to assert they still agree.

Small helpers duplicated for the same reason, each with its own tests:
`deepFreeze` / `uuidShapedNotCanonical` / `ownEntry` (shared with
`packages/capital-allocator`), the whole of `src/plain-data.ts` (round 5 — the
allocator needed the same door in front of its own schemas), and
`instantMilliseconds` (from `packages/settlement`) — the WP-110 precedent.

**One Node built-in is imported, and it is audited.** `src/plain-data.ts` holds
`import { types } from "node:util";` and uses it only as `types.isProxy` (§4.5,
proposition 1). Layer 1 has no import allowlist —
`docs/contracts/dependency-direction.md` §2 states one only for layer 0, §3 F15
binds `packages/decimal`, and the §3 F14 purity rule binds `packages/domain`,
`packages/strategies/**`, `packages/ledger` and `packages/simulation`, none of
which is this package. `pnpm check:deps` passes unchanged (34 packages, 30
edges) and the import adds no workspace edge. On the substance: a type predicate
opens no connection, reads no clock, touches no filesystem and consumes no
entropy, so §9's claims below are unaffected. The line is pinned character for
character, and its permitted use restricted to `isProxy`, by
`test/unit/risk/freshness.test.ts` — which otherwise still refuses every `node:`
import in both packages.

*Strengthened 2026-09-03 (review round 6, LOW).* The "used only as
`types.isProxy`" half of that pin was LEXICAL — a regular expression over the
source — and the reviewer showed it accepted `const t = types; t.isDate`,
`const { isDate } = types` and `types["isDate"]` while rejecting only the
literal `types.isDate`. It is now AST-based: the import is resolved to its local
binding and every reference to that binding is classified by its syntactic
parent, so an alias, a destructuring, a computed access, a renamed binding and a
dynamic `import("node:…")` are each reported. The four bypasses are permanent
test cases.

## 9. Safety

- `maxRunMode` defaults to `PAPER` and nothing in this package raises it.
- Any run mode that places real orders is refused outright
  (`RISK_REAL_ORDER_SURFACE_UNSUPPORTED`), independently of the configured
  maximum, because this package cannot verify enablement or fencing.
- No credential, signer, order-placement surface, or network call exists here.
