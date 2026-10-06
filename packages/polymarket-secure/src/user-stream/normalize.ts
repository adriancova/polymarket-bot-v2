/**
 * Normalization of the authenticated user channel's raw messages (WP-280
 * deliverable 2; handoff §9.12 "Subscribe to the authenticated user channel",
 * "Track asynchronous trade settlement"; §9.11 trade settlement states).
 *
 * INPUT is the raw wire form the official SDK's bindings parse
 * (`UserOrderEventSchema` / `UserTradeEventSchema`, `subscriptions/clob.ts`;
 * field list in `verified-2026-08-24.md` §4). The pinned SDK's own user
 * socket manager is NOT used for this, on purpose: it silently skips any
 * message its schema rejects (`if (!parsed.success) continue;`) and
 * reconnects without telling its subscriber (`websockets/clob/user.ts`,
 * `@polymarket/client` 0.11.0, unchanged in the pinned 0.12.0), and this
 * adapter must surface both.
 *
 * WHAT THE OUTPUT GUARANTEES
 *
 * - Source identifiers are carried EXACTLY as received: the order id, trade
 *   id, taker order id, maker order ids, condition id (`market`), asset id,
 *   associated trade ids and transaction hash. An identifier that is not a
 *   safe token is refused, never altered.
 * - Economic values are exact decimal strings, canonicalised (`wire.ts`).
 * - An enumerated value outside the verified vocabulary is surfaced as
 *   `UNRECOGNIZED`, never coerced to a nearby value. This includes C-3's
 *   `MATCHED_NOT_BROADCASTED` (see `venue-facts.ts`).
 * - A message whose structure is not the documented one is surfaced as an
 *   `UNRECOGNIZED` message with a fixed reason code and, where it applies, the
 *   name of the first field that failed (a name from this file, never venue
 *   text).
 * - NO OWNER IS CARRIED. `owner`, `trade_owner` and `order_owner` hold CLOB
 *   API keys (the order request's `owner` is "CLOB API key",
 *   `verified-2026-08-24.md` §2.1; the fixtures sanitise every owner as an
 *   API-key placeholder), and handoff §15 requires API keys to be redacted.
 *   A maker leg's owner is shown only to the transport's own
 *   `isAccountOwner` predicate, and only the verdict (`OWN` / `OTHER` /
 *   `UNDETERMINED`) is kept. `maker_address`, `outcome`, `outcome_index` and
 *   `bucket_index` are not carried either (nothing downstream needs them);
 *   fields that are not carried are not validated.
 * - No raw payload text, and no unrecognized value other than an upper-case
 *   token lexeme, is ever carried.
 *
 * Everything here is pure and total: no clock, no I/O, never throws.
 */

import type { DecimalString } from "@polymarket-bot/domain";

import {
  C3_MATCHED_NOT_BROADCASTED,
  ORDER_LIFECYCLE_TYPES,
  ORDER_TYPES,
  PONG_FRAME,
  TRADE_STATUS_PREFIX,
  TRADER_SIDES,
  USER_ORDER_STATUSES,
  USER_TRADE_STATUSES,
  type OrderLifecycleType,
  type OrderType,
  type TraderSide,
  type UserOrderStatus,
  type UserTradeStatus,
} from "./venue-facts.js";
import {
  readAssetId,
  readConditionId,
  readEpochMillis,
  readEpochSeconds,
  readOptionalVenueDecimal,
  readSafeId,
  readSide,
  readVenueDecimal,
  tokenLexeme,
  type VenueInstant,
} from "./wire.js";

export type { VenueInstant } from "./wire.js";

/** Bounds on hostile input (client guards; the venue documents no frame or batch size). */
export const MAX_FRAME_CHARACTERS = 1_048_576;
export const MAX_MESSAGES_PER_FRAME = 1_000;
export const MAX_LIST_ENTRIES = 1_000;

export type UnrecognizedValueReason =
  /** A string outside the verified vocabulary for this field. */
  | "NOT_IN_VERIFIED_VOCABULARY"
  /** C-3: `MATCHED_NOT_BROADCASTED` (either spelling) on the user stream; see `venue-facts.ts`. */
  | "C3_REST_ONLY_STATUS_ON_STREAM";

/** An enumerated wire value: recognised, absent (where the SDK allows it), or unrecognised. */
export type WireEnum<T extends string> =
  | { readonly kind: "KNOWN"; readonly value: T }
  | { readonly kind: "ABSENT" }
  | { readonly kind: "UNRECOGNIZED"; readonly lexeme: string | null; readonly reason: UnrecognizedValueReason };

/** Whether a maker leg belongs to the account the transport authenticates as. */
export type MakerLegAccount = "OWN" | "OTHER" | "UNDETERMINED";

