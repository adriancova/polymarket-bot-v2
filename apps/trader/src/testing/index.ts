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
import { toPnlSnapshotRow, type PnlSnapshot } from "@polymarket-bot/pnl";

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
 * The name of `accounting.pnl_snapshots`' identity constraint
 * (`db/migrations/0006_accounting.up.sql`), which {@link MemoryTraderStore}
 * enforces too (`SNAP-1`).
 */
export const PNL_SNAPSHOT_SCOPE_UNIQUE = "pnl_snapshots_scope_unique";

/**
 * The refusal {@link MemoryTraderStore.writePnlSnapshot} answers for a second
 * row of one identity — the SAME port data `PostgresTraderStore` answers for
 * the database's refusal (`adapters/postgres-store.ts` `#contained`: kind
 * `UNAVAILABLE`, detail "the durable store could not write a PnL snapshot: "
 * + the driver error's `name: message`, where node-postgres names its
 * `DatabaseError` `error`), as `durable-pnl-snapshot-postgres.test.ts` pins it.
 */
export const DUPLICATE_PNL_SNAPSHOT_DETAIL =
  "the durable store could not write a PnL snapshot: error: duplicate key value violates " +
  `unique constraint "${PNL_SNAPSHOT_SCOPE_UNIQUE}"`;

/**
 * `timestamptz` equality for `as_of`: the instant at MICROSECOND resolution,
 * whatever the zone or the number of fraction digits the string carries — so
 * `…T09:00:02Z`, `…T09:00:02.000Z` and `…T11:00:02+02:00` are one key, as they
 * are in PostgreSQL. Digits past the sixth are rounded half-to-even, which is
 * what PostgreSQL 16 did on every tie probed for `SNAP-1` (`.0000005` → `.000000`,
 * `.0000015` → `.000002`, `.0000025` → `.000002`, `.0000035` → `.000004`). A
 * string this cannot read keys as itself (the real column would refuse it,
 * with a different error this double does not model).
 */
function asOfKey(asOf: unknown): string {
  if (typeof asOf !== "string") return JSON.stringify(String(asOf));
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(asOf);
  if (match === null) return JSON.stringify(asOf);
  const [, year, month, day, hour, minute, second, fraction = "", zone = "Z"] = match;
  const offsetSeconds =
    zone === "Z"
      ? 0
      : (zone.startsWith("-") ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 3600 + Number(zone.slice(4, 6)) * 60);
  let seconds =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) /
      1000 -
    offsetSeconds;
  let micros = Number(fraction.padEnd(6, "0").slice(0, 6));
  const rest = fraction.slice(6);
  if (rest !== "") {
    const first = rest.charCodeAt(0) - 48;
    const beyond = /[1-9]/u.test(rest.slice(1));
    if (first > 5 || (first === 5 && (beyond || micros % 2 === 1))) micros += 1;
  }
  if (micros === 1_000_000) {
    seconds += 1;
    micros = 0;
  }
  return `${String(seconds)}.${String(micros).padStart(6, "0")}`;
}

/**
 * The identity `pnl_snapshots_scope_unique` is declared over —
 * `unique nulls not distinct (scope, environment, account_ref, instance_id,
 * market_id, as_of)` — read from the row exactly as the adapter binds it
 * (`toPnlSnapshotRow`, own fields only). An absent value binds as NULL in the
 * adapter and as `null` here, and two NULLs are EQUAL (`nulls not distinct`).
 * `run_id` and `denomination_asset` are NOT in the key.
 */
function pnlSnapshotKey(snapshot: PnlSnapshot): string {
  const row = toPnlSnapshotRow(snapshot);
  return JSON.stringify([
    row.scope ?? null,
    row.environment ?? null,
    row.accountRef ?? null,
    row.instanceId ?? null,
    row.marketId ?? null,
    asOfKey(row.asOf),
  ]);
}

/**
 * An in-memory durable store with failure injection — §4.2's PostgreSQL
 * boundary.
 *
 * It records everything written, so a test can assert the §6 invariant 3
 * one-decision-per-callback property and the ledger chain against what actually
 * reached the store rather than against what the loop believes it wrote.
 *
 * `SNAP-1`: it ENFORCES `accounting.pnl_snapshots`' identity constraint
 * ({@link PNL_SNAPSHOT_SCOPE_UNIQUE}). It used to push every snapshot, which
 * is how the in-memory doubles masked `BRACKET1C-SNAPKEY` — the loop wrote
 * one row PER FILL and the original paper-e2e golden held two rows of one
 * instance at one instant, which the database refuses. A second row of one
 * identity is now refused with the adapter's own port data
 * ({@link DUPLICATE_PNL_SNAPSHOT_DETAIL}) and NOT recorded.
 */
