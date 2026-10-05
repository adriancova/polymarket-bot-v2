/**
 * WP-340, packet scenario 6: FENCING AND TWO WRITERS, on a REAL PostgreSQL
 * (Testcontainers; every migration applied). Two live-shaped processes, A and
 * B, share one account, ONE API key ("the venue cannot tell them apart",
 * ADR-008 §4) and one fencing lease in `ops.fencing_leases`, and BOTH keep
 * trying to transmit the whole time: a heartbeat every 5 s through WP-320's
 * REAL controller to the mock CLOB's documented endpoint, and an order every
 * tick through WP-320's REAL fenced venue port in front of WP-260's REAL
 * client. Asserted from the VENUE's log: only one process ever transmits;
 * the other's signing, placements and heartbeats are refused inside its own
 * process; and across a takeover the two never interleave.
 *
 * Each writer is the live-safety composition with WP-320's own fakes for
 * what is not this scenario's subject (the OMS view and the coordinator, as
 * WP-320's `composition()` binds them, with the OMS's persistence ports
 * instrumented by the REAL `OmsProgressMonitor`; the kill-switch reader; the
 * geoblock ports). The fence is the subject: `FencingAuthority` over the REAL
 * `createFencingLeaseStore`, the heartbeat gate, the fenced venue. A standby
 * runs no OMS or reconciler against the account (ADR-008 §5: it may not
 * submit or heartbeat while another holder is live), so neither writer opens
 * one here; the OMS's own fenced path is in `heartbeat-failure.test.ts`.
 *
 * TIME. One manual time line drives both processes' clocks and the venue's;
 * PostgreSQL's clock is real. Each tick sleeps for real (1/SPEED of the
 * tick) and then advances the time line by at least the real time the tick
 * took, so the processes' clocks never run SLOWER than the database's: a
 * holder's local deadline always falls before its lease's real expiry (the
 * authority's conservative direction), and nothing here can manufacture an
 * overlap the real clocks would not. The speed-up is capped (SPEED = 10):
 * at the uncapped ratio a 4 ms database round trip spanned a whole renewal
 * interval of process time, and the holder lost its own lease to its
 * deadline (safe, but not this scenario).
 *
 * PAPER only: the live-shaped context reaches the fakes, the mock venue and a
 * throwaway database. No credential exists.
 */

import net from "node:net";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import {
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
  NOT_BLOCKED,
  PASSING_REPORT,
  RecordingAlerts,
  RecordingJournal,
  RELEASE_SETTLE_MS,
} from "../../../../apps/trader/src/live-safety/fakes.test-support.js";
import { createLiveSafety, OmsProgressMonitor, type LiveSafety, type PlacementClassifier } from "../../../../apps/trader/src/live-safety/index.js";
import type { LimitOrderRequest, OmsVenuePort, PlacementOutcome, SignedOrderHandle, SignOutcome } from "../../../../packages/oms/src/index.js";
import type { SignedOrderEnvelope } from "../../../../packages/polymarket-secure/src/index.js";
import { budgetFrom, LIVE_SHAPED_CONTEXT } from "../../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import { createOrderHeartbeatController, type OrderHeartbeatController } from "../../../../packages/polymarket-secure/src/heartbeat/index.js";
import { createMockSignerHandle, createSecureVenueClientForTesting } from "../../../../packages/polymarket-secure/src/testing/index.js";
import { createFencingLeaseStore, FENCING_LEASE_MAX_TTL_MS, type FencingLeaseStore } from "../../../../packages/storage-postgres/src/index.js";
import { createIsolatedDatabase, createMigratedContext, type TestContext } from "../../../../packages/storage-postgres/src/testing/index.js";
import { liveWorld, MARKET, YES, type LiveWorld } from "../support/live-node.js";
import { RATE_LIMIT_SNAPSHOT } from "../support/safety-node.js";

let context: TestContext;
let store: FencingLeaseStore;
let databaseEndpoint = "";

beforeAll(async () => {
  const { connectionString } = await createIsolatedDatabase(inject("wp340PostgresAdminUrl"), "wp340_two_writers");
  const url = new URL(connectionString);
  databaseEndpoint = `${url.port}`;
  context = await createMigratedContext(connectionString);
  store = createFencingLeaseStore(context.db);
});

