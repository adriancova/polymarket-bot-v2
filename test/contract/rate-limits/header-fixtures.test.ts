/**
 * Contract: the frozen rate-limit header fixtures
 * (`test/fixtures/venue/rate-limits/rate-limits.json`, header values
 * "illustrative synthetic examples of the documented header names") drive
 * the documented budget as the venue documents (WP-310 acceptance 4).
 *
 * The 429 is also served through the PINNED SDK's own HTTP layer
 * (`@polymarket/client@0.11.0` `ServiceClient` → `RateLimitError`), then the
 * secure client's error mapping (WP-260), then the budget: a 429 with
 * `Retry-After: 2` waits exactly 2000 ms. The SDK is reached only through
 * `packages/polymarket-secure/src/testing`; the network tripwire refuses
 * every request a fixture responder does not answer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { feedbackFromObservation, parseRateLimitHeaders, type Grant, type RateLimitBudget, type RateLimitObservation, type RequestDecision } from "../../../packages/polymarket-secure/src/index.js";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  provokeSdkHttpRejection,
  type FetchResponder,
  type NetworkTripwire,
} from "../../../packages/polymarket-secure/src/testing/index.js";

import { SIGNER, T0, documentedBudget, venueExample } from "./support.js";

const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });
const CLOB_ORIGIN = "https://clob.polymarket.com/";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

function reinstall(responder: FetchResponder): NetworkTripwire {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
  tripwire = installNetworkTripwire({ responder });
  return tripwire;
}

function fixtureHeaders(name: string): Record<string, string> {
  return venueExample("rate-limits/rate-limits.json", name)["headers"] as Record<string, string>;
}

function grantOf(decision: RequestDecision): Grant {
  if (decision.kind !== "GRANTED") throw new Error(`expected GRANTED, got ${decision.kind}`);
  return decision.grant;
}

/** A budget whose signer has full buckets at T0. */
function warmBudget(): RateLimitBudget {
  const budget = documentedBudget();
  for (const [operationId, priority] of [
    ["clob.post_order", "NEW_ORDER"],
    ["clob.cancel_order", "STALE_QUOTE_CANCEL"],
  ] as const) {
    const decision = budget.request({ operationId, priority, signer: SIGNER }, T0 - 60_000);
    if (decision.kind !== "QUEUED") throw new Error("a signer first seen starts empty");
    budget.withdraw(decision.ticketId);
  }
  return budget;
}

function placeOrder(budget: RateLimitBudget, atMs: number): RequestDecision {
  return budget.request({ operationId: "clob.post_order", priority: "NEW_ORDER", signer: SIGNER }, atMs);
}

