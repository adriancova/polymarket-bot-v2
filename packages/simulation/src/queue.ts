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
 * way. {@link checkBandOrdering} then asserts on the RESULT exactly the
 * properties that follow from that ordering — and nothing else; see its own
 * comment for the derivation and for the claim that was withdrawn.
 *
 * ADR-012 §7: no execution probe or live-micro observation exists, so none of
 * these numbers is measured. The model records that on its face.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString, mulDecimal, subDecimal } from "@polymarket-bot/decimal";

import { makerFillForShares } from "./base-units.js";
import { computeFee, readFeeScheduleSnapshot, type FeeScheduleSnapshot } from "./fees.js";
import { simulatedFill, type FillModelIdentity, type SimulatedFill } from "./fill-model.js";
import { isNonEmptyString, isNonNegativeInteger, isUnsignedIntegerString } from "./grammar.js";
import { ownFrozenTree, readOwnPlainInput } from "./plain.js";
import type { RecordedEventIdentity } from "./ports.js";
import {
  describeForRefusal,
  simulationFailure,
  simulationOk,
  totally,
  type SimulationResult,
} from "./refusals.js";

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
  return totally("reading the queue model parameters", () =>
    readQueueModelParametersInner(parameters),
  );
}

function readQueueModelParametersInner(
  offered: QueueModelParameters,
): SimulationResult<QueueModelParameters> {
  // D1 (round-2 review, MEDIUM-1): the parameters are a CALLER record, so they
  // are materialized — descriptor-based, cycle-guarded, depth-bounded — before
  // anything reads or copies them.
  const read = readOwnPlainInput<QueueModelParameters>(offered, "the queue model parameters");
  if (!read.ok) return read;
  const parameters = read.value;
  if (parameters === null || typeof parameters !== "object") {
    return simulationFailure(
      "FILL_MODEL_PARAMETERS_UNPINNED",
      "the queue model parameters are a record; §12.5 pins them per run",
    );
  }
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
  for (const [name, table] of [
    ["cancellationRatio", parameters.cancellationRatio],
    ["cancelEffectiveAfterMs", parameters.cancelEffectiveAfterMs],
    ["placedBehindSameInstantAdditions", parameters.placedBehindSameInstantAdditions],
  ] as const) {
    if (table === null || typeof table !== "object") {
      return simulationFailure(
        "FILL_MODEL_PARAMETERS_UNPINNED",
        `${name} must state a value for each of the three §12.2 scenarios`,
        { table: name },
      );
    }
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

/**
 * What was OBSERVED about size added at our price in the same recorded instant
 * we placed — including the fact that nothing was looked at (round-2 review, L4).
 *
 * A bare `"0"` conflated two different facts: "we looked and saw nothing added"
 * and "we did not look". Only the first supports the CONSERVATIVE scenario's
 * claim to be conservative; the second means its queue-ahead assumption rests on
 * an unmeasured quantity, and a reader of the band has to be able to see that.
 * Every sibling seam in this package already names its absences
 * (`NOT_MODELED`, `ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS`,
 * `NOT_AVAILABLE_ARCHIVED_ONLY`); this is the same idiom.
 *
 * There is no default: the composition root states one of the two, and
 * {@link readSameInstantAdditions} refuses anything else — including the bare
 * decimal string the previous shape took.
 */
export type SameInstantAdditions =
  /** The root did not observe same-instant additions at all. */
  | "NOT_OBSERVED"
  /** The root looked, and this is the size it observed (`"0"` is a real answer). */
  | { readonly observedShares: string };

/**
 * Validates a {@link SameInstantAdditions}. Required; never defaulted.
 *
 * D1 (round-3 review): the `{ observedShares }` form is a CALLER RECORD, and its
 * value is carried onto the band and printed in the §12.4 bytes
 * (`sameInstantAdditions=OBSERVED:<shares>`), so returning the caller's own
 * object left a lying accessor between the check and the serialization.
 */
export function readSameInstantAdditions(
  value: SameInstantAdditions,
): SimulationResult<SameInstantAdditions> {
  return totally("reading the same-instant additions", () =>
    readSameInstantAdditionsInner(value),
  );
}

function readSameInstantAdditionsInner(
  offered: SameInstantAdditions,
): SimulationResult<SameInstantAdditions> {
  const read = readOwnPlainInput<SameInstantAdditions>(offered, "the same-instant additions");
  if (!read.ok) return read;
  const value = read.value;
  if (value === "NOT_OBSERVED") return simulationOk(value);
  if (value === null || typeof value !== "object") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      'same-instant additions are stated as `"NOT_OBSERVED"` or `{ observedShares }`; a bare quantity cannot say whether a root looked and saw nothing or never looked',
      { offered: describeForRefusal(value) },
    );
  }
  const shares = value.observedShares;
  if (!isCanonicalDecimalString(shares) || compareDecimal(shares, "0") < 0) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "observed same-instant additions must be a non-negative canonical decimal string (§6 invariant 1)",
      { offered: describeForRefusal(shares) },
    );
  }
  return simulationOk(ownFrozenTree(value));
}

