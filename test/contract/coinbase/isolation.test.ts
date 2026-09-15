/**
 * The acceptance criterion "Adapter never reads strategy configuration
 * directly", and the safety rule that no credential exists anywhere in this
 * package.
 *
 * Both are properties of the SOURCE, not of a run, so they are checked by
 * reading the source tree. A behavioural test cannot prove the absence of an
 * environment read on a path it did not happen to take.
 *
 * The forbidden tokens are assembled from pieces so this file does not match its
 * own patterns; the scan covers `packages/coinbase-adapter/src/**`, which is
 * every line of the package.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(repoRoot, "packages/coinbase-adapter");
const sourceRoot = join(packageRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Every `.ts` file in the package, colocated tests included. */
const FILES = sourceFiles(sourceRoot).sort();

/**
 * The files that actually ship.
 *
 * Two checks below are about what the *adapter* may do, not about what a test
 * may assert: a colocated test naturally names the endpoint it is asserting on,
 * and a test double naturally stands in for a global. The environment,
 * credential, dependency, and I/O checks stay over every file, because none of
 * those is ever legitimate here.
 */
const IMPLEMENTATION_FILES = FILES.filter((file) => !file.endsWith(".test.ts"));

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * Every MODULE SPECIFIER `text` declares, read from its syntax tree.
 *
 * `ImportDeclaration` and `ExportDeclaration` module specifiers (so a
 * side-effect import and `export * from` count), `import x = require("…")`
 * external module references, `import("…")` type nodes, and dynamic
 * `import(…)` — the same five positions
 * `tools/check-dependency-direction.mjs` collects, and for its stated reason:
 * "Comments and string data are inert in an AST, so text that merely *mentions*
 * a specifier is structurally incapable of producing a finding, and a specifier
 * is recognised wherever the grammar puts one regardless of intervening
 * trivia." A dynamic `import()` whose argument is not a literal is reported as
 * `<computed>` so it can never be mistaken for "no specifier here".
 */
