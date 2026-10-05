/**
 * WP-320: the live-safety composition over fakes. The heartbeat gate is the
 * fence AND the seven-input health lease AND no explicit stop (ADR-033 D1);
 * kill switches reach it only through the health lease, and a MARKET or
 * STRATEGY_INSTANCE switch never stops it; PAPER cannot build it.
 */

import { describe, expect, it } from "vitest";

import { ACCOUNT, composition, engageRow, FakeBodyPort, FakeCancels, FakeCoordinator, FakeKillSwitchReader, FakeOms, HEALTH_MAX_AGE, ManualClock, MemoryFencingStore, RecordingAlerts, RecordingJournal } from "./fakes.test-support.js";
import { LiveFencingRefusal } from "./fencing-authority.js";
import { createLiveSafety, LiveSafetyConfigurationError } from "./live-safety.js";

/** Acquire the fence, start the refreshers, and let the first reads and proofs land. */
async function ready(c: ReturnType<typeof composition>): Promise<void> {
  expect((await c.safety.acquireFence()).kind).toBe("ACQUIRED");
  c.safety.start();
  await c.clock.advance(500);
  c.proveComposition();
}

describe("paper mode cannot build the live-safety composition (ADR-008 §2; ADR-010)", () => {
  for (const runMode of ["PAPER", "BACKTEST", "SHADOW", "REPLAY"]) {
    it(`${runMode} is refused before any port is touched`, () => {
      const clock = new ManualClock();
      const store = new MemoryFencingStore(() => clock.now);
      const reader = new FakeKillSwitchReader();
      const geoblock = new FakeBodyPort({});
      expect(() =>
        createLiveSafety({
          runMode,
          accountRef: ACCOUNT,
          holderId: "trader-a",
          clock,
          timers: clock,
          fencing: { store, ttlMs: 30_000, renewIntervalMs: 5_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 },
          health: { maxAgeMs: HEALTH_MAX_AGE, eventLoop: { intervalMs: 500, maxLagMs: 250 } },
          killSwitch: { reader, refreshIntervalMs: 1_000, cancels: new FakeCancels() },
          eligibility: { geoblock, closedOnly: geoblock, refreshIntervalMs: 30_000, maxAgeMs: 60_000 },
          oms: new FakeOms(),
          coordinator: new FakeCoordinator(),
          recovery: { notRunPollMs: 100, failedRunSpacingMs: 1_000 },
          journal: new RecordingJournal(),
          alerts: new RecordingAlerts(),
        }),
      ).toThrow(LiveFencingRefusal);
      expect(store.calls).toEqual([]);
      expect(reader.reads).toBe(0);
      expect(geoblock.calls).toBe(0);
    });
  }

  it("refuses refresh intervals that would let a proof age out between refreshes", () => {
    expect(() => composition({ killSwitch: { reader: new FakeKillSwitchReader(), refreshIntervalMs: 3_000, cancels: new FakeCancels() } })).toThrow(LiveSafetyConfigurationError);
  });
});

describe("the heartbeat gate (ADR-033 D1 item 2)", () => {
  it("refuses before the fence is acquired and before every input proves itself; permits once they do", async () => {
    const c = composition();
    expect(c.safety.heartbeatGate.evaluate()).toMatchObject({ permitted: false });
    await ready(c);
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
  });

  it("an unhealthy process that is still running fails the gate: market data stops proving itself", async () => {
    const c = composition();
    await ready(c);
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    // Everything else stays proved; the market-data proof is never refreshed again.
    for (let step = 0; step < 8; step += 1) {
      await c.clock.advance(500);
      c.safety.recordProof("USER_DATA", c.clock.now);
      c.safety.recordProof("RECONCILER", c.clock.now);
    }
    const verdict = c.safety.heartbeatGate.evaluate();
    expect(verdict.permitted).toBe(false);
    expect(verdict.permitted === false ? verdict.reasons : []).toContain("HEALTH_MARKET_DATA_PROOF_STALE");
  });

  it("a faulted OMS fails the gate at once (HEALTH_OMS_FAULTED)", async () => {
    const c = composition();
    await ready(c);
    c.oms.faulted = true;
    const verdict = c.safety.heartbeatGate.evaluate();
    expect(verdict.permitted === false ? verdict.reasons : []).toEqual(["HEALTH_OMS_FAULTED"]);
  });

  it("a lost fence fails the gate (FENCE_RENEW_LOST)", async () => {
    const c = composition();
    await ready(c);
    const fence = c.safety.currentFence();
    if (fence === null) throw new Error("no fence");
    c.store.revoke(fence.fencingLeaseId, "operator revocation");
    await c.clock.advance(5_000);
    const verdict = c.safety.heartbeatGate.evaluate();
    expect(verdict.permitted === false ? verdict.reasons : []).toContain("FENCE_RENEW_LOST");
  });

  it("an explicit stop (§9.9 'Stop heartbeat') fails the gate until an operator releases it", async () => {
    const c = composition();
    await ready(c);
    c.safety.stopHeartbeat("INCIDENT_CONTROLLER", "account state unknown");
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: false, reasons: ["STOPPED_INCIDENT_CONTROLLER"] });
    expect(c.safety.gate({ kind: "TRANSMISSION" }).reasons).toEqual(["STOPPED_INCIDENT_CONTROLLER"]);
    c.safety.releaseHeartbeatStop("INCIDENT_CONTROLLER", "operator-1");
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
  });

  it("repeated invalid heartbeat ids page LIVE_FENCING_CONFLICT and stop the heartbeat (ADR-008 §4)", async () => {
    const c = composition();
    await ready(c);
    c.safety.onHeartbeatEvent({ kind: "LIVE_FENCING_CONFLICT", invalidIdResponses: 2, windowMs: 60_000, atMs: c.clock.now });
    expect(c.alerts.pages.map((page) => page.page)).toEqual(["LIVE_FENCING_CONFLICT"]);
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: false, reasons: ["STOPPED_LIVE_FENCING_CONFLICT"] });
  });
});

