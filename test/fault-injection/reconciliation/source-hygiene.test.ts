/**
 * WP-290: the two reconciliation subtrees stay layer 1, and the suite stays
 * offline. `test/unit/oms/source-hygiene.test.ts` scans only the top level of
 * `packages/oms/src`, so it does not see `src/reconciliation/`; this scan
 * applies its rules there (and `test/unit/ledger/purity-and-safety.test.ts`'s
 * rules, which already walk the ledger recursively, are re-applied to the
 * ledger subtree here so the two are reported together). Each rule is shown
 * to fire on a planted line.
 *
 * Also: no Data API v1 route appears in the coordinator (V3-E15), and no new
 * file has trailing whitespace or a blank last line (WP270-R2-04's rule).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const OMS_TREE = join(repoRoot, "packages", "oms", "src", "reconciliation");
const LEDGER_TREE = join(repoRoot, "packages", "ledger", "src", "reconciliation");
const SUITE_TREE = join(repoRoot, "test", "fault-injection", "reconciliation");

function files(dir: string): { readonly file: string; readonly text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      if (name === "node_modules") continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts")) out.push({ file: path.slice(repoRoot.length + 1), text: readFileSync(path, "utf8") });
    }
  };
  walk(dir);
  return out;
}

const PROCESS = ["pro", "cess"].join("");
const FETCH = ["fe", "tch"].join("");

/** `test/unit/oms/source-hygiene.test.ts`'s rules, applied to code (comments stripped). */
const OMS_FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "a Node built-in", pattern: /from\s+["']node:|require\(\s*["']node:|from\s+["'](?:fs|net|http|https|crypto|child_process|dgram|dns|os|tls|worker_threads)["']/u },
  { name: "the venue SDK or an archived client", pattern: /@polymarket\/(?:client|clob-client|builder-)/u },
  { name: "the secure adapter (layer 2)", pattern: /from\s+["'][^"']*polymarket-secure/u },
  { name: "the inventory package (no §2.1 row)", pattern: /from\s+["'][^"']*(?:@polymarket-bot\/inventory|packages\/inventory)/u },
  { name: "the ledger package (no §2.1 row)", pattern: /from\s+["'][^"']*(?:@polymarket-bot\/ledger|packages\/ledger)/u },
  { name: "a clock", pattern: /\bDate\.now\b|\bnew Date\b|\bperformance\.now\b|\bprocess\.hrtime\b/u },
  { name: "randomness", pattern: /\bMath\.random\b|\bcrypto\.|\brandomUUID\b|\bgetRandomValues\b/u },
  { name: "the network", pattern: /\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b/u },
  { name: "the environment or process globals", pattern: /\bprocess\.(?:env|argv|exit)\b|\bglobalThis\b/u },
  { name: "a timer", pattern: /\bsetTimeout\(|\bsetInterval\(|\bsetImmediate\(/u },
  { name: "an evaluator", pattern: /\beval\(|\bnew Function\(/u },
  { name: "a float coercion of a value", pattern: /\bparseFloat\b|\bparseInt\b|\bNumber\(/u },
];

/** `test/unit/ledger/purity-and-safety.test.ts`'s rules, applied to the whole text, and the door-only risk edge. */
const LEDGER_FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "a clock", pattern: /\bDate\.now\b|\bnew Date\b/u },
  { name: "randomness", pattern: /\bMath\.random\b|\bcrypto\.randomUUID\b/u },
  { name: "the environment", pattern: /\bprocess\.env\b/u },
  { name: "the network", pattern: /\bfetch\s*\(|\bnode:net\b|\bnode:http\b|\bnode:https\b/u },
  { name: "module loading or evaluation", pattern: /\brequire\s*\(|\beval\s*\(/u },
  { name: "the filesystem", pattern: /\bnode:fs\b/u },
  { name: "a credential surface", pattern: /\bprivateKey\b|\bapiSecret\b|\bpassphrase\b|\bmnemonic\b/iu },
  { name: "an order-placement surface", pattern: /\bsignOrder\b|\bplaceOrder\b|\bsubmitOrder\b/iu },
  { name: "a float coercion", pattern: /\bparseFloat\b|\bparseInt\b|\bNumber\s*\(/u },
  { name: "the risk package's root (S5 is door-only)", pattern: /from\s+["']@polymarket-bot\/risk["']/u },
];

/** What no suite file may do. */
const SUITE_FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "an environment read", pattern: /\bprocess\s*(?:\.\s*env\b|\[\s*["'`]env["'`]\s*\])|\bimport\.meta\.env\b/u },
  { name: "the network", pattern: /\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b|from\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns)["']/u },
];

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

function violations(list: readonly { readonly file: string; readonly text: string }[], rules: typeof OMS_FORBIDDEN, strip: boolean): string[] {
  const out: string[] = [];
  for (const { file, text } of list) {
    const code = strip ? stripComments(text) : text;
    for (const rule of rules) if (rule.pattern.test(code)) out.push(`${file}: ${rule.name}`);
  }
  return out;
}

/** Route-like string literals in code: only the five documented read routes may appear. */
const ALLOWED_ROUTES = new Set(["/data/orders", "/data/order", "/data/trades", "/v2/positions", "/v2/approvals"]);

function routeLiterals(list: readonly { readonly file: string; readonly text: string }[]): string[] {
  const out: string[] = [];
  for (const { file, text } of list) {
    for (const match of stripComments(text).matchAll(/["'`](\/[A-Za-z0-9_\-/]+)["'`]/gu)) {
      if (!ALLOWED_ROUTES.has(match[1] ?? "")) out.push(`${file}: ${match[1] ?? ""}`);
    }
  }
  return out;
}

function whitespaceProblems(list: readonly { readonly file: string; readonly text: string }[]): string[] {
  const out: string[] = [];
  for (const { file, text } of list) {
    text.split("\n").forEach((line, index) => {
      if (/[ \t]+\r?$/u.test(line)) out.push(`${file}:${String(index + 1)}: trailing whitespace`);
    });
    if (!text.endsWith("\n") || /\n[ \t]*\n$/u.test(text)) out.push(`${file}: no single newline at the end`);
  }
  return out;
}

describe("the reconciliation subtrees stay layer 1", () => {
  it("the coordinator (packages/oms/src/reconciliation) has no I/O, clock, randomness, timer, adapter or same-layer import", () => {
    const list = files(OMS_TREE);
    expect(list.map((entry) => entry.file).sort()).toEqual(
      ["coordinator.ts", "door.ts", "holdings.ts", "identity.ts", "index.ts", "ports.ts", "subjects.ts", "time.ts"].map((name) => `packages/oms/src/reconciliation/${name}`),
    );
    expect(violations(list, OMS_FORBIDDEN, true)).toEqual([]);
    // Its only package import is the decimal package (the OMS's one dependency).
    const specifiers = list.flatMap(({ text }) => [...text.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1] ?? ""));
    expect([...new Set(specifiers.filter((specifier) => !specifier.startsWith(".")))]).toEqual(["@polymarket-bot/decimal"]);
  });

  it("the ledger half (packages/ledger/src/reconciliation) keeps the ledger's purity rules", () => {
    const list = files(LEDGER_TREE);
    expect(list.map((entry) => entry.file).sort()).toEqual(
      ["holdings.ts", "index.ts", "journal.ts", "taxonomy.ts"].map((name) => `packages/ledger/src/reconciliation/${name}`),
    );
    expect(violations(list, LEDGER_FORBIDDEN, false)).toEqual([]);
  });

  it("no Data API v1 route, nor any route but the five documented reads, appears in the coordinator (V3-E15)", () => {
    expect(routeLiterals(files(OMS_TREE))).toEqual([]);
  });

  it("every rule fires on a planted line (the scans are not vacuous)", () => {
    const planted = [
      'import { readFileSync } from "node:fs";',
      'import { createSecureClient } from "@polymarket/client";',
      'import { x } from "@polymarket-bot/polymarket-secure";',
      'import { ReservationService } from "@polymarket-bot/inventory";',
      'import { Ledger } from "@polymarket-bot/ledger";',
      "const now = Date.now();",
      "const r = Math.random();",
      `await ${FETCH}("https://clob.polymarket.com");`,
      `const key = ${PROCESS}.env.KEY;`,
      "setTimeout(() => undefined, 1);",
      'eval("1");',
      "const n = Number(size);",
    ];
    for (const line of planted) expect(violations([{ file: "planted.ts", text: line }], OMS_FORBIDDEN, true), line).toHaveLength(1);
    const ledgerPlanted = [
      "const t = new Date();",
      "const id = crypto.randomUUID();",
      `const k = ${PROCESS}.env.K;`,
      `${FETCH}(url);`,
      'require("x");',
      'import "node:fs";',
      "const privateKey = 1;",
      "placeOrder();",
      "parseFloat(x);",
      'import { evaluateIntent } from "@polymarket-bot/risk";',
    ];
    for (const line of ledgerPlanted) expect(violations([{ file: "planted.ts", text: line }], LEDGER_FORBIDDEN, false), line).toHaveLength(1);
    expect(routeLiterals([{ file: "planted.ts", text: 'const route = "/positions";' }])).toHaveLength(1);
    expect(routeLiterals([{ file: "planted.ts", text: 'const route = "/v1/market-positions";' }])).toHaveLength(1);
  });
});

describe("the suite and the new files", () => {
  it("the suite reads no environment variable and reaches no network", () => {
    const list = files(SUITE_TREE);
    expect(list.length).toBeGreaterThanOrEqual(10);
    expect(violations(list, SUITE_FORBIDDEN, false)).toEqual([]);
    for (const line of [`const t = ${PROCESS}.env.TRACE;`, `await ${FETCH}("https://x.invalid");`, `new ${"Web"}Socket("wss://x.invalid");`]) {
      expect(violations([{ file: "planted.ts", text: line }], SUITE_FORBIDDEN, false), line).toHaveLength(1);
    }
  });

  it("no new source or suite file has trailing whitespace or a blank last line", () => {
    const list = [...files(OMS_TREE), ...files(LEDGER_TREE), ...files(SUITE_TREE)];
    expect(whitespaceProblems(list)).toEqual([]);
    for (const text of ["const a = 1;\n\n", "const a = 1; \n", "const a = 1;"]) expect(whitespaceProblems([{ file: "planted.ts", text }])).toHaveLength(1);
  });
});
