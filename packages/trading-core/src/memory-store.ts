/**
 * The PRODUCTION in-memory {@link TraderStore} (`BACKTEST-2`).
 *
 * A backtest's durable output is its artefact, not a database, so the
 * backtest executable builds the core over this store rather than over
 * `apps/trader`'s PostgreSQL adapter. It is NOT the test double
 * `MemoryTraderStore` (`testing/index.ts`), whose module header restricts it
 * to tests ("for the trader's INFRASTRUCTURE PORTS — and for nothing else")
 * and which carries failure injection a shipped process must not have.
 *
 * ## What it keeps, and the one rule it enforces
 *
 * It records every write in order and publishes each list read-only, so a
 * backtest's artefact reads what reached the store rather than what the loop
 * believes it wrote. It enforces the ONE rule the real table enforces that
 * the loop depends on: `accounting.pnl_snapshots`' identity constraint
 * `pnl_snapshots_scope_unique` (`SNAP-1`). The identity is computed by the
 * shared `pnl-snapshot-key.ts` — the same function the loop and the test
 * double read, never a copy — so the three cannot disagree on what "one row
 * per instance per instant" means:
 *
 * - {@link InMemoryTraderStore.writePnlSnapshot} REFUSES a second row of an
 *   identity it already holds, and records nothing, as the database inserts
 *   nothing;
 * - {@link InMemoryTraderStore.replacePnlSnapshot} rewrites the one recorded
 *   row of an identity IN PLACE (the same position, as a database row keeps
 *   its id), and REFUSES — never inserts — when there is none.
 *
 * Both refusals are `UNAVAILABLE`, the kind `PostgresTraderStore` answers for
 * the same two failures, so the loop latches the same `STORE_UNAVAILABLE` halt
 * whichever store it runs over. The details say which store refused and why,
 * in this store's own words: it is not a database and does not claim a
 * driver's error text.
 *
 * ## After `close`
 *
 * Every write after {@link InMemoryTraderStore.close} is refused
 * (`UNAVAILABLE`), because a store that kept accepting writes after its owner
 * closed it would record a run's tail nobody will read. What was recorded
 * stays readable.
 *
 * NO DOCKER, NO NETWORK, NO CREDENTIAL, NO FILE. Nothing here opens a socket,
 * reads a file or reads a clock.
 */

import type { AppendedLedgerTransaction } from "@polymarket-bot/ledger";
import type { PnlSnapshot } from "@polymarket-bot/pnl";
import type {
  DecisionRecord,
  DecisionTelemetry,
  StrategyStateCheckpoint,
} from "@polymarket-bot/strategy-runtime";

import {
  PNL_SNAPSHOT_SCOPE_UNIQUE,
  pnlSnapshotKey,
  unreplacedPnlSnapshotProblem,
} from "./pnl-snapshot-key.js";
import {
  portFailed,
  portOk,
  type PortResult,
  type RiskRefusalRecord,
  type TraderStore,
} from "./ports.js";

/** The refusal for a second row of one `pnl_snapshots_scope_unique` identity. */
export const IN_MEMORY_DUPLICATE_PNL_SNAPSHOT_DETAIL =
  "the in-memory trader store could not write a PnL snapshot: a row of its " +
  `${PNL_SNAPSHOT_SCOPE_UNIQUE} identity is already recorded, and the constraint admits one`;

/** The refusal for a replacement that finds no row of its identity. */
export const IN_MEMORY_MISSING_PNL_SNAPSHOT_DETAIL =
  `the in-memory trader store could not replace a PnL snapshot: ${unreplacedPnlSnapshotProblem(0n)}`;

/** The refusal for any write after {@link InMemoryTraderStore.close}. */
export const IN_MEMORY_STORE_CLOSED_DETAIL =
  "the in-memory trader store is closed and records no further write";

/** One persisted decision, with the telemetry it was persisted with. */
export interface RecordedDecision {
  readonly record: DecisionRecord;
  readonly telemetry: DecisionTelemetry;
}

/** The production in-memory store. See the module header. */
export class InMemoryTraderStore implements TraderStore {
  readonly #decisions: RecordedDecision[] = [];
  readonly #checkpoints: StrategyStateCheckpoint[] = [];
  readonly #checkpointInstants: string[] = [];
  readonly #transactions: AppendedLedgerTransaction[] = [];
  readonly #pnlSnapshots: PnlSnapshot[] = [];
  readonly #riskRefusals: RiskRefusalRecord[] = [];
  /** `pnl_snapshots_scope_unique` identity → position in {@link #pnlSnapshots}. */
  readonly #pnlSnapshotPositions = new Map<string, number>();
  #pnlSnapshotReplacements = 0;
  #closed = false;

