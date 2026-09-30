/**
 * `@polymarket-bot/polymarket-secure/testing`: TEST-ONLY doubles for the
 * signer boundary. Nothing here can sign a real order or reach the venue:
 *
 * - {@link createMockSignerHandle}: a sealed mock signer with NO key
 *   (`./mock-signer.ts` states the three reasons it cannot sign a real order);
 * - {@link createFakeSdkFactory}: a scripted, I/O-free stand-in for the SDK;
 * - {@link createSecureVenueClientForTesting}: the SAME construction path as
 *   the real factory (run-mode gate first, then the handle checks), bound to
 *   a fake SDK, accepting only the mock signer;
 * - {@link installNetworkTripwire}: makes every network attempt throw and
 *   records it;
 * - the SDK contract hooks used by `test/contract/polymarket-secure/**`.
 */

import { buildSecureVenueClient, type CreateSecureVenueClientOptions, type SecureVenueClient } from "../venue-client.js";
import type { SdkClientFactory } from "../sdk-port.js";

export {
  createMockSignerHandle,
  MOCK_FIXTURE_DOMAIN_NAME,
  MOCK_SIGNATURE_R,
  MOCK_SIGNER_ADDRESS,
  MockSignerRefusal,
  type MockSignerProbe,
} from "./mock-signer.js";
export {
  createFakeSdkFactory,
  DEFAULT_FAKE_ACCOUNT,
  FAKE_SDK_CREDENTIALS,
  type FakeSdkRecorder,
  type FakeSdkScript,
} from "./fake-sdk.js";
export {
  installNetworkTripwire,
  NetworkTripwireError,
  type FetchResponder,
  type NetworkAttempt,
  type NetworkTripwire,
} from "./network-tripwire.js";
export { answerAsPinnedSdk, parseOrderResponseWithPinnedSdk, provokeSdkHttpRejection } from "./sdk-contract.js";

/**
 * Construct a secure venue client over a FAKE SDK. The run-mode gate still
 * runs first and still refuses BACKTEST/PAPER/SHADOW/unknown modes; only the
 * test mock signer is accepted.
 */
export async function createSecureVenueClientForTesting(
  options: CreateSecureVenueClientOptions,
  fakeSdk: SdkClientFactory,
): Promise<SecureVenueClient> {
  return buildSecureVenueClient(options, fakeSdk, "TEST_MOCK");
}
