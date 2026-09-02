/**
 * Subscription planning (workplan deliverable): configuration in, one
 * per-venue subscription set out. Pure — no I/O, no clock.
 *
 * What planning deliberately does NOT do:
 *
 * - It invents no venue limit. The maximum `assets_ids` per Polymarket
 *   subscription (venue item U-3) and the maximum `product_ids` per Coinbase
 *   subscription (U-CB-4) are both undocumented; the plan carries whatever
 *   configuration states and leaves chunking to the adapters' own documented
 *   knobs.
 * - It performs no discovery. Markets come from reviewed configuration
 *   (§9.2), and the token set is derived from them — both outcome tokens per
 *   market, which §9.2 requires the catalogue to store.
 */

import type { BinanceStreamSubscription } from "@polymarket-bot/binance-adapter";

import type { GatewayConfig } from "./config.js";

export interface SubscriptionPlan {
  /** Both outcome tokens of every configured market, deduplicated, in order. */
  readonly polymarketTokenIds: readonly string[];
  /** Trade + top-of-book per configured Binance symbol. */
  readonly binanceSubscriptions: readonly BinanceStreamSubscription[];
  /** Venue-native Coinbase product ids, passed through opaquely. */
  readonly coinbaseProductIds: readonly string[];
  /** RTDS window subscriptions, exactly as configured. */
  readonly rtdsSubscriptions: readonly {
    readonly windowSeconds: 30 | 60;
    readonly symbols?: readonly string[];
  }[];
  /**
   * The RTDS symbols the gateway publishes (lowercase). A multi-symbol
   * subscription receives every symbol; updates outside this set are counted
   * and not published (WP-100 consumer obligation: filter on
   * `payload.symbol`).
   */
  readonly rtdsPlannedSymbols: ReadonlySet<string>;
}

export function planSubscriptions(config: GatewayConfig): SubscriptionPlan {
  const tokenIds: string[] = [];
  const seen = new Set<string>();
  for (const market of config.markets) {
    for (const tokenId of [market.yesTokenId, market.noTokenId]) {
      if (!seen.has(tokenId)) {
        seen.add(tokenId);
        tokenIds.push(tokenId);
      }
    }
  }

  const binanceSubscriptions: BinanceStreamSubscription[] = [];
  if (config.binance !== undefined) {
    for (const symbol of config.binance.symbols) {
      binanceSubscriptions.push({ symbol, suffix: "trade" });
      binanceSubscriptions.push({ symbol, suffix: "bookTicker" });
    }
  }

  return {
    polymarketTokenIds: tokenIds,
    binanceSubscriptions,
    coinbaseProductIds: config.coinbase === undefined ? [] : [...config.coinbase.productIds],
    rtdsSubscriptions:
      config.rtds === undefined
        ? []
        : config.rtds.subscriptions.map((subscription) => ({
            windowSeconds: subscription.windowSeconds,
            ...(subscription.symbols === undefined ? {} : { symbols: subscription.symbols }),
          })),
    rtdsPlannedSymbols: new Set(
      config.rtds === undefined
        ? []
        : config.rtds.plannedSymbols.map((symbol) => symbol.toLowerCase()),
    ),
  };
}
