/**
 * Round-3 review pins (WP-260 r3). Each `describe` names the verifier finding
 * it pins; every test FAILS against candidate `ce73f78` and passes after the
 * fix, except those labelled "control" or "guard" (regression guards that
 * already held at `ce73f78`).
 *
 * - CX-R3-01: the pinned `@polymarket/client@0.11.0` `ServiceClient` keeps a
 *   JSON body's `code` only when the body's `error` is truthy and the code is
 *   a non-empty string. A 401 or 425 whose body carries a code next to a
 *   missing, empty or null `error` (or a non-string code, or a non-JSON body)
 *   therefore reaches the adapter with NO code. "No code" is never evidence
 *   of a clean refusal: 401/425 are effect UNKNOWN. Pinned THROUGH THE REAL
 *   SDK HTTP LAYER (an in-memory responder behind the network tripwire).
 * - I-R3-1 (folded into CX-R3-01): a `RequestRejectedError` 429 with no code
 *   is UNKNOWN too.
 */

import { RequestRejectedError } from "@polymarket/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyHttpRejection, mapVenueError } from "./error-mapping.js";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  provokeSdkHttpRejection,
  type FetchResponder,
  type NetworkTripwire,
} from "./testing/index.js";

const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });
const CLOB_ORIGIN = "https://clob.polymarket.com/";
const UNDOCUMENTED = "future_undocumented_code";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

interface Served {
  readonly status: number;
  readonly contentType?: string;
  readonly body?: string;
}

/** Serve one answer to the REAL SDK's public client and return what it throws. */
async function sdkErrorFor(served: Served): Promise<unknown> {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
  const responder: FetchResponder = (url) => {
    if (!url.startsWith(CLOB_ORIGIN)) return undefined;
    const headers = new Headers();
    if (served.contentType !== undefined) headers.set("content-type", served.contentType);
    return new Response(served.body ?? null, { status: served.status, headers });
  };
  tripwire = installNetworkTripwire({ responder });
  const error = await provokeSdkHttpRejection();
  expect(tripwire.answered()).toHaveLength(1);
  return error;
}

const json = (status: number, body: unknown): Served => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function outcomesFor(sdkError: unknown) {
  const { factory } = createFakeSdkFactory({
    postOrder: () => {
      throw sdkError;
    },
    cancelOrder: () => {
      throw sdkError;
    },
  });
  const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle }, factory);
  const signed = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size: "10" });
  if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");
  return { placed: await client.postOrder(signed.order), cancelled: await client.cancelOrder("order-1") };
}

const KIND_BY_STATUS: Readonly<Record<number, string>> = { 401: "AUTHENTICATION_REJECTED", 425: "ENGINE_RESTARTING" };

// ---------------------------------------------------------------------------

