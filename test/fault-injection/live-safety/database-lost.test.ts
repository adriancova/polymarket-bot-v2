/**
 * The packet's fault "the database is lost" (handoff §4.2: "A PostgreSQL
 * outage stops new trading decisions and order submission. Heartbeats stop,
 * causing venue-side cancellation of open orders"; §16.6 "PostgreSQL
 * outage"; ADR-008 Consequences: "Losing PostgreSQL loses trading, on
 * purpose").
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";

import { liveProcess, REDUCE, submitOne } from "./support/live-process.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

describe("the database is lost", () => {
  it("the health lease fails, the heartbeat stops, the lapse pages with orders open, every submission is refused, and the fence lapses for good", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    expect(live.entryReasons()).toEqual([]);
    expect(await submitOne(live.oms)).not.toBeNull();
    const sentBefore = live.transport.requests.length;
    const fenceBefore = live.safety.currentFence();

    // PostgreSQL goes away: the fence store and the kill-switch read both fail.
    live.store.down = true;
    live.reader.failing = true;
    await live.step(1_000);
    const gate = live.safety.heartbeatGate.evaluate();
    expect(gate.permitted).toBe(false);
    expect(gate.permitted === false ? gate.reasons : []).toEqual(expect.arrayContaining(["HEALTH_DATABASE_KILL_SWITCH_READ_FAILED", "HEALTH_KILL_SWITCH_READ_FAILED"]));
    for (const kind of ["NEW_ENTRY", "REDUCTION"] as const) {
      expect(live.safety.gate({ kind, marketId: "0190a3e0-0000-7000-8000-00000000000c", instanceId: "0190a3e0-0000-7000-8000-00000000000a" }).permitted).toBe(false);
    }
    expect(live.safety.gate(REDUCE).reasons).toContain("KILL_SWITCH_UNKNOWN_READ_FAILED");

    // No heartbeat leaves after the next tick; the lapse follows 10 s after the last confirmed send.
    await live.step(5_000);
    const sentAtOutage = live.transport.requests.length;
    expect(sentAtOutage - sentBefore).toBeLessThanOrEqual(1);
    await live.step(10_000);
    expect(live.transport.requests).toHaveLength(sentAtOutage);
    const lapse = live.journal.of("LAPSE_STARTED").at(-1);
    expect(lapse?.cause).toBe("GATE_REFUSED");
    expect(lapse?.gateReasons).toContain("HEALTH_KILL_SWITCH_READ_FAILED");
    expect(live.alerts.pages.map((page) => page.page)).toEqual(
      expect.arrayContaining(["KILL_SWITCH_STATE_UNREADABLE", "HEARTBEAT_HEALTH_LEASE_FAILED_WHILE_ORDERS_MAY_EXIST"]),
    );
    expect(live.journal.of("LAPSE_RECONCILIATION_REQUESTED").length).toBeGreaterThan(0);

    // The fence's renewals had no answer: the grant lapses at its local deadline and stays lost.
    await live.step(15_000);
    expect(live.safety.status().fence).toMatchObject({ held: false, reason: "EXPIRED" });

    // PostgreSQL returns. The stale grant is never renewed: only a new acquisition, with a higher token, restores it,
    // and only after the process has waited out the bound on every lease (r1 I1; r2 X1).
    live.store.down = false;
    live.reader.failing = false;
    await live.step(6_000);
    expect(live.safety.status().fence).toMatchObject({ held: false, reason: "EXPIRED" });
    expect(live.store.attemptAccepted(fenceBefore)).toBe(false);
    expect((await live.safety.acquireFence()).kind).toBe("LAPSED_WAITING");
    // r2 X1: the bound on every lease (one minute) plus the margin.
    await live.step(62_000);
    const again = await live.safety.acquireFence();
    expect(again.kind).toBe("ACQUIRED");
    expect(again.kind === "ACQUIRED" ? BigInt(again.fence.fencingToken) : 0n).toBeGreaterThan(BigInt(fenceBefore?.fencingToken ?? "0"));
    await live.step(6_000);
    expect(live.transport.requests.length).toBeGreaterThan(sentAtOutage);
  });
});
