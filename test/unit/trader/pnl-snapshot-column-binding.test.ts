/**
 * `TRDR-2` / `GOV-2B` **B1** — the SQL `PostgresTraderStore.writePnlSnapshot`
 * actually emits.
 *
 * The companion of `test/integration/paper-trader/durable-pnl-snapshot-postgres.test.ts`:
 * that file proves the row LANDS in a real PostgreSQL — into a database whose
 * three parent tables a TEST FIXTURE seeded, which is a caveat stated in full
 * there — and this one proves WHICH STATEMENT was sent, without Docker, so the
 * property runs in `pnpm test` on every machine and in every CI step the unit
 * suite reaches.
 *
 * The defect it pins, measured at `f41fb8d` before the fix: the adapter passed
 * `toPnlSnapshotRow`'s camelCase record to `.values(row as never)`, and since
 * `createDatabase` registers no `CamelCasePlugin`, Kysely quoted those keys
 * verbatim:
 *
 * ```
 * insert into "accounting"."pnl_snapshots" ("scope", "environment",
 *   "accountRef", "instanceId", "runId", "marketId", "denominationAsset",
 *   "grossTradingPnl", "coreNetPnl", "allInPnl", "realizedPnl",
 *   "unrealizedPnlMidpoint", "unrealizedPnlModel", "unrealizedPnlLiquidation",
 *   "worstCaseResolutionPnl", "feesPaid", "rewardEstimateTotal",
 *   "realizedRewards", "capitalCommitted", "asOf")
 *   values ($1, … , $20)
 * ```
 *
 * Eighteen of those twenty identifiers name no column, and PostgreSQL answers
 * `column "accountRef" of relation "pnl_snapshots" does not exist` — which
 * `#contained` turns into `UNAVAILABLE` and `loop.ts:1523-1530` turns into a
 * GLOBAL `STORE_UNAVAILABLE` halt after every fill.
 *
 * ## How the statement is captured
 *
 * Through the REAL `createDatabase` — the same Kysely construction
 * `apps/trader/src/main.ts` builds for production — over a pool stand-in that
 * records `(sql, parameters)` and answers an empty result. Nothing is
 * simulated between the adapter and the SQL: the query builder, the dialect
 * and the compiler are the repository's own, at the repository's own pinned
 * Kysely. NO PostgreSQL and no `pg` connection is reached, on purpose; the
 * property here is the statement, and the property there is the round trip.
 * `test/unit/storage-postgres/support/capturing-db.ts` is the precedent for
 * the stand-in, and captures one step earlier (the bound row, not the SQL).
 *
 * ## Why a second, synthetic snapshot (`TRDR-2` r1, review finding R2)
 *
 * The first round of this file drove every case from the REAL `packages/pnl`
 * pipeline and claimed that the measures it produces are "mutually distinct, so
 * a transposed binding could not pass". That claim is FALSE for two pairs, and
 * the adversarial review measured it: in that fixture
 * `coreNetPnl === allInPnl` (§6 invariant 14 — they differ by REALIZED rewards
 * only, and a realized reward needs settlement evidence no unit fixture may
 * forge) and `rewardEstimateTotal === realizedRewards === "0"`. With
 * `core_net_pnl: row.allInPnl, all_in_pnl: row.coreNetPnl` planted in the
 * adapter — a transposition of exactly the pair that invariant exists to keep
 * apart — EVERY test in the repository passed, this file's five included.
 * Equal values make a column-to-value zip blind, and the pipeline cannot be
 * asked to produce unequal ones here.
 *
 * So the transposition case below binds a HAND-BUILT `PnlSnapshot` whose twenty
 * persisted fields are twenty DISTINCT sentinels (`DecimalString` is `string`,
 * `packages/decimal/src/canonical.ts:59`, so a sentinel needs no cast; `scope`
 * and `environment` stay legal members of `internal.ledger_scope` and
 * `internal.run_mode`, because the adapter narrows them by SEARCHING those
 * lists). Its premise — that the twenty are distinct — is asserted in the test
 * rather than assumed, and with it any permutation of the binding fails.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PostgresTraderStore } from "../../../apps/trader/src/adapters/postgres-store.js";
import {
  computePnlSnapshot,
  foldPnlRecords,
  type PnlSnapshot,
} from "../../../packages/pnl/src/index.js";
import { createDatabase } from "../../../packages/storage-postgres/src/database.js";
import type { PostgresPool } from "../../../packages/storage-postgres/src/pool.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The twenty columns the adapter binds, IN BINDING ORDER, and the snapshot
 * field each one carries. This is the mapping pinned against the table types
 * at `test/unit/ledger/wp040-persistence-shape.test.ts:265-284`; here it is
 * pinned against the emitted SQL instead, so a rebinding that still compiles
 * (two fields of the same type swapped) is caught by the VALUES as well.
 */
