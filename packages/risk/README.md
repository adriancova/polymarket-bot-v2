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
| `record.*` on `resizeApprovedIntent` | **yes** | the argument is typed, not parsed; everything it carries is inherited into the new record — see §4.3 |
| any `marketId` **arriving as engine input** | n/a | `InternalMarketId` is lowercase-canonical UUIDv7 in the frozen schema, so a re-cased one is already `RISK_INPUT_INVALID` |
| `intent.orderIds[]`, `portfolio.openOrders[].orderId` | **no** | §7.2 `VenueOrderId` — venue-supplied and opaque. ADR-016 §2 "does not touch any venue wire format", and its premise (every UUID here is generated in-process) is false for them: a venue string must round-trip exactly as the venue spelled it, and refusing one on a `CANCEL` could trap a position for a rule the ADR does not impose |

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
- **the exceptions are the closed set**, `NON_IDENTITY_KEYS`: `orderId` /
  `orderIds` (§7.2 `VenueOrderId`), `reason` / `resizeReason` / `rationale`
  (`DetailString` prose, "never parsed, only displayed or logged"), and `tags`
  (§7.7 free-form strategy tags). Each entry is a string the frozen contract
  types as something other than a repository identifier, and two of them ride
  the `CANCEL` path, where over-refusal would trap a position;
- **the inherited intent is parsed**, not trusted, because the resize computes
  on it (`compareDecimal`, `absDecimal`). A hand-built `targetShares` is now a
  typed `RISK_INPUT_INVALID` instead of a thrown `InvalidDecimalStringError`.

A seventh identity field is therefore validated the moment it exists, with no
edit here — and the suite notices too: `test/unit/risk/engine.test.ts`, describe
block *"the emission boundary — a record is never built from an unvalidated
identity"*, generates its cases by walking a real record, so a new field is a
new case automatically. The older block *"ADR-016 §2 — record identity is INPUT
VALIDATION, never a cancel override"* still pins the door.

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
| `RISK_UUID_NOT_CANONICAL` | A UUID-shaped **repository** identifier arrived in a non-lowercase spelling. ADR-016 §2: refuse at the input surface, never case-fold. The door's fields and the venue exclusion are in §4.2; the record-walk rule that covers every other position is §4.3. |
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
record and leaves the original untouched, including its `intent` object.
Freezing happens **inside** `sealApprovedIntentRecord` (§4.3), so "emit a
record" and "validate the record being emitted" are one act rather than two
conventions.

`resizeApprovedIntent`'s `record` argument is INPUT, not a trusted value: it is
typed but not parsed, so it is walked for ADR-016 §2 violations in full, and its
`intent` is parsed against the frozen §7.7 contract, before anything is built.

Ceilings the strategy set (`maximumTotalCost`, `maximumBuyPrice`,
`minimumSellPrice`, `validUntil`) are copied unchanged by a resize — a ceiling
stays valid under a smaller size, and scaling one would be this package
inventing a number the strategy did not supply. Re-running `evaluateIntent` on a
resized intent produces a fresh `EVALUATED` record.

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
`deepFreeze` / `uuidShapedNotCanonical` (from `packages/capital-allocator`) and
`instantMilliseconds` (from `packages/settlement`) — the WP-110 precedent.

## 9. Safety

- `maxRunMode` defaults to `PAPER` and nothing in this package raises it.
- Any run mode that places real orders is refused outright
  (`RISK_REAL_ORDER_SURFACE_UNSUPPORTED`), independently of the configured
  maximum, because this package cannot verify enablement or fencing.
- No credential, signer, order-placement surface, or network call exists here.
