# `@polymarket-bot/execution-planner` — WP-190

Converts approved intents into **immutable execution plans** (handoff §9.10).
Pure layer-1 logic: no I/O, no clock, no network, no credential surface, and
**no order placement** — the planner produces plan *data*; submission belongs
to `packages/oms`. Exact decimal strings for every economic field (§7.3); the
planning instant, book, versioned trading parameters, fee rates, collateral
and inventory all arrive as caller data and cross a materialize-first
boundary before anything reads them.

## 1. Entry point

```ts
buildExecutionPlan(record, inputs): PlannerResult<ExecutionPlan>
```

- `record` — an `ApprovedIntentRecord` exactly as `packages/risk` emits it
  (consumed **structurally**, by shape: this package imports no risk *type* and
  no risk *logic*. The §2.1 **S4** edge added 2026-09-04 carries the parse door
  and nothing else — see §5).
- `inputs` — this package's `PlanningInputs` document (see `src/inputs.ts`).

Both are `unknown` at runtime. The answer is always a typed result; an
exception is never one of this package's answers.

| Intent type | Outcome |
| --- | --- |
| `POSITION` | placement plan; economic-leg selection (§3) |
| `REDUCE_POSITION` | sell-down placement plan out of actual holdings |
| `BASKET` | coordinated basket plan — **never labeled atomic** |
| `CANCEL` | safety-cancel plan (§4) |
| `QUOTE` | `PLAN_QUOTE_UNSUPPORTED` — §7.7's `QuoteLevel` names no outcome token (recorded domain gap, WP-180 `follow_up` 1); refusing beats inventing venue behaviour |

## 2. What every plan structurally guarantees

- a **deadline** strictly after `plannedAt` (placements:
  `min(validUntil, plannedAt + maxPlanLifetimeMs)`; cancels:
  `plannedAt + cancelDeadlineMs`), and an escalation policy
  (`CANCEL_REMAINING` / `ESCALATE_TO_RECONCILIATION`);
- **price protection**: every planned order carries a required,
  tick-conforming (§7.3 exact modulo, BigInt-scaled) limit price strictly
  inside (0, 1); rounding always tightens (BUY caps floor, SELL floors
  ceiling); a leg with no derivable bound refuses;
- **reservation before submission** (§9.10): a 1:1 order↔reservation
  bijection with byte-identical economics, in the capital-allocator's own
  request shape, plus the literal `reservationRule:
  "RESERVE_BEFORE_SUBMISSION"`;
- **labeled estimates**: fees/slippage/proceeds/worst-cost only ever appear
  under `basis: "ESTIMATE"`;
- **priority** (§6 invariant 13): cancels are `SAFETY_CANCEL`, placements
  `PLACEMENT`, coupled in both directions at the seal;
- **immutability**: the sealed value is a deeply frozen materialized tree
  sharing no object with the draft.

All of this is enforced by `sealExecutionPlan` — the single emission
boundary — so a violating draft is *unconstructible*, not flagged.

## 3. Economic-leg selection (workplan acceptance 1)

Increasing exposure to outcome D prices BOTH venue expressions — BUY D
(cost/share = limit) and SELL the opposite token O (cost/share = 1 − limit) —
and takes the cheaper, **but a sell leg is feasible only up to
`held − reserved`**, the instance's actual unreserved holdings (§6
invariant 10). When inventory forces the fallback the plan records
`reason: "INVENTORY_FALLBACK"`. Decreasing exposure sells the direction
token only (a hedge is a strategy decision, not a planning substitution) and
**refuses rather than silently downsizing** — §7.7's resize
(`resizeApprovedIntent`) is the sanctioned smaller-exit mechanism, and
shares trapped under open orders are freed by cancelling first.

Posture table (`liquidityPreference` is a constraint, `urgency` advice
within it): `MAKER_ONLY` → REST always; `TAKER_ONLY` → MARKETABLE always;
`MAKER_PREFERRED`/`TAKER_OK` → REST unless AGGRESSIVE/IMMEDIATE. Reductions:
NORMAL → REST, otherwise MARKETABLE.

Slicing: at most `maxSliceShares` per order, at most 100 orders per leg; a
sub-minimum remainder folds into the final slice so the total is conserved
exactly.

## 4. The cancel path (§6 invariant 13)

A malformed-input refusal must never be converted into, or block, a valid
CANCEL. The cancel path therefore **plucks only the fields a cancel plan
carries** (trap-free descriptor reads; `src/pluck.ts`): hostile or malformed
values in `worstCase`, `reasons`, `recommendations`, the book, the
inventory, the fee schedule or the collateral can neither throw nor refuse a
cancel — while the same values *do* refuse a placement. Venue order ids ride
verbatim (never UUID-checked, ADR-016 §2 exclusion `orderIds`/`reason`). A
genuinely malformed cancel still refuses: nothing becomes a cancel by
accident.

## 5. Boundaries and the shared parse door

