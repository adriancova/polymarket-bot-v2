/**
 * Typed errors for the data gateway (WP-120).
 *
 * Every failure this app raises carries a stable `code`, matching the idiom of
 * every upstream package (`WalError`, `EventBusError`, the adapter error
 * families): a caller branches on the code, an operator aggregates on it, and
 * the message stays human-only.
 */

export type GatewayErrorCode =
  /** A construction-time configuration defect. Fails at startup, loudly. */
  | "GATEWAY_CONFIGURATION"
  /** A method was called in a state that cannot honor it. */
  | "GATEWAY_STATE"
  /**
   * The WAL refused or faulted, so the raw frame is NOT durably recorded.
   *
   * §8.3: a critical queue that cannot accept an event halts affected trading
   * and opens a data-quality incident. Publishing normalized data whose raw
   * evidence was not recorded would break §6 invariant 4 (traceability), so
   * this is a halt signal for the affected feed, never a "log and continue".
   */
  | "GATEWAY_RECORDING_FAILED"
  /**
   * The transport refused a publication and the gateway halted publication.
   *
   * Covers both `EVENT_BUS_UNAVAILABLE` and `EVENT_BUS_PUBLISH_QUEUE_FULL`:
   * per WP-060's consumer obligations, a full publish queue is the same §8.3
   * halt signal as a dead transport, not a drop signal.
   */
  | "GATEWAY_PUBLICATION_HALTED"
  /** A completed envelope failed its frozen domain contract (ADR-002 §3/§5). */
  | "GATEWAY_ENVELOPE_REJECTED"
  /**
   * One or more resource disposals failed during `stop()` (round 4).
   *
   * `stop()` isolates every disposal: each one is attempted, failures are
   * collected here, and every remaining resource is still released. The error
   * therefore reports what did NOT close cleanly — it never means a later
   * disposal was skipped because an earlier one threw.
   */
  | "GATEWAY_DISPOSAL_FAILED";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GatewayErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options: { cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class GatewayConfigurationError extends GatewayError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("GATEWAY_CONFIGURATION", message, details);
  }
}

export class GatewayStateError extends GatewayError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("GATEWAY_STATE", message, details);
  }
}

export class GatewayRecordingError extends GatewayError {
  constructor(message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    super(
      "GATEWAY_RECORDING_FAILED",
      message,
      details,
      cause === undefined ? {} : { cause },
    );
  }
}

export class GatewayPublicationHaltedError extends GatewayError {
  constructor(message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    super(
      "GATEWAY_PUBLICATION_HALTED",
      message,
      details,
      cause === undefined ? {} : { cause },
    );
  }
}

export class GatewayEnvelopeRejectedError extends GatewayError {
  constructor(message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    super(
      "GATEWAY_ENVELOPE_REJECTED",
      message,
      details,
      cause === undefined ? {} : { cause },
    );
  }
}

/** One failed disposal, named: which resource, and what it threw. */
export interface DisposalFailure {
  readonly resource: string;
  readonly error: unknown;
}

/**
 * `DataGateway.stop()` attempted every disposal and at least one failed.
 *
 * The message names each failed resource so an operator log line is complete
 * on its own; `failures` carries the original errors; `cause` is the first
 * one, preserving the established `{ cause }` idiom for aggregation.
 */
export class GatewayDisposalError extends GatewayError {
  readonly failures: readonly DisposalFailure[];

  constructor(failures: readonly DisposalFailure[]) {
    const described = failures
      .map(
        (failure) =>
          `${failure.resource}: ${
            failure.error instanceof Error ? failure.error.message : String(failure.error)
          }`,
      )
      .join("; ");
    super(
      "GATEWAY_DISPOSAL_FAILED",
      `gateway stop(): ${String(failures.length)} resource disposal(s) failed (${described}); ` +
        "every disposal was still attempted and the lifetime anchor was released",
      { resources: failures.map((failure) => failure.resource) },
      { cause: failures[0]?.error },
    );
    this.failures = failures;
  }
}
