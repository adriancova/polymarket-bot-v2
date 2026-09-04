/**
 * The execution plan builder — §9.10's entry point.
 *
 * `buildExecutionPlan(record, inputs)` converts one approved intent into one
 * immutable execution plan, or into typed refusals. Everything is
 * deterministic data-in/data-out: no clock, no randomness, no I/O — identical
 * arguments produce byte-identical plans, and every derived identifier
 * (`:g0`, `:o1`, `:r2`) is a pure function of the caller-supplied
 * `executionPlanId`.
 *
 * THE DISPATCH IS THE §6 INVARIANT-13 MECHANISM: the intent TYPE is plucked
 * first with the trap-free reader, and a CANCEL routes to a path that reads
 * ONLY what a cancel plan carries (`record.ts`, `inputs.ts`) — so hostile or
 * malformed values in fields a cancel never consumes (the book, the
 * inventory, `worstCase`, the fee schedule) can neither throw nor refuse a
 * valid cancel, and the cancel plan schedules as `SAFETY_CANCEL` ahead of
 * every placement. A malformed CANCEL itself still refuses: nothing converts
 * a refusal into a plan.
 *
 * QUOTE INTENTS ARE REFUSED, NOT HALF-PLANNED: §7.7's `QuoteLevel` names no
 * outcome token (`packages/domain/src/intents.ts`), so planning venue orders
 * from one requires inventing which token is quoted — a recorded domain gap
 * (WP-180 `follow_up` 1, awaiting a domain ADR). `PLAN_QUOTE_UNSUPPORTED`
 * names the gap instead of guessing venue behaviour.
 *
 * PAPER-ONLY BY CONSTRUCTION: this package produces plan DATA. It has no
 * venue client, no signer, no credential surface, and no submission method;
 * placing orders is `packages/oms`'s (forbidden here) and the run-mode
 * ceiling is enforced upstream by risk (§9.8 check 2) and the allocator's
 * fenced zero live-micro caps. The plan carries `runMode` verbatim for those
 * gates — it neither grants nor widens anything.
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import type {
  BasketIntent,
  OutcomeSide,
  PositionIntent,
  ReducePositionIntent,
} from "@polymarket-bot/domain";

import { selectDecreaseLeg, selectIncreaseLeg } from "./leg.js";
import type {
  CancelPlanningInputs,
  MarketPlanningInput,
  PlanningInputs,
} from "./inputs.js";
import { marketInputFor, readCancelPlanningInputs, readPlanningInputs } from "./inputs.js";
import {
  sealExecutionPlan,
  type BasketPlan,
  type CancelPlan,
  type ExecutionPlan,
  type LegSelection,
  type PlacementPlan,
  type PlanEstimates,
  type PlannedOrder,
  type ReservationRequirement,
} from "./plan.js";
import { pluck } from "./pluck.js";
import {
  positionPosture,
  reductionPosture,
  type ExecutionPosture,
} from "./price.js";
import { readApprovedCancel, readApprovedIntentRecord, type ApprovedIntentView } from "./record.js";
import {
  contained,
  plannerFailure,
  plannerRefusal,
  type PlannerRefusal,
  type PlannerResult,
} from "./refusals.js";
import { sliceShares } from "./slice.js";
import { instantMilliseconds, instantPlusMilliseconds } from "./time.js";

/** One priced leg on its way to becoming orders and reservations. */
interface PricedLeg {
  readonly market: MarketPlanningInput;
  readonly side: OutcomeSide;
  readonly action: "BUY" | "SELL";
  readonly limitPrice: string;
  readonly totalShares: string;
  readonly posture: ExecutionPosture;
}

interface AssembledGroups {
  readonly groups: PlacementPlan["groups"];
  readonly reservations: readonly ReservationRequirement[];
  readonly estimates: PlanEstimates;
}

