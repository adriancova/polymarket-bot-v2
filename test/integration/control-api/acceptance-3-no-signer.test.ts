/**
 * WP-240 ACCEPTANCE 3 — "No signer is loaded."
 *
 * Asserted by ABSENCE, over the shipped source of both trees `WP-240` owns,
 * plus the manifests — and, for imports, over the control API's own test
 * suites and `infra/grafana/**` too (`CONTROL-1`, closing `WP-240` r1 N-4).
 * Imports are read from each file's SYNTAX TREE, as the evaluated literal,
 * and whatever the scan cannot read fails it (`CONTROL-1b`, closing
 * `CONTROL1-R2-J-L1`: the regular expression of `CONTROL-1` r1 missed a line
 * comment and an escaped specifier; `support/module-loads.ts`). This is the
 * `apps/trader` precedent
 * (`test/integration/paper-trader/compose-and-example-config.test.ts`'s scans),
 * applied to a package whose §4.1 description is literally "never has the
 * signing key".
 *
 * Three independent claims:
 *
 * 1. **No import** of the secure adapter, a venue client, or a signing library
 *    — and none of them even resolves from a scanned tree.
 * 2. **No identifier** naming a signer, a wallet key or a credential in
 *    production source — and the exceptions are enumerated, not waived: the
 *    words appear only where the code REFUSES them.
 * 3. **No manifest dependency** on `packages/polymarket-secure`, and no
 *    credential-shaped value in the shipped example configuration.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALL_PRODUCTION_NAMES, CREDENTIAL_NAME_PATTERNS } from "@polymarket-bot/observability";

import {
  COMPUTED,
  LOADER_MODULES,
  SCANNED_EXTENSIONS,
  UNPARSEABLE,
  loaderFinding,
  moduleLoadsIn,
  type ModuleLoad,
} from "./support/module-loads.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/**
 * Every file a module loader could execute, and JSON (`CONTROL-1`, N-4). Each
 * is read with its own extension's grammar (`support/module-loads.ts`).
 */
function walk(directory: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (SCANNED_EXTENSIONS.some((extension) => path.endsWith(extension))) out.push(path);
  }
  return out;
}

const OWNED_TREES = [
  resolve(repoRoot, "apps/control-api/src"),
  resolve(repoRoot, "packages/observability/src/control"),
];

const FILES = OWNED_TREES.flatMap((tree) => walk(tree));
const PRODUCTION_FILES = FILES.filter((path) => !path.endsWith(".test.ts"));

/**
 * `CONTROL-1`, closing `WP-240` r1 N-4: the IMPORT scan also covers the
 * control API's own test suites and the dashboards it feeds. A signing library
 * imported by a test of a process that "never has the signing key" would load
 * one into the very worker that proves it is absent; and a dashboard tree is
 * JSON today, so the scan's job there is to keep it that way. These trees are
 * READ here, never written — `infra/grafana/**` is outside this round's grant.
 */
const IMPORT_SCAN_TREES = [
  ...OWNED_TREES,
  resolve(repoRoot, "test/integration/control-api"),
  resolve(repoRoot, "test/unit/control-api"),
  resolve(repoRoot, "infra/grafana"),
];
const IMPORT_SCAN_FILES = IMPORT_SCAN_TREES.flatMap((tree) => walk(tree));

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const FORBIDDEN_SPECIFIERS = [
  "@polymarket-bot/polymarket-secure",
  "@polymarket/client",
  "@polymarket/clob-client",
  "@polymarket/builder-signing-sdk",
  "@polymarket/builder-relayer-client",
  "ethers",
  "viem",
  "web3",
  "@ethersproject",
] as const;

/** A signing library or the secure adapter — a PREFIX match, so `viem/accounts` counts. Never excusable. */
function isForbiddenSpecifier(specifier: string): boolean {
  return FORBIDDEN_SPECIFIERS.some((forbidden) => specifier.startsWith(forbidden));
}

