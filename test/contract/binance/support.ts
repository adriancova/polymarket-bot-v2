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
  type FeedOutcome,
  type FrameOutcome,
  type ReceiptStamp,
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
  /**
   * The socket the harness is currently driving.
   *
   * Every socket event carries the identity of the socket that produced it, so
   * a test that drives a frame has to say which socket delivered it. Tracking
   * the open connection here keeps that explicit without repeating the id at
   * every call site.
   */
  connectionId: string;
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
    connectionId: "binance.unconnected",
  };
}

/** Opens the feed and collects the resulting emissions. */
export function open(harness: Harness, connectionId: string): readonly AdapterEmission[] {
  // The attempt is registered before the socket exists: only the identity the
  // caller registers may open a connection (round-2 review, R2-M1).
  harness.feed.connecting(connectionId);
  harness.connectionId = connectionId;
  const outcome = harness.feed.onOpen(connectionId, harness.clock.peek());
  harness.emissions.push(...outcome.emissions);
  return outcome.emissions;
}

/** Delivers a frame from the socket the harness currently has open. */
export function deliver(harness: Harness, raw: string, receipt: ReceiptStamp): FrameOutcome {
  return harness.feed.onFrame(harness.connectionId, raw, receipt);
}

/** Closes the socket the harness currently has open. */
export function closeSocket(
  harness: Harness,
  receipt: ReceiptStamp,
  input: { readonly code?: number; readonly reason?: string } = {},
): FeedOutcome {
  return harness.feed.onClose(harness.connectionId, receipt, input);
}

export const eventTypesOf = (emissions: readonly AdapterEmission[]): string[] =>
  emissions.map((emission) => emission.eventType);
