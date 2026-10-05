/**
 * WP-320, PAPER only: no production source under `live-safety/` can reach a
 * network, a key, a signer or the environment. Every venue surface (the
 * heartbeat transport, the geoblock endpoint, the closed-only check) is an
 * injected port. Each non-test file is parsed, and none may:
 *
 * - reference the `process` global, or read `import.meta.env`;
 * - import any `node:` module, a filesystem, HTTP, socket, TLS or DNS module,
 *   `@polymarket/client`, or `@polymarket-bot/polymarket-secure` (the signer
 *   boundary; the heartbeat controller is reached through a structural port);
 * - call `fetch`, construct a `WebSocket`, or hold a URL in a string (venue
 *   routes are cited in comments only).
 *
 * NON-VACUOUS: the detector flags planted snippets.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = new Set(["@polymarket/client", "@polymarket-bot/polymarket-secure", "undici", "ws", "dotenv", "fs", "http", "https", "net", "tls", "dns"]);

function findings(text: string, fileName: string): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "process") {
      const parent = node.parent;
      const isName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isName) out.push("process global");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "env") out.push(".env read");
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith("node:") || FORBIDDEN.has(specifier)) out.push(`imports ${specifier}`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) out.push("dynamic import");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "fetch" || node.expression.text === "require")) out.push(`calls ${node.expression.text}`);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "WebSocket") out.push("constructs WebSocket");
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /(https?|wss?):\/\//u.test(node.text)) out.push(`URL string ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("live-safety reaches no network, key, signer or environment", () => {
  it("no production source under live-safety/ does", () => {
    const files = readdirSync(HERE).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-support.ts"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    const report: Record<string, string[]> = {};
    for (const file of files) {
      const found = findings(readFileSync(path.join(HERE, file), "utf8"), file);
      if (found.length > 0) report[file] = found;
      expect(readFileSync(path.join(HERE, file), "utf8")).not.toMatch(/test-support/u);
    }
    expect(report).toEqual({});
  });

  it("NON-VACUOUS: the detector flags every planted form", () => {
    expect(findings("const k = process.env.KEY;", "x.ts").sort()).toEqual([".env read", "process global"]);
    expect(findings('import { createOrderHeartbeatController } from "@polymarket-bot/polymarket-secure";', "x.ts")).toEqual(["imports @polymarket-bot/polymarket-secure"]);
    expect(findings('import https from "node:https";', "x.ts")).toEqual(["imports node:https"]);
    expect(findings('await fetch("https://polymarket.com/api/geoblock");', "x.ts")).toEqual(["calls fetch", "URL string https://polymarket.com/api/geoblock"]);
  });
});
