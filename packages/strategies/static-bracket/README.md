# `@polymarket-bot/strategy-static-bracket`

The first strategy (`WP-220`; handoff §13). It exercises market-series binding,
entry triggers, maker/taker execution policy, partial fills, exit creation from
actual fill allocation, stop/timeout/close-cutoff/resolution-hold policies,
order cancel/replace, and the state machine that ties them together — with no
venue dependency of any kind.

**It is not presumed profitable** (§13.1). Nothing in this package or its tests
claims, measures, or implies an edge, and no default in it should be read as a
recommendation.

## What it is

- A `Strategy<StaticBracketParams, StaticBracketState>` implementing WP-170's
  §9.6 interface: nine synchronous callbacks, each returning exactly one
  `DecisionResult`.
- Pure: no network, database, filesystem, environment, clock or unseeded
  randomness (ADR-005 §1, §6 invariant 2). Time enters only through
  `ctx.now()`; the seeded `ctx.rng()` is available and deliberately unused.
- It emits **intents**. It never places, amends or cancels an order itself
  (§2, §7.7).
- Exact-decimal economics only, and **no division anywhere**: every economic
  value it computes is an exact addition, subtraction, multiplication or
  comparison, so no rounding policy exists inside a trading decision.

## Configuration

The wire form is handoff §13.2's, key for key. **Every field is required and
there are no defaults** — see `src/params.ts` for the rule and its three
reasons. Optional *behaviour* is an explicit switch inside an always-present
object (`exit.stop.enabled`), never an absent key.

Fields beyond §13.2 exist because four §13.4 acceptance scenarios need
information §13.2 does not carry (feature keys, a fee estimate, a
submission-silence bound, an order validity horizon, a staleness bound and its
policy). Each is listed with its basis in the `src/params.ts` header.

Two §13.2 fields have a wider role than their names suggest, and it is stated
rather than implied: `exit.stop.minimum_sell_price` and `exit.stop.urgency` are
the price floor and the urgency of **every** protected reduction this strategy
emits — the stop trigger, the holding timeout, and the end-of-market policy —
while `exit.stop.enabled` switches only the price *trigger*. That is why both
remain required when the stop trigger is off: a reduction without a stated floor
would be a blind market sale.

### Configured prices are denominated in `market_selector.direction`

`entry.trigger_price_lte`, `exit.take_profit.price`,
`exit.stop.trigger_price_lte` and `exit.stop.minimum_sell_price` are all written
in the **configured direction's** terms. That matters as soon as
`entry.economic_leg_policy` is `PREFER_CHEAPEST_WITH_INVENTORY`, because the
cheaper route to the same exposure may be to **sell the complement token** the
instance already owns rather than buy the configured one.

When that route is taken the bracket is *short* the complement token, so:

- the **entry** carries `minimumSellPrice = 1 − maximum_buy_price`;
- the **take-profit** is a **BUY-BACK** of the same token, carrying
  `maximumBuyPrice = 1 − take_profit.price`;
- every **protected reduction** is likewise a **BUY-BACK**, carrying
  `maximumBuyPrice = 1 − stop.minimum_sell_price`;
- the **stop trigger** is *not* re-expressed — it is compared in the configured
  direction's terms on both legs, exactly as the entry trigger already is.
  This is an INTERPRETATION and is recorded as one in `src/decide.ts`.

An exit therefore always trades the opposite way to its entry, on the leg the
entry established, and never names more than the confirmed open allocation —
on either leg, and on every exit path. `test/unit/strategies/static-bracket/`
holds that claim to what the **merged execution planner** actually plans, not
just to the shape of the intent: `planner-shapes.test.ts` runs each emitted exit
through the real `buildExecutionPlan` and asserts the side, the share count and
the limit price of every resulting leg.

### Every exit is a `POSITION` delta; none is a `REDUCE_POSITION`