/** The shares a {@link SameInstantAdditions} contributes to the queue ahead. */
function additionsShares(value: SameInstantAdditions): string {
  // A root that did not look observed no additions, so nothing is ADDED to the
  // queue ahead — and the band carries `NOT_OBSERVED` on its face so a reader
  // can see that the conservative arm rests on an unmeasured quantity rather
  // than on a measured zero.
  return value === "NOT_OBSERVED" ? "0" : value.observedShares;
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
  /** What was observed about size added at the resting price in the same instant. */
  readonly sameInstantAdditions: SameInstantAdditions;
  /** Recorded monotonic instant the order rested at. */
  readonly restingFromNs: bigint;
  /** Recorded monotonic instant a cancel was requested, when one was. */
  readonly cancelRequestedAtNs?: bigint;
}

/**
 * One scenario's outcome. Never reported alone; see {@link RestingFillBand}.
 *
 * The scenario label is a TYPE PARAMETER so that a band's `optimistic` member
 * cannot be typed as, or filled with, the conservative outcome.
 */
export interface RestingScenarioOutcome<TScenario extends QueueScenario = QueueScenario> {
  readonly scenario: TScenario;
  readonly filledShares: string;
  readonly remainingShares: string;
  readonly queueAheadAtPlacement: string;
  readonly queueAheadRemaining: string;
  /**
   * Shares filled AFTER a cancel was requested.
   *
   * NOT monotone across the band: see {@link checkBandOrdering}. It is reported
   * per scenario because it is the adverse quantity a cancel was supposed to
   * stop, and a reader needs all three of them.
   */
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
  /**
   * The resting order this band estimates.
   *
   * Carried on the band so a serialized band is identified by the order it is
   * about rather than by whichever fill happened to sort first — the §12.4
   * ordering key has to be TOTAL and value-derived.
   */
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly restingPrice: string;
  /**
   * What the composition root observed about same-instant additions — including
   * that it did not look ({@link SameInstantAdditions}).
   *
   * On the BAND, and in its serialization, because it is an input the
   * CONSERVATIVE scenario's queue ahead depends on and the other two do not: a
   * reader comparing the three arms has to know whether that input was measured.
   */
  readonly sameInstantAdditions: SameInstantAdditions;
  readonly optimistic: RestingScenarioOutcome<"OPTIMISTIC">;
  readonly base: RestingScenarioOutcome<"BASE">;
  readonly conservative: RestingScenarioOutcome<"CONSERVATIVE">;
  readonly bandBasis: "OPTIMISTIC_BASE_CONSERVATIVE_CANCELLATION_ASSUMPTIONS";
  /**
   * Restates ADR-012 §1 on the value itself, so a report that prints one member
   * of the band without the others is visibly doing so.
   */
  readonly quotationRule: "REPORT_THE_BAND_NEVER_ONE_MEMBER";
}

/** Runs all three scenarios and returns the band. Total: no throw escapes. */
export function simulateResting(input: {
  readonly model: FillModelIdentity;
  readonly order: RestingOrderInput;
  readonly trades: readonly ObservedTrade[];
  readonly parameters: QueueModelParameters;
  readonly feeSnapshot: FeeScheduleSnapshot;
}): SimulationResult<RestingFillBand> {
  return totally("simulating a resting order", () => simulateRestingInner(input));
}