/** Builds groups/orders/reservations/estimates from priced legs. Exact. */
function assemble(
  legs: readonly PricedLeg[],
  view: ApprovedIntentView,
  inputs: PlanningInputs,
): PlannerResult<AssembledGroups> {
  const groups: Array<{
    readonly executionGroupId: string;
    readonly marketId: string;
    readonly tickSize: string;
    readonly minimumOrderSize: string;
    readonly orders: PlannedOrder[];
  }> = [];
  const reservations: ReservationRequirement[] = [];
  let worstCaseCost = "0";
  let expectedProceeds = "0";
  let fees = "0";
  let slippage = "0";
  let orderIndex = 0;

  for (const [groupIndex, leg] of legs.entries()) {
    const sliced = sliceShares(leg.totalShares, inputs.policy.maxSliceShares, leg.market.minimumOrderSize);
    if (!sliced.ok) return plannerFailure(sliced.refusal);
    const executionGroupId = `${inputs.executionPlanId}:g${String(groupIndex)}`;
    const orders: PlannedOrder[] = [];
    for (const shares of sliced.sizes) {
      const plannedOrderId = `${executionGroupId}:o${String(orderIndex)}`;
      const reservationId = `${inputs.executionPlanId}:r${String(orderIndex)}`;
      orderIndex += 1;
      const postOnly = leg.posture === "REST";
      orders.push({
        plannedOrderId,
        marketId: leg.market.marketId,
        side: leg.side,
        action: leg.action,
        limitPrice: leg.limitPrice,
        shares,
        postOnly,
        executionStyle: leg.posture,
        reservationId,
      });
      reservations.push({
        reservationId,
        strategyInstanceId: view.strategyInstanceId,
        runMode: view.runMode,
        accountingMode: inputs.accountingMode,
        marketId: leg.market.marketId,
        side: leg.side,
        action: leg.action,
        price: leg.limitPrice,
        shares,
        ...(inputs.scope === undefined ? {} : { scope: inputs.scope }),
      });

      const notional = mulDecimal(leg.limitPrice, shares);
      const feeRate = postOnly ? leg.market.makerFeeRate : leg.market.takerFeeRate;
      fees = addDecimal(fees, mulDecimal(feeRate, notional));
      if (leg.action === "BUY") {
        worstCaseCost = addDecimal(worstCaseCost, notional);
        const bestAsk = leg.side === "YES" ? leg.market.book?.yesBestAsk : leg.market.book?.noBestAsk;
        if (leg.posture === "MARKETABLE_LIMIT" && bestAsk !== undefined && compareDecimal(leg.limitPrice, bestAsk) > 0) {
          slippage = addDecimal(slippage, mulDecimal(subDecimal(leg.limitPrice, bestAsk), shares));
        }
      } else {
        expectedProceeds = addDecimal(expectedProceeds, notional);
        const bestBid = leg.side === "YES" ? leg.market.book?.yesBestBid : leg.market.book?.noBestBid;
        if (leg.posture === "MARKETABLE_LIMIT" && bestBid !== undefined && compareDecimal(bestBid, leg.limitPrice) > 0) {
          slippage = addDecimal(slippage, mulDecimal(subDecimal(bestBid, leg.limitPrice), shares));
        }
      }
    }
    groups.push({
      executionGroupId,
      marketId: leg.market.marketId,
      tickSize: leg.market.tickSize,
      minimumOrderSize: leg.market.minimumOrderSize,
      orders,
    });
  }
  return {
    ok: true,
    value: {
      groups,
      reservations,
      estimates: { basis: "ESTIMATE", worstCaseCost, expectedProceeds, fees, slippage },
    },
  };
}

