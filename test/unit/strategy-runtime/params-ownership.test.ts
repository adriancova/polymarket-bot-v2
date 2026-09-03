/**
 * Params ownership (remediation round 4, 2026-09-03 — review round 4's HIGH 2
 * and MEDIUM 3).
 *
 * Rounds 1–3 established that every caller-supplied value crossing into this
 * package is materialized ONCE into inert data. Round 3 then argued params were
 * a deliberate exception: "a `paramsSchema` may legitimately produce a non-JSON
 * value, and params never enter a record, a checkpoint, or a replay
 * comparison", so guarding and freezing them was enough. Review round 4
 * disproved that with two probes against the round-3 code:
 *
 * ```
 * bothFrozen=[true,true]
 * decisionA.reasonCodes=["MAP.9"]
 * decisionB.reasonCodes=["MAP.1"]
 * equal=false
 *
 * reads=5  first=GETTER.2.3  second=GETTER.4.5
 * ```
 *
 * Two runtimes with identical run identity, input, seed and initially identical
 * `Map` params produced DIFFERENT decisions after the caller mutated the map it
 * still held — `Object.freeze(new Map())` does not freeze the map's entries —
 * and a frozen accessor object answered five reads with five values. Both are
 * determinism breaks reachable through `ctx.params()`, and both mean the
 * context was not exclusively runtime-owned.
 *
 * The grammar this file pins: supported plain data is MATERIALIZED into the
 * runtime's own copy, and an internally mutable or accessor-bearing value is
 * REFUSED with a typed `PARAMS_NOT_MATERIALIZABLE`. There is no implicit escape
 * hatch, and the alternative for a strategy that wants a derived structure is
 * stated in `outcomes.ts`: build it in `onStart` from the materialized params
 * and keep it on the strategy object, which is the receiver of every callback.
 */

import { describe, expect, it } from "vitest";

