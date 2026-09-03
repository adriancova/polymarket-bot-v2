/**
 * The risk-policy engine — handoff §9.8's twenty pre-trade checks, in order.
 *
 * ORDER AND ACCUMULATION. §9.8 lists the checks "cheapest first" and this
 * module evaluates them in exactly that order, but it does NOT short-circuit on
 * the first failure: a rejection that named one reason would hide the other
 * three an operator has to fix. Every check whose inputs are present runs, and
 * the refusals come back in §9.8 order. A check whose input is ABSENT does not
 * silently pass — the absence is itself a refusal (`*_UNKNOWN`, `*_MISSING`).
 *
 * FAIL CLOSED IS THE WHOLE DESIGN. Unknown never permits. A missing market
 * context, an unmeasured feed, an unsupplied exposure snapshot, an unsupplied
 * allocator verdict, an unbounded cost, a missing scenario — each blocks.
 *
 * WORST-CASE CONTRACTUAL LOSS IS PRIMARY (§9.8 primary measures; workplan
 * acceptance 2). Two structural consequences, not one comment:
 *
 * 1. `policy.limits.maxWorstCaseContractualLoss` is REQUIRED — there is no way
 *    to configure the primary limit away, unlike every secondary cap, which is
 *    optional;
 * 2. the check runs even when secondary checks already refused, and the
 *    assessment is returned on BOTH arms of the result, so the measure is
 *    always observable. Its codes are the ones
 *    {@link isPrimaryRiskReasonCode} identifies.
 *
 * THIS PACKAGE EXECUTES NOTHING. It returns a verdict, an approved-intent
 * record, and typed RECOMMENDATIONS for the §9.9 incident controller (a later
 * package). It owns no connection, cancels nothing, and places nothing.
 *
 * DISPOSITION-DEPENDENT CHECKS. Which checks apply to an entry, an exit, and a
 * cancel is documented in `README.md` as one table and implemented by the
 * `disposition` guards below. The two rules that matter most:
 *
 * - §6 invariant 13, "Safety cancellation outranks new order placement": a
 *   `CANCEL` is NEVER blocked — not by staleness, exposure, edge, rate-limit
 *   headroom, time-to-close, run mode, an allocator refusal, a missing market
 *   context, or any gate added later. This is a STRUCTURAL choke point at the
 *   end of the pipeline (see "§6 INVARIANT 13" below), not a per-gate
 *   condition, because a blocked cancel can trap a position and per-gate
 *   conditions are exactly what a later edit forgets. Everything the pipeline
 *   accumulated for a cancel is returned as non-blocking
 *   `cancelPriorityOverrides` observations.
 * - §6 invariant 12, "No blind flatten": an EXIT into a stale, unsynchronized,
 *   or unknown book IS blocked, and the refusal carries cancel-and-reconcile
 *   recommendations so the reduction happens after reconciliation, under the
 *   incident controller.
 */

import { addDecimal, compareDecimal, isTickConformant, subDecimal } from "@polymarket-bot/decimal";
import {
  RUN_MODE_PLACES_REAL_ORDERS,
  runModeExceeds,
  type MoneyString,
  type SharesString,
} from "@polymarket-bot/domain";

import type { ApprovedIntentRecord } from "./approved-intent.js";
import { checkExposureLimits } from "./exposure-limits.js";
import { assessFreshness, blocksAsStale, type FreshnessAssessment } from "./freshness.js";
import { deepFreeze, uuidShapedNotCanonical } from "./guards.js";
import {
  RiskEvaluationInputSchema,
  type MarketContext,
  type RiskEvaluationInput,
  type ScopeAttribution,
} from "./inputs.js";
import { buildIntentView, heldShares, type IntentLeg } from "./intent-view.js";
import { buildWorstCaseLots } from "./lots.js";
import type { RiskPolicy } from "./policy.js";
import type { RiskReasonCode } from "./reasons.js";
import {
  recommendIncidentActions,
  type IncidentActionRecommendation,
} from "./recommendations.js";
import { riskRefusal, type RiskRefusal } from "./result.js";
import { assessScenarios, type ScenarioAssessment } from "./scenario.js";
import { isExpired } from "./time.js";
import { assessWorstCase, type WorstCaseAssessment } from "./worst-case.js";

/**
 * The verdict. The approved arm's `refusals` is the EMPTY TUPLE at the type
 * level, so "approved with refusals" is unrepresentable rather than merely
 * unusual (the WP-110 / capital-allocator precedent).
 */
