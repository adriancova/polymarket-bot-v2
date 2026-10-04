/**
 * `CONTROL-2` — the trader's REAL halt rows through the control API's door,
 * and the halt surfaces over real HTTP (no container; the real-PostgreSQL
 * half is `postgres/trader-halts-postgres.test.ts`).
 *
 * 1. **The shape pin.** `apps/control-api` mirrors the trader's three
 *    `TRADER_HALT:*` keys because F10 forbids importing an app. This file —
 *    outside every workspace package, like `trader-health-shape.test.ts` —
 *    imports the trader's OWN `HALT_INCIDENT_KEYS` and `haltIncidentRows`
 *    (`apps/trader/src/halt-record.ts`), pins the keys equal, and drives the
 *    rows the trader writes for every scope through the control API's door: each
 *    is classified under its scope with no irregularity. A change to the
 *    trader's rows fails here rather than turning into UNRECOGNIZED halts.
 * 2. **Over HTTP.** The real server, API and cache answer `/v1/health` and
 *    `/v1/metrics` with OPEN, UNKNOWN and NOT_CONFIGURED as `trader-halts.ts`
 *    states them.
 * 3. **A PostgreSQL that never answers.** The REAL PostgreSQL source, over a
 *    real pool pointed at a loopback socket that accepts and stays silent,
 *    answers UNKNOWN at its bound; one pointed at a closed port answers
 *    UNKNOWN at once.
 * 4. **The shipped `startup()`** composes `NOT_CONFIGURED`, logs why, and its
 *    health and metrics say so (`main.ts`, `TRADER_HALTS_NOT_COMPOSED`).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryTraderHaltSource,
  TRADER_HALT_INCIDENT_KEYS,
  readTraderHaltFetch,
  type TraderHaltSource,
} from "@polymarket-bot/control-api";
import { traderHaltFetch } from "@polymarket-bot/control-api/testing";
import { createDatabase, createPostgresPool } from "@polymarket-bot/storage-postgres";

import { PostgresTraderHaltSource } from "../../../apps/control-api/src/adapters/postgres-trader-halts.js";
import { startup } from "../../../apps/control-api/src/main.js";
import { HALT_INCIDENT_KEYS, haltIncidentRows } from "../../../apps/trader/src/halt-record.js";
import { serveControlApi, type ServedApi } from "./support/client.js";

const TOKEN = "fake-paper-operator-token-not-a-credential-ctl2-0001";
const OPERATORS = [{ operatorId: "ctl2-reader", token: TOKEN, grants: ["READ" as const] }];

type TraderHalts = Parameters<typeof haltIncidentRows>[0];

const MARKET_ID = "01930000-0000-7000-8000-0000000000b1";
const INSTANCE_A = "01930000-0000-7000-8000-0000000000c1";
const INSTANCE_B = "01930000-0000-7000-8000-0000000000c2";

/** One halt of each scope, as the trader's `HaltController` latches them. */
const HALTS: TraderHalts = [
  {
    scope: { kind: "GLOBAL" },
    code: "TRANSPORT_UNAVAILABLE",
    detail: "redis did not answer",
    at: "2026-10-04T00:00:01.000Z",
    action: "FULL_HALT",
  },
  {
    scope: { kind: "MARKET", marketId: MARKET_ID },
    code: "BOOK_DESYNCHRONIZED",
    detail: "book hash mismatch",
    at: "2026-10-04T00:00:02.000Z",
    action: "CANCEL_RESTING_ORDERS",
  },
  {
    scope: { kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_A },
    code: "LEDGER_POSTING_REFUSED",
    detail: "posting refused",
    at: "2026-10-04T00:00:03.000Z",
    action: "MANAGE_KNOWN_POSITIONS_ONLY",
  },
];

/**
 * The trader's rows for {@link HALTS} as the PostgreSQL source fetches them:
 * the columns `haltIncidentRows` writes, plus the id and status the table
 * gives every row, `opened_at` in the server's rendering, newest first.
 */
