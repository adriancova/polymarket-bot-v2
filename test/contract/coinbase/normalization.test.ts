/**
 * Normalization against the frozen domain contracts.
 *
 * Covers the acceptance criterion "Venue and receipt timestamps are preserved",
 * and the ADR-001 §3 boundary rule that a venue spelling is canonicalized in the
 * adapter and never inside a domain schema.
 */

import { describe, expect, it } from "vitest";

import {
  ReferenceTopOfBookChangedContract,
  ReferenceTradeObservedContract,
} from "@polymarket-bot/domain";

import { fixture, frameText, frameTextWithSequence } from "./fixtures.js";
import { createHarness, tops, trades } from "./harness.js";

describe("normalized trades", () => {
  it("turns the documented market_trades example into a ReferenceTradeObserved", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("market-trades-snapshot"));

    const [trade] = trades(output);
    expect(trade).toBeDefined();
    expect(trade?.payload).toEqual({
      venue: "coinbase",
      symbol: "ETH-USD",
      price: "1260.01",
      size: "0.3",
      takerSide: "ASK",
      venueTradeId: "000000000",
    });
    expect(trade?.eventType).toBe(ReferenceTradeObservedContract.eventType);
    expect(trade?.schemaVersion).toBe(ReferenceTradeObservedContract.schemaVersion);
  });

  it("validates every normalized payload against the frozen contract itself", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const outputs = [
      harness.processor.ingestFrame(frameText("market-trades-snapshot")),
      harness.processor.ingestFrame(frameTextWithSequence("ticker-snapshot", 1)),
      harness.processor.ingestFrame(frameText("market-trades-update")),
    ];
    const events = outputs.flatMap((output) => output.normalized);
    expect(events.length).toBe(4);
    for (const event of events) {
      const contract =
        event.eventType === "ReferenceTradeObserved"
          ? ReferenceTradeObservedContract
          : ReferenceTopOfBookChangedContract;
      expect(contract.payloadSchema.safeParse(event.payload).success, event.eventType).toBe(true);
    }
  });

  it("keeps the venue trade time and the receipt time distinct", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.advanceMs(5_000);
    const output = harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    const [trade] = trades(output);

    // The venue's own time for the event, straight from the frame.
    expect(trade?.envelope.venueTimestamp).toBe("2019-08-14T20:42:27.265Z");
    expect(trade?.venueDetail.venueTradeTime).toBe("2019-08-14T20:42:27.265Z");
    // The message-level timestamp is a THIRD fact and is kept separately: it is
    // when the venue sent the batch, not when the trade happened.
    expect(trade?.venueDetail.venueMessageTime).toBe("2023-02-09T20:19:35.39625135Z");
    // Receipt time comes from the injected clock, never from a venue field.
    expect(trade?.envelope.receivedAt).toBe("2026-08-27T12:00:05.000Z");
    expect(trade?.envelope.receivedMonotonicNs).toBe("6000000000");
  });

  it("derives takerSide by inverting the documented maker side, in both directions", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    const output = harness.processor.ingestFrame(frameText("market-trades-update"));

    const normalized = trades(output);
    expect(normalized.map((trade) => trade.venueDetail.venueSide)).toEqual(["SELL", "BUY"]);
    expect(normalized.map((trade) => trade.payload.takerSide)).toEqual(["BID", "ASK"]);
    for (const trade of normalized) {
      expect(trade.venueDetail.venueSideMeaning).toBe("MAKER");
    }
  });

  it("canonicalizes venue decimal spellings before the domain boundary", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    const output = harness.processor.ingestFrame(frameText("market-trades-update"));

    const second = trades(output)[1];
    expect(second?.venueDetail.rawPrice).toBe("1260.030");
    expect(second?.venueDetail.rawSize).toBe("1.50");
    expect(second?.payload.price).toBe("1260.03");
    expect(second?.payload.size).toBe("1.5");
  });

  it("never lets an economic value be a JavaScript number", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    const [trade] = trades(output);
    expect(typeof trade?.payload.price).toBe("string");
    expect(typeof trade?.payload.size).toBe("string");
  });
});

