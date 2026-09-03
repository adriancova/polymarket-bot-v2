/**
 * The boundary surface, RESOLVED from the module graph (remediation round 5,
 * 2026-09-03; supersedes round 4's syntactic scan, which this file used to
 * contain).
 *
 * The lesson, twice. Review round 4 found that a hand-written table of entry
 * points was already incomplete when it was written. Round 4 answered with a
 * mechanical scan of the two entry-point FILES. Review round 5 then found the
 * same defect one level up: a scan that pattern-matches AST nodes cannot see a
 * module's actual EXPORTS. `Object.entries` was to property enumeration what
 * that scan was to the module graph, and the fix is the same both times — move
 * to the layer that resolves. The enumeration now comes from a `ts.Program` and
 * its type checker (`boundary-derivation.ts`); this file is the CLASSIFICATION
 * and the behavioral cross-check.
 *
 * What round 5 reproduced against round 4's oracle before any change, and what
 * the derivation must therefore now do (each row is a permanent test in
 * `boundary-shapes.test.ts`):
 *
 * ```
 * function f(){}; export { f };  + a barrel re-export → 0 entries, 7/7 passed  → now PUBLIC
 * export const api = { method(v) {...} }              → 0 entries, 7/7 passed  → now enumerated
 * export class C { run = (v) => ... }                 → 0 entries, 7/7 passed  → now enumerated
 * export class C { get x() {} set x(v) {} }           → 0 entries, 7/7 passed  → now BOTH enumerated
 * export * from "./m.js"                              → PACKAGE (wrong)        → now PUBLIC
 * export function f(v, label = "root") in index.ts    → PACKAGE (wrong)        → now PUBLIC
 * ```
 *
 * The last row is the one that mattered most: round 4 claimed a new boundary
 * "fails this file until someone classifies it". It did fail — but the oracle
 * called a genuinely public function PACKAGE, so classifying it exactly as
 * derived made all seven tests pass again and its hostile `label` was never
 * fuzzed. A mechanism must get the VISIBILITY right and then actually FUZZ the
 * thing, or it only looks like coverage.
 *
 * `TOTAL` here means: for every argument in every position, this callable
 * returns rather than throws — the property the fuzz below exercises against 19
 * hostile values. It is a claim about ARGUMENTS, not about lifetime: the
 * invocation-scoped capabilities (`StrategyContext.*`, the `SeededRandom`
 * facade) throw `StrategyContextRevokedError` once their invocation has
 * returned, by design, and `context-revocation.test.ts` pins that for all ten
 * capabilities.
 *
 * `PARTIAL` means the callable has a stated precondition and can throw when it
 * is broken. Since round 5 that is not a free classification: every PUBLIC
 * `PARTIAL` entry must carry a WITNESS below that actually throws, so
 * downgrading a function out of the fuzz costs a demonstration that the
 * downgrade is honest.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { deriveBoundarySurface, type Derivation, type CallableShape } from "./boundary-derivation.js";
import { holdDecision, makeHarness, makeInput, makeStrategy } from "./helpers.js";
import type { StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import {
  acquireEvaluationInput,
  canonicalJsonStringify,
  createStrategyInstanceRuntime,
  deepFreeze,
  DeterministicRng,
  isReservedRuntimeReasonCode,
  isRngState,
  materializeCheckpointableJson,
  rebuildStateFromPatches,
  restoreCheckpoint,
  StrategyContextRevokedError,
  validateEvaluationInput,
} from "../../../packages/strategy-runtime/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** One program, reused by every test in this file (it costs ~350 ms to build). */
let cached: Derivation | undefined;
function surface(): Derivation {
  cached ??= deriveBoundarySurface({
    root: REPO_ROOT,
    packageDirs: ["packages/strategy-sdk/src", "packages/strategy-runtime/src"],
    entryPoints: ["packages/strategy-sdk/src/index.ts", "packages/strategy-runtime/src/index.ts"],
  });
  return cached;
}

