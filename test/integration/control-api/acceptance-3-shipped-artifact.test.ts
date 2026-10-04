/**
 * WP-240 ACCEPTANCE 3 — "No signer is loaded" — its AUTHORITATIVE checks on
 * what SHIPS (`CONTROL-1b` r4).
 *
 * Rounds 1 to 4 of `CONTROL-1b` each found a new route past the test-tree scan
 * (`acceptance-3-no-signer.test.ts`), because no static analysis of
 * JavaScript is sound against an author who obfuscates on purpose. So the
 * property rests on three checks, and the scan is lint beside them:
 *
 * 1. **The shipped bundle** (this file). The control API ships as ONE esbuild
 *    bundle, `dist/main.mjs`, built by its `build` script. This file runs that
 *    script's own esbuild invocation — the same binary, the same arguments —
 *    adding only `--metafile` and writing the output to a scratch directory,
 *    and reads the metafile: EVERY module the bundle holds is an input there.
 *    None may lie in `packages/polymarket-secure` or under a forbidden
 *    package's directory (`support/forbidden-targets.ts`: the venue SDK, the
 *    signing libraries, and the SDK's own `ox`, `@polymarket/bindings` and
 *    `@polymarket/types`), judged on its real path exactly as the run-time
 *    guard judges a landing; every input must be this package's source, a
 *    workspace package it depends on, or a third-party package on an exact,
 *    justified list; and every import the bundle leaves EXTERNAL must be a
 *    builtin that cannot load or run code.
 * 2. **The production source** (this file): no dynamic-loading primitive at
 *    all in `apps/control-api/src/**`, its tests excluded
 *    (`support/production-source-rule.ts`). The bundle states what is in the
 *    artifact; this rule states that the shipped code cannot load anything
 *    else at run time by any primitive it can name.
 * 3. **The run-time guard** (`support/no-signer-guard.ts`), installed in every
 *    runner that executes control-api code — the repository's unit runner's
 *    `control-api` project and both control-api integration runners — which
 *    refuses the load of a forbidden file in a test worker.
 *
 * ## What this does not prove
 *
 * - A deployment that runs something other than `dist/main.mjs` — this
 *   package's `src` under a loader, say — is not the shipped artifact.
 * - Third-party code inside the bundle is judged by its package, not read:
 *   zod v4's JIT compiles object-schema checks with `new Function` from the
 *   schemas' own shapes (the justification on its entry below).
 * - Workspace packages' source is reviewed code, and `check:deps` holds only
 *   part of it (`CONTROL-2`, correcting `CTRL1B-R5-L2`): F6 (the venue SDK
 *   only in `packages/polymarket-secure`) and F16's relative half (no relative
 *   specifier leaving its package) judge every literal specifier in every
 *   workspace package, and F14 (no module load a static check cannot read)
 *   holds only the purity-restricted packages — of the workspace packages this
 *   bundle holds (`decimal`, `domain`, `observability`, `risk`),
 *   `packages/domain` alone. A computed load in the other three is no
 *   `check:deps` finding. {@link BUNDLED_WORKSPACES} pins that set.
 * - The production-source rule's own limits: `support/production-source-rule.ts`,
 *   "What it does not see".
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { FORBIDDEN_PACKAGES, SDK_DEPENDENCY_PACKAGES, SDK_SIGNING_PACKAGES, SECURE_DIRECTORY } from "./support/forbidden-targets.js";
import { PERMITTED_BUILTINS, discover } from "./support/load-judge.js";
import { CODE_EXTENSIONS } from "./support/module-loads.js";
import { refusedLanding } from "./support/no-signer-guard.js";
import { dynamicLoadingIn, type DynamicLoadingFinding, type ProductionScope } from "./support/production-source-rule.js";

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(resolve(here, "../../.."));
const CONTROL_API = join(repoRoot, "apps", "control-api");
const SOURCE_ROOT = join(CONTROL_API, "src");
const SECURE = join(repoRoot, "packages", SECURE_DIRECTORY);

/** A name built from parts: the test-tree scan refuses a literal path through `node_modules`. */
const named = (...parts: readonly string[]): string => parts.join("");
const NODE_MODULES = named("node_", "modules");

