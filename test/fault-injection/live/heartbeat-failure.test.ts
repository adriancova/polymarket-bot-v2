/**
 * WP-340, work-plan acceptance 3: "Heartbeat failure cancels mock open
 * orders."
 *
 * A live-shaped process (`support/safety-node.ts`: WP-320's REAL live safety
 * and heartbeat controller, WP-270's OMS behind WP-320's fence, WP-260's
 * client, WP-280's manager, WP-290's coordinator) heartbeats to the mock
 * CLOB's DOCUMENTED order-heartbeat endpoint and rests an order there. Then
 * the heartbeat stops by every WP-320 path:
 *
 * - an UNHEALTHY health lease (the market feed's proof ages out);
 * - a LOST FENCE (an operator revokes the lease; the next renewal loses it);
 * - a GLOBAL or ACCOUNT kill switch that ends trading;
 * - a TRANSPORT failure (the heartbeat path's network fails; the gate
 *   still passes);
 * - a PROCESS STALL (nothing in the process runs; the venue's clock does).
 *
 * Each asserts, against the venue's own record:
 *
 * - the venue cancels the open order only AFTER its documented window
 *   (more than 10 s after the last valid heartbeat it received) and no later
 *   than that window plus one 5 s check (S-D17; ADR-008 §4 "timeout plus
 *   check interval");
 * - the controller LAPSES (ADR-033 D6), new entries are BLOCKED;
 * - reconciliation then REFLECTS the cancel: the D6 lapse recovery sends the
 *   order to WP-290's coordinator, whose by-id read records it CANCELED and
 *   releases its reservation; every resume is checked by R1.
 *
 * And a MARKET or STRATEGY_INSTANCE kill switch does NOT stop the heartbeat
 * (ADR-033 D1 item 3): the venue keeps receiving a valid heartbeat every 5 s
 * and sweeps nothing; that switch's own cancels remove its orders.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { engageRow } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import type { MemoryFencingStore } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { group, INSTANCE_A, ticket } from "../../unit/oms/support/harness.js";

import { CANCELLATION_CHECK_MS, HEARTBEAT_TIMEOUT_MS } from "./support/mock-clob.js";
import { liveWorld, MARKET, YES } from "./support/live-node.js";
import { recoveryProblems } from "./support/oracle.js";
import { bootSafetyNode, SAFETY_ACCOUNT, untilEntriesOpen, type SafetyNode } from "./support/safety-node.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const G = group(34501, { tokenId: YES, plannedShares: "5" });

interface Resting {
  readonly live: SafetyNode;
  readonly oms: OrderManager;
  readonly orderId: string;
  readonly venueOrderId: string;
}

/** A live process past its startup lapse, heartbeating, with one order resting at the venue. */
async function resting(): Promise<Resting> {
  const world = await liveWorld();
  world.clob.plannedShares.set(`${G.tokenId}|${G.side}`, G.plannedShares);
  const live = await bootSafetyNode(world);
  expect(await untilEntriesOpen(live), `entries open: ${JSON.stringify(live.entryReasons())}`).toBe(true);
  const oms = live.oms();
  expect((await oms.registerGroup(G)).ok).toBe(true);
  const t = ticket(G, { n: 1, shares: "1" });
  const submitted = await oms.submit(t);
  expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
  await live.step(6_000);
  const venueOrderId = world.clob.venueOrderIdOf(world.clob.receipts.at(-1) as string);
  expect(world.clob.openOrderIds("trader")).toEqual([venueOrderId]);
  expect(world.clob.heartbeatArmed("trader")).toBe(true);
  expect(live.controller.isLapsed()).toBe(false);
  return { live, oms, orderId: t.orderId, venueOrderId };
}

function lastValidHeartbeat(live: SafetyNode): number {
  const receipts = live.world.clob.heartbeatReceipts("trader");
  const last = receipts.at(-1);
  if (last === undefined) throw new Error("no valid heartbeat was ever received");
  return last;
}

