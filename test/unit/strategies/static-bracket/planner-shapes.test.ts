/**
 * WHAT THE VENUE WOULD ACTUALLY BE ASKED TO DO.
 *
 * Every other file in this suite asserts the INTENT this strategy emits. That
 * is not the same question as "what orders does this intent become", and review
 * round 2's BLOCKER lived exactly in the gap: the strategy emitted a §7.7
 * `REDUCE_POSITION` carrying `targetShares: "0"` and a `maximumBuyPrice`, every
 * intent-level assertion passed, and the MERGED execution planner
 * (`packages/execution-planner`, WP-190) turned it into
 *
 *   - `SELL 50 NO @ 0.08` on a complement bracket — a SALE of the token the
 *     bracket is already short, at a price the intent's own bound never
 *     reached, because `buildReductionPlan` reads only `minimumSellPrice`;
 *   - `SELL 60 YES` + `SELL 30 YES` on a direct bracket holding 40 shares of
 *     prior inventory — 90 shares planned for a 50-share allocation;
 *   - `SELL 50 YES` + `SELL 60 NO` + `SELL 40 NO` on a direct bracket holding
 *     100 NO — the whole untraded side dumped, because a reduction's
 *     `targetShares` is a per-side sell-down level for the WHOLE market.
 *
 * So this file drives the strategy's REAL emitted intents through the REAL
 * `buildExecutionPlan` and asserts the SIDE, the SHARE COUNT and the LIMIT
 * PRICE of the resulting legs. This is the assertion class that would have
 * caught both instances, and it is the only place in this suite where the two
 * packages meet.
 *
 * IMPORT DIRECTION. `test/unit` is outside every package's dependency graph and
 * declares no workspace edge — the precedent is `test/unit/risk/ports.test.ts`
 * and `test/unit/execution-planner/fixtures.ts`, which import two packages that
 * are forbidden to import each other. `pnpm check:deps` is re-run and still
 * reports 34 packages / 49 declared workspace edges.
 *
 * PURITY. As everywhere else in this suite: no `Date`, no `Math.random`, no
 * clock. The one `Date.parse` is the shared fixture instant from `helpers.ts`.
 */

import { describe, expect, it } from "vitest";

