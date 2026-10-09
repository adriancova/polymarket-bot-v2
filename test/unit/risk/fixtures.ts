/**
 * Shared fixtures for the WP-180 risk and capital-allocator suites.
 *
 * One tree serves both packages (work plan `WP-180` `allowed_paths`:
 * `test/unit/risk/**`). Every builder returns a FRESH mutable object so a test
 * can express "the baseline, except this one thing" by assignment — which keeps
 * each test's delta from the passing baseline visible in one line.
 *
 * The baseline `entryInput()` is deliberately a fully-passing entry: every
 * §9.8 check has its input supplied and satisfied. A test that expects a
 * refusal therefore proves the refusal came from ITS mutation and not from an
 * incidental gap in the fixture — the failure mode that makes fail-closed
 * engines easy to test badly.
 */

import { parseRiskPolicy, type RiskPolicy } from "../../../packages/risk/src/index.js";

/** Canonical lowercase UUIDv7 market ids (§7.2 / ADR-016). */
export const MARKET_A = "01890000-0000-7000-8000-000000000001";
export const MARKET_B = "01890000-0000-7000-8000-000000000002";
/**
 * The strategy instance id — a canonical lowercase UUIDv7 (ADR-021,
 * `WP-180-FU3`). It was `"strat-a"` until this round.
 *
 * WHY IT LEADS WITH A LETTER, AND WHAT THAT MEASURES. `inputs.ts` now types the
 * field `Uuidv7Schema`, so a `0`-leading minted id is ACCEPTED there — that is
 * the ruling, and it is pinned directly, on the door, in
 * `adr-021-instance-identity.test.ts`. This shared constant nevertheless carries
 * a LETTER-LEADING UUIDv7, because it also crosses `packages/capital-allocator`
 * in `ports.test.ts` (the two packages' real end-to-end port), and that package
 * still types the same value `CodeStringSchema` at four sites —
 * `src/reserve.ts:69` and `src/state.ts:68,81,92`. Measured, not assumed: with a
 * `0`-leading id those seven port tests fail with
 * `CAPITAL_INPUT_INVALID … positions.0.strategyInstanceId: must be an
 * alphanumeric code without whitespace`.
 *
 * So the INTERSECTION `apps/trader`'s `UuidAndCodeString` door mints — a
 * canonical lowercase UUIDv7 whose first hex digit is a letter — is still the
 * only shape every merged door in this repository accepts, and ADR-021's
 * "relax the trader to plain `Uuidv7Schema`" follow-up cannot land until
 * `packages/capital-allocator` is re-typed too. That is recorded as this
 * round's reported conflict rather than silently worked around here.
 */
export const INSTANCE = "a1890000-0000-7000-8000-00000000000a";

export const EVALUATED_AT = "2026-09-02T12:00:00.000Z";
export const VALID_UNTIL = "2026-09-02T13:00:00.000Z";

export interface MarketFixture {
  marketId: string;
  status: string;
  tickSize?: string;
  minimumOrderSize?: string;
  parametersVersion?: number;
  secondsToClose?: number;
  settlement?: { modelDependentActivationAllowed: boolean };
  bookSynchronized?: boolean;
  scope?: { seriesKey?: string; underlyingKey?: string; resolutionWindowKey?: string };
}

export interface FreshnessFixture {
  feed: string;
  marketId?: string;
  ageMs: number;
}

export interface ScenarioFixture {
  scenarioId: string;
  kind: string;
  marks: { marketId: string; yesPrice: string }[];
}

export interface EvaluationInputFixture {
  intent: Record<string, unknown>;
  evaluatedAt: string;
  identifiers: { approvedIntentId: string };
  context: {
    runMode: string;
    strategyInstanceId: string;
    runStatePermitsIntent: boolean;
    strategyStatePermitsIntent: boolean;
    venueEligibility?: string;
  };
  markets: MarketFixture[];
  freshness: FreshnessFixture[];
  portfolio: {
    positions: Record<string, unknown>[];
    openOrders: Record<string, unknown>[];
  };
  allocation?: Record<string, unknown>;
  scenarios: ScenarioFixture[];
  guards: { recentIntentIds: string[] };
  rateLimit: { availableRequests?: number };
  economics: { feeEstimate?: string; slippageEstimate?: string };
}

