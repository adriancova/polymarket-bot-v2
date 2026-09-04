/**
 * Hand-written TOTAL validators for the grammars this package's doors read.
 *
 * WHY HAND-WRITTEN. This package runs no runtime schema library (see
 * {@link ./plain.js} and `README.md` §2). ADR-020 §1 item 4 measured that one
 * inherited `skipChecks` turns every `.uuid()`, `.datetime()`, `.regex()` and
 * `.min()` in **every** schema in the process into a no-op — including the
 * frozen `packages/domain` primitives. A predicate that is a plain function of
 * its argument has no parse state to inherit and no slot to defeat.
 *
 * WHAT BINDS THEM TO THE FROZEN CONTRACTS. Being independent is only safe if it
 * is also faithful. `test/unit/simulation/grammar-cross.test.ts` runs each
 * predicate below against the REAL frozen schema it mirrors
 * (`Uuidv7Schema`, `UuidSchema`, `IsoTimestampSchema`,
 * `UnsignedBigIntStringSchema`, `CodeStringSchema`, `NonEmptyStringSchema`,
 * `NonNegativeIntegerSchema`, `TokenIdSchema`) over a generated corpus, at the
 * root test level where importing `zod` creates no workspace edge. A divergence
 * in either direction fails that suite.
 *
 * Every predicate is a pure function of its argument: no clock, no randomness,
 * no I/O, no ambient state.
 */

import { isCanonicalDecimalString } from "@polymarket-bot/decimal";

/** `packages/domain` `MAX_IDENTIFIER_LENGTH`. Cross-tested. */
export const MAX_IDENTIFIER_LENGTH = 200;
/** `packages/domain` `MAX_CODE_LENGTH`. Cross-tested. */
export const MAX_CODE_LENGTH = 64;
/** `packages/domain` `UnsignedBigIntStringSchema` upper bound. Cross-tested. */
export const MAX_UNSIGNED_BIGINT_DIGITS = 40;

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isLowerHex(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66);
}

/** A bounded, non-empty string (`NonEmptyStringSchema`). */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_IDENTIFIER_LENGTH;
}

/**
 * A stable machine vocabulary token (`CodeStringSchema`):
 * `[A-Za-z][A-Za-z0-9_.:-]*`, 1..64 characters.
 */
export function isCodeString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > MAX_CODE_LENGTH) return false;
  const first = value.charCodeAt(0);
  const isAlpha = (code: number): boolean =>
    (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
  if (!isAlpha(first)) return false;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isAlpha(code) || isDigit(code)) continue;
    // `_` `.` `:` `-`
    if (code === 0x5f || code === 0x2e || code === 0x3a || code === 0x2d) continue;
    return false;
  }
  return true;
}

/**
 * A canonical unsigned integer string: no sign, no leading zeros, 1..`maxDigits`.
 *
 * `UnsignedBigIntStringSchema` (40 digits) and `TokenIdSchema`
 * (`MAX_IDENTIFIER_LENGTH`) share this grammar and differ only in the bound.
 */
export function isUnsignedIntegerString(
  value: unknown,
  maxDigits: number = MAX_UNSIGNED_BIGINT_DIGITS,
): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > maxDigits) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!isDigit(value.charCodeAt(index))) return false;
  }
  return value.length === 1 || value.charCodeAt(0) !== 0x30;
}

/** `TokenIdSchema` — the same grammar bounded by `MAX_IDENTIFIER_LENGTH`. */
export function isTokenId(value: unknown): value is string {
  return isUnsignedIntegerString(value, MAX_IDENTIFIER_LENGTH);
}

/** A non-negative safe integer (`NonNegativeIntegerSchema`). */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A strictly positive safe integer (`PositiveIntegerSchema`). */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * A canonical lowercase UUID of any RFC 9562 version (`UuidSchema`).
 *
 * Structure: `8-4-4-4-12` lowercase hex, version nibble `1..8`, variant nibble
 * `8|9|a|b`. Parsed by position rather than by regex so the check has no
 * backtracking behaviour to reason about.
 */
