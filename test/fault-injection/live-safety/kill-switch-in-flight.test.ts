/**
 * r2, finding X3 (HIGH; ADR-008 §8: "Kill switches outrank everything";
 * §14.1; ADR-033 D1 item 3), against the REAL `OrderManager` through the
 * composition's fenced venue, with the order heartbeat running.
 *
 * A placement already handed to the venue when a MARKET FULL_HALT is
 * observed — queued beneath the fence (WP-310's rate-limit ladder ranks
 * `EMERGENCY_CANCEL` above `NEW_ORDER`), or simply slow — lands AFTER the
 * first and the confirming cancel sweeps. At round 1 nothing more was asked
 * of the venue: the order rested for good in the halted market while the
 * account's heartbeat (which a MARKET switch never stops) kept it alive (both
 * verifiers' reproduction: cancels at +0 and +1.5 s, the placement landing at
 * +3 s, then 30 s resting with six more heartbeats). Now the cancel is an
 * OBLIGATION: retained while the placement is pending, and renewed once it
 * settles, so the late acceptance is cancelled at the next read.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { engageRow } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import type { PlacementClassifier } from "../../../apps/trader/src/live-safety/index.js";
import type { LimitOrderRequest, PlacementOutcome, SignedOrderHandle, SignOutcome } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";
import { accepted } from "../../unit/oms/support/fake-venue.js";
import { group, openHarness, reopen, ticket } from "../../unit/oms/support/harness.js";

import { liveProcess, SUITE_INSTANCE, SUITE_MARKET } from "./support/live-process.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const REFUSALS = {
  signRefused: (reasons: readonly string[]): SignOutcome => ({ kind: "FAILED", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
  placementRefused: (reasons: readonly string[]): PlacementOutcome => ({ kind: "NOT_SENT", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
};

/** Every order of this suite reduces a position in the suite's market, for the suite's instance. */
const CLASSIFIER: PlacementClassifier<LimitOrderRequest, SignOutcome, SignedOrderHandle> = {
  request: () => ({ intent: "REDUCTION", marketId: SUITE_MARKET, instanceId: SUITE_INSTANCE }),
  signedOrder: (outcome) => (outcome.kind === "SIGNED" ? outcome.order : undefined),
  order: () => null,
};

describe("r2 X3: a placement in flight at a MARKET FULL_HALT that lands after both sweeps is cancelled once it lands (real OrderManager)", () => {
  it("the cancel obligation is RETAINED while the placement is pending and renewed AFTER it settles; the late acceptance does not rest; the heartbeat runs on (a MARKET switch never stops it)", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    const h = await openHarness();
    let land: () => void = () => {
      throw new Error("nothing in flight");
    };
    let resting = false;
    const barrier = new Promise<void>((resolve) => {
      land = resolve;
    });
    h.venue.placement = async () => {
      await barrier;
      resting = true;
      return accepted("late-order");
    };
    const cancelledAt: number[] = [];
    live.cancels.cancel = async (directive) => {
      live.cancels.calls.push(JSON.stringify(directive));
      cancelledAt.push(live.time.now);
      resting = false;
      return true;
    };
    const { manager } = await reopen(h, { venue: live.safety.fenceVenue(h.venue, REFUSALS, CLASSIFIER) });
    expect((await manager.registerGroup(group(1))).ok).toBe(true);
    // Transmitted BEFORE the switch: it passes the fence and is in flight.
    const submission = manager.submit(ticket(group(1), { n: 91 }));
    for (let turn = 0; turn < 100 && h.venue.received.length === 0; turn += 1) await Promise.resolve();
    expect(h.venue.received).toHaveLength(1);

    live.reader.rows = [engageRow({ id: "market-switch", scope: "MARKET", scopeRef: SUITE_MARKET, action: "FULL_HALT" })];
    expect(await live.safety.refreshKillSwitch()).toBe(true);
    await live.step(3_000);
    // FIRST and CONFIRMING, then RETAINED while the placement is pending.
    const passes = (): string[] => live.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => entry.pass);
    expect(passes().slice(0, 2)).toEqual(["FIRST", "CONFIRMING"]);
    expect(passes().slice(2).every((pass) => pass === "RETAINED")).toBe(true);
    expect(resting).toBe(false);

    // The placement lands now, after both sweeps: accepted, resting.
    const landedAt = live.time.now;
    land();
    expect((await submission).ok).toBe(true);
    expect(resting).toBe(true);
    const sendsBefore = live.transport.requests.length;
    await live.step(30_000);
    // On 21aee56: no cancel after the confirming sweep; the order rested for 30 s with six more heartbeats.
    expect(passes()).toContain("AFTER_SETTLE");
    expect(cancelledAt.filter((at) => at >= landedAt).length).toBeGreaterThanOrEqual(1);
    expect(cancelledAt.filter((at) => at >= landedAt)[0] ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(landedAt + 1_000);
    expect(resting).toBe(false);
    // The scope is quiescent: nothing pending, nothing the OMS shows resting there; the obligation asks no more.
    expect(live.safety.pendingPlacements()).toBe(0);
    const settledCount = passes().length;
    await live.step(10_000);
    expect(passes()).toHaveLength(settledCount);
    // A MARKET switch never stops the account's heartbeat (ADR-033 D1 item 3).
    expect(live.transport.requests.length).toBeGreaterThan(sendsBefore);
    live.safety.stop();
    live.controller.close();
  });
});
