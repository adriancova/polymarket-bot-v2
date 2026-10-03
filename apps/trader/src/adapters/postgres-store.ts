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
 * ## WHAT HAS AND HAS NOT REACHED A DATABASE (disclosed)
 *
 * This module was written where Docker was absent and was therefore shipped
 * **typecheck-pinned only** — and `GOV-2B` measured what that was worth. The
 * one method whose binding the compiler could not check, because a cast
 * disabled it, was the one that was wrong: `writePnlSnapshot` inserted
 * camelCase keys into snake_case columns and would have GLOBAL-halted the
 * assembled trader on its first fill (blocker **B1**; the whole story is on
 * that method). Two lessons are recorded here rather than relearned:
 * a typecheck pin is only as strong as the weakest cast under it, and an
 * in-memory double cannot reject a column name.
 *
 * `writePnlSnapshot` is executed against a real PostgreSQL —
 * `test/integration/paper-trader/durable-pnl-snapshot-postgres.test.ts`
 * (`TRDR-2`) inserts through this class and reads every column back from a
 * Testcontainers database — **into a database a TEST FIXTURE seeded**. That
 * file establishes the column binding and NOT the assembled trader's survival,
 * for the reason set out on {@link PostgresTraderStore.writePnlSnapshot} and in
 * that file's own header: this table's three foreign keys need rows in
 * `strategy.instances`, `strategy.runs` and `catalog.markets`.
 *
 * **All four methods now have a round trip through the ASSEMBLED trader**
 * (`BOOT-1`, `test/integration/paper-trader/durable-trader-first-fill-postgres.test.ts`):
 * the process's own startup path against a migrated database whose market,
 * instance and run were registered through `WP-040`'s repositories, one
 * decision and one fill, and every row read back. The sentence this header
 * used to carry — "**The other three methods still have no such evidence**:
 * `persistDecision`, `saveCheckpoint` and `appendLedgerTransaction` remain
 * typecheck-pinned" — is superseded by that file. What it found on the way is
 * recorded on {@link PostgresTraderStore.appendLedgerTransaction}: the durable
 * ledger header cannot yet carry its fill link. `apps/trader`'s acceptance
 * evidence for §4.2's halt BEHAVIOUR remains at the PORT, with failure
 * injection (`test/integration/paper-trader/acceptance-4-infrastructure-halts.test.ts`),
 * which is the `WP-120` precedent for that class of claim — evidence about the
 * loop's response to a failure, never about whether a statement is valid SQL.
 * Only a database answers that, and now one does for each statement here.
 * `replacePnlSnapshot` (`SNAP-1` r1), the fifth method, has its round trip
 * through the assembled trader too: the shared-instant test of
 * `test/integration/paper-trader/durable-two-level-entry-postgres-redis.test.ts`
 * (one UPDATE on the key; the row keeps its id; a missing identity refused).
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
  encodeJsonbText,
  LEDGER_SCOPES,
  RUN_MODES,
  type LedgerScopeValue,
  type PolymarketBotDatabase,
  type RunModeValue,
} from "@polymarket-bot/storage-postgres";

import { TRADER_RUN_MODE, unreplacedPnlSnapshotProblem } from "@polymarket-bot/trading-core";
import {
  portFailed,
  portOk,
  type GroupCommit,
  type PortResult,
  type RiskRefusalRecord,
  type StagedEvaluations,
  type TraderStore,
} from "@polymarket-bot/trading-core";

import type { HaltIncidentRow, HaltRecordOutcome } from "../halt-record.js";

/**
 * Narrows `scope` from the row's `string` to the column's enumeration.
 *
 * `packages/pnl`'s `PnlSnapshotRow` types `scope` as `string`; the column is
 * `internal.ledger_scope`, whose TypeScript mirror is a union of the six
 * literals. The narrowing is done by SEARCHING the shipped list rather than by
 * asserting the type, so the compiler proves the result belongs to the column's
 * union rather than being told to believe it — a `as LedgerScopeValue` here
 * would be the same class of suppressed check that `GOV-2B` B1 was.
 *
 * A value outside the list is a value PostgreSQL's enum would reject, so this
 * refuses it identically — by throwing into {@link PostgresTraderStore.#contained},
 * which turns it into the same `UNAVAILABLE` port data the driver's rejection
 * would have produced, one step earlier and naming the field.
 */
function toLedgerScope(value: string): LedgerScopeValue {
  const scope = LEDGER_SCOPES.find((candidate) => candidate === value);
  if (scope === undefined) {
    throw new Error(
      `pnl_snapshots.scope: ${JSON.stringify(value)} is not one of ` +
        `${LEDGER_SCOPES.join(", ")} (internal.ledger_scope)`,
    );
  }
  return scope;
}

/** As {@link toLedgerScope}, for `environment` and `internal.run_mode`. */
function toRunMode(value: string): RunModeValue {
  const mode = RUN_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new Error(
      `pnl_snapshots.environment: ${JSON.stringify(value)} is not one of ` +
        `${RUN_MODES.join(", ")} (internal.run_mode)`,
    );
  }
  return mode;
}

export interface PostgresTraderStoreOptions {
  readonly db: PolymarketBotDatabase;
  /** The §10.3 `definitions.decision_contract_version` this run pins. */
  readonly decisionContractVersion: number;
  /**
   * `PROVENANCE-1`: the account the run books against, written as
   * `ops.risk_events.account_ref` (the configuration's
   * `accounting.accountRef`). Absent: `NULL`.
   */
  readonly accountRef?: string;
}

