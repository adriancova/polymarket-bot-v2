/**
 * Round-2 review pins (WP-260 r2). Each `describe` names the verifier finding
 * it pins; every test FAILS against candidate `d26024e` and passes after the
 * fix, except those labelled "control" or "guard" (regression guards that
 * already held at `d26024e`).
 *
 * - CX-R2-01: `postOrders` never uses the SDK response array's own methods
 *   (`map`, species, iterator); it copies own data entries into a fresh plain
 *   array with one slot per SUBMITTED order, and an unreadable slot is UNKNOWN.
 * - CX-R2-02: every 429 from the pinned SDK is effect UNKNOWN (kind
 *   RATE_LIMITED): the SDK throws `RateLimitError` before it reads the body,
 *   so the venue's code is discarded. Pinned THROUGH THE REAL SDK HTTP LAYER
 *   (an in-memory responder behind the network tripwire).
 * - CX-R2-03: an own ACCESSOR `code` on an SDK error is "present but
 *   unreadable", never "no code": 401/425/429 with one are UNKNOWN, and the
 *   getter is never invoked.
 * - L-R2-2: the signed order's maker, signer and signature type must be the
 *   ones the pinned SDK derives from the account, and builder/metadata must
 *   be bytes32(0).
 */

import { inspect } from "node:util";

import { RateLimitError, RequestRejectedError } from "@polymarket/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mapVenueError } from "./error-mapping.js";
import { redactForLog } from "./redaction.js";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  MOCK_SIGNER_ADDRESS,
  provokeSdkHttpRejection,
  type FakeSdkScript,
  type FetchResponder,
  type NetworkTripwire,
} from "./testing/index.js";

const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });
const SECRET = "sk-FAKE-R2-SECRET-0123456789abcdefFEDCBA";
const CLOB_ORIGIN = "https://clob.polymarket.com/";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

function renderings(value: unknown): string[] {
  const out = [inspect(value, { depth: 12, showHidden: true, getters: false })];
  try {
    out.push(JSON.stringify(value) ?? "");
  } catch {
    out.push("[unserialisable]");
  }
  out.push(JSON.stringify(redactForLog(value)) ?? "");
  return out;
}

function expectNoSecret(value: unknown): void {
  for (const text of renderings(value)) expect(text).not.toContain(SECRET);
}

async function setup(script: FakeSdkScript = {}) {
  const { handle } = createMockSignerHandle();
  const { factory, recorder } = createFakeSdkFactory(script);
  const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: handle }, factory);
  return { client, recorder };
}

const REQUEST = { assetId: "12345", side: "BUY", price: "0.52", size: "10" } as const;

async function signedWith(client: Awaited<ReturnType<typeof setup>>["client"]) {
  const signed = await client.createLimitOrder(REQUEST);
  if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");
  return signed.order;
}

const acceptedResponse = (orderId: string) => ({
  ok: true,
  orderId,
  status: "live",
  makingAmount: "0",
  takingAmount: "0",
  tradeIds: [],
  transactionsHashes: [],
});

const GENUINE_ID = `0x${"a".repeat(64)}`;

// ---------------------------------------------------------------------------

