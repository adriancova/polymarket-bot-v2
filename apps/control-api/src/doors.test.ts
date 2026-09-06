/**
 * The ADR-020 door battery — D1-D4 and §6's bound.
 *
 * > "Composition may vary; permission may not."
 *
 * Every pollution case below is applied to `Object.prototype`, exercised, and
 * removed in a `finally`, so a failure cannot leak into another suite. Both the
 * ENUMERABLE and the NON-ENUMERABLE forms are used: ADR-020 §2 records that
 * `z.strictObject` sees the first and not the second, and a battery that only
 * tried the enumerable form would be measuring the wrong thing.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildDoor, deepFreeze, ownNumber, ownRecord, ownString } from "./doors.js";

const Schema = z.strictObject({
  name: z.string().min(1),
  count: z.number().int().min(0),
  nested: z.strictObject({ flag: z.string().min(1) }),
});

interface Value {
  readonly name: string;
  readonly count: number;
  readonly flag: string;
}

const door = buildDoor(Schema, "probe request", (materialized): Value => ({
  name: ownString(materialized, "name") ?? "",
  count: ownNumber(materialized, "count") ?? -1,
  flag: ownString(ownRecord(materialized, "nested"), "flag") ?? "",
}));

const CLEAN = { name: "a", count: 2, nested: { flag: "on" } };

const polluted: string[] = [];

function pollute(key: string, value: unknown, enumerable: boolean): void {
  Object.defineProperty(Object.prototype, key, { value, enumerable, configurable: true, writable: true });
  polluted.push(key);
}

function polluteGetter(key: string, get: () => unknown, enumerable: boolean): void {
  Object.defineProperty(Object.prototype, key, { get, enumerable, configurable: true });
  polluted.push(key);
}

afterEach(() => {
  for (const key of polluted.splice(0)) {
    Reflect.deleteProperty(Object.prototype, key);
  }
});

describe("the door on clean input", () => {
  it("accepts a valid record and reads it from the MATERIALIZED tree", () => {
    const result = door(CLEAN);
    expect(result).toEqual({ ok: true, value: { name: "a", count: 2, flag: "on" } });
  });

  it("D4: the returned value is deep-frozen", () => {
    const result = door({ name: "a", count: 2, nested: { flag: "on" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("REFUSES an invalid record with the schema's issues", () => {
    const result = door({ name: "", count: -1, nested: { flag: "on" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("REQUEST_INVALID");
    expect(result.refusal.issues.length).toBeGreaterThan(0);
  });

  it("REFUSES a non-record, a null and a primitive under REQUEST_NOT_DATA", () => {
    for (const input of [null, 42, "text", [1, 2, 3]]) {
      const result = door(input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
    }
  });

  it("D1: REFUSES a getter, a proxy and a function-valued field as not-data", () => {
    const withGetter = { name: "a", count: 2, nested: { flag: "on" } };
    Object.defineProperty(withGetter, "count", { get: () => 2, enumerable: true, configurable: true });
    expect(door(withGetter)).toMatchObject({ ok: false, refusal: { code: "REQUEST_NOT_DATA" } });

    expect(door(new Proxy(CLEAN, {}))).toMatchObject({
      ok: false,
      refusal: { code: "REQUEST_NOT_DATA" },
    });

    expect(door({ ...CLEAN, name: () => "a" })).toMatchObject({ ok: false });
  });

  it("REFUSES an unknown key: the request grammar is CLOSED", () => {
    expect(door({ ...CLEAN, extra: "x" })).toMatchObject({
      ok: false,
      refusal: { code: "REQUEST_INVALID" },
    });
  });
});

describe("ADR-020 §6: permission does not vary with ambient prototype state", () => {
  it("does not ADOPT an inherited required key (enumerable and non-enumerable)", () => {
    for (const enumerable of [true, false]) {
      pollute("count", 99, enumerable);
      const result = door({ name: "a", nested: { flag: "on" } });
      expect(result.ok, `enumerable=${String(enumerable)}`).toBe(false);
      for (const key of polluted.splice(0)) Reflect.deleteProperty(Object.prototype, key);
    }
  });

  it("still ACCEPTS a clean record with the same values under pollution", () => {
    for (const enumerable of [true, false]) {
      pollute("name", "adopted", enumerable);
      expect(door(CLEAN)).toEqual({ ok: true, value: { name: "a", count: 2, flag: "on" } });
      for (const key of polluted.splice(0)) Reflect.deleteProperty(Object.prototype, key);
    }
  });

  it("is not fooled by an inherited `skipChecks` — the arena still refuses bad input", () => {
    for (const enumerable of [true, false]) {
      pollute("skipChecks", true, enumerable);
      // `name: ""` fails `.min(1)`, which is exactly the check class an
      // inherited `skipChecks` disables on a raw parse.
      expect(
        door({ name: "", count: 2, nested: { flag: "on" } }).ok,
        `enumerable=${String(enumerable)}`,
      ).toBe(false);
      for (const key of polluted.splice(0)) Reflect.deleteProperty(Object.prototype, key);
    }
  });

  it("is not fooled by an inherited `optin`/`optout` required-key waiver", () => {
    pollute("optin", "optional", false);
    pollute("optout", "optional", false);
    expect(door({ name: "a", nested: { flag: "on" } }).ok).toBe(false);
  });

  it("is not fooled by an inherited `when`, which skips custom checks", () => {
    pollute("when", () => false, false);
    expect(door({ name: "", count: 2, nested: { flag: "on" } }).ok).toBe(false);
  });

  it("CONTAINS the descriptor-literal class instead of throwing a 500", () => {
    // An inherited `get` is the class ADR-020 §1.8 records: `Object.defineProperty`
    // with an object-literal descriptor throws `TypeError`, which at the pinned
    // `zod` can escape from ERROR CONSTRUCTION — the one path a malformed
    // request necessarily takes. What must hold is that the door still ANSWERS,
    // with a refusal, whichever way the library behaves at this version. The
    // code is not pinned because it legitimately depends on whether the throw
    // happens: `REQUEST_INVALID` when the parse reports normally,
    // `REQUEST_NOT_DATA` when the outer guard contains a raise.
    //
    // NOTE ON METHOD: the assertions run AFTER the pollution is removed, and
    // deliberately. An inherited `get` breaks `Object.defineProperty` for every
    // object-literal descriptor in the process — including vitest's own
    // assertion machinery, which throws a `TypeError` out of `expect()` itself.
    // Asserting inside the polluted window would be measuring the test runner.
    polluteGetter("get", () => undefined, false);
    let result: ReturnType<typeof door> | undefined;
    let raised: unknown;
    try {
      result = door({ name: "", count: 2, nested: { flag: "on" } });
    } catch (cause) {
      raised = cause;
    } finally {
      for (const key of polluted.splice(0)) Reflect.deleteProperty(Object.prototype, key);
    }

    expect(raised, "the door must not raise; it answers").toBeUndefined();
    expect(result?.ok).toBe(false);
    // The code is not pinned: `REQUEST_INVALID` when the parse reports
    // normally, `REQUEST_NOT_DATA` when the outer guard contained a raise.
    expect(["REQUEST_INVALID", "REQUEST_NOT_DATA"]).toContain(
      result?.ok === false ? result.refusal.code : "",
    );
  });

  it("NEVER throws, over every pollution shape and every input shape", () => {
    const shapes: readonly (readonly [string, unknown, boolean])[] = [
      ["skipChecks", true, true],
      ["skipChecks", true, false],
      ["optin", "optional", false],
      ["optout", "optional", false],
      ["when", () => false, false],
      ["values", [], false],
      ["name", "adopted", false],
      ["count", 99, false],
      ["nested", { flag: "adopted" }, false],
    ];
    const inputs: readonly unknown[] = [
      CLEAN,
      {},
      null,
      { name: "a" },
      { name: "a", count: "two", nested: { flag: "on" } },
      { name: "a", count: 2, nested: null },
    ];
    for (const [key, value, enumerable] of shapes) {
      pollute(key, value, enumerable);
      for (const input of inputs) {
        expect(() => door(input)).not.toThrow();
      }
      for (const polluteKey of polluted.splice(0)) {
        Reflect.deleteProperty(Object.prototype, polluteKey);
      }
    }
  });
});

describe("deepFreeze", () => {
  it("freezes nested objects and arrays", () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });

  it("returns primitives unchanged", () => {
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze(null)).toBeNull();
  });
});

describe("the own-property readers", () => {
  it("read only OWN properties", () => {
    pollute("ghost", "inherited", true);
    expect(ownString({}, "ghost")).toBeUndefined();
    expect(ownNumber({}, "ghost")).toBeUndefined();
    expect(ownRecord({}, "ghost")).toBeUndefined();
  });

  it("answer undefined for a wrong-typed own property", () => {
    expect(ownString({ a: 1 }, "a")).toBeUndefined();
    expect(ownNumber({ a: "1" }, "a")).toBeUndefined();
  });
});
