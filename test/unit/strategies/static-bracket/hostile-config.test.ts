/**
 * The hostile battery against this package's parse door.
 *
 * Four families, and the bound each one establishes:
 *
 * 1. **Prototype pollution.** ADR-020 §1's measured classes, applied to the
 *    door and to a running strategy. For NAMED string keys inherited by
 *    `Object.prototype` — enumerable and non-enumerable, including a required
 *    grammar key, an inherited `get`, `_zod` and `toString`, and state/decision
 *    keys polluted around a running callback — permission does not vary and
 *    nothing throws. **NUMERIC-INDEX pollution was a measured and OPEN exposure
 *    and is now CLOSED** (`WP-020-FU1`): its root cause was in
 *    `packages/decimal`, where one property at an index name reached
 *    `decimal.js`'s digit arrays and made `subDecimal` throw on an exactly-zero
 *    result — which this package's guards turned into a fail-closed refusal on
 *    the ORDINARY entry path. The two probes below were promoted in that round
 *    from DOCUMENTED EXPECTATIONS to ordinary permission-does-not-vary cases,
 *    widened past the one index name `WP-220` measured, and they now assert
 *    byte-identity of the decision rather than the direction of a refusal.
 *    `src/plain.ts` states both halves per ADR-020 §4.
 * 2. **Wrong shapes.** `Map`, `Set`, `Date`, class instances, accessors,
 *    symbol keys, non-enumerable keys, `Proxy`, cycles, sparse arrays,
 *    `undefined` — refused, never coerced.
 * 3. **Boundary decimals.** `"0"`, `"0.0"`, `"-0"`, `""`, `"1e-2"`, `"+0.35"`,
 *    `".35"`, `"0.35 "` — the canonical/normalizable frontier.
 * 4. **Off-by-one-tick thresholds**, at the entry trigger and the stop.
 *
 * Nothing here is inspection-only: every case asserts a behaviour.
 */

import { describe, expect, it } from "vitest";

