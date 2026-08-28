/**
 * Venue wire shapes → the frozen domain reference contracts.
 *
 * This is the decimal boundary (ADR-001 §3, §8). Coinbase sends prices and
 * sizes as strings, but the wire is not canonical, so every economic value goes
 * through `tryNormalizeDecimalString` here and the *result* crosses the
 * boundary. No value is ever coerced inside a domain schema, no value is ever a
 * JavaScript number, and a value the canonicalizer refuses fails loudly instead
 * of being clamped or dropped.
 *
 * This is also where the venue and receipt timestamps are kept apart. §7.1
 * separates `venueTimestamp` from `receivedAt`, §6 invariant 15 forbids replay
 * from using venue timestamps as an order, and ADR-002 §2.2 restates it: a venue
 * timestamp is data, not a position. So:
 *
 *   * `venueTimestamp` is the venue's own time for the *event* — the trade's
 *     `time` for a trade, the message `timestamp` for a top-of-book change,
 *     which is the only venue time a ticker frame carries.
 *   * `receivedAt` and `receivedMonotonicNs` are receipt times taken from
 *     injected clocks. They are never derived from a venue field.
 *   * The message-level `timestamp` is additionally preserved verbatim in
 *     `venueDetail.venueMessageTime`, so a trade's occurrence time and its
 *     publication time stay distinguishable after normalization.
 *
 * Nothing here throws. Each function returns an outcome, so a single bad trade
 * inside a 250-ms batch cannot discard the batch's other trades.
 */

import { tryNormalizeDecimalString } from "@polymarket-bot/decimal";
import {
  IsoTimestampSchema,
  ReferenceTopOfBookChangedContract,
  ReferenceTradeObservedContract,
  type BookSide,
  type ReferenceTopOfBookChangedPayload,
  type ReferenceTradeObservedPayload,
} from "@polymarket-bot/domain";

import type { CoinbaseAnomalyCode } from "./anomalies.js";
import { COINBASE_EVENT_TYPES, type CoinbaseTradeSide } from "./venue-facts.js";
import type { CoinbaseMarketTrade, CoinbaseTicker } from "./wire.js";

/**
 * The envelope fields an adapter can honestly fill in.
 *
 * `eventId`, `gatewayEpoch` and `ingestSeq` are deliberately ABSENT: ADR-002 §2
 * makes `(gatewayEpoch, ingestSeq)` the sole ordering authority and §9.1 assigns
 * it at the gateway (`WP-120`). An adapter that minted them would be inventing a
 * position in a total order it cannot see, and two adapters in one process would
 * mint conflicting ones. The gateway completes this draft.
 */
export type CoinbaseEnvelopeDraft = {
  /** §7.1 authoritative provenance; matches the payload `venue` restatement. */
  readonly source: "coinbase";
  /** The Coinbase channel the event came from. */
  readonly sourceChannel: string;
  /** The venue's own time for this event, when the venue supplies one. */
  readonly venueTimestamp?: string;
  /** Receipt wall-clock time, from the injected clock. Never a venue value. */
  readonly receivedAt: string;
  /** Receipt monotonic nanoseconds, as a canonical unsigned integer string. */
  readonly receivedMonotonicNs: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
};

/** Venue-native detail preserved beside a normalized trade, so nothing is lost. */
export type CoinbaseTradeVenueDetail = {
  /** `trades[].time` — when the trade occurred. */
  readonly venueTradeTime: string;
  /** The message-level `timestamp` — when the venue sent the batch. */
  readonly venueMessageTime: string;
  /**
   * `trades[].side` exactly as received.
   *
   * Carried verbatim because `takerSide` below is a *derivation* from it
   * (U-CB-3). If the documented maker-side reading is ever corrected, the fix
   * is one function, and no recorded trade has lost the venue's own word for it.
   */
  readonly venueSide: string;
  /** What the documentation says `venueSide` means. */
  readonly venueSideMeaning: "MAKER";
  /** `events[].type`, verbatim: `snapshot` or `update`, or something new. */
  readonly venueEventType: string;
  readonly sequenceNum: number;
  /** `price` and `size` exactly as received, before canonicalization. */
  readonly rawPrice: string;
  readonly rawSize: string;
};

