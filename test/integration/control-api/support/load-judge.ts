/**
 * Where a module load LANDS, and which files a scan must read
 * (`CONTROL-1b` r1, closing `CONTROL1B-R1-J-H1`, `CONTROL1B-R1-J-H2` and
 * `CONTROL1B-R1-J-L2`) — and, since `CONTROL-1b` r2, what every OTHER literal
 * a scanned file holds names ({@link judgeLiteral}, closing
 * `CONTROL1B-R2-J-H1`), and which bare packages a scanned file may load at all
 * ({@link PERMITTED_BARE_SPECIFIERS}, closing `CONTROL1B-R2-J-H2`).
 *
 * `support/module-loads.ts` reads every load a file spells as its evaluated
 * literal. Round 0 then judged that literal by NAME — a prefix match against
 * the forbidden package names — so a PATH was never judged at all: the
 * round-1 verifiers loaded the secure adapter and the venue SDK into a test
 * worker through `../../../packages/polymarket-secure/src/index.js`,
 * `…/node_modules/@polymarket/client/dist/index.js`, a `file:` URL and a
 * `data:` URL, with acceptance 3 green. This module judges each literal by the
 * file or package it REACHES:
 *
 * | The literal | Judged by |
 * | --- | --- |
 * | `node:x`, or a bare `x` that names a builtin | {@link PERMITTED_BUILTINS} — any other builtin (`node:vm`, `node:module`, `node:child_process`, `node:worker_threads`, …) is UNREADABLE: it exists to load or run code the scan cannot see |
 * | `./…`, `../…`, `/…` | the path it reaches, read BOTH as the CommonJS loader reads it (a literal path) and as the ES loader reads it (a URL: `%2e`, `%70` decoded), each through every symbolic link (`realpath`); one through `/proc` or `/dev` is UNREADABLE (`CONTROL-1b` r3: it lands in a different file for each process) |
 * | `file:…` | the path the URL names, the same way |
 * | `data:`, `http:`, any other scheme, `#imports`, a backslash | UNREADABLE |
 * | a bare package name | the name itself; then EVERY place it can land — each alias of a vitest config that runs a scanned tree, and the package `node_modules` resolution reaches from the importing file, through its symbolic link to its real directory and its `package.json` name. A name neither places is UNREADABLE, and so is a name — package AND subpath — that {@link PERMITTED_BARE_SPECIFIERS} does not list for the importing file (`CONTROL-1b` r2: `vitest/node` and `eslint` are innocuous names whose APIs load any file they are given, and the round-2 verifiers loaded the secure adapter and the venue SDK through each) |
 *
 * A path is FORBIDDEN when it reaches into `packages/polymarket-secure`,
 * passes through a `node_modules` directory (a path import into installed
 * packages goes around every manifest this acceptance reads), or names a
 * forbidden package as path segments. It is UNREADABLE when the file it
 * reaches is not one the scan reads as code or JSON (`.md`, `.node`, `.wasm`,
 * an extensionless file or a directory): the CommonJS loader runs an unknown
 * extension as JavaScript, so such a load runs code no scan has read.
 *
 * ## Discovery is total (`CONTROL1B-R1-J-H2`)
 *
 * {@link discover} reads EVERY entry of a scanned tree. A file is code (one of
 * the grammars `module-loads.ts` has), JSON, or one of the INERT kinds below —
 * and anything else FAILS, as does a symbolic link or a `node_modules`
 * directory inside a scanned tree. Round 0 filtered by extension, so a `.tsx`
 * file was never opened. Since `CONTROL-1b` r3 (`CONTROL1B-R3-J-H1`) an inert
 * kind is admitted only in a tree that holds no code — `infra/grafana` — and
 * FAILS in any other: the CommonJS loader runs a `.md` file as JavaScript, and
 * the round-3 verifiers loaded the venue SDK through one, so a file no scan
 * reads may not sit beside the code that could load it, whether the path to it
 * is a literal or is computed.
 *
 * ## Every other literal (`CONTROL-1b` r2, closing `CONTROL1B-R2-J-H1`)
 *
 * A loader the scan does not name can still be handed a LITERAL target — the
 * round-2 verifiers' plants built `createRequire` from parts and gave it
 * `"…/packages/polymarket-secure/package.json"` and `"@polymarket/client"`.
 * {@link judgeLiteral} judges every literal `module-loads.ts` collects outside
 * a load: it FAILS when the literal, read as a load from the same file, would
 * be FORBIDDEN by the rules above, or when its segments — split on `/` and
 * `\`, as written and percent-decoded — name the secure adapter's directory or
 * a forbidden package. An identifier fails only when it IS a forbidden name.
 *
 * ## A literal PATH is judged where it lands (`CONTROL-1b` r3, closing `CONTROL1B-R3-J-H1`)
 *
 * Round 2 asked of a literal only whether it was FORBIDDEN. The round-3
 * verifiers reached `createRequire` without spelling it and handed it a
 * literal path to a file the scan never reads — an inert `.md` in a scanned
 * tree, which the CommonJS loader runs as JavaScript, and a `.cjs` outside
 * every scanned tree — each of which held a `require` of the venue SDK; it
 * loaded in the repository's unit runner with acceptance 3 green. So every
 * literal with a PATH form (`./`, `../`, `.`, `..`, `/`, `file:`), and every
 * quoted string inside a literal that has one (code text an evaluator could
 * run, its escapes decoded), is resolved the way a loader handed it resolves
 * it ({@link pathReadings}): a relative path against the literal's own file's
 * directory — where `createRequire(import.meta.url)`, `import()` and vitest's
 * loaders resolve it — as written and percent-decoded, its query dropped; an
 * absolute path as itself and under the repository root, which is vite's root
 * in every runner of these trees (vite reads `/x` against its root first, and
 * `/@fs/x` as `/x`); a `file:` URL as its path. A path through `/proc` or
 * `/dev` — itself or by a symbolic link — is `<lands:…>` outright: it names a
 * different file in each process (`/proc/self/cwd` is the reader's working
 * directory), so where the runner would land is not where the scan looks.
 * Every EXISTING file a resolver can take there ({@link filesAt}: the path,
 * the path with ANY extension added — CommonJS also tries one a program
 * registers at run time — TypeScript's source for a `.js` name, a directory's
 * manifest entries and its `index`) is then judged like a load's landing:
 * FORBIDDEN as above (on its real path too); `<lands:…>` when it is not a file
 * this scan reads as code or JSON (inert files included: the CommonJS loader
 * runs any file as JavaScript); otherwise a landing — which
 * `acceptance-3-no-signer.test.ts` scans in turn when it lies outside every
 * scanned tree and every workspace package, as it does for a load's.
 * A path that reaches no existing file reaches nothing a loader could take
 * when the scan runs. What remains is in `module-loads.ts`, "What a static
 * scan cannot see".
 *
 * ## What else decides what a worker loads
 *
 * - **The runners.** A vitest config can load a module no import names — a
 *   setup file, a plugin, a custom environment or runner, pool `execArgv`.
 *   {@link unjudgedConfigKeys} holds each config that runs a scanned tree to a
 *   CLOSED world of keys, and {@link aliasesOf} hands its aliases to the bare
 *   name judge above. Since `CONTROL-1b` r2 the one plugin and the one setup
 *   file a config may name are the run-time no-signer guard's
 *   (`no-signer-guard.ts`), EXACTLY.
 * - **The packages a load lands in.** A load that lands in another workspace
 *   package runs that package's own imports, which no scan of these trees
 *   reads. {@link forbiddenDependencyClosure} reads their manifests instead,
 *   following workspace dependencies to any depth.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FORBIDDEN_PACKAGES,
  SECURE_DIRECTORY,
  isForbiddenName,
  namesForbiddenSegments,
  segmentsOfText,
} from "./forbidden-targets.js";
import { CODE_EXTENSIONS, COMPUTED, UNPARSEABLE, type ModuleLoad, type SourceLiteral } from "./module-loads.js";
import { NO_SIGNER_PLUGIN_NAME, NO_SIGNER_SETUP_FILE, noSignerLoad } from "./no-signer-guard.js";

// The vocabulary lives in `forbidden-targets.ts` (`CONTROL-1b` r2), which the
// run-time guard shares; it is re-exported here for the scan's callers.
export { FORBIDDEN_PACKAGES, SECURE_DIRECTORY, isForbiddenName };

/**
 * The Node builtins a scanned file may load — each one that cannot load or
 * run code. Everything else under `node:` is unreadable (`CONTROL1B-R1-J-L2`:
 * `node:child_process` running `node -e` passed round 0). An ALLOWLIST, so a
 * builtin Node adds later fails until someone judges it here.
 */
