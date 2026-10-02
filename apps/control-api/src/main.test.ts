/**
 * The startup sequence: step 1 runs before step 2, and every refusal is an
 * exit code an operator can script against.
 *
 * `startup` is driven with `serve: false` throughout — these tests validate the
 * ordering and the refusals, and binding a socket is `http.ts`'s job, exercised
 * over a real one in the integration suite.
 */

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryControlAuditLog,
  type AuditAppendResult,
  type ControlAuditSink,
} from "@polymarket-bot/observability";

import { AUDIT_APPEND_TIMEOUT_MS, CONTROL_PLANE_VOID_ACTOR } from "./control-plane.js";
import { EXIT_CODES, composeControlPlane, startup, type StartupPorts } from "./main.js";
import { FAKE_OPERATOR_TOKEN, ScriptedEnvironment } from "./testing/index.js";

function validConfig(): string {
  return JSON.stringify({
    bindHost: "127.0.0.1",
    bindPort: 0,
    maxRequestBodyBytes: 65_536,
    auditCapacity: 4096,
    auditSafetyReserve: 64,
    traderHealth: { kind: "none" },
    operators: [{ operatorId: "operator-a", token: FAKE_OPERATOR_TOKEN, grants: ["READ"] }],
  });
}

interface Run {
  readonly code: number;
  readonly lines: readonly string[];
  readonly configRead: boolean;
}

async function run(
  env: Readonly<Record<string, string | undefined>>,
  config: string | (() => never) = validConfig(),
): Promise<Run> {
  const lines: string[] = [];
  let configRead = false;
  const ports: StartupPorts = {
    env,
    argv: ["--check"],
    readConfig: () => {
      configRead = true;
      if (typeof config === "function") config();
      return Promise.resolve(config as string);
    },
    log: (line) => lines.push(line),
  };
  const code = await startup(ports, { serve: false });
  return { code, lines, configRead };
}

describe("step 1 runs BEFORE step 2", () => {
  it("REFUSES an unsafe environment WITHOUT reading the configuration file", async () => {
    const result = await run({
      MAX_RUN_MODE: "LIVE",
      CONTROL_API_CONFIG: "/etc/control-api.json",
    });
    expect(result.code).toBe(EXIT_CODES.unsafeEnvironment);
    // The point: a process that had already read a file would have moved ahead
    // of the validation it is subject to.
    expect(result.configRead).toBe(false);
    expect(result.lines[0]).toContain("REFUSING TO START");
  });

  it("REFUSES an environment referencing a production secret name, printing no value", async () => {
    const secret = "must-not-appear";
    const result = await run({
      POLYMARKET_PRIVATE_KEY: secret,
      CONTROL_API_CONFIG: "/etc/control-api.json",
    });
    expect(result.code).toBe(EXIT_CODES.unsafeEnvironment);
    expect(result.lines.join("\n")).not.toContain(secret);
    expect(result.lines.join("\n")).toContain("PAPER_PRODUCTION_SECRET_NAME_PRESENT");
  });
});

