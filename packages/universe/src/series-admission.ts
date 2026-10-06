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
 *   1.2, as ADR-030 Amendment 2 rule 1 item 5 amends it): the outcome trading
 *   ids, selected by the window's `version` ({@link selectTradingIds}), the
 *   condition id, and the open and close times. They are compared with no
 *   reviewed value; the close must follow the open. The version itself is
 *   checked against the review (`parameters.acceptedProtocolVersions`,
 *   Amendment 2 rule 2).
 * - **Fail closed** (Decision 1.5): a fact that is absent, unreadable or
 *   unclear refuses the window.
 * - **Not yet admissible** (`V2-3` item 7; ADR-030 Amendment 2 rule 1, note
 *   of 2026-10-06, the orchestrator's interim ruling for PAPER and BACKTEST):
 *   a window that matches in every respect but one — its accepted `version`
 *   selects an id field that is absent or `null` ("the IDs are not yet
 *   available", F-40) — is neither admitted nor refused:
 *   {@link judgeSeriesWindow} answers `NOT_YET_ADMISSIBLE` with its scheduled
 *   open, and the caller judges it again, refusing it finally at or after that
 *   open. Every other refusal stays final.
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
 * `docs/venue/verified-2026-10-04.md` (VENUE-SETL-1), the Gamma / CLOB
 * OpenAPI files that report fetched (S-O01, S-O02, S-D65), or
 * `docs/venue/verified-2026-10-05.md` (VENUE-4; the Protocol V2 rows) — with
 * the one refusal-only exception below:
 *
 * | judged | venue field | documented by |
 * | --- | --- | --- |
 * | series membership | Gamma `Event.series[].id`, `Event.seriesSlug` | S-D70 lines 345-348, 393-395; `Series.id` a string (F-08) |
 * | one market per event | `Event.markets` | S-D72 (`KeysetEventsResponse` "Always includes … Markets") |
 * | the title and question | `Event.title`, `Market.question` | Gamma OpenAPI (S-O01) `Event.title`, `Market.question` |
 * | the schedule | the title's ET range; `Market.eventStartTime`, `Market.endDate` as locators | F-14 … F-16, U-29, U-34; `./series-window-schedule.ts` |
 * | the rules | `Market.description`, `Market.resolutionSource` | S-O01; F-22 (the rules text and its digest) |
 * | the protocol version | Gamma `Market.version`: `"v1"` or `"v2"`, else refused; it must be one of the review's `acceptedProtocolVersions` | `docs/venue/verified-2026-10-05.md` F-38, F-39, F-40, F-41; ADR-030 Amendment 2 rules 1 and 2 |
 * | outcomes and pairing | `Market.outcomes` ↔ the trading ids `Market.version` selects, BY INDEX, index 0 the YES outcome: `positionIds` (an array of decimal strings) for `"v2"`, the decoded `clobTokenIds` (a JSON-encoded array) for `"v1"`, "even when both fields are present"; cross-checked against CLOB `t[].{t,o}` | F-01 (S-D23 lines 159, 173), F-03 (S-D65 lines 97-101, 157-169); F-38, F-40 (index 0 is YES); O.3 (`t[].t` carries a V2 market's position ids) |
 * | the condition id | Gamma `Market.conditionId`, kept as Gamma serves it (the window's identity); the CLOB read sends its 32-byte form ({@link paddedConditionId}) | F-43, F-70, C-19; ADR-030 Amendment 2 rule 3 |
 * | tick size | Gamma `orderPriceMinTickSize`, CLOB `mts` | S-O01; S-D65 `mts`; F-21 (per-window data) |
 * | minimum size | Gamma `orderMinSize`, CLOB `mos` | S-O01; S-D65 `mos` |
 * | negRisk | Gamma `Market.negRisk` (the authority); Gamma `Event.negRisk` (a cross-check: it must agree) | S-D23 line 305 ("`negRisk` … Market belongs to a negative-risk group", read "from the Gamma response") and lines 313-315 ("Negative-risk membership is a market-level property, but augmented negative risk is configured on the event"); S-O01 `Event.negRisk`. The S-O01 `Market` schema omits the field and the CLOB (S-D65) documents none; `ROLLOVER-1` r5, R5-ASTRA-01 |
 * | fees | Gamma `feesEnabled`, `feeSchedule.{rate, exponent, takerOnly, rebateRate}`, `makerBaseFee`, `takerBaseFee`; CLOB `fd.{r, e, to}`, `mbf`, `tbf` | S-O01; S-D65 |
 * | trading delay | CLOB `itode` ("omitted when false"); Gamma `secondsDelay` | F-18, F-19 (S-D65 lines 125-130; S-D23 line 877) |
 *
 * Never read: `startDate` (not the open, F-15), `markets-by-token`'s
 * primary/secondary tokens (C-17), the `new_market` arrays (F-13),
 * `series_slug` (U-30), the field `Market.version` does NOT select (never read
 * as an id, Amendment 2 rule 1 item 2), and every field the documents do not
 * name (`feeType`, `cryptoMarketConfig`, `eventMetadata`, the CLOB `ao`, `aot`,
 * `c`). The delay's LENGTH is not judged: two official pages disagree on it
 * (C-16); the per-market fact is `itode`.
 *
 * **One UNDOCUMENTED field is read, and it can only refuse:** the CLOB's `v`
 * (C-21; O.3 observed `"v1"` and `"v2"`). It is never an authority and never
 * admits a window (ADR-030 Amendment 2 rule 1 item 7, refining Decision 1.7):
 * a present `v` that is not Gamma's `version` refuses the window; an absent
 * `v` refuses nothing. The CLOB's `c` stays unread, so no CLOB answer's
 * condition id is compared with anything (rule 3 item 5).
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
 * The protocol versions a Gamma market may state (`docs/venue/verified-2026-10-05.md`
 * F-38: `"v2"` selects `positionIds`, `"v1"` selects `clobTokenIds`; F-39/F-40:
 * any other value is unsupported). ADR-030 Amendment 2 rule 1.
 */
export const PROTOCOL_VERSIONS = Object.freeze(["v1", "v2"] as const);
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];

/** What an operator must state, and the refusal of a review that does not state it. */
export const ACCEPTED_PROTOCOL_VERSIONS_REQUIRED =
  'acceptedProtocolVersions is required: a non-empty list of distinct protocol versions, each "v1" or "v2" ' +
  '(ADR-030 Amendment 2 rule 2; e.g. ["v1"], or ["v1","v2"] once a review accepts V2 windows). It is never inferred';

/**
 * `parameters.acceptedProtocolVersions` (ADR-030 Amendment 2 rule 2): the
 * versions a window may carry, a REVIEWED parameter like `allowedTickSizes`.
 * Required — a review written before the field existed is REFUSED at parse,
 * never read as some default (rule 2 item 1: "The gateway never infers it").
 * Distinctness is checked by index, not by iteration: the trader's mirror runs
 * this rule through a prototype-free parsing arena, whose empty array has no
 * iterator (`@polymarket-bot/trading-core` `series.ts`).
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
     * The Gamma `Market.version` values the review accepts (ADR-030 Amendment
     * 2 rule 2). A window whose version is not listed is refused. Part of the
     * review, so part of {@link seriesConfigHash}: only a review that changes
     * the list changes the hash — the venue moving the series from `"v1"` to
     * `"v2"` changes none (rule 2 item 3).
     */
    acceptedProtocolVersions: AcceptedProtocolVersions,
    /**
     * The tick sizes the review accepts. Tick size is PER-WINDOW data — the
     * venue changes it near the price limits (F-21; ruling Q3) — so the review
     * states the values it accepts, checked at admission, never one constant.
     */
    allowedTickSizes: z.array(PositiveDecimalStringSchema).min(1).max(8),
    /** Gamma `orderMinSize` and CLOB `mos` (observed 5). */
    minimumOrderSize: PositiveDecimalStringSchema,
    /**
     * The market's negative-risk membership: Gamma `Market.negRisk`, a
     * market-level property (S-D23 lines 305, 313-315). Gamma `Event.negRisk`
     * (S-O01) must state the same value.
     *
     * `ROLLOVER-1` r7 (R6-FABLE-01): ONLY `false` is reviewable. S-D23 makes
     * augmented negative risk (`Event.enableNegRisk`, `Event.negRiskAugmented`;
     * "Identify Augmented Negative Risk", lines 311-367) relevant exactly when
     * a market's `negRisk` is true, and nothing here reads or judges it. A
     * review stating `true` would admit a window whatever its augmentation, so
     * it is refused at parse — on both sides, before any hash is pinned —
     * until the review states and the door reads augmentation (r5 follow_up 2).
     */
    negRisk: z.literal(false),
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
  /**
   * The cap on concurrently admitted windows (ADR-030 Decision 1.8). Every
   * live window counts, one awaiting its resolution past
   * `unresolvedTeardownSeconds` included (`ROLLOVER-1` r2, R2-ASTRA-01): at
   * the cap, admissions are deferred; no live window is evicted for room.
   */
  maximumConcurrentWindows: z.number().int().min(1).max(64),
  /**
   * How long after its scheduled close a window may stay unresolved before it
   * is reported (resolution is observed 53 to 152 s after the close, F-17, so
   * this bound only marks a resolution missed or never made). One reviewed
   * value, so the gateway and every trader agree on it. ADR-030 Decision 4.4
   * (a window is torn down "after its resolution is handled"): past it, the
   * gateway keeps the window ADMITTED and subscribed, AWAITING its
   * resolution, in its cap slot, and names it in a NOTIFY incident; a trader
   * tears it down only if it holds no inventory and no work (`ROLLOVER-1` r1
   * deviation 2, for ratification); one that holds inventory stays, in its
   * cap slot, until its resolution is handled (`ROLLOVER-1` r2). It is also
   * the earliest instant at which the gateway applies an operator's named
   * retirement of a window whose resolution it never observed (`ROLLOVER-1`
   * r3, R3-FABLE-01; `apps/data-gateway` `seriesAdmission.operatorRetirements`).
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
 * One venue field whose absence, `null` and wrong type are each REPORTED, never
 * defaulted (ADR-030 Amendment 2 rule 1 item 3 refuses each by name).
 */
export type VenueFieldReading<T> =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "NULL" }
  | { readonly kind: "VALUE"; readonly value: T }
  | { readonly kind: "UNREADABLE"; readonly detail: string };

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
  /** `Event.negRisk` (S-O01): a cross-check of the market's own flag, which is the authority. */
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
  /**
   * `Market.version` (F-41: a nullable string), as stated. It selects the
   * trading ids (F-38); a missing, `null` or unsupported one is refused (F-39,
   * F-40).
   */
  readonly version: VenueFieldReading<string>;
  /**
   * The JSON-encoded `clobTokenIds` string, verbatim (F-01): the trading ids
   * when `version` is `"v1"` (F-38), and never read as ids otherwise.
   */
  readonly clobTokenIds: VenueStringReading;
  /**
   * `Market.positionIds` (F-41: a nullable array of strings), as stated: the
   * trading ids when `version` is `"v2"` (F-38), and never read as ids
   * otherwise. Each element is the string, or `null` when it is not one.
   */
  readonly positionIds: VenueFieldReading<readonly VenueStringReading[]>;
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
  /**
   * `Market.negRisk`, the market's own negative-risk membership (S-D23 lines
   * 305, 313-315): absent, `null` or unreadable as stated, never defaulted.
   */
  readonly negRisk: VenueBooleanReading;
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
  /**
   * `v`: **UNDOCUMENTED** (C-21; observed `"v1"` and `"v2"`, O.3). A
   * refusal-only cross-check of Gamma's `Market.version`, never an authority
   * (ADR-030 Amendment 2 rule 1 item 7): present and different refuses the
   * window; absent refuses nothing.
   */
  readonly undocumentedProtocolVersion: VenueFieldReading<string>;
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
    }
  | {
      /**
       * `V2-3` item 7 (ADR-030 Amendment 2 rule 1, note of 2026-10-06): the
       * window matches in every respect but one — its accepted `version`
       * selects an id field that is absent or `null` ("the IDs are not yet
       * available", F-40). It is not admitted, and it is not refused: the
       * caller judges it again later, and refuses it finally (with these
       * mismatches) if it is still so at or after `scheduledOpenEpochMs`.
       */
      readonly verdict: "NOT_YET_ADMISSIBLE";
      /** What a final refusal names: the unavailable ids, and the CLOB pairing they leave unjudgeable. */
      readonly mismatches: readonly string[];
      readonly conditionId: string;
      readonly scheduledOpenAt: string;
      readonly scheduledOpenEpochMs: number;
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

function fieldText(reading: VenueFieldReading<unknown>): string {
  switch (reading.kind) {
    case "ABSENT":
      return "absent";
    case "NULL":
      return "null";
    case "VALUE":
      return JSON.stringify(reading.value);
    case "UNREADABLE":
      return `not of its documented type (${reading.detail})`;
  }
}

// ---------------------------------------------------------------------------
// The trading ids, selected by the window's version (ADR-030 Amendment 2, rule 1)
// ---------------------------------------------------------------------------

/** Whether `value` is one of {@link PROTOCOL_VERSIONS} — exactly, case included. */
export function isProtocolVersion(value: unknown): value is ProtocolVersion {
  return value === "v1" || value === "v2";
}

export type TradingIdSelection =
  | {
      readonly ok: true;
      readonly version: ProtocolVersion;
      /** The field the version selected: `positionIds` for `"v2"`, `clobTokenIds` for `"v1"`. */
      readonly field: "positionIds" | "clobTokenIds";
      /** Index 0 (the YES outcome, F-40). */
      readonly yesTokenId: string;
      /** Index 1 (the NO outcome). */
      readonly noTokenId: string;
    }
  | {
      readonly ok: false;
      /** The window's version when it is a supported one, else `undefined`. */
      readonly version: ProtocolVersion | undefined;
      /** Every reason the ids could not be selected, each named. */
      readonly problems: readonly string[];
      /**
       * `V2-3` item 7: `true` exactly when the version is supported and the
       * field it selects is absent or `null` — "the IDs are not yet
       * available" (F-40). For `"v1"` the series-window door reads
       * `clobTokenIds` as a string or `null`, and its `null` also covers a
       * value of another type (`@polymarket-bot/polymarket-public`
       * `series-window/door.ts`, `stringOf`).
       */
      readonly idsNotYetAvailable: boolean;
    };

/**
 * THE SELECTION (ADR-030 Amendment 2 rule 1; F-38-F-40): a window's trading
 * ids come from the field its Gamma `Market.version` selects —
 * `"v2"`: `positionIds`, an array of decimal strings; `"v1"`: `clobTokenIds`,
 * a JSON-encoded array of decimal strings, decoded first — "even when both
 * fields are present". Presence never selects the protocol, and the other
 * field is never read as an id. Index 0 is YES, index 1 is NO.
 *
 * Refused, each by name: a missing, `null` or unsupported version (any value
 * but exactly `"v1"` or `"v2"`); a selected field that is absent or `null`
 * ("the IDs are not yet available", F-40) or of another type; not exactly two
 * ids; an id that is not a canonical decimal string (`TokenIdSchema`; F-39);
 * two equal ids. The outcomes are judged by {@link judgeSeriesWindow}. A
 * failure whose only reason is a selected field absent or `null` says so
 * (`idsNotYetAvailable`; `V2-3` item 7), and the judge then answers
 * `NOT_YET_ADMISSIBLE` rather than refusing. TOTAL and pure.
 */
export function selectTradingIds(market: GammaWindowMarketReading): TradingIdSelection {
  const version = market.version;
  if (version.kind !== "VALUE") {
    return {
      ok: false,
      version: undefined,
      problems: [
        `fact: Market.version is ${fieldText(version)}; the trading ids are chosen by the version, and a missing version is refused (F-38, F-39)`,
      ],
      idsNotYetAvailable: false,
    };
  }
  if (!isProtocolVersion(version.value)) {
    return {
      ok: false,
      version: undefined,
      problems: [
        `fact: Market.version is ${JSON.stringify(version.value)}, not a supported protocol version ("v1" or "v2"); an unsupported version is refused (F-39, F-40)`,
      ],
      idsNotYetAvailable: false,
    };
  }
  if (version.value === "v2") return selectedPair("v2", "positionIds", positionIdsOf(market.positionIds));
  return selectedPair("v1", "clobTokenIds", clobTokenIdsOf(market.clobTokenIds));
}

/**
 * The selected field, read: its ids, or why not — and whether the "why not"
 * is that the field is absent or `null`, the ids not yet available (F-40;
 * `V2-3` item 7).
 */
type SelectedField =
  | { readonly ok: true; readonly ids: readonly VenueStringReading[] }
  | { readonly ok: false; readonly problem: string; readonly notYetAvailable: boolean };

function positionIdsOf(reading: GammaWindowMarketReading["positionIds"]): SelectedField {
  switch (reading.kind) {
    case "ABSENT":
    case "NULL":
      return {
        ok: false,
        problem: `fact: Market.positionIds, the field Market.version "v2" selects, is ${fieldText(reading)}: the window's ids are not yet available (F-40)`,
        notYetAvailable: true,
      };
    case "UNREADABLE":
      return {
        ok: false,
        problem: `fact: Market.positionIds, the field Market.version "v2" selects, is not an array of decimal strings (${reading.detail}; F-38, F-41)`,
        notYetAvailable: false,
      };
    case "VALUE":
      if (reading.value.length !== 2) {
        return { ok: false, problem: `fact: Market.positionIds is ${JSON.stringify(reading.value)}, not exactly two position ids`, notYetAvailable: false };
      }
      return { ok: true, ids: reading.value };
  }
}

function clobTokenIdsOf(text: VenueStringReading): SelectedField {
  if (text === null) {
    return {
      ok: false,
      problem:
        'fact: Market.clobTokenIds, the field Market.version "v1" selects, is absent, null or not a string: the window\'s ids are not yet available (F-40)',
      notYetAvailable: true,
    };
  }
  const decoded = encodedStringArray(text);
  if (decoded === undefined || decoded.length !== 2) {
    return { ok: false, problem: `fact: Market.clobTokenIds is ${JSON.stringify(text)}, not a JSON array of exactly two token ids`, notYetAvailable: false };
  }
  return { ok: true, ids: decoded };
}

function selectedPair(
  version: ProtocolVersion,
  field: "positionIds" | "clobTokenIds",
  selected: SelectedField,
): TradingIdSelection {
  if (!selected.ok) return { ok: false, version, problems: [selected.problem], idsNotYetAvailable: selected.notYetAvailable };
  const what = field === "positionIds" ? "position id" : "token id";
  const problems: string[] = [];
  const [first, second] = selected.ids;
  const yes = first !== undefined && first !== null && TokenIdSchema.safeParse(first).success ? first : undefined;
  const no = second !== undefined && second !== null && TokenIdSchema.safeParse(second).success ? second : undefined;
  if (yes === undefined) problems.push(`fact: the index-0 ${what} ${JSON.stringify(first ?? null)} is not a canonical token id`);
  if (no === undefined) problems.push(`fact: the index-1 ${what} ${JSON.stringify(second ?? null)} is not a canonical token id`);
  if (first !== undefined && first !== null && first === second) {
    problems.push(field === "positionIds" ? "fact: the two position ids are the same id" : "fact: the two outcome tokens are the same token");
  }
  if (problems.length > 0 || yes === undefined || no === undefined) return { ok: false, version, problems, idsNotYetAvailable: false };
  return { ok: true, version, field, yesTokenId: yes, noTokenId: no };
}

// ---------------------------------------------------------------------------
// The condition id at the CLOB and Data API boundary (ADR-030 Amendment 2, rule 3)
// ---------------------------------------------------------------------------

const CONDITION_ID_31_BYTES = /^0x[0-9a-fA-F]{62}$/u;
const CONDITION_ID_32_BYTES = /^0x[0-9a-fA-F]{64}$/u;

/**
 * The form of a window's condition id that a condition-keyed CLOB or Data API
 * read sends (ADR-030 Amendment 2 rule 3; F-43: "Compatibility boundaries that
 * accept or return `bytes32` use the same values right-padded with zero
 * bytes"; F-70 and C-19: `/clob-markets` answers the 31-byte form with 404):
 *
 * - a 31-byte id (`0x` and 62 hex digits) is right-padded with one zero byte;
 * - a 32-byte id (`0x` and 64 hex digits) is sent unchanged;
 * - any other text is refused, and the caller makes no read.
 *
 * Gamma's text stays the window's identity ({@link windowInternalMarketId},
 * the events, the ledger); this form exists only at the read. PURE.
 */
export function paddedConditionId(
  conditionId: string,
): { readonly ok: true; readonly conditionId: string; readonly padded: boolean } | { readonly ok: false; readonly problem: string } {
  if (CONDITION_ID_31_BYTES.test(conditionId)) return { ok: true, conditionId: `${conditionId}00`, padded: true };
  if (CONDITION_ID_32_BYTES.test(conditionId)) return { ok: true, conditionId, padded: false };
  return {
    ok: false,
    problem:
      `the condition id ${JSON.stringify(conditionId)} is neither 31 bytes (0x and 62 hex digits) nor 32 bytes (0x and 64 hex digits), ` +
      "so no CLOB or Data API read is made for it (ADR-030 Amendment 2 rule 3; F-43)",
  };
}

/**
 * THE JUDGE. Admits a window only if it matches the reviewed pattern and every
 * reviewed parameter exactly, and every per-window fact is present and well
 * formed; otherwise refuses, naming EVERY mismatch (module header, the table).
 *
 * `V2-3` item 7 (ADR-030 Amendment 2 rule 1, note of 2026-10-06): when the
 * ONLY reason a window would be refused is that its accepted `version` selects
 * an id field that is absent or `null` — that selection problem, and the CLOB
 * pairing it leaves unjudgeable (`t[]` two tokens labelled with the reviewed
 * outcomes in order, its ids not comparable with ids not yet given) — the
 * verdict is `NOT_YET_ADMISSIBLE`, carrying the mismatches a final refusal
 * names and the window's scheduled open. Any other mismatch beside it, or a
 * window whose derived id cannot be formed, is a `REFUSE` exactly as before.
 *
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
  // The trading ids, selected by `Market.version` (ADR-030 Amendment 2 rule 1),
  // and the version checked against the review (rule 2).
  let yesTokenId: string | undefined;
  let noTokenId: string | undefined;
  let version: ProtocolVersion | undefined;
  /** `V2-3` item 7: the mismatches that only say the ids are not yet available. */
  const notYetAvailable = new Set<string>();
  if (market === null) {
    mismatches.push("fact: Market.clobTokenIds is null, not a JSON array of exactly two token ids");
  } else {
    const selection = selectTradingIds(market);
    version = selection.version;
    if (selection.ok) {
      yesTokenId = selection.yesTokenId;
      noTokenId = selection.noTokenId;
    } else {
      for (const problem of selection.problems) {
        mismatches.push(problem);
        if (selection.idsNotYetAvailable) notYetAvailable.add(problem);
      }
    }
    const accepted: readonly string[] = series.parameters.acceptedProtocolVersions;
    if (version !== undefined && !accepted.includes(version)) {
      mismatches.push(
        `parameter: Market.version is ${JSON.stringify(version)}, not one of the reviewed acceptedProtocolVersions ` +
          `${JSON.stringify(accepted)}: a series admits a protocol version only after a review accepts it (ADR-030 Amendment 2 rule 2)`,
      );
    }
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
      const pairing = `pairing: CLOB t[] is ${JSON.stringify(pairs)}, not Gamma's index pairing ${JSON.stringify(expected)} (F-01, F-03)`;
      mismatches.push(pairing);
      // `V2-3` item 7: with no Gamma ids yet, the pairing's ids cannot be
      // compared; its labels can, and a label mismatch stays a refusal.
      if (
        notYetAvailable.size > 0 &&
        pairs !== null &&
        pairs.length === 2 &&
        pairs.every((pair, index) => pair.outcome === expected[index]?.outcome)
      ) {
        notYetAvailable.add(pairing);
      }
    }
    // The UNDOCUMENTED CLOB `v` (C-21) can only REFUSE (ADR-030 Amendment 2
    // rule 1 item 7): present and not exactly Gamma's version — `null` and a
    // non-string included — refuses; absent refuses nothing. It never stands
    // in for a missing Gamma version, so it can never admit a window.
    const crossCheck = clob.undocumentedProtocolVersion;
    if (crossCheck.kind !== "ABSENT") {
      const gamma = market?.version ?? ({ kind: "ABSENT" } as const);
      if (crossCheck.kind !== "VALUE" || gamma.kind !== "VALUE" || crossCheck.value !== gamma.value) {
        mismatches.push(
          `cross-check: CLOB v (undocumented, C-21) is ${fieldText(crossCheck)}, but Gamma Market.version is ${fieldText(gamma)}; ` +
            "the venue's facts disagree (ADR-030 Amendment 2 rule 1 item 7)",
        );
      }
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
    // Negative-risk membership is a MARKET-level property (S-D23 lines 305,
    // 313-315): the market's own flag must be exactly the reviewed boolean.
    // Absent, `null` or unreadable is refused (Decision 1.5); neither the
    // event's flag nor the reviewed value ever stands in for it (`ROLLOVER-1`
    // r5, R5-ASTRA-01).
    if (market.negRisk !== parameters.negRisk) {
      mismatches.push(
        `parameter: Gamma Market.negRisk is ${booleanText(market.negRisk)}, not the reviewed ${String(parameters.negRisk)} ` +
          "(negative-risk membership is a market-level property, S-D23)",
      );
    }
  }
  // The event's flag (S-O01 `Event.negRisk`) is a cross-check: it, too, must be
  // exactly the reviewed boolean. As both flags are held to the same value, an
  // event that contradicts its market is always refused.
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
  else {
    // ADR-030 Amendment 2 rule 3: only a width the CLOB and the Data API can
    // be asked by — 31 bytes, sent padded, or 32 — is a well-formed fact.
    const venueForm = paddedConditionId(conditionId);
    if (!venueForm.ok) mismatches.push(`fact: Market.conditionId: ${venueForm.problem}`);
  }
  const gammaMarketId = market?.marketId ?? null;
  if (gammaMarketId === null || !/^[1-9][0-9]{0,18}$/u.test(gammaMarketId)) {
    mismatches.push(`fact: Market.id ${JSON.stringify(gammaMarketId)} is not the integer id GET /markets/{id} takes (S-D34)`);
  }

  // `V2-3` item 7: refused ONLY because the ids are not yet available — the
  // version supported and accepted, the schedule and the identity derivable.
  if (
    notYetAvailable.size > 0 &&
    mismatches.every((mismatch) => notYetAvailable.has(mismatch)) &&
    version !== undefined &&
    series.parameters.acceptedProtocolVersions.includes(version) &&
    schedule?.ok === true &&
    conditionId !== undefined &&
    windowInternalMarketId(conditionId, schedule.openEpochMs) !== undefined
  ) {
    return {
      verdict: "NOT_YET_ADMISSIBLE",
      mismatches,
      conditionId,
      scheduledOpenAt: schedule.openAt,
      scheduledOpenEpochMs: schedule.openEpochMs,
    };
  }
  if (
    mismatches.length > 0 ||
    schedule === undefined ||
    !schedule.ok ||
    conditionId === undefined ||
    version === undefined ||
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
