/**
 * The decision-to-order pipeline: §8.1 steps 6 through 9.
 *
 * ```text
 * … invoke subscribed strategies in stable configured order
 *   → persist DecisionResults
 *   → allocate capital          ← §9.7, packages/capital-allocator
 *   → run risk checks           ← §9.8, packages/risk
 *   → create execution plans    ← §9.10, packages/execution-planner
 *   → update OMS / submit eligible actions
 * ```
 *
 * This module builds the DOCUMENTS those packages consume. It applies no policy
 * of its own: every gate, every limit and every refusal below belongs to a
 * merged package, and this file's whole job is to hand each package a complete,
 * honest view of the state it is entitled to see.
 *
 * ## Two things it deliberately does NOT do
 *
 * 1. **It does not compensate for a risk refusal.** This pipeline does not
 *    re-tag an intent, does not resize it, does not lower a policy bound and
 *    does not bypass `evaluateIntent`. A refused protective exit is counted on
 *    the health surface (`health.ts`, `refusedExits`) and stands. A refused
 *    exit is visible; a wrong order is not acceptable.
 * 2. **It does not invent a value a package refused to default.** Where §9.8
 *    fails closed on an absent input — an absent `exposures` with a configured
 *    cap, an absent `allocation` verdict, an absent freshness measurement — this
 *    module supplies the real measurement or supplies nothing. Filling a gap
 *    with a plausible number is how a fail-closed gate becomes a fail-open one.
 *
 *    > **Corrected 2026-09-05 (remediation round 1).** At the reviewed tip this
 *    > paragraph was FALSE for the two inputs it names first: `loop.ts` passed
 *    > `exposures: undefined` and a fabricated `allocation: { permitted: true }`,
 *    > which is precisely "filling a gap with a plausible number" — and the gap
 *    > it filled was §9.8 check 14, the balance/inventory/reservation gate. Both
 *    > now carry the §9.7 allocator's real answers (`allocation.ts`); a
 *    > `permitted` this module could write is a check this module has deleted.
 *
 * ## Where `immediate_order_type` is consumed (the `WP-220` open question)
 *
 * `WP-220` records the question and does not answer it: the strategy tags its
 * entry intent `sb.order-type:FAK`, `packages/risk` never reads tags, and
 * `packages/execution-planner`'s `PlannedOrder` carries `executionStyle` and
 * `postOnly` but no time-in-force. The seam that needs one is
 * `packages/simulation`'s `ExecutionPolicy.timeInForceFor(order)`, whose own
 * comment states the rule this module follows:
 *
 * > "WP-190's `PlannedOrder` carries `executionStyle` and `postOnly` but no
 * > time-in-force — the planner does not choose one. So the venue asks the
 * > composition root rather than assuming a default: **a silently assumed `FAK`
 * > would change every unfilled remainder's fate.**"
 *
 * So the resolution is here, and it is: **read the tag; fall back to the
 * emitting instance's configured `immediate_order_type`; never default.**
 * {@link OrderTimeInForceBook} records the answer per planned order at plan
 * time, when both the intent's tags and the emitting instance are still in
 * hand, and the venue policy reads that book. An order whose time-in-force
 * cannot be resolved is REFUSED rather than submitted, because "FAK" chosen by
 * accident is a different order from the one the operator configured.
 */

import {
  buildExecutionPlan,
  type ExecutionPlan,
  type PlannerResult,
  type PlanningInputs,
} from "@polymarket-bot/execution-planner";
import type { Intent, RunMode } from "@polymarket-bot/domain";
import {
  evaluateIntent,
  type RiskEvaluation,
  type RiskPolicy,
} from "@polymarket-bot/risk";
import type { TimeInForce } from "@polymarket-bot/simulation";

import type { MarketConfig, TraderConfig } from "./config.js";
import type { MarketState } from "./market-state.js";
import type { ReservationBook } from "./reservations.js";

/** The tag prefix `packages/strategies/static-bracket`'s `orderTypeTag` emits. */
export const ORDER_TYPE_TAG_PREFIX = "sb.order-type:";

/** The tags an emitted intent may carry to mark itself an EXIT. */
export const PROTECTIVE_EXIT_TAGS: readonly string[] = Object.freeze([
  "sb.protected-reduce",
  "sb.take-profit",
]);

