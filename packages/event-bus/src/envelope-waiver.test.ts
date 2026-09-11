/**
 * The required-key waiver.
 *
 * zod@4.4.3 reads a field's optionality off `schema._zod.optin` / `._zod.optout`
 * (`$ZodObjectJIT.generateFastpass`, and `util.optionalKeys` on the slow path).
 * `_zod` is an ordinary object, so an INHERITED `optin === "optional"` AND
 * `optout === "optional"` make every field look optional-in and optional-out —
 * and the generated fastpass then DISCARDS the inner schema's issues for any key
 * absent from the input ("For optional-in/out schemas, ignore errors on absent
 * keys"). A required field can therefore go missing and the schema still accepts.
 *
 * The waiver is baked into the compiled fastpass at the schema instance's FIRST
 * parse, so the probe is only honest in a COLD module context: each test sets
 * `Object.prototype` first, then `vi.resetModules()` + dynamic import builds a
 * brand-new schema instance under the pollution. Coldness is proved inside the
 * test, not assumed: `rawAcceptsMissing` asserts the freshly built schema really
 * does accept the same missing-field input the door refuses, on the same
 * null-prototype object the door feeds it.
 *
 * What this pins: `enforceEnvelopeConstraints` must re-check EVERY declared
 * field, present or not. Inserting `if (!Object.hasOwn(own, key)) continue;` at
 * the top of its loop leaves the rest of the suite green while an envelope with
 * no `gatewayEpoch` is accepted and encoded without it.
 */
import { expect, it, vi } from "vitest";

/**
 * Which missing REQUIRED fields the raw schema accepts under each pollution.
 *
 * - both flags: the fastpass takes its "optional-in/out" branch for every field
 *   and discards the absent key's issues, so every required field may vanish.
 * - `optin` alone: the fastpass takes its plain branch, which never raises the
 *   `nonoptional` issue — harmless for fields whose own schema rejects
 *   `undefined`, but `payload` is `z.unknown()`, which raises no issue at all,
 *   so its absence becomes acceptable.
 * - `optout` alone: `isOptionalIn` stays false, so the `nonoptional` issue is
 *   still raised and nothing is waived.
 *
 * `waivesAll` marks the context where the door's re-check is the ONLY refusal.
 */
const FORMS = [
  { keys: ["optin"], waivesAll: false, alsoWaived: ["payload"] },
  { keys: ["optout"], waivesAll: false, alsoWaived: [] },
  { keys: ["optin", "optout"], waivesAll: true, alsoWaived: [] },
] as const;

function pollute(key: string, enumerable: boolean, assign: boolean): void {
  if (assign) {
    // Enumerable assignment form: `Object.prototype.optin = "optional"`.
    (Object.prototype as Record<string, unknown>)[key] = "optional";
    return;
  }
  Object.defineProperty(Object.prototype, key, {
    value: "optional", enumerable, configurable: true, writable: true,
  });
}

function caught(run: () => unknown): unknown {
  try { return run(); } catch (error) { return error; }
}

type Probe = {
  field: string;
  rawAcceptsMissing: boolean;
  validateRefusal: string;
  decodeRefusal: string;
};

/**
 * Runs the whole probe inside one cold module context under the given pollution.
 * Returns plain data so every assertion happens after `Object.prototype` is
 * restored — an assertion library is itself a user of ordinary objects.
 */
