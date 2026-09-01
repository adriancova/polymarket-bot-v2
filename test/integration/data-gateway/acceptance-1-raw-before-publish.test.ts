/**
 * WORKPLAN ACCEPTANCE 1 — "Raw frame is enqueued before normalized
 * publication."
 *
 * Asserted three independent ways, because the criterion is an ORDERING and an
 * ordering is easy to satisfy by accident and easy to break silently:
 *
 * 1. **At publish time.** The transport's publish hook reads the WAL's
 *    accepted-frame count at the instant a normalized event is submitted; it
 *    must already include the frame that event derives from.
 * 2. **In the identities.** The raw frame's `(gatewayEpoch, ingestSeq)` is
 *    strictly LOWER than every event derived from it, and the event's
 *    `causationId` names that exact raw record (§6 invariant 4).
 * 3. **When recording is refused.** If the WAL cannot accept the frame, the
 *    derived market-data events do NOT enter the stream — publishing data
 *    whose raw evidence was refused is exactly what this criterion forbids —
 *    and a PAGE incident opens instead (§8.3).
 */

import { describe, expect, it } from "vitest";

import {
  binanceTradeFrame,
  buildHarness,
  polymarketBookFrame,
  MARKET,
} from "./support/harness.js";
import { recordedFrames } from "./support/wal.js";

describe("acceptance 1 — raw frame is enqueued before normalized publication", () => {
  it("has the raw frame accepted by the WAL at the instant the derived event is published", async () => {
    const harness = await buildHarness({
      config: {
        binance: {
          feedId: "binance-reference",
          symbols: ["BTCUSDT"],
          stalenessThresholdMs: 30_000,
        },
      },
    });

    const acceptedAtPublish: number[] = [];
    harness.transport.setPublishObserver(() => {
      acceptedAtPublish.push(harness.gateway.metrics().wal.framesAccepted);
    });

    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    socket.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();

    const trades = harness.publishedOfType("ReferenceTradeObserved");
    expect(trades).toHaveLength(1);
    // Every publication happened with at least one frame already accepted by
    // the WAL. (The FeedConnected/gap events published before the first frame
    // are not frame-derived; the trade's own publish is the last one, so the
    // final reading is the load-bearing one.)
    expect(acceptedAtPublish.at(-1)).toBeGreaterThanOrEqual(1);

    await harness.gateway.stop();
  });

  it("orders the raw frame's ingestSeq below the derived event's, and links them by causationId", async () => {
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
    const socket = harness.binanceSockets.current;
    socket.open();
    socket.message(binanceTradeFrame("BTCUSDT", 7, harness.clock.nowMs()));
    await harness.settle();
    await harness.gateway.stop();

    const epoch = harness.gateway.gatewayEpoch;
    const frames = recordedFrames(harness.walFileSystem, epoch);
    expect(frames).toHaveLength(1);
    const rawFrame = frames[0];
    expect(rawFrame).toBeDefined();
    if (rawFrame === undefined) return;
    expect(rawFrame.source).toBe("binance");
    expect(rawFrame.gatewayEpoch).toBe(epoch);
    // The exact wire bytes, verbatim.
    expect(JSON.parse(rawFrame.payloadUtf8)).toMatchObject({ data: { t: 7 } });

    const trade = harness.publishedOfType("ReferenceTradeObserved")[0];
    expect(trade).toBeDefined();
    if (trade === undefined) return;
    // The ordering identity proves the sequence: raw first, event after.
    expect(BigInt(rawFrame.ingestSeq)).toBeLessThan(BigInt(trade.ingestSeq));
    // §6 invariant 4: the event names the raw record it came from.
    expect(trade.causationId).toBe(`raw:${epoch}:${rawFrame.ingestSeq}`);
  });

  it("records the raw frame before publication on the Polymarket market feed too", async () => {
    const harness = await buildHarness({
      config: { polymarket: { feedId: "polymarket-market" } },
    });
    harness.gateway.start();
    const socket = harness.polymarketSockets.current;
    socket.open();
    socket.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    await harness.settle();
    await harness.gateway.stop();

    const epoch = harness.gateway.gatewayEpoch;
    const frames = recordedFrames(harness.walFileSystem, epoch);
    expect(frames).toHaveLength(1);
    const rawFrame = frames[0];
    if (rawFrame === undefined) return;
    expect(rawFrame.source).toBe("polymarket");

    const snapshot = harness.publishedOfType("BookSnapshot")[0];
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    expect(BigInt(rawFrame.ingestSeq)).toBeLessThan(BigInt(snapshot.ingestSeq));
    expect(snapshot.causationId).toBe(`raw:${epoch}:${rawFrame.ingestSeq}`);
  });

  // The other half of the criterion: when the raw frame is NOT recorded, the
  // normalized data it would have produced must not be published either.
  it("suppresses derived market data when the WAL refuses the raw frame, and opens a PAGE incident", async () => {
    const harness = await buildHarness({
      config: {
        // A one-frame queue: the second frame in the same synchronous burst is
        // refused with `queue-overflow` before any drain can run.
        wal: { rootPath: "/wal", queueCapacity: 1 },
        polymarket: { feedId: "polymarket-market" },
      },
    });
    harness.gateway.start();
    const socket = harness.polymarketSockets.current;
    socket.open();
    // Two frames, delivered synchronously: the first is accepted, the second
    // overflows the bounded queue.
    socket.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    socket.message(polymarketBookFrame(MARKET.noTokenId, MARKET.conditionId));
    await harness.settle();

    expect(harness.recordingFailures).toContain("queue-overflow");
    const pageIncidents = harness.incidents.filter(
      (incident) => incident.reasonCode === "GATEWAY_WAL_FRAME_REFUSED",
    );
    expect(pageIncidents).toHaveLength(1);
    expect(pageIncidents[0]?.severity).toBe("PAGE");

    // Exactly one book snapshot was published — the one whose raw frame was
    // recorded. The refused frame's snapshot is absent, and counted.
    const snapshots = harness.publishedOfType("BookSnapshot");
    expect(snapshots).toHaveLength(1);
    const metrics = harness.gateway.metrics();
    expect(metrics.polymarket?.framesRefusedByWal).toBe(1);
    expect(metrics.polymarket?.marketEventsSuppressedUnrecorded).toBeGreaterThanOrEqual(1);
    // §8.3: nothing was dropped silently — the WAL queue counts no drops.
    expect(metrics.wal.queue.messagesDropped).toBe(0);

    await harness.gateway.stop();
  });
});
