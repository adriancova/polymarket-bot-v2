/**
 * `CONTROL-1b` r4: this package's own tests run under the run-time no-signer
 * guard. The repository's unit runner (`test/vitest.config.ts`) runs
 * `src/**\/*.test.ts` in its `control-api` project, which installs the guard's
 * one vite plugin and one setup file
 * (`test/integration/control-api/support/no-signer-guard.ts`); this file
 * proves it from inside the tree that project covers. A load of the venue SDK
 * and of the secure adapter's source is refused, by each half of the guard,
 * and the same routes load innocuous code.
 *
 * It cannot import the guard's shared pins (`check:deps` F16: no relative
 * import leaves this package), so it reaches each loader the way those pins
 * do — by COMPUTED names, with targets computed from parts. That is the form
 * the test-tree scan cannot read, and only the guard sees: without it, these
 * loads really load the SDK into this worker.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/** A name built at run time, so no loader name or forbidden target is spelled here. */
const word = (...parts: readonly string[]): string => parts.join("");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const SECURE = join(REPO_ROOT, "packages", word("polymarket-", "sec", "ure"));
/** The venue SDK's entry, by PATH, through the secure adapter's own `node_modules`. */
const SDK_ENTRY = join(SECURE, word("node_", "modules"), "@polymarket", word("cli", "ent"), "dist", "index.js");
/** A secure-adapter source file that imports nothing forbidden, so only the guard can refuse it. */
const SECURE_LEAF = join(SECURE, "src", "errors.ts");

const refusedBy = (half: "node" | "vite"): RegExp => new RegExp(`control-api no-signer guard \\(${half}\\): refused`, "u");

type Loader = (specifier: string) => unknown;

/** Node's module factory, reached through computed names. */
function factoryAt(anchor: string): Loader {
  const builtin = (process as unknown as Record<string, Loader>)[word("get", "Builtin", "Module")];
  const api = builtin?.(word("node:", "mod", "ule")) as Record<string, unknown> | undefined;
  const make = api?.[word("create", "Req", "uire")] as ((anchor: string) => Loader) | undefined;
  if (make === undefined) throw new Error("the module factory is not reachable — the pin is vacuous");
  return make(anchor);
}

/** vitest's own module loader, read off `vi` by a computed key. */
function viteLoader(): (path: string) => Promise<unknown> {
  const loader = (vi as unknown as Record<string, ((path: string) => Promise<unknown>) | undefined>)[word("import", "Act", "ual")];
  if (loader === undefined) throw new Error("vitest's loader is not reachable — the pin is vacuous");
  return loader.bind(vi);
}

describe("CONTROL-1b r4: apps/control-api/src runs under the run-time no-signer guard", () => {
  it("Node's half: the venue SDK, by path and through the secure adapter's own resolution, is refused — and an innocuous package loads by the same route", () => {
    expect(() => factoryAt(import.meta.url)(SDK_ENTRY)).toThrow(refusedBy("node"));
    expect(() => factoryAt(join(SECURE, "package.json"))(word("@polymarket/", "cli", "ent"))).toThrow(refusedBy("node"));
    const zod = factoryAt(join(HERE, "..", "package.json"))("zod") as Record<string, unknown>;
    expect(typeof zod["object"]).toBe("function");
  });

  it("vite's half: the secure adapter's source is refused — and an innocuous source file of this package loads by the same route", async () => {
    await expect(viteLoader()(SECURE_LEAF)).rejects.toThrow(refusedBy("vite"));
    await expect(viteLoader()(join(HERE, "instance-id.ts"))).resolves.toBeDefined();
  });
});
