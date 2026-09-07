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
import { ownEmit, ownField } from "./spec-door.js";
import {
  safeParseSettlementSpec,
  settlementSpecReviewBlockers,
  settlementVerificationStatus,
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

/**
 * D4 (ADR-020 §3): the verdict is emitted with a NULL PROTOTYPE, frozen, in the
 * declared key order.
 *
 * The consumer of this record is `@polymarket-bot/universe`'s eligibility
 * check, and the question it asks is whether activation is allowed. An emitted
 * record with an ordinary prototype answers `verdict.payoffModel` — or any
 * field a future consumer reads with `?? default` — out of `Object.prototype`
 * when the verdict does not carry it.
 */
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
  const fields: (readonly [string, unknown])[] = [
    ["status", status],
    ["modelDependentActivationAllowed", status === ACTIVATION_PERMITTED_STATUS],
  ];
  for (const key of ["settlementSpecId", "seriesId", "rulesVersionId", "payoffModel"] as const) {
    const value = ownField(detail, key);
    if (value !== undefined) {
      fields.push([key, value]);
    }
  }
  fields.push(["refusals", Object.freeze([...refusals])]);
  return ownEmit<SettlementActivationVerdict>(fields);
}

/**
 * Classifies a series' settlement binding for model-dependent activation.
 *
 * Every branch that is not `REVIEWED_MODEL_BACKED` carries at least one
 * refusal, so an operator always has a reason and a metric always has a label.
 *
 * PROTOTYPE-SAFE READS (ADR-020 §3 D3; `docs/contracts/schema-boundary.md` §3,
 * probe N). Three reads on this path decide activation and all three are own
 * reads:
 *
 * 1. `input.spec` — a dot read answers "is a spec bound to this series?" out of
 *    `Object.prototype`, so a series with NO binding could be classified
 *    against a document nobody bound to it;
 * 2. `input.reviewContext` — it carries the published-window list the
 *    `SPEC_VERIFICATION_UNSOUND` gate consults;
 * 3. the spec's own `verification.status`, at both gates below, through
 *    {@link settlementVerificationStatus}.
 *
 * The spec itself is the door's own prototype-free emission
 * ({@link safeParseSettlementSpec}), so every later read of it is answered by
 * the document and by nothing else.
 */
export function classifySettlementActivation(
  input: SettlementActivationInput = {},
): SettlementActivationVerdict {
  const candidate = ownField(input, "spec");
  if (candidate === undefined || candidate === null) {
    return verdict("SPEC_MISSING", [
      settlementRefusal(
        "SETTLEMENT_SPEC_MISSING",
        "no settlement spec is bound to this series; §9.2 requires each reviewed series to be bound to one",
      ),
    ]);
  }

  const parsed = safeParseSettlementSpec(candidate);
  if (!parsed.ok) {
    return verdict("SPEC_INVALID", [parsed.refusal]);
  }
  const spec: SettlementSpec = parsed.spec;
  const rulesVersionId = ownField(spec, "rulesVersionId");
  const identity = {
    settlementSpecId: spec.settlementSpecId,
    seriesId: spec.seriesId,
    ...(rulesVersionId === undefined ? {} : { rulesVersionId: rulesVersionId as string }),
  };

  const selected = selectPayoffModel(spec);
  if (!selected.ok) {
    return verdict("SPEC_NO_PAYOFF_MODEL", selected.refusals, identity);
  }
  const withModel = { ...identity, payoffModel: selected.value };
  const verificationStatus = settlementVerificationStatus(spec);

  if (verificationStatus === "REJECTED") {
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

  // `!== "VERIFIED"` rather than `=== "UNVERIFIED"`, and an OWN read rather
  // than `spec.verification.status`: a document that states no review outcome
  // of its own has none, whatever `Object.prototype` says, and it falls on the
  // blocking side of the gate rather than through it. The measured cell is
  // exactly this one — a spec carrying no `verification` key at all cleared
  // both gates and activated as `REVIEWED_MODEL_BACKED`.
  if (verificationStatus !== "VERIFIED") {
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
  const reviewContext = ownField(input, "reviewContext");
  const blockers = settlementSpecReviewBlockers(
    spec,
    (reviewContext as SettlementReviewContext | undefined) ?? {},
  );
  if (blockers.length > 0) {
    return verdict("SPEC_VERIFICATION_UNSOUND", blockers, withModel);
  }

  return verdict("REVIEWED_MODEL_BACKED", [], withModel);
}