export function isCanonicalUuid(value: unknown): value is string {
  return checkUuid(value, undefined);
}

/** A canonical lowercase UUIDv7 (`Uuidv7Schema`). */
export function isCanonicalUuidV7(value: unknown): value is string {
  return checkUuid(value, 7);
}

const UUID_DASH_POSITIONS: readonly number[] = [8, 13, 18, 23];
const UUID_VERSION_POSITION = 14;
const UUID_VARIANT_POSITION = 19;

function checkUuid(value: unknown, version: number | undefined): boolean {
  if (typeof value !== "string" || value.length !== 36) return false;
  for (const position of UUID_DASH_POSITIONS) {
    if (value.charCodeAt(position) !== 0x2d) return false;
  }
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) continue;
    if (!isLowerHex(value.charCodeAt(index))) return false;
  }
  const versionChar = value.charCodeAt(UUID_VERSION_POSITION);
  if (version === undefined) {
    // `1`..`8` — the range the frozen `UuidSchema` accepts.
    if (versionChar < 0x31 || versionChar > 0x38) return false;
  } else if (versionChar !== 0x30 + version) {
    return false;
  }
  const variantChar = value.charCodeAt(UUID_VARIANT_POSITION);
  return (
    variantChar === 0x38 || variantChar === 0x39 || variantChar === 0x61 || variantChar === 0x62
  );
}

/** Lowercase 64-character hex — the `internal.sha256_hex` shape (§10.2). */
export function isSha256Hex(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (let index = 0; index < 64; index += 1) {
    if (!isLowerHex(value.charCodeAt(index))) return false;
  }
  return true;
}

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a Gregorian month. Exported for the markout-horizon arithmetic. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

function readFixedDigits(value: string, start: number, count: number): number | undefined {
  let out = 0;
  for (let index = start; index < start + count; index += 1) {
    const code = value.charCodeAt(index);
    if (!isDigit(code)) return undefined;
    out = out * 10 + (code - 0x30);
  }
  return out;
}

/**
 * The §7.1 timestamp grammar: `IsoTimestampSchema` = `z.iso.datetime({ offset: true })`.
 *
 * `YYYY-MM-DDTHH:MM[:SS[.fraction]](Z|±HH:MM)`, with the calendar date validated
 * (so `2026-02-30T00:00:00Z` is refused) and the offset hour bounded to `00..23`.
 * Parsed structurally; bound to the frozen schema by the grammar cross-test.
 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // `YYYY-MM-DDTHH:MM` is the shortest admissible prefix, plus at least `Z`.
  if (value.length < 17) return false;
  const year = readFixedDigits(value, 0, 4);
  if (year === undefined) return false;
  if (value.charCodeAt(4) !== 0x2d) return false;
  const month = readFixedDigits(value, 5, 2);
  if (month === undefined || month < 1 || month > 12) return false;
  if (value.charCodeAt(7) !== 0x2d) return false;
  const day = readFixedDigits(value, 8, 2);
  if (day === undefined || day < 1 || day > daysInMonth(year, month)) return false;
  if (value.charCodeAt(10) !== 0x54) return false; // 'T'
  const hour = readFixedDigits(value, 11, 2);
  if (hour === undefined || hour > 23) return false;
  if (value.charCodeAt(13) !== 0x3a) return false;
  const minute = readFixedDigits(value, 14, 2);
  if (minute === undefined || minute > 59) return false;

  let cursor = 16;
  if (value.charCodeAt(cursor) === 0x3a) {
    const second = readFixedDigits(value, cursor + 1, 2);
    if (second === undefined || second > 59) return false;
    cursor += 3;
    if (value.charCodeAt(cursor) === 0x2e) {
      cursor += 1;
      let fractionDigits = 0;
      while (cursor < value.length && isDigit(value.charCodeAt(cursor))) {
        cursor += 1;
        fractionDigits += 1;
      }
      if (fractionDigits === 0) return false;
    }
  }

  const suffix = value.slice(cursor);
  if (suffix === "Z") return true;
  if (suffix.length !== 6) return false;
  const sign = suffix.charCodeAt(0);
  if (sign !== 0x2b && sign !== 0x2d) return false;
  const offsetHour = readFixedDigits(suffix, 1, 2);
  if (offsetHour === undefined || offsetHour > 23) return false;
  if (suffix.charCodeAt(3) !== 0x3a) return false;
  const offsetMinute = readFixedDigits(suffix, 4, 2);
  return offsetMinute !== undefined && offsetMinute <= 59;
}

/**
 * Epoch milliseconds for an ISO-8601 instant, computed arithmetically.
 *
 * NO `Date` PARSING. `Date.parse` normalizes silently, and `packages/domain`
 * records that as the reason timestamps are strings everywhere. This is also
 * what keeps the whole package clock-free: converting a RECORDED timestamp to a
 * number is arithmetic, not a clock read.
 *
 * Sub-millisecond fractional digits are TRUNCATED toward the epoch-millisecond
 * they sit in; the untruncated remainder is reported so a caller that needs
 * finer resolution uses `receivedMonotonicNs` instead.
 */
