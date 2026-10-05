/**
 * `DataGateway.create()` is transactional over what it acquires (R3-H1).
 *
 * `create()` opens the WAL journal FIRST and only then builds the publisher,
 * dispatcher, directory, plan, and feeds — any of which can refuse its
 * configuration. At `45c231c` such a refusal escaped with the journal (an
 * open WAL writer) simply dropped. The rule now: `create()` either returns a
 * gateway that OWNS the journal (and closes it in `stop()`), or it closes the
 * journal itself before the error escapes — exactly one close, exactly one
 * owner, never both.
 *
 * The journal is created inside `create()`, so the only seam that can observe
 * its disposal without new production surface is the module's own
 * `GatewayJournal.open` — spied here to hand back a close-counting fake.
 */

import type { CoinbaseSocketFactory } from "@polymarket-bot/coinbase-adapter";
import { FakeCoinbaseSocketFactory } from "@polymarket-bot/coinbase-adapter/testing";
import type { MarketEventTransport } from "@polymarket-bot/event-bus";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseGatewayConfig } from "./config.js";
import type { DisposalFailure } from "./errors.js";
import { GatewayStateError } from "./errors.js";
import type { GatewayPorts } from "./gateway.js";
import { DataGateway } from "./gateway.js";
import { GatewayJournal } from "./journal.js";
import type { CleanupDeadline } from "./ports.js";
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

function ports(overrides: Partial<GatewayPorts> = {}): GatewayPorts {
  const clock = new ManualGatewayClock();
  return {
    clock,
    ids: deterministicIdSource(),
    timers: new ManualGatewayTimers(clock),
    walFileSystem: createMemoryFileSystem(),
    transport: new MemoryEventTransport(),
    coinbaseSocketFactory: new FakeCoinbaseSocketFactory(),
    ...overrides,
  };
}

/** A journal whose only observable duty here is exactly-once `close()`. */
function closeCountingJournal(): { journal: GatewayJournal; closes: () => number } {
  let closes = 0;
  const fake = {
    close: async (): Promise<void> => {
      closes += 1;
    },
    settle: async (): Promise<void> => {
      // Nothing queued: this fake never records.
    },
    tick: async (): Promise<void> => {},
  };
  return { journal: fake as unknown as GatewayJournal, closes: () => closes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DataGateway.create() transactionality (R3-H1)", () => {
  it("closes the journal it opened when feed construction refuses the configuration", async () => {
    const { journal, closes } = closeCountingJournal();
    const openSpy = vi.spyOn(GatewayJournal, "open").mockResolvedValue(journal);

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [MARKET],
      // Configured feed, MISSING port: #buildFeeds throws after the journal
      // opened — the same post-open window every later create() failure uses.
      polymarket: { feedId: "pm-main" },
    });

    await expect(DataGateway.create(config, ports())).rejects.toBeInstanceOf(GatewayStateError);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(closes(), "the opened journal must be closed exactly once").toBe(1);
  });

  it("transfers journal ownership to the gateway on success: create() closes nothing, stop() closes exactly once", async () => {
    const { journal, closes } = closeCountingJournal();
    vi.spyOn(GatewayJournal, "open").mockResolvedValue(journal);

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [],
      coinbase: { productIds: ["BTC-USD"] },
    });

    const gateway = await DataGateway.create(config, ports());
    expect(closes(), "a successful create() must not close its own journal").toBe(0);

    gateway.start();
    await gateway.stop();
    expect(closes()).toBe(1);

    await gateway.stop();
    expect(closes(), "double stop stays exactly-once").toBe(1);
  });
});

/** Records the round-5 M-2 capability's arms and cancels. */
function recordingDeadline(): {
  deadline: CleanupDeadline;
  arms: () => number;
  cancels: () => number;
} {
  let arms = 0;
  let cancels = 0;
  return {
    arms: () => arms,
    cancels: () => cancels,
    deadline: {
      arm: () => {
        arms += 1;
        return () => {
          cancels += 1;
        };
      },
    },
  };
}