const TIME_IN_FORCE_VALUES: readonly string[] = Object.freeze(["GTC", "GTD", "FAK", "FOK"]);

/**
 * True when the intent's own tags mark it as a protective exit.
 *
 * Used ONLY for the health surface's `refusedExits` counter. It is not read by
 * any gate, and it must never be: `packages/risk` decides disposition from the
 * intent SHAPE and the supplied portfolio, never from a tag (`RISK-2`,
 * `133eac1`, superseding this sentence's earlier premise "`packages/risk`
 * decides disposition from the intent TYPE"), and a composition root that
 * re-derived a different disposition from tags would be the "mis-tag intents
 * to compensate" move the packet forbids and the strategy's README warns
 * against.
 */
export function isProtectiveExitIntent(intent: Intent): boolean {
  if (!("tags" in intent) || !Array.isArray(intent.tags)) return false;
  return intent.tags.some((tag) => PROTECTIVE_EXIT_TAGS.includes(tag));
}

/**
 * Resolves the venue time-in-force for one intent.
 *
 * Tag first, instance configuration second, REFUSAL third. There is no fourth
 * branch and no default.
 */
export function resolveTimeInForce(
  intent: Intent,
  instanceConfigured: string | undefined,
): { readonly ok: true; readonly timeInForce: TimeInForce } | { readonly ok: false; readonly detail: string } {
  if ("tags" in intent && Array.isArray(intent.tags)) {
    for (const tag of intent.tags) {
      if (typeof tag !== "string" || !tag.startsWith(ORDER_TYPE_TAG_PREFIX)) continue;
      const value = tag.slice(ORDER_TYPE_TAG_PREFIX.length);
      if (TIME_IN_FORCE_VALUES.includes(value)) {
        return { ok: true, timeInForce: value as TimeInForce };
      }
      return {
        ok: false,
        detail:
          `the intent carries ${tag}, which does not name one of the venue's four ` +
          `time-in-force values (${TIME_IN_FORCE_VALUES.join(", ")}); refused rather than ` +
          "coerced",
      };
    }
  }
  if (instanceConfigured !== undefined && TIME_IN_FORCE_VALUES.includes(instanceConfigured)) {
    return { ok: true, timeInForce: instanceConfigured as TimeInForce };
  }
  return {
    ok: false,
    detail:
      "no time-in-force could be resolved for this intent: it carries no " +
      `${ORDER_TYPE_TAG_PREFIX}* tag and the emitting instance states none. The venue asks ` +
      "the composition root precisely so that none is assumed — a silently assumed FAK would " +
      "change every unfilled remainder's fate — so the order is REFUSED",
  };
}

/**
 * `plannedOrderId -> TimeInForce`, recorded at plan time.
 *
 * The venue's `ExecutionPolicy` reads this and nothing else, so an order whose
 * time-in-force was never recorded cannot be submitted with a guessed one: the
 * policy's lookup misses and the submission is refused upstream.
 */
export class OrderTimeInForceBook {
  readonly #byOrder = new Map<string, TimeInForce>();

  record(plannedOrderId: string, timeInForce: TimeInForce): void {
    this.#byOrder.set(plannedOrderId, timeInForce);
  }

  get(plannedOrderId: string): TimeInForce | undefined {
    return this.#byOrder.get(plannedOrderId);
  }

  release(plannedOrderId: string): void {
    this.#byOrder.delete(plannedOrderId);
  }

  get size(): number {
    return this.#byOrder.size;
  }
}

/** One virtual position, as the risk engine's portfolio view carries it. */
export interface PortfolioPositionInput {
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly shares: string;
  readonly costBasis: string;
}

/** One working order, as the risk engine's portfolio view carries it. */
export interface PortfolioOpenOrderInput {
  readonly orderId: string;
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly price: string;
  readonly shares: string;
}

/**
 * `CAP-1`: one market token's filled-but-unbooked BUY exposure, as the risk
 * engine's SEPARATE `unbookedFills` input carries it (§9.8 checks 16 and 17
 * only; `AllocatorGate.unbookedExposure`).
 */
