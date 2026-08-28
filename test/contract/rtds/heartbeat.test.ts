/**
 * The RTDS heartbeat, in the direction the venue documents it.
 *
 * Verbatim (accessed 2026-08-28): "RTDS uses an application-level heartbeat.
 * Send the text frame PING every 5 seconds to maintain the connection."
 *
 * The CLIENT sends it. Nothing is documented coming back — a different rule from
 * the CLOB market channel, where the server replies `PONG` — so this suite pins
 * both the sending cadence and the deliberate refusal to model a reply.
 */

import {
  ManualScheduler,
  fakeWebSocketFactory,
  sequentialConnectionIds,
} from "@polymarket-bot/polymarket-public/testing";
import {
  RTDS_HEARTBEAT_INTERVAL_MS,
  RTDS_HEARTBEAT_REQUEST,
  RtdsTwapFeed,
  type NormalizedRtdsEventAny,
  type RtdsProblem,
} from "@polymarket-bot/polymarket-public/rtds";
import { describe, expect, it } from "vitest";

function harness(options: Record<string, unknown> = {}) {
  const scheduler = new ManualScheduler(Date.UTC(2026, 6, 27, 19, 0, 0));
  const { factory, sockets, latest } = fakeWebSocketFactory();
  const events: NormalizedRtdsEventAny[] = [];
  const problems: RtdsProblem[] = [];
  const feed = new RtdsTwapFeed(
    {
      clock: scheduler.clock,
      timers: scheduler.timers,
      webSocketFactory: factory,
      connectionId: sequentialConnectionIds(),
    },
    {
      onEvent: (event) => events.push(event),
      onProblem: (problem) => problems.push(problem),
    },
    { subscriptions: [{ windowSeconds: 30 }], ...options },
  );
  return { feed, scheduler, sockets, latest, events, problems };
}

describe("the client sends PING every 5 seconds", () => {
  it("uses the documented cadence and the documented text frame", () => {
    expect(RTDS_HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(RTDS_HEARTBEAT_REQUEST).toBe("PING");

    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(30_000);
    const heartbeats = context.latest().sent.filter((frame) => frame === "PING");
    expect(heartbeats).toHaveLength(6);
    expect(context.feed.metrics().heartbeatsSent).toBe(6);
  });

  it("starts the cadence only once the socket is open and subscribed", () => {
    const context = harness();
    context.feed.start();
    context.scheduler.advance(30_000);
    expect(context.latest().sent).toEqual([]);
    context.latest().emitOpen();
    context.scheduler.advance(5_000);
    expect(context.latest().sent.slice(1)).toEqual(["PING"]);
  });

  it("resumes the cadence on the replacement socket after a reconnect", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(5_000);
    context.latest().emitClose({ code: 1006 });
    context.scheduler.advance(1_000);
    context.latest().emitOpen();
    context.scheduler.advance(10_000);
    expect(context.sockets[1]?.sent.filter((frame) => frame === "PING")).toHaveLength(2);
    // And the retired socket received nothing more.
    expect(context.sockets[0]?.sent.filter((frame) => frame === "PING")).toHaveLength(1);
  });
});

describe("no server reply is modelled", () => {
  it("never waits for a PONG before treating the connection as usable", () => {
    const context = harness({ updateStalenessMs: 60_000 });
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(30_000);
    // No inbound frame at all, and the feed is still open and healthy: nothing
    // here models a server-side heartbeat contract that is not documented.
    expect(context.feed.metrics().status).toBe("open");
    expect(context.events.map((event) => event.eventType)).toEqual(["FeedConnected"]);
  });

  it("surfaces a bare PONG once, then counts it, rather than assuming it", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    for (let index = 0; index < 5; index += 1) context.latest().emitMessage("PONG");

    expect(context.problems).toHaveLength(1);
    expect(context.problems[0]?.code).toBe("RTDS_UNDOCUMENTED_HEARTBEAT_TEXT");
    expect(context.problems[0]?.raw).toBe("PONG");
    expect(context.problems[0]?.detail).toContain("documents no server reply");
    expect(context.feed.metrics().heartbeatTextFramesReceived).toBe(5);
  });

  it("reports it again on a new connection, because the fact is per-connection", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitMessage("PONG");
    context.latest().emitClose({});
    context.scheduler.advance(1_000);
    context.latest().emitOpen();
    context.latest().emitMessage("PONG");
    expect(context.problems).toHaveLength(2);
    expect(context.problems[1]?.detail).toContain("conn-2");
  });

  it("does not let a heartbeat frame stand in for a TWAP update", () => {
    // A live socket is not a fresh price: staleness is measured on DATA.
    const context = harness({ updateStalenessMs: 30_000, stalenessCheckIntervalMs: 5_000 });
    context.feed.start();
    context.latest().emitOpen();
    for (let index = 0; index < 8; index += 1) {
      context.scheduler.advance(5_000);
      context.latest().emitMessage("PONG");
    }
    expect(context.events.map((event) => event.eventType)).toContain("FeedStale");
    expect(context.feed.metrics().lastFrameAt).toBeDefined();
    expect(context.feed.metrics().lastObservationAt).toBeUndefined();
  });
});
