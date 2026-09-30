/**
 * The signer boundary (ADR-010 §3–§4): construction refuses in PAPER,
 * BACKTEST, SHADOW and REPLAY processes; the gate runs before the signer or
 * the SDK is touched; only sealed handles pass; the mock can never reach the
 * real SDK; and the mock itself cannot sign anything but an in-memory fixture.
 */

import { inspect } from "node:util";

import { TransportError } from "@polymarket/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecureVenueError, SignerBoundaryRefusal } from "./errors.js";
import { signerGateContextFromSafetyFlags } from "./run-mode-gate.js";
import { makeRealSdkClientFactory } from "./sdk-port.js";
import { isSealedSignerHandle, SignerHandle, unsealSigner } from "./signer.js";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  MOCK_FIXTURE_DOMAIN_NAME,
  MOCK_SIGNER_ADDRESS,
  MockSignerRefusal,
  type NetworkTripwire,
} from "./testing/index.js";
import { createSecureVenueClient } from "./venue-client.js";

/** A test-only context shape; it is data, and it only ever meets the fake SDK or a refusal. */
const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

async function refusalOf(promise: Promise<unknown>): Promise<SignerBoundaryRefusal> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SignerBoundaryRefusal);
    return error as SignerBoundaryRefusal;
  }
  throw new Error("expected a SignerBoundaryRefusal, but construction succeeded");
}

describe("a PAPER / BACKTEST / SHADOW / REPLAY process cannot construct a secure client", () => {
  const nonLive = [
    { runMode: "PAPER", maximumRunMode: "PAPER", allowRealOrders: false },
    { runMode: "BACKTEST", maximumRunMode: "PAPER", allowRealOrders: false },
    { runMode: "SHADOW", maximumRunMode: "SHADOW", allowRealOrders: false },
    { runMode: "REPLAY", maximumRunMode: "PAPER", allowRealOrders: false },
    // Even a mis-set ALLOW_REAL_ORDERS / maximum does not rescue a non-live mode.
    { runMode: "PAPER", maximumRunMode: "LIVE", allowRealOrders: true },
    { runMode: "BACKTEST", maximumRunMode: "LIVE", allowRealOrders: true },
    { runMode: "REPLAY", maximumRunMode: "LIVE", allowRealOrders: true },
  ];

  it.each(nonLive)("the REAL factory refuses %o before touching the signer", async (runModeContext) => {
    const { handle, probe } = createMockSignerHandle();
    const refusal = await refusalOf(createSecureVenueClient({ runModeContext, signer: handle }));
    expect(refusal.reasons.length).toBeGreaterThan(0);
    expect(refusal.reasons).not.toContain("MOCK_SIGNER_REJECTED_BY_REAL_SDK");
    expect(probe.getAddressCalls + probe.signTypedDataCalls + probe.signMessageCalls + probe.sendTransactionCalls).toBe(0);
  });

  it.each(nonLive)("the TEST factory refuses %o too, and never calls the SDK factory", async (runModeContext) => {
    const { handle, probe } = createMockSignerHandle();
    const { factory, recorder } = createFakeSdkFactory();
    await refusalOf(createSecureVenueClientForTesting({ runModeContext, signer: handle }, factory));
    expect(recorder.factoryCalls).toHaveLength(0);
    expect(probe.getAddressCalls + probe.signTypedDataCalls).toBe(0);
  });

  it("this test process's own environment is a refusal (the repository defaults)", async () => {
    const { handle } = createMockSignerHandle();
    const refusal = await refusalOf(
      createSecureVenueClient({ runModeContext: signerGateContextFromSafetyFlags(process.env), signer: handle }),
    );
    expect(refusal.reasons).toContain("REAL_ORDERS_NOT_ALLOWED");
  });

  it("the gate runs FIRST: a forged handle in a PAPER process reports the gate's reasons, not the handle's", async () => {
    const refusal = await refusalOf(
      createSecureVenueClient({
        runModeContext: { runMode: "PAPER", maximumRunMode: "PAPER", allowRealOrders: false },
        signer: {} as SignerHandle,
      }),
    );
    expect(refusal.reasons).toEqual(["RUN_MODE_REQUIRES_NO_SIGNER", "REAL_ORDERS_NOT_ALLOWED"]);
  });

  it("refuses a missing or malformed options object", async () => {
    await refusalOf(createSecureVenueClient(undefined as never));
    await refusalOf(createSecureVenueClient({ signer: createMockSignerHandle().handle } as never));
  });
});

describe("only sealed handles pass, and the mock never reaches the real SDK", () => {
  it.each([
    ["a plain object", {}],
    ["null", null],
    ["a lookalike with the class prototype", Object.create(SignerHandle.prototype) as unknown],
    ["a string", "[SignerHandle]"],
  ])("refuses %s as SIGNER_NOT_SEALED (behind a live-shaped context)", async (_label, forged) => {
    const { factory, recorder } = createFakeSdkFactory();
    const refusal = await refusalOf(
      createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: forged as SignerHandle }, factory),
    );
    expect(refusal.reasons).toEqual(["SIGNER_NOT_SEALED"]);
    expect(recorder.factoryCalls).toHaveLength(0);
  });

  it("a handle cannot be constructed outside the boundary", () => {
    expect(() => SignerHandle.create()).toThrow(TypeError);
    expect(() => Reflect.construct(SignerHandle, [])).toThrow(TypeError);
  });

  it("the REAL factory refuses the test mock signer even behind a live-shaped context, without unsealing it", async () => {
    const { handle, probe } = createMockSignerHandle();
    const refusal = await refusalOf(createSecureVenueClient({ runModeContext: LIVE_SHAPED_CONTEXT, signer: handle }));
    expect(refusal.reasons).toEqual(["MOCK_SIGNER_REJECTED_BY_REAL_SDK"]);
    expect(probe.getAddressCalls + probe.signTypedDataCalls + probe.signMessageCalls + probe.sendTransactionCalls).toBe(0);
  });

  it("the TEST factory accepts the mock over the fake SDK (the one success path) and hands the SDK the sealed signer", async () => {
    const { handle } = createMockSignerHandle();
    const { factory, recorder } = createFakeSdkFactory();
    const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: handle }, factory);
    expect(client.identity.signerAddress).toBe(MOCK_SIGNER_ADDRESS);
    expect(recorder.factoryCalls).toHaveLength(1);
    expect(recorder.factoryCalls[0]?.signer).toBe(unsealSigner(handle)?.signer);
  });
});

