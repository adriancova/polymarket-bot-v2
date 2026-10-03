/**
 * `CKPT-1` — ADR-027 Decision 3 on a REAL PostgreSQL: a decision that changes
 * the state, the status or the RNG is durable together with its checkpoint, or
 * not at all; and a restore built from the database resumes from the last
 * checkpoint and the highest durable `evaluation_seq`. This closes `DURABLE-1`
 * LOW-3 ("in group mode a decision and its checkpoint can commit in separate
 * transactions").
 *
 * ## The crash
 *
 * The fixture's six recorded events: an entry that fills, then its take-profit
 * exit. The process "dies" right after the database has made the ENTRY
 * decision — the first decision that carries an intent — durable: every store
 * write after that one never resolves, so nothing after it reaches PostgreSQL,
 * exactly as if the process had been killed there. The entry decision moved
 * the strategy state (ARMED → ENTRY_PLANNED), so ADR-027 Decision 1 owes it a
 * checkpoint.
 *
 * - Until `CKPT-1` the durability boundary before a placement made the decision
 *   durable ALONE — in group mode in its own commit, per row in its own
 *   autocommit — and its checkpoint followed in a LATER write. The crash came
 *   between the two: PostgreSQL held the entry decision and not its checkpoint,
 *   and a restore from the last checkpoint would have resumed from the ARMED
 *   state the durable entry had already left. Both arms below FAIL on that
 *   code (measured on `ebed242`; see the round's handoff).
 * - Now the decision and the checkpoint it owes are ONE write: the same
 *   staging of the group commit (one transaction), or, per row,
 *   `PostgresTraderStore.persistDecisionWithCheckpoint` (one statement).
 *
 * A third case puts the failure INSIDE PostgreSQL: a trigger refuses the entry
 * decision's checkpoint row, and the decision must not land without it — the
 * store's own one-transaction write (the group commit's batch; per row, one
 * statement) is what is under test there.
 *
 * What is asserted, from the database alone, after the crash and in a control
 * run with no crash:
 *
 * - the durable checkpoints are EXACTLY the ones an independent ADR-027 oracle
 *   (`support/checkpoints.ts`) derives from the durable decision rows — every
 *   durable decision that changed the state has its checkpoint, at its own
 *   sequence, holding the fold of the durable `state_patch` values;
 * - a restore point read from the rows (the last checkpoint, the highest
 *   `evaluation_seq`, the checkpointed decision's `evaluated_at`) is accepted
 *   by the runtime, resumes at the highest sequence plus one, and holds the
 *   fold of EVERY durable patch: it does not resume older than a durable
 *   decision that changed the state.
 *
 * Two arms: GROUP COMMIT (the real `PostgresGroupCommit`) and PER-ROW (the same
 * `PostgresTraderStore` handed to the trader without its group commit).
 *
 * What the database does not hold: `strategy.state_checkpoints` stores the
 * state bytes, not the checkpoint's RNG lanes or status (a pre-existing binding
 * of `apps/trader`'s adapter; `CKPT-1` reports it). The restore below supplies
 * the run seed's fresh lanes — Static Bracket draws no randomness — and ACTIVE.
 *
 * Docker: Testcontainers, its own `beforeAll`, as this suite's other container
 * files. Throwaway credentials; PAPER only; no venue, no signer.
 */

import { createDatabase, createPostgresPool } from "@polymarket-bot/storage-postgres";
import { startPostgresContainer, type TestContext } from "@polymarket-bot/storage-postgres/testing";
import {
  canonicalJsonStringify,
  DeterministicRng,
  restoreFromPoint,
  STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
  type DecisionRecord,
  type DecisionTelemetry,
  type StrategyStateCheckpoint,
} from "@polymarket-bot/strategy-runtime";
import { staticBracketStrategy } from "@polymarket-bot/strategy-static-bracket";
import type { GroupCommit, PortResult, RiskRefusalRecord, StagedEvaluations, TraderStore } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresTraderStore } from "../../../apps/trader/src/adapters/postgres-store.js";
import { owedCheckpoints } from "./support/checkpoints.js";
import { assemble, recordedEvents } from "./support/fixture.js";
import {
  CONDITION_ID,
  documentFor,
  RUN_SEED,
  registerThroughTheRepositories,
  withFreshDatabase,
  type Registered,
} from "./support/registration.js";