/**
 * §7.1 recorded monotonic nanoseconds are `bigint` on this door's record types,
 * so its materializer carries one. See {@link ../plain.js#MaterializePolicy}:
 * a `bigint` is a primitive, and every other non-plain value stays refused.
 */
const RECORDED_INSTANTS_ARE_BIGINTS = Object.freeze({ bigintIsData: true });

function simulateRestingInner(input: {
  readonly model: FillModelIdentity;
  readonly order: RestingOrderInput;
  readonly trades: readonly ObservedTrade[];
  readonly parameters: QueueModelParameters;
  readonly feeSnapshot: FeeScheduleSnapshot;
}): SimulationResult<RestingFillBand> {
  // D1 FIRST, AND ONE READ PER FIELD (round-3 review, MEDIUM-1). Every field of
  // the options bag is taken exactly once, here; every DATA record it yields is
  // then materialized, and everything below reads the materialized tree.
  //
  // What that closes, measured at `b0aeb28`: this door read
  // `order.queueAheadAtPlacement` FOUR times and `order.restingPrice` ELEVEN,
  // so an accessor answering `"10"` for the non-negativity check and `"0"`
  // afterwards produced an ACCEPTED band that serialized as valid v3 bytes with
  // `queueAhead=0` — the check and the computation saw different orders. It also
  // passed `input.model` to D4's copier, which fails CLOSED on an accessor but
  // blamed this package for it (`SIMULATION_INTERNAL`) instead of naming the
  // argument (`SIMULATION_INPUT_NOT_DATA`).
  const {
    model: offeredModel,
    order: offeredOrder,
    trades: offeredTrades,
    parameters: offeredParameters,
    feeSnapshot: offeredFeeSnapshot,
  } = input;

  const readModel = readOwnPlainInput<FillModelIdentity>(offeredModel, "the fill model identity");
  if (!readModel.ok) return readModel;
  const model = readModel.value;
  const readOrder = readOwnPlainInput<RestingOrderInput>(
    offeredOrder,
    "the resting order",
    RECORDED_INSTANTS_ARE_BIGINTS,
  );
  if (!readOrder.ok) return readOrder;
  const order = readOrder.value;
  if (order === null || typeof order !== "object") {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a resting order must be a record");
  }

  const feeSnapshot = readFeeScheduleSnapshot(offeredFeeSnapshot);
  if (!feeSnapshot.ok) return feeSnapshot;
  const parameters = readQueueModelParameters(offeredParameters);
  if (!parameters.ok) return parameters;
  const tier: unknown = model === null || typeof model !== "object" ? undefined : model.tier;
  if (tier !== "TIER_1") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the resting queue model is Tier 1; a Tier-0 identity would mislabel a queue-estimated result as pipeline smoke",
      { tier: describeForRefusal(tier) },
    );
  }
  if (!isCanonicalDecimalString(order.restingPrice)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "resting-order quantities must be canonical decimal strings (§6 invariant 1)",
      { field: "restingPrice", offered: describeForRefusal(order.restingPrice) },
    );
  }
  // The PRICE bound, for the same reason as the size bounds below (round-3
  // review, NOTE-3): a price is what the fee is computed on
  // (`fee = C × rate × p × (1 − p)`) and what the §12.4 `band` line prints, and
  // a negative one is not a price. The venue guards its own inputs; this door
  // enforces what its own computation assumes rather than inheriting it.
  if (compareDecimal(order.restingPrice, "0") <= 0) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a resting order's price is strictly positive; a non-positive price is not a price, and the fee this door charges is computed from it",
      { field: "restingPrice", offered: order.restingPrice },
    );
  }
  // V2-10: the action names which side of F-63's formula the resting order is
  // the maker on (`./base-units.js`), so it is read as one of the two, never
  // defaulted to either.
  if (order.action !== "BUY" && order.action !== "SELL") {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a resting order's action is BUY or SELL", {
      field: "action",
      offered: describeForRefusal(order.action),
    });
  }
  // THE HYPOTHESES OF THE DERIVATION, ENFORCED WHERE IT IS CITED (round-2 review,
  // MEDIUM-2). `checkBandOrdering`'s pre-cancel ordering proof reasons over
  // NON-NEGATIVE quantities: `q' = max(0, max(0, q − ratio × s) − s)` is monotone
  // in `ratio` and in the starting queue only while `q` and `s` are non-negative.
  // The venue guards its own inputs (`venue.ts` `#rest` / `observeTrade`), but a
  // caller reaching this door directly used to get a NONSENSE band — or, for
  // negative additions, a band-inconsistency refusal that blamed the derivation
  // for an input the door never checked. The bounds are the venue's, exactly.
  for (const [field, value] of [
    ["shares", order.shares],
    ["queueAheadAtPlacement", order.queueAheadAtPlacement],
  ] as const) {
    if (!isCanonicalDecimalString(value)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "resting-order quantities must be canonical decimal strings (§6 invariant 1)",
        { field, offered: describeForRefusal(value) },
      );
    }
    if (compareDecimal(value, "0") < 0) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        `a resting order's ${field} is non-negative; the band's pre-cancel ordering is derived over non-negative quantities and is not a property of a negative one`,
        { field, offered: value },
      );
    }
  }
  const additions = readSameInstantAdditions(order.sameInstantAdditions);
  if (!additions.ok) return additions;
  if (!isNonEmptyString(order.simulatedOrderId) || !isNonEmptyString(order.marketId)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a resting order must name itself and its market; the band is identified by the order it is about",
    );
  }
  if (typeof order.restingFromNs !== "bigint") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a resting order carries the recorded monotonic instant it rested at (§7.1)",
      { offered: describeForRefusal(order.restingFromNs) },
    );
  }
  if (order.cancelRequestedAtNs !== undefined && typeof order.cancelRequestedAtNs !== "bigint") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a cancel request is stated as the recorded monotonic instant it was made at (§7.1), or not at all",
      { offered: describeForRefusal(order.cancelRequestedAtNs) },
    );
  }

  // Validated BEFORE any scenario runs, and for the WHOLE list: every scenario
  // walks the same trades, so a malformed or out-of-order trade must be refused
  // once, not discovered halfway through one scenario's walk.
  const trades = readObservedTrades(offeredTrades);
  if (!trades.ok) return trades;

  const shared = {
    model,
    order,
    additions: additions.value,
    trades: trades.value,
    parameters: parameters.value,
    feeSnapshot: feeSnapshot.value,
  };
  const optimistic = runScenario({ ...shared, scenario: "OPTIMISTIC" });
  if (!optimistic.ok) return optimistic;
  const base = runScenario({ ...shared, scenario: "BASE" });
  if (!base.ok) return base;
  const conservative = runScenario({ ...shared, scenario: "CONSERVATIVE" });
  if (!conservative.ok) return conservative;

  const band = ownFrozenTree<RestingFillBand>({
    model,
    queueModelVersion: parameters.value.queueModelVersion,
    simulatedOrderId: order.simulatedOrderId,
    marketId: order.marketId,
    restingPrice: order.restingPrice,
    sameInstantAdditions: additions.value,
    optimistic: optimistic.value,
    base: base.value,
    conservative: conservative.value,
    bandBasis: "OPTIMISTIC_BASE_CONSERVATIVE_CANCELLATION_ASSUMPTIONS",
    quotationRule: "REPORT_THE_BAND_NEVER_ONE_MEMBER",
  });
  // The value RETURNED is the value CHECKED — not a sibling of it.
  return checkBandOrdering(band);
}

