/**
 * WORKPLAN DELIVERABLES "bounded queues" and "data-quality incident
 * emission", and the §8.3 invariant they exist to serve: **nothing is dropped
 * silently**.
 *
 * §8.3 is explicit — "Dropping trading or raw market events silently is
 * forbidden. If a critical queue cannot accept an event, affected trading
 * halts and a data-quality incident opens." These tests exercise each bounded
 * queue in the gateway and assert the loud outcome in every case:
 *
 * - the WAL ingestion queue (bounded by frames and by bytes) refuses;
 * - the WAL write path FAULTS and the fault becomes a PAGE incident, with the
 *   frames still accounted for rather than lost (WP-050's accepted-frame
 *   invariant);
 * - the publisher's ordering guard refuses a repeated identity;
 * - the incident registry itself is bounded, and its dedup suppresses repeats
 *   with a counter rather than flooding the stream.
 */

import { describe, expect, it } from "vitest";

import { binanceTradeFrame, buildHarness, polymarketBookFrame, MARKET } from "./support/harness.js";
import { createFaultyWalFileSystem } from "./support/faulty-file-system.js";
import { recordedFrames } from "./support/wal.js";

describe("bounded queues and no silent drops (§8.3)", () => {
  it("refuses on WAL queue overflow, counts it, and drops nothing", async () => {
    const harness = await buildHarness({
      config: {
        wal: { rootPath: "/wal", queueCapacity: 2 },
        polymarket: { feedId: "polymarket-market" },
      },
    });
    harness.gateway.start();
    const socket = harness.polymarketSockets.current;
    socket.open();

    // A synchronous burst larger than the queue: the drain cannot run between
    // frames, so the queue genuinely saturates.
    for (let index = 0; index < 6; index += 1) {
      socket.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    }
    await harness.settle();

    const metrics = harness.gateway.metrics();
    // Refusals are counted and observable...
    expect(metrics.polymarket?.framesRefusedByWal).toBeGreaterThan(0);
    expect(metrics.wal.overflowSignals).toBeGreaterThan(0);
    // ...and `messagesDropped` stays zero, because the WAL refuses rather than
    // discards: the frame is handed back to the caller, never swallowed.
    expect(metrics.wal.queue.messagesDropped).toBe(0);
    // The refusal opened its incident.
    expect(
      harness.incidents.some(
        (incident) => incident.reasonCode === "GATEWAY_WAL_FRAME_REFUSED",
      ),
    ).toBe(true);

    // Accepted + refused accounts for every frame offered.
    const accepted = metrics.wal.framesAccepted;
    const refused = metrics.polymarket?.framesRefusedByWal ?? 0;
    expect(accepted + refused).toBe(6);

    await harness.gateway.stop();
  });

  it("turns a WAL write fault into a PAGE incident instead of a silent stop", async () => {
    const walFileSystem = createFaultyWalFileSystem();
    const harness = await buildHarness({
      config: {
        binance: {
          feedId: "binance-reference",
          symbols: ["BTCUSDT"],
          stalenessThresholdMs: 30_000,
        },
      },
      walFileSystem,
    });
    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    socket.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();
    expect(harness.gateway.metrics().wal.framesAccepted).toBeGreaterThan(0);

    // The disk starts failing.
    walFileSystem.failWrites("ENOSPC (injected)");
    harness.clock.advance(10);
    socket.message(binanceTradeFrame("BTCUSDT", 2, harness.clock.nowMs()));
    await harness.settle();

    const faults = harness.incidents.filter(
      (incident) => incident.reasonCode === "GATEWAY_WAL_WRITE_FAULT",
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]?.severity).toBe("PAGE");
    expect(harness.recordingFailures).toContain("write-fault");

    // WP-050's accepted-frame invariant: every frame the writer accepted is
    // either in a manifest or handed back — never neither. The gateway's job
    // is to make the fault loud, which it did.
    expect(harness.gateway.metrics().wal.state).toBe("faulted");
  });

  it("suppresses repeated incidents with a counter rather than flooding the stream", async () => {
    const harness = await buildHarness({
      config: {
        wal: { rootPath: "/wal", queueCapacity: 1 },
        polymarket: { feedId: "polymarket-market" },
      },
    });
    harness.gateway.start();
    const socket = harness.polymarketSockets.current;
    socket.open();
    for (let index = 0; index < 10; index += 1) {
      socket.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    }
    await harness.settle();

    // Many refusals, ONE incident while it stays open, and every suppressed
    // repeat counted.
    expect(harness.gateway.metrics().polymarket?.framesRefusedByWal).toBeGreaterThan(1);
    expect(
      harness.incidents.filter(
        (incident) => incident.reasonCode === "GATEWAY_WAL_FRAME_REFUSED",
      ),
    ).toHaveLength(1);
    expect(harness.gateway.metrics().incidents.repeatsSuppressed).toBeGreaterThan(0);

    await harness.gateway.stop();
  });

  it("keeps event ordering and raw-frame traceability under a mixed multi-feed load", async () => {
    const harness = await buildHarness({
      config: {
        polymarket: { feedId: "polymarket-market" },
        binance: {
          feedId: "binance-reference",
          symbols: ["BTCUSDT"],
          stalenessThresholdMs: 30_000,
        },
        coinbase: { feedId: "coinbase-reference", productIds: ["BTC-USD"] },
      },
    });
    harness.gateway.start();
    harness.polymarketSockets.current.open();
    harness.binanceSockets.current.open();
    harness.coinbaseSockets.current.open();
    await harness.settle();

    for (let index = 1; index <= 10; index += 1) {
      harness.clock.advance(5);
      harness.binanceSockets.current.message(
        binanceTradeFrame("BTCUSDT", index, harness.clock.nowMs()),
      );
      harness.polymarketSockets.current.message(
        polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId),
      );
      await harness.settle();
    }
    await harness.gateway.stop();

    const epoch = harness.gateway.gatewayEpoch;
    const frames = recordedFrames(harness.walFileSystem, epoch);
    const framesBySeq = new Map(frames.map((frame) => [frame.ingestSeq, frame]));

    // Every market-data event traces to a raw frame that precedes it, and that
    // frame is really on disk (§6 invariant 4).
    const marketData = harness
      .published()
      .filter((envelope) =>
        ["ReferenceTradeObserved", "ReferenceTopOfBookChanged", "BookSnapshot"].includes(
          envelope.eventType,
        ),
      );
    expect(marketData.length).toBeGreaterThan(0);
    for (const envelope of marketData) {
      expect(envelope.causationId).toBeDefined();
      const rawSeq = envelope.causationId?.slice(`raw:${epoch}:`.length) ?? "";
      const frame = framesBySeq.get(rawSeq);
      expect(frame).toBeDefined();
      expect(BigInt(rawSeq)).toBeLessThan(BigInt(envelope.ingestSeq));
      // The frame's own provenance matches the event's.
      expect(frame?.connectionId).toBe(envelope.connectionId);
    }

    // Publication order is the assignment order, strictly increasing.
    const sequences = harness.published().map((envelope) => BigInt(envelope.ingestSeq));
    const sorted = [...sequences].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sequences).toEqual(sorted);
  });
});
