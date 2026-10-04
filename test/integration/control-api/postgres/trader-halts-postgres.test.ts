/**
 * `CONTROL-2` (closing `H1R1-HALT-INVISIBLE`) — open trader halts in a REAL
 * PostgreSQL, read back through the REAL control API over HTTP.
 *
 * Every halt row here that the trader could write is written by the trader's
 * OWN production writer: `haltIncidentRows` and `PostgresTraderStore.recordHalts`
 * (`apps/trader/src/halt-record.ts`, `adapters/postgres-store.ts`), the path
 * `startup()` runs before a halted trader exits 75. The rows the trader would
 * never write — an unknown scope, an irregular row, a RESOLVED or MITIGATING
 * one, hundreds of them — are inserted directly. Then the control API, through
 * `src/adapters/postgres-trader-halts.ts` on its OWN pool, answers
 * `GET /v1/health` and `GET /v1/metrics` over a real socket.
 *
 * Measured, each case against the four states of `trader-halts.ts`:
 *
 * - the trader's halts of every scope are OPEN, listed exactly as written;
 * - no open row is NONE_OPEN; RESOLVED leaves, MITIGATING stays;
 * - an unknown scope and an irregular row are counted, never dropped;
 * - many open rows: exact counts, the list bounded and marked truncated;
 * - a SLOW read (the table locked by another session) is UNKNOWN within the
 *   bound, and the SERVER cancelled the statement (no reader backend is left
 *   waiting on the lock);
 * - an UNREADABLE table (a role with no privilege on it) is UNKNOWN, and a
 *   role holding only `SELECT` on `ops.incidents` reads it;
 * - READ-ONLY: every statement the source sends is recorded, none writes, its
 *   transaction is `read only`, and every row is byte-identical after the reads.
 *
 * Docker is required (`vitest.config.ts` beside this file); nothing skips.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TraderHaltCache } from "@polymarket-bot/control-api";
import { createDatabase, createPostgresPool, type PolymarketBotDatabase, type PostgresPool } from "@polymarket-bot/storage-postgres";
import {
  createIsolatedDatabase,
  createMigratedContext,
  createTradingChain,
  startPostgresContainer,
  type TestContext,
  type TradingChain,
} from "@polymarket-bot/storage-postgres/testing";

import { PostgresTraderHaltSource } from "../../../../apps/control-api/src/adapters/postgres-trader-halts.js";
import { PostgresTraderStore } from "../../../../apps/trader/src/adapters/postgres-store.js";
import { haltIncidentRows } from "../../../../apps/trader/src/halt-record.js";
import { serveControlApi, type ServedApi } from "../support/client.js";

const TOKEN = "fake-paper-operator-token-not-a-credential-ctl2-pg01";
const OPERATORS = [{ operatorId: "ctl2-reader", token: TOKEN, grants: ["READ" as const] }];
const READER_APPLICATION = "control-2-halt-reader";

type TraderHalts = Parameters<typeof haltIncidentRows>[0];

let container: Awaited<ReturnType<typeof startPostgresContainer>> | undefined;
let context: TestContext | undefined;
let connectionString = "";
let chain: TradingChain | undefined;

function database(): TestContext {
  if (context === undefined) throw new Error("the PostgreSQL context was not created");
  return context;
}

function seeded(): TradingChain {
  if (chain === undefined) throw new Error("the trading chain was not created");
  return chain;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const isolated = await createIsolatedDatabase(container.getConnectionUri(), "control_2_halts");
  connectionString = isolated.connectionString;
  context = await createMigratedContext(connectionString);
  chain = await createTradingChain(context);
});

afterAll(async () => {
  await context?.close();
  await container?.stop();
});

beforeEach(async () => {
  // Test hygiene, by the ADMIN handle: the control API never writes here.
  await database().pool.query("delete from ops.incidents");
});

/** A pool for the control API's reader that records every statement any of its connections is sent. */
function readerPool(url = connectionString): { readonly pool: PostgresPool; readonly db: PolymarketBotDatabase; readonly statements: string[] } {
  const pool = createPostgresPool({ connectionString: url, applicationName: READER_APPLICATION, maxConnections: 4 });
  pool.on("error", () => undefined);
  const statements: string[] = [];
  const wrapped = new WeakSet<object>();
  const connect = pool.connect.bind(pool) as unknown as () => Promise<{ query: (...args: unknown[]) => unknown }>;
  (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
    const client = await connect();
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const query = client.query.bind(client);
      client.query = (...args: unknown[]) => {
        const first = args[0];
        statements.push(typeof first === "string" ? first : String((first as { text?: unknown }).text));
        return query(...args);
      };
    }
    return client;
  };
  return { pool, db: createDatabase(pool), statements };
}

