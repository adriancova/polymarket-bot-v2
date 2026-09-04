/**
 * Fill-model vocabulary, evidence labels, and exact depth arithmetic.
 *
 * ## The evidence rule is a TYPE here, not a comment
 *
 * ADR-012 §2, and work-plan `WP-210` acceptance 4: "Paper fills are not labeled
 * real evidence." Handoff §12.2: Tier 0 is "**never used for deployment
 * decisions**"; Tier 1 "reports a result band, not one falsely precise fill
 * result"; and "Paper fills do **not** count as independent evidence that the
 * fill simulator is correct."
 *
 * That is encoded three ways, so a later change has to defeat all three:
 *
 * 1. Every simulated fill carries `evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"`
 *    — a one-member union, so no simulated value is assignable to anything
 *    typed as observed venue evidence.
 * 2. A Tier-0 outcome carries `deploymentDecisionUse: "FORBIDDEN"`, and
 *    {@link quoteForDeploymentDecision} accepts only a value whose
 *    `deploymentDecisionUse` is not `"FORBIDDEN"` — so passing a Tier-0 result
 *    is a COMPILE error, and the runtime guard catches an `any`-laundered one.
 * 3. A Tier-1 RESTING result is a {@link ../queue.js} band. There is no
 *    function in this package that returns a single resting fill, so a
 *    "falsely precise fill result" is not constructible.
 *
 * ## Depth arithmetic
 *
 * Every quantity is an exact decimal string (§6 invariant 1). The ladder walk
 * below is the only place a simulated execution consumes size, and it is total:
 * a malformed level is a refusal, never a silently skipped level.
 *
 * ADR-012 §5.8 / ADR-013: `price_change.size` is CONFIRMED absolute with `"0"`
 * removing a level, so a ladder is a set of aggregate levels and no delta
 * reconstruction happens here.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString, mulDecimal, subDecimal } from "@polymarket-bot/decimal";

import { ownFrozenTree } from "./plain.js";
import type {
  BookLevelView,
  FillFactView,
  PlanningDepthAwareness,
  RecordedEventIdentity,
  SimulatedEvidenceClass,
  SimulatedRunMode,
} from "./ports.js";
import { PLANNING_DEPTH_AWARENESS, SIMULATED_EVIDENCE_CLASS } from "./ports.js";
import { simulationFailure, simulationOk, type SimulationResult } from "./refusals.js";

/** The two fill-model tiers of §12.2. There is no third. */
export type FillModelTier = "TIER_0" | "TIER_1";

/** What a tier's output may be used for. Fixed by ADR-012 §1, not by a caller. */
export type PermittedUse =
  /** Tier 0 (§12.2): "Never used for deployment decisions." */
  | "WIRING_AND_REGRESSION_ONLY"
  /** Tier 1 (§12.2): research and comparison, reported as a band. */
  | "RESEARCH_AND_COMPARISON_BAND_ONLY";

/** Whether a result may be quoted in a deployment decision. */
export type DeploymentDecisionUse = "FORBIDDEN" | "PERMITTED_AS_BAND";

/** The identity of the model that produced a result (§12.5 pins it per run). */
export interface FillModelIdentity {
  readonly tier: FillModelTier;
  /** The §12.5 "fill-model version" pin. Present on EVERY simulated fill. */
  readonly fillModelVersion: string;
  /** Content identity of the §12.5 "fill-model parameters" pin. */
  readonly fillModelParametersHash: string;
  readonly permittedUse: PermittedUse;
  readonly deploymentDecisionUse: DeploymentDecisionUse;
  /**
   * ADR-012 §7: no execution probe and no live-micro run has occurred, so no
   * calibration data exists and nothing here is fitted to observed venue
   * behaviour. Recorded on the model so a report cannot omit it.
   */
  readonly calibration: "UNCALIBRATED_NO_PROBE_DATA_EXISTS";
}

