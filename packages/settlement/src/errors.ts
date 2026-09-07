/**
 * Typed refusals and errors (handoff §21: "Errors are typed and observable").
 *
 * Two shapes, deliberately distinct:
 *
 * - A {@link SettlementRefusal} is DATA. It is what every function in this
 *   package returns when a settlement question has a legitimate negative answer
 *   — an unverified spec, an observation type with no model, a payoff that this
 *   repository refuses to invent. Refusals are returned rather than thrown
 *   because the caller (the universe eligibility check, an operational report)
 *   must be able to collect *all* of them and show an operator the whole list.
 * - A {@link SettlementError} is a THROW, reserved for a caller that handed this
 *   package something structurally impossible (a value that is not a spec at
 *   all). It is a programming error, not a settlement outcome.
 *
 * Every refusal carries a stable `code` so a consumer branches on the code and
 * a metric labels on it (§14.3), never on message text.
 */

/**
 * Stable refusal codes.
 *
 * Grouped by the question each answers. Adding a code is additive; changing the
 * meaning of one is not, because operators alert on them.
 */
export type SettlementRefusalCode =
  // --- spec structure -------------------------------------------------------
  /** The value is not a valid `SettlementSpec` (schema failure). */
  | "SETTLEMENT_SPEC_INVALID"
  /** No spec is bound to the series at all (§9.2 "bind each reviewed series"). */
  | "SETTLEMENT_SPEC_MISSING"
  /** A field the selected payoff model requires is absent. */
  | "SETTLEMENT_SPEC_FIELD_REQUIRED"
  /** A field the selected payoff model must not carry is present (ambiguous spec). */
  | "SETTLEMENT_SPEC_FIELD_FORBIDDEN"
  /**
   * A required policy field states a placeholder rather than a policy.
   *
   * ADR-009 §5.4: "'Halt and escalate' is a legitimate policy; 'unspecified' is
   * not."
   */
  | "SETTLEMENT_POLICY_PLACEHOLDER"

  // --- model selection ------------------------------------------------------
  /**
   * The declared payoff model is not permitted for the spec's `observation_type`.
   *
   * The TWAP/terminal-spot case has its own code below because §9.3 states it
   * by name and the work plan makes it an acceptance criterion.
   */
  | "SETTLEMENT_MODEL_OBSERVATION_INCOMPATIBLE"
  /**
   * §9.3: "A terminal-spot model must not be used for a TWAP-settled market."
   * Work plan `WP-110` acceptance 1; ADR-009 §2.
   */
  | "SETTLEMENT_TWAP_TERMINAL_SPOT_FORBIDDEN"
  /**
   * The spec's `observation_type` has no implementing model.
   *
   * ADR-009 §2: `VWAP`, `EVENT_RESULT` and `MANUAL_ORACLE` "have no model in the
   * §9.3 list … It is not an invitation to approximate with the nearest
   * available model."
   */
  | "SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL"

  // --- review / verification ------------------------------------------------
  /** The spec has not been reviewed; model-dependent activation is blocked (§9.2). */
  | "SETTLEMENT_SPEC_UNVERIFIED"
  /** The spec was reviewed and rejected. */
  | "SETTLEMENT_SPEC_REJECTED"
  /** A verified spec must name the market rules version it was reviewed against. */
  | "SETTLEMENT_RULES_VERSION_REQUIRED"
  /**
   * A windowed observation names a window the resolution feed does not publish.
   *
   * ADR-009 §6 rule 1: such a spec "cannot be marked verified, because nothing
   * would produce the observation it depends on".
   */
  | "SETTLEMENT_WINDOW_NOT_PUBLISHED"
  /** The caller did not state which observation windows the feed publishes. */
  | "SETTLEMENT_PUBLISHED_WINDOWS_UNKNOWN"

  // --- observation ----------------------------------------------------------
  /** The observation belongs to a different payoff model than the spec selects. */
  | "SETTLEMENT_OBSERVATION_MODEL_MISMATCH"
  /** The observation's averaging window is not the window the spec declares. */
  | "SETTLEMENT_OBSERVATION_WINDOW_MISMATCH"
  /** The observation is of a different reference symbol than the spec declares. */
  | "SETTLEMENT_OBSERVATION_SYMBOL_MISMATCH"
  /** The observation window is empty or inverted. */
  | "SETTLEMENT_OBSERVATION_WINDOW_INVALID"
  /**
   * A threshold-by-date observation carries the wrong extreme for its comparison
   * (a `GT`/`GTE` question is answered by the maximum, `LT`/`LTE` by the minimum).
   */
  | "SETTLEMENT_EXTREME_DIRECTION_MISMATCH"
  /** A timestamp in the observation is not a parseable ISO-8601 instant. */
  | "SETTLEMENT_TIMESTAMP_INVALID"

  // --- payout ---------------------------------------------------------------
  /** The outcome state is non-terminal, so no payoff is determined (ADR-009 §4). */
  | "SETTLEMENT_OUTCOME_NOT_TERMINAL"
  /**
   * `CANCELLED` payout mechanics are NOT documented by the venue.
   *
   * The resolution documentation retrieved 2026-08-28 documents redemption for a
   * winning token (`$1.00`), a losing token (`$0.00`) and the 50/50 outcome
   * (`$0.50` each) and documents no cancellation/void path at all. This package
   * therefore refuses to compute a cancellation payout rather than invent one
   * (`AGENTS.md`: "never silently invent venue behavior"). See `README.md` §5.
   */
  | "SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED";

