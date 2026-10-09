/**
 * The secure venue client: the narrow internal interface (handoff §9.12
 * "Expose an internal narrow interface"), its SDK-backed implementation, and
 * the factory that is the ONLY way to obtain one (ADR-010 §3–§4).
 *
 * CONSTRUCTION ORDER, and why it matters. {@link buildSecureVenueClient}:
 *
 * 1. runs the run-mode gate on the caller's context — before it reads the
 *    signer handle, and before any SDK code runs;
 * 2. checks the handle was sealed by this package and has the provenance the
 *    chosen SDK binding accepts (the real SDK refuses the test mock; the test
 *    factory refuses anything but the mock);
 * 3. only then unseals the signer and hands it to the SDK binding.
 *
 * A refusal throws {@link SignerBoundaryRefusal} and nothing after the
 * refusing step runs. SDK failures during construction throw a mapped,
 * redacted {@link SecureVenueError}.
 *
 * AFTER CONSTRUCTION NOTHING THROWS. Every method returns an outcome; every
 * SDK failure is mapped by `error-mapping.ts`. Caller input is read by
 * reflection that is CONTAINED: a getter, a hole, a proxy trap that throws or
 * a revoked proxy makes the input invalid (`NOT_SENT`), and the thrown value
 * is dropped unread. Arrays are copied once, index by index, from own data
 * properties, so what is validated is exactly what is sent. The SDK client (whose
 * `credentials` getter returns the L2 secret) is held in a private field and
 * is never returned, serialised or inspected.
 */

import { inspect } from "node:util";

import { OrderSide, type RateLimitUpdate } from "@polymarket/client";

import { SignerBoundaryRefusal, type SecureOperation, type SecureVenueError } from "./errors.js";
import { invalidRequest, mapVenueError } from "./error-mapping.js";
import {
  cancelOutcomeFromError,
  mapCancelResponse,
  mapOpenOrder,
  mapOrderResponse,
  placementOutcomeFromError,
  type CancelOutcome,
  type PlacementOutcome,
  type QueryOutcome,
  type VenueOrderSnapshot,
} from "./outcomes.js";
import { assertSignerGate } from "./run-mode-gate.js";
import { makeRealSdkClientFactory, type SdkClientFactory, type SdkSecureClientPort } from "./sdk-port.js";
import { SignedOrderEnvelope } from "./signed-order.js";
import { unsealSigner, type SignerHandle, type SignerProvenance } from "./signer.js";

// ---------------------------------------------------------------------------
// The narrow interface.

/** A limit order to sign locally. Price and size are exact decimal strings (ADR-001). */
export interface LimitOrderRequest {
  /**
   * CTF token id or Polymarket V2 position id, as a DECIMAL string (venue
   * report 2026-10-05 F-39: "Keep the selected ID as a decimal string"; U-13
   * resolved). A `0x…` hex id is refused (`NOT_SENT`, plan row C6).
   */
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
  /** Exact decimal string strictly between 0 and 1, e.g. `"0.52"`. Never a `number`. */
  readonly price: string;
  /** Outcome shares, exact decimal string, e.g. `"10"`. */
  readonly size: string;
  /** Post-only (GTC/GTD only; venue report §2.3). */
  readonly postOnly?: boolean;
  /** Unix seconds; makes a GTD order. The venue requires ≥ 3 minutes ahead (§2.3). */
  readonly expirationUnixSeconds?: number;
}

export type SignOutcome =
  | { readonly kind: "SIGNED"; readonly order: SignedOrderEnvelope }
  | { readonly kind: "FAILED"; readonly error: SecureVenueError };

/** Account identity: account-identifying, NOT secret (ADR-010 §3 §16.2). */
export interface VenueAccountIdentity {
  readonly signerAddress: string;
  readonly walletAddress: string;
  readonly signerType: string;
  readonly walletType: number;
}

/** Rate-limit state reported by a response (venue report §8; ADR-007 §9). */
export interface RateLimitObservation {
  readonly bucket: string | null;
  readonly remaining: number | null;
  readonly resetUnixSeconds: number | null;
  readonly tier: string | null;
  readonly warning: boolean;
}

