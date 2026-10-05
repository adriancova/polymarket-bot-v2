/**
 * The order-heartbeat protocol's port contract and its one reader (ADR-033 D1
 * item 1, D2, D6).
 *
 * ## The port (ADR-033 D1, D2)
 *
 * {@link OrderHeartbeatTransport} is the ONLY way a heartbeat could leave the
 * process, and NO BINDING OF IT EXISTS IN THIS REPOSITORY: ADR-033 D2 forbids
 * writing a transport (no raw HTTP request, no hand-built signature, no use of
 * an `@internal` SDK member) until the user rules D5. Every test binds a fake.
 *
 * The contract is PROVISIONAL (ADR-033 D2): the guide's request and response
 * shapes (S-D17), as `test/fixtures/venue/heartbeat/heartbeat.json` records
 * them. A transport reports what the venue answered, unparsed, as
 * {@link HeartbeatTransportAnswer}:
 *
 * | The venue's answer | The transport reports |
 * | --- | --- |
 * | an HTTP response with a JSON body | `{ kind: "RESPONSE", httpStatus, body, retryAfterSeconds? }` |
 * | nothing usable (a transport failure, a timeout, a signing failure) | `{ kind: "FAILURE", error: { kind, effect, retryAfterSeconds } }` (WP-260's `SecureVenueError` fields) |
 *
 * ## The reader ({@link classifyHeartbeatAnswer})
 *
 * Reads the answer ONCE, by own data property, inside a `try`. Anything
 * outside the shapes above is `UNKNOWN`. Only `CONFIRMED` confirms a
 * heartbeat (ADR-033 D6, "Confirmed means a success response that carries the
 * next id"):
 *
 * | Answer | Outcome |
 * | --- | --- |
 * | 2xx whose body carries a readable `heartbeat_id` | `CONFIRMED` (the next id) |
 * | 2xx without one, e.g. S-D18's `{"status":"ok"}` | `SUCCESS_WITHOUT_ID`: unconfirmed, fails closed |
 * | 400 whose body carries a readable `heartbeat_id` | `INVALID_ID` (the expected id) |
 * | 429 | `RATE_LIMITED` |
 * | any other status | `REJECTED` |
 * | `FAILURE` | `FAILED` |
 * | anything else | `UNKNOWN` |
 *
 * A 400 is classified by the field the guide says it carries, never by its
 * `error_msg` text (the venue's error text is not a contract: C-9's lesson in
 * `errors.ts`).
 *
 * The heartbeat id is opaque. It is carried, compared and handed back to the
 * port; it is never logged and never put in an event (`controller.ts`).
 */

import { MAX_HEARTBEAT_ID_LENGTH } from "./venue-facts.js";

/** One heartbeat to send: the id of the chain (`""` to bootstrap, S-D17). */
export interface HeartbeatRequest {
  readonly heartbeatId: string;
}

/**
 * The injected transport (ADR-033 D1). It signs and sends INSIDE `send`: the
 * controller reads the send time just before calling it (ADR-033 D6, "the
 * send time never follows the request's departure"). It is expected never to
 * throw; a throw, or an answer outside {@link HeartbeatTransportAnswer}, is
 * read as `UNKNOWN`.
 */
export interface OrderHeartbeatTransport {
  send(request: HeartbeatRequest): Promise<unknown>;
}

/** What a transport reports (provisional, ADR-033 D2). */
export type HeartbeatTransportAnswer =
  | {
      readonly kind: "RESPONSE";
      readonly httpStatus: number;
      /** The response body, parsed from JSON. */
      readonly body: unknown;
      /** `Retry-After`, in seconds, when the venue sent one. */
      readonly retryAfterSeconds?: number | null;
    }
  | {
      readonly kind: "FAILURE";
      readonly error: { readonly kind: string; readonly effect: string; readonly retryAfterSeconds: number | null };
    };

export type HeartbeatOutcome =
  | { readonly kind: "CONFIRMED"; readonly nextHeartbeatId: string }
  | { readonly kind: "SUCCESS_WITHOUT_ID"; readonly httpStatus: number }
  | { readonly kind: "INVALID_ID"; readonly expectedHeartbeatId: string }
  | { readonly kind: "RATE_LIMITED"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "REJECTED"; readonly httpStatus: number }
  | { readonly kind: "FAILED"; readonly errorKind: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: "UNKNOWN" };

