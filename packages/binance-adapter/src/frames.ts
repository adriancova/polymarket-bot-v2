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
 */

import { z } from "zod";

import {
  BINANCE_BOOK_TICKER_STREAM_SUFFIX,
  BINANCE_SERVER_SHUTDOWN_EVENT_TYPE,
  BINANCE_TRADE_EVENT_TYPE,
  BINANCE_TRADE_STREAM_SUFFIX,
} from "./venue.js";

/** Bound on any single frame this package will attempt to decode. */
export const MAX_FRAME_BYTES = 1_048_576;

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
  | "SCHEMA_MISMATCH";

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
  readonly channelSource: "WRAPPER" | "RECONSTRUCTED" | "NONE";
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
  /** `m` — "Is the buyer the market maker?", preserved verbatim (see `BNC-U5`). */
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
 * Decodes one received frame.
 *
 * Total by construction: every input maps to a `DecodedFrame`, and no input
 * throws. A caller therefore cannot accidentally write a `catch` that discards
 * venue traffic.
 */
export function decodeFrame(raw: string): DecodedFrame {
  if (raw.length > MAX_FRAME_BYTES) {
    return malformed(raw, undefined, "NONE", "FRAME_TOO_LARGE", {
      detail: `frame is ${String(raw.length)} characters, above the ${String(MAX_FRAME_BYTES)} bound`,
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

  if (!isPlainObject(parsed)) {
    return malformed(raw, undefined, "NONE", "NOT_AN_OBJECT", {
      detail: `top-level value is ${describeJsonType(parsed)}; every documented frame is a JSON object`,
    });
  }

  // The combined-stream wrapper states the originating stream.
  const wrapper = BinanceCombinedEnvelopeSchema.safeParse(parsed);
  if (wrapper.success && "data" in parsed) {
    const inner: unknown = wrapper.data.data;
    if (!isPlainObject(inner)) {
      return malformed(raw, wrapper.data.stream, "WRAPPER", "NOT_AN_OBJECT", {
        detail: `combined-stream \`data\` is ${describeJsonType(inner)}; a wrapped payload is a JSON object`,
      });
    }
    return decodePayload(raw, inner, wrapper.data.stream, "WRAPPER");
  }

  return decodePayload(raw, parsed, undefined, "NONE");
}

function decodePayload(
  raw: string,
  payload: Record<string, unknown>,
  streamName: string | undefined,
  channelSource: DecodedBase["channelSource"],
): DecodedFrame {
  const declaredEventType = typeof payload["e"] === "string" ? payload["e"] : undefined;

  if (declaredEventType === BINANCE_TRADE_EVENT_TYPE) {
    const result = BinanceTradePayloadSchema.safeParse(payload);
    if (!result.success) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `\`${BINANCE_TRADE_EVENT_TYPE}\` payload: ${formatIssues(result.error)}`,
      });
    }
    const trade = result.data;
    const channel = resolveChannel(
      streamName,
      channelSource,
      trade.s,
      BINANCE_TRADE_STREAM_SUFFIX,
    );
    return {
      kind: "TRADE",
      raw,
      streamName: channel.streamName,
      channelSource: channel.channelSource,
      unknownFields: unknownKeysOf(payload, TRADE_KNOWN_KEYS),
      symbol: trade.s,
      tradeId: trade.t,
      priceRaw: trade.p,
      quantityRaw: trade.q,
      eventTimeEpoch: trade.E,
      tradeTimeEpoch: trade.T,
      buyerIsMaker: trade.m,
    };
  }

  if (declaredEventType === BINANCE_SERVER_SHUTDOWN_EVENT_TYPE) {
    const result = BinanceServerShutdownPayloadSchema.safeParse(payload);
    if (!result.success) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `\`${BINANCE_SERVER_SHUTDOWN_EVENT_TYPE}\` payload: ${formatIssues(result.error)}`,
      });
    }
    return {
      kind: "SERVER_SHUTDOWN",
      raw,
      streamName,
      channelSource,
      unknownFields: unknownKeysOf(payload, new Set(["e", "E"])),
      eventTimeEpoch: result.data.E,
    };
  }

  if (declaredEventType !== undefined) {
    return {
      kind: "UNKNOWN",
      raw,
      streamName,
      channelSource,
      unknownFields: [],
      declaredEventType,
      detail: `event type ${JSON.stringify(declaredEventType)} is not one this package models (in scope: ${BINANCE_TRADE_EVENT_TYPE}, ${BINANCE_SERVER_SHUTDOWN_EVENT_TYPE}, and the untyped bookTicker payload)`,
    };
  }

  // `bookTicker` is the one in-scope payload with no `e` field, so it is
  // recognised by its documented key set rather than by a discriminator.
  if (looksLikeBookTicker(payload)) {
    const result = BinanceBookTickerPayloadSchema.safeParse(payload);
    if (!result.success) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `\`${BINANCE_BOOK_TICKER_STREAM_SUFFIX}\` payload: ${formatIssues(result.error)}`,
      });
    }
    const ticker = result.data;
    const channel = resolveChannel(
      streamName,
      channelSource,
      ticker.s,
      BINANCE_BOOK_TICKER_STREAM_SUFFIX,
    );
    return {
      kind: "BOOK_TICKER",
      raw,
      streamName: channel.streamName,
      channelSource: channel.channelSource,
      unknownFields: unknownKeysOf(payload, BOOK_TICKER_KNOWN_KEYS),
      symbol: ticker.s,
      updateId: ticker.u,
      bidPriceRaw: ticker.b,
      bidQuantityRaw: ticker.B,
      askPriceRaw: ticker.a,
      askQuantityRaw: ticker.A,
    };
  }

  if ("code" in payload && "msg" in payload) {
    const result = BinanceControlErrorSchema.safeParse(payload);
    if (!result.success) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `control error payload: ${formatIssues(result.error)}`,
      });
    }
    return {
      kind: "CONTROL_ERROR",
      raw,
      streamName,
      channelSource,
      unknownFields: unknownKeysOf(payload, new Set(["code", "msg", "id"])),
      venueCode: result.data.code,
      message: result.data.msg,
    };
  }

  if ("result" in payload) {
    const result = BinanceControlResponseSchema.safeParse(payload);
    if (!result.success) {
      return malformed(raw, streamName, channelSource, "SCHEMA_MISMATCH", {
        detail: `control response payload: ${formatIssues(result.error)}`,
      });
    }
    return {
      kind: "CONTROL_RESPONSE",
      raw,
      streamName,
      channelSource,
      unknownFields: unknownKeysOf(payload, new Set(["result", "id"])),
      id: result.data.id ?? null,
    };
  }

  return {
    kind: "UNKNOWN",
    raw,
    streamName,
    channelSource,
    unknownFields: [],
    declaredEventType: undefined,
    detail: `frame declares no \`e\` and matches no documented in-scope shape; keys: ${JSON.stringify(Object.keys(payload).slice(0, 20))}`,
  };
}

function looksLikeBookTicker(payload: Record<string, unknown>): boolean {
  for (const key of BOOK_TICKER_KNOWN_KEYS) {
    if (!(key in payload)) {
      return false;
    }
  }
  return true;
}

function resolveChannel(
  streamName: string | undefined,
  channelSource: DecodedBase["channelSource"],
  symbol: string,
  suffix: string,
): { streamName: string; channelSource: DecodedBase["channelSource"] } {
  if (streamName !== undefined) {
    return { streamName, channelSource };
  }
  return { streamName: `${symbol.toLowerCase()}@${suffix}`, channelSource: "RECONSTRUCTED" };
}

function malformed(
  raw: string,
  streamName: string | undefined,
  channelSource: DecodedBase["channelSource"],
  reason: MalformedFrameReason,
  extra: { readonly detail: string },
): DecodedMalformedFrame {
  return {
    kind: "MALFORMED",
    raw,
    streamName,
    channelSource,
    unknownFields: [],
    reason,
    detail: extra.detail,
  };
}

function unknownKeysOf(payload: Record<string, unknown>, known: ReadonlySet<string>): string[] {
  return Object.keys(payload).filter((key) => !known.has(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