/** Venue-native detail preserved beside a normalized top-of-book change. */
export type CoinbaseTopOfBookVenueDetail = {
  readonly venueMessageTime: string;
  readonly venueEventType: string;
  readonly sequenceNum: number;
  readonly rawBestBid?: string;
  readonly rawBestAsk?: string;
  readonly rawBestBidQuantity?: string;
  readonly rawBestAskQuantity?: string;
};

export type CoinbaseNormalizedTrade = {
  readonly eventType: typeof ReferenceTradeObservedContract.eventType;
  readonly schemaVersion: number;
  readonly envelope: CoinbaseEnvelopeDraft;
  readonly payload: ReferenceTradeObservedPayload;
  readonly venueDetail: CoinbaseTradeVenueDetail;
};

export type CoinbaseNormalizedTopOfBook = {
  readonly eventType: typeof ReferenceTopOfBookChangedContract.eventType;
  readonly schemaVersion: number;
  readonly envelope: CoinbaseEnvelopeDraft;
  readonly payload: ReferenceTopOfBookChangedPayload;
  readonly venueDetail: CoinbaseTopOfBookVenueDetail;
};

/** A normalized reference event this adapter produces. */
export type CoinbaseNormalizedEvent = CoinbaseNormalizedTrade | CoinbaseNormalizedTopOfBook;

/** Something worth recording about a value that was still normalized successfully. */
export type CoinbaseNormalizationNote = {
  readonly code: CoinbaseAnomalyCode;
  readonly detail: string;
  readonly symbol?: string;
};

export type CoinbaseNormalizationOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly notes: readonly CoinbaseNormalizationNote[] }
  | {
      readonly ok: false;
      readonly code: CoinbaseAnomalyCode;
      readonly detail: string;
      readonly symbol?: string;
      readonly notes: readonly CoinbaseNormalizationNote[];
    };

/** Everything a normalizer needs that comes from outside the individual entry. */
export type CoinbaseNormalizationContext = {
  /** The message-level `timestamp` (RFC 3339). */
  readonly venueMessageTime: string;
  /** The `events[].type` this entry arrived under. */
  readonly venueEventType: string;
  readonly sequenceNum: number;
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
};

/**
 * Maps the documented MAKER side to the domain's taker side.
 *
 * The official pages are explicit that `side` "refers to the makers side"
 * (`market-trades-maker-side`), so the taker took the other side: a maker `SELL`
 * was lifted by a buyer, whose side of the book is the BID. The inversion is a
 * reading of the documentation, not an assumption about matching, and it is
 * isolated in this one function precisely because U-CB-3 records that a public
 * trade print cannot confirm the roles independently.
 *
 * @returns the taker's book side, or `undefined` for a value outside the
 * documented pair — ADR-002 §7 requires an unrecognized value to be a
 * first-class UNKNOWN rather than a guess, so no side is asserted.
 */
const TAKER_SIDE_BY_DOCUMENTED_MAKER_SIDE: Readonly<Record<CoinbaseTradeSide, BookSide>> = {
  SELL: "BID",
  BUY: "ASK",
};

export function takerSideFromDocumentedMakerSide(venueSide: string): BookSide | undefined {
  // Keyed by the documented vocabulary, so widening `COINBASE_TRADE_SIDES`
  // without deciding what the new value means fails to compile. `Object.hasOwn`
  // rather than a truthiness check, so an inherited property name such as
  // "toString" cannot masquerade as a side.
  return Object.hasOwn(TAKER_SIDE_BY_DOCUMENTED_MAKER_SIDE, venueSide)
    ? TAKER_SIDE_BY_DOCUMENTED_MAKER_SIDE[venueSide as CoinbaseTradeSide]
    : undefined;
}

function isKnownEventType(value: string): boolean {
  return (COINBASE_EVENT_TYPES as readonly string[]).includes(value);
}

/** Notes an `events[].type` outside the documented pair, without rejecting the data. */
export function noteUnknownEventType(
  venueEventType: string,
  symbol: string | undefined,
): CoinbaseNormalizationNote | undefined {
  if (isKnownEventType(venueEventType)) {
    return undefined;
  }
  return {
    code: "COINBASE_UNKNOWN_EVENT_TYPE",
    detail:
      `events[].type "${venueEventType.slice(0, 64)}" is outside the documented snapshot/update ` +
      "pair; the entries were still normalized and this frame was not treated as a snapshot",
    ...(symbol === undefined ? {} : { symbol }),
  };
}

