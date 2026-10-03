/**
 * The OMS's ports. `packages/oms` is layer 1 (`docs/contracts/dependency-
 * direction.md` §2): it performs no I/O, reads no clock, draws no randomness,
 * holds no key and imports no adapter. Everything outside it is reached
 * through these structural interfaces, which a composition root binds:
 *
 * | Port | Bound to (by the composition root) | Mirrors |
 * | --- | --- | --- |
 * | {@link OmsVenuePort} | `createSecureVenueClient(...)` (layer 2, WP-260) | `SecureVenueClient`'s `createLimitOrder`, `postOrder`, `postOrders`, `cancelOrder` |
 * | {@link RestoreSignedOrder} | `SignedOrderEnvelope.fromPersistedPayload` | the same package |
 * | {@link OmsStore} | a PostgreSQL repository over `execution.*` (migration 0005) | the schema's columns |
 * | {@link PayloadCipher} | an encryption service holding the key (§15) | — |
 * | {@link OmsReservationPort} | `ReservationService` (WP-300, `packages/inventory`) | `reserve`, `consume`, `release` |
 * | {@link ReconciliationRequester} | the reconciliation coordinator (WP-290) | ADR-007 §3, ADR-032 |
 *
 * `packages/oms` may not import `packages/polymarket-secure` (layer 2, F12) nor
 * `packages/inventory` (same layer, no §2.1 row, F13), so both are mirrored
 * structurally. `test/unit/oms/port-conformance.test.ts` proves at compile
 * time that the real `SecureVenueClient`, `SignedOrderEnvelope` and
 * `ReservationService` satisfy these ports.
 */

import type { DecimalString } from "@polymarket-bot/decimal";

import type { AttemptState, OrderState, SettlementState } from "./states.js";

// ---------------------------------------------------------------------------
// The venue (WP-260's narrow interface).

/** A limit order to sign locally. Price and size are exact decimal strings (ADR-001). */
export interface LimitOrderRequest {
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly size: string;
  readonly postOnly?: boolean;
  readonly expirationUnixSeconds?: number;
}

/** The non-secret identity of a signed order (`SignedOrderIdentity`, WP-260). */
export interface SignedOrderIdentity {
  readonly salt: string;
  readonly maker: string;
  readonly signer: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly makerAmount: string;
  readonly takerAmount: string;
  readonly orderType: "GTC" | "GTD" | "FOK" | "FAK";
  readonly expiration: number;
  readonly timestamp: string;
  readonly signatureType: number;
  readonly postOnly: boolean;
}

/**
 * An opaque signed order (`SignedOrderEnvelope`, WP-260). The full payload,
 * signature included, is reachable only through
 * {@link SignedOrderHandle.revealPayloadForEncryptedPersistence}, whose one
 * permitted use is encrypted persistence (§15; ADR-007 §11). The OMS hands it
 * to the {@link PayloadCipher} and to nothing else.
 */
export interface SignedOrderHandle {
  readonly identity: SignedOrderIdentity;
  revealPayloadForEncryptedPersistence(): Readonly<Record<string, string | number | boolean>>;
}

/** The fields of WP-260's `SecureVenueError` the OMS reads. Never venue text. */
export interface VenueErrorView {
  readonly kind: string;
  readonly effect: string;
  readonly retryAfterSeconds: number | null;
}

export type SignOutcome =
  | { readonly kind: "SIGNED"; readonly order: SignedOrderHandle }
  /** WP-260: a FAILED sign outcome means NO ORDER EXISTS. */
  | { readonly kind: "FAILED"; readonly error: VenueErrorView };

export type PlacementOutcome =
  | {
      readonly kind: "ACCEPTED";
      readonly orderId: string;
      readonly status: string;
      readonly makingAmount: string;
      readonly takingAmount: string;
      readonly tradeIds: readonly string[];
      readonly transactionHashes: readonly string[];
    }
  | { readonly kind: "REJECTED"; readonly reason: string }
  | { readonly kind: "NOT_SENT"; readonly error: VenueErrorView }
  | { readonly kind: "REFUSED"; readonly error: VenueErrorView }
  | { readonly kind: "UNKNOWN"; readonly reason: string; readonly error: VenueErrorView | null };

export interface NotCanceledView {
  readonly orderId: string;
  readonly reason: string;
}

export type CancelOutcome =
  | { readonly kind: "COMPLETED"; readonly canceled: readonly string[]; readonly notCanceled: readonly NotCanceledView[] }
  | { readonly kind: "NOT_SENT"; readonly error: VenueErrorView }
  | { readonly kind: "REFUSED"; readonly error: VenueErrorView }
  | { readonly kind: "UNKNOWN"; readonly error: VenueErrorView | null };