afterAll(async () => {
  await context.close();
});

/**
 * WP-260's network tripwire refuses EVERY TCP connect, and the database pool may open a connection at any query, so
 * this file installs a guard of the same kind with exactly one exception: a TCP connect to the throwaway container's
 * port. Every other connect, and every `fetch`, is refused and recorded; each test asserts none was attempted.
 */
interface Guard {
  refused(): readonly string[];
  uninstall(): void;
}

function installDatabaseOnlyGuard(): Guard {
  const refused: string[] = [];
  const prototype = net.Socket.prototype as unknown as { connect: (...args: unknown[]) => unknown };
  const originalConnect = prototype.connect;
  const originalFetch = globalThis.fetch;
  prototype.connect = function guardedConnect(this: unknown, ...args: unknown[]): unknown {
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const port = typeof first === "object" && first !== null ? String((first as { port?: unknown }).port ?? "") : String(first);
    if (port !== databaseEndpoint) {
      refused.push(`net.connect(${port})`);
      throw new Error(`network guard: a connect to port ${port} refused`);
    }
    return originalConnect.apply(this, args);
  };
  globalThis.fetch = (async (input: unknown) => {
    refused.push(`fetch(${String(input)})`);
    throw new Error("network guard: fetch refused");
  }) as typeof fetch;
  return {
    refused: () => [...refused],
    uninstall: () => {
      prototype.connect = originalConnect;
      globalThis.fetch = originalFetch;
    },
  };
}

let tripwire: Guard | null = null;

let accounts = 0;
const INSTANCE = "0190a3e0-0000-7000-8000-00000000340a";
const FENCING = Object.freeze({ ttlMs: 2_000, renewIntervalMs: 500, safetyMarginMs: 300, transmitMarginMs: 400 });
/** The time line runs at most this many times faster than real time (module header: TIME). */
const SPEED = 10;

