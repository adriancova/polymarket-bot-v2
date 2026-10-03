/**
 * `CADENCE-1` — migration 0010: the ADR-026 evaluation cadence, pinned in the
 * run record (`strategy.runs`), on real PostgreSQL.
 *
 * ADR-026 D1.3-D1.4: `evaluationIntervalMs` and `evaluationHeartbeatMs` are
 * pinned in the run record of every run, and a change to either starts a new
 * run. The record is the run's `strategy.runs` row; the grant (Q1,
 * 2026-10-03) fixed its shape:
 *
 * - two nullable integer columns, NULL meaning a run recorded under ADR-024;
 * - both NULL or both set; both >= 0; (interval = 0) = (heartbeat = 0);
 * - both added to `runs_immutable_pinning`.
 *
 * Pinned here: the columns and checks exist as database objects and refuse
 * what they must; `startRun` writes both values and they read back exactly; an
 * UPDATE of either is refused (`PMB02`); and the rollback of 0010 restores
 * exactly the 0009 schema of `strategy.runs` — columns, constraints and
 * trigger — proven by comparing the catalog before 0010, after 0010, after its
 * rollback and after it is applied again; a row recorded while the columns did
 * not exist reads NULL.
 */

import {
  createDatabase,
  createPostgresPool,
  createRepositories,
  migrateDown,
  migrateUp,
  readMigrations,
} from "@polymarket-bot/storage-postgres";
import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain } from "@polymarket-bot/storage-postgres/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useEmptyDatabase, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("runs_evaluation_cadence");
const getEmpty = useEmptyDatabase("runs_evaluation_cadence_rollback");

let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;

beforeAll(async () => {
  context = getContext();
  chain = await createTradingChain(context, { label: "cadence" });
});

const pools: { end: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(async (pool) => pool.end()));
});

/** Inserts a run row through SQL, with the cadence columns as given (`undefined` omits them); the refusal, or undefined. */
async function insertRun(cadence: { readonly interval?: number | null; readonly heartbeat?: number | null }): Promise<unknown> {
  const columns = ["instance_id", "definition_id", "config_id", "environment", "code_commit", "state_schema_version", "run_seed"];
  const values: unknown[] = [chain.instanceId, chain.definitionId, chain.configId, "PAPER", "cadence-1-test", 1, "7"];
  if (cadence.interval !== undefined) {
    columns.push("evaluation_interval_ms");
    values.push(cadence.interval);
  }
  if (cadence.heartbeat !== undefined) {
    columns.push("evaluation_heartbeat_ms");
    values.push(cadence.heartbeat);
  }
  try {
    await context.pool.query(
      `insert into strategy.runs (${columns.join(", ")}) values (${values.map((_, index) => `$${String(index + 1)}`).join(", ")})`,
      values,
    );
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("migration 0010: the evaluation cadence in strategy.runs", () => {
  it("adds two nullable integer columns", async () => {
    const columns = await context.pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'strategy' and table_name = 'runs'
          and column_name in ('evaluation_interval_ms', 'evaluation_heartbeat_ms')
        order by column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: "evaluation_heartbeat_ms", data_type: "integer", is_nullable: "YES" },
      { column_name: "evaluation_interval_ms", data_type: "integer", is_nullable: "YES" },
    ]);
  });

  it("startRun records both values, and they read back exactly", async () => {
    const row = await context.db
      .selectFrom("strategy.runs")
      .select(["evaluation_interval_ms", "evaluation_heartbeat_ms"])
      .where("run_id", "=", chain.runId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ evaluation_interval_ms: 1000, evaluation_heartbeat_ms: 5000 });

    const perFrame = await context.repositories.strategy.startRun({
      instanceId: chain.instanceId,
      definitionId: chain.definitionId,
      configId: chain.configId,
      environment: "PAPER",
      codeCommit: "cadence-1-test",
      stateSchemaVersion: 1,
      runSeed: "7",
      evaluationIntervalMs: 0,
      evaluationHeartbeatMs: 0,
    });
    const stored = await context.db
      .selectFrom("strategy.runs")
      .select(["evaluation_interval_ms", "evaluation_heartbeat_ms"])
      .where("run_id", "=", perFrame)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ evaluation_interval_ms: 0, evaluation_heartbeat_ms: 0 });
  });

  it("accepts both NULL (a run recorded under ADR-024), 1000/5000 and 0/0", async () => {
    for (const cadence of [{}, { interval: null, heartbeat: null }, { interval: 1000, heartbeat: 5000 }, { interval: 0, heartbeat: 0 }]) {
      expect(await insertRun(cadence), JSON.stringify(cadence)).toBeUndefined();
    }
  });

  it.each([
    ["one set, the other NULL", { interval: 1000, heartbeat: null }, "runs_evaluation_cadence_both_or_neither"],
    ["the other set, the one NULL", { interval: null, heartbeat: 5000 }, "runs_evaluation_cadence_both_or_neither"],
    ["only the interval given", { interval: 1000 }, "runs_evaluation_cadence_both_or_neither"],
    ["a negative interval", { interval: -1, heartbeat: 5000 }, "runs_evaluation_cadence_non_negative"],
    ["a negative heartbeat", { interval: 1000, heartbeat: -5000 }, "runs_evaluation_cadence_non_negative"],
    ["interval 0 with a heartbeat", { interval: 0, heartbeat: 5000 }, "runs_evaluation_cadence_per_frame_has_no_heartbeat"],
    ["a heartbeat 0 with an interval", { interval: 1000, heartbeat: 0 }, "runs_evaluation_cadence_per_frame_has_no_heartbeat"],
  ] as const)("refuses %s (%s)", async (_label, cadence, constraint) => {
    const error = (await insertRun(cadence)) as { code?: string; constraint?: string } | undefined;
    expect(error?.code).toBe("23514");
    expect(error?.constraint).toBe(constraint);
  });

  it("does not encode the PAPER policy: another non-negative pair is a valid ROW (the application refuses it)", async () => {
    expect(await insertRun({ interval: 2000, heartbeat: 10000 })).toBeUndefined();
  });

  it("both columns are immutable pins (runs_immutable_pinning, PMB02): a change starts a new run", async () => {
    for (const [column, value] of [
      ["evaluation_interval_ms", 2000],
      ["evaluation_heartbeat_ms", 10000],
    ] as const) {
      const error = (await captureRejection(async () =>
        context.pool.query(`update strategy.runs set ${column} = $1 where run_id = $2`, [value, chain.runId]),
      )) as { code?: string; message?: string } | undefined;
      expect(error?.code, column).toBe("PMB02");
      expect(error?.message).toContain(column);
    }
    // Through the typed builder too: the trigger, not the caller, holds the pin.
    const typed = (await captureRejection(async () =>
      context.db.updateTable("strategy.runs").set({ evaluation_interval_ms: 0, evaluation_heartbeat_ms: 0 }).where("run_id", "=", chain.runId).execute(),
    )) as { code?: string } | undefined;
    expect(typed?.code).toBe("PMB02");
    // The earlier pins are still guarded, in the re-created trigger.
    const seed = (await captureRejection(async () =>
      context.pool.query("update strategy.runs set run_seed = '8' where run_id = $1", [chain.runId]),
    )) as { code?: string } | undefined;
    expect(seed?.code).toBe("PMB02");
    // And a run still STOPS: the outcome columns are not pins.
    await context.repositories.strategy.stopRun(chain.runId, "cadence-1 test stop");
  });
});