/** One simulated fill. Never an observation; see the header. */
export interface SimulatedFill {
  readonly simulatedFillId: string;
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly price: string;
  readonly shares: string;
  readonly feeAmount: string;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly evidenceClass: SimulatedEvidenceClass;
  readonly fillModelVersion: string;
  readonly model: FillModelIdentity;
  readonly planningDepthAwareness: PlanningDepthAwareness;
  /** The recorded event this fill executed against. Never a wall clock. */
  readonly atEvent: RecordedEventIdentity;
}

/** Builds a fill with the mandatory labels applied. The only constructor. */
export function simulatedFill(input: {
  readonly simulatedFillId: string;
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly price: string;
  readonly shares: string;
  readonly feeAmount: string;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly model: FillModelIdentity;
  readonly atEvent: RecordedEventIdentity;
}): SimulatedFill {
  return ownFrozenTree<SimulatedFill>({
    ...input,
    evidenceClass: SIMULATED_EVIDENCE_CLASS,
    fillModelVersion: input.model.fillModelVersion,
    planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
  });
}

/**
 * The gate a deployment decision has to pass a result through.
 *
 * The type parameter refuses `deploymentDecisionUse: "FORBIDDEN"` at COMPILE
 * time; the runtime check catches a value laundered through `any` or built by a
 * future caller that ignores the type. ADR-012 §1: "A Tier 1 result that is
 * quoted as a single number instead of a band has already violated this ADR",
 * and §2 item 4: "'The simulator says it fills' is not a promotion argument."
 */
export function quoteForDeploymentDecision<
  TResult extends { readonly model: FillModelIdentity },
>(
  result: TResult["model"]["deploymentDecisionUse"] extends "FORBIDDEN" ? never : TResult,
): SimulationResult<TResult> {
  const use = result.model.deploymentDecisionUse;
  if (use === "FORBIDDEN") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a Tier-0 pipeline-smoke result may never be quoted in a deployment decision (§12.2, ADR-012 §1)",
      { tier: result.model.tier, permittedUse: result.model.permittedUse },
    );
  }
  return simulationOk(result);
}

// ---------------------------------------------------------------------------
// Depth arithmetic
// ---------------------------------------------------------------------------

/** One matched slice of a ladder walk. */
export interface MatchedLevel {
  readonly price: string;
  readonly shares: string;
}

/** The outcome of consuming a ladder up to a limit price and a size. */
export interface DepthConsumption {
  readonly matched: readonly MatchedLevel[];
  readonly filledShares: string;
  readonly remainingShares: string;
  /** Exact `Σ price × shares` across the matched levels. */
  readonly notional: string;
  /** Levels the walk stopped at because the limit price was crossed. */
  readonly stoppedAtLimit: boolean;
}

/**
 * Walks a ladder best-first, consuming up to `shares` at prices the limit allows.
 *
 * `BUY` consumes the ASK ladder at prices `<= limitPrice`; `SELL` consumes the
 * BID ladder at prices `>= limitPrice`. Every planned order is a capped limit
 * order (WP-190 acceptance 2), so there is no unbounded market-order path here
 * and none can be added without changing the plan contract first.
 */
