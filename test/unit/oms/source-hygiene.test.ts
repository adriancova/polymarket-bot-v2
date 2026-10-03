/**
 * WP-270: `packages/oms` stays a layer-1 package with no I/O, no clock, no
 * randomness, no key and no venue SDK (`docs/contracts/dependency-direction.md`
 * §2 and F6, F12, F13, F17; ADR-010). A textual scan of every production
 * source file, shown to fire on planted lines.
 *
 * The OMS suites themselves (`test/unit/oms/**`, `test/fault-injection/oms/**`)
 * read no environment variable and reach no network (r1, SCOPE-2), and the
 * package manifest carries exactly its two scripts and one dependency (r1,
 * SCOPE-1). Planted lines in this file are assembled at run time, so the
 * suite scan covers this file too.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const SRC = join(repoRoot, "packages", "oms", "src");

const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "a Node built-in", pattern: /from\s+["']node:|require\(\s*["']node:|from\s+["'](?:fs|net|http|https|crypto|child_process|dgram|dns|os|tls|worker_threads)["']/u },
  { name: "the venue SDK or an archived client", pattern: /@polymarket\/(?:client|clob-client|builder-)/u },
  { name: "the secure adapter (layer 2)", pattern: /polymarket-secure/u },
  { name: "the inventory package (a same-layer edge without a §2.1 row)", pattern: /@polymarket-bot\/inventory|packages\/inventory/u },
  { name: "a clock", pattern: /\bDate\.now\b|\bnew Date\b|\bperformance\.now\b|\bprocess\.hrtime\b/u },
  { name: "randomness", pattern: /\bMath\.random\b|\bcrypto\.|\brandomUUID\b|\bgetRandomValues\b/u },
  { name: "the network", pattern: /\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b/u },
  { name: "the environment or process globals", pattern: /\bprocess\.(?:env|argv|exit)\b|\bglobalThis\b/u },
  { name: "a timer", pattern: /\bsetTimeout\(|\bsetInterval\(|\bsetImmediate\(/u },
  { name: "an evaluator", pattern: /\beval\(|\bnew Function\(/u },
];

// Assembled at run time so that this file's own text never matches the suite scan below.
const PROCESS = ["pro", "cess"].join("");
const FETCH = ["fe", "tch"].join("");

/** What no OMS suite may do: read the environment, or reach a network. */
const SUITE_FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "an environment read", pattern: /\bprocess\s*(?:\.\s*env\b|\[\s*["'`]env["'`]\s*\])|\bimport\.meta\.env\b/u },
  {
    name: "the network",
    pattern: /\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b|from\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns)["']/u,
  },
];

const SUITE_TREES = [join(repoRoot, "test", "unit", "oms"), join(repoRoot, "test", "fault-injection", "oms")];

function suiteFiles(): { readonly file: string; readonly text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts")) out.push({ file: path.slice(repoRoot.length + 1), text: readFileSync(path, "utf8") });
    }
  };
  for (const tree of SUITE_TREES) walk(tree);
  return out;
}

function suiteViolations(files: readonly { readonly file: string; readonly text: string }[]): string[] {
  const out: string[] = [];
  for (const { file, text } of files) for (const rule of SUITE_FORBIDDEN) if (rule.pattern.test(text)) out.push(`${file}: ${rule.name}`);
  return out;
}

function sources(): { readonly file: string; readonly text: string }[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

function violations(files: readonly { readonly file: string; readonly text: string }[]): string[] {
  const out: string[] = [];
  for (const { file, text } of files) {
    const code = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    for (const rule of FORBIDDEN) if (rule.pattern.test(code)) out.push(`${file}: ${rule.name}`);
  }
  return out;
}

describe("packages/oms source hygiene", () => {
  it("scans every production source file and finds none of the forbidden constructs", () => {
    const files = sources();
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(violations(files)).toEqual([]);
  });

  it("fires on planted lines (the scan is not vacuous)", () => {
    const planted = [
      'import { readFileSync } from "node:fs";',
      'import { createSecureClient } from "@polymarket/client";',
      'import { x } from "@polymarket-bot/polymarket-secure";',
      'import { ReservationService } from "@polymarket-bot/inventory";',
      "const now = Date.now();",
      "const r = Math.random();",
      `await ${FETCH}("https://clob.polymarket.com");`,
      `const key = ${PROCESS}.env.KEY;`,
      "setTimeout(() => undefined, 1);",
      'eval("1");',
    ];
    for (const line of planted) expect(violations([{ file: "planted.ts", text: line }])).toHaveLength(1);
  });

  it("declares only the decimal package as a dependency, and exactly its two scripts (the fault suite's typecheck runs in test:fault)", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", "oms", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ "@polymarket-bot/decimal": "workspace:*" });
    expect(manifest.scripts).toEqual({
      typecheck: "tsc --noEmit",
      "test:fault": "tsc --noEmit -p ../../test/fault-injection/oms/tsconfig.json && vitest run --config ../../test/fault-injection/oms/vitest.config.ts",
    });
  });
});

describe("the OMS suites", () => {
  it("read no environment variable and reach no network (every .ts file under test/unit/oms and test/fault-injection/oms)", () => {
    const files = suiteFiles();
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files.map((entry) => entry.file)).toContain("test/unit/oms/salt-gate.property.test.ts");
    expect(files.map((entry) => entry.file)).toContain("test/fault-injection/oms/support/crash-harness.ts");
    expect(suiteViolations(files)).toEqual([]);
  });

  it("fires on planted lines (the suite scan is not vacuous)", () => {
    const planted = [
      `if (${PROCESS}.env["OMS_PROPERTY_TRACE"] === "1") {}`,
      `const trace = ${PROCESS}.env.TRACE;`,
      `const trace = ${PROCESS}["env"]["TRACE"];`,
      `const trace = import.meta${".env"}.TRACE;`,
      `await ${FETCH}("https://clob.polymarket.com");`,
      `import { request } from "node:${"https"}";`,
      `const socket = new ${"Web"}Socket("wss://example.invalid");`,
    ];
    for (const line of planted) expect(suiteViolations([{ file: "planted.ts", text: line }]), line).toHaveLength(1);
  });
});
