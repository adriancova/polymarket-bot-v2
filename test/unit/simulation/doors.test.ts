/**
 * The hostile-input battery for `packages/simulation`'s doors (ADR-020,
 * `docs/contracts/schema-boundary.md` §2 and §4).
 *
 * ## What is being claimed
 *
 * `schema-boundary.md` §4: a package claiming conformance says which of D1–D4 it
 * performs and what it measured, and states THE BOUND — "under its pollution
 * battery, permission never varies, a `SAFETY_CANCEL` is byte-identical, and no
 * throw escapes" (ADR-020 §6).
 *
 * This package's answer, measured below:
 *
 * - **D1** — every caller/wire value is materialized prototype-free before it is
 *   validated: `materializeInput` for decoded rows, and the strict-JSON reader,
 *   which BUILDS the tree with `Object.create(null)` as it parses, for manifest
 *   bytes. Values are read from property DESCRIPTORS, so a getter is refused
 *   without being invoked.
 * - **D2 is not applicable, and that is the strongest form of it, not a waiver.**
 *   D2 exists to sever a `zod` node's `_zod` container and warm its lazies.
 *   This package runs no schema library and `zod` is absent from its whole
 *   dependency closure, so there is no `skipChecks` / `optin` / `optout` /
 *   `when` / `values` slot to inherit and no lazy build to poison. The probes
 *   below install those exact keys anyway and measure that nothing moves.
 * - **D3** — values come from the materialized tree by construction: there is no
 *   library output to take them from.
 * - **D4** — every emitted record is `ownFrozenTree`: null prototype, deep
 *   frozen, `undefined` members dropped, so an absent optional field of an
 *   emitted record cannot be answered by a polluted `Object.prototype`.
 *
 * ## The comparison that makes it evidence rather than assertion
 *
 * `the frozen schema is defeated where the hand-written predicate is not` runs
 * the SAME pollution against `packages/domain`'s `Uuidv7Schema` and against this
 * package's `isCanonicalUuidV7`. Under an inherited `skipChecks` the schema
 * accepts `"NOT-A-UUID"`; the predicate still refuses it. That is `GOV-2A`
 * probe K3's shape, reproduced against this package's own mechanism.
 */

import { afterEach, describe, expect, it } from "vitest";

import { Uuidv7Schema } from "../../../packages/domain/src/index.js";
import {
  MAX_INPUT_DEPTH,
  isCanonicalUuidV7,
  isIsoTimestamp,
  loadDataset,
  materializeInput,
  ownFrozenTree,
  parseStrictJsonText,
  readDatasetManifestText,
  readFeeScheduleSnapshot,
  readLatencyDistribution,
  readLatencyModel,
  readQueueModelParameters,
  readRunPins,
  simulationRefusal,
  SimulatedVenue,
  tier0Model,
  unmodeledRateLimits,
  createReplayClock,
  type FeeScheduleSnapshot,
  type LatencyDistribution,
  type LatencyModel,
  type QueueModelParameters,
  type ReplayRunPins,
  type SimulationResult,
} from "../../../packages/simulation/src/index.js";

import * as simulation from "../../../packages/simulation/src/index.js";

import { OUT_OF_ORDER_VENUE_FRAMES, buildDataset, runPins, sha256Hex } from "./fixtures.js";

// ---------------------------------------------------------------------------
// The pollution battery
// ---------------------------------------------------------------------------

const installed: (string | symbol)[] = [];

/**
 * Installs one polluted property on `Object.prototype`.
 *
 * The descriptor is built with `Object.create(null)` rather than as an object
 * literal, and that is not fastidiousness: ADR-020 §1 item 8 measured that an
 * inherited `get` makes every `Object.defineProperty` written with a LITERAL
 * descriptor throw `TypeError`. The first draft of this helper used a literal
 * and this suite's own "descriptor literals" class made it throw — the class
 * reproduced inside its own test harness.
 */
function pollute(key: string, descriptor: PropertyDescriptor): void {
  // Built by ASSIGNMENT onto a null-prototype object: a nested
  // `Object.defineProperty` would itself take a literal descriptor and hit the
  // same class, and assignment onto a prototype-free target can invoke no
  // inherited setter.
  const own = Object.create(null) as Record<string, unknown>;
  own["configurable"] = true;
  for (const name of Object.getOwnPropertyNames(descriptor)) {
    own[name] = (descriptor as Record<string, unknown>)[name];
  }
  Object.defineProperty(Object.prototype, key, own as PropertyDescriptor);
  installed.push(key);
}

function cleanPrototype(): void {
  while (installed.length > 0) {
    const key = installed.pop();
    if (key !== undefined) delete (Object.prototype as Record<string | symbol, unknown>)[key];
  }
}

afterEach(cleanPrototype);

/**
 * Runs a probe under pollution, removes the pollution, and only then returns.
 *
 * NOT a convenience. `WP-190` R1-N4 / `WP-180` R8-1 recorded that the tooling
 * assertion libraries themselves write object-literal property descriptors, so
 * under an inherited `get` **`expect(...)` throws before it can compare**. The
 * first draft of this suite asserted inside the polluted window and failed on
 * the assertion rather than on the door. Measuring under pollution and asserting
 * after it is the only shape that measures the door.
 */
