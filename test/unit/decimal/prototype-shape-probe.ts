/**
 * ONE POLLUTION SHAPE, ONE PROCESS — the child half of
 * `unneutralizable-shapes.test.ts`.
 *
 * WHY A CHILD PROCESS. The shapes this file installs are NON-CONFIGURABLE, which
 * means permanent: nothing can delete or redefine them for the life of the
 * realm. A test file that installed one would corrupt every later file in the
 * same vitest worker, and `WP-020-FU1` review round 1 measured that vitest's own
 * machinery breaks under exactly these shapes — the harness that is supposed to
 * report the failure is itself a victim of it. So each shape gets a process,
 * this file is that process, and the parent asserts on the JSON it prints.
 *
 * It is NOT a `.test.ts` file and vitest does not collect it (`test/vitest
 * .config.ts` includes `test/unit/**\/*.test.ts` only). It is still typechecked
 * and linted, because it is `.ts` under `test/unit`.
 *
 * WHAT IT PRINTS, on one line of stdout:
 *
 * ```text
 * { intrinsic, name, shape, configurable,
 *   clean:     { op -> answer }   measured BEFORE the shape is installed,
 *   polluted:  { op -> answer }   the same operations after,
 *   before/after: the intrinsics' own state, so restoration can be checked }
 * ```
 *
 * The clean run happens in the SAME process, so "byte-identical" is a
 * self-contained claim rather than a comparison against a number typed into a
 * test file.
 *
 * Node runs this file directly: type stripping is native, and the resolve hook
 * below maps the package's `./x.js` specifiers onto the `./x.ts` sources it
 * actually ships (`packages/decimal` has no build step — its `main` is
 * `./src/index.ts`). No bundler and no dependency.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      const parent = context.parentURL;
      if (parent !== undefined && parent.startsWith("file:")) {
        const candidate = new URL(`${specifier.slice(0, -3)}.ts`, parent);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

/** The pollution shapes, by the descriptor each installs. */
export type ProbeShape =
  | "data-writable"
  | "data-readonly"
  | "get-only"
  | "set-only"
  | "get-set";

/** The value a data property or getter answers with. Arbitrary and non-numeric. */
const POLLUTED_VALUE = "9";

interface DecimalApi {
  readonly addDecimal: (a: string, b: string) => string;
  readonly subDecimal: (a: string, b: string) => string;
  readonly mulDecimal: (a: string, b: string) => string;
  readonly divDecimal: (a: string, b: string) => string;
  readonly compareDecimal: (a: string, b: string) => number;
  readonly isZeroDecimal: (a: string) => boolean;
  readonly isTickConformant: (a: string, b: string) => boolean;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE = `${HERE}../../../packages/decimal/src`;

const arithmetic = (await import(`${PACKAGE}/arithmetic.ts`)) as DecimalApi;
const tick = (await import(`${PACKAGE}/tick.ts`)) as DecimalApi;

/**
 * The operations round-1 finding M1 measured, plus the tick gate.
 *
 * Every input is a canonical decimal string this repository produces on its
 * ordinary paths; nothing here is hostile input.
 */
const OPERATIONS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['addDecimal("100","-100")', () => arithmetic.addDecimal("100", "-100")],
  ['addDecimal("1","2")', () => arithmetic.addDecimal("1", "2")],
  ['subDecimal("50","50")', () => arithmetic.subDecimal("50", "50")],
  ['subDecimal("0.3","0.3")', () => arithmetic.subDecimal("0.3", "0.3")],
  ['mulDecimal("2","3")', () => arithmetic.mulDecimal("2", "3")],
  ['mulDecimal("0.37","100")', () => arithmetic.mulDecimal("0.37", "100")],
  ['divDecimal("1","3")', () => arithmetic.divDecimal("1", "3")],
  ['divDecimal("2","4")', () => arithmetic.divDecimal("2", "4")],
  ['compareDecimal("5","4")', () => arithmetic.compareDecimal("5", "4")],
  ['isZeroDecimal("0")', () => arithmetic.isZeroDecimal("0")],
  ['isTickConformant("0.37","0.01")', () => tick.isTickConformant("0.37", "0.01")],
  ['isTickConformant("0.375","0.01")', () => tick.isTickConformant("0.375", "0.01")],
];

/**
 * Runs one operation and renders its outcome as a string.
 *
 * A throw is rendered as `THREW <ClassName>(<code>): <message>` so the parent
 * can tell a typed refusal from an untyped `TypeError` without needing the error
 * object across the process boundary.
 */