export interface UnbookedFillInput {
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly shares: string;
  readonly debit: string;
}

export interface RiskInputContext {
  readonly intent: Intent;
  readonly evaluatedAt: string;
  readonly approvedIntentId: string;
  readonly runMode: RunMode;
  readonly strategyInstanceId: string;
  /** §9.8 check 1, computed by the caller for THIS intent. */
  readonly runStatePermitsIntent: boolean;
  readonly strategyStatePermitsIntent: boolean;
  readonly market: MarketState;
  readonly marketConfig: MarketConfig;
  /**
   * Whole seconds to close, from the later of the event instant and the
   * process instant (`CO2-N1`, ADR-031 R4). Absent = unknown.
   */
  readonly secondsToClose: number | undefined;
  /** §9.8 check 8: the book applied its last update without refusing. */
  readonly bookSynchronized: boolean;
  /** Measured book age in milliseconds at the loop's instant. */
  readonly venueBookAgeMs: number;
  /**
   * Measured feature-snapshot age in milliseconds: for a placement, the
   * trader's lag behind the event it evaluated, `max(0, processNow −
   * eventNow)` (`CO2-N1`, ADR-031 R3).
   *
   * `undefined` when the process clock's reading could not be read (R5). It
   * is propagated as an OMITTED observation, exactly as
   * {@link referenceFeedAgeMs} is, so §9.8 check 7 reads the features feed as
   * `UNKNOWN` and refuses an entry — never a zero nobody measured.
   */
  readonly featuresAgeMs: number | undefined;
  /**
   * Measured reference-feed age in milliseconds, or `undefined` when this
   * process has seen no reference event at all.
   *
   * `undefined` is propagated as an OMITTED observation rather than as a large
   * age: §9.8 tells `STALE` from `UNKNOWN` and both fail closed, but only one
   * of them is a fact this process can assert. §9.9 row 1 is the consequence —
   * "External reference feed stale, Polymarket healthy → halt new entries".
   */
  readonly referenceFeedAgeMs: number | undefined;
  readonly positions: readonly PortfolioPositionInput[];
  readonly openOrders: readonly PortfolioOpenOrderInput[];
  /**
   * `CAP-1` (orchestrator ruling, 2026-10-04): the strategy's
   * filled-but-unbooked BUY exposure — a fill the venue made that no position
   * carries yet. Since `CAP-1` r1 that includes the filled shares of a WORKING
   * order, which `openOrders` presents at its unfilled remainder only, so the
   * three views are disjoint. REQUIRED, so no
   * caller can forget it, and always emitted (an empty list included): the
   * risk engine reads an absent list as "none", which is the measure before
   * `CAP-1`. It is NOT a position (no exit may sell it, §6 invariant 10) and
   * NOT an open order (§9.8 check 18 never sees it); only checks 16 and 17
   * count it.
   */
  readonly unbookedFills: readonly UnbookedFillInput[];
  /**
   * `packages/capital-allocator`'s §9.7 exposure snapshot, covering every scope
   * this evaluation will query (`allocation.ts`). Absent is a real absence and
   * §9.8 check 15 fails closed on it; the loop never supplies one.
   */
  readonly exposures: unknown;
  /**
   * `packages/capital-allocator`'s own reservation verdict for this intent, or
   * `undefined` for an intent that commits nothing (a `CANCEL`).
   *
   * NEVER a value this module or the loop constructs. §9.8 check 14 is
   * fail-closed by design, so anything written here that is not the allocator's
   * answer replaces the check rather than satisfying it.
   */
  readonly allocation: unknown;
  /** §9.8 check 18's duplicate guard: intent ids recently evaluated. */
  readonly recentIntentIds: readonly string[];
  /** §9.8 check 19: remaining request headroom, or absent = unknown. */
  readonly availableRequests: number | undefined;
  /** §9.8 check 9: the versioned parameter set these prices belong to. */
  readonly parametersVersion: number;
  /** §9.8 check 6: the §9.2 / §9.3 readiness echo. */
  readonly modelDependentActivationAllowed: boolean;
  /** §9.8 check 17: the shock scenarios, with marks measured from the book. */
  readonly scenarios: readonly {
    readonly scenarioId: string;
    readonly kind: "SPOT" | "VOLATILITY" | "TIME" | "LIQUIDITY";
    readonly marks: readonly { readonly marketId: string; readonly yesPrice: string }[];
  }[];
  readonly feeEstimate?: string | undefined;
  readonly slippageEstimate?: string | undefined;
}

