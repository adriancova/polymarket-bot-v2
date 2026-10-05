/**
 * Typed errors for the public market-data adapter (handoff §21: "Errors are
 * typed and observable").
 *
 * Every error carries a stable `code` so a caller branches on the code rather
 * than on a message, and a `details` bag so an operator sees the endpoint, the
 * token, and the offending value in a structured log.
 *
 * These are *thrown* failures: configuration mistakes and transport failures.
 * A frame that cannot be normalized is NOT an error — it is a
 * {@link import("./normalize/result.js").NormalizationProblem}, returned as
 * data, because §8.3 forbids silently dropping a market event and a thrown
 * exception in a message loop is exactly how a drop happens.
 */

export type PolymarketPublicErrorCode =
  /** Adapter options are self-contradictory, out of range, or name a bad endpoint. */
  | "PUBLIC_MARKET_CONFIGURATION"
  /** The feed was used in a state that forbids the operation (closed, not started). */
  | "PUBLIC_MARKET_STATE"
  /** The WebSocket transport could not be reached or failed mid-stream. */
  | "PUBLIC_MARKET_TRANSPORT"
  /** A REST snapshot read failed at the transport or HTTP-status level. */
  | "PUBLIC_MARKET_SNAPSHOT_UNAVAILABLE"
  /** A REST snapshot response body did not match the documented venue shape. */
  | "PUBLIC_MARKET_SNAPSHOT_INVALID"
  /** A Gamma `GET /markets/{id}` read failed at the transport or HTTP-status level (`UNIV-4`). */
  | "PUBLIC_MARKET_STATE_UNAVAILABLE"
  /** A Gamma `GET /markets/{id}` body did not match the documented `Market` shape (`UNIV-4`). */
  | "PUBLIC_MARKET_STATE_INVALID"
  /**
   * A series-window read — Gamma `GET /events/keyset` or CLOB
   * `GET /clob-markets/{condition_id}` — failed at the transport level
   * (`ROLLOVER-1`).
   */
  | "PUBLIC_SERIES_WINDOW_UNAVAILABLE";

export type PolymarketPublicErrorDetails = Readonly<Record<string, unknown>>;

/** Base class for every error this package raises. */
export class PolymarketPublicError extends Error {
  readonly code: PolymarketPublicErrorCode;
  readonly details: PolymarketPublicErrorDetails;

  constructor(
    code: PolymarketPublicErrorCode,
    message: string,
    details: PolymarketPublicErrorDetails = {},
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Adapter options are invalid (empty endpoint, non-positive interval, bad chunk size). */
export class PublicMarketConfigurationError extends PolymarketPublicError {
  constructor(message: string, details: PolymarketPublicErrorDetails = {}) {
    super("PUBLIC_MARKET_CONFIGURATION", message, details);
  }
}

/** The feed is closed, or already started, and the operation is illegal in that state. */
export class PublicMarketStateError extends PolymarketPublicError {
  constructor(message: string, details: PolymarketPublicErrorDetails = {}) {
    super("PUBLIC_MARKET_STATE", message, details);
  }
}

/**
 * The WebSocket transport failed.
 *
 * Surfaced to the caller *in addition to* a `FeedDisconnected` signal, never
 * instead of one: a transport failure that only threw would leave the event
 * stream with no record that the feed stopped (§8.3).
 */
export class PublicMarketTransportError extends PolymarketPublicError {
  constructor(
    message: string,
    details: PolymarketPublicErrorDetails = {},
    cause?: unknown,
  ) {
    super("PUBLIC_MARKET_TRANSPORT", message, details, cause === undefined ? {} : { cause });
  }
}

/**
 * An authoritative REST snapshot could not be obtained.
 *
 * A detected gap requires a new authoritative snapshot before affected markets
 * resume (§7.1, §9.1, ADR-002 §2.4). This error therefore means the recovery
 * precondition is NOT satisfied; the caller must keep the affected markets in
 * the gap state rather than resuming on stale data.
 */
export class PublicMarketSnapshotUnavailableError extends PolymarketPublicError {
  constructor(
    message: string,
    details: PolymarketPublicErrorDetails = {},
    cause?: unknown,
  ) {
    super(
      "PUBLIC_MARKET_SNAPSHOT_UNAVAILABLE",
      message,
      details,
      cause === undefined ? {} : { cause },
    );
  }
}

/** A REST snapshot body could not be parsed as the documented venue shape. */
export class PublicMarketSnapshotInvalidError extends PolymarketPublicError {
  constructor(message: string, details: PolymarketPublicErrorDetails = {}) {
    super("PUBLIC_MARKET_SNAPSHOT_INVALID", message, details);
  }
}

/**
 * A Gamma market-state read could not be obtained (`UNIV-4`).
 *
 * A failed poll is NOT an observation: the caller must derive nothing from it
 * and report it (the gateway opens a data-quality incident), never treat the
 * absence of an answer as a statement about the market.
 */
export class GammaMarketStateUnavailableError extends PolymarketPublicError {
  constructor(
    message: string,
    details: PolymarketPublicErrorDetails = {},
    cause?: unknown,
  ) {
    super(
      "PUBLIC_MARKET_STATE_UNAVAILABLE",
      message,
      details,
      cause === undefined ? {} : { cause },
    );
  }
}

/** A Gamma market-state body could not be read as the documented `Market` shape (`UNIV-4`). */
export class GammaMarketStateInvalidError extends PolymarketPublicError {
  constructor(message: string, details: PolymarketPublicErrorDetails = {}) {
    super("PUBLIC_MARKET_STATE_INVALID", message, details);
  }
}

/**
 * A series-window read failed at the transport level (`ROLLOVER-1`). Like a
 * failed market-state poll it is NOT an observation: the gateway journals
 * nothing it did not receive, derives nothing, and reports the failure.
 */
export class SeriesWindowUnavailableError extends PolymarketPublicError {
  constructor(
    message: string,
    details: PolymarketPublicErrorDetails = {},
    cause?: unknown,
  ) {
    super(
      "PUBLIC_SERIES_WINDOW_UNAVAILABLE",
      message,
      details,
      cause === undefined ? {} : { cause },
    );
  }
}
