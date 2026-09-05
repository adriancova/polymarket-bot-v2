/**
 * Logical time for a pure strategy: strict-UTC ISO-8601 text in, integer
 * milliseconds out, and back.
 *
 * A strategy never reads a clock (§6 invariant 2, ADR-005 §1, F11). Time enters
 * ONLY as `ctx.now()` and as the timestamps carried on the views, and both are
 * strings. Every time comparison this strategy makes — holding timeout, entry
 * and exit cutoffs, cool-down, maker-to-aggressive escalation, book staleness —
 * therefore needs text-to-instant conversion, and it must be exact,
 * deterministic and total.
 *
 * GRAMMAR — the strict UTC subset, identical in spirit to the WP-160 feature
 * engine's (`docs/contracts/features-v1.md` §6) and for the same reasons:
 *
 *     YYYY-MM-DDTHH:MM:SS(.mmm)?Z
 *
 * `Z` only (one instant, one spelling), at most millisecond precision
 * (sub-millisecond digits would truncate silently), real Gregorian calendar
 * dates, and NO leap second (`:60`). An offset form such as
 * `2026-01-02T03:04:05+01:00` is REFUSED rather than converted: the domain's
 * `IsoTimestampSchema` accepts it, so refusing here is a deliberate narrowing
 * that makes the composition root's normalization obligation visible instead of
 * hiding a timezone conversion inside a trading decision. The obligation is
 * recorded in this package's README and in the WP-220 handoff.
 *
 * Milliseconds are a non-economic integer, so a JavaScript `number` is the
 * correct type (the domain itself types durations that way). Every arithmetic
 * operation below is integer arithmetic on values far inside the safe-integer
 * range; no economic value is ever a `number` anywhere in this package.
 *
 * No `Date` is referenced, constructed, or imported — the days-from-civil
 * conversion is Howard Hinnant's closed-form algorithm, which is exact integer
 * arithmetic and needs no calendar library.
 */

import { bad, ok, type Outcome } from "./plain.js";

const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Earliest year the Gregorian calendar rule is applied unambiguously. */
const MIN_YEAR = 1583;
const MAX_YEAR = 9999;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * Days from 1970-01-01 to (year, month, day), exact integer arithmetic
 * (Hinnant's `days_from_civil`).
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Inverse of {@link daysFromCivil} (Hinnant's `civil_from_days`). */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  return { year: month <= 2 ? year + 1 : year, month, day };
}

/**
 * Parses a strict-UTC ISO timestamp into epoch milliseconds. TOTAL: every
 * failure is a stated problem, and nothing throws.
 */
export function parseInstantMs(value: unknown, path: string): Outcome<number> {
  if (typeof value !== "string") {
    return bad(`${path} must be a strict-UTC ISO-8601 timestamp string`);
  }
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return bad(
      `${path} must match YYYY-MM-DDTHH:MM:SS(.mmm)Z exactly — an offset form is refused ` +
        "rather than converted, and sub-millisecond precision is refused rather than truncated",
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = match[7] === undefined ? 0 : Number(match[7]);

  if (year < MIN_YEAR || year > MAX_YEAR) {
    return bad(`${path}: year ${String(year)} is outside [${String(MIN_YEAR)}, ${String(MAX_YEAR)}]`);
  }
  if (month < 1 || month > 12) {
    return bad(`${path}: month ${match[2] ?? ""} is not a calendar month`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return bad(`${path}: ${value} is not a real calendar date`);
  }
  if (hour > 23 || minute > 59) {
    return bad(`${path}: ${value} has an out-of-range time field`);
  }
  if (second > 59) {
    return bad(`${path}: ${value} names a leap second, which has no epoch-millisecond form`);
  }
  const ms =
    daysFromCivil(year, month, day) * MS_PER_DAY +
    hour * MS_PER_HOUR +
    minute * MS_PER_MINUTE +
    second * MS_PER_SECOND +
    millis;
  return ok(ms);
}

function pad(value: number, width: number): string {
  const text = String(value);
  return text.length >= width ? text : "0".repeat(width - text.length) + text;
}

/**
 * Formats epoch milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
 *
 * Used only for values this strategy PRODUCES — `validUntil` and
 * `nextWakeupAt` — both of which the domain validates as ISO timestamps. A
 * value outside the representable calendar range refuses rather than emitting
 * a malformed timestamp.
 */
export function formatInstantMs(ms: number, path: string): Outcome<string> {
  if (!Number.isSafeInteger(ms)) {
    return bad(`${path}: ${String(ms)} is not an integer millisecond instant`);
  }
  const days = Math.floor(ms / MS_PER_DAY);
  const timeOfDay = ms - days * MS_PER_DAY;
  const { year, month, day } = civilFromDays(days);
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return bad(`${path}: instant ${String(ms)} falls outside the representable calendar range`);
  }
  const hour = Math.floor(timeOfDay / MS_PER_HOUR);
  const minute = Math.floor((timeOfDay - hour * MS_PER_HOUR) / MS_PER_MINUTE);
  const second = Math.floor((timeOfDay - hour * MS_PER_HOUR - minute * MS_PER_MINUTE) / MS_PER_SECOND);
  const millis = timeOfDay - hour * MS_PER_HOUR - minute * MS_PER_MINUTE - second * MS_PER_SECOND;
  return ok(
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:` +
      `${pad(second, 2)}.${pad(millis, 3)}Z`,
  );
}
