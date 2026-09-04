/**
 * Source-level purity pins for `packages/simulation`.
 *
 * Three claims this package makes are only true if nothing in its sources
 * violates them, and each is cheap to break by accident in a later edit:
 *
 * 1. **No clock read anywhere** (§12.4 determinism, §6 invariant 15). The
 *    dependency checker's F11 rule already forbids `new Date()` / `Date.now()`
 *    in the packages it restricts; `packages/simulation` is not one of those, so
 *    it holds itself to the same bar here.
 * 2. **No Node built-in** (`dependency-direction.md` §2.2 / F17). Layers 0 and 1
 *    may import a built-in only if the package, specifier and binding are in
 *    §2.2's table. `packages/simulation` is not in it, so the answer is none —
 *    which is why SHA-256 is a port.
 * 3. **No runtime schema library** (ADR-020 §3, the WP-160 route). Not just "no
 *    direct `zod` import" but "`zod` is not in the dependency closure at all",
 *    which is checked from the manifests rather than asserted in prose.
 *
 * The scan is deliberately textual and deliberately conservative: it reads the
 * shipped sources, ignores comments and string contents where it must, and
 * reports the file and line of anything it finds.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "simulation");
const SOURCE_ROOT = join(PACKAGE_ROOT, "src");

function sourceFiles(directory: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(path);
  }
  return out.sort();
}

/**
 * Strips block comments, line comments, and string/template literals.
 *
 * Without this, every prose mention of `Date.now()` in a module header would be
 * a finding, and the suite would be untrue rather than merely noisy.
 */
function strippedCode(text: string): string {
  let out = "";
  let index = 0;
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (index < text.length) {
    const two = text.slice(index, index + 2);
    const character = text.charAt(index);
    switch (mode) {
      case "code":
        if (two === "//") {
          mode = "line";
          index += 2;
        } else if (two === "/*") {
          mode = "block";
          index += 2;
        } else if (character === "'") {
          mode = "single";
          index += 1;
        } else if (character === '"') {
          mode = "double";
          index += 1;
        } else if (character === "`") {
          mode = "template";
          index += 1;
        } else {
          out += character;
          index += 1;
        }
        break;
      case "line":
        if (character === "\n") {
          mode = "code";
          out += "\n";
        }
        index += 1;
        break;
      case "block":
        if (two === "*/") {
          mode = "code";
          index += 2;
        } else {
          if (character === "\n") out += "\n";
          index += 1;
        }
        break;
      default: {
        const closer = mode === "single" ? "'" : mode === "double" ? '"' : "`";
        if (character === "\\") {
          index += 2;
          break;
        }
        if (character === closer) mode = "code";
        if (character === "\n") out += "\n";
        index += 1;
        break;
      }
    }
  }
  return out;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly rule: string;
}

function scan(rules: readonly { readonly rule: string; readonly pattern: RegExp }[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const code = strippedCode(readFileSync(file, "utf8"));
    const lines = code.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      for (const { rule, pattern } of rules) {
        if (pattern.test(line)) {
          findings.push({
            file: file.slice(REPO_ROOT.length + 1),
            line: index + 1,
            text: line.trim(),
            rule,
          });
        }
      }
    }
  }
  return findings;
}

describe("packages/simulation reads no clock (§12.4, §6 invariant 15)", () => {
  it("contains no Date, performance, or hrtime read", () => {
    const findings = scan([
      { rule: "new Date()", pattern: /\bnew\s+Date\s*\(/u },
      { rule: "Date.now", pattern: /\bDate\s*\.\s*now\b/u },
      { rule: "Date.parse", pattern: /\bDate\s*\.\s*parse\b/u },
      { rule: "Date.UTC", pattern: /\bDate\s*\.\s*UTC\b/u },
      { rule: "performance.now", pattern: /\bperformance\s*\.\s*now\b/u },
      { rule: "process.hrtime", pattern: /\bprocess\s*\.\s*hrtime\b/u },
      { rule: "process", pattern: /\bprocess\s*\./u },
    ]);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("contains no unseeded randomness (§6 invariant 2)", () => {
    const findings = scan([
      { rule: "Math.random", pattern: /\bMath\s*\.\s*random\b/u },
      { rule: "crypto.getRandomValues", pattern: /getRandomValues/u },
      { rule: "randomUUID", pattern: /randomUUID/u },
      { rule: "randomBytes", pattern: /randomBytes/u },
    ]);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("contains no locale-dependent comparison (a §12.4 environment dependence)", () => {
    const findings = scan([{ rule: "localeCompare", pattern: /localeCompare/u }]);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});

describe("packages/simulation imports no Node built-in (dependency-direction §2.2 / F17)", () => {
  it("has no `node:` import in any production source", () => {
    const findings = scan([{ rule: "node: import", pattern: /["']node:/u }]);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("has no bare built-in import either (fs, crypto, path, …)", () => {
    const findings = scan([
      { rule: "bare builtin import", pattern: /\bfrom\s+["'](?:fs|crypto|path|url|util|os|http|https|net)["']/u },
    ]);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});

describe("packages/simulation runs no schema library (ADR-020 §3)", () => {
  it("imports zod nowhere", () => {
    const findings = scan([{ rule: "zod import", pattern: /\bfrom\s+["']zod["']/u }]);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("calls no schema parse", () => {
    const findings = scan([
      { rule: "safeParse", pattern: /\.safeParse\s*\(/u },
      { rule: "z.", pattern: /\bz\s*\.\s*(?:object|strictObject|string|number|enum|literal)\b/u },
    ]);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("declares exactly one workspace dependency, and zod is not in its closure", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ "@polymarket-bot/decimal": "workspace:*" });
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual(["typescript"]);

    // The one dependency's own manifest: `decimal.js` only, so nothing in the
    // closure carries `zod`. `packages/domain` DOES carry it, which is exactly
    // why this package does not depend on `packages/domain`.
    const decimalManifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", "decimal", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(decimalManifest.dependencies ?? {})).not.toContain("zod");
    expect(Object.keys(decimalManifest.dependencies ?? {})).not.toContain("@polymarket-bot/domain");
  });
});

describe("packages/simulation holds no credential or venue surface", () => {
  it("names no URL, socket, signer, or key anywhere in its sources", () => {
    const findings = scan([
      { rule: "url literal", pattern: /https?:\/\//u },
      { rule: "websocket", pattern: /\bWebSocket\b/u },
      { rule: "fetch", pattern: /\bfetch\s*\(/u },
      { rule: "signer", pattern: /\bsigner\b/iu },
      { rule: "privateKey", pattern: /privateKey/iu },
      { rule: "apiSecret", pattern: /apiSecret/iu },
    ]);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});
