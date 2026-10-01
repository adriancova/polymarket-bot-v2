/**
 * Only `packages/polymarket-secure` imports the secure SDK entry points
 * (work-plan `WP-260` acceptance 1; handoff §9.12; ADR-010 §4;
 * `dependency-direction.md` F6, F7).
 *
 * WHY A TEST AS WELL AS `check:deps`. The dependency checker's F6 rule reads
 * import specifiers in workspace PACKAGE source only. This scan is wider:
 *
 * - every source file in the repository (`apps/**`, `packages/**`,
 *   `test/**`, `tools/**`, and root files), untracked files included;
 * - every `package.json` dependency field, not only imports;
 * - the lockfile's importers, so no other workspace project resolves the SDK;
 * - the archived clients (F7) everywhere.
 *
 * Specifiers are read from TypeScript's own parse of each file (static
 * imports and re-exports, `import x = require()`, `import("…")` types, and
 * dynamic `import("…")` / `require("…")` with literal arguments), so a
 * mention inside a string or comment is not an import.
 * A non-literal dynamic import is out of reach of any static scan; that
 * limit is shared with `check:deps` (F14 applies only to the purity-
 * restricted packages).
 *
 * NON-VACUOUS: the scan must find this package's own SDK imports (positive
 * control), and it must flag planted violations of every kind.
 *
 * TEST-ONLY SUBPATH (review r1, finding L4). The same scan also enforces that
 * `@polymarket-bot/polymarket-secure/testing` (the mock signer, the fake SDK
 * and `createSecureVenueClientForTesting`) is imported only by TEST files: a
 * file under `test/`, or a `*.test.*` / `*.spec.*` file. A relative import
 * that resolves into `packages/polymarket-secure/src/testing/` counts the
 * same. The testing directory itself may import its own siblings. Rule
 * label: `TEST-ONLY`. (`check:deps` F12 legitimately allows a layer-3 app to
 * import this layer-2 package; this rule narrows only the test subpath.)
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "./testing/network-tripwire.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OWNER_DIR = "packages/polymarket-secure";
const UNIFIED_SDK = "@polymarket/client";
const ARCHIVED_CLIENTS = [
  "@polymarket/clob-client",
  "@polymarket/clob-client-v2",
  "@polymarket/builder-relayer-client",
  "@polymarket/builder-signing-sdk",
];
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "python", ".venv"]);
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"];
const TESTING_SUBPATH = "@polymarket-bot/polymarket-secure/testing";
const TESTING_DIR = `${OWNER_DIR}/src/testing`;

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

interface RepoFile {
  readonly path: string;
  readonly text: string;
}

interface Finding {
  readonly path: string;
  readonly rule: "F6" | "F7" | "TEST-ONLY";
  readonly via: "import" | "manifest" | "lockfile";
  readonly specifier: string;
}

function matches(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

function isOwned(file: string): boolean {
  return file === OWNER_DIR || file.startsWith(`${OWNER_DIR}/`);
}

function judge(file: string, specifier: string, via: Finding["via"]): Finding[] {
  const out: Finding[] = [];
  if (ARCHIVED_CLIENTS.some((name) => matches(specifier, name))) out.push({ path: file, rule: "F7", via, specifier });
  if (matches(specifier, UNIFIED_SDK) && !isOwned(file)) out.push({ path: file, rule: "F6", via, specifier });
  return out;
}

/** A test file: under `test/`, or named `*.test.*` / `*.spec.*`. */
function isTestFile(file: string): boolean {
  return file.startsWith("test/") || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);
}

/** Does this import specifier, written in `file`, reach the test-only subpath? */
function reachesTestingSubpath(file: string, specifier: string): boolean {
  if (matches(specifier, TESTING_SUBPATH)) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return resolved === TESTING_DIR || resolved.startsWith(`${TESTING_DIR}/`);
}

function isInsideTestingDir(file: string): boolean {
  return file.startsWith(`${TESTING_DIR}/`);
}

/**
 * Import specifiers of one source file, from one TypeScript parse: static
 * imports and re-exports (type-only included), `import x = require()`, an
 * `import("…")` type, and literal dynamic `import()` / `require()` calls.
 * TypeScript resolves string escapes, so `"\u0040polymarket/client"` is seen
 * as `@polymarket/client`.
 */
function importSpecifiers(text: string, fileName: string): string[] {
  const specifiers: string[] = [];
  const kind = /\.(?:c|m)?jsx?$/u.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const literal = (node: ts.Node | undefined): void => {
    if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) literal(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(specifiers)];
}

