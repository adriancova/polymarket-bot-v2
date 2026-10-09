/**
 * ADR-034 D2 (`CO3-N1`): ONE EXECUTABLE QUANTITY, end to end over the mock CLOB.
 *
 * THE FINDING. The closeout's probe E01 (`~/pmb-rounds/closeout-3/E-architecture-probes.test.ts`, sha256
 * `bc23ce684d0d962aa9628874b2192cad763a43e1eabfe2ea2ffc934422bc80c4`, outside the repository; ported here, not
 * imported) submitted BUY 5.009 at 0.5 through the real WP-260 client, WP-270 OMS, WP-300 inventory and WP-290
 * coordinator. The SDK signed 5.00 shares (it floors to "Size decimals", A F-99/F-101); the OMS kept 5.009 as the
 * order's `originalShares`; the mock booked the REQUESTED 5.009 and hid the gap. With the mock booking what was
 * signed, an acknowledged order broke with `ORDER_FACTS_MISMATCH`, and a lost answer with
 * `SIGNED_IDENTITY_AMBIGUOUS` plus `ORDER_UNRESOLVED`.
 *
 * THE DECISION (ADR-034 D2.2 to D2.5), pinned here:
 *
 * - D2.6 item 1, both arms: the ticket of 5.009 is refused `OMS_SIZE_OFF_GRID` (no reservation, no signature, no
 *   venue receipt); the planner turns a request of 5.009 into a planned order of 5.00 with a `SUB_GRID` remainder of
 *   0.009; that order signs `takerAmount` 5000000, the mock books 5, the OMS holds 5, and reconciliation resumes with
 *   no break.
 * - D2.6 item 2: the mock books the SIGNED amounts, never the request (`support/mock-clob.ts`, `sharesOf`).
 * - D2.6 item 3: a share amount signed one base unit away from the ticket is `FAILED` at signing, and no attempt is
 *   recorded or sent.
 *
 * PAPER only: every venue is the mock, every network attempt is refused by WP-260's tripwire, nothing holds a key.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildExecutionPlan, type PlacementPlan } from "../../../packages/execution-planner/src/index.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { approvedPosition, marketInput, planningInputs } from "../../unit/execution-planner/fixtures.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import { sharesOf } from "./support/mock-clob.js";
import { bootNode, liveWorld, reconcileUntilResumed, YES, type LiveNode, type LiveWorld } from "./support/live-node.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

/** E01's request: BUY 5.009 shares at 0.5. */
const REQUESTED = "5.009";
const PRICE = "0.5";

/** The planner's plan for E01's request: the risk engine's real approval of BUY 5.009 YES, capped at 0.5, on a book that rests it at 0.5. */
function plannedE01(): PlacementPlan {
  const record = approvedPosition({ targetShares: REQUESTED, maximumBuyPrice: PRICE });
  const result = buildExecutionPlan(
    record,
    planningInputs({ markets: [marketInput({ book: { yesBestBid: "0.5", yesBestAsk: "0.51", noBestBid: "0.49", noBestAsk: "0.5" } })] }),
  );
  if (!result.ok) throw new Error(`the planner refused E01's request: ${JSON.stringify(result.refusals.map((refusal) => refusal.code))}`);
  if (result.value.planKind !== "POSITION") throw new Error("expected a POSITION plan");
  return result.value;
}

async function bootE01(): Promise<{ readonly world: LiveWorld; readonly node: LiveNode; readonly oms: OrderManager }> {
  const world = await liveWorld();
  const node = await bootNode(world, { stream: false });
  expect(await reconcileUntilResumed(world, node)).toBe(true);
  const oms = node.oms;
  if (oms === null) throw new Error("the OMS did not open");
  return { world, node, oms };
}

/** What the world recorded so far: inventory journal events, venue SIGN and PLACE log entries, receipts, store rows. */
function footprint(world: LiveWorld): { readonly inventory: number; readonly signs: number; readonly places: number; readonly receipts: number; readonly orders: number; readonly attempts: number } {
  const snapshot = world.u.store.snapshotSync();
  return {
    inventory: world.u.inventory.journal.length,
    signs: world.clob.log.filter((entry) => entry.kind === "SIGN").length,
    places: world.clob.log.filter((entry) => entry.kind === "PLACE").length,
    receipts: world.clob.receipts.length,
    orders: snapshot.orders.size,
    attempts: snapshot.attempts.size,
  };
}

