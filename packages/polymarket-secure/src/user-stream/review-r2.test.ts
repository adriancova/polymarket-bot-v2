/**
 * WP-280 r2: one pin per verifier finding (joint report, round 2). Each test
 * is named for its finding id. Every CX280-R2-01 test fails against the r1
 * candidate (65b5962) and passes here; the R2-01 and R2-02 doc pins fail
 * there too, and the behaviour beside them is pinned so the doc and the code
 * cannot drift apart.
 *
 * Every test installs WP-260's network tripwire and fails on any network
 * attempt. No socket exists: the port is a fake fed by the test.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REDACTED } from "../redaction.js";
import { installNetworkTripwire, type NetworkTripwire } from "../testing/network-tripwire.js";

import { createUserStreamManager, MAX_PENDING_RECONCILIATION_REQUESTS, type UserStreamOutput, type UserStreamReconciliationRequest } from "./manager.js";
import { normalizeUserChannelMessage } from "./normalize.js";
import { redactUserStreamPayload } from "./redaction.js";
import { FakeUserSocketPort, ManualTimers, type FakeUserSocketConnection } from "./testing/fake-socket-port.js";
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
const id = (suffix: string): string => `0x${"0".repeat(56)}${suffix}`;
const ASSET = "107505882767731489358349912513945399560393482969656700824895970500493757150417";

type Harness = ReturnType<typeof openUserStream>;

const scopes = (requests: readonly UserStreamReconciliationRequest[]): (readonly [string, readonly string[]])[] =>
  requests.map((request) => [request.cause, request.markets] as const);

function acknowledgeAll(h: Harness): void {
  for (const request of h.manager.pendingReconciliationRequests()) h.manager.acknowledgeReconciliationRequest(request.requestId);
}

/** Run `inside` from within the connection's next `ping` call (a port call: every step it requests is queued behind the ping step). */
function insideNextPing(connection: FakeUserSocketConnection, inside: () => void): void {
  const ping = connection.ping.bind(connection);
  connection.ping = () => {
    ping();
    connection.ping = ping;
    inside();
  };
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

const TRADE = (): Record<string, unknown> => ({
  event_type: "trade",
  type: "TRADE",
  id: "trade-r2",
  taker_order_id: id("feed0004"),
  market: FIXTURE_MARKET,
  asset_id: ASSET,
  side: "BUY",
  size: "40",
  fee_rate_bps: "0",
  price: "0.08",
  status: "CONFIRMED",
  match_time: "1782753360",
  last_update: "1782753370",
  owner: FIXTURE_OWNER,
  trader_side: "TAKER",
  timestamp: "1782753371000",
});

// ---------------------------------------------------------------------------

describe("CX280-R2-01: a request about the whole stream covers every market the connection is subscribed to on the wire", () => {
  it("a failed unsubscribe (the verifiers' repro): the EMITTED SEND_FAILED request covers the removed market, the backlog keeps it, the resubscription covers the list", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    acknowledgeAll(h);
    const old = h.port.latest;
    old.failNext = "update";
    expect(h.manager.removeMarkets([A])).toEqual({ ok: true, changed: [A] });
    // The old connection only ever sent `subscribe [A, B]`: A was still subscribed on the wire when it was lost.
    expect(old.sent).toEqual([{ kind: "subscribe", markets: [A, B] }]);
    expect(scopes(h.requests())).toEqual([["SEND_FAILED", [B, A]]]);
    expect(scopes(h.manager.pendingReconciliationRequests())).toEqual([["SEND_FAILED", [B, A]]]);
    h.timers.advance(DEFAULT_INITIAL_BACKOFF_MS);
    h.port.latest.open();
    expect(h.port.latest.sent).toEqual([{ kind: "subscribe", markets: [B] }]);
    expect(scopes(h.requests())).toEqual([
      ["SEND_FAILED", [B, A]],
      ["RESUBSCRIBED", [B]],
    ]);
  });

  it("a failed subscribe send while a removal is pending: the loss covers the addition AND the removed market", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    acknowledgeAll(h);
    const connection = h.port.latest;
    insideNextPing(connection, () => {
      expect(h.manager.removeMarkets([A]).ok).toBe(true);
      expect(h.manager.addMarkets([C]).ok).toBe(true);
      connection.failNext = "update"; // additions are sent first: the subscribe [C] frame fails
    });
    h.timers.advance(PING_INTERVAL_MS);
    expect(connection.sent).toEqual([{ kind: "subscribe", markets: [A, B] }, { kind: "ping" }]);
    expect(h.manager.state()).toBe("RECONNECTING");
    expect(scopes(h.requests())).toEqual([["SEND_FAILED", [B, C, A]]]);
    expect(scopes(h.manager.pendingReconciliationRequests())).toEqual([["SEND_FAILED", [B, C, A]]]);
  });

  it("a loss that does not fit the backlog: the emitted request and the overflow that stands for it both cover the removed market", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    for (let index = 0; index < MAX_PENDING_RECONCILIATION_REQUESTS + 5; index += 1) h.port.latest.deliver("not json");
    const saturatedOverflow = h.manager.pendingReconciliationRequests().find((request) => request.cause === "BACKLOG_OVERFLOW");
    if (saturatedOverflow === undefined) throw new Error("no overflow");
    // Acknowledge the overflow only: the regular slots stay full, so the next request builds a fresh overflow.
    expect(h.manager.acknowledgeReconciliationRequest(saturatedOverflow.requestId)).toBe(true);
    h.port.latest.failNext = "update";
    expect(h.manager.removeMarkets([A]).ok).toBe(true);
    expect(scopes([h.requests().at(-1) as UserStreamReconciliationRequest])).toEqual([["SEND_FAILED", [B, A]]]);
    const overflow = h.manager.pendingReconciliationRequests().filter((request) => request.cause === "BACKLOG_OVERFLOW");
    expect(overflow.map((request) => [request.afterLoss, [...request.markets].sort()])).toEqual([["SEND_FAILED", [A, B].sort()]]);
  });

  it("an overflow rebuilt while a removal is pending covers the removed market even when the request that did not fit names another market", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    for (let index = 0; index < MAX_PENDING_RECONCILIATION_REQUESTS + 5; index += 1) h.port.latest.deliver("not json");
    const saturatedOverflow = h.manager.pendingReconciliationRequests().find((request) => request.cause === "BACKLOG_OVERFLOW");
    if (saturatedOverflow === undefined) throw new Error("no overflow");
    expect(h.manager.acknowledgeReconciliationRequest(saturatedOverflow.requestId)).toBe(true);
    const elsewhere = conditionId(7);
    const connection = h.port.latest;
    insideNextPing(connection, () => {
      // Queued first: an event-level request on another market. Queued second: the removal's unsubscribe.
      connection.deliver(JSON.stringify({ ...ORDER(id("feed0009")), market: elsewhere, status: "EXPIRED" }));
      expect(h.manager.removeMarkets([A]).ok).toBe(true);
    });
    h.timers.advance(PING_INTERVAL_MS);
    const eventRequest = h.requests().find((request) => request.cause === "EVENT_NOT_FULLY_APPLICABLE");
    expect(eventRequest?.markets).toEqual([elsewhere]);
    const overflow = h.manager.pendingReconciliationRequests().filter((request) => request.cause === "BACKLOG_OVERFLOW");
    expect(overflow.map((request) => [...request.markets].sort())).toEqual([[A, B, elsewhere].sort()]);
    // The unsubscribe then went out, after the event's step.
    expect(connection.sent.at(-1)).toEqual({ kind: "update", operation: "unsubscribe", markets: [A] });
  });

  it("an unrecognized message that arrived before the removal's unsubscribe went out covers the removed market", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    acknowledgeAll(h);
    const connection = h.port.latest;
    insideNextPing(connection, () => {
      connection.deliver("not json");
      expect(h.manager.removeMarkets([A]).ok).toBe(true);
    });
    h.timers.advance(PING_INTERVAL_MS);
    expect(connection.sent.slice(1)).toEqual([{ kind: "ping" }, { kind: "update", operation: "unsubscribe", markets: [A] }]);
    expect(scopes(h.requests())).toEqual([["UNRECOGNIZED_MESSAGE", [B, A]]]);
    // r3 (OP-R3-01, flipped from r2's [B]): a sent unsubscribe does not take A out of the connection's scope.
    // A later frame may still be an A event the venue sent before it processed the unsubscribe.
    connection.deliver("not json");
    expect(scopes(h.requests()).at(-1)).toEqual(["UNRECOGNIZED_MESSAGE", [B, A]]);
  });

  it("STREAM_STOPPED: a stop queued before a removal covers the removed market (its unsubscribe never goes out)", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    acknowledgeAll(h);
    const connection = h.port.latest;
    insideNextPing(connection, () => {
      h.manager.stop();
      expect(h.manager.removeMarkets([A]).ok).toBe(true);
    });
    h.timers.advance(PING_INTERVAL_MS);
    expect(h.manager.state()).toBe("CLOSED");
    expect(connection.sent).toEqual([{ kind: "subscribe", markets: [A, B] }, { kind: "ping" }]);
    expect(scopes(h.requests())).toEqual([["STREAM_STOPPED", [B, A]]]);
    expect(scopes(h.manager.pendingReconciliationRequests())).toEqual([["STREAM_STOPPED", [B, A]]]);
  });

  it("MANAGER_FAULT: a fault in the step that queued a removal covers the removed market", () => {
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
    const connection = port.latest;
    insideNextPing(connection, () => {
      expect(manager.removeMarkets([A]).ok).toBe(true);
      timersDown = true; // re-arming the ping then fails: the manager faults inside this step
    });
    clock.advance(PING_INTERVAL_MS);
    expect(manager.state()).toBe("CLOSED");
    expect(manager.diagnostics().faults).toBe(1);
    expect(connection.sent).toEqual([{ kind: "subscribe", markets: [A, B] }, { kind: "ping" }]);
    expect(scopes(outputs.flatMap((output) => (output.kind === "RECONCILIATION_REQUESTED" ? [output.request] : [])))).toEqual([
      ["SUBSCRIPTION_STARTED", [A, B]],
      ["MANAGER_FAULT", [B, A]],
    ]);
  });

  it("controls: with nothing pending the scope is exactly the list, in order; after a successful unsubscribe a loss still covers the removed market (r3, OP-R3-01)", () => {
    const h = openUserStream({ markets: [A, B] });
    h.subscribe();
    acknowledgeAll(h);
    h.port.latest.drop("TRANSPORT_ERROR");
    expect(scopes(h.requests())).toEqual([["TRANSPORT_ERROR", [A, B]]]);

    const g = openUserStream({ markets: [A, B] });
    g.subscribe();
    acknowledgeAll(g);
    expect(g.manager.removeMarkets([A]).ok).toBe(true);
    expect(g.port.latest.sent.at(-1)).toEqual({ kind: "update", operation: "unsubscribe", markets: [A] });
    g.port.latest.drop("TRANSPORT_ERROR");
    // r3 (OP-R3-01, flipped from r2's [B]): the loss may have begun before the unsubscribe was sent.
    expect(scopes(g.requests())).toEqual([["TRANSPORT_ERROR", [B, A]]]);
  });
});

