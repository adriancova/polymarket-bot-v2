/**
 * LINT-1 (`CI1-L2`) — the typed ESLint block and its lint-only TypeScript
 * program stay in step, and every file ESLint lints gets the typed block.
 *
 * WHY. `eslint.config.mjs` has ONE type-aware block. It runs
 * `@typescript-eslint/no-floating-promises` with type information from the one
 * program in the root `tsconfig.lint.json`. Before it, nothing caught a planted,
 * un-awaited `runCheckerJson(...).then((r) => expect(...))`: it passed eslint,
 * tsc and the test itself (`CI-1` review, L2). This file pins three things
 * that `pnpm run lint` does not check by itself:
 * - PATH ALIASES. The suites resolve workspace packages through their own
 *   tsconfig `paths` (`@polymarket-bot/trader` -> `apps/trader/src/index.ts`,
 *   ...), and a suite has no `node_modules` link to fall back on. The lint
 *   program must carry every alias with the same target. A suite import whose
 *   alias it lacks resolves to an error type there, and the rule cannot see a
 *   promise it has no type for: lint stays green and silently skips that
 *   module's calls (reproduced when this pin was added).
 * - INCLUDE vs FILES. The block's `files` and the program's `include` spell one
 *   set twice. A FILE the block lints but the program lacks fails lint with a
 *   parsing error, which is loud. A GLOB that differs is not: lint stays green
 *   until a file lands in the gap (`apps/*` for `apps/**` passed lint), and a
 *   glob only the program has is dead weight.
 * - COVERAGE. A file ESLint lints outside the block's globs (a new
 *   `packages/<name>/vitest.config.ts`, a root `vitest.workspace.ts`, a `.cts`
 *   helper) is linted WITHOUT the rule, silently. So every tracked file ESLint
 *   lints must get the rule, on, with its default options, typed by
 *   `tsconfig.lint.json`.
 *
 * HOW, and what it costs. Plain JSON and text: `git ls-files`, `JSON.parse` of
 * every tracked tsconfig (a tsconfig with comments makes this file throw rather
 * than skip it), a dynamic import of `eslint.config.mjs` for the block's
 * globs, and ESLint's `calculateConfigForFile`, which merges the config for a
 * path without reading, parsing or type-checking the file. Nothing here builds
 * a TypeScript program: CI-2's tripwire (`no-synchronous-spawn.test.ts`)
 * documents the ~60 s of synchronous work a vitest worker tolerates per file,
 * and one program over the repository is seconds of it. Every mutant below is
 * an in-memory copy; no tracked file is touched.
 *
 * NOT CHECKED HERE:
 * - That the rule fires. Planted probes proved it when the block was added (see
 *   the `LINT-1` handoff), and `pnpm run lint` builds the program on every run.
 * - Untracked files: the lists come from the Git index, as in the tripwire.
 * - `extends` shapes other than a relative `.json` path; they throw.
 */
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const RULE = "@typescript-eslint/no-floating-promises";
const LINT_TSCONFIG = "tsconfig.lint.json";
const ESLINT_CONFIG = "eslint.config.mjs";
const TSCONFIG = /(?:^|\/)tsconfig[^/]*\.json$/u;

type JsonObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`${where} is not an array of strings: ${JSON.stringify(value)}`);
  }
  return value;
}

function compilerOptions(config: JsonObject): JsonObject {
  const options = config["compilerOptions"];
  return isObject(options) ? options : {};
}

// ---------------------------------------------------------------------------
// Path aliases.

/**
 * The repository-relative tsconfig that `file` extends, or `undefined`. Only a
 * relative path to a `.json` file is followed; any other shape (an array, a
 * package name) throws, so the pin never guesses a base it cannot read.
 */
