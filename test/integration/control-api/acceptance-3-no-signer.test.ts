/**
 * WP-240 ACCEPTANCE 3 — "No signer is loaded." — the TEST-TREE SCAN, which is
 * best-effort LINT, and the pins that hold the run-time guard's installation
 * (`CONTROL-1b` r4).
 *
 * The property rests on two AUTHORITATIVE checks:
 * `acceptance-3-shipped-artifact.test.ts` — the shipped bundle's esbuild
 * metafile holds no forbidden module, and the production source holds no
 * dynamic-loading primitive — and the run-time guard
 * (`support/no-signer-guard.ts`), installed in every runner that executes
 * control-api code (the repository unit runner's `control-api` project and
 * both control-api integration runners; "the runners" below hold each config
 * to it) and pinned in each by `no-signer-runtime-guard.test.ts`.
 *
 * Beside them, this file scans the shipped source of both trees `WP-240` owns,
 * the control API's own test suites and `infra/grafana/**`
 * (`CONTROL-1`, closing `WP-240` r1 N-4). Loads are read from each file's
 * SYNTAX TREE, as the evaluated literal, and what the scan cannot read fails
 * it (`CONTROL-1b`, for `CONTROL1-R2-J-L1`; `support/module-loads.ts`). Each
 * literal is judged by where it lands — the file a path reaches, the package a
 * bare name resolves to, the builtin a `node:` id names — every file of every
 * scanned tree is classified (r1), every other literal is judged by what it
 * names, only listed bare packages may load (r2), and a literal path is judged
 * where a loader handed it would land (r3; `support/load-judge.ts`). This is
 * the `apps/trader` precedent
 * (`test/integration/paper-trader/compose-and-example-config.test.ts`'s scans),
 * applied to a package whose §4.1 description is literally "never has the
 * signing key".
 *
 * Three claims, as far as the scan sees:
 *
 * 1. **No load** of the secure adapter, a venue client, or a signing library:
 *    no literal lands in `packages/polymarket-secure`, in `node_modules` by
 *    path, or in a package named like one; no literal in a scanned file names
 *    one; no bare package outside an explicit list is loaded; no builtin that
 *    can load or run code is loaded; nothing the scan cannot place is excused
 *    without an exact allowlist entry; the runners that execute these trees
 *    load nothing their imports do not name but the run-time guard; and no
 *    workspace package a load lands in declares a forbidden dependency, at any
 *    depth.
 * 2. **No identifier** naming a signer, a wallet key or a credential in
 *    production source — and the exceptions are enumerated, not waived: the
 *    words appear only where the code REFUSES them.
 * 3. **No manifest dependency** on `packages/polymarket-secure`, and no
 *    credential-shaped value in the shipped example configuration.
 *
 * ## Its limits, stated plainly (`CONTROL-1b` r4)
 *
 * This scan is best-effort lint: no static analysis of JavaScript is sound
 * against deliberate obfuscation, and it does not claim to be. It does not
 * see a loader reached by a computed key, by enumeration or found by value as
 * an evaluator, handed a target computed or joined to a base at run time;
 * escapes inside evaluated code text beyond the common ones (legacy octal
 * escapes, braced escapes longer than six digits) or code text quoted more
 * than four layers deep; crafted directories and manifests (a load or literal
 * path that lands on a directory, a manifest whose entry is itself a package
 * directory); a relative path resolved against the working directory or any
 * base but its own file's directory (and, when absolute, the repository
 * root); a value another module exports, or a file written at run time;
 * copies or hard links of a forbidden file; child processes and worker
 * threads; and Node's loader internals. The run-time guard refuses, in every
 * runner that executes control-api code, each of these that lands on a
 * forbidden file. It does NOT see a copy or hard link of a forbidden file at a
 * path that names nothing forbidden (it judges where a file lies, not what it
 * holds); code read as text and evaluated, or handed to a load hook a test
 * registers; a module graph a test builds itself (whose Node-loaded
 * dependencies it does see); another thread or process (its hook is
 * thread-local); Node's loader internals that run no hook
 * (`Module._extensions[…]`); or a builtin reached through
 * `process.getBuiltinModule`, which resolves nothing.
 *
 * ## What else this does not prove
 *
 * - Code a test WRITES at run time over a file that already exists, and then
 *   loads, is not read: the scan read the file's earlier text. (A load of a
 *   file that does not exist when the scan runs fails, and the guard refuses
 *   whatever forbidden file such code loads.)
 * - Third-party packages are judged by name, by the bare-package list and by
 *   their own `package.json` dependencies; their deeper transitive
 *   dependencies are not read.
 * - Runner flags outside this package — CI's environment, `NODE_OPTIONS` —
 *   are not read; this package's own scripts and the three vitest configs
 *   that run these trees are.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { ALL_PRODUCTION_NAMES, CREDENTIAL_NAME_PATTERNS } from "@polymarket-bot/observability";

import rootConfig from "../../vitest.config.js";
import postgresConfig from "./postgres/vitest.config.js";
import {
  FORBIDDEN_PACKAGES,
  PERMITTED_BARE_SPECIFIERS,
  PERMITTED_BUILTINS,
  PROCESS_DEPENDENT_ROOTS,
  SDK_DEPENDENCY_PACKAGES,
  SECURE_DIRECTORY,
  aliasesOf,
  discover,
  forbiddenDependencyClosure,
  installsNoSignerGuard,
  isForbiddenName,
  judgeLiteral,
  judgeLoad,
  judgePaths,
  landsFinding,
  literalFinding,
  projectsOf,
  unjudgedConfigKeys,
  workspacePackageOf,
  type LandingContext,
  type Verdict,
} from "./support/load-judge.js";
import {
  CODE_EXTENSIONS,
  COMPUTED,
  EVALUATOR_CONSTRUCTORS,
  LOADER_NAMES,
  RUNTIME_LOADER_PREFIX,
  SCANNED_EXTENSIONS,
  SPECIFIER_LOADERS,
  UNPARSEABLE,
  VITEST_ONLY_WHEN_ON_VI,
  loaderFinding,
  moduleLoadsIn,
  scanSource,
} from "./support/module-loads.js";
import { NO_SIGNER_PLUGIN_NAME, NO_SIGNER_SETUP_FILE, noSignerLoad, noSignerVitePlugin } from "./support/no-signer-guard.js";
import integrationConfig from "./vitest.config.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/** A name built from parts, so this file spells no loader name as a literal (the scan reads it too). */
const named = (...parts: readonly string[]): string => parts.join("");

// `CONTROL-1b` r2: every literal is judged by what it names, so this file
// spells no forbidden target either — each is read from the vocabulary.
const [SECURE_PACKAGE, VENUE_SDK, , , , ETHERS_NAME, VIEM_NAME, WEB3_NAME] = FORBIDDEN_PACKAGES;
const NODE_MODULES = named("node_", "modules");

/** Yields to the event loop between heavy synchronous blocks, so the worker's RPC is answered. */
const yieldToLoop = (): Promise<void> =>
  new Promise((resolveYield) => {
    setImmediate(resolveYield);
  });

const OWNED_TREES = [
  resolve(repoRoot, "apps/control-api/src"),
  resolve(repoRoot, "packages/observability/src/control"),
];

/**
 * `CONTROL-1`, closing `WP-240` r1 N-4: the LOAD scan also covers the control
 * API's own test suites and the dashboards it feeds. A signing library loaded
 * by a test of a process that "never has the signing key" would load one into
 * the very worker that proves it is absent; and a dashboard tree is JSON
 * today, so the scan's job there is to keep it that way. These trees are READ
 * here, never written — `infra/grafana/**` is outside this round's grant.
 */
const IMPORT_SCAN_TREES = [
  ...OWNED_TREES,
  resolve(repoRoot, "test/integration/control-api"),
  resolve(repoRoot, "test/unit/control-api"),
  resolve(repoRoot, "infra/grafana"),
];

/**
 * The one scanned tree that holds no code, and so the only one that may hold an
 * inert file (`CONTROL-1b` r3, for `CONTROL1B-R3-J-H1`: the CommonJS loader
 * runs a `.md` file as JavaScript, and the round-3 verifiers loaded the venue
 * SDK through one beside a test).
 */
const INERT_TREES = [resolve(repoRoot, "infra/grafana")];

/** `directory` — the tree itself, or a mirror of it — classified under `tree`'s policy for inert files. */
const discoverTree = (tree: string, directory = tree): ReturnType<typeof discover> =>
  discover(directory, INERT_TREES.includes(tree));

/** Every entry of every scanned tree, classified (`support/load-judge.ts`, "Discovery is total"). */
const DISCOVERED = new Map(IMPORT_SCAN_TREES.map((tree) => [tree, discoverTree(tree)] as const));
const scannedIn = (tree: string): readonly string[] => {
  const found = DISCOVERED.get(tree);
  return found === undefined ? [] : [...found.code, ...found.json];
};

const FILES = OWNED_TREES.flatMap(scannedIn);
const PRODUCTION_FILES = FILES.filter((path) => !path.endsWith(".test.ts"));
const IMPORT_SCAN_FILES = IMPORT_SCAN_TREES.flatMap(scannedIn);

/**
 * The vitest configs that run a scanned tree. Their aliases are where a bare
 * name lands under vitest, and each is a CLOSED world (`load-judge.ts`,
 * `VITEST_CONFIG_KEYS`): a setup file, a plugin or a custom environment loads
 * a module no import names.
 */
const CONFIGS = [
  { file: "test/integration/control-api/vitest.config.ts", config: integrationConfig as unknown, runs: "test/integration/control-api/" },
  {
    file: "test/integration/control-api/postgres/vitest.config.ts",
    config: postgresConfig as unknown,
    runs: "test/integration/control-api/postgres/",
  },
  // The repository's unit runner. Since `CONTROL-1b` r4 it runs
  // `apps/control-api/src/**` and `test/unit/control-api/**` in a `control-api`
  // project of their own, under the guard ({@link CONTROL_API_UNIT_TESTS}).
  { file: "test/vitest.config.ts", config: rootConfig as unknown, runs: undefined },
] as const;

/**
 * The ONE file outside the guarded trees that loads control-api code
 * (`CONTROL-1b` r4), exactly. It runs in the unit runner's other project,
 * without the guard: it is not a control-api test, and the guard's scope is
 * the control API's own tests (`test/vitest.config.ts`). What it loads is
 * production source, which the authoritative checks hold
 * (`acceptance-3-shipped-artifact.test.ts`).
 */
const OUTSIDE_LOADS_OF_CONTROL_API: readonly { readonly load: string; readonly justification: string }[] = Object.freeze([
  {
    load: "test/unit/tooling/app-bundles-load.test.ts:106 ../../../apps/control-api/src/main.js",
    justification:
      "BUNDLE-1's check that every app's shipped bundle starts (WP-010-owned): it imports control-api's production " +
      "main.ts for its exit codes and runs the built bundle in a child process; production source, held by the " +
      "production-source rule and the bundle metafile",
  },
]);

/** The trees whose files run only under the guard, or are the control API itself. */
const GUARDED_TREES = ["apps/control-api", "test/integration/control-api", "test/unit/control-api"].map((tree) => resolve(repoRoot, tree));

/** A file name a test runner reads as its configuration. */
const isRunnerConfig = (name: string): boolean => /^(vite|vitest)\.(config|workspace)\.|\.config\.[cm]?[jt]s$/u.test(name);

/** Of `configs`, every one that names the control API and is not one of {@link CONFIGS}: a runner without the guard. */
function foreignRunnersOf(configs: readonly string[]): readonly string[] {
  const runners = CONFIGS.map((entry) => resolve(repoRoot, entry.file));
  return configs.filter((config) => !runners.includes(config) && read(config).includes("control-api"));
}

/** Every load in `files` of the control API — by its package name, or by a path into `apps/control-api` — as `file:line specifier`. */
function loadsOfControlApi(files: readonly string[]): readonly string[] {
  const controlApi = resolve(repoRoot, "apps/control-api");
  const found: string[] = [];
  for (const path of files) {
    const text = read(path);
    if (!text.includes("control-api")) continue;
    for (const load of moduleLoadsIn(text, path)) {
      const specifier = load.specifier;
      const landsIn = specifier.startsWith(".") && resolve(dirname(path), specifier).startsWith(`${controlApi}/`);
      if (landsIn || specifier.startsWith("@polymarket-bot/control-api")) found.push(`${relative(repoRoot, path)}:${String(load.line)} ${specifier}`);
    }
  }
  return found;
}

/**
 * The control API's test files the repository's unit runner runs — in its
 * `control-api` project, which installs the run-time guard, and in no other
 * (`CONTROL-1b` r4).
 */
const CONTROL_API_UNIT_TESTS = ["apps/control-api/src/**/*.test.ts", "test/unit/control-api/**/*.test.ts"] as const;

const LANDING: LandingContext = { repoRoot, aliases: CONFIGS.flatMap((entry) => aliasesOf(entry.config)) };

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const SECURE = resolve(repoRoot, "packages", SECURE_DIRECTORY);
/** The venue SDK's entry, by PATH, through the secure adapter's own `node_modules`. */
const SDK_ENTRY = join(SECURE, NODE_MODULES, ...VENUE_SDK.split("/"), "dist", "index.js");

/** The workspace packages (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `packages/strategies/*`), by name. */
const WORKSPACES: ReadonlyMap<string, string> = (() => {
  const found = new Map<string, string>();
  for (const parent of ["apps", "packages", "packages/strategies"]) {
    for (const entry of readdirSync(resolve(repoRoot, parent))) {
      const manifest = resolve(repoRoot, parent, entry, "package.json");
      if (!existsSync(manifest)) continue;
      const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
      if (typeof name === "string") found.set(name, dirname(manifest));
    }
  }
  return found;
})();

