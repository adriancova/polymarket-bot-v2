/**
 * THE INDEX-NAME BATTERY for `packages/decimal` (`WP-020-FU1`).
 *
 * `docs/adr/ADR-020` §6 is the bound: **permission may not vary with ambient
 * prototype state.** Three merged records found the same violation of it under
 * one property at an ARRAY-INDEX name, in the monetary primitive every other
 * package divides and subtracts through:
 *
 * - `WP-200-FU1` review round 1, NOTE-1 — `decimal.js` invents
 *   `Object.prototype["0"]` on an exactly-zero result: a fabricated
 *   `UNATTRIBUTED` slice, a residual-lot `costBasis` divergence, and
 *   `allInPnl` `"0"` → `"9"`;
 * - `WP-220` review round 1, M2 — `subDecimal` THROWS under the same pollution,
 *   reached from `walkForSize` on the ordinary path, turning an entry into a
 *   hold;
 * - `GOV-2A` follow-up 5 — `divDecimal`'s EXPLICIT-options path throws an
 *   untyped `TypeError` under `Object.prototype.set`.
 *
 * All three were reproduced at base `b4ce0aa` before anything was written, and
 * the class measured there is far wider than the three records describe: at
 * index `"0"` a writable data property FABRICATES a value, a read-only one and
 * a get-only accessor make 22 of 24 probed operations THROW (including
 * `addDecimal("1", "2")`, which has no zero anywhere in it), a get/set pair
 * makes the library LOOP, and at index `"2"` a data property exhausts the heap.
 * At index `"1"`, `divDecimal("1", "3")` answered
 * `"3.333333633333333333333333333333333"` — ten times the truth, ACCEPTED.
 *
 * WHAT THIS FILE ASSERTS, in three parts:
 *
 * 1. **THE BOUND.** Over every (index name × shape × operation) cell, the
 *    package's answer is byte-identical to the clean one. Not "fails closed" —
 *    IDENTICAL. That is the promotion the `WP-220` record asked for.
 * 2. **NON-VACUITY.** The same pollution is applied to `decimal.js` DIRECTLY,
 *    through a constructor built exactly like the package's own, and the
 *    library is shown still to fabricate. So the battery reaches the class, and
 *    part 1 is measuring the guard rather than an accident of the material.
 * 3. **THE GUARD RESTORES WHAT IT BORROWED.** The neutralization is a temporary
 *    mutation of two intrinsics; a battery that did not check the restoration
 *    would be trading one hazard for a worse one.
 *
 * TWO RULES, inherited from `test/unit/ledger/pollution.ts`: no `expect` runs
 * inside a polluted window (an inherited `get` makes every
 * `Object.defineProperty` throw, so a battery that asserts while polluted
 * measures its own assertion library), and no own property of an intrinsic is
 * ever replaced — every name used here is an index name, which neither
 * `Object.prototype` nor `Array.prototype` owns.
 *
 * SCOPE. Every shape below is CONFIGURABLE, because a non-configurable one
 * cannot be removed and would poison the whole worker for every later test
 * file. The non-configurable shapes were measured in a `/dev/shm` scratch
 * process instead, and the result — `Object.prototype` fully covered by the
 * `Array.prototype` fallback, `Array.prototype` itself fail-closed — is
 * recorded at `packages/decimal/src/prototype-guard.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  absDecimal,
  addDecimal,
  compareDecimal,
  divDecimal,
  divDecimalExact,
  equalsDecimal,
  isNegativeDecimal,
  isZeroDecimal,
  mulDecimal,
  negateDecimal,
  subDecimal,
  type DivisionOptions,
} from "../../../packages/decimal/src/arithmetic.js";
import { DecimalRangeError } from "../../../packages/decimal/src/errors.js";
import { assertTickConformant, isTickConformant } from "../../../packages/decimal/src/tick.js";

/**
 * Appends without `push`.
 *
 * `push` is `Set` at an index name, which is the exact thing this file
 * pollutes: the first append to an empty array throws under a get-only
 * `Object.prototype["0"]`, and the first draft of the `WP-200-FU1` harness was
 * defeated that way WHILE RECORDING A DIVERGENCE.
 */
function appendData<T>(target: T[], value: T): void {
  const descriptor = Object.create(null) as Record<string, unknown>;
  descriptor["value"] = value;
  descriptor["writable"] = true;
  descriptor["enumerable"] = true;
  descriptor["configurable"] = true;
  Object.defineProperty(target, `${target.length}`, descriptor);
}

