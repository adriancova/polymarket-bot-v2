/**
 * THE `/v2/resolutions` READ (`V2-3`; ADR-030 Amendment 2, rules 3 and 4):
 * one public, condition-keyed GET of the Data API v2, answered EXACTLY as
 * received so the gateway can journal the raw body before anything is derived
 * from it (Decision 3.1).
 *
 * ## The surface (`docs/venue/verified-2026-10-05.md`)
 *
 * - **F-65:** "Both versions are served at `https://data-api.polymarket.com`,
 *   with v2 routes under the `/v2` prefix"; "v2 unifies on `condition`".
 * - **F-57 / F-67:** `GET /v2/resolutions` takes exactly one of `question_id`,
 *   `condition` or `event_id`. This read sends `condition` only, once.
 * - **F-67:** the Data API v2 states "**Auth**: none. All data routes are
 *   public". No header, credential, signer or wallet appears on any path here;
 *   the {@link PublicHttpClient} port cannot carry one.
 * - **F-70 / C-19 (ADR-030 Amendment 2 rule 3):** the route answers the
 *   31-byte condition form with HTTP 400 and the 32-byte form with 200. So
 *   {@link dataApiResolutionsUrl} takes ONLY the 32-byte form (`0x` and 64 hex
 *   digits): the caller pads a 31-byte id first (`@polymarket-bot/universe`
 *   `paddedConditionId`), and any other text is refused before a request.
 *
 * ## Our own client, never the SDK (rule 4 item 4; plan §7.1 S4(b))
 *
 * The SDK exposes no raw body (§S.4) and converts `payouts` to collateral
 * units (F-78: the wire's `[1000000,0]` becomes `["1","0"]`). This read is
 * hand-written on the package's injected HTTP port, so the gateway sees, and
 * journals, the bytes the venue sent.
 *
 * ## One request, bounded, never thrown
 *
 * {@link requestDataApiResolutions} issues exactly one request and never
 * retries; cadence and budget are the caller's (the gateway's configuration
 * door pins its arithmetic against the documented Data API v2 limit). It never
 * rejects: a transport failure, or no answer within `timeoutMs` (the request
 * is then aborted through its signal and anything that arrives later is
 * discarded unread), is a `NO_ANSWER` — a read that received nothing, so
 * there is nothing to journal. Any HTTP status is a `RESPONSE`, returned with
 * its body as received so the caller journals it FIRST.
 */

import { PublicMarketConfigurationError } from "../errors.js";
import type { CancelScheduled, PublicHttpClient } from "../ports.js";

/** The public Data API origin (F-65). */
export const DATA_API_BASE_URL = "https://data-api.polymarket.com";

/** `sourceChannel` for a `MarketResolved` derived from a `/v2/resolutions` row. */
export const DATA_API_RESOLUTIONS_REST_CHANNEL = "polymarket:data-api-resolutions-rest";

/** The only condition form this read sends: 32 bytes, `0x` and 64 hex digits (rule 3; F-70). */
const CONDITION_ID_32_BYTES = /^0x[0-9a-fA-F]{64}$/u;

/** The timer this read needs: one cancellable timeout (the gateway's and the package's timer ports both fit). */
export interface ResolutionReadTimers {
  setTimeout(handler: () => void, delayMs: number): CancelScheduled;
}

/** What one `/v2/resolutions` read got back. Never a throw. */
export type DataApiResolutionsAnswer =
  | {
      /** An HTTP response, any status, with its body exactly as received. */
      readonly kind: "RESPONSE";
      readonly url: string;
      readonly status: number;
      readonly bodyUtf8: string;
    }
  | {
      /** No response: a transport failure, or none within the read's timeout. Nothing was received. */
      readonly kind: "NO_ANSWER";
      readonly url: string;
      readonly detail: string;
    };

function origin(baseUrl: string | undefined): string {
  const value = (baseUrl ?? DATA_API_BASE_URL).replace(/\/+$/u, "");
  if (value === "") {
    throw new PublicMarketConfigurationError("the Data API base url must not be empty");
  }
  return value;
}

/**
 * The URL of one `/v2/resolutions` read, keyed by `condition` in the 32-byte
 * form. Throws `PublicMarketConfigurationError` for any other condition text:
 * no read is made for it (ADR-030 Amendment 2 rule 3 item 3).
 */
export function dataApiResolutionsUrl(paddedConditionId: string, baseUrl?: string): string {
  if (!CONDITION_ID_32_BYTES.test(paddedConditionId)) {
    throw new PublicMarketConfigurationError(
      "a /v2/resolutions read is keyed by the 32-byte condition form (0x and 64 hex digits; ADR-030 Amendment 2 rule 3, F-70): pad a 31-byte id first",
    );
  }
  const params = new URLSearchParams();
  params.set("condition", paddedConditionId);
  return `${origin(baseUrl)}/v2/resolutions?${params.toString()}`;
}

/**
 * Issues one `/v2/resolutions` read and resolves to what came back. Never
 * rejects (module header). `timeoutMs` must be a positive safe integer.
 */
export function requestDataApiResolutions(options: {
  readonly http: PublicHttpClient;
  readonly conditionId: string;
  readonly baseUrl?: string;
  readonly timers: ResolutionReadTimers;
  readonly timeoutMs: number;
}): Promise<DataApiResolutionsAnswer> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new PublicMarketConfigurationError("the /v2/resolutions read timeout must be a positive whole number of milliseconds");
  }
  const url = dataApiResolutionsUrl(options.conditionId, options.baseUrl);
  const controller = new AbortController();
  return new Promise<DataApiResolutionsAnswer>((settle) => {
    let settled = false;
    const timeout: { cancel?: CancelScheduled } = {};
    const finish = (answer: DataApiResolutionsAnswer): void => {
      if (settled) return;
      settled = true;
      timeout.cancel?.();
      settle(answer);
    };
    timeout.cancel = options.timers.setTimeout(() => {
      if (settled) return;
      controller.abort();
      finish({ kind: "NO_ANSWER", url, detail: `no answer within the read's ${String(options.timeoutMs)} ms timeout; the request was aborted` });
    }, options.timeoutMs);
    if (settled) timeout.cancel();
    let pending: Promise<{ readonly status: number; readonly body: string }>;
    try {
      pending = options.http({ url, method: "GET", signal: controller.signal });
    } catch (error) {
      finish({ kind: "NO_ANSWER", url, detail: `the request failed at the transport level: ${describe(error)}` });
      return;
    }
    pending.then(
      (response) => {
        finish({ kind: "RESPONSE", url, status: response.status, bodyUtf8: response.body });
      },
      (error: unknown) => {
        finish({ kind: "NO_ANSWER", url, detail: `the request failed at the transport level: ${describe(error)}` });
      },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
