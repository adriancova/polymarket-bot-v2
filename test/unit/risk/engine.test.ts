/**
 * The §9.8 pipeline, check by check — and a proof that the package-owned
 * reason-code vocabulary has no dead entries.
 *
 * The table below drives ONE mutation of the fully-passing baseline per case
 * and asserts the code that mutation must produce. The final test then asserts
 * that the table (plus the four resize codes and three approval codes proven in
 * `acceptance.test.ts`) covers `RISK_REASON_CODES` exactly. A code that is
 * declared but unreachable, or emitted but undeclared, fails the suite — which
 * is what keeps a published vocabulary honest as an alerting surface (§14.3).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RISK_REASON_CODES,
  RISK_REASON_CODE_COUNT,
  evaluateIntent,
  isRiskReasonCode,
  parseRiskPolicy,
  resizeApprovedIntent,
  validateEvaluationInput,
  type ApprovedIntentRecord,
  type RiskPolicy,
  type RiskReasonCode,
} from "../../../packages/risk/src/index.js";
// The data-record boundary is INTERNAL (round 3's stance on new public surface
// stands), so the one case that must observe it directly imports the module.
import { readPlainData } from "../../../packages/risk/src/plain-data.js";
import {
  FIXTURE_MEASURING,
  MARKET_A,
  MARKET_B,
  VALID_UNTIL,
  allScenarios,
  cancelIntent,
  codesOf,
  entryInput,
  exitInput,
  exposureEntry,
  exposureSnapshot,
  market,
  openOrder,
  position,
  positionIntent,
  reduceIntent,
  riskPolicy,
  type EvaluationInputFixture,
} from "./fixtures.js";

interface Case {
  readonly code: RiskReasonCode;
  readonly name: string;
  readonly policy?: () => RiskPolicy;
  /** Returns the input to evaluate; mutate the baseline in place. */
  readonly build: () => unknown;
}

/**
 * THE ORACLES — review round 4, and the reason this file no longer contains an
 * `Object.entries` walk.
 *
 * Rounds 2 and 3 checked the package's identity property with a test walk built
 * on `Object.entries`, which is the primitive the PRODUCT used. That is not an
 * oracle: it can only see what the implementation can see, so it proved nothing
 * about a non-enumerable, inherited, or accessor-backed property — the three
 * shapes review round 4 got a contract-invalid identifier through. A property
 * proved with the implementation's own primitive is not proved.
 *
 * These two oracles are independent of the implementation in a specific,
 * checkable way:
 *
 * - {@link stringsIn} enumerates through `Reflect.ownKeys` plus property
 *   DESCRIPTORS, and it walks the PROTOTYPE CHAIN. It is therefore strictly
 *   more sighted than the walk any product code performs: it reports strings
 *   that are non-enumerable, that live on a prototype, and that sit behind a
 *   getter (reported as an accessor by {@link notPlainOwnFrozenData}, never
 *   invoked here — an oracle does not run the subject's code);
 * - {@link notPlainOwnFrozenData} checks a structural property the product
 *   never checks about its own output: that every object in an emitted record
 *   is plain-prototyped, own-data-only, and frozen. That is what makes the
 *   first oracle's extra sight decisive rather than incidental — on a value
 *   with no accessors, no inherited state and no hidden properties,
 *   "what `Object.entries` sees" and "what the value carries" are the same set,
 *   so proving the record is such a value closes the question that round 3's
 *   test could only assume.
 */
