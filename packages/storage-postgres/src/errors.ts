/**
 * Typed, observable storage errors (handoff §21: "Errors are typed and
 * observable").
 *
 * Every database-enforced invariant in `db/migrations` raises a stable SQLSTATE,
 * and every one of those codes maps to exactly one error class here. A caller
 * therefore branches on a type, never on a message substring: the wording of a
 * PostgreSQL diagnostic is not a contract, but its SQLSTATE is.
 */

/** SQLSTATE codes raised by this schema's constraint triggers. */
export const STORAGE_SQL_STATES = {
  /** Append-only table received an UPDATE, DELETE, or TRUNCATE (§10.7). */
  appendOnlyViolation: "PMB01",
  /** An immutable column of a mutable row was changed. */
  immutableColumn: "PMB02",
  /** Fill allocations would exceed the fill quantity (§10.7). */
  fillAllocationExceedsFill: "PMB03",
  /** Fill allocations do not sum to the fill quantity at COMMIT (§10.7). */
  fillAllocationIncomplete: "PMB04",
  /** A ledger transaction does not balance to zero per asset (§10.7). */
  ledgerImbalance: "PMB05",
  /** A live write named a fencing lease that was not valid (§10.7, ADR-008). */
  fencingReferenceInvalid: "PMB06",
  /** A fencing token was not above every previously issued token (ADR-008 §1). */
  fencingTokenNotMonotonic: "PMB07",
  /** A reservation named an account/asset with no balance projection row. */
  unknownBalance: "PMB09",
} as const;

/** Standard SQLSTATE codes this package translates. */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_CHECK_VIOLATION = "23514";
const PG_NOT_NULL_VIOLATION = "23502";
const PG_EXCLUSION_VIOLATION = "23P01";

/** Name of the CHECK that implements §10.7 "no negative available balance". */
const NEGATIVE_AVAILABLE_BALANCE_CONSTRAINT = "balance_projection_no_negative_available";

/** The subset of a `pg` error this package reads. */
export type PostgresErrorShape = {
  readonly code?: string | undefined;
  readonly constraint?: string | undefined;
  readonly table?: string | undefined;
  readonly schema?: string | undefined;
  readonly detail?: string | undefined;
  readonly hint?: string | undefined;
  readonly message: string;
};

/** Base class for every error this package raises. */
export class StoragePostgresError extends Error {
  /** Stable machine-readable code, safe as a metric label. */
  public readonly code: string;

  public readonly sqlState: string | undefined;

  public readonly constraintName: string | undefined;

  public constructor(
    code: string,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly sqlState?: string | undefined;
      readonly constraintName?: string | undefined;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.sqlState = options?.sqlState;
    this.constraintName = options?.constraintName;
  }
}

/** An append-only table (§10.7) rejected an UPDATE, DELETE, or TRUNCATE. */
export class AppendOnlyViolationError extends StoragePostgresError {}

/** An immutable column of an otherwise-mutable row was changed. */
export class ImmutableColumnError extends StoragePostgresError {}

/** Fill allocations would exceed the actual fill quantity (§10.7). */
export class FillAllocationExceedsFillError extends StoragePostgresError {}

/** Fill allocations did not sum to the fill quantity at COMMIT (§10.7). */
export class FillAllocationIncompleteError extends StoragePostgresError {}

/** A ledger transaction did not balance to zero per asset (§10.7). */
export class LedgerImbalanceError extends StoragePostgresError {}

/** A live write named a fencing lease that was not valid (§10.7, ADR-008). */
export class FencingReferenceInvalidError extends StoragePostgresError {}

/** A fencing token was not strictly above every previously issued token. */
export class FencingTokenNotMonotonicError extends StoragePostgresError {}

/** A reservation would drive the available balance below zero (§10.7). */
export class NegativeAvailableBalanceError extends StoragePostgresError {}

/** A reservation named an account/environment/asset with no balance row. */
export class UnknownBalanceError extends StoragePostgresError {}

/** A unique constraint rejected the write. */
export class UniqueViolationError extends StoragePostgresError {}

/** A foreign key constraint rejected the write. */
export class ForeignKeyViolationError extends StoragePostgresError {}

/** A CHECK, NOT NULL, or domain constraint rejected the write. */
export class ConstraintViolationError extends StoragePostgresError {}

/** A migration file set was malformed or incomplete. */
export class MigrationDefinitionError extends StoragePostgresError {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super("MIGRATION_DEFINITION_INVALID", message, options);
  }
}

/**
 * An applied migration's file no longer hashes to the value recorded when it
 * ran. Editing an applied migration silently changes what a fresh database
 * gets, so it is rejected rather than reconciled.
 */
