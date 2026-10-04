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
  TRADER_HALTS_URL_DRIVER_REWRITES,
  TRADER_HALTS_URL_SSLMODES,
  composeControlPlane,
  libpqVariablesIn,
  planTraderHalts,
  redactDatabaseUrl,
  shutdownControlApi,
  startup,
  type ShutdownSteps,
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
      // `CTL2-L2`: a signal's shutdown that could not close what it holds still exits, and says so.
      stopFailed: 1,
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

  it("CONTROL2-R1-C2: the URL's query may say one sslmode and nothing else — a ?password= would REPLACE the authority's, past the redaction", () => {
    const postgres = { kind: "postgres", timeoutMs: 750 } as const;
    const QUERY_PASSWORD = "Qp4-not-a-credential-ctl2-query";
    for (const query of [
      `password=${QUERY_PASSWORD}`,
      `user=postgres&password=${QUERY_PASSWORD}`,
      "user=postgres",
      "host=%2Ftmp",
      "port=6432",
      "options=-c%20statement_timeout%3D0",
      "application_name=not-the-reader",
      "sslrootcert=%2Fetc%2Fpasswd",
      "sslcert=%2Fetc%2Fhosts",
      "sslkey=%2Fetc%2Fhosts",
      "ssl=true",
      "uselibpqcompat=true&sslmode=verify-full",
      "PASSWORD=x",
      "sslmode=bogus",
      "sslmode=",
      // The driver's weaker or aliased modes: refused (`TRADER_HALTS_URL_SSLMODES`).
      "sslmode=no-verify",
      "sslmode=prefer",
      "sslmode=verify-ca",
      "sslmode=VERIFY-FULL",
      "sslmode=verify-full&sslmode=disable",
      "sslmode=verify-full&password=x",
      "",
    ]) {
      const url = query === "" ? `${URL_VALUE}?=${QUERY_PASSWORD}` : `${URL_VALUE}?${query}`;
      const plan = planTraderHalts(postgres, url);
      expect(plan.ok, query).toBe(false);
      if (plan.ok) continue;
      expect(plan.code, query).toBe("CONTROL_TRADER_HALTS_URL_PARAMETERS");
      expect(plan.detail).toContain(TRADER_HALTS_DATABASE_URL_ENV);
      for (const secret of [PASSWORD, QUERY_PASSWORD, "/etc/", "statement_timeout%3D0", "6432"]) expect(plan.detail, query).not.toContain(secret);
    }
    // One sslmode the driver names is admitted, and nothing changes about the plan.
    for (const mode of TRADER_HALTS_URL_SSLMODES) {
      expect(planTraderHalts(postgres, `${URL_VALUE}?sslmode=${mode}`), mode).toEqual({
        ok: true,
        kind: "postgres",
        url: `${URL_VALUE}?sslmode=${mode}`,
        timeoutMs: 750,
      });
    }
    expect([...TRADER_HALTS_URL_SSLMODES]).toEqual(["disable", "verify-full"]);
    // An empty query is no query.
    expect(planTraderHalts(postgres, `${URL_VALUE}?`).ok).toBe(true);
  });

  it("CONTROL2-R2-C1: a URL the driver would REWRITE before reading it — a raw space, or a % that begins no two-hex-digit escape, anywhere — is refused, and so is one whose user, password, host or database does not decode", () => {
    const postgres = { kind: "postgres", timeoutMs: 750 } as const;
    const at = (password: string): string => `postgres://halt_reader:${password}@127.0.0.1:5432/polymarket_bot`;
    const refused: readonly (readonly [string, string])[] = [
      // The verifiers' two forms: the driver sends `Fake%2FSecret Word-r2c1` and `EcA%zz-nac-r2c1`, which the redaction missed.
      [at("Fake%2FSecret Word-r2c1"), "a raw space beside a hex-letter escape"],
      [at("Ec%41%zz-nac-r2c1"), "a malformed escape beside a decimal escape"],
      // Every branch of the driver's test, whether or not the rewrite would change the password.
      [at("my pass-r2c1"), "a raw space alone"],
      [at("Ec%2F%zz-nac-r2c1"), "a malformed escape beside a hex-letter escape"],
      [at("pct%-r2c1"), "a % before a non-hex character"],
      [at("pct%a-r2c1"), "a % and one hex digit before a non-hex character"],
      [at("pct%"), "a % just before the @"],
      ["postgres://halt reader:Zq7-r2c1@127.0.0.1:5432/polymarket_bot", "a raw space in the user"],
      ["postgres://halt_reader:Zq7-r2c1@127.0.0.1:5432/polymarket bot", "a raw space in the database"],
      ["postgres://halt_reader:Zq7-r2c1@127.0.0.1:5432/polymarket_bot?sslmode=disable%", "a bare % in the query"],
      // The superset: a % the driver's own test misses, at the very end of the string.
      ["postgres://halt_reader:Zq7-r2c1@127.0.0.1:5432/polymarket_bot#frag%", "a bare % at the very end"],
      ["postgres://halt_reader:Zq7-r2c1@127.0.0.1:5432/polymarket_bot#frag%a", "a % and one hex digit at the very end"],
      // Escapes that do not decode: the driver would fail every read with a bare "URI malformed".
      [at("Zq7%FF-r2c1"), "a password that is not UTF-8"],
      ["postgres://halt%C3%28reader:Zq7-r2c1@127.0.0.1:5432/polymarket_bot", "a user that is not UTF-8"],
      ["postgres://halt_reader:Zq7-r2c1@db%FF.internal:5432/polymarket_bot", "a host that is not UTF-8"],
      ["postgres://halt_reader:Zq7-r2c1@127.0.0.1:5432/polymarket%FFbot", "a database that is not UTF-8"],
    ];
    for (const [url, why] of refused) {
      // Each is a URL WHATWG reads: only this rule refuses it.
      expect(() => new URL(url), why).not.toThrow();
      const plan = planTraderHalts(postgres, url);
      expect(plan.ok, why).toBe(false);
      if (plan.ok) continue;
      expect(plan.code, why).toBe("CONTROL_TRADER_HALTS_URL_ENCODING");
      expect(plan.detail).toContain(TRADER_HALTS_DATABASE_URL_ENV);
      for (const part of ["Zq7", "r2c1", "Secret", "nac", "halt_reader", "halt reader", "127.0.0.1", "db%FF", "frag"]) {
        expect(plan.detail, why).not.toContain(part);
      }
    }

    // Admitted: the driver reads each as written, so the password it sends is the authority's,
    // percent-decoded — and that is redacted (the real driver: `trader-halt-shape.test.ts`).
    for (const url of [
      at("Zq7-plain-r2c1"),
      at("p%40ss%2Fword-r2c1"),
      at("sp%20ace%41-r2c1"),
      at("%C3%A9t%C3%A9-r2c1"),
      at("100%25-r2c1"),
      at("semi;colon=eq-r2c1"),
    ]) {
      expect(planTraderHalts(postgres, url), url).toEqual({ ok: true, kind: "postgres", url, timeoutMs: 750 });
      const sent = decodeURIComponent(new URL(url).password);
      expect(redactDatabaseUrl(`echo: ${sent}`, url), url).toBe("echo: <redacted>");
    }

    // A SUPERSET of the driver's own test (`pg-connection-string@2.14.0`, `parse`, copied here as
    // written), over every two characters after a % and at the end of the string.
    const driverRewrites = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/iu;
    const alphabet = [..."0123456789abcdefABCDEFgGzZ%@/:?#&= -_.~é"];
    let flagged = 0;
    for (const first of ["", ...alphabet]) {
      for (const second of ["", ...alphabet]) {
        const text = `pw%${first}${second}`;
        if (!driverRewrites.test(`${text}x`)) continue;
        flagged += 1;
        expect(TRADER_HALTS_URL_DRIVER_REWRITES.test(text), text).toBe(true);
        expect(TRADER_HALTS_URL_DRIVER_REWRITES.test(`${text}x`), `${text}x`).toBe(true);
      }
    }
    expect(flagged).toBeGreaterThan(1_000);
    expect(TRADER_HALTS_URL_DRIVER_REWRITES.test("pw%2Fq%41%c3%a9")).toBe(false);
    expect(TRADER_HALTS_URL_DRIVER_REWRITES.test("a b")).toBe(true);
  });

  it("CTL2-R3-L1: a user, password, host or database that decodes to a NUL is REFUSED — the driver sends each as a C string, so a server reads, and its error echoes, only the prefix before the NUL, which the redaction does not hold", () => {
    const postgres = { kind: "postgres", timeoutMs: 750 } as const;
    const NUL = "\u0000";
    const at = (password: string): string => `postgres://halt_reader:${password}@127.0.0.1:5432/polymarket_bot`;
    const refused: readonly (readonly [string, string])[] = [
      // The verifiers' two forms: an embedded %00, and a terminal one, whose prefix is the whole intended credential.
      [at("Fk%00secret-r3l1"), "an embedded %00 in the password"],
      [at("Full-pw-r3l1%00"), "a terminal %00 in the password"],
      [at("%00Lead-r3l1"), "a leading %00 in the password"],
      [at("Two%00Nuls%00-r3l1"), "two %00 in the password"],
      // A raw NUL: WHATWG writes it as %00, and the driver decodes that back to a NUL.
      [at(`Raw${NUL}Nul-r3l1`), "a raw NUL in the password"],
      ["postgres://halt%00reader:Zq7-r3l1@127.0.0.1:5432/polymarket_bot", "a %00 in the user"],
      ["postgres://halt_reader:Zq7-r3l1@db%00x.internal:5432/polymarket_bot", "a %00 in the host"],
      ["postgres://halt_reader:Zq7-r3l1@127.0.0.1:5432/polymarket%00bot", "a %00 in the database"],
    ];
    for (const [url, why] of refused) {
      // Each is a URL WHATWG reads, the driver's rewrite test passes it, and every component decodes:
      // only the NUL refuses it.
      expect(() => new URL(url), why).not.toThrow();
      expect(TRADER_HALTS_URL_DRIVER_REWRITES.test(url), why).toBe(false);
      const parsed = new URL(url);
      const decoded = [parsed.username, parsed.password, parsed.hostname].map((part) => decodeURIComponent(part));
      expect([...decoded, decodeURI(parsed.pathname)].some((part) => part.includes(NUL)), why).toBe(true);
      const plan = planTraderHalts(postgres, url);
      expect(plan.ok, why).toBe(false);
      if (plan.ok) continue;
      expect(plan.code, why).toBe("CONTROL_TRADER_HALTS_URL_ENCODING");
      expect(plan.detail).toContain(TRADER_HALTS_DATABASE_URL_ENV);
      expect(plan.detail).toContain("NUL");
      for (const part of ["r3l1", "Fk", "Full-pw", "Lead", "Nuls", "halt_reader", "halt%00reader", "127.0.0.1", "db%00x", "polymarket"]) {
        expect(plan.detail, why).not.toContain(part);
      }
    }

    // Why the refusal is load-bearing: the server reads only the prefix before the NUL, and the
    // redaction, which holds the URL and the password as written and decoded, leaves that prefix whole.
    for (const [password, prefix] of [
      ["Fk%00secret-r3l1", "Fk"],
      ["Full-pw-r3l1%00", "Full-pw-r3l1"],
    ] as const) {
      const url = at(password);
      const sent = decodeURIComponent(new URL(url).password);
      expect(sent.slice(0, sent.indexOf(NUL)), password).toBe(prefix);
      expect(redactDatabaseUrl(`echo: [${prefix}]`, url), password).toBe(`echo: [${prefix}]`);
    }

    // Admitted: the check reads the DECODED text. A literal "%00" (written %2500) and other control
    // characters decode to no NUL, and the driver sends them whole, so the redaction holds them.
    for (const url of [at("Lit%2500-r3l1"), at("Ctl%01%1F%7F-r3l1"), at("Nul0-r3l1"), "postgres://halt_reader:Zq7-r3l1@127.0.0.1:5432/poly%2500bot"]) {
      expect(planTraderHalts(postgres, url), url).toEqual({ ok: true, kind: "postgres", url, timeoutMs: 750 });
      const sent = decodeURIComponent(new URL(url).password);
      expect(sent.includes(NUL), url).toBe(false);
      expect(redactDatabaseUrl(`echo: [${sent}]`, url), url).toBe("echo: [<redacted>]");
    }
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
      // `CONTROL2-R1-C2`: a query password would be the one the driver sends.
      {
        config: configWithHalts({ kind: "postgres", timeoutMs: 750 }),
        env: { ...BASE, [TRADER_HALTS_DATABASE_URL_ENV]: `${URL_VALUE}?password=${PASSWORD}-query` },
        code: "CONTROL_TRADER_HALTS_URL_PARAMETERS",
      },
      // `CONTROL2-R2-C1`: the driver would rewrite each before reading it, and send a password the redaction misses.
      {
        config: configWithHalts({ kind: "postgres", timeoutMs: 750 }),
        env: { ...BASE, [TRADER_HALTS_DATABASE_URL_ENV]: URL_VALUE.replace(PASSWORD, `${PASSWORD}%2FSecret Word`) },
        code: "CONTROL_TRADER_HALTS_URL_ENCODING",
      },
      {
        config: configWithHalts({ kind: "postgres", timeoutMs: 750 }),
        env: { ...BASE, [TRADER_HALTS_DATABASE_URL_ENV]: URL_VALUE.replace(PASSWORD, `${PASSWORD}%41%zz-nac`) },
        code: "CONTROL_TRADER_HALTS_URL_ENCODING",
      },
      // `CTL2-R3-L1`: the driver would send each password cut at its NUL — a prefix the redaction misses,
      // and, for the terminal %00, the whole of PASSWORD.
      {
        config: configWithHalts({ kind: "postgres", timeoutMs: 750 }),
        env: { ...BASE, [TRADER_HALTS_DATABASE_URL_ENV]: URL_VALUE.replace(PASSWORD, `${PASSWORD}%00secret`) },
        code: "CONTROL_TRADER_HALTS_URL_ENCODING",
      },
      {
        config: configWithHalts({ kind: "postgres", timeoutMs: 750 }),
        env: { ...BASE, [TRADER_HALTS_DATABASE_URL_ENV]: URL_VALUE.replace(PASSWORD, `${PASSWORD}%00`) },
        code: "CONTROL_TRADER_HALTS_URL_ENCODING",
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

describe("CTL2-L2: a signal's shutdown always ENDS — the frozen pool's connections are ended at the bound, and the process is told to exit", () => {
  const SECRET_URL = "postgres://halt_reader:Sd3-not-a-credential-ctl2-stop@127.0.0.1:5432/x";

  /** Steps over fakes: the pool closes when `closeHalts` says so; every call is recorded in order. */
  function steps(overrides: Partial<ShutdownSteps> = {}): { readonly steps: ShutdownSteps; readonly calls: string[]; readonly lines: string[]; readonly exits: number[] } {
    const calls: string[] = [];
    const lines: string[] = [];
    const exits: number[] = [];
    return {
      calls,
      lines,
      exits,
      steps: {
        closeServer: () => {
          calls.push("closeServer");
          return Promise.resolve();
        },
        closeHalts: () => {
          calls.push("closeHalts");
          return Promise.resolve();
        },
        terminateHalts: () => {
          calls.push("terminateHalts");
          return 0;
        },
        log: (line) => lines.push(line),
        redact: (text) => redactDatabaseUrl(text, SECRET_URL),
        exit: (code) => {
          calls.push(`exit ${String(code)}`);
          exits.push(code);
        },
        closeWaitMs: 40,
        terminateWaitMs: 20,
        ...overrides,
      },
    };
  }

  it("a clean stop: server, then pool, never terminate; 'control API stopped.'; exit 0, once", async () => {
    const run = steps();
    expect(await shutdownControlApi(run.steps)).toBe(EXIT_CODES.ok);
    expect(run.calls).toEqual(["closeServer", "closeHalts", "exit 0"]);
    expect(run.lines).toEqual(["control API stopped."]);
  });

  it("a pool a frozen server holds: at the close bound its connections are ENDED, and once it closes the stop is clean — exit 0", async () => {
    let release: () => void = () => undefined;
    const run = steps({
      closeHalts: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      terminateHalts: () => {
        run.calls.push("terminateHalts");
        // pg destroys the socket; the abandoned read fails, its client is released, and the pool closes.
        setTimeout(release, 5);
        return 2;
      },
    });
    expect(await shutdownControlApi(run.steps)).toBe(EXIT_CODES.ok);
    expect(run.calls).toEqual(["closeServer", "terminateHalts", "exit 0"]);
    expect(run.lines).toEqual([
      "trader halts: the ops.incidents pool did not close within 40ms; ending the 2 connection(s) it still holds",
      "control API stopped.",
    ]);
  });

  it("a pool that does not close even then: the stop FAILED, says so, and the process is still told to exit — 1, not a hang", async () => {
    const run = steps({ closeHalts: () => new Promise<void>(() => undefined) });
    expect(await shutdownControlApi(run.steps)).toBe(EXIT_CODES.stopFailed);
    expect(run.exits).toEqual([1]);
    expect(run.lines.at(-1)).toBe("control API stop failed: Error: the ops.incidents pool did not close within 20ms of ending its connections");
  });

  it("a server close that fails still closes the pool, and the failure is logged REDACTED — exit 1", async () => {
    const run = steps({ closeServer: () => Promise.reject(new Error(`close failed near ${SECRET_URL}`)) });
    expect(await shutdownControlApi(run.steps)).toBe(EXIT_CODES.stopFailed);
    expect(run.calls).toEqual(["closeHalts", "exit 1"]);
    expect(run.lines).toEqual(["control API stop failed: Error: close failed near <redacted>"]);
    expect(run.lines.join("\n")).not.toContain("Sd3-not-a-credential");
  });

  it("with no exit port (a suite running startup() in its own process) nothing is told to exit, and the code is still returned", async () => {
    const run = steps({ closeHalts: () => new Promise<void>(() => undefined) });
    const withoutExit: ShutdownSteps = {
      closeServer: run.steps.closeServer,
      closeHalts: run.steps.closeHalts,
      terminateHalts: run.steps.terminateHalts,
      log: run.steps.log,
      redact: run.steps.redact,
      closeWaitMs: 40,
      terminateWaitMs: 20,
    };
    expect(await shutdownControlApi(withoutExit)).toBe(EXIT_CODES.stopFailed);
    expect(run.exits).toEqual([]);
    expect(run.lines.at(-1)).toContain("control API stop failed");
  });
});
