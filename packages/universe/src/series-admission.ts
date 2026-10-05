/**
 * SERIES AUTO-ADMISSION — the reviewed series and the exact-match judge
 * (`ROLLOVER-1`; ADR-030 Decisions 1-3; the user's ruling A5 and Q1-Q4).
 *
 * ## What ADR-030 asks, and where each part lives
 *
 * - **A reviewed series is configuration** (Decision 1.1; §9.2 "Series binding
 *   is configuration, not heuristic-only"): {@link ReviewedSeriesSchema}. It
 *   names the series, the exact pattern a window must match, and every market
 *   parameter the review accepted. Nothing here suggests or learns a series.
 * - **Exact match only** (Decision 1.4, acceptance 1): {@link judgeSeriesWindow}
 *   admits a window ONLY if it matches the reviewed pattern and every reviewed
 *   parameter exactly; anything else is REFUSED, naming every mismatch.
 * - **Per-window facts are checked for presence and form only** (Decision
 *   1.2): the outcome token ids, the condition id, and the open and close
 *   times. They are compared with no reviewed value; the close must follow the
 *   open.
 * - **Fail closed** (Decision 1.5): a fact that is absent, unreadable or
 *   unclear refuses the window.
 * - **PAPER or BACKTEST only** (Decision 2.1, acceptance 2):
 *   {@link admissionRunModeProblem}. Admission is NEVER auto-approval for live
 *   trading (Decision 2.2).
 * - **The run pins the series** (Decision 4.2; ruling Q4):
 *   {@link seriesConfigHash} is the sha256 of the reviewed document's
 *   canonical JSON. `SeriesWindowAdmitted@1` carries it, so a consumer holding
 *   its own copy of the review can refuse a window judged against another.
 *
 * ## The venue surfaces, and only those (acceptance 4; ADR-030 Decision 1.7)
 *
 * Every venue field the judge reads is DOCUMENTED, with its source in
 * `docs/venue/verified-2026-10-04.md` (VENUE-SETL-1) or the Gamma / CLOB
 * OpenAPI files that report fetched (S-O01, S-O02, S-D65):
 *
 * | judged | venue field | documented by |
 * | --- | --- | --- |
 * | series membership | Gamma `Event.series[].id`, `Event.seriesSlug` | S-D70 lines 345-348, 393-395; `Series.id` a string (F-08) |
 * | one market per event | `Event.markets` | S-D72 (`KeysetEventsResponse` "Always includes … Markets") |
 * | the title and question | `Event.title`, `Market.question` | Gamma OpenAPI (S-O01) `Event.title`, `Market.question` |
 * | the schedule | the title's ET range; `Market.eventStartTime`, `Market.endDate` as locators | F-14 … F-16, U-29, U-34; `./series-window-schedule.ts` |
 * | the rules | `Market.description`, `Market.resolutionSource` | S-O01; F-22 (the rules text and its digest) |
 * | outcomes and pairing | `Market.outcomes` ↔ `Market.clobTokenIds` BY INDEX, index 0 the YES outcome; cross-checked against CLOB `t[].{t,o}` | F-01 (S-D23 lines 159, 173), F-03 (S-D65 lines 97-101, 157-169) |
 * | tick size | Gamma `orderPriceMinTickSize`, CLOB `mts` | S-O01; S-D65 `mts`; F-21 (per-window data) |
 * | minimum size | Gamma `orderMinSize`, CLOB `mos` | S-O01; S-D65 `mos` |
 * | negRisk | Gamma `Event.negRisk` | S-O01 `Event.negRisk` (the `Market` schema documents none) |
 * | fees | Gamma `feesEnabled`, `feeSchedule.{rate, exponent, takerOnly, rebateRate}`, `makerBaseFee`, `takerBaseFee`; CLOB `fd.{r, e, to}`, `mbf`, `tbf` | S-O01; S-D65 |
 * | trading delay | CLOB `itode` ("omitted when false"); Gamma `secondsDelay` | F-18, F-19 (S-D65 lines 125-130; S-D23 line 877) |
 *
 * Never read: `startDate` (not the open, F-15), `markets-by-token`'s
 * primary/secondary tokens (C-17), the `new_market` arrays (F-13),
 * `series_slug` (U-30), and every field the documents do not name (`feeType`,
 * `cryptoMarketConfig`, `eventMetadata`, the CLOB `ao`, `aot`, `c`, `v`). The
 * delay's LENGTH is not judged: two official pages disagree on it (C-16); the
 * per-market fact is `itode`.
 *
 * The candidate the judge reads is assembled by
 * `@polymarket-bot/polymarket-public`'s series-window door from the raw
 * bodies the gateway journaled first (`UNIV-4`'s rule).
 *
 * PURE: no clock, no I/O, no randomness. `node:crypto`'s sha256 is a pure
 * computation (the `@polymarket-bot/decimal` precedent).
 */

