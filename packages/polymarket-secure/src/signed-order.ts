/**
 * The signed-order envelope (ADR-007 §2 steps 2–3, §4, §11; handoff §15).
 *
 * A signed order is created and signed LOCALLY, persisted, and only then
 * transmitted. Its signature is secret material under §15 ("Logs redact …
 * signatures, signed order payloads"), so the envelope is opaque in the same
 * way a {@link SignerHandle} is:
 *
 * - `identity` carries the non-secret fields the OMS keys idempotency on
 *   (the salt above all: "a new salt creates a new order", ADR-007 §4).
 * - The full payload, signature included, is reachable only through
 *   {@link SignedOrderEnvelope.revealPayloadForEncryptedPersistence}, whose
 *   name states the one permitted use (§15: "Signed order payloads persisted
 *   for idempotency are encrypted at rest and access-controlled"; that
 *   encryption is `WP-270`'s).
 * - `toJSON`, `toString` and `util.inspect` render `identity` only.
 *
 * `fromPersistedPayload` re-creates an envelope from that payload with a
 * strict shape check, so the same signed order can be re-posted after a
 * restart without re-signing (ADR-007 §2 step 9: "Retry the same signed order").
 */

import { inspect } from "node:util";

import type { SignedOrder as SdkSignedOrder } from "@polymarket/client";

/** The non-secret identity of a signed order. Every value is an exact string or integer. */
export interface SignedOrderIdentity {
  readonly salt: string;
  readonly maker: string;
  readonly signer: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  /** Base units, exact decimal integer string. */
  readonly makerAmount: string;
  /** Base units, exact decimal integer string. */
  readonly takerAmount: string;
  readonly orderType: "GTC" | "GTD" | "FOK" | "FAK";
  /** Unix seconds; `0` when the order does not expire. */
  readonly expiration: number;
  readonly timestamp: string;
  /** Guide and SDK: 0 EOA, 1 Proxy, 2 Safe, 3 Deposit Wallet (C-10: not the OpenAPI's 0–2). */
  readonly signatureType: number;
  readonly postOnly: boolean;
}

const PAYLOAD_KEYS = [
  "builder",
  "expiration",
  "maker",
  "makerAmount",
  "metadata",
  "orderType",
  "salt",
  "side",
  "signature",
  "signatureType",
  "signer",
  "takerAmount",
  "timestamp",
  "tokenId",
] as const;
const OPTIONAL_PAYLOAD_KEYS = ["postOnly"] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HEX = /^0x[0-9a-fA-F]*$/u;
const NON_EMPTY_HEX = /^0x[0-9a-fA-F]+$/u;
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]{0,77})$/u;
const TOKEN_ID = /^(?:0|[1-9][0-9]{0,77}|0x[0-9a-fA-F]{1,64})$/u;
const ORDER_TYPES = new Set(["GTC", "GTD", "FOK", "FAK"]);
const SIDES = new Set(["BUY", "SELL"]);
const SIGNATURE_TYPES = new Set([0, 1, 2, 3]);

type PayloadRecord = Readonly<Record<string, string | number | boolean>>;

/** Validate a candidate payload; return a frozen plain copy or `undefined`. */
function readPayload(candidate: unknown): PayloadRecord | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const allowed = new Set<string>([...PAYLOAD_KEYS, ...OPTIONAL_PAYLOAD_KEYS]);
  const out: Record<string, string | number | boolean> = {};
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== "string" || !allowed.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const value: unknown = descriptor.value;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
    out[key] = value;
  }
  for (const key of PAYLOAD_KEYS) {
    if (!(key in out)) return undefined;
  }
  const str = (key: string): string | undefined => (typeof out[key] === "string" ? out[key] : undefined);
  const ok =
    ADDRESS.test(str("maker") ?? "") &&
    ADDRESS.test(str("signer") ?? "") &&
    HEX.test(str("builder") ?? "") &&
    HEX.test(str("metadata") ?? "") &&
    NON_EMPTY_HEX.test(str("signature") ?? "") &&
    UNSIGNED_INTEGER.test(str("salt") ?? "") &&
    UNSIGNED_INTEGER.test(str("makerAmount") ?? "") &&
    UNSIGNED_INTEGER.test(str("takerAmount") ?? "") &&
    UNSIGNED_INTEGER.test(str("timestamp") ?? "") &&
    TOKEN_ID.test(str("tokenId") ?? "") &&
    SIDES.has(str("side") ?? "") &&
    ORDER_TYPES.has(str("orderType") ?? "") &&
    typeof out["expiration"] === "number" &&
    Number.isSafeInteger(out["expiration"]) &&
    out["expiration"] >= 0 &&
    typeof out["signatureType"] === "number" &&
    SIGNATURE_TYPES.has(out["signatureType"]) &&
    (out["postOnly"] === undefined || typeof out["postOnly"] === "boolean");
  return ok ? Object.freeze(out) : undefined;
}