/** The file a landing names on disk — TypeScript's `.js` for `.ts` included — or `undefined`. */
function fileOnDisk(landing: string): string | undefined {
  const extension = extname(landing);
  const swaps: Readonly<Record<string, readonly string[]>> = {
    ".js": [".ts", ".tsx"],
    ".mjs": [".mts"],
    ".cjs": [".cts"],
    ".jsx": [".tsx"],
  };
  const candidates = [landing, ...(swaps[extension] ?? []).map((swap) => `${landing.slice(0, -extension.length)}${swap}`)];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/**
 * The EXPLICIT allowlist for unreadable findings (`CONTROL-1b`): one entry per
 * repository-relative file and finding, with the exact number of occurrences
 * and why each is safe. A forbidden landing is never allowlistable, and an
 * entry that no longer matches its file exactly is itself a failure, so the
 * list cannot go stale.
 *
 * `CONTROL-1b` r1: the scan's own vocabulary. `support/module-loads.ts` must
 * NAME every loader it looks for, and since r1 a loader named by a string in
 * a value position is itself a finding — so each name in its lists is one.
 * None is used as a key or called.
 *
 * `CONTROL-1b` r2: likewise `support/forbidden-targets.ts` must NAME every
 * forbidden target, and every literal naming one is now a finding — so each
 * entry of its list is one, once; and the run-time guard's Node half reads
 * `registerHooks` from `node:module`, a builtin the scan otherwise refuses.
 * `CONTROL-1b` r3: `support/load-judge.ts` names the process-dependent trees
 * (`/proc`, `/dev`) a literal path through which fails, each once.
 * Every other scanned file needs no entry.
 */
interface LoadAllowlistEntry {
  readonly file: string;
  readonly finding: string;
  readonly count: number;
  readonly justification: string;
}
const VOCABULARY =
  "support/module-loads.ts lists the loader names it detects as string literals in its own vocabulary " +
  "arrays and map; none is read as a key or called";
const TARGET_VOCABULARY =
  "support/forbidden-targets.ts IS the list of forbidden targets every judge and the run-time guard read: each " +
  "literal names one, once, and nothing loads it";
const LOAD_ALLOWLIST: readonly LoadAllowlistEntry[] = Object.freeze([
  // Read from the vocabulary itself, so this file spells none of the names.
  // A name is written once in its list — and once more where it is also the
  // load KIND it produces (`require`), or also in the list of names flagged
  // only when read off `vi` (`mock`, `unmock`).
  ...[...LOADER_NAMES, ...EVALUATOR_CONSTRUCTORS, ...SPECIFIER_LOADERS.keys(), RUNTIME_LOADER_PREFIX].map((name) => ({
    file: "test/integration/control-api/support/module-loads.ts",
    finding: loaderFinding(name),
    count: 1 + (VITEST_ONLY_WHEN_ON_VI.includes(name) ? 1 : 0) + (SPECIFIER_LOADERS.get(name) === name ? 1 : 0),
    justification: VOCABULARY,
  })),
  // `CONTROL-1b` r2: the forbidden targets, each written once in their list
  // (since r4 the venue SDK's own packages too).
  ...[...FORBIDDEN_PACKAGES, ...SDK_DEPENDENCY_PACKAGES, SECURE_DIRECTORY].map((name) => ({
    file: "test/integration/control-api/support/forbidden-targets.ts",
    finding: literalFinding(name),
    count: 1,
    justification: TARGET_VOCABULARY,
  })),
  // `CONTROL-1b` r3: the judge names the process-dependent trees it refuses a
  // path through, each once.
  ...PROCESS_DEPENDENT_ROOTS.map((root) => ({
    file: "test/integration/control-api/support/load-judge.ts",
    finding: landsFinding(root),
    count: 1,
    justification:
      "support/load-judge.ts lists the process-dependent trees (/proc, /dev) it REFUSES a path through; the list " +
      "is read by the judge only, and nothing loads it",
  })),
  {
    file: "test/integration/control-api/support/no-signer-setup.ts",
    finding: named("<builtin:node:", "module>"),
    count: 1,
    justification:
      "the run-time guard's Node half reads registerHooks, and nothing else, from node:module: a load hook that " +
      "only REFUSES, registered before any test file is imported",
  },
  // `CONTROL-1b` r4: the shipped-artifact check runs the package's own esbuild,
  // as its build script does, in a child process.
  {
    file: "test/integration/control-api/acceptance-3-shipped-artifact.test.ts",
    finding: named("<builtin:node:", "child_", "process>"),
    count: 1,
    justification:
      "the authoritative bundle check runs this package's own esbuild binary with its build script's arguments " +
      "(asynchronously, execFile) to read the shipped bundle's metafile; the child bundles, and nothing it builds " +
      "is loaded into this worker",
  },
]);

/** A file on disk, read every time and parsed once per path and CONTENT (a test rewrites its own fixtures). */
const SCANNED_ON_DISK = new Map<string, ReturnType<typeof scanSource>>();
function scanFile(path: string): { readonly text: string; readonly scanned: ReturnType<typeof scanSource> } {
  const text = read(path);
  const key = `${path}\0${text}`;
  let scanned = SCANNED_ON_DISK.get(key);
  if (scanned === undefined) {
    scanned = scanSource(text, path);
    SCANNED_ON_DISK.set(key, scanned);
  }
  return { text, scanned };
}

/**
 * Every violation in one file: each FORBIDDEN landing, each unreadable
 * finding, and (`CONTROL-1b` r2) each literal naming a forbidden target, that
 * the allowlist does not cover EXACTLY.
 */
function violationsIn(
  path: string,
  text: string,
  allowlist: readonly LoadAllowlistEntry[] = LOAD_ALLOWLIST,
  context: LandingContext = LANDING,
  onDisk = false,
  scanned: ReturnType<typeof scanSource> = scanSource(text, path),
): readonly string[] {
  const file = relative(repoRoot, path);
  const violations: string[] = [];
  const unreadable = new Map<string, number>();
  const count = (finding: string): void => {
    unreadable.set(finding, (unreadable.get(finding) ?? 0) + 1);
  };
  for (const load of scanned.loads) {
    const verdict = judgeLoad(load, path, context);
    if (verdict.kind === "forbidden") {
      violations.push(`${file}:${String(load.line)} ${load.kind} ${load.specifier}`);
    } else if (verdict.kind === "unreadable") {
      count(verdict.finding);
    } else if (onDisk && verdict.landings.some((landing) => !existsSync(landing) && fileOnDisk(landing) === undefined)) {
      // A REAL file's load must land on something that exists now: a file
      // written at run time and then loaded holds code no scan has read.
      count(`<absent:${load.specifier}>`);
    }
  }
  // `CONTROL-1b` r2 (for `CONTROL1B-R2-J-H1`): every OTHER literal, by
  // what it names — a loader the scan cannot see could be handed it; and
  // since r3 (for `CONTROL1B-R3-J-H1`), a literal PATH by where it lands.
  for (const literal of scanned.literals) {
    const verdict = judgeLiteral(literal, path, context);
    if (verdict.kind === "forbidden") count(literalFinding(literal.text));
    else if (verdict.kind === "unreadable") count(verdict.finding);
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

/**
 * The directories `check:deps` never reads inside a workspace package
 * (`tools/check-dependency-direction.mjs`, `SKIPPED_DIRS` — and, there too,
 * every directory whose name begins with a dot). Pinned against the tool's own
 * text below.
 */
const DEPENDENCY_CHECK_SKIPS = ["node_modules", "dist", "build", "coverage", "python", "target", "out"] as const;

/**
 * Whether `file`, inside the workspace package `workspace`, is one `check:deps`
 * reads — source of an extension it parses, under no directory it skips — or
 * JSON, which loads nothing (`CONTROL-1b` r3).
 */
function readByDependencyCheck(file: string, workspace: string): boolean {
  const extension = extname(file);
  if (extension === ".json") return true;
  if (!(CODE_EXTENSIONS as readonly string[]).includes(extension)) return false;
  const directories = relative(workspace, file).split("/").slice(0, -1);
  return directories.every(
    (directory) => !directory.startsWith(".") && !(DEPENDENCY_CHECK_SKIPS as readonly string[]).includes(directory),
  );
}

/**
 * Scans `entries` and, in turn, every file a load of theirs LANDS on outside
 * every scanned tree and every workspace package (`CONTROL-1b` r1): such a
 * file — `test/vitest.config.ts`, or a fixture under `test/` — runs its own
 * loads in the same worker, and nothing else reads them. A landing in a
 * scanned tree is scanned anyway; one in a workspace package is judged by the
 * package's manifest (the dependency-closure test below) and by `check:deps`,
 * which scans every workspace package's source (F6: the venue SDK only in
 * `packages/polymarket-secure`; F16: no relative import leaving a package).
 *
 * `CONTROL-1b` r3 (for `CONTROL1B-R3-J-H1`): the same holds for every file
 * a LITERAL path lands on (`load-judge.ts`, `judgeLiteral`) — a loader the
 * scan does not name can be handed it, and the round-3 verifiers' `.cjs`
 * outside every tree held a `require` of the venue SDK; and a landing inside a
 * workspace package that `check:deps` does NOT read (under `dist/`, a
 * dot-directory and the rest of {@link DEPENDENCY_CHECK_SKIPS}) is scanned in
 * turn too.
 */
function scanClosure(
  entries: readonly string[],
  context: LandingContext = LANDING,
  workspaces: ReadonlyMap<string, string> = WORKSPACES,
): { readonly files: readonly string[]; readonly violations: readonly string[]; readonly loads: number } {
  const files: string[] = [];
  const violations: string[] = [];
  const seen = new Set(entries);
  const queue = [...entries];
  let loads = 0;
  const follow = (landings: readonly string[]): void => {
    for (const landing of landings) {
      const file = fileOnDisk(landing);
      if (file === undefined || seen.has(file)) continue;
      if (IMPORT_SCAN_TREES.some((tree) => file.startsWith(`${tree}/`))) continue;
      const workspace = [...workspaces.values()].find((directory) => file.startsWith(`${directory}/`));
      if (workspace !== undefined && readByDependencyCheck(file, workspace)) continue;
      seen.add(file);
      queue.push(file);
    }
  };
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    files.push(path);
    const { text, scanned } = scanFile(path);
    violations.push(...violationsIn(path, text, LOAD_ALLOWLIST, context, true, scanned));
    for (const load of scanned.loads) {
      loads += 1;
      const verdict = judgeLoad(load, path, context);
      if (verdict.kind === "ok") follow(verdict.landings);
    }
    for (const literal of scanned.literals) {
      const verdict = judgeLiteral(literal, path, context);
      if (verdict.kind === "ok") follow(verdict.landings);
    }
  }
  return { files, violations, loads };
}

/**
 * The workspace packages a load — or, since `CONTROL-1b` r3, a literal path —
 * of `files` lands in: each runs its own imports, which its manifest's
 * dependency closure must keep clear of every forbidden package.
 */
function reachedWorkspaces(files: readonly string[], context: LandingContext = LANDING): ReadonlySet<string> {
  const reached = new Set<string>();
  const reach = (verdict: Verdict): void => {
    if (verdict.kind !== "ok") return;
    for (const landing of verdict.landings) {
      const owner = workspacePackageOf(landing, context.repoRoot);
      if (owner !== undefined) reached.add(owner);
    }
  };
  for (const path of files) {
    const { scanned } = scanFile(path);
    for (const load of scanned.loads) reach(judgeLoad(load, path, context));
    for (const literal of scanned.literals) reach(judgeLiteral(literal, path, context));
  }
  return reached;
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
 * spelling that only the TypeScript grammars have; in a JavaScript file it is
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
    // `CONTROL-1b` r1: vitest's own loaders take a specifier too.
    both(`const m = await vi.importActual(${plain});`);
    both(`const m = await vi.importMock(${plain});`);
    both(`vi.mock(${plain});`);
    both(`vi.doMock(${plain}, () => ({}));`);
    if (quote === "`") {
      for (const form of escaped) both(`const m = await import(${q(form)});`);
    }
  }
  return out;
}

/**
 * The PATH and URL forms the round-1 verifiers used, and their relatives, as
 * spelled from `importer` (`CONTROL1B-R1-J-H1`): each must FAIL, as
 * `forbidden` (it lands somewhere a signer lives) or `unreadable` (the scan
 * cannot place it). Built from parts and from `importer`'s own location.
 */
function landingSpellings(importer: string): readonly { readonly label: string; readonly specifier: string; readonly expect: "forbidden" | "unreadable" }[] {
  const from = dirname(importer);
  const rel = (target: string): string => {
    const path = relative(from, target);
    return path.startsWith(".") ? path : `./${path}`;
  };
  const secureSource = join(SECURE, "src", "index.js");
  const sdk = SDK_ENTRY;
  const relSecure = rel(secureSource);
  const v = named("vi", "em");
  return [
    { label: "relative into the secure adapter (Opus's plant)", specifier: relSecure, expect: "forbidden" },
    { label: "relative into the venue SDK (Opus's plant)", specifier: rel(sdk), expect: "forbidden" },
    { label: "absolute into the secure adapter", specifier: join(SECURE, "src", "index.ts"), expect: "forbidden" },
    { label: "file: URL into the secure adapter", specifier: pathToFileURL(join(SECURE, "src", "index.ts")).href, expect: "forbidden" },
    { label: "a local node_modules path", specifier: `./${NODE_MODULES}/${v}/index.js`, expect: "forbidden" },
    // Forbidden by the node_modules rule ALONE: the package it names is innocuous.
    { label: "a node_modules path to any package", specifier: `./${NODE_MODULES}/innocuous/index.js`, expect: "forbidden" },
    // Forbidden by the segment rule ALONE: a directory named like the secure adapter, elsewhere.
    { label: "a directory named like the secure adapter", specifier: rel(join(repoRoot, "vendor", named("polymarket-", "secure"), "index.js")), expect: "forbidden" },
    { label: "a node_modules path from the root", specifier: rel(join(repoRoot, NODE_MODULES, ".pnpm", `${v}@2.0.0`, NODE_MODULES, v, "index.js")), expect: "forbidden" },
    { label: "a file: URL into node_modules", specifier: pathToFileURL(join(repoRoot, NODE_MODULES, v, "index.js")).href, expect: "forbidden" },
    { label: "a path naming a signing package", specifier: rel(join(repoRoot, "vendor", v, "index.js")), expect: "forbidden" },
    // Percent-encoded so that ONLY the ES loader's reading (a URL, decoded)
    // reaches the secure adapter: the literal path names neither directory.
    {
      label: "percent-encoded (the ES loader decodes it)",
      specifier: relSecure.replace(named("pack", "ages"), named("%70", "ackages")).replace(named("-se", "cure"), named("-%73", "ecure")),
      expect: "forbidden",
    },
    {
      label: "dot segments percent-encoded",
      specifier: `./${relSecure.replaceAll("../", "%2e%2e/").replace(named("-se", "cure"), named("-%73", "ecure"))}`,
      expect: "forbidden",
    },
    { label: "with a query", specifier: `${relSecure}?raw`, expect: "forbidden" },
    { label: "a data: URL", specifier: named("da", "ta:text/javascript,export default 1"), expect: "unreadable" },
    { label: "an https: URL", specifier: "https://example.invalid/m.js", expect: "unreadable" },
    { label: "an imports-field specifier", specifier: "#secure", expect: "unreadable" },
    { label: "backslash separators", specifier: relSecure.replaceAll("/", "\\"), expect: "unreadable" },
    { label: "a non-code target", specifier: "./README.md", expect: "unreadable" },
    { label: "a native addon", specifier: "./addon.node", expect: "unreadable" },
    { label: "an extensionless target", specifier: "./helper", expect: "unreadable" },
    { label: "a bare name nothing resolves", specifier: "not-an-installed-package", expect: "unreadable" },
    // `CONTROL-1b` r3: /proc/self/cwd is the LOADER's working directory — another file in each runner.
    { label: "a process-dependent path", specifier: ["", "pr" + "oc", "self", "cwd", "test", "zz.cjs"].join("/"), expect: "unreadable" },
    ...[
      "node:child_process",
      "child_process",
      "node:worker_threads",
      "node:vm",
      "vm",
      "node:module",
      "module",
      "node:inspector",
      "node:repl",
      "node:cluster",
      "node:v8",
      "node:test",
      "node:sqlite",
      "node:wasi",
      "node:process",
    ].map((builtin) => ({ label: `the builtin ${builtin}`, specifier: builtin, expect: "unreadable" as const })),
  ];
}

/** Three load forms every grammar has, for the per-tree, per-extension landing pins. */
function coreForms(specifier: string): readonly string[] {
  const s = JSON.stringify(specifier);
  return [`import ${s};`, `export * from ${s};`, `const m = await import(${s});`, `const m = require(${s});`];
}

/**
 * Spellings whose specifier the scan CANNOT read, and which must therefore
 * fail it: computed specifiers and named loaders. Built from parts, as above.
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
    `const m = await vi.importActual("${head}" + "${tail}");`,
  ];
}

/**
 * `CONTROL-1b` r1 (for `CONTROL1B-R1-J-H3`): an evaluator or loader
 * reached WITHOUT the spelling round 0 watched. Each loaded the venue SDK, or
 * would, in the round-1 exchange; each must fail.
 */
function evaluatorSpellings(sdkPath: string): readonly string[] {
  const body = "return process.getBuiltinModule('node:module').createRequire(p)(p)";
  return [
    // B3, astra's alias (with Opus's working body).
    `const F = Function; const sdkPath = ${JSON.stringify(sdkPath)}; F("p", "${body}")(sdkPath);`,
    // astra's verbatim plant.
    `const F = Function;\nF("return import(\\"viem\\")")();`,
    // F, `.constructor`.
    `const G = (() => {}).constructor; G("p", "${body}")(${JSON.stringify(sdkPath)});`,
    // E, `getBuiltinModule("node:vm")`.
    `process.getBuiltinModule("node:vm").runInThisContext("(p) => p")(${JSON.stringify(sdkPath)});`,
    `const G = (async () => {}).constructor;`,
    `const G = Object.getPrototypeOf(function* () {}).constructor;`,
    `const { constructor: C } = () => {};`,
    `const G = Reflect.get(() => {}, "constructor");`,
    `const run = Reflect.get(globalThis, "eval");`,
    `const F = globalThis.Function;`,
    `class Evaluator extends Function {}`,
    `const F = [Function][0];`,
    `const F = (0, Function);`,
    `const get = process.getBuiltinModule; get("node:vm");`,
    `const m = process.getBuiltinModule("node:" + "vm");`,
    `const m = process.getBuiltinModule.call(process, "node:vm");`,
    `process.dlopen({ exports: {} }, "/x/addon.node");`,
    `const contextify = process.binding("contextify");`,
    `module._compile("module.exports = 1", "/x.js");`,
    `const all = import.meta.glob("./**/*.ts", { eager: true });`,
    `const load = vi.importActual; await load("x");`,
    `const mock = vi.mock; mock("x");`,
    // `CONTROL-1b` r1: vite-node's wrapper parameters, and vitest's runtime.
    `const m = await __vite_ssr_dynamic_import__(${JSON.stringify(sdkPath)});`,
    `const m = await __vite_ssr_import__(${JSON.stringify(sdkPath)});`,
    `const worker = globalThis.__vitest_worker__;`,
    `const worker = Reflect.get(globalThis, "__vitest_worker__");`,
    `const realm = new ShadowRealm();`,
    // `CONTROL-1b` r2: Node's loader internals compile a file without running
    // any loader hook — the run-time guard cannot see this one, so the scan must.
    `export const compileWith = (M, m) => M._extensions[".js"](m, ${JSON.stringify(sdkPath)});`,
  ];
}

/** Where a round-2 plant names its targets: the checkout's own paths, from the vocabulary. */
const R2 = {
  anchor: join(SECURE, "package.json"),
  secureIndex: join(SECURE, "src", "index.ts"),
  q1Base: join(repoRoot, "test", "integration", "control-api", "zz-rc-q1.test.ts"),
  // Q1's module, as the plant spelled it: relative to its base path read as a directory.
  q1Module: ["..", "..", "..", "..", "packages", SECURE_DIRECTORY, NODE_MODULES, ...VENUE_SDK.split("/"), "dist", "index.js"].join("/"),
} as const;

/**
 * `CONTROL-1b` r2: the round-2 verifiers' five plants (`reconcile-r2/plants/`).
 * Each LOADED the venue SDK or the secure adapter into a test worker with
 * acceptance 3 green at round 1. `ts` is the plant VERBATIM but for its
 * checkout path (this one's), its targets interpolated from the vocabulary so
 * this file spells none; `js` is the same plant with its types stripped, for
 * the JavaScript grammars. `findings` must each be among the violations.
 * `computed` is the plant with every target computed from parts — the
 * mechanism alone — and `computedFindings` what must still catch it: for
 * astra's plant and Q3 nothing static can (the residual), which is what the
 * run-time guard's pins load instead (`support/no-signer-runtime-pins.ts`).
 */
function roundTwoPlants(): readonly {
  readonly label: string;
  readonly ts: string;
  readonly js: string;
  readonly findings: readonly string[];
  readonly computed?: string;
  readonly computedFindings?: readonly string[];
}[] {
  const s = (value: string): string => JSON.stringify(value);
  // Every segment split in two as well, so no literal of the computed form is a segment that names a target.
  const parts = (value: string): string =>
    `[${value
      .split("/")
      .map((part) => (part.length > 1 ? `${s(part.slice(0, 1))} + ${s(part.slice(1))}` : s(part)))
      .join(", ")}].join("/")`;
  return [
    {
      label: "astra's plant: getBuiltinModule and createRequire built with .join, a LITERAL anchor and package (J-H1)",
      ts: `import { expect, it } from "vitest";

const word = (...parts: readonly string[]): string => parts.join("");

it("loads the venue SDK through computed builtin and factory names", () => {
  const builtinName = word("get", "Builtin", "Module");
  const factoryName = word("create", "Require");
  const getBuiltin = (process as unknown as Record<string, (name: string) => unknown>)[builtinName];
  const moduleApi = getBuiltin?.("node:module") as Record<string, unknown>;
  const makeRequire = moduleApi[factoryName] as (anchor: string) => (specifier: string) => unknown;
  const load = makeRequire(
    ${s(R2.anchor)},
  );
  const sdk = load(${s(VENUE_SDK)}) as Record<string, unknown>;
  console.log("PLANT ASTRA LOADED", Object.keys(sdk).length, "SigningError", "SigningError" in sdk);
  expect(Object.keys(sdk).length).toBeGreaterThan(0);
  expect("SigningError" in sdk).toBe(true);
});
`,
      js: `import { expect, it } from "vitest";
const word = (...parts) => parts.join("");
it("loads the venue SDK through computed builtin and factory names", () => {
  const getBuiltin = process[word("get", "Builtin", "Module")];
  const makeRequire = getBuiltin?.("node:module")[word("create", "Require")];
  const sdk = makeRequire(${s(R2.anchor)})(${s(VENUE_SDK)});
  expect("SigningError" in sdk).toBe(true);
});
`,
      findings: [literalFinding(R2.anchor), literalFinding(VENUE_SDK)],
    },
    {
      label: "Opus's Q3: Function found by enumerating the prototype, a LITERAL SDK path (J-H1)",
      ts: `import { it } from "vitest";
it("Q3 evaluator found by value, no name spelled", () => {
  const proto = Object.getPrototypeOf(() => 0) as object;
  const found = Object.values(Object.getOwnPropertyDescriptors(proto)).map((d) => d.value as unknown).find((v) => typeof v === "function" && (v as { prototype?: unknown }).prototype === proto) as (...a: string[]) => (p: string) => object;
  const m = found("p", "return process.getBuiltinModule('node:mod' + 'ule')['create' + 'Require'](p)(p)")(${s(SDK_ENTRY)});
  console.log("PLANT Q3 LOADED", Object.keys(m).length);
});
`,
      js: `import { it } from "vitest";
it("Q3 evaluator found by value, no name spelled", () => {
  const proto = Object.getPrototypeOf(() => 0);
  const found = Object.values(Object.getOwnPropertyDescriptors(proto)).map((d) => d.value).find((v) => typeof v === "function" && v.prototype === proto);
  const m = found("p", "return process.getBuiltinModule('node:mod' + 'ule')['create' + 'Require'](p)(p)")(${s(SDK_ENTRY)});
  console.log("PLANT Q3 LOADED", Object.keys(m).length);
});
`,
      findings: [literalFinding(SDK_ENTRY)],
    },
    {
      label: "Opus's Q1: ts.sys.require(baseDir, moduleName) — the module SECOND (J-H2)",
      ts: `import { it } from "vitest";
import ts from "typescript";
it("Q1 typescript sys loader", () => {
  const got = ts.sys.require?.(${s(R2.q1Base)}, ${s(R2.q1Module)});
  console.log("PLANT Q1", got?.error === undefined ? "LOADED " + String(Object.keys((got?.module ?? {}) as object).length) + " SigningError " + String("SigningError" in ((got?.module ?? {}) as object)) : "ERROR " + String(got.error));
});
`,
      js: `import { it } from "vitest";
import ts from "typescript";
it("Q1 typescript sys loader", () => {
  const got = ts.sys.require?.(${s(R2.q1Base)}, ${s(R2.q1Module)});
  console.log("PLANT Q1", got?.error === undefined ? "LOADED" : "ERROR " + String(got.error));
});
`,
      findings: [named("<loader:re", "quire>"), "<unpermitted:typescript>", literalFinding(R2.q1Module)],
      computed: `import ts from "typescript";
export const got = ts.sys.require?.(${s(R2.q1Base)}, ${parts(R2.q1Module)});
`,
      computedFindings: [named("<loader:re", "quire>"), "<unpermitted:typescript>"],
    },
    {
      label: "Opus's Q2: vitest/node's createViteServer().ssrLoadModule (J-H2)",
      ts: `import { it } from "vitest";
import { createViteServer } from "vitest/node";
it("Q2 vite server ssrLoadModule", async () => {
  const server = await createViteServer({ configFile: false, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const m = await server.ssrLoadModule(${s(R2.secureIndex)});
    console.log("PLANT Q2 LOADED", Object.keys(m).length, Object.keys(m).slice(0, 4).join(","));
  } finally {
    await server.close();
  }
}, 60000);
`,
      js: `import { it } from "vitest";
import { createViteServer } from "vitest/node";
it("Q2 vite server ssrLoadModule", async () => {
  const server = await createViteServer({ configFile: false });
  const m = await server.ssrLoadModule(${s(R2.secureIndex)});
  console.log("PLANT Q2 LOADED", Object.keys(m).length);
}, 60000);
`,
      findings: ["<unpermitted:vitest/node>", literalFinding(R2.secureIndex)],
      computed: `import { createViteServer } from "vitest/node";
export const load = async () => (await createViteServer({ configFile: false })).ssrLoadModule(${parts(R2.secureIndex)});
`,
      computedFindings: ["<unpermitted:vitest/node>"],
    },
    {
      label: "Opus's Q4: ESLint's overrideConfigFile (J-H2)",
      ts: `import { it } from "vitest";
import { ESLint } from "eslint";
it("Q4 eslint config loader", async () => {
  const before = Object.keys(globalThis).length;
  const linter = new ESLint({ cwd: ${s(repoRoot)}, overrideConfigFile: ${s(SDK_ENTRY)} });
  try { await linter.lintText("export {};\\n"); console.log("PLANT Q4 linted"); } catch (error) { console.log("PLANT Q4 threw", String(error).slice(0, 300).replace(/\\n/g, " ")); }
  console.log("PLANT Q4 globals", before, Object.keys(globalThis).slice(before).join(","));
}, 60000);
`,
      js: `import { it } from "vitest";
import { ESLint } from "eslint";
it("Q4 eslint config loader", async () => {
  const linter = new ESLint({ cwd: ${s(repoRoot)}, overrideConfigFile: ${s(SDK_ENTRY)} });
  await linter.lintText("export {};\\n");
}, 60000);
`,
      findings: ["<unpermitted:eslint>", literalFinding(SDK_ENTRY)],
      computed: `import { ESLint } from "eslint";
export const linter = new ESLint({ overrideConfigFile: ${parts(SDK_ENTRY)} });
`,
      computedFindings: ["<unpermitted:eslint>"],
    },
  ];
}

/**
 * `CONTROL-1b` r3 (for `CONTROL1B-R3-J-H1`): the round-3 verifiers' two
 * plants (`reconcile-r3`; `fable-r3-evidence/plants-r3/`). Each reached
 * `createRequire` without spelling it — `getBuiltinModule` and `createRequire`
 * built with `.join("")`, as astra's round-2 plant did — and handed it a
 * LITERAL path to a file no scan read, which held one `require` of the venue
 * SDK: an inert `.md` beside the test, and a `.cjs` outside every scanned tree.
 * Both LOADED the SDK in the repository's unit runner with acceptance 3 green.
 * `ts` is each test file verbatim but for the target it is aimed at (so the
 * same plant can be aimed at an innocuous file); `js` the same, types
 * stripped. Their targets are written at run time ({@link withMirror}).
 */
function roundThreePlant(title: string, tag: string, target: string): { readonly ts: string; readonly js: string } {
  return {
    ts: `import { it } from "vitest";

const word = (...parts: readonly string[]): string => parts.join("");

it(${JSON.stringify(title)}, () => {
  const getBuiltin = (process as unknown as Record<string, (name: string) => unknown>)[word("get", "Builtin", "Module")];
  const api = getBuiltin?.(word("node:", "mod", "ule")) as Record<string, unknown>;
  const make = api[word("create", "Require")] as (anchor: string) => (specifier: string) => unknown;
  const m = make(import.meta.url)(${JSON.stringify(target)}) as Record<string, unknown>;
  console.log("PLANT ${tag} LOADED", Object.keys(m).length, "SigningError", "SigningError" in m);
});
`,
    js: `import { it } from "vitest";

const word = (...parts) => parts.join("");

it(${JSON.stringify(title)}, () => {
  const getBuiltin = process[word("get", "Builtin", "Module")];
  const api = getBuiltin?.(word("node:", "mod", "ule"));
  const make = api[word("create", "Require")];
  const m = make(import.meta.url)(${JSON.stringify(target)});
  console.log("PLANT ${tag} LOADED", Object.keys(m).length, "SigningError", "SigningError" in m);
});
`,
  };
}

const ROUND_THREE_PLANTS = [
  {
    label: "R3 md: an inert .md beside the test",
    stem: "zz-r3-md",
    title: "R3 md: an unnamed loader handed a LITERAL path to an inert file",
    tag: "R3MD",
    target: "./zz-r3-notes.md",
    innocuous: "./zz-r3-innocuous.cjs",
  },
  {
    label: "R3 outside: a .cjs outside every scanned tree",
    stem: "zz-r3-out",
    title: "R3 outside: an unnamed loader handed a LITERAL path to code outside every scanned tree",
    tag: "R3OUT",
    target: "../../zz-r3-outside.cjs",
    innocuous: "../../zz-r3-innocuous-outside.cjs",
  },
] as const;

interface Mirror {
  /** The mirror's root: a scratch directory laid out like the repository, holding none of its files. */
  readonly root: string;
  /** The landing context with the mirror as the repository root (vite's root). */
  readonly context: LandingContext;
  /** `tree`'s place in the mirror. */
  readonly at: (tree: string) => string;
  /** Writes `text` to `file`, creating its directories; returns `file`. */
  readonly write: (file: string, text: string) => string;
  /** One `require` of the venue SDK's entry, by the PATH the plants used, relative to `file`'s directory. */
  readonly requireSdk: (file: string) => string;
  /** That path. */
  readonly sdkFrom: (file: string) => string;
}

/**
 * Runs `body` in a scratch MIRROR of the repository's layout (`CONTROL-1b`
 * r3), so a plant's targets can exist on disk — the judge asks what a loader
 * would find there — without writing into a scanned tree (`infra/**` is
 * outside this grant, and the trees are only ever READ here). Bare packages
 * resolve from it as from the checkout.
 */
async function withMirror(body: (mirror: Mirror) => Promise<void> | void): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "control-1b-r3-mirror-")));
  try {
    symlinkSync(join(repoRoot, NODE_MODULES), join(root, NODE_MODULES));
    const sdk = join(root, "packages", SECURE_DIRECTORY, NODE_MODULES, ...VENUE_SDK.split("/"), "dist", "index.js");
    const pathTo = (from: string): string => {
      const path = relative(from, sdk);
      return path.startsWith(".") ? path : `./${path}`;
    };
    const write = (file: string, text: string): string => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, "utf8");
      return file;
    };
    await body({
      root,
      context: { ...LANDING, repoRoot: root },
      at: (tree) => join(root, relative(repoRoot, tree)),
      write,
      requireSdk: (file) => `module.exports = require(${JSON.stringify(pathTo(dirname(file)))});\n`,
      sdkFrom: (file) => pathTo(dirname(file)),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * `CONTROL-1b` r2 (for `CONTROL1B-R2-J-H1`): a literal OUTSIDE a load, in
 * each form `module-loads.ts` reads, naming a forbidden target. Built from the
 * vocabulary, so this file spells none. `jsx`: only the JSX grammars have it.
 */
function literalForms(): readonly { readonly label: string; readonly text: string; readonly finding: string; readonly jsx?: true }[] {
  const s = (value: string): string => JSON.stringify(value);
  const rest = ["packages", SECURE_DIRECTORY, "package.json"].join("/");
  const hexViem = [...VIEM_NAME].map((c) => `\\x${c.charCodeAt(0).toString(16)}`).join("");
  const percent = R2.anchor.replace(SECURE_DIRECTORY, named("polymarket-%73", "ecure"));
  const backslashed = ["packages", SECURE_DIRECTORY, "package.json"].join("\\");
  const bareEncoded = rest.replace(SECURE_DIRECTORY, named("polymarket-%73", "ecure"));
  const scoped = VENUE_SDK.replace("/", "\\/");
  return [
    { label: "a string: the secure adapter's manifest, by absolute path", text: `export const anchor = ${s(R2.anchor)};\n`, finding: literalFinding(R2.anchor) },
    { label: "a string: the venue SDK, by package name", text: `export const name = ${s(VENUE_SDK)};\n`, finding: literalFinding(VENUE_SDK) },
    { label: "a string: a signing library's subpath", text: `export const name = ${s(`${VIEM_NAME}/accounts`)};\n`, finding: literalFinding(`${VIEM_NAME}/accounts`) },
    { label: "a string: a path into node_modules", text: `export const p = ${s(`./${NODE_MODULES}/innocuous/index.js`)};\n`, finding: literalFinding(`./${NODE_MODULES}/innocuous/index.js`) },
    { label: "a string, percent-encoded", text: `export const anchor = ${s(percent)};\n`, finding: literalFinding(percent) },
    { label: "a string with backslash separators", text: `export const anchor = ${s(backslashed)};\n`, finding: literalFinding(backslashed) },
    // Bare-form paths, read by no loader rule as a path: only the segments name the target.
    { label: "a relative path without ./", text: `export const anchor = ${s(rest)};\n`, finding: literalFinding(rest) },
    { label: "a relative path without ./, percent-encoded", text: `export const anchor = ${s(bareEncoded)};\n`, finding: literalFinding(bareEncoded) },
    { label: "a template's text after a substitution", text: `export const anchor = (base) => \`\${base}/${rest}\`;\n`, finding: literalFinding(`/${rest}`) },
    { label: "a template with no substitution", text: `export const name = \`${VENUE_SDK}\`;\n`, finding: literalFinding(VENUE_SDK) },
    { label: "a template whose escapes evaluate to a name", text: `export const name = \`${hexViem}\`;\n`, finding: literalFinding(VIEM_NAME) },
    // A Windows-style path: the evaluated text drops each backslash (`\p` is `p`), the RAW text keeps them.
    { label: "String.raw: only the RAW text names it", text: `export const anchor = String.raw\`${backslashed}\`;\n`, finding: literalFinding(backslashed) },
    { label: "a regular expression's body", text: `export const source = /${scoped}/.source;\n`, finding: literalFinding(scoped) },
    { label: "a function's name", text: `export function ${VIEM_NAME}() { return 1; }\n`, finding: literalFinding(VIEM_NAME) },
    { label: "an object key", text: `export const o = { ${ETHERS_NAME}: 1 };\n`, finding: literalFinding(ETHERS_NAME) },
    { label: "a string key", text: `export const o = { ${s(VENUE_SDK)}: 1 };\n`, finding: literalFinding(VENUE_SDK) },
    { label: "a private name", text: `export class C { #${WEB3_NAME} = 1; }\n`, finding: literalFinding(WEB3_NAME) },
    { label: "JSX text", text: `export const e = <b>${VIEM_NAME}</b>;\n`, finding: literalFinding(VIEM_NAME), jsx: true },
    { label: "a JSX attribute", text: `export const e = <b title=${s(VENUE_SDK)} />;\n`, finding: literalFinding(VENUE_SDK), jsx: true },
  ];
}

describe("ACCEPTANCE 3: no signer is loaded", () => {
  it("scans a non-trivial number of files (the scan is not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(PRODUCTION_FILES.length).toBeGreaterThan(12);
  });

  it("N-4: the load scan reaches every tree it names (not vacuous per tree)", () => {
    for (const tree of IMPORT_SCAN_TREES) {
      expect(
        IMPORT_SCAN_FILES.filter((path) => path.startsWith(`${tree}/`)).length,
        `${tree} contributes no file to the load scan`,
      ).toBeGreaterThan(0);
    }
    // The suites include THIS file and the dashboards their JSON.
    expect(IMPORT_SCAN_FILES).toContain(resolve(repoRoot, "test/integration/control-api/acceptance-3-no-signer.test.ts"));
    expect(IMPORT_SCAN_FILES).toContain(resolve(repoRoot, "infra/grafana/control/operations-dashboard.json"));
  });

  it("CONTROL-1b r1 (J-H2): EVERY entry of every scanned tree is classified — code, JSON or inert — and nothing else is there", () => {
    for (const [tree, found] of DISCOVERED) {
      expect(found.problems, tree).toEqual([]);
    }
    // Non-vacuity: the inert kinds really occur, and nothing inert is code.
    const inert = [...DISCOVERED.values()].flatMap((found) => found.inert).map((path) => relative(repoRoot, path));
    expect(inert).toContain("infra/grafana/.gitkeep");
    expect(inert).toContain("infra/grafana/control/README.md");
  });

  it("loads NO secure adapter, venue client or signing library, anywhere — and judges every load it finds by where it lands", () => {
    const closure = scanClosure(IMPORT_SCAN_FILES);
    expect(closure.violations).toEqual([]);
    // Non-vacuity: the parser really did read the trees' loads, and the scan
    // really did follow a load out of the trees (this file's import of the
    // repository's unit runner config).
    expect(closure.loads).toBeGreaterThan(200);
    expect(closure.files).toContain(resolve(repoRoot, "test/vitest.config.ts"));
  });

  it("CONTROL-1b r1: a load that lands OUTSIDE every scanned tree and workspace package is scanned in turn — its own loads are judged", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-1b-r1-closure-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, 'import { x } from "./fixture.js";\nexport const y = x;\n', "utf8");
      writeFileSync(join(directory, "fixture.ts"), `import ${JSON.stringify(join(SECURE, "src", "index.js"))};\nexport const x = 1;\n`, "utf8");
      // The entry alone is clean; the fixture it lands on is not.
      expect(violationsIn(entry, read(entry))).toEqual([]);
      const closure = scanClosure([entry]);
      expect(closure.files).toEqual([entry, join(directory, "fixture.ts")]);
      expect(closure.violations).toHaveLength(1);
      expect(closure.violations[0]).toContain("fixture.ts:1 import");
      // A load of a file that does not exist when the scan runs — one a test
      // would WRITE and then load — fails: the scan cannot read what it will hold.
      writeFileSync(entry, 'export const later = () => import("./generated.js");\n', "utf8");
      expect(violationsIn(entry, read(entry))).toEqual([]);
      expect(scanClosure([entry]).violations).toEqual([
        `${relative(repoRoot, entry)} <absent:./generated.js> x1 (not allowlisted)`,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("CONTROL-1b: the allowlist is exact — every entry names a scanned file, a finding it really has, and why", () => {
    for (const entry of LOAD_ALLOWLIST) {
      const path = resolve(repoRoot, entry.file);
      expect(IMPORT_SCAN_FILES, entry.file).toContain(path);
      expect(entry.justification.length, entry.file).toBeGreaterThanOrEqual(40);
      expect(isForbiddenName(entry.finding), entry.finding).toBe(false);
    }
    // The mechanism, on a synthetic file: an entry excuses EXACTLY its count,
    // a wrong count or a stale entry fails, and a forbidden landing is never
    // excused, whatever the allowlist says.
    const path = resolve(repoRoot, "test/integration/control-api/synthetic.ts");
    const text = "const a = await import(x);\nconst b = await import(y);\n";
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
    const forbidden = `${text}import "${FORBIDDEN_PACKAGES[6]}";\n`;
    expect(violationsIn(path, forbidden, [entry(2), entry(1, FORBIDDEN_PACKAGES[6])])).toContain(
      "test/integration/control-api/synthetic.ts:3 import viem",
    );
    const secure = `import ${JSON.stringify(relative(dirname(path), join(SECURE, "src", "index.js")))};\n`;
    expect(violationsIn(path, secure, [entry(1, "<target:x>")])).toHaveLength(2);
  });

  it("CONTROL-1b (R2-J-L1): every spelling of a load is read as its EVALUATED specifier — comments and escapes included", () => {
    for (const specifier of FORBIDDEN_PACKAGES) {
      for (const spelling of plantedSpellings(specifier)) {
        const path = resolve(repoRoot, "test/integration/control-api/planted.ts");
        expect(specifiersIn(spelling.text, path), spelling.text).toContain(specifier);
        expect(violationsIn(path, spelling.text).length, spelling.text).toBeGreaterThan(0);
      }
    }
    // A subpath is a load of the package.
    const subpath = plantedSpellings(`${VIEM_NAME}/accounts`)[0]?.text ?? "";
    expect(violationsIn(resolve(repoRoot, "planted.ts"), subpath)).toEqual([`planted.ts:1 import ${VIEM_NAME}/accounts`]);
    // `CONTROL-1b` r2: a load's specifier is judged ONCE, as a load — not again
    // as a literal (`module-loads.ts`, "Every literal is read too").
    expect(violationsIn(resolve(repoRoot, "planted.ts"), `declare module ${JSON.stringify(VIEM_NAME)} { export const z: number; }\n`)).toEqual([
      `planted.ts:1 declare-module ${VIEM_NAME}`,
    ]);
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

  it("CONTROL-1b (R2-J-L1): a specifier the scan cannot read, a named loader or a parse error FAILS it", () => {
    const path = resolve(repoRoot, "test/integration/control-api/planted.ts");
    for (const specifier of [VIEM_NAME, ETHERS_NAME, SECURE_PACKAGE]) {
      for (const spelling of unreadableSpellings(specifier)) {
        const violations = violationsIn(path, spelling);
        expect(violations.length, spelling).toBeGreaterThan(0);
        // …and not by accident: nothing here names the specifier as a literal.
        expect(specifiersIn(spelling, path), spelling).not.toContain(specifier);
      }
      for (const spelling of [`\\u0069mport("${specifier}");`, `import x from "${specifier}" ((;`, "export * from;"]) {
        // Whatever the parser's recovery read, the file did not parse — fail.
        expect(violationsIn(path, spelling).length, spelling).toBeGreaterThan(0);
        expect(specifiersIn(spelling, path), spelling).toContain(UNPARSEABLE);
      }
    }
    expect(specifiersIn("const r = require;", path)).toEqual([loaderFinding(named("re", "quire"))]);
    expect(specifiersIn("\\u0069mport('x');", path)).toContain(UNPARSEABLE);
  });

  it("CONTROL-1b r1 (J-H1): a load is judged by WHERE IT LANDS — every path, URL and builtin form, in every scanned tree and every code extension", async () => {
    for (const tree of IMPORT_SCAN_TREES) {
      for (const extension of CODE_EXTENSIONS) {
        const importer = join(tree, `planted${extension}`);
        for (const { label, specifier, expect: expected } of landingSpellings(importer)) {
          const load = { kind: "import" as const, specifier, line: 1 };
          expect(judgeLoad(load, importer, LANDING).kind, `${importer}: ${label} (${specifier})`).toBe(expected);
          for (const form of coreForms(specifier)) {
            expect(violationsIn(importer, form).length, `${importer}: ${label}: ${form}`).toBeGreaterThan(0);
          }
        }
      }
      await yieldToLoop();
    }
    // Every spelling of a path load, in one tree: comments and escapes resolve to the path that is judged.
    const importer = resolve(repoRoot, "test/integration/control-api/planted.ts");
    const relSecure = relative(dirname(importer), join(SECURE, "src", "index.js"));
    for (const spelling of plantedSpellings(relSecure)) {
      expect(violationsIn(importer, spelling.text).length, spelling.text).toBeGreaterThan(0);
    }
    // Opus's two round-1 plants, verbatim, from the file he planted them in.
    const plantFile = resolve(repoRoot, "test/integration/control-api/zz-review-plant.test.ts");
    const plants = [
      named('import * as secure from "../../../packages/polymarket-', 'secure/src/index.js";'),
      named('import * as sdk from "../../../packages/polymarket-', "secure/node_", "modules/@polymarket", '/client/dist/index.js";'),
    ];
    for (const plant of plants) {
      expect(violationsIn(plantFile, plant), plant).toEqual([`test/integration/control-api/zz-review-plant.test.ts:1 import ${specifiersIn(plant, plantFile)[0] ?? ""}`]);
    }
  });

  it("CONTROL-1b r1 (J-H1): a symbolic link cannot carry a load past the judge — it is followed to where it lands", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-1b-r1-link-"));
    try {
      symlinkSync(SECURE, join(directory, "innocuous"));
      const importer = join(directory, "planted.ts");
      expect(violationsIn(importer, 'import "./innocuous/src/index.js";\n').length).toBe(1);
      expect(judgeLoad({ kind: "import", specifier: "./innocuous/src/index.js", line: 1 }, importer, LANDING).kind).toBe(
        "forbidden",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("CONTROL-1b r1 (J-H1): a bare name is judged by the package it RESOLVES to — installed under another name, or linked to a signing package", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-1b-r1-bare-"));
    try {
      const importer = join(directory, "planted.ts");
      const judge = (specifier: string): string => judgeLoad({ kind: "import", specifier, line: 1 }, importer, LANDING).kind;
      // An alias install (`"innocuous": "npm:viem"`): the directory's name is innocuous, its package is not.
      mkdirSync(join(directory, "node_modules", "innocuous"), { recursive: true });
      writeFileSync(join(directory, "node_modules", "innocuous", "package.json"), JSON.stringify({ name: named("vi", "em") }), "utf8");
      expect(judge("innocuous")).toBe("forbidden");
      expect(judge("innocuous/accounts")).toBe("forbidden");
      // A link to a directory named like a signing package, whose manifest says nothing.
      mkdirSync(join(directory, "store", named("eth", "ers")), { recursive: true });
      writeFileSync(join(directory, "store", named("eth", "ers"), "package.json"), JSON.stringify({ name: "plain" }), "utf8");
      symlinkSync(join(directory, "store", named("eth", "ers")), join(directory, "node_modules", "plain"));
      expect(judge("plain")).toBe("forbidden");
      // Positive control: an innocuous package, installed as itself, is not
      // forbidden — and loads only where the bare-package list names it
      // (`CONTROL-1b` r2, `CONTROL1B-R2-J-H2`).
      mkdirSync(join(directory, "node_modules", "harmless"), { recursive: true });
      writeFileSync(join(directory, "node_modules", "harmless", "package.json"), JSON.stringify({ name: "harmless" }), "utf8");
      const unlisted = judgeLoad({ kind: "import", specifier: "harmless", line: 1 }, importer, LANDING);
      expect(unlisted.kind === "unreadable" ? unlisted.finding : unlisted.kind).toBe("<unpermitted:harmless>");
      const listed: LandingContext = {
        ...LANDING,
        permittedBare: [{ specifier: "harmless", justification: "a synthetic entry exercising the bare-name judge itself" }],
      };
      expect(judgeLoad({ kind: "import", specifier: "harmless", line: 1 }, importer, listed).kind).toBe("ok");
      // …and the list never excuses a forbidden landing.
      const excused: LandingContext = {
        ...LANDING,
        permittedBare: [{ specifier: "innocuous", justification: "a synthetic entry that must not excuse a signer" }],
      };
      expect(judgeLoad({ kind: "import", specifier: "innocuous", line: 1 }, importer, excused).kind).toBe("forbidden");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("CONTROL-1b r1: the dependency closure follows workspace dependencies to ANY depth", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-1b-r1-closure-deps-"));
    try {
      const make = (name: string, dependencies: Record<string, string>): string => {
        const path = join(directory, name);
        mkdirSync(path);
        writeFileSync(join(path, "package.json"), JSON.stringify({ name, dependencies }), "utf8");
        return path;
      };
      const c = make("c", { [named("vi", "em")]: "2.0.0" });
      const b = make("b", { c: "workspace:*" });
      const a = make("a", { b: "workspace:*", zod: "4.0.0" });
      const workspaces = new Map([
        ["a", a],
        ["b", b],
        ["c", c],
      ]);
      expect(forbiddenDependencyClosure([a], workspaces)).toEqual([`${c}: dependencies ${named("vi", "em")}`]);
      expect(forbiddenDependencyClosure([b], new Map([["b", b]]))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("CONTROL-1b r1 (J-H3): an evaluator or loader reached WITHOUT the spelling round 0 watched fails, in every tree and every code extension", async () => {
    const sdk = SDK_ENTRY;
    for (const tree of IMPORT_SCAN_TREES) {
      for (const extension of CODE_EXTENSIONS) {
        const importer = join(tree, `planted${extension}`);
        for (const spelling of evaluatorSpellings(sdk)) {
          const violations = violationsIn(importer, spelling);
          expect(violations.length, `${importer}: ${spelling}`).toBeGreaterThan(0);
          expect(
            moduleLoadsIn(spelling, importer).some((load) => load.specifier.startsWith("<loader:") || load.kind === "builtin"),
            `${importer}: ${spelling}`,
          ).toBe(true);
        }
      }
      await yieldToLoop();
    }
  });

  it("CONTROL-1b r2 (J-H1): a literal OUTSIDE a load is judged by what it NAMES — every form, in every scanned tree and every code extension", async () => {
    for (const tree of IMPORT_SCAN_TREES) {
      for (const extension of CODE_EXTENSIONS) {
        const importer = join(tree, `planted${extension}`);
        const jsx = extension === ".tsx" || extension === ".jsx";
        for (const form of literalForms()) {
          if (form.jsx === true && !jsx) continue;
          const violations = violationsIn(importer, form.text);
          expect(violations, `${importer}: ${form.label}`).toEqual([`${relative(repoRoot, importer)} ${form.finding} x1 (not allowlisted)`]);
        }
      }
      await yieldToLoop();
    }
    // A symbolic link: the literal names nothing forbidden, the place it reaches does.
    const directory = mkdtempSync(join(tmpdir(), "control-1b-r2-literal-link-"));
    try {
      symlinkSync(SECURE, join(directory, "innocuous"));
      const importer = join(directory, "planted.ts");
      expect(violationsIn(importer, 'export const anchor = "./innocuous/package.json";\n')).toEqual([
        `${relative(repoRoot, importer)} ${literalFinding("./innocuous/package.json")} x1 (not allowlisted)`,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    // JSON: a key and a value.
    const json = resolve(repoRoot, "test/integration/control-api/planted.json");
    expect(violationsIn(json, JSON.stringify({ anchor: R2.anchor, [VENUE_SDK]: 1 }))).toEqual([
      `test/integration/control-api/planted.json ${literalFinding(R2.anchor)} x1 (not allowlisted)`,
      `test/integration/control-api/planted.json ${literalFinding(VENUE_SDK)} x1 (not allowlisted)`,
    ]);
  });

  it("CONTROL-1b r2 (J-H1, J-H2): the round-2 verifiers' five plants FAIL — verbatim, in every scanned tree and every code extension", async () => {
    for (const tree of IMPORT_SCAN_TREES) {
      for (const extension of CODE_EXTENSIONS) {
        const importer = join(tree, `zz-rc-plant${extension}`);
        const typed = [".ts", ".mts", ".cts", ".tsx"].includes(extension);
        for (const plant of roundTwoPlants()) {
          const text = typed ? plant.ts : plant.js;
          const violations = violationsIn(importer, text);
          // Read, not refused as unparseable: each finding is the plant's own.
          expect(violations.some((violation) => violation.includes(UNPARSEABLE)), `${importer}: ${plant.label}`).toBe(false);
          for (const finding of plant.findings) {
            expect(
              violations.some((violation) => violation.includes(` ${finding} `)),
              `${importer}: ${plant.label}: ${finding} in ${JSON.stringify(violations)}`,
            ).toBe(true);
          }
        }
      }
      await yieldToLoop();
    }
  });

  it("CONTROL-1b r3 (J-H1): the round-3 verifiers' two plants FAIL — on disk in a mirror of every scanned tree, in every code extension — and the same plant aimed at an innocuous file passes", async () => {
    await withMirror(async ({ context, at, write, requireSdk, sdkFrom }) => {
      for (const tree of IMPORT_SCAN_TREES) {
        const directory = at(tree);
        for (const plant of ROUND_THREE_PLANTS) {
          const target = write(resolve(directory, plant.target), requireSdk(resolve(directory, plant.target)));
          const innocuous = write(resolve(directory, plant.innocuous), "module.exports = { innocuous: 1 };\n");
          for (const extension of CODE_EXTENSIONS) {
            const typed = [".ts", ".mts", ".cts", ".tsx"].includes(extension);
            const aimed = roundThreePlant(plant.title, plant.tag, plant.target);
            const file = write(join(directory, `${plant.stem}${extension}`), typed ? aimed.ts : aimed.js);
            const closure = scanClosure([file], context);
            const label = `${relative(context.repoRoot, file)}: ${plant.label}`;
            expect(closure.violations.some((violation) => violation.includes(UNPARSEABLE)), label).toBe(false);
            if (plant.target.endsWith(".md")) {
              // (a) A literal path that lands on a file no scan reads as code fails.
              expect(closure.violations, label).toEqual([`${relative(repoRoot, file)} ${landsFinding(plant.target)} x1 (not allowlisted)`]);
            } else {
              // (b) A literal path that lands on code outside every tree is scanned in turn.
              expect(closure.files, label).toContain(target);
              expect(closure.violations, label).toEqual([
                `${relative(repoRoot, target)}:1 ${named("re", "quire")} ${sdkFrom(target)}`,
              ]);
            }
            // The same plant aimed at an innocuous file: the route alone is not what fails.
            const control = roundThreePlant(plant.title, plant.tag, plant.innocuous);
            const controlFile = write(join(directory, `${plant.stem}-control${extension}`), typed ? control.ts : control.js);
            const controlClosure = scanClosure([controlFile], context);
            expect(controlClosure.violations, `${label} (aimed at ${plant.innocuous})`).toEqual([]);
            if (!plant.target.endsWith(".md")) expect(controlClosure.files, label).toContain(innocuous);
          }
        }
        // The .md itself fails discovery wherever code is: a tree that holds
        // code may hold no file the scan does not read (the inert kinds stay
        // only in infra/grafana, which holds none).
        const notes = resolve(directory, ROUND_THREE_PLANTS[0].target);
        const admits = relative(repoRoot, tree) === "infra/grafana";
        expect(discoverTree(tree, directory).problems.some((problem) => problem.startsWith(`${notes}:`)), tree).toBe(!admits);
        expect(discover(directory, true).inert, tree).toContain(notes);
        await yieldToLoop();
      }
    });
  });

  it("CONTROL-1b r3 (J-H1): a literal PATH is judged where a loader handed it would LAND — every route a resolver takes, on disk in a mirror", async () => {
    await withMirror(({ root, context, at, write, requireSdk }) => {
      const here = at(resolve(repoRoot, "test/unit/control-api"));
      const outside = join(root, "test");
      const sdkTarget = (file: string): string => write(file, requireSdk(file));
      // Targets that are not code — the CommonJS loader runs each as JavaScript.
      sdkTarget(join(here, "notes.md"));
      sdkTarget(join(here, "blob"));
      write(join(here, "addon.node"), "");
      sdkTarget(join(outside, "registered.zz"));
      // A link to the READER's working directory: where it lands differs per process.
      const procSelf = ["", "pr" + "oc", "self", "cwd"].join("/");
      symlinkSync(procSelf, join(outside, "cwdlink"));
      // Code outside every tree, each holding a require of the venue SDK.
      const cjs = sdkTarget(join(outside, "outside.cjs"));
      const probed = sdkTarget(join(outside, "probed.js"));
      const main = sdkTarget(join(outside, "pkgdir", "lib", "entry.js"));
      write(join(outside, "pkgdir", "package.json"), JSON.stringify({ main: "lib/entry" }));
      const index = sdkTarget(join(outside, "idxdir", "index.js"));
      const exported = sdkTarget(join(outside, "expdir", "entry.cjs"));
      write(join(outside, "expdir", "package.json"), JSON.stringify({ exports: { ".": { default: "./entry.cjs" } } }));
      const source = sdkTarget(join(outside, "tsdir", "source.ts"));
      // A directory whose manifest entry is a LINK into the secure adapter: the path names nothing, the file it takes does.
      const secureLeaf = write(join(root, "packages", SECURE_DIRECTORY, "src", "leaf.js"), "module.exports = { leaf: 1 };\n");
      mkdirSync(join(outside, "fwd"), { recursive: true });
      symlinkSync(secureLeaf, join(outside, "fwd", "entry.js"));
      write(join(outside, "fwd", "package.json"), JSON.stringify({ main: "entry.js" }));
      // Clean code, inside the tree and outside it.
      write(join(here, "clean.ts"), "export const innocuous = 1;\n");
      const clean = write(join(outside, "clean.cjs"), "module.exports = { innocuous: 1 };\n");

      const backslash = "\\";
      let n = 0;
      const plant = (literal: string, extension = ".ts"): string => {
        n += 1;
        return write(join(here, `planted-${String(n)}${extension}`), extension === ".json" ? `{ "entry": ${literal} }\n` : `export const p = ${literal};\n`);
      };
      const s = JSON.stringify;
      // (a) a literal path that lands on a file no scan reads as code or JSON.
      for (const text of [
        "./notes.md",
        "./notes.md?raw",
        "./blob",
        "./addon.node",
        "./addon",
        // Any extension: CommonJS tries one a program registers at run time.
        "./notes",
        "../../registered",
        // Through /proc, directly or by a link: each runner reads its own working directory there.
        `${procSelf}/test/outside.cjs`,
        "../../cwdlink/test/outside.cjs",
      ]) {
        const file = plant(s(text));
        expect(scanClosure([file], context).violations, text).toEqual([`${relative(repoRoot, file)} ${landsFinding(text)} x1 (not allowlisted)`]);
      }
      // (b) a literal path that lands on code outside every tree — by any
      // route a resolver takes — is scanned in turn, and its require fails.
      const routes: readonly (readonly [string, string, string?])[] = [
        ["code outside every tree", s("../../outside.cjs")],
        ["an extension CommonJS and vite try", s("../../probed"), probed],
        ["a directory's manifest main", s("../../pkgdir"), main],
        ["a directory's index", s("../../idxdir"), index],
        ["a directory's manifest exports", s("../../expdir"), exported],
        ["TypeScript's source for a .js name", s("../../tsdir/source.js"), source],
        ["an absolute path", s(cjs)],
        ["root-relative, as vite reads /x", s("/test/outside.cjs")],
        ["vite's /@fs/ prefix", s(`/@fs${cjs}`)],
        ["a file: URL", s(pathToFileURL(cjs).href)],
        ["percent-encoded", s("../../%6Futside.cjs")],
        ["a template", "`../../outside.cjs`"],
        // Code TEXT an evaluator could run: each string quoted inside a literal, its escapes decoded.
        ["quoted inside code text", s("return import('../../outside.cjs')")],
        ["quoted and escaped inside code text", s(`return import('${backslash}x2e./../outside.cjs')`)],
        ["quoted after a stray apostrophe", s("don't: return import('../../outside.cjs')")],
        ["quoted twice over", s(`return F("return import('../../outside.cjs')")`)],
        ["quoted inside a percent-encoded data: URL", s(`data:text/javascript,export%20*%20from%20%27${pathToFileURL(cjs).href}%27`)],
      ];
      for (const [label, literal, landing = cjs] of routes) {
        const file = plant(literal);
        const closure = scanClosure([file], context);
        expect(closure.files, label).toContain(landing);
        expect(closure.violations.length, `${label}: ${s(closure.violations)}`).toBe(1);
        expect(closure.violations[0]?.startsWith(`${relative(repoRoot, landing)}:1 `), `${label}: ${s(closure.violations)}`).toBe(true);
      }
      // A file a resolver takes from a directory is judged on its REAL path: forbidden.
      const linked = plant(s("../../fwd"));
      expect(scanClosure([linked], context).violations).toEqual([`${relative(repoRoot, linked)} ${literalFinding("../../fwd")} x1 (not allowlisted)`]);
      // …and in JSON.
      const json = plant(s("../../outside.cjs"), ".json");
      expect(scanClosure([json], context).violations).toHaveLength(1);
      // Negative controls: what reaches nothing a resolver takes, code in the
      // tree, and clean code outside it (scanned, and clean) — no finding.
      for (const text of ["/v1/kill-switch", "./nothing-here", "./clean.ts", ".", "..", "../../..", "/", "file:///nonexistent/x.cjs", "the ./notes.md prose"]) {
        expect(scanClosure([plant(s(text))], context).violations, text).toEqual([]);
      }
      const cleanClosure = scanClosure([plant(s("../../clean.cjs"))], context);
      expect(cleanClosure.violations).toEqual([]);
      expect(cleanClosure.files).toContain(clean);
    });
  });

  it("CONTROL-1b r3: a landing inside a workspace package is left to check:deps only where check:deps READS it — and the directories it skips are the tool's own", async () => {
    const tool = read(resolve(repoRoot, "tools/check-dependency-direction.mjs"));
    const skipped = /const SKIPPED_DIRS = new Set\(\[([^\]]*)\]\)/u.exec(tool)?.[1] ?? "";
    expect([...skipped.matchAll(/"([^"]+)"/gu)].map((match) => match[1]).sort()).toEqual([...DEPENDENCY_CHECK_SKIPS].sort());
    expect(tool).toContain("entry.name.startsWith(\".\") || SKIPPED_DIRS.has(entry.name)");
    await withMirror(({ root, context, at, write, requireSdk }) => {
      const workspace = join(root, "packages", "innocuous");
      write(join(workspace, "package.json"), JSON.stringify({ name: "innocuous" }));
      const sdkTarget = (file: string): string => write(file, requireSdk(file));
      const hidden = sdkTarget(join(workspace, ".zz", "evil.cjs"));
      const built = sdkTarget(join(workspace, "dist", "evil.js"));
      const sourced = sdkTarget(join(workspace, "src", "sourced.ts"));
      const importer = write(
        join(at(resolve(repoRoot, "test/unit/control-api")), "planted.ts"),
        [hidden, built, sourced].map((target, index) => `export const p${String(index)} = ${JSON.stringify(target)};\n`).join(""),
      );
      const closure = scanClosure([importer], context, new Map([["innocuous", workspace]]));
      // Under a dot-directory and dist/, check:deps reads nothing: scanned in turn, and each require fails.
      expect(closure.files).toContain(hidden);
      expect(closure.files).toContain(built);
      expect(closure.violations.filter((violation) => violation.includes(`:1 ${named("re", "quire")} `))).toHaveLength(2);
      // Under src/, check:deps reads it (F6, F16): left to it.
      expect(closure.files).not.toContain(sourced);
      // …and the package a LITERAL path lands in is held to its dependency
      // closure, as one a load lands in is: here it declares a signing library.
      write(join(workspace, "package.json"), JSON.stringify({ name: "innocuous", dependencies: { [VIEM_NAME]: "2.0.0" } }));
      const reached = reachedWorkspaces([importer], context);
      expect([...reached]).toEqual([workspace]);
      expect(forbiddenDependencyClosure([...reached], new Map([["innocuous", workspace]]))).toEqual([
        `${workspace}: dependencies ${VIEM_NAME}`,
      ]);
    });
  });

  it("CONTROL-1b r2 (J-H2): each mechanism ALONE — with every target computed, only real loader calls are loads and only listed bare packages load", () => {
    const path = resolve(repoRoot, "test/integration/control-api/zz-rc-plant.ts");
    for (const plant of roundTwoPlants()) {
      if (plant.computed === undefined) continue;
      const violations = violationsIn(path, plant.computed);
      expect(violations.map((violation) => violation.split(" ")[1]).sort(), plant.label).toEqual(
        [...(plant.computedFindings ?? [])].sort(),
      );
    }
    // `.require` read off anything but `module`, or with other than one
    // argument, is a NAMED loader — whoever permits the package it is on.
    const typescriptAnywhere: LandingContext = {
      ...LANDING,
      permittedBare: [
        ...PERMITTED_BARE_SPECIFIERS.filter((entry) => entry.specifier !== "typescript"),
        { specifier: "typescript", justification: "a synthetic entry isolating the require rule" },
      ],
    };
    const q1 = roundTwoPlants().find((plant) => plant.label.includes("Q1"))?.computed ?? "";
    expect(violationsIn(path, q1, [], typescriptAnywhere)).toEqual([
      `test/integration/control-api/zz-rc-plant.ts ${named("<loader:re", "quire>")} x1 (not allowlisted)`,
    ]);
    const req = named("re", "quire");
    const kinds = (text: string): readonly string[] => moduleLoadsIn(text, path).map((load) => `${load.kind}|${load.specifier}`);
    const loader = (name: string): string => `loader|${loaderFinding(name)}`;
    expect(kinds(`${req}("zod");`)).toEqual([`${req}|zod`]);
    expect(kinds(`module.${req}("zod");`)).toEqual([`${req}|zod`]);
    expect(kinds(`module?.${req}?.("zod");`)).toEqual([`${req}|zod`]);
    expect(kinds(`(module.${req})("zod");`)).toEqual([`${req}|zod`]);
    expect(kinds(`${req}("zod", "extra");`)).toEqual([loader(req)]);
    expect(kinds(`${req}();`)).toEqual([loader(req)]);
    expect(kinds(`ts.sys.${req}("/base", "zod");`)).toEqual([loader(req)]);
    expect(kinds(`registry.${req}("event", 1);`)).toEqual([loader(req)]);
    expect(kinds(`globalThis.${req}("zod");`)).toEqual([loader(req)]);
    const builtin = named("getBuiltin", "Module");
    expect(kinds(`process.${builtin}("node:fs");`)).toEqual(["builtin|node:fs"]);
    expect(kinds(`globalThis.process.${builtin}("node:fs");`)).toEqual([loader(builtin)]);
    expect(kinds(`other.${builtin}("node:fs");`)).toEqual([loader(builtin)]);
    expect(kinds(`process.${builtin}("node:fs", 1);`)).toEqual([loader(builtin)]);
    const actual = named("import", "Actual");
    expect(kinds(`await vi.${actual}("zod");`)).toEqual(["vi-load|zod"]);
    expect(kinds(`await vitest.${actual}("zod");`)).toEqual(["vi-load|zod"]);
    expect(kinds(`await other.${actual}("zod");`)).toEqual([loader(actual)]);
    // A spy's own `mock` is not vitest's loader, called or read.
    expect(kinds("spy.mock(1); export const n = spy.mock.calls.length;")).toEqual([]);
  });

  it("CONTROL-1b r2 (J-H2): the bare-package list is EXACT — every package and subpath the trees load, per file where narrow, and nothing else", () => {
    const used = new Map<string, Set<string>>();
    for (const path of scanClosure(IMPORT_SCAN_FILES).files) {
      for (const load of scanFile(path).scanned.loads) {
        const specifier = load.specifier;
        const builtin = specifier.startsWith("node:") || (PERMITTED_BUILTINS as readonly string[]).includes(specifier);
        if (builtin || specifier.startsWith("<") || specifier.startsWith(".") || specifier.startsWith("/")) continue;
        const users = used.get(specifier) ?? new Set<string>();
        users.add(relative(repoRoot, path));
        used.set(specifier, users);
      }
    }
    expect([...used.keys()].sort()).toEqual(PERMITTED_BARE_SPECIFIERS.map((entry) => entry.specifier).sort());
    for (const entry of PERMITTED_BARE_SPECIFIERS) {
      expect(entry.justification.length, entry.specifier).toBeGreaterThanOrEqual(40);
      expect(isForbiddenName(entry.specifier), entry.specifier).toBe(false);
      if (entry.files !== undefined) expect([...(used.get(entry.specifier) ?? [])].sort(), entry.specifier).toEqual([...entry.files].sort());
    }
    // A package — or a subpath — the list does not name fails, wherever it is installed.
    const importer = resolve(repoRoot, "test/integration/control-api/planted.ts");
    const findingOf = (specifier: string, from = importer): string => {
      const verdict = judgeLoad({ kind: "import", specifier, line: 1 }, from, LANDING);
      return verdict.kind === "unreadable" ? verdict.finding : verdict.kind;
    };
    for (const specifier of ["vitest/node", "vitest/execute", "eslint", "esbuild", "vite", "vite-node/client", "zod/v4", "typescript/lib/tsserverlibrary"]) {
      expect(findingOf(specifier), specifier).toBe(`<unpermitted:${specifier}>`);
    }
    // …and a narrow entry holds outside its files.
    expect(findingOf("typescript")).toBe("<unpermitted:typescript>");
    expect(findingOf("typescript", resolve(repoRoot, "test/integration/control-api/support/module-loads.ts"))).toBe("ok");
    expect(findingOf("vitest/config")).toBe("<unpermitted:vitest/config>");
    expect(findingOf("vitest/config", resolve(repoRoot, "test/integration/control-api/vitest.config.ts"))).toBe("ok");
    // `CONTROL-1b` r4: the venue SDK's own packages are names matched EXACTLY —
    // alone or with a subpath, never as a prefix of another name.
    expect(SDK_DEPENDENCY_PACKAGES.length).toBe(3);
    for (const name of SDK_DEPENDENCY_PACKAGES) {
      expect(isForbiddenName(name), name).toBe(true);
      expect(isForbiddenName(`${name}/sub`), name).toBe(true);
      expect(isForbiddenName(`${name}ford`), name).toBe(false);
    }
  });

  it("CONTROL-1b r4: the scan's limits read the same wherever they are stated — best-effort lint, each limit named — the guard's are named where it is described, and no text claims more", () => {
    const normalized = (text: string): string =>
      text
        .replace(/^\s*\*\s?/gmu, "")
        .replace(/\s+/gu, " ")
        .toLowerCase();
    const readme = read(resolve(repoRoot, "apps/control-api/README.md"));
    const section = readme.slice(readme.indexOf('### 3. "No signer is loaded."'), readme.indexOf("## Authentication (§15)"));
    const self = read(resolve(here, "acceptance-3-no-signer.test.ts"));
    const header = self.slice(0, self.indexOf("\nimport {"));
    const scanner = read(resolve(here, "support/module-loads.ts"));
    const judge = read(resolve(here, "support/load-judge.ts"));
    const guard = read(resolve(here, "support/no-signer-guard.ts"));
    const setup = read(resolve(here, "support/no-signer-setup.ts"));
    const vocabulary = read(resolve(here, "support/forbidden-targets.ts"));
    const pins = read(resolve(here, "support/no-signer-runtime-pins.ts"));
    const shipped = read(resolve(here, "acceptance-3-shipped-artifact.test.ts"));
    expect(section.length).toBeGreaterThan(2000);
    // The scan's limits: the same statement, each limit named, in the README,
    // this header, the scanner and the judge.
    for (const [name, text] of [
      ["README", section],
      ["acceptance-3's header", header],
      ["module-loads.ts", scanner],
      ["load-judge.ts", judge],
    ] as const) {
      const said = normalized(text);
      for (const phrase of [
        "best-effort lint",
        "deliberate obfuscation",
        "a loader reached by a computed key, by enumeration or found by value as an evaluator",
        "legacy octal escapes, braced escapes longer than six digits",
        "quoted more than four layers deep",
        "crafted directories and manifests",
        "a manifest whose entry is itself a package directory",
        "resolved against the working directory",
        "a value another module exports, or a file written at run time",
        "copies or hard links of a forbidden file",
        "child processes and worker threads",
        "loader internals",
        "every runner that executes control-api code",
      ]) {
        expect(said, `${name}: ${phrase}`).toContain(phrase);
      }
    }
    // The guard's own limits, where the guard is described; and the unit
    // runner no longer stands outside it.
    for (const [name, text] of [
      ["README", section],
      ["acceptance-3's header", header],
      ["no-signer-guard.ts", guard],
    ] as const) {
      const said = normalized(text);
      for (const phrase of [
        "every runner that executes control-api code",
        "copy or hard link of a forbidden file at a path that names nothing forbidden",
        "code read as text",
        "thread or process",
        "module._extensions[",
        "process.getbuiltinmodule",
      ]) {
        expect(said, `${name}: ${phrase}`).toContain(phrase);
      }
      expect(said, name).not.toContain("stands alone");
      expect(said, name).not.toContain("outside `control-1b`'s grant");
    }
    // The authoritative checks are named as such where the property is stated.
    for (const [name, text] of [
      ["README", section],
      ["acceptance-3's header", header],
      ["acceptance-3-shipped-artifact.test.ts", shipped],
    ] as const) {
      const said = normalized(text);
      expect(said, name).toContain("authoritative");
      expect(said, name).toContain("metafile");
    }
    // No text claims more than the scan or the guard does.
    for (const [name, text] of [
      ["README", section],
      ["acceptance-3's header", header],
      ["module-loads.ts", scanner],
      ["load-judge.ts", judge],
      ["no-signer-guard.ts", guard],
      ["no-signer-setup.ts", setup],
      ["forbidden-targets.ts", vocabulary],
      ["no-signer-runtime-pins.ts", pins],
      ["acceptance-3-shipped-artifact.test.ts", shipped],
    ] as const) {
      const said = normalized(text);
      for (const claim of [
        "however it was spelled",
        "however the loader or the path was spelled",
        "however spelled",
        "regardless of spelling",
        "whatever spelled it",
        "unevadable",
        "closes the literal-path class",
        "the class is closed",
        "class closed",
        "what a static scan cannot see",
      ]) {
        expect(said, `${name}: ${claim}`).not.toContain(claim);
      }
    }
  });

  it("CONTROL-1b r1 (J-H2): each extension is read with ITS grammar — JSX is code in .tsx and .jsx, and a syntax error in .ts", () => {
    const jsx = "const element = <div>{1}</div>;\nexport default element;\n";
    for (const extension of [".tsx", ".jsx"]) {
      const path = resolve(repoRoot, `test/integration/control-api/planted${extension}`);
      expect(violationsIn(path, jsx), extension).toEqual([]);
      expect(violationsIn(path, `${jsx}const m = await import(name);\n`), extension).toEqual([
        `test/integration/control-api/planted${extension} <computed> x1 (not allowlisted)`,
      ]);
    }
    // A load INSIDE or AFTER JSX is read only under a JSX grammar: under the
    // TypeScript grammar each of these loses its load from the syntax tree.
    const v = named("vi", "em");
    for (const extension of [".tsx", ".jsx"]) {
      const path = resolve(repoRoot, `test/integration/control-api/planted${extension}`);
      for (const text of [
        `const element = <div>{require("${v}")}</div>;\n`,
        `const element = <div attr={import("${v}")} />;\n`,
        `const element = <></>;\nconst m = require("${v}");\n`,
        `const element = <div>\n</div>;\nexport * from "${v}";\n`,
      ]) {
        expect(specifiersIn(text, path), `${extension}: ${text}`).toContain(v);
        expect(violationsIn(path, text).length, `${extension}: ${text}`).toBeGreaterThan(0);
      }
    }
    // Under the TypeScript grammar `<div>` is a type assertion, so JSX is a
    // syntax error there. (TypeScript's JavaScript grammar reads JSX in `.js`
    // too — more permissive than the runtime, which refuses it, so a scan that
    // reads it reads more, not less.)
    for (const extension of [".ts", ".mts", ".cts"]) {
      expect(specifiersIn(jsx, resolve(repoRoot, `planted${extension}`)), extension).toContain(UNPARSEABLE);
    }
  });

  it("CONTROL-1b: negative controls — permitted loads, and the words in comments, types or prose, are not reported", () => {
    const path = resolve(repoRoot, "test/integration/control-api/planted.ts");
    for (const spelling of plantedSpellings("@polymarket-bot/observability")) {
      expect(violationsIn(path, spelling.text), spelling.text).toEqual([]);
    }
    // `CONTROL-1b` r2: a literal that IS a forbidden name, or names one as a
    // path segment, is now a finding wherever it sits (the J-H1 literal pins
    // below) — what stays clean is a comment, a type, a name inside prose, and
    // an identifier that merely starts like one.
    for (const clean of [
      'const words = ["the viem library", "ethereal", "@polymarket", "client"]; // import "viem" in a comment\n',
      '/* const m = require("viem"); */ export const required = true;\n',
      'const label = `import("viem")`;\nexport const t = label;\n',
      'type Lib = "web3" | "@polymarket/client";\nexport type L = Lib;\n',
      "export const viemClient = 1;\nexport const ethersLike = 2;\n",
      'export const doc = "packages/observability/src/control";\n',
      "export function call(f: Function): unknown { return f; }\n",
      "type Ctor = typeof Function;\nexport type F = Ctor;\n",
      "interface Callable extends Function { readonly tag: string }\nexport type C = Callable;\n",
      'export const options = { required: ["observability"] };\n',
      'import { readFileSync } from "node:fs";\nimport { join } from "path";\nexport const r = [readFileSync, join];\n',
      'import { describe } from "vitest";\nimport { tmpdir } from "node:os";\nexport const d = [describe, tmpdir];\n',
      'import { serveControlApi } from "./support/client.js";\nexport const s = serveControlApi;\n',
      "const spy = vi.fn(); spy(); export const calls = spy.mock.calls.length;\n",
      'type Kind = "eval" | "constructor";\nexport type K = Kind;\n',
    ]) {
      expect(violationsIn(path, clean), clean).toEqual([]);
    }
    expect(violationsIn(resolve(repoRoot, "planted.json"), '{ "import": "the viem docs", "from": "ethereal" }')).toEqual([]);
  });

  it("CONTROL-1b: a planted load is caught in EVERY scanned tree, in a real file the walk reaches and in every extension", async () => {
    const spellings = plantedSpellings(VIEM_NAME);
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
      await yieldToLoop();
      // A file of EVERY scanned extension in this tree, read with its grammar:
      // a code file names the specifier; JSON cannot hold a load at all.
      for (const extension of SCANNED_EXTENSIONS) {
        const virtual = join(tree, `planted${extension}`);
        for (const spelling of spellings) {
          const loads = specifiersIn(spelling.text, virtual);
          expect(violationsIn(virtual, spelling.text).length, `${virtual}: ${spelling.text}`).toBeGreaterThan(0);
          if (extension === ".json") expect(loads).toEqual([UNPARSEABLE]);
          else if (!spelling.ts || [".ts", ".mts", ".cts", ".tsx"].includes(extension)) {
            expect(loads, spelling.text).toContain(VIEM_NAME);
          }
        }
      }
      await yieldToLoop();
    }
  });

  it("CONTROL-1b r1 (J-H2): the walk reaches a planted file of EVERY extension — .tsx and .jsx included — and every other entry is classified or fails", () => {
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
      // Opus's `.tsx` helper (J-H2), verbatim: a computed import a `.ts` test loaded.
      writeFileSync(
        join(directory, "zz-recon-helper.tsx"),
        'const parts = ["..","..","..","packages","polymarket-secure","src","index.js"];\n' +
          "export const loadSecure = () => import(parts.join(\"/\"));\n",
        "utf8",
      );
      writeFileSync(join(directory, "README.md"), "# inert\n", "utf8");
      writeFileSync(join(directory, ".gitkeep"), "", "utf8");
      writeFileSync(join(directory, "notes.txt"), named("re", "quire", '("viem")'), "utf8");
      writeFileSync(join(directory, "addon.node"), "", "utf8");
      writeFileSync(join(directory, "helper"), named("re", "quire", '("viem")'), "utf8");
      mkdirSync(join(directory, "node_modules", "innocuous"), { recursive: true });
      writeFileSync(join(directory, "node_modules", "innocuous", "index.js"), "export {};\n", "utf8");
      symlinkSync(SECURE, join(directory, "link"));
      // A link that LOOKS like code is still a link: it is not read as if it were the file.
      symlinkSync(join(SECURE, "src", "index.ts"), join(directory, "alias.ts"));

      const found = discover(directory);
      expect(found.code.map((path) => relative(directory, path)).sort()).toEqual(
        [...CODE_EXTENSIONS.map((extension) => `planted${extension}`), "zz-recon-helper.tsx"].sort(),
      );
      expect(found.json.map((path) => relative(directory, path))).toEqual(["planted.json"]);
      expect(found.inert.map((path) => relative(directory, path)).sort()).toEqual([".gitkeep", "README.md"]);
      // `CONTROL-1b` r3: a tree that holds code admits no inert kind at all.
      const strict = discover(directory, false);
      expect(strict.inert).toEqual([]);
      expect(strict.problems.filter((problem) => problem.includes("an inert kind in a tree that holds code")).map((problem) => relative(directory, problem.split(":")[0] ?? "")).sort()).toEqual([
        ".gitkeep",
        "README.md",
      ]);
      expect(found.problems.map((problem) => relative(directory, problem.split(":")[0] ?? "")).sort()).toEqual(
        ["addon.node", "alias.ts", "helper", "link", "node_modules", "notes.txt"],
      );
      expect(found.problems.filter((problem) => problem.includes("a symbolic link"))).toHaveLength(2);
      for (const path of [...found.code, ...found.json]) {
        if (path.endsWith("zz-recon-helper.tsx")) {
          // Two reasons since `CONTROL-1b` r2: the computed import, and the
          // literal naming the secure adapter's directory.
          expect(violationsIn(path, read(path)), path).toEqual([
            `${relative(repoRoot, path)} <computed> x1 (not allowlisted)`,
            `${relative(repoRoot, path)} ${literalFinding(SECURE_DIRECTORY)} x1 (not allowlisted)`,
          ]);
          continue;
        }
        expect(violationsIn(path, read(path)).length, path).toBe(1);
        expect(specifiersIn(read(path), path), path).toEqual(path.endsWith(".json") ? [UNPARSEABLE] : [ETHERS_NAME]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("CONTROL-1b r1: the runners — every vitest config that runs these trees is a CLOSED world, and every alias lands where a load may", () => {
    for (const { file, config, runs } of CONFIGS) {
      expect(unjudgedConfigKeys(config), file).toEqual([]);
      // `CONTROL-1b` r2: the two control-api integration runners install the
      // run-time guard, both halves, exactly.
      if (runs !== undefined) {
        expect(installsNoSignerGuard(config), file).toBe(true);
        const include = ((config as { test?: { include?: unknown } }).test?.include ?? []) as readonly string[];
        expect(include.length, file).toBeGreaterThan(0);
        for (const pattern of include) expect(pattern.startsWith(runs), `${file}: ${pattern}`).toBe(true);
      }
    }
    // Every alias, judged where it lands; and the judge is not vacuous on them.
    expect(LANDING.aliases.length).toBeGreaterThanOrEqual(20);
    for (const alias of LANDING.aliases) {
      expect(judgePaths([alias.replacement], String(alias.find), LANDING).kind, String(alias.find)).toBe("ok");
    }
    // Positive controls: a setup file, a plugin, a custom environment — each named.
    expect(unjudgedConfigKeys({ plugins: [], test: { setupFiles: ["x"], environment: "x", include: [] } })).toEqual([
      "plugins",
      "test.environment",
      "test.setupFiles",
    ]);
    // `CONTROL-1b` r2: the guard's two values are admitted EXACTLY — not a
    // second plugin or setup file beside them, nor a look-alike plugin.
    const guard = noSignerVitePlugin();
    expect(unjudgedConfigKeys({ plugins: [guard], test: { setupFiles: [NO_SIGNER_SETUP_FILE] } })).toEqual([]);
    expect(installsNoSignerGuard({ plugins: [guard], test: { setupFiles: [NO_SIGNER_SETUP_FILE] } })).toBe(true);
    for (const plugins of [[guard, { name: "other" }], [{ ...guard, load: (): undefined => undefined }], [{ ...guard, transform: noSignerLoad }], [{ name: NO_SIGNER_PLUGIN_NAME }]]) {
      expect(unjudgedConfigKeys({ plugins }), JSON.stringify(plugins)).toEqual(["plugins"]);
    }
    for (const setupFiles of [[NO_SIGNER_SETUP_FILE, "x"], ["x"], [`${NO_SIGNER_SETUP_FILE}?x`]]) {
      expect(unjudgedConfigKeys({ test: { setupFiles } }), setupFiles.join()).toEqual(["test.setupFiles"]);
    }
    // A hook vite would read but `Object.keys` would not: non-enumerable, or inherited.
    const hidden = noSignerVitePlugin();
    Object.defineProperty(hidden, "transform", { value: noSignerLoad, enumerable: false });
    const inherited = Object.assign(Object.create({ transform: noSignerLoad }) as object, noSignerVitePlugin());
    for (const plugins of [[hidden], [inherited]]) {
      expect(unjudgedConfigKeys({ plugins })).toEqual(["plugins"]);
    }
    const sneaky = Object.create({ setupFiles: ["x"] }) as object;
    expect(unjudgedConfigKeys({ test: sneaky })).toEqual(["test.<prototype>", "test.setupFiles"]);
    expect(installsNoSignerGuard({ plugins: [guard] })).toBe(false);
    expect(installsNoSignerGuard({ test: { setupFiles: [NO_SIGNER_SETUP_FILE] } })).toBe(false);
    // `CONTROL-1b` r4: an inline project is a closed world too — no extends, no
    // root, no resolve, nothing but the guard's plugin and setup file — and a
    // project named by a config file's path is one this judge does not read.
    expect(unjudgedConfigKeys({ test: { projects: [{ test: { name: "x", include: ["x"], exclude: [] } }] } })).toEqual([]);
    expect(unjudgedConfigKeys({ test: { projects: [{ plugins: [guard], test: { setupFiles: [NO_SIGNER_SETUP_FILE] } }] } })).toEqual([]);
    expect(unjudgedConfigKeys({ test: { projects: ["packages/x/vitest.config.ts"] } })).toEqual(["test.projects[0].<not an inline project>"]);
    expect(unjudgedConfigKeys({ test: { projects: {} } })).toEqual(["test.projects"]);
    expect(
      unjudgedConfigKeys({
        test: {
          projects: [
            { test: { name: "a" } },
            { extends: true, root: "x", resolve: { alias: [] }, plugins: [{ name: "other" }], test: { setupFiles: ["x"], environment: "x", pool: "threads" } },
          ],
        },
      }),
    ).toEqual([
      "test.projects[1].extends",
      "test.projects[1].root",
      "test.projects[1].resolve",
      "test.projects[1].plugins",
      "test.projects[1].resolve.alias",
      "test.projects[1].test.environment",
      "test.projects[1].test.pool",
      "test.projects[1].test.setupFiles",
    ]);
    // …and an alias that maps an innocuous name onto the secure adapter is FORBIDDEN.
    const planted: LandingContext = {
      repoRoot,
      aliases: [...LANDING.aliases, { find: /^innocuous$/u, replacement: join(SECURE, "src", "index.ts") }],
    };
    const importer = resolve(repoRoot, "test/integration/control-api/planted.ts");
    expect(judgeLoad({ kind: "import", specifier: "innocuous", line: 1 }, importer, planted).kind).toBe("forbidden");
    expect(violationsIn(importer, 'import "innocuous";\n', LOAD_ALLOWLIST, planted)).toEqual([
      "test/integration/control-api/planted.ts:1 import innocuous",
    ]);
  });

  it("CONTROL-1b r4: the repository's unit runner runs every control-api test under the guard, in a project of its own — and every other test without it", () => {
    const unit = rootConfig as unknown;
    // The guard is installed per project, never for the whole runner: the
    // secure adapter's own tests load the venue SDK.
    expect(installsNoSignerGuard(unit)).toBe(false);
    const projects = projectsOf(unit);
    expect(projects).toHaveLength(2);
    const testOf = (project: unknown): { name?: unknown; include?: unknown; exclude?: unknown; setupFiles?: unknown } =>
      (project as { test?: { name?: unknown; include?: unknown; exclude?: unknown; setupFiles?: unknown } }).test ?? {};
    const guarded = projects.filter((project) => installsNoSignerGuard(project));
    expect(guarded).toHaveLength(1);
    expect(testOf(guarded[0]).name).toBe("control-api");
    expect(testOf(guarded[0]).include).toEqual([...CONTROL_API_UNIT_TESTS]);
    const others = projects.filter((project) => !installsNoSignerGuard(project));
    expect(others).toHaveLength(1);
    const other = others[0];
    expect((other as { plugins?: unknown }).plugins).toBeUndefined();
    expect(testOf(other).setupFiles).toBeUndefined();
    // The other project runs the repository's unit tests, and none of the control API's.
    expect(testOf(other).include).toEqual(["test/unit/**/*.test.ts", "packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"]);
    for (const glob of CONTROL_API_UNIT_TESTS) expect(testOf(other).exclude as readonly string[], glob).toContain(glob);
    // Non-vacuity: the guarded project's trees hold tests, and its pins are among them.
    for (const pin of ["test/unit/control-api/no-signer-runtime-guard.test.ts", "apps/control-api/src/no-signer-guard.test.ts"]) {
      expect(existsSync(resolve(repoRoot, pin)), pin).toBe(true);
    }
  });

  it("CONTROL-1b r4: no other runner executes control-api code — no other vitest config names it, and no test file outside the guarded trees loads it but one exact, justified entry", () => {
    const configs: string[] = [];
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        if (entry === NODE_MODULES || entry.startsWith(".") || entry === "dist") continue;
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (isRunnerConfig(entry)) configs.push(path);
        else if ((CODE_EXTENSIONS as readonly string[]).includes(extname(entry))) files.push(path);
      }
    };
    for (const top of ["test", "apps", "packages", "tools"]) walk(resolve(repoRoot, top));
    for (const top of readdirSync(repoRoot)) if (isRunnerConfig(top)) configs.push(resolve(repoRoot, top));
    expect(configs.length).toBeGreaterThan(10);
    expect(foreignRunnersOf(configs)).toEqual([]);
    // EXACT, like the scan's allowlist: an entry that no longer matches fails too.
    const outside = files.filter((path) => !GUARDED_TREES.some((tree) => path.startsWith(`${tree}/`)));
    expect(loadsOfControlApi(outside)).toEqual(OUTSIDE_LOADS_OF_CONTROL_API.map((entry) => entry.load));
    for (const entry of OUTSIDE_LOADS_OF_CONTROL_API) expect(entry.justification.length, entry.load).toBeGreaterThanOrEqual(40);
    // Non-vacuity: files outside the trees do mention the control API (in prose).
    expect(outside.filter((path) => read(path).includes("control-api")).length).toBeGreaterThan(OUTSIDE_LOADS_OF_CONTROL_API.length);
    // Positive controls, on disk outside the repository: a runner config that
    // names the control API, and a test that loads it by name or by path.
    const directory = mkdtempSync(join(tmpdir(), "control-1b-r4-runners-"));
    try {
      const config = join(directory, "vitest.config.ts");
      writeFileSync(config, 'export default { test: { include: ["apps/control-api/src/**/*.test.ts"] } };\n', "utf8");
      expect(foreignRunnersOf([config])).toEqual([config]);
      const byName = join(directory, "by-name.test.ts");
      writeFileSync(byName, 'import { EXIT_CODES } from "@polymarket-bot/control-api";\nexport const e = EXIT_CODES;\n', "utf8");
      const byPath = join(directory, "by-path.test.ts");
      const main = relative(directory, resolve(repoRoot, "apps/control-api/src/main.js"));
      writeFileSync(byPath, `export { EXIT_CODES } from ${JSON.stringify(main)};\n`, "utf8");
      const prose = join(directory, "prose.test.ts");
      writeFileSync(prose, "// the control-api README says so\nexport const n = 1;\n", "utf8");
      expect(loadsOfControlApi([byName, byPath, prose]).map((load) => load.split(" ")[1])).toEqual(["@polymarket-bot/control-api", main]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("CONTROL-1b r1: the runners — this package's scripts and its bundle's tsconfig load nothing the scan does not see", () => {
    const manifest = JSON.parse(read(resolve(repoRoot, "apps/control-api/package.json"))) as {
      scripts?: Record<string, string>;
    };
    // EXACT: a build flag (`--inject`, `--alias`, `--banner`) or a runner flag
    // (`--setupFiles`, `--import`, `NODE_OPTIONS`) loads a module no import
    // names, so any change to these is a change this acceptance must judge.
    expect(manifest.scripts).toEqual({
      typecheck: "tsc --noEmit && tsc --noEmit -p ../../test/integration/control-api/tsconfig.json",
      build: "esbuild src/main.ts --bundle --platform=node --format=esm --target=node24 --outfile=dist/main.mjs",
      start: "pnpm run typecheck && pnpm run build && node ./dist/main.mjs",
      "test:integration": "vitest run --config ../../test/integration/control-api/vitest.config.ts",
      "test:integration:postgres": "vitest run --config ../../test/integration/control-api/postgres/vitest.config.ts",
    });
    // esbuild honours tsconfig `paths`: the bundle's tsconfig chain maps no name.
    for (const file of ["apps/control-api/tsconfig.json", "tsconfig.base.json"]) {
      const options = (JSON.parse(read(resolve(repoRoot, file))) as { compilerOptions?: Record<string, unknown> })
        .compilerOptions;
      expect(options?.["paths"], file).toBeUndefined();
      expect(options?.["baseUrl"], file).toBeUndefined();
    }
    expect((JSON.parse(read(resolve(repoRoot, "apps/control-api/tsconfig.json"))) as { extends?: string }).extends).toBe(
      "../../tsconfig.base.json",
    );
  });

  it("CONTROL-1b r1: no workspace package a load — or, since r3, a literal path — LANDS in declares a forbidden dependency, at any depth", () => {
    const workspaces = WORKSPACES;
    expect(workspaces.get(SECURE_PACKAGE)).toBe(SECURE);
    const reached = reachedWorkspaces(IMPORT_SCAN_FILES);
    // Non-vacuity: the aliased trader, the observability package and this one are reached.
    for (const expected of ["apps/trader", "apps/control-api", "packages/observability", "packages/storage-postgres"]) {
      expect([...reached].map((path) => relative(repoRoot, path)), expected).toContain(expected);
    }
    expect(forbiddenDependencyClosure([...reached], workspaces)).toEqual([]);
    // Positive control: the closure does see the secure adapter's venue SDK.
    expect(forbiddenDependencyClosure([SECURE], workspaces).length).toBeGreaterThan(0);
  });

  it("CONTROL-1b: the bare-name layer — no forbidden package name even RESOLVES through node_modules from a scanned tree", () => {
    // Node's lookup for a bare specifier: `node_modules/<package>` in the
    // importing directory and every ancestor. This covers bare NAMES only; a
    // PATH is judged by where it lands (above), and a fully computed name is
    // beyond this acceptance (header, "What this does not prove").
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
      for (const specifier of [...FORBIDDEN_PACKAGES, ...SDK_DEPENDENCY_PACKAGES]) {
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
    expect(declared).not.toContain(SECURE_PACKAGE);
    for (const name of declared) {
      expect(name.toLowerCase(), `${name} looks like a signing dependency`).not.toMatch(
        new RegExp([ETHERS_NAME, VIEM_NAME, WEB3_NAME, "signer", "wallet"].join("|"), "u"),
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
      ].map((relativePath) => resolve(repoRoot, relativePath)),
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
