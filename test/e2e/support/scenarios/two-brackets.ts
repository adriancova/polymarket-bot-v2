/**
 * `BRACKET-1b`'s TWO-BRACKET paper scenario (E2).
 *
 * The same simulated market, identities, fee schedule, environment and
 * operator document as `../scenario.ts` — imported from it, not copied — with
 * ONE configuration delta: `reentry.maximum_entries_per_market` is `2`
 * (`cooldown_seconds` stays `30`). Nothing about capital or risk forced any
 * other change: each bracket costs at most `17` of the `1000` starting cash,
 * and every risk and strategy cap is met with the original values (the
 * arithmetic is in `test/replay-golden/paper-e2e/README.md`).
 *
 * ## What the run shows, and in which order
 *
 * 1. Bracket 1 enters (one fill, one ask level) and its take-profit is placed
 *    from `onFill`, sized to the whole allocation.
 * 2. The HOLDING TIMEOUT (`maximum_holding_seconds` 180, from the entry fill at
 *    09:00:02) fires on the 09:03:05 book: the resting take-profit is withdrawn
 *    first (§6 invariant 13) and its CANCELED view arrives; the next book
 *    (09:03:06) plans the protective reduction (`SB.PROTECTED_REDUCE`, a
 *    NON-cutoff cause), which crosses the bids and fills — `SB.EXIT_FILLED`,
 *    `SB.CLOSED` on its own `onFill` (`BRACKET-1a`).
 * 3. Once the 30 s cooldown from that close has passed, the 09:03:40 book gives
 *    `SB.REARMED`.
 * 4. The 09:03:41 book enters bracket 2, far from both entry cutoffs (45 s
 *    strategy, 30 s risk, before the 09:15:00 close).
 * 5. Bracket 2's take-profit is placed from `onFill` — an evaluation the loop
 *    ORIGINATES, so its provenance carries `sourceEventId ""` — and a public
 *    trade printed AT its price (09:04:00, `0.5 x 60`) fills it as a MAKER at
 *    `makerFeeRate "0"`: `SB.EXIT_FILLED`, `SB.CLOSED`.
 * 6. A last book (09:04:10) gives `SB.REFUSED_MAXIMUM_ENTRIES`.
 *
 * ## Choices, and why
 *
 * | Choice | Why |
 * | --- | --- |
 * | each entry fills in ONE ask level (`0.34 x 60`, later `0.33 x 60`) | the take-profit is sized to the whole allocation at its first `onFill`, so it is never resized: no scale-in resize exists whose cancel could race a fill (`BRACKET1-TPRACE` cannot be reached), and the run books the fewest orders the shape allows (five), which the `SIM-2` retention census counts |
 * | bracket 2's ask is `0.33`, not bracket 1's `0.34` | the two brackets' entry notionals, fees and edges DIFFER (`17` / `16.5`), so a reconciliation that mixed one bracket's fills into the other's rows could not come out exact by accident |
 * | the holding timeout, not the stop | it is driven by recorded time alone; the bids never move, so the stop (`<= 0.27`) is never touched |
 * | a book at every evaluation instant | `data_quality.maximum_book_age_ms` is 600 000 and the traded (YES) book is never older than 20 s at any evaluation, so `PAUSE_AND_CANCEL` can never mask the path (`../scenario.ts`, event 7's note) |
 * | the run ends at 09:04:10, not at `MarketClosing` | the reentry refusal is `planRearm`'s FIRST check, so any evaluation after the second close shows it; a `MarketClosing` near 09:15 would need yet another book refresh to stay fresh |
 * | its own `idNamespace` | the namespace is the seed every minted id is frozen against; one per golden keeps the two goldens' id spaces disjoint |
 *
 * No wall clock, no `Math.random`, no host entropy, no file read. Every instant
 * is a literal and every identity is minted by `recordedEventsOf`.
 */

import type { IngestedEvent } from "@polymarket-bot/trader";

import {
  CONDITION_ID,
  MARKET_ID,
  NO_TOKEN,
  PAPER_E2E_SCENARIO,
  T_OPEN,
  YES_BIDS,
  YES_TOKEN,
  feeSnapshot,
  recordedEventsOf,
  strategyParams,
  traderConfig,
  type Level,
  type Recorded,
} from "../scenario.js";
import type { Scenario } from "../scenario-contract.js";

/** The seed this scenario's golden is frozen against. Changing it changes the golden. */
export const TWO_BRACKETS_ID_NAMESPACE = "wp-250-paper-e2e-two-brackets";

/** The ONE configuration delta: two entries per market. */
export const MAXIMUM_ENTRIES_PER_MARKET = 2;

/** Bracket 1's YES asks: a 50-share entry fills in the first level, at 0.34. */
export const BRACKET_1_YES_ASKS: readonly Level[] = Object.freeze([
  Object.freeze({ price: "0.34", size: "60" }),
  Object.freeze({ price: "0.35", size: "40" }),
]);

