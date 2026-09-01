/**
 * The startup sequence is TRANSACTIONAL (round-3 review R3-H1).
 *
 * At `45c231c`, `main.ts` connected and owned the transport before
 * `DataGateway.create()` opened the WAL, and the fatal handler only set the
 * exit code — so a WAL that would not open left a healthy CONNECTED transport
 * running forever, holding the "exiting" process alive on its referenced
 * socket. These tests pin the extracted sequence's disposal discipline
 * in-process, with a close-counting transport standing where the reviewer's
 * probe put its reference-owning one; the subprocess half (the actual
 * process-liveness consequence, real bundle and probe entry) lives in
 * `test/integration/data-gateway/fatal-startup-release.test.ts`.
 *
 * The invariant under test: on ANY fatal startup error, every resource
 * acquired so far is released, `close` is called EXACTLY once per resource,
 * and the original error (not a cleanup error) is what escapes.
 */

import { FakeCoinbaseSocketFactory } from "@polymarket-bot/coinbase-adapter/testing";
import type { CoinbaseSocketFactory } from "@polymarket-bot/coinbase-adapter";
import type { MarketEventTransport } from "@polymarket-bot/event-bus";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { describe, expect, it } from "vitest";

import { parseGatewayConfig } from "./config.js";
import { GatewayStateError } from "./errors.js";
import type { GatewayHost, GatewaySequenceOptions } from "./run.js";
import { runGatewaySequence } from "./run.js";
import {
  deterministicIdSource,
  ManualGatewayClock,
  ManualGatewayTimers,
  MemoryEventTransport,
} from "./testing/index.js";

const MARKET = {
  internalMarketId: "01990000-0000-7000-8000-000000000001",
  conditionId: "0x" + "ab".repeat(31),
  yesTokenId: "11111",
  noTokenId: "22222",
  parameters: {
    tickSize: "0.01",
    minimumOrderSize: "5",
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
  },
  observedAt: "2026-08-30T12:00:00.000Z",
} as const;

interface RecordingHost extends GatewayHost {
  readonly lines: string[];
  readonly exitCodes: number[];
  readonly shutdownHandlers: Array<() => void>;
}