function moduleSpecifiersIn(text: string, fileName: string): readonly string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)) {
        specifiers.push(moduleSpecifier.text);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      specifiers.push(ts.isStringLiteralLike(expression) ? expression.text : "<computed>");
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        specifiers.push(argument.literal.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      specifiers.push(first !== undefined && ts.isStringLiteralLike(first) ? first.text : "<computed>");
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return specifiers;
}

describe("the package source", () => {
  it("has files to scan", () => {
    expect(FILES.length).toBeGreaterThan(8);
    expect(IMPLEMENTATION_FILES.length).toBeGreaterThan(8);
    expect(IMPLEMENTATION_FILES.length).toBeLessThan(FILES.length);
  });

  it("reads no environment variable", () => {
    const env = ["process", "env"].join(".");
    const envAlt = ["process", '["env"]'].join("");
    for (const file of FILES) {
      const text = read(file);
      expect(text.includes(env), relative(repoRoot, file)).toBe(false);
      expect(text.includes(envAlt), relative(repoRoot, file)).toBe(false);
      expect(text.includes("import.meta.env"), relative(repoRoot, file)).toBe(false);
    }
  });

  it("imports no configuration or strategy package", () => {
    const forbidden = [
      "@polymarket-bot/config",
      "@polymarket-bot/strategy-sdk",
      "@polymarket-bot/strategy-runtime",
      "@polymarket-bot/strategies",
      "@polymarket-bot/observability",
      "@polymarket-bot/event-bus",
      "@polymarket-bot/storage-postgres",
      "@polymarket-bot/storage-wal",
      "dotenv",
    ];
    for (const file of FILES) {
      const text = read(file);
      for (const specifier of forbidden) {
        expect(text.includes(`"${specifier}`), `${relative(repoRoot, file)} imports ${specifier}`).toBe(
          false,
        );
      }
    }
  });

  it("declares only downward workspace dependencies", () => {
    const manifest = JSON.parse(read(join(packageRoot, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const workspaceDeps = Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => name)
      .sort();
    // Downward only: `docs/contracts/dependency-direction.md` §2 puts this
    // package at layer 2 and permits no same-layer edge that is not enumerated.
    // The two layer-0 contracts, plus — since `SER-3` (2026-09-15) — the
    // layer-1 own-data JSON encoder `@polymarket-bot/risk/plain-json`, which
    // `venue-facts.ts` consumes to build the subscribe/unsubscribe frame bytes
    // (`docs/handoffs/SER-0-sweep.md`, `coinbase-subscribe-unsubscribe-frames`).
    // Still no same-layer edge, and no engine, policy or evaluation logic
    // travels the risk edge: the package root is never imported.
    expect(workspaceDeps).toEqual([
      "@polymarket-bot/decimal",
      "@polymarket-bot/domain",
      "@polymarket-bot/risk",
    ]);
    // WHICH `risk` SUBPATH, read from the SYNTAX TREE rather than from text
    // (`SER-3` review round 1, L2). The first spelling of this check was a
    // regular expression for a double-quoted `from "…"` or `import("…")`,
    // which misses a single-quoted import and a SIDE-EFFECT import
    // (`import '@polymarket-bot/risk';`) entirely — so it could not support
    // the claim "this is the only specifier anywhere". The compiler API sees a
    // specifier wherever the grammar puts one, in any quoting style, and
    // ignores text inside comments and string data, which is what
    // `tools/check-dependency-direction.mjs` does for the same reason.
    // `typescript` is already a root devDependency and this suite runs after
    // install; the negative fixtures below prove the walk sees the spellings
    // the regular expression missed.
    const riskSpecifiers = new Set<string>();
    for (const file of FILES) {
      for (const specifier of moduleSpecifiersIn(read(file), file)) {
        if (specifier === "@polymarket-bot/risk" || specifier.startsWith("@polymarket-bot/risk/")) {
          riskSpecifiers.add(specifier);
        }
      }
    }
    expect([...riskSpecifiers].sort()).toEqual(["@polymarket-bot/risk/plain-json"]);
  });

  it("the specifier walk sees every import spelling, including the ones a regex missed", () => {
    // Negative fixtures: source TEXT, not files in the package. Each line is a
    // spelling that WOULD be a violation of the subpath rule above, and each
    // must be visible to the walk. The two marked ones are exactly what the
    // round-1 regular expression could not see.
    const fixture = [
      `import '@polymarket-bot/risk';`, // side-effect import — MISSED by the regex
      `import { a } from '@polymarket-bot/risk/engine';`, // single-quoted — MISSED
      `import { b } from "@polymarket-bot/risk/plain-data";`,
      `import type { C } from '@polymarket-bot/risk/policy';`,
      `export * from "@polymarket-bot/risk/lots";`,
      `export { d } from '@polymarket-bot/risk/guards';`,
      `const e = await import('@polymarket-bot/risk/scenario');`,
      `type F = import("@polymarket-bot/risk/inputs").F;`,
      `import g = require("@polymarket-bot/risk/result");`,
      `// a comment naming "@polymarket-bot/risk/not-an-import"`,
      `const h = "@polymarket-bot/risk/not-an-import-either";`,
    ].join("\n");

    const seen = moduleSpecifiersIn(fixture, "fixture.ts").filter(
      (specifier) => specifier === "@polymarket-bot/risk" || specifier.startsWith("@polymarket-bot/risk/"),
    );
    expect([...new Set(seen)].sort()).toEqual([
      "@polymarket-bot/risk",
      "@polymarket-bot/risk/engine",
      "@polymarket-bot/risk/guards",
      "@polymarket-bot/risk/inputs",
      "@polymarket-bot/risk/lots",
      "@polymarket-bot/risk/plain-data",
      "@polymarket-bot/risk/policy",
      "@polymarket-bot/risk/result",
      "@polymarket-bot/risk/scenario",
    ]);
    // Text that merely MENTIONS the package is inert in a syntax tree, which a
    // text scan cannot tell apart from an import.
    expect(seen).not.toContain("@polymarket-bot/risk/not-an-import");
    expect(seen).not.toContain("@polymarket-bot/risk/not-an-import-either");

    // And the check that consumes this walk really would fail on one of them:
    // the package's own answer plus a side-effect import is two specifiers.
    const violating = [...new Set([...seen, "@polymarket-bot/risk/plain-json"])].sort();
    expect(violating).not.toEqual(["@polymarket-bot/risk/plain-json"]);
  });

  it("holds no credential, signer, or authentication material", () => {
    const forbidden = [
      "jwt",
      "apiKey",
      "api_key",
      "secretKey",
      "passphrase",
      "privateKey",
      "signature",
      "Authorization",
      "advanced-trade-ws-user",
    ];
    for (const file of FILES) {
      const text = read(file);
      for (const token of forbidden) {
        // `jwt` appears only inside a quoted documentation sentence that states
        // the public endpoint does not need one, so the check is on code shape:
        // no assignment, no property, no template interpolation of the token.
        expect(
          new RegExp(`${token}\\s*[:=]`, "u").test(text),
          `${relative(repoRoot, file)} mentions ${token} in a code position`,
        ).toBe(false);
      }
    }
  });

  it("names a venue endpoint in exactly one file", () => {
    // Endpoints are constants in `venue-facts.ts`, next to the citation that
    // establishes them. A URL literal anywhere else would be an endpoint with no
    // provenance, which is how an undocumented — or authenticated — host gets
    // dialled by accident.
    // `wss://` followed by a host character. The bare scheme prefix, which
    // `node-runtime.ts` uses to refuse a plaintext endpoint, is not a host.
    const filesWithUrls = IMPLEMENTATION_FILES.filter((file) =>
      /wss:\/\/[A-Za-z0-9]/u.test(read(file)),
    ).map((file) => relative(packageRoot, file).replaceAll("\\", "/"));
    expect(filesWithUrls).toEqual(["src/venue-facts.ts"]);
  });

  it("has exactly one endpoint constant, and it is the documented public one", () => {
    const text = read(join(sourceRoot, "venue-facts.ts"));
    const literals = [...text.matchAll(/"(wss:\/\/[A-Za-z0-9./-]+)"/gu)].map((match) => match[1]);
    expect(literals).toEqual(["wss://advanced-trade-ws.coinbase.com"]);
    // The Coinbase Exchange alternative is discussed in prose so the choice is
    // reviewable, but it is not a string literal anything could dial, and the
    // authenticated user endpoint is not mentioned at all.
    expect(text).not.toContain("advanced-trade-ws-user");
  });

  it("touches a global in exactly one file", () => {
    const impure = IMPLEMENTATION_FILES.filter((file) => {
      const text = read(file);
      return (
        /\bnew WebSocket\(/u.test(text) ||
        /\bprocess\.hrtime\b/u.test(text) ||
        /\bsetTimeout\(/u.test(text)
      );
    }).map((file) => relative(packageRoot, file).replaceAll("\\", "/"));
    expect(impure).toEqual(["src/node-runtime.ts"]);
  });

  it("performs no I/O outside the socket port", () => {
    for (const file of FILES) {
      const text = read(file);
      for (const builtin of ["node:fs", "node:http", "node:https", "node:net", "node:child_process"]) {
        expect(text.includes(builtin), `${relative(repoRoot, file)} imports ${builtin}`).toBe(false);
      }
      expect(/\bfetch\(/u.test(text), relative(repoRoot, file)).toBe(false);
    }
  });
});