/**
 * `PROVENANCE-1`: `ops.risk_events.check_code` of a §9.8 pre-trade refusal.
 * The risk engine evaluates its twenty checks as ONE gate and answers each
 * failing one by a reason code from its own vocabulary
 * (`@polymarket-bot/risk` `RISK_REASON_CODES`, grouped there by check). So the
 * gate is the check, and the row's `reason_code` names which of the twenty
 * refused — no check-number mapping is invented here.
 */
export const PRE_TRADE_RISK_CHECK_CODE = "PRE_TRADE_RISK";

/** `internal.detail` is bounded at 2000 characters (`db/migrations/0001_foundation.up.sql`). */
export const DETAIL_MAX_CHARACTERS = 2000;

/**
 * A text bounded to {@link DETAIL_MAX_CHARACTERS} characters (code points, as
 * PostgreSQL counts them), with a marker saying how much was cut, so a long
 * cause chain is shortened, never refused by the column's CHECK. The full
 * text is in the process's own log line.
 */
export function boundedDetail(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= DETAIL_MAX_CHARACTERS) return text;
  const marker = ` … [${String(characters.length)} characters; truncated to fit internal.detail]`;
  return characters.slice(0, DETAIL_MAX_CHARACTERS - Array.from(marker).length).join("") + marker;
}

/**
 * `PROVENANCE-1` — the `ops.risk_events` rows of one refused intent: ONE ROW
 * PER REFUSAL the check answered, in its order, each a `VETOED` §9.8 event.
 * The ONE binding both {@link PostgresTraderStore.persistRiskRefusal} and the
 * group commit insert.
 *
 * - `run_id`, `instance_id`, `market_id` are the decision's (the startup
 *   registration check verified all three rows exist, `BOOT-1`);
 * - `intent_id` is `NULL`: it is a foreign key into `strategy.intents`, which
 *   this process does not write (the same reason the ledger header's fill link
 *   is `NULL`; see {@link PostgresTraderStore.appendLedgerTransaction}). The
 *   strategy's own intent id is in `measures`;
 * - `measures` carries the decision's `evaluationSeq`, the intent id, the
 *   protective-exit flag, every reason code of the evaluation and the
 *   decision's dispatch position — strings and booleans only, bound as TEXT
 *   (`encodeJsonbText`, the `SER-2` rule);
 * - `occurred_at` is the evaluation's instant, the decision's `evaluated_at`.
 *
 * `ops.risk_events` is append-only (`internal.enforce_append_only`): the rows
 * are only ever inserted.
 */
/** One `ops.risk_events` row as this adapter binds it (`db/migrations/0007_ops.up.sql`). */
export interface RiskEventRow {
  readonly environment: typeof TRADER_RUN_MODE;
  readonly account_ref: string | null;
  readonly run_id: string;
  readonly instance_id: string;
  readonly market_id: string;
  readonly intent_id: null;
  readonly check_code: typeof PRE_TRADE_RISK_CHECK_CODE;
  readonly outcome: "VETOED";
  readonly reason_code: string;
  readonly measures: string;
  readonly detail: string;
  readonly occurred_at: string;
}

export function riskEventRows(refusal: RiskRefusalRecord, accountRef: string | null): RiskEventRow[] {
  const measures = encodeJsonbText(
    {
      evaluationSeq: String(refusal.evaluationSeq),
      intentId: refusal.intentId,
      protectiveExit: refusal.protectiveExit,
      reasonCodes: refusal.refusals.map((entry) => entry.code),
      sourceEventId: refusal.sourceEvent?.eventId ?? null,
      gatewayEpoch: refusal.sourceEvent?.gatewayEpoch ?? null,
      ingestSeq: refusal.sourceEvent?.ingestSeq ?? null,
    },
    "risk_events.measures",
  );
  return refusal.refusals.map((entry): RiskEventRow => ({
    environment: TRADER_RUN_MODE,
    account_ref: accountRef,
    run_id: refusal.runId,
    instance_id: refusal.instanceId,
    market_id: refusal.marketId,
    intent_id: null,
    check_code: PRE_TRADE_RISK_CHECK_CODE,
    outcome: "VETOED",
    reason_code: entry.code,
    measures,
    detail: boundedDetail(entry.message),
    occurred_at: refusal.occurredAt,
  }));
}

/**
 * The `strategy.decisions` row of one persisted decision — the ONE binding
 * both {@link PostgresTraderStore.persistDecision} and the group commit
 * ({@link PostgresGroupCommit}) insert, so the two paths cannot bind a column
 * differently. Throws what `encodeJsonbText` throws for a document it refuses.
 */
