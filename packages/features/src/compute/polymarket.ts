/**
 * Polymarket book and trade features (§9.5 first block).
 *
 * All arithmetic is exact except the documented divisions, which use the
 * pinned v1 policy (`decimal-policy.ts`). Absent-versus-zero semantics are the
 * contract this package owes WP-150's carried follow-up:
 *
 * - PRICE-DERIVED features (best bid/ask, midpoint, spread, VWAP, microprice)
 *   are ABSENT when a side they need is empty. Zero is a legal price and a
 *   legal size, so it may never stand in for "no price exists".
 * - SUM-DERIVED features (depth, traded volumes) report `"0"` over an empty
 *   set, because zero genuinely is the sum of nothing — the same convention
 *   the order-book package's own `depth()` uses.
 *
 * The executable-price walk mirrors the order-book package's
 * `executablePrice` semantics (best-first, min(level, remaining), typed
 * insufficient-depth with requested and available, never a partial answer) —
 * with the division OPTION pinned rather than overridable, which is this
 * package's documented choice. The walk is re-implemented here because the
 * machine-checked dependency contract enumerates no features → order-book
 * edge (F13); `test/unit/features/book-crosscheck.test.ts` binds this walk to
 * the real `executablePrice` output so the two cannot drift silently.
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import type { DecimalString } from "@polymarket-bot/decimal";

import type { ParsedBookLevel } from "../book-serialization.js";
import { dividePolicy, halveExact } from "../decimal-policy.js";
import type { ValidatedFeatureInput } from "../inputs.js";
import type { ComputedFeature, FeatureData } from "../values.js";
import { absent, ok } from "../values.js";

function sideSum(levels: readonly ParsedBookLevel[], count?: number): DecimalString {
  let sum: DecimalString = "0";
  const limit = count === undefined ? levels.length : Math.min(count, levels.length);
  for (let index = 0; index < limit; index += 1) {
    const level = levels[index];
    if (level !== undefined) {
      sum = addDecimal(sum, level.size);
    }
  }
  return sum;
}

/** One executable-price answer for one configured quantity. */
function executableOutcome(
  ladder: readonly ParsedBookLevel[],
  requestedShares: DecimalString,
): FeatureData {
  let remaining: DecimalString = requestedShares;
  let totalCost: DecimalString = "0";
  let worstPrice: DecimalString | undefined;
  let levelsConsumed = 0;
  for (const level of ladder) {
    if (compareDecimal(remaining, "0") === 0) break;
    const take = compareDecimal(level.size, remaining) < 0 ? level.size : remaining;
    totalCost = addDecimal(totalCost, mulDecimal(take, level.price));
    remaining = subDecimal(remaining, take);
    worstPrice = level.price;
    levelsConsumed += 1;
  }
  if (compareDecimal(remaining, "0") > 0 || worstPrice === undefined) {
    return {
      requestedShares,
      outcome: "INSUFFICIENT_DEPTH",
      availableShares: subDecimal(requestedShares, remaining),
    };
  }
  return {
    requestedShares,
    outcome: "QUOTE",
    volumeWeightedAveragePrice: dividePolicy(totalCost, requestedShares),
    totalCost,
    worstPrice,
    levelsConsumed,
  };
}

