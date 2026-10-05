/**
 * WP-340 FINDINGS that need product code (STOPPED: `packages/**` is outside
 * this package's paths). Each is pinned twice:
 *
 * - an EXPECTED FAILURE (`it.fails`) that states the behaviour the system
 *   should have, and names the finding: it passes while the defect exists,
 *   and FAILS the day the product is fixed, which is the instruction to
 *   delete the marker;
 * - the behaviour TODAY, asserted in full, so its fail-closed nature (what
 *   holds, what pages, what an operator must do) is evidence and not prose.
 *
 * ## WP340-F1: a retained stream observation drained after a terminal answer halts the market
 *
 * Reproduction (mock CLOB, real WP-260 client, WP-270 OMS, WP-280 manager,
 * WP-290 coordinator; a truthful venue):
 *
 * 1. a placement reaches the venue and its answer is lost (the SDK's
 *    `TransportError`): the attempt is SUBMISSION_UNKNOWN;
 * 2. the venue fills (or cancels) the order; the user channel delivers its
 *    `PLACEMENT` (LIVE) and later events while the attempt is unknown, and
 *    the OMS RETAINS them (WP-270 r3: never dropped);
 * 3. the reconciliation run answers PRESENT with the venue's terminal view:
 *    the OMS adopts the venue order id and the terminal state (FILLED or
 *    CANCELED), and only THEN drains the retained evidence;
 * 4. the oldest retained observation, `LIVE`, now reads as "a terminal order
 *    was observed LIVE": a halting EVIDENCE_CONFLICT alert. WP-290
 *    quarantines the market (`OMS_HALTING_ALERT`) and pauses submissions.
 *
 * The SAME halt follows by a second route, with nothing lost: a frame that
 * LAGS a read. The order is placed and acknowledged (its venue id known),
 * its `PLACEMENT` frame is delayed, the venue fills it, a reconciliation
 * read records it FILLED, and the late `PLACEMENT` (LIVE) then reads as "a
 * terminal order was observed LIVE". The user channel carries a venue
 * timestamp on every event; the OMS's observation port takes none, so it
 * cannot tell a stale observation from a contradiction.
 *
 * And by a THIRD route, with no fault at all: the OMS places an order and
 * cancels it before the user channel has delivered its `PLACEMENT` frame
 * (the venue answered two REST calls faster than one push); the cancel's
 * answer made the order CANCELED, and the frame then reads LIVE. Any
 * cancel or replace faster than the push latency can therefore halt its
 * market.
 *
 * Safety holds (nothing is sent, the account never resumes until an
 * operator releases the quarantine, and the release resumes only a
 * consistent account), but every lost answer whose order completes before
 * the reconciliation read, with the stream timely, halts its market. The fix
 * is in `packages/oms` (the order in which an adopted answer and the drain of
 * retained evidence are applied; related: WP270-R4-01, the adoption and the
 * drain are not crash-atomic either). PAPER only, mock venue.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OrderManager } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import { bootNode, liveWorld, reconcileUntilResumed, WP340_F1_DETAIL, YES, type LiveNode, type LiveWorld } from "./support/live-node.js";
import { recoveryProblems } from "./support/oracle.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const G = group(34201, { tokenId: YES, plannedShares: "5" });

/** Steps 1–2: the answer is lost, the venue completes the order (`complete`), and the stream delivers while the attempt is unknown. */
async function lostAnswerThenCompleted(complete: (world: LiveWorld, salt: string) => void): Promise<{ readonly world: LiveWorld; readonly node: LiveNode; readonly oms: OrderManager }> {
  const world = await liveWorld();
  const node = await bootNode(world);
  expect(await reconcileUntilResumed(world, node)).toBe(true);
  const oms = node.oms as OrderManager;
  expect((await oms.registerGroup(G)).ok).toBe(true);
  world.clob.answers.push("LOST_AFTER");
  const submitted = await oms.submit(ticket(G, { n: 1, shares: "1" }));
  expect(submitted.ok && submitted.value.attemptState).toBe("RECONCILING");
  const salt = world.clob.receipts.at(-1) as string;
  complete(world, salt);
  await world.time.advance(0);
  // The stream's observations of the order were retained: its venue id is not yet the OMS's.
  expect(oms.retainedEvidence().filter((item) => item.kind === "OBSERVATION").length).toBeGreaterThan(0);
  return { world, node, oms };
}