Every value this package did not construct is read into a prototype-free
materialized tree first (`@polymarket-bot/risk/plain-data`), and every
domain-schema parse goes through a warmed, prototype-free arena copy
(`@polymarket-bot/risk/schema-arena`, wrapping `packages/domain`'s frozen
`IntentSchema` / `IsoTimestampSchema` / `InternalMarketIdSchema`) — the measured
cross-package `zod` classes (IMPLEMENTATION_STATUS.md, Open blockers: adoption,
loss, defeated defaults, `skipChecks`, inherited `when`, cold-lazy poisoning,
descriptor literals) are probed directly in
`test/unit/execution-planner/hostile-inputs.test.ts`.

**The parse door is imported, not copied** *(changed 2026-09-04 by
`WP-180-FU2`; this section previously read "Mirrored modules" and described a
third byte-identical duplication)*. `plain-data.ts` and `schema-arena.ts` used
to be duplicated here from `packages/risk`, because a shared module needed a
`docs/contracts/dependency-direction.md` §2.1 same-layer edge that did not
exist. `GOV-2A` ruled the duplication out and wrote the edge: this package
declares `@polymarket-bot/risk` and consumes the two modules across §2.1
**S4**, through `packages/risk`'s `exports` map (F16). The ruling's constraint
travels with the edge — **no rule, policy, or evaluation logic may cross it**;
this package's leg selection, tick conformance, slicing, hysteresis and
escalation policy are its own. `test/unit/execution-planner/mirrors.test.ts` is
now the DELETION guard: it fails if either module's body reappears under the
`src` tree of any workspace member outside `packages/risk` — every `apps/*` as
well as every `packages/*` *(the `apps/*` half was added 2026-09-04 in
`WP-180-FU2` remediation round 2, review finding LOW-B, which measured a
verbatim paste into `apps/trader/src/` passing the guard)*.

**The S4 edge brings no `zod` with it — measured, not assumed.** This package
declares no `zod` dependency, and it acquires none transitively: neither door
module imports the library (`schema-arena.ts` describes its node shapes
*structurally*, so that it imports nothing), and pnpm's strict layout links no
`zod` under this package, so `import { z } from "zod"` in `src/` fails to
resolve — `TS2307`, probed with the S4 edge declared. `.safeParse` is called
only on schema objects `packages/domain` exports, through the arena
`packages/risk` owns. *(Recorded 2026-09-04 in `WP-180-FU2` remediation round 1:
the collapse candidate's handoff had listed transitive `zod` reachability as an
open risk, and the review measured it away.)*

**Structural ports.** `ApprovedIntentRecord` (in) and the allocator's
`ReservationRequest` (out) are consumed/emitted by shape;
`test/unit/execution-planner/ports.test.ts` pins both against the real
packages at compile time and runtime. *(Corrected 2026-09-04: that sentence used
to end "and asserts no workspace edge exists", which `GOV-2A`'s S3/S4 ruling
overturned in this same collapse — the suite now asserts that the door edge
EXISTS, runs only into `packages/risk`, and carries only the two door subpaths
at any depth of `src`.)*

**Consuming a plan**: like risk's emitted records (see
`packages/risk/README.md` §6.1), a sealed plan is a deeply frozen tree with
a **`null` prototype** — `Object.hasOwn`, `Object.keys`, `in`, dotted
reads, destructuring, `JSON.stringify` and `toEqual` all work;
`plan.hasOwnProperty` / `toString` are `undefined`, and a spread,
`structuredClone` or JSON round trip restores `Object.prototype`, so a copy
must be re-validated before optional fields are read off it.

## 6. Refusal vocabulary (20 codes)

`PLAN_INPUT_INVALID`, `PLAN_RECORD_INVALID`, `PLAN_UUID_NOT_CANONICAL`,
`PLAN_MARKET_INPUT_MISSING`, `PLAN_BOOK_INVALID`, `PLAN_INTENT_EXPIRED`,
`PLAN_QUOTE_UNSUPPORTED`, `PLAN_NOTHING_TO_EXECUTE`,
`PLAN_PRICE_PROTECTION_UNAVAILABLE`, `PLAN_PRICE_OUT_OF_RANGE`,
`PLAN_INVENTORY_INSUFFICIENT`, `PLAN_COLLATERAL_INSUFFICIENT`,
`PLAN_EXCEEDS_MAXIMUM_TOTAL_COST`, `PLAN_BELOW_MINIMUM_ORDER_SIZE`,
`PLAN_SLICING_INCOHERENT`, `PLAN_BASKET_LEG_UNBOUNDED`,
`PLAN_BASKET_LEG_RISK_EXCEEDED`, `PLAN_BASKET_COMBINED_COST_EXCEEDED`,
`PLAN_ATOMIC_LABEL_FORBIDDEN`, `PLAN_SEAL_INVALID`.

Each refusal carries bounded human text and own-data evidence
(`plannerRefusal` copies details descriptor-wise and counts what it cannot
copy). The vocabulary is package-owned; adding a code is additive.

## 7. Safety

`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
`LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` are
untouched: this package has no submission surface, no signer, no
credentials, and carries `runMode` verbatim for the upstream gates (risk
§9.8 check 2; the allocator's fenced zero live-micro caps) — it neither
grants nor widens anything.
