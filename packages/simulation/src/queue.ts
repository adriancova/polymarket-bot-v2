/**
 * Tier-1 resting orders: queue-ahead estimation and the optimistic / base /
 * conservative BAND (§12.2, ADR-012 §1, work-plan `WP-210` deliverable 4).
 *
 * §12.2, resting orders under Tier 1, verbatim:
 *
 * > - Estimate quantity ahead at placement.
 * > - Decrement according to observed trades.
 * > - Apply optimistic/base/conservative cancellation assumptions.
 * > - **Report a result band, not one falsely precise fill result.**
 *
 * ADR-012 §1 sharpens the last line into a rule: "A Tier 1 result that is quoted
 * as a single number instead of a band has already violated this ADR."
 *
 * ## The band is the return type, not a convention
 *
 * {@link simulateResting} returns a {@link RestingFillBand}. There is no
 * function in this package that returns a single resting fill, and there is no
 * `collapse()`/`pointEstimate()` helper: a caller that wants one number has to
 * write the collapse itself, in its own code, where a reviewer can see it.
 *
 * ## Queue-ahead is built from recorded facts only
 *
 * ADR-012 §5.9: "Queue-position estimates must be built from ingest order, venue
 * timestamps, and venue-provided hashes only" — §9.4's "the implementation must
 * not invent a venue sequence number". Here, quantity ahead at placement is the
 * AGGREGATE SIZE observed at the resting price in the book at that instant
 * (ADR-013: `price_change.size` is absolute), and it is decremented only by
 * OBSERVED trades. No venue ordinal, no arrival-time model, no priority
 * heuristic.
 *
 * ## What the three scenarios are, and why the parameters must be ordered
 *
 * Each scenario is a stated assumption about how much of the queue ahead
 * disappears to CANCELLATION alongside the trading that is actually observed,
 * and about how quickly OUR OWN cancel takes effect:
 *
 * | | queue-ahead attrition | our cancel takes effect | placed behind same-price additions |
 * | --- | --- | --- | --- |
 * | `OPTIMISTIC` | fastest | soonest | no |
 * | `BASE` | middling | middling | no |
 * | `CONSERVATIVE` | slowest | latest | yes |
 *
 * {@link readQueueModelParameters} REFUSES parameters that are not ordered that
 * way, which is what makes the band's own ordering a derivable property rather
 * than a coincidence — and {@link checkBandOrdering} then asserts it on the
 * result.
 *
 * ADR-012 §7: no execution probe or live-micro observation exists, so none of
 * these numbers is measured. The model records that on its face.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString, mulDecimal, subDecimal } from "@polymarket-bot/decimal";

import { computeFee, type FeeScheduleSnapshot } from "./fees.js";
import { simulatedFill, type FillModelIdentity, type SimulatedFill } from "./fill-model.js";
import { isNonEmptyString, isNonNegativeInteger } from "./grammar.js";
import { ownFrozenTree } from "./plain.js";
import type { RecordedEventIdentity } from "./ports.js";
import { simulationFailure, simulationOk, type SimulationResult } from "./refusals.js";

/** The three §12.2 scenarios. There is no fourth and no "point estimate". */
export const QUEUE_SCENARIOS = ["OPTIMISTIC", "BASE", "CONSERVATIVE"] as const;
export type QueueScenario = (typeof QUEUE_SCENARIOS)[number];

/** Per-scenario assumptions. Every value is caller-supplied and pinned per run. */
export interface QueueModelParameters {
  readonly queueModelVersion: string;
  /**
   * Shares of queue ahead assumed to CANCEL per share actually traded at the
   * price, as an exact decimal ratio. `"0"` means "credit no cancellation".
   */
  readonly cancellationRatio: Readonly<Record<QueueScenario, string>>;
  /** How long after a cancel request our own cancel is assumed to take effect. */
  readonly cancelEffectiveAfterMs: Readonly<Record<QueueScenario, number>>;
  /**
   * Whether size added at our price in the same recorded instant as placement is
   * assumed to sit AHEAD of us. Conservative says yes; the others say no.
   */
  readonly placedBehindSameInstantAdditions: Readonly<Record<QueueScenario, boolean>>;
  readonly basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS";
}

