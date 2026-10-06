/**
 * V2-5 pins (the SDK re-pin `@polymarket/client` 0.11.0 → 0.12.0; Protocol V2
 * plan rows C3-C6). Each `describe` names what it pins. Every test FAILS at
 * the base `450b958` (0.11.0, before V2-5), except those labelled "guard" or
 * "control", which are regression guards that already held there.
 *
 * - RULE 4c: 0.12.0's `ServiceClient` INFERS a `code` from a snake_case
 *   `error` text (any status but 400). An inferred `post_only_mode` must
 *   never become the documented refusal (`NOT_APPLIED`, cancels `YES`):
 *   `error-mapping.ts` withdraws trust from a documented code whenever the
 *   SDK could have inferred it. Pinned THROUGH THE REAL SDK HTTP LAYER (an
 *   in-memory responder behind the network tripwire), on both the public
 *   client and the authenticated `POST /order` path.
 * - C6: the `0x…` hex branch is gone from every asset-id grammar of the
 *   package: the venue client's `ASSET_ID`, the signed order's `TOKEN_ID` and
 *   the user stream's `ASSET_ID`.
 * - C4: the SDK port is the same ten members, with no `place*`.
 * - LOGGABLE_ERROR_NAMES covers the pinned SDK's error classes.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RequestRejectedError } from "@polymarket/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { mapVenueError } from "./error-mapping.js";
import { LOGGABLE_ERROR_NAMES } from "./redaction.js";
import type { SdkSecureClientPort } from "./sdk-port.js";
import { SignedOrderEnvelope } from "./signed-order.js";
import {
  contractVenueResponder,
  createFakeSdkFactory,
  createMockSignerHandle,
  createPinnedSdkFactoryForContract,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  MOCK_SIGNER_ADDRESS,
  pinnedSdkErrorClassNames,
  provokeSdkHttpRejection,
  type FetchResponder,
  type NetworkTripwire,
} from "./testing/index.js";
import { readAssetId } from "./user-stream/wire.js";

const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });
const CLOB_ORIGIN = "https://clob.polymarket.com/";
const SRC = path.dirname(fileURLToPath(import.meta.url));

/** An observed Polymarket V2 position id (venue report 2026-10-05 F-44, S-L01): 75 decimal digits. */
const V2_POSITION_ID = "663574927012476832975694178961957910328055987427402067619466963999000625152";
/** The same id in hex: the form C6 removes. */
const V2_POSITION_ID_HEX = `0x${BigInt(V2_POSITION_ID).toString(16)}`;

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Serve one answer to the REAL SDK's public client and return what it throws. */
async function publicSdkErrorFor(response: () => Response): Promise<unknown> {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
  const responder: FetchResponder = (url) => (url.startsWith(CLOB_ORIGIN) ? response() : undefined);
  tripwire = installNetworkTripwire({ responder });
  const error = await provokeSdkHttpRejection();
  expect(tripwire.answered()).toHaveLength(1);
  return error;
}

/** Run an SDK error through a venue client's postOrder and cancelOrder (a fake SDK that throws it). */
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

/** The documented post-only body (`test/fixtures/venue/orders/restricted-modes.json`, `http-503-post-only`). */
const DOCUMENTED_POST_ONLY_BODY = {
  error: "post-only mode: only post-only orders and cancels are allowed",
  code: "post_only_mode",
  retry_after_seconds: 79,
};

/** A persisted-shape signed order (mock signature, never valid) for the POST path. */
function persistedEnvelope(): SignedOrderEnvelope {
  const envelope = SignedOrderEnvelope.fromPersistedPayload({
    builder: `0x${"0".repeat(64)}`,
    expiration: 0,
    maker: MOCK_SIGNER_ADDRESS,
    makerAmount: "5200000",
    metadata: `0x${"0".repeat(64)}`,
    orderType: "GTC",
    salt: "12345",
    side: "BUY",
    signature: `0x${"00".repeat(65)}`,
    signatureType: 0,
    signer: MOCK_SIGNER_ADDRESS,
    takerAmount: "10000000",
    timestamp: "1767225600000",
    tokenId: V2_POSITION_ID,
  });
  if (envelope === undefined) throw new Error("fixture envelope refused");
  return envelope;
}

