/**
 * Response-header feedback (WP-310 deliverable 2; handoff §9.12 "Consume
 * current rate-limit headers and per-signer warning headers").
 *
 * EXACTLY FIVE HEADERS ARE READ, the ones the dated reports document
 * (`verified-2026-09-16.md` §8, unchanged on 2026-09-30 §8; facts in
 * `venue-facts.ts`):
 *
 * | Header | Documented as | Read as |
 * | --- | --- | --- |
 * | `Poly-RateLimit-Remaining` | the applicable bucket's token balance after accounting; can be negative after cancel-all / cancel-market-orders on tiers with a negative cancel balance (D-21) | a signed integer of magnitude at most `MAX_TOKEN_MAGNITUDE` (`units.ts`: the budget then holds it exactly in thousandths of a token) |
 * | `Poly-RateLimit-Reset` | the Unix timestamp, in seconds, when the current wait period ends (pinned SDK `RateLimitUpdate.reset`) | an unsigned safe integer |
 * | `Poly-RateLimit-Tier` | the tier applied to the request; read it, never assume it (D-22) | a short token |
 * | `Poly-RateLimit-Warning` | `true` in warning mode, when enforcement would have rejected the request | exactly `true` or `false` |
 * | `Retry-After` | the delay in seconds before a retry: on 429 (§8), on 425 (E-06), on the post-only 503 (§2.4) | an unsigned integer number of seconds, only on those statuses |
 *
 * Header NAMES compare case-insensitively (HTTP field names are; the pinned
 * SDK reads them through `Headers.get`). Values are trimmed of surrounding
 * spaces and tabs and must match their grammar exactly.
 *
 * UNDOCUMENTED IS INERT. Any other header (an `X-RateLimit-*`, a
 * `RateLimit-Policy`, a `Poly-RateLimit-Limit`, a `Retry-After-Ms`, …) is
 * never read: only its NAME is recorded as an `UNDOCUMENTED_HEADER` flag,
 * and its value never reaches any field. A documented header with a value
 * outside its grammar is `MALFORMED_HEADER` and is not interpreted either.
 * A `Retry-After` on a status for which the venue does not document it is
 * flagged and not interpreted. A name given twice (in two cases) is ambiguous:
 * flagged, and neither value is read.
 */

import { MAX_RETRY_AFTER_SECONDS } from "../errors.js";

import { ownKeys, readOwn } from "./plain-data.js";
import { isExactTokenCount } from "./units.js";

export const DOCUMENTED_RATE_LIMIT_HEADERS = Object.freeze({
  REMAINING: "Poly-RateLimit-Remaining",
  RESET: "Poly-RateLimit-Reset",
  TIER: "Poly-RateLimit-Tier",
  WARNING: "Poly-RateLimit-Warning",
  RETRY_AFTER: "Retry-After",
} as const);

/** HTTP 425 Too Early: the matching engine is restarting (E-06). */
export const HTTP_TOO_EARLY = 425;
/** HTTP 429 Too Many Requests: the per-signer limiter rejected the request (§8). */
export const HTTP_TOO_MANY_REQUESTS = 429;
/** HTTP 503 Service Unavailable: post-only, cancel-only or disabled trading (§9, C-9). */
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** The statuses on which the venue documents `Retry-After`. */
const RETRY_AFTER_STATUSES: readonly number[] = Object.freeze([HTTP_TOO_MANY_REQUESTS, HTTP_TOO_EARLY, HTTP_SERVICE_UNAVAILABLE]);

export type FeedbackFlag =
  /** A header the reports do not document. Its value was never read. */
  | { readonly kind: "UNDOCUMENTED_HEADER"; readonly header: string }
  /** A documented header whose value is outside its grammar. Not interpreted. */
  | { readonly kind: "MALFORMED_HEADER"; readonly header: string }
  /** A documented header given more than once. Not interpreted. */
  | { readonly kind: "DUPLICATE_HEADER"; readonly header: string }
  /** `Retry-After` on a status the venue does not document it for. Not interpreted. */
  | { readonly kind: "RETRY_AFTER_UNDOCUMENTED_FOR_STATUS"; readonly httpStatus: number | null }
  /** The header map could not be read as a plain object of own data fields. */
  | { readonly kind: "HEADERS_UNREADABLE" }
  /** An SDK observation could not be read as WP-260's `RateLimitObservation`. */
  | { readonly kind: "OBSERVATION_UNREADABLE" };

