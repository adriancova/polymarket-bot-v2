/**
 * Outbound subscription frames and inbound frame decoding.
 *
 * Frame shapes, verbatim from
 * https://docs.polymarket.com/api-reference/wss/market.md (accessed
 * 2026-08-27):
 *
 * - initial subscription: `{"assets_ids": ["<token_id>"], "type": "market"}`,
 *   with optional `custom_feature_enabled` ("Enable best_bid_ask, new_market,
 *   and market_resolved events", default `false`), `initial_dump` ("Whether to
 *   send an initial orderbook snapshot on subscribe. Defaults to true") and
 *   `level` ("Subscription level. Defaults to 2", `1 | 2 | 3`);
 * - dynamic update: `{"operation": "subscribe" | "unsubscribe", "assets_ids":
 *   [...]}` — "These frames update only the token set for the current
 *   market-stream connection";
 * - heartbeat: the client sends the text frame `PING`, the server replies
 *   `PONG`.
 *
 * `level` is NOT sent. The reference documents its existence, its enumeration
 * and its default, and nothing about what the three levels mean; sending a
 * value whose effect is unknown would be a guess about venue behaviour. The
 * server default applies.
 *
 * ## `[...assetsIds]` IS LOAD-BEARING, NOT A DEFENSIVE COPY
 *
 * Every builder below rebuilds `assets_ids` with an array-literal spread, which
 * always produces an ORDINARY array whatever the argument's species is — where
 * `assetsIds.map(…)` or `.slice(…)` would have preserved an `Array` SUBCLASS
 * the caller passed (ECMA-262 `ArraySpeciesCreate`). Since `SER-3` these frames
 * are serialized by the own-data encoder (`../outbound-json.ts`), which refuses
 * a container whose prototype is neither `Array.prototype` nor `null`, so a
 * caller's array TYPE reaching a frame would be a refusal where
 * `JSON.stringify` serialized — the defect the `SER-3` review found in
 * `../rtds/frames.ts` (round 1, M2), which this spelling already excluded here.
 * The frames themselves are object literals, so their prototype is this
 * module's too. `test/unit/polymarket-public/outbound-container-species.test.ts`
 * pins it with a subclass.
 */

/** The `type` discriminator of the initial market subscription frame. */
export const MARKET_SUBSCRIPTION_TYPE = "market";

/** An outbound frame, ready to be JSON-serialized. */
export type MarketSubscriptionFrame = Readonly<Record<string, unknown>>;

export interface MarketSubscribeFrameInput {
  readonly assetsIds: readonly string[];
  readonly customFeatureEnabled: boolean;
  readonly initialDump: boolean;
}

/**
 * The initial subscription frame sent immediately after the socket opens.
 *
 * `custom_feature_enabled` and `initial_dump` are always sent explicitly, even
 * when they match the documented server defaults: a default is a venue
 * behaviour that can change, and a feed whose event set silently changed
 * underneath it would be very hard to diagnose.
 */
export function buildMarketSubscribeFrame(
  input: MarketSubscribeFrameInput,
): MarketSubscriptionFrame {
  return {
    assets_ids: [...input.assetsIds],
    type: MARKET_SUBSCRIPTION_TYPE,
    custom_feature_enabled: input.customFeatureEnabled,
    initial_dump: input.initialDump,
  };
}

/** A dynamic subscribe frame, which adds tokens without reconnecting. */
export function buildMarketSubscribeUpdateFrame(
  assetsIds: readonly string[],
  customFeatureEnabled: boolean,
): MarketSubscriptionFrame {
  return {
    operation: "subscribe",
    assets_ids: [...assetsIds],
    custom_feature_enabled: customFeatureEnabled,
  };
}

/** A dynamic unsubscribe frame, which removes tokens without reconnecting. */
export function buildMarketUnsubscribeUpdateFrame(
  assetsIds: readonly string[],
): MarketSubscriptionFrame {
  return {
    operation: "unsubscribe",
    assets_ids: [...assetsIds],
  };
}

/** What an inbound text frame turned out to be. */
export type InboundFrame =
  /** The heartbeat reply. */
  | { readonly kind: "pong" }
  /** One or more event objects. The venue may batch several into one frame. */
  | { readonly kind: "values"; readonly values: readonly unknown[] }
  /** Not JSON, or JSON that is neither an object nor an array. */
  | { readonly kind: "unparsable"; readonly reason: string };

/**
 * Decodes one inbound text frame.
 *
 * A frame may carry a single event object OR an array of them: the official
 * SDK's market socket branches on `Array.isArray(message)` before dispatching,
 * so a client that assumed one event per frame would silently lose every event
 * after the first in a batch.
 *
 * The `PONG` comparison is on the trimmed frame, matching the SDK's equality
 * check against the literal `'PONG'`.
 */
export function decodeInboundFrame(raw: string): InboundFrame {
  const trimmed = raw.trim();
  if (trimmed === "PONG") {
    return { kind: "pong" };
  }
  if (trimmed === "") {
    return { kind: "unparsable", reason: "empty frame" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      kind: "unparsable",
      reason: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (Array.isArray(parsed)) {
    return { kind: "values", values: parsed as readonly unknown[] };
  }
  if (typeof parsed === "object" && parsed !== null) {
    return { kind: "values", values: [parsed] };
  }
  return { kind: "unparsable", reason: `JSON ${typeof parsed} is not an event object` };
}