function underPollution<TValue>(install: () => void, probe: () => TValue): TValue {
  install();
  try {
    return probe();
  } finally {
    cleanPrototype();
  }
}

/** The async form of {@link underPollution}. */
async function underPollutionAsync<TValue>(
  install: () => void,
  probe: () => Promise<TValue>,
): Promise<TValue> {
  install();
  try {
    return await probe();
  } finally {
    cleanPrototype();
  }
}

/** Every measured class of `schema-boundary.md` §2, as installable pollution. */
const CLASSES: readonly {
  readonly name: string;
  readonly install: () => void;
}[] = [
  {
    name: "adoption (enumerable value on a declared key)",
    install: () => {
      pollute("ingestSeq", { value: "999999", enumerable: true, writable: true });
      pollute("datasetRowOrdinal", { value: 999, enumerable: true, writable: true });
    },
  },
  {
    name: "adoption (NON-ENUMERABLE value on a declared key)",
    install: () => {
      pollute("ingestSeq", { value: "999999", enumerable: false, writable: true });
      pollute("payloadSha256", { value: "0".repeat(64), enumerable: false, writable: true });
      pollute("gatewayEpochs", { value: [], enumerable: false, writable: true });
    },
  },
  {
    name: "loss (get-only inherited accessor on a declared key)",
    install: () => {
      pollute("segmentId", { get: () => "adopted", enumerable: false });
    },
  },
  {
    name: "defaults defeated (get-only accessor on a defaulted key)",
    install: () => {
      pollute("pinnedVersions", { get: () => ({}), enumerable: false });
      pollute("replayEligible", { get: () => true, enumerable: false });
    },
  },
  {
    name: "format checks disabled (inherited skipChecks)",
    install: () => {
      pollute("skipChecks", { value: true, enumerable: false, writable: true });
    },
  },
  {
    name: "required-key waiver (inherited optin and optout)",
    install: () => {
      pollute("optin", { value: "optional", enumerable: false, writable: true });
      pollute("optout", { value: "optional", enumerable: false, writable: true });
    },
  },
  {
    name: "custom checks skipped (inherited when)",
    install: () => {
      pollute("when", { value: () => false, enumerable: false, writable: true });
    },
  },
  {
    name: "descriptor literals (inherited get)",
    install: () => {
      pollute("get", { value: undefined, enumerable: false, writable: true });
      pollute("set", { value: undefined, enumerable: false, writable: true });
    },
  },
  {
    name: "values (inherited values)",
    install: () => {
      pollute("values", { value: () => [], enumerable: false, writable: true });
    },
  },
  {
    name: "cold-lazy poisoning (enumerable key present at first parse)",
    install: () => {
      pollute("_zod", { value: {}, enumerable: true, writable: true });
      pollute("def", { value: {}, enumerable: true, writable: true });
    },
  },
];

// ---------------------------------------------------------------------------

describe("the bound: permission never varies under the pollution battery", () => {
  const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });

  const clean = {
    manifest: readDatasetManifestText(fixture.manifestText),
    pins: readRunPins(runPins()),
    goodUuid: isCanonicalUuidV7("0190a3e0-0000-7000-8000-000000000001"),
    badUuid: isCanonicalUuidV7("NOT-A-UUID"),
    goodTime: isIsoTimestamp("2026-01-01T00:00:00Z"),
    badTime: isIsoTimestamp("yesterday"),
  };

  it("baseline: the doors accept what they should and refuse what they should", () => {
    expect(clean.manifest.ok).toBe(true);
    expect(clean.pins.ok).toBe(true);
    expect(clean.goodUuid).toBe(true);
    expect(clean.badUuid).toBe(false);
    expect(clean.goodTime).toBe(true);
    expect(clean.badTime).toBe(false);
  });

  for (const battery of CLASSES) {
    it(`is unmoved by ${battery.name}`, async () => {
      const observed = await underPollutionAsync(battery.install, async () => {
        const manifest = readDatasetManifestText(fixture.manifestText);
        const loaded = manifest.ok
          ? await loadDataset({
              dataset: manifest.value,
              archive: fixture.archive,
              digestSha256: sha256Hex,
            })
          : undefined;
        return {
          goodUuid: isCanonicalUuidV7("0190a3e0-0000-7000-8000-000000000001"),
          badUuid: isCanonicalUuidV7("NOT-A-UUID"),
          goodTime: isIsoTimestamp("2026-01-01T00:00:00Z"),
          badTime: isIsoTimestamp("yesterday"),
          manifestOk: manifest.ok,
          gatewayEpoch: manifest.ok ? manifest.value.gatewayEpoch : null,
          recordCounts: manifest.ok ? JSON.stringify(manifest.value.recordCounts) : null,
          segmentCount: manifest.ok ? manifest.value.segments.length : -1,
          pinsOk: readRunPins(runPins()).ok,
          loadOk: loaded?.ok ?? false,
          ingestSeqs: loaded?.ok ? loaded.value.records.map((r) => r.frame.ingestSeq).join(",") : "",
          ordinals: loaded?.ok ? loaded.value.records.map((r) => r.datasetRowOrdinal).join(",") : "",
        };
      });

      // Permission never varies.
      expect(observed.goodUuid).toBe(clean.goodUuid);
      expect(observed.badUuid).toBe(clean.badUuid);
      expect(observed.goodTime).toBe(clean.goodTime);
      expect(observed.badTime).toBe(clean.badTime);
      expect(observed.manifestOk).toBe(clean.manifest.ok);
      expect(observed.pinsOk).toBe(clean.pins.ok);
      expect(observed.loadOk).toBe(true);

      // And the VALUES the doors produced are the same, not merely the verdict.
      expect(observed.gatewayEpoch).toBe(clean.manifest.ok ? clean.manifest.value.gatewayEpoch : null);
      expect(observed.recordCounts).toBe(
        clean.manifest.ok ? JSON.stringify(clean.manifest.value.recordCounts) : null,
      );
      expect(observed.segmentCount).toBe(clean.manifest.ok ? clean.manifest.value.segments.length : -1);
      expect(observed.ingestSeqs).toBe("1,2,3");
      expect(observed.ordinals).toBe("0,1,2");
    });
  }
});

