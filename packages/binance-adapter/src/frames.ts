/**
 * The Binance wire format: schemas for the documented frames, and one decoder.
 *
 * SCOPE. Exactly the frames a trades + top-of-book subscription can receive:
 * `<symbol>@trade`, `<symbol>@bookTicker`, the `serverShutdown` lifecycle
 * notice, and the JSON control responses/errors documented for the same socket.
 * Everything else is classified `UNKNOWN` and reported — never assumed.
 *
 * ALL FIELD SHAPES ARE QUOTED FROM `web-socket-streams.md` (accessed
 * 2026-08-27); each schema carries the payload block it was written from.
 *
 * LOOSE OBJECTS AT THE WIRE, STRICT OBJECTS AT THE DOMAIN. `packages/domain`
 * validates strict objects because an unknown key there is a schema-version
 * event (ADR-002 §3). The *wire* is the opposite case: ADR-002 §7 rules that
 * fixture-level strictness "is **wrong** for a runtime parser, which would
 * reject valid venue traffic", and Binance adds fields to payloads over time. So
 * these schemas are loose — and the unknown keys are not thrown away either:
 * {@link DecodedFrame} carries `unknownFields`, so a new venue field is visible
 * as data instead of being either fatal or invisible.
 *
 * NOTHING IS SILENTLY DROPPED. Every input produces a `DecodedFrame`; the
 * failure cases (`MALFORMED`, `UNKNOWN`) are values, not exceptions and not
 * omissions, because §8.3 forbids dropping a raw market event silently and
 * ADR-002 §7 requires an unrecognized venue value to be "first-class UNKNOWN —
 * routed to `DataQualityIncidentOpened` and preserved raw".
 *
 * INTEGERS ARE CHECKED FOR EXACTNESS (`BNC-U6`). `z.int()` accepts only the
 * JavaScript safe-integer range, so a venue id or epoch that `JSON.parse` could
 * only represent approximately fails to parse instead of being carried as a
 * rounded value that would then be printed as a wrong `venueTradeId`.
 *
 * THE PARSE IS NOT THE DOOR (`REC-1`, ADR-020 §3, `schema-boundary.md` §3).
 * `zod` reads a schema's DECLARED keys through the prototype chain, so a
 * successful parse is not evidence that the frame carried them. Every frame is
 * therefore materialized prototype-free by `./wire-door.ts` before any schema
 * runs, every emitted value is taken from that materialized tree rather than
 * from `result.data`, every parse and every refusal RENDERING happens inside a
 * containment, and every decoded frame is emitted with a null prototype. See
 * that module's header for which of D1–D4 this door performs and which it
 * does not.
 */

import { z } from "zod";

import {
  containedParse,
  isOwnRecord,
  ownBoolean,
  ownBoundedString,
  ownEmit,
  ownSafeInt,
  readOwnWire,
  type OwnRecord,
} from "./wire-door.js";
import {
  BINANCE_BOOK_TICKER_STREAM_SUFFIX,
  BINANCE_SERVER_SHUTDOWN_EVENT_TYPE,
  BINANCE_TRADE_EVENT_TYPE,
  BINANCE_TRADE_STREAM_SUFFIX,
} from "./venue.js";

/**
 * Bound on any single frame this package will attempt to decode, in **UTF-8
 * bytes on the wire**.
 *
 * MEASURED IN BYTES, NOT IN CHARACTERS. `String#length` counts UTF-16 code
 * units, and the venue explicitly contemplates non-ASCII symbol names ("the
 * stream events may contain non-ASCII characters encoded in UTF-8"), so a frame
 * of non-ASCII text can be two or three times its `length` in bytes. Checking
 * `length` against a byte bound would therefore let a frame materially larger
 * than this limit through — the limit exists to bound the work a single
 * venue-controlled input can cause, so it has to be measured in the units the
 * venue actually sends (round-1 review, L2).
 */
export const MAX_FRAME_BYTES = 1_048_576;