/** The trader's own production write of `halts` (the path `startup()` runs before it exits 75). */
async function traderRecords(halts: TraderHalts): Promise<void> {
  const store = new PostgresTraderStore({
    db: database().db,
    decisionContractVersion: 1,
    accountRef: "paper-account",
    pool: database().pool,
  });
  const rows = haltIncidentRows(halts, { accountRef: "paper-account", instanceIds: [seeded().instanceId] });
  const outcome = await store.recordHalts(rows, 5_000);
  expect(outcome).toEqual({ status: "written", rows: rows.length });
}

function halts(): TraderHalts {
  return [
    { scope: { kind: "GLOBAL" }, code: "TRANSPORT_UNAVAILABLE", detail: "redis did not answer", at: "2026-10-04T00:00:01.000Z", action: "FULL_HALT" },
    {
      scope: { kind: "MARKET", marketId: seeded().marketId },
      code: "BOOK_DESYNCHRONIZED",
      detail: "book hash mismatch",
      at: "2026-10-04T00:00:02.000Z",
      action: "CANCEL_RESTING_ORDERS",
    },
    {
      scope: { kind: "STRATEGY_INSTANCE", instanceId: seeded().instanceId },
      code: "LEDGER_POSTING_REFUSED",
      detail: "posting refused",
      at: "2026-10-04T00:00:03.250Z",
      action: "MANAGE_KNOWN_POSITIONS_ONLY",
    },
  ];
}

/** Inserts one row directly (the rows the trader would never write). */
async function insertRow(columns: Record<string, string | null>): Promise<void> {
  const row = {
    incident_key: "TRADER_HALT:MARKET",
    environment: "PAPER",
    account_ref: "paper-account",
    severity: "PAGE",
    status: "OPEN",
    failure_class: "STALE_BOOK",
    action: "HALT_NEW_ENTRIES",
    market_id: seeded().marketId,
    instance_id: null,
    detail: "inserted directly",
    opened_at: "2026-10-04T00:00:00.000Z",
    resolution: null,
    resolved_at: null,
    ...columns,
  };
  const names = Object.keys(row);
  await database().pool.query(
    `insert into ops.incidents (${names.join(", ")}) values (${names.map((_, index) => `$${String(index + 1)}`).join(", ")})`,
    names.map((name) => row[name as keyof typeof row]),
  );
}

async function snapshot(): Promise<unknown[]> {
  return (await database().pool.query("select * from ops.incidents order by incident_id")).rows;
}

interface HaltsSection {
  readonly state: string;
  readonly configured: boolean;
  readonly openTotal: number | null;
  readonly openByScope: Record<string, number> | null;
  readonly truncated: boolean | null;
  readonly irregular: number | null;
  readonly listed: readonly Record<string, unknown>[] | null;
  readonly detail: string | null;
  readonly reads: Record<string, number>;
}

async function halted(served: ServedApi): Promise<HaltsSection> {
  const response = await served.call("GET", "/v1/health", { token: TOKEN });
  expect(response.status).toBe(200);
  return (response.json() as { traderHalts: HaltsSection }).traderHalts;
}

