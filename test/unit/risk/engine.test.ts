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
  resizeApprovedIntent,
  type ApprovedIntentRecord,
  type RiskPolicy,
  type RiskReasonCode,
} from "../../../packages/risk/src/index.js";
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
    // `RISK_REASON_CODES` is the list's own name, not a code.
    documented.delete("RISK_REASON_CODES");
    documented.delete("RISK_REASON_CODE_COUNT");
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

  /** Every string reachable in a value, with the path it sits at. */
  function stringsIn(value: unknown, path = ""): { path: string; value: string }[] {
    if (typeof value === "string") return [{ path, value }];
    if (Array.isArray(value)) return value.flatMap((item, i) => stringsIn(item, `${path}[${i}]`));
    if (value !== null && typeof value === "object") {
      return Object.entries(value).flatMap(([key, item]) =>
        stringsIn(item, path === "" ? key : `${path}.${key}`),
      );
    }
    return [];
  }

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
