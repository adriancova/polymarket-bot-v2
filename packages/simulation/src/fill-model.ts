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
 *
 * V2-10 (F-63, F-73): each consumed level is ONE maker fill whose two legs —
 * shares and pUSD — are computed in whole base units by the documented
 * formula (`./base-units.js`), and a FOK/FAK BUY may target pUSD instead of
 * shares. Every fill carries its pUSD leg as `collateralAmount`.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString, mulDecimal, subDecimal } from "@polymarket-bot/decimal";

import { floorToBaseUnits, makerFillForShares, makerSellForBudget } from "./base-units.js";
import { ownFrozenTree, readOwnPlainInput } from "./plain.js";
import type {
  BookLevelView,
  FillFactView,
  PlanningDepthAwareness,
  RecordedEventIdentity,
  SimulatedEvidenceClass,
  SimulatedRunMode,
} from "./ports.js";
import { PLANNING_DEPTH_AWARENESS, SIMULATED_EVIDENCE_CLASS } from "./ports.js";
import { simulationFailure, simulationOk, totally, type SimulationResult } from "./refusals.js";

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
  /**
   * V2-10 (F-63): the pUSD this fill moved, BEFORE any fee — what a BUY paid,
   * what a SELL received — computed in whole base units by the documented
   * formula (`./base-units.js`). It is `price × shares` exactly whenever that
   * is a whole number of base units, and otherwise that value floored: never
   * re-derive it from `price × shares`. The fee is NOT in it: "Reconcile
   * fills and fees separately: BUY fees add to collateral spend; SELL fees
   * are deducted from proceeds" (F-63), which is how the venue's cash applies
   * the two.
   */
  readonly collateralAmount: string;
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
  readonly collateralAmount: string;
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
 *
 * ROUND-1 REVIEW (M7): the Tier-1 half of that rule used to be checked by the
 * `deploymentDecisionUse` STRING alone, so a bare `{ model, filledShares }` —
 * a single number wearing a Tier-1 identity — passed the gate, which is the
 * exact violation ADR-012 §1 names. The check below is now STRUCTURAL: a
 * Tier-1 result must actually BE a band, with all three labelled scenarios
 * present and its band basis and quotation rule intact.
 */
export function quoteForDeploymentDecision<
  TResult extends { readonly model: FillModelIdentity },
>(
  result: TResult["model"]["deploymentDecisionUse"] extends "FORBIDDEN" ? never : TResult,
): SimulationResult<TResult> {
  return totally("quoting a simulated result for a deployment decision", () => {
    // D1 (round-3 review, MEDIUM-1). This is the EVIDENCE GATE, so it is the
    // last door that may check one value and hand back another: it reads the
    // caller's result eleven times (`model`, `deploymentDecisionUse`, and every
    // field `isThreeScenarioBand` inspects), and it used to return the caller's
    // own object. A lying accessor could therefore present a band to the check
    // and a single number to whoever quoted the result — exactly what ADR-012 §1
    // forbids. The checked tree and the quoted tree are now the same frozen one.
    const read = readOwnPlainInput<TResult>(result, "the result being quoted");
    if (!read.ok) return read;
    const quoted = read.value;
    if (quoted === null || typeof quoted !== "object") {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a quotable result must be a record carrying the model that produced it",
      );
    }
    const model: FillModelIdentity | undefined = quoted.model;
    if (model === null || typeof model !== "object") {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a quotable result must name the fill model that produced it (§12.5 pins it per run)",
      );
    }
    if (model.deploymentDecisionUse === "FORBIDDEN") {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a Tier-0 pipeline-smoke result may never be quoted in a deployment decision (§12.2, ADR-012 §1)",
        { tier: String(model.tier), permittedUse: String(model.permittedUse) },
      );
    }
    if (model.tier === "TIER_1" && !isThreeScenarioBand(quoted)) {
      return simulationFailure(
        "FILL_MODEL_BAND_INCONSISTENT",
        "a Tier-1 result quoted for a deployment decision must BE the band: ADR-012 §1 — 'A Tier 1 result that is quoted as a single number instead of a band has already violated this ADR'",
        { tier: String(model.tier), permittedUse: String(model.permittedUse) },
      );
    }
    return simulationOk(ownFrozenTree(quoted));
  });
}