function decisionRow(record: DecisionRecord, telemetry: DecisionTelemetry, decisionContractVersion: number) {
  const modelOutputs = encodeJsonbText(record.decision.modelOutputs ?? null, "decisions.model_outputs");
  const statePatch = encodeJsonbText(record.decision.statePatch ?? null, "decisions.state_patch");
  return {
    run_id: record.runId,
    instance_id: record.instanceId,
    market_id: record.marketId,
    evaluation_seq: String(record.evaluationSeq),
    callback: record.callback,
    decision_type: record.decision.decisionType,
    decision_contract_version: decisionContractVersion,
    reason_codes: [...record.decision.reasonCodes],
    feature_snapshot_ref: record.decision.featureSnapshotRef,
    // `PROVENANCE-1`: NULL on purpose. The column is a foreign key into
    // `data.feature_snapshot_index`, which nothing in this repository writes
    // (its `feature_set_id` needs a `data.feature_sets` row, its
    // `content_hash` the archived snapshot bytes, and neither is produced).
    // The decision's feature snapshot is named by `feature_snapshot_ref`, the
    // engine's own content address, which a replay of the same events
    // re-derives (§12.4). An id here would point at no row.
    feature_snapshot_id: null,
    model_outputs: modelOutputs,
    state_patch: statePatch,
    next_wakeup_at: record.decision.nextWakeupAt ?? null,
    source_event_id: record.sourceEvent?.eventId ?? null,
    // `PROVENANCE-1`: the loop now supplies both (`#buildEvaluationInput`),
    // from the triggering envelope's own §7.1 fields; NULL only for an
    // evaluation the loop originates (`onFill`, `onOrderUpdate`).
    gateway_epoch: record.sourceEvent?.gatewayEpoch ?? null,
    ingest_seq: record.sourceEvent?.ingestSeq ?? null,
    intent_count: record.decision.intents.length,
    evaluation_duration_us:
      telemetry.evaluationDurationUs === null ? null : String(telemetry.evaluationDurationUs),
    evaluated_at: record.evaluatedAt,
  };
}

/** The `strategy.state_checkpoints` row of one checkpoint — shared the same way as {@link decisionRow}. */
function checkpointRow(checkpoint: StrategyStateCheckpoint, capturedAt: string) {
  return {
    run_id: checkpoint.runId,
    instance_id: checkpoint.instanceId,
    market_id: null,
    checkpoint_seq: String(checkpoint.checkpointSeq),
    state_schema_version: checkpoint.stateSchemaVersion,
    state: checkpoint.stateJson,
    state_hash: createHash("sha256").update(checkpoint.stateJson, "utf8").digest("hex"),
    captured_at: capturedAt,
  };
}

/**
 * Rows per statement: 1,000 rows of at most 19 bind parameters each is far
 * below PostgreSQL's 65,535. A batch is at most 128 stagings (the loop's hard
 * bound, `GROUP_COMMIT_MAX_EVENTS`; one staging per venue frame since ADR-024,
 * `TP2-R1-M2`), and a staging's evaluations write one decision and one
 * checkpoint each, so a batch fits one statement unless a frame evaluates
 * unusually many callbacks — which the transaction path below still handles.
 */
const GROUP_COMMIT_ROWS_PER_STATEMENT = 1_000;

/**
 * `THROUGHPUT-1a` — the store's GROUP COMMIT ({@link GroupCommit}).
 *
 * `stage` builds each event's rows with {@link decisionRow} /
 * {@link checkpointRow} — the values the per-row methods bind — and keeps
 * them in memory. `commit` inserts every staged decision and every staged
 * checkpoint, in stage order, ATOMICALLY, and answers only once PostgreSQL
 * has committed them:
 *
 * - normally as ONE statement — a multi-row insert of the decisions in a
 *   data-modifying CTE, feeding a multi-row insert of the checkpoints — which
 *   is one implicit transaction and ONE round trip (PostgreSQL runs every
 *   data-modifying `WITH` member to completion whether or not its output is
 *   read);
 * - a batch of only decisions, or only checkpoints, as one multi-row insert;
 * - a batch past {@link GROUP_COMMIT_ROWS_PER_STATEMENT} rows as chunked
 *   inserts inside one explicit transaction (`db.transaction()`).
 *
 * A failure rolls the whole batch back and is answered as `UNAVAILABLE` port
 * data, as `#contained` answers every other failure. The staged rows are
 * released either way.
 *
 * WHAT THIS CHANGES AND WHAT IT DOES NOT. Every row, every column value and
 * the `(run_id, evaluation_seq)` / `(run_id, checkpoint_seq)` uniqueness are
 * exactly the per-row path's. What changes is WHEN they become durable: at the
 * batch's commit (`loop.ts` states the bounds) instead of at each insert, in
 * one commit per batch instead of two per decision — which H1 run 1 measured
 * as the store's whole cost (~1.2 ms per autocommit on its host). The
 * database-assigned columns follow: `recorded_at` is `now()`, the batch
 * statement's (or transaction's) start, for every row of a batch.
 */
export class PostgresGroupCommit implements GroupCommit {
  readonly #db: PolymarketBotDatabase;
  readonly #decisionContractVersion: number;
  readonly #accountRef: string | null;
  #decisions: ReturnType<typeof decisionRow>[] = [];
  #checkpoints: ReturnType<typeof checkpointRow>[] = [];
  /** `PROVENANCE-1`: the staged `ops.risk_events` rows ({@link riskEventRows}). */
  #riskEvents: ReturnType<typeof riskEventRows> = [];
  #events = 0;

  constructor(db: PolymarketBotDatabase, decisionContractVersion: number, accountRef: string | null = null) {
    this.#db = db;
    this.#decisionContractVersion = decisionContractVersion;
    this.#accountRef = accountRef;
  }

  get stagedEvents(): number {
    return this.#events;
  }

