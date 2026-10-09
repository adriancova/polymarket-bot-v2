/**
 * The configuration door's ADR-020 conformance battery.
 *
 * `docs/contracts/schema-boundary.md` §4 states what a conforming door must
 * say, and item 5 is the one a test can prove: **under its pollution battery,
 * permission never varies, and no throw escapes.** So this file measures that,
 * against the classes §2 enumerates, and it does so with the class the document
 * calls out as the one to design against:
 *
 * > "**The non-enumerable variant is the one to design against.** Enumerable
 * > pollution is loud: it breaks `for…in`, it trips `strictObject`, and it
 * > poisons cold lazies noisily. Non-enumerable pollution is read by every
 * > property read the library performs and is invisible to every
 * > enumeration-based guard."
 *
 * The cautionary precedent it is measured against is named: `apps/data-gateway`'s
 * `parseGatewayConfig` is recorded LIVE ×2 in §3 — a get-only inherited
 * `tickIntervalMs` defeated its `.default()` and a startup check silently
 * passed. This door has no `.default()` at all, and the battery below shows why
 * that is not the only reason it holds.
 */

import { afterEach, describe, expect, it } from "vitest";

import { configuredFeatureKeys, configuredSeries, parseTraderConfig } from "./config.js";
import { reviewedSeriesDocument } from "./testing/series.js";