describe("create()'s post-open cleanup under the deadline capability (round 5, M-2)", () => {
  it("arms the capability at failure-path entry and cancels it when the journal close completes", async () => {
    const { journal, closes } = closeCountingJournal();
    vi.spyOn(GatewayJournal, "open").mockResolvedValue(journal);
    const { deadline, arms, cancels } = recordingDeadline();

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [MARKET],
      polymarket: { feedId: "pm-main" },
    });

    // The ORIGINAL error still escapes; the bracket changes only its bound.
    await expect(
      DataGateway.create(config, ports(), { cleanupDeadline: deadline }),
    ).rejects.toBeInstanceOf(GatewayStateError);

    expect(arms(), "armed exactly once, when the failure path began").toBe(1);
    expect(cancels(), "cancelled exactly once, when the close completed").toBe(1);
    expect(closes(), "the journal is still closed exactly once").toBe(1);
  });

  it("never arms the capability on a successful create(): the deadline guards failure paths, not normal opens", async () => {
    const { journal, closes } = closeCountingJournal();
    vi.spyOn(GatewayJournal, "open").mockResolvedValue(journal);
    const { deadline, arms } = recordingDeadline();

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [],
      coinbase: { productIds: ["BTC-USD"] },
    });

    const gateway = await DataGateway.create(config, ports(), { cleanupDeadline: deadline });
    expect(arms(), "an ordinary startup must never be treated as a cleanup failure").toBe(0);

    await gateway.stop();
    expect(closes()).toBe(1);
    expect(arms(), "stop() is bounded by the sequence's own deadline, not this bracket").toBe(0);
  });

  it("a never-settling journal close keeps the armed capability uncancelled and create() pending", async () => {
    // The M-2 shape at the create() seam: the bracket stays armed (its expiry
    // — log plus forced exit — belongs to the sequence that supplied it, and
    // is exercised in run.test.ts and the subprocess regression).
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
    const { deadline, arms, cancels } = recordingDeadline();

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [MARKET],
      polymarket: { feedId: "pm-main" },
    });

    const creating = DataGateway.create(config, ports(), { cleanupDeadline: deadline });
    creating.catch(() => {
      // Never reached in this scenario; guards a future unhandled rejection.
    });

    await vi.waitFor(() => {
      expect(arms()).toBe(1);
    });
    const settledState = await Promise.race([
      creating.then(
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
    expect(cancels(), "a hung close must never cancel the bracket").toBe(0);
  });

  it("a journal close that REJECTS on the failure path cannot mask the original construction error (round 6, L-1)", async () => {
    // The round-6 LOW: create()'s catch awaited the close WITHOUT catching its
    // rejection, so a journal.close() that broke its own non-rejecting
    // contract replaced the post-open construction error (the reviewer's
    // probe: caught=CLOSE_REJECTION, isOriginal=false) — and the cleanup
    // failure was never separately classified.
    const rejectingJournal = {
      close: (): Promise<void> => Promise.reject(new Error("CLOSE_REJECTION (injected)")),
      settle: async (): Promise<void> => {},
      tick: async (): Promise<void> => {},
    };
    vi.spyOn(GatewayJournal, "open").mockResolvedValue(
      rejectingJournal as unknown as GatewayJournal,
    );
    const { deadline, arms, cancels } = recordingDeadline();
    const disposalFailures: DisposalFailure[] = [];

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [MARKET],
      // The post-open construction error: the feed is configured, its ports
      // are absent, so #buildFeeds throws AFTER the journal opened.
      polymarket: { feedId: "pm-main" },
    });

    let caught: unknown;
    await DataGateway.create(
      config,
      ports({
        observer: {
          onDisposalFailure: (failure) => {
            disposalFailures.push(failure);
          },
        },
      }),
      { cleanupDeadline: deadline },
    ).then(
      () => {
        throw new Error("create() must reject on the construction error");
      },
      (error: unknown) => {
        caught = error;
      },
    );

    // The ORIGINAL error surfaces; the close rejection does not replace it.
    expect(caught, "the original construction error must surface").toBeInstanceOf(
      GatewayStateError,
    );
    // The cleanup rejection is separately classified, not lost.
    expect(disposalFailures).toHaveLength(1);
    expect(disposalFailures[0]?.resource).toBe("wal-journal");
    expect(String((disposalFailures[0]?.error as Error).message)).toContain("CLOSE_REJECTION");
    // The bracket stays ARMED: a rejected close may still hold resources
    // (the round-4 design) — the supplied deadline, not the rejection,
    // bounds a wedged process.
    expect(arms(), "armed exactly once at failure-path entry").toBe(1);
    expect(cancels(), "a REJECTED close must never cancel the bracket").toBe(0);
  });
});

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

