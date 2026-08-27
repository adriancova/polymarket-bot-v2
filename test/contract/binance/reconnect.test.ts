/**
 * `WP-080` acceptance 1 (second half): reconnect fixtures are handled.
 *
 * The invariant under test is ADR-002 §2.4 and handoff §7.1/§9.1: a
 * resubscription creates a new `subscriptionGeneration`, and a restart or a
 * detected gap requires a new authoritative snapshot before affected markets
 * resume. Binance publishes no snapshot on these two streams and its
 * documentation defines no replay, resume, or backfill for them, so this adapter
 * can never truthfully emit `FeedResynchronized` — it emits `FeedConnected`
 * beside a still-open gap instead. A reconnect that looked like a continuous
 * feed would be the exact failure ADR-002 §2.4 was written to make
 * unrepresentable.
 */

import { describe, expect, it } from "vitest";

import { frameText, sessionFixture } from "./fixtures.js";
import { createHarness, eventTypesOf } from "./support.js";

const SESSION = sessionFixture("reconnect-synthetic");

type Recorded = {
  readonly step: string;
  readonly label?: string;
  readonly classification?: string;
  readonly eventTypes: readonly string[];
  readonly generation: number;
  readonly directive: string;
};

function driveSession(): {
  readonly harness: ReturnType<typeof createHarness>;
  readonly recorded: readonly Recorded[];
} {
  const harness = createHarness();
  const recorded: Recorded[] = [];

  for (const step of SESSION.steps) {
    const stamp = harness.clock.advance(step.advanceMs);
    switch (step.step) {
      case "OPEN": {
        harness.feed.connecting();
        const outcome = harness.feed.onOpen(step.connectionId, stamp);
        harness.emissions.push(...outcome.emissions);
        recorded.push({
          step: "OPEN",
          eventTypes: eventTypesOf(outcome.emissions),
          generation: harness.feed.subscriptionGeneration,
          directive: outcome.directive.kind,
        });
        break;
      }
      case "CLOSE": {
        const outcome = harness.feed.onClose(stamp, {
          ...(step.code === undefined ? {} : { code: step.code }),
          ...(step.reason === undefined ? {} : { reason: step.reason }),
        });
        harness.emissions.push(...outcome.emissions);
        recorded.push({
          step: "CLOSE",
          eventTypes: eventTypesOf(outcome.emissions),
          generation: harness.feed.subscriptionGeneration,
          directive: outcome.directive.kind,
        });
        break;
      }
      case "FRAME": {
        const outcome = harness.feed.onFrame(frameText(step), stamp);
        harness.emissions.push(...outcome.emissions);
        recorded.push({
          step: "FRAME",
          label: step.label,
          classification: outcome.classification,
          eventTypes: eventTypesOf(outcome.emissions),
          generation: harness.feed.subscriptionGeneration,
          directive: outcome.directive.kind,
        });
        break;
      }
    }
  }

  return { harness, recorded };
}

