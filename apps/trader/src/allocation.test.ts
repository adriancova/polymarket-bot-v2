/**
 * The §9.7 allocator seam, unit-tested in isolation.
 *
 * The integration suite drives the gate through the assembled system; this file
 * pins the contracts that suite cannot reach cheaply — the FIFO cost basis, the
 * re-application of a held reservation against a changed account, the shadow
 * book, and the leg derivation for intent shapes the Static Bracket never emits.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy } from "@polymarket-bot/risk";
import { describe, expect, it } from "vitest";

import { projectionOf } from "./accounting.js";
import {
  AllocatorGate,
  CostBasisBook,
  intentLegs,
  requestFor,
  type AllocationMarket,
} from "./allocation.js";
import type { MarketConfig } from "./config.js";
import { MarketState } from "./market-state.js";
import { buildRiskEvaluationInput, runRiskCheck } from "./pipeline.js";

const MARKET = "018f4a7e-1111-7abc-8def-0123456789ab";
const INSTANCE = "a18f4a7e-2222-7abc-8def-0123456789ab";
const OTHER = "b18f4a7e-3333-7abc-8def-0123456789ab";

const SCOPE: AllocationMarket = {
  marketId: MARKET,
  seriesKey: "btc-15m-updown",
  underlyingKey: "BTC",
  resolutionWindowKey: "w2026-03-04T12.15",
};

const EMPTY_PROJECTION = projectionOf(Ledger.empty("PAPER"));

function gate(caps: Record<string, unknown> = {}): AllocatorGate {
  const parsed = parseAllocatorCaps({
    globalAccountCap: "1000",
    perStrategyCap: "1000",
    ...caps,
  });
  if (!parsed.ok) throw new Error(`caps refused: ${parsed.refusals[0]?.code ?? "?"}`);
  return new AllocatorGate({
    caps: parsed.value,
    markets: new Map([[MARKET, SCOPE]]),
    tokenAssetIds: new Map([
      [`${MARKET}|YES`, "token:111"],
      [`${MARKET}|NO`, "token:222"],
    ]),
  });
}

function buyIntent(shares = "50", price = "0.35"): Intent {
  return {
    type: "POSITION",
    intentId: "sb-entry-0",
    marketId: MARKET,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: shares,
    maximumBuyPrice: price,
    urgency: "IMMEDIATE",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: "2026-03-04T12:00:30Z",
    tags: [],
  } as unknown as Intent;
}

/** A §7.7 `QUOTE`: levels with prices, and no outcome token anywhere. */
function quoteIntent(): Intent {
  return {
    type: "QUOTE",
    intentId: "q-0",
    marketId: MARKET,
    bids: [{ price: "0.3", shares: "10" }],
    asks: [],
    postOnly: true,
    quoteLifetimeMs: 1000,
    replaceThresholdTicks: 1,
    maximumInventory: "100",
    tags: [],
  } as unknown as Intent;
}