/**
 * A finding the scan cannot READ as a literal it can judge: a computed
 * specifier, a named loader, a loader module, or an unparseable file
 * (`support/module-loads.ts`, "What cannot be read FAILS"). Each is a
 * violation unless {@link LOAD_ALLOWLIST} covers it.
 */
function isUnreadable(load: ModuleLoad): boolean {
  return (
    load.specifier === COMPUTED ||
    load.specifier === UNPARSEABLE ||
    load.specifier.startsWith("<loader:") ||
    LOADER_MODULES.includes(load.specifier)
  );
}

/**
 * The EXPLICIT allowlist for unreadable findings (`CONTROL-1b`): one entry per
 * repository-relative file and finding, with the exact number of occurrences
 * and why each is safe. A forbidden literal is never allowlistable, and an
 * entry that no longer matches its file exactly is itself a failure, so the
 * list cannot go stale.
 *
 * EMPTY, and measured to be: nothing in the scanned trees today computes a
 * specifier, names a loader, imports a loader module or fails to parse.
 */
interface LoadAllowlistEntry {
  readonly file: string;
  readonly finding: string;
  readonly count: number;
  readonly justification: string;
}
const LOAD_ALLOWLIST: readonly LoadAllowlistEntry[] = Object.freeze([]);

/**
 * Every violation in one file: each forbidden literal, and each unreadable
 * finding the allowlist does not cover EXACTLY.
 */
function violationsIn(
  path: string,
  text: string,
  allowlist: readonly LoadAllowlistEntry[] = LOAD_ALLOWLIST,
): readonly string[] {
  const file = relative(repoRoot, path);
  const loads = moduleLoadsIn(text, path);
  const violations: string[] = [];
  const unreadable = new Map<string, number>();
  for (const load of loads) {
    if (isForbiddenSpecifier(load.specifier)) {
      violations.push(`${file}:${String(load.line)} ${load.kind} ${load.specifier}`);
    } else if (isUnreadable(load)) {
      unreadable.set(load.specifier, (unreadable.get(load.specifier) ?? 0) + 1);
    }
  }
  const entries = allowlist.filter((entry) => entry.file === file);
  for (const [finding, count] of unreadable) {
    const entry = entries.find((candidate) => candidate.finding === finding);
    if (entry === undefined) violations.push(`${file} ${finding} x${String(count)} (not allowlisted)`);
    else if (entry.count !== count) {
      violations.push(`${file} ${finding} x${String(count)} (the allowlist expects ${String(entry.count)})`);
    }
  }
  for (const entry of entries) {
    if (!unreadable.has(entry.finding)) violations.push(`${file} ${entry.finding} (a stale allowlist entry)`);
  }
  return violations;
}

/** The specifiers `text` loads, as `path`'s grammar reads them. */
function specifiersIn(text: string, path: string): readonly string[] {
  return moduleLoadsIn(text, path).map((load) => load.specifier);
}

/**
 * Every spelling of a LOAD of `specifier` the scan must read as that
 * specifier: each import, export, require and type form, with every comment
 * placement and every escape the verifiers used (`CONTROL1-J-L1`,
 * `CONTROL1-R2-J-L1`). Built at RUN time from parts, so this file names none
 * of them in a load position — and the scan reads this file too. `ts` marks a
 * spelling that only the TypeScript grammar has; in a JavaScript file it is
 * refused as unparseable, which fails the scan as well.
 */