/**
 * Checks the band against the properties that FOLLOW from its parameters.
 *
 * ## The claim that was withdrawn, and why (round-1 review, HIGH-1)
 *
 * An earlier version of this function also required post-cancel fills to satisfy
 * `OPTIMISTIC <= BASE <= CONSERVATIVE`, on the reasoning that a post-cancel fill
 * is adverse and so the adverse quantity should be ordered the other way. **That
 * is not derivable, and it refused valid parameterizations.** Two admissible
 * parameter axes push post-cancel fills in OPPOSITE directions:
 *
 * - a longer effectiveness window (`cancelEffectiveAfterMs`, ordered
 *   `OPT <= BASE <= CONS`) admits MORE post-request trades, which raises the
 *   conservative scenario's post-cancel fills; while
 * - a higher `cancellationRatio` (ordered `OPT >= BASE >= CONS`) drains the
 *   queue ahead faster, which raises the OPTIMISTIC scenario's fills per trade.
 *
 * Either force can dominate for parameters `readQueueModelParameters` accepts.
 * Two measured examples, both refused by the old check and both correct bands:
 * ratios `1/0/0` with delays `10/20/30 ms` and one trade 5 ms after the request
 * gives post-cancel fills `{50, 0, 0}` (the ratio dominates); ratios
 * `0.5/0.25/0.1` with delays `50/150/300 ms` and one trade at 100 ms gives
 * `{0, 50, 32}` (both forces bind, in different pairs). §12.2 requires the
 * result to be REPORTED AS A BAND; it does not say filled shares are monotone
 * across scenarios, and with opposing forces they are not. A non-derivable
 * ordering is therefore not an invariant here, and is not refused.
 *
 * ## What IS derivable, and is enforced
 *
 * 1. **Each scenario is internally consistent**: canonical, non-negative
 *    quantities; `fillsAfterCancelRequest <= filledShares`; `filledShares` is
 *    exactly the sum of the scenario's own fills; the scenario's label matches
 *    the member it is filed under.
 * 2. **The three scenarios describe ONE order**: `filledShares + remainingShares`
 *    is identical across them.
 * 3. **`cancelEffectiveAtNs` is ordered `OPT <= BASE <= CONS`** whenever a cancel
 *    was requested — this follows directly from the parameter constraint
 *    `cancelEffectiveAfterMs.OPTIMISTIC <= BASE <= CONSERVATIVE` applied to one
 *    shared request instant, and it is the axis on which "conservative" means
 *    "the safety cancel lands latest".
 * 4. **Fills BEFORE the cancel request are ordered `OPT >= BASE >= CONS`.**
 *    Proof: a pre-request trade has `monotonicNs < cancelRequestedAtNs <=
 *    cancelEffectiveAtNs` in every scenario, so the effectiveness window cuts
 *    none of them and all three scenarios walk the SAME pre-request trades (the
 *    trade list is validated non-decreasing in `monotonicNs`, so the loop's
 *    `break` cannot skip an earlier one). Over that shared prefix the per-trade
 *    step is `q' = max(0, max(0, q - ratio x s) - s)` and the size that reaches
 *    us is `max(0, s - max(0, q - ratio x s))`: `q` is monotone non-increasing in
 *    `ratio` and non-decreasing in the starting queue, and the size reaching us
 *    is monotone the other way, so cumulative fills are non-decreasing in
 *    `ratio` and non-increasing in the queue ahead at placement. The parameter
 *    door pins `ratio` at `OPT >= BASE >= CONS` and allows the larger
 *    (behind-same-instant-additions) queue only in `CONSERVATIVE`, so both
 *    inputs point the same way and the ordering follows. A trade THROUGH the
 *    price fills the whole remainder in every scenario, which preserves it.
 *
 * ## Where the derivation's HYPOTHESES are enforced (round-2 review, MEDIUM-2)
 *
 * Item 4's monotonicity holds for NON-NEGATIVE quantities. It is not a property
 * of a negative one: with a negative traded size the per-trade step runs
 * backwards — the queue ahead GROWS — and the scenarios can come out ordered
 * either way. So the hypotheses are checked at the doors that state them, not
 * assumed from the venue that happens to be upstream today:
 * {@link simulateResting} refuses a negative `shares` or `queueAheadAtPlacement`
 * and a `sameInstantAdditions` that is not a valid
 * {@link SameInstantAdditions}, and {@link readObservedTrades} refuses a trade
 * whose size is not positive. Those are the venue's own bounds
 * (`venue.ts` `#rest` and `observeTrade`), which remain in place; this door no
 * longer depends on them.
 */