function extendsTarget(file: string, config: JsonObject): string | undefined {
  const target = config["extends"];
  if (target === undefined) return undefined;
  if (typeof target !== "string" || !/^\.\.?\//u.test(target) || !target.endsWith(".json")) {
    throw new Error(
      `${file}: unsupported "extends" ${JSON.stringify(target)}; this pin follows only a relative path to a .json file`,
    );
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
}

/**
 * The directory `file`'s own `paths` targets resolve against, as TypeScript
 * resolves them: the nearest `baseUrl` in its `extends` chain, relative to the
 * tsconfig that declares that `baseUrl`; without one, the directory of the
 * tsconfig that declares the `paths` (`file` itself).
 */
function pathsBase(file: string, configs: ReadonlyMap<string, JsonObject>): string {
  const seen = new Set<string>();
  for (let current: string | undefined = file; current !== undefined; ) {
    if (seen.has(current)) throw new Error(`${file}: "extends" cycle through ${current}`);
    seen.add(current);
    const config = configs.get(current);
    if (config === undefined) throw new Error(`${file}: ${current} was not read`);
    const baseUrl = compilerOptions(config)["baseUrl"];
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== "string" || path.posix.isAbsolute(baseUrl)) {
        throw new Error(`${current}: unsupported "baseUrl" ${JSON.stringify(baseUrl)}`);
      }
      return path.posix.join(path.posix.dirname(current), baseUrl);
    }
    current = extendsTarget(current, config);
  }
  return path.posix.dirname(file);
}

/**
 * The aliases `file` declares ITSELF in `compilerOptions.paths`, each target
 * resolved to a normalized repository-relative path. Inherited aliases are
 * pinned where they are declared, because every tracked tsconfig is read.
 */
function declaredAliases(file: string, configs: ReadonlyMap<string, JsonObject>): Map<string, readonly string[]> {
  const config = configs.get(file);
  if (config === undefined) throw new Error(`${file} was not read`);
  const paths = compilerOptions(config)["paths"];
  const aliases = new Map<string, readonly string[]>();
  if (paths === undefined) return aliases;
  if (!isObject(paths)) throw new Error(`${file}: "paths" is not an object`);
  const base = pathsBase(file, configs);
  for (const [alias, targets] of Object.entries(paths)) {
    const resolved = stringArray(targets, `${file} paths[${JSON.stringify(alias)}]`).map((target) => {
      if (path.posix.isAbsolute(target)) throw new Error(`${file}: absolute "paths" target ${target}`);
      return path.posix.normalize(path.posix.join(base, target));
    });
    aliases.set(alias, resolved);
  }
  return aliases;
}

interface AliasInputs {
  /** Every tracked tsconfig (the lint one included), repository-relative. */
  readonly tsconfigs: readonly string[];
  /** Those tsconfigs and every tsconfig their `extends` chains reach, parsed. */
  readonly configs: ReadonlyMap<string, JsonObject>;
  /** Every tracked file, repository-relative. */
  readonly tracked: ReadonlySet<string>;
}

/**
 * Findings: an alias of another tsconfig that `tsconfig.lint.json` lacks or
 * maps to a different target list, and an alias of `tsconfig.lint.json`
 * whose target is not a tracked file. A superset is allowed: the lint program
 * may carry an alias no suite declares, as long as it points at a real file.
 */