/** The four writes {@link MemoryTraderStore} can be made to fail, by name. */
export type TraderStoreWrite =
  | "persistDecision"
  | "saveCheckpoint"
  | "appendLedgerTransaction"
  | "writePnlSnapshot";

export class MemoryTraderStore implements TraderStore {
  readonly decisions: { record: DecisionRecord; telemetry: DecisionTelemetry }[] = [];
  readonly checkpoints: StrategyStateCheckpoint[] = [];
  /** The instant each checkpoint was captured at, in the same order. */
  readonly checkpointInstants: string[] = [];
  readonly transactions: AppendedLedgerTransaction[] = [];
  readonly pnlSnapshots: PnlSnapshot[] = [];
  /** `SNAP-1`: the identity of every snapshot recorded — `pnl_snapshots_scope_unique`. */
  readonly #pnlSnapshotKeys = new Set<string>();
  #failure: { kind: "UNAVAILABLE" | "UNREADABLE"; detail: string } | undefined;
  /** When set, only these writes fail; the others still succeed. */
  #failing: ReadonlySet<TraderStoreWrite> | undefined;
  #closed = false;

  /** Makes every later write answer the named failure. */
  fail(kind: "UNAVAILABLE" | "UNREADABLE", detail: string): void {
    this.#failure = { kind, detail };
    this.#failing = undefined;
  }

  /**
   * Makes only the NAMED writes fail.
   *
   * A real PostgreSQL outage takes every statement down at once, which
   * {@link fail} models. This narrower injection models the other real case —
   * one statement failing while the connection is up (a constraint violation, a
   * table-level lock, a partition that is not there) — and it is what lets a
   * test place a §4.2 halt at an EXACT point inside one iteration rather than
   * at the first write of the iteration.
   */
  failOnly(
    writes: readonly TraderStoreWrite[],
    kind: "UNAVAILABLE" | "UNREADABLE",
    detail: string,
  ): void {
    this.#failure = { kind, detail };
    this.#failing = new Set(writes);
  }

  recover(): void {
    this.#failure = undefined;
    this.#failing = undefined;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #refusalFor(write: TraderStoreWrite): PortResult<null> | undefined {
    const failure = this.#failure;
    if (failure === undefined) return undefined;
    if (this.#failing !== undefined && !this.#failing.has(write)) return undefined;
    return portFailed(failure.kind, failure.detail);
  }

  async persistDecision(
    record: DecisionRecord,
    telemetry: DecisionTelemetry,
  ): Promise<PortResult<null>> {
    const refused = this.#refusalFor("persistDecision");
    if (refused !== undefined) return await Promise.resolve(refused);
    this.decisions.push({ record, telemetry });
    return await Promise.resolve(portOk(null));
  }

  async saveCheckpoint(
    checkpoint: StrategyStateCheckpoint,
    capturedAt: string,
  ): Promise<PortResult<null>> {
    const refused = this.#refusalFor("saveCheckpoint");
    if (refused !== undefined) return await Promise.resolve(refused);
    this.checkpoints.push(checkpoint);
    this.checkpointInstants.push(capturedAt);
    return await Promise.resolve(portOk(null));
  }

  async appendLedgerTransaction(
    transaction: AppendedLedgerTransaction,
  ): Promise<PortResult<null>> {
    const refused = this.#refusalFor("appendLedgerTransaction");
    if (refused !== undefined) return await Promise.resolve(refused);
    this.transactions.push(transaction);
    return await Promise.resolve(portOk(null));
  }

  /**
   * Records one snapshot — unless an injected failure refuses it, or a
   * snapshot of the same `pnl_snapshots_scope_unique` identity is already
   * recorded (`SNAP-1`): then it answers the adapter's own refusal for the
   * constraint violation and records nothing, as the database inserts nothing.
   */
  async writePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>> {
    const refused = this.#refusalFor("writePnlSnapshot");
    if (refused !== undefined) return await Promise.resolve(refused);
    const key = pnlSnapshotKey(snapshot);
    if (this.#pnlSnapshotKeys.has(key)) {
      return await Promise.resolve(portFailed<null>("UNAVAILABLE", DUPLICATE_PNL_SNAPSHOT_DETAIL));
    }
    this.#pnlSnapshotKeys.add(key);
    this.pnlSnapshots.push(snapshot);
    return await Promise.resolve(portOk(null));
  }

  async close(): Promise<void> {
    this.#closed = true;
    return await Promise.resolve();
  }
}
