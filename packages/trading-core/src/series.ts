/**
 * The trader's half of SERIES AUTO-ADMISSION (`ROLLOVER-1`; ADR-030; the
 * user's ruling A5 and Q1-Q4): the reviewed-series document, its configuration
 * hash, a window's schedule from its title, the window's derived identity, and
 * the PAPER/BACKTEST guard.
 *
 * ## Why these are restated here (MIRRORS of `@polymarket-bot/universe`)
 *
 * The gateway judges a window with `@polymarket-bot/universe`'s
 * `series-admission.ts`. This package does not depend on `universe` — the edge
 * does not exist, and adding it is a lockfile change this round may not make —
 * yet ADR-030 Decision 4.2 pins the series in the trader's OWN run record, and
 * the trader RE-JUDGES every admission against its own copy of the review
 * (defence in depth: a gateway mis-configured with another review, or a
 * forged event, must not put a window into a run). So the four pure functions
 * the re-judge needs are restated below, line for line in behaviour:
 *
 * | here | the gateway's |
 * | --- | --- |
 * | {@link ReviewedSeriesSchema} | `ReviewedSeriesSchema` (`outcomes` is a two-element array here: this door's arena copies no `tuple` node; `parameters.acceptedProtocolVersions`, `V2-1`, is the same rule, its distinctness checked by index because the arena's empty array has no iterator) |
 * | {@link seriesConfigHash} | `seriesConfigHash` |
 * | {@link deriveWindowSchedule} | `deriveWindowSchedule` (`series-window-schedule.ts`) |
 * | {@link windowInternalMarketId} | `windowInternalMarketId` |
 * | {@link admissionRunModeProblem} | `admissionRunModeProblem` |
 *
 * `test/integration/paper-trader/rollover-1-series-mirror.test.ts` runs both
 * implementations over one corpus — valid and refused documents, every
 * recorded title and the daylight-saving cases, identities — and requires
 * identical answers, so the two cannot drift silently. A disagreement can only
 * REFUSE: the trader admits nothing the hashes, the schedule or the identity
 * do not agree on.
 *
 * The venue facts behind each function are cited where the gateway's copy
 * lives (`docs/venue/verified-2026-10-04.md` §A1-A4); nothing new is asserted
 * here.
 *
 * PURE: no clock, no I/O, and no Node built-in (this package's rule): `Intl`
 * is the runtime's own time-zone database, and the sha256 is
 * `@polymarket-bot/features`' `sha256HexUtf8` (an existing edge, S10).
 */

import { explainCanonicalDecimalString } from "@polymarket-bot/decimal";
import { sha256HexUtf8 } from "@polymarket-bot/features";
import { z } from "zod";

// ---------------------------------------------------------------------------
// The reviewed series
// ---------------------------------------------------------------------------

function decimal(range?: "NON_NEGATIVE" | "POSITIVE"): z.ZodType<string, string> {
  return z.string().superRefine((value, ctx) => {
    const problem = explainCanonicalDecimalString(value, range === undefined ? undefined : { range });
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });
}

const Code = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u, "must be an alphanumeric code without whitespace");
const NonEmpty = z.string().min(1).max(200);
const Instant = z.iso.datetime({ offset: true });
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u, "must be a sha256 digest: 64 lowercase hex characters");
const UnsignedIntegerString = z.string().regex(/^(?:0|[1-9][0-9]{0,17})$/u, "must be a canonical unsigned integer string");
const GammaSeriesId = z.string().regex(/^[1-9][0-9]{0,17}$/u, "must be the Gamma series id: digits, no leading zero");

/** The protocol versions a Gamma market may state (the gateway's `PROTOCOL_VERSIONS`; ADR-030 Amendment 2 rule 1). */
export const PROTOCOL_VERSIONS = Object.freeze(["v1", "v2"] as const);

/** The refusal of a review that does not state its accepted versions (the gateway's text, word for word). */
export const ACCEPTED_PROTOCOL_VERSIONS_REQUIRED =
  'acceptedProtocolVersions is required: a non-empty list of distinct protocol versions, each "v1" or "v2" ' +
  '(ADR-030 Amendment 2 rule 2; e.g. ["v1"], or ["v1","v2"] once a review accepts V2 windows). It is never inferred';

