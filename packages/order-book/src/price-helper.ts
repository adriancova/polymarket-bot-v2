/**
 * Tick-pinned price helpers (§9.4: "Invalidate or reprice affected orders
 * when tick size changes"; workplan acceptance 3: "Tick changes invalidate
 * nonconforming price helpers").
 *
 * A `PriceGrid` is issued pinned to the book's tick size AND its tick epoch.
 * When the book later applies a tick-size change with a different value, the
 * book's tick epoch advances and every previously issued grid becomes
 * INVALIDATED: each of its operations returns a typed
 * `ORDER_BOOK_PRICE_HELPER_INVALIDATED` refusal carrying both tick sizes —
 * visible, never silently wrong. A restatement of the identical tick size
 * does not invalidate (the grid still conforms).
 *
 * Grid arithmetic is exact: both operands are scaled to integers by their
 * decimal places and snapped with integer division (the same
 * no-floating-point discipline as `@polymarket-bot/decimal`'s tick module).
 */

import { decimalPlaces, isTickConformant } from "@polymarket-bot/decimal";
import { NonNegativeDecimalStringSchema } from "@polymarket-bot/domain";
import type { DecimalString } from "@polymarket-bot/domain";

import type { OutcomeTokenBook } from "./book.js";
import type { OrderBookRefusal } from "./refusals.js";
import { refuse } from "./refusals.js";

export type GridValueResult =
  | { readonly ok: true; readonly value: DecimalString }
  | { readonly ok: false; readonly refusal: OrderBookRefusal };

export type GridBooleanResult =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly refusal: OrderBookRefusal };

export interface PriceGrid {
  /** The tick size this grid was pinned to at issue time. */
  readonly tickSize: DecimalString;
  /** Whether the grid is still the book's current grid. */
  status(): { readonly valid: true } | { readonly valid: false; readonly refusal: OrderBookRefusal };
  /** Exact tick conformance of a non-negative canonical price. */
  isConformant(price: string): GridBooleanResult;
  /** Largest grid price `<= price`. */
  snapDown(price: string): GridValueResult;
  /** Smallest grid price `>= price`. */
  snapUp(price: string): GridValueResult;
}

export type PriceGridResult =
  | { readonly ok: true; readonly grid: PriceGrid }
  | { readonly ok: false; readonly refusal: OrderBookRefusal };

/** Scales a non-negative canonical decimal to an integer at `places` places. */
function scaleToInteger(value: DecimalString, places: number): bigint {
  const dot = value.indexOf(".");
  const integer = dot === -1 ? value : value.slice(0, dot);
  const fraction = dot === -1 ? "" : value.slice(dot + 1);
  const padded = fraction.padEnd(places, "0");
  return BigInt(integer + padded);
}

/** Formats a non-negative scaled integer back to a canonical decimal. */
function formatScaled(value: bigint, places: number): DecimalString {
  const digits = value.toString().padStart(places + 1, "0");
  const integer = places === 0 ? digits : digits.slice(0, digits.length - places);
  let fraction = places === 0 ? "" : digits.slice(digits.length - places);
  fraction = fraction.replace(/0+$/u, "");
  const integerCanonical = integer.replace(/^0+(?=\d)/u, "");
  return fraction === "" ? integerCanonical : `${integerCanonical}.${fraction}`;
}

/**
 * Issues a price grid pinned to the book's CURRENT tick size and tick epoch.
 * Refuses when the book has no tick size yet (`ORDER_BOOK_NO_TICK_SIZE`).
 */
export function priceGrid(book: OutcomeTokenBook): PriceGridResult {
  const tickSize = book.tickSize();
  if (tickSize === undefined) {
    return {
      ok: false,
      refusal: refuse(
        "ORDER_BOOK_NO_TICK_SIZE",
        "no tick size has been applied to this book, so no price grid exists",
      ).refusal,
    };
  }
  const pinnedEpoch = book.tickEpoch();
  const pinnedTickSize = tickSize;

  const invalidated = (): OrderBookRefusal | undefined => {
    if (book.tickEpoch() !== pinnedEpoch) {
      return refuse(
        "ORDER_BOOK_PRICE_HELPER_INVALIDATED",
        "the book's tick size changed after this helper was issued; a price computed on the old grid would be silently nonconforming, so the helper is invalidated (workplan acceptance 3)",
        {
          pinnedTickSize,
          currentTickSize: book.tickSize(),
        },
      ).refusal;
    }
    return undefined;
  };

  const parsePrice = (price: string): { ok: true; value: DecimalString } | { ok: false; refusal: OrderBookRefusal } => {
    const parsed = NonNegativeDecimalStringSchema.safeParse(price);
    if (!parsed.success) {
      return {
        ok: false,
        refusal: refuse(
          "ORDER_BOOK_NONCANONICAL_DECIMAL",
          "price is not a non-negative canonical decimal string",
          { price },
        ).refusal,
      };
    }
    return { ok: true, value: parsed.data };
  };

  const grid: PriceGrid = {
    tickSize: pinnedTickSize,
    status() {
      const refusal = invalidated();
      return refusal === undefined ? { valid: true } : { valid: false, refusal };
    },
    isConformant(price: string): GridBooleanResult {
      const refusal = invalidated();
      if (refusal !== undefined) {
        return { ok: false, refusal };
      }
      const parsed = parsePrice(price);
      if (!parsed.ok) {
        return parsed;
      }
      return { ok: true, value: isTickConformant(parsed.value, pinnedTickSize) };
    },
    snapDown(price: string): GridValueResult {
      const refusal = invalidated();
      if (refusal !== undefined) {
        return { ok: false, refusal };
      }
      const parsed = parsePrice(price);
      if (!parsed.ok) {
        return parsed;
      }
      const places = Math.max(decimalPlaces(parsed.value), decimalPlaces(pinnedTickSize));
      const scaledPrice = scaleToInteger(parsed.value, places);
      const scaledTick = scaleToInteger(pinnedTickSize, places);
      const snapped = (scaledPrice / scaledTick) * scaledTick;
      return { ok: true, value: formatScaled(snapped, places) };
    },
    snapUp(price: string): GridValueResult {
      const refusal = invalidated();
      if (refusal !== undefined) {
        return { ok: false, refusal };
      }
      const parsed = parsePrice(price);
      if (!parsed.ok) {
        return parsed;
      }
      const places = Math.max(decimalPlaces(parsed.value), decimalPlaces(pinnedTickSize));
      const scaledPrice = scaleToInteger(parsed.value, places);
      const scaledTick = scaleToInteger(pinnedTickSize, places);
      const snapped = ((scaledPrice + scaledTick - 1n) / scaledTick) * scaledTick;
      return { ok: true, value: formatScaled(snapped, places) };
    },
  };

  return { ok: true, grid };
}