export type CancelMarketFilter = { readonly market: string } | { readonly assetId: string } | { readonly market: string; readonly assetId: string };

/** The venue's batch placement limit: "1 to 15" orders (venue report §W.3). */
export const MAX_ORDERS_PER_BATCH = 15;

/**
 * Batch-cancel limit. Conflict C-11: the guide says 3,000 and the OpenAPI
 * 1,000; the lower is used until resolved (the SDK itself allows 3,000).
 */
export const MAX_CANCEL_IDS_PER_REQUEST = 1_000;

/**
 * The narrow interface `WP-270`, `WP-280` and `WP-300` build against. Every
 * method returns an outcome and never throws.
 *
 * NOT HERE, deliberately: order heartbeats (conflict C-12: the SDK has no
 * heartbeat method; an ADR is owed before `WP-320`), the authenticated user
 * stream (`WP-280`, `src/user-stream/**`), wallet operations (`WP-300`) and
 * geoblock checks (`WP-320`).
 */
export interface SecureVenueClient {
  readonly identity: VenueAccountIdentity;
  /**
   * Create and sign an order LOCALLY. The ORDER is never transmitted here
   * (ADR-007 §2 step 2), but the pinned SDK's `prepareLimitOrder` does make
   * PUBLIC, unauthenticated reads to build it (`actions/orders/cache.ts`:
   * `GET /markets-by-token/{id}`, cached for the SDK client's life, and
   * `GET /clob-markets/{condition}`, cached for 10 minutes, lines 16-17; a
   * price off the cached tick grid forces one fresh read), so a `FAILED`
   * outcome can carry an HTTP-derived kind (a transport failure, a 429).
   * Whatever its kind or effect, a `FAILED` sign outcome means NO ORDER
   * EXISTS: nothing was signed that the caller can hold, so nothing can have
   * been posted.
   *
   * The SDK chooses the signing domain from the id's reserved bits, not from
   * Gamma `version` (venue report 2026-10-05 F-47): ExchangeV3 and domain
   * version `"3"` for a V2-shaped id, the CTF or Neg Risk exchange and `"2"`
   * otherwise.
   *
   * The request's `size` must be on the venue's 0.01 share grid (ADR-034
   * D2.4: the planner quantizes, nothing downstream rounds); an off-grid size
   * is `FAILED` with `INVALID_REQUEST`, before the SDK is called.
   *
   * The SDK's signed order is checked against the request (token, side,
   * post-only, expiration and order type, and amounts EXACTLY equal to the
   * request's shares and shares × price in base units, ADR-034 D2.4) and
   * against the client's account (maker, signer and signature type as the
   * pinned SDK derives them, and zero `builder` and `metadata`) before it is
   * wrapped; a mismatch is `FAILED`.
   */
  createLimitOrder(request: LimitOrderRequest): Promise<SignOutcome>;
  /** Transmit a previously signed order (ADR-007 §2 step 5). */
  postOrder(order: SignedOrderEnvelope): Promise<PlacementOutcome>;
  /**
   * Transmit 1…15 signed orders; one outcome per order, in request order. An
   * invalid batch is refused whole: every outcome is the same `NOT_SENT`, one
   * per request entry, at most {@link MAX_ORDERS_PER_BATCH} + 1 (bounded, so a
   * hostile `length` cannot exhaust memory).
   */
  postOrders(orders: readonly SignedOrderEnvelope[]): Promise<readonly PlacementOutcome[]>;
  cancelOrder(orderId: string): Promise<CancelOutcome>;
  /** 1…1,000 order ids (C-11). */
  cancelOrders(orderIds: readonly string[]): Promise<CancelOutcome>;
  cancelMarketOrders(filter: CancelMarketFilter): Promise<CancelOutcome>;
  cancelAll(): Promise<CancelOutcome>;
  /** Authoritative single-order read (ADR-007 §3). */
  fetchOrder(orderId: string): Promise<QueryOutcome<VenueOrderSnapshot>>;
  /** Close any SDK subscriptions. Never throws. */
  close(): Promise<void>;
}

