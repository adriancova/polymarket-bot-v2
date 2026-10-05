/**
 * ADR-033 D2: no transport is written. Every NON-TEST source file under
 * `heartbeat/` is parsed, and none may:
 *
 * - import a network, HTTP, socket, TLS, DNS, crypto-signing or SDK module
 *   (`node:http`, `node:https`, `node:net`, `node:tls`, `node:dns`,
 *   `node:dgram`, `node:crypto`, `undici`, `ws`, `@polymarket/client`, or
 *   any `node:` module at all);
 * - call `fetch`, construct a `WebSocket` or `XMLHttpRequest`, or name a URL
 *   in a string (a heartbeat route is cited in comments only).
 *
 * The package's `source-hygiene.test.ts` already bars `process`, environment
 * reads and filesystem modules here. NON-VACUOUS: the detector flags planted
 * snippets.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN_PACKAGES = new Set(["undici", "ws", "@polymarket/client", "axios", "node-fetch", "ky"]);

function findings(text: string, fileName: string): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith("node:") || FORBIDDEN_PACKAGES.has(specifier) || /^(http|https|net|tls|dns|dgram|crypto)$/u.test(specifier)) {
        out.push(`imports ${specifier}`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) out.push("dynamic import");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "fetch" || node.expression.text === "require")) {
      out.push(`calls ${node.expression.text}`);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "fetch") out.push("reads .fetch");
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "WebSocket" || node.expression.text === "XMLHttpRequest")) {
      out.push(`constructs ${node.expression.text}`);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /(https?|wss?):\/\//u.test(node.text)) out.push(`URL string ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("ADR-033 D2: the heartbeat directory writes no transport", () => {
  it("no production source under heartbeat/ can reach a network", () => {
    const files = readdirSync(HERE).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-support.ts"));
    expect(files.sort()).toEqual(["controller.ts", "index.ts", "protocol.ts", "venue-facts.ts"]);
    const report: Record<string, string[]> = {};
    for (const file of files) {
      const found = findings(readFileSync(path.join(HERE, file), "utf8"), file);
      if (found.length > 0) report[file] = found;
    }
    expect(report).toEqual({});
  });

  it("no production source imports the test fakes (fakes.test-support.ts is reachable from tests only)", () => {
    const files = readdirSync(HERE).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-support.ts"));
    for (const file of files) expect(readFileSync(path.join(HERE, file), "utf8")).not.toMatch(/test-support/u);
  });

  it("NON-VACUOUS: the detector flags every planted form", () => {
    expect(findings('import http from "node:http";', "x.ts")).toEqual(["imports node:http"]);
    expect(findings('import { Client } from "@polymarket/client";', "x.ts")).toEqual(["imports @polymarket/client"]);
    expect(findings('await fetch("x");', "x.ts")).toContain("calls fetch");
    expect(findings("globalThis.fetch(u);", "x.ts")).toContain("reads .fetch");
    expect(findings("new WebSocket(u);", "x.ts")).toEqual(["constructs WebSocket"]);
    expect(findings('const u = "https://clob.polymarket.com/v1/heartbeats";', "x.ts")).toEqual(["URL string https://clob.polymarket.com/v1/heartbeats"]);
    expect(findings('await import("undici");', "x.ts")).toContain("dynamic import");
  });
});