import type { Intent } from "../../../../packages/domain/src/index.js";
import {
  buildExecutionPlan,
  positionPosture,
  reductionPosture,
  type ExecutionGroup,
  type PlannedOrder,
} from "../../../../packages/execution-planner/src/index.js";
import {
  REASONS,
  staticBracketParamsSchema,
  staticBracketStrategy,
  type StaticBracketState,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import type { DecisionResult } from "../../../../packages/domain/src/index.js";
import {
  MARKET_ID,
  STOP_KEY,
  T_NOW,
  baseConfig,
  configWith,
  context,
  parsedParams,
  protectedReductions,
  stateWith,
} from "./helpers.js";

const NOW_MS = Date.parse(T_NOW);

function params(config: Record<string, unknown> = baseConfig()) {
  return parsedParams(staticBracketParamsSchema, config);
}

const PREFERRING = configWith({
  "entry.economic_leg_policy": "PREFER_CHEAPEST_WITH_INVENTORY",
});

// ---------------------------------------------------------------------------
// The planner's own doors, fed by hand
// ---------------------------------------------------------------------------

/**
 * An approved-intent record around one of this strategy's intents.
 *
 * The record is minted by hand rather than through `packages/risk`, for one
 * reason: what is under test is the STRATEGY's intent, and routing it through a
 * second package's approval rules would let a risk-side refusal hide a
 * planning-side fact. The shape is `record.ts`'s
 * `APPROVED_INTENT_RECORD_KEYS` verbatim — the planner's door refuses an
 * unknown or missing key, so a drift in that shape fails this file loudly
 * rather than silently planning nothing.
 */
function approved(intent: Intent): Record<string, unknown> {
  return {
    approvedIntentId: "approved-1",
    lineage: "ORIGINAL",
    rootApprovedIntentId: "approved-1",
    sourceIntentId: "intent-1",
    intent,
    approvedAt: T_NOW,
    // PAPER, and nothing in this file can raise it: the planner produces plan
    // DATA and has no submission surface at all.
    runMode: "PAPER",
    strategyInstanceId: "instance-1",
    reasons: [],
    worstCase: { maximumLoss: "18" },
    worstCaseBasis: "EVALUATED",
    recommendations: [],
  };
}

interface Inventory {
  /** ACTUAL account holdings for the market, per side. */
  readonly yes?: string;
  readonly no?: string;
  readonly yesBestBid?: string;
  readonly noBestBid?: string;
}

/**
 * Planning inputs over a THIN book, which is what makes the price assertions
 * discriminating: with `noBestBid: "0.1"` a marketable SELL of NO prices at
 * `0.1 − 2 ticks = 0.08`, so an exit that is planned as a sale of the
 * complement token is visible as a number rather than as a shape.
 */
function planningInputs(inventory: Inventory): Record<string, unknown> {
  return {
    executionPlanId: "01890000-0000-7000-8000-0000000000aa",
    plannedAt: T_NOW,
    accountingMode: "SHADOW",
    availableCollateral: "1000",
    markets: [
      {
        marketId: MARKET_ID,
        tickSize: "0.01",
        minimumOrderSize: "5",
        // Arbitrary TEST rates: fee facts are caller data, never venue claims.
        makerFeeRate: "0",
        takerFeeRate: "0.01",
        book: {
          yesBestBid: inventory.yesBestBid ?? "0.3",
          yesBestAsk: "0.32",
          noBestBid: inventory.noBestBid ?? "0.1",
          noBestAsk: "0.12",
        },
        inventory: {
          yes: { held: inventory.yes ?? "0", reserved: "0" },
          no: { held: inventory.no ?? "0", reserved: "0" },
        },
      },
    ],
    policy: {
      // 60 is below the 90 shares the pre-remediation direct-leg reduction
      // planned, so an over-sized reduction shows up as TWO slices.
      maxSliceShares: "60",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 2,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 30000,
      maxPlanLifetimeMs: 600000,
    },
    // `C1-TIF` (ADR-034 D3.1 item 2): a placement's inputs carry its time-in-force.
    timeInForce: "GTC",
    scope: { seriesKey: "btc-15m", underlyingKey: "BTC", resolutionWindowKey: "w1" },
  };
}

/** `ACTION SHARES SIDE @ PRICE` for every planned order, in plan order. */
function planLegs(intent: Intent, inventory: Inventory): string[] {
  const result = buildExecutionPlan(approved(intent), planningInputs(inventory));
  if (!result.ok) {
    throw new Error(
      `the planner refused this intent: ${JSON.stringify(result.refusals.map((r) => r.code))}`,
    );
  }
  const plan = result.value;
  if (plan.planKind === "CANCEL") throw new Error("expected a placement plan, got a cancel");
  const groups: readonly ExecutionGroup[] = plan.groups;
  return groups.flatMap((group) =>
    group.orders.map(
      (order: PlannedOrder) =>
        `${order.action} ${order.shares} ${order.side} @ ${order.limitPrice}`,
    ),
  );
}

/**
 * The single position-changing intent of a decision, WHATEVER ITS SHAPE.
 *
 * Deliberately shape-blind: the assertions in this file are about the ORDERS
 * the planner produces, so a change that swaps one intent type for another has
 * to be judged on the plan and not waved through (or rejected) on the type.
 * The type itself is pinned separately, once, below.
 */
function theExit(decision: DecisionResult, what: string): Intent {
  const acting = decision.intents.filter(
    (intent) => intent.type === "POSITION" || intent.type === "REDUCE_POSITION",
  );
  expect(acting, `${what}: exactly one position-changing intent`).toHaveLength(1);
  return acting[0] as Intent;
}

// ---------------------------------------------------------------------------
// The brackets
// ---------------------------------------------------------------------------

/** A complement bracket: 50 YES-exposure held by being SHORT 50 of 100 NO. */
function openComplement(overrides: Partial<StaticBracketState> = {}): StaticBracketState {
  return stateWith({
    instanceState: "OPEN",
    allocatedShares: "50",
    allocatedCost: "35",
    legOutcome: "NO",
    legBaselineShares: "100",
    entriesExecuted: 1,
    openedAtMs: NOW_MS - 1000,
    ...overrides,
  });
}

/** A direct bracket: 50 YES bought, over `baseline` shares of prior inventory. */
function openDirect(
  baseline = "0",
  overrides: Partial<StaticBracketState> = {},
): StaticBracketState {
  return stateWith({
    instanceState: "OPEN",
    allocatedShares: "50",
    allocatedCost: "17.5",
    legOutcome: "YES",
    legBaselineShares: baseline,
    entriesExecuted: 1,
    openedAtMs: NOW_MS - 1000,
    ...overrides,
  });
}

/** The complement bracket's views: 50 NO left of the 100 it started with. */
const COMPLEMENT_VIEWS = {
  noShares: "50",
  no: { bids: [["0.7", "2000"]] as const, asks: [["0.72", "2000"]] as const },
};

describe("the reduce paths, planned by the REAL execution planner", () => {
  it("COMPLEMENT STOP: buys 50 NO back, capped at the complemented floor", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(PREFERRING), openComplement(), {
        ...COMPLEMENT_VIEWS,
        features: { [STOP_KEY]: "0.2" },
      }),
    );
    expect(decision.decisionType).toBe("reduce");
    expect(decision.reasonCodes).toContain(REASONS.stopTriggered);
    // BEFORE: `REDUCE_POSITION SELL 50 NO @ 0.08` — the wrong side, and 0.08
    // because the reduce path never reads `maximumBuyPrice`.
    // AFTER: a BUY of exactly the open allocation, at min(ask + 2 ticks, 0.74).
    expect(planLegs(theExit(decision, "complement stop"), { no: "50" })).toEqual([
      "BUY 50 NO @ 0.14",
    ]);
  });

  it("COMPLEMENT HOLDING TIMEOUT: the same buy-back", () => {
    const decision = staticBracketStrategy.onTimer(
      context(params(PREFERRING), openComplement({ openedAtMs: NOW_MS - 200_000 }), COMPLEMENT_VIEWS),
    );
    expect(decision.reasonCodes).toContain(REASONS.holdingTimeout);
    expect(planLegs(theExit(decision, "complement timeout"), { no: "50" })).toEqual([
      "BUY 50 NO @ 0.14",
    ]);
  });

  it("COMPLEMENT PROTECTED_REDUCE at the close: the same buy-back", () => {
    const decision = staticBracketStrategy.onMarketClosing(
      context(params(PREFERRING), openComplement(), COMPLEMENT_VIEWS),
      19,
    );
    expect(decision.reasonCodes).toContain(REASONS.finalProtectedReduce);
    expect(decision.reasonCodes).toContain(REASONS.exitCutoff);
    expect(planLegs(theExit(decision, "complement final policy"), { no: "50" })).toEqual([
      "BUY 50 NO @ 0.14",
    ]);
  });

  it("DIRECT reduce WITH prior inventory: sells the allocation, never the inventory", () => {
    // The bracket bought 50 YES on top of 40 it already held, so the account
    // holds 90 and the bracket owns 50 of them.
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openDirect("40"), {
        yesShares: "90",
        features: { [STOP_KEY]: "0.2" },
      }),
    );
    expect(decision.decisionType).toBe("reduce");
    // BEFORE: `SELL 60 YES` + `SELL 30 YES` — 90 shares, sliced, for a 50-share
    // allocation, because the sell-down level was "0".
    expect(planLegs(theExit(decision, "direct reduce with inventory"), { yes: "90" })).toEqual([
      "SELL 50 YES @ 0.28",
    ]);
  });

  it("DIRECT plain reduce: the UNTRADED side is not touched", () => {
    // The account also holds 100 NO — the ordinary case once
    // `PREFER_CHEAPEST_WITH_INVENTORY` is configured anywhere in the process.
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openDirect(), {
        yesShares: "50",
        noShares: "100",
        features: { [STOP_KEY]: "0.2" },
      }),
    );
    expect(decision.decisionType).toBe("reduce");
    // BEFORE: `SELL 50 YES` + `SELL 60 NO` + `SELL 40 NO` — the whole untraded
    // side dumped alongside the bracket's own allocation.
    expect(
      planLegs(theExit(decision, "direct plain reduce"), { yes: "50", no: "100" }),
    ).toEqual(["SELL 50 YES @ 0.28"]);
  });

  it("THE FLOOR IS HONOURED ON A THIN BOOK, which is where it matters", () => {
    // A marketable sell prices at `bestBid − 2 ticks`; with a bid of 0.27 that
    // is 0.25, below the configured 0.26 floor, so the floor binds.
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openDirect(), { yesShares: "50", features: { [STOP_KEY]: "0.2" } }),
    );
    expect(planLegs(theExit(decision, "thin-book floor"), { yes: "50", yesBestBid: "0.27" })).toEqual(
      ["SELL 50 YES @ 0.26"],
    );
  });

  it("THE TAKE-PROFIT plans the same way on both legs", () => {
    const direct = staticBracketStrategy.onFeatures(
      context(params(), openDirect(), { yesShares: "50" }),
    );
    expect(direct.reasonCodes).toContain(REASONS.takeProfitPlaced);
    // MAKER_ONLY rests: a sell joins the ask, floored at the 0.5 limit.
    expect(planLegs(theExit(direct, "direct take-profit"), { yes: "50" })).toEqual([
      "SELL 50 YES @ 0.5",
    ]);

    const complement = staticBracketStrategy.onFeatures(
      context(params(PREFERRING), openComplement(), COMPLEMENT_VIEWS),
    );
    expect(complement.reasonCodes).toContain(REASONS.takeProfitPlaced);
    // A resting BUY joins the bid, capped at complement(0.5) = 0.5.
    expect(planLegs(theExit(complement, "complement take-profit"), { no: "50" })).toEqual([
      "BUY 50 NO @ 0.1",
    ]);
  });

  it("NO exit path emits a §7.7 REDUCE_POSITION any more", () => {
    // The whole reason the BLOCKER was invisible: the intent shape looked right
    // and the plan it produced was not. Nothing may reintroduce it silently.
    const decisions: readonly DecisionResult[] = [
      staticBracketStrategy.onFeatures(
        context(params(), openDirect(), { yesShares: "50", features: { [STOP_KEY]: "0.2" } }),
      ),
      staticBracketStrategy.onTimer(
        context(params(), openDirect("0", { openedAtMs: NOW_MS - 200_000 }), { yesShares: "50" }),
      ),
      staticBracketStrategy.onMarketClosing(
        context(params(), openDirect(), { yesShares: "50" }),
        19,
      ),
      staticBracketStrategy.onFeatures(
        context(params(PREFERRING), openComplement(), {
          ...COMPLEMENT_VIEWS,
          features: { [STOP_KEY]: "0.2" },
        }),
      ),
      staticBracketStrategy.onTimer(
        context(params(PREFERRING), openComplement({ openedAtMs: NOW_MS - 200_000 }), COMPLEMENT_VIEWS),
      ),
      staticBracketStrategy.onMarketClosing(
        context(params(PREFERRING), openComplement(), COMPLEMENT_VIEWS),
        19,
      ),
    ];
    for (const decision of decisions) {
      expect(decision.intents.filter((intent) => intent.type === "REDUCE_POSITION")).toHaveLength(0);
      expect(protectedReductions(decision)).toHaveLength(1);
    }
  });
});

