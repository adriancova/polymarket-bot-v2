/**
 * Typed errors for the Coinbase reference adapter (handoff §21: "Errors are
 * typed and observable").
 *
 * Every error carries a stable `code` so a caller branches on the code rather
 * than a message, and a `details` bag so an operator sees the channel, the
 * product, and the offending value in a structured log.
 *
 * WHAT IS AND IS NOT AN ERROR HERE. A malformed or unrecognized *frame* is not
 * thrown: §8.3 forbids silently dropping a market event, and throwing out of the
 * socket read loop would lose the frame just as effectively. Frame-level
 * problems become typed {@link CoinbaseAnomaly} values carried out of
 * `ingestFrame` alongside the raw frame, so the caller records them
 * (`DataQualityIncidentOpened`) and keeps reading. These error classes are for
 * *caller* mistakes and for states the adapter cannot continue from.
 */

export type CoinbaseAdapterErrorCode =
  /** Adapter options are self-contradictory, out of range, or malformed. */
  | "COINBASE_CONFIGURATION"
  /** The adapter was used in a state that forbids the operation. */
  | "COINBASE_STATE"
  /** The transport could not be established or was lost. */
  | "COINBASE_TRANSPORT";

export type CoinbaseErrorDetails = Readonly<Record<string, unknown>>;

/** Base class for every error this package raises. */
export class CoinbaseAdapterError extends Error {
  readonly code: CoinbaseAdapterErrorCode;
  readonly details: CoinbaseErrorDetails;

  constructor(
    code: CoinbaseAdapterErrorCode,
    message: string,
    details: CoinbaseErrorDetails = {},
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/**
 * Adapter options are invalid.
 *
 * Raised at construction, never mid-stream: an option that would have produced
 * an invalid domain payload (a `feedId` that is not a code string, a
 * non-positive staleness threshold) is refused before a single frame is read,
 * so a running feed cannot discover the problem at the moment it must emit.
 */
export class CoinbaseConfigurationError extends CoinbaseAdapterError {
  constructor(message: string, details: CoinbaseErrorDetails = {}) {
    super("COINBASE_CONFIGURATION", message, details);
  }
}

/** The processor or connection manager is closed, or the operation is illegal now. */
export class CoinbaseStateError extends CoinbaseAdapterError {
  constructor(message: string, details: CoinbaseErrorDetails = {}) {
    super("COINBASE_STATE", message, details);
  }
}

/**
 * The WebSocket transport failed.
 *
 * Carried into a `FeedDisconnected` reason code by the connection manager rather
 * than propagated to the caller's read loop: a dropped connection is an expected
 * operating condition for a public market-data feed, and the recorded feed-status
 * event is how it becomes visible (ADR-002 §2.4).
 */
export class CoinbaseTransportError extends CoinbaseAdapterError {
  constructor(message: string, details: CoinbaseErrorDetails = {}, cause?: unknown) {
    super("COINBASE_TRANSPORT", message, details, cause === undefined ? {} : { cause });
  }
}
