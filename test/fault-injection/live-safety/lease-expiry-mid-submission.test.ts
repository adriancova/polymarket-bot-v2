/**
 * The packet's fault "a lease expires mid-submission" (§6 invariant 16:
 * "Only the holder of the current account fencing token may submit";
 * ADR-008 §2; `WP-040` R12). The REAL `OrderManager` signs, persists the
 * attempt and transmits through the live composition's fenced venue port;
 * the process stalls inside the signing call long enough for its lease to
 * expire. The transmission that follows must never reach the venue, and the
 * OMS must record that nothing left the process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composition, HEALTH_MAX_AGE, ManualClock } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import type { PlacementClassifier } from "../../../apps/trader/src/live-safety/index.js";
import type { LimitOrderRequest, PlacementOutcome, SignedOrderHandle, SignOutcome } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";
import { group, INSTANCE_A, MARKET, openHarness, reopen, ticket } from "../../unit/oms/support/harness.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const LONG = Object.fromEntries(Object.keys(HEALTH_MAX_AGE).map((input) => [input, 60_000])) as typeof HEALTH_MAX_AGE;

const REFUSALS = {
  signRefused: (reasons: readonly string[]): SignOutcome => ({ kind: "FAILED", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
  placementRefused: (reasons: readonly string[]): PlacementOutcome => ({ kind: "NOT_SENT", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
};

/** The composition's knowledge of each order's decision. The FENCE alone is under test here, so every order is classified a reduction in the harness's market (no heartbeat is attached, which would block an entry). */
const REDUCTION_IN_MARKET: PlacementClassifier<LimitOrderRequest, SignOutcome, SignedOrderHandle> = {
  request: () => ({ intent: "REDUCTION", marketId: MARKET, instanceId: INSTANCE_A }),
  signedOrder: (outcome) => (outcome.kind === "SIGNED" ? outcome.order : undefined),
  order: () => null,
};
const REDUCE = { kind: "REDUCTION", marketId: MARKET, instanceId: INSTANCE_A } as const;

async function setup(): Promise<{ c: ReturnType<typeof composition>; h: Awaited<ReturnType<typeof openHarness>>; manager: Awaited<ReturnType<typeof reopen>>["manager"] }> {
  const clock = new ManualClock();
  // Every proof may be up to 60 s old here, so that the ONLY thing a 30 s stall can break is the 30 s lease.
  const c = composition({ health: { maxAgeMs: LONG, eventLoop: { intervalMs: 500, maxLagMs: 250 } } }, clock);
  expect((await c.safety.acquireFence()).kind).toBe("ACQUIRED");
  c.safety.start();
  await clock.advance(500);
  c.proveComposition();
  expect(c.safety.gate(REDUCE)).toEqual({ permitted: true, reasons: [] });
  const h = await openHarness();
  const { manager } = await reopen(h, { venue: c.safety.fenceVenue(h.venue, REFUSALS, REDUCTION_IN_MARKET) });
  const registered = await manager.registerGroup(group(1));
  expect(registered.ok).toBe(true);
  return { c, h, manager };
}

describe("a lease that expires mid-submission", () => {
  it("expires between the signing (and the attempt's persistence) and the transmission: the venue receives nothing, the attempt is NOT_SENT", async () => {
    const { c, h, manager } = await setup();
    const fence = c.safety.currentFence();
    // The process stalls inside the signing call for a whole lease: the lease expires at the database too.
    h.venue.sign = () => {
      c.clock.stall(30_000);
      return undefined;
    };
    const result = await manager.submit(ticket(group(1), { n: 1 }));
    expect(h.venue.signed).toHaveLength(1);
    expect(h.venue.received).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.placement).toMatchObject({ kind: "NOT_SENT" });
      expect(manager.attempt(result.value.submissionAttemptId)?.state).toBe("ABANDONED");
    }
    expect(c.safety.gate(REDUCE).reasons).toEqual(["FENCE_EXPIRED"]);
    // The database half: an attempt naming the expired lease is refused (migration 0008's trigger).
    expect(c.store.attemptAccepted(fence)).toBe(false);
  });

  it("a stall that leaves less than the transmit margin also refuses the transmission (EXPIRING)", async () => {
    const { c, h, manager } = await setup();
    h.venue.sign = () => {
      // 30 s ttl − 2 s safety = 28 s local lease, acquired at 0 and 500 ms gone: stall to 26.5 s, under the 3 s margin.
      c.clock.stall(26_000);
      return undefined;
    };
    const result = await manager.submit(ticket(group(1), { n: 2 }));
    expect(h.venue.received).toEqual([]);
    expect(result.ok && result.value.placement?.kind).toBe("NOT_SENT");
    expect(c.safety.gate(REDUCE).reasons).toEqual(["FENCE_EXPIRING"]);
  });

  it("a held fence transmits normally (the control)", async () => {
    const { h, manager } = await setup();
    const result = await manager.submit(ticket(group(1), { n: 3 }));
    expect(h.venue.received).toHaveLength(1);
    expect(result.ok && result.value.placement?.kind).toBe("ACCEPTED");
  });

  it("a lost fence refuses SIGNING too: no signed order exists", async () => {
    const { c, h, manager } = await setup();
    await c.safety.releaseFence("shutdown");
    const result = await manager.submit(ticket(group(1), { n: 4 }));
    expect(h.venue.signed).toEqual([]);
    expect(h.venue.received).toEqual([]);
    expect(result.ok).toBe(false);
  });
});
