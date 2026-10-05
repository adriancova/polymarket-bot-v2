/**
 * Structural guarantees of the emergency CLI's production source, read from
 * TypeScript's own syntax tree (comments and string data in comments are
 * inert there):
 *
 * - INDEPENDENCE (§14.2; ADR-008 §6): no module imports the trader, the
 *   shared trading core or the control API, by name or by path. The CLI has
 *   no way to reach trader memory.
 * - NO TRANSPORT (ADR-033 D2, D5): no module references WP-320's heartbeat
 *   controller or transport, or names the heartbeat route; no module but the
 *   composition imports a network module.
 * - THE SHIPPED ENTRY (WP-330 r0): `src/main.ts`, the file the ADR-018 bundle
 *   is built from, is scanned with the rest; it touches no `process` and only
 *   hands its URL to the composition's single entry guard.
 * - THE CREDENTIAL BOUNDARY (§15; ADR-010 §3): only `main.ts` touches the
 *   `process` global; the environment names it reads are exactly the three
 *   ops names (plus the run-mode record handed whole to WP-260's gate), and
 *   none is sensitive by WP-260's own `isSensitiveKey`, and none trips the
 *   repository's paper-safety scan (`packages/observability`'s
 *   `scanEnvironmentForProductionNames`, the table the trader and the control
 *   API refuse a PAPER environment by), even with a value set.
 * - V3-E15: no Data API v1 route is named.
 * - DOCUMENTATION (WP-330 r1, WP330-V1-03): three statements that claimed
 *   more than the code does stay corrected; each corrected statement matches
 *   behaviour pinned elsewhere.
 *
 * NON-VACUOUS: each detector flags a planted snippet.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_PRODUCTION_NAMES, scanEnvironmentForProductionNames } from "@polymarket-bot/observability";
import { isSensitiveKey } from "@polymarket-bot/polymarket-secure";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { AUDIT_LOG_ENV, CONFIG_ENV, DATABASE_URL_ENV } from "./main.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/** The bundle's entry (`build` bundles `src/main.ts`), outside `emergency/`. */
const SHIPPED_ENTRY = path.join(SRC, "main.ts");

function productionFiles(): string[] {
  const out: string[] = [SHIPPED_ENTRY];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test-support.ts")) out.push(full);
    }
  };
  walk(HERE);
  return out.sort();
}

interface Findings {
  readonly imports: string[];
  processUses: number;
  readonly envNames: string[];
  readonly strings: string[];
  readonly identifiers: Set<string>;
}