describe("DataGateway.stop() per-resource disposal isolation (round 4)", () => {
  it("still closes the journal and the transport when an earlier feed's socket close throws mid-stop", async () => {
    // The round-4 item-2 probe: an already-started feed whose socket `close()`
    // throws SYNCHRONOUSLY during `stop()`'s disposal sequence. Every one of
    // the socket feed teardowns ends in an unguarded `socket.close()`
    // (`PublicMarketFeed` via `#withSocket`, the Binance driver's
    // `this.#socket?.close()`, `CoinbaseConnectionManager.stop()`'s
    // `socket?.close()`; `RtdsTwapFeed` was a fourth until `RTDS-RETIRE`
    // removed the RTDS feed on 2026-10-05), so this ordering is reachable IN-REPO with nothing
    // contract-violating on the transport side. At `95c8aa9` the throw
    // abandoned every later disposal — `settle()`, `journal.close()`, and
    // `transport.close()` — leaving a connected transport referenced: the hang
    // shape, reached from inside the repository's own lifecycle.
    const { journal, closes: journalCloses } = closeCountingJournal();
    vi.spyOn(GatewayJournal, "open").mockResolvedValue(journal);
    const { transport, closes } = countingTransport();
    const throwingCloseSocketFactory: CoinbaseSocketFactory = {
      connect: () => ({
        send: () => {
          // Never exercised: the socket is torn down before any subscribe.
        },
        close: () => {
          throw new Error("injected socket close failure");
        },
      }),
    };

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [],
      coinbase: { productIds: ["BTC-USD"] },
    });
    const gateway = await DataGateway.create(
      config,
      ports({ transport, coinbaseSocketFactory: throwingCloseSocketFactory }),
    );
    gateway.start();

    let rejection: unknown;
    await gateway.stop().then(
      () => {
        throw new Error("stop() must reject when a disposal failed, not swallow it");
      },
      (error: unknown) => {
        rejection = error;
      },
    );

    // Per-resource isolation: the failed feed disposal must not abandon the
    // rest. Both remaining owned resources are released, exactly once each.
    expect(
      closes(),
      "the transport must still be closed after an earlier feed disposal threw",
    ).toBe(1);
    expect(
      journalCloses(),
      "the WAL journal must still be closed after an earlier feed disposal threw",
    ).toBe(1);
    // The failure is collected and surfaced, naming the resource, not lost.
    expect(rejection).toMatchObject({ code: "GATEWAY_DISPOSAL_FAILED" });
    expect(String((rejection as Error).message)).toContain("coinbase-manager");
    expect(String((rejection as Error).message)).toContain("injected socket close failure");

    // Double stop stays exactly-once (the round-2 discipline, unchanged).
    await gateway.stop();
    expect(closes()).toBe(1);
    expect(journalCloses()).toBe(1);
  });
});

describe("stop() initiates every independent disposal family (round 6, M-1)", () => {
  it("a throwing feed close plus a HANGING journal close: the transport disposal is still initiated and the feed failure stays observable", async () => {
    // The round-6 reviewer's combined probe. At d2fbbfa stop() awaited its
    // disposals SEQUENTIALLY — journal.close() had to settle before
    // transport.close() was even CALLED — so this combination force-exited
    // (in the composed process) with socket=1, journal=1, transport=0: the
    // transport cleanup was never attempted, and the collected feed-close
    // failure never reached GatewayDisposalError (stop() cannot settle while
    // the journal close hangs, so the aggregate error never exists).
    let journalCloseCalls = 0;
    const hangingCloseJournal = {
      close: (): Promise<void> => {
        journalCloseCalls += 1;
        return new Promise<void>(() => {
          // Deliberately never settles.
        });
      },
      settle: async (): Promise<void> => {},
      tick: async (): Promise<void> => {},
    };
    vi.spyOn(GatewayJournal, "open").mockResolvedValue(
      hangingCloseJournal as unknown as GatewayJournal,
    );
    const { transport, closes } = countingTransport();
    const throwingCloseSocketFactory: CoinbaseSocketFactory = {
      connect: () => ({
        send: () => {
          // Never exercised: the socket is torn down before any subscribe.
        },
        close: () => {
          throw new Error("injected socket close failure");
        },
      }),
    };
    const disposalFailures: DisposalFailure[] = [];

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [],
      coinbase: { productIds: ["BTC-USD"] },
    });
    const gateway = await DataGateway.create(
      config,
      ports({
        transport,
        coinbaseSocketFactory: throwingCloseSocketFactory,
        observer: {
          onDisposalFailure: (failure) => {
            disposalFailures.push(failure);
          },
        },
      }),
    );
    gateway.start();

    const stopping = gateway.stop();
    stopping.catch(() => {
      // Never reached in this scenario; guards a future unhandled rejection.
    });

    // THE M-1 PIN: the transport family is INITIATED — and completes — even
    // though the WAL family's close never settles.
    await vi.waitFor(() => {
      expect(
        closes(),
        "the transport disposal must be initiated despite the hanging journal close",
      ).toBe(1);
    });
    expect(journalCloseCalls, "the journal disposal was initiated too").toBe(1);

    // Evidence retention: the SETTLED feed-close failure is observable NOW,
    // through the observer — the aggregate GatewayDisposalError can never
    // carry it, because stop() cannot settle while the journal close hangs.
    expect(
      disposalFailures.map((failure) => failure.resource),
      "the collected feed-close failure must be reported at collection time",
    ).toContain("coinbase-manager");
    const feedFailure = disposalFailures.find(
      (failure) => failure.resource === "coinbase-manager",
    );
    expect(String((feedFailure?.error as Error).message)).toContain(
      "injected socket close failure",
    );

    // stop() itself stays pending on the hung family. In the composed
    // process the sequence's cleanup deadline bounds this and force-exits —
    // pinned in run.test.ts and the subprocess regression.
    const settledState = await Promise.race([
      stopping.then(
        () => "settled",
        () => "settled",
      ),
      new Promise<string>((resolvePending) => {
        setTimeout(() => {
          resolvePending("pending");
        }, 25);
      }),
    ]);
    expect(settledState, "stop() cannot settle while a disposal hangs").toBe("pending");
  });
});
