/**
 * ACCUMULATED BINDING OBLIGATIONS 2, 3, 4, 10 — connection identity, the
 * make-before-break directive vocabulary, failed-attempt accounting, and the
 * reconnect-loop escalation the gateway owns.
 *
 * OBLIGATION 2 is the defect class that appeared independently in ALL THREE
 * Wave-1B adapters: a frame or callback from a superseded, retired, or
 * unauthorized connection must never be relabeled as current-generation data.
 * The adapters now guard it; these tests prove the GATEWAY does not
 * reintroduce it at the assembly layer — the identity on a recorded raw frame
 * is the identity of the socket that produced it, and the refusal is visible
 * in counters.
 */

import { describe, expect, it } from "vitest";

import { binanceTradeFrame, buildHarness } from "./support/harness.js";
import { recordedFrames } from "./support/wal.js";

const BINANCE_CONFIG = {
  binance: {
    feedId: "binance-reference",
    symbols: ["BTCUSDT"],
    stalenessThresholdMs: 30_000,
    reconnect: { initialDelayMs: 1_000, maxDelayMs: 10_000, multiplier: 2 },
  },
} as const;

/** The documented `serverShutdown` notice: the venue asks for a new connection. */
function serverShutdownFrame(atMs: number): string {
  return JSON.stringify({ e: "serverShutdown", E: atMs });
}

describe("obligation 2 — connection identity is unique, registered, and never relabeled", () => {
  it("mints a unique connectionId per attempt and registers it before opening the socket", async () => {
    const harness = await buildHarness({ config: { ...BINANCE_CONFIG } });
    harness.gateway.start();

    const first = harness.binanceSockets.current;
    // The identity on the socket REQUEST is the one the feed authorized: the
    // driver called `feed.connecting(id)` before asking for this socket, and
    // the adapter accepts the OPEN only for the registered identity.
    first.open();
    first.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();
    expect(harness.gateway.metrics().binance?.rejectedSocketEvents).toBe(0);

    // A reconnect gets a NEW identity — never a reused one.
    first.serverClose();
    harness.timers.advance(5_000);
    await harness.settle();
    const second = harness.binanceSockets.current;
    expect(second.request.connectionId).not.toBe(first.request.connectionId);
    second.open();
    await harness.settle();

    const ids = harness.binanceSockets.sockets.map((socket) => socket.request.connectionId);
    expect(new Set(ids).size).toBe(ids.length);

    await harness.gateway.stop();
  });

  it("refuses a frame from a retired socket with an observable counter, never relabeling it", async () => {
    const harness = await buildHarness({ config: { ...BINANCE_CONFIG } });
    harness.gateway.start();
    const first = harness.binanceSockets.current;
    first.open();
    first.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();

    first.serverClose();
    harness.timers.advance(5_000);
    await harness.settle();
    const second = harness.binanceSockets.current;
    second.open();
    await harness.settle();
    const tradesBefore = harness.publishedOfType("ReferenceTradeObserved").length;

    // The DEAD socket delivers a buffered frame after its replacement is live.
    harness.clock.advance(10);
    first.message(binanceTradeFrame("BTCUSDT", 99, harness.clock.nowMs()));
    await harness.settle();

    // It was NOT normalized onto the current generation.
    expect(harness.publishedOfType("ReferenceTradeObserved")).toHaveLength(tradesBefore);

    // It was not lost either: the raw frame is in the WAL, labelled with the
    // connection that actually produced it (§8.3 — nothing silent).
    await harness.gateway.stop();
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    const lateFrame = frames.find((frame) => frame.payloadUtf8.includes('"t":99'));
    expect(lateFrame).toBeDefined();
    expect(lateFrame?.connectionId).toBe(first.request.connectionId);
    expect(lateFrame?.connectionId).not.toBe(second.request.connectionId);
  });

  it("escalates unauthorized-identity socket events past the configured threshold", async () => {
    const harness = await buildHarness({
      config: {
        binance: { ...BINANCE_CONFIG.binance, unauthorizedEventEscalationThreshold: 2 },
      },
    });
    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    await harness.settle();

    // A socket the driver never registered calls into the feed.
    socket.emit({ type: "CLOSE", connectionId: "forged-identity", code: 1006 });
    await harness.settle();
    expect(
      harness.incidents.some(
        (incident) => incident.reasonCode === "BINANCE_UNAUTHORIZED_EVENT_RATE",
      ),
    ).toBe(false);

    socket.emit({ type: "OPEN", connectionId: "forged-identity-2" });
    await harness.settle();

    const escalations = harness.incidents.filter(
      (incident) => incident.reasonCode === "BINANCE_UNAUTHORIZED_EVENT_RATE",
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.severity).toBe("PAGE");
    expect(harness.gateway.metrics().binance?.unauthorizedSocketEvents).toBe(2);
    // The live socket is untouched by the forgery.
    expect(harness.gateway.metrics().binance?.pendingConnectionId).toBeUndefined();

    await harness.gateway.stop();
  });
});

