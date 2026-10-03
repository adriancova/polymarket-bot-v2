/**
 * Contract: matching-engine restricted-mode responses → the PINNED SDK's own
 * HTTP error construction → WP-260's mapping (the secure client's
 * `PlacementOutcome`) → the OMS's reading of it → the restricted-mode
 * detector, over the documented restricted-mode snapshot (two-minute
 * post-only window; restart backoff from 1 s doubling to 30 s).
 *
 * Fixtures: `test/fixtures/venue/orders/restricted-modes.json` (2026-08-24),
 * plus the 2026-09-30 report's documented 425 example (`HTTP/1.1 425 Too
 * Early` / `Retry-After: 1`, E-06) and the two further official strings for
 * the unclassified 503 (C-9). The fixture's cancel-only string is one side of
 * C-9 (`V3-FIXTURES`): all three strings must give the same mode, because the
 * mode is keyed on status and documented code only, never on text (E-05).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { conditionOfPlacementOutcome, type VenueModeDetector, type VenueModeSnapshot } from "../../../packages/oms/src/index.js";
import type { PlacementOutcome } from "../../../packages/polymarket-secure/src/index.js";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  provokeSdkHttpRejection,
  type FetchResponder,
  type NetworkTripwire,
} from "../../../packages/polymarket-secure/src/testing/index.js";

import { T0, documentedDetector, normalized, readRepoText, venueExample } from "./support.js";

const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });
const CLOB_ORIGIN = "https://clob.polymarket.com/";

interface HttpFixture {
  readonly http_status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

function reinstall(responder: FetchResponder): void {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
  tripwire = installNetworkTripwire({ responder });
}

function responseOf(fixture: HttpFixture): Response {
  const headers = new Headers(fixture.headers ?? {});
  if (fixture.body !== undefined) headers.set("content-type", "application/json");
  return new Response(fixture.body === undefined ? null : JSON.stringify(fixture.body), { status: fixture.http_status, headers });
}

/** Serve `fixture` to the pinned SDK and return the secure client's placement outcome for it. */
async function outcomeFor(fixture: HttpFixture): Promise<PlacementOutcome> {
  reinstall((url) => (url.startsWith(CLOB_ORIGIN) ? responseOf(fixture) : undefined));
  const sdkError = await provokeSdkHttpRejection();
  const { factory } = createFakeSdkFactory({
    postOrder: () => {
      throw sdkError;
    },
  });
  const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle }, factory);
  const signed = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size: "10" });
  if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");
  return client.postOrder(signed.order);
}

async function observe(detector: VenueModeDetector, fixture: HttpFixture, atMs: number): Promise<void> {
  const outcome = await outcomeFor(fixture);
  const result = detector.observe({ operation: "PLACEMENT", condition: conditionOfPlacementOutcome(outcome) }, atMs);
  expect(result.ok).toBe(true);
}

function example(name: string): HttpFixture {
  return venueExample("orders/restricted-modes.json", name) as unknown as HttpFixture;
}

const C9_STRINGS: readonly [string, HttpFixture][] = [
  ["the 2026-08-24 fixture (cancel-only)", { http_status: 503, body: { error: "Trading is currently cancel-only. New orders are not accepted, but cancels are allowed." } }],
  ["the 2026-09-30 matching-engine guide", { http_status: 503, body: { error: "trading is disabled" } }],
  ["the 2026-09-30 OpenAPI trading_disabled example", { http_status: 503, body: { error: "Trading is currently disabled. Check polymarket.com for updates" } }],
];

describe("restricted-mode fixtures → pinned SDK → WP-260 → the OMS's reading → the detector", () => {
  it("425 without a body or Retry-After (U-9) → RESTARTING for the documented 1 s fallback, then post-only for two minutes", async () => {
    const detector = documentedDetector();
    await observe(detector, example("http-425-engine-restarting-body-undocumented"), T0);
    expect(detector.snapshot(T0)).toMatchObject({ mode: "RESTARTING", omsMode: "TRADING_UNAVAILABLE", restartingUntilMs: T0 + 1000, postOnlyUntilMs: T0 + 1000 + 120_000 });
    // The next failed attempt after the wait doubles it.
    await observe(detector, example("http-425-engine-restarting-body-undocumented"), T0 + 1000);
    expect(detector.snapshot(T0 + 1000).restartingUntilMs).toBe(T0 + 3000);
  });

  it("425 with the documented Retry-After: 1 (E-06) → RESTARTING exactly 1000 ms, then POST_ONLY, then NORMAL", async () => {
    const report = normalized(readRepoText("docs/venue/verified-2026-09-30.md"));
    expect(report).toContain("`HTTP/1.1 425 Too Early` / `Retry-After: 1`");
    const detector = documentedDetector();
    await observe(detector, { http_status: 425, headers: { "Retry-After": "1" } }, T0);
    const at = (ms: number): VenueModeSnapshot["mode"] => detector.snapshot(ms).mode;
    expect([at(T0 + 999), at(T0 + 1000), at(T0 + 120_999), at(T0 + 121_000)]).toEqual(["RESTARTING", "POST_ONLY", "POST_ONLY", "NORMAL"]);
    expect(detector.placementGate({ postOnly: false }, T0 + 1000)).toMatchObject({ allowed: false, reason: "POST_ONLY_MODE_REQUIRES_POST_ONLY" });
    expect(detector.placementGate({ postOnly: true }, T0 + 1000)).toEqual({ allowed: true });
  });

  it("503 post_only_mode with Retry-After 79 → POST_ONLY exactly 79 s; cancels stay allowed", async () => {
    const detector = documentedDetector();
    await observe(detector, example("http-503-post-only"), T0);
    expect(detector.snapshot(T0)).toMatchObject({ mode: "POST_ONLY", omsMode: "POST_ONLY", postOnlyUntilMs: T0 + 79_000 });
    expect(detector.snapshot(T0 + 79_000).mode).toBe("NORMAL");
    expect(detector.cancelGate().allowed).toBe(true);
  });

  it.each(C9_STRINGS)("C-9: %s → TRADING_UNAVAILABLE, identically for all three strings; cancels still allowed", async (_label, fixture) => {
    const detector = documentedDetector();
    await observe(detector, fixture, T0);
    expect(detector.snapshot(T0)).toMatchObject({ mode: "TRADING_UNAVAILABLE", omsMode: "TRADING_UNAVAILABLE", tradingUnavailableUntilMs: T0 + 5000 });
    expect(detector.cancelGate().allowed).toBe(true);
  });

  it("the fixture's own cancel-only example is the first C-9 string", () => {
    expect(example("http-503-cancel-only")).toEqual(C9_STRINGS[0]?.[1]);
  });

  it("a 429 and a 500 move no mode (\"Retry only restart rejections\")", async () => {
    const detector = documentedDetector();
    await observe(detector, { http_status: 429, headers: { "Retry-After": "2" } }, T0);
    await observe(detector, { http_status: 500, body: { error: "could not insert order" } }, T0 + 1);
    expect(detector.snapshot(T0 + 1)).toMatchObject({ mode: "NORMAL", restartingUntilMs: null, tradingUnavailableUntilMs: null, postOnlyUntilMs: null });
  });
});
