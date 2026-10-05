/**
 * cancel-order and cancel-market (handoff §14.2): one documented endpoint
 * each, through WP-310's budget at EMERGENCY_CANCEL, verified by venue truth
 * afterwards, with every outcome its own exit code.
 */

import { RateLimitBudget, type Grant, type GrantCompletion } from "@polymarket-bot/polymarket-secure";
import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT, args, CONDITION, DESTRUCTIVE_REASON, harness, order, phases, refusedUnapplied, SIGNER, TOKEN_NO, TOKEN_YES, transportFailure, type Harness } from "./harness.test-support.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  vi.restoreAllMocks();
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const cancelOrder = (id: string): string[] => args("cancel-order", id, ...DESTRUCTIVE_REASON, "--confirm", `cancel-order:${id}@${ACCOUNT}`);

describe("cancel-order", () => {
  it("DELETE /order through the budget (clob.cancel_order at EMERGENCY_CANCEL), verified by a read by id: COMPLETED", async () => {
    const requests = vi.spyOn(RateLimitBudget.prototype, "request");
    const completions = vi.spyOn(RateLimitBudget.prototype, "complete");
    const h = harness();
    h.venue.add(order("o-1"), order("o-2"));
    const outcome = await runOpsCli(h.deps(cancelOrder("o-1")));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.venue.callsOf("cancelOrder").map((call) => call.args)).toEqual([["o-1"]]);
    expect(h.venue.open().map((entry) => entry.venueOrderId)).toEqual(["o-2"]);
    expect(requests.mock.calls.map(([request]) => request)).toContainEqual({ operationId: "clob.cancel_order", priority: "EMERGENCY_CANCEL", signer: SIGNER });
    const completion = completions.mock.calls.find(([grant]) => (grant as Grant).operationId === "clob.cancel_order");
    expect((completion?.[1] as GrantCompletion).canceledCount).toBe(1);
    expect(h.text()).toContain("venue truth after: order o-1 status CANCELED");
    // D8 (WP330-V1-07): the read by id verified it, and the OUTCOME record says so.
    expect(h.audit.records.at(-1)?.detail).toMatchObject({ exit: "COMPLETED", target: "o-1", statusAfter: "CANCELED", verified: true, canceled: { count: 1, ids: ["o-1"], truncated: false } });
  });

  it("the venue says not canceled (already matched): NOT_ALL_CANCELED, with the reason", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    h.venue.resist.add("o-1");
    const outcome = await runOpsCli(h.deps(cancelOrder("o-1")));
    expect(outcome.exitName).toBe("NOT_ALL_CANCELED");
    expect(h.text()).toContain("NOT CANCELED o-1: Order already matched");
  });

  it("refused unapplied: VENUE_REFUSED", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    h.venue.scripted.set("cancelOrder", () => ({ kind: "REFUSED", error: refusedUnapplied("CANCEL_ORDER") }));
    const outcome = await runOpsCli(h.deps(cancelOrder("o-1")));
    expect(outcome.exitName).toBe("VENUE_REFUSED");
  });

  it("an UNKNOWN answer verified by id as CANCELED: COMPLETED; as still LIVE: NOT_ALL_CANCELED; unreadable: UNKNOWN", async () => {
    const verified = harness();
    verified.venue.add(order("o-1"));
    verified.venue.scripted.set("cancelOrder", () => {
      const entry = verified.venue.orders.get("o-1");
      if (entry !== undefined) entry.status = "CANCELED";
      return { kind: "UNKNOWN", error: transportFailure("CANCEL_ORDER") };
    });
    expect((await runOpsCli(verified.deps(cancelOrder("o-1")))).exitName).toBe("COMPLETED");

    const live = harness();
    live.venue.add(order("o-1"));
    live.venue.scripted.set("cancelOrder", () => ({ kind: "UNKNOWN", error: null }));
    expect((await runOpsCli(live.deps(cancelOrder("o-1")))).exitName).toBe("NOT_ALL_CANCELED");

    const unreadable = harness();
    unreadable.venue.add(order("o-1"));
    unreadable.venue.scripted.set("cancelOrder", () => ({ kind: "UNKNOWN", error: null }));
    unreadable.venue.scripted.set("readOrder", () => Promise.reject(new Error("down")));
    const outcome = await runOpsCli(unreadable.deps(cancelOrder("o-1")));
    expect(outcome.exitName).toBe("UNKNOWN");
    expect(unreadable.text()).toContain("whether DELETE /order was applied: its answer was lost or unreadable");
  });

  it("the venue does not show the order by id afterwards: never read as canceled (E-14)", async () => {
    const h = harness();
    h.venue.scripted.set("cancelOrder", () => ({ kind: "UNKNOWN", error: null }));
    const outcome = await runOpsCli(h.deps(cancelOrder("o-404")));
    expect(outcome.exitName).toBe("UNKNOWN");
    expect(h.text()).toContain("the venue does not show order o-404 by id: whether it was canceled or never existed is not known");
  });
});

