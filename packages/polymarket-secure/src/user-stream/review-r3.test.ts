/**
 * WP-280 r3: one pin per verifier finding (joint report, round 3). Each test
 * is named for its finding id and asserts on the EMITTED request. The rule
 * under test: a connection's reconciliation scope holds every market it
 * subscribed to or attempted to, recorded before the port call, for the rest
 * of its life. Its controls: the scope is per connection, and the rule's
 * bound (`CONNECTION_SCOPE_FULL`).
 *
 * Every test installs WP-260's network tripwire and fails on any network
 * attempt. No socket exists: the port is a fake fed by the test.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../testing/network-tripwire.js";

import {
  createUserStreamManager,
  MAX_OVERFLOW_MARKETS,
  MAX_PENDING_RECONCILIATION_REQUESTS,
  MAX_SUBSCRIBED_MARKETS,
  STREAM_LOSS_CAUSES,
  type MarketChange,
  type UserStreamOutput,
  type UserStreamReconciliationRequest,
} from "./manager.js";
import type { UserSocketCloseCause } from "./socket-port.js";
import { FakeUserSocketPort, ManualTimers } from "./testing/fake-socket-port.js";
import { FIXTURE_MARKET, FIXTURE_OWNER, LIVE_SHAPED_CONTEXT, OTHER_MARKET, openUserStream } from "./testing/harness.js";
import { DEFAULT_INITIAL_BACKOFF_MS, PING_INTERVAL_MS } from "./venue-facts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const A = FIXTURE_MARKET;
const B = OTHER_MARKET;
const conditionId = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
const C = conditionId(3);
const ASSET = "107505882767731489358349912513945399560393482969656700824895970500493757150417";

/** An event type the adapter does not know, naming A: it is UNRECOGNIZED and requests reconciliation. */
const UNKNOWN_EVENT_FOR_A = JSON.stringify({ event_type: "new_unknown_type", market: A });

type Harness = ReturnType<typeof openUserStream>;

const scopes = (requests: readonly UserStreamReconciliationRequest[]): (readonly [string, readonly string[]])[] =>
  requests.map((request) => [request.cause, request.markets] as const);

function acknowledgeAll(h: Harness): void {
  for (const request of h.manager.pendingReconciliationRequests()) h.manager.acknowledgeReconciliationRequest(request.requestId);
}

/** Subscribed to [A, B], startup request acknowledged, then `removeMarkets([A])` whose unsubscribe send RETURNS. */
function afterReturnedUnsubscribe(): Harness {
  const h = openUserStream({ markets: [A, B] });
  h.subscribe();
  acknowledgeAll(h);
  expect(h.manager.removeMarkets([A])).toEqual({ ok: true, changed: [A] });
  expect(h.port.latest.sent).toEqual([
    { kind: "subscribe", markets: [A, B] },
    { kind: "update", operation: "unsubscribe", markets: [A] },
  ]);
  return h;
}

const ORDER_ELSEWHERE = (market: string): string =>
  JSON.stringify({
    event_type: "order",
    type: "PLACEMENT",
    id: `0x${"0".repeat(56)}feed0009`,
    owner: FIXTURE_OWNER,
    market,
    asset_id: ASSET,
    side: "BUY",
    original_size: "100",
    size_matched: "0",
    price: "0.08",
    status: "EXPIRED",
    timestamp: "1782753357257",
  });

// ---------------------------------------------------------------------------

