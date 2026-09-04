/**
 * Deterministic event time (WP-160 acceptance 3: no feature reads the current
 * wall clock directly).
 *
 * Time enters this package ONLY as caller-supplied event timestamps. This
 * module converts them to integer epoch milliseconds with pure calendar
 * arithmetic — no `Date` object anywhere, because `Date` is entangled with the
 * host clock/locale surface and its string parser is implementation-lenient.
 *
 * ## The v1 timestamp grammar (strict, UTC-only)
 *
 * ```text
 * YYYY-MM-DDTHH:MM:SS[.f{1,3}]Z
 * ```
 *
 * - `Z` designator only. The frozen domain contract accepts offsets
 *   (`z.iso.datetime({ offset: true })`); this package deliberately accepts
 *   the UTC subset, because two spellings of one instant would give one input
 *   two content addresses. The composition root normalizes to UTC upstream —
 *   a non-`Z` timestamp here is refused, never converted.
 * - At most 3 fractional digits (millisecond precision). Sub-millisecond
 *   digits would be silently truncated by an epoch-ms representation, and a
 *   silently truncated input is two inputs with one address; refused instead.
 * - The calendar date must be real (`2026-02-30` is refused), including the
 *   Gregorian leap rule. Leap seconds (`:60`) are refused: epoch-ms has no
 *   representation for them.
 *
 * Conversion uses the days-from-civil algorithm (Howard Hinnant's public
 * derivation): integer arithmetic only, exact over the whole supported range
 * (years 1583–9999 — after the Gregorian adoption, within 4-digit years).
 */

const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Days from 1970-01-01 to `year-month-day` (proleptic Gregorian, exact). */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400; // [0, 399]
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

export type ParsedTimestamp =
  | { readonly ok: true; readonly epochMs: number }
  | { readonly ok: false; readonly problem: string };

/**
 * Parses one strict-UTC timestamp to integer epoch milliseconds, or explains
 * why it is not one. Pure and total.
 */
export function parseUtcTimestamp(value: unknown): ParsedTimestamp {
  if (typeof value !== "string") {
    return { ok: false, problem: "a timestamp must be a string" };
  }
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return {
      ok: false,
      problem:
        "not in the strict v1 UTC grammar YYYY-MM-DDTHH:MM:SS[.mmm]Z (UTC designator required; at most 3 fractional digits)",
    };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";

  if (year < 1583) {
    return { ok: false, problem: "years before 1583 (pre-Gregorian) are not supported" };
  }
  if (month < 1 || month > 12) {
    return { ok: false, problem: `month ${String(month)} is not a calendar month` };
  }
  const monthDays = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (monthDays === undefined || day < 1 || day > monthDays) {
    return { ok: false, problem: `day ${String(day)} does not exist in ${match[1] ?? ""}-${match[2] ?? ""}` };
  }
  if (hour > 23) {
    return { ok: false, problem: `hour ${String(hour)} is not a time of day` };
  }
  if (minute > 59) {
    return { ok: false, problem: `minute ${String(minute)} is not a time of day` };
  }
  if (second > 59) {
    return { ok: false, problem: `second ${String(second)} is not representable in epoch milliseconds (leap seconds refused)` };
  }

  const milliseconds = fraction.length === 0 ? 0 : Number(fraction.padEnd(3, "0"));
  const epochMs =
    daysFromCivil(year, month, day) * 86_400_000 +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1000 +
    milliseconds;
  return { ok: true, epochMs };
}