describe("the bound: a SAFETY_CANCEL is byte-identical under pollution", () => {
  function venue(): SimulatedVenue {
    const clock = createReplayClock({
      receivedAt: "2026-01-01T00:00:00.000Z",
      receivedMonotonicNs: "1000",
    });
    if (!clock.ok) throw new Error("clock refused");
    return new SimulatedVenue({
      clock: clock.value,
      runMode: "BACKTEST",
      model: tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) }),
      feeSnapshot: {
        snapshotVersion: "fees/2026-08-24",
        takerFeeRate: "0.07",
        makerFeeRate: "0",
        roundingDecimalPlaces: 5,
        roundingMode: "HALF_UP",
        minimumChargedFee: "0.00001",
        feeCurrency: "USDC",
      },
      rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
      policy: {
        timeInForceFor: () => "GTC",
        statedExpiryNsFor: () => undefined,
        sameInstantAdditionsFor: () => "NOT_OBSERVED",
      },
      startingCash: "1000",
    });
  }

  const cancelCommand = {
    executionPlanId: "plan-1",
    reason: "kill switch",
    scope: { orderIds: ["a", "b"] },
    priority: "SAFETY_CANCEL",
  } as const;

  it("produces the same cancel bytes clean and under every class", async () => {
    const cleanResult = JSON.stringify(await venue().cancel(cancelCommand));
    const results: { readonly name: string; readonly bytes: string }[] = [];
    for (const battery of CLASSES) {
      const bytes = await underPollutionAsync(battery.install, async () =>
        JSON.stringify(await venue().cancel(cancelCommand)),
      );
      results.push({ name: battery.name, bytes });
    }
    for (const result of results) {
      expect(result.bytes, `cancel differed under ${result.name}`).toBe(cleanResult);
    }
  });
});

describe("the frozen schema is defeated where the hand-written predicate is not", () => {
  it("Uuidv7Schema accepts NOT-A-UUID under inherited skipChecks; isCanonicalUuidV7 does not", () => {
    expect(Uuidv7Schema.safeParse("NOT-A-UUID").success).toBe(false);
    expect(isCanonicalUuidV7("NOT-A-UUID")).toBe(false);

    pollute("skipChecks", { value: true, enumerable: false, writable: true });

    // The measured ADR-020 §1 item 4 class, reproduced here rather than cited.
    const schemaVerdict = Uuidv7Schema.safeParse("NOT-A-UUID").success;
    const predicateVerdict = isCanonicalUuidV7("NOT-A-UUID");
    expect(schemaVerdict).toBe(true); // the library check is a no-op
    expect(predicateVerdict).toBe(false); // the hand-written one is not
  });
});

describe("D1: the materializer refuses what is not data, without running it", () => {
  it("refuses a getter without invoking it", () => {
    let invoked = 0;
    const hostile = Object.defineProperty({}, "field", {
      get: () => {
        invoked += 1;
        return "value";
      },
      enumerable: true,
      configurable: true,
    });
    const outcome = materializeInput(hostile, "$");
    expect(outcome.ok).toBe(false);
    expect(invoked).toBe(0);
  });

  it("refuses __proto__ as a property name", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    const outcome = materializeInput(hostile, "$");
    expect(outcome.ok).toBe(false);
  });

  it("refuses a cycle, a symbol key, a sparse hole and a non-plain prototype", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(materializeInput(cyclic, "$").ok).toBe(false);

    const symbolled = { [Symbol.iterator]: 1, a: 2 };
    expect(materializeInput(symbolled, "$").ok).toBe(false);

    const sparse: unknown[] = [1];
    sparse.length = 3;
    expect(materializeInput({ list: sparse }, "$").ok).toBe(false);

    class Custom {
      readonly a = 1;
    }
    expect(materializeInput(new Custom(), "$").ok).toBe(false);
  });

  it("produces a tree with no prototype, so an absent field stays absent", () => {
    const outcome = materializeInput({ present: 1 }, "$");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    pollute("absent", { value: "adopted", enumerable: false, writable: true });
    expect((outcome.value as Record<string, unknown>)["absent"]).toBeUndefined();
    expect(Object.getPrototypeOf(outcome.value as object)).toBeNull();
  });
});