  /** Every persisted decision, in write order. */
  get decisions(): readonly RecordedDecision[] {
    return this.#decisions;
  }

  /** Every saved checkpoint, in write order. */
  get checkpoints(): readonly StrategyStateCheckpoint[] {
    return this.#checkpoints;
  }

  /** The instant each checkpoint was captured at, in the same order. */
  get checkpointInstants(): readonly string[] {
    return this.#checkpointInstants;
  }

  /** Every appended ledger transaction, in write order. */
  get transactions(): readonly AppendedLedgerTransaction[] {
    return this.#transactions;
  }

  /**
   * Every recorded PnL snapshot: ONE per `pnl_snapshots_scope_unique`
   * identity, in first-write order, each holding its latest content — what
   * the table would hold.
   */
  get pnlSnapshots(): readonly PnlSnapshot[] {
    return this.#pnlSnapshots;
  }

  /** `PROVENANCE-1`: every recorded risk refusal, in write order. */
  get riskRefusals(): readonly RiskRefusalRecord[] {
    return this.#riskRefusals;
  }

  /** How many replacements rewrote a row. */
  get pnlSnapshotReplacements(): number {
    return this.#pnlSnapshotReplacements;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async persistDecision(
    record: DecisionRecord,
    telemetry: DecisionTelemetry,
  ): Promise<PortResult<null>> {
    if (this.#closed) return await Promise.resolve(closedRefusal());
    this.#decisions.push({ record, telemetry });
    return await Promise.resolve(portOk(null));
  }

  /** `PROVENANCE-1`: records one refused intent. */
  async persistRiskRefusal(refusal: RiskRefusalRecord): Promise<PortResult<null>> {
    if (this.#closed) return await Promise.resolve(closedRefusal());
    this.#riskRefusals.push(refusal);
    return await Promise.resolve(portOk(null));
  }

  async saveCheckpoint(
    checkpoint: StrategyStateCheckpoint,
    capturedAt: string,
  ): Promise<PortResult<null>> {
    if (this.#closed) return await Promise.resolve(closedRefusal());
    this.#checkpoints.push(checkpoint);
    this.#checkpointInstants.push(capturedAt);
    return await Promise.resolve(portOk(null));
  }

  async appendLedgerTransaction(
    transaction: AppendedLedgerTransaction,
  ): Promise<PortResult<null>> {
    if (this.#closed) return await Promise.resolve(closedRefusal());
    this.#transactions.push(transaction);
    return await Promise.resolve(portOk(null));
  }

  /**
   * Records one snapshot, or refuses a second row of its
   * `pnl_snapshots_scope_unique` identity and records nothing.
   */
  async writePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>> {
    if (this.#closed) return await Promise.resolve(closedRefusal());
    const key = pnlSnapshotKey(snapshot);
    if (this.#pnlSnapshotPositions.has(key)) {
      return await Promise.resolve(
        portFailed<null>("UNAVAILABLE", IN_MEMORY_DUPLICATE_PNL_SNAPSHOT_DETAIL),
      );
    }
    this.#pnlSnapshotPositions.set(key, this.#pnlSnapshots.length);
    this.#pnlSnapshots.push(snapshot);
    return await Promise.resolve(portOk(null));
  }

  /**
   * Rewrites the one recorded snapshot of this snapshot's identity in place,
   * or refuses — never inserts — when none is recorded.
   */
  async replacePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>> {
    if (this.#closed) return await Promise.resolve(closedRefusal());
    const position = this.#pnlSnapshotPositions.get(pnlSnapshotKey(snapshot));
    if (position === undefined) {
      return await Promise.resolve(
        portFailed<null>("UNAVAILABLE", IN_MEMORY_MISSING_PNL_SNAPSHOT_DETAIL),
      );
    }
    this.#pnlSnapshots[position] = snapshot;
    this.#pnlSnapshotReplacements += 1;
    return await Promise.resolve(portOk(null));
  }

  async close(): Promise<void> {
    this.#closed = true;
    return await Promise.resolve();
  }
}

function closedRefusal(): PortResult<null> {
  return portFailed<null>("UNAVAILABLE", IN_MEMORY_STORE_CLOSED_DETAIL);
}
