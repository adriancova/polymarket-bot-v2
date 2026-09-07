import { UnknownPayloadEventEnvelopeSchema as schema } from "@polymarket-bot/domain";
import { describe, expect, it, vi } from "vitest";

import { decodeEnvelope, encodeEnvelope, validateEnvelope } from "./envelope-codec.js";
import { matchesOrderingFormat, MAX_WIRE_DEPTH, ORDERING_FORMAT_KEYS } from "./envelope-door.js";
import { HEAD_OUTCOMES, HONEST_FIXTURES } from "./envelope-fixtures.js";
import { EventBusEnvelopeError } from "./errors.js";

const base = HONEST_FIXTURES[0]!.input;
const full = HONEST_FIXTURES[1]!.input;
const fields = Object.keys(schema.shape);

// Assert only AFTER restoration: chai itself uses ordinary descriptor literals.
function polluted<T>(key: string, value: unknown, enumerable: boolean, run: () => T): T {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.enumerable = enumerable;
  descriptor.configurable = true;
  descriptor.writable = true;
  Object.defineProperty(Object.prototype, key, descriptor);
  try { return run(); } finally { Reflect.deleteProperty(Object.prototype, key); }
}
function caught(run: () => unknown): unknown {
  try { return run(); } catch (error) { return error; }
}
function without(field: string): Record<string, unknown> {
  const value: Record<string, unknown> = { ...full };
  delete value[field];
  return value;
}
function verdict(value: unknown) {
  try {
    const out = validateEnvelope(value) as Record<string, unknown>;
    return { ok: true, values: Object.fromEntries(fields.map(key => [key, out[key]])) };
  } catch (error) {
    const e = error as EventBusEnvelopeError;
    return { ok: false, name: e.name, message: e.message, details: e.details };
  }
}