export type RiskEvaluation =
  | {
      readonly approved: true;
      readonly record: ApprovedIntentRecord;
      readonly refusals: readonly [];
      /**
       * §6 invariant 13. Gates that WOULD have refused a non-cancel intent and
       * were overridden because a safety cancellation may never be blocked.
       * Non-empty only on a `CANCEL`; the evaluation is APPROVED regardless.
       * These are observations for the operator and the §9.9 controller — they
       * are NOT refusals, and a consumer must not treat them as ones.
       */
      readonly cancelPriorityOverrides: readonly RiskRefusal[];
      readonly recommendations: readonly IncidentActionRecommendation[];
      readonly worstCase: WorstCaseAssessment;
      readonly scenario: ScenarioAssessment | undefined;
      readonly freshness: FreshnessAssessment | undefined;
    }
  | {
      readonly approved: false;
      readonly refusals: readonly RiskRefusal[];
      readonly recommendations: readonly IncidentActionRecommendation[];
      readonly worstCase: WorstCaseAssessment | undefined;
      readonly scenario: ScenarioAssessment | undefined;
      readonly freshness: FreshnessAssessment | undefined;
    };

interface Accumulator {
  readonly refusals: RiskRefusal[];
  readonly recommendations: IncidentActionRecommendation[];
}

function recommend(
  accumulator: Accumulator,
  additions: readonly IncidentActionRecommendation[],
): void {
  for (const addition of additions) {
    const duplicate = accumulator.recommendations.some(
      (existing) =>
        existing.action === addition.action &&
        existing.failureClass === addition.failureClass &&
        existing.ordersScope === addition.ordersScope &&
        existing.marketId === addition.marketId,
    );
    if (!duplicate) accumulator.recommendations.push(addition);
  }
}

function rejected(
  accumulator: Accumulator,
  worstCase: WorstCaseAssessment | undefined,
  scenario: ScenarioAssessment | undefined,
  freshness: FreshnessAssessment | undefined,
): RiskEvaluation {
  return deepFreeze({
    approved: false as const,
    refusals: accumulator.refusals,
    recommendations: accumulator.recommendations,
    worstCase,
    scenario,
    freshness,
  });
}

/** Total held shares of a market, both tokens. */
function heldBothSides(
  input: RiskEvaluationInput,
  marketId: string,
): { readonly yes: SharesString; readonly no: SharesString } {
  return {
    yes: heldShares(input.portfolio, marketId, "YES"),
    no: heldShares(input.portfolio, marketId, "NO"),
  };
}

/**
 * Evaluates one intent against `policy`.
 *
 * `input` is unknown and validated here: a caller that hands this engine an
 * unvalidated object gets a typed refusal, never a partially-checked approval.
 */