/** A minimal, valid configuration. Every field required; none defaulted. */
function validConfig(): Record<string, unknown> {
  return {
    environment: "PAPER",
    riskPolicy: {},
    allocatorCaps: {},
    accounting: {
      accountRef: "paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "venue-clearing",
      attributionClearingRef: "attribution-clearing",
      feeExpenseRef: "fee-expense",
      startingCash: "1000",
    },
    queues: { ingestMaximumDepth: 64, outboxMaximumDepth: 64 },
    features: {
      depthLevels: [1],
      executableShares: ["50"],
      tradeWindowMs: 60000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    planning: {
      maxSliceShares: "100",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 1,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 5000,
      maxPlanLifetimeMs: 30000,
    },
    simulation: {
      fillModelVersion: "tier0.fixture",
      fillModelParametersHash: "a".repeat(64),
      feeSchedule: {
        snapshotVersion: "fixture.2026-03-04",
        takerFeeRate: "0",
        makerFeeRate: "0",
        roundingDecimalPlaces: 6,
        roundingMode: "HALF_UP",
        minimumChargedFee: "0",
        feeCurrency: "pUSD",
      },
      startingCash: "1000",
    },
    requestBudget: { capacity: 100, windowMs: 60000 },
    scenarios: [{ scenarioId: "spot.down", kind: "SPOT", yesPriceShock: "-0.1" }],
    infrastructure: {
      eventStream: "polymarket.normalized",
      consumerId: "trader-1",
      receiveBatchSize: 128,
    },
    markets: [
      {
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        conditionId: "0xcondition",
        yesTokenId: "111",
        noTokenId: "222",
        tickSize: "0.01",
        minimumOrderSize: "5",
        makerFeeRate: "0",
        takerFeeRate: "0",
        parametersVersion: 1,
        settlementReadiness: { modelDependentActivationAllowed: false },
        openTime: "2026-03-04T12:00:00.000Z",
        closeTime: "2026-03-04T12:15:00.000Z",
        seriesKey: "btc-15m-updown",
        underlyingKey: "BTC",
        resolutionWindowKey: "w2026-03-04T12.15",
      },
    ],
    instances: [
      {
        instanceId: "a18f4a7e-2222-7abc-8def-0123456789ab",
        runId: "018f4a7e-3333-7abc-8def-0123456789ab",
        configId: "018f4a7e-4444-7abc-8def-0123456789ab",
        runSeed: "424242",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        ownership: "OWNER",
        evaluationPriority: 0,
        evaluationBudgetUs: 5000000,
        params: {
          entry: { trigger_feature_key: "polymarket.executable_buy_price@50" },
          exit: { stop: { trigger_feature_key: "polymarket.executable_sell_price@50" } },
          data_quality: { incident_feature_key: "quality.active_incidents@any" },
        },
      },
    ],
  };
}

/**
 * Installs a NON-ENUMERABLE inherited property and returns its remover.
 *
 * The descriptor is built PROTOTYPE-FREE, and that is not fastidiousness: under
 * an inherited `get`, `Object.defineProperty` with an ordinary object literal
 * THROWS ("Invalid property descriptor. Cannot both specify accessors and a
 * value or writable attribute") — schema-boundary §2's "Descriptor literals"
 * class, and the repository's recorded R8-1 residual that tooling itself trips
 * on it. A helper that fell over would make the battery measure the helper.
 */
function pollute(key: string, value: unknown): () => void {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = false;
  descriptor.configurable = true;
  Object.defineProperty(Object.prototype, key, descriptor);
  return () => {
    delete (Object.prototype as Record<string, unknown>)[key];
  };
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("parseTraderConfig", () => {
  it("accepts a complete configuration and answers a frozen value", () => {
    const parsed = parseTraderConfig(validConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.environment).toBe("PAPER");
    expect(Object.isFrozen(parsed.config)).toBe(true);
    expect(Object.isFrozen(parsed.config.markets)).toBe(true);
  });

  it("D4 — the emitted configuration has NO PROTOTYPE", () => {
    const parsed = parseTraderConfig(validConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.getPrototypeOf(parsed.config)).toBeNull();
    expect(Object.getPrototypeOf(parsed.config.accounting)).toBeNull();
  });

  it("REFUSES an unrecognised key rather than ignoring it", () => {
    const parsed = parseTraderConfig({ ...validConfig(), maxRunMode: "LIVE" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.code).toBe("TRADER_CONFIG_INVALID");
  });

  it("REFUSES a non-PAPER environment by name", () => {
    const parsed = parseTraderConfig({ ...validConfig(), environment: "LIVE" });
    expect(parsed.ok).toBe(false);
  });

  it("REFUSES a missing required field — nothing here is defaulted", () => {
    const config = validConfig();
    delete (config["queues"] as Record<string, unknown>)["ingestMaximumDepth"];
    const parsed = parseTraderConfig(config);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.issues.join("\n")).toContain("ingestMaximumDepth");
  });

  it("REFUSES a market whose settlement readiness is absent — §9.8 check 6 has no default", () => {
    const config = validConfig();
    const markets = config["markets"] as Record<string, unknown>[];
    delete markets[0]?.["settlementReadiness"];
    expect(parseTraderConfig(config).ok).toBe(false);
  });

  it("REFUSES a scope key that is not a CodeString — the risk engine types it that way", () => {
    const config = validConfig();
    const markets = config["markets"] as Record<string, unknown>[];
    if (markets[0] !== undefined) markets[0]["resolutionWindowKey"] = "2026-03-04T12:15";
    const parsed = parseTraderConfig(config);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.issues.join("\n")).toContain("CodeString");
  });

  /**
   * ADR-021's final step, measured (`TRDR-1`).
   *
   * `instanceId` used to be `UuidAndCodeString` — the UUID shape whose first
   * hex digit had to be a LETTER — because `packages/risk` and
   * `packages/capital-allocator` typed the same value `CodeStringSchema` while
   * `packages/ledger` and `packages/pnl` required `Uuidv7Schema`. Both of those
   * doors were re-typed (`WP-180-FU3` `8c14b47`, `ALLOC-1` `d9f70a6`), so this
   * door now delegates to `packages/domain`'s `Uuidv7Schema` itself.
   *
   * THE CHANGE MOVES IN TWO DIRECTIONS AND BOTH ARE PINNED HERE. It ADMITS the
   * `0`-leading population every honest mint produces, and it REFUSES the
   * wrong-version and wrong-variant UUIDs the old regex was blind to — measured
   * at the base of this change: `a18f4a7e-2222-4abc-8def-0123456789ab`, a
   * lowercase **v4**, was ACCEPTED at startup and refused only mid-run by the
   * risk door (ALLOC-1 review r1 L1). A startup door that defers a refusal to
   * the first intent is not a startup door.
   */
  describe("the instance id is an IDENTITY — a canonical UUIDv7 (ADR-021)", () => {
    function withInstanceId(value: string): Record<string, unknown> {
      const config = validConfig();
      const instances = config["instances"] as Record<string, unknown>[];
      if (instances[0] !== undefined) instances[0]["instanceId"] = value;
      return config;
    }

    it("ACCEPTS a minted `0`-leading UUIDv7 — the population the old door refused", () => {
      // A UUIDv7's first hex digit is the top nibble of its 48-bit millisecond
      // timestamp, which is `0` for every instant before ~2527. This is the id
      // a real generator produces, and it was refused at STARTUP until now.
      const parsed = parseTraderConfig(withInstanceId("018f4a7e-2222-7abc-8def-0123456789ab"));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.config.instances[0]?.instanceId).toBe(
        "018f4a7e-2222-7abc-8def-0123456789ab",
      );
    });

    it("ACCEPTS the letter-leading UUIDv7 the interim door minted — compatibility", () => {
      // ADR-021 Consequences: "Existing letter-leading UUIDv7 configurations
      // remain valid." The shipped example configuration and the e2e run both
      // use one, so this row is not hypothetical.
      expect(parseTraderConfig(withInstanceId("a18f4a7e-2222-7abc-8def-0123456789ab")).ok).toBe(
        true,
      );
    });

    it("REFUSES a letter-leading lowercase v4 — the version-blind hole, now closed", () => {
      const parsed = parseTraderConfig(withInstanceId("a18f4a7e-2222-4abc-8def-0123456789ab"));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.refusal.code).toBe("TRADER_CONFIG_INVALID");
      expect(parsed.refusal.issues.join("\n")).toContain("instances.0.instanceId");
      expect(parsed.refusal.issues.join("\n")).toContain("UUIDv7");
    });

    it("REFUSES a UUIDv7 whose VARIANT nibble is not RFC 9562's — also blind before", () => {
      // Version 7, letter lead, but the variant nibble is `c` rather than one
      // of `8`/`9`/`a`/`b`. The old regex saw only the shape.
      expect(parseTraderConfig(withInstanceId("a18f4a7e-2222-7abc-cdef-0123456789ab")).ok).toBe(
        false,
      );
    });

    it("REFUSES a non-UUID code string — no other door ever admitted one", () => {
      const parsed = parseTraderConfig(withInstanceId("strat-a"));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.refusal.issues.join("\n")).toContain("instances.0.instanceId");
    });

    it("REFUSES an UPPERCASE UUIDv7 — ADR-016 §2: refused, never case-folded", () => {
      expect(parseTraderConfig(withInstanceId("018F4A7E-2222-7ABC-8DEF-0123456789AB")).ok).toBe(
        false,
      );
    });

    it("the refusal makes NO stale cross-package claim (ALLOC-1 r1 L2)", () => {
      // The old message said "packages/risk types context.strategyInstanceId as
      // CodeStringSchema" and called the narrowing "a reported cross-package
      // conflict". Both were true when they were written and are false now;
      // an operator reading them would go and fix a package that is correct.
      const parsed = parseTraderConfig(withInstanceId("strat-a"));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      const issues = parsed.refusal.issues.join("\n");
      expect(issues).not.toContain("cross-package conflict");
      expect(issues).not.toContain("CodeStringSchema");
      expect(issues).not.toContain("FIRST hex digit is a letter");
      expect(issues).toContain("UUIDv7");
    });

    it("SKIPCHECKS: the IMPORTED format check stays on under pollution", () => {
      // The grammar now comes from `@polymarket-bot/domain` rather than from a
      // literal in this file, so what the arena copies is another package's
      // node. `schema-arena` records `skipChecks` as the class that silently
      // disables exactly this kind of check; permission must not vary.
      const config = withInstanceId("a18f4a7e-2222-4abc-8def-0123456789ab");
      expect(parseTraderConfig(config).ok).toBe(false);
      cleanups.push(pollute("skipChecks", true));
      expect(parseTraderConfig(config).ok).toBe(false);
    });
  });

  /**
   * Review round 2, MEDIUM-2 — the door's decimal grammar vs. the arithmetic's.
   *
   * At the r1 tip both decimal fields were hand-written regexes WIDER than
   * `@polymarket-bot/decimal`'s canonical form, and the gap was measured end to
   * end: `startingCash: "1000.00"` parsed `ok: true`, and the first fill threw
   * `InvalidDecimalStringError: subDecimal(a): "1000.00" is not a canonical
   * decimal string` out of `loop.drain()`, which has no `try`/`catch`. Fail-STOP
   * rather than a wrong number — the decimal package refuses instead of coercing
   * — but a refusal that names no field and arrives mid-run is not a door.
   */
  describe("economic fields are CANONICAL decimals, refused at the door", () => {
    it("REFUSES a non-canonical `accounting.startingCash`, naming the field", () => {
      const config = validConfig();
      (config["accounting"] as Record<string, unknown>)["startingCash"] = "1000.00";
      (config["simulation"] as Record<string, unknown>)["startingCash"] = "1000.00";
      const parsed = parseTraderConfig(config);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.refusal.code).toBe("TRADER_CONFIG_INVALID");
      const issues = parsed.refusal.issues.join("\n");
      expect(issues).toContain("accounting.startingCash");
      expect(issues).toContain("simulation.startingCash");
      // The message is the DECIMAL package's own, so the door and the
      // arithmetic cannot state different rules.
      expect(issues).toContain("canonical");
    });

    it("REFUSES the other non-canonical spellings the regex admitted", () => {
      // Leading zeros, a trailing decimal point, a redundant fractional zero,
      // a leading `+`, and `-0` for the SIGNED field.
      const cases: readonly (readonly [string, string])[] = [
        ["01000", "leading zero"],
        ["1000.", "trailing point"],
        ["0.0", "redundant fractional zero"],
        ["+1000", "leading plus"],
      ];
      for (const [value] of cases) {
        const config = validConfig();
        (config["accounting"] as Record<string, unknown>)["startingCash"] = value;
        (config["simulation"] as Record<string, unknown>)["startingCash"] = value;
        expect(parseTraderConfig(config).ok).toBe(false);
      }
      const negativeZero = validConfig();
      const scenarios = negativeZero["scenarios"] as Record<string, unknown>[];
      if (scenarios[0] !== undefined) scenarios[0]["yesPriceShock"] = "-0";
      expect(parseTraderConfig(negativeZero).ok).toBe(false);
    });

    it("REFUSES a NEGATIVE value where the field is non-negative", () => {
      const config = validConfig();
      (config["accounting"] as Record<string, unknown>)["startingCash"] = "-1";
      (config["simulation"] as Record<string, unknown>)["startingCash"] = "-1";
      const parsed = parseTraderConfig(config);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.refusal.issues.join("\n")).toContain(">= 0");
    });

    it("ACCEPTS a canonical negative shock — the signed field is still signed", () => {
      const config = validConfig();
      const scenarios = config["scenarios"] as Record<string, unknown>[];
      if (scenarios[0] !== undefined) scenarios[0]["yesPriceShock"] = "-0.1";
      expect(parseTraderConfig(config).ok).toBe(true);
    });

    it("the canonical door is what makes the cross-field `===` sound", () => {
      // Two spellings of ONE number can no longer reach `crossFieldRefusal`: the
      // grammar refuses the non-canonical one first, so a document that passes
      // it compares two strings that are equal exactly when the numbers are.
      const config = validConfig();
      (config["accounting"] as Record<string, unknown>)["startingCash"] = "1000";
      (config["simulation"] as Record<string, unknown>)["startingCash"] = "1000.00";
      const parsed = parseTraderConfig(config);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      // Refused by the GRAMMAR, not by the cross-field check — the two values
      // are numerically equal, and calling that "inconsistent" would be wrong.
      expect(parsed.refusal.code).toBe("TRADER_CONFIG_INVALID");
    });

    it("still REFUSES two genuinely different balances as INCONSISTENT", () => {
      const config = validConfig();
      (config["simulation"] as Record<string, unknown>)["startingCash"] = "999";
      const parsed = parseTraderConfig(config);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.refusal.code).toBe("TRADER_CONFIG_INCONSISTENT");
    });

    it("the canonical check is a CUSTOM check, and pollution does not skip it", () => {
      // The rule now lives in a `superRefine`, which is exactly the class
      // `schema-arena` records as having been silently disabled by an inherited
      // `when: () => false`. Permission must not vary.
      const config = validConfig();
      (config["accounting"] as Record<string, unknown>)["startingCash"] = "1000.00";
      (config["simulation"] as Record<string, unknown>)["startingCash"] = "1000.00";
      expect(parseTraderConfig(config).ok).toBe(false);
      cleanups.push(pollute("when", () => false));
      expect(parseTraderConfig(config).ok).toBe(false);
    });
  });

  it("D1 — REFUSES a value that is not plain own data", () => {
    const config = validConfig();
    Object.defineProperty(config, "accounting", {
      get: () => validConfig()["accounting"],
      enumerable: true,
      configurable: true,
    });
    const parsed = parseTraderConfig(config);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.code).toBe("TRADER_CONFIG_NOT_DATA");
  });

  it("D1 — REFUSES a Proxy, whose traps are caller code inside the door", () => {
    const parsed = parseTraderConfig(
      new Proxy(validConfig(), {
        get: (target, key) => Reflect.get(target, key) as unknown,
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.code).toBe("TRADER_CONFIG_NOT_DATA");
  });

  describe("the pollution battery — permission never varies (schema-boundary §4 item 5)", () => {
    it("ADOPTION: a non-enumerable inherited required field does NOT satisfy the schema", () => {
      const config = validConfig();
      delete (config["accounting"] as Record<string, unknown>)["accountRef"];
      // Clean: refused.
      expect(parseTraderConfig(config).ok).toBe(false);
      // Polluted: STILL refused. A door that adopted would accept here.
      cleanups.push(pollute("accountRef", "attacker-account"));
      const polluted = parseTraderConfig(config);
      expect(polluted.ok).toBe(false);
    });

    it("SKIPCHECKS: format checks stay on — a garbage market id is still refused", () => {
      const config = validConfig();
      const markets = config["markets"] as Record<string, unknown>[];
      if (markets[0] !== undefined) markets[0]["marketId"] = "NOT-A-UUID";
      expect(parseTraderConfig(config).ok).toBe(false);
      cleanups.push(pollute("skipChecks", true));
      expect(parseTraderConfig(config).ok).toBe(false);
    });

    it("REQUIRED-KEY WAIVER: inherited optin+optout does not waive a required key", () => {
      const config = validConfig();
      delete config["planning"];
      expect(parseTraderConfig(config).ok).toBe(false);
      cleanups.push(pollute("optin", "optional"));
      cleanups.push(pollute("optout", "optional"));
      expect(parseTraderConfig(config).ok).toBe(false);
    });

    it("CUSTOM CHECK SKIPPED: inherited `when` does not disable a refusal", () => {
      const config = validConfig();
      const markets = config["markets"] as Record<string, unknown>[];
      if (markets[0] !== undefined) markets[0]["tickSize"] = "not-a-decimal";
      expect(parseTraderConfig(config).ok).toBe(false);
      cleanups.push(pollute("when", () => false));
      expect(parseTraderConfig(config).ok).toBe(false);
    });

    it("A VALID configuration parses to the SAME values under pollution", () => {
      const clean = parseTraderConfig(validConfig());
      expect(clean.ok).toBe(true);
      cleanups.push(pollute("skipChecks", true));
      cleanups.push(pollute("accountRef", "attacker-account"));
      const polluted = parseTraderConfig(validConfig());
      expect(polluted.ok).toBe(true);
      if (!clean.ok || !polluted.ok) return;
      expect(polluted.config.accounting.accountRef).toBe("paper-account");
      expect(JSON.stringify(polluted.config)).toBe(JSON.stringify(clean.config));
    });

    it("NO THROW ESCAPES for any of these inputs, INCLUDING under an inherited `get`", () => {
      // MEASURE FIRST, ASSERT AFTER — and the ordering is itself a finding.
      //
      // Under an inherited `get`, vitest's OWN assertion path builds a property
      // descriptor from an object LITERAL and throws "Invalid property
      // descriptor. Cannot both specify accessors and a value or writable
      // attribute": schema-boundary §2's "Descriptor literals" class, and the
      // repository's recorded R8-1 residual that TOOLING trips on it
      // (corroborated here independently). So the battery runs while polluted,
      // the pollution is removed, and only then is the result asserted — an
      // assertion made under the pollution would measure the assertion library
      // rather than the door.
      const inputs: readonly unknown[] = [
        undefined,
        null,
        42,
        "string",
        [],
        {},
        validConfig(),
        Object.create(null) as unknown,
      ];
      const removeGet = pollute("get", () => undefined);
      const removeSkip = pollute("skipChecks", true);
      const thrown: string[] = [];
      const answers: unknown[] = [];
      for (const input of inputs) {
        try {
          const outcome = parseTraderConfig(input);
          answers.push(outcome.ok);
        } catch (cause) {
          thrown.push(cause instanceof Error ? cause.message : String(cause));
        }
      }
      removeSkip();
      removeGet();

      expect(thrown).toEqual([]);
      // Every answer is DATA: a discriminated result, never an exception.
      expect(answers).toHaveLength(inputs.length);
      for (const answer of answers) expect(typeof answer).toBe("boolean");
    });
  });
});

