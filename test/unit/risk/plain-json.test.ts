/**
 * THE OWN-DATA JSON ENCODER (`SER-1`): three obligations, each measured.
 *
 * 1. BYTE-IDENTITY. In a clean process, `encodePlainJson(v, { indent })` must
 *    equal `JSON.stringify(v, null, indent)` byte for byte on plain data, for
 *    every `indent` this repository will use — otherwise the fix is itself a
 *    wire, key or artifact change. Asserted DIFFERENTIALLY over a generated
 *    corpus covering the whole JSON grammar (every escape class, every code
 *    unit, every surrogate alone, every number-formatting branch, integer-like
 *    key ordering, `undefined` in both container kinds, null-prototype
 *    objects, empty and nested containers), at indents 0, 1, 2 and 4.
 * 2. INVARIANCE. The result must be IDENTICAL with and without an inherited
 *    `toJSON`, in all six measured contexts — {`Object.prototype`,
 *    `Array.prototype`, `BigInt.prototype`} × {enumerable assignment,
 *    non-enumerable `defineProperty`} — and the injected `toJSON` must have
 *    run ZERO times. `String`/`Number`/`Boolean.prototype` are controls: a
 *    primitive never consults `toJSON`, so neither encoder moves there.
 * 3. REFUSAL. Everything the module header lists as a deliberate difference is
 *    a typed `NotPlainJson` with its `kind` and its `path`, never a different
 *    byte string and never a bare `TypeError`.
 *
 * NON-VACUITY (the `REC-1` lesson: a fence that kills no mutant is not a
 * fence). The handoff records the count of tests here that FAIL when the
 * encoder under test is swapped for a `JSON.stringify` stand-in — the swap is
 * one line at {@link encode} and is not committed. The last test in the
 * invariance block also proves the pollution is real by showing `JSON.stringify`
 * ITSELF hijacked in each of the six contexts.
 *
 * PROTOCOL FOR THE POLLUTED RUNS (as `test/unit/ledger/pollution.ts` and
 * `packages/event-bus/src/envelope-wire-bytes.test.ts`): install, call,
 * capture a STRING, RESTORE in a `finally`, and only then assert or format. An
 * inherited `toJSON` left installed corrupts vitest's own IPC serialization,
 * and `expect` inside the window would measure the assertion library.
 */

import { describe, expect, it } from "vitest";

import { MAX_DEPTH } from "../../../packages/risk/src/plain-data.js";
import { encodePlainJson, NotPlainJson } from "../../../packages/risk/src/plain-json.js";
import type { PlainJsonOptions } from "../../../packages/risk/src/plain-json.js";

/** The encoder under test. The mutant for the non-vacuity proof is a one-line swap HERE. */
const encode = (value: unknown, options?: PlainJsonOptions): string => encodePlainJson(value, options);

const INDENTS = [0, 1, 2, 4] as const;