/** The scan itself: pure over a file list, so it can be tested on planted inputs. */
function scanSdkBoundary(files: readonly RepoFile[]): { findings: Finding[]; ownedSdkImports: string[]; testingImports: string[] } {
  const findings: Finding[] = [];
  const ownedSdkImports: string[] = [];
  const testingImports: string[] = [];
  for (const file of files) {
    const base = path.posix.basename(file.path);
    if (base === "package.json") {
      const manifest = JSON.parse(file.text) as Record<string, unknown>;
      for (const field of DEPENDENCY_FIELDS) {
        const deps = manifest[field];
        const names = Array.isArray(deps) ? (deps as unknown[]).map(String) : typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
        for (const name of names) findings.push(...judge(file.path, name, "manifest"));
      }
      continue;
    }
    if (base === "pnpm-lock.yaml") {
      // Importer blocks: a line `  <dir>:` at two-space indent inside
      // `importers:`, followed by its dependency names at six-space indent.
      let inImporters = false;
      let importer = "";
      for (const line of file.text.split("\n")) {
        if (/^\S/u.test(line)) inImporters = line.startsWith("importers:");
        if (!inImporters) continue;
        const importerMatch = /^ {2}(\S[^:]*):\s*$/u.exec(line);
        if (importerMatch?.[1] !== undefined) importer = importerMatch[1] === "." ? "(root)" : importerMatch[1];
        const depMatch = /^ {6}'?(@?[^':\s]+)'?:\s*$/u.exec(line);
        if (depMatch?.[1] !== undefined) findings.push(...judge(importer, depMatch[1], "lockfile"));
      }
      continue;
    }
    for (const specifier of importSpecifiers(file.text, file.path)) {
      findings.push(...judge(file.path, specifier, "import"));
      if (isOwned(file.path) && matches(specifier, UNIFIED_SDK)) ownedSdkImports.push(`${file.path} -> ${specifier}`);
      if (reachesTestingSubpath(file.path, specifier) && !isInsideTestingDir(file.path)) {
        testingImports.push(`${file.path} -> ${specifier}`);
        if (!isTestFile(file.path)) findings.push({ path: file.path, rule: "TEST-ONLY", via: "import", specifier });
      }
    }
  }
  return { findings, ownedSdkImports, testingImports };
}

async function collect(dir: string, out: RepoFile[]): Promise<void> {
  for (const entry of await readdir(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await collect(rel, out);
    } else if (entry.isFile() && (SOURCE_EXTENSIONS.has(path.extname(entry.name)) || entry.name === "package.json" || rel === "pnpm-lock.yaml")) {
      out.push({ path: rel, text: await readFile(path.join(REPO_ROOT, rel), "utf8") });
    }
  }
}

describe("the repository: only packages/polymarket-secure imports @polymarket/client", () => {
  // One TypeScript parse per source file in the repository: seconds of work
  // under a loaded parallel run, so this test states its own time budget.
  it("finds no F6/F7 violation anywhere, and does find this package's own SDK imports", { timeout: 120_000 }, async () => {
    const files: RepoFile[] = [];
    await collect("", files);
    // The scan covered the trees it claims to cover.
    for (const prefix of ["apps/", "packages/", "test/", "tools/"]) {
      expect(files.some((file) => file.path.startsWith(prefix))).toBe(true);
    }
    expect(files.some((file) => file.path === "pnpm-lock.yaml")).toBe(true);
    const { findings, ownedSdkImports, testingImports } = scanSdkBoundary(files);
    expect(findings).toEqual([]);
    // Positive control for TEST-ONLY: the test files that do use the test
    // subpath are seen (and allowed).
    expect(testingImports).toContain(`${OWNER_DIR}/src/venue-client.test.ts -> ./testing/index.js`);
    expect(testingImports.some((entry) => entry.startsWith("test/contract/polymarket-secure/"))).toBe(true);
    // Positive control: the owner package's real imports are seen.
    expect(ownedSdkImports).toContain(`${OWNER_DIR}/src/error-mapping.ts -> ${UNIFIED_SDK}`);
    expect(ownedSdkImports).toContain(`${OWNER_DIR}/src/sdk-port.ts -> ${UNIFIED_SDK}`);
    // And the lockfile shows the SDK resolved for this package, pinned exactly.
    const lock = files.find((file) => file.path === "pnpm-lock.yaml")?.text ?? "";
    expect(lock).toMatch(/ {2}packages\/polymarket-secure:\n(?: {4}.*\n)*? {6}'@polymarket\/client':\n {8}specifier: 0\.11\.0\n/u);
  });
});