function evaluate(
  subject: AllocatorGate,
  intent: Intent,
  overrides: {
    readonly owners?: readonly { readonly marketId: string; readonly strategyInstanceId: string }[];
    readonly cash?: string;
    readonly accountingMode?: "LIVE" | "SHADOW";
    readonly held?: string;
  } = {},
): ReturnType<AllocatorGate["evaluate"]> {
  return subject.evaluate({
    intent,
    instanceId: INSTANCE,
    accountingMode: overrides.accountingMode ?? "LIVE",
    liveOwners: overrides.owners ?? [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
    projection: EMPTY_PROJECTION,
    availableCollateral: overrides.cash ?? "1000",
    approvedIntentId: "018f4a7e-7000-7abc-8def-000000000001",
    heldShares: () => overrides.held ?? "0",
  });
}

describe("the FIFO cost-basis book", () => {
  it("answers the EXACT remaining cost, with no division anywhere", () => {
    const book = new CostBasisBook();
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "BUY",
      price: "0.3",
      shares: "10",
    });
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "BUY",
      price: "0.4",
      shares: "10",
    });
    expect(book.costBasis(INSTANCE, MARKET, "YES")).toBe("7");

    // FIFO: the 0.3 lot goes first, then half of the 0.4 lot.
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "SELL",
      price: "0.9",
      shares: "15",
    });
    expect(book.costBasis(INSTANCE, MARKET, "YES")).toBe("2");
    expect(book.total()).toBe("2");
  });

  it("is INSTANCE- and SIDE-scoped: one instance never reads another's lots", () => {
    const book = new CostBasisBook();
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "10",
    });
    expect(book.costBasis(OTHER, MARKET, "YES")).toBe("0");
    expect(book.costBasis(INSTANCE, MARKET, "NO")).toBe("0");
    expect(book.costBasis(INSTANCE, MARKET, "YES")).toBe("5");
  });

  it("an oversell empties the book rather than making it NEGATIVE", () => {
    const book = new CostBasisBook();
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "10",
    });
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "SELL",
      price: "0.5",
      shares: "40",
    });
    expect(book.costBasis(INSTANCE, MARKET, "YES")).toBe("0");
  });
});