type PrepareLimitOrderRequest = Parameters<SdkSecureClientPort["createLimitOrder"]>[0];

// ---------------------------------------------------------------------------
// Input validation (this package's own contract; nothing is sent on failure).

const DECIMAL = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,30})?$/u;
/** A price strictly between 0 and 1 (a probability price; venue report §2.3). */
const UNIT_PRICE = /^0\.[0-9]{1,30}$/u;
/**
 * A CTF token id or a Polymarket V2 position id: a canonical DECIMAL string
 * (a uint256 has at most 78 digits). V2-5 (plan row C6) removed the `0x…` hex
 * branch: U-13 is resolved, "a V2 id is a decimal string" (venue report
 * 2026-10-05 F-39, F-44; S-D02 lines 27, 34; S-D11 line 126).
 */
const ASSET_ID = /^[1-9][0-9]{0,77}$/u;
const ORDER_ID = /^[A-Za-z0-9_\-:.]{1,200}$/u;
const CONDITION_ID = /^0x[0-9a-fA-F]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value) && /[1-9]/u.test(value);
}

/**
 * Run a reflection over caller input. Any exception (a throwing getter or
 * proxy trap, a revoked proxy) reads as `undefined`; the thrown value is
 * dropped unread, so nothing it carries can reach an outcome.
 */
function contained<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

type ListReading = { readonly ok: true; readonly items: readonly unknown[] } | { readonly ok: false; readonly length: number };

/**
 * Copy an array of 1…`max` entries from its own DATA properties, once. A
 * non-array, a length outside 1…`max`, a hole, an accessor entry or any
 * reflection failure is a refusal, reported with the best-known entry count
 * (at least 1, at most `max + 1`).
 */
function readList(value: unknown, max: number): ListReading {
  const refused = (length: number): ListReading => ({ ok: false, length: Math.min(Math.max(length, 1), max + 1) });
  const reading = contained((): ListReading => {
    if (!Array.isArray(value)) return refused(1);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return refused(1);
    if (length < 1 || length > max) return refused(length);
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return refused(length);
      items.push(descriptor.value);
    }
    return { ok: true, items: Object.freeze(items) };
  });
  return reading ?? refused(1);
}

/**
 * Copy a batch response's entries from its own DATA properties into a fresh
 * plain array of exactly `expected` slots. A non-array, a length other than
 * `expected`, or any reflection failure leaves EVERY slot `undefined`; a hole
 * or an accessor leaves ITS slot `undefined`. An `undefined` slot maps to an
 * UNKNOWN (`UNRECOGNISED_RESPONSE`) outcome: the order may exist and must be
 * reconciled. No method of the foreign array (`map`, an iterator, a species
 * constructor) runs, and nothing thrown by a trap escapes.
 */
function readResponseEntries(value: unknown, expected: number): readonly unknown[] {
  const entries: unknown[] = new Array<unknown>(expected).fill(undefined);
  const copied = contained((): boolean => {
    if (!Array.isArray(value)) return false;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (length !== expected) return false;
    for (let index = 0; index < expected; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      entries[index] = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    }
    return true;
  });
  return copied === true ? entries : new Array<unknown>(expected).fill(undefined);
}

/** The validated request, kept in this package's own terms for the cross-check. */
interface ValidatedLimitOrder {
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly size: string;
  readonly postOnly: boolean | undefined;
  readonly expiration: number | undefined;
}

function readLimitOrder(request: unknown): ValidatedLimitOrder | undefined {
  return contained(() => readLimitOrderUncontained(request));
}

