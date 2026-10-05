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
 * - It performs no discovery outside reviewed series. Markets come from
 *   reviewed configuration (§9.2), or are admitted windows of a reviewed
 *   series (ADR-030 Decision 1; `feeds/series-admission.ts`, which subscribes
 *   each admitted window's tokens itself, at run time), and the token set is
 *   derived from them — both outcome tokens per market, which §9.2 requires
 *   the catalogue to store.
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
  // No RTDS plan: the RTDS feed was retired by `RTDS-RETIRE` (2026-10-05,
  // ruling V3-C13), and the configuration door refuses an `rtds` block.
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
  };
}
