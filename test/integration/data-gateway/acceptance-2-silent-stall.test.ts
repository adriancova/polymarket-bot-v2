/**
 * WORKPLAN ACCEPTANCE 2 — "Silent socket stall fixture opens an incident."
 *
 * The fixture in each case is a socket that stays OPEN and delivers nothing:
 * no close, no error, no frame. That is the failure mode a naive recorder
 * cannot see at all, and the one §8.3/§14.3 make first-class.
 *
 * Each feed detects it with the evidence its venue actually provides, and in
 * every case the gateway — not the adapter — escalates the reported staleness
 * to a `DataQualityIncidentOpened` (the adapters emit `FeedStale` and leave the
 * operational judgement to the composition root; Coinbase additionally reports
 * its own `COINBASE_FEED_STALE` anomaly, which routes through the same path).
 */

import { describe, expect, it } from "vitest";

import { binanceTradeFrame, buildHarness, polymarketBookFrame, MARKET } from "./support/harness.js";

describe("acceptance 2 — a silent socket stall opens an incident", () => {
  it("opens an incident when the Polymarket socket stops answering PING (no close, no error)", async () => {
    const harness = await buildHarness({
      config: {
        polymarket: {
          feedId: "polymarket-market",
          heartbeatIntervalMs: 1_000,
          pongTimeoutMs: 5_000,
          stalenessCheckIntervalMs: 1_000,
        },
      },
    });
    harness.gateway.start();
    const socket = harness.polymarketSockets.current;
    socket.open();
    // One real frame, then silence: the socket never closes and never errors.
    socket.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    await harness.settle();

    expect(
      harness.incidents.some((incident) => incident.reasonCode === "GATEWAY_FEED_STALL"),
    ).toBe(false);

    // Silence past the PONG tolerance. The client keeps sending PING; nothing
    // comes back.
    harness.timers.advance(20_000);
    await harness.settle();

    const stalls = harness.incidents.filter(
      (incident) => incident.reasonCode === "GATEWAY_FEED_STALL",
    );
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.severity).toBe("NOTIFY");
    expect(stalls[0]?.feedId).toBe("polymarket-market");

    // The condition is in the published stream as well as in the observer:
    // a FeedStale event and the incident that escalates it.
    expect(harness.publishedOfType("FeedStale").length).toBeGreaterThanOrEqual(1);
    const incidentEvents = harness
      .publishedOfType("DataQualityIncidentOpened")
      .filter(
        (envelope) =>
          (envelope.payload as { reasonCode?: string }).reasonCode === "GATEWAY_FEED_STALL",
      );
    expect(incidentEvents).toHaveLength(1);
    expect(incidentEvents[0]?.source).toBe("internal");

    await harness.gateway.stop();
  });

  it("opens an incident when the Binance socket goes silent past its staleness threshold", async () => {
    const harness = await buildHarness({
      config: {
        binance: {
          feedId: "binance-reference",
          symbols: ["BTCUSDT"],
          stalenessThresholdMs: 10_000,
        },
        tickIntervalMs: 1_000,
      },
    });
    harness.gateway.start();
    const socket = harness.binanceSockets.current;
    socket.open();
    socket.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();
    expect(harness.gateway.metrics().binance?.stallsObserved).toBe(0);

    // The socket stays open and delivers nothing for well past the threshold.
    // The gateway tick drives the adapter's staleness check.
    harness.timers.advance(30_000);
    await harness.settle();

    expect(harness.gateway.metrics().binance?.stallsObserved).toBe(1);
    const stalls = harness.incidents.filter(
      (incident) => incident.reasonCode === "GATEWAY_FEED_STALL",
    );
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.feedId).toBe("binance-reference");
    // The stall did not fabricate a disconnect: the socket was never closed.
    expect(socket.closedByClient).toBe(false);

    await harness.gateway.stop();
  });

  it("opens exactly one incident per stall episode, and a fresh one after reconnect", async () => {
    const harness = await buildHarness({
      config: {
        binance: {
          feedId: "binance-reference",
          symbols: ["BTCUSDT"],
          stalenessThresholdMs: 10_000,
        },
        tickIntervalMs: 1_000,
      },
    });
    harness.gateway.start();
    const first = harness.binanceSockets.current;
    first.open();
    first.message(binanceTradeFrame("BTCUSDT", 1, harness.clock.nowMs()));
    await harness.settle();

    harness.timers.advance(30_000);
    await harness.settle();
    // Repeated ticks during ONE stall episode do not flood the stream.
    harness.timers.advance(30_000);
    await harness.settle();
    expect(
      harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_FEED_STALL"),
    ).toHaveLength(1);

    // The socket finally dies; the driver reconnects, and a new stall on the
    // new connection is a new episode with its own incident.
    first.serverClose();
    harness.timers.advance(5_000);
    await harness.settle();
    const second = harness.binanceSockets.current;
    expect(second).not.toBe(first);
    second.open();
    second.message(binanceTradeFrame("BTCUSDT", 2, harness.clock.nowMs()));
    await harness.settle();
    harness.timers.advance(30_000);
    await harness.settle();

    expect(
      harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_FEED_STALL"),
    ).toHaveLength(2);

    await harness.gateway.stop();
  });

  it("opens an incident when the Coinbase socket goes silent (the adapter's own stale anomaly)", async () => {
    const harness = await buildHarness({
      config: {
        coinbase: {
          feedId: "coinbase-reference",
          productIds: ["BTC-USD"],
          stalenessThresholdMs: 10_000,
          stalenessPollIntervalMs: 1_000,
        },
      },
    });
    harness.gateway.start();
    const socket = harness.coinbaseSockets.current;
    socket.open();
    await harness.settle();

    harness.timers.advance(30_000);
    await harness.settle();

    const stale = harness.incidents.filter(
      (incident) => incident.reasonCode === "COINBASE_FEED_STALE",
    );
    expect(stale.length).toBeGreaterThanOrEqual(1);

    await harness.gateway.stop();
  });
});
