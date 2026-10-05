/**
 * TEST SUPPORT (imported only by `*.test.ts` files here and by
 * `test/fault-injection/live-safety/**`): a manual monotonic clock with a
 * timer queue, an in-memory fencing lease store that keeps the database's
 * rules (one ACTIVE lease per account and realm, a token above every earlier
 * one, expiry by its OWN clock, holder-keyed writes, migration 0008's
 * validity check), and recording journals, pagers and readers. Nothing here
 * reaches a network, a database or a venue. PAPER only. The PostgreSQL
 * behaviour itself is proven against a real database by
 * `test/integration/postgres/fencing-race.test.ts`.
 */

import type { FencingAcquireOutcome, FencingLeaseRef, FencingRenewOutcome } from "@polymarket-bot/storage-postgres";
import { NonRealModeFencingLeaseError } from "@polymarket-bot/storage-postgres";

import { isLiveRunMode, type Fence, type FencingLeasePort } from "./fencing-authority.js";
import type { HealthInput } from "./health-lease.js";
import type { KillSwitchReader, KillSwitchRow } from "./kill-switch.js";
import { createLiveSafety, type KillSwitchCancelPort, type LiveSafety, type LiveSafetyOptions } from "./live-safety.js";
import type { LiveSafetyAlerts, LiveSafetyJournal, LiveSafetyPage, LiveSafetyRecord, MonotonicClock, SafetyCoordinator, SafetyOms, SafetyOrderView, SafetyTimers } from "./ports.js";

interface Scheduled {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
}

/** Let every pending promise continuation run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

/** A manual monotonic clock and timer queue. */
export class ManualClock implements MonotonicClock, SafetyTimers {
  #now: number;
  #order = 0;
  readonly #queue = new Map<number, Scheduled>();
  readonly #faulty: number[] = [];

  constructor(start = 5_000_000) {
    this.#now = start;
  }

  get now(): number {
    return this.#now;
  }

  monotonicMs(): number {
    return this.#faulty.shift() ?? this.#now;
  }

  /** The next `monotonicMs()` reading returns `value` (a step backwards, when below `now`). */
  injectReading(value: number): void {
    this.#faulty.push(value);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.#order += 1;
    const id = this.#order;
    this.#queue.set(id, { at: this.#now + Math.max(0, delayMs), order: id, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#queue.delete(handle);
  }

  pendingTimers(): number {
    return this.#queue.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await settle();
      let next: [number, Scheduled] | undefined;
      for (const entry of this.#queue) {
        if (entry[1].at > target) continue;
        if (next === undefined || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[1].order < next[1].order)) next = entry;
      }
      if (next === undefined) break;
      this.#queue.delete(next[0]);
      if (next[1].at > this.#now) this.#now = next[1].at;
      next[1].callback();
    }
    if (target > this.#now) this.#now = target;
    await settle();
  }
}

interface LeaseRow {
  readonly fencingLeaseId: string;
  readonly fencingToken: bigint;
  readonly accountRef: string;
  readonly environment: string;
  readonly holderId: string;
  status: "ACTIVE" | "EXPIRED" | "RELEASED" | "REVOKED";
  expiresAtMs: number;
  heartbeatId: string | null;
  reason: string | null;
}

/**
 * The fencing lease store's rules, in memory, over ITS OWN clock (`dbNowMs`),
 * which a test may move apart from the process's monotonic clock (a database
 * clock step). `down = true` makes every call reject (the database is lost).
 */
export class MemoryFencingStore implements FencingLeasePort {
  readonly rows: LeaseRow[] = [];
  readonly #highWater = new Map<string, bigint>();
  down = false;
  /** Calls, in order, for assertions (e.g. that a refused run mode reached nothing). */
  readonly calls: string[] = [];
  #ids = 0;
  /** The database clock. */
  dbNowMs: () => number;

  constructor(dbNowMs: () => number) {
    this.dbNowMs = dbNowMs;
  }

