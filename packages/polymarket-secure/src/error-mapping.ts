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
 *    `retryAfter`). A getter is never invoked.
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
  SecureVenueError,
  type CancelsAvailability,
  type RequestEffect,
  type SecureOperation,
  type SecureVenueErrorKind,
} from "./errors.js";

/** The largest retry delay carried; anything larger or malformed becomes `null`. */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/** Read an own data property without invoking a getter. */
function ownData(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function httpStatusOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function retryAfterOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RETRY_AFTER_SECONDS
    ? value
    : null;
}

interface CodeReading {
  readonly venueCode: string | null;
  readonly undocumentedVenueCode: boolean;
}

function codeOf(value: unknown): CodeReading {
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

/** HTTP status + documented code → kind. The `error` text is never consulted. */
export function classifyHttpRejection(status: number | null, documentedCode: string | null): Classified {
  if (status === 425) {
    return { kind: "ENGINE_RESTARTING", effect: "NOT_APPLIED", cancelsAvailable: "UNKNOWN" };
  }
  if (status === 503) {
    return documentedCode === "post_only_mode"
      ? { kind: "POST_ONLY_MODE", effect: "NOT_APPLIED", cancelsAvailable: "YES" }
      : // C-9: cancel-only and fully-disabled are indistinguishable, and a
        // bare 503 may not even come from the matching engine. The request
        // may have been applied as far as this package can prove.
        { kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN", cancelsAvailable: "UNKNOWN" };
  }
  if (status === 429) {
    return { kind: "RATE_LIMITED", effect: "NOT_APPLIED", cancelsAvailable: null };
  }
  if (status === 401) {
    return { kind: "AUTHENTICATION_REJECTED", effect: "NOT_APPLIED", cancelsAvailable: null };
  }
  // U-4 / ADR-007 §6: an unrecognised status or code is never mapped to a
  // look-alike and never treated as a clean rejection.
  return { kind: "REQUEST_REJECTED", effect: "UNKNOWN", cancelsAvailable: null };
}

/**
 * Map anything thrown by the SDK (or by code around it) to a redacted,
 * typed {@link SecureVenueError}. Never throws; never returns the input.
 */
export function mapVenueError(error: unknown, operation: SecureOperation): SecureVenueError {
  if (error instanceof SecureVenueError) {
    // Already mapped by this package; rebuild from its data so no foreign
    // subclass or attached property survives.
    return new SecureVenueError({ ...error.toData(), operation });
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
    return new SecureVenueError({
      ...base,
      kind: "RATE_LIMITED",
      effect: "NOT_APPLIED",
      httpStatus: 429,
      retryAfterSeconds: retryAfterOf(ownData(error, "retryAfter")),
      source: "RateLimitError",
    });
  }
  if (error instanceof RequestRejectedError) {
    const status = httpStatusOf(ownData(error, "status"));
    const code = codeOf(ownData(error, "code"));
    const classified = classifyHttpRejection(status, code.venueCode);
    return new SecureVenueError({
      ...base,
      ...classified,
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
  return new SecureVenueError({ ...base, kind: "UNKNOWN", effect: "UNKNOWN", source: "non-SDK" });
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
