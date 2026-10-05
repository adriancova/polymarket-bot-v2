/**
 * Work-plan acceptance "Unhealthy-but-running process stops heartbeat"
 * (handoff §9.18; ADR-008 §3: "a lease on HEALTH, not on liveness"; §9.9
 * "Account state unknown → Stop heartbeat"), against the REAL
 * `ReconciliationCoordinator` and the REAL `OrderManager` (§18.3):
 *
 * - r1 I3: a reconciler that keeps RUNNING and keeps FAILING. Every run is
 *   reported, none passes: the RECONCILER input ages out at its maximum age
 *   and the heartbeat stops. On the candidate a FAILED run proved the input,
 *   and heartbeats continued for as long as the failures did.
 * - r1 I5: an OMS whose persistence call HANGS. `faulted` stays false (a hung
 *   write never sets it), but the store call is pending: the OMS input ages
 *   out and the heartbeat stops. On the candidate `faulted === false` was
 *   stamped "now", and heartbeats continued.
 * - r2 X4: an OMS stuck on its RESERVATION port (WP-300's journal append that
 *   never acknowledges) or its CIPHER, with no store call pending. On 21aee56
 *   only the store was timed: `faulted: false`, nothing tracked pending,
 *   healthy, and four more heartbeats over 20 s despite the 1 s OMS bound
 *   (both verifiers' reproduction). The port is replaced BENEATH the
 *   composition's instrumentation, as the live root's would hang.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HEALTH_MAX_AGE } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
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

describe("r1 I3: a reconciler that keeps failing stops the heartbeat (real coordinator)", () => {
  it("the on-chain collateral read fails for 60 s: every run FAILS, the RECONCILER input ages out, no heartbeat leaves after the bound, and the lapse names it; a passing run restores it", async () => {
    const live = await liveProcess();
    live.reconciler = "REAL";
    await live.step(6_000);
    expect(live.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    const failingFrom = live.time.now;
    live.u.world.faults.readCollateral = () => {
      throw new Error("timeout (synthetic)");
    };
    const sendsAt = (atMs: number): number => live.transport.requests.filter((request) => request.atMs > atMs).length;
    await live.step(60_000);
    // The reconciler ran throughout (the coordinator's own reports), and never passed.
    const gate = live.safety.heartbeatGate.evaluate();
    expect(gate.permitted === false ? gate.reasons : []).toContain("HEALTH_RECONCILER_PROOF_STALE");
    // Nothing was sent once the last passing call was older than the bound (plus one send tick in flight).
    expect(sendsAt(failingFrom + HEALTH_MAX_AGE.RECONCILER + 5_000)).toBe(0);
    const lapse = live.journal.of("LAPSE_STARTED").at(-1);
    expect(lapse?.cause).toBe("GATE_REFUSED");
    expect(lapse?.gateReasons).toContain("HEALTH_RECONCILER_PROOF_STALE");
    // The read recovers: a passing run proves the input again, and the heartbeat resumes.
    delete live.u.world.faults.readCollateral;
    const recovered = live.time.now;
    await live.step(10_000);
    expect(sendsAt(recovered)).toBeGreaterThan(0);
  });
});

describe("r1 I5: an OMS whose persistence hangs stops the heartbeat (real OrderManager)", () => {
  it("a submission's store write never settles: `faulted` stays false, the OMS input ages out, no heartbeat leaves after the bound, and the lapse names it", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    expect(live.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    live.holdStore = true;
    const hungFrom = live.time.now;
    void submitOne(live.oms);
    await live.step(20_000);
    expect(live.oms.faulted).toBe(false);
    expect(live.omsProgress.pendingCount()).toBeGreaterThan(0);
    const gate = live.safety.heartbeatGate.evaluate();
    expect(gate.permitted === false ? gate.reasons : []).toContain("HEALTH_OMS_PROOF_STALE");
    expect(live.transport.requests.filter((request) => request.atMs > hungFrom + HEALTH_MAX_AGE.OMS + 5_000)).toEqual([]);
    const lapse = live.journal.of("LAPSE_STARTED").at(-1);
    expect(lapse?.gateReasons).toContain("HEALTH_OMS_PROOF_STALE");
  });
});

describe("r2 X4: an OMS stuck on its reservation port or its cipher stops the heartbeat (real OrderManager)", () => {
  for (const port of ["reservations", "cipher"] as const) {
    it(`a submission's ${port === "reservations" ? "reservation (reserve)" : "payload seal (encrypt)"} never answers: no store call pending, \`faulted\` false, the OMS input ages out, no heartbeat leaves after the bound`, async () => {
      const live = await liveProcess();
      await live.step(6_000);
      expect(live.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
      let entered = false;
      const hang = async (): Promise<never> => {
        entered = true;
        return new Promise<never>(() => undefined);
      };
      if (port === "reservations") live.u.inventory.service.reserve = hang;
      else live.u.cipher.encrypt = hang;
      const hungFrom = live.time.now;
      void submitOne(live.oms);
      for (let turn = 0; turn < 200 && !entered; turn += 1) await Promise.resolve();
      expect(entered).toBe(true);
      await live.step(20_000);
      expect(live.oms.faulted).toBe(false);
      expect(live.omsProgress.pendingCount()).toBe(1);
      const gate = live.safety.heartbeatGate.evaluate();
      expect(gate.permitted === false ? gate.reasons : []).toContain("HEALTH_OMS_PROOF_STALE");
      expect(live.transport.requests.filter((request) => request.atMs > hungFrom + HEALTH_MAX_AGE.OMS + 5_000)).toEqual([]);
      const lapse = live.journal.of("LAPSE_STARTED").at(-1);
      expect(lapse?.gateReasons).toContain("HEALTH_OMS_PROOF_STALE");
      live.safety.stop();
      live.controller.close();
    });
  }
});
