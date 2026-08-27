/**
 * Malformed and unknown input.
 *
 * The rule under test is §8.3 as ADR-002 §2.5 extends it: a frame this adapter
 * cannot turn into a normalized event must surface as a typed failure or a
 * first-class UNKNOWN, with the raw frame preserved — never as a silent drop and
 * never as an exception thrown out of the read loop.
 */

import { describe, expect, it } from "vitest";

import { classifyFrame } from "@polymarket-bot/coinbase-adapter";

import { FIXTURES, frameText } from "./fixtures.js";
import { anomalyCodes, createHarness, tops, trades } from "./harness.js";

describe("frames the adapter cannot read", () => {
  it("reports text that is not JSON, and keeps it verbatim", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("malformed-not-json"));

    expect(output.classification).toBe("REJECTED");
    expect(anomalyCodes(output)).toEqual(["COINBASE_FRAME_NOT_JSON"]);
    expect(output.anomalies[0]?.rawFrame).toBe("PONG");
    expect(output.normalized).toHaveLength(0);
  });

  it("refuses to decode a binary frame, and reports its length instead", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(new Uint8Array([0x00, 0x01, 0x02, 0x03]));

    expect(anomalyCodes(output)).toEqual(["COINBASE_FRAME_NOT_TEXT"]);
    // ADR-004 §1 keeps binary out of the raw-frame format, so there is no
    // faithful text to preserve. Fabricating one would be worse than saying so.
    expect(output.anomalies[0]?.rawFrame).toBeUndefined();
    expect(output.anomalies[0]?.rawFrameByteLength).toBe(4);
    expect(output.anomalies[0]?.severity).toBe("PAGE");
  });

  it("refuses a price that arrives as a JSON number", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("malformed-json-number-price"));

    expect(anomalyCodes(output)).toEqual(["COINBASE_FRAME_SHAPE_INVALID"]);
    expect(output.anomalies[0]?.detail).toContain("price");
    expect(output.anomalies[0]?.rawFrame).toBe(frameText("malformed-json-number-price"));
    expect(trades(output)).toHaveLength(0);
  });

  it("refuses an empty decimal rather than guessing whether it means absent or zero", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("malformed-empty-best-bid"));

    expect(anomalyCodes(output)).toEqual(["COINBASE_FRAME_SHAPE_INVALID"]);
    expect(output.anomalies[0]?.detail).toContain("best_bid");
    expect(tops(output)).toHaveLength(0);
  });

  it("refuses a non-positive trade size and keeps the rest of the batch", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("malformed-nonpositive-size"));

    expect(anomalyCodes(output)).toContain("COINBASE_ECONOMIC_FIELD_INVALID");
    const normalized = trades(output);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.payload.venueTradeId).toBe("000000008");
  });
});

describe("values outside a documented enumeration", () => {
  it("treats an unrecognized channel as UNKNOWN, not as corruption", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("candles-unhandled-channel"));

    expect(output.classification).toBe("UNKNOWN_CHANNEL");
    expect(anomalyCodes(output)).toEqual(["COINBASE_UNKNOWN_CHANNEL"]);
    expect(output.anomalies[0]?.rawFrame).toBe(frameText("candles-unhandled-channel"));
    expect(harness.processor.metrics().counters.framesUnknownChannel).toBe(1);
  });

  it("omits takerSide for an unrecognized side, and keeps the venue's own word", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("market-trades-unknown-side"));

    const [trade] = trades(output);
    expect(anomalyCodes(output)).toContain("COINBASE_UNKNOWN_TRADE_SIDE");
    expect(trade?.payload.takerSide).toBeUndefined();
    expect(trade?.payload.price).toBe("1260.05");
    expect(trade?.venueDetail.venueSide).toBe("UNSPECIFIED");
  });

  it("still normalizes trades carried under an unrecognized event type", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("market-trades-unknown-event-type"));

    expect(anomalyCodes(output)).toContain("COINBASE_UNKNOWN_EVENT_TYPE");
    expect(trades(output)).toHaveLength(1);
    expect(trades(output)[0]?.venueDetail.venueEventType).toBe("backfill");
  });

  it("counts a control frame for sequence continuity without parsing its payload", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const first = harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    expect(first.classification).toBe("MARKET_TRADES");

    const control = harness.processor.ingestFrame(frameText("subscriptions-ack"));
    expect(control.classification).toBe("CONTROL");
    expect(control.anomalies).toHaveLength(0);
    expect(control.normalized).toHaveLength(0);

    // sequence_num 2 follows the control frame's 1 with no gap, which is only
    // true because the control frame advanced the baseline.
    const next = harness.processor.ingestFrame(frameText("market-trades-update"));
    expect(anomalyCodes(next)).not.toContain("COINBASE_SEQUENCE_GAP");
  });
});

describe("the no-silent-drop property, over the whole catalogue", () => {
  it("produces a normalized event or an anomaly for every fixture that carries market data", () => {
    // Heartbeats and the subscriptions acknowledgement legitimately produce
    // neither: they carry no market data. They are still COUNTED, and they still
    // advance the sequence baseline, which the assertions below check — that is
    // what distinguishes "produced nothing" from "was dropped".
    const carriesNoMarketData = new Set(["heartbeats", "heartbeats-gap", "subscriptions-ack"]);

    for (const catalogued of FIXTURES) {
      const harness = createHarness();
      harness.processor.connectionOpened("c1");
      const output = harness.processor.ingestFrame(frameText(catalogued.id));
      const producedSomething = output.normalized.length > 0 || output.anomalies.length > 0;
      expect(producedSomething, catalogued.id).toBe(!carriesNoMarketData.has(catalogued.id));
      expect(harness.processor.metrics().counters.framesReceived, catalogued.id).toBe(1);
      expect(
        harness.processor.metrics().perChannel.length,
        `${catalogued.id} was not recorded against a channel`,
      ).toBe(catalogued.classification === "REJECTED" ? 0 : 1);
    }
  });

  it("never throws, for any fixture, in any order", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    for (const catalogued of [...FIXTURES].reverse()) {
      expect(() => harness.processor.ingestFrame(frameText(catalogued.id))).not.toThrow();
    }
    for (const catalogued of FIXTURES) {
      expect(() => classifyFrame(frameText(catalogued.id))).not.toThrow();
    }
  });

  it("survives adversarial text without throwing", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const hostile = [
      "",
      "null",
      "[]",
      '"a string"',
      "42",
      '{"channel":"ticker"}',
      '{"channel":"ticker","timestamp":"x","sequence_num":1.5,"events":[]}',
      '{"channel":"","timestamp":"x","sequence_num":0,"events":[]}',
      `{"channel":"market_trades","timestamp":"x","sequence_num":0,"events":[{"type":"update","trades":[{"trade_id":"a","product_id":"b","price":"1e5","size":"1","side":"BUY","time":"t"}]}]}`,
      '{"channel":"heartbeats","timestamp":"x","sequence_num":0,"events":[{"current_time":"t","heartbeat_counter":-1}]}',
    ];
    for (const text of hostile) {
      const output = harness.processor.ingestFrame(text);
      expect(output.anomalies.length + output.normalized.length, text).toBeGreaterThan(0);
    }
  });
});
