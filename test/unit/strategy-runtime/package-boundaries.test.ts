/**
 * WP-170 acceptance 2: "Strategies cannot import venue/storage adapters
 * through package boundaries."
 *
 * The enforcement is layered, and this file pins the parts WP-170 owns:
 *
 * 1. CONTRACT: `docs/contracts/dependency-direction.md` F3/F11/F14 bind
 *    `packages/strategies/**`; `tools/check-dependency-direction.mjs`
 *    (`pnpm check:deps`, CI-wired) evaluates them, plus F12/F13 for every
 *    package. Owned by WP-015/WP-030 — corroborated by running the gate, not
 *    duplicated here.
 * 2. STRUCTURE (owned here): a strategy's sanctioned import surface is
 *    `packages/strategy-sdk` (the §2.1 S2 edge). This file pins that the
 *    SDK's manifest reaches ONLY the frozen layer-0 domain package, and that
 *    its sources import nothing else — so nothing transitively reachable
 *    through the SDK owns a connection, a signer, or a filesystem. It also
 *    pins the runtime's surface (domain + SDK) because `strategies →
 *    strategy-runtime` is NOT an enumerated same-layer edge: F13 fails closed
 *    on it, and the persistence ports living in the runtime are therefore
 *    structurally out of a strategy's reach.
 * 3. pnpm workspace resolution: a package can only import a workspace package
 *    it declares (dependency-direction §5).
 *
 * These tests read manifests and sources with `node:fs` — this tree is the
 * root test tree, not a purity-restricted package.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Manifest {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly exports?: Record<string, string>;
}

function readManifest(relative: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, relative), "utf8")) as Manifest;
}

function sourceFiles(relativeDir: string): string[] {
  const absolute = join(REPO_ROOT, relativeDir);
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(absolute, entry));
}

function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const patterns = [
    /from\s+"([^"]+)"/g,
    /import\s+"([^"]+)"/g,
    /import\s*\(\s*"([^"]+)"\s*\)/g,
    /require\s*\(\s*"([^"]+)"\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

describe("acceptance 2: strategies cannot reach venue/storage adapters through package boundaries", () => {
  it("the SDK's manifest dependency surface is EXACTLY the frozen layer-0 domain package", () => {
    const manifest = readManifest("packages/strategy-sdk/package.json");
    expect(manifest.name).toBe("@polymarket-bot/strategy-sdk");
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@polymarket-bot/domain"]);
    // Dev dependencies carry no workspace package either: nothing reachable at
    // any install stage owns a connection.
    for (const dep of Object.keys(manifest.devDependencies ?? {})) {
      expect(dep.startsWith("@polymarket-bot/")).toBe(false);
    }
  });

  it("the runtime's manifest dependency surface is EXACTLY domain + strategy-sdk (the pre-listed S1 edge)", () => {
    const manifest = readManifest("packages/strategy-runtime/package.json");
    expect(manifest.name).toBe("@polymarket-bot/strategy-runtime");
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@polymarket-bot/domain",
      "@polymarket-bot/strategy-sdk",
    ]);
    for (const dep of Object.keys(manifest.devDependencies ?? {})) {
      expect(dep.startsWith("@polymarket-bot/")).toBe(false);
    }
  });

  it("neither manifest reaches any adapter, storage, transport, or venue package", () => {
    const forbidden = [
      "@polymarket-bot/polymarket-public",
      "@polymarket-bot/polymarket-secure",
      "@polymarket-bot/binance-adapter",
      "@polymarket-bot/coinbase-adapter",
      "@polymarket-bot/storage-postgres",
      "@polymarket-bot/storage-wal",
      "@polymarket-bot/storage-parquet",
      "@polymarket-bot/event-bus",
      "@polymarket/client",
      "pg",
      "kysely",
      "ioredis",
      "redis",
    ];
    for (const packagePath of [
      "packages/strategy-sdk/package.json",
      "packages/strategy-runtime/package.json",
    ]) {
      const manifest = readManifest(packagePath);
      const declared = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      for (const name of forbidden) {
        expect(declared, `${packagePath} must not declare ${name}`).not.toContain(name);
      }
    }
  });

  it("every SDK source import is relative or the domain entry point — no Node built-in, no adapter, no deep import (F16)", () => {
    const files = sourceFiles("packages/strategy-sdk/src");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const specifier of importSpecifiers(file)) {
        const allowed = specifier.startsWith("./") || specifier === "@polymarket-bot/domain";
        expect(allowed, `${file} imports "${specifier}"`).toBe(true);
      }
    }
  });

  it("every runtime source import is relative, the domain entry point, or the SDK entry point", () => {
    const files = sourceFiles("packages/strategy-runtime/src");
    expect(files.length).toBeGreaterThan(0);
    const entryPoints = new Set(["@polymarket-bot/domain", "@polymarket-bot/strategy-sdk"]);
    for (const file of files) {
      for (const specifier of importSpecifiers(file)) {
        const allowed = specifier.startsWith("./") || entryPoints.has(specifier);
        expect(allowed, `${file} imports "${specifier}"`).toBe(true);
      }
    }
  });

  it("neither package's sources contain a dynamic import or require (the F14 opaque-load rule, applied by construction)", () => {
    for (const dir of ["packages/strategy-sdk/src", "packages/strategy-runtime/src"]) {
      for (const file of sourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        expect(/\bimport\s*\(/.test(source), `${file} uses dynamic import()`).toBe(false);
        expect(/\brequire\s*\(/.test(source), `${file} uses require()`).toBe(false);
      }
    }
  });

  it("neither package's sources read a clock, unseeded randomness, or a process global (F1/F11 applied to the SDK surface)", () => {
    // The dependency-direction check applies F11 to `packages/strategies/**`.
    // A strategy is only as pure as what the runtime hands it, so the same
    // discipline is pinned here for the two packages a strategy can see
    // through: if the RUNTIME read `Date.now()` and put it in the context, the
    // strategy would be impure without naming a clock itself.
    const forbidden: Array<[RegExp, string]> = [
      [/\bDate\s*\.\s*now\b/, "Date.now"],
      [/\bnew\s+Date\b/, "new Date"],
      [/\bMath\s*\.\s*random\b/, "Math.random"],
      [/\bperformance\s*\.\s*now\b/, "performance.now"],
      [/\bprocess\s*\.\s*(env|hrtime|uptime)\b/, "process global"],
      [/\bglobalThis\b/, "globalThis"],
      [/\bcrypto\s*\.\s*(randomUUID|getRandomValues)\b/, "ambient crypto randomness"],
      [/\bnode:/, "a Node built-in module"],
    ];
    for (const dir of ["packages/strategy-sdk/src", "packages/strategy-runtime/src"]) {
      for (const file of sourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        // Strip block and line comments: the prose explains what is forbidden.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        for (const [pattern, label] of forbidden) {
          expect(pattern.test(code), `${file} references ${label}`).toBe(false);
        }
      }
    }
  });

  it("both packages expose only their entry point through the exports map (F16)", () => {
    for (const packagePath of [
      "packages/strategy-sdk/package.json",
      "packages/strategy-runtime/package.json",
    ]) {
      const manifest = readManifest(packagePath);
      expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
    }
  });

  it("the one concrete strategy package today declares no dependency on the runtime (F13 fails closed on strategies → strategy-runtime)", () => {
    const manifest = readManifest("packages/strategies/static-bracket/package.json");
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(declared).not.toContain("@polymarket-bot/strategy-runtime");
  });
});