describe("envelope own-data boundary", () => {
  for (const enumerable of [true, false]) {
    it.each(ORDERING_FORMAT_KEYS)(`refuses %s format with skipChecks enumerable=${enumerable}`, key => {
      const input = { ...base, [key]: key === "receivedAt" ? "yesterday" : "not-a-uuid" };
      const clean = caught(() => validateEnvelope(input));
      const result = polluted("skipChecks", true, enumerable, () => [
        caught(() => validateEnvelope(input)), caught(() => decodeEnvelope(JSON.stringify(input))),
      ]);
      expect(clean).toBeInstanceOf(EventBusEnvelopeError);
      for (const outcome of result) expect(outcome).toBeInstanceOf(EventBusEnvelopeError);
    });

    it.each(fields)(`ignores inherited declared %s enumerable=${enumerable}`, key => {
      const input = without(key);
      const clean = caught(() => validateEnvelope(input));
      const result = polluted(key, (full as Record<string, unknown>)[key], enumerable, () => [
        caught(() => validateEnvelope(input)), caught(() => decodeEnvelope(JSON.stringify(input))),
      ]);
      for (const outcome of result) {
        if (clean instanceof EventBusEnvelopeError) {
          expect(outcome).toBeInstanceOf(EventBusEnvelopeError);
        } else {
          expect(outcome).toEqual(clean);
          expect(Object.hasOwn(outcome as object, key)).toBe(false);
          expect((outcome as Record<string, unknown>)[key]).toBeUndefined();
        }
      }
    });

    it.each(["get", "path"])(`contains refusal construction under %s enumerable=${enumerable}`, key => {
      const result = polluted(key, key === "get" ? () => undefined : 42, enumerable,
        () => caught(() => validateEnvelope({ ...base, eventId: 42 })));
      expect(result).toBeInstanceOf(EventBusEnvelopeError);
      expect((result as EventBusEnvelopeError).code).toBe("EVENT_BUS_ENVELOPE_INVALID");
    });
  }

  for (const enumerable of [true, false]) {
    it.each(fields)(`refuses the own getter %s without reading it on the decode path enumerable=${enumerable}`, key => {
      let reads = 0;
      const input = { ...full };
      Object.defineProperty(input, key, { get() { reads++; return (full as Record<string, unknown>)[key]; }, enumerable, configurable: true });
      // JSON text cannot carry a getter. Inject at JSON.parse's result to exercise
      // precisely the object decode hands to validation and then to its consumer.
      const parse = vi.spyOn(JSON, "parse").mockReturnValue(input);
      let result: unknown;
      try { result = caught(() => decodeEnvelope("{}")); } finally { parse.mockRestore(); Reflect.deleteProperty(input, key); }
      expect(result).toBeInstanceOf(EventBusEnvelopeError);
      expect(reads).toBe(0);
    });
  }

  it.each(HONEST_FIXTURES.map((fixture, index) => ({ ...fixture, index })))(
    "preserves HEAD fixture $index wire bytes and every JSON value", ({ input, encoded }) => {
      expect(encodeEnvelope(input)).toBe(encoded);
      expect(JSON.parse(encodeEnvelope(input))).toEqual(input);
      expect(decodeEnvelope(encoded)).toEqual(input);
    },
  );

  const inputs: unknown[] = [null, 7, {}, { ...base, eventId: "not-a-uuid" },
    { ...base, receivedAt: "yesterday" }, { ...base, unexpected: 1 },
    { ...base, payload: { venue: "binance" } }, ...fields.map(without)];
  it.each(inputs.map((input, index) => ({ input, index })))(
    "preserves HEAD honest verdict, values and refusal bytes $index", ({ input, index }) => {
      expect(JSON.stringify(verdict(input))).toBe(JSON.stringify(HEAD_OUTCOMES[index]));
    },
  );

  it("freezes a deep snapshot and keeps absent fields absent after return", () => {
    const input = { ...base, payload: { z: [{ value: "before" }], a: false } };
    const result = validateEnvelope(input);
    input.payload.z[0]!.value = "after";
    const payload = result.payload as typeof input.payload;
    expect(payload.z[0]!.value).toBe("before");
    for (const record of [result, payload, payload.z[0]]) {
      expect(Object.getPrototypeOf(record)).toBe(null);
      expect(Object.isFrozen(record)).toBe(true);
    }
    expect(Object.isFrozen(payload.z)).toBe(true);
    const absent = polluted("connectionId", "invented", false, () => result.connectionId);
    expect(absent).toBeUndefined();
  });

  it("copies only enumerable data and preserves an own __proto__ JSON key", () => {
    const payload = JSON.parse('{"z":1,"__proto__":{"x":2},"a":3}') as object;
    Object.defineProperty(payload, "hidden", { value: "ignored", enumerable: false });
    const input = { ...base, payload };
    expect(encodeEnvelope(input)).toBe(JSON.stringify(input));
    expect(Object.hasOwn(validateEnvelope(input).payload as object, "hidden")).toBe(false);
  });

  it("refuses a nested accessor without invoking it", () => {
    let reads = 0;
    const payload = { get price() { reads++; return "1"; } };
    expect(caught(() => validateEnvelope({ ...base, payload }))).toBeInstanceOf(EventBusEnvelopeError);
    expect(reads).toBe(0);
  });

  it("bounds recursive copying and contains hostile reflection", () => {
    let payload: unknown = null;
    for (let depth = 0; depth < MAX_WIRE_DEPTH; depth++) payload = { child: payload };
    expect(caught(() => validateEnvelope({ ...base, payload }))).toBeInstanceOf(EventBusEnvelopeError);
    const proxy = new Proxy({}, { ownKeys() { throw new TypeError("hostile reflection"); } });
    expect(caught(() => validateEnvelope({ ...base, payload: proxy }))).toBeInstanceOf(EventBusEnvelopeError);
  });
});

// All four clean accept sets are compared in both directions, with positive
// and negative rows. Boundary mutations cover every character of valid seeds.
it.each(ORDERING_FORMAT_KEYS)("differentially derives %s from its schema", key => {
  const seed = base[key];
  const corpus: unknown[] = [undefined, null, 0, true, {}, [], "", "yesterday", "not-a-uuid",
    seed, seed.toUpperCase(), ` ${seed}`, `${seed}\n`, "0", "01", "-1", "+1",
    "9".repeat(40), "9".repeat(41), "2024-02-29T12:34:56Z", "2026-02-29T12:34:56Z",
    "2026-02-30T00:00:00Z", "2026-09-07", "2026-09-07T12:00:00+05:30",
    "2026-09-07T12:00:00", "2026-09-07T24:00:00Z", "2026-09-07T12:00:60Z"];
  for (let index = 0; index < seed.length; index++) {
    for (const replacement of ["0", "7", "8", "f", "F", "-", " ", "Z", "9", "\n"]) {
      corpus.push(seed.slice(0, index) + replacement + seed.slice(index + 1));
    }
  }
  let accepted = 0;
  let refused = 0;
  for (const value of corpus) {
    const clean = schema.shape[key].safeParse(value).success;
    if (clean) accepted++; else refused++;
    expect(matchesOrderingFormat(key, value)).toBe(clean);
    for (const enumerable of [true, false]) {
      expect(polluted("skipChecks", true, enumerable, () => matchesOrderingFormat(key, value))).toBe(clean);
    }
  }
  expect(accepted).toBeGreaterThan(0);
  expect(refused).toBeGreaterThan(0);
});