export function checkBandOrdering(band: RestingFillBand): SimulationResult<RestingFillBand> {
  return totally("checking a resting band", () => checkBandOrderingInner(band));
}

function checkBandOrderingInner(offered: RestingFillBand): SimulationResult<RestingFillBand> {
  // D1 (round-3 review, MEDIUM-1). This door used to validate the CALLER'S OWN
  // OBJECT and then return it: an unfrozen, prototype-bearing alias. With an
  // accessor on `conservative` that answered honestly for the check's reads and
  // differently afterwards, the check ACCEPTED and `serializeBand` on the
  // RETURNED CHECKED VALUE emitted `conservative[ filled=999 remaining=0 … ]`
  // for a 50-share order — the exact inconsistency this function exists to
  // reject, reaching the §12.4 bytes with a passed check in front of it.
  // Materializing first makes the checked value and the returned value the same
  // frozen, prototype-free tree, which no caller holds a reference to.
  const read = readOwnPlainInput<RestingFillBand>(offered, "the resting band");
  if (!read.ok) return read;
  const band = read.value;
  if (band === null || typeof band !== "object") {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a band must be a record");
  }
  // The band states what it observed about same-instant additions, or that it
  // did not look; a band that states neither is not readable as a band at all.
  const additions = readSameInstantAdditions(band.sameInstantAdditions);
  if (!additions.ok) return additions;
  const members: readonly (readonly [string, QueueScenario, RestingScenarioOutcome])[] = [
    ["optimistic", "OPTIMISTIC", band.optimistic],
    ["base", "BASE", band.base],
    ["conservative", "CONSERVATIVE", band.conservative],
  ];

  for (const [member, expected, outcome] of members) {
    if (outcome === null || typeof outcome !== "object") {
      return simulationFailure(
        "FILL_MODEL_BAND_INCONSISTENT",
        `the band's ${member} member is not a scenario outcome`,
        { member },
      );
    }
    if (outcome.scenario !== expected) {
      return simulationFailure(
        "FILL_MODEL_BAND_INCONSISTENT",
        `the band's ${member} member is labelled ${String(outcome.scenario)}; three numbers with misleading names are not a band`,
        { member, labelled: String(outcome.scenario) },
      );
    }
    for (const [field, value] of [
      ["filledShares", outcome.filledShares],
      ["remainingShares", outcome.remainingShares],
      ["queueAheadAtPlacement", outcome.queueAheadAtPlacement],
      ["queueAheadRemaining", outcome.queueAheadRemaining],
      ["fillsAfterCancelRequest", outcome.fillsAfterCancelRequest],
    ] as const) {
      if (!isCanonicalDecimalString(value)) {
        return simulationFailure(
          "SIMULATION_INPUT_INVALID",
          `the band's ${member}.${field} is not a canonical decimal string (§6 invariant 1)`,
          { member, field, offered: String(value) },
        );
      }
      if (compareDecimal(value, "0") < 0) {
        return simulationFailure(
          "FILL_MODEL_BAND_INCONSISTENT",
          `the band's ${member}.${field} is negative`,
          { member, field, offered: value },
        );
      }
    }
    if (compareDecimal(outcome.fillsAfterCancelRequest, outcome.filledShares) > 0) {
      return simulationFailure(
        "FILL_MODEL_BAND_INCONSISTENT",
        `the band's ${member} scenario fills more shares after a cancel request than it fills in total`,
        {
          member,
          fillsAfterCancelRequest: outcome.fillsAfterCancelRequest,
          filledShares: outcome.filledShares,
        },
      );
    }
    let summed = "0";
    for (const fill of outcome.fills) {
      if (!isCanonicalDecimalString(fill.shares)) {
        return simulationFailure(
          "SIMULATION_INPUT_INVALID",
          `a fill in the band's ${member} scenario carries a non-canonical share quantity`,
          { member, offered: String(fill.shares) },
        );
      }
      summed = addDecimal(summed, fill.shares);
    }
    if (compareDecimal(summed, outcome.filledShares) !== 0) {
      return simulationFailure(
        "FILL_MODEL_BAND_INCONSISTENT",
        `the band's ${member} scenario reports ${outcome.filledShares} filled and its own fills sum to ${summed}`,
        { member, reported: outcome.filledShares, summed },
      );
    }
  }

  const total = (outcome: RestingScenarioOutcome): string =>
    addDecimal(outcome.filledShares, outcome.remainingShares);
  for (const [member, , outcome] of members) {
    if (compareDecimal(total(outcome), total(band.optimistic)) !== 0) {
      return simulationFailure(
        "FILL_MODEL_BAND_INCONSISTENT",
        "the three scenarios do not describe one order: filled + remaining differs between them",
        { member, total: total(outcome), optimisticTotal: total(band.optimistic) },
      );
    }
  }

  const effective = members.map(([member, , outcome]) => ({
    member,
    at: outcome.cancelEffectiveAtNs,
  }));
  const stated = effective.filter((entry) => entry.at !== null);
  if (stated.length !== 0 && stated.length !== effective.length) {
    return simulationFailure(
      "FILL_MODEL_BAND_INCONSISTENT",
      "a cancel is requested in some scenarios of the band and not in others; the request instant is one recorded fact",
      { stated: stated.length },
    );
  }
  if (stated.length === effective.length && stated.length > 0) {
    for (const entry of stated) {
      if (!isUnsignedIntegerString(entry.at ?? "")) {
        return simulationFailure(
          "SIMULATION_INPUT_INVALID",
          `the band's ${entry.member}.cancelEffectiveAtNs is not a canonical unsigned integer string`,
          { member: entry.member, offered: String(entry.at) },
        );
      }
    }
    const [optimistic, base, conservative] = stated.map((entry) => BigInt(entry.at ?? "0"));
    if (
      optimistic === undefined ||
      base === undefined ||
      conservative === undefined ||
      optimistic > base ||
      base > conservative
    ) {
      return simulationFailure(
        "FILL_MODEL_BAND_INCONSISTENT",
        "the band is not ordered on cancel effectiveness: a conservative world is the one where a safety cancel lands latest, so cancelEffectiveAtNs must satisfy OPTIMISTIC <= BASE <= CONSERVATIVE",
        {
          optimistic: band.optimistic.cancelEffectiveAtNs,
          base: band.base.cancelEffectiveAtNs,
          conservative: band.conservative.cancelEffectiveAtNs,
        },
      );
    }
  }

  const preCancel = (outcome: RestingScenarioOutcome): string =>
    subDecimal(outcome.filledShares, outcome.fillsAfterCancelRequest);
  if (
    compareDecimal(preCancel(band.optimistic), preCancel(band.base)) < 0 ||
    compareDecimal(preCancel(band.base), preCancel(band.conservative)) < 0
  ) {
    return simulationFailure(
      "FILL_MODEL_BAND_INCONSISTENT",
      "the band is not ordered: fills before a cancel is requested must satisfy OPTIMISTIC >= BASE >= CONSERVATIVE, which follows from the parameter ordering because every scenario walks the same pre-request trades",
      {
        optimistic: preCancel(band.optimistic),
        base: preCancel(band.base),
        conservative: preCancel(band.conservative),
      },
    );
  }
  // D4 on the way out: the checked tree, frozen and prototype-free, never the
  // caller's object. `README.md` §2 D4 states this; before round 3 this one OK
  // path contradicted it.
  return simulationOk(ownFrozenTree(band));
}

