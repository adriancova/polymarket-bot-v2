/**
 * THE WIRE BYTES DO NOT DEPEND ON AMBIENT PROTOTYPE STATE (review round 4).
 *
 * The round-3 door materializes the caller's input into a tree whose OBJECTS are
 * null-prototype but whose ARRAYS keep `Array.prototype` — deliberately, because
 * a null-prototype array loses `Symbol.iterator` and every array method, which a
 * consumer of a delivered payload would notice. `Array.prototype`'s own chain
 * reaches `Object.prototype`, and `JSON.stringify` looks `toJSON` up THROUGH the
 * chain, so an inherited `toJSON` rewrote the bytes of an envelope that was
 * still ACCEPTED. A wrong value on the wire is the one outcome this door exists
 * to prevent, and it is worse than a refusal, because nothing downstream is
 * told.
 *
 * `encodeWireJson` replaces `JSON.stringify` and reads own data only. These
 * tests are its two obligations:
 *
 * 1. it must reproduce `JSON.stringify` BYTE FOR BYTE on a materialized tree in
 *    a clean environment — otherwise the fix is itself a wire change;
 * 2. its result must be IDENTICAL with and without an inherited `toJSON`, on
 *    `Object.prototype` and on `Array.prototype`, enumerable and not.
 *
 * PROTOCOL FOR THE POLLUTED RUNS: set the prototype, call, capture, RESTORE in a
 * `finally`, and only then assert or log. An inherited `toJSON` left installed
 * corrupts vitest's own IPC serialization and crashes the run, so nothing
 * between the set and the restore may assert, format or print.
 */
import { UnknownPayloadEventEnvelopeSchema as schema } from "@polymarket-bot/domain";
import { describe, expect, it, vi } from "vitest";

import { decodeEnvelope, encodeEnvelope, validateEnvelope } from "./envelope-codec.js";
import { encodeWireJson, MAX_WIRE_DEPTH, readOwnWireValue } from "./envelope-door.js";
import { HONEST_FIXTURES } from "./envelope-fixtures.js";
import { EventBusEnvelopeError } from "./errors.js";

const base = HONEST_FIXTURES[0]!.input as unknown as Record<string, unknown>;