function caught(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

/**
 * A THROW-SAFE, ALLOCATION-ONLY description of one encode. Never formats a
 * caller value and never calls `JSON.stringify`, so it is safe to run inside a
 * polluted window.
 */
function outcome(run: () => string): string {
  try {
    return `bytes:${run()}`;
  } catch (error) {
    return `threw:${error instanceof Error ? error.message : "non-error"}`;
  }
}

// ---------------------------------------------------------------------------
// The six contexts (plus three controls), with a call counter
// ---------------------------------------------------------------------------

interface Context {
  readonly name: string;
  readonly targets: readonly object[];
  readonly enumerable: boolean;
}

const CONTEXTS: readonly Context[] = [
  { name: "Object.prototype, enumerable assignment", targets: [Object.prototype], enumerable: true },
  { name: "Object.prototype, non-enumerable defineProperty", targets: [Object.prototype], enumerable: false },
  { name: "Array.prototype, enumerable assignment", targets: [Array.prototype], enumerable: true },
  { name: "Array.prototype, non-enumerable defineProperty", targets: [Array.prototype], enumerable: false },
  { name: "BigInt.prototype, enumerable assignment", targets: [BigInt.prototype], enumerable: true },
  { name: "BigInt.prototype, non-enumerable defineProperty", targets: [BigInt.prototype], enumerable: false },
];

const CONTROLS: readonly Context[] = [
  { name: "String.prototype (control)", targets: [String.prototype], enumerable: false },
  { name: "Number.prototype (control)", targets: [Number.prototype], enumerable: false },
  { name: "Boolean.prototype (control)", targets: [Boolean.prototype], enumerable: false },
];

/**
 * Installs a counting `toJSON` on each target, runs, restores, and reports how
 * many times the injected function was invoked. "Enumerable assignment" is a
 * literal `target.toJSON = fn`; the other shape is a non-enumerable
 * `defineProperty`, as measured in `SER-0`.
 */
function withInheritedToJson<T>(
  context: Context,
  run: () => T,
): { readonly result: T; readonly calls: number } {
  let calls = 0;
  const injected = (): string => {
    calls += 1;
    return "INJECTED";
  };
  const undo: (() => void)[] = [];
  for (const target of context.targets) {
    const previous = Object.getOwnPropertyDescriptor(target, "toJSON");
    if (context.enumerable) {
      (target as { toJSON?: unknown }).toJSON = injected;
    } else {
      const descriptor = Object.create(null) as PropertyDescriptor;
      descriptor.value = injected;
      descriptor.enumerable = false;
      descriptor.writable = true;
      descriptor.configurable = true;
      Object.defineProperty(target, "toJSON", descriptor);
    }
    undo.push(() => {
      Reflect.deleteProperty(target, "toJSON");
      if (previous !== undefined) Object.defineProperty(target, "toJSON", previous);
    });
  }
  let result: T;
  try {
    result = run();
  } finally {
    for (const restore of undo) restore();
  }
  return { result, calls };
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

function leafValues(): unknown[] {
  const leaves: unknown[] = [
    null,
    undefined,
    true,
    false,
    // Numbers: every formatting branch `ToString(Number)` has, and the
    // non-finite trio `SerializeJSONNumber` turns into `null`.
    0, -0, 1, -1, 1.25, -1.25, 0.1, 0.1 + 0.2, 1 / 3, 1e21, 1e-7, 1e-6, -1e21, 5e-324,
    Number.EPSILON, Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER, 2 ** 53, -(2 ** 53), 123456789012345, 1e300, -1e-300,
    Infinity, -Infinity, Number.NaN,
    // Strings: quotes, every short escape, U+0000–U+001F, DEL, the line
    // separators, astral code points, a pair, every lone-surrogate arrangement.
    "", "a", "plain text", "\"", "\\", "/", "\"\\/", "back\\slash and \"quote\"",
    "tab\there", "new\nline", "carriage\rreturn", "form\ffeed", "back\bspace",
    "vertical\u000btab", "null\u0000byte", "\u001f", "del\u007f",
    "\u2028line\u2029separators", "límite · 資産 · \u{1f4c8}", "\u{1d11e}", "😀",
    "\ud800", "\udfff", "\udbff", "\udc00", "a\ud800b", "a\udc00b", "\ud800\ud800",
    "\udc00\udc00", "\udc00\ud800", "𐀀", "\ud83d", "\ude00", "pair😀lone\ud800end",
    "a".repeat(5000), "\u{1f4c8}".repeat(500), "0.4500", "9007199254740993", "-1",
    "toJSON", "__proto__", "constructor",
  ];
  // Every code unit, in 64 blocks of 1024, so accidental pairs at block
  // boundaries are exercised too.
  for (let block = 0; block < 64; block += 1) {
    let text = "";
    for (let offset = 0; offset < 1024; offset += 1) {
      text += String.fromCharCode(block * 1024 + offset);
    }
    leaves.push(text);
  }
  // Every surrogate code unit ALONE, which is the case `JSON.stringify` escapes.
  for (let code = 0xd800; code <= 0xdfff; code += 1) {
    leaves.push(String.fromCharCode(code));
  }
  return leaves;
}

/** A chain of `depth` nested objects, the deepest carrying `leaf`. */
function nest(depth: number, leaf: unknown): unknown {
  let value: unknown = leaf;
  for (let level = 0; level < depth; level += 1) value = { child: value };
  return value;
}

/** `items` with the element at `index` DELETED, so the array really has a hole. */
function withHole(items: unknown[], index: number): unknown[] {
  Reflect.deleteProperty(items, String(index));
  return items;
}

function nullProto(entries: Readonly<Record<string, unknown>>): object {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(entries)) {
    Object.defineProperty(out, key, {
      value: entries[key], enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}

function buildCorpus(): unknown[] {
  const corpus: unknown[] = [];
  for (const leaf of leafValues()) {
    corpus.push(leaf, { value: leaf }, [leaf], { nested: { value: leaf } }, [[leaf]], nullProto({ value: leaf }));
  }
  corpus.push(
    // Empty and near-empty containers, at every indent the difference shows.
    {}, [], [[]], [{}], { empty: {} }, { empty: [] }, [[], {}, [[]], [{}]],
    { a: {}, b: [] }, [[[]]], { a: { b: { c: {} } } }, nullProto({}),
    // Keys that must be escaped exactly like values.
    { "": 1 }, { "\"": 1 }, { "\\": 1 }, { "\u0000": 1 }, { "\ud800": 1 },
    { "line\nbreak": 1 }, { "límite \u{1f4c8}": 1 }, { "😀": 1 }, { "\u2028": 1 },
    JSON.parse('{"z":1,"__proto__":{"x":2},"a":3}'),
    nullProto({ __proto__: 1, toJSON: 2 }),
    // Integer-like keys come first, ascending, in own-key order: `1,2,b,a`.
    { b: 1, 2: 1, a: 1, 1: 1 },
    { 2: "two", 10: "ten", 1: "one", z: 1, a: 2, "01": "not an index", "-1": "nor this" },
    { 4294967295: "not an index either", 4294967294: "the last index" },
    // `undefined` is OMITTED in an object and written as `null` in an array.
    { a: undefined }, { a: undefined, b: 1 }, { a: 1, b: undefined }, { a: 1, b: undefined, c: 2 },
    { outer: { a: undefined, b: [undefined, 1, undefined] } },
    [undefined], [undefined, undefined], [1, undefined, 2], [undefined, { a: undefined }],
    { only: undefined, andThis: undefined },
    // Sparse arrays: a hole is `null`, exactly as `Get` answering `undefined`.
    withHole([1, 2, 3], 1), new Array(3), Object.assign([], { 5: "x" }),
    // Non-enumerable own members are not members; non-index array members are not elements.
    Object.defineProperty({ visible: 1 }, "hidden", { value: 2, enumerable: false }),
    Object.assign([1, 2], { extra: "ignored" }),
    // Arrays of objects and objects of arrays; the accounting keys' shapes.
    [{ price: "0.4500", size: "10" }, { price: "0.4400", size: "5" }],
    { bids: [{ price: "0.52", size: "100" }], asks: [] },
    { levels: [[1, 2], [3, 4], []] },
    [[[[1]]], [[2]], [3]],
    ["acct-paper-1", "pUSD"], ["UNATTRIBUTED", "acct-paper-1", null, "pUSD"],
    ["pUSD", ""], ["pUSD", "fees-v1"], ["ACTUAL_ACCOUNT", "acct-paper-1", "pUSD"],
    // Mixed deep structures, up to the exact bound the default allows.
    nest(MAX_DEPTH - 1, "deepest"),
    nest(MAX_DEPTH - 1, { a: 1 }),
    nest(MAX_DEPTH - 2, [1, "2", null, { three: true }]),
    nest(8, [{ a: [1, { b: [true, null, "x"] }] }]),
  );
  return corpus;
}

const CORPUS = buildCorpus();

// ---------------------------------------------------------------------------
// 1. Byte-identity
// ---------------------------------------------------------------------------

describe("encodePlainJson reproduces JSON.stringify byte for byte on plain data", () => {
  it("pins the corpus size, so a shrunken corpus cannot pass quietly", () => {
    expect(CORPUS.length).toBe(13163);
  });

  for (const indent of INDENTS) {
    it(`is byte-identical to JSON.stringify(value, null, ${String(indent)}) over the corpus`, () => {
      const differences: string[] = [];
      let compared = 0;
      let refusedUndefined = 0;
      for (let index = 0; index < CORPUS.length; index += 1) {
        const value = CORPUS[index];
        const expected = JSON.stringify(value, null, indent);
        if (expected === undefined) {
          // A bare `undefined` root: `JSON.stringify` answers with no text at
          // all, which a function returning `string` may not do.
          refusedUndefined += 1;
          const refusal = caught(() => encode(value, { indent }));
          if (!(refusal instanceof NotPlainJson) || refusal.kind !== "UNDEFINED_ROOT") {
            differences.push(`#${String(index)}: undefined root was not refused as such`);
          }
          continue;
        }
        const actual = caught(() => encode(value, { indent }));
        if (actual !== expected) {
          differences.push(`#${String(index)}: expected ${expected.slice(0, 120)}`);
        }
        compared += 1;
      }
      expect(differences).toEqual([]);
      expect(compared).toBe(CORPUS.length - 1);
      expect(refusedUndefined).toBe(1);
    });
  }

  it("the corpus really exercises the grammar it claims to", () => {
    const encoded = CORPUS.map((value) => JSON.stringify(value)).filter((text): text is string => text !== undefined);
    // Every escape class, a lone surrogate, a raw astral pair, the `null`
    // substitutions, and the integer-key reordering.
    expect(encoded.some((text) => text.includes("\\\""))).toBe(true);
    expect(encoded.some((text) => text.includes("\\\\"))).toBe(true);
    for (const short of ["\\b", "\\t", "\\n", "\\f", "\\r"]) {
      expect(encoded.some((text) => text.includes(short)), short).toBe(true);
    }
    expect(encoded.some((text) => text.includes("\\u001f"))).toBe(true);
    expect(encoded.some((text) => text.includes("\\ud800"))).toBe(true);
    expect(encoded.some((text) => text.includes("😀"))).toBe(true);
    expect(encoded.some((text) => text === "[null]")).toBe(true);
    expect(encoded.some((text) => text === "[1,null,3]")).toBe(true);
    expect(encoded.some((text) => text === "{}")).toBe(true);
    expect(encoded.some((text) => text === "{\"1\":1,\"2\":1,\"b\":1,\"a\":1}")).toBe(true);
    expect(JSON.stringify(-0)).toBe("0");
    expect(JSON.stringify(1e21)).toBe("1e+21");
    expect(encoded.some((text) => text === "{\"value\":1e+21}")).toBe(true);
    expect(encoded.some((text) => text === "{\"value\":null}")).toBe(true);
    // The indent grammar: nested containers with a gap.
    expect(encode({ a: [1, {}], b: {} }, { indent: 2 })).toBe("{\n  \"a\": [\n    1,\n    {}\n  ],\n  \"b\": {}\n}");
  });

  it("honours indent up to JSON.stringify's own maximum of 10, and refuses beyond it", () => {
    const value = { a: [1, { b: "x" }], c: {} };
    for (let indent = 0; indent <= 10; indent += 1) {
      expect(encode(value, { indent })).toBe(JSON.stringify(value, null, indent));
    }
    expect(() => encode(value, { indent: 11 })).toThrow(RangeError);
    expect(() => encode(value, { indent: -1 })).toThrow(RangeError);
    expect(() => encode(value, { indent: 1.5 })).toThrow(RangeError);
    expect(() => encode(value, { indent: "  " as never })).toThrow(RangeError);
    expect(() => encode(value, { maxDepth: 0 })).toThrow(RangeError);
    expect(() => encode(value, { maxDepth: Number.NaN })).toThrow(RangeError);
  });

  it("reads its options as OWN data, so an inherited option changes nothing", () => {
    const value = { a: [1] };
    const clean = encode(value, {});
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "indent");
    let polluted: string;
    try {
      Object.defineProperty(Object.prototype, "indent", {
        value: 4, enumerable: false, writable: true, configurable: true,
      });
      polluted = outcome(() => encode(value, {}));
    } finally {
      Reflect.deleteProperty(Object.prototype, "indent");
      if (previous !== undefined) Object.defineProperty(Object.prototype, "indent", previous);
    }
    expect(polluted).toBe(`bytes:${clean}`);
    expect(clean).toBe("{\"a\":[1]}");
  });
});

// ---------------------------------------------------------------------------
// 2. Invariance under an inherited toJSON
// ---------------------------------------------------------------------------

/** Values that reach every `toJSON` lookup `JSON.stringify` performs. */
const INVARIANCE_VALUES: readonly unknown[] = [
  ...CORPUS,
  1n, { amount: 1n }, [1n], { a: { b: [0n] } },
];

describe("the bytes do not depend on an inherited toJSON (six contexts + controls)", () => {
  const clean = INVARIANCE_VALUES.map((value) => outcome(() => encode(value)));
  const cleanIndented = INVARIANCE_VALUES.map((value) => outcome(() => encode(value, { indent: 2 })));

  for (const context of [...CONTEXTS, ...CONTROLS]) {
    it(`encodes identically, invoking the injected toJSON 0 times — ${context.name}`, () => {
      // Install, call, capture, restore — then assert. Nothing in between.
      const polluted = withInheritedToJson(context, () => ({
        compact: INVARIANCE_VALUES.map((value) => outcome(() => encode(value))),
        indented: INVARIANCE_VALUES.map((value) => outcome(() => encode(value, { indent: 2 }))),
      }));

      expect(polluted.calls).toBe(0);
      const differences: number[] = [];
      for (let index = 0; index < clean.length; index += 1) {
        if (polluted.result.compact[index] !== clean[index]) differences.push(index);
        if (polluted.result.indented[index] !== cleanIndented[index]) differences.push(-index);
      }
      expect(differences).toEqual([]);
      // Not vacuous: the corpus carries arrays, objects and bigints — the three
      // value kinds whose `toJSON` lookup the contexts hijack.
      expect(clean.some((entry) => entry.startsWith("bytes:["))).toBe(true);
      expect(clean.some((entry) => entry.startsWith("bytes:{"))).toBe(true);
      expect(clean.filter((entry) => entry.startsWith("threw:") && entry.includes("bigint")).length).toBe(4);
    });
  }

  it("keeps JSON.stringify itself hijackable in all six contexts, so the immunity above is not vacuous", () => {
    const value = { list: [1, 2] };
    const observed = CONTEXTS.map((context) => {
      const run = withInheritedToJson(context, () => ({
        object: outcome(() => JSON.stringify(value)),
        bigint: outcome(() => JSON.stringify(1n)),
        ours: outcome(() => encode(value)),
        oursBigint: outcome(() => encode(1n)),
      }));
      return { name: context.name, ...run.result, calls: run.calls };
    });
    for (const entry of observed) {
      // Every context hijacked SOMETHING in `JSON.stringify`, and ran the
      // injected function to do it; ours never moved and never ran it.
      expect(entry.ours, entry.name).toBe("bytes:{\"list\":[1,2]}");
      expect(entry.oursBigint, entry.name).toMatch(/^threw:value: a bigint has no JSON representation$/u);
      if (entry.name.startsWith("Object.prototype")) {
        expect(entry.object, entry.name).toBe("bytes:\"INJECTED\"");
        expect(entry.bigint, entry.name).toBe("bytes:\"INJECTED\"");
        expect(entry.calls, entry.name).toBe(2);
      } else if (entry.name.startsWith("Array.prototype")) {
        expect(entry.object, entry.name).toBe("bytes:{\"list\":\"INJECTED\"}");
        expect(entry.bigint, entry.name).toMatch(/^threw:/u);
        expect(entry.calls, entry.name).toBe(1);
      } else {
        expect(entry.object, entry.name).toBe("bytes:{\"list\":[1,2]}");
        expect(entry.bigint, entry.name).toBe("bytes:\"INJECTED\"");
        expect(entry.calls, entry.name).toBe(1);
      }
    }
    // …and the controls hijack nothing, in either encoder, because a primitive
    // string/number/boolean never has `toJSON` looked up.
    for (const control of CONTROLS) {
      const run = withInheritedToJson(control, () => ({
        theirs: outcome(() => JSON.stringify(["x", 1, true])),
        ours: outcome(() => encode(["x", 1, true])),
      }));
      expect(run.result, control.name).toEqual({ theirs: "bytes:[\"x\",1,true]", ours: "bytes:[\"x\",1,true]" });
      expect(run.calls, control.name).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The refusal table
// ---------------------------------------------------------------------------

class Instance {
  readonly a = 1;
}

describe("everything that is not plain JSON data is a typed refusal naming its path", () => {
  const nested = (): Record<string, unknown> => ({ a: { b: [1, 2, {}] } });

  it.each([
    { name: "a bigint at the root", value: 1n, kind: "BIGINT", path: "value" },
    { name: "a bigint nested in an object", value: { amount: { total: 1n } }, kind: "BIGINT", path: "value.amount.total" },
    { name: "a bigint in an array", value: { list: [0, 1n] }, kind: "BIGINT", path: "value.list[1]" },
    { name: "a function value", value: { run: () => 1 }, kind: "EXECUTABLE", path: "value.run" },
    { name: "a function element", value: [() => 1], kind: "EXECUTABLE", path: "value[0]" },
    { name: "a function at the root", value: () => 1, kind: "EXECUTABLE", path: "value" },
    { name: "a symbol value", value: { tag: Symbol("tag") }, kind: "EXECUTABLE", path: "value.tag" },
    { name: "a symbol at the root", value: Symbol("root"), kind: "EXECUTABLE", path: "value" },
    { name: "an accessor member", value: { get x(): number { return 1; } }, kind: "ACCESSOR", path: "value.x" },
    {
      name: "an accessor element",
      value: Object.defineProperty([0], "0", { get: () => 1, enumerable: true, configurable: true }),
      kind: "ACCESSOR",
      path: "value[0]",
    },
    { name: "a Date", value: { at: new Date(0) }, kind: "NON_PLAIN", path: "value.at" },
    { name: "a Date at the root", value: new Date(0), kind: "NON_PLAIN", path: "value" },
    { name: "a Map", value: { m: new Map([["k", 1]]) }, kind: "NON_PLAIN", path: "value.m" },
    { name: "a Set", value: [new Set([1])], kind: "NON_PLAIN", path: "value[0]" },
    { name: "a class instance", value: { i: new Instance() }, kind: "NON_PLAIN", path: "value.i" },
    { name: "a Number wrapper", value: { n: new Number(1) }, kind: "NON_PLAIN", path: "value.n" },
    { name: "a String wrapper", value: { s: new String("x") }, kind: "NON_PLAIN", path: "value.s" },
    { name: "a Boolean wrapper", value: { b: new Boolean(true) }, kind: "NON_PLAIN", path: "value.b" },
    { name: "an Array subclass", value: { xs: new (class Xs extends Array {})() }, kind: "NON_PLAIN", path: "value.xs" },
    { name: "an object inheriting from a plain object", value: Object.create({ inherited: 1 }) as object, kind: "NON_PLAIN", path: "value" },
    { name: "an Error", value: new Error("e"), kind: "NON_PLAIN", path: "value" },
    { name: "an undefined root", value: undefined, kind: "UNDEFINED_ROOT", path: "value" },
  ])("refuses $name as $kind at $path", ({ value, kind, path }) => {
    const refusal = caught(() => encode(value));
    expect(refusal).toBeInstanceOf(NotPlainJson);
    const typed = refusal as NotPlainJson;
    expect(typed.kind).toBe(kind);
    expect(typed.path).toBe(path);
    expect(typed.name).toBe("NotPlainJson");
    expect(typed.message).toBe(`${path}: ${typed.problem}`);
    expect(typed.problem.length).toBeGreaterThan(20);
    // The fields are OWN data (never inherited, never a getter), and `name` is
    // hidden from enumeration like every built-in error's.
    expect(Object.keys(typed)).toEqual(["kind", "path", "problem"]);
    for (const field of ["kind", "path", "problem", "name"]) {
      expect(Object.hasOwn(Object.getOwnPropertyDescriptor(typed, field) ?? {}, "value"), field).toBe(true);
    }
  });

  it("refuses at EXACTLY maxDepth: a chain of maxDepth containers encodes, one more is refused", () => {
    for (const maxDepth of [1, 2, 3, 16, MAX_DEPTH]) {
      // `nest(n, leaf)` builds n containers; the root is depth 0, so the
      // deepest sits at depth n-1 and is allowed while n <= maxDepth.
      expect(encode(nest(maxDepth, "leaf"), { maxDepth })).toBe(JSON.stringify(nest(maxDepth, "leaf")));
      const refusal = caught(() => encode(nest(maxDepth + 1, "leaf"), { maxDepth })) as NotPlainJson;
      expect(refusal).toBeInstanceOf(NotPlainJson);
      expect(refusal.kind).toBe("DEPTH");
      expect(refusal.path).toBe(`value${".child".repeat(maxDepth)}`);
      expect(refusal.problem).toBe(`nested deeper than ${String(maxDepth)} levels`);
      // Arrays count as containers too.
      let arrays: unknown = "leaf";
      for (let level = 0; level < maxDepth + 1; level += 1) arrays = [arrays];
      expect((caught(() => encode(arrays, { maxDepth })) as NotPlainJson).kind).toBe("DEPTH");
    }
    // The default is the record bound `plain-data.ts` declares.
    expect(encode(nest(MAX_DEPTH, 1))).toBe(JSON.stringify(nest(MAX_DEPTH, 1)));
    expect((caught(() => encode(nest(MAX_DEPTH + 1, 1))) as NotPlainJson).kind).toBe("DEPTH");
  });

  it("terminates on a cyclic structure at the bound instead of recursing", () => {
    const cycle = nested();
    (cycle["a"] as Record<string, unknown>)["back"] = cycle;
    const refusal = caught(() => encode(cycle)) as NotPlainJson;
    expect(refusal).toBeInstanceOf(NotPlainJson);
    expect(refusal.kind).toBe("DEPTH");
    expect(refusal.path.startsWith("value.a.back.a.back")).toBe(true);
    const list: unknown[] = [];
    list.push(list);
    expect((caught(() => encode(list, { maxDepth: 4 })) as NotPlainJson).path).toBe("value[0][0][0][0]");
    // `JSON.stringify` would have thrown a TypeError here; the refusal is typed.
    expect(() => JSON.stringify(cycle)).toThrow(TypeError);
  });

  it("refuses a bigint BEFORE any prototype is consulted, where JSON.stringify consults one first", () => {
    // The verdict flip the header records: under `BigInt.prototype.toJSON`,
    // `JSON.stringify(1n)` is ACCEPTED bytes; the encoder's answer is the same
    // typed refusal as in a clean process.
    const context = CONTEXTS[5];
    if (context === undefined) throw new Error("six contexts");
    const run = withInheritedToJson(context, () => ({
      theirs: outcome(() => JSON.stringify({ amount: 1n })),
      ours: outcome(() => encode({ amount: 1n })),
    }));
    expect(run.result.theirs).toBe("bytes:{\"amount\":\"INJECTED\"}");
    expect(run.result.ours).toBe("threw:value.amount: a bigint has no JSON representation");
    expect(run.calls).toBe(1);
  });
});
