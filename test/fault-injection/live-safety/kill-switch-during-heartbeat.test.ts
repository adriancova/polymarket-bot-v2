/**
 * The packet's fault "the kill switch is engaged during a heartbeat"
 * (ADR-008 §8: "Kill switches outrank everything"; ADR-033 D1 item 3:
 * kill-switch state reaches the gate through the health lease, and a MARKET
 * or STRATEGY_INSTANCE switch never stops the heartbeat; §14.1).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { engageRow, releaseRow } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
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

const MARKET = "0190a3e0-0000-7000-8000-00000000000c";
const INSTANCE = "0190a3e0-0000-7000-8000-00000000000a";

describe("a GLOBAL FULL_HALT engaged while a heartbeat is in flight", () => {
  it("the in-flight heartbeat completes; no further heartbeat is sent; the lapse follows; cancel-all is requested, then confirmed once; nothing may be submitted", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    expect(await submitOne(live.oms)).not.toBeNull();
    // The next heartbeat's answer is held: it is in flight when the switch is engaged.
    live.transport.script.push({ defer: true });
    await live.step(5_000);
    expect(live.controller.status().inFlight).toBe(true);
    const inFlightSends = live.transport.requests.length;
    live.reader.rows = [engageRow({ id: "kill-1", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    // Within one refresh interval the switch is read: every submission is refused at once.
    await live.step(1_000);
    expect(live.safety.gate(REDUCE).reasons).toContain("KILL_SWITCH_ACCOUNT_ENDS_TRADING");
    expect(live.entryReasons()).toContain("KILL_SWITCH_ACCOUNT_ENGAGED");
    // The heartbeat already in flight completes (it left before the switch); nothing leaves after it.
    live.transport.resolveDeferred({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: "id-in-flight" } });
    await live.step(20_000);
    expect(live.transport.requests).toHaveLength(inFlightSends);
    const gate = live.safety.heartbeatGate.evaluate();
    expect(gate.permitted === false ? gate.reasons : []).toContain("HEALTH_KILL_SWITCH_ENGAGED_STOPS_HEARTBEAT");
    const lapse = live.journal.of("LAPSE_STARTED").at(-1);
    expect(lapse?.cause).toBe("GATE_REFUSED");
    expect(lapse?.gateReasons).toContain("HEALTH_KILL_SWITCH_ENGAGED_STOPS_HEARTBEAT");
    // The first sweep, and ONE confirming sweep a refresh interval later (r1 I2: an order in flight at the switch).
    expect(live.cancels.calls).toEqual(['{"scope":"ACCOUNT"}', '{"scope":"ACCOUNT"}']);
    expect(live.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => entry.pass)).toEqual(["FIRST", "CONFIRMING"]);

    // Released: the release settles (r1 I6), the heartbeat resumes, and the D6 recovery lifts the entry block only
    // after a qualifying run.
    live.reader.rows = [releaseRow({ id: "kill-2", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await live.step(1_500);
    // Not settled yet: still the switch it releases.
    expect(live.safety.gate(REDUCE).reasons).toContain("KILL_SWITCH_ACCOUNT_ENDS_TRADING");
    await live.step(6_000);
    expect(live.transport.requests.length).toBeGreaterThan(inFlightSends);
    expect(live.entryReasons()).toContain("HEARTBEAT_RECOVERY_PENDING");
    await live.step(6_000);
    expect(live.entryReasons()).toEqual([]);
  });

  it("a GLOBAL CANCEL_ALL stops the heartbeat too; HALT_NEW_ENTRIES and MANAGE_POSITIONS_ONLY do not", async () => {
    for (const [action, stops] of [
      ["CANCEL_ALL", true],
      ["CANCEL_MARKET", true],
      ["HALT_NEW_ENTRIES", false],
      ["MANAGE_POSITIONS_ONLY", false],
    ] as const) {
      const live = await liveProcess();
      await live.step(6_000);
      const sends = live.transport.requests.length;
      live.reader.rows = [engageRow({ id: `g-${action}`, scope: "GLOBAL", scopeRef: null, action })];
      await live.step(20_000);
      expect(live.transport.requests.length - sends > 1, action).toBe(!stops);
      expect(live.entryReasons(), action).toContain("KILL_SWITCH_ACCOUNT_ENGAGED");
    }
  });
});

describe("a MARKET or STRATEGY_INSTANCE switch never stops the heartbeat (ADR-033 D1 item 3)", () => {
  for (const scope of ["MARKET", "STRATEGY_INSTANCE"] as const) {
    it(`a ${scope} FULL_HALT engaged during a heartbeat: heartbeats continue every 5 s, its scope is blocked and its orders' cancel requested`, async () => {
      const live = await liveProcess();
      await live.step(6_000);
      live.transport.script.push({ defer: true });
      await live.step(5_000);
      live.reader.rows = [engageRow({ id: "scoped", scope, scopeRef: scope === "MARKET" ? MARKET : INSTANCE, action: "FULL_HALT" })];
      live.transport.resolveDeferred({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: "id-x" } });
      const sends = live.transport.requests.length;
      await live.step(30_000);
      expect(live.transport.requests.length - sends).toBe(6);
      expect(live.controller.isLapsed()).toBe(false);
      expect(live.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
      expect(live.entryReasons()).toContain(scope === "MARKET" ? "KILL_SWITCH_MARKET_ENGAGED" : "KILL_SWITCH_INSTANCE_ENGAGED");
      expect(live.safety.gate({ kind: "NEW_ENTRY", marketId: "0190a3e0-0000-7000-8000-0000000000ff", instanceId: "0190a3e0-0000-7000-8000-0000000000ee" }).permitted).toBe(true);
      const directive = scope === "MARKET" ? `{"scope":"MARKET","marketId":"${MARKET}"}` : `{"scope":"STRATEGY_INSTANCE","instanceId":"${INSTANCE}"}`;
      // The first sweep, then one confirming sweep (r1 I2), then nothing more.
      expect(live.cancels.calls).toEqual([directive, directive]);
    });
  }
});

describe("r1 I6: a release the control plane REFUSED and voided never lifts the switch", () => {
  it("a GLOBAL FULL_HALT whose release row landed late and was voided keeps the heartbeat stopped and every order refused, indefinitely", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    live.reader.rows = [engageRow({ id: "kill-1", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await live.step(2_000);
    const sends = live.transport.requests.length;
    // The release's append outlived the control plane's bound: refused 503, its row lands late, then its VOID.
    live.reader.rows = [releaseRow({ id: "late-release", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await live.step(500);
    live.reader.rows = [releaseRow({ id: "late-release", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", voided: true })];
    await live.step(60_000);
    expect(live.transport.requests.length - sends).toBeLessThanOrEqual(1);
    expect(live.safety.gate(REDUCE).reasons).toContain("KILL_SWITCH_ACCOUNT_ENDS_TRADING");
    const gate = live.safety.heartbeatGate.evaluate();
    expect(gate.permitted === false ? gate.reasons : []).toContain("HEALTH_KILL_SWITCH_ENGAGED_STOPS_HEARTBEAT");
  });
});