/** Post one order through a venue client over the REAL SDK, answering `POST /order` with `answer`. */
async function realSdkPostOutcome(answer: () => Response) {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
  const venue = contractVenueResponder({ markets: [], other: (request) => (request.method === "POST" && request.path === "/order" ? answer() : undefined) });
  tripwire = installNetworkTripwire({ responder: venue.responder });
  const client = await createSecureVenueClientForTesting(
    { runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle, wallet: MOCK_SIGNER_ADDRESS },
    createPinnedSdkFactoryForContract(),
  );
  const outcome = await client.postOrder(persistedEnvelope());
  await client.close();
  expect(venue.requests().filter((request) => request.method === "POST" && request.path === "/order")).toHaveLength(1);
  return outcome;
}

// ---------------------------------------------------------------------------

describe("rule 4c: the pinned 0.12.0 SDK infers codes from text; an inferred `post_only_mode` is never the documented refusal", () => {
  it("the SDK fact that forces the rule: a 503 whose JSON `error` is the bare identifier `post_only_mode` (no `code`) reaches the adapter WITH code `post_only_mode`", async () => {
    const sdkError = await publicSdkErrorFor(() => json(503, { error: "post_only_mode" }));
    expect(sdkError).toBeInstanceOf(RequestRejectedError);
    expect((sdkError as RequestRejectedError).code).toBe("post_only_mode");
  });

  it("that inferred code maps to TRADING_UNAVAILABLE / UNKNOWN (cancels UNKNOWN), never POST_ONLY_MODE / NOT_APPLIED", async () => {
    const sdkError = await publicSdkErrorFor(() => json(503, { error: "post_only_mode" }));
    expect(mapVenueError(sdkError, "POST_ORDER").toData()).toMatchObject({
      kind: "TRADING_UNAVAILABLE",
      effect: "UNKNOWN",
      cancelsAvailable: "UNKNOWN",
      httpStatus: 503,
      venueCode: null,
      undocumentedVenueCode: true,
    });
    const { placed, cancelled } = await outcomesFor(sdkError);
    expect(placed).toMatchObject({ kind: "UNKNOWN", reason: "ERROR", error: { kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN" } });
    expect(cancelled).toMatchObject({ kind: "UNKNOWN", error: { kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN" } });
  });

  it("the same through the authenticated POST /order path of the REAL SDK (its `mapTradingRestrictionError` re-wrap keeps the message): UNKNOWN", async () => {
    const outcome = await realSdkPostOutcome(() => json(503, { error: "post_only_mode" }));
    expect(outcome).toMatchObject({ kind: "UNKNOWN", reason: "ERROR", error: { kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN", venueCode: null } });
  });

  it("fail-closed corner: a body that sends the code explicitly but whose `error` text IS the code is UNKNOWN too", async () => {
    const sdkError = await publicSdkErrorFor(() => json(503, { error: "post_only_mode", code: "post_only_mode" }));
    expect(mapVenueError(sdkError, "POST_ORDER").toData()).toMatchObject({ kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN", venueCode: null });
  });

  it("control: the DOCUMENTED post-only body (sentence `error`, explicit code) stays REFUSED / NOT_APPLIED / cancels YES", async () => {
    const sdkError = await publicSdkErrorFor(() => json(503, DOCUMENTED_POST_ONLY_BODY));
    const { placed } = await outcomesFor(sdkError);
    expect(placed).toMatchObject({ kind: "REFUSED", error: { kind: "POST_ONLY_MODE", effect: "NOT_APPLIED", cancelsAvailable: "YES", retryAfterSeconds: 79 } });
  });

  it("control: the documented post-only body through the REAL SDK's POST /order path is REFUSED", async () => {
    const outcome = await realSdkPostOutcome(() => json(503, DOCUMENTED_POST_ONLY_BODY));
    expect(outcome).toMatchObject({ kind: "REFUSED", error: { kind: "POST_ONLY_MODE", effect: "NOT_APPLIED" } });
  });

  it("guard: the SDK does not infer on a 400, so a 400 `post_only_mode` text carries no code at all", async () => {
    const sdkError = await publicSdkErrorFor(() => json(400, { error: "post_only_mode" }));
    expect((sdkError as RequestRejectedError).code).toBeUndefined();
    expect(mapVenueError(sdkError, "POST_ORDER").toData()).toMatchObject({ kind: "REQUEST_REJECTED", effect: "UNKNOWN", venueCode: null, undocumentedVenueCode: false });
  });

  it("an inferred UNDOCUMENTED code is recorded as the bare fact (never its value) and stays UNKNOWN", async () => {
    const sdkError = await publicSdkErrorFor(() => json(422, { error: "signer_does_not_match_account" }));
    expect((sdkError as RequestRejectedError).code).toBe("signer_does_not_match_account");
    const data = mapVenueError(sdkError, "POST_ORDER").toData();
    expect(data).toMatchObject({ kind: "REQUEST_REJECTED", effect: "UNKNOWN", venueCode: null, undocumentedVenueCode: true });
    expect(JSON.stringify(data)).not.toContain("signer_does_not_match_account");
  });

  describe("the provenance test itself, on hand-built SDK errors", () => {
    const URL_SUFFIX = " (https://clob.polymarket.com/order)";
    it("a message that begins with the code and ` (` (what the SDK builds for an inferred code) → unprovable → UNKNOWN", () => {
      const error = new RequestRejectedError(`post_only_mode${URL_SUFFIX}`, { status: 503, code: "post_only_mode" });
      expect(mapVenueError(error, "POST_ORDER").toData()).toMatchObject({
        kind: "TRADING_UNAVAILABLE",
        effect: "UNKNOWN",
        venueCode: null,
        undocumentedVenueCode: true,
      });
    });

    it("control: the bare code with no ` (` after it cannot be an SDK-built inferred message → POST_ONLY_MODE / NOT_APPLIED", () => {
      const error = new RequestRejectedError("post_only_mode", { status: 503, code: "post_only_mode" });
      expect(mapVenueError(error, "POST_ORDER").toData()).toMatchObject({ kind: "POST_ONLY_MODE", effect: "NOT_APPLIED" });
    });

    it("a message that is an own ACCESSOR is unprovable, and its getter is never invoked", () => {
      const error = new RequestRejectedError("x", { status: 503, code: "post_only_mode" });
      let read = false;
      Object.defineProperty(error, "message", {
        get() {
          read = true;
          return "x";
        },
      });
      expect(mapVenueError(error, "POST_ORDER").toData()).toMatchObject({ kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN", venueCode: null });
      expect(read).toBe(false);
    });

    it("a missing or non-string message is unprovable", () => {
      for (const value of [undefined, 7, null]) {
        const error = new RequestRejectedError("x", { status: 503, code: "post_only_mode" });
        Object.defineProperty(error, "message", { value, configurable: true });
        expect(mapVenueError(error, "POST_ORDER").toData()).toMatchObject({ kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN" });
      }
    });

    it("control: a sentence message with the documented code is POST_ONLY_MODE / NOT_APPLIED", () => {
      const error = new RequestRejectedError(`post-only mode: only post-only orders and cancels are allowed${URL_SUFFIX}`, { status: 503, code: "post_only_mode" });
      expect(mapVenueError(error, "POST_ORDER").toData()).toMatchObject({ kind: "POST_ONLY_MODE", effect: "NOT_APPLIED", cancelsAvailable: "YES" });
    });

    it("the message is never carried: no rendering of the mapped error contains it", () => {
      const marker = "post_only_mode (https://clob.polymarket.com/order?secret-marker-V25)";
      const error = new RequestRejectedError(marker, { status: 503, code: "post_only_mode" });
      const mapped = mapVenueError(error, "POST_ORDER");
      expect(JSON.stringify(mapped.toData())).not.toContain("secret-marker-V25");
      expect(String(mapped)).not.toContain("secret-marker-V25");
    });
  });
});

// ---------------------------------------------------------------------------

describe("C6: asset ids are decimal strings; the `0x…` hex branch is removed", () => {
  async function setup() {
    const { handle, probe } = createMockSignerHandle();
    const { factory, recorder } = createFakeSdkFactory();
    const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: handle }, factory);
    return { client, probe, recorder };
  }

  it.each([
    ["the V2 id in hex", V2_POSITION_ID_HEX],
    ["a short hex id", "0x1"],
    ["an upper-case hex id", `0X${"A".repeat(10)}`],
    ["a 64-digit hex id", `0x${"f".repeat(64)}`],
  ])("createLimitOrder refuses %s locally: FAILED / INVALID_REQUEST, the SDK and the signer are never reached", async (_label, assetId) => {
    const { client, probe, recorder } = await setup();
    const outcome = await client.createLimitOrder({ assetId, side: "BUY", price: "0.52", size: "10" });
    expect(outcome).toMatchObject({ kind: "FAILED", error: { kind: "INVALID_REQUEST", effect: "NOT_SENT" } });
    expect(recorder.calls.get("createLimitOrder") ?? 0).toBe(0);
    expect(probe.signTypedDataCalls).toBe(0);
  });

  it("cancelMarketOrders refuses a hex asset id: NOT_SENT, the SDK is never reached", async () => {
    const { client, recorder } = await setup();
    const outcome = await client.cancelMarketOrders({ assetId: V2_POSITION_ID_HEX });
    expect(outcome).toMatchObject({ kind: "NOT_SENT", error: { kind: "INVALID_REQUEST" } });
    expect(recorder.calls.get("cancelMarketOrders") ?? 0).toBe(0);
  });

  it("guard: the same V2 id in DECIMAL (75 digits) is accepted by both", async () => {
    const { client, recorder } = await setup();
    expect(await client.createLimitOrder({ assetId: V2_POSITION_ID, side: "BUY", price: "0.52", size: "10" })).toMatchObject({ kind: "SIGNED" });
    expect(await client.cancelMarketOrders({ assetId: V2_POSITION_ID })).toMatchObject({ kind: "COMPLETED" });
    expect(recorder.calls.get("cancelMarketOrders")).toBe(1);
  });

  it("guard: the decimal grammar is bounded at 78 digits (a uint256) and has no leading zero", async () => {
    const { client } = await setup();
    expect(await client.createLimitOrder({ assetId: `1${"0".repeat(77)}`, side: "BUY", price: "0.52", size: "10" })).toMatchObject({ kind: "SIGNED" });
    for (const assetId of [`1${"0".repeat(78)}`, `0${V2_POSITION_ID}`, ""]) {
      expect(await client.createLimitOrder({ assetId, side: "BUY", price: "0.52", size: "10" })).toMatchObject({ kind: "FAILED", error: { kind: "INVALID_REQUEST" } });
    }
  });

  it("a persisted signed order whose tokenId is hex is not re-created (TOKEN_ID); the decimal one is", () => {
    const decimal = persistedEnvelope().revealPayloadForEncryptedPersistence();
    expect(SignedOrderEnvelope.fromPersistedPayload({ ...decimal })).toBeDefined();
    expect(SignedOrderEnvelope.fromPersistedPayload({ ...decimal, tokenId: V2_POSITION_ID_HEX })).toBeUndefined();
  });

  it("the user stream refuses a hex `asset_id` (readAssetId) and keeps the decimal one exactly", () => {
    expect(readAssetId(V2_POSITION_ID_HEX)).toBeUndefined();
    expect(readAssetId("0x1")).toBeUndefined();
    expect(readAssetId(V2_POSITION_ID)).toBe(V2_POSITION_ID);
  });
});

// ---------------------------------------------------------------------------

describe("C4: the SDK port is the same ten members, and none is `place*`", () => {
  it("guard (type level, enforced by typecheck): exactly the ten WP-260 members", () => {
    expectTypeOf<keyof SdkSecureClientPort>().toEqualTypeOf<
      | "account"
      | "createLimitOrder"
      | "postOrder"
      | "postOrders"
      | "cancelOrder"
      | "cancelOrders"
      | "cancelMarketOrders"
      | "cancelAll"
      | "fetchOrder"
      | "closeSubscriptions"
    >();
    expectTypeOf<Extract<keyof SdkSecureClientPort, `place${string}`>>().toBeNever();
  });

  it("guard: no non-test source of the package names a `place*` member (TypeScript parse of every file)", async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const source = ts.createSourceFile(full, await readFile(full, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
          const visit = (node: ts.Node): void => {
            const name =
              ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
            if (name !== undefined && /^place[A-Z]/u.test(name)) offenders.push(`${path.relative(SRC, full)}: ${name}`);
            ts.forEachChild(node, visit);
          };
          visit(source);
        }
      }
    };
    await walk(SRC);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("LOGGABLE_ERROR_NAMES covers the pinned SDK's error classes", () => {
  /** RFQ is outside the port: its four rejection classes are not in the WP-260 list, deliberately (they log as `Error`). */
  const RFQ_ONLY = /^Rfq[A-Za-z]*Error$/u;

  it("every Error subclass the SDK root exports is loggable by name, except the RFQ-only classes", () => {
    const sdkClasses = pinnedSdkErrorClassNames();
    expect(sdkClasses).toEqual(expect.arrayContaining(["RequestRejectedError", "RateLimitError", "TransportError", "PaginationLimitError", "OperationAbortedError", "PerpsCancelRetryError"]));
    expect(sdkClasses.filter((name) => !RFQ_ONLY.test(name) && !LOGGABLE_ERROR_NAMES.has(name))).toEqual([]);
  });
});
