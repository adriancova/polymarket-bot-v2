/**
 * Regression suite for review round 2's HIGH finding (remediation round 2,
 * 2026-09-02): the checkpointable-state grammar was bypassable by an EXOTIC
 * object. Round 1 had made the walk inspect own-property DESCRIPTORS, which is
 * the right check for an ordinary object and no check at all for a `Proxy`: a
 * proxy can present `Object.prototype`, plain enumerable data descriptors and
 * ordinary values to every question the validator asks, and then have its traps
 * do something else entirely afterwards.
 *
 * The reviewer's reproduction, verbatim, against the round-1 code:
 *
 * ```
 * validator=null
 * first=Error:POST_FREEZE_PROXY_GET
 * second=DECIDED
 * sequences=[0,0]
 * checkpoints=[0]
 * status=ACTIVE
 * ```
 *
 * The resolution is the second of the two the reviewer allowed: not detection
 * (undecidable — whatever a trap answered, it may answer differently next
 * time), but MATERIALIZATION. `materializeCheckpointableJson` reads every own
 * key, descriptor and value exactly once, inside a guard, and returns a fresh
 * plain copy; the copy is what the runtime keeps, freezes, serializes,
 * checkpoints and persists, and the caller's original is never read again.
 *
 * What this file pins, in order: the boundary is total (never throws), it
 * yields a copy and not the original, a hostile value can neither escape nor
 * lie into the copy, ordinary data is unaffected (no over-refusal), and the
 * copy serializes byte-identically to the source — the determinism property
 * round 1 pinned must survive the copying.
 *
 * The runtime-side half of the finding — ordering, containment, sequences —
 * is `decision-commit-ordering.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  deepFreeze,
  materializeCheckpointableJson,
} from "../../../packages/strategy-runtime/src/index.js";

/**
 * The validate-only shape these tests were written against; the export it used
 * to call (`checkpointableJsonProblem`) was removed in remediation round 3 (see
 * `json.test.ts` for the reasoning). Every assertion is unchanged.
 */
function problemOf(value: unknown): string | null {
  const result = materializeCheckpointableJson(value);
  return result.ok ? null : result.problem;
}

/**
 * The reviewer's value: plain to every inspection until something freezes it,
 * then hostile. `frozen` flips in the `preventExtensions` trap, which is the
 * first thing `Object.freeze` calls.
 */
function postFreezeProxy(): { proxy: object; target: Record<string, unknown> } {
  const target: Record<string, unknown> = { a: 1 };
  let frozen = false;
  const proxy = new Proxy(target, {
    get(t, key, receiver): unknown {
      if (frozen) {
        throw new Error("POST_FREEZE_PROXY_GET");
      }
      return Reflect.get(t, key, receiver);
    },
    preventExtensions(t): boolean {
      frozen = true;
      Object.preventExtensions(t);
      return true;
    },
  });
  return { proxy, target };
}

/** Answers `1` the first time and an unserializable function afterwards. */
function twoFacedProxy(): object {
  let reads = 0;
  return new Proxy(
    { a: 1 },
    {
      get(t, key, receiver): unknown {
        if (key === "a") {
          reads += 1;
          return reads === 1 ? 1 : (): number => 2;
        }
        return Reflect.get(t, key, receiver);
      },
    },
  );
}

function throwingTrapProxies(): ReadonlyArray<{ name: string; value: unknown; path: string }> {
  const base = { a: 1 };
  return [
    {
      name: "get",
      path: "$.nested.a",
      value: {
        nested: new Proxy(base, {
          get(): unknown {
            throw new Error("TRAP_GET");
          },
        }),
      },
    },
    {
      name: "ownKeys",
      path: "$.nested",
      value: {
        nested: new Proxy(base, {
          ownKeys(): ArrayLike<string | symbol> {
            throw new Error("TRAP_OWN_KEYS");
          },
        }),
      },
    },
    {
      name: "getOwnPropertyDescriptor",
      path: "$.nested.a",
      value: {
        nested: new Proxy(base, {
          getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
            throw new Error("TRAP_DESCRIPTOR");
          },
        }),
      },
    },
    {
      name: "getPrototypeOf",
      path: "$.nested",
      value: {
        nested: new Proxy(base, {
          getPrototypeOf(): object | null {
            throw new Error("TRAP_PROTOTYPE");
          },
        }),
      },
    },
    {
      name: "array length",
      path: "$.nested",
      value: {
        nested: new Proxy([1, 2], {
          get(t, key, receiver): unknown {
            if (key === "length") {
              throw new Error("TRAP_LENGTH");
            }
            return Reflect.get(t, key, receiver);
          },
        }),
      },
    },
    {
      name: "array element",
      path: "$.nested[1]",
      value: {
        nested: new Proxy([1, 2], {
          get(t, key, receiver): unknown {
            if (key === "1") {
              throw new Error("TRAP_ELEMENT");
            }
            return Reflect.get(t, key, receiver);
          },
        }),
      },
    },
  ];
}

