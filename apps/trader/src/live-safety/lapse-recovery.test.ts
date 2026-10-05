/**
 * ADR-033 D6, the composition's half, over fakes: the block starts latched;
 * a lapse requests reconciliation of every open order with a venue id and
 * pages when the health lease failed with orders open; a lapse end triggers
 * at once and 5 s later, and lifts only after a passing, resuming run of a
 * call made ≥ 5 s after the confirmation, and only while the heartbeat is not
 * lapsed again. The same steps run against the REAL OMS and coordinator in
 * `test/fault-injection/live-safety/heartbeat-lapse-recovery.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { FakeCoordinator, FakeOms, ManualClock, RecordingAlerts, RecordingJournal } from "./fakes.test-support.js";
import { LapseRecovery, LapseRecoveryConfigurationError, VENUE_CANCELLATION_CHECK_INTERVAL_MS } from "./lapse-recovery.js";

function setup(): {
  clock: ManualClock;
  oms: FakeOms;
  coordinator: FakeCoordinator;
  journal: RecordingJournal;
  alerts: RecordingAlerts;
  heartbeat: { lapsed: boolean };
  recovery: LapseRecovery;
} {
  const clock = new ManualClock();
  const oms = new FakeOms();
  const coordinator = new FakeCoordinator();
  const journal = new RecordingJournal();
  const alerts = new RecordingAlerts();
  const heartbeat = { lapsed: false };
  const recovery = new LapseRecovery({
    oms,
    coordinator,
    clock,
    timers: clock,
    journal,
    alerts,
    heartbeat: () => ({ isLapsed: () => heartbeat.lapsed }),
    notRunPollMs: 100,
    failedRunSpacingMs: 1_000,
  });
  return { clock, oms, coordinator, journal, alerts, heartbeat, recovery };
}

describe("D6: the entry block", () => {
  it("is latched from construction (the controller starts lapsed)", () => {
    expect(setup().recovery.blocksNewEntries()).toBe(true);
  });

  it("refuses spacing bounds outside 1 ms … 60 s", () => {
    expect(
      () =>
        new LapseRecovery({
          oms: new FakeOms(),
          coordinator: new FakeCoordinator(),
          clock: new ManualClock(),
          timers: new ManualClock(),
          journal: new RecordingJournal(),
          alerts: new RecordingAlerts(),
          heartbeat: () => null,
          notRunPollMs: 0,
          failedRunSpacingMs: 1_000,
        }),
    ).toThrow(LapseRecoveryConfigurationError);
  });
});

describe("D6: when a lapse starts", () => {
  it("requests reconciliation of every open order with a venue id (and only those), latches, and pages when the health lease failed with orders open", async () => {
    const s = setup();
    s.oms.views = [
      { orderId: "o-live", state: "LIVE", venueOrderId: "v1", marketId: "m" },
      { orderId: "o-partial", state: "PARTIALLY_FILLED", venueOrderId: "v2", marketId: "m" },
      { orderId: "o-sending", state: "SENDING", venueOrderId: null, marketId: "m" },
      { orderId: "o-filled", state: "FILLED", venueOrderId: "v3", marketId: "m" },
    ];
    s.recovery.onLapseStarted({ cause: "GATE_REFUSED", gateReasons: ["HEALTH_MARKET_DATA_PROOF_STALE"], atMs: s.clock.now });
    await s.clock.advance(0);
    expect(s.oms.requested).toEqual(["o-live", "o-partial"]);
    expect(s.recovery.blocksNewEntries()).toBe(true);
    expect(s.alerts.pages.map((page) => page.page)).toEqual(["HEARTBEAT_HEALTH_LEASE_FAILED_WHILE_ORDERS_MAY_EXIST"]);
  });

  it("does not page for a lapse that is not a health failure, nor when every order is terminal", async () => {
    const s = setup();
    s.recovery.onLapseStarted({ cause: "TRANSPORT_FAILED", gateReasons: [], atMs: 0 });
    s.oms.views = [{ orderId: "o", state: "CANCELED", venueOrderId: "v", marketId: "m" }];
    s.recovery.onLapseStarted({ cause: "GATE_REFUSED", gateReasons: ["HEALTH_OMS_FAULTED"], atMs: 0 });
    await s.clock.advance(0);
    expect(s.alerts.pages).toEqual([]);
  });

  it("pages when the OMS is faulted (orders may exist)", () => {
    const s = setup();
    s.oms.faulted = true;
    s.recovery.onLapseStarted({ cause: "GATE_REFUSED", gateReasons: ["STOPPED_INCIDENT_CONTROLLER"], atMs: 0 });
    expect(s.alerts.pages).toHaveLength(1);
  });
});

describe("D6: when a lapse ends", () => {
  it("triggers at the confirmation and again 5 s later, calls reconcile() only from 5 s after it, and lifts on a passing, resuming run", async () => {
    const s = setup();
    s.recovery.onLapseStarted({ cause: "STARTUP", gateReasons: [], atMs: s.clock.now });
    const confirmedAt = s.clock.now;
    s.recovery.onLapseEnded({ confirmedAtMs: confirmedAt });
    expect(s.coordinator.triggers).toEqual(["POSITION_BALANCE_DISCREPANCY"]);
    await s.clock.advance(VENUE_CANCELLATION_CHECK_INTERVAL_MS - 1);
    expect(s.coordinator.reconciles).toBe(0);
    expect(s.recovery.blocksNewEntries()).toBe(true);
    await s.clock.advance(1);
    expect(s.coordinator.triggers).toEqual(["POSITION_BALANCE_DISCREPANCY", "POSITION_BALANCE_DISCREPANCY"]);
    expect(s.coordinator.reconciles).toBe(1);
    expect(s.recovery.blocksNewEntries()).toBe(false);
    expect(s.journal.of("ENTRY_BLOCK_LIFTED")).toHaveLength(1);
  });

  it("re-requests only open orders that are not already RECONCILING", async () => {
    const s = setup();
    s.oms.views = [
      { orderId: "o-reconciling", state: "RECONCILING", venueOrderId: "v1", marketId: "m" },
      { orderId: "o-live", state: "LIVE", venueOrderId: "v2", marketId: "m" },
    ];
    s.recovery.onLapseStarted({ cause: "STARTUP", gateReasons: [], atMs: 0 });
    await s.clock.advance(0);
    s.oms.requested.length = 0;
    s.oms.views = [
      { orderId: "o-reconciling", state: "RECONCILING", venueOrderId: "v1", marketId: "m" },
      { orderId: "o-live", state: "LIVE", venueOrderId: "v2", marketId: "m" },
    ];
    s.recovery.onLapseEnded({ confirmedAtMs: s.clock.now });
    await s.clock.advance(0);
    expect(s.oms.requested).toEqual(["o-live"]);
  });

  it("a run that does not pass, or passes without resuming, never lifts; the next call waits failedRunSpacingMs", async () => {
    const s = setup();
    s.coordinator.outcome = { status: "FAILED", resumed: false };
    s.recovery.onLapseStarted({ cause: "STARTUP", gateReasons: [], atMs: 0 });
    s.recovery.onLapseEnded({ confirmedAtMs: s.clock.now });
    await s.clock.advance(VENUE_CANCELLATION_CHECK_INTERVAL_MS);
    expect(s.coordinator.reconciles).toBe(1);
    await s.clock.advance(999);
    expect(s.coordinator.reconciles).toBe(1);
    await s.clock.advance(1);
    expect(s.coordinator.reconciles).toBe(2);
    s.coordinator.outcome = { status: "PASSED", resumed: false };
    await s.clock.advance(1_000);
    expect(s.recovery.blocksNewEntries()).toBe(true);
    s.coordinator.outcome = { status: "PASSED", resumed: true };
    await s.clock.advance(1_000);
    expect(s.recovery.blocksNewEntries()).toBe(false);
  });

  it("R4-L1: while another call is in progress it does not call; it polls every notRunPollMs and calls at once when that call ends", async () => {
    const s = setup();
    s.coordinator.running = true;
    s.recovery.onLapseStarted({ cause: "STARTUP", gateReasons: [], atMs: 0 });
    s.recovery.onLapseEnded({ confirmedAtMs: s.clock.now });
    await s.clock.advance(VENUE_CANCELLATION_CHECK_INTERVAL_MS + 450);
    expect(s.coordinator.reconciles).toBe(0);
    s.coordinator.running = false;
    await s.clock.advance(100);
    expect(s.coordinator.reconciles).toBe(1);
    expect(s.recovery.blocksNewEntries()).toBe(false);
  });

  it("step 5: a passing run does not lift the block while the controller reports itself lapsed again", async () => {
    const s = setup();
    s.recovery.onLapseStarted({ cause: "STARTUP", gateReasons: [], atMs: 0 });
    s.recovery.onLapseEnded({ confirmedAtMs: s.clock.now });
    s.heartbeat.lapsed = true;
    await s.clock.advance(VENUE_CANCELLATION_CHECK_INTERVAL_MS);
    expect(s.coordinator.reconciles).toBe(1);
    expect(s.recovery.blocksNewEntries()).toBe(true);
    expect(s.journal.of("ENTRY_BLOCK_LIFTED")).toEqual([]);
  });

  it("step 5: a new lapse voids the recovery: its timer never fires a call; a second end for the same epoch starts nothing", async () => {
    const s = setup();
    s.recovery.onLapseStarted({ cause: "STARTUP", gateReasons: [], atMs: 0 });
    s.recovery.onLapseEnded({ confirmedAtMs: s.clock.now });
    s.recovery.onLapseEnded({ confirmedAtMs: s.clock.now });
    expect(s.coordinator.triggers).toHaveLength(1);
    await s.clock.advance(1_000);
    s.recovery.onLapseStarted({ cause: "TRANSPORT_FAILED", gateReasons: [], atMs: s.clock.now });
    await s.clock.advance(10_000);
    expect(s.coordinator.reconciles).toBe(0);
    expect(s.recovery.blocksNewEntries()).toBe(true);
    expect(s.recovery.epoch()).toBe(2);
  });
});
