/**
 * `CONTROL-1` through the SHIPPED composition root — `main.ts`'s `startup()`,
 * serving on a real loopback socket from a written configuration file.
 *
 * Every other suite builds the API through the test harness or
 * `support/client.ts`. Both call `createBudgetedAuditLog` like `main.ts`, but
 * only this file proves that the process an operator RUNS:
 *
 * - puts its audit log behind the budget, with the CONFIGURED reserve (M-3);
 * - registers no strategy instance, and so refuses every pause
 *   `CONTROL_UNKNOWN_INSTANCE` rather than answering for an instance it cannot
 *   control (M-1);
 * - serves on this package's explicit timeouts (L-9).
 *
 * The configuration (capacity 7, reserve 2) gives tiers of 3 ordinary records,
 * pauses up to 5, and engages up to 7. A READ-only operator and an operator
 * holding `STRATEGY_CONTROL` only both try to fill the log; the `KILL_SWITCH`
 * holder's GLOBAL engage must still apply and be audited.
 *
 * Shutdown follows `health-refresh-wiring.test.ts`: `startup()` installs
 * `process.once("SIGINT", …)` and returns no handle, so the test emits SIGINT.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startup } from "../../../apps/control-api/src/main.js";

const READER = "fake-paper-reader-token-not-a-credential-ctl1-0001";
const STRATEGIST = "fake-paper-strategist-token-not-a-credential-ctl1-0002";
const SWITCHER = "fake-paper-switcher-token-not-a-credential-ctl1-0003";

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
const codeOf = (body: string): unknown => (JSON.parse(body) as Record<string, unknown>)["code"];

let directory = "";
afterEach(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
  directory = "";
});

describe("CONTROL-1 through the shipped composition root", () => {
  it("budget wired with the configured reserve; no instance registered; explicit timeouts", async () => {
    directory = await mkdtemp(join(tmpdir(), "control-1-shipped-"));
    const configPath = join(directory, "control-api.json");
    await writeFile(
      configPath,
      JSON.stringify({
        bindHost: "127.0.0.1",
        bindPort: 0,
        maxRequestBodyBytes: 65_536,
        auditCapacity: 7,
        auditSafetyReserve: 2,
        traderHealth: { kind: "none" },
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

    try {
      const log = lines.join("\n");
      expect(log).toContain("audit bound 7 (the last 2 for kill-switch engages, the 2 before them for safety-direction actions)");
      expect(log).toContain("server timeouts: headers 10000ms, request 30000ms, keep-alive 5000ms");
      // `CONTROL-1b` r1 (`CONTROL1B-R1-J-L1`): the plane this process composed
      // bounds every append at the default and writes a VOID beside a late
      // APPLIED record — a composition without the record source would log
      // "NO void record".
      expect(log).toContain(
        "audit append bound 5000ms; an APPLIED record that lands after it gets a VOID record from this " +
          "process's clock and id source, when the sink and the audit budget admit one",
      );

      // A READ-only operator tries the M-3 vector: refused by name, never audited.
      for (let index = 0; index < 5; index += 1) {
        const refused = await call(port, "POST", "/v1/kill-switch", READER, { runMode: "LIVE", reason: "reader" });
        expect(refused.status).toBe(403);
        expect(codeOf(refused.body)).toBe("CONTROL_MODE_RAISE_REFUSED");
      }

      // An operator WITH a mutation grant (not KILL_SWITCH) fills the ordinary tier.
      for (let index = 0; index < 5; index += 1) {
        const refused = await call(port, "POST", "/v1/kill-switch", STRATEGIST, { allowRealOrders: true, reason: "x" });
        expect(refused.status).toBe(403);
      }

      // M-1 in the shipped composition: nothing is registered, so a pause is refused.
      const pause = await call(port, "POST", "/v1/strategies/sb-1/pause", STRATEGIST, { reason: "pause" });
      expect(pause.status).toBe(409);
      expect(codeOf(pause.body)).toBe("CONTROL_UNKNOWN_INSTANCE");
      const strategies = await call(port, "GET", "/v1/strategies", READER);
      expect((JSON.parse(strategies.body) as { strategies: readonly unknown[] }).strategies).toEqual([]);

      // THE INVARIANT: the kill-switch holder's GLOBAL engage applies and is audited.
      const engage = await call(port, "POST", "/v1/kill-switch", SWITCHER, {
        scope: "GLOBAL",
        scopeRef: null,
        action: "FULL_HALT",
        reason: "incident: halt everything",
      });
      expect(engage.status).toBe(200);
      const switches = await call(port, "GET", "/v1/kill-switch", READER);
      expect((JSON.parse(switches.body) as { killSwitches: readonly { scope: string }[] }).killSwitches).toEqual([
        expect.objectContaining({ scope: "GLOBAL", action: "FULL_HALT", actor: "switcher-d" }),
      ]);

      const metrics = (await call(port, "GET", "/v1/metrics", READER)).body;
      // Ordinary tier: 3 of the strategist's 5 attempts; then the engage.
      expect(metrics).toContain("control_audit_records 4");
      expect(metrics).toContain("control_audit_capacity 7");
      expect(metrics).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="APPLIED"} 1');
      expect(metrics).toContain('control_mutations_total{action="MODE_RAISE_ATTEMPT",outcome="REFUSED"} 3');
      expect(metrics).toContain('control_mutations_total{action="MODE_RAISE_ATTEMPT",outcome="NOT_AUDITED"} 2');
      expect(metrics).toContain('control_mutations_total{action="STRATEGY_PAUSE",outcome="NOT_AUDITED"} 1');
      // Every attempt is COUNTED: the reader's five and the strategist's five.
      expect(metrics).toContain("control_mode_raise_attempts_refused_total 10");
      expect(metrics).toContain("control_kill_switches_active 1");
    } finally {
      expect(process.listenerCount("SIGINT")).toBe(1);
      process.emit("SIGINT");
      for (let i = 0; i < 50 && !lines.includes("control API stopped."); i += 1) await sleep(20);
      expect(lines).toContain("control API stopped.");
    }
  }, 30_000);

  it("REFUSES to start on a configuration without the reserve, naming the field", async () => {
    directory = await mkdtemp(join(tmpdir(), "control-1-shipped-"));
    const configPath = join(directory, "control-api.json");
    await writeFile(
      configPath,
      JSON.stringify({
        bindHost: "127.0.0.1",
        bindPort: 0,
        maxRequestBodyBytes: 65_536,
        auditCapacity: 65_536,
        traderHealth: { kind: "none" },
        operators: [{ operatorId: "reader-b", token: READER, grants: ["READ"] }],
      }),
      "utf8",
    );
    const lines: string[] = [];
    const code = await startup(
      {
        env: { ...SAFE_ENV, CONTROL_API_CONFIG: configPath },
        argv: ["--check"],
        readConfig: (path) => readFile(path, "utf8"),
        log: (line) => lines.push(line),
      },
      { serve: false },
    );
    expect(code).toBe(78);
    expect(lines.join("\n")).toContain("CONTROL_CONFIG_INVALID");
    expect(lines.join("\n")).toContain("auditSafetyReserve");
  });
});