describe("normalized top of book", () => {
  it("turns the documented ticker example into a ReferenceTopOfBookChanged", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("ticker-snapshot"));

    const [top] = tops(output);
    expect(top?.payload).toEqual({
      venue: "coinbase",
      symbol: "BTC-USD",
      bidPrice: "21931.98",
      bidSize: "8000.21",
      askPrice: "21933.98",
      askSize: "8038.07770938",
    });
  });

  it("uses the message timestamp as the venue time, the only one the channel supplies", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.advanceMs(1_500);
    const output = harness.processor.ingestFrame(frameText("ticker-snapshot"));
    const [top] = tops(output);

    expect(top?.envelope.venueTimestamp).toBe("2023-02-09T20:30:37.167359596Z");
    expect(top?.venueDetail.venueMessageTime).toBe("2023-02-09T20:30:37.167359596Z");
    expect(top?.envelope.receivedAt).toBe("2026-08-27T12:00:01.500Z");
  });

  it("keeps an absent top-of-book key absent, rather than inventing a zero", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("ticker-bid-only"));

    const [top] = tops(output);
    expect(top?.payload).toEqual({
      venue: "coinbase",
      symbol: "ETH-USD",
      bidPrice: "1259.98",
      bidSize: "12.5",
    });
    expect(Object.hasOwn(top?.payload ?? {}, "askPrice")).toBe(false);
    expect(Object.hasOwn(top?.payload ?? {}, "askSize")).toBe(false);
  });

  it("emits nothing when a ticker restates an unchanged top of book", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("ticker-snapshot"));
    const output = harness.processor.ingestFrame(frameText("ticker-unchanged"));

    expect(tops(output)).toHaveLength(0);
    expect(output.anomalies.map((anomaly) => anomaly.code)).toContain(
      "COINBASE_TOP_OF_BOOK_UNCHANGED",
    );
    expect(harness.processor.metrics().counters.topOfBookUnchangedSuppressed).toBe(1);
  });

  it("emits when the top of book actually moves", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("ticker-snapshot"));
    harness.processor.ingestFrame(frameText("ticker-unchanged"));
    const output = harness.processor.ingestFrame(frameText("ticker-changed"));

    const [top] = tops(output);
    expect(top?.payload.bidPrice).toBe("21932.5");
    expect(top?.payload.bidSize).toBe("1.5");
    expect(top?.payload.askPrice).toBe("21934.1");
    expect(top?.payload.askSize).toBe("2");
  });
});

describe("the envelope draft", () => {
  it("carries the provenance the adapter knows and none it does not", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("connection-7");
    const output = harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    const [trade] = trades(output);

    expect(trade?.envelope.source).toBe("coinbase");
    expect(trade?.envelope.sourceChannel).toBe("market_trades");
    expect(trade?.envelope.connectionId).toBe("connection-7");
    expect(trade?.envelope.subscriptionGeneration).toBe(0);
    // The gateway assigns these (ADR-002 §2.1); the adapter must not.
    const draft = trade?.envelope as unknown as Record<string, unknown>;
    expect(Object.hasOwn(draft, "gatewayEpoch")).toBe(false);
    expect(Object.hasOwn(draft, "ingestSeq")).toBe(false);
    expect(Object.hasOwn(draft, "eventId")).toBe(false);
  });

  it("restates the envelope source in the payload venue, as ADR-002 §5 requires", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const output = harness.processor.ingestFrame(frameText("ticker-snapshot"));
    const [top] = tops(output);
    expect(top?.payload.venue).toBe(top?.envelope.source);
  });

  it("agrees with the fixture's own stated expectation", () => {
    expect(fixture("market-trades-snapshot").expectation).toContain("takerSide ASK");
  });
});