/** Bracket 2's YES asks: a 50-share entry fills in the first level, at 0.33. */
export const BRACKET_2_YES_ASKS: readonly Level[] = Object.freeze([
  Object.freeze({ price: "0.33", size: "60" }),
  Object.freeze({ price: "0.35", size: "40" }),
]);

/** The public trade that fills bracket 2's take-profit: AT its price, larger than it. */
export const TAKE_PROFIT_TRADE = Object.freeze({ price: "0.5", size: "60" });

/** The §13.2 Static Bracket configuration: `../scenario.ts`'s, with two entries. */
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

/** The whole operator document: `../scenario.ts`'s, every instance on the two-entry params. */
export function twoBracketsTraderConfig(
  options: { readonly withShadow?: boolean } = {},
): Record<string, unknown> {
  const document = traderConfig(options);
  const instances = (document["instances"] as readonly Record<string, unknown>[]).map(
    (instance) => ({ ...instance, params: twoBracketsStrategyParams() }),
  );
  return { ...document, instances };
}

function yesBook(asks: readonly Level[], receivedAt: string): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: YES_TOKEN,
      bids: YES_BIDS.map((level) => ({ price: level.price, size: level.size })),
      asks: asks.map((level) => ({ price: level.price, size: level.size })),
    },
    receivedAt,
  };
}

function noBook(receivedAt: string): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.65", size: "200" }],
      asks: [{ price: "0.66", size: "200" }],
    },
    receivedAt,
  };
}

/**
 * The recorded events, in publication order (`ingestSeq` = position + 1).
 * What each one is expected to do is derived by hand, before any capture, in
 * `test/replay-golden/paper-e2e/README.md`.
 */
const RECORDED: readonly Recorded[] = Object.freeze([
  // 1-2: the §9.5 reference feed must be non-empty before a snapshot exists.
  {
    eventType: "ReferenceTradeObserved",
    payload: { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" },
    receivedAt: "2026-05-01T08:59:58.000Z",
    source: "binance",
  },
  {
    eventType: "ReferenceTradeObserved",
    payload: { venue: "binance", symbol: "BTCUSDT", price: "64100", size: "0.25" },
    receivedAt: "2026-05-01T08:59:59.000Z",
    source: "binance",
  },
  // 3
  {
    eventType: "MarketOpened",
    payload: { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN },
    receivedAt: "2026-05-01T09:00:00.000Z",
  },
  // 4: ARM.
  yesBook(BRACKET_1_YES_ASKS, "2026-05-01T09:00:01.000Z"),
  // 5: bracket 1 ENTERS; its take-profit is placed from onFill.
  noBook("2026-05-01T09:00:02.000Z"),
  // 6: 183 s after the entry fill — the holding timeout withdraws the take-profit.
  yesBook(BRACKET_1_YES_ASKS, "2026-05-01T09:03:05.000Z"),
  // 7: the protective reduction; it fills against the 0.32 bid and CLOSES bracket 1.
  yesBook(BRACKET_1_YES_ASKS, "2026-05-01T09:03:06.000Z"),
  // 8: 34 s after the close (cooldown 30 s) — REARMED. The ask is now 0.33.
  yesBook(BRACKET_2_YES_ASKS, "2026-05-01T09:03:40.000Z"),
  // 9: bracket 2 ENTERS; its take-profit is placed from onFill (sourceEventId "").
  noBook("2026-05-01T09:03:41.000Z"),
  // 10: a trade AT the take-profit's price fills it as a MAKER, fee 0 — CLOSED.
  {
    eventType: "PublicTradeObserved",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: YES_TOKEN,
      price: TAKE_PROFIT_TRADE.price,
      size: TAKE_PROFIT_TRADE.size,
    },
    receivedAt: "2026-05-01T09:04:00.000Z",
  },
  // 11: a closed instance with both entries spent — REFUSED_MAXIMUM_ENTRIES.
  yesBook(BRACKET_2_YES_ASKS, "2026-05-01T09:04:10.000Z"),
]);

/** The scenario's events. A pure function of module constants. */
export function twoBracketsEvents(): readonly IngestedEvent[] {
  return recordedEventsOf(RECORDED);
}

/**
 * The two-bracket scenario. Its constants are `../scenario.ts`'s — the same
 * market, instance, account, sizes, prices and fee model — so the artefact's
 * `scenario` section differs from the original golden's in `idNamespace` only.
 */
export const TWO_BRACKETS_SCENARIO: Scenario = Object.freeze({
  name: "two-brackets",
  idNamespace: TWO_BRACKETS_ID_NAMESPACE,
  clockStart: T_OPEN,
  constants: PAPER_E2E_SCENARIO.constants,
  feeSnapshot,
  traderConfig: twoBracketsTraderConfig,
  events: twoBracketsEvents,
  goldenFile: "two-brackets-run.json",
});
