/**
 * The packet's fault "two writers race for the lease"; work-plan acceptance
 * "Two live writers cannot both hold authority" (§2, §6 invariant 16;
 * ADR-008 §1–§2, §5: no order-submitting hot standby). Two full processes
 * (each its own OMS, coordinator, controller and composition) share one
 * fencing store and one time line. A successor waits out the bound on EVERY
 * lease (`FENCING_LEASE_MAX_TTL_MS`, plus its margin) on its own clock, from
 * its first sight of the ended lease, whether the incumbent died or was
 * REVOKED (r1, I1), and whatever lease either was configured with (r2, X1).
 * The race against a REAL PostgreSQL is
 * `test/integration/postgres/fencing-race.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryFencingStore } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import { ManualTime } from "../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";

import { liveProcess, REDUCE } from "./support/live-process.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

type Live = Awaited<ReturnType<typeof liveProcess>>;

/** Two processes stepped together; every 250 ms both gates and both fences are asked. */
function lockstep(a: Live, b: Live, store: MemoryFencingStore): { tick(ms: number): Promise<void>; bothPermitted(): number; bothHeld(): number } {
  let bothPermitted = 0;
  let bothHeld = 0;
  return {
    async tick(ms: number): Promise<void> {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) {
        await a.step(125);
        await b.step(125);
        const gateA = a.safety.heartbeatGate.evaluate().permitted;
        const gateB = b.safety.heartbeatGate.evaluate().permitted;
        const sendA = a.safety.gate(REDUCE).permitted;
        const sendB = b.safety.gate(REDUCE).permitted;
        if ((gateA && gateB) || (sendA && sendB)) bothPermitted += 1;
        // The fence ALONE (not the health lease, which a dead process also fails): never held by both at once.
        if (a.safety.currentFence() !== null && b.safety.currentFence() !== null) bothHeld += 1;
        expect(store.activeHolders("acct-1").length).toBeLessThanOrEqual(1);
      }
    },
    bothPermitted: () => bothPermitted,
    bothHeld: () => bothHeld,
  };
}

