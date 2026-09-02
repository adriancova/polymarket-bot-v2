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
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseGatewayConfig } from "./config.js";
import { GatewayConfigurationError, GatewayStateError } from "./errors.js";
import { GatewayJournal } from "./journal.js";
import type { GatewayHost, GatewaySequenceOptions } from "./run.js";
import {
  DEFAULT_CLEANUP_DEADLINE_MS,
  MAX_CLEANUP_DEADLINE_MS,
  MIN_CLEANUP_DEADLINE_MS,
  parseCleanupDeadlineMs,
  runGatewaySequence,
} from "./run.js";
import {
  deterministicIdSource,
  ManualGatewayClock,
  ManualGatewayTimers,
  MemoryEventTransport,
} from "./testing/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** One armed cleanup deadline, as the fake host recorded it (round 4). */
interface RecordedDeadline {
  readonly delayMs: number;
  /** Simulates the referenced timer firing. */
  readonly expire: () => void;
  readonly cancelled: () => boolean;
}

interface RecordingHost extends GatewayHost {
  readonly lines: string[];
  readonly exitCodes: number[];
  readonly shutdownHandlers: Array<() => void>;
  readonly deadlines: RecordedDeadline[];
  readonly forcedExits: number[];
}

function recordingHost(): RecordingHost {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  const shutdownHandlers: Array<() => void> = [];
  const deadlines: RecordedDeadline[] = [];
  const forcedExits: number[] = [];
  return {
    lines,
    exitCodes,
    shutdownHandlers,
    deadlines,
    forcedExits,
    logError: (line, detail) => {
      lines.push(detail === undefined ? line : `${line} :: ${String(detail)}`);
    },
    registerShutdownSignals: (handler) => {
      shutdownHandlers.push(handler);
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
    armCleanupDeadline: (delayMs, onExpiry) => {
      let cancelled = false;
      deadlines.push({
        delayMs,
        expire: onExpiry,
        cancelled: () => cancelled,
      });
      return () => {
        cancelled = true;
      };
    },
    forceExit: (code) => {
      forcedExits.push(code);
    },
  };
}

/**
 * A CONNECTED transport double whose `close()` calls are counted.
 *
 * `closeRejects` models the round-4 finding's transport: `close()` rejects
 * before releasing anything, standing where the reviewer's reference-owning
 * probe put its handle-holding close.
 */
function countingTransport(
  options: { readonly closeRejects?: boolean } = {},
): { transport: MarketEventTransport; closes: () => number } {
  const inner = new MemoryEventTransport();
  let closes = 0;
  return {
    closes: () => closes,
    transport: {
      transportId: inner.transportId,
      retention: inner.retention,
      publish: (stream, envelope) => inner.publish(stream, envelope),
      subscribe: (subscribeOptions) => inner.subscribe(subscribeOptions),
      streamMetrics: (stream) => inner.streamMetrics(stream),
      close: async (): Promise<void> => {
        closes += 1;
        if (options.closeRejects === true) {
          throw new Error("injected transport close rejection (handle still referenced)");
        }
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
  readonly cleanupDeadlineMs?: number;
}): GatewaySequenceOptions {
  const clock = new ManualGatewayClock();
  return {
    config: parseGatewayConfig(args.config),
    connectTransport: args.connectTransport,
    retentionEvents: 1_000,
    ...(args.cleanupDeadlineMs === undefined
      ? {}
      : { cleanupDeadlineMs: args.cleanupDeadlineMs }),
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

describe("the cleanup hard-deadline (round 4)", () => {
  it("a fatal cleanup whose transport close rejects leaves the deadline armed; its expiry logs and forces exit 1", async () => {
    // The round-4 finding, in-process: at `95c8aa9` this cleanup failure was
    // only logged and the original error rethrown to a handler that sets
    // `process.exitCode = 1` — with the rejecting close still holding its
    // referenced handle, that was the hang. The deadline is the fallback.
    const host = recordingHost();
    const lifetime = { acquired: 0, released: 0 };
    const { transport, closes } = countingTransport({ closeRejects: true });
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
      cleanupDeadlineMs: 1_234,
    });

    // The ORIGINAL error still escapes — the cleanup failure never masks it.
    await expect(runGatewaySequence(options)).rejects.toBeInstanceOf(GatewayStateError);

    expect(closes(), "the close was attempted").toBe(1);
    expect(host.lines.join("\n")).toContain("fatal-path transport close failed");
    // Round 5 (M-2): TWO brackets now exist on this path — create()'s own,
    // around its completed journal close (armed then cancelled), and the
    // sequence's, around the rejecting transport close (armed, kept).
    expect(host.deadlines, "both cleanup brackets armed at their entries").toHaveLength(2);
    expect(
      host.deadlines[0]?.cancelled(),
      "create()'s bracket was cancelled when its journal close completed",
    ).toBe(true);
    expect(host.deadlines[1]?.delayMs).toBe(1_234);
    expect(
      host.deadlines[1]?.cancelled(),
      "a cleanup that FAILED must not clear its deadline — the handle may still be referenced",
    ).toBe(false);
    expect(host.forcedExits, "the deadline has not fired yet").toEqual([]);

    // The referenced timer fires: the expiry logs and forces the exit.
    host.deadlines[1]?.expire();
    expect(host.forcedExits).toEqual([1]);
    expect(host.lines.join("\n")).toContain("cleanup deadline");
  });

  it("a fatal cleanup that completes clears its deadline and forces nothing", async () => {
    // Test (c), in-process: the deadline must be a fallback, not a tax on the
    // clean fatal path — armed, then CLEARED, with no forced exit and no
    // deadline log (the round-2 stray-referenced-timer lesson).
    const host = recordingHost();
    const lifetime = { acquired: 0, released: 0 };
    const { transport, closes } = countingTransport();
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

    expect(closes()).toBe(1);
    // Round 5 (M-2): create()'s bracket around its journal close, then the
    // sequence's around the transport close — BOTH completed, BOTH cleared.
    expect(host.deadlines).toHaveLength(2);
    expect(
      host.deadlines[0]?.cancelled(),
      "a completed cleanup must clear its deadline (create()'s bracket)",
    ).toBe(true);
    expect(
      host.deadlines[1]?.cancelled(),
      "a completed cleanup must clear its deadline (the sequence's bracket)",
    ).toBe(true);
    expect(host.forcedExits).toEqual([]);
    expect(host.lines.join("\n")).not.toContain("cleanup deadline");
  });

  it("the shutdown path arms the same deadline and clears it when stop() completes (exit code 0 untouched)", async () => {
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

    await runGatewaySequence(options);
    expect(host.deadlines, "no deadline exists while the gateway runs").toHaveLength(0);

    host.shutdownHandlers[0]?.();
    expect(host.deadlines, "the shutdown path arms the deadline at entry").toHaveLength(1);
    await vi.waitFor(() => {
      expect(host.exitCodes).toEqual([0]);
    });
    expect(closes()).toBe(1);
    expect(
      host.deadlines[0]?.cancelled(),
      "a completed stop() must clear the shutdown deadline before the exit code is set",
    ).toBe(true);
    expect(host.forcedExits).toEqual([]);
  });

  it("a stop() that rejects during shutdown leaves the deadline armed; its expiry forces exit 1", async () => {
    const host = recordingHost();
    const lifetime = { acquired: 0, released: 0 };
    const { transport, closes } = countingTransport({ closeRejects: true });
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

    await runGatewaySequence(options);
    host.shutdownHandlers[0]?.();
    await vi.waitFor(() => {
      expect(host.exitCodes).toEqual([1]);
    });

    expect(closes(), "the close was attempted (stop() isolates disposals)").toBe(1);
    // stop()'s per-resource isolation released everything else; the lifetime
    // anchor is gone even though the transport close failed.
    expect(lifetime).toEqual({ acquired: 1, released: 1 });
    expect(host.lines.join("\n")).toContain("data-gateway: shutdown error");
    expect(host.deadlines).toHaveLength(1);
    expect(host.deadlines[0]?.cancelled(), "a failed stop() must not clear the deadline").toBe(
      false,
    );

    host.deadlines[0]?.expire();
    expect(host.forcedExits).toEqual([1]);
  });
});

describe("the cleanup deadline is validated fail-closed (round 5, M-1)", () => {
  // The finding: `Number(env)` accepted NaN, -5, 0, Infinity, and 2147483648,
  // and `run.ts` forwarded the result straight to setTimeout — Node coerces
  // every one to an effectively immediate deadline, so a LEGITIMATE 50 ms
  // transport close was force-exited after ~4 ms under NaN while 200
  // completed normally. Both seams now refuse everything outside the domain.

  it("the env seam refuses every hostile value with the one-line typed refusal", () => {
    // The five reviewer probes, a float, a non-numeric string — plus the
    // strictness pins fail-closed implies: whitespace, sign, scientific
    // notation, and below-minimum values are all refused too.
    const hostile = [
      "NaN",
      "-5",
      "0",
      "Infinity",
      "2147483648",
      "1500.5",
      "abc",
      " 200",
      "+200",
      "1e3",
      "99",
    ];
    for (const value of hostile) {
      let thrown: unknown;
      try {
        parseCleanupDeadlineMs(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${JSON.stringify(value)} must be refused`).toBeInstanceOf(
        GatewayConfigurationError,
      );
      const message = (thrown as Error).message;
      expect(message, "the refusal names the variable").toContain("GATEWAY_CLEANUP_DEADLINE_MS");
      expect(message, "the refusal names the offending value").toContain(
        `got ${JSON.stringify(value)}`,
      );
      expect(message, "the refusal names the permitted domain").toContain(
        "from 100 to 2147483647",
      );
    }
  });

  it("the env seam accepts the domain and pins unset-or-empty as the default", () => {
    // Decided and pinned: unset and empty both mean the default — the
    // package's established treatment of an empty environment value as
    // absent (`GATEWAY_CONFIG_PATH`).
    expect(parseCleanupDeadlineMs(undefined)).toBe(DEFAULT_CLEANUP_DEADLINE_MS);
    expect(parseCleanupDeadlineMs("")).toBe(DEFAULT_CLEANUP_DEADLINE_MS);
    expect(parseCleanupDeadlineMs("100")).toBe(MIN_CLEANUP_DEADLINE_MS);
    expect(parseCleanupDeadlineMs("2147483647")).toBe(MAX_CLEANUP_DEADLINE_MS);
    expect(parseCleanupDeadlineMs("10000")).toBe(10_000);
  });

  it("the sequence seam refuses an out-of-domain option BEFORE any resource is acquired", async () => {
    // A programmatic caller bypasses the env parser, so the sequence itself
    // fails closed: no transport connect, no deadline, no signal handler —
    // nothing exists yet when the typed refusal escapes.
    const hostile = [Number.NaN, -5, 0, Number.POSITIVE_INFINITY, 2_147_483_648, 1500.5, 99];
    for (const value of hostile) {
      const host = recordingHost();
      const lifetime = { acquired: 0, released: 0 };
      const { transport, closes } = countingTransport();
      const connect = vi.fn(() => Promise.resolve(transport));
      const options = baseOptions({
        config: {
          streamName: "market-events",
          wal: { rootPath: "/wal" },
          markets: [],
          coinbase: { productIds: ["BTC-USD"] },
        },
        connectTransport: connect,
        host,
        lifetime,
        cleanupDeadlineMs: value,
      });

      await expect(
        runGatewaySequence(options),
        `${String(value)} must be refused`,
      ).rejects.toBeInstanceOf(GatewayConfigurationError);

      expect(connect, `${String(value)}: nothing may be acquired`).not.toHaveBeenCalled();
      expect(closes()).toBe(0);
      expect(host.deadlines, `${String(value)}: no deadline may arm`).toHaveLength(0);
      expect(host.shutdownHandlers).toHaveLength(0);
      expect(lifetime).toEqual({ acquired: 0, released: 0 });
    }
  });
});

describe("create()'s internal cleanup runs under the deadline (round 5, M-2)", () => {
  it("a never-settling journal close after a post-open construction error: the deadline armed inside create() fires, logs, and forces exit 1", async () => {
    // The reviewer's regression, in-process. At 767ecfd `create()` awaited
    // `journal.close()` BEFORE rejecting, and the sequence armed its deadline
    // only in its catch — so a close that never settled left the sequence
    // pending forever: deadline arms 0, transport closes 0, and a connected
    // transport's referenced handle would hold the process indefinitely.
    const neverSettlingJournal = {
      close: (): Promise<void> =>
        new Promise<void>(() => {
          // Deliberately never settles.
        }),
      settle: async (): Promise<void> => {},
      tick: async (): Promise<void> => {},
    };
    vi.spyOn(GatewayJournal, "open").mockResolvedValue(
      neverSettlingJournal as unknown as GatewayJournal,
    );

    const host = recordingHost();
    const lifetime = { acquired: 0, released: 0 };
    const { transport, closes } = countingTransport();
    const options = baseOptions({
      config: {
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: [MARKET],
        // The post-open construction refusal: the feed is configured but its
        // ports are absent, so #buildFeeds throws AFTER the journal opened.
        polymarket: { feedId: "pm-main" },
      },
      connectTransport: () => Promise.resolve(transport),
      host,
      lifetime,
      cleanupDeadlineMs: 1_500,
    });

    // The sequence CANNOT settle while create()'s close hangs — that is the
    // finding. Deliberately not awaited; it stays pending past this test.
    const sequence = runGatewaySequence(options);
    sequence.catch(() => {
      // Never reached in this scenario; guards a future unhandled rejection.
    });

    await vi.waitFor(() => {
      expect(host.deadlines, "create() must arm the deadline at failure-path entry").toHaveLength(
        1,
      );
    });
    expect(host.deadlines[0]?.delayMs).toBe(1_500);
    expect(
      host.deadlines[0]?.cancelled(),
      "a close that never settles must never cancel its deadline",
    ).toBe(false);
    expect(closes(), "the sequence catch never ran, so the transport is untouched").toBe(0);
    expect(host.forcedExits).toEqual([]);

    // The sequence is pending — create() never rejected.
    const settledState = await Promise.race([
      sequence.then(
        () => "settled",
        () => "settled",
      ),
      new Promise<string>((resolvePending) => {
        setTimeout(() => {
          resolvePending("pending");
        }, 25);
      }),
    ]);
    expect(settledState, "create() cannot settle while its close hangs").toBe("pending");

    // The referenced timer fires: forced nonzero exit, deadline log present.
    host.deadlines[0]?.expire();
    expect(host.forcedExits).toEqual([1]);
    expect(host.lines.join("\n")).toContain("cleanup deadline");
    expect(host.lines.join("\n")).toContain("fatal-startup");
  });
});