const REFUSALS = Object.freeze({
  signRefused: (reasons: readonly string[]): SignOutcome => ({ kind: "FAILED", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
  placementRefused: (reasons: readonly string[]): PlacementOutcome => ({ kind: "NOT_SENT", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
});

/** Every order here reduces a position in the suite's market (no entry block applies; the fence, health and stops do). */
const CLASSIFIER: PlacementClassifier<LimitOrderRequest, SignOutcome, SignedOrderHandle> = {
  request: () => ({ intent: "REDUCTION", marketId: MARKET, instanceId: INSTANCE }),
  signedOrder: (outcome) => (outcome.kind === "SIGNED" ? outcome.order : undefined),
  order: () => ({ intent: "REDUCTION", marketId: MARKET, instanceId: INSTANCE }),
};

interface Writer {
  readonly name: string;
  readonly safety: LiveSafety;
  readonly controller: OrderHeartbeatController;
  readonly fenced: OmsVenuePort;
  /** The process is frozen: no timer of it runs, nothing of it acts (a stall), until `wake`. */
  frozen: boolean;
  readonly refusals: string[];
  sent: number;
}

async function writer(world: LiveWorld, name: string, account: string): Promise<Writer> {
  const { time, clob } = world;
  const omsProgress = new OmsProgressMonitor({ clock: time });
  omsProgress.store(new HangableOmsStore());
  omsProgress.reservations(new HangableReservations());
  omsProgress.cipher(new HangableCipher());
  const safety = createLiveSafety({
    runModeContext: LIVE_CONTEXT,
    accountRef: account,
    holderId: `trader-${name}`,
    clock: time,
    timers: time,
    fencing: { store, ...FENCING },
    health: { maxAgeMs: HEALTH_MAX_AGE, eventLoop: { intervalMs: 500, maxLagMs: 250 } },
    killSwitch: { reader: new FakeKillSwitchReader(), refreshIntervalMs: 1_000, cancels: new FakeCancels(), releaseSettleMs: RELEASE_SETTLE_MS, releaseFinality: new FakeReleaseFinality() },
    eligibility: { geoblock: new FakeBodyPort(NOT_BLOCKED), closedOnly: new FakeBodyPort({ closed_only: false }), refreshIntervalMs: 30_000, maxAgeMs: 60_000 },
    oms: new FakeOms(),
    omsProgress,
    coordinator: new FakeCoordinator(),
    recovery: { notRunPollMs: 100, failedRunSpacingMs: 1_000 },
    journal: new RecordingJournal(),
    alerts: new RecordingAlerts(),
  });
  const state = { frozen: false };
  const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle }, clob.sdk("trader", { source: name }));
  const venue: OmsVenuePort = {
    createLimitOrder: (request) => client.createLimitOrder(request),
    postOrder: (order) => client.postOrder(order as unknown as SignedOrderEnvelope),
    postOrders: (orders) => client.postOrders(orders as unknown as readonly SignedOrderEnvelope[]),
    cancelOrder: (orderId) => client.cancelOrder(orderId),
  };
  const fenced = safety.fenceVenue(venue, REFUSALS, CLASSIFIER);
  const controller = createOrderHeartbeatController({
    runModeContext: LIVE_SHAPED_CONTEXT,
    // A frozen process's timers do not run: a heartbeat it would send is never sent.
    transport: { send: (request) => (state.frozen ? new Promise<never>(() => undefined) : clob.heartbeat("trader", { source: name }).send(request)) },
    gate: safety.heartbeatGate,
    budget: budgetFrom(RATE_LIMIT_SNAPSHOT),
    clock: time,
    timers: time,
    heartbeatIds: safety.heartbeatIdSink,
    initialHeartbeatId: "",
    onEvent: (event) => safety.onHeartbeatEvent(event),
  });
  safety.attachHeartbeat(controller);
  const result: Writer = {
    name,
    safety,
    controller,
    fenced,
    get frozen() {
      return state.frozen;
    },
    set frozen(value: boolean) {
      state.frozen = value;
    },
    refusals: [],
    sent: 0,
  };
  return result;
}

/** The composition's own evidence (market data, user data, a passing periodic reconcile), unless the process is frozen. */
function prove(w: Writer, now: number): void {
  if (w.frozen) return;
  w.safety.recordProof("MARKET_DATA", now);
  w.safety.recordProof("USER_DATA", now);
  w.safety.recordReconcileReport(PASSING_REPORT, now);
}

/** One order through the writer's fenced port: signed, placed, then cancelled at once (nothing rests). */
async function tryToTransmit(w: Writer): Promise<"SENT" | "REFUSED"> {
  if (w.frozen) return "REFUSED";
  const signed = await w.fenced.createLimitOrder({ assetId: YES, side: "BUY", price: "0.5", size: "1" });
  if (signed.kind !== "SIGNED") {
    w.refusals.push(signed.error.kind);
    return "REFUSED";
  }
  const placed = await w.fenced.postOrder(signed.order);
  if (placed.kind !== "ACCEPTED") {
    w.refusals.push(placed.kind === "NOT_SENT" || placed.kind === "REFUSED" ? placed.error.kind : placed.kind);
    return "REFUSED";
  }
  w.sent += 1;
  await w.fenced.cancelOrder(placed.orderId);
  return "SENT";
}

async function activeLeases(account: string): Promise<number> {
  const result = await context.pool.query<{ count: string }>(`select count(*)::text as count from ops.fencing_leases where account_ref = $1 and status = 'ACTIVE' and expires_at > clock_timestamp()`, [account]);
  return Number(result.rows[0]?.count ?? "0");
}

interface Pair {
  readonly world: LiveWorld;
  readonly a: Writer;
  readonly b: Writer;
  bothHeld: number;
  bothPermitted: number;
  maxActive: number;
  tick(fastMs: number): Promise<void>;
}

async function pair(): Promise<Pair> {
  const world = await liveWorld();
  accounts += 1;
  // One account per test: a lease of an earlier test may still be ACTIVE by the database's clock.
  const account = `wp340-shared-account-${String(accounts)}`;
  const a = await writer(world, "A", account);
  const b = await writer(world, "B", account);
  let lastReal = performance.now();
  const p: Pair = {
    world,
    a,
    b,
    bothHeld: 0,
    bothPermitted: 0,
    maxActive: 0,
    async tick(fastMs: number): Promise<void> {
      // A real pause of 1/SPEED of the tick, then the time line advances by at least the real time spent (module header: TIME).
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.ceil(fastMs / SPEED));
      });
      const real = Math.ceil(performance.now() - lastReal);
      lastReal = performance.now();
      const advance = Math.max(fastMs, real);
      // A frozen process's refreshers and timers are stopped (`safety.stop`); its clock still moves.
      await world.time.advance(advance);
      prove(a, world.time.now);
      prove(b, world.time.now);
      const heldA = !a.frozen && a.safety.currentFence() !== null;
      const heldB = !b.frozen && b.safety.currentFence() !== null;
      if (heldA && heldB) p.bothHeld += 1;
      const permitted = (w: Writer): boolean => !w.frozen && (w.safety.heartbeatGate.evaluate().permitted || w.safety.gate({ kind: "REDUCTION", marketId: MARKET, instanceId: INSTANCE }).permitted);
      if (permitted(a) && permitted(b)) p.bothPermitted += 1;
      await tryToTransmit(a);
      await tryToTransmit(b);
      p.maxActive = Math.max(p.maxActive, await activeLeases(account));
    },
  };
  return p;
}