import { createHash } from "node:crypto";

import {
  CodeStringSchema,
  ConditionIdSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  TokenIdSchema,
} from "@polymarket-bot/domain";
import { z } from "zod";

import { containedParse, readOwnPayload } from "./lifecycle-door.js";
import {
  deriveWindowSchedule,
  SERIES_TITLE_TIME_ZONE,
  SERIES_TITLE_ZONE_LABEL,
} from "./series-window-schedule.js";

// ---------------------------------------------------------------------------
// The reviewed series (configuration)
// ---------------------------------------------------------------------------

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u, "must be a sha256 digest: 64 lowercase hex characters");
/** A canonical unsigned integer string (a JSON integer stated exactly). */
const UnsignedIntegerString = z.string().regex(/^(?:0|[1-9][0-9]{0,17})$/u, "must be a canonical unsigned integer string");
/** Gamma's `Series.id`: a string (F-08) the keyset filter takes as an integer (F-07). */
const GammaSeriesId = z.string().regex(/^[1-9][0-9]{0,17}$/u, "must be the Gamma series id: digits, no leading zero");

/**
 * One REVIEWED series (ADR-030 Decision 1.1). STRICT at every level and with
 * NO default and NO transform, so the parsed document IS the reviewed
 * document and its canonical JSON — the input to {@link seriesConfigHash} — is
 * the same on every side that holds it.
 */
