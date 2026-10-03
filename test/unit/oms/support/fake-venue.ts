/**
 * A scripted stand-in for WP-260's `SecureVenueClient`, bound to the OMS's
 * venue port. It holds no key and reaches no network: a "signature" is a
 * synthetic hex string derived from the salt, used only so the suites can
 * prove that it never reaches the store in clear.
 */

import type {
  CancelOutcome,
  LimitOrderRequest,
  OmsVenuePort,
  PlacementOutcome,
  SignOutcome,
  SignedOrderHandle,
  SignedOrderIdentity,
  VenueErrorView,
} from "../../../../packages/oms/src/index.js";

export const MAKER = "0x1111111111111111111111111111111111111111";
export const SIGNER = "0x2222222222222222222222222222222222222222";

/** The synthetic signature for a salt. Distinctive, so a leak is easy to find. */
export function signatureFor(salt: string): string {
  return `0x5157${salt.padStart(8, "0")}c0ffee${salt.padStart(8, "0")}`;
}

const PAYLOADS = new WeakMap<FakeSignedOrder, Readonly<Record<string, string | number | boolean>>>();

/** Mirrors `SignedOrderEnvelope`: `identity` is own data; the payload is behind a prototype method. */
export class FakeSignedOrder implements SignedOrderHandle {
  readonly identity: SignedOrderIdentity;

  constructor(payload: Readonly<Record<string, string | number | boolean>>) {
    this.identity = Object.freeze({
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
    PAYLOADS.set(this, Object.freeze({ ...payload }));
    Object.freeze(this);
  }

  revealPayloadForEncryptedPersistence(): Readonly<Record<string, string | number | boolean>> {
    const payload = PAYLOADS.get(this);
    if (payload === undefined) throw new TypeError("not a FakeSignedOrder");
    return payload;
  }

  toJSON(): { readonly identity: SignedOrderIdentity } {
    return { identity: this.identity };
  }
}

/** The real envelope's shape (`packages/polymarket-secure/src/signed-order.ts`): 14 required keys, `postOnly` optional. */
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
];
const OPTIONAL_PAYLOAD_KEYS = ["postOnly"];

/** `SignedOrderEnvelope.fromPersistedPayload`'s role: strict shape (as the real one: `postOnly` optional), else `undefined`. */
export function restoreFakeSignedOrder(payload: unknown): SignedOrderHandle | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const keys = Object.keys(payload);
  if (keys.some((key) => !PAYLOAD_KEYS.includes(key) && !OPTIONAL_PAYLOAD_KEYS.includes(key))) return undefined;
  if (PAYLOAD_KEYS.some((key) => !keys.includes(key))) return undefined;
  const postOnly = (payload as Record<string, unknown>)["postOnly"];
  if (postOnly !== undefined && typeof postOnly !== "boolean") return undefined;
  return new FakeSignedOrder(payload as Record<string, string | number | boolean>);
}

export function venueError(kind: string, effect: "NOT_SENT" | "NOT_APPLIED" | "UNKNOWN", retryAfterSeconds: number | null = null): VenueErrorView {
  return Object.freeze({ kind, effect, retryAfterSeconds });
}

export function accepted(orderId: string, status: "LIVE" | "MATCHED" | "DELAYED" = "LIVE"): PlacementOutcome {
  return Object.freeze({ kind: "ACCEPTED", orderId, status, makingAmount: "0", takingAmount: "0", tradeIds: [], transactionHashes: [] });
}

export type PlacementScript = (handle: SignedOrderHandle, call: number) => PlacementOutcome | Promise<PlacementOutcome>;
export type BatchScript = (handles: readonly SignedOrderHandle[], call: number) => readonly PlacementOutcome[] | Promise<readonly PlacementOutcome[]>;
export type CancelScript = (orderId: string, call: number) => CancelOutcome | Promise<CancelOutcome>;
export type SignScript = (request: LimitOrderRequest, salt: string) => SignOutcome | undefined;

/** The venue order id the default script assigns: derived from the salt, so a test can predict it. */
export function venueIdFor(salt: string): string {
  return `venue-${salt}`;
}

export class FakeVenue implements OmsVenuePort {
  /** Salts in signing order. */
  readonly signed: string[] = [];
  /** Salts of every handle the venue received, one entry per receipt, in order. */
  readonly received: string[] = [];
  readonly postCalls: string[][] = [];
  readonly cancels: string[] = [];
  placement: PlacementScript = (handle) => accepted(venueIdFor(handle.identity.salt));
  batch: BatchScript | null = null;
  cancel: CancelScript = (orderId) => Object.freeze({ kind: "COMPLETED", canceled: [orderId], notCanceled: [] });
  sign: SignScript | null = null;
  #salt = 1000;
  #calls = 0;

  async createLimitOrder(request: LimitOrderRequest): Promise<SignOutcome> {
    this.#salt += 1;
    const salt = String(this.#salt);
    const scripted = this.sign?.(request, salt);
    if (scripted !== undefined) return scripted;
    this.signed.push(salt);
    const payload = {
      builder: `0x${"0".repeat(64)}`,
      expiration: request.expirationUnixSeconds ?? 0,
      maker: MAKER,
      makerAmount: "1000000",
      metadata: `0x${"0".repeat(64)}`,
      orderType: request.expirationUnixSeconds === undefined ? "GTC" : "GTD",
      postOnly: request.postOnly === true,
      salt,
      side: request.side,
      signature: signatureFor(salt),
      signatureType: 3,
      signer: SIGNER,
      takerAmount: "2000000",
      timestamp: "1790000000000",
      tokenId: request.assetId,
    };
    return Object.freeze({ kind: "SIGNED", order: new FakeSignedOrder(payload) });
  }

  async postOrder(order: SignedOrderHandle): Promise<PlacementOutcome> {
    this.#calls += 1;
    this.received.push(order.identity.salt);
    this.postCalls.push([order.identity.salt]);
    return this.placement(order, this.#calls);
  }

  async postOrders(orders: readonly SignedOrderHandle[]): Promise<readonly PlacementOutcome[]> {
    this.#calls += 1;
    const salts = orders.map((order) => order.identity.salt);
    this.received.push(...salts);
    this.postCalls.push(salts);
    if (this.batch !== null) return this.batch(orders, this.#calls);
    return Promise.all(orders.map((order) => this.placement(order, this.#calls)));
  }

  async cancelOrder(orderId: string): Promise<CancelOutcome> {
    this.cancels.push(orderId);
    return this.cancel(orderId, this.cancels.length);
  }
}
