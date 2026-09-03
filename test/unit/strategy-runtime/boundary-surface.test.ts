/**
 * The boundary surface, DERIVED from the sources rather than remembered
 * (remediation round 4, 2026-09-03).
 *
 * Why this file exists. Rounds 1–3 each found one defect class on a new
 * surface, and round 3 answered with a 25-row hand-built table of "every entry
 * point where caller data enters this package". Review round 4 then found that
 * the table itself had holes: an exported function's own `path` ARGUMENT was
 * never in it, and both rows the table argued were deliberate NON-applications
 * turned out to be wrong. An enumeration is only as complete as the thing doing
 * the enumerating, and a table maintained by hand is complete only until the
 * next commit.
 *
 * So the enumeration is mechanical here, and it is mechanical in a way that a
 * runtime walk cannot be. The list below is parsed out of the TypeScript AST of
 * both packages' sources; `Function.length` — the obvious runtime alternative —
 * does NOT count a parameter that has a default, which is precisely what
 * `materializeCheckpointableJson(value, path = "$")` was. A runtime enumeration
 * would have reported arity 1 and missed the reported defect all over again.
 *
 * What that buys tomorrow: a new exported function, or a new parameter on an
 * existing one, fails this file until someone classifies it TOTAL or PARTIAL
 * and (for a TOTAL public one) wires it into the fuzz below. Nobody has to
 * remember to update a table; the table cannot be out of date.
 *
 * The reviewer's MEDIUM-1 reproduction, verbatim against the round-3 code:
 *
 * ```
 * materializeCheckpointableJson(1n, Symbol(...))  → threw TypeError: Cannot convert a Symbol value to a string
 * path.toString() throws                          → escaped Error: PATH_TOSTRING
 * ```
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  acquireEvaluationInput,
  canonicalJsonStringify,
  createStrategyInstanceRuntime,
  deepFreeze,
  isReservedRuntimeReasonCode,
  isRngState,
  materializeCheckpointableJson,
  rebuildStateFromPatches,
  restoreCheckpoint,
  StrategyContextRevokedError,
  validateEvaluationInput,
} from "../../../packages/strategy-runtime/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGE_DIRS = ["packages/strategy-sdk/src", "packages/strategy-runtime/src"] as const;
const ENTRY_POINTS = [
  "packages/strategy-sdk/src/index.ts",
  "packages/strategy-runtime/src/index.ts",
] as const;

/** One exported function, as the AST reports it. */
interface DerivedFunction {
  readonly id: string;
  readonly file: string;
  readonly visibility: "PUBLIC" | "PACKAGE";
  readonly params: readonly string[];
}

function sourceFiles(relativeDir: string): string[] {
  const absolute = join(REPO_ROOT, relativeDir);
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(relativeDir, entry))
    .sort();
}

function parse(relativeFile: string): ts.SourceFile {
  return ts.createSourceFile(
    relativeFile,
    readFileSync(join(REPO_ROOT, relativeFile), "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
}

/** The value names each package's entry point re-exports (its PUBLIC surface). */
function publicNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of ENTRY_POINTS) {
    const source = parse(entry);
    source.forEachChild((node) => {
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const element of node.exportClause.elements) {
          if (!element.isTypeOnly) {
            names.add(element.name.getText(source));
          }
        }
      }
    });
  }
  return names;
}

/**
 * Every exported function in both packages, with every parameter, from the AST.
 * Class members count: a public method is an entry point whether or not it is a
 * free function, and `DeterministicRng` is exported.
 */
