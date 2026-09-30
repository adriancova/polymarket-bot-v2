/**
 * TEST-ONLY scripted stand-in for the pinned SDK's `SecureClient` subset
 * (`SdkSecureClientPort`). It performs no I/O: every method answers from the
 * script or from a fixed in-memory default.
 *
 * Its default `createLimitOrder` builds an in-memory fixture order and asks
 * the signer it was given to sign it under {@link MOCK_FIXTURE_DOMAIN_NAME},
 * so a test exercises the real unseal-and-sign path of the boundary with the
 * mock signer, without any venue domain.
 *
 * It holds a FAKE L2 credential ({@link FAKE_SDK_CREDENTIALS}) the way the
 * real SDK client does (`BaseSecureClient.credentials`), so a test can prove
 * the wrapping client never leaks what the SDK object holds.
 */

import type { SignedOrder as SdkSignedOrder, Signer as SdkSigner } from "@polymarket/client";

import type { SdkClientFactory, SdkClientFactoryArguments, SdkSecureClientPort } from "../sdk-port.js";
import { MOCK_FIXTURE_DOMAIN_NAME, MOCK_SIGNER_ADDRESS } from "./mock-signer.js";

/** Obviously fake, non-production L2 credential values (never a real format match). */
export const FAKE_SDK_CREDENTIALS = Object.freeze({
  key: "fake-api-key-WP260-00000000-not-a-credential",
  secret: "ZmFrZS1zZWNyZXQtV1AyNjAtbm90LWEtY3JlZGVudGlhbA==",
  passphrase: "fake-passphrase-WP260-not-a-credential",
});

type Port = SdkSecureClientPort;
type Answer<M extends keyof Port> = Port[M] extends (...args: infer A) => infer R ? (...args: A) => R | Awaited<R> : never;

/** Per-method overrides. An override may return a value, return a promise, or throw. */
export interface FakeSdkScript {
  readonly account?: Record<string, unknown>;
  readonly createLimitOrder?: (request: Parameters<Port["createLimitOrder"]>[0], signer: SdkSigner) => unknown;
  readonly postOrder?: (order: SdkSignedOrder) => unknown;
  readonly postOrders?: (orders: readonly SdkSignedOrder[]) => unknown;
  readonly cancelOrder?: Answer<"cancelOrder">;
  readonly cancelOrders?: Answer<"cancelOrders">;
  readonly cancelMarketOrders?: Answer<"cancelMarketOrders">;
  readonly cancelAll?: Answer<"cancelAll">;
  readonly fetchOrder?: Answer<"fetchOrder">;
  readonly closeSubscriptions?: () => unknown;
  /** Make the factory itself throw this value. */
  readonly factoryThrows?: unknown;
}

export interface FakeSdkRecorder {
  /** Every factory invocation's arguments (the signer is recorded by identity only). */
  readonly factoryCalls: SdkClientFactoryArguments[];
  /** Method name → call count. */
  readonly calls: Map<string, number>;
  /** Arguments passed to each method, in call order. */
  readonly arguments: Map<string, unknown[]>;
}

export const DEFAULT_FAKE_ACCOUNT = Object.freeze({
  signer: MOCK_SIGNER_ADDRESS,
  wallet: MOCK_SIGNER_ADDRESS,
  signerType: "OWNER",
  walletType: 0,
});

let fixtureSalt = 1_000_000;

/**
 * The amounts the pinned SDK would sign for a limit order at tick 0.01:
 * shares rounded DOWN to 2 decimals, the quote (price × shares) rounded DOWN
 * to 4 decimals, both in 6-decimal base units. Exact integer arithmetic.
 */
function fixtureAmounts(request: Parameters<Port["createLimitOrder"]>[0]): { makerAmount: string; takerAmount: string } {
  const rational = (value: unknown): { n: bigint; d: bigint } => {
    const text = String(value);
    const [whole = "0", fraction = ""] = text.split(".");
    return { n: BigInt(`${whole}${fraction}`), d: 10n ** BigInt(fraction.length) };
  };
  const size = rational("size" in request ? request.size : "0");
  const price = rational(request.price);
  const shares = ((size.n * 1_000_000n) / size.d / 10_000n) * 10_000n;
  const quote = ((price.n * shares) / price.d / 100n) * 100n;
  const [maker, taker] = request.side === "BUY" ? [quote, shares] : [shares, quote];
  return { makerAmount: maker.toString(10), takerAmount: taker.toString(10) };
}

/**
 * The maker, signer and signature type the pinned SDK derives from its
 * account (`Tr` / `Ee` in `@polymarket/client@0.11.0`): signature type =
 * wallet type, maker = wallet, signer = wallet for POLY_1271 (3) else signer.
 */
function fixtureParties(account: Readonly<Record<string, unknown>>): { maker: string; signer: string; signatureType: number } {
  const wallet = typeof account["wallet"] === "string" ? account["wallet"] : MOCK_SIGNER_ADDRESS;
  const signer = typeof account["signer"] === "string" ? account["signer"] : MOCK_SIGNER_ADDRESS;
  const signatureType = typeof account["walletType"] === "number" ? account["walletType"] : 0;
  return { maker: wallet, signer: signatureType === 3 ? wallet : signer, signatureType };
}