function plantedSpellings(specifier: string): readonly { readonly text: string; readonly ts: boolean }[] {
  const out: { text: string; ts: boolean }[] = [];
  const escaped = [
    // `\x76`, `v`, `\u{76}` and a line continuation, for every letter the
    // escape replaces — the evaluated literal is the specifier itself.
    [...specifier].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    [...specifier].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
    [...specifier].map((c) => `\\u{${c.charCodeAt(0).toString(16)}}`).join(""),
    `${specifier.slice(0, 1)}\\\n${specifier.slice(1)}`,
  ];
  for (const quote of ["'", '"', "`"]) {
    const q = (text: string): string => `${quote}${text}${quote}`;
    const plain = q(specifier);
    const both = (text: string): void => {
      out.push({ text, ts: false });
    };
    const tsOnly = (text: string): void => {
      out.push({ text, ts: true });
    };
    if (quote !== "`") {
      // Static forms take a string literal only; a template is a syntax error there.
      both(`import x from ${plain};`);
      both(`import { y } from${plain};`);
      both(`import * as ns from ${plain};`);
      tsOnly(`import type { T } from ${plain};`);
      both(`import ${plain};`);
      both(`import${plain};`);
      both(`export * from ${plain};`);
      both(`export * as ns from ${plain};`);
      both(`export { y } from ${plain};`);
      tsOnly(`export type { T } from ${plain};`);
      both(`export * from // reviewer plant\n${plain};`); // astra, CONTROL1-R2-J-L1
      both(`import x from /* plant */ ${plain};`);
      both(`import x from\n// plant\n${plain};`);
      both(`import x from ${plain} with { type: "json" };`);
      tsOnly(`import z = require(${plain});`);
      tsOnly(`export import z = require(${plain});`);
      tsOnly(`type T = typeof import(${plain});`);
      tsOnly(`declare module ${plain} { export const z: number; }`);
      both(`/// <reference types=${plain} />\nexport {};`);
      both(`/// <amd-dependency path=${plain} />\nexport {};`);
      both(`/** @import { X } from ${plain} */\nexport const y = 1;`);
      for (const form of escaped) {
        both(`import ${q(form)};`); // astra's escaped bare import
        both(`export * from ${q(form)};`);
        both(`const m = await import(${q(form)});`);
        both(`const m = require(${q(form)});`);
      }
    }
    both(`const m = await import(${plain});`);
    both(`const m = await import ( ${plain} );`);
    both(`const m = await import(/* lazy */ ${plain});`);
    both(`const m = await import( // lazy\n ${plain});`); // Opus, CONTROL1-R2-J-L1
    both(`const m = await import(${plain}, { with: { type: "json" } });`);
    both(`void import(${plain}).then(() => undefined);`);
    both(`const m = require(${plain});`);
    both(`const m = require (\n  ${plain}\n);`);
    both(`const m = require( // c\n ${plain});`);
    both(`const m = require?.(${plain});`);
    both(`const m = (require)(${plain});`);
    both(`const m = \\u0072equire(${plain});`);
    both(`const m = module.require(${plain});`);
    if (quote === "`") {
      for (const form of escaped) both(`const m = await import(${q(form)});`);
    }
  }
  return out;
}

/**
 * Spellings whose specifier the scan CANNOT read, and which must therefore
 * fail it: computed specifiers, named loaders and loader modules. Built from
 * parts, as above.
 */
function unreadableSpellings(specifier: string): readonly string[] {
  const head = specifier.slice(0, 2);
  const tail = specifier.slice(2);
  return [
    `const m = await import("${head}" + "${tail}");`,
    `const m = await import(\`\${"${head}"}${tail}\`);`,
    `const name = "${specifier}"; const m = await import(name);`,
    `const m = require("${head}" + "${tail}");`,
    `const r = require; const m = r("${specifier}");`,
    `const m = module["require"]("${specifier}");`,
    `import { createRequire } from "node:module"; const m = createRequire(import.meta.url)("${specifier}");`,
    `const m = await eval("import('${specifier}')");`,
    `const m = await (0, eval)("import('${specifier}')");`,
    `const m = await globalThis["eval"]("import('${specifier}')");`,
    `const m = await new Function("return import('${specifier}')")();`,
    `const m = await Function("return import('${specifier}')")();`,
    `const m = Module._load("${specifier}");`,
    `import vm from "node:vm"; vm.runInThisContext("0");`,
  ];
}

/** Text that does not parse — an escaped keyword is a syntax error — and so fails the scan. */
function unparseableSpellings(specifier: string): readonly string[] {
  return [`\\u0069mport("${specifier}");`, `import x from "${specifier}" ((;`, `export * from;`];
}