describe("D4: emitted values are prototype-free and frozen", () => {
  it("a manifest read emits a null-prototype, deep-frozen tree", () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const dataset = readDatasetManifestText(fixture.manifestText);
    expect(dataset.ok).toBe(true);
    if (!dataset.ok) return;
    expect(Object.getPrototypeOf(dataset.value)).toBeNull();
    expect(Object.isFrozen(dataset.value)).toBe(true);
    expect(Object.isFrozen(dataset.value.segments)).toBe(true);
    expect(Object.isFrozen(dataset.value.segments[0])).toBe(true);
    expect(Object.getPrototypeOf(dataset.value.recordCounts)).toBeNull();
  });

  it("a refusal's details are own, frozen, prototype-free data", () => {
    const refusal = simulationRefusal("SIMULATION_INPUT_INVALID", "message", {
      ok: 1,
      nested: { a: 1 },
    });
    expect(Object.getPrototypeOf(refusal)).toBeNull();
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(Object.getPrototypeOf(refusal.details)).toBeNull();
    // A structured detail is DESCRIBED, never aliased.
    expect(refusal.details["nested"]).toBe("an object");
  });

  it("ownFrozenTree drops undefined members so they cannot be adopted", () => {
    const emitted = ownFrozenTree({ present: 1, absent: undefined }) as Record<string, unknown>;
    pollute("absent", { value: "adopted", enumerable: false, writable: true });
    expect(Object.hasOwn(emitted, "absent")).toBe(false);
    expect(emitted["absent"]).toBeUndefined();
  });
});

