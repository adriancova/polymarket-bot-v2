/**
 * WP-310 acceptance 3, the source half: "Limits are configuration snapshots,
 * not constants" (handoff §9.13: "Do not hardcode the example values").
 *
 * Every production source file in this directory is parsed with TypeScript,
 * and no numeric literal may appear in it except:
 *
 * - `0` and `1` (identity, counting, a cost of one request);
 * - the five NAMED UNIT constants, each only in its own declaration and with
 *   its exact value: `MS_PER_SECOND = 1000`, `PER_MILLE = 1000`, and the
 *   HTTP statuses `HTTP_TOO_EARLY = 425`, `HTTP_TOO_MANY_REQUESTS = 429`,
 *   `HTTP_SERVICE_UNAVAILABLE = 503` (protocol identifiers, not limits).
 *
 * A string or template literal made only of digits (a number in disguise) is
 * refused too. Test files (`*.test.ts`) and test support
 * (`*.test-support.ts`) are exempt: that is where the synthetic snapshots'
 * numbers live. The documented values live only in snapshot documents
 * (`test/contract/rate-limits/fixtures/`).
 *
 * NON-VACUOUS: the scanner flags planted snippets of every form.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const UNIT_CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
  MS_PER_SECOND: 1000,
  PER_MILLE: 1000,
  HTTP_TOO_EARLY: 425,
  HTTP_TOO_MANY_REQUESTS: 429,
  HTTP_SERVICE_UNAVAILABLE: 503,
});

const DIGITS_ONLY = /^-?[0-9][0-9_,.]*$/u;

function hardcodedNumbers(text: string, fileName: string): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const where = (node: ts.Node): string => `${fileName}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`;
  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      const value = Number(node.text.replace(/_/gu, "").replace(/n$/u, ""));
      const parent = node.parent;
      const declaredUnit =
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name) &&
        Object.hasOwn(UNIT_CONSTANTS, parent.name.text) &&
        UNIT_CONSTANTS[parent.name.text] === value;
      if (value !== 0 && value !== 1 && !declaredUnit) out.push(`${where(node)} numeric literal ${node.text}`);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && DIGITS_ONLY.test(node.text) && node.text !== "0" && node.text !== "1") {
      out.push(`${where(node)} digits in a string "${node.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function productionSources(): string[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-support.ts"))
    .sort();
}

describe("no limit value is hardcoded in packages/polymarket-secure/src/rate-limit", () => {
  it("scans every production source and finds no number but 0, 1 and the named units", () => {
    const files = productionSources();
    expect(files).toEqual(["budget.ts", "configuration.ts", "headers.ts", "index.ts", "plain-data.ts", "priority.ts", "units.ts", "venue-facts.ts"]);
    const found = files.flatMap((name) => hardcodedNumbers(readFileSync(path.join(DIR, name), "utf8"), name));
    expect(found).toEqual([]);
  });

  it("each unit constant is declared exactly once, with its value", () => {
    const declarations = productionSources()
      .map((name) => readFileSync(path.join(DIR, name), "utf8"))
      .join("\n")
      .match(/const (MS_PER_SECOND|PER_MILLE|HTTP_TOO_EARLY|HTTP_TOO_MANY_REQUESTS|HTTP_SERVICE_UNAVAILABLE) = [0-9]+;/gu);
    expect([...(declarations ?? [])].sort()).toEqual([
      "const HTTP_SERVICE_UNAVAILABLE = 503;",
      "const HTTP_TOO_EARLY = 425;",
      "const HTTP_TOO_MANY_REQUESTS = 429;",
      "const MS_PER_SECOND = 1000;",
      "const PER_MILLE = 1000;",
    ]);
  });

  it.each([
    ["a burst", "const orderBurst = 60;"],
    ["a refill rate in an expression", "const tokens = elapsed * 40;"],
    ["a window in an object", "const w = { limit: 9000, windowMs: 10_000 };"],
    ["a limit as a string", 'const general = "15000";'],
    ["a limit as a template", "const cap = `21000`;"],
    ["a unit constant with the wrong value", "const MS_PER_SECOND = 999;"],
    ["a unit value under another name", "const WINDOW = 1000;"],
    ["a unit value outside its declaration", "const x = MS_PER_SECOND + 1000;"],
    ["a bigint", "const big = 120000n;"],
    ["a fraction", "const half = 0.5;"],
  ])("NON-VACUOUS: flags %s", (_label, snippet) => {
    expect(hardcodedNumbers(snippet, "planted.ts").length).toBeGreaterThan(0);
  });

  it("does not flag 0, 1 or a correctly declared unit", () => {
    expect(hardcodedNumbers("const MS_PER_SECOND = 1000; const a = 0; const b = 1 + a; const c = '1';", "ok.ts")).toEqual([]);
  });
});