/** Build and mock-sign an in-memory fixture order. */
async function defaultCreateLimitOrder(
  request: Parameters<Port["createLimitOrder"]>[0],
  signer: SdkSigner,
  account: Readonly<Record<string, unknown>>,
): Promise<SdkSignedOrder> {
  fixtureSalt += 1;
  const tokenId = "assetId" in request && typeof request.assetId === "string" ? request.assetId : "1";
  const message = {
    salt: String(fixtureSalt),
    ...fixtureParties(account),
    tokenId,
    ...fixtureAmounts(request),
    side: request.side,
    timestamp: "1767225600000",
    metadata: `0x${"0".repeat(64)}`,
    builder: `0x${"0".repeat(64)}`,
  };
  const signature = await signer.signTypedData({
    domain: { name: MOCK_FIXTURE_DOMAIN_NAME, version: "0", chainId: 31337 },
    primaryType: "FixtureOrder",
    types: { FixtureOrder: [{ name: "salt", type: "uint256" }] },
    message,
  });
  const order = {
    ...message,
    expiration: request.expiration ?? 0,
    orderType: request.expiration === undefined ? "GTC" : "GTD",
    signature,
    ...(request.postOnly === undefined ? {} : { postOnly: request.postOnly }),
  };
  return order as unknown as SdkSignedOrder;
}

/**
 * A scripted SDK factory and a recorder of what the boundary handed it.
 */
export function createFakeSdkFactory(script: FakeSdkScript = {}): {
  readonly factory: SdkClientFactory;
  readonly recorder: FakeSdkRecorder;
} {
  const recorder: FakeSdkRecorder = { factoryCalls: [], calls: new Map(), arguments: new Map() };
  const record = (method: string, args: unknown[]): void => {
    recorder.calls.set(method, (recorder.calls.get(method) ?? 0) + 1);
    recorder.arguments.set(method, [...(recorder.arguments.get(method) ?? []), args]);
  };
  const factory: SdkClientFactory = async (args) => {
    recorder.factoryCalls.push(args);
    if ("factoryThrows" in script) throw script.factoryThrows;
    const signer = args.signer;
    const answer = async (method: string, override: ((...a: never[]) => unknown) | undefined, a: unknown[], fallback: () => unknown): Promise<never> => {
      record(method, a);
      return (await (override === undefined ? fallback() : (override as (...x: unknown[]) => unknown)(...a))) as never;
    };
    const port = {
      get credentials() {
        return FAKE_SDK_CREDENTIALS;
      },
      get account() {
        return (script.account ?? DEFAULT_FAKE_ACCOUNT) as never;
      },
      createLimitOrder: (request: Parameters<Port["createLimitOrder"]>[0]) =>
        answer(
          "createLimitOrder",
          script.createLimitOrder === undefined ? undefined : (r: never) => script.createLimitOrder?.(r, signer),
          [request],
          () => defaultCreateLimitOrder(request, signer, script.account ?? DEFAULT_FAKE_ACCOUNT),
        ),
      postOrder: (order: SdkSignedOrder) =>
        answer("postOrder", script.postOrder as never, [order], () => ({
          ok: true,
          orderId: "0x00000000000000000000000000000000000000000000000000000000feed0001",
          status: "live",
          makingAmount: "0",
          takingAmount: "0",
          tradeIds: [],
          transactionsHashes: [],
        })),
      postOrders: (orders: SdkSignedOrder[]) =>
        answer("postOrders", script.postOrders as never, [orders], () =>
          orders.map((_order, index) => ({
            ok: true,
            orderId: `0x${(index + 1).toString(16).padStart(64, "0")}`,
            status: "live",
            makingAmount: "0",
            takingAmount: "0",
            tradeIds: [],
            transactionsHashes: [],
          })),
        ),
      cancelOrder: (request: { orderId: string }) =>
        answer("cancelOrder", script.cancelOrder as never, [request], () => ({ canceled: [request.orderId], notCanceled: {} })),
      cancelOrders: (request: { orderIds: string[] }) =>
        answer("cancelOrders", script.cancelOrders as never, [request], () => ({ canceled: request.orderIds, notCanceled: {} })),
      cancelMarketOrders: (request: unknown) =>
        answer("cancelMarketOrders", script.cancelMarketOrders as never, [request], () => ({ canceled: [], notCanceled: {} })),
      cancelAll: () => answer("cancelAll", script.cancelAll as never, [], () => ({ canceled: [], notCanceled: {} })),
      fetchOrder: (request: { orderId: string }) =>
        answer("fetchOrder", script.fetchOrder as never, [request], () => ({
          id: request.orderId,
          assetId: "1",
          tokenId: "1",
          conditionId: `0x${"1".repeat(64)}`,
          owner: FAKE_SDK_CREDENTIALS.key,
          makerAddress: MOCK_SIGNER_ADDRESS,
          side: "BUY",
          price: "0.52",
          originalSize: "10",
          sizeMatched: "0",
          outcome: "Yes",
          orderType: "GTC",
          status: "LIVE",
          associateTrades: [],
          createdAt: "2026-09-30T00:00:00.000Z",
        })),
      closeSubscriptions: () => answer("closeSubscriptions", script.closeSubscriptions as never, [], () => undefined),
    };
    return port as unknown as SdkSecureClientPort;
  };
  return { factory, recorder };
}