/** The venue's own record of who ACTED at it (a signature issued, an order placed or cancelled, a heartbeat received). */
function actsBy(world: LiveWorld, source: string): { readonly atMs: number; readonly kind: string }[] {
  return world.clob.log.filter((entry) => entry.source === source && (entry.kind !== "HEARTBEAT" || entry.detail !== "never-arrived")).map((entry) => ({ atMs: entry.atMs, kind: entry.kind }));
}

function start(w: Writer): void {
  w.safety.start();
  w.controller.start();
}

/** A stall: the process freezes; its refreshers and heartbeat stop running (its lease is no longer renewed). */
function freeze(w: Writer): void {
  w.frozen = true;
  w.safety.stop();
}

describe("WP-340 scenario 6: two live-shaped writers, one fencing lease, real PostgreSQL: only one ever transmits", () => {
  it("they race for the lease: exactly one wins; only it signs, places and heartbeats at the venue; the other is refused inside its own process, by the fence", async () => {
    tripwire = installDatabaseOnlyGuard();
    try {
      const p = await pair();
      const [first, second] = await Promise.all([p.a.safety.acquireFence(), p.b.safety.acquireFence()]);
      const kinds = [first.kind, second.kind].sort();
      expect(kinds.filter((kind) => kind === "ACQUIRED")).toHaveLength(1);
      const holder = first.kind === "ACQUIRED" ? p.a : p.b;
      const other = holder === p.a ? p.b : p.a;
      start(p.a);
      start(p.b);
      for (let index = 0; index < 120; index += 1) await p.tick(250);
      console.log("holder refusals", JSON.stringify([...new Set(holder.refusals)]), holder.refusals.length, holder.sent, JSON.stringify(holder.safety.gate({ kind: "REDUCTION", marketId: MARKET, instanceId: INSTANCE }).reasons));
      expect(holder.sent).toBeGreaterThan(50);
      expect(other.sent).toBe(0);
      expect(other.refusals.length).toBeGreaterThan(50);
      expect(new Set(other.refusals)).toContain("FENCE_NOT_ACQUIRED");
      // The venue's record: the holder acted (signatures, placements, cancels, heartbeats); the other never reached it.
      const holderActs = actsBy(p.world, holder.name);
      expect(holderActs.filter((act) => act.kind === "HEARTBEAT").length).toBeGreaterThan(4);
      expect(holderActs.filter((act) => act.kind === "PLACE").length).toBe(holder.sent);
      expect(actsBy(p.world, other.name)).toEqual([]);
      expect(p.bothHeld).toBe(0);
      expect(p.bothPermitted).toBe(0);
      expect(p.maxActive).toBe(1);
      expect(p.world.clob.violations).toEqual([]);
      p.a.safety.stop();
      p.b.safety.stop();
      p.a.controller.close();
      p.b.controller.close();
    } finally {
      const refused = tripwire?.refused() ?? [];
      tripwire?.uninstall();
      expect(refused).toEqual([]);
    }
  });

  for (const how of ["the holder STALLS (it stops renewing)", "an operator REVOKES the live holder"] as const) {
    it(`${how}: the other takes over only after the lease ended by the database's clock and the bound (${String(FENCING_LEASE_MAX_TTL_MS)} ms) passed; from its first act on, the old holder never reaches the venue again`, async () => {
      tripwire = installDatabaseOnlyGuard();
      try {
        const p = await pair();
        expect((await p.a.safety.acquireFence()).kind).toBe("ACQUIRED");
        expect((await p.b.safety.acquireFence()).kind).toBe("HELD_ELSEWHERE");
        start(p.a);
        start(p.b);
        for (let index = 0; index < 40; index += 1) await p.tick(250);
        expect(p.a.sent).toBeGreaterThan(20);
        const aFence = p.a.safety.currentFence();
        if (aFence === null) throw new Error("A holds no fence");
        // A signs an order while it holds the fence, and has not posted it when it loses the fence.
        const heldBack = await p.a.fenced.createLimitOrder({ assetId: YES, side: "BUY", price: "0.5", size: "1" });
        if (heldBack.kind !== "SIGNED") throw new Error("the holder could not sign");
        if (how === "an operator REVOKES the live holder") expect(await store.revoke({ fencingLeaseId: aFence.fencingLeaseId, reason: "operator: suspected second writer" })).toBe(true);
        else freeze(p.a);
        const stoppedAt = p.world.time.now;
        // B keeps asking; A (alive or frozen) keeps trying to transmit at every tick.
        let takeoverAt: number | null = null;
        for (let index = 0; index < 600 && takeoverAt === null; index += 1) {
          await p.tick(250);
          if ((await p.b.safety.acquireFence()).kind === "ACQUIRED") takeoverAt = p.world.time.now;
        }
        expect(takeoverAt).not.toBeNull();
        expect((takeoverAt ?? 0) - stoppedAt).toBeGreaterThanOrEqual(FENCING_LEASE_MAX_TTL_MS);
        // The frozen holder wakes and tries again: its fence has lapsed; nothing of it reaches the venue.
        if (p.a.frozen) {
          p.a.frozen = false;
          p.a.safety.start();
        }
        // The order A signed while it held the fence is refused at its transmission: the fence is asked again then.
        const late = await p.a.fenced.postOrder(heldBack.order);
        expect(late.kind).toBe("NOT_SENT");
        if (late.kind === "NOT_SENT") expect(late.error.kind.startsWith("FENCE_") || late.error.kind.startsWith("HEALTH_")).toBe(true);
        expect(p.world.clob.receipts).not.toContain(heldBack.order.identity.salt);
        for (let index = 0; index < 80; index += 1) await p.tick(250);
        expect(p.b.sent).toBeGreaterThan(20);
        expect(await p.a.safety.acquireFence()).toMatchObject({ kind: "HELD_ELSEWHERE" });
        // The venue's record: every act of A precedes B's first act, and nothing of A follows it.
        const aActs = actsBy(p.world, "A");
        const bActs = actsBy(p.world, "B");
        const bFirst = bActs[0]?.atMs ?? Number.POSITIVE_INFINITY;
        expect(bActs.length).toBeGreaterThan(20);
        expect(aActs.filter((act) => act.atMs >= bFirst)).toEqual([]);
        expect(Math.max(...aActs.map((act) => act.atMs))).toBeLessThan(bFirst);
        // The shared API key's heartbeat chain carried over: B's first heartbeat recovered with the venue's expected id at most once.
        expect(p.world.clob.log.filter((entry) => entry.source === "B" && entry.kind === "HEARTBEAT" && entry.detail.startsWith("invalid:")).length).toBeLessThanOrEqual(1);
        expect(p.bothHeld).toBe(0);
        expect(p.bothPermitted).toBe(0);
        expect(p.maxActive).toBe(1);
        expect(p.world.clob.violations).toEqual([]);
        p.a.safety.stop();
        p.b.safety.stop();
        p.a.controller.close();
        p.b.controller.close();
      } finally {
        const refused = tripwire?.refused() ?? [];
        tripwire?.uninstall();
        expect(refused).toEqual([]);
      }
    });
  }
});
