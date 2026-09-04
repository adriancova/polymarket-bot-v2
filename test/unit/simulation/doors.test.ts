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
  isCanonicalUuidV7,
  isIsoTimestamp,
  loadDataset,
  materializeInput,
  ownFrozenTree,
  parseStrictJsonText,
  readDatasetManifestText,
  readRunPins,
  simulationRefusal,
  SimulatedVenue,
  tier0Model,
  unmodeledRateLimits,
  createReplayClock,
} from "../../../packages/simulation/src/index.js";

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
