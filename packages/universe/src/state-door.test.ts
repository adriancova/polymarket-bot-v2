/**
 * `./state-door.ts` — the projection-side class, the two re-stated formats, the
 * §7.1 order re-statement, and the two bounded tightenings.
 *
 * EVERY ROW HERE WAS MEASURED AT BASE `c2c0733` FIRST, in BOTH pollution
 * variants, and the base verdict is quoted in the test that closes it. The
 * pollution is installed with `Object.defineProperty` on `Object.prototype`, the
 * call runs, and the property is removed in a `finally` before anything is
 * asserted; an `afterEach` removes it again, so a throw mid-test cannot leave
 * the prototype dirty for another file.
 */

import { MarketDiscoveredPayloadSchema } from "@polymarket-bot/domain";
import { afterEach, describe, expect, it } from "vitest";

import { evaluateMarketReadiness } from "./eligibility.js";
import type { UniverseResult } from "./errors.js";
import {
  applyMarketLifecycleEvent,
  clarificationsAfterOpen,
  effectiveCloseInstant,
  effectiveLifecycleState,
  recordObservedOutcomeState,
  type MarketProjection,
} from "./lifecycle.js";
import {
  EVENT_ORDER_FIELDS,
  openEventOrder,
  openMetadataVersion,
  openOwnProjection,
  ownProjectionField,
  restateDeclaredFormats,
  withOwnField,
} from "./state-door.js";
import {
  applyMarketEvent,
  approveSeries,
  bindMarketToSeries,
  createUniverseRegistry,
  registerMarket,
  registerSeries,
} from "./registry.js";
import {
  SAMPLE_MARKET_ID,
  SAMPLE_RULES_VERSION_ID,
  SAMPLE_SERIES_ID,
  marketIdentitySample,
  parameterObservationSample,
  permittingSettlementView,
  seriesDefinitionSample,
} from "./testing/index.js";

// ---------------------------------------------------------------------------
// Pollution helpers. BOTH variants, always.
// ---------------------------------------------------------------------------

const VARIANTS: readonly { readonly label: string; readonly enumerable: boolean }[] = [
  { label: "non-enumerable", enumerable: false },
  { label: "enumerable", enumerable: true },
];

const POLLUTED: string[] = [];

function withInherited<T>(key: string, descriptor: PropertyDescriptor, run: () => T): T {
  POLLUTED.push(key);
  Object.defineProperty(Object.prototype, key, { ...descriptor, configurable: true });
  try {
    return run();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
    POLLUTED.pop();
  }
}

function inherited(value: unknown, enumerable: boolean): PropertyDescriptor {
  return { value, enumerable, writable: true };
}

