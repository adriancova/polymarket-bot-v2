/**
 * THE INDEX-NAME REGRESSION for the canonical door (`WP-020-FU1`).
 *
 * `WP-200-FU1`'s review round 1 measured an ADR-020 §6 hole this package's own
 * batteries could not see, because `inherited-state.test.ts` EXCLUDES
 * array-index names from its material by design (the exclusion, and its two
 * measured reasons, are documented at its `ARRAY_INDEX` constant). Round 1
 * ruled the whole append surface in scope — GRANT-AND-WIDEN — and supplied the
 * measurements, taken through the ledger door on an HONEST input:
 *
 * ```text
 * get-only accessor at Object.prototype["0"]     base 761db76   tip 7d5ac34
 *   Ledger.empty("PAPER")                        OK             LedgerConfigurationError
 *   Ledger.rebuild("PAPER", [])                  OK             LedgerConfigurationError
 *   emptyPnlState(valid identity)                bare TypeError PnlConfigurationError
 * ```
 *
 * The cause was one primitive: `plain-data.ts` accumulated with
 * `Array.prototype.push`, which is `Set`, which consults the prototype chain
 * FOR THE INDEX NAME — so an inherited get-only accessor (or a read-only data
 * property) at `"0"` made the FIRST append to an empty array throw, the
 * module's outer guard caught it, and an honest input was REFUSED. Reproduced
 * at base `b4ce0aa` before this round wrote anything: 18 divergences across two
 * index names and three shapes, every one an AVAILABILITY move.
 *
 * WHAT THIS FILE ASSERTS. Over every (index name × shape × door) cell, the
 * door's answer is byte-identical to the clean one — not merely fail-closed.
 * That is what "permission does not vary" means once the availability half is
 * closed too, and it is what lets the ledger battery's index-`"0"` disclosure
 * SHRINK in the same commit.
 *
 * THE HARNESS RULES, from `test/unit/ledger/pollution.ts`: no `expect` inside a
 * polluted window, no own property of an intrinsic replaced (every name here is
 * an index name, which neither prototype owns), and no `push` in the harness
 * itself — the first draft of that harness was defeated by this very class
 * while it was recording a divergence.
 *
 * SCOPE. Configurable shapes only: a non-configurable property cannot be
 * removed and would poison every later test file in the worker.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_DEPTH,
  ownDataDetails,
  readPlainData,
  withSchemaDefaults,
} from "../../../packages/risk/src/plain-data.js";
import { evaluateIntent } from "../../../packages/risk/src/index.js";
import { entryInput, exitInput, riskPolicy } from "./fixtures.js";

/** Appends with `CreateDataProperty` semantics — never `push`. See the header. */
function appendData<T>(target: T[], value: T): void {
  const descriptor = Object.create(null) as Record<string, unknown>;
  descriptor["value"] = value;
  descriptor["writable"] = true;
  descriptor["enumerable"] = true;
  descriptor["configurable"] = true;
  Object.defineProperty(target, `${target.length}`, descriptor);
}

interface Shape {
  readonly name: string;
  readonly descriptor: () => PropertyDescriptor;
}

const SHAPES: readonly Shape[] = [
  // The two shapes `WP-200-FU1` measured: `Set` at an absent index cannot
  // complete, so the FIRST append throws.
  { name: "accessor-get-only", descriptor: () => ({ get: () => "9", enumerable: false, configurable: true }) },
  {
    name: "accessor-throws",
    descriptor: () => ({
      get: () => {
        throw new Error("hostile getter");
      },
      enumerable: false,
      configurable: true,
    }),
  },
  { name: "data-readonly", descriptor: () => ({ value: "9", writable: false, enumerable: false, configurable: true }) },
  // Data shapes: `Set` COMPLETES here, so the append works — but the value the
  // array reports for an index it does not own does not, which is why the
  // battery keeps them.
  { name: "data-NE-9", descriptor: () => ({ value: "9", writable: true, enumerable: false, configurable: true }) },
  { name: "data-E-1", descriptor: () => ({ value: 1, writable: true, enumerable: true, configurable: true }) },
  {
    name: "accessor-get-set",
    descriptor: () => {
      const held = Object.create(null) as Record<string, unknown>;
      return {
        get: () => held["v"],
        set: (value: unknown) => {
          held["v"] = value;
        },
        enumerable: false,
        configurable: true,
      };
    },
  },
];