/**
 * Builds the §9.8 evaluation document.
 *
 * Every absence below is a REAL absence, deliberately propagated: §9.8 fails
 * closed on an unknown, and manufacturing a value here would convert a
 * fail-closed check into a fail-open one. `secondsToClose`, `availableRequests`,
 * `exposures` and `allocation` are therefore omitted when the loop does not
 * know them, rather than defaulted — and so are the `FEATURES` and
 * `REFERENCE_FEED` freshness measurements (`CO2-N1`: an unreadable process
 * clock leaves the features age unmeasured).
 *
 * For `exposures` and `allocation` the loop DOES know them: `allocation.ts`
 * asks `packages/capital-allocator` before every risk check, and this function
 * passes its answers through unaltered. The omission arms are still live and
 * still correct — a `CANCEL` commits nothing, so it carries no verdict — and
 * they are what a reviewer should read as "the allocator was not asked".
 */
export function buildRiskEvaluationInput(context: RiskInputContext): unknown {
  const market = {
    marketId: context.marketConfig.marketId,
    status: marketStatusOf(context.market),
    tickSize: context.marketConfig.tickSize,
    minimumOrderSize: context.marketConfig.minimumOrderSize,
    parametersVersion: context.parametersVersion,
    settlement: { modelDependentActivationAllowed: context.modelDependentActivationAllowed },
    bookSynchronized: context.bookSynchronized,
    ...(context.secondsToClose === undefined
      ? {}
      : { secondsToClose: context.secondsToClose }),
    scope: {
      seriesKey: context.marketConfig.seriesKey,
      underlyingKey: context.marketConfig.underlyingKey,
      resolutionWindowKey: context.marketConfig.resolutionWindowKey,
    },
  };
  return {
    intent: context.intent,
    evaluatedAt: context.evaluatedAt,
    identifiers: { approvedIntentId: context.approvedIntentId },
    context: {
      runMode: context.runMode,
      strategyInstanceId: context.strategyInstanceId,
      runStatePermitsIntent: context.runStatePermitsIntent,
      strategyStatePermitsIntent: context.strategyStatePermitsIntent,
    },
    markets: [market],
    freshness: [
      { feed: "VENUE_BOOK", marketId: context.marketConfig.marketId, ageMs: context.venueBookAgeMs },
      ...(context.featuresAgeMs === undefined ? [] : [{ feed: "FEATURES", ageMs: context.featuresAgeMs }]),
      ...(context.referenceFeedAgeMs === undefined
        ? []
        : [{ feed: "REFERENCE_FEED", ageMs: context.referenceFeedAgeMs }]),
    ],
    portfolio: {
      positions: context.positions,
      openOrders: context.openOrders,
    },
    unbookedFills: context.unbookedFills,
    ...(context.exposures === undefined ? {} : { exposures: context.exposures }),
    ...(context.allocation === undefined ? {} : { allocation: context.allocation }),
    scenarios: context.scenarios,
    guards: { recentIntentIds: context.recentIntentIds },
    rateLimit:
      context.availableRequests === undefined
        ? {}
        : { availableRequests: context.availableRequests },
    economics: {
      ...(context.feeEstimate === undefined ? {} : { feeEstimate: context.feeEstimate }),
      ...(context.slippageEstimate === undefined
        ? {}
        : { slippageEstimate: context.slippageEstimate }),
    },
  };
}

/**
 * The §9.8 market status, derived from the local lifecycle.
 *
 * `PENDING` maps to `UNKNOWN` rather than to `ACTIVE`: a market this process
 * has not seen open is a market whose status it does not know, and §9.8's
 * `UNKNOWN` is "a legitimate, explicitly-stated ignorance" that fails closed.
 */