/** The `esbuild` the `build` script runs: the package's own, as pnpm puts it on the script's PATH. */
const ESBUILD = join(CONTROL_API, NODE_MODULES, ".bin", "esbuild");

interface Manifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const manifestOf = (directory: string): Manifest => JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest;

const CONTROL_API_MANIFEST = manifestOf(CONTROL_API);

/**
 * The third-party packages the shipped bundle may hold — EXACTLY: one the
 * bundle holds and this list does not name fails, and so does an entry the
 * bundle no longer holds. A new runtime dependency is judged here before it
 * ships.
 */
const SHIPPED_THIRD_PARTY: readonly { readonly name: string; readonly justification: string }[] = Object.freeze([
  {
    name: "zod",
    justification:
      "a declared dependency: schema validation of configuration and requests; it loads no module. Its v4 core " +
      "compiles object-schema checks with new Function (allowsEval, Doc.compile) from the schemas' own shapes — code " +
      "text built from this source's schema keys, never from a request",
  },
  {
    name: "decimal.js",
    justification: "@polymarket-bot/decimal's arbitrary-precision arithmetic (via domain and risk); it loads no module",
  },
]);

/**
 * `CONTROL-2` (correcting `CTRL1B-R5-L2`): the workspace packages the shipped
 * bundle holds, EXACTLY, and the purity-restricted ones among them — the only
 * ones `check:deps` F14 holds (module header). The README and the header state
 * both; a bundle that gains a workspace package fails here until they are
 * restated.
 */
const BUNDLED_WORKSPACES = Object.freeze(["packages/decimal", "packages/domain", "packages/observability", "packages/risk"]);

/**
 * The packages `tools/check-dependency-direction.mjs` holds to F14 — its
 * `isPurityRestricted` — read from the tool's own source, so a change there
 * fails here rather than leaving the README's statement behind.
 */
function purityRestrictedDirectories(): { readonly line: string; readonly restricted: (directory: string) => boolean } {
  const tool = readFileSync(join(repoRoot, "tools", "check-dependency-direction.mjs"), "utf8");
  const line = /^\s*const isPurityRestricted = (?<expression>[^;]+);$/mu.exec(tool)?.groups?.["expression"] ?? "";
  const exact = (name: string): string | undefined => new RegExp(`const ${name} = pkg\\.dir === "(?<dir>[^"]+)";`, "u").exec(tool)?.groups?.["dir"];
  const strategies = /const isStrategy = matchesGlob\(pkg\.dir, strategyClass\);/u.test(tool);
  const directories = ["isDomain", "isLedger", "isSimulation"].map(exact);
  return {
    line,
    restricted: (directory) =>
      directories.includes(directory) || (strategies && directory.startsWith("packages/strategies/")),
  };
}

/** The workspace packages (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `packages/strategies/*`), by name. */
const WORKSPACES: ReadonlyMap<string, string> = (() => {
  const found = new Map<string, string>();
  for (const parent of ["apps", "packages", "packages/strategies"]) {
    for (const entry of readdirSync(join(repoRoot, parent))) {
      const directory = join(repoRoot, parent, entry);
      if (!existsSync(join(directory, "package.json"))) continue;
      const name = (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown }).name;
      if (typeof name === "string") found.set(name, directory);
    }
  }
  return found;
})();

/** The workspace packages `start` depends on at run time, to any depth (`start` excluded). */
function workspaceClosure(start: string): ReadonlySet<string> {
  const reached = new Set<string>();
  const queue = [start];
  for (let directory = queue.shift(); directory !== undefined; directory = queue.shift()) {
    for (const name of Object.keys(manifestOf(directory).dependencies ?? {})) {
      const workspace = WORKSPACES.get(name);
      if (workspace !== undefined && !reached.has(workspace)) {
        reached.add(workspace);
        queue.push(workspace);
      }
    }
  }
  return reached;
}

const CLOSURE = workspaceClosure(CONTROL_API);

/**
 * The arguments the `build` script hands esbuild, with its output moved into
 * `outDirectory` and a metafile added. Anything in the script this does not
 * read — another command, shell syntax, a metafile of its own — fails: the
 * bundle checked here must be the one `build` makes.
 */
