/**
 * Duplicate handling — work-plan acceptance criterion 1, first half.
 *
 * The venue produces duplicates two documented ways: a resubscription snapshot
 * replays trades already seen, and an out-of-order message can redeliver one.
 * Both are suppressed by identity, and neither suppression is silent.
 */

import { describe, expect, it } from "vitest";

import { frameText, frameTextWithSequence } from "./fixtures.js";
import { anomalyCodes, createHarness, trades } from "./harness.js";

describe("duplicate trades", () => {
  it("emits a trade once and suppresses its redelivery, with a recorded anomaly", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");

    const first = harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    expect(trades(first)).toHaveLength(1);

    const repeat = harness.processor.ingestFrame(frameText("market-trades-duplicate"));
    expect(trades(repeat)).toHaveLength(0);
    expect(anomalyCodes(repeat)).toContain("COINBASE_DUPLICATE_TRADE");

    const metrics = harness.processor.metrics();
    expect(metrics.counters.tradesNormalized).toBe(1);
    expect(metrics.counters.tradesDuplicateSuppressed).toBe(1);
  });

  it("preserves the raw frame on the duplicate anomaly", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    const repeat = harness.processor.ingestFrame(frameText("market-trades-duplicate"));

    const anomaly = repeat.anomalies.find((a) => a.code === "COINBASE_DUPLICATE_TRADE");
    expect(anomaly?.rawFrame).toBe(frameText("market-trades-duplicate"));
    expect(anomaly?.symbol).toBe("ETH-USD");
  });

  it("suppresses the snapshot replay a reconnect produces", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));

    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    // The venue sends the same snapshot again on the new subscription. The
    // dedupe window deliberately survives the reconnect, so the trade is not
    // published twice under two different generations.
    const replay = harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    expect(trades(replay)).toHaveLength(0);
    expect(anomalyCodes(replay)).toContain("COINBASE_DUPLICATE_TRADE");
  });

  it("treats the same trade id on a different product as a different trade", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));

    const otherProduct = JSON.stringify({
      channel: "market_trades",
      timestamp: "2023-02-09T20:19:38.000000000Z",
      sequence_num: 1,
      events: [
        {
          type: "update",
          trades: [
            {
              trade_id: "000000000",
              product_id: "BTC-USD",
              price: "21932.98",
              size: "0.01",
              side: "BUY",
              time: "2019-08-14T20:42:29.000Z",
            },
          ],
        },
      ],
    });

    const output = harness.processor.ingestFrame(otherProduct);
    expect(trades(output)).toHaveLength(1);
    expect(anomalyCodes(output)).not.toContain("COINBASE_DUPLICATE_TRADE");
  });

  it("bounds the dedupe window, and re-emits rather than suppressing beyond it", () => {
    const harness = createHarness({ tradeDedupeCapacity: 1 });
    harness.processor.connectionOpened("c1");

    harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    // Two further trades evict the first identity from the one-slot window.
    harness.processor.ingestFrame(frameText("market-trades-update"));

    const replay = harness.processor.ingestFrame(frameText("market-trades-duplicate"));
    // Emitting a duplicate is visible downstream; suppressing a real trade is
    // not. The bounded window fails in the visible direction on purpose.
    expect(trades(replay)).toHaveLength(1);
  });
});

describe("out-of-order and repeated messages", () => {
  it("reports a non-advancing sequence_num and still processes the frame", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameTextWithSequence("market-trades-snapshot", 5));

    const regressed = harness.processor.ingestFrame(
      frameTextWithSequence("market-trades-update", 2),
    );
    expect(anomalyCodes(regressed)).toContain("COINBASE_SEQUENCE_REGRESSED");
    // The data still arrives: ignoring an out-of-order frame is a silent drop.
    expect(trades(regressed)).toHaveLength(2);
    expect(harness.processor.metrics().counters.sequenceRegressions).toBe(1);
  });

  it("does not let a regressed value move the baseline", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameTextWithSequence("market-trades-snapshot", 5));
    harness.processor.ingestFrame(frameTextWithSequence("market-trades-update", 2));

    // 6 follows 5, so this must be in order — not a gap measured from 2.
    const next = harness.processor.ingestFrame(
      frameTextWithSequence("market-trades-unknown-side", 6),
    );
    expect(anomalyCodes(next)).not.toContain("COINBASE_SEQUENCE_GAP");
  });
});
