/**
 * `CAP-1` r0 — the orchestrator's ruling on §9.8 checks 16 and 17
 * (2026-10-04): a filled-but-unbooked BUY enters the risk engine through a
 * SEPARATE input (`unbookedFills`), counted by checks 16 and 17 exactly as a
 * booked position of the same side and token, read by nothing else, and able
 * only to make those two checks more conservative.
 *
 * Self-contained (this suite is type-checked under `packages/risk`'s own
 * `rootDir`, so it cannot import `test/unit/risk/fixtures.ts`); the baseline
 * below mirrors that fixture's fully passing ENTRY, and the first pin proves it
 * passes, so every refusal a later pin expects comes from that pin's delta.
 */

import { addDecimal, compareDecimal, mulDecimal } from "@polymarket-bot/decimal";
import { describe, expect, it } from "vitest";

import { evaluateIntent, type RiskEvaluation } from "./engine.js";
import { buildIntentView } from "./intent-view.js";
import type { PortfolioView, UnbookedFillExposure } from "./inputs.js";
import { buildWorstCaseLots } from "./lots.js";
import { parseRiskPolicy, type RiskPolicy } from "./policy.js";
import { assessScenarios } from "./scenario.js";
import { comparedScenarioLoss, notBelowBookedOnly } from "./unbooked.js";
import { assessWorstCase } from "./worst-case.js";

const MARKET = "01890000-0000-7000-8000-0000000000c1";
const OTHER_MARKET = "01890000-0000-7000-8000-0000000000c2";
const INSTANCE = "a1890000-0000-7000-8000-0000000000ca";
const KINDS = ["SPOT", "VOLATILITY", "TIME", "LIQUIDITY"] as const;

// THIS SUITE IS WRITTEN WITHOUT a spread, a destructuring, an element access or
// an `Object.*` call: `test/unit/risk/prototype-access.test.ts` censuses every
// colocated suite in this package against a pinned per-file budget, and a new
// file is admitted there only with no prototype-consulting site at all.

interface PolicyLimits {
  readonly worstCase?: string | undefined;
  readonly resolution?: string | undefined;
  readonly scenario?: string | undefined;
}