  #guard(name: string): void {
    this.calls.push(name);
    if (this.down) throw new Error("connection terminated unexpectedly (synthetic)");
  }

  #expireLapsed(accountRef: string): void {
    for (const row of this.rows) {
      if (row.accountRef === accountRef && row.status === "ACTIVE" && row.expiresAtMs <= this.dbNowMs()) {
        row.status = "EXPIRED";
        row.reason = "lease expired before a new acquisition";
      }
    }
  }

  async acquire(input: Parameters<FencingLeasePort["acquire"]>[0]): Promise<FencingAcquireOutcome> {
    const environment = input.environment;
    if (!isLiveRunMode(environment)) throw new NonRealModeFencingLeaseError(environment, input.accountRef);
    this.#guard("acquire");
    await Promise.resolve();
    this.#expireLapsed(input.accountRef);
    const incumbent = this.rows.find((row) => row.accountRef === input.accountRef && row.status === "ACTIVE");
    if (incumbent !== undefined) {
      return { kind: "HELD", holderId: incumbent.holderId, fencingToken: incumbent.fencingToken.toString(), expiresAt: new Date(incumbent.expiresAtMs).toISOString() };
    }
    const previous = [...this.rows].filter((row) => row.accountRef === input.accountRef).sort((a, b) => (a.fencingToken < b.fencingToken ? 1 : -1))[0];
    const token = (this.#highWater.get(input.accountRef) ?? 0n) + 1n;
    this.#highWater.set(input.accountRef, token);
    this.#ids += 1;
    const row: LeaseRow = {
      fencingLeaseId: `0190a3e0-0000-7000-8000-${String(this.#ids).padStart(12, "0")}`,
      fencingToken: token,
      accountRef: input.accountRef,
      environment: input.environment,
      holderId: input.holderId,
      status: "ACTIVE",
      expiresAtMs: this.dbNowMs() + input.ttlMs,
      heartbeatId: null,
      reason: null,
    };
    this.rows.push(row);
    return {
      kind: "ACQUIRED",
      grant: {
        fencingLeaseId: row.fencingLeaseId,
        fencingToken: token.toString(),
        accountRef: row.accountRef,
        environment,
        holderId: row.holderId,
        acquiredAt: new Date(this.dbNowMs()).toISOString(),
        expiresAt: new Date(row.expiresAtMs).toISOString(),
        inheritedHeartbeatId: previous?.heartbeatId ?? null,
      },
    };
  }

  #find(ref: FencingLeaseRef): LeaseRow | undefined {
    return this.rows.find((row) => row.fencingLeaseId === ref.fencingLeaseId && row.fencingToken.toString() === ref.fencingToken && row.holderId === ref.holderId);
  }

  async renew(ref: FencingLeaseRef, ttlMs: number): Promise<FencingRenewOutcome> {
    this.#guard("renew");
    await Promise.resolve();
    const row = this.#find(ref);
    if (row === undefined || row.status !== "ACTIVE" || row.expiresAtMs <= this.dbNowMs()) return { kind: "LOST" };
    row.expiresAtMs = this.dbNowMs() + ttlMs;
    return { kind: "RENEWED", expiresAt: new Date(row.expiresAtMs).toISOString() };
  }

  async recordHeartbeatId(ref: FencingLeaseRef, heartbeatId: string): Promise<boolean> {
    this.#guard("recordHeartbeatId");
    await Promise.resolve();
    const row = this.#find(ref);
    if (row === undefined || row.status !== "ACTIVE" || row.expiresAtMs <= this.dbNowMs()) return false;
    row.heartbeatId = heartbeatId;
    return true;
  }

  async release(ref: FencingLeaseRef, reason: string): Promise<boolean> {
    this.#guard("release");
    await Promise.resolve();
    const row = this.#find(ref);
    if (row === undefined || row.status !== "ACTIVE") return false;
    row.status = "RELEASED";
    row.reason = reason;
    return true;
  }

  /** An operator's revocation. */
  revoke(fencingLeaseId: string, reason: string): boolean {
    const row = this.rows.find((candidate) => candidate.fencingLeaseId === fencingLeaseId && candidate.status === "ACTIVE");
    if (row === undefined) return false;
    row.status = "REVOKED";
    row.reason = reason;
    return true;
  }

  /** Migration 0008's validity trigger: would a live attempt naming `fence` be accepted NOW (database clock)? */
  attemptAccepted(fence: Fence | null): boolean {
    if (fence === null) return false;
    const row = this.rows.find((candidate) => candidate.fencingLeaseId === fence.fencingLeaseId && candidate.fencingToken.toString() === fence.fencingToken);
    return row !== undefined && row.status === "ACTIVE" && row.expiresAtMs > this.dbNowMs();
  }

  activeHolders(accountRef: string): string[] {
    return this.rows.filter((row) => row.accountRef === accountRef && row.status === "ACTIVE" && row.expiresAtMs > this.dbNowMs()).map((row) => row.holderId);
  }
}

