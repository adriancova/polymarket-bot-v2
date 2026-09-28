/**
 * `SNAP-1` r1 — the SQL `PostgresTraderStore.replacePnlSnapshot` actually
 * emits, and its answer when the UPDATE matches no row.
 *
 * WHY THE METHOD EXISTS (`SNAP1-R1`, HIGH): the loop writes one
 * `accounting.pnl_snapshots` row per instance per instant, before the
 * harvest's deliveries (§4.2's MEDIUM-1 gate). When a LATER harvest books
 * more fills at an instant whose row this process already inserted — two
 * events with one `receivedAt` — the user's ruling requires that row to hold
 * the state after the LAST fill at that instant, and an INSERT cannot move it.
 * So the loop REPLACES it: one UPDATE, WHERE the constraint's six key columns,
 * SET every other column the insert binds.
 *
 * WHAT IS PINNED, the `TRDR-2` / `GOV-2B` B1 way
 * (`pnl-snapshot-column-binding.test.ts` pins the INSERT; this file the
 * UPDATE): the statement is captured through the REAL `createDatabase` — the
 * repository's own Kysely, dialect and compiler — over a pool stand-in that
 * records `(sql, parameters)` and answers a chosen `rowCount`. No PostgreSQL
 * is reached here; the round trip against a real one is in
 * `test/integration/paper-trader/durable-two-level-entry-postgres-redis.test.ts`.
 *
 * - SET names exactly the fourteen bound columns outside the key, each with
 *   its own field (twenty DISTINCT sentinels, so no transposition passes);
 * - WHERE names exactly the six key columns — `is null` for an absent
 *   instance or market, since the constraint is `nulls not distinct` and
 *   `= NULL` would match nothing;
 * - SET ∪ WHERE is the insert's twenty columns; the three the database owns
 *   (`pnl_snapshot_id`, `computed_at`, `rebuilt_at`) appear in neither;
 * - an UPDATE matching 0 rows (or any count but 1) is REFUSED as
 *   `UNAVAILABLE` — never an insert — and the in-memory double answers
 *   EXACTLY the same port data for a missing identity;
 * - a scope or environment outside the columns' enumerations is refused
 *   before any statement, as the insert refuses it.
 */

import { describe, expect, it } from "vitest";

import { PostgresTraderStore } from "../../../apps/trader/src/adapters/postgres-store.js";
import {
  MISSING_PNL_SNAPSHOT_DETAIL,
  MemoryTraderStore,
} from "../../../apps/trader/src/testing/index.js";
import type { PnlSnapshot } from "../../../packages/pnl/src/index.js";
import { createDatabase } from "../../../packages/storage-postgres/src/database.js";
import type { PostgresPool } from "../../../packages/storage-postgres/src/pool.js";

/** The fourteen columns SET, in binding order, and the field each carries. */
const SET: readonly (readonly [column: string, field: keyof PnlSnapshot])[] = [
  ["run_id", "runId"],
  ["denomination_asset", "denominationAsset"],
  ["gross_trading_pnl", "grossTradingPnl"],
  ["core_net_pnl", "coreNetPnl"],
  ["all_in_pnl", "allInPnl"],
  ["realized_pnl", "realizedPnl"],
  ["unrealized_pnl_midpoint", "unrealizedPnlMidpoint"],
  ["unrealized_pnl_model", "unrealizedPnlModel"],
  ["unrealized_pnl_liquidation", "unrealizedPnlLiquidation"],
  ["worst_case_resolution_pnl", "worstCaseResolutionPnl"],
  ["fees_paid", "feesPaid"],
  ["reward_estimate_total", "rewardEstimateTotal"],
  ["realized_rewards", "realizedRewards"],
  ["capital_committed", "capitalCommitted"],
];

/** The six key columns — `pnl_snapshots_scope_unique` — in WHERE order. */
const WHERE: readonly (readonly [column: string, field: keyof PnlSnapshot])[] = [
  ["scope", "scope"],
  ["environment", "environment"],
  ["account_ref", "accountRef"],
  ["instance_id", "instanceId"],
  ["market_id", "marketId"],
  ["as_of", "asOf"],
];