export function computePolymarketFeatures(input: ValidatedFeatureInput): ComputedFeature[] {
  const { bids, asks } = input.book.parsed;
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const features: ComputedFeature[] = [];

  const bothSidesReason =
    bestBid === undefined && bestAsk === undefined
      ? ("EMPTY_BOOK" as const)
      : bestBid === undefined
        ? ("EMPTY_BID_SIDE" as const)
        : bestAsk === undefined
          ? ("EMPTY_ASK_SIDE" as const)
          : undefined;

  features.push(
    bestBid === undefined
      ? absent("polymarket.best_bid", "EMPTY_BID_SIDE")
      : ok("polymarket.best_bid", { price: bestBid.price, size: bestBid.size }),
  );
  features.push(
    bestAsk === undefined
      ? absent("polymarket.best_ask", "EMPTY_ASK_SIDE")
      : ok("polymarket.best_ask", { price: bestAsk.price, size: bestAsk.size }),
  );
  features.push(
    bothSidesReason !== undefined || bestBid === undefined || bestAsk === undefined
      ? absent("polymarket.midpoint", bothSidesReason ?? "EMPTY_BOOK")
      : ok("polymarket.midpoint", halveExact(addDecimal(bestBid.price, bestAsk.price))),
  );
  features.push(
    bothSidesReason !== undefined || bestBid === undefined || bestAsk === undefined
      ? absent("polymarket.spread", bothSidesReason ?? "EMPTY_BOOK")
      : ok("polymarket.spread", subDecimal(bestAsk.price, bestBid.price)),
  );

  features.push(
    ok(
      "polymarket.depth_at_levels",
      input.config.depthLevels.map((levels) => ({
        levels,
        bidShares: sideSum(bids, levels),
        bidLevelCount: Math.min(levels, bids.length),
        askShares: sideSum(asks, levels),
        askLevelCount: Math.min(levels, asks.length),
      })),
    ),
  );

  features.push(
    ok(
      "polymarket.executable_buy_price",
      input.config.executableShares.map((shares) => executableOutcome(asks, shares)),
    ),
  );
  features.push(
    ok(
      "polymarket.executable_sell_price",
      input.config.executableShares.map((shares) => executableOutcome(bids, shares)),
    ),
  );

  const bidShares = sideSum(bids);
  const askShares = sideSum(asks);
  const totalShares = addDecimal(bidShares, askShares);
  features.push(
    compareDecimal(totalShares, "0") === 0
      ? absent("polymarket.order_book_imbalance", "EMPTY_BOOK")
      : ok("polymarket.order_book_imbalance", dividePolicy(bidShares, totalShares)),
  );

  features.push(
    bothSidesReason !== undefined || bestBid === undefined || bestAsk === undefined
      ? absent("polymarket.microprice", bothSidesReason ?? "EMPTY_BOOK")
      : ok(
          "polymarket.microprice",
          dividePolicy(
            addDecimal(mulDecimal(bestBid.price, bestAsk.size), mulDecimal(bestAsk.price, bestBid.size)),
            addDecimal(bestBid.size, bestAsk.size),
          ),
        ),
  );

  features.push(computeRecentTrades(input));
  return features;
}

function computeRecentTrades(input: ValidatedFeatureInput): ComputedFeature {
  if (input.trades === undefined) {
    return absent("polymarket.recent_trades", "INPUT_MISSING", "no trades feed input was supplied");
  }
  const windowMs = input.config.tradeWindowMs;
  const windowStartMs = input.asOfEpochMs - windowMs;

  let tradeCount = 0;
  let buyVolume: DecimalString = "0";
  let sellVolume: DecimalString = "0";
  let unknownVolume: DecimalString = "0";
  let lastTradeSide: "BID" | "ASK" | "UNKNOWN" | "NONE" = "NONE";
  for (const trade of input.trades.window) {
    // The window is (asOf - windowMs, asOf]: half-open at the old edge so one
    // trade belongs to exactly one window of this length ending at asOf.
    if (trade.observedAtEpochMs <= windowStartMs) continue;
    tradeCount += 1;
    if (trade.takerSide === "BID") {
      buyVolume = addDecimal(buyVolume, trade.size);
      lastTradeSide = "BID";
    } else if (trade.takerSide === "ASK") {
      sellVolume = addDecimal(sellVolume, trade.size);
      lastTradeSide = "ASK";
    } else {
      unknownVolume = addDecimal(unknownVolume, trade.size);
      lastTradeSide = "UNKNOWN";
    }
  }
  const order = compareDecimal(buyVolume, sellVolume);
  return ok("polymarket.recent_trades", {
    windowMs,
    tradeCount,
    buyVolume,
    sellVolume,
    unknownVolume,
    totalVolume: addDecimal(addDecimal(buyVolume, sellVolume), unknownVolume),
    netSignedVolume: subDecimal(buyVolume, sellVolume),
    netDirection: order > 0 ? "BUY" : order < 0 ? "SELL" : "FLAT",
    lastTradeSide,
  });
}