const PAYLOADS = new WeakMap<SignedOrderEnvelope, PayloadRecord>();
let constructing = false;

export class SignedOrderEnvelope {
  readonly identity: SignedOrderIdentity;

  private constructor(identity: SignedOrderIdentity) {
    if (!constructing) throw new TypeError("SignedOrderEnvelope is created only by the secure venue client");
    this.identity = identity;
    Object.freeze(this);
  }

  /** @internal Wrap a payload that {@link readPayload} accepted. */
  private static wrap(payload: PayloadRecord): SignedOrderEnvelope {
    const identity: SignedOrderIdentity = Object.freeze({
      salt: payload["salt"] as string,
      maker: payload["maker"] as string,
      signer: payload["signer"] as string,
      tokenId: payload["tokenId"] as string,
      side: payload["side"] as "BUY" | "SELL",
      makerAmount: payload["makerAmount"] as string,
      takerAmount: payload["takerAmount"] as string,
      orderType: payload["orderType"] as SignedOrderIdentity["orderType"],
      expiration: payload["expiration"] as number,
      timestamp: payload["timestamp"] as string,
      signatureType: payload["signatureType"] as number,
      postOnly: payload["postOnly"] === true,
    });
    constructing = true;
    let envelope: SignedOrderEnvelope;
    try {
      envelope = new SignedOrderEnvelope(identity);
    } finally {
      constructing = false;
    }
    PAYLOADS.set(envelope, payload);
    return envelope;
  }

  /**
   * Re-create an envelope from a payload previously obtained through
   * {@link revealPayloadForEncryptedPersistence}. Returns `undefined` for
   * anything that is not exactly that shape.
   */
  static fromPersistedPayload(payload: unknown): SignedOrderEnvelope | undefined {
    let read: PayloadRecord | undefined;
    try {
      read = readPayload(payload);
    } catch {
      // A reflection failure (a revoked proxy, a throwing trap) is "not that
      // shape"; the thrown value is dropped unread.
      return undefined;
    }
    return read === undefined ? undefined : SignedOrderEnvelope.wrap(read);
  }

  /** @internal Wrap the SDK's signed order. `undefined` when its shape is not the pinned one. */
  static fromSdkSignedOrder(order: SdkSignedOrder): SignedOrderEnvelope | undefined {
    // Copy the SDK object's own data into a plain record first, so the
    // envelope never holds a reference into the SDK's object graph.
    const plain: Record<string, unknown> = {};
    try {
      for (const key of Object.keys(order)) {
        const descriptor = Object.getOwnPropertyDescriptor(order, key);
        if (descriptor !== undefined && "value" in descriptor) plain[key] = descriptor.value;
      }
    } catch {
      return undefined;
    }
    return SignedOrderEnvelope.fromPersistedPayload(plain);
  }

  /**
   * The complete signed payload, signature included, as a frozen plain
   * object. For ENCRYPTED persistence only (§15, ADR-007 §11): never log it,
   * never put it in a fixture or an error message.
   */
  revealPayloadForEncryptedPersistence(): Readonly<Record<string, string | number | boolean>> {
    const payload = PAYLOADS.get(this);
    if (payload === undefined) throw new TypeError("not a SignedOrderEnvelope");
    return payload;
  }

  /** @internal The payload in the SDK's type, for `postOrder`. */
  static toSdkSignedOrder(envelope: SignedOrderEnvelope): SdkSignedOrder {
    return envelope.revealPayloadForEncryptedPersistence() as unknown as SdkSignedOrder;
  }

  static isEnvelope(value: unknown): value is SignedOrderEnvelope {
    return typeof value === "object" && value !== null && PAYLOADS.has(value as SignedOrderEnvelope);
  }

  toJSON(): { readonly identity: SignedOrderIdentity } {
    return { identity: this.identity };
  }

  toString(): string {
    return `[SignedOrderEnvelope salt=${this.identity.salt}]`;
  }

  [inspect.custom](): string {
    return `SignedOrderEnvelope ${JSON.stringify(this.toJSON())}`;
  }
}
