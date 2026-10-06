/**
 * TEST-ONLY mock signer. NOT A PRODUCTION SIGNER. HOLDS NO KEY.
 *
 * Why it cannot sign a real order, three independent ways:
 *
 * 1. THERE IS NO KEY. Nothing here is a private key, a seed or a mnemonic;
 *    no elliptic-curve operation is performed. The 65-byte "signature" is
 *    `r = 0` (32 zero bytes), `s` = a SHA-256 digest of the payload, and a
 *    parity byte of `0x00`. ECDSA requires `1 ≤ r ≤ n − 1`, so the value is
 *    not a secp256k1 signature at all: the pinned SDK's own `ox` parses the
 *    bytes but refuses to recover any address from them ("expected valid r"),
 *    as `signer-boundary.test.ts` shows. (An earlier version used a non-zero
 *    `r` and claimed the `0x00` byte alone made it invalid; that was wrong,
 *    since `0x00` is a valid y-parity and `ox` recovered an address.)
 * 2. IT SIGNS ONLY IN-MEMORY FIXTURES. `signTypedData` refuses any payload
 *    whose EIP-712 domain name is not {@link MOCK_FIXTURE_DOMAIN_NAME}, a
 *    name no venue contract uses (the venue's are `ClobAuthDomain` and the
 *    exchange domains, venue report §W.2). `signMessage` and
 *    `sendTransaction` always refuse.
 * 3. IT CANNOT REACH THE REAL SDK THROUGH THE PRODUCTION FACTORY. It is
 *    sealed with provenance `TEST_MOCK`, and `createSecureVenueClient` (the
 *    real SDK binding) refuses that provenance before the signer is ever
 *    unsealed. The contract suite DOES hand it to the real SDK code (V2-5:
 *    `createSecureVenueClientForTesting` over the contract factory of
 *    `./sdk-contract.ts`, with FAKE credentials, behind the network
 *    tripwire); there the SDK asks it to sign a venue order domain, and it
 *    refuses (reason 2). {@link MockSignerProbe.signTypedDataRequests}
 *    records what it was asked to sign, which is how that suite reads the
 *    domain the SDK chose. No signature is produced for any venue domain.
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

/**
 * One `signTypedData` request, recorded before the mock decides (V2-5). Only
 * NON-SECRET data is kept: the EIP-712 domain, the primary type and the
 * message's top-level scalar fields as strings (`bigint` in decimal). An
 * order message carries no signature; nested objects are not copied.
 */
export interface MockSignRequest {
  readonly domain: Readonly<Record<string, string>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, string>>;
  readonly refused: boolean;
}

/** Counters a test can read to prove the signer was, or was not, reached. */
export interface MockSignerProbe {
  readonly getAddressCalls: number;
  readonly signTypedDataCalls: number;
  readonly signMessageCalls: number;
  readonly sendTransactionCalls: number;
  readonly refusals: number;
  /** Every `signTypedData` request, in call order (a fresh frozen copy). */
  readonly signTypedDataRequests: readonly MockSignRequest[];
}

/** Top-level scalar fields of a typed-data object, as strings; anything else is skipped. */
function scalars(value: unknown): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return Object.freeze(out);
  for (const key of Object.keys(value)) {
    const entry: unknown = (value as Record<string, unknown>)[key];
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
    else if (typeof entry === "bigint") out[key] = entry.toString(10);
  }
  return Object.freeze(out);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === "bigint" ? `${entry.toString(10)}n` : entry));
}

/** The fixed `r` of every mock signature: zero, which no ECDSA signature can have. */
export const MOCK_SIGNATURE_R = `0x${"00".repeat(32)}` as const;

/** A fake 65-byte signature with `r = 0`: never a valid secp256k1 signature. */
function fakeSignature(payload: unknown): string {
  const text = canonical(payload);
  const s = createHash("sha256").update(`WP-260-MOCK-S:${text}`).digest("hex");
  return `${MOCK_SIGNATURE_R}${s}00`;
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
  const requests: MockSignRequest[] = [];
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
      const refused = payload.domain.name !== MOCK_FIXTURE_DOMAIN_NAME;
      requests.push(
        Object.freeze({ domain: scalars(payload.domain), primaryType: String(payload.primaryType), message: scalars(payload.message), refused }),
      );
      if (refused) {
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
    get signTypedDataRequests() {
      return Object.freeze([...requests]);
    },
  };
  return { handle: sealSigner(signer, "TEST_MOCK"), probe };
}