  stage(evaluations: StagedEvaluations): PortResult<null> {
    let decisions: ReturnType<typeof decisionRow>[];
    let checkpoints: ReturnType<typeof checkpointRow>[];
    let riskEvents: ReturnType<typeof riskEventRows>;
    try {
      decisions = evaluations.decisions.map((entry) =>
        decisionRow(entry.record, entry.telemetry, this.#decisionContractVersion),
      );
      checkpoints = evaluations.checkpoints.map((entry) => checkpointRow(entry.checkpoint, entry.capturedAt));
      riskEvents = evaluations.riskRefusals.flatMap((refusal) => riskEventRows(refusal, this.#accountRef));
    } catch (cause) {
      return portFailed(
        "UNAVAILABLE",
        `the durable store could not stage a decision, checkpoint or risk refusal: ${describeCause(cause)}`,
      );
    }
    this.#decisions.push(...decisions);
    this.#checkpoints.push(...checkpoints);
    this.#riskEvents.push(...riskEvents);
    // One per `stage` call — one per frame the loop flushes (`TP2-R1-M2`).
    this.#events += 1;
    return portOk(null);
  }

  async commit(): Promise<PortResult<{ readonly decisions: number; readonly checkpoints: number }>> {
    const decisions = this.#decisions;
    const checkpoints = this.#checkpoints;
    const riskEvents = this.#riskEvents;
    const events = this.#events;
    this.#decisions = [];
    this.#checkpoints = [];
    this.#riskEvents = [];
    this.#events = 0;
    if (decisions.length === 0 && checkpoints.length === 0 && riskEvents.length === 0) {
      return portOk({ decisions: 0, checkpoints: 0 });
    }
    try {
      if (riskEvents.length > 0) {
        // `PROVENANCE-1`: a batch that carries refusals. A batch WITHOUT them
        // takes exactly the statements below, unchanged.
        await this.#commitWithRiskEvents(decisions, checkpoints, riskEvents);
      } else if (
        decisions.length > 0 &&
        checkpoints.length > 0 &&
        decisions.length + checkpoints.length <= GROUP_COMMIT_ROWS_PER_STATEMENT
      ) {
        // ONE statement — a data-modifying CTE — so ONE implicit transaction
        // and ONE round trip: both inserts commit together or not at all, and
        // the database does the batch's work while the loop keeps evaluating
        // (a multi-statement transaction would need four round trips, and the
        // loop reads a reply only when it yields).
        await this.#db
          .with("staged_decisions", (db) =>
            db.insertInto("strategy.decisions").values(decisions).returning("decision_id"),
          )
          .insertInto("strategy.state_checkpoints")
          .values(checkpoints)
          .execute();
      } else if (checkpoints.length === 0 && decisions.length <= GROUP_COMMIT_ROWS_PER_STATEMENT) {
        await this.#db.insertInto("strategy.decisions").values(decisions).execute();
      } else if (decisions.length === 0 && checkpoints.length <= GROUP_COMMIT_ROWS_PER_STATEMENT) {
        await this.#db.insertInto("strategy.state_checkpoints").values(checkpoints).execute();
      } else {
        // A batch too large for one statement's parameters: one transaction.
        await this.#db.transaction().execute(async (trx) => {
          for (let start = 0; start < decisions.length; start += GROUP_COMMIT_ROWS_PER_STATEMENT) {
            await trx
              .insertInto("strategy.decisions")
              .values(decisions.slice(start, start + GROUP_COMMIT_ROWS_PER_STATEMENT))
              .execute();
          }
          for (let start = 0; start < checkpoints.length; start += GROUP_COMMIT_ROWS_PER_STATEMENT) {
            await trx
              .insertInto("strategy.state_checkpoints")
              .values(checkpoints.slice(start, start + GROUP_COMMIT_ROWS_PER_STATEMENT))
              .execute();
          }
        });
      }
    } catch (cause) {
      return portFailed(
        "UNAVAILABLE",
        `the durable store could not commit a batch of ${String(decisions.length)} decision(s), ` +
          `${String(checkpoints.length)} checkpoint(s) and ${String(riskEvents.length)} risk event(s) ` +
          `from ${String(events)} event(s); nothing of it was committed: ${describeCause(cause)}`,
      );
    }
    return portOk({ decisions: decisions.length, checkpoints: checkpoints.length });
  }

  /**
   * `PROVENANCE-1` — a batch with `ops.risk_events` rows, still ATOMIC: within
   * {@link GROUP_COMMIT_ROWS_PER_STATEMENT} rows, ONE statement (the other
   * tables' inserts as data-modifying `WITH` members, which PostgreSQL runs to
   * completion), otherwise chunked inserts inside one explicit transaction.
   * Either way every row of the batch commits together or not at all.
   */
  async #commitWithRiskEvents(
    decisions: ReturnType<typeof decisionRow>[],
    checkpoints: ReturnType<typeof checkpointRow>[],
    riskEvents: ReturnType<typeof riskEventRows>,
  ): Promise<void> {
    if (decisions.length + checkpoints.length + riskEvents.length <= GROUP_COMMIT_ROWS_PER_STATEMENT) {
      if (decisions.length > 0 && checkpoints.length > 0) {
        await this.#db
          .with("staged_decisions", (db) => db.insertInto("strategy.decisions").values(decisions).returning("decision_id"))
          .with("staged_risk_events", (db) =>
            db.insertInto("ops.risk_events").values(riskEvents).returning("risk_event_id"),
          )
          .insertInto("strategy.state_checkpoints")
          .values(checkpoints)
          .execute();
      } else if (decisions.length > 0) {
        await this.#db
          .with("staged_decisions", (db) => db.insertInto("strategy.decisions").values(decisions).returning("decision_id"))
          .insertInto("ops.risk_events")
          .values(riskEvents)
          .execute();
      } else if (checkpoints.length > 0) {
        await this.#db
          .with("staged_risk_events", (db) =>
            db.insertInto("ops.risk_events").values(riskEvents).returning("risk_event_id"),
          )
          .insertInto("strategy.state_checkpoints")
          .values(checkpoints)
          .execute();
      } else {
        await this.#db.insertInto("ops.risk_events").values(riskEvents).execute();
      }
      return;
    }
    await this.#db.transaction().execute(async (trx) => {
      for (let start = 0; start < decisions.length; start += GROUP_COMMIT_ROWS_PER_STATEMENT) {
        await trx
          .insertInto("strategy.decisions")
          .values(decisions.slice(start, start + GROUP_COMMIT_ROWS_PER_STATEMENT))
          .execute();
      }
      for (let start = 0; start < checkpoints.length; start += GROUP_COMMIT_ROWS_PER_STATEMENT) {
        await trx
          .insertInto("strategy.state_checkpoints")
          .values(checkpoints.slice(start, start + GROUP_COMMIT_ROWS_PER_STATEMENT))
          .execute();
      }
      for (let start = 0; start < riskEvents.length; start += GROUP_COMMIT_ROWS_PER_STATEMENT) {
        await trx
          .insertInto("ops.risk_events")
          .values(riskEvents.slice(start, start + GROUP_COMMIT_ROWS_PER_STATEMENT))
          .execute();
      }
    });
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