export class RecordingJournal implements LiveSafetyJournal {
  readonly entries: LiveSafetyRecord[] = [];
  record(entry: LiveSafetyRecord): void {
    this.entries.push(entry);
  }
  of<K extends LiveSafetyRecord["kind"]>(kind: K): Extract<LiveSafetyRecord, { kind: K }>[] {
    return this.entries.filter((entry): entry is Extract<LiveSafetyRecord, { kind: K }> => entry.kind === kind);
  }
}

export class RecordingAlerts implements LiveSafetyAlerts {
  readonly pages: { readonly page: LiveSafetyPage; readonly detail: string }[] = [];
  page(page: LiveSafetyPage, detail: string): void {
    this.pages.push({ page, detail });
  }
}

/** The control plane's documents (`apps/control-api/src/control-plane.ts`: `killSwitchDocument`, `killSwitchAbsent`). */
export function engageRow(options: {
  readonly id: string;
  readonly scope: string;
  readonly scopeRef: string | null;
  readonly action: string;
  readonly environment?: string;
}): KillSwitchRow {
  return {
    killSwitchEventId: options.id,
    environment: options.environment ?? "LIVE_MICRO",
    scope: options.scope,
    scopeRef: options.scopeRef,
    action: options.action,
    resultingState: {
      engaged: "true",
      scope: options.scope,
      scopeRef: options.scopeRef,
      action: options.action,
      reason: "operator test",
      since: "2026-10-04T00:00:00.000Z",
      actor: "operator-1",
    },
  };
}

export function releaseRow(options: { readonly id: string; readonly scope: string; readonly scopeRef: string | null; readonly action: string; readonly environment?: string }): KillSwitchRow {
  return {
    killSwitchEventId: options.id,
    environment: options.environment ?? "LIVE_MICRO",
    scope: options.scope,
    scopeRef: options.scopeRef,
    action: options.action,
    resultingState: { engaged: "false", scope: options.scope, scopeRef: options.scopeRef },
  };
}

/** A kill-switch reader over rows a test sets; `failing = true` makes reads reject. */
export class FakeKillSwitchReader implements KillSwitchReader {
  rows: KillSwitchRow[] = [];
  failing = false;
  reads = 0;
  async read(): Promise<readonly KillSwitchRow[]> {
    this.reads += 1;
    await Promise.resolve();
    if (this.failing) throw new Error("relation lookup failed (synthetic)");
    return [...this.rows];
  }
}

/** The geoblock fixture's documented examples (`test/fixtures/venue/geoblock/geoblock.json`), as plain bodies. */
export const NOT_BLOCKED = Object.freeze({ blocked: false, ip: "192.0.2.10", country: "AR", region: "" });
export const BLOCKED_CLOSE_ONLY_TIER = Object.freeze({ blocked: true, ip: "198.51.100.20", country: "US", region: "NY" });

/** A port answering from a settable body; `failing = true` rejects. */
export class FakeBodyPort {
  body: unknown;
  failing = false;
  calls = 0;
  constructor(body: unknown) {
    this.body = body;
  }
  async check(): Promise<unknown> {
    return this.read();
  }
  async read(): Promise<unknown> {
    this.calls += 1;
    await Promise.resolve();
    if (this.failing) throw new Error("socket hang up (synthetic)");
    return this.body;
  }
}

// ---------------------------------------------------------------------------
// A whole composition over fakes.


export const ACCOUNT = "acct-1";

export const HEALTH_MAX_AGE: Readonly<Record<HealthInput, number>> = Object.freeze({
  MARKET_DATA: 3_000,
  USER_DATA: 15_000,
  EVENT_LOOP: 2_000,
  OMS: 1_000,
  DATABASE: 4_000,
  RECONCILER: 30_000,
  KILL_SWITCH: 3_000,
});