function aliasFindings({ tsconfigs, configs, tracked }: AliasInputs): string[] {
  if (!tsconfigs.includes(LINT_TSCONFIG)) return [`${LINT_TSCONFIG} is not tracked`];
  const lint = declaredAliases(LINT_TSCONFIG, configs);
  const findings: string[] = [];
  for (const file of tsconfigs) {
    if (file === LINT_TSCONFIG) continue;
    for (const [alias, targets] of declaredAliases(file, configs)) {
      const ours = lint.get(alias);
      if (ours === undefined) {
        findings.push(
          `${file}: alias ${alias} -> ${JSON.stringify(targets)} is missing from ${LINT_TSCONFIG}; ` +
            "the typed lint program would resolve it to an error type and skip its promises",
        );
      } else if (JSON.stringify(ours) !== JSON.stringify(targets)) {
        findings.push(
          `${file}: alias ${alias} -> ${JSON.stringify(targets)}, ` +
            `but ${LINT_TSCONFIG} maps it to ${JSON.stringify(ours)}`,
        );
      }
    }
  }
  for (const [alias, targets] of lint) {
    for (const target of targets) {
      if (!tracked.has(target)) {
        findings.push(`${LINT_TSCONFIG}: alias ${alias} -> ${target}, which is not a tracked file`);
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The typed block and the program's file selection.

/** The config entries that configure the typed rule. */
function typedBlocks(eslintConfig: unknown): JsonObject[] {
  if (!Array.isArray(eslintConfig)) throw new Error(`${ESLINT_CONFIG} does not export an array`);
  return eslintConfig.filter(
    (entry): entry is JsonObject => isObject(entry) && isObject(entry["rules"]) && RULE in entry["rules"],
  );
}

function duplicates(list: readonly string[]): string[] {
  return list.filter((entry, index) => list.indexOf(entry) !== index);
}

/**
 * Findings: the typed block's `files` and the lint tsconfig's `include` are
 * not the same set, or either side has a key that would make its selection
 * differ from that list (`ignores` on the block; `files`, `exclude` or
 * `references` on the tsconfig).
 */
function globFindings(lintConfig: JsonObject, eslintConfig: unknown): string[] {
  const blocks = typedBlocks(eslintConfig);
  if (blocks.length !== 1) {
    return [`${ESLINT_CONFIG}: expected exactly one entry configuring ${RULE}, found ${blocks.length}`];
  }
  const [block] = blocks as [JsonObject];
  const files = stringArray(block["files"], `${ESLINT_CONFIG} typed block "files"`);
  const include = stringArray(lintConfig["include"], `${LINT_TSCONFIG} "include"`);
  const findings: string[] = [];
  for (const glob of files) {
    if (!include.includes(glob)) {
      findings.push(
        `${ESLINT_CONFIG} typed block lints ${glob}, which ${LINT_TSCONFIG}'s "include" lacks ` +
          "(those files fail lint with a parsing error)",
      );
    }
  }
  for (const glob of include) {
    if (!files.includes(glob)) {
      findings.push(`${LINT_TSCONFIG} includes ${glob}, which the typed block's "files" lacks`);
    }
  }
  for (const glob of duplicates(files)) findings.push(`${ESLINT_CONFIG} typed block lists ${glob} twice`);
  for (const glob of duplicates(include)) findings.push(`${LINT_TSCONFIG} includes ${glob} twice`);
  if (block["ignores"] !== undefined) findings.push(`${ESLINT_CONFIG} typed block has "ignores"`);
  for (const key of ["files", "exclude", "references"]) {
    if (lintConfig[key] !== undefined) findings.push(`${LINT_TSCONFIG} has "${key}"`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Coverage: every file ESLint lints gets the typed rule.

interface FileConfig {
  readonly file: string;
  /** ESLint's merged config for the file; `undefined` when ESLint does not lint it. */
  readonly config: unknown;
}

/**
 * Findings: a file ESLint lints whose merged config does not run the rule ON
 * with its default options (`[2]`), or does not type it with
 * `parserOptions.project` = `tsconfig.lint.json` (resolved against
 * `tsconfigRootDir`) and nothing else.
 */
function coverageFindings(entries: readonly FileConfig[], lintTsconfigPath: string): string[] {
  const findings: string[] = [];
  for (const { file, config } of entries) {
    if (config === undefined) continue;
    if (!isObject(config)) {
      findings.push(`${file}: unreadable config`);
      continue;
    }
    const rules = isObject(config["rules"]) ? config["rules"] : {};
    const rule = rules[RULE];
    if (JSON.stringify(rule) !== "[2]") {
      findings.push(`${file}: linted, but ${RULE} is ${JSON.stringify(rule)} (expected [2]: error, default options)`);
    }
    const languageOptions = isObject(config["languageOptions"]) ? config["languageOptions"] : {};
    const parserOptions = isObject(languageOptions["parserOptions"]) ? languageOptions["parserOptions"] : {};
    const project = parserOptions["project"];
    const rootDir = parserOptions["tsconfigRootDir"];
    const typedBy =
      Array.isArray(project) && project.length === 1 && typeof project[0] === "string" && typeof rootDir === "string"
        ? path.resolve(rootDir, project[0])
        : undefined;
    if (typedBy !== lintTsconfigPath || parserOptions["projectService"] !== undefined) {
      findings.push(
        `${file}: linted, but not typed by ${LINT_TSCONFIG} alone ` +
          `(project ${JSON.stringify(project)}, tsconfigRootDir ${JSON.stringify(rootDir)}, ` +
          `projectService ${JSON.stringify(parserOptions["projectService"])})`,
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Real inputs, read once.

interface RealInputs extends AliasInputs {
  readonly lintConfig: JsonObject;
  readonly eslintConfig: unknown;
  readonly lintTsconfigPath: string;
}

async function gitListFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\0").filter((entry) => entry !== "");
}

async function readJsonObject(file: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path.join(repoRoot, file), "utf8"));
  if (!isObject(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

/** `files`, plus every tsconfig their `extends` chains reach, parsed. */
async function readConfigs(files: readonly string[]): Promise<Map<string, JsonObject>> {
  const configs = new Map<string, JsonObject>();
  const pending = [...files];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (configs.has(file)) continue;
    const config = await readJsonObject(file);
    configs.set(file, config);
    const parent = extendsTarget(file, config);
    if (parent !== undefined) pending.push(parent);
  }
  return configs;
}

let realInputs: Promise<RealInputs> | undefined;

function readRealInputs(): Promise<RealInputs> {
  realInputs ??= (async () => {
    const tracked = await gitListFiles();
    const tsconfigs = tracked.filter((file) => TSCONFIG.test(file));
    const configs = await readConfigs(tsconfigs);
    const lintConfig = configs.get(LINT_TSCONFIG) ?? (await readJsonObject(LINT_TSCONFIG));
    const eslintModule: unknown = await import(pathToFileURL(path.join(repoRoot, ESLINT_CONFIG)).href);
    const eslintConfig = isObject(eslintModule) ? eslintModule["default"] : undefined;
    const lintTsconfigPath = path.join(await realpath(repoRoot), LINT_TSCONFIG);
    return { tracked: new Set(tracked), tsconfigs, configs, lintConfig, eslintConfig, lintTsconfigPath };
  })();
  return realInputs;
}

/** ESLint's merged config for each of `files`, from the repository's real config (plus `overrideConfig`). */
async function fileConfigs(files: readonly string[], options: ESLint.Options = {}): Promise<FileConfig[]> {
  const eslint = new ESLint({ cwd: repoRoot, ...options });
  const entries: FileConfig[] = [];
  for (const file of files) {
    entries.push({ file, config: (await eslint.calculateConfigForFile(file)) as unknown });
  }
  return entries;
}

let realCoverage: Promise<FileConfig[]> | undefined;

function readRealCoverage(): Promise<FileConfig[]> {
  realCoverage ??= readRealInputs().then(({ tracked }) => fileConfigs([...tracked]));
  return realCoverage;
}

// ---------------------------------------------------------------------------
// In-memory mutants. Each expectation is on the findings a mutant ADDS to the
// real files' own findings, so a drift in the real files fails the "real files"
// tests with its finding, not every mutant test as well.

function addedAliasFindings(real: AliasInputs, mutant: AliasInputs): string[] {
  const before = aliasFindings(real);
  return aliasFindings(mutant).filter((finding) => !before.includes(finding));
}

function addedGlobFindings(real: RealInputs, lintConfig: JsonObject, eslintConfig: unknown): string[] {
  const before = globFindings(real.lintConfig, real.eslintConfig);
  return globFindings(lintConfig, eslintConfig).filter((finding) => !before.includes(finding));
}

function withConfig(
  configs: ReadonlyMap<string, JsonObject>,
  file: string,
  edit: (config: JsonObject) => JsonObject,
): Map<string, JsonObject> {
  const config = configs.get(file);
  if (config === undefined) throw new Error(`mutant: ${file} was not read`);
  return new Map(configs).set(file, edit(structuredClone(config)));
}

function withPaths(config: JsonObject, edit: (paths: JsonObject) => JsonObject): JsonObject {
  const options = compilerOptions(config);
  const paths = options["paths"];
  if (!isObject(paths)) throw new Error("mutant: no paths to edit");
  return { ...config, compilerOptions: { ...options, paths: edit(paths) } };
}

function withTypedBlock(eslintConfig: unknown, edit: (block: JsonObject) => JsonObject): unknown[] {
  if (!Array.isArray(eslintConfig)) throw new Error("mutant: config is not an array");
  const [block] = typedBlocks(eslintConfig);
  if (block === undefined) throw new Error("mutant: no typed block");
  return eslintConfig.map((entry: unknown) => (entry === block ? edit(block) : entry));
}

// ---------------------------------------------------------------------------

describe("LINT-1: tsconfig.lint.json carries every tsconfig's path aliases, with the same targets", () => {
  it("resolves targets as TypeScript does: the nearest baseUrl in the extends chain, else the declaring file", () => {
    const base = "../../tsconfig.base.json";
    const inheritsUrl = "../../base-with-url.json";
    const configs = new Map<string, JsonObject>([
      ["tsconfig.base.json", { compilerOptions: {} }],
      ["base-with-url.json", { compilerOptions: { baseUrl: "packages" } }],
      ["a/b/own-url.json", { extends: base, compilerOptions: { baseUrl: "../..", paths: { x: ["p/x.ts"] } } }],
      ["a/b/dot-url.json", { extends: base, compilerOptions: { baseUrl: ".", paths: { x: ["../../p/x.ts"] } } }],
      ["a/b/no-url.json", { extends: base, compilerOptions: { paths: { x: ["../../p/x.ts"] } } }],
      // `baseUrl` "packages", inherited from the root: "../p/x.ts" is p/x.ts.
      ["a/b/inherited-url.json", { extends: inheritsUrl, compilerOptions: { paths: { x: ["../p/x.ts"] } } }],
      ["a/b/fallbacks.json", { compilerOptions: { paths: { x: ["./one.ts", "./two.ts"] } } }],
    ]);
    for (const file of ["a/b/own-url.json", "a/b/dot-url.json", "a/b/no-url.json", "a/b/inherited-url.json"]) {
      expect([...declaredAliases(file, configs)], file).toEqual([["x", ["p/x.ts"]]]);
    }
    expect([...declaredAliases("a/b/fallbacks.json", configs)]).toEqual([["x", ["a/b/one.ts", "a/b/two.ts"]]]);
    expect([...declaredAliases("tsconfig.base.json", configs)]).toEqual([]);
  });

  it("fails closed on a shape it cannot follow", () => {
    const shapes: Array<[string, JsonObject]> = [
      ['"extends" names a package', { extends: "@tsconfig/node24/tsconfig.json", compilerOptions: { paths: {} } }],
      ['"extends" is an array', { extends: ["./a.json"], compilerOptions: { paths: {} } }],
      ['"paths" is not an object', { compilerOptions: { paths: ["x"] } }],
      ["a target list is not strings", { compilerOptions: { paths: { x: "p/x.ts" } } }],
      ["a target is absolute", { compilerOptions: { paths: { x: ["/p/x.ts"] } } }],
      ['"baseUrl" is absolute', { compilerOptions: { baseUrl: "/p", paths: { x: ["x.ts"] } } }],
    ];
    for (const [label, config] of shapes) {
      expect(() => declaredAliases("t/tsconfig.json", new Map([["t/tsconfig.json", config]])), label).toThrow();
    }
  });

  it("reads a real, non-vacuous set: every tracked tsconfig, 13+ declaring aliases, 40+ distinct aliases", async () => {
    const { tsconfigs, configs } = await readRealInputs();
    for (const expected of [LINT_TSCONFIG, "tsconfig.base.json", "test/tsconfig.json", "test/e2e/tsconfig.json"]) {
      expect(tsconfigs).toContain(expected);
    }
    const declaring = tsconfigs.filter((file) => file !== LINT_TSCONFIG && declaredAliases(file, configs).size > 0);
    expect(declaring.length).toBeGreaterThanOrEqual(13);
    const distinct = new Set(declaring.flatMap((file) => [...declaredAliases(file, configs).keys()]));
    expect(distinct.size).toBeGreaterThanOrEqual(40);
    // A suite with baseUrl "." and one with the repository root as baseUrl name
    // the same file, and so does the lint program, which has no baseUrl.
    expect(declaredAliases("test/contract/binance/tsconfig.json", configs).get("@polymarket-bot/decimal")).toEqual([
      "packages/decimal/src/index.ts",
    ]);
    expect(declaredAliases("test/e2e/tsconfig.json", configs).get("@polymarket-bot/trader")).toEqual([
      "apps/trader/src/index.ts",
    ]);
    expect(declaredAliases(LINT_TSCONFIG, configs).get("@polymarket-bot/trader")).toEqual(["apps/trader/src/index.ts"]);
  });

  it("finds no drift in the real files", async () => {
    expect(aliasFindings(await readRealInputs())).toEqual([]);
  });

  it("fails when a suite gains an alias the lint program lacks", async () => {
    const real = await readRealInputs();
    const configs = withConfig(real.configs, "test/e2e/tsconfig.json", (config) =>
      withPaths(config, (paths) => ({ ...paths, "@polymarket-bot/oms": ["packages/oms/src/index.ts"] })),
    );
    expect(addedAliasFindings(real, { ...real, configs })).toEqual([
      'test/e2e/tsconfig.json: alias @polymarket-bot/oms -> ["packages/oms/src/index.ts"] ' +
        `is missing from ${LINT_TSCONFIG}; ` +
        "the typed lint program would resolve it to an error type and skip its promises",
    ]);
  });

  it("fails when a suite's alias and the lint program's point at different files", async () => {
    const real = await readRealInputs();
    // This suite's baseUrl is its own directory.
    const other = ["../../../packages/decimal/src/other.ts"];
    const configs = withConfig(real.configs, "test/contract/binance/tsconfig.json", (config) =>
      withPaths(config, (paths) => ({ ...paths, "@polymarket-bot/decimal": other })),
    );
    expect(addedAliasFindings(real, { ...real, configs })).toEqual([
      'test/contract/binance/tsconfig.json: alias @polymarket-bot/decimal -> ["packages/decimal/src/other.ts"], ' +
        `but ${LINT_TSCONFIG} maps it to ["packages/decimal/src/index.ts"]`,
    ]);
    const fallback = withConfig(real.configs, "test/e2e/tsconfig.json", (config) =>
      withPaths(config, (paths) => ({ ...paths, "@polymarket-bot/pnl": ["packages/pnl/src/index.ts", "x.ts"] })),
    );
    expect(addedAliasFindings(real, { ...real, configs: fallback })).toHaveLength(1);
  });

  it("fails when the lint program drops an alias, or points one at no tracked file", async () => {
    const real = await readRealInputs();
    const dropped = withConfig(real.configs, LINT_TSCONFIG, (config) =>
      withPaths(config, (paths) =>
        Object.fromEntries(Object.entries(paths).filter(([alias]) => alias !== "@polymarket-bot/storage-wal/testing")),
      ),
    );
    const findings = addedAliasFindings(real, { ...real, configs: dropped });
    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(findings.every((finding) => finding.includes("alias @polymarket-bot/storage-wal/testing"))).toBe(true);
    const stale = withConfig(real.configs, LINT_TSCONFIG, (config) =>
      withPaths(config, (paths) => ({ ...paths, "@polymarket-bot/gone": ["./packages/gone/src/index.ts"] })),
    );
    expect(addedAliasFindings(real, { ...real, configs: stale })).toEqual([
      `${LINT_TSCONFIG}: alias @polymarket-bot/gone -> packages/gone/src/index.ts, which is not a tracked file`,
    ]);
  });
});

describe("LINT-1: tsconfig.lint.json's include is exactly the typed block's files", () => {
  it("the real config has one typed block, and its files equal the lint program's include", async () => {
    const { lintConfig, eslintConfig } = await readRealInputs();
    expect(typedBlocks(eslintConfig)).toHaveLength(1);
    expect(globFindings(lintConfig, eslintConfig)).toEqual([]);
    const include = stringArray(lintConfig["include"], "include");
    for (const expected of ["test/**/*.ts", "packages/**/src/**/*.ts", "apps/**/src/**/*.ts"]) {
      expect(include).toContain(expected);
    }
  });

  it("the lint program extends tsconfig.base.json and never emits", async () => {
    const { lintConfig } = await readRealInputs();
    expect(lintConfig["extends"]).toBe("./tsconfig.base.json");
    expect(compilerOptions(lintConfig)["noEmit"]).toBe(true);
  });

  it("fails when a glob is only in the block, only in the include, or listed twice", async () => {
    const real = await readRealInputs();
    const { lintConfig, eslintConfig } = real;
    const include = stringArray(lintConfig["include"], "include");
    const wider = withTypedBlock(eslintConfig, (block) => ({
      ...block,
      files: [...stringArray(block["files"], "files"), "scripts/**/*.ts"],
    }));
    expect(addedGlobFindings(real, lintConfig, wider)).toEqual([
      `${ESLINT_CONFIG} typed block lints scripts/**/*.ts, which ${LINT_TSCONFIG}'s "include" lacks ` +
        "(those files fail lint with a parsing error)",
    ]);
    const narrower = { ...lintConfig, include: include.filter((glob) => glob !== "apps/**/src/**/*.ts") };
    expect(addedGlobFindings(real, narrower, eslintConfig)).toEqual([
      `${ESLINT_CONFIG} typed block lints apps/**/src/**/*.ts, which ${LINT_TSCONFIG}'s "include" lacks ` +
        "(those files fail lint with a parsing error)",
    ]);
    const extra = { ...lintConfig, include: [...include, "docs/**/*.ts"] };
    expect(addedGlobFindings(real, extra, eslintConfig)).toEqual([
      `${LINT_TSCONFIG} includes docs/**/*.ts, which the typed block's "files" lacks`,
    ]);
    const twice = { ...lintConfig, include: [...include, "test/**/*.ts"] };
    expect(addedGlobFindings(real, twice, eslintConfig)).toEqual([`${LINT_TSCONFIG} includes test/**/*.ts twice`]);
  });

  it("fails when either side narrows its list another way, or the block is missing or doubled", async () => {
    const real = await readRealInputs();
    const { lintConfig, eslintConfig } = real;
    const ignoring = withTypedBlock(eslintConfig, (block) => ({ ...block, ignores: ["x"] }));
    expect(addedGlobFindings(real, lintConfig, ignoring)).toEqual([`${ESLINT_CONFIG} typed block has "ignores"`]);
    expect(addedGlobFindings(real, { ...lintConfig, exclude: ["test/e2e/**"] }, eslintConfig)).toEqual([
      `${LINT_TSCONFIG} has "exclude"`,
    ]);
    if (!Array.isArray(eslintConfig)) throw new Error("config is not an array");
    const untyped = withTypedBlock(eslintConfig, (block) => ({ ...block, rules: {} }));
    expect(addedGlobFindings(real, lintConfig, untyped)).toEqual([
      `${ESLINT_CONFIG}: expected exactly one entry configuring ${RULE}, found 0`,
    ]);
    const [block] = typedBlocks(eslintConfig);
    expect(addedGlobFindings(real, lintConfig, [...eslintConfig, block])).toEqual([
      `${ESLINT_CONFIG}: expected exactly one entry configuring ${RULE}, found 2`,
    ]);
  });
});

describe("LINT-1: every file ESLint lints runs the rule, typed by tsconfig.lint.json", () => {
  it("covers every tracked file ESLint lints: tests, source, .mjs helpers, tools and the config", async () => {
    const { lintTsconfigPath } = await readRealInputs();
    const entries = await readRealCoverage();
    const linted = entries.filter(({ config }) => config !== undefined).map(({ file }) => file);
    // Non-vacuity: 1003 files were linted at the commit that added this pin.
    expect(linted.length).toBeGreaterThan(900);
    for (const expected of [
      "test/unit/tooling/lint-typed-program.test.ts",
      "test/unit/tooling/dependency-direction.test.ts",
      "test/e2e/support/artifact.ts",
      "test/soak/recorder/run-soak.mjs",
      "test/soak/recorder/inherited-tojson.preload.mjs",
      "test/vitest.config.ts",
      "packages/decimal/src/index.ts",
      "packages/decimal/src/arithmetic.test.ts",
      "apps/trader/src/index.ts",
      "tools/check-dependency-direction.mjs",
      ESLINT_CONFIG,
    ]) {
      expect(linted).toContain(expected);
    }
    expect(coverageFindings(entries, lintTsconfigPath)).toEqual([]);
  });

  it("fails for a file ESLint would lint outside the block's globs", async () => {
    const { lintTsconfigPath } = await readRealInputs();
    // Paths only: calculateConfigForFile merges config by path, so none of
    // these files needs to exist.
    const outside = ["packages/risk/vitest.config.ts", "vitest.workspace.ts", "test/unit/helper.cts", "scripts/x.mjs"];
    const findings = coverageFindings(await fileConfigs(outside), lintTsconfigPath);
    for (const file of outside) {
      expect(findings).toContain(`${file}: linted, but ${RULE} is undefined (expected [2]: error, default options)`);
    }
  });

  it("fails when a later block turns the rule off, changes its options or retypes a file", async () => {
    const { lintTsconfigPath } = await readRealInputs();
    const tools = ["tools/check-dependency-direction.mjs"];
    const off = await fileConfigs(tools, { overrideConfig: { files: ["tools/*.mjs"], rules: { [RULE]: "off" } } });
    expect(coverageFindings(off, lintTsconfigPath)).toEqual([
      `${tools[0]}: linted, but ${RULE} is [0] (expected [2]: error, default options)`,
    ]);
    const optioned = await fileConfigs(tools, {
      overrideConfig: { files: ["tools/*.mjs"], rules: { [RULE]: ["error", { ignoreIIFE: true }] } },
    });
    expect(coverageFindings(optioned, lintTsconfigPath)).toHaveLength(1);
    const suiteProject = { parserOptions: { project: ["./test/tsconfig.json"] } };
    const retyped = await fileConfigs(tools, {
      overrideConfig: { files: ["tools/*.mjs"], languageOptions: suiteProject },
    });
    expect(coverageFindings(retyped, lintTsconfigPath)).toHaveLength(1);
  });
});
