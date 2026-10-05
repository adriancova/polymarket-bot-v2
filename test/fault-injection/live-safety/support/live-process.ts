/**
 * The live-safety fault suite's process (WP-320): the REAL order-heartbeat
 * controller (`packages/polymarket-secure/src/heartbeat`), the REAL
 * live-safety composition (`apps/trader/src/live-safety`), and — for ADR-033
 * D6 — the REAL `OrderManager` and `ReconciliationCoordinator` over WP-290's
 * simulated venue (`test/fault-injection/reconciliation/support`). §18.3:
 * "Do not mock away the central behavior being tested".
 *
 * The fakes: the heartbeat transport, the fencing lease store (the database's
 * rules, in memory; the real PostgreSQL race is
 * `test/integration/postgres/fencing-race.test.ts`), the kill-switch reader,
 * the geoblock and closed-only ports, the cancel port. ONE manual time line
 * drives every clock: the controller's and the composition's monotonic clock,
 * the budget's epoch clock, and the coordinator's and the simulated venue's
 * clock (`Universe.clock.t` reads it). Nothing reaches a network, a database,
 * a key or a venue. PAPER only.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCOUNT as LIVE_ACCOUNT,
  FakeBodyPort,
  FakeCancels,
  FakeKillSwitchReader,
  HEALTH_MAX_AGE,
  MemoryFencingStore,
  NOT_BLOCKED,
  RecordingAlerts,
  RecordingJournal,
} from "../../../../apps/trader/src/live-safety/fakes.test-support.js";
import { createLiveSafety, type LiveSafety, type LiveSafetyOptions } from "../../../../apps/trader/src/live-safety/index.js";
import type { OrderManager } from "../../../../packages/oms/src/index.js";
import {
  budgetFrom,
  CONTRACT_SNAPSHOT_PATH,
  EventLog,
  FakeHeartbeatTransport,
  LIVE_SHAPED_CONTEXT,
  ManualTime,
} from "../../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import { createOrderHeartbeatController, type HeartbeatEvent, type OrderHeartbeatController } from "../../../../packages/polymarket-secure/src/heartbeat/index.js";
import { boot, universe, type Process, type Universe } from "../../reconciliation/support/harness.js";
import { G_YES, submitOne } from "../../reconciliation/support/scenario.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const SNAPSHOT: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, CONTRACT_SNAPSHOT_PATH), "utf8"));

export { G_YES, submitOne };

/** Every live-safety and heartbeat event of one process, in order. */
export interface LiveProcess {
  readonly time: ManualTime;
  readonly u: Universe;
  readonly p: Process;
  readonly oms: OrderManager;
  readonly store: MemoryFencingStore;
  readonly transport: FakeHeartbeatTransport;
  readonly reader: FakeKillSwitchReader;
  readonly geoblock: FakeBodyPort;
  readonly closedOnly: FakeBodyPort;
  readonly cancels: FakeCancels;
  readonly journal: RecordingJournal;
  readonly alerts: RecordingAlerts;
  readonly log: EventLog;
  readonly safety: LiveSafety;
  readonly controller: OrderHeartbeatController;
  /** The composition's own evidence (market data, user stream, the periodic reconcile), on or off. */
  healthy: boolean;
  /**
   * Advance time by `ms` in 250 ms steps; while `healthy`, the composition proves MARKET_DATA, USER_DATA and
   * RECONCILER at every step (its feeds are fresh, its periodic reconcile is running).
   */
  step(ms: number): Promise<void>;
  /** The live gate's answer for a new entry in the suite's market. */
  entryReasons(): readonly string[];
}

export interface LiveProcessOptions {
  readonly store?: MemoryFencingStore;
  readonly safety?: Partial<LiveSafetyOptions>;
  readonly responseTimeoutMs?: number;
  /** Start the controller (default) or leave it for the test. */
  readonly startController?: boolean;
  readonly time?: ManualTime;
  /** Acquire the fence at start (default), or leave the process without it (a second writer). */
  readonly acquire?: boolean;
  readonly holderId?: string;
}

/**
 * A live process, past its STARTUP reconciliation, holding the fence, its refreshers and its heartbeat started
 * (the controller starts lapsed: D6's startup lapse has run).
 */
