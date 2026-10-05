/**
 * `@polymarket-bot/polymarket-public` — the series-admission reads
 * (`ROLLOVER-1`; ADR-030): the documented Gamma `GET /events/keyset`
 * discovery read and the CLOB `GET /clob-markets/{condition_id}` read, and
 * the door that turns their bodies into the readings the universe judge
 * consumes. `./fetcher.ts` cites each surface; `./door.ts` each field.
 */

export {
  clobMarketInfoUrl,
  gammaSeriesEventsUrl,
  KEYSET_LIMIT_MAXIMUM,
  KEYSET_LIMIT_MINIMUM,
  requestClobMarketInfo,
  requestGammaSeriesEvents,
  SERIES_ADMISSION_REST_CHANNEL,
  SERIES_WINDOW_CLOB_BASE_URL,
  SERIES_WINDOW_GAMMA_BASE_URL,
  type GammaSeriesEventsQuery,
  type SeriesWindowResponse,
} from "./fetcher.js";

export {
  readClobMarketInfoBody,
  readGammaSeriesEventsBody,
  type ClobMarketInfoBodyReading,
  type ClobMarketInfoVerdict,
  type GammaSeriesEventsVerdict,
  type SeriesWindowBooleanReading,
  type SeriesWindowDecimalReading,
  type SeriesWindowEventReading,
  type SeriesWindowMarketReading,
  type SeriesWindowStringReading,
} from "./door.js";