/** Validates the parameters, including the ordering the band's meaning rests on. */
export function readQueueModelParameters(
  parameters: QueueModelParameters,
): SimulationResult<QueueModelParameters> {
  if (!isNonEmptyString(parameters.queueModelVersion)) {
    return simulationFailure(
      "FILL_MODEL_PARAMETERS_UNPINNED",
      "the queue model must name its version; §12.5 pins the fill-model parameters per run",
    );
  }
  if (parameters.basis !== "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS") {
    return simulationFailure(
      "FILL_MODEL_PARAMETERS_UNPINNED",
      "the queue model must state its basis; ADR-012 §7 records that no probe or live-micro observation exists to fit one",
    );
  }
  for (const scenario of QUEUE_SCENARIOS) {
    const ratio = parameters.cancellationRatio[scenario];
    if (!isCanonicalDecimalString(ratio) || compareDecimal(ratio, "0") < 0) {
      return simulationFailure(
        "FILL_MODEL_PARAMETERS_UNPINNED",
        `cancellationRatio.${scenario} must be a non-negative canonical decimal string`,
        { scenario },
      );
    }
    const delay = parameters.cancelEffectiveAfterMs[scenario];
    if (!isNonNegativeInteger(delay)) {
      return simulationFailure(
        "FILL_MODEL_PARAMETERS_UNPINNED",
        `cancelEffectiveAfterMs.${scenario} must be a non-negative integer number of milliseconds`,
        { scenario },
      );
    }
    if (typeof parameters.placedBehindSameInstantAdditions[scenario] !== "boolean") {
      return simulationFailure(
        "FILL_MODEL_PARAMETERS_UNPINNED",
        `placedBehindSameInstantAdditions.${scenario} must be a boolean`,
        { scenario },
      );
    }
  }
  if (
    compareDecimal(parameters.cancellationRatio.OPTIMISTIC, parameters.cancellationRatio.BASE) < 0 ||
    compareDecimal(parameters.cancellationRatio.BASE, parameters.cancellationRatio.CONSERVATIVE) < 0
  ) {
    return simulationFailure(
      "FILL_MODEL_PARAMETERS_UNPINNED",
      "cancellationRatio must be ordered OPTIMISTIC >= BASE >= CONSERVATIVE; otherwise the band's own ordering is a coincidence rather than a property",
    );
  }
  if (
    parameters.cancelEffectiveAfterMs.OPTIMISTIC > parameters.cancelEffectiveAfterMs.BASE ||
    parameters.cancelEffectiveAfterMs.BASE > parameters.cancelEffectiveAfterMs.CONSERVATIVE
  ) {
    return simulationFailure(
      "FILL_MODEL_PARAMETERS_UNPINNED",
      "cancelEffectiveAfterMs must be ordered OPTIMISTIC <= BASE <= CONSERVATIVE: a conservative world is the one where a safety cancel lands latest",
    );
  }
  if (
    parameters.placedBehindSameInstantAdditions.OPTIMISTIC ||
    parameters.placedBehindSameInstantAdditions.BASE
  ) {
    return simulationFailure(
      "FILL_MODEL_PARAMETERS_UNPINNED",
      "only the CONSERVATIVE scenario may assume placement behind same-instant additions; assuming it in the optimistic scenario inverts the band",
    );
  }
  return simulationOk(ownFrozenTree(parameters));
}

/** One observed trade at or through the resting price. */
export interface ObservedTrade {
  readonly price: string;
  readonly shares: string;
  /** Recorded monotonic nanoseconds of the event that carried it (§7.1). */
  readonly monotonicNs: bigint;
  readonly atEvent: RecordedEventIdentity;
}

