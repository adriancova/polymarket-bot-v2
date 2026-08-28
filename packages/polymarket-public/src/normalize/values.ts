/**
 * Value normalization at the venue edge — decimals, instants, identifiers, side.
 *
 * This is where the wire stops and the domain begins. ADR-001 §8 and ADR-002 §7
 * put four obligations here, and every one of them is discharged in this module
 * rather than in a schema:
 *
 * 1. **`""`, `null` and absence collapse to ABSENT.** Absence and `null` are
 *    different facts on the wire; past this boundary they are one fact. The
 *    adapter must never invent `"0"` for an absent best bid.
 * 2. **Venue spellings are normalized to the canonical decimal form** with
 *    `@polymarket-bot/decimal`, the same implementation the domain schemas
 *    validate against, so the two can never drift. The official order-book
 *    example prints `"last_trade_price": "0.090"` — the wire is demonstrably
 *    not canonical.
 * 3. **Every epoch-like form the SDK accepts is accepted**, including the
 *    date-like string, and converted to the repository's ISO-8601 form.
 * 4. **An unrecognized free-string value is first-class UNKNOWN**, returned as
 *    a typed outcome the caller reports — never coerced to a default and never
 *    silently dropped.
 *
 * Nothing here throws for bad venue data: a failure is a value, because a throw
 * inside a message loop is how an event gets dropped (§8.3).
 */

import { tryNormalizeDecimalString } from "@polymarket-bot/decimal";
import type { BookSide, TokenId } from "@polymarket-bot/domain";

/** A normalization that either produced a value, found none, or failed. */
export type ValueNormalization<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly reason: string };

const OK_ABSENT = { status: "absent" } as const;

function invalid(reason: string): ValueNormalization<never> {
  return { status: "invalid", reason };
}

/** Absent on the wire: the key is missing, the value is `null`, or it is `""`. */
function isWireAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Normalizes a venue decimal to the canonical form.
 *
 * Accepts the string spellings `normalizeDecimalString` sanctions (a leading
 * `+`, redundant leading zeros, trailing fractional zeros, `".5"`, `"1."`) and
 * rejects scientific notation, whitespace, `"NaN"` and `"Infinity"` exactly as
 * that function does.
 *
 * A finite JSON `number` is accepted too, and ONLY because ADR-001 §8.2 and
 * ADR-002 §7 require it: the SDK's `DecimalishSchema` is
 * `z.union([DecimalStringSchema, z.number().transform(...)])`, so a raw Gamma
 * body may legitimately carry a JSON number where the SDK-parsed layer carries
 * a string. The market-channel schemas in this package type every decimal as a
 * string, matching the SDK, so this branch is unreachable from the WebSocket —
 * it exists so a caller normalizing a Gamma-shaped field gets the documented
 * behaviour from the one implementation rather than writing a second one.
 *
 * The number is stringified with `String(value)`, which is what
 * `DecimalishSchema` does. That means a magnitude JavaScript prints in
 * exponential form (`1e21`, `5e-7`) is REJECTED rather than silently converted:
 * scientific notation is not a legal decimal string anywhere in this repository
 * (ADR-001 §2), and quietly expanding it here would let a float's rounding
 * error into an economic value.
 */
export function normalizeVenueDecimal(value: unknown): ValueNormalization<string> {
  if (isWireAbsent(value)) {
    return OK_ABSENT;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalid(`not a finite number: ${String(value)}`);
    }
    return normalizeDecimalText(String(value));
  }
  if (typeof value !== "string") {
    return invalid(`expected a decimal string, received ${typeof value}`);
  }
  return normalizeDecimalText(value);
}

function normalizeDecimalText(text: string): ValueNormalization<string> {
  const outcome = tryNormalizeDecimalString(text);
  return outcome.ok
    ? { status: "ok", value: outcome.value }
    : invalid(`${outcome.code}: ${outcome.message}`);
}

/**
 * Required-decimal variant: an absent value is an error, not a hole.
 *
 * Used where the domain payload cannot be built without the number (a book
 * level's price, a trade's size).
 */
export function requireVenueDecimal(
  value: unknown,
  field: string,
): ValueNormalization<string> {
  const normalized = normalizeVenueDecimal(value);
  if (normalized.status === "absent") {
    return invalid(`${field} is required but absent on the wire`);
  }
  return normalized;
}

/**
 * The largest and smallest epoch millisecond value `Date` can represent.
 *
 * Bounds are boundary hygiene for a process parsing untrusted frames, not a
 * venue fact: outside them `new Date(...).toISOString()` throws, and a throw in
 * the message loop is a dropped event.
 */
const MAX_EPOCH_MS = 8.64e15;

const DIGITS_PATTERN = /^\d+$/u;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * The SDK's own seconds-versus-milliseconds discriminator, verbatim from
 * `EpochLikeToIsoDateTimeStringSchema`:
 * `value < 1_000_000_000_000 ? value * 1000 : value`.
 */
const EPOCH_SECONDS_UPPER_BOUND = 1_000_000_000_000;

/**
 * Normalizes any epoch-like venue timestamp to an ISO-8601 instant.
 *
 * | Wire form | Reading | SDK source |
 * | --- | --- | --- |
 * | digit string | epoch **milliseconds** | `EpochMillisecondsStringSchema`, used by every market-channel `timestamp` |
 * | integer number | milliseconds, or seconds below `1_000_000_000_000` | `EpochMillisecondsLikeSchema` in `EpochLikeToIsoDateTimeStringSchema` |
 * | `YYYY-MM-DD` | that calendar date at `00:00:00.000Z` | `DateLikeStringToIsoDateTimeStringSchema` |
 * | any other string | parsed as a date-time | `DateLikeStringToIsoDateTimeStringSchema` |
 *
 * The digit-string branch reads milliseconds rather than applying the numeric
 * seconds heuristic because that is what the schema the market channel actually
 * uses says; applying the heuristic to a string would silently reinterpret a
 * pre-2001 millisecond timestamp as seconds.
 */
