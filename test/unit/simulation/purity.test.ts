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
 *
 * IT ALSO REMOVES THE QUOTES, which is why {@link scan} takes a MODE. A rule
 * whose pattern needs a quote — an import specifier, a URL literal — can never
 * fire against stripped text, so those rules are scanned against the raw source
 * instead (round-1 review HIGH-3: the reviewer's `node:crypto` and `zod`
 * mutations both survived a green suite). `the guard fires` below proves each
 * rule on synthetic sources, mechanically, so no rule can go dead again without
 * a test going red.
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

interface Rule {
  readonly rule: string;
  readonly pattern: RegExp;
}

/**
 * What text a rule is matched against.
 *
 * - `"code"` — comments and string CONTENTS removed. For rules about executable
 *   syntax (`Date.now()`, `Math.random()`, `localeCompare`), where a prose
 *   mention in a module header must not be a finding.
 * - `"literals"` — the raw source with COMMENTS removed but string literals
 *   intact. For rules whose pattern needs the quotes: an import specifier, a
 *   URL. Comments still go, so a header that discusses `"zod"` is not a finding
 *   while an actual `from "zod"` is.
 */
type ScanMode = "code" | "literals";

/** Removes comments only, leaving string literals and their quotes in place. */
function withoutComments(text: string): string {
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
        } else {
          if (character === "'") mode = "single";
          else if (character === '"') mode = "double";
          else if (character === "`") mode = "template";
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
          out += text.slice(index, index + 2);
          index += 2;
          break;
        }
        if (character === closer) mode = "code";
        out += character;
        index += 1;
        break;
      }
    }
  }
  return out;
}

function prepare(text: string, mode: ScanMode): string {
  return mode === "code" ? strippedCode(text) : withoutComments(text);
}

/** Scans one source text, so a rule can be proved on a synthetic file. */
function scanText(text: string, file: string, rules: readonly Rule[], mode: ScanMode): readonly Finding[] {
  const findings: Finding[] = [];
  const lines = prepare(text, mode).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const { rule, pattern } of rules) {
      if (pattern.test(line)) {
        findings.push({ file, line: index + 1, text: line.trim(), rule });
      }
    }
  }
  return findings;
}

function scan(rules: readonly Rule[], mode: ScanMode = "code"): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    findings.push(
      ...scanText(readFileSync(file, "utf8"), file.slice(REPO_ROOT.length + 1), rules, mode),
    );
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

