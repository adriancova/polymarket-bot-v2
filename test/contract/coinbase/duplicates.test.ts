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

  it("does not let a REFUSED trade reserve its identity", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");

    // The venue's first copy of trade 000000042 carries an empty price, which
    // the decimal boundary refuses (U-CB-1). Nothing was emitted for it.
    const refused = harness.processor.ingestFrame(frameText("malformed-snapshot-empty-price"));
    expect(anomalyCodes(refused)).toContain("COINBASE_ECONOMIC_FIELD_INVALID");
    expect(trades(refused)).toHaveLength(0);

    // The venue redelivers the same trade with a usable price. Calling this a
    // duplicate would suppress a real trade that no version of was ever emitted
    // — a silent drop wearing a duplicate's label.
    const corrected = harness.processor.ingestFrame(frameText("market-trades-corrected-price"));
    expect(anomalyCodes(corrected)).not.toContain("COINBASE_DUPLICATE_TRADE");
    expect(trades(corrected)).toHaveLength(1);
    expect(trades(corrected)[0]?.payload.venueTradeId).toBe("000000042");
    expect(trades(corrected)[0]?.payload.price).toBe("1260.09");

    const metrics = harness.processor.metrics();
    expect(metrics.counters.tradesNormalized).toBe(1);
    expect(metrics.counters.tradesDuplicateSuppressed).toBe(0);
  });

  it("reports a refused trade again rather than calling the second copy a duplicate", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("malformed-snapshot-empty-price"));

    const again = harness.processor.ingestFrame(
      frameTextWithSequence("malformed-snapshot-empty-price", 1),
    );
    // Two refused copies are two refusals. Reporting the second as a duplicate
    // would claim the trade had been normalized once, which it never was.
    expect(anomalyCodes(again)).toContain("COINBASE_ECONOMIC_FIELD_INVALID");
    expect(anomalyCodes(again)).not.toContain("COINBASE_DUPLICATE_TRADE");
    expect(harness.processor.metrics().counters.tradesDuplicateSuppressed).toBe(0);
  });

  it("still suppresses the second copy of a trade that WAS normalized", () => {
    // The guard above must not have turned duplicate suppression off.
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    const repeat = harness.processor.ingestFrame(frameText("market-trades-duplicate"));
    expect(anomalyCodes(repeat)).toContain("COINBASE_DUPLICATE_TRADE");
    expect(trades(repeat)).toHaveLength(0);
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
