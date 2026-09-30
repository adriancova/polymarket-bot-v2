/**
 * The error taxonomy (handoff §9.12; ADR-007 §6–§7; U-4; C-9; E-05–E-07),
 * driven with REAL error instances of the pinned `@polymarket/client@0.11.0`.
 */

import {
  CancelledSigningError,
  RateLimitError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TradingRestriction,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
} from "@polymarket/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecureVenueError, type SecureVenueErrorData } from "./errors.js";
import { classifyHttpRejection, mapVenueError } from "./error-mapping.js";
import { installNetworkTripwire, type NetworkTripwire } from "./testing/network-tripwire.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

function data(error: unknown): SecureVenueErrorData {
  return mapVenueError(error, "POST_ORDER").toData();
}

describe("SDK error classes → kinds and effects", () => {
  it.each([
    [new UserInputError("bad"), "INVALID_REQUEST", "NOT_SENT"],
    [new SigningError("no sig"), "SIGNING_FAILED", "NOT_SENT"],
    [new CancelledSigningError("user said no"), "SIGNING_FAILED", "NOT_SENT"],
    [new RateLimitError("slow down", { retryAfter: 3 }), "RATE_LIMITED", "NOT_APPLIED"],
    [new TransportError("socket hang up"), "TRANSPORT_FAILURE", "UNKNOWN"],
    [new TimeoutError("waited"), "TIMEOUT", "UNKNOWN"],
    [new UnexpectedResponseError("shape"), "UNEXPECTED_RESPONSE", "UNKNOWN"],
    [new Error("plain"), "UNKNOWN", "UNKNOWN"],
    ["a thrown string", "UNKNOWN", "UNKNOWN"],
    [undefined, "UNKNOWN", "UNKNOWN"],
  ] as const)("%o → %s / %s", (error, kind, effect) => {
    const mapped = data(error);
    expect(mapped.kind).toBe(kind);
    expect(mapped.effect).toBe(effect);
  });

  it("a look-alike object named like an SDK error is UNKNOWN (instanceof, never the name)", () => {
    const lookalike = { name: "RequestRejectedError", status: 503, code: "post_only_mode", message: "x" };
    expect(data(lookalike)).toMatchObject({ kind: "UNKNOWN", effect: "UNKNOWN", source: "non-SDK" });
  });

  it("a rate-limit rejection carries its retry-after", () => {
    expect(data(new RateLimitError("slow", { retryAfter: 7 }))).toMatchObject({ httpStatus: 429, retryAfterSeconds: 7 });
  });
});

