/**
 * Which payoff model may settle which observation, and what each combination
 * requires of the spec — handoff §9.3, ADR-009 §2.
 *
 * §9.3 states one rule by name: "A terminal-spot model must not be used for a
 * TWAP-settled market." That rule exists because getting it wrong is SILENT: a
 * terminal spot and a 30-second average of the same feed differ by a few basis
 * points, so the wrong model does not crash — it settles a position at a price
 * the venue never used, and the error only ever appears as unexplained PnL.
 *
 * Every other cell of the matrix below is stated for the same reason and is
 * justified in the cell's own note. The matrix is TOTAL: every one of the
 * 5 observation types × 4 payoff models has an explicit verdict, and
 * `compatibility.test.ts` walks all 20 rather than sampling.
 *
 * ```text
 *                 | TerminalSpotBinary | TwapBinary | ReferenceOpenUpDown | ThresholdByDate
 * TERMINAL_SPOT   |         yes        |     no     |         yes         |      yes
 * TWAP            |    no (§9.3)       |     yes    |         yes         |      no
 * VWAP            |         no         |     no     |         no          |      no
 * EVENT_RESULT    |         no         |     no     |         no          |      no
 * MANUAL_ORACLE   |         no         |     no     |         no          |      no
 * ```
 *
 * The three empty rows are ADR-009 §2: `VWAP`, `EVENT_RESULT` and
 * `MANUAL_ORACLE` "have no model in the §9.3 list … It is not an invitation to
 * approximate with the nearest available model."
 */

import { settlementRefusal, type SettlementRefusal } from "../errors.js";
import type { ComparisonOperator, ObservationType, PayoffModelId } from "../vocabulary.js";
import { OBSERVATION_TYPES, PAYOFF_MODEL_IDS } from "../vocabulary.js";

/**
 * The spec fields whose presence or absence a model constrains.
 *
 * Deliberately a closed union rather than `keyof SettlementSpec`: these are the
 * fields that change what is computed, and a new spec field must be considered
 * here explicitly rather than joining silently.
 */
export type ConstrainedSpecField =
  | "comparison"
  | "windowSeconds"
  | "windowStartRule"
  | "windowEndRule"
  | "strikeSource"
  | "referenceOpenSource";

/**
 * The part of a settlement spec these rules read.
 *
 * Structural rather than the full `SettlementSpec` so the compatibility rules
 * can be applied *inside* the spec schema's own refinement without a circular
 * import.
 */
export interface PayoffModelSpecView {
  readonly observationType: ObservationType;
  readonly payoffModel?: PayoffModelId | undefined;
  readonly comparison?: ComparisonOperator | undefined;
  readonly windowSeconds?: number | undefined;
  readonly windowStartRule?: string | undefined;
  readonly windowEndRule?: string | undefined;
  readonly strikeSource?: string | undefined;
  readonly referenceOpenSource?: string | undefined;
}

/** What a (model, observation type) pair requires and forbids of the spec. */
export interface PayoffModelFieldRequirements {
  readonly required: readonly ConstrainedSpecField[];
  readonly forbidden: readonly ConstrainedSpecField[];
  /** Why this combination is permitted at all, for operator-facing output. */
  readonly rationale: string;
}

const WINDOW_FIELDS = ["windowSeconds", "windowStartRule", "windowEndRule"] as const;

/**
 * The permitted (model → observation types) map with each cell's rationale.
 *
 * A model absent from an observation type's list is refused; there is no
 * fallback and no default.
 */
const COMPATIBILITY: Readonly<
  Record<PayoffModelId, Partial<Record<ObservationType, PayoffModelFieldRequirements>>>
> = Object.freeze({
  TerminalSpotBinaryModel: {
    TERMINAL_SPOT: {
      required: ["comparison", "strikeSource"],
      // A terminal spot is one observation at one instant. A spec that also
      // names an averaging window is ambiguous about which value settles it,
      // and the ambiguity resolves silently — exactly the §9.3 failure mode.
      forbidden: [...WINDOW_FIELDS, "referenceOpenSource"],
      rationale:
        "A single terminal observation of the reference symbol is compared against the spec's strike (§9.3).",
    },
  },
  TwapBinaryModel: {
    TWAP: {
      required: ["comparison", "strikeSource", ...WINDOW_FIELDS],
      forbidden: ["referenceOpenSource"],
      rationale:
        "A time-weighted average over the spec's declared window is compared against the spec's strike (§9.3, ADR-009 §6).",
    },
    // TERMINAL_SPOT is refused for the mirror image of the §9.3 rule: averaging
    // a value the venue does not average is as silently wrong as not averaging
    // one it does.
  },
  ReferenceOpenUpDownModel: {
    TERMINAL_SPOT: {
      required: ["comparison", "referenceOpenSource"],
      // The strike IS the reference open. A spec naming both leaves two
      // candidate strikes and no rule for choosing between them.
      forbidden: [...WINDOW_FIELDS, "strikeSource"],
      rationale:
        "An up/down series: the terminal observation is compared against the market's own reference open (§9.2 `btc-15m-updown`).",
    },
    TWAP: {
      required: ["comparison", "referenceOpenSource", ...WINDOW_FIELDS],
      forbidden: ["strikeSource"],
      rationale:
        "An up/down series whose settlement observation is a TWAP over the spec's declared window, compared against the market's reference open.",
    },
  },
  ThresholdByDateModel: {
    TERMINAL_SPOT: {
      // The observation period is bounded by the market's deadline, not by a
      // fixed averaging length, so `windowSeconds` is forbidden while the start
      // and end RULES are required: a "by date" question is meaningless without
      // stating from and until when the threshold may be met.
      required: ["comparison", "strikeSource", "windowStartRule", "windowEndRule"],
      forbidden: ["windowSeconds", "referenceOpenSource"],
      rationale:
        "A threshold-by-date question: the extreme observed value within the stated period is compared against the spec's threshold (§9.3).",
    },
  },
});

