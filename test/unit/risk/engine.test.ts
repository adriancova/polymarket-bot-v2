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

import { describe, expect, it } from "vitest";

import {
  RISK_REASON_CODES,
  evaluateIntent,
  isRiskReasonCode,
  type RiskPolicy,
  type RiskReasonCode,
} from "../../../packages/risk/src/index.js";
import {
  MARKET_A,
  MARKET_B,
  VALID_UNTIL,
  allScenarios,
  codesOf,
  entryInput,
  exitInput,
  exposureEntry,
  exposureSnapshot,
  market,
  openOrder,
  position,
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
      input.exposures = exposureSnapshot({});
    }),
  },
  {
    code: "RISK_MARKET_EXPOSURE_EXCEEDED",
    name: "check 15: the per-market cap",
    policy: () =>
      riskPolicy({ limits: { maxWorstCaseContractualLoss: "10000", perMarketExposureCap: "10" } }),
    build: withEntry((input) => {
      input.exposures = exposureSnapshot({});
    }),
  },
  {
    code: "RISK_SERIES_EXPOSURE_EXCEEDED",
    name: "check 15: the per-series cap",
    policy: () =>
      riskPolicy({ limits: { maxWorstCaseContractualLoss: "10000", perSeriesExposureCap: "10" } }),
    build: withEntry((input) => {
      input.exposures = exposureSnapshot({});
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
      input.exposures = exposureSnapshot({});
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
      input.exposures = exposureSnapshot({});
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

  it("a CANCEL is still refused when the run mode exceeds the process maximum", () => {
    const input = entryInput();
    input.intent = { type: "CANCEL", reason: "kill switch" };
    input.context.runMode = "LIVE";

    const result = evaluateIntent(riskPolicy(), input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_RUN_MODE_EXCEEDS_MAXIMUM");
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