describe("OP-R3-01: an unsubscribe send that RETURNS does not take the market out of its connection's scope", () => {
  it("S1: a stale heartbeat after a returned unsubscribe (no PONG after it): the EMITTED HEARTBEAT_STALE request covers the removed market", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    acknowledgeAll(h);
    const connection = h.port.latest;
    h.timers.advance(5_000);
    connection.deliver("PONG"); // the last liveness evidence
    h.timers.advance(20_000);
    expect(h.manager.removeMarkets([A]).ok).toBe(true);
    expect(connection.sent).toEqual([
      { kind: "subscribe", markets: [A, B] },
      { kind: "ping" },
      { kind: "ping" },
      { kind: "update", operation: "unsubscribe", markets: [A] },
    ]);
    h.timers.advance(15_000); // stale at 35 s
    expect(h.transitions().slice(0, 3)).toEqual(["SUBSCRIBED→STALE", "STALE→DISCONNECTED", "DISCONNECTED→RECONNECTING"]);
    expect(scopes(h.requests())).toEqual([["HEARTBEAT_STALE", [B, A]]]);
    expect(scopes(h.manager.pendingReconciliationRequests())).toEqual([["HEARTBEAT_STALE", [B, A]]]);
  });

  it("S2 control (the connection-lifetime rule): a PONG after the unsubscribe is not taken as evidence the venue processed it; the stale loss still covers the removed market", () => {
    const h = afterReturnedUnsubscribe();
    h.timers.advance(1_000);
    h.port.latest.deliver("PONG");
    h.timers.advance(40_000);
    expect(scopes(h.requests())).toEqual([["HEARTBEAT_STALE", [B, A]]]);
  });

  it.each<[UserSocketCloseCause | "SOMETHING_ELSE", string]>([
    ["CLOSED_BY_PEER", "SOCKET_CLOSED"],
    ["SERVER_ERROR", "SERVER_ERROR"],
    ["AUTH_REJECTED", "AUTH_REJECTED"],
    ["TRANSPORT_ERROR", "TRANSPORT_ERROR"],
    ["SOMETHING_ELSE", "UNCLASSIFIED_CLOSE"],
  ])("S3: %s reported after a returned unsubscribe: the EMITTED %s request covers the removed market", (closeCause, lossCause) => {
    const h = afterReturnedUnsubscribe();
    h.port.latest.drop(closeCause as UserSocketCloseCause);
    expect(scopes(h.requests())).toEqual([[lossCause, [B, A]]]);
    expect(scopes(h.manager.pendingReconciliationRequests())).toEqual([[lossCause, [B, A]]]);
  });

  it("a later send that fails after a returned unsubscribe: the EMITTED SEND_FAILED request covers the removed market", () => {
    const h = afterReturnedUnsubscribe();
    h.port.latest.failNext = "ping";
    h.timers.advance(PING_INTERVAL_MS);
    expect(scopes(h.requests())).toEqual([["SEND_FAILED", [B, A]]]);
  });

  it("M2: an unrecognized frame that arrives after the unsubscribe returned covers the removed market", () => {
    const h = afterReturnedUnsubscribe();
    h.port.latest.deliver(UNKNOWN_EVENT_FOR_A);
    expect(h.outputs.map((output) => output.kind)).toEqual(["UNRECOGNIZED_MESSAGE", "RECONCILIATION_REQUESTED"]);
    expect(scopes(h.requests())).toEqual([["UNRECOGNIZED_MESSAGE", [B, A]]]);
  });

  it("STREAM_STOPPED after a returned unsubscribe covers the removed market", () => {
    const h = afterReturnedUnsubscribe();
    h.manager.stop();
    expect(scopes(h.requests())).toEqual([["STREAM_STOPPED", [B, A]]]);
  });

  it("MANAGER_FAULT after a returned unsubscribe covers the removed market", () => {
    const port = new FakeUserSocketPort({ accountOwner: FIXTURE_OWNER });
    const clock = new ManualTimers();
    let timersDown = false;
    const timers = {
      now: (): number => clock.now(),
      setTimeout: (callback: () => void, delayMs: number): unknown => {
        if (timersDown) throw new Error("timers down");
        return clock.setTimeout(callback, delayMs);
      },
      clearTimeout: (handle: unknown): void => {
        clock.clearTimeout(handle);
      },
    };
    const outputs: UserStreamOutput[] = [];
    const manager = createUserStreamManager({ runModeContext: LIVE_SHAPED_CONTEXT, transport: port, timers, markets: [A, B], onOutput: (output) => outputs.push(output) });
    manager.start();
    port.latest.open();
    expect(manager.removeMarkets([A]).ok).toBe(true);
    expect(port.latest.sent.at(-1)).toEqual({ kind: "update", operation: "unsubscribe", markets: [A] });
    timersDown = true; // re-arming the ping fails: the manager faults
    clock.advance(PING_INTERVAL_MS);
    expect(manager.state()).toBe("CLOSED");
    expect(manager.diagnostics().faults).toBe(1);
    expect(scopes(outputs.flatMap((output) => (output.kind === "RECONCILIATION_REQUESTED" ? [output.request] : [])))).toEqual([
      ["SUBSCRIPTION_STARTED", [A, B]],
      ["MANAGER_FAULT", [B, A]],
    ]);
  });

  it("the overflow built after a returned unsubscribe covers the removed market, even when the request that did not fit names another market", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    for (let index = 0; index < MAX_PENDING_RECONCILIATION_REQUESTS + 5; index += 1) h.port.latest.deliver("not json");
    const saturatedOverflow = h.manager.pendingReconciliationRequests().find((request) => request.cause === "BACKLOG_OVERFLOW");
    if (saturatedOverflow === undefined) throw new Error("no overflow");
    expect(h.manager.acknowledgeReconciliationRequest(saturatedOverflow.requestId)).toBe(true);
    expect(h.manager.removeMarkets([A]).ok).toBe(true);
    expect(h.port.latest.sent.at(-1)).toEqual({ kind: "update", operation: "unsubscribe", markets: [A] });
    const elsewhere = conditionId(7);
    h.port.latest.deliver(ORDER_ELSEWHERE(elsewhere));
    expect(h.requests().at(-1)).toMatchObject({ cause: "EVENT_NOT_FULLY_APPLICABLE", markets: [elsewhere] });
    const overflow = h.manager.pendingReconciliationRequests().filter((request) => request.cause === "BACKLOG_OVERFLOW");
    expect(overflow.map((request) => [...request.markets].sort())).toEqual([[A, B, elsewhere].sort()]);
  });

  it("control: the scope is the connection's. After the loss, the next connection's subscription, and its own later loss, cover the list only", () => {
    const h = afterReturnedUnsubscribe();
    h.port.latest.drop("TRANSPORT_ERROR");
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    expect(h.port.latest.sent).toEqual([{ kind: "subscribe", markets: [B] }]);
    expect(scopes(h.requests())).toEqual([
      ["TRANSPORT_ERROR", [B, A]],
      ["RESUBSCRIBED", [B]],
    ]);
    h.port.latest.drop("TRANSPORT_ERROR");
    expect(scopes(h.requests()).at(-1)).toEqual(["TRANSPORT_ERROR", [B]]);
  });
});

