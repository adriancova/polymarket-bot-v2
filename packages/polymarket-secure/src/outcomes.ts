/**
 * The narrow interface's result types, and the mapping from the pinned SDK's
 * response objects to them (ADR-007 §5–§7; venue report §2.2, §2.5, C-6).
 *
 * Every economic amount is an exact decimal STRING as the venue sent it; this
 * module never converts one to a `number` (ADR-001).
 */

import type {
  CancelOrdersResponse as SdkCancelOrdersResponse,
  OpenOrder as SdkOpenOrder,
  OrderResponse as SdkOrderResponse,
} from "@polymarket/client";

import type { SecureVenueError } from "./errors.js";

// ---------------------------------------------------------------------------
// Placement.

/** Placement statuses of an accepted order (SDK `OrderPostStatus`, venue report §2.2). */
export type AcceptedPlacementStatus = "LIVE" | "MATCHED" | "DELAYED";

/**
 * Rejections the pinned SDK classifies from the venue's response
 * (`OrderResponseErrorCode`, `@polymarket/client@0.11.0`), minus the two it
 * cannot vouch for: `unknown` and `unmatched` (see {@link PlacementOutcome}).
 */
export type PlacementRejectionReason =
  | "MARKET_NOT_READY"
  | "INSUFFICIENT_BALANCE_OR_ALLOWANCE"
  | "INVALID_NONCE"
  | "INVALID_EXPIRATION"
  | "POST_ONLY_WOULD_CROSS"
  | "POST_ONLY_MODE"
  | "FOK_NOT_FILLED"
  | "FAK_NOT_FILLED";

/**
 * Why a placement outcome is UNKNOWN.
 *
 * - `SDK_UNMATCHED`: the venue documents `unmatched` as "marketable but failed
 *   to delay — placement still succeeded" (ADR-007 §5; conflict C-6), but
 *   the pinned SDK turns that response into `{ ok: false, code: "unmatched" }`
 *   and DROPS the order id. The order may exist; it must be reconciled by its
 *   signed identity, never treated as rejected.
 * - `SDK_UNKNOWN_CODE`: the SDK could not classify the venue's failure text
 *   (`unknown`), or returned a code this package does not know (U-4).
 * - `UNRECOGNISED_RESPONSE`: the SDK returned something outside its own
 *   declared response shape, or a batch answer of the wrong length.
 * - `ERROR`: the request failed and its effect is unknown; see `error`.
 */
export type PlacementUnknownReason = "SDK_UNMATCHED" | "SDK_UNKNOWN_CODE" | "UNRECOGNISED_RESPONSE" | "ERROR";

export type PlacementOutcome =
  | {
      readonly kind: "ACCEPTED";
      readonly orderId: string;
      /** `DELAYED` is never a fill: amounts are "0" and no trades exist yet (ADR-007 §5). */
      readonly status: AcceptedPlacementStatus;
      readonly makingAmount: string;
      readonly takingAmount: string;
      readonly tradeIds: readonly string[];
      readonly transactionHashes: readonly string[];
    }
  | { readonly kind: "REJECTED"; readonly reason: PlacementRejectionReason }
  /** Nothing left the process (validation or signing failed). */
  | { readonly kind: "NOT_SENT"; readonly error: SecureVenueError }
  /** The venue refused with a documented condition (429/425/401 with no code, 503 post-only). Not placed. */
  | { readonly kind: "REFUSED"; readonly error: SecureVenueError }
  /** The order may exist. ADR-007 §3: SUBMISSION_UNKNOWN; reconcile before any new salt. */
  | { readonly kind: "UNKNOWN"; readonly reason: PlacementUnknownReason; readonly error: SecureVenueError | null };

const REJECTION_BY_SDK_CODE: Readonly<Record<string, PlacementRejectionReason>> = Object.freeze({
  market_not_ready: "MARKET_NOT_READY",
  insufficient_balance_or_allowance: "INSUFFICIENT_BALANCE_OR_ALLOWANCE",
  invalid_nonce: "INVALID_NONCE",
  invalid_expiration: "INVALID_EXPIRATION",
  post_only_would_cross: "POST_ONLY_WOULD_CROSS",
  post_only_mode: "POST_ONLY_MODE",
  fok_not_filled: "FOK_NOT_FILLED",
  fak_not_filled: "FAK_NOT_FILLED",
});

const STATUS_BY_SDK_STATUS: Readonly<Record<string, AcceptedPlacementStatus>> = Object.freeze({
  live: "LIVE",
  matched: "MATCHED",
  delayed: "DELAYED",
});

/** The SDK error codes this module handles (every member of the pinned `OrderResponseErrorCode`). */
export const HANDLED_SDK_ORDER_ERROR_CODES: readonly string[] = Object.freeze([
  ...Object.keys(REJECTION_BY_SDK_CODE),
  "unmatched",
  "unknown",
]);

