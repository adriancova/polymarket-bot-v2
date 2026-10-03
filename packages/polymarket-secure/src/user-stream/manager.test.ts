/**
 * WP-280: the user-stream subscription manager — its state machine, and the
 * acceptance criterion "Reconnect always requests reconciliation".
 *
 * Every loss path (the socket closed by the server, a stale heartbeat, a
 * server error, an authentication failure, and the other transport losses) is
 * driven through the fake port, and each must:
 *
 * 1. request reconciliation at the loss, with that loss as the cause;
 * 2. reconnect after the backoff, and request reconciliation AGAIN once the
 *    new subscription frame is sent (`RESUBSCRIBED`, naming the loss);
 * 3. keep both requests in the backlog until they are acknowledged.
 *
 * Every test installs WP-260's network tripwire and fails on any network
 * attempt. No socket exists: the port is a fake fed by the test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../testing/network-tripwire.js";

import {
  createUserStreamManager,
  MAX_PENDING_RECONCILIATION_REQUESTS,
  USER_STREAM_STATES,
  USER_STREAM_TRANSITIONS,
  UserStreamConfigurationError,
  type StreamLossCause,
  type UserStreamOutput,
} from "./manager.js";
import { FakeUserSocketPort, ManualTimers } from "./testing/fake-socket-port.js";
import { FIXTURE_MARKET, FIXTURE_OWNER, LIVE_SHAPED_CONTEXT, OTHER_MARKET, openUserStream, type UserStreamHarness } from "./testing/harness.js";
import { DEFAULT_INITIAL_BACKOFF_MS, DEFAULT_STALE_AFTER_MS, PING_INTERVAL_MS } from "./venue-facts.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const ORDER_FRAME = JSON.stringify({
  event_type: "order",
  type: "PLACEMENT",
  id: "0x00000000000000000000000000000000000000000000000000000000feed0001",
  owner: FIXTURE_OWNER,
  market: FIXTURE_MARKET,
  asset_id: "107505882767731489358349912513945399560393482969656700824895970500493757150417",
  side: "BUY",
  original_size: "100",
  size_matched: "0",
  price: "0.08",
  status: "LIVE",
  timestamp: "1782753357257",
});

/**
 * Each loss path: how to cause it on a SUBSCRIBED stream, and the cause the
 * request must carry. The first four are the packet's named paths.
 */
const LOSS_PATHS: readonly { readonly name: string; readonly cause: StreamLossCause; readonly lose: (h: UserStreamHarness) => void }[] = [
  { name: "socket close", cause: "SOCKET_CLOSED", lose: (h) => h.port.latest.drop("CLOSED_BY_PEER") },
  { name: "heartbeat stale", cause: "HEARTBEAT_STALE", lose: (h) => h.timers.advance(DEFAULT_STALE_AFTER_MS) },
  { name: "server error", cause: "SERVER_ERROR", lose: (h) => h.port.latest.drop("SERVER_ERROR") },
  { name: "auth failure", cause: "AUTH_REJECTED", lose: (h) => h.port.latest.drop("AUTH_REJECTED") },
  { name: "transport error", cause: "TRANSPORT_ERROR", lose: (h) => h.port.latest.drop("TRANSPORT_ERROR") },
  {
    name: "an unclassified close",
    cause: "UNCLASSIFIED_CLOSE",
    lose: (h) => h.port.latest.drop("SOMETHING_ELSE" as never),
  },
  {
    name: "a failed PING send",
    cause: "SEND_FAILED",
    lose: (h) => {
      h.port.latest.failNext = "ping";
      h.timers.advance(PING_INTERVAL_MS);
    },
  },
];