/**
 * UTF-8 byte length of a string, without allocating an encoded copy.
 *
 * A lone surrogate is counted as 3 bytes because that is what an encoder
 * produces for it: `TextEncoder` substitutes U+FFFD, which is 3 bytes.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Whether a frame is over the byte bound, computing the exact length only when
 * the cheap bounds cannot decide.
 *
 * Every UTF-16 code unit contributes at least one byte and at most three
 * (a surrogate pair is 2 units for 4 bytes), so `length > MAX` proves the frame
 * is too large and `length * 3 <= MAX` proves it is not.
 */
function exceedsFrameByteBound(raw: string): boolean {
  if (raw.length > MAX_FRAME_BYTES) {
    return true;
  }
  if (raw.length * 3 <= MAX_FRAME_BYTES) {
    return false;
  }
  return utf8ByteLength(raw) > MAX_FRAME_BYTES;
}

/** Bound on a raw excerpt carried into an incident `detail` field. */
export const MAX_RAW_EXCERPT_LENGTH = 512;

const VenueDecimalSchema = z.string().min(1).max(64);
const VenueSymbolSchema = z.string().min(1).max(64);

/**
 * `<symbol>@trade` — "Trade Streams":
 *
 * ```javascript
 * { "e": "trade", "E": 1672515782136, "s": "BNBBTC", "t": 12345,
 *   "p": "0.001", "q": "100", "T": 1672515782136, "m": true, "M": true }
 * ```
 *
 * `M` is documented as "Ignore" and is therefore not modeled: giving it a
 * meaning would be an invention. It survives in `unknownFields` like any other
 * key the schema does not name.
 */
export const BinanceTradePayloadSchema = z.looseObject({
  e: z.literal(BINANCE_TRADE_EVENT_TYPE),
  /** Event time. */
  E: z.int(),
  /** Symbol, in the venue's own spelling. */
  s: VenueSymbolSchema,
  /** Trade ID. */
  t: z.int(),
  /** Price — a decimal string on the wire; normalized at the domain boundary. */
  p: VenueDecimalSchema,
  /** Quantity — a decimal string on the wire. */
  q: VenueDecimalSchema,
  /** Trade time. */
  T: z.int(),
  /** "Is the buyer the market maker?" */
  m: z.boolean(),
});

/**
 * Keys the venue DOCUMENTS for this payload.
 *
 * `M` is in the set although no schema field models it: the venue documents it
 * (as "Ignore"), so its presence is not schema drift. `unknownFields` answers
 * "did the venue send something its documentation does not describe", which is
 * the question worth an operator's attention; answering "did this package model
 * every key" instead would raise a data-quality incident on every single trade
 * frame and bury the real signal.
 */
const TRADE_KNOWN_KEYS = new Set(["e", "E", "s", "t", "p", "q", "T", "m", "M"]);

/**
 * `<symbol>@bookTicker` — "Individual Symbol Book Ticker Streams":
 *
 * ```javascript
 * { "u": 400900217, "s": "BNBUSDT", "b": "25.35190000", "B": "31.21000000",
 *   "a": "25.36520000", "A": "40.66000000" }
 * ```
 *
 * NOTE, and it is load-bearing: this payload carries **no event-type field and
 * no timestamp**. A top-of-book event normalized from it therefore has no
 * `venueTimestamp` — the venue supplies none — and the only time it can carry is
 * the receipt stamp. That is a fact about the feed, not a gap in this adapter,
 * and inventing a venue instant from the receipt time would be exactly the kind
 * of fabrication §6 invariant 15 exists to prevent.
 */
export const BinanceBookTickerPayloadSchema = z.looseObject({
  /** "order book updateId". */
  u: z.int(),
  s: VenueSymbolSchema,
  /** Best bid price. */
  b: VenueDecimalSchema,
  /** Best bid quantity. */
  B: VenueDecimalSchema,
  /** Best ask price. */
  a: VenueDecimalSchema,
  /** Best ask quantity. */
  A: VenueDecimalSchema,
});

const BOOK_TICKER_KNOWN_KEYS = new Set(["u", "s", "b", "B", "a", "A"]);

