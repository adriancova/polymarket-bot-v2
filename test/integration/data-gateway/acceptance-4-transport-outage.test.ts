/**
 * WORKPLAN ACCEPTANCE 4 — "Redis outage stops publication but not WAL
 * recording."
 *
 * §4.2, stated as a failure boundary: "A Redis outage stops publication and
 * therefore halts trading, but the recorder continues writing WAL."
 *
 * Exercised through the WP-060 transport INTERFACE's failure injection, not
 * against a real Redis: the boundary being tested is the gateway's, and the
 * Redis implementation has its own Testcontainers suite. `infra/compose/
 * data-gateway/` carries the real server for local operation.
 *
 * Both §8.3 outage shapes are covered, because WP-060's consumer obligations
 * make them the same halt: `EVENT_BUS_UNAVAILABLE` (the server is gone) and
 * `EVENT_BUS_PUBLISH_QUEUE_FULL` (the producer queue is saturated — a HALT
 * signal, never a drop signal).
 */

import { describe, expect, it } from "vitest";

import { binanceTradeFrame, buildHarness } from "./support/harness.js";
import { recordedFrames } from "./support/wal.js";

const BINANCE_CONFIG = {
  binance: {
    feedId: "binance-reference",
    symbols: ["BTCUSDT"],
    stalenessThresholdMs: 30_000,
  },
} as const;

describe("acceptance 4 — a transport outage stops publication but not WAL recording", () => {
  it("keeps recording every raw frame to the WAL while publication is halted", async () => {
    const harness = await buildHarness({ config: { ...BINANCE_CONFIG } });
    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    socket.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();
    const publishedBefore = harness.published().length;
    expect(publishedBefore).toBeGreaterThan(0);

    // The transport goes away mid-run.
    harness.transport.setUnavailable(true);

    for (let index = 2; index <= 6; index += 1) {
      harness.clock.advance(100);
      socket.message(binanceTradeFrame("BTCUSDT", index, harness.clock.nowMs()));
    }
    await harness.settle();

    // Publication STOPPED: nothing new reached the stream.
    expect(harness.published()).toHaveLength(publishedBefore);
    expect(harness.halts).toContain("EVENT_BUS_UNAVAILABLE");
    expect(harness.gateway.metrics().publisher.halted).toBe(true);

    // RECORDING CONTINUED: every frame is in the WAL, in order, verbatim.
    await harness.gateway.stop();
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    expect(frames).toHaveLength(6);
    const tradeIds = frames.map(
      (frame) => (JSON.parse(frame.payloadUtf8) as { data: { t: number } }).data.t,
    );
    expect(tradeIds).toEqual([1, 2, 3, 4, 5, 6]);
    // Nothing was dropped anywhere on the recording path (§8.3).
    const metrics = harness.gateway.metrics();
    expect(metrics.wal.queue.messagesDropped).toBe(0);
    expect(metrics.binance?.framesRefusedByWal).toBe(0);
  });

  it("opens a PAGE incident naming the outage, delivered through the observer", async () => {
    const harness = await buildHarness({ config: { ...BINANCE_CONFIG } });
    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    await harness.settle();

    harness.transport.setUnavailable(true);
    socket.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();

    const outageIncidents = harness.incidents.filter(
      (incident) => incident.reasonCode === "GATEWAY_TRANSPORT_UNAVAILABLE",
    );
    expect(outageIncidents).toHaveLength(1);
    expect(outageIncidents[0]?.severity).toBe("PAGE");
    // The incident's own envelope cannot be published (the transport is the
    // thing that failed) — the observer is the delivery that still works.
    expect(outageIncidents[0]?.detail).toContain("the WAL keeps recording");

    await harness.gateway.stop();
  });

  it("treats EVENT_BUS_PUBLISH_QUEUE_FULL as a halt signal, not a drop signal", async () => {
    const harness = await buildHarness({ config: { ...BINANCE_CONFIG } });
    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    await harness.settle();
    const publishedBefore = harness.published().length;

    harness.transport.failNextPublishWithQueueFull();
    socket.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();

    expect(harness.halts).toContain("EVENT_BUS_PUBLISH_QUEUE_FULL");
    expect(
      harness.incidents.some(
        (incident) => incident.reasonCode === "GATEWAY_PUBLISH_QUEUE_FULL",
      ),
    ).toBe(true);
    // Halted, not dropped: publication stopped and stays stopped.
    expect(harness.gateway.metrics().publisher.halted).toBe(true);
    harness.clock.advance(100);
    socket.message(binanceTradeFrame("BTCUSDT", 2, harness.clock.nowMs()));
    await harness.settle();
    expect(harness.published()).toHaveLength(publishedBefore);

    // And the frames are all recorded regardless.
    await harness.gateway.stop();
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    expect(frames).toHaveLength(2);
  });

  it("does not resume publication mid-epoch when the transport comes back", async () => {
    const harness = await buildHarness({ config: { ...BINANCE_CONFIG } });
    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    await harness.settle();
    const publishedBefore = harness.published().length;

    harness.transport.setUnavailable(true);
    socket.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();

    // The server returns. Publication does NOT silently resume: the events
    // assigned during the outage were never in the stream, and a mid-epoch
    // resume would hand consumers a gap the transport cannot detect (its
    // resync arithmetic watches its own publication ordinals). A restart mints
    // a new epoch and a fresh snapshot obligation, which is the §7.1 path.
    harness.transport.setUnavailable(false);
    harness.clock.advance(100);
    socket.message(binanceTradeFrame("BTCUSDT", 2, harness.clock.nowMs()));
    await harness.settle();

    expect(harness.published()).toHaveLength(publishedBefore);
    expect(harness.gateway.metrics().publisher.suppressedWhileHalted).toBeGreaterThanOrEqual(1);

    await harness.gateway.stop();
    // Both frames recorded through the whole episode.
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    expect(frames).toHaveLength(2);
  });

  it("keeps recording across a WAL segment rotation while the transport is down", async () => {
    const harness = await buildHarness({
      config: {
        ...BINANCE_CONFIG,
        // Small segments so the outage spans a rotation.
        wal: { rootPath: "/wal", maxSegmentBytes: 2_048 },
      },
    });
    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    await harness.settle();

    harness.transport.setUnavailable(true);
    for (let index = 1; index <= 30; index += 1) {
      harness.clock.advance(10);
      socket.message(binanceTradeFrame("BTCUSDT", index, harness.clock.nowMs()));
      await harness.settle();
    }
    await harness.gateway.stop();

    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    expect(frames).toHaveLength(30);
    // Rotation happened, and every closed segment is manifested — so a
    // compactor can verify them (wal-format.md §2).
    const paths = Object.keys(harness.walFileSystem.snapshot());
    const segments = paths.filter((path) => path.endsWith(".wal.jsonl"));
    const manifests = paths.filter((path) => path.endsWith(".wal.manifest.json"));
    expect(segments.length).toBeGreaterThan(1);
    expect(manifests.length).toBe(segments.length);
  });
});