describe("two live writers cannot both hold authority", () => {
  it("a standby never heartbeats or submits while the holder lives; it takes over only after waiting out the holder's whole lease; never both", async () => {
    const time = new ManualTime();
    const store = new MemoryFencingStore(() => time.now);
    const a = await liveProcess({ time, store, holderId: "trader-a" });
    const b = await liveProcess({ time, store, holderId: "trader-b", acquire: false });
    expect((await b.safety.acquireFence()).kind).toBe("HELD_ELSEWHERE");
    const pairOf = lockstep(a, b, store);
    const tick = pairOf.tick;

    // While A lives: B retries the fence every 5 s and never gets it; B's transport sees nothing.
    for (let round = 0; round < 6; round += 1) {
      await tick(5_000);
      expect((await b.safety.acquireFence()).kind).toBe("HELD_ELSEWHERE");
    }
    expect(a.transport.requests.length).toBeGreaterThan(5);
    expect(b.transport.requests).toEqual([]);
    expect(b.safety.gate(REDUCE).reasons).toContain("FENCE_NOT_ACQUIRED");

    // A dies: its refreshers and heartbeat stop (no renewal, no release).
    a.safety.stop();
    a.controller.close();
    const aFence = a.safety.currentFence();
    const aSends = a.transport.requests.length;
    let takeover: string | null = null;
    for (let round = 0; round < 30 && takeover === null; round += 1) {
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
    expect(pairOf.bothPermitted()).toBe(0);
    expect(pairOf.bothHeld()).toBe(0);
  });

  it("r1 I1: an operator REVOKES the live holder; the standby asking at once is NOT granted; the holder stops at its next renewal; the standby takes over a whole lease after its first sight; never both, and the revoked holder sends nothing after its loss", async () => {
    const time = new ManualTime();
    const store = new MemoryFencingStore(() => time.now);
    const a = await liveProcess({ time, store, holderId: "trader-a" });
    const b = await liveProcess({ time, store, holderId: "trader-b", acquire: false });
    const pairOf = lockstep(a, b, store);
    await pairOf.tick(6_000);
    const aFence = a.safety.currentFence();
    if (aFence === null) throw new Error("A holds no fence");
    expect(store.revoke(aFence.fencingLeaseId, "operator: suspected second writer")).toBe(true);
    // The standby asks immediately: on the candidate it was granted here, with A still held.
    const asked = await b.safety.acquireFence();
    expect(asked).toMatchObject({ kind: "LAPSED_WAITING", status: "REVOKED" });
    const firstSight = time.now;
    let takeoverAt: number | null = null;
    for (let round = 0; round < 160 && takeoverAt === null; round += 1) {
      await pairOf.tick(500);
      if ((await b.safety.acquireFence()).kind === "ACQUIRED") takeoverAt = time.now;
    }
    expect(takeoverAt).not.toBeNull();
    // r2 X1: the bound on every lease (one minute) plus the standby's margin, not its own lease.
    expect((takeoverAt ?? 0) - firstSight).toBeGreaterThanOrEqual(62_000);
    expect(a.journal.of("FENCE_LOST").map((entry) => entry.reason)).toEqual(["RENEW_LOST"]);
    const aLastSend = a.transport.requests.at(-1)?.atMs ?? 0;
    await pairOf.tick(15_000);
    expect(b.transport.requests.length).toBeGreaterThan(0);
    expect(b.transport.requests[0]?.atMs ?? 0).toBeGreaterThan(aLastSend);
    expect(pairOf.bothPermitted()).toBe(0);
    expect(pairOf.bothHeld()).toBe(0);
  });

  it("r2 X1: a standby configured with a SHORTER lease (2 s) than the holder (60 s): the holder is revoked right after a renewal and stays connected; the standby asks at once and keeps asking; never both held or both permitted", async () => {
    const time = new ManualTime();
    const store = new MemoryFencingStore(() => time.now);
    const a = await liveProcess({ time, store, holderId: "trader-a", safety: { fencing: { store, ttlMs: 60_000, renewIntervalMs: 5_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 } } });
    const b = await liveProcess({ time, store, holderId: "trader-b", acquire: false, safety: { fencing: { store, ttlMs: 2_000, renewIntervalMs: 500, safetyMarginMs: 250, transmitMarginMs: 250 } } });
    const pairOf = lockstep(a, b, store);
    await pairOf.tick(6_000);
    // Revoke right after one of A's renewals: A learns of it only at its NEXT renewal, up to 5 s later.
    const renewals = store.calls.filter((call) => call === "renew").length;
    for (let guard = 0; guard < 40 && store.calls.filter((call) => call === "renew").length === renewals; guard += 1) await pairOf.tick(250);
    const aFence = a.safety.currentFence();
    if (aFence === null) throw new Error("A holds no fence");
    expect(store.revoke(aFence.fencingLeaseId, "operator: suspected second writer")).toBe(true);
    expect((await b.safety.acquireFence()).kind).toBe("LAPSED_WAITING");
    const firstSight = time.now;
    let takeoverAt: number | null = null;
    for (let round = 0; round < 160 && takeoverAt === null; round += 1) {
      await pairOf.tick(500);
      if ((await b.safety.acquireFence()).kind === "ACQUIRED") takeoverAt = time.now;
    }
    // Both fences and both gates are sampled on after the grant too.
    await pairOf.tick(5_000);
    // On 21aee56 the standby presented after its OWN 2.25 s, while A held until its next renewal: both held.
    expect(pairOf.bothHeld()).toBe(0);
    expect(pairOf.bothPermitted()).toBe(0);
    expect(takeoverAt).not.toBeNull();
    expect((takeoverAt ?? 0) - firstSight).toBeGreaterThanOrEqual(60_250);
    expect(a.journal.of("FENCE_LOST").map((entry) => entry.reason)).toEqual(["RENEW_LOST"]);
  });
});