function marketStatusOf(market: MarketState): "ACTIVE" | "CLOSE_ONLY" | "HALTED" | "UNKNOWN" {
  switch (market.lifecycle) {
    case "OPEN":
      return "ACTIVE";
    case "CLOSING":
      return "CLOSE_ONLY";
    case "RESOLVED":
      return "HALTED";
    case "PENDING":
      return "UNKNOWN";
  }
}

/**
 * Runs the §9.8 engine. A thin pass-through, kept so the loop has exactly one
 * call site and a reviewer has exactly one place to check that no policy is
 * applied around it.
 */
export function runRiskCheck(policy: RiskPolicy, input: unknown): RiskEvaluation {
  return evaluateIntent(policy, input);
}

/**
 * Builds the §9.10 planning document for one market.
 *
 * The `inventory.reserved` figures come from {@link ReservationBook}, which is
 * `WP-220` obligation 9: "a reservation an accepted plan took must be honoured
 * before the next evaluation's reduction is planned". `selectDecreaseLeg` reads
 * `held − reserved` and refuses rather than downsizing, so passing a stale
 * `reserved` here is exactly how "a repeated protective exit becomes a multiple
 * of the position".
 *
 * `availableCollateral` is likewise the UNRESERVED balance, for the same reason
 * applied to cash.
 */
export function buildPlanningInputs(input: {
  readonly config: TraderConfig;
  readonly marketConfig: MarketConfig;
  readonly executionPlanId: string;
  readonly plannedAt: string;
  readonly availableCollateral: string;
  readonly heldYes: string;
  readonly heldNo: string;
  readonly reservations: ReservationBook;
  readonly yesBestBid: string | undefined;
  readonly yesBestAsk: string | undefined;
  readonly noBestBid: string | undefined;
  readonly noBestAsk: string | undefined;
}): PlanningInputs {
  const marketId = input.marketConfig.marketId;
  return {
    executionPlanId: input.executionPlanId,
    plannedAt: input.plannedAt,
    // §11: PAPER execution is simulated, and the accounting is the run's own.
    // `LIVE` here is the planner's ACCOUNTING mode (real allocation versus
    // shadow attribution), not a run mode — a `PAPER` run books against its own
    // simulated account, which is the accounting-real side of that distinction.
    accountingMode: "LIVE",
    availableCollateral: input.reservations.unreservedCollateral(input.availableCollateral),
    markets: [
      {
        marketId,
        tickSize: input.marketConfig.tickSize,
        minimumOrderSize: input.marketConfig.minimumOrderSize,
        makerFeeRate: input.marketConfig.makerFeeRate,
        takerFeeRate: input.marketConfig.takerFeeRate,
        book: {
          ...(input.yesBestBid === undefined ? {} : { yesBestBid: input.yesBestBid }),
          ...(input.yesBestAsk === undefined ? {} : { yesBestAsk: input.yesBestAsk }),
          ...(input.noBestBid === undefined ? {} : { noBestBid: input.noBestBid }),
          ...(input.noBestAsk === undefined ? {} : { noBestAsk: input.noBestAsk }),
        },
        inventory: {
          yes: {
            held: input.heldYes,
            reserved: input.reservations.reservedShares(marketId, "YES"),
          },
          no: {
            held: input.heldNo,
            reserved: input.reservations.reservedShares(marketId, "NO"),
          },
        },
      },
    ],
    policy: {
      maxSliceShares: input.config.planning.maxSliceShares,
      marketableSlippageTicks: input.config.planning.marketableSlippageTicks,
      replaceThresholdTicks: input.config.planning.replaceThresholdTicks,
      minimumReplaceIntervalMs: input.config.planning.minimumReplaceIntervalMs,
      cancelDeadlineMs: input.config.planning.cancelDeadlineMs,
      maxPlanLifetimeMs: input.config.planning.maxPlanLifetimeMs,
    },
    scope: {
      seriesKey: input.marketConfig.seriesKey,
      underlyingKey: input.marketConfig.underlyingKey,
      resolutionWindowKey: input.marketConfig.resolutionWindowKey,
    },
  };
}

/** Runs the §9.10 planner. One call site, no policy applied around it. */
export function runPlanner(record: unknown, inputs: PlanningInputs): PlannerResult<ExecutionPlan> {
  return buildExecutionPlan(record, inputs);
}
