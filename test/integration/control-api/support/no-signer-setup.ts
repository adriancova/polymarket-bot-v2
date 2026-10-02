/**
 * The Node half of the run-time no-signer guard (`CONTROL-1b` r2;
 * `no-signer-guard.ts` states the whole design): each control-api integration
 * runner names this file as its only setup file, so vitest runs it in the test
 * worker before it imports any test file.
 *
 * It registers ONE synchronous `load` hook with `module.registerHooks`
 * (Node 22.15+/23.5+; this repository runs Node 24). Node runs it for every
 * module LOADED in this thread — through `require`, `createRequire`,
 * `Module._load` and `Module.prototype.load`, ESM `import` and `import()`,
 * `require` of an ES module, and code an evaluator built — after resolution,
 * on the URL actually loaded. A load where `refusedLanding` refuses throws
 * instead: the venue SDK, a signing library and the secure adapter cannot be
 * loaded into this thread however the loader or the path was spelled. It is a
 * LOAD hook, not a resolution hook, because hooks registered later run first:
 * a resolution hook a test registered itself could answer without asking
 * this one, but the load of whatever it named still passes through here
 * (`no-signer-runtime-pins.ts`).
 *
 * The hook is THREAD-local: a `worker_threads` Worker does not inherit it,
 * nor does another process; and Node's loader internals called directly
 * (`Module._extensions[…]`) compile a file without it (`no-signer-guard.ts`,
 * "What it does not see").
 *
 * Vitest runs it before each test file. Where a thread runs more than one,
 * the hook is registered again; a second identical hook refuses exactly what
 * the first does.
 */

import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import { refusal, refusedLanding } from "./no-signer-guard.js";

/** Throws the guard's refusal when `url` is a file `refusedLanding` refuses. */
function refuseUrl(url: string): void {
  if (!url.startsWith("file:")) return;
  const path = fileURLToPath(url);
  const why = refusedLanding(path);
  if (why !== undefined) throw refusal("node", path, why);
}

registerHooks({
  load(url, context, nextLoad) {
    refuseUrl(url);
    return nextLoad(url, context);
  },
});
