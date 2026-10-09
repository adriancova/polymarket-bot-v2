/**
 * WP-180's four BINDING acceptance criteria, one describe block each.
 *
 * These are the tests the work plan names:
 *
 * 1. "Open orders and positions both consume limits."
 * 2. "Worst-case contractual loss is primary."
 * 3. "Stale data blocks entries."
 * 4. "Risk resize creates a new approved-intent record."
 *
 * Each block states its probe in the test name so a reviewer can match the
 * criterion to the assertion without reading the body.
 *
 * C1-RISK (COMPLEXITY-1, 2026-10-08), the user's rulings:
 * - criterion 1's EXPOSURE half is the capital allocator's now (the only
 *   exposure-cap authority). Its probes moved with the caps: the allocator
 *   counts open orders, positions, reservations and unbooked fills
 *   (`packages/trading-core/src/loop-capital.test.ts`, `allocation.test.ts`).
 *   The worst-case half (probes C and D) stays here.
 * - criterion 4 holds VACUOUSLY: the resize path had no caller and was deleted
 *   (the execution planner refuses rather than downsizes). What remains to pin
 *   is the other half of §7.7's rule: a record is never edited in place.
 */

import { describe, expect, it } from "vitest";

import { evaluateIntent, isPrimaryRiskReasonCode } from "../../../packages/risk/src/index.js";
import {
  MARKET_A,
  codesOf,
  entryInput,
  exitInput,
  freshObservations,
  openOrder,
  position,
  riskPolicy,
} from "./fixtures.js";