describe("cancel-market", () => {
  it("DELETE /cancel-market-orders with the condition id (and asset), through clob.cancel_market_orders at EMERGENCY_CANCEL, completed with the count", async () => {
    const requests = vi.spyOn(RateLimitBudget.prototype, "request");
    const completions = vi.spyOn(RateLimitBudget.prototype, "complete");
    const h = harness();
    h.venue.add(order("y-1", { tokenId: TOKEN_YES }), order("y-2", { tokenId: TOKEN_YES }), order("n-1", { tokenId: TOKEN_NO }), order("x-1", { tokenId: "3333", market: `0x${"9".repeat(64)}` }));
    const outcome = await runOpsCli(h.deps(args("cancel-market", CONDITION, "--asset", TOKEN_YES, ...DESTRUCTIVE_REASON, "--confirm", `cancel-market:${CONDITION}:${TOKEN_YES}@${ACCOUNT}`)));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.venue.callsOf("cancelMarketOrders").map((call) => call.args[0])).toEqual([{ market: CONDITION, assetId: TOKEN_YES }]);
    expect(h.venue.open().map((entry) => entry.venueOrderId).sort()).toEqual(["n-1", "x-1"]);
    expect(requests.mock.calls.map(([request]) => request)).toContainEqual({ operationId: "clob.cancel_market_orders", priority: "EMERGENCY_CANCEL", signer: SIGNER });
    const completion = completions.mock.calls.find(([grant]) => (grant as Grant).operationId === "clob.cancel_market_orders");
    expect((completion?.[1] as GrantCompletion).canceledCount).toBe(2);
    expect(h.text()).toContain("venue truth after: 0 open order(s) still listed in asset 1111");
    expect(h.audit.records.at(-1)?.detail).toMatchObject({ exit: "COMPLETED", verified: true, stillListedInAsset: { count: 0, ids: [], truncated: false } });
  });

  it("without --asset, the result is the venue's answer alone, and the output says which open orders it cannot attribute", async () => {
    const h = harness();
    h.venue.add(order("y-1"), order("x-1", { tokenId: "3333", market: `0x${"9".repeat(64)}` }));
    const outcome = await runOpsCli(h.deps(args("cancel-market", CONDITION, ...DESTRUCTIVE_REASON, "--confirm", `cancel-market:${CONDITION}@${ACCOUNT}`)));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.venue.callsOf("cancelMarketOrders").map((call) => call.args[0])).toEqual([{ market: CONDITION }]);
    expect(h.text()).toContain("the open-orders read carries no market id");
    expect(h.text()).toContain("which open orders belong to this market: the open-orders read carries no market id");
    // D8 (WP330-V1-07): COMPLETED on the venue's answer alone, and the OUTCOME record says it was not verified.
    expect(h.audit.records.at(-1)?.detail).toMatchObject({ exit: "COMPLETED", verified: false, stillListedInAsset: null });
  });

  it("an order of the asset still listed afterwards: NOT_ALL_CANCELED", async () => {
    const h = harness();
    h.venue.add(order("y-1"));
    h.venue.scripted.set("cancelMarketOrders", () => ({ kind: "COMPLETED", canceled: [], notCanceled: [] }));
    const outcome = await runOpsCli(h.deps(args("cancel-market", CONDITION, "--asset", TOKEN_YES, ...DESTRUCTIVE_REASON, "--confirm", `cancel-market:${CONDITION}:${TOKEN_YES}@${ACCOUNT}`)));
    expect(outcome.exitName).toBe("NOT_ALL_CANCELED");
  });
});