describe("the allocator gate", () => {
  it("PERMITS a commitment inside the caps, and the verdict carries no refusals", () => {
    const outcome = evaluate(gate(), buyIntent());
    expect(outcome.verdict?.permitted).toBe(true);
    expect(outcome.verdict?.refusals).toEqual([]);
    expect(outcome.requests).toHaveLength(1);
    expect(outcome.requests[0]?.action).toBe("BUY");
    expect(outcome.requests[0]?.shares).toBe("50");
    expect(outcome.requests[0]?.price).toBe("0.35");
  });

  it("REFUSES with the allocator's own codes when a cap binds", () => {
    const outcome = evaluate(gate({ globalAccountCap: "1" }), buyIntent());
    expect(outcome.verdict?.permitted).toBe(false);
    expect(outcome.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_GLOBAL_CAP_EXCEEDED",
    );
  });

  it("REFUSES a LIVE commitment on a market with no recorded owner (ADR-011)", () => {
    const outcome = evaluate(gate(), buyIntent(), { owners: [] });
    expect(outcome.verdict?.permitted).toBe(false);
    expect(outcome.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_LIVE_OWNERSHIP_MISSING",
    );
  });

  it("answers NO VERDICT for an intent that commits nothing", () => {
    const cancel = { type: "CANCEL", marketId: MARKET, reason: "operator" } as unknown as Intent;
    const outcome = evaluate(gate(), cancel);
    expect(outcome.verdict).toBeUndefined();
    expect(outcome.requests).toEqual([]);
  });

  it("the exposure snapshot ANSWERS for every scope the evaluation queries", () => {
    const outcome = evaluate(gate(), buyIntent());
    // An ABSENT entry is what `RISK_EXPOSURE_ENTRY_MISSING` refuses, so each of
    // these must be PRESENT — as an explicit zero on an empty account.
    expect(Object.hasOwn(outcome.exposures.byStrategyInstance, INSTANCE)).toBe(true);
    expect(Object.hasOwn(outcome.exposures.byMarket, MARKET)).toBe(true);
    expect(Object.hasOwn(outcome.exposures.bySeries, SCOPE.seriesKey)).toBe(true);
    expect(Object.hasOwn(outcome.exposures.byUnderlying, SCOPE.underlyingKey)).toBe(true);
    expect(Object.hasOwn(outcome.exposures.byResolutionWindow, SCOPE.resolutionWindowKey)).toBe(
      true,
    );
    expect(outcome.exposures.global.combined).toBe("0");
  });

  it("the SHADOW arm is the package's, and the TRADER never asks for it", () => {
    // What the arm DOES: no live owner is needed, and the caps are compared
    // against the instance's own shadow book instead of the account.
    const outcome = evaluate(gate(), buyIntent(), {
      accountingMode: "SHADOW",
      owners: [],
    });
    expect(outcome.verdict?.permitted).toBe(true);
    expect(Object.hasOwn(outcome.exposures.byMarket, MARKET)).toBe(true);
    expect(outcome.requests[0]?.accountingMode).toBe("SHADOW");

    // WHY THAT IS DANGEROUS FOR THIS PROCESS, and why `loop.ts` passes a
    // constant `LIVE` (review round 2, HIGH-1). The same commitment on the LIVE
    // arm — the one every order that reaches the shared venue, cash balance and
    // ledger must be judged on — is REFUSED, by name, for want of an owner.
    const live = evaluate(gate(), buyIntent(), { accountingMode: "LIVE", owners: [] });
    expect(live.verdict?.permitted).toBe(false);
    expect(live.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_LIVE_OWNERSHIP_MISSING",
    );
    // The shadow arm never even asks the question: that is the whole gap.
    expect(outcome.verdict?.refusals).toEqual([]);
  });

  it("an APPLIED reservation is visible to the next evaluation, and RELEASING returns it", () => {
    const subject = gate();
    const request = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-000000000009",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "50" },
      market: SCOPE,
    });
    const applied = subject.applyForPlan({
      entries: [{ plannedOrderId: "planned-1", request }],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "20",
    });
    expect(applied.ok).toBe(true);
    expect(subject.metrics().open).toBe(1);
    expect(subject.metrics().reservedCollateral).toBe("17.5");

    // 20 available, 17.5 already reserved: a second identical commitment cannot
    // be funded, and the allocator says so by name.
    const second = evaluate(subject, buyIntent(), { cash: "20" });
    expect(second.verdict?.permitted).toBe(false);
    expect(second.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_COLLATERAL_INSUFFICIENT",
    );

    expect(subject.release("planned-1")).toBe(true);
    expect(subject.release("planned-1")).toBe(false);
    expect(subject.metrics().open).toBe(0);
    expect(subject.metrics().released).toBe(1);
    expect(evaluate(subject, buyIntent(), { cash: "20" }).verdict?.permitted).toBe(true);
  });

  it("a plan is reserved ALL OR NONE: a refused leg applies nothing", () => {
    const subject = gate();
    const affordable = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-00000000000a",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "50" },
      market: SCOPE,
    });
    const unaffordable = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-00000000000b",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "500" },
      market: SCOPE,
    });
    const applied = subject.applyForPlan({
      entries: [
        { plannedOrderId: "planned-1", request: affordable },
        { plannedOrderId: "planned-2", request: unaffordable },
      ],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "20",
    });
    expect(applied.ok).toBe(false);
    expect(subject.metrics().open).toBe(0);
    expect(subject.metrics().applied).toBe(0);
    // The refusal is COUNTED under the allocator's own vocabulary.
    expect(Object.keys(subject.metrics().refusalsByCode)).toContain(
      "CAPITAL_COLLATERAL_INSUFFICIENT",
    );
  });

  it("a HAND-BUILT caps object that weakens the AGENTS.md floor is refused at the gate", () => {
    // `parseAllocatorCaps` cannot produce these caps — the live-micro fence
    // refuses them at the door — so this is the second fence layer:
    // `evaluateReservation` re-applies it at the ENFORCEMENT site, and the
    // trader's answer is a REFUSED verdict rather than an absent one. A missing
    // verdict would read to §9.8 check 14 as "no allocator ran".
    type Caps = ConstructorParameters<typeof AllocatorGate>[0]["caps"];
    const weakened = {
      globalAccountCap: "1000",
      perStrategyCap: "1000",
      liveMicroMaxOrderNotional: "5",
      liveMicroMaxAccountExposure: "5",
    } as unknown as Caps;
    const subject = new AllocatorGate({
      caps: weakened,
      markets: new Map([[MARKET, SCOPE]]),
      tokenAssetIds: new Map(),
    });
    const outcome = evaluate(subject, buyIntent());
    expect(outcome.verdict?.permitted).toBe(false);
    expect(outcome.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED",
    );
  });
});