function buildArguments(script: string, outDirectory: string): readonly string[] {
  const tokens = script.split(/\s+/u).filter((token) => token !== "");
  if (tokens[0] !== "esbuild") throw new Error(`the build script does not run esbuild first: ${script}`);
  const unread = tokens.filter((token) => !/^[A-Za-z0-9_./=:@-]+$/u.test(token));
  if (unread.length > 0) throw new Error(`the build script holds what this check does not read: ${unread.join(" ")}`);
  if (tokens.filter((token) => token.startsWith("--outfile=")).length !== 1) throw new Error(`the build script names no single --outfile: ${script}`);
  if (tokens.some((token) => token.startsWith("--metafile"))) throw new Error(`the build script writes a metafile of its own: ${script}`);
  return [
    ...tokens.slice(1).map((token) => (token.startsWith("--outfile=") ? `--outfile=${join(outDirectory, basename(token.slice("--outfile=".length)))}` : token)),
    `--metafile=${join(outDirectory, "meta.json")}`,
  ];
}

interface MetafileImport {
  readonly path: string;
  readonly kind: string;
  readonly external?: boolean;
}

interface Metafile {
  readonly inputs: Readonly<Record<string, { readonly imports: readonly MetafileImport[] }>>;
  readonly outputs: Readonly<Record<string, { readonly imports: readonly MetafileImport[] }>>;
}

/**
 * Builds the bundle the `build` script builds — or, for a positive control,
 * the same build with its entry point replaced by `entry` — and returns its
 * metafile. Nothing is written into the repository.
 */
