/**
 * The PostgreSQL binding for {@link TraderStore} — §4.2's durable boundary and
 * the persistence binding `WP-200` reserved for a composition root.
 *
 * > "So these packages ship **pure transaction/projection logic and typed
 * > records**, and the composition root binds them to the tables. The record
 * > fields mirror the WP-040 columns field-for-field in camelCase … so a
 * > composition root binds an `AppendedLedgerTransaction` with no mapping
 * > layer."
 *   — `docs/handoffs/WP-200.md`, *Persistence boundary*
 *
 * This module is that binding. It contains no accounting rule, no validation
 * that a package already performed, and no arithmetic: it moves already-valid
 * records into the tables `WP-040` shipped, and turns every failure into port
 * DATA so §4.2's "a PostgreSQL outage stops new trading decisions" is a halt
 * the loop can act on rather than an exception it cannot.
 *
 * ## NO POSTGRESQL WAS REACHED (disclosed)
 *
 * Docker is absent from the development environment this package was built in,
 * exactly as `WP-210` recorded for its own migration work ("NO PostgreSQL was
 * reached… NO integration evidence is claimed"). This binding is therefore
 * **typecheck-pinned only**: the column names and types come from
 * `packages/storage-postgres`'s shipped table types and its
 * `createLedgerRepository`, so a rename upstream fails `pnpm typecheck` — but
 * nothing here has been executed against a live database, and no integration
 * evidence is claimed for it. `apps/trader`'s acceptance evidence for §4.2's
 * PostgreSQL boundary is at the PORT, with failure injection
 * (`test/integration/paper-trader/acceptance-4-infrastructure-halts.test.ts`),
 * which is the `WP-120` precedent for the same class of claim.
 *
 * ## `strategy.decisions` has no repository, and that is not an omission here
 *
 * `packages/storage-postgres` ships a `strategy` repository for definitions,
 * configs, instances and runs, but no writer for `strategy.decisions` — the
 * table exists in the schema types and in `db/migrations/0004_strategy.up.sql`.
 * Writing it through the typed builder is exactly the "composition root binds
 * them to the tables" arrangement `WP-200` describes, so the insert is here.
 * Whether that writer should move into `packages/storage-postgres` is recorded
 * as a follow-up rather than decided by this package.
 */

import { createHash } from "node:crypto";

import type {
  DecisionRecord,
  DecisionTelemetry,
  StrategyStateCheckpoint,
} from "@polymarket-bot/strategy-runtime";
import type { AppendedLedgerTransaction } from "@polymarket-bot/ledger";
import { toPnlSnapshotRow, type PnlSnapshot } from "@polymarket-bot/pnl";
import {
  createLedgerRepository,
  type PolymarketBotDatabase,
} from "@polymarket-bot/storage-postgres";

import {
  portFailed,
  portOk,
  type PortResult,
  type TraderStore,
} from "../ports.js";

export interface PostgresTraderStoreOptions {
  readonly db: PolymarketBotDatabase;
  /** The §10.3 `definitions.decision_contract_version` this run pins. */
  readonly decisionContractVersion: number;
}

export class PostgresTraderStore implements TraderStore {
  readonly #db: PolymarketBotDatabase;
  readonly #ledger: ReturnType<typeof createLedgerRepository>;
  readonly #decisionContractVersion: number;

  constructor(options: PostgresTraderStoreOptions) {
    this.#db = options.db;
    this.#ledger = createLedgerRepository(options.db);
    this.#decisionContractVersion = options.decisionContractVersion;
  }

