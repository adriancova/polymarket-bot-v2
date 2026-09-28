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

> **This section records a residual that has been closed.** (`RISK-2` kept the
> old text unedited below a line; `BRACKET-1a` removed it — see the note after
> this quotation.) It described the disclosed price of the decision above:
> every exit this strategy emits arrived at `packages/risk` as an `ENTRY`, so
> §9.8 check 12 demanded an `expectedNetEdge` no exit carries and **every
> protective exit was refused** `RISK_EDGE_INPUTS_MISSING`. GOV-2B raised that as
> blocker **B2** — "no realized round trip is reachable in the merged paper
> core" — and `RISK-2` fixed it.
>
> **How, and what it settles.** The old record's follow-up list asked "whether
> the risk engine may read intent TAGS is a contract question for that round". The answer
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
> delta — the alternative that list also named (`buildReductionPlan` honouring
> `maximumBuyPrice` and not acting on unnamed sides, or a domain ADR adding a
> `direction` to §7.7's `ReducePositionIntent`) was **rejected**, for exactly the
> reasons this file already reproduced end to end. A covered protective
> reduction now gets reduction treatment in all four situations the old record
> tabulated — inside the entry cutoff, a `CLOSE_ONLY` market, a stale venue book
> (`RISK_BOOK_STALE_NO_BLIND_REDUCTION` and the `POSITION_STATE_UNKNOWN`
> recommendation), and the positive-net-edge gate.
>
> **What `RISK-2` had to fix here to make it reachable.** Two further defects in
> this package, both masked by B2 because nothing downstream of the risk engine
> had ever executed an exit: the exits named no venue order type (so a `REST`-
> planned take-profit inherited the entry's `FAK` and the venue refused it), and
> `legBaselineShares` was derived at the first fill from a position view that
> `WP-220` obligation 3 allows to LEAD the fill stream. Both are recorded at
> their sites in `decide.ts` and pinned by
> `test/unit/strategies/static-bracket/risk-2-exit-reachability.test.ts`.

*The pre-`RISK-2` record that used to follow here — the "type alone"
classification, its four-row table of refusals, and the follow-up list it
carried — was obsolete as a description of current behaviour from the day
`RISK-2` merged and was REMOVED by `BRACKET-1a` (`RISK2-R5`, `RISK-2` residual
item 7(i)). It is preserved verbatim in this file at `133eac1` and summarised in
`docs/handoffs/RISK-2.md`.*

### Re-emitting an exit would **compound** — and the reduction's own order track contains it

At `b17d461` an exit was a `REDUCE_POSITION`, whose `targetShares` is a LEVEL:
re-emitting "sell down to 0" five times collapsed to one action, so a strategy
that re-planned its exit on five consecutive evaluations was idempotent by
construction.

**A DELTA is not.** Every exit is a signed `POSITION` **DELTA**, and five
evaluations that each planned a reduction would plan `5 × 50 = 250` shares
against a 50-share allocation. Until `BRACKET-1a` nothing inside this package
prevented that: the protective reduction deliberately created no order track
(the reason given was that there is no venue order id to track until the OMS
answers — a reason the take-profit, tracked `PENDING` with `orderId: null` from
the start, never needed), so every ladder evaluation before the reduction filled
emitted it again, and its own fill then matched no track and PAUSED the
instance (`RISK-2` residual 5).

**What contains it now is the strategy itself.** The reduction is tracked
exactly as the take-profit is, and while it is live every evaluation holds
(`SB.EXIT_ORDER_WORKING`) — no second intent, no cancel of it. See "Protective
reduction: tracked and sticky" below for the whole policy.

**What remains of the old containment is the BACKSTOP it always was:** §9.10's
"reserve collateral/inventory before submission", which
`packages/execution-planner` carries on every plan as
`reservationRule: "RESERVE_BEFORE_SUBMISSION"`, makes each accepted plan reserve
the inventory it will spend, so a second sale of the same shares is refused with
`PLAN_INVENTORY_INSUFFICIENT` (reviewer-verified through the merged planner). It
is now reached only by the one re-plan per validity window that ruling R2
allows, and only if the retired reduction had in fact become an order the root
never listed — obligation 11 below says that cannot happen. It is someone
else's mechanism, so it stays an obligation (9) rather than an assumption.

### Protective reduction: tracked and sticky (`BRACKET-1a`; the user's rulings R2 and R3)

WP-220 requires the entry, exit, stop, timeout and close policies to be
EXPLICIT. For the protective reduction — whatever placed it: the stop, the
holding timeout, or the close cutoff's `final_policy: PROTECTED_REDUCE` — they
are:

- **It is tracked.** `planProtectedReduce` writes an EXIT order track exactly
  like the take-profit's: `PENDING`, `orderId: null`, `requestedShares` = the
  confirmed open allocation it names, `limitPrice` = the floor. Its fill folds
  through the ordinary exit edges (`EXIT_PLANNED | EXIT_WORKING
  --EXIT_FILL_COMPLETE--> CLOSED`; a partial fill `--EXIT_PARTIAL_FILL-->
  EXIT_WORKING`). No machine edge was added: 11 states, 21 triggers, 63 edges.
- **Its role is read from its minted id.** `exitRole(track)` maps the
  `sb-take-profit-` / `sb-protected-reduce-` prefix to `TAKE_PROFIT` /
  `PROTECTED_REDUCE`, and REFUSES any other prefix — the instance halts naming
  it rather than guess whether the order may be cancelled. The state document's
  shape is unchanged (`STATIC_BRACKET_STATE_SCHEMA_VERSION` 2).
- **It is STICKY (R3).** Once placed it runs to completion or to a terminal
  state. Every ladder evaluation while it is live — `PENDING`,
  `SUBMISSION_UNKNOWN`, `WORKING` (partly filled included), or a
  `CANCEL_PENDING` a safety path requested — HOLDS: no second reduction, no
  cancel of it, no take-profit beside it. A stop that clears does not withdraw
  it (take-profit maintenance holds with `SB.EXIT_ORDER_WORKING` and never
  cancels it); a later cause does not replace it; the `CANCEL_ONLY` and
  `HOLD_TO_RESOLUTION` final policies leave it working and hold it exactly as
  every other path does — `SB.EXIT_ORDER_WORKING`, and R2's silence transition
  below — rather than with their own bare hold (review round 1, BR1-M1: a
  reduction placed by the stop before the cutoff used to stay `PENDING` for
  good under those two policies). Once R2 retires such a reduction, neither
  policy places another: neither places reductions.
- **It is never re-priced, and there is NO exit escalation.** A resting
  remainder keeps its floor (`exit.stop.minimum_sell_price`) until it fills or
  ends; nothing in this package makes it more aggressive over time. (That was
  already the effect before `BRACKET-1a` — the repeated re-emissions were
  refused by the reservation — but it is now the stated policy.)
- **Only the safety paths in this package cancel it:** a data-quality incident
  (`PAUSE_AND_CANCEL`; never a blind flatten — the reduction is cancelled and
  the instance pauses), a position reconciliation (`SB.POSITION_MISMATCH` /
  `SB.NO_BLIND_FLATTEN`), and `onStop`. A fill that arrives while the instance
  is paused is folded (obligation 8), and resuming on a flat allocation closes
  the bracket — unless an entry execution the venue reported is still unfolded
  (next-but-one bullet). An end the order meets OUTSIDE this package (the
  venue, or the
  plan's own deadline under `escalation.atDeadline: CANCEL_REMAINING`) is a
  terminal state like any other: once its view arrives and its fills are
  folded (the settlement waits for them), the track is settled and the ladder
  may plan a new reduction for what is still open, at the same floor.
- **An allocation that grows under it** (a late ENTRY fill) is planned only
  after the reduction settles, still under `positionAgrees`; meanwhile the
  instance is returned to the exit states (`EXIT_TRIGGER_MET`) so the
  reduction's own fill still folds instead of being refused as an illegal
  transition. The same walk-back applies to an exit of either role that is
  terminal on the venue but still awaiting its fill (see "An exit terminal on
  the venue waits for its fill" below). If the late fill lands on STALE data,
  the instance pauses instead (`PAUSE_AND_CANCEL`) with `resumeTo` naming the
  state the fill moved it to, and the walk-back happens in the resume's own
  evaluation, before any exit fill can arrive outside `PAUSED` (review round 2,
  BR2-H1: the "awaiting its fill" hold in the ladder used to return without it,
  so the awaited sale was refused from `OPEN` and discarded).
- **A late ENTRY fill is never discarded, and the bracket is never closed over
  it** (review round 1, BR1-H1). The protective reduction is sized from the
  FOLDED allocation (§13.3 rule 1), so an entry whose view reported more than
  had been folded — e.g. `FILLED 50` with 30 delivered — is exactly the case in
  which the reduction names less than is held. The round-0 candidate cleared
  such an entry track as soon as anything was folded; the late 20 then matched
  no track, and once the reduction's own fill was attributed the bracket
  reached a false `CLOSED` holding 20. Now, while an entry's view is ahead of
  its fold: the entry track is KEPT (`SB.ENTRY_ORDER_TERMINAL`,
  `SB.AWAITING_FILL_ALLOCATION`) and the late fill folds into it BY ORDER ID;
  NO path certifies `CLOSED` — a flat fold of the folded allocation takes the
  partial-fill edge and holds `SB.AWAITING_FILL_ALLOCATION`, and neither the
  zero-open ladder branch (the paused-fold -> resume route) nor the
  market-closed shortcut closes it; and settling an exit does not move the
  bracket into `OPEN` — §13.3 folds an entry fill out of the entry states,
  `PARTIALLY_OPEN` and the exit states, but has no such edge out of `OPEN`.
  The ladder then exits what the late fill added, as an ordinary exit.
  NOT covered, and unchanged from base: a fill for an entry order that is still
  LIVE when the bracket is already `OPEN` (a withdrawn entry whose cancel loses
  the race after the take-profit's settlement moved the bracket to `OPEN`) is
  still the census's designed refusal — `SB.ILLEGAL_TRANSITION`, paused,
  fail-closed, the fill unfolded — because `OPEN --ENTRY_*-->` is not a §13.3
  edge and this round adds none. (With `convert_to_aggressive_after_ms: 0`, as
  in §13.2's example, the entry is emitted as an immediate order of the
  configured `immediate_order_type`, `FAK` there, which does not rest.)
- **Nobody answers (R2).** A reduction still `PENDING` after
  `submission_unknown_after_ms` becomes `SUBMISSION_UNKNOWN`
  (`PENDING --SILENCE_EXCEEDED-->`), reported exactly as the entry reports it —
  `modelOutputs.submissionUnknown: true`, `SB.EXIT_SUBMISSION_UNKNOWN`,
  `SB.AWAITING_RECONCILIATION` — and nothing is re-sent (§6 invariant 6). It is
  RETIRED (`SB.EXIT_INTENT_EXPIRED`, through the existing `EXIT_PLANNED
  --EXIT_ABANDONED--> OPEN` edge) only when BOTH hold: its own intent's
  `validUntil` (`placedAtMs + order_validity_ms`, as minted) is strictly in the
  past, AND no order view and no fill has EVER named it (no venue order id, no
  fill, no view-reported fill). A reduction that anything named is never
  retired by expiry. After a retirement the ladder may plan ONE reduction for
  the new validity window, gated by `positionAgrees` (strict equality) with the
  loop's reservation as the backstop — so at most one reduction per validity
  window. Retirement is safe because nothing can turn an expired intent into an
  order any more: the risk engine refuses an intent whose `validUntil` is before
  the evaluation instant (`packages/risk/src/engine.ts:238-248`,
  `RISK_INTENT_EXPIRED`) and the execution planner refuses one whose
  `validUntil` is not after the planning instant
  (`packages/execution-planner/src/build.ts:196-213`, `PLAN_INTENT_EXPIRED`);
  an order booked before then is visible (obligation 11) and is adopted before
  retirement is considered.
- **A stale view cannot hijack it.** Leg and side cannot tell it from the
  take-profit it replaced, so an id-less reduction is named only by a view that
  shows the order alive (`OPEN` / `PARTIALLY_FILLED`) or by its first fill;
  from then on exact-id matching settles its terminal views. A redelivered
  terminal view of the old take-profit is `SB.IDLE` to it. The take-profit's
  own adoption is unchanged.
- **An exit terminal on the venue waits for its fill.** If an exit order's view
  reports more executed than the fill stream has delivered, the track is kept
  and the instance holds with `SB.AWAITING_FILL_ALLOCATION` until the fill
  folds by its order id — the exit twin of the entry's posture (obligation 7).
  No exit is sized from the view. It waits IN THE EXIT STATES: the evaluation
  that holds for it — the ladder's own hold, and take-profit maintenance's
  after a late entry fill — first walks the bracket back into them if a late
  entry fill moved it out, so the fill it waits for can fold. NOT covered, and
  pre-existing at base: a TAKE-PROFIT that was still LIVE when a late entry
  fill moved the bracket to `PARTIALLY_OPEN`/`OPEN` (the resize's
  cancel-then-replace, whose cancel loses the race). Its fill is then refused
  from that state, `SB.ILLEGAL_TRANSITION` and paused, fail-closed, with the
  fill unfolded. That happens whether the fill arrives first or after a terminal
  view (at base the second order said `SB.UNATTRIBUTED_FILL` instead; it paused
  the same way). No edge was added for it.
- **Reason codes.** A stop or holding-timeout reduction reports
  `SB.PROTECTED_REDUCE`; the close-cutoff reduction keeps
  `SB.FINAL_PROTECTED_REDUCE`.

The take-profit keeps its maintenance policy, with one correction: it is
compared with the open allocation by what it still has to sell
(`requestedShares − filledShares`), so its own partial fill no longer triggers a
cancel-and-replace.

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
   wiring, and it is listed here rather than left implicit. (A frozen protective
   reduction is held the same way: it blocks a second reduction rather than
   causing one, and it is never retired by expiry once a view or a fill has
   named it.) An id-less protective reduction is adopted only from a LIVE view
   (`OPEN` / `PARTIALLY_FILLED`); a take-profit and an entry keep the adoption
   described here.
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
   rather than back into `ARMED`. For the ENTRY this holds whenever the view is
   AHEAD of the fold, whether or not part of the entry was already folded
   (`BRACKET-1a` review round 1, BR1-H1 — it used to hold only when nothing
   was), and while it holds the bracket is never certified `CLOSED`. Since
   `BRACKET-1a` the same holds for an EXIT order the venue reports terminal:
   while its view reports more executed than has been folded, the track is
   kept, no exit is sized, and the late fill folds by its order id. The exit is
   still sized only from the confirmed fill fold (§13.3 rule 1). A root that
   reports filled sizes on views it never backs with a fill will leave an
   instance waiting — since review round 1 that includes an instance that has
   exited everything it folded, which waits in its exit state instead of
   closing; a root that never reports them simply loses the evidence and
   behaves as before.
8. **A confirmed fill is delivered even while the instance is PAUSED**, and is
   folded into the allocation there (`SB.FILL_FOLDED_WHILE_PAUSED`). The fold is
   settlement accounting, not a transition: the instance stays PAUSED, emits
   nothing, and sizes its exit from the folded allocation when it resumes. A
   root that withholds fills from a paused instance leaves it believing it holds
   less than it does — the one direction this package cannot defend against,
   because it never sees the event.
9. **A reservation an accepted plan took must be honoured before the next
   evaluation's reduction is planned.** Every exit is a signed DELTA. Since
   `BRACKET-1a` the strategy no longer re-plans a protective exit on consecutive
   evaluations — its own order track holds while the reduction is live — so
   this is the BACKSTOP, not the containment: it matters for the one re-plan per
   validity window ruling R2 allows after an unanswered reduction is retired,
   where §9.10's `RESERVE_BEFORE_SUBMISSION` rule would turn a second sale of the
   same inventory into a `PLAN_INVENTORY_INSUFFICIENT` refusal if the retired
   intent had in fact become an order. See "Re-emitting an exit would
   **compound**" above.
10. **Cancel reconciliation is the OMS/composition root's job.** An unconfirmed
    cancel has no in-package timeout: if the venue acknowledges but never
    confirms, the instance waits in `SB.AWAITING_CANCEL_CONFIRMATION` with the
    stop, holding timeout and close cutoff deferred (the review-round-3
    self-edge made this a quiet wait where it was previously a loud halt that
    abandoned the position with the same protections dead). The root must
    resolve every cancel to a terminal fact — confirmed, rejected, or
    `SILENCE_EXCEEDED` via `submission_unknown_after_ms` — the §6 invariant 6
    family, same as the awaiting-fill posture.
11. **A booked order must appear in `ctx.orders()` before its intent's
    `validUntil` passes** (`BRACKET-1a`, ruling R2). A protective reduction that
    no view and no fill has ever named is RETIRED once its own intent's
    `validUntil` is in the past, and the ladder may then plan one replacement.
    That is safe only because an order that WAS booked is seen first: a live one
    is adopted (from a live view) before retirement is considered, and a
    terminal one either executed — its fill names the track — or is dead. The
    risk engine and the execution planner both refuse an expired intent
    (`packages/risk/src/engine.ts:238-248`,
    `packages/execution-planner/src/build.ts:196-213`), so nothing can become an
    order after `validUntil`. `apps/trader`'s loop meets this synchronously: it
    owns a booked order the moment `submit` answers, and lists it in the very
    next evaluation's `ctx.orders()` until one delivery of its terminal view has
    been evaluated. A root with an ASYNCHRONOUS order book (an OMS that can book
    an order it does not yet list) must list it within the intent's validity,
    or the replacement could sell the same shares twice — contained then only by
    the reservation (obligation 9) and by `positionAgrees`, which a booked sale
    already moves.

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
