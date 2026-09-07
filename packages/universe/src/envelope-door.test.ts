/**
 * THE ENVELOPE DOOR'S BOUNDARY SUITE — `schema-boundary.md` §5 item 9(b).
 *
 * The row this file exists for is a COMPOSITION row, so every measured test
 * below runs the full path — `marketLifecycleInputFromEnvelope` and then
 * `applyMarketLifecycleEvent` — and asserts on the projection. `UNIV-1` closed
 * the lifecycle door; an envelope-layer adoption arrived there as a GENUINE OWN
 * KEY, which is the one thing that door provably cannot see.
 *
 * BASE MEASUREMENT (`989d41d`, real base code; transcript in the `UNIV-2`
 * handoff), non-enumerable variant:
 *
 * ```text
 * inherited payload.outcome:    converted OK; payload OWN outcome="YES_WIN";
 *                               fold=OK lifecycleState=RESOLVED outcomeState=YES_WIN
 * inherited payload.resolvedAt: fold=OK lifecycleState=RESOLVED resolvedAt=2099-01-01T00:00:00Z
 * inherited payload (whole):    fold=OK lifecycleState=RESOLVED resolvedAt=2099-01-01T00:00:00Z
 * inherited ingestSeq:          order={"…","ingestSeq":"999"}
 * ```
 *
 * All 10 required and all 7 optional envelope keys adopted, and five of ten
 * hostile prototype shapes turned the clean refusal into an escaping
 * `TypeError`. Each is a test below.
 *
 * Pollution hygiene is the same as `./lifecycle-door.test.ts`: installed,
 * exercised, removed in a `finally` before any assertion; every projection is
 * built at module load, before any pollution exists.
 */

import { createHash } from "node:crypto";

import { DOMAIN_EVENT_REGISTRY } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { ENVELOPE_FIELDS, openLifecycleEnvelope } from "./envelope-door.js";
import { marketLifecycleInputFromEnvelope } from "./envelope.js";
import type { UniverseResult } from "./errors.js";
import {
  MARKET_LIFECYCLE_EVENT_TYPES,
  applyMarketLifecycleEvent,
  type MarketProjection,
  type ProjectionApplied,
} from "./lifecycle.js";
import { createParameterHistory } from "./parameters.js";
import { UNBOUND_SERIES_BINDING } from "./series.js";
import {
  SAMPLE_MARKET_ID,
  marketIdentitySample,
  parameterObservationSample,
} from "./testing/index.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function withInherited<T>(key: string, descriptor: PropertyDescriptor, run: () => T): T {
  Object.defineProperty(Object.prototype, key, { ...descriptor, configurable: true });
  try {
    return run();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}

function inheritedValue(value: unknown, enumerable: boolean): PropertyDescriptor {
  return { value, enumerable, writable: true };
}

const VARIANTS = [
  { label: "non-enumerable", enumerable: false },
  { label: "enumerable", enumerable: true },
] as const;

function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function hasOwnKey(record: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(record, key) !== undefined;
}

type Attempt<T> =
  | { readonly kind: "returned"; readonly value: T }
  | { readonly kind: "threw"; readonly error: string };