import {
  REASONS,
  staticBracketStrategy,
  validateStaticBracketParams,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import {
  STOP_KEY,
  TRIGGER_KEY,
  baseConfig,
  clone,
  configWith,
  context,
  parsedParams,
  protectedReductions,
  stateWith,
  type ViewOptions,
} from "./helpers.js";
import { staticBracketParamsSchema } from "../../../../packages/strategies/static-bracket/src/index.js";

const ARMED = stateWith({ instanceState: "ARMED" });

/**
 * Runs `produce` with `Object.prototype` polluted and returns its result AFTER
 * cleaning up.
 *
 * Assertions deliberately happen outside the pollution window. That is not
 * squeamishness: ADR-020 §1 class 8 measured that an inherited `get` makes
 * every `Object.defineProperty` written with an object-literal descriptor throw
 * `TypeError`, and the assertion library uses exactly that. Asserting inside
 * the window would make the harness fail on a class the door itself survives —
 * which this file measured on its first run.
 */
function underPollution<T>(
  entries: Record<string, unknown>,
  options: { enumerable: boolean },
  produce: () => T,
): T {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  const added: string[] = [];
  try {
    for (const [key, value] of Object.entries(entries)) {
      if (Object.hasOwn(proto, key)) continue;
      Object.defineProperty(proto, key, {
        value,
        writable: true,
        enumerable: options.enumerable,
        configurable: true,
      });
      added.push(key);
    }
    return produce();
  } finally {
    for (const key of added) {
      delete proto[key];
    }
  }
}

describe("hostile battery — prototype pollution (ADR-020 §1)", () => {
  it("does not adopt a required key from the prototype chain (class A1)", () => {
    const config = clone(baseConfig()) as Record<string, unknown>;
    delete (config["entry"] as Record<string, unknown>)["trigger_price_lte"];
    for (const enumerable of [true, false]) {
      const result = underPollution({ trigger_price_lte: "0.99" }, { enumerable }, () =>
        validateStaticBracketParams(config),
      );
      expect(result.ok, `enumerable=${String(enumerable)} adoption`).toBe(false);
      if (result.ok) continue;
      expect(result.problem).toContain("trigger_price_lte");
      expect(result.problem).toContain("required and absent");
    }
  });

  it("does not let an inherited key become a configuration value anywhere in the tree", () => {
    for (const enumerable of [true, false]) {
      const result = underPollution(
        {
          maximum_total_cost: "9999",
          enabled: true,
          urgency: "IMMEDIATE",
          on_incident: "PAUSE_AND_CANCEL",
        },
        { enumerable },
        () => validateStaticBracketParams(baseConfig()),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.entry.maximum_total_cost).toBe("18");
      expect(result.value.exit.stop.urgency).toBe("AGGRESSIVE");
    }
  });

  it("PERMISSION does not vary with ambient prototype state, and nothing throws", () => {
    const clean = validateStaticBracketParams(baseConfig());
    expect(clean.ok).toBe(true);
    const pollutions: Record<string, unknown>[] = [
      { skipChecks: true },
      { optin: "x", optout: "y" },
      { when: () => false },
      { values: {} },
      { get: () => undefined },
      { _zod: {} },
      { trigger_price_lte: "0.99", size_shares: "9999" },
      { toString: () => "polluted" },
    ];
    for (const pollution of pollutions) {
      for (const enumerable of [true, false]) {
        const observed = underPollution(pollution, { enumerable }, () => ({
          accepted: validateStaticBracketParams(baseConfig()).ok,
          refused: validateStaticBracketParams(configWith({ version: 99 })).ok,
        }));
        expect(
          observed.accepted,
          `permission changed under ${Object.keys(pollution).join(",")}`,
        ).toBe(clean.ok);
        expect(observed.refused, "a refusal must stay a refusal under pollution").toBe(false);
      }
    }
  });

  /**
   * PROMOTED (`WP-020-FU1`) — this used to be a DOCUMENTED EXPECTATION.
   *
   * WHAT IT USED TO SAY, and why it said it. `Object.prototype["0"]` made
   * `subDecimal` throw whenever its exact result was zero — which the book walk
   * hits on the ORDINARY path, when it consumes exactly the requested size —
   * and `economics.ts`'s guard contained the throw, so the strategy REFUSED
   * (`SB.REFUSED_BOOK_PARTICIPATION`) where a clean process would have entered.
   * The test pinned that direction, said out loud that the class was open, and
   * named the round that would close it (`WP-220` review round 1, M2).
   *
   * That round landed. `packages/decimal` no longer lets an index-named
   * property on either prototype reach `decimal.js`'s digit arrays — the
   * measurement, the root cause in the library, and the residual are in
   * `packages/decimal/src/prototype-guard.ts` — so this is now an ordinary
   * "permission does not vary" case: the strategy ENTERS, and the decision is
   * BYTE-IDENTICAL to the clean one rather than merely fail-closed.
   *
   * The `"9"` value is kept deliberately: it is the digit the base defect
   * fabricated, so a revert of the decimal fix turns this back into a refusal
   * and fails here by name.
   */
  it("numeric-index pollution changes NOTHING: the entry is byte-identical", () => {
    const params = parsedParams(staticBracketParamsSchema);
    const clean = staticBracketStrategy.onFeatures(context(params, ARMED, {}));
    expect(clean.decisionType).toBe("enter");

    for (const enumerable of [true, false]) {
      const polluted = underPollution({ "0": "9" }, { enumerable }, () =>
        staticBracketStrategy.onFeatures(context(params, ARMED, {})),
      );
      expect(polluted.decisionType, `enumerable=${String(enumerable)}`).toBe("enter");
      expect(polluted.intents).toHaveLength(clean.intents.length);
      expect(polluted.reasonCodes).not.toContain(REASONS.refusedParticipation);
      expect(polluted.reasonCodes).toContain(REASONS.entryIntentEmitted);
      // Byte-identity, not just the same shape: the sized exit and the entry
      // price are decimal results, and one fabricated digit would move them.
      expect(JSON.stringify(polluted)).toBe(JSON.stringify(clean));
    }
  });

  it("numeric-index pollution never turns a refusal into a permission", () => {
    // The direction that would actually be dangerous: pollution must not make
    // the door ACCEPT something it refuses cleanly, and must not make a holding
    // instance emit a position-changing intent. Unchanged by the promotion
    // above — it was true when the class was open and it is true now.
    const params = parsedParams(staticBracketParamsSchema);
    const observed = underPollution({ "0": "9" }, { enumerable: false }, () => ({
      refusedConfig: validateStaticBracketParams(configWith({ version: 99 })).ok,
      openInstant: staticBracketStrategy.onFeatures(
        context(params, stateWith({ instanceState: "ARMED" }), {
          features: { [TRIGGER_KEY]: "0.9" },
        }),
      ),
    }));
    expect(observed.refusedConfig).toBe(false);
    expect(observed.openInstant.intents).toHaveLength(0);
  });

  it("the index-name class is closed at every index the walk can reach", () => {
    // The promotion, widened past the one name `WP-220` measured: the book walk
    // subtracts and compares at every level, so a battery pinned to `"0"` would
    // not have seen the `"1"`/`"2"` fabrications the decimal round found.
    const params = parsedParams(staticBracketParamsSchema);
    const clean = JSON.stringify(staticBracketStrategy.onFeatures(context(params, ARMED, {})));
    const moved: string[] = [];
    for (const index of ["0", "1", "2", "3"]) {
      for (const enumerable of [true, false]) {
        const polluted = underPollution({ [index]: "9" }, { enumerable }, () =>
          JSON.stringify(staticBracketStrategy.onFeatures(context(params, ARMED, {}))),
        );
        if (polluted !== clean) {
          Object.defineProperty(moved, `${moved.length}`, {
            value: `${index} | enumerable=${String(enumerable)}`,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
    }
    expect(moved).toEqual([]);
  });

  /**
   * THE HARNESS ITSELF MUST NOT BE THE THING THAT BENDS.
   *
   * The fixture builders take ordinary `{}` option objects, so a read written
   * `options.tickSize ?? "0.01"` is answered by a polluted `Object.prototype`
   * and the FIXTURE hands the strategy a poisoned view. Every measurement in
   * this file would then be of the helpers rather than of the package. The
   * builders read own properties only; this pins that, because a bound measured
   * through a leaky harness is not a bound.
   */
  it("the FIXTURE builders read own properties only, so the battery measures the package", () => {
    const params = parsedParams(staticBracketParamsSchema);
    const clean = JSON.stringify(staticBracketStrategy.onFeatures(context(params, ARMED, {})));
    const polluted = underPollution(
      {
        // 0.35 is NOT on a 0.03 grid, so a leaked tick size would turn the
        // entry into SB.REFUSED_PRICE_OFF_TICK_GRID — a visible flip, which is
        // what makes this assertion discriminate rather than merely pass.
        tickSize: "0.03",
        minimumOrderSize: "9999",
        yesShares: "9999",
        noShares: "9999",
        closeTime: "2026-03-04T12:05:10.000Z",
        openTime: "2026-03-04T12:04:59.000Z",
        asOf: "1999-01-01T00:00:00.000Z",
        now: "1999-01-01T00:00:00.000Z",
        orders: [{ orderId: "ghost" }],
        omitFeatures: [TRIGGER_KEY],
      },
      { enumerable: true },
      () => JSON.stringify(staticBracketStrategy.onFeatures(context(params, ARMED, {}))),
    );
    expect(polluted).toBe(clean);
  });

  it("a running strategy's decision is byte-identical under pollution", () => {
    const params = parsedParams(staticBracketParamsSchema);
    const clean = JSON.stringify(staticBracketStrategy.onFeatures(context(params, ARMED, {})));
    const polluted = underPollution(
      { statePatch: { evil: true }, intents: [{ type: "CANCEL" }], allocatedShares: "9999" },
      { enumerable: true },
      () => JSON.stringify(staticBracketStrategy.onFeatures(context(params, ARMED, {}))),
    );
    expect(polluted).toBe(clean);
  });

  it("a fresh instance is not made to look like a running one by pollution", () => {
    const params = parsedParams(staticBracketParamsSchema);
    const patch = underPollution(
      { instanceState: "OPEN", allocatedShares: "50", entriesExecuted: 9 },
      { enumerable: true },
      () => staticBracketStrategy.onStart(context(params, {}, {})).statePatch,
    ) as Record<string, unknown>;
    expect(patch["instanceState"]).toBe("ARMED");
    expect(patch["allocatedShares"]).toBe("0");
    expect(patch["entriesExecuted"]).toBe(0);
  });
});

describe("hostile battery — wrong shapes", () => {
  const cases: { name: string; build: () => unknown; expect: RegExp }[] = [
    { name: "a non-object", build: () => "config", expect: /must be an object/u },
    { name: "null", build: () => null, expect: /must be an object/u },
    { name: "an array", build: () => [], expect: /must be an object/u },
    {
      name: "a Map anywhere in the tree",
      build: () => configWith({ entry: new Map([["a", 1]]) }),
      expect: /only plain objects and arrays are configuration data/u,
    },
    {
      name: "a Set",
      build: () => configWith({ risk: new Set([1]) }),
      expect: /only plain objects and arrays are configuration data/u,
    },
    {
      name: "a Date",
      build: () => configWith({ "exit.stop.enabled": new Date(0) }),
      expect: /only plain objects and arrays are configuration data/u,
    },
    {
      name: "a class instance",
      build: () => {
        class Holder {
          readonly series_id = "x";
          readonly direction = "YES";
        }
        return configWith({ market_selector: new Holder() });
      },
      expect: /only plain objects and arrays are configuration data/u,
    },
    {
      name: "a function value",
      build: () => configWith({ "entry.size_shares": () => "50" }),
      expect: /not JSON-shaped configuration data/u,
    },
    {
      name: "an explicit undefined",
      build: () => configWith({ "entry.size_shares": undefined }),
      expect: /undefined is not a value/u,
    },
    {
      name: "a non-finite number",
      build: () => configWith({ "exit.maximum_holding_seconds": Number.NaN }),
      expect: /non-finite number has no JSON form/u,
    },
    {
      name: "an accessor property",
      build: () => {
        const config = clone(baseConfig()) as Record<string, unknown>;
        Object.defineProperty(config["entry"], "size_shares", {
          get: () => "50",
          enumerable: true,
          configurable: true,
        });
        return config;
      },
      expect: /accessor property is a value recomputed on every read/u,
    },
    {
      name: "a symbol-keyed property",
      build: () => {
        const config = clone(baseConfig()) as Record<string, unknown>;
        (config["entry"] as Record<symbol, unknown>)[Symbol("hidden")] = 1;
        return config;
      },
      expect: /symbol-keyed properties are invisible to JSON/u,
    },
    {
      name: "a non-enumerable own property",
      build: () => {
        const config = clone(baseConfig()) as Record<string, unknown>;
        Object.defineProperty(config["risk"], "hidden", {
          value: 1,
          enumerable: false,
          configurable: true,
        });
        return config;
      },
      expect: /non-enumerable own property is invisible to JSON/u,
    },
    {
      name: "a cycle",
      build: () => {
        const config = clone(baseConfig()) as Record<string, unknown>;
        (config["entry"] as Record<string, unknown>)["self"] = config;
        return config;
      },
      expect: /cyclic|not part of the static-bracket configuration grammar/u,
    },
    {
      name: "a sparse array",
      build: () => {
        const holes: unknown[] = [];
        holes[3] = 1;
        return configWith({ risk: holes });
      },
      expect: /sparse array has holes/u,
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name}`, () => {
      const result = validateStaticBracketParams(testCase.build());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem).toMatch(testCase.expect);
    });
  }

  it("copies a Proxy over a plain object rather than keeping its traps", () => {
    let reads = 0;
    const config = clone(baseConfig()) as Record<string, unknown>;
    config["entry"] = new Proxy(config["entry"] as object, {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const result = validateStaticBracketParams(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = reads;
    // Every later read is of the copy, so the trap cannot run again.
    expect(result.value.entry.size_shares).toBe("50");
    expect(result.value.entry.trigger_price_lte).toBe("0.35");
    expect(reads).toBe(before);
  });
});

describe("hostile battery — boundary decimals", () => {
  const cases: { value: string; field: string; accepted: boolean; normalizedTo?: string }[] = [
    { value: "0", field: "risk.maximum_slippage", accepted: true, normalizedTo: "0" },
    { value: "0.0", field: "risk.maximum_slippage", accepted: true, normalizedTo: "0" },
    { value: "-0", field: "risk.maximum_slippage", accepted: true, normalizedTo: "0" },
    { value: "0.00", field: "entry.economics.entry_fee_per_share", accepted: true, normalizedTo: "0" },
    { value: "0", field: "entry.size_shares", accepted: false },
    { value: "0.0", field: "entry.size_shares", accepted: false },
    { value: "-1", field: "risk.maximum_slippage", accepted: false },
    { value: "1e-2", field: "entry.trigger_price_lte", accepted: false },
    { value: "+0.35", field: "entry.trigger_price_lte", accepted: false },
    { value: ".35", field: "entry.trigger_price_lte", accepted: false },
    { value: "0.35 ", field: "entry.trigger_price_lte", accepted: false },
    { value: "0.35.1", field: "entry.trigger_price_lte", accepted: false },
    { value: "", field: "entry.trigger_price_lte", accepted: false },
    { value: "1.1", field: "entry.trigger_price_lte", accepted: false },
    { value: "0.350", field: "entry.trigger_price_lte", accepted: true, normalizedTo: "0.35" },
    { value: "00.35", field: "entry.trigger_price_lte", accepted: true, normalizedTo: "0.35" },
    { value: "1", field: "entry.trigger_price_lte", accepted: true, normalizedTo: "1" },
  ];

  for (const testCase of cases) {
    it(`${testCase.accepted ? "accepts" : "refuses"} ${JSON.stringify(testCase.value)} at ${testCase.field}`, () => {
      const result = validateStaticBracketParams(
        configWith({ [testCase.field]: testCase.value }),
      );
      expect(result.ok).toBe(testCase.accepted);
      if (!result.ok || testCase.normalizedTo === undefined) return;
      const segments = testCase.field.split(".");
      let cursor: unknown = result.value;
      for (const segment of segments) {
        cursor = (cursor as Record<string, unknown>)[segment];
      }
      expect(cursor).toBe(testCase.normalizedTo);
    });
  }

  it("refuses a number where a decimal string belongs", () => {
    const result = validateStaticBracketParams(configWith({ "entry.size_shares": 50 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(/must be a decimal string/u);
  });

  it("refuses a decimal string where an integer duration belongs", () => {
    const result = validateStaticBracketParams(
      configWith({ "exit.maximum_holding_seconds": "180" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(/must be an integer/u);
  });
});

describe("hostile battery — thresholds are exact, one tick at a time", () => {
  const params = () => parsedParams(staticBracketParamsSchema);

  const entryCases: { trigger: string; enters: boolean }[] = [
    { trigger: "0.34", enters: true },
    { trigger: "0.35", enters: true },
    { trigger: "0.36", enters: false },
  ];

  for (const testCase of entryCases) {
    it(`${testCase.enters ? "enters" : "holds"} at an executable ask of ${testCase.trigger}`, () => {
      const decision = staticBracketStrategy.onFeatures(
        context(params(), ARMED, { features: { [TRIGGER_KEY]: testCase.trigger } }),
      );
      expect(decision.decisionType).toBe(testCase.enters ? "enter" : "hold");
    });
  }

  const stopCases: { trigger: string; stops: boolean }[] = [
    { trigger: "0.26", stops: true },
    { trigger: "0.27", stops: true },
    { trigger: "0.28", stops: false },
  ];

  for (const testCase of stopCases) {
    it(`${testCase.stops ? "stops" : "holds"} at an executable bid of ${testCase.trigger}`, () => {
      const open = stateWith({
        instanceState: "OPEN",
        allocatedShares: "50",
        allocatedCost: "17.5",
        legOutcome: "YES",
        entriesExecuted: 1,
      });
      const decision = staticBracketStrategy.onFeatures(
        context(params(), open, { yesShares: "50", features: { [STOP_KEY]: testCase.trigger } }),
      );
      // FORCING FINDING r2-B1: a protected reduction is a tagged POSITION
      // delta now; `type === "REDUCE_POSITION"` would never match and the
      // `stops: true` rows would assert nothing.
      const reduced = protectedReductions(decision).length > 0;
      expect(reduced).toBe(testCase.stops);
    });
  }

  /**
   * A stop that cannot be READ must never reduce.
   *
   * `stopTriggerSatisfied` answers `boolean | null`, and the three ways of
   * failing to read the feature — the key is missing from the snapshot
   * (UNUSABLE), the engine reported the feature absent (`null`), and the value
   * is the wrong type (UNUSABLE) — must all answer `null`, which the ladder
   * treats as "not triggered" for ACTING while still recording that the stop was
   * not evaluated.
   *
   * The case below the non-canonical one covered a different branch (a readable
   * VALUE that is not a canonical price), which left the unreadable branch
   * untested: mutating `if (read.kind !== "VALUE") return null` to `return true`
   * survived the whole suite while making the strategy emit a REDUCE_POSITION at
   * the stop floor on a market it had no stop reading for. These cases kill it.
   */
  const unreadableStops: { name: string; views: ViewOptions }[] = [
    { name: "absent from the snapshot entirely", views: { omitFeatures: [STOP_KEY] } },
    { name: "reported as null by the engine", views: { features: { [STOP_KEY]: null } } },
    { name: "a boolean rather than a price", views: { features: { [STOP_KEY]: true } } },
  ];

  for (const testCase of unreadableStops) {
    it(`never reduces when the stop feature is ${testCase.name}`, () => {
      const open = stateWith({
        instanceState: "OPEN",
        allocatedShares: "50",
        allocatedCost: "17.5",
        legOutcome: "YES",
        entriesExecuted: 1,
      });
      const decision = staticBracketStrategy.onFeatures(
        context(params(), open, { yesShares: "50", ...testCase.views }),
      );
      expect(
        protectedReductions(decision).length > 0,
        `an unreadable stop (${testCase.name}) must never reduce`,
      ).toBe(false);
      expect(decision.reasonCodes).not.toContain(REASONS.stopTriggered);
      expect(decision.reasonCodes).not.toContain(REASONS.finalProtectedReduce);
    });
  }

  it("cannot evaluate a stop whose feature value is not canonical, and does not act", () => {
    const open = stateWith({
      instanceState: "OPEN",
      allocatedShares: "50",
      allocatedCost: "17.5",
      legOutcome: "YES",
      entriesExecuted: 1,
    });
    const decision = staticBracketStrategy.onFeatures(
      // "0.200" is arithmetically below the 0.27 threshold, but a view value is
      // required to be canonical: the strategy refuses to interpret it rather
      // than normalizing market data inside a trading decision.
      context(params(), open, { yesShares: "50", features: { [STOP_KEY]: "0.200" } }),
    );
    expect(protectedReductions(decision).length > 0).toBe(false);
  });

  it("refuses a trigger naming a feature the engine does not compute", () => {
    const result = validateStaticBracketParams(
      configWith({ "entry.trigger_feature_key": "polymarket.executable_price@50" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(/not a member of feature set v1/u);
  });

  it("refuses a trigger whose feature contradicts its declared basis", () => {
    const result = validateStaticBracketParams(
      configWith({ "entry.trigger_feature_key": "polymarket.executable_sell_price@50" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(/basis and the feature it reads may not disagree/u);
  });

  it("holds, rather than throwing, when the trigger key is absent from the snapshot", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), ARMED, { features: { [TRIGGER_KEY]: null } }),
    );
    expect(decision.decisionType).toBe("hold");
    expect(decision.reasonCodes).toContain(REASONS.refusedTriggerAbsent);
  });
});