export function consumeDepth(input: {
  readonly ladder: readonly BookLevelView[];
  readonly action: "BUY" | "SELL";
  readonly limitPrice: string;
  readonly shares: string;
}): SimulationResult<DepthConsumption> {
  const { ladder, action, limitPrice, shares } = input;
  if (!isCanonicalDecimalString(limitPrice) || !isCanonicalDecimalString(shares)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "limitPrice and shares must be canonical decimal strings (§6 invariant 1)",
    );
  }
  if (compareDecimal(shares, "0") <= 0) {
    return simulationFailure("SIMULATION_INPUT_INVALID", "shares must be strictly positive");
  }

  const matched: MatchedLevel[] = [];
  let remaining = shares;
  let notional = "0";
  let stoppedAtLimit = false;
  let previousPrice: string | undefined;

  for (const level of ladder) {
    if (!isCanonicalDecimalString(level.price) || !isCanonicalDecimalString(level.size)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a book level carries a non-canonical decimal; a malformed level is refused rather than skipped",
        { price: String(level.price), size: String(level.size) },
      );
    }
    if (compareDecimal(level.size, "0") <= 0) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a book level carries a non-positive size; an aggregate level of size 0 is a removed level and must not be in the ladder (ADR-013)",
        { price: level.price, size: level.size },
      );
    }
    if (previousPrice !== undefined) {
      const ordered =
        action === "BUY"
          ? compareDecimal(level.price, previousPrice) > 0
          : compareDecimal(level.price, previousPrice) < 0;
      if (!ordered) {
        return simulationFailure(
          "SIMULATION_INPUT_INVALID",
          "the ladder is not strictly best-first; a fill model that consumed an unordered ladder would invent price improvement",
          { price: level.price, previousPrice },
        );
      }
    }
    previousPrice = level.price;

    const withinLimit =
      action === "BUY"
        ? compareDecimal(level.price, limitPrice) <= 0
        : compareDecimal(level.price, limitPrice) >= 0;
    if (!withinLimit) {
      stoppedAtLimit = true;
      break;
    }
    if (compareDecimal(remaining, "0") <= 0) break;

    const take = compareDecimal(level.size, remaining) <= 0 ? level.size : remaining;
    matched.push({ price: level.price, shares: take });
    notional = addDecimal(notional, mulDecimal(level.price, take));
    remaining = subDecimal(remaining, take);
  }

  return simulationOk(
    ownFrozenTree<DepthConsumption>({
      matched,
      filledShares: subDecimal(shares, remaining),
      remainingShares: remaining,
      notional,
      stoppedAtLimit,
    }),
  );
}

/**
 * Converts a simulated fill into the shape `packages/ledger` folds.
 *
 * WP-200's `FillFact` carries four facts a simulator does not have and must not
 * invent: the ledger's own `fillId`, the `accountRef`, and the two asset ids
 * (ADR-006 §7 rule 1 — "there is no implicit 'cash' asset, and USDC/pUSD are
 * never interchangeable"). They are REQUIRED arguments here, so the composition
 * root states them.
 *
 * The `environment` is the RUN MODE (§11), which for anything this package
 * produces is `BACKTEST`, `PAPER` or `SHADOW` — the ledger therefore records the
 * fill under a simulated environment and can never mistake it for a live one.
 */
export function toFillFact(
  fill: SimulatedFill,
  identity: {
    readonly fillId: string;
    readonly environment: SimulatedRunMode;
    readonly accountRef: string;
    readonly tokenAssetId: string;
    readonly denominationAssetId: string;
    readonly source: FillFactView["source"];
    readonly feeScheduleVersionRef?: string;
  },
): FillFactView {
  return ownFrozenTree<FillFactView>({
    fillId: identity.fillId,
    marketId: fill.marketId,
    environment: identity.environment,
    accountRef: identity.accountRef,
    tokenAssetId: identity.tokenAssetId,
    denominationAssetId: identity.denominationAssetId,
    side: fill.action,
    shares: fill.shares,
    price: fill.price,
    feeAmount: fill.feeAmount,
    ...(identity.feeScheduleVersionRef === undefined
      ? {}
      : { feeScheduleVersionRef: identity.feeScheduleVersionRef }),
    source: identity.source,
    occurredAt: fill.atEvent.receivedAt,
  });
}

/**
 * Total size resting at one price on a ladder, exactly. `"0"` when absent.
 *
 * NOTE there is deliberately no VWAP helper in this package. A fill is booked
 * at the exact price of the level it consumed, one fill per level; collapsing a
 * multi-level execution into one averaged price would require a division and a
 * rounding policy, and would hide from the ledger the per-level prices §6
 * invariant 4's traceability chain is supposed to carry.
 */
export function sizeAtPrice(ladder: readonly BookLevelView[], price: string): string {
  let total = "0";
  for (const level of ladder) {
    if (compareDecimal(level.price, price) === 0) total = addDecimal(total, level.size);
  }
  return total;
}