function caught(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

/**
 * A THROW-SAFE, ALLOCATION-ONLY description of one encode.
 *
 * Never formats a caller value and never calls `JSON.stringify`, so it is safe
 * to run inside a polluted window.
 */
function outcome(run: () => string): string {
  try {
    return `bytes:${run()}`;
  } catch (error) {
    return `threw:${error instanceof Error ? error.message : "non-error"}`;
  }
}

/** Installs an inherited `toJSON` on each target, runs, and restores. */
function withInheritedToJson<T>(
  targets: readonly object[],
  enumerable: boolean,
  run: () => T,
): T {
  const undo: (() => void)[] = [];
  for (const target of targets) {
    const previous = Object.getOwnPropertyDescriptor(target, "toJSON");
    const descriptor = Object.create(null) as PropertyDescriptor;
    descriptor.value = (): string => "INJECTED";
    descriptor.enumerable = enumerable;
    descriptor.writable = true;
    descriptor.configurable = true;
    Object.defineProperty(target, "toJSON", descriptor);
    undo.push(() => {
      Reflect.deleteProperty(target, "toJSON");
      if (previous !== undefined) Object.defineProperty(target, "toJSON", previous);
    });
  }
  try {
    return run();
  } finally {
    for (const restore of undo) restore();
  }
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** Leaf values whose JSON text is worth asserting on its own. */
function leafValues(): unknown[] {
  const leaves: unknown[] = [
    null,
    undefined,
    true,
    false,
    // Numbers, including every formatting branch `ToString(Number)` has.
    0,
    -0,
    1,
    -1,
    1.25,
    -1.25,
    0.1,
    0.1 + 0.2,
    1 / 3,
    1e21,
    1e-7,
    1e-6,
    -1e21,
    5e-324,
    Number.EPSILON,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    2 ** 53,
    -(2 ** 53),
    123456789012345,
    Infinity,
    -Infinity,
    Number.NaN,
    // Strings: quotes, escapes, unicode, astral, and lone surrogates.
    "",
    "a",
    "plain text",
    "\"",
    "\\",
    "\"\\/",
    "back\\slash and \"quote\"",
    "tab\there",
    "new\nline",
    "carriage\rreturn",
    "form\ffeed",
    "back\bspace",
    "vertical\u000btab",
    "null\u0000byte",
    "del\u007f",
    "\u2028line\u2029separators",
    "límite · 資産 · \u{1f4c8}",
    "\u{1d11e}",
    "😀",
    "\ud800",
    "\udfff",
    "\udbff",
    "\udc00",
    "a\ud800b",
    "a\udc00b",
    "\ud800\ud800",
    "\udc00\udc00",
    "\udc00\ud800",
    "𐀀",
    "\ud83d",
    "\ude00",
    "pair😀lone\ud800end",
    "a".repeat(5000),
    "\u{1f4c8}".repeat(500),
    "0.4500",
    "9007199254740993",
    "-1",
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

function buildCorpus(): unknown[] {
  const corpus: unknown[] = [];
  const leaves = leafValues();
  for (const leaf of leaves) {
    corpus.push(leaf, { value: leaf }, [leaf], { nested: { value: leaf } }, [[leaf]]);
  }
  corpus.push(
    // Empty and near-empty containers.
    {},
    [],
    [[]],
    [{}],
    { empty: {} },
    { empty: [] },
    [[], {}, [[]], [{}]],
    // Keys that must be escaped exactly like values.
    { "": 1 },
    { "\"": 1 },
    { "\\": 1 },
    { "\u0000": 1 },
    { "\ud800": 1 },
    { "line\nbreak": 1 },
    { "límite \u{1f4c8}": 1 },
    JSON.parse('{"z":1,"__proto__":{"x":2},"a":3}'),
    // Integer-like keys come first, ascending, in own-key order.
    { 2: "two", 10: "ten", 1: "one", z: 1, a: 2 },
    // `undefined` is OMITTED in an object and written as `null` in an array.
    { a: undefined },
    { a: undefined, b: 1 },
    { a: 1, b: undefined },
    { a: 1, b: undefined, c: 2 },
    { outer: { a: undefined, b: [undefined, 1, undefined] } },
    [undefined],
    [undefined, undefined],
    [1, undefined, 2],
    // Arrays of objects and objects of arrays.
    [{ price: "0.4500", size: "10" }, { price: "0.4400", size: "5" }],
    { bids: [{ price: "0.52", size: "100" }], asks: [] },
    { levels: [[1, 2], [3, 4], []] },
    [[[[1]]], [[2]], [3]],
    // Mixed deep structures, up to the exact bound the door allows.
    nest(MAX_WIRE_DEPTH - 1, "deepest"),
    nest(MAX_WIRE_DEPTH - 1, { a: 1 }),
    nest(MAX_WIRE_DEPTH - 2, [1, "2", null, { three: true }]),
    nest(8, [{ a: [1, { b: [true, null, "x"] }] }]),
    // The six pinned fixtures' inputs, as values.
    ...HONEST_FIXTURES.map((fixture) => fixture.input),
  );
  return corpus;
}

const CORPUS = buildCorpus();
const MATERIALIZED = CORPUS.map((value) => readOwnWireValue(value));

/** Full envelopes for the end-to-end half of the immunity proof. */
const ENVELOPES: unknown[] = [
  ...HONEST_FIXTURES.map((fixture) => fixture.input),
  { ...base, payload: [1, 2] },
  { ...base, payload: [] },
  { ...base, payload: [{ a: [1, 2] }, "x", null] },
  { ...base, payload: { list: [1, [2, [3]]], text: "límite \u{1f4c8}", lone: "\ud800" } },
  { ...base, payload: { amount: 1n } },
  { ...base, payload: 1n },
  { ...base, payload: { venue: "binance" } },
  { ...base, eventId: "not-a-uuid" },
];

describe("the encoder reproduces JSON.stringify on own data", () => {
  it("pins the corpus size, so a shrunken corpus cannot pass quietly", () => {
    expect(CORPUS.length).toBe(10928);
    expect(MATERIALIZED.length).toBe(CORPUS.length);
  });

  it("is byte-identical to JSON.stringify of the same materialized tree", () => {
    const differences: string[] = [];
    let compared = 0;
    let omitted = 0;
    for (let index = 0; index < MATERIALIZED.length; index += 1) {
      const tree = MATERIALIZED[index];
      let expected: string | undefined;
      let expectedThrew = false;
      try {
        expected = JSON.stringify(tree);
      } catch {
        expectedThrew = true;
      }
      if (expectedThrew) {
        // Only `bigint` reaches this, and the encoder must refuse it too.
        if (!(caught(() => encodeWireJson(tree)) instanceof Error)) {
          differences.push(`#${String(index)}: JSON threw, the encoder did not`);
        }
        continue;
      }
      if (expected === undefined) {
        // A bare `undefined` root: `JSON.stringify` answers with no text at
        // all, which a function returning `string` may not do, so the encoder
        // refuses instead. Every other root is compared.
        omitted += 1;
        if (!(caught(() => encodeWireJson(tree)) instanceof Error)) {
          differences.push(`#${String(index)}: undefined root was encoded`);
        }
        continue;
      }
      const actual = caught(() => encodeWireJson(tree));
      if (actual !== expected) {
        differences.push(`#${String(index)}: expected ${expected.slice(0, 120)}`);
      }
      compared += 1;
    }
    expect(differences).toEqual([]);
    expect(compared).toBe(10927);
    expect(omitted).toBe(1);
  });

  it("refuses a bigint exactly where JSON.stringify throws", () => {
    for (const value of [1n, { amount: 1n }, [1n], { a: { b: [0n] } }]) {
      const tree = readOwnWireValue(value);
      expect(() => JSON.stringify(tree)).toThrow(TypeError);
      expect(() => encodeWireJson(tree)).toThrow(/bigint/u);
    }
  });

  it("keeps the six pinned fixtures byte-identical end to end", () => {
    for (const fixture of HONEST_FIXTURES) {
      expect(encodeEnvelope(fixture.input)).toBe(fixture.encoded);
    }
  });
});

describe("the encoded bytes are immune to an inherited toJSON", () => {
  const CONTEXTS = [
    { name: "Object.prototype", targets: [Object.prototype] },
    { name: "Array.prototype", targets: [Array.prototype] },
    { name: "both prototypes", targets: [Object.prototype, Array.prototype] },
  ] as const;

  for (const context of CONTEXTS) {
    for (const enumerable of [true, false]) {
      const label = `${context.name}, enumerable=${String(enumerable)}`;

      it(`encodes the whole corpus identically under an inherited toJSON on ${label}`, () => {
        const clean = MATERIALIZED.map((tree) => outcome(() => encodeWireJson(tree)));
        // Set, call, capture, restore — then assert. Nothing in between.
        const polluted = withInheritedToJson(context.targets, enumerable, () =>
          MATERIALIZED.map((tree) => outcome(() => encodeWireJson(tree))));

        expect(polluted.length).toBe(clean.length);
        const differences: number[] = [];
        for (let index = 0; index < clean.length; index += 1) {
          if (polluted[index] !== clean[index]) differences.push(index);
        }
        expect(differences).toEqual([]);
        // Not vacuous: the corpus really does contain arrays and a bigint, the
        // two values whose `toJSON` lookup left the null-prototype objects.
        expect(clean.some((entry) => entry.includes("["))).toBe(true);
      });

      it(`gives encodeEnvelope the same outcome under an inherited toJSON on ${label}`, () => {
        const clean = ENVELOPES.map((envelope) =>
          outcome(() => encodeEnvelope(envelope as never)));
        const polluted = withInheritedToJson(context.targets, enumerable, () =>
          ENVELOPES.map((envelope) => outcome(() => encodeEnvelope(envelope as never))));

        expect(polluted).toEqual(clean);
        // And the pinned bytes really are what was produced under pollution.
        HONEST_FIXTURES.forEach((fixture, index) => {
          expect(polluted[index]).toBe(`bytes:${fixture.encoded}`);
        });
        // The two routes that were open before this round, named explicitly.
        expect(polluted[HONEST_FIXTURES.length]).toBe(`bytes:${encodeEnvelope({ ...base, payload: [1, 2] } as never)}`);
        expect(polluted[HONEST_FIXTURES.length + 4]).toMatch(/^threw:event envelope could not be encoded as JSON/u);
      });
    }
  }

  it("keeps JSON.stringify itself hijackable, so the immunity above is not vacuous", () => {
    const tree = readOwnWireValue({ list: [1, 2] });
    const hijacked = withInheritedToJson([Object.prototype], false, () => {
      try {
        return JSON.stringify(tree);
      } catch {
        return "threw";
      }
    });
    const alsoHijacked = withInheritedToJson([Array.prototype], false, () => {
      try {
        return JSON.stringify(tree);
      } catch {
        return "threw";
      }
    });
    expect(hijacked).toBe("{\"list\":\"INJECTED\"}");
    expect(alsoHijacked).toBe("{\"list\":\"INJECTED\"}");
    expect(encodeWireJson(tree)).toBe("{\"list\":[1,2]}");
  });
});

describe("the delivered record's shape is unchanged", () => {
  // Shadowing `toJSON` with an own property on every materialized array was the
  // cheaper fix for the route above. It was rejected because it is
  // consumer-visible, and this pins the contract it would have broken:
  // `@polymarket-bot/risk`'s `readPlainData`, which the trader's event door runs
  // on exactly this record, refuses a non-index own property on an array. A
  // probe against that reader at this commit returns `ok: true` for a decoded
  // `BookSnapshot` whose payload carries arrays, and `EVENT_NOT_DATA:
  // event.payload.list.toJSON: a non-index property on an array is not record
  // data` for the shadowed shape.
  it("gives a delivered array exactly the index properties and Array.prototype", () => {
    const record = validateEnvelope({ ...base, payload: { list: [1, "two", { three: 3 }] } });
    const list = (record.payload as { list: unknown[] }).list;

    expect(Object.getPrototypeOf(list)).toBe(Array.prototype);
    expect(Reflect.ownKeys(list)).toEqual(["0", "1", "2", "length"]);
    expect(Object.hasOwn(list, "toJSON")).toBe(false);
    expect(Array.isArray(list)).toBe(true);
    expect(Object.isFrozen(list)).toBe(true);
    // The consumer-visible capabilities a null prototype would have removed.
    expect([...list]).toEqual([1, "two", { three: 3 }]);
    expect(list.map((member) => member)).toEqual([1, "two", { three: 3 }]);
    const iterated: unknown[] = [];
    for (const member of list) iterated.push(member);
    expect(iterated).toEqual([1, "two", { three: 3 }]);
  });
});

describe("containment classifies by own brand, not by prototype chain", () => {
  it("contains a hostile value whose getPrototypeOf trap throws (the round-4 construction)", () => {
    let count = 0;
    // `const`, but otherwise the reviewer's construction verbatim: the trap
    // closes over the binding and only runs after it is initialized.
    const hostile: object = new Proxy(
      {},
      {
        getPrototypeOf() {
          if (++count === 1) throw hostile;
          throw new RangeError("escape from instanceof");
        },
      },
    );
    const result = caught(() => validateEnvelope(new Proxy({}, { ownKeys() { throw hostile; } })));

    expect(result).toBeInstanceOf(EventBusEnvelopeError);
    expect((result as EventBusEnvelopeError).code).toBe("EVENT_BUS_ENVELOPE_INVALID");
    // The classification never walked a prototype chain, so no trap ran at all.
    expect(count).toBe(0);
  });

  it("contains a hostile value thrown from the schema's own judgement", () => {
    let count = 0;
    // `const`, but otherwise the reviewer's construction verbatim: the trap
    // closes over the binding and only runs after it is initialized.
    const hostile: object = new Proxy(
      {},
      {
        getPrototypeOf() {
          if (++count === 1) throw hostile;
          throw new RangeError("escape from instanceof");
        },
      },
    );
    const parse = vi.spyOn(schema, "safeParse").mockImplementation(() => {
      throw hostile;
    });
    let result: unknown;
    try {
      result = caught(() => validateEnvelope(base));
    } finally {
      parse.mockRestore();
    }

    expect(result).toBeInstanceOf(EventBusEnvelopeError);
    expect((result as EventBusEnvelopeError).details).toEqual({
      issues: [{ path: "", message: "the schema could not judge this value (its refusal could not be constructed)" }],
    });
    expect(count).toBe(0);
  });

  it.each([
    {
      name: "a revoked Proxy",
      make: (): unknown => {
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        return revocable.proxy;
      },
    },
    {
      name: "a Proxy whose getOwnPropertyDescriptor trap throws",
      make: (): unknown =>
        new Proxy(new EventBusEnvelopeError("impersonation"), {
          getOwnPropertyDescriptor() {
            throw new RangeError("escape from the brand check");
          },
        }),
    },
    {
      name: "an ordinary object whose prototype chain reaches a throwing trap",
      make: (): unknown =>
        Object.create(new Proxy({}, { getPrototypeOf() { throw new RangeError("chain"); } })),
    },
    {
      name: "a primitive",
      make: (): unknown => "not an error at all",
    },
  ])("contains $name thrown out of the door", ({ make }) => {
    const thrown = make();
    const result = caught(() => validateEnvelope(new Proxy({}, { ownKeys() { throw thrown; } })));

    expect(result).toBeInstanceOf(EventBusEnvelopeError);
    expect((result as EventBusEnvelopeError).code).toBe("EVENT_BUS_ENVELOPE_INVALID");
  });

  it("renders the door's own reason, so the read's classification is not the containment's", () => {
    // `readOwnWireValue` must recognise ITS OWN refusal by brand as well. With
    // an `instanceof` there, a thrown value whose prototype chain throws escapes
    // the read and is rendered by the outer containment instead, which says
    // something different — so the message is the observable difference.
    const hostileChain = Object.create(
      new Proxy({}, { getPrototypeOf() { throw new RangeError("chain"); } }),
    ) as object;
    const contained = caught(() =>
      validateEnvelope(new Proxy({}, { ownKeys() { throw hostileChain; } })),
    ) as EventBusEnvelopeError;

    expect(contained).toBeInstanceOf(EventBusEnvelopeError);
    expect(contained.details).toEqual({
      issues: [{ path: "", message: "reading the envelope as own data failed" }],
    });

    // Positive control: a genuine own-data refusal still renders its own reason.
    const honest = caught(() => validateEnvelope({ ...base, payload: new Date(0) })) as EventBusEnvelopeError;
    expect(honest.details).toEqual({
      issues: [{ path: "", message: "a non-plain prototype is not envelope data" }],
    });
  });

  it("passes an honest refusal through with its message, code and details intact", () => {
    const refusal = caught(() => validateEnvelope({ ...base, eventId: "not-a-uuid" })) as EventBusEnvelopeError;

    expect(refusal).toBeInstanceOf(EventBusEnvelopeError);
    expect(refusal.name).toBe("EventBusEnvelopeError");
    expect(refusal.code).toBe("EVENT_BUS_ENVELOPE_INVALID");
    expect(refusal.message).toBe("value is not a valid §7.1 event envelope");
    expect(refusal.details).toEqual({
      issues: [{ path: "eventId", message: "must be a lowercase canonical UUIDv7" }],
    });
    // The brand is invisible: one own SYMBOL, non-enumerable, so it changes no
    // enumerable key and no structural comparison.
    const symbols = Object.getOwnPropertySymbols(refusal);
    expect(symbols.length).toBe(1);
    expect(Object.getOwnPropertyDescriptor(refusal, symbols[0]!)).toEqual({
      value: true, writable: false, enumerable: false, configurable: false,
    });
    expect(Object.keys(refusal)).toEqual(Object.keys(new EventBusEnvelopeError("any")));
    expect(refusal).toEqual(
      new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
        issues: [{ path: "eventId", message: "must be a lowercase canonical UUIDv7" }],
      }),
    );
  });
});

describe("decodeEnvelope refuses a non-string entry with a typed refusal", () => {
  it.each([
    { name: "undefined", value: undefined, received: "undefined" },
    { name: "null", value: null, received: "object" },
    { name: "a number", value: 7, received: "number" },
    { name: "an object", value: {}, received: "object" },
    { name: "an array", value: [], received: "object" },
    { name: "a symbol", value: Symbol("entry"), received: "symbol" },
    { name: "a bigint", value: 1n, received: "bigint" },
  ])("refuses $name", ({ value, received }) => {
    const result = caught(() => decodeEnvelope(value as never));

    expect(result).toBeInstanceOf(EventBusEnvelopeError);
    expect((result as EventBusEnvelopeError).message).toBe("a stored entry must be a string");
    expect((result as EventBusEnvelopeError).details).toEqual({ received });
  });

  it("still refuses a string that is not JSON, and one that is not an envelope", () => {
    expect(() => decodeEnvelope("{not json")).toThrow(/not valid JSON/u);
    expect(() => decodeEnvelope(JSON.stringify({ hello: "world" }))).toThrow(EventBusEnvelopeError);
    expect(decodeEnvelope(HONEST_FIXTURES[0]!.encoded)).toEqual(HONEST_FIXTURES[0]!.input);
  });
});