describe("obligations 3 and 4 — make-before-break directive and failed-attempt accounting", () => {
  it("counts a rejected PENDING close as a failed attempt and retries (obligation 4)", async () => {
    const harness = await buildHarness({ config: { ...BINANCE_CONFIG } });
    harness.gateway.start();
    const live = harness.binanceSockets.current;
    live.open();
    await harness.settle();

    // The venue asks for a new connection: the driver opens a REPLACEMENT
    // while the current socket is still live (make-before-break).
    live.message(serverShutdownFrame(harness.clock.nowMs()));
    await harness.settle();
    expect(harness.binanceSockets.sockets).toHaveLength(2);
    const replacement = harness.binanceSockets.current;
    expect(harness.gateway.metrics().binance?.pendingConnectionId).toBe(
      replacement.request.connectionId,
    );

    // The replacement dies before it opens. The feed REFUSES that close (it is
    // not disconnected — the live socket is fine) and emits no
    // FeedDisconnected, so the DRIVER must count the failed attempt itself.
    const reconnectsBefore = harness.gateway.metrics().binance?.reconnectsScheduled ?? 0;
    replacement.serverClose();
    await harness.settle();

    const metrics = harness.gateway.metrics().binance;
    expect(metrics?.pendingCloseFailures).toBe(1);
    expect(metrics?.reconnectsScheduled).toBe(reconnectsBefore + 1);
    // The attempt is retired, so the feed waits on nothing.
    expect(metrics?.pendingConnectionId).toBeUndefined();

    // The retry actually happens, with yet another fresh identity.
    harness.timers.advance(5_000);
    await harness.settle();
    expect(harness.binanceSockets.sockets).toHaveLength(3);
    const retry = harness.binanceSockets.current;
    expect(retry.request.connectionId).not.toBe(replacement.request.connectionId);

    await harness.gateway.stop();
  });

  it("waits for the outstanding attempt on NONE after a FeedDisconnected (obligation 3)", async () => {
    const harness = await buildHarness({ config: { ...BINANCE_CONFIG } });
    harness.gateway.start();
    const live = harness.binanceSockets.current;
    live.open();
    await harness.settle();

    // Make-before-break: a replacement is registered while the live socket is
    // still open.
    live.message(serverShutdownFrame(harness.clock.nowMs()));
    await harness.settle();
    expect(harness.binanceSockets.sockets).toHaveLength(2);

    // Now the LIVE socket closes first. The feed keeps the authorized
    // replacement, becomes CONNECTING, and directs NOTHING — the driver must
    // wait for the attempt it already started rather than registering a third
    // identity (which would retire the replacement and double-charge the
    // reconnect budget).
    live.serverClose();
    await harness.settle();

    expect(harness.gateway.metrics().binance?.waitedOnOutstandingAttempt).toBe(1);
    expect(harness.binanceSockets.sockets).toHaveLength(2);
    // No spurious "driver has no outstanding attempt" incident: it does.
    expect(
      harness.incidents.some(
        (incident) => incident.reasonCode === "BINANCE_DRIVER_NO_OUTSTANDING_ATTEMPT",
      ),
    ).toBe(false);

    // The replacement then opens normally and serves data.
    harness.binanceSockets.current.open();
    harness.clock.advance(10);
    harness.binanceSockets.current.message(
      binanceTradeFrame("BTCUSDT", 5, harness.clock.nowMs()),
    );
    await harness.settle();
    expect(harness.publishedOfType("ReferenceTradeObserved").length).toBeGreaterThanOrEqual(1);

    await harness.gateway.stop();
  });
});

describe("obligation 10 — the gateway owns the Coinbase reconnect-loop escalation", () => {
  it("escalates a persistent reconnect loop to a PAGE incident", async () => {
    const harness = await buildHarness({
      config: {
        coinbase: {
          feedId: "coinbase-reference",
          productIds: ["BTC-USD"],
          reconnectLoopEscalationThreshold: 3,
        },
        tickIntervalMs: 1_000,
      },
    });
    harness.gateway.start();

    // Every attempt dies before opening: the classic loop.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      harness.coinbaseSockets.current.dropConnection();
      harness.timers.advance(30_000);
      await harness.settle();
    }

    const loops = harness.incidents.filter(
      (incident) => incident.reasonCode === "COINBASE_RECONNECT_LOOP",
    );
    expect(loops.length).toBeGreaterThanOrEqual(1);
    expect(loops[0]?.severity).toBe("PAGE");
    expect(
      harness.gateway.metrics().coinbase?.reconnectLoopEscalations,
    ).toBeGreaterThanOrEqual(1);

    await harness.gateway.stop();
  });
});
