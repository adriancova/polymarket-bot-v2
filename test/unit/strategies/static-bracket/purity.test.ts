/**
 * Purity and dependency posture, scanned from the package's own source.
 *
 * `check:deps` rule 3 is the authoritative mechanism for
 * `packages/strategies/**` (F3, F11, F14) and it runs in CI. This file is the
 * belt that fails inside `pnpm test` — the gate a package author runs most
 * often — and it additionally pins facts the dependency checker does not
 * express: the declared workspace edges, the absence of a schema library, and
 * the §9.6 interface surface.
 *
 * Reading source files with `node:fs` in the ROOT test tree is the established
 * pattern (`test/unit/{ledger,simulation}` do exactly this) and is outside F17
 * by `dependency-direction.md` §2.2's explicit scope statement.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REASONS,
  TAGS,
  legTag,
  orderTypeTag,
  staticBracketStrategy,
} from "../../../../packages/strategies/static-bracket/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages/strategies/static-bracket");
const SOURCE_ROOT = join(PACKAGE_ROOT, "src");

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name.endsWith(".ts")) found.push(path);
    }
  };
  walk(SOURCE_ROOT);
  return found.sort();
}

/**
 * Source with comments AND string literals removed, so neither prose nor a
 * refusal message can trip a scan. (`plain.ts` refuses "a Map, Set, Date, class
 * instance" by name, which is a message about the Date global, not a use of
 * it — the first run of this file found exactly that.) The authoritative check
 * is `check:deps`, which decides by AST identifier reference; this one is
 * textual and is deliberately conservative about what counts as code.
 */
function code(path: string): string {
  return uncommented(path)
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, "''")
    .replace(/`(?:[^`\\]|\\.)*`/gu, "``");
}

/** Source with comments removed but literals INTACT — for import specifiers. */
function uncommented(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

describe("purity of the strategy package", () => {
  const files = sourceFiles();

  it("has real source to scan", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  const forbidden: { pattern: RegExp; what: string }[] = [
    { pattern: /\bDate\b/u, what: "the Date global (a clock; F11)" },
    { pattern: /\bMath\s*\.\s*random\b/u, what: "unseeded randomness (F11)" },
    { pattern: /\bperformance\s*\./u, what: "a monotonic clock (F11)" },
    { pattern: /\bprocess\b/u, what: "the process global (F3)" },
    { pattern: /\bglobalThis\b/u, what: "an ambient global (F3)" },
    { pattern: /from\s+"node:/u, what: "a Node built-in (F3/F17)" },
    { pattern: /require\s*\(/u, what: "a module loader (F14)" },
    { pattern: /\bimport\s*\(/u, what: "a dynamic import (F14)" },
    { pattern: /\beval\s*\(/u, what: "an evaluator (F14)" },
    { pattern: /\.constructor\b/u, what: "a constructor read (F14)" },
    { pattern: /from\s+"zod"/u, what: "a schema library (ADR-005 §1; this package hand-rolls its door)" },
    { pattern: /fetch\s*\(/u, what: "network I/O (F3)" },
    { pattern: /setTimeout|setInterval/u, what: "scheduling (F3)" },
  ];

  for (const rule of forbidden) {
    it(`contains no ${rule.what}`, () => {
      const offenders = files.filter((file) => rule.pattern.test(code(file)));
      expect(offenders.map((file) => file.slice(PACKAGE_ROOT.length + 1))).toEqual([]);
    });
  }

  it("imports only the two declared workspace packages, plus its own modules", () => {
    const specifiers = new Set<string>();
    for (const file of files) {
      const pattern = /from\s+"([^"]+)"/gu;
      const body = uncommented(file);
      let match = pattern.exec(body);
      while (match !== null) {
        specifiers.add(match[1] ?? "");
        match = pattern.exec(body);
      }
    }
    const external = [...specifiers].filter((specifier) => !specifier.startsWith("./")).sort();
    expect(external).toEqual(["@polymarket-bot/decimal", "@polymarket-bot/strategy-sdk"]);
  });

  it("declares exactly those two workspace dependencies in its manifest", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      "@polymarket-bot/decimal": "workspace:*",
      "@polymarket-bot/strategy-sdk": "workspace:*",
    });
    const devWorkspace = Object.entries(manifest.devDependencies ?? {}).filter(([, version]) =>
      version.startsWith("workspace:"),
    );
    expect(devWorkspace).toEqual([]);
  });

  it("uses no deep import into another package (F16)", () => {
    for (const file of files) {
      const pattern = /from\s+"(@polymarket-bot\/[^"]+)"/gu;
      const body = uncommented(file);
      let match = pattern.exec(body);
      while (match !== null) {
        const specifier = match[1] ?? "";
        expect(specifier.split("/")).toHaveLength(2);
        match = pattern.exec(body);
      }
    }
  });

  it("performs no division on an economic value", () => {
    // The design property stated in `economics.ts`: no rounding policy exists
    // inside a trading decision, because no quotient is ever taken.
    for (const file of files) {
      const body = code(file);
      expect(body, `${file} imports a division helper`).not.toMatch(/divDecimal/u);
    }
  });
});

describe("the reason-code and tag vocabulary", () => {
  const CODE_STRING = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;

  it("satisfies the frozen CodeString grammar and its length bound", () => {
    for (const code of Object.values(REASONS)) {
      expect(code, `${code} is not a CodeString`).toMatch(CODE_STRING);
      expect(code.length, `${code} exceeds 64 characters`).toBeLessThanOrEqual(64);
    }
    for (const tag of [...Object.values(TAGS), orderTypeTag("FAK"), legTag("YES")]) {
      expect(tag).toMatch(CODE_STRING);
      expect(tag.length).toBeLessThanOrEqual(64);
    }
  });

  it("never impersonates the runtime (ADR-005 §3 reserves the RUNTIME. prefix)", () => {
    for (const code of Object.values(REASONS)) {
      expect(code.startsWith("RUNTIME.")).toBe(false);
    }
  });

  it("has no duplicate code, so two conditions cannot report as one", () => {
    const codes = Object.values(REASONS);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("the §9.6 interface surface", () => {
  it("presents the four identity members", () => {
    expect(staticBracketStrategy.name).toBe("static-bracket");
    expect(typeof staticBracketStrategy.version).toBe("string");
    // v2: the review-round-1 remediation added `legBaselineShares` and
    // `OrderTrack.viewFilledShares`, both required. §9.6 makes a state-schema
    // change a NEW RUN rather than an in-place migration, and this number is how
    // the runtime tells the two apart.
    expect(staticBracketStrategy.stateSchemaVersion).toBe(2);
    expect(typeof (staticBracketStrategy.paramsSchema as { safeParse: unknown }).safeParse).toBe(
      "function",
    );
  });

  it("implements all nine callbacks and nothing else", () => {
    const callbacks = [
      "onStart",
      "onMarketOpen",
      "onFeatures",
      "onFill",
      "onOrderUpdate",
      "onTimer",
      "onMarketClosing",
      "onMarketResolved",
      "onStop",
    ];
    const own = Object.keys(staticBracketStrategy).sort();
    expect(own).toEqual(
      [...callbacks, "name", "version", "paramsSchema", "stateSchemaVersion"].sort(),
    );
    for (const callback of callbacks) {
      expect(
        typeof (staticBracketStrategy as unknown as Record<string, unknown>)[callback],
      ).toBe("function");
    }
  });

  it("is frozen, so no caller can swap a callback out from under the runtime", () => {
    expect(Object.isFrozen(staticBracketStrategy)).toBe(true);
  });
});