describe("kill switches reach the heartbeat only through the health lease (ADR-033 D1 item 3)", () => {
  it("a MARKET or STRATEGY_INSTANCE switch never stops the heartbeat; a GLOBAL FULL_HALT does at the next read", async () => {
    const c = composition();
    await ready(c);
    c.reader.rows = [
      engageRow({ id: "m", scope: "MARKET", scopeRef: "0190a3e0-0000-7000-8000-00000000000c", action: "FULL_HALT" }),
      engageRow({ id: "i", scope: "STRATEGY_INSTANCE", scopeRef: "0190a3e0-0000-7000-8000-00000000000a", action: "CANCEL_ALL" }),
    ];
    await c.clock.advance(1_000);
    c.proveComposition();
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    c.reader.rows.push(engageRow({ id: "g", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }));
    await c.clock.advance(1_000);
    c.proveComposition();
    const verdict = c.safety.heartbeatGate.evaluate();
    expect(verdict.permitted === false ? verdict.reasons : []).toEqual(["HEALTH_KILL_SWITCH_ENGAGED_STOPS_HEARTBEAT"]);
  });

  it("a failed kill-switch read fails the gate and pages once", async () => {
    const c = composition();
    await ready(c);
    c.reader.failing = true;
    await c.clock.advance(3_000);
    c.proveComposition();
    const verdict = c.safety.heartbeatGate.evaluate();
    expect(verdict.permitted === false ? verdict.reasons : []).toContain("HEALTH_KILL_SWITCH_READ_FAILED");
    expect(c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_STATE_UNREADABLE")).toHaveLength(1);
    expect(c.safety.gate({ kind: "TRANSMISSION" }).permitted).toBe(false);
  });

  it("each cancel an engaged switch asks for is requested once, and retried until the port accepts it", async () => {
    const c = composition();
    await ready(c);
    c.cancels.answer = false;
    c.reader.rows = [engageRow({ id: "g", scope: "GLOBAL", scopeRef: null, action: "CANCEL_ALL" })];
    await c.clock.advance(1_000);
    await c.clock.advance(1_000);
    expect(c.cancels.calls).toEqual(['{"scope":"ACCOUNT"}', '{"scope":"ACCOUNT"}']);
    c.cancels.answer = true;
    await c.clock.advance(1_000);
    await c.clock.advance(1_000);
    expect(c.cancels.calls).toHaveLength(3);
  });
});

describe("WP-290's halt port is routed into the gate (WP290-RESIDUALS: route the halt port)", () => {
  it("an account halt and a market halt block new entries until an operator releases them", async () => {
    const c = composition();
    await ready(c);
    c.safety.halts.haltMarket({ marketId: "m-1" });
    c.safety.halts.haltAccount({});
    const reasons = c.safety.gate({ kind: "NEW_ENTRY", marketId: "m-1", instanceId: "i-1" }).reasons;
    expect(reasons).toContain("RECONCILIATION_ACCOUNT_HALT");
    expect(reasons).toContain("RECONCILIATION_MARKET_HALT");
    c.safety.releaseReconciliationHalts();
    const after = c.safety.gate({ kind: "NEW_ENTRY", marketId: "m-1", instanceId: "i-1" }).reasons;
    expect(after).not.toContain("RECONCILIATION_ACCOUNT_HALT");
  });
});