function readLimitOrderUncontained(request: unknown): ValidatedLimitOrder | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const get = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  };
  const assetId = get("assetId");
  const side = get("side");
  const price = get("price");
  const size = get("size");
  const postOnly = get("postOnly");
  const expiration = get("expirationUnixSeconds");
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) return undefined;
  if (side !== "BUY" && side !== "SELL") return undefined;
  if (!isPositiveDecimal(price) || !UNIT_PRICE.test(price) || !isPositiveDecimal(size)) return undefined;
  // ADR-034 D2.4: a share quantity off the venue's grid is refused, never rounded (the SDK would floor it).
  if (!isOnShareGrid(size)) return undefined;
  if (postOnly !== undefined && typeof postOnly !== "boolean") return undefined;
  if (expiration !== undefined && !(typeof expiration === "number" && Number.isSafeInteger(expiration) && expiration > 0)) {
    return undefined;
  }
  return Object.freeze({ assetId, side, price, size, postOnly, expiration });
}

function toSdkLimitOrder(order: ValidatedLimitOrder): PrepareLimitOrderRequest {
  return {
    assetId: order.assetId,
    side: order.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
    price: order.price,
    size: order.size,
    ...(order.postOnly === undefined ? {} : { postOnly: order.postOnly }),
    ...(order.expiration === undefined ? {} : { expiration: order.expiration }),
  };
}

// ---------------------------------------------------------------------------
// The signed-order cross-check (exact integer arithmetic; never a float).

/** Base units per share and per pUSD/USDC unit: both have 6 decimals ("convert both amounts to six-decimal integers", A F-99). */
const BASE_UNITS = 1_000_000n;
/**
 * "Size decimals" is 2 for every tick size (`docs/venue/verified-2026-10-06.md`
 * F-99; the pinned SDK's `resolveRoundingConfig` has `size: 2` for all six
 * ticks, F-101). A limit order's share quantity must already be on this grid
 * (ADR-034 D2.4): the SDK would floor anything finer, and the order it signed
 * would then differ from the one the OMS records (`CO3-N1`).
 */
const SHARE_SIZE_DECIMALS = 2;

/** True when `size` (a pre-validated positive decimal) has at most {@link SHARE_SIZE_DECIMALS} fractional digits. */
function isOnShareGrid(size: string): boolean {
  const dot = size.indexOf(".");
  return dot === -1 || size.length - dot - 1 <= SHARE_SIZE_DECIMALS;
}

/** An exact decimal string as `numerator / 10^scale`. The input is pre-validated. */
function rational(decimal: string): { readonly numerator: bigint; readonly denominator: bigint } {
  const [whole = "0", fraction = ""] = decimal.split(".");
  return { numerator: BigInt(`${whole}${fraction}`), denominator: 10n ** BigInt(fraction.length) };
}

/** `value × 10^6` as an exact integer, or `undefined` when it is not a whole number of base units. */
function exactBaseUnits(numerator: bigint, denominator: bigint): bigint | undefined {
  const scaled = numerator * BASE_UNITS;
  return scaled % denominator === 0n ? scaled / denominator : undefined;
}

/** `bytes32(0)`: the pinned SDK's `builder` and `metadata` when no builder code is given (this package never gives one). */
const BYTES32_ZERO = `0x${"0".repeat(64)}`;
/** The pinned SDK's `SignatureType.POLY_1271`, used for `WalletType.DEPOSIT_WALLET` (= 3). */
const SIGNATURE_TYPE_POLY_1271 = 3;

/**
 * Is the signed order's maker/signer/signature type the one the pinned SDK
 * derives from the client's account? From `@polymarket/client@0.11.0`
 * (`Tr` / `Ee` in its bundle), unchanged in 0.12.0 (`wallet.ts` is not in
 * the 0.11.0 → 0.12.0 release diff): `signatureType` is the account's `walletType`
 * (EOA 0, POLY_PROXY 1, GNOSIS_SAFE 2, DEPOSIT_WALLET 3 map to signature
 * types 0, 1, 2, 3); `maker` is the account's `wallet`; `signer` is the
 * `wallet` for signature type 3 (POLY_1271) and the account's `signer`
 * otherwise. Addresses compare case-insensitively (an EVM address is a
 * number). Anything else fails closed.
 */
