/**
 * The signer boundary's handle (ADR-010 §3–§4; handoff §9.12 "Isolate all
 * signer access", §15).
 *
 * A {@link SignerHandle} is an OPAQUE token. Code outside this package can
 * hold one and pass it to a factory, and can do nothing else with it: it has
 * no method that signs, no method that returns the signer, and it serialises
 * to a fixed placeholder. The signer object it stands for lives in a
 * module-private `WeakMap`, reachable only through {@link unsealSigner},
 * which is not exported from the package entry points.
 *
 * WHAT IS NOT HERE. This package ships no real signer and no code path that
 * loads a key: not from the environment, not from a file, not from an
 * argument. The only way to obtain a handle today is the TEST-ONLY mock in
 * `./testing/mock-signer.ts`, sealed with provenance `TEST_MOCK`, which holds
 * no key at all. A real signer is a later, human-gated work item (ADR-010 §1,
 * §3: "A real signer is mounted only into the live execution process after
 * the live-micro gate is approved").
 */

import { inspect } from "node:util";

import type { Signer as SdkSigner } from "@polymarket/client";

/**
 * Where a sealed signer came from.
 *
 * `TEST_MOCK` is the only provenance this package can produce. The real SDK
 * factory refuses it, and the test factory accepts nothing else.
 */
export type SignerProvenance = "TEST_MOCK";

interface SealedSigner {
  readonly signer: SdkSigner;
  readonly provenance: SignerProvenance;
}

const SEALED = new WeakMap<SignerHandle, SealedSigner>();

/** Set only while {@link sealSigner} runs, so `new SignerHandle()` elsewhere fails. */
let sealing = false;

/** An opaque reference to a signer that never leaves this package. */
export class SignerHandle {
  private constructor() {
    if (!sealing) {
      throw new TypeError("SignerHandle cannot be constructed outside the signer boundary");
    }
    Object.freeze(this);
  }

  /** @internal Used only by {@link sealSigner}. */
  static create(): SignerHandle {
    return new SignerHandle();
  }

  toJSON(): string {
    return "[SignerHandle]";
  }

  toString(): string {
    return "[SignerHandle]";
  }

  [inspect.custom](): string {
    return "[SignerHandle]";
  }
}

/**
 * Seal a signer behind a new opaque handle. PACKAGE-INTERNAL: not exported
 * from `index.ts` or `testing/index.ts`.
 */
export function sealSigner(signer: SdkSigner, provenance: SignerProvenance): SignerHandle {
  sealing = true;
  let handle: SignerHandle;
  try {
    handle = SignerHandle.create();
  } finally {
    sealing = false;
  }
  SEALED.set(handle, Object.freeze({ signer, provenance }));
  return handle;
}

/** True only for a handle {@link sealSigner} produced (a forged object is not). */
export function isSealedSignerHandle(value: unknown): value is SignerHandle {
  return typeof value === "object" && value !== null && SEALED.has(value as SignerHandle);
}

/**
 * The sealed signer and its provenance, or `undefined` for anything that is
 * not a genuine handle. PACKAGE-INTERNAL.
 */
export function unsealSigner(value: unknown): SealedSigner | undefined {
  return isSealedSignerHandle(value) ? SEALED.get(value) : undefined;
}
