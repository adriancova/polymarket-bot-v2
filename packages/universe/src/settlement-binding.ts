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
 * The shape is deliberately MINIMAL: a status token, the boolean the settlement
 * layer derived from it, and identifiers this package genuinely compares
 * against its own records. Everything about how a spec is validated stays on the
 * other side of the port.
 *
 * DRIFT: {@link SETTLEMENT_ACTIVATION_STATUSES} mirrors the settlement
 * package's union. Because the two are wired together at a composition root, a
 * divergence is a TypeScript error at that wiring site — the settlement
 * verdict simply stops being assignable to {@link SettlementActivationView} —
 * rather than a silent mismatch. `settlement-binding.test.ts` pins the token
 * list so a change here is a deliberate edit.
 *
 * TRUST: this package does not re-derive the verdict, but it does not take it
 * on faith either. {@link readSettlementActivation} requires `status` and
 * `modelDependentActivationAllowed` to agree, refuses a verdict that permits
 * activation on any status other than the single permitted one, and (in
 * `eligibility.ts`) checks the reviewed rules version against the version the
 * market is actually trading under.
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
export const ACTIVATION_PERMITTED_STATUS: SettlementActivationStatus = "REVIEWED_MODEL_BACKED";

/** A refusal as the settlement layer reports it (structural, not imported). */
export interface SettlementRefusalView {
  readonly code: string;
  readonly message: string;
}

/**
 * The settlement layer's verdict for one series.
 *
 * Structurally satisfied by `SettlementActivationVerdict` from
 * `@polymarket-bot/settlement`.
 */
export interface SettlementActivationView {
  readonly status: SettlementActivationStatus;
  readonly modelDependentActivationAllowed: boolean;
  readonly settlementSpecId?: string | undefined;
  readonly seriesId?: string | undefined;
  /** The market rules version the spec was reviewed against, when it names one. */
  readonly rulesVersionId?: string | undefined;
  readonly payoffModel?: string | undefined;
  readonly refusals?: readonly SettlementRefusalView[] | undefined;
}

/** Whether a verdict is internally consistent about permitting activation. */
export function isConsistentSettlementActivation(view: SettlementActivationView): boolean {
  return (
    view.modelDependentActivationAllowed === (view.status === ACTIVATION_PERMITTED_STATUS)
  );
}
