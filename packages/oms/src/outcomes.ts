/**
 * Classification of the venue port's answers (ADR-007 §5–§7; WP-260's
 * "For WP-270 and later").
 *
 * Each answer is read ONCE, by own data property, inside a `try`; anything
 * outside the port's declared shapes is UNKNOWN for a placement and a cancel,
 * and FAILED for a signing (a signing never transmits, so nothing can exist).
 *
 * | Port answer | Class | Why |
 * | --- | --- | --- |
 * | `ACCEPTED` with a safe order id and `LIVE`/`MATCHED`/`DELAYED` | ACCEPTED | the venue holds the order |
 * | `REJECTED` with a reason the pinned SDK names | REJECTED | a definitive venue answer (WP-260 assumption: SDK codes are trusted) |
 * | `REFUSED` whose error is `POST_ONLY_MODE` / `NOT_APPLIED` | REFUSED | the one documented refusal (503 `post_only_mode`) |
 * | `NOT_SENT` whose error effect is `NOT_SENT` | NOT_SENT | nothing left the process |
 * | `UNKNOWN` (incl. `SDK_UNMATCHED`, a 401, 425 or 429, a transport failure, a timeout) | UNKNOWN | the order may exist (§6 invariant 6) |
 * | anything else: a throw, a malformed answer, a contradiction (`REFUSED` with a 425) | UNKNOWN | never a rejection by default |
 *
 * A REFUSED or NOT_SENT whose error contradicts it is UNKNOWN: the OMS does not
 * resolve the port's inconsistency in the optimistic direction.
 */

import { compositeKey, readArray, readField, readFields } from "./guards.js";
import type { SignedOrderHandle, SignedOrderIdentity } from "./ports.js";
import { MAX_ORDERS_PER_BATCH } from "./venue-facts.js";

/** The pinned SDK's named rejection reasons (WP-260 `PlacementRejectionReason`). Any other reason is UNKNOWN. */
export const KNOWN_REJECTION_REASONS: readonly string[] = Object.freeze([
  "MARKET_NOT_READY",
  "INSUFFICIENT_BALANCE_OR_ALLOWANCE",
  "INVALID_NONCE",
  "INVALID_EXPIRATION",
  "POST_ONLY_WOULD_CROSS",
  "POST_ONLY_MODE",
  "FOK_NOT_FILLED",
  "FAK_NOT_FILLED",
]);

/** Accepted placement statuses (venue report §2.2; WP-260 `AcceptedPlacementStatus`). */
export type AcceptedStatus = "LIVE" | "MATCHED" | "DELAYED";

/** A venue order id: the secure adapter's own safe-id grammar, within the database identifier bound. */
const VENUE_ID = /^[A-Za-z0-9_\-:.]{1,200}$/u;

export function isVenueId(value: unknown): value is string {
  return typeof value === "string" && VENUE_ID.test(value);
}

/** An error kind as a database `code` (letters, digits, `_`), or `null`. */
const ERROR_KIND = /^[A-Z][A-Z0-9_]{0,63}$/u;

export type PlacementClass =
  | { readonly kind: "ACCEPTED"; readonly venueOrderId: string; readonly status: AcceptedStatus }
  | { readonly kind: "REJECTED"; readonly reason: string }
  | { readonly kind: "REFUSED"; readonly errorKind: "POST_ONLY_MODE"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "NOT_SENT"; readonly errorKind: string | null }
  | {
      readonly kind: "UNKNOWN";
      /** `SDK_UNMATCHED`, `SDK_UNKNOWN_CODE`, `UNRECOGNISED_RESPONSE`, `ERROR`, `PORT_THREW`, `MALFORMED`, `BATCH_*`. */
      readonly reason: string;
      /** The error kind when the port gave one (`ENGINE_RESTARTING`, `RATE_LIMITED`, `TRANSPORT_FAILURE`, ...). */
      readonly errorKind: string | null;
      readonly retryAfterSeconds: number | null;
    };

function unknown(reason: string, errorKind: string | null = null, retryAfterSeconds: number | null = null): PlacementClass {
  return Object.freeze({ kind: "UNKNOWN", reason, errorKind, retryAfterSeconds });
}

interface ErrorRead {
  readonly kind: string | null;
  readonly effect: string | null;
  readonly retryAfterSeconds: number | null;
}

