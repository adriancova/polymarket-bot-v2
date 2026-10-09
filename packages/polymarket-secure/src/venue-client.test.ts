/**
 * The narrow interface over a scripted fake SDK: input validation (nothing is
 * sent on failure), response mapping without optimism (ADR-007 §5–§6, C-6),
 * batch limits (§W.3, C-11), cancellation, the authoritative read, rate-limit
 * observations, and exhaustiveness against the pinned SDK's runtime enums.
 */

import {
  OrderPostStatus,
  OrderResponseErrorCode,
  OrderSide,
  RequestRejectedError,
  TransportError,
  UserInputError,
} from "@polymarket/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HANDLED_SDK_ORDER_ERROR_CODES, HANDLED_SDK_POST_STATUSES } from "./outcomes.js";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  type FakeSdkRecorder,
  type FakeSdkScript,
  type NetworkTripwire,
} from "./testing/index.js";
import { MAX_CANCEL_IDS_PER_REQUEST, MAX_ORDERS_PER_BATCH, type RateLimitObservation, type SecureVenueClient } from "./venue-client.js";

const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

async function setup(script: FakeSdkScript = {}, onRateLimitUpdate?: (o: RateLimitObservation) => void) {
  const { handle, probe } = createMockSignerHandle();
  const { factory, recorder } = createFakeSdkFactory(script);
  const client = await createSecureVenueClientForTesting(
    { runModeContext: LIVE_SHAPED_CONTEXT, signer: handle, ...(onRateLimitUpdate ? { onRateLimitUpdate } : {}) },
    factory,
  );
  return { client, probe, recorder };
}

async function signedOrder(client: SecureVenueClient) {
  const outcome = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size: "10" });
  if (outcome.kind !== "SIGNED") throw new Error("fixture signing failed");
  return outcome.order;
}

const calls = (recorder: FakeSdkRecorder, method: string): number => recorder.calls.get(method) ?? 0;

describe("createLimitOrder signs locally", () => {
  it("passes exact decimal strings to the SDK and signs through the sealed mock", async () => {
    const { client, probe, recorder } = await setup();
    const outcome = await client.createLimitOrder({
      assetId: "12345",
      side: "SELL",
      price: "0.52",
      size: "10.5",
      postOnly: true,
      expirationUnixSeconds: 1_800_000_000,
    });
    expect(outcome.kind).toBe("SIGNED");
    expect(probe.signTypedDataCalls).toBe(1);
    expect(recorder.arguments.get("createLimitOrder")).toEqual([
      [{ assetId: "12345", side: OrderSide.SELL, price: "0.52", size: "10.5", postOnly: true, expiration: 1_800_000_000 }],
    ]);
    if (outcome.kind === "SIGNED") {
      expect(outcome.order.identity).toMatchObject({ tokenId: "12345", side: "SELL", orderType: "GTD", postOnly: true });
    }
    // Signing transmits nothing: no post call.
    expect(calls(recorder, "postOrder")).toBe(0);
  });

  it.each([
    ["a number price", { price: 0.52 }],
    ["a zero price", { price: "0" }],
    ["a negative price", { price: "-0.5" }],
    ["an exponent", { price: "5e-1" }],
    ["a bare fraction", { price: ".5" }],
    ["an empty size", { size: "" }],
    ["a lower-case side", { side: "buy" }],
    ["a malformed asset id", { assetId: "0x" }],
    ["a leading-zero asset id", { assetId: "0123" }],
    ["a fractional expiration", { expirationUnixSeconds: 1.5 }],
    ["a string postOnly", { postOnly: "true" }],
  ])("refuses %s as INVALID_REQUEST without calling the SDK", async (_label, patch) => {
    const { client, recorder, probe } = await setup();
    const outcome = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size: "10", ...patch } as never);
    expect(outcome).toMatchObject({ kind: "FAILED", error: { kind: "INVALID_REQUEST", effect: "NOT_SENT" } });
    expect(calls(recorder, "createLimitOrder")).toBe(0);
    expect(probe.signTypedDataCalls).toBe(0);
  });

  it("an SDK signed order outside the pinned shape is FAILED/UNKNOWN, not an envelope", async () => {
    const { client } = await setup({ createLimitOrder: () => ({ salt: "1", signature: "0xabc" }) });
    expect(await client.createLimitOrder({ assetId: "1", side: "BUY", price: "0.5", size: "1" })).toMatchObject({
      kind: "FAILED",
      error: { kind: "UNKNOWN" },
    });
  });

  it("an SDK UserInputError is NOT_SENT", async () => {
    const { client } = await setup({
      createLimitOrder: () => {
        throw new UserInputError("tick size");
      },
    });
    expect(await client.createLimitOrder({ assetId: "1", side: "BUY", price: "0.5", size: "1" })).toMatchObject({
      kind: "FAILED",
      error: { kind: "INVALID_REQUEST", effect: "NOT_SENT" },
    });
  });
});

