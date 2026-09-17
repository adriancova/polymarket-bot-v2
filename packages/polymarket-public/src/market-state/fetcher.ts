/**
 * `GET /markets/{id}` over the public Gamma REST API (`UNIV-4`).
 *
 * The documented surface (`docs/venue/verified-2026-09-16.md` D-30, S-D34 the
 * Gamma OpenAPI, S-D23 `market-details`): unauthenticated, public, returning
 * one `Market`. The whole venue licence for this module is quoted in
 * `./door.ts`; this file adds no venue fact.
 *
 * ## Two layers, so a recorder can journal raw-before-judge
 *
 * - {@link requestGammaMarket} issues the request and returns the response
 *   EXACTLY as received — status and UTF-8 body — throwing only on a
 *   transport failure. This is the layer the gateway uses: it journals the
 *   raw body to the WAL FIRST (acceptance 1), then judges the status, then
 *   runs the door.
 * - {@link fetchGammaMarket} is the `../snapshot/fetcher.ts`-style whole
 *   read for callers that need no raw copy: loud failure on transport, on a
 *   non-2xx status, and on a body the door refuses.
 *
 * ## The path parameter is CONFIGURATION, not a claim
 *
 * S-D34 documents `{id}` as the path parameter of `GET /markets/{id}`. This
 * package does not assert whether that identifier is the numeric Gamma
 * market id or the condition id: the round that wrote this module could not
 * read S-D34's parameter description or its example from the repository
 * (`docs/venue/verified-2026-09-16.md` records the property list with line
 * numbers, not the parameter). The caller supplies the exact `{id}` value it
 * has verified for its market; this module URL-encodes it and nothing more.
 * Recorded as a missing venue fact in `docs/handoffs/UNIV-4.md`.
 *
 * ## Rate limits are the caller's budget
 *
 * Gamma publishes 4,000 requests / 10 s general and 300 / 10 s for
 * `/markets` (report §8, `test/fixtures/venue/rate-limits/rate-limits.json`
 * `gamma_markets`). This module issues exactly one request per call and
 * never retries; cadence and fan-out belong to the caller (the gateway's
 * lifecycle configuration door pins its arithmetic).
 *
 * SAFETY: no credential, header, signer or wallet appears on any path here.
 */

import {
  GammaMarketStateInvalidError,
  GammaMarketStateUnavailableError,
  PublicMarketConfigurationError,
} from "../errors.js";
import type { PublicHttpClient } from "../ports.js";
import { type GammaMarketState, readGammaMarketBody } from "./door.js";

/** Public Gamma REST origin serving `GET /markets/{id}` (S-D34, accessed 2026-09-16). */
export const POLYMARKET_GAMMA_REST_BASE_URL = "https://gamma-api.polymarket.com";

/** `sourceChannel` for events derived from a Gamma market-state read. */
export const GAMMA_MARKET_REST_CHANNEL = "polymarket:gamma-market-rest";

export interface GammaMarketRequestOptions {
  readonly http: PublicHttpClient;
  /** The `{id}` path value for this market, exactly as configured. */
  readonly marketId: string;
  /** Defaults to {@link POLYMARKET_GAMMA_REST_BASE_URL}. Overridable for a local stub. */
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
}

/** One response, exactly as received. */
export interface GammaMarketResponse {
  readonly url: string;
  readonly status: number;
  readonly bodyUtf8: string;
}

/** The URL {@link requestGammaMarket} issues, for callers that journal the endpoint. */
export function gammaMarketUrl(marketId: string, baseUrl?: string): string {
  const origin = (baseUrl ?? POLYMARKET_GAMMA_REST_BASE_URL).replace(/\/+$/u, "");
  if (origin === "") {
    throw new PublicMarketConfigurationError("the Gamma REST base url must not be empty");
  }
  if (marketId === "") {
    throw new PublicMarketConfigurationError(
      "the Gamma market id must not be empty: GET /markets/{id} needs a path value",
    );
  }
  return `${origin}/markets/${encodeURIComponent(marketId)}`;
}

/**
 * Issues one `GET /markets/{id}` and returns the response as received.
 *
 * Throws {@link GammaMarketStateUnavailableError} on a transport failure
 * only. A non-2xx status is RETURNED, not thrown, so the caller can journal
 * the body before judging it.
 */
export async function requestGammaMarket(
  options: GammaMarketRequestOptions,
): Promise<GammaMarketResponse> {
  const url = gammaMarketUrl(options.marketId, options.baseUrl);
  let response;
  try {
    response = await options.http({
      url,
      method: "GET",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new GammaMarketStateUnavailableError(
      "the market-state request failed at the transport level",
      { url, method: "GET" },
      error,
    );
  }
  return { url, status: response.status, bodyUtf8: response.body };
}

/**
 * The whole read, `../snapshot/fetcher.ts`-style: loud on transport, on a
 * non-2xx status, and on a body the door refuses.
 */
export async function fetchGammaMarket(options: GammaMarketRequestOptions): Promise<{
  readonly url: string;
  readonly state: GammaMarketState;
}> {
  const response = await requestGammaMarket(options);
  if (response.status < 200 || response.status >= 300) {
    throw new GammaMarketStateUnavailableError(
      `the market-state request returned HTTP ${String(response.status)}`,
      { url: response.url, method: "GET", status: response.status },
    );
  }
  const verdict = readGammaMarketBody(response.bodyUtf8);
  if (verdict.status === "invalid") {
    throw new GammaMarketStateInvalidError(
      "the market-state response did not match the documented Market shape",
      { url: response.url, issues: verdict.issues },
    );
  }
  return { url: response.url, state: verdict.state };
}