/**
 * Normalizes one public trade.
 *
 * A canonicalization failure or a domain rejection returns `ok: false` for THIS
 * trade only. The caller keeps the other trades in the same 250-ms batch, and
 * the failure becomes an anomaly carrying the raw frame.
 */
export function normalizeTrade(
  trade: CoinbaseMarketTrade,
  context: CoinbaseNormalizationContext,
): CoinbaseNormalizationOutcome<CoinbaseNormalizedTrade> {
  const notes: CoinbaseNormalizationNote[] = [];
  const symbol = trade.product_id;

  // §7.1 types `venueTimestamp` as an ISO-8601 timestamp, and Coinbase documents
  // `trades[].time` as RFC 3339. Checking it here means an undocumented spelling
  // is attributed to the field that carried it, instead of failing the whole
  // envelope at the gateway with no idea which value was to blame.
  if (!IsoTimestampSchema.safeParse(trade.time).success) {
    return {
      ok: false,
      code: "COINBASE_TIMESTAMP_INVALID",
      detail: `trade ${trade.trade_id} time "${trade.time.slice(0, 64)}" is not the documented RFC 3339 form`,
      symbol,
      notes,
    };
  }

  const price = tryNormalizeDecimalString(trade.price, { range: "POSITIVE" });
  if (!price.ok) {
    return {
      ok: false,
      code: "COINBASE_ECONOMIC_FIELD_INVALID",
      detail: `trade ${trade.trade_id} price: ${price.message}`,
      symbol,
      notes,
    };
  }
  const size = tryNormalizeDecimalString(trade.size, { range: "POSITIVE" });
  if (!size.ok) {
    return {
      ok: false,
      code: "COINBASE_ECONOMIC_FIELD_INVALID",
      detail: `trade ${trade.trade_id} size: ${size.message}`,
      symbol,
      notes,
    };
  }

  const takerSide = takerSideFromDocumentedMakerSide(trade.side);
  if (takerSide === undefined) {
    notes.push({
      code: "COINBASE_UNKNOWN_TRADE_SIDE",
      detail:
        `trade ${trade.trade_id} side "${trade.side.slice(0, 64)}" is outside the documented ` +
        "BUY/SELL pair; takerSide is omitted rather than guessed",
      symbol,
    });
  }

  const candidate = {
    venue: "coinbase",
    symbol,
    price: price.value,
    size: size.value,
    ...(takerSide === undefined ? {} : { takerSide }),
    venueTradeId: trade.trade_id,
  };

  const parsed = ReferenceTradeObservedContract.payloadSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: "COINBASE_DOMAIN_PAYLOAD_REJECTED",
      detail: `trade ${trade.trade_id}: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`.slice(0, 1000),
      symbol,
      notes,
    };
  }

  return {
    ok: true,
    notes,
    value: {
      eventType: ReferenceTradeObservedContract.eventType,
      schemaVersion: ReferenceTradeObservedContract.schemaVersion,
      envelope: {
        source: "coinbase",
        sourceChannel: "market_trades",
        venueTimestamp: trade.time,
        receivedAt: context.receivedAt,
        receivedMonotonicNs: context.receivedMonotonicNs,
        connectionId: context.connectionId,
        subscriptionGeneration: context.subscriptionGeneration,
      },
      payload: parsed.data as ReferenceTradeObservedPayload,
      venueDetail: {
        venueTradeTime: trade.time,
        venueMessageTime: context.venueMessageTime,
        venueSide: trade.side,
        venueSideMeaning: "MAKER",
        venueEventType: context.venueEventType,
        sequenceNum: context.sequenceNum,
        rawPrice: trade.price,
        rawSize: trade.size,
      },
    },
  };
}

/**
 * Normalizes one ticker entry into a top-of-book change.
 *
 * A ticker frame carries no per-entry time, so the venue time for this event is
 * the message-level `timestamp` (`envelope-base`) — the only venue time the
 * channel supplies. It is recorded as `venueTimestamp` rather than being
 * replaced by the receipt time, which would attribute the venue's latency to the
 * consumer's clock.
 *
 * An ABSENT key stays absent (documented for `ticker_batch`,
 * `ticker-batch-no-top-of-book`). A present but unusable value fails: whether
 * Coinbase ever sends `""` or `null` is UNVERIFIED (U-CB-1), so mapping either
 * to absence would be inventing venue behavior, and inventing `"0"` would turn
 * "no best bid" into "a best bid of zero".
 */