import {
  createStrategyInstanceRuntime,
  type CreateRuntimeResult,
} from "../../../packages/strategy-runtime/src/index.js";
import type { DecisionResult, StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import {
  makeDefinition,
  makeInput,
  makeStrategy,
  RecordingSink,
  SNAPSHOT_REF,
} from "./helpers.js";

/** A strategy whose decision reports whatever `read` extracts from the params. */
function reportingStrategy(read: (params: unknown) => string) {
  return makeStrategy({
    onFeatures: (ctx: StrategyContext): DecisionResult => ({
      decisionType: "hold",
      reasonCodes: [read(ctx.params())],
      featureSnapshotRef: SNAPSHOT_REF,
      intents: [],
    }),
  });
}

function created(overrides: Parameters<typeof makeDefinition>[0]): CreateRuntimeResult {
  return createStrategyInstanceRuntime(makeDefinition(overrides).definition);
}

/**
 * A structural comparator written for this file, deliberately NOT the product's
 * walk and not `JSON.stringify` (which silently drops `undefined` and would
 * agree with a copy that lost it). Round 4 caught a sibling package precisely
 * because its test oracle repeated the product's own enumeration.
 */
function sameShape(left: unknown, right: unknown, path = "$"): string | null {
  if (Object.is(left, right)) {
    return typeof left === "object" && left !== null ? `${path}: shares an object identity` : null;
  }
  if (typeof left !== typeof right) {
    return `${path}: typeof ${typeof left} vs ${typeof right}`;
  }
  if (left === null || right === null) {
    return `${path}: ${String(left)} vs ${String(right)}`;
  }
  if (typeof left !== "object") {
    return `${path}: ${String(left)} vs ${String(right)}`;
  }
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) {
    return `${path}: array vs object`;
  }
  const leftKeys = Reflect.ownKeys(left).map(String).sort();
  const rightKeys = Reflect.ownKeys(right as object).map(String).sort();
  if (leftKeys.join("|") !== rightKeys.join("|")) {
    return `${path}: keys ${leftKeys.join(",")} vs ${rightKeys.join(",")}`;
  }
  for (const key of leftKeys) {
    const problem = sameShape(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      `${path}.${key}`,
    );
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

/**
 * Every object identity reachable from `left` that is ALSO reachable from
 * `right`. An empty result is the ownership property: the runtime's copy and
 * the caller's graph have no node in common, so no later mutation of one can be
 * observed through the other.
 */
function sharedObjects(left: unknown, right: unknown): string[] {
  const reachable = (root: unknown): Set<object> => {
    const found = new Set<object>();
    const stack: unknown[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === null || typeof current !== "object" || found.has(current)) {
        continue;
      }
      found.add(current);
      for (const key of Reflect.ownKeys(current)) {
        stack.push((current as Record<PropertyKey, unknown>)[key]);
      }
    }
    return found;
  };
  const rightSide = reachable(right);
  return [...reachable(left)]
    .filter((node) => rightSide.has(node))
    .map((node) => (Array.isArray(node) ? "array" : "object"));
}

describe("HIGH 2: params are the runtime's own inert data, or they are refused", () => {
  it("the reviewer's Map transcript: a Map is refused, so no caller can mutate what ctx.params() answers", () => {
    const result = created({ params: new Map([["k", "1"]]) });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusal.code).toBe("PARAMS_NOT_MATERIALIZABLE");
    expect(result.refusal.detail).toContain("Map");
  });

  it("the property the reviewer's probe rests on: freezing a Map does not freeze its entries", () => {
    // The oracle for WHY freezing was never enough, independent of this package.
    const map = new Map([["k", "1"]]);
    Object.freeze(map);
    expect(Object.isFrozen(map)).toBe(true);
    map.set("k", "9");
    expect(map.get("k")).toBe("9");

    // The same for an accessor: freezing makes the property non-configurable,
    // not the getter inert.
    let reads = 0;
    const accessor = Object.freeze({
      get a(): number {
        reads += 1;
        return reads;
      },
    });
    expect(Object.isFrozen(accessor)).toBe(true);
    expect(accessor.a).toBe(1);
    expect(accessor.a).toBe(2);
  });

  it("the reviewer's getter transcript: an accessor-bearing params object is refused, never read five times", () => {
    let reads = 0;
    const accessorParams = {
      get a(): number {
        reads += 1;
        return reads;
      },
    };
    const result = created({ params: accessorParams });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("PARAMS_NOT_MATERIALIZABLE");
      expect(result.refusal.detail).toContain("accessor");
    }
    // The getter was refused on its DESCRIPTOR, so it was never invoked: the
    // round-1 rule that validating configuration must not execute caller code.
    expect(reads).toBe(0);
  });

  it("determinism, restated as the property the finding broke: identical config ⇒ identical decisions", () => {
    // The plain-data equivalent of the reviewer's two-runtime probe. The caller
    // keeps its object and mutates it after creation; both runs must still
    // agree, because neither reads that object again.
    type RuntimeHandle = Extract<CreateRuntimeResult, { ok: true }>["runtime"];
    const build = (
      params: Record<string, unknown>,
    ): { runtime: RuntimeHandle; sink: RecordingSink } => {
      const sink = new RecordingSink();
      const result = createStrategyInstanceRuntime(
        makeDefinition({
          params,
          decisionSink: sink,
          strategy: reportingStrategy(
            (value) => `PARAM.${String((value as { k?: unknown }).k)}`,
          ),
        }).definition,
      );
      if (!result.ok) {
        throw new Error(`${result.refusal.code}: ${result.refusal.detail}`);
      }
      return { runtime: result.runtime, sink };
    };
    const paramsA: Record<string, unknown> = { k: "1" };
    const paramsB: Record<string, unknown> = { k: "1" };
    const a = build(paramsA);
    const b = build(paramsB);

    // Post-creation producer mutation, on ONE of the two only.
    paramsA["k"] = "9";
    paramsA["injected"] = "late";

    expect(a.runtime.evaluate(makeInput()).kind).toBe("DECIDED");
    expect(b.runtime.evaluate(makeInput()).kind).toBe("DECIDED");
    const decisionA = a.sink.calls[0]?.record.decision;
    const decisionB = b.sink.calls[0]?.record.decision;
    expect(decisionA?.reasonCodes).toEqual(["PARAM.1"]);
    expect(decisionB?.reasonCodes).toEqual(["PARAM.1"]);
    expect(JSON.stringify(decisionA)).toBe(JSON.stringify(decisionB));
    // And the producer's object was neither frozen nor otherwise taken over.
    expect(Object.isFrozen(paramsA)).toBe(false);
    expect(paramsA["k"]).toBe("9");
  });

  it("repeated reads inside and across evaluations answer the same thing, and share no object with the caller", () => {
    const caller: Record<string, unknown> = { nested: { deep: ["a", "b"] }, n: 1 };
    const seen: unknown[] = [];
    const result = createStrategyInstanceRuntime(
      makeDefinition({
        params: caller,
        strategy: reportingStrategy((params) => {
          seen.push(params);
          return "TEST.HOLD";
        }),
      }).definition,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.runtime.evaluate(makeInput()).kind).toBe("DECIDED");
    // A producer that mutates its own object between evaluations changes
    // nothing about the second one.
    (caller["nested"] as { deep: string[] }).deep.push("c");
    caller["n"] = 99;
    expect(result.runtime.evaluate(makeInput()).kind).toBe("DECIDED");

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).not.toBe(caller);
    expect(sameShape(seen[0], { nested: { deep: ["a", "b"] }, n: 1 })).toBe(null);
    // The producer's mutations are visible in ITS object and in no other.
    expect(sameShape(seen[0], caller)).toBe("$.n: 1 vs 99");
    // Identity: nothing reachable from the params is an object the caller holds.
    expect(sharedObjects(seen[0], caller)).toEqual([]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen((seen[0] as { nested: unknown }).nested)).toBe(true);
  });

  it("the refusal grammar, one row per internally mutable or accessor-bearing form", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    let deep: unknown = 1;
    for (let index = 0; index < 70; index += 1) {
      deep = { deep };
    }
    class Config {
      readonly edge = "0.02";
    }
    const rows: ReadonlyArray<readonly [string, unknown]> = [
      ["Map", new Map([["k", "v"]])],
      ["Set", new Set(["k"])],
      ["Date", { when: new Date(0) }],
      ["class instance", new Config()],
      ["function", { compiled: (): number => 1 }],
      ["nested accessor", { nested: { get computed(): number { return 1; } } }],
      ["symbol key", { [Symbol("hidden")]: 1, visible: 2 }],
      [
        "non-enumerable property",
        Object.defineProperty({ visible: 1 }, "hidden", { value: 2, enumerable: false }),
      ],
      ["symbol value", { s: Symbol("v") }],
      ["bigint", { big: 1n }],
      ["cycle", cyclic],
      ["over-deep", deep],
      [
        "revoked proxy",
        (() => {
          const revocable = Proxy.revocable({}, {});
          revocable.revoke();
          return revocable.proxy;
        })(),
      ],
    ];

    for (const [label, params] of rows) {
      let result: CreateRuntimeResult | undefined;
      expect(() => {
        result = created({ params });
      }, `${label}: creation must not throw`).not.toThrow();
      expect(result?.ok, label).toBe(false);
      if (result?.ok === false) {
        expect(result.refusal.code, label).toBe("PARAMS_NOT_MATERIALIZABLE");
        expect(result.refusal.detail.startsWith("params"), label).toBe(true);
      }
    }
  });

  it("no over-refusal: ordinary configuration data survives the copy value for value", () => {
    const params = {
      edgeThreshold: "0.02",
      levels: [1, 2, 3],
      nested: { flags: { armed: true, disabled: false }, label: "static-bracket" },
      nothing: null,
      absent: undefined,
      counter: 7,
      weird: Number.NaN,
    };
    let seen: unknown;
    const result = createStrategyInstanceRuntime(
      makeDefinition({
        params,
        strategy: reportingStrategy((value) => {
          seen = value;
          return "TEST.HOLD";
        }),
      }).definition,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.runtime.evaluate(makeInput()).kind).toBe("DECIDED");
    // `undefined` is preserved (a JSON round trip would have dropped it) and
    // `NaN` survives: params never become checkpoint bytes, so the two rules
    // that protect those bytes do not apply here.
    expect(sameShape(seen, params)).toBe(null);
    expect(Object.hasOwn(seen as object, "absent")).toBe(true);
    expect(Number.isNaN((seen as { weird: number }).weird)).toBe(true);
  });

  it("a params value that is a bare scalar, or absent, is accepted as itself", () => {
    for (const params of ["a string", 42, true, null, undefined, ["a", "list"]]) {
      let seen: unknown = "unset";
      const result = createStrategyInstanceRuntime(
        makeDefinition({
          params,
          strategy: reportingStrategy((value) => {
            seen = value;
            return "TEST.HOLD";
          }),
        }).definition,
      );
      expect(result.ok, String(params)).toBe(true);
      if (!result.ok) {
        continue;
      }
      expect(result.runtime.evaluate(makeInput()).kind).toBe("DECIDED");
      expect(sameShape(seen, params), String(params)).toBe(null);
    }
  });
});