/** An order lifecycle event (`event_type: "order"`). */
export interface NormalizedOrderEvent {
  readonly venueOrderId: string;
  /** The condition id, exactly as received. */
  readonly market: string;
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
  /** `type`: PLACEMENT, UPDATE or CANCELLATION. Never ABSENT (the SDK requires it). */
  readonly lifecycle: WireEnum<OrderLifecycleType>;
  /** May be ABSENT: the SDK types it `.nullish()`. */
  readonly status: WireEnum<UserOrderStatus>;
  readonly originalSize: DecimalString;
  readonly sizeMatched: DecimalString;
  readonly price: DecimalString;
  readonly orderType: WireEnum<OrderType>;
  /** Trade ids, exactly as received, or `null` when absent. */
  readonly associateTrades: readonly string[] | null;
  readonly createdAt: VenueInstant | null;
  /** `null` when absent or the wire `"0"` (the SDK reads `"0"` as no expiration). */
  readonly expiresAt: VenueInstant | null;
  /** The event's `timestamp` (epoch milliseconds). */
  readonly venueTimestamp: VenueInstant;
}

/** One maker order matched in a trade (`maker_orders[]`). */
export interface NormalizedMakerOrder {
  readonly venueOrderId: string;
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
  readonly matchedAmount: DecimalString;
  readonly price: DecimalString;
  readonly feeRateBps: DecimalString | null;
  readonly account: MakerLegAccount;
}

/** A trade lifecycle event (`event_type: "trade"`): MATCHED, MINED, CONFIRMED, RETRYING, FAILED. */
export interface NormalizedTradeEvent {
  readonly venueTradeId: string;
  readonly takerOrderId: string;
  readonly market: string;
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
  readonly size: DecimalString;
  readonly price: DecimalString;
  /** `fee_rate_bps`: a RATE, not an amount. `null` when absent or the wire empty string. */
  readonly feeRateBps: DecimalString | null;
  /** Never ABSENT (the SDK requires it). */
  readonly status: WireEnum<UserTradeStatus>;
  /** `match_time`, or its SDK-accepted alias `matchtime`; `null` when neither is present. */
  readonly matchedAt: VenueInstant | null;
  readonly lastUpdate: VenueInstant | null;
  readonly transactionHash: string | null;
  readonly traderSide: WireEnum<TraderSide>;
  readonly makerOrders: readonly NormalizedMakerOrder[] | null;
  readonly venueTimestamp: VenueInstant;
}

export type UnrecognizedMessageReason =
  | "NOT_TEXT"
  | "TOO_LARGE"
  | "NOT_JSON"
  | "NOT_AN_OBJECT"
  | "EMPTY_BATCH"
  | "BATCH_TOO_LARGE"
  | "UNKNOWN_EVENT_TYPE"
  | "MALFORMED_ORDER_EVENT"
  | "MALFORMED_TRADE_EVENT"
  | "UNREADABLE";

export type UserChannelMessage =
  | { readonly kind: "PONG" }
  | { readonly kind: "ORDER"; readonly event: NormalizedOrderEvent }
  | { readonly kind: "TRADE"; readonly event: NormalizedTradeEvent }
  | {
      readonly kind: "UNRECOGNIZED";
      readonly reason: UnrecognizedMessageReason;
      /** The first field that failed, as named in this file; `null` when no single field applies. */
      readonly field: string | null;
    };

export interface NormalizeOptions {
  /**
   * The transport's verdict on a maker leg's `owner`: `true` only when it is
   * the API-key identity the transport authenticates as. Without it every
   * maker leg is `UNDETERMINED`. A throw, or a non-boolean answer, is
   * `UNDETERMINED` too.
   */
  readonly isAccountOwner?: ((owner: string) => boolean) | undefined;
}

// ---------------------------------------------------------------------------
// Contained reflection over a foreign value.

class Malformed {
  constructor(readonly field: string) {}
}

type Record_ = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is Record_ {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An own DATA property's value; `undefined` when absent; an accessor is malformed. */
function own(record: Record_, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Malformed(key);
  return descriptor.value as unknown;
}

function required<T>(record: Record_, key: string, read: (value: unknown) => T | undefined): T {
  const value = read(own(record, key));
  if (value === undefined) throw new Malformed(key);
  return value;
}

function nullable<T>(record: Record_, key: string, read: (value: unknown) => T | undefined): T | null {
  const raw = own(record, key);
  if (raw === undefined || raw === null) return null;
  const value = read(raw);
  if (value === undefined) throw new Malformed(key);
  return value;
}

function readList(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Malformed(field);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_LIST_ENTRIES) throw new Malformed(field);
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) throw new Malformed(field);
    out.push(descriptor.value);
  }
  return out;
}

