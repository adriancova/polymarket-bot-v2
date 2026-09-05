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
5. **A repeated order view is ordinary traffic.** Nothing in §8.1 or §9.6
   promises at-most-once delivery, so a second `FILLED`/`CANCELED` view for an
   order the instance already tracks as terminal is *absorbed*: the evidence is
   folded, the sub-machine is not consulted, and the instance does not halt.
   Roots may redeliver freely.
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

## Known exposure: an `OPEN` view while a cancel is in flight HALTS

`CANCEL_PENDING --OBSERVED_WORKING-->` is not an edge of the §13.3 working-order
sub-machine, and `planOrderUpdate` halts on an illegal sub-machine move. So a
view with `status: "OPEN"` — or any status this package does not recognise,
which is read as `OBSERVED_WORKING` per §6 invariant 6 — that arrives for an
order whose cancel has been requested but not yet confirmed halts the instance.
That is an ordinary venue message: the order really is still open until the
cancel is processed.

**This is not fixed here.** It is not one of the review findings this round was
authorised to remediate, and closing it needs either a new sub-machine edge
(which moves the pinned machine counts) or a second absorption branch — both
changes a reviewer should see proposed rather than smuggled into a remediation.
It is reproduced and recorded so the next round can decide:

```
track CANCEL_PENDING + view status OPEN            -> SB.HALTED
track CANCEL_PENDING + unrecognised view status    -> SB.HALTED
```

Two of the 28 `(non-terminal track state × view status)` shapes. The repeated
**terminal**-view halt this round did fix is separately swept in
`machine-closure.test.ts` (1,008 shapes, zero halts).

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
