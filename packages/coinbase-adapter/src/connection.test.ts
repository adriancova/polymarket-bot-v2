import { describe, expect, it } from "vitest";

import {
  backoffDelayMs,
  CoinbaseConnectionManager,
  DEFAULT_COINBASE_BACKOFF,
  type CoinbaseBackoff,
} from "./connection.js";
import { CoinbaseConfigurationError } from "./errors.js";
import {
  FakeCoinbaseSocketFactory,
  ManualMonotonicClock,
  ManualTimer,
  ManualWallClock,
} from "./testing/index.js";

function options(overrides: Record<string, unknown> = {}): ConstructorParameters<
  typeof CoinbaseConnectionManager
>[0] {
  return {
    feedId: "coinbase.reference",
    productIds: ["ETH-USD"],
    socketFactory: new FakeCoinbaseSocketFactory(),
    timer: new ManualTimer(),
    wallClock: new ManualWallClock(),
    monotonicClock: new ManualMonotonicClock(),
    onOutput: () => undefined,
    ...overrides,
  } as ConstructorParameters<typeof CoinbaseConnectionManager>[0];
}

describe("backoffDelayMs", () => {
  const backoff: CoinbaseBackoff = { initialDelayMs: 1_000, maxDelayMs: 8_000, multiplier: 2 };

  it("waits the initial delay on the first failure", () => {
    expect(backoffDelayMs(backoff, 1)).toBe(1_000);
  });

  it("doubles, then stops at the cap", () => {
    expect(backoffDelayMs(backoff, 2)).toBe(2_000);
    expect(backoffDelayMs(backoff, 3)).toBe(4_000);
    expect(backoffDelayMs(backoff, 4)).toBe(8_000);
    expect(backoffDelayMs(backoff, 5)).toBe(8_000);
    expect(backoffDelayMs(backoff, 500)).toBe(8_000);
  });

  it("never returns less than the initial delay, even for a zero count", () => {
    expect(backoffDelayMs(backoff, 0)).toBe(1_000);
    expect(backoffDelayMs(backoff, -3)).toBe(1_000);
  });

  it("is deterministic: the same inputs give the same delay every time", () => {
    // No jitter, because unseeded randomness would make a replayed run diverge
    // (§12.4). A fleet that needs jitter supplies a Timer that adds it.
    const runs = new Set([1, 2, 3].flatMap((n) => [backoffDelayMs(backoff, n)]));
    expect([...runs]).toEqual([1_000, 2_000, 4_000]);
  });

  it("keeps the default well inside the documented 8-connections-per-second limit", () => {
    expect(backoffDelayMs(DEFAULT_COINBASE_BACKOFF, 1)).toBeGreaterThanOrEqual(125);
  });
});

describe("CoinbaseConnectionManager options", () => {
  it("refuses a feedId that is not a domain CodeString", () => {
    expect(() => new CoinbaseConnectionManager(options({ feedId: "has spaces" }))).toThrow(
      CoinbaseConfigurationError,
    );
    expect(() => new CoinbaseConnectionManager(options({ feedId: "" }))).toThrow(
      CoinbaseConfigurationError,
    );
  });

  it("refuses an empty product list", () => {
    expect(() => new CoinbaseConnectionManager(options({ productIds: [] }))).toThrow(
      CoinbaseConfigurationError,
    );
  });

  it("refuses an empty channel list", () => {
    expect(() => new CoinbaseConnectionManager(options({ channels: [] }))).toThrow(
      CoinbaseConfigurationError,
    );
  });

  it("refuses a backoff that could not terminate or could not wait", () => {
    const bad: CoinbaseBackoff[] = [
      { initialDelayMs: 0, maxDelayMs: 1_000, multiplier: 2 },
      { initialDelayMs: -1, maxDelayMs: 1_000, multiplier: 2 },
      { initialDelayMs: 1_000, maxDelayMs: 500, multiplier: 2 },
      { initialDelayMs: 1_000, maxDelayMs: 2_000, multiplier: 0.5 },
      { initialDelayMs: 1.5, maxDelayMs: 2_000, multiplier: 2 },
    ];
    for (const backoff of bad) {
      expect(
        () => new CoinbaseConnectionManager(options({ backoff })),
        JSON.stringify(backoff),
      ).toThrow(CoinbaseConfigurationError);
    }
  });

  it("refuses a non-positive staleness poll interval", () => {
    expect(
      () => new CoinbaseConnectionManager(options({ stalenessPollIntervalMs: 0 })),
    ).toThrow(CoinbaseConfigurationError);
  });

  it("starts idle: no socket is opened until start() is called", () => {
    const factory = new FakeCoinbaseSocketFactory();
    const manager = new CoinbaseConnectionManager(options({ socketFactory: factory }));
    expect(factory.sockets).toHaveLength(0);
    expect(manager.consecutiveFailures).toBe(0);
    manager.start();
    expect(factory.sockets).toHaveLength(1);
    manager.stop();
  });

  it("can omit the heartbeats subscription when the caller says so", () => {
    const factory = new FakeCoinbaseSocketFactory();
    const manager = new CoinbaseConnectionManager(
      options({ socketFactory: factory, subscribeHeartbeats: false }),
    );
    manager.start();
    factory.current.open();
    expect(factory.current.sent).toHaveLength(2);
    expect(factory.current.sent.join()).not.toContain("heartbeats");
    manager.stop();
  });

  it("counts a connection that never opened as a failure, without a false FeedDisconnected", () => {
    const factory = new FakeCoinbaseSocketFactory();
    const timer = new ManualTimer();
    const types: string[] = [];
    const manager = new CoinbaseConnectionManager(
      options({
        socketFactory: factory,
        timer,
        onOutput: (output: { feedEvents: readonly { eventType: string }[] }) => {
          for (const event of output.feedEvents) {
            types.push(event.eventType);
          }
        },
      }),
    );
    manager.start();
    factory.current.failWith(new Error("dns failure"));
    factory.current.dropConnection(1006, "never opened");

    // A connection that never produced a FeedConnected must not produce a
    // FeedDisconnected: the pair would describe a connection that never existed.
    expect(types).toEqual([]);
    expect(manager.consecutiveFailures).toBe(1);

    timer.advanceMs(1_000);
    expect(factory.sockets).toHaveLength(2);
    manager.stop();
  });
});
