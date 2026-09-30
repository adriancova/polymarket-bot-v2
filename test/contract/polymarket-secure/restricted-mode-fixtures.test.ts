/**
 * Contract: matching-engine restricted-mode HTTP responses → the PINNED
 * SDK's own HTTP error construction (`ServiceClient` → `RequestRejectedError`
 * / `RateLimitError`, `@polymarket/client@0.11.0`) → the secure client's
 * outcome (venue report 2026-09-30 §9, E-05, E-06, §2.4; conflict C-9; U-4).
 *
 * The SDK is driven with one unauthenticated public-client request whose
 * `fetch` is answered by an IN-MEMORY responder from the fixture; the network
 * tripwire refuses anything else. No authenticated endpoint is involved and
 * no request leaves the process.
 *
 * Fixture: `test/fixtures/venue/orders/restricted-modes.json` (2026-08-24).
 * Its cancel-only string is ONE side of conflict C-9; the 2026-09-30 report
 * quotes two more official strings for the same condition, and all three are
 * served below and must map identically (classification by status and
 * documented code only, never by text).
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../../fixtures/venue/orders/restricted-modes.json");
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

/** Swap the plain tripwire for one whose fetch answers from `responder` (still refusing everything else). */
function reinstall(responder?: FetchResponder): NetworkTripwire {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
  tripwire = installNetworkTripwire(responder === undefined ? {} : { responder });
  return tripwire;
}

function responseOf(fixture: HttpFixture): Response {
  const headers = new Headers(fixture.headers ?? {});
  if (fixture.body !== undefined) headers.set("content-type", "application/json");
  return new Response(fixture.body === undefined ? null : JSON.stringify(fixture.body), { status: fixture.http_status, headers });
}

/** Serve `fixture` to the SDK, capture what the SDK throws, and run it through the client's postOrder. */
async function outcomeFor(fixture: HttpFixture): Promise<{ outcome: PlacementOutcome; sdkRequests: number; requestUrls: string[] }> {
  const serving = reinstall((url) => (url.startsWith(CLOB_ORIGIN) ? responseOf(fixture) : undefined));
  const sdkError = await provokeSdkHttpRejection();
  const requestUrls = serving.answered().map((attempt) => attempt.target);
  const { factory } = createFakeSdkFactory({
    postOrder: () => {
      throw sdkError;
    },
  });
  const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle }, factory);
  const signed = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size: "10" });
  if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");
  return { outcome: await client.postOrder(signed.order), sdkRequests: requestUrls.length, requestUrls };
}