let container: Awaited<ReturnType<typeof startPostgresContainer>>;

beforeAll(async () => {
  container = await startPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/**
 * The real `PostgresTraderStore` behind a gate that can "kill the process": once
 * `crashAfterEntry` is set and the first write carrying an intent-bearing
 * decision has landed in PostgreSQL, every later write never resolves.
 *
 * It also forwards the lone `saveCheckpoint` write the trader made before
 * `CKPT-1`, to the inner store if it has one, so this file can be replayed
 * against that code — where both crash cases must fail.
 */
class GatedStore {
  readonly #inner: PostgresTraderStore;
  readonly #crashAfterEntry: boolean;
  crashed = false;
  readonly groupCommit: GroupCommit | undefined;

  constructor(inner: PostgresTraderStore, options: { readonly grouped: boolean; readonly crashAfterEntry: boolean }) {
    this.#inner = inner;
    this.#crashAfterEntry = options.crashAfterEntry;
    this.groupCommit = options.grouped ? this.#gatedGroupCommit(inner.groupCommit) : undefined;
  }

  /** The port the trader is handed: the group commit only in the grouped arm. */
  asTraderStore(): TraderStore {
    const group = this.groupCommit;
    const port: TraderStore = {
      persistDecision: (record, telemetry) => this.persistDecision(record, telemetry),
      persistDecisionWithCheckpoint: (record, telemetry, checkpoint, capturedAt) =>
        this.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt),
      persistRiskRefusal: (refusal) => this.persistRiskRefusal(refusal),
      appendLedgerTransaction: (transaction) => this.appendLedgerTransaction(transaction),
      writePnlSnapshot: (snapshot) => this.writePnlSnapshot(snapshot),
      replacePnlSnapshot: (snapshot) => this.replacePnlSnapshot(snapshot),
      close: () => this.close(),
      ...(group === undefined ? {} : { groupCommit: group }),
    };
    // Only the pre-`CKPT-1` loop reads this (see the class comment).
    return Object.assign(port, {
      saveCheckpoint: (checkpoint: StrategyStateCheckpoint, capturedAt: string) => this.saveCheckpoint(checkpoint, capturedAt),
    });
  }

  #gatedGroupCommit(real: GroupCommit): GroupCommit {
    let stagedEntry = false;
    return {
      stage: (evaluations: StagedEvaluations) => {
        const staged = real.stage(evaluations);
        if (staged.ok && evaluations.decisions.some((entry) => entry.record.decision.intents.length > 0)) {
          stagedEntry = true;
        }
        return staged;
      },
      get stagedEvents() {
        return real.stagedEvents;
      },
      commit: async () => {
        if (this.crashed) return await never<Awaited<ReturnType<GroupCommit["commit"]>>>();
        const carriesEntry = stagedEntry;
        stagedEntry = false;
        const committed = await real.commit();
        if (this.#crashAfterEntry && carriesEntry && committed.ok) this.crashed = true;
        return committed;
      },
    };
  }

  async #write<T>(write: () => Promise<PortResult<T>>, landsEntry: boolean): Promise<PortResult<T>> {
    if (this.crashed) return await never<PortResult<T>>();
    const written = await write();
    if (this.#crashAfterEntry && landsEntry && written.ok) this.crashed = true;
    return written;
  }

  async persistDecision(record: DecisionRecord, telemetry: DecisionTelemetry): Promise<PortResult<null>> {
    return await this.#write(() => this.#inner.persistDecision(record, telemetry), record.decision.intents.length > 0);
  }

  async persistDecisionWithCheckpoint(
    record: DecisionRecord,
    telemetry: DecisionTelemetry,
    checkpoint: StrategyStateCheckpoint,
    capturedAt: string,
  ): Promise<PortResult<null>> {
    return await this.#write(
      () => this.#inner.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt),
      record.decision.intents.length > 0,
    );
  }

  /** Only the pre-`CKPT-1` loop calls this; see the class comment. */
  async saveCheckpoint(checkpoint: StrategyStateCheckpoint, capturedAt: string): Promise<PortResult<null>> {
    const legacy = (this.#inner as unknown as {
      readonly saveCheckpoint?: (checkpoint: StrategyStateCheckpoint, capturedAt: string) => Promise<PortResult<null>>;
    }).saveCheckpoint;
    if (legacy === undefined) throw new Error("this store writes a checkpoint only with its decision (CKPT-1)");
    return await this.#write(() => legacy.call(this.#inner, checkpoint, capturedAt), false);
  }

  async persistRiskRefusal(refusal: RiskRefusalRecord): Promise<PortResult<null>> {
    return await this.#write(() => this.#inner.persistRiskRefusal(refusal), false);
  }

  async appendLedgerTransaction(transaction: Parameters<TraderStore["appendLedgerTransaction"]>[0]): Promise<PortResult<null>> {
    return await this.#write(() => this.#inner.appendLedgerTransaction(transaction), false);
  }

  async writePnlSnapshot(snapshot: Parameters<TraderStore["writePnlSnapshot"]>[0]): Promise<PortResult<null>> {
    return await this.#write(() => this.#inner.writePnlSnapshot(snapshot), false);
  }

  async replacePnlSnapshot(snapshot: Parameters<TraderStore["replacePnlSnapshot"]>[0]): Promise<PortResult<null>> {
    return await this.#write(() => this.#inner.replacePnlSnapshot(snapshot), false);
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

async function waitUntil(what: string, condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Drives the fixture's six events through the trader over `store`; stops at the crash, if armed. */
async function drive(label: string, registered: Registered, store: GatedStore, crashAfterEntry: boolean): Promise<void> {
  const { result } = assemble({ config: documentFor(registered, label), wrapStore: () => store.asTraderStore() });
  if (!result.ok) throw new Error(`the trader did not assemble: ${result.refusal.detail}`);
  expect(result.trader.loop.groupCommits).toBe(store.groupCommit !== undefined);
  for (const event of recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`)) {
    expect(result.trader.loop.ingest(event)).toBe(true);
  }
  const drained = result.trader.loop.drain();
  if (!crashAfterEntry) {
    await drained;
    expect(result.trader.halts.records()).toEqual([]);
    return;
  }
  // The process "dies" once the entry decision's write has landed; nothing it
  // would write after that reaches the database (every later write hangs).
  void drained;
  await waitUntil("the store to make the entry decision durable", () => store.crashed);
  // Let any write that was already in PostgreSQL's hands finish (there is none
  // by construction: the loop awaits each write); nothing new can start.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

interface DurableRows {
  readonly decisions: readonly {
    readonly instanceId: string;
    readonly evaluationSeq: number;
    readonly callback: string;
    readonly reasonCodes: readonly string[];
    readonly evaluatedAt: string;
    readonly statePatch: Readonly<Record<string, unknown>> | null;
    readonly intentCount: number;
  }[];
  readonly checkpoints: readonly {
    readonly instanceId: string;
    readonly checkpointSeq: number;
    readonly stateSchemaVersion: number;
    readonly state: unknown;
  }[];
  readonly configId: string;
  readonly runSeed: string;
}

/** What the database holds for the run, read on a connection of the test's own. */
async function durableRows(context: TestContext, registered: Registered): Promise<DurableRows> {
  const decisions = await context.pool.query<{
    instance_id: string;
    evaluation_seq: string;
    callback: string;
    reason_codes: string[];
    evaluated_at: string;
    state_patch: Record<string, unknown> | null;
    intent_count: number;
  }>(
    `select instance_id, evaluation_seq::text as evaluation_seq, callback::text as callback, reason_codes,
            to_char(evaluated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as evaluated_at,
            state_patch, intent_count
       from strategy.decisions where run_id = $1 order by evaluation_seq`,
    [registered.runId],
  );
  const checkpoints = await context.pool.query<{
    instance_id: string;
    checkpoint_seq: string;
    state_schema_version: number;
    state: unknown;
  }>(
    `select instance_id, checkpoint_seq::text as checkpoint_seq, state_schema_version, state
       from strategy.state_checkpoints where run_id = $1 order by checkpoint_seq`,
    [registered.runId],
  );
  const run = await context.pool.query<{ config_id: string; run_seed: string }>(
    "select config_id, run_seed from strategy.runs where run_id = $1",
    [registered.runId],
  );
  const runRow = run.rows[0];
  if (runRow === undefined) throw new Error("the run row is missing");
  return {
    decisions: decisions.rows.map((row) => ({
      instanceId: row.instance_id,
      evaluationSeq: Number(row.evaluation_seq),
      callback: row.callback,
      reasonCodes: row.reason_codes,
      evaluatedAt: row.evaluated_at,
      statePatch: row.state_patch,
      intentCount: row.intent_count,
    })),
    checkpoints: checkpoints.rows.map((row) => ({
      instanceId: row.instance_id,
      checkpointSeq: Number(row.checkpoint_seq),
      stateSchemaVersion: row.state_schema_version,
      state: row.state,
    })),
    configId: runRow.config_id,
    runSeed: runRow.run_seed,
  };
}

/**
 * ADR-027 D3, read off the database: every durable decision that owed a
 * checkpoint has it, holding the fold; and a restore point read from the rows
 * resumes at the highest sequence plus one, from the fold of EVERY durable
 * patch.
 */
function expectDurableTogether(
  rows: DurableRows,
  registered: Registered,
): { readonly next: number; readonly lastCheckpointSeq: number; readonly highest: number } | undefined {
  const owed = owedCheckpoints(
    rows.decisions.map((row) => ({
      instanceId: row.instanceId,
      evaluationSeq: row.evaluationSeq,
      callback: row.callback,
      attribution: row.reasonCodes.some((code) => code.startsWith("RUNTIME.")) ? "RUNTIME" : "STRATEGY",
      evaluatedAt: row.evaluatedAt,
      statePatch: row.statePatch,
    })),
  );
  expect(
    rows.checkpoints.map((row) => row.checkpointSeq),
    "the durable checkpoints are exactly those the durable decisions owe",
  ).toEqual(owed.map((entry) => entry.checkpointSeq));
  expect(rows.checkpoints.map((row) => canonicalJsonStringify(row.state))).toEqual(owed.map((entry) => entry.stateJson));

  // The restore point, from the rows (ADR-027 D2). Nothing durable (a group
  // commit whose first batch was refused whole) is a fresh run, not a restore.
  if (rows.decisions.length === 0) {
    expect(rows.checkpoints).toEqual([]);
    return undefined;
  }
  const last = rows.checkpoints.at(-1);
  const highest = rows.decisions.at(-1)?.evaluationSeq;
  if (last === undefined || highest === undefined) throw new Error("nothing durable to restore from");
  const anchor = rows.decisions.find((row) => row.evaluationSeq === last.checkpointSeq)?.evaluatedAt;
  const checkpoint: StrategyStateCheckpoint = {
    checkpointSchemaVersion: STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
    runId: registered.runId,
    instanceId: last.instanceId,
    strategyName: staticBracketStrategy.name,
    strategyVersion: staticBracketStrategy.version,
    stateSchemaVersion: last.stateSchemaVersion,
    configId: rows.configId,
    runSeed: rows.runSeed,
    checkpointSeq: last.checkpointSeq,
    // Not stored by the adapter (see the header): Static Bracket draws no
    // randomness, so the lanes are the seed's, and the run never paused.
    status: "ACTIVE",
    rngState: DeterministicRng.fromSeed(rows.runSeed).snapshot(),
    stateJson: canonicalJsonStringify(last.state),
  };
  const restored = restoreFromPoint(
    { checkpoint, highestEvaluationSeq: highest, checkpointEvaluatedAt: anchor ?? "" },
    {
      runId: registered.runId,
      instanceId: last.instanceId,
      strategyName: staticBracketStrategy.name,
      strategyVersion: staticBracketStrategy.version,
      stateSchemaVersion: staticBracketStrategy.stateSchemaVersion,
      configId: rows.configId,
      runSeed: rows.runSeed,
    },
  );
  expect(restored.ok, restored.ok ? "" : `${restored.refusal.code}: ${restored.refusal.detail}`).toBe(true);
  if (!restored.ok) return undefined;
  expect(restored.restored.nextEvaluationSeq).toBe(highest + 1);
  // It does not resume older than a durable decision that changed the state.
  expect(canonicalJsonStringify(restored.restored.state)).toBe(owed.at(-1)?.stateJson);
  return { next: restored.restored.nextEvaluationSeq, lastCheckpointSeq: last.checkpointSeq, highest };
}

/**
 * ADR-027 D2 on the database's own keys: the restored next sequence is held by
 * NEITHER `decisions_evaluation_unique` nor `state_checkpoints_seq_unique`, so
 * the restored runtime's first decision and checkpoint cannot collide.
 * Answers how many durable decisions hold the pre-`CKPT-1` rule's sequence,
 * `checkpointSeq + 1`.
 */
async function expectNextSequenceFree(
  context: TestContext,
  registered: Registered,
  restore: { readonly next: number; readonly lastCheckpointSeq: number },
): Promise<number> {
  const held = async (seq: number): Promise<{ decisions: number; checkpoints: number }> => {
    const { rows } = await context.pool.query<{ decisions: string; checkpoints: string }>(
      `select (select count(*) from strategy.decisions where run_id = $1 and evaluation_seq = $2)::text as decisions,
              (select count(*) from strategy.state_checkpoints where run_id = $1 and checkpoint_seq = $2)::text as checkpoints`,
      [registered.runId, seq],
    );
    return { decisions: Number(rows[0]?.decisions ?? "-1"), checkpoints: Number(rows[0]?.checkpoints ?? "-1") };
  };
  expect(await held(restore.next)).toEqual({ decisions: 0, checkpoints: 0 });
  return (await held(restore.lastCheckpointSeq + 1)).decisions;
}

/**
 * The test-only failure INSIDE PostgreSQL: a `BEFORE INSERT` trigger on
 * `strategy.state_checkpoints` refuses the checkpoint of the entry decision —
 * the first state whose `instanceState` left ARMED. It lives only in this
 * file's throwaway databases (no migration is touched).
 */
async function refuseTheEntryCheckpoint(context: TestContext): Promise<void> {
  await context.pool.query(
    `create function public.ckpt1_refuse_entry_checkpoint() returns trigger
       language plpgsql as $$
     begin
       raise exception 'CKPT-1: the database refuses the entry checkpoint (checkpoint_seq %)', new.checkpoint_seq;
     end
     $$`,
  );
  await context.pool.query(
    `create trigger ckpt1_refuse_entry_checkpoint
       before insert on strategy.state_checkpoints
       for each row when (new.state->>'instanceState' is distinct from 'ARMED')
       execute function public.ckpt1_refuse_entry_checkpoint()`,
  );
}

describe.each([
  { arm: "group commit (the real PostgresGroupCommit)", grouped: true },
  { arm: "per-row inserts", grouped: false },
])("ADR-027 D3 on a real PostgreSQL — $arm (CKPT-1, DURABLE-1 LOW-3)", ({ grouped }) => {
  it("PostgreSQL REFUSES the entry decision's checkpoint: the decision does not land without it — one transaction", async () => {
    await withFreshDatabase(container.getConnectionUri(), `ckpt1-refuse-${grouped ? "g" : "r"}`, async ({ connectionString, context }) => {
      const label = `refuse-${grouped ? "g" : "r"}`;
      const registered = await registerThroughTheRepositories(context, label);
      await refuseTheEntryCheckpoint(context);
      const inner = new PostgresTraderStore({
        db: createDatabase(createPostgresPool({ connectionString })),
        decisionContractVersion: 1,
      });
      const store = new GatedStore(inner, { grouped, crashAfterEntry: false });
      const { result } = assemble({ config: documentFor(registered, label), wrapStore: () => store.asTraderStore() });
      if (!result.ok) throw new Error(`the trader did not assemble: ${result.refusal.detail}`);
      for (const event of recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`)) {
        expect(result.trader.loop.ingest(event)).toBe(true);
      }
      await result.trader.loop.drain();
      await store.close();
      // The refusal is the store failure §4.2 halts on…
      const halts = result.trader.halts.records();
      expect(halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
      expect(halts[0]?.detail).toContain("CKPT-1: the database refuses the entry checkpoint");
      expect(result.trader.loop.health().execution.submissionsAccepted).toBe(0);
      // …and the entry decision did NOT become durable without the checkpoint
      // it owed: PostgreSQL rolled both back together.
      const rows = await durableRows(context, registered);
      expect(rows.decisions.filter((row) => row.intentCount > 0)).toEqual([]);
      expect(result.trader.loop.decisions().some((decision) => decision.intentIds.length > 0)).toBe(true);
      expectDurableTogether(rows, registered);
    });
  }, 180_000);

  it("a CRASH right after the entry decision became durable: its checkpoint is durable with it, and the rows restore", async () => {
    await withFreshDatabase(container.getConnectionUri(), `ckpt1-crash-${grouped ? "g" : "r"}`, async ({ connectionString, context }) => {
      const label = `crash-${grouped ? "g" : "r"}`;
      const registered = await registerThroughTheRepositories(context, label);
      expect(RUN_SEED.length).toBeGreaterThan(0);
      const inner = new PostgresTraderStore({
        db: createDatabase(createPostgresPool({ connectionString })),
        decisionContractVersion: 1,
      });
      const store = new GatedStore(inner, { grouped, crashAfterEntry: true });
      try {
        await drive(label, registered, store, true);
      } finally {
        // The "dead" process's writes hang in the gate and never reach the
        // pool, so its connections are idle and are released here.
        await inner.close();
      }
      const rows = await durableRows(context, registered);
      // The crash came after the entry decision, and nothing after it landed.
      const entry = rows.decisions.find((row) => row.intentCount > 0);
      expect(entry, "the entry decision is durable").toBeDefined();
      expect(rows.decisions.at(-1)?.evaluationSeq).toBe(entry?.evaluationSeq);
      // THE LOW-3 CASE: the entry moved the state, so it owed a checkpoint —
      // and the checkpoint is durable with it.
      expect(rows.checkpoints.map((row) => row.checkpointSeq)).toContain(entry?.evaluationSeq);
      const restore = expectDurableTogether(rows, registered);
      expect(restore).toBeDefined();
      if (restore !== undefined) await expectNextSequenceFree(context, registered, restore);
    });
  }, 180_000);

  it("CONTROL: the whole run, no crash — every owed checkpoint durable, fewer checkpoints than decisions, and the rows restore", async () => {
    await withFreshDatabase(container.getConnectionUri(), `ckpt1-control-${grouped ? "g" : "r"}`, async ({ connectionString, context }) => {
      const label = `control-${grouped ? "g" : "r"}`;
      const registered = await registerThroughTheRepositories(context, label);
      const inner = new PostgresTraderStore({
        db: createDatabase(createPostgresPool({ connectionString })),
        decisionContractVersion: 1,
      });
      const store = new GatedStore(inner, { grouped, crashAfterEntry: false });
      await drive(label, registered, store, false);
      await store.close();
      const rows = await durableRows(context, registered);
      expect(rows.decisions.filter((row) => row.intentCount > 0).length).toBe(2);
      expect(rows.checkpoints.length).toBeLessThan(rows.decisions.length);
      const restore = expectDurableTogether(rows, registered);
      expect(restore).toBeDefined();
      if (restore === undefined) return;
      // Decisions that owed no checkpoint are durable AFTER the last one…
      expect(restore.highest).toBeGreaterThan(restore.lastCheckpointSeq);
      // …so the restored next sequence is free in both keys, while the
      // pre-`CKPT-1` rule (`checkpointSeq + 1`) would re-use a durable
      // decision's sequence: `decisions_evaluation_unique` would refuse the
      // restored runtime's first decision.
      expect(await expectNextSequenceFree(context, registered, restore)).toBe(1);
    });
  }, 180_000);
});
