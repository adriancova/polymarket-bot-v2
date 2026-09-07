/**
 * The payoff-model registry — handoff §9.3, ADR-009 §2.
 *
 * Four models, no fifth, and no default:
 *
 * | Model | Settles |
 * | --- | --- |
 * | `TerminalSpotBinaryModel` | one terminal observation against a strike |
 * | `TwapBinaryModel` | a time-weighted average over the spec's window against a strike |
 * | `ReferenceOpenUpDownModel` | an observation against the market's own reference open |
 * | `ThresholdByDateModel` | whether a threshold was met within a period ending at a deadline |
 *
 * Selection is a function of the spec (ADR-009 §2), and a mismatch "must be an
 * error, not a default". Two independent gates enforce that:
 *
 * 1. {@link selectPayoffModel} refuses a spec whose declared model does not fit
 *    its `observation_type` — with the dedicated
 *    `SETTLEMENT_TWAP_TERMINAL_SPOT_FORBIDDEN` code for the combination §9.3
 *    names.
 * 2. Every observation is tagged with the model that consumes it, so the wrong
 *    reading cannot be fed to a model even when the spec is correct.
 *
 * Nothing here reads a clock, performs I/O, or holds state: an evaluation is a
 * pure function of (spec, observation), which is what makes a replayed
 * settlement reproduce a live one (§12.4).
 */

import { compareDecimal, type DecimalString } from "@polymarket-bot/decimal";

import {
  settlementFailure,
  settlementOk,
  settlementRefusal,
  type SettlementRefusal,
  type SettlementResult,
} from "../errors.js";
import type {
  ReferenceOpenUpDownObservation,
  SettlementObservation,
  ThresholdByDateObservation,
  TerminalSpotObservation,
  TwapObservation,
} from "../observation.js";
import {
  buildOwnObservation,
  observationOwnIssues,
  readOwnObservation,
} from "../observation-door.js";
import { payoutPerShare, type OutcomePayoutPerShare } from "../payout.js";
import { ownEmit, ownField } from "../spec-door.js";
import { isReviewedSettlementSpec, type SettlementSpec } from "../spec.js";
import { instantMilliseconds } from "../time.js";
import type { ComparisonOperator, MarketOutcomeState, PayoffModelId } from "../vocabulary.js";
import { COMPARISON_OPERATORS, PAYOFF_MODEL_IDS } from "../vocabulary.js";
import { checkPayoffModelCompatibility } from "./compatibility.js";

/** The comparison a model actually performed, so a settlement can be audited. */
export interface ComparisonEvaluation {
  readonly operator: ComparisonOperator;
  /** The observed settlement value. */
  readonly left: DecimalString;
  /** The strike, threshold, or reference open it was compared against. */
  readonly right: DecimalString;
  readonly satisfied: boolean;
}

/** The result of settling one market under one spec. */
export interface SettlementEvaluation {
  readonly model: PayoffModelId;
  readonly outcomeState: MarketOutcomeState;
  readonly comparison: ComparisonEvaluation;
  /**
   * Whether the spec behind this number has been reviewed (§9.2).
   *
   * Carried on the RESULT, not only checked at activation, so a consumer cannot
   * display or persist a payoff without also holding the fact that nobody
   * verified the semantics that produced it.
   */
  readonly reviewed: boolean;
  /** Present only when {@link outcomeState} is terminal and its payout is known. */
  readonly payoutPerShare?: OutcomePayoutPerShare;
}

/** Whether `left <operator> right` holds, by exact decimal comparison. */
export function satisfiesComparison(
  left: DecimalString,
  right: DecimalString,
  operator: ComparisonOperator,
): boolean {
  const order = compareDecimal(left, right);
  switch (operator) {
    case "GT":
      return order > 0;
    case "GTE":
      return order >= 0;
    case "LT":
      return order < 0;
    case "LTE":
      return order <= 0;
  }
}

/**
 * The payoff model this spec selects.
 *
 * ADR-009 §2. Returns every reason a selection is impossible rather than the
 * first: an operator repairing a spec should see the whole list.
 */
