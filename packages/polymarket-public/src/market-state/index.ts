/**
 * `@polymarket-bot/polymarket-public/market-state` — the documented polled
 * market-state surface, `GET /markets/{id}` (`UNIV-4`, closeout blocker B10).
 *
 * `./door.ts` quotes the whole venue licence (D-30) and states the door's
 * conformance; `./fetcher.ts` issues the read. Also re-exported from the
 * package barrel so existing alias tables resolve it.
 */

export {
  GAMMA_MARKET_DOCUMENTED_FIELDS,
  isGammaMarketTradeReady,
  readGammaMarket,
  readGammaMarketBody,
  type GammaMarketDocumentedField,
  type GammaMarketDocumentedType,
  type GammaMarketState,
  type GammaMarketVerdict,
  type GammaRecordedScalar,
} from "./door.js";

export {
  fetchGammaMarket,
  gammaMarketUrl,
  GAMMA_MARKET_REST_CHANNEL,
  POLYMARKET_GAMMA_REST_BASE_URL,
  requestGammaMarket,
  type GammaMarketRequestOptions,
  type GammaMarketResponse,
} from "./fetcher.js";
