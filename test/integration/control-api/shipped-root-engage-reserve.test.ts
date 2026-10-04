/**
 * `CONTROL-1` r1 — `CONTROL1-J-M1`'s three sequences through the SHIPPED
 * composition root: `main.ts`'s `startup()`, serving on a real loopback socket
 * from a written configuration file, with the audit budget it builds from the
 * configured reserve.
 *
 * `engage-reserve.test.ts` states the finding and drives the same sequences
 * through `support/client.ts` (with registered instances, so pauses are
 * measured there). This file proves the process an operator RUNS behaves the
 * same: a repeated or weakening engage is refused and spends no reserved
 * record, and a stronger halt still engages. The shipped process registers no
 * strategy instance (`CONTROL-1`, M-1), so the ordinary tier is filled with
 * `CONTROL_UNKNOWN_INSTANCE` refusals — each one an audited ORDINARY record.
 *
 * Shutdown follows `shipped-root-control-1.test.ts`: `startup()` installs
 * `process.once("SIGINT", …)` and returns no handle, so the test emits SIGINT.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startup } from "../../../apps/control-api/src/main.js";

const READER = "fake-paper-reader-token-not-a-credential-r1-shipped-01";
const STRATEGIST = "fake-paper-strategist-token-not-a-credential-r1-shipped-02";
const SWITCHER = "fake-paper-switcher-token-not-a-credential-r1-shipped-03";

const SAFE_ENV = {
  RUN_MODE: "PAPER",
  MAX_RUN_MODE: "PAPER",
  ALLOW_REAL_ORDERS: "false",
  LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
  LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
} as const;

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

let directory = "";
afterEach(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
  directory = "";
});

interface Shipped {
  engage(action: string, scope?: string, scopeRef?: string | null): Promise<string>;
  release(scope?: string, scopeRef?: string | null): Promise<string>;
  fillOrdinary(requests: number): Promise<void>;
  switches(): Promise<readonly string[]>;
  metrics(): Promise<string>;
}

/** Starts the SHIPPED process on `auditCapacity`/`auditSafetyReserve`, runs `body`, then stops it. */
async function withShippedProcess(
  auditCapacity: number,
  auditSafetyReserve: number,
  body: (shipped: Shipped) => Promise<void>,
): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), "control-1-r1-shipped-"));
  const configPath = join(directory, "control-api.json");
  await writeFile(
    configPath,
    JSON.stringify({
      bindHost: "127.0.0.1",
      bindPort: 0,
      maxRequestBodyBytes: 65_536,
      auditCapacity,
      auditSafetyReserve,
      traderHealth: { kind: "none" },
      traderHalts: { kind: "none" },
      operators: [
        { operatorId: "reader-b", token: READER, grants: ["READ"] },
        { operatorId: "strategist-c", token: STRATEGIST, grants: ["READ", "STRATEGY_CONTROL"] },
        { operatorId: "switcher-d", token: SWITCHER, grants: ["READ", "KILL_SWITCH"] },
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
  const answer = (status: number, text: string): string =>
    status === 200 ? "200" : `${String(status)} ${String((JSON.parse(text) as Record<string, unknown>)["code"])}`;

  const shipped: Shipped = {
    engage: async (action, scope = "GLOBAL", scopeRef = null) => {
      const response = await call(port, "POST", "/v1/kill-switch", SWITCHER, {
        scope,
        scopeRef,
        action,
        reason: `engage ${action}`,
      });
      return answer(response.status, response.body);
    },
    release: async (scope = "GLOBAL", scopeRef = null) => {
      const response = await call(port, "POST", "/v1/kill-switch/release", SWITCHER, {
        scope,
        scopeRef,
        authoritativeSnapshotApplied: true,
        reason: "reconciled against a snapshot",
      });
      return answer(response.status, response.body);
    },
    fillOrdinary: async (requests) => {
      for (let index = 0; index < requests; index += 1) {
        const response = await call(port, "POST", `/v1/strategies/unknown-${String(index)}/pause`, STRATEGIST, {
          reason: "filling the ordinary tier",
        });
        expect(response.status).toBe(409);
      }
    },
    switches: async () => {
      const response = await call(port, "GET", "/v1/kill-switch", READER);
      return (
        JSON.parse(response.body) as { killSwitches: readonly { scope: string; scopeRef: string | null; action: string }[] }
      ).killSwitches.map((entry) => `${entry.scope}:${entry.scopeRef ?? ""}:${entry.action}`);
    },
    metrics: async () => (await call(port, "GET", "/v1/metrics", READER)).body,
  };

  try {
    await body(shipped);
  } finally {
    expect(process.listenerCount("SIGINT")).toBe(1);
    process.emit("SIGINT");
    for (let i = 0; i < 50 && !lines.includes("control API stopped."); i += 1) await sleep(20);
    expect(lines).toContain("control API stopped.");
  }
}

describe("CONTROL1-J-M1 through the shipped composition root", () => {
  it("H1a (C=3, R=1): weakening engages are refused, FULL_HALT stands, and new switches still engage", async () => {
    await withShippedProcess(3, 1, async (shipped) => {
      expect([
        await shipped.engage("FULL_HALT"),
        await shipped.release(),
        await shipped.engage("HALT_NEW_ENTRIES"),
        await shipped.engage("HALT_NEW_ENTRIES"),
        await shipped.engage("FULL_HALT"),
      ]).toEqual([
        "200",
        "503 CONTROL_NOT_AUDITABLE",
        "409 CONTROL_ENGAGE_WOULD_WEAKEN",
        "409 CONTROL_ENGAGE_WOULD_WEAKEN",
        "409 CONTROL_ALREADY_IN_STATE",
      ]);
      expect(await shipped.switches()).toEqual(["GLOBAL::FULL_HALT"]);
      expect(await shipped.engage("FULL_HALT", "MARKET", "m-1")).toBe("200");
      expect(await shipped.engage("HALT_NEW_ENTRIES", "MARKET", "m-2")).toBe("200");
      const metrics = await shipped.metrics();
      expect(metrics).toContain("control_audit_records 3");
      expect(metrics).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="APPLIED"} 3');
      expect(metrics).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="NOT_AUDITED"} 3');
    });
  }, 30_000);

  it("H1b (C=12, R=2): identical re-engages are refused, and GLOBAL and MARKET FULL_HALT still engage", async () => {
    await withShippedProcess(12, 2, async (shipped) => {
      await shipped.fillOrdinary(20);
      const repeats: string[] = [];
      for (let index = 0; index < 6; index += 1) repeats.push(await shipped.engage("HALT_NEW_ENTRIES"));
      expect(repeats).toEqual(["200", ...Array<string>(5).fill("409 CONTROL_ALREADY_IN_STATE")]);
      expect(await shipped.engage("FULL_HALT")).toBe("200");
      expect(await shipped.engage("FULL_HALT", "MARKET", "m-1")).toBe("200");
      expect(await shipped.switches()).toEqual(["GLOBAL::FULL_HALT", "MARKET:m-1:FULL_HALT"]);
      expect(await shipped.metrics()).toContain("control_audit_records 11");
    });
  }, 30_000);

  it("H1c (C=12, R=2): with release 503, the weakening engage is refused too", async () => {
    await withShippedProcess(12, 2, async (shipped) => {
      expect(await shipped.engage("FULL_HALT")).toBe("200");
      await shipped.fillOrdinary(20);
      expect(await shipped.release()).toBe("503 CONTROL_NOT_AUDITABLE");
      expect(await shipped.engage("HALT_NEW_ENTRIES")).toBe("409 CONTROL_ENGAGE_WOULD_WEAKEN");
      expect(await shipped.switches()).toEqual(["GLOBAL::FULL_HALT"]);
      expect(await shipped.engage("FULL_HALT", "MARKET", "m-1")).toBe("200");
    });
  }, 30_000);
});