export function selectPayoffModel(spec: SettlementSpec): SettlementResult<PayoffModelId> {
  const refusals = checkPayoffModelCompatibility(spec);
  if (refusals.length > 0) {
    return settlementFailure(...refusals);
  }
  // D3: the selected model is the one the SPEC states. `spec.payoffModel` is a
  // dot read on a caller-supplied document, and at base it was answered by
  // `Object.prototype` — a spec declaring no model at all selected
  // `TerminalSpotBinaryModel` and settled markets with it.
  const payoffModel: unknown = ownField(spec, "payoffModel");
  /* c8 ignore next 9 -- second line: unreachable through the compatibility check
     above, which refuses on its own own-read both an absent model and one
     outside the vocabulary. */
  if (typeof payoffModel !== "string" || !PAYOFF_MODEL_IDS.includes(payoffModel as PayoffModelId)) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_SPEC_FIELD_REQUIRED",
        "settlement spec declares no payoff model",
        { field: "payoffModel" },
      ),
    );
  }
  return settlementOk(payoffModel as PayoffModelId);
}

function timestampRefusal(field: string, value: string): SettlementRefusal {
  return settlementRefusal(
    "SETTLEMENT_TIMESTAMP_INVALID",
    `observation field \`${field}\` is not a parseable ISO-8601 instant`,
    { field, value },
  );
}

/** Orders two instants, or refuses when either is unparseable. */
function orderedInstants(
  earlierField: string,
  earlier: string,
  laterField: string,
  later: string,
): SettlementResult<{ readonly earlierMs: number; readonly laterMs: number }> {
  const earlierMs = instantMilliseconds(earlier);
  if (earlierMs === undefined) {
    return settlementFailure(timestampRefusal(earlierField, earlier));
  }
  const laterMs = instantMilliseconds(later);
  if (laterMs === undefined) {
    return settlementFailure(timestampRefusal(laterField, later));
  }
  return settlementOk({ earlierMs, laterMs });
}

/**
 * Validates a TWAP observation window against the spec that consumes it.
 *
 * ENDPOINT CONVENTION (explicit, because H1 of the round-1 review showed the
 * boundaries were previously unchecked): `windowStartAt` and `windowEndAt` are
 * the two boundary INSTANTS of the averaging interval, and the interval's
 * length is measured as `windowEndAt − windowStartAt` at millisecond
 * precision. A declared `windowSeconds` of 30 therefore requires
 * `windowEndAt − windowStartAt === 30000 ms` exactly — the end boundary sits
 * exactly `windowSeconds` after the start boundary. Whether the endpoints
 * themselves are inclusive ticks is the feed's affair (the spec's
 * `window_start_rule` / `window_end_rule` state it in prose); what this
 * evaluator enforces is that the timestamps SPAN the declared window:
 *
 * 1. the numeric tag must equal the spec's `window_seconds`;
 * 2. both boundaries must parse as instants;
 * 3. the window must be strictly ordered (`windowEndAt > windowStartAt`); and
 * 4. the elapsed interval must equal the declared window exactly.
 *
 * Without 3 and 4, an observation TAGGED with the reviewed window but averaged
 * over a different (or inverted, or empty) span would settle the market on a
 * number the venue never used.
 */
