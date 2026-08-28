/**
 * Value normalization at the RTDS edge — the E18 TWAP value and the instants.
 *
 * Two obligations meet here, and neither is negotiable:
 *
 * 1. **ADR-001 §8.3.** "RTDS TWAP updates carry both `value` (a JSON number) and
 *    `full_accuracy_value` (a string integer). The exact-decimal ingestion path
 *    must use `full_accuracy_value` and must never read `value`." Nothing in
 *    this module reads `value`, and nothing anywhere in the RTDS subtree does.
 * 2. **The scale is E18.** Verbatim from the current official page (accessed
 *    2026-08-28): "full_accuracy_value is the exact signed E18 fixed-point
 *    value. Divide it by 10^18 with integer or decimal arithmetic. The numeric
 *    value is provided only for display convenience." The frozen report §10.3
 *    records the field as a "string integer" and is silent about the scale, so
 *    this is documented drift (D-1 in `docs/handoffs/WP-100.md`), adopted
 *    because the current official documentation controls volatile venue facts
 *    (`AGENTS.md` authority order). Publishing the unscaled integer would put a
 *    TWAP 10^18 times too large into the domain.
 *
 * Nothing here throws for bad venue data: a failure is a value, because a throw
 * inside a message loop is how an event gets dropped (§8.3). The one throwing
 * dependency — `divDecimalExact`, which raises rather than rounding — is caught
 * and converted, which is defence in depth: dividing by a power of ten always
 * terminates, so the catch is reachable only for an input so long that the exact
 * quotient exceeds the probe precision.
 */

import { divDecimalExact, tryNormalizeDecimalString } from "@polymarket-bot/decimal";

import { normalizeVenueInstant, type ValueNormalization } from "../normalize/values.js";
import { RTDS_TWAP_VALUE_DIVISOR, RTDS_TWAP_VALUE_SCALE_DECIMALS } from "./config.js";

function invalid(reason: string): ValueNormalization<never> {
  return { status: "invalid", reason };
}

/**
 * Converts `full_accuracy_value` to a canonical decimal string.
 *
 * The input must be a STRING. A JSON number is refused rather than accepted and
 * stringified: the documented example is a 23-digit integer, which no IEEE-754
 * double can hold exactly, so accepting one would silently substitute a rounded
 * value for the "exact" one the field promises. That refusal is a deliberate
 * departure from the package's Gamma-facing decimal helper, which accepts both
 * forms because the SDK's `DecimalishSchema` documents both there; here the page
 * documents a string and only a string.
 *
 * The value is signed: "the exact signed E18 fixed-point value". A negative
 * result is normalized faithfully and refused one layer up, where the domain
 * bound that rejects it is stated (`ReferenceTwapObserved.value` is
 * `NonNegativeDecimalString`).
 */
export function normalizeFullAccuracyValue(value: unknown): ValueNormalization<string> {
  if (value === undefined || value === null || value === "") {
    return invalid(
      "full_accuracy_value is required: it is the only exact form of the TWAP, and the floating `value` must never be read (ADR-001 §8.3)",
    );
  }
  if (typeof value !== "string") {
    return invalid(
      `full_accuracy_value must be a string, received ${typeof value}: a JSON number cannot carry the exact E18 integer`,
    );
  }
  const normalized = tryNormalizeDecimalString(value);
  if (!normalized.ok) {
    return invalid(`${normalized.code}: ${normalized.message}`);
  }
  if (normalized.value.includes(".")) {
    return invalid(
      `full_accuracy_value must be an integer E18 value, received "${truncate(value)}"`,
    );
  }
  try {
    return { status: "ok", value: divDecimalExact(normalized.value, RTDS_TWAP_VALUE_DIVISOR) };
  } catch (error) {
    return invalid(
      `E${String(RTDS_TWAP_VALUE_SCALE_DECIMALS)} value could not be scaled exactly: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** An instant, in both the forms this adapter needs. */
export interface VenueInstant {
  /** ISO-8601 with a UTC designator, the form every domain timestamp takes. */
  readonly iso: string;
  /** The same instant in epoch milliseconds, for interval arithmetic. */
  readonly epochMs: number;
}

/**
 * Normalizes an RTDS instant.
 *
 * Delegates the epoch-form question to the package's existing venue-instant
 * helper — the one that implements every form the official SDK accepts — so
 * this package has exactly one answer to "what is an epoch-like timestamp",
 * and derives the millisecond value back from the ISO form it returns. The
 * round trip is exact: the ISO form carries milliseconds.
 */
export function normalizeRtdsInstant(value: unknown): ValueNormalization<VenueInstant> {
  const normalized = normalizeVenueInstant(value);
  if (normalized.status !== "ok") return normalized;
  const epochMs = Date.parse(normalized.value);
  if (!Number.isFinite(epochMs)) {
    return invalid(`instant "${truncate(normalized.value)}" is not a parseable ISO timestamp`);
  }
  return { status: "ok", value: { iso: normalized.value, epochMs } };
}

/**
 * Shifts an instant by a signed number of milliseconds.
 *
 * Used to derive a TWAP window's start from its end. Out-of-range results are
 * refused rather than allowed to throw inside `toISOString()`.
 */
export function shiftInstant(epochMs: number, deltaMs: number): ValueNormalization<VenueInstant> {
  const shifted = epochMs + deltaMs;
  if (!Number.isFinite(shifted) || Math.abs(shifted) > 8.64e15) {
    return invalid(`shifted instant is out of range: ${String(shifted)}`);
  }
  return { status: "ok", value: { iso: new Date(shifted).toISOString(), epochMs: shifted } };
}

function truncate(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 61)}...`;
}
