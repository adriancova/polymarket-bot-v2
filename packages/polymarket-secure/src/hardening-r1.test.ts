/**
 * Round-1 review pins (WP-260 r1). Each `describe` names the verifier finding
 * it pins; every test here FAILS against candidate `ce8bda5` and passes after
 * the fix.
 *
 * - A: reflection over foreign values (a proxy trap that throws, a revoked
 *   proxy, a throwing getter) is contained everywhere: in error mapping, in
 *   the run-mode gate, in construction, in every client method and in the
 *   response mappers. Nothing the foreign code threw escapes, and no method
 *   throws.
 * - CX-R1-01: a SecureVenueError holds only closed-vocabulary values, on
 *   every construction and re-mapping path, and cannot be changed afterwards.
 * - CX-R1-04: any code on 401/425/429 makes the effect UNKNOWN (ADR-007 §6).
 * - CX-R1-03: redactForLog never invokes an array-index getter or an own
 *   iterator, and keeps only fixed error names.
 * - CX-R1-05: an inherited property name is not an SDK post status.
 * - L5: a signed order that does not say what was asked is never handed out,
 *   and prices are bounded to (0, 1).
 */

import { inspect } from "node:util";

import { RateLimitError, RequestRejectedError, TransportError } from "@polymarket/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecureVenueError, SignerBoundaryRefusal, type SecureVenueErrorData } from "./errors.js";
import { mapVenueError } from "./error-mapping.js";
import { mapCancelResponse, mapOpenOrder, mapOrderResponse, placementOutcomeFromError } from "./outcomes.js";
import { redactForLog } from "./redaction.js";
import { evaluateSignerGate, signerGateContextFromSafetyFlags } from "./run-mode-gate.js";
import { SignedOrderEnvelope } from "./signed-order.js";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  type FakeSdkScript,
  type NetworkTripwire,
} from "./testing/index.js";

const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });
const SECRET = "sk-FAKE-R1-SECRET-0123456789abcdefFEDCBA";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

/** Every way a value is commonly rendered or logged. */
function renderings(value: unknown): string[] {
  const out = [inspect(value, { depth: 12, showHidden: true, getters: false })];
  try {
    out.push(JSON.stringify(value) ?? "");
  } catch {
    out.push("[unserialisable]");
  }
  out.push(JSON.stringify(redactForLog(value)) ?? "");
  if (value instanceof Error) out.push(value.message, String(value.stack));
  return out;
}

function expectNoSecret(value: unknown): void {
  for (const text of renderings(value)) expect(text).not.toContain(SECRET);
}

/** A proxy on `target` whose every trap throws an error carrying SECRET. */
function hostileProxy<T extends object>(target: T): T {
  const boom = (): never => {
    throw new Error(`trap ${SECRET}`);
  };
  return new Proxy(target, {
    getPrototypeOf: boom,
    ownKeys: boom,
    getOwnPropertyDescriptor: boom,
    get: boom,
    has: boom,
  });
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A proxy that passes `instanceof RequestRejectedError` and then throws on field reads. */
function rejectedLookalikeThatThrowsOnRead(): object {
  const real = new RequestRejectedError("venue text", { status: 503 });
  return new Proxy(real, {
    getOwnPropertyDescriptor: () => {
      throw new Error(`descriptor ${SECRET}`);
    },
  });
}

async function setup(script: FakeSdkScript = {}) {
  const { handle } = createMockSignerHandle();
  const { factory, recorder } = createFakeSdkFactory(script);
  const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: handle }, factory);
  return { client, recorder };
}

const sdkCalls = (recorder: { calls: Map<string, number> }): number => [...recorder.calls.values()].reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------

describe("A: mapVenueError contains reflection failures", () => {
  it.each([
    ["a proxy whose getPrototypeOf trap throws (instanceof)", () => hostileProxy(new Error("x"))],
    ["a RequestRejectedError proxy whose descriptor trap throws", rejectedLookalikeThatThrowsOnRead],
    ["a revoked proxy", revokedProxy],
  ])("%s → a fresh UNKNOWN error, nothing thrown, no secret", (_label, make) => {
    let mapped: SecureVenueError | undefined;
    expect(() => {
      mapped = mapVenueError(make(), "POST_ORDER");
    }).not.toThrow();
    expect(mapped).toBeInstanceOf(SecureVenueError);
    expect(mapped?.toData()).toMatchObject({ kind: "UNKNOWN", effect: "UNKNOWN", source: "non-SDK", operation: "POST_ORDER" });
    expectNoSecret(mapped);
  });
});