/** The documented rate-limit state one response reported. `null`: not reported (or not interpretable). */
export interface RateLimitFeedback {
  readonly httpStatus: number | null;
  readonly remaining: number | null;
  readonly resetUnixSeconds: number | null;
  readonly tier: string | null;
  readonly warning: boolean;
  readonly retryAfterSeconds: number | null;
  readonly flags: readonly FeedbackFlag[];
}

const REMAINING = /^-?[0-9]{1,16}$/u;
const UNSIGNED = /^[0-9]{1,16}$/u;
const TIER = /^[A-Za-z0-9_-]{1,32}$/u;
/** RFC 9110 `token`: the only header names recorded verbatim (lower-cased). */
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u;
const OWS = /^[ \t]+|[ \t]+$/gu;

const LOWER_TO_DOCUMENTED: ReadonlyMap<string, string> = new Map(
  Object.values(DOCUMENTED_RATE_LIMIT_HEADERS).map((name) => [name.toLowerCase(), name] as const),
);

function statusOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** A `Poly-RateLimit-Remaining` value: a signed integer the budget can hold exactly (`units.ts`), or `null`. */
function remainingValue(text: string): number | null {
  if (!REMAINING.test(text)) return null;
  const value = Number(text);
  // `-0` is zero. A grammatical but absurd magnitude is malformed, never interpreted.
  return isExactTokenCount(value) ? value + 0 : null;
}