describe("ADR-034 D2.6 item 1: the closeout's probe E01 is a regression (BUY 5.009 at 0.5)", () => {
  it("the planner turns a request of 5.009 into ONE planned order of 5.00, recording a SUB_GRID remainder of 0.009 with both numbers", () => {
    const plan = plannedE01();
    expect(plan.groups).toHaveLength(1);
    const [order] = plan.groups[0]?.orders ?? [];
    expect(order).toMatchObject({ action: "BUY", side: "YES", limitPrice: PRICE, shares: "5" });
    expect(order?.unexecutableRemainder).toEqual({ reason: "SUB_GRID", unit: "SHARES", quantity: "0.009", requested: REQUESTED, executable: "5" });
    // D2.5: the reservation basis is the same one number.
    expect(plan.reservations).toEqual([expect.objectContaining({ reservationId: order?.reservationId, price: PRICE, shares: "5" })]);
  });

  for (const lost of [false, true] as const) {
    const arm = lost ? "lost answer" : "acknowledged";

    it(`${arm}: a TICKET of 5.009 is refused OMS_SIZE_OFF_GRID: nothing recorded, reserved, signed or sent`, async () => {
      const { world, oms } = await bootE01();
      const g = group(99901, { tokenId: YES, plannedShares: "10" });
      expect((await oms.registerGroup(g)).ok).toBe(true);
      if (lost) world.clob.answers.push("LOST_AFTER");
      const before = footprint(world);
      const refused = await oms.submit(ticket(g, { n: 99901, shares: REQUESTED, limitPrice: PRICE }));
      expect(refused).toMatchObject({ ok: false, refusal: { code: "OMS_SIZE_OFF_GRID" } });
      expect(footprint(world)).toEqual(before);
      expect(oms.orders()).toEqual([]);
      expect(oms.attempts()).toEqual([]);
      expect(world.clob.orders.size).toBe(0);
      expect(world.u.violations).toEqual([]);
    });

    it(`${arm}: the PLANNED 5.00 signs takerAmount 5000000, the mock books 5, the OMS holds 5, and reconciliation resumes with no break`, async () => {
      const plan = plannedE01();
      const planned = plan.groups[0]?.orders[0];
      if (planned === undefined) throw new Error("no planned order");
      const { world, node, oms } = await bootE01();
      const g = group(99902, { tokenId: YES, plannedShares: planned.shares, limitPrice: planned.limitPrice });
      world.clob.plannedShares.set(`${g.tokenId}|${g.side}`, g.plannedShares);
      expect((await oms.registerGroup(g)).ok).toBe(true);
      if (lost) world.clob.answers.push("LOST_AFTER");
      const t = ticket(g, { n: 99902, shares: planned.shares, limitPrice: planned.limitPrice });
      const submitted = await oms.submit(t);
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      expect(submitted.value.orderState).toBe(lost ? "RECONCILING" : "LIVE");
      expect(submitted.value.attemptState).toBe(lost ? "RECONCILING" : "RESPONDED");

      const order = oms.order(t.orderId);
      const row = [...world.u.store.snapshotSync().attempts.values()][0];
      if (order === undefined || row === undefined) throw new Error("no order or attempt was recorded");
      const payload = JSON.parse(await world.u.cipher.decrypt(row.signedPayload)) as Record<string, unknown>;
      const booked = [...world.clob.orders.values()][0];
      // One number (D2.5): the ticket, the OMS's originalShares, the signed share amount and the venue's original size.
      expect(payload["takerAmount"]).toBe("5000000");
      expect(payload["makerAmount"]).toBe("2500000");
      expect(booked?.original).toBe("5");
      expect(order.originalShares).toBe("5");

      node.coordinator.trigger("PERIODIC_TIMER");
      const report = await node.coordinator.reconcile();
      expect(report.resumed).toBe(true);
      expect(node.journal.unresolvedBreaks()).toEqual([]);
      expect(oms.order(t.orderId)).toMatchObject({ state: "LIVE", venueOrderId: booked?.venueOrderId, originalShares: "5" });
      expect(world.u.violations).toEqual([]);
    });
  }
});