/**
 * ROUND-1 REVIEW FINDING H5 — the outage that starts BEFORE the process does.
 *
 * Acceptance 4 says a Redis outage stops publication but not WAL recording.
 * Round 1 honoured that mid-run and violated it at startup: `main.ts` awaited
 * `RedisStreamsEventTransport.connect()` before `DataGateway.create()`, before
 * the WAL was opened, and before any feed started, then exited on failure. A
 * recorder restarted during an outage therefore recorded NOTHING — and those
 * minutes of venue data are gone forever, while Redis comes back in seconds.
 *
 * `main.ts` now builds the gateway on `UnavailableEventTransport`, calls
 * `haltPublication`, and starts everything else; the harness models exactly
 * that sequence with `startupTransportFailure`.
 */
describe("acceptance 4 — a transport outage AT STARTUP still records", () => {
  it("records every frame to the WAL with publication halted from the first instant", async () => {
    const harness = await buildHarness({
      config: { ...BINANCE_CONFIG },
      startupTransportFailure: "ECONNREFUSED 127.0.0.1:6379 (injected)",
    });

    // Halted before a single feed has started — no submission was attempted.
    expect(harness.gateway.metrics().publisher.halted).toBe(true);
    expect(harness.halts).toContain("EVENT_BUS_UNAVAILABLE");
    const startupIncidents = harness.incidents.filter(
      (incident) => incident.reasonCode === "GATEWAY_TRANSPORT_UNAVAILABLE",
    );
    expect(startupIncidents).toHaveLength(1);
    expect(startupIncidents[0]?.severity).toBe("PAGE");
    expect(startupIncidents[0]?.detail).toContain("the WAL keeps recording");

    // And now the whole recorder runs, exactly as it would with a healthy bus.
    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    for (let index = 1; index <= 5; index += 1) {
      harness.clock.advance(100);
      socket.message(binanceTradeFrame("BTCUSDT", index, harness.clock.nowMs()));
    }
    await harness.settle();
    await harness.gateway.stop();

    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    expect(frames).toHaveLength(5);
    const tradeIds = frames.map(
      (frame) => (JSON.parse(frame.payloadUtf8) as { data: { t: number } }).data.t,
    );
    expect(tradeIds).toEqual([1, 2, 3, 4, 5]);
    // Nothing was dropped on the recording path, and nothing was published.
    const metrics = harness.gateway.metrics();
    expect(metrics.wal.queue.messagesDropped).toBe(0);
    expect(metrics.binance?.framesRefusedByWal).toBe(0);
    expect(metrics.publisher.published).toBe(0);
    expect(metrics.publisher.suppressedWhileHalted).toBeGreaterThan(0);
    // Every closed segment is manifested, so a compactor can verify the
    // recording made during the outage (wal-format.md §2).
    const paths = Object.keys(harness.walFileSystem.snapshot());
    const segments = paths.filter((path) => path.endsWith(".wal.jsonl"));
    const manifests = paths.filter((path) => path.endsWith(".wal.manifest.json"));
    expect(segments.length).toBeGreaterThan(0);
    expect(manifests.length).toBe(segments.length);
  });
});