/** The twenty columns the INSERT binds (`pnl-snapshot-column-binding.test.ts`'s `BINDING`). */
const INSERTED = [
  "scope",
  "environment",
  "account_ref",
  "instance_id",
  "run_id",
  "market_id",
  "denomination_asset",
  "gross_trading_pnl",
  "core_net_pnl",
  "all_in_pnl",
  "realized_pnl",
  "unrealized_pnl_midpoint",
  "unrealized_pnl_model",
  "unrealized_pnl_liquidation",
  "worst_case_resolution_pnl",
  "fees_paid",
  "reward_estimate_total",
  "realized_rewards",
  "capital_committed",
  "as_of",
] as const;

const DATABASE_OWNED = ["pnl_snapshot_id", "computed_at", "rebuilt_at"] as const;

/** Twenty pairwise-distinct values, one per persisted field (the transposition probe). */
const SENTINELS: PnlSnapshot = {
  scope: "VIRTUAL_STRATEGY",
  environment: "PAPER",
  accountRef: "sentinel-account-ref",
  instanceId: "018f3a5c-0000-7000-8000-00000000000a",
  runId: "018f3a5c-0000-7000-8000-00000000000b",
  marketId: "018f3a5c-0000-7000-8000-00000000000c",
  denominationAsset: "sentinel-denomination",
  grossTradingPnl: "1",
  coreNetPnl: "2",
  allInPnl: "3",
  realizedPnl: "4",
  unrealizedPnlMidpoint: "5",
  unrealizedPnlModel: "6",
  unrealizedPnlLiquidation: "7",
  worstCaseResolutionPnl: "8",
  feesPaid: "9",
  rewardEstimateTotal: "10",
  realizedRewards: "11",
  capitalCommitted: "12",
  asOf: "2026-09-02T12:00:00.000001Z",
  feesByScheduleVersion: {},
  rewardsByProgram: {},
  estimatesByProgram: {},
};

interface Captured {
  readonly statements: { readonly sql: string; readonly parameters: readonly unknown[] }[];
  readonly pool: PostgresPool;
}

/**
 * A pool stand-in for `PostgresDialect` (as in `pnl-snapshot-column-binding.test.ts`):
 * `query(sql, parameters)` records the compiled statement and answers an
 * `UPDATE` result with `rowCount` rows affected — what kysely's driver reads
 * into `numUpdatedRows`.
 */
function capturingPool(rowCount: number): Captured {
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const client = {
    query: (sql: string, parameters: readonly unknown[]) => {
      statements.push({ sql, parameters: [...parameters] });
      return Promise.resolve({ command: "UPDATE", rowCount, rows: [] });
    },
    release: () => undefined,
  };
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(undefined),
  };
  // A test double for a `pg.Pool` (a CLASS type), the same assertion
  // `pnl-snapshot-column-binding.test.ts` makes at the same seam.
  return { statements, pool: pool as unknown as PostgresPool };
}

async function replaced(
  source: PnlSnapshot,
  rowCount = 1,
): Promise<{ readonly result: string; readonly sql: string; readonly parameters: readonly unknown[]; readonly issued: number }> {
  const capture = capturingPool(rowCount);
  const store = new PostgresTraderStore({ db: createDatabase(capture.pool), decisionContractVersion: 1 });
  const outcome = await store.replacePnlSnapshot(source);
  const statement = capture.statements[0];
  return {
    result: outcome.ok ? "ok" : `${outcome.failure.kind}: ${outcome.failure.detail}`,
    sql: statement?.sql ?? "(no statement was issued)",
    parameters: statement?.parameters ?? [],
    issued: capture.statements.length,
  };
}

/** Every quoted identifier in a compiled statement, in order, without the table's. */
function columnsOf(sql: string): readonly string[] {
  return [...sql.matchAll(/"([^"]+)"/gu)]
    .map((match) => match[1] ?? "")
    .filter((identifier) => identifier !== "accounting" && identifier !== "pnl_snapshots");
}

