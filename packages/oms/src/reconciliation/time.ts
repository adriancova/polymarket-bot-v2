/**
 * Epoch milliseconds to ISO-8601 UTC text, by integer arithmetic: no clock is
 * read and no date object is built (this package reads no clock; the
 * coordinator's readings come from its injected port). The same algorithm as
 * `packages/ledger/src/reconciliation/holdings.ts` (`isoFromEpochMs`); the
 * two packages share no edge, so each carries it, and the conformance suite
 * checks that they agree.
 */

function civilFromDays(days: number): { readonly year: number; readonly month: number; readonly day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** `YYYY-MM-DDTHH:MM:SS.mmmZ`; `undefined` outside years 1970–9999. */
export function isoFromEpochMs(ms: number): string | undefined {
  if (!Number.isSafeInteger(ms) || ms < 0) return undefined;
  const days = Math.floor(ms / 86_400_000);
  const rest = ms - days * 86_400_000;
  const { year, month, day } = civilFromDays(days);
  if (year > 9999) return undefined;
  const hours = Math.floor(rest / 3_600_000);
  const minutes = Math.floor((rest % 3_600_000) / 60_000);
  const seconds = Math.floor((rest % 60_000) / 1000);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(rest % 1000, 3)}Z`;
}

/** ISO-8601 with an offset (the shape the door accepts as a match time: `door.ts`'s `isIsoInstant`). */
const INSTANT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/u;

function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The value of a run of ASCII digits the pattern already matched (no float coercion: integer arithmetic only). */
function digitsOf(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) value = value * 10 + (text.charCodeAt(index) - 48);
  return value;
}

/** The instant a match-time text names (its offset applied), in nanoseconds, with the text's fractional digits. */
function instantOf(text: string): { readonly nanos: bigint; readonly digits: number } | undefined {
  const match = INSTANT.exec(text);
  if (match === null) return undefined;
  const [, year = "", month = "", day = "", hour = "", minute = "", second = "", fraction = "", sign = "+", offsetHours = "00", offsetMinutes = "00"] = match;
  const offset = (sign === "-" ? -1 : 1) * (digitsOf(offsetHours) * 3600 + digitsOf(offsetMinutes) * 60);
  const seconds = daysFromCivil(digitsOf(year), digitsOf(month), digitsOf(day)) * 86400 + digitsOf(hour) * 3600 + digitsOf(minute) * 60 + digitsOf(second) - offset;
  return { nanos: BigInt(seconds) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0")), digits: fraction.length };
}

/**
 * Whether two match-time texts name the same instant as far as both can tell (WP-290 r7, the evidence's fill facts):
 * offsets applied, and the coarser text the finer instant truncated or rounded to its precision. The same rule as
 * the OMS's fill de-duplication (`order-manager.ts` `sameInstant`), so the evidence never calls two texts of one
 * instant a contradiction the OMS would accept as the same fill. Two texts that are not instants are the same only
 * when they are equal.
 */
export function sameInstantText(a: string, b: string): boolean {
  if (a === b) return true;
  const x = instantOf(a);
  const y = instantOf(b);
  if (x === undefined || y === undefined) return false;
  const [coarse, fine] = x.digits <= y.digits ? [x, y] : [y, x];
  const unit = 10n ** BigInt(9 - coarse.digits);
  const excess = fine.nanos - coarse.nanos;
  return 2n * excess >= -unit && excess < unit;
}