interface Classification {
  readonly params: readonly string[];
  readonly visibility: "PUBLIC" | "PACKAGE";
  readonly shape: CallableShape;
  readonly totality: "TOTAL" | "PARTIAL";
  readonly note: string;
}

const REGISTRY: Readonly<Record<string, Classification>> = {
  // --- the public, total boundary: free functions ---------------------------
  acquireEvaluationInput: {
    params: ["input"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "TOTAL",
    note: "materializes one inert snapshot; every read is guarded",
  },
  createStrategyInstanceRuntime: {
    params: ["definition"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "TOTAL",
    note: "every failure is a typed RuntimeCreationRefusal",
  },
  isReservedRuntimeReasonCode: {
    params: ["code"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "TOTAL",
    note: "typeof guard before startsWith",
  },
  isRngState: {
    params: ["state"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "TOTAL",
    note: "a predicate that throws is not a predicate",
  },
  materializeCheckpointableJson: {
    params: ["value"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "TOTAL",
    note:
      "round 4, MEDIUM 1: the diagnostic `path` is gone from this signature — a " +
      "caller-supplied path is not part of the value contract",
  },
  rebuildStateFromPatches: {
    params: ["patches"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "TOTAL",
    note: "returns a typed result rather than throwing on a bad patch",
  },
  restoreCheckpoint: {
    params: ["checkpoint", "identity"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "TOTAL",
    note: "both arguments snapshotted; every failure is a typed CheckpointRefusal",
  },
  validateEvaluationInput: {
    params: ["input"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "TOTAL",
    note: "materializes first, then validates the snapshot",
  },
  "StrategyContextRevokedError.constructor": {
    params: ["capability"],
    visibility: "PUBLIC",
    shape: "constructor",
    totality: "TOTAL",
    note: "round 4: the capability is normalized through describeLabel before interpolation",
  },

  // --- the public, total boundary: the runtime INSTANCE ---------------------
  // Round 5: `StrategyInstanceRuntime` is exported as a TYPE only, so round 4's
  // scan (which looked for `export class`) saw none of these — yet `evaluate`
  // is the single largest caller-data boundary in the package. A resolved
  // module graph sees the type export and knows instances escape through the
  // factory.
  "StrategyInstanceRuntime.evaluate": {
    params: ["input"],
    visibility: "PUBLIC",
    shape: "method",
    totality: "TOTAL",
    note:
      "round 5: the evaluation entry point. Every hostile input is a typed " +
      "REFUSED/INPUT_INVALID outcome — acquisition happens before anything else",
  },
  "StrategyInstanceRuntime.instanceStatus": {
    params: [],
    visibility: "PUBLIC",
    shape: "method",
    totality: "TOTAL",
    note: "no parameters: returns the instance's own status field",
  },
  "StrategyInstanceRuntime.nextEvaluationSeq": {
    params: [],
    visibility: "PUBLIC",
    shape: "method",
    totality: "TOTAL",
    note: "no parameters: returns the instance's own counter",
  },

  // --- the public, total boundary: the capabilities handed to a strategy ----
  // Round 5: these are built inside `buildStrategyContext` as closures, so no
  // exported NAME reaches them. The derivation follows the RETURN types of the
  // callables it already found, which is how a facade this package hands out
  // becomes part of its surface. `book(outcome)` is the only one that takes
  // caller data, and it is the reason this whole branch is worth walking.
  "StrategyContext.book": {
    params: ["outcome"],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "a strict equality against \"YES\" decides the side; no argument can make it throw",
  },
  "StrategyContext.features": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: returns the runtime's own frozen features view",
  },
  "StrategyContext.market": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: returns the runtime's own frozen market view",
  },
  "StrategyContext.now": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: returns the logical evaluatedAt of this evaluation",
  },
  "StrategyContext.orders": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: returns the runtime's own frozen orders view",
  },
  "StrategyContext.params": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: returns the materialized params copy (round 4's HIGH 2)",
  },
  "StrategyContext.position": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: returns the runtime's own frozen position view",
  },
  "StrategyContext.riskBudget": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: returns the runtime's own frozen risk-budget view",
  },
  "StrategyContext.rng": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: returns the frozen draw-only facade over the runtime's generator",
  },
  "StrategyContext.state": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: returns the runtime's own frozen state fold",
  },
  "SeededRandom.nextUint32": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: the guarded facade over 32-bit lane arithmetic",
  },
  "SeededRandom.nextFloat53": {
    params: [],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "TOTAL",
    note: "no parameters: two guarded draws folded into a 53-bit float",
  },
  "DeterministicRng.nextUint32": {
    params: [],
    visibility: "PUBLIC",
    shape: "method",
    totality: "TOTAL",
    note: "no parameters: 32-bit integer arithmetic over the generator's own lanes",
  },
  "DeterministicRng.nextFloat53": {
    params: [],
    visibility: "PUBLIC",
    shape: "method",
    totality: "TOTAL",
    note: "no parameters: two nextUint32 draws folded into a 53-bit float",
  },
  "DeterministicRng.snapshot": {
    params: [],
    visibility: "PUBLIC",
    shape: "method",
    totality: "TOTAL",
    note: "no parameters: returns the four lanes as a fresh tuple",
  },

  // --- the public, deliberately PARTIAL surface -----------------------------
  // Every entry here must carry a witness in PUBLIC_PARTIAL_WITNESSES that
  // actually throws (review round 5's LOW).
  canonicalJsonStringify: {
    params: ["value"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "PARTIAL",
    note:
      "precondition: a MATERIALIZED, acyclic value. A cycle is a typed TypeError naming the " +
      "precondition, because a silent hang would be worse. No runtime path can reach it",
  },
  deepFreeze: {
    params: ["value"],
    visibility: "PUBLIC",
    shape: "function",
    totality: "PARTIAL",
    note:
      "precondition: an owned object graph. Object.freeze on an exotic object can throw; every " +
      "call site inside the package passes runtime-owned data or is explicitly guarded",
  },
  "DeterministicRng.fromSeed": {
    params: ["seed"],
    visibility: "PUBLIC",
    shape: "method",
    totality: "PARTIAL",
    note: "precondition: the run's canonical seed string, validated by the factory",
  },
  "DeterministicRng.fromState": {
    params: ["state"],
    visibility: "PUBLIC",
    shape: "method",
    totality: "PARTIAL",
    note: "precondition: a state the caller validated with isRngState",
  },
  "DeterministicRng.restore": {
    params: ["state"],
    visibility: "PUBLIC",
    shape: "method",
    totality: "PARTIAL",
    note: "precondition: a state the caller validated with isRngState",
  },
  "DeterministicRng.nextIntBelow": {
    params: ["maxExclusive"],
    visibility: "PUBLIC",
    shape: "method",
    totality: "PARTIAL",
    note: "throws RangeError on an out-of-range bound BY DESIGN; the runtime contains it",
  },
  "SeededRandom.nextIntBelow": {
    params: ["maxExclusive"],
    visibility: "PUBLIC",
    shape: "declared method",
    totality: "PARTIAL",
    note:
      "round 5: the facade a strategy actually calls. Same deliberate RangeError as the " +
      "generator beneath it, contained by the runtime as one CALLBACK_THREW record",
  },

  // --- package-internal: reachable only through the entry points above -----
  buildStrategyContext: {
    params: ["input", "params", "state", "rng"],
    visibility: "PACKAGE",
    shape: "function",
    totality: "TOTAL",
    note: "every argument is runtime-owned inert data by construction",
  },
  describeCause: {
    params: ["cause"],
    visibility: "PACKAGE",
    shape: "function",
    totality: "TOTAL",
    note: "the last resort is typeof, the only operation that cannot run caller code",
  },
  describeLabel: {
    params: ["label"],
    visibility: "PACKAGE",
    shape: "function",
    totality: "TOTAL",
    note: "round 4: normalizes every diagnostic path/label before it is interpolated",
  },
  drawOnlyRng: {
    params: ["rng", "guard"],
    visibility: "PACKAGE",
    shape: "function",
    totality: "PARTIAL",
    note: "the guard throws StrategyContextRevokedError by design (round 1)",
  },
  materializeCheckpointableJsonAt: {
    params: ["value", "path"],
    visibility: "PACKAGE",
    shape: "function",
    totality: "TOTAL",
    note: "the pathed form; the path is normalized through describeLabel",
  },
  materializeEvaluationViewAt: {
    params: ["value", "path"],
    visibility: "PACKAGE",
    shape: "function",
    totality: "TOTAL",
    note: "the evaluation-view grammar; same path normalization",
  },
  materializeImmutableParamsAt: {
    params: ["value", "path"],
    visibility: "PACKAGE",
    shape: "function",
    totality: "TOTAL",
    note: "round 4, HIGH 2: the params grammar; same path normalization",
  },
  readOwnFieldsOnce: {
    params: ["owner", "label", "fields"],
    visibility: "PACKAGE",
    shape: "function",
    totality: "TOTAL",
    note: "one guarded read and one guarded presence probe per field",
  },
  "ScopedStrategyContext.revoke": {
    params: [],
    visibility: "PACKAGE",
    shape: "declared property function",
    totality: "TOTAL",
    note:
      "round 5: the revocation handle the runtime keeps for itself — it is deliberately NOT on " +
      "the StrategyContext the strategy receives, and it only flips a boolean",
  },
  "StrategyInstanceRuntime.constructor": {
    params: [
      "strategy",
      "params",
      "run",
      "evaluationBudgetUs",
      "clock",
      "decisionSink",
      "checkpointStore",
      "initialState",
      "rng",
      "initialEvaluationSeq",
      "initialStatus",
    ],
    visibility: "PACKAGE",
    shape: "constructor",
    totality: "TOTAL",
    note:
      "round 5: the class VALUE is not exported, so `new` is unreachable from outside; the " +
      "factory validates every argument before it gets here",
  },
};