describe("migration 0010 rolls back to exactly 0009's strategy.runs", () => {
  /** What the catalog says about `strategy.runs`: its columns, its constraints, its pinning trigger. */
  async function catalog(pool: ReturnType<typeof createPostgresPool>): Promise<string> {
    const columns = await pool.query<Record<string, unknown>>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'strategy' and table_name = 'runs' order by ordinal_position`,
    );
    const constraints = await pool.query<Record<string, unknown>>(
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'strategy.runs'::regclass order by conname`,
    );
    const triggers = await pool.query<Record<string, unknown>>(
      `select tgname, pg_get_triggerdef(oid) as definition from pg_trigger
        where tgrelid = 'strategy.runs'::regclass and not tgisinternal order by tgname`,
    );
    return JSON.stringify({ columns: columns.rows, constraints: constraints.rows, triggers: triggers.rows });
  }

  it("up, down, up: the catalog after the rollback IS 0009's; a run's row survives it, and reads NULL — recorded without the columns — when 0010 is re-applied", async () => {
    const connectionString = getEmpty();
    const pool = createPostgresPool({ connectionString, applicationName: "cadence-1-rollback", maxConnections: 2, statementTimeoutMs: 60_000 });
    pools.push(pool);
    const onDisk = await readMigrations();
    expect(onDisk.at(-1)?.version).toBe("0010");
    const previous = onDisk.at(-2)?.version ?? "";
    expect(previous).toBe("0009");

    await migrateUp(pool, { appliedBy: "cadence-1-test", toVersion: previous });
    const before = await catalog(pool);
    expect(before).not.toContain("evaluation_interval_ms");

    await migrateUp(pool, { appliedBy: "cadence-1-test" });
    const after = await catalog(pool);
    expect(after).toContain("evaluation_interval_ms");
    expect(after).toContain("runs_evaluation_cadence_both_or_neither");
    expect(after).toContain("runs_evaluation_cadence_non_negative");
    expect(after).toContain("runs_evaluation_cadence_per_frame_has_no_heartbeat");
    expect(after).toContain("'run_seed', 'started_at', 'evaluation_interval_ms', 'evaluation_heartbeat_ms'");

    // A run recorded at 0010, with its cadence.
    const database = createDatabase(pool);
    const run = await createTradingChain({ db: database, pool, repositories: createRepositories(database) } as unknown as TestContext, {
      label: "rollback",
    });
    const cadenceOf = async () =>
      (
        await pool.query<{ interval: number | null; heartbeat: number | null }>(
          "select evaluation_interval_ms as interval, evaluation_heartbeat_ms as heartbeat from strategy.runs where run_id = $1",
          [run.runId],
        )
      ).rows;
    expect(await cadenceOf()).toEqual([{ interval: 1000, heartbeat: 5000 }]);

    const rolledBack = await migrateDown(pool, { steps: 1 });
    expect(rolledBack.applied.map((entry) => entry.version)).toEqual(["0010"]);
    expect(await catalog(pool)).toBe(before);
    const survived = await pool.query<{ count: string }>("select count(*)::text as count from strategy.runs where run_id = $1", [run.runId]);
    expect(survived.rows[0]?.count).toBe("1");

    // Forward again: the same catalog, and the row — now one recorded without the
    // columns, as every run before 0010 was — reads NULL: ADR-024's per-frame run.
    await migrateUp(pool, { appliedBy: "cadence-1-test" });
    expect(await catalog(pool)).toBe(after);
    expect(await cadenceOf()).toEqual([{ interval: null, heartbeat: null }]);
  });
});