/** One measured pollution shape. All configurable — see the file header. */
interface Shape {
  readonly name: string;
  readonly descriptor: () => PropertyDescriptor;
}

const SHAPES: readonly Shape[] = [
  // A plausible digit: the shape that FABRICATES rather than throws.
  { name: "data-NE-9", descriptor: () => ({ value: "9", writable: true, enumerable: false, configurable: true }) },
  { name: "data-E-1", descriptor: () => ({ value: 1, writable: true, enumerable: true, configurable: true }) },
  {
    name: "data-NE-uuid",
    descriptor: () => ({
      value: "01936f00-0000-7000-8000-0000000000ff",
      writable: true,
      enumerable: false,
      configurable: true,
    }),
  },
  // Read-only and accessor shapes: `Set` at an absent index cannot complete.
  { name: "data-readonly", descriptor: () => ({ value: "9", writable: false, enumerable: false, configurable: true }) },
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
  // A get/set PAIR. At base this one did not throw or fabricate — it made the
  // library LOOP, so a battery without it would have missed a liveness failure.
  {
    name: "accessor-get-set",
    descriptor: () => {
      const held = Object.create(null) as Record<string, unknown>;
      return {
        get: () => held["v"] ?? "9",
        set: (value: unknown) => {
          held["v"] = value;
        },
        enumerable: false,
        configurable: true,
      };
    },
  },
  { name: "fn-false", descriptor: () => ({ value: () => false, writable: true, enumerable: false, configurable: true }) },
];

/**
 * The index names swept.
 *
 * `"0"` is the one an empty digit array reaches first and the one all three
 * records name. `"1"`, `"2"` and `"3"` are the ones the base measurement found
 * ALSO live — `divDecimal("1", "3")` moved at `"1"`, `mulDecimal` exhausted the
 * heap at `"2"` — so a battery pinned to `"0"` alone would have understated the
 * class by three orders of magnitude. `"12"` is a control at an index no digit
 * array in this material reaches.
 */
const INDEX_NAMES: readonly string[] = ["0", "1", "2", "3", "12"];

/** One probe: a name and a total function producing a comparable string. */
interface Probe {
  readonly name: string;
  readonly run: () => string;
}

