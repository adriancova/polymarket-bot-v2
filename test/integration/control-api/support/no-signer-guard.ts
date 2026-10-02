/**
 * The RUN-TIME half of acceptance 3 (`CONTROL-1b` r2, closing
 * `CONTROL1B-R2-J-H1` and `CONTROL1B-R2-J-H2` behind the static scan).
 *
 * ## Why a run-time guard
 *
 * The static scan (`module-loads.ts`, `load-judge.ts`) judges every load a
 * file SPELLS, every literal it holds, and where every literal PATH lands. It
 * cannot judge a load whose loader is reached without spelling its name AND
 * whose target it does not reach from a literal — computed or joined to a base
 * at run time (`module-loads.ts`, "What a static scan cannot see"). The
 * round-2 verifiers loaded the venue SDK into a test worker through
 * a computed `getBuiltinModule`/`createRequire` pair, through `Function` found
 * by enumeration, through `ts.sys.require`, through a private vite server and
 * through ESLint's config loader. The scan now catches each of those plants —
 * but the class behind them is open-ended, so this guard refuses the LANDING
 * itself, whatever spelled it:
 *
 * - **Node's loaders** — `require`, `createRequire`, `Module._load`, ESM
 *   `import` and `import()`, including from code an evaluator built — through
 *   a `module.registerHooks` `load` hook, installed by `no-signer-setup.ts` as
 *   the runner's setup file, in the test worker's thread, before any test
 *   file is imported;
 * - **vitest's own module graph** — every file vite-node transforms for the
 *   worker (`vi.importActual`, `__vite_ssr_dynamic_import__`, a test's own
 *   imports) — through {@link noSignerVitePlugin}'s `load` hook, in the vitest
 *   process.
 *
 * Each refuses a file inside `packages/polymarket-secure`, or on a path whose
 * segments name a forbidden package (`forbidden-targets.ts`) — which is where
 * pnpm keeps every venue SDK and signing library, under its own name. Both
 * control-api integration runners install both halves; acceptance 3 holds
 * each runner's config to exactly them. It judges where a file LIES, by its
 * path, and never what the file holds.
 *
 * ## What it does not see
 *
 * - a COPY or hard link of a forbidden file at a path that names nothing
 *   forbidden (`CONTROL-1b` r3, `CONTROL1B-R3-J-L1`: the round-3 verifiers
 *   copied the venue SDK's `dist/` to a scratch `node_modules/zzsdk`, linked
 *   its dependencies beside it, and loaded it with this guard installed) — the
 *   static scan still fails any literal that names the source, and only a
 *   path computed at run time reaches it;
 * - code READ AS TEXT and handed to an evaluator, or to a load hook a test
 *   registers itself — nothing is resolved or loaded from disk;
 * - a module graph the test builds itself (its own vite server's file reads;
 *   that server's Node-loaded dependencies DO pass through the hook);
 * - another THREAD or process: `registerHooks` hooks are thread-local, so a
 *   `worker_threads` Worker (whose builtin the static scan refuses by name)
 *   or a child process loads without them;
 * - Node's loader internals called directly — `Module._extensions[…]`
 *   compiles a file without running any hook (the static scan refuses
 *   `_extensions` by name, and `node:module` itself);
 * - builtins reached by `process.getBuiltinModule`, which resolves nothing;
 * - the repository's unit runner, `test/vitest.config.ts` (`WP-010`-owned,
 *   outside `CONTROL-1b`'s grant), which runs `apps/control-api/src/**` and
 *   `test/unit/control-api/**` without it: there the static scan stands alone,
 *   and a load in its residual really loads what it reaches.
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

/** The setup file each control-api integration runner installs (acceptance 3 pins it). */
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

/** The plugin each control-api integration runner installs, structurally a vite plugin. */
export interface NoSignerVitePlugin {
  readonly name: string;
  readonly enforce: "pre";
  readonly load: (id: string) => undefined;
}

/** The vite half of the guard (module header). */
export function noSignerVitePlugin(): NoSignerVitePlugin {
  return { name: NO_SIGNER_PLUGIN_NAME, enforce: "pre", load: noSignerLoad };
}
