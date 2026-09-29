/**
 * `OUTAGE-1` item 3 (`BOOT1-CONFIGPARAMS`): the canonical comparison between
 * a registered `strategy.configs.parameters` and the configuration's
 * `instances[].params`, as a pure function (`compareRegisteredParameters`).
 *
 * The rules, each pinned below:
 * - object keys are a set, and arrays are ordered;
 * - strings, booleans and `null` compare exactly;
 * - a JSON number compares as its decimal string, because the registered
 *   side can only hold the string (`WP-040`'s `assertDecimalSafeJson`
 *   refuses a number at any depth);
 * - every difference is named by JSON Pointer;
 * - nesting beyond a bound fails CLOSED, so the function is total even on a
 *   cyclic value.
 *
 * The same check through a real PostgreSQL and the real `startup()` is
 * `test/integration/paper-trader/registered-config-parameters-postgres.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { compareRegisteredParameters } from "../../../apps/trader/src/adapters/postgres-registration.js";

describe("compareRegisteredParameters — what counts as the same parameters", () => {
  it("identical documents agree", () => {
    const params = { strategy: "static-bracket", entry: { size_shares: "50", legs: ["a", "b"] }, hold: false };
    expect(compareRegisteredParameters(structuredClone(params), params)).toStrictEqual([]);
  });

  it("key order is not a fact, at any depth", () => {
    expect(
      compareRegisteredParameters(
        { b: { y: "2", x: "1" }, a: [{ q: true, p: null }] },
        { a: [{ p: null, q: true }], b: { x: "1", y: "2" } },
      ),
    ).toStrictEqual([]);
  });

  it("a number agrees with its own decimal string — the only form the registered row can hold", () => {
    expect(
      compareRegisteredParameters(
        { version: "1", maximum_holding_seconds: "180", ratio: "0.5", big: "1e+21" },
        { version: 1, maximum_holding_seconds: 180, ratio: 0.5, big: 1e21 },
      ),
    ).toStrictEqual([]);
  });

  it("a number does NOT agree with another spelling of it", () => {
    expect(compareRegisteredParameters({ n: "2.0" }, { n: 2 })).toStrictEqual([
      '/n: the registered row holds "2.0" but the configuration states 2',
    ]);
    expect(compareRegisteredParameters({ n: "02" }, { n: 2 })).toHaveLength(1);
  });

  it('strings compare exactly: "0.50" is not "0.5" (two different documents, refused rather than reconciled)', () => {
    expect(compareRegisteredParameters({ price: "0.50" }, { price: "0.5" })).toStrictEqual([
      '/price: the registered row holds "0.50" but the configuration states "0.5"',
    ]);
  });

  it("a boolean or null never equals its spelling as a string", () => {
    expect(compareRegisteredParameters({ flag: "true" }, { flag: true })).toHaveLength(1);
    expect(compareRegisteredParameters({ flag: true }, { flag: "true" })).toHaveLength(1);
    expect(compareRegisteredParameters({ none: "null" }, { none: null })).toHaveLength(1);
    expect(compareRegisteredParameters({ none: null }, { none: null })).toStrictEqual([]);
    expect(compareRegisteredParameters({ flag: false }, { flag: false })).toStrictEqual([]);
  });
});

describe("compareRegisteredParameters — naming what differs", () => {
  it("an extra key on either side is named by its pointer and its value", () => {
    expect(compareRegisteredParameters({ reentry: { note: "x" } }, { reentry: {} })).toStrictEqual([
      '/reentry/note: the registered row holds "x" but the configuration has no such field',
    ]);
    expect(compareRegisteredParameters({ exit: {} }, { exit: { hold: false } })).toStrictEqual([
      "/exit/hold: the configuration states false but the registered row has no such field",
    ]);
  });

  it("arrays are ordered: a reordering is a difference at each moved index", () => {
    expect(compareRegisteredParameters({ legs: ["a", "b"] }, { legs: ["b", "a"] })).toStrictEqual([
      '/legs/0: the registered row holds "a" but the configuration states "b"',
      '/legs/1: the registered row holds "b" but the configuration states "a"',
    ]);
  });

  it("arrays of different lengths, or an array against an object, differ by shape", () => {
    expect(compareRegisteredParameters({ legs: ["a"] }, { legs: ["a", "b"] })).toStrictEqual([
      "/legs: the registered row holds an array of 1 but the configuration states an array of 2",
    ]);
    expect(compareRegisteredParameters({ legs: {} }, { legs: [] })).toStrictEqual([
      "/legs: the registered row holds an object but the configuration states an array of 0",
    ]);
  });

  it("a document that is not an object differs at the root", () => {
    expect(compareRegisteredParameters("params", { a: "1" })).toStrictEqual([
      '(the document root): the registered row holds "params" but the configuration states an object',
    ]);
  });

  it("every difference is reported, in a stable (sorted-key) order", () => {
    expect(compareRegisteredParameters({ z: "1", a: "1", m: "1" }, { z: "2", a: "2", m: "2" })).toStrictEqual([
      '/a: the registered row holds "1" but the configuration states "2"',
      '/m: the registered row holds "1" but the configuration states "2"',
      '/z: the registered row holds "1" but the configuration states "2"',
    ]);
  });

  it("pointer segments are escaped per RFC 6901 (~ as ~0, / as ~1)", () => {
    expect(compareRegisteredParameters({ "a/b": { "m~n": "1" } }, { "a/b": { "m~n": "2" } })).toStrictEqual([
      '/a~1b/m~0n: the registered row holds "1" but the configuration states "2"',
    ]);
  });

  it("a long string is shown cut short, not in full", () => {
    const [difference] = compareRegisteredParameters({ s: "x".repeat(500) }, { s: "y" });
    expect(difference).toBeDefined();
    expect(difference?.length).toBeLessThan(200);
    expect(difference).toContain('..."');
  });
});

describe("compareRegisteredParameters — total, and fails closed", () => {
  function nested(depth: number, leaf: unknown): unknown {
    let value = leaf;
    for (let level = 0; level < depth; level += 1) value = { k: value };
    return value;
  }

  it("compares a document nested to the bound (64), and refuses one level deeper rather than recursing further", () => {
    expect(compareRegisteredParameters(nested(64, "x"), nested(64, "x"))).toStrictEqual([]);
    const [deeper] = compareRegisteredParameters(nested(65, "x"), nested(65, "x"));
    expect(deeper).toContain("nested deeper than 64 levels, so it was not compared");
  });

  it("never throws, even on a cyclic value (the depth bound ends it)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const other: Record<string, unknown> = {};
    other["self"] = other;
    const differences = compareRegisteredParameters(cyclic, other);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain("nested deeper than 64 levels");
  });
});
