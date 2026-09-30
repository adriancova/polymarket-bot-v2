/**
 * SDK and HTTP errors → {@link SecureVenueError} (handoff §9.12, §15; ADR-007
 * §6–§7; U-4; conflict C-9).
 *
 * CLASSIFICATION RULES, in the order they are applied:
 *
 * 1. The SDK error class decides the family, by `instanceof` against the
 *    classes of the pinned `@polymarket/client@0.11.0`. A look-alike object
 *    that is not an instance (a plain object named `RequestRejectedError`, a
 *    class from another SDK copy) is `UNKNOWN`. Failing towards UNKNOWN is
 *    the safe direction: it forces reconciliation, never a guess.
 * 2. Inside `RequestRejectedError`, the HTTP status and the DOCUMENTED `code`
 *    decide the kind. The `error` text never does: the venue publishes three
 *    different strings for the same cancel-only/disabled condition (C-9), and
 *    its codes are examples, not an enumeration (U-4).
 * 3. Only own DATA properties of the SDK error are read (`status`, `code`,
 *    `retryAfter`). A getter is never invoked. An own ACCESSOR `code` is not
 *    "no code": it is a code that is present but unreadable, and reads as an
 *    undocumented code (so the effect is `UNKNOWN`, rule 4).
 * 4. `NOT_APPLIED` (a documented refusal) is given ONLY to 503 with the
 *    documented code `post_only_mode`: a code the pinned SDK could only have
 *    kept because the venue sent it. 401, 425 and 429 are ALWAYS effect
 *    `UNKNOWN` (the kind still follows the status, so a caller can back off),
 *    whether or not a code is present. ADR-007 §6: "an unrecognized code is
 *    surfaced as UNKNOWN and never ... silently treated as a rejection" — and
 *    with the pinned SDK the ABSENCE of a code can never be established:
 * 4a. The pinned `@polymarket/client@0.11.0` `ServiceClient` keeps a JSON
 *    body's `code` only when the body's `error` is truthy AND the code is a
 *    non-empty string (`if (error) return {message, ...(typeof code ==
 *    "string" && code !== "" ? {code} : {})}`); a text or HTML body, or a
 *    missing, empty or null `error`, discards the code entirely (CX-R3-01).
 *    So a code-less `RequestRejectedError` may still be a venue answer that
 *    carried an undocumented code, and it is UNKNOWN. The SDK message text is
 *    never consulted to tell these apart (rule 2).
 * 4b. A `RateLimitError` is ALWAYS effect `UNKNOWN` (kind `RATE_LIMITED`, so
 *    a caller still backs off). The pinned SDK throws it for EVERY 429
 *    BEFORE it reads the response body (`ServiceClient`: `if (status === 429)
 *    throw new RateLimitError(...)` precedes the body parse), so the venue's
 *    code, if any, is discarded. This is the only 429 the pinned SDK
 *    produces; a `RequestRejectedError` 429 (which it never builds) is
 *    UNKNOWN too, by rule 4.
 * 5. Reflection is contained. `instanceof` and property descriptors can run
 *    foreign code (a proxy trap); if any of it throws, the result is a fresh
 *    `UNKNOWN` error, and the thrown value is dropped unread.
 *
 * NOTHING FREE-TEXT CROSSES. The SDK's message embeds the venue's `error`
 * text and the request URL (`ServiceClient`: `${error} (${url})`), and its
 * `TransportError` wraps the raw fetch failure as `cause`, which can carry
 * the request and its L2 headers (`POLY_API_KEY`, `POLY_PASSPHRASE`,
 * `POLY_SIGNATURE`). None of it is copied: the result is built from
 * allow-listed scalars only.
 */

import {
  CancelledSigningError,
  RateLimitError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
} from "@polymarket/client";

import {
  DOCUMENTED_VENUE_ERROR_CODES,
  MAX_RETRY_AFTER_SECONDS,
  readSecureVenueErrorData,
  SecureVenueError,
  type CancelsAvailability,
  type RequestEffect,
  type SecureOperation,
  type SecureVenueErrorKind,
} from "./errors.js";