function signedOrderMatchesAccount(identity: SignedOrderEnvelope["identity"], account: VenueAccountIdentity): boolean {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  if (!Number.isInteger(account.walletType) || account.walletType < 0 || account.walletType > 3) return false;
  if (identity.signatureType !== account.walletType) return false;
  if (!same(identity.maker, account.walletAddress)) return false;
  const expectedSigner = identity.signatureType === SIGNATURE_TYPE_POLY_1271 ? account.walletAddress : account.signerAddress;
  return same(identity.signer, expectedSigner);
}

/** `builder` and `metadata` must be `bytes32(0)`: this package never asks for a builder code or metadata. */
function signedOrderHasNoAttribution(envelope: SignedOrderEnvelope): boolean {
  const payload = envelope.revealPayloadForEncryptedPersistence();
  const builder = payload["builder"];
  const metadata = payload["metadata"];
  return (
    typeof builder === "string" &&
    builder.toLowerCase() === BYTES32_ZERO &&
    typeof metadata === "string" &&
    metadata.toLowerCase() === BYTES32_ZERO
  );
}

/**
 * Does the SDK's signed order say EXACTLY what the caller asked for (ADR-034
 * D2.4, `LOW-2`)? The amounts are recomputed from the request, by order kind,
 * in base units:
 *
 * | Order | `makerAmount` | `takerAmount` |
 * | --- | --- | --- |
 * | GTC or GTD BUY | shares × price, exactly | shares, exactly |
 * | GTC or GTD SELL | shares, exactly | shares × price, exactly |
 *
 * "Exactly" holds because on-grid inputs need no rounding: Price decimals + 2
 * equals Amount decimals in every row of the venue's table (A F-102), and the
 * size is on the 0.01 grid ({@link readLimitOrder}). Anything else is `FAILED`,
 * so no order exists (WP-260), and a later change in the SDK's rounding fails
 * closed at signing. FAK and FOK cannot be requested here (the SDK port has
 * only `createLimitOrder`), and a signed order of either type is refused by
 * the order-type check; their rows arrive with ADR-034 round R3.
 */
function signedOrderMatchesRequest(identity: SignedOrderEnvelope["identity"], request: ValidatedLimitOrder): boolean {
  if (identity.tokenId !== request.assetId || identity.side !== request.side) return false;
  if (identity.postOnly !== (request.postOnly === true)) return false;
  if (identity.expiration !== (request.expiration ?? 0)) return false;
  if (identity.orderType !== (request.expiration === undefined ? "GTC" : "GTD")) return false;
  const size = rational(request.size);
  const price = rational(request.price);
  const shares = exactBaseUnits(size.numerator, size.denominator);
  const quote = exactBaseUnits(size.numerator * price.numerator, size.denominator * price.denominator);
  if (shares === undefined || quote === undefined || shares <= 0n) return false;
  const [maker, taker] = request.side === "BUY" ? [quote, shares] : [shares, quote];
  return BigInt(identity.makerAmount) === maker && BigInt(identity.takerAmount) === taker;
}

function isOrderId(value: unknown): value is string {
  return typeof value === "string" && ORDER_ID.test(value);
}

// ---------------------------------------------------------------------------
// Implementation over the SDK port.

const SDK = new WeakMap<SdkBackedSecureVenueClient, SdkSecureClientPort>();

function readIdentity(port: SdkSecureClientPort): VenueAccountIdentity | undefined {
  return contained(() => readIdentityUncontained(port));
}

function readIdentityUncontained(port: SdkSecureClientPort): VenueAccountIdentity | undefined {
  const account: unknown = port.account;
  if (typeof account !== "object" || account === null) return undefined;
  const get = (key: string): unknown => (account as Record<string, unknown>)[key];
  const signerAddress = get("signer");
  const walletAddress = get("wallet");
  const signerType = get("signerType");
  const walletType = get("walletType");
  if (
    typeof signerAddress !== "string" ||
    !ADDRESS.test(signerAddress) ||
    typeof walletAddress !== "string" ||
    !ADDRESS.test(walletAddress) ||
    typeof signerType !== "string" ||
    !/^[A-Z_]{1,32}$/u.test(signerType) ||
    typeof walletType !== "number" ||
    !Number.isInteger(walletType)
  ) {
    return undefined;
  }
  return Object.freeze({ signerAddress, walletAddress, signerType, walletType });
}

