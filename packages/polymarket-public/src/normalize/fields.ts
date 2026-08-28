/**
 * Field-level normalization shared by the WebSocket and REST book paths.
 *
 * Both paths carry the same `{price, size}` level shape and must treat it
 * identically: a snapshot fetched over REST after a gap has to be comparable,
 * value for value, with the snapshot the WebSocket pushed before it. One
 * implementation, used twice, is what makes that true.
 */

import { compareDecimal } from "@polymarket-bot/decimal";
import {
  type BookLevel,
  NonNegativeSharesStringSchema,
  PriceStringSchema,
} from "@polymarket-bot/domain";

import type { PublicMarketProblemCode } from "./result.js";
import { normalizeVenueDecimal, requireVenueDecimal } from "./values.js";

/** Why one field could not be normalized. */
export interface FieldFailure {
  readonly code: PublicMarketProblemCode;
  readonly reason: string;
}

/** A field normalization: a value, or the reason there is none. */
export type FieldResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: FieldFailure };

export function fieldOk<T>(value: T): FieldResult<T> {
  return { ok: true, value };
}

export function fieldFailed(code: PublicMarketProblemCode, reason: string): FieldResult<never> {
  return { ok: false, failure: { code, reason } };
}

/**
 * A required price, canonicalized and range-checked.
 *
 * The `[0, 1]` bound is a DOMAIN constraint, not a venue-asserted one, and it
 * stays (ADR-002 §7). ADR-001's Consequences are explicit about what happens
 * when the venue breaches it: "the adapter fails loudly rather than clamping".
 */
export function readPrice(value: unknown, field: string): FieldResult<string> {
  const decimal = requireVenueDecimal(value, field);
  if (decimal.status === "absent") return fieldFailed("INVALID_DECIMAL", `${field} is absent`);
  if (decimal.status === "invalid") {
    return fieldFailed("INVALID_DECIMAL", `${field}: ${decimal.reason}`);
  }
  if (!PriceStringSchema.safeParse(decimal.value).success) {
    return fieldFailed(
      "PRICE_OUT_OF_RANGE",
      `${field} ${decimal.value} is outside the [0, 1] outcome-token price range`,
    );
  }
  return fieldOk(decimal.value);
}

/** An optional price: absent stays absent, and is never filled with `"0"`. */
export function readOptionalPrice(
  value: unknown,
  field: string,
): FieldResult<string | undefined> {
  const decimal = normalizeVenueDecimal(value);
  if (decimal.status === "absent") return fieldOk(undefined);
  if (decimal.status === "invalid") {
    return fieldFailed("INVALID_DECIMAL", `${field}: ${decimal.reason}`);
  }
  if (!PriceStringSchema.safeParse(decimal.value).success) {
    return fieldFailed(
      "PRICE_OUT_OF_RANGE",
      `${field} ${decimal.value} is outside the [0, 1] outcome-token price range`,
    );
  }
  return fieldOk(decimal.value);
}

/** A required size that may be zero — `"0"` at a level means the level is gone. */
export function readNonNegativeSize(value: unknown, field: string): FieldResult<string> {
  const decimal = requireVenueDecimal(value, field);
  if (decimal.status === "absent") return fieldFailed("INVALID_DECIMAL", `${field} is absent`);
  if (decimal.status === "invalid") {
    return fieldFailed("INVALID_DECIMAL", `${field}: ${decimal.reason}`);
  }
  if (!NonNegativeSharesStringSchema.safeParse(decimal.value).success) {
    return fieldFailed("INVALID_DECIMAL", `${field} ${decimal.value} is negative`);
  }
  return fieldOk(decimal.value);
}

/**
 * Normalizes one side of a book.
 *
 * A repeated price fails the whole side. Two entries at one price make the
 * aggregate depth there ambiguous, and a snapshot is the authoritative state a
 * gap recovery rebuilds from (§7.1, §9.1) — picking one entry over the other
 * would corrupt every price change applied on top of it.
 */
export function normalizeLevels(
  levels: readonly { readonly price: string; readonly size: string }[],
  side: string,
): FieldResult<readonly BookLevel[]> {
  const normalized: BookLevel[] = [];
  const seen = new Set<string>();
  for (const [index, level] of levels.entries()) {
    const price = readPrice(level.price, `${side}[${String(index)}].price`);
    if (!price.ok) return price;
    const size = readNonNegativeSize(level.size, `${side}[${String(index)}].size`);
    if (!size.ok) return size;
    if (seen.has(price.value)) {
      return fieldFailed(
        "DUPLICATE_BOOK_LEVEL",
        `${side} carries price ${price.value} twice, so the book's depth at that price is ambiguous`,
      );
    }
    seen.add(price.value);
    normalized.push({ price: price.value, size: size.value });
  }
  return fieldOk(normalized);
}

/**
 * Orders levels for the domain contract: bids descending, asks ascending.
 *
 * The order is imposed rather than inherited. The venue documents the opposite
 * convention for its REST reads — "Bids are ordered by ascending price and asks
 * by descending price, so the best bid and ask are the last entries in their
 * respective arrays" — and its WebSocket examples have shown both conventions
 * over time, so trusting the wire order would make the domain contract depend
 * on an undocumented detail. Comparison is exact decimal comparison, never
 * float.
 */
export function sortLevels(
  levels: readonly BookLevel[],
  direction: "asc" | "desc",
): readonly BookLevel[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...levels].sort((left, right) => sign * compareDecimal(left.price, right.price));
}

/** A venue hash is carried only when it is a non-empty string. */
export function readOptionalHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