/**
 * `"0"` is the index every accumulator reaches first and the only one the
 * `WP-200-FU1` constructors answered at; `"1"`, `"2"` and `"6"` cover the later
 * appends (a refusal list with several entries, an array member, the string
 * inventory), and `"6"` is one of the two indices the ledger battery's derived
 * material already contained.
 */
const INDEX_NAMES: readonly string[] = ["0", "1", "2", "6"];

interface Door {
  readonly name: string;
  /** Any value: {@link quietly} encodes it, so a door may answer in its own shape. */
  readonly run: () => unknown;
}

function quietly(run: () => unknown): string {
  try {
    return JSON.stringify(run()) ?? "undefined";
  } catch (error) {
    const thrown = error as { constructor: { name: string }; message?: unknown };
    return `THREW ${thrown.constructor.name}: ${String(thrown.message)}`;
  }
}

const POLICY = riskPolicy();

/** A deep, wide value: several appends at several indices, in one read. */
const RICH: Record<string, unknown> = {
  id: "01890000-0000-7000-8000-000000000001",
  nested: { a: "one", b: "two", c: { d: "three" } },
  list: ["x", "y", "z", "p", "q", "r", "s", "t"],
  matrix: [["a"], ["b", "c"], []],
  flags: { yes: true, no: false },
  count: 3,
};