function attempt<T>(run: () => T): Attempt<T> {
  try {
    return { kind: "returned", value: run() };
  } catch (error: unknown) {
    return { kind: "threw", error: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

function codesOf<T>(outcome: Attempt<UniverseResult<T>>): readonly string[] {
  if (outcome.kind === "threw") {
    throw new Error(`the door let an exception escape: ${outcome.error}`);
  }
  return outcome.value.ok ? [] : outcome.value.refusals.map((refusal) => refusal.code);
}

function withoutKey(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

const CONDITION_ID = marketIdentitySample().conditionId;

/** Built before any pollution exists; the fold is pure, so it is reused. */
const OPENED: MarketProjection = Object.freeze({
  identity: marketIdentitySample(),
  seriesBinding: UNBOUND_SERIES_BINDING,
  lifecycleState: "OPEN",
  outcomeState: "PENDING",
  metadataVersion: 1,
  openedAt: "2026-08-28T12:00:00Z",
  clarifications: [],
  parameters: createParameterHistory(SAMPLE_MARKET_ID, parameterObservationSample()),
});

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "018f3a5c-9b7e-7c3d-8f21-6b0f9a2c4d1f",
    eventType: "MarketOpened",
    schemaVersion: 1,
    source: "polymarket",
    sourceChannel: "market",
    receivedAt: "2026-08-28T12:00:00.000Z",
    receivedMonotonicNs: "123456789012345",
    gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e",
    ingestSeq: "42",
    payload: {
      internalMarketId: SAMPLE_MARKET_ID,
      conditionId: CONDITION_ID,
      openedAt: "2026-08-28T12:00:00Z",
    },
    ...overrides,
  };
}

function resolvedEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  return envelope({ eventType: "MarketResolved", payload });
}

/** The FULL path the row lives on: envelope in, projection out. */
function foldFromEnvelope(
  value: unknown,
): { readonly stage: "convert"; readonly codes: readonly string[] } | {
  readonly stage: "fold";
  readonly result: Attempt<UniverseResult<ProjectionApplied>>;
} {
  const converted = attempt(() => marketLifecycleInputFromEnvelope(value));
  if (converted.kind === "threw") {
    throw new Error(`the envelope door let an exception escape: ${converted.error}`);
  }
  if (!converted.value.ok) {
    return { stage: "convert", codes: codesOf(converted) };
  }
  const input = converted.value.value;
  return {
    stage: "fold",
    result: attempt(() => applyMarketLifecycleEvent(OPENED, input)),
  };
}

// ---------------------------------------------------------------------------
// 1. the composition row, end to end
// ---------------------------------------------------------------------------

describe("the envelope→lifecycle composition (the measured §5 item 9b row)", () => {
  const MEASURED = [
    {
      row: "outcome",
      /** BASE: `lifecycleState=RESOLVED`, `outcomeState=YES_WIN`. */
      payload: {
        internalMarketId: SAMPLE_MARKET_ID,
        conditionId: CONDITION_ID,
        resolvedAt: "2026-08-28T12:15:30Z",
      },
      inherited: "YES_WIN",
    },
    {
      row: "resolvedAt",
      /** BASE: the market resolved at `2099-01-01T00:00:00Z`. */
      payload: {
        internalMarketId: SAMPLE_MARKET_ID,
        conditionId: CONDITION_ID,
        outcome: "YES_WIN",
      },
      inherited: "2099-01-01T00:00:00Z",
    },
    {
      row: "conditionId",
      /** BASE: `checkIdentity` satisfied from the prototype. */
      payload: {
        internalMarketId: SAMPLE_MARKET_ID,
        outcome: "YES_WIN",
        resolvedAt: "2026-08-28T12:15:30Z",
      },
      inherited: CONDITION_ID,
    },
    {
      row: "internalMarketId",
      /** BASE: the id the CALLER routes the event by came from the prototype. */
      payload: {
        conditionId: CONDITION_ID,
        outcome: "YES_WIN",
        resolvedAt: "2026-08-28T12:15:30Z",
      },
      inherited: SAMPLE_MARKET_ID,
    },
  ] as const;

  for (const measured of MEASURED) {
    for (const variant of VARIANTS) {
      it(`refuses an envelope whose payload ${measured.row} only ${variant.label} Object.prototype carries`, () => {
        const outcome = withInherited(
          measured.row,
          inheritedValue(measured.inherited, variant.enumerable),
          () => foldFromEnvelope(resolvedEnvelope({ ...measured.payload })),
        );
        expect(outcome.stage).toBe("convert");
        if (outcome.stage === "convert") {
          expect(outcome.codes).toEqual(["UNIVERSE_INPUT_INVALID"]);
        }
      });
    }
  }

  it("refuses an envelope whose WHOLE payload only the prototype carries", () => {
    for (const variant of VARIANTS) {
      const outcome = withInherited(
        "payload",
        inheritedValue(
          {
            internalMarketId: SAMPLE_MARKET_ID,
            conditionId: CONDITION_ID,
            outcome: "YES_WIN",
            resolvedAt: "2099-01-01T00:00:00Z",
          },
          variant.enumerable,
        ),
        () => foldFromEnvelope(withoutKey(resolvedEnvelope({}), "payload")),
      );
      expect(outcome.stage, variant.label).toBe("convert");
      if (outcome.stage === "convert") {
        expect(outcome.codes).toEqual(["UNIVERSE_INPUT_INVALID"]);
      }
    }
  });

  it("keeps the terminal transition unreachable when all four keys are inherited at once", () => {
    for (const variant of VARIANTS) {
      const outcome = withInherited("outcome", inheritedValue("YES_WIN", variant.enumerable), () =>
        withInherited("resolvedAt", inheritedValue("2099-01-01T00:00:00Z", variant.enumerable), () =>
          withInherited("conditionId", inheritedValue(CONDITION_ID, variant.enumerable), () =>
            withInherited(
              "internalMarketId",
              inheritedValue(SAMPLE_MARKET_ID, variant.enumerable),
              () => foldFromEnvelope(resolvedEnvelope({})),
            ),
          ),
        ),
      );
      expect(outcome.stage, variant.label).toBe("convert");
      if (outcome.stage === "convert") {
        expect(outcome.codes).toEqual(["UNIVERSE_INPUT_INVALID"]);
      }
    }
  });

  it("still resolves a market from an envelope that carries its own values", () => {
    // Permission may not vary with ambient prototype state either way
    // (ADR-020 §6): the honest envelope must still fold while the same keys are
    // inherited with DIFFERENT values.
    for (const variant of VARIANTS) {
      const outcome = withInherited("outcome", inheritedValue("NO_WIN", variant.enumerable), () =>
        withInherited("resolvedAt", inheritedValue("2099-01-01T00:00:00Z", variant.enumerable), () =>
          foldFromEnvelope(
            resolvedEnvelope({
              internalMarketId: SAMPLE_MARKET_ID,
              conditionId: CONDITION_ID,
              outcome: "YES_WIN",
              resolvedAt: "2026-08-28T12:15:30Z",
            }),
          ),
        ),
      );
      expect(outcome.stage, variant.label).toBe("fold");
      if (outcome.stage !== "fold" || outcome.result.kind === "threw") {
        throw new Error("expected a fold");
      }
      const applied = outcome.result.value;
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(ownValue(applied.value.projection, "outcomeState")).toBe("YES_WIN");
        expect(ownValue(applied.value.projection, "resolvedAt")).toBe("2026-08-28T12:15:30Z");
      }
    }
  });

  it("reads no payload key through the prototype chain at all", () => {
    // An inherited ACCESSOR counts every read the whole path performs. At base
    // the market resolved; the door's tree has no chain, so the count is zero.
    let reads = 0;
    const outcome = withInherited(
      "outcome",
      {
        get: () => {
          reads += 1;
          return "YES_WIN";
        },
        enumerable: false,
      },
      () =>
        foldFromEnvelope(
          resolvedEnvelope({
            internalMarketId: SAMPLE_MARKET_ID,
            conditionId: CONDITION_ID,
            resolvedAt: "2026-08-28T12:15:30Z",
          }),
        ),
    );
    expect(reads).toBe(0);
    expect(outcome.stage).toBe("convert");
  });

  it("hands the lifecycle door a payload with no chain to read", () => {
    const result = marketLifecycleInputFromEnvelope(envelope());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.getPrototypeOf(result.value as object)).toBe(null);
    expect(Object.getPrototypeOf(result.value.payload as object)).toBe(null);
    expect(Object.getPrototypeOf(result.value.order as object)).toBe(null);
    expect(Object.isFrozen(result.value)).toBe(true);
    // D4 at the READING end: an optional field the payload does not carry.
    const answered = withInherited("rulesVersionId", inheritedValue("phantom", false), () =>
      (result.value.payload as { readonly rulesVersionId?: string }).rulesVersionId,
    );
    expect(answered).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. the 17-key sweep
// ---------------------------------------------------------------------------

const ENVELOPE_INHERITED: Readonly<Record<string, unknown>> = Object.freeze({
  eventId: "018f3a5c-9b7e-7c3d-8f21-6b0f9a2c4dff",
  eventType: "MarketOpened",
  schemaVersion: 1,
  source: "polymarket",
  sourceChannel: "channel-from-the-prototype",
  receivedAt: "2099-01-01T00:00:00.000Z",
  receivedMonotonicNs: "999999999999999",
  gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4dff",
  ingestSeq: "999",
  payload: {
    internalMarketId: SAMPLE_MARKET_ID,
    conditionId: CONDITION_ID,
    openedAt: "2099-01-01T00:00:00Z",
  },
  venueTimestamp: "2099-01-01T00:00:00Z",
  connectionId: "connection-from-the-prototype",
  subscriptionGeneration: 9,
  rawSegmentId: "segment-from-the-prototype",
  rawRecordOffset: "999",
  correlationId: "correlation-from-the-prototype",
  causationId: "causation-from-the-prototype",
});

describe("the required-key sweep: every declared key of the §7.1 envelope", () => {
  it("adopts no declared key from the prototype, in either variant", () => {
    const swept: string[] = [];
    for (const field of ENVELOPE_FIELDS) {
      const broken = withoutKey(envelope(), field.key);
      const clean = attempt(() => marketLifecycleInputFromEnvelope({ ...broken }));
      for (const variant of VARIANTS) {
        const outcome = withInherited(
          field.key,
          inheritedValue(ENVELOPE_INHERITED[field.key], variant.enumerable),
          () => attempt(() => marketLifecycleInputFromEnvelope({ ...broken })),
        );
        swept.push(`${field.key}.${variant.label}`);
        if (field.required) {
          // BASE: every one of these converted, and the ordering keys landed in
          // the emitted `order` the replay guard compares.
          expect(codesOf(outcome), `${field.key} (${variant.label})`).toEqual([
            "UNIVERSE_INPUT_INVALID",
          ]);
          continue;
        }
        expect(codesOf(outcome), `${field.key} (${variant.label})`).toEqual(codesOf(clean));
        if (outcome.kind === "returned" && outcome.value.ok) {
          expect(outcome.value.value.order, `${field.key} (${variant.label})`).toEqual({
            gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e",
            ingestSeq: "42",
          });
        }
      }
    }
    expect(swept).toHaveLength(34);
  });

  it("takes the ORDERING from the envelope, never from the prototype", () => {
    // The sharpest optional-side cell: `order` is what `checkOrder` compares and
    // what `lastEventOrder` records, and `BigInt(ingestSeq)` throws on garbage.
    for (const variant of VARIANTS) {
      for (const key of ["gatewayEpoch", "ingestSeq"] as const) {
        const outcome = withInherited(
          key,
          inheritedValue(ENVELOPE_INHERITED[key], variant.enumerable),
          () => marketLifecycleInputFromEnvelope(envelope()),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(ownValue(outcome.value.order, key), `${key} (${variant.label})`).toBe(
            key === "ingestSeq" ? "42" : "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e",
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. the census
// ---------------------------------------------------------------------------

describe("the door's declared table is derived from the frozen §7.1 contract", () => {
  it("declares exactly the envelope's keys, with the same required split", () => {
    const shape = (
      DOMAIN_EVENT_REGISTRY.require("MarketOpened", 1).envelopeSchema as unknown as {
        readonly shape: Readonly<
          Record<string, { safeParse: (value: unknown) => { success: boolean } }>
        >;
      }
    ).shape;
    expect([...ENVELOPE_FIELDS].map((field) => field.key).sort()).toEqual(
      Object.keys(shape).sort(),
    );
    for (const field of ENVELOPE_FIELDS) {
      const member = shape[field.key];
      expect(member, field.key).toBeDefined();
      const optionalInSchema = member?.safeParse(undefined).success === true;
      expect(field.required, field.key).toBe(!optionalInSchema);
    }
  });

  it("is the same shape for every lifecycle contract this projection folds", () => {
    const declared = [...ENVELOPE_FIELDS].map((field) => field.key).sort();
    for (const eventType of MARKET_LIFECYCLE_EVENT_TYPES) {
      for (const version of DOMAIN_EVENT_REGISTRY.versionsOf(eventType)) {
        const shape = (
          DOMAIN_EVENT_REGISTRY.require(eventType, version).envelopeSchema as unknown as {
            readonly shape: Readonly<Record<string, unknown>>;
          }
        ).shape;
        expect(Object.keys(shape).sort(), `${eventType}@${String(version)}`).toEqual(declared);
      }
    }
  });

  it("counts 10 required and 7 optional declared keys", () => {
    expect({
      required: ENVELOPE_FIELDS.filter((field) => field.required).length,
      optional: ENVELOPE_FIELDS.filter((field) => !field.required).length,
    }).toEqual({ required: 10, optional: 7 });
  });
});

// ---------------------------------------------------------------------------
// 4. containment
// ---------------------------------------------------------------------------

describe("the refusal construction is contained (ADR-020 amendment 2026-09-06)", () => {
  /**
   * FIVE of these ten escaped `marketLifecycleInputFromEnvelope` as a
   * `TypeError` at base — `safeParseEnvelope` catches only its own three typed
   * errors and re-throws everything else.
   */
  const HOSTILE: readonly (readonly [string, PropertyDescriptor])[] = [
    ["get (data)", { value: () => undefined, enumerable: false }],
    ["get (accessor)", { get: () => () => undefined, enumerable: false }],
    ["value (data)", { value: "hijacked", enumerable: false }],
    ["value (accessor)", { get: () => "hijacked", enumerable: false }],
    ["_zod (data)", { value: {}, enumerable: false }],
    ["_zod (accessor)", { get: () => ({}), enumerable: false }],
    ["message (data)", { value: "hijacked", enumerable: false }],
    ["message (accessor)", { get: () => "hijacked", enumerable: false }],
    ["path (data)", { value: ["hijacked"], enumerable: false }],
    ["status (data)", { value: "hijacked", enumerable: false }],
    ["issues (data)", { value: [], enumerable: false }],
    ["def (data)", { value: {}, enumerable: false }],
    ["name (data)", { value: "hijacked", enumerable: false }],
  ];

  for (const [label, descriptor] of HOSTILE) {
    it(`refuses a malformed envelope rather than throwing under an inherited ${label}`, () => {
      const key = label.slice(0, label.indexOf(" "));
      const outcome = withInherited(key, descriptor, () =>
        attempt(() => marketLifecycleInputFromEnvelope(envelope({ ingestSeq: "not-a-number" }))),
      );
      // PERMISSION may not vary; composition may (ADR-020 §6).
      expect(codesOf(outcome)).toEqual(["UNIVERSE_INPUT_INVALID"]);
    });
  }

  it("refuses an honest-but-wrong envelope with the frozen contract's own message", () => {
    const result = marketLifecycleInputFromEnvelope(envelope({ ingestSeq: "not-a-number" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals[0]?.message).toBe(
        'envelope failed the frozen domain contract: event "MarketOpened" v1 failed validation: ingestSeq: must be a canonical unsigned integer string',
      );
      expect(result.refusals[0]?.details["errorName"]).toBe("EventValidationError");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. the D2 compensation
// ---------------------------------------------------------------------------

describe("the D2 compensation holds with every zod check switched off", () => {
  it("refuses an envelope missing a required key under an inherited skipChecks", () => {
    for (const field of ENVELOPE_FIELDS.filter((entry) => entry.required)) {
      const read = withInherited("skipChecks", inheritedValue(true, false), () =>
        openLifecycleEnvelope(withoutKey(envelope(), field.key)),
      );
      expect(read.ok, field.key).toBe(false);
    }
  });

  it("refuses an ingestSeq the replay guard could not compare", () => {
    // `BigInt("not-a-number")` THROWS out of `checkOrder`, so this one FORMAT is
    // re-stated on the door's own read (the canonical grammar the frozen
    // `UnsignedBigIntStringSchema` declares — never stricter than it).
    for (const seq of ["not-a-number", "007", "", "-1", "1.5"]) {
      const read = withInherited("skipChecks", inheritedValue(true, false), () =>
        openLifecycleEnvelope(envelope({ ingestSeq: seq })),
      );
      expect(read.ok, seq).toBe(false);
    }
    const honest = withInherited("skipChecks", inheritedValue(true, false), () =>
      openLifecycleEnvelope(envelope({ ingestSeq: "0" })),
    );
    expect(honest.ok).toBe(true);
  });

  it("refuses a source outside the frozen vocabulary under an inherited skipChecks", () => {
    const read = withInherited("skipChecks", inheritedValue(true, false), () =>
      openLifecycleEnvelope(envelope({ source: "nasdaq" })),
    );
    expect(read.ok).toBe(false);
  });

  it("is never STRICTER than the contract it re-states", () => {
    // contract-accept ⟹ door-accept, over a grid of honest and near-miss forms.
    const values: readonly unknown[] = [
      undefined,
      "",
      "x",
      "0",
      "42",
      "007",
      1,
      0,
      1.5,
      true,
      null,
      [],
      {},
      "2026-08-28T12:00:00.000Z",
      "yesterday",
      "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e",
      "x".repeat(201),
    ];
    let compared = 0;
    let drift = 0;
    for (const field of ENVELOPE_FIELDS) {
      for (const value of values) {
        const candidate = { ...envelope(), [field.key]: value };
        const contractAccepts = DOMAIN_EVENT_REGISTRY.safeParseEnvelope(candidate).ok;
        const doorAccepts = openLifecycleEnvelope(candidate).ok;
        compared += 1;
        if (contractAccepts && !doorAccepts) {
          drift += 1;
        }
      }
    }
    expect(compared).toBe(ENVELOPE_FIELDS.length * 17);
    expect(drift).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. D1: what the door refuses as data
// ---------------------------------------------------------------------------

describe("D1 — the envelope is materialized before the contract sees it", () => {
  it("refuses an accessor on the envelope without invoking it", () => {
    let invoked = 0;
    const hostile = envelope();
    Object.defineProperty(hostile, "ingestSeq", {
      get: () => {
        invoked += 1;
        return "42";
      },
      enumerable: true,
      configurable: true,
    });
    const result = marketLifecycleInputFromEnvelope(hostile);
    expect(invoked).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals[0]?.code).toBe("UNIVERSE_INPUT_INVALID");
    }
  });

  it("refuses an own __proto__, a symbol key, and a foreign prototype", () => {
    expect(
      marketLifecycleInputFromEnvelope(
        JSON.parse('{"__proto__": {"eventType": "MarketOpened"}}'),
      ).ok,
    ).toBe(false);
    expect(marketLifecycleInputFromEnvelope({ ...envelope(), [Symbol("k")]: 1 }).ok).toBe(false);
    class Foreign {
      readonly eventType = "MarketOpened";
    }
    expect(marketLifecycleInputFromEnvelope(new Foreign()).ok).toBe(false);
  });

  it("keeps the unsupported-event-type verdict for a well-formed non-lifecycle envelope", () => {
    const result = marketLifecycleInputFromEnvelope(
      envelope({
        eventType: "BestBidAskChanged",
        payload: {
          internalMarketId: SAMPLE_MARKET_ID,
          tokenId: "1000000001",
          bestBidPrice: "0.4",
          bestBidSize: "10",
          bestAskPrice: "0.6",
          bestAskSize: "10",
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals[0]?.code).toBe("UNIVERSE_EVENT_UNSUPPORTED");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. honest-input preservation
// ---------------------------------------------------------------------------

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? '"[function]"' : (JSON.stringify(value) ?? "undefined");
  }
  if (Array.isArray(value)) {
    return `[${value.map((member) => stable(member)).join(",")}]`;
  }
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(ownValue(value as object, key))}`)
    .join(",")}}`;
}

function verdict(run: () => unknown): string {
  let outcome: unknown;
  try {
    outcome = run();
  } catch (error: unknown) {
    return `THREW ${(error as Error).name}: ${(error as Error).message}`;
  }
  const result = outcome as { ok: boolean; refusals?: unknown; value?: unknown };
  return result.ok === true ? `OK ${stable(result.value)}` : `REFUSED ${stable(result.refusals)}`;
}

const ENVELOPE_KEYS = [
  "eventId",
  "eventType",
  "schemaVersion",
  "source",
  "sourceChannel",
  "receivedAt",
  "receivedMonotonicNs",
  "gatewayEpoch",
  "ingestSeq",
  "payload",
  "venueTimestamp",
  "connectionId",
  "subscriptionGeneration",
  "rawSegmentId",
  "rawRecordOffset",
  "correlationId",
  "causationId",
] as const;

const HONEST_CASES: readonly (readonly [string, () => unknown])[] = [
  ["envelope/honest", () => marketLifecycleInputFromEnvelope(envelope())],
  [
    "envelope/resolved",
    () =>
      marketLifecycleInputFromEnvelope(
        resolvedEnvelope({
          internalMarketId: SAMPLE_MARKET_ID,
          conditionId: CONDITION_ID,
          outcome: "YES_WIN",
          resolvedAt: "2026-08-28T12:15:30Z",
        }),
      ),
  ],
  [
    "envelope/optionalsPresent",
    () =>
      marketLifecycleInputFromEnvelope(
        envelope({
          venueTimestamp: "2026-08-28T11:59:59Z",
          connectionId: "conn-1",
          subscriptionGeneration: 2,
          rawSegmentId: "segment-1",
          rawRecordOffset: "17",
          correlationId: "corr-1",
          causationId: "cause-1",
        }),
      ),
  ],
  ...ENVELOPE_KEYS.map(
    (key) =>
      [
        `envelope/without:${key}`,
        () => marketLifecycleInputFromEnvelope(withoutKey(envelope(), key)),
      ] as const,
  ),
  ["envelope/badSeq", () => marketLifecycleInputFromEnvelope(envelope({ ingestSeq: "not-a-number" }))],
  ["envelope/leadingZeroSeq", () => marketLifecycleInputFromEnvelope(envelope({ ingestSeq: "007" }))],
  ["envelope/badVersion", () => marketLifecycleInputFromEnvelope(envelope({ schemaVersion: 99 }))],
  ["envelope/badEventId", () => marketLifecycleInputFromEnvelope(envelope({ eventId: "not-a-uuid" }))],
  ["envelope/badEpoch", () => marketLifecycleInputFromEnvelope(envelope({ gatewayEpoch: "not-a-uuid" }))],
  [
    "envelope/badReceivedAt",
    () => marketLifecycleInputFromEnvelope(envelope({ receivedAt: "yesterday" })),
  ],
  ["envelope/badSource", () => marketLifecycleInputFromEnvelope(envelope({ source: "nasdaq" }))],
  ["envelope/unknownType", () => marketLifecycleInputFromEnvelope(envelope({ eventType: "Nope" }))],
  [
    "envelope/notLifecycle",
    () =>
      marketLifecycleInputFromEnvelope(
        envelope({
          eventType: "BestBidAskChanged",
          payload: {
            internalMarketId: SAMPLE_MARKET_ID,
            tokenId: "1000000001",
            bestBidPrice: "0.4",
            bestBidSize: "10",
            bestAskPrice: "0.6",
            bestAskSize: "10",
          },
        }),
      ),
  ],
  [
    "envelope/payloadIncomplete",
    () => marketLifecycleInputFromEnvelope(envelope({ payload: { internalMarketId: SAMPLE_MARKET_ID } })),
  ],
  [
    "envelope/payloadWrongMarketShape",
    () =>
      marketLifecycleInputFromEnvelope(
        envelope({
          payload: { internalMarketId: 7, conditionId: CONDITION_ID, openedAt: "2026-08-28T12:00:00Z" },
        }),
      ),
  ],
  ["envelope/payloadNull", () => marketLifecycleInputFromEnvelope(envelope({ payload: null }))],
  ["envelope/payloadArray", () => marketLifecycleInputFromEnvelope(envelope({ payload: [] }))],
  ["envelope/unknownKey", () => marketLifecycleInputFromEnvelope(envelope({ invented: 1 }))],
  ["envelope/empty", () => marketLifecycleInputFromEnvelope({})],
  ["envelope/null", () => marketLifecycleInputFromEnvelope(null)],
  ["envelope/string", () => marketLifecycleInputFromEnvelope("MarketOpened")],
  ["envelope/array", () => marketLifecycleInputFromEnvelope([])],
  ["envelope/number", () => marketLifecycleInputFromEnvelope(7)],
  [
    "envelope/undefinedMember",
    () => marketLifecycleInputFromEnvelope(envelope({ connectionId: undefined })),
  ],
];

describe("honest envelopes are unchanged by the door", () => {
  it("produces the verdict digest measured at base 989d41d", () => {
    // MEASURED, not asserted: this exact 40-case battery was run against the
    // REAL base code and then against the tip, and both produced `e417edc5…` —
    // byte-identical, including every refusal message the frozen contract
    // composes and the emitted input's own keys and values.
    expect(HONEST_CASES).toHaveLength(40);
    const transcript = HONEST_CASES.map(([label, run]) => `${label}\n${verdict(run)}`).join("\n");
    expect(createHash("sha256").update(transcript).digest("hex")).toBe(
      "e417edc55a3fd8870cb5780d7b402e928e17842e6738ad5b56d9d9a0409087e8",
    );
  });

  it("produces an input the projection accepts, with the envelope's own ordering", () => {
    const result = marketLifecycleInputFromEnvelope(envelope());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const discovered: MarketProjection = {
      identity: marketIdentitySample(),
      seriesBinding: UNBOUND_SERIES_BINDING,
      lifecycleState: "DISCOVERED",
      outcomeState: "PENDING",
      metadataVersion: 1,
      clarifications: [],
      parameters: createParameterHistory(SAMPLE_MARKET_ID, parameterObservationSample()),
    };
    const applied = applyMarketLifecycleEvent(discovered, result.value);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.projection.lifecycleState).toBe("OPEN");
      expect(applied.value.projection.lastEventOrder?.ingestSeq).toBe("42");
      expect(hasOwnKey(applied.value.projection.lastEventOrder as object, "gatewayEpoch")).toBe(
        true,
      );
    }
  });
});