function recordingHost(): RecordingHost {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  const shutdownHandlers: Array<() => void> = [];
  return {
    lines,
    exitCodes,
    shutdownHandlers,
    logError: (line, detail) => {
      lines.push(detail === undefined ? line : `${line} :: ${String(detail)}`);
    },
    registerShutdownSignals: (handler) => {
      shutdownHandlers.push(handler);
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
  };
}

/** A CONNECTED transport double whose `close()` calls are counted. */
function countingTransport(): { transport: MarketEventTransport; closes: () => number } {
  const inner = new MemoryEventTransport();
  let closes = 0;
  return {
    closes: () => closes,
    transport: {
      transportId: inner.transportId,
      retention: inner.retention,
      publish: (stream, envelope) => inner.publish(stream, envelope),
      subscribe: (options) => inner.subscribe(options),
      streamMetrics: (stream) => inner.streamMetrics(stream),
      close: async (): Promise<void> => {
        closes += 1;
        await inner.close();
      },
    },
  };
}

function baseOptions(args: {
  readonly config: Record<string, unknown>;
  readonly connectTransport: GatewaySequenceOptions["connectTransport"];
  readonly host: GatewayHost;
  readonly lifetime: { acquired: number; released: number };
  readonly coinbaseSocketFactory?: CoinbaseSocketFactory;
}): GatewaySequenceOptions {
  const clock = new ManualGatewayClock();
  return {
    config: parseGatewayConfig(args.config),
    connectTransport: args.connectTransport,
    retentionEvents: 1_000,
    ports: {
      clock,
      ids: deterministicIdSource(),
      timers: new ManualGatewayTimers(clock),
      lifetime: {
        acquire: () => {
          args.lifetime.acquired += 1;
          return () => {
            args.lifetime.released += 1;
          };
        },
      },
      walFileSystem: createMemoryFileSystem(),
      coinbaseSocketFactory: args.coinbaseSocketFactory ?? new FakeCoinbaseSocketFactory(),
    },
    host: args.host,
  };
}

describe("runGatewaySequence transactional startup (R3-H1)", () => {
  it("a create() failure after the transport connected closes the transport exactly once and rethrows the original error", async () => {
    const host = recordingHost();
    const lifetime = { acquired: 0, released: 0 };
    const { transport, closes } = countingTransport();
    // The injected fatal: the Polymarket feed is configured but its socket
    // factory port is absent, which `create()` refuses AFTER the WAL journal
    // opened — the same post-connect window a WAL-open failure strikes in.
    const options = baseOptions({
      config: {
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: [MARKET],
        polymarket: { feedId: "pm-main" },
      },
      connectTransport: () => Promise.resolve(transport),
      host,
      lifetime,
    });

    await expect(runGatewaySequence(options)).rejects.toBeInstanceOf(GatewayStateError);

    expect(closes(), "the connected transport must be closed exactly once").toBe(1);
    expect(lifetime, "start() was never reached, so no lifetime handle moves").toEqual({
      acquired: 0,
      released: 0,
    });
    expect(host.lines.join("\n")).toContain(
      "startup failed before the gateway existed; closing the event-bus transport",
    );
    expect(host.shutdownHandlers, "no signal handler may exist on the fatal path").toHaveLength(0);
  });

  it("a start() failure after create() stops the gateway: transport closed exactly once, lifetime released exactly once", async () => {
    const host = recordingHost();
    const lifetime = { acquired: 0, released: 0 };
    const { transport, closes } = countingTransport();
    const injected = new Error("injected start() failure");
    const throwingFactory: CoinbaseSocketFactory = {
      connect: () => {
        throw injected;
      },
    };
    const options = baseOptions({
      config: {
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: [],
        coinbase: { productIds: ["BTC-USD"] },
      },
      connectTransport: () => Promise.resolve(transport),
      host,
      lifetime,
      coinbaseSocketFactory: throwingFactory,
    });

    await expect(runGatewaySequence(options)).rejects.toBe(injected);

    // `gateway.stop()` is the single disposal: WAL journal, transport, and
    // the lifetime anchor (already released by start()'s own catch — stop()
    // must not release it a second time).
    expect(closes(), "the connected transport must be closed exactly once").toBe(1);
    expect(lifetime).toEqual({ acquired: 1, released: 1 });
    expect(host.lines.join("\n")).toContain(
      "startup failed after the gateway was created; stopping it",
    );
    expect(host.shutdownHandlers).toHaveLength(0);
  });

  it("a create() failure behind the unavailable-transport fallback still runs the exactly-once cleanup and surfaces the create error", async () => {
    const host = recordingHost();
    const lifetime = { acquired: 0, released: 0 };
    const options = baseOptions({
      config: {
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: [MARKET],
        polymarket: { feedId: "pm-main" },
      },
      connectTransport: () => Promise.reject(new Error("connect refused (injected)")),
      host,
      lifetime,
    });

    // The rejection must be create()'s error, not anything from closing the
    // (no-op) fallback transport.
    await expect(runGatewaySequence(options)).rejects.toBeInstanceOf(GatewayStateError);
    const log = host.lines.join("\n");
    expect(log).toContain("the event bus was unreachable at startup");
    expect(log).toContain("closing the event-bus transport");
  });

  it("a successful startup closes nothing, registers shutdown once, and the returned gateway still stops cleanly", async () => {
    const host = recordingHost();
    const lifetime = { acquired: 0, released: 0 };
    const { transport, closes } = countingTransport();
    const options = baseOptions({
      config: {
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: [],
        coinbase: { productIds: ["BTC-USD"] },
      },
      connectTransport: () => Promise.resolve(transport),
      host,
      lifetime,
    });

    const gateway = await runGatewaySequence(options);

    expect(closes(), "startup must not close a healthy transport").toBe(0);
    expect(lifetime).toEqual({ acquired: 1, released: 0 });
    expect(host.shutdownHandlers).toHaveLength(1);
    expect(host.lines.join("\n")).toContain("data-gateway running: epoch");

    await gateway.stop();
    expect(closes(), "the signal-path disposal is the same single owner").toBe(1);
    expect(lifetime).toEqual({ acquired: 1, released: 1 });

    // Double stop stays exactly-once (the round-2 discipline, unchanged).
    await gateway.stop();
    expect(closes()).toBe(1);
    expect(lifetime).toEqual({ acquired: 1, released: 1 });
  });
});
