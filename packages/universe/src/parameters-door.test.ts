/**
 * `./parameters-door.ts` — the parameter-observation door.
 *
 * Two rows, both measured at base `c2c0733` in BOTH pollution variants before a
 * line was written: `UNIV-2` r1 MED-1 (the OUTPUT-side adoption that corrupted
 * `changedParameters`, the emitted §7.4 payload, and the
 * `UNIVERSE_PARAMETERS_UNCHANGED` gate) and `UNIV-2` r1 MED-2 (the `skipChecks`
 * defeat that put `tickSize:"-9"` into an immutable recorded version). The base
 * verdict is quoted in the test that closes it.
 */

import { afterEach, describe, expect, it } from "vitest";

import { UniverseValidationError } from "./errors.js";
import { effectiveCloseInstant } from "./lifecycle.js";
import {
  PARAMETER_OBSERVATION_FIELDS,
  PARAMETER_SNAPSHOT_FIELDS,
  ownSnapshotField,
  restateObservation,
} from "./parameters-door.js";
import {
  MarketParametersSchema,
  ParameterObservationSchema,
  appendParameterVersion,
  changedParameterKinds,
  createParameterHistory,
  type MarketParameters,
  type ParameterObservation,
} from "./parameters.js";
import { createUniverseRegistry, recordMarketParameters, registerMarket } from "./registry.js";
import { SAMPLE_MARKET_ID, marketIdentitySample, parameterObservationSample } from "./testing/index.js";

const CONDITION_ID = marketIdentitySample().conditionId;

const VARIANTS: readonly { readonly label: string; readonly enumerable: boolean }[] = [
  { label: "non-enumerable", enumerable: false },
  { label: "enumerable", enumerable: true },
];

const POLLUTED: string[] = [];

function withInherited<T>(key: string, value: unknown, enumerable: boolean, run: () => T): T {
  POLLUTED.push(key);
  Object.defineProperty(Object.prototype, key, {
    value,
    enumerable,
    writable: true,
    configurable: true,
  });
  try {
    return run();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
    POLLUTED.pop();
  }
}

afterEach(() => {
  for (const key of POLLUTED.splice(0)) {
    Reflect.deleteProperty(Object.prototype, key);
  }
  for (const key of ["openTime", "closeTime", "feeScheduleRef", "skipChecks"]) {
    Reflect.deleteProperty(Object.prototype, key);
  }
});

/** A snapshot with NO optional member, so the three optional cells are live. */
const LEAN = {
  tickSize: "0.01",
  minimumOrderSize: "5",
  negRisk: false,
  tradingDelaySeconds: 0,
  status: "DISCOVERED",
} as unknown as MarketParameters;

function observation(parameters: unknown, observedAt: string): ParameterObservation {
  return { parameters, observedAt, source: "polymarket" } as unknown as ParameterObservation;
}

