/**
 * `@polymarket-bot/polymarket-public` — the `/v2/resolutions` read (`V2-3`;
 * ADR-030 Amendment 2, rules 3-5): the public, condition-keyed Data API v2
 * read and the door that reads its body as stated. `./fetcher.ts` cites the
 * surface; `./door.ts` each field. The gateway's
 * `apps/data-gateway/src/feeds/resolution-check.ts` judges the reading.
 */

export {
  DATA_API_BASE_URL,
  DATA_API_RESOLUTIONS_REST_CHANNEL,
  dataApiResolutionsUrl,
  requestDataApiResolutions,
  type DataApiResolutionsAnswer,
  type ResolutionReadTimers,
} from "./fetcher.js";

export {
  readDataApiResolutionsBody,
  type DataApiFieldReading,
  type DataApiNotARowReading,
  type DataApiPayoutElement,
  type DataApiResolutionRowReading,
  type DataApiResolutionsBodyReading,
} from "./door.js";
