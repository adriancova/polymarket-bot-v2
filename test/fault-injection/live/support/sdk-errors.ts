/**
 * WP-340: the pinned SDK's OWN error objects, for the mock CLOB to throw from
 * behind WP-260's fake-SDK seam.
 *
 * WHY REAL ONES. WP-260's `mapVenueError` classifies an SDK failure by
 * `instanceof` against the pinned `@polymarket/client@0.11.0` classes; a
 * look-alike is `UNKNOWN`. A mock venue that threw plain errors would never
 * exercise the 425, post-only, cancel-only or 429 branches of the real
 * secure client. Only `packages/polymarket-secure` may import the SDK
 * (WP-260 acceptance 1, `sdk-import-boundary.test.ts`), so these objects are
 * made the way WP-260's contract suite makes them: the SDK's public client
 * performs one request (`provokeSdkHttpRejection`), WP-260's network
 * tripwire answers it from memory (the `responder`), and the SDK builds its
 * `RequestRejectedError` / `RateLimitError` from the status, headers and
 * body served. The transport failure is the SDK's `TransportError` for a
 * fetch the tripwire REFUSED.
 *
 * Nothing leaves the process: every fetch is answered or refused by the
 * tripwire, and {@link loadSdkErrors} asserts that every one was aimed at the
 * SDK's CLOB origin and that nothing else was attempted. The bodies are the
 * documented examples (`docs/venue/verified-2026-09-30.md` §2.4, §9 E-05,
 * E-06; `test/fixtures/venue/orders/restricted-modes.json`).
 */

import { installNetworkTripwire, provokeSdkHttpRejection, type NetworkAttempt } from "../../../../packages/polymarket-secure/src/testing/index.js";

/** The SDK's production CLOB origin; the only target the tripwire answers. */
export const CLOB_ORIGIN = "https://clob.polymarket.com/";

export interface SdkErrors {
  /** 425, no body, no header: the matching engine is restarting (U-9; E-06 "when the response includes it"). */
  readonly engineRestarting: unknown;
  /** 425 with the documented example header `Retry-After: 1` (E-06). */
  readonly engineRestartingRetryAfter1: unknown;
  /** 503 `{error, code: "post_only_mode", retry_after_seconds: 79}` with `Retry-After: 79` (§9). */
  readonly postOnlyMode: unknown;
  /** 503 `{"error": "trading is disabled"}` (E-05: cancel-only and disabled are indistinguishable). */
  readonly tradingDisabled: unknown;
  /** 429 with `Retry-After: 2` (§8; the pinned SDK throws `RateLimitError` before reading the body). */
  readonly rateLimited: unknown;
  /** A fetch that never reached the venue (refused by the tripwire): the SDK's `TransportError`. */
  readonly transportFailure: unknown;
}

interface Served {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

function responseOf(served: Served): Response {
  const headers = new Headers(served.headers ?? {});
  if (served.body !== undefined) headers.set("content-type", "application/json");
  return new Response(served.body === undefined ? null : JSON.stringify(served.body), { status: served.status, headers });
}

async function provoke(served: Served | null): Promise<{ readonly error: unknown; readonly answered: readonly NetworkAttempt[]; readonly refused: readonly NetworkAttempt[] }> {
  const tripwire = installNetworkTripwire(served === null ? {} : { responder: (url) => (url.startsWith(CLOB_ORIGIN) ? responseOf(served) : undefined) });
  try {
    const error = await provokeSdkHttpRejection();
    return { error, answered: tripwire.answered(), refused: tripwire.refused() };
  } finally {
    tripwire.uninstall();
  }
}

let cached: SdkErrors | null = null;

/**
 * Build (once per module graph) one SDK error object of each kind. Throws when the SDK did not throw, or when any
 * attempt aimed anywhere but the CLOB origin, or when an answered kind also had a refused attempt.
 */
export async function loadSdkErrors(): Promise<SdkErrors> {
  if (cached !== null) return cached;
  const served = async (label: string, what: Served): Promise<unknown> => {
    const result = await provoke(what);
    if (result.error === undefined) throw new Error(`the pinned SDK did not throw for ${label}`);
    if (result.refused.length > 0) throw new Error(`${label}: the tripwire refused ${String(result.refused.length)} attempt(s)`);
    if (result.answered.length < 1 || result.answered.some((attempt) => attempt.via !== "fetch" || !attempt.target.startsWith(CLOB_ORIGIN))) {
      throw new Error(`${label}: an attempt was not a fetch to the CLOB origin`);
    }
    return result.error;
  };
  const transport = await provoke(null);
  if (transport.error === undefined) throw new Error("the pinned SDK did not throw for a refused fetch");
  if (transport.answered.length > 0 || transport.refused.length < 1 || transport.refused.some((attempt) => attempt.via !== "fetch" || !attempt.target.startsWith(CLOB_ORIGIN))) {
    throw new Error("the transport probe reached something other than a refused fetch to the CLOB origin");
  }
  cached = Object.freeze({
    engineRestarting: await served("425", { status: 425 }),
    engineRestartingRetryAfter1: await served("425 Retry-After 1", { status: 425, headers: { "Retry-After": "1" } }),
    postOnlyMode: await served("503 post_only_mode", {
      status: 503,
      headers: { "Retry-After": "79" },
      body: { error: "post-only mode: only post-only orders and cancels are allowed", code: "post_only_mode", retry_after_seconds: 79 },
    }),
    tradingDisabled: await served("503 trading disabled", { status: 503, body: { error: "trading is disabled" } }),
    rateLimited: await served("429", { status: 429, headers: { "Retry-After": "2" }, body: { error: "Too Many Requests" } }),
    transportFailure: transport.error,
  });
  return cached;
}