§7.7 offers `ReducePositionIntent`, and this strategy deliberately does not use
it. Its `targetShares` is a **per-side sell-down level for the whole market** —
`packages/execution-planner`'s `buildReductionPlan` loops both sides, sells the
excess over that level on each, and reads only `minimumSellPrice`. Two things
follow, and both were reproduced end to end through the merged planner:

- **it cannot express a complement-leg exit at all.** A reduction can only
  sell; a complement bracket must buy its token back. The planner turned such an
  intent into `SELL 50 NO @ 0.08` — a *second entry* at double the size, priced
  well through the `maximumBuyPrice` the intent carried, because the reduce path
  never reads that field;
- **it cannot name one bracket's allocation.** A direct bracket holding prior
  inventory had the inventory sold too (`SELL 60` + `SELL 30` for a 50-share
  allocation), and a direct bracket holding the *other* side had that side
  dumped as well (`SELL 50 YES` + `SELL 60 NO` + `SELL 40 NO`).

§6 invariant 7 separates actual account state from virtual strategy attribution
and §13.3 rule 1 sizes an exit from the confirmed allocation: an instance that
owns a slice of a market may not act on the whole of it. A `POSITION` DELTA says
exactly that — this leg, this many shares, this side, this bound — so both exits
are built the same way. `src/decide.ts`'s `planProtectedReduce` records the four
fields a `PositionIntent` requires that a reduction does not have (`urgency`
carried verbatim, `liquidityPreference: TAKER_OK` chosen so §9.10's derived
posture is unchanged, `partialFillPolicy: ACCEPT_ANY`, `validUntil`) as a marked
INTERPRETATION, and states what is lost: the reduction's free-text `reason`,
which survives as reason codes and `modelOutputs.reduceCause`.

### What that cost at the risk seam — **RESOLVED 2026-09-15 by `RISK-2`**