export const ReviewedSeriesSchema = z.strictObject({
  /** The configuration key, e.g. `btc-15m-updown` (§9.2; `MarketDiscovered.seriesId`). */
  seriesId: CodeStringSchema,
  /** Who reviewed it, and when: a reviewed series is a human act (§9.2). */
  review: z.strictObject({
    reviewedBy: NonEmptyStringSchema,
    reviewedAt: IsoTimestampSchema,
    /** Where the review is recorded, e.g. a docs path. */
    reference: NonEmptyStringSchema,
  }),
  /** The venue's identity for the series: the discovery filter and the membership check. */
  venue: z.strictObject({
    /** `GET /events/keyset?series_id=…` (F-07); observed `"10192"` (F-10). */
    gammaSeriesId: GammaSeriesId,
    /** `Event.seriesSlug` / `Series.slug` (S-D70); observed `btc-up-or-down-15m` (F-10). */
    seriesSlug: NonEmptyStringSchema,
  }),
  /** The window pattern: the title's shape and the window's length (F-15, F-16). */
  window: z.strictObject({
    /** The fixed text before the ET range, e.g. `Bitcoin Up or Down - `. */
    titlePrefix: NonEmptyStringSchema,
    /** The only zone a title may name (`./series-window-schedule.ts`). */
    titleTimeZone: z.literal(SERIES_TITLE_TIME_ZONE),
    titleZoneLabel: z.literal(SERIES_TITLE_ZONE_LABEL),
    /** The window's length; every observed window is exactly 900 s (F-15). */
    durationSeconds: z.number().int().min(60).max(86_400),
  }),
  /** The rules text the review accepted (F-22). */
  rules: z.strictObject({
    /** sha256 of `Market.description` (F-22: `485ceb1d…` on every TWAP-rule window). */
    descriptionSha256: Sha256Hex,
    /** `Market.resolutionSource`, verbatim. */
    resolutionSource: NonEmptyStringSchema,
  }),
  /** The outcome labels IN ORDER: index 0 is the YES outcome (F-01). */
  outcomes: z.tuple([NonEmptyStringSchema, NonEmptyStringSchema]),
  /** Every market parameter the review accepted (Decision 1.1). */
  parameters: z.strictObject({
    /**
     * The tick sizes the review accepts. Tick size is PER-WINDOW data — the
     * venue changes it near the price limits (F-21; ruling Q3) — so the review
     * states the values it accepts, checked at admission, never one constant.
     */
    allowedTickSizes: z.array(PositiveDecimalStringSchema).min(1).max(8),
    /** Gamma `orderMinSize` and CLOB `mos` (observed 5). */
    minimumOrderSize: PositiveDecimalStringSchema,
    /** Gamma `Event.negRisk`. */
    negRisk: z.boolean(),
    fees: z.strictObject({
      /** Gamma `feesEnabled`. */
      feesEnabled: z.boolean(),
      /** Gamma `feeSchedule.rate` and CLOB `fd.r`. */
      rate: NonNegativeDecimalStringSchema,
      /** Gamma `feeSchedule.exponent` and CLOB `fd.e`. */
      exponent: NonNegativeDecimalStringSchema,
      /** Gamma `feeSchedule.takerOnly` and CLOB `fd.to`. */
      takerOnly: z.boolean(),
      /** Gamma `feeSchedule.rebateRate`. */
      rebateRate: NonNegativeDecimalStringSchema,
      /** Gamma `makerBaseFee` and CLOB `mbf`. */
      makerBaseFee: UnsignedIntegerString,
      /** Gamma `takerBaseFee` and CLOB `tbf`. */
      takerBaseFee: UnsignedIntegerString,
    }),
    tradingDelay: z.strictObject({
      /** CLOB `itode`, "omitted when false" (F-19): absent reads as `false`. */
      takerOrderDelayEnabled: z.boolean(),
      /**
       * Gamma `secondsDelay`: `"NOT_STATED"` when the review accepted the field
       * absent (or null) — "not stated", never `0` (F-18, ruling Q3) — else
       * the exact integer it states.
       */
      gammaSecondsDelay: z.union([z.literal("NOT_STATED"), UnsignedIntegerString]),
    }),
    /**
     * The catalog's whole-second `trading_delay_seconds` for an admitted
     * window. The review's statement, not a venue fact: the taker delay's
     * length conflicts between official pages (C-16) and is sub-second either
     * way, so the reviewer states what the catalog column records.
     */
    catalogTradingDelaySeconds: z.number().int().min(0).max(86_400),
  }),
  /** The settlement-spec binding (ADR-030 Decision 1.1, 1.6; ADR-009). */
  settlement: z.strictObject({
    specRef: CodeStringSchema,
    /** §9.8 check 6: `false` until a settlement spec is reviewed (`CLOSEOUT-2` N2). */
    modelDependentActivationAllowed: z.boolean(),
  }),
  /** What a trader books an admitted window with (its §9.7 scope and simulated fees). */
  trading: z.strictObject({
    makerFeeRate: NonNegativeDecimalStringSchema,
    takerFeeRate: NonNegativeDecimalStringSchema,
    seriesKey: CodeStringSchema,
    underlyingKey: CodeStringSchema,
    resolutionWindowKey: CodeStringSchema,
  }),
  /** The cap on concurrently admitted windows (ADR-030 Decision 1.8). */
  maximumConcurrentWindows: z.number().int().min(1).max(64),
  /**
   * How long after its scheduled close a window still unresolved stops
   * counting as a LIVE window of the series (resolution is observed 53 to
   * 152 s after the close, F-17, so this bound only marks a resolution missed
   * or never made). One reviewed value, so the gateway and every trader agree
   * on it. `ROLLOVER-1` r1 (R1-04; ADR-030 Decision 4.4, a window is torn down
   * "after its resolution is handled"): past it, a window holds no cap slot —
   * the gateway keeps it subscribed, AWAITING its resolution (at most
   * `maximumConcurrentWindows` per series), and a trader tears it down only
   * if it holds no inventory; one that holds inventory stays until its
   * resolution is handled.
   */
  unresolvedTeardownSeconds: z.number().int().min(300).max(7 * 86_400),
});

export type ReviewedSeries = z.infer<typeof ReviewedSeriesSchema>;

