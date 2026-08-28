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

  it("records a superseded connection's callback without changing any state", () => {
    const processor = new CoinbaseStreamProcessor(options());
    processor.connectionOpened("c1");
    processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    processor.connectionOpened("c2");
    const before = processor.metrics();

    const output = processor.staleConnectionActivity({
      connectionId: "c1",
      callback: "onClose",
      detail: "close code 1006",
    });

    expect(output.anomalies.map((anomaly) => anomaly.code)).toEqual([
      "COINBASE_STALE_CONNECTION_ACTIVITY",
    ]);
    expect(output.anomalies[0]?.detail).toContain("c1");
    expect(output.feedEvents).toHaveLength(0);
    expect(output.normalized).toHaveLength(0);
    const after = processor.metrics();
    expect(after.connectionId).toBe(before.connectionId);
    expect(after.subscriptionGeneration).toBe(before.subscriptionGeneration);
    expect(after.connected).toBe(before.connected);
    expect(after.counters.disconnections).toBe(before.counters.disconnections);
    expect(after.counters.staleConnectionCallbacks).toBe(1);
  });

  it("records a frame from a retired socket without ingesting it", () => {
    // The window the transport owner alone can see: the retired socket's id is
    // still the one this processor holds, so `ingestFrame` could not tell the
    // difference and would publish the frame under the current generation.
    const processor = new CoinbaseStreamProcessor(options());
    processor.connectionOpened("c1");
    const before = processor.metrics();
    // A perfectly well-formed frame, and still refused: what disqualifies it is
    // where it came from, not what it says.
    const frame = JSON.stringify({
      channel: "heartbeats",
      timestamp: "2023-06-23T20:31:26.122969572Z",
      sequence_num: 0,
      events: [{ current_time: "2023-06-23 20:31:56 +0000 UTC", heartbeat_counter: 3049 }],
    });

    const output = processor.staleConnectionFrame(frame, { connectionId: "c1" });

    expect(output.classification).toBe("HEARTBEATS");
    expect(output.anomalies.map((anomaly) => anomaly.code)).toEqual([
      "COINBASE_STALE_CONNECTION_ACTIVITY",
    ]);
    expect(output.anomalies[0]?.rawFrame).toBe(frame);
    expect(output.anomalies[0]?.channel).toBe("heartbeats");
    expect(output.normalized).toHaveLength(0);
    expect(output.feedEvents).toHaveLength(0);

    const after = processor.metrics();
    expect(after.counters.framesFromStaleConnection).toBe(1);
    // Counted as received — nothing is dropped in silence — and accounted for
    // nowhere else: no channel state, and no liveness.
    expect(after.counters.framesReceived).toBe(before.counters.framesReceived + 1);
    expect(after.perChannel).toEqual(before.perChannel);
    expect(after.lastMessageAt).toBeUndefined();
    expect(after.counters.heartbeatsReceived).toBe(0);
    // A frame is not a callback: the two are counted apart because they are
    // different events.
    expect(after.counters.staleConnectionCallbacks).toBe(0);
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
