/**
 * WP-340: a live-shaped process WITH WP-320's live safety, over the mock
 * CLOB: the composition `apps/trader/src/live-safety/live-safety.ts`
 * describes for a live root, built in the test tree (nothing is wired into
 * `main.ts`).
 *
 * REAL: everything `live-node.ts` composes, plus WP-320's `LiveSafety` (the
 * fencing authority, the seven-input health lease, kill-switch enforcement,
 * venue eligibility, the ADR-033 D6 lapse recovery, the live gate, the
 * per-order submission fence in front of the OMS's venue port) and its
 * `OmsProgressMonitor` timing the OMS's store, reservations and cipher;
 * WP-320's order-heartbeat controller (`createOrderHeartbeatController`,
 * live-shaped context, WP-310's dated budget snapshot), whose TRANSPORT is
 * the mock CLOB's documented heartbeat endpoint; and a kill-switch cancel
 * port bound through the OMS (`cancelThroughOms`, WP-320's own binding).
 *
 * DOUBLED (as in WP-320's own suite): the fencing lease store (WP-320's
 * in-memory `MemoryFencingStore`, the database's rules; the real PostgreSQL
 * store is `postgres/`'s), the kill-switch reader, the geoblock and
 * closed-only ports, the release finality, the live-safety journal and pager.
 * ONE time line drives every clock: the venue's, the process's monotonic
 * clock, the epoch clock and every timer.
 *
 * HEALTH PROOFS the composition supplies (WP-320: MARKET_DATA, USER_DATA and
 * the periodic reconcile are the composition's): USER_DATA is proved only
 * while the REAL WP-280 manager is SUBSCRIBED; MARKET_DATA while the test
 * says the market feed is healthy (no market feed is composed here); the
 * reconciler by the REAL coordinator's `reconcile()`, once a second.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FakeBodyPort,
  FakeKillSwitchReader,
  FakeReleaseFinality,
  HEALTH_MAX_AGE,
  LIVE_CONTEXT,
  MemoryFencingStore,
  NOT_BLOCKED,
  RecordingAlerts,
  RecordingJournal,
  RELEASE_SETTLE_MS,
} from "../../../../apps/trader/src/live-safety/fakes.test-support.js";
import {
  createLiveSafety,
  OmsProgressMonitor,
  type FencingLeasePort,
  type KillSwitchCancelPort,
  type LiveSafety,
  type PlacementClassifier,
} from "../../../../apps/trader/src/live-safety/index.js";
import type { LimitOrderRequest, OrderManager, PlacementOutcome, SignedOrderHandle, SignOutcome } from "../../../../packages/oms/src/index.js";
import { budgetFrom, CONTRACT_SNAPSHOT_PATH, EventLog, LIVE_SHAPED_CONTEXT } from "../../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import { createOrderHeartbeatController, type HeartbeatEvent, type OrderHeartbeatController } from "../../../../packages/polymarket-secure/src/heartbeat/index.js";
import { cancelThroughOms } from "../../live-safety/support/placing-oms.js";
import { INSTANCE_A } from "../../../unit/oms/support/harness.js";

import { bootNode, MARKET, MARKET_NO, NO, YES, type KillPlan, type LiveNode, type LiveWorld } from "./live-node.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
/** WP-310's dated contract snapshot (`rate-limits-2026-09-30`): it defines `clob.heartbeat` at `ORDER_HEARTBEAT`. */
export const RATE_LIMIT_SNAPSHOT: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, CONTRACT_SNAPSHOT_PATH), "utf8"));

/** WP-320's fake store's account (its rows are keyed by it); the kill-switch ACCOUNT scope names it too. */
export const SAFETY_ACCOUNT = "acct-1";

