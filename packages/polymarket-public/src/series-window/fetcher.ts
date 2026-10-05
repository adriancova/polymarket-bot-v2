/**
 * The two DOCUMENTED reads series admission makes (`ROLLOVER-1`; ADR-030
 * Decision 1.7; the user's ruling Q3), each returned EXACTLY as received so
 * the gateway can journal the raw body before anything judges it (`UNIV-4`'s
 * rule, ADR-030 Decision 3.1):
 *
 * 1. **Discovery — Gamma `GET /events/keyset`** (`docs/venue/verified-2026-10-04.md`
 *    F-07, S-D72 lines 44-260). The parameters this module sends, each
 *    documented there: `series_id` (integer[], lines 188-193), `closed`
 *    (boolean), `order` ("Comma-separated list of JSON field names to order
 *    by"), `ascending` (boolean, "Only used when order is set"), `limit`
 *    (integer, 1 to 100), `after_cursor` (string; `next_cursor` of the
 *    previous page), and the explicit date bound `end_date_min` (date-time).
 *    The response is `KeysetEventsResponse {events, next_cursor}`, which
 *    "Always includes Series, Tags, Markets, and EventCreators relations"
 *    (lines 295-300). `offset` is "Not allowed" and is never sent.
 *    NOT used: `GET /events?series_slug=` — `series_slug` is undocumented
 *    (U-30, F-11); and the WebSocket `new_market` event, whose delivery scope
 *    is undocumented (U-23) and which carries no schedule (F-13).
 * 2. **The CLOB market info — `GET /clob-markets/{condition_id}`** (S-D65):
 *    the explicit token↔outcome pairing (`t[].{t, o}`, F-03), `itode` (F-19),
 *    `mts`, `mos`, `mbf`, `tbf` and `fd`.
 *
 * Both hosts are public and unauthenticated. No header, credential, signer or
 * wallet appears on any path here. Each call issues exactly one request and
 * never retries; cadence and budget are the caller's (the gateway's
 * configuration door pins its arithmetic against the documented limits: Gamma
 * `/events` 500 per 10 s, CLOB general 9,000 per 10 s; S-D24 lines 33-36, 78).
 */

import { PublicMarketConfigurationError, SeriesWindowUnavailableError } from "../errors.js";
import type { PublicHttpClient } from "../ports.js";

/** The public Gamma origin (S-D72, `servers`). */
export const SERIES_WINDOW_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
/** The public CLOB origin (S-D65, `servers`: "Production CLOB API"). */
export const SERIES_WINDOW_CLOB_BASE_URL = "https://clob.polymarket.com";

/** `sourceChannel` for events derived from a series-admission read. */
export const SERIES_ADMISSION_REST_CHANNEL = "polymarket:series-admission-rest";

/** The documented `limit` bounds of `GET /events/keyset` (F-07: "1 to 100"). */
export const KEYSET_LIMIT_MINIMUM = 1;
export const KEYSET_LIMIT_MAXIMUM = 100;

/** One response, exactly as received. */
export interface SeriesWindowResponse {
  readonly url: string;
  readonly status: number;
  readonly bodyUtf8: string;
}

export interface GammaSeriesEventsQuery {
  /** The reviewed series' Gamma id (`series_id`, F-07). Digits only. */
  readonly gammaSeriesId: string;
  /** The explicit date bound: only events whose `endDate` is at or after it (`end_date_min`). */
  readonly endDateMin: string;
  /** Page size, 1-100 (F-07). */
  readonly limit: number;
  /** `next_cursor` of the previous page, when paging. */
  readonly afterCursor?: string;
  readonly baseUrl?: string;
}

function origin(baseUrl: string | undefined, fallback: string, what: string): string {
  const value = (baseUrl ?? fallback).replace(/\/+$/u, "");
  if (value === "") {
    throw new PublicMarketConfigurationError(`the ${what} base url must not be empty`);
  }
  return value;
}

/**
 * The URL of one discovery page. Throws `PublicMarketConfigurationError` on an
 * argument no documented request takes; the query string is built by
 * `URLSearchParams`, so every value is encoded.
 */
export function gammaSeriesEventsUrl(query: GammaSeriesEventsQuery): string {
  if (!/^[1-9][0-9]{0,17}$/u.test(query.gammaSeriesId)) {
    throw new PublicMarketConfigurationError("series_id is an integer (F-07): the Gamma series id must be digits");
  }
  if (!Number.isSafeInteger(query.limit) || query.limit < KEYSET_LIMIT_MINIMUM || query.limit > KEYSET_LIMIT_MAXIMUM) {
    throw new PublicMarketConfigurationError(
      `limit must be an integer from ${String(KEYSET_LIMIT_MINIMUM)} to ${String(KEYSET_LIMIT_MAXIMUM)} (F-07)`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(query.endDateMin)) {
    throw new PublicMarketConfigurationError("end_date_min is a date-time (F-07): a strict-UTC instant is required");
  }
  const params = new URLSearchParams();
  params.set("series_id", query.gammaSeriesId);
  params.set("closed", "false");
  params.set("order", "endDate");
  params.set("ascending", "true");
  params.set("limit", String(query.limit));
  params.set("end_date_min", query.endDateMin);
  if (query.afterCursor !== undefined) {
    if (query.afterCursor === "") {
      throw new PublicMarketConfigurationError("after_cursor, when sent, is the previous page's non-empty next_cursor");
    }
    params.set("after_cursor", query.afterCursor);
  }
  return `${origin(query.baseUrl, SERIES_WINDOW_GAMMA_BASE_URL, "Gamma")}/events/keyset?${params.toString()}`;
}

/** The URL of one CLOB market-info read (`GET /clob-markets/{condition_id}`, S-D65). */
export function clobMarketInfoUrl(conditionId: string, baseUrl?: string): string {
  if (conditionId === "" || conditionId.length > 200) {
    throw new PublicMarketConfigurationError("the condition id must be a non-empty venue identifier of at most 200 characters");
  }
  return `${origin(baseUrl, SERIES_WINDOW_CLOB_BASE_URL, "CLOB")}/clob-markets/${encodeURIComponent(conditionId)}`;
}

async function get(http: PublicHttpClient, url: string, what: string, signal?: AbortSignal): Promise<SeriesWindowResponse> {
  let response;
  try {
    response = await http({ url, method: "GET", ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    throw new SeriesWindowUnavailableError(`the ${what} request failed at the transport level`, { url, method: "GET" }, error);
  }
  return { url, status: response.status, bodyUtf8: response.body };
}

/**
 * Issues one discovery page request and returns the response as received.
 * Throws `SeriesWindowUnavailableError` on a transport failure only; a non-2xx
 * status is RETURNED so the caller journals the body first.
 */
export async function requestGammaSeriesEvents(options: {
  readonly http: PublicHttpClient;
  readonly query: GammaSeriesEventsQuery;
  readonly signal?: AbortSignal;
}): Promise<SeriesWindowResponse> {
  return get(options.http, gammaSeriesEventsUrl(options.query), "Gamma events-keyset", options.signal);
}

/**
 * Issues one CLOB market-info request and returns the response as received.
 * Throws `SeriesWindowUnavailableError` on a transport failure only.
 */
export async function requestClobMarketInfo(options: {
  readonly http: PublicHttpClient;
  readonly conditionId: string;
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
}): Promise<SeriesWindowResponse> {
  return get(options.http, clobMarketInfoUrl(options.conditionId, options.baseUrl), "CLOB market-info", options.signal);
}
