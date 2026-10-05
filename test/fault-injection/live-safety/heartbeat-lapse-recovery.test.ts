/**
 * ADR-033 D6 (Consequences, "WP-320's D6 tests"): a lapsed heartbeat and its
 * recovery, with a fake port and a fake monotonic clock, against the REAL
 * `OrderManager` and `ReconciliationCoordinator` (§18.3). Also the packet's
 * "the heartbeat lapses and recovers".
 *
 * The five named tests:
 * 1. a confirmation that arrives while a read taken during the lapse is still
 *    pending: no run that started before the confirmation lifts the block;
 * 2. a venue cancel within 5 s after the confirmation: the block stays
 *    latched until a run that sees it;
 * 3. a `reconcile()` call made just before 5 s after the confirmation, whose
 *    rerun takes the second trigger and resumes the OMS; no trigger is then
 *    pending; the composition calls again, and the block lifts without the
 *    periodic timer;
 * 4. a success that arrives 10 s or more after its port call: the lapse does
 *    not end;
 * 5. a new lapse between the confirmation and the passing run: the block
 *    stays latched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";

import { liveProcess, submitOne, type LiveProcess } from "./support/live-process.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const CONFIRMED = (id: string): unknown => ({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: id } });

/** One deferred controllable answer for the next `count` read calls of `listOpenOrders`. */
function holdOpenOrders(live: LiveProcess): { release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  live.u.world.faults.listOpenOrders = (answer) => {
    if (held) return answer();
    held = true;
    return gate.then(() => answer());
  };
  return {
    release: () => {
      release();
    },
  };
}

function reconcileCalls(live: LiveProcess): { readonly atMs: number; readonly outcome: string; readonly epoch: number }[] {
  return live.journal.of("LAPSE_RECONCILE_CALLED").map((entry) => ({ atMs: entry.atMs, outcome: entry.outcome, epoch: entry.epoch }));
}

function lifted(live: LiveProcess): readonly { readonly atMs: number; readonly epoch: number }[] {
  return live.journal.of("ENTRY_BLOCK_LIFTED");
}

describe("ADR-033 D6: the controller starts lapsed, and the startup lapse recovers through a qualifying run", () => {
  it("blocks new entries from the start; lifts only after a reconcile() call made ≥ 5 s after the first confirmation passes and resumes", async () => {
    const live = await liveProcess({ startController: false });
    expect(live.entryReasons()).toContain("HEARTBEAT_LAPSED");
    expect(live.entryReasons()).toContain("HEARTBEAT_RECOVERY_PENDING");
    live.controller.start();
    expect(live.journal.of("LAPSE_STARTED")[0]).toMatchObject({ cause: "STARTUP", epoch: 1 });
    await live.time.advance(0);
    const ended = live.journal.of("LAPSE_ENDED")[0];
    expect(ended).toBeDefined();
    const confirmedAt = ended?.confirmedAtMs ?? 0;
    await live.step(4_900);
    expect(live.entryReasons()).toContain("HEARTBEAT_RECOVERY_PENDING");
    expect(reconcileCalls(live)).toEqual([]);
    await live.step(500);
    expect(reconcileCalls(live).map((call) => call.outcome)).toEqual(["PASSED_AND_RESUMED"]);
    expect((reconcileCalls(live)[0]?.atMs ?? 0) - confirmedAt).toBeGreaterThanOrEqual(5_000);
    expect(live.entryReasons()).toEqual([]);
  });
});

describe("ADR-033 D6, named test 1: a confirmation that arrives while a read taken during the lapse is still pending", () => {
  it("no run that started before the confirmation lifts the entry block, even one that passes and resumes the OMS", async () => {
    const live = await liveProcess({ startController: false });
    const attempt = await submitOne(live.oms);
    expect(attempt).not.toBeNull();
    // The first heartbeat's answer is held: the process is lapsed (startup) with one LIVE order.
    live.transport.script.push({ defer: true });
    live.controller.start();
    await live.step(1_000);
    expect(live.journal.of("LAPSE_RECONCILIATION_REQUESTED").map((entry) => entry.accepted)).toEqual([true]);
    // A periodic reconcile() starts during the lapse; its open-orders read is held.
    const held = holdOpenOrders(live);
    const early = live.p.coordinator.reconcile();
    await live.step(500);
    expect(live.p.coordinator.status().running).toBe(true);
    // The confirmation arrives while that read is pending.
    live.transport.resolveDeferred(CONFIRMED("id-1"));
    await live.time.advance(0);
    const confirmedAt = live.journal.of("LAPSE_ENDED")[0]?.confirmedAtMs ?? Number.NaN;
    expect(confirmedAt).toBe(live.time.now);
    await live.step(500);
    held.release();
    const earlyReport = await early;
    // The early call passed and resumed the OMS (a rerun took the confirmation's trigger) ...
    expect(earlyReport.resumed).toBe(true);
    expect(live.oms.paused).toBe(false);
    // ... and still lifts nothing: it was made before the confirmation.
    expect(lifted(live)).toEqual([]);
    expect(live.entryReasons()).toContain("HEARTBEAT_RECOVERY_PENDING");
    await live.step(confirmedAt + 5_000 - live.time.now - 1);
    expect(lifted(live)).toEqual([]);
    await live.step(500);
    expect(lifted(live)).toHaveLength(1);
    for (const call of reconcileCalls(live)) expect(call.atMs - confirmedAt).toBeGreaterThanOrEqual(5_000);
    expect(live.entryReasons()).toEqual([]);
  });
});