describe("rate-limits header fixtures → the documented budget", () => {
  it("response-headers-success: the tier is read (Standard), and Remaining caps the order bucket", () => {
    const budget = warmBudget();
    const grant = grantOf(placeOrder(budget, T0));
    expect(budget.view(T0).signers[0]?.order.tokens).toBe("59");
    const feedback = parseRateLimitHeaders({ httpStatus: 200, headers: fixtureHeaders("response-headers-success") });
    expect(feedback).toMatchObject({ remaining: 57, resetUnixSeconds: 1782753360, tier: "standard", warning: false, retryAfterSeconds: null, flags: [] });
    const effects = budget.complete(grant, { atMs: T0, feedback });
    expect(effects.ok && effects.value).toContainEqual({ kind: "TIER_APPLIED", signer: SIGNER, tier: "Standard" });
    expect(budget.view(T0).signers[0]).toMatchObject({ tier: "Standard", order: { tokens: "57", capacity: 60, tokensPerSecond: 40 } });
    // The fixture's Reset (2026-06-29) is in the past and the balance is positive: no wait.
    expect(budget.view(T0).signers[0]?.order.blockedUntilMs).toBeNull();
  });

  it("response-headers-429: Retry-After 2 → the order bucket waits exactly 2000 ms; the cancel bucket does not", () => {
    const budget = warmBudget();
    const grant = grantOf(placeOrder(budget, T0));
    const feedback = parseRateLimitHeaders({ httpStatus: 429, headers: fixtureHeaders("response-headers-429") });
    expect(feedback).toMatchObject({ remaining: 0, retryAfterSeconds: 2 });
    budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 2 }, feedback });
    expect(budget.view(T0).signers[0]?.order).toMatchObject({ tokens: "0", blockedUntilMs: T0 + 2000 });
    // Inside the wait (the budget's time never runs backwards): the cancel bucket and every operation are free.
    expect(budget.request({ operationId: "clob.cancel_order", priority: "EMERGENCY_CANCEL", signer: SIGNER }, T0 + 1).kind).toBe("GRANTED");
    expect(budget.view(T0 + 1).operationWaits).toEqual([]);
    expect(placeOrder(budget, T0 + 1999).kind).toBe("QUEUED");
    expect(budget.poll(T0 + 1999)).toEqual([]);
    expect(budget.poll(T0 + 2000).map((event) => event.kind)).toEqual(["GRANTED"]);
  });

  it("response-headers-warning-mode: Warning true → the estimate drops to zero and the warning is counted", () => {
    const budget = warmBudget();
    const grant = grantOf(placeOrder(budget, T0));
    const feedback = parseRateLimitHeaders({ httpStatus: 200, headers: fixtureHeaders("response-headers-warning-mode") });
    expect(feedback.warning).toBe(true);
    const effects = budget.complete(grant, { atMs: T0, feedback });
    expect(effects.ok && effects.value).toContainEqual({ kind: "WARNING_MODE", budget: { dimension: "SIGNER_ORDER_BUCKET", signer: SIGNER } });
    expect(budget.view(T0).signers[0]?.order).toMatchObject({ tokens: "0", warnings: 1 });
  });

  it("an undocumented header added to a fixture is flagged and changes nothing", () => {
    const control = warmBudget();
    const probe = warmBudget();
    const base = fixtureHeaders("response-headers-success");
    const planted = { ...base, "X-RateLimit-Remaining": "0", "Poly-RateLimit-Limit": "1", "RateLimit-Policy": "1;w=600" };
    control.complete(grantOf(placeOrder(control, T0)), { atMs: T0, feedback: parseRateLimitHeaders({ httpStatus: 200, headers: base }) });
    const feedback = parseRateLimitHeaders({ httpStatus: 200, headers: planted });
    expect(feedback.flags.map((flag) => flag.kind)).toEqual(["UNDOCUMENTED_HEADER", "UNDOCUMENTED_HEADER", "UNDOCUMENTED_HEADER"]);
    probe.complete(grantOf(placeOrder(probe, T0)), { atMs: T0, feedback });
    expect(probe.view(T0)).toEqual(control.view(T0));
  });

  it("the same headers reach the budget identically through WP-260's onRateLimitUpdate observation", async () => {
    const seen: RateLimitObservation[] = [];
    const { factory, recorder } = createFakeSdkFactory();
    await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle, onRateLimitUpdate: (o) => seen.push(o) }, factory);
    const forward = recorder.factoryCalls[0]?.onRateLimitUpdate;
    // The SDK-shaped update the pinned SDK builds from the success headers (its `RateLimitUpdate`).
    forward?.({ bucket: "order" as never, remaining: 57, reset: 1782753360, tier: "standard", warning: false });
    expect(seen).toHaveLength(1);
    const viaSdk = feedbackFromObservation(seen[0]);
    const viaHeaders = parseRateLimitHeaders({ httpStatus: null, headers: fixtureHeaders("response-headers-success") });
    expect(viaSdk).toEqual(viaHeaders);
  });
});

describe("a 429 through the pinned SDK's HTTP layer → WP-260 → the budget", () => {
  it("Retry-After: 2 on a 429 arrives as RATE_LIMITED / retryAfterSeconds 2 and the bucket waits exactly 2000 ms", async () => {
    const headers = fixtureHeaders("response-headers-429");
    const serving = reinstall((url) => (url.startsWith(CLOB_ORIGIN) ? new Response(null, { status: 429, headers }) : undefined));
    const sdkError = await provokeSdkHttpRejection();
    expect(serving.answered()).toHaveLength(1);
    const { factory } = createFakeSdkFactory({
      postOrder: () => {
        throw sdkError;
      },
    });
    const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle }, factory);
    const signed = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size: "10" });
    if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");
    const outcome = await client.postOrder(signed.order);
    expect(outcome).toMatchObject({ kind: "UNKNOWN", error: { kind: "RATE_LIMITED", httpStatus: 429, retryAfterSeconds: 2, effect: "UNKNOWN" } });
    if (outcome.kind !== "UNKNOWN" || outcome.error === null) throw new Error("expected an UNKNOWN with an error");

    const budget = warmBudget();
    const grant = grantOf(placeOrder(budget, T0));
    const effects = budget.complete(grant, { atMs: T0, error: outcome.error, feedback: parseRateLimitHeaders({ httpStatus: 429, headers }) });
    expect(effects.ok && effects.value).toContainEqual({ kind: "WAIT_APPLIED", budget: { dimension: "SIGNER_ORDER_BUCKET", signer: SIGNER }, untilMs: T0 + 2000, basis: "RETRY_AFTER" });
    expect(placeOrder(budget, T0 + 1999).kind).toBe("QUEUED");
    expect(budget.poll(T0 + 2000).map((event) => event.kind)).toEqual(["GRANTED"]);
  });
});
