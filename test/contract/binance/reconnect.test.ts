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
import { closeSocket, createHarness, deliver, eventTypesOf, open } from "./support.js";

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
        // The harness records which socket is open, because every socket event
        // now carries the identity of the socket that produced it — and the
        // attempt is registered under that identity before the socket exists.
        harness.feed.connecting(step.connectionId);
        harness.connectionId = step.connectionId;
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
        const outcome = closeSocket(harness, stamp, {
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
        const outcome = deliver(harness, frameText(step), stamp);
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

/**
 * The reconnect path's hardest case: two sockets alive at once.
 *
 * A socket does not stop existing because a newer one replaced it. It can
 * deliver a buffered frame, an error, or its own close AFTER the replacement is
 * live, and every one of those callbacks used to be applied to whatever
 * connection was current at the time (round-1 review, finding H1). The venue
 * makes this concrete rather than theoretical: it documents both a 24-hour
 * connection lifetime and a `serverShutdown` notice instructing a client to
 * "establish a new connection as soon as possible", which is a make-before-break
 * reconnect with two live sockets by construction.
 */
describe("overlapping sockets", () => {
  const TRADE = (id: number): string =>
    JSON.stringify({
      stream: "bnbbtc@trade",
      data: {
        e: "trade",
        E: 1672515782136,
        s: "BNBBTC",
        t: id,
        p: "0.001",
        q: "100",
        T: 1672515782136,
        m: true,
      },
    });

  it("records a frame under the socket that delivered it, never under another", () => {
    const harness = createHarness();
    open(harness, "conn-a");
    harness.emissions.push(
      ...harness.feed.onFrame("conn-a", TRADE(1), harness.clock.advance(1)).emissions,
    );

    // conn-b opens while conn-a is still alive (make-before-break).
    open(harness, "conn-b");
    const late = harness.feed.onFrame("conn-a", TRADE(2), harness.clock.advance(1));

    expect(late.classification).toBe("STALE_CONNECTION");
    expect(eventTypesOf(late.emissions)).not.toContain("ReferenceTradeObserved");
    const trades = harness.emissions.filter(
      (emission) => emission.eventType === "ReferenceTradeObserved",
    );
    expect(trades.map((emission) => emission.connectionId)).toEqual(["conn-a"]);
    expect(trades.map((emission) => emission.subscriptionGeneration)).toEqual([0]);
  });

  it("ignores a delayed callback from a socket that has already been replaced", () => {
    const harness = createHarness();
    open(harness, "conn-a");
    closeSocket(harness, harness.clock.advance(1), { code: 1006 });
    open(harness, "conn-b");

    const before = harness.feed.metrics(harness.clock.peek());
    const staleClose = harness.feed.onClose("conn-a", harness.clock.advance(1), { code: 1006 });
    const staleError = harness.feed.onSocketError("conn-a", harness.clock.advance(1), {
      detail: "delayed",
    });
    const after = harness.feed.metrics(harness.clock.peek());

    expect(eventTypesOf(staleClose.emissions)).not.toContain("FeedDisconnected");
    expect(staleClose.directive.kind).toBe("NONE");
    expect(staleError.rejected?.relation).toBe("RETIRED");
    expect(after.state).toBe("OPEN");
    expect(after.connectionId).toBe("conn-b");
    expect(after.connections.disconnects).toBe(before.connections.disconnects);
    expect(after.connections.socketErrors).toBe(before.connections.socketErrors);
    expect(after.connections.lifecycleEventsNotFromLiveConnection).toBe(2);
  });

  it("still recognises a trade replayed after the reconnect, even out of order", () => {
    // The reconnect fixture's replay arrives immediately; here a NEWER trade
    // arrives first, which is the schedule that used to defeat duplicate
    // detection entirely (round-1 review, finding M2).
    const harness = createHarness();
    open(harness, "conn-a");
    harness.feed.onFrame("conn-a", TRADE(12_345), harness.clock.advance(1));
    closeSocket(harness, harness.clock.advance(1), { code: 1006 });
    open(harness, "conn-b");
    harness.feed.onFrame("conn-b", TRADE(12_999), harness.clock.advance(1));

    const replay = harness.feed.onFrame("conn-b", TRADE(12_345), harness.clock.advance(1));
    expect(replay.classification).toBe("DUPLICATE_SUPPRESSED");
    expect(replay.emissions).toEqual([]);
    expect(harness.feed.metrics(harness.clock.peek()).frames.lateTradesEmitted).toBe(0);
  });
});

/**
 * A reconnect is directed by the feed's OWN sockets, and by nothing else.
 *
 * The reconnect path's other hard case: an event that is well formed, carries a
 * plausible identity, and belongs to no connection this feed ever authorized.
 * Accepting one while nothing was live meant a fresh feed could be "disconnected"
 * before it had ever connected, and a forged close during a replacement's
 * connecting interval could spend the caller's last reconnect attempt and stop
 * the feed for good (round-2 review, finding R2-M1).
 */
describe("unauthorized lifecycle events", () => {
  it("does not disconnect or reconnect a feed that never authorized the socket", () => {
    const harness = createHarness();
    const close = harness.feed.onClose("forged-identity", harness.clock.advance(1), {
      code: 1006,
    });

    expect(eventTypesOf(close.emissions)).not.toContain("FeedDisconnected");
    expect(close.directive.kind).toBe("NONE");
    expect(close.rejected?.relation).toBe("UNKNOWN");

    const metrics = harness.feed.metrics(harness.clock.peek());
    expect(metrics.state).toBe("IDLE");
    expect(metrics.connections.connectionAttempts).toBe(0);
    expect(metrics.connections.disconnects).toBe(0);
    // Refused, and recorded: a refusal that left no trace would be the silent
    // drop §8.3 forbids.
    expect(metrics.connections.lifecycleEventsNotFromLiveConnection).toBe(1);
    expect(metrics.openIncidentReasonCodes).toEqual([
      "BINANCE_UNAUTHORIZED_CONNECTION_EVENT",
    ]);
  });

  it("keeps the reconnect budget for the attempt the caller actually registered", () => {
    const harness = createHarness({
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, multiplier: 2, maxAttempts: 1 },
    });
    open(harness, "conn-a");
    expect(closeSocket(harness, harness.clock.advance(1), { code: 1006 }).directive).toEqual({
      kind: "RECONNECT_AFTER",
      delayMs: 10,
      attempt: 1,
    });

    // The replacement is registered; its socket has not opened yet.
    harness.feed.connecting("conn-b");
    const forged = harness.feed.onClose("forged-identity", harness.clock.advance(1), {
      code: 1006,
    });
    expect(eventTypesOf(forged.emissions)).not.toContain("FeedDisconnected");
    expect(forged.directive.kind).toBe("NONE");

    const authorized = harness.feed.onClose("conn-b", harness.clock.advance(1), { code: 1006 });
    expect(eventTypesOf(authorized.emissions)).toEqual(["FeedDisconnected"]);
    expect(authorized.directive).toEqual({
      kind: "STOP",
      reason: "RECONNECT_ATTEMPTS_EXHAUSTED",
    });
  });

  it("opens no connection for an identity the caller never registered", () => {
    const harness = createHarness();
    open(harness, "conn-a");
    const forged = harness.feed.onOpen("forged-identity", harness.clock.advance(1));

    expect(eventTypesOf(forged.emissions)).not.toContain("FeedConnected");
    expect(forged.rejected?.relation).toBe("UNKNOWN");
    const metrics = harness.feed.metrics(harness.clock.peek());
    expect(metrics.connectionId).toBe("conn-a");
    expect(metrics.subscriptionGeneration).toBe(0);
    expect(metrics.connections.connectionsOpened).toBe(1);
  });

  it("counts no error against a feed the caller has already shut down", () => {
    const harness = createHarness();
    open(harness, "conn-a");
    harness.feed.close(harness.clock.advance(1), "operator shutdown");

    const forged = harness.feed.onSocketError("forged-identity", harness.clock.advance(1), {
      detail: "noise",
    });
    expect(forged.rejected?.relation).toBe("UNKNOWN");
    expect(forged.directive).toEqual({ kind: "STOP", reason: "CLOSED_BY_CALLER" });
    expect(harness.feed.metrics(harness.clock.peek()).connections.socketErrors).toBe(0);
  });
});

/**
 * Make-before-break means the OLD socket keeps working (round-3 review, R3-M1).
 *
 * The venue's own `serverShutdown` notice asks a client to "establish a new
 * connection as soon as possible to prevent interruption", which is precisely a
 * second socket opened while the first still carries data. Registering that
 * second attempt used to move the feed to `CONNECTING`, and the frame gate and
 * the staleness check both require `OPEN` — so during the replacement interval
 * the live socket's own market data was refused as "a frame with no live socket"
 * and its silence went unreported. A slow or failed replacement therefore
 * discarded good data indefinitely.
 */
describe("make-before-break replacement", () => {
  const TRADE = (id: number): string =>
    JSON.stringify({
      stream: "bnbbtc@trade",
      data: {
        e: "trade",
        E: 1672515782136,
        s: "BNBBTC",
        t: id,
        p: "0.001",
        q: "100",
        T: 1672515782136,
        m: true,
      },
    });

  it("keeps publishing the live socket's frames before and after the replacement's refused close", () => {
    const harness = createHarness({ stalenessThresholdMs: 10_000 });
    open(harness, "conn-a");

    // The driver registers the replacement attempt; its socket has not opened.
    harness.feed.connecting("conn-b");
    const metrics = harness.feed.metrics(harness.clock.peek());
    expect(metrics.state).toBe("OPEN");
    expect(metrics.connectionId).toBe("conn-a");
    expect(metrics.pendingConnectionId).toBe("conn-b");

    const during = harness.feed.onFrame("conn-a", TRADE(1), harness.clock.advance(1));
    expect(during.classification).toBe("NORMALIZED");
    expect(eventTypesOf(during.emissions)).toEqual(["ReferenceTradeObserved"]);

    // The replacement fails before it opens: refused, and the live feed carries on.
    const refused = harness.feed.onClose("conn-b", harness.clock.advance(1), { code: 1006 });
    expect(eventTypesOf(refused.emissions)).not.toContain("FeedDisconnected");
    expect(refused.directive.kind).toBe("NONE");

    const after = harness.feed.onFrame("conn-a", TRADE(2), harness.clock.advance(1));
    expect(after.classification).toBe("NORMALIZED");
    const trades = [...during.emissions, ...after.emissions].filter(
      (emission) => emission.eventType === "ReferenceTradeObserved",
    );
    expect(trades.map((emission) => emission.connectionId)).toEqual(["conn-a", "conn-a"]);
    expect(trades.map((emission) => emission.subscriptionGeneration)).toEqual([0, 0]);

    const final = harness.feed.metrics(harness.clock.peek());
    expect(final.frames.tradesNormalized).toBe(2);
    expect(final.frames.framesNotFromLiveConnection).toBe(0);
    expect(final.connections.disconnects).toBe(0);
  });

  it("still reports the live socket's silence during the replacement interval", () => {
    const harness = createHarness({ stalenessThresholdMs: 10_000 });
    open(harness, "conn-a");
    harness.feed.onFrame("conn-a", TRADE(1), harness.clock.advance(1_000));
    harness.feed.connecting("conn-b");
    harness.feed.onClose("conn-b", harness.clock.advance(1), { code: 1006 });

    const stale = harness.feed.checkStaleness(harness.clock.advance(10_000));
    expect(eventTypesOf(stale.emissions)).toEqual(["FeedStale"]);
    expect(harness.feed.metrics(harness.clock.peek()).connections.staleEpisodes).toBe(1);
  });

  it("records the replacement's own failure as an attempt, not as an intruder", () => {
    const harness = createHarness();
    open(harness, "conn-a");
    harness.feed.connecting("conn-b");
    const refused = harness.feed.onClose("conn-b", harness.clock.advance(1), { code: 1006 });

    expect(refused.rejected?.relation).toBe("PENDING");
    const incident = refused.emissions[0]?.payload as { reasonCode: string };
    expect(incident.reasonCode).toBe("BINANCE_PENDING_ATTEMPT_EVENT_INADMISSIBLE");

    // The unauthorized code keeps its meaning: an identity nobody registered.
    const forged = harness.feed.onClose("forged-identity", harness.clock.advance(1), {
      code: 1006,
    });
    expect((forged.emissions[0]?.payload as { reasonCode: string }).reasonCode).toBe(
      "BINANCE_UNAUTHORIZED_CONNECTION_EVENT",
    );
    expect(harness.feed.metrics(harness.clock.peek()).openIncidentReasonCodes).toContain(
      "BINANCE_PENDING_ATTEMPT_EVENT_INADMISSIBLE",
    );
  });

  /**
   * The handover's other outcome: the live socket goes away first (R4-M1).
   *
   * A driver obeys the returned directive — that is the whole contract of this
   * package — so `RECONNECT_AFTER` while its own replacement was still in flight
   * told it to register a third identity, retiring the socket it had already
   * opened and racing a second connection at the venue, against a documented
   * budget of 300 attempts per five minutes. `state` reported `IDLE` for a feed
   * that was connecting, and the caller's `maxAttempts` was charged for an
   * attempt that had not failed.
   */
  describe("the live socket closes while the replacement is still opening", () => {
    it("retains the authorization, reports CONNECTING, and directs no second attempt", () => {
      const harness = createHarness({ stalenessThresholdMs: 10_000 });
      open(harness, "conn-a");
      harness.feed.onFrame("conn-a", TRADE(1), harness.clock.advance(1));
      harness.feed.connecting("conn-b");

      const close = harness.feed.onClose("conn-a", harness.clock.advance(1), { code: 1006 });
      harness.emissions.push(...close.emissions);

      // The interruption is reported for the socket that closed…
      expect(eventTypesOf(close.emissions)).toEqual(["FeedDisconnected"]);
      expect(close.emissions[0]?.connectionId).toBe("conn-a");
      // …and the driver is told to do nothing, because it already is.
      expect(close.directive).toEqual({ kind: "NONE" });

      const metrics = harness.feed.metrics(harness.clock.peek());
      expect(metrics.state).toBe("CONNECTING");
      expect(metrics.connectionId).toBeUndefined();
      expect(metrics.pendingConnectionId).toBe("conn-b");
      expect(metrics.connections.disconnects).toBe(1);
      // One outage, one attempt registered by the driver: no third connection.
      expect(metrics.connections.connectionAttempts).toBe(2);
    });

    it("adopts that replacement when it opens, with a new generation and no gap in the books", () => {
      const harness = createHarness({ stalenessThresholdMs: 10_000 });
      open(harness, "conn-a");
      harness.emissions.push(
        ...harness.feed.onFrame("conn-a", TRADE(1), harness.clock.advance(1)).emissions,
      );
      harness.feed.connecting("conn-b");
      harness.emissions.push(
        ...harness.feed.onClose("conn-a", harness.clock.advance(1), { code: 1006 }).emissions,
      );

      const opened = harness.feed.onOpen("conn-b", harness.clock.advance(1_000));
      harness.emissions.push(...opened.emissions);
      expect(eventTypesOf(opened.emissions)).toEqual([
        "FeedConnected",
        "FeedGapDetected",
        "DataQualityIncidentOpened",
      ]);
      expect((opened.emissions[1]?.payload as { requiresAuthoritativeSnapshot: boolean })
        .requiresAuthoritativeSnapshot).toBe(true);
      expect(eventTypesOf(harness.emissions)).not.toContain("FeedResynchronized");

      harness.emissions.push(
        ...harness.feed.onFrame("conn-b", TRADE(2), harness.clock.advance(1)).emissions,
      );
      const trades = harness.emissions.filter(
        (emission) => emission.eventType === "ReferenceTradeObserved",
      );
      expect(trades.map((emission) => emission.connectionId)).toEqual(["conn-a", "conn-b"]);
      expect(trades.map((emission) => emission.subscriptionGeneration)).toEqual([0, 1]);

      // The shared sequence tracker survives the handover, so a replay across it
      // is still a duplicate rather than a second publication.
      const replay = harness.feed.onFrame("conn-b", TRADE(1), harness.clock.advance(1));
      expect(replay.classification).toBe("DUPLICATE_SUPPRESSED");

      const metrics = harness.feed.metrics(harness.clock.peek());
      expect(metrics.state).toBe("OPEN");
      expect(metrics.connectionId).toBe("conn-b");
      expect(metrics.pendingConnectionId).toBeUndefined();
      expect(metrics.connections.connectionsOpened).toBe(2);
    });

    it("makes exactly one reconnect decision when the replacement fails as well", () => {
      const harness = createHarness();
      open(harness, "conn-a");
      harness.feed.connecting("conn-b");

      const liveClose = harness.feed.onClose("conn-a", harness.clock.advance(1), { code: 1006 });
      const attemptClose = harness.feed.onClose("conn-b", harness.clock.advance(1), { code: 1006 });

      const directives = [liveClose.directive, attemptClose.directive];
      expect(directives.filter((directive) => directive.kind === "RECONNECT_AFTER")).toHaveLength(
        1,
      );
      expect(attemptClose.directive).toEqual({
        kind: "RECONNECT_AFTER",
        delayMs: 1_000,
        attempt: 1,
      });
      expect(harness.feed.metrics(harness.clock.peek()).state).toBe("IDLE");
    });

    it("keeps the attempt budget intact across the interleaving", () => {
      const harness = createHarness({
        reconnect: { initialDelayMs: 10, maxDelayMs: 20, multiplier: 2, maxAttempts: 1 },
      });
      open(harness, "conn-a");
      harness.feed.connecting("conn-b");

      expect(harness.feed.onClose("conn-a", harness.clock.advance(1), { code: 1006 }).directive)
        .toEqual({ kind: "NONE" });
      // The one attempt the caller allowed is spent by the attempt that failed…
      expect(harness.feed.onClose("conn-b", harness.clock.advance(1), { code: 1006 }).directive)
        .toEqual({ kind: "RECONNECT_AFTER", delayMs: 10, attempt: 1 });

      // …and only the NEXT failure exhausts it.
      harness.feed.connecting("conn-c");
      expect(harness.feed.onClose("conn-c", harness.clock.advance(1), { code: 1006 }).directive)
        .toEqual({ kind: "STOP", reason: "RECONNECT_ATTEMPTS_EXHAUSTED" });
    });

    it("still directs a reconnect for a live close with nothing in flight", () => {
      const harness = createHarness();
      open(harness, "conn-a");
      const close = closeSocket(harness, harness.clock.advance(1), { code: 1006 });

      expect(eventTypesOf(close.emissions)).toEqual(["FeedDisconnected"]);
      expect(close.directive).toEqual({ kind: "RECONNECT_AFTER", delayMs: 1_000, attempt: 1 });
      expect(harness.feed.metrics(harness.clock.peek()).state).toBe("IDLE");
    });
  });
});