export const PERMITTED_BUILTINS = [
  "assert",
  "assert/strict",
  "buffer",
  "crypto",
  "events",
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "os",
  "path",
  "stream",
  "stream/promises",
  "timers",
  "timers/promises",
  "url",
  "util",
  "zlib",
] as const;

/**
 * A bare specifier — package AND subpath, exactly — a scanned file may load
 * (`CONTROL-1b` r2, closing `CONTROL1B-R2-J-H2`). `files`, when present, are
 * the repository-relative files that may; absent, any scanned file may.
 */
export interface PermittedBare {
  readonly specifier: string;
  readonly files?: readonly string[];
  readonly justification: string;
}

const WORKSPACE_JUSTIFICATION =
  "a workspace package: its manifest is held to no forbidden dependency at any depth (the dependency " +
  "closure), and its source to check:deps (F6: the venue SDK only in the secure adapter; F16)";

/**
 * The bare specifiers the scanned trees load, and nothing else — an
 * ALLOWLIST, like {@link PERMITTED_BUILTINS}: a package whose API takes a path
 * and loads it (`vitest/node`'s `createViteServer().ssrLoadModule`, `eslint`'s
 * `overrideConfigFile`, `vite`, `esbuild`) reaches the secure adapter by an
 * ordinary string argument, so a package or subpath this list does not name
 * fails until someone judges it here. `acceptance-3-no-signer.test.ts` holds
 * the list to EXACTLY the specifiers the trees use.
 */
