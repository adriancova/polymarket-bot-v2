/**
 * WP-340 r1 (J1: WP340-V1-01 + CX340-R1-01): the recovery driver releases
 * WP340-F1, and NOTHING ELSE.
 *
 * The suites' recovery driver (`releaseKnownFindings` in
 * `support/live-node.ts`) stands in for an operator who has reviewed
 * WP340-F1. It may release a halting-alert quarantine only when
 * `classifyQuarantine` binds it to F1:
 *
 * - PROVENANCE: the quarantine's alert (WP-290 names it by the OMS instance's
 *   first run id and the alert's ordinal) is bound to the conflict event(s)
 *   that opened it, of every conflict-opening type; for a recovered alert,
 *   to every `conflict: true` event after the last `conflict: false` one in
 *   the log the restarted OMS loaded. Every bound event must be F1's shape;
 *   an ambiguous binding is refused;
 * - STALENESS: each bound `LIVE` was stale when written (the venue already
 *   held the order terminal), and the venue still holds it terminal at the
 *   release.
 *
 * The negative pins below are the two verifiers' witnesses. Against the r0
 * driver (alert text, or any historical F1-shaped event) both were
 * released. PAPER only: the mock CLOB, WP-260's real client, WP-270's OMS,
 * WP-280's manager, WP-290's coordinator.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OrderManager } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import { F1_RELEASES } from "./support/expected-releases.js";
import {
  bootNode,
  classifyQuarantine,
  liveWorld,
  reconcileUntilResumed,
  reconcileUntilResumedOrReviewed,
  RECOVERED_CONFLICT_DETAIL,
  WP340_F1_DETAIL,
  YES,
  type LiveNode,
  type LiveWorld,
} from "./support/live-node.js";
import { recoveryProblems } from "./support/oracle.js";

let tripwire: NetworkTripwire;
/** Every world this file made, so its total of driver releases can be pinned (`support/expected-releases.ts`). */
const worlds: LiveWorld[] = [];
afterAll(() => {
  expect(worlds.reduce((sum, world) => sum + world.findings.length, 0)).toBe(F1_RELEASES.releaseDriver);
});
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const G = group(34901, { tokenId: YES, plannedShares: "5" });

interface Placed {
  readonly world: LiveWorld;
  readonly node: LiveNode;
  readonly oms: OrderManager;
  readonly orderId: string;
}

async function started(): Promise<{ readonly world: LiveWorld; readonly node: LiveNode; readonly oms: OrderManager }> {
  const world = await liveWorld();
  worlds.push(world);
  world.clob.plannedShares.set(`${G.tokenId}|${G.side}`, G.plannedShares);
  const node = await bootNode(world);
  expect(await reconcileUntilResumed(world, node)).toBe(true);
  const oms = node.oms as OrderManager;
  expect((await oms.registerGroup(G)).ok).toBe(true);
  return { world, node, oms };
}

/** WP340-F1's fault-free route 3: placed and canceled before the PLACEMENT frame is pushed; then the frames land. */
async function genuineF1(): Promise<Placed> {
  const { world, node, oms } = await started();
  const t = ticket(G, { n: 1, shares: "1" });
  expect((await oms.submit(t)).ok).toBe(true);
  expect((await oms.requestCancel(t.orderId)).ok).toBe(true);
  await world.time.advance(0);
  expect(oms.alerts().map((alert) => alert.detail)).toEqual([WP340_F1_DETAIL]);
  return { world, node, oms, orderId: t.orderId };
}

function quarantined(node: LiveNode): ReturnType<LiveNode["journal"]["unresolvedBreaks"]> {
  return node.journal.unresolvedBreaks().filter((view) => view.breakClass === "OMS_HALTING_ALERT" && view.status === "QUARANTINED");
}

describe("WP-340 r1: the recovery driver releases WP340-F1 (positive controls)", () => {
  it("a genuine F1 (route 3, no fault): bound to its stale LIVE conflict, released once, and the account resumes consistent", async () => {
    const { world, node } = await genuineF1();
    const resumed = await reconcileUntilResumedOrReviewed(world, node);
    expect(resumed).toBe(true);
    expect(world.findings.map((entry) => entry.detail.endsWith(WP340_F1_DETAIL))).toEqual([true]);
    expect(world.refusedReleases).toEqual([]);
    expect(recoveryProblems(world, node, resumed)).toEqual([]);
  });

  it("a genuine F1 recovered after a crash (its conflict persisted, the process died before any run saw it): the recovered alert is bound to that conflict and released once", async () => {
    const { world, node } = await genuineF1();
    node.reap();
    const restarted = await bootNode(world);
    expect(restarted.oms?.alerts().map((alert) => alert.detail)).toEqual([RECOVERED_CONFLICT_DETAIL]);
    const resumed = await reconcileUntilResumedOrReviewed(world, restarted);
    expect(resumed).toBe(true);
    expect(world.findings.map((entry) => entry.detail.endsWith(RECOVERED_CONFLICT_DETAIL))).toEqual([true]);
    expect(world.refusedReleases).toEqual([]);
    expect(recoveryProblems(world, restarted, resumed)).toEqual([]);
  });
});

