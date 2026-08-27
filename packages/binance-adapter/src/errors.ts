/**
 * Typed errors for the Binance reference adapter (handoff §21: "errors are typed
 * and observable").
 *
 * Every error carries a stable `code` so a caller branches on the code rather
 * than on a message, and a structured `details` bag so an operator sees the
 * stream, the symbol, and the offending value in a log line.
 *
 * WHAT IS AND IS NOT AN ERROR HERE. A malformed or unrecognized *venue frame* is
 * NOT thrown: §8.3 forbids dropping a market event silently, and throwing on the
 * hot path would tempt a caller into a `try`/`catch` that swallows it. Bad venue
 * traffic is classified (see `./frames.ts`), counted, returned to the caller,
 * and routed to `DataQualityIncidentOpened` (ADR-002 §2.5). These errors are for
 * *caller* mistakes — a malformed configuration, an out-of-range value the
 * adapter cannot represent, a state transition that cannot happen — where
 * failing loudly is the only honest option.
 */

export type BinanceAdapterErrorCode =
  /** Feed, symbol, endpoint, or stream configuration is invalid or self-contradictory. */
  | "BINANCE_CONFIGURATION"
  /** A venue timestamp could not be converted to an ISO-8601 instant. */
  | "BINANCE_TIMESTAMP_INVALID"
  /** A venue decimal could not be normalized, or is outside the domain's range. */
  | "BINANCE_DECIMAL_INVALID"
  /** A normalized payload failed its frozen `@polymarket-bot/domain` schema. */
  | "BINANCE_PAYLOAD_INVALID"
  /** The feed was used in a state that forbids the operation. */
  | "BINANCE_STATE";

export type BinanceAdapterErrorDetails = Readonly<Record<string, unknown>>;

/** Base class for every error this package raises. */
export class BinanceAdapterError extends Error {
  public readonly code: BinanceAdapterErrorCode;
  public readonly details: BinanceAdapterErrorDetails;

  public constructor(
    code: BinanceAdapterErrorCode,
    message: string,
    details: BinanceAdapterErrorDetails = {},
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Feed options, a symbol, an endpoint, or a stream name is invalid. */
export class BinanceConfigurationError extends BinanceAdapterError {
  public constructor(message: string, details: BinanceAdapterErrorDetails = {}) {
    super("BINANCE_CONFIGURATION", message, details);
  }
}

/**
 * A venue epoch value could not be converted to an ISO-8601 instant.
 *
 * Raised for a negative value, a non-safe integer (see `BNC-U6`), or a value
 * outside the representable instant range. Guessing an instant would put a
 * fabricated `venueTimestamp` on a recorded event.
 */
export class BinanceTimestampError extends BinanceAdapterError {
  public constructor(message: string, details: BinanceAdapterErrorDetails = {}) {
    super("BINANCE_TIMESTAMP_INVALID", message, details);
  }
}

/**
 * A venue decimal string could not be normalized to the canonical form, or the
 * canonical value is outside the range the domain contract accepts.
 *
 * ADR-001 §3: "The boundary never coerces… An adapter that receives a
 * non-canonical venue spelling must call `normalizeDecimalString` explicitly, in
 * the adapter, and pass the *result* across the boundary", and ADR-002 §7: an
 * out-of-range value "is a typed adapter failure plus a
 * `DataQualityIncidentOpened`, never a clamp and never a silent drop".
 */
export class BinanceDecimalError extends BinanceAdapterError {
  public constructor(message: string, details: BinanceAdapterErrorDetails = {}) {
    super("BINANCE_DECIMAL_INVALID", message, details);
  }
}

/**
 * A payload this package assembled failed its frozen domain schema.
 *
 * This is an adapter defect, not venue traffic: the normalizer is supposed to
 * have produced a value the contract accepts. It is thrown rather than
 * classified so the defect cannot be mistaken for a venue problem.
 */
export class BinancePayloadError extends BinanceAdapterError {
  public constructor(message: string, details: BinanceAdapterErrorDetails = {}) {
    super("BINANCE_PAYLOAD_INVALID", message, details);
  }
}

/** The feed state machine was driven through an impossible transition. */
export class BinanceStateError extends BinanceAdapterError {
  public constructor(message: string, details: BinanceAdapterErrorDetails = {}) {
    super("BINANCE_STATE", message, details);
  }
}
