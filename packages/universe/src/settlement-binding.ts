/**
 * The settlement port — how this package learns whether a series' settlement
 * spec permits model-dependent strategy activation.
 *
 * WHY A PORT AND NOT AN IMPORT. Handoff §9.2 gives the Universe Service the
 * responsibility to "Reject model-dependent strategy activation on unverified
 * settlement specs", while §9.3 puts the knowledge of what a spec IS in the
 * settlement layer. `packages/universe` and `packages/settlement` are the SAME
 * layer (`docs/contracts/dependency-direction.md` §2, layer 1) and §2.1 — the
 * exhaustive list of permitted same-layer edges — contains no row for either
 * direction. An unlisted same-layer edge is violation F13 and the check fails
 * closed, so this package declares the shape it needs and the composition root
 * supplies a value.
 *
 * THE PERMITTED ARM IS DISCRIMINATED AND COMPLETE (round-1 review, H2). A
 * verdict that claims `REVIEWED_MODEL_BACKED` must NAME what was reviewed:
 * the series, the settlement spec, the rules version, and the selected payoff
 * model, and it must carry an EMPTY refusal list. Anything less is not a
 * permission this package will correlate — `eligibility.ts` refuses it. A
 * blocked verdict may be sparse, because a refusal needs no identity to be
 * safe.
 *
 * DRIFT: {@link SETTLEMENT_ACTIVATION_STATUSES} mirrors the settlement
 * package's union. `settlement-binding.test.ts` pins the two lists against the
 * settlement package's SOURCE TEXT (a test-only file read; no import edge in
 * either direction), so a vocabulary change on either side fails a test here
 * rather than diverging silently. The composition root that wires the two
 * packages additionally narrows the settlement verdict into this union, so a
 * structural divergence is a type error at that wiring site.
 *
 * TRUST: this package does not re-derive the verdict, but it does not take it
 * on faith either. `eligibility.ts` requires `status` and
 * `modelDependentActivationAllowed` to agree
 * ({@link isConsistentSettlementActivation}), requires a permitting verdict to
 * be complete ({@link permittedSettlementActivationProblems}), and correlates
 * every identity the verdict names with the market's own records.
 */

/**
 * The settlement layer's activation verdict vocabulary.
 *
 * Exactly one member permits activation; every other member is a distinct
 * reason it is refused.
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
export const ACTIVATION_PERMITTED_STATUS = "REVIEWED_MODEL_BACKED" as const;

/** Every status that blocks activation. */
export type BlockedSettlementActivationStatus = Exclude<
  SettlementActivationStatus,
  typeof ACTIVATION_PERMITTED_STATUS
>;

/** A refusal as the settlement layer reports it (structural, not imported). */
export interface SettlementRefusalView {
  readonly code: string;
  readonly message: string;
}

/**
 * A verdict that PERMITS model-dependent activation.
 *
 * Every identity-bearing field is REQUIRED: a permission that does not say
 * which series, which spec, which rules version and which model it reviewed
 * cannot be correlated with the market it is applied to, and an uncorrelated
 * permission is how a verdict for series A activates a market bound to
 * series B (round-1 review, H2). `refusals` must be present and EMPTY — the
 * empty tuple type makes a permitted verdict carrying a refusal a COMPILE
 * error (round-2 review, L1), and
 * {@link permittedSettlementActivationProblems} still re-checks it at runtime
 * because a value can lie about its compile-time shape.
 */
export interface PermittedSettlementActivationView {
  readonly status: typeof ACTIVATION_PERMITTED_STATUS;
  readonly modelDependentActivationAllowed: true;
  readonly settlementSpecId: string;
  readonly seriesId: string;
  /** The market rules version the spec was reviewed against. */
  readonly rulesVersionId: string;
  readonly payoffModel: string;
  /**
   * Typed as the empty tuple: a verdict that carries any refusal is not a
   * permission, and the type now says so (round-2 review, L1).
   */
  readonly refusals: readonly [];
}

/** A verdict that BLOCKS activation. May be sparse: a refusal needs no identity. */
export interface BlockedSettlementActivationView {
  readonly status: BlockedSettlementActivationStatus;
  readonly modelDependentActivationAllowed: false;
  readonly settlementSpecId?: string | undefined;
  readonly seriesId?: string | undefined;
  readonly rulesVersionId?: string | undefined;
  readonly payoffModel?: string | undefined;
  readonly refusals?: readonly SettlementRefusalView[] | undefined;
}

/**
 * The settlement layer's verdict for one series, discriminated on `status`.
 *
 * The composition root narrows `SettlementActivationVerdict` from
 * `@polymarket-bot/settlement` into this union when it wires the packages.
 */
export type SettlementActivationView =
  | PermittedSettlementActivationView
  | BlockedSettlementActivationView;

/**
 * The same fields with nothing guaranteed — what a runtime value might
 * actually be before this package has checked it. Validation entry points
 * accept this shape so that adversarial and legacy values can be examined
 * rather than trusted via their compile-time type.
 */
export interface UnvalidatedSettlementActivationView {
  readonly status: SettlementActivationStatus;
  readonly modelDependentActivationAllowed: boolean;
  readonly settlementSpecId?: string | undefined;
  readonly seriesId?: string | undefined;
  readonly rulesVersionId?: string | undefined;
  readonly payoffModel?: string | undefined;
  readonly refusals?: readonly SettlementRefusalView[] | undefined;
}

/** Whether a verdict is internally consistent about permitting activation. */
export function isConsistentSettlementActivation(
  view: UnvalidatedSettlementActivationView,
): boolean {
  return (
    view.modelDependentActivationAllowed === (view.status === ACTIVATION_PERMITTED_STATUS)
  );
}

/** One thing a permitting verdict failed to establish. */
export interface PermittedVerdictProblem {
  readonly field: string;
  readonly problem: string;
}

/**
 * Everything a verdict that CLAIMS to permit activation is missing.
 *
 * Empty for a complete permission. Runtime, not just type-level: a value can
 * lie about its compile-time shape, and every one of these fields is about to
 * be correlated against the market's own records — a missing field would
 * silently skip a correlation (round-1 review, H2).
 */
export function permittedSettlementActivationProblems(
  view: UnvalidatedSettlementActivationView,
): readonly PermittedVerdictProblem[] {
  const problems: PermittedVerdictProblem[] = [];
  const identityFields = [
    "settlementSpecId",
    "seriesId",
    "rulesVersionId",
    "payoffModel",
  ] as const;
  for (const field of identityFields) {
    const value = view[field];
    if (typeof value !== "string" || value.length === 0) {
      problems.push({
        field,
        problem: "a permitting verdict must name it, and it is absent or empty",
      });
    }
  }
  if (!Array.isArray(view.refusals)) {
    problems.push({
      field: "refusals",
      problem: "a permitting verdict must carry an explicit empty refusal list",
    });
  } else if (view.refusals.length > 0) {
    problems.push({
      field: "refusals",
      problem: "a permitting verdict must not carry refusals",
    });
  }
  return Object.freeze(problems);
}