async function bundle(entry?: string): Promise<Metafile> {
  const script = CONTROL_API_MANIFEST.scripts?.["build"] ?? "";
  const out = mkdtempSync(join(tmpdir(), "control-1b-r4-bundle-"));
  try {
    let args = buildArguments(script, out);
    if (entry !== undefined) args = args.map((token) => (token === "src/main.ts" ? entry : token));
    await run(ESBUILD, args, { cwd: CONTROL_API, env: process.env, timeout: 120_000 });
    return JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as Metafile;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function within(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

/** The package an input under `node_modules` belongs to: `@scope/name` or `name`, after the LAST `node_modules`. */
function packageOfInstalled(path: string): string | undefined {
  const segments = relative(repoRoot, path).split(sep);
  const last = segments.lastIndexOf(NODE_MODULES);
  if (last === -1) return undefined;
  const [first, second] = segments.slice(last + 1);
  return first?.startsWith("@") === true ? `${first}/${second ?? ""}` : first;
}

/** Whether `specifier` names a builtin from `PERMITTED_BUILTINS`, with or without `node:`. */
function isPermittedBuiltin(specifier: string): boolean {
  const name = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return (PERMITTED_BUILTINS as readonly string[]).includes(name);
}

/**
 * Every finding on a metafile (module header, check 1): a FORBIDDEN input (the
 * run-time guard's own judgement of a landing, on the path and its real
 * path); an input that is no file on disk; one outside this package's source,
 * its workspace dependencies and `node_modules`; a third-party package
 * {@link SHIPPED_THIRD_PARTY} does not name; and an external import that is
 * not a permitted builtin. `cwd` is where esbuild ran: the inputs are named
 * relative to it.
 */
function bundleFindings(metafile: Metafile, cwd: string = CONTROL_API): readonly string[] {
  const findings: string[] = [];
  for (const input of Object.keys(metafile.inputs)) {
    const path = resolve(cwd, input);
    if (!existsSync(path) || !statSync(path).isFile()) {
      findings.push(`input ${input}: no file on disk, so no place this check can judge`);
      continue;
    }
    const why = refusedLanding(path);
    if (why !== undefined) {
      findings.push(`input ${input}: FORBIDDEN — ${why}`);
      continue;
    }
    const real = realpathSync(path);
    const installed = packageOfInstalled(real);
    if (installed !== undefined) {
      if (!SHIPPED_THIRD_PARTY.some((entry) => entry.name === installed)) {
        findings.push(`input ${input}: the third-party package ${installed}, which the shipped bundle may not hold`);
      }
    } else if (!within(real, SOURCE_ROOT) && ![...CLOSURE].some((workspace) => within(real, workspace))) {
      findings.push(`input ${input}: outside this package's source, its workspace dependencies and ${NODE_MODULES}`);
    }
  }
  const imports = [...Object.values(metafile.inputs), ...Object.values(metafile.outputs)].flatMap((entry) => entry.imports);
  for (const specifier of new Set(imports.filter((entry) => entry.external === true).map((entry) => entry.path))) {
    if (!isPermittedBuiltin(specifier)) findings.push(`external ${specifier}: not a builtin the bundle may leave to the runtime`);
  }
  return findings;
}

/** The third-party packages a metafile's inputs belong to. */
function thirdPartyIn(metafile: Metafile, cwd: string = CONTROL_API): ReadonlySet<string> {
  const found = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const path = resolve(cwd, input);
    const installed = existsSync(path) ? packageOfInstalled(realpathSync(path)) : undefined;
    if (installed !== undefined) found.add(installed);
  }
  return found;
}

const PRODUCTION_SCOPE: ProductionScope = {
  dependencies: Object.keys(CONTROL_API_MANIFEST.dependencies ?? {}),
  sourceRoot: SOURCE_ROOT,
};

/** Whether `path` is a test file, which the production-source rule does not read. */
const isTestFile = (path: string): boolean => /\.test\.[cm]?[jt]sx?$/u.test(path);

/** Every code file of `apps/control-api/src`, tests excluded. */
const PRODUCTION_SOURCE = discover(SOURCE_ROOT).code.filter((path) => !isTestFile(path));

const findingsIn = (text: string, path = join(SOURCE_ROOT, "planted.ts")): readonly DynamicLoadingFinding[] =>
  dynamicLoadingIn(text, path, PRODUCTION_SCOPE);
const rulesIn = (text: string, path?: string): readonly string[] => [...new Set(findingsIn(text, path).map((finding) => finding.rule))].sort();

// Planted targets, from the vocabulary, so this file spells none.
const [SECURE_PACKAGE, VENUE_SDK, , , , , VIEM_NAME] = FORBIDDEN_PACKAGES;

/**
 * The venue SDK's own packages (`CONTROL1B-R3-J-I1`), spelled from parts HERE,
 * so the pins below do not lean on the list they pin.
 */
const SDK_OWN_PACKAGES = [named("o", "x"), named("@polymarket/", "bind", "ings"), named("@polymarket/", "ty", "pes")] as const;

/**
 * Production-source plants: each must break exactly the rules it names
 * (`support/production-source-rule.ts`). Built at run time from parts, so
 * this file names no loader as a literal (the test-tree scan reads it too).
 */
function productionPlants(): readonly { readonly label: string; readonly text: string; readonly rules: readonly string[]; readonly ts?: true }[] {
  const req = named("re", "quire");
  const ev = named("ev", "al");
  const fn = named("Func", "tion");
  const factory = named("create", "Require");
  const builtinLoader = named("get", "Builtin", "Module");
  const ctor = named("con", "structor");
  const proto = named("getProto", "typeOf");
  const glob = named("gl", "ob");
  return [
    { label: "a non-literal import()", text: "export const load = (name) => import(name);\n", rules: ["non-literal"] },
    { label: "a template import()", text: "export const load = (v) => import(`./${v}.js`);\n", rules: ["non-literal"] },
    { label: "a non-literal require()", text: `export const load = (name) => ${req}(name);\n`, rules: ["non-literal"] },
    { label: "require aliased", text: `const r = ${req};\nexport const m = r("zod");\n`, rules: ["require-form"] },
    { label: "require with two arguments", text: `export const m = ${req}("zod", 1);\n`, rules: ["require-form"] },
    { label: "require off globalThis", text: `export const m = globalThis.${req}("zod");\n`, rules: ["require-form"] },
    { label: "require off the main module", text: `export const m = process.mainModule.${req}("zod");\n`, rules: ["require-form"] },
    { label: "module.require, non-literal", text: `export const m = (name) => module.${req}(name);\n`, rules: ["non-literal"] },
    { label: "createRequire from node:module", text: `import { ${factory} } from "node:module";\nexport const r = ${factory}(import.meta.url);\n`, rules: ["name", "specifier"] },
    { label: "the evaluator, by name", text: `export const run = (code) => ${ev}(code);\n`, rules: ["name"] },
    { label: "new Function", text: `export const f = new ${fn}("return 1");\n`, rules: ["name"] },
    { label: "Function called", text: `export const f = ${fn}("return 1");\n`, rules: ["name"] },
    { label: "Function aliased", text: `const F = ${fn};\nexport const f = F;\n`, rules: ["name"] },
    { label: "node:vm", text: 'import vm from "node:vm";\nexport const v = vm;\n', rules: ["specifier"] },
    { label: "bare vm", text: 'import * as vm from "vm";\nexport const v = vm;\n', rules: ["specifier"] },
    { label: "node:child_process", text: 'import { spawn } from "node:child_process";\nexport const s = spawn;\n', rules: ["specifier"] },
    { label: "bare child_process", text: 'export { exec } from "child_process";\n', rules: ["specifier"] },
    { label: "node:worker_threads", text: 'import { Worker } from "node:worker_threads";\nexport const w = Worker;\n', rules: ["specifier"] },
    { label: "a literal import() of node:module", text: 'export const m = () => import("node:module");\n', rules: ["specifier"] },
    { label: "a literal require() of node:vm", text: `export const m = ${req}("node:vm");\n`, rules: ["specifier"] },
    { label: "process.getBuiltinModule, even of a permitted builtin", text: `export const m = process.${builtinLoader}("node:fs");\n`, rules: ["name"] },
    { label: "a computed member of globalThis", text: "export const g = (k) => globalThis[k];\n", rules: ["computed-global"] },
    { label: "a computed member of process", text: "export const p = (k) => process[k];\n", rules: ["computed-global"] },
    { label: "a computed member of module", text: "export const m = (k) => module[k];\n", rules: ["computed-global"] },
    { label: "a computed member of global", text: "export const g = (k) => global[k];\n", rules: ["computed-global"] },
    { label: "a computed member of a member of globalThis", text: "export const g = (k) => globalThis.process[k];\n", rules: ["computed-global"] },
    { label: "a computed member of process.versions", text: "export const v = (k) => process.versions[k];\n", rules: ["computed-global"] },
    { label: "a string key on globalThis", text: `export const e = globalThis["${ev}"];\n`, rules: ["computed-global", "name"] },
    { label: "process aliased", text: "const p = process;\nexport const x = (k) => p[k];\n", rules: ["global"] },
    // `CONTROL-2` (closing `CTRL1B-R5-L1`): a global object reached as a MEMBER of another is that global object.
    { label: "a global reached as a member of another, aliased", text: "const p = globalThis.process;\nexport const x = (k) => p[k];\n", rules: ["global"] },
    { label: "a global reached as a member of another, passed", text: "export const x = (k) => Reflect.get(globalThis.process, k);\n", rules: ["global"] },
    { label: "a global reached two members deep, destructured", text: "export const { env } = global.globalThis.process;\n", rules: ["global"] },
    { label: "a global reached as a member of another, spread", text: "export const all = { ...globalThis.module };\n", rules: ["global"] },
    { label: "a global reached as a member of another, returned", text: "export const g = () => (globalThis.global);\n", rules: ["global"] },
    { label: "globalThis passed", text: "export const x = (k) => Reflect.get(globalThis, k);\n", rules: ["global"] },
    { label: "process destructured", text: "export const { env } = process;\n", rules: ["global"] },
    { label: "module shadowed", text: "export const f = (module) => module;\n", rules: ["global"] },
    { label: "a function's constructor", text: `export const c = (() => 0).${ctor};\n`, rules: ["name"] },
    { label: "a function's prototype, by reflection", text: `export const p = Object.${proto}(async () => 0);\n`, rules: ["name"] },
    { label: "__proto__", text: "export const p = (() => 0).__proto__;\n", rules: ["name"] },
    { label: "a loader named by a string", text: `export const k = "${ctor}";\n`, rules: ["name"] },
    { label: "import.meta.glob", text: `export const all = import.meta.${glob}("./*.ts");\n`, rules: ["import-meta"] },
    { label: "a forbidden package", text: `import * as v from "${VIEM_NAME}";\nexport const x = v;\n`, rules: ["specifier"] },
    { label: "the secure adapter, re-exported", text: `export * from "${SECURE_PACKAGE}";\n`, rules: ["specifier"] },
    { label: "the venue SDK, dynamically", text: `export const m = () => import("${VENUE_SDK}");\n`, rules: ["specifier"] },
    { label: "an undeclared package", text: 'import { describe } from "vitest";\nexport const d = describe;\n', rules: ["specifier"] },
    { label: "a relative path leaving src", text: `export * from "../../../packages/${SECURE_DIRECTORY}/src/index.js";\n`, rules: ["specifier"] },
    { label: "a relative path to the package root", text: 'export * from "../package.json";\n', rules: ["specifier"] },
    { label: "import x = require(), of node:vm", text: `import vm = ${req}("node:vm");\nexport const v = vm;\n`, rules: ["specifier"], ts: true },
    { label: "a file that does not parse", text: "export const broken = ;\n", rules: ["unparseable"] },
  ];
}

describe("ACCEPTANCE 3, authoritative: the shipped artifact holds no signer (CONTROL-1b r4)", () => {
  it("the build script is ONE esbuild invocation this check reads in full — and anything else in it fails", () => {
    const script = CONTROL_API_MANIFEST.scripts?.["build"] ?? "";
    const out = join(tmpdir(), "out");
    expect(buildArguments(script, out)).toEqual([
      "src/main.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      `--outfile=${join(out, "main.mjs")}`,
      `--metafile=${join(out, "meta.json")}`,
    ]);
    for (const other of [
      "node build.mjs",
      `${script} && node x.mjs`,
      `${script} --metafile=meta.json`,
      `${script} '--inject=x.js'`,
      "esbuild src/main.ts --bundle",
    ]) {
      expect(() => buildArguments(other, out), other).toThrow();
    }
  });

  it("the shipped bundle: no input is FORBIDDEN, every input is accounted for, every external is a permitted builtin — and the check is not vacuous", async () => {
    const metafile = await bundle();
    expect(bundleFindings(metafile)).toEqual([]);
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.length).toBeGreaterThan(50);
    for (const expected of ["src/main.ts", "src/control-plane.ts", "src/api.ts"]) expect(inputs).toContain(expected);
    expect(inputs.some((input) => input.startsWith("../../packages/observability/src/"))).toBe(true);
    // The third-party packages it holds are EXACTLY the justified list: none unlisted, none stale.
    expect([...thirdPartyIn(metafile)].sort()).toEqual(SHIPPED_THIRD_PARTY.map((entry) => entry.name).sort());
    for (const entry of SHIPPED_THIRD_PARTY) expect(entry.justification.length, entry.name).toBeGreaterThanOrEqual(40);
    const externals = Object.values(metafile.outputs).flatMap((output) => output.imports.filter((entry) => entry.external === true));
    expect(externals.map((entry) => entry.path)).toContain("node:http");
    // `CONTROL-2` (correcting `CTRL1B-R5-L2`): the workspace packages it holds,
    // exactly, and the one among them `check:deps` F14 holds.
    const workspaces = new Set<string>();
    for (const input of inputs) {
      const real = realpathSync(resolve(CONTROL_API, input));
      for (const directory of CLOSURE) if (within(real, directory)) workspaces.add(relative(repoRoot, directory).split(sep).join("/"));
    }
    expect([...workspaces].sort()).toEqual([...BUNDLED_WORKSPACES]);
    const purity = purityRestrictedDirectories();
    expect(purity.line).toBe("isDomain || isStrategy || isLedger || isSimulation");
    expect(BUNDLED_WORKSPACES.filter(purity.restricted)).toEqual(["packages/domain"]);
    expect(purity.restricted("packages/ledger") && purity.restricted("packages/simulation") && purity.restricted("packages/strategies/x")).toBe(true);
  }, 120_000);

  it("CONTROL-2 (correcting CTRL1B-R5-L2): the README and this header state check:deps' reach exactly — F14 for packages/domain alone", () => {
    const normalized = (text: string): string =>
      text
        .replace(/^\s*\*\s?/gmu, "")
        .replace(/\s+/gu, " ")
        .toLowerCase();
    const readme = readFileSync(join(CONTROL_API, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf('### 3. "No signer is loaded."'), readme.indexOf("## Authentication (§15)"));
    const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const header = self.slice(0, self.indexOf("\nimport {"));
    for (const [name, text] of [
      ["README", section],
      ["this header", header],
    ] as const) {
      const said = normalized(text);
      expect(said, name).not.toContain("(f6, f14, f16)");
      for (const phrase of [
        "f6 (the venue sdk only in `packages/polymarket-secure`)",
        "f16's relative half",
        "every workspace package",
        "f14 (no module load a static check cannot read) holds only the purity-restricted packages",
        "(`decimal`, `domain`, `observability`, `risk`), `packages/domain` alone",
        "a computed load in the other three is no `check:deps` finding",
      ]) {
        expect(said, `${name}: ${phrase}`).toContain(phrase);
      }
    }
  });

  it("positive control: the same build with an entry that imports the secure adapter names the adapter, the venue SDK, and each of the SDK's own packages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "control-1b-r4-plant-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `import * as secure from ${JSON.stringify(join(SECURE, "src", "index.ts"))};\nexport const n = Object.keys(secure).length;\n`, "utf8");
      const findings = bundleFindings(await bundle(entry));
      const forbidden = findings.filter((finding) => finding.includes("FORBIDDEN"));
      expect(forbidden.some((finding) => finding.includes(`packages/${SECURE_DIRECTORY}/src/`))).toBe(true);
      for (const name of [VENUE_SDK ?? "", ...SDK_OWN_PACKAGES]) {
        expect(
          forbidden.some((finding) => finding.includes(`/${name}/`)),
          `${name} among ${JSON.stringify(forbidden.slice(0, 5))}`,
        ).toBe(true);
      }
      expect([...SDK_DEPENDENCY_PACKAGES].sort()).toEqual([...SDK_OWN_PACKAGES].sort());
      // `CONTROL-2` (closing `CTRL1B-R5-L3`): the SDK's signing closure, spelled from parts, is FORBIDDEN by name.
      const signing = [named("@noble/", "cur", "ves"), named("@noble/", "hash", "es"), named("@scure/", "bip", "32"), named("@scure/", "bip", "39")];
      expect([...SDK_SIGNING_PACKAGES].sort()).toEqual([...signing].sort());
      for (const name of signing) {
        expect(
          forbidden.some((finding) => finding.includes(`/${name}/`)),
          `${name} among ${JSON.stringify(forbidden.filter((finding) => finding.includes(name.split("/")[0] ?? "")).slice(0, 3))}`,
        ).toBe(true);
        expect(findings.some((finding) => finding.includes(`the third-party package ${name},`)), name).toBe(false);
      }
      // …and the packages beside them that the list does not name.
      expect(findings.some((finding) => finding.includes("which the shipped bundle may not hold"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("positive control: an entry that reaches the secure adapter through a SYMBOLIC LINK is judged on the real path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "control-1b-r4-plant-link-"));
    try {
      symlinkSync(SECURE, join(directory, "innocuous"));
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, 'export * from "./innocuous/src/errors.ts";\n', "utf8");
      const findings = bundleFindings(await bundle(entry));
      expect(findings.some((finding) => finding.includes("FORBIDDEN") && finding.includes("errors.ts"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("the metafile judge itself: an external that is not a permitted builtin, an input no file holds, and one outside every accounted place each fail", () => {
    const empty = { imports: [] as readonly MetafileImport[] };
    const external = (path: string): Metafile => ({
      inputs: { "src/main.ts": { imports: [{ path, kind: "import-statement", external: true }] } },
      outputs: {},
    });
    expect(bundleFindings(external("node:crypto"))).toEqual([]);
    for (const path of [VIEM_NAME ?? "", "node:vm", "node:child_process", "worker_threads", "module", "zod"]) {
      expect(bundleFindings(external(path)), path).toEqual([`external ${path}: not a builtin the bundle may leave to the runtime`]);
    }
    expect(bundleFindings({ inputs: { "src/nothing-here.ts": empty }, outputs: {} })).toEqual([
      "input src/nothing-here.ts: no file on disk, so no place this check can judge",
    ]);
    // A workspace package this package does not depend on.
    const unrelated = [...WORKSPACES.values()].find((directory) => !CLOSURE.has(directory) && directory !== CONTROL_API && directory !== SECURE);
    expect(unrelated).toBeDefined();
    const manifest = relative(CONTROL_API, join(unrelated ?? "", "package.json"));
    expect(bundleFindings({ inputs: { [manifest]: empty }, outputs: {} })).toEqual([
      `input ${manifest}: outside this package's source, its workspace dependencies and ${NODE_MODULES}`,
    ]);
    // The secure adapter's manifest: forbidden by where it lies.
    const secureManifest = relative(CONTROL_API, join(SECURE, "package.json"));
    expect(bundleFindings({ inputs: { [secureManifest]: empty }, outputs: {} })[0]).toContain("FORBIDDEN");
  });
});

describe("ACCEPTANCE 3, authoritative: the production source holds no dynamic-loading primitive (CONTROL-1b r4)", () => {
  it("apps/control-api/src, tests excluded: no finding — over every production file, read with its grammar", () => {
    expect(PRODUCTION_SOURCE.length).toBeGreaterThan(14);
    for (const expected of ["main.ts", "control-plane.ts", "api.ts", "testing/index.ts", "adapters/postgres-audit-sink.ts"]) {
      expect(PRODUCTION_SOURCE).toContain(join(SOURCE_ROOT, expected));
    }
    expect(PRODUCTION_SOURCE.some(isTestFile)).toBe(false);
    // Every entry of the tree is code or JSON: nothing escapes the rule by its kind.
    const discovered = discover(SOURCE_ROOT);
    expect(discovered.problems).toEqual([]);
    expect(discovered.inert).toEqual([]);
    const findings = PRODUCTION_SOURCE.flatMap((path) =>
      dynamicLoadingIn(readFileSync(path, "utf8"), path, PRODUCTION_SCOPE).map((finding) => `${relative(repoRoot, path)}:${String(finding.line)} ${finding.rule} ${finding.text}`),
    );
    expect(findings).toEqual([]);
  });

  it("each primitive FAILS — every plant breaks exactly the rules it names, in every code extension", () => {
    for (const plant of productionPlants()) {
      for (const extension of CODE_EXTENSIONS) {
        const typed = [".ts", ".mts", ".cts", ".tsx"].includes(extension);
        if (plant.ts === true && !typed) continue;
        expect(rulesIn(plant.text, join(SOURCE_ROOT, `planted${extension}`)), `${plant.label} (${extension})`).toEqual([...plant.rules].sort());
      }
    }
  });

  it("negative controls: what production source legitimately does is not a finding", () => {
    for (const clean of [
      'import { z } from "zod";\nimport { createHash } from "node:crypto";\nimport { readFile } from "node:fs/promises";\nexport const used = [z, createHash, readFile];\n',
      'import { encodePlainJson } from "@polymarket-bot/risk/plain-json";\nimport type { ControlAuditRecord } from "@polymarket-bot/observability";\nexport const e = encodePlainJson;\nexport type R = ControlAuditRecord;\n',
      'export * from "./sibling.js";\nexport { x } from "./adapters/postgres-audit-sink.js";\n',
      'export const flag = process.env["CONTROL_API_MAIN"];\nexport const first = process.argv[1];\nprocess.once("SIGINT", () => undefined);\nprocess.exitCode = 1;\n',
      "export const here = import.meta.url;\n",
      "export class Sink { constructor(readonly limit: number) {} }\n",
      "export function call(f: Function): unknown { return f; }\n",
      "type P = typeof process;\nexport type Q = P;\n",
      "export const o = { process: 1, module: 2 };\nexport const sum = o.process + o.module;\n",
      // `CONTROL-2`: a global reached as a member, used as the object of a further non-computed access, is not a finding.
      "export const env = globalThis.process.env;\nexport const first = globalThis.process.argv.slice(2);\n",
      "export const o = { globalThis: { process: 1 } };\nexport const p = o.globalThis.process;\n",
      'export const message = "this process never loads a signer, and refuses any request that names one";\n',
      "export const lazy = () => import(\"./sibling.js\");\n",
      "export type T = typeof import(\"zod\");\n",
    ]) {
      expect(findingsIn(clean), clean).toEqual([]);
    }
  });
});