export function normalizeVenueInstant(value: unknown): ValueNormalization<string> {
  if (isWireAbsent(value)) {
    return OK_ABSENT;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      return invalid(`epoch value is not an integer: ${String(value)}`);
    }
    const epochMs = value < EPOCH_SECONDS_UPPER_BOUND ? value * 1000 : value;
    return isoFromEpochMs(epochMs);
  }
  if (typeof value !== "string") {
    return invalid(`expected an epoch-like value, received ${typeof value}`);
  }
  if (DIGITS_PATTERN.test(value)) {
    const epochMs = Number(value);
    if (!Number.isSafeInteger(epochMs)) {
      return invalid(`epoch milliseconds are not a safe integer: "${value}"`);
    }
    return isoFromEpochMs(epochMs);
  }
  const text = CALENDAR_DATE_PATTERN.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(text);
  const time = parsed.getTime();
  if (Number.isNaN(time)) {
    return invalid(`not a date-like string: "${value}"`);
  }
  return isoFromEpochMs(time);
}

function isoFromEpochMs(epochMs: number): ValueNormalization<string> {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_EPOCH_MS) {
    return invalid(`epoch milliseconds out of range: ${String(epochMs)}`);
  }
  return { status: "ok", value: new Date(epochMs).toISOString() };
}

const CANONICAL_UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const LEADING_ZEROES_PATTERN = /^0+(?=\d)/u;

/** Domain bound on identifier-like strings (`MAX_IDENTIFIER_LENGTH`). */
const MAX_IDENTIFIER_LENGTH = 200;

/**
 * Normalizes a venue token id to the domain's canonical unsigned integer form.
 *
 * The SDK types a token id as a bare `z.string()`, so the wire promises
 * nothing. `docs/contracts/domain.md` §8 fixes the domain form ("venue integer
 * encoded as string … adapters normalize first, as they do for decimals"), so
 * redundant leading zeros are stripped here and anything that is not a
 * non-negative integer is reported rather than passed on.
 */
export function normalizeVenueTokenId(value: unknown): ValueNormalization<TokenId> {
  if (isWireAbsent(value)) {
    return OK_ABSENT;
  }
  if (typeof value !== "string") {
    return invalid(`expected a token id string, received ${typeof value}`);
  }
  const stripped = value.replace(LEADING_ZEROES_PATTERN, "");
  if (!CANONICAL_UNSIGNED_INTEGER_PATTERN.test(stripped)) {
    return invalid(`token id is not an unsigned integer string: "${truncate(value)}"`);
  }
  if (stripped.length > MAX_IDENTIFIER_LENGTH) {
    return invalid(`token id exceeds ${String(MAX_IDENTIFIER_LENGTH)} characters`);
  }
  return { status: "ok", value: stripped };
}

/**
 * Normalizes a venue condition id.
 *
 * NO byte-length bound is applied. The `WP-000` fixture catalogue narrows a
 * condition id to 31/32 bytes; ADR-002 §7 makes it binding that a runtime
 * parser accepts "any hex condition id the SDK accepts", and the SDK's
 * `ConditionIdResponseSchema` "validates hex syntax without constraining the
 * condition ID byte length". The market channel types the field looser still —
 * a bare `z.string()` — so a non-hex value is accepted here too and left for
 * the catalogue to judge. Only emptiness and the domain's identifier length
 * bound are enforced, because `ConditionIdSchema` in `packages/domain` is a
 * bounded non-empty string and an over-long value would fail there anyway.
 */
export function normalizeVenueConditionId(value: unknown): ValueNormalization<string> {
  if (isWireAbsent(value)) {
    return OK_ABSENT;
  }
  if (typeof value !== "string") {
    return invalid(`expected a condition id string, received ${typeof value}`);
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    return invalid(`condition id exceeds ${String(MAX_IDENTIFIER_LENGTH)} characters`);
  }
  return { status: "ok", value };
}

/**
 * Maps the venue's `BUY`/`SELL` vocabulary onto the domain's `BID`/`ASK`.
 *
 * The venue enumerates the field as `BUY | SELL` on both the price change and
 * the last trade, and documents the trade's as "From taker's perspective". A
 * buy rests on, or lifts into, the bid side; a sell the ask side. The SDK
 * upper-cases before matching, so this does too.
 *
 * An unrecognized value is NOT mapped to a default. ADR-002 §7: "A runtime
 * parser must treat an unrecognized value as first-class UNKNOWN — routed to
 * `DataQualityIncidentOpened` and preserved raw — rather than assuming the
 * enumeration is exhaustive."
 */
export function normalizeVenueSide(value: unknown): ValueNormalization<BookSide> {
  if (isWireAbsent(value)) {
    return OK_ABSENT;
  }
  if (typeof value !== "string") {
    return invalid(`expected a side string, received ${typeof value}`);
  }
  switch (value.toUpperCase()) {
    case "BUY":
      return { status: "ok", value: "BID" };
    case "SELL":
      return { status: "ok", value: "ASK" };
    default:
      return invalid(`unknown venue side "${truncate(value)}"`);
  }
}

function truncate(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 61)}...`;
}