describe("HTTP rejections are classified by status and DOCUMENTED code only", () => {
  const rejected = (status: number, extra: { code?: string; retryAfter?: number; restriction?: TradingRestriction } = {}): RequestRejectedError =>
    new RequestRejectedError("venue text (https://clob.polymarket.com/order)", { status, ...extra });

  it("425 → ENGINE_RESTARTING, not applied, cancels unknown (E-06)", () => {
    expect(data(rejected(425, { restriction: TradingRestriction.RESTARTING, retryAfter: 1 }))).toEqual({
      kind: "ENGINE_RESTARTING",
      operation: "POST_ORDER",
      effect: "NOT_APPLIED",
      httpStatus: 425,
      venueCode: null,
      undocumentedVenueCode: false,
      retryAfterSeconds: 1,
      cancelsAvailable: "UNKNOWN",
      source: "RequestRejectedError",
    });
  });

  it("503 + post_only_mode → POST_ONLY_MODE, not applied, cancels available (venue report §9)", () => {
    expect(data(rejected(503, { code: "post_only_mode", retryAfter: 79, restriction: TradingRestriction.POST_ONLY }))).toMatchObject({
      kind: "POST_ONLY_MODE",
      effect: "NOT_APPLIED",
      venueCode: "post_only_mode",
      retryAfterSeconds: 79,
      cancelsAvailable: "YES",
    });
  });

  describe("C-9: a 503 without a documented code never implies cancels are available", () => {
    // The three official strings for one condition (venue report §11 C-9).
    const strings = [
      "trading is disabled",
      "Trading is currently disabled. Check polymarket.com for updates",
      "Trading is currently cancel-only. New orders are not accepted, but cancels are allowed.",
    ];
    it.each(strings)("%j → TRADING_UNAVAILABLE with cancelsAvailable UNKNOWN and effect UNKNOWN", (text) => {
      const mapped = data(new RequestRejectedError(text, { status: 503 }));
      expect(mapped).toMatchObject({
        kind: "TRADING_UNAVAILABLE",
        effect: "UNKNOWN",
        cancelsAvailable: "UNKNOWN",
        venueCode: null,
      });
    });

    it("the three strings produce IDENTICAL mappings (text is not consulted)", () => {
      const mapped = strings.map((text) => JSON.stringify(data(new RequestRejectedError(text, { status: 503 }))));
      expect(new Set(mapped).size).toBe(1);
    });

    it("the OpenAPI example NAMES (cancel_only, trading_disabled) sent as codes are undocumented, not cancel-only evidence", () => {
      for (const code of ["cancel_only", "trading_disabled"]) {
        expect(data(rejected(503, { code }))).toMatchObject({
          kind: "TRADING_UNAVAILABLE",
          cancelsAvailable: "UNKNOWN",
          venueCode: null,
          undocumentedVenueCode: true,
        });
      }
    });

    it("a cancel that meets a bare 503 is also UNKNOWN in effect", () => {
      expect(mapVenueError(rejected(503), "CANCEL_ALL").toData()).toMatchObject({
        kind: "TRADING_UNAVAILABLE",
        effect: "UNKNOWN",
        operation: "CANCEL_ALL",
      });
    });
  });

  it("401 → AUTHENTICATION_REJECTED, not applied", () => {
    expect(data(rejected(401))).toMatchObject({ kind: "AUTHENTICATION_REJECTED", effect: "NOT_APPLIED" });
  });

  it.each([400, 403, 404, 409, 422, 500, 502, 504, 200])("status %i with no documented code → REQUEST_REJECTED, effect UNKNOWN (U-4)", (status) => {
    expect(data(rejected(status))).toMatchObject({ kind: "REQUEST_REJECTED", effect: "UNKNOWN", venueCode: null });
  });

  it("U-4: an undocumented code — including an SDK-head-style inferred snake_case code — is never adopted", () => {
    for (const code of ["invalid_order_payload", "address_banned", "closed_only_mode", "UNKNOWN", "post_only_mode "]) {
      expect(data(rejected(400, { code }))).toMatchObject({
        kind: "REQUEST_REJECTED",
        effect: "UNKNOWN",
        venueCode: null,
        undocumentedVenueCode: true,
      });
    }
  });

  it("post_only_mode on a non-503 status is not a post-only-mode restriction", () => {
    expect(data(rejected(400, { code: "post_only_mode" }))).toMatchObject({ kind: "REQUEST_REJECTED", venueCode: "post_only_mode" });
  });

  it("the SDK's `restriction` field alone does not decide: status does", () => {
    expect(data(rejected(500, { restriction: TradingRestriction.RESTARTING }))).toMatchObject({ kind: "REQUEST_REJECTED" });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 86_401])("an out-of-range retry-after %s is dropped", (retryAfter) => {
    expect(data(rejected(425, { retryAfter }))).toMatchObject({ retryAfterSeconds: null });
  });

  it("reads status/code as own DATA properties: a getter is never invoked", () => {
    const error = rejected(503);
    let invoked = false;
    Object.defineProperty(error, "code", {
      get: () => {
        invoked = true;
        return "post_only_mode";
      },
    });
    expect(data(error)).toMatchObject({ kind: "TRADING_UNAVAILABLE", venueCode: null });
    expect(invoked).toBe(false);
  });

  it("classifyHttpRejection covers 429 for an HTTP rejection that is not a RateLimitError", () => {
    expect(classifyHttpRejection(429, null)).toEqual({ kind: "RATE_LIMITED", effect: "NOT_APPLIED", cancelsAvailable: null });
  });
});

describe("mapped errors are plain, typed and re-mappable", () => {
  it("re-mapping a SecureVenueError keeps its data and changes only the operation", () => {
    const first = mapVenueError(new TransportError("x"), "POST_ORDER");
    const second = mapVenueError(first, "POST_ORDERS");
    expect(second).toBeInstanceOf(SecureVenueError);
    expect(second.toData()).toEqual({ ...first.toData(), operation: "POST_ORDERS" });
  });

  it("the message is a fixed sentence: never the SDK's message", () => {
    const mapped = mapVenueError(new RequestRejectedError("the order signer address has to be the address of the API KEY", { status: 400 }), "POST_ORDER");
    expect(mapped.message).toBe("POST_ORDER: REQUEST_REJECTED: the venue rejected the request with an unclassified status or code (U-4)");
  });
});