const BINDING: readonly (readonly [column: string, field: keyof PnlSnapshot])[] = [
  ["scope", "scope"],
  ["environment", "environment"],
  ["account_ref", "accountRef"],
  ["instance_id", "instanceId"],
  ["run_id", "runId"],
  ["market_id", "marketId"],
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
  ["as_of", "asOf"],
];

/** The three the DATABASE owns; binding any of them here would be the bug. */
const DATABASE_OWNED = ["pnl_snapshot_id", "computed_at", "rebuilt_at"] as const;

/** The `create table accounting.pnl_snapshots (...)` block, comments stripped. */
const PNL_SNAPSHOTS_DDL = (() => {
  const sql = readFileSync(join(REPO_ROOT, "db", "migrations", "0006_accounting.up.sql"), "utf8")
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment < 0 ? line : line.slice(0, comment);
    })
    .join("\n");
  const start = sql.indexOf("create table accounting.pnl_snapshots (");
  if (start < 0) throw new Error("the migration has no create table accounting.pnl_snapshots");
  const end = sql.indexOf("\n);", start);
  if (end < 0) throw new Error("the create table block is unterminated");
  return sql.slice(start, end);
})();

interface Captured {
  readonly statements: { readonly sql: string; readonly parameters: readonly unknown[] }[];
  readonly pool: PostgresPool;
}

/**
 * A pool stand-in for `PostgresDialect`: `connect()` hands back a client whose
 * `query(sql, parameters)` records the compiled statement and answers an empty
 * `INSERT` result, which is the whole of the interface kysely's driver uses for
 * a non-streaming query.
 */
function capturingPool(): Captured {
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const client = {
    query: (sql: string, parameters: readonly unknown[]) => {
      statements.push({ sql, parameters: [...parameters] });
      return Promise.resolve({ command: "INSERT", rowCount: 1, rows: [] });
    },
    release: () => undefined,
  };
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(undefined),
  };
  // A test double for a `pg.Pool` (a CLASS type): the assertion is the double's
  // own, at the seam this file exists to observe, and it is the same one
  // `test/unit/storage-postgres/support/capturing-db.ts` makes. It suppresses
  // nothing about the ADAPTER, whose binding is checked by the compiler.
  return { statements, pool: pool as unknown as PostgresPool };
}

function snapshot(): PnlSnapshot {
  const owner = {
    scope: "VIRTUAL_STRATEGY",
    accountRef: "acct-paper-1",
    instanceId: "018f3a5c-2222-7000-8000-00000000000a",
  } as const;
  const folded = foldPnlRecords(
    {
      scope: "VIRTUAL_STRATEGY",
      environment: "PAPER",
      accountRef: "acct-paper-1",
      instanceId: "018f3a5c-2222-7000-8000-00000000000a",
      runId: "018f3a5c-3333-7000-8000-00000000000a",
      marketId: "018f3a5c-1111-7000-8000-000000000001",
    },
    [
      {
        kind: "TRADE",
        ref: "018f3a5c-6666-7000-8000-000000000001",
        owner,
        marketId: "018f3a5c-1111-7000-8000-000000000001",
        tokenAssetId: "token-x",
        denominationAsset: "pUSD",
        side: "BUY",
        shares: "10",
        price: "0.4",
      },
      {
        kind: "TRADE",
        ref: "018f3a5c-6666-7000-8000-000000000002",
        owner,
        marketId: "018f3a5c-1111-7000-8000-000000000001",
        tokenAssetId: "token-x",
        denominationAsset: "pUSD",
        side: "SELL",
        shares: "4",
        price: "0.6",
      },
      {
        kind: "FEE",
        ref: "018f3a5c-6666-7000-8000-000000000003",
        owner,
        denominationAsset: "pUSD",
        amount: "0.13",
      },
    ],
  );
  if (!folded.ok) throw new Error(`the fold refused: ${JSON.stringify(folded.refusals)}`);
  const computed = computePnlSnapshot(folded.value, {
    asOf: "2026-09-02T12:00:00.123456Z",
    marks: { "token-x": { midpoint: "0.5", model: "0.52", liquidation: "0.47" } },
  });
  if (!computed.ok) throw new Error(`the snapshot was refused: ${JSON.stringify(computed.refusals)}`);
  const value = computed.value[0];
  if (value === undefined) throw new Error("the pipeline produced no snapshot");
  return value;
}

