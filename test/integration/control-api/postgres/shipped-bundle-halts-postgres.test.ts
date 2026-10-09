/**
 * `CONTROL-2` r1 (the S2 grant) — the SHIPPED control API reads an open
 * trader halt out of a REAL PostgreSQL.
 *
 * Not the source through a test harness: the bundle the package's `build`
 * script makes (`support/shipped-bundle.ts`: the package's own esbuild, the
 * script's own arguments), run with `node` in a child process, configured
 * `traderHalts.kind` `postgres`, its database URL in the ONE environment
 * variable — naming a role that holds exactly the privileges the README asks
 * a deployment for (`USAGE` on `ops`, `SELECT` on `ops.incidents`). The halt
 * row is written by the trader's own production writer.
 *
 * Measured:
 *
 * - `/v1/health` and `/v1/metrics` say OPEN, with the row as the trader wrote
 *   it; resolved by an operator, NONE_OPEN;
 * - the role's privileges are enough, and the read is READ ONLY: the bundle's
 *   sessions are named in `pg_stat_activity`, and every row is unchanged;
 * - the URL and its password appear in nothing the bundle prints or serves —
 *   including when PostgreSQL refuses the password;
 * - a reader connection the server terminates is dropped, and the process
 *   keeps serving: the next read is OPEN again;
 * - SIGTERM stops it, and the pool with it;
 * - (`CTL2-F1`) with both read bounds at the most the configuration admits, a
 *   trader that never answers and `ops.incidents` locked, `/v1/metrics` is
 *   still answered inside the scrape job's `scrape_timeout`, `UNKNOWN 1` — and
 *   `OPEN 1` once the lock goes; SIGTERM then exits 0 at once, the trader
 *   read still outstanding (`CTL2-L2`).
 *
 * Docker is required (`vitest.config.ts` beside this file); nothing skips.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedDatabase,
  createMigratedContext,
  createTradingChain,
  startPostgresContainer,
  type TestContext,
  type TradingChain,
} from "@polymarket-bot/storage-postgres/testing";

import { TRADER_HALT_READ_TIMEOUT_MAX_MS } from "../../../../apps/control-api/src/adapters/postgres-trader-halts.js";
import { READ_REFRESH_DEADLINE_MS } from "../../../../apps/control-api/src/api.js";
import { TRADER_HALTS_APPLICATION_NAME, TRADER_HALTS_DATABASE_URL_ENV } from "../../../../apps/control-api/src/main.js";
import { PostgresTraderStore } from "../../../../apps/trader/src/adapters/postgres-store.js";
import { haltIncidentRows } from "../../../../apps/trader/src/halt-record.js";
import {
  REPO_ROOT,
  SAFE_PAPER_ENVIRONMENT,
  buildShippedBundle,
  removeBundle,
  startShippedBundle,
  type BuiltBundle,
  type RunningBundle,
} from "../support/shipped-bundle.js";

const TOKEN = "fake-paper-operator-token-not-a-credential-ctl2-r1b1";
const ROLE = "control_api_halt_reader";
const PASSWORD = "Rd7-not-a-credential-ctl2-r1-bundle";

let container: Awaited<ReturnType<typeof startPostgresContainer>> | undefined;
let context: TestContext | undefined;
let chain: TradingChain | undefined;
let bundle: BuiltBundle | undefined;
let directory = "";
let readerUrl = "";

function database(): TestContext {
  if (context === undefined) throw new Error("the PostgreSQL context was not created");
  return context;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const isolated = await createIsolatedDatabase(container.getConnectionUri(), "control_2_r1_bundle");
  context = await createMigratedContext(isolated.connectionString);
  chain = await createTradingChain(context);
  // The deployment's duty (README, "Configuring the read"), and nothing more.
  const admin = context.pool;
  await admin.query(`create role ${ROLE} login password '${PASSWORD}'`);
  await admin.query(`grant usage on schema ops to ${ROLE}`);
  await admin.query(`grant select on ops.incidents to ${ROLE}`);
  const url = new URL(isolated.connectionString);
  url.username = ROLE;
  url.password = PASSWORD;
  readerUrl = url.toString();
  bundle = await buildShippedBundle();
  directory = mkdtempSync(join(tmpdir(), "control-2-r1-bundle-pg-"));
});

afterAll(async () => {
  removeBundle(bundle);
  if (directory !== "") rmSync(directory, { recursive: true, force: true });
  if (context !== undefined) {
    await context.pool.query(`select pg_terminate_backend(pid) from pg_stat_activity where usename = $1`, [ROLE]).catch(() => undefined);
    await context.close();
  }
  await container?.stop();
});

/** The trader's own production write of one GLOBAL halt (the path `startup()` runs before it exits 75). */
async function traderHalts(): Promise<void> {
  const store = new PostgresTraderStore({
    db: database().db,
    decisionContractVersion: 1,
    accountRef: "paper-account",
    pool: database().pool,
  });
  const rows = haltIncidentRows(
    [{ scope: { kind: "GLOBAL" }, code: "TRANSPORT_UNAVAILABLE", detail: "redis did not answer", at: "2026-10-04T00:00:01.000Z" }],
    { accountRef: "paper-account", instanceIds: [chain?.instanceId ?? ""] },
  );
  expect(await store.recordHalts(rows, 5_000)).toEqual({ status: "written", rows: 1 });
}