/**
 * `serverShutdown` — "Server Shutdown":
 *
 * ```javascript
 * { "e": "serverShutdown", "E": 1770123456789 }
 * ```
 *
 * "Please establish a new connection as soon as possible to prevent
 * interruption." The feed turns this into an explicit signal rather than waiting
 * for the socket to die silently.
 */
export const BinanceServerShutdownPayloadSchema = z.looseObject({
  e: z.literal(BINANCE_SERVER_SHUTDOWN_EVENT_TYPE),
  E: z.int(),
});

/**
 * Control responses — "Live Subscribing/Unsubscribing to streams".
 *
 * `{"result": null, "id": 1}` for a successful subscribe/unsubscribe,
 * `{"result": ["btcusdt@aggTrade"], "id": 3}` for `LIST_SUBSCRIPTIONS`,
 * `{"result": true, "id": 2}` for `GET_PROPERTY`. The `id` is documented as "a
 * 64-bit signed integer, alphanumeric strings; max length 36, or `null`".
 */
export const BinanceControlResponseSchema = z.looseObject({
  result: z.unknown(),
  id: z.union([z.int(), z.string().max(36), z.null()]).optional(),
});

/**
 * Control errors — the "Error Messages" table, e.g.
 * `{"code": 2, "msg": "Invalid request: too many parameters"}` and
 * `{"code":3,"msg":"Invalid JSON: expected value at line %s column %s"}`.
 *
 * The table is a list of the errors Binance documents; it is not stated to be
 * exhaustive, so `code` is an integer rather than an enum (ADR-002 §7: an
 * enumeration the venue has not declared exhaustive must not be treated as one).
 */
export const BinanceControlErrorSchema = z.looseObject({
  code: z.int(),
  msg: z.string().max(1024),
  id: z.union([z.int(), z.string().max(36), z.null()]).optional(),
});

/**
 * The combined-stream wrapper — "Combined stream events are wrapped as follows:
 * `{"stream":"<streamName>","data":<rawPayload>}`".
 */
export const BinanceCombinedEnvelopeSchema = z.looseObject({
  stream: z.string().min(1).max(128),
  data: z.unknown(),
});

/** Why a frame could not be decoded into a documented shape. */
export type MalformedFrameReason =
  | "FRAME_TOO_LARGE"
  | "NOT_JSON"
  | "NOT_AN_OBJECT"
  | "SCHEMA_MISMATCH"
  /**
   * The combined-stream wrapper named a channel the payload contradicts.
   *
   * The wrapper is the venue's statement of provenance and the payload is the
   * venue's statement of content; when they disagree, neither can be trusted to
   * route the event, so the frame is preserved and reported rather than
   * published under a channel it may not belong to (round-1 review, M1).
   */
  | "CHANNEL_MISMATCH"
  /** The frame's channel is not one of the channels this feed subscribed to. */
  | "CHANNEL_NOT_SUBSCRIBED";

/** Common fields on every decoded frame. */
type DecodedBase = {
  /** The frame exactly as received. Preserved so nothing is lost on any path. */
  readonly raw: string;
  /**
   * The originating stream name.
   *
   * Stated by the combined-stream wrapper when present; otherwise reconstructed
   * from the documented `s` field and the payload's shape, which is why the
   * reconstruction is recorded in {@link DecodedFrame.channelSource}.
   */
  readonly streamName: string | undefined;
  /**
   * Where the stream name came from, and whether it was checked.
   *
   * - `WRAPPER` — stated by the combined-stream wrapper **and** verified against
   *   the payload's own symbol and decoded kind (and, when the caller supplied
   *   a subscription set, against that set).
   * - `RECONSTRUCTED` — derived from the documented `s` field and the payload's
   *   shape, because the frame arrived unwrapped.
   * - `UNVERIFIED_WRAPPER` — stated by the wrapper for a payload that derives no
   *   channel of its own, so nothing could check it. The documented
   *   `!serverShutdown` wrapper is exactly this case: it is not a
   *   `<symbol>@<suffix>` name at all. Such a name is preserved as data but is
   *   never used as an event's `sourceChannel`.
   * - `NONE` — the frame carried no channel information.
   */
  readonly channelSource: "WRAPPER" | "RECONSTRUCTED" | "UNVERIFIED_WRAPPER" | "NONE";
  /**
   * Keys present on the wire that the venue's documentation does not describe.
   *
   * A documented-but-unmodelled key (the trade payload's `M`, "Ignore") is NOT
   * listed: this field exists to make venue schema drift visible, not to report
   * this package's modelling choices.
   */
  readonly unknownFields: readonly string[];
};

