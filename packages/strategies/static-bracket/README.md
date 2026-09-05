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
   feature snapshots → invoke subscribed strategies". A view that lags the fill
   stream will make the §6 invariant 12 position gate refuse exits it should
   have allowed.
4. **Views must be fresh or copied per evaluation** (WP-170 `follow_up` 2), and
   `StrategyContextRevokedError` must not be swallowed.

## Safety

`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false` and both live-micro caps at `0`
are untouched by this package, which holds no credential and can hold none: it
has no I/O surface at all. No venue call, no signer, no real order, and no
performance claim.
