/**
 * Checkpointable JSON and the canonical serializer.
 *
 * These two functions are what make §12.4 byte-identity and §10.3
 * `state_checkpoints.state_hash` well-defined: the grammar refuses any value
 * whose identity would change on a JSON round trip, and the serializer emits
 * one spelling per value regardless of key insertion order.
 *
 * The refusals are deliberately noisy rather than tolerant — a `Date`, a `Map`,
 * or a `-0` in strategy state serializes "successfully" through `JSON.stringify`
 * and comes back as something else, which is a replay divergence that no test
 * downstream would attribute to its cause.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  deepFreeze,
  materializeCheckpointableJson,
} from "../../../packages/strategy-runtime/src/index.js";

/**
 * The validate-only shape these tests were written against.
 *
 * `checkpointableJsonProblem` was REMOVED from the package in remediation round
 * 3 (review round 3's LOW): a public validate-then-retain predicate invites the
 * workflow that produced round 2's HIGH. Every assertion below is unchanged —
 * the walk is the same walk — but it now runs through the materializer with the
 * copy discarded, which is what the deleted export did internally.
 */
function problemOf(value: unknown): string | null {
  const result = materializeCheckpointableJson(value);
  return result.ok ? null : result.problem;
}

describe("the checkpointable-JSON grammar", () => {
  it("accepts the JSON value grammar", () => {
    expect(problemOf(null)).toBeNull();
    expect(problemOf(true)).toBeNull();
    expect(problemOf(0)).toBeNull();
    expect(problemOf(-1.5)).toBeNull();
    expect(problemOf("0.01")).toBeNull();
    expect(problemOf([])).toBeNull();
    expect(problemOf({})).toBeNull();
    expect(
      problemOf({ a: [1, "x", null, { b: false }], c: Object.create(null) }),
    ).toBeNull();
  });

  it("rejects values that do not survive a JSON round trip, naming the path", () => {
    const cases: Array<[unknown, string]> = [
      [{ a: undefined }, "$.a"],
      [{ a: () => 1 }, "$.a"],
      [{ a: Symbol("s") }, "$.a"],
      [{ a: 1n }, "$.a"],
      [{ a: Number.NaN }, "$.a"],
      [{ a: Number.POSITIVE_INFINITY }, "$.a"],
      [{ a: -0 }, "$.a"],
      [[1, [2, { deep: undefined }]], "$[1][1].deep"],
    ];
    for (const [value, path] of cases) {
      const problem = problemOf(value);
      expect(problem, JSON.stringify(path)).not.toBeNull();
      expect(problem).toContain(path);
    }
  });

  it("rejects class instances, Date, Map, and Set — their JSON forms lose information", () => {
    class Holder {
      value = 1;
    }
    for (const value of [new Holder(), new Date(0), new Map(), new Set(), /re/]) {
      expect(problemOf({ a: value }), String(value)).toContain(
        "only plain objects are checkpointable",
      );
    }
  });

  it("rejects a circular structure instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(problemOf(cyclic)).toContain("circular structure");
  });

  it("accepts the same object graph reached twice by different paths (a DAG is not a cycle)", () => {
    const shared = { x: 1 };
    expect(problemOf({ a: shared, b: shared })).toBeNull();
  });
});

describe("canonicalJsonStringify", () => {
  it("sorts object keys so insertion order cannot change the bytes", () => {
    const first = canonicalJsonStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const second = canonicalJsonStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(first).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
    expect(second).toBe(first);
  });

  it("preserves array order (arrays are sequences, not sets)", () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJsonStringify([3, 1, 2])).not.toBe(canonicalJsonStringify([1, 2, 3]));
  });

  it("serializes scalars exactly as JSON does, including escapes", () => {
    expect(canonicalJsonStringify(null)).toBe("null");
    expect(canonicalJsonStringify(true)).toBe("true");
    expect(canonicalJsonStringify(12)).toBe("12");
    expect(canonicalJsonStringify('quote " and \\ and \n')).toBe(
      JSON.stringify('quote " and \\ and \n'),
    );
    expect(canonicalJsonStringify({ "éé": "ü" })).toBe(JSON.stringify({ "éé": "ü" }));
  });

  it("round-trips through JSON.parse to an equal value", () => {
    const value = { b: [1, { d: null, c: "0.5" }], a: true };
    expect(JSON.parse(canonicalJsonStringify(value))).toEqual(value);
  });

  it("is idempotent: canonical bytes re-parsed and re-serialized are identical", () => {
    const once = canonicalJsonStringify({ z: 1, a: { c: [2, 3], b: "x" } });
    expect(canonicalJsonStringify(JSON.parse(once))).toBe(once);
  });
});

describe("deepFreeze", () => {
  it("freezes nested objects and arrays in place and returns the same reference", () => {
    const value = { a: { b: [{ c: 1 }] } };
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[0])).toBe(true);
  });

  it("is cycle-safe", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => deepFreeze(cyclic)).not.toThrow();
    expect(Object.isFrozen(cyclic)).toBe(true);
  });

  it("passes primitives through untouched", () => {
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze("a")).toBe("a");
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
  });
});