function checkTwapWindow(
  spec: SettlementSpec,
  window: {
    readonly windowSeconds: number;
    readonly windowStartAt: string;
    readonly windowEndAt: string;
  },
): SettlementResult<void> {
  // D3: the reviewed window is the one the SPEC states, read from the document
  // itself. A dot read here is answered by `Object.prototype` for a spec that
  // states none, and this comparison is the only thing standing between a
  // reviewed 30s average and a reading of something else.
  const specWindowSeconds: unknown = ownField(spec, "windowSeconds");
  if (window.windowSeconds !== specWindowSeconds) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_OBSERVATION_WINDOW_MISMATCH",
        `observation averages ${String(window.windowSeconds)}s but the spec settles on ${String(specWindowSeconds)}s`,
        {
          observationWindowSeconds: window.windowSeconds,
          specWindowSeconds,
        },
      ),
    );
  }
  const boundaries = orderedInstants(
    "windowStartAt",
    window.windowStartAt,
    "windowEndAt",
    window.windowEndAt,
  );
  if (!boundaries.ok) {
    return boundaries;
  }
  if (boundaries.value.laterMs <= boundaries.value.earlierMs) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_OBSERVATION_WINDOW_INVALID",
        "the observation window ends at or before it starts",
        { windowStartAt: window.windowStartAt, windowEndAt: window.windowEndAt },
      ),
    );
  }
  const elapsedMs = boundaries.value.laterMs - boundaries.value.earlierMs;
  const declaredMs = window.windowSeconds * 1000;
  if (elapsedMs !== declaredMs) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_OBSERVATION_WINDOW_MISMATCH",
        `the observation window spans ${String(elapsedMs / 1000)}s between its boundaries but declares a ${String(window.windowSeconds)}s average; the timestamps do not cover the reviewed window`,
        {
          windowStartAt: window.windowStartAt,
          windowEndAt: window.windowEndAt,
          declaredWindowSeconds: window.windowSeconds,
          elapsedSeconds: elapsedMs / 1000,
        },
      ),
    );
  }
  return settlementOk(undefined);
}

/**
 * The comparison the SPEC states, or the refusal that it states none.
 *
 * D3: an own read, and the operator is checked against the vocabulary rather
 * than trusted, because this value decides the DIRECTION of every settlement.
 * Measured at base: with `comparison` inherited, a `GTE` market settled `NO_WIN`
 * under an inherited `LT` — the spec's own text was never consulted.
 *
 * SECOND LINE, and disclosed as such: every cell of the compatibility matrix
 * REQUIRES `comparison`, and that check is itself an own read, so a spec that
 * states none has already been refused before this runs (pinned by "the first
 * gate answers before the second-line reads are reached").
 */
function requireComparison(spec: SettlementSpec): SettlementResult<ComparisonOperator> {
  const comparison: unknown = ownField(spec, "comparison");
  /* c8 ignore next 12 -- second line; see the note above. */
  if (
    typeof comparison !== "string" ||
    !COMPARISON_OPERATORS.includes(comparison as ComparisonOperator)
  ) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_SPEC_FIELD_REQUIRED",
        "settlement spec states no comparison operator",
        { field: "comparison" },
      ),
    );
  }
  return settlementOk(comparison as ComparisonOperator);
}

function binaryOutcome(satisfied: boolean): MarketOutcomeState {
  return satisfied ? "YES_WIN" : "NO_WIN";
}

/**
 * D4. The audited comparison, emitted with a null prototype and frozen.
 *
 * It is the record of what actually settled a market, so a consumer reading a
 * field it does not carry must read nothing — not `Object.prototype`.
 */
function comparisonRecord(
  operator: ComparisonOperator,
  left: DecimalString,
  right: DecimalString,
  satisfied: boolean,
): ComparisonEvaluation {
  return ownEmit<ComparisonEvaluation>([
    ["operator", operator],
    ["left", left],
    ["right", right],
    ["satisfied", satisfied],
  ]);
}

/**
 * Builds an evaluation, attaching the payout for a terminal outcome.
 *
 * D4 (ADR-020 §3): emitted with a NULL PROTOTYPE and frozen. Measured at base —
 * `payoutPerShare` is ABSENT on a `PENDING` settlement, and
 * `evaluation.payoutPerShare` then read an inherited `{yes:"1", no:"1"}`, i.e. a
 * redemption value for a market that has determined none (ADR-009 §4).
 */
