/**
 * The RUN-TIME guard of acceptance 3 (`CONTROL-1b` r2; since r4 one of its two
 * AUTHORITATIVE checks, with the shipped bundle's metafile and the
 * production-source rule in `acceptance-3-shipped-artifact.test.ts`). It is
 * installed in EVERY runner that executes control-api code: the repository's
 * unit runner (`test/vitest.config.ts`, its `control-api` project, which runs
 * `apps/control-api/src/**\/*.test.ts` and `test/unit/control-api/**\/*.test.ts`)
 * and both control-api integration runners. Acceptance 3 holds each config to
 * exactly its two halves, and the unit runner to exactly its two projects: the
 * other one runs every other package's tests without it, since
 * `packages/polymarket-secure`'s own tests load the venue SDK.
 *
 * ## Why a run-time guard
 *
 * The test-tree scan (`module-loads.ts`, `load-judge.ts`) is best-effort lint:
 * it judges the loads and literals a file spells, and an author who
 * obfuscates on purpose can reach a loader, and a target, it does not read —
 * each round of `CONTROL-1b` found another way. This guard refuses the
 * LANDING itself, whichever route reached it:
 *
 * - **Node's loaders** — `require`, `createRequire`, `Module._load`, ESM
 *   `import` and `import()`, including from code an evaluator built — through
 *   a `module.registerHooks` `load` hook, installed by `no-signer-setup.ts` as
 *   the runner's setup file, in the test worker's thread, before any test
 *   file is imported. It runs AFTER resolution, on the file actually loaded:
 *   a directory has already become its entry, every manifest has been
 *   followed, and the escapes and nesting of whatever text named the path
 *   have been evaluated away;
 * - **vitest's own module graph** — every file vite-node transforms for the
 *   worker (`vi.importActual`, `__vite_ssr_dynamic_import__`, a test's own
 *   imports) — through {@link noSignerVitePlugin}'s `load` hook, in the vitest
 *   process.
 *
 * Each refuses a file inside `packages/polymarket-secure`, or on a path whose
 * segments name a forbidden package (`forbidden-targets.ts`) — which is where
 * pnpm keeps every venue SDK and signing library, under its own name. It
 * judges where a file LIES, by its path and its real path, and never what the
 * file holds.
 *
 * ## What it does not see
 *
 * - a COPY or hard link of a forbidden file at a path that names nothing
 *   forbidden (`CONTROL-1b` r3, `CONTROL1B-R3-J-L1`: the round-3 verifiers
 *   copied the venue SDK's `dist/` to a scratch `node_modules/zzsdk`, linked
 *   its dependencies beside it, and loaded it with this guard installed);
 * - code READ AS TEXT and handed to an evaluator, or to a load hook a test
 *   registers itself — nothing is resolved or loaded from disk;
 * - a module graph the test builds itself (its own vite server's file reads;
 *   that server's Node-loaded dependencies DO pass through the hook);
 * - another THREAD or process: `registerHooks` hooks are thread-local, so a
 *   `worker_threads` Worker or a child process loads without them;
 * - Node's loader internals that run no hook — `Module._extensions[…]`
 *   compiles a file without one;
 * - builtins reached by `process.getBuiltinModule`, which resolves nothing.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { namesForbiddenSegments } from "./forbidden-targets.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Every refusal names this, so a test can tell the guard's refusal from any other failure. */
export const NO_SIGNER_GUARD_TAG = "control-api no-signer guard";

/** The vite plugin's name, which acceptance 3 holds each runner's `plugins` to. */
export const NO_SIGNER_PLUGIN_NAME = "control-api-no-signer-guard";

/** The setup file each runner that executes control-api code installs (acceptance 3 pins it). */
export const NO_SIGNER_SETUP_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "no-signer-setup.ts");

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
 * Why a load that lands on the absolute file `path` is refused, or
 * `undefined`: its segments name the secure adapter's directory
 * (`packages/polymarket-secure`) or a forbidden package (pnpm stores each
 * under its own name). Read on the path as given AND on its real path, each
 * relative to the repository root when inside it (so where the repository is
 * checked out cannot trip a rule) and whole otherwise.
 */
export function refusedLanding(path: string): string | undefined {
  const root = realpathThrough(REPO_ROOT);
  for (const candidate of [path, realpathThrough(path)]) {
    const base = within(candidate, root) ? relative(root, candidate) : within(candidate, REPO_ROOT) ? relative(REPO_ROOT, candidate) : candidate;
    if (namesForbiddenSegments(base.split(sep))) return "its path names the secure adapter or a signing package";
  }
  return undefined;
}

/** The error a refused landing raises: it names the guard, the half that refused, and the path. */
export function refusal(half: "node" | "vite", path: string, why: string): Error {
  return new Error(`${NO_SIGNER_GUARD_TAG} (${half}): refused ${path}: ${why}`);
}

/**
 * The `load` hook of {@link noSignerVitePlugin}: refuses a file vite would load
 * for the test worker when {@link refusedLanding} does, and otherwise leaves
 * the load to vite. Exported so acceptance 3 can hold a runner's plugin to
 * exactly this function.
 */
export function noSignerLoad(id: string): undefined {
  // Only a file path is a file on disk: a virtual module (`\0…`) is not. A
  // query (`?raw`) only ever follows the file's own segments.
  if (!id.startsWith("/")) return undefined;
  const why = refusedLanding(id);
  if (why !== undefined) throw refusal("vite", id, why);
  return undefined;
}

/** The plugin each runner that executes control-api code installs, structurally a vite plugin. */
export interface NoSignerVitePlugin {
  readonly name: string;
  readonly enforce: "pre";
  readonly load: (id: string) => undefined;
}

/** The vite half of the guard (module header). */
export function noSignerVitePlugin(): NoSignerVitePlugin {
  return { name: NO_SIGNER_PLUGIN_NAME, enforce: "pre", load: noSignerLoad };
}