afterEach(() => {
  for (const key of POLLUTED.splice(0)) {
    Reflect.deleteProperty(Object.prototype, key);
  }
  for (const key of ["rulesVersionId", "openedAt", "closesAt", "resolvedAt", "lastEventOrder", "skipChecks"]) {
    Reflect.deleteProperty(Object.prototype, key);
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONDITION_ID = marketIdentitySample().conditionId;
const EPOCH = "01936f00-0000-7000-8000-0000000e0001";
const REF = { internalMarketId: SAMPLE_MARKET_ID, conditionId: CONDITION_ID } as const;

function seededProjection(): MarketProjection {
  const registered = registerMarket(createUniverseRegistry(), {
    identity: marketIdentitySample(),
    parameters: parameterObservationSample(),
  });
  /* c8 ignore next 3 -- the sample always registers. */
  if (!registered.ok) {
    throw new Error("fixture failed");
  }
  return registered.value.projection;
}

const SEEDED = seededProjection();

function seededRegistry(): ReturnType<typeof createUniverseRegistry> {
  const registered = registerMarket(createUniverseRegistry(), {
    identity: marketIdentitySample(),
    parameters: parameterObservationSample(),
  });
  /* c8 ignore next 3 -- the sample always registers. */
  if (!registered.ok) {
    throw new Error("fixture failed");
  }
  return registered.value.registry;
}

const REGISTRY = seededRegistry();

/** A stable rendering of a fold's outcome: verdict plus every projected field. */
function verdict(run: () => unknown): string {
  let outcome: unknown;
  try {
    outcome = run();
  } catch (error: unknown) {
    return `THREW ${(error as Error).name}: ${(error as Error).message}`;
  }
  const result = outcome as UniverseResult<{
    projection: MarketProjection;
    changed: boolean;
    idempotent: boolean;
  }>;
  if (!result.ok) {
    return `REFUSED ${result.refusals.map((refusal) => refusal.code).join(",")}`;
  }
  const projection = result.value.projection;
  return [
    `OK changed=${String(result.value.changed)}`,
    `idempotent=${String(result.value.idempotent)}`,
    `lifecycleState=${projection.lifecycleState}`,
    `outcomeState=${projection.outcomeState}`,
    `rulesVersionId=${String(projection.rulesVersionId)}`,
    `openedAt=${String(projection.openedAt)}`,
    `closesAt=${String(projection.closesAt)}`,
    `resolvedAt=${String(projection.resolvedAt)}`,
    `metadataVersion=${String(projection.metadataVersion)}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// The measured rows (UNIV-1 r1 MED-1)
// ---------------------------------------------------------------------------

/**
 * The five optional `MarketProjection` fields, each with the cell that measured
 * it and the BASE verdict that cell produced.
 */
const PROJECTION_CELLS: readonly {
  readonly field: string;
  readonly base: string;
  readonly value: unknown;
  readonly run: () => unknown;
}[] = [
  {
    field: "rulesVersionId",
    base: "APPLIED over a rules hole (clean refuses UNIVERSE_RULES_VERSION_MISMATCH)",
    value: "rv-ghost",
    run: () =>
      applyMarketLifecycleEvent(SEEDED, {
        eventType: "MarketRulesChanged",
        payload: {
          ...REF,
          rulesVersionId: "rv-2",
          previousRulesVersionId: "rv-ghost",
          changedFields: ["rules"],
        },
      }),
  },
  {
    field: "openedAt",
    base: "MarketOpened swallowed as idempotent; the market never left DISCOVERED",
    value: "2026-08-28T12:00:00Z",
    run: () =>
      applyMarketLifecycleEvent(SEEDED, {
        eventType: "MarketOpened",
        payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
      }),
  },
  {
    field: "openedAt",
    base: "MarketOpened refused UNIVERSE_LIFECYCLE_CONFLICT against an instant nobody recorded",
    value: "2020-01-01T00:00:00Z",
    run: () =>
      applyMarketLifecycleEvent(SEEDED, {
        eventType: "MarketOpened",
        payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
      }),
  },
  {
    field: "resolvedAt",
    base: "a SECOND resolution accepted as idempotent (clean refuses UNIVERSE_TERMINAL_OUTCOME_CONFLICT)",
    value: "2026-08-28T12:15:00Z",
    run: () =>
      applyMarketLifecycleEvent(
        { ...SEEDED, lifecycleState: "RESOLVED", outcomeState: "YES_WIN" },
        {
          eventType: "MarketResolved",
          payload: { ...REF, outcome: "YES_WIN", resolvedAt: "2026-08-28T12:15:00Z" },
        },
      ),
  },
  {
    field: "closesAt",
    base: "MarketClosing swallowed as idempotent",
    value: "2026-08-28T12:15:00Z",
    run: () =>
      applyMarketLifecycleEvent(
        { ...SEEDED, lifecycleState: "CLOSING" },
        { eventType: "MarketClosing", payload: { ...REF, closesAt: "2026-08-28T12:15:00Z" } },
      ),
  },
  {
    field: "lastEventOrder",
    base: "every fresh event dropped UNIVERSE_EVENT_REPLAYED",
    value: { gatewayEpoch: EPOCH, ingestSeq: "999" },
    run: () =>
      applyMarketLifecycleEvent(SEEDED, {
        eventType: "MarketOpened",
        payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
        order: { gatewayEpoch: EPOCH, ingestSeq: "7" },
      }),
  },
];

describe("the projection-side class (UNIV-1 r1 MED-1)", () => {
  it("folds identically with and without an inherited optional, in both variants", () => {
    for (const cell of PROJECTION_CELLS) {
      const clean = verdict(cell.run);
      for (const variant of VARIANTS) {
        const polluted = withInherited(cell.field, inherited(cell.value, variant.enumerable), () =>
          verdict(cell.run),
        );
        expect(polluted, `${cell.field} / ${variant.label} — BASE: ${cell.base}`).toBe(clean);
      }
    }
  });

  it("sweeps ALL FIVE optional fields, in both variants, on every arm", () => {
    // The census is the class: a sixth optional field added to `MarketProjection`
    // without a door would not be swept, so the field list is pinned below and
    // every one of them is polluted against every arm here.
    const arms: readonly (readonly [string, unknown])[] = [
      ["MarketDiscovered", { ...REF, yesTokenId: "1000000001", noTokenId: "1000000002", metadataVersion: 2 }],
      ["MarketMetadataChanged", { ...REF, metadataVersion: 2, changedFields: ["title"] }],
      ["MarketRulesChanged", { ...REF, rulesVersionId: "rv-2", changedFields: ["rules"] }],
      ["MarketOpened", { ...REF, openedAt: "2026-08-28T12:00:00Z" }],
      ["MarketClosing", { ...REF, closesAt: "2026-08-28T12:15:00Z" }],
      ["MarketResolved", { ...REF, outcome: "YES_WIN", resolvedAt: "2026-08-28T12:20:00Z" }],
      [
        "MarketClarificationObserved",
        { ...REF, clarificationId: "clarification-1", observedAt: "2026-08-28T12:05:00Z" },
      ],
      [
        "TradingParametersChanged",
        {
          ...REF,
          parametersVersion: 1,
          parameterVersionRef: `${SAMPLE_MARKET_ID}/v1`,
          changedParameters: ["tick_size"],
          tickSize: "0.01",
        },
      ],
    ];
    const values: Readonly<Record<string, unknown>> = {
      rulesVersionId: "rules-from-the-prototype",
      openedAt: "2099-01-01T00:00:00Z",
      closesAt: "2099-01-01T00:00:00Z",
      resolvedAt: "2099-01-01T00:00:00Z",
      lastEventOrder: { gatewayEpoch: EPOCH, ingestSeq: "999" },
    };
    // An ORDINARY-prototype projection, deliberately: a projection the registry
    // STORES is prototype-free (the D4 half of this round), so sweeping that one
    // would measure the emission rather than the READ. `{...projection}` is what
    // every caller holding a projection actually has, and it is the shape the
    // class was measured on.
    const carrier = { ...SEEDED } as MarketProjection;
    expect(Object.getPrototypeOf(carrier)).toBe(Object.prototype);
    let cells = 0;
    for (const [eventType, payload] of arms) {
      const run = (): unknown =>
        applyMarketLifecycleEvent(carrier, { eventType: eventType as never, payload });
      const clean = verdict(run);
      for (const field of OPTIONAL_PROJECTION_FIELDS) {
        for (const variant of VARIANTS) {
          const polluted = withInherited(
            field,
            inherited(values[field], variant.enumerable),
            () => verdict(run),
          );
          expect(polluted, `${eventType} / ${field} / ${variant.label}`).toBe(clean);
          cells += 1;
        }
      }
    }
    // 8 arms x 5 optional fields x 2 variants.
    expect(cells).toBe(80);
  });

  it("closes the §9.2 activation gate — the sharpest cell of the class", () => {
    // BASE, BOTH variants: an inherited `rulesVersionId` equal to the reviewed
    // spec's turned `modelDependentActivationAllowed: false` +
    // UNIVERSE_SETTLEMENT_RULES_VERSION_DRIFT into `true` with NO refusals.
    const projection: MarketProjection = {
      ...SEEDED,
      lifecycleState: "OPEN",
      openedAt: "2026-08-28T12:00:00Z",
      seriesBinding: {
        kind: "APPROVED",
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer-1",
        approvedAt: "2026-08-28T10:00:00Z",
      },
    };
    const series = {
      ...seriesDefinitionSample(),
      binding: { approved: true, approvedBy: "reviewer-1", approvedAt: "2026-08-28T10:00:00Z" },
    };
    const evaluate = (): string => {
      const readiness = evaluateMarketReadiness(projection, {
        asOf: "2026-08-28T12:05:00Z",
        settlement: permittingSettlementView(),
        series: series as never,
      });
      return `${String(readiness.modelDependentActivationAllowed)} ${readiness.refusals
        .map((refusal) => refusal.code)
        .join(",")}`;
    };
    const clean = evaluate();
    expect(clean).toBe("false UNIVERSE_SETTLEMENT_RULES_VERSION_DRIFT");
    for (const variant of VARIANTS) {
      const polluted = withInherited(
        "rulesVersionId",
        inherited(SAMPLE_RULES_VERSION_ID, variant.enumerable),
        evaluate,
      );
      expect(polluted, variant.label).toBe(clean);
    }
  });

  it("answers the two derived readers from own data only", () => {
    // BASE: `effectiveCloseInstant` returned an instant no event carried and
    // `effectiveLifecycleState` derived CLOSED from it, in both variants.
    const closesAtClean = effectiveCloseInstant(SEEDED);
    const stateClean = effectiveLifecycleState(SEEDED, "2026-08-28T12:00:00Z");
    for (const variant of VARIANTS) {
      const polluted = withInherited(
        "closesAt",
        inherited("2000-01-01T00:00:00Z", variant.enumerable),
        () => ({
          closesAt: effectiveCloseInstant(SEEDED),
          state: effectiveLifecycleState(SEEDED, "2026-08-28T12:00:00Z"),
        }),
      );
      expect(polluted.closesAt, variant.label).toBe(closesAtClean);
      expect(polluted.state, variant.label).toBe(stateClean);
    }
  });

  it("closes recordObservedOutcomeState's own reads", () => {
    const run = (): unknown =>
      recordObservedOutcomeState(SEEDED, {
        outcomeState: "DISPUTED",
        observedAt: "2026-08-28T12:06:00Z",
        observedBy: "operator-1",
      });
    const clean = verdict(run);
    for (const field of ["lifecycleState", "outcomeState"]) {
      for (const variant of VARIANTS) {
        const polluted = withInherited(field, inherited("RESOLVED", variant.enumerable), () =>
          verdict(run),
        );
        expect(polluted, `${field} / ${variant.label}`).toBe(clean);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The census: what the class covers
// ---------------------------------------------------------------------------

/**
 * `MarketProjection`'s five optional fields.
 *
 * INTERFACE-PINNED, because `MarketProjection` has no schema to derive from: the
 * list below is checked against a MAXIMAL projection the package itself builds,
 * so a field added to the interface and then populated by a fold shows up as a
 * key this list does not contain, and the census test fails.
 */
const OPTIONAL_PROJECTION_FIELDS: readonly string[] = Object.freeze([
  "rulesVersionId",
  "openedAt",
  "closesAt",
  "resolvedAt",
  "lastEventOrder",
]);

const REQUIRED_PROJECTION_FIELDS: readonly string[] = Object.freeze([
  "identity",
  "seriesBinding",
  "lifecycleState",
  "outcomeState",
  "metadataVersion",
  "clarifications",
  "parameters",
]);

describe("the projection census", () => {
  it("covers every field a maximal projection carries", () => {
    // Build one the long way, through the registry, so the key set is the
    // package's own rather than this file's opinion.
    let registry = REGISTRY;
    const folds: readonly (readonly [string, unknown, string])[] = [
      ["MarketRulesChanged", { ...REF, rulesVersionId: "rv-1", changedFields: ["rules"] }, "1"],
      ["MarketOpened", { ...REF, openedAt: "2026-08-28T12:00:00Z" }, "2"],
      ["MarketClosing", { ...REF, closesAt: "2026-08-28T12:15:00Z" }, "3"],
      [
        "MarketClarificationObserved",
        { ...REF, clarificationId: "clarification-1", observedAt: "2026-08-28T12:05:00Z" },
        "4",
      ],
      ["MarketResolved", { ...REF, outcome: "YES_WIN", resolvedAt: "2026-08-28T12:20:00Z" }, "5"],
    ];
    for (const [eventType, payload, ingestSeq] of folds) {
      const applied = applyMarketEvent(registry, SAMPLE_MARKET_ID, {
        eventType: eventType as never,
        payload,
        order: { gatewayEpoch: EPOCH, ingestSeq },
      });
      expect(applied.ok, eventType).toBe(true);
      if (applied.ok) {
        registry = applied.value.registry;
      }
    }
    const maximal = registry.markets.get(SAMPLE_MARKET_ID as never) as MarketProjection;
    expect([...Object.keys(maximal)].sort()).toEqual(
      [...REQUIRED_PROJECTION_FIELDS, ...OPTIONAL_PROJECTION_FIELDS].sort(),
    );
    expect(OPTIONAL_PROJECTION_FIELDS).toHaveLength(5);
  });

  it("emits and stores every projection prototype-free and frozen (D4)", () => {
    // The OUTPUT half of the row: a consumer asks the returned projection
    // `projection.rulesVersionId === undefined` — `./eligibility.ts` does — and
    // an ordinary object answers that from `Object.prototype`.
    const emitted: readonly (readonly [string, unknown])[] = [
      ["registerMarket", SEEDED],
      ["registry.markets.get", REGISTRY.markets.get(SAMPLE_MARKET_ID as never)],
      [
        "a CHANGED fold",
        (() => {
          const applied = applyMarketLifecycleEvent(SEEDED, {
            eventType: "MarketOpened",
            payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
          });
          return applied.ok ? applied.value.projection : undefined;
        })(),
      ],
      [
        "an UNCHANGED fold",
        (() => {
          const applied = applyMarketLifecycleEvent(
            { ...SEEDED },
            {
              eventType: "MarketDiscovered",
              payload: {
                ...REF,
                yesTokenId: "1000000001",
                noTokenId: "1000000002",
                metadataVersion: 1,
              },
            },
          );
          return applied.ok ? applied.value.projection : undefined;
        })(),
      ],
      [
        "recordObservedOutcomeState",
        (() => {
          const applied = recordObservedOutcomeState(
            { ...SEEDED },
            {
              outcomeState: "DISPUTED",
              observedAt: "2026-08-28T12:06:00Z",
              observedBy: "operator-1",
            },
          );
          return applied.ok ? applied.value.projection : undefined;
        })(),
      ],
      [
        "applyMarketEvent's stored projection",
        (() => {
          const applied = applyMarketEvent(REGISTRY, SAMPLE_MARKET_ID, {
            eventType: "MarketOpened",
            payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
          });
          return applied.ok ? applied.value.registry.markets.get(SAMPLE_MARKET_ID as never) : undefined;
        })(),
      ],
    ];
    for (const [label, projection] of emitted) {
      expect(projection, label).toBeDefined();
      expect(Object.getPrototypeOf(projection as object), label).toBeNull();
      expect(Object.isFrozen(projection as object), label).toBe(true);
      // And a key it does not carry reads `undefined` even under pollution.
      for (const variant of VARIANTS) {
        expect(
          withInherited("rulesVersionId", inherited("ghost", variant.enumerable), () =>
            (projection as MarketProjection).rulesVersionId,
          ),
          `${label} / ${variant.label}`,
        ).toBeUndefined();
      }
    }
  });

  it("reads a projection into a null-prototype, frozen record", () => {
    const read = openOwnProjection(SEEDED);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(Object.getPrototypeOf(read.value)).toBeNull();
    expect(Object.isFrozen(read.value)).toBe(true);
    expect(Object.keys(read.value)).toEqual(Object.keys(SEEDED));
  });

  it("preserves the spread's key ORDER when it writes the ordering field", () => {
    const read = openOwnProjection(SEEDED);
    /* c8 ignore next 3 -- the fixture is valid. */
    if (!read.ok) {
      return;
    }
    const appended = withOwnField(read.value, "lastEventOrder", { gatewayEpoch: EPOCH, ingestSeq: "1" });
    expect(Object.keys(appended)).toEqual([...Object.keys(SEEDED), "lastEventOrder"]);
    const replaced = withOwnField(appended, "lifecycleState", "OPEN");
    expect(Object.keys(replaced)).toEqual(Object.keys(appended));
    expect(replaced.lifecycleState).toBe("OPEN");
  });
});

// ---------------------------------------------------------------------------
// Containment and fail-closed shapes (UNIV-1 r1 LOW-2)
// ---------------------------------------------------------------------------

describe("the projection door is total and fails closed", () => {
  it("refuses an accessor on a projection field WITHOUT invoking it", () => {
    let invoked = 0;
    const projection = { ...SEEDED };
    Object.defineProperty(projection, "rulesVersionId", {
      get: () => {
        invoked += 1;
        return "rules-from-a-getter";
      },
      enumerable: true,
      configurable: true,
    });
    const outcome = verdict(() =>
      applyMarketLifecycleEvent(projection as MarketProjection, {
        eventType: "MarketOpened",
        payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
      }),
    );
    expect(outcome).toBe("REFUSED UNIVERSE_INPUT_INVALID");
    expect(invoked).toBe(0);
  });

  it("refuses a projection that is not a record, and one missing its collections", () => {
    const shapes: readonly (readonly [string, unknown])[] = [
      ["a string", "projection"],
      ["null", null],
      ["an array", []],
      ["no clarifications", { ...SEEDED, clarifications: undefined }],
      ["clarifications not a list", { ...SEEDED, clarifications: { length: 1 } }],
      ["no parameters", { ...SEEDED, parameters: undefined }],
      ["no identity", { ...SEEDED, identity: undefined }],
      ["lastEventOrder not a record", { ...SEEDED, lastEventOrder: "1" }],
      ["lastEventOrder without ingestSeq", { ...SEEDED, lastEventOrder: { gatewayEpoch: EPOCH } }],
    ];
    for (const [label, projection] of shapes) {
      // TOTAL: a typed refusal, never a throw out of a function that returns a
      // typed result. At base several of these threw a bare `TypeError`.
      expect(
        verdict(() =>
          applyMarketLifecycleEvent(projection as MarketProjection, {
            eventType: "MarketOpened",
            payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
          }),
        ),
        label,
      ).toBe("REFUSED UNIVERSE_INPUT_INVALID");
    }
  });

  it("treats a non-enumerable own optional as absent, exactly as the spread already did", () => {
    // The disclosed drift of the own-ENUMERABLE rule: base READ such a field but
    // never PROPAGATED it, so the two now agree. Fail-closed and pinned.
    const projection = { ...SEEDED };
    Object.defineProperty(projection, "openedAt", {
      value: "2020-01-01T00:00:00Z",
      enumerable: false,
      writable: false,
      configurable: false,
    });
    const outcome = applyMarketLifecycleEvent(projection as MarketProjection, {
      eventType: "MarketOpened",
      payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.projection.openedAt).toBe("2026-08-28T12:00:00Z");
    }
  });

  it("reads an own `undefined` optional as absent", () => {
    const projection = { ...SEEDED, rulesVersionId: undefined } as unknown as MarketProjection;
    const read = openOwnProjection(projection);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(Object.hasOwn(read.value, "rulesVersionId")).toBe(false);
    }
  });

  it("answers ownProjectionField totally, for every non-record and accessor", () => {
    expect(ownProjectionField(undefined, "closesAt")).toBeUndefined();
    expect(ownProjectionField("x", "closesAt")).toBeUndefined();
    expect(ownProjectionField([], "closesAt")).toBeUndefined();
    const accessor = {};
    Object.defineProperty(accessor, "closesAt", { get: () => "x", enumerable: true });
    expect(ownProjectionField(accessor, "closesAt")).toBeUndefined();
    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "closesAt", { value: "x", enumerable: false });
    expect(ownProjectionField(nonEnumerable, "closesAt")).toBeUndefined();
    expect(ownProjectionField({ closesAt: "x" }, "closesAt")).toBe("x");
  });
});

describe("the exotic-shape drifts are pinned (UNIV-1 r1 LOW-2)", () => {
  /**
   * Shapes `zod` alone judged on their DECLARED keys and the doors refuse as
   * shapes. `UNIV-1` disclosed three such drifts and pinned only one; all of
   * them are pinned here, in one place, so a later change to the materializer's
   * refusal set is visible instead of silent. Every row is a REFUSAL, never a
   * throw: the fold returns a typed result.
   */
  function honestOpened(): Record<string, unknown> {
    return { ...REF, openedAt: "2026-08-28T12:00:00Z" };
  }

  const SHAPES: readonly (readonly [string, () => unknown])[] = [
    [
      "an accessor on a declared key",
      () => {
        const payload = honestOpened();
        Object.defineProperty(payload, "openedAt", {
          get: () => "2026-08-28T12:00:00Z",
          enumerable: true,
        });
        return payload;
      },
    ],
    ["a symbol-keyed property", () => ({ ...honestOpened(), [Symbol("k")]: 1 })],
    ["an own __proto__", () => JSON.parse('{"__proto__":{"openedAt":"2026-08-28T12:00:00Z"}}')],
    [
      "a class-instance prototype",
      () => {
        class Payload {}
        return Object.assign(new Payload(), honestOpened());
      },
    ],
    [
      "a null-prototype nested member",
      () => ({ ...honestOpened(), extra: Object.assign(Object.create(null), { a: 1 }) }),
    ],
    ["a function member", () => ({ ...honestOpened(), extra: () => undefined })],
    ["a bigint member", () => ({ ...honestOpened(), extra: 1n })],
    [
      "an array with a foreign prototype",
      () => {
        const list = ["rules"];
        Object.setPrototypeOf(list, { push: () => undefined });
        return { ...REF, rulesVersionId: "rv-1", changedFields: list };
      },
    ],
    [
      "a sparse array",
      () => {
        const list: (string | undefined)[] = ["rules"];
        list.length = 3;
        return { ...REF, rulesVersionId: "rv-1", changedFields: list };
      },
    ],
    [
      "a tree deeper than the bound",
      () => {
        let nested: Record<string, unknown> = { leaf: 1 };
        for (let depth = 0; depth < 12; depth += 1) {
          nested = { nested };
        }
        return { ...honestOpened(), extra: nested };
      },
    ],
  ];

  it("refuses every one of them, as a typed refusal and never a throw", () => {
    for (const [label, build] of SHAPES) {
      const eventType = label.includes("array") ? "MarketRulesChanged" : "MarketOpened";
      expect(
        verdict(() =>
          applyMarketEvent(REGISTRY, SAMPLE_MARKET_ID, {
            eventType: eventType as never,
            payload: build(),
          }),
        ),
        label,
      ).toBe("REFUSED UNIVERSE_INPUT_INVALID");
    }
  });

  it("still accepts the same payloads as plain data", () => {
    expect(
      applyMarketEvent(REGISTRY, SAMPLE_MARKET_ID, {
        eventType: "MarketOpened",
        payload: honestOpened(),
      }).ok,
    ).toBe(true);
    expect(
      applyMarketEvent(REGISTRY, SAMPLE_MARKET_ID, {
        eventType: "MarketRulesChanged",
        payload: { ...REF, rulesVersionId: "rv-1", changedFields: ["rules"] },
      }).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The §7.1 order re-statement (UNIV-2 r1 LOW — the ingestSeq gap)
// ---------------------------------------------------------------------------

describe("the event order is re-stated, not merely read", () => {
  const BASE_VERDICTS: readonly (readonly [string, unknown, string])[] = [
    ["missing ingestSeq", { gatewayEpoch: EPOCH }, "THREW TypeError: Cannot convert undefined to a BigInt"],
    ["fractional ingestSeq", { gatewayEpoch: EPOCH, ingestSeq: 5.5 }, "THREW RangeError"],
    ["leading-zero ingestSeq", { gatewayEpoch: EPOCH, ingestSeq: "007" }, "ACCEPTED"],
    ["hex ingestSeq", { gatewayEpoch: EPOCH, ingestSeq: "0x10" }, "ACCEPTED, ordered as 16"],
    ["missing gatewayEpoch", { ingestSeq: "9" }, "ACCEPTED, the replay guard skipped entirely"],
    ["numeric ingestSeq", { gatewayEpoch: EPOCH, ingestSeq: 9 }, "THREW/ordered as 9"],
    ["empty gatewayEpoch", { gatewayEpoch: "", ingestSeq: "9" }, "ACCEPTED"],
    ["order not a record", "1", "ACCEPTED (order read as a string)"],
  ];

  it("refuses every shape that threw or mis-ordered at base, through applyMarketEvent", () => {
    const opened = applyMarketEvent(REGISTRY, SAMPLE_MARKET_ID, {
      eventType: "MarketOpened",
      payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
      order: { gatewayEpoch: EPOCH, ingestSeq: "1" },
    });
    expect(opened.ok).toBe(true);
    /* c8 ignore next 3 -- the fixture is valid. */
    if (!opened.ok) {
      return;
    }
    for (const [label, order, base] of BASE_VERDICTS) {
      expect(
        verdict(() =>
          applyMarketEvent(opened.value.registry, SAMPLE_MARKET_ID, {
            eventType: "MarketClosing",
            payload: { ...REF, closesAt: "2026-08-28T12:15:00Z" },
            order: order as never,
          }),
        ),
        `${label} — BASE: ${base}`,
      ).toBe("REFUSED UNIVERSE_INPUT_INVALID");
    }
  });

  it("refuses the same shapes on the direct fold as well", () => {
    for (const [label, order, base] of BASE_VERDICTS) {
      expect(
        verdict(() =>
          applyMarketLifecycleEvent(SEEDED, {
            eventType: "MarketOpened",
            payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
            order: order as never,
          }),
        ),
        `${label} — BASE: ${base}`,
      ).toBe("REFUSED UNIVERSE_INPUT_INVALID");
    }
  });

  it("accepts the canonical form and stores it prototype-free and frozen (D4)", () => {
    const read = openEventOrder({ gatewayEpoch: EPOCH, ingestSeq: "0" });
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(Object.getPrototypeOf(read.value)).toBeNull();
    expect(Object.isFrozen(read.value)).toBe(true);
    expect({ ...read.value }).toEqual({ gatewayEpoch: EPOCH, ingestSeq: "0" });

    const applied = applyMarketLifecycleEvent(SEEDED, {
      eventType: "MarketOpened",
      payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
      order: { gatewayEpoch: EPOCH, ingestSeq: "12" },
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      const stored = applied.value.projection.lastEventOrder as object;
      expect(Object.getPrototypeOf(stored)).toBeNull();
      expect(Object.isFrozen(stored)).toBe(true);
    }
  });

  it("declares exactly the two §7.1 ordering keys the envelope door declares", () => {
    expect(EVENT_ORDER_FIELDS.map((field) => field.key)).toEqual(["gatewayEpoch", "ingestSeq"]);
    expect(EVENT_ORDER_FIELDS.every((field) => field.required)).toBe(true);
    const ingestSeq = EVENT_ORDER_FIELDS.find((field) => field.key === "ingestSeq");
    expect(ingestSeq?.shape.kind).toBe("unsignedIntegerString");
  });

  it("still orders honestly: a higher ingestSeq advances, an equal one is replayed", () => {
    const first = applyMarketEvent(REGISTRY, SAMPLE_MARKET_ID, {
      eventType: "MarketOpened",
      payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
      order: { gatewayEpoch: EPOCH, ingestSeq: "10" },
    });
    expect(first.ok).toBe(true);
    /* c8 ignore next 3 -- the fixture is valid. */
    if (!first.ok) {
      return;
    }
    const replayed = applyMarketEvent(first.value.registry, SAMPLE_MARKET_ID, {
      eventType: "MarketClosing",
      payload: { ...REF, closesAt: "2026-08-28T12:15:00Z" },
      order: { gatewayEpoch: EPOCH, ingestSeq: "10" },
    });
    expect(verdict(() => replayed)).toBe("REFUSED UNIVERSE_EVENT_REPLAYED");
    const advanced = applyMarketEvent(first.value.registry, SAMPLE_MARKET_ID, {
      eventType: "MarketClosing",
      payload: { ...REF, closesAt: "2026-08-28T12:15:00Z" },
      order: { gatewayEpoch: EPOCH, ingestSeq: "11" },
    });
    expect(advanced.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two re-stated formats (UNIV-1 r1 MED-2 and NOTE-2)
// ---------------------------------------------------------------------------

describe("the instant format reaches no transition under an inherited skipChecks", () => {
  const INSTANTS: readonly string[] = [
    "Aug 28 2026",
    "2026-08-28T12:15:30",
    "2026-08-28",
    "2026-02-30T00:00:00Z",
    "yesterday",
  ];

  it("refuses every one of them, clean and under skipChecks, in both variants", () => {
    for (const resolvedAt of INSTANTS) {
      const run = (): unknown =>
        applyMarketLifecycleEvent(SEEDED, {
          eventType: "MarketResolved",
          payload: { ...REF, outcome: "YES_WIN", resolvedAt },
        });
      expect(verdict(run), `${resolvedAt} clean`).toBe("REFUSED UNIVERSE_INPUT_INVALID");
      for (const variant of VARIANTS) {
        // BASE: every one of these RESOLVED the market and wrote the string
        // into `projection.resolvedAt`.
        expect(
          withInherited("skipChecks", inherited(true, variant.enumerable), () => verdict(run)),
          `${resolvedAt} / ${variant.label}`,
        ).toBe("REFUSED UNIVERSE_INPUT_INVALID");
      }
    }
  });

  it("still accepts every instant the frozen schema accepts", () => {
    for (const resolvedAt of [
      "2026-08-28T12:20:00Z",
      "2026-08-28T12:20:00.123Z",
      "2026-08-28T12:20:00+01:00",
      "2026-08-28T12:20:00-05:00",
      "2024-02-29T00:00:00Z",
    ]) {
      const outcome = applyMarketLifecycleEvent(SEEDED, {
        eventType: "MarketResolved",
        payload: { ...REF, outcome: "YES_WIN", resolvedAt },
      });
      expect(outcome.ok, resolvedAt).toBe(true);
    }
  });

  it("lets no InvalidDecimalStringError escape the fold (NOTE-2)", () => {
    const run = (): unknown =>
      applyMarketLifecycleEvent(SEEDED, {
        eventType: "TradingParametersChanged",
        payload: {
          ...REF,
          parametersVersion: 1,
          parameterVersionRef: `${SAMPLE_MARKET_ID}/v1`,
          changedParameters: ["tick_size"],
          tickSize: "1.50",
        },
      });
    expect(verdict(run)).toBe("REFUSED UNIVERSE_INPUT_INVALID");
    for (const variant of VARIANTS) {
      // BASE: `THREW InvalidDecimalStringError: compareDecimal(a): "1.50" …`
      // straight out of a function that returns a typed result.
      expect(
        withInherited("skipChecks", inherited(true, variant.enumerable), () => verdict(run)),
        variant.label,
      ).toBe("REFUSED UNIVERSE_INPUT_INVALID");
    }
  });

  it("re-states exactly the instant and decimal keys of every arm, from the door's own census", () => {
    // Vacuity guard: if the census stopped naming the instant keys, this would
    // find nothing to refuse.
    const cells: readonly (readonly [string, Record<string, unknown>, string])[] = [
      ["MarketOpened", { openedAt: "yesterday" }, "openedAt"],
      ["MarketClosing", { closesAt: "yesterday" }, "closesAt"],
      ["MarketResolved", { resolvedAt: "yesterday" }, "resolvedAt"],
      ["MarketClarificationObserved", { observedAt: "yesterday" }, "observedAt"],
      ["TradingParametersChanged", { tickSize: "1.50" }, "tickSize"],
      ["TradingParametersChanged", { minimumOrderSize: "-1" }, "minimumOrderSize"],
    ];
    for (const [eventType, payload, key] of cells) {
      const issues = restateDeclaredFormats(eventType as never, payload);
      expect(issues.length, `${eventType}.${key}`).toBe(1);
      expect(issues[0], `${eventType}.${key}`).toContain(key);
    }
    // And nothing is invented for an honest payload.
    expect(
      restateDeclaredFormats("MarketResolved", {
        ...REF,
        outcome: "YES_WIN",
        resolvedAt: "2026-08-28T12:20:00Z",
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The two bounded tightenings (UNIV-2 r1, unjudged review facts)
// ---------------------------------------------------------------------------

describe("the two approval paths agree", () => {
  function approvedRegistry(): ReturnType<typeof createUniverseRegistry> {
    const withSeries = registerSeries(createUniverseRegistry(), seriesDefinitionSample());
    /* c8 ignore next 3 -- the sample always registers. */
    if (!withSeries.ok) {
      throw new Error("fixture failed");
    }
    const approved = approveSeries(withSeries.value, {
      seriesId: SAMPLE_SERIES_ID,
      approvedBy: "reviewer-1",
      approvedAt: "2026-08-28T10:00:00Z",
    });
    /* c8 ignore next 3 -- the sample always approves. */
    if (!approved.ok) {
      throw new Error("fixture failed");
    }
    const registered = registerMarket(approved.value, {
      identity: marketIdentitySample(),
      parameters: parameterObservationSample(),
    });
    /* c8 ignore next 3 -- the sample always registers. */
    if (!registered.ok) {
      throw new Error("fixture failed");
    }
    return registered.value.registry;
  }

  const APPROVED_REGISTRY = approvedRegistry();

  const REVIEW_FACTS: readonly (readonly [string, unknown, unknown, boolean])[] = [
    ["an honest review", "reviewer-2", "2026-08-28T10:30:00Z", true],
    ["a numeric approver", 123, "2026-08-28T10:30:00Z", false],
    ["an object approver", { a: 1 }, "2026-08-28T10:30:00Z", false],
    ["an empty approver", "", "2026-08-28T10:30:00Z", false],
    ["a missing approver", undefined, "2026-08-28T10:30:00Z", false],
    ["a non-instant approvedAt", "reviewer-2", "yesterday", false],
    ["a numeric approvedAt", "reviewer-2", 0, false],
    ["a missing approvedAt", "reviewer-2", undefined, false],
  ];

  it("accepts and refuses the same review facts in bindMarketToSeries as in approveSeries", () => {
    for (const [label, approvedBy, approvedAt, accepted] of REVIEW_FACTS) {
      const bound = bindMarketToSeries(APPROVED_REGISTRY, {
        internalMarketId: SAMPLE_MARKET_ID,
        seriesId: SAMPLE_SERIES_ID,
        ...(approvedBy === undefined ? {} : { approvedBy }),
        ...(approvedAt === undefined ? {} : { approvedAt }),
      } as never);
      const approved = approveSeries(APPROVED_REGISTRY, {
        seriesId: SAMPLE_SERIES_ID,
        ...(approvedBy === undefined ? {} : { approvedBy }),
        ...(approvedAt === undefined ? {} : { approvedAt }),
      } as never);
      expect(bound.ok, `bind: ${label}`).toBe(accepted);
      expect(approved.ok, `approve: ${label}`).toBe(accepted);
      // THE POINT: the two paths agree, cell for cell.
      expect(bound.ok, `agreement: ${label}`).toBe(approved.ok);
    }
  });

  it("stores the approver a valid bind carried, and nothing else", () => {
    const bound = bindMarketToSeries(APPROVED_REGISTRY, {
      internalMarketId: SAMPLE_MARKET_ID,
      seriesId: SAMPLE_SERIES_ID,
      approvedBy: "reviewer-2",
      approvedAt: "2026-08-28T10:30:00Z",
    });
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      const binding = bound.value.markets.get(SAMPLE_MARKET_ID as never)?.seriesBinding;
      expect(binding).toEqual({
        kind: "APPROVED",
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer-2",
        approvedAt: "2026-08-28T10:30:00Z",
      });
    }
  });
});

describe("metadataVersion is judged by the payload that will carry it", () => {
  const CELLS: readonly (readonly [unknown, boolean])[] = [
    [undefined, true],
    [1, true],
    [3, true],
    [Number.MAX_SAFE_INTEGER, true],
    [0, false],
    [-1, false],
    [1.5, false],
    ["3", false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [null, false],
    [{}, false],
    [true, false],
  ];

  it("refuses exactly what MarketDiscoveredPayloadSchema's own field refuses", () => {
    const field = (
      MarketDiscoveredPayloadSchema as unknown as {
        shape: Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
      }
    ).shape["metadataVersion"];
    expect(field).toBeDefined();
    for (const [value, accepted] of CELLS) {
      expect(openMetadataVersion(value).ok, JSON.stringify(value) ?? "undefined").toBe(accepted);
      if (value !== undefined) {
        // The door's verdict IS the payload schema's verdict, cell for cell.
        expect(field?.safeParse(value).success, JSON.stringify(value)).toBe(accepted);
      }
    }
  });

  it("refuses the registration rather than emitting a payload the contract rejects", () => {
    for (const [value, accepted] of CELLS) {
      const registered = registerMarket(createUniverseRegistry(), {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
        ...(value === undefined ? {} : { metadataVersion: value as number }),
      });
      expect(registered.ok, JSON.stringify(value) ?? "undefined").toBe(accepted);
      if (registered.ok) {
        // And what it DID emit is a payload the frozen schema accepts.
        expect(MarketDiscoveredPayloadSchema.safeParse({ ...registered.value.event }).success).toBe(
          true,
        );
      }
    }
  });

  it("defaults an absent metadataVersion to 1, exactly as base did", () => {
    const registered = registerMarket(createUniverseRegistry(), {
      identity: marketIdentitySample(),
      parameters: parameterObservationSample(),
    });
    expect(registered.ok).toBe(true);
    if (registered.ok) {
      expect(registered.value.projection.metadataVersion).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// LOW-3: the emitted lists
// ---------------------------------------------------------------------------

describe("every list this package hands back is frozen (UNIV-1 r1 LOW-3)", () => {
  it("freezes clarificationsAfterOpen, the one list whose length was writable at base", () => {
    const opened = applyMarketLifecycleEvent(SEEDED, {
      eventType: "MarketOpened",
      payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
    });
    /* c8 ignore next 3 -- the fold succeeds. */
    if (!opened.ok) {
      throw new Error("fixture failed");
    }
    const clarified = applyMarketLifecycleEvent(opened.value.projection, {
      eventType: "MarketClarificationObserved",
      payload: { ...REF, clarificationId: "clarification-1", observedAt: "2026-08-28T12:05:00Z" },
    });
    expect(clarified.ok).toBe(true);
    /* c8 ignore next 3 -- the fold succeeds. */
    if (!clarified.ok) {
      return;
    }
    const projection = clarified.value.projection;
    const lists: readonly (readonly [string, readonly unknown[]])[] = [
      ["projection.clarifications", projection.clarifications],
      ["clarificationsAfterOpen()", clarificationsAfterOpen(projection)],
      ["parameters.versions", projection.parameters.versions],
      ["version.changedParameters", projection.parameters.versions[0]?.changedParameters ?? []],
    ];
    for (const [label, list] of lists) {
      expect(Object.isFrozen(list), label).toBe(true);
      expect(() => {
        (list as unknown[]).length = 0;
      }, label).toThrow(TypeError);
    }
    // And it is still the right list.
    expect(clarificationsAfterOpen(projection)).toHaveLength(1);
    expect(clarificationsAfterOpen({ ...projection, clarifications: [] })).toHaveLength(0);
  });
});
