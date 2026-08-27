/**
 * Shared harness for the Binance contract suite.
 *
 * Keeps every test on the same deterministic clock and the same feed
 * configuration, so a difference between two tests is a difference in the
 * fixture rather than in the setup.
 */

import {
  BinanceReferenceFeed,
  type AdapterEmission,
  type BinanceReferenceFeedOptions,
} from "@polymarket-bot/binance-adapter";
import { createManualClock, type ManualClock } from "@polymarket-bot/binance-adapter/testing";

export const DEFAULT_SUBSCRIPTIONS = [
  { symbol: "BNBBTC", suffix: "trade" },
  { symbol: "BNBUSDT", suffix: "bookTicker" },
] as const;

export type Harness = {
  readonly feed: BinanceReferenceFeed;
  readonly clock: ManualClock;
  /** Emissions collected from every driven transition, in order. */
  readonly emissions: AdapterEmission[];
};

/** Builds a feed with a deterministic clock and the two in-scope streams. */
export function createHarness(
  overrides: Partial<BinanceReferenceFeedOptions> = {},
  clockOptions: { readonly startAt?: string } = {},
): Harness {
  const feed = new BinanceReferenceFeed({
    feedId: "binance.reference",
    subscriptions: [...DEFAULT_SUBSCRIPTIONS],
    stalenessThresholdMs: 30_000,
    ...overrides,
  });
  return {
    feed,
    clock: createManualClock(clockOptions),
    emissions: [],
  };
}

/** Opens the feed and collects the resulting emissions. */
export function open(harness: Harness, connectionId: string): readonly AdapterEmission[] {
  harness.feed.connecting();
  const outcome = harness.feed.onOpen(connectionId, harness.clock.peek());
  harness.emissions.push(...outcome.emissions);
  return outcome.emissions;
}

export const eventTypesOf = (emissions: readonly AdapterEmission[]): string[] =>
  emissions.map((emission) => emission.eventType);