describe("the intent leg derivation", () => {
  it("a TARGET-mode position resolves against the held shares", () => {
    const target = {
      ...(buyIntent("50") as unknown as Record<string, unknown>),
      targetMode: "TARGET",
    } as unknown as Intent;
    expect(intentLegs(target, () => "20")[0]?.shares).toBe("30");
    // Already at target: nothing to commit.
    expect(intentLegs(target, () => "50")).toEqual([]);
  });

  it("a NEGATIVE delta is a SELL of its absolute size", () => {
    const exit = {
      ...(buyIntent("-30") as unknown as Record<string, unknown>),
      maximumBuyPrice: undefined,
      minimumSellPrice: "0.5",
    } as unknown as Intent;
    const legs = intentLegs(exit, () => "50");
    expect(legs[0]?.action).toBe("SELL");
    expect(legs[0]?.shares).toBe("30");
    expect(legs[0]?.price).toBe("0.5");
  });

  it("an UNPRICED leg produces NO request — a bound nobody stated is not invented", () => {
    const unpriced = {
      ...(buyIntent("50") as unknown as Record<string, unknown>),
      maximumBuyPrice: undefined,
    } as unknown as Intent;
    expect(intentLegs(unpriced, () => "0")).toEqual([]);
  });

  it("a REDUCE_POSITION sells the excess on each side the portfolio holds", () => {
    const reduce = {
      type: "REDUCE_POSITION",
      marketId: MARKET,
      targetShares: "10",
      urgency: "NORMAL",
      minimumSellPrice: "0.4",
      reason: "protective",
    } as unknown as Intent;
    const legs = intentLegs(reduce, (_marketId, side) => (side === "YES" ? "50" : "0"));
    expect(legs).toHaveLength(1);
    expect(legs[0]?.side).toBe("YES");
    expect(legs[0]?.shares).toBe("40");
  });

  it("a QUOTE names no outcome token, so it produces no request", () => {
    expect(intentLegs(quoteIntent(), () => "0")).toEqual([]);
  });
});

/**
 * The other half of "fails closed", MEASURED (review round 2, MEDIUM-1).
 *
 * `intentLegs` returning `[]` for a `QUOTE` is only half a claim: the claim that
 * matters is what the RISK ENGINE then does with the absent verdict. The
 * assertion above measured the first half and asserted the second in prose. This
 * drives both, through the two functions `loop.ts` calls in sequence and with
 * nothing substituted for either — the allocator's own `undefined`, and
 * `packages/risk`'s own answer to it.
 *
 * §9.8 check 14 is fail-closed by construction: an absent allocator verdict on
 * an ENTRY (and `packages/risk` classifies a `QUOTE` as one) is
 * `RISK_ALLOCATION_VERDICT_MISSING` — "the allocator was not asked".
 */