describe("CX-R3-01: a 401/425 whose code the pinned SDK dropped is effect UNKNOWN (never REFUSED)", () => {
  const lossyBodies: readonly [string, (status: number) => Served][] = [
    ["a JSON body with a code and NO `error`", (status) => json(status, { code: UNDOCUMENTED })],
    ["a JSON body with a code and an EMPTY `error`", (status) => json(status, { error: "", code: UNDOCUMENTED })],
    ["a JSON body with a code and a NULL `error`", (status) => json(status, { error: null, code: UNDOCUMENTED })],
    ["a JSON body with a code and a FALSE `error`", (status) => json(status, { error: false, code: UNDOCUMENTED })],
    ["a JSON body with a truthy `error` and a NUMERIC code", (status) => json(status, { error: "x", code: 7 })],
    ["a JSON body with a truthy `error` and an EMPTY code", (status) => json(status, { error: "x", code: "" })],
    ["a JSON body with only an `error`", (status) => json(status, { error: "x" })],
    ["a text/plain body", (status) => ({ status, contentType: "text/plain", body: `{"code":"${UNDOCUMENTED}"}` })],
    ["no body at all", (status) => ({ status })],
  ];

  describe.each([401, 425])("status %i", (status) => {
    it.each(lossyBodies)("%s, through the REAL SDK HTTP layer → placement and cancel UNKNOWN", async (_label, make) => {
      const sdkError = await sdkErrorFor(make(status));
      // What the pinned SDK actually builds: a RequestRejectedError with NO
      // `code`, whatever the venue put in the body.
      expect(sdkError).toBeInstanceOf(RequestRejectedError);
      expect((sdkError as RequestRejectedError).status).toBe(status);
      expect(Object.hasOwn(sdkError as object, "code") ? (sdkError as { code: unknown }).code : undefined).toBeUndefined();

      expect(mapVenueError(sdkError, "POST_ORDER").toData()).toMatchObject({
        kind: KIND_BY_STATUS[status],
        effect: "UNKNOWN",
        httpStatus: status,
        venueCode: null,
      });
      const { placed, cancelled } = await outcomesFor(sdkError);
      expect(placed).toMatchObject({ kind: "UNKNOWN", reason: "ERROR", error: { kind: KIND_BY_STATUS[status], effect: "UNKNOWN" } });
      expect(cancelled).toMatchObject({ kind: "UNKNOWN", error: { kind: KIND_BY_STATUS[status], effect: "UNKNOWN" } });
    });
  });

  it("the classification does not read the SDK message text: two 425s differing only in `error` text map identically", async () => {
    const first = mapVenueError(await sdkErrorFor(json(425, { error: "engine restarting" })), "POST_ORDER").toData();
    const second = mapVenueError(await sdkErrorFor(json(425, { error: "something else entirely" })), "POST_ORDER").toData();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ effect: "UNKNOWN" });
  });

  it("no status other than 503 with `post_only_mode` is ever NOT_APPLIED, with or without a code", () => {
    const readings = [
      { venueCode: null, undocumentedVenueCode: false },
      { venueCode: null, undocumentedVenueCode: true },
      { venueCode: "post_only_mode", undocumentedVenueCode: false },
    ] as const;
    const notApplied: string[] = [];
    for (let status = 100; status <= 599; status += 1) {
      for (const reading of readings) {
        if (classifyHttpRejection(status, reading).effect === "NOT_APPLIED") notApplied.push(`${status}:${String(reading.venueCode)}`);
      }
    }
    for (const reading of readings) {
      if (classifyHttpRejection(null, reading).effect === "NOT_APPLIED") notApplied.push(`null:${String(reading.venueCode)}`);
    }
    expect(notApplied).toEqual(["503:post_only_mode"]);
  });

  it("guard: a 401 whose body the SDK keeps (truthy `error`, undocumented code) is UNKNOWN and records the undocumented code", async () => {
    const sdkError = await sdkErrorFor(json(401, { error: "x", code: UNDOCUMENTED }));
    expect(mapVenueError(sdkError, "POST_ORDER").toData()).toMatchObject({
      kind: "AUTHENTICATION_REJECTED",
      effect: "UNKNOWN",
      undocumentedVenueCode: true,
    });
  });

  it("control: a 503 with the documented `post_only_mode` (kept by the SDK) is still REFUSED / NOT_APPLIED", async () => {
    const sdkError = await sdkErrorFor(json(503, { error: "x", code: "post_only_mode" }));
    const { placed } = await outcomesFor(sdkError);
    expect(placed).toMatchObject({ kind: "REFUSED", error: { kind: "POST_ONLY_MODE", effect: "NOT_APPLIED", cancelsAvailable: "YES" } });
  });

  it("control: a 503 with `post_only_mode` but a falsy `error` loses the code and is UNKNOWN (TRADING_UNAVAILABLE)", async () => {
    const sdkError = await sdkErrorFor(json(503, { error: "", code: "post_only_mode" }));
    expect(mapVenueError(sdkError, "POST_ORDER").toData()).toMatchObject({ kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN", venueCode: null });
  });
});

// ---------------------------------------------------------------------------

describe("I-R3-1: a RequestRejectedError 429 with no code is UNKNOWN (the pinned SDK never builds one; defence in depth)", () => {
  it("classifyHttpRejection(429, no code) → RATE_LIMITED, UNKNOWN", () => {
    expect(classifyHttpRejection(429, { venueCode: null, undocumentedVenueCode: false })).toEqual({
      kind: "RATE_LIMITED",
      effect: "UNKNOWN",
      cancelsAvailable: null,
    });
  });

  it("mapVenueError(RequestRejectedError 429, no code) → RATE_LIMITED, UNKNOWN", () => {
    expect(mapVenueError(new RequestRejectedError("slow", { status: 429 }), "POST_ORDER").toData()).toMatchObject({
      kind: "RATE_LIMITED",
      effect: "UNKNOWN",
      source: "RequestRejectedError",
    });
  });
});