export type DecodedTradeFrame = DecodedBase & {
  readonly kind: "TRADE";
  readonly symbol: string;
  readonly tradeId: number;
  readonly priceRaw: string;
  readonly quantityRaw: string;
  /** `E` — event time, in the connection's declared unit. */
  readonly eventTimeEpoch: number;
  /** `T` — trade time, in the connection's declared unit. */
  readonly tradeTimeEpoch: number;
  /**
   * `m` — "Is the buyer the market maker?", preserved verbatim.
   *
   * The domain's `takerSide` is derived from it (`m = true → ASK`,
   * `m = false → BID`, ADR-014; see `takerSideFor` in `./normalize.ts`), and the
   * raw boolean still survives here, unmapped, so a consumer reads the venue's
   * own statement rather than re-deriving it. `BNC-U5` — the question of which
   * side `takerSide` names — is closed by that ADR (`BINANCE_RESOLVED` in
   * `./venue.ts`).
   */
  readonly buyerIsMaker: boolean;
};

export type DecodedBookTickerFrame = DecodedBase & {
  readonly kind: "BOOK_TICKER";
  readonly symbol: string;
  readonly updateId: number;
  readonly bidPriceRaw: string;
  readonly bidQuantityRaw: string;
  readonly askPriceRaw: string;
  readonly askQuantityRaw: string;
};

export type DecodedServerShutdownFrame = DecodedBase & {
  readonly kind: "SERVER_SHUTDOWN";
  readonly eventTimeEpoch: number;
};

export type DecodedControlResponseFrame = DecodedBase & {
  readonly kind: "CONTROL_RESPONSE";
  readonly id: number | string | null | undefined;
};

export type DecodedControlErrorFrame = DecodedBase & {
  readonly kind: "CONTROL_ERROR";
  readonly venueCode: number;
  readonly message: string;
};

export type DecodedUnknownFrame = DecodedBase & {
  readonly kind: "UNKNOWN";
  /** The `e` value when the frame declared one this package does not model. */
  readonly declaredEventType: string | undefined;
  readonly detail: string;
};

export type DecodedMalformedFrame = DecodedBase & {
  readonly kind: "MALFORMED";
  readonly reason: MalformedFrameReason;
  readonly detail: string;
};

export type DecodedFrame =
  | DecodedTradeFrame
  | DecodedBookTickerFrame
  | DecodedServerShutdownFrame
  | DecodedControlResponseFrame
  | DecodedControlErrorFrame
  | DecodedUnknownFrame
  | DecodedMalformedFrame;

/** Frame kinds that normalize into a domain reference event. */
export const NORMALIZABLE_FRAME_KINDS = ["TRADE", "BOOK_TICKER"] as const;

