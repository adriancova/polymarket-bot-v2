/**
 * THE DOOR'S BOUNDARY SUITE — `docs/contracts/schema-boundary.md` §3, probe O.
 *
 * Every pollution battery here is scoped: the property is installed on
 * `Object.prototype`, the fold runs, and the property is removed in a `finally`
 * before anything is asserted. Nothing in this file leaves the prototype dirty,
 * and every projection the tests fold onto is built at module load, BEFORE any
 * pollution exists (an enumerable inherited key trips `z.strictObject`'s
 * unrecognized-key check inside `createParameterHistory`, which throws — that is
 * a different, fail-closed class and not what these tests measure).
 *
 * WHY THE ASSERTIONS READ OWN PROPERTIES. `projection.rulesVersionId` on a
 * prototype-BEARING projection answers from `Object.prototype` while the
 * pollution is installed, so a `.` read would report an adoption the projection
 * does not carry. Every assertion below therefore goes through
 * {@link ownValue} / {@link hasOwnKey}.
 *
 * BASE MEASUREMENT (`78ec81d`, real base code, both pollution variants):
 * all 32 required keys of the eight arms and all 8 optional keys adopt; the
 * three §3 rows resolve a market from the prototype; seven of nine hostile
 * prototype shapes turn the clean refusal of a malformed payload into an
 * escaping `TypeError`. Each of those is a test below.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { UniverseResult } from "./errors.js";
import {
  MAX_PAYLOAD_DEPTH,
  declaredKeysOf,
  ownEmit,
  payloadSchemaOf,
  readDeclaredPayload,
  readOwnPayload,
} from "./lifecycle-door.js";
import {
  MARKET_LIFECYCLE_EVENT_TYPES,
  applyMarketLifecycleEvent,
  type MarketLifecycleEventType,
  type MarketLifecycleInput,
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

const IDENTITY = marketIdentitySample();
const CONDITION_ID = IDENTITY.conditionId;
const MARKET_REF = { internalMarketId: SAMPLE_MARKET_ID, conditionId: CONDITION_ID } as const;

function discoveredProjection(): MarketProjection {
  return {
    identity: marketIdentitySample(),
    seriesBinding: UNBOUND_SERIES_BINDING,
    lifecycleState: "DISCOVERED",
    outcomeState: "PENDING",
    metadataVersion: 1,
    clarifications: [],
    parameters: createParameterHistory(SAMPLE_MARKET_ID, parameterObservationSample()),
  };
}

function expectApplied(result: UniverseResult<ProjectionApplied>): ProjectionApplied {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected success, got ${result.refusals.map((r) => r.code).join(", ")}`);
  }
  return result.value;
}

/** Built before any pollution exists; the fold is pure, so they are reused. */
const DISCOVERED: MarketProjection = discoveredProjection();
const OPENED: MarketProjection = expectApplied(
  applyMarketLifecycleEvent(DISCOVERED, {
    eventType: "MarketOpened",
    payload: { ...MARKET_REF, openedAt: "2026-08-28T12:00:00Z" },
  }),
).projection;

// ---------------------------------------------------------------------------
// pollution and own-read helpers
// ---------------------------------------------------------------------------