async function probeUnderPollution(
  keys: readonly string[], enumerable: boolean, assign: boolean,
): Promise<{ probes: Probe[]; fixtureBytes: string[]; expectedBytes: string[]; declared: string[] }> {
  for (const key of keys) pollute(key, enumerable, assign);
  try {
    vi.resetModules();
    const { UnknownPayloadEventEnvelopeSchema: schema } = await import("@polymarket-bot/domain");
    const codec = await import("./envelope-codec.js");
    const { ENVELOPE_FIELD_KEYS } = await import("./envelope-door.js");
    const { HONEST_FIXTURES } = await import("./envelope-fixtures.js");
    // The refusal class must come from the SAME fresh registry as the codec:
    // a reset module graph builds a new class object, so the statically
    // imported one would never match by identity.
    const { EventBusEnvelopeError } = await import("./errors.js");
    const base = HONEST_FIXTURES[0]!.input as unknown as Record<string, unknown>;
    const refusal = (run: () => unknown): string => {
      const outcome = caught(run);
      if (!(outcome instanceof EventBusEnvelopeError)) {
        return outcome instanceof Error ? `threw ${outcome.name}` : "ACCEPTED";
      }
      return `${outcome.name}/${outcome.code}`;
    };

    // A field is REQUIRED exactly when the schema does not wrap it in
    // `optional`. `payload` is `z.unknown()`, which zod itself treats as
    // optional-in/out; §7.1 requires it, and the door refuses its absence.
    const shape = (schema as unknown as { _zod: { def: { shape: Record<string, unknown> } } })._zod.def.shape;
    const declared = ENVELOPE_FIELD_KEYS.filter(key => {
      const def = (shape[key] as { _zod: { def: { type: string } } })._zod.def;
      return def.type !== "optional";
    });

    const probes: Probe[] = declared.map(field => {
      const missing: Record<string, unknown> = { ...base };
      delete missing[field];
      // The door hands the schema a materialized null-prototype copy; parse the
      // same shape so the raw verdict is the one the door actually overrides.
      const ownShaped = Object.assign(Object.create(null) as object, missing) as Record<string, unknown>;
      return {
        field,
        rawAcceptsMissing: schema.safeParse(ownShaped).success,
        validateRefusal: refusal(() => codec.validateEnvelope(missing)),
        decodeRefusal: refusal(() => codec.decodeEnvelope(JSON.stringify(missing))),
      };
    });
    return {
      probes,
      fixtureBytes: HONEST_FIXTURES.map(({ input }) => caught(() => codec.encodeEnvelope(input)) as string),
      expectedBytes: HONEST_FIXTURES.map(({ encoded }) => encoded),
      declared: [...declared],
    };
  } finally {
    for (const key of keys) Reflect.deleteProperty(Object.prototype, key);
  }
}

for (const form of FORMS) {
  for (const shape of [
    { name: "enumerable assignment", enumerable: true, assign: true },
    { name: "defined enumerable", enumerable: true, assign: false },
    { name: "defined non-enumerable", enumerable: false, assign: false },
  ]) {
    const label = `${form.keys.join("+")} as ${shape.name}`;

    it(`refuses every missing required field under an inherited ${label}`, async () => {
      const result = await probeUnderPollution(form.keys, shape.enumerable, shape.assign);

      // Object.prototype is clean again before anything is asserted.
      for (const key of form.keys) {
        expect(Object.hasOwn(Object.prototype, key)).toBe(false);
        expect((({} as Record<string, unknown>)[key])).toBeUndefined();
      }

      // A shape change to the pinned envelope must be noticed here, not absorbed.
      expect(result.declared).toEqual([
        "eventId", "source", "sourceChannel", "receivedAt", "receivedMonotonicNs",
        "gatewayEpoch", "ingestSeq", "eventType", "schemaVersion", "payload",
      ]);

      const expected = "EventBusEnvelopeError/EVENT_BUS_ENVELOPE_INVALID";
      for (const probe of result.probes) {
        expect(`${probe.field}:validate=${probe.validateRefusal}`).toBe(`${probe.field}:validate=${expected}`);
        expect(`${probe.field}:decode=${probe.decodeRefusal}`).toBe(`${probe.field}:decode=${expected}`);
      }

      // Coldness + fail-open proof. In the both-flags contexts the freshly built
      // schema genuinely accepts EVERY missing required field on the very object
      // the door feeds it, so the door's own re-check is the only refusal left.
      // Pinning the narrower contexts too means a future zod change that widens
      // the waiver surfaces here instead of passing silently.
      expect(result.probes.filter(probe => probe.rawAcceptsMissing).map(probe => probe.field))
        .toEqual(form.waivesAll ? result.declared : [...form.alsoWaived]);

      // The waiver must not move an accept either: honest bytes are unchanged.
      expect(result.fixtureBytes).toEqual(result.expectedBytes);
    });
  }
}