/** A bounded, single-line excerpt of a raw frame, safe for an incident `detail`. */
export function rawExcerpt(raw: string): string {
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return "(empty frame)";
  }
  return collapsed.length <= MAX_RAW_EXCERPT_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_RAW_EXCERPT_LENGTH)}…(truncated; the verbatim frame is in the raw WAL)`;
}

/**
 * Options for {@link decodeFrame}.
 *
 * `expectedStreams` is the resolved subscription set of the connection the frame
 * arrived on. Supplying it turns "the venue named a channel" into "the venue
 * named a channel this connection actually asked for": a combined connection
 * delivers only the streams in its `?streams=` query, so a frame claiming any
 * other channel is either drift or misrouting, and publishing it under that
 * channel would record provenance that no subscription supports. It is optional
 * because the decoder is also used to inspect a single frame in isolation (the
 * fixture suites do exactly that), where there is no subscription set to check
 * against.
 */
export type DecodeFrameOptions = {
  readonly expectedStreams?: ReadonlySet<string>;
};

/**
 * Decodes one received frame.
 *
 * Total by construction: every input maps to a `DecodedFrame`, and no input
 * throws. A caller therefore cannot accidentally write a `catch` that discards
 * venue traffic.
 */
export function decodeFrame(raw: string, options: DecodeFrameOptions = {}): DecodedFrame {
  if (exceedsFrameByteBound(raw)) {
    return malformed(raw, undefined, "NONE", "FRAME_TOO_LARGE", {
      detail: `frame is ${String(utf8ByteLength(raw))} UTF-8 bytes, above the ${String(MAX_FRAME_BYTES)}-byte bound`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    return malformed(raw, undefined, "NONE", "NOT_JSON", {
      detail: error instanceof Error ? error.message : "JSON.parse failed",
    });
  }

  // D1. Before a schema runs and before any property is read: rebuild the
  // frame as own data with no prototype. Everything below reads that tree.
  const read = readOwnWire(parsed);
  if (!read.ok) {
    return malformed(raw, undefined, "NONE", "SCHEMA_MISMATCH", {
      detail: `frame could not be read as JSON data: ${read.detail}`,
    });
  }
  const frame: unknown = read.value;

  if (!isOwnRecord(frame)) {
    return malformed(raw, undefined, "NONE", "NOT_AN_OBJECT", {
      detail: `top-level value is ${describeJsonType(frame)}; every documented frame is a JSON object`,
    });
  }

  // The combined-stream wrapper states the originating stream. It is a CLAIM
  // until the payload agrees with it — see `resolveChannel`. Both halves of
  // "is this a wrapper" are answered from what the frame OWNS: `Object.hasOwn`
  // rather than `in`, and the stream name read from the tree.
  const stream = ownBoundedString(frame, "stream", 1, 128);
  if (stream !== undefined && Object.hasOwn(frame, "data")) {
    const wrapper = containedParse(BinanceCombinedEnvelopeSchema, frame);
    if (!wrapper.ok) {
      return malformed(raw, stream, "UNVERIFIED_WRAPPER", "SCHEMA_MISMATCH", {
        detail: `combined-stream wrapper: ${wrapper.detail}`,
      });
    }
    const inner: unknown = frame["data"];
    if (!isOwnRecord(inner)) {
      return malformed(raw, stream, "UNVERIFIED_WRAPPER", "NOT_AN_OBJECT", {
        detail: `combined-stream \`data\` is ${describeJsonType(inner)}; a wrapped payload is a JSON object`,
      });
    }
    return decodePayload(raw, inner, stream, options);
  }

  return decodePayload(raw, frame, undefined, options);
}