export async function liveProcess(options: LiveProcessOptions = {}): Promise<LiveProcess> {
  const time = options.time ?? new ManualTime();
  const u = universe();
  // The coordinator and the simulated venue read `u.clock.t`: tie it to the one time line.
  Object.defineProperty(u.clock, "t", {
    get: () => time.epochMs(),
    set: () => {
      throw new Error("the live-safety suite drives time through ManualTime");
    },
    configurable: true,
  });
  const p = await boot(u);
  const startup = await p.coordinator.reconcile();
  if (!startup.resumed) throw new Error("the STARTUP run did not resume");
  const oms = p.oms;
  if (oms === null) throw new Error("no OMS");
  if (!(await oms.registerGroup(G_YES)).ok) throw new Error("group refused");

  const store = options.store ?? new MemoryFencingStore(() => time.now);
  const reader = new FakeKillSwitchReader();
  const geoblock = new FakeBodyPort(NOT_BLOCKED);
  const closedOnly = new FakeBodyPort({ closed_only: false });
  const cancels = new FakeCancels();
  const journal = new RecordingJournal();
  const alerts = new RecordingAlerts();
  const log = new EventLog();
  const safety = createLiveSafety({
    runMode: "LIVE_MICRO",
    accountRef: LIVE_ACCOUNT,
    holderId: options.holderId ?? "trader-a",
    clock: time,
    timers: time,
    fencing: { store, ttlMs: 30_000, renewIntervalMs: 5_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 },
    health: { maxAgeMs: HEALTH_MAX_AGE, eventLoop: { intervalMs: 500, maxLagMs: 250 } },
    killSwitch: { reader, refreshIntervalMs: 1_000, cancels },
    eligibility: { geoblock, closedOnly, refreshIntervalMs: 30_000, maxAgeMs: 60_000 },
    oms,
    coordinator: p.coordinator,
    recovery: { notRunPollMs: 100, failedRunSpacingMs: 1_000 },
    journal,
    alerts,
    ...options.safety,
  });
  safety.recordReconcileReport(startup);
  let inheritedHeartbeatId: string | null = null;
  if (options.acquire !== false) {
    const acquired = await safety.acquireFence();
    if (acquired.kind !== "ACQUIRED") throw new Error(`fence not acquired: ${acquired.kind}`);
    inheritedHeartbeatId = acquired.inheritedHeartbeatId;
  }
  const transport = new FakeHeartbeatTransport(time);
  const controller = createOrderHeartbeatController({
    runModeContext: LIVE_SHAPED_CONTEXT,
    transport,
    gate: safety.heartbeatGate,
    budget: budgetFrom(SNAPSHOT),
    clock: time,
    timers: time,
    heartbeatIds: safety.heartbeatIdSink,
    initialHeartbeatId: inheritedHeartbeatId ?? "",
    ...(options.responseTimeoutMs === undefined ? {} : { responseTimeoutMs: options.responseTimeoutMs }),
    onEvent: (event: HeartbeatEvent) => {
      log.listener(event);
      safety.onHeartbeatEvent(event);
    },
  });
  safety.attachHeartbeat(controller);
  safety.start();

  const live: LiveProcess = {
    time,
    u,
    p,
    oms,
    store,
    transport,
    reader,
    geoblock,
    closedOnly,
    cancels,
    journal,
    alerts,
    log,
    safety,
    controller,
    healthy: true,
    async step(ms: number): Promise<void> {
      let left = ms;
      const prove = (): void => {
        if (!live.healthy) return;
        safety.recordProof("MARKET_DATA", time.now);
        safety.recordProof("USER_DATA", time.now);
        safety.recordProof("RECONCILER", time.now);
      };
      prove();
      while (left > 0) {
        const chunk = Math.min(250, left);
        await time.advance(chunk);
        left -= chunk;
        prove();
      }
    },
    entryReasons: () => safety.gate({ kind: "NEW_ENTRY", marketId: "0190a3e0-0000-7000-8000-00000000000c", instanceId: "0190a3e0-0000-7000-8000-00000000000a" }).reasons,
  };
  // Let the first kill-switch read, eligibility check and event-loop proof land, then start the heartbeat.
  await live.step(500);
  if (options.startController !== false) controller.start();
  return live;
}
