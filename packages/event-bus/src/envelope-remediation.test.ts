import { UnknownPayloadEventEnvelopeSchema as schema } from "@polymarket-bot/domain";
import { expect, it, vi } from "vitest";

import { decodeEnvelope, encodeEnvelope, validateEnvelope } from "./envelope-codec.js";
import { ENVELOPE_FIELD_KEYS, matchesEnvelopeField } from "./envelope-door.js";
import { HONEST_FIXTURES } from "./envelope-fixtures.js";
import { EventBusEnvelopeError, EventBusUnavailableError } from "./errors.js";

const base = HONEST_FIXTURES[0]!.input;
const invalid = [
  ["schemaVersion", 0], ["sourceChannel", ""], ["connectionId", ""],
  ["rawSegmentId", ""], ["correlationId", ""], ["causationId", ""],
  ["venueTimestamp", "yesterday"], ["receivedMonotonicNs", "-1"],
  ["rawRecordOffset", "-2"], ["subscriptionGeneration", -1],
  ["eventType", "not a code"], ["payload", { venue: "binance" }],
] as const;

function caught(run: () => unknown): unknown {
  try { return run(); } catch (error) { return error; }
}
function polluted<T>(key: string, enumerable: boolean, run: () => T, getter = false): T {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.enumerable = enumerable;
  descriptor.configurable = true;
  if (getter) descriptor.get = () => { throw new TypeError("inherited cause must not be read"); };
  else { descriptor.value = true; descriptor.writable = true; }
  Object.defineProperty(Object.prototype, key, descriptor);
  try { return run(); } finally {
    Reflect.deleteProperty(Object.prototype, key);
    if (previous !== undefined) Object.defineProperty(Object.prototype, key, previous);
  }
}

for (const enumerable of [true, false]) {
  it.each(invalid)(`refuses %s under skipChecks enumerable=${enumerable}`, (key, value) => {
    const input = { ...base, [key]: value };
    expect(schema.safeParse(input).success).toBe(false);
    const results = polluted("skipChecks", enumerable, () => [
      caught(() => validateEnvelope(input)), caught(() => decodeEnvelope(JSON.stringify(input))),
    ]);
    for (const result of results) {
      expect(result).toBeInstanceOf(EventBusEnvelopeError);
      expect((result as EventBusEnvelopeError).code).toBe("EVENT_BUS_ENVELOPE_INVALID");
    }
  });

  it(`contains the forced schema fallback with throwing cause enumerable=${enumerable}`, () => {
    // Force a non-envelope exception AFTER materialization to pin the outer
    // containment fallback, independently of the library's current throw paths.
    const parse = vi.spyOn(schema, "safeParse").mockImplementation(() => { throw new TypeError("forced judgement failure"); });
    let result: unknown;
    try {
      result = polluted("cause", enumerable, () => caught(() => validateEnvelope(base)), true);
    } finally { parse.mockRestore(); }
    expect(result).toBeInstanceOf(EventBusEnvelopeError);
    expect((result as EventBusEnvelopeError).message).toBe("value is not a valid §7.1 event envelope");
    expect((result as EventBusEnvelopeError).details).toEqual({ issues: [{ path: "", message:
      "the schema could not judge this value (its refusal could not be constructed)" }] });
    expect(Object.hasOwn(result as object, "cause")).toBe(false);
  });

  it(`preserves every honest fixture with skipChecks enumerable=${enumerable}`, () => {
    const results = polluted("skipChecks", enumerable, () => HONEST_FIXTURES.map(({ input }) => ({
      bytes: encodeEnvelope(input), output: validateEnvelope(input),
    })));
    results.forEach((result, index) => {
      expect(result.bytes).toBe(HONEST_FIXTURES[index]!.encoded);
      expect(Object.getPrototypeOf(result.output)).toBe(null);
      expect(Object.isFrozen(result.output)).toBe(true);
    });
  });
}

it.each(ENVELOPE_FIELD_KEYS)("derives every constraint of %s with clean/polluted differential", key => {
  const field = schema.shape[key as keyof typeof schema.shape];
  const full = HONEST_FIXTURES[1]!.input as Record<string, unknown>;
  const corpus: unknown[] = [undefined, null, true, {}, [], -Infinity, Infinity, NaN,
    -Number.MAX_SAFE_INTEGER - 1, -1, -0, 0, 0.5, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    "", " ", "not a code", "-1", "+1", "01", "0", "1", "a", "a.b:c-d_e", full[key],
    "polymarket", "binance", "coinbase", "rtds", "internal", "unknown",
    "2024-02-29T12:34:56Z", "2026-02-29T12:34:56Z", "2026-02-30T00:00:00Z",
    "2026-09-07T12:00:00+05:30", "2026-09-07T24:00:00Z", "2026-09-07T12:00:60Z"];
  // Exercise both sides of every length boundary, without duplicating schema bounds.
  for (let length = 0; length <= 202; length++) corpus.push("a".repeat(length), "9".repeat(length));
  for (const value of corpus) {
    const clean = field.safeParse(value).success;
    expect(matchesEnvelopeField(key, value)).toBe(clean);
    for (const enumerable of [true, false]) {
      const result = polluted("skipChecks", enumerable, () => ({
        derived: matchesEnvelopeField(key, value),
        door: caught(() => validateEnvelope({ ...base, [key]: value })),
      }));
      expect(result.derived).toBe(clean);
      expect(!(result.door instanceof EventBusEnvelopeError)).toBe(clean);
    }
  }
});

for (const mode of ["clean", "enumerable", "non-enumerable"] as const) {
  it(`matches the clean schema provenance verdict in ${mode} state`, () => {
    const sources = ["polymarket", "binance", "coinbase", "rtds", "internal"];
    const payloads: unknown[] = [null, undefined, "binance", 1, false, [], {}, { venue: undefined },
      ...[...sources, "", "unknown", null, 1, true, {}, []].map(venue => ({ venue }))];
    let accepted = 0;
    let refused = 0;
    for (const source of sources) for (const payload of payloads) {
      const input = { ...base, source, payload };
      const clean = schema.safeParse(input).success;
      const run = () => caught(() => validateEnvelope(input));
      const result = mode === "clean" ? run() : polluted("skipChecks", mode === "enumerable", run);
      expect(!(result instanceof EventBusEnvelopeError)).toBe(clean);
      if (clean) accepted++; else refused++;
    }
    expect(accepted).toBe(45);
    expect(refused).toBe(55);
  });
}

it("preserves honest errors including own cause", () => {
  const cause = new Error("underlying failure");
  const error = new EventBusUnavailableError("unavailable", { stream: "events" }, cause);
  expect(error.cause).toBe(cause);
  expect(error.message).toBe("unavailable");
  for (const [key, value] of invalid) {
    const input = { ...base, [key]: value };
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("invalid fixture accepted");
    const refusal = caught(() => validateEnvelope(input)) as EventBusEnvelopeError;
    expect(refusal.name).toBe("EventBusEnvelopeError");
    expect(refusal.code).toBe("EVENT_BUS_ENVELOPE_INVALID");
    expect(refusal.message).toBe("value is not a valid §7.1 event envelope");
    expect(refusal.details).toEqual({ issues: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) });
  }
});
