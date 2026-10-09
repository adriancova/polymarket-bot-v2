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
 * 4. **The shipped `startup()`** (`CONTROL-2` r1): `traderHalts.kind` `none`
 *    composes `NOT_CONFIGURED`, logs why, and its health and metrics say so;
 *    `postgres` composes the PostgreSQL source from the ONE environment
 *    variable, read once, and a database that refuses or never answers is
 *    UNKNOWN — with the URL and its password in no log line, no health answer
 *    and no metrics body.
 * 5. **The PAGE rule and the panel** (`CONTROL-2` r1, S1): the rule in
 *    `infra/prometheus/trader-alerts.yaml`, evaluated against the bodies this
 *    API renders in each state, fires on OPEN and UNKNOWN only; the
 *    operations dashboard's panel binds all three families, each target an
 *    INSTANT query (`CTL2-L1`).
 * 6. **A slow read cannot silence the page** (`CTL2-F1`): the control-api
 *    scrape job states its `scrape_timeout`, above the API's answer deadline,
 *    above the halt read's longest bound; and the shipped `startup()`, with a
 *    trader that never answers and a database that froze, answers
 *    `/v1/metrics` inside that timeout with `UNKNOWN 1`.
 * 7. **A frozen database cannot hold the stop** (`CTL2-L2`): the shipped
 *    `startup()` ends the pool's connections at the close bound and tells the
 *    process to exit; the SHIPPED bundle, run with `node`, exits 0 on SIGTERM.
 *
 * The shipped BUNDLE itself — built by the `build` script and run with
 * `node` — is driven against a real PostgreSQL in
 * `postgres/shipped-bundle-halts-postgres.test.ts`.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  AbsentTraderHaltSource,
  InMemoryTraderHaltSource,
  READ_REFRESH_DEADLINE_MS,
  TRADER_HALT_INCIDENT_KEYS,
  TRADER_HALT_STATES,
  TraderHaltCache,
  readTraderHaltFetch,
  traderHaltSamples,
  type TraderHaltSource,
} from "@polymarket-bot/control-api";
import { traderHaltFetch } from "@polymarket-bot/control-api/testing";
import { PLATFORM_METRIC_FAMILIES, renderExpositionFor } from "@polymarket-bot/observability";
import { createDatabase, createPostgresPool } from "@polymarket-bot/storage-postgres";