describe("WP-340 r1: the recovery driver releases NOTHING ELSE (negative pins; both were released by the r0 driver)", () => {
  it("PROVENANCE (astra's witness): a resolved F1, then an unrecognised-status conflict on the same order, then a crash: the recovered halt is bound to the LATER conflict and is NOT released", async () => {
    const { world, node, oms, orderId } = await genuineF1();
    // The genuine F1 is released (the operator's review) and the account resumes.
    expect(await reconcileUntilResumedOrReviewed(world, node)).toBe(true);
    expect(world.findings).toHaveLength(1);
    expect(oms.order(orderId)?.state).toBe("CANCELED");
    // A status the OMS does not recognise reaches the now-CANCELED order: WP-270 reopens it (a state conflict that is
    // NOT F1's), and the process dies before any run records that alert.
    const venueOrderId = oms.order(orderId)?.venueOrderId ?? "";
    expect((await oms.applyOrderObservation({ venueOrderId, status: "UNKNOWN_NEW_VENUE_STATUS" })).ok).toBe(true);
    expect(oms.alerts().at(-1)?.detail).toBe("a terminal order was observed with an unrecognised status");
    node.reap();
    const restarted = await bootNode(world);
    expect(restarted.oms?.alerts().map((alert) => alert.detail)).toEqual([RECOVERED_CONFLICT_DETAIL]);
    const resumed = await reconcileUntilResumedOrReviewed(world, restarted);
    expect(resumed, "a recovered halt bound to a non-F1 conflict must stay").toBe(false);
    expect(world.findings, "only the first, genuine F1 was released").toHaveLength(1);
    const held = quarantined(restarted);
    expect(held).toHaveLength(1);
    expect(world.refusedReleases.map((entry) => entry.breakId)).toEqual([held[0]?.breakId]);
    expect(world.refusedReleases[0]?.reason).toContain("OBSERVATION_UNRECOGNISED");
    expect(recoveryProblems(world, restarted, resumed).some((problem) => problem.startsWith("halts in a truthful world"))).toBe(true);
  });

  it("STALENESS (Opus's witness, without a mutant): the OMS holds an order CANCELED that the venue holds LIVE, and a true LIVE arrives: the same alert text, but the LIVE was true, so the halt is NOT released", async () => {
    const { world, node, oms } = await started();
    const t = ticket(G, { n: 2, shares: "2" });
    expect((await oms.submit(t)).ok).toBe(true);
    await world.time.advance(0);
    const venueOrderId = oms.order(t.orderId)?.venueOrderId ?? "";
    // Whatever made the OMS believe the order terminal (a defect, a wrong frame), the venue still rests it.
    expect((await oms.applyOrderObservation({ venueOrderId, status: "CANCELED" })).ok).toBe(true);
    expect(oms.order(t.orderId)?.state).toBe("CANCELED");
    expect(world.clob.openOrderIds()).toEqual([venueOrderId]);
    // The venue's next update of the resting order says LIVE, and it is TRUE: WP-270 raises the F1 text.
    expect((await oms.applyOrderObservation({ venueOrderId, status: "LIVE" })).ok).toBe(true);
    expect(oms.alerts().at(-1)?.detail).toBe(WP340_F1_DETAIL);
    const resumed = await reconcileUntilResumedOrReviewed(world, node);
    expect(resumed).toBe(false);
    expect(world.findings, "a true contradiction is not WP340-F1").toEqual([]);
    const held = quarantined(node);
    expect(held).toHaveLength(1);
    const verdict = classifyQuarantine(world, held[0] as Parameters<typeof classifyQuarantine>[1]);
    expect(verdict.f1).toBe(false);
    expect(world.refusedReleases.map((entry) => entry.reason)).toEqual([expect.stringContaining("the venue held the order OPEN when it was written")]);
  });

  it("CONTROL: an unrecognised-status conflict with no F1 in its history is never released", async () => {
    const { world, node, oms } = await started();
    const t = ticket(G, { n: 3, shares: "1" });
    expect((await oms.submit(t)).ok).toBe(true);
    await world.time.advance(0);
    expect((await oms.requestCancel(t.orderId)).ok).toBe(true);
    expect(await reconcileUntilResumed(world, node)).toBe(true);
    expect(oms.alerts()).toEqual([]);
    expect((await oms.applyOrderObservation({ venueOrderId: oms.order(t.orderId)?.venueOrderId ?? "", status: "UNKNOWN_NEW_VENUE_STATUS" })).ok).toBe(true);
    node.reap();
    const restarted = await bootNode(world);
    expect(await reconcileUntilResumedOrReviewed(world, restarted)).toBe(false);
    expect(world.findings).toEqual([]);
    expect(world.refusedReleases).toHaveLength(1);
  });
});