// ---------------------------------------------------------------------------

describe("CX280-R3-02: a frame delivered INSIDE the unsubscribe port call keeps the removed market in its request", () => {
  it("Y1: an unknown event naming A, delivered inside updateSubscription('unsubscribe', [A]), requests [B, A]", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    acknowledgeAll(h);
    const connection = h.port.latest;
    const update = connection.updateSubscription.bind(connection);
    connection.updateSubscription = (operation, markets) => {
      connection.deliver(UNKNOWN_EVENT_FOR_A); // queued behind the sync step that is sending the unsubscribe
      update(operation, markets);
    };
    expect(h.manager.removeMarkets([A]).ok).toBe(true);
    expect(connection.sent.at(-1)).toEqual({ kind: "update", operation: "unsubscribe", markets: [A] });
    expect(scopes(h.requests())).toEqual([["UNRECOGNIZED_MESSAGE", [B, A]]]);
  });

  it("Y2 control: the same frame delivered before the removal requests [A, B]", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    acknowledgeAll(h);
    h.port.latest.deliver(UNKNOWN_EVENT_FOR_A);
    expect(h.manager.removeMarkets([A]).ok).toBe(true);
    expect(scopes(h.requests())).toEqual([["UNRECOGNIZED_MESSAGE", [A, B]]]);
  });
});

// ---------------------------------------------------------------------------