/** `min(validUntil, plannedAt + maxPlanLifetimeMs)`, or refusals. */
function placementDeadline(
  validUntil: string | undefined,
  inputs: PlanningInputs,
): PlannerResult<string> {
  const policyDeadline = instantPlusMilliseconds(inputs.plannedAt, inputs.policy.maxPlanLifetimeMs);
  if (policyDeadline === undefined) {
    return plannerFailure(
      plannerRefusal("PLAN_INPUT_INVALID", "the plan deadline could not be computed from plannedAt and maxPlanLifetimeMs", {
        plannedAt: inputs.plannedAt,
        maxPlanLifetimeMs: inputs.policy.maxPlanLifetimeMs,
      }),
    );
  }
  if (validUntil === undefined) return { ok: true, value: policyDeadline };
  const intentMs = instantMilliseconds(validUntil);
  const plannedMs = instantMilliseconds(inputs.plannedAt);
  const policyMs = instantMilliseconds(policyDeadline);
  if (intentMs === undefined || plannedMs === undefined || policyMs === undefined) {
    return plannerFailure(
      plannerRefusal("PLAN_INPUT_INVALID", "an instant could not be compared while computing the deadline", {
        validUntil,
        plannedAt: inputs.plannedAt,
      }),
    );
  }
  if (intentMs <= plannedMs) {
    return plannerFailure(
      plannerRefusal(
        "PLAN_INTENT_EXPIRED",
        "the intent's validUntil is not after the planning instant; a dead intent plans nothing (fail closed)",
        { validUntil, plannedAt: inputs.plannedAt },
      ),
    );
  }
  return { ok: true, value: intentMs <= policyMs ? validUntil : policyDeadline };
}

function planBase(view: ApprovedIntentView, executionPlanId: string, plannedAt: string, deadline: string) {
  return {
    executionPlanId,
    approvedIntentId: view.approvedIntentId,
    rootApprovedIntentId: view.rootApprovedIntentId,
    ...(view.sourceIntentId === undefined ? {} : { sourceIntentId: view.sourceIntentId }),
    strategyInstanceId: view.strategyInstanceId,
    runMode: view.runMode,
    plannedAt,
    deadline,
    provenance: {
      approvedAt: view.approvedAt,
      lineage: view.lineage,
      // WP-180 follow_up 3: the plan RECORDS the worst-case basis it acted on.
      worstCaseBasis: view.worstCaseBasis,
    },
  } as const;
}

// ---------------------------------------------------------------------------
// POSITION
// ---------------------------------------------------------------------------

function buildPositionPlan(
  view: ApprovedIntentView,
  intent: PositionIntent,
  inputs: PlanningInputs,
): PlannerResult<ExecutionPlan> {
  const market = marketInputFor(inputs, intent.marketId);
  if (!market.ok) return market;

  // Delta semantics mirror `packages/risk`'s intent view exactly: DELTA is
  // the requested change; ABSOLUTE targets the direction-side holding, so the
  // delta is measured against CONFIRMED ACTUAL allocation (§6 invariant 10).
  const held = (intent.direction === "YES" ? market.value.inventory.yes : market.value.inventory.no).held;
  const delta =
    intent.targetMode === "DELTA" ? intent.targetShares : subDecimal(intent.targetShares, held);
  if (compareDecimal(delta, "0") === 0) {
    return plannerFailure(
      plannerRefusal("PLAN_NOTHING_TO_EXECUTE", "the position intent resolves to a zero share delta", {
        marketId: intent.marketId,
        targetMode: intent.targetMode,
        heldShares: held,
      }),
    );
  }
  const increasing = compareDecimal(delta, "0") > 0;
  const shares = increasing ? delta : subDecimal("0", delta);
  const posture = positionPosture(intent.liquidityPreference, intent.urgency);

  const deadline = placementDeadline(intent.validUntil, inputs);
  if (!deadline.ok) return deadline;

  let selection: LegSelection;
  let limitPrice: string;
  if (increasing) {
    const leg = selectIncreaseLeg({
      market: market.value,
      direction: intent.direction,
      shares,
      posture,
      slippageTicks: inputs.policy.marketableSlippageTicks,
      ...(intent.maximumBuyPrice === undefined ? {} : { maximumBuyPrice: intent.maximumBuyPrice }),
      availableCollateral: inputs.availableCollateral,
    });
    if (!leg.ok) return plannerFailure(...leg.refusals);
    selection = leg.value.selection;
    limitPrice = leg.value.limitPrice;
  } else {
    const leg = selectDecreaseLeg({
      market: market.value,
      direction: intent.direction,
      shares,
      posture,
      slippageTicks: inputs.policy.marketableSlippageTicks,
      ...(intent.minimumSellPrice === undefined ? {} : { minimumSellPrice: intent.minimumSellPrice }),
    });
    if (!leg.ok) return plannerFailure(...leg.refusals);
    selection = leg.value.selection;
    limitPrice = leg.value.limitPrice;
  }

  // The strategy's own total-cost ceiling binds whichever leg was selected:
  // a BUY leg's worst cost directly; a SELL_OPPOSITE leg commits no new pUSD.
  if (selection.action === "BUY" && intent.maximumTotalCost !== undefined) {
    const worst = mulDecimal(limitPrice, shares);
    if (compareDecimal(worst, intent.maximumTotalCost) > 0) {
      return plannerFailure(
        plannerRefusal(
          "PLAN_EXCEEDS_MAXIMUM_TOTAL_COST",
          "the leg's worst-case cost exceeds the intent's own maximumTotalCost ceiling; a plan may not spend what the strategy forbade",
          { limitPrice, shares, worstCaseCost: worst, maximumTotalCost: intent.maximumTotalCost },
        ),
      );
    }
  }

  const assembled = assemble(
    [
      {
        market: market.value,
        side: selection.side,
        action: selection.action,
        limitPrice,
        totalShares: shares,
        posture,
      },
    ],
    view,
    inputs,
  );
  if (!assembled.ok) return assembled;

  const draft: PlacementPlan = {
    ...planBase(view, inputs.executionPlanId, inputs.plannedAt, deadline.value),
    planKind: "POSITION",
    priority: "PLACEMENT",
    priceProtection: { mode: "CAPPED_LIMIT_ORDERS_ONLY" },
    escalation: { atDeadline: "CANCEL_REMAINING" },
    accountingMode: inputs.accountingMode,
    legSelection: selection,
    partialFill: {
      policy: intent.partialFillPolicy,
      ...(intent.minimumFillShares === undefined ? {} : { minimumFillShares: intent.minimumFillShares }),
    },
    hysteresis: {
      replaceThresholdTicks: inputs.policy.replaceThresholdTicks,
      minimumReplaceIntervalMs: inputs.policy.minimumReplaceIntervalMs,
    },
    reservationRule: "RESERVE_BEFORE_SUBMISSION",
    groups: assembled.value.groups,
    reservations: assembled.value.reservations,
    estimates: assembled.value.estimates,
  };
  return sealExecutionPlan(draft);
}