describe("ADR-034 D2.4: the share grid, and the EXACT cross-check of the signed amounts", () => {
  it.each(["10.129", "0.001", "5.009", "1.000001", "49.995"])("an off-grid size %s is INVALID_REQUEST before the SDK runs: nothing is rounded or signed", async (size) => {
    const { client, recorder, probe } = await setup();
    expect(await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size })).toMatchObject({
      kind: "FAILED",
      error: { kind: "INVALID_REQUEST", effect: "NOT_SENT" },
    });
    expect(calls(recorder, "createLimitOrder")).toBe(0);
    expect(probe.signTypedDataCalls).toBe(0);
  });

  it.each([
    ["10", "10000000"],
    ["10.1", "10100000"],
    ["10.12", "10120000"],
    ["0.01", "10000"],
  ])("an on-grid size %s is signed for exactly that many shares (%s base units)", async (size, baseUnits) => {
    const { client } = await setup();
    const outcome = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size });
    expect(outcome.kind).toBe("SIGNED");
    if (outcome.kind === "SIGNED") expect(outcome.order.identity.takerAmount).toBe(baseUnits);
  });

  /** A fake SDK whose signed order is the default one with `patch` applied. */
  function tampered(patch: (order: Record<string, unknown>) => Record<string, unknown>): FakeSdkScript {
    return {
      createLimitOrder: async (request, signer) => {
        const { factory } = createFakeSdkFactory();
        const port = await factory({ signer });
        return patch((await port.createLimitOrder(request)) as unknown as Record<string, unknown>) as never;
      },
    };
  }

  const nudge = (value: unknown, delta: bigint): string => (BigInt(String(value)) + delta).toString();

  // D2.4's table, one row each (shares 12.34 at 0.37: quote 4.5658 pUSD = 4,565,800 base units; shares 12,340,000).
  for (const [row, side, expiration, maker, taker] of [
    ["GTC BUY", "BUY", undefined, "4565800", "12340000"],
    ["GTC SELL", "SELL", undefined, "12340000", "4565800"],
    ["GTD BUY", "BUY", 1_900_000_000, "4565800", "12340000"],
    ["GTD SELL", "SELL", 1_900_000_000, "12340000", "4565800"],
  ] as const) {
    const request = { assetId: "12345", side, price: "0.37", size: "12.34", ...(expiration === undefined ? {} : { expirationUnixSeconds: expiration }) };

    it(`${row}: makerAmount ${maker}, takerAmount ${taker}, exactly: SIGNED`, async () => {
      const { client } = await setup(tampered((order) => order));
      const outcome = await client.createLimitOrder(request);
      expect(outcome.kind).toBe("SIGNED");
      if (outcome.kind === "SIGNED") expect(outcome.order.identity).toMatchObject({ makerAmount: maker, takerAmount: taker, orderType: expiration === undefined ? "GTC" : "GTD" });
    });

    for (const [label, patch] of [
      ["makerAmount + 1", (order: Record<string, unknown>) => ({ ...order, makerAmount: nudge(order["makerAmount"], 1n) })],
      ["makerAmount − 1", (order: Record<string, unknown>) => ({ ...order, makerAmount: nudge(order["makerAmount"], -1n) })],
      ["takerAmount + 1", (order: Record<string, unknown>) => ({ ...order, takerAmount: nudge(order["takerAmount"], 1n) })],
      ["takerAmount − 1", (order: Record<string, unknown>) => ({ ...order, takerAmount: nudge(order["takerAmount"], -1n) })],
      ["amounts swapped", (order: Record<string, unknown>) => ({ ...order, makerAmount: order["takerAmount"], takerAmount: order["makerAmount"] })],
      // A CONSISTENT order for one base unit fewer shares: the quote is the SDK's own for 12.339999 shares at 0.37,
      // floored to tick 0.01's 4 decimals (4.5657). Before ADR-034 D2.4 the adapter's rounding tolerance signed it.
      ["one base unit fewer shares, with the SDK's own quote for them", (order: Record<string, unknown>) => {
        const shares = 12_339_999n;
        const quote = ((shares * 37n) / 100n / 100n) * 100n;
        return side === "BUY"
          ? { ...order, makerAmount: quote.toString(), takerAmount: shares.toString() }
          : { ...order, makerAmount: shares.toString(), takerAmount: quote.toString() };
      }],
    ] as const) {
      it(`${row}: ${label} → FAILED, never an envelope`, async () => {
        const { client } = await setup(tampered(patch));
        expect(await client.createLimitOrder(request)).toMatchObject({ kind: "FAILED", error: { kind: "UNKNOWN" } });
      });
    }
  }

  it.each(["FAK", "FOK"])("a signed %s order is still refused: those rows arrive with ADR-034 R3", async (orderType) => {
    const { client } = await setup(tampered((order) => ({ ...order, orderType })));
    expect(await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.37", size: "12.34" })).toMatchObject({
      kind: "FAILED",
      error: { kind: "UNKNOWN" },
    });
  });

  it("a price whose quote is not a whole number of base units can match no signed order: FAILED, never rounded", async () => {
    const { client } = await setup();
    expect((await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.1234567", size: "1" })).kind).toBe("FAILED");
  });
});

