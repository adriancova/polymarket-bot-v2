/**
 * The run-time no-signer guard's pins (`CONTROL-1b` r2; r3 adds the round-3
 * routes, an inert file and code outside every tree; r4 the round-4 routes —
 * a directory landing, nested manifests, exotic escapes in evaluated code
 * text, a working-directory load), declared once and run by EACH runner that
 * executes control-api code, all of which install the guard:
 * `no-signer-runtime-guard.test.ts` (the integration runner),
 * `postgres/no-signer-runtime-guard.test.ts` (the PostgreSQL runner) and,
 * since `CONTROL-1b` r4, `test/unit/control-api/no-signer-runtime-guard.test.ts`
 * (the repository's unit runner, its `control-api` project).
 *
 * Every attempt below is written the way the static scan CANNOT read — the
 * residual `module-loads.ts` states: each loader is reached without spelling
 * its name (a computed key, or an evaluator found by enumerating the function
 * prototype, as the round-2 verifiers did), and each target is computed from
 * the scan's own vocabulary. So the scan passes this file by construction, and
 * these pins prove that the GUARD refuses what the scan cannot see. Each
 * refusal must carry the guard's own tag and name the half that refused, so a
 * load that failed for another reason cannot pass for one. Each route also
 * loads an innocuous target, so the guard refuses the landing, not the route.
 *
 * If the guard is not installed, these attempts really load the venue SDK or
 * the secure adapter into this worker — and fail.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { FORBIDDEN_PACKAGES, SDK_DEPENDENCY_PACKAGES, SECURE_DIRECTORY } from "./forbidden-targets.js";
import { NO_SIGNER_GUARD_TAG, noSignerLoad, refusedLanding } from "./no-signer-guard.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SECURE = join(REPO_ROOT, "packages", SECURE_DIRECTORY);
const VENUE_SDK = FORBIDDEN_PACKAGES[1];
/** The venue SDK's entry, by PATH, through the secure adapter's own `node_modules`. */
const VENUE_SDK_ENTRY = join(SECURE, "node_modules", ...VENUE_SDK.split("/"), "dist", "index.js");
/** A secure-adapter source file that imports nothing forbidden, so only the guard can refuse it. */
const SECURE_LEAF = join(SECURE, "src", "errors.ts");

/** A name built at run time, so the scan reads no loader name here (its residual). */
const word = (...parts: readonly string[]): string => parts.join("");

type Loader = (specifier: string) => unknown;

/** Node's module API, reached through a COMPUTED builtin loader name and a computed id. */
function moduleApi(): Record<string, unknown> {
  const builtin = (process as unknown as Record<string, Loader>)[word("get", "Builtin", "Module")];
  const api = builtin?.(word("node:", "mod", "ule")) as Record<string, unknown> | undefined;
  if (api === undefined) throw new Error("the module API is not reachable — the pin is vacuous");
  return api;
}

/** A module factory reached through two COMPUTED names (astra's round-2 technique). */
function factoryAt(anchor: string): Loader {
  const make = moduleApi()[word("create", "Req", "uire")] as ((anchor: string) => Loader) | undefined;
  if (make === undefined) throw new Error("the factory is not reachable — the pin is vacuous");
  return make(anchor);
}

/** The evaluator found by ENUMERATING the function prototype, no name spelled (Opus's round-2 Q3). */
function evaluator(): (...source: string[]) => (argument: string) => unknown {
  const prototype = Object.getPrototypeOf(() => 0) as object;
  const found = Object.values(Object.getOwnPropertyDescriptors(prototype))
    .map((descriptor) => descriptor.value as unknown)
    .find((value) => typeof value === "function" && (value as { prototype?: unknown }).prototype === prototype);
  if (found === undefined) throw new Error("the evaluator is not reachable — the pin is vacuous");
  return found as (...source: string[]) => (argument: string) => unknown;
}

/** vitest's own module loader, read off `vi` by a computed key. */
function viteLoader(): (path: string) => Promise<unknown> {
  const loader = (vi as unknown as Record<string, (path: string) => Promise<unknown>>)[word("import", "Act", "ual")];
  if (loader === undefined) throw new Error("vitest's loader is not reachable — the pin is vacuous");
  return loader.bind(vi);
}