/** Read an error view once. `undefined` when it is present but unreadable. */
function readError(value: unknown): ErrorRead | null | undefined {
  if (value === null) return null;
  const fields = readFields(value, ["kind", "effect", "retryAfterSeconds"]);
  if (fields === undefined) return undefined;
  const kind = typeof fields.kind === "string" && ERROR_KIND.test(fields.kind) ? fields.kind : null;
  const effect = typeof fields.effect === "string" && ERROR_KIND.test(fields.effect) ? fields.effect : null;
  const retry = fields.retryAfterSeconds;
  const retryAfterSeconds = typeof retry === "number" && Number.isSafeInteger(retry) && retry >= 0 ? retry : null;
  return Object.freeze({ kind, effect, retryAfterSeconds });
}

/** One placement answer → its class. Never throws. */
export function readPlacementOutcome(raw: unknown): PlacementClass {
  try {
    return readPlacementUncontained(raw);
  } catch {
    return unknown("MALFORMED");
  }
}

function readPlacementUncontained(raw: unknown): PlacementClass {
  const kindRead = readField(raw, "kind");
  if (kindRead.kind !== "DATA") return unknown("MALFORMED");
  switch (kindRead.value) {
    case "ACCEPTED": {
      const fields = readFields(raw, ["orderId", "status"]);
      if (fields === undefined) return unknown("MALFORMED");
      const status = fields.status;
      if (!isVenueId(fields.orderId) || (status !== "LIVE" && status !== "MATCHED" && status !== "DELAYED")) {
        return unknown("UNRECOGNISED_RESPONSE");
      }
      return Object.freeze({ kind: "ACCEPTED", venueOrderId: fields.orderId, status });
    }
    case "REJECTED": {
      const reason = readField(raw, "reason");
      if (reason.kind !== "DATA" || typeof reason.value !== "string" || !KNOWN_REJECTION_REASONS.includes(reason.value)) {
        return unknown("SDK_UNKNOWN_CODE");
      }
      return Object.freeze({ kind: "REJECTED", reason: reason.value });
    }
    case "REFUSED": {
      const errorRead = readField(raw, "error");
      const error = errorRead.kind === "DATA" ? readError(errorRead.value) : undefined;
      if (error === undefined || error === null) return unknown("MALFORMED");
      if (error.kind === "POST_ONLY_MODE" && error.effect === "NOT_APPLIED") {
        return Object.freeze({ kind: "REFUSED", errorKind: "POST_ONLY_MODE", retryAfterSeconds: error.retryAfterSeconds });
      }
      // WP-260 CX-R3-01: only 503 post_only_mode is a refusal. Anything else claiming to be one is unproven.
      return unknown("ERROR", error.kind, error.retryAfterSeconds);
    }
    case "NOT_SENT": {
      const errorRead = readField(raw, "error");
      const error = errorRead.kind === "DATA" ? readError(errorRead.value) : undefined;
      if (error === undefined || error === null) return unknown("MALFORMED");
      if (error.effect !== "NOT_SENT") return unknown("ERROR", error.kind, error.retryAfterSeconds);
      return Object.freeze({ kind: "NOT_SENT", errorKind: error.kind });
    }
    case "UNKNOWN": {
      const fields = readFields(raw, ["reason", "error"]);
      if (fields === undefined) return unknown("MALFORMED");
      const reason = typeof fields.reason === "string" && ERROR_KIND.test(fields.reason) ? fields.reason : "UNRECOGNISED_RESPONSE";
      const error = fields.error === undefined ? null : readError(fields.error);
      return unknown(reason, error?.kind ?? null, error?.retryAfterSeconds ?? null);
    }
    default:
      return unknown("MALFORMED");
  }
}

/**
 * A batch answer → one class per submitted order (I-R2-2).
 *
 * - A batch the adapter refused whole comes back as NOT_SENT outcomes only, at
 *   most `MAX_ORDERS_PER_BATCH + 1` of them, NOT one per input. Their count and
 *   order say nothing about the inputs, so they are NEVER paired by position:
 *   the batch-level fact "nothing left the process" is applied to every input.
 * - Any mix of NOT_SENT with another class is outside the adapter's contract:
 *   every input is UNKNOWN.
 * - An answer of the wrong length, or not an array, or empty: every input is
 *   UNKNOWN.
 * - Otherwise (exactly one answer per input, none NOT_SENT) the adapter's
 *   documented order ("one outcome per order, in request order") pairs them.
 */