describe("ADR-033 D6, named test 2: a venue cancel within 5 s after the confirmation", () => {
  it("the block stays latched until a run that sees the cancel", async () => {
    const live = await liveProcess({ startController: false });
    const attempt = await submitOne(live.oms);
    if (attempt === null) throw new Error("not submitted");
    const orderId = live.oms.attempt(attempt)?.orderId ?? "";
    live.transport.script.push({ defer: true });
    live.controller.start();
    await live.step(1_000);
    live.transport.resolveDeferred(CONFIRMED("id-1"));
    await live.time.advance(0);
    const confirmedAt = live.journal.of("LAPSE_ENDED")[0]?.confirmedAtMs ?? Number.NaN;
    // 3 s after the confirmation, the venue's sweep cancels the order (the timeout fell during the lapse).
    await live.step(3_000);
    const venueOrder = [...live.u.world.orders.values()].find((order) => !order.foreign);
    if (venueOrder === undefined) throw new Error("no venue order");
    venueOrder.status = "CANCELED";
    let stateAtLift: string | null = null;
    const record = live.journal.record.bind(live.journal);
    live.journal.record = (entry) => {
      if (entry.kind === "ENTRY_BLOCK_LIFTED") stateAtLift = live.oms.order(orderId)?.state ?? null;
      record(entry);
    };
    await live.step(confirmedAt + 5_000 - live.time.now - 1);
    expect(live.entryReasons()).toContain("HEARTBEAT_RECOVERY_PENDING");
    expect(live.oms.order(orderId)?.state).not.toBe("CANCELED");
    await live.step(1_000);
    expect(lifted(live)).toHaveLength(1);
    // The run that lifted the block had seen the cancel.
    expect(stateAtLift).toBe("CANCELED");
  });
});

describe("ADR-033 D6, named test 3: a reconcile() call made just before 5 s after the confirmation", () => {
  it("its rerun takes the second trigger and resumes; no trigger is then pending; the composition calls again and lifts without the periodic timer", async () => {
    const live = await liveProcess({ startController: false });
    live.controller.start();
    await live.time.advance(0);
    const confirmedAt = live.journal.of("LAPSE_ENDED")[0]?.confirmedAtMs ?? Number.NaN;
    await live.step(4_900);
    // Just before confirmation + 5 s, another caller's reconcile() starts; its reads are held across the 5 s mark.
    const held = holdOpenOrders(live);
    const external = live.p.coordinator.reconcile();
    await live.time.advance(confirmedAt + 5_000 - live.time.now);
    // The composition raised the second trigger; a call now would run nothing (a run is in progress), so it waits
    // for the call in progress to end (R4-L1), polling `status().running`.
    expect(live.journal.of("LAPSE_TRIGGER_RAISED")).toHaveLength(2);
    expect(live.p.coordinator.status().running).toBe(true);
    expect(reconcileCalls(live)).toEqual([]);
    await live.time.advance(50);
    held.release();
    const report = await external;
    // The external call's rerun took the second trigger and resumed the OMS; no trigger is pending now.
    expect(report.runs.length).toBeGreaterThanOrEqual(2);
    expect(report.runs.at(-1)?.triggers).toContain("POSITION_BALANCE_DISCREPANCY");
    expect(report.resumed).toBe(true);
    expect(live.p.coordinator.status().pendingTriggers).toEqual([]);
    expect(lifted(live)).toEqual([]);
    // No periodic timer: the composition's own poll sees the call end and calls again at once.
    await live.time.advance(200);
    const calls = reconcileCalls(live);
    expect(calls.map((call) => call.outcome)).toEqual(["PASSED_AND_RESUMED"]);
    expect((calls[0]?.atMs ?? 0) - confirmedAt).toBeGreaterThanOrEqual(5_000);
    expect(lifted(live)).toHaveLength(1);
    expect(live.entryReasons()).toEqual([]);
  });
});