function evaluation(
  spec: SettlementSpec,
  model: PayoffModelId,
  outcomeState: MarketOutcomeState,
  comparison: ComparisonEvaluation,
): SettlementEvaluation {
  const payout = payoutPerShare(outcomeState);
  const reviewed = isReviewedSettlementSpec(spec);
  const fields: (readonly [string, unknown])[] = [
    ["model", model],
    ["outcomeState", outcomeState],
    ["comparison", comparison],
    ["reviewed", reviewed],
  ];
  if (payout.ok) {
    fields.push(["payoutPerShare", payout.value]);
  }
  return ownEmit<SettlementEvaluation>(fields);
}

function evaluateTerminalSpot(
  spec: SettlementSpec,
  observation: TerminalSpotObservation,
): SettlementResult<SettlementEvaluation> {
  const operator = requireComparison(spec);
  if (!operator.ok) {
    return operator;
  }
  const satisfied = satisfiesComparison(observation.observedValue, observation.strike, operator.value);
  return settlementOk(
    evaluation(
      spec,
      "TerminalSpotBinaryModel",
      binaryOutcome(satisfied),
      comparisonRecord(operator.value, observation.observedValue, observation.strike, satisfied),
    ),
  );
}

function evaluateTwap(
  spec: SettlementSpec,
  observation: TwapObservation,
): SettlementResult<SettlementEvaluation> {
  const operator = requireComparison(spec);
  if (!operator.ok) {
    return operator;
  }
  // ADR-009 §6: a TWAP spec depends on a window the feed publishes. An
  // observation averaged over a DIFFERENT window — whether mis-tagged, or
  // tagged correctly but with boundary timestamps spanning something else — is
  // not the value the spec was reviewed for, and accepting it would settle the
  // market on a number the venue never used. See {@link checkTwapWindow} for
  // the endpoint convention.
  const window = checkTwapWindow(spec, observation);
  if (!window.ok) {
    return window;
  }
  const satisfied = satisfiesComparison(observation.twapValue, observation.strike, operator.value);
  return settlementOk(
    evaluation(
      spec,
      "TwapBinaryModel",
      binaryOutcome(satisfied),
      comparisonRecord(operator.value, observation.twapValue, observation.strike, satisfied),
    ),
  );
}

function evaluateReferenceOpenUpDown(
  spec: SettlementSpec,
  observation: ReferenceOpenUpDownObservation,
): SettlementResult<SettlementEvaluation> {
  const operator = requireComparison(spec);
  if (!operator.ok) {
    return operator;
  }

  // The spec decides whether this series settles on a spot reading or on a
  // TWAP; the observation must be the one the spec was reviewed for. D3: which
  // of the two it is comes from the document's own field.
  const observationType: unknown = ownField(spec, "observationType");
  if (observationType === "TWAP") {
    if (
      observation.windowSeconds === undefined ||
      observation.windowStartAt === undefined ||
      observation.windowEndAt === undefined
    ) {
      return settlementFailure(
        settlementRefusal(
          "SETTLEMENT_OBSERVATION_WINDOW_MISMATCH",
          "the spec settles this series on a TWAP observation, but the observation carries no window",
          { specWindowSeconds: ownField(spec, "windowSeconds") },
        ),
      );
    }
    // The same window discipline as `evaluateTwap` (round-1 review, H1): the
    // tag must match the spec AND the boundary timestamps must be ordered and
    // span exactly the declared window. See {@link checkTwapWindow} for the
    // endpoint convention.
    const window = checkTwapWindow(spec, {
      windowSeconds: observation.windowSeconds,
      windowStartAt: observation.windowStartAt,
      windowEndAt: observation.windowEndAt,
    });
    if (!window.ok) {
      return window;
    }
  } else if (
    observation.windowSeconds !== undefined ||
    observation.windowStartAt !== undefined ||
    observation.windowEndAt !== undefined
  ) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_OBSERVATION_WINDOW_MISMATCH",
        `the spec settles this series on a ${String(observationType)} observation, but the observation carries an averaging window`,
        { observationType },
      ),
    );
  }

  const ordering = orderedInstants(
    "referenceOpenAt",
    observation.referenceOpenAt,
    "observedAt",
    observation.observedAt,
  );
  if (!ordering.ok) {
    return ordering;
  }
  if (ordering.value.laterMs <= ordering.value.earlierMs) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_OBSERVATION_WINDOW_INVALID",
        "the settlement observation is not after the reference open, so there is no direction to measure",
        {
          referenceOpenAt: observation.referenceOpenAt,
          observedAt: observation.observedAt,
        },
      ),
    );
  }

  const satisfied = satisfiesComparison(
    observation.observedValue,
    observation.referenceOpen,
    operator.value,
  );
  return settlementOk(
    evaluation(
      spec,
      "ReferenceOpenUpDownModel",
      binaryOutcome(satisfied),
      comparisonRecord(operator.value, observation.observedValue, observation.referenceOpen, satisfied),
    ),
  );
}

