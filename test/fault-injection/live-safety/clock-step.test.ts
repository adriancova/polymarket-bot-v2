/**
 * The packet's fault "the clock steps". Every age here is measured on the
 * process's MONOTONIC clock (ADR-033 D6); the database judges its lease by
 * ITS clock (migration 0008). Three steps:
 *
 * 1. the WALL clock steps (an NTP correction, a manual change): nothing in the
 *    fence, the heartbeat or the gate moves;
 * 2. the MONOTONIC source steps backwards (a faulty source): a clock fault,
 *    which voids every age — the heartbeat is lapsed and the fence is lost;
 * 3. the DATABASE clock steps forward past the safety margin: the database's
 *    lease ends early; the next renewal finds it lost (within one renewal
 *    interval), a new holder may take over, and the old one's submission is
 *    refused by the database.
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

describe("the clock steps", () => {
  it("a wall-clock step (forward an hour, then back two) changes nothing: no lapse, the fence held, heartbeats every 5 s", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    const lapses = live.journal.of("LAPSE_STARTED").length;
    const sends = live.transport.requests.length;
    live.time.stepWallClock(3_600_000);
    await live.step(20_000);
    live.time.stepWallClock(-7_200_000);
    await live.step(20_000);
    expect(live.journal.of("LAPSE_STARTED")).toHaveLength(lapses);
    expect(live.safety.status().fence.held).toBe(true);
    expect(live.transport.requests.length - sends).toBe(8);
    expect(live.controller.isLapsed()).toBe(false);
  });

  it("a monotonic source that steps backwards is a clock fault: the heartbeat lapses (CLOCK_FAULT) and the fence is lost", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    const sends = live.transport.requests.length;
    live.time.stepMonotonicBack(60_000);
    expect(live.controller.isLapsed()).toBe(true);
    expect(live.log.of("LAPSE_STARTED").at(-1)?.cause).toBe("CLOCK_FAULT");
    expect(live.safety.status().fence).toMatchObject({ held: false, reason: "CLOCK_FAULT" });
    await live.step(20_000);
    // The fence is gone, so the gate refuses every heartbeat from here: nothing is sent.
    expect(live.transport.requests.length - sends).toBeLessThanOrEqual(0);
    expect(live.safety.gate({ kind: "TRANSMISSION" }).reasons).toContain("FENCE_CLOCK_FAULT");
    expect(live.entryReasons()).toContain("HEARTBEAT_RECOVERY_PENDING");
  });

  it("a database clock that steps forward past the margin ends the lease early: the holder loses it at its next renewal; a takeover is fenced from the old holder", async () => {
    const time = new ManualTime();
    let dbSkew = 0;
    const store = new MemoryFencingStore(() => time.now + dbSkew);
    const a = await liveProcess({ time, store, holderId: "trader-a" });
    await a.step(6_000);
    const aFence = a.safety.currentFence();
    expect(aFence).not.toBeNull();
    // The database's clock jumps 40 s ahead: by its clock, A's lease has expired.
    dbSkew = 40_000;
    expect(store.attemptAccepted(aFence)).toBe(false);
    // A learns it at its next renewal (every 5 s), and stops.
    await a.step(5_000);
    expect(a.safety.status().fence).toMatchObject({ held: false, reason: "RENEW_LOST" });
    const sends = a.transport.requests.length;
    await a.step(10_000);
    expect(a.transport.requests.length - sends).toBeLessThanOrEqual(1);
    // Another process takes the fence with a higher token; A's submissions stay refused.
    const b = await liveProcess({ time, store, holderId: "trader-b" });
    const bFence = b.safety.currentFence();
    expect(BigInt(bFence?.fencingToken ?? "0")).toBeGreaterThan(BigInt(aFence?.fencingToken ?? "0"));
    expect(store.attemptAccepted(aFence)).toBe(false);
    expect(store.attemptAccepted(bFence)).toBe(true);
    expect(a.safety.gate({ kind: "TRANSMISSION" }).permitted).toBe(false);
  });
});