/** The largest `Retry-After` carried: one day (WP-260's `MAX_RETRY_AFTER_SECONDS`). */
const MAX_RETRY_AFTER_SECONDS = 86_400;
const ERROR_KIND = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** Own data property `key` of `target`, or `undefined` (a getter is never invoked). */
function own(target: unknown, key: string): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  if (typeof target !== "object" || target === null) return { found: false };
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !("value" in descriptor)) return { found: false };
  return { found: true, value: descriptor.value as unknown };
}

/** A readable heartbeat id: a non-empty string of printable characters, at most {@link MAX_HEARTBEAT_ID_LENGTH}. */
export function isHeartbeatId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_HEARTBEAT_ID_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function retryAfter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RETRY_AFTER_SECONDS ? value : null;
}

function bodyHeartbeatId(body: unknown): string | null {
  const field = own(body, "heartbeat_id");
  return field.found && isHeartbeatId(field.value) ? field.value : null;
}

/** Read a transport's answer. Never throws. */
export function classifyHeartbeatAnswer(answer: unknown): HeartbeatOutcome {
  try {
    const kind = own(answer, "kind");
    if (!kind.found) return Object.freeze({ kind: "UNKNOWN" as const });
    if (kind.value === "RESPONSE") {
      const status = own(answer, "httpStatus");
      const body = own(answer, "body");
      if (!status.found || !body.found) return Object.freeze({ kind: "UNKNOWN" as const });
      const httpStatus = status.value;
      if (typeof httpStatus !== "number" || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
        return Object.freeze({ kind: "UNKNOWN" as const });
      }
      if (httpStatus >= 200 && httpStatus <= 299) {
        const next = bodyHeartbeatId(body.value);
        return next === null
          ? Object.freeze({ kind: "SUCCESS_WITHOUT_ID" as const, httpStatus })
          : Object.freeze({ kind: "CONFIRMED" as const, nextHeartbeatId: next });
      }
      if (httpStatus === 400) {
        const expected = bodyHeartbeatId(body.value);
        return expected === null
          ? Object.freeze({ kind: "REJECTED" as const, httpStatus })
          : Object.freeze({ kind: "INVALID_ID" as const, expectedHeartbeatId: expected });
      }
      if (httpStatus === 429) {
        const retry = own(answer, "retryAfterSeconds");
        return Object.freeze({ kind: "RATE_LIMITED" as const, retryAfterSeconds: retry.found ? retryAfter(retry.value) : null });
      }
      return Object.freeze({ kind: "REJECTED" as const, httpStatus });
    }
    if (kind.value === "FAILURE") {
      const error = own(answer, "error");
      if (!error.found) return Object.freeze({ kind: "UNKNOWN" as const });
      const errorKind = own(error.value, "kind");
      const retry = own(error.value, "retryAfterSeconds");
      return Object.freeze({
        kind: "FAILED" as const,
        errorKind: errorKind.found && typeof errorKind.value === "string" && ERROR_KIND.test(errorKind.value) ? errorKind.value : "UNKNOWN",
        retryAfterSeconds: retry.found ? retryAfter(retry.value) : null,
      });
    }
    return Object.freeze({ kind: "UNKNOWN" as const });
  } catch {
    return Object.freeze({ kind: "UNKNOWN" as const });
  }
}

/**
 * The `RateLimitBudget` completion error of an outcome (WP-310's `GrantCompletion.error`): `null` for a success, the
 * documented 429 as `RATE_LIMITED` (which holds back only this operation, for its class and below), and every other
 * failure under a kind the budget does not act on.
 */
export function budgetErrorOf(outcome: HeartbeatOutcome): { readonly kind: string; readonly retryAfterSeconds: number | null } | null {
  switch (outcome.kind) {
    case "CONFIRMED":
    case "SUCCESS_WITHOUT_ID":
      return null;
    case "RATE_LIMITED":
      return { kind: "RATE_LIMITED", retryAfterSeconds: outcome.retryAfterSeconds };
    case "INVALID_ID":
    case "REJECTED":
      return { kind: "REQUEST_REJECTED", retryAfterSeconds: null };
    case "FAILED":
      return { kind: outcome.errorKind, retryAfterSeconds: outcome.retryAfterSeconds };
    case "UNKNOWN":
      return { kind: "UNKNOWN", retryAfterSeconds: null };
  }
}