/** Installs one inherited property for the duration of `run`, then removes it. */
function withInherited<T>(
  key: string,
  descriptor: PropertyDescriptor,
  run: () => T,
): T {
  Object.defineProperty(Object.prototype, key, { ...descriptor, configurable: true });
  try {
    return run();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}

/** The value variant of the pollution, in both enumerabilities. */
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

function codesOf(result: UniverseResult<ProjectionApplied>): readonly string[] {
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

function fold(
  projection: MarketProjection,
  input: MarketLifecycleInput,
): UniverseResult<ProjectionApplied> | { readonly threw: string } {
  try {
    return applyMarketLifecycleEvent(projection, input);
  } catch (error: unknown) {
    return { threw: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

function refusalOf(
  outcome: UniverseResult<ProjectionApplied> | { readonly threw: string },
): readonly string[] {
  if ("threw" in outcome) {
    throw new Error(`the door let an exception escape: ${outcome.threw}`);
  }
  return codesOf(outcome);
}

// ---------------------------------------------------------------------------
// the eight arms, their declared keys, and a value the prototype could supply
// ---------------------------------------------------------------------------

interface Arm {
  readonly eventType: MarketLifecycleEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projection: MarketProjection;
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/**
 * What an attacker would put on `Object.prototype` for each declared key: a
 * value the frozen schema ACCEPTS, so the only thing standing between it and
 * the projection is the door.
 */
const INHERITED_VALUES: Readonly<Record<string, unknown>> = Object.freeze({
  internalMarketId: SAMPLE_MARKET_ID,
  conditionId: CONDITION_ID,
  yesTokenId: IDENTITY.yesTokenId,
  noTokenId: IDENTITY.noTokenId,
  seriesId: "phantom-series",
  metadataVersion: 7,
  previousMetadataVersion: 5,
  changedFields: ["title"],
  rulesVersionId: "rules-from-the-prototype",
  previousRulesVersionId: "rules-the-projection-never-held",
  openedAt: "2099-01-01T00:00:00Z",
  closesAt: "2099-01-01T00:00:00Z",
  outcome: "YES_WIN",
  resolvedAt: "2099-01-01T00:00:00Z",
  clarificationId: "clarification-from-the-prototype",
  observedAt: "2099-01-01T00:00:00Z",
  parametersVersion: 1,
  previousParametersVersion: 1,
  parameterVersionRef: `${SAMPLE_MARKET_ID}/v1`,
  changedParameters: ["tick_size"],
  tickSize: "0.99",
  minimumOrderSize: "999",
});

const ARMS: readonly Arm[] = [
  {
    eventType: "MarketDiscovered",
    payload: {
      ...MARKET_REF,
      yesTokenId: IDENTITY.yesTokenId,
      noTokenId: IDENTITY.noTokenId,
      metadataVersion: 2,
    },
    projection: DISCOVERED,
    required: ["internalMarketId", "conditionId", "yesTokenId", "noTokenId", "metadataVersion"],
    optional: ["seriesId"],
  },
  {
    eventType: "MarketMetadataChanged",
    payload: { ...MARKET_REF, metadataVersion: 2, changedFields: ["title"] },
    projection: DISCOVERED,
    required: ["internalMarketId", "conditionId", "metadataVersion", "changedFields"],
    optional: ["previousMetadataVersion"],
  },
  {
    eventType: "MarketRulesChanged",
    payload: { ...MARKET_REF, rulesVersionId: "rules-2", changedFields: ["rules"] },
    projection: DISCOVERED,
    required: ["internalMarketId", "conditionId", "rulesVersionId", "changedFields"],
    optional: ["previousRulesVersionId"],
  },
  {
    eventType: "MarketOpened",
    payload: { ...MARKET_REF, openedAt: "2026-08-28T12:00:00Z" },
    projection: DISCOVERED,
    required: ["internalMarketId", "conditionId", "openedAt"],
    optional: [],
  },
  {
    eventType: "MarketClosing",
    payload: { ...MARKET_REF, closesAt: "2026-08-28T12:15:00Z" },
    projection: OPENED,
    required: ["internalMarketId", "conditionId", "closesAt"],
    optional: [],
  },
  {
    eventType: "MarketResolved",
    payload: { ...MARKET_REF, outcome: "YES_WIN", resolvedAt: "2026-08-28T12:15:30Z" },
    projection: OPENED,
    required: ["internalMarketId", "conditionId", "outcome", "resolvedAt"],
    optional: ["rulesVersionId"],
  },
  {
    eventType: "MarketClarificationObserved",
    payload: { ...MARKET_REF, clarificationId: "clar-1", observedAt: "2026-08-28T12:05:00Z" },
    projection: OPENED,
    required: ["internalMarketId", "conditionId", "clarificationId", "observedAt"],
    optional: ["rulesVersionId"],
  },
  {
    eventType: "TradingParametersChanged",
    payload: {
      ...MARKET_REF,
      parametersVersion: 1,
      parameterVersionRef: `${SAMPLE_MARKET_ID}/v1`,
      changedParameters: ["tick_size"],
    },
    projection: DISCOVERED,
    required: [
      "internalMarketId",
      "conditionId",
      "parametersVersion",
      "parameterVersionRef",
      "changedParameters",
    ],
    optional: ["previousParametersVersion", "tickSize", "minimumOrderSize"],
  },
];

function withoutKey(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const copy = { ...payload };
  delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------
// 1. the three measured rows (schema-boundary §3, probe O)
// ---------------------------------------------------------------------------

describe("the three measured rows of schema-boundary §3 (probe O)", () => {
  const MEASURED = [
    {
      row: "outcome",
      /** BASE: `lifecycleState=RESOLVED`, `outcomeState=YES_WIN` — the projection's one irreversible transition. */
      payload: { ...MARKET_REF, resolvedAt: "2026-08-28T12:15:30Z" },
      inherited: "YES_WIN",
    },
    {
      row: "resolvedAt",
      /** BASE: the market resolves at `2099-01-01T00:00:00Z`, an instant no event carried. */
      payload: { ...MARKET_REF, outcome: "YES_WIN" },
      inherited: "2099-01-01T00:00:00Z",
    },
    {
      row: "conditionId",
      /** BASE: `checkIdentity` — the guard that refuses an event naming a DIFFERENT market — is satisfied from the prototype. */
      payload: {
        internalMarketId: SAMPLE_MARKET_ID,
        outcome: "YES_WIN",
        resolvedAt: "2026-08-28T12:15:30Z",
      },
      inherited: CONDITION_ID,
    },
  ] as const;

  for (const measured of MEASURED) {
    for (const variant of VARIANTS) {
      it(`refuses a MarketResolved whose ${measured.row} only ${variant.label} Object.prototype carries`, () => {
        const outcome = withInherited(
          measured.row,
          inheritedValue(measured.inherited, variant.enumerable),
          () =>
            fold(OPENED, { eventType: "MarketResolved", payload: { ...measured.payload } }),
        );
        expect(refusalOf(outcome)).toEqual(["UNIVERSE_INPUT_INVALID"]);
      });
    }
  }

  it("keeps the terminal transition unreachable when all three keys are inherited at once", () => {
    for (const variant of VARIANTS) {
      const outcome = withInherited(
        "outcome",
        inheritedValue("YES_WIN", variant.enumerable),
        () =>
          withInherited(
            "resolvedAt",
            inheritedValue("2099-01-01T00:00:00Z", variant.enumerable),
            () =>
              withInherited(
                "conditionId",
                inheritedValue(CONDITION_ID, variant.enumerable),
                () =>
                  fold(OPENED, {
                    eventType: "MarketResolved",
                    payload: { internalMarketId: SAMPLE_MARKET_ID },
                  }),
              ),
          ),
      );
      expect(refusalOf(outcome)).toEqual(["UNIVERSE_INPUT_INVALID"]);
    }
  });

  it("still folds an honest MarketResolved while the same keys are inherited", () => {
    // The door must close the row without breaking the event that carries its
    // own values: permission may not vary with ambient prototype state either
    // way (ADR-020 §6).
    for (const variant of VARIANTS) {
      const outcome = withInherited("outcome", inheritedValue("NO_WIN", variant.enumerable), () =>
        withInherited(
          "resolvedAt",
          inheritedValue("2099-01-01T00:00:00Z", variant.enumerable),
          () =>
            fold(OPENED, {
              eventType: "MarketResolved",
              payload: { ...MARKET_REF, outcome: "YES_WIN", resolvedAt: "2026-08-28T12:15:30Z" },
            }),
        ),
      );
      if ("threw" in outcome) {
        throw new Error(outcome.threw);
      }
      const projection = expectApplied(outcome).projection;
      expect(ownValue(projection, "outcomeState")).toBe("YES_WIN");
      expect(ownValue(projection, "resolvedAt")).toBe("2026-08-28T12:15:30Z");
    }
  });

  it("reads no declared key through the prototype chain at all", () => {
    // An inherited ACCESSOR counts every read the fold performs. At base zod's
    // own property read invoked it and the market resolved; the door's tree has
    // no chain to read, so the count is zero.
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
        fold(OPENED, {
          eventType: "MarketResolved",
          payload: { ...MARKET_REF, resolvedAt: "2026-08-28T12:15:30Z" },
        }),
    );
    const observed = reads;
    expect(observed).toBe(0);
    expect(refusalOf(outcome)).toEqual(["UNIVERSE_INPUT_INVALID"]);
  });
});

// ---------------------------------------------------------------------------
// 2. the required-key sweep across all eight arms
// ---------------------------------------------------------------------------

describe("the required-key sweep: every declared key of every arm", () => {
  for (const arm of ARMS) {
    it(`${arm.eventType}: no required key can come from the prototype`, () => {
      for (const key of arm.required) {
        const payload = withoutKey(arm.payload, key);
        for (const variant of VARIANTS) {
          const outcome = withInherited(
            key,
            inheritedValue(INHERITED_VALUES[key], variant.enumerable),
            () => fold(arm.projection, { eventType: arm.eventType, payload: { ...payload } }),
          );
          expect(
            refusalOf(outcome),
            `${arm.eventType}.${key} (${variant.label})`,
          ).toEqual(["UNIVERSE_INPUT_INVALID"]);
        }
      }
    });
  }

  it("no OPTIONAL key can come from the prototype either", () => {
    // An optional key is not a refusal when it is absent, so the pin is that
    // the fold BEHAVES as if it were absent: at base an inherited
    // `rulesVersionId` was written onto a resolved market and into a
    // clarification record, and an inherited `previousRulesVersionId` /
    // `tickSize` refused an honest event.
    const seen: string[] = [];
    for (const arm of ARMS) {
      for (const key of arm.optional) {
        for (const variant of VARIANTS) {
          const outcome = withInherited(
            key,
            inheritedValue(INHERITED_VALUES[key], variant.enumerable),
            () => fold(arm.projection, { eventType: arm.eventType, payload: { ...arm.payload } }),
          );
          if ("threw" in outcome) {
            throw new Error(`${arm.eventType}.${key}: ${outcome.threw}`);
          }
          const applied = expectApplied(outcome);
          seen.push(`${arm.eventType}.${key}.${variant.label}`);
          // The value never lands as an own property of anything emitted.
          expect(hasOwnKey(applied.projection, key), `${arm.eventType}.${key}`).toBe(
            hasOwnKey(arm.projection, key),
          );
          for (const record of applied.projection.clarifications) {
            expect(hasOwnKey(record, key), `${arm.eventType}.${key} on a clarification`).toBe(
              false,
            );
          }
        }
      }
    }
    expect(seen).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// 3. the census: the door's read table may not drift from the frozen schemas
// ---------------------------------------------------------------------------

describe("the door's declared-key table is derived from the frozen schemas", () => {
  it("covers every event type the projection folds", () => {
    for (const eventType of MARKET_LIFECYCLE_EVENT_TYPES) {
      expect(declaredKeysOf(eventType).length).toBeGreaterThan(0);
      expect(payloadSchemaOf(eventType)).toBeDefined();
    }
  });

  it("declares exactly the keys the frozen schema declares, with the same required split", () => {
    for (const eventType of MARKET_LIFECYCLE_EVENT_TYPES) {
      const schema = payloadSchemaOf(eventType) as unknown as {
        readonly shape: Readonly<Record<string, { safeParse: (value: unknown) => { success: boolean } }>>;
      };
      const shape = schema.shape;
      const declared = declaredKeysOf(eventType);
      expect([...declared].map((entry) => entry.key).sort()).toEqual(Object.keys(shape).sort());
      for (const entry of declared) {
        const member = shape[entry.key];
        expect(member, `${eventType}.${entry.key}`).toBeDefined();
        // A key the schema accepts as `undefined` is optional; anything else is
        // required, and the door must refuse the event that omits it.
        const optionalInSchema = member?.safeParse(undefined).success === true;
        expect(entry.required, `${eventType}.${entry.key}`).toBe(!optionalInSchema);
      }
    }
  });

  it("counts 32 required and 8 optional declared keys across the eight arms", () => {
    // The census `UNIV-1` measured at base: every one of the 32 required keys
    // adopted from `Object.prototype`, in both variants.
    let required = 0;
    let optional = 0;
    for (const eventType of MARKET_LIFECYCLE_EVENT_TYPES) {
      for (const entry of declaredKeysOf(eventType)) {
        if (entry.required) {
          required += 1;
        } else {
          optional += 1;
        }
      }
    }
    expect({ required, optional }).toEqual({ required: 32, optional: 8 });
  });
});

// ---------------------------------------------------------------------------
// 4. containment: a refusal that cannot be constructed is still a refusal
// ---------------------------------------------------------------------------

describe("the refusal construction is contained (ADR-020 amendment 2026-09-06)", () => {
  /**
   * Shapes that drive `zod`'s own error-construction path. Seven of these nine
   * turned this door's clean refusal into an escaping `TypeError` at base.
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
    ["path (accessor)", { get: () => ["hijacked"], enumerable: false }],
    ["issues (data)", { value: [], enumerable: false }],
    ["def (data)", { value: {}, enumerable: false }],
  ];

  for (const [label, descriptor] of HOSTILE) {
    it(`refuses a malformed payload rather than throwing under an inherited ${label}`, () => {
      const key = label.slice(0, label.indexOf(" "));
      const outcome = withInherited(key, descriptor, () =>
        fold(DISCOVERED, {
          eventType: "MarketOpened",
          payload: { ...MARKET_REF, openedAt: "yesterday" },
        }),
      );
      // PERMISSION may not vary; composition may (ADR-020 §6).
      expect(refusalOf(outcome)).toEqual(["UNIVERSE_INPUT_INVALID"]);
    });
  }

  it("refuses an honest-but-wrong event with the frozen schema's own message", () => {
    const outcome = fold(DISCOVERED, {
      eventType: "MarketOpened",
      payload: { ...MARKET_REF, openedAt: "yesterday" },
    });
    if ("threw" in outcome || outcome.ok) {
      throw new Error("expected a refusal");
    }
    expect(outcome.refusals[0]?.message).toBe(
      "MarketOpened payload is invalid: openedAt: Invalid ISO datetime",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. D1: what the materializer accepts as data, and what it refuses
// ---------------------------------------------------------------------------

describe("D1 — the materializer reads own data only", () => {
  it("builds a prototype-free tree from own properties", () => {
    const read = readOwnPayload({ ...MARKET_REF, openedAt: "2026-08-28T12:00:00Z" });
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(Object.getPrototypeOf(read.value as object)).toBe(null);
    expect(ownValue(read.value as object, "conditionId")).toBe(CONDITION_ID);
  });

  it("does not copy an inherited key, in either variant", () => {
    for (const variant of VARIANTS) {
      const read = withInherited("outcome", inheritedValue("YES_WIN", variant.enumerable), () =>
        readOwnPayload({ ...MARKET_REF }),
      );
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(hasOwnKey(read.value as object, "outcome"), variant.label).toBe(false);
      }
    }
  });

  it("refuses an accessor property without invoking it", () => {
    let invoked = 0;
    const payload = {};
    Object.defineProperty(payload, "outcome", {
      get: () => {
        invoked += 1;
        return "YES_WIN";
      },
      enumerable: true,
      configurable: true,
    });
    const read = readOwnPayload(payload);
    expect(invoked).toBe(0);
    expect(read.ok).toBe(false);
  });

  it("refuses a symbol-keyed property, an own __proto__, and a foreign prototype", () => {
    const symbolKeyed = { ...MARKET_REF, [Symbol("k")]: 1 };
    expect(readOwnPayload(symbolKeyed).ok).toBe(false);
    const ownProto = JSON.parse('{"__proto__": {"outcome": "YES_WIN"}}') as unknown;
    expect(readOwnPayload(ownProto).ok).toBe(false);
    class Foreign {
      readonly conditionId = CONDITION_ID;
    }
    expect(readOwnPayload(new Foreign()).ok).toBe(false);
  });

  it("refuses a tree deeper than the bound and a sparse array", () => {
    let deep: unknown = "leaf";
    for (let level = 0; level <= MAX_PAYLOAD_DEPTH; level += 1) {
      deep = { nested: deep };
    }
    expect(readOwnPayload(deep).ok).toBe(false);
    const sparse = [1, 2, 3];
    delete sparse[1];
    expect(readOwnPayload({ changedFields: sparse }).ok).toBe(false);
  });

  it("reads an own undefined as absent, the verdict zod already gives it", () => {
    const read = readOwnPayload({ ...MARKET_REF, rulesVersionId: undefined });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(hasOwnKey(read.value as object, "rulesVersionId")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. D3/D4: the record the arms fold, and the records this package emits
// ---------------------------------------------------------------------------

describe("D3/D4 — the folded record is built here, prototype-free", () => {
  it("emits a null-prototype record carrying exactly the keys the event owns", () => {
    const read = readDeclaredPayload("MarketResolved", {
      ...MARKET_REF,
      outcome: "YES_WIN",
      resolvedAt: "2026-08-28T12:15:30Z",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(Object.getPrototypeOf(read.value)).toBe(null);
    expect(Object.keys(read.value).sort()).toEqual([
      "conditionId",
      "internalMarketId",
      "outcome",
      "resolvedAt",
    ]);
  });

  it("refuses a payload whose own value is not the shape the schema declares", () => {
    // The D2 compensation: this read holds with every zod check disabled.
    const read = readDeclaredPayload("MarketResolved", {
      ...MARKET_REF,
      outcome: "NOT_A_TERMINAL_STATE",
      resolvedAt: "yesterday",
    });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.issues).toEqual([
        "outcome: the event's own outcome is not one of the four terminal outcome states",
        "resolvedAt: the event's own resolvedAt is not an instant that parses",
      ]);
    }
  });

  it("holds the measured rows closed with every zod check switched off", () => {
    // `skipChecks` is ADR-020 §1 class 4: one inherited property turns every
    // `.uuid()`, `.datetime()`, `.regex()` and `.min()` in the process into a
    // no-op. At base it resolved a market at "yesterday" and recorded an empty
    // clarification id.
    const cases: readonly (readonly [MarketProjection, MarketLifecycleInput])[] = [
      [
        OPENED,
        {
          eventType: "MarketResolved",
          payload: { ...MARKET_REF, outcome: "YES_WIN", resolvedAt: "yesterday" },
        },
      ],
      [
        DISCOVERED,
        {
          eventType: "MarketOpened",
          payload: { internalMarketId: SAMPLE_MARKET_ID, conditionId: "", openedAt: "2026-08-28T12:00:00Z" },
        },
      ],
      [
        OPENED,
        {
          eventType: "MarketClarificationObserved",
          payload: { ...MARKET_REF, clarificationId: "", observedAt: "2026-08-28T12:05:00Z" },
        },
      ],
      [
        DISCOVERED,
        {
          eventType: "MarketDiscovered",
          payload: {
            ...MARKET_REF,
            yesTokenId: IDENTITY.yesTokenId,
            noTokenId: IDENTITY.noTokenId,
            metadataVersion: 2.5,
          },
        },
      ],
      [
        DISCOVERED,
        {
          eventType: "MarketMetadataChanged",
          payload: { ...MARKET_REF, metadataVersion: 2, changedFields: [] },
        },
      ],
    ];
    for (const [projection, input] of cases) {
      const outcome = withInherited("skipChecks", inheritedValue(true, false), () =>
        fold(projection, input),
      );
      expect(refusalOf(outcome), input.eventType).toEqual(["UNIVERSE_INPUT_INVALID"]);
    }
  });

  it("emits a clarification record with a null prototype", () => {
    const applied = expectApplied(
      applyMarketLifecycleEvent(OPENED, {
        eventType: "MarketClarificationObserved",
        payload: { ...MARKET_REF, clarificationId: "clar-1", observedAt: "2026-08-28T12:05:00Z" },
      }),
    );
    const record = applied.projection.clarifications[0];
    expect(record).toBeDefined();
    expect(Object.getPrototypeOf(record as object)).toBe(null);
    // The output side of the same class: an absent optional field may not be
    // answered by `Object.prototype`.
    const answered = withInherited(
      "rulesVersionId",
      inheritedValue("rules-from-the-prototype", false),
      () => (record as { readonly rulesVersionId?: string }).rulesVersionId,
    );
    expect(answered).toBeUndefined();
  });

  it("emits records whose properties cannot be replaced afterwards", () => {
    const emitted = ownEmit<Record<string, unknown>>({ a: 1 });
    expect(Object.getPrototypeOf(emitted)).toBe(null);
    expect(() => {
      "use strict";
      (emitted as { a: unknown }).a = 2;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. honest-input preservation
// ---------------------------------------------------------------------------

/** Deterministic serialization: own keys only, sorted, recursive. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((member) => stable(member)).join(",")}]`;
  }
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stable(ownValue(value as object, key))}`)
    .join(",")}}`;
}

function verdict(projection: MarketProjection, input: MarketLifecycleInput): string {
  const outcome = fold(projection, input);
  if ("threw" in outcome) {
    return `THREW ${outcome.threw}`;
  }
  if (!outcome.ok) {
    return `REFUSED ${stable(outcome.refusals)}`;
  }
  return `APPLIED ${stable(outcome.value)}`;
}

/** Honest events and honest-but-wrong events, one per arm and then some. */
const HONEST_CASES: readonly (readonly [MarketProjection, MarketLifecycleInput])[] = [
  ...ARMS.map(
    (arm) =>
      [arm.projection, { eventType: arm.eventType, payload: arm.payload }] as const,
  ),
  ...ARMS.flatMap((arm) =>
    arm.required.map(
      (key) =>
        [
          arm.projection,
          { eventType: arm.eventType, payload: withoutKey(arm.payload, key) },
        ] as const,
    ),
  ),
  [
    DISCOVERED,
    { eventType: "MarketOpened", payload: { ...MARKET_REF, openedAt: "yesterday" } },
  ],
  [
    DISCOVERED,
    {
      eventType: "MarketOpened",
      payload: { ...MARKET_REF, openedAt: "2026-08-28T12:00:00Z", extra: 1 },
    },
  ],
  [
    DISCOVERED,
    {
      eventType: "MarketResolved",
      payload: { ...MARKET_REF, outcome: "DISPUTED", resolvedAt: "2026-08-28T12:15:30Z" },
    },
  ],
  [OPENED, { eventType: "MarketOpened", payload: { ...MARKET_REF, openedAt: "2026-08-28T13:00:00Z" } }],
  [
    OPENED,
    {
      eventType: "MarketResolved",
      payload: {
        ...MARKET_REF,
        outcome: "CANCELLED",
        resolvedAt: "2026-08-28T12:15:30Z",
        rulesVersionId: "rules-9",
      },
    },
  ],
  [
    OPENED,
    {
      eventType: "MarketClarificationObserved",
      payload: {
        ...MARKET_REF,
        clarificationId: "clar-2",
        observedAt: "2026-08-28T11:00:00Z",
        rulesVersionId: "rules-9",
      },
    },
  ],
  [DISCOVERED, { eventType: "MarketOpened", payload: null }],
  [DISCOVERED, { eventType: "MarketOpened", payload: "not an object" }],
];

describe("honest inputs are unchanged by the door", () => {
  it("produces the verdict digest measured at base 78ec81d", () => {
    // MEASURED, not asserted: this exact battery of 48 cases was run against
    // the REAL base code (`git stash` of `./lifecycle.ts`, so the raw
    // `safeParse` path ran) and then against the tip, and both produced
    // `b610274c…`. A change to any honest verdict — refusal code, message,
    // issue ORDER, or any projected field — moves this digest.
    //
    // The serialization is recursive and own-key-sorted, so it states VALUE
    // identity; the one representational change the door makes is disclosed in
    // `docs/handoffs` and pinned separately above (an emitted clarification
    // record now has a null prototype, with the same own keys and values).
    expect(HONEST_CASES).toHaveLength(48);
    const transcript = HONEST_CASES.map(
      ([projection, input]) => `${input.eventType}\n${verdict(projection, input)}`,
    ).join("\n");
    const digest = createHash("sha256").update(transcript).digest("hex");
    expect(digest).toBe("b610274cdc3bdc3d82a7e7ba3a29db83665aa8e25bad792dd84f27df02b90838");
  });
});