/** Hostile values, one per row, applied in EVERY parameter position. */
function hostileValues(): ReadonlyArray<readonly [string, unknown]> {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  let deep: unknown = 1;
  for (let index = 0; index < 400; index += 1) {
    deep = { deep };
  }
  return [
    ["undefined", undefined],
    ["null", null],
    ["symbol", Symbol("hostile")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["negative zero", -0],
    ["revoked proxy", revocable.proxy],
    [
      "throwing toString",
      {
        toString(): string {
          throw new Error("TO_STRING");
        },
      },
    ],
    [
      "throwing get",
      new Proxy(
        { a: 1 },
        {
          get(): never {
            throw new Error("GET");
          },
        },
      ),
    ],
    [
      "throwing ownKeys",
      new Proxy(
        { a: 1 },
        {
          ownKeys(): never {
            throw new Error("OWN_KEYS");
          },
        },
      ),
    ],
    [
      "throwing getPrototypeOf",
      new Proxy(
        { a: 1 },
        {
          getPrototypeOf(): never {
            throw new Error("PROTOTYPE");
          },
        },
      ),
    ],
    [
      "throwing has",
      new Proxy(
        { a: 1 },
        {
          has(): never {
            throw new Error("HAS");
          },
        },
      ),
    ],
    ["null-prototype object", Object.create(null) as object],
    ["function", (): number => 1],
    ["Map", new Map([["k", "v"]])],
    ["cyclic object", cyclic],
    ["deeply nested object", deep],
    // A HOLE, built with `length` rather than an elision (the elision form is
    // banned by `no-sparse-arrays`). Reading index 1 yields `undefined` and
    // `1 in holed` is false — the case the canonical serializer would render as
    // the invalid text `[1,,3]`.
    [
      "array with a hole",
      (() => {
        const holed = [1, 2, 3];
        delete holed[1];
        return holed;
      })(),
    ],
    ["string", "hostile"],
  ];
}

/**
 * Runs `use` on a LIVE context, inside the one callback invocation that owns
 * it, and propagates whatever it threw to the caller. The capabilities a
 * strategy receives exist only for the duration of a callback (round 1), so
 * this is the only honest way to fuzz them.
 */
function withLiveContext<T>(use: (ctx: StrategyContext) => T): T {
  let observed: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } | undefined;
  const { runtime } = makeHarness({
    strategy: makeStrategy({
      onFeatures: (ctx: StrategyContext) => {
        try {
          observed = { ok: true, value: use(ctx) };
        } catch (error) {
          observed = { ok: false, error };
        }
        return holdDecision(ctx);
      },
    }),
  });
  runtime.evaluate(makeInput("onFeatures"));
  if (observed === undefined) {
    throw new Error("the callback never ran, so nothing was exercised");
  }
  if (!observed.ok) {
    throw observed.error;
  }
  return observed.value;
}