export const PERMITTED_BARE_SPECIFIERS: readonly PermittedBare[] = Object.freeze([
  {
    specifier: "vitest",
    justification:
      "the test runner's API: its module loaders (vi.importActual, importMock, mock, doMock, unmock, doUnmock) are read " +
      "as loads when called off vi or vitest, and any other reference to one is a named loader",
  },
  {
    specifier: "vitest/config",
    files: [
      "test/integration/control-api/vitest.config.ts",
      "test/integration/control-api/postgres/vitest.config.ts",
      "test/vitest.config.ts",
    ],
    justification: "defineConfig and configDefaults, in the three runner configs, each held to a closed world of keys",
  },
  { specifier: "zod", justification: "a schema library: it parses and validates data, and loads no module" },
  {
    specifier: "typescript",
    files: ["test/integration/control-api/support/module-loads.ts"],
    justification:
      "the scan's own parser, used to parse text only; its one module loader, sys.require, is a <loader:require> " +
      "finding wherever it is named",
  },
  ...[
    "@polymarket-bot/control-api",
    "@polymarket-bot/control-api/testing",
    "@polymarket-bot/domain",
    "@polymarket-bot/observability",
    "@polymarket-bot/risk/plain-data",
    "@polymarket-bot/risk/plain-json",
    "@polymarket-bot/risk/schema-arena",
    "@polymarket-bot/storage-postgres",
    "@polymarket-bot/storage-postgres/testing",
    "@polymarket-bot/trader",
  ].map((specifier) => ({ specifier, justification: WORKSPACE_JUSTIFICATION })),
]);

/**
 * Files a scanned tree that holds no code (`infra/grafana`) may hold: no loader
 * runs one unless a load or a literal path names it — and either fails
 * (`<target:…>`, `<lands:…>`). Since `CONTROL-1b` r3 a tree that holds code may
 * hold none ({@link discover}).
 */
export const INERT_EXTENSIONS = [".md"] as const;
export const INERT_BASENAMES = [".gitkeep"] as const;

export type Verdict =
  /** `landings`: the real paths the load can reach (none for a builtin). */
  | { readonly kind: "ok"; readonly landings: readonly string[] }
  | { readonly kind: "forbidden"; readonly why: string }
  | { readonly kind: "unreadable"; readonly finding: string; readonly why: string };

/** One alias a vitest config applies, as vite reads it. */
export interface Alias {
  readonly find: string | RegExp;
  readonly replacement: string;
}

export interface LandingContext {
  readonly repoRoot: string;
  /** Every alias of every vitest config that runs a scanned tree. */
  readonly aliases: readonly Alias[];
  /** The bare specifiers a scanned file may load. Absent: {@link PERMITTED_BARE_SPECIFIERS}. */
  readonly permittedBare?: readonly PermittedBare[];
}

function ok(landings: readonly string[]): Verdict {
  return { kind: "ok", landings: [...new Set(landings)] };
}

function forbidden(why: string): Verdict {
  return { kind: "forbidden", why };
}

function unreadable(finding: string, why: string): Verdict {
  return { kind: "unreadable", finding, why };
}

/** `path` with its longest EXISTING prefix replaced by that prefix's real path. */
function realpathThrough(path: string): string {
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    existing = parent;
  }
  return join(realpathSync(existing), relative(existing, path));
}

function within(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

/**
 * The segments of `path` this judge reads: relative to the repository root
 * when the path is inside it (so where the repository is checked out cannot
 * trip a rule), and the whole path otherwise.
 */
function segmentsOf(path: string, repoRoot: string): readonly string[] {
  const root = realpathThrough(repoRoot);
  const base = within(path, root) ? relative(root, path) : within(path, repoRoot) ? relative(repoRoot, path) : path;
  return base.split(sep).filter((segment) => segment !== "");
}

/**
 * The trees whose paths name a different file in each process that reads them
 * (`/proc/self/cwd` is that process's working directory; `/dev/fd/3` its open
 * file): where a path through one lands, the scan cannot say (`CONTROL-1b` r3).
 */
export const PROCESS_DEPENDENT_ROOTS: readonly string[] = Object.freeze(["/proc", "/dev"]);

function underProcessDependentRoot(path: string): boolean {
  return PROCESS_DEPENDENT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * Whether the absolute `path` — or a symbolic link on the way to it, followed
 * one component at a time — passes through {@link PROCESS_DEPENDENT_ROOTS}. A
 * real path cannot show it: `realpath` of `/proc/self/cwd` is the CALLER's
 * working directory, which is not the runner's that would load it.
 */
export function reachesProcessDependent(path: string): boolean {
  let pending = path.split("/").filter((segment) => segment !== "");
  let current = "/";
  for (let links = 0; pending.length > 0; ) {
    const segment = pending.shift() ?? "";
    const next = segment === ".." ? dirname(current) : segment === "." ? current : join(current, segment);
    if (underProcessDependentRoot(next)) return true;
    let target: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) target = resolve(current, readlinkSync(next));
    } catch {
      // Absent from here on: the rest of the path is read as written.
    }
    if (target === undefined) {
      current = next;
      continue;
    }
    links += 1;
    if (links > 40 || underProcessDependentRoot(target)) return true;
    pending = [...target.split("/").filter((part) => part !== ""), ...pending];
    current = "/";
  }
  return false;
}