/** A policy with every REQUIRED limit set and no invented example caps. */
export function riskPolicy(overrides: Record<string, unknown> = {}): RiskPolicy {
  const parsed = parseRiskPolicy({
    freshness: {
      venueBookMaxAgeMs: 1000,
      referenceFeedMaxAgeMs: 2000,
      featuresMaxAgeMs: 2000,
    },
    limits: { maxWorstCaseContractualLoss: "10000" },
    scenario: { maxScenarioLoss: "10000" },
    economics: {},
    participation: {},
    rateLimit: { safetyReserveRequests: 5 },
    timeToClose: { entryCutoffSeconds: 60 },
    ...overrides,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
  return parsed.value;
}

export function market(overrides: Partial<MarketFixture> = {}): MarketFixture {
  return {
    marketId: MARKET_A,
    status: "ACTIVE",
    tickSize: "0.01",
    minimumOrderSize: "5",
    parametersVersion: 3,
    secondsToClose: 3600,
    settlement: { modelDependentActivationAllowed: true },
    bookSynchronized: true,
    scope: { seriesKey: "btc-15m", underlyingKey: "BTC", resolutionWindowKey: "w1" },
    ...overrides,
  };
}

/** Every required feed measured and fresh. */
export function freshObservations(marketId = MARKET_A): FreshnessFixture[] {
  return [
    { feed: "VENUE_BOOK", marketId, ageMs: 100 },
    { feed: "REFERENCE_FEED", ageMs: 100 },
    { feed: "FEATURES", ageMs: 100 },
  ];
}

/** All four §9.8 shock kinds, each marking every market the fixtures use. */
export function allScenarios(
  yesPrice = "0.4",
  marketIds: readonly string[] = [MARKET_A],
): ScenarioFixture[] {
  return (["SPOT", "VOLATILITY", "TIME", "LIQUIDITY"] as const).map((kind) => ({
    scenarioId: `scen-${kind.toLowerCase()}`,
    kind,
    marks: marketIds.map((marketId) => ({ marketId, yesPrice })),
  }));
}

/** A §7.7 position intent: BUY 100 YES at no more than 0.5 (bounded cost 50). */
export function positionIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "POSITION",
    intentId: "intent-1",
    marketId: MARKET_A,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: "100",
    maximumBuyPrice: "0.5",
    urgency: "NORMAL",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: VALID_UNTIL,
    expectedNetEdge: "1",
    tags: [],
    ...overrides,
  };
}

/** A §7.7 reduction intent (an EXIT) toward a flat book. */
export function reduceIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "REDUCE_POSITION",
    marketId: MARKET_A,
    targetShares: "0",
    urgency: "NORMAL",
    minimumSellPrice: "0.4",
    reason: "risk reduction",
    ...overrides,
  };
}

export function cancelIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "CANCEL", marketId: MARKET_A, reason: "kill switch", ...overrides };
}

export function position(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    marketId: MARKET_A,
    side: "YES",
    shares: "100",
    costBasis: "40",
    ...overrides,
  };
}

export function openOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: "o-1",
    marketId: MARKET_A,
    side: "YES",
    action: "BUY",
    price: "0.4",
    shares: "100",
    ...overrides,
  };
}

/** The fully-passing ENTRY baseline. Mutate one field per test. */
export function entryInput(): EvaluationInputFixture {
  return {
    intent: positionIntent(),
    evaluatedAt: EVALUATED_AT,
    identifiers: { approvedIntentId: "approved-1" },
    context: {
      runMode: "PAPER",
      strategyInstanceId: INSTANCE,
      runStatePermitsIntent: true,
      strategyStatePermitsIntent: true,
    },
    markets: [market()],
    freshness: freshObservations(),
    portfolio: { positions: [], openOrders: [] },
    allocation: { permitted: true, refusals: [] },
    scenarios: allScenarios(),
    guards: { recentIntentIds: [] },
    rateLimit: { availableRequests: 100 },
    economics: { feeEstimate: "0.1", slippageEstimate: "0.1" },
  };
}

/**
 * The fully-passing EXIT baseline: a held position the reduction can act on.
 * `secondsToClose` is deliberately left inside the entry cutoff nowhere — an
 * exit is not gated by it, and the baseline keeps every entry-only input valid
 * so a test can flip disposition without a second fixture drifting.
 */
export function exitInput(): EvaluationInputFixture {
  const input = entryInput();
  input.intent = reduceIntent();
  input.portfolio.positions = [position()];
  return input;
}

/** Collects reason codes from any refusal-carrying result. */
export function codesOf(result: { refusals: readonly { code: string }[] }): string[] {
  return result.refusals.map((refusal) => refusal.code);
}
