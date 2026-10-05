/**
 * WP-320: the live-safety composition over fakes. The heartbeat gate is the
 * fence AND the seven-input health lease AND no explicit stop (ADR-033 D1);
 * kill switches reach it only through the health lease, and a MARKET or
 * STRATEGY_INSTANCE switch never stops it; PAPER, and any context above its
 * ceiling, cannot build it.
 */

import { describe, expect, it } from "vitest";

import {
  ACCOUNT,
  composition,
  engageRow,
  FakeBodyPort,
  FakeCancels,
  FakeCoordinator,
  FakeKillSwitchReader,
  FakeOms,
  HEALTH_MAX_AGE,
  LIVE_CONTEXT,
  ManualClock,
  MemoryFencingStore,
  PASSING_REPORT,
  RecordingAlerts,
  RecordingJournal,
  RELEASE_SETTLE_MS,
  REPOSITORY_DEFAULTS_LIVE_MICRO,
} from "./fakes.test-support.js";
import { LiveFencingRefusal, type RunModeContext } from "./fencing-authority.js";
import { COMPOSITION_PROVED_INPUTS, createLiveSafety, LiveSafetyConfigurationError } from "./live-safety.js";
import { OmsProgressMonitor } from "./oms-progress.js";

const MARKET = "0190a3e0-0000-7000-8000-00000000000c";
const INSTANCE = "0190a3e0-0000-7000-8000-00000000000a";
const REDUCE = { kind: "REDUCTION", marketId: MARKET, instanceId: INSTANCE } as const;

/** Acquire the fence, start the refreshers, and let the first reads and proofs land. */
async function ready(c: ReturnType<typeof composition>): Promise<void> {
  expect((await c.safety.acquireFence()).kind).toBe("ACQUIRED");
  c.safety.start();
  await c.clock.advance(500);
  c.proveComposition();
}

