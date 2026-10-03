/**
 * `TRDR-3` — the shipped control API reads its `http` trader-health source.
 *
 * ## The reproduction this file started as (`WP-240` r1 M-2, `GOV-2B` N8)
 *
 * At base `b3a829c` the control API ACCEPTED an `http` trader health source,
 * VALIDATED its URL as loopback, constructed `TraderHealthCache` around it
 * (`main.ts:174`) — and nothing ever called `refresh()`: the only occurrence
 * of `refresh()` in `apps/control-api/src` outside a test was its own
 * declaration (`health-source.ts:242`). The first commit of this file
 * (`5742c4d`) drove the SHIPPED `startup()` with `serve: true` against a
 * counting stub on the loopback and measured ZERO requests over 1.5 s of
 * serving plus two authorized reads, `control_trader_health_available 0`, no
 * `control_trader_health_reads_total` line and no `trader_*` family on
 * `/v1/metrics`.
 *
 * ## What it pins now — the same drive, the assertions flipped
 *
 * The source is read on an authorized `/v1/metrics` and `/v1/health`
 * (refresh-on-read, `api.ts` header) and NOT unprompted; the trader families
 * have producer lines; and when the stub goes away the read is COUNTED as
 * `UNAVAILABLE` while the last good report is RETAINED — `health-source.ts`'s
 * documented semantics, unchanged, so `control_trader_health_available` STAYS
 * 1 and the freshness signal is `control_trader_health_current`, which drops
 * to 0. An anonymous caller never causes a trader request.
 *
 * ## Why a stub, here
 *
 * This file is about the control API's own wiring, and a stub whose request
 * count is the instrument is the honest way to measure "did the shipped
 * process ask". The trader's REAL health server is on the other end of the
 * REAL `HttpTraderHealthSource` in `trader-health-http-source.test.ts` (this
 * directory) and of the real composition root in
 * `test/integration/paper-trader/trader-health-endpoint-postgres.test.ts`.
 *
 * ## Shutdown
 *
 * `startup()` returns once it is serving and hands back no handle; it installs
 * `process.once("SIGINT", shutdown)`. The vitest worker registers no SIGINT
 * listener of its own (measured: `process.listenerCount("SIGINT") === 0`), so
 * `process.emit("SIGINT")` reaches exactly the control API's handler.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HealthState } from "@polymarket-bot/trader";
import { afterEach, describe, expect, it } from "vitest";

import { startup } from "../../../apps/control-api/src/main.js";

const TOKEN = "fake-paper-operator-token-not-a-credential-trdr3-0001";

function realHealthDocument(): unknown {
  const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
  state.countLoop("eventsAccepted", 3);
  state.countAccounting("pnlRecords", 1);
  return JSON.parse(
    JSON.stringify(
      state.snapshot({
        asOf: "2026-09-16T00:00:10Z",
        halts: [],
        queues: [],
        seams: {
          fills: { remembered: 0, maximumRemembered: 1, admitted: 0, refused: 0, evictions: 0 },
          reservations: { open: 0, taken: 0, released: 0, reservedCollateral: "0" },
          cancels: { pending: 0, requested: 0, confirmed: 0, rejected: 0, silenceExceeded: 0 },
          orderViews: { emitted: 0, repeats: 0, tracked: 0 },
          allocator: { open: 0, applied: 0, released: 0, reservedCollateral: "0", refusalsByCode: {} },
          // `TRDR-4`: the two seams `CoreLoop.health()` always publishes, which the
          // control API's door requires.
          orders: {
            tracked: 0,
            settled: 0,
            tombstones: 0,
            maximumTombstones: 100_000,
            tombstoneEvictions: 0,
            unownedFills: 0,
            lateFillsAfterSettlement: 0,
            settleMismatches: 0,
          },
          retention: {
            decisions: { retained: 0, maximumRetained: 100_000, evicted: 0 },
            traces: { retained: 0, maximumRetained: 50_000, evicted: 0 },
            provenance: { retained: 0, maximumRetained: 50_000, evicted: 0 },
          },
          // `FOLD-1`: the seam `CoreLoop.health()` also always publishes — the
          // loop's held accounting state and its rebuild checks.
          folds: {
            checkEveryFills: 50,
            pnlCheck: false,
            fillsPosted: 0,
            ledgerChecks: 0,
            pnlChecks: 0,
            fillsAtLastCheck: null,
            ledgerMismatches: 0,
            pnlMismatches: 0,
            pnlRefusals: {},
          },
        },
      }),
    ),
  );
}

interface Stub {
  readonly port: number;
  hits(): number;
  close(): Promise<void>;
}

function startStub(): Promise<Stub> {
  let hits = 0;
  const body = JSON.stringify(realHealthDocument());
  const server: Server = createServer((request, response) => {
    hits += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        hits: () => hits,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** `token: null` sends no credential at all (a default parameter would re-admit `TOKEN` on `undefined`). */