function quietly(run: () => unknown): string {
  try {
    const value = run();
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch (error) {
    const thrown = error as { constructor: { name: string }; message?: unknown };
    return `THREW ${thrown.constructor.name}: ${String(thrown.message)}`;
  }
}

/**
 * The probe set: exactly-zero results (the recorded class), NON-zero results
 * (the class is not confined to zeros), the two division entry points, the
 * comparison and sign predicates, and the §16.2 tick gate.
 */
const PROBES: readonly Probe[] = [
  // Exactly-zero results reached by CANCELLATION — the fabrication route.
  { name: "add(100,-100)", run: () => addDecimal("100", "-100") },
  { name: "sub(50,50)", run: () => subDecimal("50", "50") },
  { name: "sub(0.3,0.3)", run: () => subDecimal("0.3", "0.3") },
  { name: "sub(1.5,1.5)", run: () => subDecimal("1.5", "1.5") },
  { name: "add(0.07,-0.07)", run: () => addDecimal("0.07", "-0.07") },
  // Zero from a zero OPERAND, which takes a different path in the library.
  { name: "mul(0,5)", run: () => mulDecimal("0", "5") },
  { name: "div(0,5)", run: () => divDecimal("0", "5") },
  { name: "divExact(0,5)", run: () => divDecimalExact("0", "5") },
  // Non-zero results, short and long.
  { name: "add(1,2)", run: () => addDecimal("1", "2") },
  { name: "add(0.1,0.2)", run: () => addDecimal("0.1", "0.2") },
  { name: "sub(1000000000000,1)", run: () => subDecimal("1000000000000", "1") },
  { name: "mul(123456789,987654321)", run: () => mulDecimal("123456789", "987654321") },
  { name: "add(long)", run: () => addDecimal("12345678901234567890.123456789", "0.000000001") },
  // Division, default and explicit, terminating and not.
  { name: "div(1,3)", run: () => divDecimal("1", "3") },
  { name: "div(2,4)", run: () => divDecimal("2", "4") },
  { name: "div(2,3,{precision:4})", run: () => divDecimal("2", "3", { precision: 4 }) },
  { name: "div(2,3,{precision:4,rounding:1})", run: () => divDecimal("2", "3", { precision: 4, rounding: 1 }) },
  { name: "divExact(1,8)", run: () => divDecimalExact("1", "8") },
  { name: "divExact(1,3)", run: () => divDecimalExact("1", "3") },
  { name: "div(1,0)", run: () => divDecimal("1", "0") },
  // Comparison, sign and absolute value.
  { name: "cmp(1,1)", run: () => String(compareDecimal("1", "1")) },
  { name: "cmp(0.1,0.2)", run: () => String(compareDecimal("0.1", "0.2")) },
  { name: "eq(0.1,0.1)", run: () => String(equalsDecimal("0.1", "0.1")) },
  { name: "neg(1.5)", run: () => negateDecimal("1.5") },
  { name: "neg(0)", run: () => negateDecimal("0") },
  { name: "abs(-2.5)", run: () => absDecimal("-2.5") },
  { name: "isZero(0.0000001)", run: () => String(isZeroDecimal("0.0000001")) },
  { name: "isNeg(-1)", run: () => String(isNegativeDecimal("-1")) },
  // The §16.2 tick gate: a safety check, not just arithmetic.
  { name: "tick(0.07,0.01)", run: () => String(isTickConformant("0.07", "0.01")) },
  { name: "tick(0.075,0.01)", run: () => String(isTickConformant("0.075", "0.01")) },
  { name: "assertTick(0.075,0.01)", run: () => assertTickConformant("0.075", "0.01") },
  // A refusal arm: composition must not vary either, for this package.
  { name: "add(1e5,1)", run: () => addDecimal("1e5", "1") },
];

/** One cell whose answer moved. */
interface Divergence {
  readonly property: string;
  readonly shape: string;
  readonly probe: string;
  readonly clean: string;
  readonly polluted: string;
}

/**
 * Runs every probe clean, then under every (name × shape), and returns every
 * answer that moved. `target` selects which intrinsic carries the pollution.
 */
function sweep(target: object, names: readonly string[] = INDEX_NAMES): readonly Divergence[] {
  const baseline = new Map<string, string>();
  for (const probe of PROBES) baseline.set(probe.name, quietly(probe.run));
  const moved: Divergence[] = [];
  for (const property of names) {
    for (const shape of SHAPES) {
      let installed = false;
      try {
        Object.defineProperty(target, property, shape.descriptor());
        installed = true;
        for (const probe of PROBES) {
          const polluted = quietly(probe.run);
          const clean = baseline.get(probe.name) ?? "";
          if (polluted !== clean) {
            appendData(moved, { property, shape: shape.name, probe: probe.name, clean, polluted });
          }
        }
      } finally {
        if (installed) {
          Reflect.deleteProperty(target, property);
          // Deleting an index does NOT lower an array's length, and
          // `Array.prototype` is itself an array — so a sweep over it leaves
          // `Array.prototype.length` at 13 unless the harness puts it back.
          // Found by this file's own restoration test, which is the point of
          // having one.
          if (target === Array.prototype) Array.prototype.length = 0;
        }
      }
    }
  }
  return moved;
}

function render(moved: readonly Divergence[]): readonly string[] {
  return moved.map(
    (one) => `${one.property} | ${one.shape} | ${one.probe}: ${one.clean} -> ${one.polluted}`,
  );
}

describe("THE BOUND: no arithmetic answer varies with an index name on a prototype", () => {
  it("is byte-identical under every shape at every index, on `Object.prototype`", () => {
    expect(render(sweep(Object.prototype))).toEqual([]);
  });

  it("is byte-identical under every shape at every index, on `Array.prototype`", () => {
    // `Array.prototype` is the LOWER link, and the guard must scan it too: a
    // digit array finds it first, so a shape here defeats a guard that only
    // knows about `Object.prototype`. (MUTATION: dropping the `Array.prototype`
    // scan from `indexNamesOwnedBy`'s two call sites fails exactly this test.)
    expect(render(sweep(Array.prototype))).toEqual([]);
  });

  it("is byte-identical with BOTH prototypes polluted at once", () => {
    const baseline = new Map<string, string>();
    for (const probe of PROBES) baseline.set(probe.name, quietly(probe.run));
    const moved: string[] = [];
    for (const property of ["0", "1"]) {
      let installed = false;
      try {
        Object.defineProperty(Object.prototype, property, { value: "9", writable: true, enumerable: false, configurable: true });
        Object.defineProperty(Array.prototype, property, { value: "7", writable: true, enumerable: false, configurable: true });
        installed = true;
        for (const probe of PROBES) {
          const polluted = quietly(probe.run);
          const clean = baseline.get(probe.name) ?? "";
          if (polluted !== clean) appendData(moved, `${property} | ${probe.name}: ${clean} -> ${polluted}`);
        }
      } finally {
        if (installed) {
          Reflect.deleteProperty(Object.prototype, property);
          Reflect.deleteProperty(Array.prototype, property);
        }
      }
    }
    expect(moved).toEqual([]);
  });
});

describe("the guard restores the intrinsics it borrows", () => {
  const descriptorOf = (target: object, name: string): string =>
    JSON.stringify(Object.getOwnPropertyDescriptor(target, name) ?? null, (_key, value: unknown) =>
      typeof value === "function" ? "<fn>" : value,
    );

  it("leaves an index property on `Object.prototype` exactly as it found it", () => {
    let before: string;
    let after: string;
    try {
      Object.defineProperty(Object.prototype, "0", {
        value: "9",
        writable: false,
        enumerable: true,
        configurable: true,
      });
      before = descriptorOf(Object.prototype, "0");
      addDecimal("100", "-100");
      after = descriptorOf(Object.prototype, "0");
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(after).toBe(before);
    expect(after).toContain('"value":"9"');
    expect(after).toContain('"writable":false');
    expect(after).toContain('"enumerable":true');
  });

  it("adds nothing to `Array.prototype` and leaves its length where it found it", () => {
    const lengthBefore = Array.prototype.length;
    let names: readonly string[];
    let length: number;
    try {
      Object.defineProperty(Object.prototype, "0", {
        value: "9",
        writable: true,
        enumerable: false,
        configurable: true,
      });
      subDecimal("50", "50");
      names = Object.getOwnPropertyNames(Array.prototype);
      length = Array.prototype.length;
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(names.filter((name) => /^(?:0|[1-9][0-9]*)$/u.test(name))).toEqual([]);
    expect(length).toBe(lengthBefore);
  });

  it("restores even when the operation THROWS", () => {
    let after: string;
    let threw: boolean;
    try {
      Object.defineProperty(Object.prototype, "0", {
        value: "9",
        writable: true,
        enumerable: false,
        configurable: true,
      });
      threw = quietly(() => divDecimal("1", "0")).startsWith("THREW");
      after = descriptorOf(Object.prototype, "0");
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(threw).toBe(true);
    expect(after).toContain('"value":"9"');
  });

  it("mutates NOTHING in an honest process", () => {
    // The fast path is what makes honest-path byte-identity structural rather
    // than tested-for: with no index name on either intrinsic, the guard scans,
    // finds none, and calls straight through.
    const objectBefore = Object.getOwnPropertyNames(Object.prototype).join(",");
    const arrayBefore = Object.getOwnPropertyNames(Array.prototype).join(",");
    for (const probe of PROBES) quietly(probe.run);
    expect(Object.getOwnPropertyNames(Object.prototype).join(",")).toBe(objectBefore);
    expect(Object.getOwnPropertyNames(Array.prototype).join(",")).toBe(arrayBefore);
  });
});

describe("`divDecimal` explicit options: own data only, typed refusals (GOV-2A follow-up 5)", () => {
  it("the explicit-options path survives `Object.prototype.set` (probe J1/J2)", () => {
    // At base this answered `TypeError: Cannot set property set of #<Object>
    // which has only a getter` — `Decimal.clone` assigns `Decimal.set` on the
    // constructor it is building, and an assignment consults the chain. The
    // fix is a MODULE-LOAD-TIME constructor for the explicit path too.
    const clean = divDecimal("2", "3", { precision: 4 });
    let polluted: string;
    try {
      Object.defineProperty(Object.prototype, "set", {
        get: () => 1,
        enumerable: false,
        configurable: true,
      });
      polluted = quietly(() => divDecimal("2", "3", { precision: 4 }));
    } finally {
      Reflect.deleteProperty(Object.prototype, "set");
    }
    expect(clean).toBe("0.6667");
    expect(polluted).toBe("0.6667");
  });

  it("an INHERITED `precision` cannot change a monetary answer", () => {
    // At base, `divDecimal("2", "3", {})` answered "0.67" with
    // `Object.prototype.precision = 2` — a PERMISSION-class change from ambient
    // state, on an empty options object the caller supplied honestly.
    const clean = divDecimal("2", "3", {});
    const moved: string[] = [];
    for (const [name, value] of [
      ["precision", 2],
      ["rounding", 1],
    ] as const) {
      let polluted: string;
      try {
        Object.defineProperty(Object.prototype, name, {
          value,
          writable: true,
          enumerable: false,
          configurable: true,
        });
        polluted = quietly(() => divDecimal("2", "3", {}));
      } finally {
        Reflect.deleteProperty(Object.prototype, name);
      }
      if (polluted !== clean) appendData(moved, `${name}: ${clean} -> ${polluted}`);
    }
    expect(clean).toBe("0.6666666666666666666666666666666667");
    expect(moved).toEqual([]);
  });

  it("the documented defaults are unchanged, for every spelling of `no options`", () => {
    const expected = "0.6666666666666666666666666666666667";
    expect(divDecimal("2", "3")).toBe(expected);
    expect(divDecimal("2", "3", undefined)).toBe(expected);
    expect(divDecimal("2", "3", {})).toBe(expected);
    // `exactOptionalPropertyTypes` makes an EXPLICIT `undefined` untypable, so
    // these three are forged: they are the shapes a JavaScript caller, or a
    // spread of a partially-filled record, actually produces. `undefined` means
    // absent — `zod`'s own rule for when a default applies, and the rule this
    // package documented before this round too.
    const forged = (value: unknown): DivisionOptions => value as DivisionOptions;
    expect(divDecimal("2", "3", forged({ precision: undefined }))).toBe(expected);
    expect(divDecimal("2", "3", forged({ rounding: undefined }))).toBe(expected);
    expect(divDecimal("2", "3", forged({ precision: undefined, rounding: undefined }))).toBe(
      expected,
    );
    // And the documented explicit contract (`docs/contracts/domain.md`).
    expect(divDecimal("2", "3", { precision: 4 })).toBe("0.6667");
    expect(divDecimal("2", "3", { precision: 4, rounding: 1 })).toBe("0.6666");
    expect(divDecimal("1", "3", { precision: 34 })).toBe(divDecimal("1", "3"));
  });

  it("refuses a malformed option with a TYPED error, and never runs a getter", () => {
    let ran = 0;
    expect(() =>
      divDecimal("1", "3", {
        get precision(): number {
          ran += 1;
          return 4;
        },
      }),
    ).toThrow(DecimalRangeError);
    // Values come from the DESCRIPTOR: the getter is refused, not invoked.
    expect(ran).toBe(0);
    for (const options of [
      { rounding: 99 as never },
      { rounding: -1 as never },
      { rounding: 1.5 as never },
      { rounding: "ROUND_UP" as never },
      4 as never,
      "x" as never,
      true as never,
    ]) {
      expect(() => divDecimal("1", "3", options), JSON.stringify(options ?? null)).toThrow(
        DecimalRangeError,
      );
    }
    // The precision arm keeps its own code (Wave 0 closeout L9), unchanged.
    try {
      divDecimal("1", "3", { precision: 0 });
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as DecimalRangeError).code).toBe("DECIMAL_INVALID_PRECISION");
    }
    try {
      divDecimal("1", "3", { rounding: 99 as never });
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as DecimalRangeError).code).toBe("DECIMAL_INVALID_OPTIONS");
    }
  });

  it("an inherited option field cannot make an EXPLICIT call read a second field", () => {
    // `{ precision: 4 }` with an inherited `rounding`: the explicit field is
    // honoured, the inherited one is not seen at all.
    const clean = divDecimal("2", "3", { precision: 4 });
    let polluted: string;
    try {
      Object.defineProperty(Object.prototype, "rounding", {
        value: 1,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      polluted = quietly(() => divDecimal("2", "3", { precision: 4 }));
    } finally {
      Reflect.deleteProperty(Object.prototype, "rounding");
    }
    expect(clean).toBe("0.6667");
    expect(polluted).toBe("0.6667");
  });
});