describe("postOrder maps without optimism (ADR-007 §5–§6)", () => {
  const accepted = (status: string, extra: Record<string, unknown> = {}) => ({
    ok: true,
    orderId: "0xfeed",
    status,
    makingAmount: "0",
    takingAmount: "0",
    tradeIds: [],
    transactionsHashes: [],
    ...extra,
  });

  it.each([
    ["live", "LIVE"],
    ["matched", "MATCHED"],
    ["delayed", "DELAYED"],
  ])("accepted %s → ACCEPTED %s", async (status, mapped) => {
    const { client } = await setup({ postOrder: () => accepted(status) });
    expect(await client.postOrder(await signedOrder(client))).toMatchObject({ kind: "ACCEPTED", status: mapped, orderId: "0xfeed" });
  });

  it("a matched response carries exact decimal strings, trades and hashes", async () => {
    const { client } = await setup({
      postOrder: () =>
        accepted("matched", {
          makingAmount: "3.2",
          takingAmount: "40",
          tradeIds: ["00000000-0000-0000-0000-000000000001"],
          transactionsHashes: [`0x${"c".repeat(64)}`],
        }),
    });
    expect(await client.postOrder(await signedOrder(client))).toEqual({
      kind: "ACCEPTED",
      orderId: "0xfeed",
      status: "MATCHED",
      makingAmount: "3.2",
      takingAmount: "40",
      tradeIds: ["00000000-0000-0000-0000-000000000001"],
      transactionHashes: [`0x${"c".repeat(64)}`],
    });
  });

  it.each([
    ["market_not_ready", "MARKET_NOT_READY"],
    ["insufficient_balance_or_allowance", "INSUFFICIENT_BALANCE_OR_ALLOWANCE"],
    ["invalid_nonce", "INVALID_NONCE"],
    ["invalid_expiration", "INVALID_EXPIRATION"],
    ["post_only_would_cross", "POST_ONLY_WOULD_CROSS"],
    ["post_only_mode", "POST_ONLY_MODE"],
    ["fok_not_filled", "FOK_NOT_FILLED"],
    ["fak_not_filled", "FAK_NOT_FILLED"],
  ])("SDK rejection %s → REJECTED %s, with no venue text carried", async (code, reason) => {
    const { client } = await setup({ postOrder: () => ({ ok: false, code, message: "venue free text 0xdeadbeef" }) });
    const outcome = await client.postOrder(await signedOrder(client));
    expect(outcome).toEqual({ kind: "REJECTED", reason });
  });

  it("C-6: the SDK's `unmatched` rejection is UNKNOWN (the venue says placement succeeded), never REJECTED", async () => {
    const { client } = await setup({ postOrder: () => ({ ok: false, code: "unmatched", message: "Unknown order failure" }) });
    expect(await client.postOrder(await signedOrder(client))).toEqual({ kind: "UNKNOWN", reason: "SDK_UNMATCHED", error: null });
  });

  it.each(["unknown", "some_new_code", "", 7])("U-4: SDK code %j → UNKNOWN (SDK_UNKNOWN_CODE)", async (code) => {
    const { client } = await setup({ postOrder: () => ({ ok: false, code, message: "x" }) });
    expect(await client.postOrder(await signedOrder(client))).toEqual({ kind: "UNKNOWN", reason: "SDK_UNKNOWN_CODE", error: null });
  });

  it.each([
    ["an empty order id", accepted("live", { orderId: "" })],
    ["an unknown status", accepted("unmatched")],
    ["a numeric amount", accepted("matched", { makingAmount: 3.2 })],
    ["an exponent amount", accepted("matched", { makingAmount: "1e3" })],
    ["a null trade list", accepted("matched", { tradeIds: null })],
    ["no ok flag", { orderId: "0xfeed" }],
    ["null", null],
  ])("an accepted response with %s is UNKNOWN (UNRECOGNISED_RESPONSE)", async (_label, response) => {
    const { client } = await setup({ postOrder: () => response });
    expect(await client.postOrder(await signedOrder(client))).toEqual({ kind: "UNKNOWN", reason: "UNRECOGNISED_RESPONSE", error: null });
  });

  it.each([
    // CX-R3-01: a code-less 425 is UNKNOWN (the pinned SDK can drop the code).
    ["425", () => new RequestRejectedError("restart", { status: 425 }), "UNKNOWN"],
    ["503 post_only_mode", () => new RequestRejectedError("po", { status: 503, code: "post_only_mode" }), "REFUSED"],
    ["503 without code (C-9)", () => new RequestRejectedError("trading is disabled", { status: 503 }), "UNKNOWN"],
    ["400 without code (U-4)", () => new RequestRejectedError("Invalid order payload", { status: 400 }), "UNKNOWN"],
    ["a transport failure", () => new TransportError("reset"), "UNKNOWN"],
    ["an SDK input error", () => new UserInputError("bad"), "NOT_SENT"],
  ])("a thrown %s → %s", async (_label, make, kind) => {
    const { client } = await setup({
      postOrder: () => {
        throw make();
      },
    });
    const outcome = await client.postOrder(await signedOrder(client));
    expect(outcome.kind).toBe(kind);
  });

  it("refuses a non-envelope without calling the SDK", async () => {
    const { client, recorder } = await setup();
    expect(await client.postOrder({ identity: {} } as never)).toMatchObject({ kind: "NOT_SENT", error: { kind: "INVALID_REQUEST" } });
    expect(calls(recorder, "postOrder")).toBe(0);
  });

  it("posts the exact signed payload that was signed (the same salt; no re-signing)", async () => {
    const { client, recorder, probe } = await setup();
    const order = await signedOrder(client);
    await client.postOrder(order);
    await client.postOrder(order);
    expect(probe.signTypedDataCalls).toBe(1);
    const posted = recorder.arguments.get("postOrder") as unknown[][];
    expect(posted).toHaveLength(2);
    expect(posted[0]?.[0]).toEqual(order.revealPayloadForEncryptedPersistence());
    expect(posted[1]?.[0]).toEqual(posted[0]?.[0]);
  });
});