describe("A: the run-mode gate contains reflection failures", () => {
  it.each([
    ["a proxy whose traps throw", () => hostileProxy({ runMode: "LIVE", maximumRunMode: "LIVE", allowRealOrders: true })],
    ["a revoked proxy", revokedProxy],
  ])("evaluateSignerGate(%s) refuses as CONTEXT_UNREADABLE without throwing", (_label, make) => {
    let verdict: ReturnType<typeof evaluateSignerGate> | undefined;
    expect(() => {
      verdict = evaluateSignerGate(make());
    }).not.toThrow();
    expect(verdict).toEqual({ permitted: false, reasons: ["CONTEXT_UNREADABLE"] });
  });

  it("signerGateContextFromSafetyFlags reads a throwing record as absent flags (so the gate refuses)", () => {
    let context: ReturnType<typeof signerGateContextFromSafetyFlags> | undefined;
    expect(() => {
      context = signerGateContextFromSafetyFlags(hostileProxy({ RUN_MODE: "LIVE" }) as Record<string, string>);
    }).not.toThrow();
    expect(context).toEqual({ runMode: undefined, maximumRunMode: "PAPER", allowRealOrders: false });
    expect(evaluateSignerGate(context).permitted).toBe(false);
  });
});

describe("A: construction contains reflection failures", () => {
  it.each([
    ["the options object", () => hostileProxy({ runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle })],
    ["the run-mode context", () => ({ runModeContext: hostileProxy({ ...LIVE_SHAPED_CONTEXT }), signer: createMockSignerHandle().handle })],
    [
      "a throwing getter on the options",
      () => ({
        runModeContext: LIVE_SHAPED_CONTEXT,
        get signer(): never {
          throw new Error(`getter ${SECRET}`);
        },
      }),
    ],
  ])("a hostile %s refuses with SignerBoundaryRefusal(CONTEXT_UNREADABLE), not the raw error", async (_label, make) => {
    const { factory, recorder } = createFakeSdkFactory();
    let thrown: unknown;
    try {
      await createSecureVenueClientForTesting(make() as never, factory);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SignerBoundaryRefusal);
    expect((thrown as SignerBoundaryRefusal).reasons).toEqual(["CONTEXT_UNREADABLE"]);
    expectNoSecret(thrown);
    expect(recorder.factoryCalls).toHaveLength(0);
  });
});