  /**
   * §6 invariant 3's persisted decision.
   *
   * The `(run_id, evaluation_seq)` unique constraint is what makes "exactly
   * one" enforceable at the database rather than only in the runtime — a
   * duplicate is a constraint violation, which arrives here as a failure the
   * loop halts on rather than as a second row.
   */
  async persistDecision(
    record: DecisionRecord,
    telemetry: DecisionTelemetry,
  ): Promise<PortResult<null>> {
    return await this.#contained("persist a decision", async () => {
      await this.#db
        .insertInto("strategy.decisions")
        .values({
          run_id: record.runId,
          instance_id: record.instanceId,
          market_id: record.marketId,
          evaluation_seq: String(record.evaluationSeq),
          callback: record.callback,
          decision_type: record.decision.decisionType,
          decision_contract_version: this.#decisionContractVersion,
          reason_codes: [...record.decision.reasonCodes],
          feature_snapshot_ref: record.decision.featureSnapshotRef,
          feature_snapshot_id: null,
          model_outputs: (record.decision.modelOutputs ?? null) as never,
          state_patch: (record.decision.statePatch ?? null) as never,
          next_wakeup_at: record.decision.nextWakeupAt ?? null,
          source_event_id: record.sourceEvent?.eventId ?? null,
          gateway_epoch: record.sourceEvent?.gatewayEpoch ?? null,
          ingest_seq: record.sourceEvent?.ingestSeq ?? null,
          intent_count: record.decision.intents.length,
          evaluation_duration_us:
            telemetry.evaluationDurationUs === null
              ? null
              : String(telemetry.evaluationDurationUs),
          evaluated_at: record.evaluatedAt,
        })
        .execute();
    });
  }

  /**
   * §9.6's checkpoint after every persisted decision.
   *
   * `state` is stored as the runtime's OWN CANONICAL BYTES rather than as a
   * re-serialized object: `stateJson` is what the runtime hashed, checkpointed
   * and would restore from, and `JsonInput` admits a string precisely so a
   * caller can store bytes it already has. Re-parsing and re-serializing would
   * put a second serializer between §6 invariant 8's rebuild and the row.
   *
   * `state_hash` is SHA-256 of those same bytes. `node:crypto` is used
   * directly: `apps/trader` is layer 3, which
   * `docs/contracts/dependency-direction.md` §2.2 leaves outside F17's
   * enumerated built-in allowlist.
   */
  async saveCheckpoint(
    checkpoint: StrategyStateCheckpoint,
    capturedAt: string,
  ): Promise<PortResult<null>> {
    return await this.#contained("save a strategy checkpoint", async () => {
      await this.#db
        .insertInto("strategy.state_checkpoints")
        .values({
          run_id: checkpoint.runId,
          instance_id: checkpoint.instanceId,
          market_id: null,
          checkpoint_seq: String(checkpoint.checkpointSeq),
          state_schema_version: checkpoint.stateSchemaVersion,
          state: checkpoint.stateJson,
          state_hash: createHash("sha256").update(checkpoint.stateJson, "utf8").digest("hex"),
          captured_at: capturedAt,
        })
        .execute();
    });
  }

  /**
   * §9.15's append-only posting, through `WP-040`'s own repository.
   *
   * The repository — not a hand-written insert — because it writes the header
   * and every entry inside ONE database transaction, so the per-asset zero-sum
   * constraint answers this call rather than a later one.
   */
  async appendLedgerTransaction(
    appended: AppendedLedgerTransaction,
  ): Promise<PortResult<null>> {
    return await this.#contained("append a ledger transaction", async () => {
      const transaction = appended.transaction;
      const entries = transaction.entries.map((entry) => ({
        scope: entry.scope,
        accountRef: entry.accountRef,
        assetId: entry.assetId,
        assetKind: entry.assetKind,
        amount: entry.amount,
        instanceId: entry.instanceId ?? null,
        runId: entry.runId ?? null,
        marketId: entry.marketId ?? null,
        detail: entry.detail ?? null,
      }));
      const header = {
        eventType: transaction.eventType,
        environment: transaction.environment,
        accountRef: transaction.accountRef,
        source: transaction.source,
        occurredAt: transaction.occurredAt,
        entries,
        settlementState: transaction.settlementState ?? null,
        referenceHash: transaction.referenceHash ?? null,
        detail: transaction.detail ?? null,
      };
      // `WP-040` F16, expressed in the input TYPE: a transaction naming an order
      // or a fill must name its market, so the two shapes are distinguished
      // here rather than merged and hoped over.
      if (transaction.marketId !== undefined) {
        await this.#ledger.postTransaction({
          ...header,
          marketId: transaction.marketId,
          orderId: transaction.orderId ?? null,
          fillId: transaction.fillId ?? null,
        });
        return;
      }
      await this.#ledger.postTransaction({ ...header, marketId: null, orderId: null, fillId: null });
    });
  }

  /** §9.16's snapshot row, bound by `packages/pnl`'s own total binding. */
  async writePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>> {
    return await this.#contained("write a PnL snapshot", async () => {
      const row = toPnlSnapshotRow(snapshot);
      await this.#db
        .insertInto("accounting.pnl_snapshots")
        .values(row as never)
        .execute();
    });
  }

  async close(): Promise<void> {
    try {
      await this.#db.destroy();
    } catch {
      // Best-effort: the process is stopping either way.
    }
  }

  /**
   * Turns a database throw into port DATA.
   *
   * §4.2 makes a PostgreSQL outage a trading halt, and a halt controller cannot
   * act on an exception it never sees. Every failure is `UNAVAILABLE` rather
   * than being classified further: from the loop's position the distinction
   * between "the server is down" and "the constraint refused" does not change
   * the response — no decision may be made until an operator has looked — and a
   * finer classification here would be a guess dressed as a diagnosis. The
   * driver's own message travels with it.
   */
  async #contained(what: string, run: () => Promise<void>): Promise<PortResult<null>> {
    try {
      await run();
      return portOk(null);
    } catch (cause) {
      return portFailed(
        "UNAVAILABLE",
        `the durable store could not ${what}: ` +
          (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)),
      );
    }
  }
}