/** Read an own data property without invoking a getter (an accessor reads as `undefined`). */
function ownData(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * The venue code of an SDK error, read from its own DATA property. An own
 * ACCESSOR is present but unreadable (the getter is never invoked): it reads
 * as an undocumented code, never as "no code".
 */
function ownCode(target: object): CodeReading {
  const descriptor = Object.getOwnPropertyDescriptor(target, "code");
  if (descriptor !== undefined && !("value" in descriptor)) {
    return { venueCode: null, undocumentedVenueCode: true };
  }
  return codeOf(descriptor?.value);
}

function httpStatusOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function retryAfterOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RETRY_AFTER_SECONDS
    ? value
    : null;
}

export interface CodeReading {
  readonly venueCode: string | null;
  readonly undocumentedVenueCode: boolean;
}

export function codeOf(value: unknown): CodeReading {
  if (value === undefined || value === null || value === "") {
    return { venueCode: null, undocumentedVenueCode: false };
  }
  if (typeof value === "string" && DOCUMENTED_VENUE_ERROR_CODES.includes(value)) {
    return { venueCode: value, undocumentedVenueCode: false };
  }
  // Present but undocumented (or not even a string): record the fact, never
  // the value — an undocumented server string is unvetted text.
  return { venueCode: null, undocumentedVenueCode: true };
}

interface Classified {
  readonly kind: SecureVenueErrorKind;
  readonly effect: RequestEffect;
  readonly cancelsAvailable: CancelsAvailability;
}

/**
 * HTTP status + code reading → kind and effect. The `error` text is never
 * consulted. The kind follows the status (so a caller can still back off on
 * a 425 or 429); the effect is `NOT_APPLIED` only for 503 with the
 * documented `post_only_mode` (rule 4 above). 401, 425 and 429 are `UNKNOWN`
 * with or without a code: the pinned SDK can drop a code the venue sent
 * (rule 4a), so "no code" is never evidence of a clean refusal.
 */
