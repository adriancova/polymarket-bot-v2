/**
 * Handoff §16.6's "Heartbeat response invalid/expired" (ADR-033 D2: it runs
 * here), through the whole composition: the documented 400 recovery
 * (S-D17: "Sign a new request with that ID and retry"), and repeated invalid
 * ids as evidence of a second writer on these credentials (ADR-008 §4: "must
 * raise a live-fencing-conflict alert"), which stops the heartbeat until an
 * operator releases it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidId } from "../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";

import { liveProcess, submitOne } from "./support/live-process.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

describe("the heartbeat answers invalid or expired id (§16.6)", () => {
  it("one 400 is recovered by ONE request with the expected id, at once; the lapse clock never trips; no page", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    live.transport.script.push(invalidId("expected-77"));
    const before = live.transport.requests.length;
    await live.step(5_000);
    const sent = live.transport.requests.slice(before).map((request) => request.heartbeatId);
    expect(sent[1]).toBe("expected-77");
    expect(live.log.of("LIVE_FENCING_CONFLICT")).toEqual([]);
    expect(live.alerts.pages).toEqual([]);
    expect(live.controller.isLapsed()).toBe(false);
    // The recovered id is persisted with the lease (ADR-008 §4).
    expect(live.store.rows.find((row) => row.status === "ACTIVE")?.heartbeatId).toMatch(/^sanitized-heartbeat-id-/u);
  });

  it("repeated 400s page LIVE_FENCING_CONFLICT and stop the heartbeat; the lapse that follows pages too while orders may exist; an operator's release restores it", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    expect(await submitOne(live.oms)).not.toBeNull();
    // Another writer keeps rotating the id: every request is answered 400 with a new expected id.
    let n = 0;
    live.transport.fallback = () => {
      n += 1;
      return invalidId(`other-writer-${String(n)}`);
    };
    await live.step(5_000);
    expect(live.log.of("LIVE_FENCING_CONFLICT").length).toBeGreaterThan(0);
    expect(live.alerts.pages.map((page) => page.page)).toContain("LIVE_FENCING_CONFLICT");
    expect(live.safety.heartbeatGate.evaluate()).toEqual({ permitted: false, reasons: ["STOPPED_LIVE_FENCING_CONFLICT"] });
    const sends = live.transport.requests.length;
    await live.step(15_000);
    expect(live.transport.requests).toHaveLength(sends);
    expect(live.journal.of("LAPSE_STARTED").at(-1)?.gateReasons).toContain("STOPPED_LIVE_FENCING_CONFLICT");
    expect(live.alerts.pages.map((page) => page.page)).toContain("HEARTBEAT_HEALTH_LEASE_FAILED_WHILE_ORDERS_MAY_EXIST");
    expect(live.safety.gate({ kind: "TRANSMISSION" }).reasons).toContain("STOPPED_LIVE_FENCING_CONFLICT");

    // The operator has looked; the venue answers normally again.
    live.transport.fallback = (_request, index) => ({ answer: { kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: `id-${String(index)}` } } });
    expect(live.safety.releaseHeartbeatStop("LIVE_FENCING_CONFLICT", "operator-1")).toBe(true);
    await live.step(12_000);
    expect(live.transport.requests.length).toBeGreaterThan(sends);
    expect(live.entryReasons()).toEqual([]);
  });
});