/**
 * `parameters.acceptedProtocolVersions` (ADR-030 Amendment 2 rule 2, item 4:
 * "Both copies of the review schema carry it, so the gateway's and the
 * trader's hashes stay equal"). Required, never defaulted. The trader does
 * not judge a window's version — `SeriesWindowAdmitted@1` carries none, so the
 * gateway alone judges it (rule 2 item 5) — but the list is part of the review
 * this trader pins, so it is part of {@link seriesConfigHash}.
 */
const AcceptedProtocolVersions = z
  .array(z.enum(PROTOCOL_VERSIONS), { error: ACCEPTED_PROTOCOL_VERSIONS_REQUIRED })
  .min(1)
  .max(PROTOCOL_VERSIONS.length)
  .superRefine((versions, ctx) => {
    for (let left = 0; left < versions.length; left += 1) {
      for (let right = left + 1; right < versions.length; right += 1) {
        if (versions[left] === versions[right]) {
          ctx.addIssue({ code: "custom", message: "the accepted protocol versions must be distinct" });
          return;
        }
      }
    }
  });

/** The only zone a reviewed title may name, and the label the titles carry. */
export const SERIES_TITLE_TIME_ZONE = "America/New_York" as const;
export const SERIES_TITLE_ZONE_LABEL = "ET" as const;

/**
 * One REVIEWED series (ADR-030 Decision 1.1), the gateway's document field for
 * field: strict at every level, no default, no transform, so the parsed tree
 * IS the reviewed document and its hash is the gateway's.
 */
export const ReviewedSeriesSchema = z.strictObject({
  seriesId: Code,
  review: z.strictObject({ reviewedBy: NonEmpty, reviewedAt: Instant, reference: NonEmpty }),
  venue: z.strictObject({ gammaSeriesId: GammaSeriesId, seriesSlug: NonEmpty }),
  window: z.strictObject({
    titlePrefix: NonEmpty,
    titleTimeZone: z.literal(SERIES_TITLE_TIME_ZONE),
    titleZoneLabel: z.literal(SERIES_TITLE_ZONE_LABEL),
    durationSeconds: z.number().int().min(60).max(86_400),
  }),
  rules: z.strictObject({ descriptionSha256: Sha256Hex, resolutionSource: NonEmpty }),
  /** The outcome labels IN ORDER: index 0 is the YES outcome. */
  outcomes: z.array(NonEmpty).min(2).max(2),
  parameters: z.strictObject({
    /** The Gamma `Market.version` values the review accepts (ADR-030 Amendment 2 rule 2). */
    acceptedProtocolVersions: AcceptedProtocolVersions,
    allowedTickSizes: z.array(decimal("POSITIVE")).min(1).max(8),
    minimumOrderSize: decimal("POSITIVE"),
    /**
     * `ROLLOVER-1` r7 (R6-FABLE-01): `false` only, as the gateway's schema —
     * augmented negative risk is neither read nor judged, so a review stating
     * `true` is refused at parse (see `@polymarket-bot/universe`).
     */
    negRisk: z.literal(false),
    fees: z.strictObject({
      feesEnabled: z.boolean(),
      rate: decimal("NON_NEGATIVE"),
      exponent: decimal("NON_NEGATIVE"),
      takerOnly: z.boolean(),
      rebateRate: decimal("NON_NEGATIVE"),
      makerBaseFee: UnsignedIntegerString,
      takerBaseFee: UnsignedIntegerString,
    }),
    tradingDelay: z.strictObject({
      takerOrderDelayEnabled: z.boolean(),
      gammaSecondsDelay: z.union([z.literal("NOT_STATED"), UnsignedIntegerString]),
    }),
    catalogTradingDelaySeconds: z.number().int().min(0).max(86_400),
  }),
  settlement: z.strictObject({ specRef: Code, modelDependentActivationAllowed: z.boolean() }),
  trading: z.strictObject({
    makerFeeRate: decimal("NON_NEGATIVE"),
    takerFeeRate: decimal("NON_NEGATIVE"),
    seriesKey: Code,
    underlyingKey: Code,
    resolutionWindowKey: Code,
  }),
  maximumConcurrentWindows: z.number().int().min(1).max(64),
  unresolvedTeardownSeconds: z.number().int().min(300).max(7 * 86_400),
});