describe("CX-R2-01: postOrders never runs the SDK response array's own methods", () => {
  it("an overridden `map` is never called; the genuine entries are what is mapped", async () => {
    let mapCalled = false;
    const { client } = await setup({
      postOrders: () => {
        const answer: unknown[] = [acceptedResponse(GENUINE_ID)];
        Object.defineProperty(answer, "map", {
          value: () => {
            mapCalled = true;
            return [{ kind: "ACCEPTED", orderId: "fabricated", apiKey: SECRET }];
          },
        });
        return answer;
      },
    });
    const outcomes = await client.postOrders([await signedWith(client)]);
    expect(mapCalled).toBe(false);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ kind: "ACCEPTED", orderId: GENUINE_ID });
    expectNoSecret(outcomes);
  });

  it("a Symbol.species subclass with a throwing `then` getter cannot make postOrders reject", async () => {
    class Species extends Array<unknown> {
      get then(): never {
        throw new Error(`then ${SECRET}`);
      }
    }
    class Evil extends Array<unknown> {
      static override get [Symbol.species](): ArrayConstructor {
        return Species as unknown as ArrayConstructor;
      }
    }
    const { client } = await setup({ postOrders: () => Evil.from([acceptedResponse(GENUINE_ID)]) });
    const signed = await signedWith(client);
    let result: { ok: unknown } | { threw: unknown };
    try {
      result = { ok: await client.postOrders([signed]) };
    } catch (error) {
      result = { threw: error };
    }
    expect(result).toHaveProperty("ok");
    const outcomes = (result as { ok: readonly unknown[] }).ok;
    expect(Object.getPrototypeOf(outcomes)).toBe(Array.prototype);
    expect(outcomes[0]).toMatchObject({ kind: "ACCEPTED", orderId: GENUINE_ID });
    expectNoSecret(result);
  });

  it("a sparse answer yields an UNKNOWN outcome in every submitted position, never a hole", async () => {
    const { client } = await setup({ postOrders: () => new Array(2) });
    const outcomes = await client.postOrders([await signedWith(client), await signedWith(client)]);
    expect(outcomes).toHaveLength(2);
    for (let index = 0; index < 2; index += 1) {
      expect(index in outcomes, `slot ${index}`).toBe(true);
      expect(outcomes[index]).toMatchObject({ kind: "UNKNOWN", reason: "UNRECOGNISED_RESPONSE" });
    }
  });

  it("an accessor entry is never invoked; only that slot is UNKNOWN", async () => {
    let invoked = false;
    const { client } = await setup({
      postOrders: () => {
        const answer: unknown[] = [acceptedResponse(GENUINE_ID), undefined];
        Object.defineProperty(answer, 1, {
          enumerable: true,
          get: () => {
            invoked = true;
            return acceptedResponse(`0x${"b".repeat(64)}`);
          },
        });
        return answer;
      },
    });
    const outcomes = await client.postOrders([await signedWith(client), await signedWith(client)]);
    expect(invoked).toBe(false);
    expect(outcomes[0]).toMatchObject({ kind: "ACCEPTED", orderId: GENUINE_ID });
    expect(outcomes[1]).toMatchObject({ kind: "UNKNOWN", reason: "UNRECOGNISED_RESPONSE" });
  });

  it("guard: an answer whose traps throw resolves to UNKNOWN in every position (nothing escapes)", async () => {
    const hostile = new Proxy([acceptedResponse(GENUINE_ID)], {
      get: () => {
        throw new Error(`get ${SECRET}`);
      },
      getOwnPropertyDescriptor: () => {
        throw new Error(`descriptor ${SECRET}`);
      },
    });
    const { client } = await setup({ postOrders: () => hostile });
    const outcomes = await client.postOrders([await signedWith(client)]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ kind: "UNKNOWN" });
    expectNoSecret(outcomes);
  });

  it("control: a wrong-length answer is UNKNOWN in every submitted position", async () => {
    const { client } = await setup({ postOrders: () => [acceptedResponse(GENUINE_ID)] });
    const outcomes = await client.postOrders([await signedWith(client), await signedWith(client)]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });
});

// ---------------------------------------------------------------------------

describe("CX-R2-02: every 429 from the pinned SDK is effect UNKNOWN (the SDK discards the body)", () => {
  function serve(status: number, body: unknown, headers: Record<string, string> = {}): void {
    tripwire.uninstall();
    expect(tripwire.refused()).toEqual([]);
    const responder: FetchResponder = (url) => {
      if (!url.startsWith(CLOB_ORIGIN)) return undefined;
      const all = new Headers(headers);
      if (body !== undefined) all.set("content-type", "application/json");
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: all });
    };
    tripwire = installNetworkTripwire({ responder });
  }

  it.each([
    ["an undocumented code", { error: "x", code: "future_undocumented_code" }],
    ["the documented code of another status", { error: "x", code: "post_only_mode" }],
    ["no body at all", undefined],
    ["a body with no code", { error: "slow down" }],
  ])("a 429 with %s, through the REAL SDK HTTP layer → UNKNOWN placement, kind RATE_LIMITED", async (_label, body) => {
    serve(429, body, { "Retry-After": "2" });
    const sdkError = await provokeSdkHttpRejection();
    expect(tripwire.answered()).toHaveLength(1);
    // What the pinned SDK actually builds: a RateLimitError with no `code`.
    expect(sdkError).toBeInstanceOf(RateLimitError);
    expect(Object.hasOwn(sdkError as object, "code")).toBe(false);
    const { client } = await setup({
      postOrder: () => {
        throw sdkError;
      },
      cancelOrder: () => {
        throw sdkError;
      },
    });
    const placed = await client.postOrder(await signedWith(client));
    expect(placed).toMatchObject({
      kind: "UNKNOWN",
      reason: "ERROR",
      error: { kind: "RATE_LIMITED", effect: "UNKNOWN", httpStatus: 429, retryAfterSeconds: 2 },
    });
    expect(await client.cancelOrder("order-1")).toMatchObject({ kind: "UNKNOWN", error: { kind: "RATE_LIMITED", effect: "UNKNOWN" } });
  });

  it("a bare RateLimitError maps to kind RATE_LIMITED, effect UNKNOWN, never NOT_APPLIED", () => {
    expect(mapVenueError(new RateLimitError("slow", { retryAfter: 3 }), "POST_ORDER").toData()).toMatchObject({
      kind: "RATE_LIMITED",
      effect: "UNKNOWN",
      httpStatus: 429,
      retryAfterSeconds: 3,
      venueCode: null,
      undocumentedVenueCode: false,
    });
  });
});