/**
 * The callable for every PUBLIC, TOTAL entry. The fuzz asserts this map covers
 * exactly those entries, so a new total public callable cannot be added without
 * being fuzzed — and, since round 5, cannot be hidden by classifying it PACKAGE
 * either, because visibility is derived rather than asserted.
 */
const PUBLIC_TOTAL_CALLS: Readonly<Record<string, (args: readonly unknown[]) => unknown>> = {
  acquireEvaluationInput: (args) => acquireEvaluationInput(args[0]),
  createStrategyInstanceRuntime: (args) =>
    createStrategyInstanceRuntime(args[0] as Parameters<typeof createStrategyInstanceRuntime>[0]),
  isReservedRuntimeReasonCode: (args) => isReservedRuntimeReasonCode(args[0] as string),
  isRngState: (args) => isRngState(args[0]),
  materializeCheckpointableJson: (args) => materializeCheckpointableJson(args[0]),
  rebuildStateFromPatches: (args) =>
    rebuildStateFromPatches(args[0] as Parameters<typeof rebuildStateFromPatches>[0]),
  restoreCheckpoint: (args) =>
    restoreCheckpoint(
      args[0] as Parameters<typeof restoreCheckpoint>[0],
      args[1] as Parameters<typeof restoreCheckpoint>[1],
    ),
  validateEvaluationInput: (args) => validateEvaluationInput(args[0]),
  "StrategyContextRevokedError.constructor": (args) =>
    new StrategyContextRevokedError(args[0] as never),
  // Round 5: these three used to be wired to `() => undefined`, which asserted
  // nothing at all. They call the real generator now.
  "DeterministicRng.nextUint32": () => DeterministicRng.fromSeed("12345").nextUint32(),
  "DeterministicRng.nextFloat53": () => DeterministicRng.fromSeed("12345").nextFloat53(),
  "DeterministicRng.snapshot": () => DeterministicRng.fromSeed("12345").snapshot(),
  "StrategyInstanceRuntime.evaluate": (args) => makeHarness().runtime.evaluate(args[0] as never),
  "StrategyInstanceRuntime.instanceStatus": () => makeHarness().runtime.instanceStatus(),
  "StrategyInstanceRuntime.nextEvaluationSeq": () => makeHarness().runtime.nextEvaluationSeq(),
  "StrategyContext.book": (args) => withLiveContext((ctx) => ctx.book(args[0] as "YES" | "NO")),
  "StrategyContext.features": () => withLiveContext((ctx) => ctx.features()),
  "StrategyContext.market": () => withLiveContext((ctx) => ctx.market()),
  "StrategyContext.now": () => withLiveContext((ctx) => ctx.now()),
  "StrategyContext.orders": () => withLiveContext((ctx) => ctx.orders()),
  "StrategyContext.params": () => withLiveContext((ctx) => ctx.params<Record<string, unknown>>()),
  "StrategyContext.position": () => withLiveContext((ctx) => ctx.position()),
  "StrategyContext.riskBudget": () => withLiveContext((ctx) => ctx.riskBudget()),
  "StrategyContext.rng": () => withLiveContext((ctx) => ctx.rng()),
  "StrategyContext.state": () => withLiveContext((ctx) => ctx.state<Record<string, unknown>>()),
  "SeededRandom.nextUint32": () => withLiveContext((ctx) => ctx.rng().nextUint32()),
  "SeededRandom.nextFloat53": () => withLiveContext((ctx) => ctx.rng().nextFloat53()),
};