describe("the strict-JSON reader (ADR-017 §3)", () => {
  it("refuses a duplicate key rather than resolving last-wins", () => {
    const outcome = parseStrictJsonText('{"a": 1, "a": 2}');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem.problem).toContain("duplicate object key");
  });

  it("refuses a __proto__ member name", () => {
    const outcome = parseStrictJsonText('{"__proto__": {"x": 1}}');
    expect(outcome.ok).toBe(false);
  });

  it("refuses NaN, Infinity and -Infinity", () => {
    for (const literal of ["NaN", "Infinity", "-Infinity", "[NaN]", '{"a": Infinity}']) {
      expect(parseStrictJsonText(literal).ok, literal).toBe(false);
    }
  });

  it("builds objects with no prototype", () => {
    const outcome = parseStrictJsonText('{"a": {"b": 1}}');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.getPrototypeOf(outcome.value as object)).toBeNull();
    const nested = (outcome.value as Record<string, unknown>)["a"];
    expect(Object.getPrototypeOf(nested as object)).toBeNull();
  });

  it("no throw escapes any door under any class", () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const escapes: string[] = [];
    for (const battery of CLASSES) {
      const thrown = underPollution(battery.install, () => {
        const failures: string[] = [];
        const attempt = (what: string, run: () => unknown): void => {
          try {
            run();
          } catch (cause) {
            failures.push(`${battery.name}/${what}: ${String(cause)}`);
          }
        };
        attempt("manifest (valid)", () => readDatasetManifestText(fixture.manifestText));
        attempt("manifest (malformed)", () => readDatasetManifestText("{ not json"));
        attempt("manifest (empty)", () => readDatasetManifestText(""));
        attempt("run pins (empty)", () => readRunPins({} as never));
        attempt("run pins (hostile)", () => readRunPins(null as never));
        attempt("materialize", () => materializeInput({ a: 1 }, "$"));
        attempt("materialize (hostile)", () => materializeInput(new Proxy({}, {}), "$"));
        attempt("strict json", () => parseStrictJsonText('{"a":1}'));
        return failures;
      });
      escapes.push(...thrown);
    }
    expect(escapes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The bound, stated over the WHOLE export surface
// ---------------------------------------------------------------------------

/**
 * Exports that are NOT doors, and the door that validates what reaches each.
 *
 * A door answers `{ ok }` and therefore promises a refusal instead of an
 * exception (ADR-020 §6). The functions below answer with a VALUE: they are
 * arithmetic, formatting and construction over inputs a door has already
 * accepted, and the compiler is what stands between a caller and a wrong
 * argument. Each entry names where its inputs were validated, so this list is a
 * claim a reviewer can check rather than a waiver.
 */
const PURE_HELPERS: Readonly<Record<string, string>> = Object.freeze({
  addMilliseconds: "clock.ts — recorded nanoseconds, validated by `createReplayClock`/`advanceTo`",
  addNanoseconds: "clock.ts — as above",
  comparePlanPriority: "ports.ts — a closed union WP-190 produced and `readRunPins`-era plans carry",
  daysInMonth: "grammar.ts — called only by `isIsoTimestamp`, which validates the digits first",
  defineData: "refusals.ts — an internal emit helper; its target is always a fresh own record",
  deriveStream: "seed.ts — the run seed is validated as an unsigned integer string by `readRunPins`",
  deriveStreams: "seed.ts — as above",
  isCanonicalUuid: "grammar.ts — a total predicate: it answers true/false for any value",
  isCanonicalUuidV7: "grammar.ts — total predicate",
  isCodeString: "grammar.ts — total predicate",
  isDecimalString: "grammar.ts — total predicate",
  isIsoTimestamp: "grammar.ts — total predicate",
  isJsonBigNumber: "strict-json.ts — total predicate over the reader's own output",
  isMemberOf: "grammar.ts — total predicate over a caller-supplied vocabulary array",
  isNonEmptyString: "grammar.ts — total predicate",
  isNonNegativeInteger: "grammar.ts — total predicate",
  isPositiveInteger: "grammar.ts — total predicate",
  isRecord: "grammar.ts — total predicate",
  isSha256Hex: "grammar.ts — total predicate",
  isSimulationRefusalCode: "refusals.ts — total predicate",
  isTokenId: "grammar.ts — total predicate",
  isUnsignedIntegerString: "grammar.ts — total predicate",
  isoToEpochMilliseconds: "grammar.ts — returns `undefined` rather than throwing",
  describeForRefusal: "refusals.ts — total by construction; it exists so refusals cannot throw",
  ownDataDescriptor: "refusals.ts — internal emit helper",
  ownDataDetails: "refusals.ts — already total; it copies own data properties only",
  ownFrozenTree: "plain.ts — emits values this package BUILT; `materializeInput` is the ingress door",
  ownPlainCopy: "plain.ts — as above",
  plainRecord: "refusals.ts — takes no argument",
  readField: "grammar.ts — reads an own property descriptor; total for records, guarded by `isRecord`",
  recordKeys: "grammar.ts — total: answers `[]` for a non-record",
  sampleLatency: "latency.ts — the model is validated by `readLatencyModel` on the execution path",
  sampleLatencyMs: "latency.ts — as above",
  serializeBand: "serialize.ts — serializes a band `simulateResting`/`checkBandOrdering` produced",
  serializeRun: "serialize.ts — serializes a run `runReplay` produced",
  simulatedFill: "fill-model.ts — the only fill constructor; its callers validate every field first",
  simulationFailure: "refusals.ts — builds a refusal; `ownDataDetails` is already total",
  simulationOk: "refusals.ts — wraps a value the caller already produced",
  simulationRefusal: "refusals.ts — as `simulationFailure`",
  tier0Model: "tier0.ts — a version/identity constructor, pinned by §12.5 and validated by `readRunPins`",
  tier1Model: "tier1.ts — as above",
  toFillFact: "fill-model.ts — converts a fill this package produced into WP-200's shape",
  tokenBucketRateLimits: "rate-limit.ts — capacities are composition-root configuration",
  unmodeledRateLimits: "rate-limit.ts — takes a disclosure string",
});

// ---------------------------------------------------------------------------
// The two argument classes the round-2 review found missing from the battery
// ---------------------------------------------------------------------------

/**
 * A record that contains itself. Walking it without a cycle guard never ends.
 *
 * It is a VALID queue-parameter set with a self-reference added, and that is the
 * point: a cyclic record that a door rejects on its first field never reaches
 * the door's copy step, so it would not measure anything. This one passes every
 * check `readQueueModelParameters` makes and arrives at the emit path with the
 * cycle intact — which is where `52a058b` raised
 * `RangeError: Maximum call stack size exceeded`.
 */
function cyclicRecord(): Record<string, unknown> {
  const cyclic: Record<string, unknown> = {
    queueModelVersion: "sim/queue/v1",
    cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
    cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
    placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
    basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
  };
  cyclic["self"] = cyclic;
  return cyclic;
}

/** An array that contains itself. */
function cyclicArray(): unknown[] {
  const cyclic: unknown[] = [1];
  cyclic.push(cyclic);
  return cyclic;
}

/** How many times any getter on {@link getterBearingRecord}'s output ran. */
let gettersInvoked = 0;

/** A record whose members are CODE. A door that reads it by name runs it. */
function getterBearingRecord(): Record<string, unknown> {
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.setPrototypeOf(hostile, Object.prototype);
  for (const key of [
    "queueModelVersion",
    "latencyModelVersion",
    "snapshotVersion",
    "samples",
    "basis",
    "cancellationRatio",
    "takerFeeRate",
    "roundingMode",
    "shares",
  ]) {
    Object.defineProperty(hostile, key, {
      get: () => {
        gettersInvoked += 1;
        return "invoked";
      },
      enumerable: true,
      configurable: true,
    });
  }
  return hostile;
}

/** A record nested past {@link MAX_INPUT_DEPTH}. */
function deeplyNestedRecord(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: true };
  for (let level = 0; level < depth; level += 1) node = { nested: node };
  return node;
}

describe("the bound: no throw escapes any door of this package", () => {
  /** A venue built with only the options every path needs. */
  function hostileVenue(): SimulatedVenue {
    const clock = createReplayClock({
      receivedAt: "2026-01-01T00:00:00.000Z",
      receivedMonotonicNs: "1000",
    });
    if (!clock.ok) throw new Error("clock refused");
    const built = new SimulatedVenue({
      clock: clock.value,
      runMode: "BACKTEST",
      model: tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) }),
      feeSnapshot: {
        snapshotVersion: "fees/2026-08-24",
        takerFeeRate: "0.07",
        makerFeeRate: "0",
        roundingDecimalPlaces: 5,
        roundingMode: "HALF_UP",
        minimumChargedFee: "0.00001",
        feeCurrency: "USDC",
      },
      rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
      policy: {
        timeInForceFor: () => "GTC",
        statedExpiryNsFor: () => undefined,
        sameInstantAdditionsFor: () => "NOT_OBSERVED",
      },
      startingCash: "1000",
      books: {
        book: () => ({
          internalMarketId: "m",
          tokenId: "1234",
          top: () => ({}),
          ladder: () => [{ price: "0.5", size: "100" }],
        }),
      },
    });
    built.observe({
      gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
      ingestSeq: "1",
      receivedAt: "2026-01-01T00:00:00.000Z",
      datasetRowOrdinal: 0,
    });
    return built;
  }

  it("no throw escapes any DOOR, under hostile arguments", () => {
    // ADR-020 §6's bound is "no throw escapes", and the round-1 review found
    // five doors plus `SimulatedVenue.submit` that leaked
    // `InvalidDecimalStringError` when a TYPE-VALID but non-canonical decimal
    // reached layer-0 arithmetic. This drives every exported DOOR — found by
    // reflection, so a door added later is covered automatically — with a
    // battery of hostile arguments, and requires a refusal, never an exception.
    //
    // WHAT COUNTS AS A DOOR, and why the boundary is drawn here: a door is an
    // export whose signature PROMISES a typed refusal, which in this package
    // means it answers with `{ ok }`. {@link PURE_HELPERS} lists the exports
    // that do not, each with the door that validates what reaches it — they are
    // arithmetic and formatting over values a door has already accepted, and
    // making them "total" would mean inventing an answer for a call the
    // compiler already refuses.
    const hostile: readonly unknown[] = [
      undefined,
      null,
      "1,5",
      "",
      "NaN",
      -1,
      Number.NaN,
      {},
      [],
      Object.create(null),
      { model: {}, shares: "1,5", price: "x", snapshot: {}, ladder: [{}], trades: [{}] },
      new Proxy({}, {}),
      Symbol("hostile"),
      0n,
      // Round-2 review MEDIUM-1: the two classes this battery was MISSING, even
      // though the same file measures both against `materializeInput` above. A
      // cyclic argument raised `RangeError: Maximum call stack size exceeded`
      // out of `readQueueModelParameters`, `readLatencyDistribution` and
      // `readLatencyModel`, and a getter-bearing one was ACCEPTED with the
      // getter invoked. Both are driven against EVERY door here, so a door added
      // later is covered without anyone remembering to add it.
      cyclicRecord(),
      cyclicArray(),
      getterBearingRecord(),
      deeplyNestedRecord(MAX_INPUT_DEPTH + 8),
    ];

    const escapes: string[] = [];
    const drivenDoors: string[] = [];
    const exported = simulation as unknown as Record<string, unknown>;
    for (const name of Object.keys(exported).sort()) {
      const value = exported[name];
      if (typeof value !== "function") continue;
      // A class constructor called without `new` throws by language rule, which
      // is not a door leaking; classes are exercised by their own suites.
      if (/^class[\s{]/u.test(Function.prototype.toString.call(value))) continue;
      if (Object.hasOwn(PURE_HELPERS, name)) continue;
      drivenDoors.push(name);
      for (const argument of hostile) {
        for (const argumentList of [[argument], [argument, argument], [argument, argument, argument]]) {
          try {
            const outcome = (value as (...args: unknown[]) => unknown)(...argumentList);
            if (outcome instanceof Promise) outcome.catch(() => undefined);
          } catch (cause) {
            escapes.push(`${name}(${String(argumentList.length)}): ${String(cause)}`);
          }
        }
      }
    }
    expect(escapes, escapes.join("\n")).toEqual([]);
    // The probe is not vacuous: it really drove the doors, including every one
    // the round-1 review named.
    expect(drivenDoors.length).toBeGreaterThan(20);
    for (const door of [
      "computeFee",
      "checkBandOrdering",
      "consumeDepth",
      "markoutStressScenario",
      "quoteForDeploymentDecision",
      "readRunPins",
      "replayPathEconomics",
      "simulateResting",
      "sizeAtPrice",
      "tier0Immediate",
      "tier0Maker",
      "tier1Immediate",
    ]) {
      expect(drivenDoors, `${door} is not being driven`).toContain(door);
    }
  });

  it("every export is either a driven door or a listed pure helper", () => {
    // The allow-list is exhaustive and CURRENT: an export removed upstream fails
    // here, and an export added upstream is driven by the probe above unless it
    // is added here deliberately, with its validating door named.
    const exported = simulation as unknown as Record<string, unknown>;
    const functions = Object.keys(exported).filter(
      (name) =>
        typeof exported[name] === "function" &&
        !/^class[\s{]/u.test(Function.prototype.toString.call(exported[name])),
    );
    for (const name of Object.keys(PURE_HELPERS)) {
      expect(functions, `${name} is listed as a pure helper but is not exported`).toContain(name);
    }
  });

  it("SimulatedVenue.submit REFUSES rather than rejecting, on every hostile plan", async () => {
    const plans: readonly unknown[] = [
      null,
      undefined,
      {},
      { executionPlanId: "p", runMode: "BACKTEST", planKind: "POSITION", priority: "PLACEMENT", groups: null },
      {
        executionPlanId: "p",
        runMode: "BACKTEST",
        planKind: "POSITION",
        priority: "PLACEMENT",
        groups: [{ marketId: "m", orders: [{ plannedOrderId: "o", side: "YES", action: "BUY", limitPrice: "1,5", shares: "10", postOnly: false, executionStyle: "REST" }] }],
      },
      {
        executionPlanId: "p",
        runMode: "BACKTEST",
        planKind: "POSITION",
        priority: "PLACEMENT",
        groups: [{ marketId: "m", orders: [{ plannedOrderId: "o", side: "SIDEWAYS", action: "BUY", limitPrice: "0.5", shares: "10", postOnly: false, executionStyle: "REST" }] }],
      },
    ];
    for (const plan of plans) {
      const simulated = hostileVenue();
      const result = await simulated.submit(plan as never);
      expect(result.accepted, JSON.stringify(plan)).toBe(false);
      expect(result.venueClass).toBe("SIMULATED");
      expect(typeof result.refusalCode).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// D1 at the doors that take a CALLER RECORD (round-2 review, MEDIUM-1)
// ---------------------------------------------------------------------------

/**
 * Every door whose argument is a caller-supplied RECORD, with a VALID example.
 *
 * The battery above proves no throw escapes; these prove the stronger property
 * the fix is actually about: each of these doors materializes its argument
 * first, so a cycle is REFUSED (typed) rather than followed until the stack runs
 * out, and a getter is REFUSED WITHOUT BEING INVOKED.
 *
 * Measured at `52a058b` before the fix: the first three THREW
 * `RangeError: Maximum call stack size exceeded` on the cyclic argument, and the
 * fee and queue doors answered `ok: true` on the getter-bearing one having run
 * the getter once — `ownPlainCopy` read members with `value[key]`.
 */
const RECORD_DOORS: readonly {
  readonly name: string;
  readonly valid: () => unknown;
  readonly drive: (value: unknown) => SimulationResult<unknown>;
}[] = [
  {
    name: "readQueueModelParameters",
    valid: () => ({
      queueModelVersion: "sim/queue/v1",
      cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
      cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
      placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
      basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
    }),
    drive: (value) => readQueueModelParameters(value as QueueModelParameters),
  },
  {
    name: "readLatencyDistribution",
    valid: () => ({ samples: [{ milliseconds: 1, weight: 1 }] }),
    drive: (value) => readLatencyDistribution(value as LatencyDistribution, "decision"),
  },
  {
    name: "readLatencyModel",
    valid: () => ({
      latencyModelVersion: "sim/latency/v1",
      decision: { samples: [{ milliseconds: 1, weight: 1 }] },
      signing: { samples: [{ milliseconds: 1, weight: 1 }] },
      network: { samples: [{ milliseconds: 1, weight: 1 }] },
      venue: { samples: [{ milliseconds: 1, weight: 1 }] },
      basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
    }),
    drive: (value) => readLatencyModel(value as LatencyModel),
  },
  {
    name: "readFeeScheduleSnapshot",
    valid: () => ({
      snapshotVersion: "fees/2026-08-24",
      takerFeeRate: "0.07",
      makerFeeRate: "0",
      roundingDecimalPlaces: 5,
      roundingMode: "HALF_UP",
      minimumChargedFee: "0.00001",
      feeCurrency: "USDC",
    }),
    drive: (value) => readFeeScheduleSnapshot(value as FeeScheduleSnapshot),
  },
  {
    name: "readRunPins",
    valid: () => runPins(),
    drive: (value) => readRunPins(value as ReplayRunPins),
  },
];

describe("D1: a door materializes its caller record before it touches it", () => {
  it("every record door ACCEPTS its valid example (the probes below are not vacuous)", () => {
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      const outcome = door.drive(door.valid());
      if (!outcome.ok) {
        faults.push(`${door.name}: ${outcome.refusal.code}: ${outcome.refusal.message}`);
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
    // Every door the round-2 review named, plus the fifth instance of the same
    // pattern it did not, is in the table — so the probes below cover all five.
    expect(RECORD_DOORS.map((door) => door.name).sort()).toEqual([
      "readFeeScheduleSnapshot",
      "readLatencyDistribution",
      "readLatencyModel",
      "readQueueModelParameters",
      "readRunPins",
    ]);
  });

  it("REFUSES a cyclic argument, typed, instead of exhausting the stack", () => {
    // Faults are COLLECTED, not asserted inside the loop: a bare `expect` throws
    // on the first door and the remaining ones are never measured, so a
    // regression in the fifth door would hide behind a regression in the first.
    // Every door below is driven on every run.
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      const cyclic = door.valid() as Record<string, unknown>;
      cyclic["self"] = cyclic;
      let outcome: SimulationResult<unknown> | undefined;
      let thrown: unknown;
      try {
        outcome = door.drive(cyclic);
      } catch (cause) {
        thrown = cause;
      }
      if (thrown !== undefined) {
        faults.push(`${door.name}: threw ${String(thrown)}`);
        continue;
      }
      if (outcome === undefined || outcome.ok) {
        faults.push(`${door.name}: accepted a cyclic record`);
        continue;
      }
      if (outcome.refusal.code !== "SIMULATION_INPUT_NOT_DATA") {
        faults.push(`${door.name}: refused with ${outcome.refusal.code}`);
      }
      if (!outcome.refusal.message.includes("cycle")) {
        faults.push(`${door.name}: did not name the cycle — ${outcome.refusal.message}`);
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });

  it("REFUSES a nested cycle — the guard is on the whole tree, not the root", () => {
    const nested = { samples: [{ milliseconds: 1, weight: 1 }] } as Record<string, unknown>;
    const inner = { deeper: {} } as Record<string, unknown>;
    inner["deeper"] = inner;
    nested["extra"] = inner;
    const outcome = readLatencyDistribution(nested as unknown as LatencyDistribution, "decision");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATION_INPUT_NOT_DATA");
  });

  it("REFUSES a getter-bearing argument WITHOUT INVOKING the getter", () => {
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      let invoked = 0;
      const hostile = door.valid() as Record<string, unknown>;
      Object.defineProperty(hostile, "hostile", {
        get: () => {
          invoked += 1;
          return "value";
        },
        enumerable: true,
        configurable: true,
      });
      let outcome: SimulationResult<unknown> | undefined;
      let thrown: unknown;
      try {
        outcome = door.drive(hostile);
      } catch (cause) {
        thrown = cause;
      }
      if (invoked !== 0) faults.push(`${door.name}: INVOKED the getter ${String(invoked)}x`);
      if (thrown !== undefined) {
        faults.push(`${door.name}: threw ${String(thrown)}`);
        continue;
      }
      if (outcome === undefined || outcome.ok) {
        faults.push(`${door.name}: accepted an accessor-bearing record`);
        continue;
      }
      if (outcome.refusal.code !== "SIMULATION_INPUT_NOT_DATA") {
        faults.push(`${door.name}: refused with ${outcome.refusal.code}`);
      }
      if (!outcome.refusal.message.includes("accessor")) {
        faults.push(`${door.name}: did not name the accessor — ${outcome.refusal.message}`);
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });

  it("REFUSES an argument nested past MAX_INPUT_DEPTH", () => {
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      const deep = door.valid() as Record<string, unknown>;
      deep["extra"] = deeplyNestedRecord(MAX_INPUT_DEPTH + 8);
      let outcome: SimulationResult<unknown> | undefined;
      let thrown: unknown;
      try {
        outcome = door.drive(deep);
      } catch (cause) {
        thrown = cause;
      }
      if (thrown !== undefined) {
        faults.push(`${door.name}: threw ${String(thrown)}`);
        continue;
      }
      if (outcome === undefined || outcome.ok) {
        faults.push(`${door.name}: accepted an over-deep record`);
        continue;
      }
      if (outcome.refusal.code !== "SIMULATION_INPUT_NOT_DATA") {
        faults.push(`${door.name}: refused with ${outcome.refusal.code}`);
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });

  it("emits a tree of its OWN, not an alias of the caller's record", () => {
    // D4 on the way out, and the reason D1 has to happen on the way in: the
    // emitted value must not be the caller's object, or a later mutation of the
    // caller's object would change a value this package already answered with.
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      const offered = door.valid() as Record<string, unknown>;
      const outcome = door.drive(offered);
      if (!outcome.ok) {
        faults.push(`${door.name}: ${outcome.refusal.code}: ${outcome.refusal.message}`);
        continue;
      }
      if (outcome.value === offered) faults.push(`${door.name}: emitted the caller's own object`);
      if (Object.getPrototypeOf(outcome.value as object) !== null) {
        faults.push(`${door.name}: emitted a value with a prototype`);
      }
      if (!Object.isFrozen(outcome.value)) faults.push(`${door.name}: emitted an unfrozen value`);
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });

  it("readRunPins is STRICT: an unknown key is refused, never carried (L6)", () => {
    // Round-2 review L2: the strictness shipped with no test at all — deleting
    // the whole unknown-key loop left the suite green. A pin set that quietly
    // carried an extra field would let an operator believe something was pinned
    // that nothing reads, and §12.5 fixes what a run pins.
    const baseline = readRunPins(runPins());
    expect(baseline.ok).toBe(true);

    const faults: string[] = [];
    for (const key of ["extraPin", "fillModelVersionn", "runSeeds", "__proto__"]) {
      const offered = { ...runPins() } as Record<string, unknown>;
      Object.defineProperty(offered, key, {
        value: "smuggled",
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const outcome = readRunPins(offered as unknown as ReplayRunPins);
      if (outcome.ok) {
        faults.push(`accepted an unknown key ${key}`);
        continue;
      }
      if (!["REPLAY_MANIFEST_INVALID", "SIMULATION_INPUT_NOT_DATA"].includes(outcome.refusal.code)) {
        faults.push(`${key}: refused with ${outcome.refusal.code}`);
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);

    // …and nothing unknown survives onto the emitted pin set.
    if (!baseline.ok) return;
    expect(Object.keys(baseline.value).sort()).toEqual(Object.keys(runPins()).sort());
  });

  it("the shared battery really drove the getter-bearing argument", () => {
    // `gettersInvoked` is incremented by the battery's own getter-bearing
    // record. It is NOT asserted to be zero: a door that reads a field by name
    // legitimately reads it, and the bound this battery states is "no throw
    // escapes". The doors that must not invoke one are pinned above, by name.
    expect(gettersInvoked).toBeGreaterThan(0);
  });
});