export function classifyHttpRejection(status: number | null, code: CodeReading): Classified {
  if (status === 425) {
    return { kind: "ENGINE_RESTARTING", effect: "UNKNOWN", cancelsAvailable: "UNKNOWN" };
  }
  if (status === 503) {
    return code.venueCode === "post_only_mode"
      ? { kind: "POST_ONLY_MODE", effect: "NOT_APPLIED", cancelsAvailable: "YES" }
      : // C-9: cancel-only and fully-disabled are indistinguishable, and a
        // bare 503 may not even come from the matching engine. The request
        // may have been applied as far as this package can prove.
        { kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN", cancelsAvailable: "UNKNOWN" };
  }
  if (status === 429) {
    return { kind: "RATE_LIMITED", effect: "UNKNOWN", cancelsAvailable: null };
  }
  if (status === 401) {
    return { kind: "AUTHENTICATION_REJECTED", effect: "UNKNOWN", cancelsAvailable: null };
  }
  // U-4 / ADR-007 §6: an unrecognised status or code is never mapped to a
  // look-alike and never treated as a clean rejection.
  return { kind: "REQUEST_REJECTED", effect: "UNKNOWN", cancelsAvailable: null };
}

/** The value-free result every uncontained or unreadable input falls to. */
function unknownError(operation: SecureOperation): SecureVenueError {
  return new SecureVenueError({
    kind: "UNKNOWN",
    operation,
    effect: "UNKNOWN",
    httpStatus: null,
    venueCode: null,
    undocumentedVenueCode: false,
    retryAfterSeconds: null,
    cancelsAvailable: null,
    source: "non-SDK",
  });
}

/**
 * Map anything thrown by the SDK (or by code around it) to a redacted,
 * typed {@link SecureVenueError}. Never throws for any `error` value, and
 * never returns the input: a reflection failure while classifying it (a
 * proxy trap that throws, a revoked proxy) yields a fresh `UNKNOWN` error
 * and the thrown value is dropped unread.
 *
 * `operation` is a package-internal literal at every call site (this
 * function is not exported from the package entry points).
 */
export function mapVenueError(error: unknown, operation: SecureOperation): SecureVenueError {
  try {
    return classifyThrown(error, operation);
  } catch {
    return unknownError(operation);
  }
}

function classifyThrown(error: unknown, operation: SecureOperation): SecureVenueError {
  if (error instanceof SecureVenueError) {
    // Already mapped by this package. Rebuild from its own DATA fields,
    // re-validated against the closed vocabularies: never via a method a
    // subclass could override, and never trusting a field it could redefine.
    const prior = readSecureVenueErrorData(error);
    return prior === undefined ? unknownError(operation) : new SecureVenueError({ ...prior, operation });
  }

  const base = {
    operation,
    httpStatus: null,
    venueCode: null,
    undocumentedVenueCode: false,
    retryAfterSeconds: null,
    cancelsAvailable: null,
  } as const;

  if (error instanceof RateLimitError) {
    // Rule 4b: the pinned SDK discarded the body, so whether the venue sent a
    // code is unknowable; the effect is UNKNOWN whatever this object carries.
    // A code that IS present is still recorded the usual way (documented
    // value, or the bare fact that an undocumented one was there).
    const code = ownCode(error);
    return new SecureVenueError({
      ...base,
      kind: "RATE_LIMITED",
      effect: "UNKNOWN",
      cancelsAvailable: null,
      ...code,
      httpStatus: 429,
      retryAfterSeconds: retryAfterOf(ownData(error, "retryAfter")),
      source: "RateLimitError",
    });
  }
  if (error instanceof RequestRejectedError) {
    const status = httpStatusOf(ownData(error, "status"));
    const code = ownCode(error);
    return new SecureVenueError({
      ...base,
      ...classifyHttpRejection(status, code),
      ...code,
      httpStatus: status,
      retryAfterSeconds: retryAfterOf(ownData(error, "retryAfter")),
      source: "RequestRejectedError",
    });
  }
  if (error instanceof TransportError) {
    return new SecureVenueError({ ...base, kind: "TRANSPORT_FAILURE", effect: "UNKNOWN", source: "TransportError" });
  }
  if (error instanceof TimeoutError) {
    return new SecureVenueError({ ...base, kind: "TIMEOUT", effect: "UNKNOWN", source: "TimeoutError" });
  }
  if (error instanceof UnexpectedResponseError) {
    return new SecureVenueError({
      ...base,
      kind: "UNEXPECTED_RESPONSE",
      effect: "UNKNOWN",
      source: "UnexpectedResponseError",
    });
  }
  if (error instanceof UserInputError) {
    // SDK contract: "thrown when an action input fails SDK validation before
    // a request is sent".
    return new SecureVenueError({ ...base, kind: "INVALID_REQUEST", effect: "NOT_SENT", source: "UserInputError" });
  }
  if (error instanceof SigningError) {
    return new SecureVenueError({ ...base, kind: "SIGNING_FAILED", effect: "NOT_SENT", source: "SigningError" });
  }
  if (error instanceof CancelledSigningError) {
    return new SecureVenueError({
      ...base,
      kind: "SIGNING_FAILED",
      effect: "NOT_SENT",
      source: "CancelledSigningError",
    });
  }
  return unknownError(operation);
}

/** A local validation failure of this package's own interface: nothing was sent. */
export function invalidRequest(operation: SecureOperation): SecureVenueError {
  return new SecureVenueError({
    kind: "INVALID_REQUEST",
    operation,
    effect: "NOT_SENT",
    httpStatus: null,
    venueCode: null,
    undocumentedVenueCode: false,
    retryAfterSeconds: null,
    cancelsAvailable: null,
    source: "polymarket-secure",
  });
}
