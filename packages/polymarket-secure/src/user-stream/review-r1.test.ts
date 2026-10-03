/**
 * WP-280 r1: one pin per verifier finding (joint report, round 1). Each test
 * is named for its finding id; each fails against the r0 candidate (2c8f7df)
 * or against the mutant named in its title, and passes here.
 *
 * Every test installs WP-260's network tripwire and fails on any network
 * attempt. No socket exists: the port is a fake fed by the test, from
 * offline fixtures.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../testing/network-tripwire.js";

import {
  createUserStreamManager,
  MAX_CONSECUTIVE_AUTH_REJECTIONS,
  MAX_OVERFLOW_MARKETS,
  MAX_PENDING_RECONCILIATION_REQUESTS,
  MAX_SUBSCRIBED_MARKETS,
  type UserStreamOutput,
  type UserStreamReconciliationRequest,
} from "./manager.js";
import { normalizeUserChannelMessage, type NormalizedTradeEvent } from "./normalize.js";
import { projectTradeEventForOms } from "./oms-projection.js";
import { FakeUserSocketPort } from "./testing/fake-socket-port.js";
import { FIXTURE_MARKET, FIXTURE_OWNER, LIVE_SHAPED_CONTEXT, OTHER_MARKET, openUserStream } from "./testing/harness.js";
import { DEFAULT_INITIAL_BACKOFF_MS, PING_INTERVAL_MS } from "./venue-facts.js";
import { MAX_PLAUSIBLE_EPOCH_MS, MIN_PLAUSIBLE_EPOCH_MS } from "./wire.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../../../test/fixtures/venue/user-ws");

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const id = (suffix: string): string => `0x${"0".repeat(56)}${suffix}`;
const ASSET = "107505882767731489358349912513945399560393482969656700824895970500493757150417";
const OTHER_ASSET = "52114319501245915516055106046884209969926127482827954674443846427813813222426";
const T1 = "00000000-0000-0000-0000-00000000t001";
const STRANGER = "11111111-1111-1111-1111-111111111111";

async function tradeFixture(name: string): Promise<Record<string, unknown>> {
  const file = JSON.parse(await readFile(path.join(FIXTURES, "trade-settlement.json"), "utf8")) as {
    examples: readonly { readonly name: string; readonly payload: Record<string, unknown> }[];
  };
  const example = file.examples.find((entry) => entry.name === name);
  if (example === undefined) throw new Error(name);
  return example.payload;
}

const ORDER = (venueOrderId: string): Record<string, unknown> => ({
  event_type: "order",
  type: "PLACEMENT",
  id: venueOrderId,
  owner: FIXTURE_OWNER,
  market: FIXTURE_MARKET,
  asset_id: ASSET,
  side: "BUY",
  original_size: "100",
  size_matched: "0",
  price: "0.08",
  status: "LIVE",
  timestamp: "1782753357257",
});

function trade(overrides: Record<string, unknown> = {}, isAccountOwner?: (owner: string) => boolean): NormalizedTradeEvent {
  const message = normalizeUserChannelMessage(
    {
      event_type: "trade",
      type: "TRADE",
      id: "trade-r1",
      taker_order_id: id("feed0004"),
      market: FIXTURE_MARKET,
      asset_id: ASSET,
      side: "BUY",
      size: "40",
      fee_rate_bps: "0",
      price: "0.08",
      status: "MATCHED",
      match_time: "1782753360",
      owner: FIXTURE_OWNER,
      maker_orders: [{ order_id: id("feed0005"), owner: STRANGER, matched_amount: "40", price: "0.08", asset_id: ASSET, side: "SELL" }],
      trader_side: "TAKER",
      timestamp: "1782753361000",
      ...overrides,
    },
    isAccountOwner === undefined ? {} : { isAccountOwner },
  );
  if (message.kind !== "TRADE") throw new Error(message.kind);
  return message.event;
}

const own = (owner: string): boolean => owner === FIXTURE_OWNER;

function acknowledgeAll(h: ReturnType<typeof openUserStream>): void {
  for (const request of h.manager.pendingReconciliationRequests()) h.manager.acknowledgeReconciliationRequest(request.requestId);
}

const conditionId = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

// ---------------------------------------------------------------------------

describe("CX280-R1-01: a TAKER trade whose maker ownership is undetermined requests reconciliation", () => {
  it("the matched fixture without an ownership predicate: the taker fill projects beside MAKER_LEG_OWNERSHIP_UNDETERMINED", async () => {
    const message = normalizeUserChannelMessage(await tradeFixture("matched"));
    if (message.kind !== "TRADE") throw new Error(message.kind);
    expect(message.event.makerOrders?.map((maker) => maker.account)).toEqual(["UNDETERMINED"]);
    const projection = projectTradeEventForOms(message.event);
    expect(projection.fills.map((fill) => [fill.venueOrderId, fill.liquidityRole])).toEqual([[id("feed0004"), "TAKER"]]);
    expect(projection.shortfalls).toEqual(["MAKER_LEG_OWNERSHIP_UNDETERMINED"]);
  });

  it("a predicate that throws or answers a non-boolean leaves a TAKER trade's maker leg undetermined, and that is a shortfall", () => {
    const throwing = (): boolean => {
      throw new Error("predicate down");
    };
    expect(projectTradeEventForOms(trade({}, throwing)).shortfalls).toEqual(["MAKER_LEG_OWNERSHIP_UNDETERMINED"]);
    expect(projectTradeEventForOms(trade({}, (() => "yes") as unknown as (owner: string) => boolean)).shortfalls).toEqual(["MAKER_LEG_OWNERSHIP_UNDETERMINED"]);
    // Control: a decided foreign maker leg is no shortfall.
    expect(projectTradeEventForOms(trade({}, own)).shortfalls).toEqual([]);
  });

  it("through the manager, over a port with no isAccountOwner: the TAKER trade requests reconciliation naming the trade and every order id", async () => {
    const h = openUserStream({ port: { ownerCheck: false } });
    h.subscribe();
    h.port.latest.deliver(JSON.stringify(await tradeFixture("matched")));
    expect(h.outputs.map((output) => output.kind)).toEqual(["TRADE", "RECONCILIATION_REQUESTED"]);
    expect(h.requests()[0]).toMatchObject({
      cause: "EVENT_NOT_FULLY_APPLICABLE",
      shortfalls: ["MAKER_LEG_OWNERSHIP_UNDETERMINED"],
      venueTradeId: T1,
      venueOrderIds: [id("feed0004"), id("feed0005")],
      markets: [FIXTURE_MARKET],
    });
  });
});

// ---------------------------------------------------------------------------

describe("CX280-R1-02: an event the listener fails to take becomes a reconciliation request", () => {
  it("ORDER: after the startup requests are acknowledged, a throw on the order leaves one EVENT_NOT_DELIVERED request naming it", () => {
    const h = openUserStream({
      onOutput: (output) => {
        if (output.kind === "ORDER") throw new Error("listener down");
      },
    });
    h.subscribe();
    acknowledgeAll(h);
    h.port.latest.deliver(JSON.stringify(ORDER(id("feed0001"))));
    expect(h.manager.state()).toBe("SUBSCRIBED");
    expect(h.manager.diagnostics().listenerFailures).toBe(1);
    const pending = h.manager.pendingReconciliationRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      cause: "EVENT_NOT_DELIVERED",
      markets: [FIXTURE_MARKET],
      venueOrderIds: [id("feed0001")],
      venueTradeId: null,
      subscriptionGeneration: 1,
    });
    // It is emitted too, after the event it stands for.
    expect(h.outputs.map((output) => output.kind)).toEqual(["ORDER", "RECONCILIATION_REQUESTED"]);
  });

  it("TRADE: the request names the trade id and every order id, exactly", async () => {
    const h = openUserStream({
      onOutput: (output) => {
        if (output.kind === "TRADE") throw new Error("listener down");
      },
    });
    h.subscribe();
    acknowledgeAll(h);
    h.port.latest.deliver(JSON.stringify(await tradeFixture("retrying")));
    expect(h.manager.pendingReconciliationRequests()).toEqual([
      expect.objectContaining({ cause: "EVENT_NOT_DELIVERED", venueTradeId: "00000000-0000-0000-0000-00000000t002", venueOrderIds: [id("feed0006"), id("feed0007")] }),
    ]);
  });

  it("a listener that throws on everything: one request per lost event, and a failure on that request makes no further one (no loop)", () => {
    const h = openUserStream({
      onOutput: () => {
        throw new Error("listener down");
      },
    });
    h.subscribe();
    acknowledgeAll(h);
    const before = h.manager.diagnostics().listenerFailures;
    h.port.latest.deliver(JSON.stringify(ORDER(id("feed0001"))));
    expect(h.manager.pendingReconciliationRequests().map((request) => request.cause)).toEqual(["EVENT_NOT_DELIVERED"]);
    // The order, then its request: two failures, and nothing more.
    expect(h.manager.diagnostics().listenerFailures - before).toBe(2);
    expect(h.manager.state()).toBe("SUBSCRIBED");
  });

  it("F-05 R24: outputs queued after the one the listener failed on are still delivered, in order", () => {
    let thrown = 0;
    const h = openUserStream({
      onOutput: (output) => {
        if (output.kind === "ORDER" && thrown === 0) {
          thrown += 1;
          throw new Error("listener down once");
        }
      },
    });
    h.subscribe();
    h.port.latest.deliver(`[${JSON.stringify(ORDER(id("feed0001")))},${JSON.stringify(ORDER(id("feed0002")))}]`);
    expect(h.outputs.map((output) => (output.kind === "ORDER" ? output.event.venueOrderId : output.kind))).toEqual([
      id("feed0001"),
      id("feed0002"),
      "RECONCILIATION_REQUESTED",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("CX280-R1-03: a saturated backlog's overflow request covers everything that did not fit", () => {
  function saturated(): ReturnType<typeof openUserStream> {
    const h = openUserStream();
    h.subscribe();
    for (let index = 0; index < MAX_PENDING_RECONCILIATION_REQUESTS + 5; index += 1) h.port.latest.deliver("not json");
    expect(h.manager.pendingReconciliationRequests()).toHaveLength(MAX_PENDING_RECONCILIATION_REQUESTS);
    return h;
  }

  const overflow = (h: ReturnType<typeof openUserStream>): UserStreamReconciliationRequest[] =>
    h.manager.pendingReconciliationRequests().filter((request) => request.cause === "BACKLOG_OVERFLOW");

  it("a market added and a reconnect while saturated are covered: the union of markets, the newest generation, the newest loss", () => {
    const h = saturated();
    expect(h.manager.addMarkets([OTHER_MARKET])).toEqual({ ok: true, changed: [OTHER_MARKET] });
    h.port.latest.drop("SERVER_ERROR");
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    const pending = h.manager.pendingReconciliationRequests();
    expect(pending).toHaveLength(MAX_PENDING_RECONCILIATION_REQUESTS);
    const [held, ...more] = overflow(h);
    expect(more).toEqual([]);
    expect([...(held?.markets ?? [])].sort()).toEqual([FIXTURE_MARKET, OTHER_MARKET].sort());
    expect(held?.subscriptionGeneration).toBe(2);
    expect(held?.afterLoss).toBe("SERVER_ERROR");
    // Every request the listener saw after saturation is covered by something retained.
    const retainedMarkets = new Set(pending.flatMap((request) => request.markets));
    expect(retainedMarkets.has(OTHER_MARKET)).toBe(true);
  });

  it("acknowledging an older overflow snapshot clears nothing newer; acknowledging the current one does, and the next loss makes a new one", () => {
    const h = saturated();
    const first = overflow(h)[0];
    if (first === undefined) throw new Error("no overflow");
    h.port.latest.drop("CLOSED_BY_PEER"); // a newer loss, after the snapshot was read
    const second = overflow(h)[0];
    if (second === undefined) throw new Error("no overflow");
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.afterLoss).toBe("SOCKET_CLOSED");
    expect(h.manager.acknowledgeReconciliationRequest(first.requestId)).toBe(false);
    expect(overflow(h).map((request) => request.requestId)).toEqual([second.requestId]);
    expect(h.manager.acknowledgeReconciliationRequest(second.requestId)).toBe(true);
    expect(overflow(h)).toEqual([]);
    h.port.latest.deliver("not json"); // the old connection is retired: ignored, no request
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    expect(overflow(h).map((request) => [request.afterLoss, request.subscriptionGeneration])).toEqual([["SOCKET_CLOSED", 2]]);
  });

  it("an event-level request that did not fit, on a market outside the subscription, is covered by the overflow", () => {
    const h = saturated();
    const elsewhere = conditionId(7);
    h.port.latest.deliver(JSON.stringify({ ...ORDER(id("feed0009")), market: elsewhere, status: "EXPIRED" }));
    expect(h.requests().at(-1)).toMatchObject({ cause: "EVENT_NOT_FULLY_APPLICABLE", markets: [elsewhere] });
    expect(h.manager.markets()).toEqual([FIXTURE_MARKET]);
    expect([...(overflow(h)[0]?.markets ?? [])].sort()).toEqual([FIXTURE_MARKET, elsewhere].sort());
  });

  it("a slot freed by an acknowledgement takes the next request as itself", () => {
    const h = saturated();
    const oldest = h.manager.pendingReconciliationRequests()[0];
    if (oldest === undefined) throw new Error("empty");
    expect(h.manager.acknowledgeReconciliationRequest(oldest.requestId)).toBe(true);
    h.port.latest.deliver("not json");
    const newest = h.requests().at(-1);
    expect(h.manager.pendingReconciliationRequests().some((request) => request.requestId === newest?.requestId)).toBe(true);
  });

  it("the union is bounded: past MAX_OVERFLOW_MARKETS the manager faults closed, and the overflow still covers every market it took", () => {
    const h = saturated();
    const added: string[] = [];
    let cycles = 0;
    for (let next = 1; h.manager.state() !== "CLOSED"; cycles += 1) {
      const batch = Array.from({ length: MAX_SUBSCRIBED_MARKETS - 1 }, () => conditionId(next++));
      expect(h.manager.addMarkets(batch).ok).toBe(true);
      added.push(...batch);
      if (h.manager.state() !== "CLOSED") expect(h.manager.removeMarkets(batch).ok).toBe(true);
      expect(cycles).toBeLessThan(20);
    }
    expect(cycles).toBe(11);
    expect(h.manager.diagnostics().faults).toBe(1);
    expect(h.requests().at(-1)?.cause).toBe("MANAGER_FAULT");
    const covered = new Set(overflow(h)[0]?.markets ?? []);
    expect(added.every((market) => covered.has(market))).toBe(true);
    expect(MAX_OVERFLOW_MARKETS).toBe(10 * MAX_SUBSCRIBED_MARKETS);
    expect(covered.size).toBeLessThanOrEqual(MAX_OVERFLOW_MARKETS + MAX_SUBSCRIBED_MARKETS);
  });
});

// ---------------------------------------------------------------------------

describe("F-01: an own maker leg is never a fill from the stream (D-13: the maker fee is per market)", () => {
  const makerTrade = (overrides: Record<string, unknown> = {}): NormalizedTradeEvent =>
    trade(
      {
        trader_side: "MAKER",
        side: "SELL",
        size: "10",
        price: "0.09",
        maker_orders: [{ order_id: id("feed0007"), owner: FIXTURE_OWNER, matched_amount: "10", price: "0.09", asset_id: ASSET, side: "BUY", fee_rate_bps: "0" }],
        ...overrides,
      },
      own,
    );

  it("MATCHED: the settlement projects, the fill does not, even with zero rates on the trade and the leg", () => {
    expect(projectTradeEventForOms(makerTrade())).toEqual({
      fills: [],
      settlements: [{ venueTradeId: "trade-r1", venueOrderId: id("feed0007"), status: "MATCHED", transactionHash: null, observedAt: "2026-06-29T17:16:01.000Z" }],
      shortfalls: ["MAKER_FEE_NOT_ON_STREAM"],
    });
  });

  it("through the manager the MATCHED maker trade requests reconciliation naming the maker order", () => {
    const h = openUserStream();
    h.subscribe();
    h.port.latest.deliver(
      JSON.stringify({
        event_type: "trade",
        type: "TRADE",
        id: "trade-r1",
        taker_order_id: id("feed0006"),
        market: FIXTURE_MARKET,
        asset_id: ASSET,
        side: "SELL",
        size: "10",
        price: "0.09",
        status: "MATCHED",
        match_time: "1782753379",
        owner: FIXTURE_OWNER,
        maker_orders: [{ order_id: id("feed0007"), owner: FIXTURE_OWNER, matched_amount: "10", price: "0.09", asset_id: ASSET, side: "BUY" }],
        trader_side: "MAKER",
        timestamp: "1782753380000",
      }),
    );
    expect(h.requests()).toEqual([
      expect.objectContaining({ cause: "EVENT_NOT_FULLY_APPLICABLE", shortfalls: ["MAKER_FEE_NOT_ON_STREAM"], venueOrderIds: [id("feed0006"), id("feed0007")] }),
    ]);
  });

  it("later settlement events raise no fill shortfall (the MATCHED event owes the fill)", () => {
    for (const status of ["MINED", "CONFIRMED", "RETRYING", "FAILED"]) expect(projectTradeEventForOms(makerTrade({ status })).shortfalls).toEqual([]);
  });

  it("venue-facts.ts records the D-13 qualification and no longer claims makers are never charged", async () => {
    const text = await readFile(path.join(HERE, "venue-facts.ts"), "utf8");
    expect(text).toContain("D-13");
    expect(text).toContain("takerOnly");
    expect(text).not.toContain("MAKERS_ARE_NEVER_CHARGED_FEES");
  });

  it("F-05 R02: an own maker leg with no matched amount is FILL_SIZE_NOT_POSITIVE, not a fee shortfall", () => {
    const zero = makerTrade({
      maker_orders: [{ order_id: id("feed0007"), owner: FIXTURE_OWNER, matched_amount: "0", price: "0.09", asset_id: ASSET, side: "BUY" }],
    });
    expect(projectTradeEventForOms(zero).shortfalls).toEqual(["FILL_SIZE_NOT_POSITIVE"]);
  });
});

// ---------------------------------------------------------------------------

describe("F-03a: market changes made from inside a port call", () => {
  it("two removals queued inside connect: the second would empty the subscription and is refused; nothing empty is sent", () => {
    const h = openUserStream({ markets: [FIXTURE_MARKET, OTHER_MARKET] });
    const results: unknown[] = [];
    h.port.duringConnect = () => {
      results.push(h.manager.removeMarkets([FIXTURE_MARKET]), h.manager.removeMarkets([OTHER_MARKET]));
    };
    h.manager.start();
    h.port.latest.open();
    expect(results).toEqual([
      { ok: true, changed: [FIXTURE_MARKET] },
      { ok: false, reason: "WOULD_EMPTY_SUBSCRIPTION" },
    ]);
    expect(h.manager.markets()).toEqual([OTHER_MARKET]);
    expect(h.port.latest.sent).toEqual([{ kind: "subscribe", markets: [OTHER_MARKET] }]);
  });

  it("two identical additions inside connect add the market once; the market cap counts the first", () => {
    const full = Array.from({ length: MAX_SUBSCRIBED_MARKETS - 1 }, (_, index) => conditionId(index + 1));
    const h = openUserStream({ markets: full });
    const results: unknown[] = [];
    h.port.duringConnect = () => {
      results.push(h.manager.addMarkets([OTHER_MARKET]), h.manager.addMarkets([OTHER_MARKET]), h.manager.addMarkets([FIXTURE_MARKET]));
    };
    h.manager.start();
    h.port.latest.open();
    expect(results).toEqual([
      { ok: true, changed: [OTHER_MARKET] },
      { ok: true, changed: [] },
      { ok: false, reason: "INVALID_MARKETS" },
    ]);
    expect(h.manager.markets()).toHaveLength(MAX_SUBSCRIBED_MARKETS);
    expect(h.port.latest.sent).toEqual([{ kind: "subscribe", markets: [...full, OTHER_MARKET] }]);
  });

  it("while subscribed, a change made inside a port call is sent once, after the call; a removal undone in the same call sends nothing", () => {
    const h = openUserStream({ markets: [FIXTURE_MARKET, OTHER_MARKET] });
    h.subscribe();
    const connection = h.port.latest;
    const third = conditionId(3);
    let inside: (() => void) | null = () => {
      h.manager.addMarkets([third]);
      h.manager.removeMarkets([OTHER_MARKET]);
      h.manager.addMarkets([OTHER_MARKET]);
    };
    const ping = connection.ping.bind(connection);
    connection.ping = () => {
      ping();
      const run = inside;
      inside = null;
      run?.();
    };
    h.timers.advance(PING_INTERVAL_MS);
    expect(connection.sent.slice(1)).toEqual([{ kind: "ping" }, { kind: "update", operation: "subscribe", markets: [third] }]);
    expect(h.requests().map((request) => [request.cause, request.markets])).toEqual([["MARKETS_ADDED", [third]]]);
    expect(h.manager.markets()).toEqual([FIXTURE_MARKET, third, OTHER_MARKET]);
  });
});

describe("F-03b: a timer that fires inside its own setTimeout faults the manager instead of being dropped", () => {
  function syncTimers(): { readonly timers: { now(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(): void }; fireNow: boolean } {
    const state = {
      fireNow: false,
      timers: {
        now: () => Date.UTC(2026, 9, 3, 12),
        setTimeout: (callback: () => void): unknown => {
          if (state.fireNow) callback();
          return {};
        },
        clearTimeout: (): void => undefined,
      },
    };
    return state;
  }

  it("after a loss: the backoff fires inside setTimeout, and the manager closes with MANAGER_FAULT rather than wait forever", () => {
    const port = new FakeUserSocketPort({ accountOwner: FIXTURE_OWNER });
    const clock = syncTimers();
    const outputs: UserStreamOutput[] = [];
    const manager = createUserStreamManager({ runModeContext: LIVE_SHAPED_CONTEXT, transport: port, timers: clock.timers, markets: [FIXTURE_MARKET], onOutput: (output) => outputs.push(output) });
    manager.start();
    port.latest.open();
    clock.fireNow = true;
    port.latest.drop("SERVER_ERROR");
    expect(manager.state()).toBe("CLOSED");
    expect(manager.diagnostics().faults).toBe(1);
    expect(port.connectCalls).toBe(1);
    expect(outputs.flatMap((output) => (output.kind === "RECONCILIATION_REQUESTED" ? [output.request.cause] : []))).toEqual([
      "SUBSCRIPTION_STARTED",
      "SERVER_ERROR",
      "MANAGER_FAULT",
    ]);
  });

  it("from the start: the connect timeout fires inside setTimeout, and the transport is never asked to connect", () => {
    const port = new FakeUserSocketPort();
    const clock = syncTimers();
    clock.fireNow = true;
    const manager = createUserStreamManager({ runModeContext: LIVE_SHAPED_CONTEXT, transport: port, timers: clock.timers, markets: [FIXTURE_MARKET], onOutput: () => undefined });
    manager.start();
    expect(manager.state()).toBe("CLOSED");
    expect(manager.diagnostics().faults).toBe(1);
    expect(port.connectCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("F-05: isolating pins for guards no r0 test isolated", () => {
  it("R01: a maker leg on another asset, on the opposite side and at the trade price, does not fix the taker's economics", () => {
    const projection = projectTradeEventForOms(
      trade({ maker_orders: [{ order_id: id("feed0005"), owner: STRANGER, matched_amount: "40", price: "0.08", asset_id: OTHER_ASSET, side: "SELL" }] }, own),
    );
    expect(projection.fills).toEqual([]);
    expect(projection.shortfalls).toEqual(["TAKER_ECONOMICS_UNVERIFIABLE"]);
  });

  it("R40: a repeated `opened` on a subscribed connection changes nothing (no second subscription frame, no fault)", () => {
    const h = openUserStream();
    h.manager.start();
    h.port.latest.open();
    h.port.latest.open();
    expect(h.port.latest.sent).toEqual([{ kind: "subscribe", markets: [FIXTURE_MARKET] }]);
    expect(h.manager.state()).toBe("SUBSCRIBED");
    expect(h.manager.diagnostics().faults).toBe(0);
    expect(h.requests().map((request) => request.cause)).toEqual(["SUBSCRIPTION_STARTED"]);
  });
});

// ---------------------------------------------------------------------------

describe("F-06: refused credentials are not re-sent without end", () => {
  it("three AUTH_REJECTED losses in a row close the manager; the first two still reconnect, and every loss requests reconciliation", () => {
    const h = openUserStream();
    h.subscribe();
    for (let cycle = 0; cycle < 12; cycle += 1) {
      h.port.latest.drop("AUTH_REJECTED");
      if (h.manager.state() === "CLOSED") break;
      h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
      h.port.latest.open();
    }
    expect(h.manager.state()).toBe("CLOSED");
    expect(h.port.connectCalls).toBe(3);
    expect(h.requests().map((request) => request.cause)).toEqual(["AUTH_REJECTED", "RESUBSCRIBED", "AUTH_REJECTED", "RESUBSCRIBED", "AUTH_REJECTED"]);
    expect(h.transitions().at(-1)).toBe("DISCONNECTED→CLOSED");
    expect(h.timers.pendingCount()).toBe(0);
    h.timers.advance(10 * 60_000);
    expect(h.port.connectCalls).toBe(3);
    expect(MAX_CONSECUTIVE_AUTH_REJECTIONS).toBe(3);
  });

  it("a recognized message between rejections restarts the count; an unrecognized frame does not", () => {
    const h = openUserStream();
    h.subscribe();
    const reject = (): void => {
      h.port.latest.drop("AUTH_REJECTED");
      h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
      h.port.latest.open();
    };
    reject();
    reject();
    h.port.latest.deliver("PONG");
    reject();
    reject();
    expect(h.manager.state()).toBe("SUBSCRIBED");
    h.port.latest.deliver(JSON.stringify({ error: "unauthorized" }));
    h.port.latest.drop("AUTH_REJECTED");
    expect(h.manager.state()).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------

describe("F-07: venue instants outside a plausible window are refused, never carried", () => {
  const order = (overrides: Record<string, unknown>): Record<string, unknown> => ({ ...ORDER(id("feed0001")), ...overrides });

  it("a seconds-shaped event timestamp (read as milliseconds, January 1970) is a malformed event", () => {
    expect(normalizeUserChannelMessage(order({ timestamp: "1672290701" }))).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_ORDER_EVENT", field: "timestamp" });
  });

  it("a milliseconds-shaped match time (read as seconds, tens of thousands of years ahead) is a malformed event", () => {
    const message = normalizeUserChannelMessage({
      event_type: "trade",
      type: "TRADE",
      id: "trade-r1",
      taker_order_id: id("feed0004"),
      market: FIXTURE_MARKET,
      asset_id: ASSET,
      side: "BUY",
      size: "40",
      price: "0.08",
      status: "MATCHED",
      match_time: "1782753360000",
      owner: FIXTURE_OWNER,
      timestamp: "1782753361000",
    });
    expect(message).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_TRADE_EVENT", field: "match_time" });
  });

  it("the window is [2020-01-01, 2100-01-01) and its edges are exact", () => {
    expect(normalizeUserChannelMessage(order({ timestamp: "1577836800000" })).kind).toBe("ORDER");
    expect(normalizeUserChannelMessage(order({ timestamp: "1577836799999" })).kind).toBe("UNRECOGNIZED");
    expect(normalizeUserChannelMessage(order({ timestamp: "4102444799999" })).kind).toBe("ORDER");
    expect(normalizeUserChannelMessage(order({ timestamp: "4102444800000" })).kind).toBe("UNRECOGNIZED");
    expect(normalizeUserChannelMessage(order({ created_at: "1577836799" }))).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_ORDER_EVENT", field: "created_at" });
    expect(new Date(MIN_PLAUSIBLE_EPOCH_MS).toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(new Date(MAX_PLAUSIBLE_EPOCH_MS).toISOString()).toBe("2100-01-01T00:00:00.000Z");
  });
});