describe("WP-330 r3 (CX330-R3-01): a hex --asset never yields a vacuous verified COMPLETED", () => {
  // 0x457 is 1111, TOKEN_YES, the token the open order rests in.
  const HEX_OF_TOKEN_YES = "0x457";
  const cancelMarket = (asset: string, ...extra: string[]): string[] => args("cancel-market", CONDITION, "--asset", asset, ...DESTRUCTIVE_REASON, ...extra);
  const confirmed = (asset: string): string[] => cancelMarket(asset, "--confirm", `cancel-market:${CONDITION}:${asset}@${ACCOUNT}`);
  type Answer = "LOST" | "COMPLETED_NOTHING_CANCELED";
  function setUp(answer: Answer): Harness {
    const h = harness();
    h.venue.add(order("still-live", { tokenId: TOKEN_YES }));
    h.venue.scripted.set("cancelMarketOrders", () => (answer === "LOST" ? { kind: "UNKNOWN", error: null } : { kind: "COMPLETED", canceled: [], notCanceled: [] }));
    return h;
  }

  for (const answer of ["LOST", "COMPLETED_NOTHING_CANCELED"] as const) {
    it(`hex ${HEX_OF_TOKEN_YES} (= ${TOKEN_YES}), the cancel answer ${answer}: refused as USAGE before anything is read or sent; never COMPLETED while the order of token ${TOKEN_YES} stays open`, async () => {
      expect(BigInt(HEX_OF_TOKEN_YES).toString()).toBe(TOKEN_YES);
      const h = setUp(answer);
      const outcome = await runOpsCli(h.deps(confirmed(HEX_OF_TOKEN_YES)));
      expect(outcome.exitName).not.toBe("COMPLETED");
      expect(outcome.exitName).toBe("USAGE");
      expect(outcome.exitCode).toBe(2);
      expect(h.touched).toEqual([]);
      expect(h.venue.calls).toEqual([]);
      expect(h.venue.open().map((entry) => entry.venueOrderId)).toEqual(["still-live"]);
      expect(h.text()).toContain("usage error: --asset must be a token id in decimal, as account-snapshot prints it");
      expect(phases(h.audit.records)).toEqual(["INVOKED", "OUTCOME"]);
      expect(h.audit.records.at(-1)?.detail).toMatchObject({ exit: "USAGE" });
      expect(JSON.stringify(h.audit.records)).not.toContain('"verified":true');
    });
  }

  it(`hex ${HEX_OF_TOKEN_YES} dry run: refused as USAGE, so no plan claims "0 open order(s) in asset ${HEX_OF_TOKEN_YES}"`, async () => {
    const h = setUp("LOST");
    const outcome = await runOpsCli(h.deps(cancelMarket(HEX_OF_TOKEN_YES, "--dry-run")));
    expect(outcome.exitName).toBe("USAGE");
    expect(h.venue.calls).toEqual([]);
    expect(h.text()).not.toContain(`open order(s) in asset ${HEX_OF_TOKEN_YES}`);
  });

  it(`CONTROL: decimal ${TOKEN_YES}, the cancel answer LOST: verified NOT_ALL_CANCELED (8), the order still listed, and the lost answer's estimate (the 1 order of the asset) passed to the budget as the canceled count`, async () => {
    const completions = vi.spyOn(RateLimitBudget.prototype, "complete");
    const h = setUp("LOST");
    const outcome = await runOpsCli(h.deps(confirmed(TOKEN_YES)));
    expect(outcome.exitName).toBe("NOT_ALL_CANCELED");
    expect(outcome.exitCode).toBe(8);
    expect(h.venue.callsOf("cancelMarketOrders").map((call) => call.args[0])).toEqual([{ market: CONDITION, assetId: TOKEN_YES }]);
    const completion = completions.mock.calls.find(([grant]) => (grant as Grant).operationId === "clob.cancel_market_orders");
    expect((completion?.[1] as GrantCompletion).canceledCount).toBe(1);
    expect(h.audit.records.at(-1)?.detail).toMatchObject({ exit: "NOT_ALL_CANCELED", verified: true, stillListedInAsset: { count: 1, ids: ["still-live"], truncated: false } });
  });

  it(`CONTROL: decimal ${TOKEN_YES}, the venue answering COMPLETED with nothing canceled: verified NOT_ALL_CANCELED (8)`, async () => {
    const h = setUp("COMPLETED_NOTHING_CANCELED");
    const outcome = await runOpsCli(h.deps(confirmed(TOKEN_YES)));
    expect(outcome.exitName).toBe("NOT_ALL_CANCELED");
    expect(h.text()).toContain(`venue truth after: 1 open order(s) still listed in asset ${TOKEN_YES} [still-live]`);
    expect(h.audit.records.at(-1)?.detail).toMatchObject({ verified: true, stillListedInAsset: { count: 1, ids: ["still-live"], truncated: false } });
  });
});