/**
 * The venue, through WP-260's narrow interface. Methods are expected never to
 * throw; if one throws or answers outside these shapes, the OMS reads the
 * answer as UNKNOWN (a placement: SUBMISSION_UNKNOWN), never as a rejection.
 */
export interface OmsVenuePort {
  createLimitOrder(request: LimitOrderRequest): Promise<SignOutcome>;
  postOrder(order: SignedOrderHandle): Promise<PlacementOutcome>;
  postOrders(orders: readonly SignedOrderHandle[]): Promise<readonly PlacementOutcome[]>;
  cancelOrder(orderId: string): Promise<CancelOutcome>;
}

/** Re-create a signed order from its decrypted persisted payload (`SignedOrderEnvelope.fromPersistedPayload`). */
export type RestoreSignedOrder = (payload: unknown) => SignedOrderHandle | undefined;

// ---------------------------------------------------------------------------
// Encryption at rest (§15; ADR-007 §11; WP-260 follow_up "persist
// revealPayloadForEncryptedPersistence() encrypted at rest").

/** An opaque ciphertext. `keyId` names the key version; neither field is secret. */
export interface EncryptedPayload {
  readonly keyId: string;
  readonly ciphertext: string;
}

/** Holds the key. `packages/oms` never sees it. */
export interface PayloadCipher {
  encrypt(plaintext: string): Promise<EncryptedPayload>;
  decrypt(payload: EncryptedPayload): Promise<string>;
}

// ---------------------------------------------------------------------------
// Persistence (migration 0005, `execution.*`). Records carry the columns the
// OMS decides; database defaults (timestamps, generated keys) are the
// adapter's. Every write list passed to `apply` is ONE transaction.

/** A JSON value for `order_events.payload` (jsonb). Exact decimals stay strings. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The OMS's view of an execution group (`execution.groups`, with the plan's post-only preference). */
export interface GroupRecord {
  readonly executionGroupId: string;
  readonly planId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly accountRef: string;
  readonly side: "BUY" | "SELL";
  readonly plannedShares: DecimalString;
  readonly postOnly: boolean;
}

/** `execution.orders` (the current projection). */
export interface OrderRecord {
  readonly orderId: string;
  readonly submissionAttemptId: string | null;
  readonly planId: string;
  readonly executionGroupId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly accountRef: string;
  readonly side: "BUY" | "SELL";
  readonly limitPrice: DecimalString;
  readonly originalShares: DecimalString;
  readonly filledShares: DecimalString;
  readonly state: OrderState;
  readonly venueOrderId: string | null;
  /** Always `null` today: the expected order hash is not computable (see the WP-270 handoff, the STOP item). */
  readonly venueOrderHash: string | null;
}

/** `execution.submission_attempts`. `signedPayload` is ciphertext only. */
export interface AttemptRecord {
  readonly submissionAttemptId: string;
  readonly executionGroupId: string;
  readonly planId: string;
  readonly accountRef: string;
  readonly attemptOrdinal: number;
  readonly signedPayload: EncryptedPayload;
  readonly salt: string;
  /** §10.7: unique where known. Always `null` today (the STOP item); never computed by the OMS. */
  readonly expectedOrderHash: string | null;
  readonly state: AttemptState;
  readonly responseStatus: string | null;
  readonly venueOrderId: string | null;
  readonly errorCode: string | null;
}

/** `execution.order_events` (append-only). */
export interface OrderEventRecord {
  readonly orderId: string;
  readonly eventOrdinal: number;
  readonly eventType: string;
  readonly previousState: OrderState | null;
  readonly newState: OrderState;
  readonly venueOrderId: string | null;
  readonly sharesDelta: DecimalString | null;
  readonly filledShares: DecimalString;
  readonly remainingShares: DecimalString;
  readonly reasonCode: string | null;
  readonly payload: { readonly [key: string]: JsonValue } | null;
  readonly source: "internal" | "polymarket";
}

/** `execution.intent_order_links` (many-to-many attribution). */
export interface IntentOrderLinkRecord {
  readonly intentId: string;
  readonly approvedIntentId: string | null;
  readonly orderId: string;
  readonly attributedShares: DecimalString;
}

/** `execution.fills`. */
export interface FillRecord {
  readonly fillId: string;
  readonly orderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly accountRef: string;
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly allocationDiscriminator: string;
  readonly side: "BUY" | "SELL";
  readonly shares: DecimalString;
  readonly price: DecimalString;
  readonly notional: DecimalString;
  readonly feeAmount: DecimalString;
  readonly feeAssetId: string | null;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly matchedAt: string;
}

