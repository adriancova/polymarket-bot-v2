/**
 * WP-290 r14: WP-280's REAL user-stream outputs, for the reconciliation suite (WP290-V14-WP280-EVENT-IDS-DISCARDED).
 *
 * The user channel's wire messages (the venue's `event_type: "order"` and `"trade"` messages, field list in
 * `docs/venue/verified-2026-08-24.md` §4 as WP-280 parses them), normalized by WP-280's own normalizer
 * (`normalizeUserChannelMessage`) and projected by its own projection (`projectOrderEventForOms`,
 * `projectTradeEventForOms`), then emitted EXACTLY as WP-280's manager emits them (`manager.ts` `#onFrame`, `#request`,
 * `#makeRequest`, `eventScope`): the ORDER or TRADE output (`kind`, `event`, `oms`, `receipt`), then, when the projection
 * has a shortfall, its `EVENT_NOT_FULLY_APPLICABLE` request (frozen, every field present), as a RECONCILIATION_REQUESTED
 * output; an unrecognized message as its UNRECOGNIZED_MESSAGE output and request. When the listener does not take an
 * activity output (`EVENT_NOT_DELIVERED`), the manager raises that request, naming the event's identifiers, after the
 * others. The real manager is not constructed here: it refuses to start without its transport (PAPER), and this suite
 * needs no socket.
 *
 * PAPER only: pure; no network, key or signer.
 */

import {
  normalizeUserChannelMessage,
  projectOrderEventForOms,
  projectTradeEventForOms,
  type NormalizeOptions,
  type UserStreamReconciliationRequest,
} from "../../../../packages/polymarket-secure/src/user-stream/index.js";

type Row = Record<string, unknown>;

/** A condition id (`market`), in the venue's form (0x + 64 hex). */
export const WP280_MARKET = "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75";
/** The API-key identity the transport authenticates as (a placeholder: no credential), and another account's. */
export const OUR_OWNER = "00000000-0000-0000-0000-0000000000a1";
export const THEIR_OWNER = "00000000-0000-0000-0000-0000000000b2";
/** WP-280's `isAccountOwner`, as the composition binds it: our owner only. */
export const OURS: NormalizeOptions = Object.freeze({ isAccountOwner: (owner: string) => owner === OUR_OWNER });
const MATCH_SECONDS = "1790000000";
const TIMESTAMP_MS = "1790000000000";

/** One maker leg of a wire trade message. */
export interface WireMaker {
  readonly orderId: string;
  readonly owner: string;
  readonly matchedAmount: string;
  readonly price: string;
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
}

/**
 * A wire trade message (`event_type: "trade"`). `status` and `traderSide` are the wire values as sent (any text, or
 * `null` for an absent `trader_side`); `makers` the `maker_orders` entries.
 */
export function wireTrade(t: {
  readonly id: string;
  readonly takerOrderId: string;
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
  readonly size: string;
  readonly price: string;
  readonly status: string;
  readonly traderSide: string | null;
  readonly makers: readonly WireMaker[];
  readonly feeRateBps?: string;
  readonly transactionHash?: string | null;
  readonly matchTime?: string | null;
}): Row {
  const wire: Row = {
    event_type: "trade",
    type: "TRADE",
    id: t.id,
    taker_order_id: t.takerOrderId,
    market: WP280_MARKET,
    asset_id: t.assetId,
    side: t.side,
    size: t.size,
    fee_rate_bps: t.feeRateBps ?? "0",
    price: t.price,
    status: t.status,
    owner: OUR_OWNER,
    trade_owner: OUR_OWNER,
    maker_orders: t.makers.map((maker) => ({ order_id: maker.orderId, owner: maker.owner, matched_amount: maker.matchedAmount, price: maker.price, asset_id: maker.assetId, side: maker.side })),
    timestamp: TIMESTAMP_MS,
  };
  if (t.traderSide !== null) wire["trader_side"] = t.traderSide;
  if (t.matchTime !== null) wire["match_time"] = t.matchTime ?? MATCH_SECONDS;
  if (t.transactionHash !== undefined && t.transactionHash !== null) wire["transaction_hash"] = t.transactionHash;
  return wire;
}

/** A wire order message (`event_type: "order"`); `status` `null` is absent (the SDK types it nullish). */
export function wireOrder(o: {
  readonly id: string;
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
  readonly originalSize: string;
  readonly sizeMatched: string;
  readonly price: string;
  readonly status: string | null;
  readonly type?: string;
}): Row {
  const wire: Row = {
    event_type: "order",
    type: o.type ?? "UPDATE",
    id: o.id,
    owner: OUR_OWNER,
    market: WP280_MARKET,
    asset_id: o.assetId,
    side: o.side,
    original_size: o.originalSize,
    size_matched: o.sizeMatched,
    price: o.price,
    outcome: "Yes",
    timestamp: TIMESTAMP_MS,
  };
  if (o.status !== null) wire["status"] = o.status;
  return wire;
}