describe("the posture mapping the protected reduction relies on", () => {
  it("positionPosture(TAKER_OK, u) === reductionPosture(u) for every reduction urgency", () => {
    // The stated INTERPRETATION in `planProtectedReduce`: a PositionIntent must
    // name a `liquidityPreference` that a ReducePositionIntent does not have,
    // and `TAKER_OK` is the one that leaves §9.10's derived posture unchanged.
    for (const urgency of ["NORMAL", "AGGRESSIVE", "IMMEDIATE"] as const) {
      expect(positionPosture("TAKER_OK", urgency), urgency).toBe(reductionPosture(urgency));
    }
    // And it is a real constraint, not a vacuous one: the alternatives differ.
    expect(positionPosture("MAKER_ONLY", "AGGRESSIVE")).not.toBe(reductionPosture("AGGRESSIVE"));
    expect(positionPosture("TAKER_ONLY", "NORMAL")).not.toBe(reductionPosture("NORMAL"));
  });

  it("a NORMAL reduction RESTS and an AGGRESSIVE one crosses, through the real planner", () => {
    const resting = params(configWith({ "exit.stop.urgency": "NORMAL" }));
    const decision = staticBracketStrategy.onFeatures(
      context(resting, openDirect(), { yesShares: "50", features: { [STOP_KEY]: "0.2" } }),
    );
    // REST SELL joins the best ask (0.32), floored at the 0.26 intent floor.
    expect(planLegs(theExit(decision, "NORMAL reduction"), { yes: "50" })).toEqual([
      "SELL 50 YES @ 0.32",
    ]);

    const crossing = staticBracketStrategy.onFeatures(
      context(params(), openDirect(), { yesShares: "50", features: { [STOP_KEY]: "0.2" } }),
    );
    expect(planLegs(theExit(crossing, "AGGRESSIVE reduction"), { yes: "50" })).toEqual([
      "SELL 50 YES @ 0.28",
    ]);
  });
});
