/**
 * ACCUMULATED BINDING OBLIGATIONS 1, 7, 9, 11 — dedup identity, durable
 * consumer identity across restarts, transport observations, and the WAL's
 * epoch handling at restart.
 *
 * - **1.** `(gatewayEpoch, ingestSeq)` is the dedup identity. Nothing the
 *   gateway publishes may carry a repeated identity, and a replay of an
 *   already-assigned identity is refused with a counter rather than
 *   double-published.
 * - **7.** The STREAM NAME — the half of the durable consumer key this
 *   producer-only process owns — is stable across restarts, because the
 *   transport keys checkpoints, resync state, and lag by `(stream,
 *   consumerId)`. Only the EPOCH changes on restart. The gateway mints no
 *   consumer id and never subscribes; that half is the trader's.
 * - **9.** `PRE_SUBSCRIPTION_FRAME` is a transport observation, not a
 *   data-quality incident about the market (WP-070 round-3 follow-up 1).
 * - **11.** WAL epoch handling at restart is consistent with `wal-format.md`
 *   §2: a restart mints a new epoch and a NEW per-epoch directory, so no
 *   directory ever spans two epochs and the WP-130 compactor's mixed-epoch
 *   refusal is never triggered by this gateway's own layout.
 */

import { describe, expect, it } from "vitest";

import { GatewayConfigurationError, parseGatewayConfig } from "@polymarket-bot/data-gateway";

import { binanceTradeFrame, buildHarness, polymarketBookFrame, MARKET } from "./support/harness.js";
import { recordedFrames, walEpochDirectories } from "./support/wal.js";

describe("obligation 1 — (gatewayEpoch, ingestSeq) is the dedup identity", () => {
  it("never publishes a repeated ordering identity across a busy run", async () => {
    const harness = await buildHarness({
      config: {
        binance: {
          feedId: "binance-reference",
          symbols: ["BTCUSDT"],
          stalenessThresholdMs: 30_000,
        },
        polymarket: { feedId: "polymarket-market" },
      },
    });
    harness.gateway.start();
    const binance = harness.binanceSockets.current;
    const polymarket = harness.polymarketSockets.current;
    binance.open();
    polymarket.open();
    for (let index = 1; index <= 20; index += 1) {
      harness.clock.advance(5);
      binance.message(binanceTradeFrame("BTCUSDT", index, harness.clock.nowMs()));
      polymarket.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    }
    await harness.settle();

    const identities = harness
      .published()
      .map((envelope) => `${envelope.gatewayEpoch}:${envelope.ingestSeq}`);
    expect(new Set(identities).size).toBe(identities.length);

    // The identity is also strictly increasing, which is what the transport's
    // own per-epoch ordering guard requires of a publisher.
    const sequences = harness.published().map((envelope) => BigInt(envelope.ingestSeq));
    for (let index = 1; index < sequences.length; index += 1) {
      const previous = sequences[index - 1];
      const current = sequences[index];
      if (previous === undefined || current === undefined) continue;
      expect(current > previous).toBe(true);
    }

    // Every raw frame has its own distinct identity in the same epoch space.
    await harness.gateway.stop();
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    const frameIdentities = frames.map((frame) => `${frame.gatewayEpoch}:${frame.ingestSeq}`);
    expect(new Set(frameIdentities).size).toBe(frameIdentities.length);
    // Raw frames and events share one total order: no identity is used twice.
    expect(new Set([...identities, ...frameIdentities]).size).toBe(
      identities.length + frameIdentities.length,
    );
  });
});

/**
 * ROUND-1 REVIEW L2 — what this package can and cannot prove about
 * obligation 7.
 *
 * Obligation 7 is "durable consumer ids are stable across restarts". A
 * consumer id is minted and checkpointed by a CONSUMER, and this process is
 * producer-only: it publishes and never subscribes, so it holds no consumer id
 * and its configuration schema has no field for one. The half of the durable
 * key it owns is the STREAM NAME, and that is exactly what these tests assert
 * — under a name that says so, rather than one that claims coverage the test
 * does not provide. The consumer half belongs to the trader (`WP-180`), and
 * the handoff's obligation table now says that instead of implying otherwise.
 */