function get(
  port: number,
  path: string,
  token: string | null = TOKEN,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the SHIPPED process on a written configuration; returns its port. */
async function startShipped(
  stubPort: number,
  directory: string,
): Promise<{ port: number; lines: string[] }> {
  const configPath = join(directory, "control-api.json");
  await writeFile(
    configPath,
    JSON.stringify({
      bindHost: "127.0.0.1",
      bindPort: 0,
      maxRequestBodyBytes: 65_536,
      auditCapacity: 64,
      auditSafetyReserve: 4,
      traderHealth: { kind: "http", url: `http://127.0.0.1:${String(stubPort)}/health`, timeoutMs: 2000 },
      operators: [{ operatorId: "trdr3-operator", token: TOKEN, grants: ["READ"] }],
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
  const listening = lines.find((line) => line.startsWith("control API listening on 127.0.0.1:"));
  const port = Number(/127\.0\.0\.1:(\d+)/u.exec(listening ?? "")?.[1] ?? "0");
  expect(port).toBeGreaterThan(0);
  return { port, lines };
}

async function stopShipped(lines: string[]): Promise<void> {
  expect(process.listenerCount("SIGINT")).toBe(1);
  process.emit("SIGINT");
  for (let i = 0; i < 50 && !lines.includes("control API stopped."); i += 1) await sleep(20);
  expect(lines).toContain("control API stopped.");
}

describe("the SHIPPED control API reads its `http` trader health source (TRDR-3; the WP-240 M-2 pin, flipped)", () => {
  let directory = "";
  afterEach(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("reads on an authorized metrics read, never unprompted; counts the source going away and RETAINS the last good report", async () => {
    directory = await mkdtemp(join(tmpdir(), "trdr3-control-api-"));
    const stub = await startStub();
    const { port, lines } = await startShipped(stub.port, directory);
    try {
      expect(lines.join("\n")).toContain("is read on every authorized /v1/health and /v1/metrics request");

      // Nothing is read unprompted (no timer): 300 ms of serving, zero asks.
      await sleep(300);
      expect(stub.hits()).toBe(0);

      // An authorized READ of the metrics surface refreshes the cache first.
      const first = await get(port, "/v1/metrics");
      expect(first.status).toBe(200);
      expect(stub.hits()).toBe(1);
      expect(first.body).toContain("control_trader_health_available 1");
      expect(first.body).toContain("control_trader_health_current 1");
      expect(first.body).toContain('control_trader_health_reads_total{outcome="OK"} 1');
      // …and the trader families the dashboards name now have producer lines.
      expect(first.body).toContain("trader_events_accepted_total 3");
      expect(first.body).toContain("trader_pnl_records_total 1");

      // The health read refreshes too, and answers the door's output.
      const health = await get(port, "/v1/health");
      expect(health.status).toBe(200);
      expect(stub.hits()).toBe(2);
      const parsed = JSON.parse(health.body) as {
        available: boolean;
        current: boolean;
        reads: Record<string, number>;
        report: { asOf: string; accounting: { realizedPnl: { account: string | null } } };
        note: string;
      };
      expect(parsed.available).toBe(true);
      expect(parsed.current).toBe(true);
      expect(parsed.reads).toEqual({ OK: 2 });
      expect(parsed.report.asOf).toBe("2026-09-16T00:00:10Z");
      // The real `HealthState` with no book attached says "no snapshot observed".
      expect(parsed.report.accounting.realizedPnl.account).toBeNull();
      expect(parsed.note).toContain("this read refreshed it");

      // The source goes away. The read is COUNTED, the last good report is
      // RETAINED (documented semantics, unchanged), `available` stays 1, and
      // `current` says the retained report is no longer the latest answer.
      await stub.close();
      const after = await get(port, "/v1/metrics");
      expect(after.status).toBe(200);
      expect(after.body).toContain("control_trader_health_available 1");
      expect(after.body).toContain("control_trader_health_current 0");
      expect(after.body).toContain('control_trader_health_reads_total{outcome="OK"} 2');
      expect(after.body).toContain('control_trader_health_reads_total{outcome="UNAVAILABLE"} 1');
      expect(after.body).toContain("trader_events_accepted_total 3");
      const stale = JSON.parse((await get(port, "/v1/health")).body) as {
        available: boolean;
        current: boolean;
        report: { asOf: string };
        note: string;
      };
      expect(stale.available).toBe(true);
      expect(stale.current).toBe(false);
      expect(stale.report.asOf).toBe("2026-09-16T00:00:10Z");
      expect(stale.note).toContain("retained from an earlier one");
    } finally {
      await stopShipped(lines);
    }
  }, 30_000);

  it("an UNAUTHENTICATED request never reaches the source", async () => {
    directory = await mkdtemp(join(tmpdir(), "trdr3-control-api-"));
    const stub = await startStub();
    const { port, lines } = await startShipped(stub.port, directory);
    try {
      expect((await get(port, "/v1/metrics", null)).status).toBe(401);
      expect((await get(port, "/v1/health", "not-the-token-and-not-a-credential-0000000000")).status).toBe(401);
      expect(stub.hits()).toBe(0);
    } finally {
      await stopShipped(lines);
      await stub.close();
    }
  }, 30_000);
});