export function classifyBatch(raw: unknown, inputs: number): readonly PlacementClass[] {
  const all = (cls: PlacementClass): readonly PlacementClass[] => Object.freeze(new Array<PlacementClass>(inputs).fill(cls));
  const entries = readArray(raw, MAX_ORDERS_PER_BATCH + 1);
  if (entries === undefined || entries.length === 0) return all(unknown("BATCH_UNRECOGNISED"));
  const classes = entries.map((entry) => readPlacementOutcome(entry));
  const notSent = classes.filter((cls) => cls.kind === "NOT_SENT").length;
  if (notSent === classes.length) return all(Object.freeze({ kind: "NOT_SENT", errorKind: "BATCH_REFUSED" }));
  if (notSent > 0) return all(unknown("BATCH_MIXED_NOT_SENT"));
  if (classes.length !== inputs) return all(unknown("BATCH_LENGTH_MISMATCH"));
  return Object.freeze(classes);
}

// ---------------------------------------------------------------------------
// Signing.

export type SignClass =
  | { readonly kind: "SIGNED"; readonly handle: SignedOrderHandle; readonly identity: SignedOrderIdentity }
  | { readonly kind: "FAILED"; readonly errorKind: string | null };

const SALT = /^(?:0|[1-9][0-9]{0,77})$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const UNSIGNED = /^(?:0|[1-9][0-9]{0,77})$/u;

/** Read a signed identity once. `undefined` for anything outside WP-260's `SignedOrderIdentity`. */
export function readIdentity(value: unknown): SignedOrderIdentity | undefined {
  const fields = readFields(value, [
    "salt",
    "maker",
    "signer",
    "tokenId",
    "side",
    "makerAmount",
    "takerAmount",
    "orderType",
    "expiration",
    "timestamp",
    "signatureType",
    "postOnly",
  ]);
  if (fields === undefined) return undefined;
  const ok =
    typeof fields.salt === "string" &&
    SALT.test(fields.salt) &&
    typeof fields.maker === "string" &&
    ADDRESS.test(fields.maker) &&
    typeof fields.signer === "string" &&
    ADDRESS.test(fields.signer) &&
    typeof fields.tokenId === "string" &&
    fields.tokenId.length > 0 &&
    fields.tokenId.length <= 200 &&
    (fields.side === "BUY" || fields.side === "SELL") &&
    typeof fields.makerAmount === "string" &&
    UNSIGNED.test(fields.makerAmount) &&
    typeof fields.takerAmount === "string" &&
    UNSIGNED.test(fields.takerAmount) &&
    (fields.orderType === "GTC" || fields.orderType === "GTD" || fields.orderType === "FOK" || fields.orderType === "FAK") &&
    typeof fields.expiration === "number" &&
    Number.isSafeInteger(fields.expiration) &&
    fields.expiration >= 0 &&
    typeof fields.timestamp === "string" &&
    UNSIGNED.test(fields.timestamp) &&
    typeof fields.signatureType === "number" &&
    Number.isSafeInteger(fields.signatureType) &&
    typeof fields.postOnly === "boolean";
  if (!ok) return undefined;
  return Object.freeze({
    salt: fields.salt as string,
    maker: fields.maker as string,
    signer: fields.signer as string,
    tokenId: fields.tokenId as string,
    side: fields.side as "BUY" | "SELL",
    makerAmount: fields.makerAmount as string,
    takerAmount: fields.takerAmount as string,
    orderType: fields.orderType as SignedOrderIdentity["orderType"],
    expiration: fields.expiration as number,
    timestamp: fields.timestamp as string,
    signatureType: fields.signatureType as number,
    postOnly: fields.postOnly as boolean,
  });
}

/**
 * One signing answer → its class. A signing never transmits (WP-260 L-R2-1),
 * so anything but a well-formed SIGNED is FAILED: no order can exist.
 */
export function readSignOutcome(raw: unknown): SignClass {
  try {
    const kind = readField(raw, "kind");
    if (kind.kind !== "DATA" || kind.value !== "SIGNED") {
      const errorRead = readField(raw, "error");
      const error = errorRead.kind === "DATA" ? readError(errorRead.value) : undefined;
      return Object.freeze({ kind: "FAILED", errorKind: error?.kind ?? null });
    }
    const orderRead = readField(raw, "order");
    if (orderRead.kind !== "DATA" || orderRead.value === null || typeof orderRead.value !== "object") {
      return Object.freeze({ kind: "FAILED", errorKind: "MALFORMED" });
    }
    const handle = orderRead.value as SignedOrderHandle;
    const identityRead = readField(handle, "identity");
    const identity = identityRead.kind === "DATA" ? readIdentity(identityRead.value) : undefined;
    if (identity === undefined) return Object.freeze({ kind: "FAILED", errorKind: "MALFORMED" });
    return Object.freeze({ kind: "SIGNED", handle, identity });
  } catch {
    return Object.freeze({ kind: "FAILED", errorKind: "MALFORMED" });
  }
}