/**
 * Judges the files a path-form load can reach: FORBIDDEN through
 * `node_modules`, or through a path naming a signing package or the secure
 * adapter's directory (`packages/polymarket-secure` itself is one) — on the
 * path as spelled and on its real path; then UNREADABLE when it passes through
 * a process-dependent tree (`CONTROL-1b` r3), or when the file is not one the
 * scan reads.
 */
export function judgePaths(candidates: readonly string[], specifier: string, context: LandingContext): Verdict {
  for (const candidate of candidates) {
    for (const path of [candidate, realpathThrough(candidate)]) {
      const segments = segmentsOf(path, context.repoRoot);
      if (segments.includes("node_modules")) {
        return forbidden(`${specifier} reaches into node_modules (${path}), around every manifest`);
      }
      if (namesForbiddenSegments(segments)) {
        return forbidden(`${specifier} reaches the secure adapter or a signing package (${path})`);
      }
    }
  }
  for (const candidate of candidates) {
    if (reachesProcessDependent(candidate)) {
      return unreadable(
        `<target:${specifier}>`,
        `${specifier} passes through ${PROCESS_DEPENDENT_ROOTS.join(" or ")}: where it lands depends on the process that loads it`,
      );
    }
  }
  for (const candidate of candidates) {
    const extension = extname(candidate);
    if (!(CODE_EXTENSIONS as readonly string[]).includes(extension) && extension !== ".json") {
      return unreadable(
        `<target:${specifier}>`,
        `${specifier} reaches ${candidate}, which is not a file this scan reads as code or JSON`,
      );
    }
  }
  return ok(candidates.map(realpathThrough));
}

/** The package a bare specifier names: `@scope/name` or `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** Node's `node_modules` lookup for `name` from `directory` and each ancestor. */
function packageDirectory(directory: string, name: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(candidate)) return candidate;
    if (dirname(current) === current) return undefined;
  }
}

/** Where `specifier` lands through `alias`, or `undefined` when it does not match. */
function throughAlias(specifier: string, alias: Alias): string | undefined {
  if (typeof alias.find === "string") {
    if (specifier === alias.find) return alias.replacement;
    if (specifier.startsWith(`${alias.find}/`)) return `${alias.replacement}${specifier.slice(alias.find.length)}`;
    return undefined;
  }
  alias.find.lastIndex = 0;
  return alias.find.test(specifier) ? specifier.replace(alias.find, alias.replacement) : undefined;
}

function judgeBare(specifier: string, importer: string, context: LandingContext): Verdict {
  if (isForbiddenName(specifier)) return forbidden(`${specifier} names a signing package or the secure adapter`);
  const landings: string[] = [];
  for (const alias of context.aliases) {
    const landing = throughAlias(specifier, alias);
    if (landing === undefined) continue;
    if (!landing.startsWith("/")) {
      return unreadable(`<alias:${specifier}>`, `${specifier} is aliased to ${landing}, which is not an absolute path`);
    }
    landings.push(landing);
  }
  const installed = packageDirectory(dirname(importer), packageNameOf(specifier));
  const reached: string[] = [];
  for (const landing of landings) {
    const verdict = judgePaths([landing], specifier, context);
    if (verdict.kind !== "ok") return verdict;
    reached.push(...verdict.landings);
  }
  if (installed !== undefined) {
    const real = realpathSync(installed);
    const manifest = join(real, "package.json");
    const name = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name : undefined;
    if (typeof name === "string" && isForbiddenName(name)) {
      return forbidden(`${specifier} is installed as the signing package ${name} (${real})`);
    }
    // Past its last `node_modules` the path is the package's own; a
    // workspace package is linked to its directory, `packages/<name>`.
    const segments = segmentsOf(real, context.repoRoot);
    if (namesForbiddenSegments(segments.slice(segments.lastIndexOf("node_modules") + 1))) {
      return forbidden(`${specifier} is installed from the secure adapter or a signing package (${real})`);
    }
    reached.push(real);
  }
  // `CONTROL-1b` r2 (closing `CONTROL1B-R2-J-H2`): nothing forbidden, and
  // still only a package and subpath the list names for this file.
  const file = relative(context.repoRoot, importer);
  const permitted = (context.permittedBare ?? PERMITTED_BARE_SPECIFIERS).find((entry) => entry.specifier === specifier);
  if (permitted === undefined || (permitted.files !== undefined && !permitted.files.includes(file))) {
    return unreadable(
      `<unpermitted:${specifier}>`,
      `${specifier} is not a bare specifier ${file} may load (PERMITTED_BARE_SPECIFIERS): a package's API can load any path it is handed`,
    );
  }
  if (landings.length === 0 && installed === undefined) {
    return unreadable(
      `<unresolved:${specifier}>`,
      `${specifier} resolves through no alias and no node_modules from ${importer}, so the scan cannot say where it lands`,
    );
  }
  return ok(reached);
}

const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;

/**
 * The verdict on one load `importer` spells (module header). A sentinel from
 * `module-loads.ts` — a computed specifier, a named loader, an unparseable
 * file — is UNREADABLE as itself.
 */