function outcome(run: () => unknown): string {
  try {
    const result = run() as { ok?: boolean; refusals?: readonly { code: string }[] };
    if (typeof result === "object" && result !== null && "ok" in result) {
      return result.ok === true
        ? `OK ${JSON.stringify(result)}`
        : `REFUSED ${(result.refusals ?? []).map((refusal) => refusal.code).join(",")}`;
    }
    return `VALUE ${JSON.stringify(result)}`;
  } catch (error: unknown) {
    return `THREW ${(error as Error).name}: ${(error as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// The census, derived from the frozen schemas
// ---------------------------------------------------------------------------

describe("the door's declared tables are derived from the frozen schemas", () => {
  function shapeOf(schema: unknown): Record<string, { safeParse: (v: unknown) => { success: boolean } }> {
    return (
      schema as { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> }
    ).shape;
  }

  it("MarketParametersSchema: the same keys, the same required split, the same ORDER", () => {
    const shape = shapeOf(MarketParametersSchema);
    // ORDER matters twice: it is the order `zod` emits (so the recorded JSON
    // does not move when the door rebuilds the snapshot) and it is the order the
    // door reads.
    expect(PARAMETER_SNAPSHOT_FIELDS.map((field) => field.key)).toEqual(Object.keys(shape));
    for (const field of PARAMETER_SNAPSHOT_FIELDS) {
      const optional = shape[field.key]?.safeParse(undefined).success === true;
      expect(field.required, field.key).toBe(!optional);
    }
    expect(PARAMETER_SNAPSHOT_FIELDS.filter((field) => !field.required)).toHaveLength(3);
  });

  it("ParameterObservationSchema: the same keys, the same required split, the same order", () => {
    const shape = shapeOf(ParameterObservationSchema);
    expect(PARAMETER_OBSERVATION_FIELDS.map((field) => field.key)).toEqual(Object.keys(shape));
    for (const field of PARAMETER_OBSERVATION_FIELDS) {
      expect(field.required, field.key).toBe(shape[field.key]?.safeParse(undefined).success !== true);
    }
  });
});

// ---------------------------------------------------------------------------
// UNIV-2 r1 MED-1 — the output side
// ---------------------------------------------------------------------------

describe("the parameter comparison reads own data (UNIV-2 r1 MED-1)", () => {
  it("establishes only the categories version 1 actually carries", () => {
    // BASE (non-enumerable): changedParameters gained fee_schedule, open_time
    // and close_time — three categories nobody observed, in an IMMUTABLE
    // recorded version.
    const run = (): unknown =>
      createParameterHistory(SAMPLE_MARKET_ID as never, observation(LEAN, "2026-08-28T11:00:00Z"))
        .versions[0]?.changedParameters;
    const clean = outcome(run);
    expect(clean).toBe('VALUE ["tick_size","minimum_order_size","trading_delay","neg_risk","status"]');
    for (const variant of VARIANTS) {
      const polluted = withInherited("openTime", "2026-08-28T12:00:00Z", variant.enumerable, () =>
        withInherited("closeTime", "2026-08-28T12:15:00Z", variant.enumerable, () =>
          withInherited("feeScheduleRef", "ghost-fees", variant.enumerable, () => outcome(run)),
        ),
      );
      if (variant.enumerable) {
        // `strictObject` sees an inherited ENUMERABLE key as an unrecognized one
        // and refuses first — base-identical, and still a refusal.
        expect(polluted, variant.label).toContain("THREW UniverseValidationError");
      } else {
        expect(polluted, variant.label).toBe(clean);
      }
    }
  });

  it("does not answer a REAL change 'nothing changed' from the prototype", () => {
    // BASE (non-enumerable): REFUSED UNIVERSE_PARAMETERS_UNCHANGED where clean
    // records version 2 with [open_time].
    const withOpen = { ...LEAN, openTime: "2026-08-28T12:00:00Z" } as MarketParameters;
    const history = createParameterHistory(
      SAMPLE_MARKET_ID as never,
      observation(withOpen, "2026-08-28T11:00:00Z"),
    );
    const run = (): unknown =>
      appendParameterVersion(
        history,
        observation(LEAN, "2026-08-28T11:30:00Z"),
        CONDITION_ID as never,
      );
    const clean = run() as { ok: boolean };
    expect(clean.ok).toBe(true);
    const polluted = withInherited("openTime", "2026-08-28T12:00:00Z", false, run) as {
      ok: boolean;
    };
    expect(polluted.ok).toBe(true);
  });

  it("emits a §7.4 payload that keeps every category that really changed", () => {
    // BASE (non-enumerable): the emitted changedParameters was ["tick_size"] —
    // close_time, which really changed, was dropped from the published event.
    const withClose = { ...LEAN, closeTime: "2026-08-28T12:15:00Z" } as MarketParameters;
    const history = createParameterHistory(
      SAMPLE_MARKET_ID as never,
      observation(withClose, "2026-08-28T11:00:00Z"),
    );
    const next = { ...LEAN, tickSize: "0.02" } as MarketParameters;
    const run = (): unknown => {
      const appended = appendParameterVersion(
        history,
        observation(next, "2026-08-28T11:30:00Z"),
        CONDITION_ID as never,
      );
      return appended.ok ? appended.value.event.changedParameters : appended;
    };
    const clean = outcome(run);
    expect(clean).toBe('VALUE ["tick_size","close_time"]');
    expect(outcome(() => withInherited("closeTime", "2026-08-28T12:15:00Z", false, run))).toBe(
      clean,
    );
  });

  it("answers effectiveCloseInstant from the stored snapshot's own data, both variants", () => {
    // BASE, BOTH variants: `2000-01-01T00:00:00Z` — a scheduled close no
    // observation carried, read off the prototype of the RECORDED snapshot.
    const registered = registerMarket(createUniverseRegistry(), {
      identity: marketIdentitySample(),
      parameters: observation(LEAN, "2026-08-28T11:00:00Z"),
    });
    expect(registered.ok).toBe(true);
    /* c8 ignore next 3 -- the fixture registers. */
    if (!registered.ok) {
      return;
    }
    const projection = registered.value.projection;
    expect(effectiveCloseInstant(projection)).toBeUndefined();
    for (const variant of VARIANTS) {
      expect(
        withInherited("closeTime", "2000-01-01T00:00:00Z", variant.enumerable, () =>
          effectiveCloseInstant(projection),
        ),
        variant.label,
      ).toBeUndefined();
    }
  });

  it("compares two CALLER-supplied snapshots on own data too", () => {
    // `changedParameterKinds` is EXPORTED and takes two snapshots this package
    // did not build, so they are ordinary objects with a live prototype chain.
    // The cell has to be ASYMMETRIC to bite: `previous` carries an own
    // `closeTime`, `next` does not, and the inherited value equals the previous
    // one — so a bracket read answers "nothing changed" about a schedule that
    // really was withdrawn.
    const previous = { ...LEAN, closeTime: "2026-08-28T12:15:00Z" } as MarketParameters;
    const next = { ...LEAN } as MarketParameters;
    const clean = changedParameterKinds(previous, next);
    expect([...clean]).toEqual(["close_time"]);
    for (const variant of VARIANTS) {
      expect(
        [
          ...withInherited("closeTime", "2026-08-28T12:15:00Z", variant.enumerable, () =>
            changedParameterKinds(previous, next),
          ),
        ],
        variant.label,
      ).toEqual(["close_time"]);
    }
    // And the reverse direction: a schedule that really was ADDED.
    expect([...changedParameterKinds(next, previous)]).toEqual(["close_time"]);
    for (const variant of VARIANTS) {
      expect(
        [
          ...withInherited("closeTime", "2026-08-28T12:15:00Z", variant.enumerable, () =>
            changedParameterKinds(next, previous),
          ),
        ],
        variant.label,
      ).toEqual(["close_time"]);
    }
  });

  it("establishes only the categories a CALLER-supplied first version carries", () => {
    // The same asymmetry on `establishedParameterKinds`, through the exported
    // history constructor with a prototype-bearing snapshot.
    const run = (): readonly string[] => [
      ...(createParameterHistory(SAMPLE_MARKET_ID as never, {
        parameters: { ...LEAN },
        observedAt: "2026-08-28T11:00:00Z",
        source: "polymarket",
      } as ParameterObservation).versions[0]?.changedParameters ?? []),
    ];
    const clean = run();
    expect(clean).toEqual(["tick_size", "minimum_order_size", "trading_delay", "neg_risk", "status"]);
    expect(withInherited("closeTime", "2026-08-28T12:15:00Z", false, run)).toEqual(clean);
  });

  it("reads an accessor member as absent without invoking it", () => {
    let invoked = 0;
    const snapshot = { ...LEAN } as Record<string, unknown>;
    Object.defineProperty(snapshot, "closeTime", {
      get: () => {
        invoked += 1;
        return "2026-08-28T12:15:00Z";
      },
      enumerable: true,
      configurable: true,
    });
    expect(ownSnapshotField(snapshot, "closeTime")).toBeUndefined();
    expect(invoked).toBe(0);
    expect(ownSnapshotField(undefined, "closeTime")).toBeUndefined();
    expect(ownSnapshotField("x", "closeTime")).toBeUndefined();
    expect(ownSnapshotField({ closeTime: undefined }, "closeTime")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UNIV-2 r1 MED-2 — the skipChecks defeat
// ---------------------------------------------------------------------------

describe("the observation re-statement survives an inherited skipChecks", () => {
  const DEFEATS: readonly (readonly [string, unknown, string])[] = [
    ["tickSize -9", { ...LEAN, tickSize: "-9" }, "RECORDED at base — an ECONOMIC parameter"],
    ["tickSize 1.50", { ...LEAN, tickSize: "1.50" }, "reached equalsDecimal and threw at base"],
    ["minimumOrderSize 0", { ...LEAN, minimumOrderSize: "0" }, "RECORDED at base"],
    ["tradingDelaySeconds -5", { ...LEAN, tradingDelaySeconds: -5 }, "RECORDED at base"],
    ["openTime yesterday", { ...LEAN, openTime: "yesterday" }, "RECORDED at base"],
    ["negRisk 'yes'", { ...LEAN, negRisk: "yes" }, "refused at base (a base-parse check)"],
    ["status NOPE", { ...LEAN, status: "NOPE" }, "refused at base (a base-parse check)"],
    ["unrecognized key", { ...LEAN, ghost: true }, "refused at base (strictObject)"],
    ["tickSize 1e3", { ...LEAN, tickSize: "1e3" }, "non-canonical"],
    ["feeScheduleRef ''", { ...LEAN, feeScheduleRef: "" }, "empty bounded string"],
    ["feeScheduleRef long", { ...LEAN, feeScheduleRef: "x".repeat(201) }, "over the bound"],
    ["closeTime before openTime", { ...LEAN, openTime: "2026-08-28T12:15:00Z", closeTime: "2026-08-28T12:00:00Z" }, "the superRefine, skipped wholesale under skipChecks"],
    ["missing tickSize", { minimumOrderSize: "5", negRisk: false, tradingDelaySeconds: 0, status: "DISCOVERED" }, "a required member"],
  ];

  it("refuses every defeat, in both variants, with the SAME throw contract", () => {
    const registered = registerMarket(createUniverseRegistry(), {
      identity: marketIdentitySample(),
      parameters: parameterObservationSample(),
    });
    /* c8 ignore next 3 -- the fixture registers. */
    if (!registered.ok) {
      throw new Error("fixture failed");
    }
    const registry = registered.value.registry;
    for (const [label, parameters, base] of DEFEATS) {
      const run = (): unknown =>
        recordMarketParameters(
          registry,
          SAMPLE_MARKET_ID,
          observation(parameters, "2026-08-28T12:05:00Z"),
        );
      expect(outcome(run), `${label} clean`).toContain("THREW UniverseValidationError");
      for (const variant of VARIANTS) {
        expect(
          withInherited("skipChecks", true, variant.enumerable, () => outcome(run)),
          `${label} / ${variant.label} — BASE: ${base}`,
        ).toContain("THREW UniverseValidationError");
      }
    }
  });

  it("lets no InvalidDecimalStringError escape a direct appendParameterVersion (NOTE-2)", () => {
    const history = createParameterHistory(
      SAMPLE_MARKET_ID as never,
      parameterObservationSample(),
    );
    const run = (): unknown =>
      appendParameterVersion(
        history,
        observation({ ...LEAN, tickSize: "1.50" }, "2026-08-28T12:05:00Z"),
        CONDITION_ID as never,
      );
    expect(outcome(run)).toContain("THREW UniverseValidationError");
    for (const variant of VARIANTS) {
      // BASE: `THREW InvalidDecimalStringError: compareDecimal(b): "1.50" …`
      expect(
        withInherited("skipChecks", true, variant.enumerable, () => outcome(run)),
        variant.label,
      ).toContain("THREW UniverseValidationError");
    }
  });

  it("is NON-VACUOUS: skipChecks really does defeat the frozen schema here", () => {
    // Without this, every assertion above could pass because `skipChecks` was
    // inert at this `zod` version. MEASURED, per variant:
    //   non-enumerable — the schema ACCEPTS `tickSize:"-9"`; the door refuses it
    //   enumerable     — the schema refuses, but for the unrecognized-key reason
    //                    (`strictObject` sees an inherited enumerable key), so
    //                    the ECONOMIC check is still not what stopped it
    const value = observation({ ...LEAN, tickSize: "-9" }, "2026-08-28T12:05:00Z");
    expect(ParameterObservationSchema.safeParse(value).success).toBe(false);
    expect(
      withInherited("skipChecks", true, false, () =>
        ParameterObservationSchema.safeParse(value).success,
      ),
    ).toBe(true);
    const enumerableIssues = withInherited("skipChecks", true, true, () => {
      const parsed = ParameterObservationSchema.safeParse(value);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.code);
    });
    expect(new Set(enumerableIssues)).toEqual(new Set(["unrecognized_keys"]));
    // Either way, the door's own read refuses on the ECONOMIC ground.
    for (const variant of VARIANTS) {
      const issues = withInherited("skipChecks", true, variant.enumerable, () => {
        const read = restateObservation(value);
        return read.ok ? [] : [...read.issues];
      });
      expect(issues, variant.label).toEqual([
        "parameters.tickSize: the observation's own tickSize is not a canonical decimal string greater than zero",
      ]);
    }
  });

  it("refuses NOTHING the frozen schema accepts (the re-statement is not stricter)", () => {
    const corpus: readonly unknown[] = [
      LEAN,
      { ...LEAN, feeScheduleRef: "fees" },
      { ...LEAN, openTime: "2026-08-28T12:00:00Z" },
      { ...LEAN, closeTime: "2026-08-28T12:15:00Z" },
      { ...LEAN, openTime: "2026-08-28T12:00:00Z", closeTime: "2026-08-28T12:15:00Z" },
      { ...LEAN, tickSize: "0.000001", minimumOrderSize: "1000000" },
      { ...LEAN, tradingDelaySeconds: 3600, negRisk: true },
      { ...LEAN, status: "RESOLVED" },
      { ...LEAN, feeScheduleRef: "x".repeat(200) },
      { ...LEAN, openTime: "2026-08-28T12:00:00.500+02:00" },
      parameterObservationSample().parameters,
    ];
    let accepted = 0;
    for (const parameters of corpus) {
      for (const source of ["polymarket", "binance", "operator"]) {
        const value = { parameters, observedAt: "2026-08-28T11:00:00Z", source };
        const schema = ParameterObservationSchema.safeParse(value).success;
        const restated = restateObservation(value).ok;
        if (schema) {
          accepted += 1;
          expect(restated, JSON.stringify(value).slice(0, 120)).toBe(true);
        }
      }
    }
    // NON-VACUITY: the corpus has to contain accepted rows for the claim to mean
    // anything, and it has to cover every optional member.
    expect(accepted).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// D4 and the throw contract
// ---------------------------------------------------------------------------

describe("what the module emits, and the verdict it keeps", () => {
  it("emits the snapshot, version, history and payload prototype-free and frozen", () => {
    const registered = registerMarket(createUniverseRegistry(), {
      identity: marketIdentitySample(),
      parameters: parameterObservationSample(),
    });
    /* c8 ignore next 3 -- the fixture registers. */
    if (!registered.ok) {
      throw new Error("fixture failed");
    }
    const recorded = recordMarketParameters(registered.value.registry, SAMPLE_MARKET_ID, {
      ...parameterObservationSample(),
      parameters: { ...parameterObservationSample().parameters, tickSize: "0.02" },
      observedAt: "2026-08-28T12:05:00Z",
    } as ParameterObservation);
    expect(recorded.ok).toBe(true);
    /* c8 ignore next 3 -- the change is real. */
    if (!recorded.ok) {
      return;
    }
    const emitted: readonly (readonly [string, object])[] = [
      ["version", recorded.value.version],
      ["version.parameters", recorded.value.version.parameters],
      ["event", recorded.value.event],
      [
        "history",
        recorded.value.registry.markets.get(SAMPLE_MARKET_ID as never)?.parameters as object,
      ],
    ];
    for (const [label, record] of emitted) {
      expect(Object.getPrototypeOf(record), label).toBeNull();
      expect(Object.isFrozen(record), label).toBe(true);
    }
    // And the JSON a consumer publishes is unchanged: same keys, same order.
    expect(Object.keys(recorded.value.version.parameters)).toEqual(
      Object.keys(MarketParametersSchema.shape),
    );
    expect(Object.keys(recorded.value.event)).toEqual([
      "internalMarketId",
      "conditionId",
      "parametersVersion",
      "previousParametersVersion",
      "parameterVersionRef",
      "changedParameters",
      "tickSize",
      "minimumOrderSize",
    ]);
  });

  it("keeps the documented UniverseValidationError contract for honest-but-wrong input", () => {
    // The frozen schema judges FIRST, so the message is still its own.
    let thrown: unknown;
    try {
      createParameterHistory(
        SAMPLE_MARKET_ID as never,
        observation({ ...LEAN, tickSize: "-9" }, "2026-08-28T11:00:00Z"),
      );
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UniverseValidationError);
    expect((thrown as UniverseValidationError).message).toBe(
      'market parameter observation is invalid: parameters.tickSize: expected a value > 0, received "-9"',
    );
    expect((thrown as UniverseValidationError).code).toBe("UNIVERSE_INPUT_INVALID");
  });

  it("still records an honest change, with the history immutable", () => {
    const history = createParameterHistory(SAMPLE_MARKET_ID as never, parameterObservationSample());
    const appended = appendParameterVersion(
      history,
      {
        ...parameterObservationSample(),
        parameters: { ...parameterObservationSample().parameters, tickSize: "0.02" },
        observedAt: "2026-08-28T12:05:00Z",
      } as ParameterObservation,
      CONDITION_ID as never,
    );
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      expect(appended.value.version.parametersVersion).toBe(2);
      expect([...appended.value.version.changedParameters]).toEqual(["tick_size"]);
      // The history it was given is unchanged, and holds the SAME frozen object.
      expect(history.versions).toHaveLength(1);
      expect(appended.value.history.versions[0]).toBe(history.versions[0]);
    }
  });
});

it("refuses an own accessor tickSize even when its value validates (F3)", () => {
  const sample = parameterObservationSample();
  const parameters = { ...sample.parameters };
  Object.defineProperty(parameters, "tickSize", { enumerable: true, get: () => "0.01" });
  const candidate = { ...sample, parameters };
  expect(ParameterObservationSchema.safeParse(candidate).success).toBe(true);
  expect(() => createParameterHistory(SAMPLE_MARKET_ID as never, candidate))
    .toThrowError(UniverseValidationError);
  expect(() => createParameterHistory(SAMPLE_MARKET_ID as never, candidate))
    .toThrowError(/accessor property/);
});
