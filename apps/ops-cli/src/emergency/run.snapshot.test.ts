/**
 * account-snapshot (handoff §14.2) and V3-E15: the Data API `/v2` routes only.
 * Read-only: nothing but reads is sent, nothing but the audit trail written.
 */

import { RateLimitBudget } from "@polymarket-bot/polymarket-secure";
import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODES } from "./exit-codes.js";
import { args, contractSnapshot, EXCHANGE, harness, order, phases, PUSD, testConfiguration, TOKEN_YES } from "./harness.test-support.js";
import { runOpsCli } from "./run.js";
import { checkApprovals, checkCollateral, checkOpenOrders, checkPositions } from "./venue-truth.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  vi.restoreAllMocks();
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

describe("account-snapshot", () => {
  it("prints open orders, /v2 positions, on-chain collateral and /v2 approvals, exactly as read; COMPLETED", async () => {
    const h = harness();
    h.venue.add(order("o-1", { price: "0.415", originalSize: "12.5", sizeMatched: "2.25" }));
    h.venue.positions = [{ tokenId: TOKEN_YES, size: "33.000001" }];
    h.venue.collateral = "1234.567891";
    const outcome = await runOpsCli(h.deps(args("account-snapshot")));
    expect(outcome.exitName).toBe("COMPLETED");
    const text = h.text();
    expect(text).toContain("order o-1: LIVE BUY 12.5 of token 1111 at 0.415, matched 2.25");
    expect(text).toContain(`token ${TOKEN_YES}: 33.000001`);
    expect(text).toContain(`asset ${PUSD}: 1234.567891`);
    expect(text).toContain(`spender ${EXCHANGE}: approved`);
    expect(phases(h.audit.records)).toEqual(["INVOKED", "OUTCOME"]);
    for (const method of ["cancelOrder", "cancelOrders", "cancelMarketOrders", "cancelAll"]) expect(h.venue.callsOf(method)).toEqual([]);
  });

  it("V3-E15: positions are requested as data.v2.positions, and an answer from a v1 route is REFUSED, never read as empty: READ_INCOMPLETE", async () => {
    const requests = vi.spyOn(RateLimitBudget.prototype, "request");
    const h = harness();
    h.venue.scripted.set("readPositions", () => ({ route: "/positions", complete: true, positions: [] }));
    const outcome = await runOpsCli(h.deps(args("account-snapshot")));
    expect(requests.mock.calls.map(([request]) => request.operationId)).toContain("data.v2.positions");
    expect(outcome.exitName).toBe("READ_INCOMPLETE");
    expect(outcome.exitCode).toBe(EXIT_CODES.READ_INCOMPLETE);
    expect(h.text()).toContain("the answer names route /positions, not /v2/positions: refused, never read as empty");
  });

  it("V3-E15: the route checks themselves, for every read", () => {
    expect(checkPositions({ route: "/v2/positions", complete: true, positions: [] })).toMatchObject({ kind: "READ" });
    for (const route of ["/positions", "/v1/positions", "/closed-positions", "/v1/market-positions", "/v2/positions/", undefined]) {
      expect(checkPositions({ route, complete: true, positions: [] }).kind, String(route)).toBe("REFUSED");
    }
    expect(checkApprovals({ route: "/approvals", approvals: [] }).kind).toBe("REFUSED");
    expect(checkApprovals({ route: "/v2/approvals", approvals: [] }).kind).toBe("READ");
    expect(checkCollateral({ source: "CLOB_BALANCE_ALLOWANCE", assetId: PUSD, balance: "1" }).kind).toBe("REFUSED");
    expect(checkOpenOrders({ route: "/data/trades", complete: true, orders: [] }).kind).toBe("REFUSED");
  });

  it("exact decimals only: a binary number, a non-canonical decimal or an over-matched order is refused, never coerced", () => {
    const row = { venueOrderId: "o-1", tokenId: "1", side: "BUY", price: "0.5", originalSize: "10", sizeMatched: "0", status: "LIVE" };
    expect(checkOpenOrders({ route: "/data/orders", complete: true, orders: [row] }).kind).toBe("READ");
    for (const bad of [{ price: 0.5 }, { price: "0.50" }, { price: "1.5" }, { originalSize: "1e3" }, { sizeMatched: "11" }, { side: "buy" }]) {
      expect(checkOpenOrders({ route: "/data/orders", complete: true, orders: [{ ...row, ...bad }] }).kind, JSON.stringify(bad)).toBe("REFUSED");
    }
    expect(checkPositions({ route: "/v2/positions", complete: true, positions: [{ tokenId: "1", size: 3 }] }).kind).toBe("REFUSED");
    expect(checkCollateral({ source: "ONCHAIN_ERC20_BALANCE", assetId: PUSD, balance: "-1" }).kind).toBe("REFUSED");
  });

  it("own data only: a getter or an inherited field is refused, and the getter never runs", () => {
    let ran = false;
    const sneaky = Object.create({ route: "/data/orders" }) as Record<string, unknown>;
    sneaky["complete"] = true;
    sneaky["orders"] = [];
    expect(checkOpenOrders(sneaky).kind).toBe("REFUSED");
    const getter = { route: "/data/orders", complete: true };
    Object.defineProperty(getter, "orders", {
      enumerable: true,
      get() {
        ran = true;
        return [];
      },
    });
    expect(checkOpenOrders(getter).kind).toBe("REFUSED");
    expect(ran).toBe(false);
  });

  it("a read the budget cannot grant is not sent and is reported: approvals without a configured operation", async () => {
    const snapshot = contractSnapshot();
    snapshot["operations"] = (snapshot["operations"] as { operationId: string }[]).filter((operation) => operation.operationId !== "data.v2.approvals");
    const h = harness({ configuration: testConfiguration({ rateLimitSnapshots: [snapshot] }) });
    const outcome = await runOpsCli(h.deps(args("account-snapshot")));
    expect(outcome.exitName).toBe("READ_INCOMPLETE");
    expect(h.venue.callsOf("readApprovals")).toEqual([]);
    expect(h.text()).toContain("readApprovals was NOT SENT: the budget refused it (UNKNOWN_OPERATION)");
  });

  it("an incomplete open-orders page is READ_INCOMPLETE, and says so", async () => {
    const h = harness();
    h.venue.scripted.set("listOpenOrders", () => ({ route: "/data/orders", complete: false, orders: [] }));
    const outcome = await runOpsCli(h.deps(args("account-snapshot")));
    expect(outcome.exitName).toBe("READ_INCOMPLETE");
    expect(h.text()).toContain("open orders: the venue marked the answer incomplete");
  });
});
