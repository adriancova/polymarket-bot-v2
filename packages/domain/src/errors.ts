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
  | "RUN_MODE_EXCEEDS_MAXIMUM";

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