export type SettlementRefusalDetails = Readonly<Record<string, unknown>>;

/** A settlement question answered "no", with the reason machine-readable. */
export interface SettlementRefusal {
  readonly code: SettlementRefusalCode;
  readonly message: string;
  readonly details: SettlementRefusalDetails;
}

/**
 * Builds a refusal. Kept as a function so every refusal has the same shape.
 *
 * D4 (ADR-020 §3): the refusal and its `details` are emitted with a NULL
 * PROTOTYPE, so a consumer branching on `refusal.details["field"]` — the
 * schema's own refinement does exactly that — reads what this package put
 * there, or nothing. `details` is copied key by key from the caller's OWN
 * properties, so an inherited key cannot ride into a refusal either.
 */
export function settlementRefusal(
  code: SettlementRefusalCode,
  message: string,
  details: SettlementRefusalDetails = {},
): SettlementRefusal {
  const copied = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(details)) {
    if (key !== "__proto__" && Object.hasOwn(details, key)) {
      copied[key] = details[key];
    }
  }
  const refusal = Object.create(null) as { code: SettlementRefusalCode; message: string; details: SettlementRefusalDetails };
  refusal.code = code;
  refusal.message = message;
  refusal.details = Object.freeze(copied);
  return Object.freeze(refusal);
}

/** A successful result, or the refusals that prevented it. */
export type SettlementResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusals: readonly SettlementRefusal[] };

/** Wraps a value as a successful result. */
export function settlementOk<T>(value: T): SettlementResult<T> {
  return { ok: true, value };
}

/** Wraps one or more refusals as a failed result. */
export function settlementFailure<T>(
  ...refusals: readonly SettlementRefusal[]
): SettlementResult<T> {
  return { ok: false, refusals: Object.freeze([...refusals]) };
}

/**
 * A caller error: the input could not be interpreted as a settlement artifact.
 *
 * Thrown only by the `assert*` / `parse*` entry points. The `safe*` variants of
 * those functions return a refusal instead.
 */
export class SettlementError extends Error {
  readonly code: SettlementRefusalCode;
  readonly details: SettlementRefusalDetails;

  constructor(
    code: SettlementRefusalCode,
    message: string,
    details: SettlementRefusalDetails = {},
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** The value is not a valid settlement spec. */
export class SettlementSpecValidationError extends SettlementError {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super("SETTLEMENT_SPEC_INVALID", message, { issues });
    this.issues = Object.freeze([...issues]);
  }
}