/** Which extreme answers a comparison: a "reach" question needs the maximum. */
const EXTREME_FOR_COMPARISON = Object.freeze({
  GT: "MAX",
  GTE: "MAX",
  LT: "MIN",
  LTE: "MIN",
} as const);

function evaluateThresholdByDate(
  spec: SettlementSpec,
  observation: ThresholdByDateObservation,
): SettlementResult<SettlementEvaluation> {
  const operator = requireComparison(spec);
  if (!operator.ok) {
    return operator;
  }

  const expectedExtreme = EXTREME_FOR_COMPARISON[operator.value];
  if (observation.extremeKind !== expectedExtreme) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_EXTREME_DIRECTION_MISMATCH",
        `a ${operator.value} threshold question is answered by the ${expectedExtreme} observed value, but the observation carries the ${observation.extremeKind}`,
        { operator: operator.value, expectedExtreme, observedExtremeKind: observation.extremeKind },
      ),
    );
  }

  const period = orderedInstants(
    "periodStartAt",
    observation.periodStartAt,
    "deadlineAt",
    observation.deadlineAt,
  );
  if (!period.ok) {
    return period;
  }
  if (period.value.laterMs <= period.value.earlierMs) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_OBSERVATION_WINDOW_INVALID",
        "the observation period ends at or before it starts",
        { periodStartAt: observation.periodStartAt, deadlineAt: observation.deadlineAt },
      ),
    );
  }

  const asOfMs = instantMilliseconds(observation.asOf);
  if (asOfMs === undefined) {
    return settlementFailure(timestampRefusal("asOf", observation.asOf));
  }
  const extremeMs = instantMilliseconds(observation.extremeObservedAt);
  if (extremeMs === undefined) {
    return settlementFailure(timestampRefusal("extremeObservedAt", observation.extremeObservedAt));
  }
  // The extreme must have been observed inside the period the question asks
  // about, and not after the instant this evaluation claims to be made as of —
  // otherwise the settlement uses information the evaluator could not have had
  // (§8.4: replay "must not use future venue timestamps").
  const upperBoundMs = Math.min(asOfMs, period.value.laterMs);
  if (extremeMs < period.value.earlierMs || extremeMs > upperBoundMs) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_OBSERVATION_WINDOW_INVALID",
        "the extreme observation lies outside the period being settled",
        {
          extremeObservedAt: observation.extremeObservedAt,
          periodStartAt: observation.periodStartAt,
          deadlineAt: observation.deadlineAt,
          asOf: observation.asOf,
        },
      ),
    );
  }

  const satisfied = satisfiesComparison(
    observation.extremeValue,
    observation.threshold,
    operator.value,
  );
  const comparison: ComparisonEvaluation = comparisonRecord(
    operator.value,
    observation.extremeValue,
    observation.threshold,
    satisfied,
  );

  // A met threshold settles the question early — it cannot be un-met later.
  if (satisfied) {
    return settlementOk(evaluation(spec, "ThresholdByDateModel", "YES_WIN", comparison));
  }
  // An unmet threshold is only a NO once the deadline has passed. Before that
  // the question is open, and `PENDING` is the honest answer.
  if (asOfMs >= period.value.laterMs) {
    return settlementOk(evaluation(spec, "ThresholdByDateModel", "NO_WIN", comparison));
  }
  return settlementOk(evaluation(spec, "ThresholdByDateModel", "PENDING", comparison));
}

