/**
 * `BRACKET-1c` — the two-bracket round trip on THIS suite's fixture, for
 * `durable-two-brackets-postgres-redis.test.ts`.
 *
 * `BRACKET-1b` recorded the shape in memory (`test/e2e/support/scenarios/two-brackets.ts`,
 * golden `test/replay-golden/paper-e2e/two-brackets-run.json`). This module
 * rebuilds the SAME shape on the paper-trader fixture's market, identities,
 * ladders and times rather than importing the e2e scenario: the durable file
 * must register the market it trades through `WP-040`'s repositories
 * (`support/registration.ts`), and the fixture is what that registration
 * already speaks.
 *
 * ## The configuration: the fixture's, with ONE delta
 *
 * `reentry.maximum_entries_per_market` is `2` ({@link twoBracketsStrategyParams}).
 * Nothing else in the strategy, risk, allocator, accounting or simulation
 * sections changes. The document also names a per-scenario event stream
 * (`infrastructure.eventStream`), as `univ-4-gateway-opens-trader-redis.test.ts`
 * does — an infrastructure address, not an economic setting — so two scenarios
 * in one Redis never read each other's events.
 *
 * `feeSchedule: "e2e"` is a SECOND, disclosed delta used by one test only: the
 * e2e scenario's fee schedule (taker `0.0195`, maker `0`, 3 places HALF_UP, on
 * both the simulator's schedule and the market's rates, as
 * `test/e2e/support/scenario.ts` states them). The fixture's schedule is ZERO,
 * so under it no fill posts a `PLATFORM_FEE` transaction and the durable fee
 * writer never runs; the variant is the only way this file can make it run.
 *
 * ## How the fixture differs from the e2e scenario, and whether it matters
 *
 * | Fixture vs e2e | Changes the run? |
 * | --- | --- |
 * | fee schedule zero vs taker `0.0195` / 3 places | YES: 2 ledger transactions per fill (8), not 3+3+3+2 (11); fees 0, so net = realized. The `"e2e"` variant restores the e2e schedule |
 * | YES asks `0.34 x 200, 0.35 x 300` (bracket 2: `0.33 x 200`) vs `0.34 x 60` / `0.33 x 60` | NO: every 50-share entry still fills in ONE level at the same price. The fixture's sizes are KEPT because its `maximum_book_participation` is `0.5` (e2e `0.9`): 50 of a 60-share level is `0.83` |
 * | `maximum_book_participation` `0.5` vs `0.9` | NO at these sizes (50 / 200 = 0.25) |
 * | T_OPEN `12:00:00` vs `09:00:00` (close `12:15` vs `09:15`) | NO: every instant is the e2e's plus exactly 3 hours, so every offset (holding timeout, cooldown, cutoffs) is identical |
 * | series `btc-15m-updown`, reference prices `100000/100100`, ids, account, idNamespace | NO: identities and labels; the reference prices only feed the §9.5 feed's presence |
 *
 * ## The events, and what each one is for
 *
 * The same eleven as `BRACKET-1b`'s, in the same order, each at the e2e
 * instant + 3 h. Both entries fill in ONE ask level, so each take-profit is
 * placed once, from `onFill`, at full size and never resized — no scale-in
 * resize exists whose cancel could race a fill (`BRACKET1-TPRACE` cannot be
 * reached). The traded (YES) book is refreshed at every evaluation instant, so
 * `data_quality.maximum_book_age_ms` (600 000) can never mask the path.
 *
 * No wall clock, no entropy, no file read: every instant is a literal and
 * every id is minted by the fixture's own counter.
 */

import type { IngestedEvent } from "@polymarket-bot/trader";

import { NO_TOKEN, T_OPEN, YES_TOKEN, ingested, resetEventIds, strategyParams } from "./fixture.js";
import { documentFor, type Registered } from "./registration.js";

/** The ONE configuration delta: two entries per market. */
export const MAXIMUM_ENTRIES_PER_MARKET = 2;

/** One price level of a recorded ladder. */
interface Level {
  readonly price: string;
  readonly size: string;
}

/** The fixture's YES bids, unchanged all run: the reduction sells 50 into the first. */
export const YES_BIDS: readonly Level[] = Object.freeze([
  Object.freeze({ price: "0.32", size: "200" }),
  Object.freeze({ price: "0.31", size: "300" }),
]);

/** Bracket 1's YES asks (the fixture's): a 50-share entry fills in the first level, at 0.34. */
export const BRACKET_1_YES_ASKS: readonly Level[] = Object.freeze([
  Object.freeze({ price: "0.34", size: "200" }),
  Object.freeze({ price: "0.35", size: "300" }),
]);

/** Bracket 2's YES asks: a 50-share entry fills in the first level, at 0.33 (1b's choice). */
export const BRACKET_2_YES_ASKS: readonly Level[] = Object.freeze([
  Object.freeze({ price: "0.33", size: "200" }),
  Object.freeze({ price: "0.35", size: "300" }),
]);

/** The public trade that fills bracket 2's take-profit: AT its price, larger than it. */
export const TAKE_PROFIT_TRADE = Object.freeze({ price: "0.5", size: "60" });

/** The fixture's §13.2 document with two entries per market. */
export function twoBracketsStrategyParams(): Record<string, unknown> {
  const params = strategyParams();
  return {
    ...params,
    reentry: {
      ...(params["reentry"] as Record<string, unknown>),
      maximum_entries_per_market: MAXIMUM_ENTRIES_PER_MARKET,
    },
  };
}