export function normalizeTopOfBook(
  ticker: CoinbaseTicker,
  context: CoinbaseNormalizationContext,
): CoinbaseNormalizationOutcome<CoinbaseNormalizedTopOfBook> {
  const notes: CoinbaseNormalizationNote[] = [];
  const symbol = ticker.product_id;

  // The message timestamp becomes this event's `venueTimestamp`, so it has to
  // satisfy the same §7.1 ISO-8601 rule the trade's own time does.
  if (!IsoTimestampSchema.safeParse(context.venueMessageTime).success) {
    return {
      ok: false,
      code: "COINBASE_TIMESTAMP_INVALID",
      detail: `ticker ${symbol} message timestamp "${context.venueMessageTime.slice(0, 64)}" is not the documented RFC 3339 form`,
      symbol,
      notes,
    };
  }

  const bidPrice = normalizeOptional(ticker.best_bid, "POSITIVE");
  if (!bidPrice.ok) {
    return failField(symbol, "best_bid", bidPrice.message, notes);
  }
  const askPrice = normalizeOptional(ticker.best_ask, "POSITIVE");
  if (!askPrice.ok) {
    return failField(symbol, "best_ask", askPrice.message, notes);
  }
  const bidSize = normalizeOptional(ticker.best_bid_quantity, "NON_NEGATIVE");
  if (!bidSize.ok) {
    return failField(symbol, "best_bid_quantity", bidSize.message, notes);
  }
  const askSize = normalizeOptional(ticker.best_ask_quantity, "NON_NEGATIVE");
  if (!askSize.ok) {
    return failField(symbol, "best_ask_quantity", askSize.message, notes);
  }

  const candidate = {
    venue: "coinbase",
    symbol,
    ...(bidPrice.value === undefined ? {} : { bidPrice: bidPrice.value }),
    ...(bidSize.value === undefined ? {} : { bidSize: bidSize.value }),
    ...(askPrice.value === undefined ? {} : { askPrice: askPrice.value }),
    ...(askSize.value === undefined ? {} : { askSize: askSize.value }),
  };

  const parsed = ReferenceTopOfBookChangedContract.payloadSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: "COINBASE_DOMAIN_PAYLOAD_REJECTED",
      detail: `ticker ${symbol}: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`.slice(0, 1000),
      symbol,
      notes,
    };
  }

  return {
    ok: true,
    notes,
    value: {
      eventType: ReferenceTopOfBookChangedContract.eventType,
      schemaVersion: ReferenceTopOfBookChangedContract.schemaVersion,
      envelope: {
        source: "coinbase",
        sourceChannel: "ticker",
        venueTimestamp: context.venueMessageTime,
        receivedAt: context.receivedAt,
        receivedMonotonicNs: context.receivedMonotonicNs,
        connectionId: context.connectionId,
        subscriptionGeneration: context.subscriptionGeneration,
      },
      payload: parsed.data as ReferenceTopOfBookChangedPayload,
      venueDetail: {
        venueMessageTime: context.venueMessageTime,
        venueEventType: context.venueEventType,
        sequenceNum: context.sequenceNum,
        ...(ticker.best_bid === undefined ? {} : { rawBestBid: ticker.best_bid }),
        ...(ticker.best_ask === undefined ? {} : { rawBestAsk: ticker.best_ask }),
        ...(ticker.best_bid_quantity === undefined
          ? {}
          : { rawBestBidQuantity: ticker.best_bid_quantity }),
        ...(ticker.best_ask_quantity === undefined
          ? {}
          : { rawBestAskQuantity: ticker.best_ask_quantity }),
      },
    },
  };
}

type OptionalNormalization =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly message: string };

function normalizeOptional(
  raw: string | undefined,
  range: "POSITIVE" | "NON_NEGATIVE",
): OptionalNormalization {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  const result = tryNormalizeDecimalString(raw, { range });
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.message };
}

function failField(
  symbol: string,
  field: string,
  message: string,
  notes: readonly CoinbaseNormalizationNote[],
): CoinbaseNormalizationOutcome<CoinbaseNormalizedTopOfBook> {
  return {
    ok: false,
    code: "COINBASE_ECONOMIC_FIELD_INVALID",
    detail: `ticker ${symbol} ${field}: ${message}`,
    symbol,
    notes,
  };
}