/** Every rule whose pattern needs a quote, and therefore the raw source. */
const NODE_BUILTIN_RULES: readonly Rule[] = [
  { rule: "node: import", pattern: /(?:from|import|require)\s*\(?\s*["'`]node:/u },
  {
    rule: "bare builtin import",
    pattern:
      /(?:from|import|require)\s*\(?\s*["'`](?:fs|crypto|path|url|util|os|http|https|net|zlib|stream|worker_threads|child_process)["'`]/u,
  },
];

const SCHEMA_LIBRARY_RULES: readonly Rule[] = [
  { rule: "zod import", pattern: /(?:from|import|require)\s*\(?\s*["'`]zod(?:\/[\w-]+)?["'`]/u },
];

/**
 * A URL is only ever a string LITERAL, so this rule needs the raw source.
 *
 * Comments are still removed, so the module headers that cite the venue
 * documentation are not findings — what is a finding is an endpoint the code
 * could actually reach.
 */
const URL_LITERAL_RULES: readonly Rule[] = [{ rule: "url literal", pattern: /https?:\/\//u }];

/**
 * The rest of the credential surface is about EXECUTABLE syntax — a call, an
 * identifier, a property — so it is matched against stripped code. Refusal
 * messages that use the word "signer" to say a simulated venue may not serve a
 * run mode that needs one are prose, not a signer.
 */
const CREDENTIAL_SURFACE_RULES: readonly Rule[] = [
  { rule: "websocket", pattern: /\bWebSocket\b/u },
  { rule: "fetch", pattern: /\bfetch\s*\(/u },
  { rule: "signer", pattern: /\bsigner\b/iu },
  { rule: "privateKey", pattern: /privateKey/iu },
  { rule: "apiSecret", pattern: /apiSecret/iu },
];

describe("packages/simulation imports no Node built-in (dependency-direction §2.2 / F17)", () => {
  it("has no `node:` import in any production source", () => {
    const findings = scan([NODE_BUILTIN_RULES[0] as Rule], "literals");
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("has no bare built-in import either (fs, crypto, path, …)", () => {
    const findings = scan([NODE_BUILTIN_RULES[1] as Rule], "literals");
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});

describe("packages/simulation runs no schema library (ADR-020 §3)", () => {
  it("imports zod nowhere", () => {
    const findings = scan(SCHEMA_LIBRARY_RULES, "literals");
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
  it("contains no URL literal", () => {
    // Scanned against the RAW source: a URL lives inside a string literal, and
    // a scan that stripped literals first could never see one (round-1 review
    // HIGH-3). Comments are still removed, so a header that cites the venue
    // documentation is not a finding.
    const findings = scan(URL_LITERAL_RULES, "literals");
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("names no socket, signer, or key in any executable position", () => {
    const findings = scan(CREDENTIAL_SURFACE_RULES, "code");
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guards are proved on synthetic sources
// ---------------------------------------------------------------------------

/**
 * A dead guard is worse than no guard: it reports "clean" about a rule that
 * cannot fire. The round-1 review demonstrated exactly that — a `node:crypto`
 * import, a `zod` import and a URL literal were each planted in the shipped
 * sources and the whole suite stayed green, because the scanner removed string
 * literals (and with them every quote the patterns needed) BEFORE matching.
 *
 * Each rule below is therefore fired on purpose, against source text written
 * here. A rule that stops matching its own violation fails by name.
 */
describe("the guard fires: every rule is proved against a planted violation", () => {
  const MUTATIONS: readonly {
    readonly name: string;
    readonly source: string;
    readonly rules: readonly Rule[];
    readonly mode: ScanMode;
    readonly rule: string;
  }[] = [
    {
      name: "a node:crypto import (review mutation M-b)",
      source: 'import { createHash } from "node:crypto";\n',
      rules: NODE_BUILTIN_RULES,
      mode: "literals",
      rule: "node: import",
    },
    {
      name: "a single-quoted node: import",
      source: "import { readFileSync } from 'node:fs';\n",
      rules: NODE_BUILTIN_RULES,
      mode: "literals",
      rule: "node: import",
    },
    {
      name: "a dynamic node: import",
      source: 'const fs = await import("node:fs");\n',
      rules: NODE_BUILTIN_RULES,
      mode: "literals",
      rule: "node: import",
    },
    {
      name: "a bare built-in import",
      source: 'import { createHash } from "crypto";\n',
      rules: NODE_BUILTIN_RULES,
      mode: "literals",
      rule: "bare builtin import",
    },
    {
      name: "a zod import (review mutation M-c)",
      source: 'import { z } from "zod";\n',
      rules: SCHEMA_LIBRARY_RULES,
      mode: "literals",
      rule: "zod import",
    },
    {
      name: "a zod subpath import",
      source: 'import { z } from "zod/v4";\n',
      rules: SCHEMA_LIBRARY_RULES,
      mode: "literals",
      rule: "zod import",
    },
    {
      name: "a URL literal (review mutation M-c)",
      source: 'const endpoint = "https://clob.polymarket.com/order";\n',
      rules: URL_LITERAL_RULES,
      mode: "literals",
      rule: "url literal",
    },
    {
      name: "a signer identifier",
      source: "const signer = loadSigner();\n",
      rules: CREDENTIAL_SURFACE_RULES,
      mode: "code",
      rule: "signer",
    },
    {
      name: "a clock read",
      source: "const now = Date.now();\n",
      rules: [{ rule: "Date.now", pattern: /\bDate\s*\.\s*now\b/u }],
      mode: "code",
      rule: "Date.now",
    },
    {
      name: "unseeded randomness",
      source: "const draw = Math.random();\n",
      rules: [{ rule: "Math.random", pattern: /\bMath\s*\.\s*random\b/u }],
      mode: "code",
      rule: "Math.random",
    },
    {
      name: "a locale-dependent comparison",
      source: "const order = left.localeCompare(right);\n",
      rules: [{ rule: "localeCompare", pattern: /localeCompare/u }],
      mode: "code",
      rule: "localeCompare",
    },
  ];

  for (const mutation of MUTATIONS) {
    it(`reports ${mutation.name}`, () => {
      const findings = scanText(mutation.source, "synthetic.ts", mutation.rules, mutation.mode);
      expect(findings.map((finding) => finding.rule)).toContain(mutation.rule);
    });
  }

  it("does NOT report the same specifiers when they only appear in prose", () => {
    // The other half of the claim: the rules stay inside their boundary, so a
    // module header that explains why this package imports no `node:` built-in
    // and no `"zod"`, and names `https://docs.polymarket.com`, is not a finding.
    const header = [
      "/**",
      " * This package imports no node: built-in, and never `from \"zod\"`.",
      " * See https://docs.polymarket.com for the venue documentation.",
      " */",
      "export const version = 1;",
      "",
    ].join("\n");
    const findings = scanText(
      header,
      "synthetic.ts",
      [...NODE_BUILTIN_RULES, ...SCHEMA_LIBRARY_RULES, ...URL_LITERAL_RULES],
      "literals",
    );
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("reports a violation planted in a REAL source file, read from disk", () => {
    // The scan is proved end-to-end, on the same reader the shipping suite
    // uses: a real file's text with one line added.
    const target = join(SOURCE_ROOT, "venue.ts");
    const mutated = `${readFileSync(target, "utf8")}\nimport { createHash } from "node:crypto";\n`;
    const findings = scanText(mutated, "packages/simulation/src/venue.ts", NODE_BUILTIN_RULES, "literals");
    expect(findings.map((finding) => finding.rule)).toEqual(["node: import"]);
    // …and the unmutated file is clean, so the finding is the planted line.
    expect(
      scanText(readFileSync(target, "utf8"), "venue.ts", NODE_BUILTIN_RULES, "literals"),
    ).toEqual([]);
  });
});