class SdkBackedSecureVenueClient implements SecureVenueClient {
  readonly identity: VenueAccountIdentity;

  constructor(port: SdkSecureClientPort, identity: VenueAccountIdentity) {
    this.identity = identity;
    SDK.set(this, port);
    Object.freeze(this);
  }

  private port(): SdkSecureClientPort {
    const port = SDK.get(this);
    if (port === undefined) throw new TypeError("not a secure venue client");
    return port;
  }

  async createLimitOrder(request: LimitOrderRequest): Promise<SignOutcome> {
    const operation: SecureOperation = "CREATE_LIMIT_ORDER";
    const validated = readLimitOrder(request);
    if (validated === undefined) return Object.freeze({ kind: "FAILED", error: invalidRequest(operation) });
    try {
      const signed = await this.port().createLimitOrder(toSdkLimitOrder(validated));
      const envelope = SignedOrderEnvelope.fromSdkSignedOrder(signed);
      // A signed order outside the pinned shape, or one that does not say
      // what was asked, is never handed out (it is not transmitted either).
      return envelope === undefined ||
        !signedOrderMatchesRequest(envelope.identity, validated) ||
        !signedOrderMatchesAccount(envelope.identity, this.identity) ||
        !signedOrderHasNoAttribution(envelope)
        ? Object.freeze({ kind: "FAILED", error: mapVenueError(undefined, operation) })
        : Object.freeze({ kind: "SIGNED", order: envelope });
    } catch (error) {
      return Object.freeze({ kind: "FAILED", error: mapVenueError(error, operation) });
    }
  }

  async postOrder(order: SignedOrderEnvelope): Promise<PlacementOutcome> {
    const operation: SecureOperation = "POST_ORDER";
    if (!SignedOrderEnvelope.isEnvelope(order)) return placementOutcomeFromError(invalidRequest(operation));
    try {
      return mapOrderResponse(await this.port().postOrder(SignedOrderEnvelope.toSdkSignedOrder(order)));
    } catch (error) {
      return placementOutcomeFromError(mapVenueError(error, operation));
    }
  }

  async postOrders(orders: readonly SignedOrderEnvelope[]): Promise<readonly PlacementOutcome[]> {
    const operation: SecureOperation = "POST_ORDERS";
    const list = readList(orders, MAX_ORDERS_PER_BATCH);
    if (!list.ok || !list.items.every((entry) => SignedOrderEnvelope.isEnvelope(entry))) {
      const outcome = placementOutcomeFromError(invalidRequest(operation));
      return Object.freeze(Array.from({ length: list.ok ? list.items.length : list.length }, () => outcome));
    }
    const envelopes = list.items as readonly SignedOrderEnvelope[];
    try {
      const responses: unknown = await this.port().postOrders(envelopes.map((envelope) => SignedOrderEnvelope.toSdkSignedOrder(envelope)));
      // The response array is FOREIGN: none of its methods, iterators or
      // species is ever used. Its entries are copied into a fresh plain array,
      // one per SUBMITTED position, and anything unreadable is UNKNOWN.
      const entries = readResponseEntries(responses, envelopes.length);
      const outcomes: PlacementOutcome[] = [];
      for (let index = 0; index < envelopes.length; index += 1) {
        outcomes.push(mapOrderResponse(entries[index]));
      }
      return Object.freeze(outcomes);
    } catch (error) {
      const outcome = placementOutcomeFromError(mapVenueError(error, operation));
      return Object.freeze(envelopes.map(() => outcome));
    }
  }