const FILLED = (world: LiveWorld, salt: string): void => void world.clob.match(salt, "1");
const CANCELED = (world: LiveWorld, salt: string): void => void world.clob.cancel(world.clob.venueOrderIdOf(salt));

/** Route 2: the venue id is known, the PLACEMENT frame lags, the order fills and a read records it FILLED; then the stale frame lands. */
async function laggingPlacementAfterFill(): Promise<{ readonly world: LiveWorld; readonly node: LiveNode; readonly oms: OrderManager }> {
  const world = await liveWorld();
  const node = await bootNode(world);
  expect(await reconcileUntilResumed(world, node)).toBe(true);
  const oms = node.oms as OrderManager;
  expect((await oms.registerGroup(G)).ok).toBe(true);
  if (node.channel === null) throw new Error("no user channel");
  node.channel.chaos = { policy: (frame) => (frame.type === "PLACEMENT" ? { delayMs: 20_000 } : "DELIVER"), dropAfter: null, dropCause: "TRANSPORT_ERROR" };
  const submitted = await oms.submit(ticket(G, { n: 1, shares: "1" }));
  expect(submitted.ok && submitted.value.orderState).toBe("LIVE");
  world.clob.match(world.clob.receipts.at(-1) as string, "1");
  expect(await reconcileUntilResumed(world, node, 3)).toBe(true);
  expect(oms.orders().map((order) => order.state)).toEqual(["FILLED"]);
  await world.time.advance(21_000);
  return { world, node, oms };
}

describe("WP340-F1 (STOPPED), route 2: a frame that lags a read, with nothing lost", () => {
  it.fails("EXPECTED FAILURE, WP340-F1 (lagging frame): a late PLACEMENT (LIVE) of an order a read already recorded FILLED should change nothing", async () => {
    const { world, node, oms } = await laggingPlacementAfterFill();
    expect(oms.alerts()).toEqual([]);
    expect(await reconcileUntilResumed(world, node, 3)).toBe(true);
    expect(world.u.halts).toEqual([]);
  });

  it("TODAY, WP340-F1 (lagging frame): the stale LIVE raises the halting alert, the market is quarantined, and an operator's release resumes a consistent account", async () => {
    const { world, node, oms } = await laggingPlacementAfterFill();
    expect(oms.alerts()).toEqual([expect.objectContaining({ kind: "EVIDENCE_CONFLICT", haltMarket: true, detail: WP340_F1_DETAIL })]);
    expect(await reconcileUntilResumed(world, node, 3)).toBe(false);
    const quarantined = node.journal.unresolvedBreaks();
    expect(quarantined.map((view) => [view.breakClass, view.status])).toEqual([["OMS_HALTING_ALERT", "QUARANTINED"]]);
    expect((await node.coordinator.releaseQuarantine({ breakId: quarantined[0]?.breakId ?? "", operatorRef: "operator-1", reason: "lagging frame reviewed" })).ok).toBe(true);
    expect(await reconcileUntilResumed(world, node, 6)).toBe(true);
    world.findings.push({ finding: "WP340-F1", breakId: quarantined[0]?.breakId ?? "", detail: WP340_F1_DETAIL });
    expect(recoveryProblems(world, node, true)).toEqual([]);
  });
});

/** Route 3: placed and cancelled through the OMS before the PLACEMENT frame is delivered; then the frame lands. */
async function cancelledBeforeItsPlacementFrame(): Promise<{ readonly world: LiveWorld; readonly node: LiveNode; readonly oms: OrderManager }> {
  const world = await liveWorld();
  const node = await bootNode(world);
  expect(await reconcileUntilResumed(world, node)).toBe(true);
  const oms = node.oms as OrderManager;
  expect((await oms.registerGroup(G)).ok).toBe(true);
  const t = ticket(G, { n: 1, shares: "1" });
  expect((await oms.submit(t)).ok).toBe(true);
  expect((await oms.requestCancel(t.orderId)).ok).toBe(true);
  expect(oms.order(t.orderId)?.state).toBe("CANCELED");
  // The push latency elapses: the PLACEMENT (LIVE) and CANCELLATION frames are delivered, in the venue's order.
  await world.time.advance(0);
  return { world, node, oms };
}

