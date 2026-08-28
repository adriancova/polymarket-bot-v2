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

/** Unix epoch milliseconds, written out in full. Nothing else is accepted. */
const EPOCH_MILLISECONDS_PATTERN = /^\d+$/u;

/**
 * The largest epoch millisecond value `Date` can represent.
 *
 * Boundary hygiene, not a venue fact: beyond it `new Date(...).toISOString()`
 * throws, and a throw in the message loop is a dropped event.
 */
const MAX_EPOCH_MS = 8.64e15;

/**
 * Normalizes the CHAINLINK OBSERVATION timestamp — `payload.timestamp`.
 *
 * ## Why this field gets its own parser (round-1 review finding M1)
 *
 * This value is load-bearing: it becomes `windowEndAt`, it anchors the derived
 * `windowStartAt`, and it is the identity a duplicate, a conflict and an
 * out-of-order arrival are all decided on. Getting its SCALE wrong does not
 * produce an error — it produces a confidently wrong window.
 *
 * The direct-RTDS representation is stated by both authorities and neither is
 * ambiguous:
 *
 *   * the current official page (accessed 2026-08-28) prints
 *     `"timestamp": 1785178800000` in the direct-RTDS update example and calls
 *     it "the Chainlink observation time";
 *   * the frozen report §10.3 writes the payload as
 *     `{symbol, value (number), full_accuracy_value (string integer),
 *     timestamp (unix ms), window_s}` — **unix ms**, in as many words.
 *
 * So this parser reads Unix epoch MILLISECONDS and nothing else. It deliberately
 * does NOT delegate to `../normalize/values.ts`'s `normalizeVenueInstant`, which
 * implements the official SDK's generic `EpochLikeToIsoDateTimeStringSchema`
 * flexibility — a numeric seconds-versus-milliseconds heuristic below
 * `1_000_000_000_000`, a `YYYY-MM-DD` calendar date, and any other date-like
 * string. That flexibility belongs to the SDK-normalized surface, which is a
 * DIFFERENT surface on the same page (`payload.windowSeconds`, `DecimalString`
 * values), and applying it here silently reinterpreted `1234` as seconds
 * (`1970-01-01T00:20:34.000Z`) and accepted `"2026-08-28T12:00:00Z"` as an
 * observation time RTDS is not documented to send.
 *
 * Two spellings of the same unambiguous fact are accepted:
 *
 * | Wire form | Read as |
 * | --- | --- |
 * | JSON number, a safe integer | epoch milliseconds |
 * | all-digit string, a safe integer | epoch milliseconds |
 *
 * The digit string is accepted because it cannot be mis-scaled — it is the
 * exact form the SDK's own `EpochMillisecondsStringSchema` uses for every
 * adjacent Polymarket timestamp, and it is read as milliseconds with no
 * heuristic applied — while the envelope schema already admits a string there.
 * Anything else (a fractional or unsafe number, a signed or spaced digit
 * string, a date-time string, a calendar date, a boolean, an object) is refused,
 * and the caller turns the refusal into `RTDS_INVALID_OBSERVATION_TIMESTAMP`
 * carrying the raw value. Absence stays ABSENT so the caller can say so.
 *
 * The value must also be non-negative: an observation time before 1970 cannot
 * be a Chainlink observation on a feed that publishes current prices, and
 * accepting one would let a negative number through as a plausible-looking
 * window. No upper freshness bound is applied here — how old is too old is
 * operator policy, and it lives in the staleness threshold (RTDS-U1).
 */
export function normalizeRtdsObservationInstant(value: unknown): ValueNormalization<VenueInstant> {
  if (value === undefined || value === null || value === "") {
    return { status: "absent" };
  }

  let epochMs: number;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      return invalid(
        `the Chainlink observation time must be a whole number of Unix epoch milliseconds, received ${String(value)}`,
      );
    }
    epochMs = value;
  } else if (typeof value === "string") {
    if (!EPOCH_MILLISECONDS_PATTERN.test(value)) {
      return invalid(
        `the Chainlink observation time must be Unix epoch milliseconds, received "${truncate(value)}": this field takes no date-like string and no seconds-versus-milliseconds heuristic`,
      );
    }
    epochMs = Number(value);
    if (!Number.isSafeInteger(epochMs)) {
      return invalid(`epoch milliseconds are not a safe integer: "${truncate(value)}"`);
    }
  } else {
    return invalid(`expected Unix epoch milliseconds, received ${typeof value}`);
  }

  if (epochMs < 0 || epochMs > MAX_EPOCH_MS) {
    return invalid(`epoch milliseconds out of range: ${String(epochMs)}`);
  }
  return { status: "ok", value: { iso: new Date(epochMs).toISOString(), epochMs } };
}

/**
 * Normalizes the PUBLISHER timestamp — the envelope's own `timestamp`.
 *
 * A different field with a different job: "the outer timestamp is when the
 * publisher submitted the update to RTDS". It is provenance, not economics —
 * nothing is computed from it, and its documented Python type is
 * `timestamp: datetime | None`, so it is allowed to be missing outright. An
 * unusable one therefore clears `venueTimestamp` and is COUNTED rather than
 * costing an otherwise complete observation.
 *
 * Because nothing load-bearing rides on it, this one keeps the package's single
 * generic epoch-like reading (`normalizeVenueInstant`), tolerating every form
 * the official SDK accepts. The tolerance is confined to this function on
 * purpose: {@link normalizeRtdsObservationInstant} is where the strictness has
 * to be, and the two must never be swapped.
 */
export function normalizeRtdsPublisherInstant(value: unknown): ValueNormalization<VenueInstant> {
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
  if (!Number.isFinite(shifted) || Math.abs(shifted) > MAX_EPOCH_MS) {
    return invalid(`shifted instant is out of range: ${String(shifted)}`);
  }
  return { status: "ok", value: { iso: new Date(shifted).toISOString(), epochMs: shifted } };
}

function truncate(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 61)}...`;
}