describe("configuration", () => {
  it("REFUSES to start with no CONTROL_API_CONFIG, and says there is no default", async () => {
    const result = await run({});
    expect(result.code).toBe(EXIT_CODES.configurationRefused);
    expect(result.lines.join("\n")).toContain("There is no default");
    expect(result.configRead).toBe(false);
  });

  it("REFUSES a configuration file that is not JSON", async () => {
    const result = await run({ CONTROL_API_CONFIG: "/etc/control-api.json" }, "not json");
    expect(result.code).toBe(EXIT_CODES.configurationRefused);
    expect(result.lines.join("\n")).toContain("could not be read as JSON");
  });

  it("REFUSES a configuration file that cannot be opened", async () => {
    const result = await run({ CONTROL_API_CONFIG: "/nope" }, () => {
      throw new Error("ENOENT");
    });
    expect(result.code).toBe(EXIT_CODES.configurationRefused);
  });

  it("REFUSES a non-loopback bind host and prints the refusal (§15)", async () => {
    const document = JSON.parse(validConfig()) as Record<string, unknown>;
    document["bindHost"] = "0.0.0.0";
    const result = await run(
      { CONTROL_API_CONFIG: "/etc/control-api.json" },
      JSON.stringify(document),
    );
    expect(result.code).toBe(EXIT_CODES.configurationRefused);
    expect(result.lines.join("\n")).toContain("CONTROL_CONFIG_NOT_LOOPBACK");
  });

  it("REFUSES a weak operator token WITHOUT printing it", async () => {
    // A value chosen so it is not a substring of any refusal wording — the
    // earlier fixture was the literal "short", which the message "shorter than
    // 32 characters" contains, and the assertion was measuring the message.
    const weak = "wk9";
    const document = JSON.parse(validConfig()) as Record<string, unknown>;
    document["operators"] = [{ operatorId: "a", token: weak, grants: ["READ"] }];
    const result = await run(
      { CONTROL_API_CONFIG: "/etc/control-api.json" },
      JSON.stringify(document),
    );
    expect(result.code).toBe(EXIT_CODES.configurationRefused);
    expect(result.lines.join("\n")).toContain("CONTROL_CONFIG_WEAK_OPERATOR");
    expect(result.lines.join("\n")).not.toContain(weak);
  });
});

describe("--check", () => {
  it("accepts a valid environment and configuration and binds NOTHING", async () => {
    const result = await run({
      RUN_MODE: "PAPER",
      MAX_RUN_MODE: "PAPER",
      ALLOW_REAL_ORDERS: "false",
      CONTROL_API_CONFIG: "/etc/control-api.json",
    });
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.lines.join("\n")).toContain("nothing was bound");
    expect(result.configRead).toBe(true);
  });

  it("NEVER prints an operator token on the accepted path either", async () => {
    const result = await run({ CONTROL_API_CONFIG: "/etc/control-api.json" });
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.lines.join("\n")).not.toContain(FAKE_OPERATOR_TOKEN);
    // It DOES say how many operators there are — a count is not a credential.
    expect(result.lines.join("\n")).toContain("1 operator(s)");
  });
});

describe("exit codes", () => {
  it("are distinct, stable and scriptable", () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      unsafeEnvironment: 78,
      configurationRefused: 78,
    });
  });
});

describe("CONTROL-1b: the control plane the shipped process composes", () => {
  it("bounds every append at the default, and VOIDS a record that lands late with the environment's instant and id", async () => {
    vi.useFakeTimers();
    try {
      const log = new InMemoryControlAuditLog(16);
      const held: (() => void)[] = [];
      // The first APPLIED append is held — a durable sink that answers late.
      const sink: ControlAuditSink = {
        append: (record) =>
          record.outcome === "APPLIED" && held.length === 0
            ? new Promise<AuditAppendResult>((resolve) => {
                held.push(() => {
                  void log.append(record).then(resolve);
                });
              })
            : log.append(record),
      };
      const environment = new ScriptedEnvironment();
      const plane = composeControlPlane(sink, environment);
      expect(plane.auditAppendTimeoutMs).toBe(AUDIT_APPEND_TIMEOUT_MS);
      expect(plane.voidsLateAppliedRecords).toBe(true);

      const engaged = plane.engageKillSwitch(
        { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" },
        { actor: "operator-a", at: environment.now(), auditRecordId: environment.nextAuditRecordId(), reason: "halt now" },
      );
      await vi.advanceTimersByTimeAsync(AUDIT_APPEND_TIMEOUT_MS);
      expect(await engaged).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });

      held[0]?.();
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
      const records = log.records();
      expect(records.map((record) => `${record.actor}/${record.outcome}`)).toEqual([
        "operator-a/APPLIED",
        `${CONTROL_PLANE_VOID_ACTOR}/REFUSED`,
      ]);
      // The void's id and instant are the ENVIRONMENT's next ones.
      expect(records[1]).toMatchObject({
        recordId: "01930000-0000-7000-8000-000000000002",
        at: "2026-09-05T00:00:02.000Z",
      });
      expect(plane.killSwitches()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
