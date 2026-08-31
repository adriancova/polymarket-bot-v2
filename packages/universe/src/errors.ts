/**
 * Typed refusals and errors (handoff §21: "Errors are typed and observable").
 *
 * As in `@polymarket-bot/settlement`, a REFUSAL is data: the registry answers
 * "no" by returning the reason, because a caller assembling an operator view
 * needs every reason at once. A THROW is reserved for a caller that handed this
 * package a structurally impossible value.
 *
 * Nothing here logs, and nothing here decides what to do about a refusal: this
 * package is pure, and the composition root owns the response.
 */

export type UniverseRefusalCode =
  // --- identity -------------------------------------------------------------
  /** The input is not a valid market registration, series definition, or event. */
  | "UNIVERSE_INPUT_INVALID"
  /** The market is not in the registry. */
  | "UNIVERSE_MARKET_UNKNOWN"
  /** A different internal market already claims this condition id. */
  | "UNIVERSE_CONDITION_ID_ALREADY_BOUND"
  /** A different internal market already claims this outcome token id. */
  | "UNIVERSE_TOKEN_ID_ALREADY_BOUND"
  /** The internal market id is already registered with a different identity. */
  | "UNIVERSE_MARKET_IDENTITY_CONFLICT"

  // --- series ---------------------------------------------------------------
  /** The series is not in the registry. */
  | "UNIVERSE_SERIES_UNKNOWN"
  /** A different series already claims this series key. */
  | "UNIVERSE_SERIES_KEY_ALREADY_BOUND"
  /** The series is already registered with a different definition. */
  | "UNIVERSE_SERIES_CONFLICT"
  /** The market is not bound to any series. */
  | "UNIVERSE_SERIES_UNBOUND"
  /**
   * The market's series binding is a SUGGESTION, not an approval.
   *
   * §9.2: "The system may suggest a series match, but a new market pattern is
   * not auto-approved for live trading."
   */
  | "UNIVERSE_SERIES_BINDING_NOT_APPROVED"
  /** The series exists but is marked inactive. */
  | "UNIVERSE_SERIES_INACTIVE"

  // --- versioned parameters -------------------------------------------------
  /** The proposed parameter snapshot is identical to the current version. */
  | "UNIVERSE_PARAMETERS_UNCHANGED"
  /** The proposed version was observed before the version it would follow. */
  | "UNIVERSE_PARAMETER_HISTORY_OUT_OF_ORDER"
  /** A `TradingParametersChanged` event names a version the registry has not recorded. */
  | "UNIVERSE_PARAMETERS_VERSION_UNKNOWN"
  /** A `TradingParametersChanged` event contradicts the recorded parameter version. */
  | "UNIVERSE_PARAMETERS_EVENT_DISAGREES"

  // --- lifecycle ------------------------------------------------------------
  /** The event would move the market backwards through its lifecycle. */
  | "UNIVERSE_LIFECYCLE_REGRESSION"
  /** The event contradicts a lifecycle fact already recorded. */
  | "UNIVERSE_LIFECYCLE_CONFLICT"
  /** A second, different resolution for a market that is already terminal. */
  | "UNIVERSE_TERMINAL_OUTCOME_CONFLICT"
  /** Only `MarketResolved` may put a market into a terminal outcome state. */
  | "UNIVERSE_TERMINAL_OUTCOME_REQUIRES_EVENT"
  /** The event's rules version does not follow the recorded one. */
  | "UNIVERSE_RULES_VERSION_MISMATCH"
  /** The event's metadata version does not advance. */
  | "UNIVERSE_METADATA_VERSION_NOT_ADVANCING"
  /** The event was already applied, or arrived behind one that was. */
  | "UNIVERSE_EVENT_REPLAYED"
  /** The value is not an envelope this package projects. */
  | "UNIVERSE_EVENT_UNSUPPORTED"

  // --- readiness ------------------------------------------------------------
  /** The market has not opened yet. */
  | "UNIVERSE_MARKET_NOT_OPEN"
  /**
   * The market's SCHEDULED close instant has elapsed.
   *
   * This is a statement about the schedule, NOT a venue-confirmed closure: no
   * domain event asserts "trading has ended", so the projection cannot know it
   * (round-1 review, M3). New activation is refused past the scheduled close,
   * but observation continues until `MarketResolved` or reconciliation
   * establishes closure.
   */
  | "UNIVERSE_SCHEDULED_CLOSE_ELAPSED"
  /** The market has resolved. */
  | "UNIVERSE_MARKET_RESOLVED"
  /** The market's settlement state is not the ordinary pending one. */
  | "UNIVERSE_OUTCOME_STATE_NOT_PENDING"
  /** Too little time remains before the scheduled close. */
  | "UNIVERSE_CLOSE_CUTOFF"
  /** The settlement layer refused model-dependent activation. */
  | "UNIVERSE_SETTLEMENT_ACTIVATION_BLOCKED"
  /** The reviewed spec names a different rules version than the market is trading under. */
  | "UNIVERSE_SETTLEMENT_RULES_VERSION_DRIFT"
  /** The settlement verdict contradicts itself. */
  | "UNIVERSE_SETTLEMENT_VERDICT_INCONSISTENT"
  /**
   * A verdict that CLAIMS to permit activation is missing an identity the
   * universe layer must correlate (series id, settlement-spec id, rules
   * version, payoff model) or carries refusals despite permitting.
   */
  | "UNIVERSE_SETTLEMENT_VERDICT_INCOMPLETE"
  /**
   * A permitted settlement verdict was presented without the approved
   * `SeriesDefinition` it must be correlated against.
   */
  | "UNIVERSE_SERIES_DEFINITION_REQUIRED"
  /** The settlement verdict names a different series than this market is bound to. */
  | "UNIVERSE_SETTLEMENT_SERIES_MISMATCH"
  /** The settlement verdict's spec is not the series' active settlement spec. */
  | "UNIVERSE_SETTLEMENT_SPEC_MISMATCH"
  /** The market has no recorded parameters. */
  | "UNIVERSE_PARAMETERS_MISSING"
  /** A timestamp handed to a readiness check is not a parseable instant. */
  | "UNIVERSE_TIMESTAMP_INVALID";

