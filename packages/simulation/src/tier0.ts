/**
 * Tier 0 — the pipeline smoke model (§12.2).
 *
 * Verbatim from §12.2:
 *
 * > - Immediate orders consume the observed top/depth without latency.
 * > - Maker orders fill on touch/trade-through.
 * > - **Never used for deployment decisions.**
 *
 * That last line is the whole point of this file's shape. Every value it
 * produces carries `permittedUse: "WIRING_AND_REGRESSION_ONLY"` and
 * `deploymentDecisionUse: "FORBIDDEN"`, and
 * {@link ../fill-model.js#quoteForDeploymentDecision} refuses such a value at
 * COMPILE time. There is no option, flag, or parameter on this model that turns
 * that off — ADR-012 §1 fixes the permitted use per tier, so it is not a
 * caller's decision.
 *
 * Tier 0 exists to prove the pipeline moves an intent to a fill to a ledger
 * posting. It models no latency, no queue, and no cancellation, and it will
 * therefore report fills a real venue would not give. That is not a defect; it
 * is the model's definition, and it is why its use is bounded.
 */

import { compareDecimal, isCanonicalDecimalString } from "@polymarket-bot/decimal";

import { computeFee, type FeeScheduleSnapshot } from "./fees.js";
import {
  consumeDepth,
  simulatedFill,
  type DepthConsumption,
  type FillModelIdentity,
  type SimulatedFill,
} from "./fill-model.js";
import { ownFrozenTree } from "./plain.js";
import type { BookView, RecordedEventIdentity } from "./ports.js";
import { simulationFailure, simulationOk, type SimulationResult } from "./refusals.js";

/** The identity every Tier-0 result carries. */
export function tier0Model(input: {
  readonly fillModelVersion: string;
  readonly fillModelParametersHash: string;
}): FillModelIdentity {
  return ownFrozenTree<FillModelIdentity>({
    tier: "TIER_0",
    fillModelVersion: input.fillModelVersion,
    fillModelParametersHash: input.fillModelParametersHash,
    permittedUse: "WIRING_AND_REGRESSION_ONLY",
    deploymentDecisionUse: "FORBIDDEN",
    calibration: "UNCALIBRATED_NO_PROBE_DATA_EXISTS",
  });
}

/** What a Tier-0 immediate execution produced. */
export interface Tier0ImmediateOutcome {
  readonly model: FillModelIdentity;
  readonly fills: readonly SimulatedFill[];
  readonly filledShares: string;
  readonly remainingShares: string;
  readonly consumption: DepthConsumption;
  /**
   * `false` whenever any size remains, so the caller applies the plan's
   * partial-fill policy rather than assuming completion (§6 invariant 10).
   */
  readonly complete: boolean;
}

/**
 * An immediate order consumes the observed top/depth with no latency.
 *
 * One fill per consumed level, at that level's exact price: §6 invariant 4's
 * traceability chain records what was actually consumed, and an averaged price
 * would hide it.
 */
export function tier0Immediate(input: {
  readonly model: FillModelIdentity;
  readonly book: BookView;
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly limitPrice: string;
  readonly shares: string;
  readonly feeSnapshot: FeeScheduleSnapshot;
  readonly atEvent: RecordedEventIdentity;
}): SimulationResult<Tier0ImmediateOutcome> {
  const ladder = input.book.ladder(input.action === "BUY" ? "ASK" : "BID");
  const consumed = consumeDepth({
    ladder,
    action: input.action,
    limitPrice: input.limitPrice,
    shares: input.shares,
  });
  if (!consumed.ok) return consumed;
  const consumption = consumed.value;

  const fills: SimulatedFill[] = [];
  for (let index = 0; index < consumption.matched.length; index += 1) {
    const level = consumption.matched[index];
    /* c8 ignore next */
    if (level === undefined) continue;
    const fee = computeFee({
      shares: level.shares,
      price: level.price,
      // §12.2 Tier 0 immediate orders cross the spread, so they are TAKER fills.
      // ADR-012 §5.4: makers pay no fees; the role is recorded, never assumed.
      liquidityRole: "TAKER",
      snapshot: input.feeSnapshot,
    });
    if (!fee.ok) return fee;
    fills.push(
      simulatedFill({
        simulatedFillId: `${input.simulatedOrderId}/t0/${String(index)}`,
        simulatedOrderId: input.simulatedOrderId,
        marketId: input.marketId,
        tokenId: input.book.tokenId,
        side: input.side,
        action: input.action,
        price: level.price,
        shares: level.shares,
        feeAmount: fee.value.feeAmount,
        liquidityRole: "TAKER",
        model: input.model,
        atEvent: input.atEvent,
      }),
    );
  }

  return simulationOk(
    ownFrozenTree<Tier0ImmediateOutcome>({
      model: input.model,
      fills,
      filledShares: consumption.filledShares,
      remainingShares: consumption.remainingShares,
      consumption,
      complete: compareDecimal(consumption.remainingShares, "0") === 0,
    }),
  );
}