export function isoToEpochMilliseconds(value: string): number | undefined {
  if (!isIsoTimestamp(value)) return undefined;
  const year = readFixedDigits(value, 0, 4);
  const month = readFixedDigits(value, 5, 2);
  const day = readFixedDigits(value, 8, 2);
  const hour = readFixedDigits(value, 11, 2);
  const minute = readFixedDigits(value, 14, 2);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  if (hour === undefined || minute === undefined) return undefined;

  let second = 0;
  let millisecond = 0;
  let cursor = 16;
  if (value.charCodeAt(cursor) === 0x3a) {
    second = readFixedDigits(value, cursor + 1, 2) ?? 0;
    cursor += 3;
    if (value.charCodeAt(cursor) === 0x2e) {
      cursor += 1;
      let digits = 0;
      let scale = 100;
      while (cursor < value.length && isDigit(value.charCodeAt(cursor))) {
        if (digits < 3) {
          millisecond += (value.charCodeAt(cursor) - 0x30) * scale;
          scale = Math.floor(scale / 10);
        }
        cursor += 1;
        digits += 1;
      }
    }
  }

  let offsetMinutes = 0;
  const suffix = value.slice(cursor);
  if (suffix !== "Z") {
    const offsetHour = readFixedDigits(suffix, 1, 2) ?? 0;
    const offsetMinute = readFixedDigits(suffix, 4, 2) ?? 0;
    offsetMinutes = offsetHour * 60 + offsetMinute;
    if (suffix.charCodeAt(0) === 0x2d) offsetMinutes = -offsetMinutes;
  }

  const days = daysFromCivil(year, month, day);
  const utcMinutes = days * 1440 + hour * 60 + minute - offsetMinutes;
  return utcMinutes * 60_000 + second * 1000 + millisecond;
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian date.
 *
 * Howard Hinnant's `days_from_civil`, which is exact integer arithmetic with no
 * calendar library and no clock.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** A canonical decimal string (§6 invariant 1). Delegated to the frozen rules. */
export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && isCanonicalDecimalString(value);
}

/** A member of a closed string vocabulary. */
export function isMemberOf<TMember extends string>(
  value: unknown,
  members: readonly TMember[],
): value is TMember {
  return typeof value === "string" && (members as readonly string[]).includes(value);
}

/** Own-property read of a materialized (prototype-free) tree. */
export function readField(tree: unknown, key: string): unknown {
  if (tree === null || typeof tree !== "object") return undefined;
  if (!Object.hasOwn(tree, key)) return undefined;
  return (tree as Record<string, unknown>)[key];
}

/** Is the materialized value a plain record (never an array, never null)? */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Own string keys of a materialized record, in insertion order. */
export function recordKeys(value: unknown): readonly string[] {
  return isRecord(value) ? Object.keys(value) : [];
}
