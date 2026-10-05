/**
 * THE SERIES-WINDOW DOOR (`ROLLOVER-1`): read a Gamma `GET /events/keyset`
 * body and a CLOB `GET /clob-markets/{condition_id}` body into the plain
 * readings `@polymarket-bot/universe`'s admission judge consumes — reading
 * ONLY documented fields, and judging nothing.
 *
 * ## What is read, and why only that (ADR-030 Decision 1.7; acceptance 4)
 *
 * The table of fields and their sources is `@polymarket-bot/universe`'s
 * `series-admission.ts` header; this door reads exactly those and no other:
 *
 * - from each `Event` (Gamma OpenAPI S-O01; S-D70/S-D72): `id`, `title`,
 *   `seriesSlug`, `series[].id`, `negRisk` (S-O01 `Event.negRisk`: a
 *   cross-check only, see below), and `markets`;
 * - from its market: `id`, `question`, `conditionId`, `description`,
 *   `resolutionSource`, `outcomes`, `clobTokenIds`, `eventStartTime`,
 *   `endDate`, `orderPriceMinTickSize`, `orderMinSize`, `secondsDelay`,
 *   `feesEnabled`, `feeSchedule.{rate, exponent, takerOnly, rebateRate}`,
 *   `makerBaseFee`, `takerBaseFee`, and `negRisk`;
 * - **`negRisk` is read from the MARKET** (`ROLLOVER-1` r5, R5-ASTRA-01):
 *   the official market-details page S-D23 (sha256 `930dd605…`) lists
 *   `negRisk` among the fields read "from the Gamma response" for a market,
 *   "Market belongs to a negative-risk group" (line 305), and says
 *   "Negative-risk membership is a market-level property, but augmented
 *   negative risk is configured on the event" (lines 313-315). The S-O01
 *   OpenAPI `Market` schema omits the field, and the CLOB `ClobMarketDetails`
 *   (S-D65) documents none; the recorded keyset body carries
 *   `markets[].negRisk` on every event (S-G03). Before r5 only the event's
 *   flag was read, so a market whose own flag differed was never seen;
 * - from `KeysetEventsResponse`: `events`, `next_cursor` (S-D72 lines 295-300);
 * - from `ClobMarketDetails` (S-D65): `t[].{t, o}`, `mos`, `mts`, `mbf`,
 *   `tbf`, `itode`, `fd.{r, e, to}`.
 *
 * Every other key — `startDate` (not the open, F-15), `feeType`,
 * `cryptoMarketConfig`, `eventMetadata` (U-32), the event's `enableNegRisk`
 * and `negRiskAugmented` and the market's `negRiskOther` (augmented negative
 * risk, which S-D23 places on the event, is not a reviewed parameter), the
 * CLOB `c`, `ao`, `aot`, `v` — is left in the journaled raw body and read by
 * nothing.
 *
 * ## A reading is not a verdict
 *
 * A field that is absent, `null` or of an unexpected type is REPORTED as such
 * (`ABSENT`, `NULL`, `UNREADABLE`, or `null` for a string), never defaulted:
 * the judge refuses a window whose facts are missing or unclear (ADR-030
 * Decision 1.5). A JSON number is read as its exact decimal text
 * (`normalizeVenueDecimal`: `String(number)`; an exponent form is refused, so a
 * float's rounding cannot enter an economic value), so `0.07` reads `"0.07"`
 * and `5` reads `"5"`.
 *
 * ## What this door performs (`docs/contracts/schema-boundary.md` §4)
 *
 * - **D1** — the body is parsed inside containment and rebuilt prototype-free
 *   by `../venue/wire-door.ts`'s `readOwnWireValue` before any read; an
 *   accessor is refused, never invoked.
 * - **D2** — not applicable: there is no library parse; every judgement is
 *   this door's own reads of the materialized tree.
 * - **D3/D4** — every value is read from the materialized tree by own-property
 *   access, and every reading is emitted frozen.
 * - **TOTAL** — never throws: an unreadable body is `{ status: "invalid" }`.
 */

import { normalizeVenueDecimal } from "../normalize/values.js";
import { isOwnWireRecord, readOwnWireValue, type OwnWireRecord } from "../venue/wire-door.js";

/** A numeric venue field: absent, `null`, an exact canonical decimal, or unreadable. */
export type SeriesWindowDecimalReading =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "NULL" }
  | { readonly kind: "VALUE"; readonly value: string }
  | { readonly kind: "UNREADABLE"; readonly detail: string };

/** A boolean venue field: a boolean, `null`, absent, or something else. */
export type SeriesWindowBooleanReading = boolean | null | "ABSENT" | "UNREADABLE";

/** A string venue field: the string, or `null` when absent, `null` or not a string. */
export type SeriesWindowStringReading = string | null;

