/**
 * ACCUMULATED BINDING OBLIGATIONS 2 and 10 on the Coinbase feed.
 *
 * - **2 (identity).** The Coinbase manager owns its own socket, so the gateway
 *   interposes at the ONE seam the manager itself injects: the socket factory.
 *   `RecordingCoinbaseSocketFactory` records each frame under the identity of
 *   the socket that produced it — captured by closure, in lockstep with the
 *   manager's own `<feedId>-c<ordinal>` minting. This test pins that
 *   correspondence, because the whole raw-frame provenance chain rests on it.
 * - **10 (escalation).** "A channel whose snapshot persistently fails to apply
 *   produces a loud reconnect loop — the gateway owns escalating that to an
 *   incident" (WP-090 known risk 1, round-2 follow-up 2). Every anomaly still
 *   routes individually; the escalation is the gateway's addition on top.
 */

import { describe, expect, it } from "vitest";

import { buildHarness, coinbaseTradesSnapshot, coinbaseTickerSnapshot } from "./support/harness.js";
import { recordedFrames } from "./support/wal.js";

const COINBASE_CONFIG = {
  coinbase: {
    feedId: "coinbase-reference",
    productIds: ["BTC-USD"],
    snapshotFailureEscalationThreshold: 3,
  },
} as const;

/** A `market_trades` snapshot whose single entry the adapter must refuse. */
function unapplicableTradesSnapshot(sequenceNum: number, atIso: string): string {
  return JSON.stringify({
    channel: "market_trades",
    timestamp: atIso,
    sequence_num: sequenceNum,
    events: [
      {
        type: "snapshot",
        trades: [
          {
            trade_id: `t-${String(sequenceNum)}`,
            product_id: "BTC-USD",
            price: "50000.10",
            // Non-positive size: `ReferenceTradeObserved` forbids it, so the
            // entry is refused and the snapshot is not applied in full.
            size: "0",
            side: "BUY",
            time: atIso,
          },
        ],
      },
    ],
  });
}

describe("obligation 2 — the recorded frame carries the identity of the socket that produced it", () => {
  it("records each Coinbase frame under its own connection id, matching the published event", async () => {
    const harness = await buildHarness({ config: { ...COINBASE_CONFIG } });
    harness.gateway.start();
    const socket = harness.coinbaseSockets.current;
    socket.open();
    await harness.settle();

    const atIso = new Date(harness.clock.nowMs()).toISOString();
    socket.deliver(
      coinbaseTradesSnapshot({ productId: "BTC-USD", sequenceNum: 1, atIso }),
    );
    await harness.settle();

    const trades = harness.publishedOfType("ReferenceTradeObserved");
    expect(trades).toHaveLength(1);
    const publishedConnectionId = trades[0]?.connectionId;
    expect(publishedConnectionId).toBeDefined();

    await harness.gateway.stop();
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    expect(frames).toHaveLength(1);
    // The raw frame and the event derived from it name the SAME connection —
    // the wrapper's closure-captured identity is in lockstep with the
    // manager's own minting, so nothing is relabeled.
    expect(frames[0]?.connectionId).toBe(publishedConnectionId);
    expect(frames[0]?.source).toBe("coinbase");
    // And the event names the raw record it came from.
    expect(trades[0]?.causationId).toBe(
      `raw:${harness.gateway.gatewayEpoch}:${frames[0]?.ingestSeq ?? ""}`,
    );
  });

  it("records a frame from a superseded socket under THAT socket's id, not the current one", async () => {
    const harness = await buildHarness({ config: { ...COINBASE_CONFIG } });
    harness.gateway.start();
    const first = harness.coinbaseSockets.current;
    first.open();
    await harness.settle();

    // The socket dies and the manager reconnects.
    first.dropConnection();
    harness.timers.advance(5_000);
    await harness.settle();
    const second = harness.coinbaseSockets.current;
    expect(second).not.toBe(first);
    second.open();
    await harness.settle();

    // The DEAD socket delivers a late frame.
    harness.clock.advance(10);
    const lateIso = new Date(harness.clock.nowMs()).toISOString();
    first.deliver(
      coinbaseTradesSnapshot({
        productId: "BTC-USD",
        sequenceNum: 99,
        atIso: lateIso,
        tradeId: "late-trade",
      }),
    );
    await harness.settle();

    // The adapter refused it as stale-connection activity, and the gateway
    // routed that refusal to an incident rather than letting it pass.
    expect(
      harness.incidents.some(
        (incident) => incident.reasonCode === "COINBASE_STALE_CONNECTION_ACTIVITY",
      ),
    ).toBe(true);

    await harness.gateway.stop();
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    const lateFrame = frames.find((frame) => frame.payloadUtf8.includes("late-trade"));
    expect(lateFrame).toBeDefined();
    // Recorded under the retired socket's identity, never the live one.
    expect(lateFrame?.connectionId).toBe(`${COINBASE_CONFIG.coinbase.feedId}-c1`);
    expect(lateFrame?.connectionId).not.toBe(`${COINBASE_CONFIG.coinbase.feedId}-c2`);
  });
});