/** A value with SEVERAL problems, so the refusal list itself needs appends. */
function broken(): Record<string, unknown> {
  const value: Record<string, unknown> = {
    good: "ok",
    aFunction: () => 1,
    aSymbolValue: Symbol("s"),
    aBigInt: 1n,
    sparse: (() => {
      const holes: unknown[] = [];
      Object.defineProperty(holes, "3", {
        value: "late",
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return holes;
    })(),
  };
  Object.defineProperty(value, "accessor", { get: () => "code", enumerable: true, configurable: true });
  Object.defineProperty(value, "__proto__", {
    value: "forbidden",
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}

const DOORS: readonly Door[] = [
  { name: "readPlainData(rich)", run: () => readPlainData(RICH, "record") },
  { name: "readPlainData(empty object)", run: () => readPlainData({}, "record") },
  { name: "readPlainData(empty array)", run: () => readPlainData({ list: [] }, "record") },
  { name: "readPlainData(broken)", run: () => readPlainData(broken(), "record") },
  { name: "readPlainData(string)", run: () => readPlainData("plain", "record") },
  {
    name: "readPlainData(too deep)",
    run: () => {
      let deep: unknown = "leaf";
      for (let level = 0; level <= MAX_DEPTH + 2; level += 1) deep = { down: deep };
      return readPlainData(deep, "record");
    },
  },
  {
    name: "withSchemaDefaults(all present)",
    run: () => {
      const read = readPlainData({ economics: { riskBuffer: "0.1" } }, "record");
      return read.ok
        ? withSchemaDefaults(read.value, [{ path: ["economics", "riskBuffer"], value: "9" }])
        : read;
    },
  },
  {
    name: "withSchemaDefaults(applies, array default)",
    run: () => {
      const read = readPlainData({ economics: {} }, "record");
      return read.ok
        ? withSchemaDefaults(read.value, [
            { path: ["economics", "kinds"], value: ["A", "B", "C", "D"] },
            { path: ["economics", "riskBuffer"], value: "0.1" },
          ])
        : read;
    },
  },
  {
    name: "withSchemaDefaults(unfilled)",
    run: () => {
      const read = readPlainData({}, "record");
      return read.ok
        ? withSchemaDefaults(read.value, [
            { path: ["missing", "one"], value: 1 },
            { path: ["missing", "two"], value: 2 },
          ])
        : read;
    },
  },
  { name: "ownDataDetails(plain)", run: () => ownDataDetails({ a: 1, b: "two", c: [1, 2, 3] }) },
  { name: "ownDataDetails(hostile)", run: () => ownDataDetails(broken()) },
  { name: "ownDataDetails(not an object)", run: () => ownDataDetails(42) },
];

/**
 * The package's PUBLIC composite door, measured SEPARATELY and to a weaker
 * claim — because that is what is true, and this round's grant is one file.
 *
 * `evaluateIntent` runs `plain-data.ts` and then eight other modules
 * (`engine.ts`, `exposure-limits.ts`, `guards.ts`, `intent-view.ts`,
 * `lots.ts`, `recommendations.ts`, `scenario.ts`, `worst-case.ts`) and the
 * `zod` arena, and every one of those still accumulates with
 * `Array.prototype.push` — including `zod`'s own `issues: []`. So the composite
 * still MOVES at an index name. What is asserted here is ADR-020 §6's bound
 * rather than byte-identity: **no PERMISSION move and no ESCAPE**, and the
 * moves that remain are enumerated by class so they cannot grow silently.
 * `packages/risk/src/plain-data.ts` is this round's only `packages/risk` path;
 * the rest of the append surface is a named follow-up.
 */
const COMPOSITE_PROBES: readonly Door[] = [
  { name: "evaluateIntent(entry)", run: () => evaluateIntent(POLICY, entryInput()) },
  { name: "evaluateIntent(exit)", run: () => evaluateIntent(POLICY, exitInput()) },
  {
    name: "evaluateIntent(refused: not an object)",
    run: () => evaluateIntent(POLICY, "not an evaluation input"),
  },
];

/**
 * The PERMISSION of a `RiskEvaluation`, and nothing else.
 *
 * ADR-020 §6 permits refusal COMPOSITION to vary and forbids permission to. So
 * the composite comparison carries the approval flag and the refusal codes —
 * the permission's vocabulary — and deliberately not the message text or the
 * evidence payloads.
 */
function permissionOf(run: () => unknown): string {
  try {
    const outcome = run() as {
      readonly approved?: unknown;
      readonly refusals?: readonly { readonly code?: unknown }[];
    };
    const codes = Array.isArray(outcome.refusals)
      ? outcome.refusals.map((one) => String(one.code)).sort().join(",")
      : "";
    return outcome.approved === true ? "APPROVED" : `REFUSED ${codes}`;
  } catch (error) {
    return `THREW ${(error as { constructor: { name: string } }).constructor.name}`;
  }
}

interface Divergence {
  readonly property: string;
  readonly shape: string;
  readonly door: string;
  readonly clean: string;
  readonly polluted: string;
}

function sweep(target: object): readonly Divergence[] {
  const baseline = new Map<string, string>();
  for (const door of DOORS) baseline.set(door.name, quietly(door.run));
  const moved: Divergence[] = [];
  for (const property of INDEX_NAMES) {
    for (const shape of SHAPES) {
      let installed = false;
      try {
        Object.defineProperty(target, property, shape.descriptor());
        installed = true;
        for (const door of DOORS) {
          const polluted = quietly(door.run);
          const clean = baseline.get(door.name) ?? "";
          if (polluted !== clean) {
            appendData(moved, { property, shape: shape.name, door: door.name, clean, polluted });
          }
        }
      } finally {
        if (installed) {
          Reflect.deleteProperty(target, property);
          // Deleting an index never lowers an array's length, and
          // `Array.prototype` is an array.
          if (target === Array.prototype) Array.prototype.length = 0;
        }
      }
    }
  }
  return moved;
}

function render(moved: readonly Divergence[]): readonly string[] {
  return moved.map(
    (one) =>
      `${one.property} | ${one.shape} | ${one.door}: ${one.clean.slice(0, 90)} -> ${one.polluted.slice(0, 90)}`,
  );
}

describe("THE BOUND at an index name: neither permission nor availability varies", () => {
  it("every `plain-data` door is byte-identical under every shape at every index (`Object.prototype`)", () => {
    expect(render(sweep(Object.prototype))).toEqual([]);
  });

  it("every `plain-data` door is byte-identical under every shape at every index (`Array.prototype`)", () => {
    // The lower link. `plain-data.ts` appends to ARRAYS, so a shape here is
    // found before `Object.prototype` is consulted at all.
    expect(render(sweep(Array.prototype))).toEqual([]);
  });
});

/**
 * The composite door, measured to ADR-020 §6's bound and its remainder
 * ENUMERATED.
 *
 * This is the honest edge of the round. `plain-data.ts` is closed; the rest of
 * the package is not, and pretending otherwise would repeat exactly the mistake
 * `WP-200-FU1` review round 1 found ("a pass-through for every legitimate
 * call", measurably false at `"0"`). What holds is the bound.
 */
describe("the composite door: the §6 bound holds, and the remainder is stated", () => {
  const compositeSweep = (): { readonly permission: string[]; readonly kinds: Set<string> } => {
    const baseline = new Map<string, string>();
    for (const probe of COMPOSITE_PROBES) baseline.set(probe.name, permissionOf(probe.run));
    const permission: string[] = [];
    const kinds = new Set<string>();
    for (const property of INDEX_NAMES) {
      for (const shape of SHAPES) {
        let installed = false;
        try {
          Object.defineProperty(Object.prototype, property, shape.descriptor());
          installed = true;
          for (const probe of COMPOSITE_PROBES) {
            const clean = baseline.get(probe.name) ?? "";
            const polluted = permissionOf(probe.run);
            const raw = quietly(probe.run);
            if (raw !== quietly(() => probe.run())) {
              // Two identical calls in the same window must agree: a door that
              // is not deterministic under pollution is a different finding.
              kinds.add("NONDETERMINISTIC");
            }
            if (polluted === clean) continue;
            if (polluted.startsWith("THREW")) {
              kinds.add("ESCAPE");
            } else if (clean === "APPROVED" && polluted.startsWith("REFUSED")) {
              kinds.add("AVAILABILITY");
            } else if (clean.startsWith("REFUSED") && polluted.startsWith("REFUSED")) {
              kinds.add("COMPOSITION");
            } else {
              kinds.add("PERMISSION");
            }
            appendData(permission, `${property} | ${shape.name} | ${probe.name}: ${clean} -> ${polluted}`);
          }
        } finally {
          if (installed) Reflect.deleteProperty(Object.prototype, property);
        }
      }
    }
    return { permission, kinds };
  };

  it("never turns a refusal into an approval, and never lets a throw escape", () => {
    const { kinds } = compositeSweep();
    expect([...kinds].sort()).not.toContain("PERMISSION");
    expect([...kinds].sort()).not.toContain("ESCAPE");
    expect([...kinds].sort()).not.toContain("NONDETERMINISTIC");
  });

  it("the remainder is exactly AVAILABILITY, and it is NOT empty", () => {
    // Non-vacuity in the other direction: this class is REAL and OPEN, and the
    // day the rest of the package's append surface is widened this test must be
    // deleted rather than left describing a fiction.
    //
    // MEASURED at this tip, and narrower than the class was before the fix: an
    // already-refused evaluation keeps its refusal CODES (so there is no
    // COMPOSITION move left at all), and what remains is only that an APPROVED
    // evaluation becomes a refused one — fail-closed, at an index name, from
    // the eight modules and the `zod` arena this round's grant does not reach.
    const { kinds, permission } = compositeSweep();
    expect(permission.length).toBeGreaterThan(0);
    expect([...kinds].sort()).toEqual(["AVAILABILITY"]);
    for (const row of permission) expect(row, row).toContain("APPROVED -> REFUSED");
    // The refusal vocabulary the remainder can produce, ENUMERATED so a new one
    // fails here. The third row is the get/set shape, where every array in the
    // process shares one backing slot, so the failure surfaces as the two
    // "unknown" market facts plus one refusal that is not a refusal at all.
    expect(
      [...new Set(permission.map((row) => row.slice(row.indexOf("-> ") + 3)))].sort(),
    ).toEqual([
      "REFUSED RISK_INPUT_INVALID",
      "REFUSED RISK_TIME_TO_CLOSE_UNKNOWN,RISK_TRADING_PARAMETERS_UNKNOWN,undefined",
      "REFUSED RISK_TRADING_PARAMETERS_UNKNOWN,undefined",
    ]);
  });
});

describe("NON-VACUITY: the class is real, and `push` is what carries it", () => {
  it("`Array.prototype.push` still throws at the FIRST append under a get-only `0`", () => {
    // The primitive the module used to use, measured directly. If this ever
    // stops throwing, the battery above is no longer testing anything and the
    // `appendData` comment in `plain-data.ts` is describing a fiction.
    let pushed: string;
    let defined: string;
    try {
      Object.defineProperty(Object.prototype, "0", {
        get: () => "9",
        enumerable: false,
        configurable: true,
      });
      pushed = quietly(() => {
        const target: unknown[] = [];
        target.push("first");
        return target.length;
      });
      defined = quietly(() => {
        const target: unknown[] = [];
        appendData(target, "first");
        return target.length;
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(pushed.startsWith("THREW TypeError")).toBe(true);
    expect(defined).toBe("1");
  });

  it("a READ-ONLY inherited `0` breaks `push` too — the class is not only accessors", () => {
    let pushed: string;
    try {
      Object.defineProperty(Object.prototype, "0", {
        value: "9",
        writable: false,
        enumerable: false,
        configurable: true,
      });
      pushed = quietly(() => {
        const target: unknown[] = [];
        target.push("first");
        return target.length;
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(pushed.startsWith("THREW TypeError")).toBe(true);
  });

  it("the door really does produce the appends the battery needs", () => {
    // Non-vacuity of the MATERIAL: the rich read must populate the string
    // inventory past index 6, and the broken read must produce several
    // problems, or the sweep would be polluting indices nothing reaches.
    const rich = readPlainData(RICH, "record");
    expect(rich.ok).toBe(true);
    if (rich.ok) expect(rich.strings.length).toBeGreaterThan(6);
    const bad = readPlainData(broken(), "record");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.length).toBeGreaterThan(2);
  });
});

describe("the widening did not change what the door SAYS", () => {
  it("still refuses every shape it refused, with the same paths", () => {
    const bad = readPlainData(broken(), "record");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const problems = bad.problems.map((one) => `${one.path} :: ${one.problem}`).sort();
    expect(problems.map((one) => one.split(" :: ")[0])).toEqual([
      "record.__proto__",
      "record.aBigInt",
      "record.aFunction",
      "record.aSymbolValue",
      "record.accessor",
      "record.sparse",
    ]);
    expect(problems.map((one) => (one.split(" :: ")[1] ?? "").slice(0, 22))).toEqual([
      'a "__proto__" property',
      "a record carries data,",
      "a record carries data,",
      "a record carries data,",
      "an accessor property: ",
      "a sparse array: a reco",
    ]);
  });

  it("still emits an own, prototype-free, ordered tree", () => {
    const read = readPlainData(RICH, "record");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const value = read.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.keys(value)).toEqual(["id", "nested", "list", "matrix", "flags", "count"]);
    expect(value["list"]).toEqual(["x", "y", "z", "p", "q", "r", "s", "t"]);
    expect(Array.isArray(value["list"])).toBe(true);
    expect(value["matrix"]).toEqual([["a"], ["b", "c"], []]);
    // Every element is an OWN data property of the array, not a hole.
    const list = value["list"] as unknown[];
    expect(Object.getOwnPropertyNames(list).sort()).toEqual(
      ["0", "1", "2", "3", "4", "5", "6", "7", "length"].sort(),
    );
    for (const index of ["0", "7"]) {
      const descriptor = Object.getOwnPropertyDescriptor(list, index);
      expect(descriptor?.enumerable).toBe(true);
      expect(descriptor?.writable).toBe(true);
      expect(descriptor?.configurable).toBe(true);
    }
  });
});
