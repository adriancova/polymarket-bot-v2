/**
 * No code path in this package reads a key or the environment (work-plan
 * `WP-260` deliverable: "no code path that reads a key from the environment
 * in this package's default export"; ADR-010 §3; handoff §15).
 *
 * Every NON-TEST source file of the package (the default export's closure,
 * the `./testing` entry and everything else under `src/`) is parsed with
 * TypeScript and must not:
 *
 * - reference the `process` global at all (so no `process.env`,
 *   `process["env"]`, `const { env } = process`, `process.argv`), nor
 *   `globalThis.process`;
 * - read `import.meta.env`, or `Deno.env` / `Bun.env`;
 * - import a filesystem or dotenv module (a key file is a key read too).
 *
 * The composition root passes its environment record to
 * `signerGateContextFromSafetyFlags` explicitly; this package never fetches it.
 *
 * NON-VACUOUS: the same detector flags planted snippets of every form above.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises", "dotenv", "dotenv/config"]);

function findings(text: string, fileName: string): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "process") {
      const parent = node.parent;
      // A property NAME called `process` (`x.process`, `{ process: 1 }`) is not the global.
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName || (ts.isPropertyAccessExpression(parent) && parent.expression.getText(source) === "globalThis")) {
        out.push(`process global at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "env") {
      const target = node.expression.getText(source);
      if (target === "import.meta" || target === "Deno" || target === "Bun") out.push(`${target}.env`);
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (FORBIDDEN_MODULES.has(node.moduleSpecifier.text)) out.push(`imports ${node.moduleSpecifier.text}`);
    }
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
      const isLoad = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (isLoad && FORBIDDEN_MODULES.has(node.arguments[0].text)) out.push(`loads ${node.arguments[0].text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

async function productionSources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await productionSources(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("no environment, process or key-file access in the package's source", () => {
  it("every non-test source file is clean", async () => {
    const files = await productionSources(SRC);
    expect(files.map((file) => path.relative(SRC, file)).sort()).toEqual(
      expect.arrayContaining(["index.ts", "run-mode-gate.ts", "signer.ts", "venue-client.ts", "testing/index.ts", "testing/mock-signer.ts"]),
    );
    const report: Record<string, string[]> = {};
    for (const file of files) {
      const found = findings(await readFile(file, "utf8"), file);
      if (found.length > 0) report[path.relative(SRC, file)] = found;
    }
    expect(report).toEqual({});
  });

  it.each([
    ["process.env", "const k = process.env.POLYMARKET_PRIVATE_KEY;"],
    ["process[\"env\"]", 'const k = process["env"]["X"];'],
    ["destructured env", "const { env } = process;"],
    ["globalThis.process", "const p = globalThis.process;"],
    ["import.meta.env", "const k = import.meta.env.KEY;"],
    ["Deno.env", "declare const Deno: { env: unknown }; const k = Deno.env;"],
    ["node:fs", 'import { readFileSync } from "node:fs";'],
    ["fs/promises", 'import { readFile } from "fs/promises";'],
    ["dotenv", 'import "dotenv/config";'],
    ["require(fs)", 'const fs = require("fs");'],
    ["dynamic import(node:fs)", 'const fs = await import("node:fs");'],
  ])("NON-VACUOUS: flags %s", (_label, snippet) => {
    expect(findings(snippet, "planted.ts").length).toBeGreaterThan(0);
  });

  it("does not flag a property merely named process", () => {
    expect(findings("const o = { process: 1 }; const v = o.process;", "ok.ts")).toEqual([]);
  });
});