import { PostgresTraderHaltSource, TRADER_HALT_READ_TIMEOUT_MAX_MS } from "../../../apps/control-api/src/adapters/postgres-trader-halts.js";
import {
  EXIT_CODES,
  TRADER_HALTS_APPLICATION_NAME,
  TRADER_HALTS_CLOSE_WAIT_MS,
  TRADER_HALTS_DATABASE_URL_ENV,
  TRADER_HALTS_TERMINATE_WAIT_MS,
  planTraderHalts,
  redactDatabaseUrl,
  startup,
} from "../../../apps/control-api/src/main.js";
import { HALT_INCIDENT_KEYS, haltIncidentRows } from "../../../apps/trader/src/halt-record.js";
import { serveControlApi, type ServedApi } from "./support/client.js";
import {
  REPO_ROOT,
  SAFE_PAPER_ENVIRONMENT,
  buildShippedBundle,
  removeBundle,
  runShippedBundle,
  startShippedBundle,
  type BuiltBundle,
} from "./support/shipped-bundle.js";

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
  },
  {
    scope: { kind: "MARKET", marketId: MARKET_ID },
    code: "BOOK_DESYNCHRONIZED",
    detail: "book hash mismatch",
    at: "2026-10-04T00:00:02.000Z",
  },
  {
    scope: { kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_A },
    code: "LEDGER_POSTING_REFUSED",
    detail: "posting refused",
    at: "2026-10-04T00:00:03.000Z",
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
    expect(market).toMatchObject({ marketId: MARKET_ID, instanceId: null, failureClass: "BOOK_DESYNCHRONIZED" });
    // C1-HALTS: the trader writes `action` NULL; the door reads it and shows none.
    expect(rows.every((row) => row["action"] === null)).toBe(true);
    expect(market !== undefined && "action" in market).toBe(false);
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

const SAFE_ENVIRONMENT = {
  RUN_MODE: "PAPER",
  MAX_RUN_MODE: "PAPER",
  ALLOW_REAL_ORDERS: "false",
  LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
  LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
} as const;

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", () => resolveListen()));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

/**
 * A loopback "PostgreSQL" that asks for the password in clear and then
 * refuses the login with an error that ECHOES it — the worst a driver error
 * can do with a credential. The composition must redact it. `received()` is
 * every password the driver sent, in order (`CONTROL2-R2-C1`: what the driver
 * ACTUALLY sends, not what a reading of the URL expects), and `connections()`
 * how many connections it was opened.
 */
async function echoingPostgres(): Promise<{
  readonly port: number;
  readonly received: () => readonly string[];
  readonly connections: () => number;
  readonly close: () => Promise<void>;
}> {
  const field = (code: string, value: string): Buffer => Buffer.concat([Buffer.from(code, "latin1"), Buffer.from(`${value}\0`, "utf8")]);
  const sockets = new Set<Socket>();
  const received: string[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readInt32BE(0));
        started = true;
        // AuthenticationCleartextPassword.
        const ask = Buffer.alloc(9);
        ask.write("R", 0, "latin1");
        ask.writeInt32BE(8, 1);
        ask.writeInt32BE(3, 5);
        socket.write(ask);
      }
      if (buffer.length < 5 || buffer[0] !== 0x70 || buffer.length < 1 + buffer.readInt32BE(1)) return;
      // The PasswordMessage's body, without its terminating NUL: what the driver sent.
      const password = buffer.subarray(5, buffer.readInt32BE(1)).toString("utf8");
      received.push(password);
      const fields = Buffer.concat([
        field("S", "FATAL"),
        field("V", "FATAL"),
        field("C", "28P01"),
        field("M", `password authentication failed; this server echoes the password it was sent: ${password}`),
        Buffer.from([0]),
      ]);
      const header = Buffer.alloc(5);
      header.write("E", 0, "latin1");
      header.writeInt32BE(4 + fields.length, 1);
      socket.end(Buffer.concat([header, fields]));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    received: () => [...received],
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/**
 * `CTL2-L2` / `CTL2-F1`: a loopback "PostgreSQL" that completes the startup
 * handshake (AuthenticationOk, then ReadyForQuery) and then never answers a
 * statement — a server that froze mid-session. A connection to it stays
 * checked out, holding a statement outstanding; `open()` counts the client
 * sockets still open.
 */
async function frozenPostgres(): Promise<{ readonly port: number; readonly open: () => number; readonly close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk: Buffer) => {
      // After the handshake every statement is swallowed: the server is frozen.
      if (started) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
      started = true;
      const ok = Buffer.alloc(9);
      ok.write("R", 0, "latin1");
      ok.writeInt32BE(8, 1);
      ok.writeInt32BE(0, 5);
      const ready = Buffer.alloc(6);
      ready.write("Z", 0, "latin1");
      ready.writeInt32BE(5, 1);
      ready.write("I", 5, "latin1");
      socket.write(Buffer.concat([ok, ready]));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    open: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/** Polls `condition` every 20 ms until it holds or `ms` pass. */
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  for (const began = Date.now(); Date.now() - began < ms; await sleep(20)) if (condition()) return true;
  return condition();
}

describe("the SHIPPED startup() composes the trader-halt source its configuration names (CONTROL-2 r1)", () => {
  let directory = "";
  afterEach(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  /**
   * Runs `startup()` serving, with `traderHalts` and `env`, and asserts it started; returns its log, its
   * port, and a stop that waits up to `stopWaitMs` for "control API stopped.". `traderHealth` defaults
   * to `none`; `exit` is the `CTL2-L2` port (absent: nothing is told to exit, as before).
   */
  async function started(
    traderHalts: unknown,
    env: Record<string, string | undefined>,
    extra: { readonly traderHealth?: unknown; readonly exit?: (code: number) => void } = {},
  ): Promise<{ readonly lines: string[]; readonly port: number; readonly stop: (stopWaitMs?: number) => Promise<void> }> {
    const run = await launched(traderHalts, env, extra);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(run.port).toBeGreaterThan(0);
    return run;
  }

  /** {@link started}, without asserting that it started: also its exit code (`CONTROL2-R2-C1`). */
  async function launched(
    traderHalts: unknown,
    env: Record<string, string | undefined>,
    extra: { readonly traderHealth?: unknown; readonly exit?: (code: number) => void } = {},
  ): Promise<{
    readonly code: number;
    readonly lines: string[];
    readonly port: number;
    readonly stop: (stopWaitMs?: number) => Promise<void>;
  }> {
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
        traderHealth: extra.traderHealth ?? { kind: "none" },
        traderHalts,
        operators: OPERATORS.map((operator) => ({ ...operator, grants: [...operator.grants] })),
      }),
      "utf8",
    );
    Object.assign(env, SAFE_ENVIRONMENT, { CONTROL_API_CONFIG: configPath });
    const sigterm = process.listeners("SIGTERM");
    const lines: string[] = [];
    const code = await startup(
      {
        env,
        argv: [],
        readConfig: (path) => readFile(path, "utf8"),
        log: (line) => {
          lines.push(line);
        },
        ...(extra.exit === undefined ? {} : { exit: extra.exit }),
      },
      { serve: true },
    );
    const listening = lines.find((line) => line.startsWith("control API listening on 127.0.0.1:"));
    const port = Number(/127\.0\.0\.1:(\d+)/u.exec(listening ?? "")?.[1] ?? "0");
    return {
      code,
      lines,
      port,
      stop: async (stopWaitMs = 2_000) => {
        expect(process.listenerCount("SIGINT")).toBe(1);
        process.emit("SIGINT");
        await until(() => lines.includes("control API stopped."), stopWaitMs);
        expect(lines).toContain("control API stopped.");
        // The SIGTERM handler this startup added, and only it.
        for (const listener of process.listeners("SIGTERM")) if (!sigterm.includes(listener)) process.removeListener("SIGTERM", listener);
      },
    };
  }

  it("none: logs the NOT CONFIGURED line, and /v1/health and /v1/metrics say NOT_CONFIGURED — never 'no halts'", async () => {
    const run = await started({ kind: "none" }, {});
    try {
      expect(run.lines.join("\n")).toContain("trader halts: NOT CONFIGURED");
      expect(run.lines.join("\n")).toContain("traderHalts.kind is none");
      const health = JSON.parse((await get(run.port, "/v1/health")).body) as { traderHalts: Record<string, unknown> };
      expect(health.traderHalts["state"]).toBe("NOT_CONFIGURED");
      expect(health.traderHalts["configured"]).toBe(false);
      expect(String(health.traderHalts["detail"])).toContain("traderHalts.kind is none");
      expect((await get(run.port, "/v1/metrics")).body).toContain('control_trader_halts_state{state="NOT_CONFIGURED"} 1');
    } finally {
      await run.stop();
    }
  }, 30_000);

  it("postgres: the ONE variable is read once, a database that refuses is UNKNOWN, and the URL and its password are printed NOWHERE", async () => {
    const password = "Wq4-not-a-credential-ctl2-r1";
    const url = `postgres://halt_reader:${password}@127.0.0.1:${String(await closedPort())}/polymarket_bot`;
    let reads = 0;
    const env: Record<string, string | undefined> = {};
    Object.defineProperty(env, TRADER_HALTS_DATABASE_URL_ENV, {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return url;
      },
    });
    const run = await started({ kind: "postgres", timeoutMs: 1_500 }, env);
    try {
      const readsAtStartup = reads;
      // The safety scan reads every variable once; the composition reads this one once.
      expect(readsAtStartup).toBe(2);
      const said = run.lines.join("\n");
      expect(said).toContain("trader halt source postgres");
      expect(said).toContain(`from the database ${TRADER_HALTS_DATABASE_URL_ENV} names (its value is never logged)`);
      const bodies: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const health = await get(run.port, "/v1/health");
        expect(health.status).toBe(200);
        bodies.push(health.body);
        const halts = (JSON.parse(health.body) as { traderHalts: Record<string, unknown> }).traderHalts;
        expect(halts["state"]).toBe("UNKNOWN");
        expect(halts["configured"]).toBe(true);
        expect(halts["openTotal"]).toBeNull();
        expect(String(halts["detail"])).toContain("ops.incidents could not be read");
        const metrics = await get(run.port, "/v1/metrics");
        bodies.push(metrics.body);
        expect(metrics.body).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
        expect(metrics.body).not.toContain("control_trader_halts_open");
      }
      // Read ONCE: serving six authorized reads read the variable no more.
      expect(reads).toBe(readsAtStartup);
      for (const text of [...bodies, run.lines.join("\n")]) {
        expect(text).not.toContain(password);
        expect(text).not.toContain(url);
      }
    } finally {
      await run.stop();
    }
    for (const line of run.lines) expect(line).not.toContain(password);
  }, 30_000);

  it("postgres against a server whose error ECHOES the password: the driver's error reaches /v1/health with the password <redacted>", async () => {
    const echoing = await echoingPostgres();
    const password = "Ec5-not-a-credential-ctl2-r1-echo";
    const url = `postgres://halt_reader:${password}@127.0.0.1:${String(echoing.port)}/polymarket_bot`;
    const run = await started({ kind: "postgres", timeoutMs: 2_000 }, { [TRADER_HALTS_DATABASE_URL_ENV]: url });
    try {
      const health = await get(run.port, "/v1/health");
      const halts = (JSON.parse(health.body) as { traderHalts: Record<string, unknown> }).traderHalts;
      expect(halts["state"]).toBe("UNKNOWN");
      // The driver's own words arrive — with the credential replaced.
      expect(String(halts["detail"])).toContain("this server echoes the password it was sent: <redacted>");
      expect(health.body).not.toContain(password);
      const metrics = await get(run.port, "/v1/metrics");
      expect(metrics.body).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
      expect(metrics.body).not.toContain(password);
      expect(run.lines.join("\n")).not.toContain(password);
    } finally {
      await run.stop();
      await echoing.close();
    }
  }, 30_000);

  it("CONTROL2-R2-C1 / CTL2-R3-L1: through the shipped startup() and HTTP — a URL the driver would rewrite, or whose password it would cut at a NUL, is REFUSED (78) before any connection, and what the server would have read is printed nowhere", async () => {
    // Each fake password with what the server reads of it (measured below, `driverSends`): at
    // 01f23a9 the first two URLs were admitted, and /v1/health carried the second column from the
    // echoing server; at 9406bb3 the last two were (`CTL2-R3-L1`), and it carried the prefix before the NUL.
    for (const [password, driverWouldSend] of [
      ["Fake%2FSecret Word-ctl2-r2", "Fake%2FSecret Word-ctl2-r2"],
      ["Ec%41%zz-nac-ctl2-r2", "EcA%zz-nac-ctl2-r2"],
      ["Fk-embedded-ctl2-r3%00secret", "Fk-embedded-ctl2-r3"],
      ["Full-pw-ctl2-r3%00", "Full-pw-ctl2-r3"],
    ] as const) {
      const echoing = await echoingPostgres();
      const url = `postgres://halt_reader:${password}@127.0.0.1:${String(echoing.port)}/polymarket_bot`;
      const run = await launched({ kind: "postgres", timeoutMs: 2_000 }, { [TRADER_HALTS_DATABASE_URL_ENV]: url });
      const bodies: string[] = [];
      try {
        // Were it admitted, this is where the password would surface.
        if (run.code === EXIT_CODES.ok) {
          bodies.push((await get(run.port, "/v1/health")).body, (await get(run.port, "/v1/metrics")).body);
        }
      } finally {
        if (run.code === EXIT_CODES.ok) await run.stop();
        await echoing.close();
      }
      for (const text of [...bodies, run.lines.join("\n")]) {
        for (const secret of [driverWouldSend, password, ...echoing.received()]) expect(text, password).not.toContain(secret);
      }
      expect(run.code, password).toBe(EXIT_CODES.configurationRefused);
      expect(run.lines.join("\n")).toContain("[CONTROL_TRADER_HALTS_URL_ENCODING]");
      expect(run.lines.join("\n")).not.toContain("control API listening");
      // Refused before any pool: the database was never reached.
      expect(echoing.connections(), password).toBe(0);
    }
  }, 30_000);

  it("postgres against a server that accepts and never answers: UNKNOWN at the configured bound, not a hang", async () => {
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolveListen) => silent.listen(0, "127.0.0.1", () => resolveListen()));
    const address = silent.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const run = await started({ kind: "postgres", timeoutMs: 400 }, {
      [TRADER_HALTS_DATABASE_URL_ENV]: `postgres://halt_reader:not-a-credential@127.0.0.1:${String(port)}/x`,
    });
    try {
      const began = Date.now();
      const health = JSON.parse((await get(run.port, "/v1/health")).body) as { traderHalts: Record<string, unknown> };
      const elapsed = Date.now() - began;
      expect(health.traderHalts["state"]).toBe("UNKNOWN");
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(elapsed).toBeLessThan(3_000);
      expect(sockets.size).toBeGreaterThan(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await run.stop();
      await new Promise<void>((resolveClose) => silent.close(() => resolveClose()));
    }
  }, 30_000);

  it("CTL2-F1: a trader that never answers (traderHealth bound 30 s) and a database that froze — /v1/metrics is still answered INSIDE the scrape timeout, UNKNOWN 1, which pages", async () => {
    const scrapeTimeoutMs = controlApiScrapeTimeoutMs();
    const traderSockets = new Set<Socket>();
    const silentTrader = createHttpServer(() => undefined);
    silentTrader.on("connection", (socket: Socket) => {
      traderSockets.add(socket);
    });
    await new Promise<void>((resolveListen) => silentTrader.listen(0, "127.0.0.1", () => resolveListen()));
    const traderAddress = silentTrader.address();
    const traderPort = typeof traderAddress === "object" && traderAddress !== null ? traderAddress.port : 0;
    const frozen = await frozenPostgres();
    const run = await started(
      { kind: "postgres", timeoutMs: 400 },
      { [TRADER_HALTS_DATABASE_URL_ENV]: `postgres://halt_reader:not-a-credential@127.0.0.1:${String(frozen.port)}/x` },
      { traderHealth: { kind: "http", url: `http://127.0.0.1:${String(traderPort)}/health`, timeoutMs: 30_000 } },
    );
    try {
      const began = Date.now();
      // A scrape: it gives up at the job's scrape_timeout, as Prometheus does.
      const metrics = await get(run.port, "/v1/metrics", scrapeTimeoutMs);
      const elapsed = Date.now() - began;
      expect(metrics.status).toBe(200);
      expect(elapsed).toBeLessThan(scrapeTimeoutMs);
      // It waited for the trader until the answer deadline, and no longer.
      expect(elapsed).toBeGreaterThanOrEqual(READ_REFRESH_DEADLINE_MS - 100);
      expect(metrics.body).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
      expect(metrics.body).toContain('control_trader_halts_state{state="NONE_OPEN"} 0');
      expect(metrics.body).not.toContain("control_trader_halts_open");
      expect(metrics.body).toContain("control_trader_health_current 0");
      expect(traderSockets.size).toBeGreaterThan(0);
      expect(frozen.open()).toBeGreaterThan(0);
    } finally {
      for (const socket of traderSockets) socket.destroy();
      await new Promise<void>((resolveClose) => silentTrader.close(() => resolveClose()));
      await frozen.close();
      await run.stop(TRADER_HALTS_CLOSE_WAIT_MS + TRADER_HALTS_TERMINATE_WAIT_MS + 2_000);
    }
  }, 60_000);

  it("CTL2-L2: a database that froze mid-statement does not hold the stop — the pool's connections are ENDED at the close bound, and the process is told to exit 0", async () => {
    const frozen = await frozenPostgres();
    const exits: number[] = [];
    const run = await started(
      { kind: "postgres", timeoutMs: 400 },
      { [TRADER_HALTS_DATABASE_URL_ENV]: `postgres://halt_reader:not-a-credential@127.0.0.1:${String(frozen.port)}/x` },
      { exit: (code) => exits.push(code) },
    );
    try {
      const health = JSON.parse((await get(run.port, "/v1/health")).body) as { traderHalts: Record<string, unknown> };
      expect(health.traderHalts["state"]).toBe("UNKNOWN");
      expect(String(health.traderHalts["detail"])).toContain("did not answer within 400 ms");
      // The abandoned read's connection: checked out, its statement outstanding, the server silent.
      expect(frozen.open()).toBe(1);
      const began = Date.now();
      await run.stop(TRADER_HALTS_CLOSE_WAIT_MS + 4_000);
      const elapsed = Date.now() - began;
      // The frozen server saw the connection go: the process ended it.
      expect(await until(() => frozen.open() === 0, 1_000), "the frozen server's connection is still open").toBe(true);
      const said = run.lines.join("\n");
      expect(said).toContain(
        `the ops.incidents pool did not close within ${String(TRADER_HALTS_CLOSE_WAIT_MS)}ms; ending the 1 connection(s) it still holds`,
      );
      expect(said).not.toContain("stop failed");
      expect(exits).toEqual([0]);
      expect(elapsed).toBeLessThan(TRADER_HALTS_CLOSE_WAIT_MS + TRADER_HALTS_TERMINATE_WAIT_MS + 1_000);
    } finally {
      await frozen.close();
    }
  }, 30_000);

  it("CTL2-L2: a clean stop is told to exit 0 once, after it says it stopped", async () => {
    const exits: number[] = [];
    const run = await started({ kind: "none" }, {}, { exit: (code) => exits.push(code) });
    await run.stop();
    expect(exits).toEqual([0]);
    expect(run.lines.at(-1)).toBe("control API stopped.");
  }, 30_000);
});

