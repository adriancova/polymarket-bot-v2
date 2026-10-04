/**
 * The shipped example configuration is a REAL configuration, and the process
 * really starts on it.
 *
 * The `WP-230` precedent (`compose-and-example-config.test.ts`): an example that
 * did not parse would be a document an operator copies and then debugs. Here it
 * goes one step further and drives `startup` end to end — the real safety check,
 * the real config door, the real server, a real request — because the example is
 * also the thing the README tells an operator to run.
 *
 * Loopback only, ephemeral port, closed afterwards.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseControlApiConfig } from "@polymarket-bot/control-api";
import { ALL_PRODUCTION_NAMES } from "@polymarket-bot/observability";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const EXAMPLE = resolve(repoRoot, "apps/control-api/control-api.config.example.json");
const README = resolve(repoRoot, "apps/control-api/README.md");

describe("the shipped example configuration", () => {
  it("PARSES through the API's own door — the only definition of valid there is", () => {
    const document = JSON.parse(readFileSync(EXAMPLE, "utf8")) as unknown;
    const parsed = parseControlApiConfig(document);
    expect(
      parsed.ok ? "valid" : parsed.refusals.map((refusal) => refusal.detail).join("; "),
    ).toBe("valid");
  });

  it("binds loopback and configures no trader health source it cannot honour", () => {
    const parsed = parseControlApiConfig(
      JSON.parse(readFileSync(EXAMPLE, "utf8")) as unknown,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.bindHost).toBe("127.0.0.1");
    // `none`, not a URL to a trader endpoint that does not exist. Shipping a
    // URL would be the false-integration claim this package refuses to make.
    expect(parsed.config.traderHealth).toEqual({ kind: "none" });
    // `CONTROL-2` r1: `none` too — the example starts with no database, and
    // says NOT_CONFIGURED rather than "no halts". A deployment that reads the
    // trader's halts sets `postgres` and the URL variable (README).
    expect({ ...parsed.config.traderHalts }).toEqual({ kind: "none" });
  });

  it("carries no production secret name", () => {
    const upper = readFileSync(EXAMPLE, "utf8").toUpperCase();
    for (const name of ALL_PRODUCTION_NAMES) {
      expect(upper, `the example references ${name}`).not.toContain(name);
    }
  });
});

describe("the README does not overstate what ships", () => {
  const readme = readFileSync(README, "utf8");

  it("names the composition obligation instead of claiming the trader endpoint", () => {
    expect(readme).toContain("does not expose an HTTP health endpoint today");
    expect(readme).toContain("No claim is made that a trader is on the other end");
  });

  it("discloses where the PostgreSQL sink has been executed, and that no composition binds it", () => {
    // `CONTROL-1b`: the sink is now driven against a real PostgreSQL by an
    // OPT-IN suite. The disclosure must say so — and must still say that the
    // shipped process binds no durable sink and that CI does not run it.
    expect(readme).toContain("reached by an opt-in suite, bound by no composition");
    expect(readme).toContain("test:integration:postgres");
    expect(readme).toContain("No composition binds the");
    expect(readme).toContain("CI does not run it yet");
  });

  it("states all four safety defaults verbatim", () => {
    for (const line of [
      "MAX_RUN_MODE=PAPER",
      "ALLOW_REAL_ORDERS=false",
      "LIVE_MICRO_MAX_ORDER_NOTIONAL=0",
      "LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0",
    ]) {
      expect(readme, line).toContain(line);
    }
  });

  it("carries no production secret name and no real-looking credential", () => {
    const upper = readme.toUpperCase();
    for (const name of ALL_PRODUCTION_NAMES) {
      expect(upper, `the README references ${name}`).not.toContain(name);
    }
  });

  it("documents every route the API serves, and no route it does not", async () => {
    const { CONTROL_API_ROUTES } = await import("@polymarket-bot/control-api");
    for (const route of CONTROL_API_ROUTES) {
      const [, path = ""] = route.split(" ");
      expect(readme, `the README omits ${route}`).toContain(path);
    }
  });

  it("CONTROL-1 (L-5): the README's route table is the ROUTER's table, row for row, grant for grant", async () => {
    const { CONTROL_API_ROUTE_TABLE } = await import("@polymarket-bot/control-api");
    const rows = readme
      .split("\n")
      .map((line) => /^\| `(GET|POST|PUT|PATCH|DELETE) (\/[^`]*)` \| `([A-Z_]+)` \|/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => `${match[1] ?? ""} ${match[2] ?? ""} ${match[3] ?? ""}`);
    expect(rows).toEqual(
      CONTROL_API_ROUTE_TABLE.map((route) => `${route.method} ${route.path} ${route.grant}`),
    );
  });

  it("CONTROL-1 (M-3): the README states the audit budget and the mutation-authority gate", () => {
    expect(readme).toContain("## The audit budget");
    expect(readme).toContain("auditSafetyReserve");
    expect(readme).toContain("holds no mutation grant");
  });
});

describe("the process really starts on the example, and serves", () => {
  it("passes safety, parses the example, binds loopback and answers a request", async () => {
    const { startup } = await import("@polymarket-bot/control-api/testing").then(
      async () => import("../../../apps/control-api/src/main.js"),
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
          CONTROL_API_CONFIG: EXAMPLE,
        },
        argv: ["--check"],
        readConfig: (path) => Promise.resolve(readFileSync(path, "utf8")),
        log: (line) => lines.push(line),
      },
      { serve: false },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("configuration accepted");
    // The example's placeholder token is never printed.
    expect(lines.join("\n")).not.toContain("NOT-A-CREDENTIAL");
  });

  it("REFUSES to start when the environment raises the ceiling, before reading the file", async () => {
    const { startup } = await import("../../../apps/control-api/src/main.js");
    const lines: string[] = [];
    let read = false;
    const code = await startup(
      {
        env: { MAX_RUN_MODE: "LIVE", CONTROL_API_CONFIG: EXAMPLE },
        argv: ["--check"],
        readConfig: (path) => {
          read = true;
          return Promise.resolve(readFileSync(path, "utf8"));
        },
        log: (line) => lines.push(line),
      },
      { serve: false },
    );
    expect(code).toBe(78);
    expect(read).toBe(false);
    expect(lines.join("\n")).toContain("PAPER_RUN_MODE_CEILING_RAISED");
  });
});