describe("acceptance 1 — open orders and positions BOTH consume limits", () => {
  const worstCasePolicy = riskPolicy({
    limits: { maxWorstCaseContractualLoss: "60" },
  });

  it("PROBE C (worst case): resting OPEN ORDERS alone consume the primary limit, with ZERO positions", () => {
    const input = entryInput();
    input.portfolio.positions = [];
    // A resting BUY of 100 at 0.4 commits 40; the intent bounds 50. 90 > 60.
    input.portfolio.openOrders = [openOrder({ price: "0.4", shares: "100" })];

    const result = evaluateIntent(worstCasePolicy, input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_WORST_CASE_LOSS_EXCEEDED");
    expect(result.worstCase?.committedCost).toBe("90");
  });

  it("PROBE D (worst case): POSITIONS alone consume the primary limit, with ZERO open orders", () => {
    const input = entryInput();
    input.portfolio.openOrders = [];
    input.portfolio.positions = [position({ shares: "100", costBasis: "40" })];

    const result = evaluateIntent(worstCasePolicy, input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_WORST_CASE_LOSS_EXCEEDED");
    expect(result.worstCase?.committedCost).toBe("90");
  });

  it("a resting SELL order consumes no pUSD limit (it reserves tokens instead)", () => {
    const input = entryInput();
    input.portfolio.positions = [position({ shares: "100", costBasis: "0" })];
    input.portfolio.openOrders = [
      openOrder({ orderId: "o-sell", action: "SELL", price: "0.9", shares: "100" }),
    ];

    const result = evaluateIntent(worstCasePolicy, input);

    expect(result.worstCase?.committedCost).toBe("50");
    expect(result.approved).toBe(true);
  });
});

describe("acceptance 2 — worst-case contractual loss is PRIMARY", () => {
  it("PROBE: an intent passing every secondary check is rejected ONLY by the worst-case code", () => {
    // Every §9.8 input is supplied and satisfied in the baseline; the single
    // delta is a primary limit below the intent's own bounded cost.
    const policy = riskPolicy({ limits: { maxWorstCaseContractualLoss: "10" } });

    const result = evaluateIntent(policy, entryInput());

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toEqual(["RISK_WORST_CASE_LOSS_EXCEEDED"]);
    expect(codesOf(result).every(isPrimaryRiskReasonCode)).toBe(true);
  });

  it("the same intent is approved when only the primary limit is raised", () => {
    expect(evaluateIntent(riskPolicy(), entryInput()).approved).toBe(true);
  });

  it("the computation uses SETTLEMENT PAYOFF SEMANTICS: both tokens, per outcome (WP-110)", () => {
    const policy = riskPolicy({ limits: { maxWorstCaseContractualLoss: "10" } });

    const result = evaluateIntent(policy, entryInput());

    const perMarket = result.worstCase?.perMarket[0];
    expect(perMarket?.marketId).toBe(MARKET_A);
    expect(perMarket?.yesShares).toBe("100");
    expect(perMarket?.noShares).toBe("0");
    // WP-110 `packages/settlement/src/payout.ts`: a winning token redeems 1, a
    // losing token 0, and each token redeems 0.5 under SPLIT_50_50.
    expect(perMarket?.perOutcomeSettlementValue).toEqual({
      YES_WIN: "100",
      NO_WIN: "0",
      SPLIT_50_50: "50",
    });
    expect(perMarket?.worstVerifiedOutcome).toBe("NO_WIN");
    expect(perMarket?.worstVerifiedValue).toBe("0");
  });

  it("the unverified CANCELLED outcome is BOUNDED, never valued (WP-110 register row U-10)", () => {
    const result = evaluateIntent(riskPolicy(), entryInput());

    expect(result.worstCase?.cancelledOutcomeTreatment).toBe(
      "ZERO_REDEMPTION_FLOOR_UNVERIFIED_U10",
    );
    // The primary measure is committed cost against a zero-redemption floor:
    // no CANCELLED payout number appears anywhere in the assessment.
    expect(result.worstCase?.maximumContractualLoss).toBe("50");
    expect(JSON.stringify(result.worstCase)).not.toContain("CANCELLED_PAYOUT");
  });

  it("the primary limit cannot be configured away — it is a required policy field", () => {
    expect(() => riskPolicy({ limits: {} })).toThrow();
  });

  it("an intent that bounds no maximum cost fails the primary limit as UNBOUNDED", () => {
    const input = entryInput();
    const intent = { ...input.intent };
    delete intent["maximumBuyPrice"];
    input.intent = intent;

    const result = evaluateIntent(riskPolicy(), input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_WORST_CASE_UNBOUNDED");
    expect(isPrimaryRiskReasonCode("RISK_WORST_CASE_UNBOUNDED")).toBe(true);
  });
});

describe("acceptance 3 — stale data blocks entries", () => {
  const policy = riskPolicy();

  it("PROBE: STALE FEATURES block an entry", () => {
    const input = entryInput();
    input.freshness = [
      { feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 100 },
      { feed: "REFERENCE_FEED", ageMs: 100 },
      { feed: "FEATURES", ageMs: 5000 },
    ];

    const result = evaluateIntent(policy, input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_FEATURES_STALE");
  });

  it("PROBE: a STALE BOOK blocks an entry", () => {
    const input = entryInput();
    input.freshness = [
      { feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 5000 },
      { feed: "REFERENCE_FEED", ageMs: 100 },
      { feed: "FEATURES", ageMs: 100 },
    ];

    const result = evaluateIntent(policy, input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_BOOK_STALE");
  });

  it("PROBE: an UNMEASURED feed blocks an entry exactly like a stale one", () => {
    const input = entryInput();
    input.freshness = [];

    const result = evaluateIntent(policy, input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_FRESHNESS_UNKNOWN");
  });

  it("a stale REFERENCE FEED blocks an entry and recommends the §9.9 row-1 actions", () => {
    const input = entryInput();
    input.freshness = [
      { feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 100 },
      { feed: "REFERENCE_FEED", ageMs: 5000 },
      { feed: "FEATURES", ageMs: 100 },
    ];

    const result = evaluateIntent(policy, input);

    expect(codesOf(result)).toContain("RISK_REFERENCE_FEED_STALE");
    expect(result.recommendations.map((r) => r.action)).toEqual([
      "CANCEL_RESTING_ORDERS",
      "HALT_NEW_ENTRIES",
    ]);
    expect(result.recommendations.every((r) => r.kind === "RECOMMENDATION")).toBe(true);
  });

  it("EXIT RULE, §9.9 row 1: a stale SIGNAL feed with a healthy venue book does NOT block a reduction", () => {
    const input = exitInput();
    input.freshness = [
      { feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 100 },
      { feed: "REFERENCE_FEED", ageMs: 5000 },
      { feed: "FEATURES", ageMs: 5000 },
    ];

    const result = evaluateIntent(policy, input);

    expect(result.approved).toBe(true);
    expect(codesOf(result)).toEqual([]);
  });

  it("EXIT RULE, §9.9 row 2 + §6 invariant 12: a STALE BOOK blocks a reduction and recommends cancel + reconcile", () => {
    const input = exitInput();
    input.freshness = [
      { feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 5000 },
      { feed: "REFERENCE_FEED", ageMs: 100 },
      { feed: "FEATURES", ageMs: 100 },
    ];

    const result = evaluateIntent(policy, input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_BOOK_STALE_NO_BLIND_REDUCTION");
    const actions = result.recommendations.map((r) => r.action);
    expect(actions).toContain("CANCEL_RESTING_ORDERS");
    expect(actions).toContain("RECONCILE_ACCOUNT");
    // No blind flatten: nothing here recommends reducing right now.
    expect(actions).not.toContain("PROTECTED_REDUCE");
  });

  it("§6 invariant 13: a CANCEL is never blocked by staleness", () => {
    const input = entryInput();
    input.intent = { type: "CANCEL", marketId: MARKET_A, reason: "kill switch" };
    input.freshness = [];
    input.context.runStatePermitsIntent = false;
    input.context.strategyStatePermitsIntent = false;

    const result = evaluateIntent(policy, input);

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.reasons).toContain("RISK_CANCEL_ALWAYS_PERMITTED");
  });

  it("freshness is CALLER-SUPPLIED: the same inputs give the same verdict twice", () => {
    const first = evaluateIntent(policy, entryInput());
    const second = evaluateIntent(policy, entryInput());
    expect(first.approved).toBe(second.approved);
    expect(first.worstCase).toEqual(second.worstCase);
  });
});

describe("acceptance 4 — no record is edited in place (the resize path was deleted by C1-RISK)", () => {
  function approvedRecord() {
    const result = evaluateIntent(riskPolicy(), entryInput());
    if (!result.approved) throw new Error(JSON.stringify(result.refusals));
    return result.record;
  }

  it("the record is deeply frozen, so an in-place edit THROWS", () => {
    const original = approvedRecord();
    expect(Object.isFrozen(original)).toBe(true);
    expect(() => {
      (original.intent as { targetShares: string }).targetShares = "999";
    }).toThrow(TypeError);
    expect(original.intent).toMatchObject({ targetShares: "100" });
  });

  it("every record emitted is an ORIGINAL with an EVALUATED worst case", () => {
    const original = approvedRecord();
    expect(original.lineage).toBe("ORIGINAL");
    expect(original.worstCaseBasis).toBe("EVALUATED");
    expect(original.rootApprovedIntentId).toBe(original.approvedIntentId);
    expect("supersedesApprovedIntentId" in original).toBe(false);
  });
});

describe("the baseline fixture really is a passing entry", () => {
  it("approves with the fresh observations the other tests mutate", () => {
    const input = entryInput();
    input.freshness = freshObservations();
    const result = evaluateIntent(riskPolicy(), input);
    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
  });
});