function answer(run: () => unknown): string {
  try {
    return `OK ${String(run())}`;
  } catch (error: unknown) {
    const thrown = error as { readonly constructor?: { readonly name?: string } };
    const named = error as { readonly code?: unknown; readonly message?: unknown };
    const className = thrown.constructor?.name ?? "?";
    const code = typeof named.code === "string" ? named.code : "";
    return `THREW ${className}(${code}): ${String(named.message)}`;
  }
}

function runAll(): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [label, run] of OPERATIONS) out[label] = answer(run);
  return out;
}

/**
 * Appends with `CreateDataProperty` semantics.
 *
 * `list[list.length] = x` and `list.push(x)` are both `Set`, and this file runs
 * in a process where `Set` at an index name is the thing that is broken: under a
 * non-configurable set-only accessor at `Array.prototype["0"]` the first append
 * onto an empty array is SILENTLY SWALLOWED, which is how the first draft of
 * this probe reported every descriptor as the empty string. `defineProperty`
 * creates the own property and consults nothing. (The same reasoning, and the
 * same helper, as `packages/decimal/src/prototype-guard.ts`'s `appendData`.)
 */
function appendData(list: string[], value: string): void {
  const descriptor = Object.create(null) as Record<string, unknown>;
  descriptor["value"] = value;
  descriptor["writable"] = true;
  descriptor["enumerable"] = true;
  descriptor["configurable"] = true;
  Object.defineProperty(list, `${list.length}`, descriptor as PropertyDescriptor);
}

/** A JSON-safe rendering of a descriptor, or `"absent"`. */
function describe(target: object, name: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (descriptor === undefined) return "absent";
  const fields: string[] = [];
  for (const field of ["value", "writable", "get", "set", "enumerable", "configurable"]) {
    if (!Object.hasOwn(descriptor, field)) continue;
    const held = (descriptor as unknown as Record<string, unknown>)[field];
    appendData(fields, `${field}=${typeof held === "function" ? "<function>" : String(held)}`);
  }
  let rendered = "";
  for (const field of fields) rendered = rendered === "" ? field : `${rendered} ${field}`;
  return rendered;
}

interface IntrinsicState {
  readonly arrayLength: number;
  readonly onArray: string;
  readonly onObject: string;
}

function snapshot(name: string): IntrinsicState {
  return {
    arrayLength: Array.prototype.length,
    onArray: describe(Array.prototype, name),
    onObject: describe(Object.prototype, name),
  };
}

function install(target: object, name: string, shape: ProbeShape, configurable: boolean): void {
  const descriptor = Object.create(null) as Record<string, unknown>;
  descriptor["enumerable"] = false;
  descriptor["configurable"] = configurable;
  switch (shape) {
    case "data-writable":
      descriptor["value"] = POLLUTED_VALUE;
      descriptor["writable"] = true;
      break;
    case "data-readonly":
      descriptor["value"] = POLLUTED_VALUE;
      descriptor["writable"] = false;
      break;
    case "get-only":
      descriptor["get"] = (): string => POLLUTED_VALUE;
      break;
    case "set-only":
      descriptor["set"] = (): void => undefined;
      break;
    case "get-set":
      descriptor["get"] = (): string => POLLUTED_VALUE;
      descriptor["set"] = (): void => undefined;
      break;
  }
  Object.defineProperty(target, name, descriptor as PropertyDescriptor);
}

const [intrinsic, name, shape, configurableArg] = process.argv.slice(2);
if (intrinsic !== "Array" && intrinsic !== "Object") {
  throw new Error(`intrinsic must be "Array" or "Object", received ${String(intrinsic)}`);
}
if (name === undefined || shape === undefined) {
  throw new Error("usage: prototype-shape-probe.ts <Array|Object> <name> <shape> <configurable>");
}
const configurable = configurableArg === "true";
const target = intrinsic === "Array" ? Array.prototype : Object.prototype;

// The clean measurement comes FIRST, in this same process, so the comparison the
// parent makes is against this build of this library rather than a literal.
const clean = runAll();

install(target, name, shape as ProbeShape, configurable);
const before = snapshot(name);
const polluted = runAll();
const after = snapshot(name);

process.stdout.write(
  `${JSON.stringify({ intrinsic, name, shape, configurable, clean, polluted, before, after })}\n`,
);
