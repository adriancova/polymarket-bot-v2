/**
 * The run-time no-signer guard's pins (`CONTROL-1b` r2, closing
 * `CONTROL1B-R2-J-H1` and `CONTROL1B-R2-J-H2` behind the static scan; r3 adds
 * the round-3 routes, an inert file and code outside every tree, written to
 * paths computed at run time), declared once and run by EACH runner that
 * installs the guard:
 * `no-signer-runtime-guard.test.ts` (the integration runner) and
 * `postgres/no-signer-runtime-guard.test.ts` (the PostgreSQL runner).
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

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { FORBIDDEN_PACKAGES, SECURE_DIRECTORY } from "./forbidden-targets.js";
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

function refusedBy(half: "node" | "vite"): RegExp {
  return new RegExp(`${NO_SIGNER_GUARD_TAG} \\(${half}\\): refused`, "u");
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
        const requireOf = (path: string): string => `module.exports = require(${JSON.stringify(path)});\n`;
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
      for (const name of FORBIDDEN_PACKAGES) {
        // As pnpm stores it: `node_modules/.pnpm/<name>@<version>/node_modules/<name>/…`.
        const stored = join(REPO_ROOT, "node_modules", ".pnpm", `${name.replace("/", "+")}@1.0.0`, "node_modules", ...name.split("/"), "index.js");
        expect(refusedLanding(stored), stored).toBeDefined();
      }
      expect(refusedLanding(join(REPO_ROOT, "apps", "control-api", "src", "index.ts"))).toBeUndefined();
      expect(refusedLanding(join(REPO_ROOT, "node_modules", "zod", "index.js"))).toBeUndefined();
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
