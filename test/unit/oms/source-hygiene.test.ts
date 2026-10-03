/**
 * WP-270: `packages/oms` stays a layer-1 package with no I/O, no clock, no
 * randomness, no key and no venue SDK (`docs/contracts/dependency-direction.md`
 * §2 and F6, F12, F13, F17; ADR-010). A textual scan of every production
 * source file, shown to fire on planted lines.
 */

import { readFileSync, readdirSync } from "node:fs";
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
      'await fetch("https://clob.polymarket.com");',
      "const key = process.env.KEY;",
      "setTimeout(() => undefined, 1);",
      'eval("1");',
    ];
    for (const line of planted) expect(violations([{ file: "planted.ts", text: line }])).toHaveLength(1);
  });

  it("declares only the decimal package as a dependency", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", "oms", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ "@polymarket-bot/decimal": "workspace:*" });
  });
});
