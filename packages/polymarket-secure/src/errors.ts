/**
 * The typed, redacted errors this package emits (handoff §9.12 "Handle current
 * error taxonomy", §15; ADR-007 §6 and §7; `protected-contracts.md` U-4).
 *
 * Every field is an allow-listed, non-secret datum: a kind, the operation, an
 * HTTP status number, a DOCUMENTED venue code, a retry delay and a fixed
 * sentence. Nothing from the SDK or the venue that is free text (an error
 * message, a URL, a response body, request headers, a `cause`) is ever copied
 * in. `redaction.ts` explains why this is the primary defence.
 */

import { inspect } from "node:util";

/** What went wrong, classified by status and documented code, never by text (C-9). */
export type SecureVenueErrorKind =
  /** The request failed validation (ours or the SDK's `UserInputError`) before anything was sent. */
  | "INVALID_REQUEST"
  /** The SDK could not produce a signature or auth payload (`SigningError`, `CancelledSigningError`). */
  | "SIGNING_FAILED"
  /**
   * HTTP 429 (`RateLimitError`). Back off. Through the pinned SDK its effect
   * is always `UNKNOWN`: the SDK discards a 429's body, so its code is unknowable.
   */
  | "RATE_LIMITED"
  /** HTTP 425: the matching engine is restarting (venue report §9, E-06). */
  | "ENGINE_RESTARTING"
  /** HTTP 503 with the documented code `post_only_mode` (venue report §9). */
  | "POST_ONLY_MODE"
  /**
   * HTTP 503 without a documented code. Conflict C-9: the venue gives three
   * strings for cancel-only and fully disabled trading and says the response
   * "does not establish whether cancels are available". Never keyed on text.
   */
  | "TRADING_UNAVAILABLE"
  /** HTTP 401. */
  | "AUTHENTICATION_REJECTED"
  /** Any other non-success HTTP status. The venue's codes are not enumerated (U-4). */
  | "REQUEST_REJECTED"
  /** A network or runtime transport failure (`TransportError`). */
  | "TRANSPORT_FAILURE"
  /** An SDK wait exceeded its polling budget (`TimeoutError`). */
  | "TIMEOUT"
  /** A response arrived but did not match the expected shape (`UnexpectedResponseError`). */
  | "UNEXPECTED_RESPONSE"
  /** Anything this package cannot classify. First-class, never guessed (ADR-007 §6). */
  | "UNKNOWN";

/**
 * What the failed request did at the venue, as far as this package can know.
 *
 * - `NOT_SENT`: nothing left the process.
 * - `NOT_APPLIED`: the venue answered with a documented refusal whose code
 *   the pinned SDK could only have kept because the venue sent it: 503 with
 *   `post_only_mode`, never one the SDK may have inferred from the `error`
 *   text (`error-mapping.ts` rule 4c, from 0.12.0). 401, 425 and 429 are
 *   always `UNKNOWN`: the pinned SDK
 *   discards the body of every 429, and drops a 401/425 body's `code`
 *   whenever the body's `error` is missing, empty or null (or the body is
 *   not JSON), so "no code" can never be established (ADR-007 §6; CX-R3-01).
 * - `UNKNOWN`: the request may have been applied. For a placement this is
 *   `SUBMISSION_UNKNOWN` territory: reconcile before any retry with a new
 *   salt (ADR-007 §2 step 10, §3).
 */
export type RequestEffect = "NOT_SENT" | "NOT_APPLIED" | "UNKNOWN";

/** The narrow-interface operation that failed. */
export type SecureOperation =
  | "CREATE_CLIENT"
  | "CREATE_LIMIT_ORDER"
  | "POST_ORDER"
  | "POST_ORDERS"
  | "CANCEL_ORDER"
  | "CANCEL_ORDERS"
  | "CANCEL_MARKET_ORDERS"
  | "CANCEL_ALL"
  | "FETCH_ORDER"
  | "CLOSE";

/**
 * Whether cancels are known to be accepted while this condition lasts.
 * `YES` only where the venue documents it (post-only mode, venue report §9);
 * `UNKNOWN` for every other restriction (C-9, E-05: "a cancel attempt is the
 * only evidence"); `null` when the error is not a trading restriction.
 */
export type CancelsAvailability = "YES" | "UNKNOWN" | null;

/** The only venue error `code` values the documentation defines (venue report §2.4, U-4). */
export const DOCUMENTED_VENUE_ERROR_CODES: readonly string[] = Object.freeze(["post_only_mode"]);

