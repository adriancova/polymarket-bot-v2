/**
 * The input boundary: hostile shapes are refused with a path, benign shapes
 * come back as fresh prototype-free own data, and no caller getter ever runs.
 */

import { describe, expect, it } from "vitest";

import { MAX_INPUT_DEPTH, materializeInput } from "./materialize.js";

function problems(value: unknown): string {
  const read = materializeInput(value, "input");
  if (read.ok) return "";
  return read.problems.map((problem) => `${problem.path}: ${problem.problem}`).join(" | ");
}

describe("materializeInput", () => {
  it("copies plain data into a fresh prototype-free tree", () => {
    const original = { a: "x", nested: { b: 1, list: [1, "two", true] } };
    const read = materializeInput(original, "input");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const tree = read.value as Record<string, unknown>;
    expect(tree).not.toBe(original);
    expect(Object.getPrototypeOf(tree)).toBeNull();
    expect(Object.getPrototypeOf(tree["nested"])).toBeNull();
    expect(tree["a"]).toBe("x");
    expect((tree["nested"] as Record<string, unknown>)["list"]).toEqual([1, "two", true]);
    // Mutating the original after the read cannot reach the tree.
    original.a = "changed";
    expect(tree["a"]).toBe("x");
  });

  it("accepts a null-prototype input object (absence of a prototype is the safe shape)", () => {
    const input = Object.create(null) as Record<string, unknown>;
    input["a"] = "x";
    const read = materializeInput(input, "input");
    expect(read.ok).toBe(true);
  });

  it("refuses an accessor property WITHOUT invoking the getter", () => {
    let invoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "price", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "0.5";
      },
    });
    const report = problems({ trade: hostile });
    expect(report).toContain("input.trade.price");
    expect(report).toContain("accessor");
    expect(invoked).toBe(false);
  });

  it("refuses symbol keys, functions, bigints, and non-plain prototypes", () => {
    expect(problems({ [Symbol("k")]: 1 })).toContain("symbol-keyed");
    expect(problems({ f: () => 1 })).toContain("not a function");
    expect(problems({ n: 1n })).toContain("not a bigint");
    class Custom {
      value = 1;
    }
    expect(problems({ c: new Custom() })).toContain("non-plain prototype");
    expect(problems({ m: new Map() })).toContain("non-plain prototype");
    expect(problems({ d: Object.create({ inherited: true }) as object })).toContain("non-plain prototype");
  });

  it('refuses a "__proto__" own property by name', () => {
    const hostile = {};
    Object.defineProperty(hostile, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(problems(hostile)).toContain('input.__proto__: a "__proto__" property');
  });

  it("does NOT copy inherited enumerable properties from a polluted Object.prototype", () => {
    (Object.prototype as Record<string, unknown>)["pollutedField"] = "adopted?";
    try {
      const read = materializeInput({ a: "x" }, "input");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const tree = read.value as Record<string, unknown>;
      expect(Object.keys(tree)).toEqual(["a"]);
      // And the read of the absent name answers undefined, not the pollution.
      expect(tree["pollutedField"]).toBeUndefined();
    } finally {
      delete (Object.prototype as Record<string, unknown>)["pollutedField"];
    }
  });

  it("materializes even when Object.prototype carries a get-only accessor descriptor field", () => {
    // The WP-180 round-8 descriptor hazard: an inherited `get` makes every
    // object-literal descriptor an accessor descriptor. The materializer's
    // descriptors are prototype-free, so defineProperty still works. The
    // results are captured as primitives INSIDE the polluted region and
    // asserted after cleanup — the assertion library itself uses literal
    // descriptors and would otherwise trip on the pollution (measured here).
    let readOk: boolean | undefined;
    let readA: unknown;
    Object.defineProperty(Object.prototype, "get", {
      configurable: true,
      get() {
        return "1000";
      },
    });
    try {
      const read = materializeInput({ a: "x", b: { c: "y" } }, "input");
      readOk = read.ok;
      readA = read.ok ? (read.value as Record<string, unknown>)["a"] : undefined;
    } finally {
      delete (Object.prototype as Record<string, unknown>)["get"];
    }
    expect(readOk).toBe(true);
    expect(readA).toBe("x");
  });

  it("refuses cycles, sparse arrays, non-index array properties, and length lies", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(problems(cyclic)).toContain("cycle");

    // eslint-disable-next-line no-sparse-arrays
    expect(problems({ list: [1, , 3] })).toContain("sparse");

    const tagged = [1, 2] as unknown as Record<string, unknown>;
    tagged["extra"] = true;
    expect(problems({ list: tagged })).toContain("non-index property");
  });

  it("shares a sub-object across two paths without calling it a cycle", () => {
    const shared = { v: 1 };
    const read = materializeInput({ a: shared, b: shared }, "input");
    expect(read.ok).toBe(true);
  });

  it(`refuses nesting deeper than ${MAX_INPUT_DEPTH} levels`, () => {
    let value: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < MAX_INPUT_DEPTH + 1; index += 1) {
      value = { child: value };
    }
    expect(problems(value)).toContain("nested deeper");
  });

  it("treats an explicitly-undefined member as absent (one representation of absence)", () => {
    const read = materializeInput({ a: "x", missing: undefined }, "input");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Object.keys(read.value as Record<string, unknown>)).toEqual(["a"]);
  });

  it("is total: a throwing Proxy trap becomes a refusal, never an exception", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    const read = materializeInput({ nested: hostile }, "input");
    expect(read.ok).toBe(false);
  });
});