describe("obligation 7 (gateway half) — the stream name is stable across restarts", () => {
  it("keeps the stream name fixed while the gateway epoch changes on restart", async () => {
    const config = {
      binance: {
        feedId: "binance-reference",
        symbols: ["BTCUSDT"],
        stalenessThresholdMs: 30_000,
      },
    } as const;

    const first = await buildHarness({ config: { ...config }, idSeed: 1 });
    first.gateway.start();
    first.binanceSockets.current.open();
    first.binanceSockets.current.message(binanceTradeFrame("BTCUSDT", 1, first.clock.nowMs()));
    await first.settle();
    await first.gateway.stop();

    // A restart: a new process lifetime, hence a new epoch (§7.1).
    const second = await buildHarness({ config: { ...config }, idSeed: 2 });
    second.gateway.start();
    second.binanceSockets.current.open();
    second.binanceSockets.current.message(
      binanceTradeFrame("BTCUSDT", 1, second.clock.nowMs()),
    );
    await second.settle();
    await second.gateway.stop();

    // The stream a consumer subscribes to is configuration, and it did not
    // move — so a restarted trader resumes its stored checkpoint rather than
    // finding a stream nobody has a position in.
    expect(second.config.streamName).toBe(first.config.streamName);
    // The epoch DID change: one process, one epoch (ADR-002 §2.1).
    expect(second.gateway.gatewayEpoch).not.toBe(first.gateway.gatewayEpoch);
    // And the new epoch restarts ingestSeq at 1, which is not a regression —
    // the epoch is the other half of the ordering identity.
    expect(second.published()[0]?.ingestSeq).toBe("1");
  });

  it("holds no consumer id at all, because it never subscribes", async () => {
    const harness = await buildHarness({
      config: {
        binance: {
          feedId: "binance-reference",
          symbols: ["BTCUSDT"],
          stalenessThresholdMs: 30_000,
        },
      },
    });
    harness.gateway.start();
    harness.binanceSockets.current.open();
    harness.binanceSockets.current.message(
      binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()),
    );
    await harness.settle();
    expect(harness.published().length).toBeGreaterThan(0);

    // Producer-only, for the whole life of the process: the transport double
    // counts subscriptions and saw none. So there is no consumer checkpoint,
    // resync state, or lag here to keep stable, and the obligation-7 claim
    // this package can make is the stream-name one above — no more.
    expect(harness.transport.subscribeCalls).toBe(0);
    // Nor is there anywhere to put a consumer id: the strict schema has no
    // such field, so a configuration that tried to set one fails loudly.
    expect(Object.keys(harness.config)).not.toContain("consumerId");
    expect(() =>
      parseGatewayConfig({
        streamName: "market-events",
        wal: { rootPath: "/wal" },
        markets: [],
        consumerId: "trader-1",
        binance: {
          feedId: "binance-reference",
          symbols: ["BTCUSDT"],
          stalenessThresholdMs: 30_000,
        },
      }),
    ).toThrow(GatewayConfigurationError);

    await harness.gateway.stop();
  });
});

describe("obligation 11 — WAL epoch handling at restart (wal-format.md §2)", () => {
  it("writes each epoch into its own directory, so no directory spans two epochs", async () => {
    const config = {
      binance: {
        feedId: "binance-reference",
        symbols: ["BTCUSDT"],
        stalenessThresholdMs: 30_000,
      },
    } as const;

    // Two gateways sharing one WAL ROOT — the restart case, and exactly the
    // layout a compactor would meet on disk.
    const first = await buildHarness({ config: { ...config }, idSeed: 1 });
    first.gateway.start();
    first.binanceSockets.current.open();
    first.binanceSockets.current.message(binanceTradeFrame("BTCUSDT", 1, first.clock.nowMs()));
    await first.settle();
    await first.gateway.stop();

    const second = await buildHarness({
      config: { ...config },
      idSeed: 2,
      walFileSystem: first.walFileSystem,
    });
    second.gateway.start();
    second.binanceSockets.current.open();
    second.binanceSockets.current.message(
      binanceTradeFrame("BTCUSDT", 1, second.clock.nowMs()),
    );
    await second.settle();
    await second.gateway.stop();

    // Two epochs on disk, in two SEPARATE directories.
    const epochs = walEpochDirectories(first.walFileSystem);
    expect(epochs).toHaveLength(2);
    expect(new Set(epochs)).toEqual(
      new Set([first.gateway.gatewayEpoch, second.gateway.gatewayEpoch]),
    );

    // Every frame in each directory carries that directory's one epoch, so a
    // compactor never meets the mixed-epoch input it refuses (WP-130 M1).
    for (const epoch of epochs) {
      const frames = recordedFrames(first.walFileSystem, epoch);
      expect(frames.length).toBeGreaterThan(0);
      expect(new Set(frames.map((frame) => frame.gatewayEpoch))).toEqual(new Set([epoch]));
    }
  });
});

describe("obligation 9 — PRE_SUBSCRIPTION_FRAME is a transport observation", () => {
  it("counts a pre-subscription frame without opening a market data-quality incident", async () => {
    const harness = await buildHarness({
      config: { polymarket: { feedId: "polymarket-market" } },
    });
    // A transport that is already connected: it reports `onOpen` and delivers
    // a frame from INSIDE the factory call, before the feed has a handle or
    // has written its subscription.
    harness.polymarketSockets.duringConnect = (socket) => {
      socket.open();
      socket.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    };
    harness.gateway.start();
    await harness.settle();

    const metrics = harness.gateway.metrics().polymarket;
    expect(metrics?.transportObservations).toBeGreaterThanOrEqual(1);
    // It said something about the SOCKET, not about the venue's data: no
    // incident was opened for it.
    expect(
      harness.incidents.some((incident) => incident.reasonCode === "PRE_SUBSCRIPTION_FRAME"),
    ).toBe(false);
    expect(metrics?.problemsRouted).toBe(0);

    // The frame was still recorded raw (§9.1) — a transport observation is not
    // a licence to lose the bytes.
    await harness.gateway.stop();
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });
});