/** `execution.fill_allocations`. Their sum is the fill's shares (§10.7). */
export interface FillAllocationRecord {
  readonly fillId: string;
  readonly scope: "VIRTUAL_STRATEGY";
  readonly instanceId: string;
  readonly allocatedShares: DecimalString;
}

/** `execution.trade_settlements` (append-only). */
export interface TradeSettlementRecord {
  readonly fillId: string;
  readonly stateOrdinal: number;
  readonly previousState: SettlementState | null;
  readonly state: SettlementState;
  readonly venueTradeId: string;
  readonly transactionHash: string | null;
  readonly observedAt: string;
}

export type StoreWrite =
  | { readonly kind: "INSERT_GROUP"; readonly group: GroupRecord }
  | { readonly kind: "INSERT_ORDER"; readonly order: OrderRecord }
  | { readonly kind: "UPDATE_ORDER"; readonly order: OrderRecord }
  | { readonly kind: "INSERT_ATTEMPT"; readonly attempt: AttemptRecord }
  | { readonly kind: "UPDATE_ATTEMPT"; readonly attempt: AttemptRecord }
  | { readonly kind: "APPEND_ORDER_EVENT"; readonly event: OrderEventRecord }
  | { readonly kind: "INSERT_INTENT_LINK"; readonly link: IntentOrderLinkRecord }
  | { readonly kind: "INSERT_FILL"; readonly fill: FillRecord; readonly allocations: readonly FillAllocationRecord[] }
  | { readonly kind: "APPEND_SETTLEMENT"; readonly settlement: TradeSettlementRecord };

export interface StoreSnapshot {
  readonly groups: readonly GroupRecord[];
  readonly orders: readonly OrderRecord[];
  readonly attempts: readonly AttemptRecord[];
  readonly events: readonly OrderEventRecord[];
  readonly links: readonly IntentOrderLinkRecord[];
  readonly fills: readonly FillRecord[];
  readonly allocations: readonly FillAllocationRecord[];
  readonly settlements: readonly TradeSettlementRecord[];
}

/**
 * The store. `apply` commits its writes as ONE transaction, in order, or
 * rejects. A rejection may still have committed (an ambiguous commit); the
 * OMS therefore FAULTS on any rejection and refuses everything until it is
 * reopened from `load()`.
 */
export interface OmsStore {
  apply(writes: readonly StoreWrite[]): Promise<void>;
  load(): Promise<StoreSnapshot>;
}

// ---------------------------------------------------------------------------
// Reservations (WP-300's `ReservationService`, structurally).

export type PortResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly refusal: { readonly code: string; readonly message: string } };

export interface OmsReservationPort {
  reserve(request: {
    readonly reservationId: string;
    readonly holderRef: string;
    readonly accountRef: string;
    readonly assetId: string;
    readonly amount: DecimalString;
  }): Promise<PortResult>;
  consume(input: { readonly reservationId: string; readonly amount: DecimalString; readonly pendingId: string }): Promise<PortResult>;
  release(input: { readonly reservationId: string }): Promise<PortResult>;
}

// ---------------------------------------------------------------------------
// Reconciliation (ADR-007 §3; handoff §9.17; WP-290 answers).

export type ReconciliationPurpose = "SUBMISSION_UNKNOWN" | "ORDER_STATE" | "FINAL_SIZE";

/**
 * A request for an authoritative venue read about one submission attempt.
 * `requestId` carries an unguessable token (ADR-032 applied to orders): an
 * answer binds only to the attempt's CURRENT request, by exact id.
 * `signedIdentity` is the non-secret identity of the signed order (§9.11 step
 * 8, "using the known signed-order identity"); `expectedOrderHash` is `null`
 * until a venue-documented or SDK-supported hash exists.
 */
export interface ReconciliationRequest {
  readonly requestId: string;
  readonly purpose: ReconciliationPurpose;
  readonly submissionAttemptId: string;
  readonly orderId: string;
  readonly executionGroupId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly limitPrice: DecimalString;
  readonly originalShares: DecimalString;
  readonly venueOrderId: string | null;
  readonly salt: string;
  readonly expectedOrderHash: string | null;
  readonly signedIdentity: SignedOrderIdentity | null;
}

/** The coordinator. It must never answer with a read made before it received the request (ADR-032 D4). */
export interface ReconciliationRequester {
  request(request: ReconciliationRequest): void;
}

/** The venue mode, as WP-310's detector reports it. Anything else reads as `TRADING_UNAVAILABLE`. */
export type VenueMode = "NORMAL" | "POST_ONLY" | "TRADING_UNAVAILABLE";
