/**
 * Preload for the soak smoke's inherited-`toJSON` pin (`SER-3`): installs ONE of
 * the six measured contexts in the process that loads it, BEFORE that
 * process's own module runs.
 *
 * Used as `node --import <this file> run-soak.mjs` with `SOAK_TOJSON_CONTEXT`
 * naming the context (`Object.prototype/enumerable`, …), so the RUNNER —
 * the process that writes the evidence record — runs polluted, while the
 * gateway it spawns does not (the flag is on the runner's argv, not in
 * `NODE_OPTIONS`). Nothing is restored: the process ends with the window.
 * Test-only; never loaded by anything that ships.
 */

import process from "node:process";

const TARGETS = {
  "Object.prototype": Object.prototype,
  "Array.prototype": Array.prototype,
  "BigInt.prototype": BigInt.prototype,
};

const context = process.env.SOAK_TOJSON_CONTEXT ?? "";
const [targetName, mode] = context.split("/");
const target = TARGETS[targetName];
if (target === undefined || (mode !== "enumerable" && mode !== "non-enumerable")) {
  throw new Error(`SOAK_TOJSON_CONTEXT must name one of the six contexts, got "${context}"`);
}

const injected = () => "INJECTED";
if (mode === "enumerable") {
  target.toJSON = injected;
} else {
  const descriptor = Object.create(null);
  descriptor.value = injected;
  descriptor.enumerable = false;
  descriptor.writable = true;
  descriptor.configurable = true;
  Object.defineProperty(target, "toJSON", descriptor);
}