/**
 * Twenty DISTINCT sentinel values, one per persisted field — the transposition
 * probe (review finding R2).
 *
 * Not a plausible snapshot and not meant to be: the point is that no two bound
 * values are equal, so the column-to-value zip refuses EVERY permutation of the
 * binding, including the two pairs the real pipeline makes equal
 * (`coreNetPnl`/`allInPnl` and `rewardEstimateTotal`/`realizedRewards`). The
 * twelve measures are the distinct integers 1-12 IN BINDING ORDER, so a failure
 * reads as a permutation of `1 … 12` rather than as a wall of decimals.
 *
 * `scope` and `environment` are legal members of the columns' enumerations
 * (`VIRTUAL_STRATEGY`, `PAPER`) because the adapter refuses anything else
 * before a statement is built — and `PAPER` is the only run mode this
 * repository operates in. The three §9.16 breakdowns are empty: they have no
 * columns, `toPnlSnapshotRow` drops them, and this file asserts that the
 * statement names exactly the twenty.
 */
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

async function emitted(source: PnlSnapshot = snapshot()): Promise<{
  readonly result: string;
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly source: PnlSnapshot;
}> {
  const capture = capturingPool();
  const store = new PostgresTraderStore({
    db: createDatabase(capture.pool),
    decisionContractVersion: 1,
  });
  const outcome = await store.writePnlSnapshot(source);
  const statement = capture.statements[0];
  return {
    result: outcome.ok ? "ok" : `${outcome.failure.kind}: ${outcome.failure.detail}`,
    sql: statement?.sql ?? "(no statement was issued)",
    parameters: statement?.parameters ?? [],
    source,
  };
}