describe("CONTROL2-R2-C1: the password the REAL driver sends, for a URL planTraderHalts admits, is the one redacted", () => {
  const POSTGRES = { kind: "postgres", timeoutMs: 2_000 } as const;

  /** `text` percent-decoded, or as written when it does not decode. */
  const decoded = (text: string): string => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };

  it("each admitted URL: the driver sends the authority's password percent-decoded, and its echo is <redacted>; each refused rewrite form: the driver, handed it directly, sends a password that is neither the URL's as written nor its decoding; each refused NUL form (CTL2-R3-L1): the server reads it cut at the NUL, and the error carries that prefix, which the redaction leaves whole", async () => {
    const echoing = await echoingPostgres();
    const at = (password: string): string => `postgres://halt_reader:${password}@127.0.0.1:${String(echoing.port)}/polymarket_bot`;
    /** What the driver sends for `url`, and the error it reports, through a pool made as `main.ts` makes it. */
    const driverSends = async (url: string): Promise<{ readonly sent: string | undefined; readonly error: string }> => {
      const before = echoing.received().length;
      const pool = createPostgresPool({
        connectionString: url,
        maxConnections: 1,
        connectionTimeoutMs: 5_000,
        applicationName: TRADER_HALTS_APPLICATION_NAME,
      });
      pool.on("error", () => undefined);
      let error = "";
      try {
        const client = await pool.connect();
        client.release();
      } catch (cause) {
        error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      }
      await pool.end();
      return { sent: echoing.received()[before], error };
    };
    try {
      let admitted = 0;
      for (const password of [
        "Zq7-plain-ctl2-r2",
        "p%40ss%2Fword-ctl2-r2",
        "sp%20ace%41-ctl2-r2",
        "%C3%A9t%C3%A9-ctl2-r2",
        "100%25-ctl2-r2",
        "semi;colon=eq-ctl2-r2",
        "%2F%2f%3A%41%7E-ctl2-r2",
        // `CTL2-R3-L1`: control characters other than NUL, and a literal "%00", are sent whole.
        "Ctl%01%1F%7F-ctl2-r3",
        "Lit%2500-ctl2-r3",
      ]) {
        const url = at(password);
        expect(planTraderHalts(POSTGRES, url).ok, password).toBe(true);
        const { sent, error } = await driverSends(url);
        // The driver read the URL as written: what it sent is the authority's password, decoded.
        expect(sent, password).toBe(decodeURIComponent(new URL(url).password));
        expect(error, password).toContain(`this server echoes the password it was sent: ${sent ?? "(nothing)"}`);
        const redacted = redactDatabaseUrl(error, url);
        expect(redacted, password).toContain("this server echoes the password it was sent: <redacted>");
        expect(redacted, password).not.toContain(sent ?? "(nothing)");
        admitted += 1;
      }
      expect(admitted).toBe(9);

      // The verifiers' two forms, and a third mixing both escapes: each REFUSED — and the positive
      // control: the driver, handed it directly, sends what the URL holds neither as written nor decoded.
      for (const [password, driverSent] of [
        ["Fake%2FSecret Word-ctl2-r2", "Fake%2FSecret Word-ctl2-r2"],
        ["Ec%41%zz-nac-ctl2-r2", "EcA%zz-nac-ctl2-r2"],
        ["Ec%2F%41 x-ctl2-r2", "Ec%2FA x-ctl2-r2"],
      ] as const) {
        const url = at(password);
        const plan = planTraderHalts(POSTGRES, url);
        expect(plan.ok ? "ADMITTED" : plan.code, password).toBe("CONTROL_TRADER_HALTS_URL_ENCODING");
        const { sent } = await driverSends(url);
        expect(sent, password).toBe(driverSent);
        const written = new URL(url).password;
        expect([written, decoded(written)], password).not.toContain(sent);
      }

      // `CTL2-R3-L1`: the verifiers' embedded and terminal %00, each REFUSED — and the positive control:
      // the driver, handed it directly, sends the decoded password, NUL and all, as a C string, and the
      // error it reports carries only the text before the NUL (its parser cuts each field there). The
      // redaction holds the password as written and decoded, so that prefix — for the terminal %00, the
      // whole intended credential — passes it untouched.
      let cut = 0;
      for (const [password, prefix] of [
        ["Fk-embedded-ctl2-r3%00secret", "Fk-embedded-ctl2-r3"],
        ["Full-pw-ctl2-r3%00", "Full-pw-ctl2-r3"],
      ] as const) {
        const url = at(password);
        const plan = planTraderHalts(POSTGRES, url);
        expect(plan.ok ? "ADMITTED" : plan.code, password).toBe("CONTROL_TRADER_HALTS_URL_ENCODING");
        const { sent, error } = await driverSends(url);
        expect(sent, password).toBe(decodeURIComponent(new URL(url).password));
        expect(sent?.indexOf("\u0000"), password).toBe(prefix.length);
        expect(error, password).toContain(`this server echoes the password it was sent: ${prefix}`);
        expect(error, password).not.toContain("\u0000");
        expect(redactDatabaseUrl(error, url), password).toContain(`this server echoes the password it was sent: ${prefix}`);
        cut += 1;
      }
      expect(cut).toBe(2);
    } finally {
      await echoing.close();
    }
  }, 60_000);
});