describe("the signer handle is opaque", () => {
  it("serialises to a placeholder and exposes no signer", () => {
    const { handle } = createMockSignerHandle();
    expect(JSON.stringify({ handle })).toBe('{"handle":"[SignerHandle]"}');
    expect(inspect(handle, { showHidden: true, depth: Infinity })).toBe("[SignerHandle]");
    expect(String(handle)).toBe("[SignerHandle]");
    expect(Reflect.ownKeys(handle)).toEqual([]);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(isSealedSignerHandle(handle)).toBe(true);
  });
});

describe("the mock signer (TEST ONLY) cannot sign a real order", () => {
  it("refuses the venue's L1 auth domain and any non-fixture domain", async () => {
    const { handle, probe } = createMockSignerHandle();
    const signer = unsealSigner(handle)?.signer;
    expect(signer).toBeDefined();
    await expect(
      signer?.signTypedData({
        domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
        primaryType: "ClobAuth",
        types: { ClobAuth: [{ name: "address", type: "address" }] },
        message: { address: MOCK_SIGNER_ADDRESS },
      }),
    ).rejects.toBeInstanceOf(MockSignerRefusal);
    await expect(signer?.signMessage("0x00")).rejects.toBeInstanceOf(MockSignerRefusal);
    await expect(signer?.sendTransaction({ chainId: 137, to: MOCK_SIGNER_ADDRESS as never })).rejects.toBeInstanceOf(
      MockSignerRefusal,
    );
    expect(probe.refusals).toBe(3);
  });

  it("signs an in-memory fixture with a structurally invalid signature (recovery byte 0x00)", async () => {
    const { handle } = createMockSignerHandle();
    const signature = await unsealSigner(handle)?.signer.signTypedData({
      domain: { name: MOCK_FIXTURE_DOMAIN_NAME, version: "0", chainId: 31337 },
      primaryType: "FixtureOrder",
      types: { FixtureOrder: [{ name: "salt", type: "uint256" }] },
      message: { salt: "1" },
    });
    expect(signature).toMatch(/^0x[0-9a-f]{128}00$/u);
  });
});

describe("the real SDK binding", () => {
  it("passes only the signer, wallet and listener to createSecureClient: no credentials, nonce or environment", async () => {
    const { handle } = createMockSignerHandle();
    const signer = unsealSigner(handle)?.signer;
    const received: unknown[] = [];
    const factory = makeRealSdkClientFactory(async (options) => {
      received.push(options);
      return {} as never;
    });
    const listener = (): void => undefined;
    await factory({ signer: signer as never, wallet: MOCK_SIGNER_ADDRESS, onRateLimitUpdate: listener });
    await factory({ signer: signer as never });
    expect(received).toHaveLength(2);
    expect(Object.keys(received[0] as object).sort()).toEqual(["onRateLimitUpdate", "signer", "wallet"]);
    expect(Object.keys(received[1] as object)).toEqual(["signer"]);
    expect((received[0] as { signer: unknown }).signer).toBe(signer);
  });
});

describe("construction failures are mapped and redacted", () => {
  const SECRET = "fake-passphrase-construction-0123456789";

  it("an SDK failure during construction becomes a SecureVenueError without the SDK's text or cause", async () => {
    const { handle } = createMockSignerHandle();
    const { factory } = createFakeSdkFactory({
      factoryThrows: new TransportError(`derive failed ${SECRET}`, { cause: { headers: { POLY_PASSPHRASE: SECRET } } }),
    });
    try {
      await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: handle }, factory);
      expect.unreachable("construction must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SecureVenueError);
      const mapped = error as SecureVenueError;
      expect(mapped.kind).toBe("TRANSPORT_FAILURE");
      expect(mapped.operation).toBe("CREATE_CLIENT");
      expect(mapped.cause).toBeUndefined();
      expect(inspect(mapped, { showHidden: true, depth: Infinity })).not.toContain(SECRET);
      expect(JSON.stringify(mapped)).not.toContain(SECRET);
    }
  });

  it("an unreadable SDK account identity refuses construction as UNKNOWN", async () => {
    const { handle } = createMockSignerHandle();
    const { factory } = createFakeSdkFactory({ account: { signer: "not-an-address" } });
    await expect(
      createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: handle }, factory),
    ).rejects.toMatchObject({ kind: "UNKNOWN", operation: "CREATE_CLIENT" });
  });

  it("a malformed wallet is INVALID_REQUEST and the SDK is not called", async () => {
    const { handle } = createMockSignerHandle();
    const { factory, recorder } = createFakeSdkFactory();
    await expect(
      createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: handle, wallet: "0x123" }, factory),
    ).rejects.toMatchObject({ kind: "INVALID_REQUEST", effect: "NOT_SENT" });
    expect(recorder.factoryCalls).toHaveLength(0);
  });
});