describe("CX280-R3-01: a market enters its connection's scope BEFORE the port call", () => {
  it("X1: the subscription frame [A, B] throws after A is removed inside it: SEND_FAILED covers A, and the next subscription is [B]", () => {
    const h = openUserStream({ markets: [A, B] });
    h.manager.start();
    const connection = h.port.latest;
    const subscribe = connection.subscribe.bind(connection);
    let inner: MarketChange | undefined;
    connection.subscribe = (markets) => {
      subscribe(markets);
      inner = h.manager.removeMarkets([A]);
      throw new Error("fails after the frame");
    };
    connection.open();
    expect(inner).toEqual({ ok: true, changed: [A] });
    expect(connection.sent).toEqual([{ kind: "subscribe", markets: [A, B] }]);
    expect(scopes(h.requests())).toEqual([["SEND_FAILED", [B, A]]]);
    expect(scopes(h.manager.pendingReconciliationRequests())).toEqual([["SEND_FAILED", [B, A]]]);
    // The failed connection's frames are discarded (its loss already covers them).
    connection.deliver(UNKNOWN_EVENT_FOR_A);
    expect(h.manager.diagnostics().ignoredFromRetiredConnections).toBe(1);
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    expect(h.port.latest.sent).toEqual([{ kind: "subscribe", markets: [B] }]);
    expect(scopes(h.requests())).toEqual([
      ["SEND_FAILED", [B, A]],
      ["RESUBSCRIBED", [B]],
    ]);
  });

  it("X2: the addition frame [C] throws after C is removed inside it: SEND_FAILED covers C, and the next subscription is [A, B]", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    acknowledgeAll(h);
    const connection = h.port.latest;
    const update = connection.updateSubscription.bind(connection);
    let inner: MarketChange | undefined;
    connection.updateSubscription = (operation, markets) => {
      update(operation, markets);
      inner = h.manager.removeMarkets([C]);
      throw new Error("fails after the frame");
    };
    expect(h.manager.addMarkets([C])).toEqual({ ok: true, changed: [C] });
    expect(inner).toEqual({ ok: true, changed: [C] });
    expect(connection.sent.at(-1)).toEqual({ kind: "update", operation: "subscribe", markets: [C] });
    expect(scopes(h.requests())).toEqual([["SEND_FAILED", [A, B, C]]]);
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    expect(scopes(h.requests())).toEqual([
      ["SEND_FAILED", [A, B, C]],
      ["RESUBSCRIBED", [A, B]],
    ]);
  });

  it("X5 control: the same subscription frame succeeding: SUBSCRIPTION_STARTED [A, B], the unsubscribe follows, and a later loss still covers A", () => {
    const h = openUserStream({ markets: [A, B] });
    h.manager.start();
    const connection = h.port.latest;
    const subscribe = connection.subscribe.bind(connection);
    connection.subscribe = (markets) => {
      subscribe(markets);
      connection.subscribe = subscribe;
      h.manager.removeMarkets([A]);
    };
    connection.open();
    expect(connection.sent).toEqual([
      { kind: "subscribe", markets: [A, B] },
      { kind: "update", operation: "unsubscribe", markets: [A] },
    ]);
    expect(scopes(h.requests())).toEqual([["SUBSCRIPTION_STARTED", [A, B]]]);
    connection.drop("CLOSED_BY_PEER");
    expect(scopes(h.requests()).at(-1)).toEqual(["SOCKET_CLOSED", [B, A]]);
  });
});

// ---------------------------------------------------------------------------