/** Every quoted identifier in a compiled statement, in order. */
function quotedIdentifiers(sql: string): readonly string[] {
  return [...sql.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

describe("writePnlSnapshot emits an INSERT naming the table's own columns (TRDR-2 / GOV-2B B1)", () => {
  it("names the twenty snake_case columns, in the binding order, and nothing else", async () => {
    const { result, sql } = await emitted();
    expect(result).toBe("ok");

    const columns = BINDING.map(([column]) => column);
    const placeholders = columns.map((_, index) => `$${String(index + 1)}`);
    expect(sql).toBe(
      `insert into "accounting"."pnl_snapshots" (${columns
        .map((column) => `"${column}"`)
        .join(", ")}) values (${placeholders.join(", ")})`,
    );
  });

  it("quotes NO camelCase identifier — the general shape of the defect", async () => {
    const { sql } = await emitted();
    // B1's signature: a quoted identifier carrying an uppercase letter. This
    // holds however the binding is written, so it catches a future field that
    // arrives camelCase even if the list above is updated to match it.
    const camelCase = quotedIdentifiers(sql).filter((identifier) => /[A-Z]/u.test(identifier));
    expect(camelCase).toEqual([]);
  });

  it("binds each column the snapshot field it belongs to", async () => {
    const { sql, parameters, source } = await emitted();
    // COLUMN-to-VALUE pairs, not merely the value order: each identifier is
    // zipped with the parameter it carries, so a camelCase identifier (B1)
    // cannot satisfy it. It catches a TRANSPOSITION only between two fields
    // this pipeline gives DIFFERENT values — `coreNetPnl` and `allInPnl` are
    // equal here by §6 invariant 14, and the next case is the one that covers
    // them.
    const columns = quotedIdentifiers(sql).filter(
      (identifier) => identifier !== "accounting" && identifier !== "pnl_snapshots",
    );
    expect(columns.map((column, index) => [column, parameters[index]])).toEqual(
      BINDING.map(([column, field]) => [column, source[field]]),
    );
    // Not all-null and not all-equal: the assertion above has content.
    expect(new Set(parameters).size).toBeGreaterThan(10);
  });

  it("binds twenty DISTINCT sentinels, so NO transposition of the twenty can pass", async () => {
    // The premise, asserted rather than assumed: if two sentinels were ever
    // made equal, this case would go as blind as the one above and the failure
    // would be silent.
    const expected = BINDING.map(([, field]) => SENTINELS[field]);
    expect(new Set(expected).size).toBe(BINDING.length);

    const { result, sql, parameters } = await emitted(SENTINELS);
    expect(result).toBe("ok");

    const columns = quotedIdentifiers(sql).filter(
      (identifier) => identifier !== "accounting" && identifier !== "pnl_snapshots",
    );
    // Every column carries ITS OWN field. Because the twenty values are
    // pairwise distinct, this holds if and only if the binding is the identity
    // — a swap of ANY two fields, same-typed or not, moves a sentinel.
    expect(columns.map((column, index) => [column, parameters[index]])).toEqual(
      BINDING.map(([column, field]) => [column, SENTINELS[field]]),
    );
    // Stated once more as the property itself, so the reason this case exists
    // survives a future rewrite of the zip: the parameters are a set of twenty.
    expect(new Set(parameters).size).toBe(BINDING.length);
    expect([...parameters].sort()).toEqual([...expected].sort());
  });

  it("binds every column of the table except the three the database owns", async () => {
    const { sql } = await emitted();
    const bound = new Set(
      quotedIdentifiers(sql).filter(
        (identifier) => identifier !== "accounting" && identifier !== "pnl_snapshots",
      ),
    );

    // Every bound identifier is a column the DDL declares …
    for (const column of bound) {
      expect(PNL_SNAPSHOTS_DDL).toContain(`\n  ${column} `);
    }
    // … no column the database owns is bound …
    for (const column of DATABASE_OWNED) {
      expect(bound.has(column)).toBe(false);
      expect(PNL_SNAPSHOTS_DDL).toContain(`\n  ${column} `);
    }
    // … and the set is exactly the binding's, so a column dropped from the
    // insert is a failure rather than a silently NULL row.
    expect([...bound].sort()).toEqual(BINDING.map(([column]) => column).sort());
  });

  it("refuses a scope or an environment the column's enumeration does not have", async () => {
    // `PnlSnapshotRow` types both as `string`, so the narrowing is the
    // adapter's. PostgreSQL would reject the value too — this refuses it one
    // step earlier, as the SAME `UNAVAILABLE` port data, naming the field.
    const capture = capturingPool();
    const store = new PostgresTraderStore({
      db: createDatabase(capture.pool),
      decisionContractVersion: 1,
    });

    // The TYPE forbids this value and a type stops a TypeScript caller and
    // nobody else; the assertion is how a hostile value is handed to a door in
    // this repository (`test/unit/.../halt.test.ts`'s `false as unknown as true`).
    const hostileScope = "ACTUAL" as unknown as PnlSnapshot["scope"];
    const badScope = await store.writePnlSnapshot({ ...snapshot(), scope: hostileScope });
    expect(badScope.ok).toBe(false);
    if (badScope.ok) throw new Error("the scope was accepted");
    expect(badScope.failure.kind).toBe("UNAVAILABLE");
    expect(badScope.failure.detail).toContain("pnl_snapshots.scope");

    const badMode = await store.writePnlSnapshot({ ...snapshot(), environment: "PRODUCTION" });
    expect(badMode.ok).toBe(false);
    if (badMode.ok) throw new Error("the environment was accepted");
    expect(badMode.failure.kind).toBe("UNAVAILABLE");
    expect(badMode.failure.detail).toContain("pnl_snapshots.environment");

    // Neither reached the database.
    expect(capture.statements).toEqual([]);
  });
});