export function evaluateIntent(policy: RiskPolicy, input: unknown): RiskEvaluation {
  const accumulator: Accumulator = { refusals: [], recommendations: [] };

  const parsed = RiskEvaluationInputSchema.safeParse(input);
  if (!parsed.success) {
    accumulator.refusals.push(
      riskRefusal("RISK_INPUT_INVALID", "risk evaluation input failed validation", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      }),
    );
    return rejected(accumulator, undefined, undefined, undefined);
  }
  const data = parsed.data;

  // --- pre-checks on the record's own identity and the intent's deadline ----
  if (uuidShapedNotCanonical(data.identifiers.approvedIntentId)) {
    accumulator.refusals.push(
      riskRefusal(
        "RISK_UUID_NOT_CANONICAL",
        "approvedIntentId is UUID-shaped but not canonical lowercase (ADR-016 §2: refuse, never case-fold)",
        { approvedIntentId: data.identifiers.approvedIntentId },
      ),
    );
  }

  const built = buildIntentView(data.intent, data.portfolio);
  const view = built.view;
  accumulator.refusals.push(...built.refusals);

  const isEntry = view.disposition === "ENTRY";
  const isCancel = view.disposition === "CANCEL";
  const placesOrders = !isCancel;

  if (view.validUntil !== undefined) {
    const expired = isExpired(view.validUntil, data.evaluatedAt);
    if (expired !== false) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_INTENT_EXPIRED",
          expired === undefined
            ? "the intent deadline and the evaluation instant are not comparable (fail closed)"
            : "the intent's validUntil is before the evaluation instant",
          { validUntil: view.validUntil, evaluatedAt: data.evaluatedAt },
        ),
      );
    }
  }

  // --- §9.8 check 1: run and strategy state --------------------------------
  if (placesOrders && !data.context.runStatePermitsIntent) {
    accumulator.refusals.push(
      riskRefusal("RISK_RUN_STATE_BLOCKS", "the run state does not permit this intent", {
        disposition: view.disposition,
      }),
    );
  }
  if (placesOrders && !data.context.strategyStatePermitsIntent) {
    accumulator.refusals.push(
      riskRefusal(
        "RISK_STRATEGY_STATE_BLOCKS",
        "the strategy instance state does not permit this intent",
        { disposition: view.disposition, strategyInstanceId: data.context.strategyInstanceId },
      ),
    );
  }

  // --- §9.8 check 2: run mode within the process maximum -------------------
  if (runModeExceeds(data.context.runMode, policy.maxRunMode)) {
    accumulator.refusals.push(
      riskRefusal(
        "RISK_RUN_MODE_EXCEEDS_MAXIMUM",
        "the requested run mode exceeds the configured process maximum (§11: a maximum cannot be raised at evaluation time)",
        { runMode: data.context.runMode, maxRunMode: policy.maxRunMode },
      ),
    );
  }

  // --- §9.8 check 3: real-order enablement and fencing ---------------------
  // This package owns NO real-order surface: no signer, no fencing token, no
  // venue connection. It therefore cannot establish that real-order
  // enablement and fencing are valid, and refuses instead of assuming
  // (`AGENTS.md`: ALLOW_REAL_ORDERS=false). A second, independent floor under
  // check 2 for a caller who configured a higher `maxRunMode`.
  if (placesOrders && RUN_MODE_PLACES_REAL_ORDERS[data.context.runMode]) {
    accumulator.refusals.push(
      riskRefusal(
        "RISK_REAL_ORDER_SURFACE_UNSUPPORTED",
        "this package cannot verify real-order enablement or writer fencing (§6 invariants 16 and 17); a real-order-mode intent is refused here by construction",
        { runMode: data.context.runMode },
      ),
    );

    // --- §9.8 check 4: venue geographic eligibility ------------------------
    // §6 invariant 18: a blocked, close-only, failed, or ambiguous result
    // prevents new live entries. Absent = unverified = blocked.
    const eligibility = data.context.venueEligibility;
    if (eligibility !== "ELIGIBLE" && !(eligibility === "CLOSE_ONLY" && !isEntry)) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_VENUE_ELIGIBILITY_UNVERIFIED",
          "venue eligibility is not a verified ELIGIBLE result (§6 invariant 18)",
          { venueEligibility: eligibility ?? "UNSUPPLIED", disposition: view.disposition },
        ),
      );
    }
  }

  // --- market contexts ------------------------------------------------------
  const marketById = new Map<string, MarketContext>(
    data.markets.map((market) => [market.marketId, market]),
  );
  const contexts: MarketContext[] = [];
  for (const marketId of view.marketIds) {
    const context = marketById.get(marketId);
    if (context === undefined) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_MARKET_CONTEXT_MISSING",
          "no market context was supplied for a market this intent touches (fail closed)",
          { marketId },
        ),
      );
      continue;
    }
    contexts.push(context);
  }

  const scopeByMarket = new Map<string, ScopeAttribution | undefined>(
    contexts.map((context) => [context.marketId, context.scope]),
  );

  for (const context of contexts) {
    // --- §9.8 check 5: market active and accepting orders ------------------
    if (placesOrders) {
      if (context.status === "UNKNOWN") {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_MARKET_STATUS_UNKNOWN",
            "the market status is UNKNOWN; acting on an unknown market is a blind action (§6 invariant 12)",
            { marketId: context.marketId },
          ),
        );
        recommend(accumulator, recommendIncidentActions("POSITION_STATE_UNKNOWN", context.marketId));
      } else if (context.status === "HALTED") {
        accumulator.refusals.push(
          riskRefusal("RISK_MARKET_NOT_ACCEPTING", "the market is halted and accepts no orders", {
            marketId: context.marketId,
            status: context.status,
          }),
        );
      } else if (context.status === "CLOSE_ONLY" && isEntry) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_MARKET_CLOSE_ONLY",
            "the market is close-only; new entries are blocked while reductions remain permitted",
            { marketId: context.marketId },
          ),
        );
      }
    }

    // --- §9.8 check 6: settlement spec verified for the strategy type ------
    if (isEntry && policy.requireVerifiedSettlementForEntries) {
      if (context.settlement?.modelDependentActivationAllowed !== true) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_SETTLEMENT_UNVERIFIED",
            "the market's settlement readiness does not permit model-dependent activation (§9.3, WP-110 readiness); absent = unverified = blocked",
            {
              marketId: context.marketId,
              modelDependentActivationAllowed:
                context.settlement?.modelDependentActivationAllowed ?? "UNSUPPLIED",
            },
          ),
        );
      }
    }
  }

  // --- §9.8 check 7: required feeds fresh and healthy ----------------------
  // Staleness measurements are CALLER-SUPPLIED (`freshness.ts`: no clock here).
  let freshness: FreshnessAssessment | undefined;
  if (placesOrders) {
    for (const context of contexts) {
      const assessment = assessFreshness(data.freshness, policy.freshness, context.marketId);
      freshness ??= assessment;

      const bookBlocks = blocksAsStale(assessment.venueBook);
      if (bookBlocks) {
        // §9.9 row 2: "Polymarket book stale → Cancel resting orders; no blind
        // aggressive orders." Blocks entries AND reductions.
        // An UNMEASURED book is reported as unknown rather than as stale on an
        // entry, so the two conditions stay distinguishable in metrics. On a
        // REDUCTION both collapse to the no-blind-flatten code, because §6
        // invariant 12 names "unknown position OR book state" as one condition.
        const bookCode: RiskReasonCode = !isEntry
          ? "RISK_BOOK_STALE_NO_BLIND_REDUCTION"
          : assessment.venueBook.status === "UNKNOWN"
            ? "RISK_FRESHNESS_UNKNOWN"
            : "RISK_BOOK_STALE";
        accumulator.refusals.push(
          riskRefusal(
            bookCode,
            isEntry
              ? "the venue book for this market is stale or unmeasured; no new entry may be placed into it"
              : "the venue book for this market is stale or unmeasured; §6 invariant 12 requires cancel and reconciliation before any protected reduction, not a blind reduction now",
            {
              marketId: context.marketId,
              status: assessment.venueBook.status,
              ageMs: assessment.venueBook.ageMs,
              limitMs: assessment.venueBook.limitMs,
            },
          ),
        );
        recommend(accumulator, recommendIncidentActions("VENUE_BOOK_STALE", context.marketId));
        if (!isEntry) {
          recommend(
            accumulator,
            recommendIncidentActions("POSITION_STATE_UNKNOWN", context.marketId),
          );
        }
      }

      // §9.9 row 1: "External reference feed stale, Polymarket healthy →
      // Cancel signal-dependent quotes; halt new entries." Entries only —
      // blanket-blocking an exit on a SIGNAL feed while the venue book is
      // healthy would be the dangerous reading of this row.
      if (isEntry) {
        for (const finding of [assessment.features, assessment.referenceFeed] as const) {
          if (!blocksAsStale(finding)) continue;
          const code: RiskReasonCode =
            finding.status === "UNKNOWN"
              ? "RISK_FRESHNESS_UNKNOWN"
              : finding.feed === "FEATURES"
                ? "RISK_FEATURES_STALE"
                : "RISK_REFERENCE_FEED_STALE";
          accumulator.refusals.push(
            riskRefusal(
              code,
              "a required signal feed is stale or unmeasured; new entries are halted (§9.8 check 7, §9.9 row 1)",
              {
                marketId: context.marketId,
                feed: finding.feed,
                status: finding.status,
                ageMs: finding.ageMs,
                limitMs: finding.limitMs,
              },
            ),
          );
        }
        if (!bookBlocks && blocksAsStale(assessment.referenceFeed)) {
          recommend(
            accumulator,
            recommendIncidentActions("REFERENCE_FEED_STALE_VENUE_HEALTHY", context.marketId),
          );
        }
      }
    }
  }

  // --- §9.8 check 8: book synchronized -------------------------------------
  if (placesOrders) {
    for (const context of contexts) {
      if (context.bookSynchronized !== true) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_BOOK_NOT_SYNCHRONIZED",
            "the local book is not confirmed synchronized for this market (absent = unknown = blocked)",
            {
              marketId: context.marketId,
              bookSynchronized: context.bookSynchronized ?? "UNSUPPLIED",
            },
          ),
        );
        recommend(accumulator, recommendIncidentActions("VENUE_BOOK_STALE", context.marketId));
      }
    }
  }

  // --- §9.8 check 9: current trading parameters are known ------------------
  if (placesOrders) {
    for (const context of contexts) {
      const missing = (
        [
          ["tickSize", context.tickSize],
          ["minimumOrderSize", context.minimumOrderSize],
          ["parametersVersion", context.parametersVersion],
        ] as const
      )
        .filter(([, value]) => value === undefined)
        .map(([name]) => name);
      if (missing.length > 0) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_TRADING_PARAMETERS_UNKNOWN",
            "current trading parameters are not fully known for this market (§6 invariant 9: parameters are versioned; an unknown version is not a known one)",
            { marketId: context.marketId, missing },
          ),
        );
      }
    }
  }

  const legsByMarket = new Map<string, IntentLeg[]>();
  for (const leg of view.legs) {
    const existing = legsByMarket.get(leg.marketId);
    if (existing === undefined) legsByMarket.set(leg.marketId, [leg]);
    else existing.push(leg);
  }

  // --- §9.8 check 10: price conforms to tick and configured bounds ---------
  if (placesOrders) {
    for (const context of contexts) {
      const tickSize = context.tickSize;
      if (tickSize === undefined) continue;
      for (const leg of legsByMarket.get(context.marketId) ?? []) {
        if (leg.limitPrice === undefined) continue;
        if (!isTickConformant(leg.limitPrice, tickSize)) {
          accumulator.refusals.push(
            riskRefusal(
              "RISK_PRICE_NOT_TICK_CONFORMANT",
              "a leg price is not an exact multiple of the market's tick size",
              { marketId: context.marketId, price: leg.limitPrice, tickSize, action: leg.action },
            ),
          );
        }
      }
    }
  }

  // --- §9.8 check 11: size meets minimum and economic floor ----------------
  if (placesOrders) {
    for (const context of contexts) {
      const minimumOrderSize = context.minimumOrderSize;
      if (minimumOrderSize === undefined) continue;
      for (const leg of legsByMarket.get(context.marketId) ?? []) {
        if (compareDecimal(leg.shares, minimumOrderSize) < 0) {
          accumulator.refusals.push(
            riskRefusal("RISK_SIZE_BELOW_MINIMUM", "a leg size is below the market minimum", {
              marketId: context.marketId,
              shares: leg.shares,
              minimumOrderSize,
              action: leg.action,
            }),
          );
        }
      }
    }
  }
  // The economic floor gates ENTRIES only: a floor that blocked an exit would
  // trap a small position that cannot economically be closed.
  if (isEntry && policy.economics.minOrderNotional !== undefined) {
    if (view.boundedCost !== undefined) {
      if (compareDecimal(view.boundedCost, policy.economics.minOrderNotional) < 0) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_NOTIONAL_BELOW_ECONOMIC_FLOOR",
            "the intent's bounded notional is below the configured economic floor",
            {
              boundedCost: view.boundedCost,
              minOrderNotional: policy.economics.minOrderNotional,
            },
          ),
        );
      }
    }
  }

  // --- §9.8 check 12: expected net edge after fees, slippage, buffer -------
  if (isEntry && policy.economics.requirePositiveNetEdgeForEntries) {
    const declaredEdge =
      data.intent.type === "POSITION"
        ? data.intent.expectedNetEdge
        : data.intent.type === "BASKET"
          ? data.intent.minimumLockedEdge
          : undefined;
    const fee = data.economics.feeEstimate;
    const slippage = data.economics.slippageEstimate;
    const missingInputs = [
      ...(declaredEdge === undefined ? ["expectedNetEdge"] : []),
      ...(fee === undefined ? ["feeEstimate"] : []),
      ...(slippage === undefined ? ["slippageEstimate"] : []),
    ];
    if (missingInputs.length > 0) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_EDGE_INPUTS_MISSING",
          "the expected-net-edge check requires a declared edge and exact fee and slippage estimates; an unsupplied cost is not a zero cost (fail closed)",
          { intentType: data.intent.type, missing: missingInputs },
        ),
      );
    } else if (declaredEdge !== undefined && fee !== undefined && slippage !== undefined) {
      const net = subDecimal(
        subDecimal(subDecimal(declaredEdge, fee), slippage),
        policy.economics.riskBuffer,
      );
      if (compareDecimal(net, "0") <= 0) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_NET_EDGE_NOT_POSITIVE",
            "expected net edge is not strictly positive after fees, slippage, and the risk buffer",
            {
              declaredEdge,
              feeEstimate: fee,
              slippageEstimate: slippage,
              riskBuffer: policy.economics.riskBuffer,
              net,
            },
          ),
        );
      }
    }
  }

  // --- §9.8 check 13: participation limits ---------------------------------
  if (isEntry && policy.participation.maxOrderShares !== undefined) {
    if (compareDecimal(view.buyShares, policy.participation.maxOrderShares) > 0) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_PARTICIPATION_LIMIT_EXCEEDED",
          "the intent's bought share count exceeds the configured per-intent participation limit",
          { buyShares: view.buyShares, maxOrderShares: policy.participation.maxOrderShares },
        ),
      );
    }
  }

  // --- §9.8 check 14: balance, allowance, inventory, reservations ----------
  // An EXPLICIT allocator refusal always binds. Its ABSENCE blocks entries
  // only: refusing a reduction because a peer view was not supplied would
  // trap a position the account already holds.
  if (data.allocation === undefined) {
    if (isEntry) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_ALLOCATION_VERDICT_MISSING",
          "no capital-allocator verdict was supplied for an entry; balance, inventory, and reservations are therefore unproven (fail closed)",
          {},
        ),
      );
    }
  } else if (!data.allocation.permitted) {
    accumulator.refusals.push(
      riskRefusal(
        "RISK_ALLOCATION_REFUSED",
        "the capital allocator refused this commitment",
        {
          allocatorCodes: (data.allocation.refusals ?? []).map((refusal) => refusal.code),
        },
      ),
    );
  }

  // §6 invariant 10: exit quantity is based on confirmed actual allocation.
  for (const leg of view.legs) {
    if (leg.action !== "SELL" || leg.side === undefined) continue;
    const held = heldShares(data.portfolio, leg.marketId, leg.side);
    if (compareDecimal(leg.shares, held) > 0) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_SELL_EXCEEDS_INVENTORY",
          "a sell leg exceeds the confirmed holding (§6 invariant 10: exit quantity is based on confirmed actual allocation, never requested entry size)",
          { marketId: leg.marketId, side: leg.side, shares: leg.shares, held },
        ),
      );
    }
  }

  // §6 invariant 12: a reduction on a market the portfolio does not describe
  // is acting on unknown position state.
  if (view.disposition === "EXIT") {
    for (const marketId of view.marketIds) {
      const held = heldBothSides(data, marketId);
      if (compareDecimal(held.yes, "0") === 0 && compareDecimal(held.no, "0") === 0) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_POSITION_STATE_UNKNOWN",
            "a reduction was requested for a market the supplied portfolio holds no position in; §6 invariant 12 requires cancel and reconciliation before any protected reduction",
            { marketId },
          ),
        );
        recommend(accumulator, recommendIncidentActions("POSITION_STATE_UNKNOWN", marketId));
      }
    }
  }

  if (data.intent.type === "QUOTE") {
    const held = heldBothSides(data, data.intent.marketId);
    const worseSide = compareDecimal(held.yes, held.no) >= 0 ? held.yes : held.no;
    let bidShares: SharesString = "0";
    for (const bid of data.intent.bids) {
      bidShares = addDecimal(bidShares, bid.shares);
    }
    const projected = addDecimal(worseSide, bidShares);
    if (compareDecimal(projected, data.intent.maximumInventory) > 0) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_QUOTE_MAX_INVENTORY_EXCEEDED",
          "the quote's fully-filled bid ladder would carry inventory above the intent's own maximumInventory",
          {
            marketId: data.intent.marketId,
            heldWorseSide: worseSide,
            bidShares,
            projected,
            maximumInventory: data.intent.maximumInventory,
          },
        ),
      );
    }
  }

  // --- §9.8 check 15: per-order, per-scope, and global limits --------------
  // Capacity limits gate ENTRIES. An exit REDUCES exposure, so enforcing a cap
  // against it would block exactly the action that brings the account back
  // inside the cap.
  const perMarketContribution = new Map<string, MoneyString>();
  // An UNBOUNDED leg has no cost to compare against a cap, and a zero is not a
  // conservative stand-in for one. `view.boundedCost === undefined` and an
  // unbounded leg are the same condition (`intent-view.ts`), and it is already
  // refused as `RISK_WORST_CASE_UNBOUNDED` at check 16 — so the intent never
  // passes on the strength of a skipped capacity check.
  let anyLegUnbounded = false;
  for (const legs of legsByMarket.values()) {
    if (legs.some((leg) => leg.boundedCost === undefined)) anyLegUnbounded = true;
  }
  if (isEntry && view.boundedCost !== undefined && !anyLegUnbounded) {
    for (const [marketId, legs] of legsByMarket) {
      let contribution: MoneyString = "0";
      for (const leg of legs) {
        // Narrowed by `anyLegUnbounded` above; never defaulted to "0".
        if (leg.boundedCost === undefined) continue;
        contribution = addDecimal(contribution, leg.boundedCost);
      }
      perMarketContribution.set(marketId, contribution);
    }
    if (policy.limits.maxOrderNotional !== undefined) {
      if (compareDecimal(view.boundedCost, policy.limits.maxOrderNotional) > 0) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_PER_ORDER_NOTIONAL_EXCEEDED",
            "the intent's bounded notional exceeds the per-order notional limit",
            { boundedCost: view.boundedCost, maxOrderNotional: policy.limits.maxOrderNotional },
          ),
        );
      }
    }
    accumulator.refusals.push(
      ...checkExposureLimits(policy.limits, data.exposures, {
        strategyInstanceId: data.context.strategyInstanceId,
        perMarketContribution,
        scopeByMarket,
        totalContribution: view.boundedCost,
      }),
    );
  }

  // --- §9.8 check 16: worst-case contractual loss — PRIMARY ----------------
  const lots = buildWorstCaseLots(data.portfolio, view);
  let worstCase: WorstCaseAssessment | undefined;
  if (lots === undefined) {
    accumulator.refusals.push(
      riskRefusal(
        "RISK_WORST_CASE_UNBOUNDED",
        "the intent bounds no maximum cost (no maximumBuyPrice and no maximumTotalCost), so its worst-case contractual loss is unbounded and cannot be shown to pass the primary limit",
        { intentType: data.intent.type },
      ),
    );
  } else {
    worstCase = assessWorstCase(lots);
    // Enforced for ENTRIES. An exit cannot raise the measure (SELL legs are
    // assumed not to fill), so enforcing it against a reduction would block
    // the account from de-risking precisely when it is over the limit.
    if (isEntry) {
      if (
        compareDecimal(worstCase.maximumContractualLoss, policy.limits.maxWorstCaseContractualLoss) >
        0
      ) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_WORST_CASE_LOSS_EXCEEDED",
            "projected maximum contractual loss exceeds the primary limit (§9.8: maximum contractual loss is a primary risk measure; the unverified CANCELLED outcome is bounded by a zero-redemption floor, never valued — WP-110 register row U-10)",
            {
              maximumContractualLoss: worstCase.maximumContractualLoss,
              limit: policy.limits.maxWorstCaseContractualLoss,
              cancelledOutcomeTreatment: worstCase.cancelledOutcomeTreatment,
              perMarket: worstCase.perMarket.map((market) => ({
                marketId: market.marketId,
                committedCost: market.committedCost,
                worstVerifiedOutcome: market.worstVerifiedOutcome,
                worstVerifiedValue: market.worstVerifiedValue,
              })),
            },
          ),
        );
      }
      if (policy.limits.maxWorstCaseResolutionLoss !== undefined) {
        if (
          compareDecimal(
            worstCase.worstCaseResolutionLoss,
            policy.limits.maxWorstCaseResolutionLoss,
          ) > 0
        ) {
          accumulator.refusals.push(
            riskRefusal(
              "RISK_WORST_CASE_RESOLUTION_LOSS_EXCEEDED",
              "projected worst-case resolution loss over the three VERIFIED terminal outcomes exceeds its limit",
              {
                worstCaseResolutionLoss: worstCase.worstCaseResolutionLoss,
                limit: policy.limits.maxWorstCaseResolutionLoss,
              },
            ),
          );
        }
      }
    }
  }

  // --- §9.8 check 17: scenario loss ----------------------------------------
  let scenario: ScenarioAssessment | undefined;
  if (lots !== undefined) {
    scenario = assessScenarios(data.scenarios, lots, policy.scenario.requiredKinds);
    if (isEntry) {
      if (scenario.missingKinds.length > 0) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_SCENARIO_MISSING",
            "a required shock scenario was not supplied; an unmeasured scenario is not a passed scenario (fail closed)",
            {
              missingKinds: scenario.missingKinds,
              requiredKinds: policy.scenario.requiredKinds,
            },
          ),
        );
      }
      if (scenario.incompleteScenarioIds.length > 0) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_SCENARIO_MARKS_INCOMPLETE",
            "a supplied scenario does not mark every market the account holds; a partially-marked portfolio understates the loss",
            { incompleteScenarioIds: scenario.incompleteScenarioIds },
          ),
        );
      }
      if (
        scenario.worstLoss !== undefined &&
        compareDecimal(scenario.worstLoss, policy.scenario.maxScenarioLoss) > 0
      ) {
        accumulator.refusals.push(
          riskRefusal("RISK_SCENARIO_LOSS_EXCEEDED", "worst scenario loss exceeds its limit", {
            worstLoss: scenario.worstLoss,
            worstScenarioId: scenario.worstScenarioId,
            limit: policy.scenario.maxScenarioLoss,
          }),
        );
      }
    }
  }

  // --- §9.8 check 18: self-trade and duplicate-intent guards ---------------
  if (view.intentId !== undefined && data.guards.recentIntentIds.includes(view.intentId)) {
    accumulator.refusals.push(
      riskRefusal("RISK_DUPLICATE_INTENT", "this intentId was already evaluated", {
        intentId: view.intentId,
      }),
    );
  }
  if (isEntry) {
    for (const leg of view.legs) {
      if (leg.limitPrice === undefined) continue;
      for (const resting of data.portfolio.openOrders) {
        if (resting.marketId !== leg.marketId) continue;
        if (leg.side !== undefined && resting.side !== leg.side) continue;
        const crosses =
          leg.action === "BUY"
            ? resting.action === "SELL" && compareDecimal(leg.limitPrice, resting.price) >= 0
            : resting.action === "BUY" && compareDecimal(resting.price, leg.limitPrice) >= 0;
        if (crosses) {
          accumulator.refusals.push(
            riskRefusal(
              "RISK_SELF_TRADE",
              "the intent would cross the account's own resting order on the same market and token",
              {
                marketId: leg.marketId,
                legAction: leg.action,
                legPrice: leg.limitPrice,
                restingOrderId: resting.orderId,
                restingAction: resting.action,
                restingPrice: resting.price,
              },
            ),
          );
        }
      }
    }
  }

  // --- §9.8 check 19: rate-limit headroom above the safety reserve ---------
  // Entries only: §6 invariant 13 makes the reserve exist FOR safety
  // cancellations, so consuming it must not be what blocks one.
  if (isEntry) {
    const available = data.rateLimit.availableRequests;
    if (available === undefined) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_RATE_LIMIT_UNKNOWN",
          "rate-limit headroom was not supplied; unknown headroom is not sufficient headroom (fail closed)",
          {},
        ),
      );
    } else if (available <= policy.rateLimit.safetyReserveRequests) {
      accumulator.refusals.push(
        riskRefusal(
          "RISK_RATE_LIMIT_HEADROOM_INSUFFICIENT",
          "remaining rate-limit headroom is at or below the safety reserve (§6 invariant 13: safety cancellation outranks new order placement)",
          {
            availableRequests: available,
            safetyReserveRequests: policy.rateLimit.safetyReserveRequests,
          },
        ),
      );
    }
  }

  // --- §9.8 check 20: time-to-close policy ---------------------------------
  if (isEntry) {
    for (const context of contexts) {
      const secondsToClose = context.secondsToClose;
      if (secondsToClose === undefined) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_TIME_TO_CLOSE_UNKNOWN",
            "time to close was not supplied for this market; unknown is not permitted (fail closed)",
            { marketId: context.marketId },
          ),
        );
        continue;
      }
      if (secondsToClose <= policy.timeToClose.entryCutoffSeconds) {
        accumulator.refusals.push(
          riskRefusal(
            "RISK_TIME_TO_CLOSE_ENTRY_BLOCKED",
            "the market is inside the configured entry cutoff before close",
            {
              marketId: context.marketId,
              secondsToClose,
              entryCutoffSeconds: policy.timeToClose.entryCutoffSeconds,
            },
          ),
        );
        const held = heldBothSides(data, context.marketId);
        if (compareDecimal(held.yes, "0") > 0 || compareDecimal(held.no, "0") > 0) {
          recommend(
            accumulator,
            recommendIncidentActions("POSITION_KNOWN_NEAR_CLOSE", context.marketId),
          );
        }
      }
    }
  }

  // --- §6 INVARIANT 13 — THE CANCEL CHOKE POINT ----------------------------
  //
  // "Safety cancellation outranks new order placement." A blocked cancel can
  // trap a position, which is precisely the failure this invariant exists to
  // prevent, so a CANCEL is privileged HERE, structurally, rather than by a
  // condition on each individual gate: once the input has parsed and the
  // disposition is `CANCEL`, every refusal the pipeline accumulated — from any
  // gate, including gates added after this was written — becomes a
  // non-blocking observation and the cancel is approved.
  //
  // Review round 1 (BLOCKER 1) found run-mode mismatch and an explicit
  // allocator refusal blocking cancels; the same-class audit of every gate in
  // this function additionally found `RISK_MARKET_CONTEXT_MISSING` and
  // `RISK_UUID_NOT_CANONICAL`. The audit and its findings are tabulated in
  // `README.md` §4.1 and `docs/handoffs/WP-180.md`.
  //
  // The ONE thing a cancel cannot bypass is input validation itself
  // (`RISK_INPUT_INVALID`, returned far above): until the input parses there is
  // no disposition to privilege, and an unparseable request names no orders to
  // cancel. That is a limit of knowledge, not a risk gate.
  //
  // DO NOT add an early `return rejected(...)` above this point, and DO NOT
  // make this condition narrower. `test/unit/risk/engine.test.ts`
  // ("a CANCEL survives every audited gate, all tripped at once") fails if you
  // do.
  if (isCancel) {
    // A cancel contributes no BUY leg, so `lots` is the portfolio's own lot set
    // and `buildWorstCaseLots` cannot have returned `undefined` (it does so
    // only for an unbounded BUY leg). The `[]` arm is structurally unreachable
    // and is an EXACT empty lot set, not a substituted measurement.
    const cancelWorstCase = worstCase ?? assessWorstCase(lots ?? []);
    const cancelRecord: ApprovedIntentRecord = {
      approvedIntentId: data.identifiers.approvedIntentId,
      lineage: "ORIGINAL",
      rootApprovedIntentId: data.identifiers.approvedIntentId,
      ...(view.intentId === undefined ? {} : { sourceIntentId: view.intentId }),
      intent: data.intent,
      approvedAt: data.evaluatedAt,
      runMode: data.context.runMode,
      strategyInstanceId: data.context.strategyInstanceId,
      reasons: ["RISK_APPROVED", "RISK_CANCEL_ALWAYS_PERMITTED"],
      worstCase: cancelWorstCase,
      worstCaseBasis: "EVALUATED",
      recommendations: accumulator.recommendations,
    };
    return deepFreeze({
      approved: true as const,
      record: cancelRecord,
      refusals: [] as const,
      cancelPriorityOverrides: [...accumulator.refusals],
      recommendations: accumulator.recommendations,
      worstCase: cancelWorstCase,
      scenario,
      freshness,
    });
  }

  if (accumulator.refusals.length > 0 || worstCase === undefined) {
    if (worstCase === undefined && accumulator.refusals.length === 0) {
      // Unreachable: an undefined assessment always pushes
      // RISK_WORST_CASE_UNBOUNDED above. Kept as a fail-closed backstop so a
      // future edit cannot approve without a worst-case measure.
      accumulator.refusals.push(
        riskRefusal(
          "RISK_WORST_CASE_UNBOUNDED",
          "no worst-case assessment was produced; approval without the primary measure is not available",
          {},
        ),
      );
    }
    return rejected(accumulator, worstCase, scenario, freshness);
  }

  // A `CANCEL` returned at the choke point above and never reaches here.
  const reasons: RiskReasonCode[] = ["RISK_APPROVED"];
  if (view.disposition === "EXIT") reasons.push("RISK_EXIT_CAPACITY_CHECKS_INAPPLICABLE");

  const record: ApprovedIntentRecord = {
    approvedIntentId: data.identifiers.approvedIntentId,
    lineage: "ORIGINAL",
    rootApprovedIntentId: data.identifiers.approvedIntentId,
    ...(view.intentId === undefined ? {} : { sourceIntentId: view.intentId }),
    intent: data.intent,
    approvedAt: data.evaluatedAt,
    runMode: data.context.runMode,
    strategyInstanceId: data.context.strategyInstanceId,
    reasons,
    worstCase,
    worstCaseBasis: "EVALUATED",
    recommendations: accumulator.recommendations,
  };

  return deepFreeze({
    approved: true as const,
    record,
    refusals: [] as const,
    // Only a CANCEL can override a gate; every other approval overrode nothing.
    cancelPriorityOverrides: [] as const,
    recommendations: accumulator.recommendations,
    worstCase,
    scenario,
    freshness,
  });
}