/** The venue's sweep that canceled `venueOrderId`, or `undefined`. */
function sweepOf(live: SafetyNode, venueOrderId: string): { readonly atMs: number } | undefined {
  return live.world.clob.sweeps.find((sweep) => sweep.credential === "trader" && sweep.canceled.includes(venueOrderId));
}

/**
 * The common assertions after the heartbeat stopped at venue-time `stoppedAfter` (the last valid heartbeat the venue
 * received): the venue's cancel inside its documented window, the controller lapsed, entries blocked; then the
 * reconciliation reflects the cancel.
 */
async function expectVenueCancelThenReconciled(r: Resting, label: string): Promise<void> {
  const { live } = r;
  const lastValid = lastValidHeartbeat(live);
  const sweep = sweepOf(live, r.venueOrderId);
  expect(sweep, `${label}: the venue canceled the order`).toBeDefined();
  const after = (sweep?.atMs ?? 0) - lastValid;
  console.info(`WP-340 heartbeat path: ${JSON.stringify({ label, cancelAfterLastValidMs: after, lapseCauses: live.heartbeatEvents.of("LAPSE_STARTED").map((event) => event.cause) })}`);
  expect(after, `${label}: not before the documented 10 s`).toBeGreaterThan(HEARTBEAT_TIMEOUT_MS);
  expect(after, `${label}: within the timeout plus one check`).toBeLessThanOrEqual(HEARTBEAT_TIMEOUT_MS + CANCELLATION_CHECK_MS);
  // No valid heartbeat reached the venue between its last one and the sweep.
  expect(live.world.clob.heartbeatReceipts("trader").filter((receipt) => receipt > lastValid && receipt <= (sweep?.atMs ?? 0))).toEqual([]);
  expect(live.heartbeatEvents.of("LAPSE_STARTED").length, `${label}: the controller lapsed`).toBeGreaterThan(0);
  expect(live.journal.of("LAPSE_STARTED").length, `${label}: the composition recorded the lapse`).toBeGreaterThan(0);
  // ADR-033 D6 step 2: the lapse sent the open order to RECONCILING through WP-270's `requestOrderReconciliation`
  // (reason MANUAL_REQUEST), as the OMS's own durable order events show.
  const requested = live.world.u.store
    .snapshotSync()
    .events.filter((event) => event.orderId === r.orderId && event.newState === "RECONCILING" && event.reasonCode === "MANUAL_REQUEST");
  expect(requested.length, `${label}: the D6 lapse recovery sent the order to reconciliation`).toBeGreaterThan(0);
  // Reconciliation reflects the venue's cancel: the D6 recovery's order requests and the coordinator's by-id read.
  for (let waited = 0; waited < 60_000 && r.oms.order(r.orderId)?.state !== "CANCELED"; waited += 1_000) await live.step(1_000);
  expect(r.oms.order(r.orderId), `${label}: the OMS shows the venue's cancel`).toMatchObject({ state: "CANCELED", filledShares: "0", finalSize: "0" });
  expect(r.oms.order(r.orderId)?.reservation.released).toBe(true);
  expect(live.world.u.violations, `${label}: R1-R3`).toEqual([]);
  expect(live.world.clob.violations, `${label}: exposure`).toEqual([]);
}