describe("the checkpointable-state boundary materializes rather than trusting an exotic value", () => {
  it("the reviewer's hostile Proxy cannot reach anything the runtime keeps", () => {
    const { proxy, target } = postFreezeProxy();
    const result = materializeCheckpointableJson({ nested: proxy });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const copy = result.value as { nested: object };

    // 1. What comes back is a COPY, not the caller's object.
    expect(copy.nested).not.toBe(proxy);
    expect(copy.nested).not.toBe(target);
    expect(Object.getPrototypeOf(copy.nested)).toBe(Object.prototype);

    // 2. Freezing the copy — which is what the runtime does at commit — no
    //    longer touches the original at all, so the trap that used to throw
    //    AFTER the decision was persisted never fires.
    expect(() => deepFreeze(copy)).not.toThrow();
    expect(Object.isFrozen(copy.nested)).toBe(true);
    expect(Object.isExtensible(target)).toBe(true);

    // 3. And the data is intact.
    expect(canonicalJsonStringify(copy)).toBe('{"nested":{"a":1}}');
  });

  it("reads every property exactly once, so a two-faced Proxy cannot lie into the copy", () => {
    const proxy = twoFacedProxy();
    const result = materializeCheckpointableJson({ nested: proxy });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The second read would have produced a function — unserializable, and the
    // exact divergence between "what was validated" and "what was kept".
    expect(canonicalJsonStringify(result.value)).toBe('{"nested":{"a":1}}');
    expect(canonicalJsonStringify(result.value)).toBe('{"nested":{"a":1}}');
    expect(typeof (proxy as { a: unknown }).a).toBe("function");
  });

  it("is TOTAL: every trap that throws becomes a stated problem, never a throw", () => {
    for (const { name, value, path } of throwingTrapProxies()) {
      let problem: string | null = "unset";
      expect(() => {
        problem = problemOf(value);
      }, `the boundary must not throw for the ${name} trap`).not.toThrow();
      expect(problem, `the ${name} trap must be refused`).not.toBeNull();
      expect(problem).toContain(path);
      expect(problem).toContain("is not checkpointable");

      let materialized: unknown;
      expect(() => {
        materialized = materializeCheckpointableJson(value);
      }, `materializeCheckpointableJson must not throw for the ${name} trap`).not.toThrow();
      expect((materialized as { ok: boolean }).ok).toBe(false);
    }
  });

  it("a Proxy over a non-plain object is still refused by the prototype rule", () => {
    const date = new Proxy(new Date(0), {});
    expect(problemOf({ when: date })).toContain("only plain objects");
    const map = new Proxy(new Map<string, number>(), {});
    expect(problemOf({ m: map })).toContain("only plain objects");
  });

  it("a lying descriptor trap can only lie into inert data", () => {
    // The target's property is an accessor; the proxy reports a plain data
    // descriptor for it. The boundary reads the value once and copies it: the
    // result is data either way, and nothing computed survives into state.
    const target = {};
    let calls = 0;
    Object.defineProperty(target, "computed", {
      get: () => {
        calls += 1;
        return calls;
      },
      enumerable: true,
      configurable: true,
    });
    const liar = new Proxy(target, {
      getOwnPropertyDescriptor(): PropertyDescriptor {
        return { value: 7, writable: true, enumerable: true, configurable: true };
      },
    });
    const result = materializeCheckpointableJson({ nested: liar });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const bytes = canonicalJsonStringify(result.value);
    expect(bytes).toBe('{"nested":{"computed":1}}');
    // Read once, and never again — the copy cannot drift under the runtime.
    expect(calls).toBe(1);
    expect(canonicalJsonStringify(result.value)).toBe(bytes);
  });

  it("still refuses an accessor WITHOUT invoking the getter (the round-1 property survives)", () => {
    let getterCalls = 0;
    const value: Record<string, unknown> = { visible: 1 };
    Object.defineProperty(value, "computed", {
      get: () => {
        getterCalls += 1;
        return getterCalls;
      },
      enumerable: true,
    });
    expect(problemOf(value)).toContain("accessor");
    expect(materializeCheckpointableJson(value).ok).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("does NOT over-refuse: everything round 1 accepted still materializes", () => {
    const accepted: unknown[] = [
      { a: 1, b: [1, 2, { c: "0.5" }], d: null },
      deepFreeze({ a: { b: [1, { c: true }] } }),
      Object.create(null) as object,
      JSON.parse('{"z":1,"a":{"b":[1,2,null]}}') as unknown,
      [1, 2, 3],
      Object.freeze([1, 2, 3]),
      {},
      [],
      { length: 3 },
      { "": 0, "0": 1, "é": true },
      { nested: { deep: { deeper: [] } } },
      "plain string",
      0,
      -1.5,
      true,
      null,
    ];
    for (const value of accepted) {
      expect(problemOf(value), JSON.stringify(value) ?? "value").toBeNull();
      const result = materializeCheckpointableJson(value);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(value);
      }
    }
  });

  it("the copy serializes BYTE-IDENTICALLY to the source (round 1's determinism property)", () => {
    const values: unknown[] = [
      { z: 1, a: { b: [1, 2, null] }, "": "empty key" },
      [{ x: 1 }, [2, [3]], "s", null, true],
      { "0": "zero", "1": "one", length: 2 },
      {},
      [],
    ];
    for (const value of values) {
      const result = materializeCheckpointableJson(value);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        continue;
      }
      expect(canonicalJsonStringify(result.value)).toBe(canonicalJsonStringify(value));
      // Insertion order too, not only the sorted canonical form: the copy must
      // be indistinguishable from the original to every serializer.
      expect(JSON.stringify(result.value)).toBe(JSON.stringify(value));
    }
  });

  it("the copy shares no object with the source, at any depth", () => {
    const source = { nested: { inner: [1, { deep: true }] } };
    const result = materializeCheckpointableJson(source);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const copy = result.value as typeof source;
    expect(copy).not.toBe(source);
    expect(copy.nested).not.toBe(source.nested);
    expect(copy.nested.inner).not.toBe(source.nested.inner);
    expect(copy.nested.inner[1]).not.toBe(source.nested.inner[1]);
    expect(copy).toEqual(source);

    // A later mutation of the source cannot reach the copy.
    source.nested.inner.push({ deep: false });
    expect(copy.nested.inner).toHaveLength(2);
  });

  it("an own `__proto__` data property survives as data and pollutes nothing", () => {
    // `JSON.parse` produces this shape; naive `copy[key] = value` would hit the
    // inherited setter and move it out of the copy.
    const source = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as unknown;
    const result = materializeCheckpointableJson(source);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const copy = result.value as object;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(copy, "__proto__")).toBe(true);
    expect(canonicalJsonStringify(copy)).toBe(canonicalJsonStringify(source));
    expect((({}) as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("INVARIANT: the validator and the materializer never disagree", () => {
    const battery: unknown[] = [
      { ok: 1 },
      [1, 2],
      { fn: (): number => 1 },
      { u: undefined },
      { big: 1n },
      { nan: Number.NaN },
      { negZero: -0 },
      { when: new Date(0) },
      new Map<string, number>(),
      ...throwingTrapProxies().map((entry) => entry.value),
      { nested: postFreezeProxy().proxy },
      Object.create(null) as object,
    ];
    for (const value of battery) {
      const problem = problemOf(value);
      const materialized = materializeCheckpointableJson(value);
      expect(materialized.ok).toBe(problem === null);
      if (!materialized.ok) {
        expect(materialized.problem).toBe(problem);
      }
    }
    // A cycle is refused by both, and neither hangs.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(problemOf(cyclic)).toContain("circular structure");
    expect(materializeCheckpointableJson(cyclic).ok).toBe(false);
  });
});