> **This section is kept, unedited below the line, as the record of a residual
> that has been closed.** It described the disclosed price of the decision above:
> every exit this strategy emits arrived at `packages/risk` as an `ENTRY`, so
> §9.8 check 12 demanded an `expectedNetEdge` no exit carries and **every
> protective exit was refused** `RISK_EDGE_INPUTS_MISSING`. GOV-2B raised that as
> blocker **B2** — "no realized round trip is reachable in the merged paper
> core" — and `RISK-2` fixed it.
>
> **How, and what it settles.** The last bullet below asked "whether the risk
> engine may read intent TAGS is a contract question for that round". The answer
> is **no, and it does not need to.** `packages/risk` now derives the disposition
> of a `POSITION` from its EFFECT ON THE SUPPLIED PORTFOLIO: an intent that
> resolves to a SELL fully covered by the confirmed holding of the same
> `(marketId, side)` is an `EXIT`; anything with a BUY leg, an over-held sell, and
> every `QUOTE` and `BASKET` stays an `ENTRY`. No tag is read, so
> `apps/trader/src/pipeline.ts`'s rule that a composition root may never
> re-derive disposition from tags is untouched. The reasoning is in
> `packages/risk/src/intent-view.ts`'s header and `packages/risk/README.md` §4.
>
> **What did NOT change.** This strategy still emits every exit as a `POSITION`
> delta — the alternative in the other bullet (`buildReductionPlan` honouring
> `maximumBuyPrice` and not acting on unnamed sides, or a domain ADR adding a
> `direction` to §7.7's `ReducePositionIntent`) was **rejected**, for exactly the
> reasons this file already reproduced end to end. The four-row table below is
> therefore obsolete as a description of current behaviour: a covered protective
> reduction now gets reduction treatment in all four situations, including
> `RISK_BOOK_STALE_NO_BLIND_REDUCTION` and the `POSITION_STATE_UNKNOWN`
> recommendation.
>
> **What `RISK-2` had to fix here to make it reachable.** Two further defects in
> this package, both masked by B2 because nothing downstream of the risk engine
> had ever executed an exit: the exits named no venue order type (so a `REST`-
> planned take-profit inherited the entry's `FAK` and the venue refused it), and
> `legBaselineShares` was derived at the first fill from a position view that
> `WP-220` obligation 3 allows to LEAD the fill stream. Both are recorded at
> their sites in `decide.ts` and pinned by
> `test/unit/strategies/static-bracket/risk-2-exit-reachability.test.ts`.

---

This is the disclosed price of the decision above, and it is stated here rather
than left for someone to discover in an incident.

`packages/risk`'s `intent-view.ts` derives the risk DISPOSITION from the intent
**type alone**: `CANCEL → CANCEL`, `REDUCE_POSITION → EXIT`, and
`POSITION | QUOTE | BASKET → ENTRY`. Because this strategy emits every exit as a
`POSITION` delta, **its protective reductions are classified `ENTRY` by the
merged risk engine** — verified through the real `buildIntentView`, which
answers `disposition: ENTRY` for both the `sb.take-profit` and the
`sb.protected-reduce` intent. The classification is deliberately fail-closed on
the risk side (entry treatment can only refuse more), so the consequence is
never a wrong order; it is a **refused protective exit**, and these are the four
places it bites (reproduced end to end through the merged `evaluateIntent` by
review round 3, and readable in `engine.ts`'s `isEntry` branches):

| Situation | What happens to a protective reduction from this strategy |
|---|---|
| Inside the configured entry cutoff before close | `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED` — the §9.8 check-20 time-to-close gate applies its *entry* half |
| Market is `CLOSE_ONLY` | `RISK_MARKET_CLOSE_ONLY` — blocked, though a reduction is exactly what a close-only market still permits |
| Venue book stale | refused with the entry-shaped staleness code (`RISK_BOOK_STALE`; `RISK_FRESHNESS_UNKNOWN` for an unmeasured book) instead of `RISK_BOOK_STALE_NO_BLIND_REDUCTION`, and the `POSITION_STATE_UNKNOWN` incident recommendation the reduction path adds is **not** raised |
| Default policy `economics.requirePositiveNetEdgeForEntries: true` | §9.8 check 12 demands `expectedNetEdge`, which no exit of this strategy carries, so **every exit is refused** (`RISK_EDGE_INPUTS_MISSING`) |

The last row is **half pre-existing**: the take-profit was already a `POSITION`
without an `expectedNetEdge` at `b17d461`, so that refusal predates the
round-2 change; what round 2 added is the *protected reduction* to the same
treatment.

§9.8 check 20 ("time-to-close policy permits **entry or reduction**") and §9.9's
ladder — `HALT_NEW_ENTRIES` above `PROTECTED_REDUCE` — both depend on telling an
entry from a reduction, and a strategy whose exits are indistinguishable from
entries erases that distinction for its own intents.

**The deviation stands anyway**, and the reason is the whole of it: the
alternatives put *wrong orders on the wire* (a `REDUCE_POSITION` becomes a
second entry on the complement leg, and sells inventory this bracket never
opened on either leg — both reproduced through the merged planner, above). A
refusal is strictly better than a wrong order. Closing it properly is a
**cross-package** change and is carried as follow-up:

- `packages/execution-planner`'s `buildReductionPlan` must honour
  `maximumBuyPrice` and must not act on sides the intent did not name; and/or a
  domain ADR adding a `direction` to §7.7's `ReducePositionIntent`;
- `packages/risk`'s intent-view mapping needs a way to recognise a **protective
  reduction**. The `sb.protected-reduce` tag already exists on the intent;
  whether the risk engine may read intent TAGS is a contract question for that
  round, not a decision this package may take.

### Re-emitting an exit **compounds**: it is a delta, not a level

At `b17d461` an exit was a `REDUCE_POSITION`, whose `targetShares` is a LEVEL:
re-emitting "sell down to 0" five times collapsed to one action, so a strategy
that re-planned its exit on five consecutive evaluations was idempotent by
construction.

**That is no longer true.** Every exit is now a signed `POSITION` **DELTA**, and
five evaluations that each plan a reduction plan `5 × 50 = 250` shares against a
50-share allocation. Nothing inside this package prevents that: the strategy
does not track intents in flight across evaluations, and a protected reduction
deliberately does not create an order track (there is no venue order id to track
until the OMS answers).

What contains it today is the **execution planner**, and only the planner:
§9.10's own responsibility — "reserve collateral/inventory before submission",
which `packages/execution-planner` carries on every plan as
`reservationRule: "RESERVE_BEFORE_SUBMISSION"` — makes each accepted plan
reserve the inventory it will spend, and the second and later reductions are
then refused with `PLAN_INVENTORY_INSUFFICIENT` (reviewer-verified through the
merged planner).
That is a real mechanism, not an accident — but it is *someone else's*
mechanism, so it is written down here as an obligation on the wiring rather than
assumed:

> **A reservation taken by an accepted plan must be honoured before the next
> evaluation's reduction is planned.** A composition root that plans from stale
> inventory — or that drops reservations between evaluations — turns a repeated
> protective exit into a multiple of the position.

No code changed for this in review round 3: the containment is the planner's
stated responsibility, and duplicating it inside the strategy would put two
authorities on the same rule.

## The `btc-15m-updown` caveat (carried from `WP-110`)

§13.2's example binds `market_selector.series_id: btc-15m-updown`. **That series
has no human-reviewed settlement specification in this repository.** This
package therefore:

- binds the series **by configured id only**, and validates nothing about it
  beyond the identifier's shape;
- **asserts no settlement fact** — no reference price source, no resolution
  time, no rounding or tie rule, no payout model. `onMarketResolved` records
  that the market resolved and does not interpret the outcome;
- treats the worst case of a long outcome-token position as **bounded by what
  was paid for it**, on the sole ground that a payout is never negative. That is
  a bound, not a payoff model; §9.3 and `packages/settlement` own payoff models.

A configuration naming any series is accepted on the same terms. Verifying that
a series is fit to trade is the universe/settlement path's job (§9.2, §9.3), not
this package's.

## Obligations on the composition root (`WP-230`)

These are real conditions this strategy's correctness rests on. Each is stated
here because a wiring that breaks one produces a *quiet* misbehaviour.

1. **Timestamps are strict UTC.** `ctx.now()`, `market.openTime`,
   `market.closeTime` and `book.asOf` must be `YYYY-MM-DDTHH:MM:SS(.mmm)Z`. An
   offset form is refused, never converted (`src/time.ts`, mirroring
   `docs/contracts/features-v1.md` §6). The domain's `IsoTimestampSchema`
   permits offsets, so normalising them upstream is the root's job.
2. **The feature snapshot must carry the configured keys.**
   `entry.trigger_feature_key`, `exit.stop.trigger_feature_key` and
   `data_quality.incident_feature_key` name entries of
   `FeatureSnapshot.values`. Each key must begin with a **real feature-set-v1
   id** (the strategy refuses any other at configuration validation) and may
   carry a projection selector after `@`. The engine's executable-price features
   are structured and the SDK's view is flat, so **projecting them onto scalar
   keys is the root's job**; this package refuses to guess the projection.
   - `executable_ask` binds to `polymarket.executable_buy_price`;
   - `executable_bid` binds to `polymarket.executable_sell_price`;
   - the incident flag must be a **boolean** at its key. An absent or
     wrong-typed flag counts as an incident, never as an all-clear.
3. **The position view must already include the fill an `onFill` evaluation is
   about.** §8.1 orders the loop "update local market/account state → update
   feature snapshots → invoke subscribed strategies". The instance records the
   leg's holding at its **first** entry fill as the baseline its own exposure is
   measured against, so a lagging view moves both position gates. Stated in both
   directions, because only one of the two is fail-closed everywhere:
   - a view that lags the **first** fill records a **low** baseline, which makes
     every later exposure reading **high** by the lag. `positionAgrees`, which
     gates the protected reduction and wants equality, then refuses and
     reconciles — fail-closed. `positionCovers`, which gates the take-profit and
     wants "at least", is *satisfied* by the inflated reading — the
     **over-permissive** direction, and the reason that gate also requires the
     **raw** holding of the traded leg to cover a SELL-side exit. (A BUY-side
     complement exit spends collateral rather than shares and has no such
     requirement.) No exposure-*increasing* intent is reachable either way: an
     exit's side and size come from the state document, never from the view;
   - a view that lags a **later** fill reads the exposure **low**, and both gates
     refuse — fail-closed, at the cost of a delayed exit.
4. **The ladder reads the order views it was handed, once, at adoption.** An
   order the instance has already adopted (it holds the venue's `orderId`) is
   not re-matched against `ctx.orders()` on later evaluations; its state moves
   only through `onOrderUpdate` and `onFill`. A root that stops delivering
   `onOrderUpdate` for an adopted order, or that delivers views only through
   `ctx.orders()`, leaves that order's tracked state frozen. The effect is
   fail-safe — a frozen live order blocks new entries (see the in-flight guard
   in `planEntry`) rather than causing one — but it is a real obligation on the
   wiring, and it is listed here rather than left implicit.
5. **A repeated order VIEW is ordinary traffic; a repeated FILL is not.** The
   two halves of this obligation point in opposite directions and are stated
   separately because one paragraph covering both would be read as covering
   both.
   - **Order views are idempotent and repeat-safe.** Nothing in §8.1 or §9.6
     promises at-most-once delivery, so a second `FILLED`/`CANCELED` view for an
     order the instance already tracks as terminal is *absorbed* (the evidence
     is folded, the sub-machine is not consulted, the instance does not halt),
     and a view that says an order is still `OPEN` while its cancel is in flight
     is absorbed by the sub-machine's own cancel-race self-edge. **Roots may
     redeliver views freely.**
   - **Fills must be delivered AT MOST ONCE.** A `StrategyFill` is settlement
     evidence, and the fold that consumes it ADDS: redelivering one fill of 50
     shares makes the instance believe it holds 100, which then sizes its exit
     at 100 (§13.3 rule 1 is computed from the fold, and the fold is the only
     writer). This package cannot tell a redelivered fill from a second real
     one — §7.7 gives a fill no identity the strategy could deduplicate on
     beyond its order id, and one order legitimately fills many times — so
     **de-duplicating the fill stream is the composition root's obligation**
     (`WP-230`). It is not new to the delta-shaped exits: the ordinary entry
     path has always double-counted a redelivered fill. Whether the runtime seam
     should carry a fill identity at all is recorded as follow-up rather than
     guessed at here.
6. **Views must be fresh or copied per evaluation** (WP-170 `follow_up` 2), and
   `StrategyContextRevokedError` must not be swallowed.
7. **`StrategyOrderView.filledShares` is read as EVIDENCE, never as
   allocation.** §8.1 guarantees no ordering between a view and the fill it
   describes, so a view reporting a filled size before its fill arrives puts the
   instance into an *awaiting-the-fill* posture (`SB.AWAITING_FILL_ALLOCATION`)
   rather than back into `ARMED`. The exit is still sized only from the confirmed
   fill fold (§13.3 rule 1). A root that reports filled sizes on views it never
   backs with a fill will leave an instance waiting; a root that never reports
   them simply loses the evidence and behaves as before.
8. **A confirmed fill is delivered even while the instance is PAUSED**, and is
   folded into the allocation there (`SB.FILL_FOLDED_WHILE_PAUSED`). The fold is
   settlement accounting, not a transition: the instance stays PAUSED, emits
   nothing, and sizes its exit from the folded allocation when it resumes. A
   root that withholds fills from a paused instance leaves it believing it holds
   less than it does — the one direction this package cannot defend against,
   because it never sees the event.
9. **A reservation an accepted plan took must be honoured before the next
   evaluation's reduction is planned.** Every exit is a signed DELTA, so
   re-planning a protective exit on consecutive evaluations names the allocation
   again each time; §9.10's `RESERVE_BEFORE_SUBMISSION` rule is what turns the
   second and later ones into `PLAN_INVENTORY_INSUFFICIENT` refusals. See
   "Re-emitting an exit **compounds**" above for the whole of it.
10. **Cancel reconciliation is the OMS/composition root's job.** An unconfirmed
    cancel has no in-package timeout: if the venue acknowledges but never
    confirms, the instance waits in `SB.AWAITING_CANCEL_CONFIRMATION` with the
    stop, holding timeout and close cutoff deferred (the review-round-3
    self-edge made this a quiet wait where it was previously a loud halt that
    abandoned the position with the same protections dead). The root must
    resolve every cancel to a terminal fact — confirmed, rejected, or
    `SILENCE_EXCEEDED` via `submission_unknown_after_ms` — the §6 invariant 6
    family, same as the awaiting-fill posture.

## Closed in review round 3: the cancel race no longer halts

Round 2 recorded a known exposure here: a view with `status: "OPEN"` — or any
status this package does not recognise, which is read as `OBSERVED_WORKING` per
§6 invariant 6 — arriving for an order whose cancel had been requested but not
yet confirmed HALTED the instance, because
`CANCEL_PENDING --OBSERVED_WORKING-->` was not an edge of the §13.3
working-order sub-machine and `planOrderUpdate` halts on an illegal move. Two of
the 28 `(non-terminal track state × view status)` shapes.

Review round 3 reproduced it through the **real WP-170 runtime** — stop →
`SB.SAFETY_CANCEL` → one ordinary `OPEN` view → `SB.HALTED` holding 50 shares,
with the stop, the holding timeout and the close cutoff all dead — and
sanctioned **one** machine row for it:

```
CANCEL_PENDING --OBSERVED_WORKING--> CANCEL_PENDING
  "a still-working view during the cancel race does not resolve the cancel"
```

It is a SELF-edge, deliberately: a working view is not a cancel confirmation, so
the cancel stays unresolved and §6 invariant 13 keeps holding — no replacement,
no second cancel, no reduction until the venue confirms the withdrawal
(`SB.AWAITING_CANCEL_CONFIRMATION`). It is also the row the sub-machine was
already inconsistent for want of: `SUBMISSION_UNKNOWN --OBSERVED_WORKING-->
WORKING` has always existed. `OPEN` is the ONLY status a root can report for an
order whose cancel is in flight — `strategy-sdk`'s `StrategyOrderStatus` has no
CANCEL_PENDING member — so this is ordinary traffic, not an anomaly.

The pinned order-machine counts move with it, and nothing else does: **8 order
states, 9 order triggers, 28 order edges** (27 before), instance table unchanged
at 11 states / 21 triggers / 63 edges. `machine-closure.test.ts` sweeps the 28
non-terminal shapes (zero halts, from two) beside the 1,008 terminal ones, and
`runtime-integration.test.ts` drives the exact route: not halted, still
`CANCEL_PENDING`, and the stop fires the moment the cancel confirms.

## Known exposure: numeric-index prototype pollution

Under `Object.prototype["0"]`, `subDecimal` throws whenever its exact result is
zero, which the order-book walk hits on its ordinary path. This package's guards
contain the throw, so the observed effect is **fail-closed**: an entry becomes a
recorded refusal (`SB.REFUSED_BOOK_PARTICIPATION`) and no exit, cancel or
reduction is affected. The root cause is in `packages/decimal` and is tracked
there; reaching it requires an already-compromised process. `src/plain.ts` states
both halves of the claim per ADR-020 §4, and
`test/unit/strategies/static-bracket/hostile-config.test.ts` carries the probe as
a documented expectation.

## Safety

`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false` and both live-micro caps at `0`
are untouched by this package, which holds no credential and can hold none: it
has no I/O surface at all. No venue call, no signer, no real order, and no
performance claim.