/**
 * Structural recognition of a {@link ../queue.js#RestingFillBand}.
 *
 * Written here rather than imported as a type guard on purpose: this module is
 * below `queue.ts` in the import graph, and what the gate needs is not the
 * nominal type but the OBSERVABLE shape — all three labelled scenarios, each
 * carrying its own filled quantity, plus the band's basis and quotation rule.
 */
function isThreeScenarioBand(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["bandBasis"] !== "OPTIMISTIC_BASE_CONSERVATIVE_CANCELLATION_ASSUMPTIONS") return false;
  if (record["quotationRule"] !== "REPORT_THE_BAND_NEVER_ONE_MEMBER") return false;
  for (const [member, label] of [
    ["optimistic", "OPTIMISTIC"],
    ["base", "BASE"],
    ["conservative", "CONSERVATIVE"],
  ] as const) {
    const scenario = record[member];
    if (scenario === null || typeof scenario !== "object") return false;
    const outcome = scenario as Record<string, unknown>;
    if (outcome["scenario"] !== label) return false;
    if (!isCanonicalDecimalString(outcome["filledShares"])) return false;
    if (!isCanonicalDecimalString(outcome["remainingShares"])) return false;
    if (!isCanonicalDecimalString(outcome["fillsAfterCancelRequest"])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Depth arithmetic
// ---------------------------------------------------------------------------

/** One matched slice of a ladder walk: ONE maker fill (`./base-units.js` inference 1). */
export interface MatchedLevel {
  readonly price: string;
  readonly shares: string;
  /** V2-10: the pUSD this maker fill moved, by F-63, in whole base units. */
  readonly collateral: string;
}

/**
 * What a walk is asked to fill (V2-10; F-63: "CLOB GTC/GTD BUY targets are
 * shares; FOK/FAK BUY targets are collateral").
 *
 * - `SHARES` — every SELL, and a GTC/GTD BUY.
 * - `COLLATERAL` — a FOK/FAK BUY whose composition root adopted the documented
 *   target (`SimulatedVenueOptions.fokFakBuyTarget`). The amount is the pUSD
 *   to spend before fees; the shares follow from the fills.
 */
export type DepthTargetKind = "SHARES" | "COLLATERAL";

/** The outcome of consuming a ladder up to a limit price and a target. */
export interface DepthConsumption {
  readonly matched: readonly MatchedLevel[];
  readonly target: DepthTargetKind;
  readonly filledShares: string;
  /**
   * `SHARES` target: the requested shares minus the filled ones. `COLLATERAL`
   * target: always `"0"` — such a walk has no share remainder, and what it
   * did not spend is {@link remainingCollateral}.
   */
  readonly remainingShares: string;
  /** Exact `Σ price × shares` across the matched levels, before F-63's floor. */
  readonly notional: string;
  /** `Σ collateral` across the matched levels: the pUSD the fills moved (F-63). */
  readonly collateral: string;
  /** The collateral target, or `null` for a `SHARES` target. */
  readonly collateralTarget: string | null;
  /** The collateral target minus what the fills spent, or `null` for a `SHARES` target. */
  readonly remainingCollateral: string | null;
  /** Levels the walk stopped at because the limit price was crossed. */
  readonly stoppedAtLimit: boolean;
  /**
   * `true` when the TARGET ended the walk: it is filled to the last whole base
   * unit F-63 can move at the maker's price. A share target can then still
   * show a sub-base-unit, or a floor-sized, remainder (`./base-units.js`
   * inference 2), and a collateral target an unspent budget under one share's
   * base unit at that price: that remainder is the formula's, never missing
   * liquidity, so the order is complete. `false` when the limit price or the
   * ladder ended it first: the order has a remainder to rest, cancel or reject.
   */
  readonly complete: boolean;
}

/**
 * Walks a ladder best-first, consuming up to a target at prices the limit allows.
 *
 * `BUY` consumes the ASK ladder at prices `<= limitPrice`; `SELL` consumes the
 * BID ladder at prices `>= limitPrice`. Every planned order is a capped limit
 * order (WP-190 acceptance 2), so there is no unbounded market-order path here
 * and none can be added without changing the plan contract first.
 *
 * V2-10: each consumed level is ONE maker fill, computed in whole base units by
 * F-63 (`./base-units.js`): the maker is a SELL on the ask ladder and a BUY on
 * the bid ladder. The target is EITHER `shares` (every SELL; a GTC/GTD BUY) OR
 * `collateral` (a FOK/FAK BUY, BUY only), never both.
 */
export function consumeDepth(
  input: {
    readonly ladder: readonly BookLevelView[];
    readonly action: "BUY" | "SELL";
    readonly limitPrice: string;
  } & (
    | { readonly shares: string; readonly collateral?: undefined }
    | { readonly collateral: string; readonly shares?: undefined }
  ),
): SimulationResult<DepthConsumption> {
  return totally("consuming depth", () => consumeDepthInner(input));
}

function consumeDepthInner(input: {
  readonly ladder: readonly BookLevelView[];
  readonly action: "BUY" | "SELL";
  readonly limitPrice: string;
  readonly shares?: string | undefined;
  readonly collateral?: string | undefined;
}): SimulationResult<DepthConsumption> {
  const { ladder: offeredLadder, action, limitPrice, shares, collateral: collateralTarget } = input;
  // D1 (round-3 review, MEDIUM-1, same class): a ladder is the ANSWER of a
  // `BookView` PORT, but what it hands back is DATA — and the walk below reads
  // each level's `price` six times (validate, order-check, limit-check, record,
  // multiply) and its `size` twice. An accessor level could therefore be
  // validated as one price and BOOKED at another, putting a price no check ever
  // saw into a fill and into the §12.4 bytes. The port is not materialized; its
  // answer is.
  const read = readOwnPlainInput<readonly BookLevelView[]>(offeredLadder, "the ladder");
  if (!read.ok) return read;
  const ladder = read.value;
  if (!Array.isArray(ladder)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a ladder is an array of aggregate levels, best first",
    );
  }
  if (action !== "BUY" && action !== "SELL") {
    return simulationFailure("SIMULATION_INPUT_INVALID", "an order action is BUY or SELL", {
      offered: String(action),
    });
  }
  // V2-10: exactly one target, and a collateral one only for a BUY (F-63: "FOK/FAK
  // BUY targets are collateral"; nothing documents a collateral-targeted SELL).
  const target: DepthTargetKind = collateralTarget === undefined ? "SHARES" : "COLLATERAL";
  if ((shares === undefined) === (collateralTarget === undefined)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a depth walk targets EITHER shares OR collateral, exactly one of them (F-63)",
    );
  }
  if (target === "COLLATERAL" && action !== "BUY") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "only a BUY may target collateral (F-63: \"FOK/FAK BUY targets are collateral\"); a SELL targets shares",
    );
  }
  const amount = target === "SHARES" ? shares : collateralTarget;
  if (!isCanonicalDecimalString(limitPrice) || !isCanonicalDecimalString(amount)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "limitPrice and the target (shares or collateral) must be canonical decimal strings (§6 invariant 1)",
    );
  }
  if (compareDecimal(amount, "0") <= 0) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      target === "SHARES" ? "shares must be strictly positive" : "the collateral target must be strictly positive",
    );
  }
  // V2-10 (F-73): a fill moves whole base units, so a target under one cannot
  // be filled at all — refused, rather than "completed" with nothing filled.
  if (floorToBaseUnits(amount) <= 0n) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the target is under one base unit (F-73: \"`1_000_000` is one pUSD or one share\"), so no fill can move any of it",
      { target, amount },
    );
  }

  const matched: MatchedLevel[] = [];
  let remaining = amount;
  let notional = "0";
  let collateral = "0";
  let filled = "0";
  let stoppedAtLimit = false;
  let targetReached = false;
  let previousPrice: string | undefined;

  for (const level of ladder) {
    if (level === null || typeof level !== "object") {
      return simulationFailure("SIMULATION_INPUT_INVALID", "a book level is not a record");
    }
    // One read per field, from the materialized tree, for the whole walk.
    const price = level.price;
    const size = level.size;
    if (!isCanonicalDecimalString(price) || !isCanonicalDecimalString(size)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a book level carries a non-canonical decimal; a malformed level is refused rather than skipped",
        { price: String(price), size: String(size) },
      );
    }
    if (compareDecimal(size, "0") <= 0) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a book level carries a non-positive size; an aggregate level of size 0 is a removed level and must not be in the ladder (ADR-013)",
        { price, size },
      );
    }
    // V2-10: F-63's counter divides by the maker's amount, which a level at a
    // non-positive price cannot have; and no price is not a price.
    if (compareDecimal(price, "0") <= 0) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a book level carries a non-positive price; a maker fill's counter amount (F-63) is defined only at a strictly positive price",
        { price, size },
      );
    }
    if (previousPrice !== undefined) {
      const ordered =
        action === "BUY"
          ? compareDecimal(price, previousPrice) > 0
          : compareDecimal(price, previousPrice) < 0;
      if (!ordered) {
        return simulationFailure(
          "SIMULATION_INPUT_INVALID",
          "the ladder is not strictly best-first; a fill model that consumed an unordered ladder would invent price improvement",
          { price, previousPrice },
        );
      }
    }
    previousPrice = price;

    const withinLimit =
      action === "BUY"
        ? compareDecimal(price, limitPrice) <= 0
        : compareDecimal(price, limitPrice) >= 0;
    // Checked BEFORE the limit test: an order that is already fully filled did
    // not stop at its limit price, it stopped because it was done. The other
    // order round-1 review probe P6 found reports `stoppedAtLimit` on a complete
    // fill, which reads as "the limit bound this execution" when it did not.
    if (targetReached) break;
    if (!withinLimit) {
      stoppedAtLimit = true;
      break;
    }

    // ONE maker fill per level: a SELL maker on the ask ladder, a BUY maker on
    // the bid ladder (`./base-units.js`).
    let legs: { readonly shares: string; readonly collateral: string };
    if (target === "COLLATERAL") {
      const budgeted = makerSellForBudget(price, remaining, size);
      if (!budgeted.ok) return budgeted;
      legs = budgeted.value;
      // The budget decided this level, or it cannot buy one more base unit of
      // a share at it — and every later ask is dearer, so not there either.
      if (budgeted.value.boundByBudget) targetReached = true;
    } else {
      const boundByTarget = compareDecimal(remaining, size) <= 0;
      const maker = makerFillForShares(action === "BUY" ? "SELL" : "BUY", price, boundByTarget ? remaining : size);
      if (!maker.ok) return maker;
      legs = maker.value;
      if (boundByTarget) targetReached = true;
    }
    if (compareDecimal(legs.shares, "0") > 0) {
      matched.push({ price, shares: legs.shares, collateral: legs.collateral });
      notional = addDecimal(notional, mulDecimal(price, legs.shares));
      collateral = addDecimal(collateral, legs.collateral);
      filled = addDecimal(filled, legs.shares);
      remaining = subDecimal(remaining, target === "SHARES" ? legs.shares : legs.collateral);
    }
    // Done once what is left of the target is under one base unit (F-73): no
    // fill could move it, whatever depth followed.
    if (floorToBaseUnits(remaining) <= 0n) targetReached = true;
  }

  return simulationOk(
    ownFrozenTree<DepthConsumption>({
      matched,
      target,
      filledShares: filled,
      remainingShares: target === "SHARES" ? remaining : "0",
      notional,
      collateral,
      collateralTarget: target === "COLLATERAL" ? amount : null,
      remainingCollateral: target === "COLLATERAL" ? remaining : null,
      stoppedAtLimit,
      complete: targetReached,
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
export function sizeAtPrice(
  offeredLadder: readonly BookLevelView[],
  price: string,
): SimulationResult<string> {
  // D1, for the same reason as `consumeDepth` (round-3 review, MEDIUM-1): the
  // port's ANSWER is data and each level is read twice below.
  const read = readOwnPlainInput<readonly BookLevelView[]>(offeredLadder, "the ladder");
  if (!read.ok) return read;
  const ladder = read.value;
  // `compareDecimal` THROWS on a value that is not a canonical decimal string,
  // so a door that documents typed refusals validates first (ADR-020 §6's "no
  // throw escapes"; the same class the round-1 review found here).
  if (!Array.isArray(ladder)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a ladder is an array of aggregate levels",
    );
  }
  if (!isCanonicalDecimalString(price)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a price must be a canonical decimal string (§6 invariant 1)",
      { offered: String(price) },
    );
  }
  let total = "0";
  for (const level of ladder) {
    if (level === null || typeof level !== "object") {
      return simulationFailure("SIMULATION_INPUT_INVALID", "a book level is not a record");
    }
    const levelPrice = level.price;
    const levelSize = level.size;
    if (!isCanonicalDecimalString(levelPrice) || !isCanonicalDecimalString(levelSize)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a book level carries a non-canonical decimal; a malformed level is refused rather than skipped",
        { price: String(levelPrice), size: String(levelSize) },
      );
    }
    if (compareDecimal(levelPrice, price) === 0) total = addDecimal(total, levelSize);
  }
  return simulationOk(total);
}
