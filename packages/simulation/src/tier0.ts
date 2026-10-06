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

import { compareDecimal, isCanonicalDecimalString, subDecimal } from "@polymarket-bot/decimal";

import { makerFillForShares } from "./base-units.js";
import { computeFee, type FeeScheduleSnapshot } from "./fees.js";
import {
  consumeDepth,
  simulatedFill,
  type DepthConsumption,
  type FillModelIdentity,
  type SimulatedFill,
} from "./fill-model.js";
import { ownFrozenTree, readOwnPlainInput } from "./plain.js";
import type { BookView, RecordedEventIdentity } from "./ports.js";
import { describeForRefusal, simulationFailure, simulationOk, totally, type SimulationResult } from "./refusals.js";

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
   * `false` whenever the order has a remainder — the limit price or the
   * ladder ended the walk before its target did — so the caller applies the
   * plan's partial-fill policy rather than assuming completion (§6 invariant
   * 10). V2-10: it is the walk's {@link DepthConsumption.complete}, not
   * `remainingShares === "0"`: a share target can end with a remainder F-63's
   * floor leaves, and a collateral target has no share remainder at all.
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
  /**
   * V2-10 (F-63: "FOK/FAK BUY targets are collateral"): when present, the
   * order is a BUY that spends up to this much pUSD before fees, and its
   * shares follow from the fills; `shares` is then the planned size the
   * target was converted from (`collateralTargetAtLimitPrice`), kept for the
   * order's record and not matched. Absent: the order targets `shares`.
   */
  readonly collateralTarget?: string;
  readonly feeSnapshot: FeeScheduleSnapshot;
  readonly atEvent: RecordedEventIdentity;
}): SimulationResult<Tier0ImmediateOutcome> {
  return totally("executing a Tier-0 immediate order", () => tier0ImmediateInner(input));
}