/** What a Tier-0 maker order did against one observed event. */
export interface Tier0MakerOutcome {
  readonly model: FillModelIdentity;
  readonly fills: readonly SimulatedFill[];
  readonly filledShares: string;
  readonly remainingShares: string;
  /** Why the maker order filled, so a reader is not left inferring it. */
  readonly trigger: "TOUCH" | "TRADE_THROUGH" | "NONE";
}

/**
 * A maker order fills "on touch/trade-through" (§12.2).
 *
 * TOUCH: an observed trade printed AT the resting price.
 * TRADE_THROUGH: an observed trade printed THROUGH it (better for the taker,
 * so the resting order must have been consumed on the way).
 *
 * Tier 0 grants the whole remaining size on either trigger — no queue position,
 * no partial. That is exactly the optimism §12.2 bounds to wiring and
 * regression use, and it is why {@link ../queue.js} exists for Tier 1.
 */
export function tier0Maker(input: {
  readonly model: FillModelIdentity;
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly restingPrice: string;
  readonly remainingShares: string;
  readonly observedTradePrice: string;
  readonly feeSnapshot: FeeScheduleSnapshot;
  readonly atEvent: RecordedEventIdentity;
}): SimulationResult<Tier0MakerOutcome> {
  // Validated BEFORE any arithmetic: `compareDecimal` THROWS on a non-canonical
  // decimal, and a door that documents typed refusals may not leak an exception
  // (ADR-020 §6's "no throw escapes"). Found by this package's own suite.
  for (const value of [input.restingPrice, input.observedTradePrice, input.remainingShares]) {
    if (!isCanonicalDecimalString(value)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "maker-fill inputs must be canonical decimal strings (§6 invariant 1)",
        { offered: String(value) },
      );
    }
  }
  const comparison = compareDecimal(input.observedTradePrice, input.restingPrice);
  // A resting BUY sits on the bid: a trade at or BELOW its price consumed it.
  // A resting SELL sits on the ask: a trade at or ABOVE its price consumed it.
  const throughIt = input.action === "BUY" ? comparison < 0 : comparison > 0;
  const trigger: "TOUCH" | "TRADE_THROUGH" | "NONE" =
    comparison === 0 ? "TOUCH" : throughIt ? "TRADE_THROUGH" : "NONE";

  if (trigger === "NONE" || compareDecimal(input.remainingShares, "0") <= 0) {
    return simulationOk(
      ownFrozenTree<Tier0MakerOutcome>({
        model: input.model,
        fills: [],
        filledShares: "0",
        remainingShares: input.remainingShares,
        trigger: "NONE",
      }),
    );
  }

  const fee = computeFee({
    shares: input.remainingShares,
    price: input.restingPrice,
    // ADR-012 §5.4 / venue report §6: "Makers pay no fees; only takers pay."
    // The rate still comes from the snapshot, so a future snapshot with a
    // nonzero maker rate simulates correctly with no edit here.
    liquidityRole: "MAKER",
    snapshot: input.feeSnapshot,
  });
  if (!fee.ok) return fee;

  return simulationOk(
    ownFrozenTree<Tier0MakerOutcome>({
      model: input.model,
      fills: [
        simulatedFill({
          simulatedFillId: `${input.simulatedOrderId}/t0m/${input.atEvent.ingestSeq}`,
          simulatedOrderId: input.simulatedOrderId,
          marketId: input.marketId,
          tokenId: input.tokenId,
          side: input.side,
          action: input.action,
          price: input.restingPrice,
          shares: input.remainingShares,
          feeAmount: fee.value.feeAmount,
          liquidityRole: "MAKER",
          model: input.model,
          atEvent: input.atEvent,
        }),
      ],
      filledShares: input.remainingShares,
      remainingShares: "0",
      trigger,
    }),
  );
}
