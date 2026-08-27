import { describe, expect, it } from "vitest";

import { CoinbaseConfigurationError } from "./errors.js";
import {
  COINBASE_CONNECTION_CHANNEL,
  CoinbaseStreamProcessor,
  DEFAULT_STALENESS_THRESHOLD_MS,
  type CoinbaseStreamProcessorOptions,
} from "./stream-processor.js";
import { ManualMonotonicClock, ManualWallClock } from "./testing/index.js";

function options(
  overrides: Partial<CoinbaseStreamProcessorOptions> = {},
): CoinbaseStreamProcessorOptions {
  return {
    feedId: "coinbase.reference",
    wallClock: new ManualWallClock(),
    monotonicClock: new ManualMonotonicClock(),
    ...overrides,
  };
}

describe("CoinbaseStreamProcessor options", () => {
  it("refuses a feedId the domain CodeString schema would reject", () => {
    for (const feedId of ["", "has spaces", "1leading-digit", "x".repeat(65)]) {
      expect(() => new CoinbaseStreamProcessor(options({ feedId })), feedId).toThrow(
        CoinbaseConfigurationError,
      );
    }
  });

  it("refuses a non-positive staleness threshold", () => {
    for (const stalenessThresholdMs of [0, -1, 1.5, Number.NaN]) {
      expect(
        () => new CoinbaseStreamProcessor(options({ stalenessThresholdMs })),
        String(stalenessThresholdMs),
      ).toThrow(CoinbaseConfigurationError);
    }
  });

  it("refuses an empty channel list, which could never close a gap", () => {
    expect(() => new CoinbaseStreamProcessor(options({ channels: [] }))).toThrow(
      CoinbaseConfigurationError,
    );
  });

  it("refuses an endpoint that is empty or longer than the envelope allows", () => {
    expect(() => new CoinbaseStreamProcessor(options({ endpoint: "" }))).toThrow(
      CoinbaseConfigurationError,
    );
    expect(() => new CoinbaseStreamProcessor(options({ endpoint: "x".repeat(201) }))).toThrow(
      CoinbaseConfigurationError,
    );
  });

  it("refuses a connectionId that is empty or too long", () => {
    const processor = new CoinbaseStreamProcessor(options());
    expect(() => processor.connectionOpened("")).toThrow(CoinbaseConfigurationError);
    expect(() => processor.connectionOpened("c".repeat(201))).toThrow(CoinbaseConfigurationError);
  });

  it("has a positive default staleness threshold", () => {
    expect(DEFAULT_STALENESS_THRESHOLD_MS).toBeGreaterThan(0);
    expect(Number.isSafeInteger(DEFAULT_STALENESS_THRESHOLD_MS)).toBe(true);
  });
});

describe("lifecycle", () => {
  it("reports generation -1 before the first connection", () => {
    const processor = new CoinbaseStreamProcessor(options());
    expect(processor.subscriptionGeneration).toBe(-1);
    expect(processor.metrics().connected).toBe(false);
    expect(processor.metrics().connectionId).toBe("");
  });

  it("attributes a connection-level event to the connection, not to a venue channel", () => {
    const processor = new CoinbaseStreamProcessor(options());
    const output = processor.connectionOpened("c1");
    expect(output.feedEvents[0]?.envelope.sourceChannel).toBe(COINBASE_CONNECTION_CHANNEL);
    expect(output.feedEvents[0]?.envelope.source).toBe("coinbase");
    // A feed-status event is the adapter's own observation, so it carries no
    // venue timestamp.
    expect(output.feedEvents[0]?.envelope.venueTimestamp).toBeUndefined();
  });

  it("advances the generation on an explicit resubscription", () => {
    const processor = new CoinbaseStreamProcessor(options());
    processor.connectionOpened("c1");
    const output = processor.resubscribed();
    expect(processor.subscriptionGeneration).toBe(1);
    // The resubscription itself asserts nothing: no gap is claimed and no
    // recovery is claimed. Those are decided by what arrives next.
    expect(output.feedEvents).toHaveLength(0);
    expect(output.anomalies).toHaveLength(0);
  });

  it("substitutes a safe reason code rather than emitting an invalid one", () => {
    const processor = new CoinbaseStreamProcessor(options());
    processor.connectionOpened("c1");
    const output = processor.connectionClosed({ reasonCode: "not a code string!" });
    const event = output.feedEvents[0];
    expect(event?.eventType).toBe("FeedDisconnected");
    if (event?.eventType === "FeedDisconnected") {
      expect(event.payload.reasonCode).toBe("COINBASE_CLOSE_REASON_UNREPRESENTABLE");
    }
  });

  it("mints deterministic incident ids, with no clock and no randomness", () => {
    const build = (): string[] => {
      const processor = new CoinbaseStreamProcessor(options());
      processor.connectionOpened("c1");
      processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
      const reopened = processor.connectionOpened("c2");
      return reopened.feedEvents.flatMap((event) =>
        event.eventType === "DataQualityIncidentOpened" ? [event.payload.incidentId] : [],
      );
    };
    expect(build()).toEqual(["coinbase.reference:c2:1"]);
    expect(build()).toEqual(build());
  });

  it("counts frames received even when they cannot be read", () => {
    const processor = new CoinbaseStreamProcessor(options());
    processor.connectionOpened("c1");
    processor.ingestFrame("not json");
    processor.ingestFrame(new Uint8Array([1]));
    expect(processor.metrics().counters.framesReceived).toBe(2);
    expect(processor.metrics().counters.framesRejected).toBe(2);
  });

  it("measures staleness from the connection when no frame has arrived yet", () => {
    const monotonicClock = new ManualMonotonicClock();
    const processor = new CoinbaseStreamProcessor(options({ monotonicClock }));
    processor.connectionOpened("c1");
    monotonicClock.advanceMs(4_000);
    expect(processor.metrics().stalenessMs).toBe(4_000);
    expect(processor.metrics().lastMessageAt).toBeUndefined();
  });
});