function tier0ImmediateInner(input: {
  readonly model: FillModelIdentity;
  readonly book: BookView;
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly limitPrice: string;
  readonly shares: string;
  readonly collateralTarget?: string;
  readonly feeSnapshot: FeeScheduleSnapshot;
  readonly atEvent: RecordedEventIdentity;
}): SimulationResult<Tier0ImmediateOutcome> {
  // D1 FIRST, AND ONE READ PER FIELD (round-3 review, MEDIUM-1). `model` and
  // `atEvent` are CALLER RECORDS that this door copies onto every fill it emits
  // and onto its outcome. Before the fix they went straight to D4's copier,
  // which refuses an accessor without invoking it but does so by THROWING — so
  // a hostile model was contained as `SIMULATION_INTERNAL`, blaming this
  // package for the caller's argument instead of naming it.
  //
  // `book` is a PORT, not data: its contract is `ladder()` / `tokenId`, and
  // materializing it would delete the methods. What it HANDS BACK is data, and
  // `consumeDepth` materializes that.
  const { model: offeredModel, atEvent: offeredAtEvent, book, action, side } = input;
  const { simulatedOrderId, marketId, limitPrice, shares, collateralTarget, feeSnapshot } = input;

  const readModel = readOwnPlainInput<FillModelIdentity>(offeredModel, "the fill model identity");
  if (!readModel.ok) return readModel;
  const model = readModel.value;
  const readAtEvent = readOwnPlainInput<RecordedEventIdentity>(
    offeredAtEvent,
    "the recorded event identity",
  );
  if (!readAtEvent.ok) return readAtEvent;
  const atEvent = readAtEvent.value;

  if (typeof book !== "object" || book === null || typeof book.ladder !== "function") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a Tier-0 immediate execution consumes an observed book; the BookView port must supply one",
    );
  }
  const tokenId = book.tokenId;
  const ladder = book.ladder(action === "BUY" ? "ASK" : "BID");
  const consumed =
    collateralTarget === undefined
      ? consumeDepth({ ladder, action, limitPrice, shares })
      : consumeDepth({ ladder, action, limitPrice, collateral: collateralTarget });
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
      snapshot: feeSnapshot,
    });
    if (!fee.ok) return fee;
    fills.push(
      simulatedFill({
        simulatedFillId: `${simulatedOrderId}/t0/${String(index)}`,
        simulatedOrderId,
        marketId,
        tokenId,
        side,
        action,
        price: level.price,
        shares: level.shares,
        collateralAmount: level.collateral,
        feeAmount: fee.value.feeAmount,
        liquidityRole: "TAKER",
        model,
        atEvent,
      }),
    );
  }

  return simulationOk(
    ownFrozenTree<Tier0ImmediateOutcome>({
      model,
      fills,
      filledShares: consumption.filledShares,
      remainingShares: consumption.remainingShares,
      consumption,
      complete: consumption.complete,
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
  return totally("executing a Tier-0 maker order", () => tier0MakerInner(input));
}

function tier0MakerInner(input: {
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
  // The same D1 + one-read-per-field shape as `tier0Immediate` above, for the
  // same two caller records and the same reason (round-3 review, MEDIUM-1: the
  // rule is the door's, not one door's).
  const { model: offeredModel, atEvent: offeredAtEvent, action, side } = input;
  const { simulatedOrderId, marketId, tokenId, restingPrice, remainingShares } = input;
  const { observedTradePrice, feeSnapshot } = input;

  const readModel = readOwnPlainInput<FillModelIdentity>(offeredModel, "the fill model identity");
  if (!readModel.ok) return readModel;
  const model = readModel.value;
  const readAtEvent = readOwnPlainInput<RecordedEventIdentity>(
    offeredAtEvent,
    "the recorded event identity",
  );
  if (!readAtEvent.ok) return readAtEvent;
  const atEvent = readAtEvent.value;
  if (atEvent === null || typeof atEvent !== "object") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a simulated fill is anchored to a recorded event identity (§7.1)",
    );
  }

  // Validated BEFORE any arithmetic: `compareDecimal` THROWS on a non-canonical
  // decimal, and a door that documents typed refusals may not leak an exception
  // (ADR-020 §6's "no throw escapes"). Found by this package's own suite.
  for (const value of [restingPrice, observedTradePrice, remainingShares]) {
    if (!isCanonicalDecimalString(value)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "maker-fill inputs must be canonical decimal strings (§6 invariant 1)",
        { offered: String(value) },
      );
    }
  }
  if (action !== "BUY" && action !== "SELL") {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a resting order's action is BUY or SELL", {
      offered: describeForRefusal(action),
    });
  }
  // V2-10: the maker's signed ratio is its price, and F-63's counter divides
  // by the maker's amount: a non-positive resting price has neither (the same
  // bound `simulateResting` enforces at its own door).
  if (compareDecimal(restingPrice, "0") <= 0) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a resting order's price is strictly positive; a maker fill's counter amount (F-63) is defined only at a strictly positive price",
      { restingPrice },
    );
  }
  const comparison = compareDecimal(observedTradePrice, restingPrice);
  // A resting BUY sits on the bid: a trade at or BELOW its price consumed it.
  // A resting SELL sits on the ask: a trade at or ABOVE its price consumed it.
  const throughIt = action === "BUY" ? comparison < 0 : comparison > 0;
  const trigger: "TOUCH" | "TRADE_THROUGH" | "NONE" =
    comparison === 0 ? "TOUCH" : throughIt ? "TRADE_THROUGH" : "NONE";

  // V2-10: the resting order IS the maker, signed at its limit price, so the
  // fill's legs are F-63's (`./base-units.js`): a resting SELL's shares fill
  // whole and its pUSD is floored; a resting BUY's pUSD is what the shares are
  // worth, floored, and its shares are the formula's counter of that.
  const legs =
    trigger === "NONE" || compareDecimal(remainingShares, "0") <= 0
      ? undefined
      : makerFillForShares(action, restingPrice, remainingShares);
  if (legs !== undefined && !legs.ok) return legs;
  if (legs === undefined || compareDecimal(legs.value.shares, "0") <= 0) {
    // Nothing fills: no trigger, nothing left, or a remainder under one base
    // unit (F-73) — which no fill can move.
    return simulationOk(
      ownFrozenTree<Tier0MakerOutcome>({
        model,
        fills: [],
        filledShares: "0",
        remainingShares,
        trigger: "NONE",
      }),
    );
  }
  const filledShares = legs.value.shares;

  const fee = computeFee({
    shares: filledShares,
    price: restingPrice,
    // ADR-012 §5.4 / venue report §6: "Makers pay no fees; only takers pay."
    // The rate still comes from the snapshot, so a future snapshot with a
    // nonzero maker rate simulates correctly with no edit here.
    liquidityRole: "MAKER",
    snapshot: feeSnapshot,
  });
  if (!fee.ok) return fee;

  return simulationOk(
    ownFrozenTree<Tier0MakerOutcome>({
      model,
      fills: [
        simulatedFill({
          simulatedFillId: `${simulatedOrderId}/t0m/${String(atEvent.ingestSeq)}`,
          simulatedOrderId,
          marketId,
          tokenId,
          side,
          action,
          price: restingPrice,
          shares: filledShares,
          collateralAmount: legs.value.collateral,
          feeAmount: fee.value.feeAmount,
          liquidityRole: "MAKER",
          model,
          atEvent,
        }),
      ],
      filledShares,
      // `"0"` whenever the remainder is a whole number of base units whose
      // value at the limit is too (every CLOB-sized order); otherwise the part
      // F-63's floor could not move. Tier 0 grants the whole remainder, so the
      // venue holds no record of that part (`venue.ts`).
      remainingShares: subDecimal(remainingShares, filledShares),
      trigger,
    }),
  );
}
