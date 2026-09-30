/**
 * `THROUGHPUT-2` — the params parse is computed once per IMMUTABLE params
 * object, and only then (`params.ts`, `PARSED_BY_OBJECT`).
 *
 * `prepare` re-validates `ctx.params()` on every callback; the WP-170 runtime
 * answers it with ONE deep-frozen plain-data object for the run's life. These
 * pin that the cached answer is exactly what a fresh validation answers, that
 * it is reused only for an object whose contents cannot change, and that every
 * other object is validated afresh — so no stale answer is ever returned.
 */

import { describe, expect, it } from "vitest";

import {
  staticBracketParamsSchema,
  validateStaticBracketParams,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import { isImmutablePlainData } from "../../../../packages/strategies/static-bracket/src/params.js";
import { baseConfig, configWith } from "./helpers.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** A fresh validation, rendered as `safeParse` renders it. */
function fresh(value: unknown): unknown {
  const result = validateStaticBracketParams(value);
  return result.ok ? { success: true, data: result.value } : { success: false, error: { message: result.problem } };
}

describe("static-bracket params: the parse of an immutable params object is cached (THROUGHPUT-2)", () => {
  it("a deep-frozen plain-data object: the SAME frozen answer again, equal to a fresh validation", () => {
    const params = deepFreeze(baseConfig());
    expect(isImmutablePlainData(params)).toBe(true);
    const first = staticBracketParamsSchema.safeParse(params);
    const second = staticBracketParamsSchema.safeParse(params);
    expect(second).toBe(first);
    expect(first.success).toBe(true);
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(fresh(params))));
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("a deep-frozen INVALID object: the refusal is cached, with the same message a fresh validation states", () => {
    const params = deepFreeze(configWith({ "entry.trigger_price_lte": "1.5" }));
    const first = staticBracketParamsSchema.safeParse(params);
    expect(first.success).toBe(false);
    expect(staticBracketParamsSchema.safeParse(params)).toBe(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(fresh(params))));
  });

  it("a MUTABLE object is validated afresh every time: a later change is seen, never a stale answer", () => {
    const params = baseConfig();
    expect(isImmutablePlainData(params)).toBe(false);
    const first = staticBracketParamsSchema.safeParse(params);
    expect(first.success).toBe(true);
    const entry = params["entry"] as Record<string, unknown>;
    entry["trigger_price_lte"] = "1.5";
    const second = staticBracketParamsSchema.safeParse(params);
    expect(second).not.toBe(first);
    expect(second.success).toBe(false);
  });

  it("a frozen root over a MUTABLE nested record is not cached", () => {
    const params = baseConfig();
    Object.freeze(params);
    expect(isImmutablePlainData(params)).toBe(false);
    const first = staticBracketParamsSchema.safeParse(params);
    (params["entry"] as Record<string, unknown>)["trigger_price_lte"] = "1.5";
    expect(staticBracketParamsSchema.safeParse(params).success).toBe(false);
    expect(first.success).toBe(true);
  });

  it("an accessor, a non-plain prototype, or an unreadable value is never treated as immutable", () => {
    const withAccessor = deepFreeze(
      Object.defineProperty(baseConfig(), "version", { get: () => 1, enumerable: true }),
    );
    expect(isImmutablePlainData(withAccessor)).toBe(false);
    class Params {}
    expect(isImmutablePlainData(Object.freeze(new Params()))).toBe(false);
    expect(isImmutablePlainData(Object.freeze(new Map()))).toBe(false);
    const hostile = new Proxy(deepFreeze(baseConfig()), {
      ownKeys: () => {
        throw new Error("no");
      },
    });
    expect(isImmutablePlainData(hostile)).toBe(false);
    expect(isImmutablePlainData(deepFreeze({ a: [1, "b", null, { c: true }] }))).toBe(true);
  });
});
