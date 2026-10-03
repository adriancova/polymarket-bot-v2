/**
 * Venue answers → restricted-mode conditions (WP-310 deliverable 3).
 *
 * Classification uses the error KIND that WP-260 derives from the HTTP status
 * and the documented `code` only (`ENGINE_RESTARTING` = 425,
 * `POST_ONLY_MODE` = 503 + `post_only_mode`, `TRADING_UNAVAILABLE` = 503
 * without a documented code) and the reason the pinned SDK names for a batch
 * entry (`POST_ONLY_MODE`). The venue's `error` text is never seen here
 * (WP-260 never carries it), so no mode can be keyed on it (E-05, C-9).
 *
 * Placement answers are read through the OMS's own classifier
 * (`readPlacementOutcome` / `classifyBatch`), so the detector and the OMS
 * agree on what an answer was.
 */

import { readField, readFields } from "../guards.js";
import { classifyBatch, readPlacementOutcome, type PlacementClass } from "../outcomes.js";

export type VenueOperation = "PLACEMENT" | "CANCEL";

export type VenueCondition =
  /** HTTP 425 on an order-related request: the matching engine is restarting. */
  | { readonly kind: "RESTARTING"; readonly retryAfterSeconds: number | null }
  /** HTTP 503 `post_only_mode` (or a batch entry rejected with it): only post-only orders are accepted. */
  | { readonly kind: "POST_ONLY"; readonly retryAfterSeconds: number | null }
  /** HTTP 503 without a documented code: cancel-only or fully disabled, indistinguishable (C-9). */
  | { readonly kind: "TRADING_UNAVAILABLE"; readonly retryAfterSeconds: number | null }
  /** The venue answered the request without any restricted-mode signal. */
  | { readonly kind: "ANSWERED" }
  /** Nothing the mode can learn from (nothing sent, a 429, a timeout, a transport failure, an unreadable answer). */
  | { readonly kind: "NONE" };

export interface VenueSignal {
  readonly operation: VenueOperation;
  readonly condition: VenueCondition;
}

const NONE: VenueCondition = Object.freeze({ kind: "NONE" as const });
const ANSWERED: VenueCondition = Object.freeze({ kind: "ANSWERED" as const });

function retryOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function byErrorKind(kind: unknown, retryAfterSeconds: unknown): VenueCondition | undefined {
  const retry = retryOf(retryAfterSeconds);
  switch (kind) {
    case "ENGINE_RESTARTING":
      return Object.freeze({ kind: "RESTARTING" as const, retryAfterSeconds: retry });
    case "POST_ONLY_MODE":
      return Object.freeze({ kind: "POST_ONLY" as const, retryAfterSeconds: retry });
    case "TRADING_UNAVAILABLE":
      return Object.freeze({ kind: "TRADING_UNAVAILABLE" as const, retryAfterSeconds: retry });
    default:
      return undefined;
  }
}

/** One placement class (the OMS's reading of a placement answer) → its condition. */
export function conditionOfPlacement(placement: PlacementClass): VenueCondition {
  switch (placement.kind) {
    case "ACCEPTED":
      return ANSWERED;
    case "REJECTED":
      // A batch entry "rejected" in post-only mode: `"success": true` with the post-only `errorMsg`, which the
      // pinned SDK names `post_only_mode` (venue report §9). Any other named rejection is an engine answer.
      return placement.reason === "POST_ONLY_MODE" ? Object.freeze({ kind: "POST_ONLY" as const, retryAfterSeconds: null }) : ANSWERED;
    case "REFUSED":
      return Object.freeze({ kind: "POST_ONLY" as const, retryAfterSeconds: placement.retryAfterSeconds });
    case "NOT_SENT":
      return NONE;
    case "UNKNOWN":
      return byErrorKind(placement.errorKind, placement.retryAfterSeconds) ?? NONE;
  }
}

/** A raw venue-port placement answer → its condition, read as the OMS reads it. */
export function conditionOfPlacementOutcome(raw: unknown): VenueCondition {
  return conditionOfPlacement(readPlacementOutcome(raw));
}

/** A raw venue-port batch answer for `inputs` orders → one condition per order, read as the OMS reads it. */
export function conditionsOfBatchOutcome(raw: unknown, inputs: number): readonly VenueCondition[] {
  return Object.freeze(classifyBatch(raw, inputs).map(conditionOfPlacement));
}

/** A raw venue-port cancel answer → its condition. Never throws. */
export function conditionOfCancelOutcome(raw: unknown): VenueCondition {
  try {
    const kind = readField(raw, "kind");
    if (kind.kind !== "DATA") return NONE;
    if (kind.value === "COMPLETED") return ANSWERED;
    if (kind.value === "NOT_SENT") return NONE;
    if (kind.value !== "REFUSED" && kind.value !== "UNKNOWN") return NONE;
    const error = readField(raw, "error");
    if (error.kind !== "DATA") return NONE;
    const fields = readFields(error.value, ["kind", "retryAfterSeconds"]);
    if (fields === undefined) return NONE;
    return byErrorKind(fields.kind, fields.retryAfterSeconds) ?? NONE;
  } catch {
    return NONE;
  }
}

/** Read a `{ operation, condition }` signal from own data fields, or `undefined`. */
export function readCondition(signal: unknown): VenueSignal | undefined {
  try {
    const fields = readFields(signal, ["operation", "condition"]);
    if (fields === undefined) return undefined;
    const operation = fields.operation;
    if (operation !== "PLACEMENT" && operation !== "CANCEL") return undefined;
    const conditionFields = readFields(fields.condition, ["kind", "retryAfterSeconds"]);
    if (conditionFields === undefined) return undefined;
    const kind = conditionFields.kind;
    let condition: VenueCondition;
    if (kind === "ANSWERED") condition = ANSWERED;
    else if (kind === "NONE") condition = NONE;
    else if (kind === "RESTARTING" || kind === "POST_ONLY" || kind === "TRADING_UNAVAILABLE") {
      const retry = conditionFields.retryAfterSeconds;
      if (!(retry === null || retryOf(retry) !== null)) return undefined;
      condition = Object.freeze({ kind, retryAfterSeconds: retry === null ? null : retryOf(retry) });
    } else return undefined;
    return Object.freeze({ operation, condition });
  } catch {
    return undefined;
  }
}