describe("the state machine", () => {
  it("IDLE → CONNECTING → SUBSCRIBED: the subscription frame carries the markets and nothing else, sent on open", () => {
    const h = openUserStream({ markets: [FIXTURE_MARKET, OTHER_MARKET] });
    expect(h.manager.state()).toBe("IDLE");
    expect(h.port.connectCalls).toBe(0);
    expect(h.manager.start()).toBe(true);
    expect(h.manager.state()).toBe("CONNECTING");
    expect(h.port.connectCalls).toBe(1);
    expect(h.port.latest.sent).toEqual([]);
    h.port.latest.open();
    expect(h.manager.state()).toBe("SUBSCRIBED");
    expect(h.port.latest.sent).toEqual([{ kind: "subscribe", markets: [FIXTURE_MARKET, OTHER_MARKET] }]);
    expect(h.transitions()).toEqual(["IDLE→CONNECTING", "CONNECTING→SUBSCRIBED"]);
    expect(h.manager.start()).toBe(false);
  });

  it("the first subscription requests reconciliation (SUBSCRIPTION_STARTED): nothing before it is on the stream", () => {
    const h = openUserStream();
    h.manager.start();
    h.port.latest.open();
    expect(h.requests().map((request) => [request.cause, request.afterLoss, request.markets])).toEqual([["SUBSCRIPTION_STARTED", null, [FIXTURE_MARKET]]]);
    expect(h.manager.pendingReconciliationRequests().map((request) => request.cause)).toEqual(["SUBSCRIPTION_STARTED"]);
  });

  it("sends PING every 10 s while subscribed, and a PONG keeps the stream fresh", () => {
    const h = openUserStream();
    h.subscribe();
    for (let tick = 1; tick <= 6; tick += 1) {
      h.timers.advance(PING_INTERVAL_MS);
      h.port.latest.deliver("PONG");
    }
    expect(h.port.latest.sent.filter((frame) => frame.kind === "ping")).toHaveLength(6);
    expect(h.manager.state()).toBe("SUBSCRIBED");
    expect(h.requests()).toEqual([]);
    expect(h.manager.diagnostics().pongsReceived).toBe(6);
  });

  it("every emitted transition is in the table, and the table covers exactly the documented states", () => {
    expect(Object.keys(USER_STREAM_TRANSITIONS).sort()).toEqual([...USER_STREAM_STATES].sort());
    const h = openUserStream();
    h.subscribe();
    for (const path of LOSS_PATHS) {
      path.lose(h);
      h.timers.advance(60_000);
      h.port.latest.open();
    }
    h.manager.stop();
    const states = h.outputs.flatMap((output) => (output.kind === "STATE" ? [output] : []));
    expect(states.length).toBeGreaterThan(20);
    for (const { from, to } of states) expect(USER_STREAM_TRANSITIONS[from]).toContain(to);
  });

  it("stop closes the connection, cancels every timer, requests reconciliation for the live stream, and is final", () => {
    const h = openUserStream();
    h.subscribe();
    const connection = h.port.latest;
    h.manager.stop();
    expect(h.manager.state()).toBe("CLOSED");
    expect(connection.closeCalls).toBe(1);
    expect(h.timers.pendingCount()).toBe(0);
    expect(h.requests().map((request) => request.cause)).toEqual(["STREAM_STOPPED"]);
    h.timers.advance(10 * 60_000);
    expect(h.port.connectCalls).toBe(1);
    expect(h.manager.start()).toBe(false);
    h.manager.stop();
    expect(h.transitions()).toEqual(["SUBSCRIBED→CLOSED"]);
  });

  it("a connect timeout is a loss (CONNECT_TIMEOUT)", () => {
    const h = openUserStream({ connectTimeoutMs: 5_000 });
    h.manager.start();
    h.timers.advance(5_000);
    expect(h.requests().map((request) => request.cause)).toEqual(["CONNECT_TIMEOUT"]);
    expect(h.port.connections[0]?.closeCalls).toBe(1);
    expect(h.manager.state()).toBe("RECONNECTING");
  });

  it("a connect that throws is a loss (CONNECT_FAILED), and a subscription send that throws is a loss (SEND_FAILED)", () => {
    const h = openUserStream();
    h.port.failNextConnect = true;
    h.manager.start();
    expect(h.requests().map((request) => request.cause)).toEqual(["CONNECT_FAILED"]);
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.failNext = "subscribe";
    h.port.latest.open();
    expect(h.requests().map((request) => request.cause)).toEqual(["CONNECT_FAILED", "SEND_FAILED"]);
    expect(h.manager.state()).toBe("RECONNECTING");
  });

  it("backoff doubles to the maximum and resets after a successful subscription", () => {
    const h = openUserStream({ initialBackoffMs: 1_000, maxBackoffMs: 4_000 });
    h.subscribe();
    const delays: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      h.port.latest.drop("TRANSPORT_ERROR");
      const before = h.port.connectCalls;
      let waited = 0;
      while (h.port.connectCalls === before) {
        h.timers.advance(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);
    h.port.latest.open();
    h.port.latest.drop("TRANSPORT_ERROR");
    const before = h.port.connectCalls;
    h.timers.advance(999);
    expect(h.port.connectCalls).toBe(before);
    h.timers.advance(1);
    expect(h.port.connectCalls).toBe(before + 1);
  });
});

describe("every reconnect requests reconciliation (acceptance 2)", () => {
  for (const path of LOSS_PATHS) {
    it(`${path.name}: a request at the loss (${path.cause}), and another after resubscribing (RESUBSCRIBED)`, () => {
      const h = openUserStream({ markets: [FIXTURE_MARKET, OTHER_MARKET] });
      h.subscribe();
      const first = h.port.latest;
      path.lose(h);

      // 1. At the loss.
      expect(h.requests().map((request) => request.cause)).toEqual([path.cause]);
      expect(h.requests()[0]?.markets).toEqual([FIXTURE_MARKET, OTHER_MARKET]);
      expect(h.manager.state()).toBe("RECONNECTING");
      expect(first.closeCalls).toBe(1);
      expect(h.transitions().at(-2)).toBe(path.cause === "HEARTBEAT_STALE" ? "STALE→DISCONNECTED" : "SUBSCRIBED→DISCONNECTED");
      expect(h.transitions().at(-1)).toBe("DISCONNECTED→RECONNECTING");

      // 2. The reconnect, and the request after the new subscription.
      h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
      expect(h.port.connections).toHaveLength(2);
      h.port.latest.open();
      expect(h.manager.state()).toBe("SUBSCRIBED");
      expect(h.port.latest.sent[0]).toEqual({ kind: "subscribe", markets: [FIXTURE_MARKET, OTHER_MARKET] });
      const requests = h.requests();
      expect(requests.map((request) => request.cause)).toEqual([path.cause, "RESUBSCRIBED"]);
      expect(requests[1]?.afterLoss).toBe(path.cause);
      expect(requests[1]?.subscriptionGeneration).toBe(2);
      expect(requests[1]?.markets).toEqual([FIXTURE_MARKET, OTHER_MARKET]);

      // 3. Both are held until acknowledged (SUBSCRIPTION_STARTED was cleared by `subscribe`'s record reset, not acknowledged).
      const pending = h.manager.pendingReconciliationRequests().map((request) => request.cause);
      expect(pending).toEqual(["SUBSCRIPTION_STARTED", path.cause, "RESUBSCRIBED"]);
      for (const request of h.manager.pendingReconciliationRequests()) expect(h.manager.acknowledgeReconciliationRequest(request.requestId)).toBe(true);
      expect(h.manager.pendingReconciliationRequests()).toEqual([]);
      expect(h.manager.acknowledgeReconciliationRequest(requests[0]?.requestId ?? "")).toBe(false);
    });
  }

  it("a loss before the first subscription still requests reconciliation, and the first subscription after it is RESUBSCRIBED", () => {
    const h = openUserStream();
    h.manager.start();
    h.port.latest.drop("SERVER_ERROR");
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    expect(h.requests().map((request) => [request.cause, request.afterLoss])).toEqual([
      ["SERVER_ERROR", null],
      ["RESUBSCRIBED", "SERVER_ERROR"],
    ]);
  });

  it("repeated losses each request reconciliation; nothing is coalesced away", () => {
    const h = openUserStream();
    h.subscribe();
    for (let round = 0; round < 5; round += 1) {
      h.port.latest.drop("CLOSED_BY_PEER");
      // The backoff resets after every successful subscription.
      h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
      h.port.latest.open();
    }
    expect(h.requests().map((request) => request.cause)).toEqual(Array.from({ length: 5 }, () => ["SOCKET_CLOSED", "RESUBSCRIBED"]).flat());
    expect(new Set(h.requests().map((request) => request.requestId)).size).toBe(10);
  });

  it("a listener that throws loses nothing: every request stays in the backlog", () => {
    const h = openUserStream({
      onOutput: () => {
        throw new Error("listener down");
      },
    });
    h.manager.start();
    h.port.latest.open();
    h.port.latest.drop("AUTH_REJECTED");
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    expect(h.manager.pendingReconciliationRequests().map((request) => request.cause)).toEqual(["SUBSCRIPTION_STARTED", "AUTH_REJECTED", "RESUBSCRIBED"]);
    expect(h.manager.diagnostics().listenerFailures).toBeGreaterThan(0);
    expect(h.manager.state()).toBe("SUBSCRIBED");
  });

  it("the backlog is bounded, and a full backlog keeps one BACKLOG_OVERFLOW request that covers every market", () => {
    const h = openUserStream();
    h.subscribe();
    for (let index = 0; index < MAX_PENDING_RECONCILIATION_REQUESTS + 10; index += 1) h.port.latest.deliver("not json");
    const pending = h.manager.pendingReconciliationRequests();
    expect(pending).toHaveLength(MAX_PENDING_RECONCILIATION_REQUESTS);
    expect(pending.filter((request) => request.cause === "BACKLOG_OVERFLOW")).toHaveLength(1);
    expect(pending.at(-1)?.cause).toBe("BACKLOG_OVERFLOW");
    expect(pending.at(-1)?.markets).toEqual([FIXTURE_MARKET]);
    // Every request was still emitted.
    expect(h.requests().filter((request) => request.cause === "UNRECOGNIZED_MESSAGE")).toHaveLength(MAX_PENDING_RECONCILIATION_REQUESTS + 10);
  });
});

describe("messages", () => {
  it("emits normalized events with their OMS projection and a receipt from the injected clock", () => {
    const h = openUserStream();
    h.subscribe();
    h.port.latest.deliver(ORDER_FRAME);
    const order = h.outputs.find((output) => output.kind === "ORDER");
    expect(order).toMatchObject({
      kind: "ORDER",
      event: { venueOrderId: "0x00000000000000000000000000000000000000000000000000000000feed0001", status: { kind: "KNOWN", value: "LIVE" } },
      oms: { observation: { venueOrderId: "0x00000000000000000000000000000000000000000000000000000000feed0001", status: "LIVE" }, shortfalls: [] },
      receipt: { subscriptionGeneration: 1, frameSequence: 1, indexInFrame: 0, receivedAt: new Date(h.timers.now()).toISOString() },
    });
    expect(h.requests()).toEqual([]);
  });

  it("an unrecognized message is surfaced, never dropped, and requests reconciliation (a gap in what was applied)", () => {
    const h = openUserStream();
    h.subscribe();
    h.port.latest.deliver(JSON.stringify({ event_type: "something_new", id: "x" }));
    expect(h.outputs.map((output) => output.kind)).toEqual(["UNRECOGNIZED_MESSAGE", "RECONCILIATION_REQUESTED"]);
    expect(h.requests()[0]).toMatchObject({ cause: "UNRECOGNIZED_MESSAGE", unrecognized: "UNKNOWN_EVENT_TYPE" });
  });

  it("an event the OMS projection cannot fully apply requests reconciliation naming its identifiers", () => {
    const h = openUserStream();
    h.subscribe();
    h.port.latest.deliver(JSON.stringify({ ...JSON.parse(ORDER_FRAME), status: "EXPIRED" }));
    expect(h.requests()[0]).toMatchObject({
      cause: "EVENT_NOT_FULLY_APPLICABLE",
      shortfalls: ["ORDER_STATUS_UNRECOGNIZED"],
      venueOrderIds: ["0x00000000000000000000000000000000000000000000000000000000feed0001"],
      markets: [FIXTURE_MARKET],
    });
  });

  it("a trade event the OMS projection cannot fully apply requests reconciliation naming the trade and its order ids (C-3)", () => {
    const h = openUserStream();
    h.subscribe();
    h.port.latest.deliver(
      JSON.stringify({
        event_type: "trade",
        type: "TRADE",
        id: "trade-c3",
        taker_order_id: "0xfeed0004",
        market: FIXTURE_MARKET,
        asset_id: "1075058827",
        side: "BUY",
        size: "40",
        price: "0.08",
        status: "MATCHED_NOT_BROADCASTED",
        owner: FIXTURE_OWNER,
        maker_orders: [{ order_id: "0xfeed0005", owner: "other", matched_amount: "40", price: "0.08", asset_id: "1075058827", side: "SELL" }],
        trader_side: "TAKER",
        timestamp: "1782753360000",
      }),
    );
    expect(h.outputs.map((output) => output.kind)).toEqual(["TRADE", "RECONCILIATION_REQUESTED"]);
    expect(h.requests()[0]).toMatchObject({
      cause: "EVENT_NOT_FULLY_APPLICABLE",
      shortfalls: ["TRADE_STATUS_C3"],
      venueTradeId: "trade-c3",
      venueOrderIds: ["0xfeed0004", "0xfeed0005"],
      markets: [FIXTURE_MARKET],
    });
  });

  it("frames from a retired connection are ignored, not delivered late (their gap was already reported)", () => {
    const h = openUserStream();
    h.subscribe();
    const old = h.port.latest;
    old.drop("CLOSED_BY_PEER");
    old.deliver(ORDER_FRAME);
    old.open();
    old.drop("SERVER_ERROR");
    expect(h.outputs.filter((output) => output.kind === "ORDER")).toEqual([]);
    expect(h.requests().map((request) => request.cause)).toEqual(["SOCKET_CLOSED"]);
    expect(h.manager.diagnostics().ignoredFromRetiredConnections).toBe(3);
  });

  it("a batch frame yields one output per message, in order", () => {
    const h = openUserStream();
    h.subscribe();
    h.port.latest.deliver(`[${ORDER_FRAME},${ORDER_FRAME}]`);
    const receipts = h.outputs.flatMap((output) => (output.kind === "ORDER" ? [output.receipt.indexInFrame] : []));
    expect(receipts).toEqual([0, 1]);
  });
});

describe("markets", () => {
  it("adding markets to a live subscription sends the documented update frame and requests reconciliation for them only", () => {
    const h = openUserStream();
    h.subscribe();
    expect(h.manager.addMarkets([OTHER_MARKET, FIXTURE_MARKET])).toEqual({ ok: true, changed: [OTHER_MARKET] });
    expect(h.port.latest.sent.at(-1)).toEqual({ kind: "update", operation: "subscribe", markets: [OTHER_MARKET] });
    expect(h.requests().map((request) => [request.cause, request.markets])).toEqual([["MARKETS_ADDED", [OTHER_MARKET]]]);
    expect(h.manager.markets()).toEqual([FIXTURE_MARKET, OTHER_MARKET]);
  });

  it("markets added while disconnected ride on the next subscription frame and its request", () => {
    const h = openUserStream();
    h.subscribe();
    h.port.latest.drop("CLOSED_BY_PEER");
    h.manager.addMarkets([OTHER_MARKET]);
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    expect(h.port.latest.sent[0]).toEqual({ kind: "subscribe", markets: [FIXTURE_MARKET, OTHER_MARKET] });
    expect(h.requests().at(-1)).toMatchObject({ cause: "RESUBSCRIBED", markets: [FIXTURE_MARKET, OTHER_MARKET] });
  });

  it("removing sends the unsubscribe frame; removing every market, or an invalid id, is refused", () => {
    const h = openUserStream({ markets: [FIXTURE_MARKET, OTHER_MARKET] });
    h.subscribe();
    expect(h.manager.removeMarkets([FIXTURE_MARKET, OTHER_MARKET])).toEqual({ ok: false, reason: "WOULD_EMPTY_SUBSCRIPTION" });
    expect(h.manager.addMarkets(["not-a-condition-id"])).toEqual({ ok: false, reason: "INVALID_MARKETS" });
    expect(h.manager.removeMarkets([OTHER_MARKET])).toEqual({ ok: true, changed: [OTHER_MARKET] });
    expect(h.port.latest.sent.at(-1)).toEqual({ kind: "update", operation: "unsubscribe", markets: [OTHER_MARKET] });
    expect(h.manager.markets()).toEqual([FIXTURE_MARKET]);
  });
});

describe("re-entrancy and containment", () => {
  it("a port that reports `opened` synchronously inside `connect` is handled after `connect` returns", () => {
    const h = openUserStream();
    h.port.duringConnect = (connection) => connection.open();
    h.manager.start();
    expect(h.manager.state()).toBe("SUBSCRIBED");
    expect(h.port.latest.sent).toEqual([{ kind: "subscribe", markets: [FIXTURE_MARKET] }]);
  });

  it("a port that reports `closed` synchronously inside `connect` is a loss", () => {
    const h = openUserStream();
    h.port.duringConnect = (connection) => connection.drop("AUTH_REJECTED");
    h.manager.start();
    expect(h.requests().map((request) => request.cause)).toEqual(["AUTH_REJECTED"]);
    expect(h.manager.state()).toBe("RECONNECTING");
  });

  it("a listener that stops the manager from inside an output leaves it CLOSED and consistent", () => {
    const h = openUserStream({
      onOutput: (output, harness) => {
        if (output.kind === "RECONCILIATION_REQUESTED" && output.request.cause === "SOCKET_CLOSED") harness.manager.stop();
      },
    });
    h.subscribe();
    h.port.latest.drop("CLOSED_BY_PEER");
    expect(h.manager.state()).toBe("CLOSED");
    expect(h.manager.diagnostics().faults).toBe(0);
    h.timers.advance(10 * 60_000);
    expect(h.port.connectCalls).toBe(1);
  });

  it("a clock that throws gives `receivedAt: null`, never a throw", () => {
    const port = new FakeUserSocketPort({ accountOwner: FIXTURE_OWNER });
    const timers = new ManualTimers();
    const outputs: UserStreamOutput[] = [];
    const manager = createUserStreamManager({
      runModeContext: LIVE_SHAPED_CONTEXT,
      transport: port,
      timers: {
        now: () => {
          throw new Error("clock down");
        },
        setTimeout: (callback, delayMs) => timers.setTimeout(callback, delayMs),
        clearTimeout: (handle) => timers.clearTimeout(handle),
      },
      markets: [FIXTURE_MARKET],
      onOutput: (output) => outputs.push(output),
    });
    manager.start();
    port.latest.open();
    port.latest.deliver(ORDER_FRAME);
    expect(outputs.find((output) => output.kind === "ORDER")).toMatchObject({ receipt: { receivedAt: null } });
    expect(outputs.find((output) => output.kind === "RECONCILIATION_REQUESTED")).toMatchObject({ request: { requestedAt: null } });
  });

  it("timers that cannot be scheduled fault the manager closed, with a reconciliation request", () => {
    const port = new FakeUserSocketPort();
    const outputs: UserStreamOutput[] = [];
    const manager = createUserStreamManager({
      runModeContext: LIVE_SHAPED_CONTEXT,
      transport: port,
      timers: {
        now: () => 0,
        setTimeout: () => {
          throw new Error("no timers");
        },
        clearTimeout: () => undefined,
      },
      markets: [FIXTURE_MARKET],
      onOutput: (output) => outputs.push(output),
    });
    manager.start();
    expect(manager.state()).toBe("CLOSED");
    expect(manager.diagnostics().faults).toBe(1);
    expect(outputs.flatMap((output) => (output.kind === "RECONCILIATION_REQUESTED" ? [output.request.cause] : []))).toEqual(["MANAGER_FAULT"]);
  });
});

describe("configuration", () => {
  const base = () => ({
    runModeContext: LIVE_SHAPED_CONTEXT,
    transport: new FakeUserSocketPort(),
    timers: new ManualTimers(),
    markets: [FIXTURE_MARKET],
    onOutput: () => undefined,
  });

  it.each([
    ["no connect method", { transport: {} }, "TRANSPORT_INVALID"],
    ["timers without now", { timers: { setTimeout: () => 1, clearTimeout: () => undefined } }, "TIMERS_INVALID"],
    ["no markets", { markets: [] }, "MARKETS_INVALID"],
    ["a malformed market", { markets: ["0x1234"] }, "MARKETS_INVALID"],
    ["a listener that is not a function", { onOutput: "nope" }, "LISTENER_INVALID"],
    ["a stale bound inside the PING cadence", { staleAfterMs: PING_INTERVAL_MS }, "TIMING_INVALID"],
    ["a fractional timeout", { connectTimeoutMs: 1.5 }, "TIMING_INVALID"],
    ["a maximum backoff below the initial", { initialBackoffMs: 5_000, maxBackoffMs: 1_000 }, "TIMING_INVALID"],
  ])("refuses %s, with a fixed code and no value", (_label, override, code) => {
    let caught: unknown;
    try {
      createUserStreamManager({ ...base(), ...(override as object) } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UserStreamConfigurationError);
    expect((caught as UserStreamConfigurationError).code).toBe(code);
    expect((caught as Error).message).toBe(`user-stream configuration refused: ${code}`);
  });

  it("de-duplicates markets and keeps their order", () => {
    const manager = createUserStreamManager({ ...base(), markets: [OTHER_MARKET, FIXTURE_MARKET, OTHER_MARKET] });
    expect(manager.markets()).toEqual([OTHER_MARKET, FIXTURE_MARKET]);
  });
});