function refusedBy(half: "node" | "vite" | "either"): RegExp {
  return new RegExp(`${NO_SIGNER_GUARD_TAG} \\(${half === "either" ? "(?:node|vite)" : half}\\): refused`, "u");
}

/** One `require` of `path`, as a CommonJS module's whole text. */
const requireOf = (path: string): string => `module.exports = require(${JSON.stringify(path)});\n`;

/** Each character of `text` as a three-digit LEGACY OCTAL escape (`\057`), which sloppy-mode code decodes. */
const octalEscaped = (text: string): string => [...text].map((c) => `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`).join("");

/** Each character of `text` as an eight-digit braced unicode escape (`\u{0000002f}`), which strict code decodes too. */
const bracedEscaped = (text: string): string => [...text].map((c) => `\\u{${c.charCodeAt(0).toString(16).padStart(8, "0")}}`).join("");

/** `body` wrapped `layers` times in an evaluator call: code text quoted inside code text. */
function nested(body: string, layers: number): string {
  let code = body;
  for (let layer = 0; layer < layers; layer += 1) code = `return ${word("Func", "tion")}(${JSON.stringify(code)})()`;
  return code;
}

/** Declares the guard's pins in the calling test file. */
export function pinNoSignerGuard(runner: string): void {
  describe(`CONTROL-1b r2: the run-time no-signer guard is installed in the ${runner} runner`, () => {
    it("Node's loaders: a factory reached by COMPUTED names refuses the venue SDK by name and by path — and still loads an innocuous package", () => {
      const secureFactory = factoryAt(join(SECURE, "package.json"));
      expect(() => secureFactory(VENUE_SDK)).toThrow(refusedBy("node"));
      expect(() => factoryAt(import.meta.url)(VENUE_SDK_ENTRY)).toThrow(refusedBy("node"));
      // Positive control: the same route, an innocuous landing.
      const zod = factoryAt(join(REPO_ROOT, "apps", "control-api", "package.json"))("zod") as Record<string, unknown>;
      expect(typeof zod["object"]).toBe("function");
    });

    it("an evaluator found by ENUMERATION (Opus's Q3), whose body builds the factory by computed names: the venue SDK is refused", () => {
      const run = evaluator()("p", "return process['getBuilt' + 'inModule']('node:mod' + 'ule')['create' + 'Require'](p)(p)");
      expect(() => run(VENUE_SDK_ENTRY)).toThrow(refusedBy("node"));
      // Node 24 requires an ES module, types stripped: without the guard this LOADS the secure adapter's source.
      expect(() => run(SECURE_LEAF)).toThrow(refusedBy("node"));
      // Positive control: an innocuous file, through the same evaluator.
      expect(run(join(REPO_ROOT, "test", "integration", "control-api", "support", "forbidden-targets.ts"))).toMatchObject({
        SECURE_DIRECTORY,
      });
    });

    it("a native ES import(), from a module written at run time and loaded through the factory: refused for the SDK and the secure adapter", async () => {
      const directory = mkdtempSync(join(tmpdir(), "control-1b-r2-guard-"));
      try {
        const helper = join(directory, "helper.mjs");
        writeFileSync(helper, "export const load = (url) => import(url);\nexport const innocuous = 1;\n", "utf8");
        const { load } = factoryAt(import.meta.url)(helper) as { load: (url: string) => Promise<unknown> };
        await expect(load(pathToFileURL(VENUE_SDK_ENTRY).href)).rejects.toThrow(refusedBy("node"));
        await expect(load(pathToFileURL(SECURE_LEAF).href)).rejects.toThrow(refusedBy("node"));
        // Positive control: the same native import of an innocuous module.
        await expect(load(pathToFileURL(helper).href)).resolves.toMatchObject({ innocuous: 1 });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("CONTROL-1b r3: the round-3 routes — a factory reached by COMPUTED names, handed an INERT file or code OUTSIDE every tree whose own require lands on the venue SDK — are refused; the same files holding innocuous code load", () => {
      const directory = mkdtempSync(join(tmpdir(), "control-1b-r3-guard-"));
      try {
        // Written at run time, their paths and contents computed: the static
        // scan's residual (`module-loads.ts`), which only this guard sees.
        const notes = join(directory, word("notes", ".md"));
        const outside = join(directory, word("outside", ".cjs"));
        writeFileSync(notes, requireOf(VENUE_SDK_ENTRY), "utf8");
        writeFileSync(outside, requireOf(VENUE_SDK_ENTRY), "utf8");
        expect(() => factoryAt(import.meta.url)(notes)).toThrow(refusedBy("node"));
        expect(() => factoryAt(import.meta.url)(outside)).toThrow(refusedBy("node"));
        // Positive control: the same route and the same kinds of file, innocuous code.
        const innocuousNotes = join(directory, word("innocuous", ".md"));
        const innocuousOutside = join(directory, word("innocuous", ".cjs"));
        writeFileSync(innocuousNotes, "module.exports = { innocuous: 1 };\n", "utf8");
        writeFileSync(innocuousOutside, "module.exports = { innocuous: 2 };\n", "utf8");
        expect(factoryAt(import.meta.url)(innocuousNotes)).toEqual({ innocuous: 1 });
        expect(factoryAt(import.meta.url)(innocuousOutside)).toEqual({ innocuous: 2 });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("CONTROL-1b r4 (R4-J-H1): a DIRECTORY named like code, whose manifest names its entry, is refused at the venue SDK that entry loads — and the same shape holding innocuous code loads", () => {
      const directory = mkdtempSync(join(tmpdir(), "control-1b-r4-guard-dir-"));
      try {
        // astra's round-4 plant, its paths computed: `zz.cjs/` is a directory, `{"main":"entry.cjs"}`.
        const plant = (name: string, entry: string): string => {
          const path = join(directory, name);
          mkdirSync(path);
          writeFileSync(join(path, "package.json"), JSON.stringify({ main: "entry.cjs" }), "utf8");
          writeFileSync(join(path, "entry.cjs"), entry, "utf8");
          return path;
        };
        expect(() => factoryAt(import.meta.url)(plant(word("zz", ".cjs"), requireOf(VENUE_SDK_ENTRY)))).toThrow(refusedBy("node"));
        // A manifest whose entry lies IN the secure adapter: refused at the entry itself.
        const into = join(directory, "into");
        mkdirSync(into);
        writeFileSync(join(into, "package.json"), JSON.stringify({ main: relative(into, SECURE_LEAF) }), "utf8");
        expect(() => factoryAt(import.meta.url)(into)).toThrow(refusedBy("node"));
        // Positive control: the same shape, innocuous code.
        expect(factoryAt(import.meta.url)(plant(word("ok", ".cjs"), "module.exports = { innocuous: 1 };\n"))).toEqual({ innocuous: 1 });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("CONTROL-1b r4 (R4-J-H3): a directory whose manifest names a NESTED package directory — which vite follows, and Node's CommonJS loader does not — is refused at the venue SDK its entry loads, and the same shape holding innocuous code loads", async () => {
      const directory = mkdtempSync(join(tmpdir(), "control-1b-r4-guard-nest-"));
      try {
        // Opus's round-4 plant, its paths computed: `ndir/` → `{"main":"inner"}`, `inner/` → `{"main":"entry.mjs"}`.
        const plant = (name: string, entry: string): string => {
          const path = join(directory, name);
          mkdirSync(join(path, "inner"), { recursive: true });
          writeFileSync(join(path, "package.json"), JSON.stringify({ main: "inner" }), "utf8");
          writeFileSync(join(path, "inner", "package.json"), JSON.stringify({ main: "entry.mjs" }), "utf8");
          writeFileSync(join(path, "inner", "entry.mjs"), entry, "utf8");
          return path;
        };
        const sdk = plant("ndir", `export * from ${JSON.stringify(pathToFileURL(VENUE_SDK_ENTRY).href)};\n`);
        await expect(viteLoader()(sdk)).rejects.toThrow(refusedBy("either"));
        // Three levels: each manifest is followed by the resolver, and the guard judges only where the load LANDS.
        const deeper = join(directory, "deeper");
        mkdirSync(deeper);
        writeFileSync(join(deeper, "package.json"), JSON.stringify({ main: "../ndir" }), "utf8");
        await expect(viteLoader()(deeper)).rejects.toThrow(refusedBy("either"));
        // Positive control: the same shape, innocuous code.
        const innocuous = plant("okdir", "export const innocuous = 2;\n");
        await expect(viteLoader()(innocuous)).resolves.toMatchObject({ innocuous: 2 });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("CONTROL-1b r4 (R4-J-H2): code TEXT an evaluator found by ENUMERATION runs, its path spelled in legacy octal escapes, in long braced escapes, or quoted five layers deep, is refused at the venue SDK it reaches — and the same text aimed at innocuous code loads", () => {
      const directory = mkdtempSync(join(tmpdir(), "control-1b-r4-guard-text-"));
      try {
        const target = join(directory, word("zz", ".cjs"));
        const innocuous = join(directory, word("ok", ".cjs"));
        writeFileSync(target, requireOf(VENUE_SDK_ENTRY), "utf8");
        writeFileSync(innocuous, "module.exports = { innocuous: 3 };\n", "utf8");
        // The factory, built inside the evaluated text by computed names (Opus's round-4 plants).
        const factory = "process.getBuiltinModule('node:mod' + 'ule')['create' + 'Require'](u)";
        const routes = [
          { label: "legacy octal", body: (path: string): string => `return ${factory}('${octalEscaped(path)}')` },
          { label: "long braced, strict", body: (path: string): string => `'use strict'; return ${factory}('${bracedEscaped(path)}')` },
        ];
        for (const { label, body } of routes) {
          expect(() => evaluator()("u", body(target))(import.meta.url), label).toThrow(refusedBy("node"));
          expect(evaluator()("u", body(innocuous))(import.meta.url), label).toEqual({ innocuous: 3 });
        }
        const deep = (path: string): unknown =>
          ((evaluator()(nested(`return (u) => ${factory}(${JSON.stringify(path)})`, 5)) as unknown as () => (u: string) => unknown)())(
            import.meta.url,
          );
        expect(() => deep(target)).toThrow(refusedBy("node"));
        expect(deep(innocuous)).toEqual({ innocuous: 3 });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("CONTROL-1b r4 (R4-J-I1): Node's loader internals, reached by COMPUTED names with no parent, resolve a relative path against the WORKING directory — and are refused at the venue SDK it reaches; the same route to innocuous code loads", () => {
      const directory = mkdtempSync(join(tmpdir(), "control-1b-r4-guard-cwd-"));
      try {
        const load = moduleApi()[word("_", "lo", "ad")] as ((request: string, parent: null) => unknown) | undefined;
        if (load === undefined) throw new Error("the loader internals are not reachable — the pin is vacuous");
        const fromWorkingDirectory = (path: string): string => {
          const path2 = relative(process.cwd(), path);
          return path2.startsWith(".") ? path2 : `./${path2}`;
        };
        const target = join(directory, word("zz", ".cjs"));
        const innocuous = join(directory, word("ok", ".cjs"));
        writeFileSync(target, requireOf(VENUE_SDK_ENTRY), "utf8");
        writeFileSync(innocuous, "module.exports = { innocuous: 4 };\n", "utf8");
        expect(() => load(fromWorkingDirectory(target), null)).toThrow(refusedBy("node"));
        expect(load(fromWorkingDirectory(innocuous), null)).toEqual({ innocuous: 4 });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("a resolution hook a test registers ITSELF answers before the guard's — and the LOAD of what it named is still refused", () => {
      type Next = (specifier: string, context: unknown) => unknown;
      const register = moduleApi()[word("register", "Hooks")] as ((hooks: object) => { deregister(): void }) | undefined;
      if (register === undefined) throw new Error("the hook registry is not reachable — the pin is vacuous");
      const target = pathToFileURL(SECURE_LEAF).href;
      const innocuous = pathToFileURL(join(REPO_ROOT, "test", "integration", "control-api", "support", "forbidden-targets.ts")).href;
      const handle = register({
        resolve: (specifier: string, context: unknown, next: Next): unknown =>
          specifier === "innocuous-short-circuit"
            ? { url: target, shortCircuit: true }
            : specifier === "innocuous-control"
              ? { url: innocuous, shortCircuit: true }
              : next(specifier, context),
      });
      try {
        // The secure adapter's leaf imports nothing forbidden: only the LOAD hook can refuse it.
        expect(() => factoryAt(import.meta.url)("innocuous-short-circuit")).toThrow(refusedBy("node"));
        // Positive control: the same short-circuit to an innocuous file loads.
        expect(factoryAt(import.meta.url)("innocuous-control")).toMatchObject({ SECURE_DIRECTORY });
      } finally {
        handle.deregister();
      }
    });

    it("vitest's own module graph: a loader read off vi by a COMPUTED key refuses the secure adapter's source — and loads an innocuous file", async () => {
      const load = viteLoader();
      await expect(load(SECURE_LEAF)).rejects.toThrow(refusedBy("vite"));
      const innocuous = (await load(join(REPO_ROOT, "test", "integration", "control-api", "support", "forbidden-targets.ts"))) as {
        FORBIDDEN_PACKAGES?: unknown;
      };
      expect(innocuous.FORBIDDEN_PACKAGES).toEqual(FORBIDDEN_PACKAGES);
    });

    it("the landing rule: the secure adapter, every forbidden package's store path, and a symbolic link into either — and nothing else", () => {
      expect(refusedLanding(SECURE_LEAF)).toBeDefined();
      expect(refusedLanding(VENUE_SDK_ENTRY)).toBeDefined();
      for (const name of [...FORBIDDEN_PACKAGES, ...SDK_DEPENDENCY_PACKAGES]) {
        // As pnpm stores it: `node_modules/.pnpm/<name>@<version>/node_modules/<name>/…`.
        const stored = join(REPO_ROOT, "node_modules", ".pnpm", `${name.replace("/", "+")}@1.0.0`, "node_modules", ...name.split("/"), "index.js");
        expect(refusedLanding(stored), stored).toBeDefined();
      }
      expect(refusedLanding(join(REPO_ROOT, "apps", "control-api", "src", "index.ts"))).toBeUndefined();
      expect(refusedLanding(join(REPO_ROOT, "node_modules", "zod", "index.js"))).toBeUndefined();
      // `CONTROL-1b` r4: the venue SDK's own packages, spelled from parts so this pin does not lean on the list…
      for (const name of [word("o", "x"), word("@polymarket/", "bind", "ings"), word("@polymarket/", "ty", "pes")]) {
        const stored = join(REPO_ROOT, "node_modules", ".pnpm", `${name.replace("/", "+")}@1.0.0`, "node_modules", ...name.split("/"), "index.js");
        expect(refusedLanding(stored), stored).toBeDefined();
      }
      // …matched EXACTLY: a package whose name only begins like one loads.
      expect(refusedLanding(join(REPO_ROOT, "node_modules", word("o", "xford"), "index.js"))).toBeUndefined();
      expect(refusedLanding(join(REPO_ROOT, "node_modules", "@polymarket", word("types", "cript"), "index.js"))).toBeUndefined();
      const directory = mkdtempSync(join(tmpdir(), "control-1b-r2-guard-link-"));
      try {
        symlinkSync(SECURE, join(directory, "innocuous"));
        expect(refusedLanding(join(directory, "innocuous", "src", "errors.ts"))).toBeDefined();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("the vite half's load hook: refuses a forbidden file with or without a query, and leaves every other id to vite", () => {
      expect(() => noSignerLoad(SECURE_LEAF)).toThrow(refusedBy("vite"));
      expect(() => noSignerLoad(`${SECURE_LEAF}?raw`)).toThrow(refusedBy("vite"));
      expect(noSignerLoad(join(REPO_ROOT, "apps", "control-api", "src", "index.ts"))).toBeUndefined();
      expect(noSignerLoad("\0virtual:innocuous")).toBeUndefined();
    });
  });
}
