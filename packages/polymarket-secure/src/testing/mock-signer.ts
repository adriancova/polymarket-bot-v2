/**
 * TEST-ONLY mock signer. NOT A PRODUCTION SIGNER. HOLDS NO KEY.
 *
 * Why it cannot sign a real order, three independent ways:
 *
 * 1. THERE IS NO KEY. Nothing here is a private key, a seed or a mnemonic;
 *    no elliptic-curve operation is performed. The "signature" is two
 *    SHA-256 digests of the payload plus a recovery byte of `0x00`, which is
 *    not a valid secp256k1 recovery id (27/28), so no verifier accepts it.
 * 2. IT SIGNS ONLY IN-MEMORY FIXTURES. `signTypedData` refuses any payload
 *    whose EIP-712 domain name is not {@link MOCK_FIXTURE_DOMAIN_NAME}, a
 *    name no venue contract uses (the venue's are `ClobAuthDomain` and the
 *    exchange domains, venue report §W.2). `signMessage` and
 *    `sendTransaction` always refuse.
 * 3. IT CANNOT REACH THE REAL SDK. It is sealed with provenance
 *    `TEST_MOCK`, and `createSecureVenueClient` (the real SDK binding)
 *    refuses that provenance before the signer is ever unsealed.
 *
 * The address is a fixed marker (`0x7e57…0260`, "test"/"WP-260"); no key for
 * it exists in this repository.
 */

import { createHash } from "node:crypto";

import type { Signer as SdkSigner } from "@polymarket/client";

import { sealSigner, type SignerHandle } from "../signer.js";

/** The fixed, non-production address the mock reports. */
export const MOCK_SIGNER_ADDRESS = "0x7e57000000000000000000000000000000000260" as const;

/** The only EIP-712 domain name the mock will sign. No venue contract uses it. */
export const MOCK_FIXTURE_DOMAIN_NAME = "WP-260 TEST FIXTURE - NOT A VENUE DOMAIN" as const;

export class MockSignerRefusal extends Error {
  override readonly name = "MockSignerRefusal";
}

/** Counters a test can read to prove the signer was, or was not, reached. */
export interface MockSignerProbe {
  readonly getAddressCalls: number;
  readonly signTypedDataCalls: number;
  readonly signMessageCalls: number;
  readonly sendTransactionCalls: number;
  readonly refusals: number;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === "bigint" ? `${entry.toString(10)}n` : entry));
}

/** A fake, structurally invalid 65-byte signature (recovery byte 0x00). */
function fakeSignature(payload: unknown): string {
  const text = canonical(payload);
  const first = createHash("sha256").update(`WP-260-MOCK-R:${text}`).digest("hex");
  const second = createHash("sha256").update(`WP-260-MOCK-S:${text}`).digest("hex");
  return `0x${first}${second}00`;
}

/**
 * Create a sealed mock signer handle and a probe of its call counts.
 * The handle is usable only with the test factory in this directory.
 */
export function createMockSignerHandle(): { readonly handle: SignerHandle; readonly probe: MockSignerProbe } {
  const counts = {
    getAddressCalls: 0,
    signTypedDataCalls: 0,
    signMessageCalls: 0,
    sendTransactionCalls: 0,
    refusals: 0,
  };
  const refuse = (what: string): never => {
    counts.refusals += 1;
    throw new MockSignerRefusal(`the WP-260 test mock signer refuses ${what}`);
  };
  const signer: SdkSigner = {
    getAddress: async () => {
      counts.getAddressCalls += 1;
      return MOCK_SIGNER_ADDRESS as unknown as Awaited<ReturnType<SdkSigner["getAddress"]>>;
    },
    signTypedData: async (payload) => {
      counts.signTypedDataCalls += 1;
      if (payload.domain.name !== MOCK_FIXTURE_DOMAIN_NAME) {
        return refuse("a payload that is not an in-memory fixture");
      }
      return fakeSignature(payload) as unknown as Awaited<ReturnType<SdkSigner["signTypedData"]>>;
    },
    signMessage: async () => {
      counts.signMessageCalls += 1;
      return refuse("every message");
    },
    sendTransaction: async () => {
      counts.sendTransactionCalls += 1;
      return refuse("every transaction");
    },
  };
  const probe: MockSignerProbe = {
    get getAddressCalls() {
      return counts.getAddressCalls;
    },
    get signTypedDataCalls() {
      return counts.signTypedDataCalls;
    },
    get signMessageCalls() {
      return counts.signMessageCalls;
    },
    get sendTransactionCalls() {
      return counts.sendTransactionCalls;
    },
    get refusals() {
      return counts.refusals;
    },
  };
  return { handle: sealSigner(signer, "TEST_MOCK"), probe };
}