export interface SeriesWindowMarketReading {
  readonly marketId: SeriesWindowStringReading;
  readonly question: SeriesWindowStringReading;
  readonly conditionId: SeriesWindowStringReading;
  readonly description: SeriesWindowStringReading;
  readonly resolutionSource: SeriesWindowStringReading;
  readonly outcomes: SeriesWindowStringReading;
  readonly clobTokenIds: SeriesWindowStringReading;
  readonly eventStartTime: SeriesWindowStringReading;
  readonly endDate: SeriesWindowStringReading;
  readonly orderPriceMinTickSize: SeriesWindowDecimalReading;
  readonly orderMinSize: SeriesWindowDecimalReading;
  readonly secondsDelay: SeriesWindowDecimalReading;
  readonly feesEnabled: SeriesWindowBooleanReading;
  readonly feeSchedule: {
    readonly rate: SeriesWindowDecimalReading;
    readonly exponent: SeriesWindowDecimalReading;
    readonly takerOnly: SeriesWindowBooleanReading;
    readonly rebateRate: SeriesWindowDecimalReading;
  } | null;
  readonly makerBaseFee: SeriesWindowDecimalReading;
  readonly takerBaseFee: SeriesWindowDecimalReading;
  /**
   * `Market.negRisk`: the market's own negative-risk membership (S-D23 lines
   * 305, 313-315), as stated — absent, `null` and a non-boolean are REPORTED,
   * never defaulted, and never filled from the event's flag.
   */
  readonly negRisk: SeriesWindowBooleanReading;
}

export interface SeriesWindowEventReading {
  readonly eventId: SeriesWindowStringReading;
  readonly eventTitle: SeriesWindowStringReading;
  readonly eventSeriesSlug: SeriesWindowStringReading;
  readonly eventSeriesIds: readonly SeriesWindowStringReading[];
  readonly eventNegRisk: SeriesWindowBooleanReading;
  readonly marketCount: number;
  readonly market: SeriesWindowMarketReading | null;
}

export interface ClobMarketInfoBodyReading {
  readonly tokens: readonly { readonly tokenId: SeriesWindowStringReading; readonly outcome: SeriesWindowStringReading }[] | null;
  readonly minimumOrderSize: SeriesWindowDecimalReading;
  readonly minimumTickSize: SeriesWindowDecimalReading;
  readonly makerBaseFee: SeriesWindowDecimalReading;
  readonly takerBaseFee: SeriesWindowDecimalReading;
  readonly takerOrderDelayEnabled: SeriesWindowBooleanReading;
  readonly fees: {
    readonly rate: SeriesWindowDecimalReading;
    readonly exponent: SeriesWindowDecimalReading;
    readonly takerOnly: SeriesWindowBooleanReading;
  } | null;
}

export type GammaSeriesEventsVerdict =
  | {
      readonly status: "ok";
      readonly events: readonly SeriesWindowEventReading[];
      /** `next_cursor`; `null` when absent, `null` or empty (the last page). */
      readonly nextCursor: string | null;
    }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

export type ClobMarketInfoVerdict =
  | { readonly status: "ok"; readonly reading: ClobMarketInfoBodyReading }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}

function own(record: OwnWireRecord, key: string): { readonly present: boolean; readonly value: unknown } {
  return Object.hasOwn(record, key) ? { present: true, value: record[key] } : { present: false, value: undefined };
}

function stringOf(record: OwnWireRecord, key: string): SeriesWindowStringReading {
  const member = own(record, key);
  return typeof member.value === "string" ? member.value : null;
}

function booleanOf(record: OwnWireRecord, key: string): SeriesWindowBooleanReading {
  const member = own(record, key);
  if (!member.present) return "ABSENT";
  if (member.value === null) return null;
  return typeof member.value === "boolean" ? member.value : "UNREADABLE";
}

function decimalOf(record: OwnWireRecord, key: string): SeriesWindowDecimalReading {
  const member = own(record, key);
  if (!member.present) return { kind: "ABSENT" };
  if (member.value === null) return { kind: "NULL" };
  if (typeof member.value !== "number" && typeof member.value !== "string") {
    return { kind: "UNREADABLE", detail: `a ${Array.isArray(member.value) ? "array" : typeof member.value}` };
  }
  const normalized = normalizeVenueDecimal(member.value);
  if (normalized.status === "ok") return { kind: "VALUE", value: normalized.value };
  if (normalized.status === "absent") return { kind: "UNREADABLE", detail: "an empty string" };
  return { kind: "UNREADABLE", detail: normalized.reason };
}

function recordOf(record: OwnWireRecord, key: string): OwnWireRecord | null {
  const member = own(record, key);
  return isOwnWireRecord(member.value) ? member.value : null;
}

function arrayOf(record: OwnWireRecord, key: string): readonly unknown[] | null {
  const member = own(record, key);
  return Array.isArray(member.value) ? (member.value as readonly unknown[]) : null;
}

function parseBody(bodyUtf8: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly issue: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyUtf8);
  } catch (error) {
    return { ok: false, issue: `<root>: the body is not JSON (${error instanceof Error ? error.message : "unparsable"})` };
  }
  const read = readOwnWireValue(parsed);
  if (!read.ok) return { ok: false, issue: `<root>: ${read.detail}` };
  return { ok: true, value: read.value };
}