describe("an intent the allocator cannot price is REFUSED downstream", () => {
  const marketConfig: MarketConfig = {
    marketId: MARKET,
    conditionId: "0xcondition",
    yesTokenId: "111",
    noTokenId: "222",
    tickSize: "0.01",
    minimumOrderSize: "5",
    makerFeeRate: "0",
    takerFeeRate: "0",
    openTime: "2026-03-04T12:00:00.000Z",
    closeTime: "2026-03-04T12:15:00.000Z",
    parametersVersion: 1,
    settlementReadiness: { modelDependentActivationAllowed: true },
    seriesKey: SCOPE.seriesKey,
    underlyingKey: SCOPE.underlyingKey,
    resolutionWindowKey: SCOPE.resolutionWindowKey,
  } as MarketConfig;

  function refusalCodesFor(intent: Intent): readonly string[] {
    const subject = gate();
    const allocation = subject.evaluate({
      intent,
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "1000",
      approvedIntentId: "018f4a7e-7000-7abc-8def-000000000021",
      heldShares: () => "0",
    });
    const market = new MarketState({ config: marketConfig, tradeWindowMs: 60_000, maximumTrades: 8 });
    market.markLifecycle("OPEN");
    const policy = parseRiskPolicy({
      freshness: { venueBookMaxAgeMs: 600_000, referenceFeedMaxAgeMs: 600_000, featuresMaxAgeMs: 600_000 },
      limits: { maxWorstCaseContractualLoss: "1000" },
      scenario: { maxScenarioLoss: "1000" },
      economics: {},
      participation: {},
      rateLimit: { safetyReserveRequests: 0 },
      timeToClose: { entryCutoffSeconds: 30 },
    });
    if (!policy.ok) throw new Error("the fixture risk policy was refused");
    const evaluation = runRiskCheck(
      policy.value,
      buildRiskEvaluationInput({
        intent,
        evaluatedAt: "2026-03-04T12:00:05.000Z",
        approvedIntentId: "018f4a7e-7000-7abc-8def-000000000021",
        runMode: "PAPER",
        strategyInstanceId: INSTANCE,
        runStatePermitsIntent: true,
        strategyStatePermitsIntent: true,
        market,
        marketConfig,
        secondsToClose: 600,
        bookSynchronized: true,
        venueBookAgeMs: 0,
        featuresAgeMs: 0,
        referenceFeedAgeMs: 0,
        positions: [],
        openOrders: [],
        // The allocator's OWN answers, passed through exactly as `loop.ts`
        // passes them. Nothing is fabricated for the absent case.
        exposures: allocation.exposures,
        allocation: allocation.verdict,
        recentIntentIds: [],
        availableRequests: 100,
        parametersVersion: 1,
        modelDependentActivationAllowed: true,
        scenarios: [],
      }),
    );
    expect(evaluation.approved).toBe(false);
    return evaluation.refusals.map((refusal) => refusal.code);
  }

  it("a QUOTE carries NO verdict, and check 14 refuses it for exactly that reason", () => {
    const subject = gate();
    const outcome = subject.evaluate({
      intent: quoteIntent(),
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "1000",
      approvedIntentId: "018f4a7e-7000-7abc-8def-000000000021",
      heldShares: () => "0",
    });
    // ABSENT, not a permissive verdict. The distinction is the whole check.
    expect(outcome.verdict).toBeUndefined();

    expect(refusalCodesFor(quoteIntent())).toContain("RISK_ALLOCATION_VERDICT_MISSING");
  });

  it("an UNPRICED position fails closed the same way — a leg nobody bounded", () => {
    const unpriced = {
      ...(buyIntent("50") as unknown as Record<string, unknown>),
      maximumBuyPrice: undefined,
    } as unknown as Intent;
    expect(refusalCodesFor(unpriced)).toContain("RISK_ALLOCATION_VERDICT_MISSING");
  });

  it("a PRICED position on the same path is refused as REFUSED, not as MISSING", () => {
    // The control, and the distinction check 14 exists to make: this intent is
    // priced, so a verdict EXISTS — 50000 shares at `0.35` is far over the
    // `1000` global cap, so the verdict says no. `RISK_ALLOCATION_REFUSED` is
    // "the allocator answered and refused"; `RISK_ALLOCATION_VERDICT_MISSING`
    // is "the allocator was never asked". A harness that refused everything
    // would not tell them apart, and this asserts both directions.
    const codes = refusalCodesFor(buyIntent("50000"));
    expect(codes).toContain("RISK_ALLOCATION_REFUSED");
    expect(codes).not.toContain("RISK_ALLOCATION_VERDICT_MISSING");
  });
});