// ---------------------------------------------------------------------------
// Cancels.

/** The documented per-order "not canceled" reasons (venue report §2.5), as WP-260 carries them. */
export const DOCUMENTED_NOT_CANCELED_REASONS: readonly string[] = Object.freeze([
  "Order not found or already canceled",
  "Order already matched",
  "Order not found",
  "Order already canceled",
]);

export type CancelClass =
  | { readonly kind: "CANCELED" }
  /** The venue answered that this order was not canceled. Its reason is never trusted to pick a state. */
  | { readonly kind: "NOT_CANCELED"; readonly reason: string }
  /** The cancel was not applied: nothing left the process, or a documented refusal. */
  | { readonly kind: "NOT_APPLIED"; readonly errorKind: string | null }
  | { readonly kind: "UNKNOWN"; readonly errorKind: string | null };

/** One cancel answer for `venueOrderId` → its class. Never throws. */
export function readCancelOutcome(raw: unknown, venueOrderId: string): CancelClass {
  try {
    const kind = readField(raw, "kind");
    if (kind.kind !== "DATA") return Object.freeze({ kind: "UNKNOWN", errorKind: null });
    if (kind.value === "COMPLETED") {
      const fields = readFields(raw, ["canceled", "notCanceled"]);
      if (fields === undefined) return Object.freeze({ kind: "UNKNOWN", errorKind: null });
      const canceled = readArray(fields.canceled, 100_000);
      const notCanceled = readArray(fields.notCanceled, 100_000);
      if (canceled === undefined || notCanceled === undefined) return Object.freeze({ kind: "UNKNOWN", errorKind: null });
      const inCanceled = canceled.some((id) => id === venueOrderId);
      let notCanceledReason: string | undefined;
      for (const entry of notCanceled) {
        const pair = readFields(entry, ["orderId", "reason"]);
        if (pair === undefined) return Object.freeze({ kind: "UNKNOWN", errorKind: null });
        if (pair.orderId === venueOrderId) {
          if (notCanceledReason !== undefined) return Object.freeze({ kind: "UNKNOWN", errorKind: null });
          notCanceledReason =
            typeof pair.reason === "string" && DOCUMENTED_NOT_CANCELED_REASONS.includes(pair.reason) ? pair.reason : "UNDOCUMENTED";
        }
      }
      if (inCanceled && notCanceledReason === undefined) return Object.freeze({ kind: "CANCELED" });
      if (!inCanceled && notCanceledReason !== undefined) return Object.freeze({ kind: "NOT_CANCELED", reason: notCanceledReason });
      return Object.freeze({ kind: "UNKNOWN", errorKind: null });
    }
    if (kind.value === "NOT_SENT" || kind.value === "REFUSED") {
      const errorRead = readField(raw, "error");
      const error = errorRead.kind === "DATA" ? readError(errorRead.value) : undefined;
      if (error === undefined || error === null) return Object.freeze({ kind: "UNKNOWN", errorKind: null });
      const expected = kind.value === "NOT_SENT" ? "NOT_SENT" : "NOT_APPLIED";
      return error.effect === expected
        ? Object.freeze({ kind: "NOT_APPLIED", errorKind: error.kind })
        : Object.freeze({ kind: "UNKNOWN", errorKind: error.kind });
    }
    if (kind.value === "UNKNOWN") {
      const errorRead = readField(raw, "error");
      const error = errorRead.kind === "DATA" ? readError(errorRead.value) : null;
      return Object.freeze({ kind: "UNKNOWN", errorKind: error?.kind ?? null });
    }
    return Object.freeze({ kind: "UNKNOWN", errorKind: null });
  } catch {
    return Object.freeze({ kind: "UNKNOWN", errorKind: null });
  }
}

/** A fill's dedupe key (§10.7: venue trade id, venue order id, allocation discriminator). */
export function fillKey(venueTradeId: string, venueOrderId: string, discriminator: string): string {
  return compositeKey(venueTradeId, venueOrderId, discriminator);
}