describe("postOrders: 1…15 per batch, one outcome per order", () => {
  it(`accepts ${MAX_ORDERS_PER_BATCH} and refuses 0 or ${MAX_ORDERS_PER_BATCH + 1} without calling the SDK`, async () => {
    const { client, recorder } = await setup();
    const order = await signedOrder(client);
    const full = await client.postOrders(Array.from({ length: MAX_ORDERS_PER_BATCH }, () => order));
    expect(full).toHaveLength(MAX_ORDERS_PER_BATCH);
    expect(full.every((outcome) => outcome.kind === "ACCEPTED")).toBe(true);
    expect(calls(recorder, "postOrders")).toBe(1);
    const tooMany = await client.postOrders(Array.from({ length: MAX_ORDERS_PER_BATCH + 1 }, () => order));
    expect(tooMany.every((outcome) => outcome.kind === "NOT_SENT")).toBe(true);
    expect(await client.postOrders([])).toEqual([expect.objectContaining({ kind: "NOT_SENT" })]);
    expect(calls(recorder, "postOrders")).toBe(1);
  });

  it("a batch answer of the wrong length makes every entry UNKNOWN", async () => {
    const { client } = await setup({ postOrders: () => [] });
    const order = await signedOrder(client);
    expect(await client.postOrders([order, order])).toEqual([
      { kind: "UNKNOWN", reason: "UNRECOGNISED_RESPONSE", error: null },
      { kind: "UNKNOWN", reason: "UNRECOGNISED_RESPONSE", error: null },
    ]);
  });

  it("per-entry outcomes are mapped independently, in request order", async () => {
    const { client } = await setup({
      postOrders: () => [
        { ok: true, orderId: "0x1", status: "live", makingAmount: "0", takingAmount: "0", tradeIds: [], transactionsHashes: [] },
        { ok: false, code: "post_only_mode", message: "x" },
        { ok: false, code: "unmatched", message: "x" },
      ],
    });
    const order = await signedOrder(client);
    expect((await client.postOrders([order, order, order])).map((outcome) => outcome.kind)).toEqual(["ACCEPTED", "REJECTED", "UNKNOWN"]);
  });

  it("a thrown batch error applies to every entry", async () => {
    const { client } = await setup({
      postOrders: () => {
        throw new TransportError("reset");
      },
    });
    const order = await signedOrder(client);
    const outcomes = await client.postOrders([order, order]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });
});

describe("cancellation", () => {
  it(`cancelOrders accepts ${MAX_CANCEL_IDS_PER_REQUEST} ids and refuses ${MAX_CANCEL_IDS_PER_REQUEST + 1} (C-11: the lower limit)`, async () => {
    const { client, recorder } = await setup();
    const ids = Array.from({ length: MAX_CANCEL_IDS_PER_REQUEST }, (_v, i) => `0x${i.toString(16)}`);
    expect((await client.cancelOrders(ids)).kind).toBe("COMPLETED");
    expect((await client.cancelOrders([...ids, "0xffff"])).kind).toBe("NOT_SENT");
    expect(await client.cancelOrders([])).toMatchObject({ kind: "NOT_SENT" });
    expect(await client.cancelOrders(["bad id with spaces"])).toMatchObject({ kind: "NOT_SENT" });
    expect(calls(recorder, "cancelOrders")).toBe(1);
  });

  it("carries documented not-canceled reasons verbatim and marks any other text UNDOCUMENTED", async () => {
    const { client } = await setup({
      cancelOrders: () =>
        ({
          canceled: ["0x1"],
          notCanceled: { "0x2": "Order already matched", "0x3": "internal detail 0xdeadbeef secret" },
        }) as never,
    });
    expect(await client.cancelOrders(["0x1", "0x2", "0x3"])).toEqual({
      kind: "COMPLETED",
      canceled: ["0x1"],
      notCanceled: [
        { orderId: "0x2", reason: "Order already matched" },
        { orderId: "0x3", reason: "UNDOCUMENTED" },
      ],
    });
  });

  it("a malformed cancel response is UNKNOWN", async () => {
    const { client } = await setup({ cancelAll: () => ({ canceled: "0x1" }) as never });
    expect(await client.cancelAll()).toEqual({ kind: "UNKNOWN", error: null });
  });

  it("C-9: a cancel meeting a bare 503 is UNKNOWN; a 425 is UNKNOWN too (CX-R3-01)", async () => {
    const bare = await setup({
      cancelOrder: () => {
        throw new RequestRejectedError("Trading is currently disabled. Check polymarket.com for updates", { status: 503 });
      },
    });
    expect(await bare.client.cancelOrder("0x1")).toMatchObject({ kind: "UNKNOWN", error: { kind: "TRADING_UNAVAILABLE", cancelsAvailable: "UNKNOWN" } });
    const restart = await setup({
      cancelOrder: () => {
        throw new RequestRejectedError("", { status: 425 });
      },
    });
    expect(await restart.client.cancelOrder("0x1")).toMatchObject({ kind: "UNKNOWN", error: { kind: "ENGINE_RESTARTING", effect: "UNKNOWN" } });
  });

  it("cancelMarketOrders needs a well-formed market or asset id", async () => {
    const { client, recorder } = await setup();
    expect(await client.cancelMarketOrders({} as never)).toMatchObject({ kind: "NOT_SENT" });
    expect(await client.cancelMarketOrders({ market: "0x1" })).toMatchObject({ kind: "NOT_SENT" });
    expect(calls(recorder, "cancelMarketOrders")).toBe(0);
    expect((await client.cancelMarketOrders({ market: `0x${"a".repeat(64)}`, assetId: "7" })).kind).toBe("COMPLETED");
    expect(recorder.arguments.get("cancelMarketOrders")).toEqual([[{ market: `0x${"a".repeat(64)}`, assetId: "7" }]]);
  });
});

describe("fetchOrder (authoritative read)", () => {
  it("maps a snapshot without the owner field", async () => {
    const { client } = await setup();
    const outcome = await client.fetchOrder("0xabc");
    expect(outcome.kind).toBe("FOUND");
    if (outcome.kind === "FOUND") {
      expect(outcome.value).toMatchObject({ orderId: "0xabc", price: "0.52", status: "LIVE", expiresAt: null });
      expect(Object.keys(outcome.value)).not.toContain("owner");
    }
  });

  it("an unrecognised status is carried as UNRECOGNISED; a malformed snapshot is FAILED", async () => {
    const odd = await setup({ fetchOrder: () => ({ id: "0x1", assetId: "1", conditionId: "0x2", makerAddress: "0x3", side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0", status: "live?", orderType: "GTC", createdAt: "2026-09-30T00:00:00Z", associateTrades: [] }) as never });
    expect(await odd.client.fetchOrder("0x1")).toMatchObject({ kind: "FOUND", value: { status: "UNRECOGNISED" } });
    const broken = await setup({ fetchOrder: () => ({ id: "0x1", price: 0.5 }) as never });
    expect(await broken.client.fetchOrder("0x1")).toEqual({ kind: "FAILED", error: null });
  });

  it("a thrown error is FAILED with the mapped error; a malformed id is not sent", async () => {
    const { client, recorder } = await setup({
      fetchOrder: () => {
        throw new TransportError("x");
      },
    });
    expect(await client.fetchOrder("0x1")).toMatchObject({ kind: "FAILED", error: { kind: "TRANSPORT_FAILURE" } });
    expect(await client.fetchOrder("")).toMatchObject({ kind: "FAILED", error: { kind: "INVALID_REQUEST" } });
    expect(calls(recorder, "fetchOrder")).toBe(1);
  });
});

describe("rate-limit observations and close", () => {
  it("sanitises SDK rate-limit updates and isolates listener failures", async () => {
    const seen: RateLimitObservation[] = [];
    const { recorder } = await setup({}, (observation) => {
      seen.push(observation);
      throw new Error("listener bug");
    });
    const forward = recorder.factoryCalls[0]?.onRateLimitUpdate;
    expect(forward).toBeDefined();
    expect(() => forward?.({ bucket: "order" as never, remaining: 5, reset: 1_767_225_600, tier: "tier 1; secret", warning: true })).not.toThrow();
    expect(seen).toEqual([{ bucket: "order", remaining: 5, resetUnixSeconds: 1_767_225_600, tier: null, warning: true }]);
  });

  it("close never throws", async () => {
    const { client } = await setup({
      closeSubscriptions: () => {
        throw new Error("x");
      },
    });
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe("exhaustive against the pinned SDK's runtime enums", () => {
  it("every OrderResponseErrorCode member is handled, and nothing else", () => {
    expect([...HANDLED_SDK_ORDER_ERROR_CODES].sort()).toEqual(Object.values(OrderResponseErrorCode).map(String).sort());
  });

  it("every OrderPostStatus member is handled, and nothing else", () => {
    expect([...HANDLED_SDK_POST_STATUSES].sort()).toEqual(Object.values(OrderPostStatus).map(String).sort());
  });
});