export type ReviewedSeriesParse =
  | { readonly ok: true; readonly series: ReviewedSeries; readonly configHash: string }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * The reviewed-series DOOR: materialize prototype-free (D1), judge inside a
 * containment (D2's refusal path), and answer the MATERIALIZED tree (D3/D4),
 * with its {@link seriesConfigHash}. TOTAL: never throws.
 */
export function parseReviewedSeries(value: unknown): ReviewedSeriesParse {
  const read = readOwnPayload(value);
  if (!read.ok) return { ok: false, issues: [`(root): ${read.detail}`] };
  const judged = containedParse(ReviewedSeriesSchema, read.value);
  if (!judged.ok) return { ok: false, issues: judged.issues };
  const series = deepFreeze(read.value) as ReviewedSeries;
  const hash = seriesConfigHash(series);
  if (!hash.ok) return { ok: false, issues: [`(root): ${hash.problem}`] };
  return { ok: true, series, configHash: hash.hash };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * The CANONICAL JSON text of a plain-data document: object keys in code-unit
 * order at every level, arrays in order, no whitespace, strings and booleans
 * as JSON writes them, integers as their decimal text. Only what the reviewed
 * series schema admits is accepted (no `null`, no non-integer number). TOTAL.
 *
 * Own data only: keys come from `Object.keys` and values from own reads of a
 * materialized tree; nothing here calls `JSON.stringify` on an object (the
 * `SER-2` lesson: an inherited `toJSON` reaches every object `JSON.stringify`
 * visits).
 */
export function canonicalSeriesJson(value: unknown): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: string } {
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

/**
 * The reviewed series' configuration hash: sha256, lowercase hex, of the UTF-8
 * bytes of {@link canonicalSeriesJson}. `SeriesWindowAdmitted@1` carries it.
 */
export function seriesConfigHash(series: unknown): { readonly ok: true; readonly hash: string } | { readonly ok: false; readonly problem: string } {
  const text = canonicalSeriesJson(series);
  if (!text.ok) return text;
  return { ok: true, hash: createHash("sha256").update(text.text, "utf8").digest("hex") };
}

// ---------------------------------------------------------------------------
// The run-mode guard (ADR-030 Decision 2.1; acceptance 2)
// ---------------------------------------------------------------------------

/** The only run modes admission may run in. */
export const ADMISSION_RUN_MODES = Object.freeze(["PAPER", "BACKTEST"] as const);

/**
 * `undefined` when admission may run in `mode`; otherwise why not. ADR-030
 * Decision 2.1: "Admission runs only when the run mode is PAPER or BACKTEST.
 * In any other mode it refuses to start." TOTAL: anything that is not exactly
 * one of the two strings is refused, an unreadable value included.
 */
export function admissionRunModeProblem(mode: unknown): string | undefined {
  if (mode === "PAPER" || mode === "BACKTEST") return undefined;
  return (
    `series admission refuses to start in run mode ${typeof mode === "string" ? JSON.stringify(mode) : `(${typeof mode})`}: ` +
    "it runs only in PAPER or BACKTEST (ADR-030 Decision 2.1), and a new window is never " +
    'auto-approved for live trading (§9.2: "a new market pattern is not auto-approved for live trading")'
  );
}

// ---------------------------------------------------------------------------
// The admitted window's internal identity
// ---------------------------------------------------------------------------

/**
 * The `InternalMarketId` (§7.2: a UUIDv7) of an admitted window, DERIVED rather
 * than drawn, so a restarted gateway, a replay and the trader all name the
 * same window the same way:
 *
 * - the 48-bit timestamp is the window's scheduled open, in Unix milliseconds;
 * - the version nibble is 7 and the variant bits are `10` (RFC 9562);
 * - the remaining 74 bits are the first bits of
 *   sha256(`rollover-1/window-market-id/v1|` + conditionId).
 *
 * The condition id is the venue market's identity (§7.2), so one venue market
 * has one internal id however often it is seen. Undefined for an open outside
 * the 48-bit range. PURE.
 */
export function windowInternalMarketId(conditionId: string, scheduledOpenEpochMs: number): string | undefined {
  if (!Number.isSafeInteger(scheduledOpenEpochMs) || scheduledOpenEpochMs < 0 || scheduledOpenEpochMs >= 2 ** 48) {
    return undefined;
  }
  const digest = createHash("sha256").update(`rollover-1/window-market-id/v1|${conditionId}`, "utf8").digest();
  const bytes = new Uint8Array(16);
  let remaining = scheduledOpenEpochMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  for (let index = 6; index < 16; index += 1) bytes[index] = digest[index - 6] ?? 0;
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// The candidate window and the judge
// ---------------------------------------------------------------------------

/**
 * One numeric venue field as the door read it: absent, `null`, an exact
 * canonical decimal, or a value no exact decimal states.
 */
export type VenueDecimalReading =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "NULL" }
  | { readonly kind: "VALUE"; readonly value: string }
  | { readonly kind: "UNREADABLE"; readonly detail: string };

/** One boolean venue field: absent, `null`, a boolean, or something else. */
export type VenueBooleanReading = boolean | null | "ABSENT" | "UNREADABLE";

/** One string venue field: a string, or `null` for absent, null or another type. */
export type VenueStringReading = string | null;

/**
 * A window as the Gamma keyset read stated it (`GET /events/keyset`, S-D72):
 * one `Event` and the fields of its markets the judge reads. Assembled by
 * `@polymarket-bot/polymarket-public`'s door; every field is the venue's own,
 * unjudged.
 */
export interface GammaWindowEventReading {
  readonly eventId: VenueStringReading;
  readonly eventTitle: VenueStringReading;
  readonly eventSeriesSlug: VenueStringReading;
  /** `Event.series[].id`, each a string or `null` when unreadable. */
  readonly eventSeriesIds: readonly VenueStringReading[];
  readonly eventNegRisk: VenueBooleanReading;
  /** How many `markets` the event carries. */
  readonly marketCount: number;
  /** The event's FIRST market (the only one when `marketCount` is 1), or `null`. */
  readonly market: GammaWindowMarketReading | null;
}

export interface GammaWindowMarketReading {
  /** `Market.id`: the `{id}` of `GET /markets/{id}` (S-D34 `pathId`, an integer). */
  readonly marketId: VenueStringReading;
  readonly question: VenueStringReading;
  readonly conditionId: VenueStringReading;
  readonly description: VenueStringReading;
  readonly resolutionSource: VenueStringReading;
  /** The JSON-encoded `outcomes` string, verbatim (F-01). */
  readonly outcomes: VenueStringReading;
  /** The JSON-encoded `clobTokenIds` string, verbatim (F-01). */
  readonly clobTokenIds: VenueStringReading;
  readonly eventStartTime: VenueStringReading;
  readonly endDate: VenueStringReading;
  readonly orderPriceMinTickSize: VenueDecimalReading;
  readonly orderMinSize: VenueDecimalReading;
  readonly secondsDelay: VenueDecimalReading;
  readonly feesEnabled: VenueBooleanReading;
  readonly feeSchedule: {
    readonly rate: VenueDecimalReading;
    readonly exponent: VenueDecimalReading;
    readonly takerOnly: VenueBooleanReading;
    readonly rebateRate: VenueDecimalReading;
  } | null;
  readonly makerBaseFee: VenueDecimalReading;
  readonly takerBaseFee: VenueDecimalReading;
}

/**
 * The CLOB market-info read (`GET /clob-markets/{condition_id}`, S-D65) as the
 * door read it.
 */
export interface ClobMarketInfoReading {
  /** `t[]`: each token's id and outcome label, in the venue's order; `null` when unreadable. */
  readonly tokens: readonly { readonly tokenId: VenueStringReading; readonly outcome: VenueStringReading }[] | null;
  readonly minimumOrderSize: VenueDecimalReading;
  readonly minimumTickSize: VenueDecimalReading;
  readonly makerBaseFee: VenueDecimalReading;
  readonly takerBaseFee: VenueDecimalReading;
  /** `itode`, documented "omitted when false". */
  readonly takerOrderDelayEnabled: VenueBooleanReading;
  readonly fees: {
    readonly rate: VenueDecimalReading;
    readonly exponent: VenueDecimalReading;
    readonly takerOnly: VenueBooleanReading;
  } | null;
}

/** What an ADMITTED window is: the per-window facts, checked for presence and form. */
export interface AdmittedWindowFacts {
  readonly seriesId: string;
  readonly seriesConfigHash: string;
  readonly internalMarketId: string;
  readonly conditionId: string;
  readonly gammaEventId: string;
  readonly gammaMarketId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly scheduledOpenAt: string;
  readonly scheduledCloseAt: string;
  readonly scheduledOpenEpochMs: number;
  readonly scheduledCloseEpochMs: number;
  readonly tickSize: string;
  readonly windowTitle: string;
}

export type SeriesWindowVerdict =
  | { readonly verdict: "ADMIT"; readonly window: AdmittedWindowFacts }
  | {
      readonly verdict: "REFUSE";
      /** Every mismatch and every missing or malformed fact, each named. */
      readonly mismatches: readonly string[];
      /** The condition id when one was readable, for the incident's detail. */
      readonly conditionId: string | undefined;
      /** `true` when the schedule itself was ambiguous (the DST repeat, U-34). */
      readonly scheduleAmbiguous: boolean;
    };

function readingText(reading: VenueDecimalReading): string {
  switch (reading.kind) {
    case "ABSENT":
      return "absent";
    case "NULL":
      return "null";
    case "VALUE":
      return reading.value;
    case "UNREADABLE":
      return `unreadable (${reading.detail})`;
  }
}

function booleanText(reading: VenueBooleanReading): string {
  return reading === "ABSENT" ? "absent" : reading === "UNREADABLE" ? "unreadable" : String(reading);
}

function decimalEquals(reading: VenueDecimalReading, reviewed: string): boolean {
  return reading.kind === "VALUE" && reading.value === reviewed;
}

/** A JSON-encoded array of strings (`outcomes`, `clobTokenIds`), or `undefined`. */
function encodedStringArray(text: VenueStringReading): readonly string[] | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((element): element is string => typeof element === "string")) {
    return undefined;
  }
  return parsed;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * THE JUDGE. Admits a window only if it matches the reviewed pattern and every
 * reviewed parameter exactly, and every per-window fact is present and well
 * formed; otherwise refuses, naming EVERY mismatch (module header, the table).
 * TOTAL and pure: never throws, reads nothing but its arguments.
 */
export function judgeSeriesWindow(
  series: ReviewedSeries,
  configHash: string,
  event: GammaWindowEventReading,
  clob: ClobMarketInfoReading | undefined,
): SeriesWindowVerdict {
  const mismatches: string[] = [];
  const market = event.market;
  const conditionText = market?.conditionId ?? null;
  const conditionId = conditionText !== null && ConditionIdSchema.safeParse(conditionText).success ? conditionText : undefined;

  // --- the pattern ------------------------------------------------------------
  if (!event.eventSeriesIds.includes(series.venue.gammaSeriesId)) {
    mismatches.push(
      `pattern: Event.series[].id is ${JSON.stringify(event.eventSeriesIds)}, which does not include the reviewed ` +
        `series id ${JSON.stringify(series.venue.gammaSeriesId)}`,
    );
  }
  if (event.eventSeriesSlug !== series.venue.seriesSlug) {
    mismatches.push(
      `pattern: Event.seriesSlug is ${JSON.stringify(event.eventSeriesSlug)}, not the reviewed ${JSON.stringify(series.venue.seriesSlug)}`,
    );
  }
  if (event.marketCount !== 1 || market === null) {
    mismatches.push(`pattern: the event carries ${String(event.marketCount)} markets; a reviewed window is exactly one market`);
  }
  const eventId = event.eventId;
  if (eventId === null || eventId.length === 0) mismatches.push("fact: the event has no id");

  let schedule: ReturnType<typeof deriveWindowSchedule> | undefined;
  let scheduleAmbiguous = false;
  if (market !== null) {
    if (event.eventTitle === null || market.question !== event.eventTitle) {
      mismatches.push(
        `pattern: Market.question ${JSON.stringify(market.question)} is not the event title ${JSON.stringify(event.eventTitle)}`,
      );
    }
    schedule = deriveWindowSchedule(event.eventTitle, series.window, market.eventStartTime, market.endDate);
    if (!schedule.ok) {
      scheduleAmbiguous = schedule.ambiguous;
      for (const problem of schedule.problems) mismatches.push(`schedule: ${problem}`);
    }

    // --- the rules ----------------------------------------------------------
    if (market.description === null) {
      mismatches.push("rules: Market.description is absent; the rules text is part of the reviewed pattern");
    } else if (sha256Hex(market.description) !== series.rules.descriptionSha256) {
      mismatches.push(
        `rules: sha256(Market.description) is ${sha256Hex(market.description)}, not the reviewed ${series.rules.descriptionSha256}`,
      );
    }
    if (market.resolutionSource !== series.rules.resolutionSource) {
      mismatches.push(
        `rules: Market.resolutionSource is ${JSON.stringify(market.resolutionSource)}, not the reviewed ${JSON.stringify(series.rules.resolutionSource)}`,
      );
    }
  }

  // --- the outcomes and their tokens (F-01, F-03) -----------------------------
  const outcomes = market === null ? undefined : encodedStringArray(market.outcomes);
  if (outcomes === undefined || outcomes.length !== 2 || outcomes[0] !== series.outcomes[0] || outcomes[1] !== series.outcomes[1]) {
    mismatches.push(
      `pattern: Market.outcomes is ${JSON.stringify(market?.outcomes ?? null)}, not the reviewed labels in order ${JSON.stringify(series.outcomes)}`,
    );
  }
  const tokens = market === null ? undefined : encodedStringArray(market.clobTokenIds);
  let yesTokenId: string | undefined;
  let noTokenId: string | undefined;
  if (tokens === undefined || tokens.length !== 2) {
    mismatches.push(`fact: Market.clobTokenIds is ${JSON.stringify(market?.clobTokenIds ?? null)}, not a JSON array of exactly two token ids`);
  } else {
    const [first, second] = tokens;
    if (first === undefined || !TokenIdSchema.safeParse(first).success) mismatches.push(`fact: the index-0 token id ${JSON.stringify(first)} is not a canonical token id`);
    else yesTokenId = first;
    if (second === undefined || !TokenIdSchema.safeParse(second).success) mismatches.push(`fact: the index-1 token id ${JSON.stringify(second)} is not a canonical token id`);
    else noTokenId = second;
    if (first !== undefined && first === second) mismatches.push("fact: the two outcome tokens are the same token");
  }
  if (clob === undefined) {
    mismatches.push("fact: no CLOB market-info read for the window; the pairing, itode and the CLOB parameters cannot be judged");
  } else {
    const expected = [
      { tokenId: yesTokenId ?? null, outcome: series.outcomes[0] },
      { tokenId: noTokenId ?? null, outcome: series.outcomes[1] },
    ];
    const pairs = clob.tokens;
    if (
      pairs === null ||
      pairs.length !== 2 ||
      pairs.some((pair, index) => pair.tokenId !== expected[index]?.tokenId || pair.outcome !== expected[index]?.outcome)
    ) {
      mismatches.push(
        `pairing: CLOB t[] is ${JSON.stringify(pairs)}, not Gamma's index pairing ${JSON.stringify(expected)} (F-01, F-03)`,
      );
    }
  }

  // --- the reviewed parameters ------------------------------------------------
  const parameters = series.parameters;
  let tickSize: string | undefined;
  if (market !== null) {
    const tick = market.orderPriceMinTickSize;
    if (tick.kind !== "VALUE" || !parameters.allowedTickSizes.includes(tick.value)) {
      mismatches.push(
        `parameter: Gamma orderPriceMinTickSize is ${readingText(tick)}, not one of the reviewed tick sizes ${JSON.stringify(parameters.allowedTickSizes)}`,
      );
    } else {
      tickSize = tick.value;
    }
    if (!decimalEquals(market.orderMinSize, parameters.minimumOrderSize)) {
      mismatches.push(`parameter: Gamma orderMinSize is ${readingText(market.orderMinSize)}, not the reviewed ${parameters.minimumOrderSize}`);
    }
    const fees = parameters.fees;
    if (market.feesEnabled !== fees.feesEnabled) {
      mismatches.push(`parameter: Gamma feesEnabled is ${booleanText(market.feesEnabled)}, not the reviewed ${String(fees.feesEnabled)}`);
    }
    const schedule_ = market.feeSchedule;
    if (schedule_ === null) {
      mismatches.push("parameter: Gamma feeSchedule is absent or not an object");
    } else {
      if (!decimalEquals(schedule_.rate, fees.rate)) mismatches.push(`parameter: Gamma feeSchedule.rate is ${readingText(schedule_.rate)}, not the reviewed ${fees.rate}`);
      if (!decimalEquals(schedule_.exponent, fees.exponent)) mismatches.push(`parameter: Gamma feeSchedule.exponent is ${readingText(schedule_.exponent)}, not the reviewed ${fees.exponent}`);
      if (schedule_.takerOnly !== fees.takerOnly) mismatches.push(`parameter: Gamma feeSchedule.takerOnly is ${booleanText(schedule_.takerOnly)}, not the reviewed ${String(fees.takerOnly)}`);
      if (!decimalEquals(schedule_.rebateRate, fees.rebateRate)) mismatches.push(`parameter: Gamma feeSchedule.rebateRate is ${readingText(schedule_.rebateRate)}, not the reviewed ${fees.rebateRate}`);
    }
    if (!decimalEquals(market.makerBaseFee, fees.makerBaseFee)) mismatches.push(`parameter: Gamma makerBaseFee is ${readingText(market.makerBaseFee)}, not the reviewed ${fees.makerBaseFee}`);
    if (!decimalEquals(market.takerBaseFee, fees.takerBaseFee)) mismatches.push(`parameter: Gamma takerBaseFee is ${readingText(market.takerBaseFee)}, not the reviewed ${fees.takerBaseFee}`);
    const delay = parameters.tradingDelay.gammaSecondsDelay;
    const seconds = market.secondsDelay;
    const secondsMatch =
      delay === "NOT_STATED" ? seconds.kind === "ABSENT" || seconds.kind === "NULL" : decimalEquals(seconds, delay);
    if (!secondsMatch) {
      mismatches.push(`parameter: Gamma secondsDelay is ${readingText(seconds)}, not the reviewed ${delay === "NOT_STATED" ? "not-stated (absent or null)" : delay}`);
    }
  }
  if (event.eventNegRisk !== parameters.negRisk) {
    mismatches.push(`parameter: Gamma Event.negRisk is ${booleanText(event.eventNegRisk)}, not the reviewed ${String(parameters.negRisk)}`);
  }
  if (clob !== undefined) {
    if (tickSize !== undefined && !decimalEquals(clob.minimumTickSize, tickSize)) {
      mismatches.push(`parameter: CLOB mts is ${readingText(clob.minimumTickSize)}, but Gamma states tick size ${tickSize}; the venue's facts disagree`);
    }
    if (!decimalEquals(clob.minimumOrderSize, parameters.minimumOrderSize)) {
      mismatches.push(`parameter: CLOB mos is ${readingText(clob.minimumOrderSize)}, not the reviewed ${parameters.minimumOrderSize}`);
    }
    const fees = parameters.fees;
    if (!decimalEquals(clob.makerBaseFee, fees.makerBaseFee)) mismatches.push(`parameter: CLOB mbf is ${readingText(clob.makerBaseFee)}, not the reviewed ${fees.makerBaseFee}`);
    if (!decimalEquals(clob.takerBaseFee, fees.takerBaseFee)) mismatches.push(`parameter: CLOB tbf is ${readingText(clob.takerBaseFee)}, not the reviewed ${fees.takerBaseFee}`);
    if (clob.fees === null) {
      mismatches.push("parameter: CLOB fd is absent or not an object");
    } else {
      if (!decimalEquals(clob.fees.rate, fees.rate)) mismatches.push(`parameter: CLOB fd.r is ${readingText(clob.fees.rate)}, not the reviewed ${fees.rate}`);
      if (!decimalEquals(clob.fees.exponent, fees.exponent)) mismatches.push(`parameter: CLOB fd.e is ${readingText(clob.fees.exponent)}, not the reviewed ${fees.exponent}`);
      if (clob.fees.takerOnly !== fees.takerOnly) mismatches.push(`parameter: CLOB fd.to is ${booleanText(clob.fees.takerOnly)}, not the reviewed ${String(fees.takerOnly)}`);
    }
    // `itode` is "omitted when false" (S-D65 lines 125-130): ABSENT reads as false.
    const itode = clob.takerOrderDelayEnabled === "ABSENT" ? false : clob.takerOrderDelayEnabled;
    if (itode !== parameters.tradingDelay.takerOrderDelayEnabled) {
      mismatches.push(
        `parameter: CLOB itode is ${booleanText(clob.takerOrderDelayEnabled)}, not the reviewed ${String(parameters.tradingDelay.takerOrderDelayEnabled)}`,
      );
    }
  }

  // --- per-window facts: presence and form only -------------------------------
  if (conditionId === undefined) mismatches.push(`fact: Market.conditionId ${JSON.stringify(conditionText)} is absent or malformed`);
  const gammaMarketId = market?.marketId ?? null;
  if (gammaMarketId === null || !/^[1-9][0-9]{0,18}$/u.test(gammaMarketId)) {
    mismatches.push(`fact: Market.id ${JSON.stringify(gammaMarketId)} is not the integer id GET /markets/{id} takes (S-D34)`);
  }

  if (
    mismatches.length > 0 ||
    schedule === undefined ||
    !schedule.ok ||
    conditionId === undefined ||
    yesTokenId === undefined ||
    noTokenId === undefined ||
    tickSize === undefined ||
    gammaMarketId === null ||
    eventId === null ||
    event.eventTitle === null
  ) {
    return {
      verdict: "REFUSE",
      mismatches: mismatches.length > 0 ? mismatches : ["the window's facts are incomplete"],
      conditionId,
      scheduleAmbiguous,
    };
  }
  const internalMarketId = windowInternalMarketId(conditionId, schedule.openEpochMs);
  if (internalMarketId === undefined) {
    return { verdict: "REFUSE", mismatches: ["fact: the scheduled open is outside the identity's range"], conditionId, scheduleAmbiguous: false };
  }
  return {
    verdict: "ADMIT",
    window: {
      seriesId: series.seriesId,
      seriesConfigHash: configHash,
      internalMarketId,
      conditionId,
      gammaEventId: eventId,
      gammaMarketId,
      yesTokenId,
      noTokenId,
      scheduledOpenAt: schedule.openAt,
      scheduledCloseAt: schedule.closeAt,
      scheduledOpenEpochMs: schedule.openEpochMs,
      scheduledCloseEpochMs: schedule.closeEpochMs,
      tickSize,
      windowTitle: event.eventTitle,
    },
  };
}