function decodePayload(
  raw: string,
  payload: OwnRecord,
  streamName: string | undefined,
  options: DecodeFrameOptions,
): DecodedFrame {
  // A wrapper name that no payload-derived channel can be checked against is
  // recorded, never trusted.
  const channelSource: DecodedBase["channelSource"] =
    streamName === undefined ? "NONE" : "UNVERIFIED_WRAPPER";
  const declaredEventType = typeof payload["e"] === "string" ? payload["e"] : undefined;

  if (declaredEventType === BINANCE_TRADE_EVENT_TYPE) {
    const result = containedParse(BinanceTradePayloadSchema, payload);
    if (!result.ok) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `\`${BINANCE_TRADE_EVENT_TYPE}\` payload: ${result.detail}`,
      });
    }
    // D3. THE MEASURED ROW. Every field is taken from the materialized tree —
    // never from `result.data` — and each read restates the presence and the
    // bound the schema declares, so a frame that did not carry `q` is refused
    // whatever the library was persuaded to accept.
    const trade = ownTradeFields(payload);
    if (trade === undefined) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", { detail: TAKE_FAILED });
    }
    const channel = resolveChannel(streamName, trade.symbol, BINANCE_TRADE_STREAM_SUFFIX, options);
    if (!channel.ok) {
      return malformed(raw, streamName, channelSource, channel.reason, { detail: channel.detail });
    }
    return ownEmit<DecodedTradeFrame>({
      kind: "TRADE",
      raw,
      streamName: channel.streamName,
      channelSource: channel.channelSource,
      unknownFields: unknownKeysOf(payload, TRADE_KNOWN_KEYS),
      symbol: trade.symbol,
      tradeId: trade.tradeId,
      priceRaw: trade.priceRaw,
      quantityRaw: trade.quantityRaw,
      eventTimeEpoch: trade.eventTimeEpoch,
      tradeTimeEpoch: trade.tradeTimeEpoch,
      buyerIsMaker: trade.buyerIsMaker,
    });
  }

  if (declaredEventType === BINANCE_SERVER_SHUTDOWN_EVENT_TYPE) {
    const result = containedParse(BinanceServerShutdownPayloadSchema, payload);
    if (!result.ok) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `\`${BINANCE_SERVER_SHUTDOWN_EVENT_TYPE}\` payload: ${result.detail}`,
      });
    }
    const eventTimeEpoch = ownSafeInt(payload, "E");
    if (eventTimeEpoch === undefined) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", { detail: TAKE_FAILED });
    }
    return ownEmit<DecodedServerShutdownFrame>({
      kind: "SERVER_SHUTDOWN",
      raw,
      streamName,
      channelSource,
      unknownFields: unknownKeysOf(payload, SHUTDOWN_KNOWN_KEYS),
      eventTimeEpoch,
    });
  }

  if (declaredEventType !== undefined) {
    return ownEmit<DecodedUnknownFrame>({
      kind: "UNKNOWN",
      raw,
      streamName,
      channelSource,
      unknownFields: [],
      declaredEventType,
      detail: `event type ${JSON.stringify(declaredEventType)} is not one this package models (in scope: ${BINANCE_TRADE_EVENT_TYPE}, ${BINANCE_SERVER_SHUTDOWN_EVENT_TYPE}, and the untyped bookTicker payload)`,
    });
  }

  // `bookTicker` is the one in-scope payload with no `e` field, so it is
  // recognised by its documented key set rather than by a discriminator.
  if (looksLikeBookTicker(payload)) {
    const result = containedParse(BinanceBookTickerPayloadSchema, payload);
    if (!result.ok) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `\`${BINANCE_BOOK_TICKER_STREAM_SUFFIX}\` payload: ${result.detail}`,
      });
    }
    const ticker = ownBookTickerFields(payload);
    if (ticker === undefined) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", { detail: TAKE_FAILED });
    }
    const channel = resolveChannel(
      streamName,
      ticker.symbol,
      BINANCE_BOOK_TICKER_STREAM_SUFFIX,
      options,
    );
    if (!channel.ok) {
      return malformed(raw, streamName, channelSource, channel.reason, { detail: channel.detail });
    }
    return ownEmit<DecodedBookTickerFrame>({
      kind: "BOOK_TICKER",
      raw,
      streamName: channel.streamName,
      channelSource: channel.channelSource,
      unknownFields: unknownKeysOf(payload, BOOK_TICKER_KNOWN_KEYS),
      symbol: ticker.symbol,
      updateId: ticker.updateId,
      bidPriceRaw: ticker.bidPriceRaw,
      bidQuantityRaw: ticker.bidQuantityRaw,
      askPriceRaw: ticker.askPriceRaw,
      askQuantityRaw: ticker.askQuantityRaw,
    });
  }

  if (Object.hasOwn(payload, "code") && Object.hasOwn(payload, "msg")) {
    const result = containedParse(BinanceControlErrorSchema, payload);
    if (!result.ok) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `control error payload: ${result.detail}`,
      });
    }
    const venueCode = ownSafeInt(payload, "code");
    const message = ownBoundedString(payload, "msg", 0, 1024);
    if (venueCode === undefined || message === undefined) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", { detail: TAKE_FAILED });
    }
    return ownEmit<DecodedControlErrorFrame>({
      kind: "CONTROL_ERROR",
      raw,
      streamName,
      channelSource,
      unknownFields: unknownKeysOf(payload, CONTROL_ERROR_KNOWN_KEYS),
      venueCode,
      message,
    });
  }

  if (Object.hasOwn(payload, "result")) {
    const result = containedParse(BinanceControlResponseSchema, payload);
    if (!result.ok) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `control response payload: ${result.detail}`,
      });
    }
    return ownEmit<DecodedControlResponseFrame>({
      kind: "CONTROL_RESPONSE",
      raw,
      streamName,
      channelSource,
      unknownFields: unknownKeysOf(payload, CONTROL_RESPONSE_KNOWN_KEYS),
      // `id` is documented optional and nullable, so ABSENCE is a documented
      // value here rather than a missing field. It is still read from the
      // materialized tree: an absent `id` reads `undefined` from a
      // prototype-free record whatever `Object.prototype` carries.
      id: ownControlId(payload) ?? null,
    });
  }

  return ownEmit<DecodedUnknownFrame>({
    kind: "UNKNOWN",
    raw,
    streamName,
    channelSource,
    unknownFields: [],
    declaredEventType: undefined,
    detail: `frame declares no \`e\` and matches no documented in-scope shape; keys: ${JSON.stringify(Object.keys(payload).slice(0, 20))}`,
  });
}