// ---------------------------------------------------------------------------

describe("CX-R2-03: an accessor `code` is present-but-unreadable, never 'no code'", () => {
  it.each([401, 425, 429])("RequestRejectedError %i with an accessor `code` → effect UNKNOWN; the getter is not invoked", (status) => {
    let invoked = false;
    const error = new RequestRejectedError("venue text", { status });
    Object.defineProperty(error, "code", {
      enumerable: true,
      get: () => {
        invoked = true;
        return undefined;
      },
    });
    const mapped = mapVenueError(error, "POST_ORDER");
    expect(invoked).toBe(false);
    expect(mapped.toData()).toMatchObject({ effect: "UNKNOWN", undocumentedVenueCode: true, venueCode: null, httpStatus: status });
  });

  it("control: RequestRejectedError 401 with no `code` property at all stays NOT_APPLIED", () => {
    expect(mapVenueError(new RequestRejectedError("venue text", { status: 401 }), "POST_ORDER").toData()).toMatchObject({
      effect: "NOT_APPLIED",
      undocumentedVenueCode: false,
    });
  });
});

// ---------------------------------------------------------------------------

describe("L-R2-2: the signed order's parties must be the ones the pinned SDK derives from the account", () => {
  const OTHER = "0x1111111111111111111111111111111111111111";
  const WALLET = "0x2222222222222222222222222222222222222222";
  const account = (walletType: number, wallet = WALLET) => ({ signer: MOCK_SIGNER_ADDRESS, wallet, signerType: "OWNER", walletType });

  /** The fake SDK's default (SDK-derived) order for this account, with fields replaced. */
  function tampered(acct: Record<string, unknown>, patch: Record<string, unknown>): FakeSdkScript {
    return {
      account: acct,
      createLimitOrder: async (req, signer) => {
        const { factory } = createFakeSdkFactory({ account: acct });
        const port = await factory({ signer });
        const order = (await port.createLimitOrder(req)) as unknown as Record<string, unknown>;
        return { ...order, ...patch };
      },
    };
  }

  it.each([
    ["EOA (0)", 0, MOCK_SIGNER_ADDRESS],
    ["POLY_PROXY (1)", 1, WALLET],
    ["GNOSIS_SAFE (2)", 2, WALLET],
    ["DEPOSIT_WALLET (3): signer is the wallet", 3, WALLET],
  ])("control: the SDK-derived order for %s is SIGNED", async (_label, walletType, wallet) => {
    const { client } = await setup(tampered(account(walletType, wallet), {}));
    expect((await client.createLimitOrder(REQUEST)).kind).toBe("SIGNED");
  });

  it("control: addresses compare case-insensitively", async () => {
    const { client } = await setup(tampered(account(1), { maker: WALLET.toUpperCase().replace("0X", "0x") }));
    expect((await client.createLimitOrder(REQUEST)).kind).toBe("SIGNED");
  });

  it.each([
    ["a maker other than the account wallet", 1, { maker: OTHER }],
    ["a signer other than the account signer", 1, { signer: OTHER }],
    ["a signature type other than the wallet type", 1, { signatureType: 2 }],
    ["an EOA order signed as a proxy", 0, { signatureType: 1 }],
    ["a deposit-wallet order whose signer is not the wallet", 3, { signer: MOCK_SIGNER_ADDRESS }],
    ["a non-zero builder", 0, { builder: `0x${"0".repeat(63)}1` }],
    ["a non-zero metadata", 0, { metadata: `0x${"0".repeat(63)}1` }],
    ["an empty builder", 0, { builder: "0x" }],
  ])("%s → FAILED, never an envelope", async (_label, walletType, patch) => {
    const acct = walletType === 0 ? account(0, MOCK_SIGNER_ADDRESS) : account(walletType);
    const { client } = await setup(tampered(acct, patch));
    expect(await client.createLimitOrder(REQUEST)).toMatchObject({ kind: "FAILED", error: { kind: "UNKNOWN" } });
  });
});