export type ReviewedSeries = z.infer<typeof ReviewedSeriesSchema>;

/**
 * The CANONICAL JSON text of a plain-data document: keys in code-unit order at
 * every level, arrays in order, no whitespace; strings and booleans as JSON
 * writes them; safe integers as their decimal text. Own data only. TOTAL.
 */
export function canonicalSeriesJson(
  value: unknown,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: string } {
  try {
    return { ok: true, text: canonical(value, 0) };
  } catch (cause) {
    return { ok: false, problem: cause instanceof Error ? cause.message : "the document is not canonicalizable" };
  }
}

function canonical(value: unknown, depth: number): string {
  if (depth > 8) throw new Error("the document is nested deeper than 8 levels");
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`a number that is not a safe integer: ${String(value)}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((element) => canonical(element, depth + 1)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`)
      .join(",")}}`;
  }
  throw new Error(`a ${value === null ? "null" : typeof value} is not a reviewed-series value`);
}

/** sha256, lowercase hex, of {@link canonicalSeriesJson}'s UTF-8 bytes — `SeriesWindowAdmitted.seriesConfigHash`. */
export function seriesConfigHash(
  series: unknown,
): { readonly ok: true; readonly hash: string } | { readonly ok: false; readonly problem: string } {
  const text = canonicalSeriesJson(series);
  if (!text.ok) return text;
  return { ok: true, hash: sha256HexUtf8(text.text) };
}

// ---------------------------------------------------------------------------
// The run-mode guard (ADR-030 Decision 2.1)
// ---------------------------------------------------------------------------

/** `undefined` when admission may run in `mode` (exactly PAPER or BACKTEST); otherwise why not. */
export function admissionRunModeProblem(mode: unknown): string | undefined {
  if (mode === "PAPER" || mode === "BACKTEST") return undefined;
  return (
    `series admission refuses to start in run mode ${typeof mode === "string" ? JSON.stringify(mode) : `(${typeof mode})`}: ` +
    "it runs only in PAPER or BACKTEST (ADR-030 Decision 2.1), and a new window is never " +
    'auto-approved for live trading (§9.2: "a new market pattern is not auto-approved for live trading")'
  );
}

// ---------------------------------------------------------------------------
// The admitted window's derived identity
// ---------------------------------------------------------------------------

/**
 * The derived UUIDv7 of an admitted window: its scheduled open (Unix ms) as the
 * timestamp, version 7, variant `10`, and the first 74 bits of
 * sha256(`rollover-1/window-market-id/v1|` + conditionId). Undefined outside
 * the 48-bit timestamp range.
 */
export function windowInternalMarketId(conditionId: string, scheduledOpenEpochMs: number): string | undefined {
  if (!Number.isSafeInteger(scheduledOpenEpochMs) || scheduledOpenEpochMs < 0 || scheduledOpenEpochMs >= 2 ** 48) {
    return undefined;
  }
  const digestHex = sha256HexUtf8(`rollover-1/window-market-id/v1|${conditionId}`);
  const bytes = new Uint8Array(16);
  let remaining = scheduledOpenEpochMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  for (let index = 6; index < 16; index += 1) {
    bytes[index] = Number.parseInt(digestHex.slice((index - 6) * 2, (index - 6) * 2 + 2), 16);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// The schedule, from the title (ruling Q3)
// ---------------------------------------------------------------------------

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

const TITLE_RANGE_PATTERN = new RegExp(
  `^(${MONTHS.join("|")}) ([1-9]|[12][0-9]|3[01]), (1[0-2]|[1-9]):([0-5][0-9])(AM|PM)-(1[0-2]|[1-9]):([0-5][0-9])(AM|PM) ${SERIES_TITLE_ZONE_LABEL}$`,
  "u",
);

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const OFFSET_STEPS: readonly number[] = Array.from({ length: (14 + 12) * 4 + 1 }, (_, index) => (index - 12 * 4) * QUARTER_HOUR_MS);

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

function nextDay(wall: WallTime): Pick<WallTime, "year" | "month" | "day"> {
  const next = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function hour24(hour12: number, meridiem: string): number {
  if (meridiem === "AM") return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

/** The ISO-8601 instant grammar {@link epochMsOfInstant} reads, with its calendar fields captured. */
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

/** Days in `month` (1-12) of the proleptic Gregorian `year`. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Epoch milliseconds of an ISO-8601 instant WITH an offset or `Z`, or
 * `undefined`.
 *
 * `ROLLOVER-1` r1 (R1-02): every calendar field is checked BEFORE conversion.
 * `Date.parse` normalizes a date the calendar does not have — on Node 24,
 * `2026-02-30T22:15:00Z` is March 2 and `2026-04-31` is May 1 — so a malformed
 * per-window fact would otherwise convert to another, well-formed instant and
 * be admitted (ADR-030 Decisions 1.2 and 1.5: present, well formed, and fail
 * closed). A month outside 1-12, a day the month does not have, an hour past
 * 23, a minute or second past 59 (no leap second, no `24:00`), or an offset
 * past 23:59 is refused here.
 */
export function epochMsOfInstant(value: string): number | undefined {
  const match = INSTANT_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number.parseInt(yearText ?? "", 10);
  const month = Number.parseInt(monthText ?? "", 10);
  const day = Number.parseInt(dayText ?? "", 10);
  const hour = Number.parseInt(hourText ?? "", 10);
  const minute = Number.parseInt(minuteText ?? "", 10);
  const second = secondText === undefined ? 0 : Number.parseInt(secondText, 10);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (offsetHourText !== undefined && (Number.parseInt(offsetHourText, 10) > 23 || Number.parseInt(offsetMinuteText ?? "", 10) > 59)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type WindowScheduleResult =
  | { readonly ok: true; readonly openAt: string; readonly closeAt: string; readonly openEpochMs: number; readonly closeEpochMs: number }
  | { readonly ok: false; readonly problems: readonly string[]; readonly ambiguous: boolean };

/**
 * A window's scheduled interval from its TITLE, read in America/New_York, the
 * year taken from the start locator's ET date, and confirmed against both
 * locators; refused unless the title converts to exactly ONE interval of the
 * reviewed length (the daylight-saving repeat, U-34). TOTAL.
 */
export function deriveWindowSchedule(
  title: string | null | undefined,
  shape: { readonly titlePrefix: string; readonly durationSeconds: number },
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
  if (openLocatorMs === undefined) problems.push("the window's start locator is absent or not an ISO-8601 instant");
  if (closeLocatorMs === undefined) problems.push("the window's end locator is absent or not an ISO-8601 instant");
  if (openLocatorMs === undefined || closeLocatorMs === undefined) return { ok: false, problems, ambiguous: false };
  const locatorWall = wallTimeOf(openLocatorMs);
  if (locatorWall === undefined) {
    return { ok: false, problems: ["the start locator could not be read as an America/New_York date"], ambiguous: false };
  }
  const [, monthName, dayText, startHour, startMinute, startMeridiem, endHour, endMinute, endMeridiem] = match;
  const start: WallTime = {
    year: locatorWall.year,
    month: MONTHS.indexOf(monthName as (typeof MONTHS)[number]) + 1,
    day: Number(dayText),
    hour: hour24(Number(startHour), String(startMeridiem)),
    minute: Number(startMinute),
  };
  const endClock = { hour: hour24(Number(endHour), String(endMeridiem)), minute: Number(endMinute) };
  const crossesMidnight = endClock.hour * 60 + endClock.minute <= start.hour * 60 + start.minute;
  const end: WallTime = { ...(crossesMidnight ? nextDay(start) : start), ...endClock };
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
          `${String(shape.durationSeconds)} s in ${SERIES_TITLE_TIME_ZONE} (year ${String(start.year)}), not exactly one`,
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
        `the title ${JSON.stringify(title)} states ${new Date(only.open).toISOString()}..${new Date(only.close).toISOString()}, ` +
          `but the window's scheduled instants read ${new Date(openLocatorMs).toISOString()}..${new Date(closeLocatorMs).toISOString()}`,
      ],
      ambiguous: false,
    };
  }
  return {
    ok: true,
    openAt: new Date(only.open).toISOString(),
    closeAt: new Date(only.close).toISOString(),
    openEpochMs: only.open,
    closeEpochMs: only.close,
  };
}