async function metrics(served: ServedApi): Promise<string> {
  const response = await served.call("GET", "/v1/metrics", { token: TOKEN });
  expect(response.status).toBe(200);
  return response.text;
}

async function withServed<T>(
  reader: { readonly db: PolymarketBotDatabase },
  timeoutMs: number,
  run: (served: ServedApi) => Promise<T>,
): Promise<T> {
  const served = await serveControlApi({ operators: OPERATORS, traderHaltSource: new PostgresTraderHaltSource({ db: reader.db, timeoutMs }) });
  try {
    return await run(served);
  } finally {
    await served.server.close();
  }
}

describe("a trader's halts, written by its own writer, read back through the control API (CONTROL-2)", () => {
  it("every scope is OPEN, listed as the trader wrote it, counted in the metrics — and the reader wrote NOTHING", async () => {
    await traderRecords(halts());
    const before = await snapshot();
    expect(before).toHaveLength(3);
    const reader = readerPool();
    try {
      await withServed(reader, 2_000, async (served) => {
        const section = await halted(served);
        expect(section.state).toBe("OPEN");
        expect(section.configured).toBe(true);
        expect(section.openTotal).toBe(3);
        expect(section.openByScope).toEqual({ GLOBAL: 1, MARKET: 1, STRATEGY_INSTANCE: 1, UNRECOGNIZED: 0 });
        expect(section.irregular).toBe(0);
        expect(section.truncated).toBe(false);
        // Newest first, every column as the trader wrote it; opened_at rendered by the server.
        expect(section.listed?.map((row) => row["scope"])).toEqual(["STRATEGY_INSTANCE", "MARKET", "GLOBAL"]);
        expect(section.listed?.[0]).toMatchObject({
          incidentKey: "TRADER_HALT:STRATEGY_INSTANCE",
          status: "OPEN",
          severity: "PAGE",
          environment: "PAPER",
          accountRef: "paper-account",
          failureClass: "LEDGER_POSTING_REFUSED",
          action: "MANAGE_KNOWN_POSITIONS_ONLY",
          marketId: null,
          instanceId: seeded().instanceId,
          detail: "posting refused",
          openedAt: "2026-10-04T00:00:03.250000Z",
          irregularities: [],
        });
        expect(section.listed?.[1]).toMatchObject({ marketId: seeded().marketId, instanceId: null, action: "CANCEL_RESTING_ORDERS" });
        expect(section.listed?.[2]).toMatchObject({ incidentKey: "TRADER_HALT:GLOBAL", instanceId: seeded().instanceId, action: "FULL_HALT" });

        const body = await metrics(served);
        expect(body).toContain('control_trader_halts_state{state="OPEN"} 1');
        expect(body).toContain('control_trader_halts_open{scope="GLOBAL"} 1');
        expect(body).toContain('control_trader_halts_open{scope="MARKET"} 1');
        expect(body).toContain('control_trader_halts_open{scope="STRATEGY_INSTANCE"} 1');
        expect(body).toContain('control_trader_halts_open{scope="UNRECOGNIZED"} 0');
        for (let i = 0; i < 3; i += 1) await halted(served);
        expect((await halted(served)).reads).toEqual({ OK: 6 });
      });
      // READ-ONLY, measured: nothing the source sent can write, its
      // transactions are READ ONLY, and every row is byte-identical.
      expect(reader.statements.length).toBeGreaterThan(0);
      const writes = reader.statements.filter((sql) => /\b(insert|update|delete|truncate|merge|alter|create|drop|grant|revoke|lock|copy|call)\b/iu.test(sql));
      expect(writes).toEqual([]);
      const begins = reader.statements.filter((sql) => /^\s*(start transaction|begin)/iu.test(sql));
      expect(begins.length).toBe(6);
      // One snapshot for both statements (the door checks the count and the list agree), read only.
      for (const begin of begins) expect(begin.toLowerCase()).toBe("start transaction isolation level repeatable read read only");
      expect(reader.statements.some((sql) => sql.includes("set_config"))).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally {
      await reader.db.destroy();
    }
  });

  it("no open row is NONE_OPEN; a RESOLVED row leaves, a MITIGATING row stays", async () => {
    const reader = readerPool();
    try {
      await withServed(reader, 2_000, async (served) => {
        expect((await halted(served)).state).toBe("NONE_OPEN");
        expect(await metrics(served)).toContain('control_trader_halts_open{scope="MARKET"} 0');
        await insertRow({ status: "RESOLVED", resolution: "operator resolved it", resolved_at: "2026-10-04T01:00:00.000Z" });
        const resolved = await halted(served);
        expect(resolved.state).toBe("NONE_OPEN");
        expect(resolved.openTotal).toBe(0);
        await insertRow({ status: "MITIGATING", detail: "being mitigated" });
        const mitigating = await halted(served);
        expect(mitigating.state).toBe("OPEN");
        expect(mitigating.openTotal).toBe(1);
        expect(mitigating.listed?.[0]).toMatchObject({ status: "MITIGATING", detail: "being mitigated" });
      });
    } finally {
      await reader.db.destroy();
    }
  });

  it("an UNKNOWN scope and an IRREGULAR row are counted and listed, never dropped", async () => {
    await insertRow({ incident_key: "TRADER_HALT:FUTURE_SCOPE", market_id: null });
    await insertRow({ incident_key: "trader_halt:market", opened_at: "2026-10-04T00:00:01.000Z" });
    await insertRow({ market_id: null, severity: "NOTIFY", environment: "SHADOW", opened_at: "2026-10-04T00:00:02.000Z" });
    // Outside the namespace: never counted.
    await insertRow({ incident_key: "TRADERXHALT:MARKET", opened_at: "2026-10-04T00:00:03.000Z" });
    await insertRow({ incident_key: "RECONCILE_BREAK", opened_at: "2026-10-04T00:00:04.000Z" });
    const reader = readerPool();
    try {
      await withServed(reader, 2_000, async (served) => {
        const section = await halted(served);
        expect(section.state).toBe("OPEN");
        expect(section.openTotal).toBe(3);
        expect(section.openByScope).toEqual({ GLOBAL: 0, MARKET: 1, STRATEGY_INSTANCE: 0, UNRECOGNIZED: 2 });
        expect(section.irregular).toBe(3);
        const said = (section.listed ?? []).map((row) => (row["irregularities"] as string[]).join("; "));
        expect(said[0]).toContain("MARKET halt row names no market_id");
        expect(said[0]).toContain("severity NOTIFY");
        expect(said[0]).toContain("environment SHADOW");
        expect(said[1]).toContain("not one of the trader's three scope keys");
        expect(said[2]).toContain("not one of the trader's three scope keys");
        expect(await metrics(served)).toContain('control_trader_halts_open{scope="UNRECOGNIZED"} 2');
      });
    } finally {
      await reader.db.destroy();
    }
  });

  it("MANY open rows: exact counts, the newest listed, marked truncated", async () => {
    await database().pool.query(
      `insert into ops.incidents (incident_key, environment, severity, status, failure_class, action, market_id, detail, opened_at)
       select 'TRADER_HALT:MARKET', 'PAPER', 'PAGE', 'OPEN', 'STALE_BOOK', 'HALT_NEW_ENTRIES', $1, 'row ' || n,
              timestamptz '2026-10-04 00:00:00+00' + n * interval '1 second'
         from generate_series(1, 130) as n`,
      [seeded().marketId],
    );
    await traderRecords(halts().slice(0, 1));
    const reader = readerPool();
    try {
      await withServed(reader, 2_000, async (served) => {
        const section = await halted(served);
        expect(section.state).toBe("OPEN");
        expect(section.openTotal).toBe(131);
        expect(section.openByScope).toEqual({ GLOBAL: 1, MARKET: 130, STRATEGY_INSTANCE: 0, UNRECOGNIZED: 0 });
        expect(section.listed).toHaveLength(50);
        expect(section.truncated).toBe(true);
        expect(section.listed?.[0]?.["detail"]).toBe("row 130");
        expect(await metrics(served)).toContain('control_trader_halts_open{scope="MARKET"} 130');
      });
    } finally {
      await reader.db.destroy();
    }
  });
});

describe("a read that cannot be trusted is UNKNOWN — never NONE_OPEN, never the previous count (CONTROL-2)", () => {
  it("a SLOW read — the table locked by another session — is UNKNOWN within the bound, and the server cancelled it", async () => {
    await traderRecords(halts());
    const reader = readerPool();
    const locker = await database().pool.connect();
    try {
      await withServed(reader, 500, async (served) => {
        expect((await halted(served)).state).toBe("OPEN");
        await locker.query("begin");
        await locker.query("lock table ops.incidents in access exclusive mode");
        const started = Date.now();
        const section = await halted(served);
        const elapsed = Date.now() - started;
        expect(section.state).toBe("UNKNOWN");
        expect(section.openTotal).toBeNull();
        expect(section.listed).toBeNull();
        expect(elapsed).toBeLessThan(3_000);
        const body = await metrics(served);
        expect(body).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
        expect(body).not.toContain("control_trader_halts_open");
        // The SERVER's bound (`set_config('statement_timeout', …, true)`):
        // no reader backend is left waiting on the lock once the read answered.
        let waiting = -1;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const rows = (
            await database().pool.query(
              "select count(*)::int as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'",
              [READER_APPLICATION],
            )
          ).rows as { n: number }[];
          waiting = rows[0]?.n ?? -1;
          if (waiting === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(waiting).toBe(0);
        await locker.query("rollback");
        expect((await halted(served)).state).toBe("OPEN");
      });
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
      await reader.db.destroy();
    }
  }, 60_000);

  it("an UNREADABLE table — a role with no privilege on it — is UNKNOWN; granted SELECT alone, the same role reads it", async () => {
    await traderRecords(halts());
    const admin = database().pool;
    const role = `ctl2_reader_${String(Date.now())}`;
    const password = "not-a-credential-ctl2";
    await admin.query(`create role ${role} login password '${password}'`);
    const url = new URL(connectionString);
    url.username = role;
    url.password = password;
    const reader = readerPool(url.toString());
    try {
      await withServed(reader, 2_000, async (served) => {
        const refused = await halted(served);
        expect(refused.state).toBe("UNKNOWN");
        expect(refused.detail).toContain("permission denied");
        expect(await metrics(served)).not.toContain("control_trader_halts_open");

        // SELECT on the one table is all the read needs.
        await admin.query(`grant usage on schema ops, internal to ${role}`);
        await admin.query(`grant select on ops.incidents to ${role}`);
        const granted = await halted(served);
        expect(granted.state).toBe("OPEN");
        expect(granted.openTotal).toBe(3);

        // Revoked again: UNKNOWN — the OPEN count is not retained.
        await admin.query(`revoke select on ops.incidents from ${role}`);
        const revoked = await halted(served);
        expect(revoked.state).toBe("UNKNOWN");
        expect(revoked.openTotal).toBeNull();
        expect(revoked.reads).toEqual({ OK: 1, UNAVAILABLE: 3 });
      });
    } finally {
      await reader.db.destroy();
      await admin.query(`revoke all on ops.incidents from ${role}`);
      await admin.query(`revoke all on schema ops, internal from ${role}`);
      await admin.query(`drop role ${role}`);
    }
  });

  it("the cache over the real source: a configured source's first state is UNKNOWN until it is read", async () => {
    const reader = readerPool();
    try {
      const cache = new TraderHaltCache(new PostgresTraderHaltSource({ db: reader.db, timeoutMs: 2_000 }));
      expect(cache.view().state).toBe("UNKNOWN");
      expect((await cache.refresh()).state).toBe("NONE_OPEN");
    } finally {
      await reader.db.destroy();
    }
  });
});