// ---------------------------------------------------------------------------

/** The JSDoc block that ends right before `marker`, as plain prose. */
function jsDocBefore(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const end = source.lastIndexOf("*/", at);
  const start = source.lastIndexOf("/**", end);
  if (start < 0 || end < 0 || source.slice(end + 2, at).trim() !== "") throw new Error(`no JSDoc right before: ${marker}`);
  return source
    .slice(start + 3, end)
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/u, ""))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("R2-01: redactUserStreamPayload's JSDoc claims exactly its key-name rule", () => {
  it("the JSDoc does not call the result safe to log, and says free text under a public key is kept and not vetted", async () => {
    const doc = jsDocBefore(await readFile(path.join(HERE, "redaction.ts"), "utf8"), "export function redactUserStreamPayload");
    expect(doc).not.toMatch(/safe to log/iu);
    expect(doc).toContain("DECIDED BY KEY NAME ONLY");
    expect(doc).toContain("is kept exactly as given and is NOT vetted");
    expect(doc).toContain("not as cleared for logging");
    // The user-stream entry's summary of it claims no more.
    const entry = await readFile(path.join(HERE, "index.ts"), "utf8");
    expect(entry).not.toMatch(/log-safe|safe to log/iu);
    expect(entry).toContain("{@link redactUserStreamPayload}: key-name-redacted copies");
  });

  it("and that is what it does: a key-name match is redacted, free text under a public key is kept (text frame and object alike)", () => {
    const key = "7f3e9c1a-1111-2222-3333-444455556666";
    expect(redactUserStreamPayload(JSON.stringify({ error: `invalid api key ${key}`, owner: key }))).toBe(
      JSON.stringify({ error: `invalid api key ${key}`, owner: REDACTED }),
    );
    expect(redactUserStreamPayload({ message: key, auth: { apiKey: key } })).toEqual({ message: key, auth: REDACTED });
    // Text that is not a JSON object or array as a whole is replaced.
    expect(redactUserStreamPayload(`invalid api key ${key}`)).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------

describe('R2-02: a venue instant of "0" is refused (fail closed), and wire.ts discloses it', () => {
  it('"0" in timestamp, created_at, match_time, matchtime or last_update makes the event malformed; "0" in expiration means no expiration', () => {
    const order = (overrides: Record<string, unknown>): unknown => normalizeUserChannelMessage({ ...ORDER(id("feed0001")), ...overrides });
    const trade = (overrides: Record<string, unknown>): unknown => normalizeUserChannelMessage({ ...TRADE(), ...overrides });
    expect(order({ timestamp: "0" })).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_ORDER_EVENT", field: "timestamp" });
    expect(order({ created_at: "0" })).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_ORDER_EVENT", field: "created_at" });
    expect(trade({ timestamp: "0" })).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_TRADE_EVENT", field: "timestamp" });
    expect(trade({ match_time: "0" })).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_TRADE_EVENT", field: "match_time" });
    const { match_time: _matchTime, ...withoutMatchTime } = TRADE();
    void _matchTime;
    expect(normalizeUserChannelMessage({ ...withoutMatchTime, matchtime: "0" })).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_TRADE_EVENT", field: "matchtime" });
    expect(trade({ last_update: "0" })).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_TRADE_EVENT", field: "last_update" });
    // Controls: the same events with real instants are recognized, and an expiration of "0" is "no expiration".
    expect(trade({})).toMatchObject({ kind: "TRADE" });
    expect(order({ created_at: "1782753350", expiration: "0" })).toMatchObject({ kind: "ORDER", event: { expiresAt: null } });
  });

  it('through the manager a "0" last_update is an UNRECOGNIZED message and a reconciliation request, never a trade', () => {
    const h = openUserStream();
    h.subscribe();
    h.port.latest.deliver(JSON.stringify({ ...TRADE(), last_update: "0" }));
    expect(h.outputs.map((output) => output.kind)).toEqual(["UNRECOGNIZED_MESSAGE", "RECONCILIATION_REQUESTED"]);
    expect(h.requests().map((request) => [request.cause, request.unrecognized])).toEqual([["UNRECOGNIZED_MESSAGE", "MALFORMED_TRADE_EVENT"]]);
  });

  it('wire.ts discloses the "0" consequence beside the plausibility window', async () => {
    const doc = jsDocBefore(await readFile(path.join(HERE, "wire.ts"), "utf8"), "export const MIN_PLAUSIBLE_EPOCH_MS");
    expect(doc).toContain('THE WIRE VALUE "0" IS REFUSED TOO');
    for (const field of ["`timestamp`", "`created_at`", "`last_update`", "`match_time`", "`matchtime`", "`expiration`"]) expect(doc).toContain(field);
    expect(doc).toContain("requests reconciliation (fail closed)");
  });
});