describe("MEDIUM 3: a schema result's `data` is present or absent, and the two mean different things", () => {
  it("the reviewer's transcript: an explicit data: undefined is the parsed value, not an absence", () => {
    const raw = { raw: "should-not-survive-transform" };
    let seen: unknown = "unset";
    const result = createStrategyInstanceRuntime(
      makeDefinition({
        params: raw,
        strategy: makeStrategy({
          paramsSchema: { safeParse: () => ({ success: true as const, data: undefined }) },
          onFeatures: (ctx: StrategyContext): DecisionResult => {
            seen = ctx.params();
            return {
              decisionType: "hold",
              reasonCodes: ["TEST.HOLD"],
              featureSnapshotRef: SNAPSHOT_REF,
              intents: [],
            };
          },
        }),
      }).definition,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.runtime.evaluate(makeInput()).kind).toBe("DECIDED");
    // Before round 4 this was the RAW object: a successful transform to
    // `undefined` was read as "the adapter returned nothing".
    expect(seen).toBeUndefined();
    expect(seen).not.toBe(raw);
  });

  it("a successful result with NO data property still means 'use the raw params I validated'", () => {
    const raw = { edgeThreshold: "0.02" };
    let seen: unknown;
    const result = createStrategyInstanceRuntime(
      makeDefinition({
        params: raw,
        strategy: makeStrategy({
          paramsSchema: { safeParse: () => ({ success: true as const }) },
          onFeatures: (ctx: StrategyContext): DecisionResult => {
            seen = ctx.params();
            return {
              decisionType: "hold",
              reasonCodes: ["TEST.HOLD"],
              featureSnapshotRef: SNAPSHOT_REF,
              intents: [],
            };
          },
        }),
      }).definition,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.runtime.evaluate(makeInput()).kind).toBe("DECIDED");
    expect(sameShape(seen, raw)).toBe(null);
    // …and it is still the runtime's own copy, not the caller's object.
    expect(seen).not.toBe(raw);
  });

  it("a transformed value is used, and the raw params it replaced never reach the strategy", () => {
    const raw = { edgeThreshold: "0.02" };
    let seen: unknown;
    const result = createStrategyInstanceRuntime(
      makeDefinition({
        params: raw,
        strategy: makeStrategy({
          paramsSchema: { safeParse: () => ({ success: true as const, data: { edge: 2 } }) },
          onFeatures: (ctx: StrategyContext): DecisionResult => {
            seen = ctx.params();
            return {
              decisionType: "hold",
              reasonCodes: ["TEST.HOLD"],
              featureSnapshotRef: SNAPSHOT_REF,
              intents: [],
            };
          },
        }),
      }).definition,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.runtime.evaluate(makeInput()).kind).toBe("DECIDED");
    expect(sameShape(seen, { edge: 2 })).toBe(null);
  });

  it("a schema result whose presence probe is hostile is a typed refusal, not a throw", () => {
    // `Reflect.has` is how presence is answered, and a `has` trap is caller
    // code like any other read.
    const hostileResult = new Proxy(
      { success: true, data: 1 },
      {
        has(): never {
          throw new Error("HAS_TRAP");
        },
      },
    );
    let result: CreateRuntimeResult | undefined;
    expect(() => {
      result = created({
        strategy: makeStrategy({ paramsSchema: { safeParse: () => hostileResult } }),
      });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.refusal.code).toBe("PARAMS_SCHEMA_UNSUPPORTED");
      expect(result.refusal.detail).toContain("HAS_TRAP");
    }
  });
});