function fetchedTraderRows(): Record<string, string | null>[] {
  const written = haltIncidentRows(HALTS, { accountRef: "paper-account", instanceIds: [INSTANCE_A, INSTANCE_B] });
  return written
    .map((row, index) => ({
      incident_id: `01930000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
      incident_key: row.incident_key,
      environment: row.environment,
      account_ref: row.account_ref,
      severity: row.severity,
      status: row.status,
      failure_class: row.failure_class,
      action: row.action,
      market_id: row.market_id,
      instance_id: row.instance_id,
      detail: row.detail,
      opened_at: row.opened_at.replace(/\.(\d{3})Z$/u, ".$1000Z"),
    }))
    .reverse();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the trader's REAL halt rows, through the control API's door (CONTROL-2 shape pin)", () => {
  it("the mirrored keys ARE the trader's keys", () => {
    expect({ ...TRADER_HALT_INCIDENT_KEYS }).toEqual({ ...HALT_INCIDENT_KEYS });
  });

  it("every row the trader writes, for every scope, is classified under its scope with NO irregularity", () => {
    const rows = fetchedTraderRows();
    // GLOBAL writes one row per configured instance.
    expect(rows).toHaveLength(4);
    const read = readTraderHaltFetch(traderHaltFetch(rows));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.halts.total).toBe(4);
    expect({ ...read.halts.byScope }).toEqual({ GLOBAL: 2, MARKET: 1, STRATEGY_INSTANCE: 1, UNRECOGNIZED: 0 });
    expect(read.halts.irregular).toBe(0);
    for (const row of read.halts.listed) expect(row.irregularities, row.incidentKey).toEqual([]);
    const market = read.halts.listed.find((row) => row.scope === "MARKET");
    expect(market).toMatchObject({ marketId: MARKET_ID, instanceId: null, failureClass: "BOOK_DESYNCHRONIZED", action: "CANCEL_RESTING_ORDERS" });
    const instance = read.halts.listed.find((row) => row.scope === "STRATEGY_INSTANCE");
    expect(instance).toMatchObject({ marketId: null, instanceId: INSTANCE_A, detail: "posting refused" });
    expect(read.halts.listed.filter((row) => row.scope === "GLOBAL").map((row) => row.instanceId).sort()).toEqual([INSTANCE_A, INSTANCE_B]);
  });
});

describe("the halt surfaces over real HTTP (CONTROL-2)", () => {
  let served: ServedApi | undefined;
  afterEach(async () => {
    await served?.server.close();
    served = undefined;
  });

  it("OPEN: the trader's rows are in /v1/health and the counts in /v1/metrics; a failed read then says UNKNOWN", async () => {
    const source = new InMemoryTraderHaltSource(traderHaltFetch(fetchedTraderRows()));
    served = await serveControlApi({ operators: OPERATORS, traderHaltSource: source });
    const health = await served.call("GET", "/v1/health", { token: TOKEN });
    expect(health.status).toBe(200);
    const halts = (health.json() as { traderHalts: Record<string, unknown> }).traderHalts;
    expect(halts["state"]).toBe("OPEN");
    expect(halts["openTotal"]).toBe(4);
    expect(halts["openByScope"]).toEqual({ GLOBAL: 2, MARKET: 1, STRATEGY_INSTANCE: 1, UNRECOGNIZED: 0 });
    expect((halts["listed"] as { failureClass: string }[]).map((row) => row.failureClass)).toContain("TRANSPORT_UNAVAILABLE");

    const metrics = await served.call("GET", "/v1/metrics", { token: TOKEN });
    expect(metrics.text).toContain('control_trader_halts_state{state="OPEN"} 1');
    expect(metrics.text).toContain('control_trader_halts_open{scope="GLOBAL"} 2');
    expect(metrics.text).toContain('control_trader_halts_open{scope="MARKET"} 1');

    source.fail("ops.incidents could not be read: connection refused");
    const after = await served.call("GET", "/v1/metrics", { token: TOKEN });
    expect(after.text).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
    expect(after.text).not.toContain("control_trader_halts_open");
    expect(after.text).toContain('control_trader_halt_reads_total{outcome="UNAVAILABLE"} 1');
    // An anonymous caller reads nothing.
    const fetches = source.fetches;
    expect((await served.call("GET", "/v1/health")).status).toBe(401);
    expect(source.fetches).toBe(fetches);
  });

  it("the default composition is NOT_CONFIGURED, said in both surfaces", async () => {
    served = await serveControlApi({ operators: OPERATORS });
    const halts = ((await served.call("GET", "/v1/health", { token: TOKEN })).json() as { traderHalts: Record<string, unknown> }).traderHalts;
    expect(halts["state"]).toBe("NOT_CONFIGURED");
    expect(halts["openTotal"]).toBeNull();
    const metrics = await served.call("GET", "/v1/metrics", { token: TOKEN });
    expect(metrics.text).toContain('control_trader_halts_state{state="NOT_CONFIGURED"} 1');
    expect(metrics.text).not.toContain("control_trader_halts_open");
  });
});

describe("the REAL PostgreSQL source against a database that does not answer (CONTROL-2)", () => {
  let served: ServedApi | undefined;
  let silent: Server | undefined;
  const sockets = new Set<Socket>();
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => {
      if (silent === undefined) resolve();
      else silent.close(() => resolve());
    });
    silent = undefined;
  });

  async function sourceAt(port: number, timeoutMs: number): Promise<{ source: TraderHaltSource; close: () => Promise<void> }> {
    const pool = createPostgresPool({
      connectionString: `postgres://halt_reader:not-a-credential@127.0.0.1:${String(port)}/nothing`,
      connectionTimeoutMs: 1500,
    });
    pool.on("error", () => undefined);
    const db = createDatabase(pool);
    return { source: new PostgresTraderHaltSource({ db, timeoutMs }), close: () => db.destroy() };
  }

  it("a server that accepts and never answers: UNKNOWN at the bound, never NONE_OPEN, never a hang", async () => {
    silent = createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => silent?.listen(0, "127.0.0.1", () => resolve()));
    const address = silent.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const { source, close } = await sourceAt(port, 300);
    served = await serveControlApi({ operators: OPERATORS, traderHaltSource: source });
    try {
      const started = Date.now();
      const health = await served.call("GET", "/v1/health", { token: TOKEN });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(1400);
      const halts = (health.json() as { traderHalts: Record<string, unknown> }).traderHalts;
      expect(halts["state"]).toBe("UNKNOWN");
      expect(String(halts["detail"])).toContain("did not answer within 300 ms");
      expect(sockets.size).toBeGreaterThan(0);
      const metrics = await served.call("GET", "/v1/metrics", { token: TOKEN });
      expect(metrics.text).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
      expect(metrics.text).not.toContain("control_trader_halts_open");
    } finally {
      await served.server.close();
      served = undefined;
      for (const socket of sockets) socket.destroy();
      await close();
    }
  }, 30_000);

  it("a closed port: UNKNOWN at once, with the driver's reason", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { source, close } = await sourceAt(port, 5000);
    try {
      const started = Date.now();
      const fetched = await source.fetch();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(fetched.fetched).toBe(false);
      if (!fetched.fetched) expect(fetched.detail).toContain("ops.incidents could not be read");
    } finally {
      await close();
    }
  });
});