describe("orders/restricted-modes fixture through the pinned SDK's HTTP layer", async () => {
  const file = JSON.parse(await readFile(FIXTURE, "utf8")) as {
    readonly fixture: string;
    readonly examples: readonly { readonly name: string; readonly payload: HttpFixture }[];
  };
  const example = (name: string): HttpFixture => {
    const found = file.examples.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`fixture example ${name} is missing`);
    return found.payload;
  };

  it("is the fixture this suite was written against", () => {
    expect(file.fixture).toBe("orders/restricted-modes");
    expect(file.examples.map((entry) => entry.name).sort()).toEqual([
      "http-425-engine-restarting-body-undocumented",
      "http-503-cancel-only",
      "http-503-post-only",
    ]);
  });

  // CX-R3-01: UNKNOWN, not REFUSED. The pinned SDK drops a 425 body's code
  // unless its `error` is truthy, so a code-less 425 does not prove the venue
  // sent no code (ADR-007 §6). The kind still says ENGINE_RESTARTING.
  it("425 with no body (U-9) → UNKNOWN / ENGINE_RESTARTING, cancels UNKNOWN (CX-R3-01)", async () => {
    const { outcome, sdkRequests, requestUrls } = await outcomeFor(example("http-425-engine-restarting-body-undocumented"));
    expect(sdkRequests).toBe(1);
    expect(requestUrls[0]?.startsWith(CLOB_ORIGIN)).toBe(true);
    expect(outcome).toMatchObject({
      kind: "UNKNOWN",
      error: { kind: "ENGINE_RESTARTING", httpStatus: 425, effect: "UNKNOWN", cancelsAvailable: "UNKNOWN" },
    });
  });

  it("503 post-only (code post_only_mode, Retry-After 79) → REFUSED / POST_ONLY_MODE, retry 79 s, cancels YES", async () => {
    const { outcome } = await outcomeFor(example("http-503-post-only"));
    expect(outcome).toMatchObject({
      kind: "REFUSED",
      error: {
        kind: "POST_ONLY_MODE",
        httpStatus: 503,
        venueCode: "post_only_mode",
        retryAfterSeconds: 79,
        cancelsAvailable: "YES",
      },
    });
  });

  describe("C-9: three official strings for cancel-only / disabled trading, one mapping", () => {
    const bodies: readonly [string, HttpFixture][] = [
      ["the 2026-08-24 fixture (cancel-only)", { http_status: 503, body: { error: "Trading is currently cancel-only. New orders are not accepted, but cancels are allowed." } }],
      ["the 2026-09-30 matching-engine guide", { http_status: 503, body: { error: "trading is disabled" } }],
      ["the 2026-09-30 OpenAPI trading_disabled example", { http_status: 503, body: { error: "Trading is currently disabled. Check polymarket.com for updates" } }],
    ];

    it("the fixture's own cancel-only example is the first of them", () => {
      expect(example("http-503-cancel-only")).toEqual(bodies[0]?.[1]);
    });

    it.each(bodies)("%s → UNKNOWN / TRADING_UNAVAILABLE, cancels UNKNOWN (never inferred from text)", async (_label, fixture) => {
      const { outcome } = await outcomeFor(fixture);
      expect(outcome).toMatchObject({
        kind: "UNKNOWN",
        reason: "ERROR",
        error: { kind: "TRADING_UNAVAILABLE", httpStatus: 503, venueCode: null, cancelsAvailable: "UNKNOWN", effect: "UNKNOWN" },
      });
    });

    it("all three produce byte-identical outcomes", async () => {
      const rendered: string[] = [];
      for (const [, fixture] of bodies) {
        rendered.push(JSON.stringify((await outcomeFor(fixture)).outcome));
      }
      expect(new Set(rendered).size).toBe(1);
    });
  });

  it("U-4: an undocumented code on a 400 is REQUEST_REJECTED with the code withheld, effect UNKNOWN", async () => {
    const { outcome } = await outcomeFor({ http_status: 400, body: { error: "Invalid order payload", code: "invalid_order_payload" } });
    expect(outcome).toMatchObject({
      kind: "UNKNOWN",
      error: { kind: "REQUEST_REJECTED", httpStatus: 400, venueCode: null, undocumentedVenueCode: true },
    });
  });

  // WP-260 r2 (CX-R2-02): the pinned SDK throws RateLimitError for every 429
  // BEFORE it reads the body, so any venue code is discarded and "no code"
  // cannot be established: the effect is UNKNOWN (ADR-007 §6); the kind stays
  // RATE_LIMITED so a caller still backs off.
  it("429 → UNKNOWN / RATE_LIMITED (the SDK discards the body)", async () => {
    const { outcome } = await outcomeFor({ http_status: 429, headers: { "Retry-After": "2" } });
    expect(outcome).toMatchObject({ kind: "UNKNOWN", error: { kind: "RATE_LIMITED", effect: "UNKNOWN", retryAfterSeconds: 2 } });
  });

  it("429 with an undocumented code in the body → UNKNOWN / RATE_LIMITED (never REFUSED)", async () => {
    const { outcome } = await outcomeFor({ http_status: 429, body: { error: "x", code: "future_undocumented_code" } });
    expect(outcome).toMatchObject({ kind: "UNKNOWN", error: { kind: "RATE_LIMITED", effect: "UNKNOWN" } });
  });

  // WP-260 r3 (CX-R3-01): the pinned SDK keeps a JSON body's `code` only
  // when the body's `error` is truthy, so these 401/425 answers reach the
  // adapter WITHOUT their code. "No code" is unproven: the effect is UNKNOWN.
  describe.each([401, 425])("%i whose body code the pinned SDK drops → UNKNOWN (never REFUSED)", (status) => {
    it.each([
      ["no `error`", { code: "future_undocumented_code" }],
      ["an empty `error`", { error: "", code: "future_undocumented_code" }],
      ["a null `error`", { error: null, code: "future_undocumented_code" }],
    ])("body with %s and an undocumented code", async (_label, body) => {
      const { outcome } = await outcomeFor({ http_status: status, body });
      expect(outcome).toMatchObject({ kind: "UNKNOWN", error: { httpStatus: status, effect: "UNKNOWN" } });
    });
  });

  it("with no responder the SDK's request is refused by the tripwire and surfaces as a transport failure", async () => {
    const sdkError = await provokeSdkHttpRejection();
    const refused = tripwire.refused();
    // Observed: the pinned SDK retries a GET that fails in transport (three
    // attempts here). Every attempt was refused, and every one was aimed at
    // the SDK's production CLOB origin.
    expect(refused.length).toBeGreaterThanOrEqual(1);
    for (const attempt of refused) {
      expect(attempt.via).toBe("fetch");
      expect(attempt.target.startsWith(CLOB_ORIGIN)).toBe(true);
    }
    // A fresh tripwire guards the rest of the test (and is checked in afterEach).
    tripwire.uninstall();
    tripwire = installNetworkTripwire();
    const { factory } = createFakeSdkFactory({
      postOrder: () => {
        throw sdkError;
      },
    });
    const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle }, factory);
    const signed = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size: "10" });
    if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");
    expect(await client.postOrder(signed.order)).toMatchObject({ kind: "UNKNOWN", error: { kind: "TRANSPORT_FAILURE" } });
  });
});
