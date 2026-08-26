/**
 * Typed domain errors (handoff §21: "errors are typed and observable").
 *
 * `@polymarket-bot/domain` performs no I/O and never logs; it only throws
 * these typed errors, which callers translate into metrics, structured logs,
 * and data-quality incidents.
 */

export type DomainErrorCode =
  | "UNKNOWN_EVENT_CONTRACT"
  | "DUPLICATE_EVENT_CONTRACT"
  | "EVENT_VALIDATION_FAILED"
  | "INVALID_SCHEMA_VERSION"
  | "EVENT_PROVENANCE_MISMATCH"
  | "RUN_MODE_EXCEEDS_MAXIMUM";

/** Renders an arbitrary value for an error message without throwing on it. */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return `${String(value)}n`;
  }
  return typeof value;
}

/** Base class for every error raised by `@polymarket-bot/domain`. */
export class DomainError extends Error {
  public readonly code: DomainErrorCode;

  public constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** No contract is registered for the requested `(eventType, schemaVersion)` pair. */
export class UnknownEventContractError extends DomainError {
  public readonly eventType: string;
  public readonly schemaVersion: number | undefined;

  public constructor(eventType: string, schemaVersion: number | undefined) {
    super(
      "UNKNOWN_EVENT_CONTRACT",
      `no registered contract for event type "${eventType}" at schema version ${schemaVersion === undefined ? "(missing)" : String(schemaVersion)}`,
    );
    this.eventType = eventType;
    this.schemaVersion = schemaVersion;
  }
}

/** Two contracts claimed the same `(eventType, schemaVersion)` key. */
export class DuplicateEventContractError extends DomainError {
  public constructor(eventType: string, schemaVersion: number) {
    super(
      "DUPLICATE_EVENT_CONTRACT",
      `duplicate contract registration for event type "${eventType}" at schema version ${String(schemaVersion)}`,
    );
  }
}

/** A payload or envelope failed its registered schema. */
export class EventValidationError extends DomainError {
  public readonly eventType: string;
  public readonly schemaVersion: number;
  public readonly issues: readonly string[];

  public constructor(eventType: string, schemaVersion: number, issues: readonly string[]) {
    super(
      "EVENT_VALIDATION_FAILED",
      `event "${eventType}" v${String(schemaVersion)} failed validation: ${issues.join("; ")}`,
    );
    this.eventType = eventType;
    this.schemaVersion = schemaVersion;
    this.issues = issues;
  }
}

/**
 * A schema version was not a positive safe integer.
 *
 * Raised at contract construction and at registry insertion, so an invalid
 * version fails at startup instead of becoming an unreachable registry key.
 * "Safe" is part of the rule: the envelope routing schema accepts only the
 * safe-integer range, so a larger value could never be routed to.
 */
export class InvalidSchemaVersionError extends DomainError {
  public readonly received: unknown;

  public constructor(received: unknown, label = "schemaVersion") {
    super(
      "INVALID_SCHEMA_VERSION",
      `${label} must be a positive safe integer (1..${String(Number.MAX_SAFE_INTEGER)}), received ${describeValue(received)}`,
    );
    this.received = received;
  }
}

/**
 * A payload's declared provenance contradicts its envelope `source` (§7.1).
 *
 * The envelope is authoritative; a payload that claims a different venue is a
 * normalization bug in the gateway and must not be recorded as if it were
 * consistent.
 */
export class EventProvenanceMismatchError extends DomainError {
  public readonly envelopeSource: string;
  public readonly payloadVenue: string;

  public constructor(envelopeSource: string, payloadVenue: string, label = "event") {
    super(
      "EVENT_PROVENANCE_MISMATCH",
      `${label}: payload venue "${payloadVenue}" contradicts envelope source "${envelopeSource}"; the envelope source is authoritative (§7.1)`,
    );
    this.envelopeSource = envelopeSource;
    this.payloadVenue = payloadVenue;
  }
}

/** A requested run mode is above the process maximum (handoff §11). */
export class RunModeNotPermittedError extends DomainError {
  public readonly requested: string;
  public readonly maximum: string;

  public constructor(requested: string, maximum: string) {
    super(
      "RUN_MODE_EXCEEDS_MAXIMUM",
      `run mode ${requested} exceeds the process maximum ${maximum}; the maximum cannot be raised at runtime`,
    );
    this.requested = requested;
    this.maximum = maximum;
  }
}
