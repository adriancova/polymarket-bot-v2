/**
 * The seam between this package and the pinned SDK (`@polymarket/client`,
 * exactly `0.11.0`; venue report §W.1).
 *
 * {@link SdkSecureClientPort} is the SUBSET of the SDK's `SecureClient` this
 * package uses. Keeping it a `Pick` of the SDK's own type means a breaking
 * SDK change to any method used here fails `typecheck`, not production.
 *
 * {@link makeRealSdkClientFactory} is the only place this package calls
 * `createSecureClient`. It is not exported from the package entry points; the
 * public factory (`createSecureVenueClient`) reaches it only after the
 * run-mode gate and the signer checks have passed.
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