export function judgeLoad(load: ModuleLoad, importer: string, context: LandingContext): Verdict {
  const specifier = load.specifier;
  if (specifier === COMPUTED || specifier === UNPARSEABLE || specifier.startsWith("<loader:")) {
    return unreadable(specifier, "the scan cannot read what this loads");
  }
  if (specifier.includes("\\")) {
    return unreadable(`<backslash:${specifier}>`, "a backslash is a path separator to some loaders and not to others");
  }
  const builtin = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  if ((PERMITTED_BUILTINS as readonly string[]).includes(builtin)) return ok([]);
  if (specifier.startsWith("node:")) {
    return unreadable(`<builtin:${specifier}>`, `${specifier} is not a builtin this scan permits; it can load or run code`);
  }
  if (URL_SCHEME.test(specifier)) {
    if (!specifier.toLowerCase().startsWith("file:")) {
      return unreadable(`<url:${specifier.slice(0, 64)}>`, "a URL other than file: loads what no scan can read");
    }
    try {
      return judgePaths([fileURLToPath(new URL(specifier))], specifier, context);
    } catch {
      return unreadable(`<url:${specifier.slice(0, 64)}>`, "a file: URL that names no path");
    }
  }
  if (specifier.startsWith("#")) {
    return unreadable(`<imports-field:${specifier}>`, "a package.json imports-field specifier is mapped outside the scan");
  }
  const relativeForm = specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
  if (relativeForm || specifier.startsWith("/")) {
    const spelled = specifier.replace(/[?#].*$/su, "");
    let asUrl: string;
    try {
      asUrl = fileURLToPath(new URL(specifier, pathToFileURL(importer)));
    } catch {
      return unreadable(`<url-path:${specifier}>`, "the ES loader cannot read this path as a file URL");
    }
    return judgePaths([resolve(dirname(importer), spelled), asUrl], specifier, context);
  }
  return judgeBare(specifier, importer, context);
}

/** Verdicts by literal, per context and importing directory: one file's literals are judged many times. */
const LITERAL_VERDICTS = new WeakMap<LandingContext, Map<string, Verdict>>();

function verdictCache(context: LandingContext): Map<string, Verdict> {
  let verdicts = LITERAL_VERDICTS.get(context);
  if (verdicts === undefined) {
    verdicts = new Map();
    LITERAL_VERDICTS.set(context, verdicts);
  }
  return verdicts;
}

/**
 * TypeScript's source for a compiled name, which vite resolves too: `./x.js`
 * is `./x.ts`. (The extensions a resolver ADDS to a path that names no file —
 * CommonJS `.js`, `.json`, `.node`; vite `.mjs`, `.js`, `.mts`, `.ts`, `.jsx`,
 * `.tsx`, `.json` — need no list: {@link filesAt} takes every extension, since
 * CommonJS also tries one a program registers at run time.)
 */
const SOURCE_SWAPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ".js": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
  ".jsx": [".tsx"],
});

/** The `package.json` fields a resolver takes a directory's entry from: CommonJS `main`; vite `exports`, `module`, `browser`. */
export const MANIFEST_ENTRY_FIELDS: readonly string[] = Object.freeze(["main", "module", "browser", "exports"]);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every string a directory's manifest names as an entry, at any depth of the fields a resolver reads. */
function manifestEntries(directory: string): readonly string[] {
  const manifest = join(directory, "package.json");
  if (!isFile(manifest)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return [];
  }
  const out: string[] = [];
  const leaves = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "object" && value !== null) for (const entry of Object.values(value)) leaves(entry);
  };
  for (const field of MANIFEST_ENTRY_FIELDS) leaves((parsed as Record<string, unknown> | null)?.[field]);
  return out;
}

/** `stem` itself when it is a file, and every file beside it named `<stem>.<any extension>`. */
function filesNamed(stem: string): readonly string[] {
  const out: string[] = [];
  if (isFile(stem)) out.push(stem);
  const directory = dirname(stem);
  const name = basename(stem);
  if (name === "" || directory === stem) return out;
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(`${name}.`) && isFile(join(directory, entry))) out.push(join(directory, entry));
  }
  return out;
}

/**
 * Every EXISTING file a resolver handed `path` can load (module header, "A
 * literal PATH is judged where it lands"): the path itself; the path with ANY
 * extension added (CommonJS tries `.js`, `.json`, `.node` and any extension a
 * program registers at run time; vite its own list); TypeScript's source for a
 * compiled name; and, when the path is a directory, its `index` with any
 * extension and each entry its manifest names (read the same way, one level
 * deep). A directory itself is not a file: what loads from it is.
 */
export function filesAt(path: string, depth = 0): readonly string[] {
  const out: string[] = [...filesNamed(path)];
  const extension = extname(path);
  for (const swap of SOURCE_SWAPS[extension] ?? []) {
    const source = `${path.slice(0, -extension.length)}${swap}`;
    if (isFile(source)) out.push(source);
  }
  if (isDirectory(path)) {
    out.push(...filesNamed(join(path, "index")));
    if (depth === 0) for (const entry of manifestEntries(path)) out.push(...filesAt(resolve(path, entry), depth + 1));
  }
  return [...new Set(out)];
}

/** Whether `text` has a PATH form a loader reads as a path, not as a package name. */
export function hasPathForm(text: string): boolean {
  return (
    text === "." ||
    text === ".." ||
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith("/") ||
    /^file:/iu.test(text)
  );
}