function stringsIn(value: unknown, path = ""): { path: string; value: string }[] {
  const found: { path: string; value: string }[] = [];
  const visit = (node: unknown, at: string, ancestors: Set<unknown>): void => {
    if (typeof node === "string") {
      found.push({ path: at, value: node });
      return;
    }
    if (node === null || typeof node !== "object" || ancestors.has(node)) return;
    ancestors.add(node);
    const isArray = Array.isArray(node);
    for (
      let level: object | null = node;
      level !== null && level !== Object.prototype && level !== Array.prototype;
      level = Object.getPrototypeOf(level) as object | null
    ) {
      for (const key of Reflect.ownKeys(level)) {
        if (typeof key !== "string") continue;
        if (isArray && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(level, key);
        if (descriptor === undefined || !("value" in descriptor)) continue;
        visit(
          descriptor.value,
          isArray ? `${at}[${key}]` : at === "" ? key : `${at}.${key}`,
          ancestors,
        );
      }
    }
    ancestors.delete(node);
  };
  visit(value, path, new Set());
  return found;
}

/**
 * Every way `value` fails to be a plain, own-data, deeply frozen record.
 *
 * STRENGTHENED IN REVIEW ROUND 6, not relaxed. An emitted record's objects must
 * now have NO PROTOTYPE AT ALL, where this oracle previously required exactly
 * `Object.prototype`. The reason is the round-6 finding that `Object.prototype`
 * is reachable state: a record that inherits from it answers for names nobody
 * put in it, and `zod` will even ADOPT such a name into a parse output. `null`
 * is strictly less state than `Object.prototype`, so every record that passes
 * this oracle now would have passed it before; the converse is false, which is
 * what makes this a stronger assertion rather than an accommodation.
 */
function notPlainOwnFrozenData(value: unknown, path = "record"): string[] {
  const findings: string[] = [];
  const visit = (node: unknown, at: string, ancestors: Set<unknown>): void => {
    if (node === null || typeof node !== "object" || ancestors.has(node)) return;
    ancestors.add(node);
    const isArray = Array.isArray(node);
    const prototype: unknown = Object.getPrototypeOf(node);
    if (prototype !== (isArray ? Array.prototype : null)) {
      findings.push(`${at}: non-plain prototype`);
    }
    if (!Object.isFrozen(node)) findings.push(`${at}: not frozen`);
    for (const key of Reflect.ownKeys(node)) {
      if (typeof key === "symbol") {
        findings.push(`${at}: symbol-keyed property ${String(key)}`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor === undefined) continue;
      const memberPath = isArray ? `${at}[${key}]` : `${at}.${key}`;
      if (!("value" in descriptor)) {
        findings.push(`${memberPath}: accessor property`);
        continue;
      }
      if (!descriptor.enumerable && !(isArray && key === "length")) {
        findings.push(`${memberPath}: non-enumerable property`);
      }
      visit(descriptor.value, memberPath, ancestors);
    }
    ancestors.delete(node);
  };
  visit(value, path, new Set());
  return findings;
}

function withEntry(mutate: (input: EvaluationInputFixture) => void): () => unknown {
  return () => {
    const input = entryInput();
    mutate(input);
    return input;
  };
}

function withExit(mutate: (input: EvaluationInputFixture) => void): () => unknown {
  return () => {
    const input = exitInput();
    mutate(input);
    return input;
  };
}

const CASES: readonly Case[] = [
  // --- input validation ----------------------------------------------------
  {
    code: "RISK_INPUT_INVALID",
    name: "an unvalidated object is refused, never partially checked",
    build: () => ({ intent: { type: "POSITION" } }),
  },
  {
    code: "RISK_UUID_NOT_CANONICAL",
    name: "a UUID-shaped, non-lowercase approvedIntentId (ADR-016 §2)",
    build: withEntry((input) => {
      input.identifiers.approvedIntentId = "01890000-0000-7000-8000-0000000000AB";
    }),
  },
  {
    code: "RISK_INTENT_EXPIRED",
    name: "validUntil before the caller-supplied evaluation instant",
    build: withEntry((input) => {
      input.intent = { ...input.intent, validUntil: "2026-09-02T11:00:00.000Z" };
    }),
  },
  {
    code: "RISK_ZERO_DELTA",
    name: "a position intent that resolves to no share delta",
    build: withEntry((input) => {
      input.intent = { ...input.intent, targetShares: "0" };
    }),
  },
  {
    code: "RISK_MARKET_CONTEXT_MISSING",
    name: "no market context for a market the intent touches",
    build: withEntry((input) => {
      input.markets = [];
    }),
  },

  // --- §9.8 checks 1–4 -----------------------------------------------------
  {
    code: "RISK_RUN_STATE_BLOCKS",
    name: "check 1: the run state does not permit the intent",
    build: withEntry((input) => {
      input.context.runStatePermitsIntent = false;
    }),
  },
  {
    code: "RISK_STRATEGY_STATE_BLOCKS",
    name: "check 1: the strategy state does not permit the intent",
    build: withEntry((input) => {
      input.context.strategyStatePermitsIntent = false;
    }),
  },
  {
    code: "RISK_RUN_MODE_EXCEEDS_MAXIMUM",
    name: "check 2: a run mode above the process maximum",
    build: withEntry((input) => {
      input.context.runMode = "SHADOW";
    }),
  },
  {
    code: "RISK_REAL_ORDER_SURFACE_UNSUPPORTED",
    name: "check 3: this package cannot verify real-order enablement or fencing",
    policy: () => riskPolicy({ maxRunMode: "LIVE" }),
    build: withEntry((input) => {
      input.context.runMode = "LIVE_MICRO";
    }),
  },
  {
    code: "RISK_VENUE_ELIGIBILITY_UNVERIFIED",
    name: "check 4: venue eligibility is not a verified ELIGIBLE result",
    policy: () => riskPolicy({ maxRunMode: "LIVE" }),
    build: withEntry((input) => {
      input.context.runMode = "LIVE_MICRO";
    }),
  },

  // --- §9.8 checks 5–6 -----------------------------------------------------
  {
    code: "RISK_MARKET_NOT_ACCEPTING",
    name: "check 5: a halted market accepts no orders",
    build: withEntry((input) => {
      input.markets = [market({ status: "HALTED" })];
    }),
  },
  {
    code: "RISK_MARKET_STATUS_UNKNOWN",
    name: "check 5: an UNKNOWN market status blocks (fail closed)",
    build: withEntry((input) => {
      input.markets = [market({ status: "UNKNOWN" })];
    }),
  },
  {
    code: "RISK_MARKET_CLOSE_ONLY",
    name: "check 5: a close-only market blocks new entries",
    build: withEntry((input) => {
      input.markets = [market({ status: "CLOSE_ONLY" })];
    }),
  },
  {
    code: "RISK_SETTLEMENT_UNVERIFIED",
    name: "check 6: model-dependent activation is not permitted for this market",
    build: withEntry((input) => {
      input.markets = [market({ settlement: { modelDependentActivationAllowed: false } })];
    }),
  },

  // --- §9.8 check 7: freshness --------------------------------------------
  {
    code: "RISK_FEATURES_STALE",
    name: "check 7: stale features block an entry",
    build: withEntry((input) => {
      input.freshness = [
        { feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 100 },
        { feed: "REFERENCE_FEED", ageMs: 100 },
        { feed: "FEATURES", ageMs: 5000 },
      ];
    }),
  },
  {
    code: "RISK_REFERENCE_FEED_STALE",
    name: "check 7: a stale external reference feed blocks an entry",
    build: withEntry((input) => {
      input.freshness = [
        { feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 100 },
        { feed: "REFERENCE_FEED", ageMs: 5000 },
        { feed: "FEATURES", ageMs: 100 },
      ];
    }),
  },
  {
    code: "RISK_BOOK_STALE",
    name: "check 7: a stale venue book blocks an entry",
    build: withEntry((input) => {
      input.freshness = [
        { feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 5000 },
        { feed: "REFERENCE_FEED", ageMs: 100 },
        { feed: "FEATURES", ageMs: 100 },
      ];
    }),
  },
  {
    code: "RISK_FRESHNESS_UNKNOWN",
    name: "check 7: an UNMEASURED feed is treated exactly like a stale one",
    build: withEntry((input) => {
      input.freshness = [];
    }),
  },
  {
    code: "RISK_BOOK_STALE_NO_BLIND_REDUCTION",
    name: "check 7 + §6 invariant 12: a stale book blocks a REDUCTION too",
    build: withExit((input) => {
      input.freshness = [
        { feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 5000 },
        { feed: "REFERENCE_FEED", ageMs: 100 },
        { feed: "FEATURES", ageMs: 100 },
      ];
    }),
  },

  // --- §9.8 checks 8–11 ----------------------------------------------------
  {
    code: "RISK_BOOK_NOT_SYNCHRONIZED",
    name: "check 8: the local book is not confirmed synchronized",
    build: withEntry((input) => {
      input.markets = [market({ bookSynchronized: false })];
    }),
  },
  {
    code: "RISK_TRADING_PARAMETERS_UNKNOWN",
    name: "check 9: an unknown tick size is not a known parameter set",
    build: withEntry((input) => {
      const context = market();
      delete context.tickSize;
      input.markets = [context];
    }),
  },
  {
    code: "RISK_PRICE_NOT_TICK_CONFORMANT",
    name: "check 10: a limit price off the tick grid",
    build: withEntry((input) => {
      input.intent = { ...input.intent, maximumBuyPrice: "0.505" };
    }),
  },
  {
    code: "RISK_SIZE_BELOW_MINIMUM",
    name: "check 11: a leg below the market minimum order size",
    build: withEntry((input) => {
      input.intent = { ...input.intent, targetShares: "1" };
    }),
  },
  {
    code: "RISK_NOTIONAL_BELOW_ECONOMIC_FLOOR",
    name: "check 11: an entry below the configured economic floor",
    policy: () => riskPolicy({ economics: { minOrderNotional: "100" } }),
    build: withEntry(() => {}),
  },

  // --- §9.8 checks 12–13 ---------------------------------------------------
  {
    code: "RISK_NET_EDGE_NOT_POSITIVE",
    name: "check 12: edge does not survive fees, slippage, and the risk buffer",
    build: withEntry((input) => {
      input.intent = { ...input.intent, expectedNetEdge: "0.1" };
    }),
  },
  {
    code: "RISK_EDGE_INPUTS_MISSING",
    name: "check 12: an unsupplied fee estimate is not a zero fee",
    build: withEntry((input) => {
      input.economics = {};
    }),
  },
  {
    code: "RISK_PARTICIPATION_LIMIT_EXCEEDED",
    name: "check 13: more shares than the participation limit permits",
    policy: () => riskPolicy({ participation: { maxOrderShares: "10" } }),
    build: withEntry(() => {}),
  },

  // --- §9.8 check 14 -------------------------------------------------------
  {
    code: "RISK_ALLOCATION_REFUSED",
    name: "check 14: the capital allocator refused the commitment",
    build: withEntry((input) => {
      input.allocation = {
        permitted: false,
        refusals: [{ code: "CAPITAL_COLLATERAL_INSUFFICIENT" }],
      };
    }),
  },
  {
    code: "RISK_ALLOCATION_VERDICT_MISSING",
    name: "check 14: no allocator verdict supplied for an entry (fail closed)",
    build: withEntry((input) => {
      delete input.allocation;
    }),
  },
  {
    code: "RISK_SELL_EXCEEDS_INVENTORY",
    name: "check 14 + §6 invariant 10: selling more than the confirmed holding",
    build: withEntry((input) => {
      input.intent = { ...input.intent, targetShares: "-200" };
      input.portfolio.positions = [];
    }),
  },
  {
    code: "RISK_QUOTE_MAX_INVENTORY_EXCEEDED",
    name: "check 14: a quote ladder that would breach its own maximumInventory",
    build: withEntry((input) => {
      input.intent = {
        type: "QUOTE",
        intentId: "intent-q",
        marketId: MARKET_A,
        bids: [{ price: "0.5", shares: "100" }],
        asks: [],
        postOnly: true,
        quoteLifetimeMs: 5000,
        replaceThresholdTicks: 1,
        maximumInventory: "10",
        tags: [],
      };
    }),
  },

  // --- §9.8 check 15 -------------------------------------------------------
  {
    code: "RISK_PER_ORDER_NOTIONAL_EXCEEDED",
    name: "check 15: the intent's bounded notional exceeds the per-order limit",
    policy: () =>
      riskPolicy({ limits: { maxWorstCaseContractualLoss: "10000", maxOrderNotional: "10" } }),
    build: withEntry(() => {}),
  },
  {
    code: "RISK_GLOBAL_EXPOSURE_EXCEEDED",
    name: "check 15: the global exposure cap",
    policy: () =>
      riskPolicy({ limits: { maxWorstCaseContractualLoss: "10000", globalExposureCap: "10" } }),
    build: withEntry((input) => {
      input.exposures = exposureSnapshot({ global: exposureEntry("5", "0") });
    }),
  },
  {
    code: "RISK_INSTANCE_EXPOSURE_EXCEEDED",
    name: "check 15: the per-strategy-instance cap",
    policy: () =>
      riskPolicy({
        limits: { maxWorstCaseContractualLoss: "10000", perInstanceExposureCap: "10" },
      }),
    build: withEntry((input) => {
      input.exposures = exposureSnapshot({ measuring: FIXTURE_MEASURING });
    }),
  },
  {
    code: "RISK_MARKET_EXPOSURE_EXCEEDED",
    name: "check 15: the per-market cap",
    policy: () =>
      riskPolicy({ limits: { maxWorstCaseContractualLoss: "10000", perMarketExposureCap: "10" } }),
    build: withEntry((input) => {
      input.exposures = exposureSnapshot({ measuring: FIXTURE_MEASURING });
    }),
  },
  {
    code: "RISK_SERIES_EXPOSURE_EXCEEDED",
    name: "check 15: the per-series cap",
    policy: () =>
      riskPolicy({ limits: { maxWorstCaseContractualLoss: "10000", perSeriesExposureCap: "10" } }),
    build: withEntry((input) => {
      input.exposures = exposureSnapshot({ measuring: FIXTURE_MEASURING });
    }),
  },
  {
    code: "RISK_UNDERLYING_EXPOSURE_EXCEEDED",
    name: "check 15: the per-underlying cap",
    policy: () =>
      riskPolicy({
        limits: { maxWorstCaseContractualLoss: "10000", perUnderlyingExposureCap: "10" },
      }),
    build: withEntry((input) => {
      input.exposures = exposureSnapshot({ measuring: FIXTURE_MEASURING });
    }),
  },
  {
    code: "RISK_RESOLUTION_WINDOW_EXPOSURE_EXCEEDED",
    name: "check 15: the per-resolution-window cap",
    policy: () =>
      riskPolicy({
        limits: { maxWorstCaseContractualLoss: "10000", perResolutionWindowExposureCap: "10" },
      }),
    build: withEntry((input) => {
      input.exposures = exposureSnapshot({ measuring: FIXTURE_MEASURING });
    }),
  },
  {
    code: "RISK_EXPOSURE_SNAPSHOT_MISSING",
    name: "check 15: a configured cap with no snapshot is not a passed cap",
    policy: () =>
      riskPolicy({ limits: { maxWorstCaseContractualLoss: "10000", globalExposureCap: "10000" } }),
    build: withEntry((input) => {
      delete input.exposures;
    }),
  },
  {
    code: "RISK_EXPOSURE_ENTRY_MISSING",
    name: "check 15: a configured cap whose queried scope the snapshot omits is not a passed cap",
    policy: () =>
      riskPolicy({
        // Deliberately roomy: if the omitted entry really were zero the intent
        // would PASS. It must not — an absent entry is unknown, not zero.
        limits: { maxWorstCaseContractualLoss: "10000", perMarketExposureCap: "10000" },
      }),
    build: withEntry((input) => {
      input.exposures = exposureSnapshot({ byMarket: {} });
    }),
  },
  {
    code: "RISK_SCOPE_KEY_MISSING",
    name: "check 15: a scope cap the request cannot be attributed to (fail closed)",
    policy: () =>
      riskPolicy({
        limits: { maxWorstCaseContractualLoss: "10000", perSeriesExposureCap: "10000" },
      }),
    build: withEntry((input) => {
      const context = market();
      delete context.scope;
      input.markets = [context];
      input.exposures = exposureSnapshot({});
    }),
  },

  // --- §9.8 check 16: the PRIMARY measure ----------------------------------
  {
    code: "RISK_WORST_CASE_LOSS_EXCEEDED",
    name: "check 16: maximum contractual loss over the primary limit",
    policy: () => riskPolicy({ limits: { maxWorstCaseContractualLoss: "10" } }),
    build: withEntry(() => {}),
  },
  {
    code: "RISK_WORST_CASE_RESOLUTION_LOSS_EXCEEDED",
    name: "check 16: worst-case resolution loss over the three verified outcomes",
    policy: () =>
      riskPolicy({
        limits: { maxWorstCaseContractualLoss: "10000", maxWorstCaseResolutionLoss: "10" },
      }),
    build: withEntry(() => {}),
  },
  {
    code: "RISK_WORST_CASE_UNBOUNDED",
    name: "check 16: an intent that bounds no maximum cost",
    build: withEntry((input) => {
      const intent = { ...input.intent };
      delete intent["maximumBuyPrice"];
      input.intent = intent;
    }),
  },
  {
    code: "RISK_BASKET_LEG_UNBOUNDED",
    name: "check 16: a buying basket leg with no price ceiling",
    build: withEntry((input) => {
      input.intent = {
        type: "BASKET",
        intentId: "intent-b",
        legs: [{ marketId: MARKET_A, direction: "YES", targetShares: "100" }],
        maximumCombinedCost: "100",
        minimumLockedEdge: "1",
        legRiskLimit: "10",
        failurePolicy: "ABANDON",
        validUntil: VALID_UNTIL,
      };
    }),
  },

  // --- §9.8 check 17 -------------------------------------------------------
  {
    code: "RISK_SCENARIO_LOSS_EXCEEDED",
    name: "check 17: the worst supplied scenario exceeds its limit",
    policy: () => riskPolicy({ scenario: { maxScenarioLoss: "1" } }),
    build: withEntry(() => {}),
  },
  {
    code: "RISK_SCENARIO_MISSING",
    name: "check 17: a required shock kind was not supplied",
    build: withEntry((input) => {
      input.scenarios = allScenarios().slice(0, 3);
    }),
  },
  {
    code: "RISK_SCENARIO_MARKS_INCOMPLETE",
    name: "check 17: a scenario that does not mark every held market",
    build: withEntry((input) => {
      input.scenarios = allScenarios("0.4", [MARKET_B]);
    }),
  },

  // --- §9.8 checks 18–20 ---------------------------------------------------
  {
    code: "RISK_DUPLICATE_INTENT",
    name: "check 18: the intentId was already evaluated",
    build: withEntry((input) => {
      input.guards.recentIntentIds = ["intent-1"];
    }),
  },
  {
    code: "RISK_SELF_TRADE",
    name: "check 18: the intent would cross the account's own resting order",
    build: withEntry((input) => {
      input.portfolio.openOrders = [
        openOrder({ orderId: "o-self", action: "SELL", price: "0.45", shares: "10" }),
      ];
      input.portfolio.positions = [position({ shares: "10", costBasis: "0" })];
    }),
  },
  {
    code: "RISK_RATE_LIMIT_HEADROOM_INSUFFICIENT",
    name: "check 19: headroom at or below the safety reserve",
    build: withEntry((input) => {
      input.rateLimit.availableRequests = 5;
    }),
  },
  {
    code: "RISK_RATE_LIMIT_UNKNOWN",
    name: "check 19: unknown headroom is not sufficient headroom",
    build: withEntry((input) => {
      delete input.rateLimit.availableRequests;
    }),
  },
  {
    code: "RISK_TIME_TO_CLOSE_ENTRY_BLOCKED",
    name: "check 20: inside the configured entry cutoff",
    build: withEntry((input) => {
      input.markets = [market({ secondsToClose: 30 })];
    }),
  },
  {
    code: "RISK_TIME_TO_CLOSE_UNKNOWN",
    name: "check 20: unknown time to close blocks an entry",
    build: withEntry((input) => {
      const context = market();
      delete context.secondsToClose;
      input.markets = [context];
    }),
  },

  // --- §6 invariant 12 -----------------------------------------------------
  {
    code: "RISK_POSITION_STATE_UNKNOWN",
    name: "a reduction on a market the supplied portfolio does not describe",
    build: withExit((input) => {
      input.portfolio.positions = [];
    }),
  },
];

describe("§9.8 pipeline — every check refuses with its own code", () => {
  for (const testCase of CASES) {
    it(`${testCase.code}: ${testCase.name}`, () => {
      const policy = (testCase.policy ?? riskPolicy)();
      const result = evaluateIntent(policy, testCase.build());
      expect(result.approved).toBe(false);
      expect(codesOf(result)).toContain(testCase.code);
    });
  }
});

describe("the reason-code vocabulary", () => {
  /**
   * Proven in `acceptance.test.ts` rather than by the table above: the three
   * APPROVAL reasons (which appear on a record, not on a refusal) and the four
   * RESIZE codes (which `resizeApprovedIntent` emits, not the pipeline).
   */
  const PROVEN_ELSEWHERE: readonly RiskReasonCode[] = [
    "RISK_APPROVED",
    "RISK_CANCEL_ALWAYS_PERMITTED",
    "RISK_EXIT_CAPACITY_CHECKS_INAPPLICABLE",
    "RISK_RESIZE_NOT_A_REDUCTION",
    "RISK_RESIZE_ID_REUSED",
    "RISK_RESIZE_UNSUPPORTED_TYPE",
    "RISK_RESIZE_INCOHERENT",
  ];

  it("has no dead entries: every declared code is reachable", () => {
    const covered = new Set<string>([...CASES.map((c) => c.code), ...PROVEN_ELSEWHERE]);
    const unreachable = RISK_REASON_CODES.filter((code) => !covered.has(code));
    expect(unreachable).toEqual([]);
  });

  it("emits no undeclared code", () => {
    for (const testCase of CASES) {
      const policy = (testCase.policy ?? riskPolicy)();
      const result = evaluateIntent(policy, testCase.build());
      for (const code of codesOf(result)) {
        expect(isRiskReasonCode(code)).toBe(true);
      }
    }
  });

  it("every code fits the frozen CodeString grammar (§14.3 metric labels)", () => {
    for (const code of RISK_REASON_CODES) {
      expect(code).toMatch(/^[A-Za-z][A-Za-z0-9_.:-]*$/u);
      expect(code.length).toBeLessThanOrEqual(64);
    }
  });

  it("declares each code exactly once", () => {
    expect(new Set(RISK_REASON_CODES).size).toBe(RISK_REASON_CODES.length);
  });

  /**
   * CARDINALITY PIN (review round 1, MEDIUM).
   *
   * The no-dead-entry test above proves reachability against whatever the list
   * currently is; it cannot notice that the DOCUMENTED count has drifted from
   * it — and it had: the handoff claimed 56 against a 61-entry list.
   *
   * WHAT THESE TWO TESTS ACTUALLY BIND (corrected in remediation round 2 —
   * review round 2, LOW): three surfaces, `RISK_REASON_CODES`,
   * `RISK_REASON_CODE_COUNT`, and `packages/risk/README.md` §5. The earlier
   * comment also claimed `docs/handoffs/WP-180.md`, which neither test reads —
   * the claim was wrong, and this is the corrected statement of it.
   *
   * That the handoff stays UNBOUND is deliberate, not an omission. It is an
   * append-only historical record of a work package, dated round by round; a
   * suite that parsed it would oblige every FUTURE package that adds a reason
   * code to edit a closed package's governance record, which is the opposite of
   * how handoffs are maintained here. The living documentation is the package
   * README, and that is what is machine-bound. The handoff's number is prose,
   * verified at review time — which is exactly how the round-1 drift was found.
   */
  it("matches its documented cardinality exactly (list, constant, README §5)", () => {
    expect(RISK_REASON_CODES.length).toBe(RISK_REASON_CODE_COUNT);
    expect(RISK_REASON_CODE_COUNT).toBe(62);
  });

  it("the README documents every declared code, and declares every documented one", () => {
    const readme = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/risk/README.md"),
      "utf8",
    );
    const documented = new Set(
      [...readme.matchAll(/`(RISK_[A-Z0-9_]+)`/gu)].map((match) => match[1] as string),
    );
    // `RISK_`-prefixed names that are NOT reason codes: the list's own name, its
    // count, and (review round 7) the policy door's declared default table,
    // which README §4.7 names because a consumer reading about the checks that
    // vanished under prototype pollution needs to know where the floor comes
    // from. Each exclusion is a NAME this package exports, never a code.
    documented.delete("RISK_REASON_CODES");
    documented.delete("RISK_REASON_CODE_COUNT");
    documented.delete("RISK_POLICY_DEFAULTS");
    expect(RISK_REASON_CODES.filter((code) => !documented.has(code))).toEqual([]);
    expect([...documented].filter((code) => !isRiskReasonCode(code))).toEqual([]);
    expect(documented.size).toBe(RISK_REASON_CODE_COUNT);
  });
});

describe("refusals accumulate rather than short-circuit", () => {
  it("reports every independent failure in §9.8 order, not just the first", () => {
    const input = entryInput();
    input.context.runStatePermitsIntent = false;
    input.markets = [market({ status: "HALTED" })];
    input.rateLimit.availableRequests = 0;

    const codes = codesOf(evaluateIntent(riskPolicy(), input));

    expect(codes).toContain("RISK_RUN_STATE_BLOCKS");
    expect(codes).toContain("RISK_MARKET_NOT_ACCEPTING");
    expect(codes).toContain("RISK_RATE_LIMIT_HEADROOM_INSUFFICIENT");
    // §9.8 order is preserved, so the cheapest check appears first.
    expect(codes.indexOf("RISK_RUN_STATE_BLOCKS")).toBeLessThan(
      codes.indexOf("RISK_MARKET_NOT_ACCEPTING"),
    );
    expect(codes.indexOf("RISK_MARKET_NOT_ACCEPTING")).toBeLessThan(
      codes.indexOf("RISK_RATE_LIMIT_HEADROOM_INSUFFICIENT"),
    );
  });
});

describe("run-mode safety floors", () => {
  it("PAPER is the default maximum and nothing in this package raises it", () => {
    expect(riskPolicy().maxRunMode).toBe("PAPER");
  });

  for (const runMode of ["EXECUTION_PROBE", "LIVE_MICRO", "LIVE"] as const) {
    it(`refuses a ${runMode} intent even when a caller configured maxRunMode: LIVE`, () => {
      const input = entryInput();
      input.context.runMode = runMode;
      const result = evaluateIntent(riskPolicy({ maxRunMode: "LIVE" }), input);
      expect(result.approved).toBe(false);
      expect(codesOf(result)).toContain("RISK_REAL_ORDER_SURFACE_UNSUPPORTED");
    });
  }

  it("an ELIGIBLE venue result still does not unlock a real-order mode here", () => {
    const input = entryInput();
    input.context.runMode = "LIVE";
    input.context.venueEligibility = "ELIGIBLE";
    const result = evaluateIntent(riskPolicy({ maxRunMode: "LIVE" }), input);
    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_REAL_ORDER_SURFACE_UNSUPPORTED");
    expect(codesOf(result)).not.toContain("RISK_VENUE_ELIGIBILITY_UNVERIFIED");
  });
});

describe("disposition matrix", () => {
  it("an EXIT is not gated by capacity, edge, participation, or time-to-close", () => {
    const policy = riskPolicy({
      limits: { maxWorstCaseContractualLoss: "1", globalExposureCap: "1", maxOrderNotional: "1" },
      participation: { maxOrderShares: "1" },
      economics: { minOrderNotional: "1000" },
      scenario: { maxScenarioLoss: "0" },
    });
    const input = exitInput();
    input.markets = [market({ secondsToClose: 1 })];
    input.rateLimit.availableRequests = 0;

    const result = evaluateIntent(policy, input);

    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.reasons).toContain("RISK_EXIT_CAPACITY_CHECKS_INAPPLICABLE");
  });

  it("an EXIT still reports its worst case, even though the limit is not enforced on it", () => {
    const policy = riskPolicy({ limits: { maxWorstCaseContractualLoss: "1" } });
    const result = evaluateIntent(policy, exitInput());
    expect(result.approved).toBe(true);
    expect(result.worstCase?.maximumContractualLoss).toBe("40");
  });

  it("a CANCEL bypasses every gate but still carries a worst-case measure", () => {
    const input = entryInput();
    input.intent = { type: "CANCEL", reason: "kill switch" };
    input.markets = [];
    input.freshness = [];
    input.rateLimit = {};
    input.economics = {};
    delete input.allocation;

    const result = evaluateIntent(riskPolicy(), input);

    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.reasons).toEqual(["RISK_APPROVED", "RISK_CANCEL_ALWAYS_PERMITTED"]);
    expect(result.record.worstCase.maximumContractualLoss).toBe("0");
  });

  /**
   * CORRECTED IN REMEDIATION ROUND 1 (review round 1, BLOCKER 1).
   *
   * This test previously asserted the OPPOSITE — that a run-mode mismatch
   * refuses a CANCEL — and so encoded the defect as the contract. §6 invariant
   * 13 ("Safety cancellation outranks new order placement") admits no such
   * exception: a blocked cancel can trap a position, which is the failure the
   * invariant exists to prevent. The mismatch is now a non-blocking
   * OBSERVATION on `cancelPriorityOverrides` and the cancel is approved.
   */
  it("a CANCEL is NOT refused when the run mode exceeds the process maximum (§6 invariant 13)", () => {
    const input = entryInput();
    input.intent = { type: "CANCEL", reason: "kill switch" };
    input.context.runMode = "LIVE";

    const result = evaluateIntent(riskPolicy(), input);

    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.reasons).toContain("RISK_CANCEL_ALWAYS_PERMITTED");
    // The gate still RAN and is still visible; it simply did not block.
    expect(result.cancelPriorityOverrides.map((r) => r.code)).toEqual([
      "RISK_RUN_MODE_EXCEEDS_MAXIMUM",
    ]);
    // The record honestly names the mode the caller asked for.
    expect(result.record.runMode).toBe("LIVE");
  });
});

