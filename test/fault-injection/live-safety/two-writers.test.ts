/**
 * The packet's fault "two writers race for the lease"; work-plan acceptance
 * "Two live writers cannot both hold authority" (§2, §6 invariant 16;
 * ADR-008 §1–§2, §5: no order-submitting hot standby). Two full processes
 * (each its own OMS, coordinator, controller and composition) share one
 * fencing store and one time line. The race against a REAL PostgreSQL is
 * `test/integration/postgres/fencing-race.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryFencingStore } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import { ManualTime } from "../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";

import { liveProcess } from "./support/live-process.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

describe("two live writers cannot both hold authority", () => {
  it("a standby never heartbeats or submits while the holder lives; it takes over only after the holder's lease expires; never both", async () => {
    const time = new ManualTime();
    const store = new MemoryFencingStore(() => time.now);
    const a = await liveProcess({ time, store, holderId: "trader-a" });
    const b = await liveProcess({ time, store, holderId: "trader-b", acquire: false });
    expect((await b.safety.acquireFence()).kind).toBe("HELD_ELSEWHERE");

    let bothPermitted = 0;
    let bothHeld = 0;
    const tick = async (ms: number): Promise<void> => {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) {
        await a.step(125);
        await b.step(125);
        const gateA = a.safety.heartbeatGate.evaluate().permitted;
        const gateB = b.safety.heartbeatGate.evaluate().permitted;
        const sendA = a.safety.gate({ kind: "TRANSMISSION" }).permitted;
        const sendB = b.safety.gate({ kind: "TRANSMISSION" }).permitted;
        if ((gateA && gateB) || (sendA && sendB)) bothPermitted += 1;
        // The fence ALONE (not the health lease, which a dead process also fails): never held by both at once.
        if (a.safety.currentFence() !== null && b.safety.currentFence() !== null) bothHeld += 1;
        expect(store.activeHolders("acct-1").length).toBeLessThanOrEqual(1);
      }
    };

    // While A lives: B retries the fence every 5 s and never gets it; B's transport sees nothing.
    for (let round = 0; round < 6; round += 1) {
      await tick(5_000);
      expect((await b.safety.acquireFence()).kind).toBe("HELD_ELSEWHERE");
    }
    expect(a.transport.requests.length).toBeGreaterThan(5);
    expect(b.transport.requests).toEqual([]);
    expect(b.safety.gate({ kind: "TRANSMISSION" }).reasons).toContain("FENCE_NOT_ACQUIRED");

    // A dies: its refreshers and heartbeat stop (no renewal, no release).
    a.safety.stop();
    a.controller.close();
    const aFence = a.safety.currentFence();
    const aSends = a.transport.requests.length;
    let takeover: string | null = null;
    for (let round = 0; round < 10 && takeover === null; round += 1) {
      await tick(5_000);
      const result = await b.safety.acquireFence();
      if (result.kind === "ACQUIRED") takeover = result.fence.fencingToken;
    }
    expect(takeover).not.toBeNull();
    expect(BigInt(takeover ?? "0")).toBeGreaterThan(BigInt(aFence?.fencingToken ?? "0"));
    await tick(15_000);
    expect(b.transport.requests.length).toBeGreaterThan(0);
    expect(a.transport.requests).toHaveLength(aSends);
    // B's first heartbeat followed A's last one by more than A's lease could cover.
    const aLast = a.transport.requests.at(-1)?.atMs ?? 0;
    const bFirst = b.transport.requests[0]?.atMs ?? 0;
    expect(bFirst).toBeGreaterThan(aLast);
    // A's fence is refused by the database (migration 0008) from the takeover on.
    expect(store.attemptAccepted(aFence)).toBe(false);
    expect(store.attemptAccepted(b.safety.currentFence())).toBe(true);
    expect(bothPermitted).toBe(0);
    expect(bothHeld).toBe(0);
  });
});