describe("obligation 10 — a persistently unapplicable snapshot escalates to an incident", () => {
  it("routes every snapshot failure and escalates to PAGE past the threshold", async () => {
    const harness = await buildHarness({ config: { ...COINBASE_CONFIG } });
    harness.gateway.start();
    const socket = harness.coinbaseSockets.current;
    socket.open();
    await harness.settle();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      harness.clock.advance(1_000);
      socket.deliver(
        unapplicableTradesSnapshot(attempt, new Date(harness.clock.nowMs()).toISOString()),
      );
      await harness.settle();
    }

    // Each individual failure is routed with the adapter's own reason code...
    expect(
      harness.incidents.some(
        (incident) => incident.reasonCode === "COINBASE_SNAPSHOT_NOT_APPLIED",
      ),
    ).toBe(true);
    // ...and the persistent repetition escalates, which is the gateway's job.
    const escalations = harness.incidents.filter(
      (incident) => incident.reasonCode === "COINBASE_SNAPSHOT_ESCALATION",
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.severity).toBe("PAGE");
    expect(escalations[0]?.detail).toContain("market_trades");
    expect(harness.gateway.metrics().coinbase?.snapshotEscalations).toBe(1);

    await harness.gateway.stop();
  });

  it("does not escalate below the threshold", async () => {
    const harness = await buildHarness({
      config: {
        coinbase: { ...COINBASE_CONFIG.coinbase, snapshotFailureEscalationThreshold: 5 },
      },
    });
    harness.gateway.start();
    const socket = harness.coinbaseSockets.current;
    socket.open();
    await harness.settle();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      harness.clock.advance(1_000);
      socket.deliver(
        unapplicableTradesSnapshot(attempt, new Date(harness.clock.nowMs()).toISOString()),
      );
      await harness.settle();
    }

    expect(
      harness.incidents.filter(
        (incident) => incident.reasonCode === "COINBASE_SNAPSHOT_ESCALATION",
      ),
    ).toHaveLength(0);
    expect(harness.gateway.metrics().coinbase?.snapshotEscalations).toBe(0);

    await harness.gateway.stop();
  });

  it("resets the escalation counters when a snapshot finally applies (FeedResynchronized)", async () => {
    const harness = await buildHarness({ config: { ...COINBASE_CONFIG } });
    harness.gateway.start();
    const first = harness.coinbaseSockets.current;
    first.open();
    await harness.settle();

    // Reconnect so a gap is open and a resynchronization is possible.
    first.dropConnection();
    harness.timers.advance(5_000);
    await harness.settle();
    const second = harness.coinbaseSockets.current;
    second.open();
    await harness.settle();

    // Two failures, below the threshold of three.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      harness.clock.advance(1_000);
      second.deliver(
        unapplicableTradesSnapshot(attempt, new Date(harness.clock.nowMs()).toISOString()),
      );
      await harness.settle();
    }

    // Then good snapshots on every declared channel close the gap.
    harness.clock.advance(1_000);
    const goodIso = new Date(harness.clock.nowMs()).toISOString();
    second.deliver(
      coinbaseTradesSnapshot({ productId: "BTC-USD", sequenceNum: 3, atIso: goodIso }),
    );
    second.deliver(
      coinbaseTickerSnapshot({ productId: "BTC-USD", sequenceNum: 4, atIso: goodIso }),
    );
    await harness.settle();

    expect(harness.publishedOfType("FeedResynchronized").length).toBeGreaterThanOrEqual(1);
    expect(harness.gateway.metrics().coinbase?.snapshotEscalations).toBe(0);

    await harness.gateway.stop();
  });
});