describe("the SHIPPED startup() composes NOT_CONFIGURED and says why (CONTROL-2)", () => {
  let directory = "";
  afterEach(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("logs the NOT CONFIGURED line, and /v1/health and /v1/metrics say NOT_CONFIGURED — never 'no halts'", async () => {
    directory = await mkdtemp(join(tmpdir(), "ctl2-control-api-"));
    const configPath = join(directory, "control-api.json");
    await writeFile(
      configPath,
      JSON.stringify({
        bindHost: "127.0.0.1",
        bindPort: 0,
        maxRequestBodyBytes: 65_536,
        auditCapacity: 64,
        auditSafetyReserve: 4,
        traderHealth: { kind: "none" },
        operators: OPERATORS.map((operator) => ({ ...operator, grants: [...operator.grants] })),
      }),
      "utf8",
    );
    const lines: string[] = [];
    const code = await startup(
      {
        env: {
          RUN_MODE: "PAPER",
          MAX_RUN_MODE: "PAPER",
          ALLOW_REAL_ORDERS: "false",
          LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
          LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
          CONTROL_API_CONFIG: configPath,
        },
        argv: [],
        readConfig: (path) => readFile(path, "utf8"),
        log: (line) => {
          lines.push(line);
        },
      },
      { serve: true },
    );
    expect(code).toBe(0);
    try {
      expect(lines.join("\n")).toContain("trader halts: NOT CONFIGURED");
      expect(lines.join("\n")).toContain("reads no open TRADER_HALT rows from ops.incidents");
      const listening = lines.find((line) => line.startsWith("control API listening on 127.0.0.1:"));
      const port = Number(/127\.0\.0\.1:(\d+)/u.exec(listening ?? "")?.[1] ?? "0");
      expect(port).toBeGreaterThan(0);
      const health = JSON.parse((await get(port, "/v1/health")).body) as { traderHalts: Record<string, unknown> };
      expect(health.traderHalts["state"]).toBe("NOT_CONFIGURED");
      expect(String(health.traderHalts["detail"])).toContain("holds no PostgreSQL client");
      expect((await get(port, "/v1/metrics")).body).toContain('control_trader_halts_state{state="NOT_CONFIGURED"} 1');
    } finally {
      expect(process.listenerCount("SIGINT")).toBe(1);
      process.emit("SIGINT");
      for (let i = 0; i < 50 && !lines.includes("control API stopped."); i += 1) await sleep(20);
      expect(lines).toContain("control API stopped.");
    }
  }, 30_000);
});

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