/** Fixed, value-free sentences. Never interpolated with venue or SDK text. */
const KIND_SENTENCES: Readonly<Record<SecureVenueErrorKind, string>> = Object.freeze({
  INVALID_REQUEST: "the request failed validation before it was sent",
  SIGNING_FAILED: "a required signature could not be produced; nothing was sent",
  RATE_LIMITED: "the venue rejected the request under its rate limit",
  ENGINE_RESTARTING: "the venue matching engine is restarting (HTTP 425)",
  POST_ONLY_MODE: "the venue is in post-only mode (HTTP 503, code post_only_mode)",
  TRADING_UNAVAILABLE:
    "the venue answered HTTP 503 without a documented code; cancel-only and fully disabled trading are indistinguishable (C-9)",
  AUTHENTICATION_REJECTED: "the venue rejected the request's authentication (HTTP 401)",
  REQUEST_REJECTED: "the venue rejected the request with an unclassified status or code (U-4)",
  TRANSPORT_FAILURE: "the request failed in transport; it may or may not have reached the venue",
  TIMEOUT: "an SDK wait timed out; the outcome is unknown",
  UNEXPECTED_RESPONSE: "the venue response did not match the expected shape; the outcome is unknown",
  UNKNOWN: "an unclassified failure; the outcome is unknown",
});

export interface SecureVenueErrorData {
  readonly kind: SecureVenueErrorKind;
  readonly operation: SecureOperation;
  readonly effect: RequestEffect;
  /** The HTTP status, when the failure was an HTTP response. */
  readonly httpStatus: number | null;
  /** A venue code, ONLY when it is documented ({@link DOCUMENTED_VENUE_ERROR_CODES}). */
  readonly venueCode: string | null;
  /** True when the venue sent a code that is not documented; its value is not carried. */
  readonly undocumentedVenueCode: boolean;
  /** Seconds the venue asked the caller to wait, when it said so. */
  readonly retryAfterSeconds: number | null;
  readonly cancelsAvailable: CancelsAvailability;
  /** The SDK error class name when it is one of the known SDK classes, else `"non-SDK"`. */
  readonly source: SecureVenueErrorSource;
}

/**
 * Where a mapped error came from: one of the pinned SDK's error classes this
 * package classifies, `"non-SDK"` for anything else, or `"polymarket-secure"`
 * for this package's own validation.
 */
export type SecureVenueErrorSource =
  | "RateLimitError"
  | "RequestRejectedError"
  | "TransportError"
  | "TimeoutError"
  | "UnexpectedResponseError"
  | "UserInputError"
  | "SigningError"
  | "CancelledSigningError"
  | "non-SDK"
  | "polymarket-secure";

// ---------------------------------------------------------------------------
// Closed vocabularies. Every field of a SecureVenueError is checked against
// these on EVERY construction, so no caller, subclass or mutated instance can
// put a value outside them into an error this package emits.

const KINDS: ReadonlySet<string> = new Set<SecureVenueErrorKind>([
  "INVALID_REQUEST",
  "SIGNING_FAILED",
  "RATE_LIMITED",
  "ENGINE_RESTARTING",
  "POST_ONLY_MODE",
  "TRADING_UNAVAILABLE",
  "AUTHENTICATION_REJECTED",
  "REQUEST_REJECTED",
  "TRANSPORT_FAILURE",
  "TIMEOUT",
  "UNEXPECTED_RESPONSE",
  "UNKNOWN",
]);
const OPERATIONS: ReadonlySet<string> = new Set<SecureOperation>([
  "CREATE_CLIENT",
  "CREATE_LIMIT_ORDER",
  "POST_ORDER",
  "POST_ORDERS",
  "CANCEL_ORDER",
  "CANCEL_ORDERS",
  "CANCEL_MARKET_ORDERS",
  "CANCEL_ALL",
  "FETCH_ORDER",
  "CLOSE",
]);
const EFFECTS: ReadonlySet<string> = new Set<RequestEffect>(["NOT_SENT", "NOT_APPLIED", "UNKNOWN"]);
const SOURCES: ReadonlySet<string> = new Set<SecureVenueErrorSource>([
  "RateLimitError",
  "RequestRejectedError",
  "TransportError",
  "TimeoutError",
  "UnexpectedResponseError",
  "UserInputError",
  "SigningError",
  "CancelledSigningError",
  "non-SDK",
  "polymarket-secure",
]);