/** The models permitted for an observation type, in §9.3 order. Possibly empty. */
export function payoffModelsForObservationType(
  observationType: ObservationType,
): readonly PayoffModelId[] {
  return PAYOFF_MODEL_IDS.filter((model) => COMPATIBILITY[model][observationType] !== undefined);
}

/** The observation types a model may settle, in §9.3 order. Never empty. */
export function observationTypesForPayoffModel(
  model: PayoffModelId,
): readonly ObservationType[] {
  return OBSERVATION_TYPES.filter(
    (observationType) => COMPATIBILITY[model][observationType] !== undefined,
  );
}

/** Whether a model may settle an observation type at all. */
export function isCompatiblePayoffModel(
  observationType: ObservationType,
  model: PayoffModelId,
): boolean {
  return COMPATIBILITY[model][observationType] !== undefined;
}

/**
 * What the pair requires of the spec, or `undefined` when the pair is refused.
 */
export function payoffModelRequirements(
  observationType: ObservationType,
  model: PayoffModelId,
): PayoffModelFieldRequirements | undefined {
  return COMPATIBILITY[model][observationType];
}

function fieldIsPresent(view: PayoffModelSpecView, field: ConstrainedSpecField): boolean {
  return view[field] !== undefined;
}

/**
 * Every reason the declared model and the spec do not fit together, in a stable
 * order. An empty array means the pair is usable.
 *
 * Reported as a LIST rather than the first failure so an operator repairing a
 * spec sees every problem at once instead of one per round trip.
 */
export function checkPayoffModelCompatibility(
  view: PayoffModelSpecView,
): readonly SettlementRefusal[] {
  const { observationType, payoffModel } = view;
  const refusals: SettlementRefusal[] = [];

  if (payoffModel === undefined) {
    const candidates = payoffModelsForObservationType(observationType);
    refusals.push(
      candidates.length === 0
        ? settlementRefusal(
            "SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL",
            `observation type ${observationType} has no implementing payoff model (§9.3 lists four models; ADR-009 §2 forbids approximating with the nearest one)`,
            { observationType },
          )
        : settlementRefusal(
            "SETTLEMENT_SPEC_FIELD_REQUIRED",
            `settlement spec declares no payoff model; observation type ${observationType} permits ${candidates.join(", ")}`,
            { field: "payoffModel", observationType, candidates },
          ),
    );
    return Object.freeze(refusals);
  }

  const requirements = payoffModelRequirements(observationType, payoffModel);
  if (requirements === undefined) {
    const candidates = payoffModelsForObservationType(observationType);
    if (observationType === "TWAP" && payoffModel === "TerminalSpotBinaryModel") {
      refusals.push(
        settlementRefusal(
          "SETTLEMENT_TWAP_TERMINAL_SPOT_FORBIDDEN",
          "a terminal-spot model must not be used for a TWAP-settled market (§9.3; ADR-009 §2)",
          { observationType, payoffModel, candidates },
        ),
      );
      return Object.freeze(refusals);
    }
    refusals.push(
      settlementRefusal(
        candidates.length === 0
          ? "SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL"
          : "SETTLEMENT_MODEL_OBSERVATION_INCOMPATIBLE",
        candidates.length === 0
          ? `observation type ${observationType} has no implementing payoff model, so ${payoffModel} cannot settle it (ADR-009 §2)`
          : `payoff model ${payoffModel} cannot settle a ${observationType} observation; permitted: ${candidates.join(", ")}`,
        { observationType, payoffModel, candidates },
      ),
    );
    return Object.freeze(refusals);
  }

  for (const field of requirements.required) {
    if (!fieldIsPresent(view, field)) {
      refusals.push(
        settlementRefusal(
          "SETTLEMENT_SPEC_FIELD_REQUIRED",
          `payoff model ${payoffModel} on a ${observationType} observation requires \`${field}\``,
          { field, observationType, payoffModel },
        ),
      );
    }
  }

  for (const field of requirements.forbidden) {
    if (fieldIsPresent(view, field)) {
      refusals.push(
        settlementRefusal(
          "SETTLEMENT_SPEC_FIELD_FORBIDDEN",
          `payoff model ${payoffModel} on a ${observationType} observation must not declare \`${field}\`; it would leave the settlement value ambiguous`,
          { field, observationType, payoffModel },
        ),
      );
    }
  }

  return Object.freeze(refusals);
}