/**
 * Validates the observed trades a band is computed from.
 *
 * Non-decreasing `monotonicNs` is not a nicety: {@link runScenario} stops at the
 * first trade at or after its cancel-effectiveness instant, so an out-of-order
 * list silently truncates the walk and returns a smaller fill as though it were
 * the answer. The same list, sorted, gives a different number — which means an
 * unsorted list has no defined answer and is refused rather than answered.
 */
function readObservedTrades(
  offered: readonly ObservedTrade[],
): SimulationResult<readonly ObservedTrade[]> {
  // D1 (round-3 review, MEDIUM-1): the trade list is a CALLER ARRAY OF CALLER
  // RECORDS, and every scenario walks it three times — price, size and instant
  // are each read again per scenario — so an accessor could answer the
  // validation and the walk differently. It is materialized once, here, and the
  // three scenarios walk the materialized tree.
  const read = readOwnPlainInput<readonly ObservedTrade[]>(
    offered,
    "the observed trades",
    RECORDED_INSTANTS_ARE_BIGINTS,
  );
  if (!read.ok) return read;
  const trades = read.value;
  if (!Array.isArray(trades)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the observed trades must be an array (possibly empty)",
    );
  }
  let previous: bigint | undefined;
  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    if (trade === undefined || typeof trade !== "object") {
      return simulationFailure("SIMULATION_INPUT_INVALID", "an observed trade is not a record", {
        index,
      });
    }
    if (!isCanonicalDecimalString(trade.price) || !isCanonicalDecimalString(trade.shares)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade carries a non-canonical decimal",
        { index, price: describeForRefusal(trade.price), shares: describeForRefusal(trade.shares) },
      );
    }
    // The venue's own bound (`venue.ts` `observeTrade`), enforced HERE too
    // (round-2 review, MEDIUM-2): a negative traded size ran the queue walk
    // BACKWARDS — `queueAhead` grew — and produced a band whose scenarios could
    // come out ordered the wrong way, which the derivation above claims cannot
    // happen. It cannot, for the non-negative sizes the derivation assumes; so
    // the assumption is checked rather than hoped for.
    if (compareDecimal(trade.shares, "0") <= 0) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade has positive size; a non-positive one is not a trade, and the queue walk's monotonicity in the cancellation ratio is derived over positive traded size",
        { index, shares: trade.shares },
      );
    }
    // The same bound on the PRICE (round-3 review, NOTE-3). The walk compares a
    // trade price with the resting price to decide "at" from "through", and a
    // non-positive price is not a price: the door enforces what its own
    // computation assumes rather than inheriting the venue's guard.
    if (compareDecimal(trade.price, "0") <= 0) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade prints at a strictly positive price; the at-price / through-price comparison this walk turns on is not defined for a non-positive one",
        { index, price: trade.price },
      );
    }
    if (typeof trade.monotonicNs !== "bigint" || trade.monotonicNs < 0n) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade must carry the recorded monotonic nanoseconds of the event that printed it (§7.1)",
        { index },
      );
    }
    if (previous !== undefined && trade.monotonicNs < previous) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "the observed trades are not in non-decreasing recorded monotonic order; a queue walk over an unordered list truncates silently and would report a smaller fill as though it were the answer",
        {
          index,
          previousMonotonicNs: previous.toString(),
          monotonicNs: trade.monotonicNs.toString(),
        },
      );
    }
    previous = trade.monotonicNs;
  }
  return simulationOk(trades);
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function runScenario<TScenario extends QueueScenario>(input: {
  readonly scenario: TScenario;
  readonly model: FillModelIdentity;
  readonly order: RestingOrderInput;
  readonly additions: SameInstantAdditions;
  readonly trades: readonly ObservedTrade[];
  readonly parameters: QueueModelParameters;
  readonly feeSnapshot: FeeScheduleSnapshot;
}): SimulationResult<RestingScenarioOutcome<TScenario>> {
  const { scenario, order, parameters } = input;
  const ratio = parameters.cancellationRatio[scenario];
  const behind = parameters.placedBehindSameInstantAdditions[scenario];

  const queueAheadAtPlacement = behind
    ? addDecimal(order.queueAheadAtPlacement, additionsShares(input.additions))
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
    // The trade list was validated as a whole by `readObservedTrades` before any
    // scenario ran: canonical decimals, and non-decreasing in `monotonicNs`, so
    // this `break` cannot skip an earlier trade.

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

    // V2-10: our resting order is the MAKER, signed at its resting price, so
    // the estimated fill moves F-63's legs in whole base units
    // (`./base-units.js`): a resting SELL's shares whole and its pUSD floored;
    // a resting BUY's pUSD floored and its shares the formula's counter of it.
    // An estimate under one base unit moves nothing (F-73).
    const legs = makerFillForShares(order.action, order.restingPrice, fillsUs);
    if (!legs.ok) return legs;
    const moved = legs.value.shares;
    if (compareDecimal(moved, "0") <= 0) continue;

    const fee = computeFee({
      shares: moved,
      price: order.restingPrice,
      liquidityRole: "MAKER",
      snapshot: input.feeSnapshot,
    });
    if (!fee.ok) return fee;

    remaining = subDecimal(remaining, moved);
    filled = addDecimal(filled, moved);
    if (order.cancelRequestedAtNs !== undefined && trade.monotonicNs >= order.cancelRequestedAtNs) {
      fillsAfterCancel = addDecimal(fillsAfterCancel, moved);
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
        shares: moved,
        collateralAmount: legs.value.collateral,
        feeAmount: fee.value.feeAmount,
        liquidityRole: "MAKER",
        model: input.model,
        atEvent: trade.atEvent,
      }),
    );
  }

  return simulationOk(
    ownFrozenTree<RestingScenarioOutcome<TScenario>>({
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