describe("configuredFeatureKeys", () => {
  it("collects every *_feature_key an instance configures, sorted and de-duplicated", () => {
    const parsed = parseTraderConfig(validConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(configuredFeatureKeys(parsed.config)).toEqual([
      "polymarket.executable_buy_price@50",
      "polymarket.executable_sell_price@50",
      "quality.active_incidents@any",
    ]);
  });
});

/**
 * `ROLLOVER-1` (ADR-030): a document may carry reviewed `series` and
 * `seriesInstances` — instances bound to a SERIES whose windows are admitted
 * at runtime — beside, or instead of, market-bound ones.
 */
describe("the series fields (ROLLOVER-1)", () => {
  const SERIES_INSTANCE = {
    instanceId: "b18f4a7e-5555-7abc-8def-0123456789ab",
    runId: "018f4a7e-6666-7abc-8def-0123456789ab",
    configId: "018f4a7e-7777-7abc-8def-0123456789ab",
    runSeed: "77",
    seriesId: "btc-15m-updown",
    ownership: "OWNER",
    evaluationPriority: 1,
    evaluationBudgetUs: 5000000,
    params: {
      entry: { trigger_feature_key: "polymarket.executable_buy_price@25" },
      exit: { stop: { trigger_feature_key: "polymarket.executable_sell_price@50" } },
      data_quality: { incident_feature_key: "quality.active_incidents@any" },
    },
  };

  function seriesOnly(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...validConfig(),
      markets: [],
      instances: [],
      series: [reviewedSeriesDocument()],
      seriesInstances: [SERIES_INSTANCE],
      ...overrides,
    };
  }

  function issuesOf(document: Record<string, unknown>): readonly string[] {
    const parsed = parseTraderConfig(document);
    return parsed.ok ? [] : parsed.refusal.issues;
  }

  it("accepts a series-only document, hashes each series, and counts series-bound feature keys", () => {
    const parsed = parseTraderConfig(seriesOnly());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const series = configuredSeries(parsed.config);
    expect(series.map((entry) => entry.series.seriesId)).toEqual(["btc-15m-updown"]);
    expect(series[0]?.configHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(configuredFeatureKeys(parsed.config)).toContain("polymarket.executable_buy_price@25");
  });

  it("accepts market-bound and series-bound instances side by side", () => {
    expect(parseTraderConfig(seriesOnly({ markets: validConfig()["markets"], instances: validConfig()["instances"] })).ok).toBe(true);
  });

  it("refuses a document with no instance at all, and market-bound instances with no market", () => {
    expect(issuesOf(seriesOnly({ seriesInstances: undefined, series: undefined }))).toContain(
      "instances, seriesInstances: at least one instance is required",
    );
    expect(issuesOf(seriesOnly({ instances: validConfig()["instances"] }))).toContain(
      "markets: a market-bound instance needs at least one configured market",
    );
  });

  it("refuses a series nothing trades, an instance naming an unreviewed series, two owners, a series twice", () => {
    expect(issuesOf(seriesOnly({ seriesInstances: undefined })).join("\n")).toContain("has no series-bound instance");
    expect(issuesOf(seriesOnly({ seriesInstances: [{ ...SERIES_INSTANCE, seriesId: "eth-15m-updown" }] })).join("\n")).toContain(
      "which this document does not review",
    );
    const second = { ...SERIES_INSTANCE, instanceId: "b18f4a7e-8888-7abc-8def-0123456789ab", runId: "018f4a7e-9999-7abc-8def-0123456789ab" };
    expect(issuesOf(seriesOnly({ seriesInstances: [SERIES_INSTANCE, second] })).join("\n")).toContain("OWNER instances");
    expect(issuesOf(seriesOnly({ series: [reviewedSeriesDocument(), reviewedSeriesDocument()] }))).toContain(
      "series: each seriesId may appear once",
    );
  });

  it("refuses a shared run id (each run's evaluation sequence is its own) and a shared instance id", () => {
    const market = validConfig();
    const marketInstance = (market["instances"] as Record<string, unknown>[])[0] ?? {};
    const sharedRun = seriesOnly({
      markets: market["markets"],
      instances: market["instances"],
      seriesInstances: [{ ...SERIES_INSTANCE, runId: marketInstance["runId"] }],
    });
    expect(issuesOf(sharedRun).join("\n")).toContain("each runId may appear once");
    const sharedInstance = seriesOnly({
      markets: market["markets"],
      instances: market["instances"],
      seriesInstances: [{ ...SERIES_INSTANCE, instanceId: marketInstance["instanceId"] }],
    });
    expect(issuesOf(sharedInstance).join("\n")).toContain("each instanceId may appear once");
  });

  it("refuses a series the reviewed-series schema refuses", () => {
    expect(parseTraderConfig(seriesOnly({ series: [{ ...reviewedSeriesDocument(), approved: true }] })).ok).toBe(false);
  });
});

/**
 * `V2-1` (ADR-030 Amendment 2 rule 2): the review's `acceptedProtocolVersions`
 * is required at the trader's configuration door too. A configuration written
 * before the field existed is REFUSED, naming the field and what to add —
 * never read as a default. The schema rule itself is pinned in `series.test.ts`.
 */
describe("the series' acceptedProtocolVersions at the configuration door (V2-1)", () => {
  const REFUSAL =
    'acceptedProtocolVersions is required: a non-empty list of distinct protocol versions, each "v1" or "v2" ' +
    '(ADR-030 Amendment 2 rule 2; e.g. ["v1"], or ["v1","v2"] once a review accepts V2 windows). It is never inferred';

  function withAccepted(accepted: unknown | undefined): Record<string, unknown> {
    const document = reviewedSeriesDocument();
    const parameters = { ...(document["parameters"] as Record<string, unknown>) };
    if (accepted === undefined) delete parameters["acceptedProtocolVersions"];
    else parameters["acceptedProtocolVersions"] = accepted;
    return { ...document, parameters };
  }

  function seriesOnly(series: Record<string, unknown>): Record<string, unknown> {
    const instance = (validConfig()["instances"] as Record<string, unknown>[])[0] ?? {};
    const rest = Object.fromEntries(Object.entries(instance).filter(([key]) => key !== "marketId"));
    return {
      ...validConfig(),
      markets: [],
      instances: [],
      series: [series],
      seriesInstances: [{ ...rest, seriesId: "btc-15m-updown" }],
    };
  }

  it("refuses a series without the field, naming it and what to add", () => {
    const parsed = parseTraderConfig(seriesOnly(withAccepted(undefined)));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.code).toBe("TRADER_CONFIG_INVALID");
      expect(parsed.refusal.issues).toContain(`series.0.parameters.acceptedProtocolVersions: ${REFUSAL}`);
    }
  });

  it("refuses an empty, duplicated or unknown list, and accepts a reviewed one, whose hash includes it", () => {
    for (const bad of [[], ["v1", "v1"], ["v3"], ["V2"], "v1"]) {
      expect(parseTraderConfig(seriesOnly(withAccepted(bad))).ok, JSON.stringify(bad)).toBe(false);
    }
    const v1 = parseTraderConfig(seriesOnly(withAccepted(["v1"])));
    const both = parseTraderConfig(seriesOnly(withAccepted(["v1", "v2"])));
    expect(v1.ok && both.ok).toBe(true);
    if (!v1.ok || !both.ok) return;
    expect(configuredSeries(v1.config)[0]?.configHash).toBe("27a746ce86cb3329920762611f47e7557a188a4a545ad991b0594333a7fcb759");
    expect(configuredSeries(both.config)[0]?.configHash).toBe("f833fbbca4aaf9c15f0025c041f80471f49aabff0b0979224c4e11518d2beb97");
  });
});
