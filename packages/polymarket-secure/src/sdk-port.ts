/**
 * The seam between this package and the pinned SDK (`@polymarket/client`,
 * exactly `0.12.0`; V2-5 re-pinned it from `0.11.0`, with the fresh check of
 * venue report 2026-09-30 §W.1 recorded in `docs/runbooks/signer.md` §7).
 *
 * {@link SdkSecureClientPort} is the SUBSET of the SDK's `SecureClient` this
 * package uses. Keeping it a `Pick` of the SDK's own type means a breaking
 * SDK change to any method used here fails `typecheck`, not production.
 *
 * {@link makeRealSdkClientFactory} is the only PRODUCTION place this package
 * calls `createSecureClient`. It is not exported from the package entry
 * points; the public factory (`createSecureVenueClient`) reaches it only after
 * the run-mode gate and the signer checks have passed. The test-only contract
 * hook `testing/sdk-contract.ts` wraps it (it adds FAKE credentials, so the
 * real SDK code can run behind the network tripwire); the `./testing`
 * subpath is importable by test files only (`sdk-import-boundary.test.ts`).
 *
 * THE PORT MUST NEVER GAIN A `place*` MEMBER: the SDK's `placeLimitOrder` /
 * `placeMarketOrder` post the order AND, on a 400 "allowance is not enough",
 * send ERC-20 / ERC-1155 approval transactions by themselves
 * (`actions/orders/trade.ts`, `postOrderWithAllowanceRecovery`). V2-5 pins
 * the ten members (`v2-5.test.ts`).
 */

import { createSecureClient, type RateLimitUpdate, type SecureClient, type Signer } from "@polymarket/client";

export type SdkSecureClientPort = Pick<
  SecureClient,
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
>;

export interface SdkClientFactoryArguments {
  readonly signer: Signer;
  readonly wallet?: string;
  readonly onRateLimitUpdate?: (update: RateLimitUpdate) => void;
}

export type SdkClientFactory = (args: SdkClientFactoryArguments) => Promise<SdkSecureClientPort>;

/**
 * Bind the real SDK constructor. `create` is injectable so a test can prove
 * what this binding passes to the SDK without the SDK doing any I/O.
 *
 * No `credentials` or `nonce` are passed: the SDK derives or retrieves the L2
 * API credentials itself (venue report §W.2, S-D43: "derives or retrieves API
 * credentials"), so no caller of this package ever handles them. No
 * `environment` is passed: the SDK default is its `production` config.
 */
export function makeRealSdkClientFactory(create: typeof createSecureClient = createSecureClient): SdkClientFactory {
  return async (args) => {
    const options: Parameters<typeof createSecureClient>[0] = {
      signer: args.signer,
      ...(args.wallet === undefined ? {} : { wallet: args.wallet }),
      ...(args.onRateLimitUpdate === undefined ? {} : { onRateLimitUpdate: args.onRateLimitUpdate }),
    };
    return create(options);
  };
}
