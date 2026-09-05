/**
 * Test doubles for the trader's INFRASTRUCTURE PORTS — and for nothing else.
 *
 * The rule this module keeps, stated because it is the difference between an
 * integration test and a theatre performance: **the subject is never doubled.**
 * Books, features, the strategy runtime, the strategy, capital allocation, risk,
 * planning, the simulated venue, the ledger and the PnL engine are the REAL
 * merged packages in every test that uses this module. What is doubled here is
 * only what §12.1 defines as a swappable seam plus the two failure boundaries
 * §4.2 names:
 *
 * | Double | Real thing | Why it is doubled |
 * | --- | --- | --- |
 * | {@link ManualClock} | the §12.1 `Clock` | a wall clock is non-deterministic (§12.4) |
 * | {@link MemoryEventFeed} | Redis, over `packages/event-bus` | §4.2's Redis outage, injectable |
 * | {@link MemoryTraderStore} | PostgreSQL, over `packages/storage-postgres` | §4.2's PostgreSQL outage, injectable |
 *
 * That is exactly the `WP-120` integration-suite precedent: "Acceptance 4
 * ('Redis outage stops publication but not WAL recording') is exercised against
 * the WP-060 transport INTERFACE via an in-memory implementation with failure
 * injection."
 *
 * NO DOCKER, NO NETWORK, NO CREDENTIAL. Nothing in this module opens a socket or
 * reads a file.
 */

import type {
  DecisionRecord,
  DecisionTelemetry,
  StrategyStateCheckpoint,
} from "@polymarket-bot/strategy-runtime";
import type { AppendedLedgerTransaction } from "@polymarket-bot/ledger";
import type { PnlSnapshot } from "@polymarket-bot/pnl";

import {
  portFailed,
  portOk,
  type Clock,
  type IngestedEvent,
  type MarketEventFeed,
  type PortResult,
  type TraderStore,
} from "../ports.js";

/**
 * A clock positioned by the caller.
 *
 * `now()` answers the instant it was last positioned at, and `monotonicNs()`
 * answers a counter that advances with it. Nothing reads a host clock, so a run
 * driven by a fixed event list produces a fixed sequence of instants — which is
 * what §12.4's byte-identity claim rests on.
 */
export class ManualClock implements Clock {
  #instant: string;
  #monotonicNs: bigint;

  constructor(startAt: string, startMonotonicNs = 0n) {
    this.#instant = startAt;
    this.#monotonicNs = startMonotonicNs;
  }

  now(): string {
    return this.#instant;
  }

  monotonicNs(): bigint {
    return this.#monotonicNs;
  }

  /** Positions the clock at a recorded instant. */
  positionAt(instant: string, monotonicNs: bigint): void {
    this.#instant = instant;
    this.#monotonicNs = monotonicNs;
  }
}

/**
 * An in-memory event feed with failure injection — §4.2's Redis boundary.
 *
 * The three injectable states are the three the real transport can be in:
 * healthy, unreachable (`UNAVAILABLE`), and ADR-003 §3.3's hard resync
 * (`RESYNC_REQUIRED`). The last is not an error the loop can retry through:
 * §7.1 requires a new authoritative snapshot before affected markets resume, so
 * the trader must halt on it, which is what the acceptance test asserts.
 */
export class MemoryEventFeed implements MarketEventFeed {
  #pending: IngestedEvent[];
  #failure: { kind: "UNAVAILABLE" | "RESYNC_REQUIRED"; detail: string } | undefined;
  #closed = false;
  #polls = 0;
  #commits = 0;

  constructor(events: readonly IngestedEvent[] = []) {
    this.#pending = [...events];
  }

  /** Queues more events, as a publisher would. */
  publish(...events: readonly IngestedEvent[]): void {
    this.#pending.push(...events);
  }

  /** Makes every later `poll` answer the named failure. §4.2's outage. */
  fail(kind: "UNAVAILABLE" | "RESYNC_REQUIRED", detail: string): void {
    this.#failure = { kind, detail };
  }

  /** Clears an injected failure. */
  recover(): void {
    this.#failure = undefined;
  }

  get polls(): number {
    return this.#polls;
  }

  get commits(): number {
    return this.#commits;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async poll(): Promise<PortResult<readonly IngestedEvent[]>> {
    this.#polls += 1;
    if (this.#failure !== undefined) {
      return await Promise.resolve(portFailed(this.#failure.kind, this.#failure.detail));
    }
    const batch = this.#pending;
    this.#pending = [];
    return await Promise.resolve(portOk(Object.freeze(batch)));
  }

  async commit(): Promise<PortResult<null>> {
    this.#commits += 1;
    if (this.#failure !== undefined) {
      return await Promise.resolve(portFailed(this.#failure.kind, this.#failure.detail));
    }
    return await Promise.resolve(portOk(null));
  }

  async close(): Promise<void> {
    this.#closed = true;
    return await Promise.resolve();
  }
}

/**
 * An in-memory durable store with failure injection — §4.2's PostgreSQL
 * boundary.
 *
 * It records everything written, so a test can assert the §6 invariant 3
 * one-decision-per-callback property and the ledger chain against what actually
 * reached the store rather than against what the loop believes it wrote.
 */
export class MemoryTraderStore implements TraderStore {
  readonly decisions: { record: DecisionRecord; telemetry: DecisionTelemetry }[] = [];
  readonly checkpoints: StrategyStateCheckpoint[] = [];
  /** The instant each checkpoint was captured at, in the same order. */
  readonly checkpointInstants: string[] = [];
  readonly transactions: AppendedLedgerTransaction[] = [];
  readonly pnlSnapshots: PnlSnapshot[] = [];
  #failure: { kind: "UNAVAILABLE" | "UNREADABLE"; detail: string } | undefined;
  #closed = false;

  /** Makes every later write answer the named failure. */
  fail(kind: "UNAVAILABLE" | "UNREADABLE", detail: string): void {
    this.#failure = { kind, detail };
  }

  recover(): void {
    this.#failure = undefined;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async persistDecision(
    record: DecisionRecord,
    telemetry: DecisionTelemetry,
  ): Promise<PortResult<null>> {
    if (this.#failure !== undefined) {
      return await Promise.resolve(portFailed(this.#failure.kind, this.#failure.detail));
    }
    this.decisions.push({ record, telemetry });
    return await Promise.resolve(portOk(null));
  }

  async saveCheckpoint(
    checkpoint: StrategyStateCheckpoint,
    capturedAt: string,
  ): Promise<PortResult<null>> {
    if (this.#failure !== undefined) {
      return await Promise.resolve(portFailed(this.#failure.kind, this.#failure.detail));
    }
    this.checkpoints.push(checkpoint);
    this.checkpointInstants.push(capturedAt);
    return await Promise.resolve(portOk(null));
  }

  async appendLedgerTransaction(
    transaction: AppendedLedgerTransaction,
  ): Promise<PortResult<null>> {
    if (this.#failure !== undefined) {
      return await Promise.resolve(portFailed(this.#failure.kind, this.#failure.detail));
    }
    this.transactions.push(transaction);
    return await Promise.resolve(portOk(null));
  }

  async writePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>> {
    if (this.#failure !== undefined) {
      return await Promise.resolve(portFailed(this.#failure.kind, this.#failure.detail));
    }
    this.pnlSnapshots.push(snapshot);
    return await Promise.resolve(portOk(null));
  }

  async close(): Promise<void> {
    this.#closed = true;
    return await Promise.resolve();
  }
}