describe("SNAP-1 r1: replacePnlSnapshot emits ONE UPDATE — SET the non-key columns, WHERE the constraint's key", () => {
  it("names the fourteen SET columns and the six WHERE columns, in order, and nothing else", async () => {
    const { result, sql, issued } = await replaced(SENTINELS);
    expect(result).toBe("ok");
    expect(issued).toBe(1);
    const set = SET.map(([column], index) => `"${column}" = $${String(index + 1)}`).join(", ");
    const where = WHERE.map(([column], index) => `"${column}" = $${String(SET.length + index + 1)}`).join(" and ");
    expect(sql).toBe(`update "accounting"."pnl_snapshots" set ${set} where ${where}`);
  });

  it("binds each column its OWN field: twenty distinct sentinels, so no transposition can pass", async () => {
    const expected = [...SET, ...WHERE].map(([, field]) => SENTINELS[field]);
    expect(new Set(expected).size).toBe(20);
    const { sql, parameters } = await replaced(SENTINELS);
    expect(columnsOf(sql).map((column, index) => [column, parameters[index]])).toEqual(
      [...SET, ...WHERE].map(([column, field]) => [column, SENTINELS[field]]),
    );
    expect(new Set(parameters).size).toBe(20);
  });

  it("SET ∪ WHERE is exactly the insert's twenty columns; the three the database owns are touched by neither", async () => {
    const { sql } = await replaced(SENTINELS);
    const columns = columnsOf(sql);
    expect(new Set(columns).size).toBe(columns.length);
    expect([...columns].sort()).toEqual([...INSERTED].sort());
    for (const owned of DATABASE_OWNED) expect(columns).not.toContain(owned);
    // The key is WHERE only: no key column is rewritten.
    const setColumns = columns.slice(0, SET.length);
    for (const [column] of WHERE) expect(setColumns).not.toContain(column);
  });

  it("an absent instance or market is matched with IS NULL (the constraint is nulls not distinct), never `= NULL`", async () => {
    const accountWide: PnlSnapshot = { ...SENTINELS, scope: "ACTUAL_ACCOUNT", instanceId: null, marketId: null, runId: null };
    const { result, sql, parameters } = await replaced(accountWide);
    expect(result).toBe("ok");
    expect(sql).toContain(`"instance_id" is null and "market_id" is null and "as_of" = $18`);
    expect(sql).not.toMatch(/"(instance_id|market_id)" = /u);
    expect(parameters).toHaveLength(SET.length + WHERE.length - 2);
    expect(parameters.slice(SET.length)).toEqual(["ACTUAL_ACCOUNT", "PAPER", "sentinel-account-ref", SENTINELS.asOf]);
  });

  it("an UPDATE that matches NO row is REFUSED (UNAVAILABLE, nothing else issued), and the in-memory double answers EXACTLY the same port data", async () => {
    const capture = capturingPool(0);
    const adapter = new PostgresTraderStore({ db: createDatabase(capture.pool), decisionContractVersion: 1 });
    const fromAdapter = await adapter.replacePnlSnapshot(SENTINELS);
    expect(fromAdapter).toEqual({ ok: false, failure: { kind: "UNAVAILABLE", detail: MISSING_PNL_SNAPSHOT_DETAIL } });
    // One UPDATE and nothing after it: no fallback INSERT.
    expect(capture.statements.map((statement) => statement.sql.split(" ")[0])).toEqual(["update"]);
    const fromDouble = await new MemoryTraderStore().replacePnlSnapshot(SENTINELS);
    expect(fromDouble).toEqual(fromAdapter);
  });

  it("any count but exactly one is refused, naming the count", async () => {
    const { result } = await replaced(SENTINELS, 2);
    expect(result).toBe(
      "UNAVAILABLE: the durable store could not replace a PnL snapshot: Error: a PnL snapshot replacement " +
        "rewrites exactly one row of its pnl_snapshots_scope_unique identity, and 2 matched",
    );
  });

  it("refuses a scope or an environment the column's enumeration does not have, before any statement", async () => {
    const hostileScope = "ACTUAL" as unknown as PnlSnapshot["scope"];
    const badScope = await replaced({ ...SENTINELS, scope: hostileScope });
    expect(badScope.result).toContain("UNAVAILABLE: the durable store could not replace a PnL snapshot");
    expect(badScope.result).toContain("pnl_snapshots.scope");
    expect(badScope.issued).toBe(0);
    const badMode = await replaced({ ...SENTINELS, environment: "PRODUCTION" });
    expect(badMode.result).toContain("pnl_snapshots.environment");
    expect(badMode.issued).toBe(0);
  });
});