/** The SDK post statuses this module handles (every member of the pinned `OrderPostStatus`). */
export const HANDLED_SDK_POST_STATUSES: readonly string[] = Object.freeze(Object.keys(STATUS_BY_SDK_STATUS));

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const SAFE_ID = /^[A-Za-z0-9_\-:.]{1,200}$/u;

function ownData(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/** Upper bound on an id list carried from one response; a longer list is not recognised (UNKNOWN: reconcile). */
const MAX_ID_LIST = 100_000;

/** An array of safe ids, read index by index from own DATA properties (no iterator, no getter). */
function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = ownData(value, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_ID_LIST) return undefined;
  const out: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = ownData(value, String(index));
    if (typeof entry !== "string" || !SAFE_ID.test(entry)) return undefined;
    out.push(entry);
  }
  return Object.freeze(out);
}

const UNRECOGNISED: PlacementOutcome = Object.freeze({
  kind: "UNKNOWN",
  reason: "UNRECOGNISED_RESPONSE",
  error: null,
});

/**
 * One SDK `OrderResponse` → {@link PlacementOutcome}. Reads own data
 * properties only, validates every field it carries, and falls to UNKNOWN on
 * anything outside the pinned SDK's declared shape. The venue's rejection
 * message is never carried (free text; U-4).
 */
export function mapOrderResponse(response: SdkOrderResponse | unknown): PlacementOutcome {
  // Reflection over the response is contained: if it throws, the response is
  // unrecognised and the thrown value is dropped unread.
  try {
    return mapOrderResponseUncontained(response);
  } catch {
    return UNRECOGNISED;
  }
}

function mapOrderResponseUncontained(response: unknown): PlacementOutcome {
  if (typeof response !== "object" || response === null) return UNRECOGNISED;
  const ok = ownData(response, "ok");
  if (ok === true) {
    const orderId = ownData(response, "orderId");
    const status = ownData(response, "status");
    const makingAmount = ownData(response, "makingAmount");
    const takingAmount = ownData(response, "takingAmount");
    const tradeIds = stringArray(ownData(response, "tradeIds"));
    const transactionHashes = stringArray(ownData(response, "transactionsHashes"));
    // Own keys only: an inherited name ("constructor", "toString") is not a status.
    const mapped = typeof status === "string" && Object.hasOwn(STATUS_BY_SDK_STATUS, status) ? STATUS_BY_SDK_STATUS[status] : undefined;
    if (
      typeof orderId !== "string" ||
      !SAFE_ID.test(orderId) ||
      mapped === undefined ||
      typeof makingAmount !== "string" ||
      !DECIMAL.test(makingAmount) ||
      typeof takingAmount !== "string" ||
      !DECIMAL.test(takingAmount) ||
      tradeIds === undefined ||
      transactionHashes === undefined
    ) {
      return UNRECOGNISED;
    }
    return Object.freeze({
      kind: "ACCEPTED",
      orderId,
      status: mapped,
      makingAmount,
      takingAmount,
      tradeIds,
      transactionHashes,
    });
  }
  if (ok === false) {
    const code = ownData(response, "code");
    if (code === "unmatched") {
      return Object.freeze({ kind: "UNKNOWN", reason: "SDK_UNMATCHED", error: null });
    }
    const reason = typeof code === "string" && Object.hasOwn(REJECTION_BY_SDK_CODE, code) ? REJECTION_BY_SDK_CODE[code] : undefined;
    return reason === undefined
      ? Object.freeze({ kind: "UNKNOWN", reason: "SDK_UNKNOWN_CODE", error: null })
      : Object.freeze({ kind: "REJECTED", reason });
  }
  return UNRECOGNISED;
}

/** A thrown, mapped error → the placement outcome its effect implies. */
export function placementOutcomeFromError(error: SecureVenueError): PlacementOutcome {
  switch (error.effect) {
    case "NOT_SENT":
      return Object.freeze({ kind: "NOT_SENT", error });
    case "NOT_APPLIED":
      return Object.freeze({ kind: "REFUSED", error });
    default:
      return Object.freeze({ kind: "UNKNOWN", reason: "ERROR", error });
  }
}

// ---------------------------------------------------------------------------
// Cancellation.

/**
 * The documented per-order "not canceled" reasons (venue report §2.5), carried
 * verbatim only when the venue sends exactly one of them. Anything else is
 * `UNDOCUMENTED`: the text is free and is not carried.
 */
export const DOCUMENTED_NOT_CANCELED_REASONS: readonly string[] = Object.freeze([
  "Order not found or already canceled",
  "Order already matched",
  "Order not found",
  "Order already canceled",
]);

export interface NotCanceledEntry {
  readonly orderId: string;
  readonly reason: string;
}

export type CancelOutcome =
  | {
      readonly kind: "COMPLETED";
      readonly canceled: readonly string[];
      readonly notCanceled: readonly NotCanceledEntry[];
    }
  | { readonly kind: "NOT_SENT"; readonly error: SecureVenueError }
  | { readonly kind: "REFUSED"; readonly error: SecureVenueError }
  /** Some or all of the cancels may have been applied. Reconcile. */
  | { readonly kind: "UNKNOWN"; readonly error: SecureVenueError | null };