/** One JavaScript string's escapes, resolved: `\x2e`, `\u002e`, `\u{2e}`, the single-character escapes, line continuations. */
export function decodeEscapes(text: string): string {
  const single: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };
  return text.replace(
    /\\(?:x([0-9A-Fa-f]{2})|u\{([0-9A-Fa-f]{1,6})\}|u([0-9A-Fa-f]{4})|(\r\n|[\s\S]))/gu,
    (_match, hex?: string, braced?: string, unicode?: string, other?: string): string => {
      const code = hex ?? braced ?? unicode;
      if (code !== undefined) {
        const point = Number.parseInt(code, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : "";
      }
      if (other === "\n" || other === "\r" || other === "\r\n" || other === "\u2028" || other === "\u2029") return "";
      return single[other ?? ""] ?? other ?? "";
    },
  );
}

/**
 * Every string QUOTED inside `text` — from each `'`, `"` or backtick to the next
 * unescaped one of the same kind, so a stray apostrophe cannot hide one — with
 * its escapes decoded, and those quoted inside it in turn (module header: code
 * text an evaluator could run names its loads this way).
 */
export function quotedStrings(text: string, depth = 0): readonly string[] {
  if (depth > 4) return [];
  const out = new Set<string>();
  for (let open = 0; open < text.length; open += 1) {
    const quote = text[open];
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;
    let close = open + 1;
    while (close < text.length && text[close] !== quote) close += text[close] === "\\" ? 2 : 1;
    if (close >= text.length) continue;
    const inner = decodeEscapes(text.slice(open + 1, close));
    if (inner === "") continue;
    out.add(inner);
    for (const nested of quotedStrings(inner, depth + 1)) out.add(nested);
  }
  return [...out];
}

/**
 * Where a loader handed the path-form `text` from `importer` looks (module
 * header): relative to `importer`'s directory, or — absolute — as itself and
 * under the repository root (vite's root), with vite's `/@fs/` prefix dropped
 * too; each as written, with its query or hash dropped, and percent-decoded; a
 * `file:` URL as the path it names.
 */