describe("NON-VACUOUS: planted violations are caught", () => {
  const planted: RepoFile[] = [
    { path: "packages/oms/src/venue.ts", text: 'import { createSecureClient } from "@polymarket/client";\n' },
    { path: "packages/oms/src/types.ts", text: 'import type { Signer } from "@polymarket/client";\n' },
    { path: "packages/oms/src/reexport.ts", text: 'export { privateKey } from "@polymarket/client/viem";\n' },
    { path: "apps/trader/src/lazy.ts", text: 'export const load = () => import("@polymarket/client");\n' },
    { path: "apps/trader/src/cjs.cjs", text: 'const sdk = require("@polymarket/client");\nmodule.exports = sdk;\n' },
    { path: "test/unit/leak.test.ts", text: 'import sdk = require("@polymarket/client");\nexport { sdk };\n' },
    { path: "test/unit/type.test.ts", text: 'export type C = typeof import("@polymarket/client");\n' },
    { path: "tools/probe.mjs", text: "const m = await import(`@polymarket/client`);\nexport default m;\n" },
    { path: "tools/escaped.mjs", text: 'import sdk from "\\u0040polymarket/client";\nexport default sdk;\n' },
    { path: "packages/risk/package.json", text: JSON.stringify({ dependencies: { "@polymarket/client": "0.11.0" } }) },
    { path: "packages/polymarket-secure/src/old.ts", text: 'import { ClobClient } from "@polymarket/clob-client";\n' },
    { path: "apps/trader/src/wire.ts", text: 'import { createSecureVenueClientForTesting } from "@polymarket-bot/polymarket-secure/testing";\n' },
    { path: "packages/oms/src/mock.ts", text: 'export { createMockSignerHandle } from "@polymarket-bot/polymarket-secure/testing";\n' },
    { path: "packages/polymarket-secure/src/leak.ts", text: 'import { createMockSignerHandle } from "./testing/index.js";\n' },
    { path: "tools/relative.ts", text: 'import { createFakeSdkFactory } from "../packages/polymarket-secure/src/testing/fake-sdk.js";\n' },
    {
      path: "pnpm-lock.yaml",
      text: "importers:\n\n  packages/oms:\n    dependencies:\n      '@polymarket/client':\n        specifier: 0.11.0\n        version: 0.11.0\n\npackages:\n\n  '@polymarket/client@0.11.0':\n    resolution: {}\n",
    },
  ];

  it("flags every planted violation, by the rule and channel that applies", () => {
    const { findings } = scanSdkBoundary(planted);
    const flagged = findings.map((finding) => `${finding.rule}:${finding.via}:${finding.path}`).sort();
    expect(flagged).toEqual(
      [
        "F6:import:packages/oms/src/venue.ts",
        "F6:import:packages/oms/src/types.ts",
        "F6:import:packages/oms/src/reexport.ts",
        "F6:import:apps/trader/src/lazy.ts",
        "F6:import:apps/trader/src/cjs.cjs",
        "F6:import:test/unit/leak.test.ts",
        "F6:import:test/unit/type.test.ts",
        "F6:import:tools/probe.mjs",
        "F6:import:tools/escaped.mjs",
        "F6:manifest:packages/risk/package.json",
        "F7:import:packages/polymarket-secure/src/old.ts",
        "F6:lockfile:packages/oms",
        "TEST-ONLY:import:apps/trader/src/wire.ts",
        "TEST-ONLY:import:packages/oms/src/mock.ts",
        "TEST-ONLY:import:packages/polymarket-secure/src/leak.ts",
        "TEST-ONLY:import:tools/relative.ts",
      ].sort(),
    );
  });

  it("does not flag a mention in a string or a comment, or the owner package's own import", () => {
    const { findings } = scanSdkBoundary([
      { path: "test/unit/tooling/example.test.ts", text: 'const note = "import { x } from \\"@polymarket/client\\"";\n// import "@polymarket/client"\nexport { note };\n' },
      { path: "packages/polymarket-secure/src/ok.ts", text: 'import { createSecureClient } from "@polymarket/client";\nexport { createSecureClient };\n' },
      { path: "packages/polymarket-secure/package.json", text: JSON.stringify({ dependencies: { "@polymarket/client": "0.11.0" } }) },
      // Test files may use the test-only subpath; so may the testing directory itself.
      { path: "apps/trader/src/wire.test.ts", text: 'import { createMockSignerHandle } from "@polymarket-bot/polymarket-secure/testing";\n' },
      { path: "test/unit/secure/x.test.ts", text: 'import { createMockSignerHandle } from "../../../packages/polymarket-secure/src/testing/index.js";\n' },
      { path: "packages/polymarket-secure/src/testing/index.ts", text: 'export { createMockSignerHandle } from "./mock-signer.js";\n' },
      // The main entry point is not the test subpath.
      { path: "apps/trader/src/live.ts", text: 'import { createSecureVenueClient } from "@polymarket-bot/polymarket-secure";\n' },
    ]);
    expect(findings).toEqual([]);
  });
});