/** The detail a take-from-the-tree refusal carries. */
const TAKE_FAILED =
  "the schema accepted this frame but the frame itself does not carry every documented field as its own value; a field that is not in the frame is never taken from anywhere else";

const SHUTDOWN_KNOWN_KEYS = new Set(["e", "E"]);
const CONTROL_ERROR_KNOWN_KEYS = new Set(["code", "msg", "id"]);
const CONTROL_RESPONSE_KNOWN_KEYS = new Set(["result", "id"]);

/** D3 for `<symbol>@trade`: what the FRAME carries, or nothing. */
function ownTradeFields(payload: OwnRecord):
  | {
      readonly symbol: string;
      readonly tradeId: number;
      readonly priceRaw: string;
      readonly quantityRaw: string;
      readonly eventTimeEpoch: number;
      readonly tradeTimeEpoch: number;
      readonly buyerIsMaker: boolean;
    }
  | undefined {
  const symbol = ownBoundedString(payload, "s", 1, 64);
  const priceRaw = ownBoundedString(payload, "p", 1, 64);
  const quantityRaw = ownBoundedString(payload, "q", 1, 64);
  const tradeId = ownSafeInt(payload, "t");
  const eventTimeEpoch = ownSafeInt(payload, "E");
  const tradeTimeEpoch = ownSafeInt(payload, "T");
  const buyerIsMaker = ownBoolean(payload, "m");
  if (
    symbol === undefined ||
    priceRaw === undefined ||
    quantityRaw === undefined ||
    tradeId === undefined ||
    eventTimeEpoch === undefined ||
    tradeTimeEpoch === undefined ||
    buyerIsMaker === undefined
  ) {
    return undefined;
  }
  return {
    symbol,
    tradeId,
    priceRaw,
    quantityRaw,
    eventTimeEpoch,
    tradeTimeEpoch,
    buyerIsMaker,
  };
}

/** D3 for `<symbol>@bookTicker`. */
function ownBookTickerFields(payload: OwnRecord):
  | {
      readonly symbol: string;
      readonly updateId: number;
      readonly bidPriceRaw: string;
      readonly bidQuantityRaw: string;
      readonly askPriceRaw: string;
      readonly askQuantityRaw: string;
    }
  | undefined {
  const symbol = ownBoundedString(payload, "s", 1, 64);
  const updateId = ownSafeInt(payload, "u");
  const bidPriceRaw = ownBoundedString(payload, "b", 1, 64);
  const bidQuantityRaw = ownBoundedString(payload, "B", 1, 64);
  const askPriceRaw = ownBoundedString(payload, "a", 1, 64);
  const askQuantityRaw = ownBoundedString(payload, "A", 1, 64);
  if (
    symbol === undefined ||
    updateId === undefined ||
    bidPriceRaw === undefined ||
    bidQuantityRaw === undefined ||
    askPriceRaw === undefined ||
    askQuantityRaw === undefined
  ) {
    return undefined;
  }
  return { symbol, updateId, bidPriceRaw, bidQuantityRaw, askPriceRaw, askQuantityRaw };
}