describe("CONNECTION_SCOPE_FULL: one connection's scope is bounded by MAX_OVERFLOW_MARKETS; past it the manager closes the connection itself", () => {
  it("is a loss cause, so it requests reconciliation like every other", () => {
    expect(STREAM_LOSS_CAUSES).toContain("CONNECTION_SCOPE_FULL");
  });

  it("up to the bound additions are sent (a re-added market is not growth); one more closes the connection, its request covers everything it covered, and the next connection starts from the list", () => {
    const h = openUserStream({ markets: [A] });
    h.subscribe();
    acknowledgeAll(h);
    const first = h.port.latest;
    let next = 100;
    const fresh = (count: number): string[] => Array.from({ length: count }, () => conditionId(next++));
    const everCovered = new Set<string>([A]);
    // Ten full batches, each added and then removed: the connection's scope grows to 1 + 10 * 999 = 9,991.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const batch = fresh(MAX_SUBSCRIBED_MARKETS - 1);
      expect(h.manager.addMarkets(batch).ok).toBe(true);
      expect(h.manager.removeMarkets(batch).ok).toBe(true);
      for (const market of batch) everCovered.add(market);
      acknowledgeAll(h);
    }
    // Exactly to the bound: nine more, sent.
    const toBound = fresh(MAX_OVERFLOW_MARKETS - everCovered.size);
    expect(toBound).toHaveLength(9);
    expect(h.manager.addMarkets(toBound).ok).toBe(true);
    for (const market of toBound) everCovered.add(market);
    expect(everCovered.size).toBe(MAX_OVERFLOW_MARKETS);
    expect(first.sent.at(-1)).toEqual({ kind: "update", operation: "subscribe", markets: toBound });
    // A market the connection already covered is not growth: re-adding one at the bound is sent too.
    const earlier = conditionId(100);
    expect(h.manager.addMarkets([earlier]).ok).toBe(true);
    expect(first.sent.at(-1)).toEqual({ kind: "update", operation: "subscribe", markets: [earlier] });
    expect(h.manager.state()).toBe("SUBSCRIBED");
    expect(scopes(h.requests()).at(-1)).toEqual(["MARKETS_ADDED", [earlier]]);
    acknowledgeAll(h);
    const framesBefore = first.sent.length;
    h.outputs.length = 0;

    // One market more than the bound: not sent; the connection is closed by the manager.
    const [beyond] = fresh(1) as [string];
    expect(h.manager.addMarkets([beyond]).ok).toBe(true);
    expect(first.sent).toHaveLength(framesBefore);
    expect(first.closeCalls).toBe(1);
    expect(h.transitions()).toEqual(["SUBSCRIBED→DISCONNECTED", "DISCONNECTED→RECONNECTING"]);
    const [recycled, ...others] = h.requests();
    expect(others).toEqual([]);
    expect(recycled?.cause).toBe("CONNECTION_SCOPE_FULL");
    const list = h.manager.markets();
    expect(list).toEqual([A, ...toBound, earlier, beyond]);
    expect(new Set(recycled?.markets)).toEqual(new Set([...everCovered, beyond]));
    expect(recycled?.markets.slice(0, list.length)).toEqual(list);
    expect(h.manager.pendingReconciliationRequests().map((request) => request.cause)).toEqual(["CONNECTION_SCOPE_FULL"]);

    // The next connection subscribes to the list, and its scope is the list again.
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    expect(h.port.latest.sent).toEqual([{ kind: "subscribe", markets: list }]);
    expect(h.requests().at(-1)).toMatchObject({ cause: "RESUBSCRIBED", afterLoss: "CONNECTION_SCOPE_FULL", markets: list });
    h.port.latest.drop("TRANSPORT_ERROR");
    expect(h.requests().at(-1)).toMatchObject({ cause: "TRANSPORT_ERROR", markets: list });
  });
});

// ---------------------------------------------------------------------------

describe("the rule is stated where it is implemented", () => {
  it("manager.ts states the connection-lifetime scope (no send-time cut-off), and socket-port.ts says a returned call is no evidence of delivery", async () => {
    const manager = (await readFile(path.join(HERE, "manager.ts"), "utf8")).replace(/\s*\n\s*\*\s?/gu, " ");
    expect(manager).toContain("FOR THE REST OF THE CONNECTION'S LIFE");
    expect(manager).toContain("A send that returns is no evidence that the frame arrived");
    expect(manager).not.toMatch(/stays in scope until its unsubscribe frame has been sent/u);
    const port = (await readFile(path.join(HERE, "socket-port.ts"), "utf8")).replace(/\s*\n\s*\*\s?/gu, " ");
    expect(port).toContain("A method that RETURNS is no evidence that its frame arrived");
  });
});