/**
 * Review round 5's LOW, closed. A `PARTIAL` classification is a claim that the
 * callable CAN throw under a stated precondition; without a witness it is just
 * a way to leave a public function out of the fuzz. Downgrading something to
 * `PARTIAL` now costs a concrete, executable demonstration.
 */
interface PartialWitness {
  /** The precondition, in the same words the source states it. */
  readonly precondition: string;
  /** Breaking that precondition, concretely. Must throw. */
  readonly breaks: () => unknown;
  readonly throws: ErrorConstructor | string;
}

function cyclicValue(): Record<string, unknown> {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic["self"] = cyclic;
  return cyclic;
}

function unfreezableValue(): object {
  return new Proxy(
    { a: 1 },
    {
      preventExtensions(): boolean {
        throw new Error("PREVENT_EXTENSIONS");
      },
    },
  );
}

const PUBLIC_PARTIAL_WITNESSES: Readonly<Record<string, PartialWitness>> = {
  canonicalJsonStringify: {
    precondition: "a MATERIALIZED, acyclic value",
    breaks: () => canonicalJsonStringify(cyclicValue() as never),
    throws: TypeError,
  },
  deepFreeze: {
    precondition: "an object graph the runtime owns",
    breaks: () => deepFreeze(unfreezableValue()),
    throws: "PREVENT_EXTENSIONS",
  },
  "DeterministicRng.fromSeed": {
    precondition: "the run's canonical seed STRING, validated by the factory",
    breaks: () => DeterministicRng.fromSeed(null as unknown as string),
    throws: TypeError,
  },
  "DeterministicRng.fromState": {
    precondition: "a four-lane state the caller validated with isRngState",
    breaks: () => DeterministicRng.fromState({} as unknown as [number, number, number, number]),
    throws: TypeError,
  },
  "DeterministicRng.restore": {
    precondition: "a four-lane state the caller validated with isRngState",
    breaks: () =>
      DeterministicRng.fromSeed("12345").restore(
        {} as unknown as [number, number, number, number],
      ),
    throws: TypeError,
  },
  "DeterministicRng.nextIntBelow": {
    precondition: "an integer bound in [1, 2^32]",
    breaks: () => DeterministicRng.fromSeed("12345").nextIntBelow(0),
    throws: RangeError,
  },
  "SeededRandom.nextIntBelow": {
    precondition: "an integer bound in [1, 2^32], inside a live invocation",
    breaks: () => withLiveContext((ctx) => ctx.rng().nextIntBelow(0)),
    throws: RangeError,
  },
};

