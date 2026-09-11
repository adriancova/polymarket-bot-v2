/**
 * The door's own refusals — the ones the schema does not make for it.
 *
 * Every case here is a value the pinned schema accepts (or accepts after
 * silently dropping something), so `copyMember` / `enforceEnvelopeConstraints`
 * is the only layer that refuses it. Deleting any one of those branches leaves
 * the rest of the suite green, which is why each has its own row below.
 */
import { UnknownPayloadEventEnvelopeSchema as schema } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { decodeEnvelope, encodeEnvelope, validateEnvelope } from "./envelope-codec.js";
import { HONEST_FIXTURES } from "./envelope-fixtures.js";
import { EventBusEnvelopeError } from "./errors.js";

const base = HONEST_FIXTURES[0]!.input as unknown as Record<string, unknown>;

function refusal(run: () => unknown): { message: string; issues: unknown } {
  try {
    return { message: `ACCEPTED: ${JSON.stringify(run())}`, issues: null };
  } catch (error) {
    if (!(error instanceof EventBusEnvelopeError)) {
      return { message: `threw ${(error as Error).name}: ${(error as Error).message}`, issues: null };
    }
    const details = error.details as { issues?: { path: string; message: string }[] };
    return { message: details.issues?.[0]?.message ?? "(no issue)", issues: details.issues };
  }
}

class SpoofsItsJson {
  public readonly own = "own property";
  public toJSON(): unknown {
    return { spoofed: "from the prototype's toJSON" };
  }
}

// Built by index rather than as `[1, , 3]` so the hole survives any tooling
// that would rewrite a sparse literal; `hasSparseHole` re-checks it below.
const sparse: unknown[] = [];
sparse[0] = 1;
sparse[2] = 3;

const symbolKeyed: Record<string, unknown> = { declared: 1 };
(symbolKeyed as Record<symbol, unknown>)[Symbol("hidden")] = "not envelope data";

const cases: { name: string; payload: unknown; message: string }[] = [
  // Without the prototype check, a Date copies as an own-property-free `{}` —
  // the encoded payload silently loses the instant it was carrying.
  { name: "a Date payload", payload: new Date(0), message: "a non-plain prototype is not envelope data" },
  // Without it, a class instance encodes from its own props, contradicting the
  // `{"spoofed":…}` a plain JSON.stringify of the same value would produce.
  { name: "a class instance whose prototype defines toJSON", payload: new SpoofsItsJson(),
    message: "a non-plain prototype is not envelope data" },
  { name: "a function value", payload: { handler: () => "code, not data" },
    message: "an envelope must contain data, not executable or symbolic values" },
  { name: "a symbol value", payload: { marker: Symbol("not data") },
    message: "an envelope must contain data, not executable or symbolic values" },
  { name: "a sparse array", payload: { prices: sparse }, message: "a sparse array is not envelope data" },
  { name: "a symbol-keyed property", payload: symbolKeyed,
    message: "a symbol-keyed property is not envelope data" },
];

describe("the door's own data refusals", () => {
  it.each(cases)("refuses $name", ({ payload, message }) => {
    const input = { ...base, payload };
    expect(refusal(() => validateEnvelope(input)).message).toBe(message);
    expect(refusal(() => encodeEnvelope(input as never)).message).toBe(message);
  });

  it("keeps its hostile fixtures hostile", () => {
    // A de-sparsed array or a lost symbol key would make those rows pass for the
    // wrong reason, so the fixtures assert their own shape.
    expect(sparse.length).toBe(3);
    expect(Object.hasOwn(sparse, "1")).toBe(false);
    expect(Object.getOwnPropertySymbols(symbolKeyed).length).toBe(1);
  });

  it("pins what the refused Date and class instance would otherwise encode as", () => {
    // Guards against a future "harmless" relaxation: these are the two wrong
    // wire forms the prototype refusal exists to prevent.
    expect(JSON.stringify({ a: new Date(0) })).toBe('{"a":"1970-01-01T00:00:00.000Z"}');
    expect(JSON.stringify({ a: new SpoofsItsJson() })).toBe('{"a":{"spoofed":"from the prototype\'s toJSON"}}');
    expect(Object.keys(new SpoofsItsJson())).toEqual(["own"]);
    // The schema itself has no opinion on any of it: payload is `z.unknown()`.
    for (const { payload } of cases) {
      expect(schema.safeParse({ ...base, payload }).success).toBe(true);
    }
  });

  // SANCTIONED TIGHTENING over the schema's accept-and-drop verdict. zod's
  // `handleCatchall` skips a top-level own `__proto__` before its unknown-key
  // scan, so the strict envelope schema ACCEPTS these bytes and returns a value
  // with the member silently removed. Dropping recorded data is what §8.3
  // forbids, so the door's unknown-key restatement refuses the envelope instead.
  // See the matching comment in envelope-door.ts; do not "fix" this to match zod.
  it("refuses wire bytes carrying a top-level __proto__ member, which the schema accepts and drops", () => {
    const honest = HONEST_FIXTURES[0]!;
    const injected = `{"__proto__":{"x":1},${honest.encoded.slice(1)}`;
    const parsed: unknown = JSON.parse(injected);

    // The member really is there as own data, and the schema really does accept.
    expect(Object.hasOwn(parsed as object, "__proto__")).toBe(true);
    const verdict = schema.safeParse(parsed);
    expect(verdict.success).toBe(true);
    expect(Object.hasOwn(verdict.data as object, "__proto__")).toBe(false);
    // The dropped member is the ONLY difference the schema reports…
    expect({ ...(verdict.data as object) }).toEqual({ ...(honest.input as object) });
    // …though its output is re-keyed into shape order, so it is not the wire
    // bytes either. That is the second reason the door encodes its own copy of
    // the caller's input rather than the parse output.
    expect(JSON.stringify(verdict.data)).not.toBe(honest.encoded);

    // The door refuses rather than dropping it.
    expect(refusal(() => decodeEnvelope(injected)).message)
      .toBe("the own envelope does not match its schema constraints");
    expect(refusal(() => validateEnvelope(parsed)).message)
      .toBe("the own envelope does not match its schema constraints");

    // The honest bytes it was derived from are still accepted unchanged.
    expect(encodeEnvelope(decodeEnvelope(honest.encoded))).toBe(honest.encoded);
  });
});