export class PostgresTraderStore implements TraderStore {
  readonly #db: PolymarketBotDatabase;
  readonly #ledger: ReturnType<typeof createLedgerRepository>;
  readonly #decisionContractVersion: number;
  readonly #accountRef: string | null;
  /** `THROUGHPUT-1a`: the store's group commit (see {@link PostgresGroupCommit}). */
  readonly groupCommit: PostgresGroupCommit;

  constructor(options: PostgresTraderStoreOptions) {
    this.#db = options.db;
    this.#ledger = createLedgerRepository(options.db);
    this.#decisionContractVersion = options.decisionContractVersion;
    this.#accountRef = options.accountRef ?? null;
    this.groupCommit = new PostgresGroupCommit(options.db, options.decisionContractVersion, this.#accountRef);
  }

  /**
   * `PROVENANCE-1`: one refused intent's `ops.risk_events` rows
   * ({@link riskEventRows}), in ONE multi-row insert. The per-row path; the
   * group commit stages the same rows with the event's others.
   */
  async persistRiskRefusal(refusal: RiskRefusalRecord): Promise<PortResult<null>> {
    return await this.#contained("persist a risk refusal", async () => {
      await this.#db.insertInto("ops.risk_events").values(riskEventRows(refusal, this.#accountRef)).execute();
    });
  }

  /**
   * `PROVENANCE-1` — writes a halt's `ops.incidents` rows
   * (`halt-record.ts`, `haltIncidentRows`) in one transaction, and answers
   * within `deadlineMs` whatever the database does. NEVER throws, and never
   * holds the caller past the bound: the process exits after this whether or
   * not the rows were written (fail closed — the halt is already latched and
   * nothing trades; the record is what an operator and the research worker
   * read afterwards).
   *
   * Two bounds, because a database can fail two ways:
   *
   * - one that ANSWERS slowly (a lock, an overloaded server): the transaction
   *   first sets its own `statement_timeout` to `deadlineMs`
   *   (`set_config(..., true)`, local to this transaction), so the SERVER
   *   cancels the insert at the bound and releases the connection — the
   *   store's close then does not wait on it;
   * - one that does NOT ANSWER (down, refused, partitioned): the call is raced
   *   against a timer of `deadlineMs` (unreferenced, so it never keeps the
   *   process alive). A refused or reset connection fails at once.
   *
   * An answer after the bound is not reported as written: the outcome is
   * `unconfirmed`, and says the rows may or may not exist.
   */
  async recordHalts(rows: readonly HaltIncidentRow[], deadlineMs: number): Promise<HaltRecordOutcome> {
    if (rows.length === 0) return { status: "written", rows: 0 };
    const write = (async (): Promise<HaltRecordOutcome> => {
      try {
        await this.#db.transaction().execute(async (trx) => {
          await trx
            .selectNoFrom((eb) =>
              eb.fn<string>("set_config", [eb.val("statement_timeout"), eb.val(String(deadlineMs)), eb.val(true)]).as("bound"),
            )
            .execute();
          await trx.insertInto("ops.incidents").values([...rows]).execute();
        });
        return { status: "written", rows: rows.length };
      } catch (cause) {
        return { status: "failed", detail: describeCause(cause) };
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<HaltRecordOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          status: "unconfirmed",
          detail:
            `the database did not answer within ${String(deadlineMs)} ms; the halt's rows may or may ` +
            "not have been written",
        });
      }, deadlineMs);
      timer.unref();
    });
    try {
      return await Promise.race([write, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * §6 invariant 3's persisted decision.
   *
   * The `(run_id, evaluation_seq)` unique constraint is what makes "exactly
   * one" enforceable at the database rather than only in the runtime — a
   * duplicate is a constraint violation, which arrives here as a failure the
   * loop halts on rather than as a second row.
   *
   * `model_outputs` and `state_patch` are bound as TEXT — the documents' own
   * bytes from `packages/storage-postgres`'s `encodeJsonbText` (the own-data
   * encoder of `@polymarket-bot/risk/plain-json`), `null` staying `null` — so
   * `pg` never serializes an object through the prototype chain. The
   * repository rule is one sentence: every `jsonb` write hands `pg` text
   * (`packages/storage-postgres/src/json.ts`, `SER-2`). The runtime's
   * materializer emits null-prototype objects, whose arrays keep
   * `Array.prototype`; the encoder reads own data only, so neither is
   * consulted for a `toJSON`. A document the encoder refuses is the storage
   * package's typed error, which `#contained` turns into `UNAVAILABLE` like
   * every other failure here.
   */
  async persistDecision(
    record: DecisionRecord,
    telemetry: DecisionTelemetry,
  ): Promise<PortResult<null>> {
    return await this.#contained("persist a decision", async () => {
      await this.#db
        .insertInto("strategy.decisions")
        .values(decisionRow(record, telemetry, this.#decisionContractVersion))
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
        .values(checkpointRow(checkpoint, capturedAt))
        .execute();
    });
  }

  /**
   * §9.15's append-only posting, through `WP-040`'s own repository.
   *
   * The repository — not a hand-written insert — because it writes the header
   * and every entry inside ONE database transaction, so the per-asset zero-sum
   * constraint answers this call rather than a later one.
   *
   * ## The execution link is bound NULL, and why (`BOOT-1`, measured)
   *
   * This method used to forward `transaction.fillId` and `transaction.orderId`
   * into the header. `accounting.ledger_transactions.fill_id` is a foreign key
   * into `execution.fills` (and `order_id` into `execution.orders`), and this
   * process writes NEITHER table — nor `strategy.intents`,
   * `strategy.approved_intents`, `execution.plans` or `execution.groups`, the
   * chain those rows require (`execution.fills.order_id` and
   * `execution.orders.plan_id` are NOT NULL). The fill identity the postings
   * carry is `DeterministicIdFactory`'s (`accounting.ts`), a value no row holds.
   * So the first time the ASSEMBLED trader reached a fill against a real
   * database — the moment `BOOT-1`'s registration check let it past its first
   * decision — this call answered
   *
   * ```text
   * STORE_UNAVAILABLE: the ledger transaction could not be persisted: … violates
   *   foreign key constraint "ledger_transactions_fill_id_fkey"
   * ```
   *
   * and `loop.ts` GLOBAL-halted, one write later than B9. A durable transaction
   * cannot name a fill row that does not exist, so the header carries NULL for
   * both links until the execution chain is persisted — which is its own round
   * (the "trader read path" `GOV-2B` names as R10), not something to half-do
   * from an accounting adapter.
   *
   * **What this SEVERS, said plainly (`BOOT-1` r1, review R5).** This is a
   * severing disclosed as a binding, not a cosmetic NULL.
   * `packages/ledger/src/fill-posting.ts` puts the fill identity NOWHERE but
   * the header's `fillId` (the `shared` header at `:278-286`; no entry
   * `detail`, no `referenceHash` carries it), so once it is dropped here the
   * durable transactions of ONE fill — principal, token, and fee when charged
   * — share only `occurred_at`, `market_id`, `account_ref` and `environment`.
   * Two fills at one instant in one market are indistinguishable in the
   * durable ledger, and §6 invariant 8's rebuild FROM THE DURABLE ROWS cannot
   * reproduce per-fill economics (cost basis per lot, per-fill fees, the
   * `TraceLink` chain) until the execution chain lands and this binding gets
   * its link back. What is NOT lost: per-asset balances and per-instance
   * attribution — every entry still names its `instance_id`, `run_id` and
   * `market_id`, the header its `market_id` — and the in-memory ledger (§6
   * invariant 8's in-process authority) and `CoreLoop.traces()` still carry
   * `ledgerFillId` and the transaction ids. The durable row is honest about
   * what the durable schema holds: no fill.
   *
   * WHAT THE TESTS PIN, precisely. The first round said the NULL pin "fails
   * the day the chain lands"; it did not — `fill_id IS NULL` measures THIS
   * adapter's binding, and would stay green with a persisted chain and a
   * stale binding. `durable-trader-first-fill-postgres.test.ts` therefore pins
   * BOTH: `fill_id`/`order_id` NULL on every durable transaction (the
   * binding), AND `execution.fills` EMPTY after the fill (the chain's
   * absence). The second is what fails when a round persists fills; that
   * failure is the instruction to delete the NULL binding above.
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
        // The execution link, NULL on purpose — see the method doc. NOT
        // `transaction.orderId ?? null` / `transaction.fillId ?? null`: those
        // name rows this process never writes.
        orderId: null,
        fillId: null,
      };
      // `WP-040` F16, expressed in the input TYPE: a market-bound transaction
      // and a standalone one are distinguished here rather than merged and
      // hoped over — the fill postings are market-bound, and their `market_id`
      // is a foreign key `BOOT-1`'s registration check has already verified.
      if (transaction.marketId !== undefined) {
        await this.#ledger.postTransaction({ ...header, marketId: transaction.marketId });
        return;
      }
      await this.#ledger.postTransaction({ ...header, marketId: null });
    });
  }

  /**
   * §9.16's snapshot row — bound COLUMN BY COLUMN, with no cast, so the
   * compiler checks the binding.
   *
   * ## What was here before, and why it could not work (`GOV-2B` B1, `TRDR-2`)
   *
   * This method used to hand `toPnlSnapshotRow`'s record to the builder behind
   * `.values(row as never)`. That record is `packages/pnl`'s camelCase mirror
   * of the columns (`accountRef`, `grossTradingPnl`, `asOf`, …); the table is
   * snake_case (`packages/storage-postgres/src/schema/accounting.ts`,
   * `db/migrations/0006_accounting.up.sql`), and `createDatabase` registers no
   * `CamelCasePlugin` (`packages/storage-postgres/src/database.ts`). Kysely
   * quotes the keys it is given, so the emitted SQL was
   *
   * ```sql
   * insert into "accounting"."pnl_snapshots"
   *   ("scope", "environment", "accountRef", "instanceId", … , "asOf")
   *   values ($1, … , $20)
   * ```
   *
   * — eighteen of the twenty identifiers naming columns that do not exist.
   * PostgreSQL answers `column "accountRef" of relation "pnl_snapshots" does
   * not exist`; `#contained` turns that into `UNAVAILABLE`; `loop.ts:1523-1530`
   * escalates it to a GLOBAL `STORE_UNAVAILABLE` halt, and `loop.ts:1421` runs
   * this after EVERY fill — so the assembled durable trader halted on its
   * first fill. **The `as never` is what suppressed the compile error that
   * would have caught it**: the two sibling inserts above write explicit
   * snake_case and need no cast, and now so does this one. The escalation is
   * NOT the defect and is unchanged: a store failure SHOULD halt the loop.
   *
   * The twenty fields below are the whole of `PnlSnapshotRow`, and the columns
   * they name are every column of the table except the three the DATABASE owns
   * — `pnl_snapshot_id` (`default internal.uuid_generate_v7()`), `computed_at`
   * (`default now()`) and `rebuilt_at` (nullable, set by a rebuild and never by
   * a computation) — which is why the row deliberately carries none of them and
   * why none is named here. The mapping is the one pinned at
   * `test/unit/ledger/wp040-persistence-shape.test.ts:265-284`; with the cast
   * gone, `pnpm typecheck` now fails here if a column is renamed, retyped,
   * added as REQUIRED, or dropped.
   *
   * The row — not `snapshot` — is the source of every value, because
   * `toPnlSnapshotRow` is the WP-200-FU1 own-data read: it takes each field
   * from an own DATA property and returns a prototype-free record, so no value
   * bound below can have been answered by `Object.prototype` or produced by a
   * caller's getter.
   *
   * ## What the compiler still does NOT check here (`TRDR-2` r1, review R7)
   *
   * The pin is real and it is NARROW. Two gaps, so that it is not over-read:
   *
   * 1. **The column DOMAINS are invisible to it.** `fees_paid`,
   *    `reward_estimate_total`, `realized_rewards` and `capital_committed` are
   *    `internal.non_negative_decimal_string`; `instance_id`, `run_id` and
   *    `market_id` are `internal.uuid_v7`, whose CHECK constraints demand the
   *    version nibble `7` and a variant nibble in `8/9/a/b`; `account_ref` and
   *    `denomination_asset` are `internal.identifier`, bounded at 200
   *    characters (`db/migrations/0001_foundation.up.sql`). In TypeScript every
   *    one of those is `string` — `DecimalString` is an ALIAS of `string`
   *    (`packages/decimal/src/canonical.ts:59`) — so a NEGATIVE fee, a
   *    non-version-7 uuid or a 201-character account reference typechecks
   *    perfectly, reaches the database, and comes back as a runtime
   *    `UNAVAILABLE` that `loop.ts:1523-1530` escalates to a GLOBAL halt. The
   *    compiler checks the SHAPE of this statement; only PostgreSQL checks its
   *    VALUES. The upstream refusals in `packages/pnl` are what keep those
   *    values canonical, not anything written here.
   * 2. **A MISSING column is not always a compile error.** Kysely makes a
   *    nullable or defaulted column OPTIONAL on insert, so deleting
   *    `instance_id`, `run_id`, `market_id`, `unrealized_pnl_model`,
   *    `unrealized_pnl_liquidation` or `worst_case_resolution_pnl` from the
   *    object below would compile and write silent NULLs into a monetary row.
   *    What forbids that is the TESTS — the emitted statement's column set in
   *    `test/unit/trader/pnl-snapshot-column-binding.test.ts` and the read-back
   *    of every column in
   *    `test/integration/paper-trader/durable-pnl-snapshot-postgres.test.ts` —
   *    and they are load-bearing for exactly this reason.
   *
   * ## What the round trip proves, and what it does not (review R1; `BOOT-1`)
   *
   * The Testcontainers file above inserts through THIS class and reads every
   * column back, so the binding is established against the real schema. It does
   * NOT establish that the assembled trader survives. This table's `instance_id`,
   * `run_id` and `market_id` are foreign keys into `strategy.instances`,
   * `strategy.runs` and `catalog.markets`, and the rows satisfying them are
   * created by `createTradingChain`, a `@polymarket-bot/storage-postgres/testing`
   * FIXTURE. This doc used to continue: "**No code in `apps/trader` creates
   * those rows** … The missing piece is a BOOTSTRAP path that registers the
   * market, the instance and the run; it is a separate closeout blocker and is
   * deliberately not invented here." That blocker (B9) is closed by `BOOT-1`,
   * and STILL no code in `apps/trader` creates those rows — by decision, not
   * omission: `adapters/postgres-registration.ts` VERIFIES at startup that the
   * rows the configuration names exist and agree with it, and the process
   * refuses to start otherwise, for the per-table reasons set out there. The
   * assembled trader's survival through its first decision and first fill is
   * established by `durable-trader-first-fill-postgres.test.ts`, which runs the
   * process's own startup path against rows registered through `WP-040`'s
   * repositories and reads this table back. (The earlier sentence "nothing else
   * in the app writes SQL at all" was also too strong — `TRDR-2` review R9 —
   * since `appendLedgerTransaction` causes SQL through `WP-040`'s ledger
   * repository; the conclusion it served is unchanged.)
   */
  async writePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>> {
    return await this.#contained("write a PnL snapshot", async () => {
      const row = toPnlSnapshotRow(snapshot);
      await this.#db
        .insertInto("accounting.pnl_snapshots")
        .values({
          scope: toLedgerScope(row.scope),
          environment: toRunMode(row.environment),
          account_ref: row.accountRef,
          instance_id: row.instanceId,
          run_id: row.runId,
          market_id: row.marketId,
          denomination_asset: row.denominationAsset,
          gross_trading_pnl: row.grossTradingPnl,
          core_net_pnl: row.coreNetPnl,
          all_in_pnl: row.allInPnl,
          realized_pnl: row.realizedPnl,
          unrealized_pnl_midpoint: row.unrealizedPnlMidpoint,
          unrealized_pnl_model: row.unrealizedPnlModel,
          unrealized_pnl_liquidation: row.unrealizedPnlLiquidation,
          worst_case_resolution_pnl: row.worstCaseResolutionPnl,
          fees_paid: row.feesPaid,
          reward_estimate_total: row.rewardEstimateTotal,
          realized_rewards: row.realizedRewards,
          capital_committed: row.capitalCommitted,
          as_of: row.asOf,
        })
        .execute();
    });
  }

  /**
   * `SNAP-1` r1: rewrites the ONE existing `accounting.pnl_snapshots` row of
   * the snapshot's `pnl_snapshots_scope_unique` identity — (scope,
   * environment, account_ref, instance_id, market_id, as_of), `nulls not
   * distinct` — with the snapshot's values.
   *
   * WHY IT EXISTS. The loop writes one row per instance per instant, holding
   * the state after the LAST fill booked at that instant (the user's ruling,
   * 2026-09-28), and writes it before the harvest's deliveries (§4.2's
   * MEDIUM-1 gate). When a LATER harvest books more fills at an instant whose
   * row this process already inserted — two events with one `receivedAt` — the
   * row must move to the later state, and an INSERT cannot do that. The table
   * is the "rebuildable reporting projection" (`0006_accounting.up.sql`; no
   * `internal.enforce_append_only`, and `AccountingPnlSnapshotsTable` is not an
   * `AppendOnlyTable`), so an UPDATE is legal without a migration.
   *
   * WHAT IT IS NOT. Not an upsert and not a skip: {@link writePnlSnapshot}
   * still REFUSES a duplicate identity, and this still REFUSES a missing one —
   * `numUpdatedRows` must be exactly `1`, otherwise it throws
   * `unreplacedPnlSnapshotProblem` into {@link #contained}, which answers
   * `UNAVAILABLE` like every other failure here. The adapter never decides
   * between the two; the loop does, for an identity it inserted itself.
   *
   * THE STATEMENT. The fourteen bound columns outside the key are SET — the
   * same values, from the same `toPnlSnapshotRow`, an insert of this snapshot
   * would bind — and the six key columns are the WHERE (`is null` for an
   * absent instance or market: `nulls not distinct`). The three columns the
   * database owns (`pnl_snapshot_id`, `computed_at`, `rebuilt_at`) are not
   * touched, so the row keeps its id and its first `computed_at`. Pinned by
   * `test/unit/trader/pnl-snapshot-replace-binding.test.ts` (the emitted SQL)
   * and executed against a real PostgreSQL by
   * `test/integration/paper-trader/durable-two-level-entry-postgres-redis.test.ts`.
   */
  async replacePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>> {
    return await this.#contained("replace a PnL snapshot", async () => {
      const row = toPnlSnapshotRow(snapshot);
      let statement = this.#db
        .updateTable("accounting.pnl_snapshots")
        .set({
          run_id: row.runId,
          denomination_asset: row.denominationAsset,
          gross_trading_pnl: row.grossTradingPnl,
          core_net_pnl: row.coreNetPnl,
          all_in_pnl: row.allInPnl,
          realized_pnl: row.realizedPnl,
          unrealized_pnl_midpoint: row.unrealizedPnlMidpoint,
          unrealized_pnl_model: row.unrealizedPnlModel,
          unrealized_pnl_liquidation: row.unrealizedPnlLiquidation,
          worst_case_resolution_pnl: row.worstCaseResolutionPnl,
          fees_paid: row.feesPaid,
          reward_estimate_total: row.rewardEstimateTotal,
          realized_rewards: row.realizedRewards,
          capital_committed: row.capitalCommitted,
        })
        .where("scope", "=", toLedgerScope(row.scope))
        .where("environment", "=", toRunMode(row.environment))
        .where("account_ref", "=", row.accountRef);
      statement =
        row.instanceId === null
          ? statement.where("instance_id", "is", null)
          : statement.where("instance_id", "=", row.instanceId);
      statement =
        row.marketId === null
          ? statement.where("market_id", "is", null)
          : statement.where("market_id", "=", row.marketId);
      const result = await statement.where("as_of", "=", row.asOf).executeTakeFirst();
      const matched = result.numUpdatedRows;
      if (matched !== 1n) throw new Error(unreplacedPnlSnapshotProblem(matched));
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