// ---------------------------------------------------------------------------
// REDUCE_POSITION
// ---------------------------------------------------------------------------

function buildReductionPlan(
  view: ApprovedIntentView,
  intent: ReducePositionIntent,
  inputs: PlanningInputs,
): PlannerResult<ExecutionPlan> {
  const market = marketInputFor(inputs, intent.marketId);
  if (!market.ok) return market;
  const posture = reductionPosture(intent.urgency);
  const deadline = placementDeadline(undefined, inputs);
  if (!deadline.ok) return deadline;

  // `targetShares` is the level to sell DOWN TO, per side — the same
  // semantics `packages/risk`'s intent view derives from §7.7: the reduction
  // leg is a SELL of the excess over the target on each side actually held.
  const target = compareDecimal(intent.targetShares, "0") < 0
    ? subDecimal("0", intent.targetShares)
    : intent.targetShares;
  const legs: PricedLeg[] = [];
  const refusals: PlannerRefusal[] = [];
  let firstSelection: LegSelection | undefined;
  for (const side of ["YES", "NO"] as const) {
    const held = (side === "YES" ? market.value.inventory.yes : market.value.inventory.no).held;
    if (compareDecimal(held, target) <= 0) continue;
    const excess = subDecimal(held, target);
    const leg = selectDecreaseLeg({
      market: market.value,
      direction: side,
      shares: excess,
      posture,
      slippageTicks: inputs.policy.marketableSlippageTicks,
      ...(intent.minimumSellPrice === undefined ? {} : { minimumSellPrice: intent.minimumSellPrice }),
    });
    if (!leg.ok) {
      refusals.push(...leg.refusals);
      continue;
    }
    firstSelection ??= leg.value.selection;
    legs.push({
      market: market.value,
      side,
      action: "SELL",
      limitPrice: leg.value.limitPrice,
      totalShares: excess,
      posture,
    });
  }
  if (refusals.length > 0) return plannerFailure(...refusals);
  if (legs.length === 0 || firstSelection === undefined) {
    return plannerFailure(
      plannerRefusal(
        "PLAN_NOTHING_TO_EXECUTE",
        "no side holds more than the reduction target; there is nothing to sell down (§6 invariant 10: exits are based on confirmed actual allocation)",
        { marketId: intent.marketId, targetShares: intent.targetShares },
      ),
    );
  }

  const assembled = assemble(legs, view, inputs);
  if (!assembled.ok) return assembled;

  const draft: PlacementPlan = {
    ...planBase(view, inputs.executionPlanId, inputs.plannedAt, deadline.value),
    planKind: "REDUCE_POSITION",
    priority: "PLACEMENT",
    priceProtection: { mode: "CAPPED_LIMIT_ORDERS_ONLY" },
    escalation: { atDeadline: "CANCEL_REMAINING" },
    accountingMode: inputs.accountingMode,
    legSelection: firstSelection,
    // §6 invariant 10: partial fills are first-class, and ANY partial
    // reduction is progress toward the target — a stated planning rule
    // (§7.7's reduction intent carries no partialFillPolicy field to copy).
    partialFill: { policy: "ACCEPT_ANY" },
    hysteresis: {
      replaceThresholdTicks: inputs.policy.replaceThresholdTicks,
      minimumReplaceIntervalMs: inputs.policy.minimumReplaceIntervalMs,
    },
    reservationRule: "RESERVE_BEFORE_SUBMISSION",
    groups: assembled.value.groups,
    reservations: assembled.value.reservations,
    estimates: assembled.value.estimates,
  };
  return sealExecutionPlan(draft);
}