export type UniverseRefusalDetails = Readonly<Record<string, unknown>>;

/** A registry question answered "no", with the reason machine-readable. */
export interface UniverseRefusal {
  readonly code: UniverseRefusalCode;
  readonly message: string;
  readonly details: UniverseRefusalDetails;
}

/** Builds a refusal. */
export function universeRefusal(
  code: UniverseRefusalCode,
  message: string,
  details: UniverseRefusalDetails = {},
): UniverseRefusal {
  return Object.freeze({ code, message, details: Object.freeze({ ...details }) });
}

/** A successful result, or the refusals that prevented it. */
export type UniverseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusals: readonly UniverseRefusal[] };

/** Wraps a value as a successful result. */
export function universeOk<T>(value: T): UniverseResult<T> {
  return { ok: true, value };
}

/** Wraps one or more refusals as a failed result. */
export function universeFailure<T>(...refusals: readonly UniverseRefusal[]): UniverseResult<T> {
  return { ok: false, refusals: Object.freeze([...refusals]) };
}

/** A caller error: the input could not be interpreted at all. */
export class UniverseError extends Error {
  readonly code: UniverseRefusalCode;
  readonly details: UniverseRefusalDetails;

  constructor(
    code: UniverseRefusalCode,
    message: string,
    details: UniverseRefusalDetails = {},
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** The value failed a schema in this package. */
export class UniverseValidationError extends UniverseError {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super("UNIVERSE_INPUT_INVALID", message, { issues });
    this.issues = Object.freeze([...issues]);
  }
}
