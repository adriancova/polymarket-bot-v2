/**
 * Typed errors for the event transport (handoff §21: "Errors are typed and
 * observable").
 *
 * Every error carries a stable `code` so a caller branches on the code rather
 * than on a message, and a `details` bag so an operator sees the stream, the
 * consumer, and the offending value in a structured log.
 *
 * These errors exist because §8.3 forbids a silent drop. Every way this package
 * can fail to move an event is either a typed throw from this file or a
 * `resync-required` result from `receive` — never a quietly discarded event.
 */

export type EventBusErrorCode =
  /** Transport or subscription options are self-contradictory or out of range. */
  | "EVENT_BUS_CONFIGURATION"
  /** A value handed to `publish`, or read back from the stream, is not a valid §7.1 envelope. */
  | "EVENT_BUS_ENVELOPE_INVALID"
  /** `ingestSeq` did not advance within its `gatewayEpoch` (ADR-002 §2, ADR-003 §2). */
  | "EVENT_BUS_ORDERING_VIOLATION"
  /** A stored entry could not be read back as an envelope. */
  | "EVENT_BUS_ENTRY_UNREADABLE"
  /** A checkpoint is malformed, belongs elsewhere, or would move backwards. */
  | "EVENT_BUS_CHECKPOINT_INVALID"
  /** The consumer must hard-resynchronize before the requested operation is legal. */
  | "EVENT_BUS_RESYNC_REQUIRED"
  /** The transport or subscription was used in a state that forbids the operation. */
  | "EVENT_BUS_STATE"
  /** The underlying transport could not be reached; publication stops (ADR-003 §4). */
  | "EVENT_BUS_UNAVAILABLE";

export type EventBusErrorDetails = Readonly<Record<string, unknown>>;

/** Base class for every error this package raises. */
export class EventBusError extends Error {
  readonly code: EventBusErrorCode;
  readonly details: EventBusErrorDetails;

  constructor(
    code: EventBusErrorCode,
    message: string,
    details: EventBusErrorDetails = {},
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Transport or subscription options are invalid (non-positive bound, empty name). */
export class EventBusConfigurationError extends EventBusError {
  constructor(message: string, details: EventBusErrorDetails = {}) {
    super("EVENT_BUS_CONFIGURATION", message, details);
  }
}

/**
 * A value is not a valid §7.1 envelope.
 *
 * Thrown synchronously from `publish`, which makes it a caller error rather
 * than a dropped event: the caller still holds the envelope and decides what to
 * do with it (§8.3, ADR-002 §2.5 — route it to `DataQualityIncidentOpened`
 * with the raw frame preserved).
 */
export class EventBusEnvelopeError extends EventBusError {
  constructor(message: string, details: EventBusErrorDetails = {}) {
    super("EVENT_BUS_ENVELOPE_INVALID", message, details);
  }
}

/**
 * `ingestSeq` did not advance within its `gatewayEpoch`.
 *
 * `(gatewayEpoch, ingestSeq)` is the only ordering authority (ADR-002 §2), so
 * publishing a non-advancing pair would put an event in the stream with no
 * defined position. The event is refused, not reordered and not dropped.
 */
export class EventBusOrderingError extends EventBusError {
  constructor(message: string, details: EventBusErrorDetails = {}) {
    super("EVENT_BUS_ORDERING_VIOLATION", message, details);
  }
}

/**
 * A stored entry could not be read back as an envelope.
 *
 * The subscription delivers every valid event that preceded the bad entry
 * first, then throws this on the following `receive` and refuses to advance
 * past it. `checkpoint` names the offending entry, so a caller that has opened
 * a data-quality incident can subscribe again from that position to step over
 * it deliberately. There is no code path that skips it silently.
 */
export class EventBusEntryError extends EventBusError {
  constructor(message: string, details: EventBusErrorDetails = {}) {
    super("EVENT_BUS_ENTRY_UNREADABLE", message, details);
  }
}

/** A checkpoint is malformed, belongs to another stream/transport, or regresses. */
export class EventBusCheckpointError extends EventBusError {
  constructor(message: string, details: EventBusErrorDetails = {}) {
    super("EVENT_BUS_CHECKPOINT_INVALID", message, details);
  }
}

/**
 * The subscription has a pending hard-resync condition.
 *
 * Raised by operations that would otherwise let a consumer continue as though
 * nothing were missing — checkpointing past the gap, in particular (ADR-003
 * §3.3).
 */
export class EventBusResyncRequiredError extends EventBusError {
  constructor(message: string, details: EventBusErrorDetails = {}) {
    super("EVENT_BUS_RESYNC_REQUIRED", message, details);
  }
}

/** The transport or subscription is closed, or the operation is illegal in its current state. */
export class EventBusStateError extends EventBusError {
  constructor(message: string, details: EventBusErrorDetails = {}) {
    super("EVENT_BUS_STATE", message, details);
  }
}

/**
 * The underlying transport could not be reached.
 *
 * ADR-003 §4: publication stops and therefore trading halts. This is the
 * designed behavior, not a degradation to work around — the caller must not
 * fall back to another data path, and must not continue on stale state.
 */
export class EventBusUnavailableError extends EventBusError {
  constructor(message: string, details: EventBusErrorDetails = {}, cause?: unknown) {
    super("EVENT_BUS_UNAVAILABLE", message, details, cause === undefined ? {} : { cause });
  }
}