describe("CONTROL-2 r1 (S1): the PAGE rule and the operations panel read the platform's trader-halt families", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const rules = readFileSync(resolve(repoRoot, "infra/prometheus/trader-alerts.yaml"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");

  /** The one `- alert: TraderHaltOpenOrUnknown` block. */
  const block = /- alert: TraderHaltOpenOrUnknown\n[\s\S]*?(?=\n\s*- alert: |\n\s*- name: |$)/u.exec(rules)?.[0] ?? "";

  it("TraderHaltOpenOrUnknown PAGES at once on the state family, in the trader-halts group", () => {
    expect(rules).toMatch(/- name: trader-halts\n\s+rules:\n\s+- alert: TraderHaltOpenOrUnknown\n/u);
    expect(block).toContain('expr: max(control_trader_halts_state{state=~"OPEN|UNKNOWN"}) == 1');
    expect(block).toContain("severity: page");
    expect(block).toContain("for: 0m");
  });

  it("evaluated against the body this API renders in each state, the rule fires on OPEN and UNKNOWN — and on nothing else", async () => {
    const expression = /expr: max\(control_trader_halts_state\{state=~"(?<states>[^"]+)"\}\) == 1/u.exec(block)?.groups?.["states"] ?? "";
    // PromQL anchors a label regex at both ends.
    const matcher = new RegExp(`^(?:${expression})$`, "u");
    const firesOn = (body: string): boolean =>
      [...body.matchAll(/^control_trader_halts_state\{state="(?<state>[A-Z_]+)"\} (?<value>\d+)$/gmu)].some(
        (match) => matcher.test(match.groups?.["state"] ?? "") && match.groups?.["value"] === "1",
      );
    const cache = async (result: unknown): Promise<TraderHaltCache> => {
      const read = new TraderHaltCache(new InMemoryTraderHaltSource(result));
      await read.refresh();
      return read;
    };
    const failed = new TraderHaltCache(new InMemoryTraderHaltSource());
    await failed.refresh();
    const states: Record<string, TraderHaltCache> = {
      OPEN: await cache(traderHaltFetch(fetchedTraderRows())),
      NONE_OPEN: await cache(traderHaltFetch([])),
      UNKNOWN: failed,
      NOT_CONFIGURED: new TraderHaltCache(new AbsentTraderHaltSource()),
    };
    expect(Object.keys(states).sort()).toEqual([...TRADER_HALT_STATES].sort());
    const fired: string[] = [];
    for (const [state, read] of Object.entries(states)) {
      const body = renderExpositionFor(PLATFORM_METRIC_FAMILIES, traderHaltSamples(read));
      expect(body, state).toContain(`control_trader_halts_state{state="${state}"} 1`);
      if (firesOn(body)) fired.push(state);
    }
    expect(fired.sort()).toEqual(["OPEN", "UNKNOWN"]);
  });

  it("the operations dashboard's panel binds all three families", () => {
    const dashboard = JSON.parse(readFileSync(resolve(repoRoot, "infra/grafana/control/operations-dashboard.json"), "utf8")) as {
      panels: { title?: string; targets?: { expr?: string }[]; description?: string }[];
    };
    const panel = dashboard.panels.find((entry) => entry.title === "Open trader halts (ops.incidents)");
    expect(panel).toBeDefined();
    const exprs = (panel?.targets ?? []).map((target) => target.expr ?? "");
    for (const family of ["control_trader_halts_state", "control_trader_halts_open", "control_trader_halt_reads_total"]) {
      expect(exprs.some((expr) => expr.includes(family)), family).toBe(true);
    }
    expect(panel?.description).toContain("TraderHaltOpenOrUnknown");
  });

  it("CTL2-L1: every target of the halt panel is an INSTANT query — a target Prometheus is not scraping shows nothing, never an earlier NONE_OPEN", () => {
    const dashboard = JSON.parse(readFileSync(resolve(repoRoot, "infra/grafana/control/operations-dashboard.json"), "utf8")) as {
      panels: { title?: string; type?: string; targets?: { refId?: string; expr?: string; instant?: unknown }[] }[];
    };
    const panel = dashboard.panels.find((entry) => entry.title === "Open trader halts (ops.incidents)");
    expect(panel?.type).toBe("stat");
    const targets = panel?.targets ?? [];
    expect(targets.map((target) => target.refId)).toEqual(["A", "B", "C"]);
    for (const target of targets) expect(target.instant, `${target.refId ?? ""} ${target.expr ?? ""}`).toBe(true);
  });

  it("CTL2-F1: the control-api job STATES its scrape_timeout (10 s), above the API's answer deadline (8 s, with room), above the halt read's longest bound (5 s) — within its interval", () => {
    const scrapeTimeoutMs = controlApiScrapeTimeoutMs();
    expect(scrapeTimeoutMs).toBe(10_000);
    expect(READ_REFRESH_DEADLINE_MS).toBe(8_000);
    expect(READ_REFRESH_DEADLINE_MS + 2_000).toBeLessThanOrEqual(scrapeTimeoutMs);
    expect(TRADER_HALT_READ_TIMEOUT_MAX_MS).toBe(5_000);
    expect(TRADER_HALT_READ_TIMEOUT_MAX_MS + 2_000).toBeLessThanOrEqual(READ_REFRESH_DEADLINE_MS);
    expect(scrapeTimeoutMs).toBeLessThanOrEqual(seconds(controlApiJob(), "scrape_interval"));
  });
});

describe("the SHIPPED bundle, run with node: CTL2-L2 (SIGTERM exits while a frozen database and a silent trader hold it) and CONTROL2-R2-C1 / CTL2-R3-L1 (a URL the driver would rewrite, or whose password it would cut at a NUL, is refused)", () => {
  let bundle: BuiltBundle | undefined;
  let directory = "";
  beforeAll(async () => {
    bundle = await buildShippedBundle();
    directory = await mkdtemp(join(tmpdir(), "ctl2-l2-bundle-"));
  }, 120_000);
  afterAll(async () => {
    removeBundle(bundle);
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  /** Writes the bundle's configuration: `traderHalts` postgres, and `traderHealth` as given. */
  async function configWith(traderHealth: unknown): Promise<string> {
    const config = join(directory, "control-api.json");
    await writeFile(
      config,
      JSON.stringify({
        bindHost: "127.0.0.1",
        bindPort: 0,
        maxRequestBodyBytes: 65_536,
        auditCapacity: 64,
        auditSafetyReserve: 4,
        traderHealth,
        traderHalts: { kind: "postgres", timeoutMs: 400 },
        operators: OPERATORS.map((operator) => ({ ...operator, grants: [...operator.grants] })),
      }),
      "utf8",
    );
    return config;
  }

  it("SIGTERM: the pool's connection is ended at the close bound, and the process exits 0 — it waits neither for the database nor for a trader read still within its 60 s bound (CTL2-R2-L3: only the exit port ends it)", async () => {
    const frozen = await frozenPostgres();
    // CTL2-R2-L3: a trader that never answers, read with a 60 s bound. Its read is still outstanding at
    // SIGTERM, and its socket keeps the event loop alive: only the shipped `exit` port can end the process
    // within the stop's bounds — without it, the process lives until SIGKILL.
    const openTraderSockets = new Set<Socket>();
    const silentTrader = createHttpServer(() => undefined);
    silentTrader.on("connection", (socket: Socket) => {
      openTraderSockets.add(socket);
      socket.on("close", () => openTraderSockets.delete(socket));
    });
    await new Promise<void>((resolveListen) => silentTrader.listen(0, "127.0.0.1", () => resolveListen()));
    const traderAddress = silentTrader.address();
    const traderPort = typeof traderAddress === "object" && traderAddress !== null ? traderAddress.port : 0;
    const config = await configWith({ kind: "http", url: `http://127.0.0.1:${String(traderPort)}/health`, timeoutMs: 60_000 });
    const running = await startShippedBundle(bundle?.file ?? "", {
      ...SAFE_PAPER_ENVIRONMENT,
      CONTROL_API_CONFIG: config,
      [TRADER_HALTS_DATABASE_URL_ENV]: `postgres://halt_reader:not-a-credential@127.0.0.1:${String(frozen.port)}/x`,
    });
    try {
      // Answered at the answer deadline: the halts UNKNOWN at their bound, the trader not current.
      const health = JSON.parse((await get(running.port, "/v1/health")).body) as {
        current: unknown;
        traderHalts: Record<string, unknown>;
      };
      expect(health.traderHalts["state"]).toBe("UNKNOWN");
      expect(health.current).toBe(false);
      expect(frozen.open()).toBe(1);
      // The trader read is outstanding: the process holds an open socket to the silent trader.
      expect(openTraderSockets.size).toBe(1);
      const began = Date.now();
      // SIGTERM, and SIGKILL only if it is still alive well past both bounds.
      const exit = await running.stop(TRADER_HALTS_CLOSE_WAIT_MS + 5_000);
      const elapsed = Date.now() - began;
      expect(exit.signal, exit.stdout).toBeNull();
      expect(exit.code, exit.stdout).toBe(0);
      expect(exit.stdout).toContain("ending the 1 connection(s) it still holds");
      expect(exit.stdout).toContain("control API stopped.");
      expect(elapsed).toBeLessThan(TRADER_HALTS_CLOSE_WAIT_MS + TRADER_HALTS_TERMINATE_WAIT_MS + 2_000);
      // The process is gone, and the trader read with it.
      expect(await until(() => openTraderSockets.size === 0, 2_000)).toBe(true);
    } finally {
      if (running.alive()) await running.stop(0);
      for (const socket of openTraderSockets) socket.destroy();
      await new Promise<void>((resolveClose) => silentTrader.close(() => resolveClose()));
      await frozen.close();
    }
  }, 60_000);

  it("CONTROL2-R2-C1 / CTL2-R3-L1: the bundle refuses both URL forms the driver would rewrite, and both whose password it would cut at a NUL (78), serving or --check, before any connection and printing neither the password nor what the server would read", async () => {
    const config = await configWith({ kind: "none" });
    for (const [password, driverWouldSend] of [
      ["Fake%2FSecret Word-ctl2-r2", "Fake%2FSecret Word-ctl2-r2"],
      ["Ec%41%zz-nac-ctl2-r2", "EcA%zz-nac-ctl2-r2"],
      // `CTL2-R3-L1`: the server would read each password up to its NUL, and echo that prefix.
      ["Fk-embedded-ctl2-r3%00secret", "Fk-embedded-ctl2-r3"],
      ["Full-pw-ctl2-r3%00", "Full-pw-ctl2-r3"],
    ] as const) {
      const echoing = await echoingPostgres();
      try {
        // `--check` first: a bundle that admitted the URL would exit 0 at once there, where serving would not exit.
        for (const args of [["--check"], []]) {
          const exit = await runShippedBundle(bundle?.file ?? "", args, {
            ...SAFE_PAPER_ENVIRONMENT,
            CONTROL_API_CONFIG: config,
            [TRADER_HALTS_DATABASE_URL_ENV]: `postgres://halt_reader:${password}@127.0.0.1:${String(echoing.port)}/polymarket_bot`,
          });
          const said = `${exit.stdout}${exit.stderr}`;
          for (const secret of [password, driverWouldSend, "halt_reader"]) expect(said, `${password} ${args.join(" ")}`).not.toContain(secret);
          expect(exit.code, said).toBe(EXIT_CODES.configurationRefused);
          expect(exit.stdout).toContain("[CONTROL_TRADER_HALTS_URL_ENCODING]");
          expect(exit.stdout).not.toContain("control API listening");
        }
        expect(echoing.connections(), password).toBe(0);
      } finally {
        await echoing.close();
      }
    }
  }, 60_000);
});

/** The `control-api` job of `infra/prometheus/control-api-scrape.yaml`, comments removed. */
function controlApiJob(): string {
  const source = readFileSync(resolve(REPO_ROOT, "infra/prometheus/control-api-scrape.yaml"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
  return /- job_name: "control-api"\n[\s\S]*?(?=\n {2}- job_name: |$)/u.exec(source)?.[0] ?? "";
}

/** A `<key>: <n>s` duration of the job, in milliseconds; NaN when the job does not state it. */
function seconds(job: string, key: string): number {
  const value = new RegExp(`^ +${key}: (\\d+)s$`, "mu").exec(job)?.[1];
  return value === undefined ? Number.NaN : Number(value) * 1_000;
}

/** The control-api job's stated `scrape_timeout`, in milliseconds (NaN when it relies on the default). */
function controlApiScrapeTimeoutMs(): number {
  return seconds(controlApiJob(), "scrape_timeout");
}

/** An authorized GET; with `timeoutMs`, it gives up (rejects) when no complete answer has arrived by then — as a scrape does. */
function get(port: number, path: string, timeoutMs?: number): Promise<{ status: number; body: string }> {
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
    if (timeoutMs !== undefined) {
      const timer = setTimeout(() => req.destroy(new Error(`no answer to GET ${path} within ${String(timeoutMs)} ms`)), timeoutMs);
      req.on("close", () => clearTimeout(timer));
    }
    req.end();
  });
}