export class MigrationChecksumMismatchError extends StoragePostgresError {
  public constructor(
    public readonly version: string,
    public readonly recordedChecksum: string,
    public readonly actualChecksum: string,
  ) {
    super(
      "MIGRATION_CHECKSUM_MISMATCH",
      `Migration ${version} was applied with checksum ${recordedChecksum} but now hashes to ${actualChecksum}. ` +
        "An applied migration is immutable; add a new migration instead.",
    );
  }
}

/** A migration failed to apply or roll back. */
export class MigrationFailedError extends StoragePostgresError {
  public constructor(
    public readonly version: string,
    public readonly direction: "up" | "down",
    cause: unknown,
  ) {
    super(
      "MIGRATION_FAILED",
      `Migration ${version} failed to run ${direction}: ${describeCause(cause)}`,
      { cause },
    );
  }
}

/** A PostgreSQL timestamp could not be read as an ISO-8601 instant. */
export class InvalidTimestampError extends StoragePostgresError {
  public constructor(value: string) {
    super(
      "INVALID_TIMESTAMP",
      `Cannot read ${JSON.stringify(value)} as an ISO-8601 UTC instant. ` +
        "Connections must run with TimeZone=UTC and DateStyle=ISO.",
    );
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function readPostgresError(error: unknown): PostgresErrorShape | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as Record<string, unknown>;
  if (typeof candidate["code"] !== "string" || typeof candidate["message"] !== "string") {
    return undefined;
  }
  return {
    code: candidate["code"],
    message: candidate["message"],
    constraint: typeof candidate["constraint"] === "string" ? candidate["constraint"] : undefined,
    table: typeof candidate["table"] === "string" ? candidate["table"] : undefined,
    schema: typeof candidate["schema"] === "string" ? candidate["schema"] : undefined,
    detail: typeof candidate["detail"] === "string" ? candidate["detail"] : undefined,
    hint: typeof candidate["hint"] === "string" ? candidate["hint"] : undefined,
  };
}

/**
 * Translates a `pg` error into a typed storage error.
 *
 * An error this package does not model is returned unchanged: inventing a type
 * for an unrecognized SQLSTATE would hide the diagnostic the operator needs.
 */
export function mapPostgresError(error: unknown): unknown {
  const pgError = readPostgresError(error);
  if (pgError === undefined || pgError.code === undefined) {
    return error;
  }

  const options = {
    cause: error,
    sqlState: pgError.code,
    constraintName: pgError.constraint,
  };

  switch (pgError.code) {
    case STORAGE_SQL_STATES.appendOnlyViolation:
      return new AppendOnlyViolationError("APPEND_ONLY_VIOLATION", pgError.message, options);
    case STORAGE_SQL_STATES.immutableColumn:
      return new ImmutableColumnError("IMMUTABLE_COLUMN", pgError.message, options);
    case STORAGE_SQL_STATES.fillAllocationExceedsFill:
      return new FillAllocationExceedsFillError(
        "FILL_ALLOCATION_EXCEEDS_FILL",
        pgError.message,
        options,
      );
    case STORAGE_SQL_STATES.fillAllocationIncomplete:
      return new FillAllocationIncompleteError(
        "FILL_ALLOCATION_INCOMPLETE",
        pgError.message,
        options,
      );
    case STORAGE_SQL_STATES.ledgerImbalance:
      return new LedgerImbalanceError("LEDGER_IMBALANCE", pgError.message, options);
    case STORAGE_SQL_STATES.fencingReferenceInvalid:
      return new FencingReferenceInvalidError(
        "FENCING_REFERENCE_INVALID",
        pgError.message,
        options,
      );
    case STORAGE_SQL_STATES.fencingTokenNotMonotonic:
      return new FencingTokenNotMonotonicError(
        "FENCING_TOKEN_NOT_MONOTONIC",
        pgError.message,
        options,
      );
    case STORAGE_SQL_STATES.unknownBalance:
      return new UnknownBalanceError("UNKNOWN_BALANCE", pgError.message, options);
    case PG_UNIQUE_VIOLATION:
    case PG_EXCLUSION_VIOLATION:
      return new UniqueViolationError("UNIQUE_VIOLATION", pgError.message, options);
    case PG_FOREIGN_KEY_VIOLATION:
      return new ForeignKeyViolationError("FOREIGN_KEY_VIOLATION", pgError.message, options);
    case PG_CHECK_VIOLATION:
      if (pgError.constraint === NEGATIVE_AVAILABLE_BALANCE_CONSTRAINT) {
        return new NegativeAvailableBalanceError(
          "NEGATIVE_AVAILABLE_BALANCE",
          pgError.message,
          options,
        );
      }
      return new ConstraintViolationError("CHECK_VIOLATION", pgError.message, options);
    case PG_NOT_NULL_VIOLATION:
      return new ConstraintViolationError("NOT_NULL_VIOLATION", pgError.message, options);
    default:
      return error;
  }
}

/** Runs `operation`, translating any PostgreSQL error into a typed one. */
export async function withMappedErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapPostgresError(error);
  }
}