export function pathReadings(text: string, importer: string, context: LandingContext): readonly string[] {
  if (/^file:/iu.test(text)) {
    try {
      return [fileURLToPath(new URL(text))];
    } catch {
      return [];
    }
  }
  const forms = new Set<string>([text, text.replace(/[?#].*$/su, "")]);
  for (const form of [...forms]) {
    try {
      forms.add(decodeURIComponent(form));
    } catch {
      // Not percent-encoded: read as written only.
    }
  }
  for (const form of [...forms]) if (form.startsWith("/@fs/")) forms.add(form.slice("/@fs".length));
  const out = new Set<string>();
  for (const form of forms) {
    if (form === "" || form.includes("\0")) continue;
    if (isAbsolute(form)) {
      out.add(resolve(form));
      out.add(join(context.repoRoot, form));
    } else {
      out.add(resolve(dirname(importer), form));
    }
  }
  return [...out];
}

/** The finding a literal path that lands on a file this scan does not read produces: `<lands:"./notes.md">`. */
export function landsFinding(text: string): string {
  return `<lands:${JSON.stringify(text.slice(0, 160))}>`;
}

/** The verdict on one path-form string `importer` holds (module header, "A literal PATH is judged where it lands"). */
function judgePathLiteral(text: string, importer: string, context: LandingContext): Verdict {
  const verdicts = verdictCache(context);
  const key = `path\0${dirname(importer)}\0${text}`;
  const cached = verdicts.get(key);
  if (cached !== undefined) return cached;
  const verdict = ((): Verdict => {
    const readings = pathReadings(text, importer, context);
    const files = readings.flatMap((reading) => filesAt(reading));
    for (const path of [...readings, ...files]) {
      for (const candidate of [path, realpathThrough(path)]) {
        const segments = segmentsOf(candidate, context.repoRoot);
        if (segments.includes("node_modules") || namesForbiddenSegments(segments)) {
          return forbidden(`${text} reaches the secure adapter, a signing package or node_modules (${candidate})`);
        }
      }
    }
    for (const reading of readings) {
      if (reachesProcessDependent(reading)) {
        return unreadable(landsFinding(text), `${text} passes through ${PROCESS_DEPENDENT_ROOTS.join(" or ")}: where it lands depends on the process`);
      }
    }
    for (const file of files) {
      const extension = extname(file);
      if (!(CODE_EXTENSIONS as readonly string[]).includes(extension) && extension !== ".json") {
        return unreadable(landsFinding(text), `${text} reaches ${file}, which is not a file this scan reads as code or JSON`);
      }
    }
    return ok(files.map(realpathThrough));
  })();
  verdicts.set(key, verdict);
  return verdict;
}

/**
 * The verdict on `literal` — one a scanned file holds OUTSIDE a load
 * (`module-loads.ts`, "Every literal is read too"). `CONTROL-1b` r2, closing
 * `CONTROL1B-R2-J-H1` (module header, "Every other literal"):
 *
 * - an IDENTIFIER is FORBIDDEN when it IS a forbidden package's name (`viem`),
 *   since `Function.prototype.name` and `Object.keys` make it a string;
 * - any other literal is FORBIDDEN when its segments — split on `/` and `\`,
 *   as written and percent-decoded — name the secure adapter's directory or a
 *   forbidden package, or when it would be FORBIDDEN as a load from the same
 *   file: a forbidden name or subpath, a path that reaches the secure adapter
 *   (through a symbolic link too) or passes through `node_modules`, a bare
 *   name installed as a signing package.
 *
 * `CONTROL-1b` r3, closing `CONTROL1B-R3-J-H1` (module header, "A literal PATH
 * is judged where it lands"): the literal, and each string quoted inside it,
 * that has a path form is then judged where it LANDS — FORBIDDEN, or
 * UNREADABLE as `<lands:…>` when an existing file a resolver can take there is
 * not code or JSON; otherwise its `landings` are the code and JSON files it
 * reaches, for the caller to scan in turn. Whether the literal as a whole would
 * be UNREADABLE as a load is still not asked: most literals are no specifier at
 * all, and a path that reaches no file loads nothing.
 */
export function judgeLiteral(literal: SourceLiteral, importer: string, context: LandingContext): Verdict {
  const text = literal.text;
  if (literal.kind === "identifier") {
    return namesForbiddenSegments([text]) ? forbidden(`the name ${text} is a forbidden package's`) : ok([]);
  }
  const readings = [text];
  try {
    const decoded = decodeURIComponent(text);
    if (decoded !== text) readings.push(decoded);
  } catch {
    // Not percent-encoded text: read as written only.
  }
  for (const reading of readings) {
    if (namesForbiddenSegments(segmentsOfText(reading))) {
      return forbidden(`its segments name the secure adapter or a signing package (${reading.slice(0, 120)})`);
    }
  }
  const verdicts = verdictCache(context);
  const key = `${dirname(importer)}\0${text}`;
  let asLoad = verdicts.get(key);
  if (asLoad === undefined) {
    asLoad = judgeLoad({ kind: "import", specifier: text, line: literal.line }, importer, context);
    verdicts.set(key, asLoad);
  }
  if (asLoad.kind === "forbidden") return asLoad;
  const landings: string[] = [];
  let lands: Verdict | undefined;
  // Each string quoted inside the literal — and inside its percent-decoded
  // reading, as a `data:` URL holds code — is code text an evaluator could run.
  const quoted = new Set([text, ...readings.flatMap((reading) => quotedStrings(reading))]);
  for (const path of [...quoted].filter(hasPathForm)) {
    const verdict = judgePathLiteral(path, importer, context);
    if (verdict.kind === "forbidden") return verdict;
    if (verdict.kind === "unreadable") lands ??= verdict;
    else landings.push(...verdict.landings);
  }
  return lands ?? ok(landings);
}

/** The finding a literal naming a forbidden target produces: `<names:"viem">`. */
export function literalFinding(text: string): string {
  return `<names:${JSON.stringify(text)}>`;
}

export interface Discovery {
  /** Files read with a code grammar. */
  readonly code: readonly string[];
  readonly json: readonly string[];
  /** Files of an inert kind: read by no loader unless a load names them, and such a load fails. */
  readonly inert: readonly string[];
  /** Everything a scan cannot classify: each FAILS. */
  readonly problems: readonly string[];
}

/**
 * Every entry of `tree`, classified (module header, "Discovery is total").
 * `admitsInert`: whether the tree may hold the inert kinds at all — only a
 * tree that holds no code may (`CONTROL-1b` r3); in any other an inert file
 * is a problem.
 */
export function discover(tree: string, admitsInert = true): Discovery {
  const code: string[] = [];
  const json: string[] = [];
  const inert: string[] = [];
  const problems: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        problems.push(`${path}: a symbolic link in a scanned tree (it could point the scan, or a load, anywhere)`);
      } else if (stat.isDirectory()) {
        if (entry === "node_modules") problems.push(`${path}: a node_modules directory inside a scanned tree`);
        else walk(path);
      } else if ((CODE_EXTENSIONS as readonly string[]).includes(extname(entry))) {
        code.push(path);
      } else if (extname(entry) === ".json") {
        json.push(path);
      } else if (
        (INERT_EXTENSIONS as readonly string[]).includes(extname(entry)) ||
        (INERT_BASENAMES as readonly string[]).includes(basename(entry))
      ) {
        if (admitsInert) inert.push(path);
        else {
          problems.push(
            `${path}: an inert kind in a tree that holds code (the CommonJS loader runs any file as JavaScript, and no scan reads this one)`,
          );
        }
      } else {
        problems.push(`${path}: a file the scan cannot classify (not code, JSON, or an inert kind)`);
      }
    }
  };
  walk(tree);
  return { code, json, inert, problems };
}

/**
 * The keys a vitest config that runs a scanned tree may set — a CLOSED world:
 * `setupFiles`, `globalSetup`, `plugins`, `environment`, a custom `runner`,
 * pool `execArgv` and the rest can each load a module no import names, so a
 * key outside this list fails until someone judges it here. `plugins` and
 * `test.setupFiles` are in it only with the run-time no-signer guard's values,
 * EXACTLY ({@link installsNoSignerGuard}; `CONTROL-1b` r2): any other value of
 * either is an unjudged key.
 */
export const VITEST_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "": ["resolve", "test", "plugins"],
  resolve: ["alias"],
  test: ["root", "setupFiles", "include", "exclude", "testTimeout", "hookTimeout", "passWithNoTests"],
});

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * EVERY own key of `value` — non-enumerable and symbol keys included, since
 * vite reads a hook by property access — and `<prototype>` when `value`
 * inherits from anything but a plain object, whose keys vite would read too.
 */