/** The observation door's refusal, composed the way this package composes one. */
function observationInvalid(issues: readonly string[]): SettlementRefusal {
  return settlementRefusal(
    "SETTLEMENT_OBSERVATION_INVALID",
    `settlement observation is invalid: ${issues.join("; ")}`,
    { issues },
  );
}

/**
 * Settles one market THROUGH THE OBSERVATION DOOR (`../observation-door.ts`;
 * ADR-020 §3): selects the spec's model, reads the observation into plain own
 * data, checks that the reading belongs to that model and states what the model
 * settles on, and evaluates FROM THE READ TREE.
 *
 * The steps, in the order they run:
 *
 * 1. the spec selects a model, or the spec's own refusals come back (unchanged:
 *    a spec problem is reported before a reading is even looked at);
 * 2. **D1** — {@link readOwnObservation} materializes the reading prototype-free
 *    from its own descriptors, so an accessor, a symbol key, a `__proto__` key
 *    or a foreign prototype is refused rather than settled on;
 * 3. the two mismatch gates, on OWN reads of both documents — at base each was
 *    answerable by `Object.prototype` from either side;
 * 4. {@link observationOwnIssues} — every field the model settles on must be the
 *    reading's OWN, and nothing else may ride along;
 * 5. **D3/D4** — {@link buildOwnObservation} projects the reading, and the
 *    evaluators settle on that projection.
 *
 * The result carries `reviewed` (§9.2). Evaluation is NOT gated on review,
 * because backtests and research legitimately settle unverified specs; what is
 * gated is *activation* — see `classifySettlementActivation`.
 */
export function evaluateSettlement(
  spec: SettlementSpec,
  observation: SettlementObservation,
): SettlementResult<SettlementEvaluation> {
  const selected = selectPayoffModel(spec);
  if (!selected.ok) {
    return selected;
  }

  const read = readOwnObservation(observation);
  if (!read.ok) {
    return settlementFailure(
      observationInvalid([`(root): the value is not observation data: ${read.detail}`]),
    );
  }
  const tree = read.value;

  const observationModel: unknown = ownField(tree, "model");
  if (observationModel !== selected.value) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_OBSERVATION_MODEL_MISMATCH",
        `the spec selects ${selected.value} but the observation is a ${String(observationModel)} reading`,
        { selectedModel: selected.value, observationModel },
      ),
    );
  }
  const observationSymbol: unknown = ownField(tree, "referenceSymbol");
  const specSymbol: unknown = ownField(spec, "referenceSymbol");
  if (observationSymbol !== specSymbol) {
    return settlementFailure(
      settlementRefusal(
        "SETTLEMENT_OBSERVATION_SYMBOL_MISMATCH",
        `the spec settles ${String(specSymbol)} but the observation is of ${String(observationSymbol)}`,
        { specSymbol, observationSymbol },
      ),
    );
  }

  const issues = observationOwnIssues(selected.value, tree);
  if (issues.length > 0) {
    return settlementFailure(observationInvalid(issues));
  }

  switch (selected.value) {
    case "TerminalSpotBinaryModel":
      return evaluateTerminalSpot(
        spec,
        buildOwnObservation<TerminalSpotObservation>(selected.value, tree),
      );
    case "TwapBinaryModel":
      return evaluateTwap(spec, buildOwnObservation<TwapObservation>(selected.value, tree));
    case "ReferenceOpenUpDownModel":
      return evaluateReferenceOpenUpDown(
        spec,
        buildOwnObservation<ReferenceOpenUpDownObservation>(selected.value, tree),
      );
    case "ThresholdByDateModel":
      return evaluateThresholdByDate(
        spec,
        buildOwnObservation<ThresholdByDateObservation>(selected.value, tree),
      );
  }
}
