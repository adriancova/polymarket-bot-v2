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
import {
  EXIT_CODES,
  TRADER_HALTS_DATABASE_URL_ENV,
  composeControlPlane,
  libpqVariablesIn,
  planTraderHalts,
  redactDatabaseUrl,
  startup,
  type StartupPorts,
} from "./main.js";
import { FAKE_OPERATOR_TOKEN, ScriptedEnvironment } from "./testing/index.js";

function validConfig(): string {
  return JSON.stringify({
    bindHost: "127.0.0.1",
    bindPort: 0,
    maxRequestBodyBytes: 65_536,
    auditCapacity: 4096,
    auditSafetyReserve: 64,
    traderHealth: { kind: "none" },
    traderHalts: { kind: "none" },
    operators: [{ operatorId: "operator-a", token: FAKE_OPERATOR_TOKEN, grants: ["READ"] }],
  });
}

/** `validConfig()` with `traderHalts` replaced. */
function configWithHalts(traderHalts: unknown): string {
  return JSON.stringify({ ...(JSON.parse(validConfig()) as Record<string, unknown>), traderHalts });
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

describe("CONTROL-2 r1: the trader halt source — one variable, read once, never printed", () => {
  const PASSWORD = "Zq7-not-a-credential-ctl2-pw";
  const URL_VALUE = `postgres://halt_reader:${PASSWORD}@127.0.0.1:5432/polymarket_bot`;
  const BASE = { CONTROL_API_CONFIG: "/etc/control-api.json" } as const;

  it("names ONE environment variable, and it is no production or credential-shaped name", () => {
    expect(TRADER_HALTS_DATABASE_URL_ENV).toBe("CONTROL_API_TRADER_HALTS_DATABASE_URL");
  });

  it("plans: none with no URL; postgres with a postgres URL; every other combination is a refusal that prints no value", () => {
    expect(planTraderHalts({ kind: "none" }, undefined)).toEqual({ ok: true, kind: "none" });
    expect(planTraderHalts({ kind: "none" }, "")).toEqual({ ok: true, kind: "none" });
    expect(planTraderHalts({ kind: "postgres", timeoutMs: 750 }, URL_VALUE)).toEqual({
      ok: true,
      kind: "postgres",
      url: URL_VALUE,
      timeoutMs: 750,
    });
    expect(planTraderHalts({ kind: "postgres", timeoutMs: 750 }, URL_VALUE.replace("postgres:", "postgresql:")).ok).toBe(true);
    const refusals = [
      [planTraderHalts({ kind: "none" }, URL_VALUE), "CONTROL_TRADER_HALTS_URL_UNUSED"],
      [planTraderHalts({ kind: "postgres", timeoutMs: 750 }, undefined), "CONTROL_TRADER_HALTS_URL_MISSING"],
      [planTraderHalts({ kind: "postgres", timeoutMs: 750 }, ""), "CONTROL_TRADER_HALTS_URL_MISSING"],
      [planTraderHalts({ kind: "postgres", timeoutMs: 750 }, `http://halt_reader:${PASSWORD}@127.0.0.1/x`), "CONTROL_TRADER_HALTS_URL_INVALID"],
      [planTraderHalts({ kind: "postgres", timeoutMs: 750 }, `not a url ${PASSWORD}`), "CONTROL_TRADER_HALTS_URL_INVALID"],
    ] as const;
    for (const [plan, code] of refusals) {
      expect(plan.ok, code).toBe(false);
      if (plan.ok) continue;
      expect(plan.code).toBe(code);
      expect(plan.detail).toContain(TRADER_HALTS_DATABASE_URL_ENV);
      expect(plan.detail).not.toContain(PASSWORD);
    }
  });

  it("the URL is the ONE source: a URL missing a user, a password, a host or a database, or a PG* variable beside it, is refused", () => {
    const postgres = { kind: "postgres", timeoutMs: 750 } as const;
    for (const [url, missing] of [
      [`postgres://127.0.0.1:5432/polymarket_bot`, "no user, no password"],
      [`postgres://halt_reader@127.0.0.1:5432/polymarket_bot`, "no password"],
      [`postgres://halt_reader:${PASSWORD}@127.0.0.1:5432`, "no database"],
      [`postgres://halt_reader:${PASSWORD}@127.0.0.1:5432/`, "no database"],
      [`postgres:///polymarket_bot`, "no user, no password, no host"],
    ] as const) {
      const plan = planTraderHalts(postgres, url);
      expect(plan.ok, url).toBe(false);
      if (plan.ok) continue;
      expect(plan.code).toBe("CONTROL_TRADER_HALTS_URL_INCOMPLETE");
      expect(plan.detail).toContain(`names ${missing}`);
      expect(plan.detail).not.toContain(PASSWORD);
    }
    // Credentials with no host are no URL at all (WHATWG): refused as invalid, the value unprinted.
    const hostless = planTraderHalts(postgres, `postgres://halt_reader:${PASSWORD}@/polymarket_bot`);
    expect(hostless.ok ? "" : `${hostless.code} ${hostless.detail}`).toMatch(/^CONTROL_TRADER_HALTS_URL_INVALID (?!.*Zq7)/u);
    // libpq's namespace beside the URL: refused by NAME, values never printed.
    const env = { PGPASSWORD: "Hx2-not-a-credential", PGSSLMODE: "disable", PGDATA_EMPTY: "", PG_NOT_LIBPQ: "x", PATH: "/bin" };
    expect(libpqVariablesIn(env)).toEqual(["PGPASSWORD", "PGSSLMODE"]);
    const plan = planTraderHalts(postgres, URL_VALUE, libpqVariablesIn(env));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("CONTROL_TRADER_HALTS_LIBPQ_ENVIRONMENT");
    expect(plan.detail).toContain("PGPASSWORD, PGSSLMODE");
    expect(plan.detail).not.toContain("Hx2-not-a-credential");
    // Under none, the driver is not composed: nothing to refuse.
    expect(planTraderHalts({ kind: "none" }, undefined, libpqVariablesIn(env))).toEqual({ ok: true, kind: "none" });
  });

  it("startup REFUSES each mismatch (78), naming the variable and never printing its value", async () => {
    const cases = [
      { config: configWithHalts({ kind: "postgres", timeoutMs: 750 }), env: BASE, code: "CONTROL_TRADER_HALTS_URL_MISSING" },
      {
        config: configWithHalts({ kind: "postgres", timeoutMs: 750 }),
        env: { ...BASE, [TRADER_HALTS_DATABASE_URL_ENV]: `mysql://halt_reader:${PASSWORD}@127.0.0.1/x` },
        code: "CONTROL_TRADER_HALTS_URL_INVALID",
      },
      { config: validConfig(), env: { ...BASE, [TRADER_HALTS_DATABASE_URL_ENV]: URL_VALUE }, code: "CONTROL_TRADER_HALTS_URL_UNUSED" },
      {
        config: configWithHalts({ kind: "postgres", timeoutMs: 750 }),
        env: { ...BASE, [TRADER_HALTS_DATABASE_URL_ENV]: URL_VALUE.replace(`:${PASSWORD}`, "") },
        code: "CONTROL_TRADER_HALTS_URL_INCOMPLETE",
      },
      {
        config: configWithHalts({ kind: "postgres", timeoutMs: 750 }),
        env: { ...BASE, [TRADER_HALTS_DATABASE_URL_ENV]: URL_VALUE, PGPASSWORD: PASSWORD },
        code: "CONTROL_TRADER_HALTS_LIBPQ_ENVIRONMENT",
      },
    ];
    for (const entry of cases) {
      const result = await run(entry.env, entry.config);
      expect(result.code, entry.code).toBe(EXIT_CODES.configurationRefused);
      const said = result.lines.join("\n");
      expect(said).toContain(`[${entry.code}]`);
      expect(said).not.toContain(PASSWORD);
      expect(said).not.toContain("halt_reader");
      expect(said).not.toContain("configuration accepted");
    }
  });

  it("--check with postgres: accepted, the source named, the URL and its password printed nowhere — and the variable read ONCE by the composition", async () => {
    let reads = 0;
    const env: Record<string, string | undefined> = { ...BASE };
    Object.defineProperty(env, TRADER_HALTS_DATABASE_URL_ENV, {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return URL_VALUE;
      },
    });
    const result = await run(env, configWithHalts({ kind: "postgres", timeoutMs: 750 }));
    expect(result.code).toBe(EXIT_CODES.ok);
    const said = result.lines.join("\n");
    expect(said).toContain("trader halt source postgres");
    expect(said).not.toContain(PASSWORD);
    expect(said).not.toContain(URL_VALUE);
    // Two reads in all: the safety scan reads EVERY variable's value (a
    // credential-shaped NAME is refused only when it carries one), and the
    // composition reads this one once.
    expect(reads).toBe(2);
  });

  it("--check with none: accepted and says so", async () => {
    const result = await run(BASE);
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.lines.join("\n")).toContain("trader halt source none");
  });

  it("redactDatabaseUrl: the URL, and its password as written and decoded, become <redacted> — longest first", () => {
    const encoded = "p%40ss%2Fword-ctl2";
    const url = `postgres://halt_reader:${encoded}@db.internal:5432/x`;
    const text = `failed for ${url}; password ${encoded} or p@ss/word-ctl2; user halt_reader`;
    const redacted = redactDatabaseUrl(text, url);
    expect(redacted).toBe("failed for <redacted>; password <redacted> or <redacted>; user halt_reader");
    // No password: only the URL itself.
    expect(redactDatabaseUrl("x postgres://u@h/d y", "postgres://u@h/d")).toBe("x <redacted> y");
    // A URL that does not parse is still redacted whole.
    expect(redactDatabaseUrl("a not-a-url b", "not-a-url")).toBe("a <redacted> b");
    expect(redactDatabaseUrl("nothing here", URL_VALUE)).toBe("nothing here");
  });
});