function readMarket(market: OwnWireRecord): SeriesWindowMarketReading {
  const schedule = recordOf(market, "feeSchedule");
  return {
    marketId: stringOf(market, "id"),
    question: stringOf(market, "question"),
    conditionId: stringOf(market, "conditionId"),
    description: stringOf(market, "description"),
    resolutionSource: stringOf(market, "resolutionSource"),
    outcomes: stringOf(market, "outcomes"),
    clobTokenIds: stringOf(market, "clobTokenIds"),
    eventStartTime: stringOf(market, "eventStartTime"),
    endDate: stringOf(market, "endDate"),
    orderPriceMinTickSize: decimalOf(market, "orderPriceMinTickSize"),
    orderMinSize: decimalOf(market, "orderMinSize"),
    secondsDelay: decimalOf(market, "secondsDelay"),
    feesEnabled: booleanOf(market, "feesEnabled"),
    feeSchedule:
      schedule === null
        ? null
        : {
            rate: decimalOf(schedule, "rate"),
            exponent: decimalOf(schedule, "exponent"),
            takerOnly: booleanOf(schedule, "takerOnly"),
            rebateRate: decimalOf(schedule, "rebateRate"),
          },
    makerBaseFee: decimalOf(market, "makerBaseFee"),
    takerBaseFee: decimalOf(market, "takerBaseFee"),
    negRisk: booleanOf(market, "negRisk"),
  };
}

function readEvent(event: OwnWireRecord): SeriesWindowEventReading {
  const series = arrayOf(event, "series") ?? [];
  const markets = arrayOf(event, "markets");
  const first = markets === null ? undefined : markets[0];
  return {
    eventId: stringOf(event, "id"),
    eventTitle: stringOf(event, "title"),
    eventSeriesSlug: stringOf(event, "seriesSlug"),
    eventSeriesIds: series.map((entry) => (isOwnWireRecord(entry) ? stringOf(entry, "id") : null)),
    eventNegRisk: booleanOf(event, "negRisk"),
    marketCount: markets === null ? 0 : markets.length,
    market: isOwnWireRecord(first) ? readMarket(first) : null,
  };
}

/**
 * Reads one `GET /events/keyset` body (S-D72 `KeysetEventsResponse`). An
 * event that is not an object is refused with the whole page — a page the
 * door cannot read whole is not partially admitted. TOTAL.
 */
export function readGammaSeriesEventsBody(bodyUtf8: string): GammaSeriesEventsVerdict {
  const body = parseBody(bodyUtf8);
  if (!body.ok) return freeze({ status: "invalid", issues: [body.issue] });
  if (!isOwnWireRecord(body.value)) {
    return freeze({ status: "invalid", issues: ["<root>: a KeysetEventsResponse is a JSON object; the body is not one"] });
  }
  const events = arrayOf(body.value, "events");
  if (events === null) {
    return freeze({ status: "invalid", issues: ["events: KeysetEventsResponse.events is absent or not an array"] });
  }
  const readings: SeriesWindowEventReading[] = [];
  const issues: string[] = [];
  events.forEach((event, index) => {
    if (isOwnWireRecord(event)) readings.push(readEvent(event));
    else issues.push(`events[${String(index)}]: an Event is a JSON object`);
  });
  if (issues.length > 0) return freeze({ status: "invalid", issues });
  const cursor = stringOf(body.value, "next_cursor");
  return freeze({ status: "ok", events: readings, nextCursor: cursor === null || cursor === "" ? null : cursor });
}

/** Reads one `GET /clob-markets/{condition_id}` body (S-D65 `ClobMarketDetails`). TOTAL. */
export function readClobMarketInfoBody(bodyUtf8: string): ClobMarketInfoVerdict {
  const body = parseBody(bodyUtf8);
  if (!body.ok) return freeze({ status: "invalid", issues: [body.issue] });
  if (!isOwnWireRecord(body.value)) {
    return freeze({ status: "invalid", issues: ["<root>: ClobMarketDetails is a JSON object; the body is not one"] });
  }
  const record = body.value;
  const tokens = arrayOf(record, "t");
  const fees = recordOf(record, "fd");
  return freeze({
    status: "ok",
    reading: {
      tokens:
        tokens === null
          ? null
          : tokens.map((token) =>
              isOwnWireRecord(token)
                ? { tokenId: stringOf(token, "t"), outcome: stringOf(token, "o") }
                : { tokenId: null, outcome: null },
            ),
      minimumOrderSize: decimalOf(record, "mos"),
      minimumTickSize: decimalOf(record, "mts"),
      makerBaseFee: decimalOf(record, "mbf"),
      takerBaseFee: decimalOf(record, "tbf"),
      takerOrderDelayEnabled: booleanOf(record, "itode"),
      fees:
        fees === null
          ? null
          : { rate: decimalOf(fees, "r"), exponent: decimalOf(fees, "e"), takerOnly: booleanOf(fees, "to") },
    },
  });
}