// ---------------------------------------------------------------------------
// BASKET
// ---------------------------------------------------------------------------

function buildBasketPlan(
  view: ApprovedIntentView,
  intent: BasketIntent,
  inputs: PlanningInputs,
): PlannerResult<ExecutionPlan> {
  const deadline = placementDeadline(intent.validUntil, inputs);
  if (!deadline.ok) return deadline;

  const legs: PricedLeg[] = [];
  const refusals: PlannerRefusal[] = [];
  let combinedCost = "0";
  for (const [index, leg] of intent.legs.entries()) {
    const shares = compareDecimal(leg.targetShares, "0") < 0
      ? subDecimal("0", leg.targetShares)
      : leg.targetShares;
    if (compareDecimal(shares, "0") === 0) continue;
    const market = marketInputFor(inputs, leg.marketId);
    if (!market.ok) {
      refusals.push(...market.refusals);
      continue;
    }
    const buying = compareDecimal(leg.targetShares, "0") > 0;
    if (buying) {
      // A buying basket leg must carry its own ceiling — the same rule the
      // risk engine enforces (`RISK_BASKET_LEG_UNBOUNDED`), restated here so
      // a hand-built record cannot smuggle an unbounded leg past planning.
      if (leg.maximumBuyPrice === undefined) {
        refusals.push(
          plannerRefusal(
            "PLAN_BASKET_LEG_UNBOUNDED",
            "a buying basket leg carries no maximumBuyPrice, so its contractual cost is unbounded (§9.10: each coordinated leg's own risk must be bounded)",
            { legIndex: index, marketId: leg.marketId, direction: leg.direction },
          ),
        );
        continue;
      }
      const increase = selectIncreaseLeg({
        market: market.value,
        direction: leg.direction,
        shares,
        posture: "MARKETABLE_LIMIT",
        slippageTicks: inputs.policy.marketableSlippageTicks,
        maximumBuyPrice: leg.maximumBuyPrice,
        // The remaining collateral after earlier legs: coordinated legs
        // draw on one account (§9.7), so each leg sees what is left.
        availableCollateral: subDecimal(inputs.availableCollateral, combinedCost),
      });
      if (!increase.ok) {
        refusals.push(...increase.refusals);
        continue;
      }
      const cost = mulDecimal(increase.value.limitPrice, shares);
      if (increase.value.selection.action === "BUY") {
        if (compareDecimal(cost, intent.legRiskLimit) > 0) {
          refusals.push(
            plannerRefusal(
              "PLAN_BASKET_LEG_RISK_EXCEEDED",
              "this leg's worst-case cost exceeds the basket's own legRiskLimit (§9.10 coordinated-basket leg-risk policy)",
              { legIndex: index, marketId: leg.marketId, worstCaseCost: cost, legRiskLimit: intent.legRiskLimit },
            ),
          );
          continue;
        }
        combinedCost = addDecimal(combinedCost, cost);
      }
      legs.push({
        market: market.value,
        side: increase.value.selection.side,
        action: increase.value.selection.action,
        limitPrice: increase.value.limitPrice,
        totalShares: shares,
        posture: "MARKETABLE_LIMIT",
      });
      continue;
    }
    const decrease = selectDecreaseLeg({
      market: market.value,
      direction: leg.direction,
      shares,
      posture: "MARKETABLE_LIMIT",
      slippageTicks: inputs.policy.marketableSlippageTicks,
      ...(leg.minimumSellPrice === undefined ? {} : { minimumSellPrice: leg.minimumSellPrice }),
    });
    if (!decrease.ok) {
      refusals.push(...decrease.refusals);
      continue;
    }
    legs.push({
      market: market.value,
      side: leg.direction,
      action: "SELL",
      limitPrice: decrease.value.limitPrice,
      totalShares: shares,
      posture: "MARKETABLE_LIMIT",
    });
  }
  if (refusals.length > 0) return plannerFailure(...refusals);
  if (legs.length === 0) {
    return plannerFailure(
      plannerRefusal("PLAN_NOTHING_TO_EXECUTE", "every basket leg resolves to zero shares", {}),
    );
  }
  if (compareDecimal(combinedCost, intent.maximumCombinedCost) > 0) {
    return plannerFailure(
      plannerRefusal(
        "PLAN_BASKET_COMBINED_COST_EXCEEDED",
        "the basket's combined worst-case cost exceeds its own maximumCombinedCost ceiling",
        { combinedCost, maximumCombinedCost: intent.maximumCombinedCost },
      ),
    );
  }

  const assembled = assemble(legs, view, inputs);
  if (!assembled.ok) return assembled;

  const draft: BasketPlan = {
    ...planBase(view, inputs.executionPlanId, inputs.plannedAt, deadline.value),
    planKind: "BASKET",
    priority: "PLACEMENT",
    // COORDINATED is the only value the contract admits; §7.7: "Basket
    // execution is coordinated, not assumed atomic" (workplan acceptance 3).
    coordination: "COORDINATED",
    failurePolicy: intent.failurePolicy,
    legRiskLimit: intent.legRiskLimit,
    maximumCombinedCost: intent.maximumCombinedCost,
    priceProtection: { mode: "CAPPED_LIMIT_ORDERS_ONLY" },
    escalation: { atDeadline: "CANCEL_REMAINING" },
    accountingMode: inputs.accountingMode,
    partialFill: { policy: "ACCEPT_ANY" },
    hysteresis: {
      replaceThresholdTicks: inputs.policy.replaceThresholdTicks,
      minimumReplaceIntervalMs: inputs.policy.minimumReplaceIntervalMs,
    },
    reservationRule: "RESERVE_BEFORE_SUBMISSION",
    groups: assembled.value.groups,
    reservations: assembled.value.reservations,
    estimates: assembled.value.estimates,
  };
  return sealExecutionPlan(draft);
}

