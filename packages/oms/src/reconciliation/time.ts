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
