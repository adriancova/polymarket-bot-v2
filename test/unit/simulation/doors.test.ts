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
  ReplayClock,
  checkBandOrdering,
  computeFee,
  computeMarkouts,
  consumeDepth,
  DatasetEventSource,
  deriveReplayEventId,
  deriveStreams,
  isCanonicalUuidV7,
  isIsoTimestamp,
  loadDataset,
  markoutStressScenario,
  materializeInput,
  ownFrozenTree,
  parseStrictJsonText,
  quoteForDeploymentDecision,
  readDatasetManifestText,
  readFeeScheduleSnapshot,
  readLatencyDistribution,
  readLatencyModel,
  readQueueModelParameters,
  readRunPins,
  readSameInstantAdditions,
  reconcileRunPins,
  replayPathEconomics,
  runEventSource,
  runReplay,
  serializeBand,
  simulateResting,
  simulationFailure,
  simulationOk,
  simulationRefusal,
  sizeAtPrice,
  SimulatedVenue,
  tier0Immediate,
  tier0Maker,
  tier0Model,
  tier1Immediate,
  tier1Model,
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

  it("refuses a bigint by DEFAULT, and carries one only where a door asks", () => {
    // The `bigintIsData` policy is the one thing round 3 relaxed, so it is
    // pinned here rather than described. A `bigint` is a PRIMITIVE — immutable,
    // identity-free, no prototype, no code — so admitting it adopts nothing;
    // but it cannot come from JSON, so at a WIRE door its presence means the
    // value was constructed rather than recorded, and the default refuses it.
    expect(materializeInput({ instant: 1n }, "$").ok).toBe(false);
    expect(materializeInput({ instant: 1n }, "$", {}).ok).toBe(false);
    expect(materializeInput({ instant: 1n }, "$", { bigintIsData: false }).ok).toBe(false);
    const carried = materializeInput({ instant: 1n }, "$", { bigintIsData: true });
    expect(carried.ok).toBe(true);
    if (!carried.ok) return;
    expect((carried.value as Record<string, unknown>)["instant"]).toBe(1n);

    // Relaxing it relaxes NOTHING else: an accessor, a cycle and a foreign
    // prototype are still refused under the permissive policy.
    const withAccessor = Object.defineProperty({}, "field", {
      get: () => "value",
      enumerable: true,
      configurable: true,
    });
    expect(materializeInput(withAccessor, "$", { bigintIsData: true }).ok).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(materializeInput(cyclic, "$", { bigintIsData: true }).ok).toBe(false);
    class Custom {
      readonly a = 1n;
    }
    expect(materializeInput(new Custom(), "$", { bigintIsData: true }).ok).toBe(false);

    // …and the WIRE doors keep the default: a pin set carrying a bigint is not
    // a recorded pin set.
    const pins = { ...runPins() } as unknown as Record<string, unknown>;
    pins["runSeed"] = 42n;
    const outcome = readRunPins(pins as unknown as ReplayRunPins);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATION_INPUT_NOT_DATA");
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

// ---------------------------------------------------------------------------
// The three hostility classes, NESTED (round-3 review, MEDIUM-1)
// ---------------------------------------------------------------------------

/**
 * Each class, built at DEPTH rather than at the root.
 *
 * Round 2 measured all three at the top level of a door's argument. Round 3's
 * drive found that a door which reads `input.order` and then computes over the
 * caller's object is untouched by a root-level probe: the hostility has to sit
 * INSIDE the record the door actually reads. Everything below is therefore
 * planted two levels down from the record under test.
 */
const HOSTILITY_CLASSES: readonly {
  readonly name: string;
  /** Builds the value to plant. `undefined` getters counter means it has none. */
  readonly build: () => unknown;
  /** The substring the refusal must name, so a coincidental refusal cannot pass. */
  readonly named: string;
}[] = [
  {
    name: "a nested cycle",
    build: () => {
      const inner: Record<string, unknown> = { deeper: {} };
      inner["deeper"] = inner;
      return { nested: inner };
    },
    named: "cycle",
  },
  {
    name: "a nested accessor",
    build: () => {
      const inner = {} as Record<string, unknown>;
      Object.defineProperty(inner, "hostile", {
        get: () => {
          gettersInvoked += 1;
          nestedGettersInvoked += 1;
          return "value";
        },
        enumerable: true,
        configurable: true,
      });
      return { nested: { deeper: inner } };
    },
    named: "accessor",
  },
  {
    name: "nested past MAX_INPUT_DEPTH",
    build: () => ({ nested: { deeper: deeplyNestedRecord(MAX_INPUT_DEPTH + 8) } }),
    named: "",
  },
];

/** How many times a NESTED accessor planted by the battery above ran. */
let nestedGettersInvoked = 0;

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

  it("no throw escapes any DOOR, under hostile arguments", async () => {
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
      // Round-3 review, MEDIUM-1 / LOW-1: the same three classes NESTED, driven
      // by reflection against EVERY export — so an export added later is
      // covered by construction rather than by anyone remembering to list it.
      ...HOSTILITY_CLASSES.map((hostility) => hostility.build()),
      // …and each nested class wrapped in a record whose keys the doors DO read,
      // so it reaches a field read rather than sitting in a key nobody looks at.
      ...HOSTILITY_CLASSES.map((hostility) => ({
        model: hostility.build(),
        order: hostility.build(),
        trades: [hostility.build()],
        fills: [hostility.build()],
        ladder: [hostility.build()],
        snapshot: hostility.build(),
        parameters: hostility.build(),
        feeSnapshot: hostility.build(),
        atEvent: hostility.build(),
        fill: hostility.build(),
        diagnostics: [hostility.build()],
        band: hostility.build(),
        pins: hostility.build(),
      })),
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
            // AWAITED, not swallowed (round-4 review, MEDIUM-1's class). The
            // previous line was `outcome.catch(() => undefined)`, which discards
            // exactly the failure ADR-020 §6's bound is about: a REJECTED PROMISE
            // is a throw that escapes one tick later. Awaiting it here found
            // three live violations at `d56e707` — `loadDataset`
            // ("Cannot destructure property 'dataset' of 'options' as it is
            // null"), `runEventSource` ("Cannot read properties of null (reading
            // 'events')") and `runReplay` ("Cannot read properties of null
            // (reading 'runPins')") — each of which now answers a typed refusal.
            if (outcome instanceof Promise) await outcome;
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

  it("an ASYNC door REFUSES rather than rejecting, when a PORT it was given throws", async () => {
    // Round-4 review MEDIUM-1's class, at the three async doors. Awaiting the
    // battery above found them rejecting on a hostile ARGUMENT; these three
    // probes close the other half — a port that throws MID-RUN, which no
    // argument check can anticipate and only the totality guard contains.
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const manifest = readDatasetManifestText(fixture.manifestText);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    // 1. `loadDataset`, with a DIGEST port that throws.
    const loaded = await loadDataset({
      dataset: manifest.value,
      archive: fixture.archive,
      digestSha256: () => {
        throw new Error("a digest port that throws");
      },
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.code).toBe("SIMULATION_INTERNAL");

    // 2. `runEventSource`, with a NORMALIZER that throws mid-stream.
    const verified = await loadDataset({
      dataset: manifest.value,
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const created = DatasetEventSource.create(verified.value, {
      normalizerVersion: "test/throwing/v1",
      normalize: () => {
        throw new Error("a normalizer that throws");
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const drained = await runEventSource(created.value);
    expect(drained.ok).toBe(false);
    if (drained.ok) return;
    expect(drained.refusal.code).toBe("SIMULATION_INTERNAL");

    // 3. `runReplay`, with an options bag whose `runPins` read throws.
    const trapping = new Proxy(
      {},
      {
        get: (_held, key) => {
          if (key === "then") return undefined;
          throw new Error("an options trap that throws");
        },
      },
    );
    const replayed = await runReplay(trapping as never);
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.refusal.code).toBe("SIMULATION_INTERNAL");
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
// D1 at the doors that take a CALLER RECORD (round-2 MEDIUM-1, round-3 MEDIUM-1)
// ---------------------------------------------------------------------------

/**
 * A path from a door's argument to one caller DATA RECORD it materializes.
 *
 * `[]` means the argument IS the record. `["order"]` means the argument is an
 * options bag whose `order` member is one. The battery plants its hostility AT
 * that record — nested inside it — which is the distinction round 3 turned on:
 * a root-level probe cannot reach a door that reads `input.order` and then
 * computes over the caller's object.
 */
type RecordPath = readonly string[];

interface RecordDoor {
  /** Unique label for this probe; several probes may target one export. */
  readonly id: string;
  /**
   * The EXPORT this drives, for the partition check below.
   *
   * For a CLASS MEMBER (round-4 review, MEDIUM-2) this is the class's export
   * name and {@link RecordDoor.member} names the method, so
   * `SimulatedVenue.observeTrade` is checked against the class-member partition
   * rather than against the exported-function partition.
   */
  readonly name: string;
  /** The method, when this door is a class member: `"observeTrade"`. */
  readonly member?: string;
  readonly valid: () => unknown;
  /**
   * Whether the ARGUMENT ITSELF is the caller data record.
   *
   * `false` for a door whose argument is an OPTIONS BAG assembled at the call
   * site: the bag is not materialized (it may carry ports), each of its fields
   * is read once, and the records it yields are.
   */
  readonly argumentIsData: boolean;
  /**
   * Members the walker must NOT treat as data, each with the reason.
   *
   * Ports (an object with a function member) and class instances (a non-plain
   * prototype) are detected mechanically; this is for anything neither rule
   * catches. It is deliberately the ONLY hand-maintained part: a new DATA member
   * of a fixture is covered by construction, and only a new NON-data one has to
   * be declared.
   */
  readonly notData?: Readonly<Record<string, string>>;
  /**
   * Drives the door.
   *
   * It may answer a PROMISE (round-4 review, MEDIUM-2): three of the class
   * members this table now covers — `submit`, `submitAll`, `cancel` — are async,
   * and a door that fails one tick later has still failed. Each async entry
   * adapts its own answer shape onto `SimulationResult` at the call site, and
   * says how.
   */
  readonly drive: (value: unknown) => SimulationResult<unknown> | Promise<SimulationResult<unknown>>;
}

/**
 * Every position inside a door's valid argument that holds caller DATA.
 *
 * DERIVED, not listed (round-3 review, LOW-1). The previous table named the
 * records by hand, so a door could claim one record, be probed at that one, and
 * quietly read three others raw — which is how round 3's four doors survived
 * round 2. Here the fixture is WALKED, and every object or array it reaches is
 * probed, except:
 *
 * - a PORT — an object with a function-valued own member; its contract is those
 *   methods and materializing it would delete them. Round-4 review NOTE-2: the
 *   walker used to skip a port's WHOLE SUBTREE, so a HYBRID (an object carrying
 *   both methods and a nested data record) would have been silently unprobed. It
 *   now declines to probe the hybrid ITSELF — that object is a port — and keeps
 *   walking its non-function members, so a nested data record inside one is
 *   probed like any other. `the walker walks PAST a port's methods` below
 *   measures it on a synthetic hybrid, because no fixture here is one: the only
 *   hybrids the fixtures contain (`BOOK_PORT`) carry PRIMITIVE data members, and
 *   a primitive holds no position the hostility classes could be planted at.
 * - a CLASS INSTANCE — a non-plain prototype; `plain.ts` refuses those as data
 *   by policy, so a door cannot be asked to materialize one;
 * - anything the door declares in {@link RecordDoor.notData}, with its reason.
 *
 * A data member added to a fixture is therefore probed without anyone
 * remembering to list it.
 *
 * DISCLOSED LIMIT (round-4 review NOTE-1): the walk is over the positions a
 * fixture INSTANTIATES. Where a field is a UNION with a record arm and the
 * fixture uses the primitive arm — `sameInstantAdditions: "NOT_OBSERVED"` — the
 * record arm yields no position, so nothing probes it. That is closed HERE by
 * fixture rather than by machinery: every union in these fixtures with a record
 * arm has a SECOND-ARM entry in {@link RECORD_DOORS} (`… (observed additions
 * arm)`), and `every union with a record arm has a second-arm fixture` below
 * fails if a first-arm-only union is added. The reviewer's own round-4 probe of
 * the gap — `{ observedShares: <cyclic> }` at `simulateResting` — was REFUSED,
 * so the gap was in the MEASUREMENT, not in the door; the second-arm entries
 * make that mechanical.
 */
function deriveRecordPaths(door: RecordDoor): readonly RecordPath[] {
  const paths: RecordPath[] = [];
  const notData = door.notData ?? {};
  const walk = (value: unknown, path: RecordPath): void => {
    if (value === null || typeof value !== "object") return;
    if (path.length > 0 && Object.hasOwn(notData, path.join("."))) return;
    const prototype: unknown = Object.getPrototypeOf(value);
    const isArray = Array.isArray(value);
    if (prototype !== null && prototype !== (isArray ? Array.prototype : Object.prototype)) return;
    const isPort = Object.keys(value).some(
      (key) => typeof (value as Record<string, unknown>)[key] === "function",
    );
    // A PORT is not a data position — but its DATA members still are.
    if (!isPort && (path.length > 0 || door.argumentIsData)) paths.push(path);
    if (isArray) {
      // The first element stands for the array: planting into it is nesting.
      walk((value as unknown[])[0], [...path, "0"]);
      return;
    }
    for (const key of Object.keys(value)) {
      const member: unknown = (value as Record<string, unknown>)[key];
      if (typeof member === "function") continue; // a METHOD is not data
      walk(member, [...path, key]);
    }
  };
  walk(door.valid(), []);
  return paths;
}

// --- fixtures the doors below need -----------------------------------------

const FEE_SNAPSHOT = (): Record<string, unknown> => ({
  snapshotVersion: "fees/2026-08-24",
  takerFeeRate: "0.07",
  makerFeeRate: "0",
  roundingDecimalPlaces: 5,
  roundingMode: "HALF_UP",
  minimumChargedFee: "0.00001",
  feeCurrency: "USDC",
});

const QUEUE_PARAMETERS = (): Record<string, unknown> => ({
  queueModelVersion: "sim/queue/v1",
  cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
  cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
  placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
});

const LATENCY_MODEL = (): Record<string, unknown> => ({
  latencyModelVersion: "sim/latency/v1",
  decision: { samples: [{ milliseconds: 1, weight: 1 }] },
  signing: { samples: [{ milliseconds: 1, weight: 1 }] },
  network: { samples: [{ milliseconds: 1, weight: 1 }] },
  venue: { samples: [{ milliseconds: 1, weight: 1 }] },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
});

const AT_EVENT = (): Record<string, unknown> => ({
  gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
  ingestSeq: "1",
  receivedAt: "2026-01-01T00:00:00.000Z",
  datasetRowOrdinal: 0,
});

const TIER_0_MODEL = (): Record<string, unknown> => ({
  ...tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) }),
});

const TIER_1_MODEL = (): Record<string, unknown> => ({
  ...tier1Model({ fillModelVersion: "sim/tier1/v1", fillModelParametersHash: "0".repeat(64) }),
});

const RESTING_ORDER = (): Record<string, unknown> => ({
  simulatedOrderId: "o-1",
  marketId: "m-1",
  tokenId: "1234",
  side: "YES",
  action: "BUY",
  restingPrice: "0.5",
  shares: "50",
  queueAheadAtPlacement: "10",
  sameInstantAdditions: "NOT_OBSERVED",
  restingFromNs: 1000n,
});

/**
 * The SECOND ARM of the one union in these fixtures that has a record arm
 * (round-4 review, NOTE-1).
 *
 * `SameInstantAdditions` is `"NOT_OBSERVED" | { observedShares }`. The fixture
 * above instantiates the PRIMITIVE arm, and the walker can only derive
 * positions a fixture instantiates, so nothing probed the record arm — the
 * record a door reads `observedShares` out of. This one instantiates it, and the
 * doors that take it are entered TWICE in {@link RECORD_DOORS}, once per arm.
 */
const RESTING_ORDER_OBSERVED_ARM = (): Record<string, unknown> => ({
  ...RESTING_ORDER(),
  sameInstantAdditions: { observedShares: "5" },
});

const OBSERVED_TRADE = (): Record<string, unknown> => ({
  price: "0.5",
  shares: "40",
  monotonicNs: 2000n,
  atEvent: AT_EVENT(),
});

const SIMULATED_FILL = (): Record<string, unknown> => ({
  simulatedFillId: "f-1",
  simulatedOrderId: "o-1",
  marketId: "m-1",
  tokenId: "1234",
  side: "YES",
  action: "BUY",
  price: "0.5",
  shares: "10",
  feeAmount: "0",
  liquidityRole: "TAKER",
  evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE",
  fillModelVersion: "sim/tier0/v1",
  model: TIER_0_MODEL(),
  planningDepthAwareness: "TOP_OF_BOOK_ONLY",
  atEvent: AT_EVENT(),
});

const MARKOUT_DIAGNOSTIC = (): Record<string, unknown> => ({
  simulatedFillId: "f-1",
  role: "DIAGNOSTIC_ONLY",
  appliedToReplayEconomics: false,
  observations: [
    { horizon: "1s", referencePrice: "0.4", perShare: "-0.1", total: "-1", atEvent: AT_EVENT() },
  ],
  note: "n",
});

/** A VALID band, built by the door that builds bands. */
function validBand(): Record<string, unknown> {
  return bandFrom(RESTING_ORDER());
}

/** The same band, built from the union's RECORD arm (round-4 review, NOTE-1). */
function validBandObservedArm(): Record<string, unknown> {
  return bandFrom(RESTING_ORDER_OBSERVED_ARM());
}

function bandFrom(order: Record<string, unknown>): Record<string, unknown> {
  const built = simulateResting({
    model: TIER_1_MODEL() as never,
    order: order as never,
    trades: [OBSERVED_TRADE()] as never,
    parameters: QUEUE_PARAMETERS() as never,
    feeSnapshot: FEE_SNAPSHOT() as never,
  });
  if (!built.ok) throw new Error(`the band fixture is not valid: ${built.refusal.message}`);
  return JSON.parse(JSON.stringify(built.value, bigintSafe)) as Record<string, unknown>;
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

const BOOK_PORT = {
  internalMarketId: "m-1",
  tokenId: "1234",
  top: () => ({}),
  ladder: () => [{ price: "0.5", size: "100" }],
};

/**
 * Every door whose argument carries a caller-supplied DATA RECORD, with a VALID
 * example and the PATH to each record it is claimed to materialize.
 *
 * The battery above proves no throw escapes; these prove the stronger property
 * the fixes are actually about: each of these doors materializes the record
 * FIRST, so a cycle is REFUSED (typed) rather than followed until the stack runs
 * out, a getter is REFUSED WITHOUT BEING INVOKED — at any depth — and the value
 * it hands back is its own frozen tree rather than an alias of the caller's.
 *
 * Measured before the fixes: at `52a058b` the read* doors THREW
 * `RangeError: Maximum call stack size exceeded` on a cyclic argument; at
 * `b0aeb28` `simulateResting` re-read `order.queueAheadAtPlacement` four times
 * (an accessor answering `"10"` then `"0"` produced an ACCEPTED band with
 * `queueAhead=0`), `checkBandOrdering` returned the caller's unfrozen object (an
 * accessor honest for the check and lying afterwards serialized
 * `conservative[ filled=999 remaining=0 … ]` on a 50-share order),
 * `tier0Immediate` answered `SIMULATION_INTERNAL`, and `replayPathEconomics`
 * ACCEPTED an accessor-bearing fill with the getter invoked.
 */
const RECORD_DOORS: readonly RecordDoor[] = [
  {
    id: "readQueueModelParameters",
    name: "readQueueModelParameters",
    valid: QUEUE_PARAMETERS,
    argumentIsData: true,
    drive: (value) => readQueueModelParameters(value as QueueModelParameters),
  },
  {
    id: "readLatencyDistribution",
    name: "readLatencyDistribution",
    valid: () => ({ samples: [{ milliseconds: 1, weight: 1 }] }),
    argumentIsData: true,
    drive: (value) => readLatencyDistribution(value as LatencyDistribution, "decision"),
  },
  {
    id: "readLatencyModel",
    name: "readLatencyModel",
    valid: LATENCY_MODEL,
    argumentIsData: true,
    drive: (value) => readLatencyModel(value as LatencyModel),
  },
  {
    id: "readFeeScheduleSnapshot",
    name: "readFeeScheduleSnapshot",
    valid: FEE_SNAPSHOT,
    argumentIsData: true,
    drive: (value) => readFeeScheduleSnapshot(value as FeeScheduleSnapshot),
  },
  {
    id: "readRunPins",
    name: "readRunPins",
    valid: () => runPins(),
    argumentIsData: true,
    drive: (value) => readRunPins(value as ReplayRunPins),
  },
  {
    id: "readSameInstantAdditions",
    name: "readSameInstantAdditions",
    valid: () => ({ observedShares: "0" }),
    argumentIsData: true,
    drive: (value) => readSameInstantAdditions(value as never),
  },
  {
    id: "simulateResting",
    name: "simulateResting",
    valid: () => ({
      model: TIER_1_MODEL(),
      order: RESTING_ORDER(),
      trades: [OBSERVED_TRADE()],
      parameters: QUEUE_PARAMETERS(),
      feeSnapshot: FEE_SNAPSHOT(),
    }),
    argumentIsData: false,
    drive: (value) => simulateResting(value as never),
  },
  {
    id: "simulateResting (observed same-instant additions arm)",
    name: "simulateResting",
    valid: () => ({
      model: TIER_1_MODEL(),
      order: RESTING_ORDER_OBSERVED_ARM(),
      trades: [OBSERVED_TRADE()],
      parameters: QUEUE_PARAMETERS(),
      feeSnapshot: FEE_SNAPSHOT(),
    }),
    argumentIsData: false,
    drive: (value) => simulateResting(value as never),
  },
  {
    id: "checkBandOrdering",
    name: "checkBandOrdering",
    valid: validBand,
    argumentIsData: true,
    drive: (value) => checkBandOrdering(value as never),
  },
  {
    id: "checkBandOrdering (observed same-instant additions arm)",
    name: "checkBandOrdering",
    valid: validBandObservedArm,
    argumentIsData: true,
    drive: (value) => checkBandOrdering(value as never),
  },
  {
    id: "quoteForDeploymentDecision",
    name: "quoteForDeploymentDecision",
    valid: validBand,
    argumentIsData: true,
    drive: (value) => quoteForDeploymentDecision(value as never),
  },
  {
    id: "replayPathEconomics",
    name: "replayPathEconomics",
    valid: () => [SIMULATED_FILL()],
    argumentIsData: true,
    drive: (value) => replayPathEconomics(value as never),
  },
  {
    id: "computeFee",
    name: "computeFee",
    valid: () => ({
      shares: "10",
      price: "0.5",
      liquidityRole: "TAKER",
      snapshot: FEE_SNAPSHOT(),
    }),
    argumentIsData: false,
    drive: (value) => computeFee(value as never),
  },
  {
    id: "consumeDepth",
    name: "consumeDepth",
    valid: () => ({
      ladder: [{ price: "0.5", size: "100" }],
      action: "BUY",
      limitPrice: "0.6",
      shares: "10",
    }),
    argumentIsData: false,
    drive: (value) => consumeDepth(value as never),
  },
  {
    id: "sizeAtPrice",
    name: "sizeAtPrice",
    valid: () => [{ price: "0.5", size: "100" }],
    argumentIsData: true,
    drive: (value) => sizeAtPrice(value as never, "0.5"),
  },
  {
    id: "tier0Immediate",
    name: "tier0Immediate",
    valid: () => ({
      model: TIER_0_MODEL(),
      book: BOOK_PORT,
      simulatedOrderId: "o-1",
      marketId: "m-1",
      side: "YES",
      action: "BUY",
      limitPrice: "0.6",
      shares: "10",
      feeSnapshot: FEE_SNAPSHOT(),
      atEvent: AT_EVENT(),
    }),
    argumentIsData: false,
    drive: (value) => tier0Immediate(value as never),
  },
  {
    id: "tier0Maker",
    name: "tier0Maker",
    valid: () => ({
      model: TIER_0_MODEL(),
      simulatedOrderId: "o-1",
      marketId: "m-1",
      tokenId: "1234",
      side: "YES",
      action: "BUY",
      restingPrice: "0.5",
      remainingShares: "10",
      observedTradePrice: "0.5",
      feeSnapshot: FEE_SNAPSHOT(),
      atEvent: AT_EVENT(),
    }),
    argumentIsData: false,
    drive: (value) => tier0Maker(value as never),
  },
  {
    id: "tier1Immediate",
    name: "tier1Immediate",
    valid: () => ({
      model: TIER_1_MODEL(),
      timeline: {
        bookAt: () => ({ book: BOOK_PORT, atEvent: AT_EVENT() }),
      },
      latencyModel: LATENCY_MODEL(),
      streams: deriveStreams("42"),
      simulatedOrderId: "o-1",
      marketId: "m-1",
      side: "YES",
      action: "BUY",
      limitPrice: "0.6",
      shares: "10",
      timeInForce: "GTC",
      postOnly: false,
      submittedAtNs: 1000n,
      market: {
        marketId: "m-1",
        tickSize: "0.01",
        minimumOrderSize: "1",
        secondsDelay: 0,
        parametersVersion: 1,
      },
      feeSnapshot: FEE_SNAPSHOT(),
    }),
    argumentIsData: false,
    notData: {
      streams:
        "SeededStream INSTANCES — a stream is code with state (its position advances), not data",
    },
    drive: (value) => tier1Immediate(value as never),
  },
  {
    id: "computeMarkouts",
    name: "computeMarkouts",
    valid: () => ({
      fill: SIMULATED_FILL(),
      filledAtNs: 1000n,
      midTimeline: { midAt: () => ({ mid: "0.4", atEvent: AT_EVENT() }) },
      resolutionValuePerShare: "1",
      horizons: [{ label: "1s", milliseconds: 1000 }],
    }),
    argumentIsData: false,
    drive: (value) => computeMarkouts(value as never),
  },
  {
    id: "markoutStressScenario",
    name: "markoutStressScenario",
    valid: () => ({
      scenarioName: "s",
      horizon: "1s",
      fills: [SIMULATED_FILL()],
      diagnostics: [MARKOUT_DIAGNOSTIC()],
    }),
    argumentIsData: false,
    drive: (value) => markoutStressScenario(value as never),
  },
  {
    id: "createReplayClock",
    name: "createReplayClock",
    valid: () => ({ receivedAt: "2026-01-01T00:00:00.000Z", receivedMonotonicNs: "1000" }),
    argumentIsData: true,
    drive: (value) => createReplayClock(value as never),
  },
  {
    id: "deriveReplayEventId",
    name: "deriveReplayEventId",
    valid: () => ({
      gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
      ingestSeq: "1",
      receivedAt: "2026-01-01T00:00:00.000Z",
      index: 0,
    }),
    argumentIsData: true,
    drive: (value) => deriveReplayEventId(sha256Hex, value as never),
  },
  {
    id: "reconcileRunPins (the run's pin set)",
    name: "reconcileRunPins",
    valid: () => runPins(),
    argumentIsData: true,
    drive: (value) => reconcileRunPins(manifestFixture(), value as ReplayRunPins),
  },
  {
    id: "reconcileRunPins (the manifest's pins)",
    name: "reconcileRunPins",
    valid: () => ({ pins: manifestPinsFixture() }),
    argumentIsData: false,
    drive: (value) => reconcileRunPins(value as never, runPins()),
  },

  // --- CLASS MEMBERS (round-4 review, MEDIUM-2) -----------------------------
  //
  // The partition used to stop at exported FUNCTIONS, so every method of
  // `SimulatedVenue` / `ReplayClock` / `DatasetEventSource` / `SeededStream` sat
  // outside it: the reviewer added an unclassified caller-record method to
  // `SimulatedVenue` and it survived the entire suite. The four below are the
  // members that take a caller DATA record, and they are subscribed to exactly
  // the same nested battery as every exported record door.
  {
    id: "SimulatedVenue.observe",
    name: "SimulatedVenue",
    member: "observe",
    valid: AT_EVENT,
    argumentIsData: true,
    drive: (value) => probeVenue().observe(value as never),
  },
  {
    id: "SimulatedVenue.observeTrade",
    name: "SimulatedVenue",
    member: "observeTrade",
    valid: () => ({
      marketId: "m-1",
      side: "YES",
      price: "0.5",
      shares: "10",
      monotonicNs: 2000n,
      atEvent: AT_EVENT(),
    }),
    argumentIsData: true,
    drive: (value) => probeVenue().observeTrade(value as never),
  },
  {
    id: "SimulatedVenue.submit",
    name: "SimulatedVenue",
    member: "submit",
    valid: PLACEMENT_PLAN,
    argumentIsData: true,
    // ADAPTER: `submit` answers an `ExecutionResult`, never a `SimulationResult`,
    // because ADR-020 §6's bound has to be honoured by REFUSING rather than by
    // rejecting. Its refusal fields are mapped onto the battery's shape here, so
    // the battery measures the venue's own answer rather than a proxy for it.
    drive: async (value) => executionResultAsResult(await probeVenue().submit(value as never)),
  },
  {
    id: "SimulatedVenue.submitAll",
    name: "SimulatedVenue",
    member: "submitAll",
    valid: () => [PLACEMENT_PLAN()],
    // The argument is a LIST, not a record: each PLAN in it is the caller data
    // record, and `submit` materializes each one. The batch's own read of the
    // caller is the scheduling PRIORITY, taken once per plan through a total
    // guard — measured by `a batch schedules on a priority it read once` below.
    argumentIsData: false,
    // ADAPTER: a batch is refused when ANY of its results is, so a hostile plan
    // planted beside a valid one cannot pass by hiding behind the valid one.
    drive: async (value) => {
      const results = await probeVenue().submitAll(value as never);
      for (const result of results) {
        const mapped = executionResultAsResult(result);
        if (!mapped.ok) return mapped;
      }
      return simulationOk(results);
    },
  },
  {
    id: "SimulatedVenue.cancel",
    name: "SimulatedVenue",
    member: "cancel",
    valid: () => ({
      executionPlanId: "plan-1",
      reason: "kill switch",
      scope: { orderIds: ["o-1"] },
      priority: "SAFETY_CANCEL",
    }),
    argumentIsData: true,
    // ADAPTER: `CancelResult` carries no refusal field, so an unreadable command
    // is reported the way §6 invariant 13 requires — nothing cancelled, and the
    // reason in `notCancelled` under the venue's own marker id. Only that marker
    // is read as a refusal: "order id `o-1` is unknown to this venue" is a
    // perfectly good CANCEL RESULT and must not be mistaken for an input refusal.
    drive: async (value) => cancelResultAsResult(await probeVenue().cancel(value as never)),
  },
];

/**
 * A venue with every option the probes above need, positioned at nothing.
 *
 * Freshly built per drive, because these doors MUTATE: a venue that already
 * knows `o-1` refuses the second submission of it (§6 invariant 6), which would
 * make every probe after the first refuse for the wrong reason.
 */
function probeVenue(): SimulatedVenue {
  const clock = createReplayClock({
    receivedAt: "2026-01-01T00:00:00.000Z",
    receivedMonotonicNs: "1000",
  });
  if (!clock.ok) throw new Error("the probe clock refused");
  const venue = new SimulatedVenue({
    clock: clock.value,
    runMode: "BACKTEST",
    model: tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) }),
    feeSnapshot: FEE_SNAPSHOT() as never,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: {
      timeInForceFor: () => "GTC",
      statedExpiryNsFor: () => undefined,
      sameInstantAdditionsFor: () => "NOT_OBSERVED",
    },
    startingCash: "1000",
    books: { book: () => BOOK_PORT as never },
  });
  // POSITIONED: the venue refuses to produce anything anchored to no recorded
  // event, so a probe against an unpositioned one would measure that refusal
  // instead of the door under test.
  const positioned = venue.observe(AT_EVENT() as never);
  if (!positioned.ok) throw new Error(`the probe venue refused its own identity: ${positioned.refusal.message}`);
  return venue;
}

/** A valid placement plan for the venue above: one non-crossing resting order. */
function PLACEMENT_PLAN(): Record<string, unknown> {
  return {
    executionPlanId: "plan-1",
    runMode: "BACKTEST",
    planKind: "POSITION",
    priority: "PLACEMENT",
    groups: [
      {
        marketId: "m-1",
        orders: [
          {
            plannedOrderId: "o-1",
            side: "YES",
            action: "BUY",
            limitPrice: "0.4",
            shares: "10",
            postOnly: true,
            executionStyle: "REST",
          },
        ],
      },
    ],
  };
}

function executionResultAsResult(result: {
  readonly accepted: boolean;
  readonly refusalCode?: string;
  readonly refusalMessage?: string;
}): SimulationResult<unknown> {
  if (result.accepted) return simulationOk(result);
  return simulationFailure(
    (result.refusalCode ?? "SIMULATION_INTERNAL") as never,
    result.refusalMessage ?? "the venue refused without saying why",
  );
}

/** The venue's own marker for "the command could not be read as data". */
const UNREADABLE_COMMAND = "(the command could not be read)";

function cancelResultAsResult(result: {
  readonly notCancelled: readonly { readonly simulatedOrderId: string; readonly reason: string }[];
}): SimulationResult<unknown> {
  const unreadable = result.notCancelled.find(
    (entry) => entry.simulatedOrderId === UNREADABLE_COMMAND,
  );
  if (unreadable === undefined) return simulationOk(result);
  const [code, ...rest] = unreadable.reason.split(": ");
  return simulationFailure((code ?? "SIMULATION_INTERNAL") as never, rest.join(": "));
}

function manifestPinsFixture(): Record<string, unknown> {
  const pins = runPins();
  return {
    normalizerVersion: pins.normalizerVersion,
    featureSetVersion: pins.featureSetVersion,
    runSeed: pins.runSeed,
    fillModelVersion: pins.fillModelVersion,
    latencyModelVersion: pins.latencyModelVersion,
    feeSnapshotVersion: pins.feeSnapshotVersion,
    rewardSnapshotVersion: pins.rewardSnapshotVersion,
    settlementSpecVersions: [...pins.settlementSpecVersions],
  };
}

function manifestFixture(): never {
  return { pins: manifestPinsFixture() } as never;
}

/**
 * Doors that take NO caller data record, and what their argument is instead.
 *
 * `plain.ts`'s rule is about DATA. A port's contract IS its methods, a function
 * cannot be copied, and bytes are read by `strict-json.ts` — which is itself the
 * D1 reader and builds a prototype-free tree as it parses. Each entry states
 * which of those it is, so the classification is a claim a reviewer can check
 * rather than a place to hide a door.
 */
const NON_RECORD_DOORS: Readonly<Record<string, string>> = Object.freeze({
  decodeUtf8Strict: "BYTES — a Uint8Array; there is no record to materialize",
  encodeUtf8Strict: "a PRIMITIVE string",
  loadDataset:
    "an options bag of PORTS and FUNCTIONS (archive reader, SHA-256 digest); its `dataset` is the OUTPUT of `readDatasetManifestText`, and every decoded row goes through `materializeInput` in `event-source.ts`",
  materializeInput: "IS D1 — the reader every other door's record goes through",
  parseStrictJsonBytes: "BYTES — the ADR-017 §3 reader; it BUILDS a prototype-free tree as it parses",
  parseStrictJsonText: "TEXT — as above",
  readDatasetManifestBytes: "BYTES — read by `parseStrictJsonBytes`, then validated field by field",
  readDatasetManifestText: "TEXT — as above",
  readRoundingMode: "a PRIMITIVE — one member of a closed vocabulary",
  roundDecimal: "PRIMITIVES — a decimal string, a place count and a rounding mode",
  runEventSource:
    "an options bag of PORTS (event source, normalizer, clock) and FUNCTIONS; the rows are materialized in `event-source.ts`",
  runReplay:
    "an options bag of PORTS and FUNCTIONS (dataset archive, digest, normalizer, core loop); every record it produces is emitted by a door in this table",
  sumFees: "an array of PRIMITIVE amounts, each read once and validated before it is added",
  totally: "a label and a FUNCTION — the totality guard itself",
});

// ---------------------------------------------------------------------------
// The partition, extended to CLASS MEMBERS (round-4 review, MEDIUM-2)
// ---------------------------------------------------------------------------

/**
 * The five buckets a public class member may be in.
 *
 * `RECORD DOOR` is the only one that is not self-describing: it is a CLAIM that
 * the member is entered in {@link RECORD_DOORS}, and the partition test below
 * checks it, so tagging a method `RECORD DOOR` subscribes it to the whole nested
 * hostility battery rather than exempting it.
 */
const MEMBER_BUCKETS = [
  "RECORD DOOR",
  "ONE-READ DOOR",
  "NON-RECORD DOOR",
  "PORT ANSWER",
  "PURE HELPER",
] as const;

/**
 * Every public member of every exported CLASS, classified.
 *
 * WHY THIS EXISTS. Round-4 review MEDIUM-2: the partition covered exported
 * FUNCTIONS and explicitly filtered class constructors out, so every method of
 * `SimulatedVenue`, `ReplayClock`, `DatasetEventSource` and `SeededStream` was
 * outside it. The reviewer ADDED an unclassified caller-record method to
 * `SimulatedVenue` and it survived all 5268 tests. The table below is walked
 * against the real prototypes and statics, so the same mutation now fails BY
 * NAME.
 *
 * THE BUCKETS, and what each one asserts:
 *
 * - **RECORD DOOR** — takes a caller DATA record, materializes it before
 *   validating or computing, and is driven by the nested battery.
 * - **ONE-READ DOOR** — takes a caller record and does NOT materialize it,
 *   because it runs once per delivered event and a copy per event is the cost
 *   the design refuses. It reads each PRIMITIVE field exactly once into a local
 *   and is totality-guarded. There is exactly ONE, and its two properties are
 *   probed by name below.
 * - **NON-RECORD DOOR** — its argument is a PORT, a FUNCTION, BYTES, a
 *   PRIMITIVE, or a value this package itself built.
 * - **PORT ANSWER** — takes NO caller argument: a getter or a nullary method
 *   over the object's own state. Nothing to materialize; the claim is that it is
 *   TOTAL and hands out no alias of live internal state.
 * - **PURE HELPER** — answers a VALUE rather than `{ ok }`, with the door that
 *   validated what reaches it named.
 */
const CLASS_MEMBERS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  SimulatedVenue: Object.freeze({
    fills: "PORT ANSWER — no argument; answers a FROZEN COPY of the retained fill list, never the live log",
    atEvent: "PORT ANSWER — no argument; answers the materialized identity `observe` stored",
    ordersSnapshot:
      "PORT ANSWER — no argument; a fresh array of frozen orders (live ∪ retained terminal), ordered by id",
    restingBands: "PORT ANSWER — no argument; a fresh array of the frozen LIVE bands, ordered by id",
    bandHistory:
      "PORT ANSWER — no argument; a fresh array of frozen bands (live ∪ retained terminal), ordered by id (SIM-2)",
    retention: "PORT ANSWER — no argument; a frozen prototype-free counter record (SIM-2)",
    fillsSince:
      "NON-RECORD DOOR — a PRIMITIVE sequence; totality-guarded, refuses a non-safe-integer, future or evicted sequence by name, and answers a frozen prototype-free page (SIM-2)",
    orderById:
      "NON-RECORD DOOR — a PRIMITIVE id; a non-string answers undefined; answers the stored frozen order this package built (SIM-2)",
    orderByPlannedId:
      "NON-RECORD DOOR — a PRIMITIVE id; a non-string answers undefined; answers the stored frozen order this package built (SIM-2)",
    acknowledgeTerminal:
      "NON-RECORD DOOR — a PRIMITIVE id; a non-string, live, unknown or already-acknowledged id answers false and changes nothing; answers a boolean (SIM-2 r1)",
    observe: "RECORD DOOR",
    observeTrade: "RECORD DOOR",
    submit: "RECORD DOOR",
    submitAll: "RECORD DOOR",
    cancel: "RECORD DOOR",
    queryAccountState:
      "PORT ANSWER — no argument; totality-guarded, and every member of the snapshot is a tree this package built",
  }),
  ReplayClock: Object.freeze({
    now: "PORT ANSWER — no argument; the recorded instant the clock is positioned at",
    monotonicNs: "PORT ANSWER — no argument",
    epochMilliseconds: "PORT ANSWER — no argument; derived arithmetically, never parsed",
    observations: "PORT ANSWER — no argument; a frozen prototype-free diagnostic record",
    advanceTo: "ONE-READ DOOR",
    positionedAt:
      "PURE HELPER — three validated PRIMITIVES; `createReplayClock` is the door that validated them",
  }),
  DatasetEventSource: Object.freeze({
    clock: "PORT ANSWER — no argument; the `ReplayClock` this source drives, which is itself a port",
    loaded: "PORT ANSWER — no argument; the verified dataset this package built",
    refusal: "PORT ANSWER — no argument; the frozen refusal that ended iteration, if any",
    report: "PORT ANSWER — no argument; a frozen prototype-free counter record",
    events: "PORT ANSWER — no argument; the §12.1 stream itself",
    identityOf:
      "PURE HELPER — a `ReplayRecord` this package BUILT (`loadDataset` materializes every decoded row and emits it frozen); it answers a value, not `{ ok }`",
    create:
      "NON-RECORD DOOR — a `LoadedDataset` this package built and a NORMALIZER port, whose contract is its `normalize` method",
  }),
  SeededStream: Object.freeze({
    draws: "PORT ANSWER — no argument; the draw counter",
    nextUint64: "PORT ANSWER — no argument; the next draw",
    nextBelow:
      "PURE HELPER — a PRIMITIVE `bigint` bound; its caller is `sampleLatency`, over a distribution `readLatencyModel` validated",
  }),
});

describe("the record-door table is DERIVED, not maintained (round-3 review, LOW-1)", () => {
  it("partitions the whole export surface: a tenth door cannot be added unclassified", () => {
    // THE MECHANISM. Round 3: the old table was hand-written and checked by
    // list equality against five names, so nothing detected a tenth door — the
    // four the review found were doors nobody had listed. Here the three lists
    // must PARTITION the exported functions exactly:
    //
    //   record doors  ∪  non-record doors  ∪  pure helpers  =  every export
    //
    // so a new export fails this test until it is classified, and classifying
    // it as a record door subscribes it to the whole nested battery below.
    const exported = simulation as unknown as Record<string, unknown>;
    const functions = Object.keys(exported)
      .filter((name) => typeof exported[name] === "function")
      .filter(
        (name) => !/^class[\s{]/u.test(Function.prototype.toString.call(exported[name])),
      )
      .sort();

    const recordDoorNames = new Set(
      // The class-member entries are partitioned by CLASS_MEMBERS below, against
      // the real prototypes, rather than against the exported-function list.
      RECORD_DOORS.filter((door) => door.member === undefined).map((door) => door.name),
    );
    const nonRecordDoorNames = new Set(Object.keys(NON_RECORD_DOORS));
    const pureHelperNames = new Set(Object.keys(PURE_HELPERS));

    const unclassified: string[] = [];
    const doubleClassified: string[] = [];
    for (const name of functions) {
      const memberships = [
        recordDoorNames.has(name) ? "record door" : undefined,
        nonRecordDoorNames.has(name) ? "non-record door" : undefined,
        pureHelperNames.has(name) ? "pure helper" : undefined,
      ].filter((entry): entry is string => entry !== undefined);
      if (memberships.length === 0) unclassified.push(name);
      if (memberships.length > 1) doubleClassified.push(`${name}: ${memberships.join(" and ")}`);
    }
    expect(
      unclassified,
      `these exports are classified nowhere — add each to RECORD_DOORS with a valid example (which subscribes it to the hostility battery), or to NON_RECORD_DOORS / PURE_HELPERS with the reason:\n${unclassified.join("\n")}`,
    ).toEqual([]);
    expect(doubleClassified, doubleClassified.join("\n")).toEqual([]);

    // …and no list carries a name that is no longer exported.
    const stale: string[] = [];
    for (const [label, names] of [
      ["RECORD_DOORS", recordDoorNames],
      ["NON_RECORD_DOORS", nonRecordDoorNames],
      ["PURE_HELPERS", pureHelperNames],
    ] as const) {
      for (const name of names) {
        if (!functions.includes(name)) stale.push(`${label} lists ${name}, which is not exported`);
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("derives at least one record position for every record door", () => {
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      const paths = deriveRecordPaths(door);
      if (paths.length === 0) faults.push(`${door.id}: the walker found no data position`);
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });

  it("every declared non-data member is a real member, with a reason", () => {
    // The one hand-maintained part is kept honest: a `notData` entry naming a
    // member the fixture no longer has would silently stop excluding anything.
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      for (const [path, reason] of Object.entries(door.notData ?? {})) {
        if (reason.trim() === "") faults.push(`${door.id}: ${path} has no reason`);
        if (navigate(door.valid(), path.split(".")) === undefined) {
          faults.push(`${door.id}: notData names ${path}, which the fixture does not have`);
        }
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });

  it("the walker walks PAST a port's methods into its data (round-4 review, NOTE-2)", () => {
    // The mechanism, measured on a SYNTHETIC hybrid, because no fixture here is
    // one: `BOOK_PORT` carries methods beside PRIMITIVE data, and a primitive
    // holds no position a hostility class could be planted at. Before the fix the
    // walker `return`ed at the first function-valued member and the whole subtree
    // — including `hybrid.nested` — was silently unprobed.
    const hybrid: RecordDoor = {
      id: "synthetic hybrid",
      name: "synthetic",
      valid: () => ({
        port: {
          method: () => undefined,
          identity: "a primitive, which yields no position",
          nested: { deeper: { leaf: 1 } },
        },
        plain: { leaf: 1 },
      }),
      argumentIsData: false,
      drive: () => simulationOk(null),
    };
    const derived = deriveRecordPaths(hybrid).map(describePath);
    // The PORT itself is not a data position…
    expect(derived).not.toContain("port");
    // …and its data subtree is.
    expect(derived).toContain("port.nested");
    expect(derived).toContain("port.nested.deeper");
    expect(derived).toContain("plain");
  });

  it("every union with a record arm has a second-arm fixture (round-4 review, NOTE-1)", () => {
    // The walker can only derive positions a fixture INSTANTIATES, so a union
    // whose record arm is never built is never probed. `SameInstantAdditions` is
    // the only such union in these fixtures; both arms are entered, and the
    // record arm really does yield a derived position (otherwise the second entry
    // would be a duplicate of the first and would measure nothing).
    const firstArm = RECORD_DOORS.find((door) => door.id === "simulateResting");
    const secondArm = RECORD_DOORS.find(
      (door) => door.id === "simulateResting (observed same-instant additions arm)",
    );
    expect(firstArm, "the first-arm entry disappeared").toBeDefined();
    expect(secondArm, "the second-arm entry disappeared").toBeDefined();
    if (firstArm === undefined || secondArm === undefined) return;
    const first = deriveRecordPaths(firstArm).map(describePath);
    const second = deriveRecordPaths(secondArm).map(describePath);
    expect(first).not.toContain("order.sameInstantAdditions");
    expect(second).toContain("order.sameInstantAdditions");

    const bandArm = RECORD_DOORS.find(
      (door) => door.id === "checkBandOrdering (observed same-instant additions arm)",
    );
    expect(bandArm, "the band's second-arm entry disappeared").toBeDefined();
    if (bandArm === undefined) return;
    expect(deriveRecordPaths(bandArm).map(describePath)).toContain("sameInstantAdditions");
  });
});

// ---------------------------------------------------------------------------
// The partition, over CLASS MEMBERS (round-4 review, MEDIUM-2)
// ---------------------------------------------------------------------------

/** Every public member of one exported class, as the runtime really has them. */
function publicMembersOf(constructor: unknown): readonly string[] {
  const value = constructor as { readonly prototype: object };
  const statics = Object.getOwnPropertyNames(constructor).filter(
    (key) => !["length", "name", "prototype"].includes(key),
  );
  const members = Object.getOwnPropertyNames(value.prototype).filter((key) => key !== "constructor");
  return [...statics, ...members].sort();
}

/** Every exported CLASS, by export name. */
function exportedClasses(): readonly (readonly [string, unknown])[] {
  const exported = simulation as unknown as Record<string, unknown>;
  return Object.keys(exported)
    .filter(
      (name) =>
        typeof exported[name] === "function" &&
        /^class[\s{]/u.test(Function.prototype.toString.call(exported[name])),
    )
    .sort()
    .map((name) => [name, exported[name]] as const);
}

describe("the partition covers CLASS MEMBERS too (round-4 review, MEDIUM-2)", () => {
  it("classifies every public member of every exported class", () => {
    // THE MUTATION THIS CATCHES, by name: the reviewer added a caller-record
    // method to `SimulatedVenue` and it survived all 5268 tests, because the
    // partition filtered class constructors out and stopped at exported
    // FUNCTIONS. Every prototype member and every static of every exported class
    // is now walked against CLASS_MEMBERS.
    const unclassified: string[] = [];
    const badBucket: string[] = [];
    const stale: string[] = [];
    let membersChecked = 0;

    for (const [className, constructor] of exportedClasses()) {
      const declared = CLASS_MEMBERS[className];
      if (declared === undefined) {
        unclassified.push(`${className}: the whole class is classified nowhere`);
        continue;
      }
      const actual = publicMembersOf(constructor);
      for (const member of actual) {
        membersChecked += 1;
        const bucket = declared[member];
        if (bucket === undefined) {
          unclassified.push(`${className}.${member}`);
          continue;
        }
        if (!MEMBER_BUCKETS.some((known) => bucket.startsWith(known))) {
          badBucket.push(`${className}.${member}: "${bucket}" names no known bucket`);
        }
      }
      for (const member of Object.keys(declared)) {
        if (!actual.includes(member)) {
          stale.push(`CLASS_MEMBERS lists ${className}.${member}, which the class does not have`);
        }
      }
    }
    // Every class in the table is a class the package still exports.
    const classNames = exportedClasses().map(([name]) => name);
    for (const className of Object.keys(CLASS_MEMBERS)) {
      if (!classNames.includes(className)) {
        stale.push(`CLASS_MEMBERS lists ${className}, which is not an exported class`);
      }
    }

    expect(
      unclassified,
      `these public class members are classified nowhere — add each to CLASS_MEMBERS as a RECORD DOOR (which subscribes it to the nested hostility battery via RECORD_DOORS), or as a ONE-READ DOOR / NON-RECORD DOOR / PORT ANSWER / PURE HELPER with the reason:\n${unclassified.join("\n")}`,
    ).toEqual([]);
    expect(badBucket, badBucket.join("\n")).toEqual([]);
    expect(stale, stale.join("\n")).toEqual([]);
    // Not vacuous: the four exported classes really were walked.
    expect(classNames).toEqual(["DatasetEventSource", "ReplayClock", "SeededStream", "SimulatedVenue"]);
    expect(membersChecked).toBeGreaterThan(24);
  });

  it("a member tagged RECORD DOOR really is driven by the nested battery", () => {
    // Tagging is a CLAIM, not a waiver: `RECORD DOOR` means "entered in
    // RECORD_DOORS", so it cannot be used to exempt a method from the battery.
    const driven = new Set(
      RECORD_DOORS.filter((door) => door.member !== undefined).map(
        (door) => `${door.name}.${String(door.member)}`,
      ),
    );
    const missing: string[] = [];
    const extra: string[] = [];
    for (const [className, members] of Object.entries(CLASS_MEMBERS)) {
      for (const [member, bucket] of Object.entries(members)) {
        const qualified = `${className}.${member}`;
        if (bucket.startsWith("RECORD DOOR") && !driven.has(qualified)) {
          missing.push(`${qualified} is tagged RECORD DOOR but has no RECORD_DOORS entry`);
        }
        if (!bucket.startsWith("RECORD DOOR") && driven.has(qualified)) {
          extra.push(`${qualified} is driven as a record door but is not tagged one`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
    expect(extra, extra.join("\n")).toEqual([]);
    expect(driven.size).toBe(5);
  });

  it("the ONE-READ carve-out is exactly one member, and both its claims hold", () => {
    // The carve-out is named, counted, and PROBED — it is the one place in this
    // package where a caller record is read without being materialized.
    const oneRead: string[] = [];
    for (const [className, members] of Object.entries(CLASS_MEMBERS)) {
      for (const [member, bucket] of Object.entries(members)) {
        if (bucket.startsWith("ONE-READ DOOR")) oneRead.push(`${className}.${member}`);
      }
    }
    expect(oneRead).toEqual(["ReplayClock.advanceTo"]);

    const built = createReplayClock({
      receivedAt: "2026-01-01T00:00:00.000Z",
      receivedMonotonicNs: "1000",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const clock = built.value;

    // CLAIM 1 — one read per field: an accessor cannot answer the monotonicity
    // check with one value and position the clock with another.
    let monotonicReads = 0;
    const lying = {} as Record<string, unknown>;
    Object.defineProperty(lying, "receivedAt", {
      value: "2026-01-01T00:00:01.000Z",
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(lying, "receivedMonotonicNs", {
      get: () => {
        monotonicReads += 1;
        return monotonicReads <= 1 ? "2000" : "999999999";
      },
      enumerable: true,
      configurable: true,
    });
    const advanced = clock.advanceTo(lying as never);
    expect(advanced.ok).toBe(true);
    expect(monotonicReads).toBe(1);
    expect(clock.monotonicNs()).toBe(2000n);

    // CLAIM 2 — total: a throwing accessor is CONTAINED, not raised at the
    // caller. Round-4 review LOW-1: at `d56e707` this threw the caller's own
    // `Error` out of a door whose signature promises a typed refusal.
    const throwing = {} as Record<string, unknown>;
    Object.defineProperty(throwing, "receivedAt", {
      get: () => {
        throw new Error("an accessor that throws inside advanceTo");
      },
      enumerable: true,
      configurable: true,
    });
    let thrown: unknown;
    let contained: SimulationResult<null> | undefined;
    try {
      contained = clock.advanceTo(throwing as never);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeUndefined();
    expect(contained?.ok).toBe(false);
    if (contained === undefined || contained.ok) return;
    expect(contained.refusal.code).toBe("SIMULATION_INTERNAL");
    // …and the clock did not move on the failed read.
    expect(clock.monotonicNs()).toBe(2000n);
  });

  it("a batch schedules on a priority it read once, and a throwing one is contained", async () => {
    // `submitAll`'s ONE caller read is the scheduling priority (§6 invariant 13).
    // At `d56e707` it was read raw inside the sort comparator, so a THROWING
    // accessor escaped as a rejected promise out of a method that answers a list
    // of results.
    let reads = 0;
    const throwing = { ...PLACEMENT_PLAN() } as Record<string, unknown>;
    delete throwing["priority"];
    Object.defineProperty(throwing, "priority", {
      get: () => {
        reads += 1;
        throw new Error("a priority accessor that throws");
      },
      enumerable: true,
      configurable: true,
    });
    let rejected: unknown;
    let results: readonly { readonly accepted: boolean; readonly refusalCode?: string }[] = [];
    try {
      results = await probeVenue().submitAll([throwing] as never);
    } catch (cause) {
      rejected = cause;
    }
    expect(rejected).toBeUndefined();
    expect(reads).toBe(1);
    expect(results.length).toBe(1);
    expect(results[0]?.accepted).toBe(false);
    expect(results[0]?.refusalCode).toBe("SIMULATION_INPUT_NOT_DATA");

    // …and the §6 invariant 13 ordering still holds for readable plans: a
    // SAFETY_CANCEL plan is submitted before a PLACEMENT one whatever order they
    // arrive in.
    const cancelPlan = {
      executionPlanId: "cancel-1",
      runMode: "BACKTEST",
      planKind: "CANCEL",
      priority: "SAFETY_CANCEL",
      reason: "kill switch",
      scope: { orderIds: [] as string[] },
    };
    const ordered = await probeVenue().submitAll([PLACEMENT_PLAN(), cancelPlan] as never);
    expect(ordered.map((result) => result.executionPlanId)).toEqual(["cancel-1", "plan-1"]);
  });

  it("every PORT ANSWER is total and hands out no alias of live state", async () => {
    // A member that takes no caller argument still has two properties worth
    // measuring: it cannot throw, and it cannot hand a consumer the venue's own
    // mutable state. Round-4 review MEDIUM-2's sweep found `SimulatedVenue.fills`
    // handing out `this.#fills` itself, which `runReplay` reads to build the
    // §12.4 bytes — so a consumer could push a fill the venue never produced.
    const venue = probeVenue();
    venue.observe(AT_EVENT() as never);
    const submitted = await venue.submit(PLACEMENT_PLAN() as never);
    expect(submitted.accepted, submitted.refusalMessage ?? "").toBe(true);

    const fills = venue.fills as unknown as unknown[];
    expect(Object.isFrozen(fills)).toBe(true);
    expect(venue.fills).not.toBe(venue.fills); // a fresh copy each read
    const orders = venue.ordersSnapshot();
    expect(orders).not.toBe(venue.ordersSnapshot());
    // SIM-2: the new history and counter answers are fresh too.
    expect(venue.bandHistory()).not.toBe(venue.bandHistory());
    expect(venue.restingBands()).not.toBe(venue.restingBands());
    expect(Object.isFrozen(venue.retention())).toBe(true);
    expect(Object.getPrototypeOf(venue.retention())).toBeNull();
    expect(venue.atEvent).toBeDefined();
    expect(Object.isFrozen(venue.atEvent)).toBe(true);

    // Total under every pollution class, for every no-argument member of every
    // exported class the table classifies as a PORT ANSWER.
    const clock = createReplayClock({
      receivedAt: "2026-01-01T00:00:00.000Z",
      receivedMonotonicNs: "1000",
    });
    expect(clock.ok).toBe(true);
    if (!clock.ok) return;
    const instances: Readonly<Record<string, unknown>> = {
      SimulatedVenue: venue,
      ReplayClock: clock.value,
      SeededStream: deriveStreams("42")["latency.decision"],
    };
    const escapes: string[] = [];
    for (const battery of CLASSES) {
      const failures = await underPollutionAsync(battery.install, async () => {
        const found: string[] = [];
        for (const [className, members] of Object.entries(CLASS_MEMBERS)) {
          const instance = instances[className];
          if (instance === undefined) continue; // driven by its own suite
          for (const [member, bucket] of Object.entries(members)) {
            if (!bucket.startsWith("PORT ANSWER")) continue;
            try {
              const read: unknown = (instance as Record<string, unknown>)[member];
              if (typeof read === "function") {
                const answered: unknown = (read as () => unknown).call(instance);
                if (answered instanceof Promise) await answered;
              }
            } catch (cause) {
              found.push(`${battery.name}/${className}.${member}: ${String(cause)}`);
            }
          }
        }
        return found;
      });
      escapes.push(...failures);
    }
    expect(escapes, escapes.join("\n")).toEqual([]);
  });
});

describe("D1: a door materializes its caller record before it touches it", () => {
  it("every record door ACCEPTS its valid example (the probes below are not vacuous)", async () => {
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      const outcome = await door.drive(door.valid());
      if (!outcome.ok) {
        faults.push(`${door.id}: ${outcome.refusal.code}: ${outcome.refusal.message}`);
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });

  it("REFUSES every hostility class, at every record it claims, NESTED", async () => {
    // Faults are COLLECTED, not asserted inside the loop: a bare `expect` throws
    // on the first door and the remaining ones are never measured, so a
    // regression in the twentieth door would hide behind one in the first.
    const faults: string[] = [];
    let probes = 0;
    for (const door of RECORD_DOORS) {
      for (const path of deriveRecordPaths(door)) {
        for (const hostility of HOSTILITY_CLASSES) {
          probes += 1;
          const before = nestedGettersInvoked;
          const argument = door.valid();
          const planted = plantAt(argument, path, hostility.build());
          if (planted !== null) {
            faults.push(`${door.id} at ${describePath(path)}: ${planted}`);
            continue;
          }
          let outcome: SimulationResult<unknown> | undefined;
          let thrown: unknown;
          try {
            // AWAITED (round-4 review, MEDIUM-2): a door that fails one tick
            // later has still failed, and three of the members this table now
            // covers are async.
            outcome = await door.drive(argument);
          } catch (cause) {
            thrown = cause;
          }
          const where = `${door.id} at ${describePath(path)} with ${hostility.name}`;
          if (nestedGettersInvoked !== before) {
            faults.push(`${where}: INVOKED the nested getter`);
          }
          if (thrown !== undefined) {
            faults.push(`${where}: threw ${String(thrown)}`);
            continue;
          }
          if (outcome === undefined || outcome.ok) {
            faults.push(`${where}: ACCEPTED it`);
            continue;
          }
          if (outcome.refusal.code !== "SIMULATION_INPUT_NOT_DATA") {
            faults.push(`${where}: refused with ${outcome.refusal.code}`);
            continue;
          }
          if (hostility.named !== "" && !outcome.refusal.message.includes(hostility.named)) {
            faults.push(`${where}: did not name it — ${outcome.refusal.message}`);
          }
        }
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
    // Not vacuous: every door × every DERIVED record position × every class
    // really ran, and the walker found far more positions than the round-2
    // table listed by hand (5 doors, one position each).
    expect(probes).toBe(
      RECORD_DOORS.reduce((total, door) => total + deriveRecordPaths(door).length, 0) *
        HOSTILITY_CLASSES.length,
    );
    expect(probes).toBeGreaterThan(150);
  });

  it("REFUSES the same three classes at the ROOT of each record", async () => {
    // The round-2 shape, kept: hostility planted ON the record rather than
    // inside it. Both are measured because they fail differently — a door that
    // checks `typeof input.order === "object"` before materializing would pass
    // one and not the other.
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      for (const path of deriveRecordPaths(door)) {
        for (const hostility of HOSTILITY_CLASSES) {
          const before = nestedGettersInvoked;
          const argument = door.valid();
          const target = navigate(argument, path);
          if (target === null || typeof target !== "object") {
            faults.push(`${door.id}: ${describePath(path)} is not reachable`);
            continue;
          }
          // The hostility's own members, spread ONTO the record rather than
          // planted inside it: `{ nested: … }` becomes the record's own key.
          const built = hostility.build() as Record<string, unknown>;
          const host = target as Record<string, unknown>;
          for (const key of Object.keys(built)) {
            Object.defineProperty(host, key, {
              value: built[key],
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
          let outcome: SimulationResult<unknown> | undefined;
          let thrown: unknown;
          try {
            outcome = await door.drive(argument);
          } catch (cause) {
            thrown = cause;
          }
          const where = `${door.id} at ${describePath(path)} (root) with ${hostility.name}`;
          if (nestedGettersInvoked !== before) faults.push(`${where}: INVOKED the getter`);
          if (thrown !== undefined) {
            faults.push(`${where}: threw ${String(thrown)}`);
            continue;
          }
          if (outcome === undefined || outcome.ok) {
            faults.push(`${where}: ACCEPTED it`);
            continue;
          }
          if (outcome.refusal.code !== "SIMULATION_INPUT_NOT_DATA") {
            faults.push(`${where}: refused with ${outcome.refusal.code}`);
          }
        }
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });

  it("emits a tree of its OWN, not an alias of the caller's record", async () => {
    // D4 on the way out, and the reason D1 has to happen on the way in: the
    // emitted value must not be the caller's object, or a later mutation of the
    // caller's object would change a value this package already answered with.
    // Round-3 review MEDIUM-1 found `checkBandOrdering`'s OK path returning an
    // unfrozen, prototype-bearing ALIAS — so a band could pass the check and
    // serialize as something else.
    const faults: string[] = [];
    for (const door of RECORD_DOORS) {
      const offered = door.valid();
      const outcome = await door.drive(offered);
      if (!outcome.ok) {
        faults.push(`${door.id}: ${outcome.refusal.code}: ${outcome.refusal.message}`);
        continue;
      }
      const emitted: unknown = outcome.value;
      if (emitted === offered) faults.push(`${door.id}: emitted the caller's own object`);
      if (emitted === null || typeof emitted !== "object") continue;
      if (Array.isArray(emitted)) {
        // A LIST answer (a batch of results): the container must be frozen and
        // every member must be its own frozen prototype-free tree. Checking the
        // container's prototype would only assert that `Array.prototype` is
        // `Array.prototype`.
        if (!Object.isFrozen(emitted)) faults.push(`${door.id}: emitted an unfrozen list`);
        for (const member of emitted as readonly unknown[]) {
          if (member === null || typeof member !== "object") continue;
          if (Object.getPrototypeOf(member) !== null) {
            faults.push(`${door.id}: emitted a list member with a prototype`);
          }
          if (!Object.isFrozen(member)) faults.push(`${door.id}: emitted an unfrozen list member`);
        }
        continue;
      }
      // A door that answers a PRIMITIVE (a size, an id) has nothing to alias.
      if (Object.getPrototypeOf(emitted) !== null && !(emitted instanceof ReplayClock)) {
        faults.push(`${door.id}: emitted a value with a prototype`);
      }
      if (!Object.isFrozen(emitted) && !(emitted instanceof ReplayClock)) {
        faults.push(`${door.id}: emitted an unfrozen value`);
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });

  it("a lying accessor cannot be checked as one value and used as another", () => {
    // The round-3 probe, kept as a regression: an accessor on the band's
    // `conservative` member that answers honestly while `checkBandOrdering`
    // reads it and differently afterwards. At `b0aeb28` the check ACCEPTED and
    // `serializeBand` on the RETURNED CHECKED VALUE printed
    // `conservative[ filled=999 remaining=0 … ]` for a 50-share order.
    const honest = validBand()["conservative"] as Record<string, unknown>;
    const lying = { ...honest, filledShares: "999", remainingShares: "0", fills: [] };
    let reads = 0;
    const hostile = validBand();
    delete hostile["conservative"];
    Object.defineProperty(hostile, "conservative", {
      get: () => {
        reads += 1;
        return reads <= 2 ? honest : lying;
      },
      enumerable: true,
      configurable: true,
    });
    const checked = checkBandOrdering(hostile as never);
    const serialized = checked.ok ? serializeBand(checked.value) : "(refused)";
    expect(checked.ok).toBe(false);
    expect(reads).toBe(0);
    expect(serialized).toBe("(refused)");
    if (checked.ok) return;
    expect(checked.refusal.code).toBe("SIMULATION_INPUT_NOT_DATA");
  });

  it("a lying accessor cannot pass simulateResting's own size check and then be computed over", () => {
    // The queueAhead TOCTOU, kept as a regression. At `b0aeb28` this produced
    // an ACCEPTED band serializing as valid v3 bytes with `queueAhead=0`.
    let reads = 0;
    const order = RESTING_ORDER();
    delete order["queueAheadAtPlacement"];
    Object.defineProperty(order, "queueAheadAtPlacement", {
      get: () => {
        reads += 1;
        return reads <= 1 ? "10" : "0";
      },
      enumerable: true,
      configurable: true,
    });
    const outcome = simulateResting({
      model: TIER_1_MODEL() as never,
      order: order as never,
      trades: [OBSERVED_TRADE()] as never,
      parameters: QUEUE_PARAMETERS() as never,
      feeSnapshot: FEE_SNAPSHOT() as never,
    });
    expect(outcome.ok).toBe(false);
    expect(reads).toBe(0);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATION_INPUT_NOT_DATA");
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

  it("NO nested getter was invoked anywhere in this file", () => {
    // The stronger claim, over every probe above: a getter planted INSIDE a
    // caller record was never once run — not by a record door, and not by the
    // whole-surface reflection battery either.
    expect(nestedGettersInvoked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Planting helpers
// ---------------------------------------------------------------------------

/** Walks a path into an argument. `undefined` when the path does not exist. */
function navigate(root: unknown, path: RecordPath): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Plants a hostile value INSIDE the record at `path`. Returns a fault string
 * when the path could not be reached, so a stale path fails loudly rather than
 * making a probe vacuous.
 */
function plantAt(root: unknown, path: RecordPath, hostile: unknown): string | null {
  const target = navigate(root, path);
  if (target === null || typeof target !== "object") {
    return `${describePath(path)} is not a record or array`;
  }
  if (Array.isArray(target)) {
    // PUSHED, not defined by name: a named property on an array is refused as
    // "not indexed data", which would refuse for the wrong reason and stop
    // measuring whether the hostility itself is caught.
    (target as unknown[]).push(hostile);
    return null;
  }
  Object.defineProperty(target, "plantedByTheBattery", {
    value: hostile,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return null;
}

function describePath(path: RecordPath): string {
  return path.length === 0 ? "the argument itself" : path.join(".");
}