describe("ADR-034 D2.6 item 2: the mock venue books the SIGNED amounts, never the request", () => {
  it("an off-grid size signed through the fake SDK directly (beneath the client, which refuses it) is booked at its signed 5, not the requested 5.009", async () => {
    const world = await liveWorld();
    const port = await world.clob.sdk("trader")({ signer: { signTypedData: async () => `0x${"00".repeat(65)}` } as never });
    const signed = (await port.createLimitOrder({ assetId: YES, side: "BUY", price: PRICE, size: REQUESTED } as never)) as unknown as Record<string, unknown>;
    expect(signed["takerAmount"]).toBe("5000000");
    await port.postOrder(signed as never);
    const booked = [...world.clob.orders.values()][0];
    expect(booked?.original).toBe("5");
    expect(booked?.original).toBe(sharesOf("BUY", { makerAmount: String(signed["makerAmount"]), takerAmount: String(signed["takerAmount"]) }));
    // A SELL books its signed makerAmount.
    const sold = (await port.createLimitOrder({ assetId: YES, side: "SELL", price: PRICE, size: "7.777" } as never)) as unknown as Record<string, unknown>;
    expect(sold["makerAmount"]).toBe("7770000");
    world.clob.orders.clear();
    await port.postOrder(sold as never);
    expect([...world.clob.orders.values()][0]?.original).toBe("7.77");
  });
});

describe("ADR-034 D2.6 item 3: a share amount signed one base unit away from the ticket is FAILED, and nothing is sent", () => {
  for (const [label, skew] of [
    // A consistent signed order for one base unit FEWER shares: the quote is what the SDK signs for 4.999999 shares
    // at 0.5 (floored to tick 0.01's 4 decimals: 2.4999). Before D2.4 the adapter's tolerance accepted it.
    ["one base unit fewer shares, with the SDK's own quote for them", (amounts: { readonly makerAmount: string; readonly takerAmount: string }) => {
      const shares = BigInt(amounts.takerAmount) - 1n;
      return { makerAmount: String(((shares * 5n) / 10n / 100n) * 100n), takerAmount: String(shares) };
    }],
    ["takerAmount (shares) one base unit short", (amounts: { readonly makerAmount: string; readonly takerAmount: string }) => ({ ...amounts, takerAmount: String(BigInt(amounts.takerAmount) - 1n) })],
    ["takerAmount (shares) one base unit over", (amounts: { readonly makerAmount: string; readonly takerAmount: string }) => ({ ...amounts, takerAmount: String(BigInt(amounts.takerAmount) + 1n) })],
    ["makerAmount (quote) one base unit short", (amounts: { readonly makerAmount: string; readonly takerAmount: string }) => ({ ...amounts, makerAmount: String(BigInt(amounts.makerAmount) - 1n) })],
  ] as const) {
    it(`${label}: OMS_SIGN_FAILED; no attempt recorded, nothing placed, the reservation released, the group still open`, async () => {
      const { world, oms } = await bootE01();
      const g = group(99903, { tokenId: YES, plannedShares: "10" });
      expect((await oms.registerGroup(g)).ok).toBe(true);
      world.clob.signingSkew = skew;
      const refused = await oms.submit(ticket(g, { n: 99903, shares: "5", limitPrice: PRICE }));
      expect(refused).toMatchObject({ ok: false, refusal: { code: "OMS_SIGN_FAILED" } });
      expect(oms.attempts()).toEqual([]);
      expect(world.u.store.snapshotSync().attempts.size).toBe(0);
      expect(world.clob.receipts).toEqual([]);
      expect(world.clob.log.filter((entry) => entry.kind === "PLACE")).toEqual([]);
      expect(world.clob.orders.size).toBe(0);
      const [order] = oms.orders();
      expect(order).toMatchObject({ state: "CANCELED", finalSize: "0", reservation: { released: true } });
      // The gate is open again: the SDK's own amounts sign and place.
      world.clob.signingSkew = null;
      const placed = await oms.submit(ticket(g, { n: 99904, shares: "5", limitPrice: PRICE }));
      expect(placed.ok && placed.value.orderState).toBe("LIVE");
      expect(world.u.violations).toEqual([]);
    });
  }
});