/** A minimal OMS: orders a test sets; every reconciliation request recorded. */
export class FakeOms implements SafetyOms {
  faulted = false;
  views: SafetyOrderView[] = [];
  readonly requested: string[] = [];
  orders(): readonly SafetyOrderView[] {
    return [...this.views];
  }
  async requestOrderReconciliation(orderId: string): Promise<{ readonly ok: boolean }> {
    this.requested.push(orderId);
    const order = this.views.find((view) => view.orderId === orderId);
    if (order === undefined || !["ACKNOWLEDGED", "LIVE", "DELAYED", "PARTIALLY_FILLED", "CANCEL_PENDING"].includes(order.state)) return { ok: false };
    this.views = this.views.map((view) => (view.orderId === orderId ? { ...view, state: "RECONCILING" } : view));
    return { ok: true };
  }
}

/** A minimal coordinator: every reconcile passes and resumes unless the test says otherwise. */
export class FakeCoordinator implements SafetyCoordinator {
  readonly triggers: string[] = [];
  reconciles = 0;
  running = false;
  outcome: { readonly status: string; readonly resumed: boolean } = { status: "PASSED", resumed: true };
  trigger(trigger: "POSITION_BALANCE_DISCREPANCY"): void {
    this.triggers.push(trigger);
  }
  async reconcile(): Promise<{ readonly runs: readonly { readonly status: string; readonly resumed: boolean }[]; readonly resumed: boolean }> {
    this.reconciles += 1;
    await Promise.resolve();
    return { runs: [this.outcome], resumed: this.outcome.resumed };
  }
  status(): { readonly running: boolean } {
    return { running: this.running };
  }
}

export class FakeCancels implements KillSwitchCancelPort {
  readonly calls: string[] = [];
  answer: unknown = true;
  async cancel(directive: Parameters<KillSwitchCancelPort["cancel"]>[0]): Promise<unknown> {
    this.calls.push(JSON.stringify(directive));
    await Promise.resolve();
    return this.answer;
  }
}

export interface Composition {
  readonly clock: ManualClock;
  readonly store: MemoryFencingStore;
  readonly reader: FakeKillSwitchReader;
  readonly geoblock: FakeBodyPort;
  readonly closedOnly: FakeBodyPort;
  readonly oms: FakeOms;
  readonly coordinator: FakeCoordinator;
  readonly cancels: FakeCancels;
  readonly journal: RecordingJournal;
  readonly alerts: RecordingAlerts;
  readonly safety: LiveSafety;
  /** Prove MARKET_DATA, USER_DATA and RECONCILER now (the composition's own evidence). */
  proveComposition(): void;
}

export function composition(overrides: Partial<LiveSafetyOptions> = {}, clock: ManualClock = new ManualClock()): Composition {
  const store = new MemoryFencingStore(() => clock.now);
  const reader = new FakeKillSwitchReader();
  const geoblock = new FakeBodyPort(NOT_BLOCKED);
  const closedOnly = new FakeBodyPort({ closed_only: false });
  const oms = new FakeOms();
  const coordinator = new FakeCoordinator();
  const cancels = new FakeCancels();
  const journal = new RecordingJournal();
  const alerts = new RecordingAlerts();
  const safety = createLiveSafety({
    runMode: "LIVE_MICRO",
    accountRef: ACCOUNT,
    holderId: "trader-a",
    clock,
    timers: clock,
    fencing: { store, ttlMs: 30_000, renewIntervalMs: 5_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 },
    health: { maxAgeMs: HEALTH_MAX_AGE, eventLoop: { intervalMs: 500, maxLagMs: 250 } },
    killSwitch: { reader, refreshIntervalMs: 1_000, cancels },
    eligibility: { geoblock, closedOnly, refreshIntervalMs: 30_000, maxAgeMs: 60_000 },
    oms,
    coordinator,
    recovery: { notRunPollMs: 100, failedRunSpacingMs: 1_000 },
    journal,
    alerts,
    ...overrides,
  });
  return {
    clock,
    store,
    reader,
    geoblock,
    closedOnly,
    oms,
    coordinator,
    cancels,
    journal,
    alerts,
    safety,
    proveComposition: () => {
      safety.recordProof("MARKET_DATA", clock.now);
      safety.recordProof("USER_DATA", clock.now);
      safety.recordProof("RECONCILER", clock.now);
    },
  };
}