describe("WP-340 acceptance 3: every WP-320 path that stops the heartbeat makes the mock venue cancel, after its documented window", () => {
  it("an UNHEALTHY health lease (the market feed's proof ages out): the gate fails, the heartbeat stops, the lapse pages, entries are blocked; the venue cancels; reconciliation reflects it", async () => {
    const r = await resting();
    r.live.marketDataHealthy = false;
    await r.live.step(4_000);
    const gate = r.live.safety.heartbeatGate.evaluate();
    expect(gate.permitted).toBe(false);
    expect(r.live.entryReasons().length).toBeGreaterThan(0);
    await r.live.step(16_000);
    expect(r.live.controller.isLapsed()).toBe(true);
    expect(r.live.alerts.pages.map((page) => page.page)).toContain("HEARTBEAT_HEALTH_LEASE_FAILED_WHILE_ORDERS_MAY_EXIST");
    expect(r.live.entryReasons().length).toBeGreaterThan(0);
    await expectVenueCancelThenReconciled(r, "unhealthy");
  });

  it("a LOST FENCE (an operator revokes the lease): the next renewal loses it, every submission is refused, the heartbeat stops; the venue cancels; reconciliation reflects it", async () => {
    const r = await resting();
    const fence = r.live.safety.currentFence();
    if (fence === null) throw new Error("no fence");
    expect((r.live.store as MemoryFencingStore).revoke(fence.fencingLeaseId, "operator: stop this writer")).toBe(true);
    await r.live.step(8_000);
    expect(r.live.safety.currentFence()).toBeNull();
    expect(r.live.journal.of("FENCE_LOST").length).toBe(1);
    // The fence refuses even a signing: no order can exist.
    const refused = await r.oms.submit(ticket(G, { n: 2, shares: "1" }));
    expect(refused.ok).toBe(false);
    await r.live.step(12_000);
    expect(r.live.controller.isLapsed()).toBe(true);
    expect(r.live.entryReasons().length).toBeGreaterThan(0);
    await expectVenueCancelThenReconciled(r, "lost fence");
    expect(r.live.world.clob.receipts).toHaveLength(1);
  });

  for (const scope of ["GLOBAL", "ACCOUNT"] as const) {
    it(`a ${scope} FULL_HALT whose own cancels never answer: the heartbeat stops anyway, so the VENUE cancels after its window; reconciliation reflects it`, async () => {
      const r = await resting();
      // Defence in depth: the switch's cancel through the OMS reaches the venue and is never answered.
      r.live.world.clob.hangCancels.add(r.venueOrderId);
      r.live.reader.rows = [engageRow({ id: `kill-${scope}`, scope, scopeRef: scope === "GLOBAL" ? null : SAFETY_ACCOUNT, action: "FULL_HALT" })];
      await r.live.step(2_000);
      const gate = r.live.safety.heartbeatGate.evaluate();
      expect(gate.permitted === false ? gate.reasons : []).toContain("HEALTH_KILL_SWITCH_ENGAGED_STOPS_HEARTBEAT");
      expect(r.live.entryReasons().length).toBeGreaterThan(0);
      expect(r.live.cancelCalls.length).toBeGreaterThan(0);
      await r.live.step(18_000);
      expect(r.live.controller.isLapsed()).toBe(true);
      r.live.world.clob.hangCancels.clear();
      await expectVenueCancelThenReconciled(r, `${scope} kill switch`);
    });

    it(`a ${scope} CANCEL_ALL whose cancels work: the order is cancelled through the OMS at once AND the heartbeat stops; nothing rests at the venue`, async () => {
      const r = await resting();
      r.live.reader.rows = [engageRow({ id: `cancel-all-${scope}`, scope, scopeRef: scope === "GLOBAL" ? null : SAFETY_ACCOUNT, action: "CANCEL_ALL" })];
      await r.live.step(3_000);
      expect(r.live.world.clob.openOrderIds("trader")).toEqual([]);
      expect(r.oms.order(r.orderId)?.state).toBe("CANCELED");
      const sendsAtStop = r.live.world.clob.heartbeatReceipts("trader").length;
      await r.live.step(20_000);
      expect(r.live.world.clob.heartbeatReceipts("trader").length - sendsAtStop).toBeLessThanOrEqual(1);
      expect(r.live.controller.isLapsed()).toBe(true);
      expect(r.live.world.u.violations).toEqual([]);
    });
  }

  it("a TRANSPORT failure on the heartbeat path (the gate still passes): nothing valid reaches the venue, the controller lapses 10 s after its last confirmed send, entries are blocked; the venue cancels; reconciliation reflects it", async () => {
    const r = await resting();
    r.live.world.clob.heartbeatOutage("trader", true);
    await r.live.step(4_000);
    expect(r.live.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    await r.live.step(14_000);
    expect(r.live.controller.isLapsed()).toBe(true);
    const lapse = r.live.heartbeatEvents.of("LAPSE_STARTED").at(-1);
    expect(lapse?.cause).not.toBe("GATE_REFUSED");
    expect(r.live.entryReasons().length).toBeGreaterThan(0);
    // The outage is network-side: the venue never saw the attempts.
    expect(r.live.world.clob.log.filter((entry) => entry.kind === "HEARTBEAT" && entry.detail === "never-arrived").length).toBeGreaterThan(1);
    await expectVenueCancelThenReconciled(r, "transport failure");
    // The path recovers: the next confirmed heartbeat ends the lapse, and the D6 recovery lifts the block after a qualifying run.
    r.live.world.clob.heartbeatOutage("trader", false);
    expect(await untilEntriesOpen(r.live, 40_000)).toBe(true);
    expect(recoveryProblems(r.live.world, r.live.node, !r.oms.paused)).toEqual([]);
  });

  it("a PROCESS STALL of 20 s (no timer runs; the venue's clock does): the venue cancels DURING the stall, inside its window; the process finds itself lapsed, blocks entries, and its recovery reads the cancel", async () => {
    const r = await resting();
    const before = lastValidHeartbeat(r.live);
    r.live.world.time.stall(20_000);
    // The venue evaluates the checks it owes at their own instants, whatever the process did.
    r.live.world.clob.catchUp();
    const sweep = sweepOf(r.live, r.venueOrderId);
    expect(sweep).toBeDefined();
    expect((sweep?.atMs ?? 0) - before).toBeGreaterThan(HEARTBEAT_TIMEOUT_MS);
    expect((sweep?.atMs ?? 0) - before).toBeLessThanOrEqual(HEARTBEAT_TIMEOUT_MS + CANCELLATION_CHECK_MS);
    await r.live.step(1_000);
    expect(r.live.heartbeatEvents.of("LAPSE_STARTED").length).toBeGreaterThan(0);
    expect(r.live.entryReasons().length).toBeGreaterThan(0);
    await expectVenueCancelThenReconciled(r, "process stall");
  });
});

describe("ADR-033 D1 item 3: a MARKET or STRATEGY_INSTANCE kill switch does NOT stop the heartbeat", () => {
  for (const scope of ["MARKET", "STRATEGY_INSTANCE"] as const) {
    it(`a ${scope} FULL_HALT: the venue keeps receiving a valid heartbeat every 5 s and sweeps nothing; the switch's own cancel removes its order; entries in its scope are blocked`, async () => {
      const r = await resting();
      r.live.reader.rows = [engageRow({ id: `scoped-${scope}`, scope, scopeRef: scope === "MARKET" ? MARKET : INSTANCE_A, action: "FULL_HALT" })];
      const receiptsBefore = r.live.world.clob.heartbeatReceipts("trader").length;
      await r.live.step(30_000);
      const receipts = r.live.world.clob.heartbeatReceipts("trader").slice(receiptsBefore);
      expect(receipts.length).toBeGreaterThanOrEqual(5);
      for (let index = 1; index < receipts.length; index += 1) expect((receipts[index] ?? 0) - (receipts[index - 1] ?? 0)).toBeLessThanOrEqual(5_250);
      expect(r.live.controller.isLapsed()).toBe(false);
      expect(r.live.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
      expect(r.live.world.clob.sweeps.filter((sweep) => sweep.canceled.length > 0)).toEqual([]);
      expect(r.live.entryReasons()).toContain(scope === "MARKET" ? "KILL_SWITCH_MARKET_ENGAGED" : "KILL_SWITCH_INSTANCE_ENGAGED");
      // The switch's own cancel, through the OMS, removed the order; the venue's heartbeat sweep did not.
      expect(r.live.world.clob.openOrderIds("trader")).toEqual([]);
      expect(r.oms.order(r.orderId)?.state).toBe("CANCELED");
      expect(r.live.world.u.violations).toEqual([]);
    });
  }
});