describe("A: no client method throws on hostile input, and none reaches the SDK", () => {
  const hostileInputs: ReadonlyArray<readonly [string, () => unknown]> = [
    ["a trap-throwing proxy", () => hostileProxy({})],
    ["a trap-throwing array proxy", () => hostileProxy([] as unknown[])],
    ["a revoked proxy", revokedProxy],
  ];

  it.each(hostileInputs)("createLimitOrder, postOrders, cancelOrders, cancelMarketOrders with %s → NOT_SENT outcomes", async (_label, make) => {
    const { client, recorder } = await setup();
    const results = [
      await client.createLimitOrder(make() as never),
      ...(await client.postOrders(make() as never)),
      await client.cancelOrders(make() as never),
      await client.cancelMarketOrders(make() as never),
      await client.postOrder(make() as never),
      await client.cancelOrder(make() as never),
      await client.fetchOrder(make() as never),
    ];
    for (const result of results) {
      expect(result).toMatchObject({ error: { kind: "INVALID_REQUEST", effect: "NOT_SENT" } });
      expectNoSecret(result);
    }
    expect(sdkCalls(recorder)).toBe(0);
  });

  it("an array with a throwing index getter is refused without calling the getter twice or reaching the SDK", async () => {
    const { client, recorder } = await setup();
    const ids = ["0x1"];
    Object.defineProperty(ids, 0, {
      get: () => {
        throw new Error(`index ${SECRET}`);
      },
    });
    const outcome = await client.cancelOrders(ids);
    expect(outcome).toMatchObject({ kind: "NOT_SENT" });
    expectNoSecret(outcome);
    expect(sdkCalls(recorder)).toBe(0);
  });

  it("a hostile length is bounded: a proxy reporting 2^32-1 entries yields at most 16 refusals", async () => {
    const { client } = await setup();
    const huge = new Proxy([] as unknown[], {
      getOwnPropertyDescriptor: (target, key) =>
        key === "length" ? { value: 2 ** 32 - 1, writable: true, enumerable: false, configurable: false } : Reflect.getOwnPropertyDescriptor(target, key),
    });
    const outcomes = await client.postOrders(huge as never);
    expect(outcomes.length).toBeLessThanOrEqual(16);
    expect(outcomes.every((outcome) => outcome.kind === "NOT_SENT")).toBe(true);
  });

  it("the SDK throwing a trap-throwing proxy → UNKNOWN outcome with a fresh UNKNOWN error, no secret", async () => {
    const hostile = hostileProxy(new Error("x"));
    const thrower = () => {
      throw hostile;
    };
    const { client } = await setup({ postOrder: thrower, cancelAll: thrower, fetchOrder: thrower, createLimitOrder: thrower });
    const signedOrder = await setup().then(({ client: other }) => other.createLimitOrder({ assetId: "1", side: "BUY", price: "0.5", size: "1" }));
    if (signedOrder.kind !== "SIGNED") throw new Error("fixture signing failed");
    const results = [
      await client.postOrder(signedOrder.order),
      await client.cancelAll(),
      await client.fetchOrder("0x1"),
      await client.createLimitOrder({ assetId: "1", side: "BUY", price: "0.5", size: "1" }),
    ];
    for (const result of results) {
      expect(result).toMatchObject({ error: { kind: "UNKNOWN", effect: "UNKNOWN", source: "non-SDK" } });
      expectNoSecret(result);
    }
  });

  it("an SDK response whose reflection throws maps to UNKNOWN/FAILED, never a throw", () => {
    expect(mapOrderResponse(revokedProxy())).toEqual({ kind: "UNKNOWN", reason: "UNRECOGNISED_RESPONSE", error: null });
    expect(mapOrderResponse(hostileProxy({ ok: true }))).toEqual({ kind: "UNKNOWN", reason: "UNRECOGNISED_RESPONSE", error: null });
    expect(mapCancelResponse(hostileProxy({}))).toEqual({ kind: "UNKNOWN", error: null });
    expect(mapOpenOrder(hostileProxy({}))).toEqual({ kind: "FAILED", error: null });
  });

  it("SignedOrderEnvelope.fromPersistedPayload(a revoked or trap-throwing proxy) is undefined, not a throw", () => {
    expect(SignedOrderEnvelope.fromPersistedPayload(revokedProxy())).toBeUndefined();
    expect(SignedOrderEnvelope.fromPersistedPayload(hostileProxy({}))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

const VALID: SecureVenueErrorData = Object.freeze({
  kind: "TRANSPORT_FAILURE",
  operation: "POST_ORDER",
  effect: "UNKNOWN",
  httpStatus: null,
  venueCode: null,
  undocumentedVenueCode: false,
  retryAfterSeconds: null,
  cancelsAvailable: null,
  source: "TransportError",
});

describe("CX-R1-01: SecureVenueError holds only closed-vocabulary values", () => {
  it.each([
    ["source", { source: SECRET }],
    ["kind", { kind: SECRET }],
    ["operation", { operation: SECRET }],
    ["effect", { effect: SECRET }],
    ["venueCode (undocumented)", { venueCode: SECRET }],
    ["httpStatus", { httpStatus: 9999 }],
    ["retryAfterSeconds", { retryAfterSeconds: Number.NaN }],
    ["cancelsAvailable", { cancelsAvailable: SECRET }],
    ["undocumentedVenueCode", { undocumentedVenueCode: SECRET }],
  ])("the constructor refuses an out-of-vocabulary %s with a fixed, value-free TypeError", (_label, patch) => {
    let thrown: unknown;
    try {
      new SecureVenueError({ ...VALID, ...patch } as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toBe("SecureVenueError: data outside the closed vocabularies");
    expectNoSecret(thrown);
  });

  it("the constructor never invokes a getter on its input", () => {
    let invoked = false;
    const data = { ...VALID };
    Object.defineProperty(data, "kind", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "UNKNOWN";
      },
    });
    expect(() => new SecureVenueError(data)).toThrow(TypeError);
    expect(invoked).toBe(false);
  });

  it("an instance is frozen: a field cannot be changed after the check", () => {
    const error = new SecureVenueError(VALID);
    expect(Object.isFrozen(error)).toBe(true);
    expect(() => {
      (error as unknown as { source: string }).source = SECRET;
    }).toThrow(TypeError);
    expect(error.source).toBe("TransportError");
  });

  it("re-mapping a subclass instance does not trust its overridden toData()", () => {
    class Tampered extends SecureVenueError {
      override toData(): SecureVenueErrorData {
        return { ...super.toData(), source: SECRET } as never;
      }
    }
    const remapped = mapVenueError(new Tampered(VALID), "POST_ORDERS");
    expect(remapped.toData()).toEqual({ ...VALID, operation: "POST_ORDERS" });
    expectNoSecret(remapped);
  });

  it("re-mapping reads only own DATA fields: an accessor on a subclass prototype is never consulted", () => {
    class Accessor extends SecureVenueError {}
    Object.defineProperty(Accessor.prototype, "source", {
      configurable: true,
      get: () => SECRET,
      set: () => undefined,
    });
    const remapped = mapVenueError(new Accessor(VALID), "POST_ORDER");
    expect(remapped.toData()).toEqual(VALID);
    expectNoSecret(remapped);
  });

  it("re-mapping an object that passes instanceof but lacks valid own fields falls to UNKNOWN", () => {
    const forged = Object.create(SecureVenueError.prototype) as SecureVenueError;
    Object.assign(forged, { ...VALID, source: SECRET });
    const remapped = mapVenueError(forged, "POST_ORDER");
    expect(remapped.toData()).toMatchObject({ kind: "UNKNOWN", effect: "UNKNOWN", source: "non-SDK" });
    expectNoSecret(remapped);
  });

  it("SignerBoundaryRefusal accepts only known reason codes, and never echoes others", () => {
    let thrown: unknown;
    try {
      new SignerBoundaryRefusal([SECRET] as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expectNoSecret(thrown);
    expect(new SignerBoundaryRefusal(["CONTEXT_UNREADABLE"]).reasons).toEqual(["CONTEXT_UNREADABLE"]);
  });
});

// ---------------------------------------------------------------------------

describe("CX-R1-04: any code on 401/425/429 makes the effect UNKNOWN (ADR-007 §6)", () => {
  const rejected = (status: number, code?: string): RequestRejectedError =>
    new RequestRejectedError("venue text", { status, ...(code === undefined ? {} : { code }) });

  it.each([401, 425, 429])("status %i with an undocumented code → effect UNKNOWN, placement UNKNOWN (never REFUSED)", (status) => {
    const mapped = mapVenueError(rejected(status, "some_new_code"), "POST_ORDER");
    expect(mapped.toData()).toMatchObject({ effect: "UNKNOWN", undocumentedVenueCode: true, venueCode: null, httpStatus: status });
    expect(placementOutcomeFromError(mapped).kind).toBe("UNKNOWN");
  });

  it.each([401, 425, 429])("status %i with the documented code of ANOTHER status (post_only_mode) → effect UNKNOWN", (status) => {
    expect(mapVenueError(rejected(status, "post_only_mode"), "POST_ORDER").toData()).toMatchObject({ effect: "UNKNOWN" });
  });

  // CX-R3-01 superseded this r1 control: with NO code the effect is UNKNOWN
  // too, because the pinned SDK can drop a code the venue sent.
  it.each([401, 425, 429])("status %i with NO code is also effect UNKNOWN (CX-R3-01), code fields unset", (status) => {
    expect(mapVenueError(rejected(status), "POST_ORDER").toData()).toMatchObject({ effect: "UNKNOWN", venueCode: null, undocumentedVenueCode: false });
  });

  it("a RateLimitError carrying a code is treated the same way", () => {
    const error = new RateLimitError("slow", { retryAfter: 2 });
    Object.defineProperty(error, "code", { value: "some_new_code", enumerable: true });
    expect(mapVenueError(error, "POST_ORDER").toData()).toMatchObject({ kind: "RATE_LIMITED", effect: "UNKNOWN", undocumentedVenueCode: true });
  });

  it("through the client: a 429 with an undocumented code is an UNKNOWN placement", async () => {
    const { client } = await setup({
      postOrder: () => {
        throw rejected(429, "some_new_code");
      },
    });
    const signed = await client.createLimitOrder({ assetId: "1", side: "BUY", price: "0.5", size: "1" });
    if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");
    expect(await client.postOrder(signed.order)).toMatchObject({ kind: "UNKNOWN", reason: "ERROR" });
  });
});

// ---------------------------------------------------------------------------

describe("CX-R1-03: redactForLog never invokes array getters or own iterators, and keeps only fixed error names", () => {
  it("an array-index getter is not invoked; the entry is [accessor]", () => {
    let invoked = false;
    const list: unknown[] = ["a", "b"];
    Object.defineProperty(list, 1, {
      enumerable: true,
      get: () => {
        invoked = true;
        return SECRET;
      },
    });
    expect(redactForLog({ list })).toEqual({ list: ["a", "[accessor]"] });
    expect(invoked).toBe(false);
  });

  it("an own Symbol.iterator on a Map or Set is not called", () => {
    let invoked = false;
    const map = new Map([["k", "v"]]);
    const set = new Set(["v"]);
    for (const collection of [map, set]) {
      Object.defineProperty(collection, Symbol.iterator, {
        value: function* () {
          invoked = true;
          yield ["k", SECRET];
        },
      });
    }
    expect(redactForLog({ map, set })).toEqual({ map: { k: "v" }, set: ["v"] });
    expect(invoked).toBe(false);
  });

  it("an error whose name is not a fixed error name is logged as Error", () => {
    const error = new Error("text");
    error.name = "skFAKER1SECRET0123456789abcdef";
    expect(redactForLog(error)).toEqual({ name: "Error" });
    const known = new TransportError("text");
    expect(redactForLog(known)).toEqual({ name: "TransportError" });
  });

  it("a revoked or trap-throwing proxy is [unreadable], never a throw", () => {
    expect(redactForLog({ inner: revokedProxy() })).toEqual({ inner: "[unreadable]" });
    expect(redactForLog({ inner: hostileProxy({}) })).toEqual({ inner: "[unreadable]" });
  });
});

// ---------------------------------------------------------------------------

describe("CX-R1-05: an inherited property name is not an SDK post status", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("status %j → UNRECOGNISED", (status) => {
    expect(
      mapOrderResponse({ ok: true, orderId: "0x1", status, makingAmount: "0", takingAmount: "0", tradeIds: [], transactionsHashes: [] }),
    ).toEqual({ kind: "UNKNOWN", reason: "UNRECOGNISED_RESPONSE", error: null });
  });
});

// ---------------------------------------------------------------------------

describe("L5: the SDK's signed order must say what was asked", () => {
  const request = { assetId: "12345", side: "BUY", price: "0.52", size: "10" } as const;

  /** The fake SDK's default order for `request`, with one field replaced. */
  function tampered(patch: Record<string, unknown>): FakeSdkScript {
    return {
      createLimitOrder: async (req, signer) => {
        const { factory } = createFakeSdkFactory();
        const port = await factory({ signer });
        const order = (await port.createLimitOrder(req)) as unknown as Record<string, unknown>;
        return { ...order, ...patch };
      },
    };
  }

  it("control: the untampered fake order is SIGNED", async () => {
    const { client } = await setup(tampered({}));
    expect((await client.createLimitOrder(request)).kind).toBe("SIGNED");
  });

  it.each([
    ["another token", { tokenId: "999" }],
    ["the other side", { side: "SELL" }],
    ["post-only set when not asked", { postOnly: true }],
    ["an expiration when none was asked", { expiration: 1_900_000_000 }],
    ["GTD when none was asked", { orderType: "GTD" }],
    ["FOK instead of GTC", { orderType: "FOK" }],
    ["more shares than asked", { takerAmount: "10010000" }],
    ["shares rounded down by a whole lot", { takerAmount: "9990000", makerAmount: "5194800" }],
    ["paying more than price × shares", { makerAmount: "5200001" }],
    ["paying far less than price × shares", { makerAmount: "5100000" }],
    ["zero shares", { takerAmount: "0", makerAmount: "0" }],
  ])("%s → FAILED, never an envelope", async (_label, patch) => {
    const { client } = await setup(tampered(patch));
    expect(await client.createLimitOrder(request)).toMatchObject({ kind: "FAILED", error: { kind: "UNKNOWN" } });
  });

  it("a SELL's proceeds must be exactly price × shares: no rounding is tolerated (ADR-034 D2.4)", async () => {
    const sell = { ...request, side: "SELL" } as const;
    // 0.52 × 10 shares = 5.2 pUSD = 5,200,000 base units. Before ADR-034 D2.4 a quote rounded down by less than
    // 10^3 base units was SIGNED (5199001); on-grid inputs need no rounding (A F-102), so any deviation fails closed.
    for (const [takerAmount, kind] of [
      ["5200000", "SIGNED"],
      ["5199999", "FAILED"],
      ["5199001", "FAILED"],
      ["5199000", "FAILED"],
      ["5200001", "FAILED"],
    ] as const) {
      const { client } = await setup(tampered({ makerAmount: "10000000", takerAmount }));
      expect((await client.createLimitOrder(sell)).kind, takerAmount).toBe(kind);
    }
  });

  it.each(["1", "1.0", "1.5", "2", "0.0"])("price %j is outside (0, 1): INVALID_REQUEST, nothing signed", async (price) => {
    const { client, recorder } = await setup();
    expect(await client.createLimitOrder({ ...request, price })).toMatchObject({ kind: "FAILED", error: { kind: "INVALID_REQUEST" } });
    expect(recorder.calls.get("createLimitOrder") ?? 0).toBe(0);
  });

  it("prices just inside (0, 1) are accepted, with exact decimal strings", async () => {
    const { client } = await setup();
    for (const price of ["0.001", "0.999"]) {
      expect((await client.createLimitOrder({ ...request, price })).kind, price).toBe("SIGNED");
    }
  });
});
