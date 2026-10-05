/**
 * WP-310, `packages/oms/src/restricted-mode/**`:
 *
 * 1. Layer-1 hygiene: the production sources here use none of the constructs
 *    `test/unit/oms/source-hygiene.test.ts` forbids in the OMS (that scan
 *    reads only the top-level `src/` files, so this directory runs it on
 *    itself): no Node built-in, no SDK, no adapter, no clock, no randomness,
 *    no network, no environment, no timer, no evaluator.
 * 2. No hardcoded duration (acceptance 3): no numeric literal but 0, 1 and
 *    `MS_PER_SECOND = 1000` in its declaration; no digits-only string.
 * 3. Every venue fact this directory relies on is quoted verbatim from its
 *    dated report.
 *
 * NON-VACUOUS: each scan flags planted snippets.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { RESTRICTED_MODE_FACTS } from "./facts.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, "..", "..", "..", "..");

const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "a Node built-in", pattern: /from\s+["']node:|require\(\s*["']node:|from\s+["'](?:fs|net|http|https|crypto|child_process|dgram|dns|os|tls|worker_threads)["']/u },
  { name: "the venue SDK or an archived client", pattern: /@polymarket\/(?:client|clob-client|builder-)/u },
  { name: "the secure adapter (layer 2)", pattern: /polymarket-secure/u },
  { name: "the inventory package", pattern: /@polymarket-bot\/inventory|packages\/inventory/u },
  { name: "a clock", pattern: /\bDate\.now\b|\bnew Date\b|\bperformance\.now\b|\bprocess\.hrtime\b/u },
  { name: "randomness", pattern: /\bMath\.random\b|\bcrypto\.|\brandomUUID\b|\bgetRandomValues\b/u },
  { name: "the network", pattern: /\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b/u },
  { name: "the environment or process globals", pattern: /\bprocess\.(?:env|argv|exit)\b|\bglobalThis\b/u },
  { name: "a timer", pattern: /\bsetTimeout\(|\bsetInterval\(|\bsetImmediate\(/u },
  { name: "an evaluator", pattern: /\beval\(|\bnew Function\(/u },
];

function violations(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  return FORBIDDEN.filter((rule) => rule.pattern.test(code)).map((rule) => rule.name);
}

const UNIT_CONSTANTS: Readonly<Record<string, number>> = Object.freeze({ MS_PER_SECOND: 1000 });

function hardcodedNumbers(text: string, fileName: string): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
      if (value !== 0 && value !== 1 && !declaredUnit) out.push(`${fileName}: ${node.text}`);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^-?[0-9][0-9_,.]*$/u.test(node.text) && node.text !== "0" && node.text !== "1") {
      out.push(`${fileName}: "${node.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function productionSources(): { readonly name: string; readonly text: string }[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-support.ts"))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(DIR, name), "utf8") }));
}

describe("restricted-mode layer-1 hygiene", () => {
  it("scans every production source and finds none of the forbidden constructs", () => {
    const files = productionSources();
    expect(files.map((file) => file.name)).toEqual(["configuration.ts", "detector.ts", "facts.ts", "index.ts", "signals.ts", "venue-port.ts"]);
    expect(files.flatMap((file) => violations(file.text).map((rule) => `${file.name}: ${rule}`))).toEqual([]);
  });

  it("NON-VACUOUS: flags planted lines", () => {
    for (const line of ["const now = Date.now();", "const d = new Date();", 'import { x } from "node:fs";', "setTimeout(() => 0, 5);", "const r = Math.random();"]) {
      expect(violations(line), line).not.toEqual([]);
    }
  });
});

describe("no duration is hardcoded in packages/oms/src/restricted-mode", () => {
  it("no number but 0, 1 and the declared MS_PER_SECOND", () => {
    expect(productionSources().flatMap((file) => hardcodedNumbers(file.text, file.name))).toEqual([]);
  });

  it.each([
    ["the post-only window", "const window = 120_000;"],
    ["a restart start delay", "const start = 2 * MS_PER_SECOND;"],
    ["a backoff cap in an object", "const backoff = { capMs: 30000 };"],
    ["a duration as a string", 'const d = "120000";'],
    ["a wrong unit", "const MS_PER_SECOND = 60;"],
  ])("NON-VACUOUS: flags %s", (_label, snippet) => {
    expect(hardcodedNumbers(snippet, "planted.ts").length).toBeGreaterThan(0);
  });
});

describe("cited restricted-mode facts", () => {
  const normalize = (text: string): string => text.replace(/\s+/gu, " ");
  for (const fact of Object.values(RESTRICTED_MODE_FACTS)) {
    it(`${fact.id} is quoted verbatim from ${fact.source} ${fact.section}`, () => {
      expect(fact.source).toMatch(/^docs\/venue\/verified-\d{4}-\d{2}-\d{2}\.md$/u);
      expect(normalize(readFileSync(path.join(REPO_ROOT, fact.source), "utf8"))).toContain(normalize(fact.quote));
    });
  }
});