  private async cancel(operation: SecureOperation, call: () => Promise<unknown>): Promise<CancelOutcome> {
    try {
      return mapCancelResponse(await call());
    } catch (error) {
      return cancelOutcomeFromError(mapVenueError(error, operation));
    }
  }

  async cancelOrder(orderId: string): Promise<CancelOutcome> {
    if (!isOrderId(orderId)) return cancelOutcomeFromError(invalidRequest("CANCEL_ORDER"));
    return this.cancel("CANCEL_ORDER", () => this.port().cancelOrder({ orderId }));
  }

  async cancelOrders(orderIds: readonly string[]): Promise<CancelOutcome> {
    const list = readList(orderIds, MAX_CANCEL_IDS_PER_REQUEST);
    if (!list.ok || !list.items.every(isOrderId)) {
      return cancelOutcomeFromError(invalidRequest("CANCEL_ORDERS"));
    }
    const ids = [...(list.items as readonly string[])];
    return this.cancel("CANCEL_ORDERS", () => this.port().cancelOrders({ orderIds: ids }));
  }

  async cancelMarketOrders(filter: CancelMarketFilter): Promise<CancelOutcome> {
    const operation: SecureOperation = "CANCEL_MARKET_ORDERS";
    if (typeof filter !== "object" || filter === null) return cancelOutcomeFromError(invalidRequest(operation));
    const read = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(filter, key);
      return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    };
    const fields = contained(() => ({ market: read("market"), assetId: read("assetId") }));
    if (fields === undefined) return cancelOutcomeFromError(invalidRequest(operation));
    const { market, assetId } = fields;
    const marketOk = market === undefined || (typeof market === "string" && CONDITION_ID.test(market));
    const assetOk = assetId === undefined || (typeof assetId === "string" && ASSET_ID.test(assetId));
    // A filter with neither field would cancel nothing selective; refuse it
    // rather than let it be confused with cancel-all.
    if (!marketOk || !assetOk || (market === undefined && assetId === undefined)) {
      return cancelOutcomeFromError(invalidRequest(operation));
    }
    const request = {
      ...(typeof market === "string" ? { market } : {}),
      ...(typeof assetId === "string" ? { assetId } : {}),
    };
    return this.cancel(operation, () => this.port().cancelMarketOrders(request));
  }

  async cancelAll(): Promise<CancelOutcome> {
    return this.cancel("CANCEL_ALL", () => this.port().cancelAll());
  }

  async fetchOrder(orderId: string): Promise<QueryOutcome<VenueOrderSnapshot>> {
    if (!isOrderId(orderId)) return Object.freeze({ kind: "FAILED", error: invalidRequest("FETCH_ORDER") });
    try {
      return mapOpenOrder(await this.port().fetchOrder({ orderId }));
    } catch (error) {
      return Object.freeze({ kind: "FAILED", error: mapVenueError(error, "FETCH_ORDER") });
    }
  }

  async close(): Promise<void> {
    try {
      await this.port().closeSubscriptions();
    } catch {
      // Closing is best effort; a failure here carries nothing actionable
      // and its text is unvetted, so it is dropped.
    }
  }

  toJSON(): { readonly identity: VenueAccountIdentity } {
    return { identity: this.identity };
  }

  [inspect.custom](): string {
    return `SecureVenueClient ${JSON.stringify(this.toJSON())}`;
  }
}

function toRateLimitObservation(update: RateLimitUpdate): RateLimitObservation {
  const number = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
  const token = (value: unknown): string | null =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/u.test(value) ? value : null;
  return Object.freeze({
    bucket: token(update.bucket),
    remaining: number(update.remaining),
    resetUnixSeconds: number(update.reset),
    tier: token(update.tier),
    warning: update.warning === true,
  });
}

// ---------------------------------------------------------------------------
// Factories.