/** The resting order being simulated. */
export interface RestingOrderInput {
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly restingPrice: string;
  readonly shares: string;
  /** Aggregate size observed AT the resting price when the order was placed. */
  readonly queueAheadAtPlacement: string;
  /** Size added at the resting price in the same recorded instant as placement. */
  readonly sameInstantAdditionsShares: string;
  /** Recorded monotonic instant the order rested at. */
  readonly restingFromNs: bigint;
  /** Recorded monotonic instant a cancel was requested, when one was. */
  readonly cancelRequestedAtNs?: bigint;
}

/** One scenario's outcome. Never reported alone; see {@link RestingFillBand}. */
export interface RestingScenarioOutcome {
  readonly scenario: QueueScenario;
  readonly filledShares: string;
  readonly remainingShares: string;
  readonly queueAheadAtPlacement: string;
  readonly queueAheadRemaining: string;
  /** Shares filled AFTER a cancel was requested. Adverse; monotone the other way. */
  readonly fillsAfterCancelRequest: string;
  readonly cancelEffectiveAtNs: string | null;
  readonly fills: readonly SimulatedFill[];
}

/**
 * The Tier-1 resting result. A BAND, always (§12.2, ADR-012 §1).
 */
export interface RestingFillBand {
  readonly model: FillModelIdentity;
  readonly queueModelVersion: string;
  readonly optimistic: RestingScenarioOutcome;
  readonly base: RestingScenarioOutcome;
  readonly conservative: RestingScenarioOutcome;
  readonly bandBasis: "OPTIMISTIC_BASE_CONSERVATIVE_CANCELLATION_ASSUMPTIONS";
  /**
   * Restates ADR-012 §1 on the value itself, so a report that prints one member
   * of the band without the others is visibly doing so.
   */
  readonly quotationRule: "REPORT_THE_BAND_NEVER_ONE_MEMBER";
}

/** Runs all three scenarios and returns the band. */
export function simulateResting(input: {
  readonly model: FillModelIdentity;
  readonly order: RestingOrderInput;
  readonly trades: readonly ObservedTrade[];
  readonly parameters: QueueModelParameters;
  readonly feeSnapshot: FeeScheduleSnapshot;
}): SimulationResult<RestingFillBand> {
  const parameters = readQueueModelParameters(input.parameters);
  if (!parameters.ok) return parameters;
  if (input.model.tier !== "TIER_1") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the resting queue model is Tier 1; a Tier-0 identity would mislabel a queue-estimated result as pipeline smoke",
      { tier: input.model.tier },
    );
  }
  for (const value of [
    input.order.restingPrice,
    input.order.shares,
    input.order.queueAheadAtPlacement,
    input.order.sameInstantAdditionsShares,
  ]) {
    if (!isCanonicalDecimalString(value)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "resting-order quantities must be canonical decimal strings (§6 invariant 1)",
      );
    }
  }

  const outcomes: Partial<Record<QueueScenario, RestingScenarioOutcome>> = {};
  for (const scenario of QUEUE_SCENARIOS) {
    const outcome = runScenario({
      scenario,
      model: input.model,
      order: input.order,
      trades: input.trades,
      parameters: parameters.value,
      feeSnapshot: input.feeSnapshot,
    });
    if (!outcome.ok) return outcome;
    outcomes[scenario] = outcome.value;
  }

  const optimistic = outcomes.OPTIMISTIC;
  const base = outcomes.BASE;
  const conservative = outcomes.CONSERVATIVE;
  /* c8 ignore next 3 -- every scenario was assigned in the loop above. */
  if (optimistic === undefined || base === undefined || conservative === undefined) {
    return simulationFailure("SIMULATION_INTERNAL", "a queue scenario produced no outcome");
  }

  const band = ownFrozenTree<RestingFillBand>({
    model: input.model,
    queueModelVersion: parameters.value.queueModelVersion,
    optimistic,
    base,
    conservative,
    bandBasis: "OPTIMISTIC_BASE_CONSERVATIVE_CANCELLATION_ASSUMPTIONS",
    quotationRule: "REPORT_THE_BAND_NEVER_ONE_MEMBER",
  });
  const ordering = checkBandOrdering(band);
  if (!ordering.ok) return ordering;
  return simulationOk(band);
}