/** Starts the built bundle, configured `postgres`, its URL in the one variable; `traderHealth` `none` unless given. */
async function startBundle(
  url: string,
  options: { readonly traderHealth?: unknown; readonly haltTimeoutMs?: number } = {},
): Promise<RunningBundle> {
  const config = join(directory, `control-api-${String(Date.now())}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      bindHost: "127.0.0.1",
      bindPort: 0,
      maxRequestBodyBytes: 65_536,
      auditCapacity: 64,
      auditSafetyReserve: 4,
      traderHealth: options.traderHealth ?? { kind: "none" },
      traderHalts: { kind: "postgres", timeoutMs: options.haltTimeoutMs ?? 2_000 },
      operators: [{ operatorId: "ctl2-r1-reader", token: TOKEN, grants: ["READ"] }],
    }),
    "utf8",
  );
  return await startShippedBundle(bundle?.file ?? "", {
    ...SAFE_PAPER_ENVIRONMENT,
    CONTROL_API_CONFIG: config,
    [TRADER_HALTS_DATABASE_URL_ENV]: url,
  });
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

/** The control-api job's stated `scrape_timeout` (`infra/prometheus/control-api-scrape.yaml`), in milliseconds; NaN when unstated. */
function scrapeTimeoutMs(): number {
  const job =
    /- job_name: "control-api"\n[\s\S]*?(?=\n {2}- job_name: |$)/u.exec(
      readFileSync(join(REPO_ROOT, "infra", "prometheus", "control-api-scrape.yaml"), "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/u.test(line))
        .join("\n"),
    )?.[0] ?? "";
  const seconds = /^ +scrape_timeout: (\d+)s$/mu.exec(job)?.[1];
  return seconds === undefined ? Number.NaN : Number(seconds) * 1_000;
}

interface HaltsSection {
  readonly state: string;
  readonly configured: boolean;
  readonly openTotal: number | null;
  readonly openByScope: Record<string, number> | null;
  readonly listed: readonly Record<string, unknown>[] | null;
  readonly detail: string | null;
  readonly reads: Record<string, number>;
}

async function halts(running: RunningBundle): Promise<HaltsSection & { readonly raw: string }> {
  const response = await get(running.port, "/v1/health");
  expect(response.status).toBe(200);
  return { ...(JSON.parse(response.body) as { traderHalts: HaltsSection }).traderHalts, raw: response.body };
}

describe("the SHIPPED bundle reads an open trader halt from a real PostgreSQL (CONTROL-2 r1, S2)", () => {
  it("OPEN in /v1/health and /v1/metrics through a role with USAGE on ops and SELECT on ops.incidents only; NONE_OPEN once resolved; nothing written; the URL printed nowhere", async () => {
    await traderHalts();
    const before = (await database().pool.query("select * from ops.incidents order by incident_id")).rows;
    const running = await startBundle(readerUrl);
    const served: string[] = [];
    try {
      const open = await halts(running);
      served.push(open.raw);
      expect(open.state).toBe("OPEN");
      expect(open.configured).toBe(true);
      expect(open.openTotal).toBe(1);
      expect(open.openByScope).toEqual({ GLOBAL: 1, MARKET: 0, STRATEGY_INSTANCE: 0, UNRECOGNIZED: 0 });
      expect(open.listed?.[0]).toMatchObject({
        incidentKey: "TRADER_HALT:GLOBAL",
        status: "OPEN",
        severity: "PAGE",
        environment: "PAPER",
        failureClass: "TRANSPORT_UNAVAILABLE",
        detail: "redis did not answer",
        irregularities: [],
      });
      // C1-HALTS: no action is shown (the trader writes it NULL).
      expect(open.listed?.[0] !== undefined && "action" in open.listed[0]).toBe(false);
      const metrics = await get(running.port, "/v1/metrics");
      served.push(metrics.body);
      expect(metrics.status).toBe(200);
      expect(metrics.body).toContain('control_trader_halts_state{state="OPEN"} 1');
      expect(metrics.body).toContain('control_trader_halts_state{state="UNKNOWN"} 0');
      expect(metrics.body).toContain('control_trader_halts_open{scope="GLOBAL"} 1');
      expect(metrics.body).toContain('control_trader_halt_reads_total{outcome="OK"} 2');

      // The bundle's sessions are the reader role's, named, and wrote nothing.
      const sessions = (
        await database().pool.query("select distinct usename, application_name from pg_stat_activity where usename = $1", [ROLE])
      ).rows as { usename: string; application_name: string }[];
      expect(sessions).toEqual([{ usename: ROLE, application_name: TRADER_HALTS_APPLICATION_NAME }]);
      expect((await database().pool.query("select * from ops.incidents order by incident_id")).rows).toEqual(before);

      // An operator resolves the row (the ADMIN handle; the control API never does).
      await database().pool.query(
        "update ops.incidents set status = 'RESOLVED', resolution = 'operator resolved it', resolved_at = now() where incident_key = 'TRADER_HALT:GLOBAL'",
      );
      const resolved = await halts(running);
      served.push(resolved.raw);
      expect(resolved.state).toBe("NONE_OPEN");
      expect(resolved.openTotal).toBe(0);
      expect((await get(running.port, "/v1/metrics")).body).toContain('control_trader_halts_state{state="NONE_OPEN"} 1');
    } finally {
      const exit = await running.stop();
      expect(exit.stdout).toContain("control API stopped.");
      const printed = `${exit.stdout}\n${exit.stderr}`;
      for (const text of [printed, ...served]) {
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(readerUrl);
      }
      expect(exit.stdout).toContain(`from the database ${TRADER_HALTS_DATABASE_URL_ENV} names (its value is never logged)`);
      await database().pool.query("delete from ops.incidents");
    }
  }, 120_000);

  it("a reader connection the SERVER terminates is dropped, the process keeps serving, and the next read is OPEN again", async () => {
    await traderHalts();
    const running = await startBundle(readerUrl);
    try {
      expect((await halts(running)).state).toBe("OPEN");
      const terminated = (
        await database().pool.query("select pg_terminate_backend(pid) as done from pg_stat_activity where usename = $1", [ROLE])
      ).rows as { done: boolean }[];
      expect(terminated.length).toBeGreaterThan(0);
      // The idle client's `error` event reaches the pool's listener, not an unhandled throw.
      for (let i = 0; i < 50 && !running.output().stdout.includes("an idle ops.incidents connection failed"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(running.output().stdout).toContain("an idle ops.incidents connection failed and was dropped");
      expect(running.alive()).toBe(true);
      const again = await halts(running);
      expect(again.state).toBe("OPEN");
      expect(again.openTotal).toBe(1);
      expect(running.output().stdout).not.toContain(PASSWORD);
    } finally {
      const exit = await running.stop();
      expect(exit.stdout).toContain("control API stopped.");
      expect(`${exit.stdout}${exit.stderr}`).not.toContain(PASSWORD);
      await database().pool.query("delete from ops.incidents");
    }
  }, 120_000);

  it("CTL2-F1: both read bounds at their most, a trader that NEVER answers and ops.incidents LOCKED — every scrape is answered inside its scrape_timeout: UNKNOWN 1, then OPEN 1; SIGTERM then exits 0 at once", async () => {
    await traderHalts();
    const timeoutMs = scrapeTimeoutMs();
    expect(timeoutMs).toBe(10_000);
    const traderSockets = new Set<Socket>();
    const silentTrader = createHttpServer(() => undefined);
    silentTrader.on("connection", (socket: Socket) => {
      traderSockets.add(socket);
    });
    await new Promise<void>((resolveListen) => silentTrader.listen(0, "127.0.0.1", () => resolveListen()));
    const address = silentTrader.address();
    const traderPort = typeof address === "object" && address !== null ? address.port : 0;
    const locker = await database().pool.connect();
    let running: RunningBundle | undefined;
    try {
      await locker.query("begin");
      await locker.query("lock table ops.incidents in access exclusive mode");
      running = await startBundle(readerUrl, {
        haltTimeoutMs: TRADER_HALT_READ_TIMEOUT_MAX_MS,
        traderHealth: { kind: "http", url: `http://127.0.0.1:${String(traderPort)}/health`, timeoutMs: 60_000 },
      });
      const began = Date.now();
      const locked = await get(running.port, "/v1/metrics", timeoutMs);
      const elapsed = Date.now() - began;
      expect(locked.status).toBe(200);
      expect(elapsed).toBeLessThan(timeoutMs);
      expect(elapsed).toBeGreaterThanOrEqual(READ_REFRESH_DEADLINE_MS - 100);
      expect(locked.body).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
      expect(locked.body).toContain('control_trader_halts_state{state="NONE_OPEN"} 0');
      expect(locked.body).not.toContain("control_trader_halts_open");
      expect(locked.body).toContain("control_trader_health_current 0");

      // The lock goes; the trader still says nothing. The next scrape reads the row.
      await locker.query("rollback");
      const unlocked = await get(running.port, "/v1/metrics", timeoutMs);
      expect(unlocked.status).toBe(200);
      expect(unlocked.body).toContain('control_trader_halts_state{state="OPEN"} 1');
      expect(unlocked.body).toContain('control_trader_halts_open{scope="GLOBAL"} 1');
      expect(traderSockets.size).toBeGreaterThan(0);

      // CTL2-L2: the trader read is still outstanding (its bound is 60 s); the stop does not wait for it.
      const stopping = Date.now();
      const exit = await running.stop(10_000);
      expect(exit.signal, exit.stdout).toBeNull();
      expect(exit.code, exit.stdout).toBe(0);
      expect(Date.now() - stopping).toBeLessThan(5_000);
      expect(exit.stdout).toContain("control API stopped.");
      expect(`${exit.stdout}${exit.stderr}`).not.toContain(PASSWORD);
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
      if (running?.alive() === true) await running.stop(0);
      for (const socket of traderSockets) socket.destroy();
      await new Promise<void>((resolveClose) => silentTrader.close(() => resolveClose()));
      await database().pool.query("delete from ops.incidents");
    }
  }, 120_000);

  it("a password PostgreSQL refuses is UNKNOWN — never 'no halts' — and the password is in nothing the bundle prints or serves", async () => {
    await traderHalts();
    const wrong = "Bq2-not-a-credential-ctl2-r1-wrong";
    const url = new URL(readerUrl);
    url.password = wrong;
    const running = await startBundle(url.toString());
    const served: string[] = [];
    try {
      const refused = await halts(running);
      served.push(refused.raw);
      expect(refused.state).toBe("UNKNOWN");
      expect(refused.openTotal).toBeNull();
      expect(refused.detail).toContain("password authentication failed");
      const metrics = await get(running.port, "/v1/metrics");
      served.push(metrics.body);
      expect(metrics.body).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
      expect(metrics.body).not.toContain("control_trader_halts_open");
    } finally {
      const exit = await running.stop();
      for (const text of [`${exit.stdout}\n${exit.stderr}`, ...served]) {
        expect(text).not.toContain(wrong);
        expect(text).not.toContain(url.toString());
      }
      await database().pool.query("delete from ops.incidents");
    }
  }, 120_000);
});