export interface CreateSecureVenueClientOptions {
  /**
   * `{ runMode, maximumRunMode, allowRealOrders }` from the composition
   * root's validated startup configuration. See `run-mode-gate.ts`.
   */
  readonly runModeContext: unknown;
  /** A handle sealed by this package. */
  readonly signer: SignerHandle;
  /** Optional account/funder wallet address (SDK `wallet`). */
  readonly wallet?: string;
  /** Receives sanitised rate-limit observations; its failures are ignored. */
  readonly onRateLimitUpdate?: (observation: RateLimitObservation) => void;
}

/**
 * The shared construction path. PACKAGE-INTERNAL: exported for the test
 * factory in `./testing` and for this package's tests, not from `index.ts`.
 */
export async function buildSecureVenueClient(
  options: CreateSecureVenueClientOptions,
  sdkFactory: SdkClientFactory,
  acceptedProvenance: "REAL" | SignerProvenance,
): Promise<SecureVenueClient> {
  if (typeof options !== "object" || options === null) {
    throw new SignerBoundaryRefusal(["CONTEXT_UNREADABLE"]);
  }
  // Each option is read once. A throwing getter or proxy trap is contained:
  // it refuses as CONTEXT_UNREADABLE and its thrown value is dropped unread.
  const option = (key: keyof CreateSecureVenueClientOptions): unknown => {
    try {
      return (options as unknown as Record<string, unknown>)[key];
    } catch {
      throw new SignerBoundaryRefusal(["CONTEXT_UNREADABLE"]);
    }
  };

  // 1. The run-mode gate, before anything touches the signer or the SDK.
  assertSignerGate(option("runModeContext"));

  // 2. The handle and its provenance.
  const sealed = unsealSigner(option("signer"));
  if (sealed === undefined) throw new SignerBoundaryRefusal(["SIGNER_NOT_SEALED"]);
  if (acceptedProvenance === "REAL" && sealed.provenance === "TEST_MOCK") {
    throw new SignerBoundaryRefusal(["MOCK_SIGNER_REJECTED_BY_REAL_SDK"]);
  }
  if (acceptedProvenance !== "REAL" && sealed.provenance !== acceptedProvenance) {
    throw new SignerBoundaryRefusal(["REAL_SIGNER_REJECTED_BY_TEST_FACTORY"]);
  }

  const wallet = option("wallet");
  if (wallet !== undefined && !(typeof wallet === "string" && ADDRESS.test(wallet))) {
    throw invalidRequest("CREATE_CLIENT");
  }
  const listenerOption = option("onRateLimitUpdate");
  const listener = typeof listenerOption === "function" ? (listenerOption as (observation: RateLimitObservation) => void) : undefined;
  const onRateLimitUpdate =
    listener !== undefined
      ? (update: RateLimitUpdate): void => {
          try {
            listener(toRateLimitObservation(update));
          } catch {
            // A listener failure must not surface SDK internals; ignored, as
            // the SDK itself ignores listener failures.
          }
        }
      : undefined;

  // 3. Only now does the signer reach the SDK binding.
  let port: SdkSecureClientPort;
  try {
    port = await sdkFactory({
      signer: sealed.signer,
      ...(wallet === undefined ? {} : { wallet }),
      ...(onRateLimitUpdate === undefined ? {} : { onRateLimitUpdate }),
    });
  } catch (error) {
    throw mapVenueError(error, "CREATE_CLIENT");
  }
  const identity = readIdentity(port);
  if (identity === undefined) {
    throw mapVenueError(undefined, "CREATE_CLIENT");
  }
  return new SdkBackedSecureVenueClient(port, identity);
}

/**
 * Construct the secure venue client over the REAL pinned SDK.
 *
 * Refuses (throws {@link SignerBoundaryRefusal}) in every BACKTEST, PAPER,
 * SHADOW or unrecognised (e.g. REPLAY) process, whenever the process maximum
 * or `allowRealOrders` does not admit real orders, for any handle this
 * package did not seal, and for the test-only mock signer. Under the
 * repository defaults it therefore always refuses.
 */
export async function createSecureVenueClient(options: CreateSecureVenueClientOptions): Promise<SecureVenueClient> {
  return buildSecureVenueClient(options, makeRealSdkClientFactory(), "REAL");
}
