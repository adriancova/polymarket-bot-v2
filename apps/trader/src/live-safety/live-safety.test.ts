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
  type Composition,
  engageRow,
  FakeBodyPort,
  FakeCancels,
  FakeCoordinator,
  FakeKillSwitchReader,
  FakeOms,
  FakeReleaseFinality,
  HangableCipher,
  HangableOmsStore,
  HangableReservations,
  HEALTH_MAX_AGE,
  LIVE_CONTEXT,
  ManualClock,
  MemoryFencingStore,
  PASSING_REPORT,
  RecordingAlerts,
  RecordingJournal,
  RELEASE_SETTLE_MS,
  releaseRow,
  REPOSITORY_DEFAULTS_LIVE_MICRO,
} from "./fakes.test-support.js";
import type { PlacementVenuePort } from "./fenced-venue.js";
import { LiveFencingRefusal, type RunModeContext } from "./fencing-authority.js";
import { COMPOSITION_PROVED_INPUTS, createLiveSafety, LiveSafetyConfigurationError, type LiveSafetyOptions } from "./live-safety.js";
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
          killSwitch: { reader, refreshIntervalMs: 1_000, cancels: new FakeCancels(), releaseSettleMs: RELEASE_SETTLE_MS, releaseFinality: new FakeReleaseFinality() },
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
    expect(() => composition({ killSwitch: { reader: new FakeKillSwitchReader(), refreshIntervalMs: 3_000, cancels: new FakeCancels(), releaseSettleMs: RELEASE_SETTLE_MS, releaseFinality: new FakeReleaseFinality() } })).toThrow(LiveSafetyConfigurationError);
  });

  it("refuses a missing release settle window and a missing OMS progress monitor", () => {
    expect(() => composition({ killSwitch: { reader: new FakeKillSwitchReader(), refreshIntervalMs: 1_000, cancels: new FakeCancels() } as never })).toThrow(LiveSafetyConfigurationError);
    expect(() => composition({ omsProgress: undefined as never })).toThrow(LiveSafetyConfigurationError);
  });

  it("r2 X2: refuses a missing (or unusable) release finality port: without positive evidence no release could ever be judged", () => {
    for (const releaseFinality of [undefined, null, {}, { isFinal: true }]) {
      expect(() =>
        composition({ killSwitch: { reader: new FakeKillSwitchReader(), refreshIntervalMs: 1_000, cancels: new FakeCancels(), releaseSettleMs: RELEASE_SETTLE_MS, releaseFinality: releaseFinality as never } }),
      ).toThrow(LiveSafetyConfigurationError);
    }
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

  /**
   * r2, X4 (HIGH). At round 1 only the store had to be wrapped: an OMS stuck on its reservation port (WP-300's journal
   * append that never acknowledges) had nothing tracked pending, so the input read healthy and the heartbeat ran on
   * (reproduced with the real OMS). Every asynchronous persistence port must now be instrumented, or nothing is proved.
   */
  it("r2 X4: coverage is evidence: a monitor with only the store wrapped proves nothing (RESERVATIONS_NOT_INSTRUMENTED), nor with the cipher missing (CIPHER_NOT_INSTRUMENTED); all three wrapped through dependencies() proves", async () => {
    const clock = new ManualClock();
    const onlyStore = new OmsProgressMonitor({ clock });
    onlyStore.store(new HangableOmsStore());
    const c = composition({ omsProgress: onlyStore }, clock);
    await ready(c);
    // On 21aee56 the store alone sufficed: this gate was permitted.
    expect(c.safety.heartbeatGate.evaluate()).toMatchObject({ permitted: false, reasons: ["HEALTH_OMS_RESERVATIONS_NOT_INSTRUMENTED"] });
    onlyStore.reservations(new HangableReservations());
    expect(c.safety.heartbeatGate.evaluate()).toMatchObject({ permitted: false, reasons: ["HEALTH_OMS_CIPHER_NOT_INSTRUMENTED"] });
    onlyStore.cipher(new HangableCipher());
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    expect(onlyStore.instrumented()).toEqual(["store", "reservations", "cipher"]);

    const whole = new OmsProgressMonitor({ clock });
    const other = { newId: () => "id-1" };
    const deps = whole.dependencies({ store: new HangableOmsStore(), reservations: new HangableReservations(), cipher: new HangableCipher(), ...other });
    expect(whole.reading(clock.now)).toEqual({ healthy: true, provenAtMs: clock.now });
    expect(deps.newId).toBe(other.newId);
    expect(Object.keys(deps).sort()).toEqual(["cipher", "newId", "reservations", "store"]);
  });

  for (const port of ["reservations", "cipher"] as const) {
    it(`r2 X4: a ${port} call that never settles fails OMS after its maximum age, with no store call pending and \`faulted\` false; the heartbeat stops`, async () => {
      const c = composition();
      await ready(c);
      expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
      if (port === "reservations") {
        c.rawReservations.hang = true;
        void c.omsReservations.reserve({});
      } else {
        c.rawCipher.hang = true;
        void c.omsCipher.encrypt("signed-order-payload");
      }
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
  }

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

/**
 * r2, X3 (HIGH). At round 1 a switch's cancel ended after the confirming sweep: a placement already handed to the
 * venue when a MARKET FULL_HALT was observed, landing after both sweeps, rested indefinitely while the account's
 * heartbeat kept it alive (reproduced with the real OMS). The cancel is now an obligation held while a placement in
 * its scope is pending, renewed after one settles, and held while the OMS shows an order in the scope resting.
 */
describe("r2 X3: a kill switch's cancel is an obligation held until its scope is quiescent", () => {
  const OTHER_MARKET = "0190a3e0-0000-7000-8000-0000000000ff";
  const OTHER_INSTANCE = "0190a3e0-0000-7000-8000-0000000000fe";

  /** A fenced venue whose placements are held in flight until the test lands them. */
  interface HeldOrder {
    readonly id: string;
    readonly marketId: string;
    readonly instanceId: string;
  }

  function heldVenue(c: ReturnType<typeof composition>): { fenced: PlacementVenuePort<string, string, HeldOrder, string, string>; land(id: string): void } {
    const pending = new Map<string, () => void>();
    const venue: PlacementVenuePort<string, string, HeldOrder, string, string> = {
      createLimitOrder: async (request: string) => `SIGNED:${request}`,
      postOrder: async (order: HeldOrder) => {
        await new Promise<void>((resolve) => {
          pending.set(order.id, resolve);
        });
        return `ACCEPTED:${order.id}`;
      },
      postOrders: async (orders: readonly HeldOrder[]) => orders.map((order) => `ACCEPTED:${order.id}`),
      cancelOrder: async () => "CANCELED",
    };
    const fenced = c.safety.fenceVenue(
      venue,
      { signRefused: (reasons) => `FAILED(${reasons.join(",")})`, placementRefused: (reasons) => `NOT_SENT(${reasons.join(",")})` },
      { request: () => null, signedOrder: () => undefined, order: (order) => ({ intent: "REDUCTION", marketId: order.marketId, instanceId: order.instanceId }) },
    );
    return {
      fenced,
      land: (id: string): void => {
        const resolve = pending.get(id);
        if (resolve === undefined) throw new Error(`${id} is not in flight`);
        pending.delete(id);
        resolve();
      },
    };
  }

  function passes(c: ReturnType<typeof composition>): string[] {
    return c.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => entry.pass);
  }

  it("a placement in flight when a MARKET FULL_HALT is observed, landing after the first and confirming cancels: the obligation is RETAINED while it is pending, and the market is cancelled AFTER it settles; then nothing more", async () => {
    const c = composition();
    await ready(c);
    const { fenced, land } = heldVenue(c);
    const placement = fenced.postOrder({ id: "in-flight", marketId: MARKET, instanceId: INSTANCE });
    await c.clock.advance(0);
    expect(c.safety.pendingPlacements()).toBe(1);
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(4_000);
    // FIRST, CONFIRMING, then RETAINED once per refresh interval while the placement is pending.
    expect(passes(c)).toEqual(["FIRST", "CONFIRMING", "RETAINED", "RETAINED"]);
    land("in-flight");
    expect(await placement).toBe("ACCEPTED:in-flight");
    expect(c.safety.pendingPlacements()).toBe(0);
    const before = c.cancels.calls.length;
    await c.clock.advance(1_000);
    // On 21aee56 nothing was requested after the confirming sweep: the late acceptance rested.
    expect(passes(c).at(-1)).toBe("AFTER_SETTLE");
    expect(c.cancels.calls.slice(before)).toEqual([JSON.stringify({ scope: "MARKET", marketId: MARKET })]);
    await c.clock.advance(5_000);
    expect(passes(c)).toEqual(["FIRST", "CONFIRMING", "RETAINED", "RETAINED", "AFTER_SETTLE"]);
    // The heartbeat is never stopped by a MARKET switch (ADR-033 D1 item 3).
    c.proveComposition();
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
  });

  it("a placement that settles while the confirming cancel is in flight still calls for a cancel requested after it", async () => {
    const c = composition();
    await ready(c);
    const { fenced, land } = heldVenue(c);
    const placement = fenced.postOrder({ id: "racing", marketId: MARKET, instanceId: INSTANCE });
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(1_000);
    expect(passes(c)).toEqual(["FIRST"]);
    let releaseCancel: () => void = () => undefined;
    c.cancels.cancel = async (directive) => {
      c.cancels.calls.push(JSON.stringify(directive));
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      return true;
    };
    await c.clock.advance(1_000);
    // The confirming cancel was requested; the placement settles before it is answered.
    land("racing");
    await placement;
    releaseCancel();
    await c.clock.advance(0);
    expect(passes(c)).toEqual(["FIRST", "CONFIRMING"]);
    c.cancels.cancel = async (directive) => {
      c.cancels.calls.push(JSON.stringify(directive));
      return true;
    };
    await c.clock.advance(1_000);
    expect(passes(c)).toEqual(["FIRST", "CONFIRMING", "AFTER_SETTLE"]);
  });

  it("venue evidence: after the confirming cancel, an order the OMS shows resting in the halted market keeps the obligation (RETAINED once per refresh interval) until the OMS shows it CANCELED; an order in another market does not", async () => {
    const c = composition();
    await ready(c);
    c.oms.views = [
      { orderId: "o-here", state: "LIVE", venueOrderId: "v-here", marketId: MARKET },
      { orderId: "o-there", state: "LIVE", venueOrderId: "v-there", marketId: OTHER_MARKET },
    ];
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(4_000);
    expect(passes(c)).toEqual(["FIRST", "CONFIRMING", "RETAINED", "RETAINED"]);
    for (const state of ["SUBMISSION_UNKNOWN", "CANCEL_PENDING"]) {
      c.oms.views = [{ orderId: "o-here", state, venueOrderId: "v-here", marketId: MARKET }];
      await c.clock.advance(1_000);
      expect(passes(c).at(-1)).toBe("RETAINED");
    }
    const count = passes(c).length;
    c.oms.views = [
      { orderId: "o-here", state: "CANCELED", venueOrderId: "v-here", marketId: MARKET },
      { orderId: "o-there", state: "LIVE", venueOrderId: "v-there", marketId: OTHER_MARKET },
    ];
    await c.clock.advance(5_000);
    expect(passes(c)).toHaveLength(count);
    // An unreadable OMS view is not evidence the scope is clear.
    c.oms.orders = () => {
      throw new Error("unreadable");
    };
    await c.clock.advance(1_000);
    expect(passes(c).at(-1)).toBe("RETAINED");
  });

  it("a STRATEGY_INSTANCE FULL_HALT: a pending placement of that instance holds the obligation and its settling calls for another cancel; a placement of another instance does neither", async () => {
    const c = composition();
    await ready(c);
    const { fenced, land } = heldVenue(c);
    const mine = fenced.postOrder({ id: "mine", marketId: MARKET, instanceId: INSTANCE });
    const theirs = fenced.postOrder({ id: "theirs", marketId: MARKET, instanceId: OTHER_INSTANCE });
    c.reader.rows = [engageRow({ id: "s", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" })];
    await c.clock.advance(3_000);
    expect(passes(c)).toEqual(["FIRST", "CONFIRMING", "RETAINED"]);
    land("theirs");
    await theirs;
    await c.clock.advance(1_000);
    expect(passes(c).at(-1)).toBe("RETAINED");
    land("mine");
    await mine;
    await c.clock.advance(1_000);
    expect(passes(c).at(-1)).toBe("AFTER_SETTLE");
    await c.clock.advance(3_000);
    expect(passes(c)).toEqual(["FIRST", "CONFIRMING", "RETAINED", "RETAINED", "AFTER_SETTLE"]);
  });

  it("an account-ending GLOBAL switch is held by a pending placement in ANY market; an obligation whose switch is released is dropped", async () => {
    const c = composition();
    await ready(c);
    const { fenced, land } = heldVenue(c);
    const placement = fenced.postOrder({ id: "anywhere", marketId: OTHER_MARKET, instanceId: OTHER_INSTANCE });
    c.reader.rows = [engageRow({ id: "g", scope: "GLOBAL", scopeRef: null, action: "CANCEL_ALL" })];
    await c.clock.advance(3_000);
    expect(passes(c)).toEqual(["FIRST", "CONFIRMING", "RETAINED"]);
    c.reader.rows = [];
    await c.clock.advance(1_000);
    land("anywhere");
    await placement;
    await c.clock.advance(3_000);
    expect(passes(c)).toEqual(["FIRST", "CONFIRMING", "RETAINED"]);
  });
});

/** A fenced venue whose placements are held in flight until the test lands them, or loses their answer (a throw). */
function heldVenueR3(c: ReturnType<typeof composition>): {
  fenced: PlacementVenuePort<string, string, { readonly id: string; readonly marketId: string; readonly instanceId: string }, string, string>;
  land(id: string): void;
  lose(id: string): void;
} {
  const pending = new Map<string, { readonly resolve: () => void; readonly reject: (error: Error) => void }>();
  const venue: PlacementVenuePort<string, string, { readonly id: string; readonly marketId: string; readonly instanceId: string }, string, string> = {
    createLimitOrder: async (request: string) => `SIGNED:${request}`,
    postOrder: async (order) => {
      await new Promise<void>((resolve, reject) => {
        pending.set(order.id, { resolve, reject });
      });
      return `ACCEPTED:${order.id}`;
    },
    postOrders: async (orders) => orders.map((order) => `ACCEPTED:${order.id}`),
    cancelOrder: async () => "CANCELED",
  };
  const fenced = c.safety.fenceVenue(
    venue,
    { signRefused: (reasons) => `FAILED(${reasons.join(",")})`, placementRefused: (reasons) => `NOT_SENT(${reasons.join(",")})` },
    { request: () => null, signedOrder: () => undefined, order: (order) => ({ intent: "REDUCTION", marketId: order.marketId, instanceId: order.instanceId }) },
  );
  const take = (id: string): { readonly resolve: () => void; readonly reject: (error: Error) => void } => {
    const held = pending.get(id);
    if (held === undefined) throw new Error(`${id} is not in flight`);
    pending.delete(id);
    return held;
  };
  return {
    fenced,
    land: (id: string): void => {
      take(id).resolve();
    },
    lose: (id: string): void => {
      take(id).reject(new Error("socket hang up: the answer was lost (synthetic)"));
    },
  };
}

function cancelRequests(c: ReturnType<typeof composition>): (readonly [string, string])[] {
  return c.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => [entry.pass, entry.outcome] as const);
}

/** A composition whose kill-switch options carry `extra` (its own reader, cancel port and finality, returned). */
function compositionWithKillSwitch(extra: Partial<LiveSafetyOptions["killSwitch"]>): ReturnType<typeof composition> {
  const reader = new FakeKillSwitchReader();
  const cancels = new FakeCancels();
  const releaseFinality = new FakeReleaseFinality();
  const c = composition({ killSwitch: { reader, refreshIntervalMs: 1_000, cancels, releaseSettleMs: RELEASE_SETTLE_MS, releaseFinality, ...extra } });
  return { ...c, reader, cancels, releaseFinality };
}

/**
 * r3, J1 (HIGH; Opus R3-M-1 = astra CX320-R3-02). WP-270's order view carries no strategy instance, and at round 2
 * an instance directive therefore read "nothing resting": its obligation ended after the confirming or settling
 * pass, so an instance order still resting — already resting with its cancel accepted, or a placement whose answer
 * was lost and that reconciliation later showed LIVE — rested under the instance's FULL_HALT while the heartbeat
 * kept it alive. Missing attribution is no longer "clear".
 */
describe("r3 J1: a STRATEGY_INSTANCE obligation is held while the OMS shows an order not PROVED to be another instance's", () => {
  const OTHER_INSTANCE = "0190a3e0-0000-7000-8000-0000000000fe";

  it("an instance order already resting: FIRST and CONFIRMING are accepted and it still rests: RETAINED once per refresh interval until the OMS shows it ended; the account heartbeat runs on", async () => {
    const c = composition();
    await ready(c);
    c.oms.views = [{ orderId: "o-instance", state: "LIVE", venueOrderId: "v-instance", marketId: MARKET }];
    c.reader.rows = [engageRow({ id: "s", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" })];
    await c.clock.advance(6_000);
    // On f42019a: ["FIRST", "CONFIRMING"], then nothing while the order rested.
    expect(cancelRequests(c).map(([pass]) => pass)).toEqual(["FIRST", "CONFIRMING", "RETAINED", "RETAINED", "RETAINED", "RETAINED"]);
    c.proveComposition();
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    c.oms.views = [{ orderId: "o-instance", state: "CANCELED", venueOrderId: "v-instance", marketId: MARKET }];
    await c.clock.advance(5_000);
    expect(cancelRequests(c)).toHaveLength(6);
  });

  it("UNKNOWN, then reconciled LIVE: a placement in flight at the switch whose answer is lost settles (the OMS shows it SUBMISSION_UNKNOWN, then LIVE): the obligation is RETAINED after the settling pass for as long as it rests", async () => {
    const c = composition();
    await ready(c);
    const { fenced, lose } = heldVenueR3(c);
    const placement = fenced.postOrder({ id: "lost", marketId: MARKET, instanceId: INSTANCE });
    c.oms.views = [{ orderId: "lost", state: "SENDING", venueOrderId: null, marketId: MARKET }];
    c.reader.rows = [engageRow({ id: "s", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" })];
    await c.clock.advance(3_000);
    lose("lost");
    await expect(placement).rejects.toThrow("answer was lost");
    c.oms.views = [{ orderId: "lost", state: "SUBMISSION_UNKNOWN", venueOrderId: null, marketId: MARKET }];
    await c.clock.advance(1_000);
    expect(cancelRequests(c).at(-1)?.[0]).toBe("AFTER_SETTLE");
    const atSettle = cancelRequests(c).length;
    // The venue processed it after all; reconciliation shows it LIVE.
    c.oms.views = [{ orderId: "lost", state: "LIVE", venueOrderId: "v-lost", marketId: MARKET }];
    await c.clock.advance(20_000);
    // On f42019a: nothing after AFTER_SETTLE for 20 s while it rested.
    expect(cancelRequests(c).slice(atSettle).map(([pass]) => pass)).toEqual(Array.from({ length: 20 }, () => "RETAINED"));
    c.proveComposition();
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
  });

  const THROWS = Symbol("throws");
  for (const [label, answer, holds] of [
    ["attributed to ANOTHER instance", OTHER_INSTANCE, false],
    ["attributed to this instance", INSTANCE, true],
    ["unattributed (null)", null, true],
    ["an empty answer", "", true],
    ["a non-identifier answer", 42, true],
    ["a port that throws", THROWS, true],
  ] as const) {
    it(`with an attribution port, a resting order ${label} ${holds ? "holds" : "does not hold"} the obligation`, async () => {
      const c = compositionWithKillSwitch({
        instanceAttribution: {
          instanceOf: (order) => {
            expect(order.orderId).toBe("o-1");
            if (answer === THROWS) throw new Error("attribution store unreachable (synthetic)");
            return answer;
          },
        },
      });
      await ready(c);
      c.oms.views = [{ orderId: "o-1", state: "LIVE", venueOrderId: "v-1", marketId: MARKET }];
      c.reader.rows = [engageRow({ id: "s", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" })];
      await c.clock.advance(5_000);
      expect(cancelRequests(c).map(([pass]) => pass)).toEqual(holds ? ["FIRST", "CONFIRMING", "RETAINED", "RETAINED", "RETAINED"] : ["FIRST", "CONFIRMING"]);
    });
  }

  it("refuses an unusable attribution port", () => {
    for (const instanceAttribution of [null, {}, { instanceOf: "yes" }]) {
      expect(() => compositionWithKillSwitch({ instanceAttribution: instanceAttribution as never })).toThrow(LiveSafetyConfigurationError);
    }
  });
});

/**
 * r3, J2 (HIGH; astra CX320-R3-01). At round 2 the obligation waited on its request for good: one cancel that never
 * answered stopped every later cancel of that switch, while health stayed green and a MARKET or STRATEGY_INSTANCE
 * switch kept the heartbeat running. Every request is now a numbered attempt with a deadline.
 */
describe("r3 J2: every kill-switch cancel request is a numbered attempt with a deadline", () => {
  it("a FIRST cancel that never answers is abandoned at the first read past cancelTimeoutMs, paged once, and requested again at that read; the working service then discharges it and the obligation goes on", async () => {
    const c = composition();
    await ready(c);
    c.oms.views = [{ orderId: "o-here", state: "LIVE", venueOrderId: "v-here", marketId: MARKET }];
    let calls = 0;
    c.cancels.cancel = async (directive) => {
      calls += 1;
      c.cancels.calls.push(JSON.stringify(directive));
      if (calls === 1) return new Promise<never>(() => undefined);
      return true;
    };
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(1_000);
    expect(calls).toBe(1);
    await c.clock.advance(4_000);
    // On f42019a: still one call, and nothing journalled.
    expect(cancelRequests(c)).toEqual([
      ["FIRST", "ABANDONED"],
      ["FIRST", "ACCEPTED"],
      ["CONFIRMING", "ACCEPTED"],
      ["RETAINED", "ACCEPTED"],
      ["RETAINED", "ACCEPTED"],
    ]);
    expect(c.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => entry.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_CANCEL_UNANSWERED")).toHaveLength(1);
    // A MARKET switch never stops the account's heartbeat (ADR-033 D1 item 3).
    c.proveComposition();
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
  });

  it("a cancel service that never answers is asked again at EVERY read (not once), and paged once", async () => {
    const c = composition();
    await ready(c);
    c.cancels.cancel = async (directive) => {
      c.cancels.calls.push(JSON.stringify(directive));
      return new Promise<never>(() => undefined);
    };
    c.reader.rows = [engageRow({ id: "i", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" })];
    await c.clock.advance(10_000);
    // On f42019a: 1.
    expect(c.cancels.calls).toHaveLength(10);
    expect(cancelRequests(c)).toEqual(Array.from({ length: 9 }, () => ["FIRST", "ABANDONED"]));
    expect(c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_CANCEL_UNANSWERED")).toHaveLength(1);
    c.proveComposition();
    expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
  });

  it("a late answer of an abandoned attempt discharges nothing, and does not release the newer attempt it was replaced by", async () => {
    const c = composition();
    await ready(c);
    const answers: ((value: unknown) => void)[] = [];
    c.cancels.cancel = async (directive) => {
      c.cancels.calls.push(JSON.stringify(directive));
      return new Promise<unknown>((resolve) => {
        answers.push(resolve);
      });
    };
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(2_000);
    // Attempt 1 was abandoned at the second read and attempt 2 requested; attempt 1 now answers `true`.
    expect(answers).toHaveLength(2);
    answers[0]?.(true);
    await c.clock.advance(0);
    expect(c.journal.of("KILL_SWITCH_CANCEL_LATE_ANSWER_DISCARDED")).toMatchObject([{ attempt: 1, pass: "FIRST", accepted: true }]);
    // Nothing was discharged: at the next read attempt 2 is abandoned in turn and FIRST is requested again (not CONFIRMING).
    await c.clock.advance(1_000);
    expect(answers).toHaveLength(3);
    expect(cancelRequests(c)).toEqual([
      ["FIRST", "ABANDONED"],
      ["FIRST", "ABANDONED"],
    ]);
    answers[2]?.(true);
    await c.clock.advance(1_000);
    expect(cancelRequests(c)).toEqual([
      ["FIRST", "ABANDONED"],
      ["FIRST", "ABANDONED"],
      ["FIRST", "ACCEPTED"],
    ]);
    // The confirming pass comes one refresh interval after that acceptance, as for any obligation.
    await c.clock.advance(1_000);
    expect(answers).toHaveLength(4);
    answers[3]?.(true);
    await c.clock.advance(0);
    expect(cancelRequests(c).at(-1)).toEqual(["CONFIRMING", "ACCEPTED"]);
  });

  it("one directive's silent cancel does not delay another's: the attempts of one read run side by side", async () => {
    const c = composition();
    await ready(c);
    c.cancels.cancel = async (directive) => {
      c.cancels.calls.push(JSON.stringify(directive));
      if (directive.scope === "MARKET") return new Promise<never>(() => undefined);
      return true;
    };
    c.reader.rows = [
      engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" }),
      engageRow({ id: "i", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" }),
    ];
    await c.clock.advance(1_000);
    expect(c.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => [entry.directive, entry.pass, entry.outcome])).toEqual([[`i:STRATEGY_INSTANCE:${INSTANCE}`, "FIRST", "ACCEPTED"]]);
  });

  it("refuses a cancel deadline that is not an integer of 1 ms up to the KILL_SWITCH input's maximum age", () => {
    for (const cancelTimeoutMs of [0, -1, 1.5, Number.NaN, HEALTH_MAX_AGE.KILL_SWITCH + 1, "1000"]) {
      expect(() => compositionWithKillSwitch({ cancelTimeoutMs: cancelTimeoutMs as never })).toThrow(LiveSafetyConfigurationError);
    }
    expect(() => compositionWithKillSwitch({ cancelTimeoutMs: HEALTH_MAX_AGE.KILL_SWITCH })).not.toThrow();
  });

  it("a configured deadline longer than the refresh interval: the attempt is waited on until it passes, then abandoned", async () => {
    const c = compositionWithKillSwitch({ cancelTimeoutMs: 2_500 });
    await ready(c);
    c.cancels.cancel = async (directive) => {
      c.cancels.calls.push(JSON.stringify(directive));
      return new Promise<never>(() => undefined);
    };
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(3_000);
    expect(c.cancels.calls).toHaveLength(1);
    await c.clock.advance(1_000);
    expect(c.cancels.calls).toHaveLength(2);
    expect(cancelRequests(c)).toEqual([["FIRST", "ABANDONED"]]);
  });
});

/**
 * r3, J3 (LOW; Opus R3-L2). At round 2 a PENDING release asked for no cancel, and the engage's obligation was dropped
 * at the read that first saw the release: a placement landing inside the settle window was cancelled only once the
 * release settled (to UNCONFIRMED), up to `releaseSettleMs` later, while the scope's submissions stayed blocked.
 */
describe("r3 J3: a release that is still PENDING keeps a cancel obligation", () => {
  it("a placement in flight at a MARKET FULL_HALT lands inside its (never final) release's settle window: it is cancelled at the next read, while the release is still PENDING", async () => {
    const c = composition();
    await ready(c);
    c.releaseFinality.all = false;
    const { fenced, land } = heldVenueR3(c);
    const placement = fenced.postOrder({ id: "p", marketId: MARKET, instanceId: INSTANCE });
    c.reader.rows = [engageRow({ id: "e", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(3_000);
    c.reader.rows = [releaseRow({ id: "r", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(1_000);
    const cancelledAt: number[] = [];
    const inner = c.cancels.cancel.bind(c.cancels);
    c.cancels.cancel = async (directive) => {
      cancelledAt.push(c.clock.now);
      return inner(directive);
    };
    land("p");
    expect(await placement).toBe("ACCEPTED:p");
    const landedAt = c.clock.now;
    await c.clock.advance(1_000);
    const status = c.safety.status().killSwitch;
    expect(status.known ? status.effects.engaged.map((entry) => [entry.killSwitchEventId, entry.release]) : null).toEqual([["r", "PENDING"]]);
    // On f42019a: no cancel until the release settled (UNCONFIRMED), 1.5 s after landing.
    expect(cancelledAt.filter((at) => at >= landedAt)).toHaveLength(1);
    expect((cancelledAt[0] ?? Number.POSITIVE_INFINITY) - landedAt).toBeLessThanOrEqual(1_000);
    expect(c.journal.of("KILL_SWITCH_CANCEL_REQUESTED").at(-1)).toMatchObject({ directive: `r:MARKET:${MARKET}`, pass: "AFTER_SETTLE", outcome: "ACCEPTED" });
    // Submissions in the scope stay blocked throughout.
    expect(c.safety.gate(REDUCE).reasons).toContain("KILL_SWITCH_MARKET_ENDS_TRADING");
  });
});

/**
 * r4, CX320-R4-01 (HIGH; astra, agreed by Opus). The r3 attempt deadline bounded the composition's own cancel request,
 * not the venue call beneath the OMS: WP-270's `requestCancel` persists CANCEL_PENDING, awaits the venue with no
 * deadline, and refuses to cancel a CANCEL_PENDING order again. A venue cancel that never answered stranded the order:
 * every later pass was accepted and removed nothing, while a MARKET or STRATEGY_INSTANCE switch kept the heartbeat
 * running. The fakes below model an OMS-bound cancel port exactly so: a cancellable order (LIVE, RECONCILING) goes
 * CANCEL_PENDING and its venue cancel is sent; anything else is skipped and the port answers `true`.
 */
describe("r4 CX320-R4-01: an order stranded CANCEL_PENDING beneath the OMS is released through requestOrderReconciliation", () => {
  const OTHER_MARKET = "0190a3e0-0000-7000-8000-0000000000ff";
  const OTHER_INSTANCE = "0190a3e0-0000-7000-8000-0000000000fe";

  /** An OMS-bound cancel port over the fake OMS: the first venue cancel never answers; the later ones cancel. */
  function omsBoundCancels(c: ReturnType<typeof composition>): { venueCancels(): number } {
    let venueCancels = 0;
    c.cancels.cancel = async (directive) => {
      c.cancels.calls.push(JSON.stringify(directive));
      let hang = false;
      c.oms.views = c.oms.views.map((view) => {
        const inScope = directive.scope === "ACCOUNT" || (directive.scope === "MARKET" && view.marketId === directive.marketId) || directive.scope === "STRATEGY_INSTANCE";
        if (!inScope || !["LIVE", "RECONCILING"].includes(view.state)) return view;
        venueCancels += 1;
        if (venueCancels === 1) {
          hang = true;
          return { ...view, state: "CANCEL_PENDING" };
        }
        return { ...view, state: "CANCELED" };
      });
      if (hang) return new Promise<never>(() => undefined);
      return true;
    };
    return { venueCancels: () => venueCancels };
  }

  function stranded(c: ReturnType<typeof composition>): unknown[] {
    return c.journal.of("KILL_SWITCH_STRANDED_CANCEL_RECONCILIATION_REQUESTED").map((entry) => [entry.directive, entry.orderId, entry.accepted]);
  }

  for (const scope of ["MARKET", "STRATEGY_INSTANCE"] as const) {
    it(`${scope} FULL_HALT: the venue cancel beneath the OMS never answers; the order, CANCEL_PENDING for cancelTimeoutMs, is sent to requestOrderReconciliation ONCE (journalled, paged once) and the obligation's next pass cancels it again; the heartbeat runs on`, async () => {
      const c = composition();
      await ready(c);
      const venue = omsBoundCancels(c);
      c.oms.views = [{ orderId: "o-here", state: "LIVE", venueOrderId: "v-here", marketId: MARKET }];
      c.reader.rows = [engageRow({ id: "k", scope, scopeRef: scope === "MARKET" ? MARKET : INSTANCE, action: "FULL_HALT" })];
      const readAt = c.clock.now + 500;
      await c.clock.advance(1_000);
      expect(c.oms.views.map((view) => view.state)).toEqual(["CANCEL_PENDING"]);
      await c.clock.advance(1_000);
      // First seen CANCEL_PENDING at the read after the FIRST request; released one deadline (1 s) later.
      expect(c.oms.requested).toEqual([]);
      await c.clock.advance(1_000);
      const key = `k:${scope}:${scope === "MARKET" ? MARKET : INSTANCE}`;
      // On 04be84d: never requested; the order stays CANCEL_PENDING and every RETAINED pass is ACCEPTED.
      expect(c.oms.requested).toEqual(["o-here"]);
      expect(stranded(c)).toEqual([[key, "o-here", true]]);
      expect(c.journal.of("KILL_SWITCH_STRANDED_CANCEL_RECONCILIATION_REQUESTED")[0]?.cancelPendingSinceMs).toBe(readAt + 1_000);
      expect(c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_CANCEL_STRANDED")).toHaveLength(1);
      expect(venue.venueCancels()).toBe(2);
      expect(c.oms.views.map((view) => view.state)).toEqual(["CANCELED"]);
      // The journal never reads a stranded scope as clear: ACCEPTED while the order rested says so.
      expect(c.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => [entry.pass, entry.outcome, entry.scopeStillResting])).toEqual([
        ["FIRST", "ABANDONED", true],
        ["FIRST", "ACCEPTED", true],
        ["CONFIRMING", "ACCEPTED", false],
      ]);
      // Quiescent: nothing more is asked, nothing more is reconciled.
      await c.clock.advance(5_000);
      expect(c.cancels.calls).toHaveLength(3);
      expect(c.oms.requested).toEqual(["o-here"]);
      c.proveComposition();
      expect(c.safety.heartbeatGate.evaluate()).toEqual({ permitted: true });
    });
  }

  it("a venue that never answers ANY cancel: each new CANCEL_PENDING is released one deadline after a read first sees it, for as long as the switch is engaged; paged once", async () => {
    const c = composition();
    await ready(c);
    c.oms.views = [{ orderId: "o-here", state: "LIVE", venueOrderId: "v-here", marketId: MARKET }];
    c.cancels.cancel = async (directive) => {
      c.cancels.calls.push(JSON.stringify(directive));
      const cancellable = c.oms.views.some((view) => ["LIVE", "RECONCILING"].includes(view.state));
      c.oms.views = c.oms.views.map((view) => (["LIVE", "RECONCILING"].includes(view.state) ? { ...view, state: "CANCEL_PENDING" } : view));
      return cancellable ? new Promise<never>(() => undefined) : true;
    };
    c.reader.rows = [engageRow({ id: "k", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(12_000);
    // Twelve reads: FIRST at the 1st (hangs); first seen CANCEL_PENDING at the 2nd; released at the 3rd and every second
    // read after it (each release lets that read's pass send a new cancel, which hangs and is first seen at the next).
    expect(c.oms.requested).toEqual(["o-here", "o-here", "o-here", "o-here", "o-here"]);
    expect(c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_CANCEL_STRANDED")).toHaveLength(1);
    expect(c.oms.views.map((view) => view.state)).not.toEqual(["CANCELED"]);
  });

  it("only an order that MAY be in a current obligation's scope is released: another market's is not, nor any while no switch is engaged; one stranded before the switch is released at the first read that has the obligation", async () => {
    const c = composition();
    await ready(c);
    c.oms.views = [
      { orderId: "o-here", state: "CANCEL_PENDING", venueOrderId: "v-here", marketId: MARKET },
      { orderId: "o-there", state: "CANCEL_PENDING", venueOrderId: "v-there", marketId: OTHER_MARKET },
    ];
    await c.clock.advance(5_000);
    expect(c.oms.requested).toEqual([]);
    c.reader.rows = [engageRow({ id: "k", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(1_000);
    expect(c.oms.requested).toEqual(["o-here"]);
    await c.clock.advance(5_000);
    expect(c.oms.requested).toEqual(["o-here"]);
    expect(c.oms.views.find((view) => view.orderId === "o-there")?.state).toBe("CANCEL_PENDING");
  });

  it("STRATEGY_INSTANCE: an order the attribution port affirmatively names ANOTHER instance's is not released; this instance's, and an unattributed one, are", async () => {
    const c = compositionWithKillSwitch({
      instanceAttribution: { instanceOf: (order) => (order.orderId === "theirs" ? OTHER_INSTANCE : order.orderId === "mine" ? INSTANCE : null) },
    });
    await ready(c);
    c.oms.views = ["mine", "theirs", "unknown"].map((orderId) => ({ orderId, state: "CANCEL_PENDING", venueOrderId: `v-${orderId}`, marketId: MARKET }));
    c.reader.rows = [engageRow({ id: "k", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" })];
    await c.clock.advance(3_000);
    expect([...c.oms.requested].sort()).toEqual(["mine", "unknown"]);
  });

  it("the deadline runs from the first read that saw it CANCEL_PENDING, continuously; a request not yet settled is not repeated; a refused one is asked again at the first read that has seen the order CANCEL_PENDING for a deadline since the request", async () => {
    const c = compositionWithKillSwitch({ cancelTimeoutMs: 2_500 });
    await ready(c);
    const answers: ((value: { readonly ok: boolean }) => void)[] = [];
    c.oms.requestOrderReconciliation = async (orderId) => {
      c.oms.requested.push(orderId);
      return new Promise<{ readonly ok: boolean }>((resolve) => {
        answers.push(resolve);
      });
    };
    const pendingView = { orderId: "o-here", state: "CANCEL_PENDING", venueOrderId: "v-here", marketId: MARKET };
    c.oms.views = [pendingView];
    c.reader.rows = [engageRow({ id: "k", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(2_000);
    // Seen at two reads 1 s apart; then LIVE for one read: forgotten.
    c.oms.views = [{ ...pendingView, state: "LIVE" }];
    await c.clock.advance(1_000);
    c.oms.views = [pendingView];
    await c.clock.advance(3_000);
    // Seen again at three reads (0, 1 s, 2 s): not yet one 2.5 s deadline since it was seen again.
    expect(c.oms.requested).toEqual([]);
    await c.clock.advance(1_000);
    expect(c.oms.requested).toEqual(["o-here"]);
    // Unsettled: never repeated.
    await c.clock.advance(10_000);
    expect(c.oms.requested).toEqual(["o-here"]);
    expect(c.journal.of("KILL_SWITCH_STRANDED_CANCEL_RECONCILIATION_REQUESTED")).toEqual([]);
    // Refused, the order still CANCEL_PENDING as at every read since the request (each read after it timed it afresh):
    // journalled, and asked again at the next read.
    answers[0]?.({ ok: false });
    await c.clock.advance(0);
    expect(c.journal.of("KILL_SWITCH_STRANDED_CANCEL_RECONCILIATION_REQUESTED").map((entry) => entry.accepted)).toEqual([false]);
    await c.clock.advance(1_000);
    expect(c.oms.requested).toEqual(["o-here", "o-here"]);
    // Accepted: the order goes RECONCILING, then a NEW cancel makes it CANCEL_PENDING again: its own deadline starts
    // at the first read that sees it (reads at 0, 1 s and 2 s: none; at 3 s: released).
    answers[1]?.({ ok: true });
    c.oms.views = [{ ...pendingView, state: "RECONCILING" }];
    await c.clock.advance(1_000);
    c.oms.views = [pendingView];
    await c.clock.advance(3_000);
    expect(c.oms.requested).toEqual(["o-here", "o-here"]);
    await c.clock.advance(1_000);
    expect(c.oms.requested).toEqual(["o-here", "o-here", "o-here"]);
    expect(c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_CANCEL_STRANDED")).toHaveLength(1);
  });

  it("an OMS view that cannot be read releases nothing, and the obligation's passes go on", async () => {
    const c = composition();
    await ready(c);
    c.oms.orders = () => {
      throw new Error("unreadable");
    };
    c.reader.rows = [engageRow({ id: "k", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(5_000);
    expect(c.oms.requested).toEqual([]);
    expect(cancelRequests(c).map(([pass]) => pass)).toEqual(["FIRST", "CONFIRMING", "RETAINED", "RETAINED", "RETAINED"]);
  });
});

/**
 * r4, R4-L1 (LOW; Opus, agreed by astra). Kill-switch references were matched by exact string while the control
 * plane accepts any 1–256-character reference: a switch engaged under another spelling (upper case) was reported
 * engaged and enforced on nothing here (Opus probe N4: a REDUCTION permitted in the halted market; an ACCOUNT
 * FULL_HALT that did not stop the heartbeat).
 */
describe("r4 R4-L1: a switch's reference is matched in its scope's canonical form, and a non-canonical one is paged", () => {
  it("an ACCOUNT FULL_HALT engaged as 'ACCT-1' is this account's ('acct-1'): it stops the heartbeat and blocks every order; paged once", async () => {
    const c = composition();
    await ready(c);
    c.reader.rows = [engageRow({ id: "a", scope: "ACCOUNT", scopeRef: ACCOUNT.toUpperCase(), action: "FULL_HALT" })];
    await c.clock.advance(5_000);
    c.proveComposition();
    // On 04be84d: permitted.
    expect(c.safety.heartbeatGate.evaluate().permitted).toBe(false);
    expect(c.safety.gate(REDUCE).reasons).toContain("KILL_SWITCH_ACCOUNT_ENDS_TRADING");
    const pages = c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_SCOPE_REF_NOT_CANONICAL");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.detail).toContain("ACCOUNT");
  });

  it("a MARKET FULL_HALT engaged with the market id in upper case blocks that market's reductions, and its obligation is held while the OMS shows that (lower-case) market's order resting; paged once", async () => {
    const c = composition();
    await ready(c);
    c.oms.views = [{ orderId: "o-here", state: "LIVE", venueOrderId: "v-here", marketId: MARKET }];
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET.toUpperCase(), action: "FULL_HALT" })];
    await c.clock.advance(5_000);
    // On 04be84d: the reduction is permitted, and the obligation stops after its confirming pass.
    expect(c.safety.gate(REDUCE).reasons).toContain("KILL_SWITCH_MARKET_ENDS_TRADING");
    expect(cancelRequests(c).map(([pass]) => pass)).toEqual(["FIRST", "CONFIRMING", "RETAINED", "RETAINED", "RETAINED"]);
    expect(c.cancels.calls[0]).toBe(JSON.stringify({ scope: "MARKET", marketId: MARKET }));
    expect(c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_SCOPE_REF_NOT_CANONICAL")).toHaveLength(1);
  });

  it("the other side is read alike: an OMS order, and a placement in flight, whose market id is spelt in upper case are in a canonical MARKET switch's scope", async () => {
    const c = composition();
    await ready(c);
    const { fenced, land } = heldVenueR3(c);
    const placement = fenced.postOrder({ id: "p", marketId: MARKET.toUpperCase(), instanceId: INSTANCE });
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await c.clock.advance(4_000);
    // Held by the pending placement: RETAINED while it is in flight; its settling calls for another cancel.
    expect(cancelRequests(c).map(([pass]) => pass)).toEqual(["FIRST", "CONFIRMING", "RETAINED", "RETAINED"]);
    land("p");
    expect(await placement).toBe("ACCEPTED:p");
    c.oms.views = [{ orderId: "o-upper", state: "LIVE", venueOrderId: "v-upper", marketId: MARKET.toUpperCase() }];
    await c.clock.advance(3_000);
    expect(cancelRequests(c).slice(4).map(([pass]) => pass)).toEqual(["AFTER_SETTLE", "RETAINED", "RETAINED"]);
    // ... and the OMS order stranded CANCEL_PENDING in it is released.
    c.oms.views = [{ orderId: "o-upper", state: "CANCEL_PENDING", venueOrderId: "v-upper", marketId: MARKET.toUpperCase() }];
    await c.clock.advance(2_000);
    expect(c.oms.requested).toEqual(["o-upper"]);
  });

  it("an attribution port answering this instance's id in another spelling holds the instance obligation", async () => {
    const c = compositionWithKillSwitch({ instanceAttribution: { instanceOf: () => INSTANCE.toUpperCase() } });
    await ready(c);
    c.oms.views = [{ orderId: "o-1", state: "LIVE", venueOrderId: "v-1", marketId: MARKET }];
    c.reader.rows = [engageRow({ id: "s", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" })];
    await c.clock.advance(4_000);
    expect(cancelRequests(c).map(([pass]) => pass)).toEqual(["FIRST", "CONFIRMING", "RETAINED", "RETAINED"]);
  });

  it("a canonical reference is never paged", async () => {
    const c = composition();
    await ready(c);
    c.reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" }), engageRow({ id: "a", scope: "ACCOUNT", scopeRef: "acct-2", action: "FULL_HALT" })];
    await c.clock.advance(5_000);
    expect(c.alerts.pages.filter((page) => page.page === "KILL_SWITCH_SCOPE_REF_NOT_CANONICAL")).toEqual([]);
  });
});

describe("C1-OMS06: the gate's reconciliation halts are the coordinator's QUARANTINED breaks, read at every ask", () => {
  const OTHER = "0190a3e0-0000-7000-8000-00000000000d";
  const halts = (c: Composition, kind: "NEW_ENTRY" | "REDUCTION", marketId: string): readonly string[] =>
    c.safety.gate({ kind, marketId, instanceId: INSTANCE }).reasons.filter((reason) => reason.startsWith("RECONCILIATION_") || reason === "HALTS_UNREADABLE");

  it("(5a) the journal unreadable: every new entry is refused (HALTS_UNREADABLE), and the status reads the account halted", async () => {
    const c = composition();
    await ready(c);
    c.coordinator.quarantined = null;
    expect(halts(c, "NEW_ENTRY", MARKET)).toEqual(["HALTS_UNREADABLE"]);
    expect(c.safety.status().reconciliationHalts).toEqual({ account: true, markets: [] });
  });

  it("(5b) a MARKET break blocks that market's entries only; an ACCOUNT break, or a MARKET break with no market, blocks every entry", async () => {
    const c = composition();
    await ready(c);
    expect(halts(c, "NEW_ENTRY", MARKET)).toEqual([]);
    c.coordinator.quarantined = [{ scope: "MARKET", marketId: MARKET }];
    expect(halts(c, "NEW_ENTRY", MARKET)).toEqual(["RECONCILIATION_MARKET_HALT"]);
    expect(halts(c, "NEW_ENTRY", OTHER)).toEqual([]);
    expect(c.safety.status().reconciliationHalts).toEqual({ account: false, markets: [MARKET] });
    c.coordinator.quarantined = [{ scope: "ACCOUNT", marketId: null }];
    expect(halts(c, "NEW_ENTRY", MARKET)).toEqual(["RECONCILIATION_ACCOUNT_HALT"]);
    expect(halts(c, "NEW_ENTRY", OTHER)).toEqual(["RECONCILIATION_ACCOUNT_HALT"]);
    // An ACCOUNT-scope break that names a market still halts the account, not that market.
    c.coordinator.quarantined = [{ scope: "ACCOUNT", marketId: MARKET }];
    expect(halts(c, "NEW_ENTRY", OTHER)).toEqual(["RECONCILIATION_ACCOUNT_HALT"]);
    c.coordinator.quarantined = [{ scope: "MARKET", marketId: null }];
    expect(halts(c, "NEW_ENTRY", OTHER)).toEqual(["RECONCILIATION_ACCOUNT_HALT"]);
  });

  it("(5c, unit) nothing is latched: a break gone from the journal stops blocking at the next ask, the others still block", async () => {
    const c = composition();
    await ready(c);
    c.coordinator.quarantined = [
      { scope: "MARKET", marketId: MARKET },
      { scope: "MARKET", marketId: OTHER },
    ];
    expect(halts(c, "NEW_ENTRY", MARKET)).toEqual(["RECONCILIATION_MARKET_HALT"]);
    c.coordinator.quarantined = [{ scope: "MARKET", marketId: OTHER }];
    expect(halts(c, "NEW_ENTRY", MARKET)).toEqual([]);
    expect(halts(c, "NEW_ENTRY", OTHER)).toEqual(["RECONCILIATION_MARKET_HALT"]);
  });

  it("(5e) reductions are never blocked by the reconciliation halts, nor by an unreadable journal", async () => {
    const c = composition();
    await ready(c);
    c.coordinator.quarantined = [
      { scope: "MARKET", marketId: MARKET },
      { scope: "ACCOUNT", marketId: null },
    ];
    expect(halts(c, "NEW_ENTRY", MARKET)).toEqual(["RECONCILIATION_ACCOUNT_HALT", "RECONCILIATION_MARKET_HALT"]);
    expect(halts(c, "REDUCTION", MARKET)).toEqual([]);
    expect(c.safety.gate(REDUCE).permitted).toBe(true);
    c.coordinator.quarantined = null;
    expect(halts(c, "REDUCTION", MARKET)).toEqual([]);
    expect(c.safety.gate(REDUCE).permitted).toBe(true);
  });
});