const UNKNOWN_CANCEL: CancelOutcome = Object.freeze({ kind: "UNKNOWN", error: null });

export function mapCancelResponse(response: SdkCancelOrdersResponse | unknown): CancelOutcome {
  // Contained, as for placements: a reflection failure is UNKNOWN.
  try {
    return mapCancelResponseUncontained(response);
  } catch {
    return UNKNOWN_CANCEL;
  }
}

function mapCancelResponseUncontained(response: unknown): CancelOutcome {
  const unknownOutcome = UNKNOWN_CANCEL;
  if (typeof response !== "object" || response === null) return unknownOutcome;
  const canceled = stringArray(ownData(response, "canceled"));
  const notCanceledRaw = ownData(response, "notCanceled");
  if (canceled === undefined || typeof notCanceledRaw !== "object" || notCanceledRaw === null) return unknownOutcome;
  const notCanceled: NotCanceledEntry[] = [];
  for (const orderId of Object.keys(notCanceledRaw)) {
    const reason = ownData(notCanceledRaw, orderId);
    if (!SAFE_ID.test(orderId) || typeof reason !== "string") return unknownOutcome;
    notCanceled.push(
      Object.freeze({ orderId, reason: DOCUMENTED_NOT_CANCELED_REASONS.includes(reason) ? reason : "UNDOCUMENTED" }),
    );
  }
  return Object.freeze({ kind: "COMPLETED", canceled, notCanceled: Object.freeze(notCanceled) });
}

export function cancelOutcomeFromError(error: SecureVenueError): CancelOutcome {
  switch (error.effect) {
    case "NOT_SENT":
      return Object.freeze({ kind: "NOT_SENT", error });
    case "NOT_APPLIED":
      return Object.freeze({ kind: "REFUSED", error });
    default:
      return Object.freeze({ kind: "UNKNOWN", error });
  }
}

// ---------------------------------------------------------------------------
// Query.

/**
 * An authoritative order read (ADR-007 §3). The order's `owner` (the API key
 * that owns it) is deliberately NOT carried.
 */
export interface VenueOrderSnapshot {
  readonly orderId: string;
  readonly assetId: string;
  readonly conditionId: string;
  readonly makerAddress: string;
  readonly side: string;
  readonly price: string;
  readonly originalSize: string;
  readonly sizeMatched: string;
  /** Upper-case venue status, or `UNRECOGNISED` when the venue sent anything else. */
  readonly status: string;
  readonly orderType: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly associateTrades: readonly string[];
}

export type QueryOutcome<T> =
  | { readonly kind: "FOUND"; readonly value: T }
  | { readonly kind: "FAILED"; readonly error: SecureVenueError | null };

const UPPER_TOKEN = /^[A-Z][A-Z_]{0,63}$/u;
const ISO_LIKE = /^[0-9TZ:.+-]{1,40}$/u;

const FAILED_QUERY: QueryOutcome<VenueOrderSnapshot> = Object.freeze({ kind: "FAILED", error: null });

export function mapOpenOrder(order: SdkOpenOrder | unknown): QueryOutcome<VenueOrderSnapshot> {
  // Contained, as for placements: a reflection failure is FAILED.
  try {
    return mapOpenOrderUncontained(order);
  } catch {
    return FAILED_QUERY;
  }
}

function mapOpenOrderUncontained(order: unknown): QueryOutcome<VenueOrderSnapshot> {
  const failed = FAILED_QUERY;
  if (typeof order !== "object" || order === null) return failed;
  const text = (key: string, pattern: RegExp): string | undefined => {
    const value = ownData(order, key);
    return typeof value === "string" && pattern.test(value) ? value : undefined;
  };
  const statusRaw = ownData(order, "status");
  const expiresRaw = ownData(order, "expiresAt");
  const snapshot = {
    orderId: text("id", SAFE_ID),
    assetId: text("assetId", SAFE_ID),
    conditionId: text("conditionId", SAFE_ID),
    makerAddress: text("makerAddress", SAFE_ID),
    side: text("side", UPPER_TOKEN),
    price: text("price", DECIMAL),
    originalSize: text("originalSize", DECIMAL),
    sizeMatched: text("sizeMatched", DECIMAL),
    status: typeof statusRaw === "string" && UPPER_TOKEN.test(statusRaw) ? statusRaw : "UNRECOGNISED",
    orderType: text("orderType", UPPER_TOKEN),
    createdAt: text("createdAt", ISO_LIKE),
    expiresAt: expiresRaw === undefined ? null : typeof expiresRaw === "string" && ISO_LIKE.test(expiresRaw) ? expiresRaw : undefined,
    associateTrades: stringArray(ownData(order, "associateTrades")),
  };
  for (const value of Object.values(snapshot)) {
    if (value === undefined) return failed;
  }
  return Object.freeze({ kind: "FOUND", value: Object.freeze(snapshot as VenueOrderSnapshot) });
}
