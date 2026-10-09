/**
 * `C1-OPS` (COMPLEXITY-1, CONTROL-API option (a)) through the SHIPPED
 * composition root: `main.ts`'s `startup()`, serving on a real loopback socket
 * from a written configuration file.
 *
 * No running trader reads this process's controls, so the shipped process
 * composes `mutationsReachTrader: false`. Pinned here:
 *
 * - every mutating route (pause, resume, kill-switch engage, release) answers
 *   `501 CONTROL_NOT_WIRED`, telling the operator to stop the trader with
 *   Ctrl-C or SIGTERM, and nothing is engaged;
 * - each of those refusals is AUDITED: one `REFUSED` record per request;
 * - authorization still comes first: an operator without the route's grant
 *   gets `403 CONTROL_UNAUTHORIZED` and writes no record;
 * - the by-name mode-raise refusal still comes first: `403
 *   CONTROL_MODE_RAISE_REFUSED`, audited as a mode-raise attempt.
 *
 * The engage and release sequences `test/integration/control-api/
 * shipped-root-engage-reserve.test.ts` drove through the shipped root
 * (`CONTROL1-J-M1`) are unreachable there now; `engage-reserve.test.ts` keeps
 * driving them over HTTP through `support/client.ts`, which composes
 * `mutationsReachTrader: true`.
 *
 * Shutdown follows `test/integration/control-api/shipped-root-control-1.test.ts`:
 * `startup()` installs `process.once("SIGINT", …)` and returns no handle, so
 * the test emits SIGINT.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startup } from "./main.js";

const READER = "fake-paper-reader-token-not-a-credential-c1ops-0001";
const HOLDER = "fake-paper-holder-token-not-a-credential-c1ops-0002";

const SAFE_ENV = {
  RUN_MODE: "PAPER",
  MAX_RUN_MODE: "PAPER",
  ALLOW_REAL_ORDERS: "false",
  LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
  LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
} as const;

/** The four mutating routes, a body each would accept, and the audit action each records. */
const MUTATIONS = [
  { path: "/v1/strategies/sb-1/pause", action: "STRATEGY_PAUSE", body: { reason: "pause it" } },
  { path: "/v1/strategies/sb-1/resume", action: "STRATEGY_RESUME", body: { reason: "resume it" } },
  {
    path: "/v1/kill-switch",
    action: "KILL_SWITCH_ENGAGE",
    body: { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "incident: halt everything" },
  },
  {
    path: "/v1/kill-switch/release",
    action: "KILL_SWITCH_RELEASE",
    body: { scope: "GLOBAL", scopeRef: null, authoritativeSnapshotApplied: true, reason: "reconciled" },
  },
] as const;

function call(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
        },
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const fieldOf = (body: string, key: string): unknown => (JSON.parse(body) as Record<string, unknown>)[key];

let directory = "";
afterEach(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
  directory = "";
});

/** Starts the SHIPPED process, runs `body` against its port, then stops it. */
async function withShippedProcess(body: (port: number) => Promise<void>): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), "c1-ops-shipped-"));
  const configPath = join(directory, "control-api.json");
  await writeFile(
    configPath,
    JSON.stringify({
      bindHost: "127.0.0.1",
      bindPort: 0,
      maxRequestBodyBytes: 65_536,
      auditCapacity: 64,
      auditSafetyReserve: 2,
      traderHealth: { kind: "none" },
      traderHalts: { kind: "none" },
      operators: [
        { operatorId: "reader-b", token: READER, grants: ["READ"] },
        { operatorId: "holder-a", token: HOLDER, grants: ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] },
      ],
    }),
    "utf8",
  );
  const lines: string[] = [];
  const code = await startup(
    {
      env: { ...SAFE_ENV, CONTROL_API_CONFIG: configPath },
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
  try {
    await body(port);
  } finally {
    expect(process.listenerCount("SIGINT")).toBe(1);
    process.emit("SIGINT");
    for (let i = 0; i < 50 && !lines.includes("control API stopped."); i += 1) await sleep(20);
    expect(lines).toContain("control API stopped.");
  }
}

describe("C1-OPS: the shipped PAPER process answers every mutating route 501 CONTROL_NOT_WIRED", () => {
  it("501 on all four routes, one REFUSED audit record each, and nothing engaged", async () => {
    await withShippedProcess(async (port) => {
      for (const mutation of MUTATIONS) {
        const response = await call(port, "POST", mutation.path, HOLDER, mutation.body);
        expect(response.status, mutation.path).toBe(501);
        expect(fieldOf(response.body, "code"), mutation.path).toBe("CONTROL_NOT_WIRED");
        expect(String(fieldOf(response.body, "detail")), mutation.path).toMatch(/Ctrl-C or send it SIGTERM/u);
      }
      const switches = await call(port, "GET", "/v1/kill-switch", READER);
      expect(fieldOf(switches.body, "killSwitches")).toEqual([]);

      const metrics = (await call(port, "GET", "/v1/metrics", READER)).body;
      expect(metrics).toContain("control_audit_records 4");
      for (const mutation of MUTATIONS) {
        expect(metrics).toContain(`control_mutations_total{action="${mutation.action}",outcome="REFUSED"} 1`);
      }
      expect(metrics).not.toContain('outcome="APPLIED"');
      expect(metrics).toContain("control_kill_switches_active 0");
    });
  }, 30_000);

  it("403 before 501: an operator without the route's grant is refused authorization and writes no record", async () => {
    await withShippedProcess(async (port) => {
      for (const mutation of MUTATIONS) {
        const response = await call(port, "POST", mutation.path, READER, mutation.body);
        expect(response.status, mutation.path).toBe(403);
        expect(fieldOf(response.body, "code"), mutation.path).toBe("CONTROL_UNAUTHORIZED");
      }
      const metrics = (await call(port, "GET", "/v1/metrics", READER)).body;
      expect(metrics).toContain("control_audit_records 0");
    });
  }, 30_000);

  it("mode-raise before 501: a body naming a run mode is refused by name on every mutating route", async () => {
    await withShippedProcess(async (port) => {
      for (const mutation of MUTATIONS) {
        const response = await call(port, "POST", mutation.path, HOLDER, { ...mutation.body, runMode: "LIVE" });
        expect(response.status, mutation.path).toBe(403);
        expect(fieldOf(response.body, "code"), mutation.path).toBe("CONTROL_MODE_RAISE_REFUSED");
      }
      const metrics = (await call(port, "GET", "/v1/metrics", READER)).body;
      expect(metrics).toContain('control_mutations_total{action="MODE_RAISE_ATTEMPT",outcome="REFUSED"} 4');
      expect(metrics).toContain("control_audit_records 4");
      for (const mutation of MUTATIONS) expect(metrics).not.toContain(`action="${mutation.action}"`);
    });
  }, 30_000);
});