function policy(limits: PolicyLimits = {}): RiskPolicy {
  const document: { maxWorstCaseContractualLoss: string; maxWorstCaseResolutionLoss?: string } = {
    maxWorstCaseContractualLoss: limits.worstCase ?? "10000",
  };
  if (limits.resolution !== undefined) document.maxWorstCaseResolutionLoss = limits.resolution;
  const parsed = parseRiskPolicy({
    freshness: { venueBookMaxAgeMs: 1000, referenceFeedMaxAgeMs: 2000, featuresMaxAgeMs: 2000 },
    limits: document,
    scenario: { maxScenarioLoss: limits.scenario ?? "10000" },
    economics: {},
    participation: {},
    rateLimit: { safetyReserveRequests: 5 },
    timeToClose: { entryCutoffSeconds: 60 },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
  return parsed.value;
}

function market(marketId: string): Record<string, unknown> {
  return {
    marketId,
    status: "ACTIVE",
    tickSize: "0.01",
    minimumOrderSize: "5",
    parametersVersion: 3,
    secondsToClose: 3600,
    settlement: { modelDependentActivationAllowed: true },
    bookSynchronized: true,
    scope: { seriesKey: "btc-15m", underlyingKey: "BTC", resolutionWindowKey: "w1" },
  };
}

/** A §7.7 BUY: by default 10 YES at no more than 0.35 (bounded cost 3.5). */
function buyIntent(leg: { readonly direction?: "YES" | "NO"; readonly targetShares?: string; readonly maximumBuyPrice?: string } = {}): Record<string, unknown> {
  return {
    type: "POSITION",
    intentId: "intent-cap1-r0",
    marketId: MARKET,
    direction: leg.direction ?? "YES",
    targetMode: "DELTA",
    targetShares: leg.targetShares ?? "10",
    maximumBuyPrice: leg.maximumBuyPrice ?? "0.35",
    urgency: "NORMAL",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: "2026-09-02T13:00:00.000Z",
    expectedNetEdge: "1",
    tags: [],
  };
}

/** A SELL of YES (a negative DELTA, or an ABSOLUTE target), bounded at 0.3. */
function sellIntent(targetMode: "DELTA" | "ABSOLUTE", targetShares: string): Record<string, unknown> {
  return {
    type: "POSITION",
    intentId: "intent-cap1-r0-sell",
    marketId: MARKET,
    direction: "YES",
    targetMode,
    targetShares,
    minimumSellPrice: "0.3",
    urgency: "NORMAL",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: "2026-09-02T13:00:00.000Z",
    expectedNetEdge: "1",
    tags: [],
  };
}

type Scenarios = { scenarioId: string; kind: string; marks: { marketId: string; yesPrice: string }[] }[];

interface Input {
  intent: Record<string, unknown>;
  evaluatedAt: string;
  identifiers: { approvedIntentId: string };
  context: { runMode: string; strategyInstanceId: string; runStatePermitsIntent: boolean; strategyStatePermitsIntent: boolean };
  markets: Record<string, unknown>[];
  freshness: Record<string, unknown>[];
  portfolio: { positions: Record<string, unknown>[]; openOrders: Record<string, unknown>[] };
  unbookedFills?: readonly unknown[];
  allocation: { permitted: boolean; refusals: never[] };
  scenarios: Scenarios;
  guards: { recentIntentIds: string[] };
  rateLimit: { availableRequests: number };
  economics: { feeEstimate: string; slippageEstimate: string };
}

interface InputParts {
  readonly intent?: Record<string, unknown>;
  readonly positions?: Record<string, unknown>[];
  readonly openOrders?: Record<string, unknown>[];
  readonly unbookedFills?: readonly unknown[];
  readonly scenarios?: Scenarios;
  readonly marketIds?: readonly string[];
}

/** The fully passing ENTRY baseline (the shape of `test/unit/risk/fixtures.ts`'s `entryInput`), with `parts` set. */
function entryInput(parts: InputParts = {}): Input {
  const input: Input = {
    intent: parts.intent ?? buyIntent(),
    evaluatedAt: "2026-09-02T12:00:00.000Z",
    identifiers: { approvedIntentId: "approved-cap1-r0" },
    context: { runMode: "PAPER", strategyInstanceId: INSTANCE, runStatePermitsIntent: true, strategyStatePermitsIntent: true },
    markets: (parts.marketIds ?? [MARKET]).map(market),
    freshness: [
      { feed: "VENUE_BOOK", marketId: MARKET, ageMs: 100 },
      { feed: "REFERENCE_FEED", ageMs: 100 },
      { feed: "FEATURES", ageMs: 100 },
    ],
    portfolio: { positions: parts.positions ?? [], openOrders: parts.openOrders ?? [] },
    allocation: { permitted: true, refusals: [] },
    scenarios: parts.scenarios ?? scenarios("0.4", [MARKET]),
    guards: { recentIntentIds: [] },
    rateLimit: { availableRequests: 100 },
    economics: { feeEstimate: "0.1", slippageEstimate: "0.1" },
  };
  if (parts.unbookedFills !== undefined) input.unbookedFills = parts.unbookedFills;
  return input;
}

function scenarios(yesPrice: string, marketIds: readonly string[]): Scenarios {
  return KINDS.map((kind) => ({
    scenarioId: `scen-${kind.toLowerCase()}`,
    kind,
    marks: marketIds.map((marketId) => ({ marketId, yesPrice })),
  }));
}

function unbooked(shares: string, debit: string, side: "YES" | "NO" = "YES", marketId = MARKET): UnbookedFillExposure {
  return { marketId, side, shares, debit };
}

function position(shares: string, costBasis: string, side: "YES" | "NO" = "YES"): Record<string, unknown> {
  return { marketId: MARKET, side, shares, costBasis };
}

function codesOf(evaluation: RiskEvaluation): string[] {
  return evaluation.refusals.map((refusal) => refusal.code);
}

describe("CAP-1 r0: the separate unbookedFills input — what it is", () => {
  it("the baseline passes, and ABSENT and EMPTY are the same answer: the measure before CAP-1", () => {
    const absent = evaluateIntent(policy(), entryInput());
    expect(codesOf(absent)).toEqual([]);
    expect(absent.approved).toBe(true);
    expect(evaluateIntent(policy(), entryInput({ unbookedFills: [] }))).toEqual(absent);
  });

  it("is counted by checks 16 and 17 EXACTLY as a booked position of the same side and token", () => {
    for (const held of [
      { side: "YES", shares: "10", debit: "3.4" },
      { side: "NO", shares: "7", debit: "4.55" },
      { side: "YES", shares: "0.5", debit: "0.17" },
    ] as const) {
      const booked = evaluateIntent(policy(), entryInput({ positions: [position(held.shares, held.debit, held.side)] }));
      const pending = evaluateIntent(policy(), entryInput({ unbookedFills: [unbooked(held.shares, held.debit, held.side)] }));
      expect(pending.worstCase).toEqual(booked.worstCase);
      expect(pending.scenario).toEqual(booked.scenario);
    }
  });

  it("a malformed entry is refused at the door (RISK_INPUT_INVALID), never read as zero", () => {
    for (const entry of [
      { marketId: MARKET, side: "YES", shares: "-1", debit: "0.3" },
      { marketId: MARKET, side: "YES", shares: "1", debit: "-0.3" },
      { marketId: MARKET, side: "MAYBE", shares: "1", debit: "0.3" },
      { marketId: MARKET, side: "YES", shares: "1", debit: "0.3", price: "0.3" },
    ]) {
      expect(codesOf(evaluateIntent(policy(), entryInput({ unbookedFills: [entry] })))).toEqual(["RISK_INPUT_INVALID"]);
    }
  });

  it("check 16 (PRIMARY): the R4-CAP shape — 3.40 booked + 3.40 FILLED and not booked + the 3.50 BUY = 10.30 > 8 is REFUSED, as the booked control is; without the input it measured 6.90 and passed", () => {
    const withUnbooked = evaluateIntent(policy({ worstCase: "8" }), entryInput({ positions: [position("10", "3.4")], unbookedFills: [unbooked("10", "3.4")] }));
    const bookedControl = evaluateIntent(policy({ worstCase: "8" }), entryInput({ positions: [position("20", "6.8")] }));
    const withoutIt = evaluateIntent(policy({ worstCase: "8" }), entryInput({ positions: [position("10", "3.4")] }));
    expect(codesOf(withUnbooked)).toEqual(["RISK_WORST_CASE_LOSS_EXCEEDED"]);
    expect(codesOf(bookedControl)).toEqual(["RISK_WORST_CASE_LOSS_EXCEEDED"]);
    expect(withUnbooked.worstCase?.maximumContractualLoss).toBe("10.3");
    expect(bookedControl.worstCase?.maximumContractualLoss).toBe("10.3");
    expect(withoutIt.worstCase?.maximumContractualLoss).toBe("6.9");
    expect(withoutIt.approved).toBe(true);
  });
});

describe("CAP-1 r0: what the separate input is NOT", () => {
  it("NOT a sellable position (§6 invariant 10): a SELL is covered by the BOOKED shares only — 10 booked + 10 unbooked cannot cover a SELL of 15, and unbooked shares alone cover nothing", () => {
    const fifteen = evaluateIntent(policy(), entryInput({ intent: sellIntent("DELTA", "-15"), positions: [position("10", "3.4")], unbookedFills: [unbooked("10", "3.4")] }));
    expect(codesOf(fifteen)).toContain("RISK_SELL_EXCEEDS_INVENTORY");
    const onlyUnbooked = evaluateIntent(policy(), entryInput({ intent: sellIntent("DELTA", "-5"), unbookedFills: [unbooked("10", "3.4")] }));
    expect(codesOf(onlyUnbooked)).toContain("RISK_SELL_EXCEEDS_INVENTORY");
  });

  it("a protective SELL of the whole BOOKED position in the window is an EXIT, sized to the booked shares, and admitted even where check 16 refuses any entry", () => {
    const exit = evaluateIntent(policy({ worstCase: "5" }), entryInput({ intent: sellIntent("ABSOLUTE", "0"), positions: [position("10", "3.4")], unbookedFills: [unbooked("10", "3.4")] }));
    expect(codesOf(exit)).toEqual([]);
    expect(exit.approved).toBe(true);
    // The exit's leg is the booked position's size, read from positions alone.
    const built = buildIntentView(sellIntent("ABSOLUTE", "0") as never, { positions: [position("10", "3.4")], openOrders: [] } as unknown as PortfolioView);
    expect(built.view.disposition).toBe("EXIT");
    expect(built.view.legs.map((leg) => leg.shares)).toEqual(["10"]);
    // An entry in the same window is refused: 3.4 + 3.4 + 3.5 > 5.
    const entry = evaluateIntent(policy({ worstCase: "5" }), entryInput({ positions: [position("10", "3.4")], unbookedFills: [unbooked("10", "3.4")] }));
    expect(codesOf(entry)).toEqual(["RISK_WORST_CASE_LOSS_EXCEEDED"]);
  });

  it("NOT an open order (§9.8 check 18): a SELL priced below the FILLED BUY never trips RISK_SELF_TRADE through it — while the same BUY, still RESTING, does", () => {
    const filled = evaluateIntent(policy(), entryInput({ intent: sellIntent("DELTA", "-5"), unbookedFills: [unbooked("10", "3.5")] }));
    expect(codesOf(filled)).not.toContain("RISK_SELF_TRADE");
    const resting = evaluateIntent(
      policy(),
      entryInput({ intent: sellIntent("DELTA", "-5"), openOrders: [{ orderId: "o-1", marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "10" }] }),
    );
    expect(codesOf(resting)).toContain("RISK_SELF_TRADE");
  });
});

describe("CAP-1 r0: MONOTONE — an unbooked fill may raise a check-16 or check-17 measure, never lower one", () => {
  it("check 16's resolution limit: a YES fill against a held NO forms a pair that redeems 1 under every verified outcome; the compared loss stays the booked-only 2.75, and the BUY is refused as before", () => {
    const positions = [position("10", "6", "NO")];
    const intent = buyIntent({ targetShares: "5" });
    // Booked-only: cost 6 + 1.75; YES 5 / NO 10 redeem at worst 5: loss 2.75.
    const base = evaluateIntent(policy({ resolution: "2.5" }), entryInput({ intent, positions }));
    expect(codesOf(base)).toEqual(["RISK_WORST_CASE_RESOLUTION_LOSS_EXCEEDED"]);
    expect(base.worstCase?.worstCaseResolutionLoss).toBe("2.75");
    const pending = evaluateIntent(policy({ resolution: "2.5" }), entryInput({ intent, positions, unbookedFills: [unbooked("10", "3.4")] }));
    // Measured WITH the fill: cost 11.15; YES 15 / NO 10 redeem at worst 10: loss 1.15.
    expect(pending.worstCase?.worstCaseResolutionLoss).toBe("1.15");
    // Compared: never below the booked-only 2.75.
    expect(codesOf(pending)).toEqual(["RISK_WORST_CASE_RESOLUTION_LOSS_EXCEEDED"]);
    expect(pending.refusals.at(0)?.details).toMatchObject({ worstCaseResolutionLoss: "2.75" });
  });

  it("check 17: a fill bought BELOW the shocked mark would lower the scenario loss; the compared worst stays the booked-only 1.25, and the BUY is refused as before", () => {
    const positions = [position("10", "4")];
    const intent = buyIntent({ targetShares: "5" });
    const marks = scenarios("0.3", [MARKET]);
    // Booked-only: (4 + 1.75) − 15 × 0.3 = 1.25.
    const base = evaluateIntent(policy({ scenario: "1" }), entryInput({ intent, positions, scenarios: marks }));
    expect(codesOf(base)).toEqual(["RISK_SCENARIO_LOSS_EXCEEDED"]);
    expect(base.scenario?.worstLoss).toBe("1.25");
    const pending = evaluateIntent(policy({ scenario: "1" }), entryInput({ intent, positions, scenarios: marks, unbookedFills: [unbooked("10", "2")] }));
    // Measured WITH the fill bought at 0.20: (4 + 2 + 1.75) − 25 × 0.3 = 0.25.
    expect(pending.scenario?.worstLoss).toBe("0.25");
    expect(codesOf(pending)).toEqual(["RISK_SCENARIO_LOSS_EXCEEDED"]);
    expect(pending.refusals.at(0)?.details).toMatchObject({ worstLoss: "1.25" });
  });

  it("C1-RISK: an unbooked fill in a market no scenario marks is valued at 0 — its whole debit counts as scenario loss — and that loss is compared and refused like any other", () => {
    // Measured: MARKET (3.5 − 10 × 0.4 = −0.5) plus the unmarked OTHER_MARKET
    // fill at its full debit 3.4 = 2.9. Admitted under the default limit.
    const pending = evaluateIntent(policy(), entryInput({ unbookedFills: [unbooked("10", "3.4", "YES", OTHER_MARKET)] }));
    expect(codesOf(pending)).toEqual([]);
    expect(pending.scenario?.worstLoss).toBe("2.9");
    // At the limit it passes; one cent under, it is refused with that figure.
    expect(codesOf(evaluateIntent(policy({ scenario: "2.9" }), entryInput({ unbookedFills: [unbooked("10", "3.4", "YES", OTHER_MARKET)] })))).toEqual([]);
    const tight = evaluateIntent(policy({ scenario: "2.89" }), entryInput({ unbookedFills: [unbooked("10", "3.4", "YES", OTHER_MARKET)] }));
    expect(codesOf(tight)).toEqual(["RISK_SCENARIO_LOSS_EXCEEDED"]);
    expect(tight.refusals.at(0)?.details).toMatchObject({ worstLoss: "2.9" });

    // With a booked position too: (4 + 1.75 + 3.4) − 15 × 0.3 = 4.65, above
    // the booked-only 1.25, so 4.65 is the compared figure.
    const both = evaluateIntent(
      policy({ scenario: "1" }),
      entryInput({
        intent: buyIntent({ targetShares: "5" }),
        positions: [position("10", "4")],
        scenarios: scenarios("0.3", [MARKET]),
        unbookedFills: [unbooked("10", "3.4", "YES", OTHER_MARKET)],
      }),
    );
    expect(codesOf(both)).toEqual(["RISK_SCENARIO_LOSS_EXCEEDED"]);
    expect(both.refusals.at(0)?.details).toMatchObject({ worstLoss: "4.65" });
  });
});

// ---------------------------------------------------------------------------
// The seeded property
// ---------------------------------------------------------------------------

/** `mulberry32`: a small seeded PRNG — deterministic, never a host source. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, choices: readonly T[]): T {
  const chosen = choices.at(Math.floor(random() * choices.length));
  if (chosen === undefined) throw new Error("pick from an empty list");
  return chosen;
}

const PRICES = ["0.05", "0.2", "0.34", "0.5", "0.66", "0.8", "0.95"] as const;
const SIZES = ["1", "5", "10", "12.5", "40"] as const;
const SIDES = ["YES", "NO"] as const;
const CHECKS_16_AND_17 = new Set([
  "RISK_WORST_CASE_LOSS_EXCEEDED",
  "RISK_WORST_CASE_RESOLUTION_LOSS_EXCEEDED",
  "RISK_SCENARIO_LOSS_EXCEEDED",
  "RISK_SCENARIO_MISSING",
]);

/** One random state: a portfolio, resting orders, unbooked fills, scenario marks, an intent and limits. */
function randomState(random: () => number): {
  readonly build: (withUnbooked: boolean) => Input;
  readonly fills: readonly UnbookedFillExposure[];
  readonly cancel: boolean;
  readonly policy: RiskPolicy;
} {
  const markets = random() < 0.3 ? [MARKET, OTHER_MARKET] : [MARKET];
  const positions: Record<string, unknown>[] = [];
  for (let index = 0; index < Math.floor(random() * 3); index += 1) {
    const shares = pick(random, SIZES);
    positions.push({ marketId: pick(random, markets), side: pick(random, SIDES), shares, costBasis: mulDecimal(shares, pick(random, PRICES)) });
  }
  const openOrders: Record<string, unknown>[] = [];
  for (let index = 0; index < Math.floor(random() * 3); index += 1) {
    openOrders.push({
      orderId: `o-${String(index)}`,
      marketId: pick(random, markets),
      side: pick(random, SIDES),
      action: random() < 0.6 ? "BUY" : "SELL",
      price: pick(random, PRICES),
      shares: pick(random, SIZES),
    });
  }
  const fills: UnbookedFillExposure[] = [];
  for (let index = 0; index < Math.floor(random() * 4); index += 1) {
    const shares = pick(random, SIZES);
    fills.push(unbooked(shares, mulDecimal(shares, pick(random, PRICES)), pick(random, SIDES), pick(random, markets)));
  }
  // Marks: usually every market; sometimes the first market only (the other is valued at 0).
  const marked = random() < 0.85 ? markets : [MARKET];
  const scenarioList = KINDS.map((kind) => ({
    scenarioId: `scen-${kind.toLowerCase()}`,
    kind,
    marks: marked.map((marketId) => ({ marketId, yesPrice: pick(random, PRICES) })),
  }));
  const draw = random();
  const cancel = draw >= 0.875;
  const intent =
    draw < 0.75
      ? buyIntent({ direction: pick(random, SIDES), targetShares: pick(random, SIZES), maximumBuyPrice: pick(random, PRICES) })
      : cancel
        ? { type: "CANCEL", marketId: MARKET, reason: "cap1 r0 property" }
        : sellIntent("DELTA", `-${pick(random, SIZES)}`);
  const limit = (): string => pick(random, ["0.5", "2", "5", "10", "25", "60", "10000"]);
  const limits: PolicyLimits = { worstCase: limit(), resolution: random() < 0.6 ? limit() : undefined, scenario: limit() };
  return {
    build: (withUnbooked) =>
      entryInput(
        withUnbooked
          ? { intent, positions, openOrders, scenarios: scenarioList, marketIds: markets, unbookedFills: fills }
          : { intent, positions, openOrders, scenarios: scenarioList, marketIds: markets },
      ),
    fills,
    cancel,
    policy: policy(limits),
  };
}

/**
 * Yields to the macrotask queue so a long synchronous stretch never starves
 * the worker's RPC with vitest (CI-2; `CAP1-R1-GATE-1`).
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("CAP-1 r0 property — for the same state, the candidate's check-16 and check-17 losses are at least the booked-only ones, equal when nothing is unbooked, and no other check moves", () => {
  it("holds over 3,000 seeded states", async () => {
    let unbookedStates = 0;
    let strictlyRaised = 0;
    let guarded = 0;
    let refusedOnlyWithUnbooked = 0;
    for (let seed = 1; seed <= 3_000; seed += 1) {
      // `CAP1-R1-GATE-1`: one macrotask turn every 100 states.
      if (seed % 100 === 0) await yieldToEventLoop();
      const random = prng(seed);
      const state = randomState(random);
      const where = `seed ${String(seed)}`;
      const fills = state.fills;
      const input = state.build(true);
      if (fills.length > 0) unbookedStates += 1;

      // --- the MEASURES (the engine's own functions, so base is base) ------
      const portfolio = input.portfolio as unknown as PortfolioView;
      const built = buildIntentView(input.intent as never, portfolio);
      const bookedLots = buildWorstCaseLots(portfolio, built.view);
      const lots = buildWorstCaseLots(portfolio, built.view, fills);
      expect(lots === undefined, where).toBe(bookedLots === undefined);
      if (lots !== undefined && bookedLots !== undefined) {
        const base = assessWorstCase(bookedLots);
        const candidate = assessWorstCase(lots);
        // Check 16 PRIMARY: never below — above by exactly the debits.
        let debits = "0";
        for (const fill of fills) debits = addDecimal(debits, fill.debit);
        expect(candidate.maximumContractualLoss, where).toBe(addDecimal(base.maximumContractualLoss, debits));
        // Check 16 secondary, AS COMPARED: never below.
        const resolution = notBelowBookedOnly(candidate.worstCaseResolutionLoss, base.worstCaseResolutionLoss);
        expect(compareDecimal(resolution, base.worstCaseResolutionLoss), where).toBeGreaterThanOrEqual(0);
        if (compareDecimal(candidate.worstCaseResolutionLoss, base.worstCaseResolutionLoss) < 0) guarded += 1;
        // Check 17, AS COMPARED: never below the booked-only worst.
        const scenarioBase = assessScenarios(input.scenarios as never, bookedLots, KINDS);
        const scenarioCandidate = assessScenarios(input.scenarios as never, lots, KINDS);
        const compared = comparedScenarioLoss(scenarioCandidate, scenarioBase);
        if (scenarioBase.worstLoss !== undefined) {
          expect(compared.worstLoss, where).toBeDefined();
          expect(compareDecimal(compared.worstLoss ?? "0", scenarioBase.worstLoss), where).toBeGreaterThanOrEqual(0);
          if (compareDecimal(compared.worstLoss ?? "0", scenarioBase.worstLoss) > 0) strictlyRaised += 1;
        }
        // C1-RISK: an unmarked lot is valued at 0, so every supplied scenario
        // yields a loss for both lot sets.
        expect(scenarioCandidate.worstLoss, where).toBeDefined();
        expect(scenarioBase.worstLoss, where).toBeDefined();
        if (fills.length === 0) {
          expect(candidate, where).toEqual(base);
          expect(scenarioCandidate, where).toEqual(scenarioBase);
          expect(compared.worstLoss, where).toBe(scenarioBase.worstLoss);
        }
      }

      // --- the DECISIONS -----------------------------------------------------
      const before = evaluateIntent(state.policy, state.build(false));
      const after = evaluateIntent(state.policy, input);
      const others = (evaluation: RiskEvaluation): string[] => codesOf(evaluation).filter((code) => !CHECKS_16_AND_17.has(code));
      const sixteenAndSeventeen = (evaluation: RiskEvaluation): string[] => codesOf(evaluation).filter((code) => CHECKS_16_AND_17.has(code));
      // No other check moves, in kind, count or order.
      expect(others(after), where).toEqual(others(before));
      // Checks 16 and 17 only ever ADD refusals.
      for (const code of sixteenAndSeventeen(before)) expect(sixteenAndSeventeen(after), where).toContain(code);
      if (before.approved && !after.approved) refusedOnlyWithUnbooked += 1;
      // A CANCEL is never refused through it (§6 invariant 13).
      if (state.cancel) expect(after.approved, where).toBe(true);
      if (fills.length === 0) expect(after, where).toEqual(before);
    }
    // Non-vacuity: unbooked states occurred; the measure rose; the guard bit; decisions moved.
    expect(unbookedStates).toBeGreaterThan(1_000);
    expect(strictlyRaised).toBeGreaterThan(100);
    expect(guarded).toBeGreaterThan(0);
    expect(refusedOnlyWithUnbooked).toBeGreaterThan(50);
  }, 120_000);
});