describe("ACCEPTANCE 3: no signer is loaded", () => {
  it("scans a non-trivial number of files (the scan is not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(PRODUCTION_FILES.length).toBeGreaterThan(12);
  });

  it("N-4: the import scan reaches every tree it names (not vacuous per tree)", () => {
    for (const tree of IMPORT_SCAN_TREES) {
      expect(
        IMPORT_SCAN_FILES.filter((path) => path.startsWith(`${tree}/`)).length,
        `${tree} contributes no file to the import scan`,
      ).toBeGreaterThan(0);
    }
    // The suites include THIS file and the dashboards their JSON.
    expect(IMPORT_SCAN_FILES).toContain(resolve(repoRoot, "test/integration/control-api/acceptance-3-no-signer.test.ts"));
    expect(IMPORT_SCAN_FILES).toContain(resolve(repoRoot, "infra/grafana/control/operations-dashboard.json"));
  });

  it("imports NO secure adapter, venue client or signing library, anywhere — and reads every load it finds", () => {
    let loads = 0;
    for (const path of IMPORT_SCAN_FILES) {
      expect(violationsIn(path, read(path)), `${path} loads a forbidden or unreadable module`).toEqual([]);
      loads += moduleLoadsIn(read(path), path).length;
    }
    // Non-vacuity: the parser really did read the trees' imports.
    expect(loads).toBeGreaterThan(200);
  });

  it("CONTROL-1b: the allowlist is exact — every entry names a scanned file, a finding it really has, and why", () => {
    for (const entry of LOAD_ALLOWLIST) {
      const path = resolve(repoRoot, entry.file);
      expect(IMPORT_SCAN_FILES, entry.file).toContain(path);
      expect(entry.justification.length, entry.file).toBeGreaterThanOrEqual(40);
      expect(isForbiddenSpecifier(entry.finding), entry.finding).toBe(false);
    }
    // The mechanism, on a synthetic file: an entry excuses EXACTLY its count,
    // a wrong count or a stale entry fails, and a forbidden literal is never
    // excused, whatever the allowlist says.
    const path = resolve(repoRoot, "test/integration/control-api/synthetic.ts");
    const text = 'const a = await import(x);\nconst b = await import(y);\n';
    const entry = (count: number, finding = COMPUTED): LoadAllowlistEntry => ({
      file: "test/integration/control-api/synthetic.ts",
      finding,
      count,
      justification: "a synthetic entry exercising the allowlist mechanism itself",
    });
    expect(violationsIn(path, text, [])).toEqual(["test/integration/control-api/synthetic.ts <computed> x2 (not allowlisted)"]);
    expect(violationsIn(path, text, [entry(2)])).toEqual([]);
    expect(violationsIn(path, text, [entry(1)])).toHaveLength(1);
    expect(violationsIn(path, text, [entry(3)])).toHaveLength(1);
    expect(violationsIn(path, "export const clean = 1;\n", [entry(2)])).toEqual([
      "test/integration/control-api/synthetic.ts <computed> (a stale allowlist entry)",
    ]);
    const forbidden = `${text}import "${FORBIDDEN_SPECIFIERS[6]}";\n`;
    expect(violationsIn(path, forbidden, [entry(2), entry(1, FORBIDDEN_SPECIFIERS[6])])).toContain(
      "test/integration/control-api/synthetic.ts:3 import viem",
    );
  });

  it("CONTROL-1b (R2-J-L1): every spelling of a load is read as its EVALUATED specifier — comments and escapes included", () => {
    for (const specifier of FORBIDDEN_SPECIFIERS) {
      for (const spelling of plantedSpellings(specifier)) {
        const path = resolve(repoRoot, "test/integration/control-api/planted.ts");
        expect(specifiersIn(spelling.text, path), spelling.text).toContain(specifier);
        expect(violationsIn(path, spelling.text).length, spelling.text).toBeGreaterThan(0);
      }
    }
    // A subpath is a load of the package.
    const subpath = plantedSpellings("viem/accounts")[0]?.text ?? "";
    expect(violationsIn(resolve(repoRoot, "planted.ts"), subpath)).toEqual(["planted.ts:1 import viem/accounts"]);
    // The verifiers' three round-2 plants, exactly as reported.
    const reported = [
      ["export * from // c\n", "'viem';"].join(""),
      ["import '", "\\x76iem';"].join(""),
      ["const m = await import( // c\n ", '"ethers");'].join(""),
    ];
    for (const plant of reported) {
      expect(violationsIn(resolve(repoRoot, "planted.ts"), plant).length, plant).toBe(1);
    }
  });

  it("CONTROL-1b (R2-J-L1): a specifier the scan cannot read, a named loader, a loader module or a parse error FAILS it", () => {
    const path = resolve(repoRoot, "test/integration/control-api/planted.ts");
    for (const specifier of ["viem", "ethers", "@polymarket-bot/polymarket-secure"]) {
      for (const spelling of unreadableSpellings(specifier)) {
        const violations = violationsIn(path, spelling);
        expect(violations.length, spelling).toBeGreaterThan(0);
        // …and not by accident: nothing here names the specifier as a literal.
        expect(specifiersIn(spelling, path), spelling).not.toContain(specifier);
      }
      for (const spelling of unparseableSpellings(specifier)) {
        // Whatever the parser's recovery read, the file did not parse — fail.
        expect(violationsIn(path, spelling).length, spelling).toBeGreaterThan(0);
        expect(specifiersIn(spelling, path), spelling).toContain(UNPARSEABLE);
      }
    }
    expect(specifiersIn("const r = require;", path)).toEqual([loaderFinding("require")]);
    expect(specifiersIn("\\u0069mport('x');", path)).toContain(UNPARSEABLE);
  });

  it("CONTROL-1b: negative controls — permitted modules, and the words as data, comments or types, are not reported", () => {
    const path = resolve(repoRoot, "test/integration/control-api/planted.ts");
    for (const spelling of plantedSpellings("@polymarket-bot/observability")) {
      expect(violationsIn(path, spelling.text), spelling.text).toEqual([]);
    }
    for (const clean of [
      'const words = ["viem", "ethers"]; // import "viem" in a comment\n',
      '/* const m = require("viem"); */ export const required = true;\n',
      'const label = `import("viem")`;\nexport const t = label;\n',
      "export function call(f: Function): unknown { return f; }\n",
      'export const options = { required: ["web3"] };\n',
    ]) {
      expect(violationsIn(path, clean), clean).toEqual([]);
    }
    expect(violationsIn(resolve(repoRoot, "planted.json"), '{ "import": "viem", "from": "ethers" }')).toEqual([]);
  });

  it("CONTROL-1b: a planted load is caught in EVERY scanned tree, in a real file the walk reaches and in every extension", () => {
    const spellings = plantedSpellings("viem");
    for (const tree of IMPORT_SCAN_TREES) {
      // The tree's own first file, as the walk found it, with a load appended
      // in memory — the trees are only READ (infra/** is outside the grant).
      const reached = IMPORT_SCAN_FILES.find((path) => path.startsWith(`${tree}/`));
      expect(reached, `${tree} contributes no file`).toBeDefined();
      const path = reached ?? "";
      const source = read(path);
      expect(violationsIn(path, source), `${path} is not clean to begin with`).toEqual([]);
      for (const spelling of spellings) {
        // A triple-slash directive is one only at the TOP of a file (further
        // down it is an inert comment, to TypeScript and to the runtime), so
        // it is planted first; every other load is planted after the source.
        const planted = spelling.text.startsWith("///")
          ? `${spelling.text}\n${source}`
          : `${source}\n${spelling.text}\n`;
        expect(violationsIn(path, planted).length, `${tree}: ${spelling.text}`).toBeGreaterThan(0);
      }
      // A file of EVERY scanned extension in this tree, read with its grammar:
      // a code file names the specifier; JSON cannot hold a load at all.
      for (const extension of SCANNED_EXTENSIONS) {
        const virtual = join(tree, `planted${extension}`);
        for (const spelling of spellings) {
          const loads = specifiersIn(spelling.text, virtual);
          expect(violationsIn(virtual, spelling.text).length, `${virtual}: ${spelling.text}`).toBeGreaterThan(0);
          if (extension === ".json") expect(loads).toEqual([UNPARSEABLE]);
          else if (!spelling.ts || [".ts", ".mts", ".cts"].includes(extension)) expect(loads, spelling.text).toContain("viem");
        }
      }
    }
  });

  it("CONTROL-1b: the walk reaches a planted FILE of every scanned extension, and the scan reports each", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-1b-l1-"));
    try {
      const reported = [
        ["export * from // c\n", "'ethers';"].join(""),
        ["import '", "\\x65thers';"].join(""),
        ["const m = await import( // c\n ", '"ethers");'].join(""),
      ];
      SCANNED_EXTENSIONS.forEach((extension, index) => {
        writeFileSync(join(directory, `planted${extension}`), reported[index % reported.length] ?? "", "utf8");
      });
      const walked = walk(directory);
      expect(walked).toHaveLength(SCANNED_EXTENSIONS.length);
      for (const path of walked) {
        expect(violationsIn(path, read(path)).length, path).toBe(1);
        expect(specifiersIn(read(path), path), path).toEqual(path.endsWith(".json") ? [UNPARSEABLE] : ["ethers"]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("CONTROL-1b: the layer behind the scan — no forbidden package even RESOLVES from a scanned tree", () => {
    // Node's lookup for a bare specifier: `node_modules/<package>` in the
    // importing directory and every ancestor. A load spelled in a way no
    // static scan can read would still have nothing to load.
    const packageOf = (specifier: string): string =>
      specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier);
    const resolvable = (from: string, specifier: string): boolean => {
      for (let directory = from; ; directory = dirname(directory)) {
        if (existsSync(join(directory, "node_modules", packageOf(specifier)))) return true;
        if (dirname(directory) === directory) return false;
      }
    };
    const scopeOnly = (specifier: string): boolean => specifier.startsWith("@") && !specifier.includes("/");
    for (const tree of IMPORT_SCAN_TREES) {
      for (const specifier of FORBIDDEN_SPECIFIERS) {
        if (scopeOnly(specifier)) {
          // `@ethersproject` is a SCOPE: no package of it may be reachable.
          for (let directory = tree; ; directory = dirname(directory)) {
            expect(existsSync(join(directory, "node_modules", specifier)), `${directory}: ${specifier}`).toBe(false);
            if (dirname(directory) === directory) break;
          }
        } else {
          expect(resolvable(tree, specifier), `${tree}: ${specifier}`).toBe(false);
        }
      }
      // Positive control: the lookup does find a package that IS reachable.
      expect(resolvable(tree, "typescript"), `${tree}: typescript`).toBe(true);
    }
  });

  it("declares NO dependency on packages/polymarket-secure or a signing library", () => {
    const manifest = JSON.parse(read(resolve(repoRoot, "apps/control-api/package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared).not.toContain("@polymarket-bot/polymarket-secure");
    for (const name of declared) {
      expect(name.toLowerCase(), `${name} looks like a signing dependency`).not.toMatch(
        /ethers|viem|web3|signer|wallet/u,
      );
    }
    // The observability package declares no runtime dependency at all.
    const observability = JSON.parse(
      read(resolve(repoRoot, "packages/observability/package.json")),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(observability.dependencies ?? {})).toEqual([]);
  });

  it("CONSTRUCTS no signer: every signer-shaped declaration ASSERTS ABSENCE", () => {
    // Declarations, not mentions. A `const signer =`, a `signer:` field, a
    // `#privateKey` — anything that could HOLD signing material.
    //
    // Exactly one declaration is expected to exist, and it is the one that says
    // there is no signer: `RunStateView.signerLoaded: false`, a literal `false`
    // on the wire. So rather than "the word never appears in a declaration",
    // the assertion is the stronger and truer "every declaration that mentions
    // a signer states its ABSENCE", checked against the declaration's own line.
    const declaration =
      /^.*(?:const|let|var|readonly|private|#)\s*[A-Za-z_$]*(?:signer|privateKey|walletKey|mnemonic|keystore)[A-Za-z_$]*\s*[:=].*$/gimu;
    const found: string[] = [];
    for (const path of PRODUCTION_FILES) {
      if (!path.endsWith(".ts")) continue;
      for (const line of read(path).match(declaration) ?? []) {
        found.push(`${path}: ${line.trim()}`);
        expect(line, `${path} declares ${line.trim()}`).toMatch(/\bfalse\b/u);
      }
    }
    // Non-vacuity: the scan really does reach the one declaration that exists.
    expect(found.filter((entry) => entry.includes("signerLoaded")).length).toBeGreaterThan(0);
  });

  it("mentions signer words ONLY where the code refuses them", () => {
    // The words DO appear — in `vocabulary.ts`'s forbidden-key list, in
    // `safety.ts`'s refusal text, and in comments explaining why there is no
    // signer. Enumerating the files that may contain them turns "the word is
    // absent" into the stronger and truer "the word appears only in refusals".
    const permitted = new Set(
      [
        "apps/control-api/src/vocabulary.ts",
        "apps/control-api/src/safety.ts",
        "apps/control-api/src/auth.ts",
        "apps/control-api/src/api.ts",
        "apps/control-api/src/control-plane.ts",
        "apps/control-api/src/main.ts",
        "apps/control-api/src/index.ts",
        "packages/observability/src/control/paper-safety.ts",
        "packages/observability/src/control/index.ts",
        // Its `MODE_RAISE_ATTEMPT` doc comment describes what the action
        // records: a request that tried to "reference a signer, and was refused
        // by name". The word is in the refusal's own definition.
        "packages/observability/src/control/audit.ts",
        // `control_allow_real_orders`'s and `control_mode_raise_attempts_
        // refused_total`'s HELP text — the metric documentation that says this
        // process has no signer, and the counter of requests that named one.
        "packages/observability/src/control/metric-families.ts",
      ].map((relative) => resolve(repoRoot, relative)),
    );
    for (const path of PRODUCTION_FILES) {
      if (!path.endsWith(".ts")) continue;
      if (permitted.has(path)) continue;
      const source = read(path).toLowerCase();
      for (const word of ["signer", "private key", "privatekey", "mnemonic", "keystore"]) {
        expect(source, `${path} mentions "${word}"`).not.toContain(word);
      }
    }
  });

  it("the shipped example configuration carries no production secret name", () => {
    const example = read(resolve(repoRoot, "apps/control-api/control-api.config.example.json"));
    const upper = example.toUpperCase();
    for (const name of ALL_PRODUCTION_NAMES) {
      expect(upper, `the example references ${name}`).not.toContain(name);
    }
    for (const pattern of CREDENTIAL_NAME_PATTERNS) {
      expect(upper, `the example references ${pattern}`).not.toContain(pattern);
    }
  });

  it("the example's token says, in its own text, that it is not a credential", () => {
    const example = JSON.parse(
      read(resolve(repoRoot, "apps/control-api/control-api.config.example.json")),
    ) as { operators: readonly { token: string }[] };
    for (const operator of example.operators) {
      expect(operator.token.toUpperCase()).toContain("NOT-A-CREDENTIAL");
    }
  });

  it("the run-state surface states signerLoaded: false on the wire", async () => {
    const { serveControlApi } = await import("./support/client.js");
    const { FAKE_OPERATOR_TOKEN } = await import("@polymarket-bot/control-api/testing");
    const api = await serveControlApi({
      operators: [
        { operatorId: "operator-a", token: FAKE_OPERATOR_TOKEN, grants: ["READ"] },
      ],
    });
    try {
      const response = await api.call("GET", "/v1/run-state", { token: FAKE_OPERATOR_TOKEN });
      expect((response.json() as Record<string, unknown>)["signerLoaded"]).toBe(false);
    } finally {
      await api.server.close();
    }
  });
});
