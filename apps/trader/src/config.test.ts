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

import { configuredFeatureKeys, parseTraderConfig } from "./config.js";

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
      retentionMaxEvents: 100000,
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

  it("REFUSES an instance id that cannot satisfy BOTH merged doors, and says why", () => {
    const config = validConfig();
    const instances = config["instances"] as Record<string, unknown>[];
    // A genuinely-minted UUIDv7 begins with `0`: satisfies `packages/ledger`,
    // fails `packages/risk`'s CodeString. Refused at STARTUP with the conflict
    // named, rather than as a mid-run RISK_INPUT_INVALID.
    if (instances[0] !== undefined) {
      instances[0]["instanceId"] = "018f4a7e-2222-7abc-8def-0123456789ab";
    }
    const parsed = parseTraderConfig(config);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.issues.join("\n")).toContain("cross-package conflict");
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