/**
 * Asserts the band's own ordering.
 *
 * A band whose "optimistic" member fills less than its "conservative" one is not
 * a band; it is three numbers with misleading names. This is checked on the
 * RESULT as well as being made derivable from the parameters, because the two
 * checks fail for different reasons.
 */
export function checkBandOrdering(band: RestingFillBand): SimulationResult<RestingFillBand> {
  // The band has TWO axes and they point in opposite directions, so the check
  // is stated per axis rather than on the total:
  //
  //   * fills BEFORE a cancel is requested are the thing a resting order wants,
  //     so more of them is the optimistic world: OPTIMISTIC >= BASE >= CONSERVATIVE;
  //   * fills AFTER a cancel is requested are adverse — the cancel was supposed
  //     to stop them — so fewer of them is the optimistic world, and the order
  //     inverts: OPTIMISTIC <= BASE <= CONSERVATIVE.
  //
  // Checking the TOTAL would fail on a correctly-modelled cancel, because a
  // conservative world's slower cancel produces MORE total fills. That is a real
  // property of the model, not a defect, and it is exactly why the two axes are
  // reported separately.
  const preCancel = (outcome: RestingScenarioOutcome): string =>
    subDecimal(outcome.filledShares, outcome.fillsAfterCancelRequest);
  if (
    compareDecimal(preCancel(band.optimistic), preCancel(band.base)) < 0 ||
    compareDecimal(preCancel(band.base), preCancel(band.conservative)) < 0
  ) {
    return simulationFailure(
      "FILL_MODEL_BAND_INCONSISTENT",
      "the band is not ordered: fills before a cancel must satisfy OPTIMISTIC >= BASE >= CONSERVATIVE",
      {
        optimistic: preCancel(band.optimistic),
        base: preCancel(band.base),
        conservative: preCancel(band.conservative),
      },
    );
  }
  if (
    compareDecimal(band.optimistic.fillsAfterCancelRequest, band.base.fillsAfterCancelRequest) > 0 ||
    compareDecimal(band.base.fillsAfterCancelRequest, band.conservative.fillsAfterCancelRequest) > 0
  ) {
    return simulationFailure(
      "FILL_MODEL_BAND_INCONSISTENT",
      "the band is not ordered on post-cancel fills: an adverse quantity must satisfy OPTIMISTIC <= BASE <= CONSERVATIVE",
      {
        optimistic: band.optimistic.fillsAfterCancelRequest,
        base: band.base.fillsAfterCancelRequest,
        conservative: band.conservative.fillsAfterCancelRequest,
      },
    );
  }
  return simulationOk(band);
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function runScenario(input: {
  readonly scenario: QueueScenario;
  readonly model: FillModelIdentity;
  readonly order: RestingOrderInput;
  readonly trades: readonly ObservedTrade[];
  readonly parameters: QueueModelParameters;
  readonly feeSnapshot: FeeScheduleSnapshot;
}): SimulationResult<RestingScenarioOutcome> {
  const { scenario, order, parameters } = input;
  const ratio = parameters.cancellationRatio[scenario];
  const behind = parameters.placedBehindSameInstantAdditions[scenario];

  const queueAheadAtPlacement = behind
    ? addDecimal(order.queueAheadAtPlacement, order.sameInstantAdditionsShares)
    : order.queueAheadAtPlacement;

  const cancelEffectiveAtNs =
    order.cancelRequestedAtNs === undefined
      ? null
      : order.cancelRequestedAtNs +
        BigInt(parameters.cancelEffectiveAfterMs[scenario]) * NANOSECONDS_PER_MILLISECOND;

  let queueAhead = queueAheadAtPlacement;
  let remaining = order.shares;
  let filled = "0";
  let fillsAfterCancel = "0";
  const fills: SimulatedFill[] = [];

  for (let index = 0; index < input.trades.length; index += 1) {
    const trade = input.trades[index];
    /* c8 ignore next */
    if (trade === undefined) continue;
    if (trade.monotonicNs < order.restingFromNs) continue;
    if (cancelEffectiveAtNs !== null && trade.monotonicNs >= cancelEffectiveAtNs) break;
    if (compareDecimal(remaining, "0") <= 0) break;
    if (!isCanonicalDecimalString(trade.price) || !isCanonicalDecimalString(trade.shares)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade carries a non-canonical decimal",
        { price: String(trade.price), shares: String(trade.shares) },
      );
    }

    const comparison = compareDecimal(trade.price, order.restingPrice);
    // A resting BUY sits on the bid: a trade BELOW its price traded through it.
    // A resting SELL sits on the ask: a trade ABOVE its price traded through it.
    const through = order.action === "BUY" ? comparison < 0 : comparison > 0;
    const atPrice = comparison === 0;
    if (!through && !atPrice) continue;

    let fillsUs: string;
    if (through) {
      // Everything at our price was consumed on the way, so the whole remaining
      // size is filled. Same rule as Tier 0's TRADE_THROUGH, but here it is
      // reached only after the queue in front has actually been swept.
      queueAhead = "0";
      fillsUs = remaining;
    } else {
      // Exact: `ratio × traded`, capped by what is actually ahead. No rounding —
      // venue sizes are themselves fractional (venue report §7), so rounding
      // here would be an invented quantisation, and §6 invariant 1 keeps the
      // arithmetic exact either way.
      const attrition = minDecimal(queueAhead, mulDecimal(ratio, trade.shares));
      queueAhead = subDecimal(queueAhead, attrition);
      const consumedByTrade = minDecimal(queueAhead, trade.shares);
      queueAhead = subDecimal(queueAhead, consumedByTrade);
      const spill = subDecimal(trade.shares, consumedByTrade);
      fillsUs = minDecimal(remaining, spill);
    }

    if (compareDecimal(fillsUs, "0") <= 0) continue;

    const fee = computeFee({
      shares: fillsUs,
      price: order.restingPrice,
      liquidityRole: "MAKER",
      snapshot: input.feeSnapshot,
    });
    if (!fee.ok) return fee;

    remaining = subDecimal(remaining, fillsUs);
    filled = addDecimal(filled, fillsUs);
    if (order.cancelRequestedAtNs !== undefined && trade.monotonicNs >= order.cancelRequestedAtNs) {
      fillsAfterCancel = addDecimal(fillsAfterCancel, fillsUs);
    }
    fills.push(
      simulatedFill({
        simulatedFillId: `${order.simulatedOrderId}/t1q/${scenario}/${String(index)}`,
        simulatedOrderId: order.simulatedOrderId,
        marketId: order.marketId,
        tokenId: order.tokenId,
        side: order.side,
        action: order.action,
        price: order.restingPrice,
        shares: fillsUs,
        feeAmount: fee.value.feeAmount,
        liquidityRole: "MAKER",
        model: input.model,
        atEvent: trade.atEvent,
      }),
    );
  }

  return simulationOk(
    ownFrozenTree<RestingScenarioOutcome>({
      scenario,
      filledShares: filled,
      remainingShares: remaining,
      queueAheadAtPlacement,
      queueAheadRemaining: queueAhead,
      fillsAfterCancelRequest: fillsAfterCancel,
      cancelEffectiveAtNs: cancelEffectiveAtNs === null ? null : cancelEffectiveAtNs.toString(),
      fills,
    }),
  );
}

function minDecimal(left: string, right: string): string {
  return compareDecimal(left, right) <= 0 ? left : right;
}