/** The largest retry delay carried (one day). */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

const FIELD_NAMES = [
  "kind",
  "operation",
  "effect",
  "httpStatus",
  "venueCode",
  "undocumentedVenueCode",
  "retryAfterSeconds",
  "cancelsAvailable",
  "source",
] as const;

export function isSecureOperation(value: unknown): value is SecureOperation {
  return typeof value === "string" && OPERATIONS.has(value);
}

/**
 * Read `candidate` as {@link SecureVenueErrorData}: own DATA properties only
 * (a getter is never invoked), every value inside its closed vocabulary.
 * Returns `undefined` for anything else, including a candidate whose
 * reflection throws (a revoked proxy, a throwing trap). Never throws.
 */
export function readSecureVenueErrorData(candidate: unknown): SecureVenueErrorData | undefined {
  try {
    if (typeof candidate !== "object" || candidate === null) return undefined;
    const values: Record<string, unknown> = {};
    for (const key of FIELD_NAMES) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      values[key] = descriptor.value;
    }
    const { kind, operation, effect, httpStatus, venueCode, undocumentedVenueCode, retryAfterSeconds, cancelsAvailable, source } =
      values;
    const valid =
      typeof kind === "string" &&
      KINDS.has(kind) &&
      isSecureOperation(operation) &&
      typeof effect === "string" &&
      EFFECTS.has(effect) &&
      (httpStatus === null ||
        (typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) &&
      (venueCode === null || (typeof venueCode === "string" && DOCUMENTED_VENUE_ERROR_CODES.includes(venueCode))) &&
      typeof undocumentedVenueCode === "boolean" &&
      (retryAfterSeconds === null ||
        (typeof retryAfterSeconds === "number" &&
          Number.isFinite(retryAfterSeconds) &&
          retryAfterSeconds >= 0 &&
          retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS)) &&
      (cancelsAvailable === null || cancelsAvailable === "YES" || cancelsAvailable === "UNKNOWN") &&
      typeof source === "string" &&
      SOURCES.has(source);
    if (!valid) return undefined;
    return Object.freeze({
      kind: kind as SecureVenueErrorKind,
      operation,
      effect: effect as RequestEffect,
      httpStatus: httpStatus as number | null,
      venueCode: venueCode as string | null,
      undocumentedVenueCode,
      retryAfterSeconds: retryAfterSeconds as number | null,
      cancelsAvailable: cancelsAvailable as CancelsAvailability,
      source: source as SecureVenueErrorSource,
    });
  } catch {
    return undefined;
  }
}

/**
 * A typed, redacted venue error.
 *
 * It has no `cause`, and its `message` is one of the fixed sentences above
 * plus the kind and operation. `toJSON()` and `util.inspect` both render only
 * {@link SecureVenueErrorData}.
 *
 * The constructor VALIDATES its input with {@link readSecureVenueErrorData}
 * (own data properties, closed vocabularies) and throws a `TypeError` with a
 * fixed, value-free message on anything else. The instance is frozen, so its
 * fields cannot be changed after the check.
 */
export class SecureVenueError extends Error implements SecureVenueErrorData {
  override readonly name = "SecureVenueError";
  readonly kind: SecureVenueErrorKind;
  readonly operation: SecureOperation;
  readonly effect: RequestEffect;
  readonly httpStatus: number | null;
  readonly venueCode: string | null;
  readonly undocumentedVenueCode: boolean;
  readonly retryAfterSeconds: number | null;
  readonly cancelsAvailable: CancelsAvailability;
  readonly source: SecureVenueErrorSource;

  constructor(data: SecureVenueErrorData) {
    const valid = readSecureVenueErrorData(data);
    if (valid === undefined) {
      // Fixed text: the rejected input is never echoed.
      throw new TypeError("SecureVenueError: data outside the closed vocabularies");
    }
    super(`${valid.operation}: ${valid.kind}: ${KIND_SENTENCES[valid.kind]}`);
    this.kind = valid.kind;
    this.operation = valid.operation;
    this.effect = valid.effect;
    this.httpStatus = valid.httpStatus;
    this.venueCode = valid.venueCode;
    this.undocumentedVenueCode = valid.undocumentedVenueCode;
    this.retryAfterSeconds = valid.retryAfterSeconds;
    this.cancelsAvailable = valid.cancelsAvailable;
    this.source = valid.source;
    Object.freeze(this);
  }