describe("paper mode cannot build the live-safety composition (ADR-008 §2; ADR-010)", () => {
  const contexts: readonly (readonly [string, RunModeContext])[] = [
    ...["PAPER", "BACKTEST", "SHADOW", "REPLAY"].map((runMode) => [runMode, { runMode, maximumRunMode: "LIVE", allowRealOrders: true }] as const),
    // r1 I8: the repository's defaults refuse a LIVE_MICRO context too; so does a context above its ceiling.
    ["LIVE_MICRO under the repository defaults", REPOSITORY_DEFAULTS_LIVE_MICRO],
    ["LIVE above a LIVE_MICRO ceiling", { runMode: "LIVE", maximumRunMode: "LIVE_MICRO", allowRealOrders: true }],
  ];
  for (const [name, runModeContext] of contexts) {
    it(`${name} is refused before any port is touched`, () => {
      const clock = new ManualClock();
      const store = new MemoryFencingStore(() => clock.now);
      const reader = new FakeKillSwitchReader();
      const geoblock = new FakeBodyPort({});
      expect(() =>
        createLiveSafety({
          runModeContext,
          accountRef: ACCOUNT,
          holderId: "trader-a",
          clock,
          timers: clock,
          fencing: { store, ttlMs: 30_000, renewIntervalMs: 5_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 },
          health: { maxAgeMs: HEALTH_MAX_AGE, eventLoop: { intervalMs: 500, maxLagMs: 250 } },
          killSwitch: { reader, refreshIntervalMs: 1_000, cancels: new FakeCancels(), releaseSettleMs: RELEASE_SETTLE_MS },
          eligibility: { geoblock, closedOnly: geoblock, refreshIntervalMs: 30_000, maxAgeMs: 60_000 },
          oms: new FakeOms(),
          omsProgress: new OmsProgressMonitor({ clock }),
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

  it("builds for a live context within its ceiling with real orders allowed (the fakes only)", () => {
    expect(() => composition({ runModeContext: LIVE_CONTEXT })).not.toThrow();
  });

  it("refuses refresh intervals that would let a proof age out between refreshes", () => {
    expect(() => composition({ killSwitch: { reader: new FakeKillSwitchReader(), refreshIntervalMs: 3_000, cancels: new FakeCancels(), releaseSettleMs: RELEASE_SETTLE_MS } })).toThrow(LiveSafetyConfigurationError);
  });

  it("refuses a missing release settle window and a missing OMS progress monitor", () => {
    expect(() => composition({ killSwitch: { reader: new FakeKillSwitchReader(), refreshIntervalMs: 1_000, cancels: new FakeCancels() } as never })).toThrow(LiveSafetyConfigurationError);
    expect(() => composition({ omsProgress: undefined as never })).toThrow(LiveSafetyConfigurationError);
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
      c.safety.recordReconcileReport(PASSING_REPORT, c.clock.now);
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
    expect(c.safety.gate(REDUCE).reasons).toEqual(["STOPPED_INCIDENT_CONTROLLER"]);
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
    expect(c.safety.gate(REDUCE).permitted).toBe(false);
  });

  it("each cancel an engaged switch asks for is retried until the port accepts it, then confirmed ONCE one refresh interval later (r1 I2), and never again", async () => {
    const c = composition();
    await ready(c);
    c.cancels.answer = false;
    c.reader.rows = [engageRow({ id: "g", scope: "GLOBAL", scopeRef: null, action: "CANCEL_ALL" })];
    await c.clock.advance(1_000);
    await c.clock.advance(1_000);
    expect(c.cancels.calls).toEqual(['{"scope":"ACCOUNT"}', '{"scope":"ACCOUNT"}']);
    c.cancels.answer = true;
    await c.clock.advance(1_000);
    expect(c.cancels.calls).toHaveLength(3);
    await c.clock.advance(1_000);
    expect(c.cancels.calls).toHaveLength(4);
    await c.clock.advance(5_000);
    expect(c.cancels.calls).toHaveLength(4);
    expect(c.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => [entry.pass, entry.accepted])).toEqual([
      ["FIRST", false],
      ["FIRST", false],
      ["FIRST", true],
      ["CONFIRMING", true],
    ]);
  });

  it("r1 I10: a kill-switch read that HANGS (rather than fails) fails DATABASE and pages KILL_SWITCH_STATE_UNREADABLE once, without waiting for the replacement read", async () => {
    const c = composition();
    await ready(c);
    c.reader.read = async () => new Promise<never>(() => undefined);
    await c.clock.advance(3_000);
    c.proveComposition();
    expect(c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_STATE_UNREADABLE")).toHaveLength(1);
    const verdict = c.safety.heartbeatGate.evaluate();
    expect(verdict.permitted === false ? verdict.reasons : []).toEqual(expect.arrayContaining(["HEALTH_DATABASE_KILL_SWITCH_READ_TIMED_OUT", "HEALTH_KILL_SWITCH_READ_TIMED_OUT"]));
  });
});

describe("r1 I3: the RECONCILER input is proved ONLY by a run that passed and resumed", () => {
  it("RECONCILER can no longer be proved by recordProof", () => {
    expect([...COMPOSITION_PROVED_INPUTS]).toEqual(["MARKET_DATA", "USER_DATA", "DATABASE"]);
  });

  it("a reconciler whose runs keep FAILING (or QUARANTINE) ages the input out: the heartbeat stops though every report arrives", async () => {
    const c = composition();
    await ready(c);
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    for (let second = 1; second <= 31; second += 1) {
      await c.clock.advance(1_000);
      c.safety.recordProof("MARKET_DATA", c.clock.now);
      c.safety.recordProof("USER_DATA", c.clock.now);
      const status = second % 2 === 0 ? "FAILED" : "QUARANTINED";
      c.safety.recordReconcileReport({ runs: [{ status, resumed: false }] }, c.clock.now);
    }
    const verdict = c.safety.heartbeatGate.evaluate();
    expect(verdict.permitted === false ? verdict.reasons : []).toEqual(["HEALTH_RECONCILER_PROOF_STALE"]);
    // A passing run, called now, proves it again.
    c.safety.recordReconcileReport(PASSING_REPORT, c.clock.now);
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
  });

  it("a passing run is proved at the instant BEFORE its call, not at receipt", async () => {
    const c = composition();
    await ready(c);
    const calledAt = c.clock.now;
    await c.clock.advance(HEALTH_MAX_AGE.RECONCILER);
    c.proveComposition();
    c.safety.recordReconcileReport(PASSING_REPORT, calledAt - 1);
    // The latest proof is still the fresher one (proofs never move backwards) …
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    // … and a report whose call was older than the bound proves nothing fresh.
    const d = composition();
    await ready(d);
    const oldCall = d.clock.now;
    await d.clock.advance(HEALTH_MAX_AGE.RECONCILER + 1);
    d.safety.recordProof("MARKET_DATA", d.clock.now);
    d.safety.recordProof("USER_DATA", d.clock.now);
    d.safety.recordReconcileReport(PASSING_REPORT, oldCall);
    const verdict = d.safety.heartbeatGate.evaluate();
    expect(verdict.permitted === false ? verdict.reasons : []).toEqual(["HEALTH_RECONCILER_PROOF_STALE"]);
  });

  it("a PASSED run that did not resume, NOT_RUN and an unreadable report prove nothing; the unreadable one fails the input", async () => {
    const c = composition();
    await ready(c);
    await c.clock.advance(HEALTH_MAX_AGE.RECONCILER + 1);
    c.safety.recordProof("MARKET_DATA", c.clock.now);
    c.safety.recordProof("USER_DATA", c.clock.now);
    c.safety.recordReconcileReport({ runs: [{ status: "PASSED", resumed: false }, { status: "NOT_RUN", resumed: false }] }, c.clock.now);
    expect(c.safety.heartbeatGate.evaluate()).toMatchObject({ permitted: false, reasons: ["HEALTH_RECONCILER_PROOF_STALE"] });
    c.safety.recordReconcileReport({ runs: null } as never, c.clock.now);
    expect(c.safety.heartbeatGate.evaluate()).toMatchObject({ permitted: false, reasons: ["HEALTH_RECONCILER_REPORT_UNREADABLE"] });
  });
});

describe("r1 I5: the OMS input ages while an OMS port call hangs", () => {
  it("a persistence call that never settles fails OMS after its maximum age, though `faulted` stays false; the heartbeat stops", async () => {
    const c = composition();
    await ready(c);
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    c.rawOmsStore.hang = true;
    void c.omsStore.apply([]);
    expect(c.omsProgress.pendingCount()).toBe(1);
    await c.clock.advance(HEALTH_MAX_AGE.OMS);
    c.proveComposition();
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    await c.clock.advance(1);
    c.proveComposition();
    expect(c.oms.faulted).toBe(false);
    const verdict = c.safety.heartbeatGate.evaluate();
    expect(verdict.permitted === false ? verdict.reasons : []).toEqual(["HEALTH_OMS_PROOF_STALE"]);
  });

  it("a composition that never instrumented the OMS store proves nothing (STORE_NOT_INSTRUMENTED)", async () => {
    const clock = new ManualClock();
    const c = composition({ omsProgress: new OmsProgressMonitor({ clock }) }, clock);
    await ready(c);
    const verdict = c.safety.heartbeatGate.evaluate();
    expect(verdict.permitted === false ? verdict.reasons : []).toEqual(["HEALTH_OMS_STORE_NOT_INSTRUMENTED"]);
  });

  it("calls that settle leave the input proved now; a refused store write still faults the OMS at once", async () => {
    const c = composition();
    await ready(c);
    await c.omsStore.apply([]);
    await c.clock.advance(10_000);
    c.proveComposition();
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    c.oms.faulted = true;
    expect(c.safety.heartbeatGate.evaluate()).toMatchObject({ permitted: false, reasons: ["HEALTH_OMS_FAULTED"] });
  });
});

describe("r1 I2: the composition's fenced venue judges every order with its OWN scope", () => {
  it("a MARKET FULL_HALT read after the decision refuses that market's transmissions, and nothing else; an unscoped order is never signed", async () => {
    const c = composition();
    await ready(c);
    const sent: string[] = [];
    const venue = {
      createLimitOrder: async (request: string) => `SIGNED:${request}`,
      postOrder: async (order: { readonly id: string }) => {
        sent.push(order.id);
        return `ACCEPTED:${order.id}`;
      },
      postOrders: async (orders: readonly { readonly id: string }[]) => orders.map((order) => `ACCEPTED:${order.id}`),
      cancelOrder: async () => "CANCELED",
    };
    const OTHER = "0190a3e0-0000-7000-8000-0000000000ff";
    const fenced = c.safety.fenceVenue(
      venue,
      { signRefused: (reasons) => `FAILED(${reasons.join(",")})`, placementRefused: (reasons) => `NOT_SENT(${reasons.join(",")})` },
      {
        request: () => null,
        signedOrder: () => undefined,
        order: (order) => ({ intent: "REDUCTION", marketId: order.id === "here" ? MARKET : OTHER, instanceId: INSTANCE }),
      },
    );
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    expect(await c.safety.refreshKillSwitch()).toBe(true);
    expect(await fenced.postOrder({ id: "here" })).toBe("NOT_SENT(KILL_SWITCH_MARKET_ENDS_TRADING)");
    expect(await fenced.postOrder({ id: "there" })).toBe("ACCEPTED:there");
    expect(sent).toEqual(["there"]);
    // An order with no scope is never sent.
    expect(await fenced.createLimitOrder("anything")).toBe("FAILED(PLACEMENT_UNCLASSIFIED)");
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