describe("the boundary surface is resolved from the module graph, not scanned", () => {
  it("every callable the type checker resolves is classified — and vice versa", () => {
    const derivation = surface();
    // Non-empty, both packages parsed, and no id derived twice.
    expect(derivation.callables.length).toBeGreaterThan(40);
    expect(derivation.parsedFiles.some((file) => file.startsWith("packages/strategy-sdk"))).toBe(
      true,
    );
    expect(
      derivation.parsedFiles.some((file) => file.startsWith("packages/strategy-runtime")),
    ).toBe(true);
    const ids = derivation.callables.map((entry) => entry.id);
    expect(new Set(ids).size, "two callables derived the same id").toBe(ids.length);

    expect(
      [...ids].sort(),
      "a callable entered or left the boundary without a classification: add it to REGISTRY " +
        "in this file with the derived visibility and shape, and — if it is PUBLIC and TOTAL — " +
        "to PUBLIC_TOTAL_CALLS so the hostile battery reaches it (PUBLIC and PARTIAL needs a " +
        "witness in PUBLIC_PARTIAL_WITNESSES instead)",
    ).toEqual(Object.keys(REGISTRY).sort());

    for (const entry of derivation.callables) {
      const classification = REGISTRY[entry.id];
      expect(classification, entry.id).toBeDefined();
      if (classification === undefined) {
        continue;
      }
      expect(classification.params, `${entry.id} parameters`).toEqual(entry.params);
      expect(classification.visibility, `${entry.id} visibility`).toBe(entry.visibility);
      expect(classification.shape, `${entry.id} shape`).toBe(entry.shape);
      expect(classification.note.length, `${entry.id} note`).toBeGreaterThan(20);
    }
  });

  it("the derivation refuses to guess: nothing is left unresolved, and the program type-checks", () => {
    // Fail-closed is the whole point of round 5. An entry here means the walk
    // met a callable shape it could not classify and stopped rather than
    // treating it as internal.
    expect(surface().unresolved).toEqual([]);
    // And the resolution is only as good as the program: a package that does
    // not compile would resolve to nonsense…
    expect(surface().diagnostics).toEqual([]);
    // …and neither would a program holding two copies of a workspace package,
    // because half the callables would be attributed to "somebody else".
    expect(surface().foreignWorkspaceResolutions).toEqual([]);
  });

  it("no PUBLIC signature carries a diagnostic path or label (round 4, MEDIUM 1)", () => {
    // The rule the finding implies: a diagnostic string is the runtime's own
    // business. A caller-supplied one is an operation on caller data inside a
    // function that promises never to throw, and it is invisible to a runtime
    // arity check because it has a default.
    const diagnostic = new Set(["path", "label"]);
    for (const entry of surface().callables) {
      if (entry.visibility !== "PUBLIC") {
        continue;
      }
      for (const parameter of entry.params) {
        expect(
          diagnostic.has(parameter),
          `${entry.id} exposes the diagnostic parameter "${parameter}" publicly`,
        ).toBe(false);
      }
    }
  });

  it("Function.length would MISS a defaulted parameter — which is why the compiler is the oracle", () => {
    // The methodological point, executable. Round 3's table and any runtime
    // enumeration both reported arity 1 for the two-parameter function that
    // carried the defect.
    const pathed = surface().callables.find(
      (entry) => entry.id === "materializeCheckpointableJsonAt",
    );
    expect(pathed?.params).toEqual(["value", "path"]);
    // The PUBLIC wrapper takes the value alone, by both measures.
    expect(materializeCheckpointableJson.length).toBe(1);
    expect(REGISTRY["materializeCheckpointableJson"]?.params).toEqual(["value"]);
  });

  it("every PUBLIC TOTAL callable survives every hostile value in every parameter position", () => {
    const registered = Object.entries(REGISTRY)
      .filter(([, value]) => value.visibility === "PUBLIC" && value.totality === "TOTAL")
      .map(([id]) => id)
      .sort();
    expect(
      Object.keys(PUBLIC_TOTAL_CALLS).sort(),
      "a PUBLIC TOTAL callable is not wired to the hostile battery",
    ).toEqual(registered);

    for (const id of registered) {
      const call = PUBLIC_TOTAL_CALLS[id];
      const arity = REGISTRY[id]?.params.length ?? 0;
      if (call === undefined) {
        continue;
      }
      if (arity === 0) {
        expect(() => call([]), id).not.toThrow();
        continue;
      }
      for (let position = 0; position < arity; position += 1) {
        for (const [label, value] of hostileValues()) {
          const args = Array.from({ length: arity }, (_, index) =>
            index === position ? value : undefined,
          );
          expect(
            () => call(args),
            `${id} threw for a ${label} in parameter ${String(position)}`,
          ).not.toThrow();
        }
      }
    }
  });

  it("the reviewer's transcript: an extra path argument can no longer make the materializer throw", () => {
    // A JavaScript caller can pass a second argument to a one-parameter
    // function. Before round 4 that argument was the diagnostic path and it was
    // interpolated into the refusal; now it is simply not a parameter.
    const jsCaller = materializeCheckpointableJson as unknown as (
      value: unknown,
      path: unknown,
    ) => { readonly ok: boolean; readonly problem?: string };

    for (const path of [
      Symbol("hostile"),
      {
        toString(): string {
          throw new Error("PATH_TOSTRING");
        },
      },
      Object.create(null) as object,
      1n,
    ]) {
      const result = jsCaller(1n, path);
      expect(result.ok).toBe(false);
      expect(result.problem).toBe("$: bigint is not representable in JSON");
    }
  });

  it("PARTIAL is not a euphemism: every public partial carries a witness that it really throws", () => {
    // Review round 5's LOW. The old version of this test hard-coded two
    // examples, so downgrading a function from TOTAL to PARTIAL and deleting
    // its call adapter — two edits, the second one prompted by the first
    // failure — removed it from the fuzz with all seven tests passing. A
    // witness set derived from the registry makes that trade explicit.
    const partials = Object.entries(REGISTRY)
      .filter(([, value]) => value.visibility === "PUBLIC" && value.totality === "PARTIAL")
      .map(([id]) => id)
      .sort();
    expect(
      Object.keys(PUBLIC_PARTIAL_WITNESSES).sort(),
      "a PUBLIC PARTIAL classification without a witness is a way of leaving a public callable " +
        "out of the fuzz: give it a concrete precondition and a call that breaks it",
    ).toEqual(partials);

    for (const id of partials) {
      const witness = PUBLIC_PARTIAL_WITNESSES[id];
      expect(witness, id).toBeDefined();
      if (witness === undefined) {
        continue;
      }
      expect(witness.precondition.length, `${id} precondition`).toBeGreaterThan(15);
      expect(
        witness.breaks,
        `${id} is classified PARTIAL but its documented precondition, broken, does not throw — ` +
          "so PARTIAL is hiding it from the fuzz rather than describing it",
      ).toThrow(witness.throws);
    }
  });

  it("…and the materializing boundary in front of the partials refuses without throwing", () => {
    // The other half of the argument: the partial functions are unreachable
    // with a bad value from any runtime path, because the boundary in front of
    // them answers first, with a refusal rather than an exception.
    expect(materializeCheckpointableJson(cyclicValue()).ok).toBe(false);
    const copy = materializeCheckpointableJson(unfreezableValue());
    expect(copy.ok).toBe(true);
    if (copy.ok) {
      expect(() => deepFreeze(copy.value)).not.toThrow();
    }
  });

  it("the strategy SDK implements nothing: every callable it declares has no body here", () => {
    // Round 4 asserted the SDK "exports no function at all", which was true of
    // its module exports and blind to the CONTRACTS it declares — the ten
    // `StrategyContext` capabilities the runtime implements and hands to
    // strategies. Both halves are asserted now.
    const sdk = surface().callables.filter((entry) =>
      entry.file.startsWith("packages/strategy-sdk"),
    );
    expect(sdk.length).toBeGreaterThan(0);
    for (const entry of sdk) {
      expect(entry.shape.startsWith("declared"), `${entry.id} has a body in the SDK`).toBe(true);
      expect(entry.via, `${entry.id} is an SDK module export`).not.toBe("module export");
    }
  });

  it("`typescript` is a root devDependency used by the ROOT test tree only", () => {
    // Neither package may import it (acceptance 2's `node:`/import pins in
    // package-boundaries.test.ts bind the sources); this file and the
    // derivation module are in the root test tree, which already imports
    // node:fs, node:path and node:url.
    expect(typeof ts.createProgram).toBe("function");
    expect(ts.version.startsWith("5.")).toBe(true);
  });
});