// ---------------------------------------------------------------------------
// CANCEL
// ---------------------------------------------------------------------------

function buildCancelPlan(record: unknown, inputs: unknown): PlannerResult<ExecutionPlan> {
  const view = readApprovedCancel(record);
  const cancelInputs = readCancelPlanningInputs(inputs);
  if (!view.ok || !cancelInputs.ok) {
    return plannerFailure(
      ...(view.ok ? [] : view.refusals),
      ...(cancelInputs.ok ? [] : cancelInputs.refusals),
    );
  }
  return assembleCancelPlan(view.value, cancelInputs.value);
}

function assembleCancelPlan(
  view: ApprovedIntentView,
  inputs: CancelPlanningInputs,
): PlannerResult<ExecutionPlan> {
  if (view.intent.type !== "CANCEL") {
    return plannerFailure(
      plannerRefusal("PLAN_RECORD_INVALID", "the cancel builder was handed a non-cancel intent", {
        intentType: view.intent.type,
      }),
    );
  }
  const deadline = instantPlusMilliseconds(inputs.plannedAt, inputs.cancelDeadlineMs);
  if (deadline === undefined) {
    return plannerFailure(
      plannerRefusal("PLAN_INPUT_INVALID", "the cancel deadline could not be computed", {
        plannedAt: inputs.plannedAt,
        cancelDeadlineMs: inputs.cancelDeadlineMs,
      }),
    );
  }
  const draft: CancelPlan = {
    ...planBase(view, inputs.executionPlanId, inputs.plannedAt, deadline),
    planKind: "CANCEL",
    // §6 invariant 13: safety cancellation outranks new order placement, and
    // rate-limit scheduling reflects this priority.
    priority: "SAFETY_CANCEL",
    priceProtection: { mode: "NO_NEW_ORDERS" },
    // §6 invariant 6 direction: a cancel that cannot be confirmed by its
    // deadline is reconciled against authoritative venue state, never
    // guessed at and never retried blind.
    escalation: { atDeadline: "ESCALATE_TO_RECONCILIATION" },
    scope: {
      ...(view.intent.marketId === undefined ? {} : { marketId: view.intent.marketId }),
      ...(view.intent.orderIds === undefined ? {} : { orderIds: view.intent.orderIds }),
    },
    reason: view.intent.reason,
  };
  return sealExecutionPlan(draft);
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Converts one approved intent into one immutable execution plan.
 *
 * `record` is an `ApprovedIntentRecord` as `packages/risk` emits it at
 * `98a6cc1`; `inputs` is this package's `PlanningInputs` document. Both are
 * `unknown` at runtime and cross the materialize-first boundary before
 * anything reads them. TOTAL: whatever the arguments are, the answer is a
 * typed result, never an exception.
 */
export function buildExecutionPlan(record: unknown, inputs: unknown): PlannerResult<ExecutionPlan> {
  return contained(
    () => buildExecutionPlanInner(record, inputs),
    (thrown) =>
      plannerFailure(
        plannerRefusal(
          "PLAN_SEAL_INVALID",
          "planning failed unexpectedly; an intent that cannot be planned produces no plan (fail closed)",
          { thrown },
        ),
      ),
  );
}

function buildExecutionPlanInner(record: unknown, inputs: unknown): PlannerResult<ExecutionPlan> {
  // THE DISPATCH (module header): the intent type is plucked trap-free so a
  // CANCEL reaches its own narrow path before any wide read can trip over a
  // field the cancel does not consume (§6 invariant 13).
  const typePluck = pluck(record, "record", ["intent", "type"]);
  if (typePluck.ok && typePluck.read.value === "CANCEL") {
    return buildCancelPlan(record, inputs);
  }

  const view = readApprovedIntentRecord(record);
  const planningInputs = readPlanningInputs(inputs);
  if (!view.ok || !planningInputs.ok) {
    return plannerFailure(
      ...(view.ok ? [] : view.refusals),
      ...(planningInputs.ok ? [] : planningInputs.refusals),
    );
  }

  const intent = view.value.intent;
  switch (intent.type) {
    case "POSITION":
      return buildPositionPlan(view.value, intent, planningInputs.value);
    case "REDUCE_POSITION":
      return buildReductionPlan(view.value, intent, planningInputs.value);
    case "BASKET":
      return buildBasketPlan(view.value, intent, planningInputs.value);
    case "QUOTE":
      return plannerFailure(
        plannerRefusal(
          "PLAN_QUOTE_UNSUPPORTED",
          "§7.7's QuoteLevel names no outcome token, so planning venue orders from a quote intent would require inventing which token is quoted — a recorded domain gap (WP-180 follow_up 1) that a domain ADR must close before quotes are plannable",
          { intentId: intent.intentId, marketId: intent.marketId },
        ),
      );
    case "CANCEL":
      // Reached only if the pluck above failed but the full read succeeded —
      // possible when the record is valid data whose top-level container the
      // pluck refused (it is stricter about proxies at the ROOT). Same door,
      // same plan.
      return buildCancelPlan(record, inputs);
  }
}