describe("WP340-F1 (STOPPED), route 3: a cancel answered before the order's PLACEMENT frame, with no fault at all", () => {
  it.fails("EXPECTED FAILURE, WP340-F1 (cancel before the frame): placing and cancelling faster than the push latency should change nothing", async () => {
    const { world, node, oms } = await cancelledBeforeItsPlacementFrame();
    expect(oms.alerts()).toEqual([]);
    expect(await reconcileUntilResumed(world, node, 3)).toBe(true);
    expect(world.u.halts).toEqual([]);
  });

  it("TODAY, WP340-F1 (cancel before the frame): the late LIVE raises the halting alert and the market is quarantined until an operator releases it", async () => {
    const { world, node, oms } = await cancelledBeforeItsPlacementFrame();
    expect(oms.alerts()).toEqual([expect.objectContaining({ kind: "EVIDENCE_CONFLICT", haltMarket: true, detail: WP340_F1_DETAIL })]);
    expect(await reconcileUntilResumed(world, node, 3)).toBe(false);
    const quarantined = node.journal.unresolvedBreaks();
    expect(quarantined.map((view) => [view.breakClass, view.status])).toEqual([["OMS_HALTING_ALERT", "QUARANTINED"]]);
    expect((await node.coordinator.releaseQuarantine({ breakId: quarantined[0]?.breakId ?? "", operatorRef: "operator-1", reason: "late placement frame reviewed" })).ok).toBe(true);
    expect(await reconcileUntilResumed(world, node, 6)).toBe(true);
    world.findings.push({ finding: "WP340-F1", breakId: quarantined[0]?.breakId ?? "", detail: WP340_F1_DETAIL });
    expect(recoveryProblems(world, node, true)).toEqual([]);
  });
});

describe("WP340-F1 (STOPPED): a retained stream observation drained after a terminal reconciliation answer halts the market", () => {
  for (const [variant, complete] of [
    ["filled", FILLED],
    ["canceled", CANCELED],
  ] as const) {
    it.fails(`EXPECTED FAILURE, WP340-F1 (${variant}): a truthful venue, a lost answer, the order ${variant} before the read: the account should resume with no halt`, async () => {
      const { world, node } = await lostAnswerThenCompleted(complete);
      const resumed = await reconcileUntilResumed(world, node, 6);
      expect(node.journal.unresolvedBreaks().map((view) => view.breakClass)).toEqual([]);
      expect(world.u.halts).toEqual([]);
      expect(resumed).toBe(true);
    });

    it(`TODAY, WP340-F1 (${variant}): the market is quarantined and submissions stay paused until an operator releases it; the release resumes a consistent account`, async () => {
      const { world, node, oms } = await lostAnswerThenCompleted(complete);
      const resumed = await reconcileUntilResumed(world, node, 6);
      expect(resumed).toBe(false);
      expect(oms.alerts()).toEqual([expect.objectContaining({ kind: "EVIDENCE_CONFLICT", haltMarket: true, detail: WP340_F1_DETAIL })]);
      const quarantined = node.journal.unresolvedBreaks();
      expect(quarantined.map((view) => [view.breakClass, view.status])).toEqual([["OMS_HALTING_ALERT", "QUARANTINED"]]);
      expect(world.u.halts.every((halt) => halt.breakId === quarantined[0]?.breakId)).toBe(true);
      expect(world.u.halts.length).toBeGreaterThan(0);
      // Fail-closed: a new order is refused while it holds.
      const refused = await oms.submit(ticket(G, { n: 2, shares: "1" }));
      expect(refused.ok).toBe(false);
      // Nothing about the venue is wrong: one order, the OMS's view equals it, nothing was sent twice.
      expect(world.clob.orders.size).toBe(1);
      expect(world.clob.receipts).toHaveLength(1);
      // The operator's review: release it; the next run must pass on its own, and does, with the account consistent.
      const released = await node.coordinator.releaseQuarantine({ breakId: quarantined[0]?.breakId ?? "", operatorRef: "operator-1", reason: "stale stream observation reviewed" });
      expect(released.ok).toBe(true);
      expect(await reconcileUntilResumed(world, node, 6)).toBe(true);
      expect(world.u.violations).toEqual([]);
      world.findings.push({ finding: "WP340-F1", breakId: quarantined[0]?.breakId ?? "", detail: WP340_F1_DETAIL });
      expect(recoveryProblems(world, node, true)).toEqual([]);
    });
  }
});
