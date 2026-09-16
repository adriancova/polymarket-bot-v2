/**
 * `TRDR-3` REPRODUCTION — the shipped control API never reads its `http`
 * trader-health source (`WP-240` r1 M-2, `GOV-2B` N8).
 *
 * At base `b3a829c` the control API ACCEPTS an `http` trader health source,
 * VALIDATES its URL as loopback, constructs `TraderHealthCache` around it
 * (`main.ts:174`) — and nothing ever calls `refresh()`: the only occurrence of
 * `refresh()` in `apps/control-api/src` outside a test is its own declaration
 * (`health-source.ts:242`). This file drives the SHIPPED `startup()` with
 * `serve: true` against a counting stub on the loopback and asserts the defect
 * as it stands: ZERO requests to the stub over 1.5 s of serving and two
 * authorized reads, and `control_trader_health_available 0` on `/v1/metrics`.
 *
 * THIS IS THE PIN THAT FLIPS. The round that wires the refresh rewrites the
 * assertions below to the wired behaviour; a reader of the history sees the
 * same drive measure both states.
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
          }),
      });
    });
  });
}

function get(
  port: number,
  path: string,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
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
async function startShipped(stubPort: number, directory: string): Promise<{ port: number; lines: string[] }> {
  const configPath = join(directory, "control-api.json");
  await writeFile(
    configPath,
    JSON.stringify({
      bindHost: "127.0.0.1",
      bindPort: 0,
      maxRequestBodyBytes: 65_536,
      auditCapacity: 64,
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

describe("REPRODUCTION at base: the shipped control API never reads its `http` health source", () => {
  let directory = "";
  afterEach(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("serves for 1.5 s, answers two authorized reads, and the stub receives ZERO requests; available stays 0", async () => {
    directory = await mkdtemp(join(tmpdir(), "trdr3-control-api-"));
    const stub = await startStub();
    const { port, lines } = await startShipped(stub.port, directory);
    try {
      expect(lines.join("\n")).toContain("trader health source http");
      await sleep(1500);
      expect(stub.hits()).toBe(0);

      const metrics = await get(port, "/v1/metrics");
      expect(metrics.status).toBe(200);
      expect(metrics.body).toContain("control_trader_health_available 0");
      expect(metrics.body).not.toContain("control_trader_health_reads_total");
      expect(metrics.body).not.toContain("trader_events_accepted_total");

      const health = await get(port, "/v1/health");
      expect(health.status).toBe(200);
      expect((JSON.parse(health.body) as { available: boolean }).available).toBe(false);

      // Two reads later, still nothing asked the trader.
      expect(stub.hits()).toBe(0);
    } finally {
      await stopShipped(lines);
      await stub.close();
    }
  }, 30_000);
});