function unsignedInteger(text: string): number | null {
  if (!UNSIGNED.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** A `Retry-After` value in seconds, within WP-260's bound (`MAX_RETRY_AFTER_SECONDS`). */
function retryAfterValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RETRY_AFTER_SECONDS ? value : null;
}

const EMPTY_FEEDBACK = (httpStatus: number | null, flags: readonly FeedbackFlag[]): RateLimitFeedback =>
  Object.freeze({ httpStatus, remaining: null, resetUnixSeconds: null, tier: null, warning: false, retryAfterSeconds: null, flags: Object.freeze([...flags]) });

/**
 * Parse one response's headers. `headers` is a plain object of header name →
 * string value (the shape of the venue fixtures). Never throws.
 */
export function parseRateLimitHeaders(input: { readonly httpStatus: number | null; readonly headers: unknown }): RateLimitFeedback {
  const statusRead = readOwn(input, "httpStatus");
  const httpStatus = statusOf(statusRead.kind === "DATA" ? statusRead.value : null);
  const headersRead = readOwn(input, "headers");
  const headers = headersRead.kind === "DATA" ? headersRead.value : undefined;
  const keys = ownKeys(headers);
  if (keys === undefined) return EMPTY_FEEDBACK(httpStatus, [Object.freeze({ kind: "HEADERS_UNREADABLE" })]);

  const flags: FeedbackFlag[] = [];
  const values = new Map<string, string | null>();
  const duplicated = new Set<string>();
  for (const key of keys) {
    const documented = LOWER_TO_DOCUMENTED.get(key.toLowerCase());
    if (documented === undefined) {
      // Never read: the name alone is recorded (lower-cased), and only when it is a valid field name.
      flags.push(Object.freeze({ kind: "UNDOCUMENTED_HEADER", header: FIELD_NAME.test(key) ? key.toLowerCase() : "<not-a-field-name>" }));
      continue;
    }
    if (values.has(documented)) {
      duplicated.add(documented);
      continue;
    }
    const read = readOwn(headers, key);
    values.set(documented, read.kind === "DATA" && typeof read.value === "string" ? read.value.replace(OWS, "") : null);
  }
  for (const name of duplicated) {
    flags.push(Object.freeze({ kind: "DUPLICATE_HEADER", header: name }));
    values.delete(name);
  }

  const take = <T>(name: string, parse: (text: string) => T | null): T | null => {
    if (!values.has(name)) return null;
    const text = values.get(name);
    const parsed = text === null || text === undefined ? null : parse(text);
    if (parsed === null) flags.push(Object.freeze({ kind: "MALFORMED_HEADER", header: name }));
    return parsed;
  };

  const remaining = take(DOCUMENTED_RATE_LIMIT_HEADERS.REMAINING, remainingValue);
  const resetUnixSeconds = take(DOCUMENTED_RATE_LIMIT_HEADERS.RESET, unsignedInteger);
  const tier = take(DOCUMENTED_RATE_LIMIT_HEADERS.TIER, (text) => (TIER.test(text) ? text : null));
  const warning = take(DOCUMENTED_RATE_LIMIT_HEADERS.WARNING, (text) => (text === "true" ? true : text === "false" ? false : null)) === true;
  let retryAfterSeconds: number | null = null;
  if (values.has(DOCUMENTED_RATE_LIMIT_HEADERS.RETRY_AFTER)) {
    if (httpStatus === null || !RETRY_AFTER_STATUSES.includes(httpStatus)) {
      flags.push(Object.freeze({ kind: "RETRY_AFTER_UNDOCUMENTED_FOR_STATUS", httpStatus }));
    } else {
      retryAfterSeconds = take(DOCUMENTED_RATE_LIMIT_HEADERS.RETRY_AFTER, (text) => retryAfterValue(unsignedInteger(text)));
    }
  }
  return Object.freeze({ httpStatus, remaining, resetUnixSeconds, tier, warning, retryAfterSeconds, flags: Object.freeze(flags) });
}

/**
 * The same feedback from WP-260's sanitised SDK observation
 * (`RateLimitObservation`, delivered to `onRateLimitUpdate`), plus, when the
 * caller has it, the response's status and its `Retry-After` in seconds (a
 * `SecureVenueError`'s `httpStatus` and `retryAfterSeconds`). The SDK
 * observation carries no status, so a `Retry-After` without a documented
 * status is flagged and not interpreted, as for raw headers.
 */
export function feedbackFromObservation(
  observation: unknown,
  response: { readonly httpStatus: number | null; readonly retryAfterSeconds: number | null } = { httpStatus: null, retryAfterSeconds: null },
): RateLimitFeedback {
  const statusRead = readOwn(response, "httpStatus");
  const retryRead = readOwn(response, "retryAfterSeconds");
  const httpStatus = statusOf(statusRead.kind === "DATA" ? statusRead.value : null);
  const flags: FeedbackFlag[] = [];
  let retryAfterSeconds: number | null = null;
  const retryRaw = retryRead.kind === "DATA" ? retryRead.value : null;
  if (retryRaw !== null && retryRaw !== undefined) {
    if (httpStatus === null || !RETRY_AFTER_STATUSES.includes(httpStatus)) {
      flags.push(Object.freeze({ kind: "RETRY_AFTER_UNDOCUMENTED_FOR_STATUS", httpStatus }));
    } else {
      retryAfterSeconds = retryAfterValue(retryRaw);
      if (retryAfterSeconds === null) flags.push(Object.freeze({ kind: "MALFORMED_HEADER", header: DOCUMENTED_RATE_LIMIT_HEADERS.RETRY_AFTER }));
    }
  }
  const fields = ["remaining", "resetUnixSeconds", "tier", "warning"].map((key) => readOwn(observation, key));
  if (observation === null || typeof observation !== "object" || fields.some((field) => field.kind === "OPAQUE")) {
    return EMPTY_FEEDBACK(httpStatus, [...flags, Object.freeze({ kind: "OBSERVATION_UNREADABLE" as const })]);
  }
  const [remainingRead, resetRead, tierRead, warningRead] = fields;
  const value = (read: typeof remainingRead): unknown => (read?.kind === "DATA" ? read.value : null);
  const remainingRaw = value(remainingRead);
  const resetRaw = value(resetRead);
  const tierRaw = value(tierRead);
  const remainingNumber = typeof remainingRaw === "number" && Number.isSafeInteger(remainingRaw);
  const remaining = remainingNumber && isExactTokenCount(remainingRaw) ? remainingRaw + 0 : null;
  const resetUnixSeconds = typeof resetRaw === "number" && Number.isSafeInteger(resetRaw) && resetRaw >= 0 ? resetRaw : null;
  const tier = typeof tierRaw === "string" && TIER.test(tierRaw) ? tierRaw : null;
  if (
    (remainingRaw !== null && !remainingNumber) ||
    (resetRaw !== null && resetUnixSeconds === null) ||
    (tierRaw !== null && tier === null)
  ) {
    flags.push(Object.freeze({ kind: "OBSERVATION_UNREADABLE" }));
  }
  // A readable but absurd Remaining is malformed, as in the headers: never interpreted.
  if (remainingNumber && remaining === null) flags.push(Object.freeze({ kind: "MALFORMED_HEADER", header: DOCUMENTED_RATE_LIMIT_HEADERS.REMAINING }));
  return Object.freeze({
    httpStatus,
    remaining,
    resetUnixSeconds,
    tier,
    warning: value(warningRead) === true,
    retryAfterSeconds,
    flags: Object.freeze(flags),
  });
}

/** WP-260's observation `bucket` (the pinned SDK's `'order' | 'cancel'`) as a signer bucket, or `null`. */
export function signerBucketOfObservation(observation: unknown): "ORDER" | "CANCEL" | null {
  const read = readOwn(observation, "bucket");
  if (read.kind !== "DATA") return null;
  return read.value === "order" ? "ORDER" : read.value === "cancel" ? "CANCEL" : null;
}