function derive(): DerivedFunction[] {
  const exported = publicNames();
  const derived: DerivedFunction[] = [];
  for (const dir of PACKAGE_DIRS) {
    for (const file of sourceFiles(dir)) {
      const source = parse(file);
      const record = (owner: string | null, name: string, node: ts.SignatureDeclarationBase): void => {
        const id = owner === null ? name : `${owner}.${name}`;
        derived.push({
          id,
          file,
          visibility: exported.has(owner ?? name) ? "PUBLIC" : "PACKAGE",
          params: node.parameters.map((parameter) => parameter.name.getText(source)),
        });
      };
      const isExported = (node: ts.Node): boolean =>
        (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
      const isPrivate = (node: ts.Node): boolean =>
        (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Private) !== 0;

      source.forEachChild((node) => {
        if (ts.isFunctionDeclaration(node) && node.name !== undefined && isExported(node)) {
          record(null, node.name.getText(source), node);
          return;
        }
        if (ts.isClassDeclaration(node) && node.name !== undefined && isExported(node)) {
          const className = node.name.getText(source);
          for (const member of node.members) {
            if (ts.isConstructorDeclaration(member) && !isPrivate(member)) {
              record(className, "constructor", member);
            } else if (
              ts.isMethodDeclaration(member) &&
              member.name !== undefined &&
              !isPrivate(member)
            ) {
              record(className, member.name.getText(source), member);
            }
          }
          return;
        }
        if (ts.isVariableStatement(node) && isExported(node)) {
          for (const declaration of node.declarationList.declarations) {
            const initializer = declaration.initializer;
            if (
              initializer !== undefined &&
              (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
            ) {
              record(null, declaration.name.getText(source), initializer);
            }
          }
        }
      });
    }
  }
  return derived.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The classification. Every derived function must appear here with the SAME
 * parameter list the AST reports, and every entry here must be derivable.
 *
 * `TOTAL` means the function cannot throw for ANY argument in ANY position —
 * the property the fuzz below exercises. `PARTIAL` means the function has a
 * stated precondition and its source says so; those are deliberate, and this
 * table is what keeps the set of them from growing quietly.
 */
interface Classification {
  readonly params: readonly string[];
  readonly visibility: "PUBLIC" | "PACKAGE";
  readonly totality: "TOTAL" | "PARTIAL";
  readonly note: string;
}

const REGISTRY: Readonly<Record<string, Classification>> = {
  // --- the public, total boundary ------------------------------------------
  acquireEvaluationInput: {
    params: ["input"],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "materializes one inert snapshot; every read is guarded",
  },
  createStrategyInstanceRuntime: {
    params: ["definition"],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "every failure is a typed RuntimeCreationRefusal",
  },
  isReservedRuntimeReasonCode: {
    params: ["code"],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "typeof guard before startsWith",
  },
  isRngState: {
    params: ["state"],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "a predicate that throws is not a predicate",
  },
  materializeCheckpointableJson: {
    params: ["value"],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note:
      "round 4, MEDIUM 1: the diagnostic `path` is gone from this signature — a " +
      "caller-supplied path is not part of the value contract",
  },
  rebuildStateFromPatches: {
    params: ["patches"],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "returns a typed result rather than throwing on a bad patch",
  },
  restoreCheckpoint: {
    params: ["checkpoint", "identity"],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "both arguments snapshotted; every failure is a typed CheckpointRefusal",
  },
  "StrategyContextRevokedError.constructor": {
    params: ["capability"],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "round 4: the capability is normalized through describeLabel before interpolation",
  },
  validateEvaluationInput: {
    params: ["input"],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "materializes first, then validates the snapshot",
  },

  // --- the public, deliberately PARTIAL surface ----------------------------
  canonicalJsonStringify: {
    params: ["value"],
    visibility: "PUBLIC",
    totality: "PARTIAL",
    note:
      "precondition: a MATERIALIZED, acyclic value. A cycle is a typed TypeError naming the " +
      "precondition, because a silent hang would be worse. No runtime path can reach it",
  },
  deepFreeze: {
    params: ["value"],
    visibility: "PUBLIC",
    totality: "PARTIAL",
    note:
      "precondition: an owned object graph. Object.freeze on an exotic object can throw; every " +
      "call site inside the package passes runtime-owned data or is explicitly guarded",
  },
  "DeterministicRng.fromSeed": {
    params: ["seed"],
    visibility: "PUBLIC",
    totality: "PARTIAL",
    note: "precondition: the run's canonical seed string, validated by the factory",
  },
  "DeterministicRng.fromState": {
    params: ["state"],
    visibility: "PUBLIC",
    totality: "PARTIAL",
    note: "precondition: a state the caller validated with isRngState",
  },
  "DeterministicRng.restore": {
    params: ["state"],
    visibility: "PUBLIC",
    totality: "PARTIAL",
    note: "precondition: a state the caller validated with isRngState",
  },
  "DeterministicRng.nextIntBelow": {
    params: ["maxExclusive"],
    visibility: "PUBLIC",
    totality: "PARTIAL",
    note: "throws RangeError on an out-of-range bound BY DESIGN; the runtime contains it",
  },
  "DeterministicRng.nextUint32": {
    params: [],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "no parameters: 32-bit integer arithmetic over the generator's own lanes",
  },
  "DeterministicRng.nextFloat53": {
    params: [],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "no parameters: two nextUint32 draws folded into a 53-bit float",
  },
  "DeterministicRng.snapshot": {
    params: [],
    visibility: "PUBLIC",
    totality: "TOTAL",
    note: "no parameters: returns the four lanes as a fresh tuple",
  },

  // --- package-internal: reachable only through the entry points above -----
  buildStrategyContext: {
    params: ["input", "params", "state", "rng"],
    visibility: "PACKAGE",
    totality: "TOTAL",
    note: "every argument is runtime-owned inert data by construction",
  },
  describeCause: {
    params: ["cause"],
    visibility: "PACKAGE",
    totality: "TOTAL",
    note: "the last resort is typeof, the only operation that cannot run caller code",
  },
  describeLabel: {
    params: ["label"],
    visibility: "PACKAGE",
    totality: "TOTAL",
    note: "round 4: normalizes every diagnostic path/label before it is interpolated",
  },
  drawOnlyRng: {
    params: ["rng", "guard"],
    visibility: "PACKAGE",
    totality: "PARTIAL",
    note: "the guard throws StrategyContextRevokedError by design (round 1)",
  },
  materializeCheckpointableJsonAt: {
    params: ["value", "path"],
    visibility: "PACKAGE",
    totality: "TOTAL",
    note: "the pathed form; the path is normalized through describeLabel",
  },
  materializeEvaluationViewAt: {
    params: ["value", "path"],
    visibility: "PACKAGE",
    totality: "TOTAL",
    note: "the evaluation-view grammar; same path normalization",
  },
  materializeImmutableParamsAt: {
    params: ["value", "path"],
    visibility: "PACKAGE",
    totality: "TOTAL",
    note: "round 4, HIGH 2: the params grammar; same path normalization",
  },
  readOwnFieldsOnce: {
    params: ["owner", "label", "fields"],
    visibility: "PACKAGE",
    totality: "TOTAL",
    note: "one guarded read and one guarded presence probe per field",
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
 * The callable for every PUBLIC, TOTAL entry. The fuzz asserts this map covers
 * exactly those entries, so a new total public function cannot be added without
 * being fuzzed.
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
  "StrategyContextRevokedError.constructor": (args) =>
    new StrategyContextRevokedError(args[0] as never),
  validateEvaluationInput: (args) => validateEvaluationInput(args[0]),
  "DeterministicRng.nextUint32": () => undefined,
  "DeterministicRng.nextFloat53": () => undefined,
  "DeterministicRng.snapshot": () => undefined,
};

describe("the boundary surface is derived from the sources, not remembered", () => {
  it("every exported function and every parameter the AST reports is classified — and vice versa", () => {
    const derived = derive();
    // Non-empty, and both packages were actually parsed.
    expect(derived.length).toBeGreaterThan(20);

    const derivedIds = derived.map((entry) => entry.id).sort();
    const registeredIds = Object.keys(REGISTRY).sort();
    expect(
      derivedIds,
      "a function was exported without a totality classification (or a classification " +
        "outlived its function): add it to REGISTRY in this file, and — if it is PUBLIC and " +
        "TOTAL — to PUBLIC_TOTAL_CALLS so the fuzz covers it",
    ).toEqual(registeredIds);

    for (const entry of derived) {
      const classification = REGISTRY[entry.id];
      expect(classification, entry.id).toBeDefined();
      if (classification === undefined) {
        continue;
      }
      expect(classification.params, `${entry.id} parameters`).toEqual(entry.params);
      expect(classification.visibility, `${entry.id} visibility`).toBe(entry.visibility);
      expect(classification.note.length, `${entry.id} note`).toBeGreaterThan(20);
    }
  });

  it("no PUBLIC signature carries a diagnostic path or label (round 4, MEDIUM 1)", () => {
    // The rule the finding implies: a diagnostic string is the runtime's own
    // business. A caller-supplied one is an operation on caller data inside a
    // function that promises never to throw, and it is invisible to a runtime
    // arity check because it has a default.
    const diagnostic = new Set(["path", "label"]);
    for (const entry of derive()) {
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

  it("Function.length would MISS a defaulted parameter — which is why the AST is the oracle", () => {
    // The methodological point, executable. Round 3's table and any runtime
    // enumeration both reported arity 1 for the two-parameter function that
    // carried the defect.
    const source = parse("packages/strategy-runtime/src/json.ts");
    let pathed: ts.FunctionDeclaration | undefined;
    source.forEachChild((node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.getText(source) === "materializeCheckpointableJsonAt"
      ) {
        pathed = node;
      }
    });
    expect(pathed).toBeDefined();
    expect(pathed?.parameters.length).toBe(2);
    // The PUBLIC wrapper takes the value alone, by both measures.
    expect(materializeCheckpointableJson.length).toBe(1);
    expect(REGISTRY["materializeCheckpointableJson"]?.params).toEqual(["value"]);
  });

  it("every PUBLIC TOTAL function survives every hostile value in every parameter position", () => {
    const registered = Object.entries(REGISTRY)
      .filter(([, value]) => value.visibility === "PUBLIC" && value.totality === "TOTAL")
      .map(([id]) => id)
      .sort();
    expect(Object.keys(PUBLIC_TOTAL_CALLS).sort()).toEqual(registered);

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

  it("PARTIAL is not a euphemism: each partial public function throws exactly where its note says", () => {
    // A classification nobody checks is a comment. These two are the only
    // PUBLIC functions the registry admits can throw for a value argument, and
    // the reason is a stated precondition rather than an oversight.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => canonicalJsonStringify(cyclic)).toThrow(TypeError);
    // …and the materializing boundary that every runtime path goes through
    // first refuses the same value without throwing, which is why no runtime
    // path can reach that TypeError.
    expect(materializeCheckpointableJson(cyclic).ok).toBe(false);

    const unfreezable = new Proxy(
      { a: 1 },
      {
        preventExtensions(): boolean {
          throw new Error("PREVENT_EXTENSIONS");
        },
      },
    );
    expect(() => deepFreeze(unfreezable)).toThrow("PREVENT_EXTENSIONS");
    // Same argument: what the runtime hands `deepFreeze` is always its own copy.
    const copy = materializeCheckpointableJson(unfreezable);
    expect(copy.ok).toBe(true);
    if (copy.ok) {
      expect(() => deepFreeze(copy.value)).not.toThrow();
    }
  });

  it("the strategy SDK exports no function at all — parsed, not grepped", () => {
    const sdk = derive().filter((entry) => entry.file.startsWith("packages/strategy-sdk"));
    expect(sdk).toEqual([]);
  });
});