function ownKeysOf(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null) return [];
  const prototype = Object.getPrototypeOf(value) as unknown;
  const keys = Reflect.ownKeys(value).map((key) => String(key));
  return prototype === Object.prototype || prototype === null ? keys : [...keys, "<prototype>"];
}

/** Whether `plugins` is exactly `[noSignerVitePlugin()]`: one plain plugin, its three keys, the guard's own `load`. */
function isGuardPlugins(plugins: unknown): boolean {
  if (!Array.isArray(plugins) || plugins.length !== 1) return false;
  const plugin = recordOf(plugins[0]);
  return (
    [...ownKeysOf(plugins[0])].sort().join(",") === "enforce,load,name" &&
    plugin["name"] === NO_SIGNER_PLUGIN_NAME &&
    plugin["enforce"] === "pre" &&
    plugin["load"] === noSignerLoad
  );
}

/** Whether `setupFiles` is exactly `[NO_SIGNER_SETUP_FILE]`. */
function isGuardSetup(setupFiles: unknown): boolean {
  return Array.isArray(setupFiles) && setupFiles.length === 1 && setupFiles[0] === NO_SIGNER_SETUP_FILE;
}

/** Every key path of `config` outside {@link VITEST_CONFIG_KEYS}, or holding a value it does not admit. */
export function unjudgedConfigKeys(config: unknown): readonly string[] {
  const out: string[] = [];
  const top = recordOf(config);
  for (const key of ownKeysOf(config)) {
    if (!(VITEST_CONFIG_KEYS[""] ?? []).includes(key)) out.push(key);
  }
  if ("plugins" in top && !isGuardPlugins(top["plugins"])) out.push("plugins");
  for (const section of ["resolve", "test"]) {
    for (const key of ownKeysOf(top[section])) {
      if (!(VITEST_CONFIG_KEYS[section] ?? []).includes(key)) out.push(`${section}.${key}`);
    }
  }
  const test = recordOf(top["test"]);
  if ("setupFiles" in test && !isGuardSetup(test["setupFiles"])) out.push("test.setupFiles");
  return out;
}

/** Whether `config` installs BOTH halves of the run-time no-signer guard, exactly (`no-signer-guard.ts`). */
export function installsNoSignerGuard(config: unknown): boolean {
  const top = recordOf(config);
  return isGuardPlugins(top["plugins"]) && isGuardSetup(recordOf(top["test"])["setupFiles"]);
}

/** The aliases a vitest config applies, as {@link Alias} entries (vite accepts an array or an object). */
export function aliasesOf(config: unknown): readonly Alias[] {
  const resolveSection = (config as { resolve?: { alias?: unknown } } | undefined)?.resolve;
  const alias = resolveSection?.alias;
  if (alias === undefined) return [];
  if (Array.isArray(alias)) {
    return alias.map((entry: unknown) => {
      const { find, replacement } = entry as { find: unknown; replacement: unknown };
      if ((typeof find !== "string" && !(find instanceof RegExp)) || typeof replacement !== "string") {
        throw new TypeError(`an alias the scan cannot read: ${String(find)}`);
      }
      return { find, replacement };
    });
  }
  return Object.entries(alias as Record<string, unknown>).map(([find, replacement]) => {
    if (typeof replacement !== "string") throw new TypeError(`an alias the scan cannot read: ${find}`);
    return { find, replacement };
  });
}

/**
 * The package directory `path` is, or sits in — its nearest `package.json`
 * strictly below the repository root — or `undefined` (a file under `test/`).
 */
export function workspacePackageOf(path: string, repoRoot: string): string | undefined {
  const root = realpathThrough(repoRoot);
  for (let directory = path; within(directory, root) && directory !== root; directory = dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) return directory;
  }
  return undefined;
}

/**
 * Every forbidden dependency DECLARED, at any depth, by the workspace packages
 * in `start` and the workspace packages they depend on (`dependencies`,
 * `optionalDependencies`, `peerDependencies`) — a load that lands in a
 * workspace package runs that package's own imports, which no scan of these
 * trees reads (module header). `workspaces` maps each workspace package name
 * to its directory.
 */
export function forbiddenDependencyClosure(
  start: readonly string[],
  workspaces: ReadonlyMap<string, string>,
): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const directory = queue.shift() ?? "";
    if (seen.has(directory)) continue;
    seen.add(directory);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const declared = manifest[field];
      if (typeof declared !== "object" || declared === null) continue;
      for (const name of Object.keys(declared)) {
        if (isForbiddenName(name)) found.push(`${directory}: ${field} ${name}`);
        const workspace = workspaces.get(name);
        if (workspace !== undefined) queue.push(workspace);
      }
    }
  }
  return found;
}