/** The fence's refusals, in WP-270's vocabulary: a refused signing is FAILED (no order exists), a refused transmission NOT_SENT. */
const REFUSALS = Object.freeze({
  signRefused: (reasons: readonly string[]): SignOutcome => ({ kind: "FAILED", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
  placementRefused: (reasons: readonly string[]): PlacementOutcome => ({ kind: "NOT_SENT", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
});

function marketOf(tokenId: string): string {
  return tokenId === NO ? MARKET_NO : MARKET;
}

/**
 * Every order of these suites is a NEW ENTRY of instance A in its token's market; an order restored after a restart
 * is classified from its signed identity's token the same way (the composition knows each order's decision).
 */
const CLASSIFIER: PlacementClassifier<LimitOrderRequest, SignOutcome, SignedOrderHandle> = {
  request: (request) => ({ intent: "NEW_ENTRY", marketId: marketOf(request.assetId), instanceId: INSTANCE_A }),
  signedOrder: (outcome) => (outcome.kind === "SIGNED" ? outcome.order : undefined),
  order: (order) => ({ intent: "NEW_ENTRY", marketId: marketOf(order.identity.tokenId), instanceId: INSTANCE_A }),
};

export interface SafetyNode {
  readonly world: LiveWorld;
  readonly node: LiveNode;
  readonly safety: LiveSafety;
  readonly controller: OrderHeartbeatController;
  readonly omsProgress: OmsProgressMonitor;
  readonly store: FencingLeasePort;
  readonly reader: FakeKillSwitchReader;
  readonly geoblock: FakeBodyPort;
  readonly closedOnly: FakeBodyPort;
  readonly releaseFinality: FakeReleaseFinality;
  readonly journal: RecordingJournal;
  readonly alerts: RecordingAlerts;
  readonly heartbeatEvents: EventLog;
  /** The kill-switch cancel directives the composition received, and whether each was accepted. */
  readonly cancelCalls: { readonly directive: string; readonly accepted: boolean }[];
  /** The market feed is healthy (MARKET_DATA is proved at every step); `false` stops proving it. */
  marketDataHealthy: boolean;
  /** The composition's periodic reconcile runs (once a second). */
  periodicReconcile: boolean;
  /** Advance the time line in 250 ms steps, proving what the composition proves at each. */
  step(ms: number): Promise<void>;
  /** The live gate's reasons for a NEW ENTRY in the YES token's market. */
  entryReasons(): readonly string[];
  oms(): OrderManager;
}

export interface SafetyNodeOptions {
  readonly store?: FencingLeasePort;
  readonly holderId?: string;
  readonly credential?: string;
  readonly source?: string;
  /** Acquire the fence at start (default). */
  readonly acquire?: boolean;
  /** Start the heartbeat controller (default). */
  readonly startController?: boolean;
  readonly plan?: KillPlan | null;
  readonly fencing?: { readonly ttlMs: number; readonly renewIntervalMs: number; readonly safetyMarginMs: number; readonly transmitMarginMs: number };
}

export async function bootSafetyNode(world: LiveWorld, options: SafetyNodeOptions = {}): Promise<SafetyNode> {
  const { time } = world;
  const store = options.store ?? new MemoryFencingStore(() => time.now);
  const reader = new FakeKillSwitchReader();
  const geoblock = new FakeBodyPort(NOT_BLOCKED);
  const closedOnly = new FakeBodyPort({ closed_only: false });
  const releaseFinality = new FakeReleaseFinality();
  const journal = new RecordingJournal();
  const alerts = new RecordingAlerts();
  const heartbeatEvents = new EventLog();
  const cancelCalls: { readonly directive: string; readonly accepted: boolean }[] = [];
  const omsProgress = new OmsProgressMonitor({ clock: time });
  let safety: LiveSafety | null = null;
  const credential = options.credential ?? "trader";
  const node = await bootNode(world, {
    plan: options.plan ?? null,
    credential,
    source: options.source ?? options.holderId ?? credential,
    compose: ({ coordinator, oms }) => {
      // The kill-switch cancel port, bound THROUGH the OMS (WP-320's `cancelThroughOms`): what the venue removes, the
      // OMS learns from the venue's own answers.
      const cancels: KillSwitchCancelPort = {
        cancel: async (directive) => {
          const manager = oms();
          const accepted = manager === null ? false : await cancelThroughOms(manager, directive, () => INSTANCE_A);
          cancelCalls.push({ directive: JSON.stringify(directive), accepted });
          return accepted;
        },
      };
      safety = createLiveSafety({
        runModeContext: LIVE_CONTEXT,
        accountRef: SAFETY_ACCOUNT,
        holderId: options.holderId ?? "trader-a",
        clock: time,
        timers: time,
        fencing: { store, ...(options.fencing ?? { ttlMs: 30_000, renewIntervalMs: 5_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 }) },
        health: { maxAgeMs: HEALTH_MAX_AGE, eventLoop: { intervalMs: 500, maxLagMs: 250 } },
        killSwitch: { reader, refreshIntervalMs: 1_000, cancels, releaseSettleMs: RELEASE_SETTLE_MS, releaseFinality },
        eligibility: { geoblock, closedOnly, refreshIntervalMs: 30_000, maxAgeMs: 60_000 },
        // The OMS opens after this composition: a view bound to it once open (the live root's lazy view).
        oms: {
          get faulted(): boolean {
            return oms()?.faulted ?? true;
          },
          orders: () => oms()?.orders() ?? [],
          requestOrderReconciliation: async (orderId: string) => {
            const manager = oms();
            return manager === null ? { ok: false } : manager.requestOrderReconciliation(orderId);
          },
        },
        omsProgress,
        coordinator,
        recovery: { notRunPollMs: 100, failedRunSpacingMs: 1_000 },
        journal,
        alerts,
      });
      const composed: LiveSafety = safety;
      return {
        wrapVenue: (venue) => composed.fenceVenue(venue, REFUSALS, CLASSIFIER),
        wrapDependencies: (deps) => omsProgress.dependencies(deps),
        halts: { haltMarket: (request) => composed.halts.haltMarket(request), haltAccount: (request) => composed.halts.haltAccount(request) },
      };
    },
  });
  if (safety === null) throw new Error("the composition step did not run");
  const live: LiveSafety = safety;
  let inheritedHeartbeatId: string | null = null;
  if (options.acquire !== false) {
    const acquired = await live.acquireFence();
    if (acquired.kind !== "ACQUIRED") throw new Error(`fence not acquired: ${acquired.kind}`);
    inheritedHeartbeatId = acquired.inheritedHeartbeatId;
  }
  const controller = createOrderHeartbeatController({
    runModeContext: LIVE_SHAPED_CONTEXT,
    transport: world.clob.heartbeat(credential, { source: options.source ?? options.holderId ?? credential, checkpoint: (name, run) => node.inc.call(name, run), alive: () => node.inc.alive }),
    gate: live.heartbeatGate,
    budget: budgetFrom(RATE_LIMIT_SNAPSHOT),
    clock: time,
    timers: time,
    heartbeatIds: live.heartbeatIdSink,
    initialHeartbeatId: inheritedHeartbeatId ?? "",
    onEvent: (event: HeartbeatEvent) => {
      heartbeatEvents.listener(event);
      live.onHeartbeatEvent(event);
    },
  });
  live.attachHeartbeat(controller);
  live.start();
  let lastReconcileAt = Number.NEGATIVE_INFINITY;
  const result: SafetyNode = {
    world,
    node,
    safety: live,
    controller,
    omsProgress,
    store,
    reader,
    geoblock,
    closedOnly,
    releaseFinality,
    journal,
    alerts,
    heartbeatEvents,
    cancelCalls,
    marketDataHealthy: true,
    periodicReconcile: true,
    async step(ms: number): Promise<void> {
      const prove = async (): Promise<void> => {
        if (!node.inc.alive) return;
        if (result.marketDataHealthy) live.recordProof("MARKET_DATA", time.now);
        if (node.stream?.state() === "SUBSCRIBED") live.recordProof("USER_DATA", time.now);
        if (!result.periodicReconcile || time.now - lastReconcileAt < 1_000 || node.coordinator.status().running) return;
        lastReconcileAt = time.now;
        const calledAt = time.now;
        live.recordReconcileReport(await node.coordinator.reconcile(), calledAt);
      };
      await prove();
      let left = ms;
      while (left > 0) {
        const chunk = Math.min(250, left);
        await time.advance(chunk);
        left -= chunk;
        await prove();
      }
    },
    entryReasons: () => live.gate({ kind: "NEW_ENTRY", marketId: MARKET, instanceId: INSTANCE_A }).reasons,
    oms: () => {
      if (node.oms === null) throw new Error("no OMS");
      return node.oms;
    },
  };
  // Let the first kill-switch read, eligibility check and event-loop proof land, then start the heartbeat.
  await result.step(500);
  if (options.startController !== false) controller.start();
  return result;
}

/** Step until the D6 startup recovery lifted the entry block (or give up after `maxMs`). */
export async function untilEntriesOpen(live: SafetyNode, maxMs = 30_000): Promise<boolean> {
  for (let waited = 0; waited < maxMs; waited += 500) {
    if (live.entryReasons().length === 0) return true;
    await live.step(500);
  }
  return live.entryReasons().length === 0;
}

export { YES, NO };
