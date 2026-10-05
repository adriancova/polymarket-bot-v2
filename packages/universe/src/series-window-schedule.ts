/**
 * A series window's SCHEDULE, from its title (`ROLLOVER-1`; ADR-030; the user's
 * ruling Q3 of 2026-10-04).
 *
 * ## The venue facts this module rests on (`docs/venue/verified-2026-10-04.md`)
 *
 * - **The title is the authority.** The rules text defines the window "of the
 *   time range specified in the title" (F-16, quoting F-22), so the title's ET
 *   range IS the window. The titles read
 *   `Bitcoin Up or Down - <Month D>, <h:mmAM/PM>-<h:mmAM/PM> ET` (F-15).
 * - **ET means America/New_York.** "The question title … read in
 *   America/New_York time, equals `[eventStartTime, endDate]`" on 115 of 115
 *   windows (F-15), every one in EDT. Converting by the IANA rules for
 *   America/New_York is the report's own method (§A3); the first EST window
 *   would confirm it.
 * - **`eventStartTime` and `endDate` LOCATE a window, by observation only.**
 *   Their types are documented, their meanings are not (F-14, U-29). They are
 *   used here for exactly two things: the title carries no YEAR, so the year is
 *   read from `eventStartTime`'s America/New_York date; and the interval the
 *   title converts to must EQUAL `[eventStartTime, endDate]` — a disagreement
 *   is a fact that is not clear, and the window is refused (ADR-030
 *   Decision 1.5: "If the facts are missing or unclear, the window is not
 *   admitted"). `startDate` is NOT the open (F-15) and is never read.
 * - **The DST repeat is refused, never resolved.** When daylight saving time
 *   ends (2026-11-01) the 1:00-2:00 AM ET hour repeats, so one title can name
 *   two UTC intervals (U-34). A title that does not convert to EXACTLY ONE
 *   interval of the reviewed length is refused (ruling Q3; U-34: "fail closed
 *   on any title that does not convert to exactly one 900 s interval"). A wall
 *   time skipped when daylight saving time starts converts to none, and is
 *   refused the same way.
 *
 * ## How a wall time is converted
 *
 * Every UTC instant whose America/New_York wall clock reads the title's
 * minute is found by trying each whole-quarter-hour UTC offset from −12:00 to
 * +14:00 and keeping the instants that format back to that wall time — so
 * nothing here assumes the zone's offsets; the runtime's IANA data
 * (`Intl.DateTimeFormat`) answers. A wall time therefore converts to zero
 * (skipped), one, or two (repeated) instants, and every pairing of a start
 * instant with an end instant exactly `durationSeconds` later is a candidate.
 * Exactly one candidate is required.
 *
 * An end wall time at or before the start wall time is read on the NEXT day
 * (`11:45PM-12:00AM`): the only reading under which a 15-minute window can
 * cross midnight. Nothing else is inferred.
 *
 * PURE: no clock, no I/O. `Intl` is the runtime's own time-zone database.
 */

/** The only zone a reviewed title may name. */
export const SERIES_TITLE_TIME_ZONE = "America/New_York" as const;

/** The zone label the titles carry. */
export const SERIES_TITLE_ZONE_LABEL = "ET" as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * The part of a title after the reviewed prefix:
 * `<Month> <D>, <h:mm><AM|PM>-<h:mm><AM|PM> ET`. Anchored at both ends; no
 * other spelling is accepted.
 */
const TITLE_RANGE_PATTERN = new RegExp(
  `^(${MONTHS.join("|")}) ([1-9]|[12][0-9]|3[01]), (1[0-2]|[1-9]):([0-5][0-9])(AM|PM)-(1[0-2]|[1-9]):([0-5][0-9])(AM|PM) ${SERIES_TITLE_ZONE_LABEL}$`,
  "u",
);

const QUARTER_HOUR_MS = 15 * 60 * 1000;
/** −12:00 … +14:00, the full range of offsets the IANA database uses. */
const OFFSET_STEPS: readonly number[] = Array.from({ length: (14 + 12) * 4 + 1 }, (_, index) => (index - 12 * 4) * QUARTER_HOUR_MS);

