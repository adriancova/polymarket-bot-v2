/**
 * The model-dependent activation gate — handoff §9.2, work plan `WP-110`
 * acceptance 3 ("Unverified settlement spec blocks model-dependent
 * activation").
 *
 * §9.2 makes this a Universe Service responsibility ("Reject model-dependent
 * strategy activation on unverified settlement specs") while §9.3 puts the
 * knowledge — what a spec is, whether a model implements it — here. Those two
 * packages are the SAME dependency layer
 * (`docs/contracts/dependency-direction.md` §2, layer 1) and no §2.1 row
 * permits an edge between them, so this package publishes a VERDICT and
 * `@polymarket-bot/universe` consumes it as an injected port. The composition
 * root wires the two; a divergence between the two status unions is a
 * type error at that wiring site rather than a silent mismatch.
 *
 * The gate is deliberately one-way: exactly one status permits activation and
 * every other outcome — missing, invalid, unreviewed, rejected, modelless, or
 * claiming a review it cannot support — blocks it.
 */

import {
  settlementRefusal,
  type SettlementRefusal,
} from "./errors.js";
import { selectPayoffModel } from "./models/registry.js";
import {
  safeParseSettlementSpec,
  settlementSpecReviewBlockers,
  type SettlementReviewContext,
  type SettlementSpec,
} from "./spec.js";
import type { PayoffModelId } from "./vocabulary.js";

/**
 * Why a series may or may not back a model-dependent strategy.
 *
 * `SPEC_UNVERIFIED` and `SPEC_REJECTED` are distinct because the operator
 * response differs: one needs a review, the other needs a new spec.
 * `SPEC_VERIFICATION_UNSOUND` is a spec that CLAIMS a review it cannot support
 * — an unnamed rules version, or a window nothing publishes (ADR-009 §6) —
 * which is a more serious condition than "not yet reviewed" and must not be
 * reported as the same thing.
 */
export const SETTLEMENT_ACTIVATION_STATUSES = [
  "REVIEWED_MODEL_BACKED",
  "SPEC_MISSING",
  "SPEC_INVALID",
  "SPEC_NO_PAYOFF_MODEL",
  "SPEC_UNVERIFIED",
  "SPEC_REJECTED",
  "SPEC_VERIFICATION_UNSOUND",
] as const;

export type SettlementActivationStatus = (typeof SETTLEMENT_ACTIVATION_STATUSES)[number];

/** The one status under which model-dependent activation is permitted. */
export const ACTIVATION_PERMITTED_STATUS: SettlementActivationStatus = "REVIEWED_MODEL_BACKED";

/** The verdict `@polymarket-bot/universe` consumes. */
export interface SettlementActivationVerdict {
  readonly status: SettlementActivationStatus;
  /** True for exactly one status; carried explicitly so a consumer cannot mis-branch. */
  readonly modelDependentActivationAllowed: boolean;
  /** Present when a spec was supplied and parsed. */
  readonly settlementSpecId?: string;
  readonly seriesId?: string;
  /**
   * The rules version the spec was reviewed against, when it names one.
   *
   * The universe layer compares it with the market's current rules version:
   * a spec reviewed against superseded rules is not a review of what is
   * trading now (§6 invariant 9).
   */
  readonly rulesVersionId?: string;
  /** The selected model, present only when one was selectable. */
  readonly payoffModel?: PayoffModelId;
  /** Every reason activation is refused, in a stable order. Empty when permitted. */
  readonly refusals: readonly SettlementRefusal[];
}

export interface SettlementActivationInput {
  /**
   * The series' bound settlement spec: a parsed {@link SettlementSpec}, an
   * unparsed value from configuration or the catalog, or `undefined` when no
   * spec is bound at all.
   */
  readonly spec?: unknown;
  /** Feed context for the review checks; see {@link SettlementReviewContext}. */
  readonly reviewContext?: SettlementReviewContext;
}

function verdict(
  status: SettlementActivationStatus,
  refusals: readonly SettlementRefusal[],
  detail: {
    readonly settlementSpecId?: string;
    readonly seriesId?: string;
    readonly rulesVersionId?: string;
    readonly payoffModel?: PayoffModelId;
  } = {},
): SettlementActivationVerdict {
  return Object.freeze({
    status,
    modelDependentActivationAllowed: status === ACTIVATION_PERMITTED_STATUS,
    ...detail,
    refusals: Object.freeze([...refusals]),
  });
}

/**
 * Classifies a series' settlement binding for model-dependent activation.
 *
 * Every branch that is not `REVIEWED_MODEL_BACKED` carries at least one
 * refusal, so an operator always has a reason and a metric always has a label.
 */
export function classifySettlementActivation(
  input: SettlementActivationInput = {},
): SettlementActivationVerdict {
  if (input.spec === undefined || input.spec === null) {
    return verdict("SPEC_MISSING", [
      settlementRefusal(
        "SETTLEMENT_SPEC_MISSING",
        "no settlement spec is bound to this series; §9.2 requires each reviewed series to be bound to one",
      ),
    ]);
  }

  const parsed = safeParseSettlementSpec(input.spec);
  if (!parsed.ok) {
    return verdict("SPEC_INVALID", [parsed.refusal]);
  }
  const spec: SettlementSpec = parsed.spec;
  const identity = {
    settlementSpecId: spec.settlementSpecId,
    seriesId: spec.seriesId,
    ...(spec.rulesVersionId === undefined ? {} : { rulesVersionId: spec.rulesVersionId }),
  };

  const selected = selectPayoffModel(spec);
  if (!selected.ok) {
    return verdict("SPEC_NO_PAYOFF_MODEL", selected.refusals, identity);
  }
  const withModel = { ...identity, payoffModel: selected.value };

  if (spec.verification.status === "REJECTED") {
    return verdict(
      "SPEC_REJECTED",
      [
        settlementRefusal(
          "SETTLEMENT_SPEC_REJECTED",
          "the settlement spec was reviewed and rejected; a new spec version is required",
          identity,
        ),
      ],
      withModel,
    );
  }

  if (spec.verification.status === "UNVERIFIED") {
    return verdict(
      "SPEC_UNVERIFIED",
      [
        settlementRefusal(
          "SETTLEMENT_SPEC_UNVERIFIED",
          "the settlement spec carries no `verified_by`/`verified_at`; §9.2 blocks model-dependent activation on an unverified spec",
          identity,
        ),
      ],
      withModel,
    );
  }

  // The spec claims a review. A claim is not evidence: re-check the conditions
  // that must have held when it was made, because the world (a feed's published
  // windows) can move underneath a spec that was correct when signed.
  const blockers = settlementSpecReviewBlockers(spec, input.reviewContext ?? {});
  if (blockers.length > 0) {
    return verdict("SPEC_VERIFICATION_UNSOUND", blockers, withModel);
  }

  return verdict("REVIEWED_MODEL_BACKED", [], withModel);
}