describe("reconnect session", () => {
  it("classifies every scripted frame as the fixture states", () => {
    const { recorded } = driveSession();
    const frames = recorded.filter((entry) => entry.step === "FRAME");
    const expected = SESSION.steps.filter((step) => step.step === "FRAME");
    expect(frames.map((entry) => [entry.label, entry.classification])).toEqual(
      expected.map((step) => [step.label, step.expectedClassification]),
    );
  });

  it("opens every connection with FeedConnected AND an unwaived gap", () => {
    const { recorded } = driveSession();
    const opens = recorded.filter((entry) => entry.step === "OPEN");
    expect(opens).toHaveLength(3);
    for (const entry of opens) {
      expect(entry.eventTypes).toEqual([
        "FeedConnected",
        "FeedGapDetected",
        "DataQualityIncidentOpened",
      ]);
    }
  });

  it("never claims a resynchronization it did not perform (ADR-002 §2.4)", () => {
    const { harness } = driveSession();
    expect(eventTypesOf(harness.emissions)).not.toContain("FeedResynchronized");
  });

  it("pins every emitted gap's snapshot obligation to `true`", () => {
    const { harness } = driveSession();
    const gaps = harness.emissions.filter((emission) => emission.eventType === "FeedGapDetected");
    expect(gaps).toHaveLength(3);
    for (const gap of gaps) {
      expect((gap.payload as { requiresAuthoritativeSnapshot: boolean })
        .requiresAuthoritativeSnapshot).toBe(true);
    }
  });

  it("distinguishes the first subscription from a resubscription by reason code", () => {
    const { harness } = driveSession();
    const reasons = harness.emissions
      .filter((emission) => emission.eventType === "FeedGapDetected")
      .map((emission) => (emission.payload as { reasonCode: string }).reasonCode);
    expect(reasons).toEqual([
      "BINANCE_SUBSCRIPTION_START_NO_REPLAY",
      "BINANCE_RECONNECT_NO_REPLAY",
      "BINANCE_RECONNECT_NO_REPLAY",
    ]);
  });

  it("advances the subscription generation on every resubscription", () => {
    const { recorded } = driveSession();
    expect(recorded.filter((entry) => entry.step === "OPEN").map((entry) => entry.generation))
      .toEqual([0, 1, 2]);
  });

  it("stamps every emission with the generation and connection it belongs to", () => {
    const { harness } = driveSession();
    const trades = harness.emissions.filter(
      (emission) => emission.eventType === "ReferenceTradeObserved",
    );
    expect(trades.map((emission) => emission.subscriptionGeneration)).toEqual([0, 1]);
    expect(trades.map((emission) => emission.connectionId)).toEqual(["conn-a", "conn-b"]);
  });

  it("emits FeedDisconnected on every close and directs a backed-off reconnect", () => {
    const { harness, recorded } = driveSession();
    const closes = recorded.filter((entry) => entry.step === "CLOSE");
    expect(closes).toHaveLength(2);
    for (const entry of closes) {
      expect(entry.eventTypes).toEqual(["FeedDisconnected"]);
      expect(entry.directive).toBe("RECONNECT_AFTER");
    }
    const disconnects = harness.emissions.filter(
      (emission) => emission.eventType === "FeedDisconnected",
    );
    expect(
      disconnects.map((emission) => (emission.payload as { reasonCode: string }).reasonCode),
    ).toEqual(["BINANCE_SOCKET_CLOSED", "BINANCE_SOCKET_CLOSED"]);
  });

  it("surfaces the documented serverShutdown advisory without acting on it", () => {
    const { recorded } = driveSession();
    const notice = recorded.find((entry) => entry.label === "server-shutdown-notice");
    expect(notice?.classification).toBe("SERVER_SHUTDOWN");
    expect(notice?.directive).toBe("NONE");
  });

  it("still recognises a frame replayed across the reconnect as a duplicate", () => {
    const { recorded } = driveSession();
    const replay = recorded.find((entry) => entry.label === "trade-replayed-after-reconnect");
    expect(replay?.classification).toBe("DUPLICATE_SUPPRESSED");
    expect(replay?.eventTypes).toEqual([]);
  });

  it("does not fabricate the events that happened while disconnected", () => {
    const { harness } = driveSession();
    const tradeIds = harness.emissions
      .filter((emission) => emission.eventType === "ReferenceTradeObserved")
      .map((emission) => (emission.payload as { venueTradeId: string }).venueTradeId);
    // Trades 12346..12998 were never observed and are never invented; the gap
    // event is what records that they are missing.
    expect(tradeIds).toEqual(["12345", "12999"]);
  });

  it("reports the connection lifecycle in the metrics", () => {
    const { harness } = driveSession();
    const metrics = harness.feed.metrics(harness.clock.peek());
    expect(metrics.connections.connectionAttempts).toBe(3);
    expect(metrics.connections.connectionsOpened).toBe(3);
    expect(metrics.connections.disconnects).toBe(2);
    expect(metrics.subscriptionGeneration).toBe(2);
    expect(metrics.state).toBe("OPEN");
  });
});