/** A wall-clock minute in one zone. */
interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

let formatter: Intl.DateTimeFormat | undefined;

function zoneFormatter(): Intl.DateTimeFormat {
  formatter ??= new Intl.DateTimeFormat("en-US", {
    timeZone: SERIES_TITLE_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  return formatter;
}

/** The America/New_York wall time of a UTC instant (whole seconds), or `undefined`. */
function wallTimeOf(epochMs: number): (WallTime & { readonly second: number }) | undefined {
  if (!Number.isFinite(epochMs)) return undefined;
  const parts = zoneFormatter().formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  const wall = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
  return Object.values(wall).every((value) => Number.isInteger(value)) ? wall : undefined;
}

/** Every UTC instant at which the zone's wall clock reads `wall` (seconds 0). Ascending. */
function instantsOf(wall: WallTime): readonly number[] {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  if (!Number.isFinite(naive)) return [];
  const found = new Set<number>();
  for (const offset of OFFSET_STEPS) {
    const candidate = naive - offset;
    const back = wallTimeOf(candidate);
    if (
      back !== undefined &&
      back.year === wall.year &&
      back.month === wall.month &&
      back.day === wall.day &&
      back.hour === wall.hour &&
      back.minute === wall.minute &&
      back.second === 0
    ) {
      found.add(candidate);
    }
  }
  return [...found].sort((left, right) => left - right);
}

/** The calendar day after `wall`'s (proleptic Gregorian, via UTC arithmetic). */
function nextDay(wall: WallTime): Pick<WallTime, "year" | "month" | "day"> {
  const next = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function hour24(hour12: number, meridiem: string): number {
  if (meridiem === "AM") return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

/** Strict-UTC millisecond rendering, the form every instant in this repository uses. */
export function isoFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Epoch milliseconds of an ISO-8601 instant WITH an offset or `Z`, or `undefined`. */
export function epochMsOfInstant(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** What the window's title says, as reviewed (`ReviewedSeries.window`). */
export interface SeriesWindowShape {
  /** The fixed text before the ET range, e.g. `Bitcoin Up or Down - `. */
  readonly titlePrefix: string;
  /** The window's length, e.g. 900 (`btc-15m-updown`; F-15: "exactly 900 s"). */
  readonly durationSeconds: number;
}

export type WindowScheduleResult =
  | {
      readonly ok: true;
      /** The window's scheduled open, strict UTC with milliseconds. */
      readonly openAt: string;
      /** The window's scheduled close, strict UTC with milliseconds. */
      readonly closeAt: string;
      readonly openEpochMs: number;
      readonly closeEpochMs: number;
    }
  | {
      readonly ok: false;
      /** Why the title gives no single interval; names every problem found. */
      readonly problems: readonly string[];
      /**
       * `true` when the title parsed but converts to zero or several intervals
       * of the reviewed length — the daylight-saving cases (U-34).
       */
      readonly ambiguous: boolean;
    };

/**
 * Derives a window's scheduled interval from its TITLE (the authority), using
 * the locators only to find the year and to confirm the result (module
 * header). TOTAL: never throws.
 *
 * @param title the venue's title, verbatim
 * @param shape the reviewed series' title prefix and window length
 * @param locatorOpen `eventStartTime` (or, for a re-judge, the admitted
 *   `scheduledOpenAt`), an ISO-8601 instant
 * @param locatorClose `endDate` (or the admitted `scheduledCloseAt`)
 */
export function deriveWindowSchedule(
  title: string | null | undefined,
  shape: SeriesWindowShape,
  locatorOpen: string | null | undefined,
  locatorClose: string | null | undefined,
): WindowScheduleResult {
  const problems: string[] = [];
  if (typeof title !== "string" || title.length === 0) {
    return { ok: false, problems: ["the window has no title, and the title is the schedule's authority"], ambiguous: false };
  }
  if (!title.startsWith(shape.titlePrefix)) {
    return {
      ok: false,
      problems: [`the title ${JSON.stringify(title)} does not begin with the reviewed prefix ${JSON.stringify(shape.titlePrefix)}`],
      ambiguous: false,
    };
  }
  const match = TITLE_RANGE_PATTERN.exec(title.slice(shape.titlePrefix.length));
  if (match === null) {
    return {
      ok: false,
      problems: [
        `the title ${JSON.stringify(title)} does not state its range as "<Month D>, <h:mmAM/PM>-<h:mmAM/PM> ${SERIES_TITLE_ZONE_LABEL}"`,
      ],
      ambiguous: false,
    };
  }
  const openLocatorMs = typeof locatorOpen === "string" ? epochMsOfInstant(locatorOpen) : undefined;
  const closeLocatorMs = typeof locatorClose === "string" ? epochMsOfInstant(locatorClose) : undefined;
  if (openLocatorMs === undefined) problems.push("the window's start locator (eventStartTime) is absent or not an ISO-8601 instant");
  if (closeLocatorMs === undefined) problems.push("the window's end locator (endDate) is absent or not an ISO-8601 instant");
  if (openLocatorMs === undefined || closeLocatorMs === undefined) return { ok: false, problems, ambiguous: false };

  // The title carries no year: it is the year of the start locator's own
  // America/New_York date (module header).
  const locatorWall = wallTimeOf(openLocatorMs);
  if (locatorWall === undefined) {
    return { ok: false, problems: ["the start locator could not be read as an America/New_York date"], ambiguous: false };
  }
  const [, monthName, dayText, startHour, startMinute, startMeridiem, endHour, endMinute, endMeridiem] = match;
  const month = MONTHS.indexOf(monthName as (typeof MONTHS)[number]) + 1;
  const start: WallTime = {
    year: locatorWall.year,
    month,
    day: Number(dayText),
    hour: hour24(Number(startHour), String(startMeridiem)),
    minute: Number(startMinute),
  };
  // A day the calendar does not have (`February 30`) round-trips to another
  // date and so converts to no instant: refused below as zero intervals.
  const endClock = { hour: hour24(Number(endHour), String(endMeridiem)), minute: Number(endMinute) };
  const crossesMidnight = endClock.hour * 60 + endClock.minute <= start.hour * 60 + start.minute;
  const endDate = crossesMidnight ? nextDay(start) : start;
  const end: WallTime = { ...endDate, ...endClock };

  const durationMs = shape.durationSeconds * 1000;
  const candidates: { readonly open: number; readonly close: number }[] = [];
  for (const open of instantsOf(start)) {
    for (const close of instantsOf(end)) {
      if (close - open === durationMs) candidates.push({ open, close });
    }
  }
  if (candidates.length !== 1) {
    return {
      ok: false,
      problems: [
        `the title ${JSON.stringify(title)} converts to ${String(candidates.length)} UTC intervals of ` +
          `${String(shape.durationSeconds)} s in ${SERIES_TITLE_TIME_ZONE} (year ${String(start.year)}), not exactly one` +
          (candidates.length > 1
            ? ` (${candidates.map((candidate) => `${isoFromEpochMs(candidate.open)}..${isoFromEpochMs(candidate.close)}`).join(", ")}): ` +
              "a repeated wall-clock hour (daylight saving ends, U-34) — refused, never resolved"
            : ": a wall time the zone skips or a range of another length — refused"),
      ],
      ambiguous: true,
    };
  }
  const only = candidates[0];
  if (only === undefined) return { ok: false, problems: ["unreachable: no candidate"], ambiguous: true };
  if (only.open !== openLocatorMs || only.close !== closeLocatorMs) {
    return {
      ok: false,
      problems: [
        `the title ${JSON.stringify(title)} states ${isoFromEpochMs(only.open)}..${isoFromEpochMs(only.close)}, but the ` +
          `window's locators read ${isoFromEpochMs(openLocatorMs)}..${isoFromEpochMs(closeLocatorMs)}; ` +
          "the venue's facts disagree, so the window is not clear (ADR-030 Decision 1.5)",
      ],
      ambiguous: false,
    };
  }
  return {
    ok: true,
    openAt: isoFromEpochMs(only.open),
    closeAt: isoFromEpochMs(only.close),
    openEpochMs: only.open,
    closeEpochMs: only.close,
  };
}