describe("ADR-033 D6, named test 4: a success that arrives 10 s or more after its port call", () => {
  it("does not end the lapse: no LAPSE_ENDED, no recovery, the block stays latched", async () => {
    const live = await liveProcess({ startController: false, responseTimeoutMs: 60_000 });
    live.transport.fallback = () => ({ defer: true });
    live.controller.start();
    await live.step(10_000);
    live.transport.resolveDeferred(CONFIRMED("late-id"));
    await live.step(5_000);
    expect(live.log.of("HEARTBEAT_UNCONFIRMED").map((event) => event.reason)).toContain("LATE_CONFIRMATION");
    expect(live.journal.of("LAPSE_ENDED")).toEqual([]);
    expect(reconcileCalls(live)).toEqual([]);
    expect(live.entryReasons()).toContain("HEARTBEAT_RECOVERY_PENDING");
  });
});

describe("ADR-033 D6, named test 5: a new lapse between the confirmation and the passing run", () => {
  it("voids the recovery: the block stays latched, even when a run then passes", async () => {
    const live = await liveProcess({ startController: false, responseTimeoutMs: 60_000 });
    live.transport.script.push({ defer: true });
    live.transport.fallback = () => ({ defer: true });
    live.controller.start();
    const sentAt = live.time.now;
    await live.step(9_900);
    // Confirmed 9.9 s after its send: the lapse ends; the next heartbeat goes unanswered.
    live.transport.resolveDeferred(CONFIRMED("id-1"));
    await live.time.advance(0);
    expect(live.journal.of("LAPSE_ENDED")).toHaveLength(1);
    // 10 s after the confirmed send: a new lapse, before the composition's 5 s wait is over.
    await live.step(sentAt + 10_000 - live.time.now);
    expect(live.journal.of("LAPSE_STARTED").map((entry) => entry.epoch)).toEqual([1, 2]);
    await live.step(10_000);
    // A run that passes (another caller's) lifts nothing; the voided recovery made no call.
    const report = await live.p.coordinator.reconcile();
    expect(report.resumed).toBe(true);
    await live.step(1_000);
    expect(reconcileCalls(live)).toEqual([]);
    expect(lifted(live)).toEqual([]);
    expect(live.entryReasons()).toContain("HEARTBEAT_RECOVERY_PENDING");
  });
});

describe("the packet's fault: the heartbeat lapses and recovers", () => {
  it("a running heartbeat that stops being confirmed lapses 10 s after its last confirmed send; open orders are reconciled; its recovery lifts the block", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    expect(live.entryReasons()).toEqual([]);
    const attempt = await submitOne(live.oms);
    expect(attempt).not.toBeNull();
    // The transport starts failing.
    live.transport.fallback = () => ({ answer: { kind: "FAILURE", error: { kind: "TRANSPORT_FAILURE", effect: "UNKNOWN", retryAfterSeconds: null } } });
    const lastConfirmed = live.controller.status().lastConfirmedSendAtMs ?? 0;
    await live.step(lastConfirmed + 10_000 - live.time.now - 1);
    expect(live.journal.of("LAPSE_STARTED")).toHaveLength(1);
    await live.step(1);
    const lapse = live.journal.of("LAPSE_STARTED")[1];
    expect(lapse).toMatchObject({ cause: "TRANSPORT_FAILED", atMs: lastConfirmed + 10_000, epoch: 2 });
    expect(live.entryReasons()).toContain("HEARTBEAT_LAPSED");
    expect(live.journal.of("LAPSE_RECONCILIATION_REQUESTED").map((entry) => entry.accepted)).toEqual([true]);
    expect(live.oms.paused).toBe(true);
    // The transport recovers.
    live.transport.fallback = (_request, index) => ({ answer: { kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: `id-${String(index)}` } } });
    await live.step(5_000);
    expect(live.journal.of("LAPSE_ENDED")).toHaveLength(2);
    expect(live.entryReasons()).toContain("HEARTBEAT_RECOVERY_PENDING");
    await live.step(6_000);
    expect(lifted(live).map((entry) => entry.epoch)).toEqual([1, 2]);
    expect(live.entryReasons()).toEqual([]);
    expect(live.oms.paused).toBe(false);
  });
});