  /** The allow-listed fields only. */
  toData(): SecureVenueErrorData {
    return {
      kind: this.kind,
      operation: this.operation,
      effect: this.effect,
      httpStatus: this.httpStatus,
      venueCode: this.venueCode,
      undocumentedVenueCode: this.undocumentedVenueCode,
      retryAfterSeconds: this.retryAfterSeconds,
      cancelsAvailable: this.cancelsAvailable,
      source: this.source,
    };
  }

  toJSON(): SecureVenueErrorData & { readonly name: string; readonly message: string } {
    return { name: this.name, message: this.message, ...this.toData() };
  }

  [inspect.custom](): string {
    return `SecureVenueError ${JSON.stringify(this.toJSON())}`;
  }
}

/** Why the signer boundary refused (ADR-010 §3). */
export type SignerRefusalReason =
  /** The run-mode context is not a plain object of three own data properties. */
  | "CONTEXT_UNREADABLE"
  /** `runMode` is not a §11 run mode (for example `REPLAY`). */
  | "RUN_MODE_UNKNOWN"
  /** `runMode` is BACKTEST, PAPER or SHADOW: modes that need no signer (§11). */
  | "RUN_MODE_REQUIRES_NO_SIGNER"
  /** `maximumRunMode` is not a §11 run mode. */
  | "MAXIMUM_RUN_MODE_UNKNOWN"
  /** `runMode` exceeds the process maximum (§11). */
  | "RUN_MODE_ABOVE_MAXIMUM"
  /** `allowRealOrders` is anything but the boolean `true`. */
  | "REAL_ORDERS_NOT_ALLOWED"
  /** The signer is not a handle this package sealed. */
  | "SIGNER_NOT_SEALED"
  /** A test-only mock signer was handed to the real venue SDK factory. */
  | "MOCK_SIGNER_REJECTED_BY_REAL_SDK"
  /** A non-mock signer was handed to the test-only factory. */
  | "REAL_SIGNER_REJECTED_BY_TEST_FACTORY";

const REFUSAL_REASONS: ReadonlySet<string> = new Set<SignerRefusalReason>([
  "CONTEXT_UNREADABLE",
  "RUN_MODE_UNKNOWN",
  "RUN_MODE_REQUIRES_NO_SIGNER",
  "MAXIMUM_RUN_MODE_UNKNOWN",
  "RUN_MODE_ABOVE_MAXIMUM",
  "REAL_ORDERS_NOT_ALLOWED",
  "SIGNER_NOT_SEALED",
  "MOCK_SIGNER_REJECTED_BY_REAL_SDK",
  "REAL_SIGNER_REJECTED_BY_TEST_FACTORY",
]);

/** A copy of 1…9 known reasons, or `undefined`. Own data entries only; never throws. */
function readRefusalReasons(candidate: unknown): readonly SignerRefusalReason[] | undefined {
  try {
    if (!Array.isArray(candidate)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 1 || length > REFUSAL_REASONS.size) return undefined;
    const out: SignerRefusalReason[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
      const value: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      if (typeof value !== "string" || !REFUSAL_REASONS.has(value)) return undefined;
      out.push(value as SignerRefusalReason);
    }
    return Object.freeze(out);
  } catch {
    return undefined;
  }
}

/**
 * The signer boundary refused to construct a secure client. Carries reason
 * codes only; never a value from the context it refused. The constructor
 * accepts only 1…9 known {@link SignerRefusalReason} codes and throws a
 * `TypeError` with a fixed, value-free message on anything else.
 */
export class SignerBoundaryRefusal extends Error {
  override readonly name = "SignerBoundaryRefusal";
  readonly reasons: readonly SignerRefusalReason[];

  constructor(reasons: readonly SignerRefusalReason[]) {
    const valid = readRefusalReasons(reasons);
    if (valid === undefined) {
      throw new TypeError("SignerBoundaryRefusal: reasons outside the closed vocabulary");
    }
    super(`the signer boundary refused to construct a secure venue client: ${valid.join(", ")}`);
    this.reasons = valid;
    Object.freeze(this);
  }

  toJSON(): { readonly name: string; readonly message: string; readonly reasons: readonly SignerRefusalReason[] } {
    return { name: this.name, message: this.message, reasons: this.reasons };
  }

  [inspect.custom](): string {
    return `SignerBoundaryRefusal ${JSON.stringify(this.toJSON())}`;
  }
}