/** D3 for the control frames' `id`: an int, a bounded string, or nothing. */
function ownControlId(payload: OwnRecord): number | string | null | undefined {
  const value = payload["id"];
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.length <= 36 ? value : undefined;
  }
  return ownSafeInt(payload, "id");
}

function looksLikeBookTicker(payload: OwnRecord): boolean {
  for (const key of BOOK_TICKER_KNOWN_KEYS) {
    if (!Object.hasOwn(payload, key)) {
      return false;
    }
  }
  return true;
}

type ResolvedChannel =
  | {
      readonly ok: true;
      readonly streamName: string;
      readonly channelSource: DecodedBase["channelSource"];
    }
  | { readonly ok: false; readonly reason: MalformedFrameReason; readonly detail: string };

/**
 * Establishes the channel a normalizable payload belongs to, and CHECKS it.
 *
 * The venue documents the combined wrapper as `{"stream":"<streamName>","data":
 * <rawPayload>}` and stream names as `"<lowercase symbol>@<suffix>"`, so for the
 * two payloads that carry their own symbol the wrapper is fully derivable — and
 * therefore fully checkable. Before this check the wrapper was believed
 * unconditionally, which meant a frame could be published with a
 * `sourceChannel` naming a different symbol, a different stream type, or a
 * string that is not a stream name at all, while its payload said something
 * else (round-1 review, M1). `sourceChannel` is provenance recorded in the WAL;
 * provenance that contradicts its own payload is worse than no provenance,
 * because a reader cannot tell it is wrong.
 *
 * Both failure modes are MALFORMED rather than silently corrected: the venue
 * documents no case in which the two disagree, so a disagreement is an
 * unrecognized condition, and ADR-002 §7 requires an unrecognized condition to
 * be preserved raw and reported rather than resolved by guessing which half to
 * believe.
 */
function resolveChannel(
  streamName: string | undefined,
  symbol: string,
  suffix: string,
  options: DecodeFrameOptions,
): ResolvedChannel {
  const derived = `${symbol.toLowerCase()}@${suffix}`;
  if (streamName !== undefined && streamName !== derived) {
    return {
      ok: false,
      reason: "CHANNEL_MISMATCH",
      detail: `combined-stream wrapper names ${JSON.stringify(streamName)} but the payload decodes as ${JSON.stringify(derived)} (symbol ${JSON.stringify(symbol)}); the venue documents stream names as "<lowercase symbol>@<suffix>", so the wrapper and the payload disagree about where this frame came from`,
    };
  }
  const expected = options.expectedStreams;
  if (expected !== undefined && !expected.has(derived)) {
    return {
      ok: false,
      reason: "CHANNEL_NOT_SUBSCRIBED",
      detail: `frame decodes as channel ${JSON.stringify(derived)}, which is not one of the subscribed streams (${[...expected].slice(0, 8).join(", ")}${expected.size > 8 ? ", …" : ""})`,
    };
  }
  return {
    ok: true,
    streamName: derived,
    channelSource: streamName === undefined ? "RECONSTRUCTED" : "WRAPPER",
  };
}

function malformed(
  raw: string,
  streamName: string | undefined,
  channelSource: DecodedBase["channelSource"],
  reason: MalformedFrameReason,
  extra: { readonly detail: string },
): DecodedMalformedFrame {
  return ownEmit<DecodedMalformedFrame>({
    kind: "MALFORMED",
    raw,
    streamName,
    channelSource,
    unknownFields: [],
    reason,
    detail: extra.detail,
  });
}

/**
 * Keys the venue sent that its documentation does not describe.
 *
 * Reads the MATERIALIZED tree, so this list is exactly what the frame carried:
 * `unknownFields` is a feature (ADR-002 §7 — venue schema drift is visible as
 * data), and closing declared-key adoption must not cost it.
 */
function unknownKeysOf(payload: OwnRecord, known: ReadonlySet<string>): string[] {
  return Object.keys(payload).filter((key) => !known.has(key));
}

function describeJsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return `a ${typeof value}`;
}