function scan(text: string, fileName: string): Findings {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Findings = { imports: [], processUses: 0, envNames: [], strings: [], identifiers: new Set() };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
      found.imports.push(node.arguments[0].text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.strings.push(node.text);
    }
    if (ts.isIdentifier(node)) {
      found.identifiers.add(node.text);
      if (node.text === "process") found.processUses += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const FORBIDDEN_IMPORTS = [/^@polymarket-bot\/trader(\/|$)/u, /^@polymarket-bot\/trading-core(\/|$)/u, /^@polymarket-bot\/control-api(\/|$)/u, /apps\/trader|trading-core|control-api/u];
const NETWORK_MODULES = ["http", "https", "net", "tls", "dgram", "dns", "ws", "undici", "node:http", "node:https", "node:net", "node:tls", "node:dgram", "node:dns"];
const TRANSPORT_NAMES = ["OrderHeartbeatTransport", "createOrderHeartbeatController", "classifyHeartbeatAnswer", "BOOTSTRAP_HEARTBEAT_ID"];
const DATA_API_V1 = /^\/(?:v1\/|positions\b|closed-positions\b|activity\b|value\b|holders\b)/u;

describe("the emergency CLI's production source", () => {
  const files = productionFiles();

  it("is the set this scan expects (non-vacuity)", () => {
    const names = files.map((file) => path.relative(HERE, file));
    expect(names).toEqual(expect.arrayContaining(["../main.ts", "run.ts", "main.ts", "commands/cancel.ts", "commands/reconcile.ts", "commands/stop-heartbeat.ts", "audit-log.ts"]));
  });

  it("THE SHIPPED ENTRY: src/main.ts imports only the composition, touches no `process`, and hands its own URL to the single entry guard", () => {
    const text = readFileSync(SHIPPED_ENTRY, "utf8");
    const found = scan(text, SHIPPED_ENTRY);
    expect(found.imports).toEqual(["./emergency/main.js"]);
    expect(found.processUses).toBe(0);
    expect(text).toContain("await runIfProcessEntry(import.meta.url);");
    // The composition runs nothing at load (no top-level `if` or statement
    // expression, so no entry guard of its own): exactly one guard per bundle.
    const composition = ts.createSourceFile("main.ts", readFileSync(path.join(HERE, "main.ts"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(composition.statements.filter((statement) => ts.isIfStatement(statement) || ts.isExpressionStatement(statement)).map((statement) => statement.getText().slice(0, 60))).toEqual([]);
    // The entry's one statement is that call (non-vacuity of the detector).
    const entry = ts.createSourceFile("entry.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(entry.statements.filter((statement) => ts.isExpressionStatement(statement))).toHaveLength(1);
  });

  it("INDEPENDENCE: imports neither the trader, the trading core nor the control API, by name or by path", () => {
    const offenders = files.flatMap((file) => scan(readFileSync(file, "utf8"), file).imports.filter((specifier) => FORBIDDEN_IMPORTS.some((rule) => rule.test(specifier))).map((specifier) => `${path.relative(SRC, file)}: ${specifier}`));
    expect(offenders).toEqual([]);
  });

  it("INDEPENDENCE: the package manifest declares no trader, trading-core or control-api dependency", () => {
    const manifest = JSON.parse(readFileSync(path.resolve(SRC, "..", "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) => Object.keys(manifest[field] ?? {}));
    expect(declared.filter((name) => /trader|trading-core|control-api/u.test(name))).toEqual([]);
  });

  it("NO TRANSPORT: no heartbeat controller, transport or route, and no network module outside the composition", () => {
    for (const file of files) {
      const found = scan(readFileSync(file, "utf8"), file);
      const relative = path.relative(HERE, file);
      expect(TRANSPORT_NAMES.filter((name) => found.identifiers.has(name)), relative).toEqual([]);
      expect(found.strings.filter((text) => /heartbeats\b/u.test(text) && text.startsWith("/")), relative).toEqual([]);
      expect(found.imports.filter((specifier) => NETWORK_MODULES.includes(specifier)), relative).toEqual([]);
    }
  });

  it("THE CREDENTIAL BOUNDARY: only main.ts touches `process`; it reads exactly the three ops names, none sensitive", () => {
    for (const file of files) {
      const found = scan(readFileSync(file, "utf8"), file);
      if (path.relative(HERE, file) !== "main.ts") expect(found.processUses, path.relative(HERE, file)).toBe(0);
    }
    const names = [AUDIT_LOG_ENV, CONFIG_ENV, DATABASE_URL_ENV];
    expect(names).toEqual(["OPS_CLI_AUDIT_LOG", "OPS_CLI_CONFIG", "OPS_CLI_DATABASE_URL"]);
    expect(names.filter((name) => isSensitiveKey(name))).toEqual([]);
    const main = readFileSync(path.join(HERE, "main.ts"), "utf8");
    // Every `io.env[...]` read names one of the three constants; the record itself goes whole to the gate.
    const reads = [...main.matchAll(/io\.env\[([A-Z_]+)\]/gu)].map((match) => match[1]);
    expect(new Set(reads)).toEqual(new Set(["DATABASE_URL_ENV", "AUDIT_LOG_ENV", "CONFIG_ENV"]));
    expect(main).toContain("runModeFlags: io.env");
  });

  it("THE CREDENTIAL BOUNDARY: the CLI's environment names, set, do not trip the paper-safety scan; and no source names a production secret", () => {
    const environment = { [AUDIT_LOG_ENV]: "/var/lib/pmb/audit.jsonl", [CONFIG_ENV]: "/etc/pmb/ops.json", [DATABASE_URL_ENV]: "postgresql://ops@db/pmb", RUN_MODE: "PAPER", MAX_RUN_MODE: "PAPER", ALLOW_REAL_ORDERS: "false" };
    expect(scanEnvironmentForProductionNames(environment)).toEqual([]);
    for (const file of files) {
      const text = readFileSync(file, "utf8").toUpperCase();
      expect(ALL_PRODUCTION_NAMES.filter((name) => text.includes(name)), path.relative(HERE, file)).toEqual([]);
    }
    // CONTROL: the scan refuses a production name.
    expect(scanEnvironmentForProductionNames({ POLYMARKET_PRIVATE_KEY: "x" }).length).toBeGreaterThan(0);
  });

  it("V3-E15: no Data API v1 route is named anywhere", () => {
    for (const file of files) {
      const found = scan(readFileSync(file, "utf8"), file);
      expect(found.strings.filter((text) => DATA_API_V1.test(text)), path.relative(HERE, file)).toEqual([]);
    }
  });

  it("DOCUMENTATION (WP330-V1-03): the overclaims are gone, and the corrected statements are those the behaviour pins hold", () => {
    // Comment text, flattened: no line breaks, no leading `*`.
    const flat = (file: string): string =>
      readFileSync(file, "utf8")
        .replace(/\n\s*\*\s?/gu, " ")
        .replace(/\s+/gu, " ");
    const run = flat(path.join(HERE, "run.ts"));
    const auditLog = flat(path.join(HERE, "audit-log.ts"));
    const printer = flat(path.join(HERE, "printer.ts"));
    const runbook = flat(path.resolve(SRC, "..", "..", "..", "docs", "runbooks", "emergency.md"));
    // 1. A refused process with a database configured does write its audit copies there
    //    (main.test.ts "an UNREACHABLE database"; test/integration/ops-cli "a PAPER refusal is mirrored").
    expect(run).not.toContain("no configuration, credential, database or venue is touched by a process it refuses");
    expect(run).toContain("their best-effort copies in `ops.config_change_audit`, which do connect to that database");
    // 2. INVOKED is written once the (pure) gate has given its verdict (run.gate.test.ts).
    expect(auditLog).not.toContain("`INVOKED` before the gate,");
    expect(auditLog).toContain("`INVOKED` once WP-260's signer gate has given its verdict");
    // 3. A refusal prints no PLAN, RESULT or UNKNOWN (test/unit/tooling/app-bundles-load.test.ts).
    expect(printer).not.toContain("a section is never omitted");
    expect(runbook).not.toContain("No section is ever left out");
    expect(printer).toContain("it prints no PLAN, RESULT or UNKNOWN");
    expect(runbook).toContain("It prints no PLAN, RESULT or UNKNOWN");
  });

  it("NON-VACUOUS: every detector flags a planted snippet", () => {
    const planted = scan(
      [
        'import { x } from "@polymarket-bot/trader";',
        'import { y } from "../../../apps/trader/src/loop.js";',
        'import net from "node:net";',
        'import type { OrderHeartbeatTransport } from "@polymarket-bot/polymarket-secure";',
        'const route = "/v1/heartbeats";',
        'const positions = "/positions";',
        "const key = process.env.SOMETHING;",
      ].join("\n"),
      "planted.ts",
    );
    expect(planted.imports.filter((specifier) => FORBIDDEN_IMPORTS.some((rule) => rule.test(specifier)))).toHaveLength(2);
    expect(planted.imports.filter((specifier) => NETWORK_MODULES.includes(specifier))).toEqual(["node:net"]);
    expect(planted.identifiers.has("OrderHeartbeatTransport")).toBe(true);
    expect(planted.strings.filter((text) => /heartbeats\b/u.test(text) && text.startsWith("/"))).toEqual(["/v1/heartbeats"]);
    expect(planted.strings.filter((text) => DATA_API_V1.test(text))).toEqual(["/v1/heartbeats", "/positions"]);
    expect(planted.processUses).toBe(1);
    expect(isSensitiveKey("OPS_CLI_CANCEL_API_KEY")).toBe(true);
  });
});
