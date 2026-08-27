/**
 * Shared offline harness for the Coinbase contract suite.
 *
 * Builds a processor whose clocks a test controls completely, so receipt
 * timestamps are deterministic and staleness can be produced without waiting.
 */

import { CoinbaseStreamProcessor } from "@polymarket-bot/coinbase-adapter";
import type {
  CoinbaseAnomaly,
  CoinbaseAnomalyCode,
  CoinbaseFeedEvent,
  CoinbaseNormalizedEvent,
  CoinbaseNormalizedTopOfBook,
  CoinbaseNormalizedTrade,
  CoinbaseProcessorOutput,
} from "@polymarket-bot/coinbase-adapter";
import {
  ManualMonotonicClock,
  ManualWallClock,
} from "@polymarket-bot/coinbase-adapter/testing";

export type Harness = {
  readonly processor: CoinbaseStreamProcessor;
  readonly wallClock: ManualWallClock;
  readonly monotonicClock: ManualMonotonicClock;
  /** Advances both clocks together by the same simulated duration. */
  advanceMs(deltaMs: number): void;
};

export function createHarness(
  options: {
    readonly feedId?: string;
    readonly channels?: readonly ("market_trades" | "ticker" | "heartbeats" | "subscriptions")[];
    readonly stalenessThresholdMs?: number;
    readonly tradeDedupeCapacity?: number;
  } = {},
): Harness {
  const wallClock = new ManualWallClock("2026-08-27T12:00:00.000Z");
  const monotonicClock = new ManualMonotonicClock(1_000_000_000n);
  const processor = new CoinbaseStreamProcessor({
    feedId: options.feedId ?? "coinbase.reference",
    ...(options.channels === undefined ? {} : { channels: options.channels }),
    ...(options.stalenessThresholdMs === undefined
      ? {}
      : { stalenessThresholdMs: options.stalenessThresholdMs }),
    ...(options.tradeDedupeCapacity === undefined
      ? {}
      : { tradeDedupeCapacity: options.tradeDedupeCapacity }),
    wallClock,
    monotonicClock,
  });
  return {
    processor,
    wallClock,
    monotonicClock,
    advanceMs(deltaMs: number): void {
      wallClock.advanceMs(deltaMs);
      monotonicClock.advanceMs(deltaMs);
    },
  };
}

/**
 * The three arrays every processor and manager output carries.
 *
 * Structural rather than the concrete `CoinbaseProcessorOutput`, so the same
 * helpers read a `CoinbaseFeedOutput` from the connection manager, which does
 * not carry `requiresResubscription`.
 */
export type OutputLike = Pick<
  CoinbaseProcessorOutput,
  "normalized" | "feedEvents" | "anomalies"
>;

export function anomalyCodes(output: OutputLike): CoinbaseAnomalyCode[] {
  return output.anomalies.map((anomaly: CoinbaseAnomaly) => anomaly.code);
}

export function feedEventTypes(output: OutputLike): string[] {
  return output.feedEvents.map((event: CoinbaseFeedEvent) => event.eventType);
}

export function trades(output: OutputLike): CoinbaseNormalizedTrade[] {
  return output.normalized.filter(
    (event: CoinbaseNormalizedEvent): event is CoinbaseNormalizedTrade =>
      event.eventType === "ReferenceTradeObserved",
  );
}

export function tops(output: OutputLike): CoinbaseNormalizedTopOfBook[] {
  return output.normalized.filter(
    (event: CoinbaseNormalizedEvent): event is CoinbaseNormalizedTopOfBook =>
      event.eventType === "ReferenceTopOfBookChanged",
  );
}

/** The first feed event of a type, failing loudly when there is none. */
export function feedEvent<T extends CoinbaseFeedEvent["eventType"]>(
  output: OutputLike,
  eventType: T,
): Extract<CoinbaseFeedEvent, { eventType: T }> {
  const found = output.feedEvents.find((event) => event.eventType === eventType);
  if (found === undefined) {
    throw new Error(
      `expected a ${eventType} event; got ${feedEventTypes(output).join(", ") || "<none>"}`,
    );
  }
  return found as Extract<CoinbaseFeedEvent, { eventType: T }>;
}