function enumOf<T extends string>(
  vocabulary: readonly T[],
  record: Record_,
  key: string,
  presence: "REQUIRED" | "NULLISH",
): WireEnum<T> {
  const raw = own(record, key);
  if (raw === undefined || raw === null) {
    if (presence === "REQUIRED") throw new Malformed(key);
    return Object.freeze({ kind: "ABSENT" });
  }
  if (typeof raw !== "string") throw new Malformed(key);
  if ((vocabulary as readonly string[]).includes(raw)) return Object.freeze({ kind: "KNOWN", value: raw as T });
  return Object.freeze({ kind: "UNRECOGNIZED", lexeme: tokenLexeme(raw), reason: "NOT_IN_VERIFIED_VOCABULARY" });
}

/**
 * The trade status: the five verified values in either spelling (plain, or
 * `TRADE_STATUS_`-prefixed; ADR-002), C-3's lexeme as UNRECOGNIZED with its
 * own reason, anything else UNRECOGNIZED.
 */
function tradeStatus(record: Record_): WireEnum<UserTradeStatus> {
  const raw = own(record, "status");
  if (typeof raw !== "string") throw new Malformed("status");
  const plain = raw.startsWith(TRADE_STATUS_PREFIX) ? raw.slice(TRADE_STATUS_PREFIX.length) : raw;
  if (plain === C3_MATCHED_NOT_BROADCASTED) {
    return Object.freeze({ kind: "UNRECOGNIZED", lexeme: tokenLexeme(raw), reason: "C3_REST_ONLY_STATUS_ON_STREAM" });
  }
  if ((USER_TRADE_STATUSES as readonly string[]).includes(plain)) return Object.freeze({ kind: "KNOWN", value: plain as UserTradeStatus });
  return Object.freeze({ kind: "UNRECOGNIZED", lexeme: tokenLexeme(raw), reason: "NOT_IN_VERIFIED_VOCABULARY" });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function accountOf(owner: string, options: NormalizeOptions): MakerLegAccount {
  const predicate = options.isAccountOwner;
  if (typeof predicate !== "function") return "UNDETERMINED";
  try {
    const verdict: unknown = predicate(owner);
    return verdict === true ? "OWN" : verdict === false ? "OTHER" : "UNDETERMINED";
  } catch {
    // The predicate's failure is dropped unread; ownership stays undetermined.
    return "UNDETERMINED";
  }
}

// ---------------------------------------------------------------------------
// The two event shapes.

function orderEvent(record: Record_): NormalizedOrderEvent {
  // `owner` is required by the SDK schema (`owner: z.string()`); it is checked, never carried.
  required(record, "owner", readString);
  const associate = nullable(record, "associate_trades", (value) => readList(value, "associate_trades"));
  const associateTrades =
    associate === null
      ? null
      : Object.freeze(
          associate.map((entry) => {
            const id = readSafeId(entry);
            if (id === undefined) throw new Malformed("associate_trades");
            return id;
          }),
        );
  const expirationRaw = own(record, "expiration");
  const expiresAt = expirationRaw === "0" ? null : nullable(record, "expiration", readEpochSeconds);
  return Object.freeze({
    venueOrderId: required(record, "id", readSafeId),
    market: required(record, "market", readConditionId),
    assetId: required(record, "asset_id", readAssetId),
    side: required(record, "side", readSide),
    lifecycle: enumOf(ORDER_LIFECYCLE_TYPES, record, "type", "REQUIRED"),
    status: enumOf(USER_ORDER_STATUSES, record, "status", "NULLISH"),
    originalSize: required(record, "original_size", (value) => readVenueDecimal(value, "NON_NEGATIVE")),
    sizeMatched: required(record, "size_matched", (value) => readVenueDecimal(value, "NON_NEGATIVE")),
    price: required(record, "price", (value) => readVenueDecimal(value, "UNIT_INTERVAL")),
    orderType: enumOf(ORDER_TYPES, record, "order_type", "NULLISH"),
    associateTrades,
    createdAt: nullable(record, "created_at", readEpochSeconds),
    expiresAt,
    venueTimestamp: required(record, "timestamp", readEpochMillis),
  });
}

function makerOrder(value: unknown, options: NormalizeOptions): NormalizedMakerOrder {
  if (!isPlainObject(value)) throw new Malformed("maker_orders");
  const owner = required(value, "owner", readString);
  return Object.freeze({
    venueOrderId: required(value, "order_id", readSafeId),
    assetId: required(value, "asset_id", readAssetId),
    side: required(value, "side", readSide),
    matchedAmount: required(value, "matched_amount", (raw) => readVenueDecimal(raw, "NON_NEGATIVE")),
    price: required(value, "price", (raw) => readVenueDecimal(raw, "UNIT_INTERVAL")),
    feeRateBps: optionalDecimal(value, "fee_rate_bps"),
    account: accountOf(owner, options),
  });
}

function optionalDecimal(record: Record_, key: string): DecimalString | null {
  const value = readOptionalVenueDecimal(own(record, key), "NON_NEGATIVE");
  if (value === undefined) throw new Malformed(key);
  return value;
}

function tradeEvent(record: Record_, options: NormalizeOptions): NormalizedTradeEvent {
  if (own(record, "type") !== "TRADE") throw new Malformed("type");
  required(record, "owner", readString);
  const matchTime = nullable(record, "match_time", readEpochSeconds);
  const matchtime = nullable(record, "matchtime", readEpochSeconds);
  // The SDK reads `match_time ?? matchtime`. Two DIFFERENT values are a contradiction, not a choice.
  if (matchTime !== null && matchtime !== null && matchTime.wire !== matchtime.wire) throw new Malformed("matchtime");
  const makers = nullable(record, "maker_orders", (value) => readList(value, "maker_orders"));
  return Object.freeze({
    venueTradeId: required(record, "id", readSafeId),
    takerOrderId: required(record, "taker_order_id", readSafeId),
    market: required(record, "market", readConditionId),
    assetId: required(record, "asset_id", readAssetId),
    side: required(record, "side", readSide),
    size: required(record, "size", (value) => readVenueDecimal(value, "NON_NEGATIVE")),
    price: required(record, "price", (value) => readVenueDecimal(value, "UNIT_INTERVAL")),
    feeRateBps: optionalDecimal(record, "fee_rate_bps"),
    status: tradeStatus(record),
    matchedAt: matchTime ?? matchtime,
    lastUpdate: nullable(record, "last_update", readEpochSeconds),
    transactionHash: nullable(record, "transaction_hash", readSafeId),
    traderSide: enumOf(TRADER_SIDES, record, "trader_side", "NULLISH"),
    makerOrders: makers === null ? null : Object.freeze(makers.map((entry) => makerOrder(entry, options))),
    venueTimestamp: required(record, "timestamp", readEpochMillis),
  });
}

// ---------------------------------------------------------------------------
// Entry points.

function unrecognized(reason: UnrecognizedMessageReason, field: string | null = null): UserChannelMessage {
  return Object.freeze({ kind: "UNRECOGNIZED", reason, field });
}

/** Normalize ONE parsed user-channel message (a JSON value). Never throws. */
export function normalizeUserChannelMessage(message: unknown, options: NormalizeOptions = {}): UserChannelMessage {
  try {
    if (!isPlainObject(message)) return unrecognized("NOT_AN_OBJECT");
    const eventType = own(message, "event_type");
    if (eventType === "order") {
      try {
        return Object.freeze({ kind: "ORDER", event: orderEvent(message) });
      } catch (error) {
        if (error instanceof Malformed) return unrecognized("MALFORMED_ORDER_EVENT", error.field);
        throw error;
      }
    }
    if (eventType === "trade") {
      try {
        return Object.freeze({ kind: "TRADE", event: tradeEvent(message, options) });
      } catch (error) {
        if (error instanceof Malformed) return unrecognized("MALFORMED_TRADE_EVENT", error.field);
        throw error;
      }
    }
    return unrecognized("UNKNOWN_EVENT_TYPE");
  } catch {
    // A revoked proxy, a throwing trap, an accessor on `event_type`: nothing thrown is carried.
    return unrecognized("UNREADABLE");
  }
}

/**
 * Normalize ONE raw text frame. The frame `PONG` is the heartbeat reply
 * (`venue-facts.ts`). Any other frame is JSON: one message, or an array of
 * messages (the pinned SDK accepts both forms, `websockets/clob/user.ts`
 * `#onConnectionMessage`). Never throws.
 */
export function normalizeUserChannelFrame(frame: unknown, options: NormalizeOptions = {}): readonly UserChannelMessage[] {
  if (typeof frame !== "string") return Object.freeze([unrecognized("NOT_TEXT")]);
  if (frame === PONG_FRAME) return Object.freeze([Object.freeze({ kind: "PONG" as const })]);
  if (frame.length > MAX_FRAME_CHARACTERS) return Object.freeze([unrecognized("TOO_LARGE")]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return Object.freeze([unrecognized("NOT_JSON")]);
  }
  if (!Array.isArray(parsed)) return Object.freeze([normalizeUserChannelMessage(parsed, options)]);
  if (parsed.length === 0) return Object.freeze([unrecognized("EMPTY_BATCH")]);
  if (parsed.length > MAX_MESSAGES_PER_FRAME) return Object.freeze([unrecognized("BATCH_TOO_LARGE")]);
  return Object.freeze(parsed.map((entry: unknown) => normalizeUserChannelMessage(entry, options)));
}