/**
 * §6 INVARIANT 13, gate by gate.
 *
 * Remediation round 1 audited EVERY gate in `evaluateIntent` for the
 * "a cancel can be blocked" defect class, not only the two the reviewer cited.
 * The three RISK GATES below are the ones that could reach a `CANCEL` at all;
 * every other gate is already guarded by `placesOrders` / `isEntry` / a
 * disposition test, or is structurally unreachable for a cancel (a cancel has
 * no legs, no `intentId`, and no `validUntil`). The last test drives all three
 * at once, plus every other hostile input, so the structural choke point — not
 * three separate conditions — is what is pinned.
 *
 * The audit's fourth finding, `RISK_UUID_NOT_CANONICAL`, is no longer a gate:
 * review round 2 ruled it INPUT VALIDATION, which a cancel does not bypass.
 * See the following describe block.
 */
describe("§6 invariant 13 — a CANCEL survives every audited gate", () => {
  interface GateCase {
    readonly name: string;
    readonly overriddenCode: string;
    readonly trip: (input: EvaluationInputFixture) => void;
  }

  const GATES: readonly GateCase[] = [
    {
      name: "check 2: the run mode exceeds the configured process maximum",
      overriddenCode: "RISK_RUN_MODE_EXCEEDS_MAXIMUM",
      trip: (input) => {
        input.context.runMode = "LIVE";
      },
    },
    {
      name: "check 14: the capital allocator explicitly REFUSED",
      overriddenCode: "RISK_ALLOCATION_REFUSED",
      trip: (input) => {
        input.allocation = {
          permitted: false,
          refusals: [{ code: "CAPITAL_COLLATERAL_INSUFFICIENT" }],
        };
      },
    },
    {
      name: "no market context was supplied for the market being cancelled",
      overriddenCode: "RISK_MARKET_CONTEXT_MISSING",
      trip: (input) => {
        input.markets = [];
      },
    },
    /**
     * CORRECTED IN REMEDIATION ROUND 2 (review round 2, BLOCKER).
     *
     * A fourth case lived here: *"the approvedIntentId is UUID-shaped but not
     * canonical (ADR-016 §2)"*, asserting that the identity violation was
     * OVERRIDDEN and the cancel approved. That encoded the defect as the
     * contract — the approved record was then emitted carrying the
     * non-canonical id, which ADR-016 §2 forbids. Review round 2 ruled that
     * §6 invariant 13 protects a VALID cancel from risk policy and does not
     * require accepting a malformed identity, so the check moved to input
     * validation. Its replacement is the describe block below, which asserts
     * the opposite outcome (a typed REFUSAL, no record) rather than deleting
     * the coverage.
     */
  ];

  for (const gate of GATES) {
    it(`is approved despite ${gate.name}`, () => {
      const input = entryInput();
      input.intent = cancelIntent();
      gate.trip(input);

      const result = evaluateIntent(riskPolicy(), input);

      expect(codesOf(result)).toEqual([]);
      expect(result.approved).toBe(true);
      if (!result.approved) return;
      expect(result.cancelPriorityOverrides.map((r) => r.code)).toContain(gate.overriddenCode);
    });
  }

  it("a CANCEL survives every audited gate, all tripped at once", () => {
    const policy = riskPolicy({
      limits: {
        maxWorstCaseContractualLoss: "0",
        globalExposureCap: "0",
        perInstanceExposureCap: "0",
        perMarketExposureCap: "0",
        maxOrderNotional: "0",
      },
      scenario: { maxScenarioLoss: "0" },
      participation: { maxOrderShares: "1" },
    });
    const input = entryInput();
    input.intent = cancelIntent();
    // Every state flag, feed, peer view, and headroom input hostile at once.
    input.context.runMode = "LIVE";
    input.context.runStatePermitsIntent = false;
    input.context.strategyStatePermitsIntent = false;
    input.context.venueEligibility = "BLOCKED";
    // A VALID identity, deliberately UUID-shaped and canonical: the cancel path
    // must stay open for a well-formed request (remediation round 2 moved the
    // ADR-016 §2 check to input validation, so a non-canonical id here would
    // now refuse at the door and prove nothing about the choke point).
    input.identifiers.approvedIntentId = "01890000-0000-7000-8000-0000000000ab";
    input.markets = [];
    input.freshness = [];
    input.portfolio = { positions: [position()], openOrders: [] };
    input.allocation = {
      permitted: false,
      refusals: [{ code: "CAPITAL_COLLATERAL_INSUFFICIENT" }],
    };
    delete input.exposures;
    input.scenarios = [];
    input.guards.recentIntentIds = ["intent-1"];
    input.rateLimit = {};
    input.economics = {};

    const result = evaluateIntent(policy, input);

    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.reasons).toEqual(["RISK_APPROVED", "RISK_CANCEL_ALWAYS_PERMITTED"]);
    // The measure is still computed and returned, from the portfolio alone.
    expect(result.record.worstCase.maximumContractualLoss).toBe("40");
    // Every gate that fired is visible, and NONE of them blocked.
    const overridden = result.cancelPriorityOverrides.map((r) => r.code);
    // An input-validation refusal is NOT overridable, so none may appear here.
    expect(overridden).not.toContain("RISK_UUID_NOT_CANONICAL");
    expect(overridden).not.toContain("RISK_INPUT_INVALID");
    expect(overridden).toContain("RISK_RUN_MODE_EXCEEDS_MAXIMUM");
    expect(overridden).toContain("RISK_MARKET_CONTEXT_MISSING");
    expect(overridden).toContain("RISK_ALLOCATION_REFUSED");
    for (const code of overridden) {
      expect(isRiskReasonCode(code)).toBe(true);
    }
  });

  it("an ENTRY and an EXIT never carry overrides — only a CANCEL can", () => {
    const entry = evaluateIntent(riskPolicy(), entryInput());
    expect(entry.approved).toBe(true);
    if (entry.approved) expect(entry.cancelPriorityOverrides).toEqual([]);

    const exit = evaluateIntent(riskPolicy(), exitInput());
    expect(exit.approved).toBe(true);
    if (exit.approved) expect(exit.cancelPriorityOverrides).toEqual([]);
  });

  it("the only thing a CANCEL cannot bypass is input validation itself", () => {
    // Until the input parses there is no disposition to privilege, and an
    // unparseable request names no orders to cancel.
    const result = evaluateIntent(riskPolicy(), { intent: { type: "CANCEL" } });
    expect(result.approved).toBe(false);
    expect(codesOf(result)).toEqual(["RISK_INPUT_INVALID"]);
  });

  /**
   * REVIEW ROUND 7, BLOCKER — a GET-ONLY inherited field may not trap a cancel.
   *
   * The reviewer's probe, kept as a mandatory case. `Object.prototype.reason` is
   * defined as a GET-ONLY accessor and nothing else changes: the caller's
   * `intent.reason` is its own valid string, the materialized input is intact,
   * and the schema reports success. But `zod` assembles its output BY
   * ASSIGNMENT, and an assignment that finds an inherited get-only accessor does
   * not write — so the field vanished from the output, and remediation round 6's
   * "the output is smaller than the input" check refused the whole request:
   *
   * ```text
   * clean:    approved=true, codes=[]
   * polluted: validateOk=false, approved=false
   * code:     RISK_INPUT_INVALID
   * lost:     ["input.intent.reason"]
   * getterCalls=0
   * ```
   *
   * The lost field was an artefact of the LIBRARY'S output assembly, not of the
   * caller's input, so this is a VALID cancel and §6 invariant 13 protects it.
   * Round 7 stopped reading that output at all: the door validates the
   * materialized tree and then USES the materialized tree. The assertions are the
   * reviewer's own — `approved=true`, and ZERO getter invocations, because
   * nothing in either package reads that name through a prototype.
   */
  describe("a get-only inherited field never traps a valid CANCEL (round 7 BLOCKER)", () => {
    /** Every name whose get-only inherited accessor refused a CANCEL at round 6. */
    const TRAPPED_AT_ROUND_6 = [
      "reason", // the reviewer's own probe: the CANCEL's own field
      "marketId",
      "type",
      "bookSynchronized",
      "allocation",
      "approvedIntentId",
    ] as const;

    function withGetOnly<T>(key: string, body: () => T): { readonly value: T; readonly calls: number } {
      let calls = 0;
      Object.defineProperty(Object.prototype, key, {
        get(): unknown {
          calls += 1;
          return "1000";
        },
        enumerable: false,
        configurable: true,
      });
      try {
        return { value: body(), calls };
      } finally {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }

    for (const key of TRAPPED_AT_ROUND_6) {
      it(`is approved, with ZERO getter calls, under a get-only Object.prototype.${key}`, () => {
        const input = entryInput();
        input.intent = cancelIntent();
        const clean = evaluateIntent(riskPolicy(), input);
        expect(clean.approved).toBe(true);

        const polluted = withGetOnly(key, () => ({
          validated: validateEvaluationInput(input),
          evaluation: evaluateIntent(riskPolicy(), input),
        }));

        expect(polluted.value.validated.ok).toBe(true);
        expect(codesOf(polluted.value.evaluation)).toEqual([]);
        expect(polluted.value.evaluation.approved).toBe(true);
        expect(polluted.calls).toBe(0);
        // and the answer is the same answer, not merely another approval
        expect(JSON.stringify(polluted.value.evaluation)).toBe(JSON.stringify(clean));
      });
    }

    it("the harness really does pollute: a naive read of the same name sees it", () => {
      // Non-vacuity. If the descriptor were not installed, every case above
      // would pass for the wrong reason.
      const seen = withGetOnly("reason", () => ({} as Record<string, unknown>)["reason"]);
      expect(seen.value).toBe("1000");
      expect(seen.calls).toBe(1);
      expect(Object.hasOwn(Object.prototype, "reason")).toBe(false);
    });
  });

  /**
   * REVIEW ROUND 8, BLOCKER — an inherited SETTER may not trap a cancel either.
   *
   * Round 7 stopped every door READING the library's parse output. Round 8's
   * reviewer showed that was necessary and not sufficient: discarding the output
   * does not stop the library BUILDING it, and it builds it by ASSIGNMENT onto
   * an ordinary object — so an inherited setter runs, and a THROWING one aborts
   * the parse. The probe, verbatim, against the round-7 tip:
   *
   * ```text
   * a valid CANCEL carrying its own `reason: "kill switch"`,
   * with a non-enumerable configurable THROWING setter at Object.prototype.reason
   *   → setterCalls=1, approved=false, codes=["RISK_INPUT_INVALID"]
   * ```
   *
   * "Ignore an assembly failure and answer valid" is NOT the fix: the library
   * validates and assigns key by key, so an abort leaves every LATER key
   * unvalidated, and that answer would admit an input nobody checked (measured —
   * see `schema-arena.ts`). The fix is that the assembly can no longer reach a
   * polluted prototype: each door parses through a copy whose containers and
   * parse context have none.
   *
   * The assertions below are the reviewer's own, in both setter modes: the
   * answer must be BYTE-IDENTICAL to the clean one, and the setter invocation
   * count must be reported — it is ZERO.
   */
  describe("an inherited SETTER never traps a valid CANCEL (round 8 BLOCKER)", () => {
    const KEYS = [
      "reason", // the reviewer's own probe: the CANCEL's own field
      "marketId",
      "type",
      "intent",
      "evaluatedAt",
      "identifiers",
      "approvedIntentId",
    ] as const;

    function withSetter<T>(
      key: string,
      mode: "accepting" | "throwing",
      body: () => T,
    ): { readonly value: T | string; readonly threw: boolean; readonly setterCalls: number } {
      let setterCalls = 0;
      Object.defineProperty(Object.prototype, key, {
        get(): unknown {
          return "INHERITED";
        },
        set(): void {
          setterCalls += 1;
          if (mode === "throwing") throw new TypeError("inherited-setter");
        },
        enumerable: false,
        configurable: true,
      });
      try {
        return { value: body(), threw: false, setterCalls };
      } catch (error) {
        return { value: `THREW ${String(error)}`, threw: true, setterCalls };
      } finally {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }

    for (const mode of ["accepting", "throwing"] as const) {
      for (const key of KEYS) {
        it(`is approved BYTE-IDENTICALLY under an ${mode} Object.prototype.${key}, with ZERO setter calls`, () => {
          const input = entryInput();
          input.intent = cancelIntent();
          const clean = evaluateIntent(riskPolicy(), input);
          expect(clean.approved).toBe(true);

          const polluted = withSetter(key, mode, () => ({
            validated: validateEvaluationInput(input).ok,
            evaluation: JSON.stringify(evaluateIntent(riskPolicy(), input)),
          }));

          expect(polluted.threw).toBe(false);
          expect(polluted.setterCalls).toBe(0);
          expect(typeof polluted.value === "string" ? polluted.value : polluted.value.validated).toBe(
            true,
          );
          expect(
            typeof polluted.value === "string" ? polluted.value : polluted.value.evaluation,
          ).toBe(JSON.stringify(clean));
        });
      }
    }

    it("the harness really does pollute: a naive assembly invokes the setter and throws", () => {
      // Non-vacuity, in the shape of the defect itself: an ordinary object being
      // assembled by assignment is exactly what the library was doing.
      const accepted = withSetter("reason", "accepting", () => {
        const out: Record<string, unknown> = {};
        out["reason"] = "kill switch";
        return Object.hasOwn(out, "reason");
      });
      expect(accepted.setterCalls).toBe(1);
      expect(accepted.value).toBe(false); // the write never landed on the object

      const thrown = withSetter("reason", "throwing", () => {
        const out: Record<string, unknown> = {};
        out["reason"] = "kill switch";
        return "no throw";
      });
      expect(thrown.threw).toBe(true);
      expect(thrown.setterCalls).toBe(1);
      expect(Object.hasOwn(Object.prototype, "reason")).toBe(false);
    });

    it("a MALFORMED cancel is still refused under the same pollution (no fail-open)", () => {
      // The other half of the BLOCKER: the fix may not buy the cancel's approval
      // by skipping validation. A cancel whose `evaluatedAt` is not a timestamp
      // is refused, polluted or not, and with the same code.
      const input = entryInput();
      input.intent = cancelIntent();
      input.evaluatedAt = "not-a-timestamp";
      const clean = evaluateIntent(riskPolicy(), input);
      expect(clean.approved).toBe(false);
      expect(codesOf(clean)).toEqual(["RISK_INPUT_INVALID"]);

      for (const mode of ["accepting", "throwing"] as const) {
        const polluted = withSetter(mode === "accepting" ? "reason" : "intent", mode, () =>
          JSON.stringify(evaluateIntent(riskPolicy(), input)),
        );
        expect(polluted.threw, mode).toBe(false);
        expect(polluted.value, mode).toBe(JSON.stringify(clean));
      }
    });
  });
});

/**
 * ADR-016 §2 IDENTITY VALIDATION — the other side of the invariant-13 line.
 *
 * REVIEW ROUND 2, BLOCKER. Remediation round 1 left this check inside the §9.8
 * pipeline, where the cancel choke point turned it into a non-blocking
 * override: a `CANCEL` carrying a UUID-shaped, NON-CANONICAL `approvedIntentId`
 * was APPROVED and the id was copied verbatim into the emitted record. The
 * reviewer ruled that ADR-016 §2 requires a typed refusal AT AN INPUT SURFACE
 * and explicitly forbids accepting uppercase UUIDs "for lookup or persistence";
 * that `evaluateIntent(policy, input: unknown)` is such a surface; and that
 * "safety cancellation outranks new order placement" does not authorize
 * emitting a contract-invalid approved record. §6 invariant 13 protects a VALID
 * cancel from being trapped by risk POLICY — it does not require accepting a
 * malformed identity.
 *
 * The sweep the reviewer asked for found the defect in FIVE record fields, from
 * THREE input fields: `approvedIntentId` → `approvedIntentId` +
 * `rootApprovedIntentId`, `intent.intentId` → `sourceIntentId` +
 * `intent.intentId`, and `context.strategyInstanceId` → `strategyInstanceId`.
 * The last test states the property directly over emitted records rather than
 * enumerating the sites, so a NEW field copied from unvalidated input is caught
 * without anyone remembering to add a case.
 *
 * CORRECTION, 2026-09-03 (review round 3). The last claim above was TOO STRONG
 * as this block wrote it. These tests mutate the ENGINE'S INPUT, which the door
 * validates, and then resize a record the ENGINE built — so the resize path's
 * own input, a HAND-BUILT record, was never driven hostile beyond four named
 * fields. Review round 3 found a sixth (`record.intent.marketId`) that this
 * battery cannot see, and remediation round 3's probe found 43 further
 * positions. The property is now enforced structurally at the emission boundary
 * and pinned by the block BELOW, which generates its cases from a record's own
 * shape instead of from any list. Everything in this block still holds and is
 * unmodified.
 */
describe("ADR-016 §2 — record identity is INPUT VALIDATION, never a cancel override", () => {
  /** UUID-shaped, non-canonical. */
  const NON_CANONICAL = "01890000-0000-7000-8000-0000000000AB";
  /** The same value canonically spelled. It must never be PRODUCED from it. */
  const CANONICAL = "01890000-0000-7000-8000-0000000000ab";
  /** `CodeString` must start with a letter, so a code-shaped UUID starts at `f`. */
  const NON_CANONICAL_CODE = "f1890000-0000-7000-8000-0000000000AB";
  const CANONICAL_CODE = "f1890000-0000-7000-8000-0000000000ab";

  /**
   * An INDEPENDENT oracle — deliberately not the package's own guard, so a
   * mutation of `guards.ts` cannot make these tests agree with the defect.
   */
  const UUID_SHAPE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
  const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  function nonCanonicalUuid(value: string): boolean {
    return UUID_SHAPE.test(value) && !UUID_CANONICAL.test(value);
  }

  // Every string reachable in a value is found by the module-scope `stringsIn`
  // ORACLE (see its comment): descriptor-based and prototype-chain-walking, so
  // it is strictly more sighted than any walk the package performs. Round 3's
  // block-local `Object.entries` copy was removed in round 4, which found that
  // primitive blind to three shapes the product also missed.

  /**
   * The ONLY strings an emitted record may carry non-canonically: VENUE-supplied
   * opaque identifiers (§7.2 `VenueOrderId`). ADR-016 §2's amendment says the
   * ruling "does not touch any venue wire format (venue identifiers are not
   * UUIDs; their rules are ADR-015's)", and its premise — every UUID here is
   * generated in-process — is false for them. A test below proves this
   * exclusion is exact and non-vacuous.
   */
  const VENUE_ID_PATH = /^intent\.orderIds\[\d+\]$/u;

  interface IdentityCase {
    readonly field: string;
    readonly hostile: (input: EvaluationInputFixture) => void;
    readonly valid: (input: EvaluationInputFixture) => void;
  }

  const IDENTITY_FIELDS: readonly IdentityCase[] = [
    {
      field: "identifiers.approvedIntentId",
      hostile: (input) => {
        input.identifiers.approvedIntentId = NON_CANONICAL;
      },
      valid: (input) => {
        input.identifiers.approvedIntentId = CANONICAL;
      },
    },
    {
      field: "context.strategyInstanceId",
      hostile: (input) => {
        input.context.strategyInstanceId = NON_CANONICAL_CODE;
      },
      valid: (input) => {
        input.context.strategyInstanceId = CANONICAL_CODE;
      },
    },
    {
      field: "intent.intentId",
      hostile: (input) => {
        input.intent = { ...input.intent, intentId: NON_CANONICAL };
      },
      valid: (input) => {
        input.intent = { ...input.intent, intentId: CANONICAL };
      },
    },
    {
      field: "guards.recentIntentIds[0]",
      hostile: (input) => {
        input.guards.recentIntentIds = [NON_CANONICAL];
      },
      valid: (input) => {
        input.guards.recentIntentIds = [CANONICAL];
      },
    },
  ];

  it("REVIEWER'S PROBE: a CANCEL with a non-canonical approvedIntentId is REFUSED, with no record", () => {
    const input = entryInput();
    input.intent = cancelIntent();
    input.identifiers.approvedIntentId = NON_CANONICAL;

    const result = evaluateIntent(riskPolicy(), input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toEqual(["RISK_UUID_NOT_CANONICAL"]);
    // No approved arm at all — not an approval carrying an observation.
    expect(result).not.toHaveProperty("record");
    expect(result).not.toHaveProperty("cancelPriorityOverrides");
  });

  for (const identity of IDENTITY_FIELDS) {
    it(`refuses ${identity.field}, naming the field and carrying the RAW value`, () => {
      const input = entryInput();
      identity.hostile(input);

      const result = evaluateIntent(riskPolicy(), input);

      expect(result.approved).toBe(false);
      expect(codesOf(result)).toEqual(["RISK_UUID_NOT_CANONICAL"]);
      const refusal = result.refusals[0];
      expect(refusal?.details["field"]).toBe(identity.field);
      expect(nonCanonicalUuid(String(refusal?.details["value"]))).toBe(true);
    });
  }

  it("refuses identically for an ENTRY, an EXIT, and a CANCEL — before a disposition exists", () => {
    for (const build of [entryInput, exitInput, () => ({ ...entryInput(), intent: cancelIntent() })]) {
      const input = build() as EvaluationInputFixture;
      input.identifiers.approvedIntentId = NON_CANONICAL;
      const result = evaluateIntent(riskPolicy(), input);
      expect(result.approved).toBe(false);
      expect(codesOf(result)).toEqual(["RISK_UUID_NOT_CANONICAL"]);
    }
  });

  it("reports EVERY identity violation at once — the door does not short-circuit", () => {
    const input = entryInput();
    for (const identity of IDENTITY_FIELDS) identity.hostile(input);

    const result = evaluateIntent(riskPolicy(), input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toEqual(IDENTITY_FIELDS.map(() => "RISK_UUID_NOT_CANONICAL"));
    expect(result.refusals.map((r) => r.details["field"])).toEqual(
      IDENTITY_FIELDS.map((identity) => identity.field),
    );
  });

  it("NEVER case-folds: no canonical form of the id appears anywhere in the result", () => {
    const input = entryInput();
    input.identifiers.approvedIntentId = NON_CANONICAL;

    const result = evaluateIntent(riskPolicy(), input);

    const seen = stringsIn(result).map((s) => s.value);
    expect(seen).toContain(NON_CANONICAL);
    expect(seen).not.toContain(CANONICAL);
  });

  it("resizeApprovedIntent refuses a non-canonical identity INHERITED from a hand-built record", () => {
    const approved = evaluateIntent(riskPolicy(), entryInput());
    expect(approved.approved).toBe(true);
    if (!approved.approved) return;

    for (const field of [
      "approvedIntentId",
      "rootApprovedIntentId",
      "sourceIntentId",
      "strategyInstanceId",
    ] as const) {
      const handBuilt = { ...approved.record, [field]: NON_CANONICAL } as ApprovedIntentRecord;
      const resized = resizeApprovedIntent(handBuilt, {
        approvedIntentId: CANONICAL,
        resizedAt: "2026-09-03T12:00:01.000Z",
        newTargetShares: "50",
        reason: "shrink",
      });
      expect(resized.ok).toBe(false);
      if (resized.ok) return;
      expect(resized.refusals.map((r) => r.code)).toContain("RISK_UUID_NOT_CANONICAL");
      expect(resized.refusals.map((r) => r.details["field"])).toContain(`record.${field}`);
    }
  });

  it("a canonical lowercase UUID in every identity field is ACCEPTED and copied verbatim", () => {
    const input = entryInput();
    for (const identity of IDENTITY_FIELDS) identity.valid(input);
    // The duplicate guard must not fire on this canonical entry.
    input.guards.recentIntentIds = [];

    const result = evaluateIntent(riskPolicy(), input);

    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.approvedIntentId).toBe(CANONICAL);
    expect(result.record.rootApprovedIntentId).toBe(CANONICAL);
    expect(result.record.sourceIntentId).toBe(CANONICAL);
    expect(result.record.strategyInstanceId).toBe(CANONICAL_CODE);
  });

  it("a VENUE-supplied opaque orderId is out of ADR-016 §2's scope and never blocks a cancel", () => {
    const input = entryInput();
    input.intent = cancelIntent({ orderIds: [NON_CANONICAL] });

    const result = evaluateIntent(riskPolicy(), input);

    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    // Round-tripped byte for byte: a venue string is the venue's spelling.
    expect(result.record.intent).toMatchObject({ orderIds: [NON_CANONICAL] });
    // …and it is the ONLY non-canonical string the record carries, at exactly
    // the declared venue path (the exclusion is exact, and non-vacuous).
    expect(stringsIn(result.record).filter((s) => nonCanonicalUuid(s.value))).toEqual([
      { path: "intent.orderIds[0]", value: NON_CANONICAL },
    ]);
  });

  it("THE BINDING PROPERTY: no path emits an approved record carrying a non-canonical id", () => {
    const dispositions: readonly ((input: EvaluationInputFixture) => void)[] = [
      () => undefined,
      (input) => {
        input.intent = reduceIntent();
        input.portfolio.positions = [position()];
      },
      (input) => {
        input.intent = cancelIntent();
      },
    ];

    const offending: { path: string; value: string }[] = [];
    let recordsEmitted = 0;

    for (const setDisposition of dispositions) {
      for (const identity of [...IDENTITY_FIELDS.map((f) => f.hostile), () => undefined]) {
        const input = entryInput();
        setDisposition(input);
        identity(input);

        const result = evaluateIntent(riskPolicy(), input);
        if (!result.approved) continue;
        recordsEmitted += 1;
        offending.push(
          ...stringsIn(result.record).filter(
            (s) => nonCanonicalUuid(s.value) && !VENUE_ID_PATH.test(s.path),
          ),
        );

        // The resize path emits records too, and inherits identity fields.
        const resized = resizeApprovedIntent(result.record, {
          approvedIntentId: CANONICAL,
          resizedAt: "2026-09-03T12:00:01.000Z",
          newTargetShares: "50",
          reason: "shrink",
        });
        if (!resized.ok) continue;
        recordsEmitted += 1;
        offending.push(
          ...stringsIn(resized.value).filter(
            (s) => nonCanonicalUuid(s.value) && !VENUE_ID_PATH.test(s.path),
          ),
        );
      }
    }

    expect(offending).toEqual([]);
    // NON-VACUITY: the battery really did emit records to inspect.
    expect(recordsEmitted).toBeGreaterThanOrEqual(3);
  });
});

/**
 * THE EMISSION BOUNDARY — review round 3.
 *
 * FINDING. `resizeApprovedIntent` validated a LIST of seven inherited identity
 * fields and then copied the WHOLE intent into the new record, so a hand-built
 * record with `intent.marketId = "01890000-…-AB"` resized cleanly and the
 * emitted record carried the contract-invalid id
 * (`{"ok":true,"emittedMarketId":"01890000-0000-7000-8000-0000000000AB"}`).
 * Rounds 2 and 3 each fixed a list and each left the property false, so the
 * list is gone: `sealApprovedIntentRecord` WALKS the record being emitted, and
 * the resize walks the record it inherits, checking every string at every depth
 * except the closed `NON_IDENTITY_KEYS` set (venue ids, `DetailString` prose,
 * strategy tags — each a contract-typed non-identifier).
 *
 * WHY THIS BLOCK IS DIFFERENT FROM THE ONE ABOVE. Its cases are GENERATED from
 * a real record's own shape: it walks a valid record, drives every string
 * position hostile in turn, and asserts the outcome per position. A seventh
 * identity field added tomorrow becomes a new position with no edit here — that
 * is the mechanism the previous two rounds lacked, and it is what makes
 * "no record-emitting path emits an unvalidated identity" a property of the
 * code's shape rather than of a maintained list.
 */
describe("the emission boundary — a record is never built from an unvalidated identity", () => {
  const NON_CANONICAL = "01890000-0000-7000-8000-0000000000AB";
  /** Letter-leading, so it satisfies `CodeString`/`Tag` too. */
  const NON_CANONICAL_CODE = "f1890000-0000-7000-8000-0000000000AB";
  const CANONICAL = "01890000-0000-7000-8000-0000000000ab";

  /** An INDEPENDENT oracle, as in the block above. */
  const UUID_SHAPE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
  const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  function nonCanonicalUuid(value: string): boolean {
    return UUID_SHAPE.test(value) && !UUID_CANONICAL.test(value);
  }

  // The cases below use the module-scope `stringsIn` ORACLE. This block used to
  // define its own `Object.entries` copy; review round 4 found that primitive
  // blind to exactly the shapes the product's walk was blind to, so a test
  // written on it could not have failed where the product failed.

  /**
   * The property names a record may legitimately carry a non-canonical
   * UUID-shaped string under, written INDEPENDENTLY of the package's own set so
   * that widening `NON_IDENTITY_KEYS` in `approved-intent.ts` does not silently
   * widen what these tests accept. Each names the schema that types it as a
   * non-identifier: `VenueOrderIdSchema` (`CancelIntentSchema.orderIds`),
   * `DetailStringSchema` (`reason`, `resizeReason`, and — since round 4 —
   * `IncidentActionRecommendationSchema.rationale`), and `TagSchema` (§7.7
   * `tags`).
   *
   * SINGULAR `orderId` WAS REMOVED IN ROUND 4: no field an approved-intent
   * record can carry is typed `VenueOrderId` under that name, and the
   * repository's own `execution.orders` table has an in-process
   * `order_id internal.uuid_v7` beside a separate `venue_order_id` column, so
   * the name does not imply "venue".
   */
  const EXCLUDED_KEY = /(^|\.)(orderIds\[\d+\]|reason|resizeReason|rationale|tags\[\d+\])$/u;

  const REQUEST = {
    approvedIntentId: CANONICAL,
    resizedAt: "2026-09-03T12:00:01.000Z",
    newTargetShares: "50",
    reason: "shrink",
  };

  function approvedRecord(mutate: (input: EvaluationInputFixture) => void): ApprovedIntentRecord {
    const input = entryInput();
    mutate(input);
    const result = evaluateIntent(riskPolicy(), input);
    if (!result.approved) throw new Error(`fixture not approved: ${codesOf(result).join(",")}`);
    return result.record;
  }

  /** A POSITION record whose intent also carries a strategy tag. */
  function positionRecord(): ApprovedIntentRecord {
    return approvedRecord((input) => {
      input.intent = positionIntent({ tags: ["alpha"] });
    });
  }

  /** A REDUCE_POSITION record: carries `intent.reason`, and no `intentId`. */
  function reductionRecord(): ApprovedIntentRecord {
    return approvedRecord((input) => {
      input.intent = reduceIntent({ targetShares: "100" });
      input.portfolio.positions = [position()];
    });
  }

  /** A record carrying a recommendation — `marketId` AND free-text `rationale`. */
  function recommendingRecord(): ApprovedIntentRecord {
    return {
      ...positionRecord(),
      recommendations: [
        {
          kind: "RECOMMENDATION",
          action: "CANCEL_RESTING_ORDERS",
          failureClass: "VENUE_BOOK_STALE",
          ordersScope: "MARKET",
          marketId: MARKET_A,
          rationale: '§9.9: "Cancel resting orders; no blind aggressive orders"',
        },
      ],
    };
  }

  /** A deep clone of `record` with the string at `path` replaced. */
  function withStringAt(
    record: ApprovedIntentRecord,
    path: string,
    value: string,
  ): ApprovedIntentRecord {
    const clone = structuredClone(record) as unknown as Record<string, unknown>;
    const steps = path.replace(/\[(\d+)\]/gu, ".$1").split(".");
    let cursor: Record<string, unknown> = clone;
    for (const step of steps.slice(0, -1)) {
      cursor = cursor[step] as Record<string, unknown>;
    }
    cursor[steps[steps.length - 1] as string] = value;
    return clone as unknown as ApprovedIntentRecord;
  }

  it("REVIEWER'S PROBE (round 3): a POSITION resize refuses a non-canonical INHERITED intent.marketId", () => {
    const handBuilt = withStringAt(positionRecord(), "intent.marketId", NON_CANONICAL);

    const resized = resizeApprovedIntent(handBuilt, REQUEST);

    expect(resized.ok).toBe(false);
    if (resized.ok) return;
    expect(resized.refusals.map((r) => r.code)).toContain("RISK_UUID_NOT_CANONICAL");
    const identity = resized.refusals.find((r) => r.code === "RISK_UUID_NOT_CANONICAL");
    expect(identity?.details["field"]).toBe("record.intent.marketId");
    // The RAW value rides out; no canonical form is ever produced.
    expect(identity?.details["value"]).toBe(NON_CANONICAL);
    expect(stringsIn(resized).map((s) => s.value)).not.toContain(CANONICAL.toLowerCase());
  });

  it("the same for a REDUCE_POSITION resize (the §7.7 shape with no intentId)", () => {
    const handBuilt = withStringAt(reductionRecord(), "intent.marketId", NON_CANONICAL);

    const resized = resizeApprovedIntent(handBuilt, REQUEST);

    expect(resized.ok).toBe(false);
    if (resized.ok) return;
    expect(resized.refusals.map((r) => r.details["field"])).toContain("record.intent.marketId");
  });

  it("worstCase.perMarket[].marketId — an internal id NO field list had named — is refused", () => {
    const handBuilt = withStringAt(
      positionRecord(),
      "worstCase.perMarket[0].marketId",
      NON_CANONICAL,
    );

    const resized = resizeApprovedIntent(handBuilt, REQUEST);

    expect(resized.ok).toBe(false);
    if (resized.ok) return;
    expect(resized.refusals.map((r) => r.details["field"])).toContain(
      "record.worstCase.perMarket[0].marketId",
    );
  });

  it("recommendations[].marketId is refused; its free-text rationale is not an identifier", () => {
    const hostileId = withStringAt(recommendingRecord(), "recommendations[0].marketId", NON_CANONICAL);
    const refused = resizeApprovedIntent(hostileId, REQUEST);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusals.map((r) => r.details["field"])).toContain(
      "record.recommendations[0].marketId",
    );

    const hostileProse = withStringAt(
      recommendingRecord(),
      "recommendations[0].rationale",
      NON_CANONICAL,
    );
    const allowed = resizeApprovedIntent(hostileProse, REQUEST);
    expect(allowed.ok).toBe(true);
  });

  it("a hand-built intent that is not a §7.7 intent is a TYPED refusal, never a throw", () => {
    // Before this round `compareDecimal` threw `InvalidDecimalStringError` out
    // of a function whose entire contract is to return a typed result.
    const handBuilt = withStringAt(positionRecord(), "intent.targetShares", "not-a-decimal");

    const resized = resizeApprovedIntent(handBuilt, REQUEST);

    expect(resized.ok).toBe(false);
    if (resized.ok) return;
    expect(resized.refusals.map((r) => r.code)).toContain("RISK_INPUT_INVALID");
  });

  it("THE STRUCTURAL PROPERTY: every string position of a hand-built record, generated from its shape", () => {
    const bases = [positionRecord(), reductionRecord(), recommendingRecord()];
    const emittedInvalid: { mutated: string; path: string; value: string }[] = [];
    const acceptedIdentity: string[] = [];
    let checkedPositions = 0;
    let excludedPositions = 0;

    for (const base of bases) {
      for (const site of stringsIn(base)) {
        const handBuilt = withStringAt(base, site.path, NON_CANONICAL_CODE);
        // A typed result, ALWAYS: identity validation may not throw.
        const resized = resizeApprovedIntent(handBuilt, REQUEST);

        if (EXCLUDED_KEY.test(site.path)) {
          excludedPositions += 1;
          // The exclusions are real: a venue id, a prose reason, and a tag are
          // ACCEPTED and round-tripped byte for byte. Over-refusing one of
          // these on a CANCEL is how a position gets trapped (§6 invariant 13).
          expect(resized.ok).toBe(true);
          if (!resized.ok) continue;
          expect(stringsIn(resized.value).map((s) => s.value)).toContain(NON_CANONICAL_CODE);
          continue;
        }

        checkedPositions += 1;
        if (resized.ok) {
          acceptedIdentity.push(site.path);
          emittedInvalid.push(
            ...stringsIn(resized.value)
              .filter((s) => nonCanonicalUuid(s.value) && !EXCLUDED_KEY.test(s.path))
              .map((s) => ({ mutated: site.path, path: s.path, value: s.value })),
          );
          continue;
        }
        // Refused — and the refusal names the position and keeps the raw value.
        expect(resized.refusals.map((r) => r.details["field"])).toContain(`record.${site.path}`);
      }
    }

    expect(acceptedIdentity).toEqual([]);
    expect(emittedInvalid).toEqual([]);
    // NON-VACUITY, both ways: the battery really did drive dozens of identity
    // positions hostile, and it really did exercise the exclusions.
    expect(checkedPositions).toBeGreaterThan(50);
    expect(excludedPositions).toBeGreaterThanOrEqual(3);
  });

  it("the boundary adds NO new way to refuse a cancel: venue ids and prose ride through", () => {
    for (const intent of [
      cancelIntent({ orderIds: [NON_CANONICAL] }),
      cancelIntent({ reason: NON_CANONICAL }),
      cancelIntent({ orderIds: [NON_CANONICAL], reason: NON_CANONICAL }),
    ]) {
      const input = entryInput();
      input.intent = intent;

      const result = evaluateIntent(riskPolicy(), input);

      expect(codesOf(result)).toEqual([]);
      expect(result.approved).toBe(true);
      if (!result.approved) continue;
      // Round-tripped byte for byte, at the excluded paths and nowhere else.
      expect(
        stringsIn(result.record)
          .filter((s) => nonCanonicalUuid(s.value))
          .every((s) => EXCLUDED_KEY.test(s.path)),
      ).toBe(true);
    }
  });

  it("every emitted record is frozen BY the boundary — the resize path included", () => {
    const resized = resizeApprovedIntent(positionRecord(), REQUEST);
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    expect(Object.isFrozen(resized.value)).toBe(true);
    expect(Object.isFrozen(resized.value.reasons)).toBe(true);
    expect(() => {
      (resized.value as { approvedIntentId: string }).approvedIntentId = "tampered";
    }).toThrow(TypeError);
  });
});

/**
 * THE DATA-RECORD BOUNDARY — review round 4.
 *
 * FINDING. Round 3's emission boundary WALKED the record instead of listing its
 * fields, but the walk's enumeration primitive — `Object.entries` — had become
 * the new list. It sees only enumerable own properties, so three shapes carried
 * a contract-invalid repository identifier straight through it:
 *
 * - the existing `worstCase.perMarket[0].marketId` made NON-ENUMERABLE:
 *   `{"ok":true,"emitted":"01890000-…-AB","frozen":true,"codes":[]}`;
 * - the same field moved to the object's PROTOTYPE: accepted, and editing that
 *   prototype AFTER the call changed the value the returned record reported,
 *   although the container answered `Object.isFrozen` with `true` — so the
 *   emitted record was not deeply immutable either;
 * - an enumerable GETTER: `Error("getter-fired")` escaped `resizeApprovedIntent`,
 *   whose entire contract is a typed, non-throwing result.
 *
 * And the round-3 TEST walked with `Object.entries` too, so it could not have
 * seen any of them: a property proved with the implementation's own primitive
 * is not proved.
 *
 * FIX. `packages/risk/src/plain-data.ts` READS a value into plain own data
 * before anything looks at it — descriptors only, so a getter is refused
 * without ever being invoked; the prototype must be plain, because an inherited
 * property is state a freeze cannot reach; non-enumerable data properties are
 * READ (hiding a field does not remove it) and therefore checked. Both
 * boundaries then use only that snapshot, and the snapshot is what gets
 * emitted. `ApprovedIntentRecordSchema` states the record's complete runtime
 * shape, so "this argument is a record" is checked rather than assumed.
 *
 * ORACLES. These cases use the module-scope {@link stringsIn} and
 * {@link notPlainOwnFrozenData}, which walk descriptors and prototype chains —
 * strictly more sighted than any walk the package performs — and check a
 * structural property of the OUTPUT that the product never checks about itself.
 */
describe("the data-record boundary — a caller's object is not a record", () => {
  const NON_CANONICAL = "01890000-0000-7000-8000-0000000000AB";
  const CANONICAL = "01890000-0000-7000-8000-0000000000ab";

  const UUID_SHAPE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
  const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  function nonCanonicalUuid(value: string): boolean {
    return UUID_SHAPE.test(value) && !UUID_CANONICAL.test(value);
  }

  /** As in the block above, written independently of `NON_IDENTITY_KEYS`. */
  const EXCLUDED_KEY = /(^|\.)(orderIds\[\d+\]|reason|resizeReason|rationale|tags\[\d+\])$/u;

  const REQUEST = {
    approvedIntentId: CANONICAL,
    resizedAt: "2026-09-03T12:00:01.000Z",
    newTargetShares: "50",
    reason: "shrink",
  };

  /** A MUTABLE record, as a caller would hand one in (deserialized, rebuilt). */
  function handBuiltRecord(
    mutate: (input: EvaluationInputFixture) => void = () => undefined,
  ): ApprovedIntentRecord {
    const input = entryInput();
    input.intent = positionIntent({ tags: ["alpha"] });
    mutate(input);
    const result = evaluateIntent(riskPolicy(), input);
    if (!result.approved) throw new Error(`fixture not approved: ${codesOf(result).join(",")}`);
    return structuredClone(result.record) as ApprovedIntentRecord;
  }

  /** The first per-market lot of a mutable record. */
  function lotOf(record: ApprovedIntentRecord): Record<string, unknown> {
    return (record.worstCase.perMarket as unknown as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
  }

  function codes(result: ReturnType<typeof resizeApprovedIntent>): string[] {
    return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
  }

  it("REVIEWER'S PROBE (round 4a): a NON-ENUMERABLE identity property is refused, not emitted", () => {
    const record = handBuiltRecord();
    Object.defineProperty(lotOf(record), "marketId", {
      value: NON_CANONICAL,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    const resized = resizeApprovedIntent(record, REQUEST);

    expect(resized.ok).toBe(false);
    if (resized.ok) return;
    // Hiding a field from enumeration does not remove it from the value, so it
    // is READ and then refused by name, with the raw value — a better answer
    // than a shape refusal would be.
    const identity = resized.refusals.find((r) => r.code === "RISK_UUID_NOT_CANONICAL");
    expect(identity?.details["field"]).toBe("record.worstCase.perMarket[0].marketId");
    expect(identity?.details["value"]).toBe(NON_CANONICAL);
  });

  it("REVIEWER'S PROBE (round 4b): an INHERITED property is refused — a freeze cannot reach a prototype", () => {
    for (const inheritedValue of [NON_CANONICAL, CANONICAL]) {
      const record = handBuiltRecord();
      const lot = lotOf(record);
      delete lot["marketId"];
      const prototype: Record<string, unknown> = { marketId: inheritedValue };
      Object.setPrototypeOf(lot, prototype);

      const resized = resizeApprovedIntent(record, REQUEST);

      // Refused whether the inherited value is hostile or benign: the defect is
      // the SHAPE. A record that reports a value it does not own cannot be
      // frozen, and round 4's probe changed a returned record's market id by
      // editing this prototype after the call returned.
      expect(resized.ok).toBe(false);
      if (resized.ok) return;
      expect(codes(resized)).toContain("RISK_INPUT_INVALID");
      expect(JSON.stringify(resized.refusals)).toContain("record.worstCase.perMarket[0]");
    }
  });

  it("REVIEWER'S PROBE (round 4c): a THROWING getter is a typed refusal, and is never invoked", () => {
    const record = handBuiltRecord();
    const lot = lotOf(record);
    delete lot["marketId"];
    let invoked = 0;
    Object.defineProperty(lot, "marketId", {
      get() {
        invoked += 1;
        throw new Error("getter-fired");
      },
      enumerable: true,
      configurable: true,
    });

    // Round 4: `Error("getter-fired")` escaped this call.
    const resized = resizeApprovedIntent(record, REQUEST);

    expect(resized.ok).toBe(false);
    expect(codes(resized)).toContain("RISK_INPUT_INVALID");
    // The boundary reads DESCRIPTORS, so no caller code runs inside it at all.
    expect(invoked).toBe(0);
  });

  it("a getter cannot get one value validated and a different one emitted", () => {
    const record = handBuiltRecord();
    const lot = lotOf(record);
    const clean = lot["marketId"] as string;
    delete lot["marketId"];
    let reads = 0;
    Object.defineProperty(lot, "marketId", {
      get() {
        reads += 1;
        return reads === 1 ? clean : NON_CANONICAL;
      },
      enumerable: true,
      configurable: true,
    });

    const resized = resizeApprovedIntent(record, REQUEST);

    expect(resized.ok).toBe(false);
    expect(reads).toBe(0);
  });

  it("a benign accessor is refused too: an emitted record carries data, not code", () => {
    const record = handBuiltRecord();
    const lot = lotOf(record);
    const clean = lot["marketId"] as string;
    delete lot["marketId"];
    Object.defineProperty(lot, "marketId", {
      get: () => clean,
      enumerable: true,
      configurable: true,
    });

    expect(resizeApprovedIntent(record, REQUEST).ok).toBe(false);
  });

  it("THE STRUCTURAL PROPERTY: every emitted record is plain, own-data and deeply frozen", () => {
    const emitted: unknown[] = [];

    for (const build of [
      () => entryInput(),
      () => {
        const input = entryInput();
        input.intent = reduceIntent({ targetShares: "100" });
        input.portfolio.positions = [position()];
        return input;
      },
      () => {
        const input = entryInput();
        input.intent = cancelIntent({ orderIds: [NON_CANONICAL] });
        return input;
      },
    ]) {
      const result = evaluateIntent(riskPolicy(), build());
      expect(result.approved).toBe(true);
      if (!result.approved) continue;
      emitted.push(result.record);
      const resized = resizeApprovedIntent(structuredClone(result.record), REQUEST);
      if (resized.ok) emitted.push(resized.value);
    }

    for (const record of emitted) {
      // ORACLE 2: plain prototype, own enumerable DATA properties only, frozen
      // at every depth. This is what makes "the walk sees everything" true
      // rather than assumed — on such a value every enumeration primitive
      // reports the same set.
      expect(notPlainOwnFrozenData(record)).toEqual([]);
      // ORACLE 1: and nothing UUID-shaped-but-not-canonical is reachable by the
      // more sighted walk either, except under a contract-typed exclusion.
      expect(
        stringsIn(record)
          .filter((entry) => nonCanonicalUuid(entry.value))
          .filter((entry) => !EXCLUDED_KEY.test(entry.path)),
      ).toEqual([]);
    }
    // NON-VACUITY: entry, exit and cancel arms, plus resizes of them.
    expect(emitted.length).toBeGreaterThanOrEqual(5);
  });

  it("an emitted record shares no object with the argument it was built from", () => {
    const caller = handBuiltRecord();
    const resized = resizeApprovedIntent(caller, REQUEST);
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;

    // Materialized, not aliased: nothing the caller still holds is inside the
    // record it got back, so no later edit of theirs can reach it.
    expect(resized.value.worstCase).not.toBe(caller.worstCase);
    expect(resized.value.worstCase.perMarket[0]).not.toBe(caller.worstCase.perMarket[0]);
    expect(resized.value.intent).not.toBe(caller.intent);
    expect(resized.value.recommendations).not.toBe(caller.recommendations);
    // …and the values are nonetheless carried through byte for byte.
    expect(resized.value.worstCase).toEqual(caller.worstCase);

    lotOf(caller)["marketId"] = "MUTATED-AFTER-RETURN";
    expect(resized.value.worstCase.perMarket[0]?.marketId).toBe(MARKET_A);
  });

  it("the ENGINE's records come through the boundary too, materialized rather than aliased", () => {
    // Round 3 disclosed that no test could distinguish the engine's use of the
    // emission boundary (mutation M-R3e survived): every string in an
    // engine-built record is validated at the door or is a package literal, so
    // bypassing the seal changed no refusal. Since round 4 the boundary also
    // MATERIALIZES, which is observable: a sealed record is a fresh tree, so it
    // cannot be the same object the evaluation carries beside it.
    for (const build of [
      () => entryInput(),
      () => {
        const input = entryInput();
        input.intent = cancelIntent();
        return input;
      },
    ]) {
      const result = evaluateIntent(riskPolicy(), build());
      expect(result.approved).toBe(true);
      if (!result.approved) continue;
      expect(result.record.worstCase).not.toBe(result.worstCase);
      expect(result.record.worstCase).toEqual(result.worstCase);
      expect(notPlainOwnFrozenData(result.record)).toEqual([]);
    }
  });

  it("LOW (round 4): a singular `orderId` is CHECKED — the name does not imply a venue id", () => {
    // `CancelIntent.orderIds` is typed `VenueOrderIdSchema`, so it is excluded.
    // Singular `orderId` is typed that way nowhere, and the repository's own
    // `execution.orders` table has an in-process `order_id internal.uuid_v7`
    // beside a separate `venue_order_id` column. Excluding the NAME was wider
    // than the contract behind it.
    const record = handBuiltRecord() as unknown as Record<string, unknown>;
    record["orderId"] = NON_CANONICAL;

    const resized = resizeApprovedIntent(record as unknown as ApprovedIntentRecord, REQUEST);

    expect(resized.ok).toBe(false);
    if (resized.ok) return;
    const identity = resized.refusals.find((r) => r.code === "RISK_UUID_NOT_CANONICAL");
    expect(identity?.details["field"]).toBe("record.orderId");
    expect(identity?.details["value"]).toBe(NON_CANONICAL);
  });

  it("the contract-backed exclusions still ride through, byte for byte", () => {
    const input = entryInput();
    input.intent = cancelIntent({ orderIds: [NON_CANONICAL], reason: NON_CANONICAL });
    const result = evaluateIntent(riskPolicy(), input);
    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.intent).toMatchObject({
      orderIds: [NON_CANONICAL],
      reason: NON_CANONICAL,
    });

    const tagged = handBuiltRecord((withTag) => {
      withTag.intent = positionIntent({ tags: ["f1890000-0000-7000-8000-0000000000AB"] });
    });
    const resized = resizeApprovedIntent(tagged, REQUEST);
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    expect(resized.value.intent).toMatchObject({
      tags: ["f1890000-0000-7000-8000-0000000000AB"],
    });
  });

  it("each exclusion is bounded by the TYPE its schema gives it, not by its key name", () => {
    // A `tag` that is not a `CodeString` is refused, though `tags` is excluded
    // from the IDENTITY check…
    const badTag = handBuiltRecord() as unknown as { intent: { tags: string[] } };
    badTag.intent.tags = ["not a code"];
    expect(codes(resizeApprovedIntent(badTag as unknown as ApprovedIntentRecord, REQUEST))).toEqual(
      ["RISK_INPUT_INVALID"],
    );

    // …and so is a `rationale` that is not a `DetailString`. That annotation
    // (`IncidentActionRecommendationSchema.rationale`) was added in round 4:
    // the exclusion cited a contract type the field did not have.
    const badProse = handBuiltRecord() as unknown as {
      recommendations: { rationale: string }[];
    };
    badProse.recommendations = [
      {
        kind: "RECOMMENDATION",
        action: "CANCEL_RESTING_ORDERS",
        failureClass: "VENUE_BOOK_STALE",
        ordersScope: "ACCOUNT",
        rationale: "",
      } as unknown as { rationale: string },
    ];
    expect(
      codes(resizeApprovedIntent(badProse as unknown as ApprovedIntentRecord, REQUEST)),
    ).toEqual(["RISK_INPUT_INVALID"]);
  });

  it("a value that is not an approved-intent record is a typed refusal, never a throw", () => {
    const notRecords: unknown[] = [
      null,
      undefined,
      "record",
      42,
      [],
      {},
      { ...handBuiltRecord(), extraKey: "surprise" },
    ];
    for (const notRecord of notRecords) {
      const resized = resizeApprovedIntent(notRecord as ApprovedIntentRecord, REQUEST);
      expect(resized.ok).toBe(false);
      expect(codes(resized)).toContain("RISK_INPUT_INVALID");
    }

    // A required field that is missing is named, not defaulted.
    const missing = handBuiltRecord() as unknown as Record<string, unknown>;
    delete missing["rootApprovedIntentId"];
    const resized = resizeApprovedIntent(missing as unknown as ApprovedIntentRecord, REQUEST);
    expect(resized.ok).toBe(false);
    if (resized.ok) return;
    expect(JSON.stringify(resized.refusals)).toContain("rootApprovedIntentId");
  });

  it("a cyclic or sparse record is a typed refusal, not a hang and not a throw", () => {
    const cyclic = handBuiltRecord() as unknown as { worstCase: Record<string, unknown> };
    cyclic.worstCase["self"] = cyclic.worstCase;
    expect(
      codes(resizeApprovedIntent(cyclic as unknown as ApprovedIntentRecord, REQUEST)),
    ).toContain("RISK_INPUT_INVALID");

    const sparse = handBuiltRecord() as unknown as { reasons: unknown };
    const holes = ["RISK_APPROVED"];
    holes.length = 3;
    sparse.reasons = holes;
    expect(
      codes(resizeApprovedIntent(sparse as unknown as ApprovedIntentRecord, REQUEST)),
    ).toContain("RISK_INPUT_INVALID");
  });
});

/**
 * A HOSTILE VALUE AT THE BOUNDARY — review round 5.
 *
 * FINDINGS. Round 4's boundary claimed, flatly, that "no caller code runs inside
 * the boundary". Round 5 falsified it three ways, and found the materializer
 * itself creating the wrong kind of property:
 *
 * - `out[key] = value` for `key === "__proto__"` invoked `Object.prototype`'s
 *   inherited SETTER, so the value became the emitted object's PROTOTYPE and no
 *   own property was created. `sealApprovedIntentRecord` returned
 *   `ok=true, plainPrototype=false, prototypeFrozen=false`, and adding an
 *   uppercase UUID `marketId` to that prototype AFTER the call changed what the
 *   "validated, frozen" record reported;
 * - a `Proxy` is caller code wearing the shape of data. A plain-looking one was
 *   ACCEPTED after its traps ran (nine invocations for a nested one); a trap
 *   result carrying getters ran four of them inside
 *   `Object.getOwnPropertyDescriptor` itself; and an array `Proxy` whose
 *   `length` answered with a throwing `@@toPrimitive` escaped through
 *   `String(reported)` while the REFUSAL was being built, so the public
 *   `resizeApprovedIntent` threw;
 * - the public input doors handed caller objects straight to `zod`, which reads
 *   properties — so a valid `CANCEL` representation with a throwing
 *   `identifiers` getter THREW instead of refusing, and never reached the §6
 *   invariant 13 choke point at all.
 *
 * WHAT THE FIX CLAIMS, AND WHAT IT DOES NOT. `plain-data.ts` states three
 * separate propositions rather than one absolute: no code carried by the
 * inspected value is invoked (descriptors, plus a trap-free `Proxy` predicate,
 * plus `Object.defineProperty`); totality is unconditional (an outer containment
 * guard); and the OUTPUT is plain own frozen data whatever the input did. The
 * cases below are written against those three, not against the old absolute.
 */
describe("a hostile value at the boundary — review round 5", () => {
  const NON_CANONICAL = "01890000-0000-7000-8000-0000000000AB";
  const CANONICAL = "01890000-0000-7000-8000-0000000000ab";

  const REQUEST = {
    approvedIntentId: CANONICAL,
    resizedAt: "2026-09-03T12:00:01.000Z",
    newTargetShares: "50",
    reason: "shrink",
  };

  function handBuilt(): ApprovedIntentRecord {
    const input = entryInput();
    input.intent = positionIntent({ tags: ["alpha"] });
    const result = evaluateIntent(riskPolicy(), input);
    if (!result.approved) throw new Error(`fixture not approved: ${codesOf(result).join(",")}`);
    return structuredClone(result.record) as ApprovedIntentRecord;
  }

  function lot(record: ApprovedIntentRecord): Record<string, unknown> {
    return (record.worstCase.perMarket as unknown as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
  }

  function codes(result: ReturnType<typeof resizeApprovedIntent>): string[] {
    return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
  }

  /** Trap counter that also proves the handler was reachable at all. */
  function countingProxy<T extends object>(
    target: T,
    counts: { value: number },
  ): { proxy: T; handler: ProxyHandler<T> } {
    const bump = <R>(compute: () => R): R => {
      counts.value += 1;
      return compute();
    };
    const handler: ProxyHandler<T> = {
      getPrototypeOf: (t) => bump(() => Reflect.getPrototypeOf(t)),
      ownKeys: (t) => bump(() => Reflect.ownKeys(t)),
      getOwnPropertyDescriptor: (t, k) => bump(() => Reflect.getOwnPropertyDescriptor(t, k)),
      get: (t, k, r) => bump(() => Reflect.get(t, k, r) as unknown),
      has: (t, k) => bump(() => Reflect.has(t, k)),
      isExtensible: (t) => bump(() => Reflect.isExtensible(t)),
      preventExtensions: (t) => bump(() => Reflect.preventExtensions(t)),
      defineProperty: (t, k, d) => bump(() => Reflect.defineProperty(t, k, d)),
    };
    return { proxy: new Proxy(target, handler), handler };
  }

  it("REVIEWER'S PROBE (round 5a): a non-enumerable own `__proto__` never becomes a prototype", () => {
    const record = handBuilt() as unknown as Record<string, unknown>;
    Object.defineProperty(record, "__proto__", {
      value: {},
      enumerable: false,
      writable: true,
      configurable: true,
    });

    const resized = resizeApprovedIntent(record as unknown as ApprovedIntentRecord, REQUEST);

    // Refused, and refused BY NAME — the reviewer's draft was accepted with
    // `plainPrototype:false`, which is what let a post-return prototype edit
    // change a "frozen" record.
    expect(resized.ok).toBe(false);
    expect(codes(resized)).toContain("RISK_INPUT_INVALID");
    expect(JSON.stringify(resized)).toContain("__proto__");
    // And `Object.prototype` itself is untouched: nothing was written through
    // the inherited setter on the way.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("materialization uses CreateDataProperty semantics — no INHERITED setter is ever invoked", () => {
    // `__proto__` is refused as a NAME (the next case), which would leave the
    // `Object.defineProperty` half of round 5's BLOCKER 1 unobservable — a fix
    // no test can distinguish is a fix nobody is holding. So this case tests
    // the PROPERTY rather than the one key that exposed it: with an inherited
    // setter installed for an ordinary field name, `out[key] = value` invokes
    // it and creates NO own property, while `Object.defineProperty` does not
    // consult it at all.
    //
    // The intrinsic is restored in `finally`, and nothing else runs inside the
    // window.
    const record = handBuilt();
    let setterInvoked = 0;
    let read: ReturnType<typeof readPlainData> | undefined;
    let resized: ReturnType<typeof resizeApprovedIntent> | undefined;
    Object.defineProperty(Object.prototype, "marketId", {
      set() {
        setterInvoked += 1;
      },
      get() {
        return undefined;
      },
      configurable: true,
    });
    let invokedByTheMaterializer = -1;
    try {
      read = readPlainData({ marketId: MARKET_A, lot: { marketId: MARKET_B } }, "value");
      invokedByTheMaterializer = setterInvoked;
      resized = resizeApprovedIntent(record, REQUEST);
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)["marketId"];
    }

    // THE UNIT ASSERTION. With `out[key] = value`, the inherited setter would
    // have swallowed both fields and neither own property would exist.
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const materialized = read.value as Record<string, unknown>;
    expect(Object.hasOwn(materialized, "marketId")).toBe(true);
    expect(materialized["marketId"]).toBe(MARKET_A);
    expect(Object.hasOwn(materialized["lot"] as object, "marketId")).toBe(true);
    // The materializer invoked NOTHING. (The end-to-end count is deliberately
    // not asserted: `zod` builds its parse output with assignment, so it does
    // touch the setter. That output is discarded — nothing this package emits
    // comes from it — but the honest scope for this assertion is the
    // materializer, which is what round 5's BLOCKER 1 was about.)
    expect(invokedByTheMaterializer).toBe(0);

    // …and end to end the emitted record still carries the real value, which is
    // what the setter would otherwise have erased.
    expect(resized?.ok).toBe(true);
    if (resized === undefined || !resized.ok) return;
    expect(resized.value.worstCase.perMarket[0]?.marketId).toBe(MARKET_A);
  });

  it("root and nested `__proto__`, `constructor` and `prototype` are refused, never emitted", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const nested of [false, true]) {
        for (const enumerable of [false, true]) {
          const record = handBuilt();
          const target = nested
            ? lot(record)
            : (record as unknown as Record<string, unknown>);
          Object.defineProperty(target, key, {
            value: NON_CANONICAL,
            enumerable,
            writable: true,
            configurable: true,
          });

          const resized = resizeApprovedIntent(record, REQUEST);
          const where = `${key}${nested ? " (nested)" : " (root)"}${enumerable ? "" : " hidden"}`;
          expect(resized.ok, where).toBe(false);
          // Either shape refusal or identity refusal is acceptable; what is not
          // acceptable is emission, an exception, or a silent drop.
          expect(codes(resized).length, where).toBeGreaterThan(0);
        }
      }
    }
    // Non-vacuity, and the intrinsic is clean: 12 hostile cases and nothing
    // leaked onto `Object.prototype`.
    expect(Object.hasOwn(Object.prototype, "marketId")).toBe(false);
    expect(({} as Record<string, unknown>)["marketId"]).toBeUndefined();
  });

  it("an emitted record is plain own frozen data, and no post-return edit reaches it", () => {
    const caller = handBuilt();
    const resized = resizeApprovedIntent(caller, REQUEST);
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;

    const emitted = resized.value as unknown as Record<string, unknown>;
    // `null`, not `Object.prototype` (review round 6): an emitted record now
    // inherits nothing at all. See {@link notPlainOwnFrozenData}.
    expect(Object.getPrototypeOf(emitted)).toBe(null);
    expect(Object.hasOwn(emitted, "__proto__")).toBe(false);
    expect(notPlainOwnFrozenData(emitted)).toEqual([]);

    // POST-RETURN MUTABILITY, the round-4 probe's move: edit everything the
    // caller still holds — the object, its sub-objects, and the prototype of
    // each — and read the record again.
    lot(caller)["marketId"] = "MUTATED-AFTER-RETURN";
    Object.setPrototypeOf(caller, { marketId: "FROM-A-PROTOTYPE" });
    expect(resized.value.worstCase.perMarket[0]?.marketId).toBe(MARKET_A);
    expect(() => {
      (emitted as { approvedIntentId: string }).approvedIntentId = "tampered";
    }).toThrow(TypeError);
  });

  it("REVIEWER'S PROBE (round 5b): a Proxy at the ROOT is refused with ZERO trap invocations", () => {
    const counts = { value: 0 };
    const { proxy } = countingProxy(handBuilt() as object, counts);

    const resized = resizeApprovedIntent(proxy as ApprovedIntentRecord, REQUEST);

    expect(resized.ok).toBe(false);
    expect(codes(resized)).toContain("RISK_INPUT_INVALID");
    // The load-bearing number. Round 5 recorded `getPrototypeOf=1, ownKeys=1,
    // getOwnPropertyDescriptor=1` and `ok:true`.
    expect(counts.value).toBe(0);
    expect(JSON.stringify(resized)).toContain("Proxy");
  });

  it("REVIEWER'S PROBE (round 5c): a Proxy NESTED in a valid record is refused with ZERO traps", () => {
    const counts = { value: 0 };
    const record = handBuilt();
    const perMarket = record.worstCase.perMarket as unknown as Record<string, unknown>[];
    const { proxy } = countingProxy(perMarket[0] as object, counts);
    perMarket[0] = proxy as Record<string, unknown>;

    const resized = resizeApprovedIntent(record, REQUEST);

    expect(resized.ok).toBe(false);
    // Round 5 recorded NINE trap invocations here, and an accepted record.
    expect(counts.value).toBe(0);

    // The counter is not vacuous: the same proxy answers a reflective operation
    // when something other than the boundary asks.
    expect(Reflect.ownKeys(proxy).length).toBeGreaterThan(0);
    expect(counts.value).toBeGreaterThan(0);
  });

  it("REVIEWER'S PROBE (round 5d): an exotic descriptor cannot run getters inside the read", () => {
    let getters = 0;
    const record = handBuilt();
    const perMarket = record.worstCase.perMarket as unknown as Record<string, unknown>[];
    const inner = perMarket[0] as object;
    perMarket[0] = new Proxy(inner, {
      getOwnPropertyDescriptor(target, key) {
        const real = Reflect.getOwnPropertyDescriptor(target, key);
        // `Object.getOwnPropertyDescriptor` NORMALIZES a trap result, and that
        // normalization reads `.value`, `.writable`, `.enumerable` and
        // `.configurable` — four getters per property, running inside what the
        // boundary believed was a pure reflective read.
        return {
          get value() {
            getters += 1;
            return real?.value as unknown;
          },
          get writable() {
            getters += 1;
            return true;
          },
          get enumerable() {
            getters += 1;
            return true;
          },
          get configurable() {
            getters += 1;
            return true;
          },
        } as PropertyDescriptor;
      },
    }) as Record<string, unknown>;

    const resized = resizeApprovedIntent(record, REQUEST);

    expect(resized.ok).toBe(false);
    expect(getters).toBe(0);
  });

  it("a Proxy that OMITS a property or LIES in a descriptor cannot be approved", () => {
    for (const handler of [
      {
        ownKeys: (target: object) => Reflect.ownKeys(target).filter((k) => k !== "marketId"),
        getOwnPropertyDescriptor: (target: object, key: string | symbol) =>
          key === "marketId" ? undefined : Reflect.getOwnPropertyDescriptor(target, key),
      },
      {
        getOwnPropertyDescriptor: (target: object, key: string | symbol) =>
          key === "marketId"
            ? { value: NON_CANONICAL, writable: true, enumerable: true, configurable: true }
            : Reflect.getOwnPropertyDescriptor(target, key),
      },
    ] as ProxyHandler<object>[]) {
      const record = handBuilt();
      const perMarket = record.worstCase.perMarket as unknown as Record<string, unknown>[];
      perMarket[0] = new Proxy(perMarket[0] as object, handler) as Record<string, unknown>;
      expect(resizeApprovedIntent(record, REQUEST).ok).toBe(false);
    }
  });

  it("REVIEWER'S PROBE (round 5e): a hostile array `length` cannot propagate an exception", () => {
    let coerced = 0;
    const record = handBuilt();
    const worstCase = record.worstCase as unknown as Record<string, unknown>;
    const realArray = worstCase["perMarket"] as unknown[];
    const hostileLength = {
      [Symbol.toPrimitive]() {
        coerced += 1;
        throw new Error("coerce-from-caller");
      },
    };
    worstCase["perMarket"] = new Proxy(realArray, {
      get: (target, key, receiver) =>
        key === "length" ? hostileLength : (Reflect.get(target, key, receiver) as unknown),
      getOwnPropertyDescriptor: (target, key) =>
        key === "length"
          ? { value: hostileLength, writable: true, enumerable: false, configurable: false }
          : Reflect.getOwnPropertyDescriptor(target, key),
    }) as unknown[];

    // Round 5: this call threw `Error("coerce-from-caller")` — from the code
    // that BUILT the refusal (`String(reported)`), not from the check.
    const resized = resizeApprovedIntent(record, REQUEST);

    expect(resized.ok).toBe(false);
    expect(coerced).toBe(0);
  });

  it("a revoked Proxy and a throwing descriptor trap stay typed refusals", () => {
    const record = handBuilt();
    const perMarket = record.worstCase.perMarket as unknown as Record<string, unknown>[];
    const { proxy, revoke } = Proxy.revocable(perMarket[0] as object, {});
    revoke();
    perMarket[0] = proxy as Record<string, unknown>;
    expect(codes(resizeApprovedIntent(record, REQUEST))).toContain("RISK_INPUT_INVALID");

    const second = handBuilt();
    const lots = second.worstCase.perMarket as unknown as Record<string, unknown>[];
    lots[0] = new Proxy(lots[0] as object, {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor-trap");
      },
    }) as Record<string, unknown>;
    expect(codes(resizeApprovedIntent(second, REQUEST))).toContain("RISK_INPUT_INVALID");
  });

  it("REVIEWER'S PROBE (round 5f): a CANCEL with a throwing accessor is REFUSED, not thrown", () => {
    let invoked = 0;
    const input = entryInput();
    input.intent = cancelIntent();
    const hostile = { ...input } as Record<string, unknown>;
    delete hostile["identifiers"];
    Object.defineProperty(hostile, "identifiers", {
      get() {
        invoked += 1;
        throw new Error("cancel-input-getter");
      },
      enumerable: true,
      configurable: true,
    });

    // Round 5: this call THREW, so the cancel never reached the §6 invariant 13
    // choke point. A refusal is the correct answer — the representation is
    // malformed — but it must be a refusal.
    const result = evaluateIntent(riskPolicy(), hostile);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_INPUT_INVALID");
    expect(invoked).toBe(0);
  });

  it("the policy door refuses an accessor-bearing policy without invoking it", () => {
    let invoked = 0;
    const hostile: Record<string, unknown> = {
      freshness: { venueBookMaxAgeMs: 1000, referenceFeedMaxAgeMs: 2000, featuresMaxAgeMs: 2000 },
      scenario: { maxScenarioLoss: "10000" },
      economics: {},
      participation: {},
      rateLimit: { safetyReserveRequests: 5 },
      timeToClose: { entryCutoffSeconds: 60 },
    };
    Object.defineProperty(hostile, "limits", {
      get() {
        invoked += 1;
        throw new Error("policy-getter");
      },
      enumerable: true,
      configurable: true,
    });

    const parsed = parseRiskPolicy(hostile);
    expect(parsed.ok).toBe(false);
    expect(invoked).toBe(0);

    // …and a Proxy policy is refused with no traps at all.
    let traps = 0;
    const proxied = new Proxy(
      {},
      {
        ownKeys(target) {
          traps += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          traps += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf(target) {
          traps += 1;
          return Reflect.getPrototypeOf(target);
        },
        get(target, key, receiver) {
          traps += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    expect(parseRiskPolicy(proxied).ok).toBe(false);
    expect(traps).toBe(0);
  });

  it("an INHERITED scope entry is not a measurement — RISK_EXPOSURE_ENTRY_MISSING still fires", () => {
    // `strategyInstanceId` is a `CodeString`, so `"constructor"` is admissible
    // input. `exposures.byStrategyInstance["constructor"]` answers the `Object`
    // constructor — not `undefined` — so the round-1 BLOCKER-2 fix ("an omitted
    // entry is unknown exposure, not zero") read an intrinsic as a measurement
    // and then fed `undefined` to decimal arithmetic.
    const input = entryInput();
    input.context.strategyInstanceId = "constructor";
    input.exposures = exposureSnapshot({ measuring: { marketIds: [MARKET_A, MARKET_B] } });

    const result = evaluateIntent(
      riskPolicy({ limits: { maxWorstCaseContractualLoss: "10000", perInstanceExposureCap: "500" } }),
      input,
    );

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_EXPOSURE_ENTRY_MISSING");
    // Named, with the offending scope key — not a decimal exception.
    expect(JSON.stringify(result.refusals)).toContain("constructor");
  });

  it("an inherited member is not an exposure entry for a MEASURED scope either", () => {
    // The mirror case: the snapshot genuinely measures `"constructor"` at zero,
    // so the evaluation must proceed and compare against that zero.
    const input = entryInput();
    input.context.strategyInstanceId = "constructor";
    input.exposures = exposureSnapshot({
      measuring: { strategyInstanceIds: ["constructor"], marketIds: [MARKET_A, MARKET_B] },
    });

    const result = evaluateIntent(
      riskPolicy({ limits: { maxWorstCaseContractualLoss: "10000", perInstanceExposureCap: "500" } }),
      input,
    );

    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
  });

  it("the outer containment guard answers with a REJECTION, never an approval or a throw", () => {
    // `policy` is TYPED `RiskPolicy` and never parsed at runtime, so it is the
    // one argument the door does not see. A hostile one is the cleanest way to
    // reach the guard from outside.
    let invoked = 0;
    const base = riskPolicy() as unknown as Record<string, unknown>;
    const hostilePolicy = { ...base };
    Object.defineProperty(hostilePolicy, "limits", {
      get() {
        invoked += 1;
        throw new Error("policy-read-from-the-pipeline");
      },
      enumerable: true,
      configurable: true,
    });

    const result = evaluateIntent(hostilePolicy as unknown as RiskPolicy, entryInput());

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_INPUT_INVALID");
    // The refusal carries the thrown value's TYPE only — never its message,
    // which would be one more caller-controlled read.
    expect(JSON.stringify(result.refusals)).not.toContain("policy-read-from-the-pipeline");
    // Non-vacuity: the getter really was the thing that fired.
    expect(invoked).toBeGreaterThan(0);
    // A contained failure is a rejection, and a rejection is not a cancel
    // override: no record, and the approved arm is unreachable.
    expect("record" in result).toBe(false);
  });

  it("a contained CANCEL failure is still a refusal, not an approval (§6 invariant 13 unchanged)", () => {
    const input = entryInput();
    input.intent = cancelIntent();
    const base = riskPolicy() as unknown as Record<string, unknown>;
    const hostilePolicy = { ...base };
    Object.defineProperty(hostilePolicy, "maxRunMode", {
      get() {
        throw new Error("policy-read");
      },
      enumerable: true,
      configurable: true,
    });

    const result = evaluateIntent(hostilePolicy as unknown as RiskPolicy, input);

    // §6 invariant 13 protects a VALID cancel from RISK POLICY. It does not
    // require answering when the evaluation could not be performed at all — the
    // same boundary review round 2 drew for malformed input.
    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_INPUT_INVALID");
  });
});

describe("the approved-intent record", () => {
  it("names its own identity, its lineage root, and the strategy's intentId", () => {
    const result = evaluateIntent(riskPolicy(), entryInput());
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.approvedIntentId).toBe("approved-1");
    expect(result.record.rootApprovedIntentId).toBe("approved-1");
    expect(result.record.lineage).toBe("ORIGINAL");
    expect(result.record.sourceIntentId).toBe("intent-1");
    expect(result.record.worstCaseBasis).toBe("EVALUATED");
    expect(result.record.runMode).toBe("PAPER");
  });

  it("carries no sourceIntentId for the §7.7 shapes that have none", () => {
    const result = evaluateIntent(riskPolicy(), exitInput());
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.sourceIntentId).toBeUndefined();
  });

  it("is deeply frozen, and the approved arm carries an empty refusal list", () => {
    const result = evaluateIntent(riskPolicy(), entryInput());
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.refusals).toEqual([]);
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(() => {
      (result.record as { approvedIntentId: string }).approvedIntentId = "tampered";
    }).toThrow(TypeError);
  });
});
