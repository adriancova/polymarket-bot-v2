/**
 * Strict-UTC instants — `WP-220` composition-root obligation 1.
 *
 * > "**Timestamps are strict UTC.** `ctx.now()`, `market.openTime`,
 * > `market.closeTime` and `book.asOf` must be `YYYY-MM-DDTHH:MM:SS(.mmm)Z`. An
 * > offset form is refused, never converted (`src/time.ts`, mirroring
 * > `docs/contracts/features-v1.md` §6). The domain's `IsoTimestampSchema`
 * > permits offsets, so **normalising them upstream is the root's job**."
 *   — `packages/strategies/static-bracket/README.md`
 *
 * So this module is that normalisation, and it is the ONLY place in the trader
 * where an offset form is allowed to exist. The split of responsibility, stated
 * because it is easy to get backwards:
 *
 * - the **strategy** refuses an offset (it cannot convert one without a rule it
 *   has no authority to invent);
 * - the **root** converts one, exactly once, at the ingress door, and every
 *   view it hands downstream carries the normalised form.
 *
 * WHY CONVERSION IS SAFE HERE AND NOT THERE. An offset instant names a unique
 * point in time — `2026-03-04T13:00:00+01:00` and `2026-03-04T12:00:00Z` are
 * the same instant — so the conversion loses no information about WHEN. What it
 * loses is the ORIGINATOR'S LOCAL RENDERING, which no economic decision in this
 * repository reads. The strategy refuses because a strategy that silently
 * accepted both spellings would compare two instants that print differently and
 * are equal, which is a defect class §12.4 byte-determinism cannot tolerate.
 *
 * MILLISECOND PRECISION IS THE CANONICAL FORM. Sub-millisecond digits are
 * REFUSED rather than truncated: truncation is a silent economic edit at the
 * one place §8.4 ordering is decided, and the repository's own event envelopes
 * carry nanoseconds in `receivedMonotonicNs`, not in the ISO field. A refusal
 * costs a normaliser fix upstream; a truncation costs an unfindable ordering
 * bug.
 *
 * NO CLOCK IS READ HERE. Every function takes its input as an argument. The
 * trader's own clock is a §12.1 port (`ports.ts`), so replay and live share
 * this code path exactly (§12.1: "Everything between event input and the
 * `ExecutionVenue` interface is shared").
 */

/** `YYYY-MM-DDTHH:MM:SS(.mmm)Z` — the canonical form the strategy accepts. */
const STRICT_UTC =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

/**
 * A full ISO-8601 instant with an explicit zone, as the domain's
 * `IsoTimestampSchema` permits: `Z`, `+HH:MM` or `-HH:MM`, with 0–9 fractional
 * digits.
 */
const ZONED_ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

export type NormalizeInstantResult =
  | { readonly ok: true; readonly instant: string; readonly epochMs: number }
  | { readonly ok: false; readonly problem: string };

/** True for the canonical strict-UTC spelling and nothing else. */
export function isStrictUtcInstant(value: unknown): value is string {
  return typeof value === "string" && STRICT_UTC.test(value);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Renders epoch milliseconds in the canonical strict-UTC form. */
export function formatStrictUtc(epochMs: number): string {
  const date = new Date(epochMs);
  const milliseconds = date.getUTCMilliseconds();
  const base =
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-` +
    `${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}:` +
    `${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`;
  return milliseconds === 0 ? `${base}Z` : `${base}.${pad(milliseconds, 3)}Z`;
}

/**
 * Normalises one caller instant into the strict-UTC form the strategy accepts.
 *
 * TOTAL: every failure is data, and every failure NAMES what was wrong. The
 * three refusals it can answer are deliberately distinct, because they have
 * different fixes:
 *
 * - not a string / not ISO-8601 with a zone → the producer is not emitting
 *   §7.1 timestamps at all;
 * - sub-millisecond precision → the producer's normaliser is carrying a
 *   precision the canonical form does not have (fix upstream, never truncate);
 * - an out-of-range field (month 13, day 32, hour 25) → a value `Date` would
 *   happily roll over into a different instant, which is the silent-repair
 *   class ADR-016 forbids for identifiers and this module forbids for time.
 */
export function normalizeToStrictUtc(value: unknown): NormalizeInstantResult {
  if (typeof value !== "string") {
    return {
      ok: false,
      problem: `an instant must be an ISO-8601 string; received ${typeof value}`,
    };
  }
  const match = ZONED_ISO.exec(value);
  if (match === null) {
    return {
      ok: false,
      problem:
        `"${value}" is not an ISO-8601 instant with an explicit zone; the trader normalises ` +
        "offsets to strict UTC and refuses anything it cannot read as an instant",
    };
  }
  const fraction = match[7];
  if (fraction !== undefined && fraction.length > 3) {
    return {
      ok: false,
      problem:
        `"${value}" carries sub-millisecond precision; the canonical instant form is ` +
        "YYYY-MM-DDTHH:MM:SS(.mmm)Z and the trader REFUSES rather than truncates — a " +
        "truncation is a silent edit at the point §8.4 ordering is decided",
    };
  }
  // Ranges are checked BEFORE `Date` sees the value: `Date.parse` accepts
  // "2026-02-30" and answers March 2nd, which would turn a malformed instant
  // into a real one nobody wrote.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return {
      ok: false,
      problem: `"${value}" has a calendar or clock field out of range; refused, never rolled over`,
    };
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    return { ok: false, problem: `"${value}" is not a resolvable instant` };
  }
  const normalized = formatStrictUtc(epochMs);
  // The round trip is the totality proof: whatever came in, what goes out is a
  // value this module's own strict matcher accepts.
  if (!STRICT_UTC.test(normalized)) {
    return {
      ok: false,
      problem: `"${value}" did not normalise to a strict-UTC instant (${normalized})`,
    };
  }
  // A round-over the range check above cannot see (day 31 of a 30-day month)
  // shows up here as a normalised value naming a different calendar day.
  if (
    normalized.slice(0, 10) !==
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` &&
    match[8] === "Z"
  ) {
    return {
      ok: false,
      problem:
        `"${value}" names a calendar day that does not exist and would roll over to ` +
        `${normalized}; refused, never repaired`,
    };
  }
  return { ok: true, instant: normalized, epochMs };
}

/**
 * Epoch milliseconds of a strict-UTC instant.
 *
 * Separate from {@link normalizeToStrictUtc} so the loop can compare instants
 * it has already normalised without re-deriving the string.
 */
export function strictUtcEpochMs(instant: string): number | undefined {
  if (!STRICT_UTC.test(instant)) return undefined;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? parsed : undefined;
}