/** One emission of WP-280's manager for one wire message: what the listener receives, in order. */
export interface Wp280Emission {
  /** The ORDER, TRADE or UNRECOGNIZED_MESSAGE output (`null` only for a PONG, never here). */
  readonly output: Row;
  /** Its request (EVENT_NOT_FULLY_APPLICABLE or UNRECOGNIZED_MESSAGE), or `null`. */
  readonly request: UserStreamReconciliationRequest | null;
  /** The EVENT_NOT_DELIVERED request the manager raises if the listener does not take `output` (activity outputs only). */
  readonly notDelivered: UserStreamReconciliationRequest | null;
  /** The normalized message kind and the projection's shortfalls (for labels). */
  readonly kind: string;
  readonly shortfalls: readonly string[];
}

let requestCounter = 0;

/** `manager.ts` `#makeRequest`: every field present, frozen, ids de-duplicated. */
function makeRequest(cause: string, detail: { readonly markets: readonly string[]; readonly shortfalls?: readonly string[]; readonly unrecognized?: string; readonly venueOrderIds?: readonly string[]; readonly venueTradeId?: string }): UserStreamReconciliationRequest {
  requestCounter += 1;
  return Object.freeze({
    requestId: `user-stream-reconcile-${String(requestCounter)}`,
    cause,
    afterLoss: null,
    markets: Object.freeze([...detail.markets]),
    subscriptionGeneration: 1,
    shortfalls: Object.freeze([...(detail.shortfalls ?? [])]),
    unrecognized: detail.unrecognized ?? null,
    venueOrderIds: Object.freeze([...new Set(detail.venueOrderIds ?? [])]),
    venueTradeId: detail.venueTradeId ?? null,
    requestedAt: null,
  }) as unknown as UserStreamReconciliationRequest;
}

/** Exactly what WP-280's manager emits for one wire message (`manager.ts` `#onFrame`). */
export function wp280Emit(message: unknown, options: NormalizeOptions = OURS, frameSequence = 1): Wp280Emission {
  const normalized = normalizeUserChannelMessage(message, options);
  const receipt = Object.freeze({ subscriptionGeneration: 1, frameSequence, indexInFrame: 0, receivedAt: null });
  if (normalized.kind === "ORDER") {
    const oms = projectOrderEventForOms(normalized.event);
    const scope = { markets: [normalized.event.market], venueOrderIds: [normalized.event.venueOrderId] };
    return {
      output: Object.freeze({ kind: "ORDER", event: normalized.event, oms, receipt }),
      request: oms.shortfalls.length > 0 ? makeRequest("EVENT_NOT_FULLY_APPLICABLE", { ...scope, shortfalls: oms.shortfalls }) : null,
      notDelivered: makeRequest("EVENT_NOT_DELIVERED", scope),
      kind: "ORDER",
      shortfalls: oms.shortfalls,
    };
  }
  if (normalized.kind === "TRADE") {
    const event = normalized.event;
    const oms = projectTradeEventForOms(event);
    const scope = { markets: [event.market], venueOrderIds: [event.takerOrderId, ...(event.makerOrders ?? []).map((maker) => maker.venueOrderId)], venueTradeId: event.venueTradeId };
    return {
      output: Object.freeze({ kind: "TRADE", event, oms, receipt }),
      request: oms.shortfalls.length > 0 ? makeRequest("EVENT_NOT_FULLY_APPLICABLE", { ...scope, shortfalls: oms.shortfalls }) : null,
      notDelivered: makeRequest("EVENT_NOT_DELIVERED", scope),
      kind: "TRADE",
      shortfalls: oms.shortfalls,
    };
  }
  if (normalized.kind === "UNRECOGNIZED") {
    return {
      output: Object.freeze({ kind: "UNRECOGNIZED_MESSAGE", reason: normalized.reason, field: normalized.field, receipt }),
      request: makeRequest("UNRECOGNIZED_MESSAGE", { markets: [WP280_MARKET], unrecognized: normalized.reason }),
      notDelivered: null,
      kind: "UNRECOGNIZED",
      shortfalls: [],
    };
  }
  throw new Error("a PONG is not an emission");
}

/** WP-280's request backlog, as the coordinator reads it (`UserStreamManager`'s two methods). */
export class Wp280Backlog {
  readonly pending: UserStreamReconciliationRequest[] = [];
  readonly acknowledged: string[] = [];
  pendingReconciliationRequests(): readonly UserStreamReconciliationRequest[] {
    return [...this.pending];
  }
  acknowledgeReconciliationRequest(requestId: string): boolean {
    const index = this.pending.findIndex((request) => request.requestId === requestId);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.acknowledged.push(requestId);
    return true;
  }
}

/** The listener's side of one emission: what the coordinator receives, in WP-280's order. */
export function deliver(
  coordinator: { onUserStreamOutput(output: unknown): void },
  backlog: Wp280Backlog,
  emission: Wp280Emission,
  options: { readonly outputTaken?: boolean; readonly output?: unknown; readonly requestsReceived?: boolean } = {},
): void {
  const taken = options.outputTaken ?? true;
  if (taken) coordinator.onUserStreamOutput(options.output ?? emission.output);
  // `requestsReceived: false`: the coordinator never receives the requests (a stand-in for a request that never
  // reaches it: the output is then its only word of the event).
  if (options.requestsReceived === false) return;
  for (const request of [emission.request, taken ? null : emission.notDelivered]) {
    if (request === null) continue;
    backlog.pending.push(request);
    coordinator.onUserStreamOutput(Object.freeze({ kind: "RECONCILIATION_REQUESTED", request }));
  }
}