/** The e2e scenario's fee schedule (`test/e2e/support/scenario.ts` `feeSnapshot()`), restated. */
export const E2E_FEE_SCHEDULE = Object.freeze({
  snapshotVersion: "wp250.sim.2026-05-01",
  takerFeeRate: "0.0195",
  makerFeeRate: "0",
  roundingDecimalPlaces: 3,
  roundingMode: "HALF_UP",
  minimumChargedFee: "0",
  feeCurrency: "pUSD",
});

/**
 * The operator document for the registered rows: {@link documentFor}'s, with
 * the two-entry params, the scenario's own event stream and — for the one
 * variant that asks — the e2e fee schedule.
 */
export function twoBracketsDocument(
  registered: Registered,
  label: string,
  options: { readonly eventStream: string; readonly feeSchedule?: "fixture" | "e2e" },
): Record<string, unknown> {
  const base = documentFor(registered, label);
  const instances = (base["instances"] as readonly Record<string, unknown>[]).map((instance) => ({
    ...instance,
    params: twoBracketsStrategyParams(),
  }));
  const infrastructure = {
    ...(base["infrastructure"] as Record<string, unknown>),
    eventStream: options.eventStream,
  };
  if (options.feeSchedule !== "e2e") return { ...base, instances, infrastructure };
  const markets = (base["markets"] as readonly Record<string, unknown>[]).map((market) => ({
    ...market,
    makerFeeRate: E2E_FEE_SCHEDULE.makerFeeRate,
    takerFeeRate: E2E_FEE_SCHEDULE.takerFeeRate,
  }));
  const simulation = {
    ...(base["simulation"] as Record<string, unknown>),
    feeSchedule: { ...E2E_FEE_SCHEDULE },
  };
  return { ...base, instances, infrastructure, markets, simulation };
}

function yesBook(
  marketId: string,
  asks: readonly Level[],
  receivedAt: string,
  ingestSeq: number,
): IngestedEvent {
  return ingested(
    "BookSnapshot",
    {
      internalMarketId: marketId,
      tokenId: YES_TOKEN,
      bids: YES_BIDS.map((level) => ({ price: level.price, size: level.size })),
      asks: asks.map((level) => ({ price: level.price, size: level.size })),
    },
    { receivedAt, ingestSeq },
  );
}

function noBook(marketId: string, receivedAt: string, ingestSeq: number): IngestedEvent {
  return ingested(
    "BookSnapshot",
    {
      internalMarketId: marketId,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.65", size: "200" }],
      asks: [{ price: "0.66", size: "200" }],
    },
    { receivedAt, ingestSeq },
  );
}

/**
 * The eleven recorded events, in publication order (`ingestSeq` = position + 1),
 * addressed to the REGISTERED market and the condition id it was registered
 * under. What each one is expected to do is derived by hand in the test file's
 * header.
 */
export function twoBracketsEvents(marketId: string, conditionId: string): readonly IngestedEvent[] {
  resetEventIds();
  return Object.freeze([
    // 1-2: the §9.5 reference feed must be non-empty before a snapshot exists.
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100000", size: "0.5" },
      { receivedAt: "2026-03-04T11:59:58.000Z", ingestSeq: 1, source: "binance" },
    ),
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100100", size: "0.25" },
      { receivedAt: "2026-03-04T11:59:59.000Z", ingestSeq: 2, source: "binance" },
    ),
    // 3
    ingested(
      "MarketOpened",
      { internalMarketId: marketId, conditionId, openedAt: T_OPEN },
      { receivedAt: "2026-03-04T12:00:00.000Z", ingestSeq: 3 },
    ),
    // 4: ARM.
    yesBook(marketId, BRACKET_1_YES_ASKS, "2026-03-04T12:00:01.000Z", 4),
    // 5: bracket 1 ENTERS; its take-profit is placed from onFill.
    noBook(marketId, "2026-03-04T12:00:02.000Z", 5),
    // 6: 183 s after the entry fill — the holding timeout withdraws the take-profit.
    yesBook(marketId, BRACKET_1_YES_ASKS, "2026-03-04T12:03:05.000Z", 6),
    // 7: the protective reduction fills against the 0.32 bid and CLOSES bracket 1.
    yesBook(marketId, BRACKET_1_YES_ASKS, "2026-03-04T12:03:06.000Z", 7),
    // 8: 34 s after the close (cooldown 30 s) — REARMED. The ask is now 0.33.
    yesBook(marketId, BRACKET_2_YES_ASKS, "2026-03-04T12:03:40.000Z", 8),
    // 9: bracket 2 ENTERS; its take-profit is placed from onFill (no source event).
    noBook(marketId, "2026-03-04T12:03:41.000Z", 9),
    // 10: a trade AT the take-profit's price fills it as a MAKER — CLOSED.
    ingested(
      "PublicTradeObserved",
      {
        internalMarketId: marketId,
        tokenId: YES_TOKEN,
        price: TAKE_PROFIT_TRADE.price,
        size: TAKE_PROFIT_TRADE.size,
      },
      { receivedAt: "2026-03-04T12:04:00.000Z", ingestSeq: 10 },
    ),
    // 11: a closed instance with both entries spent — REFUSED_MAXIMUM_ENTRIES.
    yesBook(marketId, BRACKET_2_YES_ASKS, "2026-03-04T12:04:10.000Z", 11),
  ]);
}
